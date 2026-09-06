# docusaurus

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `docusaurus` · **Layer:** framework

A React documentation site generator. Most SEO values come from `docusaurus.config` and each doc's
front matter; the theme renders the head. Sets the `docs` vertical hint.

## 1. Detection recap

Generator `Docusaurus` (4), the `__docusaurus` root marker (3); with `--path`,
`docusaurus.config.*` (5) and the `@docusaurus/core` dependency (5).

## 2. Generated automatically — do not re-add

Canonical tags, the `og:` block from the doc's title/description, the sitemap
(`@docusaurus/plugin-sitemap` in the classic preset), the search index when Algolia is configured,
and the versioned/i18n `hreflang` alternates. The theme also emits `<html lang>`.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Doc | `docs/intro.md` → `/docs/intro` | `slug` front matter overrides it |
| Versioned docs | `/docs/2.x/intro` + `/docs/intro` | Old versions duplicate the current one — check the canonical |
| i18n | `/es/docs/intro` | Needs hreflang (Docusaurus emits it) |
| Blog | `/blog/<slug>`, `/blog/tags/<t>` | Thin tag archives |
| Pages | `src/pages/*.tsx|md` | — |

Versioned documentation is the dominant duplicate risk on this platform: the same page exists once
per version, and only the current version should be canonical.

## 4. Platform-owned — do not fix

The theme's head order, the generated sitemap, the search index, and the version dropdown.
`not_applicable`, owner Docusaurus.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Doc title / description / slug | the doc's front matter (`title`, `description`, `slug`) | `local-files` | AUTO (`front-matter`) | none |
| Site url / baseUrl / title / tagline | `docusaurus.config.*` | `local-files` | AUTO (`config-file`) | none |
| Extra head tags | `themeConfig.metadata`, or `<Head>` in a page component | `local-files` | PROPOSED | none |
| JSON-LD | a `<Head>` block in the page/theme component | `local-files` | PROPOSED | none |
| robots | `static/robots.txt` | `local-files` | AUTO | none |
| Old-version indexing | `noIndex` on archived versions, or a canonical to current | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the build publishes them.

## 8. Verification

Source-level, then `--dev-url`. Static output: `pending_cache` until a rebuild.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

No Docusaurus-specific ids. Version duplication is reported under the M2 canonical ids with the
version paths in `evidence.observed`; the `docs` hint raises M10 (internal linking) and M11 (answer
blocks) in the report's emphasis.

## 11. Manual paths (EN / ES)

- EN: `title` and `description` in the doc's front matter drive the head.
  ES: `title` y `description` en el front matter del documento controlan el head.
- EN: `url` + `baseUrl` in `docusaurus.config` make absolute URLs correct.
  ES: `url` + `baseUrl` en `docusaurus.config` corrigen las URLs absolutas.

## 12. Honesty & UNVERIFIED

- Whether old versions are indexable depends on the versioning setup; check the rendered canonical
  before calling it a duplicate.
