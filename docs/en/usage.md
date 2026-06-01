# Usage

A practical guide to running `claude-seo-ai` — installing it, running the four
commands, reading the dual-score report, and applying fixes safely.

## Install

**As a Claude Code plugin (recommended):**

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

**Cross-agent (Cursor, Codex, Gemini CLI, Windsurf…) via Vercel Skills:**

```
npx skills add Hainrixz/claude-seo-ai
```

> Published at `github.com/Hainrixz/claude-seo-ai`. The plugin works fully
> offline (Tier 0) — no keys required. Optional JS rendering and Core Web Vitals
> field data live in Tier 1+ (see Data tiers in the README).

## The four commands

`claude-seo-ai` ships **four command skills** — `audit`, `geo`, `score`, and
`fix`. There is no root router and no subcommand parsing: each is its own
top-level command. Because Claude Code plugin skills are always namespaced, the
plugin name (`claude-seo-ai`) is the namespace, so every command is invoked as
`/claude-seo-ai:<command>`. The `target` is either a URL (`https://…`) or a
local path (a web project or built HTML).

```
/claude-seo-ai:audit <url|path> [--render auto|static|js] [--vertical auto|saas|blog-publisher|local-business|ecommerce|docs]
/claude-seo-ai:geo   <url|path>
/claude-seo-ai:score
/claude-seo-ai:fix   <url|path> [--category schema|meta|robots|sitemap|hreflang|alt|canonical|social|llms] [--dry-run]
```

| Command | What it does | Writes files? |
|---|---|---|
| `audit` | Full read-only audit on both axes; merges findings; scores. | No — never |
| `geo` | AI-search (GEO/AEO) subset → AI Visibility score + citability report. | No |
| `score` | Recompute/show the two scores from the most recent audit's findings. | No |
| `fix` | Opt-in fixer; previews diffs, writes only after you confirm. | Only on confirm |

`audit`, `geo`, and `score` are read-only and can be triggered by description.
`fix` is `disable-model-invocation: true` — only **you** can invoke it, and the
model never auto-triggers it.

### `audit`

Read-only. It invokes the `seo-orchestrator` skill, which builds one shared
PageSnapshot, detects the vertical, dispatches the read-only specialist
subagents in parallel, merges findings, and scores. It never touches your files.

```
# Audit a live URL
/claude-seo-ai:audit https://example.com

# Audit a bundled fixture (local HTML)
/claude-seo-ai:audit tests/fixtures/blog-post.html

# Force JS rendering for a SPA, treat it as e-commerce
/claude-seo-ai:audit https://example.com --render js --vertical ecommerce
```

You get: both scores with bands and one-line interpretations, a per-category
breakdown, the data tier reached, the count of `needs_api` checks, and a
prioritized fix list sorted by impact ÷ effort. Each item carries status,
evidence, recommendation, fixability (auto/proposed/advisory), and
`expected_impact`. It ends by offering to run `fix`.

### `geo`

The AI-search subset only — answer extractability (M11), fact density (M12),
AI-crawler access + llms.txt (M14/M21), entity linking (M6), plus schema (M5)
and rendering (M4) since they feed AI visibility. It may dispatch the
`ai-search-geo-specialist` subagent. Reports the **AI Visibility** score (band +
interpretation) and a citability breakdown by category.

```
/claude-seo-ai:geo https://example.com
```

> Note: `llms.txt` is reported but **scored 0** and labeled low/uncertain impact
> (~10% adoption; partial vendor support — Anthropic and Perplexity honor it,
> Google does not use it for AI Overviews/AI Mode, OpenAI uncommitted; also
> useful as IDE-agent context).

### `score`

Recomputes and displays the two scores from the most recent audit this session
by re-running the `seo-score` skill (which uses `scripts/score.mjs` for a
reproducible number). Pass a saved findings JSON to score that file instead. If
no prior audit exists, run `audit` first.

```
# Recompute from the last audit
/claude-seo-ai:score

# Score a saved findings file
/claude-seo-ai:score findings.json
```

### `fix`

Opt-in writer — covered in detail below.

```
/claude-seo-ai:fix tests/fixtures/blog-post.html --category schema,meta
```

## Reading the dual-score report

Two **independent** 0–100 scores, never blended into one. A page can rank well
in Google yet be uncitable by AI engines, or the reverse.

| Score | Weighted toward |
|---|---|
| **Search SEO** | indexability, Core Web Vitals, on-page, schema |
| **AI Visibility (GEO/AEO)** | answer extractability, schema, fact density, AI-crawler access, entities |

Each score has a letter band (A–F) and a one-line interpretation. Notes:

- **Severity gating** caps a score at F if something critical fails (e.g.
  site-wide `noindex`).
- **Conditional verticals** re-normalize so a blog isn't penalized for lacking
  Product schema.
- Each finding carries a `confidence` tier (`established` / `directional` /
  `speculative`); leaked or inferred guidance (e.g. NavBoost) ships only as
  `directional`.

### What `needs_api` means

Some checks can't be verified offline — they need a Tier 1+ integration (a render
MCP, `PSI_API_KEY`, or Search Console). These are marked `needs_api`. They are
**excluded from the score math** and counted separately as **score confidence**,
so a high score backed by many unverifiable checks is reported honestly rather
than inflated. Providing the relevant key/MCP (see Data tiers in the README)
turns these into real findings.

## The opt-in fixer (dry-run / confirm flow)

The `fix` command is `disable-model-invocation: true` — the model can **never**
trigger writes on its own. Only you, by running `/claude-seo-ai:fix`, do, and
writes go through the single `seo-fixer-writer` subagent (the only agent with
Write/Edit; every auditor is read-only by tool allowlist).

**Dry-run (preview only) is the default.** The flow:

1. Take the findings (last audit or a fresh one) and filter to `fixable: auto`
   (plus `proposed` if you opt in). `--category` scopes which classes apply.
2. For each, locate the exact insertion point and build a **unified diff** (or
   new-file content). Any real-world inputs (e.g. `sameAs` URLs, locale map,
   publish dates) are **asked of you** — never invented.
3. **Dry-run**: print every diff grouped by file, write nothing, and summarize
   what dropping `--dry-run` would change.
4. On explicit confirmation only: delegate to `seo-fixer-writer` to apply.
   Per-change or batch confirmation is your choice.

```
# Preview (default) — nothing is written
/claude-seo-ai:fix tests/fixtures/blog-post.html

# Scope to schema + meta, still preview-only
/claude-seo-ai:fix https://example.com --category schema,meta --dry-run

# Apply (drop --dry-run, then confirm each change when prompted)
/claude-seo-ai:fix https://example.com --category meta
```

### What it can and can't write

| Class | Examples | Behavior |
|---|---|---|
| **AUTO** | meta `viewport`/`charset`/`<html lang>`, Tier-1 JSON-LD, robots.txt AI directives + `Sitemap:`, canonical, hreflang sets, OG/Twitter cards, image `width`/`height`, XML sitemap entries, `llms.txt` (disclosure-gated) | Written with diff + confirmation |
| **PROPOSED** | generated `<title>`/meta description, answer-block/TL;DR rewrites, internal-link insertions, heading restructuring, generated image alt text | Per-item accept required |
| **ADVISORY** | content/E-E-A-T rewrites, Core Web Vitals/performance, rendering strategy, redirects, link-building, Merchant Center/GBP | **Never written** |

### Safety guarantees

- Dry-run by default; writing requires dropping `--dry-run` and confirming.
- **Git-aware** — refuses a dirty working tree unless `--force`; prefers a branch.
- **Backups** of every file before first modification to
  `${CLAUDE_PLUGIN_DATA}/backups/<timestamp>/<path>`.
- **Idempotent** — re-running `fix` produces no new diffs once applied.
- **Re-verifies** each change (e.g. via `scripts/validate-jsonld.mjs`) and
  reports pass/fail.
- **Never touches** `.git/`, `.env`/secrets, lockfiles, or files outside the
  project root (enforced by a PreToolUse hook).
- **No fabrication** — never writes invented statistics, citations, dates (no
  backdating `dateModified`), credentials, or identity links.

## Optional helper scripts

The skills work as pure Markdown; the zero-dependency Node helpers (Node ≥ 18, no
install step) sharpen accuracy and make each `verification.reproduce` runnable:

```
node scripts/parse-html.mjs           --file tests/fixtures/blog-post.html
node scripts/validate-jsonld.mjs      --url  https://example.com
node scripts/parse-robots-sitemap.mjs --url  https://example.com
node scripts/score.mjs                --findings findings.json
```
