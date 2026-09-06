// M10 — orphan detection. A page is orphaned when nothing in the sampled link graph points at it.
//
// The honest part of this check is the denominator: an orphan verdict is only as good as the crawl
// that produced it, so every finding states how many URLs were discovered, how many were sampled,
// and whether the frontier was truncated. Forced seeds (the origin, the requested target and
// --seeds URLs) are excluded — they entered the crawl by instruction, not by being linked.

import { mk, push, listing, plural, agree, originOf, isHtmlResponse, urlKey } from './_shared.mjs';

const SEED_ROLES = new Set(['homepage', 'target']);
const SEED_SOURCES = new Set(['origin', 'target', 'seeds']);

export const check = {
  id: 'links-site',
  module: 'M10',
  scope: 'site',
  ids: ['M10.orphan.no_incoming_links'],

  run(ctx) {
    const out = [];
    const crawl = ctx.crawl;
    const repro = { script: 'crawl.mjs', args: { url: (crawl && crawl.target) || originOf(ctx) || '', json: true } };

    if (!crawl || !Array.isArray(crawl.pages)) {
      push(out, mk({
        id: 'M10.orphan.no_incoming_links', title: 'Orphan pages could not be detected (no crawl in this run)',
        status: 'needs_api', scope: 'site',
        evidence: { observed: 'No crawl.json in ' + ctx.run_dir + ': without a link graph there is no inlink count to test.' },
        expected: 'A crawl manifest carrying pages[].inlinks and a link graph.',
        recommendation: 'Re-run with scripts/crawl.mjs so inbound internal links can be counted.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'crawl.json exists and its pages carry an inlinks count.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'An inlink count is a property of the graph, not of a page; a single snapshot cannot supply it.' },
      }));
      return out;
    }

    const sampling = crawl.sampling || {};
    const budget = crawl.budget || {};
    const discovered = sampling.discovered != null ? sampling.discovered : crawl.pages.length;
    const frontier = plural(crawl.pages.length, 'URL') + ' sampled of ' + discovered + ' discovered'
      + (budget.max_reached ? ', frontier cap reached' : '')
      + (budget.pages_exhausted === false ? ', page budget not exhausted' : '');

    // A manifest written before the crawler learned to skip non-HTML responses can still list an
    // /agents.md or a JSON endpoint. "No page links to your machine-readable file" is not a defect,
    // so those are dropped here too, using the snapshot the run persisted next to the manifest.
    const snapshots = new Map();
    for (const page of ctx.pages || []) { const k = urlKey(page.url); if (k) snapshots.set(k, page); }
    const isHtmlUrl = (url) => { const p = snapshots.get(urlKey(url)); return p ? isHtmlResponse(p) : true; };

    const orphans = crawl.pages.filter((p) => p
      && p.inlinks === 0
      && !SEED_ROLES.has(p.role)
      && !SEED_SOURCES.has(p.discovered_via)
      && typeof p.status === 'number' && p.status >= 200 && p.status < 300
      && p.noindex !== true
      && isHtmlUrl(p.url));

    for (const p of orphans) {
      push(out, mk({
        id: 'M10.orphan.no_incoming_links', title: 'Page has no internal links pointing at it', status: 'fail', severity: 3, scope: 'page',
        location: { url: p.url },
        evidence: { observed: p.url + ' was discovered via ' + p.discovered_via + (p.in_sitemap ? ' and is listed in the XML sitemap' : '') + ', and 0 of the crawled pages link to it (' + frontier + ').' },
        expected: 'Every indexable URL is reachable from at least one internal link.',
        recommendation: 'Link to this URL from a relevant page (a hub, a category page or the body of a related article). A sitemap entry alone gives the page no internal signal.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'At least one crawled page contains an internal anchor whose href resolves to ' + p.url + '.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents internal links as the primary discovery path; the inlink count here is only as complete as the ' + frontier + ' that produced it.' },
      }));
    }

    /* ---- sitemap URLs the crawl never reached ------------------------------------------------ */
    const sitemapUrls = ((ctx.site && ctx.site.sitemaps && ctx.site.sitemaps.sample) || []).map((s) => s.loc);
    const crawled = new Set(crawl.pages.map((p) => p.url));
    const unreached = sitemapUrls.filter((u) => !crawled.has(u));
    if (unreached.length && orphans.length === 0) {
      push(out, mk({
        id: 'M10.orphan.no_incoming_links', title: 'Sitemap URLs the crawl never reached through a link',
        status: 'needs_api', scope: 'site',
        evidence: { observed: plural(unreached.length, 'sitemap URL') + ' ' + agree(unreached.length, 'was', 'were') + ' not sampled, so ' + agree(unreached.length, 'its inlink count is', 'their inlink counts are') + ' unknown: ' + listing(unreached, 4) + ' (' + frontier + ').' },
        expected: 'A crawl wide enough to sample every sitemap URL, or an explicit statement that the rest were not measured.',
        recommendation: 'Raise --pages / --max (or pass the URLs as --seeds) if the inlink status of these URLs matters for this audit.',
        fixable: 'advisory',
        verification: { method: 'link_graph', assertion: 'Each listed sitemap URL appears in crawl.json pages[] with an inlinks count.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Reporting these as orphans would overstate what the crawl saw; they are unmeasured, not proven unlinked.' },
      }));
    }

    return out;
  },
};

export default check;
