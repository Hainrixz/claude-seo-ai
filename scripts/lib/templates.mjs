// Template clustering for the crawler (pure functions, no I/O).
//
// A "template" is the page type behind a URL: the product page, the blog post, the category
// listing. Two signals decide it, and both are recorded so a reader can check the call:
//
//   1. the URL path pattern — identifier-looking segments collapse to `*`, short literal
//      segments survive (`/blog/first-post` and `/blog/second-post` share `/blog/*`);
//   2. the page type — the primary JSON-LD `@type`, or, when there is no usable JSON-LD, the
//      CMS body class (`template-product`, `single-post`, …) mapped to the equivalent
//      schema.org family, so a Shopify product page with markup and one without still cluster
//      together instead of splitting on the presence of a `<script type=application/ld+json>`.
//
// The key is `<pattern>|<type>` ('' when no type was observed). explain() returns the whole
// derivation — every segment, its verdict, the JSON-LD types seen, the body class, the
// evidence strings — so `crawl.json` can say why two URLs landed in the same bucket.
//
// Nothing here fetches anything: the caller passes a parseDocument() result (and optionally the
// raw HTML head, since parseDocument does not record the <body class>).

/** Longest path prefix kept in a pattern; deeper paths end in `/**`. */
export const MAX_PATTERN_SEGMENTS = 10;
/** Most query parameter names kept in a pattern. */
export const MAX_PATTERN_QUERY_KEYS = 6;
/** File extensions stripped from a segment before it is classified. */
export const PAGE_EXTENSIONS = Object.freeze(['.html', '.htm', '.php', '.asp', '.aspx', '.jsp', '.xhtml', '.shtml']);

/**
 * JSON-LD types that describe the site or a widget rather than the page type. They never win the
 * `@type` vote; a page whose only markup is one of these is treated as untyped.
 */
export const GENERIC_JSONLD_TYPES = Object.freeze(new Set([
  'WebSite', 'BreadcrumbList', 'SearchAction', 'ListItem', 'SiteNavigationElement', 'WPHeader', 'WPFooter', 'WPSideBar',
  'ImageObject', 'Graph', 'Organization', 'Corporation', 'Person', 'PostalAddress', 'ContactPoint', 'OpeningHoursSpecification',
  'AggregateRating', 'Rating', 'Offer', 'AggregateOffer', 'Brand', 'Thing',
]));

/**
 * CMS body-class markers mapped to the schema.org family they describe. Order is priority: the
 * first rule matching any class token wins. Sources are the stock Shopify (`template-*`) and
 * WordPress/WooCommerce (`single-post`, `page-template-*`, `single-product`) body classes.
 */
export const CLASS_TEMPLATE_RULES = Object.freeze([
  [/^template-product$/, 'Product'],
  [/^product-template$/, 'Product'],
  [/^single-product$/, 'Product'],
  [/^template-collection$/, 'CollectionPage'],
  [/^collection-template$/, 'CollectionPage'],
  [/^template-list-collections$/, 'CollectionPage'],
  [/^(archive|category|tag|term|post-type-archive)(-.+)?$/, 'CollectionPage'],
  [/^template-article$/, 'Article'],
  [/^article-template$/, 'Article'],
  [/^single-post$/, 'Article'],
  [/^single-format-standard$/, 'Article'],
  [/^post-template(-.+)?$/, 'Article'],
  [/^template-blog$/, 'Blog'],
  [/^blog$/, 'Blog'],
  [/^template-index$/, 'WebSite'],
  [/^(home|front-page)$/, 'WebSite'],
  [/^template-page$/, 'WebPage'],
  [/^page-template(-.+)?$/, 'WebPage'],
  [/^(page|type-page)$/, 'WebPage'],
  [/^template-search$/, 'SearchResultsPage'],
  [/^search(-results|-no-results)?$/, 'SearchResultsPage'],
  [/^template-cart$/, 'CheckoutPage'],
  [/^cart-template$/, 'CheckoutPage'],
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{8,}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;
const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/i; // exactly "es" or "pt-br" — long slugs never match
const SLUG_RE = /^[^\s]*[-_][^\s]*$/;
const HAS_LETTER = /[a-z]/i;
const HAS_DIGIT = /\d/;

/** Split a path segment into its base and a page file extension ('' when there is none). */
export function splitExtension(seg) {
  const s = String(seg == null ? '' : seg);
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return { base: s, ext: '' };
  const ext = s.slice(dot).toLowerCase();
  return PAGE_EXTENSIONS.includes(ext) ? { base: s.slice(0, dot), ext } : { base: s, ext: '' };
}

/**
 * Decide whether one path segment is an identifier (collapses to `*`) or a literal section name.
 * @returns {{raw:string, base:string, ext:string, kind:string, out:string}} `kind` is the reason.
 *   Identifier kinds: numeric · uuid · hex · date · slug · alnum · long · single.
 *   Literal kinds:    locale · literal.
 */
export function classifySegment(seg, { index = 0 } = {}) {
  const raw = String(seg == null ? '' : seg);
  const { base, ext } = splitExtension(raw);
  const lower = base.toLowerCase();
  const literal = (kind) => ({ raw, base, ext, kind, out: lower + ext });
  const wild = (kind) => ({ raw, base, ext, kind, out: '*' });
  if (!base) return literal('literal');
  if (/^\d+$/.test(base)) return wild('numeric');
  if (UUID_RE.test(base)) return wild('uuid');
  if (ISO_DATE_RE.test(base)) return wild('date');
  if (index === 0 && LOCALE_RE.test(base)) return literal('locale');
  if (base.length === 1) return wild('single');
  if (HEX_ID_RE.test(base) && HAS_DIGIT.test(base)) return wild('hex');
  if (SLUG_RE.test(base) && base.length >= 6) return wild('slug');
  if (HAS_LETTER.test(base) && HAS_DIGIT.test(base) && base.length >= 4) return wild('alnum');
  if (base.length > 16) return wild('long');
  return literal('literal');
}

/** The pathname of a URL or path string, decoded when possible ('' inputs become '/'). */
function pathOf(urlOrPath) {
  const s = String(urlOrPath == null ? '' : urlOrPath).trim();
  if (!s) return { path: '/', search: '' };
  try {
    const u = /^https?:\/\//i.test(s) ? new URL(s) : new URL(s[0] === '/' ? 'http://x' + s : 'http://' + s);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch { /* keep the encoded form */ }
    return { path: p || '/', search: u.search };
  } catch {
    const [p, q = ''] = s.split('#')[0].split('?');
    return { path: p || '/', search: q ? '?' + q : '' };
  }
}

/** Sorted, de-duplicated query parameter names (values are never part of a template key). */
export function queryKeys(search) {
  if (!search) return [];
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  const names = [...new Set([...params.keys()].map((k) => k.toLowerCase()))].sort();
  return names.slice(0, MAX_PATTERN_QUERY_KEYS);
}

/**
 * URL → path pattern: `/blog/first-post` → `/blog/*`, `/` → `/`, `/es/shop/2/` → `/es/shop/*`.
 * A query turns into its sorted parameter names (`/search?q=x&page=2` → `/search?page&q`) because
 * filter and pagination URLs are their own template, never one bucket per value.
 */
export function pathPattern(urlOrPath, { withQuery = true } = {}) {
  const { path, search } = pathOf(urlOrPath);
  const parts = path.split('/').filter(Boolean);
  const kept = parts.slice(0, MAX_PATTERN_SEGMENTS).map((s, i) => classifySegment(s, { index: i }).out);
  let pattern = kept.length ? '/' + kept.join('/') : '/';
  if (parts.length > MAX_PATTERN_SEGMENTS) pattern += '/**';
  if (withQuery) {
    const keys = queryKeys(search);
    if (keys.length) pattern += '?' + keys.join('&');
  }
  return pattern;
}

/** `https://schema.org/Product` / `schema:Product` → `Product`. */
export function normalizeType(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) return '';
  const tail = s.split(/[/#]/).pop() || s;
  return tail.replace(/^[a-z0-9]+:/i, '').trim();
}

/**
 * The JSON-LD type that best describes the page: the first non-generic `@type` in document order.
 * @returns {{type:string|null, types:string[], blocks:number}} `types` is every type seen (normalized).
 */
export function primaryJsonLdType(parsed) {
  const blocks = parsed && Array.isArray(parsed.jsonld) ? parsed.jsonld : [];
  const types = [];
  for (const b of blocks) {
    if (!b || b.ok === false) continue;
    for (const t of Array.isArray(b.type) ? b.type : []) {
      const n = normalizeType(t);
      if (n && !types.includes(n)) types.push(n);
    }
  }
  const primary = types.find((t) => !GENERIC_JSONLD_TYPES.has(t)) || null;
  return { type: primary, types, blocks: blocks.length };
}

/** The class attribute of the first `<body>` tag, or null. Works on a partial HTML head. */
export function bodyClassOf(html) {
  if (typeof html !== 'string' || !html) return null;
  const m = /<body\b[^>]*?\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
  if (!m) return null;
  const value = (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '').trim();
  return value || null;
}

/**
 * Map a CMS body class to a schema.org family via CLASS_TEMPLATE_RULES.
 * @returns {{marker:string|null, family:string|null}} the class token that matched and its family.
 */
export function bodyTemplateMarker(bodyClass) {
  const tokens = String(bodyClass || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { marker: null, family: null };
  for (const [re, family] of CLASS_TEMPLATE_RULES) {
    for (const tok of tokens) if (re.test(tok)) return { marker: tok, family };
  }
  return { marker: null, family: null };
}

/** `/blog/*|Article` → `{ pattern: '/blog/*', type: 'Article' }` (type '' when the key has none). */
export function splitKey(key) {
  const s = String(key == null ? '' : key);
  const i = s.lastIndexOf('|');
  return i === -1 ? { pattern: s, type: '' } : { pattern: s.slice(0, i), type: s.slice(i + 1) };
}

/** Build a key from its parts (the inverse of splitKey). */
export function makeKey(pattern, type) { return String(pattern) + '|' + (type || ''); }

/**
 * Full derivation of a template key, for `crawl.json` and for humans.
 *
 * @param {string} url
 * @param {object|null} [parsed]  a parseDocument() result (jsonld, optionally body_class)
 * @param {object} [opts]
 * @param {string} [opts.bodyClass]  the `<body class>` value (parseDocument does not record it)
 * @param {string} [opts.html]       raw HTML (or just its head) to read the body class from
 * @returns {{key, pattern, type, type_source, segments, query_keys, jsonld_types, jsonld_blocks,
 *            body_class, body_marker, body_family, evidence}}
 */
export function explain(url, parsed = null, opts = {}) {
  const { path, search } = pathOf(url);
  const parts = path.split('/').filter(Boolean);
  const segments = parts.slice(0, MAX_PATTERN_SEGMENTS).map((s, i) => classifySegment(s, { index: i }));
  const pattern = pathPattern(url);
  const jl = primaryJsonLdType(parsed);
  const bodyClass = opts.bodyClass != null ? opts.bodyClass
    : (parsed && typeof parsed.body_class === 'string' ? parsed.body_class : bodyClassOf(opts.html));
  const { marker, family } = bodyTemplateMarker(bodyClass);

  let type = null, type_source = 'none';
  if (jl.type) { type = jl.type; type_source = 'jsonld'; }
  else if (family) { type = family; type_source = 'body-class'; }

  const evidence = ['url-pattern:' + pattern];
  if (jl.type) evidence.push('jsonld:' + jl.type);
  else if (jl.types.length) evidence.push('jsonld-generic:' + jl.types.join(','));
  if (marker) evidence.push('body-class:' + marker + '=>' + family);

  return {
    key: makeKey(pattern, type), pattern, type, type_source,
    segments, query_keys: queryKeys(search),
    jsonld_types: jl.types, jsonld_blocks: jl.blocks,
    body_class: bodyClass || null, body_marker: marker, body_family: family,
    evidence,
  };
}

/**
 * The template key of a URL: `<path pattern>|<page type>`. `parsed` (and `opts.html`/`opts.bodyClass`)
 * are optional — a URL nobody fetched yields the untyped key `<pattern>|`, which groupTemplates()
 * folds into the typed keys of the same pattern.
 */
export function templateKey(url, parsed = null, opts = {}) {
  return explain(url, parsed, opts).key;
}

/**
 * Roll per-URL keys up into the `templates[]` table of a crawl manifest.
 *
 * `entries` are `{ url, key, sampled, evidence? }` — one per discovered URL, `sampled` true for the
 * ones actually fetched. Untyped keys (`<pattern>|`) come from URLs nobody fetched: they are folded
 * into the pattern's primary typed key (the one with most samples, ties by first appearance) so a
 * template's `discovered` count covers the whole family, and the fold is disclosed in `evidence`
 * (`unfetched-urls-assigned-by-pattern`) and in `patterns_split` when one pattern carries several types.
 *
 * @returns {Array<{key, pattern, type, discovered, sampled, examples, evidence, weight, split}>}
 *   ordered by discovered desc, weight = the template's share of all discovered URLs (3 decimals).
 */
export function groupTemplates(entries, { examples = 3 } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.key === 'string') : [];
  const groups = new Map(); // key -> record
  const byPattern = new Map(); // pattern -> { keys: [], unfetched: [entries] }
  const add = (g, e) => {
    g.discovered++;
    if (e.sampled) g.sampled++;
    if (g.examples.length < examples) g.examples.push(e.url);
    for (const ev of e.evidence || []) if (!g.evidence.includes(ev)) g.evidence.push(ev);
  };
  const ensure = (key, pattern, type) => {
    if (!groups.has(key)) {
      groups.set(key, { key, pattern, type, discovered: 0, sampled: 0, examples: [], evidence: ['url-pattern:' + pattern], weight: 0, split: false });
      byPattern.get(pattern).keys.push(key);
    }
    return groups.get(key);
  };

  for (const e of list) {
    const { pattern, type } = splitKey(e.key);
    if (!byPattern.has(pattern)) byPattern.set(pattern, { keys: [], unfetched: [] });
    // A URL nobody fetched has no type of its own; it waits for the pattern's verdict below. A page
    // that WAS fetched keeps its own key even when untyped, so every pages[].template has a bucket.
    if (!type && !e.sampled) { byPattern.get(pattern).unfetched.push(e); continue; }
    add(ensure(e.key, pattern, type), e);
  }

  // Unfetched URLs join the busiest group of their pattern — disclosed, never silent.
  for (const [pattern, slot] of byPattern) {
    if (!slot.unfetched.length) continue;
    const ranked = slot.keys.map((k) => groups.get(k)).filter(Boolean).sort((a, b) => (b.sampled - a.sampled) || (b.discovered - a.discovered));
    let target = ranked[0];
    if (!target) target = ensure(makeKey(pattern, ''), pattern, '');
    else if (!target.evidence.includes('unfetched-urls-assigned-by-pattern')) target.evidence.push('unfetched-urls-assigned-by-pattern');
    for (const e of slot.unfetched) add(target, e);
  }
  // A pattern carrying several page types is a split (a product and an article under /shop/*).
  for (const slot of byPattern.values()) {
    if (slot.keys.length < 2) continue;
    for (const k of slot.keys) {
      const g = groups.get(k);
      if (!g) continue;
      g.split = true;
      if (!g.evidence.includes('pattern-split-by-type')) g.evidence.push('pattern-split-by-type');
    }
  }

  const out = [...groups.values()];
  const total = out.reduce((n, g) => n + g.discovered, 0) || 1;
  for (const g of out) g.weight = Math.round((g.discovered / total) * 1000) / 1000;
  out.sort((a, b) => (b.discovered - a.discovered) || (b.sampled - a.sampled) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
