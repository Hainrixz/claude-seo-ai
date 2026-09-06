# jekyll

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `jekyll` · **Layer:** framework

Ruby static-site generator, the default on GitHub Pages. When `jekyll-seo-tag` is installed it owns
the head entirely — that changes every fix in this card.

## 1. Detection recap

Generator `Jekyll` (4), the `<!-- Begin Jekyll SEO tag -->` comment (3); with `--path`, `_config.yml`
(4), `_posts/` (3), `_layouts/` (2). The comment also sets `framework.flavor = jekyll-seo-tag`.

## 2. Generated automatically — do not re-add

With `jekyll-seo-tag`: title, description, canonical, Open Graph, Twitter cards and JSON-LD, all
from `_config.yml` and each page's front matter. Adding your own tags next to it produces duplicates.
Without the plugin, Jekyll emits nothing beyond what the layout contains.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Post | `_posts/YYYY-MM-DD-slug.md` → the `permalink` pattern | — |
| Page | `about.md` → `/about/` | — |
| `permalink` front matter | any path | Overrides the default |
| Collection | `_docs/x.md` → `/docs/x/` | — |
| Category / tag pages | only if a plugin generates them | Often 404 while still linked |
| `baseurl` | a subpath deploy | Absolute URLs break without `url` + `baseurl` |

## 4. Platform-owned — do not fix

When `jekyll-seo-tag` is present, the whole head is the plugin's. Emit
`M7.jekyll.seo_tag_present` as `not_applicable` naming it, and fix the **inputs** (front matter,
`_config.yml`) instead of the output.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Per-page title/description | the page's front matter | `local-files` | AUTO (`front-matter`) | none |
| Site title, description, `url`, `baseurl`, `lang` | `_config.yml` | `local-files` | AUTO (`config-file`) | none |
| Head tags (no `jekyll-seo-tag`) | `_includes/head.html` | `local-files` | AUTO (`html-head`) | none |
| JSON-LD (no plugin) | `_includes/head.html` | `local-files` | PROPOSED | none |
| robots | `robots.txt` at the site root | `local-files` | AUTO | none |
| Sitemap | `jekyll-sitemap` in `_config.yml` | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; `jekyll build` (or GitHub Pages' build) publishes them.

## 8. Verification

Source-level, then `--dev-url`. GitHub Pages rebuilds asynchronously after a push: `pending_cache`
is the right answer for a few minutes.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M7.jekyll.seo_tag_present` — `not_applicable`: `jekyll-seo-tag` owns the head; head-injection
  fixes become front-matter / `_config.yml` edits

## 11. Manual paths (EN / ES)

- EN: with `jekyll-seo-tag`, set `title` and `description` in the page's front matter — not in the layout.
  ES: con `jekyll-seo-tag`, define `title` y `description` en el front matter de la página, no en el layout.
- EN: set `url` and `baseurl` in `_config.yml`. ES: define `url` y `baseurl` en `_config.yml`.

## 12. Honesty & UNVERIFIED

- The plugin can be present in `_config.yml` and absent from the built output (or vice versa on a
  GitHub Pages allowlist). Trust the rendered comment over the config when they disagree.
