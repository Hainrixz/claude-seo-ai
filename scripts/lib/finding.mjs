// Finding constructor for the deterministic checks. Fills safe defaults, validates against the
// schema and either throws (test mode) or returns { finding, errors } so a caller can drop + warn.
// Also builds absolute, runnable `verification.reproduce` commands.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
 * Build an absolute reproduce command: node "<plugin_root>/scripts/<script>" <args…>.
 * The script path is always double-quoted (plugin roots may contain spaces; the form is greppable).
 * `args` may be an array of tokens or an object of flags ({ url: 'x', deep: true, type: ['A','B'] }).
 */
export function reproduceCommand(scriptName, args = []) {
  const script = scriptName.endsWith('.mjs') ? scriptName : scriptName + '.mjs';
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
  return ['node', '"' + escapeDq(resolve(SCRIPTS_DIR, script)) + '"', ...tokens].join(' ');
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
