// The deterministic checks registry.
//
//   import { CHECKS, runChecks, loadRunContext } from './checks/index.mjs';
//   const ctx = loadRunContext('<run dir>', { psi_key, feed_path, lang, environment });
//   const { findings, stats } = await runChecks(ctx);
//
// Contract
// --------
// Every module in this directory (except the `_`-prefixed helpers) exports
//   check = { id, module, ids: [...], scope: 'page' | 'site', run(ctx) -> Finding[] }
// `run` may be sync or async. A 'page' check is invoked once per page with `ctx.page` set; a 'site'
// check is invoked once and may iterate `ctx.pages` itself (which is what the cross-URL checks do).
//
// runChecks() NEVER throws: a check that blows up is recorded in stats.errors and the rest still
// run, because an audit that dies on one bad page is worse than an audit that reports the failure.
//
// ctx = {
//   run_dir, crawl (crawl.json | null), site: { robots, sitemaps, discovery },
//   pages: [{ slug, url, snapshot, parsed, parsed_rendered, html_path, html, status, template,
//             role, in_sitemap, inlinks, ua_diff }],
//   page (set for scope 'page'), profile (platform profile | null),
//   vertical ({ primary, also[], multilingual } | null),
//   options: { lang, environment, psi_key, feed_path, ua_variants },
//   tools: { fetchImpl, psi },
// }

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJson, pageSlug } from '../lib/store.mjs';
import { isHtmlResponse, newRunState, takeDropped } from './_shared.mjs';
import { fetchRaw } from '../lib/fetch.mjs';
import { manifestFromSinglePage } from '../crawl.mjs';
import { main as psiMain } from '../psi-client.mjs';
import { loadDiscovery } from '../ai-discovery.mjs';

import { check as crawlability } from './crawlability.mjs';
import { check as indexability } from './indexability.mjs';
import { check as indexabilitySite } from './indexability-site.mjs';
import { check as onpage } from './onpage.mjs';
import { check as onpageSite } from './onpage-site.mjs';
import { check as social } from './social.mjs';
import { check as images } from './images.mjs';
import { check as links } from './links.mjs';
import { check as linksSite } from './links-site.mjs';
import { check as schema } from './schema.mjs';
import { check as sitemaps } from './sitemaps.mjs';
import { check as international } from './international.mjs';
import { check as freshness } from './freshness.mjs';
import { check as rendering } from './rendering.mjs';
import { check as aiCrawlers } from './ai-crawlers.mjs';
import { check as aiEligibility } from './ai-eligibility.mjs';
import { check as aiDiscovery } from './ai-discovery.mjs';
import { check as agenticCommerce } from './agentic-commerce.mjs';
import { check as ecommerce } from './ecommerce.mjs';
import { check as agentReadiness } from './agent-readiness.mjs';
import { check as cwv } from './cwv.mjs';
import { check as platformShopify } from './platform-shopify.mjs';
import { check as platformWordpress } from './platform-wordpress.mjs';
import { check as platformFrameworks } from './platform-frameworks.mjs';
import { check as hostingEnvironment } from './hosting-environment.mjs';

/** Registered checks, in the order they run. Order affects nothing but the output sequence. */
export const CHECKS = Object.freeze([
  crawlability,
  indexability,
  indexabilitySite,
  onpage,
  onpageSite,
  social,
  images,
  links,
  linksSite,
  schema,
  sitemaps,
  international,
  freshness,
  rendering,
  aiCrawlers,
  aiEligibility,
  aiDiscovery,
  agenticCommerce,
  ecommerce,
  agentReadiness,
  cwv,
  platformShopify,
  platformWordpress,
  platformFrameworks,
  hostingEnvironment,
]);

/** Every finding id any registered check can emit (deduped, sorted) — useful for docs and tests. */
export function knownIds() {
  const ids = new Set();
  for (const c of CHECKS) for (const id of c.ids || []) ids.add(id);
  return [...ids].sort();
}

/** Largest HTML file we will load into memory per page. Snapshots are already byte-capped. */
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

function readTextFile(path) {
  try {
    if (!path || !existsSync(path)) return null;
    if (statSync(path).size > MAX_HTML_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

/** Snapshot JSON files in <run>/pages, excluding the per-user-agent variants. */
function snapshotFiles(pagesDir) {
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith('.json') && !/\.ua-[^.]+\.json$/.test(f) && !f.endsWith('.ua-diff.json'))
    .sort();
}

function buildPage(runDir, snapshotPath, manifestEntry) {
  const snapshot = readJson(snapshotPath, null);
  if (!snapshot) return null;
  const target = snapshot.target || {};
  const slug = (manifestEntry && manifestEntry.slug) || target.slug || basename(snapshotPath, '.json');
  const url = (manifestEntry && manifestEntry.url) || target.final_url || target.value || null;
  const htmlPath = snapshot.raw_html_path ? resolve(join(runDir, snapshot.raw_html_path)) : null;
  const renderedPath = snapshot.rendered_html_path ? resolve(join(runDir, snapshot.rendered_html_path)) : null;
  const uaDiffPath = join(runDir, 'pages', slug + '.ua-diff.json');
  return {
    slug,
    url,
    snapshot,
    snapshot_path: resolve(snapshotPath),
    parsed: snapshot.parsed || null,
    parsed_rendered: snapshot.parsed_rendered || null,
    html_path: htmlPath,
    html: readTextFile(htmlPath) || (snapshot.html_inline && snapshot.html_inline.raw) || null,
    rendered_html: readTextFile(renderedPath) || (snapshot.html_inline && snapshot.html_inline.rendered) || null,
    status: manifestEntry && manifestEntry.status != null ? manifestEntry.status : (snapshot.status != null ? snapshot.status : null),
    template: (manifestEntry && manifestEntry.template) || null,
    role: (manifestEntry && manifestEntry.role) || null,
    in_sitemap: manifestEntry ? manifestEntry.in_sitemap : null,
    inlinks: manifestEntry ? manifestEntry.inlinks : null,
    ua_diff: readJson(uaDiffPath, null),
    manifest: manifestEntry || null,
  };
}

/**
 * Read a persisted run directory into a check context.
 * Falls back to manifestFromSinglePage() when the run holds one snapshot and no crawl.json, so a
 * single-page run still gets the page-level checks (the cross-URL ones then report needs_api).
 *
 * @param {string} runDir
 * @param {object} [options]  { lang, environment, psi_key, feed_path, ua_variants, vertical,
 *                              profile, fetchImpl, psi, no_network }
 */
export function loadRunContext(runDir, options = {}) {
  const dir = resolve(runDir);
  const crawl = readJson(join(dir, 'crawl.json'), null) || manifestFromSinglePage(dir);
  const site = {
    robots: readJson(join(dir, 'site', 'robots.json'), null),
    sitemaps: readJson(join(dir, 'site', 'sitemaps.json'), null),
    // loadDiscovery(), never a bare readJson: discovery.json stores a 4096-char `text_head` preview
    // per probe, and validating the preview instead of the saved body invents defects (a UCP profile
    // over the cap stops being parseable JSON at the cut). ai-discovery.mjs's CLI hydrates the same
    // way, so both readers of a run see the same bytes.
    discovery: loadDiscovery(dir),
  };
  const profile = options.profile !== undefined ? options.profile : readJson(join(dir, 'profile.json'), null);

  const pagesDir = join(dir, 'pages');
  const pages = [];
  const seen = new Set();
  for (const entry of (crawl && Array.isArray(crawl.pages) ? crawl.pages : [])) {
    const rel = entry.snapshot || ('pages/' + (entry.slug || pageSlug(entry.url || '')) + '.json');
    const abs = resolve(join(dir, rel));
    const page = buildPage(dir, abs, entry);
    if (page) { pages.push(page); seen.add(basename(abs)); }
  }
  // Any snapshot the manifest does not mention (a manually added page) still gets checked — but the
  // manifest also drops snapshots ON PURPOSE: crawl.mjs takes a 200 that is not an HTML document
  // (/agents.md, llms.txt, a JSON endpoint) out of `pages` and leaves the snapshot on disk as
  // evidence. Adding it back here would undo that decision, and the site-scoped checks that iterate
  // ctx.pages directly (crawlability, sitemaps, links-site, _shared's template grouping) would score
  // a markdown file as a web page. Same rule as the crawler's, from the same helper.
  for (const file of snapshotFiles(pagesDir)) {
    if (seen.has(file)) continue;
    const page = buildPage(dir, join(pagesDir, file), null);
    if (page && isHtmlResponse(page)) pages.push(page);
  }

  const vertical = options.vertical !== undefined
    ? options.vertical
    : (profile && (profile.vertical || (profile.verticals && { primary: profile.verticals[0] }))) || null;

  return {
    run_dir: dir,
    _state: newRunState(),
    crawl,
    site,
    pages,
    page: null,
    profile,
    vertical,
    options: {
      lang: options.lang,
      environment: options.environment,
      psi_key: options.psi_key,
      feed_path: options.feed_path,
      ua_variants: options.ua_variants,
      no_network: options.no_network,
    },
    tools: {
      fetchImpl: options.fetchImpl || fetchRaw,
      psi: options.psi || psiMain,
    },
  };
}

const message = (e) => String((e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : (e && e.message) || e));

/**
 * Run every registered check against `ctx`.
 * @returns {Promise<{findings: object[], stats: {checks_run:number, per_module:object,
 *   needs_api:number, manual_review:number, not_applicable:number, dropped:number,
 *   dropped_findings:{check:string,page?:string,id:string|null,module:string|null,errors:string[]}[],
 *   psi:('used'|'needs_api'|null), errors:{check:string,message:string,page?:string}[]}}>}
 *
 * `dropped` counts every finding that never reached the array: a check that returned a non-array,
 * a malformed object, and — the common case in production — a finding `mk()` refused because it
 * failed schema validation. `dropped_findings` names the first 20 so a schema regression is
 * diagnosable instead of looking like a clean site.
 */
export async function runChecks(ctx) {
  const findings = [];
  const stats = {
    checks_run: 0,
    per_module: {},
    needs_api: 0,
    manual_review: 0,
    not_applicable: 0,
    dropped: 0,
    dropped_findings: [],
    // What the PSI client actually did in this run (M15 sets it). Recorded here rather than
    // inferred from verification.method downstream, so no check can imply an API call it never made.
    psi: null,
    errors: [],
  };
  const context = ctx && typeof ctx === 'object' ? ctx : { pages: [], site: {}, options: {}, tools: {} };
  takeDropped(); // discard anything left over from an earlier run in this process
  /** Move the schema-invalid findings mk() refused into stats, attributed to the check that built them. */
  const drainDrops = (checkId, page) => {
    const { entries, total } = takeDropped();
    stats.dropped += total; // exact: `entries` is capped, the count is not
    for (const d of entries) {
      if (stats.dropped_findings.length < 20) stats.dropped_findings.push({ check: checkId, page: page || undefined, ...d });
    }
  };
  if (!Array.isArray(context.pages)) context.pages = [];
  // Created here, not inside a check: every page-scoped check receives a `{...context, page}` copy,
  // and only a shared object reference lets the token cache and the probe budget survive the copy.
  if (!context._state) context._state = newRunState();

  const collect = (result) => {
    if (!Array.isArray(result)) {
      if (result) stats.dropped++;
      return;
    }
    for (const f of result) {
      if (!f || typeof f !== 'object' || !f.id) { stats.dropped++; continue; }
      findings.push(f);
      const mod = f.module || 'unknown';
      stats.per_module[mod] = (stats.per_module[mod] || 0) + 1;
      if (f.status === 'needs_api') stats.needs_api++;
      else if (f.status === 'manual_review') stats.manual_review++;
      else if (f.status === 'not_applicable') stats.not_applicable++;
    }
  };

  for (const check of CHECKS) {
    if (!check || typeof check.run !== 'function') {
      stats.errors.push({ check: (check && check.id) || 'unknown', message: 'check has no run() function' });
      continue;
    }
    let ran = false;
    if (check.scope === 'page') {
      for (const page of context.pages) {
        const where = (page && page.url) || (page && page.slug) || null;
        try {
          collect(await check.run({ ...context, page }));
          ran = true;
        } catch (e) {
          stats.errors.push({ check: check.id, page: where, message: message(e) });
        }
        drainDrops(check.id, where);
      }
      if (!context.pages.length) ran = true; // nothing to iterate is not a failure
    } else {
      try {
        collect(await check.run({ ...context, page: null }));
        ran = true;
      } catch (e) {
        stats.errors.push({ check: check.id, message: message(e) });
      }
      drainDrops(check.id, null);
    }
    if (ran) stats.checks_run++;
  }

  stats.psi = (context._state && context._state.psi) || null;
  return { findings, stats };
}

export default { CHECKS, runChecks, loadRunContext, knownIds };
