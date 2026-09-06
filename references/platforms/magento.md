# magento

**Status:** instructions-only · **Last verified:** 2026-09-05 · **Detector id:** `magento` · **Layer:** platform

Adobe Commerce / Magento Open Source. A large, self-hosted platform whose SEO surface is spread
across admin config, per-product fields and theme templates. No write path is implemented here.

## 1. Detection recap

`x-magento-*` response headers (5), `/static/version<digits>/frontend/` asset paths (4),
`data-mage-init` / `Magento_*` markup (3), the `form_key` cookie (2 — generic name, corroborating
only). Sets the `ecommerce` vertical hint.

## 2. Generated automatically — do not re-add

`sitemap.xml` when the scheduled sitemap job is enabled; `robots.txt` from the design config;
canonical tags when "Use Canonical Link Meta Tag" is on for products and categories; layered
navigation URLs; the static-content version prefix.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Product | `/<url-key>.html` | — |
| Category-scoped product | `/<category>/<url-key>.html` | Duplicate unless the canonical setting is on |
| Layered navigation | `?color=`, `?price=`, `?product_list_order=` | Facet explosion |
| Pagination / limit | `?p=2`, `?product_list_limit=` | Duplicate variants |
| Store views | `/<store-code>/...` | Multi-store duplication; needs hreflang |
| Search | `/catalogsearch/result/?q=` | Thin, crawlable |
| SID | `?SID=` | Session leakage into URLs (legacy) |

## 4. Platform-owned — do not fix

The static-content version prefix, the checkout, the price/stock blocks, and the generated layout
XML. `not_applicable`, owner Magento.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Product meta title / description / url key | Admin → Catalog → Products → *product* → Search Engine Optimization | `instructions` | ADVISORY | none |
| Canonical for products & categories | Stores → Configuration → Catalog → SEO → Use Canonical Link Meta Tag | `instructions` | ADVISORY | none |
| robots.txt | Content → Design → Configuration → *store view* → Search Engine Robots | `instructions` | ADVISORY | none |
| Head snippet (JSON-LD) | Content → Design → Configuration → HTML Head → Scripts and Style Sheets | `instructions` | ADVISORY | none |
| Theme head (repo available) | `app/design/frontend/<Vendor>/<theme>/Magento_Theme/layout/default_head_blocks.xml` | `local-files` | PROPOSED | none |
| Redirect | Marketing → URL Rewrites | `instructions` | ADVISORY | none |

## 6. Write method & credentials

None implemented. Magento's REST API can write product attributes, but the auth model
(integration tokens, ACL roles) and the attribute names for SEO fields are **UNVERIFIED** here, so
nothing is written. `write_targets` contains `instructions` (plus `local-files` when the project is
checked out).

## 7. Preview & publish

Admin changes are live once the relevant cache type is refreshed. Theme file changes need
`setup:static-content:deploy` and a cache flush — both are the operator's job, never ours.

## 8. Verification

Re-snapshot after the user confirms the cache flush. A Magento page served from the full-page cache
will show the old head for a long time: `pending_cache` is the normal first answer.

## 9. Rollback

The user reverses the same admin field. For repo edits, the local-files backup restores the file.

## 10. Check ids

No Magento-specific ids yet. Category-scoped duplicates, facet URLs and store-view duplication are
reported under the generic M2 / M1 / M20 ids with the surface in `evidence.observed`.

## 11. Manual paths (EN / ES)

- Product SEO — EN: Catalog → Products → *product* → Search Engine Optimization.
  ES: Catálogo → Productos → *producto* → Optimización para motores de búsqueda.
- Canonical setting — EN: Stores → Configuration → Catalog → Catalog → SEO.
  ES: Tiendas → Configuración → Catálogo → Catálogo → SEO.
- robots.txt — EN: Content → Design → Configuration → *store view* → Search Engine Robots.
  ES: Contenido → Diseño → Configuración → *vista de tienda* → Robots de motores de búsqueda.
- Redirects — EN: Marketing → SEO & Search → URL Rewrites.
  ES: Marketing → SEO y búsqueda → Reescrituras de URL.

## 12. Honesty & UNVERIFIED

- Every REST endpoint and attribute code for SEO fields: **UNVERIFIED**. Do not write.
- Admin menu labels differ between Adobe Commerce and Open Source and between versions; describe the
  setting as well as its path.
