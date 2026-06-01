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

- Offline: validate required-property completeness against the templates in `schema/jsonld-templates/`.
- Tier 1: confirm eligibility with Google Rich Results Test / schema.org validator.
- Report `needs_api` (not a pass) when a live validator is unavailable.
