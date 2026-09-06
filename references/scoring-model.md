# Scoring model — two scores, never blended

`claude-seo-ai` reports **two independent 0–100 scores**. They share inputs but weight them differently and must never be averaged into one number. A page can rank well yet be uncitable by AI, or vice-versa — surfacing both is the product thesis.

Each score = `Σ(category_value × weight) / Σ(active weight)` where `category_value` ∈ [0,100] is the severity-weighted pass rate of that category's findings. Implementation: `scripts/score.mjs` (`scoreFindings`, `scoreSite`). Findings are validated against `schema/finding.schema.json` first; the score output validates against `$defs.score` in `schema/audit-report.schema.json`.

## Category value (per category)

```
points(finding) = status_factor × severity
  status_factor: pass = 1.0, warn = 0.5, fail = 0.0
  excluded (neither numerator nor denominator): needs_api, manual_review, not_applicable, severity 0
category_value = 100 × Σ points / Σ severity   (over scored findings only)
```

`needs_api` (no key/MCP/renderer), `manual_review` (a deterministic check could not decide — e.g. unsupported page language — and a human or model must judge) and `not_applicable` are **never a silent pass and never a penalty**. Each axis reports `needs_api_count`, `manual_review_count` and `unscored_count` so the reader knows how much of the picture was actually scored. Severity `0` marks informational findings (probes, GSC AI exports): they are reported and never scored.

A finding contributes only to the axis named in `expected_impact.axis` (`search`, `ai`, `both`). Module suffixes normalize to the parent (`M7b` → `M7`). A module with no category on an axis is reported under `unmapped_findings` rather than silently dropped.

## Search SEO score — category weights (unchanged in v0.2.0)

| Category | Modules | Weight |
|---|---|---|
| Indexability & Crawl | M1, M2, M3 | 22 |
| Core Web Vitals / Performance | M15 | 16 |
| On-Page & Meta | M7 (M7b, M7c) | 12 |
| Structured Data | M5 | 12 |
| Rendering | M4 | 8 |
| Internal Linking & Semantics | M10 | 8 |
| E-E-A-T | M16 | 7 |
| Images / Media | M9 | 5 |
| Sitemaps & Discovery | M17 | 5 |
| Freshness | M13 | 3 |
| Social Cards | M8 | 2 |
| **Conditional** E-commerce | M18 | 15* — `vertical:ecommerce` |
| **Conditional** Local | M19 | 10* — `vertical:local-business` |
| **Conditional** International | M20 | 8* — `flag:multilingual` |

## AI Visibility (GEO/AEO) score — category weights (v0.2.0, always-on = 100)

| Category | Modules | Weight |
|---|---|---|
| Answer Extractability | M11 | 18 |
| AI Crawler Access | M14 | 14 |
| Fact Density / Original Data | M12 | 14 |
| Structured Data | M5 | 12 |
| Rendering (non-JS) | M4 | 10 |
| Entity / Knowledge-Graph | M6 | 9 |
| E-E-A-T / Authority | M16 | 9 |
| Freshness | M13 | 6 |
| Agent-readiness | M22 | 4 |
| Images / Multimodal | M9 | 4 |
| AI discovery & agent endpoints | M21 | 0 (reported, **never moves the score**) |
| **Conditional** Agentic commerce readiness | M18 | 6* — `vertical:ecommerce` |
| **Conditional** Local / place data | M19 | 5* — `vertical:local-business` |

M21 (llms.txt, agents.md, UCP, ARD catalog, agentic sitemap) keeps weight 0: no engine documents that these files affect citation. Its findings still appear in the category list and count toward `unscored_count`. M18/M19 previously had `axis: both` findings with no AI category — they were silently dropped on the AI axis; the conditional rows fix that.

## Conditional categories and activation

Conditional categories enter the denominator only when their condition holds **and** they have at least one scored finding. Weights re-normalize over the active total, so a blog is never penalized for lacking Product schema.

- **Declared** (preferred): `--vertical ecommerce,local-business`, `--multilingual`, or `--vertical-json <seo-vertical-detect output | profile.json>`. In declared mode an undeclared condition is false: findings of an inactive conditional module are listed under `ignored_conditional[]` and never scored. A declared condition with no scored findings produces a warning.
- **Inferred** (legacy, when no flag is given): a conditional category activates when it has ≥ 1 scored finding. The output flags this with `activation.source: "inferred"`, `activation.inferred_categories[]` and a warning.

Every category emits `activation` (`always` | `vertical:ecommerce` | `vertical:local-business` | `flag:multilingual` | `inactive`), `active` (condition met and scored > 0), `active_weight` (its share, in %, of the active total), `modules[]`, `scored`, `needs_api`, `manual_review`.

## Severity calibration

Severity means **how much eligibility or extractability the observed fact removes**, not how important the module is.

| Severity | Meaning | Examples |
|---|---|---|
| 5 | Catastrophic, eligibility-killing at site/template scope | site-wide `noindex`, robots.txt blocks Googlebot, `nosnippet`/`max-snippet:0` site-wide, CSR-only shell, robots.txt 5xx |
| 4 | Major: eligibility or extractability of a page class is materially reduced | page-level `noindex` on a key page, Product without price, robots blocks CSS/JS |
| 3 | Moderate: a documented or strongly correlated signal is missing | no direct answer under a question heading, missing `dateModified`, thin fact density, missing Person schema for the author |
| 2 | Minor | unresolved anaphora openers, missing `x-default`, no `Sitemap:` directive |
| 1 | Cosmetic | optional discovery files, tidy-ups |
| 0 | Informational / unscored | probes (`M14.probe.*`), GSC AI exports (`M14.gsc_ai.*`), `not_applicable` |

Re-assignments applied in v0.2.0: `M11.heading.no_direct_answer` 5→3 · `M11.passage.unresolved_anaphora` 5→2 · `M12.*` 4→3 · `M6.*` 4→3 · `M16.author.missing_person_schema` 4→3 · `M4.render.jsonld_js_injected` 4→3 · `M18.offer.missing_price` 5→4 · `M18.offer.price_feed_mismatch` 5→3 · `M18.facets.uncanonicalized` 5→3 · `M1.sitemap.missing_directive` 5→2 · `M1.robots.blocks_css_js` 5→4 · `M20.hreflang.invalid_bcp47` 4→3 · `M20.hreflang.missing_xdefault` 4→2.

## Bands and the `unscored` state

- Bands (`scripts/lib/bands.mjs`): **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 60, **F** < 60.
- When an axis has **no active category with weight > 0** (no findings, only `needs_api`/`manual_review`, only inactive conditionals or only weight-0 modules) the axis is **`unscored`**: `value: null`, `raw_value: null`, `band: "unscored"`, `state: "unscored"`. An empty findings set is never an F.

## Coverage floor and the `partial` state

A score built from two of thirteen categories is not the same claim as one built from all thirteen, and the axis object has to say so. Each axis therefore reports **coverage**: the share (%) of its **always-on** weight that carried at least one scored finding.

- Denominator: the always-on categories only (they sum to 100 on both axes). A conditional category's weight exists only when its vertical is declared, so including it would make coverage depend on the vertical rather than on how much was measured.
- Numerator: the weight of the always-on categories that ended up `active` (condition met **and** at least one scored finding).
- Keys: `coverage` (%), `coverage_weight` (the measured weight), `coverage_total` (the denominator), `provisional` (boolean).

When `coverage` falls below **`COVERAGE_FLOOR` = 50%**, the axis is **provisional**: `provisional: true`, `state: "partial"` (instead of `scored`), and a warning naming the unmeasured categories. **The numbers never change** — `value`, `raw_value` and `band` stay exactly as computed, because hiding a number is its own dishonesty; the caveat travels next to it instead. `report.md` prints the coverage column, marks the band with `*` and repeats the warning under **Warnings**.

A `capped` axis keeps `state: "capped"` (the cap is the stronger, actionable fact) and still reports `provisional` and the coverage warning. An `unscored` axis is never provisional — there is nothing to qualify.

Typical trigger: `--pages 1 --no-crawl`, a run where only robots and agent-readiness produced findings, or an axis whose remaining categories were all `needs_api`.

## Severity gating (caps)

A finding **caps its axis at 40 (band F)** only when **all** of these hold:

1. `severity: 5` **and** `status: fail`;
2. `expected_impact.confidence: established` — `directional` and `speculative` findings never cap, whatever their severity;
3. its category is **active with weight > 0** on that axis (so M21 at weight 0 and inactive conditionals never cap).

Output: `raw_value` (the weighted value before the cap), `value` (= `min(raw_value, 40)` when capped), `capped: true`, `state: "capped"`, and `cap_reasons[]` with `{id, module, category, severity, status, confidence, scope}` for every gating finding. `capped` reports that the gate applied even when `raw_value` was already ≤ 40.

**Environment suppression.** With `--environment preview|staging|local` (from `profile.json.environment.kind`), caps whose id matches `M2.*noindex*`, `M1.robots.*` or `M14.ai_eligibility.not_indexable` are **not applied**: noindex/robots blocking is expected on a non-production host. They move to `suppressed_caps[]` (with `environment` and `reason`) and a warning is added. Any other sev-5 established fail (e.g. a CSR-only shell) still caps. `production` is the default and never suppresses.

**Probes are never scored.** Web-search presence probes (`M14.probe.*`) and GSC generative-AI imports (`M14.gsc_ai.*`) are severity 0 and live under `report.json.probes`; they cannot move or cap either score.

## Validation

Findings are validated before scoring (`scripts/lib/validate-finding.mjs`, a structural mirror of `schema/finding.schema.json` via `scripts/lib/schema-lite.mjs`). Invalid findings are **dropped**, listed in `dropped_findings[{index, id, errors[]}]` and counted in `dropped_count` (top level and on both axes). `--strict` makes any drop exit 2; `--validate-only` reports validity without scoring. Findings whose module has no category on their axis appear in `unmapped_findings[]`.

## One-line interpretations

High = `value ≥ 75`, low = `value < 60`. Each axis carries **its own** sentence:

| Quadrant | Search | AI |
|---|---|---|
| High Search / Low AI | Ranks well; classic fundamentals are strong. | Hard to cite by AI engines — add extractable structure and verify AI eligibility. |
| Low Search / High AI | Foundational SEO issues to fix first. | Citable by AI, but weak classic ranking limits reach. |
| Both low | Foundational issues — fix indexability and structure first. | Foundational issues — add structure, schema, and answer blocks. |
| Both high | Strong classic SEO; pursue depth and authority. | Strong AI visibility; keep content fresh and original. |
| Mixed (60–75 on either) | Mixed — see the prioritized actions. | Mixed — see the prioritized actions. |
| Unscored axis | Unscored — no scored findings in an active Search category. | Unscored — no scored findings in an active AI category. |

When one axis is unscored, the other is interpreted on its own level (high → "Strong …", low → "Foundational …", else mixed).

The table is the English wording (`INTERPRETATIONS`). `INTERPRETATIONS_ES` is keyed identically, and every warning the scorer emits has both languages in `MESSAGES`; `scoreFindings`/`scoreSite` take an optional `lang` and `report.mjs --lang` passes it through, so a Spanish report carries a Spanish interpretation and Spanish warnings. Finding text stays English — it comes from the checks, not from the scorer.

## Site-level rollup (`scoreSite`, `--manifest crawl.json`)

1. Findings are deduplicated by `id | scope | location.url | location.file | location.resource | location.selector` (worst status, then highest severity wins) so a site-scoped finding emitted by several page runs is **scored once**.
2. Each finding is attached to a page via `location.url` (normalized: lower-case host, no hash, no trailing slash), `location.file`/page `slug`/`snapshot`, or a non-schema `page` hint (url or slug; stripped before validation). `scope: site` findings apply to every page; `scope: template` findings apply to every page of that template; unmatched page findings are treated as site-wide with a warning.
3. Each page is scored with `scoreFindings(site ∪ template ∪ own)` — a site-wide cap therefore caps every page.
4. A sampled page whose `status` is outside 2xx (404, 429, 5xx) is **never scored**: the on-page checks skip a non-content page, so it would collect almost no negative findings and out-score a real page. It stays in `pages[]` with `status`, `scorable: false` and `unscored_reason: "non_2xx_status"`, is listed in `unscored_pages[]`, is named in a warning, carries no weight in the rollup and never appears in `worst_pages`. It also does not consume the "first sample of this template" weight slot. A `status` of `null` (a local file) is scorable.
5. Rollup per axis: `value = Σ w_page × page_value / Σ w_page` over pages with a scored value; unscored if none. `w_page` = `manifest.pages[].weight` when present, else by role: **homepage 3 · target 2 · first sample of each template 2 · other pages (long-tail) 1**. `method: "role_weights"`; `weights` echoes the table. The site is `capped` only when every scored page is capped (i.e. the cap is site-wide); page-only caps are counted in a warning.
6. Output adds `pages[] {url, slug, role, template, status, scorable, weight, weight_source, findings_count, search{value, raw_value, band, state, capped}, ai{…}}`, `pages_scored`, `unscored_pages[] {url, status, role}` and `worst_pages {search[3], ai[3]}`. Category values in the rollup are the page-weighted means; counts come from the deduplicated set.
7. When Search Console impressions are available (Tier 2) a future `method: "gsc_impressions"` weights pages by impressions instead.

## Output shape (per axis)

```
value, band, capped, needs_api_count,                       ← legacy keys
raw_value, state (scored|partial|capped|unscored), cap_reasons[], suppressed_caps[],
manual_review_count, unscored_count, dropped_count, warnings[],
coverage, coverage_weight, coverage_total, provisional,
categories[] { name, weight, value, active, modules[], active_weight, activation, conditional, scored, needs_api, manual_review },
interpretation
```

Top level: `findings_count`, `search_seo`, `ai_visibility`, `dropped_count`, `dropped_findings[]`, `unmapped_findings[]`, `ignored_conditional[]`, `activation {source, vertical{primary, also[], multilingual}, environment, inferred_categories[]}`, `warnings[]` (+ the rollup keys above with `--manifest`). See `docs/en/scoring.md` for the CLI.
