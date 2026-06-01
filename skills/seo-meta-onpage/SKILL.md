---
name: seo-meta-onpage
description: Audit and generate the document head — title (50-60 chars), meta description (150-160 chars), viewport, charset, <html lang>, and robots-meta sanity — flagging missing/duplicate/over-long values and producing length-bounded, keyword-aware replacements. Module M7. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-meta-onpage (M7)

Head hygiene is cheap, deterministic, and the first thing every crawler reads. Reference: `references/schema-tier1.md` for the structured-data layer that sits alongside the head (owned by M5).

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Title** — exactly one `<title>`; length 50-60 chars (warn outside the band, **fail** if missing or empty, **fail** if duplicated site-wide across distinct URLs). Not all caps; not pure keyword list.
2. **Meta description** — present, 150-160 chars (warn outside, not fail — Google may rewrite it); not duplicated site-wide; describes the page, not boilerplate.
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
- Method `dom_assert`: `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-html.mjs --url <u>` (or `--file <path>`) — returns `title` (value/length/ok), `meta_description` (value/length/ok), `robots_meta`, `canonical`, and `head_hygiene` (viewport/charset/lang) so each head element's presence and length is asserted directly against the snapshot.
- Duplicate-title/description checks need the full crawl set; when only a single page is available the cross-URL assertion is reported `needs_api`, **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. Examples:
- `M7.title.missing` — no `<title>` (fail, severity 3, `fixable: proposed`, axis `search`, confidence `established`).
- `M7.title.length_out_of_band` — title 78 chars, truncates in SERP (warn, severity 3, `fixable: proposed`, axis `search`, confidence `directional`).
- `M7.viewport.missing` — no responsive viewport (fail, severity 3, `fixable: auto`, axis `search`, confidence `established`).
Each finding: `evidence.observed` quotes the head verbatim (e.g. the exact title string + its length); `verification.reproduce` is the runnable `parse-html.mjs` command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- The "meta keywords" tag is dead — Google ignores it; do not add or recommend it.
- Title/description length bands are SERP-display heuristics (pixel-width truncation), not ranking factors — over-band values are `warn`, not `fail`, and impact is `directional` at most.
- Google frequently **rewrites** the displayed title/description from on-page content; a perfect tag is not guaranteed to appear, so never promise a SERP snippet as a ranking gain.
