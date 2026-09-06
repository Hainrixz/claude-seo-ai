# Structured data — Tier-1 types & rules (2026)

Use **JSON-LD** (Google's preferred format). Flag inline microdata/RDFa for migration. One `<script type="application/ld+json">` per logical entity, or a single `@graph` linking them with stable `@id`s.

## Tier-1 types (highest leverage for Search + AI)

| Type | When | Key required/recommended props |
|---|---|---|
| `Organization` | Every site (home/about) | `name`, `url`, `logo`, `sameAs[]`, `contactPoint` |
| `WebSite` | Home | `name`, `url`, optional `potentialAction` (SearchAction) |
| `Article` / `NewsArticle` / `BlogPosting` | Editorial pages | `headline`, `author` (Person), `datePublished`, `dateModified`, `image`, `publisher` |
| `Person` | Authors / profiles | `name`, `jobTitle`, `sameAs[]` (LinkedIn/Wikidata), `knowsAbout` |
| `BreadcrumbList` | Any nested page | ordered `itemListElement` with `position`, `name`, `item` |
| `Product` + `Offer` | E-commerce/SaaS | `name`, `image`; Offer: `price`, `priceCurrency`, `availability` |
| `Review` / `AggregateRating` | Products/services with reviews | `ratingValue`, `reviewCount`/`bestRating`, `author` |
| `LocalBusiness` (+ subtypes) | Physical locations | `name`, `address` (PostalAddress), `telephone`, `openingHoursSpecification`, `geo` |
| `VideoObject` | Embedded video | `name`, `description`, `thumbnailUrl`, `uploadDate`, `duration` |
| `Event` | Events | `name`, `startDate`, `location`, `offers` |
| `SoftwareApplication` | SaaS / apps / plugins | `name`, `applicationCategory`, `operatingSystem`, `offers` (price, `priceCurrency`), optional `aggregateRating` |

## Best-practice rules

- **Stable `@id`** per entity (e.g. `https://site.com/#org`, `.../article-slug#article`) — never timestamp-based. Lets AI systems and your own `@graph` reference the same entity reliably.
- **`sameAs`** links the entity to its canonical identities (Wikidata QID, Wikipedia, LinkedIn, Crunchbase, official socials). Wikidata is the strongest target for the Google Knowledge Graph. Only ever use URLs the user confirms — never invent identity links.
- **Dates**: include both `datePublished` and `dateModified` (ISO 8601). They must agree with visible on-page dates. Never backdate.
- **Author**: prefer a `Person` object with credentials over a bare string — feeds E-E-A-T.
- Match structured data to visible page content (don't mark up data the user can't see) and keep it consistent with any product feed.

## Deprecated-for-Google-rich-results (honesty)

- **FAQPage** and **HowTo** no longer produce Google rich results. They remain valid schema.org types that Google parses and AI engines may extract. Guidance: *keep if already present (harmless, possibly useful for AI extraction), but do NOT add them expecting SERP rich results, and never count them as a rich-result win.*
- Don't recommend `SpecialAnnouncement`/`ClaimReview` rich results (no general support).

## Validation

- Offline: `schema/jsonld-templates/` holds one JSON-LD template per Tier-1 type above (including `SoftwareApplication`), with stable `@id` patterns and `TODO:<field>` placeholders. They are the SPEC behind `scripts/validate-jsonld.mjs` (required vs recommended properties, nested `Offer`/`AggregateRating`/`Person` walked, not just `@graph` roots) and the source the fixer's AUTO JSON-LD generation fills from page content. `SoftwareApplication` is in both the templates and the script's SPEC, so it validates like every other Tier-1 type.
- Run it as `node "<plugin_root>/scripts/validate-jsonld.mjs" --snapshot "<run_dir>/pages/<slug>.json"` (add `--prefer rendered` for a client-injected graph, `--type <Type>` to focus one type) — the same absolute command every M5 finding carries in `verification.reproduce`. It also accepts `--url <u>` and `--file <path>`; there is no site-wide mode.
- Tier 1: confirm eligibility with Google Rich Results Test / schema.org validator.
- Report `needs_api` (not a pass) when a live validator is unavailable. Google states no special structured data is required for its AI features — schema helps eligibility and consistency, so label AI-axis impact `directional`.
