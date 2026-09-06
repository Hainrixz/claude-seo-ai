# framer

**Status:** instructions-only · **Last verified:** 2026-09-05 · **Detector id:** `framer` · **Layer:** platform

A design-first builder with no SEO write API. Audit fully; write nothing.

## 1. Detection recap

Asset host `framerusercontent.com` (4), generator `Framer` (4), `data-framer-name` /
`__framer_events` markers (2).

## 2. Generated automatically — do not re-add

`sitemap.xml` and `robots.txt`; canonical tags; the title and description from each page's SEO
panel; Open Graph from the page's social image; the image CDN's responsive variants; the client-side
router's history handling.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Page | `/<slug>` | — |
| CMS collection item | `/<collection>/<slug>` | Collection slug changes move every item |
| Locale | `/<locale>/<slug>` | Localized sites add a prefix |
| Preview | `<project>.framer.website` | Indexable duplicate if the custom domain is also live |

Framer renders client-side for parts of the page: check the rendered DOM, not just the raw HTML,
before reporting missing content (`--prefer rendered` on the snapshot).

## 4. Platform-owned — do not fix

`sitemap.xml`, `robots.txt`, the head order, the CDN, and the generated class names. All
`not_applicable`, owner Framer.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Page title & description | Page settings → SEO | `instructions` | ADVISORY | none |
| JSON-LD / custom head | Site settings → General → Custom code (head) | `instructions` | ADVISORY | none |
| Redirect | Site settings → Redirects (`/old` → `/new`) | `instructions` | ADVISORY | none |
| Image alt | Layer's accessibility/alt field | `instructions` | ADVISORY | none |

## 6. Write method & credentials

None. No credential key names are requested; `write_targets` contains only `instructions`.

## 7. Preview & publish

Framer's own preview/publish flow, driven by the user. Nothing reaches the live site until they
press Publish.

## 8. Verification

Re-snapshot after the user confirms they published, then re-run the scripts. Prefer the rendered DOM
for content checks.

## 9. Rollback

The user reverses the same panel change. Record the `before` value in the ticket so they can.

## 10. Check ids

No Framer-specific ids. `M17.*` and `M1.*` file-level fixes are `not_applicable` (owner Framer).
M4 rendering findings matter more here than on server-rendered platforms.

## 11. Manual paths (EN / ES)

- Page SEO — EN: Pages → *page* → settings → SEO. ES: Páginas → *página* → ajustes → SEO.
- Custom head code — EN: Site settings → General → Custom code → Start of head.
  ES: Ajustes del sitio → General → Código personalizado → Inicio de head.
- Redirects — EN: Site settings → Redirects. ES: Ajustes del sitio → Redirecciones.

## 12. Honesty & UNVERIFIED

- No public SEO write API is documented. Any claim that Framer pages can be updated programmatically
  would be invented — the status stays `instructions-only`.
- Panel names move between Framer releases; treat §11 paths as a guide and describe the setting, not
  only its location.
