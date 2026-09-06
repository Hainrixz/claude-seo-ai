// Unit tests for scripts/lib/templates.mjs — the URL → template clustering the crawler samples by.
// Pure functions only: no server, no filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySegment, splitExtension, pathPattern, queryKeys, normalizeType, primaryJsonLdType,
  bodyClassOf, bodyTemplateMarker, templateKey, explain, splitKey, makeKey, groupTemplates,
  MAX_PATTERN_SEGMENTS, GENERIC_JSONLD_TYPES,
} from '../../scripts/lib/templates.mjs';

const kinds = (u) => explain(u).segments.map((s) => s.kind);

test('classifySegment: identifiers collapse, short section names survive', () => {
  assert.equal(classifySegment('123').kind, 'numeric');
  assert.equal(classifySegment('123').out, '*');
  assert.equal(classifySegment('550e8400-e29b-41d4-a716-446655440000').kind, 'uuid');
  assert.equal(classifySegment('2026-07-01').kind, 'date');
  assert.equal(classifySegment('2026-07').kind, 'date');
  assert.equal(classifySegment('deadbeef99').kind, 'hex');
  assert.equal(classifySegment('first-post').kind, 'slug');
  assert.equal(classifySegment('sku99').kind, 'alnum');
  assert.equal(classifySegment('a').kind, 'single', 'a one-character segment is an id, not a section');
  assert.equal(classifySegment('an-extraordinarily-long-name').kind, 'slug');
  assert.equal(classifySegment('averylongsinglewordsegment').kind, 'long');
  assert.equal(classifySegment('blog').kind, 'literal');
  assert.equal(classifySegment('blog').out, 'blog');
  assert.equal(classifySegment('Collections').out, 'collections', 'patterns are lower-cased');
  assert.equal(classifySegment('es', { index: 0 }).kind, 'locale');
  assert.equal(classifySegment('pt-br', { index: 0 }).kind, 'locale');
  assert.equal(classifySegment('pt-br', { index: 2 }).kind, 'literal', 'a locale is only recognised in first position');
  assert.equal(classifySegment('red-cap', { index: 0 }).kind, 'slug', 'a 7-char hyphenated word is not a locale');
});

test('splitExtension only strips page extensions', () => {
  assert.deepEqual(splitExtension('a.html'), { base: 'a', ext: '.html' });
  assert.deepEqual(splitExtension('report.pdf'), { base: 'report.pdf', ext: '' });
  assert.deepEqual(splitExtension('index'), { base: 'index', ext: '' });
  assert.deepEqual(splitExtension('.htaccess'), { base: '.htaccess', ext: '' }, 'a leading dot is not an extension');
});

test('pathPattern: siblings of one template share a pattern', () => {
  assert.equal(pathPattern('/'), '/');
  assert.equal(pathPattern('https://x.test/'), '/');
  assert.equal(pathPattern('/about'), '/about');
  assert.equal(pathPattern('/blog/a'), '/blog/*');
  assert.equal(pathPattern('/blog/b'), '/blog/*');
  assert.equal(pathPattern('/blog/first-post/'), '/blog/*');
  assert.equal(pathPattern('/blog/a.html'), '/blog/*');
  assert.equal(pathPattern('https://x.test/es/blog/segundo-articulo'), '/es/blog/*');
  assert.equal(pathPattern('/2026/07/01/hello-world'), '/*/*/*/*');
  assert.equal(pathPattern('/products/12345'), '/products/*');
  assert.equal(pathPattern('/collections/all'), '/collections/all');
});

test('pathPattern: a query becomes its sorted parameter names, never its values', () => {
  assert.equal(pathPattern('/search?q=shoes&page=2'), '/search?page&q');
  assert.equal(pathPattern('/search?q=hats&page=9'), '/search?page&q', 'different values, same template');
  assert.equal(pathPattern('/search?q=x', { withQuery: false }), '/search');
  assert.deepEqual(queryKeys('?B=1&a=2&a=3'), ['a', 'b']);
  assert.equal(queryKeys('').length, 0);
  assert.equal(queryKeys('?a=1&b=2&c=3&d=4&e=5&f=6&g=7').length, 6, 'capped at MAX_PATTERN_QUERY_KEYS');
});

test('pathPattern: very deep paths are truncated with a marker', () => {
  const deep = '/' + Array.from({ length: MAX_PATTERN_SEGMENTS + 3 }, (_, i) => 'seg' + i).join('/');
  const p = pathPattern(deep);
  assert.ok(p.endsWith('/**'), p);
  assert.equal(p.split('/').filter(Boolean).length, MAX_PATTERN_SEGMENTS + 1);
});

test('segment kinds are reported per URL', () => {
  assert.deepEqual(kinds('/es/blog/mi-primer-articulo'), ['locale', 'literal', 'slug']);
  assert.deepEqual(kinds('/'), []);
});

test('primaryJsonLdType skips site-level types and normalizes namespaced ones', () => {
  const one = primaryJsonLdType({ jsonld: [{ ok: true, type: ['WebSite'] }, { ok: true, type: ['BreadcrumbList', 'Product'] }] });
  assert.equal(one.type, 'Product');
  assert.deepEqual(one.types, ['WebSite', 'BreadcrumbList', 'Product']);
  assert.equal(primaryJsonLdType({ jsonld: [{ ok: true, type: ['https://schema.org/BlogPosting'] }] }).type, 'BlogPosting');
  assert.equal(primaryJsonLdType({ jsonld: [{ ok: false, type: [], error: 'bad json' }] }).type, null, 'a broken block votes for nothing');
  assert.equal(primaryJsonLdType({ jsonld: [{ ok: true, type: ['Organization'] }] }).type, null, 'only generic types = untyped');
  assert.equal(primaryJsonLdType(null).type, null);
  assert.ok(GENERIC_JSONLD_TYPES.has('WebSite'));
  assert.equal(normalizeType('schema:Product'), 'Product');
  assert.equal(normalizeType(null), '');
});

test('bodyClassOf handles the three attribute quotings and no class at all', () => {
  assert.equal(bodyClassOf('<html><body class="template-product foo">'), 'template-product foo');
  assert.equal(bodyClassOf("<body id='x' class='single-post'>"), 'single-post');
  assert.equal(bodyClassOf('<body class=home>'), 'home');
  assert.equal(bodyClassOf('<body>'), null);
  assert.equal(bodyClassOf(''), null);
  assert.equal(bodyClassOf(null), null);
});

test('bodyTemplateMarker maps CMS classes to a schema family', () => {
  assert.deepEqual(bodyTemplateMarker('gradient template-product product-page'), { marker: 'template-product', family: 'Product' });
  assert.deepEqual(bodyTemplateMarker('single single-post postid-42'), { marker: 'single-post', family: 'Article' });
  assert.deepEqual(bodyTemplateMarker('page-template-default page'), { marker: 'page-template-default', family: 'WebPage' });
  assert.deepEqual(bodyTemplateMarker('archive category category-news'), { marker: 'archive', family: 'CollectionPage' });
  assert.deepEqual(bodyTemplateMarker('woocommerce single-product'), { marker: 'single-product', family: 'Product' });
  assert.deepEqual(bodyTemplateMarker('no-idea-what-this-is'), { marker: null, family: null });
});

test('templateKey merges a marked-up product with an unmarked sibling of the same template', () => {
  const withLd = templateKey('https://x.test/shop/red-shoes', { jsonld: [{ ok: true, type: ['Product'] }] });
  const withClass = templateKey('https://x.test/shop/blue-hat', null, { html: '<html><body class="template-product">' });
  assert.equal(withLd, '/shop/*|Product');
  assert.equal(withClass, '/shop/*|Product', 'the body class stands in for missing JSON-LD');
  assert.equal(templateKey('https://x.test/shop/sizing-guide', { jsonld: [{ ok: true, type: ['Article'] }] }), '/shop/*|Article');
  assert.equal(templateKey('https://x.test/shop/discontinued-item'), '/shop/*|', 'no page fetched = no type');
});

test('templateKey prefers JSON-LD over the body class and records both', () => {
  const info = explain('https://x.test/shop/red-shoes', { jsonld: [{ ok: true, type: ['Product'] }] }, { bodyClass: 'template-page' });
  assert.equal(info.type, 'Product');
  assert.equal(info.type_source, 'jsonld');
  assert.equal(info.body_marker, 'template-page');
  assert.equal(info.body_family, 'WebPage');
  assert.deepEqual(info.evidence, ['url-pattern:/shop/*', 'jsonld:Product', 'body-class:template-page=>WebPage']);
  const fromClass = explain('https://x.test/posts/1', null, { bodyClass: 'single-post' });
  assert.equal(fromClass.type_source, 'body-class');
  assert.equal(fromClass.key, '/posts/*|Article');
  const none = explain('https://x.test/about');
  assert.equal(none.type_source, 'none');
  assert.deepEqual(none.evidence, ['url-pattern:/about']);
});

test('explain reports a generic-only JSON-LD page as untyped but says what it saw', () => {
  const info = explain('https://x.test/', { jsonld: [{ ok: true, type: ['WebSite', 'Organization'] }] });
  assert.equal(info.type, null);
  assert.equal(info.key, '/|');
  assert.deepEqual(info.evidence, ['url-pattern:/', 'jsonld-generic:WebSite,Organization']);
});

test('splitKey / makeKey round-trip, including patterns that contain a query', () => {
  assert.deepEqual(splitKey('/blog/*|Article'), { pattern: '/blog/*', type: 'Article' });
  assert.deepEqual(splitKey('/search?page&q|'), { pattern: '/search?page&q', type: '' });
  assert.equal(makeKey('/blog/*', 'Article'), '/blog/*|Article');
  assert.equal(makeKey('/blog/*', null), '/blog/*|');
});

test('groupTemplates: unfetched URLs join the busiest group of their pattern, disclosed', () => {
  const t = groupTemplates([
    { url: '/shop/a-one', key: '/shop/*|Product', sampled: true, evidence: ['jsonld:Product'] },
    { url: '/shop/b-two', key: '/shop/*|Product', sampled: true },
    { url: '/shop/c-three', key: '/shop/*|', sampled: false },
    { url: '/shop/d-four', key: '/shop/*|', sampled: false },
    { url: '/shop/guide-page', key: '/shop/*|Article', sampled: true },
    { url: '/', key: '/|WebSite', sampled: true },
  ]);
  const product = t.find((g) => g.key === '/shop/*|Product');
  assert.equal(product.discovered, 4, 'two sampled products plus the two nobody fetched');
  assert.equal(product.sampled, 2);
  assert.ok(product.evidence.includes('unfetched-urls-assigned-by-pattern'));
  assert.ok(product.evidence.includes('pattern-split-by-type'));
  assert.ok(product.split);
  assert.equal(t.find((g) => g.key === '/shop/*|Article').discovered, 1);
  assert.equal(t.find((g) => g.key === '/|WebSite').split, false);
  assert.equal(t[0].key, '/shop/*|Product', 'ordered by discovered desc');
  assert.equal(Math.round(t.reduce((n, g) => n + g.weight, 0)), 1, 'weights are shares of all discovered URLs');
  assert.equal(product.weight, 0.667);
});

test('groupTemplates: a page that was fetched keeps its own bucket even without a type', () => {
  const t = groupTemplates([
    { url: '/blog/a', key: '/blog/*|', sampled: true },
    { url: '/blog/first-post', key: '/blog/*|BlogPosting', sampled: true },
    { url: '/blog/never-fetched', key: '/blog/*|', sampled: false },
  ]);
  const keys = t.map((g) => g.key).sort();
  assert.deepEqual(keys, ['/blog/*|', '/blog/*|BlogPosting']);
  const untyped = t.find((g) => g.key === '/blog/*|');
  assert.equal(untyped.sampled, 1);
  assert.equal(untyped.discovered, 2, 'the unfetched sibling joined the busiest group, which is this one');
  assert.ok(untyped.evidence.includes('unfetched-urls-assigned-by-pattern'));
});

test('groupTemplates: a pattern nobody fetched keeps its untyped key', () => {
  const t = groupTemplates([{ url: '/old', key: '/old|', sampled: false }]);
  assert.equal(t.length, 1);
  assert.deepEqual({ key: t[0].key, discovered: t[0].discovered, sampled: t[0].sampled, weight: t[0].weight }, { key: '/old|', discovered: 1, sampled: 0, weight: 1 });
  assert.deepEqual(t[0].evidence, ['url-pattern:/old']);
});

test('groupTemplates tolerates junk and an empty list', () => {
  assert.deepEqual(groupTemplates([]), []);
  assert.deepEqual(groupTemplates(null), []);
  assert.deepEqual(groupTemplates([null, { url: '/x' }, 3]), []);
});
