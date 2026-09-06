#!/usr/bin/env node
// M22 — agent readiness (plan 4d). Can a scripted agent understand and operate this page from the
// HTML alone? Everything here is directional: the same accessibility semantics that let a screen
// reader name a control are what an agent parses, but no engine documents an "agent-readiness"
// ranking factor. Severity is capped at 3 for every finding built on this output.
//
// What static HTML cannot answer (cursor affordance, target size, overlays, focus order) is listed
// verbatim in `not_checkable_static` instead of being silently skipped.
//
// Usage: node agent-readiness.mjs --url https://example.com/page
//        node agent-readiness.mjs --file ./page.html [--url <page url>] [--m4 ./render.json]
//        node agent-readiness.mjs --snapshot <run>/pages/<slug>.json [--prefer rendered]
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, isMain, runCli, loadInput, inputFailure } from './lib/util.mjs';
import { tokenize, parseDocument, innerText, inContent } from './lib/html.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { detectLang, lexiconFor } from './lib/lang.mjs';

/** Native controls an agent can operate without guessing. */
export const NATIVE_INTERACTIVE = Object.freeze(new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label', 'details']));
/** Button-like native controls: what `interactive.semantic` counts (links are reported separately). */
export const SEMANTIC_BUTTON_TAGS = Object.freeze(new Set(['button', 'summary']));
export const SEMANTIC_INPUT_TYPES = Object.freeze(new Set(['button', 'submit', 'reset', 'image']));
/** ARIA roles that promise an interaction the element's tag does not provide. */
export const INTERACTIVE_ROLES = Object.freeze(new Set(['button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio', 'option', 'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox']));
export const FORM_CONTROL_TAGS = Object.freeze(new Set(['input', 'select', 'textarea']));
export const EXCLUDED_INPUT_TYPES = Object.freeze(new Set(['hidden']));
/** Below this the page reads as a shell rather than a document (same cutoff as lib/renderers). */
export const SHELL_WORD_THRESHOLD = 150;
export const WEBMCP_RE = /navigator\s*\.\s*modelContext\b/;

/** The four things a static HTML pass cannot decide. Reported, never assumed to pass. */
export const NOT_CHECKABLE_STATIC = Object.freeze([
  { id: 'cursor_affordance', reason: 'Whether a control looks clickable (cursor:pointer, :hover, focus ring) depends on computed CSS.', tier1: 'npx lighthouse <url> --only-categories=accessibility' },
  { id: 'target_size', reason: 'Minimum target size needs layout boxes, which static HTML does not carry.', tier1: 'npx lighthouse <url> --only-categories=accessibility' },
  { id: 'overlays_and_interstitials', reason: 'Consent banners, modals and cookie walls that cover the content only exist after the page runs.', tier1: 'render the page (snapshot.mjs --render js) and re-run this check on the rendered DOM' },
  { id: 'focus_order_and_traps', reason: 'Focus order, focus visibility and keyboard traps need a live accessibility tree.', tier1: 'npx lighthouse <url> --only-categories=accessibility' },
]);

const NOTE = 'Directional. These are accessibility semantics an agent depends on to name and operate controls; no engine documents them as a ranking or citation factor. Image alt text is reported for context only — M9 owns it.';

const attr = (t, k) => (t && t.attrs ? t.attrs[k] : undefined);
const has = (t, k) => attr(t, k) !== undefined;
const roleOf = (t) => String(attr(t, 'role') || '').trim().toLowerCase();
const clip = (s, n = 80) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/**
 * Text of an element for accessible-name purposes: subtrees marked aria-hidden="true" are skipped,
 * because a screen reader — and an agent reading the same tree — never sees them.
 */
export function nameText(tokens, i, { maxLen = 200 } = {}) {
  const open = tokens[i];
  if (!open || open.kind !== 'open') return '';
  const end = open.end_idx == null ? tokens.length : open.end_idx;
  let out = '';
  let j = i + 1;
  while (j < end) {
    const t = tokens[j];
    if (t.attrs && String(t.attrs['aria-hidden'] || '').toLowerCase() === 'true') {
      j = t.kind === 'open' && t.end_idx != null ? t.end_idx : j + 1;
      continue;
    }
    if (t.kind === 'text') out += t.text;
    else if (t.kind !== 'comment' && t.name) out += ' ';
    j++;
  }
  const s = decodeEntities(out).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Map every id to the text of that element, so aria-labelledby can be resolved inside one document. */
function idTextMap(tokens) {
  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t.kind !== 'open' && t.kind !== 'self') || !t.attrs || !t.attrs.id) continue;
    if (map.has(t.attrs.id)) continue;
    map.set(t.attrs.id, t.kind === 'open' ? innerText(tokens, i, { maxLen: 200 }) : String(t.attrs.value || t.attrs.alt || '').trim());
  }
  return map;
}

/** Accessible name of a control, in the order an agent (and a screen reader) would resolve it. */
export function accessibleName(tokens, i, idText) {
  const t = tokens[i];
  if (!t) return { name: '', source: 'none' };
  const aria = String(attr(t, 'aria-label') || '').trim();
  if (aria) return { name: aria, source: 'aria-label' };
  const labelledby = String(attr(t, 'aria-labelledby') || '').trim();
  if (labelledby) {
    const text = labelledby.split(/\s+/).map((id) => (idText.get(id) || '')).filter(Boolean).join(' ').trim();
    if (text) return { name: text, source: 'aria-labelledby' };
    return { name: '', source: 'aria-labelledby-unresolved' };
  }
  if (t.name === 'input') {
    const v = String(attr(t, 'value') || '').trim();
    if (v) return { name: v, source: 'value' };
    const alt = String(attr(t, 'alt') || '').trim();
    if (alt) return { name: alt, source: 'alt' };
  }
  const text = t.kind === 'open' ? nameText(tokens, i, { maxLen: 200 }) : '';
  if (text) return { name: text, source: 'text' };
  if (t.kind === 'open' && t.end_idx != null) {
    for (let j = i + 1; j < t.end_idx; j++) {
      const c = tokens[j];
      if (c.attrs && String(c.attrs['aria-hidden'] || '').toLowerCase() === 'true') { j = c.kind === 'open' && c.end_idx != null ? c.end_idx - 1 : j; continue; }
      if (c.name === 'img' && c.attrs && String(c.attrs.alt || '').trim()) return { name: String(c.attrs.alt).trim(), source: 'image-alt' };
      if (c.name === 'svg' && c.attrs && String(c.attrs['aria-label'] || '').trim()) return { name: String(c.attrs['aria-label']).trim(), source: 'svg-aria-label' };
      if (c.name === 'title' && c.kind === 'open') { const tt = innerText(tokens, j, { maxLen: 200 }); if (tt) return { name: tt, source: 'svg-title' }; }
    }
  }
  const title = String(attr(t, 'title') || '').trim();
  if (title) return { name: title, source: 'title' };
  return { name: '', source: 'none' };
}

/** Decide whether the static HTML already carries the content, from an M4 artifact or a shell heuristic. */
export function serverRenderedFrom(parsed, m4) {
  const markers = (parsed && parsed.markers) || {};
  const words = (parsed && parsed.word_count) || 0;
  if (m4 && typeof m4 === 'object') {
    if (typeof m4.server_rendered === 'boolean') return { value: m4.server_rendered, source: 'm4', signals: [] };
    const r = m4.render && typeof m4.render === 'object' ? m4.render : m4;
    const signals = Array.isArray(r.signals) ? r.signals : [];
    // A render that actually ran is the strongest evidence: if it added meaningful content, the
    // server did not ship it. `needed: true` on its own is only a suspicion, so it stays unknown.
    if (r.delta && typeof r.delta === 'object') return { value: !r.delta.meaningful, source: 'm4', signals, render_used: r.used || null };
    if (r.needed === false) return { value: true, source: 'm4', signals, render_used: r.used || null };
    if (r.needed === true) return { value: null, source: 'm4', signals: [...signals, 'render_suspected_but_not_performed'], render_used: r.used || null };
  }
  const shell = markers.next_root_empty === true || markers.app_root_empty === true;
  const framework = !!(markers.next_data || markers.nuxt || markers.reactroot || markers.angular || markers.sveltekit || markers.remix);
  const h1 = (parsed && parsed.headings ? parsed.headings.filter((h) => h.level === 1).length : 0);
  if (shell) return { value: false, source: 'heuristic', signals: ['empty_root_element'] };
  if (words >= SHELL_WORD_THRESHOLD && h1 >= 1) return { value: true, source: 'heuristic', signals: ['word_count>=' + SHELL_WORD_THRESHOLD, 'h1_present'] };
  if (words < SHELL_WORD_THRESHOLD && framework) return { value: false, source: 'heuristic', signals: ['framework_markers', 'word_count<' + SHELL_WORD_THRESHOLD] };
  return { value: null, source: 'heuristic', signals: ['inconclusive'] };
}

/**
 * Pure analysis.
 * @param {object} parsed  parseDocument() result
 * @param {string} html    the same HTML (tokenized here; pass opts.tokens to reuse a tokenization)
 * @param {object} [opts]  { tokens, m4, lang, url }
 */
export function analyzeAgentReadiness(parsed, html, opts = {}) {
  const tokens = opts.tokens || tokenize(typeof html === 'string' ? html : '');
  const doc = parsed || parseDocument(typeof html === 'string' ? html : '');
  const det = detectLang(tokens, { flag: opts.lang, doc });
  const lex = det.supported ? lexiconFor(det.lang) : null;
  const idText = idTextMap(tokens);
  const labelFor = new Set();
  for (const t of tokens) if (t.name === 'label' && t.attrs && t.attrs.for) labelFor.add(t.attrs.for);

  const interactive = { semantic: 0, fake: 0, fake_examples: [], anchor_no_href: 0, anchor_no_href_examples: [], anchor_javascript_href: 0, anchor_javascript_href_examples: [] };
  const buttons = { total: 0, without_name: 0, without_name_examples: [] };
  const forms = { controls_total: 0, labeled: 0, unlabeled: 0, unlabeled_examples: [], label_sources: {} };
  const links = { total: 0, with_href: 0, empty_name: 0, empty_name_examples: [], generic: null, generic_examples: [] };
  const dialogs = { dialog_elements: 0, role_dialog: 0, aria_modal: 0 };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // 'raw' covers iframe/textarea/svg, which the tokenizer emits as one token with their content
    if (t.kind !== 'open' && t.kind !== 'self' && t.kind !== 'raw') continue;
    const name = t.name;
    const role = roleOf(t);
    const type = String(attr(t, 'type') || '').toLowerCase();

    if (name === 'dialog') dialogs.dialog_elements++;
    if (role === 'dialog' || role === 'alertdialog') dialogs.role_dialog++;
    if (has(t, 'aria-modal')) dialogs.aria_modal++;

    // ---- semantic (button-like) controls
    const semanticButton = SEMANTIC_BUTTON_TAGS.has(name) || (name === 'input' && SEMANTIC_INPUT_TYPES.has(type));
    if (semanticButton) {
      interactive.semantic++;
      buttons.total++;
      const an = accessibleName(tokens, i, idText);
      if (!an.name) {
        buttons.without_name++;
        if (buttons.without_name_examples.length < 5) buttons.without_name_examples.push({ tag: name, type: type || null, class: attr(t, 'class') ?? null, id: attr(t, 'id') ?? null });
      }
    }

    // ---- non-semantic interactive elements
    const handler = has(t, 'onclick') || has(t, 'onkeydown') || has(t, 'onkeyup');
    const promisesInteraction = handler || INTERACTIVE_ROLES.has(role);
    if (promisesInteraction) {
      const fake = name === 'a' ? !has(t, 'href') : !NATIVE_INTERACTIVE.has(name);
      if (fake) {
        interactive.fake++;
        if (interactive.fake_examples.length < 5) {
          // class/id travel with the example so a reader can find the element again: "<div onclick>"
          // names a pattern, "<div class=\"cta primary\" onclick>" names the thing to fix.
          interactive.fake_examples.push({
            tag: name, role: role || null, onclick: handler, tabindex: attr(t, 'tabindex') ?? null,
            class: attr(t, 'class') ?? null, id: attr(t, 'id') ?? null,
            text: clip(t.kind === 'open' ? innerText(tokens, i, { maxLen: 80 }) : ''),
          });
        }
      }
    }

    // ---- links
    if (name === 'a') {
      links.total++;
      const href = attr(t, 'href');
      if (href === undefined) {
        interactive.anchor_no_href++;
        if (interactive.anchor_no_href_examples.length < 5) interactive.anchor_no_href_examples.push({ text: clip(innerText(tokens, i, { maxLen: 80 })), role: role || null });
        continue;
      }
      links.with_href++;
      if (/^\s*javascript:/i.test(String(href))) {
        interactive.anchor_javascript_href++;
        if (interactive.anchor_javascript_href_examples.length < 5) interactive.anchor_javascript_href_examples.push({ href: clip(String(href)), text: clip(innerText(tokens, i, { maxLen: 80 })) });
      }
      const an = accessibleName(tokens, i, idText);
      if (!an.name) {
        links.empty_name++;
        if (links.empty_name_examples.length < 5) links.empty_name_examples.push({ href: clip(String(href)), reason: an.source === 'aria-labelledby-unresolved' ? 'aria-labelledby points at nothing' : 'no text, aria-label, image alt or title' });
      } else if (lex) {
        if (lex.generic_anchor.test(an.name.trim())) {
          links.generic = (links.generic || 0) + 1;
          if (links.generic_examples.length < 5) links.generic_examples.push({ href: clip(String(href)), anchor: an.name.trim() });
        }
      }
    }

    // ---- form controls (page-wide, not only inside <form>)
    if (FORM_CONTROL_TAGS.has(name)) {
      if (name === 'input' && (EXCLUDED_INPUT_TYPES.has(type) || SEMANTIC_INPUT_TYPES.has(type))) continue;
      forms.controls_total++;
      let source = null;
      if (String(attr(t, 'aria-label') || '').trim()) source = 'aria-label';
      else if (String(attr(t, 'aria-labelledby') || '').trim()) {
        const text = String(attr(t, 'aria-labelledby')).split(/\s+/).map((id) => idText.get(id) || '').filter(Boolean).join(' ').trim();
        if (text) source = 'aria-labelledby';
      } else if (attr(t, 'id') && labelFor.has(attr(t, 'id'))) source = 'label[for]';
      else {
        for (let p = t.parent; p >= 0; p = tokens[p].parent) if (tokens[p].name === 'label') { source = 'ancestor-label'; break; }
      }
      if (source) { forms.labeled++; forms.label_sources[source] = (forms.label_sources[source] || 0) + 1; }
      else {
        forms.unlabeled++;
        if (forms.unlabeled_examples.length < 5) {
          forms.unlabeled_examples.push({ tag: name, type: type || null, name_attr: attr(t, 'name') ?? null, placeholder: attr(t, 'placeholder') ?? null });
        }
      }
    }
  }
  if (lex && links.generic === null) links.generic = 0;

  const images = doc.images || [];
  const iframes = doc.iframes || [];
  const iframeTokens = tokens.filter((t) => t.name === 'iframe' && t.kind !== 'close');
  const iframesInContent = iframeTokens.filter((t) => inContent(t)).length;
  const server = serverRenderedFrom(doc, opts.m4);
  const wordCountValue = doc.word_count || 0;

  const htmlText = typeof html === 'string' ? html : '';
  const webmcp = WEBMCP_RE.test(htmlText);

  return {
    lang: { detected: det.tag || 'unknown', source: det.source, confidence: det.confidence, supported: det.supported },
    interactive,
    buttons,
    forms,
    links: { ...links, generic_note: 'Reference only — M10 owns anchor quality; counted here because an agent reading link text alone cannot tell where a generic link goes.' },
    images: { total: images.length, missing_alt: images.filter((im) => !im.alt_present).length, see_m9: true },
    content: {
      word_count: wordCountValue,
      server_rendered: server.value,
      server_rendered_source: server.source,
      server_rendered_signals: server.signals,
      iframes: { total: iframes.length, in_content: iframesInContent },
      iframe_primary: iframesInContent > 0 && wordCountValue < SHELL_WORD_THRESHOLD,
    },
    dialogs: { ...dialogs, note: 'Presence only. Focus management, dismissal and whether the dialog blocks the page are not decidable from static HTML.' },
    webmcp_detected: webmcp,
    webmcp_note: webmcp ? 'navigator.modelContext referenced in the page source; report-only, the tool set it exposes is not inspected.' : null,
    not_checkable_static: NOT_CHECKABLE_STATIC.map((x) => ({ ...x })),
    note: NOTE,
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const url = input.finalUrl || (typeof flagValue(args.url) === 'string' ? flagValue(args.url) : null);
  let m4 = null;
  const m4Flag = flagValue(args.m4);
  if (typeof m4Flag === 'string' && m4Flag.trim()) {
    const abs = resolve(m4Flag.trim());
    try { m4 = JSON.parse(readFileSync(abs, 'utf8')); }
    catch (e) { return { result: { error: 'cannot read --m4 ' + abs + ': ' + String(e && e.message || e) }, code: EXIT.USAGE }; }
  } else if (input.source === 'snapshot' && input.snapshot) {
    try { m4 = { render: JSON.parse(readFileSync(input.snapshot.path, 'utf8')).render }; } catch { m4 = null; }
  }
  const tokens = tokenize(input.html);
  const parsed = parseDocument(input.html, url, { tokens });
  const langFlag = flagValue(args.lang);
  const result = {
    source: input.source,
    url: url || null,
    ...analyzeAgentReadiness(parsed, input.html, { tokens, m4, lang: typeof langFlag === 'string' ? langFlag : undefined, url }),
  };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
