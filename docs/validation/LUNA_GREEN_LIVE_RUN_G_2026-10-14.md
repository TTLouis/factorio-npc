# Luna green-science live run G (2026-10-14)

## Candidate and setup

- **Candidate:** commit `ec6b8385`. It is the same candidate as run F (`LUNA_GREEN_LIVE_RUN_F_2026-10-14.md`) and includes units 7–10.
- **Deployment:** verified in the container.
  - The 50 runtime modules match the commit, and the 31 mod files match the release.
  - Model `gpt-6-luna`, method `local`, with Jev on.
  - Container DNS to the provider resolved.
- **Approval:** the owner approved this rerun after Tailscale was reconnected.
- **World and start:** a freshly generated world (isolated compose project, empty data dir), actor 18, zero humans, game speed 1.
- **Starter kit and objective:** the same as in runs E and F.
- **Timing:** the run started at 13:13Z. It was stopped by the operator through the driver's stop file at about 13:45Z, after 28 idle minutes.

## What worked

- **Goal admission and planning.**
  - The goal was admitted with a new goal_id (`goal_0iaqbdn_1`).
  - The harness requirements read ran before commit.
  - A one-step plan was committed: the electronics and steam-power research triggers.
- **Executor actions.**
  - The executor's batches were admitted and completed natively: 50 iron ore and 10 copper ore were mined.
  - A stone furnace was placed (placement receipt recorded).
- **Unit 7 live.**
  - At 13:16:34Z the executor's unverified world-blocker claim exhausted the fresh-context recovery, and the goal paused as model_recoverable.
  - `recovery.auto_resume_scheduled` (attempt 1) fired, and `recovery.auto_resume_started` followed at 13:16:50Z.
  - A fresh restage then continued the step, and its next batch passed preflight.
  - This is the first live proof of the model-recoverable auto-resume.

## Stall: an uncorrected world-class preflight refusal ends autonomy silently

- **The batch.** At 13:17:35Z the executor submitted:
  - operation 1: `gather_resource coal 10`;
  - operation 2: `supply_entity` into furnace 34 with `{coal 10, iron-ore 50, copper-ore 10}`.
- **The refusal.**
  - The batch stock ledger credited the coal gather.
  - Preflight refused operation 2 with `supply_destination_conflict`: iron-ore and copper-ore both target the furnace's only one-slot source inventory.
  - The refusal itself is correct.
- **What happened next.**
  - The refusal's class is `world`.
  - The MW5 replacement wake skipped it (`blocker_not_world_evidence`, `code_not_world_change`).
  - The request ended `blocked_preflight`, and the board step became `blocked`.
  - `run.paused` stayed false, so no auto-resume applied, no further request was made, and the NPC stayed idle with an active goal.
  - The refusal's facts (slot count, per-item counts) never reached the model.
- **Fix in progress:** unit 12.
  - A world-class preflight refusal gets one bounded correction turn carrying the refusal facts.
  - If it is still refused, the goal pauses as model_recoverable, so unit 7's capped auto-resume restages it.
  - run-check gains a `silent_blocked_stall` finding.

## run-check

`run-check.mjs` reported two findings:
- `restage_loop`, three times;
- `stale_step_tracker_behind_batch`, once.

Both follow from the single coarse step: one research-trigger step spans many batches, and ore mining is not step-verified progress. Neither caused the stall. run-check did not flag the stall itself; that is the gap unit 12 closes.

## Not reached

No smelting, red science or research happened. logistic-science-pack was not researched.
