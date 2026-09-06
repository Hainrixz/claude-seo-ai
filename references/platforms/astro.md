# astro

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `astro` · **Layer:** framework

Astro ships plain HTML by default, so the head is real markup in a layout file — the friendliest
framework in this set for deterministic fixes.

## 1. Detection recap

Generator `Astro` (4), `<astro-island` / `<astro-slot` / `data-astro-` (4), `/_astro/` asset paths
(4); with `--path`, `astro.config.*` (5) and the `astro` dependency (4).

## 2. Generated automatically — do not re-add

`/_astro/` asset links; the island hydration scripts; `<meta charset>` from the layout; the sitemap
when `@astrojs/sitemap` is installed. Astro adds no SEO tags on its own — an empty head is really
empty, which makes missing-tag findings unusually trustworthy here.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `src/pages/about.astro` → `/about` | — |
| Dynamic | `src/pages/blog/[slug].astro` + `getStaticPaths` | — |
| Rest | `src/pages/[...path].astro` | Soft 404s |
| Endpoint | `src/pages/robots.txt.ts` | A route, not a static file |
| Trailing slash | `trailingSlash` config | Both variants answering 200 is a duplicate |
| i18n | `src/pages/es/...` | Needs hreflang |

## 4. Platform-owned — do not fix

`/_astro/` asset URLs and island markup. `not_applicable`, owner Astro.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, canonical, OG | the `<head>` in `src/layouts/*.astro` | `local-files` | AUTO (`html-head`) | none |
| Per-page overrides | the page's frontmatter + layout props | `local-files` | PROPOSED | none |
| JSON-LD | `<script type="application/ld+json" set:html={…}>` in the layout | `local-files` | PROPOSED | none |
| `site` (absolute URLs, sitemap) | `astro.config.*` `site:` | `local-files` | AUTO | none |
| robots | `public/robots.txt` | `local-files` | AUTO | none |

`@astrojs/sitemap` **requires `site` in `astro.config`**; without it no sitemap is emitted at all.
That makes the fix deterministic: take the audited origin, write it into the config.

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the build publishes them.

## 8. Verification

Source-level, then `--dev-url`. Astro's default output is static: a rebuild is required, so
`pending_cache` until then.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M17.astro.site_missing` — 3 · search · established · auto. **fail** when `@astrojs/sitemap` is
  installed (the integration silently emits nothing), **warn** when it is not.

## 11. Manual paths (EN / ES)

- EN: add `site: 'https://…'` to `astro.config.mjs`, then rebuild.
  ES: añade `site: 'https://…'` a `astro.config.mjs` y reconstruye.
- EN: head tags live in `src/layouts/<Layout>.astro`, not in each page.
  ES: las etiquetas del head viven en `src/layouts/<Layout>.astro`, no en cada página.

## 12. Honesty & UNVERIFIED

- A site using an SSR adapter can render tags from data at request time; the file tree then only
  tells half the story. Confirm with the rendered snapshot.
