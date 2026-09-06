// A small JSON-Schema-subset validator (zero dependencies). Enough to validate the plugin's own
// schemas (schema/finding.schema.json, schema/audit-report.schema.json) at runtime without a
// full draft-2020 implementation.
//
// Supported keywords: type (string or array — a type array is how nullable fields are expressed,
// e.g. ["number","null"]), enum, const, required, properties, additionalProperties (false or a
// schema), pattern, minimum/maximum, exclusiveMinimum/exclusiveMaximum, minLength/maxLength,
// minItems/maxItems, items, oneOf/anyOf/allOf (shallow: sub-schemas are evaluated, matches are
// counted, their inner errors are summarized), $ref (local "#/$defs/x" / "#/definitions/x" and
// external ids resolved through a caller-provided map), and `not`.
// Ignored (annotation-only here): format, title, description, $schema, $id, default, examples.
//
// validate(schema, value, options) -> { ok, errors: [{ path, keyword, message }] }
//   options.refs : { [$id or basename]: schema } for external $ref targets
//   options.root : the document that owns `schema` (defaults to `schema`) — used for "#/..." refs

const MAX_DEPTH = 64;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

function matchesType(v, t) {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

function joinPath(base, key) {
  if (typeof key === 'number') return base + '[' + key + ']';
  return base ? base + '.' + key : key;
}

function pointerGet(doc, pointer) {
  // pointer like "/$defs/score" (already stripped of the leading '#')
  const parts = pointer.split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveRef(ref, ctx) {
  if (typeof ref !== 'string') return { error: 'non-string $ref' };
  if (ref.startsWith('#')) {
    const target = pointerGet(ctx.root, ref.slice(1));
    return target === undefined ? { error: 'unresolved local $ref ' + ref } : { schema: target, root: ctx.root };
  }
  const [docId, frag] = ref.split('#');
  const refs = ctx.refs || {};
  const base = docId.split('/').pop();
  const doc = refs[docId] || refs[base] || null;
  if (!doc) return { error: 'unresolved external $ref ' + ref };
  if (frag) {
    const target = pointerGet(doc, frag);
    return target === undefined ? { error: 'unresolved external $ref ' + ref } : { schema: target, root: doc };
  }
  return { schema: doc, root: doc };
}

function check(schema, value, path, ctx, depth, errors) {
  if (depth > MAX_DEPTH) { errors.push({ path, keyword: '$ref', message: 'schema nesting too deep (possible $ref cycle)' }); return; }
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ path, keyword: 'false', message: 'schema forbids any value here' }); return; }
  if (schema === null || typeof schema !== 'object') { errors.push({ path, keyword: 'schema', message: 'invalid schema node' }); return; }

  if (schema.$ref !== undefined) {
    const r = resolveRef(schema.$ref, ctx);
    if (r.error) { errors.push({ path, keyword: '$ref', message: r.error }); return; }
    check(r.schema, value, path, { ...ctx, root: r.root }, depth + 1, errors);
    // Sibling keywords next to $ref are honored too (draft 2019+ semantics).
    const rest = { ...schema }; delete rest.$ref;
    if (Object.keys(rest).some((k) => !/^(\$id|\$schema|title|description|\$comment|examples|default)$/.test(k))) {
      check(rest, value, path, ctx, depth + 1, errors);
    }
    return;
  }

  // type
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({ path, keyword: 'type', message: 'expected ' + types.join('|') + ', got ' + typeOf(value) });
      return; // further keyword checks assume the right type
    }
  }

  // enum / const
  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push({ path, keyword: 'enum', message: 'must be one of ' + schema.enum.map((e) => JSON.stringify(e)).join(', ') + '; got ' + JSON.stringify(value) });
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push({ path, keyword: 'const', message: 'must equal ' + JSON.stringify(schema.const) });
  }

  // strings
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, keyword: 'minLength', message: 'length ' + value.length + ' < minLength ' + schema.minLength });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, keyword: 'maxLength', message: 'length ' + value.length + ' > maxLength ' + schema.maxLength });
    if (schema.pattern !== undefined) {
      let re;
      try { re = new RegExp(schema.pattern, 'u'); } catch { try { re = new RegExp(schema.pattern); } catch { re = null; } }
      if (re && !re.test(value)) errors.push({ path, keyword: 'pattern', message: 'does not match /' + schema.pattern + '/' });
    }
  }

  // numbers
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: 'minimum', message: value + ' < minimum ' + schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: 'maximum', message: value + ' > maximum ' + schema.maximum });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path, keyword: 'exclusiveMinimum', message: value + ' <= exclusiveMinimum ' + schema.exclusiveMinimum });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push({ path, keyword: 'exclusiveMaximum', message: value + ' >= exclusiveMaximum ' + schema.exclusiveMaximum });
  }

  // arrays
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: 'minItems', message: value.length + ' items < minItems ' + schema.minItems });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: 'maxItems', message: value.length + ' items > maxItems ' + schema.maxItems });
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((s, i) => { if (i < value.length) check(s, value[i], joinPath(path, i), ctx, depth + 1, errors); });
      } else {
        value.forEach((v, i) => check(schema.items, v, joinPath(path, i), ctx, depth + 1, errors));
      }
    }
  }

  // objects
  if (matchesType(value, 'object')) {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!(k in value) || value[k] === undefined) errors.push({ path, keyword: 'required', message: 'missing required property "' + k + '"' });
    }
    for (const k of Object.keys(props)) if (k in value && value[k] !== undefined) check(props[k], value[k], joinPath(path, k), ctx, depth + 1, errors);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of Object.keys(value)) {
        if (k in props || value[k] === undefined) continue;
        if (schema.additionalProperties === false) errors.push({ path, keyword: 'additionalProperties', message: 'unexpected property "' + k + '"' });
        else check(schema.additionalProperties, value[k], joinPath(path, k), ctx, depth + 1, errors);
      }
    }
  }

  // combinators (shallow)
  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) check(s, value, path, ctx, depth + 1, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((s) => { const e = []; check(s, value, path, ctx, depth + 1, e); return e; });
    if (!branchErrors.some((e) => e.length === 0)) {
      errors.push({ path, keyword: 'anyOf', message: 'matches none of ' + schema.anyOf.length + ' alternatives (' + summarize(branchErrors) + ')' });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((s) => { const e = []; check(s, value, path, ctx, depth + 1, e); return e; });
    const matches = branchErrors.filter((e) => e.length === 0).length;
    if (matches === 0) errors.push({ path, keyword: 'oneOf', message: 'matches none of ' + schema.oneOf.length + ' alternatives (' + summarize(branchErrors) + ')' });
    else if (matches > 1) errors.push({ path, keyword: 'oneOf', message: 'matches ' + matches + ' alternatives; exactly one required' });
  }
  if (schema.not !== undefined) {
    const e = [];
    check(schema.not, value, path, ctx, depth + 1, e);
    if (e.length === 0) errors.push({ path, keyword: 'not', message: 'must not match the "not" schema' });
  }
}

function summarize(branchErrors) {
  return branchErrors.map((e, i) => i + ': ' + (e[0] ? e[0].message : 'ok')).join('; ');
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Validate `value` against `schema`.
 * @returns {{ ok: boolean, errors: Array<{ path: string, keyword: string, message: string }> }}
 */
export function validate(schema, value, options = {}) {
  const errors = [];
  const ctx = { root: options.root || schema, refs: options.refs || {} };
  check(schema, value, options.path || '', ctx, 0, errors);
  return { ok: errors.length === 0, errors };
}

/** Pre-bind a schema: returns (value) => validate(schema, value, options). */
export function compile(schema, options = {}) {
  return (value) => validate(schema, value, options);
}

/** Render an error list as compact strings ("$.severity: expected integer, got string"). */
export function formatErrors(errors) {
  return errors.map((e) => (e.path ? e.path : '$') + ': ' + e.message);
}
