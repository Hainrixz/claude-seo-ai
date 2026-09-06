// page-api provider: BigCommerce (Catalog API for products, Content API for pages).
//
// The interesting constraint here is not SEO advice, it is a platform limit: `page_title` is capped
// at 70 characters and `meta_description` at 160, and a longer value is rejected outright. So a
// value that is too long is truncated **at a word boundary** and the preview says it was truncated
// and by how much — a silent trim would put a half-sentence on someone's product page.
//
// Catalog fields have no draft state: they are live on write. Writes are also channel-aware, which
// this build cannot verify from the outside, so the preview says which channel assumption it is
// making (none) rather than pretending it checked.
//
// UNVERIFIED in this build: the content-pages field names and the channel-assignment payload.

import { changeId, makeChange } from '../../lib/adapter.mjs';
import { explainKeys, missingKeys, resolveKey } from '../../lib/credentials.mjs';
import { reproduceCommand } from '../../lib/finding.mjs';
import { readJson } from '../../lib/store.mjs';
import {
  describeFailure, groupByPage, httpFor, makeRemoteOps, normalizeAnswers, pathOf,
  renderRequestPreview, truncateAtWord,
} from '../_shared.mjs';

export const PROVIDER = 'bigcommerce';
export const KEYS = Object.freeze(['BIGCOMMERCE_STORE_HASH', 'BIGCOMMERCE_TOKEN']);
export const API_BASE = 'https://api.bigcommerce.com';
export const UNVERIFIED = Object.freeze(['content-pages field names', 'channel-assignment payload']);

/** The platform's own field limits — not an SEO opinion. */
export const LIMITS = Object.freeze({ page_title: 70, meta_description: 160 });

/** Finding field -> API property, per resource kind. */
export const FIELD_MAP = Object.freeze({
  product: Object.freeze({ title: 'page_title', description: 'meta_description' }),
  page: Object.freeze({ title: 'meta_title', description: 'meta_description' }),
});

export function headersFor(ctx = {}) {
  const token = resolveKey('BIGCOMMERCE_TOKEN', ctx.env || process.env);
  if (!token) return null;
  return { 'x-auth-token': token, accept: 'application/json' };
}

function storeBase(ctx = {}, options = {}) {
  const hash = options.store || ctx.store || resolveKey('BIGCOMMERCE_STORE_HASH', ctx.env || process.env);
  if (!hash) return null;
  return API_BASE + '/stores/' + encodeURIComponent(hash);
}

/** capabilities: the token can read the catalog. */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const needs = missingKeys(KEYS, env);
  const out = {
    provider: PROVIDER, ready: false, needs, tools: {},
    scopes: ['store_v2_products', 'store_v2_content'],
    writes: 'BigCommerce product/page SEO fields — live on write, truncated to the platform limits',
    limits: { ...LIMITS }, unverified: [...UNVERIFIED], notes: [],
  };
  if (needs.length) { out.notes.push(...explainKeys(KEYS, { env }).lines); return out; }
  const base = storeBase(ctx, options);
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(base + '/v3/catalog/summary', { headers: headersFor(ctx) }); }
  catch (e) { out.notes.push('could not reach the BigCommerce API: ' + String((e && e.message) || e)); return out; }
  if (!res.ok) { out.notes.push('GET /v3/catalog/summary failed: ' + describeFailure(res, env)); return out; }
  out.ready = true;
  out.store = base;
  if (res.json && res.json.data) out.catalog = { products: res.json.data.inventory_count, variants: res.json.data.variant_count };
  out.notes.push('writes are channel-aware: this build cannot tell which channel the audited storefront belongs to, so it writes the catalog record itself. Confirm the channel if the store serves more than one.');
  return out;
}

/** Products (id + custom_url + current SEO fields), following v3 pagination. */
export async function listProducts(ctx = {}, options = {}) {
  return listAll(ctx, options, '/v3/catalog/products', { include_fields: 'name,custom_url,page_title,meta_description' });
}

/** Content pages (id + url + current SEO fields). */
export async function listContentPages(ctx = {}, options = {}) {
  return listAll(ctx, options, '/v3/content/pages', {});
}

async function listAll(ctx, options, path, extraQuery) {
  const base = storeBase(ctx, options);
  const headers = headersFor(ctx);
  if (!base || !headers) return { ok: false, items: [], error: 'missing BIGCOMMERCE_STORE_HASH or BIGCOMMERCE_TOKEN' };
  const http = httpFor(ctx);
  const items = [];
  for (let page = 1; page <= 40; page++) {
    let res;
    try { res = await http.get(base + path, { headers, query: { limit: 250, page, ...extraQuery } }); }
    catch (e) { return { ok: false, items, error: String((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, items, error: describeFailure(res, ctx.env || process.env) };
    const batch = res.json && Array.isArray(res.json.data) ? res.json.data : [];
    items.push(...batch);
    const pagination = res.json && res.json.meta ? res.json.meta.pagination : null;
    const totalPages = pagination ? Number(pagination.total_pages) : 1;
    if (!batch.length || page >= (Number.isFinite(totalPages) ? totalPages : 1)) break;
  }
  return { ok: true, items, error: null };
}

/** Match an audited URL to a product (custom_url.url) or a content page (url). */
export function matchItem(products, pages, page) {
  const wanted = pathOf(page.url);
  for (const p of products) {
    const url = p && p.custom_url ? p.custom_url.url : null;
    if (url && pathOf(url) === wanted) return { kind: 'product', item: p };
  }
  for (const p of pages) {
    if (p && p.url && pathOf(p.url) === wanted) return { kind: 'page', item: p };
  }
  return null;
}

/** plan: one change per matched product or content page. */
export async function plan(options = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const skipped = [];
  const changes = [];
  const notes = [];

  const needs = missingKeys(KEYS, env);
  if (needs.length) return { provider: PROVIDER, ready: false, changes, skipped, notes: explainKeys(KEYS, { env }).lines };

  const answers = normalizeAnswers(options.answers);
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);
  if (!grouped.pages.length) return { provider: PROVIDER, ready: true, changes, skipped, notes };

  const productList = await listProducts(ctx, options);
  if (!productList.ok) return { provider: PROVIDER, ready: false, changes, skipped, notes: ['could not list products: ' + productList.error] };
  const pageList = await listContentPages(ctx, options);
  if (!pageList.ok) notes.push('could not list content pages (' + pageList.error + '): only products were matched');

  const base = storeBase(ctx, options);
  for (const page of grouped.pages) {
    const match = matchItem(productList.items, pageList.ok ? pageList.items : [], page);
    if (!match) { skipped.push({ finding: page.finding_ids.join(', '), reason: 'no BigCommerce product or content page matches ' + page.url }); continue; }
    const map = FIELD_MAP[match.kind];
    const path = (match.kind === 'product' ? '/v3/catalog/products/' : '/v3/content/pages/') + encodeURIComponent(match.item.id);
    const url = base + path;

    const body = {};
    const expect = {};
    const before = {};
    const truncated = [];
    for (const [field, entry] of Object.entries(page.fields)) {
      const prop = map[field];
      if (!prop) { skipped.push({ finding: entry.finding, reason: '"' + field + '" is not a BigCommerce ' + match.kind + ' field — head snippets go through Script Manager or the Stencil theme (instructions adapter)' }); continue; }
      const limit = LIMITS[prop];
      const cut = limit ? truncateAtWord(entry.value, limit) : { value: entry.value, truncated: false };
      if (cut.truncated) truncated.push({ field: prop, limit, from: String(entry.value).length, to: cut.value.length });
      body[prop] = cut.value;
      expect[field] = cut.value;
      before[prop] = match.item[prop] === undefined ? null : match.item[prop];
    }
    if (!Object.keys(body).length) continue;

    const previewBody = renderRequestPreview({
      method: 'PUT', url, headers: { 'x-auth-token': '', 'content-type': '' }, body, before,
      notes: [
        'live_impact: live — catalog and content fields have no draft state.',
        truncated.length
          ? 'truncated at a word boundary to fit the platform limit: ' + truncated.map((t) => t.field + ' ' + t.from + ' -> ' + t.to + ' chars (max ' + t.limit + ')').join('; ')
          : null,
        match.kind === 'page' ? 'UNVERIFIED: the content-pages field names are not confirmed in this build — check the response body after applying.' : null,
        'channel: this writes the catalog record; a store with several channels may present a different value per channel.',
      ],
      env,
    });

    const id = changeId({
      adapter: 'page-api', op: 'update-fields',
      target: { kind: 'resource', locator: 'bigcommerce:' + match.kind + ':' + match.item.id, url: page.url },
      finding_ids: page.finding_ids, strategy: 'bigcommerce-' + match.kind + '-seo', payload: { body },
    });
    const built = makeChange({
      id,
      finding_ids: page.finding_ids,
      adapter: 'page-api',
      class: 'proposed',
      target: { kind: 'resource', locator: 'bigcommerce:' + match.kind + ':' + match.item.id, url: page.url },
      op: 'update-fields',
      strategy: 'bigcommerce-' + match.kind + '-seo',
      payload: {
        provider: PROVIDER, kind: match.kind, item_id: match.item.id, method: 'PUT', url, path, body, expect,
        truncated, limits: { ...LIMITS },
        unverified: match.kind === 'page' ? ['content-pages field names'] : [],
      },
      preview: { kind: 'payload', body: previewBody, lang: 'json' },
      before: { source: 'GET ' + path, values: before },
      requires: { credentials: [...KEYS], tools: [], scopes: [match.kind === 'product' ? 'store_v2_products' : 'store_v2_content'] },
      live_impact: 'live',
      verify: {
        method: 'dom_assert',
        command: reproduceCommand('adapters/page-api.mjs', ['verify', '--provider', PROVIDER, '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id]),
        assertion: 'the API reports the new SEO fields and the public URL serves them',
        url: page.url,
      },
      rollback: { kind: 'restore-fields', data: { method: 'PUT', url, body: before } },
      status: 'planned',
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) skipped.push({ finding: page.finding_ids.join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  notes.push('robots.txt, the sitemap and 301 redirects are store settings — handed to the instructions adapter.');
  return { provider: PROVIDER, ready: true, store: base, changes, skipped, notes };
}

const ops = makeRemoteOps({
  provider: PROVIDER,
  headers: headersFor,
  async readback({ change, ctx, headers }) {
    const payload = change.payload || {};
    const http = httpFor(ctx);
    const res = await http.get(payload.url, { headers });
    if (!res.ok) return { ok: false, error: describeFailure(res, ctx.env || process.env) };
    const data = res.json && res.json.data ? res.json.data : (res.json || {});
    const map = FIELD_MAP[payload.kind] || FIELD_MAP.product;
    const values = {};
    for (const [field, prop] of Object.entries(map)) {
      if (payload.expect && payload.expect[field] === undefined) continue;
      if (data[prop] !== undefined) values[field] = data[prop];
    }
    return { ok: true, values };
  },
});

export const preview = ops.preview;
export const apply = ops.apply;
export const verify = ops.verify;
export const rollback = ops.rollback;
