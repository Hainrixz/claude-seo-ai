# bigcommerce

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `bigcommerce` · **Layer:** platform

Catalog-driven storefront (Stencil themes) with a catalog API that owns the per-product SEO fields.

## 1. Detection recap

Asset host `cdn11.bigcommerce.com` (4), cookie `SHOP_SESSION_TOKEN` (4, UNVERIFIED), `/stencil/`
paths (2), `stencil-utils` bundle marker (2, UNVERIFIED). Sets the `ecommerce` vertical hint.

## 2. Generated automatically — do not re-add

`sitemap.xml` (per channel); `robots.txt` from the store settings; canonical tags for products
reachable through several category paths; the product image CDN variants; faceted-search URLs.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Product | `/<product-url>/` | — |
| Category | `/<category>/` | — |
| Category-scoped product | `/<category>/<product>/` | Duplicate; canonical must point at the product URL |
| Faceted search | `?sort=`, `?price_min=`, brand/attribute facets | Facet explosion |
| Search | `/search.php?search_query=` | Thin, crawlable |
| Channel variants | the same catalog on several channels | Cross-channel duplication |

## 4. Platform-owned — do not fix

`sitemap.xml`, `robots.txt` (store settings), the checkout, the price/stock markup, and the CDN.
`not_applicable`, owner BigCommerce.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Product `page_title` (≤ 70) and `meta_description` (≤ 160) | Catalog API product update | `page-api` | PROPOSED | **live** |
| Category page title / description | Catalog API category update | `page-api` | PROPOSED | **live** |
| Head snippet (JSON-LD) | Storefront → Script manager, or the Stencil theme's `base.html` | `instructions` | ADVISORY | none |
| Theme head (repo available) | Stencil `templates/layout/base.html` | `local-files` | AUTO | none |
| Redirect | Storefront → 301 redirects | `instructions` | ADVISORY | none |

The length limits are the platform's own field limits, not an SEO opinion: a longer value is
rejected, so the fix planner must truncate at the word boundary and say it did.

## 6. Write method & credentials

BigCommerce Catalog API (store-scoped). Credential key names: `BIGCOMMERCE_STORE_HASH`,
`BIGCOMMERCE_TOKEN` (`BIGCOMMERCE_ACCESS_TOKEN` still resolves). Writes are **channel-aware**: confirm which channel the audited
storefront belongs to before writing, or a change can land on a channel nobody is looking at.

## 7. Preview & publish

No draft state for catalog fields — they are live on write. Stencil theme changes go through the
theme upload/apply flow, which is a user action.

## 8. Verification

Re-read the product over the API and snapshot the public product URL. BigCommerce caches
aggressively at the edge: a correct API read with a stale page is `pending_cache`.

## 9. Rollback

Write the `before` values back through the same endpoint.

## 10. Check ids

No BigCommerce-specific ids yet. Category-scoped product duplicates are reported under the M2
canonical ids; facet URLs under the M1 crawl-control ids. Adds M18 through the `ecommerce` hint.

## 11. Manual paths (EN / ES)

- Product SEO — EN: Products → *product* → SEO → Page title / Meta description.
  ES: Productos → *producto* → SEO → Título de página / Meta descripción.
- Redirects — EN: Storefront → 301 Redirects. ES: Escaparate → Redirecciones 301.
- robots.txt — EN: Settings → Store setup → Search engine robots.
  ES: Configuración → Configuración de la tienda → Robots de motores de búsqueda.

## 12. Honesty & UNVERIFIED

- The `SHOP_SESSION_TOKEN` cookie name and the `stencil-utils` marker are observed, not documented:
  **UNVERIFIED**. Detection does not rest on either alone.
- The exact catalog endpoint paths and the channel-assignment payload are **UNVERIFIED** in this
  build; the adapter reports `needs_api` until confirmed.
