// M4 — rendering. Everything here is read from the snapshot's own render block: whether a render
// was needed, whether one actually ran, and what the raw-vs-rendered delta contained.
//
// Two rules keep this module honest:
//   1. If a render was needed and none ran, the answer is needs_api — never "the page is fine".
//   2. M4.render.csr_only_primary_content is the only capping finding in the module, and it only
//      reaches template scope (where a cap is possible) when every sampled page of one template
//      shows the same shell. A single page stays at page scope, so it cannot cap a score.

import { RENDER_WORD_THRESHOLD } from '../lib/renderers.mjs';
import { mk, push, listing, plural, agree, contentPages, finalUrl, snapRepro } from './_shared.mjs';

/** Rendered words must exceed the raw count by this factor before "the raw HTML is a shell" holds. */
export const SHELL_WORD_RATIO = 2;

const renderOf = (page) => (page.snapshot && page.snapshot.render) || null;

function isShell(page) {
  const r = renderOf(page);
  if (!r || !r.delta) return false;
  const rawWords = (page.parsed && page.parsed.word_count) || 0;
  const added = r.delta.words || 0;
  return rawWords < RENDER_WORD_THRESHOLD && (r.delta.h1_added > 0 || added >= Math.max(RENDER_WORD_THRESHOLD, rawWords * SHELL_WORD_RATIO));
}

export const check = {
  id: 'rendering',
  module: 'M4',
  scope: 'site',
  ids: ['M4.render.needs_renderer', 'M4.render.csr_only_primary_content', 'M4.render.jsonld_js_injected', 'M4.render.lazy_main_content'],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx);

    /* ---- a render was needed and none ran ----------------------------------------------------- */
    const unrendered = pages.filter((p) => {
      const r = renderOf(p);
      return r && r.needed && (!r.used || r.used === 'none');
    });
    if (unrendered.length) {
      const first = unrendered[0];
      const r = renderOf(first);
      push(out, mk({
        id: 'M4.render.needs_renderer', title: 'Pages show client-side-rendering signals and no renderer was available', status: 'needs_api', severity: 3, scope: 'site',
        location: { url: finalUrl(first) },
        evidence: { observed: plural(unrendered.length, 'sampled page') + ' of ' + pages.length + ' reports render.needed with render.used="none" (signals on ' + finalUrl(first) + ': ' + listing(r.signals || [], 4) + '; mode "' + r.mode + '", renderer "' + r.renderer + '"). The raw-vs-rendered delta could not be measured.' },
        expected: 'A run with a renderer (--render js, or --rendered-file with a DOM captured elsewhere) so the delta can be measured.',
        recommendation: (r && r.hint) || 'Re-run with --render js (Chrome or Playwright), or pass --rendered-file <dom.html> from an MCP browser capture.',
        fixable: 'advisory',
        verification: { method: 'render_diff', assertion: 'The snapshot carries render.used != "none" and a render.delta object.' },
        reproduce: snapRepro(ctx, first, 'snapshot.mjs', { render: 'js' }),
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'The CSR signals (low word count, empty framework root, hydration markers) are heuristics; only a real render can confirm or refute them, so the result is unknown rather than clean.' },
      }));
    }

    /* ---- CSR-only primary content ------------------------------------------------------------- */
    const shells = pages.filter(isShell);
    if (shells.length) {
      // Group by template: a whole template rendered client-side is a site-level fact and may cap.
      const byTemplate = new Map();
      for (const p of shells) {
        const key = p.template || '(no template)';
        if (!byTemplate.has(key)) byTemplate.set(key, []);
        byTemplate.get(key).push(p);
      }
      for (const [template, group] of byTemplate) {
        const sameTemplate = pages.filter((p) => (p.template || '(no template)') === template);
        const wholeTemplate = group.length >= 2 && group.length === sameTemplate.length;
        const first = group[0];
        const d = renderOf(first).delta;
        push(out, mk({
          id: 'M4.render.csr_only_primary_content', title: 'Primary content exists only after JavaScript runs', status: 'fail', severity: 5,
          scope: wholeTemplate ? 'template' : 'page',
          location: { url: finalUrl(first) },
          evidence: { observed: (wholeTemplate ? 'All ' + plural(group.length, 'sampled page') + ' of template "' + template + '"' : finalUrl(first))
            + (wholeTemplate ? ' ' + agree(group.length, 'serves', 'serve') + ' ' : ' serves ') + ((first.parsed && first.parsed.word_count) || 0) + ' words of raw HTML; rendering adds ' + (d.words || 0) + ' words, ' + (d.h1_added || 0) + ' H1(s), ' + (d.headings || 0) + ' heading(s) and ' + (d.anchors || 0) + ' link(s).' },
          expected: 'The H1 and the body text are present in the HTML the server returns.',
          recommendation: 'Server-render (or pre-render) the primary content for this template. Every consumer that does not execute JavaScript — including AI crawlers that fetch without rendering — sees only the shell.',
          fixable: 'advisory',
          verification: { method: 'render_diff', assertion: 'The raw HTML already contains the H1 and the bulk of the body text (render delta near zero).' },
          reproduce: snapRepro(ctx, first, 'snapshot.mjs', { render: 'js' }),
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents that rendering is deferred and not guaranteed for every page, and several AI crawlers document that they do not execute JavaScript at all.' },
        }));
      }
    }

    /* ---- JSON-LD injected by script ------------------------------------------------------------ */
    for (const p of pages) {
      const r = renderOf(p);
      if (!r || !r.delta) continue;
      if ((r.delta.jsonld_blocks || 0) > 0) {
        push(out, mk({
          id: 'M4.render.jsonld_js_injected', title: 'JSON-LD appears only after hydration', status: 'warn', severity: 3, scope: 'page',
          location: { url: finalUrl(p) },
          evidence: { observed: (r.delta.jsonld_blocks) + ' ld+json block(s) exist only in the rendered DOM of ' + finalUrl(p) + '; the raw HTML carries ' + (((p.parsed && p.parsed.jsonld) || []).length) + '.' },
          expected: 'Structured data is in the HTML the server returns.',
          recommendation: 'Emit the JSON-LD server-side (a <script type="application/ld+json"> in the initial HTML), not from a client-side effect.',
          fixable: 'advisory',
          verification: { method: 'render_diff', assertion: 'The raw HTML contains the same ld+json blocks as the rendered DOM.' },
          reproduce: snapRepro(ctx, p, 'validate-jsonld.mjs'),
          expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google renders before extracting structured data, but consumers that fetch without executing JavaScript — including several documented AI crawlers — never see it.' },
        }));
      }

      if (!isShell(p) && (r.delta.words || 0) >= RENDER_WORD_THRESHOLD) {
        push(out, mk({
          id: 'M4.render.lazy_main_content', title: 'A large part of the body text loads only after JavaScript', status: 'warn', severity: 3, scope: 'page',
          location: { url: finalUrl(p) },
          evidence: { observed: finalUrl(p) + ' serves ' + ((p.parsed && p.parsed.word_count) || 0) + ' words of raw HTML and gains ' + r.delta.words + ' more after rendering (H1 present in the raw HTML: ' + ((r.delta.h1_added || 0) === 0 ? 'yes' : 'no') + ').' },
          expected: 'The main content is in the initial HTML; only genuinely secondary blocks load later.',
          recommendation: 'Move the deferred body content into the server response, and keep lazy loading for comments, related items and other secondary blocks.',
          fixable: 'advisory',
          verification: { method: 'render_diff', assertion: 'The rendered DOM adds fewer than ' + RENDER_WORD_THRESHOLD + ' words to the raw HTML.' },
          reproduce: snapRepro(ctx, p, 'snapshot.mjs', { render: 'js' }),
          expected_impact: { axis: 'both', confidence: 'directional', rationale: 'How much deferred text an engine indexes depends on its render queue, which no vendor quantifies; the word delta is the observation, not the consequence.' },
        }));
      }
    }

    return out;
  },
};

export default check;
