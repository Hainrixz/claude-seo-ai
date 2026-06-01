// Shared zero-dependency helpers for claude-seo-ai scripts.
// HTML parsing is intentionally lightweight (regex over the served markup) so the
// scripts run anywhere `node` exists, with no install step. For pathological
// markup, prefer the agent's own reading of the PageSnapshot — these scripts
// back the deterministic, reproducible checks (verification.reproduce).

import { readFileSync } from 'node:fs';

/** Minimal `--flag value` / `--flag` arg parser. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

/** Print a JSON result to stdout and exit. */
export function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

/** Fetch text with a short timeout; returns { ok, status, text, headers, error }. */
export async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, text: '', headers: {}, error: 'global fetch unavailable (need Node >=18)' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'claude-seo-ai/0.1 (+https://github.com/Hainrixz/claude-seo-ai)', ...headers },
    });
    const text = await res.text();
    const h = {};
    for (const [k, v] of res.headers.entries()) h[k.toLowerCase()] = v;
    return { ok: res.ok, status: res.status, text, headers: h, finalUrl: res.url, error: null };
  } catch (e) {
    return { ok: false, status: 0, text: '', headers: {}, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

/** Load HTML from --url or --file. Returns { source, html, headers, status, error }. */
export async function loadInput(args) {
  if (args.file) {
    try { return { source: 'file', html: readFileSync(args.file, 'utf8'), headers: {}, status: 200, error: null }; }
    catch (e) { return { source: 'file', html: '', headers: {}, status: 0, error: String(e && e.message || e) }; }
  }
  if (args.url) {
    const r = await fetchText(args.url);
    return { source: 'url', html: r.text, headers: r.headers, status: r.status, finalUrl: r.finalUrl, error: r.error };
  }
  return { source: 'none', html: '', headers: {}, status: 0, error: 'provide --url <u> or --file <path>' };
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
export { stripTags };

/** Decode the handful of HTML entities relevant to text fields. */
export function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

/** First match group or null. */
function firstGroup(html, re) { const m = html.match(re); return m ? m[1] : null; }

/** Extract <title>. */
export function getTitle(html) {
  const t = firstGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return t == null ? null : decodeEntities(stripTags(t));
}

/** Get the content of a <meta name="..."> (case-insensitive). */
export function getMetaName(html, name) {
  const re = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i');
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["'][^>]*>`, 'i');
  const v = firstGroup(html, re) ?? firstGroup(html, re2);
  return v == null ? null : decodeEntities(v);
}

/** Get the content of a <meta property="..."> (Open Graph). */
export function getMetaProperty(html, prop) {
  const re = new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i');
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${prop}["'][^>]*>`, 'i');
  const v = firstGroup(html, re) ?? firstGroup(html, re2);
  return v == null ? null : decodeEntities(v);
}

/** Get a <link rel="..."> href (first match). */
export function getLinkRel(html, rel) {
  const re = new RegExp(`<link[^>]*rel=["']${rel}["'][^>]*href=["']([^"']*)["'][^>]*>`, 'i');
  const re2 = new RegExp(`<link[^>]*href=["']([^"']*)["'][^>]*rel=["']${rel}["'][^>]*>`, 'i');
  return firstGroup(html, re) ?? firstGroup(html, re2);
}

/** Get <html lang="..">. */
export function getHtmlLang(html) {
  return firstGroup(html, /<html[^>]*\blang=["']([^"']*)["'][^>]*>/i);
}

/** Get declared charset. */
export function getCharset(html) {
  return firstGroup(html, /<meta[^>]*charset=["']?([\w-]+)["']?[^>]*>/i);
}

/** Collect headings as [{level, text}]. */
export function getHeadings(html) {
  const out = [];
  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ level: Number(m[1][1]), text: decodeEntities(stripTags(m[2])) });
  return out;
}

/** Collect <img> tags with src/alt/dimensions. */
export function getImages(html) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = firstGroup(tag, /\bsrc=["']([^"']*)["']/i);
    const altPresent = /\balt=/i.test(tag);
    const alt = firstGroup(tag, /\balt=["']([^"']*)["']/i);
    const width = firstGroup(tag, /\bwidth=["']?(\d+)/i);
    const height = firstGroup(tag, /\bheight=["']?(\d+)/i);
    out.push({ src, altPresent, alt: alt == null ? null : decodeEntities(alt), width, height });
  }
  return out;
}

/** Collect <a href> links as [{href, anchor}]. */
export function getLinks(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ href: m[1], anchor: decodeEntities(stripTags(m[2])) });
  return out;
}

/** Extract all JSON-LD blocks; returns [{ok, type, data, error, raw}]. */
export function getJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    try {
      const data = JSON.parse(raw);
      const types = collectTypes(data);
      out.push({ ok: true, type: types, data, error: null, raw });
    } catch (e) {
      out.push({ ok: false, type: [], data: null, error: String(e && e.message || e), raw });
    }
  }
  return out;
}

function collectTypes(node, acc = []) {
  if (Array.isArray(node)) { for (const n of node) collectTypes(n, acc); return acc; }
  if (node && typeof node === 'object') {
    if (node['@type']) {
      if (Array.isArray(node['@type'])) acc.push(...node['@type']); else acc.push(node['@type']);
    }
    if (Array.isArray(node['@graph'])) for (const n of node['@graph']) collectTypes(n, acc);
  }
  return acc;
}

/** Valid-ish BCP-47 language[-REGION] check (lenient, covers common cases + x-default). */
export function isBcp47(code) {
  if (!code) return false;
  if (code.toLowerCase() === 'x-default') return true;
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Za-z0-9]{2,8})?$/.test(code);
}
