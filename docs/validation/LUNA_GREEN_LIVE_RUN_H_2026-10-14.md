# Luna green-science live run H (2026-10-14)

## Candidate and setup

- **Candidate:** commit `49c490e2`, units 7–13.
- **Deployment:** verified in the container.
  - All 50 runtime modules and 31 mod files match the commit.
  - Model `gpt-6-luna`, method `local`, with Jev on.
  - Container DNS to the provider resolved.
- **Approval:** the owner approved this run in chat.
- **World and start:** a freshly generated world (isolated compose project, empty data dir), seed 1250820996, actor 11, zero humans, game speed 1. Run E's starter kit and objective.
- **Timing:** started 18:04:31Z; ended 18:11:32Z with driver result `request_failed`.

## What worked

- **Goal admission and requirements.** The goal was admitted as `goal_0w5wy5j_1`, and the harness requirements read ran.
- **Executor actions.** Steps verified natively. The stone furnace was placed and fuelled with 9 coal, and it smelted copper (4 plates).
- **Past run G.** This run got past run G's stall point.
- **Unit 13 live.** `operations.refusal_budget_reset` was seen on both restages.
- **Unit 7 live.** The auto-resume fired twice (attempts 1 and 2 of the per-step limit of 2).

## Stop: an unverified world-blocker claim ends autonomy

- **Pause.** At 18:10:41Z a rejected unverified world-blocker claim exhausted its recovery. The goal paused as model_recoverable (`provider_action_omission_repair_failed`, request `req_mv8f6png_1`).
- **Restages with the board paused.** Both auto-resume restages ran with the task board still `status: paused`. The auto-resume path never makes the RUN_RESUMED transition that a player's continue makes.
- **Attempt 1.** The executor sent no operations, and the plan paused again.
- **Attempt 2.** The executor sent a valid checkpoint (`inventory_count iron-plate >= 50`) with no operations. `persistPlannerCheckpoint` threw `checkpoint_requires_active_step` (non-recoverable), giving a GUARD pause `runtime_recovery_failed` (restage request `recovery_mv8fevzk`). Autonomy ended.
- **Run G revisited.** Run G's apparent auto-resume success only worked because operations run on a paused plan, while checkpoints do not.

## Model-side misread on the restage

- Luna said there was no furnace fuel and that the furnace was "configured for copper".
- In fact the furnace held 9 coal (fuel), 5 copper ore (source) and 4 copper plates (output). The NPC held 42 iron ore and no coal.
- Open question: does the restage packet distinguish machine fuel from the NPC's held fuel, and does it state the furnace's source slot?

## run-check

`run-check.mjs` read 3 requests and 514 rows, with no parse errors.

Findings:

- `request_failed_unrecoverable`, 1: `checkpoint_requires_active_step`. This is the real finding.
- `restage_loop`, 3: the executor restaged 3 times for one step with no step verified in between.
- `stale_step_tracker_behind_batch`, 1: step_1 stayed active after batch 8 completed.
- `no_chat_reply`, 1: `request.failed` carries no `chat_message` field.
- `model_recoverable_pause_not_resumed`, 1: a **false positive** here. The pause was superseded by the guard pause in the same request, so no auto-resume decision was expected. Fixed in unit 14.

Informational:

- `later_contracts_deferred`, 1.
- `contract_bound_just_in_time`, 1.

## Fix in progress: unit 14

- Auto-resume makes the real resume transition before restaging.
- A leftover harness-state invariant becomes a declared system pause.
- The burner-machine facts are checked.
- run-check's `model_recoverable_pause_not_resumed` false positive is fixed.

## Not reached

No red science, research, or logistic-science-pack.
