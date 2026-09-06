# JSON-LD templates (Tier-1 types)

One template per Tier-1 type from [`references/schema-tier1.md`](../../references/schema-tier1.md). Two consumers:

1. **`scripts/validate-jsonld.mjs` SPEC** — the required/recommended property sets it checks per `@type` are the keys these templates carry (required = the keys a page cannot omit; recommended = the rest). Keep the two in sync: adding a property here means adding it to the script's SPEC in the same change. `SoftwareApplication` is templated here; its SPEC entry lands with the script pass (TO-VERIFY before claiming it validates).
2. **The fixer's AUTO JSON-LD generation** (`seo-schema-jsonld` → `schema-generator` proposal → `seo-fixer-writer` apply). A proposal is a template filled from page content; every value the page does not state stays a `TODO:<field>` placeholder for the user to fill. Placeholders are never invented, never written as real values, and preserved verbatim by the writer.

| File | `@type` | `@id` pattern |
|---|---|---|
| `organization.json` | Organization | `<site_url>/#organization` |
| `website.json` | WebSite | `<site_url>/#website` |
| `article.json` / `blogposting.json` / `newsarticle.json` | Article / BlogPosting / NewsArticle | `<page_url>#article` (`#blogposting`, `#newsarticle`) |
| `person.json` | Person | `<site_url>/author/<slug>#person` |
| `breadcrumblist.json` | BreadcrumbList | `<page_url>#breadcrumb` |
| `product-offer.json` | Product + Offer | `<page_url>#product`, `<page_url>#offer` |
| `review-aggregaterating.json` | Review + AggregateRating (as a `@graph` that attaches to `#product` by `@id`) | `<page_url>#review-<slug>` |
| `localbusiness.json` | LocalBusiness (or subtype) | `<site_url>/#localbusiness` |
| `videoobject.json` | VideoObject | `<page_url>#video` |
| `event.json` | Event | `<page_url>#event` |
| `softwareapplication.json` | SoftwareApplication | `<page_url>#software` |

## Conventions

- **Placeholders** are strings of the form `TODO:<field>` (sometimes with a hint, e.g. `TODO:date_modified_iso8601_never_backdated`). Fill or delete them; a block shipped with a `TODO:` inside is a `fail`, not a `pass`. Fields that must be numbers in the final block (`price`, `ratingValue`, `position`, `width`) are placeholders here and become numbers (or numeric strings, which schema.org accepts for `price`) when filled.
- **Stable `@id`s**: `<site_url>/#organization` and `<site_url>/#website` are site-wide; page entities hang off the canonical `<page_url>` with a fragment. Never timestamp-based. Templates reference each other by `@id` (`publisher`, `author`, `isPartOf`, `seller`) so the final block is a single `@graph` with no duplicated entities.
- **Truth constraints**: `headline`/`name`/`price` must match what is visible on the page; `datePublished`/`dateModified` must match visible dates (never backdate); `sameAs` only with URLs the user confirms; ratings only from real reviews. Remove `aggregateRating` rather than fill it with an estimate.
- **Validator coupling (TO-VERIFY in the script pass)**: `validate-jsonld.mjs` looks up SPEC by `@type`. `localbusiness.json` ships `@type: "TODO:LocalBusiness_or_subtype"` (the subtype is the user's choice) and the second `@graph` node of `review-aggregaterating.json` is an `@id`-only attach node with no `@type` (it merges into the page's `#product`), so neither matches a SPEC entry until filled/merged. The fixer's AUTO path must never treat an unfilled LocalBusiness template — or a Review graph whose `#product` target is absent — as a validated block: `TODO:` present ⇒ `fail`, and the validator should report an unknown/missing `@type` rather than silently skip the node.
- **Deprecated for Google rich results** (`FAQPage`, `HowTo`) have no template on purpose — see `references/schema-tier1.md`.
- **Platform ownership**: on WordPress with an SEO plugin or Shopify Dawn themes the platform already emits a graph; the fixer proposes plugin-field / theme-snippet edits instead of injecting a second graph (see `references/platforms/<id>.md`, Phase 3).
