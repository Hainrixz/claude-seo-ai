# Distribution

How `claude-seo-ai` ships, how to install it, and how to publish updates. The project distributes
through **two channels** from the same repository — a native **Claude Code plugin** and a cross-agent
**Vercel Skills** package — plus a **GitHub Action** for CI.

## Two channels, one repo

| Channel | Mechanism | What you get |
|---|---|---|
| **Claude Code plugin** | `.claude-plugin/marketplace.json` (`source: ./`) | Everything: skills, the `scripts/` acquisition layer, the five subagents, the two PreToolUse hooks, `userConfig` credential prompts |
| **Cross-agent (Vercel Skills)** | `npx skills add` | Agent-agnostic `skills/<name>/SKILL.md` files only |

The orchestration layer — the `agents/` subagents (4 read-only auditors + 1 writer), the `hooks/`
write and shell guards, and the opt-in render MCPs from `.mcp.json.example` — is
**Claude-Code-specific**.

## Claude Code plugin

The in-repo `marketplace.json` declares a single plugin sourced from the repository root
(`"source": "./"`), so the marketplace **is** the repository — no separate publish step and no
registry upload.

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

Published at `github.com/Hainrixz/claude-seo-ai` — `plugin.json` and `marketplace.json` carry that
`homepage` / `repository`. If you fork the repo, update the owner in `plugin.json`,
`marketplace.json` and the schema `$id`s to your own.

The plugin works fully offline at **Tier 0** (the bundled zero-dependency Node scripts, no keys). JS
rendering and real Core Web Vitals are opt-in Tier 1+; see [`mcp.md`](mcp.md).

### Credentials ship as `userConfig`, not as files

`plugin.json` declares a `userConfig` block with the 17 credential keys the write adapters
understand — Shopify, WordPress, Webflow, Wix, Ghost, HubSpot, BigCommerce, plus `PSI_API_KEY` — each
marked `sensitive` where it is a secret. Claude Code prompts for them under `/plugin` and exports
each as `CLAUDE_PLUGIN_OPTION_<KEY>`, which the adapters read before falling back to the bare `<KEY>`
from the environment.

Nothing about that touches your repository: no `.env` is written, no value reaches `argv`, and the
fix log redacts commands. See [`platforms.md`](platforms.md#credentials).

## Cross-agent via Vercel Skills

Because every skill is a plain `skills/<name>/SKILL.md` Markdown file, the suite installs into any
compatible agent (Cursor, Codex, Gemini CLI, Windsurf, …):

```
npx skills add Hainrixz/claude-seo-ai
```

> **The skills-only channel ships the Markdown, not the machinery.** `npx skills add` installs
> `skills/**` — it does **not** ship `scripts/`, `agents/`, `hooks/`, `references/` or `schema/`. Every
> skill in this suite calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"` for acquisition and
> verification, and `${CLAUDE_PLUGIN_ROOT}` is a Claude Code plugin variable. On a skills-only
> install those commands have nothing to run, and the orchestrator's documented behaviour is to say
> so first and fall back to **prompt-only mode**: `WebFetch` summaries, every header/status/render/
> robots-dependent finding marked `needs_api`, no persistence, and the report labeled *"prompt-only
> mode — not comparable to a scripted run"*.
>
> If you want the deterministic pipeline on another agent, clone the repository and run the scripts
> directly (`node scripts/audit.mjs <url> --out ./runs`) — they are plain Node ≥ 18 ESM with zero
> dependencies and no install step.

What carries over and what does not:

| Capability | Claude Code plugin | Cross-agent (skills-only) |
|---|---|---|
| Skill Markdown (`SKILL.md`) | Yes | Yes |
| The `scripts/` acquisition layer + persisted runs | Yes | **No** — clone the repo to get them |
| Deterministic checks registry, `report.json`, `compare` | Yes | No (same reason) |
| Platform adapters and the ticketed fix flow | Yes | No |
| `seo-fixer-writer` as the sole writer subagent | Yes | No — no subagent isolation |
| `guard-write` / `guard-bash` PreToolUse hooks | Yes | No |
| `userConfig` credential prompts | Yes | No — use environment variables |
| Opt-in render MCPs (`.mcp.json.example`) | Yes | Depends on the host agent |
| `disable-model-invocation` on the fixer | Yes | Not enforced |

> Safety reminder: in Claude Code the fixer ([`skills/fix`](../../skills/fix/SKILL.md)) is
> `disable-model-invocation: true` and only `seo-fixer-writer` holds Write/Edit. Running skills-only
> on another agent, those guarantees rest on the host agent's own model and permissions — review
> every diff before accepting it.

## GitHub Action (CI)

`action.yml` at the repository root is a composite action that runs the **deterministic subset** — the
model-judged modules need Claude Code, so the two scores in CI describe what a script can prove, not
everything the full audit covers. It sets up Node, runs `scripts/audit.mjs`, writes a job summary,
exposes the scores as step outputs and uploads the run directory as an artifact.

```yaml
- id: seo
  uses: Hainrixz/claude-seo-ai@v0.2.0
  with:
    url: https://example.com
    pages: '5'
    render: static            # the default never launches a browser
    fail-under-search: '70'
    fail-under-ai: '60'
```

Inputs: `url` (required), `pages`, `max`, `render`, `lang`, `environment`, `vertical`,
`fail-under-search`, `fail-under-ai`, `fail-on-gated`, `fail-on-severity`, `out`, `node-version`,
`upload-artifact`, `artifact-name`.
Outputs: `search-score`, `ai-score`, `search-band`, `ai-band`, `report-json`, `report-md`, `run-dir`,
`exit-code`.

A tripped gate exits **3** and emits one `::error` annotation per gate. A ready-to-copy workflow is
in [`.github/workflows/seo-audit-example.yml`](../../.github/workflows/seo-audit-example.yml); the
project's own CI matrix (Node 18/20/22 × ubuntu/macos/windows) is in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

Because CI pins the action by tag, **tag every release** (`v0.2.0`) so `uses: …@v0.2.0` resolves.

## Versioning

The version lives in **three** places and they must move together:

- `.claude-plugin/plugin.json` → `"version"`
- `.claude-plugin/marketplace.json` → the plugin entry's `"version"`
- `scripts/package.json` → `"version"`

`node scripts/check.mjs` verifies the alignment and fails if they drift, so this is enforced rather
than remembered.

Semantic versioning:

| Bump | When |
|---|---|
| Patch (`0.2.0 → 0.2.1`) | Fixes, doc edits, no behavior change |
| Minor (`0.2.0 → 0.3.0`) | New skills, checks, adapters or flags; backward-compatible |
| Major (`0.2.0 → 1.0.0`) | Breaking changes to commands, the finding schema, the report schema, or scoring |

To ship an update: bump all three versions, update `CHANGELOG.md`, keep `docs/en` and `docs/es` in
lockstep, commit, tag, and push. Users pull the new build by re-running the marketplace/install flow
or `/reload-plugins`.

## Pre-publish checklist

```bash
# syntax-check every script, lint skill/agent frontmatter, verify the three versions align
node scripts/check.mjs

# the full suite (unit + e2e against the local fixture server; no network)
node tests/run.mjs        # or: node --test tests/

# validate the plugin manifest (if you have the CLI)
claude plugin validate . --strict
```

Then confirm by hand: the `[Unreleased]` heading in `CHANGELOG.md` has become a dated release, the
three versions match, `docs/es/` mirrors any `docs/en/` change, and the release tag matches the
version the action's `uses:` line will point at.

## Licensing & originality

`claude-seo-ai` is **MIT-licensed** (declared in both `plugin.json` and `marketplace.json`; full text
in [`LICENSE`](../../LICENSE)). It is original work: inspired by the patterns of community SEO tooling
but copying **no** branding, text or names from any other project. Contributions must uphold the same
standard — see [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — including no fabricated statistics,
citations, dates, credentials or `sameAs` identity links.

When redistributing, keep the MIT `LICENSE` and copyright notice intact.
