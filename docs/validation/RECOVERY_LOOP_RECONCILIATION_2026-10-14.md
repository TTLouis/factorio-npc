# Recovery consolidation proposal: reconciliation and pre-live gate (2026-10-14)

This reviews the recovery consolidation proposal written on 2026-10-14, a scratchpad outside the repository, against the integration HEAD. The proposal was inspected at `9e4ef5a0`. It is a proposal, not an instruction, and it does not authorize a live run.

## Baseline at review

- **Integration HEAD:** `c80e03cf` on `experiment/jev-agent-architecture`.
- **Commits since the proposal's baseline:**
  - unit 15 (`58f73d7b`, `0dc70122`): fresh machine output counts toward the step residual;
  - unit 16 (`34818951`, `f5a0d1f0`): the per-case reasoning effort reaches GPT-6 behind the CLI proxy;
  - run I checkpoint `982713d9`.
- **Gate on `c80e03cf`:** `bash scripts/test-local.sh all` exits 0 with 2338 tests passing. The production, craft-trigger, native-admission and steam-lab engine lanes pass (exit 0). The commit is pushed.

## What the proposal gets right

- **Focused coverage is broad.** Existing focused tests cover:
  - pause classes and the auto-resume cap;
  - the stop, player-request and actor/epoch races;
  - restart from persisted pauses;
  - the run G refusal correction;
  - the run H activation;
  - lost-acknowledgement reconciliation.

  That is about 60 tests across `pause-class-auto-resume`, `world-refusal-correction` and `operation-reconciliation-scenario`.
- **But no test drives the whole chain.** None goes through the production scheduling path to a verified finish. The recovery tests call `runModelRecoverableResume` directly instead of letting the timer fire. They set the inventory to the expected answer, and they stop at an accepted checkpoint or an admitted batch.
- **Run I proves the point.** Recovery activated correctly six times and still rebuilt a contradictory packet each time. Nothing tested that a resumed plan goes on to finish.

## Decisions

| Proposal item | Decision | Why |
| --- | --- | --- |
| Composed full-loop scenarios (R02, R03, R04, R06, R07, R09, R15) | **Adopted as unit 17.** One composed G→H→I chain to verified completion, plus restart, cancellation and no-replay variants. Timers fire through node:test mock timers. Furnace state changes only through admitted operations. Zero humans. Unknown RCON commands are checked. | This is the missing proof. It reuses the existing fixtures instead of copying their assertions. |
| R15 boundary checks | **Covered by unit 15:** stale observations are never credited, held stock is unchanged, an `inventory_count` is not satisfied until the items are collected, and trigger rows are not netted. Unit 17 adds the native transfer happening before completion. | Unit 15 owns the residual algorithm; recovery tests consume it. |
| R05 transport / intake, R08 cap versus detector, R10 duplicates, R11 forbidden classes, R12 in-flight work | **Already covered by focused tests** (transport resume, intake retry, the limit-reached test, stop races, never-resume-guard tests, `blocked_repeating_failure`). Each gets a composed variant only if unit 17 shows a divergence. | Avoids duplicating coverage. |
| C2 / C3: shared activation and scheduling refactor | **Deferred.** Unit 14 already sends model, transport and restart-lifecycle resumes through one fenced `resumePausedPlan`. A scheduling refactor goes ahead only if a composed scenario shows a divergent path. | A refactor without a failing test is risk without evidence. |
| Persisting transport attempt counts | **Not changed.** Transport attempts stay in memory, as documented. | This is a policy decision, not part of this work. |
| Retry limits, pause-class allowlists, authority | **Unchanged.** | The owner's limits stand. Raising the cap is not a fix. |
| Native `recovery-loop` lane | **Completed as unit 18**, locally merged at `e39eea27`. It runs the furnace G+H+I chain on the real engine with scripted provider replies, two process restarts, exact completion/no replay and pending-timer cancellation. | The engine proves the slots, smelting and transfer. Real timers also exposed the inherited completed-turn scope defect, fixed in `7b8fe59`. |

## Entry criteria for run J

- [x] Unit 17 composed scenarios pass: G→H→I reaches verified completion, plus restart, cancellation and no-replay.
- [x] Any defect a composed scenario exposes is fixed in its own commit, with no change to authority or limits. Runtime fixes `e1aaf952`; completed tests `a9663f98`; reviewed and merged as `14a03571`.
- [x] Unit 18 native recovery-loop lane passes on frozen code/test candidate `4783226c`, independently reviewed and locally merged at `e39eea27`.
- [x] `bash scripts/test-local.sh all` passes on merged candidate `e39eea27`, and the production, craft-trigger, native-admission and steam-lab lanes pass alongside recovery-loop on frozen candidate `4783226c` (identical code).
- [x] The installer repin is current: `payload-src/installer.sh` is unchanged; bootstrap tests pass in the static gate.
- [x] Local server image built from pushed candidate `451bd0e1`; all 51 shipped runtime/prompt files and 31 mod files verified against source/passing engine image. Offline standalone startup, native save and graceful shutdown pass. See [remote integration and packaging checkpoint](UNIT17_18_INTEGRATION_2026-10-15.md).
- [x] Run J's cold-start preflight verified candidate `9550ecc9`, all 50 runtime/staging modules, committed prompt, release manifest and 31 active mod files; no runtime override applied.
- [x] The owner authorized run J on October 15. It is concluded; this go does not authorize another run.

## Candidate and open blockers

Unit 17 is complete and locally integrated at `14a03571` (code/test checkpoint `a9663f98`). Fourteen composed scenarios pass without skips or TODOs. Runtime fixes preserve fresh machine-output facts after restart and settle exact completed operation evidence before checkpoint verification. Independent review passed. See [unit-17 checkpoint](UNIT17_RECOVERY_LOOP_2026-10-14.md).

Unit 18 is now complete and locally integrated at `e39eea27`. Its real-timer fix adds one composed regression (15 total). The final offline image on frozen candidate `4783226c` passed recovery-loop, production, craft-trigger, native-admission and steam-lab; the merged full Docker gate passed with 2,353 runtime/staging and 1,142 mod tests, typecheck and Lua checks, exit 0. Native restart completion holds 12 copper plates with zero replay dispatches. Pending-timer cancellation also passes. See [unit-18 checkpoint](UNIT18_RECOVERY_ENGINE_2026-10-15.md) for fixture limits, source/image identity and evidence paths.

Units 17 and 18 were pushed together to `origin/experiment/jev-agent-architecture` at `451bd0e1` on October 15. The full local server image and offline packaging/startup/shutdown checks now pass; the older root checkout's uncommitted documentation was preserved. See the [integration checkpoint](UNIT17_18_INTEGRATION_2026-10-15.md) for exact image identity and evidence.

Run J was authorized and concluded after 12 minutes on October 15. Native copper collection progressed to 10 held plates, then iron to 50 held plates, but the completed-slice planner boundary failed with `checkpoint_requires_active_step`. All 40 provider calls succeeded; no auto-resume occurred. Save/traces are preserved and the isolated stack is down. See [run J checkpoint and proposed bounded fix/regression](LUNA_GREEN_LIVE_RUN_J_2026-10-15.md).

The completed-slice checkpoint fault is repaired as unit 19 (`2e24b74f`, merge `01424bcd`). Five full-loop regressions, the unit/merged canonical static gates and all five native prerequisite lanes pass; independent review found no concrete blockers. See [unit 19](UNIT19_COMPLETED_SLICE_CHECKPOINT_2026-10-15.md). No live Pterodactyl deployment was changed. Autonomous green science remains unproven.

Louis authorized one further longer CLI-proxy trial on October 15 after the fix and checks. Run K's build and deployed-file/cold-world preflight passed on `bcc4e843`. It ran 40m36s, crafted a lab, unlocked red science, produced 21 packs and continued through three bounded auto-resumes, with zero harness-state faults. It stopped at a separate queued-withdrawal/craft-admission timing mismatch; the partial prefix is retained. See [Run K and its proposed regression](LUNA_GREEN_LIVE_RUN_K_2026-10-15.md).

Run K is concluded, stack down and save/full traces preserved. The new admission-time stock fix and static/native full-loop regression remain open before another trial, which requires a new owner's go. Existing limits and the usage floor were unchanged; no arbitrary duration cutoff or corrective gameplay was used. Autonomous green science remains unproven.

## October 15: unit 20 follow-up

Louis authorized the Run K fix, static/native full-loop tests, integration and one further CLI-proxy trial. Reviewed code/tests `da8d3bdb` are locally integrated at `d16a15db`. The craft preflight's current-stock rejection now takes the existing bounded argument-correction path before dispatch, even when the execution ledger credits future stock. Six static full-loop scenarios and the native queued-craft control/proof reproduce the original defect and verify receipt-separated recovery. Frozen and merged canonical checks and all six native lanes pass; reviewed integration is ready to push. See [unit 20 checklist](UNIT20_QUEUED_CRAFT_ADMISSION_2026-10-15.md). Red/green automation follows the research-unlock trial and requires measured native assembler/inserter output and lab continuity.

Unit 20 was pushed at `0fbc4bff`. The server build and deployed/cold verification passed. The one authorized [Run L](LUNA_GREEN_LIVE_RUN_L_2026-10-15.md) ended after 4m30s at an invalid-unit-reference submission followed by closed-observation recovery and unsupported-blocker exhaustion. Green science remains unproven; the Unit 20 live condition was not reached. Save/traces preserved and stack down. A concrete invalid-reference/checkpoint-scope regression gate precedes another authorized trial; limits and authority are unchanged.
