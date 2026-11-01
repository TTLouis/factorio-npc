# Autonomous green-science validation D — October 13, 2026

## Result

**Blocked before a plan or gameplay: provider transport failure. Green science remains unproven.** The one authorized cold-world attempt submitted its raw-chat objective, created a fresh canonical goal, and made one Luna provider request. That request failed with `fetch failed`; the runtime emitted `request.failed` with `recoverable=false`. The overseer stopped at this first blocker, saved the world, closed its single RCON instance and removed only this isolated Compose stack. No provider retry, corrective prompt, implementation change or second run occurred.

This is a failed live provider attempt, not autonomous gameplay evidence. The logs do not establish the underlying transport cause or show that the inference server received the request. No endpoint, credential or provider setting was inspected or changed to diagnose it.

## Candidate and deployment

- Integration checkout: `D:/SideProjects/airi-factorio-npc/airi-factorio/.claude/worktrees/peaceful-saha-a52c6f`, branch `og-port-integration`.
- Clean, pushed candidate: `35150fc61244d25a1992f50025d3e824ddf19b08`; reviewed runtime code `16138b9a578d2dcfd3f42f804f36ad963fa66026`; payload repin `ed8bf0ad`.
- `scripts/build-docker-local.ps1 -NoEnvUpdate` exited 0. No `--pull`, `--no-cache`, source changes or `.env` edits.
- All **49 shipped runtime/staging modules**, including `batch-stock.mjs`, matched `git show HEAD` after CR normalization. Both shipping-list completeness and unexpected shipped modules were checked.
- All **31 active compiled-mod files** matched the installed release after CR normalization; no extra active files. Active `control.lua` normalized SHA-256: `cc4050f869974321933c7b2fdf5b24a0ed2f7d27b09b170b3167a69317f1d172`.
- Gameplay model: **`qwen3-coder-30b-a3b-instruct`**, confirmed from allowlisted runtime configuration and the actual request payload. `AI_API_METHOD` was empty. Current settings were preserved, per the run-specific owner instruction; the historical GPT-6 proxy run label does not describe this model. Jev token presence was verified without printing its value.

## Cold-world contract and correlation

- New Compose project `luna-green-20261013d`, new empty data directory `test-results/luna-green-live-2026-10-13d/data` and newly generated save `luna-green-d-world.zip`. Prior trials and worktrees were preserved.
- `/data` bind source existed. RCON published only at `127.0.0.1:27016`, forwarding to container port 27015. Docker Desktop was not touched.
- Fresh world seed `3729861058`; standalone actor **11**, epoch **1**. Before setup: empty main inventory, nil task board (`NULL_BOARD` semantics), no machines, no science unlocks or research progress. Zero humans and speed 1 before and after the attempt.
- Exact starter insertion: **1 burner mining drill, 1 stone furnace, 8 iron plates, 1 pistol and 10 firearm magazines**. The main-inventory snapshot shows the construction items and plates; equipment is omitted from that main-inventory view. The insertion receipt records all five items.
- Raw objective: `!luna Reach green science: produce red science packs and consume them in native lab research to complete logistic-science-pack and enable green science. Hand crafting and hand-fed machines are allowed; factory automation is optional. Use natural resources and native game mechanics. Finish when logistic-science-pack is researched and its recipe is enabled.`
- Request **`req_mv6fo1ee_1`**, new goal **`goal_1aai7qd_1`**. Final persisted goal is `active`, with no committed plan, no active plan id and no run object. Final world board remains nil. The original goal/actor/request correlation is preserved; canonical completion was not reached.
- Operator gameplay actions after starter: **0**. Corrective prompts: **0**. No teleport, item insertion or research completion after setup.

## First blocker and native outcome

The goal was submitted at approximately `2026-10-13T08:42:54.764Z`; request receipt was `08:42:55.383Z`. The sole provider request at `08:42:55.652Z` failed at `08:42:55.702Z` with `fetch failed` (50 ms reported latency; neither timeout nor cancellation). `request.failed recoverable=false` followed at `08:42:55.706Z`. Four Jev decision calls were recorded. No provider response or gameplay operation was recorded.

The driver observed the terminal failure on its next 90-second snapshot and ended as `request_failed` after **90,157 ms**. This interval is observation latency, not a time-limit stop. The previous 45-minute and 91-poll cutoffs were removed; no arbitrary duration or poll-count condition ended the attempt.

Final native state: **0 red packs produced, 0 consumed, 0 tasks added, no machines, logistic-science-pack unresearched and its recipe disabled**. Actor 11 stayed at the origin with zero humans and speed 1. This attempt did not exercise the reviewed stock, recipe, resource-recovery or powered-lab gameplay paths.

`run-check` exited **1**, reporting `request_failed_unrecoverable` once, for this request; 18 behavior rows, one request, zero parse errors. An initial checker invocation inside the release found that this diagnostic module is not shipped; the read-only checker was then run from the exact integration checkout against the preserved host trace. Both outputs are retained. This did not invoke another provider or restart gameplay.

## Evidence and shutdown

All paths below are relative to the integration checkout. Local evidence remains ignored; documentation contains no endpoint or credential values.

- Evidence root: `test-results/luna-green-live-2026-10-13d/`.
- `summary.json`, `evidence-sha256.json`, `expected-runtime.json`, `verify-deployment.mjs` and `run-live.mjs` preserve the result, hashes, deployment checks and adapted driver.
- `data/logs/sgluna-behavior.jsonl`, `sgluna-decision.jsonl`, `sgluna-prompts.jsonl` preserve the structured exchanges.
- `data/logs/deployment-verification.json`, `e2e-before.json`, `e2e-contract.json`, `e2e-world-snapshots.jsonl`, `e2e-result.json`, `e2e-final-npc-state.json` preserve native state and correlation. The final canonical-state copy is authoritative; the driver's earlier `e2e-latest-npc-state.json` predates the failed request.
- `run-check.json`, `live-observation.log`, `start.log`, `down.log`; build output `test-green-live-build.log` at checkout root.
- Final save: `data/saves/luna-green-d-checkpoint.zip`, **584,859 bytes**; original cold-world save also retained.
- Trial driver exited 0 for completed evidence handling; this is not a passing gameplay result. Compose `down` exited 0. No production Pterodactyl deployment occurred.
- Usage: 77% weekly remaining at start, **76% remaining** at evidence/shutdown milestone. No reset credit used; the 50% hard floor was not approached.

No runtime fix or second run is authorized by this finding. The next action is to resolve the current gameplay provider transport/configuration outside this completed trial, then obtain separate authority before any new autonomous attempt.
