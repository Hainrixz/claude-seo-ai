---
name: seo-core-web-vitals
description: Audit Core Web Vitals & page performance — measure LCP, INP, and CLS against p75 field thresholds, diagnose render-blocking resources, unoptimized images, and layout-shift sources, and produce prioritized, advisory-only remediation guidance. Module M15. Feeds the Search SEO score (heavily) and the AI Visibility score (minimally).
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-core-web-vitals (M15)

Core Web Vitals are a confirmed Google ranking signal and a proxy for page quality. Thresholds, field-vs-lab honesty rules, and LCP decomposition: `references/cwv-thresholds.md` (follow it exactly).

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Field CWV at p75** — LCP ≤ 2.5 s, INP ≤ 200 ms (INP replaced FID), CLS ≤ 0.1, all at the 75th percentile of real-user data. All three must pass for a "good" rating. Use the proactive-warning thresholds (LCP > 2.0 s, INP > 160 ms, CLS > 0.08) to `warn` before failing.
2. **Render-blocking resources** — synchronous `<script>` in `<head>` (no `defer`/`async`/`type=module`), blocking `<link rel="stylesheet">`, and `@import` chains that delay first render (LCP/INP risk).
3. **Unoptimized images** — missing `width`/`height` (or `aspect-ratio`), no `loading="lazy"` below the fold, no responsive `srcset`/`sizes`, legacy formats where AVIF/WebP would serve, and a non-preloaded LCP image.
4. **Layout-shift sources** — images/iframes/ads/embeds without reserved dimensions, web-font swap without `font-display`/size-adjust, and content injected above existing content (CLS risk).
5. **LCP decomposition** — attribute LCP to TTFB vs resource load delay vs load duration vs render delay (see `references/cwv-thresholds.md`) so each finding targets the dominant subpart.

## Fixes (fixable: advisory)
**Advisory only.** Performance fixes touch build config, server, CDN, and runtime JavaScript — high breakage risk — so the tool **diagnoses and prioritizes** but never auto-edits performance code. For each failing metric, name the specific resource/element causing it and rank fixes by expected leverage (e.g. preload the LCP image, defer non-critical JS, reserve image dimensions). Give framework-specific direction where the stack is known. **Never fabricate measured values** — if field data is absent, ask the user to supply a PSI/CrUX key or leave a clearly-marked TODO placeholder rather than guessing a metric.

## Verification
- Field (Tier 1): `node ${CLAUDE_SKILL_DIR}/../../scripts/psi-client.mjs --url <u>` calls the PageSpeed Insights API (`loadingExperience`, method `psi_api`); CrUX History via the same client (`crux_api`) for p75 trends. Requires a free API key.
- Tier 0 (no key): emit `status: needs_api` for every field-CWV finding, plus clearly-labeled **lab heuristics** (render-blocking count, missing image dimensions, bundle weight). Label lab signals "lab data — not what Google ranks on"; never present a heuristic as a measured field value.
- When the required data tier is unavailable, status is `needs_api` — **never** a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M15.lcp.exceeds_p75` — field LCP > 2.5 s at p75 (status `fail`, severity 4, `fixable: advisory`, axis `search`, confidence `established`). `evidence.observed` quotes the measured p75 value and the LCP element; `verification.reproduce` runs the psi-client command.
- `M15.cls.unsized_image` — image with no `width`/`height` shifting layout (status `warn`, severity 4, `fixable: advisory`, axis `search`, confidence `directional`). `evidence.observed` quotes the `<img>` tag.
- `M15.field.needs_api` — no PSI/CrUX key, field CWV unverifiable (status `needs_api`, severity 4, `fixable: advisory`, axis `search`, confidence `established`).
Each finding: `evidence.observed` quotes the page/measurement; `verification.reproduce` is the runnable command; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **Lab ≠ field.** A single local Lighthouse run is diagnostic only; Google ranks on field (CrUX) p75. Never let a lab number drive the Search score or masquerade as a field result.
- CWV is a real but **modest tie-breaker** signal — it does not override relevance/content quality. Don't promise ranking jumps from a green score; report it as banded `expected_impact`, not a predicted percentage gain.
- A "100" lab performance score is not a pass if field p75 fails; only field data settles a CWV finding.
