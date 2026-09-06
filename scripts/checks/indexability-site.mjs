// M2 — cross-URL indexability: redirect chains and loops, broken internal links and HTTPS
// enforcement. These need more than one URL, so they read the crawl manifest (crawl.json) and the
// site/discovery.json HTTP->HTTPS probe rather than a single snapshot.
//
// Without a crawl there is nothing to cross-check, so the module reports needs_api with the reason
// instead of passing silently.

import { mk, push, listing, plural, originOf } from './_shared.mjs';

/** How many hops past the first response count as a chain (1 hop = a single, normal redirect). */
export const CHAIN_HOPS = 2;

/** `A -> 301 -> B -> 302 -> C`, the shape a human can follow. */
function chainText(entry) {
  const hops = (entry.chain || []).map((h) => h.url + ' -> ' + h.status);
  return hops.join(' -> ') + (entry.final_url ? ' -> ' + entry.final_url + ' (' + entry.status + ')' : '');
}

export const check = {
  id: 'indexability-site',
  module: 'M2',
  scope: 'site',
  ids: ['M2.redirect.chain', 'M2.redirect.loop', 'M2.links.broken_internal', 'M2.https.not_enforced'],

  run(ctx) {
    const out = [];
    const crawl = ctx.crawl;
    const repro = { script: 'crawl.mjs', args: { url: (crawl && crawl.target) || originOf(ctx) || '', json: true } };

    if (!crawl) {
      push(out, mk({
        id: 'M2.links.broken_internal', title: 'Internal link health was not measured (no crawl in this run)',
        status: 'needs_api', scope: 'site',
        evidence: { observed: 'No crawl.json in ' + ctx.run_dir + ': this run holds a single snapshot, so no internal link was followed and no redirect chain was resolved.' },
        expected: 'A multi-page run (crawl.mjs) that probes internal links and records their status chains.',
        recommendation: 'Re-run with scripts/crawl.mjs (or the audit command without --single-page) to cross-check internal links, redirects and orphans.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'crawl.json exists and its link_status block lists probed internal links.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Broken links and redirect chains are cross-URL facts; one page cannot evidence them, so the result is unknown rather than clean.' },
      }));
      return out;
    }

    const probes = (crawl.link_status && crawl.link_status.results) || [];
    const budget = (crawl.link_status && crawl.link_status.budget) || 0;
    const checked = (crawl.link_status && crawl.link_status.checked) || 0;
    const frontier = 'link-status budget ' + budget + ', ' + plural(checked, 'URL') + ' probed';

    /* ---- loops ------------------------------------------------------------------------------ */
    const loops = probes.filter((r) => r.loop);
    // A loop reached from several sampled URLs is a rule, not an accident: report it once, at template scope.
    const loopScope = loops.length > 1 ? 'template' : 'page';
    for (const r of loops) {
      push(out, mk({
        id: 'M2.redirect.loop', title: 'Internal link redirects in a loop and never resolves',
        status: 'fail', severity: loopScope === 'template' ? 5 : 4, scope: loopScope,
        location: { url: r.url },
        evidence: { observed: chainText(r) + ' — the chain returns to a URL it already visited (' + frontier + ').' },
        expected: 'Every internal link resolves to a 200 within a small number of hops.',
        recommendation: 'Fix the redirect rule that sends the URL back into the chain, then re-probe. A looping URL is unreachable for users and crawlers alike.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'Following ' + r.url + ' terminates at a 2xx without revisiting a URL.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that it gives up on a redirect loop; the destination content is never fetched.' },
      }));
    }

    /* ---- chains ----------------------------------------------------------------------------- */
    // Two sources: the link-status probes (URLs the crawl chose not to fetch) and the sampled pages
    // themselves, whose manifest entry records how many hops the fetch cost.
    const chains = probes.filter((r) => !r.loop && (r.hops || 0) >= CHAIN_HOPS);
    const probed = new Set(probes.map((r) => r.url));
    for (const p of crawl.pages || []) {
      if (!p || (p.hops || 0) < CHAIN_HOPS || probed.has(p.url)) continue;
      chains.push({ url: p.url, hops: p.hops, final_url: p.url, inlinks: p.inlinks || 0, chain: [], from_page: true });
    }
    for (const r of chains) {
      push(out, mk({
        id: 'M2.redirect.chain', title: 'Internal link traverses more than one redirect before 200',
        status: 'warn', severity: 4, scope: 'page',
        location: { url: r.url },
        evidence: {
          observed: r.from_page
            ? plural(r.hops, 'hop') + ' before ' + r.url + ' answered 200; the crawl followed the whole chain in one fetch, so only the hop count was recorded.'
            : plural(r.hops, 'hop') + ': ' + chainText(r) + ' (linked from ' + plural(r.inlinks || 0, 'sampled page') + ').',
        },
        expected: 'Internal links point at the final URL, so a fetch costs at most one redirect.',
        recommendation: 'Update the links (or the first redirect rule) to point straight at ' + (r.final_url || 'the final URL') + '.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'GET ' + r.url + ' reaches a 2xx in at most one hop.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that it follows a limited number of hops per crawl attempt and that chains waste crawl budget.' },
      }));
    }

    /* ---- broken internal links --------------------------------------------------------------- */
    const brokenProbes = probes.filter((r) => r.broken || (r.status >= 400));
    const brokenPages = (crawl.pages || []).filter((p) => typeof p.status === 'number' && p.status >= 400);
    const broken = new Map();
    for (const r of brokenProbes) broken.set(r.url, { url: r.url, status: r.status, inlinks: r.inlinks || 0, error: r.error });
    for (const p of brokenPages) if (!broken.has(p.url)) broken.set(p.url, { url: p.url, status: p.status, inlinks: p.inlinks || 0, error: null });
    if (broken.size) {
      const list = [...broken.values()];
      push(out, mk({
        id: 'M2.links.broken_internal', title: 'Internal links point at URLs that return an error',
        status: 'warn', severity: 3, scope: 'site',
        location: { url: list[0].url },
        evidence: { observed: plural(list.length, 'internal URL') + ' returned 4xx/5xx: ' + listing(list.map((b) => b.url + ' -> HTTP ' + b.status + (b.inlinks ? ' (' + plural(b.inlinks, 'inlink') + ')' : '')), 5) + '. ' + frontier + '.' },
        expected: 'Internal links resolve to 200, or the link is removed.',
        recommendation: 'Fix or remove the links to the URLs above; redirect the ones that moved to their new location.',
        fixable: 'proposed',
        verification: { method: 'link_graph', assertion: 'Each listed URL returns a 2xx, or is no longer linked internally.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that a 404 URL is dropped from the index; internal links pointing at it also waste the crawl requests they attract.' },
      }));
    }

    /* ---- HTTPS enforcement ------------------------------------------------------------------- */
    const https = ctx.site && ctx.site.discovery && ctx.site.discovery.https_enforcement;
    if (https && https.applicable && https.redirects_to_https === false) {
      push(out, mk({
        id: 'M2.https.not_enforced', title: 'The HTTP URL does not redirect to HTTPS',
        status: 'fail', severity: 4, scope: 'site',
        location: { url: https.url || originOf(ctx) },
        evidence: { observed: 'GET ' + https.url + ' -> HTTP ' + https.status + (https.final_url ? ' ending at ' + https.final_url : '') + ' after ' + plural(https.hops || 0, 'hop') + '; the response never moves to https://.' },
        expected: 'http:// requests answer with a 301 to the https:// equivalent.',
        recommendation: 'Add a site-wide 301 from http:// to https:// (and an HSTS header once it is stable).',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'GET the http:// origin returns a 301/308 whose Location is the https:// URL.' },
        reproduce: { script: 'ai-discovery.mjs', args: { 'run-dir': ctx.run_dir } },
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents HTTPS as a ranking signal and canonicalises to the secure URL; an unredirected http:// copy splits the two.' },
      }));
    }

    return out;
  },
};

export default check;
