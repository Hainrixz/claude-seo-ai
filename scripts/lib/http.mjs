// Tiny JSON-over-HTTP client for the write adapters (zero dependencies, Node >= 18 global fetch).
//
// Why not lib/fetch.mjs: that module is the *crawler* — redirect chains, byte caps, charset
// sniffing, crawler user agents. This one talks to management APIs: one request, JSON in and out,
// bounded retries on the statuses vendors document as retryable, and a normalized error shape so an
// adapter can put a failure in a manifest instead of throwing a stack trace at the user.
//
// Guarantees:
//   * never throws for an HTTP status — a 4xx/5xx comes back as { ok: false, status, error }
//   * `fetchImpl` is injectable, and CLAUDE_SEO_AI_OFFLINE=1 makes a *real* network call throw, so a
//     test that forgets its mock fails loudly instead of hitting a live store
//   * nothing here prints; `describeRequest()` builds the redacted one-liner a log or preview shows

import { redact, redactObject } from './credentials.mjs';

export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RETRIES = 2;
/** Statuses worth retrying: rate limits and transient gateway failures. 4xx otherwise is a real answer. */
export const RETRY_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
const RETRY_SET = new Set(RETRY_STATUSES);
/** Base backoff; attempt n waits BASE * 2^(n-1), capped, unless the response carries Retry-After. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8000;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when this process must not open a real socket (tests, CI dry runs). */
export function isOffline(env = process.env) {
  const v = env && env.CLAUDE_SEO_AI_OFFLINE;
  return typeof v === 'string' ? v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false' : !!v;
}

/** Pick the fetch implementation: injected first, then global. Throws under CLAUDE_SEO_AI_OFFLINE. */
export function resolveFetch(fetchImpl, env = process.env) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (isOffline(env)) {
    const err = new Error('CLAUDE_SEO_AI_OFFLINE is set: refusing a real network request (inject fetchImpl)');
    err.code = 'OFFLINE';
    throw err;
  }
  if (typeof globalThis.fetch !== 'function') {
    const err = new Error('global fetch is unavailable (Node >= 18 required, or pass fetchImpl)');
    err.code = 'NO_FETCH';
    throw err;
  }
  return globalThis.fetch;
}

/** Headers (a Headers instance, an array of pairs or a plain object) as a lower-cased plain object. */
export function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    return out;
  }
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * One normalized error shape for every failure mode.
 * type: 'http' (a status we treat as a failure) · 'timeout' · 'network' · 'parse' · 'offline' · 'usage'
 */
export function normalizeError(e, { status = null, body = null, url = null } = {}) {
  if (e && typeof e === 'object' && e.__normalized) return e;
  const raw = e && (e.message || e.name) ? String(e.message || e.name) : String(e || 'unknown error');
  let type = 'network';
  if (e && (e.code === 'OFFLINE' || e.code === 'NO_FETCH')) type = 'offline';
  else if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || /timed? ?out/i.test(raw))) type = 'timeout';
  else if (e && e.name === 'SyntaxError') type = 'parse';
  else if (e && e.code === 'USAGE') type = 'usage';
  const out = { __normalized: true, type, message: redact(raw), status, retriable: type === 'timeout' || type === 'network' };
  if (url) out.url = redact(String(url));
  if (body != null) out.body = typeof body === 'string' ? redact(body).slice(0, 2000) : redactObject(body);
  return out;
}

/** Error object for an HTTP status the caller treats as a failure. */
export function httpError(status, { statusText = '', body = null, url = null, headers = null } = {}) {
  const out = {
    __normalized: true, type: 'http', status,
    message: 'HTTP ' + status + (statusText ? ' ' + statusText : ''),
    retriable: RETRY_SET.has(status),
  };
  if (url) out.url = redact(String(url));
  if (body != null) out.body = typeof body === 'string' ? redact(body).slice(0, 2000) : redactObject(body);
  if (headers && headers['retry-after']) out.retry_after = headers['retry-after'];
  return out;
}

/** Retry-After as milliseconds (delta-seconds or HTTP-date), or null when absent/unparsable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, 120000);
  const when = Date.parse(s);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - now, 120000));
  return null;
}

/** Exponential backoff for attempt `n` (1-based), honouring Retry-After when the server sent one. */
export function backoffMs(attempt, retryAfter = null) {
  if (Number.isFinite(retryAfter) && retryAfter !== null) return retryAfter;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)), BACKOFF_MAX_MS);
}

/** Append query parameters to a URL without disturbing the ones already there. */
export function withQuery(url, query) {
  if (!query || typeof query !== 'object') return String(url);
  const u = new URL(String(url));
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
    else u.searchParams.set(k, String(v));
  }
  return u.href;
}

/**
 * A printable, redacted description of a request — this is what goes in a preview or the audit log.
 * Header values are replaced by their names only: an Authorization header has no safe prefix.
 */
export function describeRequest({ method = 'GET', url = '', headers = {}, body = null } = {}, { env = process.env } = {}) {
  const names = Object.keys(headersToObject(headers)).sort();
  let line = String(method).toUpperCase() + ' ' + redact(String(url), { env });
  if (names.length) line += '  headers: ' + names.join(', ') + ' (values withheld)';
  if (body !== null && body !== undefined) {
    const rendered = typeof body === 'string' ? body : JSON.stringify(redactObject(body, { env }));
    line += '\nbody: ' + redact(rendered, { env }).slice(0, 4000);
  }
  return line;
}

function parseBody(text, contentType) {
  if (text === '' || text === undefined || text === null) return { json: null, parse_error: null };
  const ct = String(contentType || '').toLowerCase();
  const looksJson = ct.includes('json') || /^[\s\r\n]*[[{]/.test(text);
  if (!looksJson) return { json: null, parse_error: null };
  try { return { json: JSON.parse(text), parse_error: null }; }
  catch (e) { return { json: null, parse_error: String(e && e.message || e) }; }
}

/**
 * Perform one JSON request with bounded retries.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]        extra headers (Accept/Content-Type are filled in)
 * @param {object|string} [opts.body]    an object is JSON-encoded; a string is sent verbatim
 * @param {Function} [opts.fetchImpl]    injectable fetch (tests, offline runs)
 * @param {number} [opts.timeoutMs=20000] per attempt
 * @param {number} [opts.retries=2]      extra attempts on 408/425/429/5xx and network/timeout errors
 * @param {number[]} [opts.retryStatuses]
 * @param {Function} [opts.sleep]        injectable delay (tests)
 * @param {object} [opts.query]          query parameters merged into the URL
 * @param {boolean} [opts.okStatuses]    statuses treated as success (default: 2xx)
 * @returns {Promise<{ok, status, headers, json, text, url, method, attempts, error}>} — never throws
 *          for an HTTP status; throws only when the caller asked for a real fetch while offline.
 */
export async function jsonRequest(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body = null, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES, retryStatuses = RETRY_STATUSES, sleep = sleepDefault,
    query = null, okStatuses = null, env = process.env, signal = null, now = Date.now,
  } = opts;

  const target = withQuery(url, query);
  const doFetch = resolveFetch(fetchImpl, env);
  const retrySet = new Set(retryStatuses);
  const upperMethod = String(method).toUpperCase();

  const sendHeaders = { accept: 'application/json', ...headersToObject(headers) };
  let payload;
  if (body === null || body === undefined) payload = undefined;
  else if (typeof body === 'string') payload = body;
  else { payload = JSON.stringify(body); if (!sendHeaders['content-type']) sendHeaders['content-type'] = 'application/json'; }

  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && Number(timeoutMs) > 0 ? setTimeout(() => controller.abort(), Number(timeoutMs)) : null;
    if (signal && controller && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let res;
    try {
      res = await doFetch(target, {
        method: upperMethod, headers: sendHeaders, body: payload,
        signal: controller ? controller.signal : undefined, redirect: 'follow',
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastError = normalizeError(e, { url: target });
      if (lastError.type === 'offline') throw e;
      if (attempt < maxAttempts && lastError.retriable) { await sleep(backoffMs(attempt)); continue; }
      return { ok: false, status: 0, headers: {}, json: null, text: '', url: target, method: upperMethod, attempts: attempt, error: lastError };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = Number(res && res.status) || 0;
    const resHeaders = headersToObject(res && res.headers);
    let text = '';
    try { text = res && typeof res.text === 'function' ? await res.text() : ''; }
    catch (e) { text = ''; lastError = normalizeError(e, { status, url: target }); }
    const { json, parse_error } = parseBody(text, resHeaders['content-type']);

    const ok = Array.isArray(okStatuses) ? okStatuses.includes(status) : status >= 200 && status < 300;
    if (!ok && retrySet.has(status) && attempt < maxAttempts) {
      await sleep(backoffMs(attempt, retryAfterMs(resHeaders['retry-after'], typeof now === 'function' ? now() : Date.now())));
      continue;
    }

    const out = {
      ok, status, headers: resHeaders, json, text, url: target, method: upperMethod,
      attempts: attempt, error: null,
    };
    if (!ok) out.error = httpError(status, { statusText: res && res.statusText, body: json || text, url: target, headers: resHeaders });
    else if (parse_error) out.error = normalizeError(Object.assign(new SyntaxError(parse_error), { name: 'SyntaxError' }), { status, url: target });
    return out;
  }
  return { ok: false, status: 0, headers: {}, json: null, text: '', url: target, method: upperMethod, attempts: maxAttempts, error: lastError || normalizeError(new Error('request failed'), { url: target }) };
}

/** GET helper. */
export function getJson(url, opts = {}) { return jsonRequest(url, { ...opts, method: 'GET' }); }
/** POST helper. */
export function postJson(url, body, opts = {}) { return jsonRequest(url, { ...opts, method: 'POST', body }); }

/**
 * Bundle the injectable pieces an adapter's ctx.http needs.
 * Usage: `const http = makeHttp({ fetchImpl, env });  await http.json(url, { method: 'PUT', body })`
 */
export function makeHttp({ fetchImpl = undefined, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, sleep = sleepDefault } = {}) {
  const base = { fetchImpl, env, timeoutMs, retries, sleep };
  return {
    json: (url, opts = {}) => jsonRequest(url, { ...base, ...opts }),
    get: (url, opts = {}) => jsonRequest(url, { ...base, ...opts, method: 'GET' }),
    post: (url, body, opts = {}) => jsonRequest(url, { ...base, ...opts, method: 'POST', body }),
    describe: (req) => describeRequest(req, { env }),
    offline: isOffline(env),
  };
}

/** Basic-auth header value for user/password credentials (WordPress application passwords). */
export function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(String(user) + ':' + String(password), 'utf8').toString('base64');
}
