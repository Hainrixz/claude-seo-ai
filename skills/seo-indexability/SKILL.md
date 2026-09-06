---
name: seo-indexability
description: Audit a page's indexability and site health — canonical presence/validity (self vs cross-domain vs chain, canonical to redirect/404, and the genuinely lethal canonical+noindex pair where the canonical points elsewhere), robots meta and X-Robots-Tag noindex/nofollow, duplicate clusters, pagination signals, plus redirect chains/loops, 4xx/5xx and soft-404 internal links, mixed content, HTTP-to-HTTPS enforcement, user-agent content divergence (cloaking), orphan pages and click-depth — and generate self-referential canonical / noindex-removal fixes. Module M2 (covers M3 site health). Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-indexability (M2)

If a page can't be crawled, indexed, or canonicalized correctly, every other signal is wasted — this is the floor under the Search score. Schema-side context: `references/schema-tier1.md`. AI-bot access and snippet eligibility are M14 (`seo-ai-crawlers`); this module owns the classic-Search side, including the search-axis cloaking check.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`canonicals[]`, `robots_meta[]`) plus `status_chain`, `headers`, `robots_directives.effective`, and the crawl graph in `<run_dir>/crawl.json` for orphans, depth, duplicate clusters, and internal link status; `<run_dir>/profile.json` carries `environment.kind` (`production|preview|staging|local`); when the run included a user-agent diff, `<run_dir>/ua-diff.json` holds the per-UA response fields. Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`) plus `headers`, `status_chain`, and `robots_directives`:
1. **Canonical**: exactly one `<link rel="canonical">`; absolute HTTPS URL; classify self-referential vs cross-domain vs chained (canonical points to a URL that itself canonicalizes elsewhere). Flag a canonical that resolves to a redirect or a 4xx.
2. **Canonical + noindex — read it correctly.** `noindex` together with a **self-referential** canonical is *not* the lethal pair: it is a coherent, usually deliberate exclusion (thank-you pages, filtered views, staging). Report it as `M2.robots.noindex_present` and ask before touching it. The pair is lethal only when the canonical points **elsewhere**: the page tells Google "index that other URL instead" while also saying "don't index me", and the contradiction can propagate the `noindex` to the canonical target — that is `M2.canonical.noindex_conflict`.
3. **Robots directives**: `<meta name="robots">` and the `X-Robots-Tag` header for `noindex`/`nofollow`/`none`; reconcile header vs meta (the most restrictive applies; a header directive reaches non-HTML responses too). Record the **scope** — a directive emitted by a template or an edge rule is `template`/`site`, one written into a single document is `page`.
4. **Duplicate clusters**: near-identical title/H1/body across URLs with no consolidating canonical.
5. **Pagination**: paginated series signals (self-canonical per page; do not canonicalize page 2+ to page 1 — that delists deep items).
6. **Site health (covers M3)**: redirect chains (>1 hop) and loops, internal links returning 4xx/5xx, soft-404 (200 status on an empty/"not found" page), mixed content (HTTP subresources on an HTTPS page), HTTP-to-HTTPS enforcement, orphan pages (no internal inlinks inside the crawl frontier) and click-depth from the homepage.
7. **User-agent content divergence (cloaking, search axis)**: from `ua-diff.json`, compare what the origin serves a default browser UA against what it serves `googlebot` — status, title, H1, word count, canonical, robots directives, JSON-LD. A material difference is the search-axis cloaking signal (`M2.cloaking.ua_content_divergence`). The AI-bot side of the same diff (a challenged `GPTBot`, a refused spoofed `Googlebot`) belongs to M14.
8. **Environment**: read `profile.json.environment.kind`. On `preview`/`staging`/`local`, a `noindex` or a blanket robots block is the **expected** configuration, not a defect — record `M2.hosting.preview_environment_audited` so the report says which host was audited.

## Fixes
- **AUTO** (`fixable: auto`): inject a single self-referential absolute-HTTPS `<link rel="canonical">` when absent. Deterministic, additive, verifiable diff for `fix`.
- **PROPOSED** (`fixable: proposed`): removing a `noindex` the user has **confirmed** is unintended; duplicate-cluster consolidation (which URL should win is an editorial call); repointing or removing broken internal links.
- **ADVISORY** (`fixable: advisory`): redirect chains/loops, status codes, HTTP-to-HTTPS enforcement, mixed-content origins, and any edge rule behind a UA divergence — these live in server/CDN config, so the tool reports the exact change and writes nothing.
- Never fabricate which URL "should" win, whether a page is intentionally noindexed, or the intent behind a UA-conditional response — ask the user or leave a clearly-marked TODO placeholder.

## Verification
- `dom_assert`: parse the DOM for canonical/robots presence and value.
- `header_check`: read `X-Robots-Tag` and follow the redirect chain (status + `Location` per hop, loop detection).
- `link_graph`: internal link status, orphans, and click-depth from `<run_dir>/crawl.json`.
- `ua_diff`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ua-diff.mjs" --url <final_url> --ua default,googlebot` — the two responses side by side.
- When the required data tier is unavailable (no live fetch, no crawl graph for orphans and depth, no UA diff), status is `needs_api` — never a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`; axis `search`. Each carries `evidence.observed` quoting the page/header verbatim and a runnable `verification.reproduce`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).
- `M2.canonical.missing` — no `<link rel="canonical">` on an indexable page (`warn`, or `fail` when duplicates exist; severity 4, `fixable: auto`, `established`).
- `M2.canonical.noindex_conflict` — `noindex` on a URL whose canonical points to a **different** URL (`fail`, severity 4, `fixable: proposed`, `established`).
- `M2.robots.noindex_present` — `noindex` with a self-referential canonical (or no canonical): a coherent exclusion, reported not condemned (`warn`, severity 3, `fixable: proposed`, `established`).
- `M2.robots.unintended_noindex` — the same directive after the **user confirms** the URL is meant to be indexed (`fail`, severity **5** at site/template scope, **4** for a single page, `fixable: proposed`, `established`).
- `M2.redirect.chain` — an internal link traverses more than one hop before 200 (`warn`, severity 4, `fixable: advisory`, `established`).
- `M2.redirect.loop` — the chain never resolves; the URL is unreachable (`fail`, severity **5** when a template or site-wide rule causes it, **4** for a single URL, `fixable: advisory`, `established`).
- `M2.links.broken_internal` — internal links returning 4xx/5xx, with the source page and anchor (`warn`, severity 3, `fixable: proposed`, `established`).
- `M2.mixed_content` — HTTP subresources on an HTTPS page; active mixed content is blocked by browsers (`warn`, severity 3, `fixable: proposed`, `established`).
- `M2.https.not_enforced` — the HTTP URL does not redirect to HTTPS (`fail`, severity 4, `fixable: advisory`, `established`).
- `M2.cloaking.ua_content_divergence` — the origin serves materially different content to `googlebot` than to a default browser UA (`warn`, severity 4, `fixable: advisory`, confidence `directional`).
- `M2.hosting.preview_environment_audited` — the audited host is a preview/staging/local environment (`warn`, severity 1, `fixable: advisory`, `established`).

**Platform-conditional ids.** This module also emits 6 ids that fire only when `profile.json` names the platform (`shopify`, `wordpress`). They are indexed in `references/routing.md` § Platform-conditional finding ids and specified in `references/platforms/<id>.md` §10.

## Honesty
- A canonical is a *hint*, not a directive — Google may pick a different canonical; report it as strong consolidation, not a guarantee.
- **Self-canonical + `noindex` is not a bug.** Reporting every noindexed page as a lethal contradiction is a well-known false positive; this module only calls the pair lethal when the canonical points elsewhere, and it never removes a `noindex` without the user's confirmation.
- **Cloaking is an inference, not a measurement.** We send a `Googlebot` user-agent string; we are not verified Googlebot. Geo/A-B routing, personalization, consent walls, and bot-protection rules all produce divergence without any intent to deceive. Confirm with reverse DNS, server logs, or Search Console URL Inspection before calling it cloaking — the finding is `directional`.
- On a preview/staging/local host, `noindex` and robots blocks are correct configuration. The scorer, given `--environment preview|staging|local`, moves those severity-5 caps into `suppressed_caps[]` instead of gating the Search score at F; say which environment was audited rather than reporting a phantom emergency.
- `rel=next/prev` is no longer used by Google for pagination; don't recommend adding it as a ranking tactic — keep a self-canonical per page instead.
- Click-depth and orphan status correlate with crawl priority but are not a documented ranking factor — flag as `directional`, never as an established score cap. Orphan evidence must state the crawl frontier that produced it.
