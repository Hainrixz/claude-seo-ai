// JSON-LD helpers shared by validate-jsonld.mjs, html.mjs and the audit pipeline.
// Pure functions, no I/O. Nodes are objects carrying an @type; flattenNodes() walks
// `@graph` AND every nested object/array property so nested Offer/Person/AggregateRating
// nodes are validated too (they used to be invisible), each with a human-readable path.

/** Normalize a node's @type to an array of strings. */
export function typesOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const t = node['@type'];
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string');
  return typeof t === 'string' && t ? [t] : [];
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Collect @type values. Default (legacy) walks top-level arrays and `@graph` only, which is
 * what a block's `type` summary has always meant. Pass `{ deep: true }` to include every
 * nested node's types as well.
 */
export function collectTypes(data, opts = {}, acc = [], seen = new Set()) {
  if (Array.isArray(opts)) { acc = opts; opts = {}; } // tolerate the old (data, acc) call shape
  const deep = !!opts.deep;
  if (Array.isArray(data)) { for (const n of data) collectTypes(n, opts, acc, seen); return acc; }
  if (!isPlainObject(data) || seen.has(data)) return acc;
  seen.add(data);
  acc.push(...typesOf(data));
  if (Array.isArray(data['@graph'])) for (const n of data['@graph']) collectTypes(n, opts, acc, seen);
  if (deep) {
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('@')) continue;
      if (Array.isArray(v) || isPlainObject(v)) collectTypes(v, opts, acc, seen);
    }
  }
  return acc;
}

/**
 * Flatten every typed node in a JSON-LD document (single object, array, or @graph) into
 * [{ node, path, types, depth, parent_types }]. Pre-order: a parent precedes its children.
 * Path examples: "Product", "Product.offers[0]", "Article.author", "Organization" (@graph member).
 * Objects without @type are traversed (their typed descendants are still found) but not emitted.
 * Dedupes by object identity, so a shared reference is reported once.
 */
export function flattenNodes(data) {
  const out = [];
  const seen = new Set();
  const visit = (value, path, depth, parentTypes) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, path ? `${path}[${i}]` : '', depth, parentTypes));
      return;
    }
    if (!isPlainObject(value) || seen.has(value)) return;
    seen.add(value);
    const types = typesOf(value);
    let here = path;
    let nextDepth = depth;
    if (types.length) {
      // A typed node names its own path segment when it is a root or a @graph member.
      here = path || types[0];
      out.push({ node: value, path: here, types, depth, parent_types: parentTypes });
      nextDepth = depth + 1;
    }
    if (Array.isArray(value['@graph'])) {
      // @graph members are roots in their own right: their path is their type name.
      for (const member of value['@graph']) visit(member, '', depth, parentTypes);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('@')) continue;
      if (!Array.isArray(v) && !isPlainObject(v)) continue;
      const base = types.length ? here : path;
      visit(v, base ? `${base}.${k}` : k, nextDepth, types.length ? types : parentTypes);
    }
  };
  visit(data, '', 0, []);
  return out;
}

/**
 * Give repeated root paths a distinct suffix, so evidence can tell two sibling roots apart.
 * A root (or `@graph` member) is named after its type, so two ProductGroups on one page both
 * flatten to "ProductGroup" and a finding that quotes the path names neither of them; the second
 * becomes "ProductGroup[1]", and its descendants follow ("ProductGroup[1].hasVariant[0]").
 *
 * This is presentation only. It never makes a path safe to MATCH nodes with — two blocks flattened
 * separately still collide — so membership is always decided by object identity (variantNodeSet).
 * @param {Array} entries flattenNodes() output, in order (extra keys are preserved)
 */
export function disambiguateRootPaths(entries) {
  const counts = new Map();
  let from = null, to = null;
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') { out.push(entry); continue; }
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (Number(entry.depth) === 0) {
      const n = counts.get(path) || 0;
      counts.set(path, n + 1);
      from = n > 0 ? path : null;
      to = n > 0 ? path + '[' + n + ']' : null;
    }
    if (from && (path === from || path.startsWith(from + '.'))) out.push({ ...entry, path: to + path.slice(from.length) });
    else out.push(entry);
  }
  return out;
}

/* ----------------------------------------------------------------- references vs declarations */

/**
 * Properties whose object value POINTS AT an item described elsewhere instead of declaring one
 * here: a review widget's `itemReviewed`, a "related/similar product" pointer, a variant's parent
 * group. A node reached through one of them is a back-reference, so it can never be "missing" the
 * properties the real node carries — judging it produces a false claim about the page's markup.
 */
export const BACK_REFERENCE_PROPS = Object.freeze(['itemReviewed', 'isSimilarTo', 'isRelatedTo', 'isVariantOf']);
/** `mainEntity` declares the item on a WebPage and only back-references it under a review node. */
const REVIEW_TYPES = ['Review', 'UserReview', 'CriticReview', 'AggregateRating', 'EmployerAggregateRating'];
/** Keys that do nothing but name a resource; a nested node carrying only these is a pointer to it. */
export const NAMING_PROPS = Object.freeze(['url', 'name']);

/** Last property segment of a flatten path: "AggregateRating.itemReviewed[0]" -> "itemReviewed". */
export function pathProperty(path) {
  const seg = String(path == null ? '' : path).split('.').pop() || '';
  return seg.replace(/\[\d+\]$/, '');
}

/** Own, non-empty properties of a node, ignoring the @-keywords. */
export function ownProps(node) {
  if (!isPlainObject(node)) return [];
  return Object.keys(node).filter((k) => !k.startsWith('@') && !isEmptyValue(node[k]));
}

/**
 * True when a flattened entry (from flattenNodes) was reached through a back-reference property.
 * @param {{path?: string, parent_types?: string[]}} entry
 */
export function isBackReference(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const prop = pathProperty(entry.path);
  if (BACK_REFERENCE_PROPS.includes(prop)) return true;
  return prop === 'mainEntity' && (entry.parent_types || []).some((t) => REVIEW_TYPES.includes(t));
}

/**
 * True for a flattened entry that points at a resource defined elsewhere rather than declaring it:
 * a node with no own properties, or a NESTED node whose only properties name the target
 * (`url`, `name`, `@id`) — a `hasVariant` entry, say. A top-level node carrying just a name is
 * still a declaration, however thin, so it is not swallowed here.
 * @param {{node?: object, depth?: number}} entry
 */
export function isReferenceStub(entry) {
  if (!entry || typeof entry !== 'object') return true;
  const isEntry = Array.isArray(entry.types) && typeof entry.path === 'string';
  const node = isEntry ? entry.node : entry;
  const own = ownProps(node);
  if (!own.length) return true;
  return isEntry && Number(entry.depth) > 0 && own.every((k) => NAMING_PROPS.includes(k));
}

/* ------------------------------------------------------- product declarations (one rule, shared) */
//
// M5 (schema), M18 (ecommerce) and the Shopify platform check all have to answer the same question:
// which of a page's Product-typed nodes DECLARE a product here? Three modules answering it three
// ways is how a correctly marked-up variant page collected "29 Product nodes", "ProductGroup
// .hasVariant[0] lacks brand, sku, gtin" and "no Offer" all at once — claims about markup Google
// documents as correct. The rule lives here so the three cannot drift again.

/** Node types that describe a product. `ProductGroup` is the variant-carrying parent. */
export const PRODUCT_TYPES = Object.freeze(['Product', 'ProductGroup']);

/**
 * Properties whose value is a MEMBER of the node carrying them, not a product declared in its own
 * right. Google documents `hasVariant` as how a ProductGroup lists its variants, and documents the
 * variants as inheriting the group's properties — so a `hasVariant` entry is never "a second
 * Product on the page" and never "missing" what the group supplies. (`isVariantOf`, the pointer in
 * the other direction, is already a BACK_REFERENCE_PROP.)
 */
export const VARIANT_PROPS = Object.freeze(['hasVariant']);

/**
 * Every object a node carries under `hasVariant` — the variants themselves and everything nested
 * inside them (their Offers above all) — as a Set keyed by object identity.
 *
 * Identity, not path text, is what makes a variant "this group's". Two sibling roots of the same
 * type share a flatten path ("ProductGroup" twice), so `path.startsWith(group.path + '.hasVariant')`
 * hands one group the other group's variants: a group with no offers of its own then quotes the
 * neighbour's cheapest price as this product's, and a missing gtin is hidden by the neighbour's.
 * flattenNodes() dedupes by identity too, so `set.has(entry.node)` is exact.
 * @param {object} node a raw JSON-LD node (a flattenNodes entry's `.node`)
 * @returns {Set<object>}
 */
export function variantNodeSet(node) {
  const set = new Set();
  if (!isPlainObject(node)) return set;
  const stack = [];
  for (const prop of VARIANT_PROPS) if (node[prop] !== undefined) stack.push(node[prop]);
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
    if (!isPlainObject(cur) || set.has(cur)) continue;
    set.add(cur);
    if (Array.isArray(cur['@graph'])) stack.push(cur['@graph']);
    for (const [k, v] of Object.entries(cur)) {
      if (k.startsWith('@')) continue;
      if (Array.isArray(v) || isPlainObject(v)) stack.push(v);
    }
  }
  return set;
}

/**
 * Properties that make a Product node a description rather than a pointer. `name`, `url` and `@id`
 * are deliberately absent: they name a target, they do not describe one (see NAMING_PROPS), so a
 * nested `{"@type":"Product","url":"…?size=8","name":"Size 8"}` stays a pointer. A node that
 * carries an offer but no name is still a declaration — M18 must be able to say the title is
 * missing rather than pretend the node is not there.
 */
export const PRODUCT_SUBSTANCE_PROPS = Object.freeze([
  'offers', 'sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'productID',
  'brand', 'image', 'description', 'hasVariant', 'productGroupID', 'aggregateRating', 'review',
]);

/** Accept either a flattenNodes() entry or a raw (node, path) pair; always return an entry shape. */
function asEntry(value, path) {
  if (value && typeof value === 'object' && Array.isArray(value.types) && typeof value.path === 'string') return value;
  const p = typeof path === 'string' ? path : '';
  return { node: value, path: p, types: typesOf(value), depth: p.includes('.') ? 1 : 0, parent_types: [] };
}

/** True when the entry is typed Product or ProductGroup. */
export function isProductNode(entry, path) {
  const e = asEntry(entry, path);
  return e.types.some((t) => PRODUCT_TYPES.includes(t));
}

/** True when the entry was reached through a variant property, so its parent is the declaration. */
export function isVariantEntry(entry, path) {
  return VARIANT_PROPS.includes(pathProperty(asEntry(entry, path).path));
}

/** True when the node carries at least one property that describes a product. */
export function hasProductSubstance(node) {
  return ownProps(node).some((k) => PRODUCT_SUBSTANCE_PROPS.includes(k));
}

/**
 * True when this node DECLARES a product on this page. Excluded, in order: a back-reference
 * (`itemReviewed`, `isSimilarTo`, `isRelatedTo`, `isVariantOf`, a review's `mainEntity`), a
 * `hasVariant` member, a url/name/@id-only stub, and a NESTED node with no substantive property.
 * A root (or `@graph` member) is judged by the existing stub rule alone, so a top-level Product
 * carrying just a name stays the thin declaration it is.
 * @param {object} entry a flattenNodes() entry, or a raw node when `path` is passed
 * @param {string} [path]
 */
export function isProductDeclaration(entry, path) {
  const e = asEntry(entry, path);
  if (!isProductNode(e)) return false;
  if (isBackReference(e) || isVariantEntry(e) || isReferenceStub(e)) return false;
  return Number(e.depth) === 0 || hasProductSubstance(e.node);
}

/**
 * Split flattened nodes into the four groups the findings need to talk about.
 * @param {Array} entries flattenNodes() output (extra keys are preserved)
 * @returns {{declarations: Array, variants: Array, back_references: Array, stubs: Array}}
 */
export function classifyProductNodes(entries) {
  const declarations = [], variants = [], back_references = [], stubs = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isProductNode(entry)) continue;
    if (isBackReference(entry)) back_references.push(entry);
    else if (isVariantEntry(entry)) variants.push(entry);
    else if (isReferenceStub(entry) || (Number(entry.depth) > 0 && !hasProductSubstance(entry.node))) stubs.push(entry);
    else declarations.push(entry);
  }
  return { declarations, variants, back_references, stubs };
}

/** The Product/ProductGroup nodes a page declares (see isProductDeclaration). */
export function productDeclarations(entries) {
  return classifyProductNodes(entries).declarations;
}

/**
 * True when a property value should count as missing: absent, null, empty/blank string,
 * empty array, array of only-empty values, or an object with no own keys.
 */
export function isEmptyValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyValue);
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false; // numbers (incl. 0) and booleans are values
}

/**
 * Check one node against a single-type spec { required: [], recommended: [] }.
 * Returns unprefixed property names. `empty` lists properties that are present but empty
 * (they are also reported as missing — an empty value is not a value).
 */
export function checkProps(node, spec = {}) {
  const res = { missing_required: [], missing_recommended: [], empty: [] };
  if (!isPlainObject(node)) return res;
  for (const p of spec.required || []) {
    if (isEmptyValue(node[p])) { res.missing_required.push(p); if (p in node) res.empty.push(p); }
  }
  for (const p of spec.recommended || []) {
    if (isEmptyValue(node[p])) { res.missing_recommended.push(p); if (p in node) res.empty.push(p); }
  }
  return res;
}

/**
 * Validate a node against a type map (e.g. validate-jsonld's SPEC: { Product: {required, recommended} }).
 * Every one of the node's types that has a spec is applied; entries are prefixed "Type.prop".
 * known_type is true when at least one of the node's types has a spec (legacy semantics).
 */
export function validateNode(node, specMap = {}) {
  const types = typesOf(node);
  const out = { types, has_id: isPlainObject(node) && '@id' in node, missing_required: [], missing_recommended: [], empty_properties: [], known_type: false };
  for (const t of types) {
    const spec = specMap[t];
    if (!spec) continue;
    out.known_type = true;
    const r = checkProps(node, spec);
    out.missing_required.push(...r.missing_required.map((p) => t + '.' + p));
    out.missing_recommended.push(...r.missing_recommended.map((p) => t + '.' + p));
    out.empty_properties.push(...r.empty.map((p) => t + '.' + p));
  }
  return out;
}
