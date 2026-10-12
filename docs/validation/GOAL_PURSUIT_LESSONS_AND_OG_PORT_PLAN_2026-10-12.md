# Goal-pursuit experiment: lessons and OG port plan (2026-10-12)

Status: handoff. **Nothing below has been ported yet.** The owner chose the original
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
