# Green-science CLI-proxy rerun E — October 13, 2026

## Provider diagnosis and repair

Attempt D resolved stale local-provider settings: Qwen through a Windows-host LM Studio endpoint. A sanitized same-image diagnostic reproduced `ECONNREFUSED`: DNS succeeded, but the configured TCP listener was absent. This was not a CLI-proxy or GPT-6 Luna failure.

The owner clarified that the intended current provider is the Tailscale CLI proxy with `gpt-6-luna`. The isolated rerun was corrected to that provider with `AI_API_METHOD=local`. Its DNS and TCP probes passed, authenticated `/models` returned HTTP 200, and the exact model was advertised. Existing credentials were consumed through Compose without reading or editing `.env`. The private endpoint is confined to ignored local run configuration. The mistaken LM Studio startup was undone; it is not the gameplay backend.

This is a local configuration repair; runtime/mod source and generation settings were unchanged. The ignored rerun overlay remains at `test-results/luna-green-live-2026-10-13e/live.compose.yml`. Default `.env` settings were not rewritten; reproduction must use the confirmed run overlay rather than the stale defaults.

## Candidate and procedure

- Pushed candidate `05c6c35f69c1132b8f6a59dc640023690129cef8`; reviewed runtime code `16138b9a`.
- Prescribed `scripts/build-docker-local.ps1 -NoEnvUpdate` exited 0 (`test-green-e-build.log`). All 49 runtime/staging modules and 31 active compiled mod files matched. Config mirror and actual provider responses confirm `gpt-6-luna`, method `local`.
- Fresh isolated project `luna-green-20261013e`, empty data directory and newly generated world. Standalone actor 9, epoch 1; zero humans and speed 1. Before setup: empty inventory and nil board. Previous trials/saves were preserved.
- Original starter: drill 1, furnace 1, iron plates 8, pistol 1 and ammunition 10. No operator gameplay or corrective prompts followed setup.
- One raw-chat green-science objective; fresh goal `goal_0krmyq5_1`, request `req_mv6ofio6_1`. No arbitrary timer or poll-count cutoff; 50% weekly remaining was the hard floor.

## Completed trial result

**Provider connectivity is fixed. Autonomous green science remains unproven.** Twelve provider requests received twelve responses, with zero provider errors. Luna committed the step “Complete electronics trigger by producing 10 copper plates,” admitted native `gather_resource(copper-ore,10,search_radius=256)`, moved to the resource patch and finished with 10 copper ore in real inventory.

The executor then failed to return a smelting/acquisition action. An unverified world blocker was rejected, the existing fresh-context recovery was used, and its final reply again contained `operations:[]`. It said the step was incomplete and that it was blocked from smelting, without an executable operation or explicit `BLOCKED:` reason. At `12:49:40Z` (08:49:40 Toronto), bounded recovery exhausted with `provider_action_omission_repair_failed`; the controller paused the still-active goal.

This is the first new reproducible controller/model blocker, distinct from transport. Its underlying policy/prompt cause is not established by this trial. Final inventory retained 10 copper ore, starter drill/furnace and 8 iron plates; no machines were placed, no copper plates/red science were produced, and logistic-science research remained incomplete. The attempt stopped as `controller_paused` after 90,178 ms, saved the world, closed its RCON and removed only its isolated stack. No further live retry or corrective intervention occurred.

The checker reports `stale_step_tracker_behind_batch` for the completed mining batch while the broader copper-plate step remains active. That signature alone does not prove tracker staleness: mining ore does not satisfy the copper-plate/electronics contract. The terminal action-omission failure above is directly evidenced by the trace and persisted pause.

## Evidence

Local ignored root: `test-results/luna-green-live-2026-10-13e/`.

- `summary.json`, `evidence-sha256.json`, `run-check.json`, `live-observation.log`, `start.log`, `down.log`.
- `data/logs/deployment-verification.json`, `e2e-contract.json`, `e2e-before.json`, `e2e-world-snapshots.jsonl`, `e2e-result.json`, `e2e-final-npc-state.json`.
- Full behavior, prompt and Jev decision traces in `data/logs/sgluna-*.jsonl`.
- Final save `data/saves/luna-green-e-checkpoint.zip`.

The first copied checker invocation lacked a diagnostic dependency; the exact checkout checker then ran read-only against the saved trace, exit 1 with the signature discussed above. Evidence handling did not invoke another model or gameplay run.

Usage was 73% weekly remaining at shutdown. The run ended at its controller blocker, not a usage target; the 50% floor was not approached. All existing static/engine prerequisite evidence remains valid; this rerun changed no production code.
