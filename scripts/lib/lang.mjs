// Language detection + EN/ES lexicons for the content heuristics (M11 answer blocks, M12 fact
// density, M13 freshness). Pure: no I/O, no network.
//
// detectLang(htmlOrTokens, { flag, doc }) -> { lang, tag, source, confidence, supported }
//   precedence: --lang flag > <html lang> primary subtag > <meta http-equiv=content-language>
//               > og:locale > stop-word heuristic (EN/ES) > 'unknown'
//   `lang` is the analysis language ('en' | 'es' | 'unknown'); `tag` is the language code that was
//   actually observed (e.g. 'fr' for a French page — unsupported, so lang is 'unknown').
// LEXICON.en / LEXICON.es -> question words, declarative exclusions, windups, anaphora, TL;DR markers,
//   months, date labels, original-data phrases, superlatives, generic anchors, stop words.
// isAuthorityHost(hostname) -> matched on the hostname only (never on the path).
// findDates(text, { lang }) / parseDate(str, { lang }) / findLabeledDates(text, { lang }) -> dates.
//
// NOTE: JavaScript's \b and \w are ASCII-only, so every boundary next to a possibly accented word
// uses the Unicode-aware lookarounds B0 / B1 below instead.

import { tokenize, parseDocument } from './html.mjs';

export const SUPPORTED_LANGS = Object.freeze(['en', 'es']);

const B0 = '(?<![\\p{L}\\p{N}_])'; // start-of-word boundary (Unicode-aware)
const B1 = '(?![\\p{L}\\p{N}_])';  // end-of-word boundary (Unicode-aware)
const toSet = (arr) => new Set(arr.map((w) => w.toLowerCase()));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr) => arr.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
const ru = (src, flags = 'iu') => new RegExp(src, flags);

// ---------------------------------------------------------------------------
// EN
const EN_QUESTION_WORDS = ['how', 'what', 'why', 'when', 'where', 'who', 'whom', 'whose', 'which', 'can', 'could', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'should', 'will', 'would'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const EN_MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const EN_MONTH_ALIASES = {};
const EN_VERBS = ['is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'does', 'do', 'did', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'means', 'meant', 'helps', 'helped', 'makes', 'made', 'works', 'worked', 'shows', 'showed', 'includes', 'included', 'requires', 'required', 'allows', 'allowed', 'gives', 'gave',
  'lets', 'let', 'keeps', 'kept', 'takes', 'took', 'comes', 'came', 'goes', 'went', 'leads', 'led', 'matters', 'mattered', 'depends', 'depended', 'applies', 'applied', 'happens',
  'happened', 'explains', 'explained', 'seems', 'seemed', 'needs', 'needed', 'tells', 'told', 'ensures', 'ensured', 'enables', 'enabled', 'becomes', 'became', 'remains', 'remained',
  'reduces', 'reduced', 'increases', 'increased', 'creates', 'created', 'provides', 'provided', 'offers', 'offered', 'refers', 'referred', 'results', 'resulted', 'involves', 'involved',
  'affects', 'affected', 'covers', 'covered', 'describes', 'described', 'sounds', 'looks', 'feels', 'turns', 'turned', 'saves', 'saved', 'costs', 'cost', 'uses', 'used', 'tends', 'adds',
  'added', 'removes', 'removed', 'improves', 'improved', 'prevents', 'prevented', 'causes', 'caused', 'holds', 'held', 'runs', 'ran', 'starts', 'started', 'ends', 'ended', 'sets', 'set',
  'brings', 'brought', 'points', 'pointed', 'suggests', 'suggested', 'implies', 'implied', 'assumes', 'assumed', 'represents', 'represented', 'consists', 'consisted', 'differs', 'differed',
  'relies', 'relied', 'serves', 'served', 'aims', 'aimed', 'tracks', 'tracked', 'measures', 'measured', 'counts', 'counted', 'checks', 'checked', 'defines', 'defined', 'signals', 'signaled',
  'isn\'t', 'aren\'t', 'wasn\'t', 'weren\'t', 'doesn\'t', 'don\'t', 'didn\'t', 'won\'t', 'can\'t', 'couldn\'t', 'shouldn\'t', 'hasn\'t', 'haven\'t', 'hadn\'t'];
const EN_ADVERBS = ['also', 'often', 'usually', 'then', 'simply', 'still', 'just', 'now', 'all', 'both', 'never', 'always', 'typically', 'generally', 'really', 'only', 'already', 'therefore', 'thus', 'in turn'];

// ---------------------------------------------------------------------------
// ES — accented interrogatives are the real question words; a few unaccented multi-word forms are
// accepted because SEO titles often drop accents ("Que es el GEO"), while bare unaccented
// como/cuando/donde stay out (they are conjunctions).
const ES_QUESTION_WORDS = ['qué', 'cómo', 'por qué', 'porqué', 'para qué', 'cuándo', 'dónde', 'adónde', 'quién', 'quiénes', 'cuál', 'cuáles', 'cuánto', 'cuánta', 'cuántos', 'cuántas',
  'puede', 'pueden', 'puedo', 'podemos', 'debo', 'debe', 'deben', 'debería', 'deberías', 'deberíamos', 'hay', 'se puede', 'se pueden', 'conviene', 'es posible', 'existe', 'existen', 'vale la pena', 'merece la pena', 'sirve', 'funciona',
  'que es', 'que son', 'que significa', 'que pasa', 'que ocurre', 'que incluye', 'que tiene', 'que hay', 'que hacer', 'como funciona', 'como funcionan', 'como se', 'cual es', 'cuales son', 'cuanto cuesta', 'cuanto cuestan', 'cuanto tarda', 'quien puede', 'donde se', 'donde puedo', 'cuando conviene', 'por que'];
const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ES_MONTH_ALIASES = { setiembre: 9 };
const ES_MONTH_ABBR = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const ES_VERBS = ['es', 'son', 'era', 'eran', 'fue', 'fueron', 'será', 'serán', 'sería', 'serían', 'está', 'están', 'estaba', 'estaban', 'estará', 'ha', 'han', 'había', 'habían', 'hay',
  'puede', 'pueden', 'podía', 'podían', 'podría', 'podrían', 'debe', 'deben', 'debería', 'deberían', 'hace', 'hacen', 'hizo', 'hicieron', 'hará', 'harán', 'haría',
  'permite', 'permiten', 'permitió', 'permitirá', 'ayuda', 'ayudan', 'ayudó', 'ayudará', 'significa', 'significan', 'significó', 'implica', 'implican', 'implicó', 'incluye', 'incluyen',
  'incluyó', 'requiere', 'requieren', 'requirió', 'funciona', 'funcionan', 'funcionó', 'tiene', 'tienen', 'tenía', 'tenían', 'tuvo', 'tendrá', 'sirve', 'sirven', 'sirvió', 'depende',
  'dependen', 'dependía', 'ocurre', 'ocurren', 'ocurrió', 'sucede', 'suceden', 'sucedió', 'muestra', 'muestran', 'mostró', 'indica', 'indican', 'indicó', 'explica', 'explican', 'explicó',
  'genera', 'generan', 'generó', 'mejora', 'mejoran', 'mejoró', 'reduce', 'reducen', 'redujo', 'aumenta', 'aumentan', 'aumentó', 'afecta', 'afectan', 'afectó', 'resulta', 'resultan',
  'resultó', 'consiste', 'consisten', 'supone', 'suponen', 'supuso', 'parece', 'parecen', 'pareció', 'lleva', 'llevan', 'llevó', 'da', 'dan', 'dio', 'dieron', 'va', 'van', 'iba', 'viene',
  'vienen', 'vino', 'queda', 'quedan', 'quedó', 'cambia', 'cambian', 'cambió', 'evita', 'evitan', 'evitó', 'garantiza', 'garantizan', 'asegura', 'aseguran', 'facilita', 'facilitan',
  'convierte', 'convierten', 'convirtió', 'representa', 'representan', 'equivale', 'equivalen', 'define', 'definen', 'describe', 'describen', 'demuestra', 'demuestran', 'refleja', 'reflejan',
  'provoca', 'provocan', 'causa', 'causan', 'produce', 'producen', 'produjo', 'ofrece', 'ofrecen', 'ofreció', 'cuenta', 'cuentan', 'contó', 'cuesta', 'cuestan', 'costó', 'ahorra', 'ahorran',
  'importa', 'importan', 'importó', 'basta', 'bastan', 'existe', 'existen', 'existía', 'aplica', 'aplican', 'aplicó', 'trata', 'tratan', 'trató', 'refiere', 'refieren'];
const ES_ADVERBS = ['no', 'se', 'ya', 'también', 'tampoco', 'siempre', 'nunca', 'solo', 'sólo', 'aún', 'todavía', 'nos', 'les', 'le', 'te', 'me', 'lo', 'la', 'los', 'las', 'a su vez', 'por tanto', 'entonces', 'además'];

const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function buildLexicon(code, spec) {
  const aliases = spec.month_aliases || {};
  const monthNumbers = new Map();
  spec.months.forEach((m, i) => monthNumbers.set(stripAccents(m), i + 1));
  for (const [k, v] of Object.entries(aliases)) monthNumbers.set(stripAccents(k), v);
  for (const [k, v] of Object.entries(spec.month_abbr)) monthNumbers.set(stripAccents(k), v);
  const monthAlt = alt([...spec.months, ...Object.keys(aliases), ...Object.keys(spec.month_abbr)]);
  return Object.freeze({
    code,
    question_words: Object.freeze(spec.question_words.slice()),
    question_re: ru('^(?:' + alt(spec.question_words) + ')' + B1),
    declarative_exclusions: Object.freeze(spec.declarative_exclusions.slice()),
    windup: spec.windup,
    anaphora_phrases: spec.anaphora_phrases,
    anaphora_pronouns: Object.freeze(spec.anaphora_pronouns.slice()),
    anaphora_pronoun_re: ru('^(?:' + alt(spec.anaphora_pronouns) + ')' + B1),
    anaphora_skip: toSet(spec.anaphora_skip),
    verbs: toSet(spec.verbs),
    tldr_heading: spec.tldr_heading,
    tldr_text: spec.tldr_text,
    months: Object.freeze(spec.months.slice()),
    month_abbr: Object.freeze(Object.keys(spec.month_abbr)),
    month_aliases: Object.freeze({ ...aliases }),
    month_numbers: monthNumbers,
    month_alt: monthAlt,
    month_re: ru(B0 + '(?:' + monthAlt + ')' + B1 + '\\.?'),
    date_labels: spec.date_labels,
    date_label_kinds: spec.date_label_kinds,
    original_data: spec.original_data,
    superlatives: spec.superlatives,
    generic_anchor: spec.generic_anchor,
    generic_anchors: Object.freeze(spec.generic_anchors.slice()),
    stopwords: toSet(spec.stopwords),
    percent_words: Object.freeze(spec.percent_words.slice()),
    magnitude_words: Object.freeze(spec.magnitude_words.slice()),
  });
}

export const LEXICON = Object.freeze({
  en: buildLexicon('en', {
    question_words: EN_QUESTION_WORDS,
    // "How to <verb>" titles and "What we/you/our…" section labels are declarative, not questions.
    declarative_exclusions: [/^how\s+to\b/i, /^what\s+(we|you|i|our|they|this|that|the|it)\b/i, /^who\s+we\s+are\b/i, /^where\s+we\s+are\b/i, /^when\s+to\s+/i, /^where\s+to\s+/i],
    windup: /^(?:in this (?:section|article|post|guide|chapter|tutorial|piece|lesson|page)|we(?:'| wi)ll (?:explore|cover|look|discuss|walk|go|dive|break|show|explain|take|see|review)|let'?s\b|below(?:,| we| you)|first,|here we|read on|keep reading|before we (?:dive|begin|start|get)|in the following|the following (?:section|sections|guide|paragraphs)|this (?:section|article|post|guide|chapter) (?:will|covers|explains|explores|walks|shows|looks)|today we|today,? (?:we|i|you)|in this piece)/i,
    anaphora_phrases: /^(?:as (?:mentioned|noted|discussed|stated|explained|shown|described|outlined|said|seen|covered) (?:above|earlier|previously|before|already)|as (?:above|noted|mentioned|discussed|explained)\b|as we (?:saw|said|mentioned|discussed|explained|noted|covered)|as i (?:said|mentioned|noted|explained)|see above|the (?:former|latter)\b|(?:this|that) (?:said|being said)|with (?:this|that) in mind|given (?:the|this) above|for (?:this|that) reason|because of (?:this|that)\b|in (?:this|that) case\b|(?:so|thus|therefore|hence),?\s)/i,
    anaphora_pronouns: ['this', 'that', 'these', 'those', 'it', 'they', 'he', 'she'],
    anaphora_skip: EN_ADVERBS,
    verbs: EN_VERBS,
    tldr_heading: /^(?:tl;?dr|key takeaways?|summary|in short|in summary|in brief|at a glance|quick answer|the short answer|short answer|key points|executive summary|highlights|overview)\b/i,
    tldr_text: /\b(?:tl;?dr|key takeaways?|in short|in summary|in brief|summary:|at a glance|quick answer:|the short answer|key points:)\b/i,
    months: EN_MONTHS,
    month_aliases: EN_MONTH_ALIASES,
    month_abbr: EN_MONTH_ABBR,
    date_labels: /\b(published(?: on)?|posted(?: on)?|date published|publication date|updated(?: on)?|last updated|last modified|modified(?: on)?|last reviewed|reviewed(?: on)?|date)\b\s*[:\-–—]?\s*/gi,
    date_label_kinds: { published: /^(?:published|posted|date published|publication date|date)\b/i, updated: /^(?:updated|last updated|last modified|modified|last reviewed|reviewed)\b/i },
    original_data: /\b(?:our(?:\s+\w+){0,2}\s+(?:study|survey|data|research|analysis|test|tests|experiment|benchmark|poll|dataset)|we\s+(?:analy[sz]ed|surveyed|tested|measured|polled|found that|collected|benchmarked|interviewed|compared|observed that|discovered that)|internal data|proprietary data|first-party data|in our (?:test|tests|study|survey|analysis|experiment|benchmark)|according to our (?:data|research|study|survey|analysis))\b/i,
    superlatives: /\b(?:the (?:best|fastest|most|largest|biggest|leading|number one|#1|top|cheapest|only)|fastest|cheapest|studies show|research shows|experts agree|experts say|everyone knows|it is well known|it'?s well known|it is widely known|undoubtedly|without a doubt|world-class|industry-leading|cutting-edge|revolutionary)\b/i,
    generic_anchors: ['click here', 'here', 'read more', 'learn more', 'more', 'this', 'link', 'this link', 'this page', 'continue reading', 'more info', 'details', 'see more', 'find out more', 'view more', 'go', 'website', 'page', 'article', 'post', 'info'],
    generic_anchor: /^(?:click here|here|read more|learn more|more|this|link|this link|this page|continue reading|more info|details|see more|find out more|view more|go|website|page|article|post|info)$/i,
    stopwords: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'as', 'on', 'are', 'this', 'was', 'be', 'by', 'at', 'from', 'or', 'an', 'it', 'you', 'your', 'we', 'our', 'not', 'have', 'has', 'can', 'will', 'which', 'their', 'they', 'what', 'when', 'how', 'there', 'about', 'into', 'than', 'more', 'these', 'been', 'its', 'also', 'if', 'but', 'would', 'should'],
    percent_words: ['percent', 'pct'],
    magnitude_words: ['k', 'm', 'bn', 'mm', 'billion', 'million', 'thousand', 'trillion'],
  }),
  es: buildLexicon('es', {
    question_words: ES_QUESTION_WORDS,
    // "Cómo <infinitivo>" titles ("Cómo optimizar…") and "Quiénes somos"-style labels are declarative.
    declarative_exclusions: [
      ru('^c[oó]mo\\s+\\p{L}+(?:ar|er|ir)(?:se|te|lo|la|los|las|le|les|nos)?' + B1),
      ru('^qu[eé]\\s+(?:hacemos|ofrecemos|incluye|incluyen|encontrar[aá]s|aprender[aá]s|necesitas|obtienes|dice|dicen|opinan|somos)' + B1),
      ru('^qui[eé]nes\\s+somos' + B1), ru('^qui[eé]n\\s+soy' + B1), ru('^d[oó]nde\\s+estamos' + B1), ru('^c[oó]mo\\s+llegar' + B1), ru('^c[oó]mo\\s+trabajamos' + B1),
      ru('^cu[aá]ndo\\s+\\p{L}+(?:ar|er|ir)' + B1), ru('^d[oó]nde\\s+\\p{L}+(?:ar|er|ir)' + B1), ru('^lo\\s+que' + B1),
    ],
    windup: ru('^(?:en esta (?:secci[oó]n|gu[ií]a|entrada|publicaci[oó]n|nota|p[aá]gina|lecci[oó]n|parte)|en este (?:art[ií]culo|cap[ií]tulo|apartado|post|tutorial|texto|blog|v[ií]deo|video)|a continuaci[oó]n|vamos a (?:ver|explorar|repasar|analizar|revisar|explicar|profundizar|conocer|descubrir|hablar|mostrar|aprender|contarte|explicarte|ense[ñn]arte)|veamos' + B1 + '|primero,|en las siguientes l[ií]neas|en los siguientes (?:p[aá]rrafos|apartados|puntos)|en las pr[oó]ximas l[ií]neas|sigue leyendo|contin[uú]a leyendo|te (?:contamos|explicamos|mostramos|ense[ñn]amos) (?:a continuaci[oó]n|en esta|en este|c[oó]mo|todo)|hoy (?:vamos|veremos|hablaremos|te|os|analizamos)|antes de (?:empezar|comenzar|entrar|nada)|m[aá]s abajo|aqu[ií] (?:te|os|vamos|veremos|repasamos))'),
    anaphora_phrases: ru('^(?:como (?:ya )?(?:mencionamos|mencion[eé]|dijimos|vimos|comentamos|explicamos|se[ñn]alamos|indicamos|adelantamos|coment[eé]|expliqu[eé]|dije|se mencion[oó]|se dijo|se explic[oó]|se indic[oó]|se coment[oó]|se vio|se[ñn]al[eé])(?:\\s+(?:antes|arriba|anteriormente|previamente|m[aá]s arriba|al inicio|al principio|ya))?|como (?:ya )?(?:hemos|he) (?:dicho|visto|mencionado|explicado|comentado|se[ñn]alado|indicado|adelantado)|seg[uú]n lo anterior|lo anterior' + B1 + '|dicho esto|dicho lo anterior|(?:este|esta) [uú]ltim[oa]' + B1 + '|(?:el|la) anterior' + B1 + '|por (?:eso|ello|esta raz[oó]n|esa raz[oó]n|lo tanto|ende|esto|tanto)' + B1 + '|as[ií] (?:que|pues)' + B1 + '|de ah[ií] que' + B1 + '|en (?:este|ese) caso' + B1 + '|con esto en mente|teniendo esto en cuenta|(?:por consiguiente|en consecuencia|entonces),?\\s)'),
    anaphora_pronouns: ['esto', 'eso', 'esta', 'este', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquello', 'aquella', 'aquel', 'aquellos', 'aquellas', 'ello', 'ellos', 'ellas', 'él', 'lo'],
    anaphora_skip: ES_ADVERBS,
    verbs: ES_VERBS,
    tldr_heading: ru('^(?:resumen|tl;?dr|en resumen|en pocas palabras|puntos clave|lo esencial|conclusiones clave|de un vistazo|ideas clave|en s[ií]ntesis|resumiendo|lo m[aá]s importante|respuesta r[aá]pida|respuesta corta|la respuesta corta|resumen ejecutivo|en breve)' + B1),
    tldr_text: ru(B0 + '(?:tl;?dr' + B1 + '|en resumen' + B1 + '|en pocas palabras' + B1 + '|puntos clave' + B1 + '|lo esencial' + B1 + '|conclusiones clave' + B1 + '|de un vistazo' + B1 + '|ideas clave' + B1 + '|en s[ií]ntesis' + B1 + '|resumen:|resumiendo[,:]|respuesta r[aá]pida:|respuesta corta:|en breve[,:])'),
    months: ES_MONTHS,
    month_aliases: ES_MONTH_ALIASES,
    month_abbr: ES_MONTH_ABBR,
    date_labels: ru(B0 + '(actualizad[oa](?: el| en)?|[uú]ltima actualizaci[oó]n|fecha de actualizaci[oó]n|publicad[oa](?: el| en)?|fecha de publicaci[oó]n|fecha|modificad[oa](?: el)?|[uú]ltima modificaci[oó]n|revisad[oa](?: el)?|[uú]ltima revisi[oó]n)' + B1 + '\\s*[:\\-–—]?\\s*', 'giu'),
    date_label_kinds: { published: ru('^(?:publicad[oa]|fecha de publicaci[oó]n|fecha)' + B1), updated: ru('^(?:actualizad[oa]|[uú]ltima actualizaci[oó]n|fecha de actualizaci[oó]n|modificad[oa]|[uú]ltima modificaci[oó]n|revisad[oa]|[uú]ltima revisi[oó]n)' + B1) },
    original_data: ru(B0 + '(?:nuestr[oa]s?(?:\\s+\\p{L}+){0,2}\\s+(?:estudio|an[aá]lisis|informe|experimento|benchmark|sondeo|relevamiento|test|muestreo|encuesta|investigaci[oó]n|prueba|pruebas|muestra|base de datos|medici[oó]n|mediciones|revisi[oó]n|datos|cifras|conjunto de datos)|(?:analizamos|encuestamos|medimos|probamos|evaluamos|relevamos|recopilamos|recogimos|revisamos|comparamos|estudiamos|entrevistamos|auditamos|monitoreamos|observamos que|descubrimos que|encontramos que|comprobamos que|detectamos que)|datos (?:propios|internos|de primera mano|de primera fuente)|seg[uú]n nuestr[oa]s? (?:datos|an[aá]lisis|estudio|encuesta|investigaci[oó]n|mediciones|pruebas|cifras))' + B1),
    superlatives: ru(B0 + '(?:(?:el|la|los|las) (?:mejor|mejores|m[aá]s r[aá]pid[oa]s?|m[aá]s grandes?|m[aá]s barat[oa]s?|l[ií]der|l[ií]deres|n[uú]mero uno|n[uú]mero 1|#1|[uú]nic[oa]s?)|lo m[aá]s (?:barato|r[aá]pido|efectivo|eficaz|recomendado)|los estudios (?:muestran|demuestran|indican|dicen)|las investigaciones (?:muestran|demuestran|indican|dicen)|los expertos (?:coinciden|afirman|dicen|recomiendan|aseguran)|todo el mundo sabe|todos saben|es bien sabido|sin duda|sin lugar a dudas|l[ií]der (?:del|en el) (?:mercado|sector)|de clase mundial|revolucionari[oa]|el m[aá]s|la m[aá]s)' + B1),
    generic_anchors: ['aquí', 'aqui', 'haz clic', 'haz clic aquí', 'haz click', 'haz click aquí', 'clic aquí', 'click aquí', 'pincha aquí', 'pulsa aquí', 'leer más', 'leer mas', 'ver más', 'ver mas', 'más', 'mas', 'más información', 'mas información', 'este enlace', 'enlace', 'link', 'aquí mismo', 'seguir leyendo', 'continuar leyendo', 'ver', 'saber más', 'conoce más', 'descubre más', 'entra', 'entrar', 'ir', 'página', 'artículo', 'sitio web', 'detalles', 'esto', 'este'],
    generic_anchor: ru('^(?:aqu[ií]|haz clic(?: aqu[ií])?|haz click(?: aqu[ií])?|clic aqu[ií]|click aqu[ií]|pincha aqu[ií]|pulsa aqu[ií]|leer m[aá]s|ver m[aá]s|m[aá]s|m[aá]s informaci[oó]n|este enlace|enlace|link|aqu[ií] mismo|seguir leyendo|continuar leyendo|ver|saber m[aá]s|conoce m[aá]s|descubre m[aá]s|entra|entrar|ir|p[aá]gina|art[ií]culo|sitio web|detalles|esto|este)$'),
    stopwords: ['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'para', 'con', 'se', 'su', 'sus', 'al', 'lo', 'como', 'más', 'pero', 'o', 'este', 'esta', 'son', 'ser', 'también', 'sin', 'sobre', 'entre', 'cuando', 'muy', 'ya', 'todo', 'puede', 'hay', 'porque', 'qué', 'cómo', 'nos', 'le', 'les', 'está', 'están', 'tiene', 'tienen', 'hacer', 'desde', 'hasta', 'cada', 'nuestro', 'nuestra'],
    percent_words: ['por ciento', 'porciento'],
    magnitude_words: ['mil', 'millones', 'millón', 'millon', 'billones', 'billón', 'k', 'm', 'mm'],
  }),
});

// ---------------------------------------------------------------------------
// Authority hosts: matched on the hostname only (a path like /wikipedia.org/… never counts).
export const AUTHORITY_HOST_RULES = Object.freeze([
  /\.(gov|edu|mil)$/,
  /\.gob\.(mx|es|ar|cl|co|pe|ec|bo|ve|gt|hn|ni|sv|pa|do|cu|uy|py)$/,
  /\.gov\.(uk|au|br|in|ca|nz|ie|sg|za|ar|co|cl|py|pt|it|pl|tr)$/,
  /\.edu\.(mx|ar|co|pe|uy|au|br|ec|bo|ve|gt|sv|pa|do|cu|py|ni|hn|cl)$/,
  /\.ac\.(uk|nz|jp|kr|il|za|in|at|be|cn|th)$/,
  /\.gouv\.fr$/, /\.gc\.ca$/, /\.admin\.ch$/,
  /(^|\.)europa\.eu$/, /(^|\.)boe\.es$/, /(^|\.)ine\.es$/, /(^|\.)inegi\.org\.mx$/, /(^|\.)scielo\.org$/, /(^|\.)redalyc\.org$/, /(^|\.)cepal\.org$/,
  /(^|\.)un\.org$/, /(^|\.)worldbank\.org$/, /(^|\.)bancomundial\.org$/, /(^|\.)imf\.org$/, /(^|\.)who\.int$/, /(^|\.)paho\.org$/, /(^|\.)oecd\.org$/, /(^|\.)unesco\.org$/,
  /(^|\.)wikipedia\.org$/, /(^|\.)nature\.com$/, /(^|\.)science\.org$/, /(^|\.)sciencedirect\.com$/, /(^|\.)nih\.gov$/, /(^|\.)arxiv\.org$/, /(^|\.)doi\.org$/, /(^|\.)jstor\.org$/,
  /(^|\.)springer\.com$/, /(^|\.)ieee\.org$/, /(^|\.)acm\.org$/, /(^|\.)ietf\.org$/, /(^|\.)iso\.org$/, /(^|\.)w3\.org$/, /(^|\.)schema\.org$/, /(^|\.)whatwg\.org$/,
  /^(developer|developers|docs)\./,
]);

/** Hostname of a URL or a bare host, lowercased and without a trailing dot; null when unparsable. */
export function hostnameOf(urlOrHost, base) {
  if (urlOrHost == null) return null;
  const s = String(urlOrHost).trim();
  if (!s) return null;
  try { const h = new URL(s, base).hostname; return h ? h.toLowerCase().replace(/\.$/, '') : null; } catch { /* not a URL */ }
  if (/^[a-z0-9.-]+$/i.test(s) && s.includes('.')) return s.toLowerCase().replace(/\.$/, '');
  return null;
}

/** True when the HOSTNAME (only) matches an authority rule. Accepts a hostname or an absolute URL. */
export function isAuthorityHost(hostOrUrl) {
  const host = hostnameOf(hostOrUrl);
  if (!host) return false;
  return AUTHORITY_HOST_RULES.some((re) => re.test(host));
}

// ---------------------------------------------------------------------------
// Language detection

/** BCP 47-ish tag -> lowercase primary subtag ('es-MX' / 'es_ES' / 'ES' -> 'es'); null when not a language tag. */
export function normalizeLangTag(tag) {
  if (tag == null) return null;
  const s = String(tag).trim().replace(/_/g, '-').split(/[,;\s]/)[0];
  if (!s) return null;
  const primary = s.split('-')[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  return primary;
}

/** Visible text used by the stop-word heuristic: text tokens outside raw elements, title and head. */
function sampleText(tokens, maxChars = 8000) {
  let out = '';
  for (const t of tokens) {
    if (t.kind !== 'text') continue;
    const p = t.parent >= 0 ? tokens[t.parent] : null;
    if (p && (p.name === 'title' || p.name === 'head' || p.name === 'option')) continue;
    out += t.text + ' ';
    if (out.length > maxChars) break;
  }
  return out;
}

/** Stop-word vote over up to 1500 tokens. Returns { lang, en, es, tokens }. */
export function guessLangFromText(text) {
  const toks = String(text || '').toLowerCase().split(/[^\p{L}']+/u).filter(Boolean).slice(0, 1500);
  let en = 0, es = 0;
  for (const w of toks) {
    if (LEXICON.en.stopwords.has(w)) en++;
    if (LEXICON.es.stopwords.has(w)) es++;
  }
  let lang = 'unknown';
  const top = Math.max(en, es);
  if (top >= 5) {
    if (en >= es * 1.5) lang = 'en';
    else if (es >= en * 1.5) lang = 'es';
  }
  return { lang, en, es, tokens: toks.length };
}

/**
 * Detect the page language. `flag` is the --lang value ('en'|'es'|'auto'|other); `doc` an optional
 * parseDocument() result (avoids re-parsing). Returns { lang, tag, source, confidence, supported }.
 */
export function detectLang(htmlOrTokens, { flag, doc } = {}) {
  const finish = (tag, source, confidence) => {
    const lang = tag && SUPPORTED_LANGS.includes(tag) ? tag : 'unknown';
    return { lang, tag: tag || null, source, confidence, supported: lang !== 'unknown' };
  };
  if (flag != null && flag !== true && String(flag).trim() !== '' && String(flag).trim().toLowerCase() !== 'auto') {
    const tag = normalizeLangTag(flag) || String(flag).trim().toLowerCase();
    return finish(tag, 'flag', 'high');
  }
  let tokens = null;
  if (Array.isArray(htmlOrTokens)) tokens = htmlOrTokens;
  else if (htmlOrTokens != null) tokens = tokenize(String(htmlOrTokens));
  const d = doc || (tokens ? parseDocument('', null, { tokens }) : null);
  if (!d) return finish(null, 'none', 'none');

  const htmlTag = normalizeLangTag(d.lang);
  if (htmlTag) return finish(htmlTag, 'html-lang', 'high');
  const cl = (d.metas || []).find((m) => m.http_equiv === 'content-language' && m.content);
  const clTag = cl ? normalizeLangTag(cl.content) : null;
  if (clTag) return finish(clTag, 'content-language', 'medium');
  const og = (d.metas || []).find((m) => m.property === 'og:locale' && m.content);
  const ogTag = og ? normalizeLangTag(og.content) : null;
  if (ogTag) return finish(ogTag, 'og-locale', 'medium');
  if (tokens) {
    const g = guessLangFromText(sampleText(tokens));
    if (g.lang !== 'unknown') return finish(g.lang, 'heuristic', 'low');
  }
  return finish(null, 'none', 'none');
}

/** The lexicon for a detected language, or null when unsupported. */
export function lexiconFor(lang) { return LEXICON[lang] || null; }

// ---------------------------------------------------------------------------
// Heuristic predicates shared by the scripts. Each returns null when the language is unsupported.

/** Is this heading text a question in `lang`? (leading ¿ / trailing ? always count). */
export function isQuestionHeading(text, lang) {
  const lex = lexiconFor(lang);
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\?\s*$/.test(t) || /^¿/.test(t)) return true;
  if (!lex) return null;
  if (!lex.question_re.test(t)) return false;
  return !lex.declarative_exclusions.some((re) => re.test(t));
}

/** Does the passage open with a wind-up ("In this section we'll…", "A continuación…")? */
export function isWindup(text, lang) {
  const lex = lexiconFor(lang);
  if (!lex) return null;
  return lex.windup.test(String(text || '').trim());
}

/**
 * Does the passage open anaphorically? Phrase forms ("As mentioned above", "Como mencionamos antes")
 * always count; a bare pronoun ("This", "Esto", "It") counts only when the next word is a verb
 * (optionally after one or two adverbs/clitics), so "This guide covers…" is not anaphoric.
 */
export function isAnaphoric(text, lang) {
  const lex = lexiconFor(lang);
  if (!lex) return null;
  const t = String(text || '').trim();
  if (!t) return false;
  if (lex.anaphora_phrases.test(t)) return true;
  const m = lex.anaphora_pronoun_re.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length).replace(/^[\s,;:–—-]+/, '');
  const toks = rest.split(/[\s,;:]+/).map((w) => w.replace(/[^\p{L}']/gu, '').toLowerCase()).filter(Boolean);
  let i = 0;
  while (i < toks.length && i < 2 && lex.anaphora_skip.has(toks[i])) i++;
  if (i >= toks.length) return false;
  if (lex.verbs.has(toks[i])) return true;
  // two-word skips ("in turn", "por tanto")
  if (toks.length > i + 2 && lex.anaphora_skip.has(toks[i] + ' ' + toks[i + 1])) return lex.verbs.has(toks[i + 2]);
  return false;
}

/** TL;DR / summary marker in a heading (anchored) or in running text. */
export function hasTldrMarker(text, lang, { heading = false } = {}) {
  const lex = lexiconFor(lang);
  if (!lex) return null;
  const t = String(text || '').trim();
  return heading ? lex.tldr_heading.test(t) : lex.tldr_text.test(t);
}

// ---------------------------------------------------------------------------
// Dates

const pad2 = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => y >= 1000 && y <= 2999 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
/** Month number (1–12) for a month name or abbreviation in `lang` (or in any supported language). */
export function monthIndex(name, lang) {
  if (!name) return null;
  const n = stripAccents(String(name).toLowerCase().trim().replace(/\.$/, ''));
  const langs = lang && LEXICON[lang] ? [lang] : SUPPORTED_LANGS;
  for (const l of langs) {
    const v = LEXICON[l].month_numbers.get(n);
    if (v) return v;
  }
  return null;
}

const ISO_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g;
const NUMERIC_RE = /(?<!\d|\d[/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d|[/.-]\d)/g;
const YMD_NUMERIC_RE = /(?<!\d|\d[/.-])(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?!\d|[/.-]\d)/g;

function textDatePatterns(lang) {
  const langs = lang && LEXICON[lang] ? [lang] : SUPPORTED_LANGS;
  const out = [];
  for (const l of langs) {
    const M = LEXICON[l].month_alt;
    if (l === 'es') {
      out.push({ re: ru(B0 + '(\\d{1,2})(?:º|°)?\\s+de\\s+(' + M + ')\\.?\\s+(?:de|del)\\s+(\\d{4})' + B1, 'giu'), order: 'dmy', format: 'dmy-text', lang: l });
      out.push({ re: ru(B0 + '(' + M + ')\\.?\\s+(\\d{1,2}),?\\s+(?:de\\s+)?(\\d{4})' + B1, 'giu'), order: 'mdy', format: 'mdy-text', lang: l });
      out.push({ re: ru(B0 + '(\\d{1,2})\\s+(' + M + ')\\.?,?\\s+(\\d{4})' + B1, 'giu'), order: 'dmy', format: 'dmy-text', lang: l });
    } else {
      out.push({ re: ru(B0 + '(' + M + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})' + B1, 'giu'), order: 'mdy', format: 'mdy-text', lang: l });
      out.push({ re: ru(B0 + '(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + M + ')\\.?,?\\s+(\\d{4})' + B1, 'giu'), order: 'dmy', format: 'dmy-text', lang: l });
    }
  }
  return out;
}

/**
 * Find visible dates in text. Returns [{ raw, iso, format, ambiguous, index, lang }] sorted by position.
 * ISO and month-name dates are unambiguous; numeric d/m/y is read DMY for 'es', MDY for 'en', and
 * left with iso:null when the language is unknown and both readings are valid.
 */
export function findDates(text, { lang, limit = 50 } = {}) {
  const s = String(text || '');
  const found = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  const push = (m, iso, format, ambiguous, l) => {
    const a = m.index, b = m.index + m[0].length;
    if (overlaps(a, b)) return;
    taken.push([a, b]);
    found.push({ raw: m[0], iso, format, ambiguous, index: a, lang: l || null });
  };
  let m;
  ISO_RE.lastIndex = 0;
  while ((m = ISO_RE.exec(s))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    push(m, validYmd(y, mo, d) ? ymd(y, mo, d) : null, m[4] ? 'iso-datetime' : 'iso', false, null);
  }
  for (const p of textDatePatterns(lang)) {
    p.re.lastIndex = 0;
    while ((m = p.re.exec(s))) {
      const monthName = p.order === 'mdy' ? m[1] : m[2];
      const day = +(p.order === 'mdy' ? m[2] : m[1]);
      const mo = monthIndex(monthName, p.lang);
      const y = +m[3];
      if (!mo) continue;
      push(m, validYmd(y, mo, day) ? ymd(y, mo, day) : null, p.format, false, p.lang);
    }
  }
  YMD_NUMERIC_RE.lastIndex = 0;
  while ((m = YMD_NUMERIC_RE.exec(s))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!validYmd(y, mo, d)) continue;
    push(m, ymd(y, mo, d), 'numeric-ymd', false, null);
  }
  NUMERIC_RE.lastIndex = 0;
  while ((m = NUMERIC_RE.exec(s))) {
    const a = +m[1], b = +m[2], y = +m[3];
    const dmyOk = validYmd(y, b, a), mdyOk = validYmd(y, a, b);
    if (!dmyOk && !mdyOk) continue;
    let iso = null, ambiguous = false;
    if (dmyOk && !mdyOk) iso = ymd(y, b, a);
    else if (mdyOk && !dmyOk) iso = ymd(y, a, b);
    else {
      ambiguous = true;
      if (lang === 'es') iso = ymd(y, b, a);
      else if (lang === 'en') iso = ymd(y, a, b);
    }
    push(m, iso, 'numeric', ambiguous, null);
  }
  found.sort((x, y) => x.index - y.index);
  return found.slice(0, limit);
}

/**
 * Normalize one date string (schema.org value, meta content, HTTP header or visible text) to
 * { raw, iso: 'YYYY-MM-DD'|null, iso_utc: 'YYYY-MM-DD'|null, precision, format, ambiguous }.
 * iso keeps the calendar day as written; iso_utc is the UTC day when an explicit offset is present
 * (a datetime without an offset is NOT shifted — that would depend on the machine's time zone).
 */
export function parseDate(value, { lang } = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const out = { raw, iso: null, iso_utc: null, precision: null, format: null, ambiguous: false };
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(raw);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!validYmd(y, mo, d)) return out;
    out.iso = ymd(y, mo, d);
    out.precision = m[4] ? 'datetime' : 'day';
    out.format = m[4] ? 'iso-datetime' : 'iso';
    out.iso_utc = out.iso;
    if (m[7]) {
      const t = Date.parse(raw.replace(' ', 'T'));
      if (!Number.isNaN(t)) out.iso_utc = new Date(t).toISOString().slice(0, 10);
    }
    return out;
  }
  m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (m && +m[2] >= 1 && +m[2] <= 12) { out.iso = `${m[1]}-${m[2]}-01`; out.iso_utc = out.iso; out.precision = 'month'; out.format = 'iso-month'; return out; }
  m = /^(\d{4})$/.exec(raw);
  if (m && +m[1] >= 1000 && +m[1] <= 2999) { out.iso = `${m[1]}-01-01`; out.iso_utc = out.iso; out.precision = 'year'; out.format = 'iso-year'; return out; }
  // RFC 2822 / HTTP-date ("Sat, 10 Jan 2026 12:00:00 GMT") — Date.parse is reliable here
  if (/\b(GMT|UTC)\b|^[A-Z][a-z]{2},\s/.test(raw)) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) {
      out.iso_utc = new Date(t).toISOString().slice(0, 10);
      out.iso = out.iso_utc;
      out.precision = 'datetime';
      out.format = 'http-date';
      return out;
    }
  }
  const [first] = findDates(raw, { lang, limit: 1 });
  if (first && first.raw.length >= Math.max(6, raw.length - 6)) {
    out.iso = first.iso; out.iso_utc = first.iso; out.precision = first.iso ? 'day' : null; out.format = first.format; out.ambiguous = first.ambiguous;
  }
  return out;
}

/**
 * Dates that follow a label ("Publicado el 10 de enero de 2026", "Last updated: Jan 3, 2026").
 * Returns [{ label, kind: 'published'|'updated'|'other', raw, iso, ambiguous, index }].
 */
export function findLabeledDates(text, { lang, window = 48 } = {}) {
  const lex = lexiconFor(lang);
  if (!lex) return [];
  const s = String(text || '');
  const out = [];
  const re = new RegExp(lex.date_labels.source, lex.date_labels.flags.includes('g') ? lex.date_labels.flags : lex.date_labels.flags + 'g');
  let m;
  while ((m = re.exec(s))) {
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + window);
    const [d] = findDates(after, { lang, limit: 1 });
    if (!d || d.index > 12) continue;
    const label = m[1];
    const kind = lex.date_label_kinds.updated.test(label) ? 'updated' : (lex.date_label_kinds.published.test(label) ? 'published' : 'other');
    out.push({ label, kind, raw: d.raw, iso: d.iso, ambiguous: d.ambiguous, index: m.index });
  }
  return out;
}
