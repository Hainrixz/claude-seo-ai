#!/usr/bin/env node
// Freshness & temporal-signal checks (M13): schema dates vs visible dates vs the
// HTTP Last-Modified header, plus content age. Never used to backdate anything.
//
// Usage: node check-freshness.mjs --url https://example.com/post
//        node check-freshness.mjs --file ./post.html

import { parseArgs, emit, loadInput, getJsonLd, decodeEntities } from './lib/util.mjs';

const ISO = /\b(\d{4}-\d{2}-\d{2})(T[\d:.+Z-]+)?\b/;
const VISIBLE = /\b(\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/i;

function collectDates(node, acc = { published: [], modified: [] }) {
  if (Array.isArray(node)) { for (const n of node) collectDates(n, acc); return acc; }
  if (node && typeof node === 'object') {
    if (node.datePublished) acc.published.push(String(node.datePublished));
    if (node.dateModified) acc.modified.push(String(node.dateModified));
    if (Array.isArray(node['@graph'])) for (const n of node['@graph']) collectDates(n, acc);
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') collectDates(node[k], acc);
  }
  return acc;
}

const daysSince = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 86400000); };

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

const blocks = getJsonLd(input.html).filter((b) => b.ok).map((b) => b.data);
const schemaDates = collectDates(blocks);

const timeTags = [...input.html.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
const visibleText = decodeEntities(input.html.replace(/<[^>]*>/g, ' '));
const visibleMatch = visibleText.match(VISIBLE);
const lastModified = input.headers && (input.headers['last-modified'] || null);

const modified = schemaDates.modified[0] || null;
const published = schemaDates.published[0] || null;

emit({
  source: input.source,
  schema_datePublished: published,
  schema_dateModified: modified,
  has_dateModified: !!modified,
  time_datetime_tags: timeTags.slice(0, 10),
  visible_date_sample: visibleMatch ? visibleMatch[0] : null,
  http_last_modified: lastModified,
  modified_age_days: modified ? daysSince(modified) : null,
  published_age_days: published ? daysSince(published) : null,
  schema_vs_lastmodified_mismatch:
    modified && lastModified && (ISO.exec(modified) || [])[1] !== isoFromHttp(lastModified)
      ? { schema: modified, header: lastModified } : null,
  note: 'Staleness is topic-dependent; flag, do not hard-fail on age alone. Never write a false/backdated dateModified.',
});

function isoFromHttp(h) { const t = Date.parse(h); if (Number.isNaN(t)) return null; return new Date(t).toISOString().slice(0, 10); }
