// page-api provider: Ghost Admin API.
//
// Ghost authenticates with a short-lived JWT signed from the Admin API key (`<id>:<hex secret>`) —
// built here with `node:crypto`, no dependency, five-minute lifetime, `aud: /admin/`.
//
// The rule that shapes `apply`: **a post update must carry the post's current `updated_at`**. Ghost
// uses it for collision detection, so this adapter re-reads the post right before writing and
// refuses when it no longer matches what the plan was built from — someone else edited the post,
// and silently winning that race would destroy their work.
//
// Extra JSON-LD goes into `codeinjection_head` behind `<!-- claude-seo-ai:start -->` markers, so a
// second run replaces its own block instead of stacking another copy next to it. `status`, `html`,
// `lexical` and the post title are never sent: changing metadata must never publish a draft or
// touch the body.

import { createHmac } from 'node:crypto';
import { changeId, makeChange } from '../../lib/adapter.mjs';
import { explainKeys, missingKeys, resolveKey } from '../../lib/credentials.mjs';
import { DEFAULT_MARKER, markerBlock, markerComment, replaceBetween } from '../../lib/diff.mjs';
import { reproduceCommand } from '../../lib/finding.mjs';
import { readJson } from '../../lib/store.mjs';
import {
  describeFailure, groupByPage, httpFor, makeRemoteOps, normalizeAnswers, renderRequestPreview, slugOf,
} from '../_shared.mjs';

export const PROVIDER = 'ghost';
export const KEYS = Object.freeze(['GHOST_URL', 'GHOST_ADMIN_KEY']);
export const API_PATH = '/ghost/api/admin';
export const API_VERSION = 'v5.0';
/** Resource types a slug lookup tries, in order. */
export const RESOURCES = Object.freeze(['posts', 'pages']);
export const UNVERIFIED = Object.freeze(['Admin API version path (accept-version header value)']);

/** Finding field -> Ghost post field. The post's own `title` is deliberately absent. */
export const FIELD_MAP = Object.freeze({
  title: 'meta_title',
  description: 'meta_description',
  og_title: 'og_title',
  og_description: 'og_description',
  og_image: 'og_image',
  twitter_title: 'twitter_title',
  twitter_description: 'twitter_description',
  canonical: 'canonical_url',
  jsonld: 'codeinjection_head',
});

/** Fields that must never travel in a metadata write. */
export const FORBIDDEN_FIELDS = Object.freeze(['status', 'html', 'mobiledoc', 'lexical', 'title', 'slug', 'authors', 'published_at']);

/**
 * Sign a Ghost Admin API token: HS256 over the hex-decoded secret, `kid` = the key id.
 * @returns {string|null} null when the key is not in `<id>:<secret>` form
 */
export function ghostToken(adminKey, { now = Date.now(), ttlSec = 300 } = {}) {
  const raw = String(adminKey || '').trim();
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const id = raw.slice(0, at);
  const secret = raw.slice(at + 1);
  if (!id || !/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) return null;
  const iat = Math.floor((now instanceof Date ? now.getTime() : Number(now)) / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const data = b64({ alg: 'HS256', typ: 'JWT', kid: id }) + '.' + b64({ iat, exp: iat + Math.max(1, Number(ttlSec) || 300), aud: '/admin/' });
  const sig = createHmac('sha256', Buffer.from(secret, 'hex')).update(data).digest('base64url');
  return data + '.' + sig;
}

export function headersFor(ctx = {}) {
  const env = ctx.env || process.env;
  const token = ghostToken(resolveKey('GHOST_ADMIN_KEY', env), { now: ctx.now ? ctx.now() : Date.now() });
  if (!token) return null;
  return { authorization: 'Ghost ' + token, 'accept-version': API_VERSION, accept: 'application/json' };
}

function siteUrl(ctx = {}, options = {}) {
  const raw = options.site || ctx.site || resolveKey('GHOST_URL', ctx.env || process.env);
  if (!raw) return null;
  return String(raw).trim().replace(/\/+$/, '').replace(new RegExp(API_PATH.replace(/\//g, '\\/') + '$'), '');
}

/** `<site>/ghost/api/admin/<path>` — Ghost is strict about the trailing slash, so it is kept. */
export function adminUrl(site, path) {
  return String(site).replace(/\/+$/, '') + API_PATH + '/' + String(path).replace(/^\/+/, '');
}

/**
 * Insert or refresh this tool's block inside a code-injection field.
 * Running it twice with the same snippet is a no-op — that is the whole point.
 */
export function upsertHeadBlock(current, snippet, marker = DEFAULT_MARKER) {
  const src = String(current == null ? '' : current);
  const body = String(snippet == null ? '' : snippet).trim();
  if (!body) return { text: src, changed: false, reason: 'empty-snippet' };
  const start = markerComment(marker + ':start', 'html');
  const end = markerComment(marker + ':end', 'html');
  if (src.includes(start) && src.includes(end)) {
    const replaced = replaceBetween(src, { start, end, replacement: '\n' + body + '\n' });
    return { text: replaced.text, changed: replaced.changed, reason: replaced.changed ? 'block-updated' : 'block-unchanged' };
  }
  const block = markerBlock(body, marker, 'html');
  const text = src.trim() ? src.replace(/\s+$/, '') + '\n' + block : block;
  return { text, changed: true, reason: 'block-inserted' };
}

/** Drop the fields a metadata write must never carry. */
export function sanitizeFields(fields) {
  const out = {};
  const refused = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (FORBIDDEN_FIELDS.includes(key)) { refused.push(key); continue; }
    out[key] = value;
  }
  return { fields: out, refused };
}

/** capabilities: the JWT is accepted and the site answers. */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const needs = missingKeys(KEYS, env);
  const out = {
    provider: PROVIDER, ready: false, needs, tools: {},
    writes: 'Ghost post/page metadata and code injection (live for published posts)',
    unverified: [...UNVERIFIED], notes: [],
  };
  if (needs.length) { out.notes.push(...explainKeys(KEYS, { env }).lines); return out; }
  const headers = headersFor(ctx);
  if (!headers) {
    out.needs = [...needs, 'GHOST_ADMIN_KEY in <id>:<hex secret> form'];
    out.notes.push('GHOST_ADMIN_KEY is not in the `<id>:<hex secret>` shape the Admin API signs with.');
    return out;
  }
  const site = siteUrl(ctx, options);
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(adminUrl(site, 'site/'), { headers }); }
  catch (e) { out.notes.push('could not reach the Ghost Admin API: ' + String((e && e.message) || e)); return out; }
  if (!res.ok) { out.notes.push('GET /ghost/api/admin/site/ failed: ' + describeFailure(res, env)); return out; }
  out.ready = true;
  out.site = site;
  const siteInfo = res.json && res.json.site ? res.json.site : null;
  if (siteInfo) out.ghost = { title: siteInfo.title, version: siteInfo.version };
  return out;
}

/** Find a post (then a page) by slug. */
export async function findResource(slug, ctx = {}, options = {}, headers = null) {
  const site = siteUrl(ctx, options);
  const auth = headers || headersFor(ctx);
  if (!site || !auth) return { error: 'missing GHOST_URL or GHOST_ADMIN_KEY' };
  const http = httpFor(ctx);
  for (const type of RESOURCES) {
    let res;
    try { res = await http.get(adminUrl(site, type + '/slug/' + encodeURIComponent(slug) + '/'), { headers: auth }); }
    catch (e) { return { error: String((e && e.message) || e) }; }
    if (res.status === 404) continue;
    if (!res.ok) return { error: describeFailure(res, ctx.env || process.env) };
    const list = res.json && Array.isArray(res.json[type]) ? res.json[type] : [];
    if (list.length) return { type, resource: list[0] };
  }
  return { error: 'no post or page with slug "' + slug + '"' };
}

/** plan: one change per post (Ghost writes all metadata fields in one PUT). */
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
  const site = siteUrl(ctx, options);
  const headers = headersFor(ctx);
  if (!headers) return { provider: PROVIDER, ready: false, changes, skipped, notes: ['GHOST_ADMIN_KEY is not in the `<id>:<hex secret>` shape the Admin API signs with'] };

  const answers = normalizeAnswers(options.answers);
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  for (const page of grouped.pages) {
    const answer = answers.resources[page.path] || {};
    const slug = answer.slug || page.slug || slugOf(page.url);
    if (!slug) { skipped.push({ finding: page.finding_ids.join(', '), reason: 'no slug in ' + page.url }); continue; }
    const found = await findResource(slug, ctx, options, headers);
    if (found.error) { skipped.push({ finding: page.finding_ids.join(', '), reason: found.error }); continue; }
    const post = found.resource;

    const fields = {};
    const expect = {};
    for (const [field, entry] of Object.entries(page.fields)) {
      const target = FIELD_MAP[field];
      if (!target) { skipped.push({ finding: entry.finding, reason: '"' + field + '" has no Ghost post field' }); continue; }
      if (target === 'codeinjection_head') {
        const upsert = upsertHeadBlock(post.codeinjection_head, entry.value);
        if (!upsert.changed) { skipped.push({ finding: entry.finding, reason: 'the same block is already in codeinjection_head', status: 'skipped_idempotent' }); continue; }
        fields.codeinjection_head = upsert.text;
        expect.jsonld = entry.value;
      } else {
        fields[target] = entry.value;
        expect[field] = entry.value;
      }
    }
    const safe = sanitizeFields(fields);
    if (!Object.keys(safe.fields).length) continue;

    const url = adminUrl(site, found.type + '/' + encodeURIComponent(post.id) + '/');
    const body = { [found.type]: [{ id: post.id, updated_at: post.updated_at, ...safe.fields }] };
    const published = String(post.status || '').toLowerCase() === 'published';
    const before = {};
    for (const key of Object.keys(safe.fields)) before[key] = post[key] === undefined ? null : post[key];

    const previewBody = renderRequestPreview({
      method: 'PUT', url, headers: { authorization: '', 'accept-version': '', 'content-type': '' },
      body, before,
      notes: [
        published ? 'live_impact: live — this post is published, so the change is public as soon as it is written.'
          : 'live_impact: none — this is a draft; its metadata changes without anything going public. `status` is never sent, so it stays a draft.',
        'updated_at travels with the write: Ghost rejects the update if the post changed in the meantime, and so does this adapter.',
        safe.refused.length ? 'dropped fields that must never be written: ' + safe.refused.join(', ') : null,
        fields.codeinjection_head ? 'the JSON-LD sits between <!-- ' + DEFAULT_MARKER + ':start --> markers, so re-running replaces it instead of adding a second copy.' : null,
      ],
      env,
    });

    const id = changeId({
      adapter: 'page-api', op: 'update-fields',
      target: { kind: 'resource', locator: 'ghost:' + found.type + ':' + post.id, url: page.url },
      finding_ids: page.finding_ids, strategy: 'ghost-post-meta', payload: { fields: safe.fields },
    });
    const built = makeChange({
      id,
      finding_ids: page.finding_ids,
      adapter: 'page-api',
      class: 'proposed',
      target: { kind: 'resource', locator: 'ghost:' + found.type + ':' + post.id, url: page.url },
      op: 'update-fields',
      strategy: 'ghost-post-meta',
      payload: {
        provider: PROVIDER, resource: found.type, post_id: post.id, method: 'PUT', url, body,
        updated_at: post.updated_at, expect, fields: safe.fields, unverified: [],
      },
      preview: { kind: 'payload', body: previewBody, lang: 'json' },
      before: { source: 'GET ' + found.type + '/slug/' + slug + '/', values: { ...before, updated_at: post.updated_at } },
      requires: { credentials: [...KEYS], tools: [] },
      live_impact: published ? 'live' : 'none',
      verify: {
        method: 'dom_assert',
        command: reproduceCommand('adapters/page-api.mjs', ['verify', '--provider', PROVIDER, '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id]),
        assertion: 'the Admin API reports the new metadata and the public page serves it',
        url: page.url,
      },
      rollback: {
        kind: 'restore-fields',
        data: { method: 'PUT', url, body: { [found.type]: [{ id: post.id, updated_at: post.updated_at, ...before }] } },
      },
      status: 'planned',
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) skipped.push({ finding: page.finding_ids.join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  notes.push('slug changes, redirects (redirects.json) and image alt text are editor actions — they are handed to the instructions adapter.');
  return { provider: PROVIDER, ready: true, site, changes, skipped, notes };
}

/** Re-read the post so the write carries a current `updated_at` — and refuse a lost race. */
async function freshUpdatedAt({ change, ctx, headers, body, rollback }) {
  const payload = change.payload || {};
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(payload.url, { headers }); }
  catch (e) { return { error: 'could not re-read the post before writing: ' + String((e && e.message) || e) }; }
  if (!res.ok) return { error: 'could not re-read the post before writing: ' + describeFailure(res, ctx.env || process.env) };
  const list = res.json && Array.isArray(res.json[payload.resource]) ? res.json[payload.resource] : [];
  const post = list[0];
  if (!post) return { error: 'the post no longer exists at ' + payload.url };
  if (!rollback && payload.updated_at && post.updated_at !== payload.updated_at) {
    return {
      error: 'the post changed since this fix was planned (updated_at ' + post.updated_at + ' != ' + payload.updated_at
        + '). Re-run the audit and re-plan rather than overwriting someone else\'s edit.',
    };
  }
  const next = JSON.parse(JSON.stringify(body));
  const items = next[payload.resource];
  if (Array.isArray(items) && items[0]) items[0].updated_at = post.updated_at;
  return { body: next };
}

const ops = makeRemoteOps({
  provider: PROVIDER,
  headers: headersFor,
  beforeApply: freshUpdatedAt,
  async readback({ change, ctx, headers }) {
    const payload = change.payload || {};
    const http = httpFor(ctx);
    const res = await http.get(payload.url, { headers });
    if (!res.ok) return { ok: false, error: describeFailure(res, ctx.env || process.env) };
    const list = res.json && Array.isArray(res.json[payload.resource]) ? res.json[payload.resource] : [];
    const post = list[0] || {};
    const expect = payload.expect && typeof payload.expect === 'object' ? payload.expect : {};
    const values = {};
    for (const [field, target] of Object.entries(FIELD_MAP)) {
      if (expect[field] === undefined) continue;
      if (target === 'codeinjection_head') {
        // The head holds more than our block, so "did it land" is containment, not equality.
        values.jsonld = typeof post.codeinjection_head === 'string' && post.codeinjection_head.includes(String(expect.jsonld || '').trim())
          ? expect.jsonld : (post.codeinjection_head || null);
      } else if (post[target] !== undefined) values[field] = post[target];
    }
    return { ok: true, values };
  },
});

export const preview = ops.preview;
export const apply = ops.apply;
export const verify = ops.verify;
export const rollback = ops.rollback;
