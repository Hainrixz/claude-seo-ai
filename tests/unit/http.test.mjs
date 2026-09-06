// Unit tests for scripts/lib/http.mjs — retries, error normalization, offline guard, no secret leaks.
// Every request goes through an injected fetchImpl; nothing here opens a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'http.mjs')).href);

/** Minimal Response stand-in. */
function res(status, body, headers = {}) {
  return {
    status,
    statusText: status === 200 ? 'OK' : '',
    headers: new Map(Object.entries(headers)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
// Map has .forEach(value, key) like Headers, which headersToObject relies on.

function scripted(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

const noSleep = async () => {};

test('a 2xx JSON response comes back parsed, with lower-cased headers', async () => {
  const { impl, calls } = scripted([res(200, { ok: true, id: 12 }, { 'Content-Type': 'application/json', 'X-Request-Id': 'abc' })]);
  const out = await H.jsonRequest('https://api.example/v1/pages', { fetchImpl: impl, sleep: noSleep });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, id: 12 });
  assert.equal(out.headers['x-request-id'], 'abc');
  assert.equal(out.attempts, 1);
  assert.equal(out.error, null);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.accept, 'application/json');
});

test('an object body is JSON-encoded and gets a content-type', async () => {
  const { impl, calls } = scripted([res(200, {})]);
  await H.jsonRequest('https://api.example/x', { method: 'PUT', body: { seo: { title: 'Rain shadow' } }, fetchImpl: impl, sleep: noSleep });
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, '{"seo":{"title":"Rain shadow"}}');
});

test('429 is retried up to the limit, then returned as a normalized error', async () => {
  const waits = [];
  const { impl, calls } = scripted([res(429, { message: 'slow down' }, { 'Retry-After': '2' })]);
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: impl, retries: 2, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(calls.length, 3, 'one attempt plus two retries');
  assert.deepEqual(waits, [2000, 2000], 'Retry-After wins over exponential backoff');
  assert.equal(out.ok, false);
  assert.equal(out.status, 429);
  assert.equal(out.error.type, 'http');
  assert.equal(out.error.retriable, true);
  assert.deepEqual(out.error.body, { message: 'slow down' });
});

test('a 5xx that recovers on retry succeeds', async () => {
  const responses = [res(503, 'busy'), res(200, { ok: true })];
  let n = 0;
  const impl = async () => responses[n++];
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: impl, retries: 1, sleep: noSleep });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('4xx is never retried — it is a real answer', async () => {
  const { impl, calls } = scripted([res(404, { errors: ['not found'] })]);
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: impl, retries: 3, sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 404);
  assert.equal(out.error.retriable, false);
});

test('a network error is retried, then normalized (never thrown)', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: impl, retries: 1, sleep: noSleep });
  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.equal(out.error.type, 'network');
  assert.equal(out.attempts, 2);
});

test('an abort is reported as a timeout', async () => {
  const impl = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: impl, retries: 0, sleep: noSleep });
  assert.equal(out.error.type, 'timeout');
});

test('CLAUDE_SEO_AI_OFFLINE makes a real request throw instead of hitting the network', async () => {
  assert.equal(H.isOffline({ CLAUDE_SEO_AI_OFFLINE: '1' }), true);
  assert.equal(H.isOffline({ CLAUDE_SEO_AI_OFFLINE: '0' }), false);
  assert.equal(H.isOffline({}), false);
  await assert.rejects(() => H.jsonRequest('https://api.example/x', { env: { CLAUDE_SEO_AI_OFFLINE: '1' } }), /refusing a real network request/);
  // an injected impl is always allowed, offline or not
  const out = await H.jsonRequest('https://api.example/x', { env: { CLAUDE_SEO_AI_OFFLINE: '1' }, fetchImpl: async () => res(200, { ok: true }), sleep: noSleep });
  assert.equal(out.ok, true);
});

test('retryAfterMs understands seconds and HTTP dates, and caps absurd values', () => {
  assert.equal(H.retryAfterMs('3'), 3000);
  assert.equal(H.retryAfterMs('99999'), 120000);
  assert.equal(H.retryAfterMs(''), null);
  assert.equal(H.retryAfterMs('nonsense'), null);
  const now = Date.parse('2026-09-06T10:00:00Z');
  assert.equal(H.retryAfterMs('Sun, 06 Sep 2026 10:00:05 GMT', now), 5000);
});

test('backoff doubles and stays under the cap', () => {
  assert.equal(H.backoffMs(1), 500);
  assert.equal(H.backoffMs(2), 1000);
  assert.equal(H.backoffMs(9), H.BACKOFF_MAX_MS);
  assert.equal(H.backoffMs(1, 7000), 7000);
});

test('withQuery adds parameters without dropping the ones already there', () => {
  assert.equal(H.withQuery('https://api.example/x?a=1', { b: 2 }), 'https://api.example/x?a=1&b=2');
  assert.equal(H.withQuery('https://api.example/x', { list: ['a', 'b'], skip: null }), 'https://api.example/x?list=a&list=b');
});

test('describeRequest shows header names only and redacts known secrets', () => {
  const line = H.describeRequest({
    method: 'put', url: 'https://api.webflow.com/v2/pages/1?token=wf_secret_value_1',
    headers: { Authorization: 'Bearer wf_secret_value_1', 'Content-Type': 'application/json' },
    body: { seo: { title: 'x' }, token: 'wf_secret_value_1' },
  }, { env: { WEBFLOW_TOKEN: 'wf_secret_value_1' } });
  assert.ok(line.startsWith('PUT '));
  assert.ok(!line.includes('wf_secret_value_1'), 'no secret may appear in a printable description');
  assert.match(line, /headers: authorization, content-type \(values withheld\)/);
  assert.match(line, /\[redacted\]/);
});

test('basicAuth builds the header the WordPress REST adapter needs', () => {
  assert.equal(H.basicAuth('editor', 'abcd efgh'), 'Basic ' + Buffer.from('editor:abcd efgh').toString('base64'));
});

test('makeHttp bundles the injected pieces', async () => {
  const http = H.makeHttp({ fetchImpl: async () => res(200, { ok: 1 }), sleep: noSleep });
  const out = await http.get('https://api.example/x');
  assert.equal(out.json.ok, 1);
  assert.equal(http.offline, false);
});

test('a non-JSON 200 body is returned as text with a null json field', async () => {
  const out = await H.jsonRequest('https://api.example/x', { fetchImpl: async () => res(200, 'plain text', { 'Content-Type': 'text/plain' }), sleep: noSleep });
  assert.equal(out.ok, true);
  assert.equal(out.json, null);
  assert.equal(out.text, 'plain text');
  assert.equal(out.error, null);
});
