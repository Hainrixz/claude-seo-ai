# payload

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `payload` · **Layer:** platform

Payload 3 is a TypeScript CMS that runs **inside** a Next.js app. The framework card governs the
head; this card governs the content fields behind it.

## 1. Detection recap

Repo-only: `payload.config.ts` / `src/payload.config.ts` (5), the `payload` dependency (4),
`@payloadcms/plugin-seo` (3). There is no reliable runtime marker — a Payload site looks exactly
like the Next.js app it is, so **without `--path` this platform is not detected**, and that is
correct rather than a gap.

## 2. Generated automatically — do not re-add

Nothing at the HTTP level: whatever the Next.js app renders is what exists. Read `nextjs.md` §2.
`@payloadcms/plugin-seo` adds SEO fields to collections and, in most setups, a preview of the
snippet — but only the app's own components turn those fields into tags.

## 3. URL surfaces & duplicate risks

Payload itself defines no public URL shapes; the Next.js route tree does (see `nextjs.md` §3). The
one Payload-specific surface is the admin panel, usually at `/admin`, which must not be indexed, and
the REST/GraphQL endpoints under `/api`.

## 4. Platform-owned — do not fix

The admin panel markup, the `/api` responses, and the database. `not_applicable`, owner Payload.
The head belongs to the Next.js app: do not write head tags through Payload.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Head tags, JSON-LD, canonical | the Next.js route files — see `nextjs.md` §5 | `local-files` | AUTO/PROPOSED | none |
| SEO field values on a document | `PATCH /api/<collection>/<id>` with the plugin's SEO field names | `page-api` | PROPOSED | **live** |
| `/admin` indexability | the app's `robots.ts` / `robots.txt` | `local-files` | AUTO | none |
| Collection slug / URL field | the document's own fields | `page-api` | PROPOSED | **live** |

## 6. Write method & credentials

Payload REST API with an API key or a logged-in user token. Credential key names: `PAYLOAD_URL`,
`PAYLOAD_API_KEY`. The SEO plugin's field names (`meta.title`, `meta.description`, …) are
**UNVERIFIED** (§12) — read a document first and write only field paths you have seen.

## 7. Preview & publish

Collections with drafts enabled have a real draft state (`?draft=true` reads); without drafts, a
write is live. Check the collection's `versions.drafts` setting before promising a staged change.

## 8. Verification

Re-read the document over the API and snapshot the public URL. A statically generated Next.js route
will not change until it revalidates — that is `pending_cache`, and the revalidation window belongs
in the note.

## 9. Rollback

Write the captured `before` field values back. With drafts enabled, Payload's own version history is
the user's fallback.

## 10. Check ids

No Payload-specific ids. Everything in `nextjs.md` §10 applies, plus an M2 finding when `/admin` is
indexable.

## 11. Manual paths (EN / ES)

- Document SEO fields — EN: Admin → *collection* → *document* → SEO tab.
  ES: Admin → *colección* → *documento* → pestaña SEO.
- Admin indexing — EN: add `/admin` to the app's robots rules. ES: añade `/admin` a las reglas robots.

## 12. Honesty & UNVERIFIED

- `@payloadcms/plugin-seo` field names and the exact REST payload shape: **UNVERIFIED**. Read before
  writing; report `needs_api` rather than guessing a field path.
- Payload is detected from the repo only. If the audit is URL-only, the profile will say `nextjs`
  and nothing else — that is the honest answer, not a miss.
