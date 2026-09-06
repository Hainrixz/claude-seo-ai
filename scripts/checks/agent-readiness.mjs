// M22 — agent readiness. Built on agent-readiness.mjs analyzeAgentReadiness(), which counts
// semantic vs. improvised controls, accessible names, labelled form controls and content trapped in
// iframes, all from static HTML.
//
// Nothing in this module is `established`: no vendor documents how a browsing agent handles a
// div-with-onclick. The counts are exact, the consequence is directional. The items static HTML
// genuinely cannot decide (cursor affordance, target size, overlays, focus order) are emitted once
// as not_applicable with the Tier-1 path that would answer them.

import { analyzeAgentReadiness, NOT_CHECKABLE_STATIC } from '../agent-readiness.mjs';
import { mk, push, clip, listing, describeExample, plural, contentPages, finalUrl, snapRepro, tokensFor } from './_shared.mjs';

const DIRECTIONAL = 'Browsing agents read the DOM the way assistive technology does, but no vendor publishes how a specific control pattern affects task completion.';

export const check = {
  id: 'agent-readiness',
  module: 'M22',
  scope: 'site',
  ids: [
    'M22.controls.non_semantic_interactive', 'M22.controls.button_without_name', 'M22.links.empty_name',
    'M22.links.href_javascript', 'M22.forms.unlabeled_controls', 'M22.content.iframe_primary',
    'M22.lighthouse.agentic_browsing', 'M22.static.not_checkable', 'M22.semantics.ok', 'M22.webmcp.present',
  ],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx).filter((p) => typeof p.html === 'string');
    if (!pages.length) return out;

    for (const page of pages) {
      const url = finalUrl(page);
      const at = { location: { url } };
      const repro = snapRepro(ctx, page, 'agent-readiness.mjs');
      const base = { scope: 'page', ...at, fixable: 'proposed' };
      const impact = (rationale) => ({ axis: 'ai', confidence: 'directional', rationale: rationale || DIRECTIONAL });

      const a = analyzeAgentReadiness(page.parsed, page.html, { tokens: tokensFor(ctx, page), lang: ctx.options && ctx.options.lang, url });
      let clean = true;

      if (a.interactive.fake > 0) {
        const dominant = a.interactive.fake > a.interactive.semantic;
        clean = false;
        push(out, mk({
          id: 'M22.controls.non_semantic_interactive', title: 'Controls are built from non-semantic elements',
          status: dominant ? 'fail' : 'warn', severity: 3, ...base,
          evidence: { observed: a.interactive.fake + ' improvised control(s) against ' + a.interactive.semantic + ' native button-like element(s) on ' + url + ': ' + listing((a.interactive.fake_examples || []).map((e) => describeExample(e, 80)), 3) + '.' },
          expected: 'Anything clickable is a <button>, an <a href>, or carries a valid interactive role plus keyboard handling.',
          recommendation: 'Replace the div/span handlers with <button type="button"> (or <a href> for navigation). An agent that cannot recognise a control cannot use it.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Every element with a click handler is a native control or carries an interactive role.' },
          reproduce: repro,
          expected_impact: impact(),
        }));
      }

      if (a.buttons.without_name > 0) {
        clean = false;
        push(out, mk({
          id: 'M22.controls.button_without_name', title: 'Buttons have no accessible name', status: 'warn', severity: 2, ...base,
          evidence: { observed: a.buttons.without_name + ' of ' + a.buttons.total + ' button(s) on ' + url + ' expose no text, aria-label or labelled image: ' + listing((a.buttons.without_name_examples || []).map((e) => describeExample(e, 80)), 3) + '.' },
          expected: 'Every button carries text, an aria-label, or an image with alt text.',
          recommendation: 'Add visible text or an aria-label naming the action the button performs.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Every button resolves to a non-empty accessible name.' },
          reproduce: repro,
          expected_impact: impact(),
        }));
      }

      if (a.links.empty_name > 0) {
        clean = false;
        push(out, mk({
          id: 'M22.links.empty_name', title: 'Links have no accessible name', status: 'warn', severity: 2, ...base,
          evidence: { observed: a.links.empty_name + ' of ' + a.links.total + ' link(s) on ' + url + ' have no text, alt or aria-label: ' + listing((a.links.empty_name_examples || []).map((e) => describeExample(e, 80)), 3) + '.' },
          expected: 'Every link names its destination.',
          recommendation: 'Give the link text, or an aria-label when it wraps an icon.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Every <a href> resolves to a non-empty accessible name.' },
          reproduce: repro,
          expected_impact: impact(),
        }));
      }

      if (a.interactive.anchor_javascript_href > 0) {
        clean = false;
        push(out, mk({
          id: 'M22.links.href_javascript', title: 'Links navigate through javascript: hrefs', status: 'warn', severity: 2, ...base,
          evidence: { observed: a.interactive.anchor_javascript_href + ' anchor(s) on ' + url + ' use a javascript: href: ' + listing((a.interactive.anchor_javascript_href_examples || []).map((e) => describeExample(e, 80)), 3) + '.' },
          expected: 'Links carry a real URL; script-only actions are buttons.',
          recommendation: 'Give the anchor the destination URL, or convert it to a <button> if it performs an action rather than navigating.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'No <a> element uses a javascript: href.' },
          reproduce: repro,
          expected_impact: impact('An agent that does not execute the page\'s scripts has no URL to follow; whether a given agent runs them is documented per vendor, not per pattern.'),
        }));
      }

      if (a.forms.unlabeled > 0) {
        clean = false;
        push(out, mk({
          id: 'M22.forms.unlabeled_controls', title: 'Form controls have no label', status: 'warn', severity: 3, ...base,
          evidence: { observed: a.forms.unlabeled + ' of ' + a.forms.controls_total + ' form control(s) on ' + url + ' have no <label for>, wrapping label, aria-label or aria-labelledby: ' + listing((a.forms.unlabeled_examples || []).map((e) => describeExample(e, 80)), 3) + '.' },
          expected: 'Every form control is labelled.',
          recommendation: 'Add a <label for="…"> (or aria-label) naming what each field expects. A placeholder is not a label.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Every form control resolves to an accessible name.' },
          reproduce: repro,
          expected_impact: impact(),
        }));
      }

      if (a.content.iframe_primary) {
        clean = false;
        push(out, mk({
          id: 'M22.content.iframe_primary', title: 'The primary content sits inside an iframe', status: 'warn', severity: 2, ...base,
          evidence: { observed: url + ' carries ' + plural(a.content.iframes.in_content, 'iframe') + ' in its content region and only ' + a.content.word_count + ' words of its own text.' },
          expected: 'The page\'s own HTML carries its primary content.',
          recommendation: 'Render the content in the page itself and keep iframes for genuinely embedded third-party widgets.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'The page\'s own document contains the primary content, not an embedded frame.' },
          reproduce: repro,
          expected_impact: impact('Content inside a frame belongs to another document; how each agent traverses frames is not documented.'),
        }));
      }

      if (a.webmcp_detected) {
        push(out, mk({
          id: 'M22.webmcp.present', title: 'The page advertises a WebMCP surface', status: 'pass', severity: 0, ...at, scope: 'page', fixable: 'advisory',
          evidence: { observed: url + ' contains a WebMCP marker' + (a.webmcp_note ? ' (' + clip(a.webmcp_note, 100) + ')' : '') + '.' },
          expected: 'Informational: presence only.',
          recommendation: 'Nothing to do. This records that the page exposes a machine surface; whether it works was not tested.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'The page contains the WebMCP marker.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'speculative', rationale: 'WebMCP is an emerging proposal; presence is observable, adoption by agents is not.' },
        }));
      }

      if (clean) {
        push(out, mk({
          id: 'M22.semantics.ok', title: 'Controls, names and labels are all clean', status: 'pass', severity: 3, ...at, scope: 'page', fixable: 'advisory',
          evidence: { observed: url + ': ' + a.interactive.semantic + ' native control(s), 0 improvised ones, ' + a.buttons.total + ' button(s) all named, ' + a.links.total + ' link(s) all named, ' + a.forms.controls_total + ' form control(s) all labelled.' },
          expected: 'Native controls, accessible names everywhere, labelled form fields.',
          recommendation: 'No action needed for the statically checkable items; see M22.static.not_checkable for what a static pass cannot answer.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'The page reports zero improvised controls, unnamed buttons/links and unlabelled form controls.' },
          reproduce: repro,
          expected_impact: impact('Clean semantics are necessary for an agent to operate a page; they do not guarantee the task succeeds.'),
        }));
      }
    }

    /* ---- the items a static pass cannot decide, stated once ----------------------------------- */
    const first = pages[0];
    push(out, mk({
      id: 'M22.static.not_checkable', title: 'Items that static HTML cannot decide', status: 'not_applicable', scope: 'site', fixable: 'advisory',
      location: { url: finalUrl(first) },
      evidence: { observed: NOT_CHECKABLE_STATIC.map((n) => n.id + ': ' + clip(n.reason, 110)).join(' | ') },
      expected: 'These need computed styles, layout boxes or a live page — not the HTML source.',
      recommendation: 'Tier 1: ' + clip((NOT_CHECKABLE_STATIC[0] && NOT_CHECKABLE_STATIC[0].tier1) || 'run Lighthouse against the URL', 120) + '.',
      fixable: 'advisory',
      verification: { method: 'manual_review', assertion: 'A rendered-page audit (Lighthouse accessibility, or a browsing agent) covers these four items.' },
      reproduce: snapRepro(ctx, first, 'agent-readiness.mjs'),
      expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'Listing what was not measured keeps the module from reading as a clean bill of health.' },
    }));

    push(out, mk({
      id: 'M22.lighthouse.agentic_browsing', title: 'The consent-gated agentic browsing run did not happen', status: 'needs_api', severity: 3, scope: 'site', fixable: 'advisory',
      location: { url: finalUrl(first) },
      evidence: { observed: 'No agentic-browsing score is present in ' + ctx.run_dir + ': the run is deterministic and static, and that audit needs a rendered page plus explicit consent.' },
      expected: 'A Lighthouse agentic-browsing run against the live URL, with its score recorded in the run.',
      recommendation: 'Run it separately if the numbers matter: npx lighthouse ' + finalUrl(first) + ' --only-categories=accessibility (and the agentic-browsing audit where available).',
      fixable: 'advisory',
      verification: { method: 'manual_review', assertion: 'A Lighthouse run for this URL reports the agentic-browsing category score.' },
      reproduce: snapRepro(ctx, first, 'agent-readiness.mjs'),
      expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'The audit was not run, so no score is claimed either way.' },
    }));

    return out;
  },
};

export default check;
