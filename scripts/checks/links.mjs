// M10 — internal linking, per page. Contextual link volume, anchor quality and the semantic
// landmark that separates in-body links from navigation.
//
// Anchor quality is language-dependent: the generic-anchor lexicon only covers EN and ES, so on a
// page in any other language that part is skipped and the reason is stated, never scored as clean.

import { detectLang, lexiconFor } from '../lib/lang.mjs';
import { mk, push, clip, listing, plural, finalUrl, isContentPage, snapRepro, tokensFor } from './_shared.mjs';

/** Below this many in-body internal links a page is effectively a leaf in the link graph. */
export const MIN_CONTEXTUAL_LINKS = 3;

export const check = {
  id: 'links',
  module: 'M10',
  scope: 'page',
  ids: ['M10.contextual.too_few_inbody_links', 'M10.anchor.generic_text', 'M10.semantic.missing_main'],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const parsed = page.parsed || {};
    const url = finalUrl(page);
    const repro = snapRepro(ctx, page, 'link-graph.mjs');
    const at = { location: { url } };

    const anchors = (parsed.anchors || []).filter((a) => a && a.href && a.scheme === 'http');
    const contextual = anchors.filter((a) => a.in_content && a.internal === true);

    if (contextual.length < MIN_CONTEXTUAL_LINKS) {
      push(out, mk({
        id: 'M10.contextual.too_few_inbody_links', title: 'Few contextual in-body internal links', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: plural(contextual.length, 'internal link') + ' inside the content region of ' + url + ' (' + anchors.length + ' http anchors on the page in total; the rest sit in nav/header/footer/aside).' },
        expected: 'At least ' + MIN_CONTEXTUAL_LINKS + ' contextual links from the body text to related pages.',
        recommendation: 'Link from the body copy to the pages this one references, using anchor text that names the destination.',
        fixable: 'proposed',
        verification: { method: 'link_graph', assertion: 'The content region contains at least ' + MIN_CONTEXTUAL_LINKS + ' internal anchors.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Internal links are how Google discovers and weights pages, but no engine publishes a minimum count — the threshold is ours.' },
      }));
    }

    /* ---- generic anchors (EN/ES lexicons only) ------------------------------------------------ */
    const det = detectLang(tokensFor(ctx, page) || page.html || '', { flag: ctx.options && ctx.options.lang, doc: parsed });
    const lex = det.supported ? lexiconFor(det.lang) : null;
    if (lex && lex.generic_anchor) {
      const generic = anchors.filter((a) => a.anchor && lex.generic_anchor.test(String(a.anchor).trim()));
      if (generic.length) {
        push(out, mk({
          id: 'M10.anchor.generic_text', title: 'Anchors use generic text that does not name the destination', status: 'warn', severity: 3, scope: 'page', ...at,
          evidence: { observed: plural(generic.length, 'anchor') + ' of ' + anchors.length + ' on ' + url + ' reads as generic ' + det.lang + ' link text: ' + listing(generic.map((a) => '"' + clip(a.anchor, 40) + '" -> ' + clip(a.abs || a.href, 60)), 3) + '.' },
          expected: 'Anchor text names the page it points at.',
          recommendation: 'Replace the generic anchors with text describing the destination (the destination\'s topic, not "read more").',
          fixable: 'proposed',
          verification: { method: 'link_graph', assertion: 'No anchor text matches the generic-anchor lexicon for the page language.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google documents descriptive anchor text as a signal about the destination; the size of the effect is not published.' },
        }));
      }
    }

    /* ---- landmark --------------------------------------------------------------------------- */
    const lm = parsed.landmarks || {};
    if (!lm.main && !lm.article) {
      push(out, mk({
        id: 'M10.semantic.missing_main', title: 'No <main>/<article> landmark separating content links from navigation', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: 'No <main>, <article> or role="main" on ' + url + ', so all ' + anchors.length + ' http anchors are treated as one undifferentiated set; landmarks seen: ' + (listing(Object.entries(lm).filter(([, v]) => v).map(([k]) => k), 6)) + '.' },
        expected: 'The primary content sits inside <main> (or <article>), so in-body links are distinguishable from boilerplate.',
        recommendation: 'Wrap the primary content in <main>; keep site navigation in <nav> and the footer in <footer>.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The document has a <main>/<article> landmark and its links can be separated from navigation.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Landmarks let a consumer tell body links from site-wide navigation; search engines infer this without them, so the effect is on extraction rather than ranking.' },
      }));
    }

    return out;
  },
};

export default check;
