#!/usr/bin/env node
// Extract and audit on-page SEO elements from a page (URL or file).
// Backs verification for M7 (title/meta/headings), M8 (social), M9 (images), M10 (links).
//
// Usage: node parse-html.mjs --url https://example.com
//        node parse-html.mjs --file ./index.html [--url https://example.com/page]   (--url gives the page URL for canonical checks)
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// Built on lib/html.mjs parseDocument(). Every v0.1.0 output key is kept; additions:
// canonicals[] (link + HTTP Link header, all of them), canonical_count, canonical_conflict,
// canonical_target ('self'|'other'|'unknown'|null), self_canonical_noindex, robots_meta_all[],
// hreflang_count, base_href, markers, word_count, landmarks, extra image/link/heading counters.
// canonical_and_noindex is true ONLY when a canonical points to a different URL than the page
// while robots meta says noindex; a self-canonical + noindex is reported as self_canonical_noindex.
// When the page URL is unknown (--file without --url) canonical_and_noindex is null, not a guess.

import { EXIT, isMain, runCli, loadInput, inputFailure, parseDocument, parseLinkHeader, sameUrl } from './lib/util.mjs';

const GENERIC_ANCHOR = /^(click here|read more|here|link|more)$/i;

function len(s) { return s == null ? 0 : [...s].length; }

function countByLevel(hs) {
  const c = {};
  for (const h of hs) c['h' + h.level] = (c['h' + h.level] || 0) + 1;
  return c;
}

function metaProp(doc, prop) {
  const m = doc.metas.find((x) => x.property === prop && x.content !== null);
  return m ? m.content : null;
}
function metaName(doc, name) {
  const m = doc.metas.find((x) => x.name === name && x.content !== null);
  return m ? m.content : null;
}

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;

  const pageUrl = input.finalUrl || args.url || null;
  const doc = parseDocument(input.html, pageUrl);

  // Canonicals: every <link rel=canonical> plus any HTTP Link header canonical.
  const canonicals = doc.canonicals.map((c) => ({ href: c.href, abs: c.abs, source: c.source }));
  const linkHeader = parseLinkHeader(input.headers && input.headers.link);
  for (const l of linkHeader) {
    if (l.rel.includes('canonical')) {
      let abs = null; try { abs = new URL(l.href, pageUrl || undefined).href; } catch { /* keep null */ }
      canonicals.push({ href: l.href, abs, source: 'header' });
    }
  }
  const canonical = canonicals.length ? canonicals[0].href : null;
  const canonicalTargets = [...new Set(canonicals.map((c) => c.abs || c.href))];
  const canonicalConflict = canonicalTargets.length > 1 && !canonicalTargets.every((u) => sameUrl(u, canonicalTargets[0], pageUrl || undefined));

  const robotsMeta = metaName(doc, 'robots');
  const noindex = doc.robots_meta.some((r) => (r.name === 'robots' || r.name === 'googlebot') && /\bnoindex\b/i.test(r.content || ''));
  let canonicalTarget = null;
  if (canonicals.length) {
    if (!pageUrl) canonicalTarget = 'unknown';
    else canonicalTarget = canonicals.every((c) => sameUrl(c.abs || c.href, pageUrl, pageUrl)) ? 'self' : 'other';
  }
  const canonicalAndNoindex = !noindex || !canonicals.length ? false : (canonicalTarget === 'unknown' ? null : canonicalTarget === 'other');
  const selfCanonicalNoindex = noindex && canonicalTarget === 'self';

  const headings = doc.headings.filter((h) => !h.aria);
  const h1s = headings.filter((h) => h.level === 1);
  let lastLevel = 0; const skips = [];
  for (const h of headings) {
    if (lastLevel && h.level > lastLevel + 1) skips.push({ from: lastLevel, to: h.level, text: h.text.slice(0, 60) });
    lastLevel = h.level;
  }

  const images = doc.images;
  const imgMissingAlt = images.filter((i) => !i.alt_present);
  const imgEmptyAlt = images.filter((i) => i.alt_present && (i.alt == null || i.alt.trim() === ''));
  const imgNoDims = images.filter((i) => !i.sized);

  const og = {
    title: metaProp(doc, 'og:title'),
    description: metaProp(doc, 'og:description'),
    image: metaProp(doc, 'og:image'),
    url: metaProp(doc, 'og:url'),
    type: metaProp(doc, 'og:type'),
  };
  const twitter = {
    card: metaName(doc, 'twitter:card'),
    title: metaName(doc, 'twitter:title'),
    image: metaName(doc, 'twitter:image'),
  };

  const links = doc.anchors;
  const title = doc.title.value;
  const description = metaName(doc, 'description');
  const hreflangCount = doc.hreflang.length + linkHeader.filter((l) => l.rel.includes('alternate') && l.hreflang).length;

  const result = {
    source: input.source,
    status: input.status,
    finalUrl: pageUrl,
    title: { value: title, length: len(title), ok: title != null && len(title) >= 30 && len(title) <= 60, count: doc.title.count },
    meta_description: { value: description, length: len(description), ok: description != null && len(description) >= 70 && len(description) <= 160 },
    robots_meta: robotsMeta,
    robots_meta_all: doc.robots_meta,
    canonical,
    canonicals,
    canonical_count: canonicals.length,
    canonical_conflict: canonicalConflict,
    canonical_target: canonicalTarget,
    canonical_and_noindex: canonicalAndNoindex,
    self_canonical_noindex: selfCanonicalNoindex,
    base_href: doc.base_href,
    hreflang_count: hreflangCount,
    head_hygiene: { viewport: !!metaName(doc, 'viewport'), charset: doc.charset.value || null, charset_offset_bytes: doc.charset.offset_bytes, lang: doc.lang || null },
    headings: {
      counts: countByLevel(headings), h1_count: h1s.length, skipped_levels: skips,
      h1_in_content: h1s.filter((h) => h.in_content).length, total: headings.length,
      in_content: headings.filter((h) => h.in_content).length,
    },
    images: {
      total: images.length, missing_alt: imgMissingAlt.length, empty_alt: imgEmptyAlt.length, missing_dimensions: imgNoDims.length,
      lazy: images.filter((i) => i.lazy).length, with_srcset: images.filter((i) => i.srcset.length > 0).length,
      data_src_only: images.filter((i) => i.data_src != null && (i.src == null || /^data:/i.test(i.src))).length,
    },
    open_graph: og,
    twitter_card: twitter,
    links: {
      total: links.length,
      generic_anchors: links.filter((l) => GENERIC_ANCHOR.test(l.anchor.trim())).length,
      internal: links.filter((l) => l.internal === true).length,
      external: links.filter((l) => l.internal === false && l.scheme === 'http').length,
      unresolved: links.filter((l) => l.internal === null).length,
      in_content: links.filter((l) => l.in_content).length,
      nofollow: links.filter((l) => l.nofollow).length,
      sponsored: links.filter((l) => l.sponsored).length,
      ugc: links.filter((l) => l.ugc).length,
      fragment_only: links.filter((l) => l.fragment_only).length,
      empty_anchors: links.filter((l) => !l.anchor).length,
    },
    markers: doc.markers,
    word_count: doc.word_count,
    landmarks: doc.landmarks,
    structured_data: { jsonld_blocks: doc.jsonld.length, jsonld_invalid: doc.jsonld.filter((b) => !b.ok).length, microdata_items: doc.microdata_items, rdfa_typeof: doc.rdfa_typeof },
  };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
