// Platform-conditional checks for Shopify (plan 3c). They only run when detect-platform.mjs put a
// medium/high-confidence `shopify` verdict in the run's profile.json — a low-confidence guess never
// produces platform findings.
//
// Two things this file is careful about:
//   * Platform-owned surfaces (the generated sitemap) are emitted as `not_applicable` naming
//     Shopify as the owner, so the generic M17 advice is not offered for something a merchant
//     cannot edit.
//   * Anything that needs the theme source (robots.txt.liquid) is `needs_api` when no theme is
//     available, never a guess from the rendered output.

import { isAllowed } from '../lib/robots.mjs';
import {
  mk, push, clip, listing, plural, contentPages, finalUrl, platformId, originOf, urlKey,
  hreflangEntries, jsonldBlocks,
} from './_shared.mjs';
import { flattenNodes, disambiguateRootPaths, classifyProductNodes, isProductNode, variantNodeSet } from '../lib/jsonld.mjs';

/** Synthetic paths used to ask robots.txt what it allows; they are never fetched. */
export const PROBE_PATHS = Object.freeze({
  tagCombo: '/collections/all/tag-one+tag-two',
  filter: '/collections/all?filter.v.price.gte=10',
  sort: '/collections/all?sort_by=price-ascending',
});

const productNodesOf = (page) => {
  const out = [];
  for (const b of jsonldBlocks(page)) {
    if (b.data === undefined) continue;
    for (const n of flattenNodes(b.data)) out.push(n);
  }
  return disambiguateRootPaths(out);
};

/**
 * The nodes that together describe one declaration: a ProductGroup plus the variants it carries.
 * Google documents a variant as inheriting the group's properties and the group as the parent of
 * the variants' offers, so identifiers are looked for across the pair. Judging a `hasVariant` entry
 * on its own reported a correctly marked-up store as "ProductGroup.hasVariant[0] lacks brand, sku,
 * gtin, offers.url" when the group carried all three.
 *
 * Membership is object identity, never the path text: two sibling root ProductGroups (a theme and
 * an app both emitting one — exactly what duplicate_product_jsonld exists to report) share the
 * flatten path "ProductGroup", so a prefix match judged every group against the union of all their
 * variants: one group's brand satisfied the other, and a genuinely missing gtin was masked.
 */
const declarationGroup = (nodes, entry) => {
  const members = variantNodeSet(entry.node);
  return members.size ? [entry, ...nodes.filter((n) => n !== entry && members.has(n.node))] : [entry];
};

/** True when any node in the group carries `key` (or one of its gtin spellings). */
const anyHas = (group, key) => group.some((n) => n.node[key] || n.node[key + '13'] || n.node[key + '12'] || n.node[key + '14'] || n.node[key + '8']);

const offersOf = (node) => (Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : []);

export const check = {
  id: 'platform-shopify',
  module: 'M2',
  scope: 'site',
  // `ids` is the inventory of what this check can actually emit (knownIds() is built from it), so an
  // id with no code path behind it does not belong here. Shopify's `seo.hidden` metafield is not
  // implemented: from the storefront it is indistinguishable from any other noindex, which the
  // generic M2 indexability ids already report. See references/platforms/shopify.md §10.
  ids: [
    'M2.shopify.collection_path_duplicate', 'M2.shopify.variant_param_canonical', 'M2.shopify.collections_all_indexable',
    'M1.shopify.tag_combo_urls_crawlable', 'M1.shopify.filter_sort_urls_crawlable',
    'M1.shopify.robots_liquid_drops_defaults', 'M20.shopify.duplicate_hreflang', 'M5.shopify.theme_jsonld_gaps',
    'M5.shopify.duplicate_product_jsonld', 'M7.shopify.description_is_body_fallback', 'M17.shopify.sitemap_platform_owned',
  ],

  run(ctx) {
    const out = [];
    if (platformId(ctx) !== 'shopify') return out;
    const pages = contentPages(ctx);
    const origin = originOf(ctx);
    const robots = ctx.site && ctx.site.robots;
    const robotsUrl = (robots && robots.url) || (origin || '') + '/robots.txt';
    const robotsRepro = { script: 'parse-robots-sitemap.mjs', args: { url: robotsUrl, path: '/' } };
    const profileRepro = { script: 'detect-platform.mjs', args: { url: origin || '' } };

    /* ---- canonicalisation of collection-path and ?variant= URLs -------------------------------- */
    const collectionDupes = [];
    const variantDupes = [];
    for (const page of pages) {
      const url = finalUrl(page);
      const canonical = ((page.parsed && page.parsed.canonicals) || [])[0];
      const canonicalAbs = canonical && (canonical.abs || canonical.href);
      let u;
      try { u = new URL(url); } catch { continue; }
      const collectionPath = /^\/collections\/[^/]+\/products\/([^/?#]+)/.exec(u.pathname);
      if (collectionPath) {
        const expected = u.origin + '/products/' + collectionPath[1];
        if (!canonicalAbs || urlKey(canonicalAbs) !== urlKey(expected)) collectionDupes.push({ url, canonical: canonicalAbs, expected });
      }
      if (u.searchParams.has('variant')) {
        const base = u.origin + u.pathname;
        if (!canonicalAbs || urlKey(canonicalAbs) !== urlKey(base)) variantDupes.push({ url, canonical: canonicalAbs, expected: base });
      }
    }

    if (collectionDupes.length) {
      push(out, mk({
        id: 'M2.shopify.collection_path_duplicate', title: 'Collection-path product URLs do not canonicalise to /products/<handle>',
        status: 'fail', severity: 4, scope: 'template',
        location: { url: collectionDupes[0].url, resource: 'theme.liquid (canonical_url)' },
        evidence: { observed: listing(collectionDupes.map((d) => d.url + ' canonicalises to ' + (d.canonical || 'nothing') + ' instead of ' + d.expected), 3) + '.' },
        expected: 'Every /collections/<c>/products/<p> URL canonicalises to /products/<p>.',
        recommendation: 'Restore Shopify\'s `{{ canonical_url }}` in theme.liquid; a hard-coded or request-derived canonical breaks the platform default that collapses collection paths.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'A /collections/<c>/products/<p> URL returns a canonical of /products/<p>.' },
        reproduce: profileRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Shopify documents that the same product is reachable from every collection path and that canonical_url collapses them; without it the product exists at as many URLs as it has collections.' },
      }));
    }

    if (variantDupes.length) {
      push(out, mk({
        id: 'M2.shopify.variant_param_canonical', title: '?variant= URLs do not canonicalise to the base product URL',
        status: 'fail', severity: 3, scope: 'template',
        location: { url: variantDupes[0].url, resource: 'theme.liquid (canonical_url)' },
        evidence: { observed: listing(variantDupes.map((d) => d.url + ' canonicalises to ' + (d.canonical || 'nothing') + ' instead of ' + d.expected), 3) + '.' },
        expected: 'A ?variant= URL canonicalises to the product URL without the parameter.',
        recommendation: 'Use `{{ canonical_url }}` so variant selection does not create indexable duplicates.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'A ?variant= URL returns a canonical without the variant parameter.' },
        reproduce: profileRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Shopify documents canonical_url as stripping the variant parameter; overriding it publishes one indexable URL per variant.' },
      }));
    }

    /* ---- robots.txt defaults ------------------------------------------------------------------ */
    if (robots && robots.parsed) {
      const verdictFor = (path) => isAllowed(robots.parsed, 'Googlebot', (origin || '') + path);
      const tag = verdictFor(PROBE_PATHS.tagCombo);
      if (tag && tag.allowed) {
        push(out, mk({
          id: 'M1.shopify.tag_combo_urls_crawlable', title: 'Tag-combination collection URLs are crawlable',
          status: 'warn', severity: 3, scope: 'site',
          location: { url: robotsUrl, resource: 'robots.txt.liquid' },
          evidence: { observed: 'robots.txt allows Googlebot on ' + PROBE_PATHS.tagCombo + ' (via ' + tag.via + (tag.rule ? ', line ' + tag.rule.line : '') + '); Shopify\'s default group disallows `/collections/*/*+*` and the `%2B` form.' },
          expected: 'The default `Disallow: /collections/*+*` rules are present.',
          recommendation: 'Keep the `{% for group in robots.default_groups %}` loop in templates/robots.txt.liquid so the platform defaults are emitted; add custom rules after it, never instead of it.',
          fixable: 'auto',
          verification: { method: 'robots_parse', assertion: 'isAllowed(robots, "Googlebot", "' + PROBE_PATHS.tagCombo + '") is false.' },
          reproduce: robotsRepro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Tag combinations multiply crawlable URLs combinatorially; Shopify blocks them by default, but no vendor quantifies the crawl-budget cost.' },
        }));
      }
      const filter = verdictFor(PROBE_PATHS.filter);
      const sort = verdictFor(PROBE_PATHS.sort);
      const openParams = [filter && filter.allowed ? PROBE_PATHS.filter : null, sort && sort.allowed ? PROBE_PATHS.sort : null].filter(Boolean);
      if (openParams.length) {
        push(out, mk({
          id: 'M1.shopify.filter_sort_urls_crawlable', title: 'Filter and sort parameter URLs are crawlable',
          status: 'warn', severity: 2, scope: 'site',
          location: { url: robotsUrl, resource: 'robots.txt.liquid' },
          evidence: { observed: 'robots.txt allows Googlebot on ' + listing(openParams, 2) + '.' },
          expected: 'Parameter-only listing variants are blocked or canonicalised to the clean collection URL.',
          recommendation: 'Keep Shopify\'s default `*sort_by*` and filter rules, or canonicalise the parameter URLs to the collection.',
          fixable: 'proposed',
          verification: { method: 'robots_parse', assertion: 'Sorted and filtered collection URLs are disallowed or canonicalise to the clean collection URL.' },
          reproduce: robotsRepro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Sorted and filtered variants are near-duplicates; how much crawl they attract on a given store is not published.' },
        }));
      }
    } else {
      push(out, mk({
        id: 'M1.shopify.robots_liquid_drops_defaults', title: 'Whether robots.txt.liquid keeps the platform defaults was not checked',
        status: 'needs_api', scope: 'site',
        location: { url: robotsUrl, resource: 'templates/robots.txt.liquid' },
        evidence: { observed: 'No parsed robots.txt in ' + ctx.run_dir + ', and no theme source is available, so the `{% for group in robots.default_groups %}` loop could not be inspected.' },
        expected: 'The theme template still emits Shopify\'s default groups.',
        recommendation: 'Pull the theme (shopify theme pull) and check templates/robots.txt.liquid, or re-run the crawl so robots.txt is fetched.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'templates/robots.txt.liquid contains the default_groups loop, or robots.txt still carries the default rules.' },
        reproduce: robotsRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'A custom robots.txt.liquid that drops the loop silently removes every platform default; the file itself is the only evidence.' },
      }));
    }

    /* ---- /collections/all ---------------------------------------------------------------------- */
    const all = pages.find((p) => { try { return new URL(finalUrl(p)).pathname === '/collections/all'; } catch { return false; } });
    if (all) {
      const eff = all.snapshot && all.snapshot.robots_directives && all.snapshot.robots_directives.effective;
      if (!eff || !eff.noindex) {
        push(out, mk({
          id: 'M2.shopify.collections_all_indexable', title: '/collections/all is indexable', status: 'warn', severity: 1, scope: 'page',
          location: { url: finalUrl(all) },
          evidence: { observed: finalUrl(all) + ' returns HTTP ' + (all.status != null ? all.status : 'unknown') + ' with no noindex; it lists every product with ' + ((all.parsed && all.parsed.word_count) || 0) + ' words of its own copy.' },
          expected: 'Either a curated, described collection, or noindex.',
          recommendation: 'Give /collections/all its own description if it should rank, otherwise add noindex to it.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: '/collections/all carries noindex or unique descriptive content.' },
          reproduce: profileRepro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'A thin catch-all listing competes with the curated collections; Shopify does not document a recommended treatment.' },
        }));
      }
    }

    /* ---- theme JSON-LD ------------------------------------------------------------------------- */
    // Which nodes count is lib/jsonld.mjs's classifyProductNodes(), the same rule M5 and M18 use:
    // a `hasVariant` member, a review's `itemReviewed` and a url-only stub are pointers at a product
    // described elsewhere, not extra Product blocks the theme emitted. Counting them told a store
    // with one ProductGroup and 28 variants that it had "29 Product nodes" and asked it to delete
    // markup Google documents as correct.
    for (const page of pages) {
      const nodes = productNodesOf(page);
      const { declarations, variants, stubs, back_references: backRefs } = classifyProductNodes(nodes);
      if (!declarations.length) continue;
      const url = finalUrl(page);
      const pointers = [...variants, ...stubs, ...backRefs];
      const pointerNote = pointers.length
        ? ' (' + pointers.length + ' further Product-typed node' + (pointers.length === 1 ? '' : 's')
          + ' — ' + listing(pointers.map((n) => n.path), 3) + ' — point at items declared elsewhere and are not counted)'
        : '';

      if (declarations.length >= 2) {
        push(out, mk({
          id: 'M5.shopify.duplicate_product_jsonld', title: 'Two or more Product blocks on one product page', status: 'warn', severity: 3, scope: 'page',
          location: { url, resource: 'snippets/seo-structured-data.liquid' },
          evidence: { observed: declarations.length + ' Product nodes declared on ' + url + ': ' + listing(declarations.map((p) => p.path + ' "' + clip(p.node.name, 40) + '"'), 4) + pointerNote + '.' },
          expected: 'One Product node per product page.',
          recommendation: 'Usually the theme and an app both emit Product markup: remove one of the two sources.',
          fixable: 'proposed',
          verification: { method: 'schema_validator', assertion: 'The page emits exactly one Product node.' },
          reproduce: { script: 'validate-jsonld.mjs', args: { url } },
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents that conflicting duplicate markup for the same item can make it ignore the structured data.' },
        }));
      }

      const gaps = [];
      for (const p of declarations) {
        // A ProductGroup is judged with its variants: the group carries brand, the variants carry
        // sku/gtin and the variant URLs, and Google documents the inheritance between them.
        const group = declarationGroup(nodes, p);
        const miss = ['brand', 'sku', 'gtin'].filter((k) => !anyHas(group, k));
        if (!group.some((n) => offersOf(n.node).some((o) => o && o.url))) miss.push('offers.url');
        // Count the products under `hasVariant`, not the group's size: the group also holds each
        // variant's nested Offer nodes, which reported 83 variants as "97 variant nodes".
        if (miss.length) gaps.push({ path: p.path, miss, variants: group.filter((n) => isProductNode(n)).length - 1 });
      }
      if (gaps.length) {
        push(out, mk({
          id: 'M5.shopify.theme_jsonld_gaps', title: 'Theme Product markup omits identifiers Google asks for', status: 'warn', severity: 3, scope: 'template',
          location: { url, resource: 'snippets/seo-structured-data.liquid' },
          evidence: { observed: listing(gaps.map((g) => g.path + (g.variants > 0 ? ' (with its ' + plural(g.variants, 'variant node') + ')' : '') + ' lacks ' + listing(g.miss, 4)), 3) + ' on ' + url + '.' },
          expected: 'Product carries brand, sku, a gtin when one exists, and offers.url.',
          recommendation: 'Extend the theme\'s structured-data snippet with product.vendor (brand), variant.sku, variant.barcode (gtin) and the variant URL.',
          fixable: 'proposed',
          verification: { method: 'schema_validator', assertion: 'Product nodes expose brand, sku, gtin and offers.url.' },
          reproduce: { script: 'validate-jsonld.mjs', args: { url } },
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents brand, sku, gtin and offer url as recommended product properties that improve matching in shopping surfaces.' },
        }));
      }
    }

    /* ---- duplicate hreflang per locale ---------------------------------------------------------- */
    for (const page of pages) {
      const entries = hreflangEntries(page);
      if (!entries.length) continue;
      const counts = new Map();
      for (const e of entries) {
        const k = String(e.hreflang).toLowerCase();
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const dupes = [...counts.entries()].filter(([, n]) => n > 1);
      if (dupes.length) {
        push(out, mk({
          id: 'M20.shopify.duplicate_hreflang', title: 'More than one hreflang link per locale', status: 'fail', severity: 3, scope: 'page',
          location: { url: finalUrl(page), resource: 'theme.liquid' },
          evidence: { observed: listing(dupes.map(([tag, n]) => 'hreflang="' + tag + '" appears ' + n + ' times'), 4) + ' on ' + finalUrl(page) + ' (' + entries.length + ' alternate links in total).' },
          expected: 'One alternate link per locale.',
          recommendation: 'Shopify emits hreflang through `content_for_header`: remove the duplicate set the theme adds by hand rather than the platform one.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Each hreflang value appears exactly once in the head.' },
          reproduce: { script: 'hreflang-check.mjs', args: { url: finalUrl(page) } },
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that conflicting annotations for the same locale are ignored, so the duplicated entries can invalidate the cluster.' },
        }));
      }
    }

    /* ---- meta description that repeats the body lead --------------------------------------------- */
    for (const page of pages) {
      const parsed = page.parsed || {};
      const desc = ((parsed.metas || []).find((m) => m && m.name === 'description') || {}).content;
      if (!desc) continue;
      const lead = clip(parsed.text_sample || '', 400).toLowerCase();
      const head = clip(desc, 80).toLowerCase().replace(/…$/, '');
      if (head.length >= 40 && lead.includes(head)) {
        push(out, mk({
          id: 'M7.shopify.description_is_body_fallback', title: 'Meta description repeats the start of the body copy', status: 'warn', severity: 2, scope: 'page',
          location: { url: finalUrl(page), resource: 'Admin > SEO description' },
          evidence: { observed: 'The meta description on ' + finalUrl(page) + ' starts with "' + clip(desc, 90) + '", which also opens the page body — the Shopify fallback when the Admin SEO description is empty.' },
          expected: 'A written SEO description per product/collection.',
          recommendation: 'Fill the Admin "Search engine listing" description for this resource so Shopify stops falling back to the body text.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'The meta description differs from the opening of the body copy.' },
          reproduce: { script: 'parse-html.mjs', args: { url: finalUrl(page) } },
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'The fallback is a Shopify behaviour, not a defect Google documents; the cost is a snippet the merchant did not choose.' },
        }));
      }
    }

    /* ---- platform-owned sitemap ------------------------------------------------------------------ */
    push(out, mk({
      id: 'M17.shopify.sitemap_platform_owned', title: 'The XML sitemap is generated by Shopify and cannot be edited',
      status: 'not_applicable', scope: 'site',
      location: { url: (origin || '') + '/sitemap.xml', resource: 'Shopify-generated sitemap' },
      evidence: { observed: 'Owner: Shopify. The store\'s /sitemap.xml is generated by the platform; a merchant can only influence it by publishing/unpublishing resources or setting the seo.hidden metafield.' },
      expected: 'M17 sitemap fixes do not apply to this platform.',
      recommendation: 'To remove a URL from the sitemap, unpublish the resource or set its seo.hidden metafield — do not attempt to edit the file.',
      fixable: 'advisory',
      verification: { method: 'xml_parse', assertion: '/sitemap.xml is served by Shopify and no theme file generates it.' },
      reproduce: profileRepro,
      expected_impact: { axis: 'search', confidence: 'established', rationale: 'Shopify documents the sitemap as platform-generated and not editable; offering generic sitemap fixes here would waste the merchant\'s time.' },
    }));

    return out;
  },
};

export default check;
