# Distribution

How `claude-seo-ai` ships, how to install it, and how to publish updates. The
project distributes through **two channels** from the same repository: a native
**Claude Code plugin** and a cross-agent **Vercel Skills** package.

## Two channels, one repo

| Channel | Mechanism | What you get |
|---|---|---|
| **Claude Code plugin** | `.claude-plugin/marketplace.json` (`source: ./`) | Full suite: skills + MCP/agent/hook orchestration |
| **Cross-agent (Vercel Skills)** | `npx skills add` | Agent-agnostic `skills/<name>/SKILL.md` only |

The orchestration layer — the `agents/` subagents (4 read-only auditors + 1
writer), the `hooks/` PreToolUse write guard, and opt-in render MCPs from
`.mcp.json.example` — is **Claude-Code-specific**. On other agents the project
**degrades to skills-only**: the Markdown skills still run, but the agent-level
safety and tool-allowlist enforcement that Claude Code provides is not present.

## Claude Code plugin

The in-repo `marketplace.json` declares a single plugin sourced from the repo
root (`"source": "./"`), so the marketplace **is** the repository — no separate
publish step or registry upload.

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

Published at `github.com/Hainrixz/claude-seo-ai` — `plugin.json` and
`marketplace.json` carry that `homepage` / `repository`. If you fork this repo,
update the owner in `plugin.json`, `marketplace.json`, and the schema `$id`s to your own.

The plugin works fully offline at **Tier 0** (WebFetch + bundled zero-dependency
Node scripts). JS rendering and real Core Web Vitals are opt-in Tier 1+ via a
render MCP and/or `PSI_API_KEY` — see [Data tiers](../../README.md#data-tiers).

## Cross-agent via Vercel Skills

Because every skill is a plain `skills/<name>/SKILL.md` Markdown file, the suite
installs into any compatible agent (Cursor, Codex, Gemini CLI, Windsurf, …):

```
npx skills add Hainrixz/claude-seo-ai
```

What carries over and what does not:

| Capability | Claude Code plugin | Cross-agent (skills-only) |
|---|---|---|
| Audit / fix skills (`SKILL.md`) | Yes | Yes |
| Zero-dep Node scripts (Node ≥ 18) | Yes | Yes (if the agent can run Node) |
| `seo-fixer-writer` as the sole writer subagent | Yes | No (no subagent isolation) |
| PreToolUse write-guard hook | Yes | No |
| Opt-in render MCPs (`.mcp.json.example`) | Yes | Depends on host agent |
| `disable-model-invocation` on the fixer | Yes | Not enforced |

> Safety reminder: in Claude Code the fixer
> ([`skills/fix`](../../skills/fix/SKILL.md)) is
> `disable-model-invocation: true` and only `seo-fixer-writer` holds Write/Edit.
> When running skills-only on another agent, those guarantees rely on the host
> agent's own model and permissions, so review diffs before accepting writes.

## Versioning

Versions live in two places and must stay aligned:

- `.claude-plugin/plugin.json` → `"version"` (currently `0.1.0`)
- `.claude-plugin/marketplace.json` → the plugin entry's `"version"` (also `0.1.0`)

To ship an update, **bump the `version` in `plugin.json`** (and match it in
`marketplace.json`), commit, and push. Users pull the new build by re-running
the marketplace/install flow or `/reload-plugins`.

Follow semantic versioning:

| Bump | When |
|---|---|
| Patch (`0.1.0 → 0.1.1`) | Fixes, doc edits, no behavior change |
| Minor (`0.1.0 → 0.2.0`) | New skills, modules, or flags; backward-compatible |
| Major (`0.1.0 → 1.0.0`) | Breaking changes to commands, finding schema, or scoring |

Keep the bilingual docs (`docs/en` + `docs/es`) in sync when user-facing
behavior changes, per [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Before
publishing, validate the manifest:

```
claude plugin validate .
```

## Pre-publish checklist

```
# syntax-check every script
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done
# run the script self-test against the fixtures
node tests/run.mjs
# validate the plugin manifest (if you have the CLI)
claude plugin validate .
```

## Licensing & originality

`claude-seo-ai` is **MIT-licensed** (declared in both `plugin.json` and
`marketplace.json`; full text in [`LICENSE`](../../LICENSE)). It is original
work: inspired by the patterns of community SEO tooling but copying **no**
branding, text, or names from any other project. Contributions must uphold the
same standard — see the ground rules in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) — including no fabricated statistics,
citations, dates, credentials, or `sameAs` identity links.

When redistributing, keep the MIT `LICENSE` and copyright notice intact.
