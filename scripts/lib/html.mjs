// Zero-dependency HTML tokenizer + document model for claude-seo-ai.
//
// tokenize(html)            -> tokens with structure (parent, end_idx, region) — see TOKEN SHAPE below
// parseDocument(html, base) -> the flat, JSON-friendly page model every script builds on
// extractPassages(...)      -> content blocks (p/li/td/dd/blockquote/figcaption + leaf div/section)
// parseLinkHeader(value)    -> [{ href, rel[], hreflang, type, media }] from an HTTP Link header
// inContent(tok)            -> region test (nav/footer/aside are boilerplate; header only inside main/article)
//
// TOKEN SHAPE
//   { kind: 'open'|'close'|'self'|'raw'|'comment'|'doctype'|'text',
//     name, attrs (keys lowercased, first occurrence wins, values entity-decoded),
//     start, end (char offsets into the source), content (raw elements only), text (text tokens),
//     region ('body' or innermost landmark), regions (landmark stack snapshot),
//     parent (index of the enclosing open token, -1 at top level), depth,
//     end_idx (open tokens: index of the first token after the element; implied when no close tag),
//     open_idx (close tokens: index of the open token they close, -1 when stray),
//     landmark (open tokens: 'main'|'article'|'nav'|'header'|'footer'|'aside'|null) }
//   'self'  = void elements (img, meta, link, br, …) and anything written with "/>".
//   'raw'   = script/style/template/noscript/textarea/svg/iframe/xmp consumed whole; `.content` holds the inside.
//
// The tokenizer follows browser behaviour where it matters for SEO extraction (unquoted and
// single-quoted attributes, apostrophes inside double quotes, '>' inside quoted values, tags
// spanning lines, implied end tags for p/li/dd/dt/td/th/tr/option, stray end tags ignored).

import { decodeEntities } from './entities.mjs';
import { collectTypes } from './jsonld.mjs';

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'command']);
export const RAW_ELEMENTS = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'svg', 'iframe', 'xmp']);
export const LANDMARK_TAGS = new Set(['main', 'article', 'nav', 'header', 'footer', 'aside']);
const ROLE_LANDMARK = { navigation: 'nav', main: 'main', banner: 'header', contentinfo: 'footer', complementary: 'aside', article: 'article' };
// Elements whose start tag ends an open <p>, and whose boundaries separate words when flattening text.
export const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'body', 'html', 'head', 'title']);
// Inline-level elements that still separate words when text is flattened (never close an open <p>).
const TEXT_BREAK = new Set(['br', 'button', 'select', 'option', 'input', 'img', 'iframe', 'video', 'audio', 'canvas', 'svg']);
const breaksText = (name) => TEXT_BREAK.has(name) || BLOCK_ELEMENTS.has(name);
const INLINE_FORMATTING = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var']);
const HEADING = /^h[1-6]$/;

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

const closeTagRe = new Map();
function findRawEnd(html, name, from) {
  let re = closeTagRe.get(name);
  if (!re) { re = new RegExp('</' + name + '(?=[\\s/>])', 'gi'); closeTagRe.set(name, re); }
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return { contentEnd: html.length, tagEnd: html.length };
  const gt = html.indexOf('>', m.index + 2);
  return { contentEnd: m.index, tagEnd: gt === -1 ? html.length : gt + 1 };
}

/** Scan attributes starting at `i` (just after the tag name). Returns { attrs, end, selfClosing }. */
function scanAttrs(html, i) {
  const n = html.length;
  const attrs = {};
  let selfClosing = false;
  while (i < n) {
    let c = html.charCodeAt(i);
    if (isWs(c)) { i++; continue; }
    if (c === 62 /* > */) return { attrs, end: i + 1, selfClosing };
    if (c === 47 /* / */) { if (html.charCodeAt(i + 1) === 62) { selfClosing = true; return { attrs, end: i + 2, selfClosing }; } i++; continue; }
    // attribute name
    let ns = i;
    while (i < n) { c = html.charCodeAt(i); if (isWs(c) || c === 47 || c === 62 || (c === 61 && i > ns)) break; i++; }
    const name = html.slice(ns, i).toLowerCase();
    // optional "= value"
    let j = i;
    while (j < n && isWs(html.charCodeAt(j))) j++;
    let value = null;
    if (html.charCodeAt(j) === 61 /* = */) {
      j++;
      while (j < n && isWs(html.charCodeAt(j))) j++;
      const q = html.charCodeAt(j);
      if (q === 34 || q === 39) {
        const close = html.indexOf(String.fromCharCode(q), j + 1);
        const vEnd = close === -1 ? n : close;
        value = html.slice(j + 1, vEnd);
        i = close === -1 ? n : close + 1;
      } else {
        let vs = j;
        while (j < n) { c = html.charCodeAt(j); if (isWs(c) || c === 62) break; j++; }
        value = html.slice(vs, j);
        i = j;
      }
    }
    if (name && !Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = value === null ? '' : (value.indexOf('&') === -1 ? value : decodeEntities(value));
    if (!name && i === ns) i++; // stray character (e.g. a lone '='): skip it
  }
  return { attrs, end: n, selfClosing };
}

/** Lexing pass: raw token stream without structure. */
function lex(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  let textStart = 0;
  const flushText = (upto) => {
    if (upto > textStart) tokens.push({ kind: 'text', text: html.slice(textStart, upto), start: textStart, end: upto });
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const c1 = html.charCodeAt(lt + 1);
    if (isAlpha(c1)) {
      // open tag
      let j = lt + 1;
      while (j < n) { const c = html.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++; }
      const name = html.slice(lt + 1, j).toLowerCase();
      const { attrs, end, selfClosing } = scanAttrs(html, j);
      flushText(lt);
      if (RAW_ELEMENTS.has(name) && !selfClosing) {
        const { contentEnd, tagEnd } = findRawEnd(html, name, end);
        tokens.push({ kind: 'raw', name, attrs, start: lt, end: tagEnd, content: html.slice(end, contentEnd) });
        i = textStart = tagEnd;
      } else {
        tokens.push({ kind: selfClosing || VOID_ELEMENTS.has(name) ? 'self' : 'open', name, attrs, start: lt, end });
        i = textStart = end;
      }
      continue;
    }
    if (c1 === 47 /* / */ && isAlpha(html.charCodeAt(lt + 2))) {
      let j = lt + 2;
      while (j < n) { const c = html.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++; }
      const name = html.slice(lt + 2, j).toLowerCase();
      const gt = html.indexOf('>', j);
      const end = gt === -1 ? n : gt + 1;
      flushText(lt);
      tokens.push({ kind: 'close', name, start: lt, end });
      i = textStart = end;
      continue;
    }
    if (c1 === 33 /* ! */) {
      flushText(lt);
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        const end = close === -1 ? n : close + 3;
        tokens.push({ kind: 'comment', text: html.slice(lt + 4, close === -1 ? n : close), start: lt, end });
        i = textStart = end;
      } else if (/^<!doctype/i.test(html.slice(lt, lt + 9))) {
        const gt = html.indexOf('>', lt);
        const end = gt === -1 ? n : gt + 1;
        tokens.push({ kind: 'doctype', text: html.slice(lt + 2, gt === -1 ? n : gt), start: lt, end });
        i = textStart = end;
      } else {
        // bogus comment (<![CDATA[ … ]]> in HTML, <!ELEMENT …>)
        const gt = html.indexOf('>', lt);
        const end = gt === -1 ? n : gt + 1;
        tokens.push({ kind: 'comment', text: html.slice(lt + 2, gt === -1 ? n : gt), bogus: true, start: lt, end });
        i = textStart = end;
      }
      continue;
    }
    if (c1 === 63 /* ? */) {
      flushText(lt);
      const gt = html.indexOf('>', lt);
      const end = gt === -1 ? n : gt + 1;
      tokens.push({ kind: 'comment', text: html.slice(lt + 1, gt === -1 ? n : gt), bogus: true, start: lt, end });
      i = textStart = end;
      continue;
    }
    // a literal '<' in text
    i = lt + 1;
  }
  flushText(n);
  return tokens;
}

/** Structural pass: parents, implied end tags, end_idx, landmark regions. Mutates tokens in place. */
function structure(tokens) {
  const stack = []; // indices of open tokens
  let landmarks = Object.freeze([]);
  const nameAt = (k) => tokens[stack[k]].name;
  const popTo = (k, endIdx) => {
    while (stack.length > k) {
      const idx = stack.pop();
      const t = tokens[idx];
      t.end_idx = endIdx;
      if (t.landmark) landmarks = Object.freeze(landmarks.slice(0, -1));
    }
  };
  // Find the nearest open element named in `targets`, stopping at any element in `stops`. Returns stack index or -1.
  const findUpTo = (targets, stops) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const nm = nameAt(k);
      if (targets.has(nm)) return k;
      if (stops && stops.has(nm)) return -1;
    }
    return -1;
  };
  const P = new Set(['p']), LI = new Set(['li']), LIST = new Set(['ul', 'ol', 'menu']), DEF = new Set(['dt', 'dd']), DL = new Set(['dl']);
  const CELL = new Set(['td', 'th']), CELLSTOP = new Set(['tr', 'table']), ROW = new Set(['tr']), TBL = new Set(['table']);
  const SECT = new Set(['thead', 'tbody', 'tfoot']), ROWSTOP = new Set(['table', 'thead', 'tbody', 'tfoot']);
  const OPT = new Set(['option']), OPTSTOP = new Set(['select', 'datalist']), A = new Set(['a']);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'open' || tok.kind === 'self' || tok.kind === 'raw') {
      const name = tok.name;
      // implied end tags triggered by this start tag
      if (BLOCK_ELEMENTS.has(name) && stack.length) {
        // close an open <p> unless separated from it by a non-inline element
        for (let k = stack.length - 1; k >= 0; k--) {
          const nm = nameAt(k);
          if (nm === 'p') { popTo(k, i); break; }
          if (!INLINE_FORMATTING.has(nm)) break;
        }
      }
      let k = -1;
      if (name === 'li') k = findUpTo(LI, LIST);
      else if (name === 'dt' || name === 'dd') k = findUpTo(DEF, DL);
      else if (name === 'td' || name === 'th') k = findUpTo(CELL, CELLSTOP);
      else if (name === 'tr') k = findUpTo(ROW, ROWSTOP);
      else if (name === 'thead' || name === 'tbody' || name === 'tfoot') k = findUpTo(SECT, TBL);
      else if (name === 'option') k = findUpTo(OPT, OPTSTOP);
      else if (name === 'a') k = findUpTo(A, null);
      else if (HEADING.test(name) && stack.length && HEADING.test(nameAt(stack.length - 1))) k = stack.length - 1;
      if (k !== -1) popTo(k, i);
    }
    tok.parent = stack.length ? stack[stack.length - 1] : -1;
    tok.depth = stack.length;
    tok.regions = landmarks;
    tok.region = landmarks.length ? landmarks[landmarks.length - 1] : 'body';

    if (tok.kind === 'open') {
      const role = tok.attrs.role ? String(tok.attrs.role).trim().toLowerCase().split(/\s+/)[0] : '';
      tok.landmark = LANDMARK_TAGS.has(tok.name) ? tok.name : (ROLE_LANDMARK[role] || null);
      if (tok.landmark) landmarks = Object.freeze([...landmarks, tok.landmark]);
      stack.push(i);
    } else if (tok.kind === 'self' || tok.kind === 'raw') {
      tok.end_idx = i + 1;
    } else if (tok.kind === 'close') {
      let k = -1;
      for (let s = stack.length - 1; s >= 0; s--) if (nameAt(s) === tok.name) { k = s; break; }
      if (k === -1) { tok.open_idx = -1; tok.stray = true; continue; }
      tok.open_idx = stack[k];
      popTo(k, i);
    }
  }
  popTo(0, tokens.length);
  return tokens;
}

/** Tokenize HTML into a structured token list (see TOKEN SHAPE at the top of this file). */
export function tokenize(html) {
  const src = typeof html === 'string' ? html : String(html ?? '');
  return structure(lex(src));
}

/** True when the token sits in a content region: not nav/footer/aside; a header only counts inside main/article. */
export function inContent(tok) {
  const r = (tok && tok.regions) || [];
  let hasHeader = false, hasContentRoot = false;
  for (const x of r) {
    if (x === 'nav' || x === 'footer' || x === 'aside') return false;
    if (x === 'header') hasHeader = true;
    else if (x === 'main' || x === 'article') hasContentRoot = true;
  }
  return !(hasHeader && !hasContentRoot);
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Visible text inside the element opened at index `i` (block boundaries and <br> become spaces). */
export function innerText(tokens, i, { maxLen = Infinity } = {}) {
  const open = tokens[i];
  if (!open || (open.kind !== 'open')) return open && open.kind === 'text' ? collapse(decodeEntities(open.text)) : '';
  const end = open.end_idx == null ? tokens.length : open.end_idx;
  let out = '';
  for (let j = i + 1; j < end; j++) {
    const t = tokens[j];
    if (t.kind === 'text') { out += t.text; if (out.length > maxLen * 4 + 64) break; }
    else if (t.kind !== 'comment' && t.name && breaksText(t.name)) out += ' ';
  }
  const s = collapse(decodeEntities(out));
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function resolveUrl(href, base) {
  if (href == null) return null;
  const h = String(href).trim();
  if (!h) return null;
  try { return base ? new URL(h, base).href : new URL(h).href; } catch { return null; }
}

function hostKey(host) { return String(host || '').toLowerCase().replace(/^www\./, ''); }

/** Compare two URLs for SEO equivalence: scheme/host case, default port, trailing slash and fragment ignored. */
export function sameUrl(a, b, base) {
  const norm = (u) => {
    try {
      const x = new URL(String(u), base);
      x.hash = '';
      let p = x.pathname.replace(/\/+$/, '') || '/';
      return `${x.protocol}//${x.host.toLowerCase()}${p}${x.search}`;
    } catch { return null; }
  };
  const na = norm(a), nb = norm(b);
  return na !== null && nb !== null && na === nb;
}

const numericPx = (v) => (v == null ? null : (/^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(String(v)) || [])[1] || null);

function splitList(v) { return v == null ? [] : String(v).trim().toLowerCase().split(/\s+/).filter(Boolean); }

function parseSrcset(v) {
  if (v == null) return [];
  return String(v).split(',').map((c) => c.trim()).filter(Boolean).map((c) => c.split(/\s+/)[0]).filter(Boolean);
}

/**
 * Framework-bound `src`/`alt`: Vue `:src` / `v-bind:alt`, Alpine `x-bind:src`, Angular `[src]`.
 * The real value is written by JavaScript, so the plain attribute is ABSENT from the static HTML
 * rather than empty in it — a distinction a finding that quotes the tag has to be able to make.
 */
const BOUND_ATTR_RE = /^(?::|v-bind:|x-bind:|\[)(src|alt)\]?$/;
const boundAttrs = (attrs) => Object.keys(attrs).filter((k) => BOUND_ATTR_RE.test(k));

const JSONLD_MIME = 'application/ld+json';
function isJsonLdType(type) {
  if (type == null) return false;
  return String(type).split(';')[0].trim().toLowerCase() === JSONLD_MIME;
}

function parseJsonLdBlock(raw) {
  const text = raw.trim();
  try { return { ok: true, data: JSON.parse(text), error: null, repaired: null }; }
  catch (e) {
    // Common wrapper noise: HTML comments or CDATA around the JSON. Strip once and retry, but say so.
    const stripped = text.replace(/^<!--/, '').replace(/-->$/, '').replace(/^\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>$/, '').trim();
    if (stripped !== text) {
      try { return { ok: true, data: JSON.parse(stripped), error: null, repaired: 'stripped_comment_wrapper' }; } catch { /* fall through */ }
    }
    return { ok: false, data: null, error: String(e && e.message || e), repaired: null };
  }
}

const JS_NOTICE = /(enable|turn on|activate|allow)\s+javascript|javascript\s+(is\s+)?(required|disabled|needed|must be enabled)|requires?\s+javascript|(does not|doesn't|won't) work (properly )?without javascript|necesita(s)? javascript|activa(r)? javascript|javascript (est[aá] )?(desactivado|deshabilitado)/i;

/**
 * Parse an HTML document into the flat page model. `baseUrl` (optional) is the page's URL and is
 * used for absolute URLs, internal/external classification and <base href> resolution.
 * Pass `{ tokens }` to reuse a token list you already have.
 */
export function parseDocument(html, baseUrl = null, opts = {}) {
  const src = typeof html === 'string' ? html : String(html ?? '');
  const tokens = opts.tokens || tokenize(src);

  // <base href> (first wins, browsers ignore later ones)
  let base_href = null;
  for (const t of tokens) if (t.kind === 'self' && t.name === 'base' && t.attrs.href != null) { base_href = t.attrs.href; break; }
  const effective_base = (base_href && resolveUrl(base_href, baseUrl || undefined)) || (baseUrl ? resolveUrl(baseUrl, undefined) : null);
  const pageHost = (() => { try { return baseUrl ? hostKey(new URL(baseUrl).host) : null; } catch { return null; } })();
  const abs = (h) => resolveUrl(h, effective_base || undefined);

  // label[for] set for form labelling
  const labelFor = new Set();
  for (const t of tokens) if (t.kind === 'open' && t.name === 'label' && t.attrs.for) labelFor.add(t.attrs.for);

  const doc = {
    base_href, effective_base,
    title: { value: null, count: 0 },
    metas: [], robots_meta: [], lang: null, charset: { value: null, offset_bytes: null },
    canonicals: [], hreflang: [], links_rel: [], anchors: [], headings: [], images: [], scripts: [], stylesheets: [],
    jsonld: [], microdata_items: 0, rdfa_typeof: 0, iframes: [], forms: [],
    landmarks: { main: 0, article: 0, nav: 0, header: 0, footer: 0, aside: 0 },
    markers: { next_data: false, next_assets: false, nuxt: false, reactroot: false, next_root_empty: null, app_root_empty: null, angular: false, sveltekit: false, astro: false, remix: false, noscript_js_notice: false, generator: null },
    word_count: 0, text_sample: '', html_comments_sample: [],
  };

  let text = '';
  let htmlLangSeen = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const kind = t.kind;
    if (kind === 'text') {
      if (!inContent(t)) continue;
      const p = t.parent >= 0 ? tokens[t.parent].name : null;
      if (p === 'title' || p === 'head') continue; // head text is never page content
      text += t.text;
      continue;
    }
    if (kind === 'comment') {
      if (!t.bogus && doc.html_comments_sample.length < 5) { const c = collapse(t.text); if (c) doc.html_comments_sample.push(c.slice(0, 120)); }
      continue;
    }
    if (kind === 'doctype' || kind === 'close') continue;
    const name = t.name, a = t.attrs;
    if (inContent(t) && breaksText(name)) text += ' ';

    if (a.itemscope !== undefined) doc.microdata_items++;
    if (a.typeof !== undefined) doc.rdfa_typeof++;
    if (t.landmark) doc.landmarks[t.landmark]++;
    if (a['data-reactroot'] !== undefined) doc.markers.reactroot = true;
    if (a['ng-version'] !== undefined || name === 'app-root') doc.markers.angular = true;
    if (name === 'astro-island' || name === 'astro-slot') doc.markers.astro = true;
    for (const k in a) {
      if (k.startsWith('data-sveltekit')) doc.markers.sveltekit = true;
      else if (k.startsWith('data-astro-')) doc.markers.astro = true;
    }
    const id = a.id;
    if (kind === 'open' && id) {
      if (id === '__next') doc.markers.next_root_empty = innerText(tokens, i, { maxLen: 8 }).length === 0;
      else if (id === '__nuxt' || id === '__NUXT') { doc.markers.nuxt = true; doc.markers.app_root_empty = innerText(tokens, i, { maxLen: 8 }).length === 0; }
      else if (id === 'root' || id === 'app' || id === '___gatsby' || id === '__layout' || id === 'svelte') doc.markers.app_root_empty = innerText(tokens, i, { maxLen: 8 }).length === 0;
    }

    switch (name) {
      case 'html':
        if (!htmlLangSeen) { htmlLangSeen = true; doc.lang = a.lang ?? a['xml:lang'] ?? null; }
        break;
      case 'title':
        if (kind === 'open') { doc.title.count++; if (doc.title.value === null) doc.title.value = innerText(tokens, i); }
        break;
      case 'meta': {
        const m = { name: a.name != null ? a.name.trim().toLowerCase() : null, property: a.property != null ? a.property.trim().toLowerCase() : null, content: a.content ?? null };
        if (a['http-equiv'] != null) m.http_equiv = a['http-equiv'].trim().toLowerCase();
        if (a.itemprop != null) m.itemprop = a.itemprop;
        if (a.charset != null) m.charset = a.charset;
        doc.metas.push(m);
        if (m.name === 'robots' || m.name === 'googlebot' || m.name === 'bingbot') doc.robots_meta.push({ name: m.name, content: m.content });
        if (m.name === 'generator' && doc.markers.generator === null) doc.markers.generator = m.content;
        if (doc.charset.value === null) {
          let cs = null;
          if (a.charset != null) cs = a.charset.trim();
          else if (m.http_equiv === 'content-type' && m.content) cs = (/charset\s*=\s*["']?([\w-]+)/i.exec(m.content) || [])[1] || null;
          if (cs) doc.charset = { value: cs, offset_bytes: Buffer.byteLength(src.slice(0, t.start), 'utf8') };
        }
        break;
      }
      case 'link': {
        const rel = splitList(a.rel);
        const entry = { rel, href: a.href ?? null, abs: abs(a.href), hreflang: a.hreflang ?? null, type: a.type ?? null, media: a.media ?? null };
        if (a.as != null) entry.as = a.as;
        doc.links_rel.push(entry);
        if (rel.includes('canonical') && entry.href != null) doc.canonicals.push({ href: entry.href, abs: entry.abs, source: 'link' });
        if (rel.includes('alternate') && entry.hreflang && entry.href != null) doc.hreflang.push({ hreflang: entry.hreflang, href: entry.href, abs: entry.abs, source: 'link' });
        if (rel.includes('stylesheet') && entry.href != null) doc.stylesheets.push({ href: entry.href, abs: entry.abs, media: entry.media });
        break;
      }
      case 'a': {
        if (a.href == null) break;
        const href = a.href.trim();
        const rel = splitList(a.rel);
        let anchor = kind === 'open' ? innerText(tokens, i) : '';
        let anchor_source = anchor ? 'text' : 'empty';
        if (!anchor && kind === 'open') {
          const aria = a['aria-label'] && a['aria-label'].trim();
          if (aria) { anchor = collapse(aria); anchor_source = 'aria-label'; }
          else {
            for (let j = i + 1; j < t.end_idx; j++) { const c = tokens[j]; if (c.kind === 'self' && c.name === 'img' && c.attrs.alt && c.attrs.alt.trim()) { anchor = collapse(c.attrs.alt); anchor_source = 'image-alt'; break; } }
            if (!anchor && a.title && a.title.trim()) { anchor = collapse(a.title); anchor_source = 'title'; }
          }
        }
        const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(href) || [])[1];
        const kindOf = !scheme ? 'http' : (/^https?$/i.test(scheme) ? 'http' : scheme.toLowerCase());
        const absHref = kindOf === 'http' ? abs(href) : null;
        let internal = null;
        if (kindOf !== 'http') internal = false;
        else if (absHref && pageHost) { try { internal = hostKey(new URL(absHref).host) === pageHost; } catch { internal = null; } }
        else if (!scheme && !href.startsWith('//')) internal = true;
        doc.anchors.push({
          href, abs: absHref, anchor, anchor_source, rel, nofollow: rel.includes('nofollow'), sponsored: rel.includes('sponsored'), ugc: rel.includes('ugc'),
          internal, fragment_only: href === '' || href.startsWith('#'), scheme: kindOf, region: t.region, in_content: inContent(t),
        });
        break;
      }
      case 'img': {
        const src_ = a.src != null && a.src.trim() !== '' ? a.src.trim() : null;
        const dataSrc = a['data-src'] ?? a['data-lazy-src'] ?? a['data-original'] ?? a['data-srcset'] ?? null;
        const w = numericPx(a.width), h = numericPx(a.height);
        const placeholder = src_ === null || /^data:/i.test(src_);
        doc.images.push({
          src: src_, abs: abs(src_), srcset: parseSrcset(a.srcset), data_src: dataSrc, lazy: (a.loading || '').trim().toLowerCase() === 'lazy' || (placeholder && dataSrc != null),
          alt: a.alt ?? null, alt_present: a.alt !== undefined, width: a.width ?? null, height: a.height ?? null, sized: w !== null && h !== null,
          bound: boundAttrs(a), region: t.region, in_content: inContent(t),
        });
        break;
      }
      case 'script': {
        if (isJsonLdType(a.type)) {
          const parsed = parseJsonLdBlock(t.content || '');
          const raw = (t.content || '').trim();
          const block = parsed.ok ? { ok: true, type: collectTypes(parsed.data), data: parsed.data, error: null, raw } : { ok: false, type: [], data: null, error: parsed.error, raw };
          if (parsed.repaired) block.repaired = parsed.repaired;
          doc.jsonld.push(block);
        } else {
          const s = { src: a.src ?? null, abs: abs(a.src), type: a.type ?? null, async: a.async !== undefined, defer: a.defer !== undefined, module: (a.type || '').trim().toLowerCase() === 'module', inline_bytes: a.src == null ? Buffer.byteLength(t.content || '', 'utf8') : 0 };
          doc.scripts.push(s);
          if (id === '__NEXT_DATA__') doc.markers.next_data = true;
          if (s.src && /\/_next\//.test(s.src)) doc.markers.next_assets = true;
          if (!s.src && t.content) {
            if (/window\.__NUXT__|__NUXT_DATA__|useNuxtApp/.test(t.content)) doc.markers.nuxt = true;
            if (/__remixContext|__remixManifest|__remixRouteModules/.test(t.content)) doc.markers.remix = true;
            if (/__sveltekit_|kit\.start\(|sveltekit/.test(t.content)) doc.markers.sveltekit = true;
          }
          if (s.src && /\/_app\/immutable\//.test(s.src)) doc.markers.sveltekit = true;
        }
        break;
      }
      case 'noscript':
        if (t.content && JS_NOTICE.test(t.content)) doc.markers.noscript_js_notice = true;
        break;
      case 'iframe':
        doc.iframes.push({ src: a.src ?? null, abs: abs(a.src), title: a.title ?? null, loading: a.loading ?? null, region: t.region });
        break;
      case 'form': {
        if (kind !== 'open') break;
        let inputs = 0, labeled = 0;
        for (let j = i + 1; j < t.end_idx; j++) {
          const c = tokens[j];
          if (!c.name || !c.attrs) continue; // close tokens carry a name but no attrs
          const isInput = (c.name === 'input' && !/^(hidden|submit|button|reset|image)$/i.test(c.attrs.type || 'text')) || c.name === 'select' || c.name === 'textarea';
          if (!isInput) continue;
          inputs++;
          let lab = c.attrs['aria-label'] != null || c.attrs['aria-labelledby'] != null || (c.attrs.id && labelFor.has(c.attrs.id));
          if (!lab) for (let p = c.parent; p >= 0 && p > i; p = tokens[p].parent) if (tokens[p].name === 'label') { lab = true; break; }
          if (lab) labeled++;
        }
        doc.forms.push({ action: a.action ?? null, abs: abs(a.action), method: (a.method || 'get').toLowerCase(), inputs, labeled, region: t.region });
        break;
      }
      default:
        if (kind === 'open' && HEADING.test(name)) doc.headings.push({ level: Number(name[1]), text: innerText(tokens, i), region: t.region, in_content: inContent(t) });
        else if (kind === 'open' && a.role === 'heading' && /^[1-6]$/.test(String(a['aria-level'] || ''))) doc.headings.push({ level: Number(a['aria-level']), text: innerText(tokens, i), region: t.region, in_content: inContent(t), aria: true });
    }
  }

  const flat = collapse(decodeEntities(text));
  doc.word_count = flat ? flat.split(' ').length : 0;
  doc.text_sample = flat.slice(0, 2000);
  return doc;
}

const PASSAGE_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'blockquote', 'figcaption', 'div', 'section']);
const PASSAGE_BLOCK_CHILD = new Set([...BLOCK_ELEMENTS].filter((n) => n !== 'br'));

/**
 * Content blocks for passage-level analysis. A block is a p/li/td/th/dd/blockquote/figcaption or a
 * leaf div/section whose own text (inline children included) has >= minWords words and which
 * contains no block-level child. Returns [{ text, words, region, tag, heading_before, in_content }].
 */
export function extractPassages(tokensOrHtml, { minWords = 5 } = {}) {
  const tokens = Array.isArray(tokensOrHtml) ? tokensOrHtml : tokenize(tokensOrHtml);
  const out = [];
  let headingBefore = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'open') continue;
    if (HEADING.test(t.name)) { headingBefore = innerText(tokens, i); continue; }
    if (!PASSAGE_TAGS.has(t.name)) continue;
    const end = t.end_idx == null ? tokens.length : t.end_idx;
    let hasBlock = false;
    for (let j = i + 1; j < end; j++) {
      const c = tokens[j];
      if ((c.kind === 'open' || c.kind === 'self') && PASSAGE_BLOCK_CHILD.has(c.name)) { hasBlock = true; break; }
    }
    if (hasBlock) continue;
    const text = innerText(tokens, i);
    if (!text) continue;
    const words = text.split(' ').length;
    if (words < minWords) continue;
    out.push({ text, words, region: t.region, tag: t.name, heading_before: headingBefore, in_content: inContent(t) });
  }
  return out;
}

/**
 * Parse an HTTP Link header (RFC 8288) into [{ href, rel[], hreflang, type, media, title }].
 * Accepts a string or an array of header values; commas inside quotes or <> do not split.
 */
export function parseLinkHeader(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value.join(', ') : String(value);
  const parts = [];
  let cur = '', q = null, angle = false;
  for (const ch of raw) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '<') angle = true; else if (ch === '>') angle = false;
    if (ch === ',' && !angle) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const part of parts) {
    const m = /^\s*<([^>]*)>\s*(.*)$/s.exec(part);
    if (!m) continue;
    const entry = { href: m[1].trim(), rel: [], hreflang: null, type: null, media: null, title: null };
    for (const param of m[2].split(';')) {
      const pm = /^\s*([A-Za-z*-]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))\s*$/.exec(param);
      if (!pm) continue;
      const k = pm[1].toLowerCase(), v = (pm[2] !== undefined ? pm[2] : pm[3]).trim();
      if (k === 'rel') entry.rel = v.toLowerCase().split(/\s+/).filter(Boolean);
      else if (k === 'hreflang') entry.hreflang = v;
      else if (k === 'type') entry.type = v;
      else if (k === 'media') entry.media = v;
      else if (k === 'title') entry.title = v;
    }
    out.push(entry);
  }
  return out;
}
