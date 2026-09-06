// Unit tests for scripts/lib/credentials.mjs — resolution order, presence without values, redaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'credentials.mjs')).href);

test('KEY_CATALOG covers every key the plan names, with sensitivity and a description', () => {
  const expected = [
    'SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN', 'SHOPIFY_ADMIN_TOKEN', 'WP_URL', 'WP_USER', 'WP_APP_PASSWORD',
    'WP_SSH', 'WEBFLOW_TOKEN', 'WEBFLOW_SITE_ID', 'WIX_API_KEY', 'WIX_SITE_ID', 'GHOST_URL',
    'GHOST_ADMIN_KEY', 'HUBSPOT_TOKEN', 'BIGCOMMERCE_STORE_HASH', 'BIGCOMMERCE_TOKEN',
  ];
  assert.deepEqual(C.KEY_NAMES.slice().sort(), expected.slice().sort());
  for (const key of expected) {
    const spec = C.KEY_CATALOG[key];
    assert.equal(typeof spec.sensitive, 'boolean', key + ' needs a sensitive flag');
    assert.ok(spec.description && spec.description.length > 20, key + ' needs a real description');
  }
  const secrets = ['SHOPIFY_THEME_TOKEN', 'SHOPIFY_ADMIN_TOKEN', 'WP_APP_PASSWORD', 'WEBFLOW_TOKEN', 'WIX_API_KEY', 'GHOST_ADMIN_KEY', 'HUBSPOT_TOKEN', 'BIGCOMMERCE_TOKEN'];
  for (const key of secrets) assert.equal(C.KEY_CATALOG[key].sensitive, true, key + ' must be sensitive');
  for (const key of ['SHOPIFY_STORE', 'WP_URL', 'WP_USER', 'WP_SSH', 'WEBFLOW_SITE_ID', 'WIX_SITE_ID', 'GHOST_URL', 'BIGCOMMERCE_STORE_HASH']) {
    assert.equal(C.KEY_CATALOG[key].sensitive, false, key + ' is an identifier, not a secret');
  }
});

test('resolveKey order: CLAUDE_PLUGIN_OPTION_<KEY> then <KEY>, catalog name before alias', () => {
  assert.equal(C.resolveKey('WEBFLOW_TOKEN', { CLAUDE_PLUGIN_OPTION_WEBFLOW_TOKEN: 'from-option', WEBFLOW_TOKEN: 'from-env' }), 'from-option');
  assert.equal(C.resolveKey('WEBFLOW_TOKEN', { WEBFLOW_TOKEN: 'from-env' }), 'from-env');
  assert.equal(C.resolveKey('WEBFLOW_TOKEN', { WEBFLOW_TOKEN: '   ' }), null, 'blank is not a value');
  assert.equal(C.resolveKey('WEBFLOW_TOKEN', {}), null);
  assert.equal(C.resolveKey('WP_URL', { WORDPRESS_URL: 'https://alias.example' }), 'https://alias.example', 'the platform-rules spelling still resolves');
  assert.equal(C.resolveKey('WP_URL', { WP_URL: 'https://main.example', WORDPRESS_URL: 'https://alias.example' }), 'https://main.example');
  assert.deepEqual(C.lookupOrder('SHOPIFY_THEME_TOKEN'), [
    'CLAUDE_PLUGIN_OPTION_SHOPIFY_THEME_TOKEN', 'SHOPIFY_THEME_TOKEN',
    'CLAUDE_PLUGIN_OPTION_SHOPIFY_CLI_THEME_TOKEN', 'SHOPIFY_CLI_THEME_TOKEN',
  ]);
});

test('presence reports provenance and never the value', () => {
  const env = { CLAUDE_PLUGIN_OPTION_SHOPIFY_ADMIN_TOKEN: 'shpat_supersecretvalue', SHOPIFY_STORE: 'shop.myshopify.com' };
  const report = C.presence(['SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_STORE', 'WEBFLOW_TOKEN'], env);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('shpat_supersecretvalue'), 'a presence report must never carry a value');
  assert.deepEqual(report.map((r) => [r.key, r.present]), [['SHOPIFY_ADMIN_TOKEN', true], ['SHOPIFY_STORE', true], ['WEBFLOW_TOKEN', false]]);
  assert.equal(report[0].source, 'CLAUDE_PLUGIN_OPTION_SHOPIFY_ADMIN_TOKEN');
  assert.equal(report[0].sensitive, true);
  assert.deepEqual(C.missingKeys(['SHOPIFY_ADMIN_TOKEN', 'WEBFLOW_TOKEN', 'WIX_API_KEY'], env), ['WEBFLOW_TOKEN', 'WIX_API_KEY']);
  assert.equal(C.hasKey('WIX_API_KEY', env), false);
});

test('an unknown key is treated as sensitive', () => {
  assert.equal(C.isSensitive('SOME_UNLISTED_TOKEN'), true);
  assert.equal(C.keySpec('SOME_UNLISTED_TOKEN'), null);
  assert.equal(C.canonicalKey('SHOPIFY_CLI_THEME_TOKEN'), 'SHOPIFY_THEME_TOKEN');
});

test('redact replaces secret values (and their URL-encoded form) but leaves identifiers alone', () => {
  const env = {
    SHOPIFY_ADMIN_TOKEN: 'shpat_0123456789abcdef',
    WP_APP_PASSWORD: 'abcd efgh ijkl mnop',
    SHOPIFY_STORE: 'my-store.myshopify.com',
    WP_USER: 'editor',
  };
  const text = 'token=shpat_0123456789abcdef store=my-store.myshopify.com user=editor pass=abcd%20efgh%20ijkl%20mnop';
  const out = C.redact(text, { env });
  assert.ok(!out.includes('shpat_0123456789abcdef'));
  assert.ok(!out.includes('abcd%20efgh%20ijkl%20mnop'), 'the URL-encoded application password is redacted too');
  assert.match(out, /\[redacted:SHOPIFY_ADMIN_TOKEN\]/);
  assert.ok(out.includes('my-store.myshopify.com'), 'a store domain is not a secret');
  assert.ok(out.includes('editor'), 'a user name is not a secret');
});

test('redact ignores very short values so unrelated text survives', () => {
  const out = C.redact('the theme is on and the tap is off', { env: { WEBFLOW_TOKEN: 'on' } });
  assert.equal(out, 'the theme is on and the tap is off');
});

test('redactObject blanks secret-looking fields and redacts values everywhere else', () => {
  const env = { HUBSPOT_TOKEN: 'pat-na1-0000-1111-2222' };
  const out = C.redactObject({ Authorization: 'Bearer pat-na1-0000-1111-2222', nested: { note: 'uses pat-na1-0000-1111-2222', id: 7 } }, { env });
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.nested.note, 'uses [redacted:HUBSPOT_TOKEN]');
  assert.equal(out.nested.id, 7);
});

test('explainKeys names the missing keys in both languages without leaking anything', () => {
  const en = C.explainKeys(['WEBFLOW_TOKEN', 'WEBFLOW_SITE_ID'], { env: { WEBFLOW_SITE_ID: 'abc123' } });
  assert.deepEqual(en.missing, ['WEBFLOW_TOKEN']);
  assert.match(en.lines[0], /^Missing credential: WEBFLOW_TOKEN —/);
  assert.match(en.hint, /plugin/);
  const es = C.explainKeys(['WEBFLOW_TOKEN'], { env: {}, lang: 'es' });
  assert.match(es.lines[0], /^Falta la credencial: WEBFLOW_TOKEN/);
});

test('keysForAdapter maps adapters to their catalog keys', () => {
  assert.deepEqual(C.keysForAdapter('shopify-theme'), ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN']);
  assert.deepEqual(C.keysForAdapter('wordpress-rest'), ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD']);
  assert.ok(C.keysForAdapter('page-api').includes('GHOST_ADMIN_KEY'));
});

test('the catalog agrees with the adapter key names in lib/platform-rules.mjs (via aliases)', async () => {
  const rules = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'platform-rules.mjs')).href);
  const named = new Set();
  for (const spec of Object.values(rules.ADAPTERS)) for (const key of spec.needs) named.add(key);
  for (const keys of Object.values(rules.PAGE_API_KEYS)) for (const key of keys) named.add(key);
  const unknown = [...named].filter((k) => !C.keySpec(k));
  // Payload's keys are not in the catalog yet (its adapter is not built); everything else must resolve.
  assert.deepEqual(unknown.sort(), ['PAYLOAD_API_KEY', 'PAYLOAD_URL']);
});
