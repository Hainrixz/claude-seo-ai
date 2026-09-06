// scripts/fix-plan.mjs — target selection and the grouped dry run, on a synthetic report and a
// throwaway copy of a fixture repo. Offline, and it must leave the project byte-identical: this is
// the step that plans writes, not the one that performs them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FP = await import(pathToFileURL(join(ROOT, 'scripts', 'fix-plan.mjs')).href);
const SCRIPT = join(ROOT, 'scripts', 'fix-plan.mjs');
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');

const URL_ = 'https://ridgeline.example/blog/rain-shadow';

const finding = (id, module, fix_preview) => ({
  id, module, title: id, status: 'fail', severity: 3, scope: 'page',
  location: { url: URL_ },
  evidence: { observed: 'missing' },
  expected: 'present', recommendation: 'add it',
  fixable: 'auto', fix_preview,
  verification: { method: 'dom_assert', assertion: 'present' },
  expected_impact: { axis: 'search', confidence: 'established', magnitude: 'medium', rationale: 'documented' },
});

const REPORT = {
  target: { kind: 'url', value: URL_, host: 'ridgeline.example' },
  generated_at: new Date().toISOString(),
  findings: [
    finding('M7.meta.description_missing', 'M7', '<meta name="description" content="Why the east side stays dry.">'),
    finding('M5.jsonld.missing', 'M5', '<script type="application/ld+json">{"@type":"Article"}</script>'),
    { ...finding('M9.cwv.lcp_slow', 'M9', ''), fixable: 'advisory', fix_preview: undefined },
  ],
};

const PROFILE = {
  version: 1,
  platform: { id: 'static', confidence: 'high' },
  capabilities: { local_files: true },
  write_targets: [
    { adapter: 'local-files', for: ['head', 'files'], ready: true, needs: [], tools: {} },
    { adapter: 'instructions', for: ['manual'], ready: true, needs: [], tools: {} },
  ],
};

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cseo-fixplan-'));
  const project = join(base, 'project');
  cpSync(join(REPOS, 'static'), project, { recursive: true });
  const data = join(base, 'data');
  mkdirSync(data, { recursive: true });
  const reportPath = join(base, 'report.json');
  const profilePath = join(base, 'profile.json');
  writeFileSync(reportPath, JSON.stringify(REPORT, null, 2));
  writeFileSync(profilePath, JSON.stringify(PROFILE, null, 2));
  return { base, project, data, reportPath, profilePath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Snapshot every file in a tree so a "planned nothing" claim can be proven. */
function snapshotTree(dir, prefix = '') {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshotTree(p, prefix + entry.name + '/'));
    else out[prefix + entry.name] = readFileSync(p, 'utf8');
  }
  return out;
}

function runCli(args, env = null) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* asserted by the caller */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

test('resolveTargets follows the explicit flag, and never selects local files without a project', () => {
  const explicit = FP.resolveTargets({ targets: 'local,instructions', project: '/tmp/p' });
  assert.deepEqual(explicit.targets, ['local-files', 'instructions']);
  assert.equal(explicit.source, 'flag');

  const noProject = FP.resolveTargets({ targets: 'local' });
  assert.deepEqual(noProject.targets, ['instructions'], 'a URL-only target has no source tree');
  assert.match(noProject.notes.join(' '), /no --project/);

  assert.deepEqual(FP.resolveTargets({ targets: 'shopify', project: null }).targets, ['shopify-theme', 'shopify-admin', 'instructions']);
  assert.deepEqual(FP.resolveTargets({ targets: 'webflow' }).targets, ['page-api', 'instructions']);
  assert.equal(FP.resolveTargets({ targets: 'webflow' }).provider, 'webflow');
  assert.deepEqual(FP.resolveTargets({ targets: 'nope' }).errors.length, 1, 'an unknown target is a usage error, not a guess');
});

test('resolveTargets falls back to the profile, and to instructions when credentials are missing', () => {
  const shopifyProfile = {
    platform: { id: 'shopify', confidence: 'high' },
    write_targets: [
      { adapter: 'shopify-theme', ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN'], tools: { shopify: true } },
      { adapter: 'shopify-admin', ready: true, needs: [] },
    ],
  };
  // `env: {}` on purpose: readiness is read from the environment now, so the assertion must not
  // depend on what the developer running the suite happens to have exported.
  const picked = FP.resolveTargets({ profile: shopifyProfile, env: {} });
  assert.equal(picked.source, 'profile');
  assert.deepEqual(picked.targets, ['shopify-admin', 'instructions']);
  assert.match(picked.notes.join(' '), /SHOPIFY_THEME_TOKEN/, 'the missing key is named, never the value');

  const wp = FP.resolveTargets({
    env: {},
    profile: {
      platform: { id: 'wordpress', confidence: 'high' },
      write_targets: [{ adapter: 'wordpress-rest', ready: false, needs: ['WP_APP_PASSWORD'] }, { adapter: 'wordpress-wpcli', ready: true, needs: [] }],
    },
  });
  assert.deepEqual(wp.targets, ['wordpress-wpcli', 'instructions'], 'WP-CLI is the fallback when REST has no credentials');

  const bare = FP.resolveTargets({ profile: { platform: { id: 'squarespace', confidence: 'high' }, write_targets: [] }, env: {} });
  assert.deepEqual(bare.targets, ['instructions']);
  assert.equal(bare.targets[bare.targets.length - 1], 'instructions', 'instructions is always the last resort');
});

test('resolveTargets reads the credentials this process can see, not the audit-time snapshot', () => {
  // The documented flow is: export the keys (or fill the /plugin prompts), then run fix. The profile
  // was written when the audit ran — trusting its frozen `ready:false` printed "shopify-admin … is
  // missing SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN" in a shell where both were exported, and collapsed
  // the default --targets auto flow to instructions.
  const profile = {
    platform: { id: 'shopify', confidence: 'high' },
    write_targets: [
      { adapter: 'shopify-theme', ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN'], tools: { shopify: false } },
      { adapter: 'shopify-admin', ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN'], tools: {} },
    ],
  };
  const env = { SHOPIFY_STORE: 'my-store.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_thisisafake', SHOPIFY_THEME_TOKEN: 'shptka_thisisafake' };
  const now = FP.resolveTargets({ profile, env });
  assert.deepEqual(now.targets, ['shopify-admin', 'instructions'], 'the keys are here; only the CLI is still missing');
  const rows = Object.fromEntries(now.readiness.map((r) => [r.adapter, r]));
  assert.deepEqual(rows['shopify-admin'].missing, [], 'no key is missing in this environment');
  assert.equal(rows['shopify-admin'].ready, true);
  assert.equal(rows['shopify-admin'].ready_in_profile, false, 'and the plan says the profile disagreed');
  assert.deepEqual(rows['shopify-theme'].missing_tools, ['shopify'], 'a tool the profile could not find still blocks');
  assert.match(now.notes.join(' '), /cannot find `shopify` on PATH/);
  assert.doesNotMatch(now.notes.join(' '), /missing SHOPIFY_STORE/, 'never name a key that is present');

  // The plugin-option spelling and the historical alias resolve too (lib/credentials lookupOrder).
  const viaPlugin = FP.resolveTargets({ profile, env: { CLAUDE_PLUGIN_OPTION_SHOPIFY_STORE: 's', SHOPIFY_ACCESS_TOKEN: 'shpat_thisisafake' } });
  assert.ok(viaPlugin.targets.includes('shopify-admin'));

  const withCli = FP.resolveTargets({ profile, env, tools: { shopify: true } });
  assert.deepEqual(withCli.targets, ['shopify-theme', 'shopify-admin', 'instructions']);

  // WordPress REST wins over WP-CLI as soon as its three keys are exported.
  const wp = FP.resolveTargets({
    profile: {
      platform: { id: 'wordpress', confidence: 'high' },
      write_targets: [
        { adapter: 'wordpress-rest', ready: false, needs: ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD'] },
        { adapter: 'wordpress-wpcli', ready: false, needs: ['WP_SSH'], tools: { wp: true, ssh: true } },
      ],
    },
    env: { WP_URL: 'https://e.test', WP_USER: 'jo', WP_APP_PASSWORD: 'a b c d' },
  });
  assert.deepEqual(wp.targets, ['wordpress-rest', 'instructions']);
});

test('a dry run groups changes per adapter and writes plan.json without touching the project', async () => {
  const s = sandbox();
  try {
    const before = snapshotTree(s.project);
    const r = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'run1']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = r.out;
    assert.equal(out.dry_run, true);
    assert.equal(out.run, 'run1');
    assert.deepEqual(out.targets, ['local-files', 'instructions']);

    const byAdapter = Object.fromEntries(out.groups.map((g) => [g.adapter, g]));
    assert.equal(byAdapter['local-files'].changes.length, 2, 'both fixable findings map to source files');
    assert.ok(byAdapter['local-files'].changes.every((c) => c.target.locator === 'blog/rain-shadow.html'));
    assert.ok(byAdapter['local-files'].changes.every((c) => c.live_impact === 'none'));
    // instructions is the fallback, not a second copy: it renders only what local-files did not claim
    // (here the advisory finding, which no adapter can write).
    const claimed = new Set(byAdapter['local-files'].changes.flatMap((c) => c.finding_ids));
    const handed = new Set(byAdapter.instructions.changes.flatMap((c) => c.finding_ids));
    assert.deepEqual([...claimed].filter((id) => handed.has(id)), [], 'no finding is planned twice');
    assert.deepEqual([...handed], ['M9.cwv.lcp_slow'], 'the advisory finding is handed to the user, never written');
    assert.ok(!byAdapter['local-files'].changes.some((c) => c.finding_ids.includes('M9.cwv.lcp_slow')), 'an advisory finding is never a file write');

    const plan = JSON.parse(readFileSync(join(s.data, 'fix', 'runs', 'run1', 'plan.json'), 'utf8'));
    assert.equal(plan.changes.length, out.changes_count);
    assert.ok(plan.changes.every((c) => c.status === 'planned'), 'nothing leaves the plan already applied');
    const manifest = JSON.parse(readFileSync(join(s.data, 'fix', 'runs', 'run1', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.confirmed, [], 'a plan confirms nothing');
    assert.equal(manifest.dry_run, true);
    assert.deepEqual(manifest.adapters, ['local-files', 'instructions']);
    assert.equal(manifest.report, s.reportPath);

    const previews = readdirSync(join(s.data, 'fix', 'runs', 'run1', 'preview'));
    assert.equal(previews.length, out.changes_count, 'every change has a preview on disk');
    assert.ok(previews.some((f) => f.endsWith('.diff')));

    assert.deepEqual(snapshotTree(s.project), before, 'fix-plan must not modify a single byte of the project');
    assert.match(out.summary, /DRY RUN, nothing has been applied/);
    assert.match(out.summary, /local-files — 2 changes/);
    assert.match(out.summary, /\[none\]/, 'every change carries a live_impact badge');
  } finally { s.cleanup(); }
});

test('the dry-run summary prints per-adapter readiness from the live environment, key names only', () => {
  const s = sandbox();
  try {
    const shopifyProfile = join(s.base, 'shopify-profile.json');
    writeFileSync(shopifyProfile, JSON.stringify({
      version: 1,
      platform: { id: 'shopify', confidence: 'high' },
      capabilities: { theme_files: true, admin_api: true },
      write_targets: [
        { adapter: 'shopify-theme', for: ['head'], ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN'], tools: { shopify: false } },
        { adapter: 'shopify-admin', for: ['seo-fields'], ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN'], tools: {} },
      ],
    }));
    const token = 'shpat_thisisafaketoken';
    const r = runCli(['--report', s.reportPath, '--profile', shopifyProfile, '--data', s.data, '--run', 'ready1'],
      { SHOPIFY_STORE: 'my-store.myshopify.com', SHOPIFY_ADMIN_TOKEN: token });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(r.out.targets.includes('shopify-admin'), 'the exported keys select the adapter the audit could not');
    assert.match(r.out.summary, /write targets \(credentials re-checked against this environment\)/);
    assert.match(r.out.summary, /shopify-admin\s+ready\s+needs: SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN/);
    assert.match(r.out.summary, /shopify-theme\s+not ready.*missing: SHOPIFY_THEME_TOKEN.*not on PATH: shopify/);
    assert.ok(!r.stdout.includes(token), 'a credential value never reaches the output');
  } finally { s.cleanup(); }
});

test('a target whose adapter does not exist is reported, not thrown', async () => {
  const s = sandbox();
  try {
    const loaded = await FP.loadAdapter('page-api');
    if (!loaded.available) {
      assert.match(loaded.reason, /does not exist in this build yet/);
      const r = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--data', s.data, '--targets', 'page-api']);
      assert.equal(r.status, 0, 'a missing adapter is a downgrade, not a failure');
      const group = r.out.groups.find((g) => g.adapter === 'page-api');
      assert.equal(group.available, false);
      assert.equal(group.changes.length, 0);
      assert.ok(r.out.groups.find((g) => g.adapter === 'instructions').changes.length > 0,
        'its findings fall through to instructions');
    } else {
      assert.equal(typeof loaded.mod.plan, 'function', 'an available adapter must expose plan()');
    }
    assert.equal((await FP.loadAdapter('not-an-adapter')).available, false);
  } finally { s.cleanup(); }
});

test('--targets instructions alone renders every finding as a click path', () => {
  const s = sandbox();
  try {
    const r = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--data', s.data, '--targets', 'instructions', '--run', 'manual']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.targets, ['instructions']);
    assert.ok(r.out.changes_count >= 2, 'nothing is trimmed when instructions is the only target');
    assert.ok(r.out.changes.every((c) => c.adapter === 'instructions' && c.live_impact === 'none'));
  } finally { s.cleanup(); }
});

test('re-planning the same run is stable and replaces only its own adapters', () => {
  const s = sandbox();
  try {
    const first = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'stable']);
    const second = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'stable']);
    assert.equal(second.status, 0);
    assert.deepEqual(second.out.changes.map((c) => c.id), first.out.changes.map((c) => c.id), 'change ids are deterministic');
    const plan = JSON.parse(readFileSync(join(s.data, 'fix', 'runs', 'stable', 'plan.json'), 'utf8'));
    assert.equal(plan.changes.length, first.out.changes_count, 're-planning must not duplicate changes');
  } finally { s.cleanup(); }
});

test('the summary never prints an empty "[not ready: ]" badge', () => {
  const base = {
    run: 'run_1', run_dir: '/tmp/run_1', report: '/tmp/report.json', changes: [], changes_count: 0,
    target: { kind: 'url', value: URL_ }, notes: [],
  };
  const render = (group) => FP.renderSummary({ ...base, groups: [group] });

  const named = render({ adapter: 'shopify-theme', changes: [], ready: false, needs: ['SHOPIFY_STORE', 'SHOPIFY_STORE'] });
  assert.match(named, /\[not ready: SHOPIFY_STORE\]/, 'a duplicate key is listed once');

  // An adapter that could not say what it needs still reads as not ready, without the dangling list.
  for (const needs of [[], undefined, [null, '']]) {
    const blank = render({ adapter: 'wordpress-wpcli', changes: [], ready: false, needs });
    assert.match(blank, /wordpress-wpcli — 0 changes {2}\[not ready\]/);
    assert.ok(!blank.includes('[not ready: ]'), blank);
  }

  const ok = render({ adapter: 'instructions', changes: [], ready: true, needs: [] });
  assert.ok(!ok.includes('not ready'), ok);
});

// ---------------------------------------------------------------------------
// coverage accounting

test('classifyFindings puts every finding in exactly one bucket', () => {
  const f = (id, fixable, status = 'fail') => ({ id, module: id.split('.')[0], status, fixable });
  const list = [
    f('M7.a', 'auto'), f('M7.b', 'proposed'), f('M9.c', 'advisory'),
    f('M2.d', 'auto', 'pass'), f('M2.e', 'auto', 'needs_api'),
  ];
  const off = FP.classifyFindings(list, { includeProposed: false });
  assert.equal(off.actionable.length, 3, 'only fail/warn findings are actionable');
  assert.deepEqual(off.considered.map((x) => x.id), ['M7.a'], 'proposed is not handed over without the flag');
  assert.deepEqual(off.withheld_proposed.map((x) => x.id), ['M7.b']);
  assert.deepEqual(off.advisory.map((x) => x.id), ['M9.c']);

  const on = FP.classifyFindings(list, { includeProposed: true });
  assert.deepEqual(on.considered.map((x) => x.id), ['M7.a', 'M7.b']);
  assert.deepEqual(on.withheld_proposed, [], 'with the flag nothing is held back');

  // --category narrows the pool the same way every adapter narrows it.
  const only9 = FP.classifyFindings(list, { category: 'M9' });
  assert.deepEqual(only9.actionable.map((x) => x.id), ['M9.c']);
});

test('a held-back count over a shorter id list says "across N id(s)", never a silent truncation', () => {
  const f = (id) => ({ id, module: id.split('.')[0], status: 'fail', fixable: 'proposed' });
  // The same two ids firing on three pages each: 6 occurrences, 2 distinct ids.
  const findings = [f('M9.alt.missing'), f('M9.alt.missing'), f('M9.alt.missing'), f('M7.title.short'), f('M7.title.short'), f('M7.title.short')];
  const cov = FP.buildCoverage({ findings, includeProposed: false, groups: [{ adapter: 'local-files', available: true, handed: findings, changes: [], skipped: [] }] });
  assert.equal(cov.skipped_proposed.count, 6);
  assert.equal(cov.skipped_proposed.id_count, 2);
  assert.deepEqual(cov.skipped_proposed.ids, ['M9.alt.missing', 'M7.title.short']);
  const printed = FP.renderCoverage(cov).join('\n');
  assert.match(printed, /held back as proposed \(6 across 2 id\(s\)\)/);
  assert.equal(FP.countPhrase(3, ['a', 'b', 'c']), '3', 'one id per finding needs no extra clause');
  assert.equal(FP.countPhrase(24, new Array(15).fill('x'), 'fixable finding(s)'), '24 fixable finding(s) across 15 id(s)');
});

test('buildCoverage accounts for every finding an adapter did not plan, and why', () => {
  const f = (id, fixable) => ({ id, module: id.split('.')[0], status: 'fail', fixable });
  const findings = [f('M7.a', 'auto'), f('M7.b', 'proposed'), f('M9.c', 'advisory'), f('M12.d', 'auto')];
  const change = (id, cls) => ({ id: 'chg_' + id, class: cls, finding_ids: [id] });

  const cov = FP.buildCoverage({
    findings,
    includeProposed: false,
    groups: [
      { adapter: 'local-files', available: true, handed: findings, changes: [change('M7.a', 'auto')], skipped: [{ finding: 'M12.d', reason: 'no route' }] },
      { adapter: 'instructions', available: true, handed: [f('M9.c', 'advisory'), f('M12.d', 'auto')], changes: [change('M9.c', 'proposed')], skipped: [] },
    ],
  });

  assert.equal(cov.findings, 4);
  assert.equal(cov.actionable, 4);
  assert.equal(cov.writable, 2, 'M7.a and M12.d are the write-adapter pool without the flag');
  assert.equal(cov.planned, 2);
  assert.equal(cov.planned_auto, 1);
  assert.equal(cov.planned_proposed, 1);

  assert.equal(cov.skipped_proposed.count, 1);
  assert.deepEqual(cov.skipped_proposed.ids, ['M7.b']);
  assert.match(cov.skipped_proposed.hint, /--include-proposed/);

  assert.equal(cov.advisory.count, 1);
  assert.deepEqual(cov.advisory.ids, ['M9.c']);
  assert.deepEqual(cov.advisory.rendered_as_instructions, ['M9.c']);

  // M12.d reached both adapters and neither planned it: that is the unroutable bucket.
  assert.equal(cov.unroutable.count, 1);
  assert.deepEqual(cov.unroutable.ids, ['M12.d']);
  assert.match(cov.unroutable.note, /no adapter/);

  assert.equal(cov.by_adapter['local-files'].considered, 2);
  assert.equal(cov.by_adapter['local-files'].planned_auto, 1);
  assert.equal(cov.by_adapter['local-files'].skipped, 1);
  assert.equal(cov.by_adapter['local-files'].withheld_proposed, 1, 'the adapter never saw the proposed finding');
  assert.equal(cov.by_adapter.instructions.considered, 2, 'instructions renders advisory findings too');
  assert.ok(cov.planned <= cov.considered, 'nothing can be planned that no adapter was handed');

  // With the flag, the same report holds nothing back.
  const withFlag = FP.buildCoverage({
    findings, includeProposed: true,
    groups: [{ adapter: 'local-files', available: true, handed: findings, changes: [change('M7.a', 'auto'), change('M7.b', 'proposed')], skipped: [] }],
  });
  assert.equal(withFlag.skipped_proposed.count, 0);
  assert.equal(withFlag.skipped_proposed.hint, null);
  assert.equal(withFlag.planned_proposed, 1);
});

test('the dry run reports coverage in plan.json, the manifest and the printed summary', () => {
  const s = sandbox();
  try {
    const withoutFlag = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'cov']);
    assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
    const cov = withoutFlag.out.coverage;
    assert.ok(cov, 'the result carries a coverage block');
    assert.equal(cov.findings, REPORT.findings.length);
    assert.equal(cov.include_proposed, false);
    assert.equal(cov.advisory.count, 1);
    assert.deepEqual(cov.advisory.ids, ['M9.cwv.lcp_slow']);
    assert.ok(cov.by_adapter['local-files'], 'every adapter that ran is accounted for');
    assert.ok(cov.by_adapter.instructions);

    const plan = JSON.parse(readFileSync(join(s.data, 'fix', 'runs', 'cov', 'plan.json'), 'utf8'));
    assert.deepEqual(plan.coverage, cov, 'plan.json carries the same accounting the CLI printed');
    const manifest = JSON.parse(readFileSync(join(s.data, 'fix', 'runs', 'cov', 'manifest.json'), 'utf8'));
    assert.equal(manifest.counts.considered, cov.considered);
    assert.equal(manifest.counts.advisory, cov.advisory.count);
    assert.equal(manifest.counts.skipped_proposed, cov.skipped_proposed.count);
    assert.equal(manifest.counts.unroutable, cov.unroutable.count);

    assert.match(withoutFlag.out.summary, /coverage: \d+ actionable finding\(s\)/);
    assert.match(withoutFlag.out.summary, /coverage: \d+ considered here/, 'each adapter group prints its own line');
    assert.match(withoutFlag.out.summary, /advisory, never written \(1\): M9\.cwv\.lcp_slow/);
  } finally { s.cleanup(); }
});

test('a proposed finding is never dropped silently: the count, the ids and the flag are printed', () => {
  const s = sandbox();
  try {
    // The shipped report is all-auto, so add one proposed finding to the same page.
    const proposed = { ...finding('M7.title.length_out_of_band', 'M7', '<title>Rain shadow</title>'), fixable: 'proposed', status: 'warn' };
    writeFileSync(s.reportPath, JSON.stringify({ ...REPORT, findings: [...REPORT.findings, proposed] }, null, 2));

    const held = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'held']);
    assert.equal(held.status, 0, held.stderr);
    assert.equal(held.out.coverage.skipped_proposed.count, 1);
    assert.deepEqual(held.out.coverage.skipped_proposed.ids, ['M7.title.length_out_of_band']);
    assert.ok(!held.out.changes.some((c) => (c.finding_ids || []).includes('M7.title.length_out_of_band')),
      'the proposed finding is not planned without the flag');
    assert.match(held.out.summary, /held back as proposed \(1\): M7\.title\.length_out_of_band/);
    assert.match(held.out.summary, /--include-proposed/);
    assert.ok(held.out.notes.some((n) => n.includes('--include-proposed')), 'the note names the flag, not just the count');
    assert.equal(held.out.coverage.by_adapter['local-files'].withheld_proposed, 1);

    const planned = runCli(['--report', s.reportPath, '--profile', s.profilePath, '--project', s.project, '--data', s.data, '--run', 'planned', '--include-proposed']);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.out.coverage.skipped_proposed.count, 0);
    assert.equal(planned.out.coverage.include_proposed, true);
    assert.ok(planned.out.changes.some((c) => (c.finding_ids || []).includes('M7.title.length_out_of_band')),
      'with the flag the same finding is planned');
    assert.ok(!planned.out.summary.includes('held back as proposed'));
  } finally { s.cleanup(); }
});

test('usage errors: a missing or unreadable report, and a bad project path', () => {
  const s = sandbox();
  try {
    assert.equal(runCli(['--profile', s.profilePath]).status, 1, '--report is required — never fix from memory');
    assert.equal(runCli(['--report', join(s.base, 'nope.json')]).status, 1);
    assert.match(runCli(['--report', join(s.base, 'nope.json')]).out.error, /cannot read report/);
    assert.equal(runCli(['--report', s.reportPath, '--project', join(s.base, 'nope')]).status, 1);
    assert.equal(runCli(['--report', s.reportPath, '--targets', 'nonsense']).status, 1);
  } finally { s.cleanup(); }
});
