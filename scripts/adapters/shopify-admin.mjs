#!/usr/bin/env node
// shopify-admin adapter — writes the per-resource SEO fields Shopify keeps in the Admin, not in the
// theme: a product's or collection's search-engine title and description, the `seo.hidden` metafield
// that pulls a resource out of the index and the sitemap, and URL redirects.
//
//   node scripts/adapters/shopify-admin.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>]
//                                           [--store <s>] [--json]
//   ops: capabilities | plan | preview | apply | verify | rollback
//
// THESE WRITES ARE LIVE
// The Admin API has no staging surface: a mutation changes the storefront the moment it succeeds.
// So every change this adapter plans is `class: proposed`, `live_impact: live`, and its preview
// prints the exact query, the exact variables and the current values it would replace. `apply`
// re-reads the resource first and returns `skipped_idempotent` when the field already holds the
// target value, so a repeated run is not a second write.
//
// WHAT IT WILL NOT DO
// Page and article SEO (`pageUpdate` / `articleUpdate`) are NOT planned: their `seo` input and the
// scopes they need are unverified against the 2026-07 schema (references/platforms/shopify.md §12),
// and guessing a scope is how a fix becomes a 403 in someone's production store.

import { existsSync } from 'node:fs';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  ensureConfirmed, loadFixRun, makeChange, openFixRun, requireTicket, resolveDataDir, transition,
  updateManifest,
} from '../lib/adapter.mjs';
import { jsonRequest } from '../lib/http.mjs';
import { presence, redactObject, resolveKey } from '../lib/credentials.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';
import { reproduceCommand } from '../lib/finding.mjs';
import { fixableFindings, normalizeAnswers, parseFixPreview } from './local-files.mjs';
import { normalizeStore } from './shopify-theme.mjs';
import { logOpEvent, opThrew, withheldProposedNote } from './_shared.mjs';
import { snapshotUrl } from '../snapshot.mjs';

export const ADAPTER = 'shopify-admin';
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback'];

/**
 * Admin GraphQL version.
 *
 * Shopify ships a new stable version every quarter and supports each one for twelve months, so this
 * pin goes stale on a schedule rather than by surprise. RE-CHECK IT EVERY QUARTER: confirm the
 * version still exists, that `productByIdentifier` is still there, and that nothing in the mutations
 * below changed shape (references/platforms/shopify.md §12 tracks this as an explicit open item).
 */
export const API_VERSION = '2026-07';
export const CREDENTIAL_KEYS = Object.freeze(['SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN']);

/** Scopes each kind of write needs, per Shopify's Admin API access-scope reference. */
export const REQUIRED_SCOPES = Object.freeze({
  'product-seo': Object.freeze(['write_products']),
  'collection-seo': Object.freeze(['write_products']),
  'seo-hidden': Object.freeze(['write_products']),
  redirect: Object.freeze(['write_online_store_navigation']),
});

/**
 * Writes this adapter deliberately does not perform. The value is what a person has to confirm
 * before the write could be added — it is reported by `capabilities`, never silently skipped.
 */
export const UNVERIFIED_WRITES = Object.freeze({
  'page-seo': 'pageUpdate: the seo input and the scope it needs are UNVERIFIED for ' + API_VERSION + ' — confirm against the schema (@shopify/dev-mcp) before enabling it',
  'article-seo': 'articleUpdate: same, unverified for ' + API_VERSION + ' — page and article SEO is handed to the instructions adapter instead',
});

/** `https://<store>/admin/api/<version>/graphql.json` */
export function adminEndpoint(store, version = API_VERSION) {
  const host = normalizeStore(store);
  return host ? 'https://' + host + '/admin/api/' + version + '/graphql.json' : null;
}

// ---------------------------------------------------------------------------
// GraphQL documents (kept as constants so the payload snapshots in the tests are stable)

const SEO_FIELDS = 'seo { title description }';
const HIDDEN_METAFIELD = 'metafield(namespace: "seo", key: "hidden") { id value type }';

export const QUERIES = Object.freeze({
  scopes: [
    'query claudeSeoAiAccessScopes {',
    '  currentAppInstallation { accessScopes { handle } }',
    '}',
  ].join('\n'),

  productByIdentifier: [
    'query claudeSeoAiProductByIdentifier($identifier: ProductIdentifierInput!) {',
    '  productByIdentifier(identifier: $identifier) {',
    '    id',
    '    handle',
    '    title',
    '    onlineStoreUrl',
    '    ' + SEO_FIELDS,
    '    ' + HIDDEN_METAFIELD,
    '  }',
    '}',
  ].join('\n'),

  productByHandle: [
    'query claudeSeoAiProductByHandle($handle: String!) {',
    '  productByHandle(handle: $handle) {',
    '    id',
    '    handle',
    '    title',
    '    onlineStoreUrl',
    '    ' + SEO_FIELDS,
    '    ' + HIDDEN_METAFIELD,
    '  }',
    '}',
  ].join('\n'),

  collectionByHandle: [
    'query claudeSeoAiCollectionByHandle($handle: String!) {',
    '  collectionByHandle(handle: $handle) {',
    '    id',
    '    handle',
    '    title',
    '    onlineStoreUrl',
    '    ' + SEO_FIELDS,
    '    ' + HIDDEN_METAFIELD,
    '  }',
    '}',
  ].join('\n'),

  urlRedirects: [
    'query claudeSeoAiUrlRedirects($query: String!) {',
    '  urlRedirects(first: 1, query: $query) {',
    '    edges { node { id path target } }',
    '  }',
    '}',
  ].join('\n'),
});

export const MUTATIONS = Object.freeze({
  productUpdate: [
    'mutation claudeSeoAiProductUpdate($input: ProductInput!) {',
    '  productUpdate(input: $input) {',
    '    product { id handle ' + SEO_FIELDS + ' }',
    '    userErrors { field message }',
    '  }',
    '}',
  ].join('\n'),

  collectionUpdate: [
    'mutation claudeSeoAiCollectionUpdate($input: CollectionInput!) {',
    '  collectionUpdate(input: $input) {',
    '    collection { id handle ' + SEO_FIELDS + ' }',
    '    userErrors { field message }',
    '  }',
    '}',
  ].join('\n'),

  metafieldsSet: [
    'mutation claudeSeoAiMetafieldsSet($metafields: [MetafieldsSetInput!]!) {',
    '  metafieldsSet(metafields: $metafields) {',
    '    metafields { id namespace key type value }',
    '    userErrors { field message code }',
    '  }',
    '}',
  ].join('\n'),

  metafieldsDelete: [
    'mutation claudeSeoAiMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {',
    '  metafieldsDelete(metafields: $metafields) {',
    '    deletedMetafields { key namespace ownerId }',
    '    userErrors { field message }',
    '  }',
    '}',
  ].join('\n'),

  urlRedirectCreate: [
    'mutation claudeSeoAiUrlRedirectCreate($urlRedirect: UrlRedirectInput!) {',
    '  urlRedirectCreate(urlRedirect: $urlRedirect) {',
    '    urlRedirect { id path target }',
    '    userErrors { field message }',
    '  }',
    '}',
  ].join('\n'),

  urlRedirectDelete: [
    'mutation claudeSeoAiUrlRedirectDelete($id: ID!) {',
    '  urlRedirectDelete(id: $id) {',
    '    deletedUrlRedirectId',
    '    userErrors { field message }',
    '  }',
    '}',
  ].join('\n'),
});

/** The `seo.hidden` metafield Shopify uses to drop a resource from the index and the sitemap. */
export const HIDDEN_METAFIELD_INPUT = Object.freeze({ namespace: 'seo', key: 'hidden', type: 'number_integer', value: '1' });

// ---------------------------------------------------------------------------
// HTTP

/**
 * One Admin GraphQL call. The token travels in the X-Shopify-Access-Token header and nowhere else;
 * every fetch goes through the injectable `fetchImpl`, so tests never touch the network.
 * @returns {{ok, status, data, errors, error, endpoint}}
 */
export async function adminRequest(ctx = {}, { query, variables = {}, timeoutMs = 20000 } = {}) {
  const env = ctx.env || process.env;
  const store = ctx.store || resolveStore(ctx);
  const endpoint = adminEndpoint(store);
  if (!endpoint) return { ok: false, status: 0, data: null, errors: [], error: 'no store: pass --store or set SHOPIFY_STORE', endpoint: null };
  const token = resolveKey('SHOPIFY_ADMIN_TOKEN', env);
  if (!token) return { ok: false, status: 0, data: null, errors: [], error: 'SHOPIFY_ADMIN_TOKEN is not set', endpoint };

  const res = await jsonRequest(endpoint, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
    body: { query, variables },
    fetchImpl: ctx.fetchImpl, env, timeoutMs,
  });
  const json = res.json && typeof res.json === 'object' ? res.json : null;
  const errors = json && Array.isArray(json.errors) ? json.errors : [];
  const message = errors.length
    ? errors.map((e) => String((e && e.message) || e)).join('; ')
    : (res.error ? (res.error.message || res.error.type || 'request failed') : null);
  return {
    ok: !!(res.ok && json && json.data && !errors.length),
    status: res.status,
    data: json ? json.data : null,
    errors,
    error: res.ok && !errors.length ? null : message,
    endpoint,
  };
}

/** `userErrors` a mutation returned, flattened to strings. */
export function userErrorsOf(data, mutation) {
  const node = data && data[mutation];
  const list = node && Array.isArray(node.userErrors) ? node.userErrors : [];
  return list.map((e) => {
    const field = Array.isArray(e && e.field) ? e.field.join('.') : (e && e.field) || '';
    return (field ? field + ': ' : '') + String((e && e.message) || 'unspecified error') + (e && e.code ? ' [' + e.code + ']' : '');
  });
}

/** Which store: --store, the ctx, the profile, then SHOPIFY_STORE. */
export function resolveStore(ctx = {}, options = {}) {
  const fromProfile = options.profile && options.profile.platform && options.profile.platform.store;
  for (const c of [options.store, ctx.store, fromProfile, resolveKey('SHOPIFY_STORE', ctx.env || process.env)]) {
    const s = normalizeStore(c);
    if (s) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a report

/** Which Shopify resource a storefront URL points at. `null` when the shape is not one we can write. */
export function resourceFromUrl(url) {
  let path;
  try { path = new URL(String(url), 'https://shop.invalid').pathname; } catch { return null; }
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const at = parts.indexOf('products');
  if (at !== -1 && parts[at + 1]) return { kind: 'product', handle: parts[at + 1] };
  if (parts[0] === 'collections' && parts[1] && parts[1] !== 'all' && parts.length === 2) return { kind: 'collection', handle: parts[1] };
  if (parts[0] === 'pages' && parts[1]) return { kind: 'page', handle: parts[1] };
  if (parts[0] === 'blogs' && parts[1] && parts[2]) return { kind: 'article', handle: parts[2] };
  return null;
}

const TITLE_ID_RE = /^M7\.title\./;
const DESC_ID_RE = /^M7\.(description\.|shopify\.description_is_body_fallback)/;
const REDIRECT_ID_RE = /^M2\.(redirect\.(chain|loop)|links\.broken_internal)$/;

/**
 * The SEO fields a finding asks for, taken from its `fix_preview` (or the user's `--answers`).
 * `title: …` / `description: …` lines win; otherwise the finding's id says which field the text is.
 * @returns {{title?: string, description?: string}|null}
 */
export function seoFieldsFor(finding, parsedPreview) {
  const updates = parsedPreview && parsedPreview.updates ? parsedPreview.updates : null;
  const out = {};
  if (updates) {
    for (const key of ['title', 'description']) {
      const v = updates[key] ?? updates['seo_' + key] ?? updates[key + '_tag'];
      if (typeof v === 'string' && v.trim()) out[key] = v.trim();
    }
  }
  if (!Object.keys(out).length) {
    const text = String((parsedPreview && parsedPreview.snippet) || '').trim();
    if (!text || text.includes('\n')) return Object.keys(out).length ? out : null;
    const id = String((finding && finding.id) || '');
    if (TITLE_ID_RE.test(id)) out.title = text;
    else if (DESC_ID_RE.test(id)) out.description = text;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A redirect pair written as `/old -> /new`, `/old => /new`, or `from: /old` + `to: /new`.
 * Absolute URLs are reduced to their path. Anything else returns null — a redirect target is never
 * guessed from a finding's prose.
 */
export function redirectPairFrom(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const asPath = (v) => {
    const s = String(v || '').trim().replace(/^["']|["']$/g, '');
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) { try { const u = new URL(s); return u.pathname + u.search; } catch { return null; } }
    return s.startsWith('/') ? s : null;
  };
  const arrow = /^(\S+)\s*(?:->|=>|→)\s*(\S+)$/.exec(raw.split(/\r?\n/)[0].trim());
  if (arrow) {
    const path = asPath(arrow[1]);
    const target = asPath(arrow[2]) || (/^https?:\/\//i.test(arrow[2]) ? arrow[2] : null);
    return path && target ? { path, target } : null;
  }
  const lines = Object.fromEntries(raw.split(/\r?\n/).map((l) => {
    const m = /^\s*([A-Za-z_]+)\s*:\s*(.+)$/.exec(l);
    return m ? [m[1].toLowerCase(), m[2].trim()] : [null, null];
  }).filter(([k]) => k));
  const path = asPath(lines.from ?? lines.path ?? lines.source);
  const target = asPath(lines.to ?? lines.target ?? lines.destination);
  return path && target ? { path, target } : null;
}

/** `hidden`, `seo.hidden`, `seo.hidden = 1`, `hidden: true` — the user asking to hide a resource. */
export function hiddenDirective(text) {
  return /^\s*(seo\.)?hidden\s*(?:[:=]\s*(1|true|yes))?\s*$/i.test(String(text == null ? '' : text).trim());
}

// ---------------------------------------------------------------------------
// Resolving a handle to a GID

/**
 * handle → {gid, seo, metafield}. `productByIdentifier` is the 2026-07 way in; when the schema on
 * the other end does not know it, `productByHandle` is tried and `resolved_by` says which answered.
 */
export async function resolveResource(ctx, { kind, handle }) {
  if (kind === 'collection') {
    const res = await adminRequest(ctx, { query: QUERIES.collectionByHandle, variables: { handle } });
    const node = res.data && res.data.collectionByHandle;
    if (!res.ok) return { ok: false, error: res.error, resolved_by: 'collectionByHandle' };
    if (!node) return { ok: false, error: 'no collection with handle "' + handle + '"', resolved_by: 'collectionByHandle' };
    return { ok: true, node, resolved_by: 'collectionByHandle' };
  }
  if (kind !== 'product') return { ok: false, error: 'this adapter writes products and collections only; ' + kind + ' is handled by the instructions adapter' };

  const first = await adminRequest(ctx, { query: QUERIES.productByIdentifier, variables: { identifier: { handle } } });
  if (first.ok) {
    const node = first.data && first.data.productByIdentifier;
    if (node) return { ok: true, node, resolved_by: 'productByIdentifier' };
    return { ok: false, error: 'no product with handle "' + handle + '"', resolved_by: 'productByIdentifier' };
  }
  const schemaGap = first.errors.some((e) => /productByIdentifier|ProductIdentifierInput|doesn't exist|does not exist|Cannot query field/i.test(String((e && e.message) || '')));
  if (!schemaGap) return { ok: false, error: first.error, resolved_by: 'productByIdentifier' };

  const second = await adminRequest(ctx, { query: QUERIES.productByHandle, variables: { handle } });
  const node = second.data && second.data.productByHandle;
  if (!second.ok) return { ok: false, error: second.error, resolved_by: 'productByHandle' };
  if (!node) return { ok: false, error: 'no product with handle "' + handle + '"', resolved_by: 'productByHandle' };
  return { ok: true, node, resolved_by: 'productByHandle', fallback: true };
}

/** Does a redirect for this path already exist? */
export async function findRedirect(ctx, path) {
  const res = await adminRequest(ctx, { query: QUERIES.urlRedirects, variables: { query: 'path:' + path } });
  if (!res.ok) return { ok: false, error: res.error, redirect: null };
  const edges = (res.data && res.data.urlRedirects && res.data.urlRedirects.edges) || [];
  const node = edges.length ? edges[0].node : null;
  return { ok: true, redirect: node || null };
}

// ---------------------------------------------------------------------------
// capabilities

/** The scopes the token actually has, from `currentAppInstallation`. */
export async function grantedScopes(ctx) {
  const res = await adminRequest(ctx, { query: QUERIES.scopes, variables: {} });
  if (!res.ok) return { ok: false, error: res.error, scopes: [] };
  const list = (res.data && res.data.currentAppInstallation && res.data.currentAppInstallation.accessScopes) || [];
  return { ok: true, scopes: list.map((s) => String((s && s.handle) || '')).filter(Boolean) };
}

/** capabilities: credentials present, token scopes vs the scopes each write needs. */
export async function capabilities(ctx = {}) {
  const env = ctx.env || process.env;
  const store = resolveStore(ctx);
  const keys = presence(CREDENTIAL_KEYS, env);
  const missing = keys.filter((k) => !k.present).map((k) => k.key);
  const needed = [...new Set(Object.values(REQUIRED_SCOPES).flat())];
  const notes = [];
  const out = {
    adapter: ADAPTER,
    ready: false,
    needs: [...new Set([...missing, ...(store ? [] : ['SHOPIFY_STORE'])])],
    tools: {},
    store,
    api_version: API_VERSION,
    endpoint: adminEndpoint(store),
    credentials: keys.map((k) => ({ key: k.key, present: k.present, source: k.source })),
    scopes: { required: needed, granted: null, missing: null, by_operation: REQUIRED_SCOPES },
    unverified: UNVERIFIED_WRITES,
    writes: 'live: the Admin API has no staging surface',
    notes,
  };
  for (const [op, why] of Object.entries(UNVERIFIED_WRITES)) notes.push(op + ' is not offered — ' + why);
  if (missing.length || !store) {
    notes.push('scopes were not checked: ' + (store ? 'set ' + missing.join(' and ') : 'no store resolved'));
    return out;
  }

  const granted = await grantedScopes({ ...ctx, store });
  if (!granted.ok) {
    notes.push('could not read the token\'s scopes (' + granted.error + '), so what this token may write is unknown');
    return out;
  }
  out.scopes.granted = granted.scopes;
  out.scopes.missing = needed.filter((s) => !granted.scopes.includes(s));
  out.ready = out.scopes.missing.length === 0;
  if (out.scopes.missing.length) {
    notes.push('the token is missing ' + out.scopes.missing.join(', ') + ' — re-issue it with those scopes, or the matching writes stay unavailable');
    for (const [op, scopes] of Object.entries(REQUIRED_SCOPES)) {
      const lacking = scopes.filter((s) => !granted.scopes.includes(s));
      if (lacking.length) notes.push(op + ' needs ' + lacking.join(', '));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// plan

function previewBody({ title, mutation, query, variables, before, url, endpoint, notes = [] }) {
  return [
    title,
    url ? 'URL:      ' + url : null,
    'Endpoint: POST ' + (endpoint || 'https://<store>/admin/api/' + API_VERSION + '/graphql.json'),
    'This write is LIVE the moment it succeeds — the Admin API has no preview theme.',
    '',
    'Current values:',
    JSON.stringify(before, null, 2),
    '',
    mutation,
    '',
    'Variables:',
    JSON.stringify(variables, null, 2),
    ...(notes.length ? ['', ...notes.map((n) => '- ' + n)] : []),
    ...(query ? ['', 'Idempotency read used before this write:', query] : []),
  ].filter((l) => l !== null && l !== undefined).join('\n');
}

/**
 * plan: findings → Admin API changes. The reads it does (handle → GID, current SEO values, an
 * existing redirect) are read-only; nothing is written here.
 * @param {object} options { report, profile, store, category, includeProposed, answers, findings }
 * @param {object} ctx     { run, dataDir, env, fetchImpl }
 */
export async function plan(options = {}, ctx = {}) {
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const store = resolveStore(ctx, { ...options, profile });
  const local = { ...ctx, store };

  const changes = [];
  const skipped = [];
  const notes = [];
  if (!store) return { adapter: ADAPTER, ready: false, store: null, changes, skipped, notes: ['no store resolved: --store or SHOPIFY_STORE is required'] };
  if (!resolveKey('SHOPIFY_ADMIN_TOKEN', ctx.env || process.env)) {
    return { adapter: ADAPTER, ready: false, store, changes, skipped, notes: ['SHOPIFY_ADMIN_TOKEN is not set, so no Admin write can be planned'] };
  }
  for (const why of Object.values(UNVERIFIED_WRITES)) notes.push(why);

  const answers = normalizeAnswers(options.answers);
  const runDir = ctx.run ? ctx.run.dir : '<run>';
  const resolved = new Map();
  const endpoint = adminEndpoint(store);
  const build = (spec) => buildChange({ ...spec, endpoint });

  // Every Admin write is `proposed` (the API writes live), so the flag decides whether this adapter
  // plans anything at all. Assuming it would let `plan` stage a live write nobody asked to see.
  const includeProposed = options.includeProposed === true;
  const withheld = withheldProposedNote(findings, { includeProposed, category: options.category });
  if (withheld) notes.push(withheld);

  for (const finding of fixableFindings(findings, { includeProposed, category: options.category })) {
    const id = String(finding.id || '');
    const answer = answers[id];
    const raw = finding.fix_preview || answer || '';
    const parsed = parseFixPreview(raw);
    const url = (finding.location && finding.location.url) || null;

    if (REDIRECT_ID_RE.test(id)) {
      const pair = redirectPairFrom(answer || finding.fix_preview || '');
      if (!pair) {
        skipped.push({ finding: id, reason: 'no redirect pair to create — supply it as "/old-path -> /new-path" in --answers; a redirect target is never guessed' });
        continue;
      }
      const existing = await findRedirect(local, pair.path);
      if (!existing.ok) { skipped.push({ finding: id, reason: 'could not check for an existing redirect: ' + existing.error }); continue; }
      if (existing.redirect && String(existing.redirect.target) === pair.target) {
        skipped.push({ finding: id, reason: 'a redirect from ' + pair.path + ' to ' + pair.target + ' already exists', status: 'skipped_idempotent' });
        continue;
      }
      if (existing.redirect) {
        skipped.push({ finding: id, reason: pair.path + ' already redirects to ' + existing.redirect.target + ' — change it in the Admin rather than have this tool overwrite a redirect it did not make' });
        continue;
      }
      const built = build({
        finding, runDir, url,
        target: { kind: 'redirect', locator: pair.path },
        op: 'create-redirect',
        strategy: 'admin-graphql',
        scopes: REQUIRED_SCOPES.redirect,
        payload: { mutation: 'urlRedirectCreate', document: MUTATIONS.urlRedirectCreate, variables: { urlRedirect: { path: pair.path, target: pair.target } }, resource: 'redirect' },
        before: { redirect: null },
        rollback: { kind: 'delete-redirect', data: { path: pair.path, target: pair.target } },
        verifyMethod: 'api_read',
        assertion: 'urlRedirects(query:"path:' + pair.path + '") returns a redirect to ' + pair.target,
        previewTitle: 'Create a URL redirect: ' + pair.path + ' → ' + pair.target,
        idemQuery: QUERIES.urlRedirects,
      });
      if (built.errors.length) skipped.push({ finding: id, reason: 'invalid change: ' + built.errors.join('; ') });
      else changes.push(built.change);
      continue;
    }

    const resource = url ? resourceFromUrl(url) : null;
    if (!resource) continue;
    if (resource.kind === 'page' || resource.kind === 'article') {
      skipped.push({ finding: id, reason: UNVERIFIED_WRITES[resource.kind === 'page' ? 'page-seo' : 'article-seo'] });
      continue;
    }

    const wantsHidden = hiddenDirective(answer || '');
    const fields = wantsHidden ? null : seoFieldsFor(finding, parsed);
    if (!wantsHidden && !fields) {
      if (TITLE_ID_RE.test(id) || DESC_ID_RE.test(id)) {
        skipped.push({ finding: id, reason: 'no text to write — the audit gave no fix_preview and you supplied no --answers entry, and this adapter never writes a title or description it made up' });
      }
      continue;
    }

    const key = resource.kind + ':' + resource.handle;
    if (!resolved.has(key)) resolved.set(key, await resolveResource(local, resource));
    const found = resolved.get(key);
    if (!found.ok) { skipped.push({ finding: id, reason: 'could not resolve ' + key + ': ' + found.error }); continue; }
    const node = found.node;

    if (wantsHidden) {
      const current = node.metafield && String(node.metafield.value);
      if (current === '1') {
        skipped.push({ finding: id, reason: key + ' already carries seo.hidden = 1', status: 'skipped_idempotent' });
        continue;
      }
      const built = build({
        finding, runDir, url,
        target: { kind: 'resource', locator: key + '#seo.hidden' },
        op: 'update-fields',
        strategy: 'admin-graphql',
        scopes: REQUIRED_SCOPES['seo-hidden'],
        payload: {
          mutation: 'metafieldsSet', document: MUTATIONS.metafieldsSet, resource: resource.kind, handle: resource.handle, gid: node.id,
          variables: { metafields: [{ ownerId: node.id, ...HIDDEN_METAFIELD_INPUT }] },
        },
        before: { gid: node.id, metafield: node.metafield || null },
        rollback: { kind: 'restore-fields', data: { gid: node.id, metafield: node.metafield || null } },
        verifyMethod: 'api_read',
        assertion: key + ' has the seo.hidden metafield set to 1 (Shopify then drops it from the index and the sitemap)',
        previewTitle: 'Hide ' + key + ' from search (seo.hidden = 1)',
        notes: [
          'Shopify recommends the Unlisted product status over seo.hidden for products.',
          'The resource disappears from sitemap.xml on Shopify\'s next generation, not instantly.',
        ],
      });
      if (built.errors.length) skipped.push({ finding: id, reason: 'invalid change: ' + built.errors.join('; ') });
      else changes.push(built.change);
      continue;
    }

    const before = { title: (node.seo && node.seo.title) || null, description: (node.seo && node.seo.description) || null };
    const same = Object.entries(fields).every(([k, v]) => String(before[k] || '') === v);
    if (same) {
      skipped.push({ finding: id, reason: key + ' already has these SEO values', status: 'skipped_idempotent' });
      continue;
    }
    const mutation = resource.kind === 'product' ? 'productUpdate' : 'collectionUpdate';
    const built = build({
      finding, runDir, url,
      target: { kind: 'resource', locator: key },
      op: 'update-fields',
      strategy: 'admin-graphql',
      scopes: REQUIRED_SCOPES[resource.kind + '-seo'],
      payload: {
        mutation, document: MUTATIONS[mutation], resource: resource.kind, handle: resource.handle, gid: node.id,
        fields, resolved_by: found.resolved_by,
        variables: { input: { id: node.id, seo: fields } },
      },
      before: { gid: node.id, seo: before },
      rollback: { kind: 'restore-fields', data: { gid: node.id, mutation, seo: before } },
      verifyMethod: 'api_read',
      assertion: key + ' returns the new seo ' + Object.keys(fields).join(' and ') + ', and the public page serves it',
      previewTitle: 'Set the Admin SEO ' + Object.keys(fields).join(' + ') + ' on ' + key,
      notes: found.fallback ? ['resolved with the productByHandle fallback: productByIdentifier was not available on this shop'] : [],
    });
    if (built.errors.length) skipped.push({ finding: id, reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  if (!changes.length && !skipped.length) notes.push('no findings in this report map to an Admin API write');
  return { adapter: ADAPTER, ready: true, store, api_version: API_VERSION, changes, skipped, notes };
}

function buildChange({ finding, runDir, url, target, op, strategy, scopes, payload, before, rollback, verifyMethod, assertion, previewTitle, notes = [], idemQuery = null, endpoint = null }) {
  const draft = {
    finding_ids: [String(finding.id)],
    adapter: ADAPTER,
    class: 'proposed',
    target: { ...target, url: url || undefined },
    op,
    strategy,
    payload,
    requires: { credentials: [...CREDENTIAL_KEYS], tools: [], scopes: [...scopes] },
    live_impact: 'live',
    rollback,
    status: 'planned',
  };
  const id = makeChange(draft, { mode: 'return', phase: 'plan' }).change.id;
  return makeChange({
    ...draft,
    id,
    before,
    preview: {
      kind: 'payload',
      lang: 'graphql',
      body: previewBody({ title: previewTitle, mutation: payload.document, query: idemQuery, variables: payload.variables, before, url, endpoint, notes }),
    },
    verify: {
      method: verifyMethod,
      command: reproduceCommand('adapters/shopify-admin.mjs', ['verify', '--run', runDir, '--change', id]),
      assertion,
      url: url || undefined,
    },
  }, { mode: 'return', phase: 'preview' });
}

// ---------------------------------------------------------------------------
// preview / apply / verify / rollback

/**
 * preview: re-read the resource so the "current values" shown are the ones the write would replace.
 *
 * When that read fails there are no current values — only the ones recorded at plan time. Printing
 * those under the same heading would present stale state as freshly read, so the body says so in
 * the heading itself and the result carries `read_error` with `ok: null`: the write is not refused,
 * but nobody should confirm it believing the "before" was just checked.
 */
export async function preview(change, ctx = {}) {
  const local = { ...ctx, store: ctx.store || resolveStore(ctx) };
  const fresh = await currentState(local, change);

  if (!fresh.ok) {
    const body = change.preview.body.replace('Current values:', 'Current values AT PLAN TIME (the live re-read failed — see below):')
      + '\n\nHEADS UP: the live values could not be re-read just now: ' + fresh.error + '\n'
      + 'What this write would replace is therefore unknown. Re-run `preview` once the Admin API answers,\n'
      + 'and do not confirm the write on the strength of the values above.';
    if (ctx.run) writeText(ctx.run.previewPath(change.id, '.graphql.txt'), body);
    const next = transition({ ...change, preview: { ...change.preview, body } }, 'previewed');
    return { change: next, ok: null, body, live: null, read_error: fresh.error, warning: 'the current values could not be read: ' + fresh.error };
  }

  const body = fresh.changedSince
    ? change.preview.body + '\n\nHEADS UP: the live values changed since this was planned. Now:\n' + JSON.stringify(fresh.before, null, 2)
    : change.preview.body;
  if (ctx.run) writeText(ctx.run.previewPath(change.id, '.graphql.txt'), body);
  if (fresh.idempotent) {
    return { change: transition(change, 'skipped_idempotent'), ok: true, body, reason: 'the live values already match this change' };
  }
  const next = transition({ ...change, preview: { ...change.preview, body } }, 'previewed');
  return { change: next, ok: true, body, drifted: !!fresh.changedSince, live: fresh.before };
}

/** Read what is live right now for this change, and say whether the write is still needed. */
async function currentState(ctx, change) {
  const payload = change.payload || {};
  if (payload.mutation === 'urlRedirectCreate') {
    const path = payload.variables.urlRedirect.path;
    const found = await findRedirect(ctx, path);
    if (!found.ok) return { ok: false, error: found.error };
    const wanted = payload.variables.urlRedirect.target;
    return {
      ok: true, before: { redirect: found.redirect },
      idempotent: !!(found.redirect && String(found.redirect.target) === wanted),
      blocked: !!(found.redirect && String(found.redirect.target) !== wanted),
      changedSince: JSON.stringify(found.redirect || null) !== JSON.stringify((change.before && change.before.redirect) || null),
      node: found.redirect,
    };
  }
  const kind = payload.resource === 'collection' ? 'collection' : 'product';
  const found = await resolveResource(ctx, { kind, handle: payload.handle });
  if (!found.ok) return { ok: false, error: found.error };
  const node = found.node;
  if (payload.mutation === 'metafieldsSet') {
    const value = node.metafield ? String(node.metafield.value) : null;
    return { ok: true, before: { gid: node.id, metafield: node.metafield || null }, idempotent: value === '1', changedSince: value !== ((change.before && change.before.metafield && String(change.before.metafield.value)) || null), node };
  }
  const before = { title: (node.seo && node.seo.title) || null, description: (node.seo && node.seo.description) || null };
  const fields = payload.fields || {};
  return {
    ok: true, before: { gid: node.id, seo: before },
    idempotent: Object.entries(fields).every(([k, v]) => String(before[k] || '') === v),
    changedSince: JSON.stringify(before) !== JSON.stringify((change.before && change.before.seo) || null),
    node,
  };
}

/** apply: re-read, then run the mutation. `userErrors` are surfaced as a failure, never swallowed. */
export async function apply(change, ctx = {}) {
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String(e && e.message || e) }; }
  const local = { ...ctx, store: ctx.store || resolveStore(ctx) };
  const payload = confirmed.payload || {};

  const fresh = await currentState(local, confirmed);
  if (!fresh.ok) return { change: transition(confirmed, 'failed', { error: 'could not read the current state before writing: ' + fresh.error }), ok: false };
  if (fresh.idempotent) return { change: transition(confirmed, 'skipped_idempotent'), ok: true, reason: 'the live values already match this change' };
  if (fresh.blocked) {
    return { change: transition(confirmed, 'failed', { error: 'a different redirect already exists for this path — resolve it in the Admin first' }), ok: false };
  }

  const res = await adminRequest(local, { query: payload.document, variables: payload.variables });
  if (!res.ok) return { change: transition(confirmed, 'failed', { error: 'the Admin API rejected the mutation: ' + res.error }), ok: false, status: res.status };
  const errs = userErrorsOf(res.data, payload.mutation);
  if (errs.length) return { change: transition(confirmed, 'failed', { error: payload.mutation + ' returned userErrors: ' + errs.join('; ') }), ok: false, user_errors: errs };

  const created = payload.mutation === 'urlRedirectCreate' ? (res.data.urlRedirectCreate && res.data.urlRedirectCreate.urlRedirect) : null;
  if (ctx.run) {
    writeJson(ctx.run.beforePath(confirmed.id), { change: confirmed.id, before: fresh.before, read_at: new Date().toISOString() });
    writeJson(ctx.run.afterPath(confirmed.id), redactObject({
      change: confirmed.id, mutation: payload.mutation, store: local.store, api_version: API_VERSION,
      result: res.data, applied_at: new Date().toISOString(),
    }, { env: ctx.env || process.env }));
    ctx.run.log({ event: 'apply', adapter: ADAPTER, change: confirmed.id, mutation: payload.mutation, live: true });
  }
  const rollback = created && created.id
    ? { kind: 'delete-redirect', data: { id: created.id, path: created.path, target: created.target } }
    : { ...confirmed.rollback, data: { ...(confirmed.rollback && confirmed.rollback.data), ...fresh.before } };
  return { change: transition({ ...confirmed, before: fresh.before, rollback }, 'applied'), ok: true, result: res.data };
}

/**
 * verify: re-query the Admin API and, for SEO fields, snapshot the public URL too. The storefront
 * can lag behind the Admin, so "the API has it, the page does not yet" is `pending_cache`.
 */
export async function verify(change, ctx = {}) {
  const local = { ...ctx, store: ctx.store || resolveStore(ctx) };
  const payload = change.payload || {};
  const fresh = await currentState(local, change);
  if (!fresh.ok) {
    return { change, ok: null, checks: [{ name: 'admin-api', ok: null, detail: 'could not re-read the resource: ' + fresh.error }] };
  }
  const apiOk = payload.mutation === 'urlRedirectCreate'
    ? !!(fresh.node && String(fresh.node.target) === payload.variables.urlRedirect.target)
    : fresh.idempotent;
  const checks = [{ name: 'admin-api', ok: apiOk, detail: apiOk ? 'the Admin API returns the new value' : 'the Admin API still returns ' + JSON.stringify(fresh.before) }];

  const url = change.target && change.target.url;
  if (apiOk && payload.fields && url) {
    const pub = await fetchPublic(url, ctx);
    if (!pub.ok) checks.push({ name: 'public-url', ok: null, detail: 'could not fetch ' + url + ': ' + pub.error });
    else {
      const seen = publicSeoOf(pub.snapshot);
      const hits = Object.entries(payload.fields).filter(([k, v]) => String(seen[k] || '').trim() === String(v).trim());
      const allSeen = hits.length === Object.keys(payload.fields).length;
      checks.push({ name: 'public-url', ok: allSeen, detail: allSeen ? 'the storefront serves the new values' : 'the storefront still serves ' + JSON.stringify(seen) });
      if (!allSeen) {
        const next = change.status === 'applied' || change.status === 'pending_cache' ? transition(change, 'pending_cache') : change;
        return { change: next, ok: null, checks, url, note: 'the Admin API has the new value but ' + url + ' has not caught up — Shopify caches the storefront; re-verify shortly' };
      }
    }
  }
  if (apiOk) {
    if (change.status === 'verified') return { change, ok: true, checks };
    return { change: transition(change, 'verified'), ok: true, checks };
  }
  const failed = change.status === 'applied' || change.status === 'pending_cache'
    ? transition(change, 'failed', { error: 'verification failed: the Admin API does not return the new value' })
    : change;
  return { change: failed, ok: false, checks };
}

/** The title and description the storefront is actually serving (parsed title is {value, count}). */
export function publicSeoOf(snapshot) {
  const p = (snapshot && snapshot.parsed) || {};
  const desc = (Array.isArray(p.metas) ? p.metas : []).find((m) => m && String(m.name).toLowerCase() === 'description');
  const title = p.title && typeof p.title === 'object' ? p.title.value : p.title;
  return { title: title || '', description: (desc && desc.content) || '' };
}

async function fetchPublic(url, ctx = {}) {
  try {
    const opts = { persist: false, artifacts: 'none', render: 'static', env: ctx.env || process.env };
    if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
    const snap = await snapshotUrl(url, opts);
    if (!snap.ok) return { ok: false, snapshot: null, error: snap.error || 'snapshot failed' };
    return { ok: true, snapshot: snap.snapshot, error: null };
  } catch (e) {
    return { ok: false, snapshot: null, error: String(e && e.message || e) };
  }
}

/** rollback: put the recorded `before` values back, or delete the redirect this run created. */
export async function rollback(change, ctx = {}) {
  const local = { ...ctx, store: ctx.store || resolveStore(ctx) };
  const payload = change.payload || {};
  const data = (change.rollback && change.rollback.data) || {};

  if (change.rollback && change.rollback.kind === 'delete-redirect') {
    let id = data.id || null;
    if (!id) {
      const found = await findRedirect(local, data.path);
      if (!found.ok) return { change: transition(change, 'failed', { error: 'could not look up the redirect to delete: ' + found.error }), ok: false };
      if (!found.redirect) return { change: transition(change, 'rolled_back'), ok: true, note: 'no redirect for ' + data.path + ' exists any more' };
      if (data.target && String(found.redirect.target) !== String(data.target)) {
        return { change: transition(change, 'failed', { error: 'the redirect for ' + data.path + ' now points at ' + found.redirect.target + ', not the one this run created — leaving it alone' }), ok: false };
      }
      id = found.redirect.id;
    }
    const res = await adminRequest(local, { query: MUTATIONS.urlRedirectDelete, variables: { id } });
    if (!res.ok) return { change: transition(change, 'failed', { error: 'urlRedirectDelete failed: ' + res.error }), ok: false };
    const errs = userErrorsOf(res.data, 'urlRedirectDelete');
    if (errs.length) return { change: transition(change, 'failed', { error: 'urlRedirectDelete returned userErrors: ' + errs.join('; ') }), ok: false };
    if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, mutation: 'urlRedirectDelete' });
    return { change: transition(change, 'rolled_back'), ok: true, deleted: id };
  }

  if (payload.mutation === 'metafieldsSet') {
    const previous = (change.before && change.before.metafield) || data.metafield || null;
    const ownerId = data.gid || (change.before && change.before.gid) || payload.gid;
    const req = previous && previous.value !== undefined && previous.value !== null
      ? { query: MUTATIONS.metafieldsSet, variables: { metafields: [{ ownerId, namespace: 'seo', key: 'hidden', type: previous.type || HIDDEN_METAFIELD_INPUT.type, value: String(previous.value) }] }, name: 'metafieldsSet' }
      : { query: MUTATIONS.metafieldsDelete, variables: { metafields: [{ ownerId, namespace: 'seo', key: 'hidden' }] }, name: 'metafieldsDelete' };
    const res = await adminRequest(local, req);
    if (!res.ok) return { change: transition(change, 'failed', { error: req.name + ' failed: ' + res.error }), ok: false };
    const errs = userErrorsOf(res.data, req.name);
    if (errs.length) return { change: transition(change, 'failed', { error: req.name + ' returned userErrors: ' + errs.join('; ') }), ok: false };
    if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, mutation: req.name });
    return { change: transition(change, 'rolled_back'), ok: true, restored: previous ? previous.value : null };
  }

  const seo = data.seo || (change.before && change.before.seo) || null;
  const gid = data.gid || (change.before && change.before.gid) || payload.gid;
  if (!seo || !gid) {
    return { change: transition(change, 'failed', { error: 'no recorded "before" values for this change — restore the SEO fields in the Admin by hand' }), ok: false };
  }
  const mutation = data.mutation || payload.mutation;
  const fields = {};
  for (const k of Object.keys(payload.fields || { title: null, description: null })) fields[k] = seo[k] === null || seo[k] === undefined ? '' : seo[k];
  const res = await adminRequest(local, { query: MUTATIONS[mutation], variables: { input: { id: gid, seo: fields } } });
  if (!res.ok) return { change: transition(change, 'failed', { error: mutation + ' failed on rollback: ' + res.error }), ok: false };
  const errs = userErrorsOf(res.data, mutation);
  if (errs.length) return { change: transition(change, 'failed', { error: mutation + ' returned userErrors on rollback: ' + errs.join('; ') }), ok: false };
  if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, mutation });
  return { change: transition(change, 'rolled_back'), ok: true, restored: fields };
}

// ---------------------------------------------------------------------------
// CLI

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args) {
  const plan = run ? run.readPlan() : null;
  const all = plan && Array.isArray(plan.changes) ? plan.changes : [];
  const mine = all.filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    return mine.filter((c) => wanted.has(c.id));
  }
  return mine;
}

function persist(run, updated) {
  if (!run || !updated.length) return;
  const plan = run.readPlan();
  if (!plan || !Array.isArray(plan.changes)) return;
  const byId = new Map(updated.map((c) => [c.id, c]));
  plan.changes = plan.changes.map((c) => (byId.has(c.id) ? byId.get(c.id) : c));
  run.setChanges(plan.changes);
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) {
    return { result: { error: 'usage: shopify-admin <' + OPS.join('|') + '> --run <dir> [--change <id>] [--ticket <t>] [--store <s>]' }, code: EXIT.USAGE };
  }
  const dataDir = resolveDataDir(args);
  const ctx = { dataDir, env: process.env, now: () => new Date(), store: args.store && args.store !== true ? normalizeStore(String(args.store)) : null };
  ctx.store = ctx.store || resolveStore(ctx);

  if (op === 'capabilities') return { result: await capabilities(ctx), code: EXIT.OK };

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    if (!existsSync(String(args.report))) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const profilePath = args.profile && args.profile !== true ? String(args.profile) : null;
    const run = loadRun(args, dataDir) || openFixRun(dataDir, { report: String(args.report), profile: profilePath, target: report.target || null, adapters: [ADAPTER] });
    ctx.run = run;
    const out = await plan({
      report, profile: profilePath, store: ctx.store,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) if (c.preview && c.preview.body) writeText(run.previewPath(c.id, '.graphql.txt'), c.preview.body);
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length, skipped: out.skipped.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  const changes = pickChanges(run, args);
  if (!changes.length) {
    return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };
  }

  const results = [];
  const updated = [];
  for (const change of changes) {
    if (op === 'apply') {
      const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change.id });
      if (!gate.ok) {
        results.push({ change: change.id, ok: false, refused: gate.reason, error: 'apply writes live data and needs a valid confirmation ticket (' + gate.reason + ')' });
        continue;
      }
    }
    const fn = { preview, apply, verify, rollback }[op];
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push({
      change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok,
      ...(out.error ? { error: out.error } : {}), ...(out.checks ? { checks: out.checks } : {}),
      ...(out.reason ? { reason: out.reason } : {}), ...(out.note ? { note: out.note } : {}),
      ...(out.user_errors ? { user_errors: out.user_errors } : {}), ...(out.drifted ? { drifted: true } : {}),
      ...(out.warning ? { warning: out.warning } : {}), ...(out.read_error ? { read_error: out.read_error } : {}),
    });
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, store: ctx.store, api_version: API_VERSION, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
