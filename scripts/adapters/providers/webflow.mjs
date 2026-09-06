// page-api provider: Webflow (Data API v2).
//
// Webflow is the one no-code platform in this set with a real staging boundary: a `PUT /v2/pages/{id}`
// lands in the project's unpublished state and the site only changes when the project is published.
// So every change here is `live_impact: staged`, `verify` reports "saved, not published" instead of
// pretending, and `publish` is a separate op with its own confirmation ticket.
//
// Read-modify-write on purpose: the page metadata object is sent whole, so the current `title`,
// `slug` and the untouched half of `seo`/`openGraph` travel back unchanged rather than being blanked.
//
// UNVERIFIED in this build: the exact field names inside `openGraph`, and the request body of the
// custom-code API (JSON-LD in the page head). OG fields are sent only when a finding supplies them
// and the preview says they are unverified; custom code, redirects and staging-indexing are not
// written at all — they come back as `skipped` for the instructions adapter.

import { changeId, makeChange } from '../../lib/adapter.mjs';
import { explainKeys, missingKeys, resolveKey } from '../../lib/credentials.mjs';
import { reproduceCommand } from '../../lib/finding.mjs';
import { readJson } from '../../lib/store.mjs';
import {
  describeFailure, groupByPage, httpFor, makeRemoteOps, normalizeAnswers, pathOf, renderRequestPreview,
} from '../_shared.mjs';

export const PROVIDER = 'webflow';
export const KEYS = Object.freeze(['WEBFLOW_TOKEN', 'WEBFLOW_SITE_ID']);
export const SCOPES = Object.freeze(['pages:read', 'pages:write', 'sites:write']);
export const API_BASE = 'https://api.webflow.com';
/** Fields whose names we have not confirmed against the vendor docs in this build. */
export const UNVERIFIED = Object.freeze(['openGraph field names', 'custom-code API request shape']);

/** Fields this provider can write, mapped to where they live in the page metadata object. */
const FIELD_MAP = Object.freeze({
  title: { group: 'seo', key: 'title' },
  description: { group: 'seo', key: 'description' },
  og_title: { group: 'openGraph', key: 'title' },
  og_description: { group: 'openGraph', key: 'description' },
});

export function headersFor(ctx = {}) {
  const token = resolveKey('WEBFLOW_TOKEN', ctx.env || process.env);
  if (!token) return null;
  return { authorization: 'Bearer ' + token, accept: 'application/json' };
}

function siteId(ctx = {}, options = {}) {
  return options.site || ctx.site || resolveKey('WEBFLOW_SITE_ID', ctx.env || process.env) || null;
}

/** capabilities: the token can read the site's page list (a write scope cannot be probed read-only). */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const needs = missingKeys(KEYS, env);
  const out = {
    provider: PROVIDER, ready: false, needs, tools: {}, scopes: [...SCOPES],
    writes: 'Webflow page SEO fields — staged until the project is published',
    unverified: [...UNVERIFIED], notes: [],
  };
  if (needs.length) { out.notes.push(...explainKeys(KEYS, { env }).lines); return out; }
  const site = siteId(ctx, options);
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(API_BASE + '/v2/sites/' + encodeURIComponent(site) + '/pages', { headers: headersFor(ctx), query: { limit: 1 } }); }
  catch (e) { out.notes.push('could not reach the Webflow API: ' + String((e && e.message) || e)); return out; }
  if (!res.ok) { out.notes.push('GET /v2/sites/{site}/pages failed: ' + describeFailure(res, env)); return out; }
  out.ready = true;
  out.site = site;
  out.pages = res.json && res.json.pagination ? res.json.pagination.total : undefined;
  out.notes.push('a write needs the pages:write scope; publishing needs sites:write. Neither can be probed without using it, so a 403 on apply means the token is missing that scope.');
  return out;
}

/** Every page in the site, following the API's offset pagination. */
export async function listPages(ctx = {}, options = {}) {
  const site = siteId(ctx, options);
  const headers = headersFor(ctx);
  if (!site || !headers) return { ok: false, pages: [], error: 'missing WEBFLOW_SITE_ID or WEBFLOW_TOKEN' };
  const http = httpFor(ctx);
  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 40; guard++) {
    let res;
    try { res = await http.get(API_BASE + '/v2/sites/' + encodeURIComponent(site) + '/pages', { headers, query: { limit: 100, offset } }); }
    catch (e) { return { ok: false, pages, error: String((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, pages, error: describeFailure(res, ctx.env || process.env) };
    const batch = res.json && Array.isArray(res.json.pages) ? res.json.pages : [];
    pages.push(...batch);
    const total = res.json && res.json.pagination ? Number(res.json.pagination.total) : pages.length;
    offset += batch.length;
    if (!batch.length || pages.length >= total) break;
  }
  return { ok: true, pages, error: null };
}

/** Match an audited URL to a Webflow page by publishedPath first, then slug. */
export function matchPage(pages, page) {
  const wanted = pathOf(page.url);
  const bySlug = wanted.split('/').filter(Boolean).pop() || '';
  for (const p of pages) {
    if (p && p.publishedPath && pathOf(p.publishedPath) === wanted) return p;
  }
  for (const p of pages) {
    if (p && p.slug && String(p.slug).toLowerCase() === bySlug) return p;
  }
  if (wanted === '/') {
    const home = pages.find((p) => p && (p.slug === '' || p.slug === 'index' || p.publishedPath === '/'));
    if (home) return home;
  }
  return null;
}

/** Merge new field values into the page metadata Webflow already holds. */
export function mergePageBody(current, fields) {
  const seo = { ...(current && current.seo ? current.seo : {}) };
  const openGraph = { ...(current && current.openGraph ? current.openGraph : {}) };
  const touched = { seo: false, openGraph: false };
  for (const [field, value] of Object.entries(fields)) {
    const slot = FIELD_MAP[field];
    if (!slot) continue;
    if (slot.group === 'seo') { seo[slot.key] = value; touched.seo = true; }
    else { openGraph[slot.key] = value; touched.openGraph = true; }
  }
  const body = { title: current ? current.title : undefined, slug: current ? current.slug : undefined };
  if (touched.seo || (current && current.seo)) body.seo = seo;
  if (touched.openGraph || (current && current.openGraph)) body.openGraph = openGraph;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return { body, touched };
}

/** plan: one change per page (Webflow writes the whole page metadata object in one call). */
export async function plan(options = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const notes = [];
  const skipped = [];
  const changes = [];

  const needs = missingKeys(KEYS, env);
  if (needs.length) return { provider: PROVIDER, ready: false, changes, skipped, notes: explainKeys(KEYS, { env }).lines };

  const answers = normalizeAnswers(options.answers);
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  const listed = await listPages(ctx, options);
  if (!listed.ok) return { provider: PROVIDER, ready: false, changes, skipped, notes: ['could not list the site pages: ' + listed.error] };

  const site = siteId(ctx, options);
  for (const page of grouped.pages) {
    const match = matchPage(listed.pages, page);
    if (!match) { skipped.push({ finding: page.finding_ids.join(', '), reason: 'no Webflow page matches ' + page.url + ' (matched on publishedPath and slug)' }); continue; }

    const writable = {};
    for (const [field, entry] of Object.entries(page.fields)) {
      if (FIELD_MAP[field]) writable[field] = entry.value;
      else skipped.push({ finding: entry.finding, reason: '"' + field + '" is not a Webflow page field — JSON-LD and head snippets go through Project settings -> Custom code (instructions adapter)' });
    }
    if (!Object.keys(writable).length) continue;

    const merged = mergePageBody(match, writable);
    const url = API_BASE + '/v2/pages/' + encodeURIComponent(match.id);
    const usesOg = Object.keys(writable).some((f) => FIELD_MAP[f].group === 'openGraph');
    const before = { seo: match.seo || null, openGraph: match.openGraph || null, title: match.title, slug: match.slug };
    const expect = {};
    for (const [field, value] of Object.entries(writable)) expect[field] = value;

    const previewBody = renderRequestPreview({
      method: 'PUT', url, headers: { authorization: '', accept: '', 'content-type': '' },
      body: merged.body, before,
      notes: [
        'live_impact: staged — this saves into the unpublished project state. The public site changes only when you publish (`publish` op, its own confirmation).',
        usesOg ? 'UNVERIFIED: the openGraph field names are not confirmed against the Data API docs in this build. Check the response before trusting the OG half.' : null,
        'the whole page metadata object is sent back, so title and slug keep the values Webflow already has.',
      ],
      env,
    });

    const id = changeId({
      adapter: 'page-api', op: 'update-fields',
      target: { kind: 'page', locator: 'webflow:page:' + match.id, url: page.url },
      finding_ids: page.finding_ids, strategy: 'webflow-page-seo', payload: { fields: writable },
    });
    const built = makeChange({
      id,
      finding_ids: page.finding_ids,
      adapter: 'page-api',
      class: 'proposed',
      target: { kind: 'page', locator: 'webflow:page:' + match.id, url: page.url },
      op: 'update-fields',
      strategy: 'webflow-page-seo',
      payload: {
        provider: PROVIDER, site, page_id: match.id, method: 'PUT', url, body: merged.body,
        fields: writable, expect, unverified: usesOg ? ['openGraph field names'] : [],
      },
      preview: { kind: 'payload', body: previewBody, lang: 'json' },
      before: { source: 'GET /v2/sites/' + site + '/pages', values: before },
      requires: { credentials: [...KEYS], tools: [], scopes: ['pages:write'] },
      live_impact: 'staged',
      verify: {
        method: 'dom_assert',
        command: reproduceCommand('adapters/page-api.mjs', ['verify', '--provider', PROVIDER, '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id]),
        assertion: 'GET /v2/pages/' + match.id + ' reports the new seo fields; the public page changes only after a publish',
        url: page.url,
      },
      rollback: { kind: 'restore-fields', data: { method: 'PUT', url, body: { title: match.title, slug: match.slug, seo: match.seo || {}, openGraph: match.openGraph || {} } } },
      status: 'planned',
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) skipped.push({ finding: page.finding_ids.join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  notes.push('redirects, staging indexing and head custom code are Designer/Project-settings actions in this build — they are handed to the instructions adapter rather than written blind.');
  return { provider: PROVIDER, ready: true, site, changes, skipped, notes };
}

const ops = makeRemoteOps({
  provider: PROVIDER,
  headers: headersFor,
  staged: (change) => change.live_impact === 'staged',
  stagedNote: () => 'saved to the unpublished project state. The public site still serves the old values until you publish: `node scripts/adapters/page-api.mjs publish --provider webflow --run <run>` (a second confirmation, its own ticket).',
  async readback({ change, ctx, headers }) {
    const payload = change.payload || {};
    const http = httpFor(ctx);
    const res = await http.get(API_BASE + '/v2/pages/' + encodeURIComponent(payload.page_id), { headers });
    if (!res.ok) return { ok: false, error: describeFailure(res, ctx.env || process.env) };
    const json = res.json || {};
    const values = {};
    for (const [field, slot] of Object.entries(FIELD_MAP)) {
      const group = json[slot.group];
      if (group && typeof group === 'object' && group[slot.key] !== undefined) values[field] = group[slot.key];
    }
    return { ok: true, values };
  },
});

export const preview = ops.preview;
export const apply = ops.apply;
export const verify = ops.verify;
export const rollback = ops.rollback;

/**
 * publish: push the project live. This is the moment a staged change becomes public, so it carries
 * its own confirmation ticket (checked by the CLI) and never runs as part of `apply`.
 */
export async function publish(_change, ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const headers = headersFor(ctx);
  const site = siteId(ctx, options);
  if (!headers || !site) return { ok: false, error: 'missing ' + missingKeys(KEYS, env).join(', ') };
  const url = API_BASE + '/v2/sites/' + encodeURIComponent(site) + '/publish';
  const body = { publishToWebflowSubdomain: options.subdomain === true };
  if (Array.isArray(options.domains) && options.domains.length) body.customDomains = options.domains;
  const http = httpFor(ctx);
  let res;
  try { res = await http.json(url, { method: 'POST', headers, body }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!res.ok) return { ok: false, status: res.status, error: describeFailure(res, env) };
  if (ctx.run) ctx.run.log({ event: 'publish', adapter: 'page-api', provider: PROVIDER, site, status: res.status });
  return {
    ok: true, status: res.status, site, url,
    note: 'the project was published: every staged change in it — including ones this tool did not make — is now live.',
  };
}
