// hreflang collection (HTML <link rel=alternate hreflang> ∪ HTTP Link header) and reciprocity checks.

import { parseLinkHeader } from './fetch.mjs';
import { urlsEquivalent } from './urlnorm.mjs';

/** Extract [{ hreflang, href }] from <link rel="alternate" hreflang=".." href=".."> tags (attribute order agnostic). */
export function extractHreflang(html) {
  const out = [];
  if (!html) return out;
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
    const hreflang = (tag.match(/\bhreflang\s*=\s*["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (hreflang && href) out.push({ hreflang: hreflang.trim(), href: href.trim() });
  }
  return out;
}

function resolve(href, base) {
  if (!base) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

/**
 * Merge HTML hreflang links with `Link:` header alternates.
 * @param {string|{html?:string, raw_html?:string, headers?:object}|Array} input  HTML text, a snapshot-like object, or pre-extracted entries
 * @param {object} [headers]  lower-cased response headers (used for the Link header)
 * @param {string} [base]     the page URL, used to resolve relative hrefs into `abs`
 * @returns {Array<{hreflang:string, href:string, abs:string|null, source:'html'|'header'}>}
 */
export function collectHreflang(input, headers = {}, base = null) {
  let html = '';
  let hdrs = headers || {};
  let pre = null;
  if (typeof input === 'string') html = input;
  else if (Array.isArray(input)) pre = input;
  else if (input && typeof input === 'object') {
    html = input.html || input.raw_html || '';
    hdrs = { ...(input.headers || {}), ...hdrs };
  }
  const out = [];
  const seen = new Set();
  const add = (hreflang, href, source) => {
    const abs = resolve(href, base);
    const key = hreflang.toLowerCase() + '|' + (abs || href);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hreflang, href, abs, source });
  };
  for (const e of pre || extractHreflang(html)) add(e.hreflang, e.href, e.source || 'html');
  const link = hdrs.link != null ? hdrs.link : hdrs.Link;
  for (const l of parseLinkHeader(link, base)) {
    if (!l.rel || !l.rel.split(/\s+/).includes('alternate') || !l.hreflang) continue;
    add(l.hreflang, l.url, 'header');
  }
  return out;
}

/** Canonical URL from a `Link: <...>; rel="canonical"` header, resolved against `base`, or null. */
export function headerCanonical(headers = {}, base = null) {
  const link = headers && (headers.link != null ? headers.link : headers.Link);
  const hit = parseLinkHeader(link, base).find((l) => l.rel && l.rel.split(/\s+/).includes('canonical'));
  return hit ? hit.url : null;
}

/**
 * Fetch each alternate (x-default skipped) and check that it links back to `self`.
 * `fetchImpl(url)` resolves to a fetchRaw- or fetchText-shaped result.
 * @returns {Promise<{reciprocity:Array<{href,reachable,reciprocal,status,final_url}>, non_reciprocal:string[], checked:number, skipped:number}>}
 */
export async function checkReciprocity(entries, fetchImpl, { budget = 25, self = null } = {}) {
  const reciprocity = [];
  const todo = (entries || []).filter((e) => String(e.hreflang).toLowerCase() !== 'x-default');
  const slice = todo.slice(0, Math.max(0, budget));
  for (const e of slice) {
    const target = e.abs || e.href;
    let r;
    try { r = await fetchImpl(target); } catch (err) { r = { ok: false, status: 0, error: String(err && err.message || err) }; }
    const status = r ? r.status : 0;
    if (!r || !r.ok) { reciprocity.push({ href: e.href, reachable: false, reciprocal: null, status, final_url: (r && (r.final_url || r.finalUrl)) || null }); continue; }
    const text = r.body && typeof r.body.text === 'string' ? r.body.text : (r.text || '');
    const finalUrl = r.final_url || r.finalUrl || target;
    const back = collectHreflang(text, r.headers || {}, finalUrl);
    const reciprocal = self ? back.some((b) => urlsEquivalent(b.abs || b.href, self)) : null;
    reciprocity.push({ href: e.href, reachable: true, reciprocal, status, final_url: finalUrl });
  }
  return {
    reciprocity,
    non_reciprocal: reciprocity.filter((x) => x.reachable && x.reciprocal === false).map((x) => x.href),
    checked: slice.length,
    skipped: todo.length - slice.length,
  };
}
