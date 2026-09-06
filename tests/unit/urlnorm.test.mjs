// lib/urlnorm.mjs — normalizeUrl, sameSite, isInternal, urlsEquivalent, linkKind (+ lib/fetch redirectFlags/parseLinkHeader, pure).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, sameSite, isInternal, urlsEquivalent, linkKind, hostKey, DEFAULT_TRACKING } from '../../scripts/lib/urlnorm.mjs';
import { redirectFlags, parseLinkHeader, resolveUa, UA_PRESETS } from '../../scripts/lib/fetch.mjs';

describe('normalizeUrl', () => {
  it('lowercases the host, drops default ports and fragments, strips tracking params and sorts the query', () => {
    assert.equal(normalizeUrl('HTTP://WWW.Example.com:80/Path/?utm_source=x&b=2&a=1&fbclid=abc#frag'), 'http://www.example.com/Path/?a=1&b=2');
    assert.equal(normalizeUrl('https://example.com:443/'), 'https://example.com/');
    assert.equal(normalizeUrl('https://example.com:8443/'), 'https://example.com:8443/', 'non-default ports stay');
    assert.equal(normalizeUrl('https://example.com/?gclid=1&msclkid=2&mc_cid=3&utm_campaign=4'), 'https://example.com/', 'every default tracker removed');
    assert.equal(normalizeUrl('https://example.com/a?z=1&y=2', { sortQuery: false }), 'https://example.com/a?z=1&y=2');
    assert.equal(normalizeUrl('https://example.com/a?utm_x=1&k=v', { stripTracking: false }), 'https://example.com/a?k=v&utm_x=1');
    assert.equal(normalizeUrl('https://example.com/a?ref=1', { stripTracking: ['ref'] }), 'https://example.com/a');
    assert.ok(DEFAULT_TRACKING.includes('utm_*'));
  });
  it('resolves relative references, optional www / trailing-slash / index stripping, case of the path preserved', () => {
    assert.equal(normalizeUrl('../b?x=1', { base: 'https://example.com/a/c/' }), 'https://example.com/a/b?x=1');
    assert.equal(normalizeUrl('https://www.example.com/A', { stripWww: true }), 'https://example.com/A');
    assert.equal(normalizeUrl('https://example.com/a/', { stripTrailingSlash: true }), 'https://example.com/a');
    assert.equal(normalizeUrl('https://example.com/', { stripTrailingSlash: true }), 'https://example.com/', 'root keeps its slash');
    assert.equal(normalizeUrl('https://example.com/x/index.html', { dropIndex: true }), 'https://example.com/x/');
    assert.equal(normalizeUrl('https://example.com/a#x', { stripHash: false }), 'https://example.com/a#x');
  });
  it('returns null for unparsable or non-http input', () => {
    assert.equal(normalizeUrl('not a url'), null);
    assert.equal(normalizeUrl('/relative-without-base'), null);
    assert.equal(normalizeUrl('mailto:a@b.c'), null);
    assert.equal(normalizeUrl('javascript:void(0)'), null);
    assert.equal(normalizeUrl(''), null);
  });
});

describe('sameSite / isInternal / hostKey / urlsEquivalent', () => {
  it('www and case insensitive; protocol and port ignored; different registrable hosts differ', () => {
    assert.equal(hostKey('https://WWW.Example.com/x'), 'example.com');
    assert.equal(sameSite('https://www.example.com/a', 'http://example.com/b'), true);
    assert.equal(sameSite('https://EXAMPLE.com:8080/', 'https://example.com/'), true);
    assert.equal(sameSite('https://blog.example.com/', 'https://example.com/'), false, 'subdomains are a different site (conservative)');
    assert.equal(sameSite('https://example.com/', 'https://example.org/'), false);
    assert.equal(sameSite('nope', 'https://example.com/'), false);
  });
  it('isInternal resolves relative hrefs and refuses non-http schemes', () => {
    const base = 'https://www.example.com/dir/page';
    assert.equal(isInternal('/x', base), true);
    assert.equal(isInternal('sub/page', base), true);
    assert.equal(isInternal('https://example.com/x', base), true, 'apex vs www is internal');
    assert.equal(isInternal('//example.com/x', base), true, 'protocol-relative');
    assert.equal(isInternal('https://example.org/x', base), false);
    assert.equal(isInternal('mailto:a@example.com', base), false);
    assert.equal(isInternal('tel:+1', base), false);
    assert.equal(isInternal('javascript:void(0)', base), false);
    assert.equal(isInternal('#frag', base), true, 'a fragment resolves to the page itself (callers drop fragments earlier via linkKind)');
    assert.equal(isInternal('http://[bad', base), false);
  });
  it('urlsEquivalent ignores trailing slash, fragment and tracking-free query order', () => {
    assert.equal(urlsEquivalent('https://example.com/a/', 'https://example.com/a'), true);
    assert.equal(urlsEquivalent('https://Example.com/a#x', 'https://example.com/a'), true);
    assert.equal(urlsEquivalent('https://example.com/a?b=1&a=2', 'https://example.com/a?a=2&b=1'), true);
    assert.equal(urlsEquivalent('https://example.com/a', 'https://example.com/b'), false);
    assert.equal(urlsEquivalent('/a', 'https://example.com/a', 'https://example.com/'), true);
    assert.equal(urlsEquivalent('x/', 'x'), true, 'falls back to a string compare when neither parses');
  });
});

describe('linkKind', () => {
  it('classifies hrefs before counting', () => {
    assert.equal(linkKind('#top'), 'fragment');
    assert.equal(linkKind('#'), 'fragment');
    assert.equal(linkKind('mailto:x@y.z'), 'mailto');
    assert.equal(linkKind('tel:+1'), 'tel');
    assert.equal(linkKind('javascript:void(0)'), 'javascript');
    assert.equal(linkKind('JavaScript:alert(1)'), 'javascript');
    assert.equal(linkKind('data:text/plain,hi'), 'data');
    assert.equal(linkKind('ftp://x/y'), 'other');
    assert.equal(linkKind('https://x/y'), 'http');
    assert.equal(linkKind('/relative'), 'http');
    assert.equal(linkKind('page.html?x#y'), 'http');
    assert.equal(linkKind(''), 'invalid');
    assert.equal(linkKind(null), 'invalid');
  });
});

describe('lib/fetch pure helpers', () => {
  it('redirectFlags describes http→https, www normalization, host change and trailing slash', () => {
    const f = redirectFlags('http://example.com/a', 'https://www.example.com/a/', 2);
    assert.deepEqual(f, { hops: 2, loop: false, truncated: false, http_to_https: true, host_changed: false, www_normalized: true, trailing_slash_changed: true });
    assert.equal(redirectFlags('https://a.com/', 'https://b.com/').host_changed, true);
    assert.equal(redirectFlags('https://a.com/', 'https://b.com/').www_normalized, false);
    assert.equal(redirectFlags('https://a.com/x', 'https://a.com/y').trailing_slash_changed, false);
    assert.equal(redirectFlags('nope', 'https://a.com/').http_to_https, false, 'unparsable input yields all-false flags');
  });
  it('parseLinkHeader handles multiple entries, quoted params, relative URLs and arrays', () => {
    const links = parseLinkHeader('<https://x.test/a>; rel="canonical", </es/a>; rel="alternate"; hreflang="es", <https://x.test/n>; rel=next', 'https://x.test/page');
    assert.deepEqual(links.map((l) => [l.url, l.rel, l.hreflang]), [
      ['https://x.test/a', 'canonical', null], ['https://x.test/es/a', 'alternate', 'es'], ['https://x.test/n', 'next', null],
    ]);
    assert.equal(parseLinkHeader(['<https://x/1>; rel="a"', '<https://x/2>; rel="b"']).length, 2);
    assert.deepEqual(parseLinkHeader(null), []);
    assert.deepEqual(parseLinkHeader('garbage'), []);
  });
  it('resolveUa maps presets (case-insensitive) and passes literal strings through', () => {
    assert.deepEqual(resolveUa({}), { ua: UA_PRESETS.default, preset: 'default' });
    assert.deepEqual(resolveUa({ ua: 'GoogleBot' }), { ua: UA_PRESETS.googlebot, preset: 'googlebot' });
    assert.deepEqual(resolveUa({ uaPreset: 'gptbot' }), { ua: UA_PRESETS.gptbot, preset: 'gptbot' });
    assert.deepEqual(resolveUa({ ua: 'MyBot/1.0' }), { ua: 'MyBot/1.0', preset: null });
    assert.equal(resolveUa({ uaPreset: 'unknown-preset' }).preset, 'default');
    for (const [k, v] of Object.entries(UA_PRESETS)) assert.ok(v.length > 10, k);
    assert.match(UA_PRESETS.default, /claude-seo-ai\/0\.2/);
    assert.match(UA_PRESETS['oai-searchbot'], /OAI-SearchBot/);
    assert.match(UA_PRESETS['claude-searchbot'], /Claude-SearchBot/);
  });
});
