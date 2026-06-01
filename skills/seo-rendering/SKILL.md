---
name: seo-rendering
description: Audit a page's rendering strategy and JavaScript dependency — diff raw HTML against the rendered DOM to measure how much primary content, links, headings, and JSON-LD exist only after JS executes, classify CSR-only / SSR / SSG / ISR, and emit framework-specific guidance. Module M4. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-rendering (M4)

Most AI crawlers do not execute JavaScript, so content that only exists after hydration is invisible to them — CSR-only is a hard AI gate. JS dependency also delays first paint; see `references/cwv-thresholds.md` for how this feeds LCP/INP.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`) and the raw HTML the server first returned:
1. **Content delta**: diff `raw_html` vs `rendered_dom` — measure the share of primary text, internal links, headings (h1–h3), and `<script type="application/ld+json">` blocks that appear **only** after JavaScript runs.
2. **Classify the strategy**: CSR-only (empty/near-empty raw shell, content injected client-side) / SSR / SSG (prerendered static) / ISR (prerendered + revalidated). Use raw-HTML completeness and framework signals (`__NEXT_DATA__`, hydration markers, `data-reactroot`, build manifests).
3. **Hydration-blocked text**: primary content present in raw HTML but hidden/empty until hydration, or rendered only into a client-only island.
4. **Lazy-loaded main content**: above-the-fold or primary content that requires scroll/intersection/interaction to load — invisible to a non-interacting crawler.
5. **AI gate**: if the h1, primary body, or JSON-LD exist only in `rendered_dom`, flag the page as not reliably consumable by non-JS AI crawlers.

## Fixes (fixable: advisory)
Rendering strategy is a framework/architecture decision with high breakage risk, so M4 is **ADVISORY only** — it diagnoses and prioritizes, it never auto-edits build/server code.
- Emit framework-specific guidance: e.g. move CSR-only routes to SSG/ISR or SSR (Next.js App Router server components / `generateStaticParams` + `revalidate`; Nuxt/Astro/SvelteKit equivalents).
- Recommend prerendering or partial prerendering for primary content; reserve client-only islands for genuinely interactive widgets.
- Where the right strategy depends on data freshness or constraints the snapshot can't reveal, leave a clearly-marked TODO for the user — **never** fabricate a `revalidate` interval or assert a strategy choice. Every finding carries `fixable: advisory`.

## Verification
- `render_diff`: compute the content-delta ratio of `raw_html` vs `rendered_dom` (primary text / links / headings / JSON-LD present in rendered but absent in raw). A high delta on primary content confirms the JS dependency.
- Rendering an accurate `rendered_dom` requires a headless-browser data tier. When that tier is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M4.render.csr_only_primary_content` — h1 and body text exist only in `rendered_dom`, raw HTML is an empty shell (status `fail`, severity 5, axis `both`, `fixable: advisory`, confidence `established`).
- `M4.render.jsonld_js_injected` — JSON-LD blocks present only after hydration, so non-JS crawlers see no structured data (status `warn`, severity 4, axis `ai`, `fixable: advisory`, confidence `established`).
- `M4.render.lazy_main_content` — primary content loads only on scroll/interaction (status `warn`, severity 4, axis `both`, `fixable: advisory`, confidence `directional`).
Each finding: `evidence.observed` quotes the raw vs rendered delta on the page; `verification.reproduce` is a runnable `render_diff` assertion; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- Googlebot **does** render JavaScript (second-wave, queued), so a well-built CSR app can still rank in classic Search — frame CSR-only as an AI-visibility and crawl-efficiency problem, not an automatic Google-ranking failure.
- Don't claim "SSR ranks higher than CSR" as a ranking factor; the documented effect is content **availability** to non-JS consumers and faster paint, not a rendering-mode boost. Keep CSR if the page is interactive-by-nature and primary content is still server-delivered.
