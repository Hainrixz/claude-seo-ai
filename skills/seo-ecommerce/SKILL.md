---
name: seo-ecommerce
description: Conditionally audit and generate e-commerce structured data for product pages — validate Product/Offer (price, priceCurrency, availability), AggregateRating/Review, faceted-navigation canonicalization, and variant/ProductGroup handling, cross-checking page-to-schema-to-Merchant-feed consistency, and produce ready-to-inject Product JSON-LD. Module M18. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-ecommerce (M18)

Conditional commerce module: it only runs when commerce signals are detected, then audits and completes product structured data. Reference: `references/schema-tier1.md` (Product + Offer, Review/AggregateRating rows).

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Commerce gate**: detect commerce signals (price/currency text, add-to-cart/buy controls, `Product`/`Offer` schema, `og:type=product`). If none, every M18 finding is `not_applicable` (severity 0) — do not force product schema onto non-commerce pages.
2. **Product + Offer**: `Product` has `name`, `image`; `Offer` has `price`, `priceCurrency`, `availability` (`schema.org/InStock` etc.). Per `references/schema-tier1.md`.
3. **AggregateRating / Review**: if ratings are visibly shown, expect `AggregateRating` (`ratingValue`, `reviewCount`/`bestRating`) and/or `Review` (`author`). Never mark up ratings not visible on the page.
4. **Page → schema → feed consistency (Tier 2)**: schema `price`/`priceCurrency`/`availability` must match visible on-page values and the Merchant Center feed. Mismatches risk disapproval and lost rich results.
5. **Faceted navigation**: filter/sort URLs (`?color=`, `?sort=`) should canonicalize to the clean product/category URL or be `noindex`, to avoid index bloat and duplicate-content dilution.
6. **Variants / ProductGroup**: multi-variant products should use `ProductGroup` with `hasVariant` and `variesBy`, not duplicate standalone `Product` blocks per SKU.

## Fixes
- **AUTO** (`fixable: auto`): generate complete, valid `Product`/`Offer`/`AggregateRating` JSON-LD inferred from the DOM (name, image, price, currency, availability, visible rating) inside a single `@graph` with a stable `@id`. The block is a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): canonical/`noindex` tags for faceted URLs and `ProductGroup` restructuring — drafts requiring per-item accept.
- **ADVISORY** (`fixable: advisory`): price / availability mismatches between page, schema, and feed — the store backend/feed is the source of truth, so the tool never writes these. **Never invent** prices, currencies, availability, or ratings — ask the user or leave a clearly-marked TODO placeholder.

## Verification
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/validate-jsonld.mjs --url <u>` (`schema_validator`) — JSON validity + required Product/Offer properties.
- Tier 1: Google Rich Results Test / schema.org validator (`rich_results_api`) for merchant-listing eligibility.
- Tier 2: Merchant Center feed diff — compare schema vs feed `price`/`availability`. When the required data tier (feed/API) is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Severity 5 on ecommerce pages, 0 (`not_applicable`) otherwise; axis `both`. Examples:
- `M18.offer.missing_price` — Product without `Offer.price`/`priceCurrency` (status `fail`, severity 5, `fixable: auto`, axis `both`, confidence `established`).
- `M18.offer.price_feed_mismatch` — schema price differs from on-page/feed price (status `warn`, severity 5, `fixable: advisory`, axis `both`, confidence `directional`; needs feed → may be `needs_api`).
- `M18.facets.uncanonicalized` — indexable faceted URLs lack canonical/`noindex` (status `warn`, severity 5, `fixable: proposed`, axis `both`, confidence `directional`).
Each finding: `evidence.observed` quotes the page (e.g. the rendered price text or the offending `?filter=` URL); `verification.reproduce` is a runnable command; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- AggregateRating/Review markup does **not** guarantee star rich results — Google shows them at its discretion and gates them by policy; don't promise stars from markup alone.
- Faceted-URL hygiene reduces crawl/index waste but is not a direct ranking factor — frame as `directional`, not a guaranteed gain.
- Keep schema strictly consistent with visible content and the product feed; fabricated or feed-mismatched values invite Merchant disapproval, not a win.
