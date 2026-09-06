// lib/fetch.mjs against the local fixture server: redirect chains/loops/truncation, headers, byte cap,
// gzip (raw .gz and content-encoding), charset, UA presets, retries, timeouts, network errors, fetchText compat.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fetchRaw, fetchText, UA_PRESETS } from '../../scripts/lib/fetch.mjs';
import { startServer } from '../helpers/server.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
const U = (p) => srv.url + p;
const hitsFor = (p) => srv.hits.filter((h) => h.path === p).length;

function closedLoopbackPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

describe('fetchRaw redirects', () => {
  it('records every hop of a 301→302→200 chain and lands on the final page', async () => {
    const r = await fetchRaw(U('/old'));
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.final_url, U('/blog/a'));
    assert.deepEqual(r.status_chain.map((h) => [h.url, h.status, h.location]), [
      [U('/old'), 301, '/older'], [U('/older'), 302, '/blog/a'], [U('/blog/a'), 200, null],
    ]);
    assert.ok(r.status_chain.every((h) => Number.isInteger(h.ms) && h.ms >= 0));
    assert.equal(r.redirects.hops, 2);
    assert.equal(r.redirects.loop, false);
    assert.equal(r.redirects.truncated, false);
    assert.equal(r.redirects.host_changed, false);
    assert.match(r.body.text, /First article/);
    assert.equal(r.body.charset, 'utf-8');
    assert.equal(r.body.charset_source, 'header');
    assert.equal(typeof r.body.sha256, 'string');
    assert.equal(r.body.sha256.length, 64);
    for (const k of ['ttfb_ms', 'download_ms', 'total_ms']) assert.ok(Number.isInteger(r.timing[k]), k);
    assert.equal(r.error, null);
    assert.equal(r.url, U('/old'));
  });
  it('detects a redirect loop without hanging', async () => {
    const r = await fetchRaw(U('/loop1'));
    assert.equal(r.ok, false);
    assert.equal(r.redirects.loop, true);
    assert.equal(r.error, 'redirect loop');
    assert.equal(r.status_chain.length, 2);
    assert.equal(r.status, 302);
    assert.equal(r.body.text, '');
  });
  it('stops after maxHops and flags truncation', async () => {
    const r = await fetchRaw(U('/hop/5'), { maxHops: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.redirects.truncated, true);
    assert.equal(r.redirects.hops, 3);
    assert.match(r.error, /too many redirects/);
    const full = await fetchRaw(U('/hop/5'));
    assert.equal(full.ok, true);
    assert.equal(full.redirects.hops, 5);
  });
  it('follow:false returns the 3xx itself; trailing-slash redirects are flagged', async () => {
    const r = await fetchRaw(U('/old'), { follow: false });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/older');
    assert.equal(r.status_chain.length, 1);
    const slash = await fetchRaw(U('/dir'));
    assert.equal(slash.final_url, U('/dir/'));
    assert.equal(slash.redirects.trailing_slash_changed, true);
  });
});

describe('fetchRaw headers and body handling', () => {
  it('lowercases headers and replaces set-cookie with cookie names only', async () => {
    const r = await fetchRaw(U('/cookies'));
    assert.equal(r.headers['set-cookie'], undefined);
    assert.deepEqual(r.headers.cookie_names, ['session', 'theme']);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.ok(!JSON.stringify(r.headers).includes('abc123'), 'cookie values are never recorded');
  });
  it('sends the UA preset plus accept and accept-language headers', async () => {
    const dflt = JSON.parse((await fetchRaw(U('/echo-ua'))).body.text);
    assert.equal(dflt.ua, UA_PRESETS.default);
    assert.match(dflt.accept, /text\/html/);
    assert.match(dflt['accept-language'], /en/);
    const g = JSON.parse((await fetchRaw(U('/echo-ua'), { ua: 'googlebot', acceptLanguage: 'es-MX,es;q=0.9' })).body.text);
    assert.match(g.ua, /Googlebot\/2\.1/);
    assert.equal(g['accept-language'], 'es-MX,es;q=0.9');
    const lit = JSON.parse((await fetchRaw(U('/echo-ua'), { ua: 'MyAuditBot/9', headers: { Accept: 'application/json' } })).body.text);
    assert.equal(lit.ua, 'MyAuditBot/9');
    assert.equal(lit.accept, 'application/json', 'explicit headers override the defaults');
  });
  it('streams the body and stops at maxBytes', async () => {
    const capped = await fetchRaw(U('/big'), { maxBytes: 100_000 });
    assert.equal(capped.ok, true);
    assert.equal(capped.body.truncated, true);
    assert.equal(capped.body.bytes, 100_000);
    assert.equal(capped.body.text.length, 100_000);
    const whole = await fetchRaw(U('/big'));
    assert.equal(whole.body.truncated, false);
    assert.equal(whole.body.bytes, 2_500_000);
  });
  it('gunzips a raw .gz body and decodes a content-encoding: gzip body', async () => {
    const gz = await fetchRaw(U('/sitemap-pages.xml.gz'));
    assert.equal(gz.ok, true);
    assert.equal(gz.body.gunzipped, true);
    assert.match(gz.body.text, /<urlset/);
    assert.match(gz.body.text, new RegExp(srv.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/about'));
    const enc = await fetchRaw(U('/gz-body'));
    assert.equal(enc.ok, true);
    assert.equal(enc.headers['content-encoding'], 'gzip');
    assert.equal(enc.body.content_encoding, 'gzip');
    assert.match(enc.body.text, /GZ-BODY-MARKER/);
  });
  it('decodes the charset from the content-type header, else sniffs <meta charset>, else utf-8', async () => {
    const l1 = await fetchRaw(U('/latin1'));
    assert.equal(l1.body.charset, 'iso-8859-1');
    assert.equal(l1.body.text, '<p>café</p>');
    const meta = await fetchRaw(U('/meta-charset'));
    assert.equal(meta.body.charset_source, meta.body.charset_fallback ? 'meta' : 'meta');
    if (!meta.body.charset_fallback) { assert.equal(meta.body.charset, 'windows-1252'); assert.match(meta.body.text, /“hi”/); }
    const plain = await fetchRaw(U('/echo-ua'));
    assert.equal(plain.body.charset, 'utf-8');
    assert.equal(plain.body.charset_source, 'fallback');
  });
});

describe('fetchRaw failures, retries and timeouts', () => {
  it('retries once on 5xx with backoff (never on 4xx) and reports attempts', async () => {
    const before5 = hitsFor('/boom');
    const r = await fetchRaw(U('/boom'), { retries: 1 });
    assert.equal(r.status, 500);
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 2);
    assert.equal(hitsFor('/boom') - before5, 2);
    const noRetry = await fetchRaw(U('/boom'), { retries: 0 });
    assert.equal(noRetry.attempts, 1);
    const before4 = hitsFor('/does-not-exist');
    const nf = await fetchRaw(U('/does-not-exist'), { retries: 3 });
    assert.equal(nf.status, 404);
    assert.equal(nf.attempts, 1);
    assert.equal(hitsFor('/does-not-exist') - before4, 1);
  });
  it('network error → ok:false, status 0, error string, empty chain', async () => {
    const port = await closedLoopbackPort();
    const r = await fetchRaw(`http://127.0.0.1:${port}/x`, { retries: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.equal(typeof r.error, 'string');
    assert.deepEqual(r.status_chain, []);
    assert.equal(r.body.text, '');
    assert.equal(r.attempts, 1);
  });
  it('per-attempt timeout aborts a slow response', async () => {
    const r = await fetchRaw(U('/slow?ms=1500'), { timeoutMs: 150, retries: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.match(r.error, /timeout/i);
  });
  it('rejects invalid or non-http URLs without throwing', async () => {
    assert.match((await fetchRaw('not a url')).error, /invalid URL/);
    assert.match((await fetchRaw('ftp://example.com/x')).error, /unsupported protocol/);
  });
});

describe('fetchText compat wrapper', () => {
  it('keeps the legacy shape { ok, status, text, headers, finalUrl, error }', async () => {
    const r = await fetchText(U('/old'));
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.match(r.text, /First article/);
    assert.equal(r.finalUrl, U('/blog/a'));
    assert.equal(r.error, null);
    assert.equal(typeof r.headers['content-type'], 'string');
    assert.equal(r.chain.length, 3);
    const port = await closedLoopbackPort();
    const bad = await fetchText(`http://127.0.0.1:${port}/`, { retries: 0 });
    assert.deepEqual([bad.ok, bad.status, bad.text], [false, 0, '']);
    assert.equal(typeof bad.error, 'string');
  });
});
