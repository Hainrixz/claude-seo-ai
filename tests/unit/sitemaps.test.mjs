// lib/sitemaps.mjs — parseSitemap (index, urlset, gz buffer, entities, lastmod stats, errors) and discoverSitemaps with an injected fetcher.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSitemap, discoverSitemaps, xmlDecode, parseW3cDate, maybeGunzip, WELL_KNOWN_SITEMAPS } from '../../scripts/lib/sitemaps.mjs';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f) => readFileSync(resolve(FIX, f), 'utf8');
const INDEX = read('sitemap-index.xml');
const POSTS = read('sitemap-posts.xml');
const PAGES = read('sitemap-pages.xml');

describe('parseSitemap', () => {
  it('parses a sitemap index', () => {
    const s = parseSitemap(INDEX);
    assert.equal(s.kind, 'sitemapindex');
    assert.equal(s.url_count, 2);
    assert.deepEqual(s.entries.map((e) => e.loc), ['https://example.com/sitemap-posts.xml', 'https://example.com/sitemap-pages.xml.gz']);
    assert.equal(s.entries[1].lastmod, '2026-08-15T10:00:00Z');
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.namespaces, [{ prefix: null, uri: 'http://www.sitemaps.org/schemas/sitemap/0.9' }]);
  });
  it('parses a urlset: entity-decoded loc, alternates, image counts, lastmod stats and validation errors', () => {
    const s = parseSitemap(POSTS);
    assert.equal(s.kind, 'urlset');
    assert.equal(s.url_count, 4);
    const a = s.entries[0];
    assert.equal(a.loc, 'https://example.com/blog/a?x=1&y=2', '&amp; decoded');
    assert.equal(a.changefreq, 'weekly');
    assert.equal(a.priority, 0.8);
    assert.deepEqual(a.alternates, [{ hreflang: 'es', href: 'https://example.com/es/blog/a' }, { hreflang: 'x-default', href: 'https://example.com/blog/a' }]);
    assert.equal(a.images, 2);
    assert.equal(a.videos, 0);
    assert.equal(a.lastmod_iso, '2026-07-01T00:00:00.000Z');
    assert.equal(s.entries[1].lastmod_iso, '2026-07-15T08:30:00.000Z');
    assert.equal(s.entries[3].loc, null);
    assert.deepEqual(s.lastmod, { count: 4, min: '2026-07-01T00:00:00.000Z', max: '2026-07-15T08:30:00.000Z', distinct: 3, invalid: 1 });
    assert.deepEqual(s.errors, [
      'entry #3: <lastmod> is not a W3C datetime: 15/07/2026',
      'entry #3: invalid <changefreq> sometimes',
      'entry #3: <priority> outside 0.0–1.0: 7',
      'entry #4: missing <loc>',
    ]);
    assert.deepEqual(s.namespaces.map((n) => n.prefix), [null, 'xhtml', 'image']);
  });
  it('detects identical lastmod values and news extensions', () => {
    const s = parseSitemap(PAGES);
    assert.equal(s.lastmod.count, 2);
    assert.equal(s.lastmod.distinct, 1);
    assert.equal(s.entries[1].news, 1);
  });
  it('accepts a gzip Buffer and a plain Buffer', () => {
    const gz = parseSitemap(gzipSync(Buffer.from(PAGES)));
    assert.equal(gz.kind, 'urlset');
    assert.equal(gz.url_count, 2);
    assert.equal(parseSitemap(Buffer.from(INDEX)).kind, 'sitemapindex');
    const m = maybeGunzip(gzipSync(Buffer.from('x')));
    assert.deepEqual([m.gz, m.buf.toString()], [true, 'x']);
    assert.equal(maybeGunzip(Buffer.from('plain')).gz, false);
  });
  it('flags invalid input, HTML soft-404 bodies, missing namespace, mismatched entries', () => {
    const html = parseSitemap('<!DOCTYPE html><html><body>Not found</body></html>');
    assert.equal(html.kind, 'invalid');
    assert.match(html.errors.join(' '), /looks like an HTML page/);
    assert.equal(parseSitemap('').kind, 'invalid');
    assert.equal(parseSitemap(null).kind, 'invalid');
    const noNs = parseSitemap('<urlset><url><loc>https://x/</loc></url></urlset>');
    assert.equal(noNs.kind, 'urlset');
    assert.match(noNs.errors[0], /missing default xmlns/);
    const mixed = parseSitemap('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x/</loc></url></sitemapindex>');
    assert.ok(mixed.errors.includes('<url> entries inside a <sitemapindex>'));
    assert.ok(mixed.errors.includes('no <sitemap> entries'));
    const unclosed = parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x/</loc></url>');
    assert.ok(unclosed.errors.includes('unclosed <urlset>'));
    const rel = parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/relative</loc></url></urlset>');
    assert.match(rel.errors[0], /not an absolute http\(s\) URL/);
    const cdata = parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc><![CDATA[https://x/a?b=1&c=2]]></loc></url></urlset>');
    assert.equal(cdata.entries[0].loc, 'https://x/a?b=1&c=2');
  });
  it('helpers: xmlDecode and parseW3cDate', () => {
    assert.equal(xmlDecode('a&amp;b&lt;c&gt;&quot;&apos;&#65;&#x42;'), 'a&b<c>"\'AB');
    assert.equal(parseW3cDate('2026'), '2026-01-01T00:00:00.000Z');
    assert.equal(parseW3cDate('2026-07'), '2026-07-01T00:00:00.000Z');
    assert.equal(parseW3cDate('2026-07-01T10:00:00+02:00'), '2026-07-01T08:00:00.000Z');
    assert.equal(parseW3cDate('July 1 2026'), null);
    assert.equal(parseW3cDate(''), null);
  });
});

describe('discoverSitemaps (injected fetcher, no network)', () => {
  const origin = 'https://example.com';
  const gzPages = gzipSync(Buffer.from(PAGES));
  const routes = {
    [origin + '/sitemap.xml']: { status: 200, text: INDEX },
    [origin + '/sitemap-posts.xml']: { status: 200, text: POSTS },
    [origin + '/sitemap-pages.xml.gz']: { status: 200, buffer: gzPages },
    [origin + '/wp-sitemap.xml']: { status: 200, text: '<!doctype html><html><body>home</body></html>' },
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (!r) return { ok: false, status: 404, body: { text: '', bytes: 0 }, error: null };
    return { ok: true, status: 200, body: r.buffer ? { text: '', buffer: r.buffer, bytes: r.buffer.length } : { text: r.text, bytes: Buffer.byteLength(r.text) }, error: null };
  };
  const robots = { sitemaps: ['https://example.com/sitemap.xml'], groups: [] };

  it('unions robots Sitemap lines with the well-known paths, walks the index recursively, inflates .gz, and reports per-file details', async () => {
    calls.length = 0;
    const d = await discoverSitemaps(origin, robots, fetchImpl);
    assert.deepEqual(d.declared, ['https://example.com/sitemap.xml']);
    assert.equal(d.found, 3, 'index + posts + gz pages (the HTML wp-sitemap is invalid, not found)');
    assert.equal(d.truncated, false);
    assert.ok(calls.every((c) => c.opts && c.opts.returnBuffer === true), 'asks the fetcher for a buffer so gz can be inflated locally');
    const by = Object.fromEntries(d.files.map((f) => [f.url, f]));
    assert.equal(by[origin + '/sitemap.xml'].kind, 'sitemapindex');
    assert.equal(by[origin + '/sitemap.xml'].source, 'robots');
    assert.equal(by[origin + '/sitemap-posts.xml'].source, 'index');
    assert.equal(by[origin + '/sitemap-posts.xml'].parent, origin + '/sitemap.xml');
    assert.equal(by[origin + '/sitemap-posts.xml'].url_count, 4);
    assert.equal(by[origin + '/sitemap-posts.xml'].errors.length, 4);
    const gz = by[origin + '/sitemap-pages.xml.gz'];
    assert.equal(gz.gz, true);
    assert.equal(gz.kind, 'urlset');
    assert.equal(gz.url_count, 2);
    assert.equal(gz.bytes, Buffer.byteLength(PAGES), 'bytes are the inflated size');
    assert.equal(by[origin + '/wp-sitemap.xml'].kind, 'invalid');
    assert.equal(by[origin + '/sitemap_index.xml'].status, 404);
    assert.equal(by[origin + '/sitemap_index.xml'].error, 'HTTP 404');
    assert.equal(d.files.length, 1 + WELL_KNOWN_SITEMAPS.length - 1 + 2, 'declared (also well-known) + other well-known + 2 children');
    assert.equal(d.urls.length, 5, '3 posts (one has no loc) + 2 pages');
    assert.deepEqual(d.urls[0], { loc: 'https://example.com/blog/a?x=1&y=2', lastmod: '2026-07-01T00:00:00.000Z', sitemap: origin + '/sitemap-posts.xml' });
    assert.ok(d.urls.some((u) => u.sitemap === origin + '/sitemap-pages.xml.gz'));
  });
  it('honors maxFiles / maxUrls caps, the wellKnown switch, the onParsed hook and a bad origin', async () => {
    const capped = await discoverSitemaps(origin, robots, fetchImpl, { maxFiles: 1, wellKnown: false });
    assert.equal(capped.files.length, 1);
    assert.equal(capped.truncated, true);
    assert.equal(capped.truncated_files, true);
    const urlCap = await discoverSitemaps(origin, robots, fetchImpl, { maxUrls: 2, wellKnown: false });
    assert.equal(urlCap.urls.length, 2);
    assert.equal(urlCap.truncated_urls, true);
    const seen = [];
    const declaredOnly = await discoverSitemaps(origin, robots, fetchImpl, { wellKnown: false, onParsed: (f, p) => seen.push([f.url, p.kind]) });
    assert.equal(declaredOnly.files.length, 3);
    assert.deepEqual(seen[0], [origin + '/sitemap.xml', 'sitemapindex']);
    const none = await discoverSitemaps(origin, { sitemaps: [] }, fetchImpl, { wellKnown: false });
    assert.deepEqual([none.files.length, none.found], [0, 0]);
    const bad = await discoverSitemaps('not a url', robots, fetchImpl);
    assert.match(bad.error, /invalid origin/);
    const relative = await discoverSitemaps(origin, { sitemaps: ['/sitemap.xml'] }, fetchImpl, { wellKnown: false });
    assert.equal(relative.files[0].url, origin + '/sitemap.xml', 'relative Sitemap: lines resolve against the origin');
  });
  it('records the final URL and walks a redirect alias only once', async () => {
    // /wp-sitemap.xml -> 301 -> /sitemap_index.xml -> 302 -> /sitemap.xml is ONE sitemap. Keying the
    // file on the requested URL made it three live sources with identical url_counts, walked the same
    // index three times, and spent the 50-file budget on the duplicates.
    const redirecting = async (url, opts) => {
      const target = (url === origin + '/wp-sitemap.xml' || url === origin + '/sitemap_index.xml') ? origin + '/sitemap.xml' : url;
      const r = await fetchImpl(target, opts);
      return { ...r, final_url: target };
    };
    const d = await discoverSitemaps(origin, robots, redirecting);
    const by = Object.fromEntries(d.files.map((f) => [f.url, f]));
    assert.equal(by[origin + '/sitemap.xml'].alias_of, null, 'the first path to reach the document owns it');
    assert.equal(by[origin + '/sitemap.xml'].final_url, origin + '/sitemap.xml');
    for (const alias of ['/wp-sitemap.xml', '/sitemap_index.xml']) {
      const f = by[origin + alias];
      assert.equal(f.final_url, origin + '/sitemap.xml', alias + ' resolves to the one document');
      assert.equal(f.redirected, true);
      assert.equal(f.alias_of, origin + '/sitemap.xml');
      assert.equal(f.kind, 'sitemapindex', 'what the path serves is still described honestly');
    }
    assert.equal(d.found, 3, 'index + its two children — the aliases are not counted as extra sitemaps');
    assert.equal(d.urls.filter((u) => u.loc === 'https://example.com/blog/a?x=1&y=2').length, 1,
      'an alias contributes no second copy of the same URLs');
    assert.equal(d.files.filter((f) => f.parent === origin + '/sitemap.xml').length, 2, 'the index is walked once');
  });

  it('survives a throwing fetcher and a robotsFromFetch-shaped robots argument', async () => {
    const d = await discoverSitemaps(origin, { mode: 'parsed', robots }, async () => { throw new Error('boom'); }, { wellKnown: false });
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].status, 0);
    assert.match(d.files[0].error, /boom/);
  });
});
