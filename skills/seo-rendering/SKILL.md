---
name: seo-rendering
description: Audit a page's rendering strategy and JavaScript dependency — diff raw HTML against the rendered DOM to measure how much primary content, links, headings, and JSON-LD exist only after JS executes, classify CSR-only / SSR / SSG / ISR, and emit framework-specific guidance. Module M4. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-rendering (M4)

Content that only exists after hydration is invisible to any consumer that does not run JavaScript. Google renders JS (documented); most third-party AI crawlers are **reported** not to (directional — see Honesty), so a CSR-only shell is primarily an AI-visibility and crawl-efficiency problem. JS dependency also delays first paint; see `references/cwv-thresholds.md` for how this feeds LCP/INP.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` and `parsed_rendered`, plus the `render{needed,signals,used,confidence,hint,delta}` block — the script already computed the raw-vs-rendered delta; `raw_html_path`/`rendered_html_path` name the files on disk; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`) and the script-computed `render.delta`:
1. **Content delta**: diff `raw_html_path` vs `rendered_html_path` — measure the share of primary text, internal links, headings (h1–h3), and `<script type="application/ld+json">` blocks that appear **only** after JavaScript runs.
2. **Classify the strategy**: CSR-only (empty/near-empty raw shell, content injected client-side) / SSR / SSG (prerendered static) / ISR (prerendered + revalidated). Use raw-HTML completeness and framework signals (`__NEXT_DATA__`, hydration markers, `data-reactroot`, build manifests).
3. **Hydration-blocked text**: primary content present in raw HTML but hidden/empty until hydration, or rendered only into a client-only island.
4. **Lazy-loaded main content**: above-the-fold or primary content that requires scroll/intersection/interaction to load — invisible to a non-interacting crawler.
5. **AI gate**: if the h1, primary body, or JSON-LD exist only in `rendered_html_path`, flag the page as not reliably consumable by non-JS AI crawlers.

## Fixes (fixable: advisory)
Rendering strategy is a framework/architecture decision with high breakage risk, so M4 is **ADVISORY only** — it diagnoses and prioritizes, it never auto-edits build/server code.
- Emit framework-specific guidance: e.g. move CSR-only routes to SSG/ISR or SSR (Next.js App Router server components / `generateStaticParams` + `revalidate`; Nuxt/Astro/SvelteKit equivalents).
- Recommend prerendering or partial prerendering for primary content; reserve client-only islands for genuinely interactive widgets.
- Where the right strategy depends on data freshness or constraints the snapshot can't reveal, leave a clearly-marked TODO for the user — **never** fabricate a `revalidate` interval or assert a strategy choice. Every finding carries `fixable: advisory`.

## Verification
- `render_diff`: compute the content-delta ratio of `raw_html_path` vs `rendered_html_path` (primary text / links / headings / JSON-LD present in rendered but absent in raw). A high delta on primary content confirms the JS dependency.
- Rendering an accurate `rendered_html_path` requires a headless-browser data tier. When that tier is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Examples:
- `M4.render.csr_only_primary_content` — the H1 and body text exist only in `rendered_html_path`; the raw HTML is an empty shell (`fail`, severity 5, axis `both`, `fixable: advisory`, confidence `established`). This is the module's only capping finding, and only at template/site scope.
- `M4.render.jsonld_js_injected` — JSON-LD blocks appear only after hydration, so a non-JS consumer sees no structured data (`warn`, severity **3**, axis `ai`, `fixable: advisory`, confidence `established`).
- `M4.render.lazy_main_content` — primary content loads only on scroll or interaction (`warn`, severity **3**, axis `both`, `fixable: advisory`, confidence `directional`).
- `M4.render.needs_renderer` — the page shows CSR signals and no renderer was available, so the delta could not be measured (`needs_api`, severity 3, axis `both`).
Each finding: `evidence.observed` quotes the raw-vs-rendered delta on the page; `verification.reproduce` is a runnable `render_diff` assertion; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **Googlebot renders JavaScript** — documented by Google (second-wave, queued rendering), so a well-built CSR app can still be indexed and rank. That part is `established`; treat CSR-only as a risk to *AI consumers* and to crawl efficiency, not as an automatic Google failure.
- **"Most AI crawlers do not execute JavaScript" is `directional`, not documented.** Vendors publish user-agent tokens, not rendering capabilities. Word it as "we could not confirm that these crawlers execute JS, and their published behaviour suggests they do not" — never as a vendor statement.
- Don't claim "SSR ranks higher than CSR" as a ranking factor. What is real is content **availability** to non-JS consumers and faster first paint, not a rendering-mode boost. Keep CSR where the page is interactive by nature and the primary content is still server-delivered.
- A render delta measured without a real headless browser is not a measurement — if the renderer tier was unavailable, say `needs_api` rather than inferring the delta from framework markers alone.
