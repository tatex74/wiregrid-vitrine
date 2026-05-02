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
  fr_about: resolve(dist, 'fr', 'about', 'index.html'),
  en_about: resolve(dist, 'en', 'about', 'index.html'),
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
    fr_about: readFileSync(pages.fr_about, 'utf-8'),
    en_about: readFileSync(pages.en_about, 'utf-8'),
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
    it(`${lang}/about/index.html has a <title>`, () => {
      const key = `${lang}_about` as keyof typeof html;
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

describe('Personas section renders 4 cards (DSI persona added 2026-05-02)', () => {
  for (const lang of ['fr', 'en'] as const) {
    function personasSection(): string {
      const m = html[lang].match(/<section id="personas"[\s\S]*?<\/section>/);
      if (!m) throw new Error(`personas section not found in ${lang}`);
      return m[0];
    }

    it(`${lang} personas section renders exactly 4 articles`, () => {
      const section = personasSection();
      const articles = section.match(/<article\b/g) ?? [];
      expect(articles).toHaveLength(4);
    });

    it(`${lang} personas section names the technical-director / DSI role`, () => {
      const section = personasSection();
      if (lang === 'fr') {
        expect(section).toMatch(/DSI industriel|Direction technique/);
      } else {
        expect(section).toMatch(/Technical director|Industrial CIO/);
      }
    });
  }
});

describe('Sovereignty section renders the four pillars (2026-05-02 brief axe 3)', () => {
  for (const lang of ['fr', 'en'] as const) {
    function sovereigntySection(): string {
      const m = html[lang].match(/<section id="sovereignty"[\s\S]*?<\/section>/);
      if (!m) throw new Error(`sovereignty section not found in ${lang}`);
      return m[0];
    }

    it(`${lang} sovereignty section is rendered`, () => {
      // Throws if the section is missing.
      const section = sovereigntySection();
      expect(section.length).toBeGreaterThan(0);
    });

    it(`${lang} sovereignty section has exactly 4 cards`, () => {
      const section = sovereigntySection();
      const articles = section.match(/<article\b/g) ?? [];
      expect(articles).toHaveLength(4);
    });

    it(`${lang} sovereignty section mentions GDPR + air-gap + French law`, () => {
      const section = sovereigntySection();
      expect(section).toMatch(/RGPD|GDPR/);
      expect(section).toMatch(/air-gap/i);
      if (lang === 'fr') {
        expect(section).toMatch(/droit français|juridiction Paris/i);
      } else {
        expect(section).toMatch(/French law|courts in Paris/i);
      }
    });

    it(`${lang} sovereignty section flags the Bruno placeholder for the registered city`, () => {
      // The attribution line is the only entry in the section that
      // depends on Bruno-side data. If this test fails AFTER Bruno
      // fills in the city, drop the assertion.
      const section = sovereigntySection();
      expect(section).toMatch(/À COMPLÉTER PAR BRUNO|TO BE FILLED BY BRUNO/);
    });
  }
});

describe('FAQ has the four B2B-compliance entries from 2026-05-02 brief § 5', () => {
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang} FAQ exposes the sovereignty + GDPR + support-language + code-audit questions`, () => {
      // FAQ entries land both in JSON-LD (re-quoted by AI search) and
      // in the visible <details> list. Search for canonical terms
      // pulled straight from the entry copy.
      if (lang === 'fr') {
        expect(html[lang]).toMatch(/Mes données restent-elles en France/);
        expect(html[lang]).toMatch(/Wiregrid est-il conforme RGPD/);
        expect(html[lang]).toMatch(/Le support est-il en français/);
        expect(html[lang]).toMatch(/Puis-je auditer le code source/);
      } else {
        expect(html[lang]).toMatch(/Does my data stay in France/);
        expect(html[lang]).toMatch(/Is Wiregrid GDPR compliant/);
        expect(html[lang]).toMatch(/Is support in French/);
        expect(html[lang]).toMatch(/Can I audit the source code/);
      }
    });
  }
});

describe('About page has the founder + mission + coords sections', () => {
  for (const lang of ['fr', 'en'] as const) {
    const key = `${lang}_about` as keyof typeof html;

    it(`${lang} about page renders the five top-level sections`, () => {
      // Five <h2> headings: founder, mission, values, timeline, coords.
      const h2 = html[key].match(/<h2\b/g) ?? [];
      expect(h2.length).toBeGreaterThanOrEqual(5);
    });

    it(`${lang} about page links back to home`, () => {
      expect(html[key]).toMatch(new RegExp(`href="/${lang}/"`));
    });

    it(`${lang} about page exposes Bruno placeholders for company / address / SIREN`, () => {
      // Anti-regression: ensure the placeholders are visible enough
      // that a casual review catches them before merge to master.
      const marker = lang === 'fr' ? 'À COMPLÉTER PAR BRUNO' : 'TO BE FILLED BY BRUNO';
      expect(html[key]).toContain(marker);
    });
  }
});

describe('Footer carries the French-company attribution and continuity link', () => {
  for (const lang of ['fr', 'en'] as const) {
    function footer(): string {
      return html[lang].match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    }

    it(`${lang} footer surfaces a legal box (company + city + SIREN) above the bottom row`, () => {
      const f = footer();
      // The legal box lives in col-1 of the footer (Brand + tagline +
      // legal anchor) and carries Bruno placeholders until filled.
      expect(f).toMatch(/société française enregistrée|French company registered/);
      expect(f).toMatch(/SIREN/);
    });

    it(`${lang} footer carries the 'what if you shut down' continuity link to faq.company_disappears`, () => {
      const f = footer();
      expect(f).toContain(`href="/${lang}/#faq-company_disappears"`);
      if (lang === 'fr') {
        expect(f).toMatch(/Et si vous fermez demain/);
      } else {
        expect(f).toMatch(/What if you shut down tomorrow/);
      }
    });

    it(`${lang} footer bottom row keeps a French-tech tagline`, () => {
      const f = footer();
      if (lang === 'fr') {
        expect(f).toMatch(/Données françaises\. Tech française\./);
      } else {
        expect(f).toMatch(/French data\. French tech\./);
      }
    });
  }
});

describe('Hard-rule lint on built HTML', () => {
  const EM_DASH = '—';
  const FORBIDDEN_NAMES = [
    'Niagara',
    'Ignition',
    'EcoStruxure',
    'Tridium',
    'Inductive Automation',
    'Workbench',
    'JACE',
  ];
  const OPEN_SOURCE_PATTERNS = [/open[- ]source/i, /source[- ]available/i];

  for (const key of [
    'fr',
    'en',
    'fr_trial',
    'en_trial',
    'fr_about',
    'en_about',
  ] as const) {
    it(`${key} contains no em-dash`, () => {
      expect(html[key]).not.toContain(EM_DASH);
    });

    it(`${key} contains no banned competitor name`, () => {
      for (const name of FORBIDDEN_NAMES) {
        expect(html[key], `banned name "${name}" in ${key}`).not.toMatch(
          new RegExp(`\\b${name}\\b`),
        );
      }
    });

    it(`${key} does not mention "open source" or "source available"`, () => {
      for (const pattern of OPEN_SOURCE_PATTERNS) {
        expect(html[key]).not.toMatch(pattern);
      }
    });
  }
});

describe('Pricing section renders 3 tiers per ADR-0008', () => {
  for (const lang of ['fr', 'en'] as const) {
    function pricingSection(): string {
      const m = html[lang].match(/<section id="pricing"[\s\S]*?<\/section>/);
      if (!m) throw new Error(`pricing section not found in ${lang}`);
      return m[0];
    }

    it(`${lang} pricing has exactly 3 tier cards`, () => {
      const section = pricingSection();
      const cardHeads = section.match(/<h3 class="text-xl/g) ?? [];
      expect(cardHeads).toHaveLength(3);
    });

    it(`${lang} pricing wires the 3 expected CTAs (demo / trial / standard mailto)`, () => {
      const section = pricingSection();
      expect(section).toContain('href="https://demo.wiregrid.fr"');
      expect(section).toContain(`href="/${lang}/trial/"`);
      expect(section).toContain('href="mailto:contact@wiregrid.fr?subject=Wiregrid%20Standard"');
    });

    it(`${lang} pricing Standard tier carries the legal anchor + continuity link`, () => {
      const section = pricingSection();
      if (lang === 'fr') {
        expect(section).toMatch(/Société française enregistrée\. Données et support sous droit français\./);
        expect(section).toMatch(/Et si vous fermez demain/);
      } else {
        expect(section).toMatch(/French registered company\. Data and support under French law\./);
        expect(section).toMatch(/What if you shut down tomorrow/);
      }
      expect(section).toContain(`href="/${lang}/#faq-company_disappears"`);
    });

    it(`${lang} pricing no longer references the obsolete free-forever 50-points tier`, () => {
      // ADR-0008 explicitly rejected a permanent self-host free tier.
      // Make sure the old "Discovery / 50 points / forever" copy is gone.
      const section = pricingSection();
      expect(section).not.toMatch(/Discovery|Découverte/);
      expect(section).not.toMatch(/50 points/);
      expect(section).not.toMatch(/forever|pour toujours/);
    });
  }
});
