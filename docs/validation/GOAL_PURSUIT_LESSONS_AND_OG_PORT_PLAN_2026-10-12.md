# Goal-pursuit experiment: lessons and OG port plan (2026-10-12)

Status: porting. Unit 1 is merged; see [Build status](#build-status). The owner chose the original
(OG) staged planner/executor harness on 2026-10-12; the opt-in direct goal-pursuit loop
(`SGLUNA_GOAL_PURSUIT_MODE=direct`) is concluded as a dead end.

## Where things are

| Item | Location | Note |
|---|---|---|
| OG integration branch | `origin/experiment/jev-agent-architecture` @ `30cb9b99` | Has none of the fixes below |
| Pursuit branch | local `experiment/goal-pursuit-harness` @ `61b35e19` | **Not pushed to origin.** Lives only in the shared repo refs (checked out by Codex at `D:/SideProjects/airi-factorio-npc/goal-pursuit-harness`) |
| Codex's final comparison | `goal-pursuit-harness/docs/validation/GOAL_PURSUIT_VS_LEGACY_2026-10-11.md` | **Untracked** in Codex's checkout |
| Attempt log | `docs/validation/GREEN_SCIENCE_PURSUIT_WORK_2026-10-10.md` (pursuit branch) | Attempts 1–36 |
| Raw evidence | `goal-pursuit-harness/test-results/green-science-pursuit-20261010/attempt-NN/` | Gitignored, local only |

Before porting, ask the owner whether to push the pursuit branch (or an archive tag) so the
source commits survive if Codex's checkout is removed. Do not edit Codex's checkout.

## What was learned

1. **The loop shape did not work.** One model call per turn chose observations, an action
   batch or a pause. Only 14–29% of calls dispatched actions (attempt 28: 44 batches in 320
   calls; attempt 33: 45 in 317). Most of the budget went on re-observing.
2. **Bigger allowances did not move the frontier.** 30 calls/20 min (attempts 1–17) gave ore
   only; 60–120 calls/1 h (18–21) gave a few plates and gears; 500 calls/1 h/50M chars
   (22–36) gave at most 75 red packs. No research ever completed and power was never built.
3. **Prompt rules piled up.** `PURSUIT_PROMPT` grew a behaviour rule per failure. This is the
   pattern the "facts, not prompt advice" rule forbids. None of those rules should be ported.
4. **The useful output was native admission gaps.** Most failures were the mod accepting work
   it could not complete (occluded targets, empty radii, missing held items, competing
   supplies, unreachable centres). Both harnesses share that layer, so those fixes are the
   real value of the 36 attempts.
5. **Power is the real blocker.** Attempt 30 queued research that stalled with `no_power`.
   Attempt 33 was refused an offshore pump craft (`bootstrap_dependency_unresolved`) and a
   boiler placement (`placement_item_missing`). Green science needs steam power, and fluid
   systems are still known-red in `NPC_PRODUCTION_VALIDATION_ROADMAP.md`. No harness should
   retry green science live until steam power is proven by an exact-layout real-engine fixture.
6. **Uncertain operations froze pursuit.** Its `TERMINAL` set excluded `ADMITTED_CANCELLED`, so
   any native cancel paused the campaign with `uncertain_operation:*`. OG already treats
   `ADMITTED_CANCELLED` as settled (`npc-agent-loop.mjs` ~8004/~8096). Keep it that way.
7. **Pins are not portable.** Every pursuit fix was followed by a `build: pin ...` commit. Do not
   cherry-pick those. Repin once per OG unit per AGENTS.md.

## Port list

### Keep: native/mod correctness (port first)

Mostly `packages/autorio`. Several commits also touch `pursuit-runtime.mjs`; port only the
mod/staging parts. Their real-engine fixtures live in `tests/factorio/runner/pursuit_factorio.mjs`
and need OG-lane equivalents.

| Commit | Fix | Files to port |
|---|---|---|
| `5ebebdbc` | Exact ore under overlapping tree boxes | `mining_reach.ts`, mining-reach test |
| `aa44967e` | Exact natural harvest targets under overlapping trees | `mining_reach.ts` |
| `37c776bb` | Occluded natural targets | `harvest.ts`, `mining_reach.ts` |
| `12efe768` | Resource source must exist in radius | `control.ts`, `transfer_preflight.test.ts` |
| `44b5e241` | Natural harvest source in radius | `control.ts`, `harvest.ts` |
| `7129b529` | Finite-tile amount check | `control.ts` |
| `b84919aa` | Held placement item preflight (both native paths) | `placement_candidates.ts`, `placement_preflight.ts`, `control.ts`, staging `structured-policy.mjs` |
| `56cc1391` | Unsupported exact recipe machine | `control.ts` |
| `50e4ec03` | Absent navigation target | `control.ts` |
| `a6e58a94` | Unreachable placement-centre navigation guard | `navigation_position_preflight.ts`, `control.ts`, staging `structured-policy.mjs` |
| `3562d0bd` | Mixed supplies with a missing source | `transfer_preflight.ts` |
| `b02caea7` | Zero-transfer mixed supplies | `transfer_preflight.ts` |
| `b70c5eb9` | Competing single-slot supplies | `transfer_preflight.ts` |
| `402f8d66` | Human transfer availability | `control.ts`, staging `structured-policy.mjs` |
| `1efbdefc` | Natural-only harvest and pending receipts | `harvest.ts`, `operation_admission.ts`, `control.ts`, `types.ts` |

`1efbdefc` adds a new remote operation, `harvest_natural_product` (natural sources only). In OG
that is a tool-contract change, so check how it should be exposed before wiring it.

### Keep: facts and diagnostics

| Commit | Fix | Files |
|---|---|---|
| `12364d63` | Machine power/status facts | `tools.ts`, `prototype_knowledge.ts`, `goal_world_conditions.ts` (skip `pursuit-knowledge.mjs`) |
| `e9fcfcc7` | Bounded fluid source observation | `fluid_source_observation.ts`, `tools.ts`, `contracts/factorio-tool-contract.json`, `structured-policy.mjs`, steam replay golden |
| `41919e4e` | Provider response-stage/byte diagnostics | `provider-base.mjs` + tests. Port the diagnostics only, not the pursuit tool switch. Keep the CLI-proxy hostname out of the repo |

### Adapt: batch-wide stock accounting

`b70c5eb9` (staging part), `a29d3051` and `6d3488a1` are pursuit-runtime only today. The idea is
sound: don't admit a batch whose withdrawals or crafts together exceed observed stock. In OG it
has to be dependency-aware, through `NpcAgentLoop.preflightOperations` and
`transferBatchDependency`, so a craft that produces an ingredient for a later step still counts.

### Adapt: fact handoff to the active step

All pursuit-only modules today. Port the concepts as harness facts on the active OG step, not as
prompt text:

- `765282d2` recipe quantities
- `15b370a0` bounded prerequisite knowledge (`pursuit-knowledge.mjs`)
- `9d40e5dc` historical entity references
- `886e359f` historical fluid locations
- `169772cb` machine stock refresh before decisions
- `fad1cad8` reads kept after no-effect admission refusals

### Leave

- The pursuit loop, `submitPursuitDecision` protocol and `controlProtocol` switch
- All `PURSUIT_PROMPT` behaviour rules
- `68b37357` decision-array correction
- `ee9fa8af` Luna reasoning-profile pinning
- Enlarged allowances and the trial/monitor/watchdog machinery
- All `build: pin ...` commits

## Recommended unit order

1. **Native mod fixes** (the first Keep table). One or two units. Unit tests plus an OG
   real-engine lane equivalent for each fixture in `pursuit_factorio.mjs`.
2. **Facts and diagnostics** (power, fluid source observation, provider diagnostics). The tool
   contract change needs its golden updated.
3. **Active-step fact handoff** (the second Adapt list), as harness facts.
4. **Dependency-aware batch stock accounting** in `preflightOperations`, with OG dependency tests.
5. **Steam-power exact-layout fixture** under `tests/factorio/`: offshore pump → boiler → steam
   engine → pole → powered lab, verified by semantic output (lab powered, research progress),
   not placement. This is the gate before any live green-science attempt.

Each unit follows the AGENTS.md merge protocol: unit worktree, reviewer, `bash scripts/test-local.sh all`
green, repin the installer payload if shipped files changed, push to the integration branch. Every
behaviour change gets a named trace event with `request_id` and a reason. No live e2e without the
owner's go.

## Build status

| Unit | Commits on `experiment/jev-agent-architecture` | Status |
|---|---|---|
| 1. Native mod fixes | `2530d3c8` `7f469a5d` `b17b12a8` `926e97c2` `c2ac975a`, merge `969fefb2`, follow-ups `6fabdf5d` `afa0aa40` `db8bfae0` `a0647b49` | Merged. Static gates green. The `native-admission` real-engine lane, the OG equivalent of the `pursuit_factorio.mjs` fixtures, passed on 2026-10-12. |
| 2. Facts and diagnostics | 2a merge `175cde97`; 2b merge `7b23ae71`, `a8021ed5`; 2c `f01225e9` `ab39ab76` `1cd94b4c` `35c0f5d5` `1d81df66`, merge `e818d83a`, installer repin `ce4b025e` | Merged. Gate green; `native-admission` lane PASS. |
| 3. Active-step fact handoff | `7acf4ccb` `7e4cd887` `645ec17f` `f0fc5ac8`, merge `572d4600` | Merged. Gate green; `native-admission` lane PASS. |
| 4. Dependency-aware batch stock accounting | — | In progress |
| 5. Steam-power exact-layout fixture | `481a1196`, evidence `133504ff` | Merged locally. Focused steam-lab and full production engine lanes passed; native powered lab research progresses with seeded science/prerequisites. |
| 6. Raw-leaf acquisition facts (run C follow-up) | `ab2290f3`, merge `015c2ab3` | Merged. Bounded native source facts; static gate green, not live-validated. |
| Run C blocker recovery and diagnostics | `fdb55d72`, merge `b974dc97`, repin `473327a0` | Merged. Rejected blockers use durable bounded recovery; original run C diagnosed. Combined 2,129 runtime + 1,105 mod tests and 9 payload tests passed. See [checkpoint](LUNA_RUN_C_STATIC_FOLLOWUP_2026-10-13.md). |

Additional run C fixes: recipe applicability `5c9826cb` and bounded resource observation recovery `ec2f359a` are reviewed and merged locally. Combined gate:2,136 runtime/staging and1,107 mod tests, typecheck and generated Lua passed. See [red-to-green checklist](GREEN_SCIENCE_RED_TO_GREEN_2026-10-13.md) for remaining candidate gates and the one-run authorization.

Unit 1 notes:

- `harvest_product` is natural-only: it takes neutral trees and rocks with no `last_user`, and fails closed. Rocks are `is_building` in the engine, so the guard excludes only placed buildings (`db8bfae0`); the pursuit source wrongly excluded rocks. No separate `harvest_natural_product` op or contract change. Fish is no longer a harvest source.
- In the OG loop, argument-error refusals get the one bounded model-correction turn:
  - malformed radius, position or count;
  - a reach inside a furnace collision box;
  - an expired placement candidate;
  - a product that no tree or rock yields.
- World-in-radius refusals go through the existing `blocked_preflight` path, with an MW5 replacement attempt. These are `resource_source_not_found`, `navigation_target_not_found`, `natural_harvest_source_not_found`, `resource_source_insufficient`, `supply_destination_conflict` and `player_unavailable`. That policy is awaiting the owner's decision.
- `placement_item_missing` is deferred when an earlier operation in the same batch can supply the item. That deferral is traced as `placement.preflight_item_deferred`.
- Real-engine proof:
  - Done: trees, rocks, held-item placement, craft-then-place, exact ore under a tree.
  - Not done: a player-touched natural entity, because one can't be made with zero connected players. The `operation_admission` nil-hole fix has unit tests only.

Unit 2 notes:

- Machine facts (2a): `getEntityStatus` now reports `status_name`, `energy_source`, `energy` and `electric_network_id` for machines.
- Fluid terrain reads (2a): a new bounded tool, `getFluidSourceTiles`, reports fluid source tiles. The tool contract golden is updated.
- Wrong entity names (2a) are refused as `unknown_entity_prototype`. The observation traces are `observation.fluid_sources_observed` and `observation.entity_read_refused`.
- Seam bug (2a): `supervisor-adapter.mjs` `transformNearbyEntities` turned an `ok:false` refusal into an empty scan. It now forwards `ok:false` unchanged.
- Provider timeouts (2b): timeout traces carry `response_stage`, `response_bytes`, `http_status` and `response_content_type`. The `reading_error_body` stage is real (`a8021ed5`).
- Refusal classes (2c): every mod preflight refusal declares a class from the closed set `argument | authority | prerequisite | world`. The registry is `packages/autorio/src/refusal_classes.ts`, stamped in `autorio_preflight.operation`. The OG loop picks recovery by that class. `argument` gets the one correction turn. A missing or unknown class fails closed to `world` and emits `operations.preflight_unclassified`. `invalid_name` and `unknown_technology` are now `argument`.
- Why (2c): a new refusal code can no longer take the wrong recovery path silently. A static guard test fails if a refusal literal in the mod has no class. The shared class set ships with the installer as `deploy/pterodactyl/runtime-v8/refusal-class.mjs`.
- Open: the "nothing found in radius" codes stay `world`. The planner-wake list in `replacement-wake.mjs` and `TRANSFER_SUPPLY_PREFLIGHT_CODES` are similar hand lists that could later come from the producer.

Unit 3 notes:

- Water anchors (3a): validated `getFluidSourceTiles` answers become historical anchors (at most 16, 4000 chars, keyed `surface:x:y`). They reach executor restages as a `fluid_source_hints` record labelled historical, to be re-checked before placing. An empty or failed read never erases them. They last for the goal, through chat amendments and "continue", and clear on a new goal, goal completion or process restart. Trace: `context.fluid_source_hints_carried`.
- Recipe closure (3b): at restage the harness reads `getRecipeDetails` for step roots it has not seen, breadth-first, at most 8 reads per handoff. It never reads while a batch is in flight, and it runs inside the actor/epoch fence; a fence change refuses the restage and rolls it back. A lab root now yields circuit and gear crafts, not a one-row "missing". Trace: `context.recipe_closure_prefetched`.
- `normalizeRecipeFact` marks a recipe incomplete when an amount is missing or a probability is out of range.
- The mod's no-recipe answer declares `code: 'no_recipe'` (raw items such as iron ore), so the harness remembers it instead of matching error text.
- Not ported, on purpose: raw historical entity ids and positions (OG withholds them so stale targets are not reused), and pursuit's reads kept after a refusal (OG never lost them).
- Deferred: fresh reads of known machines at restage (3c), until a steam-chain scenario shows the need.
