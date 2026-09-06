# webflow

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `webflow` · **Layer:** platform

A visual builder with a real page API, so head fields are writable; everything structural is a
Designer action.

## 1. Detection recap

Asset host `website-files.com` (4), generator `Webflow` (4), the `data-wf-site` attribute (4 — it
also yields the site id), `data-wf-page` (2).

## 2. Generated automatically — do not re-add

`sitemap.xml` (auto mode) and `robots.txt` from the project settings; canonical tags; the
title/description Webflow renders from each page's SEO settings; Open Graph from the page's OG
settings; responsive image variants on the CDN.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Static page | `/<slug>` | — |
| CMS collection item | `/<collection-slug>/<item-slug>` | Renaming a collection slug moves every item |
| Staging | `<site>.webflow.io` | Indexable unless disabled — a classic duplicate-site leak |
| Locale | `/<locale>/<slug>` | Localization adds a prefix per locale |

`<site>.webflow.io` staging being crawlable is the highest-value Webflow finding; it duplicates the
entire production site.

## 4. Platform-owned — do not fix

Auto-generated `sitemap.xml` (unless the project switched to a manual sitemap), the CDN, the
published HTML structure, and the Designer's class system. Emit as `not_applicable`, owner Webflow.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Page title, slug, SEO title/description, OG fields | `PUT /v2/pages/{page_id}` body `{ title, slug, seo{title,description}, openGraph{…} }` | `page-api` | PROPOSED | **live** on publish |
| JSON-LD / extra head tags | custom-code API, or Project settings → Custom code → Head | `page-api` / `instructions` | PROPOSED | **live** on publish |
| Redirect | Project settings → Publishing → 301 redirects | `instructions` | ADVISORY | none |
| Staging indexability | Project settings → SEO → disable subdomain indexing | `instructions` | ADVISORY | none |
| Image alt | Designer / Asset manager alt field | `instructions` | ADVISORY | none |

## 6. Write method & credentials

Webflow Data API v2, `PUT /v2/pages/{page_id}` with scope `pages:write`; the custom-code API for
head snippets. Credential key names: `WEBFLOW_TOKEN`, `WEBFLOW_SITE_ID`. Page ids come from the
site's page list, not from the URL.

## 7. Preview & publish

API writes land in the **unpublished** project state; the site changes when the project is
published. Publishing is a separate, explicitly confirmed op. Say plainly which state a change is in
— "saved but not published" is not "fixed".

## 8. Verification

Re-read the page over the API, then snapshot the published URL. Before a publish, a correct API read
with an unchanged public page is expected, not `pending_cache` — report it as `staged`.

## 9. Rollback

Write the captured `before` object back through the same endpoint. Webflow's own site backups can
restore a whole project state, but that is a user action, not ours.

## 10. Check ids

No Webflow-specific ids yet. `M17.*` sitemap fixes are `not_applicable` in auto-sitemap projects.
A crawlable `<site>.webflow.io` is reported under the M2 indexability ids with the staging host in
`evidence.observed`.

## 11. Manual paths (EN / ES)

- Page SEO — EN: Pages panel → *page* → settings → SEO settings.
  ES: Panel de páginas → *página* → configuración → Ajustes SEO.
- Head code — EN: Project settings → Custom code → Head code.
  ES: Configuración del proyecto → Código personalizado → Head.
- Redirects — EN: Project settings → Publishing → 301 redirects.
  ES: Configuración del proyecto → Publicación → Redirecciones 301.
- Staging indexing — EN: Project settings → SEO → Indexing.
  ES: Configuración del proyecto → SEO → Indexación.

## 12. Honesty & UNVERIFIED

- Exact field names inside `openGraph` and the custom-code API's request shape: **UNVERIFIED** in
  this build. Confirm against Webflow's Data API docs before writing; until then the adapter reports
  `needs_api`.
- Whether a given project uses the auto sitemap or a manual one is a project setting — check it
  before calling a sitemap finding `not_applicable`.
