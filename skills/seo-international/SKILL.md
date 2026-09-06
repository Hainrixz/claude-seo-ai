---
name: seo-international
description: Audit and generate hreflang annotations for multilingual sites — check reciprocity, BCP-47 validity, self-reference, x-default, hreflang/canonical conflicts, and <html lang> agreement, and emit reciprocal hreflang link sets. Module M20 (conditional). Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-international (M20)

hreflang tells search engines which language/region URL to serve. This module is **conditional**: it only runs when seo-vertical-detect flags a multilingual site (multiple `lang`/locale URLs, language switcher, or existing hreflang). On monolingual sites every finding is `not_applicable` at severity 0. Schema-type concerns defer to `references/schema-tier1.md`; this module owns link-level localization only.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`hreflang[]`, `canonicals[]`, `<html lang>` in `parsed`) plus `headers.link` and the sibling pages under `<run_dir>/pages/` for reciprocity; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`). Read hreflang from `<link rel="alternate" hreflang="...">` in `<head>` (also accept HTTP `Link:` headers / sitemap `xhtml:link` when present):
1. **Reciprocity** — if page A declares an alternate B, B must declare A back. One-way hreflang is ignored by Google.
2. **BCP-47 validity** — each `hreflang` value is a valid language (`en`) or language-region (`en-GB`, `pt-BR`) tag; region is ISO-3166-1 alpha-2, not a country-of-language guess (`en-UK` is invalid; use `en-GB`).
3. **Self-reference** — the page lists itself in its own hreflang set.
4. **x-default** — at least one `hreflang="x-default"` for the language-selector / fallback URL.
5. **hreflang↔canonical conflict** — an hreflang URL must be self-canonical; pointing hreflang at a URL whose `rel=canonical` is a *different* page neutralizes the cluster (cross-check M2/seo-indexability).
6. **`<html lang>` agreement** — the document `lang` attribute matches the locale this URL targets in its own hreflang entry.

## Fixes
- **AUTO** (`fixable: auto`): when the locale→URL map is **known** (supplied by the user, a sitemap, or discovered alternates), generate a complete reciprocal hreflang link set — every locale + a single `x-default` — as a `<head>` diff for `fix`. Additive and deterministic.
- **PROPOSED** (`fixable: proposed`): a partial set inferred from discovered alternates that needs the user to confirm the locale map before write.
- **ADVISORY** (`fixable: advisory`): "this looks multilingual but no locale map exists" — never written by the tool.
- **Never fabricate** locales, region codes, or alternate URLs. If the map is incomplete, leave a clearly-marked `TODO(locale)` placeholder and ask the user.

## Verification
- Offline: `node "${CLAUDE_PLUGIN_ROOT}/scripts/hreflang-check.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>` / `--file <path>`) — parses the alternate set from the `<link>` tags **and** the HTTP `Link` header (`entries`, `header_entries`), validates BCP-47 tags (`invalid_bcp47`), and reports `has_x_default`, `self_referenced`, `duplicate_langs` and the canonical-vs-hreflang conflict. Reciprocity is **not** in this mode: it needs `--url <u> --deep [--budget 25] [--ua <preset>]`, which fetches each declared alternate.
- Reciprocity requires fetching each declared alternate; when those URLs (or a sitemap tier) are unavailable, status is `needs_api`, **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`; axis `search`. On a monolingual site every id is `not_applicable` at severity 0. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).
- `M20.hreflang.missing_reciprocal` — the page declares `hreflang="de-DE"` for a URL that does not point back; Google ignores one-way annotations, so the cluster does not form (`fail`, severity 4, `fixable: proposed`, confidence `established`). `evidence.observed` quotes the one-way `<link>`.
- `M20.hreflang.invalid_bcp47` — e.g. `hreflang="en-UK"` (`fail`, severity **3**, `fixable: auto`, confidence `established`; recommend `en-GB`). One bad value invalidates that entry, not the whole set.
- `M20.hreflang.missing_self` — the page is absent from its own alternate set (`fail`, severity 3, `fixable: auto`, confidence `established`).
- `M20.hreflang.canonical_conflict` — an hreflang URL whose `rel=canonical` points at a different page, which neutralizes the cluster (`fail`, severity 4, `fixable: proposed`, confidence `established`; cross-check M2).
- `M20.hreflang.missing_xdefault` — the cluster has no `x-default` fallback (`warn`, severity **2**, `fixable: auto`, confidence `directional` — `x-default` is recommended, not required, and its absence degrades selector routing rather than breaking the cluster).
- `M20.lang.mismatch` — `<html lang>` disagrees with the locale this URL claims in its own hreflang entry (`warn`, severity 2, `fixable: auto`, confidence `directional`).
- `M20.hreflang.not_applicable` — monolingual site (`not_applicable`, severity 0).
**Platform-conditional ids.** This module also emits 1 id that fires only when `profile.json` names the platform (`shopify`). It is indexed in `references/routing.md` § Platform-conditional finding ids and specified in `references/platforms/<id>.md` §10.

Each finding: `verification.reproduce` runs the hreflang-check command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- hreflang is a **targeting/clustering** signal, not a ranking boost: it selects which existing URL to show in a locale, it does not raise rankings. Don't sell it as a ranking lever.
- hreflang does **not** fix thin or machine-translated content, and it is not a substitute for `rel=canonical` — the two work together.
- Bing and Yandex use it weakly to not at all; the documented beneficiary is Google. Don't claim cross-engine parity.
- Reciprocity cannot be asserted from one page. If the alternates were not fetched within the crawl budget, the finding is `needs_api` — a one-sided view is not evidence of a one-way link.
