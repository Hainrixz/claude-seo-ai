#!/usr/bin/env node
// detect-platform.mjs — build the SiteProfile the orchestrator merges into <run_dir>/profile.json.
//
// Four independent layers are scored (platform / framework / cms plugins / hosting), so a headless
// WordPress behind Next.js resolves both instead of one shadowing the other. Everything is evidence
// based: every verdict carries the signals that produced it, and a layer with too little evidence is
// omitted rather than guessed — an unknown platform is `null`, never "probably WordPress".
//
// Usage:
//   node detect-platform.mjs --snapshot <run>/pages/<slug>.json [--path <project>] [--probe]
//   node detect-platform.mjs --url https://example.com [--path <project>] [--probe]
//   node detect-platform.mjs --path <project>
//   node detect-platform.mjs --html page.html [--headers h.json] [--cookies c.json] [--probes p.json] [--url u]
//   ... [--out <profile.json>]
//
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failure).
//
// Network: only `--url` and `--probe` touch the network, and `--probe` is limited to the small set
// of endpoints in PROBE_PATHS. `--path` is the only way repo/pkg signals are ever consulted.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { EXIT, fetchText, isMain, readSnapshot, runCli } from './lib/util.mjs';
import { parseDocument } from './lib/html.mjs';
import {
  ADAPTERS, BUILD_CONFIG_FILES, CARD_IDS, ENVIRONMENT_RULES, PAGE_API_KEYS,
  PLATFORM_CAPABILITIES, RULES, VERTICAL_HINTS, confidenceOf,
} from './lib/platform-rules.mjs';
// Key names travel through the catalog so a historical spelling still resolves: the catalog name is
// what profile.json reports, and both it and its aliases are accepted from the environment.
import { lookupOrder } from './lib/credentials.mjs';

export { RULES };

export const PROFILE_VERSION = 'detect-platform/1';

/** Endpoints `--probe` may request (opt-in, one GET each, capped). */
export const PROBE_PATHS = Object.freeze(['/wp-json/', '/.well-known/ucp', '/products.json', '/wp-sitemap.xml']);

/** WordPress REST namespace -> plugin id. */
export const NAMESPACE_PLUGINS = Object.freeze({
  'yoast/v1': 'yoast', 'rankmath/v1': 'rankmath', 'aioseo/v1': 'aioseo', 'seopress/v1': 'seopress',
  'wc/v3': 'woocommerce', 'wc/store/v1': 'woocommerce', 'wc/v2': 'woocommerce',
});

const REPO_SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.cache',
  'dist', 'build', 'coverage', '.turbo', '.vercel', '.netlify', 'vendor', '.venv', '__pycache__', 'tmp']);
const MAX_REPO_FILES = 4000;
const MAX_REPO_DEPTH = 6;

// ---------------------------------------------------------------------------
// Evidence

const uniq = (a) => [...new Set(a.filter((x) => x != null && x !== ''))];
const asRe = (m) => (m instanceof RegExp ? m : new RegExp(escapeRe(String(m)), 'i'));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s, n = 72) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

/** Lowercase header names, join array values, drop the snapshot's cookie_names helper key. */
export function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    const name = String(k).toLowerCase();
    if (name === 'cookie_names') continue;
    out[name] = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  }
  return out;
}

/** Cookie NAMES only — values are never read, recorded or matched. */
export function normalizeCookies(cookies, headers = {}) {
  const names = [];
  const push = (n) => { const t = String(n).trim(); if (t) names.push(t.split('=')[0].trim()); };
  if (Array.isArray(cookies)) cookies.forEach(push);
  else if (cookies && typeof cookies === 'object') Object.keys(cookies).forEach(push);
  else if (typeof cookies === 'string') cookies.split(/[;,]/).forEach(push);
  const sc = headers['set-cookie'];
  if (sc) String(sc).split(/,\s*(?=[^;,=\s]+=)/).forEach(push);
  return uniq(names);
}

/** Probe map: `{ "/wp-json": { status, text } }` with normalized keys. */
export function normalizeProbes(probes) {
  const out = {};
  if (!probes || typeof probes !== 'object') return out;
  for (const [k, v] of Object.entries(probes)) {
    const key = probeKey(k);
    if (!key) continue;
    const status = v && typeof v === 'object' && Number.isInteger(v.status) ? v.status : (typeof v === 'number' ? v : null);
    let text = '';
    if (v && typeof v === 'object') {
      if (typeof v.text === 'string') text = v.text;
      else if (typeof v.body === 'string') text = v.body;
      else if (v.json !== undefined) { try { text = JSON.stringify(v.json); } catch { text = ''; } }
    } else if (typeof v === 'string') text = v;
    out[key] = { status, text };
  }
  return out;
}

function probeKey(p) {
  let s = String(p || '').trim();
  if (!s) return null;
  try { if (/^https?:/i.test(s)) { const u = new URL(s); s = u.pathname; } } catch { /* keep raw */ }
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\?.*$/, '');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

const URL_ATTR = /\b(?:src|href|data-src|data-lazy-src|data-original|srcset|data-srcset|poster|action|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/gi;

/** Every URL-ish attribute value in the HTML (srcset split into candidates). */
export function extractUrls(html) {
  const out = [];
  if (!html) return out;
  URL_ATTR.lastIndex = 0;
  let m;
  while ((m = URL_ATTR.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw || raw.length > 2000) continue;
    for (const part of raw.split(',')) {
      const v = part.trim().split(/\s+/)[0];
      if (v && (v.includes('/') || v.includes(':'))) out.push(v);
    }
  }
  return out;
}

function hostOf(v) {
  try {
    if (/^https?:\/\//i.test(v)) return new URL(v).host.toLowerCase();
    if (v.startsWith('//')) return new URL('https:' + v).host.toLowerCase();
  } catch { /* not a URL */ }
  return null;
}

function pathOf(v) {
  try { if (/^https?:\/\//i.test(v)) { const u = new URL(v); return u.pathname + u.search; } } catch { /* not a URL */ }
  return v;
}

/** Normalized evidence bundle every rule is scored against. */
export function buildEvidence(input = {}) {
  const html = typeof input.html === 'string' ? input.html : '';
  const headers = normalizeHeaders(input.headers);
  const cookies = normalizeCookies(input.cookies, headers);
  const probes = normalizeProbes(input.probes);
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null;
  let host = null; let pathQuery = null;
  if (url) { try { const u = new URL(url); host = u.host.toLowerCase(); pathQuery = u.pathname + u.search; } catch { /* not absolute */ } }

  const doc = html ? (input.doc || parseDocument(html)) : null;
  const urls = extractUrls(html);
  const linkTags = doc ? doc.links_rel.map((l) => `<link rel="${(l.rel || []).join(' ')}" href="${l.href || ''}" type="${l.type || ''}" hreflang="${l.hreflang || ''}">`) : [];
  if (headers.link) linkTags.push('Link: ' + headers.link);

  const files = Array.isArray(input.files) ? uniq(input.files.map((f) => String(f).split(sep).join('/').replace(/^\.\//, ''))) : [];
  const deps = input.deps && typeof input.deps === 'object' ? Object.keys(input.deps) : Array.isArray(input.deps) ? input.deps.map(String) : [];

  return {
    html, headers, cookies, probes, url, host,
    path_query: pathQuery,
    hosts: uniq([host, ...urls.map(hostOf)]),
    paths: uniq([pathQuery, ...urls.map(pathOf)]),
    generator: doc ? doc.markers.generator : null,
    link_rel_text: linkTags.join('\n'),
    files, deps,
    has_html: !!html, has_headers: Object.keys(headers).length > 0, has_repo: files.length > 0,
    probe_paths: Object.keys(probes),
    doc,
  };
}

// ---------------------------------------------------------------------------
// Rule matching

/** Test one rule against the evidence. Returns `{ value }` (the matched token) or null. */
export function testRule(rule, ev) {
  if (!rule || !rule.kind) return null;
  const hay = (list) => {
    const re = asRe(rule.match);
    for (const item of list) {
      if (item == null) continue;
      const m = re.exec(String(item));
      if (m) return { value: clip(m[0], 72) };
    }
    return null;
  };
  switch (rule.kind) {
    case 'header': {
      const want = String(rule.match).toLowerCase();
      const names = want.includes('*')
        ? Object.keys(ev.headers).filter((h) => new RegExp('^' + want.split('*').map(escapeRe).join('.*') + '$').test(h))
        : (Object.prototype.hasOwnProperty.call(ev.headers, want) ? [want] : []);
      for (const n of names) {
        if (!rule.value) return { value: n };
        const m = asRe(rule.value).exec(ev.headers[n]);
        if (m) return { value: n + ': ' + clip(m[0], 48) };
      }
      return null;
    }
    case 'cookie': {
      const re = asRe(rule.match);
      const hit = ev.cookies.find((c) => re.test(c));
      return hit ? { value: 'cookie ' + hit } : null;
    }
    case 'generator':
      return ev.generator && asRe(rule.match).test(ev.generator) ? { value: 'generator: ' + clip(ev.generator, 48) } : null;
    case 'asset_host':
      return hay(rule.scope === 'page' ? [ev.host] : ev.hosts);
    case 'path':
      return hay(rule.scope === 'page' ? [ev.path_query] : ev.paths);
    case 'dom': {
      const m = asRe(rule.match).exec(ev.html);
      return m ? { value: clip(m[0], 72) } : null;
    }
    case 'link_rel': {
      const m = asRe(rule.match).exec(ev.link_rel_text);
      return m ? { value: clip(m[0], 72) } : null;
    }
    case 'probe': {
      const key = probeKey(rule.match);
      const p = ev.probes[key];
      if (!p) return null;
      const okStatus = p.status == null ? !!p.text : p.status >= 200 && p.status < 300;
      if (!okStatus) return null;
      if (!rule.value) return { value: key + ' ' + (p.status == null ? 'ok' : p.status) };
      const m = asRe(rule.value).exec(p.text || '');
      return m ? { value: key + ' ' + clip(m[0], 48) } : null;
    }
    case 'repo':
      return hay(ev.files);
    case 'pkg': {
      const re = rule.match instanceof RegExp ? rule.match : new RegExp('^' + escapeRe(String(rule.match)) + '$');
      const hit = ev.deps.find((d) => re.test(d));
      return hit ? { value: 'dependency ' + hit } : null;
    }
    default:
      return null;
  }
}

/**
 * Score one layer. `rulesById` is `{ id: Rule[] }` (or a layer name from RULES).
 * Returns `[{ id, score, confidence, kinds, signals }]`, highest score first, ties broken by id.
 */
export function scoreLayer(rulesById, ev) {
  const layer = typeof rulesById === 'string' ? RULES[rulesById] : rulesById;
  const out = [];
  if (!layer) return out;
  for (const [id, rules] of Object.entries(layer)) {
    const signals = [];
    const kinds = new Set();
    let score = 0;
    for (const rule of rules) {
      const hit = testRule(rule, ev);
      if (!hit) continue;
      score += rule.weight;
      kinds.add(rule.kind);
      const s = { kind: rule.kind, value: hit.value, weight: rule.weight };
      if (rule.note) s.note = rule.note;
      signals.push(s);
    }
    if (score <= 0) continue;
    out.push({ id, score, confidence: confidenceOf(score, kinds.size), kinds: [...kinds], signals });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out;
}

const keep = (c) => (c && c.confidence ? { id: c.id, confidence: c.confidence, score: c.score, signals: c.signals } : null);

/** Runner-up candidates that cleared the low floor — what the verdict was chosen over. */
const alternatives = (cands, chosen) => cands
  .filter((c) => c.confidence && (!chosen || c.id !== chosen.id))
  .map((c) => ({ id: c.id, confidence: c.confidence, score: c.score }));

// ---------------------------------------------------------------------------
// Environment

export function detectEnvironment(ev) {
  const signals = [];
  let kind = 'production';
  for (const rule of ENVIRONMENT_RULES) {
    const hit = testRule(rule, ev);
    if (!hit) continue;
    signals.push({ kind: rule.kind, value: hit.value, weight: rule.weight });
    if (kind === 'production') kind = rule.env;
  }
  if (!ev.url && ev.has_repo && !ev.has_html) { kind = 'local'; signals.push({ kind: 'repo', value: 'project directory only, no HTTP target', weight: 3 }); }
  if (kind !== 'production') {
    const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(ev.html) || /noindex/i.test(ev.headers['x-robots-tag'] || '');
    if (noindex) signals.push({ kind: 'dom', value: 'noindex on a non-production host (expected)', weight: 2 });
  }
  return { kind, signals };
}

// ---------------------------------------------------------------------------
// Capabilities, write targets

/**
 * Credential presence: key names only — `CLAUDE_PLUGIN_OPTION_<KEY>` or `<KEY>`, for the catalog
 * name and every alias of it. Values are never read, and presence is presence: an exported empty
 * string means the operator set the variable, so it is not reported as missing here.
 */
export function hasCredential(key, env = process.env) {
  return lookupOrder(String(key)).some((name) => Object.prototype.hasOwnProperty.call(env || {}, name));
}

/** Is `name` an executable on PATH? (presence only — never executed here.) */
export function hasTool(name, env = process.env) {
  const path = env.PATH || env.Path || '';
  if (!path) return false;
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      try { const p = join(dir, name + ext); if (statSync(p).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

function toolMap(names, lookup) {
  const out = {};
  for (const n of names) out[n] = !!lookup(n);
  return out;
}

function deriveCapabilities({ platform, framework, plugins, localFiles, tools, ev, headless }) {
  const base = platform && PLATFORM_CAPABILITIES[platform.id] ? { ...PLATFORM_CAPABILITIES[platform.id] } : {
    theme_files: false, rest_api: false, wp_cli: false, admin_api: false, page_api: false,
    sitemap_editable: false, robots_editable: 'none', redirects: 'none',
    head_owner: framework ? 'framework' : 'theme', instructions_only: !framework,
  };
  const caps = { local_files: localFiles, ...base };
  caps.wp_cli = !!(platform && platform.id === 'wordpress' && tools.wp);

  if (platform && platform.id === 'wordpress') {
    const seoPlugin = plugins.find((p) => p.id !== 'woocommerce');
    if (seoPlugin) caps.head_owner = 'seo-plugin';
    if (localFiles) {
      caps.robots_editable = ev.files.some((f) => /^robots\.txt$/i.test(f)) ? 'physical' : 'plugin';
      caps.theme_files = true;
    }
  }
  if (headless) {
    caps.head_owner = 'framework';
    caps.theme_files = false;
    caps.robots_editable = localFiles ? 'file' : 'none';
    if (caps.redirects === 'none' && localFiles) caps.redirects = 'file';
  }
  if (!platform && framework) { caps.head_owner = 'framework'; caps.instructions_only = !localFiles; }
  if (localFiles && (!platform || headless || framework)) {
    caps.sitemap_editable = true;
    if (caps.robots_editable === 'none') caps.robots_editable = 'file';
    if (caps.redirects === 'none') caps.redirects = 'file';
    caps.instructions_only = false;
  }
  if (!platform && !framework && !localFiles) caps.instructions_only = true;
  return caps;
}

function buildWriteTargets({ platform, caps, env, lookup }) {
  const out = [];
  const add = (adapter, over = {}) => {
    const spec = ADAPTERS[adapter] || { for: [], needs: [], tools: [] };
    const needs = over.needs || spec.needs;
    const tools = toolMap(over.tools || spec.tools, lookup);
    const ready = needs.every((k) => hasCredential(k, env)) && Object.values(tools).every(Boolean);
    out.push({ adapter, for: over.for || spec.for, ready, needs: [...needs], tools });
  };
  // A `low` platform verdict is a hint, not a mandate: it never selects a CMS write path.
  const pid = platform && (platform.confidence === 'high' || platform.confidence === 'medium') ? platform.id : null;
  if (pid === 'shopify') {
    if (caps.theme_files) add('shopify-theme');
    if (caps.admin_api) add('shopify-admin');
  }
  if (pid === 'wordpress') {
    add('wordpress-rest');
    add('wordpress-wpcli');
  }
  if (caps.page_api && pid && PAGE_API_KEYS[pid]) add('page-api', { needs: PAGE_API_KEYS[pid] });
  if (caps.local_files) add('local-files');
  add('instructions');
  return out;
}

// ---------------------------------------------------------------------------
// Framework flavor / router

function frameworkDetails(id, ev, platformId) {
  const has = (re) => ev.files.some((f) => re.test(f));
  switch (id) {
    case 'nextjs': {
      let router = null;
      if (has(/^(src\/)?app\/layout\.(js|jsx|ts|tsx|mjs)$/)) router = 'app';
      else if (has(/^(src\/)?pages\/_app\.(js|jsx|ts|tsx|mjs)$/)) router = 'pages';
      else if (/self\.__next_f\.push/.test(ev.html)) router = 'app';
      else if (/__NEXT_DATA__|next-head-count/.test(ev.html)) router = 'pages';
      return { flavor: router ? router + '-router' : null, router };
    }
    case 'react-router': {
      if (platformId === 'shopify' || ev.deps.includes('@shopify/hydrogen')) return { flavor: 'hydrogen', router: 'remix' };
      if (/__reactRouterContext/.test(ev.html) || has(/^react-router\.config\./) || ev.deps.includes('react-router')) return { flavor: 'react-router-7', router: 'framework' };
      if (/__remixContext/.test(ev.html) || has(/^remix\.config\./) || ev.deps.includes('@remix-run/react')) return { flavor: 'remix', router: 'remix' };
      return { flavor: null, router: null };
    }
    case 'nuxt':
      return { flavor: has(/^app\/pages\//) ? 'nuxt-4' : null, router: null };
    case 'jekyll':
      return { flavor: /Begin Jekyll SEO tag/i.test(ev.html) ? 'jekyll-seo-tag' : null, router: null };
    case 'sveltekit':
      return { flavor: null, router: has(/^src\/routes\//) ? 'filesystem' : null };
    default:
      return { flavor: null, router: null };
  }
}

// ---------------------------------------------------------------------------
// detect()

/**
 * Build a SiteProfile from an evidence bundle.
 * input: { url, html, headers, cookies, probes, files[], deps{}, env, which(name)->bool, project_root }
 */
export function detect(input = {}) {
  const ev = buildEvidence(input);
  const env = input.env || process.env;
  const lookup = typeof input.which === 'function' ? input.which
    : input.tools && typeof input.tools === 'object' ? (n) => !!input.tools[n]
      : (n) => hasTool(n, env);
  const notes = [];

  const platformCands = scoreLayer(RULES.platform, ev);
  let frameworkCands = scoreLayer(RULES.framework, ev);
  const pluginCands = scoreLayer(RULES.plugins, ev);
  const hostingCands = scoreLayer(RULES.hosting, ev);

  // `static` is a statement about the ABSENCE of a build system: drop it as soon as any build
  // framework has evidence, or a build config file is present in the project.
  const buildish = frameworkCands.some((c) => c.id !== 'static' && c.confidence) || ev.files.some((f) => BUILD_CONFIG_FILES.some((re) => re.test(f)));
  if (buildish) frameworkCands = frameworkCands.filter((c) => c.id !== 'static');

  const platform = keep(platformCands[0]);
  const framework = keep(frameworkCands[0]);
  const plugins = pluginCands.filter((c) => c.confidence).map((c) => ({ id: c.id, confidence: c.confidence, score: c.score, signals: c.signals }));
  const hostingTop = keep(hostingCands[0]);

  const headless = !!(platform && framework && framework.id !== 'static'
    && !(platform.id === 'payload') && (framework.confidence === 'high' || framework.confidence === 'medium'));
  if (headless) notes.push(`headless / decoupled front end: ${platform.id} content with a ${framework.id} head — the framework owns the <head>, not the CMS theme`);

  let frameworkOut = null;
  if (framework) {
    const { flavor, router } = frameworkDetails(framework.id, ev, platform ? platform.id : null);
    frameworkOut = { id: framework.id, flavor, router, confidence: framework.confidence, score: framework.score, signals: framework.signals };
  }

  const localFiles = ev.has_repo;
  const tools = toolMap(['shopify', 'wp', 'ssh'], lookup);
  const capabilities = deriveCapabilities({ platform, framework, plugins, localFiles, tools, ev, headless });
  const write_targets = buildWriteTargets({ platform, caps: capabilities, env, lookup });
  const environment = detectEnvironment(ev);

  const hints = [];
  for (const id of [platform && platform.id, framework && framework.id, ...plugins.map((p) => p.id)]) {
    if (id && VERTICAL_HINTS[id]) hints.push(...VERTICAL_HINTS[id]);
  }
  if (ev.probes['/.well-known/ucp'] || ev.probes['/products.json']) hints.push('ecommerce');

  if (!ev.url && ev.has_html) notes.push('environment defaults to production: no target URL was given, so the host-based preview/staging signals could not be checked');
  if (!ev.has_repo) notes.push('repo signals not consulted: no --path given (repo/pkg rules were skipped)');
  if (!ev.probe_paths.length) notes.push('no probe results supplied: probe-only signals (REST namespaces, /.well-known/ucp) were skipped — rerun with --probe for a plugin-accurate WordPress verdict');
  if (!platform) notes.push('platform unresolved: no candidate reached the low-confidence floor (score >= 2). Treat the site as instructions-only until a card is confirmed by hand.');
  else if (platform.confidence === 'low') notes.push(`platform "${platform.id}" is low confidence (score ${platform.score}, ${platform.signals.length} signal(s)): reported, but no platform write path is offered — confirm it by hand first`);
  if (platform && platform.id === 'wordpress' && localFiles && ev.files.some((f) => f === 'theme.json' || /\/theme\.json$/.test(f)) && ev.files.some((f) => /(^|\/)templates\/.+\.html$/.test(f))) {
    notes.push('block theme detected (theme.json + templates/*.html): there is no header.php — head edits go through wp_head or the SEO plugin');
  }
  for (const sig of [...(platform ? platform.signals : []), ...(framework ? framework.signals : [])]) {
    if (sig.note && sig.note.startsWith('UNVERIFIED')) notes.push(`signal "${sig.value}" — ${sig.note}`);
  }

  return {
    version: PROFILE_VERSION,
    target: { url: ev.url, host: ev.host, project_root: input.project_root || null },
    platform,
    framework: frameworkOut,
    cms_plugins: plugins,
    hosting: hostingTop ? { id: hostingTop.id, confidence: hostingTop.confidence, signals: hostingTop.signals } : { id: null, confidence: null, signals: [] },
    environment,
    capabilities,
    write_targets,
    candidates: {
      platform: alternatives(platformCands, platform),
      framework: alternatives(frameworkCands, framework),
    },
    vertical_hints: uniq(hints),
    cards: uniq([platform && platform.id, framework && framework.id, ...plugins.map((p) => p.id)].filter((id) => CARD_IDS.includes(id)))
      .map((id) => `references/platforms/${id}.md`),
    sources: {
      html: ev.has_html, headers: ev.has_headers, cookies: ev.cookies.length > 0,
      probes: ev.probe_paths, repo: input.project_root || null, repo_files: ev.files.length,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Probes

function joinUrl(origin, path) {
  try { return new URL(path, origin).toString(); } catch { return String(origin).replace(/\/+$/, '') + path; }
}

/**
 * Probe `<origin>/wp-json/` for the REST namespace list — far more reliable than sniffing HTML
 * comments, and the only way to tell Yoast from Rank Math from AIOSEO without guessing.
 * `fetchImpl(url, opts) -> { status, text, error }` is injectable (tests never touch the network).
 */
export async function probeWordPress(origin, fetchImpl = fetchText) {
  const url = joinUrl(origin, '/wp-json/');
  let r;
  try { r = await fetchImpl(url, { maxBytes: 262144, accept: 'application/json' }); }
  catch (e) { return { ok: false, url, status: null, namespaces: [], plugins: [], error: String((e && e.message) || e) }; }
  const status = r && Number.isInteger(r.status) ? r.status : null;
  const text = r && typeof r.text === 'string' ? r.text : '';
  if (status === null || status < 200 || status >= 300) {
    return { ok: false, url, status, namespaces: [], plugins: [], error: (r && r.error) || (status ? 'HTTP ' + status : 'no response') };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json || !Array.isArray(json.namespaces)) {
    return { ok: false, url, status, namespaces: [], plugins: [], error: 'response is not a WP REST index (no namespaces[])' };
  }
  const namespaces = json.namespaces.map(String);
  const plugins = uniq(namespaces.map((ns) => NAMESPACE_PLUGINS[ns]));
  return { ok: true, url, status, namespaces, plugins, error: null };
}

/** Run the opt-in probe set; returns a probes map ready for detect({ probes }). */
export async function runProbes(origin, fetchImpl = fetchText, paths = PROBE_PATHS) {
  const probes = {};
  for (const p of paths) {
    if (p === '/wp-json/') {
      const wp = await probeWordPress(origin, fetchImpl);
      probes[p] = { status: wp.status, text: wp.ok ? JSON.stringify({ namespaces: wp.namespaces }) : '' };
      continue;
    }
    let r;
    try { r = await fetchImpl(joinUrl(origin, p), { maxBytes: 65536 }); }
    catch (e) { probes[p] = { status: null, text: '', error: String((e && e.message) || e) }; continue; }
    probes[p] = { status: Number.isInteger(r && r.status) ? r.status : null, text: typeof (r && r.text) === 'string' ? r.text.slice(0, 4096) : '' };
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Project (repo) reading — only with --path

/** Walk a project directory into project-relative POSIX paths + package.json dependency names. */
export function readProject(dir) {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { root, files: [], deps: {}, error: 'not a directory: ' + root };
  const files = [];
  const walk = (abs, rel, depth) => {
    if (files.length >= MAX_REPO_FILES || depth > MAX_REPO_DEPTH) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_REPO_FILES) return;
      if (e.isDirectory()) { if (e.name.startsWith('.') || REPO_SKIP.has(e.name)) continue; walk(join(abs, e.name), rel + e.name + '/', depth + 1); }
      else files.push(rel + e.name);
    }
  };
  walk(root, '', 0);
  let deps = {};
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
    } catch { /* unreadable package.json is not fatal */ }
  }
  return { root, files, deps, error: null };
}

// ---------------------------------------------------------------------------
// CLI

function readJsonArg(p, label) {
  try { return { value: JSON.parse(readFileSync(resolve(p), 'utf8')), error: null }; }
  catch (e) { return { value: null, error: `cannot read --${label} ${p}: ` + String((e && e.message) || e) }; }
}

const USAGE = 'usage: detect-platform.mjs --snapshot <pages/x.json> [--path <dir>] [--probe] | --url <u> [--path] [--probe] | --path <dir> | --html <f> [--headers <j>] [--cookies <j>] [--probes <j>]';

export async function main(args = {}) {
  const input = { env: process.env };
  let origin = null;

  // Project path (repo/pkg signals) — never consulted unless asked for.
  if (args.path && typeof args.path === 'string') {
    const proj = readProject(args.path);
    if (proj.error) return { result: { error: proj.error }, code: EXIT.USAGE };
    input.files = proj.files; input.deps = proj.deps; input.project_root = proj.root;
  }

  if (args.html && typeof args.html === 'string') {
    // Test / offline mode: everything comes from files.
    try { input.html = readFileSync(resolve(args.html), 'utf8'); }
    catch (e) { return { result: { error: 'cannot read --html ' + args.html + ': ' + String((e && e.message) || e) }, code: EXIT.USAGE }; }
    for (const [flag, key] of [['headers', 'headers'], ['cookies', 'cookies'], ['probes', 'probes']]) {
      if (typeof args[flag] !== 'string') continue;
      const { value, error } = readJsonArg(args[flag], flag);
      if (error) return { result: { error }, code: EXIT.USAGE };
      input[key] = value;
    }
    if (typeof args.url === 'string') input.url = args.url;
  } else if (args.snapshot !== undefined) {
    const rs = readSnapshot(args);
    if (rs.error) return { result: { error: rs.error }, code: EXIT.USAGE };
    const snap = rs.snapshot;
    let html = '';
    if (snap.raw_html_path) {
      try { html = readFileSync(resolve(rs.run_dir, snap.raw_html_path), 'utf8'); }
      catch (e) { return { result: { error: 'snapshot HTML missing: ' + snap.raw_html_path + ' (' + String((e && e.message) || e) + ')' }, code: EXIT.USAGE }; }
    } else if (snap.html_inline && typeof snap.html_inline.raw === 'string') html = snap.html_inline.raw;
    input.html = html;
    input.headers = snap.headers || {};
    input.cookies = snap.cookie_names || [];
    input.url = (snap.target && (snap.target.final_url || snap.target.requested_url)) || null;
    origin = (snap.target && snap.target.origin) || null;
  } else if (args.url && typeof args.url === 'string') {
    const r = await fetchText(args.url);
    if (!r || (r.error && !r.text)) return { result: { error: 'fetch failed: ' + ((r && r.error) || 'no response'), url: args.url }, code: EXIT.RUNTIME };
    input.html = r.text || '';
    input.headers = r.headers || {};
    input.cookies = (r.headers && r.headers.cookie_names) || [];
    input.url = r.finalUrl || args.url;
    try { origin = new URL(input.url).origin; } catch { origin = null; }
  } else if (!input.files) {
    return { result: { error: 'provide --snapshot, --url, --path or --html', usage: USAGE }, code: EXIT.USAGE };
  }

  if (args.probe) {
    if (!origin && input.url) { try { origin = new URL(input.url).origin; } catch { /* none */ } }
    if (!origin) return { result: { error: '--probe needs an http(s) target (use --snapshot or --url)', usage: USAGE }, code: EXIT.USAGE };
    input.probes = { ...(input.probes || {}), ...(await runProbes(origin, fetchText)) };
  }

  const profile = detect(input);
  if (args.out && typeof args.out === 'string') {
    try { writeFileSync(resolve(args.out), JSON.stringify(profile, null, 2) + '\n'); profile.written_to = resolve(args.out); }
    catch (e) { return { result: { error: 'cannot write --out ' + args.out + ': ' + String((e && e.message) || e) }, code: EXIT.RUNTIME }; }
  }
  return { result: profile, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
