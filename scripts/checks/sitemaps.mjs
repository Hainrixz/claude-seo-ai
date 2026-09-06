// M17 — XML sitemaps. Discovery and parse results come from site/sitemaps.json (lib/site.mjs);
// the per-URL verdicts are the join between the sitemap's <loc> list and the pages the crawl
// actually fetched, so a URL the crawl never visited is never reported as broken — only as
// unmeasured.
//
// M1 owns "no Sitemap: directive and nothing discovered"; this module owns "a sitemap exists but
// robots.txt does not point at it", so the two never double-count the same fact.

import { mk, push, clip, listing, plural, agree, urlKey, finalUrl, originOf, isContentPage } from './_shared.mjs';

/** With fewer <loc> entries than this, identical lastmod values are unremarkable. */
export const LASTMOD_SAMPLE_MIN = 3;

function pageIndex(ctx) {
  const byKey = new Map();
  for (const page of ctx.pages || []) {
    const t = (page.snapshot && page.snapshot.target) || {};
    for (const u of [t.requested_url, t.final_url, page.url]) {
      const k = urlKey(u);
      if (k && !byKey.has(k)) byKey.set(k, page);
    }
  }
  return byKey;
}

export const check = {
  id: 'sitemaps',
  module: 'M17',
  scope: 'site',
  ids: [
    'M17.sitemap.missing', 'M17.robots.no_sitemap_line', 'M17.sitemap.noindex_url',
    'M17.sitemap.error_url', 'M17.sitemap.redirected_url', 'M17.sitemap.missing_indexable_url',
    'M17.sitemap.lastmod_identical',
  ],

  run(ctx) {
    const out = [];
    const origin = originOf(ctx);
    const sm = ctx.site && ctx.site.sitemaps;
    const robots = ctx.site && ctx.site.robots;
    const repro = { script: 'parse-robots-sitemap.mjs', args: { url: (origin || '') + '/robots.txt', path: '/' } };

    if (!sm) {
      push(out, mk({
        id: 'M17.sitemap.missing', title: 'Sitemap discovery did not run in this run', status: 'needs_api', scope: 'site',
        evidence: { observed: 'No site/sitemaps.json in ' + ctx.run_dir + ' (the run used --artifacts none, or sitemap discovery was skipped).' },
        expected: 'A run that probes robots.txt and the well-known sitemap paths.',
        recommendation: 'Re-run without --no-sitemaps / --artifacts none so the sitemap can be fetched and parsed.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'site/sitemaps.json exists and carries a files[] list.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'A sitemap that was never fetched is unknown, not absent.' },
      }));
      return out;
    }

    const declaredInRobots = ((robots && robots.sitemaps_declared) || (sm.declared || [])).length;

    /* ---- nothing found ----------------------------------------------------------------------- */
    if (!sm.found || !sm.url_count) {
      push(out, mk({
        id: 'M17.sitemap.missing', title: 'No XML sitemap was found', status: 'fail', severity: 3, scope: 'site',
        location: { url: origin || undefined },
        evidence: { observed: 'robots.txt declares ' + plural(declaredInRobots, 'sitemap') + ' and the well-known paths returned ' + plural(sm.found || 0, 'usable sitemap') + ' with ' + (sm.url_count || 0) + ' URLs' + (sm.error ? ' (' + clip(sm.error, 100) + ')' : '') + '.' },
        expected: 'An XML sitemap reachable at /sitemap.xml or declared in robots.txt.',
        recommendation: 'Publish a sitemap listing the canonical, indexable URLs and declare it with a `Sitemap:` line in robots.txt.',
        fixable: 'auto',
        verification: { method: 'xml_parse', assertion: 'A sitemap URL returns a valid urlset or sitemapindex.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents sitemaps as a discovery aid, most valuable for large sites and pages with few internal links.' },
      }));
      return out;
    }

    /* ---- found but undeclared ---------------------------------------------------------------- */
    if (!declaredInRobots) {
      push(out, mk({
        id: 'M17.robots.no_sitemap_line', title: 'A sitemap exists but robots.txt does not declare it', status: 'warn', severity: 3, scope: 'site',
        location: { url: (origin || '') + '/robots.txt', resource: 'robots.txt' },
        evidence: { observed: plural(sm.found, 'sitemap') + ' with ' + sm.url_count + ' URLs was found' + (sm.well_known_only ? ' at a well-known path only' : '') + ', and robots.txt carries no `Sitemap:` line.' },
        expected: 'robots.txt declares every sitemap the site publishes.',
        recommendation: 'Add `Sitemap: ' + ((sm.files && sm.files[0] && sm.files[0].url) || (origin || '') + '/sitemap.xml') + '` to robots.txt.',
        fixable: 'auto',
        verification: { method: 'robots_parse', assertion: 'robots.txt contains a Sitemap: line for the discovered sitemap.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents the robots.txt Sitemap directive as one of the two supported ways to submit a sitemap; the other is Search Console.' },
      }));
    }

    /* ---- per-URL verdicts against what the crawl fetched --------------------------------------- */
    const locs = (sm.sample || []).map((s) => ({ loc: s.loc, lastmod: s.lastmod, sitemap: s.sitemap }));
    const byKey = pageIndex(ctx);
    const errored = [];
    const redirected = [];
    const excluded = [];

    for (const entry of locs) {
      const page = byKey.get(urlKey(entry.loc));
      if (!page) continue; // never fetched: reported by M10's unmeasured-URL finding, not invented here
      const status = page.status != null ? page.status : (page.snapshot && page.snapshot.status);
      if (typeof status === 'number' && status >= 400) { errored.push({ ...entry, status }); continue; }
      const t = (page.snapshot && page.snapshot.target) || {};
      const hops = (page.snapshot && page.snapshot.redirects && page.snapshot.redirects.hops) || 0;
      if (hops > 0 && t.final_url && urlKey(t.final_url) !== urlKey(entry.loc)) {
        redirected.push({ ...entry, status, final_url: t.final_url, hops });
        continue;
      }
      const noindex = !!(page.snapshot && page.snapshot.robots_directives && page.snapshot.robots_directives.effective && page.snapshot.robots_directives.effective.noindex);
      const canonicals = ((page.parsed && page.parsed.canonicals) || []).map((c) => c.abs || c.href).filter(Boolean);
      const canonical = canonicals[0] || null;
      const nonCanonical = canonical && urlKey(canonical) !== urlKey(entry.loc);
      if (noindex || nonCanonical) excluded.push({ ...entry, noindex, canonical });
    }

    if (excluded.length) {
      push(out, mk({
        id: 'M17.sitemap.noindex_url', title: 'The sitemap lists URLs the site excludes from the index', status: 'fail', severity: 3, scope: 'site',
        location: { url: excluded[0].loc },
        evidence: { observed: plural(excluded.length, 'sitemap URL') + ' ' + agree(excluded.length, 'is', 'are') + ' noindex or non-canonical: ' + listing(excluded.map((e) => e.loc + (e.noindex ? ' (noindex)' : '') + (e.canonical ? ' (canonical -> ' + e.canonical + ')' : '')), 4) + '.' },
        expected: 'A sitemap lists only canonical, indexable URLs.',
        recommendation: 'Remove the excluded URLs from the sitemap, or list the canonical version instead. A sitemap entry asks the engine to index a URL the page itself declines.',
        fixable: 'proposed',
        verification: { method: 'xml_parse', assertion: 'Every <loc> resolves to a 200 page that self-canonicalises and carries no noindex.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that sitemaps should list canonical URLs; a noindex or non-canonical entry sends a signal the page then contradicts.' },
      }));
    }

    if (errored.length) {
      push(out, mk({
        id: 'M17.sitemap.error_url', title: 'The sitemap lists URLs that return an error', status: 'fail', severity: 3, scope: 'site',
        location: { url: errored[0].loc },
        evidence: { observed: plural(errored.length, 'sitemap URL') + ' returned 4xx/5xx when crawled: ' + listing(errored.map((e) => e.loc + ' -> HTTP ' + e.status), 4) + '.' },
        expected: 'Every <loc> resolves to a 200.',
        recommendation: 'Remove the dead URLs from the sitemap (or restore the pages). A sitemap full of errors slows re-crawling of the URLs that do work.',
        fixable: 'proposed',
        verification: { method: 'xml_parse', assertion: 'Each <loc> returns a 2xx response.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google reports sitemap URLs that 404 as errors in Search Console and stops trusting the file as a freshness signal.' },
      }));
    }

    if (redirected.length) {
      push(out, mk({
        id: 'M17.sitemap.redirected_url', title: 'The sitemap lists URLs that redirect', status: 'warn', severity: 3, scope: 'site',
        location: { url: redirected[0].loc },
        evidence: { observed: plural(redirected.length, 'sitemap URL') + ' redirects: ' + listing(redirected.map((e) => e.loc + ' -> ' + e.final_url + ' (' + plural(e.hops, 'hop') + ')'), 4) + '.' },
        expected: 'A sitemap lists final URLs, not redirect sources.',
        recommendation: 'Replace the listed entries with their destinations.',
        fixable: 'proposed',
        verification: { method: 'xml_parse', assertion: 'Each <loc> returns 200 without a redirect.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that sitemap URLs should be the canonical destination; a redirecting entry costs a hop on every re-crawl.' },
      }));
    }

    /* ---- indexable pages missing from the sitemap ---------------------------------------------- */
    const missing = (ctx.pages || []).filter((p) => {
      if (!isContentPage(p)) return false;
      const eff = p.snapshot && p.snapshot.robots_directives && p.snapshot.robots_directives.effective;
      if (eff && eff.noindex) return false;
      return p.in_sitemap === false;
    });
    if (missing.length) {
      push(out, mk({
        id: 'M17.sitemap.missing_indexable_url', title: 'Indexable pages the crawl found are absent from the sitemap', status: 'warn', severity: 3, scope: 'site',
        location: { url: finalUrl(missing[0]) },
        evidence: { observed: plural(missing.length, 'crawled indexable URL') + ' ' + agree(missing.length, 'is', 'are') + ' not listed in any sitemap (' + sm.url_count + ' URLs across ' + plural(sm.found, 'sitemap file') + '): ' + listing(missing.map((p) => finalUrl(p)), 4) + '.' },
        expected: 'Every indexable URL appears in a sitemap.',
        recommendation: 'Regenerate the sitemap from the same source that generates the site\'s routes so new URLs cannot be forgotten.',
        fixable: 'proposed',
        verification: { method: 'xml_parse', assertion: 'Each listed URL appears as a <loc> in one of the site\'s sitemaps.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Well-linked pages are discovered without a sitemap; the gap matters most for URLs with few internal links, which this check cannot rank.' },
      }));
    }

    /* ---- lastmod anti-pattern ------------------------------------------------------------------ */
    const lm = sm.lastmod || {};
    if (lm.count >= LASTMOD_SAMPLE_MIN && lm.min && lm.max && lm.min === lm.max && lm.count === sm.url_count) {
      push(out, mk({
        id: 'M17.sitemap.lastmod_identical', title: 'Every sitemap URL carries the same lastmod', status: 'warn', severity: 2, scope: 'site',
        location: { url: (sm.files && sm.files[0] && sm.files[0].url) || undefined },
        evidence: { observed: 'All ' + lm.count + ' <lastmod> values equal ' + lm.min + ', so the file cannot distinguish a changed page from an unchanged one.' },
        expected: 'lastmod reflects when each URL last changed meaningfully.',
        recommendation: 'Emit the real per-URL modification date, or omit lastmod entirely — a build timestamp on every URL is worse than none.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'The sitemap carries more than one distinct <lastmod> value, or none at all.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google states it ignores lastmod when a site reports it inconsistently; the effect is a loss of the recrawl hint, not a penalty.' },
      }));
    }

    return out;
  },
};

export default check;
