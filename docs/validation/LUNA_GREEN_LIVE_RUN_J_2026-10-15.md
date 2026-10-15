# Luna green-science live run J — October 15, 2026

## Result

**Progress beyond the copper stall; green science still unproven.** The one owner-authorized CLI-proxy trial ended after 12 minutes at a new completed-slice harness fault, `checkpoint_requires_active_step`. All 40 main-provider requests returned successfully. No second trial, corrective prompt or provider retry followed the stop.

## Frozen candidate and preflight

- Pushed candidate **`9550ecc998eee9895c04a8b11e661e9b36d19c3c`**, containing reviewed units 17/18. Runtime/mod/engine code is unchanged from the green static and native checkpoint: 2,353 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks, and recovery-loop/production/craft-trigger/native-admission/steam-lab lanes.
- Rebuilt through `scripts/build-docker-local.ps1 -NoEnvUpdate`, exit 0. Actual image digest **`sha256:df39b419ac7c9b89f2a2420ebf22f596a5f32a6234da97a6b9b2ce58d74c9574`**. No runtime override was applied to the image.
- Before the objective, all **50 shipped runtime/staging modules** matched `git show` source after CR normalization, the packaged prompt matched its committed hash, and the production manifest verified. All **31 active mod files** matched the packaged compiled mod, including exact binary comparisons.
- Actual non-secret config and all main-provider responses confirm **`gpt-6-luna`**, API method `local`, through the previously confirmed CLI-proxy overlay. Dedicated Jev is enabled. `.env` was neither read by the agent nor edited; private routing remains confined to ignored local configuration.
- New Compose project `luna-green-20261015j` and empty data directory preserved previous trials. Data bind source exists; RCON publishes only on `127.0.0.1:27016`.
- Fresh world seed **3480656586**, standalone actor **14**, empty inventory and nil board before setup. Zero humans and speed 1 throughout the observed trial.
- Run E's unchanged starter: burner drill 1, stone furnace 1, iron plates 8, pistol 1, ammunition 10. One raw-chat green-science objective; no operator gameplay after setup. Fresh goal **`goal_1n7zz80_1`**, request **`req_mv98kbam_1`**.
- Started **03:47:22 EDT**, terminal error **03:59:15 EDT**, driver concluded **03:59:23 EDT** (07:47:22–07:59:23 UTC), elapsed **721,481 ms**. No arbitrary duration or poll-count cutoff. Weekly remaining allowance was 98% afterward, above the 50% floor.

## What worked and what was not exercised

Luna mined copper, placed/fuelled a furnace and smelted 10 copper plates. One native snapshot showed six held and four in furnace output; the next showed **10 held, empty output** and the completed copper plan. It continued to iron acquisition and native smelting, ultimately holding **50 iron plates**, 50 iron ore, 10 copper plates and the unused starter drill. The furnace remained placed with coal 5 and empty input/output.

The old copper-output stall did not recur. This is stronger live progress than run I, but it is not direct live proof of units 17/18's auto-resume path: **zero `recovery.auto_resume_started` events** occurred in J. Their restart/cancellation/no-replay proof remains the deterministic native lane.

No red science was produced or consumed; logistic-science-pack remained unresearched and its recipe disabled. No lab or steam-power cell was built. Holding 50 iron plates includes eight starter plates and must not itself be treated as evidence of a 50-plate production trigger.

## First terminal fault

After a deterministic slice completed, the planner answered at `trigger_source: plan_slice_completed` with an unsupported `BLOCKED:` claim that it could not verify the steam-power trigger. Its structured reply proposed one step, “Verify steam-power trigger completion,” no operations, and a `research_completed steam-power` checkpoint.

The preceding canonical reducer plan was already **COMPLETED**. The reply passed through `plan.accepted` and `plan.persisted`, but the retained legacy/current plan was still completed. `persistPlannerCheckpoint` then required an active step and threw **`checkpoint_requires_active_step`**. The runtime reported `recoverable=false`, `harness_state_fault: checkpoint_requires_active_step`, `pause_class: system`; it did not enter bounded model recovery. The failure snapshot and persisted reducer history corroborate this boundary mismatch.

This is a different entry path from run H's paused-plan activation fault: J never auto-resumed. Source inspection finds that `plannerOnlyDraftCandidate` excludes an explicit model blocker, while the ordinary remaining-work blocker branch is skipped for the just-completed slice. The later checkpoint persistence call still executes. That explains the observed path; a deterministic replay is required before selecting a production patch.

## Proposed fix and regression case

Handle a checkpoint-bearing, no-operation blocker at a completed-slice planner boundary **before mutating/persisting the compatibility board or applying an active-step checkpoint**. An unsupported blocker should enter the existing bounded model-correctable route. A valid successor should acquire its own admitted/committed identity before accepting a checkpoint. Preserve the completed plan, verified history, current goal, grants and retry limits; do not reopen completed history or weaken the active-step guard.

The ignored replay case `completed-slice-checkpoint-case.json` captures the exact structured reply, trigger source, final canonical state, failure code, preconditions and assertions. It explicitly labels the captured state as post-failure, not a fabricated pre-turn snapshot. The next runnable composed regression should begin with an active finite goal whose last slice is completed, return this exact planner reply and require bounded handling without a system fault or manufactured research completion. Add positive successor admission, true world-blocker and actor/epoch cancellation variants. Keep production-trigger counts separate from held starter stock.

**Production fix and runnable regression remain open.** No runtime/mod source was changed during J, and no fresh live run is authorized by this record.

## Evidence and shutdown

- Main provider: **40 requests / 40 responses / 0 errors**; actual model `gpt-6-luna`. Reasoning requests: 38 `high`, two `low`; cumulative reported reasoning output 11,263 units. Unit 16's reasoning setting reaches the proxy.
- Jev: **43 requests / 43 responses** in the decision trace; no transport failure reported.
- Exact checkout `run-check.mjs` ran read-only in Docker: **1 request, 695 rows, zero parse errors**, exit 1 for `harness_state_fault` and `request_failed_unrecoverable`.
- Driver exit 0 means it recorded the terminal outcome, **not gameplay success**. Native checkpoint save is non-empty. RCON closed in `finally`; only the isolated run-J stack was shut down. No live Pterodactyl deployment or other container was changed.

Local ignored evidence root: `test-results/luna-green-live-2026-10-15j/` in `peaceful-saha-a52c6f`. It contains `summary.json`, `completed-slice-checkpoint-case.json`, `run-check.json`, `evidence-sha256.json`, preflight/start/down logs and the driver; `data/logs/` contains the full behavior/prompt/Jev traces, deployment report, contract, native snapshots, result and final canonical state. Native save: `data/saves/luna-green-j-checkpoint.zip`. The private overlay and raw traces are not committed.
