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
