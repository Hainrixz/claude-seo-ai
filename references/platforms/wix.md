# wix

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `wix` · **Layer:** platform

A closed builder with a real SEO API for item-level tags. Everything else is a click-path.

## 1. Detection recap

Header `x-wix-request-id` (5), the `wixBiSession` global (4), asset hosts `static.wixstatic.com` and
`parastorage.com` (4 each), generator `Wix.com Website Builder` (4).

## 2. Generated automatically — do not re-add

`sitemap.xml` (per site, including collection pages); the default `robots.txt`; canonical tags;
hreflang for Multilingual sites; the Open Graph block Wix renders from the page's SEO panel; the
image CDN's responsive variants.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Static page | `/<page-slug>` | — |
| Dynamic (CMS) page | `/<prefix>/<item-slug>` | Duplicates when two prefixes point at one collection |
| Blog post | `/post/<slug>` | — |
| Store product | `/product-page/<slug>` | — |
| Editor preview params | `?lightbox=`, `?_gl=` | Should not be linked internally |

## 4. Platform-owned — do not fix

`sitemap.xml`, the `robots.txt` defaults, the URL prefix scheme, the image CDN, and the head order.
Multilingual alternates are owned by the Wix Multilingual app. Emit these as `not_applicable`.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Page/item title, description, OG tags | Item SEO Tags API (item type + id) | `page-api` | PROPOSED | **live** |
| Custom head snippet (JSON-LD) | Settings → Custom Code | — | ADVISORY | none |
| URL slug change + redirect | Editor / URL redirect manager | — | ADVISORY | none |
| robots.txt | SEO Tools → Robots.txt editor | — | ADVISORY | none |

## 6. Write method & credentials

Wix Item SEO Tags API, addressed by item type + item id. Credential key names: `WIX_API_KEY`,
`WIX_SITE_ID`. **Tags replace in full**: read the current tag set, merge, write the whole set back —
a partial payload deletes the tags it omits. Primary language only.

## 7. Preview & publish

Static pages need `publish: true` for the change to reach the live site; without it the change sits
in the editor's unpublished state. Dynamic-page items apply immediately. Both are `live_impact:
live` from the user's point of view — confirm before either.

## 8. Verification

Re-read the item's tags through the API **and** snapshot the public URL. Wix serves through its own
CDN; a stale public head with a correct API read is `pending_cache`.

## 9. Rollback

Write the captured full tag set back. Because the API replaces in full, the `before` snapshot is the
rollback — capture it or do not write.

## 10. Check ids

No Wix-specific ids yet. Every M17 sitemap fix and every M1 robots fix is `not_applicable` with Wix
as the owner. M7/M8 head findings stay, routed to the `page-api` adapter.

## 11. Manual paths (EN / ES)

- Page SEO — EN: Site menu → *page* → SEO Basics. ES: Menú del sitio → *página* → Conceptos básicos de SEO.
- robots.txt — EN: SEO tools → Robots.txt editor. ES: Herramientas SEO → Editor de robots.txt.
- Redirects — EN: SEO tools → URL redirect manager. ES: Herramientas SEO → Administrador de redirecciones.
- Custom head code — EN: Settings → Custom code → Head. ES: Configuración → Código personalizado → Head.

## 12. Honesty & UNVERIFIED

- The exact endpoint path, request body and publish semantics of the Item SEO Tags API:
  **UNVERIFIED** in this build. The adapter reports `needs_api` until confirmed against Wix's docs.
- Secondary-language tags are not writable through this route as far as we know — treat multilingual
  head fixes as ADVISORY.
