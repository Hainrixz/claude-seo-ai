// Finding constructor for the deterministic checks. Fills safe defaults, validates against the
// schema and either throws (test mode) or returns { finding, errors } so a caller can drop + warn.
// Also builds absolute, runnable `verification.reproduce` commands.

import { fileURLToPath } from 'node:url';
import { dirname, posix, resolve, sep as NATIVE_SEP } from 'node:path';
import { validateFinding } from './validate-finding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute plugin root (…/claude-seo-ai), derived from this module's location — never from cwd. */
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
export const SCRIPTS_DIR = resolve(PLUGIN_ROOT, 'scripts');

const UNSCORED_STATUSES = new Set(['not_applicable', 'needs_api', 'manual_review']);

/** True inside a node:test child or when CLAUDE_SEO_AI_STRICT_FINDINGS is set: invalid findings throw. */
export function isTestMode() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.CLAUDE_SEO_AI_STRICT_FINDINGS);
}

const escapeDq = (s) => String(s).replace(/(["\\$`])/g, (m) => '\\' + m);

/** Shell-quote one argument for a reproduce command (POSIX double quotes; safe for paths with spaces). */
export function shellQuote(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(str)) return str;
  return '"' + escapeDq(str) + '"';
}

/**
 * A reproduce command's script path is absolute in POSIX (`/a/b`) or Windows drive (`D:/a/b`) form.
 * Reproduce paths are always written with forward slashes, so this is the one shape to test against.
 */
export const ABSOLUTE_SCRIPT_PATH = /^(?:[A-Za-z]:)?\//;

/**
 * Absolute path to a script under scripts/, written with forward slashes on every platform.
 *
 * Windows reproduce commands used to come out as `node "D:\\a\\repo\\scripts\\x.mjs"`: the POSIX
 * double-quote escaping doubled every separator and the command no longer round-tripped. Node
 * accepts `D:/a/repo/scripts/x.mjs` on Windows just as happily, and one forward-slash form means
 * evidence, tests and docs read the same everywhere.
 *
 * `dir` and `sep` are injectable so the Windows shape can be unit-tested from any platform.
 * @param {string} scriptName  'psi-client', 'audit.mjs' or 'adapters/local-files.mjs'
 */
export function scriptPath(scriptName, { dir = SCRIPTS_DIR, sep = NATIVE_SEP } = {}) {
  const name = String(scriptName);
  const script = name.endsWith('.mjs') ? name : name + '.mjs';
  const base = String(dir).split(sep).join('/').replace(/\/+$/, '');
  // posix.normalize (not resolve — the base may be a Windows drive path) collapses any './' or
  // '../' a caller wrote into the script name, the way resolve() used to. It also eats the leading
  // '//' of a Windows UNC root (\\server\share, a plugin installed on a network share), which would
  // silently repoint an absolute-looking path at '/server/share' — so that prefix is restored.
  const unc = base.startsWith('//');
  const out = posix.normalize(base + '/' + script.split(sep).join('/').replace(/^\/+/, ''));
  return unc && !out.startsWith('//') ? '/' + out : out;
}

/**
 * Rewrite a filesystem path for a reproduce *argument*, the way scriptPath() does for the script.
 *
 * `shellQuote` escapes backslashes (POSIX double-quote rules), so a native Windows path used to
 * reach the reader doubled — `--run-dir "D:\\a\\repo\\runs\\r1"` — and neither cmd.exe nor
 * PowerShell round-trips that back to `D:\a\repo\runs\r1`, so the pasted command pointed at a
 * nonexistent directory. Node's fs accepts `D:/a/repo/runs/r1` on Windows just as happily, so one
 * forward-slash form makes every path in a finding — script, snapshot, run dir, feed, project root
 * — paste-able. Reproduce args that are not paths (URLs, ids, flags) must not go through here.
 *
 * Only the platform separator is rewritten: on POSIX a backslash is a legal filename character and
 * has to survive. `sep` is injectable so the Windows shape can be unit-tested from any platform.
 * @param {string|null|undefined} p
 */
export function reproPath(p, { sep = NATIVE_SEP } = {}) {
  if (p === null || p === undefined) return p;
  const s = String(p);
  return sep === '/' ? s : s.split(sep).join('/');
}

/**
 * Double-quote a reproduce command's script path. Deliberately *not* `shellQuote`: a path is not
 * arbitrary user text, and backslash-escaping it is what mangled Windows paths. Paths that contain
 * a double quote cannot be quoted this way — and a plugin installed under such a path could not be
 * required by any shell either — so that is an error, never a silent mangling.
 */
export function quotePath(p) {
  const str = String(p);
  if (str.includes('"')) throw new Error('reproduce: script path must not contain a double quote: ' + str);
  return '"' + str + '"';
}

/**
 * Build an absolute reproduce command: node "<plugin_root>/scripts/<script>" <args…>.
 * The script path is always double-quoted (plugin roots may contain spaces; the form is greppable)
 * and always forward-slashed (see scriptPath).
 * `args` may be an array of tokens or an object of flags ({ url: 'x', deep: true, type: ['A','B'] }).
 */
export function reproduceCommand(scriptName, args = [], opts = {}) {
  const tokens = [];
  if (Array.isArray(args)) {
    for (const a of args) tokens.push(shellQuote(a));
  } else if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === false) continue;
      const flag = (k.length === 1 ? '-' : '--') + k;
      if (v === true) { tokens.push(flag); continue; }
      for (const item of (Array.isArray(v) ? v : [v])) { tokens.push(flag); tokens.push(shellQuote(item)); }
    }
  }
  return ['node', quotePath(scriptPath(scriptName, opts)), ...tokens].join(' ');
}

function moduleFromId(id) {
  const m = /^(M[0-9]{1,2}[a-z]?)\./.exec(String(id || ''));
  return m ? m[1] : undefined;
}

function magnitudeFromSeverity(sev) {
  if (sev >= 4) return 'high';
  if (sev === 3) return 'medium';
  return 'low';
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
 * Build a finding. Defaults filled when absent (never invented facts, only structural defaults):
 *   module            ← prefix of id
 *   scope             ← 'page'
 *   fixable           ← 'advisory'
 *   severity          ← 0 when status is not_applicable / needs_api / manual_review
 *   evidence          ← { observed } when given as a string
 *   verification.reproduce ← reproduceCommand(reproduce.script, reproduce.args) when `reproduce`
 *                            is given as { script, args } (shorthand, removed from the output)
 *   expected_impact.magnitude ← banded from severity (>=4 high, 3 medium, else low)
 * Options: { mode: 'throw' | 'return' } — default: throw in test mode, return otherwise.
 * @returns {{ finding: object, errors: string[] }}
 */
export function makeFinding(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const { reproduce, ...rest } = src;
  const f = { ...rest };
  if (f.module === undefined) f.module = moduleFromId(f.id);
  if (f.scope === undefined) f.scope = 'page';
  if (f.fixable === undefined) f.fixable = 'advisory';
  if (f.severity === undefined && UNSCORED_STATUSES.has(f.status)) f.severity = 0;
  if (typeof f.evidence === 'string') f.evidence = { observed: f.evidence };
  const shorthand = reproduce && typeof reproduce === 'object' && reproduce.script;
  if (f.verification && typeof f.verification === 'object') {
    f.verification = { ...f.verification };
    if (f.verification.reproduce === undefined && shorthand) f.verification.reproduce = reproduceCommand(reproduce.script, reproduce.args || []);
  } else if (shorthand) {
    f.verification = { reproduce: reproduceCommand(reproduce.script, reproduce.args || []) };
  }
  if (f.expected_impact && typeof f.expected_impact === 'object') {
    f.expected_impact = { ...f.expected_impact };
    if (f.expected_impact.magnitude === undefined && Number.isInteger(f.severity)) f.expected_impact.magnitude = magnitudeFromSeverity(f.severity);
  }
  const finding = stripUndefined(f);
  const { errors } = validateFinding(finding);
  const mode = opts.mode || (isTestMode() ? 'throw' : 'return');
  if (errors.length && mode === 'throw') {
    const err = new Error('invalid finding ' + (finding.id || '(no id)') + ': ' + errors.join('; '));
    err.finding = finding;
    err.errors = errors;
    throw err;
  }
  return { finding, errors };
}
