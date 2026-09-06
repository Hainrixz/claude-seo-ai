// HTML character-reference decoding with zero dependencies.
// Covers numeric references (&#NNN; / &#xHH;, surrogate-safe, with the browser's
// Windows-1252 remap for the C1 range) plus the full HTML 4 named set (Latin-1,
// symbols/Greek, special) and the XHTML/HTML5 additions sites actually emit.
// Unknown references are left untouched so nothing is ever invented.

const table = Object.create(null);
const define = (names, firstCode) => names.forEach((n, i) => { if (n) table[n] = String.fromCodePoint(firstCode + i); });

// Latin-1 supplement: U+00A0 .. U+00FF, contiguous.
define([
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect', 'uml', 'copy', 'ordf', 'laquo', 'not', 'shy', 'reg', 'macr',
  'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot', 'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil', 'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
  'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times', 'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN', 'szlig',
  'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide', 'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
], 0xA0);

// Greek capitals U+0391..U+03A9 (no U+03A2) and lowercase U+03B1..U+03C9 (with final sigma at U+03C2).
define(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', null,
  'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'], 0x391);
define(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigmaf',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'], 0x3B1);

// Arrows U+2190..U+2195 and double arrows U+21D0..U+21D4.
define(['larr', 'uarr', 'rarr', 'darr', 'harr'], 0x2190);
define(['lArr', 'uArr', 'rArr', 'dArr', 'hArr'], 0x21D0);

// Everything else: explicit code points.
Object.assign(table, Object.fromEntries(Object.entries({
  // ASCII / markup
  quot: 0x22, amp: 0x26, lt: 0x3C, gt: 0x3E, apos: 0x27, Tab: 0x09, NewLine: 0x0A,
  excl: 0x21, num: 0x23, dollar: 0x24, percnt: 0x25, lpar: 0x28, rpar: 0x29, ast: 0x2A, plus: 0x2B, comma: 0x2C, period: 0x2E,
  sol: 0x2F, colon: 0x3A, semi: 0x3B, equals: 0x3D, quest: 0x3F, commat: 0x40, lsqb: 0x5B, bsol: 0x5C, rsqb: 0x5D, Hat: 0x5E,
  lowbar: 0x5F, grave: 0x60, lcub: 0x7B, verbar: 0x7C, rcub: 0x7D, half: 0xBD,
  // Latin extended, spacing modifiers
  OElig: 0x152, oelig: 0x153, Scaron: 0x160, scaron: 0x161, Yuml: 0x178, fnof: 0x192, circ: 0x2C6, tilde: 0x2DC,
  thetasym: 0x3D1, upsih: 0x3D2, piv: 0x3D6,
  // General punctuation
  ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200C, zwj: 0x200D, lrm: 0x200E, rlm: 0x200F,
  hyphen: 0x2010, dash: 0x2010, ndash: 0x2013, mdash: 0x2014, lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201A,
  ldquo: 0x201C, rdquo: 0x201D, bdquo: 0x201E, dagger: 0x2020, Dagger: 0x2021, bull: 0x2022, bullet: 0x2022,
  hellip: 0x2026, permil: 0x2030, prime: 0x2032, Prime: 0x2033, lsaquo: 0x2039, rsaquo: 0x203A, oline: 0x203E, frasl: 0x2044,
  euro: 0x20AC, image: 0x2111, weierp: 0x2118, real: 0x211C, trade: 0x2122, alefsym: 0x2135, crarr: 0x21B5,
  // Mathematical operators
  forall: 0x2200, part: 0x2202, exist: 0x2203, empty: 0x2205, nabla: 0x2207, isin: 0x2208, notin: 0x2209, ni: 0x220B,
  prod: 0x220F, sum: 0x2211, minus: 0x2212, lowast: 0x2217, radic: 0x221A, prop: 0x221D, infin: 0x221E, ang: 0x2220,
  and: 0x2227, or: 0x2228, cap: 0x2229, cup: 0x222A, int: 0x222B, there4: 0x2234, sim: 0x223C, cong: 0x2245, asymp: 0x2248,
  ne: 0x2260, equiv: 0x2261, le: 0x2264, ge: 0x2265, sub: 0x2282, sup: 0x2283, nsub: 0x2284, sube: 0x2286, supe: 0x2287,
  oplus: 0x2295, otimes: 0x2297, perp: 0x22A5, sdot: 0x22C5, lceil: 0x2308, rceil: 0x2309, lfloor: 0x230A, rfloor: 0x230B,
  lang: 0x27E8, rang: 0x27E9, loz: 0x25CA, spades: 0x2660, clubs: 0x2663, hearts: 0x2665, diams: 0x2666,
  // Dingbats commonly seen in the wild
  check: 0x2713, cross: 0x2717, star: 0x2606, starf: 0x2605, phone: 0x260E,
}).map(([k, v]) => [k, String.fromCodePoint(v)])));

export const ENTITIES = Object.freeze(table);
export const ENTITY_COUNT = Object.keys(table).length;

// Browsers map numeric references in the C1 control range to Windows-1252 glyphs.
const C1_REMAP = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030,
  0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
};

function fromCodePointSafe(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10FFFF) return '�';
  if (cp >= 0xD800 && cp <= 0xDFFF) return '�'; // lone surrogate
  if (C1_REMAP[cp]) cp = C1_REMAP[cp];
  return String.fromCodePoint(cp);
}

const REF = /&(?:#([0-9]{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g;

/** Decode HTML character references. Unknown named references are left as-is. */
export function decodeEntities(s = '') {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (str.indexOf('&') === -1) return str;
  return str.replace(REF, (m, dec, hex, name) => {
    if (dec !== undefined) return fromCodePointSafe(parseInt(dec, 10));
    if (hex !== undefined) return fromCodePointSafe(parseInt(hex, 16));
    const v = table[name];
    return v === undefined ? m : v;
  });
}

/** Encode the five characters that are unsafe in HTML text/attribute context. */
export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
