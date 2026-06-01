---
name: seo-international
description: Audit and generate hreflang annotations for multilingual sites — check reciprocity, BCP-47 validity, self-reference, x-default, hreflang/canonical conflicts, and <html lang> agreement, and emit reciprocal hreflang link sets. Module M20 (conditional). Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-international (M20)

hreflang tells search engines which language/region URL to serve. This module is **conditional**: it only runs when seo-vertical-detect flags a multilingual site (multiple `lang`/locale URLs, language switcher, or existing hreflang). On monolingual sites every finding is `not_applicable` at severity 0. Schema-type concerns defer to `references/schema-tier1.md`; this module owns link-level localization only.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`). Read hreflang from `<link rel="alternate" hreflang="...">` in `<head>` (also accept HTTP `Link:` headers / sitemap `xhtml:link` when present):
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
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/hreflang-check.mjs --url <u>` — parses the alternate set, validates BCP-47 tags, and checks reciprocity/self-reference/x-default across the discovered cluster.
- Reciprocity requires fetching each declared alternate; when those URLs (or a sitemap tier) are unavailable, status is `needs_api`, **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. On a confirmed multilingual site severity is **4**; otherwise the check is `not_applicable` at severity 0. Examples:
- `M20.hreflang.missing_reciprocal` — page declares `hreflang="de-DE"` for a URL that does not point back (`status: fail`, severity 4, `fixable: proposed`, axis `search`, confidence `established`). `evidence.observed` quotes the one-way `<link>`; `verification.reproduce` runs the hreflang-check command above.
- `M20.hreflang.invalid_bcp47` — `hreflang="en-UK"` (`fail`, severity 4, `fixable: auto`, axis `search`, confidence `established`; recommend `en-GB`).
- `M20.hreflang.missing_xdefault` — cluster has no `x-default` fallback (`warn`, severity 4, `fixable: auto`, axis `search`, confidence `directional`).
- `M20.hreflang.not_applicable` — monolingual site (`not_applicable`, severity 0).

## Honesty
- hreflang is a **targeting/clustering** signal, not a ranking boost: it selects which existing URL to show in a locale, it does not raise rankings. Don't sell it as a ranking lever.
- hreflang does **not** fix thin or machine-translated content, and it is not a substitute for `rel=canonical` — the two work together.
- Bing/Yandex use it weakly to not-at-all; the documented beneficiary is Google. Don't claim cross-engine parity.
