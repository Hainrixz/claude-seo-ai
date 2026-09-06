// M18 (product block) — Offer completeness, faceted URLs, variant modelling and per-product
// catalogue eligibility. Runs once over the run so faceted URLs can be compared across the crawl
// and a supplied feed can be joined to the pages by URL.
//
// Boundary with M5: M5.product.missing_offer_price fires when a Product has no `offers` at all;
// M18.offer.missing_price fires when the Offer exists but its price or priceCurrency does not.
// Nothing is reported twice.

import { readFileSync } from 'node:fs';
import { flattenNodes } from '../lib/jsonld.mjs';
import { detectFormat, parseFeed, canonicalizeRow, parsePrice } from '../acp-feed-lint.mjs';
import {
  mk, push, clip, listing, plural, contentPages, finalUrl, isEcommerce, snapRepro, urlKey, numericPrice,
} from './_shared.mjs';

/** Query keys that mark a faceted/sorted listing URL rather than a distinct page. */
export const FACET_KEYS = ['filter', 'color', 'colour', 'size', 'sort', 'sort_by', 'orderby', 'order', 'price', 'brand', 'material', 'style', 'pa_color', 'pa_size', 'variant'];

const isFacetKey = (k) => {
  const key = String(k).toLowerCase();
  return FACET_KEYS.includes(key) || key.startsWith('filter.') || key.startsWith('filter_') || key.startsWith('pa_');
};

function productNodes(page) {
  const out = [];
  for (const b of (page.parsed && page.parsed.jsonld) || []) {
    if (!b || b.ok === false || b.data === undefined) continue;
    for (const n of flattenNodes(b.data)) out.push(n);
  }
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Load the supplied feed into a URL -> row map, so a page can be joined to its feed entry. */
function feedIndex(feedPath) {
  let text;
  try { text = readFileSync(feedPath, 'utf8'); } catch { return null; }
  const format = detectFormat(text, feedPath);
  const parsedFeed = parseFeed(text, format);
  const byUrl = new Map();
  for (const raw of parsedFeed.rows || []) {
    const { row } = canonicalizeRow(raw);
    const key = urlKey(row.url);
    if (key && !byUrl.has(key)) byUrl.set(key, row);
  }
  return { byUrl, rows: (parsedFeed.rows || []).length, format };
}

export const check = {
  id: 'ecommerce',
  module: 'M18',
  scope: 'site',
  ids: [
    'M18.offer.missing_price', 'M18.offer.price_feed_mismatch', 'M18.facets.uncanonicalized',
    'M18.variants.no_productgroup', 'M18.agentic.catalog_eligibility', 'M18.agentic.feed_page_price_mismatch',
  ],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx);
    const withProduct = pages.filter((p) => productNodes(p).some((n) => n.types.includes('Product')));
    if (!isEcommerce(ctx) && !withProduct.length) return out;

    const feedPath = ctx.options && ctx.options.feed_path;
    const feed = feedPath ? feedIndex(feedPath) : null;

    for (const page of withProduct) {
      const url = finalUrl(page);
      const at = { location: { url } };
      const repro = snapRepro(ctx, page, 'validate-jsonld.mjs');
      const nodes = productNodes(page);
      const products = nodes.filter((n) => n.types.includes('Product'));
      const offers = nodes.filter((n) => n.types.some((t) => t === 'Offer' || t === 'AggregateOffer'));

      /* ---- Offer without price / currency --------------------------------------------------- */
      const incomplete = offers.filter((n) => {
        const price = n.node.price != null ? n.node.price : n.node.lowPrice;
        return price == null || String(price).trim() === '' || !n.node.priceCurrency;
      });
      if (incomplete.length) {
        push(out, mk({
          id: 'M18.offer.missing_price', title: 'Offer markup is missing price or priceCurrency', status: 'fail', severity: 4, scope: 'page', ...at,
          evidence: { observed: listing(incomplete.map((n) => n.path + ' -> price=' + JSON.stringify(n.node.price != null ? n.node.price : n.node.lowPrice) + ', priceCurrency=' + JSON.stringify(n.node.priceCurrency)), 3) + ' on ' + url + '.' },
          expected: 'Every Offer carries a numeric price and an ISO 4217 priceCurrency.',
          recommendation: 'Emit price and priceCurrency from the same source the page renders the price from.',
          fixable: 'auto',
          verification: { method: 'schema_validator', assertion: 'Every Offer node has a non-empty price and priceCurrency.' },
          reproduce: repro,
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents price and priceCurrency as required for product rich results; an Offer without them is ineligible.' },
        }));
      }

      /* ---- variants ------------------------------------------------------------------------- */
      const hasGroup = nodes.some((n) => n.types.includes('ProductGroup')) || products.some((p) => p.node.hasVariant);
      if (products.length >= 2 && !hasGroup) {
        push(out, mk({
          id: 'M18.variants.no_productgroup', title: 'Several Product blocks on one URL instead of a ProductGroup', status: 'warn', severity: 3, scope: 'page', ...at,
          evidence: { observed: products.length + ' separate Product nodes on ' + url + ' (' + listing(products.map((p) => p.path + ' "' + clip(p.node.name, 40) + '"'), 4) + ') and no ProductGroup/hasVariant.' },
          expected: 'A page with variants models them as one ProductGroup with hasVariant entries.',
          recommendation: 'Emit a ProductGroup carrying the shared attributes and a hasVariant array for the SKUs.',
          fixable: 'proposed',
          verification: { method: 'schema_validator', assertion: 'The page emits a ProductGroup with hasVariant instead of repeated Product nodes.' },
          reproduce: repro,
          expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Google documents ProductGroup for variants, but repeated Product blocks are still parsed, so the cost is in how variants are grouped rather than eligibility.' },
        }));
      }

      /* ---- catalogue eligibility -------------------------------------------------------------- */
      const p = products[0];
      if (p) {
        const offer = offers[0];
        const price = offer ? numericPrice(offer.node.price != null ? offer.node.price : offer.node.lowPrice) : null;
        const checks = {
          title: !!clip(p.node.name || '', 200),
          image: !!first(p.node.image) || ((page.parsed && page.parsed.images) || []).some((i) => i.in_content),
          price: price != null && price > 0,
          url: !!url,
          availability: !!(offer && offer.node.availability),
        };
        const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        const status = missing.length === 0 ? 'pass' : missing.length === 1 ? 'warn' : 'fail';
        push(out, mk({
          id: 'M18.agentic.catalog_eligibility', title: 'Per-product catalogue eligibility', status, severity: 3, scope: 'page', ...at,
          evidence: { observed: url + ': title=' + (checks.title ? '"' + clip(p.node.name, 50) + '"' : 'missing') + ', image=' + (checks.image ? 'present' : 'missing') + ', price=' + (price != null ? price : 'missing') + ', url=present, availability=' + (checks.availability ? clip(first(offer.node.availability), 40) : 'missing') + '.' },
          expected: 'A product an agent can list carries a title, an image, a price above zero, a stable URL and a visible availability state.',
          recommendation: missing.length ? 'Supply the missing field(s): ' + listing(missing, 5) + '.' : 'No action needed — the product carries everything an agent needs to list it.',
          fixable: 'proposed',
          verification: { method: 'schema_validator', assertion: 'The Product/Offer pair exposes name, image, price > 0, url and availability.' },
          reproduce: repro,
          expected_impact: { axis: 'both', confidence: 'directional', rationale: 'The field list follows the shape shopping agents and product feeds require; no vendor publishes what happens to a partially described product.' },
        }));

        /* ---- feed join ------------------------------------------------------------------------ */
        if (feed) {
          const row = feed.byUrl.get(urlKey(url));
          if (row) {
            const feedPrice = parsePrice(row.price);
            const feedValue = feedPrice ? feedPrice.amount : numericPrice(row.price);
            if (feedValue != null && price != null && Math.abs(feedValue - price) >= 0.005) {
              push(out, mk({
                id: 'M18.offer.price_feed_mismatch', title: 'Feed price differs from the price in the page markup', status: 'warn', severity: 3, scope: 'page', ...at,
                evidence: { observed: 'Feed row for ' + url + ' declares price "' + clip(row.price, 30) + '"; the page\'s Offer markup declares ' + price + '.' },
                expected: 'The feed and the page agree on the price.',
                recommendation: 'Regenerate the feed from the same source as the page, and re-check after any price change propagates through the cache.',
                fixable: 'advisory',
                verification: { method: 'manual_review', assertion: 'The feed price for this item equals the Offer price on its page.' },
                reproduce: { script: 'acp-feed-lint.mjs', args: { feed: feedPath } },
                expected_impact: { axis: 'both', confidence: 'directional', rationale: 'A disagreement is exact; which side an agent trusts, and for how long, is not documented.' },
              }));
            }
            const feedAvail = row.availability ? String(row.availability).toLowerCase() : null;
            const pageAvail = checks.availability ? String(first(offer.node.availability)).toLowerCase() : null;
            const bothKnown = feedAvail && pageAvail;
            const disagree = bothKnown && !pageAvail.includes(feedAvail.replace(/[^a-z]/g, '')) && !feedAvail.includes(pageAvail.split('/').pop());
            if (disagree) {
              push(out, mk({
                id: 'M18.agentic.feed_page_price_mismatch', title: 'Feed availability disagrees with the page', status: 'warn', severity: 3, scope: 'page', ...at,
                evidence: { observed: 'Feed row for ' + url + ' declares availability "' + clip(row.availability, 30) + '"; the page\'s Offer declares "' + clip(first(offer.node.availability), 50) + '".' },
                expected: 'The feed and the page agree on availability.',
                recommendation: 'Publish availability from one source; an agent that buys from a stale feed fails at checkout.',
                fixable: 'advisory',
                verification: { method: 'manual_review', assertion: 'The feed availability for this item matches the Offer availability on its page.' },
                reproduce: { script: 'acp-feed-lint.mjs', args: { feed: feedPath } },
                expected_impact: { axis: 'both', confidence: 'directional', rationale: 'The disagreement is observable; the consequence depends on the agent\'s refresh policy, which is not published.' },
              }));
            }
          }
        } else if (isEcommerce(ctx)) {
          push(out, mk({
            id: 'M18.offer.price_feed_mismatch', title: 'Feed price could not be compared (no --feed supplied)', status: 'needs_api', scope: 'page', ...at,
            evidence: { observed: url + ' declares an Offer price of ' + (price == null ? 'none' : price) + '; no product feed was supplied, so the two could not be compared.' },
            expected: 'A feed passed with --feed so its price can be joined to the page.',
            recommendation: 'Re-run with --feed <path> to compare feed prices against the marked-up ones.',
            fixable: 'advisory',
            verification: { method: 'manual_review', assertion: 'The feed row for this URL carries the same price as the page.' },
            reproduce: { script: 'acp-feed-lint.mjs', args: { feed: '<feed file>' } },
            expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Without the feed there is no second value to compare, so the check is unmeasured rather than clean.' },
          }));
        }
      }
    }

    /* ---- faceted URLs across the crawl -------------------------------------------------------- */
    const faceted = [];
    for (const page of pages) {
      const url = finalUrl(page);
      let keys = [];
      try { keys = [...new URL(url).searchParams.keys()].filter(isFacetKey); } catch { keys = []; }
      if (!keys.length) continue;
      const eff = page.snapshot && page.snapshot.robots_directives && page.snapshot.robots_directives.effective;
      if (eff && eff.noindex) continue;
      const canonicals = ((page.parsed && page.parsed.canonicals) || []).map((c) => c.abs || c.href).filter(Boolean);
      const selfCanonical = !canonicals.length || urlKey(canonicals[0]) === urlKey(url);
      if (selfCanonical) faceted.push({ url, keys });
    }
    if (faceted.length) {
      push(out, mk({
        id: 'M18.facets.uncanonicalized', title: 'Faceted URLs are indexable and self-canonical', status: 'warn', severity: 3, scope: 'site',
        location: { url: faceted[0].url },
        evidence: { observed: plural(faceted.length, 'crawled URL') + ' carries facet/sort parameters, no noindex and no canonical to the clean URL: ' + listing(faceted.map((f) => f.url + ' (' + listing(f.keys, 3) + ')'), 4) + '.' },
        expected: 'Facet and sort combinations either canonicalise to the unfiltered listing or carry noindex.',
        recommendation: 'Point the canonical at the unfiltered listing for parameter-only variants, and keep indexable facets to the small set that has its own demand.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'Each faceted URL canonicalises to the clean listing or carries noindex.' },
        reproduce: pages.length ? snapRepro(ctx, pages[0], 'parse-html.mjs') : { script: 'parse-html.mjs', args: { url: faceted[0].url } },
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Google documents faceted navigation as a crawl-budget risk and recommends canonicalisation; the size of the effect depends on the number of combinations, which this crawl only sampled.' },
      }));
    }

    return out;
  },
};

export default check;
