// URL normalization and same-site tests shared by the crawl, link-graph and hreflang code.

export const DEFAULT_TRACKING = Object.freeze(['utm_*', 'fbclid', 'gclid', 'gclsrc', 'dclid', 'mc_cid', 'mc_eid', 'msclkid', 'yclid', '_ga', '_gl', 'ref_src', 'igshid']);

function trackingMatcher(list) {
  const exact = new Set(), prefixes = [];
  for (const t of list || []) {
    const s = String(t).toLowerCase();
    if (s.endsWith('*')) prefixes.push(s.slice(0, -1)); else exact.add(s);
  }
  return (name) => { const n = String(name).toLowerCase(); return exact.has(n) || prefixes.some((p) => n.startsWith(p)); };
}

/** Lower-cased hostname without a leading `www.` — the key two URLs share when they are the same site. */
export function hostKey(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(u || '').toLowerCase().replace(/^www\./, ''); }
}

/**
 * Normalize a URL for de-duplication and graph keys. Returns a string, or null when unparsable.
 * @param {string} u
 * @param {object} [opts]
 * @param {string} [opts.base]                 resolve relative URLs against this
 * @param {boolean} [opts.stripHash=true]
 * @param {string[]|false} [opts.stripTracking=DEFAULT_TRACKING]  query keys to drop (`utm_*` prefix form allowed)
 * @param {boolean} [opts.sortQuery=true]
 * @param {boolean} [opts.lowercaseHost=true]
 * @param {boolean} [opts.stripWww=false]
 * @param {boolean} [opts.stripTrailingSlash=false]  drop a trailing slash on non-root paths
 * @param {boolean} [opts.dropDefaultPort=true]
 * @param {boolean} [opts.dropIndex=false]     strip a trailing /index.html|htm|php
 */
export function normalizeUrl(u, opts = {}) {
  const {
    base, stripHash = true, stripTracking = DEFAULT_TRACKING, sortQuery = true, lowercaseHost = true, stripWww = false,
    stripTrailingSlash = false, dropDefaultPort = true, dropIndex = false,
  } = opts;
  let url;
  try { url = new URL(String(u).trim(), base); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (lowercaseHost) url.hostname = url.hostname.toLowerCase();
  if (stripWww) url.hostname = url.hostname.replace(/^www\./, '');
  if (dropDefaultPort && ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) url.port = '';
  if (stripHash) url.hash = '';
  if (stripTracking) {
    const isTracking = trackingMatcher(stripTracking);
    const keep = [];
    for (const [k, v] of url.searchParams) if (!isTracking(k)) keep.push([k, v]);
    if (sortQuery) keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    url.search = keep.length ? '?' + new URLSearchParams(keep).toString() : '';
  } else if (sortQuery && url.search) {
    const pairs = [...url.searchParams].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    url.search = pairs.length ? '?' + new URLSearchParams(pairs).toString() : '';
  }
  if (dropIndex) url.pathname = url.pathname.replace(/\/index\.(html?|php)$/i, '/');
  if (stripTrailingSlash && url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

/** Same site = same registrable host ignoring a leading `www.` (case-insensitive). Protocol and port are ignored. */
export function sameSite(a, b) {
  const ha = hostKey(a), hb = hostKey(b);
  return !!ha && ha === hb;
}

/** Is `href` (relative or absolute) an http(s) link to the same site as `base`? Non-http schemes are never internal. */
export function isInternal(href, base) {
  let abs;
  try { abs = new URL(String(href).trim(), base); } catch { return false; }
  if (!/^https?:$/.test(abs.protocol)) return false;
  return sameSite(abs.href, base);
}

/** Two URLs are equivalent when they normalize to the same string modulo trailing slash and fragment. */
export function urlsEquivalent(a, b, base) {
  const na = normalizeUrl(a, { base, stripTrailingSlash: true, stripTracking: false });
  const nb = normalizeUrl(b, { base, stripTrailingSlash: true, stripTracking: false });
  if (na == null || nb == null) return String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '');
  return na === nb;
}

/**
 * Classify an href before it is counted as a link: 'http' (crawlable), 'fragment' (same-page `#x`),
 * 'mailto' | 'tel' | 'javascript' | 'data' | 'other' (non-http scheme) or 'invalid'.
 */
export function linkKind(href) {
  const s = String(href == null ? '' : href).trim();
  if (!s) return 'invalid';
  if (s[0] === '#') return 'fragment';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme) {
    const p = scheme[1].toLowerCase();
    if (p === 'http' || p === 'https') return 'http';
    if (p === 'mailto' || p === 'tel' || p === 'javascript' || p === 'data') return p;
    return 'other';
  }
  return 'http'; // relative reference
}
