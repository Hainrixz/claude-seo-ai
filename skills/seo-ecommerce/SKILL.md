---
name: seo-ecommerce
description: Conditionally audit and generate e-commerce structured data and agentic-commerce readiness for product pages — validate Product/Offer (price, priceCurrency, availability), AggregateRating/Review, faceted-navigation canonicalization and variant/ProductGroup handling, cross-check page-to-schema-to-feed consistency, and assess whether shopping agents can read the store (UCP merchant profile, catalog eligibility, ACP feed hygiene). Module M18. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-ecommerce (M18)

Conditional commerce module: it runs only when commerce signals are detected, then audits (a) product structured data for Search and (b) whether an AI shopping agent can actually read and act on the store. Reference: `references/schema-tier1.md` (Product + Offer, Review/AggregateRating rows). Platform-specific ids — Shopify's Catalog and UCP defaults among them — live in `references/platforms/shopify.md` and are emitted by the platform-conditional checks, not from here.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`jsonld[]`, `metas[]`, `text_sample`) and `vertical` from the envelope — the commerce gate is decided there; `<run_dir>/site/discovery.json` carries the probes for `/.well-known/ucp` and `/api/ucp/mcp` (status, content-type, body); `<run_dir>/profile.json` names the platform. Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Commerce gate**: detect commerce signals (price/currency text, add-to-cart/buy controls, `Product`/`Offer` schema, `og:type=product`). If none, every M18 finding is `not_applicable` (severity 0) — do not force product schema onto non-commerce pages.
2. **Product + Offer**: `Product` has `name`, `image`; `Offer` has `price`, `priceCurrency`, `availability` (`schema.org/InStock` etc.). Per `references/schema-tier1.md`.
3. **AggregateRating / Review**: if ratings are visibly shown, expect `AggregateRating` (`ratingValue`, `reviewCount`/`bestRating`) and/or `Review` (`author`). Never mark up ratings that are not visible on the page.
4. **Page → schema → feed consistency**: schema `price`/`priceCurrency`/`availability` must match the visible on-page values and the merchant feed. Mismatches risk disapproval and lost rich results.
5. **Faceted navigation**: filter/sort URLs (`?color=`, `?sort=`) should canonicalize to the clean product/category URL or be `noindex`, to avoid index bloat and duplicate-content dilution.
6. **Variants / ProductGroup**: multi-variant products should use `ProductGroup` with `hasVariant` and `variesBy`, not duplicate standalone `Product` blocks per SKU.

### Agentic commerce readiness (ecommerce only)
Shopping agents do not read a product page the way a shopper does: they look for a machine-readable merchant profile, a catalog they are allowed to enumerate, and a feed whose fields parse. These checks run **only** when the ecommerce vertical is active, and they populate the conditional **AI** category for M18 (weight 6) alongside the Search category.

7. **UCP merchant profile** — `/.well-known/ucp` must be publicly reachable (200, no auth), valid JSON, with `ucp.version` as `YYYY-MM-DD` and `services`/`capabilities` as objects keyed by reverse-DNS names mapping to arrays of `{version, spec, transport?, endpoint?, schema}`. When the store is not an ecommerce vertical this file is M21's (`seo-ai-discovery`); on a store, M18 owns it.
8. **Catalog eligibility** — for each sampled product, check the properties a catalog needs to list it at all: a title, at least one image, a price greater than zero, a stable identifiable product URL, and a product that is not hidden/unavailable in the storefront. Report per-product results, not a single verdict.
9. **Agentic-checkout feed (ACP)** — when the user supplies a feed with `--feed <path>`, lint it: the required fields, a price written as an amount plus a currency code (`"79.99 USD"`), an availability value from the allowed enum, GTINs that pass the mod-10 check, absolute URLs, and no duplicate `item_id`. With no feed supplied the finding is `needs_api` — never a pass.
10. **Feed ↔ page price** — where a feed is available, compare its price and availability against the rendered page and the schema. Three sources, one truth.
11. **Merchant Center / platform hints** — a verified merchant feed is how Google receives authoritative product data; note whether one is plausibly present (structured data alone is not a feed) and whether the platform declares a catalog integration.

## Fixes
- **AUTO** (`fixable: auto`): generate complete, valid `Product`/`Offer`/`AggregateRating` JSON-LD inferred from the DOM (name, image, price, currency, availability, visible rating) inside a single `@graph` with a stable `@id`. The block is a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): canonical/`noindex` tags for faceted URLs, `ProductGroup` restructuring, and feed-field corrections — drafts requiring per-item accept.
- **ADVISORY** (`fixable: advisory`): price/availability mismatches between page, schema, and feed; UCP profile publication; catalog enrolment. The store backend, the feed, and the platform are the sources of truth, so the tool never writes these. **Never invent** prices, currencies, availability, ratings, GTINs, or endpoints — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- Offline: `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-jsonld.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) (`schema_validator`) — JSON validity + required Product/Offer properties.
- Feed lint: `node "${CLAUDE_PLUGIN_ROOT}/scripts/acp-feed-lint.mjs" --feed <path>` (JSONL, CSV, or TSV) — required fields, price format, availability enum, GTIN mod-10, absolute URLs, duplicate `item_id` (`schema_validator`).
- UCP/catalog probes: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-discovery.mjs" --snapshot <pages/<slug>.json>` re-reads `site/discovery.json` and validates the profile shape (`schema_validator`).
- Tier 1: Google Rich Results Test / schema.org validator (`rich_results_api`) for merchant-listing eligibility.
- When the required tier (feed, API, merchant account) is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. On a non-commerce page every id is `not_applicable` at severity 0. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).

**Product data** — axis `both`:
- `M18.offer.missing_price` — Product without `Offer.price`/`priceCurrency` (`fail`, severity **4**, `fixable: auto`, confidence `established`).
- `M18.offer.price_feed_mismatch` — schema price differs from the on-page or feed price (`warn`, severity **3**, `fixable: advisory`, confidence `directional`; `needs_api` when no feed is supplied).
- `M18.facets.uncanonicalized` — indexable faceted URLs with no canonical and no `noindex` (`warn`, severity **3**, `fixable: proposed`, confidence `directional`).
- `M18.variants.no_productgroup` — per-SKU duplicate `Product` blocks instead of `ProductGroup` + `hasVariant` (`warn`, severity 3, `fixable: proposed`, confidence `directional`). Counts declarations only: a page that already models variants with `hasVariant` never fires it, however many variants it lists.
- Catalog eligibility judges the ProductGroup itself, and prices it from the variants' offers when the group carries none of its own — a group whose variants each carry a price is not "missing a price".

**Agentic commerce readiness** — ecommerce only:
- `M18.agentic.ucp_profile_missing` — no `/.well-known/ucp` on a store (`warn`, severity 3, axis `ai`, `fixable: advisory`, confidence `directional`).
- `M18.agentic.ucp_profile_invalid` — the profile exists but the version, `services`, or `capabilities` shape does not parse (`warn`, severity 3, axis `ai`, `fixable: advisory`, confidence `directional`).
- `M18.agentic.ucp_not_public` — the profile is behind auth, a redirect to login, or a non-JSON content type, so no agent can read it (`fail`, severity 3, axis `ai`, `fixable: advisory`, confidence `directional`).
- `M18.agentic.catalog_eligibility` — per-product catalog check: `pass` when title, image, price > 0, identifiable URL and visible storefront status all hold; `warn` when one is missing; `fail` when the product could not be listed at all (severity 3, axis `both`, `fixable: proposed`, confidence `directional`).
- `M18.agentic.acp_feed_errors` — feed lint failures, one row per error class with the offending line (`fail`, severity 3, axis `both`, `fixable: proposed`, confidence `directional`; **`needs_api`** whenever `--feed` was not supplied).
- `M18.agentic.feed_page_price_mismatch` — the feed price or availability disagrees with the rendered page (`warn`, severity 3, axis `both`, `fixable: advisory`, confidence `directional`).
- `M18.agentic.merchant_center_hint` — a verified merchant feed is the documented path for authoritative product data reaching Google's shopping and AI surfaces (`pass`, severity 1, axis `both`, `fixable: advisory`, confidence `established`; informational — we cannot see the merchant account).
- `M18.agentic.shopify_catalog_declared` — the platform declares a catalog integration in its UCP profile (`pass`, severity 1, axis `ai`, confidence `directional` — a platform default, not merchant merit).

Each finding: `evidence.observed` quotes the page, the profile, or the feed line verbatim (e.g. the rendered price text, the offending `?filter=` URL, `item_id` and column); `verification.reproduce` is a runnable command; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- AggregateRating/Review markup does **not** guarantee star rich results — Google shows them at its discretion and gates them by policy; never promise stars from markup alone.
- Faceted-URL hygiene reduces crawl and index waste but is not a direct ranking factor — `directional`, not a guaranteed gain.
- **Agentic commerce is early and unevenly documented.** UCP, catalog enrolment rules, and agentic checkout are vendor programmes that change fast, and no vendor publishes a "readiness score". Every `M18.agentic.*` finding is `directional` — the only `established` claim in the set is that a merchant feed is the documented channel for authoritative product data.
- On Shopify, `/.well-known/ucp`, `agents.md`, and the agentic discovery files ship **by default**. Their presence on a Shopify store is a platform default, not evidence the merchant did anything; their absence on a non-Shopify store is a gap, not a failure.
- A feed lint failure is a fact about the file, not about the store's ranking. Report the row, the field, and the rule; do not extrapolate a revenue or visibility number.
- Keep schema strictly consistent with the visible page and the feed. Fabricated or feed-mismatched values invite merchant disapproval, not a win — and never invent a GTIN.
