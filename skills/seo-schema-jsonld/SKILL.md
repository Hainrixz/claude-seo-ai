---
name: seo-schema-jsonld
description: Audit and generate structured data (JSON-LD) for a page — detect, validate, and complete Tier-1 schema.org types (Article, Organization, Person, Product/Offer, BreadcrumbList, LocalBusiness, Review, VideoObject, Event), flag microdata/RDFa and deprecated-for-rich-results types (FAQPage/HowTo), and produce ready-to-inject JSON-LD blocks. Module M5. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-schema-jsonld (M5)

Structured data is the single highest-leverage signal for both classic rich results and AI citation. Reference: `references/schema-tier1.md`. Templates: `schema/jsonld-templates/`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
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
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/validate-jsonld.mjs --url <u>` — checks JSON validity + required properties against the templates.
- Tier 1: confirm eligibility with Google Rich Results Test / schema.org validator. When unavailable, status is `needs_api`, not `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M5.article.missing` — no Article schema on an editorial page (severity 4, fail, `fixable: auto`, axis `both`, confidence `established`).
- `M5.product.missing_offer_price` — Product without `Offer.price` on a product page (status `fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`).
- `M5.faqpage.deprecated_richresult` — FAQPage present (status `warn`, severity 1, `fixable: advisory`, axis `ai`, confidence `established`; rationale cites Google FAQ rich-result removal; **not** counted as a win).
Each finding: `evidence.observed` quotes what's on the page; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- FAQPage/HowTo: parseable by AI, **no Google rich results** — keep if present, don't add expecting SERP features.
- Don't mark up content not visible on the page; keep schema consistent with any product feed.
