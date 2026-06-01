---
name: score
description: Recompute and display the two scores (Search SEO + AI Visibility) from the most recent audit's findings, without re-crawling. Use to re-show or refresh the scores after an audit, or to score a saved findings JSON file.
argument-hint: "[findings.json]"
allowed-tools: Read, Bash
---

# /claude-seo-ai:score

Recompute and show the two 0–100 scores from the latest audit's findings by re-running the **seo-score** skill (which uses `scripts/score.mjs` for a reproducible number).

- If a findings JSON path is given in `$ARGUMENTS`, score that file: `node scripts/score.mjs --findings <path>`.
- Otherwise use the findings from the most recent audit this session. If no audit has run yet, tell the user to run `/claude-seo-ai:audit <url>` first.

Show both scores with bands, the per-category breakdown, any severity-gating cap, and the `needs_api` count. Two scores, never blended.
