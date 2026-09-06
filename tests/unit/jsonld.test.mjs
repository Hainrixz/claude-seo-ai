// lib/jsonld.mjs + validate-jsonld.mjs: nested-node flattening with paths, empty-value handling,
// SPEC coverage (SoftwareApplication, LocalBusiness subtypes), CLI output shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { flattenNodes, disambiguateRootPaths, variantNodeSet, collectTypes, validateNode, checkProps, isEmptyValue, typesOf, isBackReference, isReferenceStub, ownProps, pathProperty, isProductDeclaration, classifyProductNodes, productDeclarations, hasProductSubstance } from '../../scripts/lib/jsonld.mjs';
import { SPEC, LOCAL_BUSINESS_TYPES, main } from '../../scripts/validate-jsonld.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FIX = resolve(ROOT, 'tests', 'fixtures');
const NESTED = resolve(FIX, 'nested-jsonld.html');

const product = {
  '@context': 'https://schema.org', '@type': 'Product', name: 'Widget Pro', image: [],
  brand: { '@type': 'Brand', name: 'Acme' },
  offers: [{ '@type': 'Offer', price: '', priceCurrency: 'USD', availability: 'https://schema.org/InStock' }],
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: null },
};
const graph = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Article', headline: 'x', datePublished: '2026-02-02', author: { '@type': 'Person', name: 'Ana', sameAs: [] }, publisher: { '@id': '#org' } },
    { '@type': 'Organization', '@id': '#org', name: 'Acme', logo: '' },
  ],
};

describe('flattenNodes', () => {
  it('walks nested properties in pre-order with readable paths and depths', () => {
    assert.deepEqual(flattenNodes(product).map((n) => [n.path, n.depth, n.types[0]]), [
      ['Product', 0, 'Product'], ['Product.brand', 1, 'Brand'], ['Product.offers[0]', 1, 'Offer'], ['Product.aggregateRating', 1, 'AggregateRating'],
    ]);
  });
  it('treats @graph members as roots; untyped reference objects are not nodes', () => {
    assert.deepEqual(flattenNodes(graph).map((n) => [n.path, n.depth]), [['Article', 0], ['Article.author', 1], ['Organization', 0]]);
  });
  it('handles top-level arrays, dedupes shared objects, and records parent_types', () => {
    const shared = { '@type': 'Person', name: 'S' };
    const arr = [{ '@type': 'Article', headline: 'a', author: shared }, { '@type': 'BlogPosting', headline: 'b', author: shared }];
    const nodes = flattenNodes(arr);
    assert.deepEqual(nodes.map((n) => n.path), ['Article', 'Article.author', 'BlogPosting']);
    assert.deepEqual(nodes[1].parent_types, ['Article']);
    assert.deepEqual(flattenNodes(null), []);
    assert.deepEqual(flattenNodes('str'), []);
  });
  it('supports multi-type nodes', () => {
    const n = flattenNodes({ '@type': ['Organization', 'LocalBusiness'], name: 'x' });
    assert.deepEqual(n[0].types, ['Organization', 'LocalBusiness']);
    assert.equal(n[0].path, 'Organization');
  });
});

describe('collectTypes / typesOf', () => {
  it('is shallow by default (legacy block summary) and deep on request', () => {
    assert.deepEqual(collectTypes(product), ['Product']);
    assert.deepEqual(collectTypes(product, { deep: true }), ['Product', 'Brand', 'Offer', 'AggregateRating']);
    assert.deepEqual(collectTypes([graph]), ['Article', 'Organization']);
    assert.deepEqual(typesOf({ '@type': 'X' }), ['X']);
    assert.deepEqual(typesOf(null), []);
  });
});

describe('isEmptyValue / checkProps / validateNode', () => {
  it('counts "", null, [], {}, blank and arrays of empties as missing; 0 and false are values', () => {
    for (const v of [undefined, null, '', '  ', [], {}, [''], [null]]) assert.equal(isEmptyValue(v), true, JSON.stringify(v));
    for (const v of [0, false, 'x', [0], { a: 1 }]) assert.equal(isEmptyValue(v), false, JSON.stringify(v));
  });
  it('checkProps returns unprefixed names and lists present-but-empty properties', () => {
    assert.deepEqual(checkProps(product.offers[0], SPEC.Offer), { missing_required: ['price'], missing_recommended: ['url'], empty: ['price'] });
  });
  it('validateNode applies every known type of the node with Type.prop prefixes', () => {
    const v = validateNode(product, SPEC);
    assert.deepEqual(v.missing_required, []);
    assert.deepEqual(v.missing_recommended, ['Product.image']);
    assert.deepEqual(v.empty_properties, ['Product.image']);
    assert.equal(v.known_type, true);
    assert.equal(validateNode({ '@type': 'Brand', name: 'x' }, SPEC).known_type, false);
    const multi = validateNode({ '@type': ['Restaurant', 'Organization'], name: 'R' }, SPEC);
    assert.ok(multi.missing_required.includes('Restaurant.address'));
    assert.ok(multi.missing_recommended.includes('Organization.url'));
  });
});

describe('SPEC coverage', () => {
  it('includes SoftwareApplication and the LocalBusiness subtype family', () => {
    for (const t of ['SoftwareApplication', 'WebApplication', 'MobileApplication', 'LocalBusiness', 'Restaurant', 'Dentist', 'Store', 'Hotel', 'Plumber', 'RealEstateAgent']) assert.ok(SPEC[t], t);
    assert.ok(LOCAL_BUSINESS_TYPES.length >= 50);
    for (const t of LOCAL_BUSINESS_TYPES) assert.deepEqual(SPEC[t].required, ['name', 'address'], t);
    assert.deepEqual(SPEC.SoftwareApplication.required, ['name', 'offers']);
    assert.deepEqual(SPEC.BlogPosting.required, ['headline', 'author', 'datePublished'], 'legacy Article spec unchanged');
  });
});

describe('validate-jsonld.mjs on nested-jsonld.html', () => {
  const run = (args) => JSON.parse(execFileSync(process.execPath, [resolve(ROOT, 'scripts', 'validate-jsonld.mjs'), ...args], { encoding: 'utf8' }));
  it('main() (in-process) reports nested nodes with paths and nodes_nested_count, keeping legacy keys', async () => {
    const { result, code } = await main({ file: NESTED });
    assert.equal(code, 0);
    for (const k of ['source', 'finalUrl', 'blocks_found', 'invalid_json_blocks', 'nodes', 'types_present', 'deprecated_richresult_types_present']) assert.ok(k in result, 'legacy key ' + k);
    assert.equal(result.blocks_found, 2);
    assert.equal(result.invalid_json_blocks, 0);
    assert.equal(result.nodes_total, 7);
    assert.equal(result.nodes_nested_count, 4);
    assert.deepEqual(result.types_present, ['AggregateRating', 'Article', 'Brand', 'Offer', 'Organization', 'Person', 'Product']);
    const by = (p) => result.nodes.find((n) => n.path === p);
    assert.deepEqual([by('Product.offers[0]').missing_required, by('Product.offers[0]').empty_properties], [['Offer.price'], ['Offer.price']]);
    assert.deepEqual(by('Product.aggregateRating').missing_recommended, ['AggregateRating.reviewCount', 'AggregateRating.ratingCount']);
    assert.ok(by('Product').missing_recommended.includes('Product.image'), 'empty array counts as missing');
    assert.deepEqual([by('Article.author').depth, by('Article.author').missing_recommended], [1, ['Person.sameAs', 'Person.jobTitle']]);
    assert.ok(by('Organization').missing_recommended.includes('Organization.logo'), 'empty string counts as missing');
    assert.equal(by('Organization').has_id, true);
    assert.equal(by('Product.brand').known_type, false);
    assert.equal(by('Article').missing_required.length, 0);
  });
  it('--type filters nested nodes too and leaves top-level counts intact', () => {
    const r = run(['--file', NESTED, '--type', 'Offer', '--type', 'Person']);
    assert.deepEqual(r.nodes.map((n) => n.path), ['Product.offers[0]', 'Article.author']);
    assert.equal(r.nodes_total, 7);
    assert.equal(r.blocks_found, 2);
  });
  it('invalid blocks are reported with the parse error, never as a silent pass', () => {
    const r = run(['--file', resolve(FIX, 'malformed.html')]);
    assert.equal(r.blocks_found, 3, 'MIME match ignores charset param, case and whitespace');
    assert.equal(r.invalid_json_blocks, 1);
    const bad = r.nodes.find((n) => n.valid_json === false);
    assert.equal(typeof bad.error, 'string');
    assert.deepEqual(r.types_present, ['Organization', 'WebSite']);
  });
});

describe('references vs declarations', () => {
  const page = {
    '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Wool Runners',
    offers: { '@type': 'Offer', price: 110, priceCurrency: 'USD' },
    hasVariant: [{ '@type': 'Product', url: 'https://e.test/p?size=8' }, { '@type': 'Product', url: 'https://e.test/p?size=9', name: 'Size 9' }],
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', itemReviewed: { '@type': 'Product', name: 'Wool Runners', image: 'https://e.test/i.png' } },
    isSimilarTo: { '@type': 'Product', name: 'Tree Runners', image: 'https://e.test/t.png', description: 'The other one' },
  };
  const at = (path) => flattenNodes(page).find((n) => n.path === path);

  it('pathProperty reads the property a node hangs off, index or not', () => {
    assert.equal(pathProperty('AggregateRating.itemReviewed'), 'itemReviewed');
    assert.equal(pathProperty('ProductGroup.hasVariant[1]'), 'hasVariant');
    assert.equal(pathProperty('Product'), 'Product');
    assert.equal(pathProperty(undefined), '');
  });

  it('a node reached through a back-reference property points elsewhere, however complete it is', () => {
    assert.equal(isBackReference(at('ProductGroup.aggregateRating.itemReviewed')), true);
    assert.equal(isBackReference(at('ProductGroup.isSimilarTo')), true);
    assert.equal(isBackReference(at('ProductGroup')), false);
    assert.equal(isBackReference(at('ProductGroup.hasVariant[0]')), false, 'a variant entry is judged by what it carries, not by its property');
    // mainEntity is a declaration on a page and a pointer under a review node.
    assert.equal(isBackReference({ path: 'WebPage.mainEntity', parent_types: ['WebPage'] }), false);
    assert.equal(isBackReference({ path: 'Review.mainEntity', parent_types: ['Review'] }), true);
  });

  it('a nested node carrying only naming properties is a stub; a top-level one is a declaration', () => {
    assert.equal(isReferenceStub(at('ProductGroup.hasVariant[0]')), true, 'url only');
    assert.equal(isReferenceStub(at('ProductGroup.hasVariant[1]')), true, 'url + name only');
    assert.equal(isReferenceStub(at('ProductGroup.isSimilarTo')), false, 'it also carries a description and an image');
    assert.equal(isReferenceStub(at('ProductGroup')), false);
    assert.equal(isReferenceStub(flattenNodes({ '@type': 'Product', name: 'Thing' })[0]), false,
      'a root Product with just a name is a thin declaration, not a pointer');
    assert.equal(isReferenceStub(flattenNodes({ '@type': 'Product', '@id': '#p' })[0]), true);
  });

  it('ownProps ignores the @-keywords and empty values', () => {
    assert.deepEqual(ownProps({ '@type': 'Product', '@id': '#p', name: 'A', image: [], sku: '', price: 0 }), ['name', 'price']);
    assert.deepEqual(ownProps('not a node'), []);
  });
});

/* Two sibling roots of the same type flatten to the SAME path ("ProductGroup" twice). Matching a
   group's variants by that path text handed one group the other group's offers and identifiers —
   a false price and a masked gap, both stated at `established` confidence. */
describe('sibling roots of the same type', () => {
  const twoGroups = [
    { '@type': 'ProductGroup', name: 'Group A', brand: 'Acme', hasVariant: [{ '@type': 'Product', name: 'A-1', offers: { '@type': 'Offer', price: '500.00', priceCurrency: 'USD' } }] },
    { '@type': 'ProductGroup', name: 'Group B', gtin13: '0123456789012', hasVariant: [{ '@type': 'Product', name: 'B-1', offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' } }] },
  ];

  it('variantNodeSet answers by object identity, so a group owns only its own variants', () => {
    const flat = flattenNodes(twoGroups);
    const [a, b] = flat.filter((n) => n.types.includes('ProductGroup'));
    assert.equal(a.path, b.path, 'fixture check: the flatten paths really do collide');
    const setA = variantNodeSet(a.node);
    assert.equal(setA.size, 2, 'the variant and its nested Offer');
    const offers = flat.filter((n) => n.types.includes('Offer'));
    assert.deepEqual(offers.filter((o) => setA.has(o.node)).map((o) => o.node.price), ['500.00'],
      "group A is priced from its own variant, never from group B's cheaper one");
    assert.deepEqual([...variantNodeSet(b.node)].filter((n) => n.name).map((n) => n.name), ['B-1']);
    assert.equal(variantNodeSet({ '@type': 'Product', name: 'No variants' }).size, 0);
    assert.equal(variantNodeSet(null).size, 0, 'a non-object is not a crash');
  });

  it('variantNodeSet reaches the whole subtree of a variant, and survives a cycle', () => {
    const variant = { '@type': 'Product', name: 'V' };
    variant.isVariantOf = variant; // a self-reference must not spin
    const set = variantNodeSet({ '@type': 'ProductGroup', hasVariant: [[variant, { '@type': 'Offer', price: 1 }]] });
    assert.equal(set.size, 2, 'nested arrays are walked, identity stops the cycle');
  });

  it('disambiguateRootPaths names the second root and its descendants', () => {
    const paths = disambiguateRootPaths(flattenNodes(twoGroups)).map((n) => n.path);
    assert.deepEqual(paths, [
      'ProductGroup', 'ProductGroup.hasVariant[0]', 'ProductGroup.hasVariant[0].offers',
      'ProductGroup[1]', 'ProductGroup[1].hasVariant[0]', 'ProductGroup[1].hasVariant[0].offers',
    ]);
    assert.deepEqual(disambiguateRootPaths(flattenNodes(product)).map((n) => n.path),
      ['Product', 'Product.brand', 'Product.offers[0]', 'Product.aggregateRating'], 'a page with one root is untouched');
    assert.deepEqual(disambiguateRootPaths(null), [], 'a non-array input is not a crash');
  });

  it('paths from separate blocks are disambiguated too, since each block flattens on its own', () => {
    const perBlock = [...flattenNodes(twoGroups[0]), ...flattenNodes(twoGroups[1])];
    assert.deepEqual(disambiguateRootPaths(perBlock).map((n) => n.path).filter((p) => !p.includes('.')),
      ['ProductGroup', 'ProductGroup[1]']);
  });
});

/* One shape, three modules: M5, M18 and the Shopify check all ask "which nodes declare a product
   here?" through classifyProductNodes(). The fixture is the shape a real Shopify variant page emits
   (allbirds.com/products/mens-wool-runners-natural-white): one ProductGroup, a long tail of url-only
   hasVariant stubs, one fully described variant, and a review widget pointing back at the item. */
describe('product declarations', () => {
  const VARIANTS = Array.from({ length: 20 }, (_, i) => ({ '@type': 'Product', url: 'https://e.test/p/wool-runners?size=' + (i + 5) }));
  const storePage = {
    '@context': 'https://schema.org',
    '@type': 'ProductGroup',
    name: 'Wool Runners',
    brand: { '@type': 'Brand', name: 'Allbirds' },
    sku: 'WR-NAT-WHITE',
    image: 'https://e.test/i.png',
    productGroupID: 'WR',
    offers: { '@type': 'Offer', price: '110.00', priceCurrency: 'USD', url: 'https://e.test/p/wool-runners' },
    hasVariant: [
      ...VARIANTS,
      { '@type': 'Product', name: 'Wool Runners — 9', sku: 'WR-9', image: 'https://e.test/9.png', offers: { '@type': 'Offer', price: '110.00', priceCurrency: 'USD', url: 'https://e.test/p/wool-runners?size=9' } },
    ],
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: '812', itemReviewed: { '@type': 'Product', name: 'Wool Runners', image: 'https://e.test/i.png' } },
  };
  const flat = () => flattenNodes(storePage);

  it('counts one declaration on a ProductGroup page, whatever the variant count', () => {
    const { declarations, variants, back_references: backRefs, stubs } = classifyProductNodes(flat());
    assert.deepEqual(declarations.map((d) => d.path), ['ProductGroup'],
      'the group declares the product; the 21 variants and the review pointer do not');
    assert.equal(variants.length, 21, 'every hasVariant entry is a member of the group');
    assert.equal(backRefs.length, 1, 'aggregateRating.itemReviewed points at the item, it does not declare it');
    assert.equal(stubs.length, 0);
    assert.deepEqual(productDeclarations(flat()).map((d) => d.path), ['ProductGroup']);
  });

  it('a fully described variant is still a member, not a second product on the page', () => {
    const full = flat().find((n) => n.path === 'ProductGroup.hasVariant[20]');
    assert.ok(full && full.node.sku, 'fixture check: the last variant is the complete one');
    assert.equal(isProductDeclaration(full), false,
      'Google documents variants as inheriting the group; judging one on its own reports the group as incomplete');
  });

  it('substance, not just a name, makes a nested node a declaration', () => {
    assert.equal(hasProductSubstance({ '@type': 'Product', name: 'A', url: 'https://e.test/a' }), false);
    assert.equal(hasProductSubstance({ '@type': 'Product', name: 'A', offers: { price: 1 } }), true);
    const nested = flattenNodes({ '@type': 'WebPage', mainEntity: { '@type': 'Product', name: 'A', url: 'https://e.test/a' } });
    assert.equal(isProductDeclaration(nested.find((n) => n.path === 'WebPage.mainEntity')), false, 'a naming-only pointer');
    const real = flattenNodes({ '@type': 'WebPage', mainEntity: { '@type': 'Product', name: 'A', sku: 'X1' } });
    assert.equal(isProductDeclaration(real.find((n) => n.path === 'WebPage.mainEntity')), true);
  });

  it('a root Product is a declaration, and the (node, path) call shape works too', () => {
    assert.equal(isProductDeclaration(flattenNodes({ '@type': 'Product', name: 'Thing' })[0]), true, 'thin, but declared here');
    assert.equal(isProductDeclaration({ '@type': 'Product', name: 'Thing', offers: { price: 1 } }, 'Product'), true);
    assert.equal(isProductDeclaration({ '@type': 'Product', url: 'https://e.test/x' }, 'ProductGroup.hasVariant[0]'), false);
    assert.equal(isProductDeclaration({ '@type': 'Article', headline: 'Not a product' }, 'Article'), false);
    assert.deepEqual(classifyProductNodes(null).declarations, [], 'a non-array input is not a crash');
  });
});
