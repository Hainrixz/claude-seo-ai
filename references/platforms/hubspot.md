# hubspot

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `hubspot` · **Layer:** platform

CMS Hub pages with a REST API for page metadata and a draft/publish model that is genuinely useful.

## 1. Detection recap

Asset host `js.hs-scripts.com` (4), `/_hcms/` paths (3), `/hs-fs/hubfs/` asset paths (3), cookies
`__hstc` / `hubspotutk` (4), generator `HubSpot` (4).

## 2. Generated automatically — do not re-add

`sitemap.xml`; `robots.txt` from the domain settings; canonical tags (including the cross-domain
canonical for multi-domain portals); the tracking script; CTA and form markup; language variant
`hreflang` for multi-language page groups.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Site page | `/<slug>` | — |
| Blog post | `/<blog-slug>/<post-slug>` | — |
| Blog listing / tag | `/<blog>/tag/<t>` | Thin archives |
| CTA redirect | `/_hcms/cta/redirect/...` | Crawlable action URL |
| Preview | `?hs_preview=` | Must not be linked or indexed |
| Multi-domain | the same content on two connected domains | Real duplication; check the canonical |

## 4. Platform-owned — do not fix

`sitemap.xml`, `robots.txt` (domain settings), the tracking script, CTA/form markup, and the
`hs_preview` mechanism. `not_applicable`, owner HubSpot.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Page title & meta description | `PATCH /cms/v3/pages/site-pages/{id}` (`htmlTitle`, `metaDescription`) | `page-api` | PROPOSED | staged, then **live** on push |
| Head HTML (JSON-LD) | the page's `headHtml` field, or Settings → Website → Pages → head HTML | `page-api` / `instructions` | PROPOSED | staged |
| Redirect | Settings → Website → Domains & URLs → URL redirects | `instructions` | ADVISORY | none |
| Image alt | the module's alt field in the page editor | `instructions` | ADVISORY | none |
| Blog post meta | the blog-posts endpoint (same shape) | `page-api` | PROPOSED | staged |

## 6. Write method & credentials

HubSpot CMS API v3. Credential key name: `HUBSPOT_TOKEN` (a private app token with CMS scopes;
`HUBSPOT_ACCESS_TOKEN` still resolves). Page ids come from the pages listing, not from the URL.

## 7. Preview & publish

HubSpot's draft model is a real staging surface: a `PATCH` updates the **draft** of a page, and a
separate push-live step publishes it. That two-step is the confirmation gate — a change is `staged`
until pushed, and the report must say so.

## 8. Verification

Re-read the page (draft and live variants) and snapshot the public URL after the push. Before the
push, an unchanged public page is `staged`, not a failure.

## 9. Rollback

`PATCH` the `before` values back and push again, or discard the draft before it is pushed. HubSpot's
own page revision history is the user's fallback.

## 10. Check ids

No HubSpot-specific ids yet. `M17.*` and `M1.*` file-level fixes are `not_applicable`.
Multi-domain duplication is reported under the M2 canonical ids.

## 11. Manual paths (EN / ES)

- Page SEO — EN: Marketing → Website → Website Pages → *page* → Settings → Page title / Meta description.
  ES: Marketing → Sitio web → Páginas → *página* → Configuración → Título / Meta descripción.
- Head HTML — EN: page Settings → Advanced options → Head HTML.
  ES: Configuración de la página → Opciones avanzadas → HTML del head.
- Redirects — EN: Settings → Website → Domains & URLs → URL Redirects.
  ES: Configuración → Sitio web → Dominios y URLs → Redirecciones de URL.

## 12. Honesty & UNVERIFIED

- The exact draft→live push endpoint name and the `headHtml` field name are **UNVERIFIED** in this
  build; until confirmed the adapter reports `needs_api` for anything beyond `htmlTitle` and
  `metaDescription`.
- Blog posts live on a different endpoint from site pages; do not assume one payload works for both.
