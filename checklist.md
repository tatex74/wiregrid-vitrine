# WireGrid Vitrine — Project Checklist

Source of truth for "what's done / what's next" on this repo. Update inline as work lands.

For the trial license system that spans both this repo and the wiregrid product repo, the architectural source of truth is `c:/Users/bruno/Desktop/Dev/wiregrid-lead/docs/adr/0006-trial-license-system.md`. That file is read-only from here. The wiregrid checklist tracks the items on its side; this checklist tracks only what lives in this repo.

---

## Refonte vitrine v3 — fermée le 2026-04-30

Closure par vitrine-Claude en 3 commits atomiques sur `dev`, CI verte en 25s, tree clean :

- `2fdbd18 chore: add CLAUDE.md and checklist.md` (foundational docs multi-Claude workflow)
- `51021e4 style: remove em-dash from worker.js comment` (hygiène hard-rule)
- `c8d3d66 feat(vitrine): v3 refonte light mode warm` (atomique, 19 fichiers, +519/-617)

État `dev` = `origin/dev`. Prêt pour Vague 5.

---

## Vague 5: système de licence trial 7 jours (côté vitrine)

Spec figée: `c:/Users/bruno/Desktop/Dev/wiregrid-lead/docs/adr/0006-trial-license-system.md` (lecture seule, ne modifie pas). Préalable côté wiregrid: génération des paires de clés Ed25519 par dev-Claude wiregrid + transmission de la clé privée trial via `wrangler secret put TRIAL_SIGNING_KEY` faite par Bruno.

**Plan d'attaque (validé lead 2026-04-30)** : ordre A→F. Tu peux démarrer A immédiatement, sans bloquer sur les préalables. Pour C (signature JWT), stub la clé en test avec une paire générée à la volée dans `setUp` ; le branchement avec la vraie clé se fait quand Bruno l'a posée.

**Statut des préalables au 2026-04-30** :
- `TRIAL_SIGNING_KEY` : pas encore posée. Dev-Claude wiregrid génère les paires en premier dans Vague 5 wiregrid-side (`scripts/generate_license_keys.py`), Bruno relaie la privée via `wrangler secret put`. Estimation : 1-2 jours côté wiregrid.
- `RESEND_API_KEY` : pas encore posée. Bruno crée le compte Resend en parallèle, pose le secret. Tant que pas posée, mock l'envoi en test (assertion sur le payload qu'on enverrait).
- `TURNSTILE_SECRET_KEY` + siteKey public : pas encore provisionné. Bruno provisionne via le dashboard Cloudflare, transmet siteKey à câbler dans `trial.astro`. Tant que pas en place, utilise les test keys publiques de Cloudflare (`1x00000000000000000000AA` siteKey + `1x0000000000000000000000000000000AA` secret) qui acceptent tout en dev.
- **Sender email** (lead 2026-04-30) : `noreply@wiregrid.fr` pour la production (DKIM + SPF à configurer sur la zone wiregrid.fr côté Cloudflare DNS, ~10 min). Pour le dev/test avant configuration DKIM, fallback sur `onboarding@resend.dev` (sender Resend par défaut, fonctionne sans setup DNS).

**Page Astro et UX**

- [x] `src/pages/<lang>/trial.astro` (FR + EN): formulaire (nom, email, entreprise opt, use-case opt), Cloudflare Turnstile widget, POST vers `/api/trial`, écran de succès "Mail envoyé, vérifiez votre boîte"
- [x] i18n keys: ajout dans `src/i18n/fr.json` + `en.json` + `faq-keys.ts` si pertinent
- [x] Lien "Essayer 7 jours" depuis Hero, FinalCTA, Pricing
- [x] FAQ: ajout d'entrées "Comment se passe l'essai 7 jours ?", "Que devient mon installation à la fin ?"

**Worker `src/worker.js` route `POST /api/trial`**

- [ ] Verify Turnstile token via `https://challenges.cloudflare.com/turnstile/v0/siteverify`
- [ ] Rate-limit IP via Workers Rate Limiting binding `TRIAL_RATE_LIMITER` (3 req/24h par IP)
- [ ] KV dedupe `trial_dedupe:<email>` avec TTL 30j (refus si présent)
- [ ] Sign JWT Ed25519 selon ADR 0006 § 8 (`tier: "trial"`, `iss: "wiregrid-trial-signer"`, `exp = iat + 7*24*3600`, limits + features par défaut, `binding: null`)
- [ ] Write KV dedupe entry
- [ ] Schedule 3 emails Resend: welcome immédiat (license.jwt en pièce jointe + docker-compose.yml + commande d'install + lien doc), reminder à `iat + 144h` (24h avant fin), post-mortem à `iat + 170h` (= H+2 post-exp)
- [ ] Réponse JSON `{ "ok": true }` au formulaire pour afficher l'écran de succès

**Bindings et secrets**

- [ ] `wrangler.jsonc`: KV namespace `TRIAL_DEDUPE`, Rate Limiting `TRIAL_RATE_LIMITER`
- [ ] Bruno: `wrangler secret put TRIAL_SIGNING_KEY` (Ed25519 PEM, fourni depuis Bitwarden après génération côté wiregrid)
- [ ] Bruno: `wrangler secret put RESEND_API_KEY`
- [ ] Bruno: `wrangler secret put TURNSTILE_SECRET_KEY`
- [ ] Bruno: récupérer le siteKey Turnstile public et le câbler dans `trial.astro`

**Templates email**

- [ ] `src/emails/welcome.{ts,html,txt}` (FR + EN selon la langue détectée du formulaire): license.jwt en pièce jointe, docker-compose.yml minimal inline, commande d'install, lien doc
- [ ] `src/emails/reminder.{ts,html,txt}` (FR + EN): "Plus que 24h sur votre essai. Pour passer en production: [calendly]"
- [ ] `src/emails/post_mortem.{ts,html,txt}` (FR + EN): "Votre essai est terminé. Discutons ? [calendly]"
- [ ] Sobre, pas de promesses fonctionnelles, pas de noms de concurrents, pas d'em-dashes

**Tests vitest**

- [ ] Parsing du body JSON `/api/trial` (champs requis, formats)
- [ ] Rejet sans Turnstile token
- [ ] Rejet sur dedupe KV
- [ ] Rejet rate-limit (4e requête)
- [ ] Génération JWT: claims attendus, signature valide avec une clé de test
- [x] Smoke build static via `built-html.test.ts` étendu pour la nouvelle page trial

**CRL endpoint (optionnel, pas urgent)**

- [ ] `src/pages/crl.json.ts` retourne `{ "revoked": [], "version": 1 }`. Sera consommé par les déploiements production une fois les premières licences prod émises.

---

## Backlog vitrine

- [ ] OpenGraph tags par page (Hero text, image dynamique sur og-image.svg ou variantes)
- [ ] a11y pass: focus states, ARIA labels, keyboard nav, contraste WCAG AA
- [ ] Lighthouse audit + optimisations (image lazy-load, font-display: swap, JS minimal sur la page d'accueil)
- [ ] `llms.txt` à mettre à jour avec les pages trial une fois en place
- [ ] sitemap.xml: vérifier inclusion automatique des pages `/<lang>/trial` via `@astrojs/sitemap`
- [ ] `robots.txt`: bloquer `/api/trial` des crawlers (pas une page indexable)
- [ ] Copy marketing: itérations à coordonner avec Bruno, pas en autonomie
- [ ] Purge cache CF après deploy si modifs de copie pour rafraichir les visiteurs récurrents

---

## Tests à relancer après chaque grosse passe

```bash
npm test                 # vitest
npm run build            # Astro compile dist/
npx wrangler dev         # smoke local du Worker (build dist/ d'abord)
```

CI: `.github/workflows/ci.yml`. Deploy auto vers prod sur push `master` via `.github/workflows/deploy.yml` (smoke test inclus).
