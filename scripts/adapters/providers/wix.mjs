// page-api provider: Wix Item SEO Tags.
//
// Two things make Wix different from every other provider here.
//
//  1. **Tags replace in full.** A partial payload deletes the tags it leaves out, so every write is
//     read → merge → write-the-whole-set, and the captured set *is* the rollback. `mergeTags` keeps
//     tags this tool knows nothing about (a verification meta, a custom link, someone's JSON-LD)
//     exactly where they were.
//  2. **The endpoint is UNVERIFIED in this build.** Rather than guess and fail at apply time, the
//     provider probes it in `capabilities` and, until that probe says the path answers, every change
//     is planned as `skipped_unready` with the payload printed for a human to check.
//
// Item type and item id cannot be derived from a URL — they come from `--answers`
// (`{"resources": {"https://site/page": {"itemType": "STATIC_PAGE", "itemId": "…"}}}`) and nothing
// is invented when they are absent.

import { changeId, makeChange } from '../../lib/adapter.mjs';
import { explainKeys, missingKeys, resolveKey } from '../../lib/credentials.mjs';
import { reproduceCommand } from '../../lib/finding.mjs';
import { readJson } from '../../lib/store.mjs';
import {
  describeFailure, groupByPage, httpFor, makeRemoteOps, normalizeAnswers, renderRequestPreview,
} from '../_shared.mjs';

export const PROVIDER = 'wix';
export const KEYS = Object.freeze(['WIX_API_KEY', 'WIX_SITE_ID']);
export const API_BASE = 'https://www.wixapis.com';
/** Path this build believes the Item SEO Tags API lives at. Probed, never assumed. */
export const TAGS_PATH = '/seo/v1/item-tags';
export const UNVERIFIED = Object.freeze(['Item SEO Tags endpoint path', 'request body shape', 'publish semantics']);
/** Item types whose changes only reach the live site with `publish: true`. */
export const STATIC_ITEM_TYPES = Object.freeze(['STATIC_PAGE', 'STATIC_PAGE_ITEM']);

/** Which tag a field becomes, in the shape Wix stores them. */
export const FIELD_TAGS = Object.freeze({
  title: (value) => ({ type: 'title', children: value }),
  description: (value) => ({ type: 'meta', props: { name: 'description', content: value } }),
  og_title: (value) => ({ type: 'meta', props: { property: 'og:title', content: value } }),
  og_description: (value) => ({ type: 'meta', props: { property: 'og:description', content: value } }),
  og_image: (value) => ({ type: 'meta', props: { property: 'og:image', content: value } }),
  canonical: (value) => ({ type: 'link', props: { rel: 'canonical', href: value } }),
});

export function headersFor(ctx = {}) {
  const env = ctx.env || process.env;
  const key = resolveKey('WIX_API_KEY', env);
  const site = resolveKey('WIX_SITE_ID', env);
  if (!key || !site) return null;
  return { authorization: key, 'wix-site-id': site, accept: 'application/json' };
}

/** Identity of a tag: two tags with the same identity are the same slot, and one replaces the other. */
export function tagKey(tag) {
  if (!tag || typeof tag !== 'object') return '';
  const props = tag.props && typeof tag.props === 'object' ? tag.props : {};
  const name = props.name || props.property || props.rel || props.httpEquiv || '';
  return String(tag.type || '').toLowerCase() + '|' + String(name).toLowerCase();
}

/**
 * Merge new tags into the set Wix currently holds, in place, keeping every tag we did not touch.
 * @returns {{tags: object[], replaced: string[], added: string[]}}
 */
export function mergeTags(existing, updates) {
  const out = (Array.isArray(existing) ? existing : []).map((t) => ({ ...t }));
  const replaced = [];
  const added = [];
  for (const tag of Array.isArray(updates) ? updates : []) {
    const key = tagKey(tag);
    const at = out.findIndex((t) => tagKey(t) === key);
    if (at === -1) { out.push(tag); added.push(key); }
    else { out[at] = { ...out[at], ...tag }; replaced.push(key); }
  }
  return { tags: out, replaced, added };
}

/** Read the current tag set for one item. */
export async function readTags({ itemType, itemId }, ctx = {}, headers = null) {
  const http = httpFor(ctx);
  const auth = headers || headersFor(ctx);
  if (!auth) return { ok: false, tags: [], error: 'missing WIX_API_KEY or WIX_SITE_ID' };
  let res;
  try { res = await http.get(API_BASE + TAGS_PATH, { headers: auth, query: { itemType, itemId } }); }
  catch (e) { return { ok: false, tags: [], error: String((e && e.message) || e) }; }
  if (!res.ok) return { ok: false, tags: [], status: res.status, error: describeFailure(res, ctx.env || process.env) };
  const json = res.json || {};
  const tags = Array.isArray(json.tags) ? json.tags : (json.itemTags && Array.isArray(json.itemTags.tags) ? json.itemTags.tags : []);
  return { ok: true, tags, error: null };
}

/**
 * capabilities: probe the endpoint before believing in it. A 400/422 means "the path exists and
 * wants parameters" — which is exactly the confirmation we need; a 404 means our path is wrong.
 */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const needs = missingKeys(KEYS, env);
  const out = {
    provider: PROVIDER, ready: false, needs, tools: {},
    writes: 'Wix item SEO tags (full-set replace); static pages need publish: true to reach the live site',
    unverified: [...UNVERIFIED], notes: [], endpoint: API_BASE + TAGS_PATH,
  };
  if (needs.length) { out.notes.push(...explainKeys(KEYS, { env }).lines); return out; }
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(API_BASE + TAGS_PATH, { headers: headersFor(ctx), retries: 0 }); }
  catch (e) { out.notes.push('could not probe the endpoint: ' + String((e && e.message) || e)); return out; }
  const status = res.status;
  const exists = res.ok || [400, 422, 428].includes(status);
  out.probe = { path: TAGS_PATH, status, exists };
  if (status === 401 || status === 403) {
    out.notes.push('the API key was rejected (' + status + '): check the key and that it has SEO permissions for this site.');
    return out;
  }
  if (!exists) {
    out.notes.push('the Item SEO Tags path returned ' + status + ': this build\'s path (' + TAGS_PATH + ') is UNVERIFIED and looks wrong. Changes will be planned as skipped_unready with the payload printed, so nothing is written blind.');
    return out;
  }
  out.ready = true;
  out.notes.push('endpoint answers (' + status + '), but its request body and publish semantics are still UNVERIFIED — read the preview before confirming.');
  return out;
}

/** plan: one change per item (a Wix write is always the whole tag set). */
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

  const probe = options.probe !== undefined ? options.probe : await capabilities(ctx, options);
  const endpointConfirmed = !!(probe && probe.ready);
  if (!endpointConfirmed) notes.push('the Item SEO Tags endpoint is not confirmed on this site: changes are planned as skipped_unready so a human can check the payload first.');

  const answers = normalizeAnswers(options.answers);
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  for (const page of grouped.pages) {
    const resource = answers.resources[page.path];
    if (!resource || !resource.itemId || !resource.itemType) {
      skipped.push({
        finding: page.finding_ids.join(', '),
        reason: 'Wix addresses SEO tags by item type + item id, which a URL does not carry. Pass them in --answers: {"resources": {"' + page.url + '": {"itemType": "STATIC_PAGE", "itemId": "<id>"}}}',
      });
      continue;
    }
    const itemType = String(resource.itemType);
    const itemId = String(resource.itemId);

    const updates = [];
    const expect = {};
    for (const [field, entry] of Object.entries(page.fields)) {
      const build = FIELD_TAGS[field];
      if (!build) { skipped.push({ finding: entry.finding, reason: '"' + field + '" has no Item SEO Tags slot — use Settings -> Custom code (instructions adapter)' }); continue; }
      updates.push(build(entry.value));
      expect[field] = entry.value;
    }
    if (!updates.length) continue;

    const current = endpointConfirmed ? await readTags({ itemType, itemId }, ctx) : { ok: false, tags: [], error: 'endpoint not confirmed' };
    if (endpointConfirmed && !current.ok) {
      skipped.push({ finding: page.finding_ids.join(', '), reason: 'could not read the current tags (a full-set write without them would delete tags): ' + current.error });
      continue;
    }
    const merged = mergeTags(current.tags, updates);
    const isStatic = STATIC_ITEM_TYPES.includes(itemType.toUpperCase());
    const body = { itemType, itemId, tags: merged.tags, publish: isStatic ? true : undefined };
    if (body.publish === undefined) delete body.publish;
    const url = API_BASE + TAGS_PATH;

    const previewBody = renderRequestPreview({
      method: 'PUT', url, headers: { authorization: '', 'wix-site-id': '', 'content-type': '' },
      body, before: { tags: current.tags },
      notes: [
        'Wix replaces the tag set in full. ' + merged.replaced.length + ' tag(s) replaced, ' + merged.added.length + ' added, '
          + Math.max(0, (current.tags || []).length - merged.replaced.length) + ' left exactly as they were.',
        isStatic ? 'publish: true — a static page needs it, and it makes this change LIVE on save.' : 'a dynamic item applies immediately: LIVE on save.',
        'UNVERIFIED: ' + UNVERIFIED.join(', ') + '. Read the body above before confirming.',
        endpointConfirmed ? null : 'the endpoint probe did not confirm this path, so this change is parked as skipped_unready.',
      ],
      env,
    });

    const id = changeId({
      adapter: 'page-api', op: 'update-fields',
      target: { kind: 'resource', locator: 'wix:' + itemType + ':' + itemId, url: page.url },
      finding_ids: page.finding_ids, strategy: 'wix-item-seo-tags', payload: { fields: expect },
    });
    const built = makeChange({
      id,
      finding_ids: page.finding_ids,
      adapter: 'page-api',
      class: 'proposed',
      target: { kind: 'resource', locator: 'wix:' + itemType + ':' + itemId, url: page.url },
      op: 'update-fields',
      strategy: 'wix-item-seo-tags',
      payload: {
        provider: PROVIDER, item_type: itemType, item_id: itemId, method: 'PUT', url, body,
        expect, unverified: [...UNVERIFIED], publish: !!isStatic,
      },
      preview: { kind: 'payload', body: previewBody, lang: 'json' },
      before: { source: 'GET ' + TAGS_PATH + '?itemType=' + itemType + '&itemId=' + itemId, values: { tags: current.tags } },
      requires: { credentials: [...KEYS], tools: [] },
      live_impact: 'live',
      verify: {
        method: 'dom_assert',
        command: reproduceCommand('adapters/page-api.mjs', ['verify', '--provider', PROVIDER, '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id]),
        assertion: 'the item tags read back with the new values and the public page serves them',
        url: page.url,
      },
      rollback: current.ok
        ? { kind: 'restore-fields', data: { method: 'PUT', url, body: { itemType, itemId, tags: current.tags, ...(isStatic ? { publish: true } : {}) } } }
        : { kind: 'none' },
      status: endpointConfirmed ? 'planned' : 'skipped_unready',
      error: endpointConfirmed ? undefined : 'the Wix Item SEO Tags endpoint is UNVERIFIED and did not answer the capability probe',
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) skipped.push({ finding: page.finding_ids.join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  return { provider: PROVIDER, ready: endpointConfirmed, changes, skipped, notes };
}

const ops = makeRemoteOps({
  provider: PROVIDER,
  headers: headersFor,
  async readback({ change, ctx, headers }) {
    const payload = change.payload || {};
    const current = await readTags({ itemType: payload.item_type, itemId: payload.item_id }, ctx, headers);
    if (!current.ok) return { ok: false, error: current.error };
    const values = {};
    for (const [field, build] of Object.entries(FIELD_TAGS)) {
      const wanted = tagKey(build(''));
      const found = current.tags.find((t) => tagKey(t) === wanted);
      if (!found) continue;
      values[field] = found.type === 'title' ? found.children : ((found.props && (found.props.content || found.props.href)) || null);
    }
    return { ok: true, values };
  },
});

export const preview = ops.preview;
export const apply = ops.apply;
export const verify = ops.verify;
export const rollback = ops.rollback;
