# Luna Haiku live trial and executor step identity — October 8, 2026

## Live trial (owner-requested, cheap model)

- Code: `3dc1de6d` (newest integrated work at the time). Full local image built with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All 45 shipped runtime modules matched the commit (CR normalized), and the active `control.lua` matched the compiled release.
- Isolated Compose project with its own data directory, RCON and game ports on host loopback only. Model `claude-haiku-5-5` through the owner's CLI proxy (`AI_API_METHOD=local`); the proxy key was loaded opaquely from `.env`. Jev enabled. Zero connected humans, speed 1, fresh world, declared starter kit only.
- Objective: the same red-to-green goal as the October 7 trials. Controller limit 45 minutes; no corrective prompts or operator gameplay.

### Result: `request_failed` after 390.8 s (goal `goal_04s5qpr_1`)

- 10 Luna calls (383,805 usage units, 149,040 cached) and 14 Jev calls. No provider or HTTP errors; the proxy accepted the model id.
- Luna mined 50 iron ore and 20 coal, placed and fuelled the stone furnace, smelted iron and held 58 iron plates. Two of three committed steps closed. The copper step was never started. Red science stayed locked.
- `run-check` exited 0 with no findings; it did not detect the terminal failure.

### Failure

1. Luna reported the iron step met with `operations: []`. The G1/G2 fresh read closed the step (`plan.step_closed_on_fresh_read`, `checkpoint_met_before_batch`) and the request continued.
2. Luna's next reply chose a valid copper operation but echoed the shorter plan list it had seen (iron step, copper step) with `currentStep: 1`. The committed active index was 2. The `[CONTROL_DECISION_STATE]` block already named the correct step id and index.
3. Protocol v2 refused the index mismatch (`executor.stale_step_rejected`). `enforceExecutorContract` runs inside `commitPlan`, after the `plan_category` correction loop, so the error reached the guarded-turn catch as `request.failed recoverable:false` and the goal paused. No `recovery.classified` row was written.

Evidence: ignored local directory `test-results/luna-haiku-live-2026-10-08/` (controller, overlay, deployment verification, logs and final state).

## Repair: executor operations bind to the committed step id

Owner asked for a long-term fix rather than a targeted patch. Merged at `0f337065` (unit commits `b57d30b1`, `dc2cea2a`, `3e13d181`, `1222d281`), with an independent invariant review whose should-fix and notes were applied.

- The executor instruction now asks for `stepId` (the active step id from `[CONTROL_DECISION_STATE]`) instead of echoing `plan`/`currentStep`. No other prompt text changed.
- A reply whose `stepId` names the active step is bound to it (`executor.step_bound`). `currentStep` is normalized to the committed index, so a bound reply cannot use an index to imply a step closure; only an explicit `semanticCompletion` claim keeps its existing checks. Zero-operation replies keep their legacy shape for final-completion handling.
- A `stepId` naming another step is refused. A reply without `stepId` keeps the legacy index rule and traces `executor.legacy_step_index_used`. A planner `stepId` is ignored and traced (`planner.step_id_ignored`).
- Step-identity refusals get their own correction allowance: 2 per committed step, keyed by goal, plan and tracker step id, persisted (`executor_step_identity_ledger`, max 128 entries), not renewed by restage, new request, restart or Resume, and separate from other `plan_category` corrections. The actor/epoch fence is checked before the allowance is charged. Corrections are fact messages (`executor.step_identity_correction`); exhaustion pauses the goal with `executor_step_identity_exhausted`.
- The fresh-read close and receipt-verified closes share one transition fact naming the new active step and its id. The receipt fact sits before the detailed receipt so receipt compaction still works.
- `run-check` reports a request ending in `request.failed` with `recoverable:false` and any counted `executor.stale_step_rejected`.

Gates on the merge: `bash scripts/test-local.sh all` exit 0 — runtime 1,906 pass, 0 fail, 0 todo; mod 1,045 tests in 120 files. Installer payload `--check` current. Tests replay the two recorded Haiku replies byte for byte.

## Limits and follow-ups

- Not yet live-validated. A rerun needs the owner's go.
- The `submitPlan` schema still lists `plan`/`currentStep` as required; the harness tolerates their absence when `stepId` is present.
- Existing blind-wait and deferred facts are appended after the detailed receipt, which disables receipt compaction when present. This predates the repair.
