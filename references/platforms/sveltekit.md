# sveltekit

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `sveltekit` · **Layer:** framework

Head tags come from `<svelte:head>` blocks, usually in the root layout, fed by `page.data`.

## 1. Detection recap

`/_app/immutable/` asset paths (4), `data-sveltekit-*` attributes (3), the `__sveltekit_` global (3);
with `--path`, `svelte.config.*` (4), `src/routes/` (2) and the `@sveltejs/kit` dependency (5).

## 2. Generated automatically — do not re-add

`/_app/immutable/` module preloads; the hydration payload; `%sveltekit.head%` output from
`src/app.html`. SvelteKit adds no SEO tags by itself.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `src/routes/about/+page.svelte` → `/about` | — |
| Dynamic | `[slug]`, `[...rest]`, `[[optional]]` | Optional params create two URLs for one page |
| Group | `(app)/about/+page.svelte` → `/about` | The group is not in the URL |
| Endpoint | `src/routes/robots.txt/+server.js` | A route, not a static file |
| Trailing slash | `trailingSlash` in `+layout.js` | Duplicate variants |

## 4. Platform-owned — do not fix

`/_app/immutable/` URLs and the hydration payload. `not_applicable`, owner SvelteKit.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Static title/description/OG | `<svelte:head>` in `src/routes/+layout.svelte` | `local-files` | AUTO (`html-head`) | none |
| Data-driven head values | `<svelte:head>` reading `$page.data` | `local-files` | PROPOSED | none |
| `<html lang>` | `src/app.html` | `local-files` | AUTO | none |
| JSON-LD | `<svelte:head>` with `{@html …}` | `local-files` | PROPOSED | none |
| robots | `static/robots.txt` **or** `src/routes/robots.txt/+server.js` — never both | `local-files` | AUTO | none |
| Sitemap | `src/routes/sitemap.xml/+server.js` | `local-files` | PROPOSED | none |

## 6. Write method & credentials

`local-files`, no credentials. Without `--project`, `instructions` only.

## 7. Preview & publish

Repo edits; the deploy publishes them.

## 8. Verification

Source-level, then `--dev-url`. Prerendered routes need a rebuild — `pending_cache` until then.

## 9. Rollback

Restore the file from `before/`.

## 10. Check ids

No SvelteKit-specific ids yet. A `static/robots.txt` shadowed by a `+server.js` route is reported
under `M1.*` with both locations in `evidence.observed`.

## 11. Manual paths (EN / ES)

- EN: put shared tags in `src/routes/+layout.svelte` inside `<svelte:head>`.
  ES: coloca las etiquetas comunes en `src/routes/+layout.svelte` dentro de `<svelte:head>`.
- EN: `<html lang>` is in `src/app.html`. ES: `<html lang>` está en `src/app.html`.

## 12. Honesty & UNVERIFIED

- Whether a route is prerendered or server-rendered changes what a source fix achieves; read the
  route's `prerender` export before promising an outcome.
