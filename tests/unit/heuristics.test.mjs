// The three content heuristics (check-answerblocks, factdensity, check-freshness) on top of
// lib/passages.mjs + lib/lang.mjs: Spanish coverage, div-only markup, the boilerplate policy,
// numeric classification, date normalization and the manual_review path for unsupported languages.
// Fixtures are synthetic (tests/fixtures/blog-post-es.html, div-only-landing.html, blog-post.html).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tokenize } from '../../scripts/lib/html.mjs';
import {
  contentMask, visibleText, headingsOf, passages, passagesByTag, answerAfterHeading, classifyNumbers, hasBlockChild, wordCount,
  PASSAGE_TAGS, ANSWER_KINDS, DIRECT_ANSWER_MIN_WORDS,
} from '../../scripts/lib/passages.mjs';
import { analyzeAnswerBlocks, main as answerMain } from '../../scripts/check-answerblocks.mjs';
import { analyzeFactDensity, outboundHosts, main as factMain } from '../../scripts/factdensity.mjs';
import { analyzeFreshness, collectSchemaDates, main as freshMain } from '../../scripts/check-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FIX = resolve(ROOT, 'tests', 'fixtures');
const ES = resolve(FIX, 'blog-post-es.html');
const DIV = resolve(FIX, 'div-only-landing.html');
const EN = resolve(FIX, 'blog-post.html');
const ES_HTML = readFileSync(ES, 'utf8');

function run(script, args) {
  return JSON.parse(execFileSync(process.execPath, [resolve(ROOT, 'scripts', script), ...args], { encoding: 'utf8' }));
}
function memo(fn) { let v, done = false; return () => { if (!done) { v = fn(); done = true; } return v; }; }
const abEs = memo(() => run('check-answerblocks.mjs', ['--file', ES]));
const fdEs = memo(() => run('factdensity.mjs', ['--file', ES]));
const frEs = memo(() => run('check-freshness.mjs', ['--file', ES]));
const abDiv = memo(() => run('check-answerblocks.mjs', ['--file', DIV]));
const fdDiv = memo(() => run('factdensity.mjs', ['--file', DIV]));
const abXx = memo(() => run('check-answerblocks.mjs', ['--file', ES, '--lang', 'xx']));
const fdXx = memo(() => run('factdensity.mjs', ['--file', ES, '--lang', 'xx']));
const frXx = memo(() => run('check-freshness.mjs', ['--file', ES, '--lang', 'xx']));
const abEn = memo(() => run('check-answerblocks.mjs', ['--file', EN]));
const fdEn = memo(() => run('factdensity.mjs', ['--file', EN]));
const frEn = memo(() => run('check-freshness.mjs', ['--file', EN]));

const doc = (body, head = '', lang = 'en') => `<!doctype html><html lang="${lang}"><head><title>ZTITLE</title>${head}</head><body>${body}</body></html>`;
const LONG = 'palabra '.repeat(20).trim(); // 20 words

describe('boilerplate policy (lib/passages contentMask)', () => {
  it('strips nav/footer/aside (tags and roles) and <head>, keeps main content', () => {
    const t = tokenize(doc('<div role="navigation"><a href="/">x</a></div><main><p>Kept text here for sure.</p></main><aside><p>Ad copy that must go.</p></aside><footer><p>Footer text must go.</p></footer>'));
    const m = contentMask(t);
    assert.deepEqual(m.stripped, { nav: 1, footer: 1, aside: 1, header: 0 });
    assert.equal(m.has_content_root, true);
    const text = visibleText(t, { mask: m });
    assert.ok(text.includes('Kept text here')); assert.ok(!text.includes('Ad copy')); assert.ok(!text.includes('Footer text')); assert.ok(!text.includes('ZTITLE'), 'title is not content');
  });
  it('keeps a <header> inside <article>/<main> (the h1 survives)', () => {
    const t = tokenize(doc('<main><article><header><h1>Title kept</h1></header><p>Body text of the article here.</p></article></main>'));
    const m = contentMask(t);
    assert.equal(m.stripped.header, 0);
    assert.deepEqual(headingsOf(t, { mask: m }).map((h) => h.text), ['Title kept']);
  });
  it('strips a <header> outside main/article when the page has a content root', () => {
    const t = tokenize(doc('<header><h1>Site name</h1><p>tagline words in the site header</p></header><main><h2>Real</h2><p>Body text of the page here.</p></main>'));
    const m = contentMask(t);
    assert.equal(m.stripped.header, 1);
    assert.deepEqual(headingsOf(t, { mask: m }).map((h) => h.text), ['Real']);
  });
  it('keeps a <header> that contains the h1 when there is no main/article at all (page-builder markup)', () => {
    const t = tokenize(doc('<header><h1>Hero title</h1><div>Hero copy with enough words to count as a passage.</div></header><header><div>Second header without h1 gets stripped away.</div></header><div><h2>Section</h2><div>Section copy with enough words to count too.</div></div>'));
    const m = contentMask(t);
    assert.equal(m.has_content_root, false);
    assert.equal(m.kept_header_with_h1, true);
    assert.equal(m.stripped.header, 1);
    const ps = passages(t, { mask: m });
    assert.ok(ps.some((p) => p.text.startsWith('Hero copy')));
    assert.ok(!ps.some((p) => p.text.startsWith('Second header')));
    assert.equal(headingsOf(t, { mask: m }).filter((h) => h.level === 1).length, 1);
  });
  it('script/style/noscript/template/svg content is never text', () => {
    const t = tokenize(doc('<main><script>var a = "the the the and of";</script><style>.x{}</style><noscript>Enable JS please now</noscript><template><p>Tpl words words words words</p></template><svg><text>svg words words words words</text></svg><p>Only this counts as content.</p></main>'));
    const ps = passages(t);
    assert.deepEqual(ps.map((p) => p.text), ['Only this counts as content.']);
  });
});

describe('passages (lib/passages)', () => {
  it('accepts p/li/dd/td/th/blockquote/summary and leaf divs; cells need 8 words', () => {
    assert.deepEqual([...PASSAGE_TAGS].sort(), ['blockquote', 'dd', 'div', 'li', 'p', 'summary', 'td', 'th']);
    const t = tokenize(doc(`<main>
      <p>One two three four five.</p><p>Too short.</p>
      <ul><li>Item with five words here.</li><li>Nested container: <ul><li>Inner item with five words.</li></ul></li></ul>
      <dl><dt>Term</dt><dd>Definition with five words here.</dd></dl>
      <table><tr><th>Short header</th><td>Cell with seven words only here x</td></tr><tr><td>A cell with eight words exactly right here now.</td></tr></table>
      <blockquote>Quote with at least five words.</blockquote>
      <details><summary>Summary with at least five words.</summary><p>Details body with five words.</p></details>
      <div class="wrap"><div>Leaf div with five words.</div><div><p>Div holding a p is a container.</p></div></div>
    </main>`));
    const ps = passages(t);
    const by = passagesByTag(ps);
    assert.deepEqual(by, { p: 3, li: 2, dd: 1, td: 1, th: 0, blockquote: 1, summary: 1, div: 1 });
    assert.ok(!ps.some((p) => p.text.startsWith('Nested container')), 'li with a nested list is a container');
    assert.ok(!ps.some((p) => p.text.startsWith('Cell with seven')), 'td below 8 words is dropped');
    assert.ok(ps.some((p) => p.tag === 'td' && p.text.startsWith('A cell with eight')));
    assert.equal(ps.filter((p) => p.tag === 'div').length, 1, 'no double counting of container divs');
    assert.equal(hasBlockChild(t, t.findIndex((x) => x.kind === 'open' && x.name === 'blockquote')), false);
  });
  it('records heading_before and word counts', () => {
    const t = tokenize(doc('<main><h2>Q?</h2><p>Alpha beta gamma delta epsilon.</p></main>'));
    const [p] = passages(t);
    assert.equal(p.heading_before, 'Q?'); assert.equal(p.heading_level, 2); assert.equal(p.words, 5);
    assert.equal(wordCount('  a  b   c '), 3); assert.equal(wordCount(''), 0);
  });
});

describe('answerAfterHeading (lib/passages)', () => {
  const answer = (body, lang = 'es') => {
    const t = tokenize(doc(body, '', lang));
    const hs = headingsOf(t);
    return answerAfterHeading(t, hs[0].index, { stopIdx: hs[1] ? hs[1].index : undefined, lang });
  };
  it('paragraph needs >= 15 words and no wind-up', () => {
    assert.equal(DIRECT_ANSWER_MIN_WORDS, 15);
    const a = answer(`<main><h2>¿Qué es?</h2><p>${LONG}</p></main>`);
    assert.equal(a.kind, 'paragraph'); assert.equal(a.words, 20); assert.equal(a.has_direct_answer, true); assert.equal(a.windup, false);
    const short = answer('<main><h2>¿Qué es?</h2><p>Muy corto para servir de respuesta directa.</p></main>');
    assert.equal(short.has_direct_answer, false);
    const w = answer(`<main><h2>¿Qué es?</h2><p>En esta guía veremos ${LONG}</p></main>`);
    assert.equal(w.windup, true); assert.equal(w.has_direct_answer, false);
  });
  it('list with >= 2 items is a direct answer even when short; 1 item is not', () => {
    const a = answer('<main><h2>¿Qué incluye?</h2><ul><li>Envío gratis.</li><li>Devolución en 30 días.</li></ul></main>');
    assert.equal(a.kind, 'list'); assert.equal(a.items, 2); assert.equal(a.has_direct_answer, true);
    const one = answer('<main><h2>¿Qué incluye?</h2><ul><li>Envío gratis.</li></ul></main>');
    assert.equal(one.items, 1); assert.equal(one.has_direct_answer, false);
  });
  it('table (>= 2 rows), definition list, leaf div, bare text and code are recognized', () => {
    const tbl = answer('<main><h2>¿Cuánto cuesta?</h2><table><tr><th>Plan</th><th>Precio</th></tr><tr><td>Básico</td><td>79,99 €</td></tr></table></main>');
    assert.equal(tbl.kind, 'table'); assert.equal(tbl.rows, 2); assert.equal(tbl.has_direct_answer, true);
    const dl = answer(`<main><h2>¿Qué es?</h2><dl><dt>GEO</dt><dd>${LONG}</dd></dl></main>`);
    assert.equal(dl.kind, 'definition'); assert.equal(dl.items, 1); assert.equal(dl.has_direct_answer, true);
    const dv = answer(`<main><h2>¿Qué es?</h2><div class="wrap"><div class="inner">${LONG}</div></div></main>`);
    assert.equal(dv.kind, 'div'); assert.equal(dv.has_direct_answer, true);
    const tx = answer(`<main><h2>¿Qué es?</h2>${LONG}<br>más<h2>Otra</h2><p>x</p></main>`);
    assert.equal(tx.kind, 'text'); assert.equal(tx.has_direct_answer, true);
    const code = answer('<main><h2>¿Cómo se instala?</h2><pre>npm install x</pre></main>');
    assert.equal(code.kind, 'code'); assert.equal(code.has_direct_answer, false);
    assert.deepEqual(ANSWER_KINDS, ['paragraph', 'list', 'table', 'div', 'definition', 'text', 'code', 'none']);
  });
  it('a heading followed by another heading, or by an image/figure only, has no answer', () => {
    const none = answer('<main><h2>¿Qué es?</h2><h3>Sub</h3><p>Texto.</p></main>');
    assert.equal(none.kind, 'none'); assert.equal(none.has_direct_answer, false);
    const fig = answer('<main><h2>¿Qué es?</h2><figure><img src="x.png" alt="a"><figcaption>Caption words here five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen</figcaption></figure><h2>Next</h2></main>');
    assert.equal(fig.kind, 'none');
  });
  it('stripped regions never supply the answer; unsupported language -> null verdicts', () => {
    const a = answer(`<main><h2>¿Qué es?</h2><aside><p>${LONG}</p></aside><p>Respuesta corta.</p></main>`);
    assert.equal(a.kind, 'paragraph'); assert.equal(a.text, 'Respuesta corta.');
    const fr = answer(`<main><h2>Quoi ?</h2><p>${LONG}</p></main>`, 'fr');
    assert.equal(fr.kind, 'paragraph'); assert.equal(fr.words, 20);
    assert.equal(fr.has_direct_answer, null); assert.equal(fr.windup, null); assert.equal(fr.anaphoric, null);
  });
});

describe('classifyNumbers (lib/passages)', () => {
  it('ES formats: "41 %", "79,99 €", "1.200", years, dates', () => {
    const n = classifyNumbers('El 41 % de las 1.200 tiendas paga 79,99 € al mes; publicado el 10 de enero de 2026 y en 2025 creció 2 millones. Precio: MXN 1,500.', { lang: 'es' });
    assert.equal(n.percentages, 1); assert.equal(n.prices, 2); assert.equal(n.dates, 1); assert.equal(n.years, 1);
    assert.equal(n.substantive, 3, '41 %, 1.200, 2 millones');
    assert.equal(n.all, n.dates + n.prices + n.years + n.substantive);
    assert.deepEqual(n.sample.filter((s) => s.kind === 'price').map((s) => s.raw), ['79,99 €', 'MXN 1,500']);
  });
  it('EN formats and exclusions: $ prices, 1,200, 3.5x, GPT-4 / H2 / 2xl / v2 / times / list markers ignored', () => {
    const n = classifyNumbers('1. Our 2026 survey of 1,200 pages found 41% more citations; it costs $79.99 (about 2 mil pesos) and is 3.5x faster than GPT-4 on H2 at 10:30, size 2xl, v2 API, on January 10, 2026.', { lang: 'en' });
    assert.equal(n.years, 1); assert.equal(n.dates, 1); assert.equal(n.prices, 2); assert.equal(n.percentages, 1);
    assert.deepEqual(n.sample.filter((s) => s.kind === 'number').map((s) => s.raw), ['1,200', '3.5x']);
    assert.equal(n.substantive, 3);
  });
  it('an ISO date is one date token, not a year plus two numbers; empty text -> zeros', () => {
    const n = classifyNumbers('Updated 2026-01-10 and 10/01/2026.', { lang: 'en' });
    assert.equal(n.dates, 2); assert.equal(n.years, 0); assert.equal(n.substantive, 0); assert.equal(n.all, 2);
    assert.deepEqual(classifyNumbers('', {}), { all: 0, years: 0, prices: 0, dates: 0, percentages: 0, substantive: 0, sample: [] });
  });
  it('digits are counted even when the language is unknown', () => {
    const n = classifyNumbers('Prix 79,99 € et 41 % en 2026', { lang: 'unknown' });
    assert.equal(n.prices, 1); assert.equal(n.percentages, 1); assert.equal(n.years, 1);
  });
});

describe('check-answerblocks.mjs', () => {
  it('Spanish fixture: detects es and counts the div-based question answer, anaphora, TL;DR and passages', () => {
    const r = abEs();
    assert.deepEqual(r.lang, { detected: 'es', source: 'html-lang', confidence: 'high', supported: true });
    assert.equal(r.question_headings, 1);
    assert.equal(r.question_headings_without_direct_answer, 1);
    assert.equal(r.details[0].heading, '¿Qué es el GEO?');
    assert.equal(r.details[0].answer_kind, 'div');
    assert.equal(r.details[0].windup, true, '"En esta guía veremos…" is a wind-up');
    assert.ok(r.details[0].answer_words >= 15, 'the div answer was read (' + r.details[0].answer_words + ' words)');
    assert.equal(r.answers_by_kind.div, 1);
    assert.equal(r.anaphora_openers, 1, '"Como mencionamos antes, …"');
    assert.equal(r.has_tldr_or_summary, true, 'the "Resumen" block');
    assert.ok(r.passages >= 3, 'passages ' + r.passages);
    assert.ok(r.passages_by_tag.li >= 2 && r.passages_by_tag.p >= 2 && r.passages_by_tag.div >= 1);
    assert.equal(r.headings.h1, 1, 'the h1 inside <article><header> is retained');
    assert.equal(r.language_dependent_checks, 'evaluated');
    assert.equal(r.long_passages_over_250w, 0);
  });
  it('div-only landing page: passages > 0, the header h1 is kept, question answers come from divs', () => {
    const r = abDiv();
    assert.ok(r.passages > 0);
    assert.equal(r.passages_by_tag.p, 0); assert.ok(r.passages_by_tag.div >= 4);
    assert.equal(r.headings.h1, 1);
    assert.equal(r.boilerplate.kept_header_with_h1, true);
    assert.equal(r.boilerplate.has_content_root, false);
    assert.equal(r.question_headings, 2);
    assert.equal(r.answers_by_kind.div, 2);
    const cost = r.details.find((d) => d.heading === 'What does it cost?');
    assert.equal(cost.has_direct_answer, true);
  });
  it('--lang xx: language-dependent fields are null (never 0) and the checks are manual_review', () => {
    const r = abXx();
    assert.deepEqual(r.lang, { detected: 'xx', source: 'flag', confidence: 'high', supported: false });
    for (const k of ['question_headings', 'question_headings_without_direct_answer', 'answers_in_40_60_band', 'anaphora_openers', 'has_tldr_or_summary', 'answers_by_kind']) assert.equal(r[k], null, k);
    assert.deepEqual(r.details, []);
    assert.equal(r.headings.question, null);
    assert.equal(typeof r.passages, 'number'); assert.ok(r.passages > 0, 'structure-only counts stay numeric');
    assert.equal(r.language_dependent_checks, 'manual_review');
    assert.match(r.note, /manual review/);
  });
  it('legacy English keys and values are unchanged', () => {
    const r = abEn();
    for (const k of ['source', 'question_headings', 'question_headings_without_direct_answer', 'answers_in_40_60_band', 'details', 'passages', 'long_passages_over_250w', 'anaphora_openers', 'has_tldr_or_summary']) assert.ok(k in r, k);
    assert.equal(r.question_headings, 3); assert.equal(r.question_headings_without_direct_answer, 1); assert.equal(r.anaphora_openers, 1);
    assert.equal(r.passages, 3); assert.equal(r.has_tldr_or_summary, false);
    for (const k of ['heading', 'answer_words', 'has_direct_answer', 'in_target_band', 'windup']) assert.ok(k in r.details[0], k);
  });
  it('--lang es on the English fixture forces the Spanish lexicon (flag precedence)', () => {
    const r = analyzeAnswerBlocks(readFileSync(EN, 'utf8'), { lang: 'es' });
    assert.equal(r.lang.detected, 'es'); assert.equal(r.lang.source, 'flag');
    assert.equal(r.question_headings, 3, 'the trailing ? still marks the headings as questions');
    assert.equal(r.anaphora_openers, 0, '"As mentioned above" is not Spanish anaphora');
  });
  it('main(): missing input is USAGE (1), a fetch failure is RUNTIME (2)', async () => {
    const none = await answerMain({});
    assert.equal(none.code, 1); assert.equal(typeof none.result.error, 'string');
    const bad = await answerMain({ file: resolve(FIX, 'does-not-exist.html') });
    assert.equal(bad.code, 1);
    const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'check-answerblocks.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.equal(typeof JSON.parse(r.stdout).error, 'string');
  });
});

describe('factdensity.mjs', () => {
  it('Spanish fixture: numeric detail, substantive density, hostname-matched authority hosts deduped per host', () => {
    const r = fdEs();
    assert.equal(r.lang.detected, 'es');
    assert.equal(r.numeric_tokens, r.numeric_tokens_detail.all, 'numeric_tokens stays the total for compatibility');
    const d = r.numeric_tokens_detail;
    assert.deepEqual(Object.keys(d), ['all', 'years', 'prices', 'dates', 'percentages', 'substantive']);
    assert.equal(d.prices, 2, '79,99 € and 149,00 €'); assert.equal(d.percentages, 1, '41 %'); assert.equal(d.dates, 2);
    assert.ok(d.substantive >= 2, '41 % and 1.200');
    assert.equal(d.all, d.years + d.prices + d.dates + d.substantive);
    assert.equal(r.numeric_density_per_100w, +(100 * d.substantive / r.content_words).toFixed(2));
    assert.deepEqual(r.authority_hosts, ['schema.org', 'www.inegi.org.mx']);
    assert.equal(r.authoritative_outbound_links, 2);
    assert.equal(r.original_data_signal, true, '"Nuestro análisis de 1.200 fichas…"');
    assert.equal(r.superlative_or_vague_authority_claims, 0, 'the aside superlative was stripped');
    assert.equal(r.language_dependent_checks, 'evaluated');
    assert.ok(r.passages >= 3);
  });
  it('div-only landing page has content words and passages', () => {
    const r = fdDiv();
    assert.ok(r.content_words > 50); assert.ok(r.passages >= 4); assert.equal(r.passages_by_tag.p, 0);
    assert.equal(r.numeric_tokens_detail.prices, 2); assert.equal(r.original_data_signal, true);
  });
  it('--lang xx: language-dependent fields null, numeric counts stay numeric', () => {
    const r = fdXx();
    assert.equal(r.lang.supported, false);
    assert.equal(r.original_data_signal, null); assert.equal(r.superlative_or_vague_authority_claims, null);
    assert.equal(typeof r.numeric_tokens, 'number'); assert.ok(r.numeric_tokens > 0);
    assert.equal(r.language_dependent_checks, 'manual_review');
  });
  it('legacy English keys and values are unchanged', () => {
    const r = fdEn();
    for (const k of ['source', 'content_words', 'numeric_tokens', 'numeric_density_per_100w', 'passages', 'passages_30w_plus_with_no_numbers', 'original_data_signal', 'superlative_or_vague_authority_claims', 'authoritative_outbound_links', 'note']) assert.ok(k in r, k);
    assert.equal(r.original_data_signal, true); assert.ok(r.numeric_tokens > 0); assert.equal(r.authoritative_outbound_links, 1);
    assert.deepEqual(r.authority_hosts, ['schema.org']);
  });
  it('authority is matched on the hostname only, deduped per host, internal links excluded', () => {
    const html = doc('<main><p>Sources: <a href="https://example.com/wikipedia.org/x">trick</a>, <a href="https://en.wikipedia.org/a">w1</a>, <a href="https://en.wikipedia.org/b">w2</a>, <a href="https://datos.gob.mx/x">gob</a>, <a href="/internal">in</a>, <a href="https://www.mysite.test/self">self</a>, <a href="mailto:x@nih.gov">mail</a>.</p></main>');
    const r = analyzeFactDensity(html, { url: 'https://mysite.test/page' });
    assert.deepEqual(r.authority_hosts, ['datos.gob.mx', 'en.wikipedia.org']);
    assert.equal(r.authoritative_outbound_links, 2);
    assert.equal(r.outbound_links.total, 4); assert.equal(r.outbound_links.distinct_hosts, 3);
    const o = outboundHosts([{ scheme: 'http', abs: 'https://a.test/' }, { scheme: 'mailto', abs: null }], null);
    assert.equal(o.total, 1);
  });
  it('main(): missing input is USAGE (1)', async () => {
    const none = await factMain({});
    assert.equal(none.code, 1);
  });
});

describe('check-freshness.mjs', () => {
  it('Spanish fixture: visible ES dates, labeled dates, article:* metas, script bodies ignored', () => {
    const r = frEs();
    assert.equal(r.lang.detected, 'es');
    assert.equal(r.schema_datePublished, '2026-01-10'); assert.equal(r.schema_dateModified, '2026-03-03'); assert.equal(r.has_dateModified, true);
    assert.equal(r.visible_date_sample, '10 de enero de 2026');
    assert.deepEqual(r.visible_dates.map((d) => d.iso), ['2026-01-10', '2026-03-03']);
    assert.ok(!r.visible_dates.some((d) => d.raw.includes('2018') || d.raw.includes('2019')), 'script bodies never count');
    assert.ok(!r.visible_dates.some((d) => d.raw.includes('2020') || d.raw === '12/12/2025'), 'aside/footer dates are boilerplate');
    assert.deepEqual(r.labeled_dates, { published: '2026-01-10', updated: '2026-03-03' });
    assert.equal(r.meta_published_time, '2026-01-10T09:00:00-06:00'); assert.equal(r.meta_modified_time, '2026-03-03T12:30:00-06:00');
    assert.equal(r.meta_dates.modified_time_iso, '2026-03-03');
    assert.equal(r.meta_vs_schema_modified_mismatch, null); assert.equal(r.visible_vs_schema_modified_mismatch, null);
    assert.deepEqual(r.schema_date_unparseable, []); assert.equal(r.modified_dates_conflict, false);
    assert.equal(r.language_dependent_checks, 'evaluated');
  });
  it('--lang xx: only neutral (ISO) visible dates, labeled dates null, manual_review', () => {
    const r = frXx();
    assert.equal(r.lang.supported, false);
    assert.equal(r.labeled_dates, null);
    assert.deepEqual(r.visible_dates, [], 'the Spanish month names are not read without a lexicon');
    assert.equal(r.visible_date_sample, null);
    assert.equal(r.schema_datePublished, '2026-01-10', 'schema dates are language-neutral');
    assert.equal(r.language_dependent_checks, 'manual_review');
  });
  it('legacy English keys and values are unchanged', () => {
    const r = frEn();
    for (const k of ['source', 'schema_datePublished', 'schema_dateModified', 'has_dateModified', 'time_datetime_tags', 'visible_date_sample', 'http_last_modified', 'modified_age_days', 'published_age_days', 'schema_vs_lastmodified_mismatch', 'note']) assert.ok(k in r, k);
    assert.equal(r.schema_datePublished, '2026-01-10'); assert.equal(r.has_dateModified, false); assert.equal(r.visible_date_sample, 'January 10, 2026');
    assert.deepEqual(r.time_datetime_tags, ['2026-01-10']);
  });
  const ld = (published, modified, extra = '') => doc('<main><p>Body text here.</p></main>', `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","datePublished":${JSON.stringify(published)}${modified === undefined ? '' : ',"dateModified":' + JSON.stringify(modified)}}</script>${extra}`);
  it('schema_vs_lastmodified_mismatch compares normalized dates (offset-aware) and reports both readings', () => {
    const now = Date.parse('2026-09-05T00:00:00Z');
    const same = analyzeFreshness(ld('2026-01-10', '2026-03-03'), { headers: { 'last-modified': 'Tue, 03 Mar 2026 18:00:00 GMT' }, now });
    assert.equal(same.schema_vs_lastmodified_mismatch, null);
    assert.equal(same.http_last_modified_iso, '2026-03-03');
    assert.equal(same.modified_age_days, 186); assert.equal(same.published_age_days, 238);
    const diff = analyzeFreshness(ld('2026-01-10', '2026-03-03'), { headers: { 'last-modified': 'Wed, 04 Mar 2026 18:00:00 GMT' } });
    assert.deepEqual(diff.schema_vs_lastmodified_mismatch, { schema: '2026-03-03', schema_iso: '2026-03-03', header: 'Wed, 04 Mar 2026 18:00:00 GMT', header_iso: '2026-03-04' });
    const tz = analyzeFreshness(ld('2026-01-10', '2026-03-03T23:30:00-06:00'), { headers: { 'last-modified': 'Wed, 04 Mar 2026 05:30:00 GMT' } });
    assert.equal(tz.schema_vs_lastmodified_mismatch, null, 'same instant across the UTC day boundary is not a mismatch');
  });
  it('an unparseable schema date is reported, never turned into a false mismatch', () => {
    const r = analyzeFreshness(ld('2026-01-10', 'hace dos semanas'), { headers: { 'last-modified': 'Tue, 03 Mar 2026 18:00:00 GMT' }, lang: 'es' });
    assert.equal(r.schema_vs_lastmodified_mismatch, null);
    assert.deepEqual(r.schema_date_unparseable, [{ field: 'dateModified', value: 'hace dos semanas' }]);
    assert.equal(r.schema_dateModified, 'hace dos semanas', 'raw value is still surfaced'); assert.equal(r.schema_dateModified_iso, null);
    assert.equal(r.has_dateModified, true); assert.equal(r.modified_age_days, null);
  });
  it('multiple dateModified values: all listed, the latest wins, conflict flagged; earliest datePublished wins', () => {
    const html = doc('<main><p>Body.</p></main>', '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","datePublished":"2026-01-12","dateModified":"2026-02-01"},{"@type":"WebPage","datePublished":"2026-01-10","dateModified":"2026-03-03T10:00:00Z"}]}</script>');
    const r = analyzeFreshness(html, {});
    assert.deepEqual(r.all_modified_dates, ['2026-02-01', '2026-03-03T10:00:00Z']);
    assert.equal(r.schema_dateModified, '2026-03-03T10:00:00Z'); assert.equal(r.schema_dateModified_iso, '2026-03-03');
    assert.equal(r.modified_dates_conflict, true);
    assert.equal(r.schema_datePublished, '2026-01-10'); assert.equal(r.published_dates_conflict, true);
    assert.equal(r.modified_before_published, false);
    const dup = analyzeFreshness(doc('<main><p>Body.</p></main>', '<script type="application/ld+json">[{"@type":"Article","dateModified":"2026-03-03"},{"@type":"WebPage","dateModified":"2026-03-03"}]</script>'), {});
    assert.equal(dup.modified_dates_conflict, false, 'identical values are not a conflict');
    assert.deepEqual(collectSchemaDates({ a: { datePublished: '2026-01-01', nested: [{ dateModified: '2026-02-02' }] } }), { published: ['2026-01-01'], modified: ['2026-02-02'] });
  });
  it('ES numeric d/m/y is read DMY and flagged ambiguous; EN reads MDY', () => {
    const es = analyzeFreshness(doc('<main><p>Publicado: 05/02/2026</p></main>', '', 'es'), {});
    assert.deepEqual(es.visible_dates[0], { raw: '05/02/2026', iso: '2026-02-05', format: 'numeric', ambiguous: true });
    assert.equal(es.labeled_dates.published, '2026-02-05');
    const en = analyzeFreshness(doc('<main><p>Published: 05/02/2026</p></main>', '', 'en'), {});
    assert.equal(en.visible_dates[0].iso, '2026-05-02');
  });
  it('falls back to the full page text when the content region has no visible date', () => {
    const r = analyzeFreshness(doc('<header><p>Updated January 3, 2026</p></header><main><p>No dates in the body text.</p></main>'), {});
    assert.equal(r.visible_date_scope, 'full'); assert.equal(r.visible_date_sample, 'January 3, 2026');
  });
  it('main(): missing input is USAGE (1); --file reports no HTTP header', async () => {
    const none = await freshMain({});
    assert.equal(none.code, 1);
    const ok = await freshMain({ file: ES });
    assert.equal(ok.code, 0); assert.equal(ok.result.source, 'file'); assert.equal(ok.result.http_last_modified, null);
  });
});

describe('ES fixture shape (guards against fixture drift)', () => {
  it('has the markers the language tests rely on', () => {
    assert.match(ES_HTML, /<html lang="es">/);
    assert.match(ES_HTML, /<article>\s*<header>\s*<h1>/);
    assert.match(ES_HTML, /¿Qué es el GEO\?/); assert.match(ES_HTML, /En esta guía veremos/); assert.match(ES_HTML, /Como mencionamos antes,/);
    assert.match(ES_HTML, /<h2>Resumen<\/h2>/); assert.match(ES_HTML, /10 de enero de 2026/); assert.match(ES_HTML, /79,99 €/); assert.match(ES_HTML, /41 %/);
    assert.match(ES_HTML, /https:\/\/www\.inegi\.org\.mx\//);
  });
});
