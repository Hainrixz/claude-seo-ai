---
name: seo-local
description: Audit and generate Local SEO signals for local-business pages — verify LocalBusiness JSON-LD, NAP consistency, geo coordinates, openingHoursSpecification, and service-area, advise on Google Business Profile alignment, and produce ready-to-inject LocalBusiness JSON-LD. Module M19 (conditional). Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-local (M19)

Local pages live and die on consistent, machine-readable place data. **Conditional module**: only runs when the page is classified local-business (storefront, service-area, multi-location, contact/location page). Reference: `references/schema-tier1.md` (LocalBusiness row).

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`), only for local-business pages:
1. **LocalBusiness schema**: a `LocalBusiness` (or correct subtype, e.g. `Restaurant`, `Dentist`) JSON-LD block with required props — `name`, `address` (`PostalAddress`), `telephone`.
2. **NAP consistency**: visible Name / Address / Phone match across the page (header, footer, contact block) and match the schema values — no formatting drift, no stale numbers.
3. **Geo coordinates**: `geo` (`GeoCoordinates` with `latitude`/`longitude`) present and plausible for the stated address.
4. **Opening hours**: `openingHoursSpecification` present, structured (`dayOfWeek`, `opens`, `closes`), and agreeing with any visible hours.
5. **Service-area**: for service-area businesses, `areaServed` declared rather than (or alongside) a `PostalAddress` storefront.
6. **GBP alignment (advisory)**: NAP, categories, and hours should match the Google Business Profile — the tool cannot read GBP, so this is advisory only.

## Fixes
- **AUTO**: generate a complete, valid `LocalBusiness` JSON-LD block from **user-confirmed** NAP, hours, geo, and service-area, with a stable `@id`. The block is a diff for `fix`.
- **NAP / hours drift**: PROPOSED — surface the mismatch and a draft correction for per-item accept (the tool cannot know which value is canonical).
- **GBP alignment**: ADVISORY — never written by the tool.
**Never fabricate** an address, phone, coordinates, or hours — ask the user or leave a clearly-marked `TODO` placeholder they fill before injection.

## Verification
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/validate-jsonld.mjs --url <u>` (`schema_validator`) — JSON validity + required LocalBusiness props; `dom_assert` confirms visible NAP matches schema.
- Tier 1: confirm rich-result eligibility with Google Rich Results Test / schema.org validator. When the data tier (or GBP) is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. On a non-local page these are `not_applicable` (severity 0); on local pages severity is 4, axis `both`. Examples:
- `M19.localbusiness.missing` — local page with no LocalBusiness schema (status `fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`). `evidence.observed` quotes the visible address/phone with no matching `ld+json`; `verification.reproduce` runs the validator above.
- `M19.nap.inconsistent` — footer phone differs from schema `telephone` (status `warn`, severity 4, `fixable: proposed`, axis `both`, confidence `directional`). `evidence.observed` quotes both strings; verified by `dom_assert`.
- `M19.hours.missing` — no `openingHoursSpecification` despite visible hours (status `warn`, severity 4, `fixable: auto`, axis `both`, confidence `established`).
Each finding: `evidence.observed` quotes the page; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- Consistent NAP + structured place data are **established** signals for local pack/maps and AI place answers; raw on-page **proximity/ranking gains are not promised** here — the dominant local-pack factors (proximity, GBP signals, reviews) sit outside the page DOM and are advisory.
- Adding `geo`/`openingHoursSpecification` will **not** by itself move local rankings without an accurate, verified GBP; never ship that as a guaranteed win.
- Do not invent coordinates from an address via an unverified geocode and present them as fact — mark unconfirmed values `TODO`.
