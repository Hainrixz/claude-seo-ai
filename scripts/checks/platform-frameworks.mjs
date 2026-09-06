// Framework-conditional checks (plan 3c). These are repo checks: the facts they need (a
// metadataBase, a site URL in the config, where a Head export lives) exist in the source, not in
// the rendered HTML. So the module only reports a defect when profile.json carries a project root
// it can read; otherwise it says the source was not available and returns needs_api.
//
// Reads are read-only, path-guarded to the project root, and capped in size.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { mk, push, listing, frameworkId, originOf } from './_shared.mjs';

/** Config files are small; refuse to read anything larger so a stray binary cannot be slurped. */
export const MAX_CONFIG_BYTES = 512 * 1024;

function projectRoot(ctx) {
  const root = ctx.profile && ctx.profile.target && ctx.profile.target.project_root;
  if (!root) return null;
  try { return statSync(root).isDirectory() ? resolve(root) : null; } catch { return null; }
}

/** Resolve a repo-relative path, refusing anything that escapes the project root. */
function inRoot(root, rel) {
  const abs = resolve(join(root, rel));
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

const has = (root, rel) => { const p = inRoot(root, rel); return !!(p && existsSync(p)); };

function readText(root, rel) {
  const p = inRoot(root, rel);
  if (!p || !existsSync(p)) return null;
  try {
    if (statSync(p).size > MAX_CONFIG_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

/** First existing path from a list, with its content. */
function firstFile(root, rels) {
  for (const rel of rels) {
    const text = readText(root, rel);
    if (text !== null) return { rel, text };
  }
  return null;
}

const NEXT_CONFIGS = ['app/layout.tsx', 'app/layout.ts', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.ts', 'src/app/layout.jsx', 'src/app/layout.js'];
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts'];
const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];
const GATSBY_CONFIGS = ['gatsby-config.ts', 'gatsby-config.js', 'gatsby-config.mjs'];
const HUGO_CONFIGS = ['hugo.toml', 'hugo.yaml', 'config.toml', 'config.yaml', 'hugo.json', 'config/_default/hugo.toml', 'config/_default/config.toml'];

/** Per-framework "the source was not available" finding, so a gap never reads as clean. */
const NEEDS_SOURCE = {
  nextjs: ['M7.nextjs.metadata_base_missing', 'metadataBase and the robots/sitemap sources live in app/*, not in the HTML'],
  astro: ['M17.astro.site_missing', 'the `site` option lives in astro.config.*'],
  nuxt: ['M17.nuxt.site_url_missing', 'the site URL lives in nuxt.config.*'],
  gatsby: ['M17.gatsby.site_url_missing', 'siteUrl lives in gatsby-config.*'],
  hugo: ['M17.hugo.baseurl_missing', 'baseURL lives in hugo.toml / config.toml'],
  jekyll: ['M7.jekyll.seo_tag_present', 'whether jekyll-seo-tag owns the head is decided by _config.yml'],
  'react-router': ['M7.react_router.meta_replaces_parent', 'route meta exports live in app/routes/*'],
};

export const check = {
  id: 'platform-frameworks',
  module: 'M7',
  scope: 'site',
  ids: [
    'M7.nextjs.metadata_base_missing', 'M1.nextjs.robots_conflict', 'M17.nextjs.sitemap_missing_source',
    'M17.astro.site_missing', 'M17.nuxt.site_url_missing', 'M17.gatsby.site_url_missing', 'M17.hugo.baseurl_missing',
    'M7.gatsby.head_in_non_page', 'M7.react_router.meta_replaces_parent', 'M7.jekyll.seo_tag_present',
  ],

  run(ctx) {
    const out = [];
    const fw = frameworkId(ctx);
    if (!fw) return out;
    const origin = originOf(ctx);
    const root = projectRoot(ctx);
    const repro = { script: 'detect-platform.mjs', args: root ? { path: root } : { url: origin || '' } };

    if (!root) {
      const entry = NEEDS_SOURCE[fw];
      if (!entry) return out;
      const [id, why] = entry;
      push(out, mk({
        id, title: 'Framework configuration could not be inspected (no project root)', status: 'needs_api', scope: 'site',
        location: { url: origin || undefined },
        evidence: { observed: 'profile.json detects the ' + fw + ' framework but carries no target.project_root, and ' + why + ' — so the source could not be read.' },
        expected: 'An audit run with --path <repo> so the framework configuration can be read.',
        recommendation: 'Re-run the audit with --path pointing at the project checkout to enable the framework checks.',
        fixable: 'advisory',
        verification: { method: 'manual_review', assertion: 'The project source is available and the relevant configuration file can be read.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'The configuration file is the only evidence for these checks; without it the answer is unknown, not clean.' },
      }));
      return out;
    }

    const sitemapFound = !!(ctx.site && ctx.site.sitemaps && ctx.site.sitemaps.found);

    /* ---- Next.js ------------------------------------------------------------------------------ */
    if (fw === 'nextjs') {
      const layout = firstFile(root, NEXT_CONFIGS);
      if (layout && !/metadataBase\s*:/.test(layout.text)) {
        push(out, mk({
          id: 'M7.nextjs.metadata_base_missing', title: 'No metadataBase in the root layout', status: 'fail', severity: 3, scope: 'site',
          location: { file: layout.rel },
          evidence: { observed: layout.rel + ' exports metadata without a `metadataBase`, so relative canonical and openGraph URLs cannot be resolved to absolute ones at build time.' },
          expected: 'The root layout sets metadataBase to the site origin.',
          recommendation: 'Add `metadataBase: new URL("' + (origin || 'https://example.com') + '")` to the metadata export in ' + layout.rel + '.',
          fixable: 'auto',
          verification: { method: 'dom_assert', assertion: 'Rendered canonical and og:url values are absolute URLs on the production origin.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Next.js documents that relative metadata URLs need metadataBase; without it the framework falls back to a default origin, which is wrong in production.' },
        }));
      }

      const robotsSources = ['app/robots.ts', 'app/robots.js', 'src/app/robots.ts', 'src/app/robots.js'].filter((r) => has(root, r));
      if (robotsSources.length && has(root, 'public/robots.txt')) {
        push(out, mk({
          id: 'M1.nextjs.robots_conflict', title: 'Two sources generate robots.txt', status: 'warn', severity: 3, scope: 'site',
          location: { file: robotsSources[0] },
          evidence: { observed: 'Both ' + robotsSources[0] + ' and public/robots.txt exist; Next.js serves the static file and the route handler never runs.' },
          expected: 'One source of truth for robots.txt.',
          recommendation: 'Delete public/robots.txt if the route handler is the intended source (or the reverse). Right now the file wins silently.',
          fixable: 'proposed',
          verification: { method: 'robots_parse', assertion: 'Only one robots.txt source exists in the repo and its content matches the served file.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Next.js documents that files in public/ are served as-is and take precedence over the equivalent route, so the generated rules are silently dropped.' },
        }));
      }

      const sitemapSources = ['app/sitemap.ts', 'app/sitemap.js', 'src/app/sitemap.ts', 'src/app/sitemap.js', 'public/sitemap.xml', 'next-sitemap.config.js', 'next-sitemap.config.mjs'];
      if (!sitemapFound && !sitemapSources.some((r) => has(root, r))) {
        push(out, mk({
          id: 'M17.nextjs.sitemap_missing_source', title: 'No sitemap is served and nothing in the repo generates one', status: 'warn', severity: 3, scope: 'site',
          location: { url: (origin || '') + '/sitemap.xml' },
          evidence: { observed: 'No usable sitemap was fetched from the site, and none of ' + listing(sitemapSources, 4) + ' exists in ' + root + '.' },
          expected: 'A sitemap route (app/sitemap.ts) or a generated file.',
          recommendation: 'Add app/sitemap.ts returning the site\'s routes, then declare it in robots.txt.',
          fixable: 'auto',
          verification: { method: 'xml_parse', assertion: 'GET /sitemap.xml returns a valid urlset.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Well-linked Next.js routes are discovered without a sitemap; the gap matters most for large or thinly linked route sets.' },
        }));
      }
    }

    /* ---- Astro --------------------------------------------------------------------------------- */
    if (fw === 'astro') {
      const cfg = firstFile(root, ASTRO_CONFIGS);
      if (cfg && !/\bsite\s*:/.test(cfg.text)) {
        const withSitemap = /@astrojs\/sitemap/.test(cfg.text);
        push(out, mk({
          id: 'M17.astro.site_missing', title: 'astro.config sets no `site`', status: withSitemap ? 'fail' : 'warn', severity: 3, scope: 'site',
          location: { file: cfg.rel },
          evidence: { observed: cfg.rel + ' has no `site:` option' + (withSitemap ? ', yet it loads @astrojs/sitemap, which cannot emit absolute <loc> values without it' : '; canonical and sitemap URLs therefore cannot be absolute') + '.' },
          expected: '`site: "' + (origin || 'https://example.com') + '"` in astro.config.',
          recommendation: 'Set the `site` option to the production origin and rebuild.',
          fixable: 'auto',
          verification: { method: 'xml_parse', assertion: 'The generated sitemap contains absolute <loc> URLs on the production origin.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Astro documents `site` as the origin used for canonical URLs and by the sitemap integration; without it the integration cannot produce absolute URLs.' },
        }));
      }
    }

    /* ---- Nuxt / Gatsby / Hugo ------------------------------------------------------------------- */
    const siteUrlChecks = [
      { fw: 'nuxt', id: 'M17.nuxt.site_url_missing', configs: NUXT_CONFIGS, re: /(site\s*:\s*{[^}]*url|siteUrl|url\s*:\s*['"`]https?:)/, key: 'site.url', status: 'warn' },
      { fw: 'gatsby', id: 'M17.gatsby.site_url_missing', configs: GATSBY_CONFIGS, re: /siteUrl\s*:/, key: 'siteMetadata.siteUrl', status: 'warn' },
      { fw: 'hugo', id: 'M17.hugo.baseurl_missing', configs: HUGO_CONFIGS, re: /^\s*base[Uu][Rr][Ll]\s*[:=]/m, key: 'baseURL', status: 'fail' },
    ];
    for (const c of siteUrlChecks) {
      if (fw !== c.fw) continue;
      const cfg = firstFile(root, c.configs);
      if (cfg && !c.re.test(cfg.text)) {
        push(out, mk({
          id: c.id, title: 'The site URL is not configured (' + c.key + ')', status: c.status, severity: 3, scope: 'site',
          location: { file: cfg.rel },
          evidence: { observed: cfg.rel + ' declares no ' + c.key + ', so generated canonical and sitemap URLs cannot be absolute.' },
          expected: c.key + ' set to the production origin.',
          recommendation: 'Set ' + c.key + ' to "' + (origin || 'https://example.com') + '" and rebuild.',
          fixable: 'auto',
          verification: { method: 'xml_parse', assertion: 'Generated canonical and sitemap URLs are absolute on the production origin.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Each of these generators documents the option as the base for absolute URLs; without it the output carries relative or placeholder origins.' },
        }));
      }
    }

    /* ---- Gatsby Head placement ------------------------------------------------------------------ */
    if (fw === 'gatsby') {
      const componentDirs = ['src/components'];
      const offenders = [];
      for (const dir of componentDirs) {
        const abs = inRoot(root, dir);
        if (!abs || !existsSync(abs)) continue;
        let entries = [];
        try { entries = readdirSync(abs); } catch { entries = []; }
        for (const name of entries) {
          if (!/\.(jsx?|tsx?)$/.test(name)) continue;
          const text = readText(root, join(dir, name));
          if (text && /export\s+(?:const|function)\s+Head\b/.test(text)) offenders.push(join(dir, name));
        }
      }
      if (offenders.length) {
        push(out, mk({
          id: 'M7.gatsby.head_in_non_page', title: 'A Head export lives outside a page or template', status: 'warn', severity: 3, scope: 'site',
          location: { file: offenders[0] },
          evidence: { observed: listing(offenders, 4) + ' export a `Head` component, but Gatsby only calls Head exports from files under src/pages or from page templates.' },
          expected: 'Head exports live in src/pages/** or in the templates used by createPage.',
          recommendation: 'Move the Head export into the page or template that renders this component; a Head in a plain component is dead code.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'The tags the Head export declares appear in the built HTML.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Gatsby documents the Head API as applying to pages and templates only; an export elsewhere never runs.' },
        }));
      }
    }

    /* ---- React Router / Remix meta merging -------------------------------------------------------- */
    if (fw === 'react-router') {
      const dir = ['app/routes', 'src/routes'].find((d) => has(root, d));
      const offenders = [];
      if (dir) {
        let entries = [];
        try { entries = readdirSync(inRoot(root, dir)); } catch { entries = []; }
        for (const name of entries) {
          if (!/\.(jsx?|tsx?)$/.test(name) || /^_index\./.test(name) || /^root\./.test(name)) continue;
          const text = readText(root, join(dir, name));
          if (!text) continue;
          if (/export\s+(?:const|function)\s+meta\b/.test(text) && !/matches\s*\.\s*flatMap|\.\.\.\s*matches/.test(text)) offenders.push(join(dir, name));
        }
      }
      if (offenders.length) {
        push(out, mk({
          id: 'M7.react_router.meta_replaces_parent', title: 'A child route\'s meta export replaces the parent\'s instead of merging',
          status: 'warn', severity: 2, scope: 'site',
          location: { file: offenders[0] },
          evidence: { observed: listing(offenders, 4) + ' export `meta` without spreading the parent matches, so the tags declared in the root route are dropped for these routes.' },
          expected: 'Each child meta spreads the parent matches (…matches.flatMap(m => m.meta ?? [])) before adding its own tags.',
          recommendation: 'Spread the parent meta in each child route, or centralise the shared tags in the root route and let children add only their own.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'The rendered head of a child route still carries the root route\'s shared tags.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'React Router documents that a route\'s meta export replaces (does not merge with) its parent\'s, so unspread children lose the shared tags.' },
        }));
      }
    }

    /* ---- Jekyll: the plugin owns the head ---------------------------------------------------------- */
    if (fw === 'jekyll') {
      const cfg = readText(root, '_config.yml') || '';
      const flavor = (ctx.profile && ctx.profile.framework && ctx.profile.framework.flavor) || '';
      if (/jekyll-seo-tag/.test(cfg) || /jekyll-seo-tag/.test(flavor)) {
        push(out, mk({
          id: 'M7.jekyll.seo_tag_present', title: 'jekyll-seo-tag owns the head', status: 'not_applicable', scope: 'site',
          location: { file: '_config.yml', url: origin || undefined },
          evidence: { observed: 'Owner: jekyll-seo-tag (declared in _config.yml). It generates the title, description, canonical, Open Graph tags and JSON-LD from the front matter and _config.yml.' },
          expected: 'Head fixes are applied through front matter and _config.yml, not by editing the head include.',
          recommendation: 'Set title/description/image in the page front matter and the site defaults in _config.yml; adding the same tags to _includes/head.html would duplicate what the plugin emits.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'Changing the front matter changes the rendered head tags.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'The plugin documents which tags it emits; a manual duplicate in the layout would conflict with it.' },
        }));
      }
    }

    return out;
  },
};

export default check;
