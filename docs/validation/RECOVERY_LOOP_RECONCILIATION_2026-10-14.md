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
| Native `recovery-loop` lane | **Planned as unit 18**, after unit 17 is green. It runs the furnace G+H+I chain on the real engine with scripted provider replies. | The fake furnace in unit 17 is invented physics. The engine proves the slots, smelting and transfer. |

## Entry criteria for run J

- [ ] Unit 17 composed scenarios pass: G→H→I reaches verified completion, plus restart, cancellation and no-replay.
- [ ] Any defect a composed scenario exposes is fixed in its own commit, with no change to authority or limits.
- [ ] Unit 18 native recovery-loop lane passes, or it is listed below as an open blocker with the owner's call.
- [ ] `bash scripts/test-local.sh all` passes, and the production, craft-trigger, native-admission and steam-lab lanes pass on the frozen candidate.
- [ ] The installer repin is current (needed only if `payload-src/installer.sh` changed).
- [ ] The image is built from the pushed candidate, and the deployment is verified file by file.
- [ ] The owner says go for run J.

## Candidate and open blockers

To be filled in as the units land.
