// lib/lang.mjs: language detection precedence, EN/ES lexicon predicates, hostname-only authority
// rules and date parsing. All inputs are synthetic strings.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_LANGS, LEXICON, AUTHORITY_HOST_RULES, detectLang, normalizeLangTag, guessLangFromText, lexiconFor,
  isQuestionHeading, isWindup, isAnaphoric, hasTldrMarker, isAuthorityHost, hostnameOf,
  findDates, parseDate, findLabeledDates, monthIndex,
} from '../../scripts/lib/lang.mjs';

const page = (head, body = '', attrs = '') => `<!doctype html><html${attrs}><head>${head}</head><body>${body}</body></html>`;
const ES_TEXT = '<p>El GEO es la práctica de estructurar el contenido para que los motores de respuesta lo citen. En esta guía vemos cómo hacerlo con datos y con ejemplos de la tienda, por qué importa y qué medir.</p>';
const EN_TEXT = '<p>The practice of structuring content so that answer engines can cite it is what we cover in this guide, with data and examples from the store and what to measure.</p>';

describe('detectLang precedence', () => {
  it('--lang flag wins over everything', () => {
    const d = detectLang(page('', ES_TEXT, ' lang="es"'), { flag: 'en' });
    assert.deepEqual(d, { lang: 'en', tag: 'en', source: 'flag', confidence: 'high', supported: true });
  });
  it('an unsupported --lang is reported as its own tag, unsupported', () => {
    const d = detectLang(page('', ES_TEXT, ' lang="es"'), { flag: 'xx' });
    assert.equal(d.lang, 'unknown'); assert.equal(d.tag, 'xx'); assert.equal(d.source, 'flag'); assert.equal(d.supported, false);
  });
  it('--lang auto and a bare --lang (true) fall through to the page', () => {
    assert.equal(detectLang(page('', '', ' lang="es-MX"'), { flag: 'auto' }).source, 'html-lang');
    assert.equal(detectLang(page('', '', ' lang="es-MX"'), { flag: true }).lang, 'es');
  });
  it('<html lang> primary subtag (es-MX, es_ES, ES) is high confidence', () => {
    for (const tag of ['es-MX', 'es_ES', 'ES', 'es-419']) {
      const d = detectLang(page('', EN_TEXT, ` lang="${tag}"`));
      assert.equal(d.lang, 'es', tag); assert.equal(d.source, 'html-lang'); assert.equal(d.confidence, 'high');
    }
  });
  it('a declared but unsupported language (fr) beats the heuristic and is unsupported', () => {
    const d = detectLang(page('', ES_TEXT, ' lang="fr"'));
    assert.equal(d.lang, 'unknown'); assert.equal(d.tag, 'fr'); assert.equal(d.supported, false); assert.equal(d.source, 'html-lang');
  });
  it('content-language meta, then og:locale, then the stop-word heuristic', () => {
    assert.deepEqual(detectLang(page('<meta http-equiv="Content-Language" content="es-AR, en">', EN_TEXT)), { lang: 'es', tag: 'es', source: 'content-language', confidence: 'medium', supported: true });
    assert.deepEqual(detectLang(page('<meta property="og:locale" content="es_ES">', EN_TEXT)), { lang: 'es', tag: 'es', source: 'og-locale', confidence: 'medium', supported: true });
    const h = detectLang(page('', ES_TEXT));
    assert.equal(h.lang, 'es'); assert.equal(h.source, 'heuristic'); assert.equal(h.confidence, 'low');
    assert.equal(detectLang(page('', EN_TEXT)).lang, 'en');
  });
  it('no signal at all -> unknown / none, never a fabricated language', () => {
    assert.deepEqual(detectLang(page('', '<p>lorem ipsum dolor sit amet</p>')), { lang: 'unknown', tag: null, source: 'none', confidence: 'none', supported: false });
    assert.equal(detectLang(null).source, 'none');
  });
  it('script and style bodies do not feed the heuristic', () => {
    const d = detectLang(page('', '<script>var the = "the and of to in is that for with as on are this";</script><p>x</p>'));
    assert.equal(d.lang, 'unknown');
  });
  it('normalizeLangTag / guessLangFromText helpers', () => {
    assert.equal(normalizeLangTag(' EN-us '), 'en'); assert.equal(normalizeLangTag('zh-Hant-TW'), 'zh'); assert.equal(normalizeLangTag('x-default'), null);
    assert.equal(normalizeLangTag(''), null); assert.equal(normalizeLangTag('123'), null); assert.equal(normalizeLangTag(null), null);
    assert.equal(guessLangFromText('').lang, 'unknown');
    assert.equal(guessLangFromText('el la de que y en los las un una por para con').lang, 'es');
  });
});

describe('lexicons', () => {
  it('ship both languages with the same shape', () => {
    assert.deepEqual(SUPPORTED_LANGS, ['en', 'es']);
    for (const l of SUPPORTED_LANGS) {
      const lex = LEXICON[l];
      for (const k of ['question_words', 'question_re', 'declarative_exclusions', 'windup', 'anaphora_phrases', 'anaphora_pronouns', 'verbs', 'tldr_heading', 'tldr_text', 'months', 'month_abbr', 'date_labels', 'original_data', 'superlatives', 'generic_anchor', 'generic_anchors', 'stopwords']) {
        assert.ok(lex[k] != null, `${l}.${k}`);
      }
      assert.equal(lex.months.length, 12);
      assert.ok(lex.month_numbers instanceof Map && lex.month_numbers.get('sept') === 9);
      assert.equal(lexiconFor(l), lex);
    }
    assert.equal(lexiconFor('fr'), null); assert.equal(lexiconFor('unknown'), null);
  });
  it('ES question words cover the interrogatives, modal openers and "se puede"', () => {
    for (const w of ['qué', 'cómo', 'por qué', 'cuándo', 'dónde', 'quién', 'cuál', 'cuáles', 'puede', 'puedo', 'debo', 'debería', 'hay', 'se puede']) assert.ok(LEXICON.es.question_words.includes(w), w);
  });
  it('ES generic anchors and superlatives are present', () => {
    for (const a of ['aquí', 'haz clic', 'leer más', 'ver más', 'más']) assert.ok(LEXICON.es.generic_anchor.test(a), a);
    assert.ok(LEXICON.es.superlatives.test('somos la mejor agencia'));
    assert.ok(LEXICON.es.superlatives.test('los expertos coinciden en que'));
    assert.ok(!LEXICON.es.superlatives.test('una agencia con datos'));
  });
});

describe('question headings', () => {
  it('EN: legacy behaviour (question word or trailing ?) with declarative exclusions', () => {
    assert.equal(isQuestionHeading('What is generative engine optimization?', 'en'), true);
    assert.equal(isQuestionHeading('Why does structured data matter', 'en'), true);
    assert.equal(isQuestionHeading('How to Optimize for AI Search in 2026', 'en'), false);
    assert.equal(isQuestionHeading('What we do', 'en'), false);
    assert.equal(isQuestionHeading('Pricing', 'en'), false);
  });
  it('ES: ¿ or ? always count; accented interrogatives count; "Cómo + infinitivo" and "Quiénes somos" do not', () => {
    assert.equal(isQuestionHeading('¿Qué es el GEO?', 'es'), true);
    assert.equal(isQuestionHeading('¿Puedo devolver un producto', 'es'), true);
    assert.equal(isQuestionHeading('Qué es el GEO', 'es'), true);
    assert.equal(isQuestionHeading('Que es el GEO', 'es'), true);
    assert.equal(isQuestionHeading('Se puede pagar en cuotas', 'es'), true);
    assert.equal(isQuestionHeading('Por qué importan los datos', 'es'), true);
    assert.equal(isQuestionHeading('Cómo optimizar tu tienda', 'es'), false);
    assert.equal(isQuestionHeading('Cómo añadir un sitemap', 'es'), false);
    assert.equal(isQuestionHeading('Quiénes somos', 'es'), false);
    assert.equal(isQuestionHeading('Cuando el SEO no basta', 'es'), false, 'unaccented conjunction is not an interrogative');
    assert.equal(isQuestionHeading('La importancia de los datos estructurados', 'es'), false);
  });
  it('unsupported language -> null unless the punctuation makes it a question', () => {
    assert.equal(isQuestionHeading('Comment ça marche', 'fr'), null);
    assert.equal(isQuestionHeading('Comment ça marche ?', 'fr'), true);
  });
});

describe('wind-ups, anaphora, TL;DR', () => {
  it('wind-ups in both languages; null when unsupported', () => {
    assert.equal(isWindup("In this section we'll explore the steps.", 'en'), true);
    assert.equal(isWindup('Generative engine optimization is the practice of…', 'en'), false);
    assert.equal(isWindup('En esta guía veremos qué es el GEO.', 'es'), true);
    assert.equal(isWindup('A continuación repasamos los pasos.', 'es'), true);
    assert.equal(isWindup('Vamos a ver cómo funciona.', 'es'), true);
    assert.equal(isWindup('Veamos un ejemplo.', 'es'), true);
    assert.equal(isWindup('El GEO es la práctica de estructurar contenido.', 'es'), false);
    assert.equal(isWindup('Dans cette section…', 'fr'), null);
  });
  it('phrase anaphora always counts; bare pronouns only when a verb follows', () => {
    assert.equal(isAnaphoric('As mentioned above, it helps.', 'en'), true);
    assert.equal(isAnaphoric('This is why it matters.', 'en'), true);
    assert.equal(isAnaphoric('It also helps a lot.', 'en'), true);
    assert.equal(isAnaphoric('This guide covers the basics of GEO.', 'en'), false, 'This + noun is deictic, not anaphoric');
    assert.equal(isAnaphoric('These pages rank well.', 'en'), false);
    assert.equal(isAnaphoric('Como mencionamos antes, los datos ayudan.', 'es'), true);
    assert.equal(isAnaphoric('Esto es lo que importa.', 'es'), true);
    assert.equal(isAnaphoric('Esto no significa que debas ignorarlo.', 'es'), true);
    assert.equal(isAnaphoric('Esta guía explica el GEO.', 'es'), false);
    assert.equal(isAnaphoric('Los datos estructurados ayudan.', 'es'), false);
    assert.equal(isAnaphoric('Ceci est important.', 'fr'), null);
  });
  it('TL;DR markers: heading form (anchored) vs text form', () => {
    assert.equal(hasTldrMarker('Resumen', 'es', { heading: true }), true);
    assert.equal(hasTldrMarker('En pocas palabras', 'es', { heading: true }), true);
    assert.equal(hasTldrMarker('Un resumen de la historia del comercio', 'es'), false, 'a bare "resumen" inside prose is not a marker');
    assert.equal(hasTldrMarker('… y por eso. En resumen, el GEO importa.', 'es'), true);
    assert.equal(hasTldrMarker('Key takeaways', 'en', { heading: true }), true);
    assert.equal(hasTldrMarker('TL;DR: it works', 'en'), true);
    assert.equal(hasTldrMarker('Résumé', 'fr'), null);
  });
});

describe('authority hosts (hostname only)', () => {
  it('matches government, academic and named research hosts by hostname', () => {
    for (const h of ['datos.gob.mx', 'www.boe.es', 'www.gov.uk', 'ons.gov.uk', 'www.inegi.org.mx', 'scielo.org', 'www.scielo.org', 'redalyc.org', 'ec.europa.eu', 'unam.edu.mx', 'nih.gov', 'en.wikipedia.org', 'schema.org', 'developer.mozilla.org', 'docs.python.org', 'developers.google.com', 'www.who.int', 'arxiv.org', 'www.w3.org', 'example.edu', 'nasa.gov']) {
      assert.equal(isAuthorityHost(h), true, h);
    }
  });
  it('never matches inside the path or on look-alike hosts', () => {
    assert.equal(isAuthorityHost('https://example.com/wikipedia.org/x'), false);
    assert.equal(isAuthorityHost('https://example.com/?u=https://nih.gov'), false);
    assert.equal(isAuthorityHost('notschema.org'), false);
    assert.equal(isAuthorityHost('wikipedia.org.evil.com'), false);
    assert.equal(isAuthorityHost('govern.com'), false);
    assert.equal(isAuthorityHost('mydocs.example.com'), false, 'docs. must be the leading label');
    assert.equal(isAuthorityHost('mailto:a@nih.gov'), false);
    assert.equal(isAuthorityHost(''), false); assert.equal(isAuthorityHost(null), false);
  });
  it('accepts absolute URLs and exposes the rule table', () => {
    assert.equal(isAuthorityHost('https://www.inegi.org.mx/temas/comercio/'), true);
    assert.equal(hostnameOf('https://WWW.Example.COM./a'), 'www.example.com');
    assert.equal(hostnameOf('/relative'), null);
    assert.ok(AUTHORITY_HOST_RULES.length > 20);
    assert.ok(AUTHORITY_HOST_RULES.every((r) => r instanceof RegExp));
  });
});

describe('dates', () => {
  it('ES visible dates: "10 de enero de 2026", "enero 10, 2026", "3 mar. 2026"', () => {
    const d = findDates('Publicado el 10 de enero de 2026; también enero 10, 2026 y 3 mar. 2026.', { lang: 'es' });
    assert.deepEqual(d.map((x) => [x.raw, x.iso, x.format]), [['10 de enero de 2026', '2026-01-10', 'dmy-text'], ['enero 10, 2026', '2026-01-10', 'mdy-text'], ['3 mar. 2026', '2026-03-03', 'dmy-text']]);
    assert.ok(d.every((x) => x.ambiguous === false));
  });
  it('EN visible dates and ISO datetimes', () => {
    const d = findDates('Published January 10, 2026, updated 3rd March 2026, build 2026-01-10T10:00:00Z.', { lang: 'en' });
    assert.deepEqual(d.map((x) => [x.raw, x.iso]), [['January 10, 2026', '2026-01-10'], ['3rd March 2026', '2026-03-03'], ['2026-01-10T10:00:00Z', '2026-01-10']]);
    assert.equal(d[2].format, 'iso-datetime');
  });
  it('numeric d/m/y is disambiguated by language and flagged ambiguous', () => {
    const es = findDates('05/02/2026', { lang: 'es' })[0];
    const en = findDates('05/02/2026', { lang: 'en' })[0];
    assert.equal(es.iso, '2026-02-05'); assert.equal(es.ambiguous, true);
    assert.equal(en.iso, '2026-05-02'); assert.equal(en.ambiguous, true);
    const unk = findDates('05/02/2026 and 13/02/2026', { lang: 'unknown' });
    assert.equal(unk[0].iso, null, 'ambiguous with no language -> no fabricated reading');
    assert.equal(unk[1].iso, '2026-02-13'); assert.equal(unk[1].ambiguous, false);
    assert.equal(findDates('2026/01/10', {})[0].iso, '2026-01-10');
    assert.deepEqual(findDates('version 1.2.3 and 12/34/2026', { lang: 'en' }), []);
  });
  it('month names only from the selected language when one is given', () => {
    assert.equal(findDates('10 de enero de 2026', { lang: 'en' }).length, 0);
    assert.equal(findDates('10 de enero de 2026', {}).length, 1, 'no language -> both lexicons');
    assert.equal(monthIndex('sept', 'es'), 9); assert.equal(monthIndex('set', 'es'), 9); assert.equal(monthIndex('Dic.', 'es'), 12);
    assert.equal(monthIndex('May', 'en'), 5); assert.equal(monthIndex('Sept', 'en'), 9); assert.equal(monthIndex('foo', 'en'), null);
  });
  it('parseDate normalizes ISO (with and without offset), HTTP-date, month/year precision and text', () => {
    assert.equal(parseDate('2026-01-10').iso, '2026-01-10');
    const tz = parseDate('2026-01-10T23:30:00-05:00');
    assert.equal(tz.iso, '2026-01-10'); assert.equal(tz.iso_utc, '2026-01-11'); assert.equal(tz.precision, 'datetime');
    const noTz = parseDate('2026-01-10T23:30:00');
    assert.equal(noTz.iso_utc, '2026-01-10', 'no offset -> never shifted by the machine time zone');
    assert.equal(parseDate('Sat, 10 Jan 2026 12:00:00 GMT').iso, '2026-01-10');
    assert.equal(parseDate('2026-01').precision, 'month'); assert.equal(parseDate('2026').precision, 'year');
    assert.equal(parseDate('10 de enero de 2026', { lang: 'es' }).iso, '2026-01-10');
    assert.equal(parseDate('January 10, 2026', { lang: 'en' }).iso, '2026-01-10');
    assert.equal(parseDate('hace dos semanas', { lang: 'es' }).iso, null);
    assert.equal(parseDate('2026-13-45').iso, null);
    assert.equal(parseDate(''), null); assert.equal(parseDate(null), null);
  });
  it('labeled dates classify published vs updated in both languages', () => {
    const es = findLabeledDates('Publicado el 10 de enero de 2026 · Última actualización: 3 de marzo de 2026', { lang: 'es' });
    assert.deepEqual(es.map((d) => [d.kind, d.iso]), [['published', '2026-01-10'], ['updated', '2026-03-03']]);
    const en = findLabeledDates('Last updated: Jan 3, 2026. Published on January 10, 2026', { lang: 'en' });
    assert.deepEqual(en.map((d) => [d.kind, d.iso]), [['updated', '2026-01-03'], ['published', '2026-01-10']]);
    assert.deepEqual(findLabeledDates('Publicado el 10 de enero de 2026', { lang: 'fr' }), []);
    assert.deepEqual(findLabeledDates('Updated our pricing page last week', { lang: 'en' }), []);
  });
});
