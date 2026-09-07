// Deterministic HTTP acquisition for claude-seo-ai (zero dependencies, Node >= 18).
//
// fetchRaw() is the one place the toolkit talks HTTP: it follows redirects by hand
// (redirect: 'manual') so every hop is recorded, streams the body up to a byte cap,
// gunzips bodies that arrive as raw gzip (e.g. sitemap.xml.gz served without
// content-encoding), sniffs the charset, and never throws — failures come back as
// { ok: false, error } so callers can decide whether that is USAGE, RUNTIME or a finding.
//
// fetchText() is the legacy-shaped wrapper ({ ok, status, text, headers, finalUrl, error })
// that scripts/lib/util.mjs will delegate to; keep its shape stable.

import { createHash } from 'node:crypto';
import { gunzipSync, constants as Z } from 'node:zlib';

/**
 * User-agent presets. These mirror the strings the vendors document for their crawlers
 * (Google/Bing/OpenAI/Anthropic developer pages, mirrored 2026-09). Vendors bump the
 * version token from time to time — KEEP CURRENT and re-check the vendor page before
 * relying on a preset for a strong claim. The Chrome version token in the Googlebot and
 * Bingbot strings is the placeholder those vendors document as `W.X.Y.Z`; a recent
 * stable major is substituted so the header is syntactically normal.
 * A spoofed crawler UA is *directional* evidence only: CDNs may legitimately refuse a
 * "Googlebot" request that does not come from Google's IP ranges.
 */
export const UA_PRESETS = Object.freeze({
  default: 'Mozilla/5.0 (compatible; claude-seo-ai/0.2; +https://github.com/Hainrixz/claude-seo-ai)',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/128.0.0.0 Safari/537.36',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
  'oai-searchbot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
  'claude-searchbot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
});

export const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** Resolve { ua, uaPreset } to the literal header value. `ua` may itself be a preset name. */
export function resolveUa({ ua, uaPreset } = {}) {
  if (typeof ua === 'string' && ua.trim()) {
    const key = ua.trim().toLowerCase();
    if (UA_PRESETS[key]) return { ua: UA_PRESETS[key], preset: key };
    return { ua: ua.trim(), preset: null };
  }
  const key = String(uaPreset || 'default').toLowerCase();
  if (UA_PRESETS[key]) return { ua: UA_PRESETS[key], preset: key };
  return { ua: UA_PRESETS.default, preset: 'default' };
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const ms = (a, b) => Math.max(0, Math.round(b - a));
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/**
 * Parse an HTTP Link header into [{ url, rel, hreflang, params }].
 * `Link: <https://x/a>; rel="canonical", <https://x/es>; rel="alternate"; hreflang="es"`.
 */
export function parseLinkHeader(value, base) {
  const out = [];
  if (!value) return out;
  const list = Array.isArray(value) ? value : [String(value)];
  for (const raw of list) {
    // split on commas that are followed by a `<`, so commas inside quoted params survive
    for (const part of String(raw).split(/,\s*(?=<)/)) {
      const m = part.match(/^\s*<([^>]*)>\s*(.*)$/);
      if (!m) continue;
      let url = m[1].trim();
      if (base) { try { url = new URL(url, base).href; } catch { /* keep raw */ } }
      const params = {};
      for (const p of m[2].split(';')) {
        const kv = p.match(/^\s*([A-Za-z0-9*_-]+)\s*=\s*"?([^"]*)"?\s*$/);
        if (kv) params[kv[1].toLowerCase()] = kv[2].trim();
      }
      out.push({ url, rel: params.rel ? params.rel.toLowerCase() : null, hreflang: params.hreflang || null, params });
    }
  }
  return out;
}

function lowerHeaders(res) {
  const headers = {};
  const cookieNames = [];
  for (const [k, v] of res.headers) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') continue;
    headers[key] = Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] + ', ' + v : v;
  }
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') cookies = res.headers.getSetCookie();
  else { const sc = res.headers.get('set-cookie'); if (sc) cookies = sc.split(/,\s*(?=[^;,=\s]+=)/); }
  for (const c of cookies) { const name = String(c).split(';')[0].split('=')[0].trim(); if (name) cookieNames.push(name); }
  headers.cookie_names = cookieNames; // cookie values are never recorded
  return headers;
}

function charsetFromContentType(ct) {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(ct || '');
  return m ? m[1].toLowerCase() : null;
}

function sniffCharset(buf) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

/**
 * index-windows-1252 from the WHATWG Encoding Standard: the code points for bytes 0x80–0x9F.
 * Every other byte maps to the code point of the same value (verified against a correct
 * TextDecoder for all 256 bytes).
 */
const WINDOWS_1252_HIGH =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' + // 0x80-0x8F
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';   // 0x90-0x9F

/** Every label the Encoding Standard maps to windows-1252 (iso-8859-1 and us-ascii included). */
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100',
  'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252',
  'x-cp1252',
]);

/**
 * Decode bytes as windows-1252 using the spec table, with no dependency on the runtime's ICU.
 * Node 20 resolves every windows-1252 label to a plain latin1 table (0x93 decodes to U+0093
 * instead of “), so the same bytes read differently there than on 18/22/24. This module promises
 * deterministic acquisition, so the most common legacy web encoding is decoded from the table.
 */
export function decodeWindows1252(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let out = '';
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80 || b > 0x9f) continue;
    if (i > start) out += bytes.toString('latin1', start, i); // latin1 is byte-identity here
    out += WINDOWS_1252_HIGH[b - 0x80];
    start = i + 1;
  }
  return start === 0 ? bytes.toString('latin1') : start < bytes.length ? out + bytes.toString('latin1', start) : out;
}

const normalizeLabel = (label) => String(label == null ? '' : label).trim().toLowerCase().replace(/^["']|["']$/g, '');

/** True when `label` names windows-1252 (or one of the labels the Encoding Standard folds into it). */
export function isWindows1252Label(label) { return WINDOWS_1252_LABELS.has(normalizeLabel(label)); }

/**
 * Decode a body under a declared/sniffed charset.
 * @returns {{text, charset, fallback, decodedWith}} `decodedWith` is 'builtin-windows-1252' or
 *   'text-decoder', recorded on the result as `body.charset_decoded_with` so a surprising
 *   transliteration can be traced to who did it.
 */
function decodeBody(buf, charset) {
  const label = normalizeLabel(charset);
  if (label && WINDOWS_1252_LABELS.has(label)) {
    return { text: decodeWindows1252(buf), charset, fallback: false, decodedWith: 'builtin-windows-1252' };
  }
  const tryDecode = (l) => { try { return new TextDecoder(l).decode(buf); } catch { return null; } };
  if (label) { const t = tryDecode(label); if (t != null) return { text: t, charset, fallback: false, decodedWith: 'text-decoder' }; }
  return { text: tryDecode('utf-8') ?? buf.toString('utf8'), charset: 'utf-8', fallback: !!charset, decodedWith: 'text-decoder' };
}

async function readBody(res, maxBytes) {
  const chunks = [];
  let total = 0, truncated = false;
  if (!res.body) return { buf: Buffer.alloc(0), truncated };
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      if (total + value.length > maxBytes) {
        chunks.push(Buffer.from(value.subarray(0, Math.max(0, maxBytes - total))));
        total = maxBytes; truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(Buffer.from(value)); total += value.length;
    }
  } catch (e) {
    // a mid-body network error yields what we have, flagged as truncated
    truncated = true;
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

/** One HTTP request with per-attempt timeout; retries on network error / 5xx (never on 4xx). */
async function attemptFetch(url, init, { timeoutMs, retries }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs);
    const t0 = now();
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.status >= 500 && attempt < retries) {
        clearTimeout(timer);
        try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { res, timer, t0, attempts: attempt + 1, error: null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
    }
  }
  const cause = lastErr && lastErr.cause && lastErr.cause.message;
  const message = String(lastErr && lastErr.message || lastErr || 'fetch failed');
  return { res: null, timer: null, t0: 0, attempts: retries + 1, error: cause ? message + ': ' + cause : message };
}

function hostNoWww(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }

/** Describe how `last` differs from `first` after a redirect chain (exported for tests). */
export function redirectFlags(first, last, hops = 0, loop = false, truncated = false) {
  const flags = { hops, loop, truncated, http_to_https: false, host_changed: false, www_normalized: false, trailing_slash_changed: false };
  let a, b;
  try { a = new URL(first); b = new URL(last); } catch { return flags; }
  flags.http_to_https = a.protocol === 'http:' && b.protocol === 'https:';
  flags.www_normalized = a.hostname.toLowerCase() !== b.hostname.toLowerCase() && hostNoWww(a.hostname) === hostNoWww(b.hostname);
  flags.host_changed = hostNoWww(a.hostname) !== hostNoWww(b.hostname);
  const pa = a.pathname, pb = b.pathname;
  flags.trailing_slash_changed = pa !== pb && pa.replace(/\/+$/, '') === pb.replace(/\/+$/, '');
  return flags;
}

function emptyBody() {
  return { text: '', bytes: 0, truncated: false, charset: null, charset_decoded_with: null, sha256: null, content_encoding: null, gunzipped: false };
}

/**
 * Fetch a URL with a fully recorded redirect chain.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.ua]             literal UA string or preset name (see UA_PRESETS)
 * @param {string} [opts.uaPreset]       preset name when `ua` is absent (default 'default')
 * @param {string} [opts.acceptLanguage]
 * @param {number} [opts.timeoutMs=20000]   per request attempt
 * @param {number} [opts.maxHops=10]        redirects followed before `redirects.truncated`
 * @param {number} [opts.maxBytes=5000000]  body byte cap (`body.truncated` when hit)
 * @param {number} [opts.retries=1]         retries on network error / 5xx, 500ms×n backoff; never on 4xx
 * @param {boolean} [opts.follow=true]      false → return the first response even if 3xx
 * @param {object} [opts.headers]           extra request headers (override defaults)
 * @param {string} [opts.method='GET']
 * @param {boolean} [opts.returnBuffer]     also return `body.buffer` (Buffer) for binary consumers
 * @returns {Promise<object>} never throws; see module header for the shape
 */
export async function fetchRaw(url, opts = {}) {
  const {
    acceptLanguage = DEFAULT_ACCEPT_LANGUAGE, accept = DEFAULT_ACCEPT, timeoutMs = 20000, maxHops = 10,
    maxBytes = 5_000_000, retries = 1, follow = true, headers = {}, method = 'GET', returnBuffer = false,
  } = opts;
  const { ua, preset } = resolveUa(opts);
  const base = {
    url, ua, ua_preset: preset, ok: false, status: 0, final_url: url, status_chain: [],
    redirects: redirectFlags(url, url, 0, false, false), headers: {}, body: emptyBody(),
    timing: { ttfb_ms: null, download_ms: null, total_ms: null }, attempts: 0, error: null,
  };
  if (typeof fetch !== 'function') return { ...base, error: 'global fetch unavailable (need Node >= 18)' };
  let current;
  try { current = new URL(url).href; } catch { return { ...base, error: 'invalid URL: ' + url }; }
  if (!/^https?:$/.test(new URL(current).protocol)) return { ...base, error: 'unsupported protocol (need http or https): ' + url };

  const reqHeaders = { 'user-agent': ua, accept, 'accept-language': acceptLanguage, ...lowerKeys(headers) };
  const init = { method, redirect: 'manual', headers: reqHeaders };
  const tStart = now();
  const chain = [];
  const visited = new Set([current]);
  let loop = false, truncated = false, attempts = 0;

  for (;;) {
    const a = await attemptFetch(current, init, { timeoutMs, retries });
    attempts += a.attempts;
    if (!a.res) {
      return {
        ...base, final_url: current, status_chain: chain, attempts, error: a.error,
        redirects: redirectFlags(url, current, chain.length, loop, truncated), timing: { ttfb_ms: null, download_ms: null, total_ms: ms(tStart, now()) },
      };
    }
    const { res, timer, t0 } = a;
    const tHeaders = now();
    const location = res.headers.get('location');
    const isRedirect = res.status >= 300 && res.status < 400 && !!location;
    if (isRedirect && follow) {
      chain.push({ url: current, status: res.status, location, ms: ms(t0, tHeaders) });
      clearTimeout(timer);
      try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
      let next;
      try { next = new URL(location, current).href; } catch {
        return finish({ ...base, status: res.status, final_url: current, status_chain: chain, headers: lowerHeaders(res), attempts,
          error: 'unresolvable Location header: ' + location }, url, current, chain, loop, truncated, tStart, tHeaders, tHeaders);
      }
      if (visited.has(next)) {
        loop = true;
        return finish({ ...base, status: res.status, final_url: next, status_chain: chain, headers: lowerHeaders(res), attempts, error: 'redirect loop' },
          url, next, chain, loop, truncated, tStart, tHeaders, tHeaders);
      }
      if (chain.length >= maxHops) {
        truncated = true;
        return finish({ ...base, status: res.status, final_url: next, status_chain: chain, headers: lowerHeaders(res), attempts, error: 'too many redirects (> ' + maxHops + ')' },
          url, next, chain, loop, truncated, tStart, tHeaders, tHeaders);
      }
      visited.add(next);
      current = next;
      continue;
    }

    // Final response: stream the body under the byte cap.
    const { buf: rawBuf, truncated: bodyTruncated } = await readBody(res, maxBytes);
    clearTimeout(timer);
    const tBody = now();
    let buf = rawBuf, gunzipped = false, gzError = null;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try { buf = gunzipSync(buf, { finishFlush: Z.Z_SYNC_FLUSH }); gunzipped = true; }
      catch (e) { gzError = String(e && e.message || e); }
    }
    const hdrs = lowerHeaders(res);
    const declared = charsetFromContentType(hdrs['content-type']);
    const sniffed = declared ? null : sniffCharset(buf);
    const dec = decodeBody(buf, declared || sniffed);
    const body = {
      text: dec.text, bytes: buf.length, truncated: bodyTruncated, charset: dec.charset, charset_source: declared ? 'header' : sniffed ? 'meta' : 'fallback',
      charset_decoded_with: dec.decodedWith,
      sha256: createHash('sha256').update(buf).digest('hex'), content_encoding: hdrs['content-encoding'] || null, gunzipped,
    };
    if (dec.fallback) body.charset_fallback = true;
    if (gzError) body.gunzip_error = gzError;
    if (returnBuffer) body.buffer = buf;
    chain.push({ url: current, status: res.status, location: null, ms: ms(t0, tHeaders) });
    return {
      ...base, ok: res.status >= 200 && res.status < 300, status: res.status, final_url: current, status_chain: chain,
      redirects: redirectFlags(url, current, chain.length - 1, loop, truncated), headers: hdrs, body,
      timing: { ttfb_ms: ms(t0, tHeaders), download_ms: ms(tHeaders, tBody), total_ms: ms(tStart, tBody) }, attempts, error: null,
    };
  }
}

function finish(result, first, last, chain, loop, truncated, tStart, tHeaders, tEnd) {
  result.redirects = redirectFlags(first, last, chain.length, loop, truncated);
  result.timing = { ttfb_ms: null, download_ms: null, total_ms: ms(tStart, tEnd || tHeaders) };
  return result;
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v != null) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * Legacy-shaped wrapper: { ok, status, text, headers, finalUrl, error }.
 * Redirects are followed (recorded in `chain` for callers that want it).
 */
export async function fetchText(url, opts = {}) {
  const { timeoutMs = 15000, headers = {}, ...rest } = opts;
  const r = await fetchRaw(url, { timeoutMs, headers, ...rest, follow: true });
  return { ok: r.ok, status: r.status, text: r.body.text, headers: r.headers, finalUrl: r.final_url, error: r.error, chain: r.status_chain };
}
