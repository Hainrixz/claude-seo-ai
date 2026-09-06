# eleventy

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `eleventy` · **Layer:** framework

A minimal static-site generator: the head is whatever your base layout contains, and the URL comes
from `permalink` or the input path.

## 1. Detection recap

Generator `Eleventy` (4); with `--path`, `.eleventy.js` / `eleventy.config.js|cjs|mjs` (5) and the
`@11ty/eleventy` dependency (5). Many Eleventy sites emit no generator tag, so a URL-only audit will
often say `static` instead — that is honest, not a miss.

## 2. Generated automatically — do not re-add

Nothing. Eleventy emits exactly what the templates say. A missing tag is genuinely missing.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Input file | `src/about.md` → `/about/` | Depends on `dir.input` |
| `permalink` front matter | any path | Overrides the default; `permalink: false` emits nothing |
| Pagination | `pagination` front matter | Generates many URLs from one file |
| Collections | template + `collections.*` | Same |
| `dir.input` | config | The file tree does not give the URL without it |

## 4. Platform-owned — do not fix

Nothing. Eleventy owns no output.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, canonical, OG | `_includes/layouts/base.*` (the base layout's `<head>`) | `local-files` | AUTO (`html-head`) | none |
| Per-page title/description | the page's front matter | `local-files` | AUTO (`front-matter`) | none |
| Site-wide values (URL, title, author) | `_data/site.json` — ask before creating it if absent | `local-files` | PROPOSED | none |
| JSON-LD | an include pulled into the base layout | `local-files` | PROPOSED | none |
| robots / sitemap | a passthrough `robots.txt`, and a `sitemap.njk` template | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the build publishes them.

## 8. Verification

Source-level, then `--dev-url`. Static output: `pending_cache` until a rebuild.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

No Eleventy-specific ids. Missing site URL configuration is reported under the generic `M17.*`
sitemap ids with `_data/site.json` named in `evidence.observed`.

## 11. Manual paths (EN / ES)

- EN: head tags belong in the base layout under `_includes/layouts/`.
  ES: las etiquetas del head van en el layout base bajo `_includes/layouts/`.
- EN: `dir.input` in the Eleventy config decides where pages live. ES: `dir.input` en la configuración
  de Eleventy decide dónde viven las páginas.

## 12. Honesty & UNVERIFIED

- Directory conventions in Eleventy are configuration, not convention. Read the config before
  claiming a file path; without it the route→file mapping is `manual_review`.
