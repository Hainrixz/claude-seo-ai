---
name: seo-schema-jsonld
description: Audit and generate structured data (JSON-LD) for a page — detect, validate, and complete Tier-1 schema.org types (Article, Organization, Person, Product/Offer, BreadcrumbList, LocalBusiness, Review, VideoObject, Event), flag microdata/RDFa and deprecated-for-rich-results types (FAQPage/HowTo), and produce ready-to-inject JSON-LD blocks. Module M5. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-schema-jsonld (M5)

Structured data is the single highest-leverage signal for both classic rich results and AI citation. Reference: `references/schema-tier1.md`. Templates: `schema/jsonld-templates/`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`jsonld[]`, `microdata_items`, `headings[]`, `images[]`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Detect** every `<script type="application/ld+json">` block; parse JSON; note any inline microdata/RDFa (flag for migration to JSON-LD).
2. **Validate** each block: valid JSON, recognized `@type`, required + recommended properties present per `references/schema-tier1.md`.
3. **Completeness** vs the page's content & vertical: e.g. an article page should have `Article`/`BlogPosting` with `author` (Person), `datePublished`, `dateModified`, `image`, `publisher`; a product page `Product` + `Offer` (`price`, `priceCurrency`, `availability`).
4. **Entity hygiene**: stable `@id`, `@graph` linkage, `sameAs` (defer the sameAs audit detail to M6/seo-entity-linking).
5. **Date agreement**: schema `datePublished`/`dateModified` should match visible dates (cross-check with M13).
6. **Deprecation honesty**: if `FAQPage`/`HowTo` present, do NOT report them as a rich-result win — label deprecated-for-SERP (still parseable by AI).

## Fixes (fixable: auto)
Generate complete, valid JSON-LD blocks **inferred from page content** for any missing/incomplete Tier-1 type:
- `Article`/`BlogPosting` from `<article>`, `<h1>`, byline, dates, hero image.
- `Organization`/`WebSite` from footer/contact/logo.
- `Product`+`Offer` from product DOM (name, image, price, currency, availability).
- `BreadcrumbList` from nav breadcrumb.
- `Person` (author) with credential fields **the user supplies**.
Use a single `@graph` with stable `@id`s. Inject missing `dateModified`/`@id`. The block is a diff for `fix` (AUTO). **Never invent** prices, dates, ratings, or `sameAs` identity links — ask or leave a clearly-marked TODO placeholder the user fills.

## Verification
- Offline: `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-jsonld.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) — checks JSON validity + required properties against the templates.
- Tier 1: confirm eligibility with Google Rich Results Test / schema.org validator. When unavailable, status is `needs_api`, not `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Examples:
- `M5.article.missing` — no Article schema on an editorial page (`fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`).
- `M5.product.missing_offer_price` — Product without `Offer.price` on a product page (`fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`). Only nodes that DECLARE a product here count (`lib/jsonld.mjs` `classifyProductNodes`): a `hasVariant` member belongs to its ProductGroup, a review's `itemReviewed` and an `isSimilarTo`/`isRelatedTo` node point at an item declared elsewhere, and a nested url/name-only node is a pointer — none of them is markup this page is missing.
- `M5.jsonld.invalid_json` — a `ld+json` block that does not parse, so every type inside it is invisible (`fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`).
- `M5.jsonld.contradicts_page` — marked-up values (price, rating, date, author) disagree with what the page displays (`fail`, severity 4, `fixable: proposed`, axis `both`, confidence `established`).
- `M5.faqpage.deprecated_richresult` — FAQPage present (`warn`, severity 1, `fixable: advisory`, axis `ai`, confidence `established`; rationale cites Google's FAQ rich-result removal; **not** counted as a win).
**Platform-conditional ids.** This module also emits 4 ids that fire only when `profile.json` names the platform (`shopify`, `wordpress`). They are indexed in `references/routing.md` § Platform-conditional finding ids and specified in `references/platforms/<id>.md` §10.

Each finding: `evidence.observed` quotes what's on the page; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **Google documents no special schema.org type, property, or "AI schema" for its AI features.** Eligibility for AI Overviews / AI Mode comes from being indexed and snippet-eligible (M14), not from markup. What *is* documented, and therefore `established`, is that structured data must be **valid** and **consistent with the visible page** to be used at all — for rich results and for the merchant/business data Google ingests. Frame schema work as "make the page machine-readable and honest", not "unlock AI citations".
- FAQPage/HowTo: still parseable, **no Google rich results** — keep them if present, do not add them expecting SERP features.
- Don't mark up content that is not visible on the page, and keep schema consistent with any product feed; invented or mismatched values invite manual actions and disapprovals, not wins.
- A valid block is a floor, not a ranking lever: report the presence of correct schema as eligibility, never as a predicted position change.
