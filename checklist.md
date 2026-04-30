# WireGrid Vitrine — Project Checklist

Source of truth for "what's done / what's next" on this repo. Update inline as work lands.

For the trial license system that spans both this repo and the wiregrid product repo, the architectural source of truth is `c:/Users/bruno/Desktop/Dev/wiregrid-lead/docs/adr/0006-trial-license-system.md`. That file is read-only from here. The wiregrid checklist tracks the items on its side; this checklist tracks only what lives in this repo.

---

## En cours: refonte vitrine v3 (uncommitted WIP)

État au 2026-04-30. Derniers commits sur `dev`: `028b86a fix(logo): restore the original logo`, `4e861e2 feat: vitrine v3 light mode warm`.

Working tree non-commit avec une refonte design en cours:

- Components modifiés: AppPreview, Features, Header, Hero, Pricing
- Components supprimés: Comparison, Equipment, HowItWorks, Stats
- Components untracked: FinalCTA, Lifecycle, Personas
- Layouts/pages modifiés: Base, en/index, fr/index
- i18n: en.json, fr.json, faq-keys.ts
- Worker: src/worker.js (à diagnostiquer, peut être lié au refacto v3 ou à un début de signer)
- Styles: global.css

À faire avant d'attaquer la Vague 5:

- [ ] Lire les diffs section par section et décider: WIP à finir ou à reverter (côté vitrine-Claude au démarrage, briefer Bruno)
- [ ] Vérifier le build local (`npm run build`) et les tests (`npm test`)
- [ ] Si à garder: découper en commits cohérents (feat / fix / style / refactor par scope), push sur dev, CI verte
- [ ] Si à reverter: `git checkout -- .` et `git clean -fd`, brief Bruno avant
- [ ] Aligner README.md sur l'état post-refonte si nécessaire

---

## Vague 5: système de licence trial 7 jours (côté vitrine)

Spec figée: `c:/Users/bruno/Desktop/Dev/wiregrid-lead/docs/adr/0006-trial-license-system.md` (lecture seule, ne modifie pas). Préalable côté wiregrid: génération des paires de clés Ed25519 par dev-Claude wiregrid + transmission de la clé privée trial via `wrangler secret put TRIAL_SIGNING_KEY` faite par Bruno.

**Page Astro et UX**

- [ ] `src/pages/<lang>/trial.astro` (FR + EN): formulaire (nom, email, entreprise opt, use-case opt), Cloudflare Turnstile widget, POST vers `/api/trial`, écran de succès "Mail envoyé, vérifiez votre boîte"
- [ ] i18n keys: ajout dans `src/i18n/fr.json` + `en.json` + `faq-keys.ts` si pertinent
- [ ] Lien "Essayer 7 jours" depuis Hero, FinalCTA, Pricing
- [ ] FAQ: ajout d'entrées "Comment se passe l'essai ?", "Que devient mon installation à la fin ?"

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
- [ ] Smoke build static via `built-html.test.ts` étendu pour la nouvelle page trial

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
