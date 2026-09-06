// M13 — freshness, deterministic part only. Dates are normalised by check-freshness.mjs
// (analyzeFreshness), which reads schema.org, <time datetime>, the article:* metas, Last-Modified
// and the visible text, and reports what it could not parse instead of guessing.
//
// M13.content.stale_volatile is deliberately not emitted here: deciding that a topic is
// fast-moving is a judgement, not an observation, so it stays with the model-judged pass.

import { analyzeFreshness } from '../check-freshness.mjs';
import { mk, push, clip, listing, plural, agree, finalUrl, isContentPage, snapRepro } from './_shared.mjs';
import { flattenNodes } from '../lib/jsonld.mjs';

export const DATED_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'ScholarlyArticle', 'Report', 'LiveBlogPosting', 'WebPage', 'Recipe', 'HowTo'];

function datedNodes(page) {
  const out = [];
  for (const b of (page.parsed && page.parsed.jsonld) || []) {
    if (!b || b.ok === false || b.data === undefined) continue;
    for (const n of flattenNodes(b.data)) if (n.types.some((t) => DATED_TYPES.includes(t))) out.push(n);
  }
  return out;
}

export const check = {
  id: 'freshness',
  module: 'M13',
  scope: 'page',
  ids: ['M13.datemodified.missing', 'M13.dates.visible_schema_mismatch', 'M13.schema.date_unparseable'],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page) || typeof page.html !== 'string') return out;
    const url = finalUrl(page);
    const at = { location: { url } };
    const repro = snapRepro(ctx, page, 'check-freshness.mjs');

    const f = analyzeFreshness(page.html, {
      lang: ctx.options && ctx.options.lang,
      url,
      headers: (page.snapshot && page.snapshot.headers) || {},
    });

    const dated = datedNodes(page);

    /* ---- dateModified missing ----------------------------------------------------------------- */
    if (dated.length && f.schema_datePublished && !f.has_dateModified) {
      push(out, mk({
        id: 'M13.datemodified.missing', title: 'Dated schema carries datePublished but no dateModified', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: listing(dated.map((n) => n.path), 3) + ' on ' + url + ' declares datePublished "' + clip(f.schema_datePublished, 40) + '" and no dateModified.' },
        expected: 'A dated node carries both datePublished and dateModified.',
        recommendation: 'Emit dateModified from the CMS\'s real update timestamp (not the build time) alongside datePublished.',
        fixable: 'auto',
        verification: { method: 'schema_validator', assertion: 'The dated node exposes a dateModified property that parses as ISO 8601.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Google documents dateModified as one of the signals it uses to show a date, but states the date shown is chosen from several sources, so the effect is not guaranteed.' },
      }));
    }

    /* ---- visible date vs schema --------------------------------------------------------------- */
    const mismatch = f.visible_vs_schema_modified_mismatch || f.meta_vs_schema_modified_mismatch || f.schema_vs_lastmodified_mismatch;
    if (mismatch) {
      const shown = mismatch.visible || mismatch.meta || mismatch.header || mismatch.schema;
      push(out, mk({
        id: 'M13.dates.visible_schema_mismatch', title: 'The date the page shows disagrees with the date in the markup', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: 'On ' + url + ': ' + JSON.stringify(mismatch).slice(0, 300) + '.' },
        expected: 'The visible "updated" date, the article:modified_time meta, Last-Modified and schema dateModified all describe the same moment.',
        recommendation: 'Render every date from one source. If the page text is right, fix the markup; if the markup is right, fix the template that prints the date.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'The visible date and schema dateModified normalise to the same day.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Google states that conflicting dates make it pick one, and that structured data should match visible content; which date wins is not documented.' },
      }));
    }

    /* ---- unparseable / conflicting dates ------------------------------------------------------- */
    const unparseable = f.schema_date_unparseable || [];
    if (unparseable.length || f.modified_dates_conflict || f.published_dates_conflict) {
      const parts = [];
      if (unparseable.length) parts.push(plural(unparseable.length, 'schema date') + ' ' + agree(unparseable.length, 'does', 'do') + ' not parse: ' + listing(unparseable.map((u) => u.field + '="' + clip(u.value, 40) + '"'), 3));
      if (f.modified_dates_conflict) parts.push('several dateModified values were found (' + listing(f.all_modified_dates || [], 4) + '); the latest was used');
      if (f.published_dates_conflict) parts.push('several datePublished values were found (' + listing(f.all_published_dates || [], 4) + '); the earliest was used');
      push(out, mk({
        id: 'M13.schema.date_unparseable', title: 'Schema dates do not parse, or the page declares several', status: 'warn', severity: 2, scope: 'page', ...at,
        evidence: { observed: parts.join('; ') + ' on ' + url + '.' },
        expected: 'One datePublished and one dateModified per node, each a valid ISO 8601 value.',
        recommendation: 'Emit ISO 8601 dates (with a timezone offset) and exactly one of each per node.',
        fixable: 'proposed',
        verification: { method: 'schema_validator', assertion: 'Every date property parses as ISO 8601 and appears once per node.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'An unreadable date is a parsing gap, not proof the dates disagree, so it is reported instead of a mismatch.' },
      }));
    }

    return out;
  },
};

export default check;
