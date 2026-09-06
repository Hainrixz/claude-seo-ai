#!/usr/bin/env node
// Build the fix plan: report + platform profile in, one plan.json full of Changes out.
//
// This is the step between "we know what is wrong" and "someone writes something". It groups the
// report's fixable findings by the adapter that owns each surface, calls that adapter's plan(),
// and persists the result in a fix run directory. It applies nothing, previews nothing live and
// needs no credentials: a missing token downgrades a target to `instructions`, it never fails the
// run and it is never silently dropped from the summary.
//
// Target selection (plan 3g step 3): an explicit --targets wins; otherwise the profile's
// write_targets decide — a local project gets `local-files`, Shopify gets theme + admin, WordPress
// gets REST when its credentials are present and WP-CLI when only --ssh/WP_SSH is, hosted builders
// get page-api when their key is present — and `instructions` is always appended as the honest
// fallback, so every finding has somewhere to go. A URL-only target never selects `local-files`:
// there is no source tree to edit.
//
// Usage:
//   node scripts/fix-plan.mjs --report <report.json> --profile <profile.json> \
//        [--targets local,instructions] [--run <fix-run-id|dir>] [--category <c>] [--include-proposed] \
//        [--answers <json|path>] [--project <dir>] [--dev-url <u>] [--lang en|es] [--data <dir>]
// Exit codes: 0 ok · 1 usage (unreadable report, unknown target) · 2 an adapter threw.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { fixRunDir, loadFixRun, openFixRun, resolveDataDirInfo } from './lib/adapter.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** adapter id -> module, relative to scripts/. Every id the profile's write_targets can name. */
export const ADAPTER_MODULES = Object.freeze({
  'local-files': 'adapters/local-files.mjs',
  'shopify-theme': 'adapters/shopify-theme.mjs',
  'shopify-admin': 'adapters/shopify-admin.mjs',
  'wordpress-rest': 'adapters/wordpress-rest.mjs',
  'wordpress-wpcli': 'adapters/wordpress-wpcli.mjs',
  'page-api': 'adapters/page-api.mjs',
  instructions: 'adapters/instructions.mjs',
});

/** What `--target`/`--targets` words mean. A word may expand to more than one adapter. */
export const TARGET_ALIASES = Object.freeze({
  auto: ['auto'],
  local: ['local-files'], 'local-files': ['local-files'], files: ['local-files'],
  shopify: ['shopify-theme', 'shopify-admin'],
  'shopify-theme': ['shopify-theme'], theme: ['shopify-theme'],
  'shopify-admin': ['shopify-admin'], admin: ['shopify-admin'],
  wordpress: ['wordpress-rest', 'wordpress-wpcli'],
  'wordpress-rest': ['wordpress-rest'], rest: ['wordpress-rest'],
  'wordpress-wpcli': ['wordpress-wpcli'], wpcli: ['wordpress-wpcli'], 'wp-cli': ['wordpress-wpcli'],
  'page-api': ['page-api'], webflow: ['page-api'], wix: ['page-api'], ghost: ['page-api'], hubspot: ['page-api'], bigcommerce: ['page-api'],
  instructions: ['instructions'], manual: ['instructions'],
});

/** Providers the page-api adapter multiplexes; `--targets webflow` also fixes the provider. */
export const PAGE_API_PROVIDERS = Object.freeze(['webflow', 'wix', 'ghost', 'hubspot', 'bigcommerce']);

const msg = (e) => String((e && e.message) || e);
const uniq = (list) => [...new Set(list)];

function readJson(path) {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }; }
  catch (e) { return { value: null, error: msg(e) }; }
}

/** `a,b|c` / repeated flags / an array -> ['a','b','c']. */
export function splitList(value) {
  const parts = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string') continue;
    for (const piece of item.split(/[,|\s]+/)) if (piece.trim()) parts.push(piece.trim().toLowerCase());
  }
  return uniq(parts);
}

/**
 * Which adapters this run plans for.
 * @param {object} opts { targets, profile, project, env }
 * @returns {{targets: string[], provider: string|null, notes: string[], errors: string[], source: 'flag'|'profile'}}
 */
export function resolveTargets({ targets = null, profile = null, project = null, env = process.env } = {}) {
  const notes = [];
  const errors = [];
  const requested = splitList(targets);
  const explicit = requested.filter((t) => t !== 'auto');
  let provider = requested.find((t) => PAGE_API_PROVIDERS.includes(t)) || null;
  let list = [];
  let source = 'flag';

  if (explicit.length) {
    for (const word of explicit) {
      const mapped = TARGET_ALIASES[word];
      if (!mapped) { errors.push('unknown --targets value "' + word + '" (known: ' + Object.keys(TARGET_ALIASES).sort().join(', ') + ')'); continue; }
      list.push(...mapped);
    }
    if (list.includes('local-files') && !project) {
      notes.push('--targets asked for local files but no --project was given; a URL-only target has no source tree to edit.');
      list = list.filter((a) => a !== 'local-files');
    }
  } else {
    source = 'profile';
    const wt = profile && Array.isArray(profile.write_targets) ? profile.write_targets : [];
    const byId = new Map(wt.map((t) => [t && t.adapter, t]));
    const platform = (profile && profile.platform && profile.platform.id) || null;
    const ready = (id) => !!(byId.get(id) && byId.get(id).ready);

    if (project) list.push('local-files');
    else if (byId.has('local-files')) notes.push('the profile can write local files, but this run has no --project: pass one to edit the source tree.');

    if (platform === 'shopify') {
      for (const id of ['shopify-theme', 'shopify-admin']) {
        if (!byId.has(id)) continue;
        if (ready(id)) list.push(id);
        else notes.push(id + ' is the right write path for Shopify but is missing ' + (byId.get(id).needs || []).join(', ') + ' — falling back to instructions.');
      }
    }
    if (platform === 'wordpress') {
      if (ready('wordpress-rest')) list.push('wordpress-rest');
      else if (ready('wordpress-wpcli')) list.push('wordpress-wpcli');
      else notes.push('WordPress: neither the REST credentials (WP_URL, WP_USER, WP_APP_PASSWORD) nor WP_SSH are present — falling back to instructions.');
    }
    if (byId.has('page-api')) {
      if (ready('page-api')) { list.push('page-api'); provider = provider || platform; }
      else notes.push('page-api is available for ' + (platform || 'this platform') + ' but is missing ' + (byId.get('page-api').needs || []).join(', ') + ' — falling back to instructions.');
    }
    if (!wt.length) notes.push('the profile carries no write_targets; planning instructions only.');
  }

  list = uniq(list).filter((a) => a !== 'instructions');
  list.push('instructions'); // always last, always present: every finding has somewhere to go
  if (provider && !PAGE_API_PROVIDERS.includes(provider)) provider = null;
  return { targets: list, provider, notes, errors, source };
}

/** Import one adapter module. A target that does not exist yet is reported, never thrown. */
export async function loadAdapter(adapter, { scriptsDir = SCRIPTS_DIR } = {}) {
  const rel = ADAPTER_MODULES[adapter];
  if (!rel) return { adapter, available: false, reason: 'no module is registered for "' + adapter + '"' };
  const file = join(scriptsDir, rel);
  if (!existsSync(file)) return { adapter, available: false, file, reason: 'scripts/' + rel + ' does not exist in this build yet — its findings go to instructions instead' };
  try { return { adapter, available: true, file, mod: await import(pathToFileURL(file).href) }; }
  catch (e) { return { adapter, available: false, file, reason: 'failed to load scripts/' + rel + ': ' + msg(e) }; }
}

const previewExt = (kind) => (kind === 'diff' ? '.diff' : kind === 'payload' ? '.json' : kind === 'command' ? '.sh' : '.md');
const badge = (impact) => (impact === 'live' ? '[LIVE]' : impact === 'staged' ? '[staged]' : '[none]');

/** The grouped dry-run summary the `fix` skill prints. Text, because a plan is read by a human. */
export function renderSummary(result) {
  const L = [];
  const target = result.target ? (result.target.value || result.target.kind) : 'unknown target';
  L.push('fix plan ' + result.run + ' — DRY RUN, nothing has been applied');
  L.push('target: ' + target + (result.profile_summary ? '  ·  profile: ' + result.profile_summary : ''));
  L.push('report: ' + (result.report || 'n/a'));
  L.push('run dir: ' + result.run_dir);
  L.push('');
  if (!result.changes_count) L.push('No changes planned. Every fixable finding was skipped — see `skipped` below.');
  for (const group of result.groups) {
    const head = group.adapter + ' — ' + group.changes.length + ' change' + (group.changes.length === 1 ? '' : 's');
    const needs = [...new Set(group.needs || [])].filter(Boolean);
    const state = group.available === false ? '  [unavailable]'
      // an empty "[not ready: ]" tells the operator nothing — say only what we can name
      : (group.ready === false ? (needs.length ? '  [not ready: ' + needs.join(', ') + ']' : '  [not ready]') : '');
    L.push(head + state);
    if (group.available === false) L.push('    ' + group.reason);
    for (const c of group.changes) {
      L.push('    ' + c.id + '  ' + String(c.class).padEnd(8) + ' ' + badge(c.live_impact).padEnd(8) + ' ' +
        String(c.target && c.target.locator ? c.target.locator : '-') + '   ' + (c.finding_ids || []).join(', '));
    }
    for (const s of group.skipped || []) L.push('    skipped ' + (s.finding || s.id || '?') + ': ' + (s.reason || ''));
    for (const n of group.notes || []) L.push('    note: ' + n);
    L.push('');
  }
  for (const n of result.notes || []) L.push('note: ' + n);
  const live = result.changes.filter((c) => c.live_impact === 'live').length;
  const staged = result.changes.filter((c) => c.live_impact === 'staged').length;
  L.push('');
  L.push(result.changes_count + ' change(s): ' + result.auto_count + ' auto, ' + result.proposed_count + ' proposed · ' +
    staged + ' staged, ' + live + ' live-impact.');
  L.push('Nothing here is applied: preview each change, confirm it, and only then does /claude-seo-ai:fix issue a ticket and dispatch seo-fixer-writer.');
  return L.join('\n');
}

/** Resolve `--run` to a fix-run handle (an id under <DATA>/fix/runs, or a directory path). */
export function openRun(args, dataDir, seed) {
  const raw = args.run === true ? null : (typeof args.run === 'string' && args.run.trim() ? args.run.trim() : null);
  if (raw && (raw.includes('/') || raw.includes(sep))) {
    const dir = resolve(raw);
    if (existsSync(dir) && statSync(dir).isDirectory()) return loadFixRun(dir, { dataDir });
    return openFixRun(dataDir, { ...seed, id: dir.split(/[\\/]/).filter(Boolean).pop() });
  }
  if (raw) {
    const dir = fixRunDir(dataDir, raw);
    if (existsSync(dir)) return loadFixRun(dir, { dataDir });
    return openFixRun(dataDir, { ...seed, id: raw });
  }
  return openFixRun(dataDir, seed);
}

export async function main(args) {
  if (!args.report || args.report === true) return { result: { error: 'fix-plan needs --report <report.json> (the persisted audit — never fix from memory)' }, code: EXIT.USAGE };
  const reportPath = resolve(String(args.report));
  const report = readJson(reportPath);
  if (report.error) return { result: { error: 'cannot read report ' + reportPath + ': ' + report.error }, code: EXIT.USAGE };

  const profilePath = args.profile && args.profile !== true ? resolve(String(args.profile)) : null;
  const profileRead = profilePath ? readJson(profilePath) : { value: null, error: null };
  if (profilePath && profileRead.error) return { result: { error: 'cannot read profile ' + profilePath + ': ' + profileRead.error }, code: EXIT.USAGE };
  const profile = profileRead.value || (report.value && report.value.platform) || null;

  const info = resolveDataDirInfo(args);
  const dataDir = info.dir;
  const reportTarget = (report.value && report.value.target) || null;
  const project = args.project && args.project !== true
    ? resolve(String(args.project))
    : (reportTarget && reportTarget.kind === 'path' && reportTarget.value ? resolve(String(reportTarget.value)) : null);
  if (project && !(existsSync(project) && statSync(project).isDirectory())) {
    return { result: { error: '--project is not a directory: ' + project }, code: EXIT.USAGE };
  }

  const selection = resolveTargets({ targets: args.targets || args.target, profile, project, env: process.env });
  if (selection.errors.length) return { result: { error: selection.errors.join('; ') }, code: EXIT.USAGE };

  const run = openRun(args, dataDir, {
    report: reportPath, profile: profilePath, target: reportTarget, adapters: selection.targets,
  });

  const ctx = {
    run, dataDir, project, env: process.env, now: () => new Date(),
    devUrl: args['dev-url'] && args['dev-url'] !== true ? String(args['dev-url']) : null,
  };
  const options = {
    report: report.value,
    profile,
    project,
    category: args.category === true ? null : args.category,
    includeProposed: args['include-proposed'] === true,
    answers: args.answers === true ? null : args.answers,
    lang: args.lang === true ? 'en' : args.lang,
    provider: selection.provider,
  };

  const groups = [];
  const all = [];
  const failures = [];
  const notes = [...selection.notes];
  for (const adapter of selection.targets) {
    const loaded = await loadAdapter(adapter);
    if (!loaded.available) {
      groups.push({ adapter, available: false, reason: loaded.reason, changes: [], skipped: [], notes: [] });
      continue;
    }
    let caps = null;
    if (typeof loaded.mod.capabilities === 'function') {
      try { caps = await loaded.mod.capabilities(ctx); } catch (e) { caps = { ready: false, needs: [], error: msg(e) }; }
    }
    // `instructions` is the fallback, not a second copy of the work: when another adapter already
    // owns a finding, the user does not also need a click path for it. `--targets instructions`
    // alone still renders everything.
    const scoped = { ...options };
    if (adapter === 'instructions' && selection.targets.length > 1) {
      const covered = new Set(all.flatMap((c) => c.finding_ids || []));
      const source = Array.isArray(options.report && options.report.findings) ? options.report.findings : [];
      scoped.findings = source.filter((f) => f && !covered.has(f.id));
      if (covered.size) {
        notes.push(scoped.findings.length
          ? 'instructions renders the ' + scoped.findings.length + ' finding(s) no write adapter claimed; the other ' + covered.size + ' are planned as changes above.'
          : 'every fixable finding is claimed by a write adapter, so instructions has nothing left to render.');
      }
    }
    let out;
    try { out = await loaded.mod.plan(scoped, ctx); }
    catch (e) {
      failures.push(adapter + ': ' + msg(e));
      groups.push({ adapter, available: true, ready: caps ? caps.ready !== false : null, needs: (caps && caps.needs) || [], changes: [], skipped: [], notes: ['plan() failed: ' + msg(e)], error: msg(e) });
      continue;
    }
    const changes = Array.isArray(out && out.changes) ? out.changes : [];
    all.push(...changes);
    groups.push({
      adapter, available: true,
      ready: out && out.ready !== undefined ? out.ready !== false : (caps ? caps.ready !== false : null),
      needs: (caps && caps.needs) || [],
      changes, skipped: (out && out.skipped) || [], notes: (out && out.notes) || [],
    });
  }

  // Persist: replace the changes of the adapters this run planned for, keep everyone else's.
  const planned = run.readPlan() || { changes: [] };
  const kept = (planned.changes || []).filter((c) => !selection.targets.includes(c.adapter));
  run.setChanges([...kept, ...all]);
  for (const c of all) {
    if (c && c.preview && typeof c.preview.body === 'string' && c.preview.body) {
      try { writeFileSync(run.previewPath(c.id, previewExt(c.preview.kind)), c.preview.body); } catch { /* preview is a convenience, not the contract */ }
    }
  }
  const auto_count = all.filter((c) => c.class === 'auto').length;
  run.updateManifest((m) => ({
    ...m,
    report: reportPath, profile: profilePath, target: reportTarget || m.target || null,
    adapters: selection.targets, target_source: selection.source,
    planned_at: new Date().toISOString(), dry_run: true,
    confirmed: Array.isArray(m.confirmed) ? m.confirmed : [],
    counts: { changes: all.length, auto: auto_count, proposed: all.length - auto_count },
  }));
  run.log({ event: 'fix-plan', adapters: selection.targets, changes: all.length, dry_run: true });

  const platformLabel = profile && profile.platform && profile.platform.id
    ? profile.platform.id + (profile.platform.confidence ? ' (' + profile.platform.confidence + ')' : '') : null;
  const result = {
    ok: failures.length === 0,
    dry_run: true,
    run: run.id,
    run_dir: run.dir,
    data_dir: dataDir,
    data_dir_source: info.source,
    report: reportPath,
    profile: profilePath,
    profile_summary: platformLabel,
    target: reportTarget,
    project,
    targets: selection.targets,
    target_source: selection.source,
    provider: selection.provider,
    changes_count: all.length,
    auto_count,
    proposed_count: all.length - auto_count,
    changes: all.map((c) => ({ id: c.id, adapter: c.adapter, class: c.class, op: c.op, live_impact: c.live_impact, target: c.target, finding_ids: c.finding_ids, requires: c.requires, status: c.status })),
    groups: groups.map((g) => ({ ...g, changes: g.changes.map((c) => ({ id: c.id, class: c.class, live_impact: c.live_impact, target: c.target, finding_ids: c.finding_ids, op: c.op })) })),
    notes,
    failures,
  };
  result.summary = renderSummary(result);
  return { result, code: failures.length ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
