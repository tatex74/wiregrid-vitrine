/**
 * Cloudflare Worker entry that delegates every request to the static assets
 * binding (`env.ASSETS`), which serves files from ./dist as configured
 * in wrangler.jsonc.
 *
 * Kept minimal on purpose: the vitrine is fully static (Astro build),
 * so we do not run any logic on the edge. The handler exists only
 * because wrangler ≥ 4 requires a `main` entry for every deploy.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
