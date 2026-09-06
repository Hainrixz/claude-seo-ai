---
name: score
description: Recompute and display the two scores (Search SEO + AI Visibility) from a persisted audit run, without re-crawling. Use to re-show or refresh the scores after an audit, to score a specific run directory or host, or to score a saved findings JSON file.
argument-hint: "[findings.json | run-dir | latest[:host]]"
allowed-tools: Read, Bash
---

# /claude-seo-ai:score

Recompute and show the two 0–100 scores by running the **seo-score** skill, which uses `scripts/score.mjs` for a reproducible number. Runs live under `${CLAUDE_PLUGIN_DATA}/runs/<host>/<run-id>/`; `latest` resolves to the most recent run. <!-- reconcile-flags-v0.2 -->

- No argument (default): `node "${CLAUDE_PLUGIN_ROOT}/scripts/score.mjs" --run latest` <!-- reconcile-flags-v0.2 -->
- `latest:<host>` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/score.mjs" --run latest:<host>` <!-- reconcile-flags-v0.2 -->
- A run directory → `node "${CLAUDE_PLUGIN_ROOT}/scripts/score.mjs" --run <run-dir>` <!-- reconcile-flags-v0.2 -->
- A findings JSON path → `node "${CLAUDE_PLUGIN_ROOT}/scripts/score.mjs" --findings <path>` (pass `--vertical a,b --multilingual` when the file has no run context). <!-- reconcile-flags-v0.2 -->
- If the script reports that no run exists, tell the user to run `/claude-seo-ai:audit <url>` first — never score from memory.

Show both scores with bands, the per-category breakdown, any severity-gating cap (`cap_reasons`), the `unscored` state when no category is active, and the `needs_api` / `manual_review` / `dropped` counts. Two scores, never blended. When an axis comes back `provisional: true` (`state: "partial"`), say the band and its `coverage` % in the same sentence — a band built on a third of the model is not the same claim as a measured one, and the per-axis `warnings[]` name what was not measured.
