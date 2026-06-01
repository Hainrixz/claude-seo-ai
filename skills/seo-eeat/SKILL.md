---
name: seo-eeat
description: Audit and strengthen E-E-A-T and trust signals on a page — verify author identity/credentials (Person schema, byline, author page, sameAs), Organization about/contact/policies, visible experience/expertise markers, and transparency (sourcing, disclosures), and generate Person/Organization trust JSON-LD. Module M16. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-eeat (M16)

Experience, Expertise, Authoritativeness, and Trust are how both Google's quality systems and AI answer engines decide whether to rely on a page. Trust is foundational and now applies beyond YMYL. Schema details: `references/schema-tier1.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Author identity & credentials**: is there a visible byline? A `Person` schema with `name`, `jobTitle`, `knowsAbout`, and `sameAs[]` (LinkedIn/Wikidata)? Does the byline link to an author/bio page? Are credentials/experience stated, not just a name?
2. **Organization trust**: discoverable About and Contact pages; an `Organization` block with `name`, `url`, `logo`, `contactPoint`, `sameAs[]`; visible editorial/privacy/returns policies appropriate to the vertical.
3. **Experience & expertise markers**: first-hand signals (original photos, "we tested", dates, methodology) and topical depth — not just generic prose.
4. **Transparency**: sourcing/citations for claims, author disclosures (affiliate, sponsored, AI-assisted), last-reviewed dates. Defer the `sameAs` identity-graph detail to M6/seo-entity-linking.

## Fixes
- **AUTO** (`fixable: auto`): inject `Person` (author) and `Organization` trust JSON-LD built **only from confirmed inputs** — name, jobTitle, contactPoint, policy URLs the user supplies. The block is a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): draft a byline link or a `sameAs` set for per-item accept.
- **ADVISORY** (`fixable: advisory`): writing real author bios, About/contact pages, or editorial policies — the tool never authors these. **Never fabricate** names, credentials, dates, or identity links — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/validate-jsonld.mjs --url <u>` plus `dom_assert` for visible byline/links/policy pages.
- When confirming an identity link or a live About/contact page requires a fetch that is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M16.author.missing_person_schema` — editorial page with a byline but no `Person` schema (status `fail`, severity 4, `fixable: auto`, axis `both`, confidence `established`).
- `M16.author.no_bio_page` — byline does not link to an author/bio page (status `warn`, severity 3, `fixable: proposed`, axis `both`, confidence `directional`).
- `M16.org.no_contact_page` — no discoverable About/Contact or `contactPoint` (status `warn`, severity 3, `fixable: advisory`, axis `both`, confidence `directional`).
Each finding: `evidence.observed` quotes what is on the page; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- E-E-A-T is not a single measurable score Google exposes — it is a quality framing assessed via many signals. Adding a `Person` block or an "author bio" is not a direct ranking lever; mark such impact `directional`, never as a guaranteed gain.
- A fabricated author, invented credentials, or fake review markup is worse than none — it is a trust risk for Search and AI. The tool only emits trust signals the user can substantiate.
