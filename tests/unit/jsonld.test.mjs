// lib/jsonld.mjs + validate-jsonld.mjs: nested-node flattening with paths, empty-value handling,
// SPEC coverage (SoftwareApplication, LocalBusiness subtypes), CLI output shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { flattenNodes, collectTypes, validateNode, checkProps, isEmptyValue, typesOf } from '../../scripts/lib/jsonld.mjs';
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
