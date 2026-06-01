#!/usr/bin/env node
// Extract and validate JSON-LD structured data. Backs M5 (schema), M16 (author/Org),
// M18 (Product), M19 (LocalBusiness), M13 (dates).
//
// Usage: node validate-jsonld.mjs --url https://example.com [--type Article]
//        node validate-jsonld.mjs --file ./page.html
//
// Offline check only: valid JSON, recognized @type, presence of required/recommended
// properties per the Tier-1 template. It does NOT confirm Google rich-result eligibility
// (that needs the Rich Results Test, Tier 1) — callers should mark that status `needs_api`.

import { parseArgs, emit, loadInput, getJsonLd } from './lib/util.mjs';

// Required (hard) and recommended (soft) properties per Tier-1 type.
const SPEC = {
  Organization: { required: ['name'], recommended: ['url', 'logo', 'sameAs'] },
  WebSite: { required: ['name', 'url'], recommended: ['potentialAction'] },
  Article: { required: ['headline', 'author', 'datePublished'], recommended: ['image', 'dateModified', 'publisher'] },
  NewsArticle: { required: ['headline', 'author', 'datePublished'], recommended: ['image', 'dateModified', 'publisher'] },
  BlogPosting: { required: ['headline', 'author', 'datePublished'], recommended: ['image', 'dateModified', 'publisher'] },
  Person: { required: ['name'], recommended: ['sameAs', 'jobTitle'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  Product: { required: ['name'], recommended: ['image', 'offers', 'aggregateRating', 'brand'] },
  Offer: { required: ['price', 'priceCurrency'], recommended: ['availability', 'url'] },
  Review: { required: ['reviewRating'], recommended: ['author', 'itemReviewed'] },
  AggregateRating: { required: ['ratingValue'], recommended: ['reviewCount', 'ratingCount'] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHoursSpecification', 'geo'] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'duration'] },
  Event: { required: ['name', 'startDate'], recommended: ['location', 'offers'] },
};
const DEPRECATED_RICHRESULT = ['FAQPage', 'HowTo']; // still valid schema, no Google rich result

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

const blocks = getJsonLd(input.html);
const nodes = [];
for (const b of blocks) {
  if (!b.ok) { nodes.push({ valid_json: false, error: b.error, raw: b.raw.slice(0, 200) }); continue; }
  flatten(b.data).forEach((n) => nodes.push(evaluateNode(n)));
}

const wanted = args.type ? nodes.filter((n) => (n.types || []).includes(args.type)) : nodes;

emit({
  source: input.source,
  finalUrl: input.finalUrl || args.url || null,
  blocks_found: blocks.length,
  invalid_json_blocks: blocks.filter((b) => !b.ok).length,
  nodes: wanted,
  types_present: [...new Set(nodes.flatMap((n) => n.types || []))].sort(),
  deprecated_richresult_types_present: nodes.flatMap((n) => n.types || []).filter((t) => DEPRECATED_RICHRESULT.includes(t)),
});

function flatten(data, acc = []) {
  if (Array.isArray(data)) { for (const d of data) flatten(d, acc); return acc; }
  if (data && typeof data === 'object') {
    if (Array.isArray(data['@graph'])) { for (const d of data['@graph']) flatten(d, acc); }
    if (data['@type']) acc.push(data);
  }
  return acc;
}

function typesOf(node) {
  const t = node['@type'];
  return Array.isArray(t) ? t : (t ? [t] : []);
}

function evaluateNode(node) {
  const types = typesOf(node);
  const out = { valid_json: true, types, has_id: '@id' in node, missing_required: [], missing_recommended: [] };
  for (const t of types) {
    const spec = SPEC[t];
    if (!spec) continue;
    for (const p of spec.required) if (!(p in node)) out.missing_required.push(t + '.' + p);
    for (const p of spec.recommended) if (!(p in node)) out.missing_recommended.push(t + '.' + p);
  }
  out.known_type = types.some((t) => SPEC[t]);
  out.deprecated_richresult = types.some((t) => DEPRECATED_RICHRESULT.includes(t));
  return out;
}
