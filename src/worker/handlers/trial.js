// POST /api/trial handler. Orchestrates Turnstile verification, rate
// limit + dedupe checks, JWT signing, and 3 scheduled Resend emails.
//
// Side effects are isolated: KV/RateLimiter/fetch/now() are passed via
// the env or via the `deps` argument so vitest can mock them.

import { jsonResponse, badRequest, tooManyRequests, serverError, isValidEmail, normaliseEmail } from '../json.js';
import { verifyTurnstile } from '../turnstile.js';
import {
  checkNativeRateLimit,
  checkIpWindow,
  isEmailDedupe,
  recordEmailIssued,
  rollbackEmailDedupe,
} from '../rate.js';
import { importEd25519PrivateKey, buildTrialClaims, signJwt } from '../license.js';
import { sendResend, epochToIso } from '../resend.js';
import { renderWelcomeEmail } from '../../emails/welcome.js';
import { renderReminderEmail } from '../../emails/reminder.js';
import { renderPostMortemEmail } from '../../emails/post-mortem.js';

const REMINDER_OFFSET_S = 144 * 3600;
const POST_MORTEM_OFFSET_S = 170 * 3600;

const DEFAULTS = {
  fromEmail: 'Wiregrid <onboarding@resend.dev>',
  replyTo: 'contact@wiregrid.fr',
  calendlyUrl: 'https://wiregrid.fr',
  docsUrl: 'https://wiregrid.fr',
};

export async function handleTrialRequest(request, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());

  // 1. Parse + validate body
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('bad-json', 'Body is not valid JSON.');
  }
  if (!body || typeof body !== 'object') {
    return badRequest('bad-body', 'Body is not an object.');
  }
  const name = (body.name ?? '').toString().trim();
  const email = normaliseEmail(body.email);
  const company = (body.company ?? '').toString().trim();
  const useCase = (body.useCase ?? '').toString().trim();
  const lang = body.lang === 'en' ? 'en' : 'fr';
  const turnstileToken = body.turnstileToken ?? null;

  if (!name || name.length > 200) {
    return badRequest('bad-name', 'Name is required (1..200 chars).');
  }
  if (!isValidEmail(email)) {
    return badRequest('bad-email', 'Email is invalid.');
  }
  if (!company || company.length > 200) {
    return badRequest('bad-company', 'Company is required (1..200 chars).');
  }
  if (!useCase || useCase.length > 2000) {
    return badRequest('bad-use-case', 'Use case is required (1..2000 chars).');
  }

  // 2. Identify the caller (CF-Connecting-IP is set on Cloudflare's edge,
  //    falls back to a sentinel in tests)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';

  // 3. Turnstile (skipped only if TURNSTILE_SECRET_KEY is missing AND the
  //    body explicitly carries a non-empty token — keeps prod strict but
  //    lets local wrangler dev work when the operator hasn't put the
  //    secret yet, as long as the form sent something).
  if (env.TURNSTILE_SECRET_KEY) {
    const ts = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: turnstileToken,
      remoteIp: ip === 'unknown' ? undefined : ip,
      fetchImpl,
    });
    if (!ts.success) {
      return badRequest('bad-turnstile', 'Turnstile verification failed.');
    }
  } else if (!turnstileToken) {
    return badRequest('bad-turnstile', 'Turnstile token missing.');
  }

  // 4. Short-window rate limit (3 req per 60s per IP, native binding)
  const native = await checkNativeRateLimit(env.TRIAL_RATE_LIMITER, `ip:${ip}`);
  if (!native.allowed) {
    return tooManyRequests('rate-limit', 'Too many requests. Try again in a minute.');
  }

  // 5. Long-window rate limit (3 req per 24h per IP, KV)
  const ipWindow = await checkIpWindow(env.TRIAL_DEDUPE, ip, { now: now() });
  if (!ipWindow.allowed) {
    return tooManyRequests('rate-limit', 'Too many requests for this IP in the last 24h.');
  }

  // 6. Email dedupe (1 trial per email per 30d)
  if (await isEmailDedupe(env.TRIAL_DEDUPE, email)) {
    return tooManyRequests('dedupe', 'A trial has already been issued for this email in the last 30 days.');
  }

  // 7. Sign JWT. Refuse if signing key is missing (don't issue placeholders).
  if (!env.TRIAL_SIGNING_KEY) {
    console.error('handleTrialRequest: TRIAL_SIGNING_KEY missing, cannot sign');
    return serverError('signer-unavailable', 'License signer is unavailable. Please write to contact@wiregrid.fr.');
  }
  let jwt;
  try {
    const privateKey = await importEd25519PrivateKey(env.TRIAL_SIGNING_KEY);
    const claims = buildTrialClaims({
      email,
      name,
      company,
      now: now(),
      jti: uuid(),
    });
    jwt = await signJwt(privateKey, claims);
  } catch (err) {
    console.error('handleTrialRequest: signing failed', err);
    return serverError('signer-error', 'License signing failed. Please write to contact@wiregrid.fr.');
  }
  // Re-derive iat/exp the same way buildTrialClaims did so we don't have
  // to round-trip through the JWT to get the timestamps for scheduling.
  const iat = Math.floor(now() / 1000);

  // 8. Write KV email dedupe before sending. If welcome fails, we roll back.
  await recordEmailIssued(env.TRIAL_DEDUPE, email, jwt.split('.')[1]);

  // 9. Send welcome immediately. Must succeed.
  const fromEmail = env.RESEND_FROM_EMAIL || DEFAULTS.fromEmail;
  const replyTo = env.RESEND_REPLY_TO || DEFAULTS.replyTo;
  const calendlyUrl = env.CALENDLY_URL || DEFAULTS.calendlyUrl;
  const docsUrl = env.DOCS_INSTALL_URL || DEFAULTS.docsUrl;

  const welcome = renderWelcomeEmail({
    lang,
    name,
    jwt,
    docsUrl,
    imageTag: env.WIREGRID_IMAGE_TAG,
  });
  const welcomeRes = await sendResend({
    apiKey: env.RESEND_API_KEY,
    from: fromEmail,
    to: email,
    replyTo,
    subject: welcome.subject,
    html: welcome.html,
    text: welcome.text,
    attachments: welcome.attachments,
    fetchImpl,
  });

  if (!welcomeRes.ok && welcomeRes.code !== 'no-api-key') {
    // Real Resend error: roll back so the user can retry.
    await rollbackEmailDedupe(env.TRIAL_DEDUPE, email);
    console.error('handleTrialRequest: welcome send failed', welcomeRes);
    return serverError('email-failed', 'Could not send the welcome email. Please write to contact@wiregrid.fr.');
  }
  if (welcomeRes.code === 'no-api-key') {
    // Per ADR-0006 dev-mode: log + return 200 so we can E2E-test the
    // worker before Bruno provisions Resend. Real prod always has
    // RESEND_API_KEY set, so this branch never runs.
    console.warn('handleTrialRequest: RESEND_API_KEY missing, skipping all email sends');
  }

  // 10. Schedule reminder (J+6) + post-mortem (J+7 +2h). Best-effort: log
  //     failures but still respond ok=true to the form.
  if (welcomeRes.code !== 'no-api-key') {
    const reminder = renderReminderEmail({ lang, name, calendlyUrl });
    const postMortem = renderPostMortemEmail({ lang, name, calendlyUrl });
    const results = await Promise.allSettled([
      sendResend({
        apiKey: env.RESEND_API_KEY,
        from: fromEmail,
        to: email,
        replyTo,
        subject: reminder.subject,
        html: reminder.html,
        text: reminder.text,
        scheduledAt: epochToIso(iat + REMINDER_OFFSET_S),
        fetchImpl,
      }),
      sendResend({
        apiKey: env.RESEND_API_KEY,
        from: fromEmail,
        to: email,
        replyTo,
        subject: postMortem.subject,
        html: postMortem.html,
        text: postMortem.text,
        scheduledAt: epochToIso(iat + POST_MORTEM_OFFSET_S),
        fetchImpl,
      }),
    ]);
    for (const r of results) {
      if (r.status === 'rejected' || (r.value && r.value.ok === false)) {
        console.error('handleTrialRequest: scheduled email failed', r);
      }
    }
  }

  return jsonResponse({ ok: true });
}
