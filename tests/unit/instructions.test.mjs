// Unit tests for scripts/adapters/instructions.mjs — card parsing, EN/ES rendering, and the
// honesty rules (it writes nothing, it never claims a verified fix).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const I = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'instructions.mjs')).href);
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);
const { detect } = await import(pathToFileURL(join(ROOT, 'scripts', 'detect-platform.mjs')).href);

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cseo-ins-'));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { base, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const titleFinding = {
  id: 'M7.title.missing',
  module: 'M7',
  title: 'Page title missing',
  status: 'fail',
  severity: 4,
  scope: 'page',
  location: { url: 'https://shop.example/products/wool-runner' },
  evidence: { observed: '<title> is empty' },
  expected: 'a unique title of 30-60 characters',
  recommendation: 'set the SEO title on the product',
  fixable: 'proposed',
  fix_preview: 'Wool Runner — breathable everyday shoe | Ridgeline',
  verification: { method: 'dom_assert', assertion: 'title is non-empty', reproduce: 'node scripts/parse-html.mjs --url https://shop.example/products/wool-runner' },
  expected_impact: { axis: 'search', confidence: 'established', magnitude: 'high', rationale: 'the title is the strongest on-page signal' },
};

const redirectFinding = {
  ...titleFinding,
  id: 'M3.redirect.chain',
  module: 'M3',
  title: 'Redirect chain on a product URL',
  fix_preview: '/products/old-handle -> /products/wool-runner',
  recommendation: 'create a single-hop redirect',
};

const profile = { platform: { id: 'shopify', confidence: 'high' }, cards: ['shopify'] };
const report = { target: { kind: 'url', value: 'https://shop.example/' }, findings: [titleFinding, redirectFinding], platform: profile };

test('a real detect() profile finds its cards: profile.cards holds paths, not bare ids', () => {
  const fixture = join(ROOT, 'tests', 'fixtures', 'platforms', 'shopify');
  const detected = detect({
    url: 'https://northwind-supply.myshopify.com/products/merino-crew-tee',
    html: readFileSync(join(fixture, 'page.html'), 'utf8'),
    headers: JSON.parse(readFileSync(join(fixture, 'headers.json'), 'utf8')),
  });
  // This is the shape detect-platform actually writes — the bug was that only bare ids resolved.
  assert.ok(detected.cards.some((c) => c.includes('/')), 'detect() stores cards as repo paths');
  assert.deepEqual(I.cardIdsFor(detected), ['shopify']);
  assert.ok(I.manualPathsFor(detected).length >= 4, 'the shopify card\'s §11 click paths were found');
  // Both spellings and a stray path traversal all land on the same card id.
  assert.equal(I.readCard('references/platforms/shopify.md').id, 'shopify');
  assert.equal(I.readCard('shopify').id, 'shopify');
  assert.equal(I.readCard('../../../etc/passwd'), null);
});

test('parseManualPaths reads section 11 of a real platform card, in both languages', () => {
  const card = I.readCard('shopify');
  assert.ok(card, 'references/platforms/shopify.md must exist');
  const entries = I.parseManualPaths(card.text);
  assert.ok(entries.length >= 4);
  const seo = entries.find((e) => /SEO title/i.test(e.label || ''));
  assert.ok(seo, 'the SEO title path is present');
  assert.match(seo.en, /Admin/);
  assert.match(seo.es, /Panel/);
  assert.ok(!seo.en.includes('ES:'), 'the two languages are separated');
  for (const e of entries) { assert.ok(e.en && e.es); }
});

test('parseManualPaths copes with a bullet that has no label and with a missing section', () => {
  const entries = I.parseManualPaths('## 11. Manual paths (EN / ES)\n\n- EN: open the route file.\n  ES: abre el archivo de la ruta.\n\n## 12. Honesty\n');
  assert.deepEqual(entries, [{ label: null, en: 'open the route file.', es: 'abre el archivo de la ruta.' }]);
  assert.deepEqual(I.parseManualPaths('# card\n\n## 10. Check ids\n- nothing\n'), []);
  assert.deepEqual(I.parseManualPaths(''), []);
  assert.equal(I.readCard('no-such-platform'), null);
  assert.equal(I.readCard('../../etc/passwd'), null, 'a card id can never walk out of references/platforms');
});

test('a capital Z (or any text) inside section 11 does not truncate it', () => {
  // JavaScript has no \\Z anchor: an end-of-section lookahead written that way silently stops at a
  // literal Z. This is the regression guard for that.
  const card = '# x\n\n## 11. Manual paths (EN / ES)\n\n- Zone settings — EN: Zoom → Zebra.\n  ES: Zoom → Cebra.\n- Second — EN: A.\n  ES: B.\n\n## 12. Honesty\n- not a manual path\n';
  const entries = I.parseManualPaths(card);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].en, 'Zoom → Zebra.');
  assert.equal(entries[1].es, 'B.');
});

test('cardIdsFor prefers the profile cards, then platform + framework + plugins', () => {
  assert.deepEqual(I.cardIdsFor({ cards: ['shopify'] }), ['shopify']);
  assert.deepEqual(I.cardIdsFor({ platform: { id: 'wordpress' }, framework: { id: 'nextjs' }, cms_plugins: [{ id: 'yoast' }] }), ['wordpress', 'nextjs', 'yoast']);
  assert.deepEqual(I.cardIdsFor(null), []);
});

test('plan makes one instruction per module, with the exact values from the findings', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await I.plan({ report, profile, lang: 'en' }, { run, dataDir });
    assert.equal(out.changes.length, 2, 'M7 and M3 are separate instructions');
    const m7 = out.changes.find((c) => c.payload.module === 'M7');
    assert.deepEqual(m7.finding_ids, ['M7.title.missing']);
    assert.equal(m7.adapter, 'instructions');
    assert.equal(m7.class, 'proposed');
    assert.equal(m7.op, 'instruction');
    assert.equal(m7.target.kind, 'manual');
    assert.equal(m7.target.locator, 'shopify:M7:page');
    assert.equal(m7.live_impact, 'none');
    assert.deepEqual(m7.requires, { credentials: [], tools: [] });
    assert.equal(m7.rollback.kind, 'none');
    assert.equal(m7.verify.method, 'manual_review');
    assert.deepEqual(A.validateChange(m7, { phase: 'preview' }), []);

    assert.match(m7.preview.body, /Admin → Products/, 'the Shopify click path is rendered');
    assert.match(m7.preview.body, /Wool Runner — breathable everyday shoe \| Ridgeline/, 'the exact value comes from fix_preview');
    assert.match(m7.preview.body, /https:\/\/shop\.example\/products\/wool-runner/);
    assert.match(m7.preview.body, /<title> is empty/, 'what the audit observed is quoted');
    assert.match(m7.preview.body, /node scripts\/parse-html\.mjs/, 'the reproduce command is carried through');

    const m3 = out.changes.find((c) => c.payload.module === 'M3');
    assert.match(m3.preview.body, /URL redirects/, 'the redirect path is matched to the redirect module');
  } finally { cleanup(); }
});

test('plan renders Spanish when asked, with the same values', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const es = await I.plan({ report, profile, lang: 'es' }, { run, dataDir });
    const m7 = es.changes.find((c) => c.payload.module === 'M7');
    assert.equal(m7.preview.lang, 'es');
    assert.match(m7.preview.body, /Hazlo a mano/);
    assert.match(m7.preview.body, /Panel → Productos/);
    assert.match(m7.preview.body, /Ruta de clics/);
    assert.match(m7.preview.body, /Wool Runner — breathable everyday shoe \| Ridgeline/, 'the value itself is never translated');
    assert.ok(!m7.preview.body.includes('Click path'));

    const en = await I.plan({ report, profile, lang: 'en' }, { run, dataDir });
    const enM7 = en.changes.find((c) => c.payload.module === 'M7');
    assert.match(enM7.preview.body, /Click path/);
    assert.ok(!enM7.preview.body.includes('Ruta de clics'));
    assert.equal(enM7.id, m7.id, 'the language does not change the change identity');
  } finally { cleanup(); }
});

test('normalizeLang accepts es-MX and falls back to en', () => {
  assert.equal(I.normalizeLang('es'), 'es');
  assert.equal(I.normalizeLang('es-MX'), 'es');
  assert.equal(I.normalizeLang('fr'), 'en');
  assert.equal(I.normalizeLang(undefined), 'en');
});

test('with no platform card the instructions still carry the finding, and say the path is missing', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await I.plan({ report: { target: report.target, findings: [titleFinding] }, profile: { platform: { id: 'unknown-cms' } } }, { run, dataDir });
    assert.equal(out.changes.length, 1);
    assert.match(out.changes[0].preview.body, /No platform card matched this site/);
    assert.ok(out.notes.some((n) => /no platform card matched/.test(n)));
  } finally { cleanup(); }
});

test('a card whose paths do not name this change still offers them, labelled as general', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    // the astro card documents `site:` and where head tags live; neither is about local business data
    const astro = { framework: { id: 'astro' }, cards: ['astro'] };
    const localFinding = { ...titleFinding, id: 'M19.nap.inconsistent', module: 'M19', title: 'Business address differs between pages' };
    const out = await I.plan({ report: { target: report.target, findings: [localFinding] }, profile: astro }, { run, dataDir });
    const body = out.changes[0].preview.body;
    assert.match(body, /general paths from this platform card/);
    assert.match(body, /astro\.md §11/);
    assert.match(body, /src\/layouts/);

    // where the card *does* have the right path, it is used as a specific one
    const headMatch = await I.plan({ report: { target: report.target, findings: [titleFinding] }, profile: astro }, { run, dataDir });
    assert.ok(!headMatch.changes[0].preview.body.includes('general paths'), 'the astro head path is a real match for M7');

    const generic = I.pathsForModule(I.manualPathsFor(astro), 'M19');
    assert.ok(generic.length > 0 && generic.every((p) => p.generic === true));
    const specific = I.pathsForModule(I.manualPathsFor({ cards: ['shopify'] }), 'M7');
    assert.ok(specific.some((p) => /SEO title/i.test(p.label || '')));
    assert.ok(!specific.some((p) => p.generic), 'a real topic match is never labelled general');
  } finally { cleanup(); }
});

test('groupFindings honours --category and skips proposed when asked', () => {
  const findings = [titleFinding, redirectFinding, { ...titleFinding, id: 'M7.b', fixable: 'auto', module: 'M7' }];
  assert.equal(I.groupFindings(findings).length, 2);
  assert.equal(I.groupFindings(findings, { includeProposed: false }).length, 1);
  assert.deepEqual(I.groupFindings(findings, { category: 'M3' }).map((g) => g.module), ['M3']);
  assert.deepEqual(I.groupFindings([{ ...titleFinding, status: 'pass' }]), []);
});

test('apply hands the change to the user and says so; verify never claims a pass', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await I.plan({ report, profile, lang: 'en' }, { run, dataDir });
    const change = out.changes[0];

    const previewed = await I.preview(change, { run });
    assert.equal(previewed.change.status, 'previewed');
    assert.ok(existsSync(run.previewPath(change.id, '.md')));

    const applied = await I.apply(previewed.change, { run });
    assert.equal(applied.ok, true);
    assert.equal(applied.change.status, 'applied');
    assert.equal(applied.change.applied_by, 'user');
    assert.match(applied.note, /nothing was written/);

    const verified = await I.verify(applied.change, { run });
    assert.equal(verified.ok, null, 'a manual change is never auto-verified');
    assert.equal(verified.status, 'manual_review');
    assert.equal(verified.change.status, 'applied', 'the status does not move to verified');

    const rolled = await I.rollback(applied.change, { run });
    assert.equal(rolled.ok, false);
    assert.equal(rolled.change.status, 'applied', 'nothing was written, so nothing is rolled back');
    assert.match(rolled.note, /nothing to undo/);
  } finally { cleanup(); }
});

test('CLI: capabilities is ready, plan writes previews, and an unknown op is a usage error', async () => {
  const { base, dataDir, cleanup } = sandbox();
  try {
    const caps = await I.main({ _: ['capabilities'], data: dataDir });
    assert.equal(caps.code, 0);
    assert.equal(caps.result.ready, true);
    assert.deepEqual(caps.result.needs, []);
    assert.match(caps.result.writes, /nothing/);

    const reportPath = join(base, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const planned = await I.main({ _: ['plan'], data: dataDir, report: reportPath, lang: 'es' });
    assert.equal(planned.code, 0);
    assert.equal(planned.result.lang, 'es');
    assert.equal(planned.result.changes.length, 2);
    const runDir = planned.result.run_dir;
    const changeId = planned.result.changes[0].id;
    assert.ok(existsSync(join(runDir, 'preview', changeId + '.md')));
    assert.match(readFileSync(join(runDir, 'preview', changeId + '.md'), 'utf8'), /Hazlo a mano/);

    const applied = await I.main({ _: ['apply'], data: dataDir, run: runDir, change: changeId });
    assert.equal(applied.result.results[0].status, 'applied');
    const stored = A.loadFixRun(runDir).readPlan().changes.find((c) => c.id === changeId);
    assert.equal(stored.status, 'applied');

    const bad = await I.main({ _: ['nope'], data: dataDir });
    assert.equal(bad.code, 1);
    assert.match(bad.result.error, /usage: instructions/);
    const noReport = await I.main({ _: ['plan'], data: dataDir });
    assert.equal(noReport.code, 1);
  } finally { cleanup(); }
});

test('every platform card that exists has a parsable section 11', () => {
  const ids = ['shopify', 'wordpress', 'nextjs', 'wix', 'squarespace', 'webflow', 'ghost', 'hubspot', 'bigcommerce', 'hugo', 'jekyll', 'astro', 'sveltekit', 'static'];
  for (const id of ids) {
    const card = I.readCard(id);
    if (!card) continue;
    const entries = I.parseManualPaths(card.text);
    assert.ok(entries.length > 0, id + '.md section 11 should yield at least one manual path');
    for (const e of entries) assert.ok(e.en && e.es, id + '.md must carry both languages for "' + (e.label || e.en) + '"');
  }
});
