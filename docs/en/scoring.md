# Scoring

`claude-seo-ai` reports **two independent 0–100 scores** and **never blends them into one number**. They share inputs but weight them differently. A page can rank well yet be uncitable by AI, or be highly citable yet rank poorly — surfacing both is the point.

- **Search SEO score** — how well the page is set up to rank in classic search engines.
- **AI Visibility (GEO/AEO) score** — how extractable and citable the page is for AI answer engines.

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

Status factors come straight from the implementation:

| status | factor | counted? |
|---|---|---|
| `pass` | 1.0 | yes |
| `warn` | 0.5 | yes |
| `fail` | 0.0 | yes (in denominator) |
| `needs_api` | — | **excluded** from both numerator and denominator |
| `not_applicable` | — | **excluded** from both numerator and denominator |

A finding only contributes to a score when its `expected_impact.axis` matches that score (`search`, `ai`, or `both`). Shared modules (M4, M5, M9, M13, M16) are scored independently in each score at that score's own weight. Module suffixes are normalized to the parent (e.g. `M7b` → `M7`).

### How `needs_api` is excluded

`needs_api` (and `not_applicable`) findings are dropped before scoring — they **never count as a pass and never penalize**. Each score reports `needs_api_count` so you know how much of the picture required an API you didn't connect. A category whose findings are all `needs_api`/`not_applicable` has no scored findings and is therefore inactive (see re-normalization below).

## Search SEO — category weights

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
| Freshness | M13 | 3 |
| Social Cards | M8 | 2 |
| **Conditional** E-commerce | M18 | 15 |
| **Conditional** Local | M19 | 10 |
| **Conditional** International | M20 | 8 |

## AI Visibility (GEO/AEO) — category weights

| Category | Modules | Weight |
|---|---|---|
| Answer Extractability | M11 | 20 |
| Structured Data | M5 | 16 |
| Fact Density / Original Data | M12 | 14 |
| AI Crawler Access | M14 | 12 |
| Rendering (non-JS) | M4 | 10 |
| Entity / Knowledge-Graph | M6 | 10 |
| E-E-A-T / Authority | M16 | 9 |
| Freshness | M13 | 6 |
| Images / Multimodal | M9 | 3 |
| llms.txt | M21 | 0 (reported, **excluded from score**) |

`llms.txt` has weight `0`: it is checked and reported but, like any zero-weight category, it never moves the score.

## Dynamic re-normalization of conditional verticals

Only categories that are **active** and have **weight > 0** enter the denominator. A category is active when it has at least one scored finding in that axis.

- The conditional verticals — **E-commerce (M18)**, **Local (M19)**, **International (M20)** — only become active when their signals are detected (e.g. Product/Offer schema or cart routes trigger e-commerce).
- When a category is inactive, its weight is removed and the remaining weights re-normalize, so the score is always out of the **active** total. A blog is never penalized for lacking Product schema.

## Letter bands

| Band | Range |
|---|---|
| A | ≥ 90 |
| B | ≥ 80 |
| C | ≥ 70 |
| D | ≥ 60 |
| F | < 60 |

## Severity gating (sev-5 fail caps at F)

Any finding in the axis with `severity: 5` **and** `status: fail` (e.g. site-wide `noindex`, `robots.txt` blocking all crawlers, canonical+noindex on key pages) caps that score at **40 (band F)** regardless of other passes, and sets `capped: true`. This keeps a technically broken site from showing green. The cap only lowers a score — if the weighted value is already ≤ 40, nothing changes.

## Search-vs-AI quadrant interpretations

Each score carries a one-line `interpretation`. The implementation classifies a score as **high** when `value ≥ 75` and **low** when `value < 60`; the quadrant is read from the pair. The exact strings (Search, then AI):

| Quadrant | Search interpretation | AI interpretation |
|---|---|---|
| High Search / Low AI | Ranks well, hard to cite by AI engines. | Weak classic ranking despite content. |
| Low Search / High AI | Foundational SEO issues to fix first. | Citable by AI, but weak classic ranking. |
| Low Search / Low AI | Foundational issues — fix indexability and structure first. | Foundational issues — add structure, schema, and answer blocks. |
| High Search / High AI | Strong classic SEO; pursue depth and authority. | Strong AI visibility; keep content fresh and original. |
| Any other (mixed) | Mixed — see the prioritized actions. | Mixed — see the prioritized actions. |

> Note: scores between 60 and 75 fall outside both the high and low thresholds, so a pair that isn't squarely in one quadrant yields the **mixed** interpretation.

## Output shape

Running the scorer emits both scores side by side:

```json
{
  "findings_count": 0,
  "search_seo": {
    "value": 0,
    "band": "F",
    "capped": false,
    "needs_api_count": 0,
    "categories": [ { "name": "...", "weight": 22, "value": 0, "active": false } ],
    "interpretation": "..."
  },
  "ai_visibility": { "value": 0, "band": "F", "capped": false, "needs_api_count": 0, "categories": [], "interpretation": "..." }
}
```

Run it with:

```bash
node scripts/score.mjs --findings findings.json
# or
cat findings.json | node scripts/score.mjs
```

Input is a JSON array of findings, or `{ "findings": [...] }`, each conforming to `schema/finding.schema.json`. The scorer is pure logic and fully reproducible.
