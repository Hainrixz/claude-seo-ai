#!/usr/bin/env node
// Extract and audit on-page SEO elements from a page (URL or file).
// Backs verification for M7 (title/meta/headings), M8 (social), M9 (images), M10 (links).
//
// Usage: node parse-html.mjs --url https://example.com
//        node parse-html.mjs --file ./index.html

import {
  parseArgs, emit, loadInput, getTitle, getMetaName, getMetaProperty,
  getLinkRel, getHtmlLang, getCharset, getHeadings, getImages, getLinks,
} from './lib/util.mjs';

function len(s) { return s == null ? 0 : [...s].length; }

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

const html = input.html;
const title = getTitle(html);
const description = getMetaName(html, 'description');
const robotsMeta = getMetaName(html, 'robots');
const canonical = getLinkRel(html, 'canonical');
const viewport = getMetaName(html, 'viewport');
const charset = getCharset(html);
const lang = getHtmlLang(html);
const headings = getHeadings(html);
const images = getImages(html);
const links = getLinks(html);

const h1s = headings.filter((h) => h.level === 1);
// detect skipped heading levels (e.g., h2 -> h4)
let lastLevel = 0, skips = [];
for (const h of headings) {
  if (lastLevel && h.level > lastLevel + 1) skips.push({ from: lastLevel, to: h.level, text: h.text.slice(0, 60) });
  lastLevel = h.level;
}

const imgMissingAlt = images.filter((i) => !i.altPresent);
const imgEmptyAlt = images.filter((i) => i.altPresent && (i.alt == null || i.alt.trim() === ''));
const imgNoDims = images.filter((i) => !i.width || !i.height);

const og = {
  title: getMetaProperty(html, 'og:title'),
  description: getMetaProperty(html, 'og:description'),
  image: getMetaProperty(html, 'og:image'),
  url: getMetaProperty(html, 'og:url'),
  type: getMetaProperty(html, 'og:type'),
};
const twitter = {
  card: getMetaName(html, 'twitter:card'),
  title: getMetaName(html, 'twitter:title'),
  image: getMetaName(html, 'twitter:image'),
};

emit({
  source: input.source,
  status: input.status,
  finalUrl: input.finalUrl || args.url || null,
  title: { value: title, length: len(title), ok: title != null && len(title) >= 30 && len(title) <= 60 },
  meta_description: { value: description, length: len(description), ok: description != null && len(description) >= 70 && len(description) <= 160 },
  robots_meta: robotsMeta,
  canonical,
  canonical_and_noindex: !!(canonical && robotsMeta && /noindex/i.test(robotsMeta)),
  head_hygiene: { viewport: !!viewport, charset: charset || null, lang: lang || null },
  headings: { counts: countByLevel(headings), h1_count: h1s.length, skipped_levels: skips },
  images: { total: images.length, missing_alt: imgMissingAlt.length, empty_alt: imgEmptyAlt.length, missing_dimensions: imgNoDims.length },
  open_graph: og,
  twitter_card: twitter,
  links: { total: links.length, generic_anchors: links.filter((l) => /^(click here|read more|here|link|more)$/i.test(l.anchor.trim())).length },
});

function countByLevel(hs) {
  const c = {};
  for (const h of hs) c['h' + h.level] = (c['h' + h.level] || 0) + 1;
  return c;
}
