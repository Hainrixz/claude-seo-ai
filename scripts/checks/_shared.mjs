// Shared helpers for the deterministic checks in scripts/checks/*.mjs.
//
// Not a check module: it exports no `check`. Every check imports `mk()` from here so that all
// findings go through lib/finding.mjs makeFinding() (schema-validated, absolute reproduce
// command) and so the honesty rules live in exactly one place:
//   - `observed` is always something we actually read (a tag, a header, a robots line, a count);
//   - a fact we could not observe becomes `needs_api` / `manual_review`, never a silent pass;
//   - `established` is reserved for mechanisms a vendor documents.

import { join, resolve } from 'node:path';
import { makeFinding, isTestMode } from '../lib/finding.mjs';
import { normalizeUrl, urlsEquivalent, hostKey } from '../lib/urlnorm.mjs';
import { tokenize } from '../lib/html.mjs';
import { isHtmlDocument, mediaTypeOf } from '../lib/site.mjs';

/** Statuses that never enter a score; makeFinding defaults their severity to 0. */
export const UNSCORED = new Set(['not_applicable', 'needs_api', 'manual_review']);

/**
 * Build one finding. Throws inside node:test (so a malformed finding fails the suite loudly) and
 * returns null in production, where runChecks() counts the drop instead of crashing the audit.
 * @returns {object|null}
 */
export function mk(spec) {
  const { finding, errors } = makeFinding(spec);
  if (errors.length) {
    if (isTestMode()) throw new Error('invalid finding ' + (spec && spec.id) + ': ' + errors.join('; '));
    recordDrop(spec, errors);
    return null;
  }
  return finding;
}

/**
 * Schema-invalid findings dropped in production, so the drop is observable instead of silent.
 *
 * A module-level log rather than run state: `mk()` receives only the finding spec, and every check
 * in a run executes in this one process, so runChecks() can drain the log after each check and
 * attribute the drops to it. `takeDropped()` empties the log; a run that never drains it cannot
 * grow unbounded either, because the log is capped.
 */
const MAX_DROPPED = 100;
const dropped = [];
/** Every drop since the last drain, INCLUDING the ones past MAX_DROPPED. */
let droppedTotal = 0;

function recordDrop(spec, errors) {
  // Counted before the cap: the entry list is bounded so a runaway check cannot eat memory, but the
  // count must stay exact. A silently under-reported count is the failure this log exists to prevent
  // — past the cap, a schema regression would look like a clean site again.
  droppedTotal++;
  if (dropped.length >= MAX_DROPPED) return;
  const id = spec && typeof spec.id === 'string' ? spec.id : null;
  dropped.push({ id, module: id ? id.split('.')[0] : null, errors: errors.slice(0, 5) });
}

/**
 * Drain the dropped-finding log.
 * @returns {{entries: object[], total: number}} the entries recorded since the last call (capped at
 *   MAX_DROPPED) and the exact number of drops they stand for, which can be larger.
 */
export function takeDropped() {
  const entries = dropped.splice(0, dropped.length);
  const total = droppedTotal;
  droppedTotal = 0;
  return { entries, total };
}

/** Read the log without clearing it (diagnostics and tests). */
export function peekDropped() {
  return dropped.slice();
}

/** Push non-null findings onto `out` (variadic; accepts arrays). */
export function push(out, ...items) {
  for (const item of items) {
    if (Array.isArray(item)) push(out, ...item);
    else if (item) out.push(item);
  }
}

/* ----------------------------------------------------------------- run-dir paths */

/** Absolute path of a page's snapshot JSON, for a runnable `--snapshot` reproduce command. */
export function snapshotPath(ctx, page) {
  if (page && page.snapshot_path) return page.snapshot_path;
  if (ctx && ctx.run_dir && page && page.slug) return resolve(join(ctx.run_dir, 'pages', page.slug + '.json'));
  return null;
}

/** `{script, args}` shorthand for a script that accepts `--snapshot <pages/x.json>`. */
export function snapRepro(ctx, page, script, extra = {}) {
  const p = snapshotPath(ctx, page);
  return p ? { script, args: { snapshot: p, ...extra } } : { script, args: { url: pageUrl(page), ...extra } };
}

/** `{script, args}` shorthand for a script that takes the run directory. */
export function runRepro(ctx, script, extra = {}) {
  return { script, args: { 'run-dir': ctx.run_dir, ...extra } };
}

/* ----------------------------------------------------------------- page helpers */

export function pageUrl(page) {
  if (!page) return null;
  return page.url || (page.snapshot && page.snapshot.target && (page.snapshot.target.final_url || page.snapshot.target.value)) || null;
}

/** The URL the page finally resolved to (what canonical/hreflang must be compared against). */
export function finalUrl(page) {
  const t = page && page.snapshot && page.snapshot.target;
  return (t && (t.final_url || t.value)) || pageUrl(page);
}

/** HTTP status, or null for a local file snapshot. */
export function pageStatus(page) {
  if (!page) return null;
  if (page.status !== undefined && page.status !== null) return page.status;
  return page.snapshot && page.snapshot.status != null ? page.snapshot.status : null;
}

/** The page's declared media type, lowercased and without parameters ('' when undeclared). */
export function contentTypeOf(page) {
  return mediaTypeOf((page && page.snapshot && page.snapshot.headers) || null);
}

/** True when this page's response is an HTML document (lib/site.mjs owns the rule). */
export function isHtmlResponse(page) {
  return isHtmlDocument((page && page.snapshot && page.snapshot.headers) || null, page && page.html);
}

/**
 * True for pages whose body is real HTML content: 2xx (or a local file, status null) AND an HTML
 * response. A markdown, JSON or feed URL that the crawl happened to follow must not collect
 * "missing <title>" style findings — it is a machine-readable artifact, not a web page.
 */
export function isContentPage(page) {
  const s = pageStatus(page);
  if (!(s === null || (s >= 200 && s < 300))) return false;
  return isHtmlResponse(page);
}

/** Content pages only — the set every on-page check should iterate. */
export function contentPages(ctx) {
  return (ctx.pages || []).filter(isContentPage);
}

/**
 * Mutable state shared by every check in one run: the token cache and the network probe budgets.
 * runChecks() hands each page-scoped check a fresh `{...ctx, page}` object, so anything written
 * onto `ctx` itself would be thrown away between pages — this holder is created once and the copies
 * all reference the same object. `newRunState()` is what loadRunContext()/runChecks() install.
 *
 * `psi` records what the PageSpeed Insights client actually did — 'used' when it returned data,
 * 'needs_api' when it was asked and could not answer, null when it was never called. report.mjs
 * reads it (through checks.json) instead of inferring PSI provenance from a finding's
 * verification.method, which a lab-side heuristic could otherwise inflate.
 */
export const newRunState = () => ({ tokens: new Map(), og_probes: 0, psi: null });

export function runState(ctx) {
  if (!ctx._state) ctx._state = newRunState();
  return ctx._state;
}

/** Tokenize a page's raw HTML once per run (four checks need the token stream). */
export function tokensFor(ctx, page) {
  if (!page || typeof page.html !== 'string') return null;
  const state = runState(ctx);
  const key = page.slug || pageUrl(page);
  if (state.tokens.has(key)) return state.tokens.get(key);
  let toks = null;
  try { toks = tokenize(page.html); } catch { toks = null; }
  state.tokens.set(key, toks);
  return toks;
}

/** The page's effective robots directives (Google view: unscoped meta + googlebot + header). */
export function effectiveRobots(page) {
  const rd = page && page.snapshot && page.snapshot.robots_directives;
  return (rd && rd.effective) || null;
}

/** Every canonical the page declares, link tags first, then the HTTP Link header. */
export function canonicalsOf(page) {
  const out = [];
  const parsed = page && page.parsed;
  for (const c of (parsed && parsed.canonicals) || []) if (c && (c.abs || c.href)) out.push({ href: c.href, abs: c.abs || c.href, source: 'link' });
  const hl = page && page.snapshot && page.snapshot.header_links;
  if (hl && hl.canonical) out.push({ href: hl.canonical, abs: hl.canonical, source: 'header' });
  return out;
}

/** 'self' | 'other' | 'none' — where this page's canonical points. */
export function canonicalTarget(page) {
  const cans = canonicalsOf(page);
  if (!cans.length) return { kind: 'none', abs: null, source: null };
  const self = finalUrl(page);
  const other = cans.find((c) => c.abs && self && !urlsEquivalent(c.abs, self));
  if (other) return { kind: 'other', abs: other.abs, source: other.source };
  return { kind: 'self', abs: cans[0].abs, source: cans[0].source };
}

/* ----------------------------------------------------------------- text helpers */

/** Collapse whitespace and clip, so evidence stays quotable without dumping a page. */
export function clip(value, max = 240) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Render one "example" object (the small shapes the analyzers collect) as a quotable string.
 * Evidence must never ship `String({})`, so every branch here produces something a reader can act
 * on: a start tag for element examples, an anchor for link examples, `where: reason` for the
 * `{path|line, reason}` shape the validators use, and `key=value` pairs for anything else.
 */
export function describeExample(value, max = 80) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return clip(value, max);
  if (Array.isArray(value)) return clip(value.map((v) => describeExample(v, max)).join(', '), max);
  const e = value;
  if (typeof e.reason === 'string' && e.tag === undefined && e.href === undefined) {
    const where = e.path != null ? e.path : (e.line != null ? 'line ' + e.line : (e.file != null ? e.file : (e.url != null ? e.url : null)));
    return clip(where != null ? where + ': ' + e.reason : e.reason, max);
  }
  let head = null;
  if (typeof e.tag === 'string' && e.tag) {
    const attrs = [];
    if (e.href != null && e.href !== '') attrs.push('href="' + clip(e.href, 60) + '"');
    for (const [key, prop] of [['type', 'type'], ['role', 'role'], ['name', 'name_attr'], ['name', 'name'], ['id', 'id'], ['class', 'class'], ['placeholder', 'placeholder'], ['tabindex', 'tabindex']]) {
      const v = e[prop];
      if (v == null || v === '' || attrs.some((a) => a.startsWith(key + '='))) continue;
      attrs.push(key + '="' + clip(v, 40) + '"');
    }
    if (e.onclick) attrs.push('onclick');
    head = '<' + e.tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
  } else if (e.href != null && e.href !== '') {
    head = '<a href="' + clip(e.href, 60) + '">';
  }
  if (head) {
    const label = e.text || e.anchor || e.name || '';
    const why = e.reason || e.error || null;
    return clip(head + (label ? ' "' + clip(label, 40) + '"' : '') + (why ? ' (' + clip(why, 60) + ')' : ''), max);
  }
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (v == null || v === '' || typeof v === 'object' || typeof v === 'function') continue;
    parts.push(k + '=' + clip(v, 40));
  }
  if (parts.length) return clip(parts.join(' '), max);
  try { return clip(JSON.stringify(e), max); } catch { return '(unprintable)'; }
}

/**
 * "a, b, c and 4 more" — keeps evidence honest about how much was elided. Objects are rendered
 * through describeExample(), so an example array can never reach a reader as `[object Object]`.
 */
export function listing(items, max = 5) {
  const arr = (items || []).map((x) => (x && typeof x === 'object' ? describeExample(x) : String(x)));
  if (!arr.length) return '(none)';
  if (arr.length <= max) return arr.join(', ');
  return arr.slice(0, max).join(', ') + ' and ' + (arr.length - max) + ' more';
}

export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

/**
 * Subject-verb agreement for a sentence whose subject is a count: `plural(n, 'page') + ' ' +
 * agree(n, 'is', 'are')`. Evidence is read by a person; "3 sitemap URLs is noindex" undermines
 * every number beside it.
 */
export const agree = (n, one, many) => (n === 1 ? one : many);

/* ----------------------------------------------------------------- url helpers */

export { normalizeUrl, urlsEquivalent, hostKey };

/** Comparison key for "is this the same URL": lower host, no hash, no trailing slash, no tracking. */
export function urlKey(u, base) {
  const n = normalizeUrl(u, { base, stripHash: true, stripTrailingSlash: true, lowercaseHost: true, stripWww: true });
  return n || (u == null ? null : String(u));
}

/** Origin of the audited site, from the crawl manifest or the first page. */
export function originOf(ctx) {
  if (ctx.crawl && ctx.crawl.origin) return ctx.crawl.origin;
  for (const p of ctx.pages || []) {
    const u = finalUrl(p);
    try { if (u) return new URL(u).origin; } catch { /* local file */ }
  }
  return null;
}

/* ----------------------------------------------------------------- vertical / profile */

/** True when the audited site is declared (or detected) as e-commerce. */
export function isEcommerce(ctx) {
  const v = ctx.vertical;
  if (v && typeof v === 'object') {
    const all = [v.primary, ...(Array.isArray(v.also) ? v.also : [])].filter(Boolean);
    if (all.includes('ecommerce')) return true;
    if (v.primary) return false; // an explicit, non-ecommerce vertical wins over profile hints
  }
  if (typeof v === 'string') return v === 'ecommerce';
  const hints = ctx.profile && Array.isArray(ctx.profile.vertical_hints) ? ctx.profile.vertical_hints : [];
  return hints.includes('ecommerce');
}

/** True when the site is declared multilingual, or any sampled page declares hreflang. */
export function isMultilingual(ctx) {
  const v = ctx.vertical;
  if (v && typeof v === 'object' && v.multilingual === true) return true;
  for (const p of ctx.pages || []) if (hreflangEntries(p).length) return true;
  return false;
}

/** Platform id when the profile is confident enough to act on it (a `low` verdict is not). */
export function platformId(ctx) {
  const p = ctx.profile && ctx.profile.platform;
  if (!p || !p.id) return null;
  return p.confidence === 'low' ? null : p.id;
}

export function frameworkId(ctx) {
  const f = ctx.profile && ctx.profile.framework;
  if (!f || !f.id) return null;
  return f.confidence === 'low' ? null : f.id;
}

/* ----------------------------------------------------------------- hreflang */

/** hreflang entries declared by a page: <link rel=alternate> plus the HTTP Link header. */
export function hreflangEntries(page) {
  const out = [];
  const parsed = page && page.parsed;
  for (const h of (parsed && parsed.hreflang) || []) {
    if (h && h.hreflang) out.push({ hreflang: String(h.hreflang), href: h.href, abs: h.abs || h.href, source: 'html' });
  }
  const alts = page && page.snapshot && page.snapshot.header_links && page.snapshot.header_links.alternates;
  for (const a of alts || []) if (a && a.hreflang) out.push({ hreflang: String(a.hreflang), href: a.url, abs: a.url, source: 'header' });
  return out;
}

/* ----------------------------------------------------------------- JSON-LD */

/** Every valid ld+json block's data, in document order. */
export function jsonldBlocks(page) {
  const parsed = page && page.parsed;
  return ((parsed && parsed.jsonld) || []).filter((b) => b && b.ok !== false);
}

/** True when `types` contains any of `wanted` (case-sensitive schema.org names). */
export const hasType = (types, wanted) => (types || []).some((t) => wanted.includes(t));

/**
 * Numeric value of a price written in any of the shapes a page or a feed uses
 * ("49", "49.00", "$49.00", "1.299,00 €", "MXN 1,500.50"). Returns null when the string carries no
 * digits — we never guess a currency, only the amount, because that is all a comparison needs.
 */
export function numericPrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw == null ? '' : raw);
  const m = s.match(/\d[\d.,   ]*\d|\d/);
  if (!m) return null;
  let body = m[0].replace(/[\s  ]/g, '');
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // The rightmost separator is the decimal one; the other groups thousands.
    if (lastComma > lastDot) body = body.replace(/\./g, '').replace(',', '.');
    else body = body.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,500" is thousands; "49,00" is a decimal comma (exactly two trailing digits).
    body = /,\d{2}$/.test(body) ? body.replace(',', '.') : body.replace(/,/g, '');
  } else if (lastDot > -1 && /\.\d{3}$/.test(body) && body.split('.').length > 2) {
    body = body.replace(/\./g, '');
  }
  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}
