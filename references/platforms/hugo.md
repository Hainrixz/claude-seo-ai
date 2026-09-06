# hugo

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `hugo` · **Layer:** framework

Go static-site generator. The head lives in a partial; the content lives in front matter. Both are
deterministic text edits, which makes Hugo one of the best AUTO targets in this set.

## 1. Detection recap

Generator `Hugo` (4); with `--path`, `hugo.toml` / `config.toml|yaml|json` (4), `config/_default/`
(3), `archetypes/` (2), `layouts/partials|_default/` (2). Repo-only detection is normal here and
lands at `medium` — one signal kind cannot reach `high`.

## 2. Generated automatically — do not re-add

Nothing, unless the theme's partials add it. Hugo emits exactly what the templates say. That means a
missing tag is genuinely missing — and that a theme may already emit the tag you were about to add,
so read `layouts/partials/head.html` (and the theme's copy) first.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `content/posts/x.md` → `/posts/x/` | — |
| `url` in front matter | any path | Overrides the section path |
| `permalinks` config | per-section pattern | The file tree alone does not give the URL |
| Taxonomy | `/tags/<t>/`, `/categories/<c>/` | Thin archives |
| Pagination | `/page/2/` | Fine |
| `_index.md` | section landing page | — |
| Multilingual | `/es/...` or a per-language host | Needs hreflang |

## 4. Platform-owned — do not fix

Nothing is owned by Hugo itself. The **theme** under `themes/` is off limits for a different reason:
edits there are overwritten on the next theme update. Copy the partial into the project's own
`layouts/` and edit the copy.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, canonical, OG | `layouts/partials/head.html` (project copy) | `local-files` | AUTO (`html-head`) | none |
| Per-page title/description | the page's front matter (`title`, `description`) | `local-files` | AUTO (`front-matter`) | none |
| `baseURL` | `hugo.toml` | `local-files` | AUTO (`config-file`) | none |
| JSON-LD | a partial included from `head.html` | `local-files` | PROPOSED | none |
| robots | `static/robots.txt` (or `enableRobotsTXT` + a layout) | `local-files` | AUTO | none |
| Sitemap | Hugo's built-in sitemap; `sitemap` config for changefreq/priority | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; `hugo` builds them; the deploy publishes.

## 8. Verification

Source-level, then `--dev-url` against `hugo server` when the user offers one. Static output:
`pending_cache` until a rebuild.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M17.hugo.baseurl_missing` — fail · 3 · search · established · auto: no `baseURL`, so every
  generated absolute URL (sitemap included) is wrong

## 11. Manual paths (EN / ES)

- EN: copy `themes/<t>/layouts/partials/head.html` to `layouts/partials/head.html`, then edit the copy.
  ES: copia `themes/<t>/layouts/partials/head.html` a `layouts/partials/head.html` y edita la copia.
- EN: set `baseURL` in `hugo.toml`. ES: define `baseURL` en `hugo.toml`.

## 12. Honesty & UNVERIFIED

- `permalinks` and front-matter `url` mean the file path does not determine the URL. Resolve the
  mapping from the crawl, or mark it `manual_review`.
