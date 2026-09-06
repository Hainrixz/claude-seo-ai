// Text diffing and exact-anchor editing for the file-writing adapters (zero dependencies).
//
// Two halves:
//   * unifiedDiff() — the preview a human reads before saying yes. Line-based LCS, standard
//     unified format, so the output pastes into `git apply` and reads like every other diff.
//   * applyInsertAt() / replaceBetween() / marker blocks — the *only* way this repo edits a file
//     it did not generate. Every edit names an exact anchor that must be present, is idempotent
//     (a marker or the verbatim snippet already there means "nothing to do"), and returns a reason
//     instead of guessing when the anchor is missing. A regex-rewrite of someone's template is how
//     a "fix" corrupts a site.

/** Split into lines, remembering the dominant EOL and whether the file ended with one. */
export function splitLines(text) {
  const s = String(text == null ? '' : text);
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length;
  const eol = crlf > 0 && crlf >= lf / 2 ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(s);
  const body = trailingNewline ? s.slice(0, s.length - (s.endsWith('\r\n') ? 2 : 1)) : s;
  const lines = body === '' && !trailingNewline ? [] : body.split(/\r\n|\n|\r/);
  return { lines, eol, trailingNewline };
}

/** Join lines back with the given EOL, optionally re-adding the trailing newline. */
export function joinLines(lines, { eol = '\n', trailingNewline = true } = {}) {
  const body = lines.join(eol);
  return trailingNewline && body !== '' ? body + eol : body;
}

/** Biggest matrix the exact LCS will build (cells). Beyond it, the middle is emitted as one hunk. */
export const MAX_LCS_CELLS = 4000000;

/**
 * Line diff as [{op:'='|'-'|'+', line}] in output order.
 * Common prefix/suffix are trimmed first (the usual case: one inserted block), so the quadratic
 * part only ever sees the region that actually changed.
 */
export function diffLines(beforeLines, afterLines) {
  const a = Array.isArray(beforeLines) ? beforeLines : splitLines(beforeLines).lines;
  const b = Array.isArray(afterLines) ? afterLines : splitLines(afterLines).lines;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: '=', line: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length && midB.length && midA.length * midB.length > MAX_LCS_CELLS) {
    for (const line of midA) out.push({ op: '-', line });
    for (const line of midB) out.push({ op: '+', line });
  } else if (!midA.length || !midB.length) {
    for (const line of midA) out.push({ op: '-', line });
    for (const line of midB) out.push({ op: '+', line });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ op: '=', line: midA[i] }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) { out.push({ op: '-', line: midA[i] }); i++; }
      else { out.push({ op: '+', line: midB[j] }); j++; }
    }
    while (i < n) { out.push({ op: '-', line: midA[i] }); i++; }
    while (j < m) { out.push({ op: '+', line: midB[j] }); j++; }
  }

  for (let i = endA; i < a.length; i++) out.push({ op: '=', line: a[i] });
  return out;
}

const NO_NEWLINE = '\\ No newline at end of file';
/**
 * Sentinel appended to the last line of a side that does not end with a newline. It makes that line
 * compare unequal to the same text *with* a newline (which is what a diff must show), and marks
 * where the `\ No newline at end of file` note belongs. It can never occur in real text.
 */
const NONL = '\u0000<no-eof-newline>';

/** Lines of `text`, with the no-trailing-newline sentinel applied to the last one when needed. */
function linesWithEofMarker(text) {
  const { lines, trailingNewline } = splitLines(text);
  if (!trailingNewline && lines.length) {
    const out = lines.slice();
    out[out.length - 1] += NONL;
    return out;
  }
  return lines;
}

/** Added / removed line counts (a modified line counts once on each side). */
export function diffStats(before, after) {
  let added = 0;
  let removed = 0;
  for (const d of diffLines(linesWithEofMarker(before), linesWithEofMarker(after))) {
    if (d.op === '+') added++;
    else if (d.op === '-') removed++;
  }
  return { added, removed, changed: added > 0 || removed > 0 };
}

/**
 * Unified diff between two texts. Returns '' when they are identical — an adapter treats that as
 * "already applied" rather than emitting an empty preview.
 * @param {string} before
 * @param {string} after
 * @param {object} [opts] { fromFile, toFile, context = 3, header = true }
 */
export function unifiedDiff(before, after, { fromFile = 'a', toFile = 'b', context = 3, header = true } = {}) {
  const b1 = String(before == null ? '' : before);
  const b2 = String(after == null ? '' : after);
  if (b1 === b2) return '';
  const linesA = linesWithEofMarker(b1);
  const linesB = linesWithEofMarker(b2);
  const ops = diffLines(linesA, linesB);

  // group into hunks with `context` lines of leading/trailing context
  const hunks = [];
  let lineA = 1;
  let lineB = 1;
  let pending = null;
  let trailing = 0;
  const ctx = Math.max(0, Number(context) || 0);
  const recentContext = [];

  const flush = () => {
    if (!pending) return;
    hunks.push(pending);
    pending = null;
    trailing = 0;
  };

  for (const d of ops) {
    if (d.op === '=') {
      if (pending) {
        if (trailing < ctx) { pending.lines.push({ op: ' ', line: d.line }); pending.countA++; pending.countB++; trailing++; }
        else flush();
      }
      if (!pending) {
        recentContext.push({ line: d.line, a: lineA, b: lineB });
        if (recentContext.length > ctx) recentContext.shift();
      }
      lineA++; lineB++;
      continue;
    }
    if (!pending) {
      const first = recentContext.length ? recentContext[0] : { a: lineA, b: lineB };
      pending = { startA: first.a, startB: first.b, countA: 0, countB: 0, lines: [] };
      for (const c of recentContext) { pending.lines.push({ op: ' ', line: c.line }); pending.countA++; pending.countB++; }
      recentContext.length = 0;
    }
    trailing = 0;
    if (d.op === '-') { pending.lines.push({ op: '-', line: d.line }); pending.countA++; lineA++; }
    else { pending.lines.push({ op: '+', line: d.line }); pending.countB++; lineB++; }
  }
  flush();
  if (!hunks.length) return '';

  const out = [];
  if (header) out.push('--- ' + fromFile, '+++ ' + toFile);
  for (const h of hunks) {
    const rangeA = h.countA === 0 ? h.startA - 1 + ',0' : (h.countA === 1 ? String(h.startA) : h.startA + ',' + h.countA);
    const rangeB = h.countB === 0 ? h.startB - 1 + ',0' : (h.countB === 1 ? String(h.startB) : h.startB + ',' + h.countB);
    out.push('@@ -' + rangeA + ' +' + rangeB + ' @@');
    for (const l of h.lines) {
      if (l.line.endsWith(NONL)) {
        // the note belongs immediately after the line it describes, on that line's own side
        out.push(l.op + l.line.slice(0, -NONL.length), NO_NEWLINE);
      } else {
        out.push(l.op + l.line);
      }
    }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Exact-anchor edits

/** Comment syntaxes the marker helpers know. */
export const COMMENT_STYLES = Object.freeze({
  html: { open: '<!-- ', close: ' -->' },
  liquid: { open: '{% comment %}', close: '{% endcomment %}' },
  js: { open: '/* ', close: ' */' },
  hash: { open: '# ', close: '' },
  jsx: { open: '{/* ', close: ' */}' },
});

/** The marker every edit this tool makes carries, so a later run recognises its own work. */
export const DEFAULT_MARKER = 'claude-seo-ai';

/** Render `marker` as a comment in the given style, e.g. `<!-- claude-seo-ai -->`. */
export function markerComment(marker = DEFAULT_MARKER, style = 'html') {
  const s = COMMENT_STYLES[style] || COMMENT_STYLES.html;
  return s.open + marker + s.close;
}

/** True when the text already carries this marker (in any comment syntax). */
export function hasMarker(text, marker = DEFAULT_MARKER) {
  return String(text == null ? '' : text).includes(String(marker));
}

/** Wrap a block between `<!-- marker:start -->` / `<!-- marker:end -->` comments for later replacement. */
export function markerBlock(body, marker = DEFAULT_MARKER, style = 'html', { eol = '\n' } = {}) {
  return markerComment(marker + ':start', style) + eol + String(body).replace(/\s+$/, '') + eol + markerComment(marker + ':end', style);
}

/** Leading whitespace of the line containing `index`. */
function indentAt(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart, index + 1));
  return m ? m[0] : '';
}

function nthIndexOf(haystack, needle, occurrence) {
  let idx = -1;
  for (let n = 0; n < Math.max(1, occurrence); n++) {
    idx = haystack.indexOf(needle, idx + (n === 0 ? 0 : 1));
    if (idx === -1) return -1;
  }
  return idx;
}

/**
 * Insert `insert` immediately before or after an exact `anchor` string.
 *
 * Idempotency, in order: an existing `marker` wins, then the verbatim `insert` text. Either one
 * returns `{ ok: true, changed: false }` — running the same fix twice is a no-op, not a duplicate.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.anchor            exact substring that must exist
 * @param {'after'|'before'} [opts.position='after']
 * @param {string} opts.insert            text to add (a trailing newline is managed for you)
 * @param {string|null} [opts.marker]     idempotency marker to look for first
 * @param {number} [opts.occurrence=1]    which occurrence of the anchor to use (1-based)
 * @param {boolean} [opts.matchIndent=true] copy the anchor line's indentation onto inserted lines
 * @param {'line'|'inline'} [opts.mode='line'] 'line' puts the insert on its own line(s)
 * @returns {{ok, text, changed, reason, index}} reason: 'inserted' | 'marker-present' |
 *          'already-present' | 'anchor-not-found' | 'empty-insert'
 */
export function applyInsertAt(text, { anchor, position = 'after', insert, marker = null, occurrence = 1, matchIndent = true, mode = 'line' } = {}) {
  const src = String(text == null ? '' : text);
  const body = String(insert == null ? '' : insert);
  if (!body.trim()) return { ok: false, text: src, changed: false, reason: 'empty-insert', index: -1 };
  if (marker && hasMarker(src, marker)) return { ok: true, text: src, changed: false, reason: 'marker-present', index: src.indexOf(String(marker)) };
  if (src.includes(body.trim())) return { ok: true, text: src, changed: false, reason: 'already-present', index: src.indexOf(body.trim()) };
  if (typeof anchor !== 'string' || anchor === '') return { ok: false, text: src, changed: false, reason: 'anchor-not-found', index: -1 };

  const at = nthIndexOf(src, anchor, occurrence);
  if (at === -1) return { ok: false, text: src, changed: false, reason: 'anchor-not-found', index: -1 };

  const insertionPoint = position === 'before' ? at : at + anchor.length;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  if (mode === 'inline') {
    return { ok: true, text: src.slice(0, insertionPoint) + body + src.slice(insertionPoint), changed: true, reason: 'inserted', index: insertionPoint };
  }
  const indent = matchIndent ? indentAt(src, at) : '';
  const indented = body.split(/\r?\n/).map((l, i) => (l === '' ? '' : (i === 0 ? indent : indent) + l)).join(eol);
  const before = src.slice(0, insertionPoint);
  const after = src.slice(insertionPoint);
  const needsLeading = before !== '' && !before.endsWith('\n');
  const needsTrailing = after !== '' && !after.startsWith('\n');
  const chunk = (needsLeading ? eol : '') + indented + (needsTrailing ? eol : '');
  return { ok: true, text: before + chunk + after, changed: true, reason: 'inserted', index: insertionPoint };
}

/**
 * Replace the text between two exact delimiters.
 * @param {string} text
 * @param {object} opts { start, end, replacement, inclusive = false, occurrence = 1 }
 * @returns {{ok, text, changed, reason, range}} reason: 'replaced' | 'unchanged' | 'start-not-found' | 'end-not-found'
 */
export function replaceBetween(text, { start, end, replacement = '', inclusive = false, occurrence = 1 } = {}) {
  const src = String(text == null ? '' : text);
  if (typeof start !== 'string' || start === '') return { ok: false, text: src, changed: false, reason: 'start-not-found', range: null };
  if (typeof end !== 'string' || end === '') return { ok: false, text: src, changed: false, reason: 'end-not-found', range: null };
  const s = nthIndexOf(src, start, occurrence);
  if (s === -1) return { ok: false, text: src, changed: false, reason: 'start-not-found', range: null };
  const searchFrom = s + start.length;
  const e = src.indexOf(end, searchFrom);
  if (e === -1) return { ok: false, text: src, changed: false, reason: 'end-not-found', range: null };
  const from = inclusive ? s : searchFrom;
  const to = inclusive ? e + end.length : e;
  const next = src.slice(0, from) + String(replacement) + src.slice(to);
  return { ok: true, text: next, changed: next !== src, reason: next === src ? 'unchanged' : 'replaced', range: [from, to] };
}

/**
 * Insert or refresh a marker-delimited block. First run inserts at the anchor; later runs replace
 * what is between the markers, so re-fixing a page never stacks duplicates.
 */
export function upsertMarkerBlock(text, { marker = DEFAULT_MARKER, style = 'html', body, anchor, position = 'after', occurrence = 1 } = {}) {
  const src = String(text == null ? '' : text);
  const startTag = markerComment(marker + ':start', style);
  const endTag = markerComment(marker + ':end', style);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  if (src.includes(startTag) && src.includes(endTag)) {
    const replaced = replaceBetween(src, { start: startTag, end: endTag, replacement: eol + String(body).replace(/\s+$/, '') + eol });
    return { ...replaced, reason: replaced.changed ? 'block-updated' : 'block-unchanged' };
  }
  const block = markerBlock(body, marker, style, { eol });
  const inserted = applyInsertAt(src, { anchor, position, insert: block, occurrence, marker: null });
  return inserted;
}

/** Anchors the `html-head` strategy tries, best first: after charset, after the title, then <head>. */
export const HEAD_ANCHOR_PATTERNS = Object.freeze([
  { name: 'charset', re: /<meta[^>]*\bcharset\s*=[^>]*>/i, position: 'after' },
  { name: 'title', re: /<title[^>]*>[\s\S]*?<\/title>/i, position: 'after' },
  { name: 'head-open', re: /<head[^>]*>/i, position: 'after' },
]);

/**
 * Find the exact head anchor to insert after in an HTML/Liquid/template document.
 * @returns {{anchor: string, name: string, position: string}|null}
 */
export function findHeadAnchor(html) {
  const src = String(html == null ? '' : html);
  for (const p of HEAD_ANCHOR_PATTERNS) {
    const m = p.re.exec(src);
    if (m) return { anchor: m[0], name: p.name, position: p.position };
  }
  return null;
}

/**
 * Insert a snippet into a document's <head> at an exact anchor (charset > title > <head>).
 * Returns the same shape as applyInsertAt, plus `anchor` — the adapter records which anchor it used
 * so `verify` and `rollback` can talk about the same place in the file.
 */
export function insertInHead(html, snippet, { marker = DEFAULT_MARKER, style = 'html' } = {}) {
  const src = String(html == null ? '' : html);
  const anchor = findHeadAnchor(src);
  if (!anchor) return { ok: false, text: src, changed: false, reason: 'no-head', index: -1, anchor: null };
  const withMarker = marker && !String(snippet).includes(marker)
    ? String(snippet).replace(/\s+$/, '') + ' ' + markerComment(marker, style)
    : String(snippet);
  const res = applyInsertAt(src, { anchor: anchor.anchor, position: anchor.position, insert: withMarker, marker });
  return { ...res, anchor };
}
