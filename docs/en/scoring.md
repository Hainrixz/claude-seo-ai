# Scoring

`claude-seo-ai` reports **two independent 0–100 scores** and **never blends them into one number**. They share inputs but weight them differently. A page can rank well yet be uncitable by AI, or be highly citable yet rank poorly — surfacing both is the point.

- **Search SEO score** — how well the page is set up to rank in classic search engines.
- **AI Visibility (GEO/AEO) score** — how extractable and citable the page is for AI answer engines, and whether it is even eligible (indexed + snippet-eligible).

The scorer is `scripts/score.mjs`. It is pure logic (no network) and fully reproducible; the same findings always give the same scores.

## How a score is computed

Each score is a weighted average of category values over the **active** weights:

```
score = Σ(category_value × weight) / Σ(active weight)
```

A category's value is the severity-weighted pass rate of the findings in that category:

```
points(finding) = status_factor × severity
  status_factor: pass = 1.0, warn = 0.5, fail = 0.0
category_value = 100 × Σ points / Σ severity   (over scored findings only)
```

| status | factor | counted? |
|---|---|---|
| `pass` | 1.0 | yes |
| `warn` | 0.5 | yes |
| `fail` | 0.0 | yes (in the denominator) |
| `needs_api` | — | **excluded**; counted in `needs_api_count` |
| `manual_review` | — | **excluded**; counted in `manual_review_count` |
| `not_applicable` | — | **excluded** |
| any status with `severity: 0` | — | **excluded** (informational) |

A finding only contributes to a score when its `expected_impact.axis` matches that score (`search`, `ai`, or `both`). Shared modules (M4, M5, M9, M13, M16, M18, M19) are scored independently in each score at that score's own weight. Module suffixes are normalized to the parent (`M7b` → `M7`). A finding whose module has no category on its axis is listed in `unmapped_findings` — never silently scored or silently dropped.

### `needs_api` and `manual_review` are excluded, never assumed

Both statuses are dropped before scoring — they **never count as a pass and never penalize**. `needs_api` means an API key, MCP or renderer was missing; `manual_review` means a deterministic check could not decide (for example an unsupported page language) and a human or model must judge. Each axis reports `needs_api_count`, `manual_review_count` and `unscored_count` (everything on the axis that did not enter the score, for any reason) so you know how much of the picture was actually measured.

## Search SEO — category weights

| Category (`name` in the output) | Modules | Weight | Activation |
|---|---|---|---|
| Indexability & Crawl | M1, M2, M3 | 22 | always |
| Core Web Vitals / Performance | M15 | 16 | always |
| On-Page & Meta | M7 | 12 | always |
| Structured Data | M5 | 12 | always |
| Rendering | M4 | 8 | always |
| Internal Linking & Semantics | M10 | 8 | always |
| E-E-A-T | M16 | 7 | always |
| Images / Media | M9 | 5 | always |
| Sitemaps & Discovery | M17 | 5 | always |
| Freshness | M13 | 3 | always |
| Social Cards | M8 | 2 | always |
| E-commerce | M18 | 15 | `vertical:ecommerce` |
| Local | M19 | 10 | `vertical:local-business` |
| International | M20 | 8 | `flag:multilingual` |

## AI Visibility (GEO/AEO) — category weights

Always-on weights sum to 100.

| Category (`name` in the output) | Modules | Weight | Activation |
|---|---|---|---|
| Answer Extractability | M11 | 18 | always |
| AI Crawler Access | M14 | 14 | always |
| Fact Density / Original Data | M12 | 14 | always |
| Structured Data | M5 | 12 | always |
| Rendering (non-JS) | M4 | 10 | always |
| Entity / Knowledge-Graph | M6 | 9 | always |
| E-E-A-T / Authority | M16 | 9 | always |
| Freshness | M13 | 6 | always |
| Agent-readiness | M22 | 4 | always |
| Images / Multimodal | M9 | 4 | always |
| AI discovery & agent endpoints | M21 | **0** | always (reported, never scored) |
| Agentic commerce readiness | M18 | 6 | `vertical:ecommerce` |
| Local / place data | M19 | 5 | `vertical:local-business` |

**M21 has weight 0.** llms.txt, agents.md, the UCP profile, the ARD catalog and the agentic sitemap are checked and reported, but no engine documents that they affect citation, so they never move the AI score. Their findings show up in the category list and in `unscored_count`.

## Conditional categories and how they activate

Only categories that are **active** and have **weight > 0** enter the denominator. When a category is inactive its weight is removed and the rest re-normalize, so a blog is never penalized for lacking Product schema. Each category reports its `active_weight` — the share (in %) of the active total it actually carried.

There are two ways a conditional category becomes active:

1. **Declared** — pass `--vertical ecommerce,local-business`, `--multilingual`, or `--vertical-json <file>` (the output of `seo-vertical-detect`, or a `profile.json` with a `vertical` object). This is what the audit does. In declared mode, anything you did not declare is off: findings of an inactive conditional module are listed in `ignored_conditional[]` and never scored, and a declared vertical with no scored findings produces a warning.
2. **Inferred** (legacy fallback, when you pass no flag) — a conditional category activates as soon as it has one scored finding. The output flags this: `activation.source: "inferred"`, `activation.inferred_categories`, and a warning asking you to declare the vertical.

Each category emits `activation`: `always`, `vertical:ecommerce`, `vertical:local-business`, `flag:multilingual`, or `inactive`.

## Severity calibration

Severity measures **how much eligibility or extractability the observed fact removes** — not how important the module is. Only severity 5 can cap a score (see below).

| Severity | Meaning | Examples |
|---|---|---|
| 5 | Catastrophic, eligibility-killing at site/template scope | site-wide `noindex`, robots.txt blocking Googlebot, `nosnippet`/`max-snippet:0` site-wide, CSR-only shell, robots.txt returning 5xx |
| 4 | Major: a page class loses eligibility or extractability | page-level `noindex` on a key page, Product without price, robots blocking CSS/JS |
| 3 | Moderate: a documented or strongly correlated signal is missing | question heading without a direct answer, missing `dateModified`, thin fact density, author without Person schema |
| 2 | Minor | anaphora openers, missing `x-default`, no `Sitemap:` directive |
| 1 | Cosmetic | optional discovery files |
| 0 | Informational — never scored | web-search probes, GSC AI export, `not_applicable` |

Findings re-assigned in v0.2.0: `M11.heading.no_direct_answer` 5→3, `M11.passage.unresolved_anaphora` 5→2, `M12.*` 4→3, `M6.*` 4→3, `M16.author.missing_person_schema` 4→3, `M4.render.jsonld_js_injected` 4→3, `M18.offer.missing_price` 5→4, `M18.offer.price_feed_mismatch` 5→3, `M18.facets.uncanonicalized` 5→3, `M1.sitemap.missing_directive` 5→2, `M1.robots.blocks_css_js` 5→4, `M20.hreflang.invalid_bcp47` 4→3, `M20.hreflang.missing_xdefault` 4→2.

## Letter bands and the `unscored` state

| Band | Range |
|---|---|
| A | ≥ 90 |
| B | ≥ 80 |
| C | ≥ 70 |
| D | ≥ 60 |
| F | < 60 |
| `unscored` | no active category with weight > 0 |

When nothing on an axis could be scored — no findings, only `needs_api`/`manual_review`, only inactive conditionals, or only weight-0 modules — the axis is **unscored**: `value: null`, `raw_value: null`, `band: "unscored"`, `state: "unscored"`. An empty findings set is never reported as an F.

## Coverage and provisional bands

A one-page run can produce a confident-looking letter from a sliver of the model, so every axis also reports how much of itself was measured:

| Key | Meaning |
|---|---|
| `coverage` | % of the axis's **always-on** weight that carried at least one scored finding |
| `coverage_weight` / `coverage_total` | the same figure as raw weights (the always-on block sums to 100) |
| `provisional` | `true` when `coverage` is below the floor (**50%**) |

Below the floor the axis reports `state: "partial"` and a warning naming the unmeasured categories. **The score and the band do not change** — they are still exactly what the findings produced; the caveat rides beside them. `report.md` shows a Coverage column, marks a provisional band with `*`, and repeats the warning under **Warnings**.

```
"ai_visibility": { "value": 100, "band": "A", "state": "partial", "provisional": true,
                   "coverage": 18, "coverage_weight": 18, "coverage_total": 100,
                   "warnings": ["coverage 18%: only 18 of 100 always-on weight on the ai axis carried a scored finding, …"] }
```

Widen the run (more pages, a full crawl, a PSI key, the model-judged modules) to raise coverage. A capped axis keeps `state: "capped"` and still reports `provisional`; an `unscored` axis is never provisional.

## Severity gating (caps)

A score is capped at **40 (band F)** only when a finding meets **all** of these conditions:

1. `severity: 5` **and** `status: fail`;
2. `expected_impact.confidence: "established"` — a `directional` or `speculative` finding never caps, however severe;
3. its category is **active with weight > 0** on that axis — so M21 (weight 0) and inactive conditional modules never cap.

The output keeps both numbers: `raw_value` is the weighted value before the cap, `value` is `min(raw_value, 40)`; `capped: true` and `state: "capped"` say the gate applied (even when `raw_value` was already ≤ 40), and `cap_reasons[]` lists every gating finding (`id`, `module`, `category`, `severity`, `status`, `confidence`, `scope`).

### Non-production environments

Pass `--environment preview|staging|local` (the audit takes it from `profile.json`). On a non-production host, caps whose id matches `M2.*noindex*`, `M1.robots.*` or `M14.ai_eligibility.not_indexable` are **suppressed**: noindex and robots blocking are expected there. They move to `suppressed_caps[]` with the environment and the reason `expected on a non-production host`, and a warning is added. Any other established sev-5 failure (a CSR-only shell, for instance) still caps. The default, `production`, never suppresses.

### Probes are never scored

Web-search presence probes (`M14.probe.*`) and GSC generative-AI imports (`M14.gsc_ai.*`) are severity 0 and reported under `probes` in `report.json`. They are a proxy, not citation data, and cannot move or cap either score.

## Validation

Every finding is validated against `schema/finding.schema.json` before scoring. Invalid findings are **dropped** and listed in `dropped_findings[]` (`index`, `id`, `errors[]`); `dropped_count` appears at the top level and on both axes. Use `--strict` to make any drop exit with code 2 (CI), and `--validate-only` to check a findings file without scoring it.

## Search-vs-AI interpretations

High = `value ≥ 75`, low = `value < 60`. Each score carries **its own** one-line `interpretation`:

| Quadrant | Search interpretation | AI interpretation |
|---|---|---|
| High Search / Low AI | Ranks well; classic fundamentals are strong. | Hard to cite by AI engines — add extractable structure and verify AI eligibility. |
| Low Search / High AI | Foundational SEO issues to fix first. | Citable by AI, but weak classic ranking limits reach. |
| Low Search / Low AI | Foundational issues — fix indexability and structure first. | Foundational issues — add structure, schema, and answer blocks. |
| High Search / High AI | Strong classic SEO; pursue depth and authority. | Strong AI visibility; keep content fresh and original. |
| Any other (mixed) | Mixed — see the prioritized actions. | Mixed — see the prioritized actions. |
| Axis unscored | Unscored — no scored findings in an active Search category. | Unscored — no scored findings in an active AI category. |

Scores between 60 and 75 are neither high nor low, so a pair that isn't squarely in one quadrant is **mixed**. When one axis is unscored, the other is interpreted on its own level.

The table above is the English wording. `report.mjs --lang es` (and `scoreFindings(..., { lang: 'es' })`) writes the same line, and every warning the scorer emits, in Spanish — a Spanish report must not print English sentences under Spanish headings. Finding text (title, evidence, recommendation) stays English: it comes from the checks, not from the scorer.

## Site rollup (`--manifest`)

With a crawl manifest (`crawl.json`), the scorer scores every sampled page and rolls the results up to a site score:

1. Findings are deduplicated (`id` + scope + location) so a site-wide finding emitted by several page runs counts **once**.
2. Findings attach to pages through `location.url` (host lower-cased, no hash, no trailing slash), `location.file` / the page `slug`, or a `page` hint (url or slug — a rollup-only key, stripped before validation). `scope: site` findings apply to every page, `scope: template` findings to every page of that template; unmatched page findings are treated as site-wide, with a warning.
3. Each page gets its own two scores (so a site-wide cap caps every page).
4. A page that did **not** answer 2xx (404, 429, a 5xx) is never scored. The on-page checks skip a non-content page, so it would collect almost no negative findings and end up scoring higher than a real page. It stays in `pages[]` with its `status`, `scorable: false` and `unscored_reason: "non_2xx_status"`, appears in `unscored_pages[]` and in a warning, carries no weight in the rollup, and never shows up under `worst_pages`. A `status` of `null` (a local file) is scored normally.
5. `site value = Σ w_page × page_value / Σ w_page` over scored pages. `w_page` comes from `manifest.pages[].weight` when present, otherwise from the page role: **homepage 3 · target 2 · first sample of each template 2 · long-tail 1**. This is `method: "role_weights"`; weighting by Search Console impressions is planned as `method: "gsc_impressions"`.
6. A **one-page** run has no rollup at all, so a single audited URL that answered 404/429/5xx still reports the two axes — from site-level findings only. The report then carries a warning saying exactly that: the scores describe no page.
7. The rollup is `capped` only when every scored page is capped (a site-wide gate); page-only caps are counted in a warning. `pages[]` lists each page's role, weight, HTTP status and both scores; `pages_scored` says how many of `pages_count` actually entered the mean, and `worst_pages` gives the three lowest scored pages per axis.

## Running the scorer

```bash
# a findings file, stdin, or a persisted run
node scripts/score.mjs --findings findings.json
cat findings.json | node scripts/score.mjs
node scripts/score.mjs --run ~/.claude-seo-ai/runs/example.com/latest        # reads <run>/findings.json

# declare the vertical (what the audit does) instead of inferring it
node scripts/score.mjs --findings findings.json --vertical ecommerce,local-business --multilingual
node scripts/score.mjs --findings findings.json --vertical-json profile.json

# staging/preview hosts: noindex/robots caps are suppressed and reported
node scripts/score.mjs --findings findings.json --environment staging

# site rollup from a crawl manifest (findings from --findings/--run, or the ones the manifest carries)
node scripts/score.mjs --run <run-dir> --manifest              # <run-dir>/crawl.json
node scripts/score.mjs --manifest crawl.json

# CI
node scripts/score.mjs --findings findings.json --strict        # exit 2 if any finding was dropped
node scripts/score.mjs --findings findings.json --validate-only
```

Input is a JSON array of findings, or `{ "findings": [...] }`, each conforming to `schema/finding.schema.json`. Exit codes: `0` ok · `1` bad invocation (no input, unreadable file, invalid JSON, bad flag) · `2` `--strict` with dropped findings.

## Output shape

```json
{
  "findings_count": 7,
  "search_seo": {
    "value": 40, "band": "F", "capped": true, "needs_api_count": 1,
    "raw_value": 71.8, "state": "capped",
    "cap_reasons": [ { "id": "M2.robots.noindex_sitewide", "module": "M2", "category": "Indexability & Crawl", "severity": 5, "status": "fail", "confidence": "established", "scope": "site" } ],
    "suppressed_caps": [],
    "manual_review_count": 0, "unscored_count": 1, "dropped_count": 0,
    "warnings": [],
    "categories": [
      { "name": "Indexability & Crawl", "weight": 22, "value": 50, "active": true, "modules": ["M1", "M2", "M3"], "active_weight": 56.4, "activation": "always", "conditional": false, "scored": 2, "needs_api": 0, "manual_review": 0 }
    ],
    "interpretation": "Foundational SEO issues to fix first."
  },
  "ai_visibility": { "value": null, "band": "unscored", "state": "unscored", "...": "same keys" },
  "dropped_count": 0, "dropped_findings": [], "unmapped_findings": [], "ignored_conditional": [],
  "activation": { "source": "declared", "vertical": { "primary": "ecommerce", "also": [], "multilingual": false }, "environment": "production", "inferred_categories": [] },
  "warnings": []
}
```

The legacy keys (`value`, `band`, `capped`, `needs_api_count`, `categories[].name/weight/value/active`, `interpretation`) are unchanged; everything else is additive. With `--manifest` the result also carries `method`, `weights`, `pages_count`, `pages_scored`, `pages[]`, `unscored_pages[]`, `worst_pages`, `unassigned_count`. Both axis objects validate against `$defs.score` in `schema/audit-report.schema.json`.
