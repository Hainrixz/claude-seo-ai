# drupal

**Status:** instructions-only · **Last verified:** 2026-09-05 · **Detector id:** `drupal` · **Layer:** platform

Drupal's SEO output depends almost entirely on which contributed modules are installed (Metatag,
Pathauto, Simple XML Sitemap, Redirect). Detect the modules before assuming anything.

## 1. Detection recap

Header `x-generator: Drupal …` (5), `x-drupal-cache` (5), `x-drupal-dynamic-cache` (4),
`/sites/default/files/` asset paths (4), generator meta (4).

## 2. Generated automatically — do not re-add

Core emits the canonical and shortlink for nodes, the aggregated CSS/JS under
`/sites/default/files/`, and the page cache headers. Titles, descriptions, Open Graph and JSON-LD
come from the **Metatag** module when it is installed; the sitemap from **Simple XML Sitemap**;
clean URLs from **Pathauto**. None of those are core.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Node, raw | `/node/<nid>` | Duplicate of the aliased path unless redirected |
| Node, aliased | `/<pathauto-pattern>` | — |
| Taxonomy term | `/taxonomy/term/<tid>` and its alias | Same duplicate pattern |
| Views pagination | `?page=1` | Fine; canonical must stay self-referential |
| Views exposed filters | `?field_x_value=` | Facet explosion |
| Language prefix | `/<langcode>/...` | Multilingual duplication without hreflang |
| Files | `/sites/default/files/...` | Should not be indexed as pages |

`/node/<nid>` remaining reachable alongside the alias is the classic Drupal duplicate.

## 4. Platform-owned — do not fix

Core cache headers, the aggregated asset paths, and the render pipeline. `not_applicable`, owner
Drupal. When Metatag owns the head, treat head injections the same way as a WordPress SEO plugin:
`not_applicable` naming Metatag.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Node meta title / description | Metatag fields on the node form | `instructions` | ADVISORY | none |
| Global meta defaults | Configuration → Search and metadata → Metatag | `instructions` | ADVISORY | none |
| robots.txt | the physical `robots.txt` at the docroot (repo) | `local-files` | AUTO | none |
| Sitemap | Configuration → Search and metadata → Simple XML Sitemap | `instructions` | ADVISORY | none |
| Redirect | the Redirect module's URL redirects UI | `instructions` | ADVISORY | none |
| Theme head (repo available) | `<theme>/templates/html.html.twig` | `local-files` | PROPOSED | none |

## 6. Write method & credentials

None implemented. Drupal's JSON:API can write nodes, but the field names for Metatag values are
site-specific and **UNVERIFIED**, so nothing is written. `write_targets` is `instructions` plus
`local-files` when the project is checked out.

## 7. Preview & publish

Drupal's own revision/publish flow. Config changes take effect after a cache rebuild
(`drush cr`), which is the operator's action.

## 8. Verification

Re-snapshot after the user confirms the cache rebuild. `x-drupal-cache: HIT` with an old head is
`pending_cache`.

## 9. Rollback

The user reverses the field, or reverts the node revision. Repo edits roll back from the
local-files backup.

## 10. Check ids

No Drupal-specific ids yet. `/node/<nid>` duplicates are reported under the M2 canonical ids;
language prefixes under M20 when multilingual is active.

## 11. Manual paths (EN / ES)

- Node metadata — EN: Content → *node* → Edit → Metatags.
  ES: Contenido → *nodo* → Editar → Metaetiquetas.
- Global defaults — EN: Configuration → Search and metadata → Metatag.
  ES: Configuración → Búsqueda y metadatos → Metatag.
- Sitemap — EN: Configuration → Search and metadata → Simple XML Sitemap.
  ES: Configuración → Búsqueda y metadatos → Simple XML Sitemap.
- Redirects — EN: Configuration → Search and metadata → URL redirects.
  ES: Configuración → Búsqueda y metadatos → Redirecciones de URL.

## 12. Honesty & UNVERIFIED

- Which SEO modules are installed cannot be read from the HTML alone. Say "Metatag not confirmed"
  rather than assuming it, and route the finding to `manual_review` when it changes the fix.
- JSON:API field names for Metatag: **UNVERIFIED**. Do not write.
