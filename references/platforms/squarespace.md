# squarespace

**Status:** instructions-only · **Last verified:** 2026-09-05 · **Detector id:** `squarespace` · **Layer:** platform

No SEO write API. Every fix is a click-path or a Code Injection snippet the user pastes. The audit is
still fully useful; the writer never is.

## 1. Detection recap

Asset host `static1.squarespace.com` (4), the `Static.SQUARESPACE_CONTEXT` global (4), generator
`Squarespace` (4), `Server: Squarespace` (4, UNVERIFIED). Image URLs on
`images.squarespace-cdn.com` corroborate but are not scored.

## 2. Generated automatically — do not re-add

`sitemap.xml`; the default `robots.txt`; canonical tags; the head's title and description from the
page's SEO panel; Open Graph from the page's social image settings; AMP-ish responsive image sets.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `/<page-slug>` | — |
| Blog post | `/<blog-slug>/<post-slug>` | Changing the blog slug moves every post |
| Collection item | `/<collection>/<item>` | — |
| Tag / category | `?tag=`, `?category=` | Thin, parameterized archives |
| Format variants | `?format=json`, `?format=json-pretty` | Crawlable JSON duplicates of every page |

`?format=json` is the surface most Squarespace audits miss: it returns the page's data as JSON at a
crawlable URL.

## 4. Platform-owned — do not fix

`sitemap.xml`, `robots.txt`, the URL structure, the image CDN, and the order of head tags. There is
no file to edit — all of it is `not_applicable`, owner Squarespace.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Page title & description | Page settings → SEO | `instructions` | ADVISORY | none |
| JSON-LD, extra meta | Settings → Advanced → Code Injection (Header) | `instructions` | ADVISORY | none |
| Redirect | Settings → Advanced → URL Mappings (`/old -> /new 301`) | `instructions` | ADVISORY | none |
| Image alt text | Image block → the caption/alt field | `instructions` | ADVISORY | none |

Every row is a written instruction with the exact panel path and the exact text to paste. Nothing is
applied automatically, ever.

## 6. Write method & credentials

None. No credentials are requested, because there is nothing to authenticate to. The profile's
`write_targets` contains only `instructions`.

## 7. Preview & publish

Squarespace's own draft/publish flow, driven by the user. Code Injection changes are live on save.

## 8. Verification

Ask the user to say when they have saved, then re-snapshot the URL and re-run the module scripts.
Until the re-snapshot agrees, the finding stays open — never mark an instruction "fixed" on trust.

## 9. Rollback

The user reverses the same click-path. Tell them what the previous value was; that is the whole
rollback plan, so capture `before` in the ticket.

## 10. Check ids

No Squarespace-specific ids. `M17.*` sitemap fixes and `M1.*` robots fixes are `not_applicable`
(owner Squarespace). Add `?format=json` duplicates to the M2 evidence when a crawl shows them.

## 11. Manual paths (EN / ES)

- Page SEO — EN: Pages → *page* → gear icon → SEO. ES: Páginas → *página* → icono de ajustes → SEO.
- Code Injection — EN: Settings → Advanced → Code Injection → Header.
  ES: Configuración → Avanzado → Inyección de código → Encabezado.
- Redirects — EN: Settings → Advanced → URL Mappings, one rule per line: `/old -> /new 301`.
  ES: Configuración → Avanzado → Asignaciones de URL, una regla por línea: `/antigua -> /nueva 301`.

## 12. Honesty & UNVERIFIED

- The `Server: Squarespace` header: **UNVERIFIED**; detection does not depend on it alone.
- Squarespace has a commerce API, but no SEO-tag write API we can cite. Claiming otherwise would
  invent a capability — the status stays `instructions-only`.
