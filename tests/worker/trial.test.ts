/**
 * Tests for src/worker/handlers/trial.js. The full /api/trial flow with
 * mocked KV, RateLimiter, fetch (Turnstile + Resend), and an ephemeral
 * Ed25519 keypair for the signing key.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { handleTrialRequest } from '../../src/worker/handlers/trial.js';

// ---------- Helpers ----------

let SIGNING_PEM: string;
let PUBLIC_KEY: CryptoKey;

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const b64 = Buffer.from(der).toString('base64');
  SIGNING_PEM = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  PUBLIC_KEY = kp.publicKey;
});

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
}

function makeRateLimiter(allowedSequence: boolean[] = []) {
  let i = 0;
  return {
    async limit(_args: { key: string }) {
      const success = allowedSequence[i] ?? true;
      i += 1;
      return { success };
    },
  };
}

function makeFetch(opts: { turnstile?: 'pass' | 'fail'; resend?: 'ok' | 'fail' | 'fail-welcome-only' } = {}) {
  const turnstile = opts.turnstile ?? 'pass';
  const resend = opts.resend ?? 'ok';
  let resendCallIndex = 0;

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      return new Response(JSON.stringify({ success: turnstile === 'pass' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.resend.com/emails')) {
      const i = resendCallIndex;
      resendCallIndex += 1;
      const failNow = resend === 'fail' || (resend === 'fail-welcome-only' && i === 0);
      if (failNow) {
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: `re_${i}` }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not mocked', { status: 500 });
  });
  return { fn, calls };
}

function buildRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('https://wiregrid.fr/api/trial', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function baseEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    TRIAL_DEDUPE: makeKv(),
    TRIAL_RATE_LIMITER: makeRateLimiter([true]),
    TRIAL_SIGNING_KEY: SIGNING_PEM,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    RESEND_API_KEY: 'resend-key',
    RESEND_FROM_EMAIL: 'test@wiregrid.fr',
    ...overrides,
  };
}

function validBody() {
  return {
    name: 'Bruno',
    email: 'bruno@example.com',
    company: 'Acme',
    useCase: 'GTB tertiaire 200 points',
    lang: 'fr',
    turnstileToken: 'token',
  };
}

function base64UrlDecode(str: string): Uint8Array {
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Tests ----------

describe('handleTrialRequest — happy path', () => {
  it('returns 200 ok=true on a valid submission', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('writes the email dedupe entry in KV', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(env.TRIAL_DEDUPE.store.get('email:bruno@example.com')).toBeDefined();
  });

  it('calls Resend three times: welcome (immediate) + reminder (J+6) + post-mortem (J+7+2h)', async () => {
    const env = baseEnv();
    const { fn: fetchImpl, calls } = makeFetch();
    await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    const resendCalls = calls.filter((c) => c.url.includes('api.resend.com/emails'));
    expect(resendCalls).toHaveLength(3);

    const bodies = resendCalls.map((c) => JSON.parse(c.init!.body as string));
    expect(bodies[0].scheduled_at).toBeUndefined(); // welcome immediate
    expect(bodies[1].scheduled_at).toBeDefined(); // reminder
    expect(bodies[2].scheduled_at).toBeDefined(); // post-mortem
    expect(new Date(bodies[2].scheduled_at).getTime()).toBeGreaterThan(new Date(bodies[1].scheduled_at).getTime());
  });

  it('signs the JWT with TRIAL_SIGNING_KEY and the signature verifies against the public key', async () => {
    const env = baseEnv();
    const { fn: fetchImpl, calls } = makeFetch();
    await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });

    const welcomeCall = calls.find((c) => c.url.includes('api.resend.com'));
    const body = JSON.parse(welcomeCall!.init!.body as string);
    const jwtAttachment = body.attachments.find((a: { filename: string }) => a.filename === 'license.jwt');
    const jwt = Buffer.from(jwtAttachment.content, 'base64').toString('utf-8');
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');

    // Verify
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);
    const ok = await crypto.subtle.verify('Ed25519', PUBLIC_KEY, signature, signingInput);
    expect(ok).toBe(true);

    // Claims sanity
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    expect(claims.tier).toBe('trial');
    expect(claims.iss).toBe('wiregrid-trial-signer');
    expect(claims.sub).toBe('trial:bruno@example.com');
    expect(claims.exp - claims.iat).toBe(7 * 24 * 3600);
    expect(claims.binding).toBeNull();
    expect(claims.issued_to).toEqual({ name: 'Bruno', company: 'Acme' });
  });
});

describe('handleTrialRequest — input validation', () => {
  it('rejects malformed JSON', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const req = new Request('https://wiregrid.fr/api/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    const res = await handleTrialRequest(req, env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-json');
  });

  it('rejects an invalid email', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest({ ...validBody(), email: 'not-an-email' }), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-email');
  });

  it('rejects an empty name', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest({ ...validBody(), name: '   ' }), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-name');
  });

  it('rejects an empty company (now required)', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest({ ...validBody(), company: '   ' }), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-company');
  });

  it('rejects a missing company (now required)', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const body = validBody();
    delete (body as Record<string, unknown>).company;
    const res = await handleTrialRequest(buildRequest(body), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-company');
  });

  it('rejects an empty useCase (now required)', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest({ ...validBody(), useCase: '' }), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-use-case');
  });

  it('rejects a missing useCase (now required)', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    const body = validBody();
    delete (body as Record<string, unknown>).useCase;
    const res = await handleTrialRequest(buildRequest(body), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-use-case');
  });
});

describe('handleTrialRequest — Turnstile', () => {
  it('rejects when Turnstile verification fails', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch({ turnstile: 'fail' });
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-turnstile');
  });

  it('rejects when no token is provided AND no secret configured', async () => {
    const env = baseEnv({ TURNSTILE_SECRET_KEY: undefined });
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest({ ...validBody(), turnstileToken: '' }), env, { fetch: fetchImpl });
    expect(res.status).toBe(400);
  });
});

describe('handleTrialRequest — rate limiting + dedupe', () => {
  it('returns 429 when the native rate limiter rejects', async () => {
    const env = baseEnv({ TRIAL_RATE_LIMITER: makeRateLimiter([false]) });
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate-limit');
  });

  it('returns 429 with code=dedupe when the email is already in KV', async () => {
    const env = baseEnv();
    await env.TRIAL_DEDUPE.put('email:bruno@example.com', JSON.stringify({ jti: 'old' }));
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('dedupe');
  });

  it('blocks the 4th request from the same IP within 24h', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch();
    // Three different emails to bypass per-email dedupe.
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
      const res = await handleTrialRequest(buildRequest({ ...validBody(), email }), env, { fetch: fetchImpl });
      expect(res.status).toBe(200);
    }
    const res4 = await handleTrialRequest(buildRequest({ ...validBody(), email: 'd@x.com' }), env, { fetch: fetchImpl });
    expect(res4.status).toBe(429);
  });
});

describe('handleTrialRequest — secret missing', () => {
  it('returns 500 if TRIAL_SIGNING_KEY is missing', async () => {
    const env = baseEnv({ TRIAL_SIGNING_KEY: undefined });
    const { fn: fetchImpl } = makeFetch();
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('signer-unavailable');
  });

  it('returns 200 even if RESEND_API_KEY is missing (dev-mode bypass)', async () => {
    const env = baseEnv({ RESEND_API_KEY: undefined });
    const { fn: fetchImpl, calls } = makeFetch();
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(200);
    // No Resend calls at all when there's no API key.
    expect(calls.filter((c) => c.url.includes('api.resend.com'))).toHaveLength(0);
  });
});

describe('handleTrialRequest — partial failures', () => {
  it('rolls back the KV dedupe + returns 500 if the welcome email fails', async () => {
    const env = baseEnv();
    const { fn: fetchImpl } = makeFetch({ resend: 'fail-welcome-only' });
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('email-failed');
    // Dedupe must be cleared so the user can retry.
    expect(env.TRIAL_DEDUPE.store.get('email:bruno@example.com')).toBeUndefined();
  });

  it('still returns 200 if the reminder/post-mortem sends fail (best effort)', async () => {
    const env = baseEnv();
    // Welcome OK, reminder + post-mortem fail.
    let i = 0;
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('siteverify')) {
        return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
      }
      i += 1;
      if (i === 1) {
        return new Response(JSON.stringify({ id: 're_welcome' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'rate-limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await handleTrialRequest(buildRequest(validBody()), env, { fetch: fetchImpl as unknown as typeof fetch });
    expect(res.status).toBe(200);
  });
});
