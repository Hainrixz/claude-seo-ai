# Core Web Vitals & performance (2026)

Assessed at the **75th percentile (p75)** of real-user (field) data. All three must pass at p75 for a "good" rating.

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| **LCP** — Largest Contentful Paint | ≤ 2.5 s | 2.5–4.0 s | > 4.0 s |
| **INP** — Interaction to Next Paint (replaced FID) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** — Cumulative Layout Shift | ≤ 0.1 | 0.1–0.25 | > 0.25 |

Proactive-warning thresholds (warn before failing): LCP > 2.0 s, INP > 160 ms, CLS > 0.08.

## Field vs lab — be honest

- **Field data (CrUX, p75)** is what Google actually ranks on. Source it from the PageSpeed Insights API (`loadingExperience`, Tier 1, free key). When PSI returns `origin_fallback: true` the numbers are origin-level, not page-level — the finding must say so. CrUX History API (trend data): **TO-VERIFY — not implemented** in `psi-client.mjs`; never claim a CWV trend from this tool.
- **Lab data (local Lighthouse)** is a single synthetic run. Useful for diagnosing causes, but **label it "lab data — not what Google ranks on"** and never let it drive the Search score on its own.
- With no API key (Tier 0): emit only `needs_api` for field CWV plus heuristic, clearly-labeled lab signals (render-blocking resources, missing image dimensions → CLS risk, large bundles → INP/LCP risk). Never present a heuristic as a measured field value.

## LCP decomposition (for actionable advice)

`LCP = TTFB + resource load delay + resource load duration + element render delay`. Identify which subpart dominates to target the fix (server/CDN, preconnect/preload, image optimization, or render-blocking JS/CSS).

## Why advisory-only

Performance fixes touch build config, server, and runtime JavaScript — high breakage risk. The tool **diagnoses and prioritizes** (which resource causes each metric, framework-specific guidance) but does **not** auto-edit performance code. CWV weighs heavily on the Search score and minimally on the AI score.
