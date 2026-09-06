---
name: seo-images-media
description: Audit and fix image & media accessibility for a page — detect missing/empty/duplicated/keyword-stuffed alt text, check alt quality and length, missing width/height (CLS), legacy formats, and absent VideoObject schema; generate contextual alt and dimensions. Module M9. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-images-media (M9)

Accessible, well-described media is read by both ranking systems and AI extractors — alt text is the primary semantic handle for an image. Reference: `references/schema-tier1.md` (VideoObject row).

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`images[]` with `alt_present`/`sized`/`lazy`, `iframes`, `jsonld[]`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Alt presence**: every content `<img>` has an `alt` attribute. Distinguish decorative images (`alt=""` + `role="presentation"` is correct, not a finding) from missing `alt` entirely (fail).
2. **Alt quality**: not empty on a content image; not the filename (`IMG_2031.jpg`); not duplicated verbatim across distinct images; not keyword-stuffed (comma-separated keyword lists are an anti-pattern). Alt should be descriptive and contextual to surrounding content. Target length ~80-140 chars — long enough to be specific, short enough that screen readers/AI don't truncate.
3. **Dimensions**: `width` and `height` set on `<img>` (or aspect-ratio reserved in CSS) to prevent layout shift (CLS, a Core Web Vitals input — defer the CWV measurement itself to the perf module).
4. **Format**: flag legacy `jpg`/`png` where a modern format (WebP/AVIF) or a responsive `<picture>`/`srcset` would serve smaller bytes.
5. **Video**: embedded video (`<video>`, YouTube/Vimeo iframe) without `VideoObject` JSON-LD — coordinate with M5; required/recommended props in `references/schema-tier1.md`.

## Fixes
- **AUTO** (`fixable: auto`): add `width`/`height` to `<img>` from the source asset's intrinsic dimensions (deterministic, additive, verifiable) — emitted as a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): generate contextual alt text inferred from the image plus its surrounding heading/caption/paragraph. Drafts require per-item human accept (alt is editorial). **Never** fabricate what an image depicts beyond what the page context supports — leave a clearly-marked `TODO: describe image` placeholder when context is insufficient, or ask the user.
- **ADVISORY** (`fixable: advisory`): format upgrades (WebP/AVIF, `srcset`). The tool cannot transcode binaries, so it never writes these — it recommends only.

## Verification
- Method `dom_assert`: re-parse the snapshot and assert the condition (alt non-empty, `width`+`height` present, not a filename, etc.).
- When dimension checks need the intrinsic size of a remote asset and no fetch tier is available, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`; axis `both`; severity 3 across the module. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Nothing in M9 reaches 4.
- `M9.alt.missing` — content `<img>` with no `alt` attribute. status `fail`, `fixable: proposed`, confidence `established`. `evidence.observed` quotes the offending `<img>` tag.
- `M9.img.no_dimensions` — `<img>` lacking `width`/`height`. status `warn`, `fixable: auto`, confidence `directional` (CLS link). 
- `M9.video.missing_videoobject` — embedded video without VideoObject schema. status `warn`, `fixable: proposed`, confidence `established`.
Each finding: `evidence.observed` quotes the page; `verification.reproduce` is runnable, e.g. `node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-html.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) then inspect the `images` block (`missing_alt`, `empty_alt`, `missing_dimensions`). `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- Alt text aids accessibility and image/AI understanding; treat ranking lift as `directional`, not a guaranteed gain — do not promise traffic from alt rewrites.
- Keyword-stuffing alt is harmful, not helpful — flag it, never generate it.
- WebP/AVIF reduce bytes (a real perf input) but format alone is not a documented ranking factor; keep it `advisory`/`low` magnitude.
