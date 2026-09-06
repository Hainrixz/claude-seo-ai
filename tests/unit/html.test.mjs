// lib/html.mjs: tokenizer, parseDocument, extractPassages, parseLinkHeader, and the util.mjs
// compat getters on malformed markup. Fixtures are synthetic (tests/fixtures/malformed.html).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tokenize, parseDocument, extractPassages, parseLinkHeader, inContent, innerText, sameUrl } from '../../scripts/lib/html.mjs';
import { decodeEntities, ENTITY_COUNT } from '../../scripts/lib/entities.mjs';
import {
  getTitle, getMetaName, getMetaProperty, getLinkRel, getHtmlLang, getCharset, getHeadings, getImages, getLinks, getJsonLd, stripTags,
} from '../../scripts/lib/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '..', 'fixtures');
const MALFORMED = readFileSync(resolve(FIX, 'malformed.html'), 'utf8');
const BLOG = readFileSync(resolve(FIX, 'blog-post.html'), 'utf8');
const PAGE = 'https://example.test/sale/spring';
const doc = parseDocument(MALFORMED, PAGE);
const byHref = (href) => doc.anchors.find((a) => a.href === href);

describe('entities', () => {
  it('ships a full named table (HTML4 + apos + common HTML5)', () => assert.ok(ENTITY_COUNT >= 250, 'only ' + ENTITY_COUNT));
  it('decodes numeric decimal/hex and named references', () => {
    assert.equal(decodeEntities('Don&#8217;t &#x27;x&#x27; &hellip; &mdash; &ndash; &lsquo;a&rsquo; &ldquo;b&rdquo;'), 'Don’t \'x\' … — – ‘a’ “b”');
    assert.equal(decodeEntities('&trade; &copy; &reg; &laquo;x&raquo; &euro; &eacute;&ntilde; &Omega;&alpha; &nbsp;'), '™ © ® «x» € éñ Ωα  ');
    assert.equal(decodeEntities('&amp;lt; &quot;&apos; &#39;'), '&lt; "\' \'');
  });
  it('is surrogate-safe and leaves unknown references alone', () => {
    assert.equal(decodeEntities('&#128512;'), '😀');
    assert.equal(decodeEntities('&#xD800;'), '�');
    assert.equal(decodeEntities('&#0;'), '�');
    assert.equal(decodeEntities('&#146;'), '’', 'C1 range maps to Windows-1252 like browsers do');
    assert.equal(decodeEntities('&nosuchentity; & plain'), '&nosuchentity; & plain');
  });
});

describe('tokenize', () => {
  it('handles unquoted, single-quoted and double-quoted attributes; keys lowercased; first duplicate wins', () => {
    const [t] = tokenize(`<a HREF=/x CLASS='btn primary' title="it's > ok" href="/second" data-x>`);
    assert.equal(t.kind, 'open');
    assert.deepEqual(t.attrs, { href: '/x', class: 'btn primary', title: "it's > ok", 'data-x': '' });
  });
  it('keeps apostrophes inside double quotes and > inside quoted values', () => {
    const [m] = tokenize(`<meta name="description" content="Don't miss a > b">`);
    assert.equal(m.attrs.content, "Don't miss a > b");
  });
  it('parses tags spanning multiple lines', () => {
    const [m] = tokenize('<meta property="og:image"\n      content="https://x.test/a.png?w=1&amp;h=2"\n>');
    assert.equal(m.attrs.content, 'https://x.test/a.png?w=1&h=2');
  });
  it('consumes raw-text elements as one token with .content', () => {
    const toks = tokenize('<script type="text/javascript">var a = "<h1>x</h1>";</script><style>.a>b{}</style><template><h2>t</h2></template><noscript><img src=x></noscript><textarea><p>y</p></textarea><svg><title>s</title></svg>');
    assert.deepEqual(toks.map((t) => t.kind), ['raw', 'raw', 'raw', 'raw', 'raw', 'raw']);
    assert.equal(toks[0].content, 'var a = "<h1>x</h1>";');
    assert.equal(toks[5].content, '<title>s</title>');
  });
  it('treats void elements and "/>" as self tokens; a literal < in text stays text', () => {
    assert.deepEqual(tokenize('<div/><img src=a.png/><br>').map((t) => [t.kind, t.name]), [['self', 'div'], ['self', 'img'], ['self', 'br']]);
    assert.deepEqual(tokenize('<p>a < b and 3 > 2</p>').map((t) => t.kind), ['open', 'text', 'close']);
  });
  it('emits comment and doctype tokens', () => {
    const toks = tokenize('<!DOCTYPE html><!-- hi --><p>x</p>');
    assert.equal(toks[0].kind, 'doctype');
    assert.equal(toks[1].kind, 'comment');
    assert.equal(toks[1].text, ' hi ');
  });
  it('applies implied end tags for p/li/td and ignores stray closes', () => {
    const toks = tokenize('<p>one<p>two</div><ul><li>a<li>b</ul><table><tr><td>c<td>d</table>');
    const opens = toks.filter((t) => t.kind === 'open').map((t) => [t.name, toks[t.end_idx] ? toks[t.end_idx].name : 'EOF']);
    assert.deepEqual(opens, [['p', 'p'], ['p', 'ul'], ['ul', 'ul'], ['li', 'li'], ['li', 'ul'], ['table', 'table'], ['tr', 'table'], ['td', 'td'], ['td', 'table']]);
    assert.equal(toks.find((t) => t.kind === 'close' && t.name === 'div').stray, true);
  });
  it('tracks landmark regions, including role-based landmarks, with header only counting inside main/article', () => {
    const toks = tokenize('<header><h2>a</h2></header><div role="navigation"><a href=/>n</a></div><main><article><header><h1>b</h1></header></article></main><footer>f</footer>');
    const byText = (s) => toks.find((t) => t.kind === 'text' && t.text === s);
    assert.equal(byText('a').region, 'header'); assert.equal(inContent(byText('a')), false);
    assert.equal(byText('n').region, 'nav'); assert.equal(inContent(byText('n')), false);
    assert.equal(byText('b').region, 'header'); assert.deepEqual([...byText('b').regions], ['main', 'article', 'header']); assert.equal(inContent(byText('b')), true);
    assert.equal(inContent(byText('f')), false);
  });
  it('innerText flattens inline children and separates blocks with spaces', () => {
    const toks = tokenize('<div><b>W</b>ord<br>next<p>para</p></div>');
    assert.equal(innerText(toks, 0), 'Word next para');
  });
  it('inline-level controls (button/select) do not implicitly close an open <p>', () => {
    const toks = tokenize('<p>Text <button>Go</button> more words here</p><p>next</p>');
    const p = toks[0];
    assert.equal(p.name, 'p');
    assert.equal(toks[p.end_idx].kind, 'close', 'the <p> ends at its own </p>, not at <button>');
    assert.equal(innerText(toks, 0), 'Text Go more words here');
    assert.equal(extractPassages(toks, { minWords: 5 })[0].text, 'Text Go more words here');
  });
});

describe('parseDocument on malformed.html', () => {
  it('head: title (first wins, count), lang, charset with byte offset, base href', () => {
    assert.deepEqual(doc.title, { value: 'Don\'t Miss Our "Spring" Sale … Save 40%', count: 2 });
    assert.equal(doc.lang, 'en-GB');
    assert.equal(doc.charset.value, 'utf-8');
    assert.equal(typeof doc.charset.offset_bytes, 'number');
    assert.ok(doc.charset.offset_bytes < 1024);
    assert.equal(doc.base_href, 'https://example.test/sale/');
    assert.equal(doc.effective_base, 'https://example.test/sale/');
  });
  it('metas: apostrophes, entities, single quotes, multi-line tags, > in values', () => {
    const meta = (n) => doc.metas.find((m) => m.name === n).content;
    const prop = (p) => doc.metas.find((m) => m.property === p).content;
    assert.equal(meta('description'), 'A guide to the "Spring" sale: Don\'t miss it ’ you\'ll love it — really');
    assert.equal(meta('keywords'), 'spring, sale, discounts');
    assert.equal(prop('og:title'), 'Spring sale\nacross lines');
    assert.equal(prop('og:image'), 'https://example.test/img/og.png?w=1200&h=630');
    assert.equal(prop('og:description'), "Compare a > b and 'quotes' inside a double-quoted value");
  });
  it('robots_meta collects robots + googlebot tags with lowercased names', () => {
    assert.deepEqual(doc.robots_meta, [{ name: 'robots', content: 'noindex, follow' }, { name: 'googlebot', content: 'max-snippet:-1, max-image-preview:large' }]);
  });
  it('reports ALL canonicals (incl. unquoted), each with source', () => {
    assert.deepEqual(doc.canonicals.map((c) => [c.href, c.source]), [['https://example.test/sale/spring', 'link'], ['https://example.test/sale/spring-2', 'link']]);
  });
  it('hreflang and stylesheets', () => {
    assert.deepEqual(doc.hreflang.map((h) => h.hreflang), ['en-GB', 'es']);
    assert.deepEqual(doc.stylesheets, [{ href: '/css/site.css', abs: 'https://example.test/css/site.css', media: 'screen' }]);
  });
  it('anchors: 14 real links, decoys in script/template/noscript/svg excluded', () => {
    assert.equal(doc.anchors.length, 14);
    for (const decoy of ['/script-decoy', '/template-decoy', '/noscript-decoy', '/svg-decoy']) assert.equal(byHref(decoy), undefined, decoy + ' must not be extracted');
  });
  it('anchors: rel flags, regions, internal/external (www-insensitive), fragment_only, duplicate attr, image-alt fallback', () => {
    const partner = byHref('https://partner.example/deal');
    assert.deepEqual([partner.nofollow, partner.sponsored, partner.ugc, partner.internal, partner.region, partner.in_content], [true, true, false, false, 'nav', false]);
    assert.equal(byHref('/sale/details').ugc, true);
    assert.equal(byHref('#top').fragment_only, true);
    assert.equal(byHref('https://www.example.test/about').internal, true, 'www vs apex is the same site');
    assert.equal(byHref('mailto:hi@example.test').internal, false);
    assert.equal(byHref('mailto:hi@example.test').scheme, 'mailto');
    assert.equal(byHref('/sale/single-quoted').anchor, 'Single quoted link');
    assert.equal(byHref('/sale/unquoted').anchor, 'Unquoted link');
    assert.equal(byHref('/sale/unquoted').abs, 'https://example.test/sale/unquoted');
    assert.equal(byHref('/first').anchor, 'Duplicate attribute');
    assert.equal(byHref('/second'), undefined);
    assert.equal(byHref('/authors/sam').in_content, true, 'header inside article is content');
    assert.equal(byHref('/authors/sam').abs, 'https://example.test/authors/sam');
    assert.deepEqual([byHref('/img/big.jpg').anchor, byHref('/img/big.jpg').anchor_source], ['Thumbnail of the big image', 'image-alt']);
    assert.equal(byHref('/related-1').region, 'aside');
    assert.equal(byHref('/privacy').region, 'footer');
  });
  it('headings: apostrophes and entities decoded, header-in-article H1 is content, top-level header H2 is not', () => {
    assert.deepEqual(doc.headings.map((h) => [h.level, h.text, h.in_content]), [
      [2, 'Site tagline heading in the top-level header', false],
      [1, "Don't miss the Spring sale – up to 40% off", true],
      [2, "What's included?", true],
      [2, 'Related', false],
    ]);
  });
  it('images: lazy/data-src, srcset, width="100%" unsized, decoys excluded, src never inferred from data-src', () => {
    assert.equal(doc.images.length, 5);
    const [hero, lazy, product, noalt] = doc.images;
    assert.deepEqual([hero.width, hero.height, hero.sized], ['100%', 'auto', false]);
    assert.equal(lazy.lazy, true);
    assert.equal(lazy.data_src, '/img/lazy-1.jpg');
    assert.match(lazy.src, /^data:image/);
    assert.deepEqual([lazy.alt, lazy.alt_present, lazy.sized], ['', true, true]);
    assert.deepEqual(product.srcset, ['/img/product-480.jpg', '/img/product-960.jpg']);
    assert.equal(product.abs, 'https://example.test/img/product.jpg');
    assert.deepEqual([noalt.alt, noalt.alt_present, noalt.sized], [null, false, true]);
    assert.equal(doc.images.find((i) => i.src === 'decoy.png' || i.src === '/pixel.gif' || i.src === '/script-decoy.png'), undefined);
    assert.deepEqual(doc.images.map((i) => i.bound), [[], [], [], [], []], 'no framework bindings in this fixture');
  });
  it('images: a framework-bound src/alt is recorded, so an absent attribute is not read as an empty one', () => {
    const bound = parseDocument('<main><img v-if="p" :src="p.image" :alt="p.title" width="96" height="96">'
      + '<img x-bind:src="s" [alt]="t"><img v-bind:alt="t" src="/x.png"><img src="/y.png" alt="plain"></main>', 'https://example.test/').images;
    assert.deepEqual(bound.map((i) => i.bound), [[':src', ':alt'], ['x-bind:src', '[alt]'], ['v-bind:alt'], []]);
    assert.deepEqual([bound[0].src, bound[0].alt_present], [null, false], 'the plain attributes really are absent from the static HTML');
  });
  it('jsonld: MIME match ignores params/case/whitespace; invalid JSON reported, never guessed', () => {
    assert.deepEqual(doc.jsonld.map((b) => [b.ok, b.type]), [[true, ['Organization']], [true, ['WebSite']], [false, []]]);
    assert.equal(typeof doc.jsonld[2].error, 'string');
    assert.equal(doc.jsonld[2].data, null);
  });
  it('scripts, microdata, rdfa, iframes, forms, landmarks', () => {
    assert.deepEqual(doc.scripts.map((s) => [s.src, s.type]), [[null, 'text/javascript']]);
    assert.equal(doc.microdata_items, 1);
    assert.equal(doc.rdfa_typeof, 1);
    assert.deepEqual(doc.iframes.map((f) => [f.src, f.title]), [['https://video.example/embed/1', 'Video']]);
    assert.deepEqual(doc.forms.map((f) => [f.action, f.method, f.inputs, f.labeled]), [['/subscribe', 'post', 2, 1]]);
    assert.deepEqual(doc.landmarks, { main: 1, article: 1, nav: 1, header: 2, footer: 1, aside: 1 });
  });
  it('markers: generator captured, no framework false positives', () => {
    assert.equal(doc.markers.generator, 'ExampleCMS 9.1');
    for (const k of ['next_data', 'nuxt', 'reactroot', 'angular', 'sveltekit', 'astro', 'remix', 'noscript_js_notice']) assert.equal(doc.markers[k], false, k);
    assert.equal(doc.markers.next_root_empty, null);
  });
  it('word_count and text_sample use content regions only; comments sampled', () => {
    assert.ok(doc.word_count > 50 && doc.word_count < 200, 'word_count ' + doc.word_count);
    assert.match(doc.text_sample, /^Don't miss the Spring sale – up to 40% off/);
    assert.match(doc.text_sample, /you've waited for…/);
    for (const boiler of ['Site tagline', 'Privacy', 'Related one', 'Home', 'Partner offer', 'textarea decoy', 'SVG title decoy', 'Decoy second title']) assert.doesNotMatch(doc.text_sample, new RegExp(boiler), boiler + ' must not be in content text');
    assert.deepEqual(doc.html_comments_sample, ['built by a human', 'second comment: keep this one short']);
  });
});

describe('parseDocument markers on synthetic shells', () => {
  it('detects empty Next/Nuxt/SPA roots, hydration markers and noscript JS notices', () => {
    const next = parseDocument('<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script></body></html>');
    assert.deepEqual([next.markers.next_data, next.markers.next_assets, next.markers.next_root_empty], [true, true, true]);
    const nuxt = parseDocument('<div id="__nuxt"><p>hydrated content</p></div><script>window.__NUXT__={}</script>');
    assert.deepEqual([nuxt.markers.nuxt, nuxt.markers.app_root_empty], [true, false]);
    const spa = parseDocument('<div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><app-root ng-version="17.0.0"></app-root>');
    assert.deepEqual([spa.markers.app_root_empty, spa.markers.noscript_js_notice, spa.markers.angular], [true, true, true]);
    const others = parseDocument('<body data-sveltekit-preload-data="hover"><astro-island></astro-island><div data-reactroot=""></div><script>window.__remixContext = {}</script></body>');
    assert.deepEqual([others.markers.sveltekit, others.markers.astro, others.markers.reactroot, others.markers.remix], [true, true, true, true]);
  });
  it('resolves relative URLs against <base href> and reports internal null when the site is unknown', () => {
    const d = parseDocument('<base href="https://cdn.example/assets/"><a href="img/a.png">a</a><a href="https://other.example/">o</a>', null);
    assert.equal(d.anchors[0].abs, 'https://cdn.example/assets/img/a.png');
    assert.equal(d.anchors[0].internal, true, 'a relative href is internal by construction');
    assert.equal(d.anchors[1].internal, null, 'absolute href with no page URL: unknown, not guessed');
  });
});

describe('extractPassages', () => {
  const passages = extractPassages(MALFORMED, { minWords: 5 });
  it('returns p/li/blockquote blocks and leaf divs, skipping containers with block children', () => {
    assert.deepEqual(passages.map((p) => p.tag), ['p', 'p', 'p', 'div', 'li', 'li', 'blockquote', 'p', 'p']);
    assert.equal(passages.find((p) => p.tag === 'div').text, 'Leaf div with enough direct words to count as a passage here.');
    assert.equal(passages.filter((p) => p.text.startsWith('Every item')).length, 1, 'the wrapping div.card is not double-counted');
  });
  it('carries region, in_content and heading_before; unclosed <li> items are separate passages', () => {
    const lis = passages.filter((p) => p.tag === 'li');
    assert.deepEqual(lis.map((p) => p.text), ['First bullet with five words here', 'Second bullet with enough words too']);
    assert.equal(lis[0].heading_before, "What's included?");
    const footer = passages.find((p) => p.region === 'footer');
    assert.equal(footer.in_content, false);
    assert.equal(passages.find((p) => p.text.startsWith('Published')).in_content, true);
  });
  it('honours minWords and accepts a token array', () => {
    const toks = tokenize('<p>one two</p><p>one two three four five six</p>');
    assert.equal(extractPassages(toks, { minWords: 5 }).length, 1);
    assert.equal(extractPassages(toks, { minWords: 2 }).length, 2);
  });
});

describe('parseLinkHeader / sameUrl', () => {
  it('parses canonical and hreflang alternates, commas inside <> and quotes do not split', () => {
    const out = parseLinkHeader('<https://e.test/a>; rel="canonical", <https://e.test/es/a>; rel="alternate"; hreflang="es", </x,y>; rel=preload; as=style; title="a, b"');
    assert.deepEqual(out.map((l) => [l.href, l.rel, l.hreflang]), [['https://e.test/a', ['canonical'], null], ['https://e.test/es/a', ['alternate'], 'es'], ['/x,y', ['preload'], null]]);
    assert.equal(out[2].title, 'a, b');
    assert.deepEqual(parseLinkHeader(null), []);
    assert.equal(parseLinkHeader(['<https://e.test/1>; rel=canonical', '<https://e.test/2>; rel=next']).length, 2);
  });
  it('sameUrl ignores trailing slash, fragment and host case', () => {
    assert.equal(sameUrl('https://E.test/a/', 'https://e.test/a#x'), true);
    assert.equal(sameUrl('https://e.test/a', 'https://e.test/b'), false);
    assert.equal(sameUrl('/a', 'https://e.test/a', 'https://e.test/'), true);
  });
});

describe('util.mjs compat getters', () => {
  it('produce the legacy values on blog-post.html', () => {
    assert.equal(getTitle(BLOG), 'How to Optimize for AI Search in 2026');
    assert.equal(getMetaName(BLOG, 'description'), 'A practical guide to ranking in Google and getting cited by AI engines like ChatGPT and Perplexity in 2026.');
    assert.equal(getMetaName(BLOG, 'viewport'), null);
    assert.equal(getMetaProperty(BLOG, 'og:title'), 'How to Optimize for AI Search in 2026');
    assert.equal(getMetaProperty(BLOG, 'og:image'), null);
    assert.equal(getLinkRel(BLOG, 'canonical'), 'https://example.com/blog/ai-search-2026');
    assert.equal(getHtmlLang(BLOG), 'en');
    assert.equal(getCharset(BLOG), 'utf-8');
    assert.deepEqual(getHeadings(BLOG).map((h) => [h.level, h.text]), [[1, 'How to Optimize for AI Search in 2026'], [2, 'What is generative engine optimization?'], [2, 'Why does structured data matter?'], [3, 'How do I add JSON-LD?']]);
    assert.deepEqual(getImages(BLOG), [
      { src: 'diagram.png', altPresent: true, alt: 'Diagram showing the GEO workflow from content to citation', width: null, height: null },
      { src: 'hero.jpg', altPresent: false, alt: null, width: null, height: null },
    ]);
    assert.deepEqual(getLinks(BLOG).map((l) => [l.href, l.anchor]), [['/', 'Home'], ['/blog', 'Blog'], ['/blog', 'Read more'], ['https://schema.org/Article', 'schema.org Article spec']]);
    const jl = getJsonLd(BLOG);
    assert.equal(jl.length, 1);
    assert.deepEqual([jl[0].ok, jl[0].type, jl[0].data['@type']], [true, ['BlogPosting'], 'BlogPosting']);
  });
  it('now survive malformed markup', () => {
    assert.equal(getTitle(MALFORMED), 'Don\'t Miss Our "Spring" Sale … Save 40%');
    assert.equal(getMetaName(MALFORMED, 'Description'), 'A guide to the "Spring" sale: Don\'t miss it ’ you\'ll love it — really');
    assert.equal(getMetaName(MALFORMED, 'keywords'), 'spring, sale, discounts');
    assert.equal(getLinkRel(MALFORMED, 'canonical'), 'https://example.test/sale/spring');
    assert.equal(getHtmlLang(MALFORMED), 'en-GB');
    assert.equal(getHeadings(MALFORMED).length, 4);
    const imgs = getImages(MALFORMED);
    assert.equal(imgs.length, 5);
    assert.deepEqual([imgs[0].width, imgs[0].height], [null, null], 'width="100%"/height=auto are not pixel sizes');
    assert.deepEqual([imgs[1].width, imgs[1].height], ['640', '360']);
    assert.match(imgs[1].src, /^data:/, 'src is not inferred from data-src');
    assert.equal(getLinks(MALFORMED).length, 14);
    assert.equal(getJsonLd(MALFORMED).length, 3);
  });
  it('stripTags drops raw-text content and collapses whitespace', () => {
    assert.equal(stripTags('<b>a</b>  <script>var x = "<i>y</i>";</script> c'), 'a c');
    assert.equal(stripTags('plain   text'), 'plain text');
    assert.equal(stripTags('a < b'), 'a < b');
  });
});
