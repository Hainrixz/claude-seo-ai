# react-router

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `react-router` · **Layer:** framework

Covers React Router v7 framework mode, Remix, and Shopify Hydrogen — they share one head model: a
`meta` export per route. `framework.flavor` is `react-router-7`, `remix` or `hydrogen`.

## 1. Detection recap

`__remixContext` (4, Remix/Hydrogen) or `__reactRouterContext` (4, RR7); with `--path`,
`react-router.config.*` / `remix.config.*` (5), `@remix-run/react` (4), `react-router` (3),
`@shopify/hydrogen` (5). When the platform layer also says `shopify`, the flavor is `hydrogen` and
`shopify.md` governs the URL surfaces and the Admin API.

## 2. Generated automatically — do not re-add

The `/build/` or `/assets/` module scripts and the hydration context. Nothing SEO-related is emitted
by the framework. Hydrogen's `getSeoMeta` emits whatever the loader's `seo` object contains — read
it before adding a tag.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Flat route | `app/routes/products.$handle.tsx` → `/products/:handle` | — |
| Index | `app/routes/_index.tsx` → `/` | — |
| Splat | `app/routes/$.tsx` | Catches everything — soft 404s |
| Pathless layout | `app/routes/_app.tsx` | Not a URL |
| Config routes | `app/routes.ts` | The file tree is not the whole truth; parse it |

## 4. Platform-owned — do not fix

The build asset URLs and the hydration context. On Hydrogen, everything in `shopify.md` §4.
`not_applicable`, owner the framework/platform.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, OG for a route | the route's `export const meta` array | `local-files` | PROPOSED | none |
| Inherited parent tags | add `...matches.flatMap((m) => m.meta ?? [])` to the child's array | `local-files` | PROPOSED | none |
| `<html lang>` | `app/root.tsx` | `local-files` | AUTO | none |
| JSON-LD | a `<script type="application/ld+json">` in the route component | `local-files` | PROPOSED | none |
| robots / sitemap | `app/routes/robots[.]txt.tsx`, `app/routes/sitemap[.]xml.tsx` | `local-files` | PROPOSED | none |
| Hydrogen SEO | the loader's `seo` object + `getSeoMeta` | `local-files` | PROPOSED | none |

**A child route's `meta` export replaces the parent's, it does not merge.** A route that exports
`meta` without spreading `matches` silently drops every site-wide tag — that is the most valuable
finding this card unlocks.

## 6. Write method & credentials

`local-files`, no credentials. On Hydrogen, product/collection SEO fields still come from Shopify
Admin (`shopify.md` §6), not from the repo.

## 7. Preview & publish

Repo edits; the deploy publishes them. Hydrogen on Oxygen: preview deployments per branch.

## 8. Verification

Source-level, then `--dev-url`. Note for Hydrogen: Oxygen serves `robots.txt` only on the production
custom domain, so a preview URL is not evidence about robots.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M7.react_router.meta_replaces_parent` — warn · 2 · search · established · proposed: a child route
  exports `meta` without spreading the parent matches

## 11. Manual paths (EN / ES)

- EN: in the route file, start the `meta` array with `...matches.flatMap((m) => m.meta ?? [])`.
  ES: en el archivo de la ruta, empieza el array `meta` con `...matches.flatMap((m) => m.meta ?? [])`.
- EN (Hydrogen): set the `seo` object in the loader and render it with `getSeoMeta`.
  ES (Hydrogen): define el objeto `seo` en el loader y renderízalo con `getSeoMeta`.

## 12. Honesty & UNVERIFIED

- With `app/routes.ts` in play, the file tree does not define the URLs. Parse the config or say the
  route mapping is `manual_review`.
- Hydrogen versions differ in whether `getSeoMeta` or a `seo` export is idiomatic; read the repo.
