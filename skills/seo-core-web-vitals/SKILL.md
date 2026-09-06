---
name: seo-core-web-vitals
description: Audit Core Web Vitals & page performance — measure LCP, INP, and CLS against p75 field thresholds, diagnose render-blocking resources, unoptimized images, and layout-shift sources, and produce prioritized, advisory-only remediation guidance. Module M15. Feeds the Search SEO score (heavily) and the AI Visibility score (minimally).
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-core-web-vitals (M15)

Core Web Vitals are a confirmed Google ranking signal and a proxy for page quality. Thresholds, field-vs-lab honesty rules, and LCP decomposition: `references/cwv-thresholds.md` (follow it exactly).

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`scripts[]`, `stylesheets[]`, `images[]`) plus `timing.ttfb_ms`, `body.bytes`, and `render` — field data still needs the PSI tier; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Field CWV at p75** — LCP ≤ 2.5 s, INP ≤ 200 ms (INP replaced FID), CLS ≤ 0.1, all at the 75th percentile of real-user data. All three must pass for a "good" rating. Use the proactive-warning thresholds (LCP > 2.0 s, INP > 160 ms, CLS > 0.08) to `warn` before failing.
2. **Render-blocking resources** — synchronous `<script>` in `<head>` (no `defer`/`async`/`type=module`), blocking `<link rel="stylesheet">`, and `@import` chains that delay first render (LCP/INP risk).
3. **Unoptimized images** — missing `width`/`height` (or `aspect-ratio`), no `loading="lazy"` below the fold, no responsive `srcset`/`sizes`, legacy formats where AVIF/WebP would serve, and a non-preloaded LCP image.
4. **Layout-shift sources** — images/iframes/ads/embeds without reserved dimensions, web-font swap without `font-display`/size-adjust, and content injected above existing content (CLS risk).
5. **LCP decomposition** — attribute LCP to TTFB vs resource load delay vs load duration vs render delay (see `references/cwv-thresholds.md`) so each finding targets the dominant subpart.

## Fixes (fixable: advisory)
**Advisory only.** Performance fixes touch build config, server, CDN, and runtime JavaScript — high breakage risk — so the tool **diagnoses and prioritizes** but never auto-edits performance code. For each failing metric, name the specific resource/element causing it and rank fixes by expected leverage (e.g. preload the LCP image, defer non-critical JS, reserve image dimensions). Give framework-specific direction where the stack is known. **Never fabricate measured values** — if field data is absent, ask the user to supply a PSI/CrUX key or leave a clearly-marked TODO placeholder rather than guessing a metric.

## Verification
- Field (Tier 1): `node "${CLAUDE_PLUGIN_ROOT}/scripts/psi-client.mjs" --url <final_url> [--strategy mobile|desktop] [--timeout 60000]` calls the PageSpeed Insights API (`loadingExperience`, method `psi_api`). It takes a **URL only** — there is no `--snapshot` mode, because field data is measured on the live origin, not on a saved DOM. The key comes from the environment (`CLAUDE_PLUGIN_OPTION_PSI_API_KEY`, else `PSI_API_KEY`); there is deliberately no `--key` flag. Without a key the script returns `status: "needs_api"` at exit 0 — branch on `status`, never on the exit code. When PSI sets `origin_fallback`, the numbers are origin-level and the finding must say so. **CrUX History (`crux_api`) is not implemented** by the bundled client (`references/cwv-thresholds.md`): never claim a p75 trend from this tool.
- Tier 0 (no key): emit `status: needs_api` for every field-CWV finding, plus clearly-labeled **lab heuristics** (render-blocking count, missing image dimensions, bundle weight). Label lab signals "lab data — not what Google ranks on"; never present a heuristic as a measured field value.
- When the required data tier is unavailable, status is `needs_api` — **never** a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Field CWV never reaches 5: it is a tie-breaker, not an eligibility gate. Examples:
- `M15.lcp.exceeds_p75` — field LCP > 2.5 s at p75 (status `fail`, severity 4, `fixable: advisory`, axis `search`, confidence `established`). `evidence.observed` quotes the measured p75 value and the LCP element; `verification.reproduce` runs the psi-client command.
- `M15.cls.unsized_image` — image with no `width`/`height` shifting layout (status `warn`, severity 4, `fixable: advisory`, axis `search`, confidence `directional`). `evidence.observed` quotes the `<img>` tag.
- `M15.field.needs_api` — no PSI/CrUX key, field CWV unverifiable (status `needs_api`, severity 4, `fixable: advisory`, axis `search`, confidence `established`).
Each finding: `evidence.observed` quotes the page/measurement; `verification.reproduce` is the runnable command; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **Lab ≠ field.** A single local Lighthouse run is diagnostic only; Google ranks on field (CrUX) p75. Never let a lab number drive the Search score or masquerade as a field result.
- CWV is a real but **modest tie-breaker** signal — it does not override relevance/content quality. Don't promise ranking jumps from a green score; report it as banded `expected_impact`, not a predicted percentage gain.
- A "100" lab performance score is not a pass if field p75 fails; only field data settles a CWV finding.
