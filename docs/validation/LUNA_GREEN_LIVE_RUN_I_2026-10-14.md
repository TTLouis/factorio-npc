# Luna green-science live run I (2026-10-14)

## Candidate and setup

- **Candidate:** commit `9e4ef5a0`, units 7–14.
- **Gates:** 2328 runtime tests pass. The production, craft-trigger, native-admission and steam-lab engine lanes all pass.
- **Deployment:** verified in the container against `expected-runtime.json`. Model `gpt-6-luna` through the CLI proxy, with Jev on.
- **Approval:** the owner approved this run in chat ("go, start run I").
- **World and start:** a freshly generated world (isolated compose project, empty data dir), seed 2433756922, actor 5, zero humans, game speed 1. Run E's starter kit and objective.
- **Timing:** started 20:21:41Z; ended 20:29:06Z with driver result `auto_resume_exhausted`.

## What worked

- **Goal admission.** The goal was admitted as `goal_1xmbgcu_1`.
- **Executor actions.** The executor gathered copper ore and coal, placed a stone furnace and fuelled it. The furnace smelted copper, and the NPC took 9 copper plates into its inventory.
- **Unit 14 live.** `recovery.auto_resume_plan_resumed` fired on all 6 auto-resumes. Each restage ran on an active plan, with no `checkpoint_requires_active_step` (run H's stop).
- **Unit 14 facts.** `context.placed_machines_carried` fired on every restage, each with one fresh furnace read.
- **Unit 7 cap.** The cap worked as designed: per-step attempts reset on progress, and the goal stopped at 6 of 6 (`recovery.auto_resume_exhausted reason: goal_limit_reached`).

## Stop: the residual ignored stock in the machine's output

- **Step.** The active step was "Produce 10 copper plates for the electronics trigger", contract `inventory_count copper-plate>=10`.
- **Where it stuck.** From 20:25 onward the NPC held 9 plates.
- **Packet facts on the last restage** (fresh reads):
  - `held_counts`: copper-plate=9, copper-ore=0.
  - `placed_machines`: stone-furnace unit=13, machine_fuel={coal:9}, machine_source=empty, machine_output={copper-plate:3}.
  - `residual_needs`: copper-plate missing=1, crafts=1, plus copper-ore missing=1. `raw_leaf_acquisition` then pointed at mining copper ore.
- **Contradiction.** The furnace's own output already covered the shortfall. The native transfer `move_items_exact to_entity=false` was available. But the deterministic residual counted only the actor's held stock, so it told the model to mine and smelt one more ore.
- **Model's response.** The executor (GPT-6) answered 8 times with `BLOCKED: ... can't verify ...` and no operations. Each claim was rejected (`world_blocked_without_authoritative_evidence`), recovery was exhausted (`unverified_blocker_recovery_exhausted`), and the goal paused as model_recoverable. Once (20:28:26) it moved 1 ore into the furnace, then claimed again that it was blocked before the plate was collected.

## Model configuration observation

- `requested_thinking_mode` was `not_sent` on every provider call. Reasoning tokens were zero on 48 of 54 responses here, and 22 of 32 in run H. Most executor replies were under 100 output tokens.
- Whether to send a reasoning setting for the CLI-proxy model is a provider-configuration decision for the owner. It is not changed here.

## run-check

`run-check.mjs` read 7 requests and 875 rows, with no parse errors.

Findings:

- `restage_loop`, 1: the executor restaged 8 times for one step with no step verified in between.
- `stale_step_tracker_behind_batch`, 4: step_1 stayed active after batches 4, 5, 7 and 9 completed. Expected here, since the contract was unmet at 9 of 10.
- `no_chat_reply`, 2: `request.failed` carries no `chat_message` field.
- auto-resume exhausted, 1: goal limit, step 1 of 2, goal 6 of 6.

## Fix: unit 15

- Count a placed machine's FRESH output toward the step residual, with the machine's identity, the native transfer stated as a fact, and the crafts and ore demand netted.
- Stale observations are never credited.
- Trigger-production rows stay unchanged.

## Not reached

No red science, research, or logistic-science-pack.
