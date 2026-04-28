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
  };
});

describe('Built pages exist and have a <title>', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang}/index.html has a <title>`, () => {
      expect(html[lang]).toMatch(/<title>[^<]+<\/title>/);
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
