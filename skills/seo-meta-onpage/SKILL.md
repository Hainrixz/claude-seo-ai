---
name: seo-meta-onpage
description: Audit and generate the document head — title and meta description length against the shared bands (title pass 30-60 chars, recommended 50-60; description pass 70-160, recommended 150-160), viewport, charset, <html lang>, and robots-meta sanity — flagging missing/duplicate/out-of-band values and producing length-bounded, keyword-aware replacements. Module M7. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-meta-onpage (M7)

Head hygiene is cheap, deterministic, and the first thing every crawler reads. Reference: `references/schema-tier1.md` for the structured-data layer that sits alongside the head (owned by M5).

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`title`, `metas[]`, `robots_meta[]`, `canonicals[]`, `word_count`) plus `headers` (`content-language`, `x-robots-tag`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Title** — exactly one `<title>`. Length is judged against the **shared bands** in `scripts/lib/bands.mjs` (the single source; `parse-html.mjs`, the on-page checks and this skill all read it): **pass 30-60 characters**, **recommended 50-60**. Inside 50-60 the verdict is `recommended`; inside 30-60 but outside that, `pass`; below 30 `short`, above 60 `long` — both are `warn`, never `fail`. **Fail** only when the title is missing or empty, or duplicated site-wide across distinct URLs. Not all caps; not a pure keyword list.
2. **Meta description** — present, judged against the same shared bands: **pass 70-160 characters**, **recommended 150-160**. Outside the pass band is `warn`, never `fail` — Google rewrites descriptions freely. Not duplicated site-wide; describes this page, not boilerplate.
3. **Viewport** — `<meta name="viewport" content="width=device-width, initial-scale=1">` present (fail if missing — mobile rendering/indexing depends on it).
4. **Charset** — `<meta charset="utf-8">` present and in the first 1024 bytes of `<head>`.
5. **Language** — `<html lang="…">` present and a valid BCP-47 tag.
6. **Robots meta** — sanity-check `<meta name="robots">`: flag an accidental `noindex`/`nofollow` on a page meant to rank. Full indexability/canonical logic (including the canonical tag) is owned by **seo-indexability (M2)** — here only **note presence** of `<link rel="canonical">`, do not adjudicate it.

## Fixes
- **AUTO** — add missing `viewport`, `charset` (utf-8), and `<html lang>` (inferred from `Content-Language` header or page text; leave a TODO if ambiguous). These are deterministic, additive, verifiable writes → diff for `fix`.
- **PROPOSED** — generate/trim a `<title>` and `meta description` from `<h1>`, lead paragraph, and primary topic: length-bounded, keyword-aware but **not** stuffed, brand suffix only if the site uses one. Each is a draft requiring per-item accept (humans own messaging).
- **ADVISORY** — removing an intentional `noindex` is never auto-written; surface it and let the user decide.
- **Never fabricate** a title, description, or `lang` — when content is too thin to derive a value, leave a clearly-marked `TODO:` placeholder for the user to fill.

## Verification
- Method `dom_assert`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-html.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>` / `--file <path>`) — returns `title` (value/length/ok), `meta_description` (value/length/ok), `robots_meta`, `canonical`, and `head_hygiene` (viewport/charset/lang) so each head element's presence and length is asserted directly against the snapshot.
- Duplicate-title/description checks need the full crawl set; when only a single page is available the cross-URL assertion is reported `needs_api`, **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Head hygiene never reaches 5. Examples:
- `M7.title.missing` — no `<title>` (fail, severity 3, `fixable: proposed`, axis `search`, confidence `established`).
- `M7.title.length_out_of_band` — title 78 chars, outside the 30-60 pass band and likely truncated in the SERP (warn, severity 3, `fixable: proposed`, axis `search`, confidence `directional`). Quote the length and the band that produced the verdict.
- `M7.description.length_out_of_band` — description outside the 70-160 pass band (warn, severity 2, `fixable: proposed`, axis `search`, confidence `directional`).
- `M7.viewport.missing` — no responsive viewport (fail, severity 3, `fixable: auto`, axis `search`, confidence `established`).
- `M7.title.duplicate_across_urls` — the same `<title>` is served from several sampled URLs (warn, severity 3, `fixable: proposed`, axis `search`, confidence `directional`). One finding per duplicate cluster, quoting the shared title and the URLs.
- `M7.description.duplicate_across_urls` — the same meta description is served from several sampled URLs (warn, severity 2, `fixable: proposed`, axis `search`, confidence `directional`).
Both duplicate checks are cross-URL: with fewer than two content pages in the run they are reported once as `M7.title.duplicate_across_urls` with status `needs_api` (severity 0, unscored), never as a pass.
**Platform-conditional ids.** This module also emits 6 ids that fire only when `profile.json` names the platform (`shopify`, `wordpress`, `nextjs`, `gatsby`, `jekyll`, `react-router`). They are indexed in `references/routing.md` § Platform-conditional finding ids and specified in `references/platforms/<id>.md` §10.

Each finding: `evidence.observed` quotes the head verbatim (e.g. the exact title string + its length); `verification.reproduce` is the runnable `parse-html.mjs` command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- The "meta keywords" tag is dead — Google ignores it; do not add or recommend it.
- Title/description length bands are SERP-display heuristics (Google truncates on pixel width, not characters), not ranking factors — out-of-band values are `warn`, never `fail`, and impact is `directional` at most. The **pass** band is deliberately wider than the **recommended** band so a 35-character title is not reported as a defect; both bands come from `scripts/lib/bands.mjs` so the script, the report, and this skill can never disagree.
- Google frequently **rewrites** the displayed title/description from on-page content; a perfect tag is not guaranteed to appear, so never promise a SERP snippet as a ranking gain.
