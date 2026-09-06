# Platform knowledge cards — template and rules

One card per detected id (`references/platforms/<id>.md`). `scripts/detect-platform.mjs` names the
cards it wants in `profile.cards[]`; the orchestrator passes those paths to every subagent as
`platform_cards`. A card is the only place a subagent may learn what the platform generates by
itself, what it refuses to let anyone change, and how a fix would actually be written.

Cards are **read by agents**, not by users. Keep them short, imperative and specific. A sentence
that does not change what an auditor emits or what a writer does has no business in a card.

## Header (required, immediately under the H1)

```
**Status:** stable | beta | instructions-only · **Last verified:** YYYY-MM-DD · **Detector id:** `<id>` · **Layer:** platform | framework | plugin
```

- `stable` — the write path has been exercised end to end and has a rollback.
- `beta` — the write path is implemented but thinly exercised; keep changes PROPOSED.
- `instructions-only` — no write API exists; every fix is a click-path for a human.
- `Last verified` is the date the vendor facts in the card were last checked against vendor
  documentation. An old date is not a bug; a wrong date is.

## The 12 sections (all required, in this order, `## N. Title`)

| # | Title | What belongs in it |
|---|---|---|
| 1 | Detection recap | The signals the detector scores, and what a low-confidence verdict means here. |
| 2 | Generated automatically — do not re-add | Everything the platform already emits. Re-adding it is the single most common way to make a site worse. |
| 3 | URL surfaces & duplicate risks | The URL shapes this platform invents, and which ones collide. |
| 4 | Platform-owned — do not fix | Things no adapter may touch, and where a human changes them instead. A finding about these is `not_applicable` with the owner in `evidence.observed`. |
| 5 | Fix map | `class → location → adapter → AUTO/PROPOSED/ADVISORY → live_impact`. One table row per fix class. |
| 6 | Write method & credentials | Endpoint/CLI, auth, credential **key names** (never values), scopes. |
| 7 | Preview & publish | Whether a staged version exists, and the confirmation gate before anything goes live. |
| 8 | Verification | How to prove a change landed; when to answer `pending_cache` instead of `pass`. |
| 9 | Rollback | Exactly what is restored, and what cannot be. |
| 10 | Check ids | Platform-conditional ids this card unlocks, plus the ids it suppresses as `not_applicable`. |
| 11 | Manual paths (EN / ES) | The click-path a human follows, in both languages, for everything ADVISORY. |
| 12 | Honesty & UNVERIFIED | Every claim in the card that is not backed by vendor documentation, marked `UNVERIFIED`. |

## Writing rules

- **Never invent an API.** No endpoint, field name, scope, or CLI flag goes in a card unless it is
  documented by the vendor. If it is needed but unconfirmed, write it and label it `UNVERIFIED` in
  §12 — the adapter will treat it as `needs_api` rather than call it.
- **`live_impact` is a promise.** `none` = local/staged only, `staged` = a preview surface the
  public cannot see, `live` = the public site changes on apply. Anything `live` is PROPOSED at best,
  and needs a second confirmation.
- **AUTO is reserved** for deterministic text edits with an exact anchor (`html-head`,
  `front-matter`, `config-file`, `liquid`). Every JSX/TS-object strategy is PROPOSED.
- **Suppressions are findings.** When the platform owns something a module would normally flag,
  emit the id as `not_applicable` naming the owner — never drop it silently, and never let it pass.
- **Cookies, tokens and store names are key names in a card, never values.**

## Cards in this directory

Platform layer: `shopify` · `wordpress` · `wix` · `squarespace` · `webflow` · `framer` · `ghost` ·
`hubspot` · `bigcommerce` · `magento` · `drupal` · `payload`
Plugin layer: `woocommerce`
Framework layer: `nextjs` · `nuxt` · `astro` · `sveltekit` · `react-router` · `gatsby` · `hugo` ·
`jekyll` · `eleventy` · `docusaurus` · `static`

A site usually gets two or three cards at once (platform + framework + plugin). When they disagree,
the **head owner wins**: `profile.capabilities.head_owner` says who actually renders the tags.
