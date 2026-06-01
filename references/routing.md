# Vertical detection & module routing

`seo-vertical-detect` classifies the target, then the orchestrator runs the always-on modules plus the conditional ones the vertical unlocks, and reweights the scores.

## Verticals & signals

| Vertical | Detection signals |
|---|---|
| `ecommerce` | `Product`/`Offer` schema, cart/checkout routes, price elements, add-to-cart, `og:type=product` |
| `local-business` | `LocalBusiness` schema, NAP (name/address/phone), maps embed, opening hours, store-locator |
| `blog-publisher` | `Article`/`BlogPosting` schema, bylines/author pages, RSS/Atom feed, post archives, dates |
| `saas` | pricing/signup/login routes, `SoftwareApplication`, feature/integration pages, docs subdomain |
| `docs` | docs/reference routes, sidebar nav, version selectors, code blocks, llms.txt presence |
| `generic` | none of the above clearly dominates |

A site can match several (e.g. SaaS + docs + blog). Run the union of unlocked modules; let conditional scoring re-normalize.

## Always-on modules (every audit)

M1 crawlability · M2/M3 indexability · M4 rendering · M5 schema · M6 entities · M7 meta+headings · M8 social · M9 images · M10 internal linking · M11 answer blocks · M12 fact density · M13 freshness · M14 AI crawlers · M15 CWV · M16 E-E-A-T · M17 sitemaps · M21 llms.txt.

## Conditional modules (unlocked by vertical)

| Vertical | Adds | Emphasis shift |
|---|---|---|
| `ecommerce` | M18 (Product/Offer/Review, faceted nav, feed↔page consistency) | Schema + CWV weigh more |
| `local-business` | M19 (LocalBusiness, NAP, hours, geo) | Entities + LocalBusiness schema |
| `blog-publisher` | — | E-E-A-T (M16), freshness (M13), answer blocks (M11) weigh more |
| multilingual (any vertical with >1 locale or `hreflang`) | M20 (hreflang reciprocity, x-default, BCP-47) | — |
| `docs` | — | Answer blocks (M11), llms.txt (M21 reported), internal linking (M10) |

## Subagent dispatch (parallel)

- `technical-auditor` → M1, M2 (+M3), M4, M7, M7b (mobile), M7c (headings), M8, M9, M10, M15, M17
- `ai-search-geo-specialist` → M6, M11, M12, M14, M21
- `content-eeat-analyst` → M13, M16
- `schema-generator` → M5 (+ M18/M19 schema when conditional active)

Each returns findings conforming to `schema/finding.schema.json`; the orchestrator merges, dedupes by `id`, runs `seo-score`, and renders the report.
