# gatsby

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `gatsby` · **Layer:** framework

React static-site generator. Head tags come from the `Head` export, which Gatsby only honours in
page and template files.

## 1. Detection recap

`id="___gatsby"` (4), `/page-data/` paths (4), generator `Gatsby` (4); with `--path`,
`gatsby-config.*` (5) and the `gatsby` dependency (4).

## 2. Generated automatically — do not re-add

The `/page-data/` JSON preloads, the webpack runtime scripts, and `gatsby-plugin-image`'s markup.
Anything a head plugin already emits (`gatsby-plugin-sitemap`, `gatsby-plugin-robots-txt`) — check
`gatsby-config` before adding a tag.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page file | `src/pages/about.js` → `/about` | — |
| Programmatic page | `createPage` in `gatsby-node.js` → `src/templates/*` | The URL is decided in code; the file tree is only a hint (low confidence) |
| Client-only route | `src/pages/app/[...].js` | Not crawlable content |
| Trailing slash | `trailingSlash` option | Duplicate variants |
| `/page-data/*.json` | data payloads | Should not be indexed as pages |

## 4. Platform-owned — do not fix

`/page-data/` URLs, the webpack runtime, and `gatsby-plugin-image` output. `not_applicable`, owner
Gatsby.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, OG | the `export function Head()` of a page or template | `local-files` | PROPOSED | none |
| Site URL (canonical, sitemap) | `gatsby-config` `siteMetadata.siteUrl` | `local-files` | AUTO | none |
| JSON-LD | a `<script type="application/ld+json">` inside `Head` | `local-files` | PROPOSED | none |
| robots | `static/robots.txt` or `gatsby-plugin-robots-txt` config | `local-files` | AUTO | none |
| Sitemap | `gatsby-plugin-sitemap` in `gatsby-config` | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the build publishes them.

## 8. Verification

Source-level, then `--dev-url`. Gatsby output is static: `pending_cache` until a rebuild.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M17.gatsby.site_url_missing` — warn · 3 · search · established · auto: no `siteMetadata.siteUrl`
- `M7.gatsby.head_in_non_page` — warn · 3 · search · established · advisory: a `Head` export in a
  component that is neither a page nor a template, where Gatsby ignores it

## 11. Manual paths (EN / ES)

- EN: `Head` only works in `src/pages/**` and the templates used by `createPage`.
  ES: `Head` solo funciona en `src/pages/**` y en las plantillas usadas por `createPage`.
- EN: set `siteMetadata.siteUrl` in `gatsby-config`. ES: define `siteMetadata.siteUrl` en `gatsby-config`.

## 12. Honesty & UNVERIFIED

- Mapping a URL to its template requires reading `gatsby-node.js`. When that mapping is not certain,
  the route→file result is low confidence and the fix is PROPOSED at best.
