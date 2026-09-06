#!/usr/bin/env node
// wordpress-rest — write SEO fields to WordPress over the REST API with an application password.
//
//   node scripts/adapters/wordpress-rest.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>] [--json]
//   plan: --report <report.json> [--profile <profile.json>] [--category …] [--include-proposed]
//         [--answers <json|path>] [--wp-url <https://site>] [--plugin yoast|rankmath|aioseo|seopress]
//   ops: capabilities | plan | preview | apply | verify | rollback
//
// Three rules shape everything in this file:
//
//  1. **HTTPS only.** Application passwords travel in a Basic-auth header. Over http they are sent
//     in clear to anyone on the path, so an http:// site is refused — not warned about, refused.
//  2. **`status` and `content` are never sent.** A REST write that carries either can publish a
//     draft or overwrite a post body. `sanitizeBody` strips them and says so; `apply` refuses a
//     payload that still contains one.
//  3. **The SEO plugin decides the route.** AIOSEO and SEOPress accept a write; Yoast and Rank Math
//     keep their meta out of REST, so those changes are planned as `skipped_unready` carrying the
//     `register_post_meta(… show_in_rest …)` mu-plugin shim *and* the equivalent WP-CLI command —
//     an honest "here is how to unlock it", never a silent failure.
//
// Values come from the report (`fix_preview`) or from `--answers`. This adapter never writes a
// title or description it made up.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  canTransition, changeId, ensureConfirmed, loadFixRun, makeChange, openFixRun,
  requireTicket, resolveDataDir, transition, updateManifest,
} from '../lib/adapter.mjs';
import { basicAuth } from '../lib/http.mjs';
import { explainKeys, missingKeys, redactObject, resolveKey } from '../lib/credentials.mjs';
import { reproduceCommand } from '../lib/finding.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';
import {
  checkPublicUrl, describeFailure, fieldsMatch, groupByPage, httpFor, logOpEvent, normalizeAnswers, opThrew,
  pathOf, publicUrlFor, renderRequestPreview, slugOf,
} from './_shared.mjs';

export const ADAPTER = 'wordpress-rest';
/** Credential keys this adapter needs (names only — values never leave the environment). */
export const KEYS = Object.freeze(['WP_URL', 'WP_USER', 'WP_APP_PASSWORD']);
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback'];

/** REST namespace -> SEO plugin id (the reliable signal; HTML sniffing finds comments, not plugins). */
export const SEO_NAMESPACES = Object.freeze({
  'yoast/v1': 'yoast',
  'rankmath/v1': 'rankmath',
  'aioseo/v1': 'aioseo',
  'seopress/v1': 'seopress',
});

/** Plugins whose SEO meta is not writable over REST without a `show_in_rest` shim. */
export const SHIM_PLUGINS = Object.freeze(['yoast', 'rankmath']);

/** Post meta keys the shim (and WP-CLI) use, per plugin. */
export const META_KEYS = Object.freeze({
  yoast: Object.freeze({ title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc' }),
  rankmath: Object.freeze({ title: 'rank_math_title', description: 'rank_math_description' }),
});

/** Fields that must never be part of a REST body built here. */
export const FORBIDDEN_FIELDS = Object.freeze(['status', 'content', 'password', 'author', 'date', 'date_gmt', 'sticky']);

/** Post types this adapter addresses, in the order a slug lookup tries them. */
export const POST_TYPES = Object.freeze(['posts', 'pages']);

// ---------------------------------------------------------------------------
// Site + auth

/** The site URL, from --wp-url (non-secret) or the WP_URL credential key. */
export function siteFor(ctx = {}, options = {}) {
  const raw = options.wpUrl || ctx.site || resolveKey('WP_URL', ctx.env || process.env);
  if (!raw) return null;
  return String(raw).trim().replace(/\/+$/, '');
}

/**
 * Refuse anything but https. Basic auth over http leaks the application password.
 * @returns {{ok: boolean, reason: string|null, url: string|null}}
 */
export function requireHttps(site) {
  const raw = String(site || '').trim();
  if (!raw) return { ok: false, reason: 'no WordPress site URL: set WP_URL (https://…)', url: null };
  let parsed;
  try { parsed = new URL(raw); }
  catch { return { ok: false, reason: 'WP_URL is not a URL: ' + raw, url: null }; }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      url: parsed.origin,
      reason: 'refusing ' + parsed.protocol + '// — an application password sent over plain HTTP is readable by anyone on the network path. Use https, or fix the site over SSH with the wordpress-wpcli adapter.',
    };
  }
  return { ok: true, reason: null, url: raw.replace(/\/+$/, '') };
}

/** `<site>/wp-json/<path>` with exactly one slash between the parts. */
export function restUrl(site, path) {
  const base = String(site || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return base + '/wp-json/' + p;
}

/** Basic-auth header from the environment. Returns null when either half is missing. */
export function authHeaders(ctx = {}) {
  const env = ctx.env || process.env;
  const user = resolveKey('WP_USER', env);
  const password = resolveKey('WP_APP_PASSWORD', env);
  if (!user || !password) return null;
  return { authorization: basicAuth(user, password) };
}

// ---------------------------------------------------------------------------
// Plugin detection

/** SEO plugin ids implied by a REST namespace list. */
export function pluginsFromNamespaces(namespaces) {
  const out = [];
  for (const ns of Array.isArray(namespaces) ? namespaces : []) {
    const id = SEO_NAMESPACES[String(ns)];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Which plugin owns the head, from (in order) an explicit override, the REST namespaces, and the
 * platform profile's `cms_plugins`. Returns null when nothing says — and null is reported, not
 * papered over with a guess.
 */
export function detectPlugin({ plugin = null, namespaces = null, profile = null } = {}) {
  if (plugin && SEO_NAMESPACES[plugin + '/v1'] !== undefined) return { id: plugin, source: 'override' };
  if (plugin && Object.values(SEO_NAMESPACES).includes(plugin)) return { id: plugin, source: 'override' };
  const fromNs = pluginsFromNamespaces(namespaces);
  if (fromNs.length) return { id: fromNs[0], source: 'rest-namespaces', all: fromNs };
  const ids = (profile && Array.isArray(profile.cms_plugins) ? profile.cms_plugins : [])
    .map((p) => (p && p.id ? String(p.id) : null))
    .filter((id) => id && Object.values(SEO_NAMESPACES).includes(id));
  if (ids.length) return { id: ids[0], source: 'profile', all: ids };
  return null;
}

// ---------------------------------------------------------------------------
// Payload safety

/**
 * Drop every field a fix must never send. Returns the safe body plus the names that were removed,
 * so a preview can say "these were dropped" instead of quietly shipping them.
 * @returns {{body: object, refused: string[]}}
 */
export function sanitizeBody(body) {
  const out = {};
  const refused = [];
  for (const [key, value] of Object.entries(body && typeof body === 'object' ? body : {})) {
    if (FORBIDDEN_FIELDS.includes(key)) { refused.push(key); continue; }
    out[key] = value;
  }
  return { body: out, refused };
}

// ---------------------------------------------------------------------------
// Resource resolution (which post/page/media id a finding is about)

const WP_RESOURCE_RE = /\/wp-json\/wp\/v2\/(posts|pages|media)\/(\d+)/i;

/** Post id from a snapshot's `<link rel="alternate" type="application/json" href="…/wp/v2/posts/12">`. */
export function resourceFromSnapshot(snapshot) {
  const parsed = snapshot && snapshot.parsed;
  const links = parsed && Array.isArray(parsed.links_rel) ? parsed.links_rel : [];
  for (const link of links) {
    const href = String((link && (link.abs || link.href)) || '');
    const m = WP_RESOURCE_RE.exec(href);
    if (m) return { type: m[1].toLowerCase(), id: Number(m[2]), source: 'snapshot-alternate-link' };
  }
  return null;
}

/** Load `<run_dir>/pages/*.json` snapshots from a report, indexed by URL path. */
export function loadSnapshots(report) {
  const out = new Map();
  const runDir = report && typeof report.run_dir === 'string' ? report.run_dir : null;
  if (!runDir) return out;
  let names = [];
  try { names = readdirSync(join(runDir, 'pages')); }
  catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const snap = readJson(join(runDir, 'pages', name), null);
    const url = snap && snap.target && (snap.target.final_url || snap.target.value);
    if (url) out.set(pathOf(url), snap);
  }
  return out;
}

/**
 * Find the WordPress resource behind a page URL: an answer the user gave, then the snapshot's
 * REST alternate link, then a `?slug=` lookup over REST. Never a guessed id.
 * @returns {Promise<{type, id, source}|{error: string}>}
 */
export async function resolveResource(page, ctx = {}, { resources = {}, snapshots = null, site = null, headers = null } = {}) {
  const answer = resources[page.path];
  if (answer && Number.isFinite(Number(answer.id))) {
    return { type: String(answer.type || 'posts'), id: Number(answer.id), source: 'answers' };
  }
  const snap = snapshots && typeof snapshots.get === 'function' ? snapshots.get(page.path) : null;
  const fromSnap = snap ? resourceFromSnapshot(snap) : null;
  if (fromSnap) return fromSnap;

  if (!site || !headers) return { error: 'no post id: pass it in --answers as {"resources":{"' + page.url + '":{"type":"posts","id":123}}}, or run the audit with a snapshot so the REST alternate link is available' };
  const slug = page.slug || slugOf(page.url);
  if (!slug) return { error: 'no slug in ' + page.url + ' to look the post up by' };
  const http = httpFor(ctx);
  for (const type of POST_TYPES) {
    let res;
    try { res = await http.get(restUrl(site, 'wp/v2/' + type), { headers, query: { slug, context: 'edit', _fields: 'id,slug,link,type' } }); }
    catch (e) { return { error: 'slug lookup failed: ' + String((e && e.message) || e) }; }
    if (!res.ok) continue;
    const list = Array.isArray(res.json) ? res.json : [];
    if (list.length === 1) return { type, id: Number(list[0].id), source: 'rest-slug-lookup' };
    if (list.length > 1) return { error: 'slug "' + slug + '" matches ' + list.length + ' ' + type + ' — name the id in --answers' };
  }
  return { error: 'no ' + POST_TYPES.join('/') + ' found for slug "' + slug + '"' };
}

const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const UPLOAD_PATH_RE = /(?:https?:\/\/[^\s"'<>]+)?\/wp-content\/uploads\/[^\s"'<>)]+/i;

/** The image a media finding is about, taken from what the finding itself says. */
export function imageRefFor(finding) {
  if (!finding) return null;
  const preview = typeof finding.fix_preview === 'string' ? finding.fix_preview : '';
  const img = IMG_SRC_RE.exec(preview);
  if (img) return img[1] || img[2] || img[3];
  for (const text of [
    finding.location && finding.location.selector,
    finding.evidence && finding.evidence.observed,
    finding.evidence && finding.evidence.snippet,
  ]) {
    if (typeof text !== 'string') continue;
    const upload = UPLOAD_PATH_RE.exec(text);
    if (upload) return upload[0];
    const inner = IMG_SRC_RE.exec(text);
    if (inner) return inner[1] || inner[2] || inner[3];
  }
  return null;
}

/** The media slug WordPress would have given a file: basename, no extension, no -1024x768 suffix. */
export function mediaSlugFor(imageUrl) {
  const raw = String(imageUrl || '').split(/[?#]/)[0];
  const base = raw.split('/').filter(Boolean).pop() || '';
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/-\d{2,5}x\d{2,5}$/i, '');
}

/**
 * The attachment id behind an image: an answer first, then a `?search=` lookup matched on the
 * file name. An ambiguous match is an error, never a coin flip — writing alt text onto the wrong
 * attachment changes a different page.
 */
export async function resolveMediaId(page, entry, ctx = {}, { resources = {}, site = null, headers = null } = {}) {
  const answer = resources[page.path];
  const given = answer && (answer.media_id || (String(answer.type) === 'media' ? answer.id : null));
  if (Number.isFinite(Number(given))) return { id: Number(given), source: 'answers' };

  const finding = (page.findings || []).find((f) => f && f.id === entry.finding) || null;
  const ref = imageRefFor(finding);
  const help = 'pass it in --answers as {"resources":{"' + page.url + '":{"media_id":123}}}';
  if (!ref) return { error: 'alt text needs the attachment id and the finding does not name the image file — ' + help };
  if (!site || !headers) return { error: 'alt text needs an attachment lookup, which needs credentials — ' + help };

  const slug = mediaSlugFor(ref);
  if (!slug) return { error: 'could not read a file name out of "' + ref + '" — ' + help };
  const http = httpFor(ctx);
  let res;
  try { res = await http.get(restUrl(site, 'wp/v2/media'), { headers, query: { search: slug, context: 'edit', per_page: 20, _fields: 'id,source_url,slug' } }); }
  catch (e) { return { error: 'attachment lookup failed: ' + String((e && e.message) || e) }; }
  if (!res.ok) return { error: 'attachment lookup failed: ' + describeFailure(res, ctx.env || process.env) };
  const list = Array.isArray(res.json) ? res.json : [];
  const wanted = mediaSlugFor(ref);
  const matches = list.filter((m) => m && (mediaSlugFor(m.source_url) === wanted || String(m.slug || '') === wanted));
  if (matches.length === 1) return { id: Number(matches[0].id), source: 'rest-media-search' };
  if (matches.length > 1) return { error: 'the file name "' + wanted + '" matches ' + matches.length + ' attachments — ' + help };
  return { error: 'no attachment matches "' + wanted + '" — ' + help };
}

// ---------------------------------------------------------------------------
// Route planning per plugin

/** The shim a site owner installs (as an mu-plugin) to make Yoast / Rank Math meta REST-writable. */
export function shimSnippet(plugin, postType = 'post') {
  const keys = META_KEYS[plugin];
  if (!keys) return '';
  const lines = [
    '<?php',
    '// wp-content/mu-plugins/claude-seo-ai-rest-meta.php',
    '// Exposes the ' + plugin + ' SEO meta keys to the REST API so an authenticated editor can write them.',
    '// Installing this is a site-owner decision: it widens what the REST API can change.',
    'add_action( \'init\', function () {',
    '  $keys = array(',
  ];
  for (const key of Object.values(keys)) lines.push('    \'' + key + '\',');
  lines.push('  );');
  lines.push('  foreach ( $keys as $key ) {');
  lines.push('    register_post_meta( \'' + postType + '\', $key, array(');
  lines.push('      \'show_in_rest\'  => true,');
  lines.push('      \'single\'        => true,');
  lines.push('      \'type\'          => \'string\',');
  lines.push('      \'auth_callback\' => function () { return current_user_can( \'edit_posts\' ); },');
  lines.push('    ) );');
  lines.push('  }');
  lines.push('} );');
  return lines.join('\n');
}

/** The WP-CLI command that writes the same value without any shim. */
export function wpCliEquivalent(plugin, id, field, value) {
  const keys = META_KEYS[plugin];
  const key = keys ? keys[field] : null;
  if (!key) return null;
  return 'node scripts/adapters/wordpress-wpcli.mjs plan --report <report.json> --target wordpress-wpcli'
    + '   # runs: wp post meta update ' + id + ' ' + key + ' ' + JSON.stringify(value);
}

/**
 * The REST route for one field on one resource.
 * @returns {{route: 'aioseo'|'seopress'|'core'|'media'|'shim-required'|'unsupported', method, path, body, note}}
 */
export function routeForField({ plugin, type, id, field, value }) {
  if (type === 'media' || field === 'alt') {
    return { route: 'media', method: 'POST', path: 'wp/v2/media/' + id, body: { alt_text: value }, note: null };
  }
  if (field === 'excerpt' || field === 'slug') {
    return { route: 'core', method: 'POST', path: 'wp/v2/' + type + '/' + id, body: { [field]: value }, note: null };
  }
  if (field !== 'title' && field !== 'description') {
    return {
      route: 'unsupported', method: null, path: null, body: null,
      note: 'the WordPress REST API has no field for "' + field + '" — this one is a plugin UI or theme edit (instructions adapter)',
    };
  }
  if (plugin === 'aioseo') {
    return {
      route: 'aioseo', method: 'POST', path: 'wp/v2/' + type + '/' + id,
      body: { aioseo_meta_data: { [field]: value } }, note: null,
    };
  }
  if (plugin === 'seopress') {
    return {
      route: 'seopress', method: 'PUT', path: 'seopress/v1/posts/' + id + '/title-description-metas',
      body: { [field]: value },
      note: 'SEOPress endpoint availability on the free tier is UNVERIFIED — capabilities probes it before apply',
    };
  }
  if (SHIM_PLUGINS.includes(plugin)) {
    return {
      route: 'shim-required', method: null, path: null, body: null,
      note: plugin + ' keeps its SEO meta out of REST: install the register_post_meta shim, or write it with WP-CLI',
    };
  }
  return {
    route: 'unsupported', method: null, path: null, body: null,
    note: 'no SEO plugin was detected, and WordPress core has no separate SEO ' + field
      + ' field — writing the post ' + field + ' would change the page itself, so this is left to you',
  };
}

// ---------------------------------------------------------------------------
// Adapter ops

/** capabilities: the REST index (namespaces -> plugin, application-passwords) plus an auth check. */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const site = siteFor(ctx, options);
  const needs = missingKeys(KEYS, env);
  const out = {
    adapter: ADAPTER, ready: false, needs, tools: {},
    writes: 'live post/page/media fields over the WordPress REST API (never status or content)',
    notes: [],
  };
  const https = requireHttps(site);
  if (!https.ok) {
    out.notes.push(https.reason);
    if (!needs.includes('WP_URL')) out.needs = [...needs, 'WP_URL (https)'];
    return out;
  }
  out.site = https.url;
  if (needs.length) {
    out.notes.push(...explainKeys(KEYS, { env }).lines);
    return out;
  }
  const headers = authHeaders(ctx);
  const http = httpFor(ctx);
  let index;
  try { index = await http.get(restUrl(https.url, ''), { headers }); }
  catch (e) { out.notes.push('could not read /wp-json/: ' + String((e && e.message) || e)); return out; }
  if (!index.ok || !index.json) {
    out.notes.push('GET /wp-json/ failed: ' + describeFailure(index, env));
    return out;
  }
  const namespaces = Array.isArray(index.json.namespaces) ? index.json.namespaces.map(String) : [];
  const plugins = pluginsFromNamespaces(namespaces);
  const appPasswords = !!(index.json.authentication && index.json.authentication['application-passwords']);
  out.namespaces = namespaces;
  out.seo_plugins = plugins;
  out.application_passwords = appPasswords;
  if (!appPasswords) out.notes.push('the REST index does not advertise application-passwords: this host may have them disabled (that is a needs_api, not a retry)');

  let me;
  try { me = await http.get(restUrl(https.url, 'wp/v2/users/me'), { headers, query: { context: 'edit' } }); }
  catch (e) { out.notes.push('could not read users/me: ' + String((e && e.message) || e)); return out; }
  if (!me.ok) {
    out.notes.push('authentication failed on /wp/v2/users/me?context=edit: ' + describeFailure(me, env));
    return out;
  }
  out.user = me.json ? { id: me.json.id, slug: me.json.slug, capabilities: me.json.capabilities ? Object.keys(me.json.capabilities).filter((c) => /^(edit_posts|edit_others_posts|upload_files|manage_options)$/.test(c)) : [] } : null;
  const canEdit = !out.user || !out.user.capabilities.length || out.user.capabilities.includes('edit_posts');
  out.ready = !!canEdit;
  if (!canEdit) out.notes.push('the authenticated user cannot edit posts — use an account with the editor role');
  if (plugins.some((p) => SHIM_PLUGINS.includes(p))) {
    out.notes.push(plugins.filter((p) => SHIM_PLUGINS.includes(p)).join('/') + ' detected: SEO title/description are not REST-writable without the register_post_meta shim (the plan carries it, and the WP-CLI equivalent)');
  }
  return out;
}

/**
 * plan: one change per (resource, field).
 * @param {object} options { report, profile, answers, category, includeProposed, plugin, namespaces, snapshots, wpUrl }
 * @param {object} ctx     { run, dataDir, env, fetchImpl }
 */
export async function plan(options = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);

  const site = siteFor(ctx, options);
  const https = requireHttps(site);
  const notes = [];
  const skipped = [];
  if (!https.ok) return { adapter: ADAPTER, ready: false, changes: [], skipped, notes: [https.reason] };

  const missing = missingKeys(KEYS, env);
  const headers = missing.length ? null : authHeaders(ctx);
  if (missing.length) notes.push('planning without credentials: before-values and slug lookups are skipped (' + missing.join(', ') + ' not set)');

  const answers = normalizeAnswers(options.answers);
  const plugin = detectPlugin({ plugin: options.plugin, namespaces: options.namespaces, profile });
  if (!plugin) notes.push('no SEO plugin detected: only excerpt, slug and image alt are writable over core REST');
  else notes.push('SEO plugin: ' + plugin.id + ' (from ' + plugin.source + ')');

  const snapshots = options.snapshots instanceof Map ? options.snapshots
    : (options.snapshots ? new Map(Object.entries(options.snapshots).map(([k, v]) => [pathOf(k), v])) : loadSnapshots(report));

  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  const changes = [];
  const http = httpFor(ctx);
  // `before` per resource, read once: the edit context is the only view that shows plugin meta.
  const beforeCache = new Map();
  const readBefore = async (type, id) => {
    const key = type + '/' + id;
    if (beforeCache.has(key)) return beforeCache.get(key);
    let value = null;
    if (headers) {
      try {
        const res = await http.get(restUrl(https.url, 'wp/v2/' + key), { headers, query: { context: 'edit' } });
        if (res.ok && res.json) value = res.json;
        else notes.push('could not read the current values of ' + key + ': ' + describeFailure(res, env));
      } catch (e) { notes.push('could not read ' + key + ': ' + String((e && e.message) || e)); }
    }
    beforeCache.set(key, value);
    return value;
  };

  for (const page of grouped.pages) {
    let pageResource = null;
    const resolvePage = async () => {
      if (!pageResource) pageResource = await resolveResource(page, ctx, { resources: answers.resources, snapshots, site: https.url, headers });
      return pageResource;
    };

    // SEOPress writes title and description through one endpoint: sending them separately risks
    // the omitted half being stored as empty, so they travel together.
    const seopress = {};
    for (const [field, entry] of Object.entries(page.fields)) {
      if (plugin && plugin.id === 'seopress' && (field === 'title' || field === 'description')) { seopress[field] = entry; continue; }
      // Alt text lives on the attachment, not on the post that shows it.
      let resource;
      if (field === 'alt') {
        const media = await resolveMediaId(page, entry, ctx, { resources: answers.resources, site: https.url, headers });
        if (media.error) { skipped.push({ finding: entry.finding, reason: media.error }); continue; }
        resource = { type: 'media', id: media.id, source: media.source };
      } else {
        const resolved = await resolvePage();
        if (resolved.error) { skipped.push({ finding: entry.finding, reason: resolved.error }); continue; }
        resource = resolved;
      }
      const route = routeForField({ plugin: plugin ? plugin.id : null, type: resource.type, id: resource.id, field, value: entry.value });
      if (route.route === 'unsupported') {
        skipped.push({ finding: entry.finding, reason: route.note });
        continue;
      }
      const before = await readBefore(resource.type, resource.id);
      const built = buildChange({
        site: https.url, page, field, entry, resource, route, plugin, before, ctx,
      });
      if (built.errors && built.errors.length) { skipped.push({ finding: entry.finding, reason: 'invalid change: ' + built.errors.join('; ') }); continue; }
      changes.push(built.change);
    }

    if (Object.keys(seopress).length) {
      const resolved = await resolvePage();
      if (resolved.error) {
        for (const entry of Object.values(seopress)) skipped.push({ finding: entry.finding, reason: resolved.error });
      } else {
        const before = await readBefore(resolved.type, resolved.id);
        const built = buildSeopressChange({ site: https.url, page, fields: seopress, resource: resolved, before, ctx });
        if (built.errors && built.errors.length) skipped.push({ finding: Object.values(seopress).map((e) => e.finding).join(', '), reason: 'invalid change: ' + built.errors.join('; ') });
        else changes.push(built.change);
      }
    }
  }

  return { adapter: ADAPTER, ready: !missing.length, site: https.url, plugin: plugin ? plugin.id : null, changes, skipped, notes };
}

/** Build one Change (a writable REST call, or the shim/WP-CLI hand-off for Yoast / Rank Math). */
function buildChange({ site, page, field, entry, resource, route, plugin, before, ctx }) {
  const env = (ctx && ctx.env) || process.env;
  const run = ctx && ctx.run;
  const locator = 'wp/v2/' + resource.type + '/' + resource.id + '#' + field;
  const beforeValue = beforeFor({ before, field, route, plugin });

  if (route.route === 'shim-required') {
    const shim = shimSnippet(plugin.id, resource.type === 'pages' ? 'page' : 'post');
    const cli = wpCliEquivalent(plugin.id, resource.id, field, entry.value);
    const body = [
      plugin.id + ' does not expose its SEO ' + field + ' over the REST API, so this change cannot be applied here.',
      '',
      'Two ways forward — both are yours to choose, neither is done for you:',
      '',
      '1. Write it over SSH with WP-CLI (nothing to install):',
      '   ' + (cli || '(no meta key known for ' + field + ')'),
      '',
      '2. Or expose the meta to REST by installing this mu-plugin, then re-plan:',
      '',
      shim,
      '',
      'Value the audit wants for ' + field + ': ' + JSON.stringify(entry.value),
      'Current value: ' + (beforeValue === null || beforeValue === undefined ? '(unknown — not readable over REST)' : JSON.stringify(beforeValue)),
    ].join('\n');
    const id = changeId({
      adapter: ADAPTER, op: 'update-fields', target: { kind: 'resource', locator, url: page.url },
      finding_ids: [entry.finding], strategy: 'meta-shim-required', payload: { field, plugin: plugin.id },
    });
    return makeChange({
      id,
      finding_ids: [entry.finding],
      adapter: ADAPTER,
      class: 'proposed',
      target: { kind: 'resource', locator, url: page.url },
      op: 'update-fields',
      strategy: 'meta-shim-required',
      payload: { field, plugin: plugin.id, value: entry.value, meta_key: (META_KEYS[plugin.id] || {})[field] || null, resource, unverified: [] },
      preview: { kind: 'text', body },
      requires: { credentials: [...KEYS], tools: [] },
      live_impact: 'none',
      verify: { method: 'manual_review', command: reproduceCommand('adapters/wordpress-rest.mjs', ['capabilities']), assertion: 'the shim is installed (or the WP-CLI command was run) and a re-plan produces a writable change', url: page.url },
      rollback: { kind: 'none' },
      status: 'skipped_unready',
      error: plugin.id + ' SEO meta is not exposed to the REST API on this site',
    }, { mode: 'return', phase: 'preview' });
  }

  const sanitized = sanitizeBody(route.body);
  const url = restUrl(site, route.path);
  const notes = [];
  if (route.note) notes.push('note: ' + route.note);
  if (sanitized.refused.length) notes.push('dropped fields that must never be written: ' + sanitized.refused.join(', '));
  notes.push('this is a LIVE write: WordPress has no staging surface for REST edits.');
  const preview = renderRequestPreview({
    method: route.method, url, headers: { authorization: '', accept: '', 'content-type': '' },
    body: sanitized.body,
    before: beforeValue === undefined ? null : { [field]: beforeValue },
    notes, env,
  });

  const payload = {
    field, plugin: plugin ? plugin.id : null, route: route.route,
    method: route.method, path: route.path, url, body: sanitized.body,
    resource, unverified: route.route === 'seopress' ? ['seopress /title-description-metas on the free tier'] : [],
  };
  const id = changeId({
    adapter: ADAPTER, op: 'update-fields', target: { kind: 'resource', locator, url: page.url },
    finding_ids: [entry.finding], strategy: route.route, payload: { field, body: sanitized.body },
  });
  const rollbackBody = rollbackBodyFor({ route, field, beforeValue });
  const built = makeChange({
    id,
    finding_ids: [entry.finding],
    adapter: ADAPTER,
    class: 'proposed',
    target: { kind: 'resource', locator, url: page.url },
    op: 'update-fields',
    strategy: route.route,
    payload,
    preview: { kind: 'payload', body: preview, lang: 'json' },
    before: { field, value: beforeValue === undefined ? null : beforeValue, known: beforeValue !== undefined, source: 'GET ' + url.replace(/\?.*$/, '') + '?context=edit' },
    requires: { credentials: [...KEYS], tools: [] },
    live_impact: 'live',
    verify: {
      method: 'dom_assert',
      command: reproduceCommand('adapters/wordpress-rest.mjs', ['verify', '--run', run ? run.dir : '<run>', '--change', id]),
      assertion: 'the REST resource reports ' + field + ' = the new value, and the public page serves it',
      url: page.url,
    },
    rollback: rollbackBody
      ? { kind: 'restore-fields', data: { method: route.method, path: route.path, url, body: rollbackBody } }
      : { kind: 'none' },
    status: 'planned',
  }, { mode: 'return', phase: 'preview' });
  return built;
}

/**
 * One SEOPress write carrying both title and description. The half that is not being changed is
 * sent with the value the API currently reports, so a partial payload cannot blank it.
 */
function buildSeopressChange({ site, page, fields, resource, before, ctx }) {
  const env = (ctx && ctx.env) || process.env;
  const run = ctx && ctx.run;
  const path = 'seopress/v1/posts/' + resource.id + '/title-description-metas';
  const url = restUrl(site, path);
  const body = {};
  const beforeValues = {};
  const finding_ids = [];
  for (const key of ['title', 'description']) {
    const current = beforeFor({ before, field: key, route: { route: 'seopress' }, plugin: null });
    if (current !== undefined) beforeValues[key] = current;
    if (fields[key]) { body[key] = fields[key].value; finding_ids.push(fields[key].finding); }
    else if (current !== undefined && current !== null && current !== '') body[key] = current;
  }
  const locator = 'seopress/v1/posts/' + resource.id;
  const preview = renderRequestPreview({
    method: 'PUT', url, headers: { authorization: '', accept: '', 'content-type': '' },
    body, before: Object.keys(beforeValues).length ? beforeValues : null,
    notes: [
      'title and description are written together: this endpoint takes both, and sending one alone can store the other as empty.',
      Object.keys(body).length === 2 && !fields.title ? 'the title in the body is the value SEOPress already has, resent unchanged.' : null,
      Object.keys(body).length === 2 && !fields.description ? 'the description in the body is the value SEOPress already has, resent unchanged.' : null,
      'UNVERIFIED: SEOPress /title-description-metas on the free tier.',
      'this is a LIVE write.',
    ],
    env,
  });
  const id = changeId({
    adapter: ADAPTER, op: 'update-fields', target: { kind: 'resource', locator, url: page.url },
    finding_ids, strategy: 'seopress', payload: { body },
  });
  return makeChange({
    id,
    finding_ids,
    adapter: ADAPTER,
    class: 'proposed',
    target: { kind: 'resource', locator, url: page.url },
    op: 'update-fields',
    strategy: 'seopress',
    payload: {
      field: fields.description ? 'description' : 'title', plugin: 'seopress', route: 'seopress',
      method: 'PUT', path, url, body, resource,
      unverified: ['seopress /title-description-metas on the free tier'],
    },
    preview: { kind: 'payload', body: preview, lang: 'json' },
    before: { field: 'title+description', value: Object.keys(beforeValues).length ? beforeValues : null, known: Object.keys(beforeValues).length > 0, source: 'GET ' + restUrl(site, 'wp/v2/' + resource.type + '/' + resource.id) + '?context=edit' },
    requires: { credentials: [...KEYS], tools: [] },
    live_impact: 'live',
    verify: {
      method: 'dom_assert',
      command: reproduceCommand('adapters/wordpress-rest.mjs', ['verify', '--run', run ? run.dir : '<run>', '--change', id]),
      assertion: 'SEOPress reports the new title and description, and the public page serves them',
      url: page.url,
    },
    rollback: Object.keys(beforeValues).length
      ? { kind: 'restore-fields', data: { method: 'PUT', path, url, body: beforeValues } }
      : { kind: 'none' },
    status: 'planned',
  }, { mode: 'return', phase: 'preview' });
}

/** The current value of `field` on the resource, as the route reads it (undefined = not known). */
function beforeFor({ before, field, route, plugin }) {
  if (!before || typeof before !== 'object') return undefined;
  if (route.route === 'media' || field === 'alt') return before.alt_text;
  if (field === 'slug') return before.slug;
  if (field === 'excerpt') return before.excerpt && typeof before.excerpt === 'object' ? before.excerpt.raw : before.excerpt;
  if (route.route === 'aioseo') {
    const meta = before.aioseo_meta_data || before.aioseo || null;
    return meta && typeof meta === 'object' ? meta[field] : undefined;
  }
  if (route.route === 'seopress') {
    const meta = before.meta && typeof before.meta === 'object' ? before.meta : null;
    const key = field === 'title' ? '_seopress_titles_title' : '_seopress_titles_desc';
    return meta ? meta[key] : undefined;
  }
  if (plugin && META_KEYS[plugin.id]) {
    const meta = before.meta && typeof before.meta === 'object' ? before.meta : null;
    return meta ? meta[META_KEYS[plugin.id][field]] : undefined;
  }
  return undefined;
}

function rollbackBodyFor({ route, field, beforeValue }) {
  if (beforeValue === undefined) return null; // no captured value -> no rollback claim
  const value = beforeValue === null ? '' : beforeValue;
  if (route.route === 'aioseo') return { aioseo_meta_data: { [field]: value } };
  if (route.route === 'seopress') return { [field]: value };
  if (route.route === 'media') return { alt_text: value };
  return { [field]: value };
}

/** preview: the stored request preview, written into the run's preview/ directory. */
export async function preview(change, ctx = {}) {
  const body = (change.preview && change.preview.body) || '';
  if (ctx.run) writeText(ctx.run.previewPath(change.id, change.preview && change.preview.kind === 'text' ? '.txt' : '.json.txt'), body);
  if (change.status === 'skipped_unready') return { change, ok: null, body, reason: 'not applicable over REST on this site — read the preview for the two ways forward' };
  return { change: canTransition(change.status, 'previewed') ? transition(change, 'previewed') : change, ok: true, body };
}

/** apply: the live REST write. The ticket was checked by the caller; this refuses anything unsafe. */
export async function apply(change, ctx = {}) {
  const env = ctx.env || process.env;
  if (change.status === 'skipped_unready') {
    return { change, ok: false, reason: 'skipped_unready', error: change.error || 'this change cannot be written over REST' };
  }
  const payload = change.payload || {};
  const site = siteFor(ctx);
  const https = requireHttps(site);
  if (!https.ok) return { change: transition(change, 'failed', { error: https.reason }), ok: false };
  const check = sanitizeBody(payload.body);
  if (check.refused.length) {
    return { change: transition(change, 'failed', { error: 'refusing to send ' + check.refused.join(', ') + ' — this adapter never changes post status or content' }), ok: false };
  }
  const headers = authHeaders(ctx);
  if (!headers) {
    return { change: transition(change, 'failed', { error: 'missing credentials: ' + missingKeys(KEYS, env).join(', ') }), ok: false };
  }
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String((e && e.message) || e) }; }

  const url = payload.url || restUrl(https.url, payload.path);
  const safeUrl = requireHttps(url);
  if (!safeUrl.ok) return { change: transition(change, 'failed', { error: safeUrl.reason }), ok: false };
  const http = httpFor(ctx);
  let res;
  try { res = await http.json(url, { method: payload.method, headers, body: check.body }); }
  catch (e) { return { change: transition(confirmed, 'failed', { error: String((e && e.message) || e) }), ok: false }; }
  if (!res.ok) {
    return { change: transition(confirmed, 'failed', { error: describeFailure(res, env) }), ok: false, status: res.status };
  }
  if (ctx.run) {
    writeJson(ctx.run.afterPath(confirmed.id), {
      change: confirmed.id, method: payload.method, url, status: res.status,
      field: payload.field, applied_at: new Date().toISOString(),
    });
    ctx.run.log({ event: 'apply', adapter: ADAPTER, change: confirmed.id, method: payload.method, status: res.status, field: payload.field });
  }
  return { change: transition(confirmed, 'applied'), ok: true, status: res.status };
}

/**
 * verify: read the resource back over REST, then look at the public page with a cache-buster.
 * REST correct + public stale is `pending_cache` with flush instructions — never a pass, never a fail.
 */
export async function verify(change, ctx = {}) {
  const env = ctx.env || process.env;
  const payload = change.payload || {};
  const site = siteFor(ctx);
  const https = requireHttps(site);
  if (!https.ok) return { change, ok: null, checks: [{ name: 'site', ok: null, detail: https.reason }] };
  const headers = authHeaders(ctx);
  const resource = payload.resource || {};
  const checks = [];
  const wanted = payload.body && payload.field ? { [payload.field]: valueFromBody(payload) } : null;

  if (!headers) {
    checks.push({ name: 'rest', ok: null, detail: 'no credentials: cannot re-read the resource' });
  } else {
    const http = httpFor(ctx);
    let res;
    try { res = await http.get(restUrl(https.url, 'wp/v2/' + resource.type + '/' + resource.id), { headers, query: { context: 'edit' } }); }
    catch (e) { res = { ok: false, status: 0, error: { message: String((e && e.message) || e) } }; }
    if (!res.ok) checks.push({ name: 'rest', ok: null, detail: 'could not re-read the resource: ' + describeFailure(res, env) });
    else {
      const observed = beforeFor({ before: res.json, field: payload.field, route: { route: payload.route }, plugin: payload.plugin ? { id: payload.plugin } : null });
      const cmp = fieldsMatch(wanted || {}, { [payload.field]: observed });
      checks.push({
        name: 'rest', ok: observed === undefined ? null : cmp.ok,
        detail: observed === undefined
          ? payload.field + ' is not readable over REST on this site (the plugin owns it)'
          : (cmp.ok ? payload.field + ' matches the value that was written' : payload.field + ' still reads ' + JSON.stringify(observed)),
      });
    }
  }

  const url = publicUrlFor(change, ctx);
  const needle = wanted ? String(wanted[payload.field] || '') : '';
  let publicCheck = null;
  if (url && needle) {
    publicCheck = await checkPublicUrl(url, [needle], ctx);
    checks.push({
      name: 'public', ok: publicCheck.ok,
      detail: publicCheck.error ? 'could not fetch ' + publicCheck.url + ': ' + publicCheck.error
        : (publicCheck.ok ? 'the public page serves the new value' : 'the public page still serves the old value'),
    });
  }

  const restCheck = checks.find((c) => c.name === 'rest');
  if (restCheck && restCheck.ok === false) {
    return { change: canTransition(change.status, 'failed') ? transition(change, 'failed', { error: restCheck.detail }) : change, ok: false, checks };
  }
  if (publicCheck && publicCheck.ok === false && restCheck && restCheck.ok !== false) {
    const next = canTransition(change.status, 'pending_cache') ? transition(change, 'pending_cache') : change;
    return {
      change: next, ok: null, checks,
      note: 'the API accepted the change but the public page is still cached. Flush and re-verify: `wp cache flush` over SSH, your caching plugin\'s "Purge all", and the CDN in front of the site (Cloudflare: Caching -> Configuration -> Purge Everything).',
    };
  }
  if (restCheck && restCheck.ok === null && (!publicCheck || publicCheck.ok !== true)) {
    return { change, ok: null, checks, note: 'not verifiable from here — treat this as unconfirmed, not as done' };
  }
  if (!canTransition(change.status, 'verified')) return { change, ok: true, checks, note: 'checks passed; status left at "' + change.status + '"' };
  return { change: transition(change, 'verified'), ok: true, checks };
}

function valueFromBody(payload) {
  const body = payload.body || {};
  if (body.aioseo_meta_data && typeof body.aioseo_meta_data === 'object') return body.aioseo_meta_data[payload.field];
  if (body.alt_text !== undefined) return body.alt_text;
  return body[payload.field];
}

/** rollback: POST/PUT the captured `before` value back through the same route. */
export async function rollback(change, ctx = {}) {
  const env = ctx.env || process.env;
  const data = (change.rollback && change.rollback.data) || null;
  if (!data || !data.body) {
    return { change, ok: false, reason: 'no-before', note: 'the value before the write was never readable, so there is nothing to restore — put the old value back by hand in the plugin\'s field' };
  }
  const headers = authHeaders(ctx);
  if (!headers) return { change, ok: false, error: 'missing credentials: ' + missingKeys(KEYS, env).join(', ') };
  const site = siteFor(ctx);
  const https = requireHttps(site);
  if (!https.ok) return { change, ok: false, error: https.reason };
  const url = data.url || restUrl(https.url, data.path);
  const safeUrl = requireHttps(url);
  if (!safeUrl.ok) return { change, ok: false, error: safeUrl.reason };
  const http = httpFor(ctx);
  let res;
  try { res = await http.json(url, { method: data.method, headers, body: sanitizeBody(data.body).body }); }
  catch (e) { return { change, ok: false, error: String((e && e.message) || e) }; }
  if (!res.ok) return { change, ok: false, error: describeFailure(res, env) };
  if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, status: res.status });
  return { change: canTransition(change.status, 'rolled_back') ? transition(change, 'rolled_back') : change, ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// CLI

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args) {
  const planFile = run ? run.readPlan() : null;
  const all = planFile && Array.isArray(planFile.changes) ? planFile.changes : [];
  const mine = all.filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    return mine.filter((c) => wanted.has(c.id));
  }
  return mine;
}

function persist(run, updated) {
  if (!run || !updated.length) return;
  const planFile = run.readPlan();
  if (!planFile || !Array.isArray(planFile.changes)) return;
  const byId = new Map(updated.map((c) => [c.id, c]));
  run.setChanges(planFile.changes.map((c) => (byId.has(c.id) ? byId.get(c.id) : c)));
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) {
    return { result: { error: 'usage: wordpress-rest <' + OPS.join('|') + '> --run <dir> [--change <id>] [--ticket <t>]' }, code: EXIT.USAGE };
  }
  const dataDir = resolveDataDir(args);
  const options = { wpUrl: args['wp-url'] && args['wp-url'] !== true ? String(args['wp-url']) : null };
  const ctx = {
    dataDir, env: process.env, now: () => new Date(), site: options.wpUrl || undefined,
    devUrl: args['dev-url'] && args['dev-url'] !== true ? String(args['dev-url']) : null,
  };

  if (op === 'capabilities') {
    return { result: await capabilities(ctx, options), code: EXIT.OK };
  }

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const run = loadRun(args, dataDir) || openFixRun(dataDir, {
      report: String(args.report), profile: args.profile && args.profile !== true ? String(args.profile) : null,
      target: report.target || null, adapters: [ADAPTER],
    });
    ctx.run = run;
    const out = await plan({
      report, profile: args.profile && args.profile !== true ? String(args.profile) : null,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
      plugin: args.plugin && args.plugin !== true ? String(args.plugin) : null,
      wpUrl: options.wpUrl,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) {
        if (c.preview && c.preview.body) writeText(run.previewPath(c.id, c.preview.kind === 'text' ? '.txt' : '.json.txt'), c.preview.body);
      }
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length, skipped: out.skipped.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  const changes = pickChanges(run, args);
  if (!changes.length) return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };

  const results = [];
  const updated = [];
  for (const change of changes) {
    if (op === 'apply') {
      const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change.id });
      if (!gate.ok) {
        results.push({ change: change.id, ok: false, refused: gate.reason, error: op + ' needs a valid confirmation ticket (' + gate.reason + ')' });
        continue;
      }
    }
    const fn = { preview, apply, verify, rollback }[op];
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push(redactObject({
      change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok,
      ...(out.error ? { error: out.error } : {}),
      ...(out.checks ? { checks: out.checks } : {}),
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.note ? { note: out.note } : {}),
    }, { env: process.env }));
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
