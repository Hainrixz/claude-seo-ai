// M15 — Core Web Vitals. Field data is the only thing Google ranks on, and field data needs the
// PageSpeed Insights API, so without a key this module reports needs_api and clearly labels the two
// static heuristics it can still offer as lab-side hints.
//
// When PSI does answer, `origin_fallback` is surfaced verbatim: those numbers describe the ORIGIN,
// not this URL, and a finding must never present them as page-level.

import { THRESH } from '../psi-client.mjs';
import { credential } from '../lib/util.mjs';
import { mk, push, clip, listing, plural, agree, contentPages, finalUrl, snapRepro, originOf, runState } from './_shared.mjs';

/** The URL PSI is asked about: the crawl target, else the homepage, else the first sampled page. */
function subject(ctx) {
  const pages = contentPages(ctx);
  const target = (ctx.crawl && ctx.crawl.target) || null;
  return pages.find((p) => finalUrl(p) === target)
    || pages.find((p) => p.role === 'homepage')
    || pages[0]
    || null;
}

export const check = {
  id: 'cwv',
  module: 'M15',
  scope: 'site',
  ids: ['M15.field.needs_api', 'M15.lcp.exceeds_p75', 'M15.cls.unsized_image'],

  async run(ctx) {
    const out = [];
    const page = subject(ctx);
    const url = page ? finalUrl(page) : originOf(ctx);
    if (!url) return out;
    const repro = { script: 'psi-client.mjs', args: { url } };

    // Environment only (CLAUDE_PLUGIN_OPTION_PSI_API_KEY, then PSI_API_KEY). ctx.options.psi_key is
    // the programmatic seat for a library caller; psi-client.mjs re-reads the environment itself, so
    // the key is a gate here and never travels through argv.
    const key = (ctx.options && ctx.options.psi_key) || credential('PSI_API_KEY');
    const psi = (ctx.tools && ctx.tools.psi) || null;
    const state = runState(ctx);
    let field = null;
    let apiNote = null;

    if (key && psi) {
      let res = null;
      try { res = await psi({ url, strategy: 'mobile' }); } catch (e) { res = { result: { status: 'needs_api', error: String((e && e.message) || e) } }; }
      const r = (res && res.result) || {};
      if (r.status === 'needs_api') apiNote = clip(r.error || (r.api_error && r.api_error.detail) || 'PageSpeed Insights was unavailable', 160);
      else field = r.field || null;
      // Provenance for the report's data_sources block: the request went out, so say what came back.
      state.psi = r.status === 'needs_api' ? 'needs_api' : 'used';
    } else {
      apiNote = key ? 'no PSI client was injected into this run' : 'no PSI/CrUX API key was available in the environment (CLAUDE_PLUGIN_OPTION_PSI_API_KEY or PSI_API_KEY)';
      state.psi = 'needs_api';
    }

    if (!field || field.has_field_data === false) {
      push(out, mk({
        id: 'M15.field.needs_api', title: 'Field Core Web Vitals could not be measured', status: 'needs_api', severity: 4, scope: 'site',
        location: { url },
        evidence: { observed: 'No field (CrUX) data for ' + url + ': ' + (apiNote || 'PageSpeed Insights returned no field metrics for this URL or its origin') + '.' },
        expected: 'p75 LCP, INP and CLS from the Chrome UX Report for this URL or its origin.',
        recommendation: 'Export CLAUDE_PLUGIN_OPTION_PSI_API_KEY (or PSI_API_KEY) in the environment and re-run; the key is never passed on the command line. A page with too little traffic may still have no field data, in which case only lab measurements exist.',
        fixable: 'advisory',
        verification: { method: 'psi_api', assertion: 'psi-client.mjs returns status "ok" with field.has_field_data true.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that the Core Web Vitals it uses come from field data; a lab number is not a substitute and is never presented as one here.' },
      }));
    } else {
      const scopeNote = field.origin_fallback
        ? 'these numbers are ORIGIN-level (CrUX had too little traffic for this URL), so they describe the site, not this page'
        : 'page-level CrUX data';
      if (field.lcp_ms != null && field.lcp_ms > THRESH.LCP.poor) {
        push(out, mk({
          id: 'M15.lcp.exceeds_p75', title: 'Field LCP at p75 is above the "good" threshold', status: 'fail', severity: 4, scope: 'site',
          location: { url },
          evidence: { observed: 'CrUX p75 LCP for ' + url + ' is ' + field.lcp_ms + ' ms (' + field.lcp_rating + '); the good threshold is ' + THRESH.LCP.good + ' ms and the poor threshold ' + THRESH.LCP.poor + ' ms. Scope: ' + scopeNote + '.' },
          expected: 'p75 LCP at or below ' + THRESH.LCP.good + ' ms.',
          recommendation: 'Identify and prioritise the LCP element (usually the hero image or the first heading): preload it, serve it in a modern format at the right size, and remove render-blocking work ahead of it.',
          fixable: 'advisory',
          verification: { method: 'psi_api', assertion: 'CrUX p75 LCP for this URL falls at or below ' + THRESH.LCP.good + ' ms.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents Core Web Vitals as part of page experience and publishes ' + THRESH.LCP.good + ' ms as the LCP "good" threshold; it is a tie-breaker, not an eligibility gate.' },
        }));
      }
    }

    /* ---- lab-side heuristic, explicitly labelled ---------------------------------------------- */
    const unsizedPages = contentPages(ctx)
      .map((p) => ({ page: p, unsized: ((p.parsed && p.parsed.images) || []).filter((i) => i.in_content && !i.sized) }))
      .filter((x) => x.unsized.length);
    if (unsizedPages.length) {
      const first = unsizedPages[0];
      push(out, mk({
        id: 'M15.cls.unsized_image', title: 'Content images without width/height can shift the layout', status: 'warn', severity: 4, scope: 'site',
        location: { url: finalUrl(first.page) },
        evidence: { observed: 'Static (lab-side) observation, not a measured CLS value: ' + plural(unsizedPages.length, 'sampled page') + ' ' + agree(unsizedPages.length, 'carries', 'carry') + ' content images with no numeric width/height, e.g. ' + finalUrl(first.page) + ' with ' + plural(first.unsized.length, 'image') + ' (' + listing(first.unsized.map((i) => clip(i.src || i.abs, 60)), 3) + ').' },
        expected: 'Every content image reserves its space through width/height attributes or a CSS aspect-ratio.',
        recommendation: 'Add intrinsic width and height to the images listed above, then confirm the effect with a real CLS measurement.',
        fixable: 'advisory',
        // dom_assert, not psi_api: nothing was measured here. A method label is also a
        // provenance claim (report.mjs falls back to it when no checks.json records what the
        // PSI client did), so a lab-side heuristic must never borrow one.
        verification: { method: 'dom_assert', assertion: 'Every content image carries numeric width/height (or a CSS aspect-ratio), and a PSI/CrUX run then reports CLS at or below ' + THRESH.CLS.good + ' for this URL.' },
        reproduce: snapRepro(ctx, first.page, 'parse-html.mjs'),
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Unsized images are a documented cause of layout shift, but this finding is a source-level heuristic — no CLS value was measured for this page.' },
      }));
    }

    return out;
  },
};

export default check;
