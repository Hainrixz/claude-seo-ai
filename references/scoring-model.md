# Scoring model — two scores, never blended

`claude-seo-ai` reports **two independent 0–100 scores**. They share inputs but weight them differently and must never be averaged into one number. A page can rank well yet be uncitable by AI, or vice-versa — surfacing both is the product thesis.

Each score = `Σ(category_value × weight) / Σ(active weight)` where `category_value` ∈ [0,100] is the severity-weighted pass rate of that category's findings.

## Category value (per category)

For the findings in a category, convert status → points and weight by severity:

```
points(finding) = status_factor × severity
  status_factor: pass = 1.0, warn = 0.5, fail = 0.0, not_applicable/needs_api = excluded
category_value = 100 × Σ points(passed/warned) / Σ (severity over scored findings)
```

`needs_api` and `not_applicable` are **excluded from both numerator and denominator** — they never count as a pass and never penalize. The report lists how many findings were `needs_api` so the user knows the score's confidence.

## Search SEO score — category weights

| Category | Modules | Weight |
|---|---|---|
| Indexability & Crawl | M1, M2, M3 | 22 |
| Core Web Vitals / Performance | M15 | 16 |
| On-Page & Meta | M7 | 12 |
| Structured Data | M5 | 12 |
| Rendering | M4 | 8 |
| Internal Linking & Semantics | M10 | 8 |
| E-E-A-T | M16 | 7 |
| Images / Media | M9 | 5 |
| Sitemaps & Discovery | M17 | 5 |
| Social Cards | M8 | 2 |
| Freshness | M13 | 3 |
| **Conditional** E-commerce | M18 | 15* |
| **Conditional** Local | M19 | 10* |
| **Conditional** International | M20 | 8* |

## AI Visibility (GEO/AEO) score — category weights

| Category | Modules | Weight |
|---|---|---|
| Answer Extractability & Passage Structure | M11 | 20 |
| Structured Data | M5 | 16 |
| Fact Density / Original Data / Citations | M12 | 14 |
| AI Crawler Access & Citability | M14 | 12 |
| Rendering (non-JS extractability) | M4 | 10 |
| Entity / Knowledge-Graph | M6 | 10 |
| E-E-A-T / Authority | M16 | 9 |
| Freshness | M13 | 6 |
| Images / Multimodal | M9 | 3 |
| llms.txt | M21 | 0 (reported, **excluded from score**) |

## Dynamic re-normalization (conditional modules)

Conditional categories (E-commerce, Local, International) enter the denominator **only when their signals are detected** (e.g. Product/Offer schema or cart routes → e-commerce). When inactive, their weight is removed and remaining weights re-normalize so the score is always out of the active total. A blog is never penalized for lacking Product schema.

## Bands & severity gating

- Bands: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 60, **F** < 60.
- **Severity gating:** any `severity: 5` finding with `status: fail` (e.g. site-wide `noindex`, `robots.txt` blocking all crawlers, canonical+noindex on key pages) **caps the affected score at ≤ 40 (band F)** regardless of other passes, and sets `capped: true`. This prevents a technically-broken site from showing green.
- A finding contributes only to the score(s) named in its `expected_impact.axis`. Shared modules (M4, M5, M9, M13, M16) are scored independently in each score at that score's weight.

## Site-level rollup

- Per-page scores roll up to a site score weighted by importance: homepage and detected templates (e.g. the blog-post template, the product template) weigh more than long-tail pages.
- When Search Console (Tier 2) is available, weight pages by impressions instead.
- Always show both the worst-offending pages and the site aggregate.

## One-line interpretations (examples)

- High Search / low AI → "Ranks well, hard to cite by AI engines."
- Low Search / high AI → "Citable by AI, but weak classic ranking."
- Both low → "Foundational issues — fix indexability and structure first."
- Both high → "Strong on both surfaces; pursue content depth and authority."
