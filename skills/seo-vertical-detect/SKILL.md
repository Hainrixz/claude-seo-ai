---
name: seo-vertical-detect
description: Classify a website as ecommerce, local-business, blog-publisher, saas, docs, or generic (multiple may apply), and report detected locales. Used by seo-orchestrator to decide which conditional modules to run and how to reweight the scores.
allowed-tools: Read, Grep, Glob, WebFetch
---

# seo-vertical-detect

Given the PageSnapshot, classify the site so the orchestrator can route conditional modules. Read `references/routing.md` for the signal table.

## Method
Score each vertical from observable signals (not guesses):
- **ecommerce** — `Product`/`Offer` JSON-LD, cart/checkout/add-to-cart routes or buttons, price + currency elements, `og:type=product`.
- **local-business** — `LocalBusiness` JSON-LD, NAP block (name/address/phone), maps embed, opening hours, store-locator.
- **blog-publisher** — `Article`/`BlogPosting` JSON-LD, author bylines/author pages, RSS/Atom `<link>`, dated post archives.
- **saas** — pricing/signup/login routes, `SoftwareApplication` schema, feature/integration/docs pages.
- **docs** — docs/reference routes, sidebar/version nav, dense code blocks, present `llms.txt`.
- **generic** — none dominates.

A site can match several; return all that clear the threshold, ranked, plus a `primary`.

**Locales**: detect `hreflang` tags, `<html lang>`, and locale-prefixed routes (`/es/`, `/fr/`). If >1 locale, flag multilingual so M20 (hreflang) activates.

## Output
```json
{ "primary": "ecommerce", "also": ["blog-publisher"], "multilingual": true, "locales": ["en","es"],
  "signals": { "ecommerce": ["Product JSON-LD on /p/...", "cart route /cart"], "...": [] } }
```
Base every classification on a cited signal in `signals` — never label a vertical without evidence.
