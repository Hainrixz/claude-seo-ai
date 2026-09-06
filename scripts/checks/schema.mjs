// M5 — structured data, structurally. Every typed node in every ld+json block is flattened with
// lib/jsonld.mjs, so nested Offer/Person/AggregateRating nodes are judged too.
//
// Division of labour with M18: this module reports a Product that carries no Offer at all
// (M5.product.missing_offer_price); an Offer that exists but lacks price/priceCurrency belongs to
// M18.offer.missing_price. The two never fire on the same node.
//
// The contradiction check is deliberately narrow: it only fires when the page displays at least one
// price and none of the displayed prices matches the marked-up one. A page with no visible price is
// reported as nothing, because "the markup disagrees with the page" would then be unfalsifiable.

import { flattenNodes, disambiguateRootPaths, typesOf, classifyProductNodes, pathProperty, ownProps } from '../lib/jsonld.mjs';
import { contentMask, visibleText, classifyNumbers } from '../lib/passages.mjs';
import { detectLang } from '../lib/lang.mjs';
import { mk, push, clip, listing, plural, agree, finalUrl, isContentPage, snapRepro, tokensFor, numericPrice } from './_shared.mjs';

export const ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'ScholarlyArticle', 'Report', 'LiveBlogPosting'];
export const DEPRECATED_RICHRESULT = ['FAQPage', 'HowTo'];
/** Words of body copy below which a page with an <article> landmark is not treated as editorial. */
export const EDITORIAL_MIN_WORDS = 300;

/** The @type this page's template was clustered under, e.g. '/blog/*|Article' -> 'Article'. */
function templateType(page) {
  const key = page && page.template;
  if (typeof key !== 'string') return '';
  const i = key.lastIndexOf('|');
  return i === -1 ? '' : key.slice(i + 1);
}

function isEditorial(page) {
  if (ARTICLE_TYPES.includes(templateType(page))) return true;
  const parsed = page.parsed || {};
  return !!(parsed.landmarks && parsed.landmarks.article) && (parsed.word_count || 0) >= EDITORIAL_MIN_WORDS;
}

/** Every typed node of every parseable block, with the block index it came from. */
function nodesOf(page) {
  const out = [];
  const blocks = (page.parsed && page.parsed.jsonld) || [];
  blocks.forEach((b, i) => {
    if (!b || b.ok === false || b.data === undefined) return;
    for (const n of flattenNodes(b.data)) out.push({ ...n, block: i });
  });
  // Two roots of the same type (two blocks, or two members of one array) both flatten to their type
  // name, so the second is renamed "Product[1]": a finding that quotes a path must name one node.
  return disambiguateRootPaths(out);
}

export const check = {
  id: 'schema',
  module: 'M5',
  scope: 'page',
  ids: ['M5.jsonld.invalid_json', 'M5.article.missing', 'M5.product.missing_offer_price', 'M5.jsonld.contradicts_page', 'M5.faqpage.deprecated_richresult'],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const parsed = page.parsed || {};
    const url = finalUrl(page);
    const repro = snapRepro(ctx, page, 'validate-jsonld.mjs');
    const at = { location: { url } };

    /* ---- unparseable blocks ------------------------------------------------------------------ */
    const broken = ((parsed.jsonld) || []).filter((b) => b && b.ok === false);
    if (broken.length) {
      push(out, mk({
        id: 'M5.jsonld.invalid_json', title: 'A ld+json block does not parse', status: 'fail', severity: 4, scope: 'page', ...at,
        evidence: {
          observed: plural(broken.length, 'application/ld+json block') + ' on ' + url + ' failed to parse: ' + listing(broken.map((b) => clip(b.error, 80)), 3) + '.',
          snippet: clip(broken[0].raw, 200),
        },
        expected: 'Every ld+json block is valid JSON.',
        recommendation: 'Fix the JSON syntax (usually a trailing comma, an unescaped quote, or template output injected without escaping). Everything inside an unparseable block is invisible to consumers.',
        fixable: 'auto',
        verification: { method: 'schema_validator', assertion: 'JSON.parse succeeds on every application/ld+json block.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents that it ignores structured data it cannot parse; every type inside the broken block is lost.' },
      }));
    }

    const nodes = nodesOf(page);
    const allTypes = [...new Set(nodes.flatMap((n) => n.types))];

    /* ---- editorial page without Article ------------------------------------------------------ */
    if (isEditorial(page) && !allTypes.some((t) => ARTICLE_TYPES.includes(t))) {
      push(out, mk({
        id: 'M5.article.missing', title: 'Editorial page carries no Article schema', status: 'fail', severity: 4, scope: 'page', ...at,
        evidence: { observed: url + ' is an editorial page (' + (templateType(page) ? 'template type ' + templateType(page) : '<article> landmark, ' + (parsed.word_count || 0) + ' words') + ') and its JSON-LD declares ' + (allTypes.length ? listing(allTypes, 6) : 'no types at all') + ' — no Article/NewsArticle/BlogPosting node.' },
        expected: 'An Article (or NewsArticle/BlogPosting) node with headline, datePublished, dateModified, author and image.',
        recommendation: 'Add Article JSON-LD to the template using schema/jsonld-templates/article.json.',
        fixable: 'auto',
        verification: { method: 'schema_validator', assertion: 'The page emits an Article-family node with the required properties.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents Article structured data as the requirement for article rich results and for the byline/date it shows beside them.' },
      }));
    }

    /* ---- Product without any Offer ----------------------------------------------------------- */
    // ONE finding per page, naming the offending nodes. Every Product node on a page shares the same
    // location, so a finding per node would collapse to one in report.mjs's dedupe anyway — and the
    // reader would be told "21 duplicates merged" instead of which nodes are short an Offer.
    //
    // Which nodes count as declarations is lib/jsonld.mjs's classifyProductNodes() — the same rule
    // M18 and the Shopify check use. Three shapes are pointers rather than declarations:
    //   - a `hasVariant` member: Google documents a ProductGroup's variants as inheriting the
    //     group's properties, so the group is the declaration and variant-level pricing is M18's
    //     (M18.offer.missing_price / M18.variants.no_productgroup);
    //   - a nested node carrying nothing but url/name/@id, or no substantive property at all — a
    //     REFERENCE to a product defined elsewhere;
    //   - a node reached through a back-reference property (`itemReviewed`, `isSimilarTo`,
    //     `isRelatedTo`, `isVariantOf`, `mainEntity` under a review node). A review widget's
    //     `aggregateRating.itemReviewed = {"@type":"Product","name":"…"}` describes the item being
    //     reviewed, not an offer the page is short of; claiming otherwise is a false failure about
    //     the merchant's markup — and the page's real Product/ProductGroup usually does carry price.
    const hasOffer = (n) => {
      const offers = n && n.offers;
      return Array.isArray(offers) ? offers.length > 0 : !!(offers && typeof offers === 'object');
    };
    const groups = classifyProductNodes(nodes);
    // ProductGroup is M18's subject (it prices through its variants); M5 keeps its Product scope.
    const offerless = groups.declarations.filter((p) => p.types.includes('Product') && !hasOffer(p.node));
    const stubs = groups.stubs.filter((p) => !hasOffer(p.node));
    const variants = groups.variants.filter((p) => !hasOffer(p.node));
    const backRefs = groups.back_references.filter((p) => !hasOffer(p.node));
    if (offerless.length) {
      const first = offerless[0];
      const names = offerless.map((p) => p.path + ' ("' + clip((p.node && p.node.name) || '(unnamed)', 40) + '")');
      push(out, mk({
        id: 'M5.product.missing_offer_price', title: 'Product markup carries no Offer', status: 'fail', severity: 4, scope: 'page', ...at,
        evidence: { observed: plural(offerless.length, 'Product node') + ' on ' + url + ' ' + agree(offerless.length, 'declares', 'declare') + ' no `offers` property: ' + listing(names, 4)
          + '. Properties present on ' + first.path + ': ' + listing(ownProps(first.node), 8)
          + (stubs.length ? '. ' + plural(stubs.length, 'further reference stub') + ' (url/name/@id only) left to M18, which owns variant pricing' : '')
          + (variants.length ? '. ' + plural(variants.length, 'further node') + ' ' + agree(variants.length, 'is', 'are') + ' a `hasVariant` member of the ProductGroup that declares it, which Google documents as inheriting the group\'s properties' : '')
          + (backRefs.length ? '. ' + plural(backRefs.length, 'further node') + ' reached through ' + listing([...new Set(backRefs.map((b) => pathProperty(b.path)))], 3) + ' ' + agree(backRefs.length, 'is', 'are') + ' a back-reference to an item declared elsewhere, not a declaration on this page' : '') + '.' },
        expected: 'Product carries an Offer (or AggregateOffer) with price and priceCurrency.',
        recommendation: 'Add an offers node with price, priceCurrency and availability, using schema/jsonld-templates/product-offer.json.',
        fixable: 'auto',
        verification: { method: 'schema_validator', assertion: 'Every Product node has an offers property containing a price.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents price as required for product rich results; a Product without an Offer is ineligible for them.' },
      }));
    }

    /* ---- marked-up price vs the price the page shows ------------------------------------------ */
    const offerNodes = nodes.filter((n) => n.types.some((t) => t === 'Offer' || t === 'AggregateOffer'));
    const schemaPrices = offerNodes
      .map((n) => ({ path: n.path, raw: n.node.price != null ? n.node.price : n.node.lowPrice, value: numericPrice(n.node.price != null ? n.node.price : n.node.lowPrice) }))
      .filter((p) => p.value != null);
    if (schemaPrices.length) {
      const tokens = tokensFor(ctx, page);
      if (tokens) {
        const det = detectLang(tokens, { flag: ctx.options && ctx.options.lang, doc: parsed });
        const text = visibleText(tokens, { mask: contentMask(tokens) });
        const numbers = classifyNumbers(text, { lang: det.supported ? det.lang : undefined });
        const shown = (numbers.sample || []).filter((s) => s.kind === 'price');
        const shownValues = shown.map((s) => numericPrice(s.raw)).filter((v) => v != null);
        if (shownValues.length && !schemaPrices.some((p) => shownValues.some((v) => Math.abs(v - p.value) < 0.005))) {
          push(out, mk({
            id: 'M5.jsonld.contradicts_page', title: 'Marked-up price does not match any price shown on the page', status: 'fail', severity: 4, scope: 'page', ...at,
            evidence: { observed: 'JSON-LD declares ' + listing(schemaPrices.map((p) => p.path + ' price ' + p.raw), 3) + ', while the visible content shows ' + listing(shown.map((s) => '"' + clip(s.raw, 24) + '"'), 4) + ' on ' + url + '.' },
            expected: 'The price in the markup is the price the page displays.',
            recommendation: 'Render the structured data from the same source as the displayed price (currency, discounts and taxes included) so the two cannot drift.',
            fixable: 'proposed',
            verification: { method: 'schema_validator', assertion: 'The Offer price equals a price rendered in the page\'s content region.' },
            reproduce: repro,
            expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents that structured data must match the content visible to users; mismatched prices are a stated cause of manual action against rich results.' },
          }));
        }
      }
    }

    /* ---- FAQPage / HowTo --------------------------------------------------------------------- */
    const deprecated = nodes.filter((n) => n.types.some((t) => DEPRECATED_RICHRESULT.includes(t)));
    if (deprecated.length) {
      push(out, mk({
        id: 'M5.faqpage.deprecated_richresult', title: 'FAQPage/HowTo markup no longer earns a rich result', status: 'warn', severity: 1, scope: 'page', ...at,
        evidence: { observed: listing(deprecated.map((n) => n.path + ' (' + typesOf(n.node).join(', ') + ')'), 3) + ' on ' + url + '.' },
        expected: 'The markup is kept only for non-Google consumers, and is not counted as a search win.',
        recommendation: 'Keep it if other consumers read it; do not add more of it expecting a rich result. Google retired the FAQ rich result for almost all sites and limited HowTo to none.',
        fixable: 'advisory',
        verification: { method: 'schema_validator', assertion: 'The page still emits FAQPage/HowTo nodes (valid schema, no Google rich result).' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google announced the removal of the FAQ rich result and the restriction of HowTo; the markup remains valid schema.org and is still read by other consumers.' },
      }));
    }

    return out;
  },
};

export default check;
