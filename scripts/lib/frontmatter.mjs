// YAML front matter for Markdown content files (Hugo, Jekyll, Astro, Eleventy, Docusaurus).
//
// Deliberately a *minimal* subset — scalars, quoted strings, inline and block arrays of scalars —
// because that is what an SEO fix touches: title, description, slug, canonical, image, tags, draft,
// date. Anything richer (nested maps, block scalars `|`/`>`, anchors, multi-document files) is
// detected, reported as unsupported and left byte-for-byte alone; `mergeFrontmatter` refuses to
// touch those keys rather than round-tripping someone's content through a half-YAML writer.
//
// TOML front matter (`+++`, common in Hugo) is recognised and reported, never rewritten.

export const YAML_DELIMITER = '---';
export const TOML_DELIMITER = '+++';

const isBlank = (line) => /^\s*$/.test(line);

/** Strip a trailing `# comment` that is outside quotes. */
function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) { if (ch === quote && value[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

/** Parse one scalar: quoted string, boolean, null, number, or bare string. */
export function parseScalar(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if ((s.startsWith("'") && s.endsWith("'") && s.length >= 2)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

/** Parse an inline array `[a, "b", 3]` (scalars only). Returns null when it is not one. */
export function parseInlineArray(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!(s.startsWith('[') && s.endsWith(']'))) return null;
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) { current += ch; if (ch === quote && inner[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { items.push(parseScalar(current)); current = ''; continue; }
    if (ch === '[' || ch === '{') return null; // nested structures are out of scope
    current += ch;
  }
  if (current.trim() !== '') items.push(parseScalar(current));
  return items;
}

/**
 * Parse the front-matter block at the top of `text`.
 * @returns {{present, format, supported, raw, data, order, unsupported, body, body_index, eol, delimiter}}
 *   `data` holds only the keys this subset understands; `unsupported` names the top-level keys that
 *   were seen but not parsed (nested maps, block scalars) — merging must not touch those.
 */
export function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const empty = {
    present: false, format: null, supported: false, raw: '', data: {}, order: [], unsupported: [],
    body: src, body_index: 0, eol, delimiter: null, end_index: 0,
  };
  const bom = src.startsWith('﻿') ? 1 : 0;
  const head = src.slice(bom);
  const firstLineEnd = head.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? head : head.slice(0, firstLineEnd)).replace(/\r$/, '');
  const delimiter = firstLine.trim() === YAML_DELIMITER ? YAML_DELIMITER : firstLine.trim() === TOML_DELIMITER ? TOML_DELIMITER : null;
  if (!delimiter || firstLineEnd === -1) return empty;

  const rest = head.slice(firstLineEnd + 1);
  // Byte offsets, not line counts: a CRLF file must round-trip byte-for-byte.
  const closeRe = delimiter === YAML_DELIMITER ? /^---[ \t]*\r?(?:\n|$)/m : /^\+\+\+[ \t]*\r?(?:\n|$)/m;
  const close = closeRe.exec(rest);
  if (!close) return empty;

  const raw = rest.slice(0, close.index).replace(/\r?\n$/, '');
  const blockLines = raw === '' ? [] : raw.split(/\r?\n/);
  const consumed = bom + firstLineEnd + 1 + close.index + close[0].length;
  const body = src.slice(Math.min(consumed, src.length));

  if (delimiter === TOML_DELIMITER) {
    return { present: true, format: 'toml', supported: false, raw, data: {}, order: [], unsupported: ['*'], body, body_index: consumed, eol, delimiter, end_index: consumed };
  }

  const data = {};
  const order = [];
  const unsupported = [];
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (isBlank(line) || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_.$-]+)\s*:(.*)$/.exec(line);
    if (!m) { if (/^\s+/.test(line)) continue; unsupported.push(line.trim().slice(0, 40)); continue; }
    const key = m[1];
    const after = stripComment(m[2]).trim();
    order.push(key);
    if (after === '') {
      // block array (- item) or nested map (indented key:)
      const items = [];
      let j = i + 1;
      let sawNested = false;
      for (; j < blockLines.length; j++) {
        const next = blockLines[j];
        if (isBlank(next)) continue;
        const dash = /^\s+-\s+(.*)$/.exec(next);
        if (dash) { items.push(parseScalar(stripComment(dash[1]))); continue; }
        if (/^\s+\S/.test(next)) { sawNested = true; continue; }
        break;
      }
      if (sawNested || (!items.length && j > i + 1)) { unsupported.push(key); }
      else if (items.length) data[key] = items;
      else data[key] = '';
      i = j - 1;
      continue;
    }
    if (after === '|' || after === '>' || after === '|-' || after === '>-' || after === '|+' || after === '>+') {
      unsupported.push(key);
      let j = i + 1;
      for (; j < blockLines.length; j++) { if (isBlank(blockLines[j]) || /^\s+/.test(blockLines[j])) continue; break; }
      i = j - 1;
      continue;
    }
    const inline = parseInlineArray(after);
    data[key] = inline === null ? parseScalar(after) : inline;
  }
  return { present: true, format: 'yaml', supported: true, raw, data, order, unsupported, body, body_index: consumed, eol, delimiter, end_index: consumed };
}

const NEEDS_QUOTES = /^\s|\s$|^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|^(true|false|null|yes|no|on|off|~)$|^-?\d+(\.\d+)?$/i;

/** Render one scalar the way this module parses it back. Strings get double quotes when needed. */
export function stringifyScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '"' + String(value) + '"';
  const s = String(value);
  if (s === '') return '""';
  if (s.includes('\n')) return JSON.stringify(s);
  if (NEEDS_QUOTES.test(s) || s.includes('"')) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return s;
}

/**
 * Render one item of an inline array. Anything with a space, comma or bracket is quoted: inside
 * `[...]` those characters change how the list is read.
 */
export function stringifyArrayItem(value) {
  if (typeof value !== 'string') return stringifyScalar(value);
  if (/[\s,[\]{}]/.test(value) || value === '') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return stringifyScalar(value);
}

/** Render `key: value` (arrays become inline `[a, b]`). */
export function stringifyEntry(key, value) {
  if (Array.isArray(value)) return key + ': [' + value.map((v) => stringifyArrayItem(v)).join(', ') + ']';
  return key + ': ' + stringifyScalar(value);
}

/** Render a whole data object as front-matter lines (without the `---` delimiters). */
export function stringifyFrontmatter(data, { eol = '\n', order = null } = {}) {
  const keys = Array.isArray(order) && order.length
    ? [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))]
    : Object.keys(data);
  return keys.map((k) => stringifyEntry(k, data[k])).join(eol);
}

/** Wrap front-matter lines in `---` delimiters and prepend them to `body`. */
export function buildDocument(data, body, { eol = '\n', order = null } = {}) {
  const block = stringifyFrontmatter(data, { eol, order });
  const rest = String(body == null ? '' : body);
  return YAML_DELIMITER + eol + (block ? block + eol : '') + YAML_DELIMITER + eol + rest;
}

/** Index of the top-level `key:` line inside the block lines, or -1. */
function findKeyLine(blockLines, key) {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&') + '\\s*:');
  for (let i = 0; i < blockLines.length; i++) if (re.test(blockLines[i])) return i;
  return -1;
}

/** How many lines the value at `startIdx` spans (a block array continues over its `- item` lines). */
function valueSpan(blockLines, startIdx) {
  const after = stripComment((/^[^:]*:(.*)$/.exec(blockLines[startIdx]) || ['', ''])[1]).trim();
  if (after !== '') return 1;
  let j = startIdx + 1;
  for (; j < blockLines.length; j++) {
    if (isBlank(blockLines[j])) { continue; }
    if (/^\s+/.test(blockLines[j])) continue;
    break;
  }
  return j - startIdx;
}

/**
 * Merge `updates` into a document's front matter, preserving every untouched line verbatim.
 *
 * Rules:
 *   * an existing key is replaced only when `overwrite` is true (default false → reported as skipped
 *     with reason 'exists'); a fix never silently rewrites an author's title
 *   * a key this subset cannot parse (nested map, block scalar) is skipped with reason 'unsupported'
 *   * TOML front matter is skipped entirely with reason 'toml'
 *   * a document with no front matter gets one when `create` is true (default)
 *
 * @returns {{ok, text, changed, added: string[], updated: string[], skipped: [{key, reason}], reason}}
 */
export function mergeFrontmatter(text, updates, { overwrite = false, create = true } = {}) {
  const src = String(text == null ? '' : text);
  const parsed = parseFrontmatter(src);
  const entries = Object.entries(updates || {}).filter(([, v]) => v !== undefined);
  const added = [];
  const updated = [];
  const skipped = [];

  if (!entries.length) return { ok: true, text: src, changed: false, added, updated, skipped, reason: 'no-updates' };

  if (parsed.present && parsed.format === 'toml') {
    for (const [k] of entries) skipped.push({ key: k, reason: 'toml' });
    return { ok: false, text: src, changed: false, added, updated, skipped, reason: 'toml-front-matter-not-supported' };
  }

  const eol = parsed.eol;
  if (!parsed.present) {
    if (!create) return { ok: false, text: src, changed: false, added, updated, skipped, reason: 'no-front-matter' };
    const data = {};
    for (const [k, v] of entries) { data[k] = v; added.push(k); }
    return { ok: true, text: buildDocument(data, src, { eol }), changed: true, added, updated, skipped, reason: 'created' };
  }

  const blockLines = parsed.raw === '' ? [] : parsed.raw.split(eol === '\r\n' ? '\r\n' : '\n');
  let changed = false;
  for (const [key, value] of entries) {
    if (parsed.unsupported.includes(key)) { skipped.push({ key, reason: 'unsupported' }); continue; }
    const idx = findKeyLine(blockLines, key);
    if (idx === -1) {
      blockLines.push(stringifyEntry(key, value));
      added.push(key);
      changed = true;
      continue;
    }
    if (!overwrite) { skipped.push({ key, reason: 'exists' }); continue; }
    const span = valueSpan(blockLines, idx);
    const rendered = stringifyEntry(key, value);
    const currentSlice = blockLines.slice(idx, idx + span).join(eol);
    if (currentSlice === rendered) { skipped.push({ key, reason: 'identical' }); continue; }
    blockLines.splice(idx, span, rendered);
    updated.push(key);
    changed = true;
  }
  if (!changed) return { ok: true, text: src, changed: false, added, updated, skipped, reason: 'unchanged' };

  // `parsed.body` starts immediately after the closing delimiter's newline, so it is concatenated
  // as-is: a blank line the author left between the front matter and the body survives the merge.
  const rebuilt = YAML_DELIMITER + eol + (blockLines.length ? blockLines.join(eol) + eol : '') + YAML_DELIMITER + eol;
  return { ok: true, text: rebuilt + parsed.body, changed: true, added, updated, skipped, reason: 'merged' };
}

/** One front-matter value (undefined when absent or unsupported). */
export function readFrontmatterValue(text, key) {
  const parsed = parseFrontmatter(text);
  return parsed.present ? parsed.data[key] : undefined;
}
