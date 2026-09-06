# ghost

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `ghost` · **Layer:** platform

A publishing platform with a genuine Admin API for post metadata, plus Handlebars themes when the
site is self-hosted.

## 1. Detection recap

Header `x-ghost-cache-status` (5), `/ghost/api/content/` script paths (4), generator `Ghost` (4),
`ghost-portal` / `data-ghost` markers (2).

## 2. Generated automatically — do not re-add

`sitemap.xml` (and the per-type children `sitemap-posts.xml`, `sitemap-pages.xml`, …); `robots.txt`;
canonical tags; the Article/Person JSON-LD Ghost emits for posts and authors; RSS at `/rss/`; the
AMP variant when enabled; Open Graph and Twitter tags from the post's own fields.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Post | `/<slug>/` | — |
| Page | `/<slug>/` | Shares the namespace with posts |
| Tag / author archive | `/tag/<t>/`, `/author/<a>/` | Thin when sparse |
| Pagination | `/page/2/` | Fine |
| AMP | `/<slug>/amp/` | Duplicate when AMP is enabled |
| Preview | `/p/<uuid>/` | Should not be indexable |
| RSS | `/rss/` | Not a duplicate, but must not be blocked |

## 4. Platform-owned — do not fix

`sitemap.xml`, `robots.txt` (self-hosted installs can override it in the theme, managed Ghost(Pro)
cannot), the built-in JSON-LD graph, and the members/portal scripts. `not_applicable`, owner Ghost.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| `meta_title`, `meta_description`, `og_*`, `twitter_*`, `canonical_url` | Admin API `PUT /posts/{id}/` | `page-api` | PROPOSED | **live** |
| Head snippet (extra JSON-LD) | `codeinjection_head` on the post, or Settings → Code injection | `page-api` / `instructions` | PROPOSED | **live** |
| Theme head (self-hosted, repo available) | `default.hbs` | `local-files` | AUTO | none |
| Slug change + redirect | Admin, plus `redirects.json` upload | `instructions` | ADVISORY | none |
| Image alt | the editor's image card alt field | `instructions` | ADVISORY | none |

## 6. Write method & credentials

Ghost Admin API. Credential key names: `GHOST_URL`, `GHOST_ADMIN_KEY` (the `GHOST_ADMIN_API_*`
spellings still resolve). A post update
**requires the current `updated_at`** in the payload — Ghost uses it for collision detection and
rejects the write without it. Read the post first, always.

## 7. Preview & publish

Published posts change live on write. Drafts stay drafts — updating a draft's metadata is
`live_impact: none`. Never flip `status`.

## 8. Verification

Re-read the post over the Admin API and snapshot the public URL. `x-ghost-cache-status: HIT` with an
old head is `pending_cache`.

## 9. Rollback

Write the captured `before` fields back with a fresh `updated_at`. Nothing else in this card
changes site-wide state.

## 10. Check ids

No Ghost-specific ids yet. `M17.*` sitemap fixes are `not_applicable` (owner Ghost). AMP duplicates
and `/p/<uuid>/` previews are reported under the M2 ids with the surface in `evidence.observed`.

## 11. Manual paths (EN / ES)

- Post meta — EN: Post → settings (gear) → Meta data. ES: Entrada → ajustes (engranaje) → Metadatos.
- Code injection — EN: Settings → Code injection → Site header.
  ES: Configuración → Inyección de código → Encabezado del sitio.
- Redirects — EN: Settings → Labs → Redirects (upload `redirects.json`).
  ES: Configuración → Labs → Redirecciones (sube `redirects.json`).

## 12. Honesty & UNVERIFIED

- The exact Admin API version path and the JWT/Admin-key signing dance are **UNVERIFIED** in this
  build; the adapter reports `needs_api` until the request shape is confirmed.
- Ghost(Pro) does not allow theme file edits through us; only self-hosted installs with the repo
  checked out get the `local-files` row.
