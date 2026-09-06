// M7 — cross-URL head hygiene: the same <title> or meta description served from several distinct
// URLs. Distinctness is decided by lib/urlnorm normalizeUrl (lower-case host, no fragment, no
// trailing slash, tracking parameters removed), so `/a` and `/a/#x` are one URL while `/a` and
// `/a?ref=x` are two — the second pair really is two crawlable URLs with one title.
//
// Only sampled pages can be compared, so the evidence always states how many URLs were in scope.
//
// This module also carries the two M7b mobile items no static pass can decide (viewport overflow
// and tap-target geometry). They are reported once per run as needs_api rather than per page,
// because "we did not measure this" is one fact about the run, not one fact per URL.

import { mk, push, clip, listing, plural, contentPages, finalUrl, urlKey, originOf, snapRepro } from './_shared.mjs';

/** Ignore near-empty strings: an empty title is M7.title.missing, not a duplicate. */
const MIN_CHARS = 3;

function cluster(pages, pick) {
  const groups = new Map();
  for (const page of pages) {
    const value = pick(page);
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text.length < MIN_CHARS) continue;
    const key = text.toLowerCase();
    if (!groups.has(key)) groups.set(key, { text, urls: new Set() });
    const url = finalUrl(page);
    groups.get(key).urls.add(urlKey(url) || url);
  }
  return [...groups.values()].filter((g) => g.urls.size > 1);
}

const descOf = (page) => {
  for (const m of (page.parsed && page.parsed.metas) || []) if (m && m.name === 'description') return m.content;
  return null;
};

export const check = {
  id: 'onpage-site',
  module: 'M7',
  scope: 'site',
  ids: [
    'M7.title.duplicate_across_urls', 'M7.description.duplicate_across_urls',
    'M7b.layout.horizontal_scroll', 'M7b.taptarget.too_small',
  ],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx);
    const repro = { script: 'crawl.mjs', args: { url: (ctx.crawl && ctx.crawl.target) || originOf(ctx) || '', json: true } };

    if (pages.length < 2) {
      push(out, mk({
        id: 'M7.title.duplicate_across_urls', title: 'Duplicate titles could not be checked (one page in this run)',
        status: 'needs_api', scope: 'site',
        evidence: { observed: plural(pages.length, 'content page') + ' in ' + ctx.run_dir + ': a duplicate needs at least two URLs to compare.' },
        expected: 'A crawl that samples several URLs per template.',
        recommendation: 'Re-run with scripts/crawl.mjs so titles and descriptions can be compared across URLs.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The run holds two or more page snapshots.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Duplication is a relation between URLs; a single snapshot cannot evidence or refute it.' },
      }));
      return out;
    }

    /* ---- the two M7b items that need a laid-out page, stated once per run ------------------- */
    // Overflow and tap-target geometry come from computed styles and layout boxes. A static pass
    // cannot see either, so they are reported as unmeasured rather than quietly passing.
    for (const [id, title, what, how] of [
      ['M7b.layout.horizontal_scroll', 'Horizontal overflow was not measured',
        'whether content overflows a 360 px viewport depends on computed widths, not on the HTML source',
        'npx lighthouse <url> --only-categories=seo,accessibility --form-factor=mobile'],
      ['M7b.taptarget.too_small', 'Tap-target size was not measured',
        'target size and spacing need layout boxes, which the HTML source does not carry',
        'npx lighthouse <url> --only-categories=accessibility --form-factor=mobile'],
    ]) {
      push(out, mk({
        id, title, status: 'needs_api', scope: 'site',
        location: { url: finalUrl(pages[0]) },
        evidence: { observed: 'Not measured in this run: ' + what + '. ' + plural(pages.length, 'page') + ' were parsed from static HTML only.' },
        expected: 'A rendered-page audit that reports viewport overflow and tap-target geometry.',
        recommendation: 'Run ' + how + ' against the URLs that matter, or re-run this audit with a renderer attached.',
        fixable: 'advisory',
        verification: { method: 'manual_review', assertion: 'A mobile Lighthouse run reports no horizontal overflow and no undersized tap targets.' },
        reproduce: snapRepro(ctx, pages[0], 'parse-html.mjs'),
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google documents mobile usability expectations but publishes no static test for them; claiming a pass from the HTML alone would be a fabrication.' },
      }));
    }

    const scope = plural(pages.length, 'sampled URL');
    for (const g of cluster(pages, (p) => (p.parsed && p.parsed.title ? p.parsed.title.value : null))) {
      const urls = [...g.urls];
      push(out, mk({
        id: 'M7.title.duplicate_across_urls', title: 'The same <title> is served from several URLs',
        status: 'warn', severity: 3, scope: 'site',
        location: { url: urls[0] },
        evidence: { observed: '"' + clip(g.text, 100) + '" is the <title> of ' + urls.length + ' distinct URLs: ' + listing(urls, 5) + ' (out of ' + scope + ').' },
        expected: 'Each indexable URL carries a title that distinguishes it from the rest of the site.',
        recommendation: 'Give each URL a distinct title, or consolidate the duplicates with rel=canonical / a redirect if they are the same page.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'No two distinct indexable URLs return the same <title>.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Search Console reports duplicate titles as a quality issue; the ranking effect depends on whether the URLs are genuinely different pages, which this check cannot decide.' },
      }));
    }

    for (const g of cluster(pages, descOf)) {
      const urls = [...g.urls];
      push(out, mk({
        id: 'M7.description.duplicate_across_urls', title: 'The same meta description is served from several URLs',
        status: 'warn', severity: 2, scope: 'site',
        location: { url: urls[0] },
        evidence: { observed: '"' + clip(g.text, 100) + '" is the meta description of ' + urls.length + ' distinct URLs: ' + listing(urls, 5) + ' (out of ' + scope + ').' },
        expected: 'Each URL describes itself.',
        recommendation: 'Write a per-URL description, or drop the shared one and let the engine generate a snippet from the page.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'No two distinct indexable URLs return the same meta description.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google rewrites descriptions it finds unhelpful; a repeated description mostly costs the site control of its own snippet.' },
      }));
    }

    return out;
  },
};

export default check;
