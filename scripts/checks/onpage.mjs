// M7 / M7b / M7c — head hygiene, mobile viewport and heading structure for one page.
//
// Length verdicts come from lib/bands.mjs so the skill text, parse-html.mjs and this check can
// never drift apart, and every finding quotes the string it measured together with the band that
// produced the verdict — a number without its band is not evidence.

import { TITLE, DESCRIPTION, lengthVerdict } from '../lib/bands.mjs';
import { mk, push, clip, listing, finalUrl, isContentPage, snapRepro } from './_shared.mjs';

const metaContent = (parsed, name) => {
  for (const m of (parsed && parsed.metas) || []) {
    if (m && m.name === name && typeof m.content === 'string') return m.content;
  }
  return null;
};

/** Headings in document order with their level, used for the skipped-level walk. */
const outline = (parsed) => ((parsed && parsed.headings) || []).filter((h) => h && Number.isInteger(h.level));

export const check = {
  id: 'onpage',
  module: 'M7',
  scope: 'page',
  ids: [
    'M7.title.missing', 'M7.title.length_out_of_band', 'M7.description.length_out_of_band', 'M7.viewport.missing',
    'M7b.viewport.user_scalable_no', 'M7c.h1.multiple', 'M7c.outline.skipped_level', 'M7c.landmark.no_main',
  ],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const parsed = page.parsed || {};
    const url = finalUrl(page);
    const repro = snapRepro(ctx, page, 'parse-html.mjs');
    const at = { location: { url } };

    /* ---- title ------------------------------------------------------------------------------ */
    const title = parsed.title && typeof parsed.title.value === 'string' ? parsed.title.value.trim() : '';
    if (!title) {
      push(out, mk({
        id: 'M7.title.missing', title: 'Page has no <title>', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: 'No non-empty <title> element in the head of ' + url + ' (' + (parsed.title ? parsed.title.count : 0) + ' <title> tag(s) found).' },
        expected: 'Every indexable page carries one descriptive <title>.',
        recommendation: 'Add a unique <title> of ' + TITLE.pass[0] + '-' + TITLE.pass[1] + ' characters describing this page.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'The head contains exactly one non-empty <title>.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents the <title> as the primary source of the SERP title link; without one it generates a substitute from the page.' },
      }));
    } else {
      const verdict = lengthVerdict(title.length, TITLE);
      if (verdict === 'short' || verdict === 'long') {
        push(out, mk({
          id: 'M7.title.length_out_of_band', title: 'Title length is outside the pass band', status: 'warn', severity: 3, scope: 'page', ...at,
          evidence: { observed: '"' + clip(title, 120) + '" is ' + title.length + ' characters (' + verdict + '); pass band ' + TITLE.pass[0] + '-' + TITLE.pass[1] + ', recommended ' + TITLE.recommended[0] + '-' + TITLE.recommended[1] + '.' },
          expected: 'Title length inside ' + TITLE.pass[0] + '-' + TITLE.pass[1] + ' characters.',
          recommendation: verdict === 'long'
            ? 'Shorten the title to about ' + TITLE.recommended[0] + '-' + TITLE.recommended[1] + ' characters so the SERP does not truncate it.'
            : 'Expand the title to at least ' + TITLE.pass[0] + ' characters with the page\'s distinguishing terms.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'The <title> length falls within ' + TITLE.pass[0] + '-' + TITLE.pass[1] + ' characters.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google publishes no character limit — the band is a pixel-width convention, and Google rewrites titles it considers unhelpful regardless of length.' },
        }));
      }
    }

    /* ---- description ------------------------------------------------------------------------ */
    const desc = metaContent(parsed, 'description');
    const descLen = desc ? desc.trim().length : 0;
    const descVerdict = lengthVerdict(descLen, DESCRIPTION);
    if (descVerdict === 'short' || descVerdict === 'long') {
      push(out, mk({
        id: 'M7.description.length_out_of_band', title: 'Meta description is outside the pass band', status: 'warn', severity: 2, scope: 'page', ...at,
        evidence: {
          observed: desc === null
            ? 'No <meta name="description"> on ' + url + ' (0 characters; pass band ' + DESCRIPTION.pass[0] + '-' + DESCRIPTION.pass[1] + ').'
            : '"' + clip(desc, 200) + '" is ' + descLen + ' characters (' + descVerdict + '); pass band ' + DESCRIPTION.pass[0] + '-' + DESCRIPTION.pass[1] + '.',
        },
        expected: 'A meta description of ' + DESCRIPTION.pass[0] + '-' + DESCRIPTION.pass[1] + ' characters that summarises the page.',
        recommendation: desc === null
          ? 'Add a <meta name="description"> summarising this page in about ' + DESCRIPTION.recommended[0] + '-' + DESCRIPTION.recommended[1] + ' characters.'
          : 'Rewrite the description to land inside the band.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'meta[name=description] content length falls within ' + DESCRIPTION.pass[0] + '-' + DESCRIPTION.pass[1] + '.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google states the description is not a ranking factor and is frequently rewritten; the band affects how often the site\'s own text is used as the snippet.' },
      }));
    }

    /* ---- viewport (M7 head hygiene + M7b mobile) --------------------------------------------- */
    const viewport = metaContent(parsed, 'viewport');
    if (!viewport) {
      push(out, mk({
        id: 'M7.viewport.missing', title: 'No responsive viewport meta tag', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: 'No <meta name="viewport"> in the head of ' + url + '.' },
        expected: '<meta name="viewport" content="width=device-width, initial-scale=1">',
        recommendation: 'Add the responsive viewport meta tag to the site template.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'meta[name=viewport] exists and sets width=device-width.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents the viewport meta tag as the way a page declares it adapts to the device width; without it mobile browsers assume a desktop viewport.' },
      }));
    } else if (/user-scalable\s*=\s*(no|0)/i.test(viewport) || /maximum-scale\s*=\s*(1(\.0+)?|0?\.\d+)\b/i.test(viewport)) {
      push(out, mk({
        id: 'M7b.viewport.user_scalable_no', title: 'Viewport meta disables zoom', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: '<meta name="viewport" content="' + clip(viewport, 120) + '"> on ' + url + '.' },
        expected: 'A viewport that lets the user zoom (no user-scalable=no, no maximum-scale of 1).',
        recommendation: 'Remove user-scalable=no / maximum-scale=1 from the viewport tag.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The viewport content contains neither user-scalable=no nor a maximum-scale <= 1.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Blocking zoom is a documented accessibility failure (WCAG 1.4.4) and is reported by Lighthouse; it is not itself a ranking penalty.' },
      }));
    }

    /* ---- headings ---------------------------------------------------------------------------- */
    const heads = outline(parsed);
    const h1s = heads.filter((h) => h.level === 1);
    if (h1s.length > 1) {
      push(out, mk({
        id: 'M7c.h1.multiple', title: 'More than one <h1> on the page', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: h1s.length + ' <h1> elements: ' + listing(h1s.map((h) => '"' + clip(h.text, 60) + '"'), 4) + '.' },
        expected: 'One <h1> naming the page\'s subject.',
        recommendation: 'Keep the H1 that names the page and demote the others to H2/H3.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'The document contains exactly one <h1>.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google states multiple H1s are tolerated, so the impact is on the heading outline an extractor reads rather than on ranking directly.' },
      }));
    }

    const skips = [];
    for (let i = 1; i < heads.length; i++) {
      if (heads[i].level - heads[i - 1].level > 1) skips.push({ from: heads[i - 1], to: heads[i] });
    }
    if (skips.length) {
      push(out, mk({
        id: 'M7c.outline.skipped_level', title: 'Heading outline skips a level', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: listing(skips.map((s) => 'h' + s.from.level + ' "' + clip(s.from.text, 40) + '" is followed directly by h' + s.to.level + ' "' + clip(s.to.text, 40) + '"'), 3) + '.' },
        expected: 'Heading levels descend one step at a time (h2 -> h3, never h2 -> h4).',
        recommendation: 'Renumber the headings so each nested section is exactly one level below its parent.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'No two consecutive headings differ by more than one level.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'A broken outline is an accessibility defect and makes passage boundaries harder to infer; no engine documents a ranking effect.' },
      }));
    }

    const lm = parsed.landmarks || {};
    if (!lm.main && !lm.article) {
      push(out, mk({
        id: 'M7c.landmark.no_main', title: 'No <main> or <article> landmark around the primary content', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: 'No <main>, <article> or role="main"/"article" element on ' + url + '; the ' + (parsed.word_count || 0) + '-word body sits in unmarked containers.' },
        expected: 'The primary content is wrapped in <main> (or <article> for a single piece of content).',
        recommendation: 'Wrap the primary content in <main> so boilerplate stripping and assistive technology can find it.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The document contains a <main>/<article> element or an element with role="main".' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Landmarks are how this tool (and screen readers) separate content from boilerplate; search engines infer the main content without them, so the effect is on extraction quality rather than ranking.' },
      }));
    }

    return out;
  },
};

export default check;
