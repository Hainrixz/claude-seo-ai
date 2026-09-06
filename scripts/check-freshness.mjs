#!/usr/bin/env node
// Freshness & temporal-signal checks (M13): schema dates vs visible dates vs the
// HTTP Last-Modified header, plus content age. Never used to backdate anything.
//
// Usage: node check-freshness.mjs --url https://example.com/post [--lang en|es|auto]
//        node check-freshness.mjs --file ./post.html [--url <page url>] [--lang en|es|auto]
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// Dates are normalized before any comparison (ISO 8601, HTTP-date, "10 de enero de 2026",
// "January 10, 2026", numeric d/m/y disambiguated by language and flagged `ambiguous`). A schema
// date that cannot be parsed is reported in schema_date_unparseable instead of producing a false
// mismatch. Several dateModified values -> all_modified_dates[], the latest wins, conflict flagged.
// Visible dates are scanned on the boilerplate-stripped text (script bodies never count).

import { EXIT, isMain, runCli, loadInput, inputFailure } from './lib/util.mjs';
import { tokenize, parseDocument } from './lib/html.mjs';
import { detectLang, parseDate, findDates, findLabeledDates } from './lib/lang.mjs';
import { contentMask, visibleText } from './lib/passages.mjs';

const NOTE = 'Staleness is topic-dependent; flag, do not hard-fail on age alone. Never write a false/backdated dateModified.';
const DAY_MS = 86400000;

function langSummary(det) {
  return { detected: det.tag || 'unknown', source: det.source, confidence: det.confidence, supported: det.supported };
}

/** All datePublished / dateModified values in JSON-LD data (recursive, @graph included), as strings. */
export function collectSchemaDates(node, acc = { published: [], modified: [] }, seen = new Set()) {
  if (Array.isArray(node)) { for (const n of node) collectSchemaDates(n, acc, seen); return acc; }
  if (node && typeof node === 'object') {
    if (seen.has(node)) return acc;
    seen.add(node);
    if (node.datePublished != null && node.datePublished !== '') acc.published.push(String(node.datePublished));
    if (node.dateModified != null && node.dateModified !== '') acc.modified.push(String(node.dateModified));
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') collectSchemaDates(node[k], acc, seen);
  }
  return acc;
}

const daysBetween = (iso, now) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : Math.round((now - t) / DAY_MS); };

/** Pick one date out of several: 'earliest' or 'latest' parseable one (raw string kept). */
function pick(raws, mode, lang) {
  const parsed = raws.map((raw) => ({ raw, p: parseDate(raw, { lang }) }));
  const ok = parsed.filter((x) => x.p && x.p.iso);
  const unparseable = parsed.filter((x) => !x.p || !x.p.iso).map((x) => x.raw);
  const distinct = [...new Set(ok.map((x) => x.p.iso))];
  let chosen = null;
  if (ok.length) {
    ok.sort((a, b) => (a.p.iso < b.p.iso ? -1 : a.p.iso > b.p.iso ? 1 : 0));
    chosen = mode === 'latest' ? ok[ok.length - 1] : ok[0];
  } else if (raws.length) chosen = parsed[0];
  return { raw: chosen ? chosen.raw : null, iso: chosen && chosen.p ? chosen.p.iso : null, iso_utc: chosen && chosen.p ? chosen.p.iso_utc : null, conflict: distinct.length > 1, unparseable };
}

const metaContent = (doc, property) => { const m = doc.metas.find((x) => x.property === property && x.content); return m ? m.content : null; };
const metaName = (doc, name) => { const m = doc.metas.find((x) => x.name === name && x.content); return m ? m.content : null; };

/** Pure analysis of one HTML document. `headers` are lowercased response headers (may be {}). */
export function analyzeFreshness(html, { lang: langFlag, url = null, headers = {}, now = Date.now() } = {}) {
  const tokens = tokenize(html);
  const doc = parseDocument(html, url, { tokens });
  const det = detectLang(tokens, { flag: langFlag, doc });
  const lang = det.supported ? det.lang : null;

  // --- schema.org dates
  const blocks = doc.jsonld.filter((b) => b.ok).map((b) => b.data);
  const schemaDates = collectSchemaDates(blocks);
  const published = pick(schemaDates.published, 'earliest', lang);
  const modified = pick(schemaDates.modified, 'latest', lang);
  const unparseable = [
    ...published.unparseable.map((value) => ({ field: 'datePublished', value })),
    ...modified.unparseable.map((value) => ({ field: 'dateModified', value })),
  ];

  // --- meta dates
  const metaPublished = metaContent(doc, 'article:published_time');
  const metaModified = metaContent(doc, 'article:modified_time');
  const ogUpdated = metaContent(doc, 'og:updated_time');
  const metaDate = metaName(doc, 'date') || metaName(doc, 'dc.date') || metaName(doc, 'dcterms.date') || metaName(doc, 'pubdate');
  const metaLastMod = metaName(doc, 'last-modified') || metaName(doc, 'dc.date.modified') || metaName(doc, 'dcterms.modified') || metaName(doc, 'revised');
  const isoOf = (v) => { const p = v == null ? null : parseDate(v, { lang }); return p && p.iso ? p.iso : null; };

  // --- <time datetime>
  const timeTags = [];
  for (const t of tokens) if ((t.kind === 'open' || t.kind === 'self') && t.name === 'time' && t.attrs.datetime) timeTags.push(t.attrs.datetime);

  // --- visible dates (boilerplate-stripped; script bodies are opaque tokens and never count)
  const mask = contentMask(tokens);
  const contentText = visibleText(tokens, { mask });
  const fullMask = { keep: new Uint8Array(tokens.length).fill(1) };
  for (let i = 0; i < tokens.length; i++) if (tokens[i].kind !== 'text' && tokens[i].kind !== 'open' && tokens[i].kind !== 'self' && tokens[i].kind !== 'close') fullMask.keep[i] = 0;
  for (let i = 0; i < tokens.length; i++) { const t = tokens[i]; if (t.kind === 'open' && (t.name === 'head' || t.name === 'title')) for (let j = i; j < (t.end_idx == null ? tokens.length : t.end_idx); j++) fullMask.keep[j] = 0; }
  const fullText = visibleText(tokens, { mask: fullMask });
  let visibleDates, visibleScope = 'content';
  if (lang) {
    visibleDates = findDates(contentText, { lang, limit: 10 });
    if (!visibleDates.length) { visibleDates = findDates(fullText, { lang, limit: 10 }); visibleScope = visibleDates.length ? 'full' : 'content'; }
  } else {
    // language-neutral scan only: ISO / Y-M-D / unambiguous numeric forms
    const neutral = (arr) => arr.filter((d) => !d.lang && d.iso && !d.ambiguous);
    visibleDates = neutral(findDates(contentText, { lang: undefined, limit: 50 })).slice(0, 10);
    if (!visibleDates.length) { visibleDates = neutral(findDates(fullText, { lang: undefined, limit: 50 })).slice(0, 10); visibleScope = visibleDates.length ? 'full' : 'content'; }
  }
  const labeled = lang ? findLabeledDates(contentText, { lang }) : null;
  const labeledDates = lang ? {
    published: (labeled.find((d) => d.kind === 'published' && d.iso) || {}).iso || null,
    updated: (labeled.find((d) => d.kind === 'updated' && d.iso) || {}).iso || null,
  } : null;

  // --- HTTP Last-Modified
  const lastModified = headers && (headers['last-modified'] || null);
  const lastModifiedIso = lastModified ? isoOf(lastModified) : null;

  // --- comparisons on normalized dates only
  let mismatch = null;
  if (modified.iso && lastModifiedIso) {
    const same = modified.iso === lastModifiedIso || modified.iso_utc === lastModifiedIso;
    if (!same) mismatch = { schema: modified.raw, schema_iso: modified.iso, header: lastModified, header_iso: lastModifiedIso };
  }
  const visibleVsSchema = labeledDates && labeledDates.updated && modified.iso && labeledDates.updated !== modified.iso
    ? { visible: labeledDates.updated, schema: modified.iso } : null;
  const metaVsSchema = metaModified && isoOf(metaModified) && modified.iso && isoOf(metaModified) !== modified.iso
    ? { meta: metaModified, meta_iso: isoOf(metaModified), schema: modified.raw, schema_iso: modified.iso } : null;

  return {
    lang: langSummary(det),
    schema_datePublished: published.raw,
    schema_dateModified: modified.raw,
    has_dateModified: !!modified.raw,
    time_datetime_tags: timeTags.slice(0, 10),
    visible_date_sample: visibleDates.length ? visibleDates[0].raw : null,
    http_last_modified: lastModified,
    modified_age_days: modified.iso ? daysBetween(modified.iso, now) : null,
    published_age_days: published.iso ? daysBetween(published.iso, now) : null,
    schema_vs_lastmodified_mismatch: mismatch,
    schema_datePublished_iso: published.iso,
    schema_dateModified_iso: modified.iso,
    all_published_dates: schemaDates.published,
    all_modified_dates: schemaDates.modified,
    published_dates_conflict: published.conflict,
    modified_dates_conflict: modified.conflict,
    schema_date_unparseable: unparseable,
    modified_before_published: published.iso && modified.iso ? modified.iso < published.iso : null,
    meta_published_time: metaPublished,
    meta_modified_time: metaModified,
    og_updated_time: ogUpdated,
    meta_dates: { published_time_iso: isoOf(metaPublished), modified_time_iso: isoOf(metaModified), og_updated_time_iso: isoOf(ogUpdated), date: metaDate, last_modified: metaLastMod },
    meta_vs_schema_modified_mismatch: metaVsSchema,
    http_last_modified_iso: lastModifiedIso,
    visible_dates: visibleDates.map((d) => ({ raw: d.raw, iso: d.iso, format: d.format, ambiguous: d.ambiguous })),
    visible_date_scope: visibleScope,
    labeled_dates: labeledDates,
    visible_vs_schema_modified_mismatch: visibleVsSchema,
    language_dependent_checks: lang ? 'evaluated' : 'manual_review',
    note: lang ? NOTE : `Language '${det.tag || 'unknown'}' is not supported by the EN/ES lexicons: only ISO/numeric visible dates were scanned and labeled dates are null — review visible dates manually. ` + NOTE,
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const langFlag = flagValue(args.lang);
  const url = input.finalUrl || (typeof args.url === 'string' ? args.url : null);
  const result = { source: input.source, ...analyzeFreshness(input.html, { lang: typeof langFlag === 'string' ? langFlag : undefined, url, headers: input.headers || {} }) };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);
