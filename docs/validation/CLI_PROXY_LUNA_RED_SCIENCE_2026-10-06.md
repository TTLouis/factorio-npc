# CLI proxy Luna red-science trial — October 6, 2026 UTC

Result: **blocked before world action; red-science unlock and automation not achieved**.

## Candidate and isolation

- Source `6439c996e3964d1ffcac14f49db2054206078258`, Factorio 2.0.77.
- Supported full local build passed; provider-base, supervisor and goal-requirements deployed files matched committed source with CR normalized.
- Added `build-docker-local.ps1 -NoEnvUpdate` so isolated builds do not read or rewrite the secret environment file. PowerShell parser and diff checks passed. The preceding runtime candidate passed 1,626 runtime/967 mod tests and its payload checks; this trial did not change gameplay runtime code.
- User-authorized CLI proxy endpoint `http://proxy.example-tailnet.ts.net:18317/v1`, `gpt-6-luna`, local method. Updated client key loaded opaquely by Compose. Authenticated models listing and one minimal completion passed (HTTP 200).
- Separate Compose project `luna-red-science-e2e`, fresh data at `test-results/luna-red-science-2026-10-06/data`; existing `data/saves` left untouched. RCON published only at 127.0.0.1:27016. Jev disabled. Provider guard 60 requests/hour, 32,000 output units/turn.
- Native normal-generated map seed 3455857901, zero connected humans, standalone actor 18, initially empty inventory and NULL_BOARD. No terrain changes or research shortcuts.
- One declared starter kit: 8 iron plates, 1 burner drill, 1 stone furnace, 1 pistol and 10 magazines. Engine auto-equipped the weapon/ammunition; main inventory showed construction items.

## Observed failure

Request `req_muvzz3ba_1` asked to unlock red science, then automate ore/fuel/plate supply and powered assembly, proving 10 packs per game minute for five consecutive minutes into a dedicated chest without hand-feeding.

The interaction router classified this first objective as `amend_current` despite the empty board. This is a separate routing observation, not a proven cause of the transport failure. No committed goal or action batch was observed.

Five provider requests were recorded. Nine tool calls read actor/task/inventory/equipment/research/recipe/spatial/skill information. After observation decision pressure closed tools, the planning response crossed the existing 262,144-byte body limit: the reader observed 271,137 bytes, cancelled reading and raised `provider_response_too_large`. Requested `max_tokens` was 4,000. The oversized body's content and usage were not retained, so its cause and total quota consumption remain unknown. Do not infer exact spend from successful-response usage alone.

Read-only world snapshots retained the original living actor at (0,0), red science locked, automation unresearched and no assemblers/chests. The isolated container was stopped after terminal failure. This is transport/intake evidence, not autonomous-production proof.

Current upstream [CLIProxyAPI Codex translator source](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/codex/openai/chat-completions/codex_openai_request.go) disables mapping both client token-cap fields and defaults reasoning effort to medium. This suggests the client cap cannot be assumed effective for the Codex route; the installed proxy revision has not been verified. Raising the response limit without seeing the actual body would not establish a correct fix.

## Retained evidence and next step

Ignored local evidence: `test-results/luna-red-science-2026-10-06/` contains build/start logs, result summary, test overlay/controllers, and native behavior/prompt/world logs. No secrets are included in this checkpoint.

Next diagnostic would replay the failed planning payload once to the same proxy, bound capture to 1 MiB and 90 seconds, inspect response structure/content versus reasoning sizes and usage, and make no world mutation. It has not run. Automatic approval review rejected preparation of that replay as exporting internal game/runtime context without explicit authorization. Obtain explicit owner approval for that exact export/call before proceeding; repository AGENTS.md also says never retry providers on the agent's own initiative. Preserve the current byte guard until evidence supports a bounded transport fix, then add a deterministic recorded regression and repeat the fresh-world trial.
