// M2 — per-page indexability. Canonicalisation, the noindex pair, mixed content, and the
// user-agent divergence recorded by ua-diff.mjs.
//
// The one rule this file exists to get right: `noindex` + a canonical that points ELSEWHERE is a
// contradiction Google resolves unpredictably (M2.canonical.noindex_conflict). `noindex` with a
// self-referential canonical is a coherent exclusion — the page is meant to be out of the index —
// so it is reported as M2.robots.noindex_present and never as a lethal defect. The escalation to
// M2.robots.unintended_noindex only exists after a human confirms the URL should be indexed, so
// this check never emits it.

import {
  mk, push, clip, listing, canonicalsOf, canonicalTarget, effectiveRobots,
  finalUrl, isContentPage, snapRepro, contentPages,
} from './_shared.mjs';

/** Assets that make an HTTPS page "mixed content" when they are served over plain http://. */
function httpAssets(parsed) {
  if (!parsed) return [];
  const out = [];
  const add = (list, kind, key) => {
    for (const item of list || []) {
      const abs = item && (item[key] || item.abs);
      if (typeof abs === 'string' && abs.startsWith('http://')) out.push({ kind, url: abs });
    }
  };
  add(parsed.scripts, 'script', 'abs');
  add(parsed.stylesheets, 'stylesheet', 'abs');
  add(parsed.images, 'image', 'abs');
  add(parsed.iframes, 'iframe', 'abs');
  return out;
}

export const check = {
  id: 'indexability',
  module: 'M2',
  scope: 'page',
  ids: ['M2.canonical.missing', 'M2.canonical.noindex_conflict', 'M2.robots.noindex_present', 'M2.mixed_content', 'M2.cloaking.ua_content_divergence'],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const url = finalUrl(page);
    const parsed = page.parsed || {};
    const repro = snapRepro(ctx, page, 'parse-html.mjs');
    const canonicals = canonicalsOf(page);
    const target = canonicalTarget(page);
    const robots = effectiveRobots(page) || {};

    /* ---- canonical missing ------------------------------------------------------------------ */
    if (!canonicals.length) {
      const title = parsed.title && parsed.title.value ? String(parsed.title.value).trim() : '';
      const twins = title ? contentPages(ctx).filter((p) => p !== page && p.parsed && p.parsed.title && String(p.parsed.title.value || '').trim() === title) : [];
      push(out, mk({
        id: 'M2.canonical.missing', title: 'No rel=canonical on an indexable page',
        status: twins.length ? 'fail' : 'warn', severity: 4, scope: 'page',
        location: { url },
        evidence: {
          observed: 'No <link rel="canonical"> and no `Link: <…>; rel="canonical"` header on ' + url + '.'
            + (twins.length ? ' ' + twins.length + ' other sampled URL(s) serve the same <title> "' + clip(title, 80) + '": ' + listing(twins.map((p) => finalUrl(p)), 3) + '.' : ''),
        },
        expected: 'Every indexable URL declares the canonical version of itself.',
        recommendation: 'Add a self-referential <link rel="canonical" href="' + url + '"> (or the equivalent Link header) to this template.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'The page head contains exactly one <link rel="canonical"> resolving to the page\'s own URL.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents rel=canonical as the strongest of its canonicalisation signals; without it the engine picks a canonical for you.' },
      }));
    }

    /* ---- the noindex pair ------------------------------------------------------------------- */
    if (robots.noindex) {
      const sources = (page.snapshot && page.snapshot.robots_directives && page.snapshot.robots_directives.sources) || [];
      const raw = (() => {
        const rd = page.snapshot && page.snapshot.robots_directives;
        const header = rd && rd.header && rd.header.raw ? 'X-Robots-Tag: ' + rd.header.raw : null;
        const meta = rd && Array.isArray(rd.meta) && rd.meta.length ? '<meta name="' + rd.meta[0].name + '" content="' + rd.meta[0].content + '">' : null;
        return [header, meta].filter(Boolean).join(' and ') || 'noindex (source not recorded)';
      })();

      if (target.kind === 'other') {
        push(out, mk({
          id: 'M2.canonical.noindex_conflict', title: 'noindex on a page whose canonical points at a different URL',
          status: 'fail', severity: 4, scope: 'page',
          location: { url },
          evidence: { observed: url + ' serves ' + raw + ' (from ' + listing(sources, 2) + ') while its canonical points at ' + target.abs + '.' },
          expected: 'A page either excludes itself with noindex and a self-referential canonical, or points its canonical at the URL that should be indexed without noindex.',
          recommendation: 'Decide which URL should be indexed. If it is the canonical target, drop the noindex here and let the canonical consolidate; if this URL must stay out, make the canonical self-referential.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'The page does not combine a noindex directive with a canonical pointing at another URL.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that noindex and a cross-URL canonical are contradictory signals; the engine may apply the noindex to the canonical target.' },
        }));
      } else {
        push(out, mk({
          id: 'M2.robots.noindex_present', title: 'Page is excluded from the index by a noindex directive',
          status: 'warn', severity: 3, scope: 'page',
          location: { url },
          evidence: { observed: url + ' serves ' + raw + ' (from ' + listing(sources, 2) + ')' + (target.kind === 'self' ? ' with a self-referential canonical' : ' and declares no canonical') + '.' },
          expected: 'Only URLs that are deliberately kept out of search results carry noindex.',
          recommendation: 'Confirm this exclusion is intentional. If the URL is meant to rank, remove the noindex — and only then does this become the severity-5 M2.robots.unintended_noindex.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'The effective robots directives for this URL contain noindex.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents noindex as removing the URL from search results; whether that is a defect depends on intent, which this check cannot observe.' },
        }));
      }
    }

    /* ---- mixed content ---------------------------------------------------------------------- */
    if (typeof url === 'string' && url.startsWith('https://')) {
      const insecure = httpAssets(parsed);
      if (insecure.length) {
        push(out, mk({
          id: 'M2.mixed_content', title: 'HTTPS page loads subresources over plain HTTP',
          status: 'warn', severity: 3, scope: 'page',
          location: { url },
          evidence: { observed: insecure.length + ' http:// subresource(s) on an https:// page: ' + listing(insecure.map((a) => a.kind + ' ' + a.url), 4) + '.' },
          expected: 'Every subresource on an HTTPS page is itself requested over HTTPS.',
          recommendation: 'Serve the listed assets over HTTPS (or use protocol-relative/absolute https URLs). Browsers block active mixed content outright and upgrade or block passive mixed content.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'No src/href on the page resolves to an http:// URL.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Browsers document that active mixed content is blocked, so the affected script or stylesheet never runs for the user or the renderer.' },
        }));
      }
    }

    /* ---- UA divergence (cloaking-shaped, from ua-diff.mjs) ---------------------------------- */
    const diff = page.ua_diff;
    if (diff && Array.isArray(diff.diffs)) {
      const gb = diff.diffs.find((d) => d.ua === 'googlebot' && d.differs);
      if (gb) {
        const variant = (diff.variants || []).find((v) => v.ua === 'googlebot') || {};
        const base = (diff.variants || []).find((v) => v.ua === diff.baseline) || {};
        const reasons = ['status_differs', 'title_or_h1_differs', 'canonical_differs', 'noindex_differs', 'jsonld_differs'].filter((k) => gb[k]);
        push(out, mk({
          id: 'M2.cloaking.ua_content_divergence', title: 'The origin answers Googlebot differently from a default browser user-agent',
          status: 'warn', severity: 4, scope: 'page',
          location: { url },
          evidence: { observed: 'ua-diff on ' + url + ': ' + listing(reasons, 5) + '. default -> HTTP ' + base.status + ' "' + clip(base.title, 60) + '" (' + base.word_count + ' words); googlebot -> HTTP ' + variant.status + ' "' + clip(variant.title, 60) + '" (' + variant.word_count + ' words).' },
          expected: 'The same URL returns the same content to Googlebot and to a browser.',
          recommendation: 'Find the edge rule or bot-detection branch behind the difference and serve both agents the same document. Verify the requesting IP with reverse DNS before treating a spoofed UA as a real crawler.',
          fixable: 'advisory',
          verification: { method: 'ua_diff', assertion: 'The googlebot variant matches the default variant on status, title/H1, canonical, noindex and JSON-LD types.' },
          reproduce: { script: 'ua-diff.mjs', args: { url, ua: 'default,googlebot,gptbot,oai-searchbot,claude-searchbot' } },
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Serving crawlers different content is against Google spam policies, but a difference measured from one client can also be caching, geo-routing or bot mitigation, so the cause is not established here.' },
        }));
      }
    }

    return out;
  },
};

export default check;
