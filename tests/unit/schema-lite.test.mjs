// Unit tests for scripts/lib/schema-lite.mjs (JSON-Schema subset) and scripts/lib/validate-finding.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = (name) => import(pathToFileURL(join(ROOT, 'scripts', 'lib', name)).href);
const { validate, compile, formatErrors, deepEqual } = await lib('schema-lite.mjs');
const { validateFinding, validateFindings, FINDING_SCHEMA, FINDING_SCHEMA_PATH } = await lib('validate-finding.mjs');
const { scoreFindings } = await import(pathToFileURL(join(ROOT, 'scripts', 'score.mjs')).href);
const REPORT = JSON.parse(readFileSync(join(ROOT, 'schema', 'audit-report.schema.json'), 'utf8'));
const load = (n) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', n), 'utf8'));

const ok = (schema, v, o) => { const r = validate(schema, v, o); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r; };
const bad = (schema, v, keyword, o) => {
  const r = validate(schema, v, o);
  assert.equal(r.ok, false, 'expected failure for ' + JSON.stringify(v));
  if (keyword) assert.ok(r.errors.some((e) => e.keyword === keyword), 'expected keyword ' + keyword + ' in ' + JSON.stringify(r.errors));
  return r;
};

describe('schema-lite: types', () => {
  it('single types', () => {
    ok({ type: 'string' }, 'x'); bad({ type: 'string' }, 1, 'type');
    ok({ type: 'number' }, 1.5); bad({ type: 'number' }, '1', 'type'); bad({ type: 'number' }, NaN, 'type');
    ok({ type: 'integer' }, 3); bad({ type: 'integer' }, 1.5, 'type');
    ok({ type: 'boolean' }, false); bad({ type: 'boolean' }, 0, 'type');
    ok({ type: 'null' }, null); bad({ type: 'null' }, undefined, 'type');
    ok({ type: 'array' }, []); bad({ type: 'array' }, {}, 'type');
    ok({ type: 'object' }, {}); bad({ type: 'object' }, [], 'type'); bad({ type: 'object' }, null, 'type');
  });
  it('type arrays express nullable fields', () => {
    const s = { type: ['number', 'null'], minimum: 0 };
    ok(s, null); ok(s, 3); const r = bad(s, '3', 'type');
    assert.equal(r.errors[0].message, 'expected number|null, got string');
    bad(s, -1, 'minimum');
  });
  it('true/false/empty schemas', () => {
    ok(true, 42); ok({}, 42); ok(undefined, 42); bad(false, 42, 'false');
  });
});

describe('schema-lite: value keywords', () => {
  it('enum and const', () => {
    ok({ enum: ['a', 1, null] }, null); bad({ enum: ['a'] }, 'b', 'enum');
    ok({ const: { a: [1] } }, { a: [1] }); bad({ const: 1 }, 2, 'const');
  });
  it('string constraints', () => {
    ok({ type: 'string', minLength: 2, maxLength: 3, pattern: '^a+$' }, 'aa');
    bad({ minLength: 2 }, 'a', 'minLength'); bad({ maxLength: 1 }, 'ab', 'maxLength'); bad({ pattern: '^M[0-9]+$' }, 'X1', 'pattern');
  });
  it('numeric constraints', () => {
    ok({ minimum: 0, maximum: 5 }, 5); bad({ minimum: 0 }, -0.1, 'minimum'); bad({ maximum: 5 }, 5.1, 'maximum');
    ok({ exclusiveMinimum: 0 }, 0.1); bad({ exclusiveMinimum: 0 }, 0, 'exclusiveMinimum'); bad({ exclusiveMaximum: 1 }, 1, 'exclusiveMaximum');
  });
  it('arrays: items, tuple items, minItems/maxItems', () => {
    ok({ items: { type: 'string' } }, ['a', 'b']); bad({ items: { type: 'string' } }, ['a', 1], 'type');
    ok({ items: [{ type: 'string' }, { type: 'number' }] }, ['a', 1, 'extra']); bad({ items: [{ type: 'string' }] }, [1], 'type');
    bad({ minItems: 1 }, [], 'minItems'); bad({ maxItems: 1 }, [1, 2], 'maxItems');
  });
  it('objects: required, properties, additionalProperties false or a schema', () => {
    const s = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'integer' } }, additionalProperties: false };
    ok(s, { a: 'x', b: 1 });
    const r1 = bad(s, { b: 1 }, 'required'); assert.match(r1.errors[0].message, /"a"/);
    const r2 = bad(s, { a: 'x', zzz: 1 }, 'additionalProperties'); assert.match(r2.errors[0].message, /"zzz"/);
    ok({ additionalProperties: { type: 'number' } }, { x: 1 }); bad({ additionalProperties: { type: 'number' } }, { x: 'y' }, 'type');
    ok(s, { a: 'x', b: undefined }, 'undefined-valued keys are treated as absent');
  });
});

describe('schema-lite: paths and error formatting', () => {
  it('nested property and array index paths', () => {
    const s = { properties: { evidence: { properties: { observed: { type: 'string' } } }, doc_ref: { items: { type: 'string' } } } };
    const r = validate(s, { evidence: { observed: 1 }, doc_ref: ['ok', 2] });
    assert.deepEqual(r.errors.map((e) => e.path), ['evidence.observed', 'doc_ref[1]']);
    assert.deepEqual(formatErrors(r.errors), ['evidence.observed: expected string, got number', 'doc_ref[1]: expected string, got number']);
    assert.deepEqual(formatErrors(validate({ type: 'object' }, 1).errors), ['$: expected object, got number']);
  });
  it('compile pre-binds a schema; deepEqual compares structurally', () => {
    const v = compile({ type: 'integer' });
    assert.equal(v(1).ok, true); assert.equal(v('1').ok, false);
    assert.equal(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqual([1, 2], [2, 1]), false);
  });
});

describe('schema-lite: combinators and $ref', () => {
  it('oneOf: the report vertical accepts a legacy string or the detect object, nothing else', () => {
    const s = REPORT.properties.vertical;
    ok(s, 'saas', { root: REPORT });
    ok(s, { primary: 'ecommerce', also: ['docs'], multilingual: true, locales: ['es-MX'], signals: { cart: true }, source: 'detected' }, { root: REPORT });
    bad(s, 'bogus', 'oneOf', { root: REPORT });
    bad(s, { primary: 'bogus' }, 'oneOf', { root: REPORT });
    bad(s, { also: ['docs'] }, 'oneOf', { root: REPORT });
    bad(s, 42, 'oneOf', { root: REPORT });
  });
  it('oneOf rejects a value matching two alternatives; anyOf accepts it', () => {
    const r = bad({ oneOf: [{ type: 'number' }, { minimum: 0 }] }, 5, 'oneOf');
    assert.match(r.errors[0].message, /matches 2 alternatives/);
    ok({ anyOf: [{ type: 'number' }, { minimum: 0 }] }, 5);
    bad({ anyOf: [{ type: 'number' }, { type: 'null' }] }, 'x', 'anyOf');
  });
  it('allOf and not', () => {
    ok({ allOf: [{ type: 'integer' }, { minimum: 1 }] }, 1); bad({ allOf: [{ type: 'integer' }, { minimum: 1 }] }, 0, 'minimum');
    ok({ not: { type: 'string' } }, 1); bad({ not: { type: 'string' } }, 'x', 'not');
  });
  it('local $ref (#/$defs/…) resolves against the root document', () => {
    ok({ $ref: '#/$defs/band' }, 'unscored', { root: REPORT });
    bad({ $ref: '#/$defs/band' }, 'Z', 'enum', { root: REPORT });
    bad({ $ref: '#/$defs/nope' }, 'A', '$ref', { root: REPORT });
    ok({ $ref: '#/$defs/band', enum: ['A'] }, 'A', { root: REPORT });
    bad({ $ref: '#/$defs/band', enum: ['A'] }, 'B', 'enum', { root: REPORT });
  });
  it('external $ref resolves through the refs map by $id or basename; unresolved is an error', () => {
    const items = REPORT.properties.findings.items; // $ref to the finding schema by $id
    const f = load('sample-findings.json')[0];
    ok(items, f, { root: REPORT, refs: { [FINDING_SCHEMA.$id]: FINDING_SCHEMA } });
    ok(items, f, { root: REPORT, refs: { 'finding.schema.json': FINDING_SCHEMA } });
    bad(items, { ...f, status: 'ok' }, 'enum', { root: REPORT, refs: { 'finding.schema.json': FINDING_SCHEMA } });
    bad(items, f, '$ref', { root: REPORT });
    ok({ $ref: 'finding.schema.json#/properties/status' }, 'manual_review', { refs: { 'finding.schema.json': FINDING_SCHEMA } });
  });
  it('a $ref cycle is reported instead of overflowing the stack', () => {
    const r = validate({ $ref: '#' }, 1);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.keyword === '$ref' && /too deep/.test(e.message)));
  });
});

describe('validate-finding.mjs against schema/finding.schema.json', () => {
  it('loads the schema from the plugin root', () => {
    assert.equal(FINDING_SCHEMA_PATH, join(ROOT, 'schema', 'finding.schema.json'));
    assert.ok(FINDING_SCHEMA.properties.status.enum.includes('manual_review'));
    assert.ok(FINDING_SCHEMA.properties.verification.properties.method.enum.includes('ua_diff'));
    assert.ok(FINDING_SCHEMA.properties.verification.properties.method.enum.includes('web_search_probe'));
    assert.equal(FINDING_SCHEMA.properties.location.properties.resource.type, 'string');
  });
  it('every finding in the sample and gated fixtures is valid', () => {
    for (const name of ['sample-findings.json', 'findings-gated.json', 'findings-search-only.json']) {
      for (const f of load(name)) { const r = validateFinding(f); assert.equal(r.ok, true, name + ' ' + f.id + ': ' + r.errors.join('; ')); }
    }
  });
  it('the invalid fixture yields the expected errors per entry', () => {
    const inv = load('findings-invalid.json');
    const e0 = validateFinding(inv[0]).errors;
    assert.ok(e0.some((e) => e === '$: missing required property "evidence"'), JSON.stringify(e0));
    assert.ok(e0.some((e) => e === '$: missing required property "verification"'));
    const e1 = validateFinding(inv[1]).errors;
    assert.ok(e1.some((e) => e.startsWith('status: must be one of')));
    assert.ok(e1.some((e) => e === 'severity: expected integer, got string'));
    const e2 = validateFinding(inv[2]).errors;
    assert.ok(e2.some((e) => e.startsWith('id: does not match')));
    assert.ok(e2.some((e) => e === '$: unexpected property "page"'));
    assert.deepEqual(validateFinding(inv[3]), { ok: true, errors: [] });
    const { valid, dropped } = validateFindings(inv);
    assert.deepEqual([valid.length, dropped.map((d) => d.index)], [1, [0, 1, 2]]);
    assert.deepEqual(validateFindings(null), { valid: [], dropped: [] });
    assert.equal(validateFinding(null).ok, false);
  });
  it('accepts the new status/method/location values and severity 0', () => {
    const f = { ...load('sample-findings.json')[0], status: 'manual_review', severity: 0, location: { url: 'https://e.test/', resource: 'theme.liquid' } };
    f.verification = { ...f.verification, method: 'web_search_probe' };
    assert.deepEqual(validateFinding(f), { ok: true, errors: [] });
  });
});

describe('audit-report.schema.json end to end', () => {
  const refs = { [FINDING_SCHEMA.$id]: FINDING_SCHEMA };
  const findings = load('sample-findings.json');
  const scores = scoreFindings(findings);
  const report = {
    target: { kind: 'url', value: 'https://example.com/', host: 'example.com', pages_analyzed: 1 },
    generated_at: '2026-09-05T00:00:00Z',
    tier: 0,
    vertical: { primary: 'blog-publisher', also: [], multilingual: false, source: 'detected' },
    scores: { search_seo: scores.search_seo, ai_visibility: scores.ai_visibility },
    findings,
  };
  it('a minimal report with the scorer output validates', () => { ok(REPORT, report, { refs }); });
  it('the optional v0.2.0 sections validate', () => {
    ok(REPORT, {
      ...report,
      run_id: '2026-09-05T00-00-00Z', plugin_version: '0.2.0', run_dir: '/tmp/runs/example.com/2026-09-05T00-00-00Z',
      coverage: { mode: 'deterministic', modules_covered: ['M1', 'M2'], modules_model_only: ['M11'] },
      pages: [{ url: 'https://example.com/', role: 'homepage', template: 'home', weight: 3, search: { value: 90, band: 'A', state: 'scored', capped: false }, ai: { value: null, band: 'unscored', state: 'unscored', capped: false } }],
      site_rollup: { method: 'role_weights', weights: { homepage: 3 }, worst_pages: { search: [{ url: 'https://example.com/x', value: 10, band: 'F' }], ai: [] } },
      data_sources: { render: 'chrome', psi: false, gsc: null },
      platform: { platform: { id: 'wordpress' } },
      probes: { web_search: { disclaimer: 'proxy' } },
      dropped_findings: [{ index: 3, id: null, errors: ['$: missing required property "id"'] }],
      site: { robots: { status: 200 } },
      warnings: ['x'],
    }, { refs });
  });
  it('rejects unknown top-level keys, a bad coverage mode and a legacy vertical typo', () => {
    bad(REPORT, { ...report, bogus: 1 }, 'additionalProperties', { refs });
    bad(REPORT, { ...report, coverage: { mode: 'partial' } }, 'enum', { refs });
    bad(REPORT, { ...report, vertical: 'shop' }, 'oneOf', { refs });
    ok(REPORT, { ...report, vertical: 'ecommerce' }, { refs });
  });
});
