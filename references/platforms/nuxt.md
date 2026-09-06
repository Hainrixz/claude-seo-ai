# nuxt

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `nuxt` · **Layer:** framework

Vue's meta framework. `useSeoMeta` in the page component is the recommended head API; site-wide
values live in `nuxt.config`.

## 1. Detection recap

`/_nuxt/` asset paths (4), `id="__nuxt"` (4), `__NUXT_DATA__` / `window.__NUXT__` (4), generator (3);
with `--path`, `nuxt.config.*` (5) and the `nuxt` dependency (4). `app/pages/` in the repo means a
Nuxt 4 layout (`framework.flavor = nuxt-4`).

## 2. Generated automatically — do not re-add

The `/_nuxt/` module preloads and style links; the hydration payload; `<html lang>` when
`app.head.htmlAttrs.lang` is set in config; whatever `@nuxtjs/seo` already emits (canonical, OG
image, robots) when the module is installed — check before adding.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `pages/about.vue` → `/about` | — |
| Dynamic | `pages/blog/[slug].vue` | — |
| Catch-all | `pages/[...slug].vue` | Soft 404s |
| Nested layout route | `pages/parent/index.vue` + `pages/parent.vue` | — |
| i18n | `/es/...` via `@nuxtjs/i18n` | Needs hreflang |

## 4. Platform-owned — do not fix

`/_nuxt/` asset URLs and the hydration payload. `not_applicable`, owner Nuxt.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Title, description, OG per page | `useSeoMeta({ … })` in the page's `<script setup>` | `local-files` | PROPOSED | none |
| Site-wide head defaults | `nuxt.config` `app.head` | `local-files` | AUTO | none |
| Site URL (canonical/sitemap base) | `nuxt.config` `site.url` (`@nuxtjs/seo`) | `local-files` | AUTO | none |
| JSON-LD | `useHead({ script: [{ type: 'application/ld+json', innerHTML: … }] })` | `local-files` | PROPOSED | none |
| robots / sitemap | `public/robots.txt`, or the `@nuxtjs/seo` modules | `local-files` | AUTO | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the deploy publishes them.

## 8. Verification

Source-level, then `--dev-url` re-snapshot when available. Nuxt pre-renders in many setups: expect
`pending_cache` until a rebuild.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

- `M17.nuxt.site_url_missing` — warn · 3 · search · established · auto: no `site.url` configured, so
  canonical and sitemap URLs cannot be absolute

## 11. Manual paths (EN / ES)

- EN: add `useSeoMeta({ title, description })` to the page's `<script setup>`.
  ES: añade `useSeoMeta({ title, description })` al `<script setup>` de la página.
- EN: set `site: { url: 'https://…' }` in `nuxt.config`. ES: define `site: { url: 'https://…' }` en `nuxt.config`.

## 12. Honesty & UNVERIFIED

- Which of `@nuxtjs/seo`'s sub-modules are enabled changes what is already emitted; read the config
  before claiming a tag is missing.
- Nuxt 2 (`window.__NUXT__`, `nuxt.config.js` with a different shape) is out of scope for the AUTO
  edits here; treat it as PROPOSED.
