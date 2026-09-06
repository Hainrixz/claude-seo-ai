# nextjs

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `nextjs` · **Layer:** framework

The head is code. With `--project` checked out, most head fixes are deterministic file edits; without
it, every fix is a snippet the user pastes. The router flavor decides which rules apply.

## 1. Detection recap

`x-powered-by: Next.js` (5), `/_next/` asset paths (4), `__NEXT_DATA__` (4), `self.__next_f.push`
(4), `next-head-count` (3); with `--path`, `next.config.*` (5) and the `next` dependency (4).
Router: `app/layout.*` or `self.__next_f.push` ⇒ **app**; `pages/_app.*`, `__NEXT_DATA__` or
`next-head-count` ⇒ **pages**. `framework.flavor` is `app-router` / `pages-router`.

## 2. Generated automatically — do not re-add

`<meta charset>` and the viewport tag from the metadata defaults; the `/_next/` asset links and
preloads; `next/image`'s `srcset` and `sizes`; the streaming chunks (App Router). Also: whatever
`generateMetadata` already returns — read the route's source before adding a tag, or you will ship
two titles.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Static route | `app/about/page.tsx` → `/about` | — |
| Dynamic | `[slug]`, `[...slug]`, `[[...slug]]` | Catch-alls can serve any path with a 200 — check for soft 404s |
| Route group | `(marketing)/about/page.tsx` → `/about` | The group segment is **not** in the URL |
| Parallel / intercepting | `@modal`, `(.)photo` | Not standalone URLs |
| i18n (pages router) | `/es/...` | Duplication without hreflang |
| Trailing slash | `trailingSlash` config | Both variants answering 200 is a duplicate |

## 4. Platform-owned — do not fix

The `/_next/` asset URLs, the build manifest, the RSC payload, and `next/image`'s generated markup.
`not_applicable`, owner Next.js.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, canonical, OG (App) | the route's `export const metadata = {` — merge keys | `local-files` | AUTO **only** with that literal anchor, else PROPOSED | none |
| Same, computed | `generateMetadata` return object | `local-files` | PROPOSED | none |
| Title/description (Pages) | inside an existing `<Head>` in the page | `local-files` | AUTO; creating `<Head>` is PROPOSED | none |
| `metadataBase` | `app/layout.*` metadata object | `local-files` | AUTO | none |
| `<html lang>` | `app/layout.*` (App) or `_document.*` (Pages) | `local-files` | AUTO | none |
| JSON-LD | `<script type="application/ld+json" dangerouslySetInnerHTML={{__html: …}} />` in the route | `local-files` | PROPOSED | none |
| robots | `app/robots.ts` or `public/robots.txt` — never both | `local-files` | AUTO | none |
| Sitemap | `app/sitemap.ts` (`generateSitemaps`, `alternates.languages`) or `next-sitemap` | `local-files` | AUTO | none |

**`metadataBase` is required** for relative OG/canonical URLs; without it the build errors or the
URLs resolve wrong. `title.template` applies to child routes only, never to the layout's own title.

## 6. Write method & credentials

`local-files` — no credentials. Inside Claude Code the writer applies the diff with Edit/Write so the
native diff prompt and `guard-write` engage; the adapter's own `apply` exists for `--yes`/CI runs and
is contained to `--project`. Without `--project` the profile offers `instructions` only.

## 7. Preview & publish

None of this is live: a file edit changes the repo. The deploy is the user's (or CI's) action, and
it is what makes the change public. Say so, so nobody thinks a green diff is a fixed site.

## 8. Verification

Source-level first (the anchor now contains the value), then, when `--dev-url` is given, re-snapshot
the dev/preview URL and re-run the module scripts. A statically generated route needs a rebuild
before the HTML changes — that is `pending_cache`, not a failure.

## 9. Rollback

Restore the file from the run's `before/` copy. One file per change, so a rollback never touches a
route the change did not.

## 10. Check ids

- `M7.nextjs.metadata_base_missing` — fail · 3 · search · established · auto(local): relative OG or
  canonical URLs with no `metadataBase`
- `M1.nextjs.robots_conflict` — warn · 3 · search · established · proposed: both `app/robots.ts` and
  `public/robots.txt` exist
- `M17.nextjs.sitemap_missing_source` — warn · 3 · search · directional · auto: the sitemap 404s and
  no `app/sitemap.ts` / `next-sitemap` source exists

## 11. Manual paths (EN / ES)

- EN: open the route file, add the key to the exported `metadata` object, redeploy.
  ES: abre el archivo de la ruta, añade la clave al objeto `metadata` exportado y vuelve a desplegar.
- EN: robots and sitemap live in code (`app/robots.ts`, `app/sitemap.ts`) — editing a stray
  `public/robots.txt` does nothing when the route file exists.
  ES: robots y sitemap viven en el código; editar un `public/robots.txt` suelto no hace nada si
  existe el archivo de ruta.

## 12. Honesty & UNVERIFIED

- A route whose metadata is computed from a CMS cannot be fixed by editing the route file — the fix
  belongs to the CMS. When `platform` is also detected, follow the platform card for content.
- Catch-all routes make "does this URL exist" unanswerable from the file tree alone. Use the crawl.
