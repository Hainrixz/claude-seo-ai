#!/usr/bin/env node
// instructions adapter — the fallback that always works, and the only one for closed platforms.
//
//   node scripts/adapters/instructions.mjs <op> --run <fix-run-dir> [--change <id>] [--lang en|es] [--json]
//   ops: capabilities | plan | preview | apply | verify | rollback
//
// It writes nothing anywhere. It turns findings into a click-path the user can follow in their own
// admin, in English or Spanish, with the exact values already filled in — the title text, the
// JSON-LD block, the robots lines — taken verbatim from the finding, never invented. The click path
// itself comes from section 11 ("Manual paths (EN / ES)") of the platform knowledge card the
// detector matched, so what the user reads is the same source of truth the audit used.
//
// `apply` marks the change "applied (handed to the user)" and says so: this adapter cannot observe
// whether the user did it, and `verify` returns a manual_review result rather than a pass.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  canTransition, changeId, ensureConfirmed, loadFixRun, makeChange, openFixRun, resolveDataDir, transition,
  updateManifest,
} from '../lib/adapter.mjs';
import { PLUGIN_ROOT, reproduceCommand } from '../lib/finding.mjs';
import { readJson, writeText } from '../lib/store.mjs';
import { logOpEvent, opThrew } from './_shared.mjs';

export const ADAPTER = 'instructions';
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback'];

/** references/platforms/<id>.md */
export const CARDS_DIR = resolve(PLUGIN_ROOT, 'references', 'platforms');

/**
 * Normalize a card reference to a bare id. `detect-platform` writes profile.cards as repo paths
 * ("references/platforms/shopify.md"), while callers and fixtures pass bare ids ("shopify") — both
 * have to land on the same file, so take the basename, drop a trailing `.md`, then filter.
 */
export function cardIdOf(ref) {
  const base = String(ref == null ? '' : ref).trim().split(/[\\/]/).pop().replace(/\.md$/i, '');
  return base.replace(/[^a-z0-9._-]/gi, '');
}

/** Read a platform knowledge card by id (or by the path shape a profile stores). */
export function readCard(id) {
  const safe = cardIdOf(id);
  if (!safe) return null;
  const path = join(CARDS_DIR, safe + '.md');
  try { return existsSync(path) ? { id: safe, path, text: readFileSync(path, 'utf8') } : null; }
  catch { return null; }
}

/**
 * Parse section 11 ("Manual paths (EN / ES)") of a card into [{label, en, es}].
 * Bullets come in two shapes, both used by the cards:
 *   `- SEO title & description — EN: Admin → … ES: Panel → …`
 *   `- EN: open the route file … ES: abre el archivo …`
 */
export function parseManualPaths(cardText) {
  const text = String(cardText || '');
  // Split on the '## ' headings rather than using a lookahead: JavaScript has no \Z, and a
  // hand-rolled end-of-section pattern is exactly the kind of thing that silently truncates.
  const section = text.split(/^##[ \t]+/m).find((chunk) => /^11\./.test(chunk.trim()));
  if (!section) return [];
  const body = section.replace(/^[ \t]*11\.[^\n]*\n/, '');
  const bullets = [];
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line)) {
      if (current) bullets.push(current);
      current = line.replace(/^\s*-\s+/, '').trim();
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ' ' + line.trim();
    } else if (/^\s*$/.test(line)) {
      if (current) { bullets.push(current); current = null; }
    }
  }
  if (current) bullets.push(current);

  return bullets.map((raw) => {
    const enAt = raw.search(/\bEN:\s/);
    const esAt = raw.search(/\bES:\s/);
    if (enAt === -1 && esAt === -1) return { label: raw.trim(), en: raw.trim(), es: raw.trim() };
    const labelRaw = enAt > 0 ? raw.slice(0, enAt) : '';
    const label = labelRaw.replace(/[\s—–-]+$/, '').trim() || null;
    const en = enAt === -1 ? null : raw.slice(enAt + 3, esAt === -1 ? undefined : esAt).replace(/[\s—–]+$/, '').trim();
    const es = esAt === -1 ? null : raw.slice(esAt + 3).trim();
    return { label, en: en || es, es: es || en };
  }).filter((e) => e.en || e.es);
}

/**
 * Card ids to consult for a profile, most specific first (platform, then framework).
 * `profile.cards` arrives from detect-platform as repo paths, so every id goes through `cardIdOf`.
 */
export function cardIdsFor(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const norm = (list) => [...new Set(list.map(cardIdOf).filter(Boolean))];
  if (Array.isArray(profile.cards) && profile.cards.length) return norm(profile.cards);
  const ids = [];
  if (profile.platform && profile.platform.id) ids.push(String(profile.platform.id));
  if (profile.framework && profile.framework.id) ids.push(String(profile.framework.id));
  for (const p of Array.isArray(profile.cms_plugins) ? profile.cms_plugins : []) if (p && p.id) ids.push(String(p.id));
  return norm(ids);
}

/** Manual-path entries for a profile: every card it matched, in order, tagged with its card id. */
export function manualPathsFor(profile) {
  const out = [];
  for (const id of cardIdsFor(profile)) {
    const card = readCard(id);
    if (!card) continue;
    for (const entry of parseManualPaths(card.text)) out.push({ ...entry, card: id });
  }
  return out;
}

const TOPICS = [
  { key: 'title', re: /(title|description|snippet|meta|seo)/i, modules: ['M7'] },
  { key: 'head', re: /(head|layout|template|theme file|edit code)/i, modules: ['M7', 'M8', 'M11', 'M5'] },
  { key: 'redirect', re: /(redirect|301|url change)/i, modules: ['M3'] },
  { key: 'robots', re: /(robots|crawl|visibility|index)/i, modules: ['M1', 'M2'] },
  { key: 'schema', re: /(schema|structured|json-?ld|rich result)/i, modules: ['M5'] },
  { key: 'image', re: /(image|alt|media|picture)/i, modules: ['M9'] },
  { key: 'hreflang', re: /(hreflang|market|language|locale|international)/i, modules: ['M20'] },
  { key: 'sitemap', re: /(sitemap)/i, modules: ['M17'] },
  { key: 'theme', re: /(theme|template|code|head)/i, modules: ['M4', 'M8', 'M11'] },
];

/**
 * The manual-path entries most relevant to a module, best first (never more than three).
 * When nothing matches the module's topics but the card does have paths, the first two are returned
 * with `generic: true` — a general path from the right card beats "no path at all", as long as the
 * rendering says which it is.
 */
export function pathsForModule(entries, moduleId) {
  const topics = TOPICS.filter((t) => t.modules.includes(String(moduleId)));
  const scored = entries.map((e) => {
    const hay = [e.label, e.en, e.es].filter(Boolean).join(' ');
    let score = 0;
    for (const t of topics) if (t.re.test(hay)) score += 2;
    return { entry: e, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length) return scored.slice(0, 3).map((s) => s.entry);
  return entries.slice(0, 2).map((e) => ({ ...e, generic: true }));
}

const T = {
  en: {
    heading: 'Do this by hand',
    why: 'Why', where: 'Where', value: 'Exact value to use', observed: 'What the audit saw',
    expected: 'What it should be', path: 'Click path', verify: 'How to check it worked',
    findings: 'Findings covered', noPath: 'No platform card matched this site — follow the recommendation in your CMS.',
    general: 'general paths from this platform card, not specific to this change',
    reaudit: 'Re-run the audit after the change; this tool cannot see your admin.',
    handed: 'Handed to you: nothing was written by the tool.',
  },
  es: {
    heading: 'Hazlo a mano',
    why: 'Por qué', where: 'Dónde', value: 'Valor exacto', observed: 'Lo que vio la auditoría',
    expected: 'Lo que debería ser', path: 'Ruta de clics', verify: 'Cómo comprobarlo',
    findings: 'Hallazgos cubiertos', noPath: 'Ninguna ficha de plataforma coincide con este sitio: sigue la recomendación en tu CMS.',
    general: 'rutas generales de la ficha de la plataforma, no específicas de este cambio',
    reaudit: 'Vuelve a ejecutar la auditoría después del cambio; esta herramienta no ve tu panel.',
    handed: 'Te lo dejamos a ti: la herramienta no escribió nada.',
  },
};

/** en | es (anything else falls back to en). */
export function normalizeLang(lang) { return String(lang || 'en').toLowerCase().startsWith('es') ? 'es' : 'en'; }

/**
 * Render one instruction block. Every value shown comes from the finding itself
 * (`evidence.observed`, `expected`, `recommendation`, `fix_preview`) — nothing is generated.
 */
export function renderInstruction({ findings, paths = [], lang = 'en', profile = null, cardId = null }) {
  const L = normalizeLang(lang);
  const t = T[L];
  const lines = [];
  const first = findings[0];
  lines.push('## ' + t.heading + ': ' + first.title);
  lines.push('');
  lines.push('**' + t.why + ':** ' + first.recommendation);
  lines.push('');
  if (paths.length) {
    lines.push('**' + t.path + ':**' + (paths.every((p) => p.generic) ? ' _(' + t.general + ')_' : ''));
    for (const p of paths) {
      const body = L === 'es' ? p.es : p.en;
      lines.push('- ' + (p.label ? '*' + p.label + '* — ' : '') + body + (p.card ? '  _(' + p.card + '.md §11)_' : ''));
    }
  } else {
    lines.push('**' + t.path + ':** ' + t.noPath);
  }
  lines.push('');
  for (const f of findings) {
    const loc = f.location || {};
    const where = loc.url || loc.resource || loc.file || (profile && profile.target && profile.target.url) || '—';
    lines.push('### ' + f.id);
    lines.push('- **' + t.where + ':** ' + where + (loc.selector ? ' (`' + loc.selector + '`)' : ''));
    lines.push('- **' + t.observed + ':** ' + (f.evidence && f.evidence.observed ? f.evidence.observed : '—'));
    lines.push('- **' + t.expected + ':** ' + f.expected);
    if (f.fix_preview) {
      lines.push('- **' + t.value + ':**');
      lines.push('');
      lines.push('```');
      lines.push(String(f.fix_preview).replace(/\s+$/, ''));
      lines.push('```');
    }
    if (f.verification && f.verification.reproduce) {
      lines.push('- **' + t.verify + ':** `' + f.verification.reproduce + '`');
    }
    lines.push('');
  }
  lines.push('_' + t.reaudit + '_');
  return lines.join('\n');
}

/** Group findings into one instruction per module (+ scope), preserving report order. */
export function groupFindings(findings, { includeProposed = true, category = null } = {}) {
  const groups = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || typeof f !== 'object') continue;
    if (f.status !== 'fail' && f.status !== 'warn') continue;
    if (f.fixable === 'proposed' && !includeProposed) continue;
    if (category) {
      const wanted = (Array.isArray(category) ? category : [category]).map((c) => String(c).toLowerCase());
      const axis = f.expected_impact && f.expected_impact.axis ? String(f.expected_impact.axis).toLowerCase() : '';
      const values = new Set([String(f.module || '').toLowerCase(), axis, String(f.fixable || '').toLowerCase(), String(f.scope || '').toLowerCase()]);
      if (axis === 'both') { values.add('search'); values.add('ai'); }
      if (!wanted.some((w) => values.has(w))) continue;
    }
    const key = String(f.module || 'M0') + '|' + String(f.scope || 'page');
    if (!groups.has(key)) groups.set(key, { key, module: String(f.module || 'M0'), scope: String(f.scope || 'page'), findings: [] });
    groups.get(key).findings.push(f);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Adapter ops

/** capabilities: always ready — this adapter needs no credentials and touches nothing. */
export async function capabilities() {
  return { adapter: ADAPTER, ready: true, needs: [], tools: {}, writes: 'nothing (renders a click path for the user)' };
}

/** plan: one `instruction` change per finding group, rendered in --lang. */
export async function plan(options = {}, ctx = {}) {
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);
  const lang = normalizeLang(options.lang);
  const entries = manualPathsFor(profile);
  const cardId = cardIdsFor(profile)[0] || null;

  const changes = [];
  const groups = groupFindings(findings, { includeProposed: options.includeProposed !== false, category: options.category });
  for (const group of groups) {
    const paths = pathsForModule(entries, group.module);
    const body = renderInstruction({ findings: group.findings, paths, lang, profile, cardId });
    const locator = (cardId ? cardId + ':' : '') + group.module + ':' + group.scope;
    const finding_ids = group.findings.map((f) => f.id);
    // The identity of an instruction is what the user has to do, not which language it is read in:
    // `lang` stays out of the hash so switching --lang updates a change instead of creating a new one.
    const id = changeId({ adapter: ADAPTER, op: 'instruction', target: { kind: 'manual', locator }, finding_ids, strategy: 'manual', payload: { module: group.module, card: cardId } });
    const built = makeChange({
      id,
      finding_ids,
      adapter: ADAPTER,
      class: 'proposed',
      target: { kind: 'manual', locator, url: (group.findings[0].location && group.findings[0].location.url) || undefined },
      op: 'instruction',
      strategy: 'manual',
      payload: { lang, module: group.module, card: cardId, paths: paths.map((p) => p.label || p.en) },
      preview: { kind: 'text', body, lang },
      requires: { credentials: [], tools: [] },
      live_impact: 'none',
      verify: {
        method: 'manual_review',
        command: reproduceCommand('audit.mjs', { url: (report && report.target && report.target.value) || '<target>' }),
        assertion: 'after you make the change, a fresh audit no longer reports ' + group.findings.map((f) => f.id).join(', '),
      },
      rollback: { kind: 'none' },
      status: 'planned',
    }, { mode: 'return', phase: 'preview' });
    if (!built.errors.length) changes.push(built.change);
  }
  return { adapter: ADAPTER, ready: true, lang, card: cardId, changes, skipped: [], notes: entries.length ? [] : ['no platform card matched this profile: the instructions carry the finding text without a click path'] };
}

/** preview: the rendered text, re-written to the run's preview/ directory. */
export async function preview(change, ctx = {}) {
  const body = change.preview && change.preview.body ? change.preview.body : '';
  if (ctx.run) writeText(ctx.run.previewPath(change.id, '.md'), body);
  return { change: canTransition(change.status, 'previewed') ? transition(change, 'previewed') : change, ok: true, body };
}

/**
 * apply: hand the instructions to the user. This is the honest maximum — the tool cannot click
 * through someone's admin, so the change is recorded as applied *by the user*, not by the tool.
 */
export async function apply(change, ctx = {}) {
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String(e && e.message || e) }; }
  const t = T[normalizeLang(change.payload && change.payload.lang)];
  if (ctx.run) ctx.run.log({ event: 'apply', adapter: ADAPTER, change: change.id, note: 'handed to user' });
  return {
    change: transition(confirmed, 'applied', { applied_by: 'user' }),
    ok: true, handed_to_user: true, note: t.handed, body: change.preview && change.preview.body,
  };
}

/** verify: manual_review — never a pass. Re-audit is the only honest confirmation. */
export async function verify(change, ctx = {}) {
  const t = T[normalizeLang(change.payload && change.payload.lang)];
  return {
    change, ok: null, status: 'manual_review',
    note: t.reaudit,
    checks: [{ name: 'manual', ok: null, detail: change.verify && change.verify.assertion }],
  };
}

/** rollback: nothing was written, so nothing is undone — the user reverts it the same way. */
export async function rollback(change, ctx = {}) {
  return {
    change, ok: false, reason: 'manual',
    note: 'this change was handed to you, so the tool has nothing to undo — reverse the same steps in your admin',
  };
}

// ---------------------------------------------------------------------------
// CLI

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) return { result: { error: 'usage: instructions <' + OPS.join('|') + '> --run <dir> [--change <id>] [--lang en|es]' }, code: EXIT.USAGE };
  const dataDir = resolveDataDir(args);
  const ctx = { dataDir, env: process.env, now: () => new Date() };

  if (op === 'capabilities') return { result: await capabilities(ctx), code: EXIT.OK };

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const run = loadRun(args, dataDir) || openFixRun(dataDir, { report: String(args.report), profile: args.profile && args.profile !== true ? String(args.profile) : null, target: report.target || null, adapters: [ADAPTER] });
    ctx.run = run;
    const out = await plan({
      report, profile: args.profile && args.profile !== true ? String(args.profile) : null,
      lang: args.lang === true ? 'en' : args.lang,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] !== false,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) writeText(run.previewPath(c.id, '.md'), c.preview.body);
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: EXIT.OK };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  const planFile = run.readPlan() || { changes: [] };
  let changes = (planFile.changes || []).filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    changes = changes.filter((c) => wanted.has(c.id));
  }
  if (!changes.length) return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir }, code: EXIT.USAGE };

  const fn = { preview, apply, verify, rollback }[op];
  const results = [];
  const updated = [];
  for (const change of changes) {
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push({ change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok, ...(out.note ? { note: out.note } : {}), ...(out.error ? { error: out.error } : {}), ...(out.reason ? { reason: out.reason } : {}) });
  }
  const byId = new Map(updated.map((c) => [c.id, c]));
  run.setChanges((planFile.changes || []).map((c) => (byId.has(c.id) ? byId.get(c.id) : c)));
  logOpEvent(run, { op, adapter: ADAPTER, results });
  // this adapter writes nothing: a finished instruction never turns the run into a live one
  updateManifest(run, { op, adapter: ADAPTER, changes: updated, wrote: false });
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, results }, code: results.some((r) => r.ok === false && r.error) ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
