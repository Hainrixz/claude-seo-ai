// Adapter plumbing shared by every scripts/adapters/*.mjs: the Change record, its status machine,
// the fix-run directory, and the confirmation tickets that gate `apply`/`publish`/`rollback`.
//
// Nothing here writes to a site. A Change is a *description* of one edit — enough for a human to
// read the preview, say yes, and for the writer agent to perform (or undo) exactly that edit.
//
// Layout of a fix run (DATA = resolveDataDir(): --data > $CLAUDE_SEO_AI_HOME > $CLAUDE_PLUGIN_DATA > ~/.claude-seo-ai):
//   <DATA>/fix/runs/<run-id>/plan.json      { version, run, created_at, target, report, profile, changes[] }
//   <DATA>/fix/runs/<run-id>/manifest.json  { version, run, created_at, adapters[], confirmed[], results{}, … }
//   <DATA>/fix/runs/<run-id>/preview/<change-id>.<ext>   rendered preview (diff / payload / command / text)
//   <DATA>/fix/runs/<run-id>/before/<change-id>.json     pre-write state for rollback
//   <DATA>/fix/runs/<run-id>/after/<change-id>.json      post-write state for verification
//   <DATA>/fix/runs/<run-id>/log.ndjson                  append-only audit log (commands redacted)
//   <DATA>/backups/<run-id>/<relpath>                    byte-for-byte copies of edited local files
//   <DATA>/fix/tickets/<sha256(normalized command)>.json { run, change, issued_at, expires_at, one_shot }
//
// Tickets are procedural hardening, not a security boundary: a hook inherits Claude Code's
// environment, so anything the model can read it can also write. The real backstop is Claude Code's
// own Bash permission prompt (see docs: never allow-list `Bash(shopify:*)`, `Bash(wp:*)`, `Bash(ssh:*)`).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readJson, sanitizeRunId, writeJson, writeText, newRunId } from './store.mjs';
import { redact } from './credentials.mjs';

export const PLAN_VERSION = 1;
export const MANIFEST_VERSION = 1;
/** Confirmation tickets live 15 minutes and are consumed on first match. */
export const TICKET_TTL_MS = 15 * 60 * 1000;

export const CHANGE_CLASSES = Object.freeze(['auto', 'proposed']);
export const TARGET_KINDS = Object.freeze(['file', 'theme-file', 'resource', 'option', 'page', 'redirect', 'manual']);
export const CHANGE_OPS = Object.freeze(['insert', 'replace', 'create', 'remove', 'update-fields', 'create-redirect', 'instruction']);
export const PREVIEW_KINDS = Object.freeze(['diff', 'payload', 'command', 'text']);
export const LIVE_IMPACTS = Object.freeze(['none', 'staged', 'live']);
export const ROLLBACK_KINDS = Object.freeze(['restore-file', 'delete-theme', 'republish-theme', 'restore-fields', 'delete-redirect', 'none']);
export const CHANGE_STATUSES = Object.freeze([
  'planned', 'previewed', 'confirmed', 'applied', 'verified', 'pending_cache',
  'failed', 'rolled_back', 'skipped_idempotent', 'skipped_unready',
]);

/**
 * Allowed status moves. A change never goes backwards: once it is `applied` the only ways out are
 * verification, a cache wait, a failure or a rollback — so a manifest can be replayed honestly.
 */
export const STATUS_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['previewed', 'confirmed', 'failed', 'skipped_idempotent', 'skipped_unready']),
  previewed: Object.freeze(['confirmed', 'failed', 'skipped_idempotent', 'skipped_unready']),
  confirmed: Object.freeze(['applied', 'failed', 'skipped_idempotent', 'skipped_unready']),
  applied: Object.freeze(['verified', 'pending_cache', 'failed', 'rolled_back']),
  pending_cache: Object.freeze(['verified', 'failed', 'rolled_back']),
  verified: Object.freeze(['rolled_back']),
  failed: Object.freeze([]),
  rolled_back: Object.freeze([]),
  skipped_idempotent: Object.freeze([]),
  skipped_unready: Object.freeze([]),
});

/** Statuses that mean "this change will not move again". */
export const TERMINAL_STATUSES = Object.freeze(['failed', 'rolled_back', 'skipped_idempotent', 'skipped_unready']);

const sha1hex = (s) => createHash('sha1').update(String(s)).digest('hex');
const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Stable JSON (recursively sorted keys) so a hash of the same logical value is always the same string. */
export function canonicalJson(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v === undefined ? null : v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Deterministic change id: `chg_` + first 12 hex of sha1 over the identity of the edit
 * (adapter, op, target, sorted finding ids, payload). Two planners that describe the same edit
 * produce the same id — that is what makes `apply` idempotent across runs.
 */
export function changeId(seed) {
  const s = seed && typeof seed === 'object' ? seed : { seed: String(seed) };
  const identity = {
    adapter: s.adapter || null,
    op: s.op || null,
    target: s.target ? { kind: s.target.kind || null, locator: s.target.locator || null, url: s.target.url || null } : null,
    finding_ids: Array.isArray(s.finding_ids) ? [...s.finding_ids].map(String).sort() : [],
    strategy: s.strategy || null,
    payload: s.payload === undefined ? null : s.payload,
  };
  return 'chg_' + sha1hex(canonicalJson(identity)).slice(0, 12);
}

/** True inside a node:test child or when CLAUDE_SEO_AI_STRICT_FINDINGS is set: invalid changes throw. */
export function isStrictMode() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.CLAUDE_SEO_AI_STRICT_FINDINGS);
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validate a Change against the adapter contract.
 * `phase` controls how much must already be filled in: 'plan' (default) tolerates a missing preview;
 * every later phase requires one, because a change is never confirmed without something to read.
 * @returns {string[]} human-readable errors ([] when valid)
 */
export function validateChange(change, { phase = 'plan' } = {}) {
  const errors = [];
  const c = change;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['change must be an object'];
  if (!/^chg_[0-9a-f]{12}$/.test(String(c.id || ''))) errors.push('id must match chg_<12 hex>');
  if (!isStringArray(c.finding_ids)) errors.push('finding_ids must be an array of strings');
  if (!isNonEmptyString(c.adapter)) errors.push('adapter is required');
  if (!CHANGE_CLASSES.includes(c.class)) errors.push('class must be one of ' + CHANGE_CLASSES.join('|'));
  if (!c.target || typeof c.target !== 'object') errors.push('target is required');
  else {
    if (!TARGET_KINDS.includes(c.target.kind)) errors.push('target.kind must be one of ' + TARGET_KINDS.join('|'));
    if (!isNonEmptyString(c.target.locator)) errors.push('target.locator is required');
    if (c.target.url !== undefined && !isNonEmptyString(c.target.url)) errors.push('target.url must be a non-empty string when present');
    if (c.target.project_root !== undefined && !isNonEmptyString(c.target.project_root)) errors.push('target.project_root must be a non-empty string when present');
  }
  if (!CHANGE_OPS.includes(c.op)) errors.push('op must be one of ' + CHANGE_OPS.join('|'));
  if (c.strategy !== undefined && !isNonEmptyString(c.strategy)) errors.push('strategy must be a non-empty string when present');
  if (c.preview === undefined) {
    if (phase !== 'plan') errors.push('preview is required from the preview phase on');
  } else if (!c.preview || typeof c.preview !== 'object') errors.push('preview must be an object');
  else {
    if (!PREVIEW_KINDS.includes(c.preview.kind)) errors.push('preview.kind must be one of ' + PREVIEW_KINDS.join('|'));
    if (typeof c.preview.body !== 'string') errors.push('preview.body must be a string');
  }
  if (!c.requires || typeof c.requires !== 'object') errors.push('requires is required');
  else {
    if (!isStringArray(c.requires.credentials)) errors.push('requires.credentials must be an array of key names');
    if (!isStringArray(c.requires.tools)) errors.push('requires.tools must be an array of tool names');
    if (c.requires.scopes !== undefined && !isStringArray(c.requires.scopes)) errors.push('requires.scopes must be an array of strings when present');
  }
  if (!LIVE_IMPACTS.includes(c.live_impact)) errors.push('live_impact must be one of ' + LIVE_IMPACTS.join('|'));
  if (!c.verify || typeof c.verify !== 'object') errors.push('verify is required');
  else {
    if (!isNonEmptyString(c.verify.method)) errors.push('verify.method is required');
    if (!isNonEmptyString(c.verify.assertion)) errors.push('verify.assertion is required');
  }
  if (!c.rollback || typeof c.rollback !== 'object') errors.push('rollback is required');
  else if (!ROLLBACK_KINDS.includes(c.rollback.kind)) errors.push('rollback.kind must be one of ' + ROLLBACK_KINDS.join('|'));
  if (!CHANGE_STATUSES.includes(c.status)) errors.push('status must be one of ' + CHANGE_STATUSES.join('|'));
  if (c.error !== undefined && c.error !== null && !isNonEmptyString(c.error)) errors.push('error must be a non-empty string or null');
  return errors;
}

function stripUndefined(obj) {
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return obj;
}

/**
 * Build a Change. Structural defaults only — nothing about the site is invented:
 *   id          ← changeId({adapter, op, target, finding_ids, strategy, payload})
 *   class       ← 'proposed'  (the safe side: an adapter must *opt in* to 'auto')
 *   status      ← 'planned'
 *   live_impact ← 'none'
 *   requires    ← { credentials: [], tools: [] }
 *   rollback    ← { kind: 'none' }
 *   finding_ids ← []
 * Options: { mode: 'throw' | 'return' } (default: throw under node:test), { phase } for validation.
 * @returns {{ change: object, errors: string[] }}
 */
export function makeChange(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const c = { ...src };
  if (c.finding_ids === undefined) c.finding_ids = [];
  else if (typeof c.finding_ids === 'string') c.finding_ids = [c.finding_ids];
  if (c.class === undefined) c.class = 'proposed';
  if (c.status === undefined) c.status = 'planned';
  if (c.live_impact === undefined) c.live_impact = 'none';
  if (c.requires === undefined) c.requires = { credentials: [], tools: [] };
  else {
    c.requires = { credentials: [], tools: [], ...c.requires };
  }
  if (c.rollback === undefined) c.rollback = { kind: 'none' };
  if (c.target && typeof c.target === 'object') c.target = { ...c.target };
  if (c.id === undefined) c.id = changeId(c);
  const change = stripUndefined(c);
  const errors = validateChange(change, { phase: opts.phase || 'plan' });
  const mode = opts.mode || (isStrictMode() ? 'throw' : 'return');
  if (errors.length && mode === 'throw') {
    const err = new Error('invalid change ' + (change.id || '(no id)') + ': ' + errors.join('; '));
    err.change = change;
    err.errors = errors;
    throw err;
  }
  return { change, errors };
}

/** Is `to` reachable from `from`? (Same status is always allowed — re-running an op is not a move.) */
export function canTransition(from, to) {
  if (from === to) return CHANGE_STATUSES.includes(from);
  const allowed = STATUS_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

/**
 * Return a copy of `change` moved to `status`, merging `extra` (e.g. { error }).
 * Throws on an illegal move: silently accepting one would let a manifest claim a write happened.
 */
export function transition(change, status, extra = {}) {
  const from = change && change.status;
  if (!CHANGE_STATUSES.includes(status)) throw new Error('unknown change status: ' + status);
  if (!canTransition(from, status)) throw new Error('illegal status transition ' + from + ' -> ' + status + ' for ' + (change && change.id));
  const next = { ...change, ...extra, status };
  // a stale error from an earlier attempt must not travel with a change that has since succeeded
  if (status !== 'failed' && extra.error === undefined) delete next.error;
  return next;
}

/**
 * Move a change to `confirmed` when it is not there yet. `apply` calls this because the ticket it
 * consumed *is* the user's confirmation; a change that can no longer be confirmed (already applied,
 * rolled back, skipped) throws rather than being quietly re-applied.
 */
export function ensureConfirmed(change) {
  if (change && change.status === 'confirmed') return change;
  if (canTransition(change && change.status, 'confirmed')) return transition(change, 'confirmed');
  throw new Error('change ' + (change && change.id) + ' cannot be confirmed from status "' + (change && change.status) + '"');
}

// ---------------------------------------------------------------------------
// Data dir + fix run

/**
 * Where fix state lives: --data > $CLAUDE_SEO_AI_HOME > $CLAUDE_PLUGIN_DATA > ~/.claude-seo-ai.
 * (`lib/store.mjs` resolves the *runs* root the same way, one level deeper.)
 * @returns {{dir: string, source: string}}
 */
export function resolveDataDirInfo(args = {}, env = process.env) {
  const flag = args && typeof args.data === 'string' && args.data.trim() ? args.data.trim() : null;
  if (flag) return { dir: resolve(flag), source: '--data' };
  const home = env && typeof env.CLAUDE_SEO_AI_HOME === 'string' ? env.CLAUDE_SEO_AI_HOME.trim() : '';
  if (home) return { dir: resolve(home), source: 'CLAUDE_SEO_AI_HOME' };
  const data = env && typeof env.CLAUDE_PLUGIN_DATA === 'string' ? env.CLAUDE_PLUGIN_DATA.trim() : '';
  if (data) return { dir: resolve(data), source: 'CLAUDE_PLUGIN_DATA' };
  return { dir: join(homedir(), '.claude-seo-ai'), source: 'default' };
}

/** Absolute data dir (see resolveDataDirInfo). */
export function resolveDataDir(args = {}, env = process.env) { return resolveDataDirInfo(args, env).dir; }

/** `<DATA>/fix` */
export function fixRoot(dataDir) { return join(resolve(dataDir), 'fix'); }
/** `<DATA>/fix/runs/<id>` */
export function fixRunDir(dataDir, id) { return join(fixRoot(dataDir), 'runs', sanitizeRunId(id)); }
/** `<DATA>/fix/tickets` */
export function ticketsDir(dataDir) { return join(fixRoot(dataDir), 'tickets'); }
/** `<DATA>/backups/<run>` */
export function backupsDir(dataDir, runId) { return join(resolve(dataDir), 'backups', sanitizeRunId(runId)); }

/** Reject '..', absolute paths and NUL in a relative path used to build a backup/preview name. */
export function safeRelPath(relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  if (!raw.trim()) throw new Error('empty relative path');
  if (raw.includes('\0')) throw new Error('relative path contains a NUL byte');
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) throw new Error('relative path must not be absolute: ' + raw);
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error('relative path must not escape with "..": ' + raw);
    parts.push(seg);
  }
  if (!parts.length) throw new Error('relative path resolves to nothing: ' + raw);
  return parts.join('/');
}

const changeFileName = (id, ext) => {
  const safe = String(id || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'change';
  return safe + (ext ? (ext.startsWith('.') ? ext : '.' + ext) : '');
};

function fixRunHandle(dir, dataDir, id) {
  const paths = {
    dir,
    plan: join(dir, 'plan.json'),
    manifest: join(dir, 'manifest.json'),
    preview_dir: join(dir, 'preview'),
    before_dir: join(dir, 'before'),
    after_dir: join(dir, 'after'),
    log: join(dir, 'log.ndjson'),
    backups: backupsDir(dataDir, id),
  };
  const handle = {
    id,
    dir,
    data_dir: resolve(dataDir),
    paths,
    readPlan: () => readJson(paths.plan, null),
    readManifest: () => readJson(paths.manifest, null),
    writePlan(plan) { return writeJson(paths.plan, plan); },
    writeManifest(manifest) { return writeJson(paths.manifest, manifest); },
    /** Replace plan.changes, keeping the rest of plan.json intact. */
    setChanges(changes) {
      const plan = handle.readPlan() || { version: PLAN_VERSION, run: id, created_at: new Date().toISOString(), changes: [] };
      plan.changes = Array.isArray(changes) ? changes : [];
      plan.updated_at = new Date().toISOString();
      return writeJson(paths.plan, plan);
    },
    updateManifest(fn) {
      const manifest = handle.readManifest() || { version: MANIFEST_VERSION, run: id };
      const next = fn(manifest) || manifest;
      next.updated_at = new Date().toISOString();
      return writeJson(paths.manifest, next);
    },
    previewPath: (changeIdValue, ext = '.txt') => join(paths.preview_dir, changeFileName(changeIdValue, ext)),
    beforePath: (changeIdValue, ext = '.json') => join(paths.before_dir, changeFileName(changeIdValue, ext)),
    afterPath: (changeIdValue, ext = '.json') => join(paths.after_dir, changeFileName(changeIdValue, ext)),
    backupPath: (relPath) => join(paths.backups, ...safeRelPath(relPath).split('/')),
    /** Append one redacted NDJSON event. Never throws — an unwritable log must not abort a fix. */
    log(event) {
      const rec = { ts: new Date().toISOString(), run: id, ...(event && typeof event === 'object' ? event : { message: String(event) }) };
      if (typeof rec.command === 'string') rec.command = redactCommand(rec.command);
      try {
        mkdirSync(dirname(paths.log), { recursive: true });
        appendFileSync(paths.log, JSON.stringify(rec) + '\n');
      } catch { /* logging is best effort */ }
      return rec;
    },
    readLog() {
      try {
        return readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      } catch { return []; }
    },
  };
  return handle;
}

/**
 * Create (or reopen) a fix run directory and seed plan.json + manifest.json.
 * `report` / `profile` are paths to the report and platform profile the plan was built from — the
 * manifest records them so a later `verify`/`rollback` can prove which audit produced the change.
 * @returns handle: { id, dir, paths, readPlan, setChanges, updateManifest, previewPath, backupPath, log, … }
 */
export function openFixRun(dataDir, { report = null, profile = null, id = null, target = null, adapters = [], now = new Date(), meta = {} } = {}) {
  const base = resolve(dataDir);
  const runId = id ? sanitizeRunId(id) : uniqueRunId(base, now);
  const dir = fixRunDir(base, runId);
  for (const sub of ['', 'preview', 'before', 'after']) mkdirSync(join(dir, sub), { recursive: true });
  const handle = fixRunHandle(dir, base, runId);
  const created_at = (now instanceof Date ? now : new Date(now)).toISOString();
  if (!existsSync(handle.paths.plan)) {
    handle.writePlan({ version: PLAN_VERSION, run: runId, created_at, target, report, profile, changes: [] });
  }
  if (!existsSync(handle.paths.manifest)) {
    handle.writeManifest({
      version: MANIFEST_VERSION, run: runId, created_at, target,
      report, profile, adapters: [...adapters], confirmed: [], results: {}, ...meta,
    });
  }
  if (!existsSync(handle.paths.log)) writeText(handle.paths.log, '');
  return handle;
}

function uniqueRunId(dataDir, now) {
  const stamp = newRunId(now instanceof Date ? now : new Date(now));
  let candidate = stamp;
  for (let n = 2; existsSync(fixRunDir(dataDir, candidate)); n++) candidate = stamp + '-' + n;
  return candidate;
}

const looksLikePath = (raw) => raw.includes('/') || raw.includes(sep) || raw === '.' || raw === '..' || isAbsolute(raw);

/**
 * Reopen an existing run. `ref` is either a directory (what adapters get as `--run <fix-run-dir>`)
 * or the bare run id that fix-plan prints — resolved under <DATA>/fix/runs/<id>, so the two forms
 * the fix flow hands around are interchangeable.
 *
 * The data dir is derived from the layout (<DATA>/fix/runs/<id>) unless `dataDir` is given; an id
 * without a `dataDir` falls back to the usual resolution ($CLAUDE_SEO_AI_HOME > … > ~/.claude-seo-ai).
 */
export function loadFixRun(ref, { dataDir = null } = {}) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) throw new Error('loadFixRun needs a fix run id or directory');
  const tried = [];
  if (!looksLikePath(raw)) {
    const base = resolve(dataDir || resolveDataDir({}));
    let byId = null;
    try { byId = fixRunDir(base, raw); } catch { /* not a usable run id — fall through to the path form */ }
    if (byId) {
      if (existsSync(byId) && statSync(byId).isDirectory()) return fixRunHandle(byId, base, byId.split(sep).filter(Boolean).pop());
      tried.push(byId);
    }
  }
  const dir = resolve(raw);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    const id = dir.split(sep).filter(Boolean).pop();
    const base = dataDir ? resolve(dataDir) : resolve(dir, '..', '..', '..');
    return fixRunHandle(dir, base, id);
  }
  tried.push(dir);
  throw new Error('fix run not found: ' + raw + ' (looked in ' + tried.join(', ') + ')');
}

/** Every run id under <DATA>/fix/runs, newest first. */
export function listFixRuns(dataDir) {
  const dir = join(fixRoot(dataDir), 'runs');
  try { return readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } }).sort().reverse(); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// Manifest bookkeeping

/** Ops that touch the site (or a staging copy of it): after one of these the run is no longer a dry run. */
export const WRITE_OPS = Object.freeze(['apply', 'publish', 'rollback']);

/** Statuses that mean the write actually landed. */
const APPLIED_STATUSES = new Set(['applied', 'verified', 'pending_cache']);

/** manifest key that records when an op last ran. */
const OP_TIMESTAMP_KEY = Object.freeze({
  plan: 'planned_at', preview: 'previewed_at', apply: 'applied_at',
  verify: 'verified_at', rollback: 'rolled_back_at', publish: 'published_at',
});

/**
 * Record the outcome of one adapter op in manifest.json — the single place every adapter's
 * apply/rollback/publish reports through, so the manifest never keeps claiming `dry_run: true`
 * after something was written.
 *
 * What it maintains: `dry_run` (false once a write op actually landed), the `applied` /
 * `rolled_back` / `failed` id lists, a per-change `results` map ({status, op, adapter, at, error})
 * and `last_op` + a `<op>_at` timestamp.
 *
 * `wrote` overrides the derivation for ops with no changes of their own (a theme `publish`).
 * Nothing is invented: a change only enters `applied` when its own status says so.
 *
 * @param {object|null} run     fix-run handle (openFixRun/loadFixRun); null is a no-op
 * @param {object} outcome { op, adapter, changes: [{id,status,error}], wrote, now }
 * @returns {object|null} the manifest as written
 */
export function updateManifest(run, { op, adapter = null, changes = [], wrote = undefined, now = new Date() } = {}) {
  if (!run || typeof run.updateManifest !== 'function') return null;
  const opName = String(op || '').trim() || 'op';
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.id) : [];
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const landed = list.some((c) => APPLIED_STATUSES.has(c.status) || c.status === 'rolled_back');
  const touched = wrote === undefined ? (WRITE_OPS.includes(opName) && landed) : !!wrote;

  return run.updateManifest((m) => {
    const next = { ...m };
    if (touched) next.dry_run = false;
    const applied = new Set(Array.isArray(next.applied) ? next.applied : []);
    const rolledBack = new Set(Array.isArray(next.rolled_back) ? next.rolled_back : []);
    const failed = new Set(Array.isArray(next.failed) ? next.failed : []);
    const results = { ...(next.results && typeof next.results === 'object' ? next.results : {}) };
    for (const c of list) {
      const id = String(c.id);
      if (APPLIED_STATUSES.has(c.status)) { applied.add(id); rolledBack.delete(id); failed.delete(id); }
      else if (c.status === 'rolled_back') { rolledBack.add(id); applied.delete(id); }
      else if (c.status === 'failed') { failed.add(id); applied.delete(id); }
      results[id] = {
        status: c.status || null, op: opName, adapter: adapter || c.adapter || null, at,
        ...(c.error ? { error: String(c.error) } : {}),
      };
    }
    next.applied = [...applied];
    next.rolled_back = [...rolledBack];
    next.failed = [...failed];
    next.results = results;
    next.last_op = { op: opName, adapter, at, changes: list.length, wrote: touched };
    next[OP_TIMESTAMP_KEY[opName] || opName + '_at'] = at;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Tickets

/**
 * Canonical form of a command for ticket hashing: CRLF → LF, runs of whitespace → one space, trimmed.
 * Nothing else is normalized — a different flag order is a different command, on purpose.
 */
export function normalizeCommand(command) {
  return String(command == null ? '' : command).replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** sha256 of the normalized command — the ticket's file name. */
export function ticketId(command) { return sha256hex(normalizeCommand(command)); }

/** `<DATA>/fix/tickets/<sha256>.json` */
export function ticketPath(dataDir, command) { return join(ticketsDir(dataDir), ticketId(command) + '.json'); }

/** Same file, addressed by the id a caller already holds (64 hex characters). */
export function ticketPathById(dataDir, id) {
  const clean = String(id || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('not a ticket id (expected 64 hex characters): ' + JSON.stringify(id));
  return join(ticketsDir(dataDir), clean + '.json');
}

/** True when `value` is a ticket id rather than a command string. */
export function isTicketId(value) { return /^[0-9a-f]{64}$/.test(String(value || '').trim().toLowerCase()); }

/**
 * Issue a confirmation ticket for one exact command. Called by the `fix` flow only after the user
 * has confirmed that change in their own turn.
 * @returns {{id, path, ticket}}
 */
export function issueTicket(dataDir, { command, run = null, change = null, ttlMs = TICKET_TTL_MS, now = Date.now(), one_shot = true } = {}) {
  const normalized = normalizeCommand(command);
  if (!normalized) throw new Error('issueTicket: command is required');
  const issuedMs = now instanceof Date ? now.getTime() : Number(now);
  const ticket = {
    run: run || null,
    change: change || null,
    issued_at: new Date(issuedMs).toISOString(),
    expires_at: new Date(issuedMs + Math.max(0, Number(ttlMs) || 0)).toISOString(),
    one_shot: one_shot !== false,
    command_sha256: ticketId(normalized),
    command_preview: redactCommand(normalized).slice(0, 300),
  };
  const path = ticketPath(dataDir, normalized);
  writeJson(path, ticket);
  return { id: ticket.command_sha256, path, ticket };
}

/**
 * Look up the ticket for `command` without consuming it.
 * @returns {{ok, reason, ticket, id, path}} reason: null | 'missing' | 'malformed' | 'expired'
 */
export function checkTicket(dataDir, command, { now = Date.now() } = {}) {
  const id = ticketId(command);
  const path = ticketPath(dataDir, command);
  const ticket = readJson(path, null);
  if (!ticket || typeof ticket !== 'object') return { ok: false, reason: 'missing', ticket: null, id, path };
  const expires = Date.parse(ticket.expires_at);
  if (!Number.isFinite(expires)) return { ok: false, reason: 'malformed', ticket, id, path };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (nowMs > expires) return { ok: false, reason: 'expired', ticket, id, path };
  return { ok: true, reason: null, ticket, id, path };
}

/**
 * Consume the ticket for `command`: valid one-shot tickets are deleted, reusable ones get a `uses`
 * counter. An expired ticket is removed too, so a stale file never lingers.
 * @returns {{ok, reason, ticket, id, path}}
 */
export function consumeTicket(dataDir, command, { now = Date.now() } = {}) {
  const found = checkTicket(dataDir, command, { now });
  if (!found.ok) {
    if (found.reason === 'expired' || found.reason === 'malformed') { try { rmSync(found.path, { force: true }); } catch { /* best effort */ } }
    return found;
  }
  const ticket = found.ticket;
  if (ticket.one_shot !== false) {
    try { rmSync(found.path, { force: true }); } catch { /* best effort */ }
  } else {
    ticket.uses = (Number(ticket.uses) || 0) + 1;
    ticket.last_used_at = new Date(now instanceof Date ? now.getTime() : Number(now)).toISOString();
    writeJson(found.path, ticket);
  }
  return { ok: true, reason: null, ticket, id: found.id, path: found.path };
}

/**
 * Gate an `apply`/`publish`/`rollback` on a ticket the `fix` flow issued after the user confirmed.
 *
 * `ticket` may be the ticket id (64 hex) or the exact command string that was confirmed. The ticket
 * must also be bound to this run and, when it names one, to this change — a ticket for one change
 * must never unlock a different one.
 *
 * @returns {{ok, reason, ticket}} reason: null | 'no-ticket' | 'missing' | 'expired' | 'malformed' |
 *          'wrong-run' | 'wrong-change'
 */
export function requireTicket(dataDir, { ticket, run = null, change = null, now = Date.now(), consume = true } = {}) {
  const raw = ticket === undefined || ticket === null ? '' : String(ticket).trim();
  if (!raw) return { ok: false, reason: 'no-ticket', ticket: null };
  const path = isTicketId(raw) ? ticketPathById(dataDir, raw) : ticketPath(dataDir, raw);
  const found = readJson(path, null);
  if (!found || typeof found !== 'object') return { ok: false, reason: 'missing', ticket: null };
  const expires = Date.parse(found.expires_at);
  if (!Number.isFinite(expires)) { try { rmSync(path, { force: true }); } catch { /* best effort */ } return { ok: false, reason: 'malformed', ticket: found }; }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (nowMs > expires) { try { rmSync(path, { force: true }); } catch { /* best effort */ } return { ok: false, reason: 'expired', ticket: found }; }
  if (found.run && run && String(found.run) !== String(run)) return { ok: false, reason: 'wrong-run', ticket: found };
  if (found.change && change && String(found.change) !== String(change)) return { ok: false, reason: 'wrong-change', ticket: found };
  if (consume) {
    if (found.one_shot !== false) { try { rmSync(path, { force: true }); } catch { /* best effort */ } }
    else {
      found.uses = (Number(found.uses) || 0) + 1;
      found.last_used_at = new Date(nowMs).toISOString();
      writeJson(path, found);
    }
  }
  return { ok: true, reason: null, ticket: found };
}

/** Delete expired ticket files. Returns the number removed. */
export function pruneTickets(dataDir, { now = Date.now() } = {}) {
  const dir = ticketsDir(dataDir);
  let removed = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    const t = readJson(p, null);
    const expires = t ? Date.parse(t.expires_at) : NaN;
    if (!Number.isFinite(expires) || nowMs > expires) { try { rmSync(p, { force: true }); removed++; } catch { /* best effort */ } }
  }
  return removed;
}

const SECRET_FLAGS = /(--?(?:[a-z0-9]+[-_])*(?:password|passwd|pass|token|api[-_]?key|secret|auth|access[-_]?token|bearer)[= ])(("[^"]*")|('[^']*')|(\S+))/gi;
const SECRET_HEADERS = /((?:authorization|x-shopify-access-token|x-api-key|x-auth-token)\s*:\s*)([^"'\\\s][^"'\\]*)/gi;
const BASIC_AUTH_URL = /(\bhttps?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
// `curl -u user:app_password` / `--user`, the exact shape the WordPress REST docs use.
const BASIC_AUTH_FLAG = /(^|\s)(-u|-U|--user|--proxy-user)([= ])((?:"[^"]*")|(?:'[^']*')|(?:\S+))/gi;
const INLINE_ENV = /\b([A-Z][A-Z0-9_]{2,})=((?:"[^"]*")|(?:'[^']*')|(?:\S+))/g;

/**
 * Redact a command before it reaches a log, a preview or the transcript.
 * Two layers: exact values of known credential keys present in the environment (lib/credentials.mjs)
 * and shape-based masking of flags, headers, inline `KEY=value` prefixes and basic-auth URLs.
 * Redaction is best effort — the real rule is that secrets never go in argv in the first place.
 */
export function redactCommand(command, { env = process.env, extra = [] } = {}) {
  let s = redact(String(command == null ? '' : command), { env, extra });
  s = s.replace(BASIC_AUTH_URL, (_m, scheme, user) => scheme + user + ':[redacted]@');
  s = s.replace(BASIC_AUTH_FLAG, (m, lead, flag, sep, value) => {
    const q = /^["']/.test(value) ? value[0] : '';
    const bare = q ? value.slice(1, -1) : value;
    const at = bare.indexOf(':');
    // No colon means no password on the command line (curl prompts for it) — nothing to hide.
    if (at === -1) return m;
    return lead + flag + sep + q + bare.slice(0, at) + ':[redacted]' + q;
  });
  s = s.replace(SECRET_FLAGS, (_m, flag) => flag + '[redacted]');
  s = s.replace(SECRET_HEADERS, (_m, head) => head + '[redacted]');
  s = s.replace(INLINE_ENV, (m, key, value) => (/(TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL)/.test(key) ? key + '=[redacted]' : m));
  return s;
}
