// Persistence for claude-seo-ai runs (zero dependencies, Node >= 18).
//
// Layout (root = the runs directory, see resolveRoot):
//   <root>/index.json                          { version, updated_at, hosts: { <hostkey>: { runs[], latest, baseline, target } } }
//   <root>/<hostkey>/<run-id>/{site,pages,agents}/…   plus crawl.json, findings*.json, report.json, report.md written by other scripts
//   <root>/<hostkey>/latest        symlink → <run-id>   (best effort; Windows/EPERM tolerated)
//   <root>/<hostkey>/latest.json   { run, path, updated_at }   (always written — the portable pointer)
//   <root>/<hostkey>/baseline.json { run, path, set_at }       (set by `compare --set-baseline`; exempt from pruning)
//
// hostkey  = lower-cased host with ':' → '_' (so a port survives on every filesystem), e.g. 'www.example.com', '127.0.0.1_8080'
//            local paths → 'local/<basename>-<sha1(path)[:8]>' (two path segments)
// run-id   = UTC 'YYYY-MM-DDTHH-mm-ssZ' (sorts chronologically); callers may pass their own id (e.g. 'gap-<slug>')
// slug     = URL path with '/' → '_' (≤ 60 chars) + '--' + sha1(final URL)[:8]; the root path is 'index--<hash>'
//
// Nothing here prints or exits; every writer returns the absolute path it wrote.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Plugin root (the directory holding .claude-plugin/, scripts/, skills/). */
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
export const INDEX_VERSION = 1;
/** Timestamp run ids, optionally suffixed -2, -3 ... when two runs start in the same second. */
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/;
/** Retention defaults: 20 runs per host, 5 for gap-analysis hosts (keys starting with `_gap`). */
export const DEFAULT_KEEP = Object.freeze({ default: 20, gap: 5 });
const RESERVED_NAMES = new Set(['latest', 'baseline', 'index', 'latest.json', 'baseline.json', 'index.json']);

export function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }

/** Version string from .claude-plugin/plugin.json, or null when unreadable. */
export function pluginVersion() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Root resolution

/**
 * Where runs live: --out > $CLAUDE_SEO_AI_HOME > $CLAUDE_PLUGIN_DATA/runs > ~/.claude-seo-ai/runs.
 * Returns { root (absolute), source }.
 */
export function resolveRootInfo(args = {}, env = process.env) {
  const out = args && typeof args.out === 'string' && args.out.trim() ? args.out.trim() : null;
  if (out) return { root: resolve(out), source: '--out' };
  const home = env && typeof env.CLAUDE_SEO_AI_HOME === 'string' ? env.CLAUDE_SEO_AI_HOME.trim() : '';
  if (home) return { root: resolve(home), source: 'CLAUDE_SEO_AI_HOME' };
  const data = env && typeof env.CLAUDE_PLUGIN_DATA === 'string' ? env.CLAUDE_PLUGIN_DATA.trim() : '';
  if (data) return { root: resolve(data, 'runs'), source: 'CLAUDE_PLUGIN_DATA' };
  return { root: join(homedir(), '.claude-seo-ai', 'runs'), source: 'default' };
}

/** Absolute runs root (see resolveRootInfo). */
export function resolveRoot(args = {}, env = process.env) { return resolveRootInfo(args, env).root; }

// ---------------------------------------------------------------------------
// Keys and ids

const HOST_LIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/i;
const FILE_LIKE = /\.(x?html?|xml|json|txt|md|mjs|cjs|js|css|gz)$/i;

/** True for http(s) URLs. */
export function isHttpUrl(s) { return /^https?:\/\//i.test(String(s || '').trim()); }

/** True when `s` reads like a bare hostname (example.com, localhost:3000) rather than a path. */
export function looksLikeHost(s) {
  const v = String(s || '').trim();
  return HOST_LIKE.test(v) && !FILE_LIKE.test(v) && !existsSync(v);
}

function localKey(p) {
  const abs = resolve(String(p));
  let real = abs;
  try { real = realpathSync(abs); } catch { /* not on disk yet — key on the absolute path */ }
  const name = (basename(real) || 'root').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'root';
  return 'local/' + name + '-' + sha1(real).slice(0, 8);
}

/**
 * Storage key for a target: lower-cased host with ':' → '_' for URLs / bare hosts;
 * 'local/<basename>-<sha1[:8]>' for filesystem paths and file:// URLs.
 */
export function hostKey(target) {
  const s = String(target || '').trim();
  if (!s) return 'local/root-' + sha1('').slice(0, 8);
  if (isHttpUrl(s)) {
    try { return new URL(s).host.toLowerCase().replace(/:/g, '_'); } catch { /* fall through to local */ }
  }
  if (/^file:\/\//i.test(s)) {
    try { return localKey(fileURLToPath(s)); } catch { return localKey(s.replace(/^file:\/\//i, '')); }
  }
  if (looksLikeHost(s)) return s.toLowerCase().replace(/:/g, '_');
  return localKey(s);
}

/** Retention budget for a host key (gap-analysis hosts keep fewer runs). */
export function keepFor(hostKeyValue) { return /^_gap(\/|$)/.test(String(hostKeyValue || '')) ? DEFAULT_KEEP.gap : DEFAULT_KEEP.default; }

/** UTC run id 'YYYY-MM-DDTHH-mm-ssZ' (filesystem-safe, sorts chronologically). */
export function newRunId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}-${p(date.getUTCMinutes())}-${p(date.getUTCSeconds())}Z`;
}

/** Make a caller-supplied run id safe for the filesystem (never 'latest'/'baseline'). */
export function sanitizeRunId(id) {
  let s = String(id == null ? '' : id).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  if (!s) throw new Error('invalid run id: ' + JSON.stringify(id));
  if (RESERVED_NAMES.has(s.toLowerCase())) throw new Error('run id "' + s + '" is reserved');
  return s;
}

/**
 * Page slug: path with '/' → '_' (≤ maxLen chars, ASCII-safe) + '--' + sha1(url)[:8]. '/' → 'index--<hash>'.
 * Non-URL input is treated as a (relative) file path; a trailing .html/.htm is dropped from the readable part.
 */
export function pageSlug(urlOrPath, { maxLen = 60 } = {}) {
  const s = String(urlOrPath || '').trim();
  let pathPart, hashSource;
  if (isHttpUrl(s)) {
    try { const u = new URL(s); pathPart = safeDecode(u.pathname); hashSource = u.href; }
    catch { pathPart = s; hashSource = s; }
  } else {
    const norm = s.replace(/\\/g, '/').replace(/^\.\//, '');
    pathPart = norm.replace(/\.x?html?$/i, '');
    hashSource = norm;
  }
  let slug = pathPart.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
  slug = slug.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  if (!slug) slug = 'index';
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/[-_.]+$/g, '') || 'page';
  return slug + '--' + sha1(hashSource).slice(0, 8);
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// ---------------------------------------------------------------------------
// Files

/** Write pretty JSON atomically (tmp + rename), creating parent directories. Returns the absolute path. */
export function writeJson(path, obj) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, abs);
  return abs;
}

/** Write text (string or Buffer), creating parent directories. Returns the absolute path. */
export function writeText(path, data) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data == null ? '' : data);
  return abs;
}

/** Parse a JSON file; `fallback` (default null) when missing or invalid. */
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Forward-slash relative path of `abs` inside `runDir` (what snapshots store). */
export function relPath(runDir, abs) { return relative(runDir, abs).split(sep).join('/'); }

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

/** Directory of a host inside the root (host keys may hold one '/' for local targets). */
export function hostDirFor(root, hostKeyValue) { return join(root, ...String(hostKeyValue).split('/')); }

// ---------------------------------------------------------------------------
// index.json

export function readIndex(root) {
  const idx = readJson(join(root, 'index.json'), null);
  if (!idx || typeof idx !== 'object' || !idx.hosts || typeof idx.hosts !== 'object') return { version: INDEX_VERSION, updated_at: null, hosts: {} };
  return idx;
}

export function writeIndex(root, idx) {
  idx.version = INDEX_VERSION;
  idx.updated_at = new Date().toISOString();
  return writeJson(join(root, 'index.json'), idx);
}

/** Read-modify-write one host entry; `fn(hostEntry, index)` mutates in place. Returns the index. */
export function updateIndex(root, hostKeyValue, fn) {
  const idx = readIndex(root);
  const h = idx.hosts[hostKeyValue] || (idx.hosts[hostKeyValue] = { runs: [], latest: null, baseline: null });
  if (!Array.isArray(h.runs)) h.runs = [];
  fn(h, idx);
  h.runs = [...new Set(h.runs)].sort();
  writeIndex(root, idx);
  return idx;
}

export function indexAddRun(root, hostKeyValue, runId, meta = {}) {
  return updateIndex(root, hostKeyValue, (h) => {
    if (!h.runs.includes(runId)) h.runs.push(runId);
    if (meta && meta.target) h.target = String(meta.target);
    if (meta && meta.kind) h.kind = meta.kind;
  });
}

export function indexRemoveRuns(root, hostKeyValue, ids) {
  const gone = new Set(ids || []);
  return updateIndex(root, hostKeyValue, (h) => { h.runs = h.runs.filter((r) => !gone.has(r)); });
}

/** Host keys known to this root: index first, directory scan as a fallback (so a hand-copied tree still resolves). */
export function listHosts(root) {
  const keys = new Set(Object.keys(readIndex(root).hosts));
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === 'local' || e.name.startsWith('_')) {
        for (const sub of readdirSync(join(root, e.name), { withFileTypes: true })) if (sub.isDirectory()) keys.add(e.name + '/' + sub.name);
      } else keys.add(e.name);
    }
  } catch { /* root may not exist yet */ }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Runs

/**
 * Create (or reopen) a run directory with its site/pages/agents subfolders and register it in index.json.
 * @param {{root:string, host?:string, target?:string, runId?:string}} p  host = a hostkey; target = URL/path when host is absent
 */
export function openRun({ root, host, target, runId } = {}) {
  if (!root) throw new Error('openRun: root is required');
  const host_key = host || hostKey(target);
  const host_dir = hostDirFor(root, host_key);
  let run_id;
  if (runId != null && String(runId).trim()) run_id = sanitizeRunId(runId);
  else {
    // a fresh id must never reuse a directory another run started in the same second
    const stamp = newRunId();
    run_id = stamp;
    for (let n = 2; existsSync(join(host_dir, run_id)); n++) run_id = stamp + '-' + n;
  }
  const dir = join(host_dir, run_id);
  const created = !existsSync(dir);
  for (const sub of ['', 'site', 'pages', 'agents']) mkdirSync(join(dir, sub), { recursive: true });
  indexAddRun(root, host_key, run_id, { target, kind: host_key.startsWith('local/') ? 'local' : 'url' });
  return {
    root: resolve(root), host_key, run_id, host_dir, dir, created,
    site_dir: join(dir, 'site'), pages_dir: join(dir, 'pages'), agents_dir: join(dir, 'agents'),
  };
}

/** Root and host key for a host directory (walks up to the directory holding index.json). */
export function locateRoot(hostDir) {
  const abs = resolve(hostDir);
  let cur = dirname(abs);
  for (let i = 0; i < 3; i++) {
    if (isFile(join(cur, 'index.json'))) return { root: cur, hostKey: relPath(cur, abs) };
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const parent = dirname(abs);
  const pName = basename(parent);
  if (pName === 'local' || pName.startsWith('_')) return { root: dirname(parent), hostKey: pName + '/' + basename(abs) };
  return { root: parent, hostKey: basename(abs) };
}

/**
 * Point `latest` at a run: a symlink when the platform allows it (never replaces a real file/dir),
 * plus latest.json which is always written and is what resolveRunRef reads first.
 */
export function setLatest(hostDir, runId) {
  const runDir = join(hostDir, runId);
  const link = join(hostDir, 'latest');
  let symlink = false, symlink_error = null;
  try {
    let st = null;
    try { st = lstatSync(link); } catch { /* absent */ }
    if (st && st.isSymbolicLink()) unlinkSync(link);
    else if (st) throw new Error('"latest" exists and is not a symlink; left untouched');
    if (process.platform === 'win32') symlinkSync(runDir, link, 'junction'); else symlinkSync(runId, link);
    symlink = true;
  } catch (e) { symlink_error = String(e && e.message || e); }
  const latest_json = writeJson(join(hostDir, 'latest.json'), { run: runId, path: runDir, updated_at: new Date().toISOString() });
  try {
    const { root, hostKey: hk } = locateRoot(hostDir);
    updateIndex(root, hk, (h) => { h.latest = runId; if (!h.runs.includes(runId)) h.runs.push(runId); });
  } catch { /* index is a convenience; the pointer file is authoritative */ }
  return { run: runId, path: runDir, latest_json, symlink, symlink_error };
}

/** Mark a run as the comparison baseline (exempt from pruning). */
export function setBaseline(hostDir, runId, meta = {}) {
  const runDir = join(hostDir, runId);
  if (!isDir(runDir)) throw new Error('setBaseline: run not found: ' + runDir);
  const baseline_json = writeJson(join(hostDir, 'baseline.json'), { ...meta, run: runId, path: runDir, set_at: new Date().toISOString() });
  try {
    const { root, hostKey: hk } = locateRoot(hostDir);
    updateIndex(root, hk, (h) => { h.baseline = runId; if (!h.runs.includes(runId)) h.runs.push(runId); });
  } catch { /* see setLatest */ }
  return { run: runId, path: runDir, baseline_json };
}

/** Epoch ms of a timestamp run id (a -n collision suffix adds n ms so same-second siblings keep their order). */
export function runIdTime(id) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?$/.exec(String(id));
  if (!m) return 0;
  const t = Date.parse(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'));
  return Number.isFinite(t) ? t + (m[2] ? Number(m[2]) : 0) : 0;
}

/** Run directories under a host, newest first ({ id, time, dir }). Timestamp ids sort by their time, others by mtime. */
export function listRuns(hostDir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(hostDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isDirectory() || RESERVED_NAMES.has(e.name)) continue;
    const dir = join(hostDir, e.name);
    let time = 0;
    if (RUN_ID_RE.test(e.name)) time = runIdTime(e.name);
    if (!time) { try { time = statSync(dir).mtimeMs; } catch { time = 0; } }
    out.push({ id: e.name, time, dir });
  }
  return out.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

/** Run id the `latest` pointer names (latest.json first, then the symlink, then the newest directory). */
export function latestRunId(hostDir) {
  const pointer = readJson(join(hostDir, 'latest.json'));
  if (pointer && pointer.run && isDir(join(hostDir, pointer.run))) return pointer.run;
  try { const t = readlinkSync(join(hostDir, 'latest')); const id = basename(t); if (isDir(join(hostDir, id))) return id; } catch { /* no symlink */ }
  const runs = listRuns(hostDir);
  return runs.length ? runs[0].id : null;
}

/**
 * Delete old runs beyond `keep`, never touching the runs named by latest.json / baseline.json / the
 * latest symlink / `protectedIds`. Returns { removed[], kept[], protected[] }.
 */
export function prune(hostDir, keep = DEFAULT_KEEP.default, protectedIds = []) {
  const budget = Math.max(0, Math.floor(Number(keep)) || 0);
  const protectedSet = new Set((protectedIds || []).map(String));
  const latest = readJson(join(hostDir, 'latest.json'));
  if (latest && latest.run) protectedSet.add(String(latest.run));
  const baseline = readJson(join(hostDir, 'baseline.json'));
  if (baseline && baseline.run) protectedSet.add(String(baseline.run));
  try { protectedSet.add(basename(readlinkSync(join(hostDir, 'latest')))); } catch { /* no symlink */ }
  const removed = [], kept = [];
  let count = 0;
  for (const r of listRuns(hostDir)) {
    if (protectedSet.has(r.id)) { kept.push(r.id); count++; continue; }
    if (count < budget) { kept.push(r.id); count++; continue; }
    try { rmSync(r.dir, { recursive: true, force: true }); removed.push(r.id); }
    catch { kept.push(r.id); }
  }
  if (removed.length) {
    try { const { root, hostKey: hk } = locateRoot(hostDir); indexRemoveRuns(root, hk, removed); } catch { /* best effort */ }
  }
  return { removed, kept, keep: budget, protected: [...protectedSet] };
}

// ---------------------------------------------------------------------------
// References

function hostKeyLoose(root, hostArg) {
  const hk = hostKey(hostArg);
  if (isDir(hostDirFor(root, hk))) return hk;
  const strip = (k) => k.replace(/^www\./, '');
  const want = strip(hk);
  const hit = listHosts(root).find((k) => strip(k) === want);
  return hit || hk;
}

function pickHost(root, kind) {
  let best = null;
  for (const hk of listHosts(root)) {
    const hostDir = hostDirFor(root, hk);
    const pointer = readJson(join(hostDir, kind + '.json'));
    const runId = pointer && pointer.run ? String(pointer.run) : (kind === 'latest' ? latestRunId(hostDir) : null);
    if (!runId || !isDir(join(hostDir, runId))) continue;
    const stamp = (pointer && (pointer.updated_at || pointer.set_at)) || '';
    const time = Date.parse(stamp) || runIdTime(runId) || 0;
    if (!best || time > best.time) best = { hk, time };
  }
  return best ? best.hk : null;
}

function describeRun(dir, kind, root, hk, ref) {
  const abs = resolve(dir);
  const files = {};
  for (const f of ['report.json', 'report.md', 'findings.json', 'findings.deterministic.json', 'crawl.json', 'profile.json']) {
    if (isFile(join(abs, f))) files[f.replace(/\.(json|md)$/, '').replace(/\./g, '_')] = join(abs, f);
  }
  let pages = 0;
  try { pages = readdirSync(join(abs, 'pages')).filter((n) => n.endsWith('.json')).length; } catch { /* no pages dir */ }
  let hostKeyValue = hk || null;
  if (!hostKeyValue) { try { hostKeyValue = locateRoot(dirname(abs)).hostKey; } catch { hostKeyValue = null; } }
  return { ref, kind, dir: abs, run_id: basename(abs), host_key: hostKeyValue, root: root ? resolve(root) : null, report_json: files.report || null, files, pages_count: pages };
}

/**
 * Resolve a run reference: 'latest', 'latest:<host>', 'baseline', 'baseline:<host>', a run directory,
 * a report.json (or any JSON inside a run dir), or '<hostkey>/<run-id>' relative to `root`. Returns
 * { ref, kind:'latest'|'baseline'|'dir'|'report', dir, run_id, host_key, root, report_json, files, pages_count }
 * or null when nothing matches.
 */
export function resolveRunRef(ref, root) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  const m = /^(latest|baseline)(?::(.+))?$/i.exec(s);
  if (m) {
    if (!root) return null;
    const kind = m[1].toLowerCase();
    const hk = m[2] ? hostKeyLoose(root, m[2].trim()) : pickHost(root, kind);
    if (!hk) return null;
    const hostDir = hostDirFor(root, hk);
    let runId = null;
    if (kind === 'latest') runId = latestRunId(hostDir);
    else { const b = readJson(join(hostDir, 'baseline.json')); runId = b && b.run ? String(b.run) : null; }
    if (!runId) return null;
    const dir = join(hostDir, runId);
    return isDir(dir) ? describeRun(dir, kind, root, hk, s) : null;
  }
  const abs = resolve(s);
  if (isDir(abs)) return describeRun(abs, 'dir', root, null, s);
  if (isFile(abs) && /\.json$/i.test(abs)) {
    const dir = /[\\/]pages[\\/][^\\/]+\.json$/i.test(abs) ? dirname(dirname(abs)) : dirname(abs);
    return describeRun(dir, 'report', root, null, s);
  }
  if (root) {
    const rel = join(root, ...s.split('/'));
    if (isDir(rel)) return describeRun(rel, 'dir', root, null, s);
  }
  return null;
}
