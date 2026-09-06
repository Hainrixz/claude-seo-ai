---
name: seo-freshness
description: Audit and repair freshness & temporal signals on a page — reconcile visible publish/update dates with schema datePublished/dateModified, flag staleness against topic volatility, and inject honest dateModified. Module M13. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-freshness (M13)

Freshness is a recency signal both classic ranking systems (Query Deserves Freshness) and AI answer engines weigh — Perplexity in particular favours recently-updated sources when citing. Date fields tie directly to Article schema (cross-check M5); see `references/schema-tier1.md` for the date rules.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`jsonld[]`, `metas[]` for `article:published_time`/`modified_time`) plus `headers.last-modified`; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Visible dates**: detect on-page "Published" / "Updated on" / "Last reviewed" patterns and their values (ISO or human-readable).
2. **Schema dates**: parse `datePublished`/`dateModified` from JSON-LD `Article`/`BlogPosting`/`NewsArticle`.
3. **Agreement**: visible date and schema date must match; flag mismatches and schema dates with no visible counterpart (AI engines distrust hidden-only dates).
4. **Staleness**: estimate content age (most recent reliable date) vs topic volatility — fast-moving topics (prices, tooling, "best X 2026", regulations) decay faster than evergreen reference content. Report stale, not just old.
5. **Pattern hygiene**: "updated on" with no substantive content change is a freshness anti-pattern — note it, never recommend it.

## Fixes
- **AUTO** (`fixable: auto`): inject a missing `dateModified` into existing Article schema as an additive diff for `fix`. **Never backdate** to a false date — use the verifiable last-change date (e.g. Last-Modified header / repo mtime / today) or leave a clearly-marked `TODO` placeholder the user confirms.
- **PROPOSED** (`fixable: proposed`): surface visible-vs-schema date mismatches with the corrected value as a draft requiring per-item accept; never auto-rewrite a date the user must verify.
- **ADVISORY** (`fixable: advisory`): recommend a genuine content refresh for stale-on-volatile pages — the tool never writes editorial content. **Never fabricate** dates or invent an update that did not happen.

## Verification
- `dom_assert`: visible date string present and parses; matches schema value.
- `schema_validator`: `datePublished`/`dateModified` present, valid ISO 8601, `dateModified >= datePublished`.
- `header_check`: HTTP `Last-Modified` header corroborates the claimed modification date.
- When the live tier (header fetch / validator) is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`; axis `both`; confidence `directional` throughout. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Freshness never caps.
- `M13.datemodified.missing` — Article schema with `datePublished` but no `dateModified` (`fail`, severity 3, `fixable: auto`).
- `M13.dates.visible_schema_mismatch` — visible "Updated May 2025" against schema `dateModified: 2023-01-10` (`warn`, severity 3, `fixable: proposed`).
- `M13.content.stale_volatile` — a "best X 2024" page unchanged for two years on a fast-moving topic (`warn`, severity 2, `fixable: advisory`).
- `M13.schema.date_unparseable` — a date field that exists but does not parse as ISO 8601, or a page with several `dateModified` values (the latest wins, and the conflict is reported) (`warn`, severity 2, `fixable: proposed`). Emit this instead of a mismatch: an unreadable date is a parsing gap, not proof the dates disagree.
Each finding: `evidence.observed` quotes the page (date string + selector); `verification.reproduce` is a runnable assertion (e.g. `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-freshness.mjs" --snapshot <pages/<slug>.json> [--lang en|es|auto]` (or `--url <u>`)); `expected_impact` is banded + confidence-tagged, with any published number confined to `rationale` with a citation.

## Honesty
- Freshness is a contextual signal, not a universal ranking boost — refreshing evergreen content rarely moves rankings, and a `dateModified` bump without a real content change is detectable and adds no durable value. Confidence here is **directional**, never `established`; never present a date edit as a guaranteed ranking gain or backdate to fake recency.
- Date parsing is language-bound: Spanish month names and `article:published_time`/`article:modified_time` are read, but an unrecognized format produces `M13.schema.date_unparseable`, never a fabricated mismatch.
