# Luna GPT-6 proxy live run C — October 13, 2026

## Setup (owner go)

- Code: `572d4600` (merge of unit 3, active-step fact handoff). Checkpoint docs at `d76f0746`. Evidence is in `test-results/luna-gpt6-live-2026-10-13c/`.
- Deployment verified against the candidate: 48 shipped runtime modules compared, 0 mismatches. The active control file matches the release. Jev token present.
- Provider: the owner's CLI proxy (method `local`), Luna model `gpt-6-luna`. Endpoint details are kept out of this document.
- Cold start: fresh generated world, isolated Compose project, empty data directory, zero connected humans, speed 1. Actor `20`, epoch `1`, standalone character. Starter kit only (1 burner mining drill, 1 stone furnace, 8 iron plates).
- Objective: "research logistic science" (green science, `goal_05sw4t7_1`).
- No corrective prompts and no operator gameplay after the starter kit.

## Result: `controller_paused` on the first step, no gameplay executed

- Request `req_mv64d4rf_1`, started `2026-10-13T03:26:28Z`. The request ran about 46 s from receipt to completion (`request.time_split` wall 45,799 ms). The harness trial recorded `elapsed_ms` 60,255.
- 7 Luna provider calls (`provider.request` rows) and 5 Jev decision calls. No provider or HTTP errors.
- Planner committed plan `goal_05sw4t7_1_p3` v1 with one step: "Produce 10 copper plates to trigger electronics". Its completion contract is `copper-plate >= 10` and `research_completed electronics`.
- Executor restage at checkpoint C3 (handoff `ho_c6fdbb4035a0`): packet 4,915 chars. Carried 4 recipe facts, 1 research path, 9 fresh items, 0 stale items, 2 residual needs. Recipe closure prefetch read 2 roots, found 2.
- Residual needs: `copper-plate required=10 held=0 missing=10`, and `copper-ore required=10 held=0 missing=10`. No acquisition fact for copper ore was in the packet.
- The packet's recipe facts included Space Age recipes (`copper-ore-recycling`, `asteroid-crushing`) that do not apply to the base game being played.
- Executor observation budget: 4 reads, then `recovery.classified` `jev_observation_budget_complete` with tools disabled. The reads were:
  - `getInventoryItems` (1 burner mining drill, 1 stone furnace, 8 iron plates);
  - `getNearbyEntities` radius 32, type `resource`: 0 results;
  - `getNearbyEntities` radius 16, name `stone-furnace`: 0 results;
  - `getRecipeDetails` `copper-plate`.
- Goal evaluation: `0/1` conditions met.
- Action-omission recovery (`recovery.action_omission_started`, one act-or-block call). The model answered BLOCKED: "I have no copper ore, and the live recipe data shows 10 copper ore are needed... I can't verify an executable way to acquire it from the available observations."
- `outcome.candidate` `world_blocked` was rejected with `world_blocked_without_authoritative_evidence`.
- `outcome.candidate` `recoverable_provider_failure` (`provider_reported_blocker`) was then validated. The task board moved to `paused` with `pause_reason` `recoverable_provider_failure:provider_reported_blocker`, and `goal.paused` fired. The goal is resumable with "continue".

## Verdict

- **Not green science.** The first autonomous step was not executed. No copper ore was mined or smelted, no copper plate was made, and `electronics` was not triggered.
- Operator gameplay after the starter kit: 0. Connected humans: 0.
- This run is evidence for the findings below, not for capability.

## Findings

1. **Raw leaves lack native acquisition facts.** The packet says copper ore is missing but does not say how to get it (mine a resource patch, which the observation radius found empty). The model had no grounded route, so it could not act. Fix in progress: unit 6.
2. **A rejected, unverified blocker still pauses autonomy.** The harness rejected the `world_blocked` candidate as lacking authoritative evidence, then accepted the same text as `recoverable_provider_failure`. The goal paused with no new evidence. The pause path should not be reachable from a rejected blocker.
3. **Executor observation budget is exhausted after 4 reads.** The budget ended the decision before the model could follow up on the empty resource scan (for example a wider radius or another resource search).
4. **Recipe closure carries Space Age recipes.** `copper-ore-recycling` and `asteroid-crushing` appeared as recipe facts for a base-game goal. They add noise to the packet and can offer routes that do not apply.
5. **`run-check` does not flag this pause shape.** `run-check.mjs` reported "No known failure signatures found" for 1 request and 99 rows. The rejected world-blocked candidate followed by a validated recoverable pause was not treated as a finding.

## Follow-up

- Unit 6 (raw-leaf acquisition facts) started 2026-10-13. It is the first design fix. Each finding above gets a static fixture using realistic output sizes before any further live run.
- Queued: blocker-rejection pause (finding 2), the run-check gap (finding 5), and the observation budget and recipe-closure scoping (findings 3 and 4).
- The next live run waits for the owner's go, or for the standing allowance window (at most one agent-started e2e per 5-hour window, once it is more than 60% used).

## Earlier attempts on this build (runs a and b)

- Runs a and b were stopped before the goal was sent, because of provider configuration (a wrong model id, and a stale base URL).
- They produced no gameplay evidence and are not counted in this checkpoint.
