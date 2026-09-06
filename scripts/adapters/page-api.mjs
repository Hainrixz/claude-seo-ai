#!/usr/bin/env node
// page-api — one CLI over the five hosted platforms that expose a page-metadata API.
//
//   node scripts/adapters/page-api.mjs <op> --provider webflow|wix|ghost|hubspot|bigcommerce \
//        --run <fix-run-dir> [--change <id>] [--ticket <t>] [--json]
//   plan: --report <report.json> [--profile <profile.json>] [--category …] [--include-proposed]
//         [--answers <json|path>] [--live] [--blog]
//   ops: capabilities | plan | preview | apply | verify | rollback | publish
//
// The adapter name on every change is `page-api`; `payload.provider` says which platform it belongs
// to, so one fix run can carry changes for a Ghost blog and a BigCommerce catalog at once and each
// op only touches its own.
//
// What differs between providers is deliberately visible rather than smoothed over:
//   * Webflow and HubSpot have a real staging boundary — their writes are `staged` and `publish` is
//     a separate, separately-confirmed op.
//   * Wix, Ghost and BigCommerce are live on write, and say so in the preview.
//   * Wix replaces its tag set in full, so a write is always read → merge → write.
//   * Ghost needs the post's current `updated_at`, and refuses a write when the post moved under it.
//
// `capabilities` without `--provider` reports every provider's readiness at once, credential names
// only — no values, ever.

import { EXIT, isMain, runCli } from '../lib/util.mjs';
import { loadFixRun, openFixRun, requireTicket, resolveDataDir, updateManifest } from '../lib/adapter.mjs';
import { redactObject } from '../lib/credentials.mjs';
import { readJson, writeText } from '../lib/store.mjs';
import { logOpEvent, opThrew } from './_shared.mjs';
import * as webflow from './providers/webflow.mjs';
import * as wix from './providers/wix.mjs';
import * as ghost from './providers/ghost.mjs';
import * as hubspot from './providers/hubspot.mjs';
import * as bigcommerce from './providers/bigcommerce.mjs';

export const ADAPTER = 'page-api';

/** provider id -> module. Every one exports capabilities/plan/preview/apply/verify/rollback. */
export const PROVIDERS = Object.freeze({ webflow, wix, ghost, hubspot, bigcommerce });
/** Provider ids in a stable order (what `capabilities` reports and the usage line prints). */
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
/** Providers with a publish step (a staged write only reaches the public site through it). */
export const PUBLISHERS = Object.freeze(PROVIDER_IDS.filter((id) => typeof PROVIDERS[id].publish === 'function'));

const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback', 'publish'];

/** The provider module for an id, or null. */
export function providerFor(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
}

/** Credential key names a provider needs (names only). */
export function keysFor(id) {
  const mod = providerFor(id);
  return mod && Array.isArray(mod.KEYS) ? [...mod.KEYS] : [];
}

/** capabilities for one provider, or for all of them when `id` is null. */
export async function capabilities(ctx = {}, options = {}) {
  const id = options.provider || null;
  if (id) {
    const mod = providerFor(id);
    if (!mod) return { adapter: ADAPTER, ready: false, needs: [], error: 'unknown provider "' + id + '" (known: ' + PROVIDER_IDS.join(', ') + ')' };
    const caps = await mod.capabilities(ctx, options);
    return { adapter: ADAPTER, ...caps, needs: caps.needs || [] };
  }
  const providers = {};
  for (const key of PROVIDER_IDS) {
    try { providers[key] = await PROVIDERS[key].capabilities(ctx, options); }
    catch (e) { providers[key] = { provider: key, ready: false, needs: keysFor(key), notes: [String((e && e.message) || e)] }; }
  }
  const ready = PROVIDER_IDS.filter((key) => providers[key] && providers[key].ready);
  return { adapter: ADAPTER, ready: ready.length > 0, providers, ready_providers: ready, needs: ready.length ? [] : ['credentials for one of: ' + PROVIDER_IDS.join(', ')] };
}

/** plan through one provider. */
export async function plan(options = {}, ctx = {}) {
  const mod = providerFor(options.provider);
  if (!mod) return { adapter: ADAPTER, ready: false, changes: [], skipped: [], notes: ['unknown provider "' + options.provider + '"'] };
  const out = await mod.plan(options, ctx);
  return { adapter: ADAPTER, ...out };
}

/** Run one op on one change through the change's own provider. */
export async function runOp(op, change, ctx = {}, options = {}) {
  const id = (change.payload && change.payload.provider) || options.provider;
  const mod = providerFor(id);
  if (!mod) return { change, ok: false, error: 'change ' + change.id + ' names an unknown provider "' + id + '"' };
  const fn = mod[op];
  if (typeof fn !== 'function') return { change, ok: false, error: id + ' has no "' + op + '" op' };
  return fn(change, ctx, options);
}

/** The uniform adapter ops, each dispatched to the provider named on the change. */
export const preview = (change, ctx = {}, options = {}) => runOp('preview', change, ctx, options);
export const apply = (change, ctx = {}, options = {}) => runOp('apply', change, ctx, options);
export const verify = (change, ctx = {}, options = {}) => runOp('verify', change, ctx, options);
export const rollback = (change, ctx = {}, options = {}) => runOp('rollback', change, ctx, options);

/** publish for a change's provider (only webflow and hubspot have one). */
export async function publish(change, ctx = {}, options = {}) {
  const id = (change && change.payload && change.payload.provider) || options.provider;
  const mod = providerFor(id);
  if (!mod) return { ok: false, error: 'unknown provider "' + id + '"' };
  if (typeof mod.publish !== 'function') return { ok: false, error: id + ' has no publish step: its writes are live on apply' };
  return mod.publish(change, ctx, options);
}

// ---------------------------------------------------------------------------
// CLI

function optionsFromArgs(args) {
  return {
    provider: args.provider && args.provider !== true ? String(args.provider).toLowerCase() : null,
    live: args.live === true,
    blog: args.blog === true,
    site: args.site && args.site !== true ? String(args.site) : null,
    store: args.store && args.store !== true ? String(args.store) : null,
    page: args.page && args.page !== true ? String(args.page) : null,
    subdomain: args.subdomain === true,
    domains: args.domain ? (Array.isArray(args.domain) ? args.domain.map(String) : [String(args.domain)]) : [],
  };
}

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args, provider) {
  const planFile = run ? run.readPlan() : null;
  const all = planFile && Array.isArray(planFile.changes) ? planFile.changes : [];
  let mine = all.filter((c) => c.adapter === ADAPTER && (!provider || (c.payload && c.payload.provider === provider)));
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    mine = mine.filter((c) => wanted.has(c.id));
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
    return { result: { error: 'usage: page-api <' + OPS.join('|') + '> --provider ' + PROVIDER_IDS.join('|') + ' --run <dir> [--change <id>] [--ticket <t>]' }, code: EXIT.USAGE };
  }
  const dataDir = resolveDataDir(args);
  const options = optionsFromArgs(args);
  const ctx = {
    dataDir, env: process.env, now: () => new Date(),
    devUrl: args['dev-url'] && args['dev-url'] !== true ? String(args['dev-url']) : null,
  };

  if (op === 'capabilities') return { result: await capabilities(ctx, options), code: EXIT.OK };

  if (!options.provider) {
    return { result: { error: op + ' needs --provider ' + PROVIDER_IDS.join('|') }, code: EXIT.USAGE };
  }
  if (!providerFor(options.provider)) {
    return { result: { error: 'unknown provider "' + options.provider + '" (known: ' + PROVIDER_IDS.join(', ') + ')' }, code: EXIT.USAGE };
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
      ...options,
      report, profile: args.profile && args.profile !== true ? String(args.profile) : null,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
    }, ctx);
    if (out.changes && out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => !(c.adapter === ADAPTER && c.payload && c.payload.provider === options.provider));
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) if (c.preview && c.preview.body) writeText(run.previewPath(c.id, '.json.txt'), c.preview.body);
    }
    run.log({ event: 'plan', adapter: ADAPTER, provider: options.provider, changes: (out.changes || []).length, skipped: (out.skipped || []).length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;

  if (op === 'publish') {
    const mod = providerFor(options.provider);
    if (typeof mod.publish !== 'function') {
      return { result: { adapter: ADAPTER, provider: options.provider, error: options.provider + ' has no publish step: its writes are live on apply (publishers: ' + PUBLISHERS.join(', ') + ')' }, code: EXIT.USAGE };
    }
    const changes = pickChanges(run, args, options.provider);
    const change = changes.length === 1 ? changes[0] : null;
    const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change ? change.id : null });
    if (!gate.ok) {
      return { result: { adapter: ADAPTER, provider: options.provider, op, error: 'publish needs its own confirmation ticket (' + gate.reason + ') — publishing makes every staged change on the site public' }, code: EXIT.USAGE };
    }
    // A ticket issued for one change must not unlock a publish that was never named in it.
    if (gate.ticket && gate.ticket.change && (!change || gate.ticket.change !== change.id)) {
      return { result: { adapter: ADAPTER, provider: options.provider, op, error: 'that ticket was issued for change ' + gate.ticket.change + ', not for a publish — confirm the publish on its own' }, code: EXIT.USAGE };
    }
    let out;
    try { out = await mod.publish(change, ctx, options); }
    catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
    run.log({ event: 'publish', adapter: ADAPTER, provider: options.provider, ok: !!out.ok });
    updateManifest(run, { op: 'publish', adapter: ADAPTER, changes: out.change ? [out.change] : [], wrote: !!out.ok });
    return { result: redactObject({ adapter: ADAPTER, provider: options.provider, op, run: run.id, ...out }, { env: process.env }), code: out.ok ? EXIT.OK : EXIT.RUNTIME };
  }

  const changes = pickChanges(run, args, options.provider);
  if (!changes.length) {
    return { result: { error: 'no ' + ADAPTER + '/' + options.provider + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };
  }

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
    let out;
    try { out = await runOp(op, change, ctx, options); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push(redactObject({
      change: change.id, provider: (change.payload && change.payload.provider) || options.provider,
      status: out.change ? out.change.status : change.status, ok: out.ok,
      ...(out.error ? { error: out.error } : {}),
      ...(out.checks ? { checks: out.checks } : {}),
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.note ? { note: out.note } : {}),
      ...(out.status && typeof out.status === 'number' ? { http_status: out.status } : {}),
    }, { env: process.env }));
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results, extra: { provider: options.provider } });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, provider: options.provider, op, run: run.id, run_dir: run.dir, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
