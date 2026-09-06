#!/usr/bin/env node
// Build the fix plan: report + platform profile in, one plan.json full of Changes out.
//
// This is the step between "we know what is wrong" and "someone writes something". It groups the
// report's fixable findings by the adapter that owns each surface, calls that adapter's plan(),
// and persists the result in a fix run directory. It applies nothing, previews nothing live and
// needs no credentials: a missing token downgrades a target to `instructions`, it never fails the
// run and it is never silently dropped from the summary.
//
// Nothing is dropped quietly either: `coverage` (in the result, in plan.json and in the printed
// summary) accounts for every finding in the report — considered, planned auto, planned proposed,
// held back for want of --include-proposed (with the ids), advisory, and the ones no adapter owns.
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
// Not an adapter (it is the adapters' shared plumbing), so it is imported statically: the same
// predicate must decide what `--category` means here and inside every adapter.
import { matchesCategory } from './adapters/_shared.mjs';
// Credential presence is read here, never a value: lib/credentials.mjs is the only resolver, and it
// looks in both the CLAUDE_PLUGIN_OPTION_<KEY> and <KEY> spellings.
import { canonicalKey, keysForAdapter, missingKeys } from './lib/credentials.mjs';

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
 *
 * Readiness is re-evaluated HERE, against the environment this process is running in — not read off
 * `profile.write_targets[].ready`, which detect-platform.mjs computed when the audit ran. The
 * documented flow is "export the keys (or fill the /plugin prompts), then run fix": with the frozen
 * flag, an audit taken before the keys existed collapsed every write adapter to `instructions` even
 * with the credentials exported, and `--targets shopify-admin` on the same shell reported the group
 * ready. Tool detection (a `shopify` or `wp` binary on PATH) still comes from the profile, because
 * this function does not spawn anything; a caller that knows better passes `tools`.
 *
 * @param {object} opts { targets, profile, project, env, tools }
 * @returns {{targets: string[], provider: string|null, notes: string[], errors: string[],
 *   source: 'flag'|'profile', readiness: Array<{adapter, ready, needs, missing, tools, ready_in_profile}>}}
 */
export function resolveTargets({ targets = null, profile = null, project = null, env = process.env, tools = null } = {}) {
  const notes = [];
  const errors = [];
  const readiness = [];
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

    /** Live readiness for one profile target: keys from `env` now, tools from the profile. */
    const assess = (id) => {
      const t = byId.get(id) || {};
      // An empty `needs` in the profile is a statement ("this adapter needs no keys"), not a gap:
      // only a target with no needs field at all falls back to the catalog.
      const needs = Array.isArray(t.needs) ? t.needs : keysForAdapter(id);
      const missing = missingKeys(needs, env);
      const toolMap = { ...(t.tools || {}), ...(tools || {}) };
      const missingTools = Object.entries(toolMap).filter(([, ok]) => !ok).map(([name]) => name);
      const row = {
        adapter: id,
        needs: needs.map((k) => canonicalKey(k)),
        missing,
        missing_tools: missingTools,
        tools: toolMap,
        ready: missing.length === 0 && missingTools.length === 0,
        ready_in_profile: !!t.ready,
      };
      readiness.push(row);
      return row;
    };
    /** "is missing SHOPIFY_ADMIN_TOKEN" / "cannot find the `shopify` CLI" — only what is true now. */
    const lack = (row) => [
      row.missing.length ? 'is missing ' + row.missing.join(', ') : null,
      row.missing_tools.length ? 'cannot find ' + row.missing_tools.map((t) => '`' + t + '`') .join(', ') + ' on PATH' : null,
    ].filter(Boolean).join(' and ');

    if (project) list.push('local-files');
    else if (byId.has('local-files')) notes.push('the profile can write local files, but this run has no --project: pass one to edit the source tree.');

    if (platform === 'shopify') {
      for (const id of ['shopify-theme', 'shopify-admin']) {
        if (!byId.has(id)) continue;
        const row = assess(id);
        if (row.ready) list.push(id);
        else notes.push(id + ' is the right write path for Shopify but ' + lack(row) + ' — falling back to instructions.');
      }
    }
    if (platform === 'wordpress') {
      const rest = byId.has('wordpress-rest') ? assess('wordpress-rest') : null;
      const cli = byId.has('wordpress-wpcli') ? assess('wordpress-wpcli') : null;
      if (rest && rest.ready) list.push('wordpress-rest');
      else if (cli && cli.ready) list.push('wordpress-wpcli');
      else notes.push('WordPress: neither the REST credentials (WP_URL, WP_USER, WP_APP_PASSWORD) nor WP_SSH are usable in this environment'
        + (rest && rest.missing.length ? ' (REST ' + lack(rest) + ')' : '') + ' — falling back to instructions.');
    }
    if (byId.has('page-api')) {
      const row = assess('page-api');
      if (row.ready) { list.push('page-api'); provider = provider || platform; }
      else notes.push('page-api is available for ' + (platform || 'this platform') + ' but ' + lack(row) + ' — falling back to instructions.');
    }
    if (!wt.length) notes.push('the profile carries no write_targets; planning instructions only.');
    // Say when the environment changed the answer: the operator exported the keys and it worked.
    for (const row of readiness) {
      if (row.ready && !row.ready_in_profile) notes.push(row.adapter + ' is ready in this environment (the audit-time profile said it was not): ' + (row.needs.length ? row.needs.join(', ') + ' resolved' : 'no credentials needed') + '.');
    }
  }

  list = uniq(list).filter((a) => a !== 'instructions');
  list.push('instructions'); // always last, always present: every finding has somewhere to go
  if (provider && !PAGE_API_PROVIDERS.includes(provider)) provider = null;
  return { targets: list, provider, notes, errors, source, readiness };
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

// ---------------------------------------------------------------------------
// Coverage accounting
//
// The gap this closes: without --include-proposed every adapter silently drops every
// `fixable: 'proposed'` finding, so a plan could print "2 changes" over a report of 30 findings and
// say nothing about the other 28. Every finding in the report now lands in exactly one bucket, and
// the plan says which.

/** Ids the fix flow can act on at all: a failing or warning finding with a fixable class. */
export const ACTIONABLE_STATUSES = Object.freeze(['fail', 'warn']);

const idsOf = (list) => [...new Set(list.map((f) => String((f && f.id) || f)).filter(Boolean))];

/**
 * Bucket a report's findings before any adapter sees them.
 * @returns {{actionable, considered, withheld_proposed, advisory, considered_ids:Set<string>}}
 *   actionable        — fail/warn findings that pass --category
 *   considered        — the ones actually handed to the adapters (proposed only with the flag)
 *   withheld_proposed — proposed findings kept back because --include-proposed was not passed
 *   advisory          — `fixable: 'advisory'`: never written by this tool, by design
 */
export function classifyFindings(findings, { category = null, includeProposed = false } = {}) {
  const actionable = (Array.isArray(findings) ? findings : []).filter(
    (f) => f && typeof f === 'object' && ACTIONABLE_STATUSES.includes(f.status) && matchesCategory(f, category),
  );
  const advisory = actionable.filter((f) => f.fixable === 'advisory');
  const proposed = actionable.filter((f) => f.fixable === 'proposed');
  const considered = actionable.filter((f) => f.fixable === 'auto' || (includeProposed && f.fixable === 'proposed'));
  return {
    actionable,
    considered,
    withheld_proposed: includeProposed ? [] : proposed,
    advisory,
    considered_ids: new Set(idsOf(considered)),
  };
}

/** Distinct finding ids a list of changes claims, split by change class. */
function claimedBy(changes) {
  const auto = new Set();
  const proposed = new Set();
  for (const c of changes || []) {
    for (const id of c.finding_ids || []) (c.class === 'auto' ? auto : proposed).add(String(id));
  }
  return { auto: [...auto], proposed: [...proposed], all: new Set([...auto, ...proposed]) };
}

export const INCLUDE_PROPOSED_HINT = 're-run with --include-proposed to plan them (each one still needs your yes before it is written)';

/**
 * Per-adapter and run-level coverage: what was considered, what was planned, and what was not —
 * with the reason. Called after every adapter has planned.
 *
 * Two pools, because they are not the same thing: a WRITE adapter may only act on a fixable
 * (`auto`, or `proposed` with the flag) finding, while `instructions` renders any actionable one,
 * advisory included — that is precisely what advisory means. So `considered` is the union of what
 * the adapters in this run were actually handed and could act on, which keeps
 * `planned ⊆ considered` true and makes `unroutable = considered − planned` mean something.
 *
 * @param {object} args { findings, category, includeProposed, groups }
 *   groups: [{ adapter, available, changes, skipped, handed }] where `handed` is the finding list
 *           the adapter was given (instructions gets a reduced one when it is the fallback).
 */
export function buildCoverage({ findings = [], category = null, includeProposed = false, groups = [] } = {}) {
  const buckets = classifyFindings(findings, { category, includeProposed });
  const withheldIds = new Set(idsOf(buckets.withheld_proposed));
  const advisoryIds = new Set(idsOf(buckets.advisory));
  const actionableIds = new Set(idsOf(buckets.actionable));

  const by_adapter = {};
  const plannedAuto = new Set();
  const plannedProposed = new Set();
  const consideredIds = new Set();
  for (const group of groups) {
    const handedIds = idsOf(group.handed || findings);
    const claimed = claimedBy(group.changes);
    for (const id of claimed.auto) plannedAuto.add(id);
    for (const id of claimed.proposed) plannedProposed.add(id);
    // `instructions` writes nothing, so nothing is out of its reach but a withheld proposed item.
    const reach = group.adapter === 'instructions'
      ? handedIds.filter((id) => actionableIds.has(id) && !withheldIds.has(id))
      : handedIds.filter((id) => buckets.considered_ids.has(id));
    for (const id of reach) consideredIds.add(id);
    by_adapter[group.adapter] = {
      considered: reach.length,
      planned: claimed.all.size,
      planned_auto: claimed.auto.length,
      planned_proposed: claimed.proposed.length,
      skipped: (group.skipped || []).length,
      // Withheld before this adapter ever saw them, so it could not have planned them.
      withheld_proposed: handedIds.filter((id) => withheldIds.has(id)).length,
      available: group.available !== false,
    };
  }

  const planned = new Set([...plannedAuto, ...plannedProposed]);
  const unroutable = buckets.actionable.filter((f) => consideredIds.has(String(f.id)) && !planned.has(String(f.id)));
  const advisoryRendered = buckets.advisory.filter((f) => planned.has(String(f.id)));

  return {
    findings: Array.isArray(findings) ? findings.length : 0,
    actionable: buckets.actionable.length,
    considered: consideredIds.size,
    writable: buckets.considered.length,
    include_proposed: !!includeProposed,
    planned: planned.size,
    planned_auto: plannedAuto.size,
    planned_proposed: plannedProposed.size,
    // `count` counts finding occurrences, `ids`/`id_count` the distinct ids behind them: the same
    // id fires on many pages, so 24 findings can be 15 ids. Both numbers are printed, because a
    // count with a shorter list under it reads as dropped items.
    skipped_proposed: {
      count: buckets.withheld_proposed.length,
      id_count: idsOf(buckets.withheld_proposed).length,
      ids: idsOf(buckets.withheld_proposed),
      hint: buckets.withheld_proposed.length ? INCLUDE_PROPOSED_HINT : null,
    },
    advisory: {
      count: buckets.advisory.length,
      id_count: advisoryIds.size,
      ids: [...advisoryIds],
      rendered_as_instructions: idsOf(advisoryRendered),
      note: 'advisory findings are never written by this tool; a person decides what to do with them',
    },
    unroutable: {
      count: unroutable.length,
      id_count: idsOf(unroutable).length,
      ids: idsOf(unroutable),
      note: unroutable.length ? 'no adapter available for this profile owns these findings — they stay in the report, unplanned' : null,
    },
    by_adapter,
  };
}

/**
 * "24 across 15 id(s)" — or just "15" when every occurrence has its own id. `count` counts finding
 * occurrences and `ids` the distinct ids under them; printing a bare 24 above a list of 15 ids
 * reads as a truncated list, which it is not.
 */
export function countPhrase(count, ids, noun = '') {
  const distinct = Array.isArray(ids) ? ids.length : count;
  const head = noun ? count + ' ' + noun : String(count);
  return distinct && distinct !== count ? head + ' across ' + distinct + ' id(s)' : head;
}

/** The coverage block the dry-run summary prints. */
export function renderCoverage(coverage) {
  if (!coverage) return [];
  const L = [];
  L.push('coverage: ' + coverage.actionable + ' actionable finding(s) in the report · ' + coverage.considered +
    ' reached an adapter · ' + coverage.planned + ' planned (' + coverage.planned_auto + ' auto, ' +
    coverage.planned_proposed + ' proposed).');
  const sp = coverage.skipped_proposed;
  if (sp && sp.count) {
    L.push('  held back as proposed (' + countPhrase(sp.count, sp.ids) + '): ' + sp.ids.join(', '));
    L.push('  → ' + sp.hint);
  }
  if (coverage.advisory && coverage.advisory.count) {
    const rendered = coverage.advisory.rendered_as_instructions || [];
    L.push('  advisory, never written (' + countPhrase(coverage.advisory.count, coverage.advisory.ids) + '): ' + coverage.advisory.ids.join(', ') +
      (rendered.length ? ' — ' + rendered.length + ' of them rendered as an instruction card' : ''));
  }
  if (coverage.unroutable && coverage.unroutable.count) {
    L.push('  no adapter for this profile (' + countPhrase(coverage.unroutable.count, coverage.unroutable.ids) + '): ' + coverage.unroutable.ids.join(', '));
    L.push('  → ' + coverage.unroutable.note);
  }
  return L;
}

/** The grouped dry-run summary the `fix` skill prints. Text, because a plan is read by a human. */
export function renderSummary(result) {
  const L = [];
  const target = result.target ? (result.target.value || result.target.kind) : 'unknown target';
  L.push('fix plan ' + result.run + ' — DRY RUN, nothing has been applied');
  L.push('target: ' + target + (result.profile_summary ? '  ·  profile: ' + result.profile_summary : ''));
  L.push('report: ' + (result.report || 'n/a'));
  L.push('run dir: ' + result.run_dir);
  L.push('');
  // Names only, never values: the operator needs to know which key is still missing, not what is in it.
  if ((result.target_readiness || []).length) {
    L.push('write targets (credentials re-checked against this environment):');
    for (const r of result.target_readiness) {
      L.push('  ' + String(r.adapter).padEnd(16) + (r.ready ? 'ready    ' : 'not ready')
        + '  needs: ' + (r.needs.length ? r.needs.join(', ') : 'no credentials')
        + (r.missing.length ? '  ·  missing: ' + r.missing.join(', ') : '')
        + (r.missing_tools.length ? '  ·  not on PATH: ' + r.missing_tools.join(', ') : ''));
    }
    L.push('');
  }
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
    const cov = result.coverage && result.coverage.by_adapter ? result.coverage.by_adapter[group.adapter] : null;
    if (cov) {
      L.push('    coverage: ' + cov.considered + ' considered here · ' + cov.planned + ' planned (' +
        cov.planned_auto + ' auto, ' + cov.planned_proposed + ' proposed) · ' + cov.skipped + ' skipped by the adapter' +
        (cov.withheld_proposed ? ' · ' + cov.withheld_proposed + ' held back as proposed' : ''));
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
  for (const line of renderCoverage(result.coverage)) L.push(line);
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
  const allFindings = Array.isArray(report.value && report.value.findings) ? report.value.findings : [];
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
    // What this adapter was actually given, for the coverage accounting below.
    const handed = Array.isArray(scoped.findings) ? scoped.findings : allFindings;
    let out;
    try { out = await loaded.mod.plan(scoped, ctx); }
    catch (e) {
      failures.push(adapter + ': ' + msg(e));
      groups.push({ adapter, available: true, ready: caps ? caps.ready !== false : null, needs: (caps && caps.needs) || [], changes: [], skipped: [], notes: ['plan() failed: ' + msg(e)], error: msg(e), handed });
      continue;
    }
    const changes = Array.isArray(out && out.changes) ? out.changes : [];
    all.push(...changes);
    groups.push({
      adapter, available: true,
      ready: out && out.ready !== undefined ? out.ready !== false : (caps ? caps.ready !== false : null),
      needs: (caps && caps.needs) || [],
      changes, skipped: (out && out.skipped) || [], notes: (out && out.notes) || [], handed,
    });
  }

  const coverage = buildCoverage({
    findings: allFindings, category: options.category, includeProposed: options.includeProposed, groups,
  });
  if (coverage.skipped_proposed.count) {
    notes.push(countPhrase(coverage.skipped_proposed.count, coverage.skipped_proposed.ids, 'fixable finding(s)')
      + ' are classed "proposed" and were not planned: '
      + coverage.skipped_proposed.ids.join(', ') + ' — ' + coverage.skipped_proposed.hint + '.');
  }
  if (coverage.unroutable.count) {
    notes.push(countPhrase(coverage.unroutable.count, coverage.unroutable.ids, 'finding(s)')
      + ' reached no adapter in this run: '
      + coverage.unroutable.ids.join(', ') + ' — ' + coverage.unroutable.note + '.');
  }

  // Persist: replace the changes of the adapters this run planned for, keep everyone else's.
  const planned = run.readPlan() || { changes: [] };
  const kept = (planned.changes || []).filter((c) => !selection.targets.includes(c.adapter));
  run.setChanges([...kept, ...all]);
  // …and record where every finding went, so plan.json answers "why is this not here?" on its own.
  const planFile = run.readPlan();
  if (planFile) { planFile.coverage = coverage; run.writePlan(planFile); }
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
    planned_at: new Date().toISOString(),
    // Re-planning a run that already applied something must not reset the manifest to "dry run":
    // lib/adapter.updateManifest clears the flag when a write lands, and only a write may set it back.
    dry_run: m.dry_run === false ? false : true,
    confirmed: Array.isArray(m.confirmed) ? m.confirmed : [],
    counts: {
      changes: all.length, auto: auto_count, proposed: all.length - auto_count,
      considered: coverage.considered, planned_findings: coverage.planned,
      skipped_proposed: coverage.skipped_proposed.count, advisory: coverage.advisory.count,
      unroutable: coverage.unroutable.count,
    },
  }));
  run.log({
    event: 'fix-plan', adapters: selection.targets, changes: all.length, dry_run: true,
    considered: coverage.considered, skipped_proposed: coverage.skipped_proposed.count, unroutable: coverage.unroutable.count,
  });

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
    target_readiness: selection.readiness,
    provider: selection.provider,
    changes_count: all.length,
    auto_count,
    proposed_count: all.length - auto_count,
    changes: all.map((c) => ({ id: c.id, adapter: c.adapter, class: c.class, op: c.op, live_impact: c.live_impact, target: c.target, finding_ids: c.finding_ids, requires: c.requires, status: c.status })),
    // `handed` is dropped from the printed group: it is the whole findings array, not a summary.
    groups: groups.map(({ handed: _handed, ...g }) => ({
      ...g,
      coverage: coverage.by_adapter[g.adapter] || null,
      changes: g.changes.map((c) => ({ id: c.id, class: c.class, live_impact: c.live_impact, target: c.target, finding_ids: c.finding_ids, op: c.op })),
    })),
    coverage,
    notes,
    failures,
  };
  result.summary = renderSummary(result);
  return { result, code: failures.length ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
