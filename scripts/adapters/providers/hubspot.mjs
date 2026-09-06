// page-api provider: HubSpot CMS pages (API v3).
//
// HubSpot has the one draft model in this set that is genuinely useful: a `PATCH …/{id}/draft`
// changes the page's draft, and a separate push-live step publishes it. That two-step *is* the
// confirmation gate, so:
//   * the default route writes the draft and reports `live_impact: staged`;
//   * `verify` on a staged change says "saved to the draft, the public page has not changed" —
//     that is the honest answer, not a failure and not a pass;
//   * `publish` (push-live) is its own op with its own ticket;
//   * `--live` switches to the direct `PATCH …/{id}`, which *is* live, and the preview says so.
//
// UNVERIFIED in this build: the push-live path segment and the `headHtml` field name. Head HTML is
// therefore not written at all — it comes back as `skipped` for the instructions adapter.

import { changeId, makeChange } from '../../lib/adapter.mjs';
import { explainKeys, missingKeys, resolveKey } from '../../lib/credentials.mjs';
import { reproduceCommand } from '../../lib/finding.mjs';
import { readJson } from '../../lib/store.mjs';
import {
  describeFailure, groupByPage, httpFor, makeRemoteOps, normalizeAnswers, pathOf, renderRequestPreview,
} from '../_shared.mjs';

export const PROVIDER = 'hubspot';
export const KEYS = Object.freeze(['HUBSPOT_TOKEN']);
export const API_BASE = 'https://api.hubapi.com';
export const PAGES_PATH = '/cms/v3/pages/site-pages';
export const BLOG_PATH = '/cms/v3/blogs/posts';
export const UNVERIFIED = Object.freeze(['draft push-live path segment', 'headHtml field name']);

/** Finding field -> HubSpot page property. */
export const FIELD_MAP = Object.freeze({
  title: 'htmlTitle',
  description: 'metaDescription',
});

export function headersFor(ctx = {}) {
  const token = resolveKey('HUBSPOT_TOKEN', ctx.env || process.env);
  if (!token) return null;
  return { authorization: 'Bearer ' + token, accept: 'application/json' };
}

function basePath(options = {}) {
  return options.blog ? BLOG_PATH : PAGES_PATH;
}

/** capabilities: the private-app token can list CMS pages. */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const needs = missingKeys(KEYS, env);
  const out = {
    provider: PROVIDER, ready: false, needs, tools: {},
    scopes: ['content', 'cms.knowledge_base.articles.write'],
    writes: 'HubSpot CMS page title/meta description — into the draft by default, live only on push',
    unverified: [...UNVERIFIED], notes: [],
  };
  if (needs.length) { out.notes.push(...explainKeys(KEYS, { env }).lines); return out; }
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(API_BASE + basePath(options), { headers: headersFor(ctx), query: { limit: 1 } }); }
  catch (e) { out.notes.push('could not reach the HubSpot API: ' + String((e && e.message) || e)); return out; }
  if (!res.ok) { out.notes.push('GET ' + basePath(options) + ' failed: ' + describeFailure(res, env)); return out; }
  out.ready = true;
  out.pages = res.json && res.json.total !== undefined ? res.json.total : undefined;
  out.notes.push('blog posts live on ' + BLOG_PATH + ', a different endpoint with the same field names — pass --blog for those.');
  return out;
}

/** Every CMS page, following the API's `after` cursor. */
export async function listPages(ctx = {}, options = {}) {
  const headers = headersFor(ctx);
  if (!headers) return { ok: false, pages: [], error: 'missing HUBSPOT_TOKEN' };
  const http = httpFor(ctx);
  const pages = [];
  let after = null;
  for (let guard = 0; guard < 40; guard++) {
    const query = { limit: 100 };
    if (after) query.after = after;
    let res;
    try { res = await http.get(API_BASE + basePath(options), { headers, query }); }
    catch (e) { return { ok: false, pages, error: String((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, pages, error: describeFailure(res, ctx.env || process.env) };
    const batch = res.json && Array.isArray(res.json.results) ? res.json.results : [];
    pages.push(...batch);
    after = res.json && res.json.paging && res.json.paging.next ? res.json.paging.next.after : null;
    if (!after || !batch.length) break;
  }
  return { ok: true, pages, error: null };
}

/** Match an audited URL to a HubSpot page by its absolute url, then by slug. */
export function matchPage(pages, page) {
  const wanted = pathOf(page.url);
  for (const p of pages) {
    if (p && p.url && pathOf(p.url) === wanted) return p;
  }
  const slug = wanted.split('/').filter(Boolean).pop() || '';
  for (const p of pages) {
    if (p && p.slug && pathOf('/' + String(p.slug)) === '/' + slug) return p;
  }
  return null;
}

/** plan: one change per page. */
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

  const direct = options.live === true;
  const answers = normalizeAnswers(options.answers);
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  const listed = await listPages(ctx, options);
  if (!listed.ok) return { provider: PROVIDER, ready: false, changes, skipped, notes: ['could not list CMS pages: ' + listed.error] };

  for (const page of grouped.pages) {
    const match = matchPage(listed.pages, page);
    if (!match) { skipped.push({ finding: page.finding_ids.join(', '), reason: 'no HubSpot page matches ' + page.url + ' (matched on url and slug)' }); continue; }

    const body = {};
    const expect = {};
    const before = {};
    for (const [field, entry] of Object.entries(page.fields)) {
      const prop = FIELD_MAP[field];
      if (!prop) {
        skipped.push({ finding: entry.finding, reason: '"' + field + '" would need the page headHtml field, whose name is UNVERIFIED in this build — use page Settings -> Advanced options -> Head HTML (instructions adapter)' });
        continue;
      }
      body[prop] = entry.value;
      expect[field] = entry.value;
      before[prop] = match[prop] === undefined ? null : match[prop];
    }
    if (!Object.keys(body).length) continue;

    const path = basePath(options) + '/' + encodeURIComponent(match.id) + (direct ? '' : '/draft');
    const url = API_BASE + path;
    const previewBody = renderRequestPreview({
      method: 'PATCH', url, headers: { authorization: '', 'content-type': '' }, body, before,
      notes: [
        direct
          ? 'live_impact: LIVE — --live patches the published page directly, skipping the draft. The public page changes immediately.'
          : 'live_impact: staged — this patches the page draft. Nothing public changes until the draft is pushed live (`publish` op, its own confirmation).',
        direct ? null : 'UNVERIFIED: the push-live path segment (' + PAGES_PATH + '/{id}/draft/push-live) is not confirmed in this build; `publish` reports the exact response it gets.',
      ],
      env,
    });

    const id = changeId({
      adapter: 'page-api', op: 'update-fields',
      target: { kind: 'page', locator: 'hubspot:page:' + match.id + (direct ? '' : ':draft'), url: page.url },
      finding_ids: page.finding_ids, strategy: direct ? 'hubspot-page-live' : 'hubspot-page-draft', payload: { body },
    });
    const built = makeChange({
      id,
      finding_ids: page.finding_ids,
      adapter: 'page-api',
      class: 'proposed',
      target: { kind: 'page', locator: 'hubspot:page:' + match.id + (direct ? '' : ':draft'), url: page.url },
      op: 'update-fields',
      strategy: direct ? 'hubspot-page-live' : 'hubspot-page-draft',
      payload: {
        provider: PROVIDER, page_id: match.id, method: 'PATCH', url, path, body, expect,
        draft: !direct, blog: !!options.blog, unverified: direct ? [] : ['draft push-live path segment'],
      },
      preview: { kind: 'payload', body: previewBody, lang: 'json' },
      before: { source: 'GET ' + basePath(options), values: before },
      requires: { credentials: [...KEYS], tools: [], scopes: ['content'] },
      live_impact: direct ? 'live' : 'staged',
      verify: {
        method: 'dom_assert',
        command: reproduceCommand('adapters/page-api.mjs', ['verify', '--provider', PROVIDER, '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id]),
        assertion: direct
          ? 'the page reports the new title/description and the public page serves them'
          : 'the page draft reports the new title/description; the public page changes only after push-live',
        url: page.url,
      },
      rollback: { kind: 'restore-fields', data: { method: 'PATCH', url, body: before } },
      status: 'planned',
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) skipped.push({ finding: page.finding_ids.join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  notes.push('redirects and image alt text are HubSpot settings/editor actions — handed to the instructions adapter.');
  return { provider: PROVIDER, ready: true, draft_mode: !direct, changes, skipped, notes };
}

const ops = makeRemoteOps({
  provider: PROVIDER,
  headers: headersFor,
  staged: (change) => change.live_impact === 'staged',
  stagedNote: (change) => 'saved to the page draft. The public page still serves the old values until it is pushed live: '
    + 'node scripts/adapters/page-api.mjs publish --provider hubspot --run <run> --change ' + change.id + ' (a second confirmation, its own ticket).',
  async readback({ change, ctx, headers }) {
    const payload = change.payload || {};
    const http = httpFor(ctx);
    const res = await http.get(payload.url, { headers });
    if (!res.ok) return { ok: false, error: describeFailure(res, ctx.env || process.env) };
    const json = res.json || {};
    const values = {};
    for (const [field, prop] of Object.entries(FIELD_MAP)) {
      if (payload.expect && payload.expect[field] === undefined) continue;
      if (json[prop] !== undefined) values[field] = json[prop];
    }
    return { ok: true, values };
  },
});

export const preview = ops.preview;
export const apply = ops.apply;
export const verify = ops.verify;
export const rollback = ops.rollback;

/**
 * publish: push a page's draft live. Its own op, its own ticket — this is the step that makes a
 * staged change public.
 */
export async function publish(change, ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const headers = headersFor(ctx);
  if (!headers) return { ok: false, error: 'missing HUBSPOT_TOKEN' };
  const payload = (change && change.payload) || {};
  const pageId = payload.page_id || options.page;
  if (!pageId) return { ok: false, error: 'publish needs --change <id> (or --page <id>) so it knows which draft to push live' };
  const url = API_BASE + (payload.blog || options.blog ? BLOG_PATH : PAGES_PATH) + '/' + encodeURIComponent(pageId) + '/draft/push-live';
  const http = httpFor(ctx);
  let res;
  try { res = await http.json(url, { method: 'POST', headers, body: {} }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!res.ok) {
    return {
      ok: false, status: res.status, url, error: describeFailure(res, env),
      note: res.status === 404 ? 'the push-live path is UNVERIFIED in this build and this account answered 404 — publish the page from the HubSpot editor instead.' : undefined,
    };
  }
  if (ctx.run) ctx.run.log({ event: 'publish', adapter: 'page-api', provider: PROVIDER, change: change ? change.id : null, status: res.status });
  return { ok: true, status: res.status, url, note: 'the draft was pushed live: every draft edit on that page is now public, not only this one.' };
}
