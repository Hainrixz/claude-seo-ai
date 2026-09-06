// M20 — hreflang. Runs once over the whole run so reciprocity can be judged inside the crawl:
// an alternate that was never fetched is reported as unmeasured, never as one-way.
//
// On a site where nothing declares hreflang and the vertical is not flagged multilingual, the whole
// module reports M20.hreflang.not_applicable at severity 0 rather than staying silent.

import { isBcp47 } from '../lib/util.mjs';
import {
  mk, push, clip, listing, plural, agree, contentPages, finalUrl, hreflangEntries, isMultilingual,
  urlKey, snapRepro, originOf,
} from './_shared.mjs';

const X_DEFAULT = 'x-default';

/**
 * ISO 3166-1 alpha-2 region codes. hreflang syntax alone is not enough: `en-UK` parses as a valid
 * BCP 47 tag but UK is not an assigned region (the United Kingdom is GB), and Google documents that
 * it ignores the annotation. BCP 47 also allows UN M.49 numeric regions such as `es-419`.
 */
export const ISO_3166_1 = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV '
  + 'BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG '
  + 'KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX '
  + 'MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG '
  + 'SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG '
  + 'VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

/** Region subtags people write for a region that does not exist, with the code Google expects. */
export const REGION_CORRECTIONS = Object.freeze({ UK: 'GB', EU: 'a language-only tag, or one entry per member country', EN: 'GB or US', SP: 'ES', JA: 'JP' });

/** Primary language subtag of a tag ('es-MX' -> 'es'); null for x-default or junk. */
function primary(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t || t === X_DEFAULT) return null;
  const m = /^([a-z]{2,3})(?:-|$)/.exec(t);
  return m ? m[1] : null;
}

/**
 * Why a tag is unusable, or null when it is fine. Syntax first, then the region assignment —
 * the second is what catches the common `en-UK`.
 */
export function tagProblem(value) {
  const raw = String(value || '').trim();
  if (raw.toLowerCase() === X_DEFAULT) return null;
  if (!raw) return 'the value is empty';
  if (raw.includes('_')) return 'BCP 47 separates subtags with "-", not "_"';
  if (!isBcp47(raw)) return 'it is not a well-formed BCP 47 language tag';
  const parts = raw.split('-');
  const region = parts.length > 1 ? parts[1].toUpperCase() : null;
  if (!region || /^[0-9]{3}$/.test(region)) return null;      // language-only, or a UN M.49 region
  if (region.length === 4) return null;                        // a script subtag (e.g. zh-Hant)
  if (region.length !== 2) return 'the region subtag "' + parts[1] + '" is neither ISO 3166-1 alpha-2 nor a UN M.49 code';
  if (ISO_3166_1.has(region)) return null;
  const fix = Object.prototype.hasOwnProperty.call(REGION_CORRECTIONS, region) ? REGION_CORRECTIONS[region] : null;
  return 'the region subtag "' + parts[1] + '" is not an ISO 3166-1 alpha-2 code' + (fix ? ' (use ' + fix + ')' : '');
}

export const check = {
  id: 'international',
  module: 'M20',
  scope: 'site',
  ids: [
    'M20.hreflang.not_applicable', 'M20.hreflang.invalid_bcp47', 'M20.hreflang.missing_self',
    'M20.hreflang.missing_reciprocal', 'M20.hreflang.canonical_conflict', 'M20.hreflang.missing_xdefault',
    'M20.lang.mismatch',
  ],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx);
    const declaring = pages.filter((p) => hreflangEntries(p).length);

    if (!declaring.length) {
      push(out, mk({
        id: 'M20.hreflang.not_applicable', title: 'No hreflang annotations on this site', status: 'not_applicable', scope: 'site',
        evidence: { observed: 'None of the ' + plural(pages.length, 'sampled page') + ' declares a rel="alternate" hreflang link or Link header' + (isMultilingual(ctx) ? ', although the run declares the site multilingual' : '') + '.' },
        expected: 'A monolingual site needs no hreflang; a multilingual one annotates each locale cluster.',
        recommendation: isMultilingual(ctx)
          ? 'The run declares this site multilingual: add reciprocal hreflang annotations (including a self-reference and an x-default) to each localised URL.'
          : 'Nothing to do — hreflang only applies once the same content exists in more than one language or region.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'No page emits <link rel="alternate" hreflang="…">.' },
        reproduce: pages.length ? snapRepro(ctx, pages[0], 'hreflang-check.mjs') : { script: 'hreflang-check.mjs', args: { url: originOf(ctx) || '' } },
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents hreflang as applying to pages that exist in several languages or regions; on a monolingual site there is nothing for it to annotate.' },
      }));
      return out;
    }

    // Index the run by URL so an alternate can be resolved to a page we actually fetched.
    const byKey = new Map();
    for (const p of pages) {
      const k = urlKey(finalUrl(p));
      if (k) byKey.set(k, p);
    }

    for (const page of declaring) {
      const url = finalUrl(page);
      const at = { location: { url } };
      const repro = snapRepro(ctx, page, 'hreflang-check.mjs');
      const entries = hreflangEntries(page);
      const selfKey = urlKey(url);

      /* ---- syntax ------------------------------------------------------------------------- */
      const invalid = entries.map((e) => ({ entry: e, problem: tagProblem(e.hreflang) })).filter((x) => x.problem);
      if (invalid.length) {
        push(out, mk({
          id: 'M20.hreflang.invalid_bcp47', title: 'hreflang value is not a valid BCP 47 tag', status: 'fail', severity: 3, scope: 'page', ...at,
          evidence: { observed: listing(invalid.map((x) => '<link rel="alternate" hreflang="' + clip(x.entry.hreflang, 20) + '" href="' + clip(x.entry.abs || x.entry.href, 70) + '"> — ' + x.problem), 3) + ' on ' + url + '.' },
          expected: 'Each hreflang is an ISO 639-1 language code, optionally with an ISO 3166-1 alpha-2 region (or a UN M.49 numeric region), or x-default.',
          recommendation: 'Correct the tag. The usual case is a region that does not exist: en-UK should be en-GB.',
          fixable: 'auto',
          verification: { method: 'dom_assert', assertion: 'Every hreflang attribute is a well-formed BCP 47 tag with an assigned region, or equals x-default.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that hreflang values must use ISO 639-1 language and ISO 3166-1 alpha-2 region codes and that it ignores the ones it cannot resolve, so that alternate does not exist for the cluster.' },
        }));
      }

      /* ---- self reference ------------------------------------------------------------------ */
      const hasSelf = entries.some((e) => e.abs && urlKey(e.abs) === selfKey);
      if (!hasSelf) {
        push(out, mk({
          id: 'M20.hreflang.missing_self', title: 'Page is absent from its own hreflang set', status: 'fail', severity: 3, scope: 'page', ...at,
          evidence: { observed: url + ' declares ' + plural(entries.length, 'alternate') + ' (' + listing(entries.map((e) => e.hreflang), 5) + ') and none of them points at itself.' },
          expected: 'Every page in a cluster lists itself among its alternates.',
          recommendation: 'Add a self-referential <link rel="alternate" hreflang="<this page\'s locale>" href="' + url + '">.',
          fixable: 'auto',
          verification: { method: 'dom_assert', assertion: 'One alternate href equals the page\'s own canonical URL.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents the self-referential annotation as required for the set to be understood as a cluster.' },
        }));
      }

      /* ---- x-default ------------------------------------------------------------------------ */
      const locales = new Set(entries.map((e) => String(e.hreflang).toLowerCase()).filter((t) => t !== X_DEFAULT));
      if (locales.size >= 2 && !entries.some((e) => String(e.hreflang).toLowerCase() === X_DEFAULT)) {
        push(out, mk({
          id: 'M20.hreflang.missing_xdefault', title: 'hreflang cluster has no x-default', status: 'warn', severity: 2, scope: 'page', ...at,
          evidence: { observed: url + ' declares ' + locales.size + ' locales (' + listing([...locales], 6) + ') and no hreflang="x-default" entry.' },
          expected: 'A cluster covering several locales names one URL as the fallback with x-default.',
          recommendation: 'Add <link rel="alternate" hreflang="x-default" href="<the locale selector or default page>">.',
          fixable: 'auto',
          verification: { method: 'dom_assert', assertion: 'The alternate set contains an hreflang="x-default" entry.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google documents x-default as recommended rather than required; its absence degrades routing for unmatched users instead of breaking the cluster.' },
        }));
      }

      /* ---- <html lang> vs the locale this URL claims ---------------------------------------- */
      const own = entries.find((e) => e.abs && urlKey(e.abs) === selfKey);
      const claimed = own ? primary(own.hreflang) : null;
      const declared = primary(page.parsed && page.parsed.lang);
      if (claimed && declared && claimed !== declared) {
        push(out, mk({
          id: 'M20.lang.mismatch', title: '<html lang> disagrees with the locale this URL claims in hreflang', status: 'warn', severity: 2, scope: 'page', ...at,
          evidence: { observed: url + ' serves <html lang="' + clip(page.parsed.lang, 20) + '"> while its own hreflang entry claims "' + clip(own.hreflang, 20) + '".' },
          expected: '<html lang> and the page\'s own hreflang entry name the same language.',
          recommendation: 'Set <html lang> from the same locale variable that generates the hreflang set.',
          fixable: 'auto',
          verification: { method: 'dom_assert', assertion: 'The primary subtag of <html lang> equals the primary subtag of the self-referential hreflang.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google says it does not use <html lang> for language detection, so the conflict mostly misleads browsers, translation tools and assistive technology.' },
        }));
      }

      /* ---- reciprocity + canonical conflicts (only for alternates the crawl fetched) ---------- */
      const oneWay = [];
      const conflicts = [];
      const unmeasured = [];
      for (const e of entries) {
        if (!e.abs || String(e.hreflang).toLowerCase() === X_DEFAULT) continue;
        const key = urlKey(e.abs);
        if (key === selfKey) continue;
        const target = byKey.get(key);
        if (!target) { unmeasured.push(e); continue; }
        const back = hreflangEntries(target).some((t) => t.abs && urlKey(t.abs) === selfKey);
        if (!back) oneWay.push({ entry: e, target });
        const canonical = ((target.parsed && target.parsed.canonicals) || [])[0];
        const canonicalAbs = canonical && (canonical.abs || canonical.href);
        if (canonicalAbs && urlKey(canonicalAbs) !== key) conflicts.push({ entry: e, canonical: canonicalAbs });
      }

      if (oneWay.length) {
        push(out, mk({
          id: 'M20.hreflang.missing_reciprocal', title: 'hreflang annotation is one-way', status: 'fail', severity: 4, scope: 'page', ...at,
          evidence: { observed: url + ' declares ' + listing(oneWay.map((o) => '<link rel="alternate" hreflang="' + o.entry.hreflang + '" href="' + clip(o.entry.abs, 70) + '">'), 3) + ', and ' + (oneWay.length === 1 ? 'that URL does' : 'those URLs do') + ' not link back to it.' },
          expected: 'Every alternate points back at every other member of the cluster, including this page.',
          recommendation: 'Add the return annotation on the alternate URL(s), or drop the one-way entry.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Each alternate page lists ' + url + ' among its own hreflang entries.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that it ignores hreflang annotations that are not confirmed by a return link, so the cluster does not form.' },
        }));
      }

      if (conflicts.length) {
        push(out, mk({
          id: 'M20.hreflang.canonical_conflict', title: 'An hreflang alternate canonicalises to a different page', status: 'fail', severity: 4, scope: 'page', ...at,
          evidence: { observed: listing(conflicts.map((c) => c.entry.abs + ' (declared as hreflang="' + c.entry.hreflang + '" by ' + url + ') canonicalises to ' + c.canonical), 3) + '.' },
          expected: 'Each alternate self-canonicalises, so the cluster and the canonicalisation agree.',
          recommendation: 'Make the alternate self-canonical, or point the hreflang entry at the canonical URL instead.',
          fixable: 'proposed',
          verification: { method: 'dom_assert', assertion: 'Every alternate URL carries a self-referential canonical.' },
          reproduce: repro,
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that hreflang and rel=canonical must agree; a cross-URL canonical on an alternate collapses the cluster it was supposed to join.' },
        }));
      }

      if (unmeasured.length && !oneWay.length) {
        push(out, mk({
          id: 'M20.hreflang.missing_reciprocal', title: 'Reciprocity of some alternates was not measured', status: 'needs_api', scope: 'page', ...at,
          evidence: { observed: plural(unmeasured.length, 'alternate') + ' declared by ' + url + ' ' + agree(unmeasured.length, 'was', 'were') + ' not fetched in this run, so the return link could not be verified: ' + listing(unmeasured.map((e) => e.hreflang + ' -> ' + clip(e.abs, 70)), 4) + '.' },
          expected: 'Every alternate is fetched and its return annotation confirmed.',
          recommendation: 'Run hreflang-check.mjs --deep on this URL (it fetches the alternates within a budget), or widen the crawl to include the other locales.',
          fixable: 'advisory',
          verification: { method: 'dom_assert', assertion: 'Each alternate URL is fetched and lists ' + url + ' among its hreflang entries.' },
          reproduce: snapRepro(ctx, page, 'hreflang-check.mjs', { deep: true }),
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'A return link that was not fetched is unknown; calling it missing would invent the observation.' },
        }));
      }
    }

    return out;
  },
};

export default check;
