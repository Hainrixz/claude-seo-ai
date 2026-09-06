# woocommerce

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `woocommerce` · **Layer:** plugin

WooCommerce is a WordPress plugin, so `wordpress.md` governs the head, the write method and the
credentials. This card covers only what the shop layer adds. Read both.

## 1. Detection recap

`/wp-json/` exposing `wc/v3` or `wc/store/v1` (5), the `woocommerce_cart_hash` cookie (4),
`/plugins/woocommerce/` asset paths (4), `woocommerce`/`woocommerce-page` body classes (3), and with
`--path` the plugin directory itself (5). Detected in the **plugin layer**, so it never competes with
the `wordpress` platform verdict. Sets the `ecommerce` vertical hint.

## 2. Generated automatically — do not re-add

Cart, checkout and account pages (with `noindex` on cart/checkout by default); product and category
archive pagination; the `?add-to-cart=` action URLs; product gallery markup. Product JSON-LD comes
from the SEO plugin, not from WooCommerce, unless a theme adds its own.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Product | `/product/<slug>/` | — |
| Product category | `/product-category/<c>/` | Thin when nearly empty |
| Product tag | `/product-tag/<t>/` | Usually thin |
| Layered nav filters | `?filter_<attr>=`, `?min_price=`, `?orderby=` | Facet explosion |
| Add to cart | `?add-to-cart=<id>` | Crawlable action URL |
| Cart / checkout / account | `/cart/`, `/checkout/`, `/my-account/` | Must stay out of the index |
| Variations | `?attribute_pa_*=` | Duplicate of the parent product |

## 4. Platform-owned — do not fix

Cart/checkout/account templates and their noindex; price and stock markup; the `wc/store` REST
responses; coupon and session cookies. Emit as `not_applicable` naming WooCommerce.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Product title / short description / slug | `POST /wp/v2/product/<id>` (public product post type) | `wordpress-rest` | PROPOSED | **live** |
| SEO title & description | the SEO plugin's fields — see `wordpress.md` §5 | `wordpress-rest` / `wordpress-wpcli` | PROPOSED | **live** |
| Product image alt | `POST /wp/v2/media/<id>` | `wordpress-rest` | PROPOSED | **live** |
| Facet / filter crawl control | robots.txt or the SEO plugin's crawl settings | — | ADVISORY | none |
| Thin category/tag archives | merge or noindex through the SEO plugin | — | ADVISORY | none |

Product **prices, stock and variations are never written by this plugin.** They are commerce data.

## 6. Write method & credentials

Same as `wordpress.md` §6 (`WP_URL`, `WP_USER`, `WP_APP_PASSWORD`, or `WP_SSH` for WP-CLI). The WooCommerce REST API (`wc/v3`) needs its own consumer key/secret and
is **not** used here: it writes commerce data, which is out of scope.

## 7. Preview & publish

None. Writes are live. See `wordpress.md` §7.

## 8. Verification

Re-fetch the product over REST and snapshot the public product URL. Shops usually run aggressive
page caching plus a CDN: `pending_cache` is the honest answer until the public HTML agrees.

## 9. Rollback

Restore `before` through the same REST field. Nothing in this card touches orders, prices or stock,
so a rollback is always a text restore.

## 10. Check ids

Adds the ecommerce module M18 (Product/Offer/Review completeness, faceted navigation, feed↔page
consistency) through the `ecommerce` vertical hint, plus every id in `wordpress.md` §10.
No WooCommerce-specific ids exist yet; facet findings are emitted as the generic
`M1.*` crawl-control ids with the filter parameters in `evidence.observed`.

## 11. Manual paths (EN / ES)

- Product SEO fields — EN: Products → *product* → the SEO plugin box → Edit snippet.
  ES: Productos → *producto* → el cuadro del plugin SEO → Editar fragmento.
- Category description — EN: Products → Categories → *category* → Description.
  ES: Productos → Categorías → *categoría* → Descripción.
- Cart/checkout indexing — EN: leave it alone; it is noindexed on purpose.
  ES: déjalo como está; lleva noindex a propósito.

## 12. Honesty & UNVERIFIED

- The `product` post type being exposed at `/wp/v2/product` depends on the store's configuration:
  **UNVERIFIED** for a given install. Probe `/wp-json/wp/v2/types` before planning a REST write.
- Layered-nav parameter names vary by attribute and by theme; enumerate them from the crawl instead
  of assuming `?filter_*`.
