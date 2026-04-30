/**
 * Post-build assertions on the static HTML output.
 *
 * Runs after `npm run build` against ./dist/. Catches the kind of
 * regressions that have already bitten us once (hardcoded localhost:8000
 * URLs, personal email exposure, broken `href="#"` links, dead waitlist
 * anchors). Faster and more meaningful than rendering individual Astro
 * components in isolation, because we test exactly what visitors see.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

const dist = resolve(__dirname, '..', 'dist');
const pages = {
  apex: resolve(dist, 'index.html'),
  fr: resolve(dist, 'fr', 'index.html'),
  en: resolve(dist, 'en', 'index.html'),
  fr_trial: resolve(dist, 'fr', 'trial', 'index.html'),
  en_trial: resolve(dist, 'en', 'trial', 'index.html'),
};

let html: Record<keyof typeof pages, string>;

beforeAll(() => {
  for (const [name, path] of Object.entries(pages)) {
    if (!existsSync(path)) {
      throw new Error(
        `Missing built page: ${path}. Run \`npm run build\` first.`
      );
    }
  }
  html = {
    apex: readFileSync(pages.apex, 'utf-8'),
    fr: readFileSync(pages.fr, 'utf-8'),
    en: readFileSync(pages.en, 'utf-8'),
    fr_trial: readFileSync(pages.fr_trial, 'utf-8'),
    en_trial: readFileSync(pages.en_trial, 'utf-8'),
  };
});

describe('Built pages exist and have a <title>', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang}/index.html has a <title>`, () => {
      expect(html[lang]).toMatch(/<title>[^<]+<\/title>/);
    });
    it(`${lang}/trial/index.html has a <title>`, () => {
      const key = `${lang}_trial` as keyof typeof html;
      expect(html[key]).toMatch(/<title>[^<]+<\/title>/);
    });
  }
});

describe('No prod-breaking hardcoded URLs', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang} has no http://localhost LINKS (terminal mocks are allowed)`, () => {
      // Block real <a href> / <img src> pointing at localhost; allow it
      // in code / pre blocks (terminal mocks where it's the user's own
      // self-hosted URL after `docker compose up`).
      expect(html[lang]).not.toMatch(/(href|src)=["']http:\/\/localhost/);
    });

    it(`${lang} has no bruno.crespo74 personal email`, () => {
      expect(html[lang]).not.toMatch(/bruno\.crespo74/);
    });

    it(`${lang} has no broken href="#" anchors (excluding heading anchors)`, () => {
      // Strip valid anchors like href="#features" before checking
      const withoutValidAnchors = html[lang].replace(/href="#[a-z][a-z0-9-]*"/gi, '');
      expect(withoutValidAnchors).not.toMatch(/href="#"/);
    });
  }
});

describe('Demo CTAs point to the live app', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang} contains at least one https://demo.wiregrid.fr link`, () => {
      const matches = html[lang].match(/https:\/\/demo\.wiregrid\.fr/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('Contact mailto goes to the right address', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang} mailto links use contact@wiregrid.fr`, () => {
      const mailtos = html[lang].match(/mailto:([^"'\s<>]+)/g) ?? [];
      expect(mailtos.length).toBeGreaterThan(0);
      for (const mailto of mailtos) {
        // Allow ?subject=... and similar URL params, just check the address.
        const addr = mailto.replace(/^mailto:/, '').split('?')[0];
        expect(addr).toBe('contact@wiregrid.fr');
      }
    });
  }
});

describe('Removed components are really gone', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang} has no #waitlist anchor (component was removed)`, () => {
      expect(html[lang]).not.toMatch(/href="#waitlist"/);
    });
  }
});

describe('Apex root redirects to /fr/', () => {
  it('apex page is a redirect stub pointing to /fr/', () => {
    expect(html.apex).toMatch(/url=\/fr\//);
  });
});

describe('Trial pages wire to /api/trial and Turnstile', () => {
  for (const lang of ['fr', 'en'] as const) {
    const key = `${lang}_trial` as keyof typeof html;

    it(`${lang}/trial/index.html POSTs to /api/trial`, () => {
      // The fetch URL is rendered inline in the page script (since it's
      // is:inline). It must be the same-origin /api/trial route.
      expect(html[key]).toContain("'/api/trial'");
    });

    it(`${lang}/trial/index.html embeds the Turnstile widget script`, () => {
      expect(html[key]).toMatch(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
    });

    it(`${lang}/trial/index.html exposes a Turnstile siteKey`, () => {
      // Must be either a real key or Cloudflare's public test key.
      // We just check the data-sitekey attribute is set and non-empty.
      expect(html[key]).toMatch(/class="cf-turnstile"[^>]*data-sitekey="[^"]+"/);
    });

    it(`${lang}/trial/index.html has the form fields name, email, company, useCase`, () => {
      expect(html[key]).toMatch(/name="name"/);
      expect(html[key]).toMatch(/name="email"/);
      expect(html[key]).toMatch(/name="company"/);
      expect(html[key]).toMatch(/name="useCase"/);
    });
  }
});

describe('Landing pages link to the trial page', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang}/index.html links to /${lang}/trial/`, () => {
      expect(html[lang]).toMatch(new RegExp(`href="/${lang}/trial/"`));
    });
  }
});
