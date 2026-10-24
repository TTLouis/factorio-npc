# SGLuna Factorio — NPC Agent Harness Status

This file is the current status summary for the single-NPC integration line. Historical detailed checkpoints are retained under `docs/validation/`.

## October 23: Run AT verified entity recovery, then polling guard exhaustion

[Run AT](validation/RED_AUTOMATION_LIVE_RUN_AT_2026-10-23.md) tested reviewed
`9b403767` in one cold accelerated trial with Luna read-only overwatch. The harness
renewed furnace 3's missing request binding, collected the existing ten copper
plates and verified the original checkpoint without corrective model/operator work.
That was one successful entity-refresh episode; the residual admission and gather
recovery variants were not exercised in this live run.

The science goal failed after 10m31.795s at the strict stop boundary: the controller
exceeded its 1,200 control reads per minute and safely guard-paused. All 39 sprint
bursts restored. Six of seven committed steps completed; a direct burner-drill to
furnace iron chain produced 41 plates, but no science was produced. The next
failure is control-poll amplification/budget exhaustion, not the repaired AS binding.

The report includes complete 42 CLI / 36 Jev usage, recovery/tool/native/timing
accounting and actual plans, with unavailable price/thinking telemetry explicit.
Strict paired stop, save integrity, pristine 2.0.77 load and owned cleanup passed.
No second trial, corrective gameplay prompt, manual resume, push or deployment.

## October 23: reviewed Run AS entity-refresh repair

The [entity-refresh repair](validation/RUN_AS_ENTITY_REFRESH_FIX_2026-10-23.md)
was merged locally at `6beb6dc7` after independent approval of `9a3c9e42`.
The harness can refresh a recorded same-epoch NPC machine's expired exact binding
across typed observation, mutation validation and residual admission. It discards
the old proposal, reconciles fresh stock, and collects proven existing output
through the durable production controller. Restored tasks retain wait/crafting,
native-work, ownership and shared recovery-budget fences; uncertain or exhausted
correction pauses visibly. Committed steps and checkpoint authority are unchanged.

41 new runtime regressions include the exact AS replies and a composed residual
Session recovery. Both exact positive cases fail on the unchanged baseline for the
original reasons. Candidate and merged gates:3,343runtime/1,378mod, type/Lua and
payload9 PASS; changed-file lint clean. Factorio2.0.77 prevention and residual
cases physically smelted/collected10plates and verified the original checkpoint
at1x/zero humans/zero inference. Independent review approved; all owned Docker
resources removed/verified and sealed AR/AS evidence preserved.

No further live E2E, push or deployment occurred. Autonomous science production is
still unproven. Shutdown-alarm classification and accounting helpers remain Units
B/C in the [next-patch plan](RUN_AS_NEXT_PATCH_PLAN_2026-10-23.md).

## October 23: consolidated candidate after the AR repair and Run AS

The consolidated executable baseline was `cdbc95ed`, with 3,302 runtime / 1,378 mod
tests, type/Lua/payload gates and independent review passed. The
[consolidation record](validation/FIX_CONSOLIDATION_2026-10-23.md) groups the
already-merged fixes by shared harness boundary and records archival/recovery of
completed worktrees. Historical report adoption changes documentation only.

[AR's mining repair](validation/RUN_AR_MINING_RECONCILIATION_FIX_2026-10-23.md)
proves exact native resource selection and bounded acquisition-only partial-batch
reconciliation, including injected residual failure and physical coal-only
continuation. Those proofs are separate from live autonomous production.

[Run AS](validation/RED_AUTOMATION_LIVE_RUN_AS_2026-10-23.md) mined normally and
smelted ten copper plates, then guard-paused on an exact furnace target with no
live observation binding. No science was produced, and the new mining correction
paths were not triggered. Eight control retries yielded five continuations and
three failures; there were no automatic resumes. Stop/save/exact load/cleanup
passed, with one documented sprint alarm during stop confirmation.

The [next patch plan](RUN_AS_NEXT_PATCH_PLAN_2026-10-23.md) targets a bounded
harness-owned identity refresh across observation and mutation boundaries, with
partial-production reconciliation, then separate shutdown/accounting follow-ups.
It is a proposal, not implemented behavior or permission for another trial.

## October 23: accelerated Run AR (historical trial boundary)

The [Run AR report](validation/RED_AUTOMATION_LIVE_RUN_AR_2026-10-23.md) records
six safely restored sprint bursts / 1,836 native ticks, then a gameplay failure
after 4m30s: copper gathering succeeded, coal mining was rejected, and the
partially completed batch remained uncertain. Duplicate-effect protection blocked
continuation. No automated science or factory construction was demonstrated.
Quantity compilation/material-ledger/production-task paths were not exercised.

The accelerator's cold-start clock and first-console confirmation gaps were
repaired and proved in actual Session/native tests before AR. Full merged gates
passed 3261 runtime / 1366 mod tests. AP is an invalid startup trial; AQ is a
zero-inference preflight failure; their separate sealed evidence is retained.
AR passed strict paired stop/save, ZIP integrity, pristine exact-version load and
owned cleanup. A post-stop closed-authority alarm remains documented separately
from zero in-trial sprint faults. Partial-batch effect reconciliation was a gap at
that trial boundary; the later offline AR repair above supplies bounded correction.
Safe refusal alone is not successful self-correction.

## October 23: Run AO controller liveness repair

The [Run AO repair checkpoint](validation/RUN_AO_CONTROLLER_LIVENESS_2026-10-23.md)
separates obsolete advisory predictions from fresh activation ownership. A resumed
activation can author its pending checkpoint JIT; obsolete callbacks and contract
calls cannot bind, charge, clear or pause replacement work. The supervisor detects
an unpaused committed step with no owned work, verifies native idle/empty queues
and persistent-controller status, then reconciles and resumes through the ordinary
recovery path. Durable limits are two attempts per step and six per goal; uncertain
effects and exhaustion pause safely. Scripted exact-AO prevention and residual
recovery pass; this is not a new live gameplay or accelerated-engine validation.

## October 23: finite production controller and one-step prediction

The [Run AN repair checkpoint](validation/PRODUCTION_TASK_CONTROLLER_2026-10-23.md)
adds desired-item quantity compilation, durable material claims/protected checkpoint
stock, and finite harness-owned production intents. The executor can delegate
bounded acquisition, hand crafting, exact machine fueling/input, native waits and
collection. Fresh inventory and exact identities determine each remaining batch;
queued output is never inventory. Existing admission, receipt and completion gates
remain authoritative. Proven pre-admission misses and settled native failures can
recompile automatically within durable limits; uncertain work cannot replay.

One-step contract prediction (P3/P4) is implemented: a single planner side call
starts after native admission and remains non-executable until the next step
activates and passes fresh validation. Stale/failed/material-only predictions use
JIT fallback. It predicts within the current immutable slice; future slices still
refine the Roadmap Shelf from fresh state. A slice outline is not a complete
factory plan.

Deterministic Factorio 2.0.77 validation produced two poles with two native craft
batches, automatically corrected an injected Run AN over-count, and smelted and
collected two copper plates in separate batches, with zero humans and no external
inference. This establishes finite production mechanics, not autonomous red-science
automation. Fluids, multi-output/probabilistic recipes, layout design, machine
placement/configuration and sustained logistics remain outside this task primitive.

## October 22: temporary native construction reservations

The [reservation checkpoint](validation/NPC_AREA_RESERVATIONS_2026-10-22.md)
adds purple/black blocking tiles, durable temporary-surface entity escrow,
verified restoration and a separate blueprint/pin review mode. Native Factorio
2.0.77 proves auto cut/restore across restart, original tile layers, inventories,
blueprint metadata, in-progress furnace state, placement refusal, preserved
intrusions and 37 explicit vanilla prototype round-trips. Review markers and
missing-player refusal are native-tested; actual player approval and UI event
provenance have unit-test proof only. The designer handoff is paged and gated;
no designer inference agent or production capability is promoted.

For the unfinished playable-checkpoint work, preserved candidate refs, review
blockers and settled owner decisions, read the
[October 5 handoff](validation/PLAYABLE_HANDOFF_2026-10-05.md). It accounts for later
ledger/refusal-clearance and goal-requirements changes; the earlier chat handoff
must not be used to reset current integration.

## October 20: Run 19af placement candidates fixed offline (ledger row AF-2)

- **Blocker.** `getPlacementCandidates` returned 8 legal drill candidates, but the rejected-footprint samples (overlapping furnace 31) were listed first, both roles read the answer as blocked, and the candidates sat about 15 tiles from the furnace they should feed.
- **Fix.**
  - The runtime renders the answer with the legal candidates first and the rejected footprints last under `obstructions.label = rejected_footprint_samples_not_candidates` (`placement-candidates-render.mjs`, through the new `renderToolOutput` hook).
  - The request takes `anchor { unit_number }`: candidates rank nearest it (`distance_from_anchor`, `ordering = nearest_to_anchor_first`), the search centres on it with no `center`, and the build never clears it.
  - `placement_clearing.ts` is the one clearance decision. A footprint refused only for ground items, natural obstructions (neutral-force, hand-minable, not a placed building: trees, rocks) and the NPC's own idle entities is a candidate whose `clears` lists those entities. Players' buildings, cliffs and entities in a running chain stay blocked.
  - Placing it walks into hand-mining reach, waits the native mining time, mines the entities into the NPC inventory and builds. The receipt carries `entities_cleared` (with the measured items); refusals are `clearing_inventory_full`, `clearing_unreachable` and `clearing_failed`. Once anything was cleared the batch carries no no-mutation proof.
- **Review fixes.**
  - `place_candidate` now forwards the protected unit numbers (anchor and join target) to the placement task.
  - Running chain also means electric: a pole with any electric entity in its supply area, or any entity with an electric network id, is never cleared. A neutral entity that holds items is not cleared either. An unreadable `last_user` or a full neighbour scan blocks (fail closed).
  - The room check covers every blocker's products and the ground items together before anything is mined, from reads only (`get_insertable_count`, `count_empty_stacks`, stack sizes); the inventory is never written. A failed mine call that moved items or destroyed the entity is recorded in `entities_cleared` and withholds the no-mutation proof.
  - With an anchor, distance to it decides first and a candidate that clears nothing wins ties; without one, candidates that clear nothing come first (`ordering` says which). The open scan runs in square rings outward from the centre. The request filters run before the clearance check, which is memoised per entity and capped at 400 footprint checks per read; when that cap or the scan limit ends the search, `candidates_may_be_incomplete` and a reason sit beside the candidates. The chain scans look at the actor force only. A mine call that failed with the entity still standing is reported as `items_taken_entity_remained`. The runtime trims lowest-ranked candidates (counted, `returned_candidate_count` follows) before it would cut valid JSON.
- **Known limits.**
  - "Own" is same force with no recorded user. In a force shared by several NPCs it also covers another NPC's idle entities; only the running-chain guard protects their working machines. Whether a robot build from a human blueprint carries the human's `last_user` is not verified, and the lane runs with zero humans, so the human-built case has unit-test proof only.
  - The NPC's own idle entities are cleared only through `place_candidate`, and only those the chosen candidate listed in `clears` (the candidate path revalidates against that list). A raw `place_entity`, a construction plan or any other placement path clears ground items and natural obstructions only and refuses a footprint held by the NPC's own build with `not_placeable` (the native production lane's overlapping-drill refusal).
  - A cleared own entity's unit number can still be held by an earlier read, which then gets `target_gone`.
- **Proof.** Unit tests with a fake world, plus the native `placement-clearing` lane in Factorio 2.0.77 (zero humans, real actor). It passed locally on 2026-10-20 (tree, rock and idle own chest cleared after the native mining time, +4 wood, +20 stone, +1 chest, equal to the receipt; another force's chest, a loaded chest, a cliff, a pole supplying a lab and the lab stay blocked, a lone pole is a candidate; a full inventory refuses with `clearing_inventory_full` and keeps the no-mutation proof; the anchor ranks clean candidates and places through `place_candidate`). The lane is not wired into CI and no evidence file is committed. Not live-tested.

## October 19: Run AF placement pickup receipts fixed and verified natively

- **Blocker.** The Run AF preflight review of `3fe2bcbf` found a false no-effect proof. A placement could pick spilled ground items into the NPC inventory and then fail, but its batch still carried `failed_before_mutation`. Admission and runtime reconciliation then settled it as a refusal.
- **Fix.**
  - Measured pickups are tracked on the task across every later failure: inventory full, native recheck, `create_failed`, and an uncertain destroy.
  - The pickup details are reported in each failure result.
  - The proof is withheld after any pickup. A measured zero pickup keeps it.
  - Mutated placements now become `uncertain` / `partial_unknown`. Actor/epoch, cancellation, admission and duplicate guards are unchanged.
- **Proof.**
  - Code `10948bf7`, payload repin `bb9a6cb8`, test nits `f3975f85`.
  - Passed: 2,662 runtime tests, 1,249 mod tests, typecheck/Lua, ESLint and the 9 payload tests.
  - New native Factorio 2.0.77 lane `ground-item-pickup`:
    - A fuelled drill spills ore, and the approved placement picks it up and builds the furnace over the drop point. The pickup equals the inventory change.
    - A partially fitting stack fails for real, with no proof, `uncertain` admission and `partial_unknown`.
    - A zero pickup keeps the proof.
  - Independent review: approve with nits (fixed). [Validation note](validation/RUN_AF_PLACEMENT_PICKUP_RECEIPTS_2026-10-19.md).
- **Boundary.** After a pickup failure the goal pauses on `duplicate_effect_suppressed` and does not replan. Not live-tested; Codex's next E2E checks the live path.

## October 19: Run AE placement gaps fixed offline

- **Ground items.** Run AE stalled because a burner drill, fueled before its furnace existed, dropped ore on its drop point, and the script build check rejected all 52 furnace footprints over it. A footprint blocked only by ground items is now a candidate that lists `ground_items`. Placing it picks them up into the NPC inventory, re-checks natively, then builds. If the inventory is full, it fails with correctable `ground_items_inventory_full`. Tile-rule entities keep the strict check. This was the owner's "pick up on build" choice.
- **Smaller gaps.**
  - `fresh_topology` keeps `unit_number` and the item drop point.
  - Drill `getPrototypeDetails` no longer reads a key the 2.0 prototype lacks.
  - A checkpoint echoed with `plannerReview` under a frozen plan is ignored and traced, not refused. A refused review names its conflict.
- **Proof.** Code `8f1ffcf4`, payload `a40d5fb5`. Passed: 2,658 runtime tests, 1,241 mod tests, typecheck/Lua, ESLint, and the 9 payload tests. Not live-tested. [Work note](validation/RUN_AE_PLACEMENT_GAPS_2026-10-19.md).

## October 19: Run AD direct-feed observation gaps fixed and validated offline

- **Open observations.** Typed JSON and `submitPlan` observation requests can use the ordinary approved spatial/resource tools when reads are open. Normal argument validation, cache, budgets and actor/epoch/cancellation fences apply. Closed rounds retain their narrower fact grammar and durable one-read allowance.
- **Post-batch coverage.** Research/inventory-only predicted coverage cannot close ordinary reads for an active explicit direct-feed brief. The existing fresh-read budget still closes the decision when spent; plan/review authority and numeric allowances are unchanged.
- **Proof.** Reviewed code `54f2f18f`, payload `128765ed`, local no-ff merge `021a361a`: merged 2,655 runtime and 1,234 mod tests, typecheck/Lua and payload9 pass. Native Factorio 2.0.77 uses the real Session, provider serializer and candidate admission to place/fuel a direct-fed pair, produce two iron plates and collect one. Original-runtime and coverage-only controls fail as expected; the prior normal-observation native canary also passes. [Validation checkpoint](validation/RUN_AD_OBSERVATION_GAPS_2026-10-19.md).
- **Boundary.** The native replies and research-only route are scripted. This proves fact access and continuation, not autonomous live selection or red-science throughput. No new E2E or deployment ran. Owned test resources are removed; sealed evidence and historical reports are retained.

## October 19: Run AC review gaps fixed offline

- **Read reopen.** When an executor review comes from a read phase that the harness closed on post-batch coverage, reads reopen once per step. In Run AC, only `research_state` was predicted after the walk to iron ore, so no ore-site or placement read was available.
- **Planner review round.** Each step gets one in-turn planner round after a review. The allowance is durable, runtime-only and capped at 8 steps per goal. The committed plan cannot change. An empty reply returns the same step to a fresh executor with `[PLANNER_REVIEW_NOTES]`. A second review pauses as before.
- **Unchanged.** Advisory authority and the replacement-wake requirements are unchanged.
- **Evidence.** 2,635 runtime tests passed in Docker. Not live-tested. [Work note](validation/RUN_AC_REVIEW_GAPS_2026-10-19.md).

## October 19: Run AC respects supply method and requests review; guard pause stops progress

- **Result.** One cold trial at `b1da8392` stopped after 7.5161 minutes with ten new copper plates, zero new iron plates and zero red science. All 19 provider calls returned (Sol5/Luna14), all 23 Jev calls returned, no errors. One committed slice and eight admitted batches; all admissions followed executor replies.
- **Method.** Planner chose manual startup coal/copper and direct-fed iron with explicit setup/time rationale. All 14 executor requests carried the active guidance and selected details. Iron preparation admitted only wait/navigation, with no manual iron supply. Extra cells remained optional time savings; direct-fed production was not built or proven.
- **Review boundary.** Executor explicitly requested advisory `local_recovery_exhausted` review for missing iron-site/output geometry evidence. Planner context returned, then a guard pause ended the request; zero provider calls followed. The prior post-batch bundle covered only the selected research family and closed reads. Investigate observation-family sufficiency and bounded planner continuation; the review does not establish physical infeasibility or authorize replacement.
- **Closeout.** Strict paired stop, fresh579,452Bsave/all55CRC/exact2.0.77 pristine load pass. All owned stack/proof containers, network, volumes, unique image and tunnel removed; shared build alias and sealed evidence retained. No corrections/resumes/resets/second trial. [Run AC evidence](validation/RED_AUTOMATION_LIVE_RUN_AC_2026-10-19.md).

## October 18: Executor supply strategy and advisory review fixed offline

- **Strategy.** New planner briefs explicitly choose direct feeding, manual bootstrap or no resource method. Selected direct-miner-smelting details require that choice before commit. An explicitly chosen direct-feed method rejects manual supply of that resource before the whole batch is admitted and returns advisory review. Startup fuel and unrelated materials remain allowed. Additional dedicated cells remain optional investments justified by time savings.
- **Review.** Protocol 3 removes conflicting harness instructions to emit legacy `BLOCKED` prose. A legacy executor claim rejected by outcome authority can reach advisory review only at an idle, settled, current step. Accepted blockers, uncertain effects, actor/generation checks, plan authority and budgets retain their guards. Review pauses and returns planner context; it does not automatically run an unbounded planner loop.
- **Proof.** Frozen runtime `736dc960`, reviewed merge `05bfccce`: 29 focused, 2,632 runtime and 1,234 mod tests, typecheck/Lua, lint, installer9 and 92 Python checks pass. Actual original/candidate module controls distinguish both defects. Native Factorio 2.0.77 preserves powered-load output and refuses a mismatched supply batch with authorization envelopes unchanged at six, actor inventory/position unchanged, and zero external fetches. [Offline checkpoint](validation/EXECUTOR_STRATEGY_REVIEW_2026-10-18.md).
- **Boundary.** No live provider/Jev calls or gameplay trial ran for this fix. The replay covers the recorded response and authority path, not the entire water exploration. Live strategy choice, time savings and autonomous red-science throughput remain unproven. All owned test containers and the native test image were removed; sealed evidence is retained.

## October 18: Planner/executor contracts merged; Run AB stops before power

- **Integration.** Published `80eaf9e5` includes reviewed planner-only strategy/skill selection, executor briefs and selected details, bounded advisory review and an integration guard against selecting details absent from the rendered context. Merged 2,620 runtime/1,234 mod tests, lint, installer9, native protocol3/92Python and hosted CI/release/security pass. [Contract checkpoint](validation/PLANNER_EXECUTOR_CONTRACTS_2026-10-18.md).
- **Live result.** One authorized cold trial lasted40.6362min:118/118 provider replies (Sol10/Luna108),86/86Jev,zero errors. Two committed slices and38executor gameplay admissions produced95iron/18copper plates, lab and main steam kit, but no installed power or red science. Skill details and briefs remained present; the executor still hand-mined and reused one furnace, leaving its miner held. Additional cells were framed as optional time savings. No `plannerReview` request occurred.
- **Boundary.** A wider water read found exposed samples, but the walk toward one ended `navigation_unreachable`; subsequent narrow incomplete reads were empty and pump candidates refused. Unsupported legacy `BLOCKED` prose followed. Seven request failures consumed the unchanged goal6/6 recovery allowance. Next replay that case against the new advisory review contract, plus investigate brief adherence and the steam-kit checkpoint's omitted pipe/coal promises. These are follow-up findings, not fixes validated by this trial.
- **Closeout.** Strict paired stop/nativeidle, fresh519,592Bsave/all55CRC/exact2.0.77 pristine load pass. Owned stack/network/volumes/unique images/tunnel and browser are gone; sharedlocal image retained. Sealed216files/43frozenhelpers verified; no corrections/resets/secondtrial. Automated red throughput remains unproven. [Run AB report](validation/RED_AUTOMATION_LIVE_RUN_AB_2026-10-18.md).

## October 18: Run Z reaches connected water; partial placement blocks automation

- **Result.** The single owner-authorized fresh trial at frozen `e86934e2` stopped after 19.5451 minutes with 50 new iron plates, ten copper plates and zero red science. Pump 35 supplied boiler 36; the engine remained held, no generation or automated chain existed, and measurement never started. Actual planner/executor routing was Sol/Luna, 81/81 provider replies and 54/54 Jev exchanges, zero errors.
- **Blocker.** Batch 21 completed boiler placement, then refused an overlapping engine footprint and cancelled the pole tail. `admitted_cancelled` / `partial_unknown` prevented duplicate repair; canonical `unresolved_operation_effect` required user decision. Three listed tasks reported four starts, so internal approach/resume accounting needs exact offline replay before claiming a reconciliation defect or permitting repair. Assess same-batch footprint validation too; preserve the uncertainty fence.
- **Landfill boundary.** Native removal and subsequent candidate placement are proven by the static/native gates below. Run Z used exposed water and did not exercise landfill removal. Water-first refusal and automatic recovery to a validated pump candidate worked live. The actor job boundary supports future robot execution; no robot backend is exposed yet.
- **Closeout.** Strict paired stop/native idle, fresh 695,581-byte save, all 55 CRCs and exact-release Factorio 2.0.77 pristine-copy load pass. All owned containers, networks, disposable volumes, image tags and SSH tunnel are removed; prior archives and environment remain preserved. All 186 Run Z evidence files and 26 frozen helpers verify independently. Weekly remaining was 92% at trial finish, 91% at final publication check, above the approximately 5% reserve. No manual gameplay correction, budget reset or second trial. Automatic red throughput remains unproven. [Run Z result and sealed evidence](validation/RED_AUTOMATION_LIVE_RUN_Z_2026-10-18.md).
- **Publication scope.** Later, separately published telemetry/tail-registry work through `cc2e5cb9` is preserved. Run Z evaluated `e86934e2`; its release/engine evidence does not validate that later runtime.

## October 18: Native landfill preparation validated before Run Z

- **Capability.** Water-first pump preparation can reclaim a single native landfill layer directly over water through real tile-proxy mining. Actor-bound references, native mining time, inventory, reach, footing and protected/foreign-work checks constrain removal. Completion, interruption, restart and actor loss preserve real effects and clean only owned work. The job boundary permits future robot execution; this release exposes actor work only.
- **Pump authority.** Preparation is a separate task/receipt. It invalidates the actor's old water observations and pump candidates; fresh water and legal candidate-ID placement are required afterward. Preparing terrain never proves a working pump or power.
- **Proof.** Reviewed production merge `b2019034`, including the concurrently published post-batch inventory/recipe fact improvement. Merged Docker gate passes 2,566 runtime/staging and 1,223 mod tests, typecheck/Lua/generated-Lua, lint and nine payload tests. All 26 native lanes and 92 Python checks pass. Focused native proof reclaims six landfill and builds a water-sourcing pump with zero humans, including cancellation, foreign marks, saved pending work/restart and actual actor death. [Validation checkpoint](validation/PUMP_LANDFILL_REMOVAL_2026-10-18.md).
- **Boundary.** Prior archived evidence remains unchanged. The owner authorized one fresh Run Z after actual release-byte, proxy and role-routing verification, with the existing 60-minute construction and five-wall-minute automated-throughput measurement rules. Approximately 5% usage is reserved; live stop threshold is 7%. Autonomous red-science throughput is still unproven before that trial.

## October 17: Run X partial-transfer, completion and stop regressions fixed offline

- **Recovery.** Fully accounted native transfer refusals now settle as known partial work, preserving completed effects and refusing original-batch replay. Fresh same-step repairs share the existing two-attempt allowance. Missing receipts, changed actors/epochs and cancelled tails retain uncertainty and the duplicate guard.
- **Contracts and stop.** A blocked executor continuation reaches canonical blocked admission instead of being treated as a new draft missing completion declarations. The committed checkpoint remains immutable. Operator stop emits the canonical pause trace even while the plan remains BLOCKED; strict stop-proof rules are unchanged.
- **Proof.** Frozen production `2865d1b4`; 2,536 runtime/staging tests, 1,181 mod tests, typecheck/Lua/generated-Lua, lint and nine payload tests PASS. All 24 native lanes and 92 Python checks PASS. The new full loop physically smelts five copper plates to reach fifteen held; missing-proof and original-code controls discriminate the fixes. Independent source/evidence review passed. [Validation checkpoint](validation/RUN_X_PARTIAL_TRANSFER_RECOVERY_2026-10-17.md).
- **Integration.** Reviewed no-ff merge `a0a379fa`; merged canonical gate passes the same 2,536 runtime/staging and 1,181 mod tests, typecheck and Lua checks. Immutable payload pins are validated. Publication target is `experiment/jev-agent-architecture`.
- **Boundary.** Historical Run X save/evidence is preserved and all owned test containers are down. Autonomous red-science throughput remains unproven. The E2E goal stays **paused**; no live provider/Jev run or deployment.

## October 17: Run X reaches furnace transition; red automation remains unproven

- **Trial.** Frozen `ffc0a046`, sole minimum objective, actual Sol6.1 planner8/Luna executor47, 55/55 replies and zero provider transport errors; Jev50/50. Native output reached 60 iron/ten copper plates with ten hand-crafted gears held. Only the furnace was placed; no power, automated chain or red output. Measurement never started. Canonical terminal stop occurred at 14.22 minutes; weekly remaining31% stayed above the approved30% floor.
- **Boundary.** During the additional-copper step, native batch20 completed three transfer tasks before copper was refused with `target_rejects_item`. Partial-effect uncertainty was preserved. The next executor action failed `missing_step_completions`; the independently refreshed canonical plan was `BLOCKED`, requiring user decision. Next replay the physical furnace recipe transition/completed prefix and completion-contract recovery. Final normalized status agrees with fresh post-stop native state, so earlier snapshots do not establish a stale observation bug.
- **Archival.** Strict paired stop-trace confirmation failed because no `goal.paused` event was emitted. A separately authorized, independently verified fresh cancellation/durable same-goal operator pause allowed safe archival without clearing pending effects. The 598,298-byte save passes all55 ZIP-entry CRCs and offline Factorio2.0.77 loading of a pristine copy. A one-chunk archive-guard assumption was corrected locally with ten regression groups; original failures remain preserved. Owned stack/forwarder are down and evidence retained. Broader E2E goal remains **paused**; no new production patch or second trial. [Run X evidence](validation/RED_AUTOMATION_LIVE_RUN_X_2026-10-17.md).

## October 17: Lean fresh topology and placement obstruction context integrated

- **Behavior.** Planner and executor receive a scoped native snapshot capped at 1,950 characters: relevant held stock, fluid/electric connections, conditional prototype capacity ratios and bounded rejected-footprint witnesses from admitted observations. Actor/session/epoch/surface/force changes and pending or intervening mutations invalidate it. Existing plan ownership, admission, observation/recovery limits and the executor's 6,000-character handoff remain intact.
- **Expansion guidance.** Running vanilla prototypes derive 60 steam/s per fully supplied boiler versus 30/s per engine, so guidance suggests room/access for two compatible engines. This does not add a second engine to the committed task, reserve space or claim actual throughput. Missing/incompatible evidence gives no assumed ratio. Asynchronous next-step prediction was unbuilt at this checkpoint; see the October 23 update above.
- **Proof.** Frozen `f3903af5` passes 2,517 runtime/staging tests, including 33 topology cases. Mod gates pass 1,150 tests, typecheck, Lua build and generated-Lua validation; nine payload tests pass. The native full-loop fixture delivers both actual role serializers, crafts/routes two pipes through normal admission and powers a real inserter at 400 W with both original poles retained. It places exactly one engine and reports a legal connected expansion footprint. All 23 native lanes pass, with final production/fixture rechecks covering shoreline recovery, normal observation and fresh topology. Native source/image mapping and integration results are recorded in the [validation checkpoint](validation/FRESH_TOPOLOGY_CONTEXT_2026-10-17.md).
- **Integration.** Reviewed no-ff merge `8eadec71`; merged canonical gate passes 2,517 runtime/staging and 1,150 mod tests, typecheck and Lua. Full lint and nine immutable payload tests pass. Publication target is `experiment/jev-agent-architecture`.
- **Boundary.** Scripted decisions and native mechanics are proven; autonomous red-science throughput remains unproven. The broader E2E goal remains **paused**. No live provider/Jev run or deployment.

## October 17: Run W saved-layout steam/power replay passes offline

- **Exact boundary.** The captured shoreline has no directly connected engine candidate; its inline footprint crosses water, with additional pole/actor overlap. Pole removal alone is insufficient. A pristine-copy scripted repair crafts two pipes from held iron, clears one natural tree, routes steam inland, places the held engine and crafts/places a real inserter load. Both original poles and the original save remain unchanged.
- **Proof.** Production structured parsing/rendering and actor/epoch admission, zero humans/artificial power, network-disabled Docker, eight native operations. Three steady samples prove connected boiler/pipes/engine and 400 W supplied to the inserter on a positive shared network. Independent review and 364-file evidence verification passed. This is deterministic mechanics proof, without Session/full-loop autonomous recovery or throughput claims.
- **Assessment.** Planner had relevant inventory/recipes/research/shoreline reads; executor's final missing-engine claim contradicted delivered inventory. Recommend bounded fresh topology/obstruction facts and planner wake-up summaries. Just-in-time step contracts exist; asynchronous next-step prediction was unbuilt at this checkpoint; see the October 23 update above. Local task branch `test/run-w-saved-layout` only, no production change, provider/Jev calls, goal resume, integration push or deployment. E2E goal remains **paused**. [Replay and audit](validation/RUN_W_SAVED_LAYOUT_REPLAY_2026-10-17.md).

## October 16: Run W minimum prompt reaches steam; goal resume limit stops safely

- **Trial.** Frozen `9e00fc5c`, 21.04 minutes with the approved 60-minute cap/40% floor. The single minimum objective was correctly interpreted as sustained red throughput from natural resources. Actual delegation: Sol planner10/10, Luna executor65/65, zero provider errors; Jev48/48. Both roles exercised open/closed CLI-proxy wire. Native output reached 50 new iron/ten copper plates, a connected fueled pump/boiler and two poles. Engine remained held; red0, no measurement.
- **Boundary.** Current scoped `recovery.auto_resume_exhausted` reached the unchanged goal6/6 limit; the supervisor preserved transient recovery and stopped on genuine terminal authority. Luna's final engine-absent claim contradicted fresh delivered inventory; generic legal engine candidates and boiler geometry had been delivered, but no engine placement was attempted. Missing baseline or native illegal engine placement is not demonstrated. Next offline check: replay connection-specific engine candidates against the saved layout and verify actual generation/load before proposing a harness fix.
- **Safety.** Fresh paired stop/native idle, 883,308-byte save, complete 56-entry CRC and parent verification passed. Isolated stack and owned tunnel are down; evidence preserved. Weekly remaining44%, trial exception ended. General E2E goal remains **paused**; no second trial, production change, push or deployment. [Run W evidence](validation/RED_AUTOMATION_LIVE_RUN_W_2026-10-16.md).

## October 16: Run V supervision and water-only shoreline recovery fixed locally

- **Fix.** Shared external trial classifier preserves bounded model/transport recovery; native/canonical observations are refreshed and terminal classification repeated before an automatic supervisor stop. Fresh incomplete-empty water coverage can now use the existing exploration correction without an extra negative pump read. All category/read/resume budgets, immutable-plan and provenance/effect/actor/epoch fences remain unchanged.
- **Proof.** Independently reviewed code `6fe763b7`, local no-ff merge `1dce938f`. Merged Docker gate passes 2,481 runtime/staging and 1,144 mod tests, typecheck and Lua. Seven stop/race and six serialized water-only regressions pass. Five native lanes pass, including original paired-pump and new water-only worlds through actual movement, fresh discovery, connected steam generation, powered lab and science consumption. Original runtime passes the old native canary then fails the new water-only case specifically on missing exploration guidance.
- **Boundary.** Local only; no new live provider/Jev calls, Run V resume, push or deployment. Owner requested the concrete proposed 60-minute/40% next-trial plan before approval. General goal remains **paused**; complete unattended red throughput remains unproven. [Fix/evidence](validation/RUN_V_SUPERVISION_SHORELINE_FIX_2026-10-16.md), [proposed trial plan](validation/RED_AUTOMATION_NEXT_TRIAL_PLAN_2026-10-16.md).

## October 16: Run V verifies delegation and smelting; parent stops early

- **Trial.** Frozen `4cc7b57e`, about 24 minutes; Sol planner8/8, Luna executor63/62, provider71/70 with zero errors (one outstanding at cancellation), Jev55/55. Dedicated CLI-proxy gameplay wire retained closed tools with explicit `none`. Native production reached 50 new iron/ten copper plates, clearing Run U's copper-output obstruction. Pump/boiler/engine/two poles were acquired; only the furnace was placed. No automatic power/science chain or throughput measurement.
- **Interpretation.** Parent incorrectly stopped on an observed transient model-recoverable action-omission pause. Built-in automatic recovery had already resumed before stop; a local pump attempt was refused `not_placeable` without mutation. No automatic-resume exhaustion occurred, and future recovery outcome is unknown. Record this as truncated operator-stop evidence. Align supervisor decisions with the frozen runner's terminal rules before another trial; inspect retained shoreline facts/placement receipts offline.
- **Safety.** Same-goal paired stop/native idle, fresh 875,954-byte save, completed Factorio save and all 56-entry CRC verified; independent review approved the native split-save verifier correction. Isolated stack down and owned forwarder removed. The one-trial 40% floor exception ended; general E2E goal remains **paused**. No second trial, push or deployment. [Run V evidence](validation/RED_AUTOMATION_LIVE_RUN_V_2026-10-16.md).

## October 16: Pulled cloud CI head; local and all native checks pass, E2E paused

- **Source/fixes.** Fast-forwarded to remote `37d5728b`. Real-engine checks exposed two stale resilience fixtures: a refusal compared inventory against stock replaced by the intervening persistence fixture, and an invented prototype was used to expect a structural blocker. Fresh complete-inventory snapshots and a real locked-recipe preflight fix those cases while preserving frozen-plan, restart, guard-pause and explicit-revision assertions. No production policy or limits changed.
- **Proof.** Independent review approved `b36872af`; local no-ff merge `8df6d2cc`. Merged Docker checks pass 2,468 runtime/1,144 mod, typecheck and Lua. Expanded lint, 102 ordinary-agent tests, workspace build/typecheck, ordinary/guarded LuaJIT parsing, guard compilation, nine installer tests and isolated Compose assertions pass. The final official network-disabled Factorio image passes **all 22 lanes**, plus 92 Python regressions. An actual one-plate mutation fails the strengthened no-effect assertion.
- **Boundary.** These fixture fixes and the validation record remain local; remote stays `37d5728b`. E2E goal remains **paused**; no live provider/Jev calls, push or deployment, and existing `.env` API selections remain untouched. This closes the local engine-validation gap, without claiming a new hosted CI run or unattended science throughput. [Validation](validation/LOCAL_NATIVE_CI_VALIDATION_2026-10-16.md).

## October 15: Cloud CI health candidate; native verification pending

- Cloud-only cleanup based on pushed `138c0ce6`; no push or deployment is implied.
- Corrects the runtime-only fluid-tool inventory, lint failures and CI job coupling. The existing `typescript-quality` aggregate still requires every underlying check to succeed.
- The native lifecycle fixture now uses a genuine locked recipe for its structural-blocker case instead of an invented prototype. Production refusal/recovery policy is unchanged. This fixture edit remains **unverified in the engine**.
- Offline proof: lint 0 errors/warnings; 2,468 runtime/staging, 102 ordinary-agent and 1,144 mod tests pass; workspace build/typecheck, generated-Lua semantic check, isolated guard compilation and nine payload tests pass. Node 24.19.0 / pinned pnpm 10.30.1. Remaining gates: [cloud CI health checkpoint](validation/CLOUD_CI_HEALTH_2026-10-15.md). This does not establish a playable milestone or autonomous throughput.

## October 15: Dedicated CLI-proxy profile reviewed and integrated locally; E2E paused

- **Fix.** `AI_API_METHOD=cli-proxy` now selects a separate upstream-inference capability profile. Ordinary HTTPS endpoints work independently of hosting/tunneling; optional local/Tailscale HTTP keeps existing URL rules. No LM Studio context/pricing assumptions. API URL/key/model field names and existing `.env` contents remain unchanged.
- **Preflight.** Both actual role serializers must prove retained function schemas and explicit closed `tool_choice:none`, without inference. Legacy local/unset/direct/router and unsupported roles fail this trial gate. Generic/direct/router/local compatibility, response cap and all budgets remain intact.
- **Proof/integration.** Independent final review of `3b2cc106`; local no-ff merge `506e1b10`. Merged Docker gate passes 2,465 runtime/1,144 mod, typecheck and Lua; nine installer tests and 31 offline prepared-helper checks pass. Official network-disabled native lane proves both preflights and unchanged nine-call copper-smelting/lab/red-unlock recovery. E2E goal remains **paused**; no live inference, push or deployment. Future trial preparation needs a new deployment freeze before readiness. [Validation](validation/CLI_PROXY_PROFILE_2026-10-15.md).

## October 15: Run U verifies normal reads and stop fence; generic closed provider wire hits size guard

- **Trial.** Frozen `6ceaa2ae`, nine minutes including shutdown, 33 requests (four Sol/29 Luna), 32 responses and one response-size error. Jev23/23, one resume used. Native ten copper plates and 100 mined iron ore, but zero iron/red production and only the furnace placed; its copper output obstructed iron smelting. Full-chain measurement never started.
- **Verified fixes.** Actual provider wire exercises normal typed inventory observation once without consuming the closed allowance. The repaired paired cancellation/operator-pause stop fence passes live despite retained pause timestamp, before the 951,850-byte save. Exact evidence and save are retained; isolated stack is down.
- **Next boundary.** The final closed Luna request used the legacy generic profile and serialized only model/messages/max_tokens4000, without tools/tool_choice. Its response exceeded the unchanged256KiB guard (270,557 bytes). The failed body was canceled before parse; its contents are unknown. Empty AI_API_METHOD retained legacy auto/generic selection despite routing through CLI proxy. The dedicated CLI-proxy profile and offline preflight above address this configuration gap; live confirmation remains pending, with every size/call/recovery limit preserved. No blind retry, push or deployment. [Run U evidence](validation/RED_AUTOMATION_LIVE_RUN_U_2026-10-15.md).
## October 15: Run T observation channel reviewed and integrated locally

- **Fix.** A validated typed observation request while ordinary tools are open becomes the same ordinary tool call, using existing budget, cache, duplicate handling and actor fences. It cannot consume the closed one-fact ledger or force tools closed. Guidance advertises the separate targeted allowance only on closed decisions. Strict identity/no-edit validation and existing recovery/resume limits remain.
- **Proof.** Reviewed `339c0cc6`; 21 new static regressions include the actual serialized Sol/Luna Session loop, ordinary cache/budget parity, repeated Jev observation routing, closed-ledger preservation and actor/epoch/cancellation controls. The final official native image proves iron-output clearing → five NEW copper plates → native lab craft → red-science unlock, preserving the checkpoint and six prior resumes. Nine wire calls (two Sol/seven Luna), three admitted batches, zero humans and fully idle native state. Original-runtime controls reproduce premature closed-tool behavior. All thirteen prior native canaries pass; all 31 compiled mod files match the final image.
- **Integration/supervision.** Local no-ff merge `785071f4`; merged Docker gate passes 2,452 runtime/1,144 mod, typecheck and Lua. The independently reviewed Run U observer passes 26 offline tests for fresh cancellation/pause proof despite retained pause timestamps. No push, release or deployment. A fresh live trial and the complete unattended natural-resource chain/throughput remain unproven. [Validation](validation/NORMAL_OBSERVATION_CHANNEL_2026-10-15.md).
## October 15: Run T reaches lab prerequisites, exhausts bounded recovery

- **Trial.** Frozen `4da208b6`, 19m11s to terminal: 88/88 provider responses (5 Sol/83 Luna), Jev 61/61, zero transport errors. Native production reached 74 iron and 20 copper plates, with ten hand-crafted gears held. Only the furnace was placed; no lab, power, automatic mining/fuel, science assembler or red output. Measurement never started. Two full observation baselines and one accepted Sol JIT checkpoint are verified in actual provider wire.
- **Boundary.** Six goal resumes exhausted after valid JSON action omissions and unsupported blockers around lab prerequisites. The one malformed reply was repaired and gathering resumed. Current wire retains correct action permissions/baselines. An open-round `observationRequest` can nevertheless consume the dedicated missing-fact allowance and force normal tools closed; Luna chose a redundant research read, then claimed furnace facts unavailable. Next inspect/consolidate this channel with the ordinary observation budget/cache/fences while preserving every limit. [Run T evidence](validation/RED_AUTOMATION_LIVE_RUN_T_2026-10-15.md).
- **Shutdown.** The observer rejected an old durable pause timestamp despite fresh operator cancellation/pause traces and native idle. It correctly left an incomplete result. An independently verified outer shutdown saved 901,989 bytes and removed the isolated stack. The next observer must recognize the actual already-paused-goal stop receipt shape. No second trial, push or deployment.

## October 15: Run S local target recovery reviewed and integrated

- **Fix.** A native legacy name-transfer miss within reach can recover inside the unchanged semantic step only with matching admitted journal/batch/signature, active plan/step and fresh actor/epoch. It uses the existing persistent two-attempt transfer allowance. The model chooses travel and obtains fresh spatial identity/counts before exact delivery; no automatic walk, substitution, cached-ID authority or extra budget.
- **Effect proof.** Native local `no_target` now proves the failed task touched no inventory. Existing reconciliation permits whole-batch absence only for `started_count:1`. Completed prefixes and old unproved Run S receipts retain uncertain effects and replay protection. Exact destruction and authority failures remain closed.
- **Proof/integration.** Reviewed `6b374d2c`, local no-ff merge `162e73ce`; merged Docker checks pass 2,431 runtime/1,144 mod tests, typecheck and Lua. Final native lane passes all three isolated worlds: remote intended furnace/decoy recovery produces ten new copper plates and unlocks electronics; actual completed movement-prefix uncertainty and actual mined-target destruction both preserve replay guards. All twelve existing native canaries pass. Original-code controls detect both missing recovery guidance and missing native absence proof. The separate Run T observer passes independent review and 21 offline checks, including confirmed stop before save. No push, release or deployment; full automated red throughput remains unproven. [Validation](validation/LOCAL_TRANSFER_TARGET_RECOVERY_2026-10-15.md).

## October 15: Run S exposes local transfer target recovery

- **Trial.** Frozen `7ca69aed`, 17/17 provider responses (3 Sol/14 Luna), Jev 13/13, zero transport errors. The NPC gathered ten copper ore and ten coal and placed furnace 10. No plates, power or red science; measurement never started. Parent verified the isolated stack is down and the 860,822-byte save is retained.
- **Blocker.** Legacy name-based `move_items` searched within interaction reach and returned `moving_items:no_target`; the furnace still existed 39.67 tiles away. The harness promoted this local absence into a structural blocker before the final model reply. Exact-identity resolution was not exercised. Next fix: bounded, correlated target-location recovery within the same committed step and existing recovery allowance, preserving pending-effect uncertainty and fresh observation requirements.
- **Supervision.** The canonical plan became `BLOCKED` while `run.paused` stayed false. The runner missed that terminal state; parent stopped the trial through its existing safe save path. The next runner must recognize this state explicitly. No usage-floor condition occurred. [Run S evidence](validation/RED_AUTOMATION_LIVE_RUN_S_2026-10-15.md).

## October 15: Run R targeted water recovery reviewed and integrated locally

- **Fix.** An unused targeted fact allowance can request actor-centered native water coverage after a fresh same-scope empty offshore-pump search. Strict water/radius/limit arguments, scope/freshness and actor/epoch/cancellation fences apply. The same durable ledger is consumed before transport; no observation-count, provider, category or resume cap increases. Existing native coverage suppresses redundant reads. The model still chooses exploration; strict checkpoint parsing and admission remain unchanged.
- **Proof.** Frozen `41642d05` passes 2,414 runtime tests. Mod/typecheck/Lua gates pass with identical production code. Twelve new cases cover the actual closed wire, malformed-checkpoint refusal, persisted six-resume history, one-fact ledger/restart, stale/forged facts and cancelled reads/actions. All twelve network-disabled native lanes pass. The new lane uses one targeted read, eight admitted batches and fresh native exploration/candidates to connect water/steam and power a lab that consumes science; prior goal resumes remain six. Original-code static/native controls detect the missing contract. Independent frozen review approved.
- **Integration.** Local no-ff merge `7252e412`; production/tests match frozen `41642d05`. Merged canonical checks pass: 2,414 runtime/1,142 mod, typecheck and Lua. No push, release or Pterodactyl deployment. Full-chain red throughput remains unproven. [Validation/evidence](validation/TARGETED_WATER_RECOVERY_2026-10-15.md).

## October 15: Run R verifies both repaired provider boundaries; shoreline fact recovery remains open

- **Live progress.** Candidate `8bf6fc15`, one supervised local trial, 16m31s: 71/71 provider responses (6 Sol/65 Luna), Jev 42/42, zero errors. Actual closed JSON placement created furnace 29; native production reached ten copper and fifty iron plates. The NPC collected the plates and acquired pump/boiler/engine/two poles. Two JIT checkpoint calls succeeded, including the transition into the power-placement step. No operator corrections.
- **Terminal.** Only the furnace was placed. An empty offshore-pump candidate search covered radius 24; normal observations then closed. Luna also redeclared a malformed checkpoint, correctly refused before placement, then claimed a world blocker. The six-goal-resume guard stopped the run. No connected power, automated mining/fuel/science chain or five-minute benchmark. Save/manifest/exact wire retained; isolated stack down.
- **Independent diagnosis.** The remaining targeted fact allowance was unused, but its grammar cannot request water coverage. Unit 22 needs that native coverage evidence before offering unexplored centers; pump-only absence cannot establish a world blocker or justify invented destinations. Next narrow fix: one bounded actor-centered water read through the existing targeted allowance, gated by fresh same-scope empty pump-search evidence. Preserve strict checkpoint parsing, all read/provider/resume limits and actor/epoch fences; prove actual exploration-to-native-connected-power continuation in full-loop static/native tests before another trial. [Run R evidence](validation/RED_AUTOMATION_LIVE_RUN_R_2026-10-15.md).

## October 15: Run Q operation-channel clarification reviewed and integrated locally

- **Fix.** Fresh control state now distinguishes closed observations from strict-JSON operation proposals awaiting validation/admission. The closed prompt includes canonical operation arguments and the held-placement/new-identity dependency boundary. This grants no gameplay authority, adds no automatic actions/reads/retries and preserves all budgets and actor/epoch/stop fences.
- **Proof.** Frozen `825548ce` passes 2,402 runtime/staging tests and 1,142 mod tests plus typecheck/Lua. Four new full-loop cases cover C7 recovery, the consumed targeted read, unchanged checkpoint, exact blocker rejection and meaningful stop/epoch boundaries. Native held-furnace placement, fresh identity and admitted supply produce ten new copper plates and unlock electronics, in two batches with zero humans. All ten existing native canaries pass. Original-code static/native controls detect the missing channel contract; the initial native fixture error and its test-only correction are preserved.
- **Integration.** Independent frozen review approved; local no-ff merge `fd791448` has identical production/test files. Merged canonical checks pass: 2,402 runtime/1,142 mod, typecheck and Lua. No push or deployment. Full-chain automated red production and its five-minute benchmark remain unproven. [Validation/evidence](validation/CLOSED_ACTION_RECOVERY_2026-10-15.md).

## October 15: Run Q stopped before first furnace placement

- **Trial.** Frozen `e77ed843`, one supervised local CLI-proxy run: 18/18 provider responses (3 Sol / 15 Luna), zero errors, Jev 9/9. Gathered ten coal and ten copper ore; held starter furnace remained unplaced. No power, smelting, automated red production or benchmark. Isolated stack down; save and exact request/reply evidence preserved.
- **Diagnosis.** After one targeted inventory read, Luna claimed closed tools prevented placing the held furnace. Ordinary placement was already supported through JSON operations with no existing entity ID or coordinates. The outcome authority correctly rejected the unsupported blocker and retained the two-step/six-goal resume limits. Independent review corroborated a model mistake amplified by unclear distinction between observation-tool closure and structured operation proposals.
- **Next.** Clarify that proposal channel while retaining all validation, admission and identity fences. Static/native regressions must cover consumed inventory read, held furnace placement, receipt, fresh entity identity, real fuel/ore supply, ten newly smelted copper plates and the electronics trigger before the next supervised trial. The prior step-contract fix was not reached in this run. [Run Q evidence](validation/RED_AUTOMATION_LIVE_RUN_Q_2026-10-15.md).

## October 15: Run P checkpoint provider fix reviewed and integrated locally

- **Fix.** Just-in-time checkpoint calls now receive their exclusive target-only JSON contract and canonical predicate schema, without normal gameplay steering/control/style or a gameplay tool catalog. The CLI proxy's explicit disabled-tool guard remains, using only a non-executable checkpoint schema. Strict parsing, two attempts, reserves, planner/executor ownership, native admission and stop/actor/epoch fences remain unchanged. The new provider trace identifies the request and reason.
- **Proof.** Frozen `8f7ac8ee` passes 2,398 runtime/staging and 1,142 mod tests plus typecheck/Lua checks; eight new regressions exercise actual serialized role-resolved requests, exact live invalid replies and cancellation negatives. All ten network-disabled native lanes pass. New native proof follows real equipment crafting through one bounded contract correction, fresh legal candidates, actual pump/boiler water, sole-steam generation, connected powered lab and science consumption: seven admitted batches, three JIT calls, zero humans, no post-setup correction. Presence counts alone are not connectivity proof.
- **Controls and integration.** All eight new static cases fail with the two original modules while every old test passes; original native control fails at the exact conflicting gameplay wire instructions. Independent frozen review approved. No-ff local merge `449a0014`; merged canonical gate passes with identical runtime/test code. No push, release or live trial in the fix. The full unattended red-science goal remains active. [Fix validation and evidence](validation/STEP_CONTRACT_RECOVERY_2026-10-15.md).

## October 15: Run P passes live baseline recovery; checkpoint authoring blocks power placement

- **Verified progress.** One supervised local trial at `36958714`, 15m1s, 64 provider replies (12 Sol / 52 Luna), zero errors; Jev 42/42. Actual C7 provider payload contains the full furnace snapshot, followed by copper-output clearing and iron processing. Native production reached 50 iron/10 copper plates; the NPC crafted the pump, boiler, engine, ten pipes and four poles. The baseline fix now has live continuation evidence.
- **New blocker.** The next shoreline step required a just-in-time completion contract. Both actual serialized contract requests included provider-injected gameplay `[CONTROL_OUTPUT]` instructions demanding `chatMessage`, `plan`, `currentStep` and `operations`. The first reply used an unsupported entity-existence shape; its correction followed that conflicting gameplay envelope and asked for the accepted checkpoint schema. Strict validation and the two-attempt guard correctly paused before unbound placement. Independent read-only review corroborated the provider prompt conflict.
- **Next work.** Task-specific checkpoint output/schema isolation with real serialized-provider and native crafting-to-connected-power regressions; preserve strict parsing, planner ownership, existing limits and cancellation fences. Run P save/evidence retained, isolated stack down. No power placement, automated red output or five-minute benchmark. Full goal remains active, local only. [Run P checkpoint](validation/RED_AUTOMATION_LIVE_RUN_P_2026-10-15.md).

## October 15: Run O transport failure isolated; CLI-proxy connection restored

- **Run O.** Candidate `c0bad249` passed deployment/native-mod and cold-world checks, but all three CLI-proxy connection attempts failed with `ECONNREFUSED`; no Sol/Luna reply, gameplay production or baseline recovery occurred. Jev completed 12/12 requests. Save/evidence preserved and isolated stack down. [Run O checkpoint](validation/RED_AUTOMATION_LIVE_RUN_O_2026-10-15.md).
- **Transport repair.** The Docker VM was online over Tailscale and its existing CLIProxyAPI container was healthy. The local forwarding listener was missing. Restored a loopback-only SSH tunnel over Tailscale, preserving strict verification of the existing VM host key. The game image then received HTTP 200 from an authenticated models-list request, with Sol 6.1 and Luna available. No inference, VM service restart, provider configuration change or production code change was needed. The tunnel is a running helper process, not a boot-persistent task. [Recovery evidence](validation/CLI_PROXY_RECOVERY_2026-10-15.md).
- **Active goal.** The owner authorizes successive local, supervised trials toward the complete automated natural-resource red-science chain. Each trial uses a fresh isolated world, a frozen tested candidate, Sol planning/Luna execution, unchanged limits and at most 45 construction minutes. Success still requires the five-wall-minute speed-2 window with AI mutations paused, enemies suppressed, at least ten new red packs, upstream production and physical logistics proof. No push, release or Pterodactyl deployment is authorized.

## October 15: Run N observation-baseline recovery verified and integrated locally

- **Fix.** Compact entity/nearby responses require a complete baseline delivered in the current conversation and actor/epoch scope. Rebuilt contexts without that evidence receive full native snapshots; normal explicitly carried baselines still support diffs. Compaction repair settles dependent observations before provider dispatch, including secondary folds after large expansions. Existing observation/recovery caps and mutation authority remain intact.
- **Full-loop proof.** Exact Run N blocker/recipe data drives closed C5 correction, the production Session timer/C7, fresh machine observations, furnace output clearing, copper processing and a verified crafted lab. Stop/epoch replies admit nothing. The native lane performs copper→iron→copper switching, crafts/places a real lab and unlocks the red-science trigger: eight intended batches, one resume, no replay or post-setup corrective gameplay. Scripted Sol/Luna/Jev only.
- **Gates.** Frozen code/tests `cd717daa`; 2,390 runtime/staging and 1,142 mod tests plus typecheck/Lua checks pass. All nine native lanes pass, including connected steam/powered lab and assembler/inserter production canaries. All ten new static cases fail with the original production modules; the original native control fails at C7 (`unchanged` instead of `full`). Independent review passed after its secondary-compaction finding was reproduced and fixed.
- **Local integration.** No-ff merge `9f9723b6` in the existing integration checkout for `experiment/jev-agent-architecture`; the merged canonical gate also passes. Root checkout's unrelated edits preserved. No push, server build or live provider run. Full-factory red output at 1/game minute and the five-minute peaceful, AI-paused, speed-2 benchmark remain pending. [Recovery checkpoint and evidence](validation/OBSERVATION_BASELINE_RECOVERY_2026-10-15.md).

## October 15: Run N red-automation construction stopped before throughput measurement

- **One authorized delegated trial.** Local candidate `77e65f4b`; shipped runtime/prompt/manifest and all 31 active/native-tested mod files match. Sol planner / Luna executor produced 5 / 56 replies, zero provider errors; Jev 38 requests/responses. Fresh world, zero humans, unchanged declared starter and no corrective gameplay. No push.
- **Progress/result.** 22m32s: electronics/steam-power triggers, 72 iron plates, 10 copper plates, gears/cable and one furnace. No lab, connected steam power, automated supply chain or red science. The lab step exhausted two resumes (goal 4/6).
- **Concrete boundary.** The rebuilt executor received `getEntityStatus` as `unchanged` with no full entity-status baseline in its actual provider payload. It declined to process available copper ore without current furnace facts. Bind diff eligibility to delivered conversation continuity and add static/native full-loop recovery regressions before another live trial; preserve existing caps and completion authority.
- **Benchmark pending.** Owner selected five wall minutes at speed 2, AI mutations paused, enemies removed and expansion disabled, with at least ten new red packs and verified upstream production. Construction never reached readiness, so none of those measurement controls were applied. Save/traces preserved, isolated stack down; no live retry. [Run N checkpoint and regression plan](validation/RED_AUTOMATION_LIVE_RUN_N_2026-10-15.md).

## October 15: Unit 22 shoreline recovery and powered-lab loop verified locally

- **Recovery.** Reviewed code/tests `adc0821a` reject an unsupported world-blocker claim backed only by local pump absence and inconclusive water coverage. The existing category-correction allowance supplies bounded native exploration facts; the model chooses an action under the same goal/checkpoint. No observation/resume cap increase or automatic gameplay action. Facts are request/goal/step/actor/epoch scoped, expire and clear on mutation/restart.
- **Completion gap.** The native loop exposed missing `place_candidate` strict receipt mapping. Clean correlated placement receipts now reach the existing world checkpoint evaluation; an unpowered placed lab still cannot close the powered-lab result.
- **Proof.** Exact sanitized Run M static replay with its fresh-context allowance already spent reaches verified output, plus cancellation/epoch, existing-cap exhaustion, restart/no-replay and invalid-receipt negatives. Frozen gates pass 2,380 runtime/staging and 1,142 mod tests, typecheck/Lua checks; all eight native lanes pass. Native exploration discovers a distant shoreline, builds connected steam power, powers a real lab and consumes science. Independent original-code controls fail at both repaired boundaries.
- **Local integration only.** Work uses the existing `og-port-integration` checkout for the `experiment/jev-agent-architecture` line. The root checkout's old checked-out branch and pre-existing document changes remain untouched. No push, server build or live provider run. This engine fixture proves the recovery path; live green unlock and red/green automation remain unproved. [Unit 22 checkpoint](validation/UNIT22_RUN_M_SHORELINE_RECOVERY_2026-10-15.md).

## October 15: Run M confirms Sol/Luna delegation; shoreline recovery remains blocked

- **Reviewed fix integrated.** Unit 21 code/tests `b9d25643`, merge `c07f506a`, pushed/deployed source `517fcdc1`. Frozen and merged gates pass 2,373 runtime/staging and 1,142 mod tests plus typecheck/Lua checks; seven frozen native lanes green. Deployment/prompt/manifest and all 31 active/native-tested mod files match.
- **Real delegation.** One authorized fresh CLI-proxy trial: 7 Sol planner and 134 Luna executor responses, no main-provider errors. Three C3 commitments parked the planner and created executor contexts; Sol returned at later slice boundaries via fresh C2 contexts after recovery discarded the parked context. Jev 91 requests / 90 successful responses / one HTTP-499 runtime fallback.
- **Result.** 40m36s, six auto-resumes, then `goal_limit_reached`. Native lab, pump, boiler and steam engine crafted; red recipe unlocked. Power chain/lab were not placed, red produced/consumed stayed zero, green remained locked. Zero humans, speed 1, no operator corrections; save/traces preserved and stack down.
- **Next regression.** A radius-24 pump search and radius-128 local water absence were followed by an explicitly inconclusive radius-256 scan. Luna declared an unsupported blocker instead of bounded exploration; authority rejected it and the goal recovery allowance exhausted. Add static/native exploration-to-powered-lab full-loop coverage without raising limits. Unit 21's invalid-reference/scope conditions did not fire live. [Run M evidence and next local unit](validation/LUNA_GREEN_LIVE_RUN_M_2026-10-15.md).

## October 15: Run L recovery fixed; delegated trial concluded

- **Unit 21.** Reviewed code/tests `b9d25643` classify the exact invalid `unit_number` boundary into the existing tool-capable bounded correction loop. No malformed batch is admitted. Bounded rejection traces preserve replayable numeric/type facts. Same-request preflight correction cannot substitute ingredient stock or a semantic assessment for the retained result checkpoint.
- **Proof.** Eight new static scenarios include Sol planner/Luna executor resolution, placement receipt followed by fresh discovery, verified output, existing-cap exhaustion, stop/epoch fencing and lost-ack restart without replay. Original implementations fail the intended regressions. Canonical gates pass 2,373 runtime/staging and 1,142 mod tests, typecheck/Lua checks; all seven frozen native lanes pass, including the new real-engine delegated recovery chain and existing production canaries.
- **Trial.** The authorized Sol-planner/Luna-executor Run M concluded at a separate shoreline/exploration recovery boundary, with actual models and handoffs verified. Red/green automation remains the next milestone after the research unlock/reliability gate. [Unit 21 evidence and checklist](validation/UNIT21_RUN_L_DELEGATION_RECOVERY_2026-10-15.md).

## October 15: Run L stopped at invalid-reference recovery before smelting

- **One authorized trial.** Pushed candidate `0fbc4bff`; deployment/prompt/manifest and all 31 active/packaged mod files verified. Fresh actor 24, zero humans, speed 1, unchanged starter. Actual CLI-proxy model `gpt-6-luna`; 11 provider responses, no provider errors, Jev 17/17. No operator corrections or retry.
- **Progress/stop.** Gathered 10 copper ore, 50 iron ore and 5 stone. A two-operation submission then failed `unit_number` validation before admission. Recovery classified it `unknown` and chose `wake_planner` with observations disabled. Two unsupported blocker replies exhausted the existing allowance, producing a guard pause after 4m30s. No red packs or green unlock; Unit 19/20 failure conditions were not reached.
- **Next boundary.** Add a full-loop invalid-reference correction that can discover current entity facts, preserve committed result checkpoints and finish through native receipts without raising limits. Run L also captured an acquisition-checkpoint/result-scope discrepancy. Exact invalid tool arguments were not logged; do not invent them. [Run L evidence and concrete follow-up](validation/LUNA_GREEN_LIVE_RUN_L_2026-10-15.md).
- **Preserved.** Checkpoint save and traces retained; stack down. Offline run-check has zero flagged signatures/parse errors, which does not establish gameplay success. Red/green automation remains the next production milestone after the recovery gate and research unlock.

## October 15: Run K admission fix and full-loop regressions pushed

- **Unit 20.** Reviewed source/tests `da8d3bdb`, no-ff integration `d16a15db`. A native craft rejection can no longer be overwritten by queued future supply. Existing bounded correction requests acquisition, its receipt and settled inventory before the craft; canonical goal/step, native validation and retry limits remain intact.
- **Proof.** Six new static full-loop scenarios cover receipt sequencing through verified science output, held-stock admission, bounded repeated refusal, stop/epoch fencing and lost-ack restart without replay. Final tests reproduce Run K's exact failure on original modules. The new native queued-craft lane proves the accepted unsafe prefix on an independent control map, then refuses before mutation and crafts/verifies one real red pack on a pristine proof map.
- **Gates.** Frozen and merged candidates pass 2,365 runtime/staging and 1,142 mod tests, typecheck/Lua checks; frozen code passes six real-engine lanes including the existing recovery/production canaries. Reviewed integration pushed at `0fbc4bff`.
- **Trial/next.** The authorized CLI-proxy Run L concluded at a different boundary before smelting. Red/green assembler/inserter automation remains the next production milestone, with native output and research-continuity evidence. [Unit 20 checkpoint and next milestone](validation/UNIT20_QUEUED_CRAFT_ADMISSION_2026-10-15.md).

## October 15: longer Run K reached red science, stopped at queued-stock admission mismatch

- **Unit 19 integrated.** Code `2e24b74f`, merge `01424bcd`, pushed candidate `bcc4e843`. Five full-loop regressions pass; full unit/merged static gates and five native lanes are green. The Run J completed-slice checkpoint guard remains intact and its fault did not recur.
- **Longer live result.** One authorized CLI-proxy run lasted 40m36s, with 112 successful main-provider responses, no provider errors and 94 Jev responses. Luna autonomously crafted a lab, unlocked red science and hand-crafted 21 red packs. Three actual auto-resumes continued their plans. Zero humans, speed 1 and unchanged starter; no operator corrections.
- **New stop.** Batch stock credited a queued one-plate withdrawal toward a craft in the same admission call. Native crafting validates current ingredients before queueing, so operation 2 refused; operation 1 later completed. Its uncertain partial admission/receipt is preserved. Green research and recipe unlock remain false; no powered lab was reached.
- **Next.** Separate admission-time versus queued-effect stock fix and static/native full-loop regression remain open. No blind prefix replay or new live run. Save/full rotated traces preserved and the isolated stack is down. [Run K checkpoint and proposed regression](validation/LUNA_GREEN_LIVE_RUN_K_2026-10-15.md).

## October 15: Run J completed-slice fix integrated; next trial authorized

- **Unit 19.** Reviewed fix `2e24b74f`, merged at `01424bcd`. Completed-slice planner blockers enter existing bounded outcome/recovery handling before checkpoint persistence. Corrected batch-bearing and planner-only successors retain separate identity and a spent durable recovery allowance; the active-step guard is unchanged.
- **Full-loop proof.** Exact Run J reply reproduces the old fault. Five passing Session/receipt scenarios cover both successor routes through verified goal completion, exhaustion, stop and epoch fencing. Completed history and goal identity are preserved; no fake stock/research completion.
- **Gates.** Unit and merged canonical Docker gates passed: 2,358 runtime/staging, 1,142 mod tests, typecheck/Lua checks. Frozen-candidate recovery-loop, production, craft-trigger, native-admission and steam-lab lanes passed. Independent review found no concrete merge blockers.
- **Next.** Louis authorized one further longer CLI-proxy trial toward green science after these checks. It starts after the pushed candidate's server build and deployed-file/cold-world verification. No preset duration cutoff or corrective gameplay; existing controller bounds and the 50% usage floor stand. [Unit 19 checkpoint](validation/UNIT19_COMPLETED_SLICE_CHECKPOINT_2026-10-15.md).

## October 15: CLI-proxy run J progressed, then hit a completed-slice harness fault

- **One authorized trial.** Candidate `9550ecc9`; deployed runtime/prompt/mod files matched, fresh actor 14, zero humans, speed 1 and the unchanged starter. Actual model `gpt-6-luna`; 40 provider requests/responses, zero provider errors; Jev 43 requests/responses. No operator corrections or retry.
- **Progress.** Native copper mining/smelting/collection reached 10 held copper plates with empty furnace output; Luna continued to 50 held iron plates. No auto-resume fired, so the new recovery paths were not directly exercised live. No red science, lab/steam cell or green research completion.
- **Stop.** After a completed slice, a checkpoint-bearing planner `BLOCKED:` reply was persisted against a still-completed plan; `persistPlannerCheckpoint` raised `checkpoint_requires_active_step` (system harness fault). Run-check confirms that fault and an unrecoverable request failure, with no parse errors. This differs from run H's paused-plan activation path.
- **Preserved/next.** Trial concluded after 12 minutes, checkpoint save/traces preserved and isolated stack down. A captured replay case and bounded-routing design are recorded; production fix and runnable regression remain open before another live run. [Run J checkpoint](validation/LUNA_GREEN_LIVE_RUN_J_2026-10-15.md).

## October 15: units 17/18 pushed; local image and startup gates complete

- **Remote integration.** Reviewed unit merges `14a03571` and `e39eea27` are included in `origin/experiment/jev-agent-architecture` at source candidate `451bd0e1`. The clean integration worktree remains `peaceful-saha-a52c6f`; the older root checkout's uncommitted docs and local branch ref were preserved.
- **Green gates.** Canonical Docker static gate: 2,353 runtime/staging and 1,142 mod tests, typecheck and Lua checks. Frozen-image recovery-loop, production, craft-trigger, native-admission and steam-lab lanes passed. No runtime/mod changes followed those tests.
- **Packaged image.** Full local server build from the pushed source passed. All 51 runtime/prompt files match source, all 31 mod files match the passing engine image, and manifest validation passes. A fresh network-disabled, dummy-provider container reached standalone-NPC readiness, saved and stopped gracefully with exit 0; no provider reservations. No existing server restart or settings edit.
- **Next.** Local preparation is complete. Run J still requires Louis's go and the actual chosen live-run container's cold-start/file verification. No live provider run or Pterodactyl deployment occurred. [Integration and exact image evidence](validation/UNIT17_18_INTEGRATION_2026-10-15.md).

## October 15: unit 18 native recovery regressions complete (local)

- **Integrated locally.** Merge `e39eea27` on `og-port-integration`; runtime fix `7b8fe59`, frozen code/test candidate `4783226c`. The native G/H/I chain reaches verified completion across two Factorio/Node restarts, with lost-acknowledgement settlement, zero replay dispatches and pending-timer cancellation. Scripted main-model/Jev only; no network inference.
- **Real-timer fix.** A supervisor event detaches from a completed inherited provider-turn scope before entering the queue. The native lane exposed the stale-generation rejection; the new `R-scope` regression asserts verified completion and the correlated `recovery.queue_scope_detached` trace. Existing stale-work/cancellation guards and retry limits remain intact. Fifteen composed recovery scenarios now pass.
- **Validation.** Frozen-image recovery-loop, production, craft-trigger, native-admission and steam-lab lanes all passed, exit 0. Merged canonical Docker gate: 2,353 runtime/staging and 1,142 mod tests across 128 files, plus typecheck and Lua checks; exit 0. Independent reviews found no merge blockers.
- **Limits/next.** Recovery runs at speed 1 with zero humans and one declared seeded furnace fixture; nearby native reads revalidate target and current output after restart. This proves mechanics/recovery, not autonomous green science. No push, live provider run or deployment. Pushed-candidate deployment verification and Louis's go remain required before run J.
- **Evidence.** [Unit 18 checkpoint](validation/UNIT18_RECOVERY_ENGINE_2026-10-15.md) and [updated pre-live plan](validation/RECOVERY_LOOP_RECONCILIATION_2026-10-14.md).

## October 14: unit 17 composed recovery regressions complete (static proof)

- **Integrated locally.** Merge `14a03571` on `og-port-integration`; runtime fix `e1aaf952`, final tests `a9663f98`. Fourteen composed scenarios cover G→H→I through verified completion, disk restore, takeover/actor cancellation and completed/unknown operation effects without replay. No skipped tests or TODOs.
- **Restart fixes.** C7 recovery rebuilds bounded fresh local machine observations before deriving available output. Exact completed restart evidence settles through the existing idle-receipt guard with current actor and recovery-request correlation. Clearing an operation never substitutes for world-state goal verification. Unknown effects, authority boundaries and retry limits are preserved.
- **Validation.** Unit-worktree Docker gate: 2,352 runtime/staging and 1,142 mod tests passed, plus typecheck and Lua checks; independent review found no merge blockers. The same full gate passed on merged candidate `14a03571`, exit 0 (`unit17-integration-all.log`).
- **Next.** Unit 18 native recovery-loop proof and frozen-candidate engine/deployment checks remain open. No live provider/Jev call, push or deployment in this unit.
- **Evidence.** [Unit 17 checkpoint](validation/UNIT17_RECOVERY_LOOP_2026-10-14.md) and [reconciled pre-live plan](validation/RECOVERY_LOOP_RECONCILIATION_2026-10-14.md).

## October 14: port unit 13, pause class follows who can fix the refusal (static lane, not live-validated)

- **One terminal decision.** `classifyBlockedEnd` (refusal-class.mjs) decides the pause class of a request that ends on a refusal, from the refusal class, which executor recoveries were spent and whether it is world evidence. An argument refusal after its retry, or a world refusal after a recovery it spent, ends as a `model_recoverable` pause (`preflight_executor_refusal_uncorrected`) with the step untouched, and unit 7 restages it. Everything else keeps the unit 12 guard pause. Both ends trace `operations.blocked_end_classified` with `request_id`, `recovery_spent`, `pause_class` and `reason`.
- **Two meanings of never-wake.** The world-correction exclusion is now `EXECUTOR_UNFIXABLE_WORLD_CODES` (recipe_locked, authorization_stale, duplicate_effect_suppressed, no_actor, different_surface, bootstrap_dependency_unresolved), declared beside the refusal class with the reason for each. `NEVER_WAKE_PREFLIGHT_CODES` keeps only its MW5 meaning, so supply_missing now gets the correction turn.
- **Deadlock freeze.** The third identical failure on a step (the request plus unit 7's two restages) trips the deadlock detector and froze the plan with no visible end. `finishPreflightRecoveryFailure` now ends that as one guard pause `blocked_<reason>`, traced `operations.recovery_failure_frozen` and `goal.paused`. For a repeating executor refusal this fires on the same attempt as the per-step cap, so `recovery.auto_resume_exhausted` is not reached for it.

## October 14: port unit 12, world-refusal correction turn and declared terminal pause (static and engine lanes, not live-validated)

- **Correction turn.** A declared world-class preflight refusal that is not harness world evidence gets one correction turn carrying the refusal facts. A second refusal pauses the plan as `model_recoverable` (`preflight_world_refusal_uncorrected`), which unit 7's capped auto-resume restages. The exclusion reuses `NEVER_WAKE_PREFLIGHT_CODES`; there is no second list.
- **Terminal pause.** Every other request that would end `blocked_preflight` goes through one function, `endBlockedPreflightWithPause`. It applies a durable GUARD pause `blocked_<code>`, traces `operations.blocked_end_paused` and `goal.paused` with `request_id`, and sends one chat line. A timer never resumes it. This covers recipe_locked, a world-evidence refusal whose replan wake was skipped, unclassified refusals, authority or argument refusals after their own retry, and non-research prerequisites.
- **Transport.** `preflight_transport_error` is now a transport pause with no correction turn.
- **run-check.** Gains `silent_blocked_stall`, which flags a blocked request that nothing wakes again.
- **Test fix.** A flaky handoff test failed because two restages in the same millisecond got the same handoff id. The packet now includes the conversation sequence.
- **Gate.** 2291 runtime tests pass. All four engine lanes pass on `7f8d0021`. No installer repin was needed.
- **Open.** Argument-after-retry and supply_missing end in a GUARD pause, which is a dead end with zero humans. `model_recoverable` may fit better. Decide from run H evidence.

## October 14: live run G on ec6b8385 (first live auto-resume, then a silent world-refusal stall)

- **Setup.** Candidate `ec6b8385` (units 7 to 10) in a freshly generated world, zero humans, game speed 1. One objective, no operator gameplay after the starter kit. The operator stopped it after 28 idle minutes. [Checkpoint](validation/LUNA_GREEN_LIVE_RUN_G_2026-10-14.md).
- **Worked.** The goal was admitted with a new goal_id. A one-step plan (electronics and steam-power research triggers) was committed. The executor mined 50 iron ore and 10 copper ore natively and placed a stone furnace.
- **First live auto-resume (unit 7).** An unverified world-blocker claim exhausted fresh-context recovery, and the goal paused as `model_recoverable`. `recovery.auto_resume_scheduled` fired, and a fresh restage continued the step.
- **Stall.** A batch with `gather_resource coal 10` and a `supply_entity` into the furnace was refused with `supply_destination_conflict`. Iron ore and copper ore both target the furnace's one-slot source inventory. The refusal is `world` class, the MW5 replacement wake skipped it, and the request ended `blocked_preflight` with no pause. The model never saw the refusal facts, and the NPC stayed idle with an active goal.
- **run-check.** Reported `restage_loop` (three times) and `stale_step_tracker_behind_batch` (once). Both follow from one coarse research-trigger step, and neither caused the stall. run-check did not flag the stall itself. Unit 12 addresses that gap.
- **Not reached.** No smelting, red science or research. `logistic-science-pack` was not researched.

## October 14: live run F on ec6b8385 (DNS failure, no gameplay)

- **Setup.** The same candidate `ec6b8385` in a freshly generated world, actor 11, zero humans, game speed 1, with the run E starter kit and objective. [Checkpoint](validation/LUNA_GREEN_LIVE_RUN_F_2026-10-14.md).
- **Result.** The first planner call failed after 187 ms with `fetch failed` and was marked `recoverable=false`. The goal was never admitted. There were no provider responses and no world actions. run-check reported `request_failed_unrecoverable`.
- **Cause.** Infrastructure. The CLI-proxy host did not resolve from inside the container or from the host. Run E reached the same proxy on 2026-10-13. No gameplay was tested, so run F does not validate units 7 to 10.
- **Finding 1 (unit 11).** The cause code was dropped. The logs said only `fetch failed`, so a DNS outage could not be told apart from a refusal or a timeout.
- **Finding 2 (unit 11).** A transport failure on the first planner call lost the objective, because auto-resume only recovers a paused plan. With zero humans, the NPC stayed idle.

## October 13-14: port units 8, 9 and 10 (static and engine lanes, not live-validated)

- **Unit 8 (`e695d251`).** Executor targeted reads that admit the executor step id, trigger production roots, machine energy kinds and burner fuel facts carried to the executor as harness facts.
- **Unit 9 (`26814155`, fix-forward `ec6b8385`).** `entity_count` step contracts, build bills from `place_items`, science residual from research progress, `harvested_from` for trees and rocks, and trigger readiness (`credited_only_after_prerequisites`). The fix-forward is a test-teardown retry only.
- **Unit 10 (`b45d9f7f`).** Fluid-port placement with `connects_to`, rechecked at execution. Nearest-first water reads with chunk coverage. Electric prototype facts for pole reach, power, fuel and pumps.
- **Candidate `ec6b8385`.** Gate green. The production, craft-trigger, native-admission and steam-lab engine lanes passed. Not live-validated. The live runs on this candidate are F and G above.

## October 13: port unit 7, declared pause classes and bounded auto-resume (static only, not live-validated)

- **Declared class.** Every pause now carries `pause_class` (`transport`, `model_recoverable`, `authority`, `operator`, `system`, `guard`) from the registry `runtime-v8/pause-class.mjs`, declared where the pause is created and stored in the planning reducer's durable run state. A missing or unknown class never auto-resumes and is traced (`recovery.pause_unclassified`). The transport subkind comes from structured provider fields (`http_status`, `transport_subkind`); the message regex remains only as a legacy fallback for re-wrapped errors.
- **Auto-resume.** `transport` keeps its in-memory backoff. A `model_recoverable` pause (run E's `provider_action_omission_repair_failed`, a rejected unverified blocker, output budget exhausted without evidence) resumes after 15 s through the existing interrupted-plan recovery with a fresh executor restage; the committed plan, goal and step identity are untouched. Authority, operator, system and guard pauses never resume.
- **Bound.** Owner-delegated 2026-10-13: at most 2 resumes per step identity (goal, plan, plan version, step) without verified progress, and at most 6 per goal. Both counts live in durable plan state and survive a restart; only a verified batch receipt for the step (or the step verifying) resets the step count. A scheduled resume carries actor, epoch, goal, plan, plan version and step and cancels with `recovery.auto_resume_cancelled` if any changed by fire time.
- **Trace and run-check.** `recovery.auto_resume_scheduled|started|exhausted|cancelled` and `recovery.pause_unclassified`; `run-check` flags `model_recoverable_pause_not_resumed` and `auto_resume_exhausted`.
- **Gate.** Static scenarios only (`pause-class-auto-resume.test.mjs`, `run-check.test.mjs`); no real-engine lane and no live provider run. `pause-class.mjs` joins the installer copy list, so the installer payload needs a repin.

## October 14: port unit 11, cause codes and the intake retry (static only, not live-validated)

Follows live run F ([checkpoint](validation/LUNA_GREEN_LIVE_RUN_F_2026-10-14.md)): the proxy host did not resolve, the first planner call failed with `fetch failed`, and the objective was lost.

- **Cause code.** `provider.error` and `request.failed` now carry `cause_code` (a short upper-case token read from `error.cause.code` or `error.code`; never the cause message, URL or host) and, for a transport failure, `pause_class: transport` and `transport_subkind`. DNS codes (`ENOTFOUND`, `EAI_AGAIN`) and the other undici network codes classify as transport. Context-window and output-budget failures stay excluded.
- **Intake retry.** A transport failure on the first planner call of a new goal (no plan, no committed goal work) is kept by the supervisor as one durable pending intake retry (`memory.intakeRetry()`, in `npc-state.json`): sender, text, intent, request id, actor and epoch it was received under, attempt, next time. It reuses unit 7's transport schedule and limits (`autoResumeDelayMs`, `autoResumeMaxAttempts`), is cancelled synchronously by any player request or UI control (`cancelAutoResume`), is fenced at fire time on actor, epoch and an admitted goal, survives a restart, and ends with one chat line when exhausted. Any other failure at intake behaves as before.
- **Trace and run-check.** `recovery.intake_retry_scheduled|started|cancelled|exhausted`. `run-check` treats a `request.failed` with a scheduled retry as informational (`intake_retry_scheduled`); `intake_retry_exhausted` and a non-transport `recoverable=false` failure remain findings.
- **Gate.** Static scenarios only (`intake-retry.test.mjs`, `run-check.test.mjs`); no live provider run. No new runtime module, so the installer copy list is unchanged.

## October 13: CLI-proxy rerun E (transport fixed, copper mined, controller paused)

- **Provider repair.** Attempt D had resolved stale local LM Studio/Qwen settings and failed with connection refused. The owner confirmed the intended CLI proxy with `gpt-6-luna`; rerun E used that configuration, authenticated HTTP 200, and 12 successful responses with zero provider errors. `.env` was not read or edited.
- **Evidence.** Candidate `05c6c35f`, 49 runtime/staging and 31 mod files matched. Fresh standalone actor 9/epoch 1, zero humans/speed 1, unchanged starter procedure. Luna mined 10 copper ore natively.
- **First blocker.** No next smelting/acquisition action after mining; bounded fresh-context/action-omission recovery exhausted and the controller paused (`provider_action_omission_repair_failed`). No copper plate, red science or green research completion. Trial concluded, save/traces preserved, stack down, no further retry. Usage remained 73%, above the 50% floor.
- **Checkpoint.** [Provider repair and completed rerun E](validation/GREEN_SCIENCE_LIVE_E_2026-10-13.md).

## October 13: authorized green-science attempt D (provider failure, no gameplay)

- **Candidate/deployment.** Clean pushed HEAD `35150fc61244d25a1992f50025d3e824ddf19b08` (reviewed code `16138b9a`) built with `-NoEnvUpdate`. All 49 shipped runtime/staging modules matched candidate source after CR normalization; all 31 active mod files matched the release.
- **Current model.** `qwen3-coder-30b-a3b-instruct`, confirmed from non-secret config and the actual request payload. Existing gameplay settings were preserved; no `.env` read or edit.
- **Result.** One cold-world raw-chat objective created goal `goal_1aai7qd_1` for standalone actor 11/epoch 1, request `req_mv6fo1ee_1`. The first and only Luna provider request failed with `fetch failed`, followed by `request.failed recoverable=false`; four Jev calls. No committed plan, gameplay operation, red science production/consumption or research completion. Green science remains unproven; the transport cause is not established.
- **Stop/evidence.** Stopped at the first blocker, final save preserved, one RCON closed and isolated Compose stack removed. No corrective prompts, provider retry, runtime changes or second run. Zero humans and speed 1 throughout. `run-check` flags `request_failed_unrecoverable`. Weekly allowance was 76% remaining at shutdown.
- **Checkpoint.** [Attempt D and exact evidence paths](validation/GREEN_SCIENCE_LIVE_D_2026-10-13.md); local evidence `test-results/luna-green-live-2026-10-13d/`.

## October 13: green-science prerequisites, second static pass

- **Integrated.** Native surface-applicability filtering (`5c9826cb`) and one native-grounded resource search through the existing durable targeted-read allowance (`ec2f359a`). Normal observation limits are unchanged. Both received independent source review.
- **Engine evidence.** Powered-lab fixture (`481a1196`, evidence update `133504ff`) passed the focused steam-lab and full production lanes. Real research advanced after native pole placement, with one lab, the original steam engine, zero humans and speed 1. Seeded science/prerequisites make this a mechanics proof; autonomous green science remains unproven.
- **Combined static gate.** 2,173 runtime/staging tests and 1,108 mod tests passed, plus typecheck, Lua build and generated-Lua validation; 9 installer payload tests passed.
- **Candidate.** Unit 4 batch stock (`3fd26f42`, merge `0708bd4b`) and fresh native recipe projection (`16138b9a`) are reviewed and green. All preparation prerequisites passed. The one authorized attempt is now concluded as attempt D above, blocked by the first provider transport failure before gameplay. The owner set a 50% weekly remaining hard floor; 76% remained at shutdown.
- **Durable checklist.** [Green-science red-to-green pass](validation/GREEN_SCIENCE_RED_TO_GREEN_2026-10-13.md).

## October 13: run C static repairs integrated (gate green, not live-validated)

- **Code.** Unit 6 raw acquisition facts (`ab2290f3`, merge `015c2ab3`) and rejected-blocker recovery/diagnostics (`fdb55d72`, merge `b974dc97`); installer repin `473327a0`.
- **Result.** Executor handoffs now carry bounded native mining-source observations for missing raw materials, without expanding ore recycling/crushing recipes. Rejected model blockers receive the existing durable recovery attempt instead of being relabelled provider outages. Exhaustion remains explicit and bounded.
- **Validation.** Combined Docker gate: 2,129 runtime/staging and 1,105 mod tests passed, plus typecheck, Lua build/check, and 9 payload tests. Independent review passed. The revised checker flags the original 99-row run C trace with `rejected_blocker_pause`.
- **Next.** Unit 4 batch stock and unit 5 powered-lab/research-progress proof remain open. The general observation budget and surface/expansion-aware recipe eligibility still need focused follow-up. No new live run or deployment.
- **Checkpoint.** [Static follow-up and remaining work](validation/LUNA_RUN_C_STATIC_FOLLOWUP_2026-10-13.md).

## October 13: GPT-6 proxy live run c on `572d4600` (paused on step 1, not green science)

- **Setup.** Cold start, objective "research logistic science", actor 20, zero connected humans, starter kit only. Luna model `gpt-6-luna` through the CLI proxy. Deployment matched the candidate (48 runtime modules, 0 mismatches).
- **Result.** The planner committed one step: produce 10 copper plates. The executor found no copper ore within radius 32 and had no acquisition fact for it. The model answered BLOCKED. The harness rejected that blocker as unverified, then accepted the same text as `recoverable_provider_failure`, and the goal paused on step 1. No gameplay was executed. About 46 s and 7 Luna calls, no provider errors.
- **Findings.** Raw leaves lack native acquisition facts. A rejected unverified blocker still pauses autonomy. The executor observation budget ends after 4 reads. Recipe closure carries Space Age recipes into a base-game goal. `run-check` reported no failure signatures for this pause shape.
- **Next.** Unit 6 (raw-leaf acquisition facts) started 2026-10-13. The blocker-rejection pause and the `run-check` gap are queued. Each finding gets a static fixture before another live run, which waits for the owner's go or the standing allowance window.
- **Checkpoint.** [Run c](validation/LUNA_GPT6_PROXY_LIVE_RUN_C_2026-10-13.md). Runs a and b were stopped before the goal by provider configuration and have no gameplay evidence.

## October 12: goal-pursuit native admission fixes ported to OG, unit 1 (static gates and real-engine lane passed, not live-validated)

- **Why.** The owner concluded the direct goal-pursuit loop on 2026-10-12 and chose this harness. Its useful output was the native admission fixes in `packages/autorio`, now ported. The plan and build status are in the [port plan](validation/GOAL_PURSUIT_LESSONS_AND_OG_PORT_PLAN_2026-10-12.md#build-status).
- **Native preflights** (merge `969fefb2`). They refuse, with stable codes and before dispatch, work the native layer cannot complete:
  - gathers, navigation and harvests with no source in the radius;
  - a recipe set on a furnace;
  - a reach inside a furnace collision box;
  - mixed or competing supplies, and transfers to an absent human;
  - a placement item that isn't held.
  - `harvest_product` is natural-only, and its target selection is exact.
  - The admission reconcile no longer treats a missing receipt as complete.
- **OG policy.** `6fabdf5d` and `afa0aa40` give argument-error refusals the one bounded correction turn. These are malformed args, a reach inside a furnace, an expired placement candidate, and a product no tree or rock yields. World-in-radius refusals still freeze through `blocked_preflight`, with an MW5 replacement attempt, pending the owner's decision. A same-batch craft defers `placement_item_missing`, traced as `placement.preflight_item_deferred`.
- **Gates.** `bash scripts/test-local.sh all` exit 0: 2,076 runtime tests and 1,089 mod tests. The installer payload did not change.
- **Real engine.** New opt-in lane `native-admission` (`c2ac975a`, `a0647b49`). `NPC_TEST_LANES=native-admission` passed on 2026-10-12, with zero connected players. It covered:
  - refusals that left the world and the OG record unchanged;
  - the real-engine recipe correction turn;
  - harvesting a tree and a map rock, and the exact ore under a tree;
  - held-item and craft-then-place placement.
- **Rock fix** (`db8bfae0`). The lane found that Factorio sets `is_building` on every simple-entity, so the harvest guard had excluded map rocks. The pursuit source had the same bug. The guard now excludes only placed buildings (with an owner or a placing item).
- **Open.** Units 2–5 of the port plan.

## October 12: port unit 2, facts, diagnostics and refusal classes (merged, gate green, native-admission lane PASS, not live-validated)

- **Facts** (2a, merge `175cde97`). `getEntityStatus` reports `status_name`, `energy_source`, `energy` and `electric_network_id` for machines. A new bounded tool, `getFluidSourceTiles`, reads fluid terrain; the tool contract golden is updated. A wrong entity name is refused as `unknown_entity_prototype`. Traces: `observation.fluid_sources_observed` and `observation.entity_read_refused`.
- **Seam fix.** `supervisor-adapter.mjs` `transformNearbyEntities` used to turn an `ok:false` refusal into an empty scan. It now forwards `ok:false` unchanged.
- **Provider timeout diagnostics** (2b, merge `7b23ae71`, `a8021ed5`). Timeout traces carry `response_stage`, `response_bytes`, `http_status` and `response_content_type`. The `reading_error_body` stage is real.
- **Refusal classes** (2c, commits `f01225e9` `ab39ab76` `1cd94b4c` `35c0f5d5` `1d81df66`, merge `e818d83a`).
  - Every mod preflight refusal declares a class from the closed set `argument | authority | prerequisite | world`. The registry is `packages/autorio/src/refusal_classes.ts`, stamped in `autorio_preflight.operation`. Admission codes declare theirs through `ADMISSION_REFUSAL_CLASS` in `authorization.mjs`. The shared set is `deploy/pterodactyl/runtime-v8/refusal-class.mjs`.
  - The OG loop chooses recovery by declared class. `argument` gets the one bounded correction turn; the others go through `blocked_preflight` and MW5. A missing or unknown class fails closed to `world` and emits `operations.preflight_unclassified`.
  - `invalid_name` and `unknown_technology` are now `argument`.
  - A static guard test fails if any refusal literal in the mod lacks a class. This removes a bug class instead of growing a list.
- **Installer.** `refusal-class.mjs` is now shipped, so the payload is repinned (`ce4b025e`). The pin check and `build-payload.test.mjs` (9/9) pass.
- **Gates.** `bash scripts/test-local.sh all` exit 0 on `e818d83a`: 2,098 runtime tests and 124 mod test files. The real-engine `native-admission` lane passed.
- **Open.** The "nothing found in radius" codes stay `world`. The planner-wake list in `replacement-wake.mjs` and `TRANSFER_SUPPLY_PREFLIGHT_CODES` are hand lists that could later come from the producer. Unit 5 (powered lab with research progress) is still open; the steam-power fixture already exists.

## October 12: port unit 3, active-step fact handoff (merged, gate green, native-admission lane PASS, not live-validated)

- **Water anchors** (3a, `7acf4ccb`). Validated `getFluidSourceTiles` answers become historical anchors for the goal (at most 16, 4000 chars, keyed `surface:x:y`). Executor restages carry them as a `fluid_source_hints` record labelled historical; the model must re-check before placing. An empty or failed read never erases them. Trace: `context.fluid_source_hints_carried`.
- **Recipe closure** (3b, `7e4cd887`, `645ec17f`, `f0fc5ac8`). At restage the harness reads `getRecipeDetails` for unseen step roots, breadth-first, at most 8 reads per handoff. It never reads during a batch and stays inside the actor/epoch fence. A lab root now yields its circuit and gear crafts. `normalizeRecipeFact` marks a recipe incomplete when an amount is missing or a probability is out of range. The mod's no-recipe answer declares `code: 'no_recipe'`, so the harness no longer matches error text. Trace: `context.recipe_closure_prefetched`.
- **Not ported, on purpose.** Raw historical entity ids and positions (OG withholds them so stale targets are not reused), and pursuit's reads kept after a refusal.
- **Deferred.** Fresh reads of known machines at restage (3c), until a steam-chain scenario shows the need.
- **Gates.** Merge `572d4600`: runtime 2,116/2,116, mod 124/124 files, `native-admission` lane PASS. The installer payload did not change, so no repin.
- **Live.** No live run has been made on this build. A GPT-6 proxy run was set up on 2026-10-13 (image `572d4600`, isolated project, empty data dir) but stopped before any goal was sent, because the stack read a non-GPT-6 local model setting. No provider calls were made. It waits for the owner to confirm the provider configuration.

## October 9: step identity by text, just-in-time step contracts (static gates passed, not live-validated)

- **Execution-draft wording** (`81ac9958`, owner OK). Planner prompts say every execution step is deterministic.
- **Executor step identity after a replacement** (`643940f3`). A reply without a `stepId` is resolved by the step text its own list names, not by comparing index frames.
  - A text that names a verified step is refused as `executor_stale_step` with reason `step_text_names_verified_step`.
  - A text-resolved reply is traced as `executor.step_resolved_by_text`, counted by `run-check` as informational.
  - This closes the October 8 open item where a board-index reply paused the goal.
- **Just-in-time step contracts, P1+P2** (`f111edc9`). Steps after the first are committed with a pending contract and bound by a planner step contract call when they become active. See [the roadmap build status](NPC_PLANNING_ROADMAP.md#one-step-contract-prediction-owner-decision-2026-10-08-p1p4-implemented-2026-10-23).
  - `run-check` counts deferred and just-in-time contracts and flags `step_contract_unavailable` pauses.
  - The installer payload did not change; the pin check passes.
- **Gates.** `bash scripts/test-local.sh all` exit 0: 2,066 runtime tests and the mod lane.
- **Open.**
  - P3/P4 were unbuilt at this checkpoint and are implemented in the October 23 update above.
  - The mod's task board parses `contract_kind` but does not render it, so a pending contract is not shown.
  - The next live Haiku run waits for the owner's go.

## October 8 after trial C: semantic steps prevented, minimal MW5 recovery wired (static gates passed, not live-validated)

- **Prevention.** Execution plans may declare only deterministic checkpoints (`68b7945f`).
  - A semantic step in an execution draft is refused at commit as `semantic_step_in_execution_plan`, traced as `plan.semantic_step_refused`.
  - `assessmentOnly` slices are unchanged. Committed plans from saved games keep working.
  - Planner prompt and schema wording now state the same rule.
- **Minimal MW5** (`b0cf4b59`, installer pin `43fc6dbc`).
  - A chat objective gets a `player_task` grant.
  - A committed plan that becomes BLOCKED by a harness-evidenced world change wakes the planner with `[PLAN_BLOCKED]` to author a replacement under MW1. It is capped at 3 per goal by a durable counter.
    - A world change here is an allowlisted preflight code, or a proven admission refusal.
  - The player gets one chat line per replacement.
  - Deadlocks and provider failures never wake the planner.
  - The protected-structure gates apply to Luna's own replacement plans and to a future Auto mandate.
- **Gates.** `bash scripts/test-local.sh all` exit 0: 1,974 runtime tests and 120 mod files.
- **Open.**
  - An executor reply that uses the board's step index instead of `stepId` after a replacement is refused and pauses the goal.
  - The one-step contract prediction was unbuilt at this checkpoint; see the October 23 update above.
- **Deterministic control-JSON repair** (`dec23c37`, installer pin `16cc9bcf`).
  - Fixes only stringified arrays, stringified objects, closed-enum strings that were encoded twice, and trailing commas.
  - Runs only after a pure shape failure and before any stateful check. Never on replies with several tool calls.
  - Traced as `provider.control_json_repaired` or `provider.control_json_repair_failed`.
  - Trial C's twice-encoded `developmentMode` used to be dropped silently by the salvage; it is now kept.
  - Gate: 1,998 runtime tests and 120 mod files.

## October 8 Haiku trial C: slice hand-over fixed live, paused on a semantic smelting step

Owner-approved rerun at `2281bd1f` (`claude-haiku-5-5`, CLI proxy): 47 Luna and 54 Jev calls, 1,023 seconds, zero humans or corrections. Two full slices and one step of a third verified (9 steps, red science unlocked); slice 2 handed over with `budget.continuation_slice_reset`, and all 23 executor replies bound by `stepId`. The planner then declared a smelting step semantic; the executor was refused (`semantic_step_cannot_mutate`), reported a blocker, and the goal paused as a recoverable provider failure. Open: semantic world-changing steps are accepted at commit and have no route back to the planner, and bound executor replies can no longer use the semantic-to-deterministic transition. Details: [trial C](validation/LUNA_HAIKU_LIVE_2026-10-08C.md).

## October 8 Haiku trial B and per-slice continuations: repaired, static gates passed

Owner-approved rerun at `a8610bb5` with `claude-haiku-5-5` through the CLI proxy: 41 Luna calls, 542 seconds, zero humans or corrections. Step identity held (11 bound by `stepId`, 9 correct legacy indexes, no refusals) and Luna verified all four steps of the first slice (50 iron and 12 copper plates, two fuelled furnaces). The hand-over to the next slice then paused with `continuation_limit_10` because the request-wide continuation counter (14) was compared with the non-active limit once the slice completed. Merged `f9a8a627` measures continuation limits per plan slice, resets only after a slice with a verified deterministic close and an admitted operation batch (generation-fenced), adds a 256 request-wide backstop, and gives delegated executor rounds a `submitPlan` schema requiring `stepId` with matching executor-only prompt wording. Not yet live-validated. See [the trial B record](validation/LUNA_HAIKU_LIVE_2026-10-08B.md).

## October 8 Haiku live trial and executor step identity: repaired, static gates passed

Owner-requested cheap run at `3dc1de6d` with `claude-haiku-5-5` through the CLI proxy: 10 Luna and 14 Jev calls, 390.8 seconds, zero humans or corrections. Luna closed two of three steps (58 iron plates) but echoed a stale step index after an in-request step close; the v2 guard refused it outside the correction loop and the goal paused as non-recoverable. Merged `0f337065` binds executor operations to the committed step id, gives step-identity refusals a persisted allowance of two corrections per step, shares one step-transition fact and makes run-check flag terminal failures. Gate: runtime 1,906, mod 1,045, payload current. Not yet live-validated. See [the checkpoint](validation/LUNA_HAIKU_LIVE_2026-10-08.md).

## October 7 draft recovery and native trigger facts: repaired, final gates passed

Closed-round control guidance now reports the actual phase/tool state. Planner-owned drafts can request one bounded typed fact read; refused reads enter structured correction without losing declarations, and valid no-action commitment still delegates to a fresh Luna executor. Native craft-trigger facts include hand/category/producer capability and survive bounded grounding and historical executor handoff. Oversized blocker evidence stays valid JSON with explicit omissions. Independently reviewed units are integrated; frozen candidate `af050cc9` passes 1,889 runtime and 1,045 mod tests, typechecks, generated Lua, full Docker build and nine payload checks. All 45 shipped runtime files match the candidate. Native requirements, crafting triggers, research/combat and resilience passed on the final candidate, including real restart and crafting recovery. Two earlier native failures were retained and repaired without weakening assertions. Detailed evidence retained; owned temporary containers/worlds removed. Zero live provider calls or production deployment; autonomous red-to-green remains unproven. Shared weekly usage rose from 25% to 30%, including unrelated work, with the owner’s ceiling temporarily removed. [Contracts, review and final evidence](validation/LUNA_DRAFT_RECOVERY_2026-10-07.md).

## October 7 targeted-recovery live trial: paused before first batch

Owner-authorized fresh run at `38bc2018`: five Luna and four Jev calls, 60.194 seconds, speed 1, zero humans or corrective prompts/gameplay takeover. Luna corrected prerequisite ordering but tried to hand-craft copper plates. Preflight correctly required a furnace before commitment. Its targeted read was refused because the plan was still `DRAFT`; inconsistent tools-enabled versus tools-closed guidance and a refusal lacking completion declarations then led to a format correction and blocker. Canonical goal stays active, board paused at 0/4, red production/consumption zero, green research/recipe false. No successful targeted read or furnace reuse was reached. Evidence retained; container/network/worlds removed. Next gap is draft-stage planner/preflight recovery. [Live packet, attribution and cleanup](validation/LUNA_TARGETED_LIVE_2026-10-07.md).

## October 7 targeted observation recovery: static and native gates passed

The closed-round missing-fact repair is integrated and independently reviewed. Luna can request one typed exact entity, inventory or research read while preserving the committed plan; idle execution, ownership and correlation checks guard it. The allowance persists across restart and renews only with native receipt or active-step progress. Superseded handoff step facts no longer conflict with current planning state. Frozen candidate `61f70f54` passes 1,868 runtime and 1,041 mod tests, typechecks, generated Lua, full Docker build and nine payload checks; all 45 shipped image runtime files match. Native exact entity and research passed; the restart lane passed on one fresh retry after a retained process-shutdown stall. No live providers or autonomous-success claim. Shared usage is 21%, below this phase's 24% ceiling. [Conflict, contracts and build checklist](validation/LUNA_TARGETED_OBSERVATION_2026-10-07.md).

## October 7 repaired Luna trial: electronics completed, paused before iron smelting

Owner-authorized fresh run at `bea69cbc`: 21 Luna and 19 Jev calls, 330.916 seconds, zero humans or operator corrections. Luna committed deterministic checkpoints, mined copper and coal, recovered placement failure, fed a native furnace and completed electronics. It then mined 50 iron ore but claimed it could not reuse the copper furnace without another observation after tools closed. The harness retained the active goal and paused truthfully at 1/4; red production/consumption stayed zero and green research false. The earlier assessment-contract dead end did not recur. Logs and exact replies are retained; trial container/world discarded. Shared weekly usage reached that phase's 19% ceiling; the owner subsequently granted five more points for the targeted repair above. [Trial evidence and next investigation](validation/LUNA_SEMANTIC_LIVE_2026-10-07.md).

## October 7 planner contract boundary: repaired, live acceptance pending

The recorded all-semantic execution draft is now refused before commitment. New execution drafts require a deterministic world-result checkpoint; explicit `assessmentOnly:true` slices stay with the planner. Research instructions now consistently support future `research_completed` outcomes and multiple technologies. Frozen saved contracts remain unchanged, and the offline checker recognizes the original delegated semantic dead end. Independently reviewed units are integrated at `26ad8871`; Docker runtime 1,855, mod 1,036, typechecks, generated Lua, full build and nine payload checks passed. Native research, crafting and restart lanes passed with zero humans; no new live provider run occurred. Temporary worlds were discarded after preserving evidence. [Repair contracts and validation](validation/LUNA_SEMANTIC_CONTRACT_REPAIR_2026-10-07.md).

## October 7 fresh Luna + Jev trial: semantic contract prevents execution

Owner-authorized fresh run at `3278c4b1`: seven Luna calls and five Jev requests/responses, 60.229 seconds, zero gameplay batches, humans or operator corrective prompts. The planner committed three semantic assessment steps, then the fresh executor proposed copper gathering with conflicting deterministic declarations. Admission correctly rejected `semantic_step_cannot_mutate`; the executor exhausted its observations and paused. Canonical goal remains active, board paused at 0/3, red production/consumption zero and green research false. The previous handoff repair supplied fresh research reads and four executor observations as intended. Next repair is the planner/executor completion-contract boundary, preserving committed semantics and using authorized successor planning. Logs/state retained; test container and worlds discarded. [Evidence, attribution and bounded follow-up](validation/LUNA_AUDIT_LIVE_2026-10-07.md).

## October 7 audit repairs: static and native gates green

The five confirmed runtime audit defects are repaired and independently reviewed: goal/actor completion fences, fatal provider refusal handling, Jev-only routing quota, correlated historical receipt settlement after restart, and atomic concurrent provider reservations. Newly authored receipt contracts also reject unsupported wait/research proof. Final code candidate `8b6f25d4` passes 1,846 runtime tests, 1,036 mod tests, typechecks, generated Lua, full Docker build and nine payload checks; nine checked image files match the checkout. Native research/combat and final resilience passed, including planning lifecycle, blocked-plan restore/revision, death recovery, navigation, native crafting/cancellation and real process restarts. Independent test controllers now use isolated worlds; production replay guards remain intact. Zero live provider calls or production deployment; autonomous red-to-green remains unproved. Weekly usage rose four percentage points, within the owner's five-point budget. Ready for a separately authorized live trial after the deployment preflight. [Review, retained failures and gate evidence](validation/LUNA_AUDIT_REPAIRS_2026-10-06.md).

## October 6 executor research context repair: scripted gates green

Active research contracts now drive bounded authoritative research-path reads and relevant inventory refresh. C3 starts a fresh bounded executor observation decision without resetting the shared allowance; superseded handoffs and request cleanup cannot overwrite newer-lineage observation state. Missing/deferred facts remain explicit. Eleven regressions include the unchanged live blocker, corrected scripted admission, stale actors, restored state, in-flight refresh, scan limits and supersession. Unit `15d15b21`, merge `c0511b01`, repin `c66f3a16`. Final official Docker gates: 1,823 runtime and 1,036 mod tests, typechecks and generated Lua passed; full Docker build and nine payload checks passed. The upgraded checker now flags the retained live failure. No live run or deployment; autonomous gameplay remains unproved. [Repair contract, verification and remaining work](validation/LUNA_EXECUTOR_RESEARCH_CONTEXT_2026-10-06.md).

## October 6 planner-first live trial: handoff works, research facts lost

Owner-authorized fresh run at `6b268031`, with the old 60/120 trial call caps removed: Luna committed a declared plan without operations and C3 created a fresh executor. The executor paused before gameplay because its handoff omitted the exact research triggers already observed by the planner, while retaining `observation_budget_remaining=0`. Five Luna and five Jev calls, 60 seconds, zero gameplay batches/red packs/humans or operator corrective prompts. Canonical goal remained active; board paused truthfully. Server stopped; evidence retained. Next bounded repair: carry authoritative facts for the active research contract and provide bounded missing-fact observation at the executor decision boundary, preserving the shared allowance and identity fences. [Live evidence and attribution](validation/LUNA_PLANNER_FIRST_LIVE_2026-10-06.md).

## October 6 planner-first delegation: scripted gates green

The owner selected Luna planner → Luna executor for one NPC. A new validated protocol-v2 plan can now commit with no initial operations and hand first-action selection to a fresh executor context. Completion contracts freeze before handoff; actual executor actions still require the ordinary preflight and admission checks. Seven new regressions cover zero synthetic progress, preserved identities/contracts on restore, unchanged allowance, missing declarations, preflight refusal, disabled/failed handoff and stale actors. Unit `21e6b129`, merge `1306b003`, installer repin `bc7bcced`. Final integration Docker gate: 1,812 runtime tests, 1,036 mod tests, typechecks and generated-Lua checks passed; full Docker build and nine payload tests passed. The updated planning probe passes 4/4 scripted samples. No new live provider or gameplay run. [Contract and evidence](validation/LUNA_PLANNER_FIRST_DELEGATION_2026-10-06.md).

## October 6 fresh planning-test container: 3/4 passed

An owner-requested fresh disposable container reran the same four Luna scenarios at `d3988992`. Unmet research now proposed an action; continuation and semantic closure passed again. Initial deterministic planning still omitted operations. All responses returned normally, so the changed answer does not establish a container stall. No gameplay, Jev calls, corrective prompts or automatic retries. [Retry evidence and attribution](validation/LUNA_PLANNING_TRACKER_RESTART_2026-10-06.md).

## October 6 Luna planning/tracker probes: proxy healthy, 2/4 passed

After Tailscale startup, the owner's Docker VM proxy passed unauthenticated health and authenticated model-list checks from Docker. Four one-shot Luna decisions used a direct Tailscale endpoint override: satisfied-step continuation and grounded semantic closure passed; the initial deterministic plan and unmet-research reply omitted actions. Zero corrective prompts, retries, Jev calls or game connections. The initial planning probe's missing-admission diagnostic was clarified without changing saved replies or pass/fail criteria. [Planning-only evidence and fixture limitations](validation/LUNA_PLANNING_TRACKER_PROBES_2026-10-06.md). The earlier connectivity blocker below is superseded for this direct endpoint; `.env` still uses its existing Docker-host address.

## October 6 controller reconciliation: static gates green

Local Luna repairs preserved in `90fc419c` are reconciled with Claude's shared HEAD `48e2f1f7`. The official Docker gate passes 1,805 runtime tests and 1,036 mod tests, plus typechecks and generated-Lua checks. Shared checkpoint settlement retains pending-amendment and identity fences; canonical goal retirement and semantic admission regressions pass. The full Docker build, nine payload checks, and isolated native trigger-ladder lane also pass; installer repin is `fa0ce8bf`. The opt-in planning/tracker runner passes 4/4 scripted decisions. Live Luna probes received no HTTP/model response because the configured proxy refuses TCP connections; waiting for the owner to restore it. Evidence and open gates are tracked in the [new reconciliation checkpoint](validation/LUNA_CONTROLLER_RECONCILIATION_2026-10-06.md). Autonomous gameplay and multiplayer gates remain open.

## October 6 multiplayer join/desync: confirmed, cause unresolved

During the assisted finish, the owner joined at 05:10:21 Toronto; the server received `playerDesynced` about 71 seconds later. The client's first recorded CRC mismatch was tick 104177, one tick after native red-craft batch completion at 104176. The server continued to green research. This is distinct from the earlier observer selecting the human instead of NPC 25. Join timing and external RCON/polling interactions are recorded as unresolved hypotheses; no new Luna/Jev prompt occurred around the desync. Retained logs do not prove that every join fails. [Incident evidence and pending controlled tests](validation/MULTIPLAYER_JOIN_DESYNC_2026-10-06.md).

## October 6 assisted finish: native red science unlocks green science

After the owner requested help finishing the paused retry, the same actor/world reached green science at unchanged `1eb6172f`: **75 red packs genuinely crafted and 75 consumed**, with normal lab research completed (`by_script=false`) and the green recipe enabled. Native material receipts, six-furnace smelting and an actual steam-powered two-lab layout were verified. The task-board world check reads 1/1 met, while its status remains paused from the earlier continuation failure. [Assisted finish and exact attribution](validation/LUNA_GUIDED_RED_TO_GREEN_2026-10-06.md).

Luna chose and mined only the first ten copper ore. The operator drove the remainder through validated native operations: 65 completions, plus one interrupted admission before checkpoint recovery. Total main-provider and Jev calls remained seven each. This is assisted gameplay proof; autonomous planning remains unproven. All operation/recovery/final audit logs are retained. The one local server remains available on UDP 34201.

## October 6 resumed Luna + Jev test: mining succeeds, semantic completion omitted

Owner-requested fresh retry at unchanged `1eb6172f`: Luna mined ten copper ore, then twice returned no action or semantic step-completion confirmation. The bounded automatic repair failed and the runtime preserved the unfinished goal in a paused state. Seven Luna calls and seven Jev exchanges, no decision fallbacks; its autonomous portion did not reach red science or green research. The offline log checker reports `stale_step_tracker_behind_batch`. [Resumed trial evidence](validation/LUNA_JEV_RESUME_2026-10-06.md).

One new local Docker server is available for owner inspection on UDP 34201 (`127.0.0.1:34201`, or `100.98.209.103:34201` over Tailscale), Factorio 2.0.77. Its matching autorio mod was installed in the owner's requested client folder. A human connected during the trial. The initial observer mistakenly selected that player as the NPC; a corrected authoritative read confirmed standalone NPC actor 25 never changed. Original evidence and the correction are both retained.

## October 6 Luna with Jev: native mining, then unfinished goal cleared

Owner-requested retry at unchanged `1eb6172f`, with the dedicated `.env` Jev token enabled, a separate fresh world, zero humans and speed 1. Jev routed the unchanged goal as `new_goal` (reported confidence 0.98); Luna genuinely gathered ten copper ore. It then confused the completed gathering slice with the still-active green-research goal and returned no next work. The runtime's legacy-board completion boundary cleared the canonical goal although the game had reported 0/1 goal conditions met. Red science and green research remain unachieved.

Eight Luna calls, nine valid Jev exchanges, zero decision fallbacks; no corrective prompts or gameplay takeover after the declared kit. Captured logs are retained; this test world was discarded at the owner's request. All old Factorio test containers, including the temporary viewer, were removed before the later fresh retry above. [Retry evidence and completion-boundary diagnosis](validation/LUNA_JEV_AUTONOMY_2026-10-06.md). A linked electronics shelf node was also marked realized by ore collection alone; slice completion needs to remain separate from goal completion and broader shelf realization.

October 6 cleanup retained 29 captured evidence files at their original log paths and verified unchanged SHA256 hashes. Test-world saves and duplicate server logs were removed. Runtime configuration and the separate Claude worktree's data were left untouched. The ignored cleanup manifest is `test-results/docker-cleanup-2026-10-06/retention-cleanup.json`.

## October 6 Luna trial: task intake failed before gameplay

Fresh-world trial at `1eb6172f`, Factorio 2.0.77, Luna through the owner's CLI proxy, zero humans and speed 1: the router classified the explicit red-to-green task as `chat_only` with no current goal. It replied “I am here.” and admitted no plan. One provider call; no corrective prompts or operator gameplay after the declared starter kit. The isolated container is stopped.

The captured classifier payload also contains an inappropriate final user-role gameplay `[STEERING]` block; its effect on this particular answer is unproven. First-task intake and classifier packet isolation need coverage. See [the fresh trial checkpoint](validation/LUNA_AUTONOMY_INTAKE_2026-10-06.md). Execution repairs A–E remain live-unvalidated because this attempt never reached them.

## October 6 research-trigger ladder (scripted real-engine evidence, no model run)

New real-engine lane `trigger-ladder` (`tests/factorio/runner/trigger_ladder_cell.py`). It answers a gap the owner's "automate red science" run exposed: the `craft-trigger` lane seeds steam-power and electronics as researched, so nothing had shown the earlier triggers complete natively from a fresh world. This is scripted engine evidence, not a provider or planner run.

- Fresh world, zero connected players, nothing researched. The cell reads the prerequisite closure of `automation-science-pack` and `logistic-science-pack` from the engine (2.0.77, bundled mods) and dispatches on each technology's `research_trigger` type. Closure: `electronics` (craft-item copper-plate x10), `steam-power` (craft-item iron-plate x50), `automation-science-pack` (craft-item lab x1, prerequisites both), and `logistic-science-pack` (lab research, 75 red packs, listed as `lab_research_not_exercised`).
- The NPC performs exactly each trigger through its own operations. Plates come from a real stone furnace it crafted, placed, fuelled and supplied (`craft_item`, `place_entity`, `supply_entity`, `move_items_exact`, `wait`) and empties; the lab comes from the native hand-crafting queue, with gears, circuits, cable and belts crafted natively and the missing 5 copper plates smelted first. Only raw ore, coal and stone are seeded (each checked against the engine to be a resource product, and listed in the JSON as `seeded_raw_inputs`). No research state, plates or target items are written by the cell.
- Result: all three trigger technologies researched with their unlocked recipes enabled. Observed ticks (polled; game.speed 4): electronics 2952, steam-power 12759, automation-science-pack 15230. A per-poll trace shows each smelting trigger completing only after `products_finished` reached the trigger count. Smelted plates are credited by the engine's own production statistics; the lab is credited by the existing craft-trigger bridge (statistics 1, `hand_crafted` 1, `hand_crafted_in_statistics` 1, goal `current` 1, not double counted).
- No finding: every trigger completed after the NPC performed it exactly, so no mod change was needed. The cell fails with `FINDING trigger_not_credited ...`, `trigger_type_unsupported_by_cell`, `item_not_producible_by_npc`, `recipe_locked_for_trigger` or `prerequisite_unresearched` if that stops being true.
- Limits: only the `craft-item` trigger type is driven (no mine-entity, build-entity, craft-fluid or orbit trigger exists in this closure; any other type fails with a named finding rather than passing). `on_research_finished.by_script` cannot be captured from an RCON cell, so script-independence rests on the cell never writing research state. Lab research is not exercised.

## October 6 autonomy repair units A–E (unit and recorded-replay evidence only, no live run)

Repairs for the four failure shapes in [the October 5 autonomy failure analysis](validation/LUNA_AUTONOMY_FAILURE_ANALYSIS_2026-10-05.md); its closing checklist holds the commits.

- A: transfer preflight reports source/destination counts; a proved missing supply is recovered inside the committed step, bounded at 2 per step.
- B: a wait-only batch on a working checkpoint machine becomes the existing condition wait; blind waits carry a fresh machine read.
- C: a draft whose own operations empty its checkpoint stock is rejected; after commit, extracting unmet checkpoint stock is refused recoverably, bounded at 2.
- D1: `craft_item` on a machine-only recipe returns `requires_machine` live facts; bootstrap separates held, placed and running machines.
- D2: a fresh executor gets recipe facts, fresh or stale-labelled counts and residual needs; counts behind an in-flight batch are deferred and refreshed after its receipt.
- E: a recorded replay of the retained run drives the real loop through all four shapes. Gate: 1,749 runtime pass + 3 todo, 1,030 mod.

Known gaps (E todo tests, not fixed): an already-met committed checkpoint on an idle machine neither routes a wait nor closes the step before a later collection; the deferred executor refresh reads nothing for a prose-only step. None of this is live-validated; the live ladder is owner-run.

## October 5 CLI proxy red-to-green guided proof (Toronto)

The CLI proxy test world reached green science at candidate `d8fa2a1c` on
Factorio 2.0.77: **75 red packs genuinely hand-crafted and 75 consumed** by two
native steam-powered labs; green technology researched and its recipe enabled,
with `by_script=false`, actor 10, zero humans and game speed 1. The successful
save was discarded during the owner-requested October 6 cleanup; native proof
logs are retained and the isolated container was removed.

This is a guided finish. Luna completed early mining/smelting but its planning
and continuation pauses prevented autonomous completion. The operator finished
through existing bounded native operations under the owner's manual-allowed
objective. Full autonomy and automated science production remain unproven.

Two fixes arose from the trial: local GPT-6 closed rounds now retain the tool
schema with explicit `tool_choice: none` (`8a60ba43`), avoiding the unsolicited
image observed in a diagnostic replay; and confirmed standalone native crafts
now supply missing production-statistics flow for ready craft-item research
triggers, without goal double counting (`dd81485e`). A genuine second lab craft
unlocked red science in the same world. Gates: **1,629 runtime and 970 mod tests**,
typecheck/Lua/generated-Lua checks, 9 payload tests, plus a passing real-Factorio
`craft-trigger` lane. See the [guided checkpoint](validation/CLI_PROXY_LUNA_RED_TO_GREEN_2026-10-05.md)
for exact candidates, saved proof, model usage, diagnostics and remaining limits.
The [blocked first trial](validation/CLI_PROXY_LUNA_RED_SCIENCE_2026-10-06.md)
remains historical evidence (its date is UTC).
## October 5 goal requirements grounding (scripted engine proof, no new live-provider run)
## October 5 NPC live vision vehicle (unit and real-engine lane evidence; merged into `experiment/jev-agent-architecture`)

A hidden car prototype, `sgluna-npc-vision` (`chunk_exploration_radius = 2`), follows the
standalone NPC so its force charts and sees a 5×5 chunk window around it, like a
spidertron. The design is in `docs/NPC_CHARACTER_ARCHITECTURE.md`, "Map knowledge".
Real Factorio 2.0.77 evidence comes from the new `vision` lane
(`NPC_TEST_LANES=vision`, `tests/factorio/runner/npc_vision_cell.py`, opt-in like
`provenance`; it is not in the default lane list).

**What this does and does not prove.** Live charting and vision with a connected
player is **unproven**: the lane runs with zero players, and the engine charts nothing
for a force without a connected player (not for the vehicle, `LuaForce.chart` or a
powered radar). What the lane proves is lifecycle and non-interaction, listed below.
Whether the vehicle actually charts for an observer has to be checked with a real
connected client.

What the lane proved with zero connected players:

- **Lifecycle**: exactly one vehicle for the NPC, on the NPC, same single entity
  across a new chunk, a move inside one chunk (correction timer) and another new
  chunk. After the vehicle was removed it was rebuilt and an orphan was swept
  (`npc.vision.destroyed ... reason=entity_invalid`, `npc.vision.swept ...
  destroyed=1 reason=before_create:no_vehicle`). After the NPC died the old
  vehicle was destroyed (`reason=actor_replaced`) and one was built for the
  replacement actor. After a real stop/restart exactly one vehicle survived as the
  same entity, was not rebuilt, and still followed the NPC.
- **Non-interaction**: the engine reports a hidden car with no collision layers,
  not selectable, not a military target, no passengers, no emissions, no item,
  recipe, placing item or unlocking technology. The live entity is indestructible,
  unminable, inoperable, unrotatable, and `damage(1000)` deals 0. The NPC placed a
  wooden chest and a stone furnace on the exact tile an instance occupied; a burner
  inserter and a belt built on instance tiles moved coal past them to the belt end;
  area clearing removed a tree beside an instance and left the instance. A hunting
  biter and an armed enemy turret never harmed the live vehicle in 1,500 ticks,
  while the same biter destroyed a destructible instance and the same turret shot
  a real target. No pollution at the vehicle.
- **No entry**: `set_driver`, `set_passenger` and `set_driving` (also forced), with the
  NPC standing on it, never put anyone inside the live vehicle or a fresh instance
  (`get_driver` and `get_passenger` stay nil), so `allow_passengers = false` holds
  for the driver seat too.
- **Invisible**: `get_nearby_entities`, `get_entity_status`, `find_entities`,
  `query_area` and `inspect_entity` never returned it, with six instances inside
  the 20-tile radius in the engine.
- **Finding**: hunting enemies attack any destructible player-force entity, so the
  runtime `destructible = false` (set at creation) is what protects the vehicle,
  not the prototype flags.
- **Named limitation, `zero_connected_players_no_engine_chart`**: with zero
  connected players the engine charted nothing for the vehicle (active and
  inactive), for `LuaForce.chart` and for a powered, working radar (0 of 25, 16,
  16, 1 and 9 chunks). Vehicle exploration with a connected player is not proven
  here, and neither is whether `active = false` would suppress it. The vehicle
  stays active. The lane does not fake charting: if a future engine charts, the
  vehicle's whole window must be charted or the lane fails.

Gate: **1,637 runtime and 992 mod tests**, typecheck, Lua build and generated-Lua
check; the staging guard has one test per prototype property, and
`npc_vision.test.ts` covers lifecycle, sweep, trace lines and a source scan that
fails on any direct `find_entities_filtered`. Real engine: the `vision`, `core`
and `research-combat` lanes pass; `production` passes alone (one parallel run
failed the steam-power hand-mining sentinel under load); `resilience` fails
identically on the unchanged base `467dd799` at the planning-lifecycle step
(`providerCalls` 4, expected 3), so it is not caused by this work. Not exercised
in a real engine: a cross-surface teleport and `on_configuration_changed`
(both unit-tested).

## October 5 goal requirements grounding (unit evidence only, no live run yet)

Merged at `4f833278` after the live run `goal_052327n_1`, where the planner
hand-crafted automation science packs before the trigger technology that unlocks
the recipe. A focused Docker engine fixture now passes at `483e68c2` on Factorio
2.0.77 with zero connected humans and scripted replies. It verifies the real
requirements query, one grounding round before commit/admission, and terminal
locked-craft refusal with unlock evidence and unchanged sampled gameplay state.
It also exposed and fixed false asteroid-research requirements for mineable ores
(`a3385471`, payload repin `dfd019bd`). Gate: **1,624 runtime and 967 mod tests**,
typecheck, Lua build, generated-Lua check, and 9 installer tests. Evidence and
limits: [focused October 5 checkpoint](validation/GOAL_REQUIREMENTS_E2E_2026-10-05.md).
Ordinary unlock progression was unproven at that checkpoint; the guided proof
above now covers red-to-green progression. Automated red-science output remains
unproven.

- `autorio_planning.goal_requirements` reads the goal's `done_when` targets from
  the live game: locked recipes and ingredients, compatible machines, and the
  unlocking technology with its dependency-ordered pending research, each node
  marked lab science or trigger, with the exact trigger. Every list is bounded.
- The runtime shows this as a `[REQUIREMENTS]` block only while a plan is being
  authored or revised. The first plan of a goal gets one grounding round, before
  commit or admission, when anything is locked. That round shares the goal-reading
  challenge's round when both fire, and is skipped during provider-error recovery.
- `recipe_locked` is still a terminal blocker. It now carries unlock evidence,
  and the blocker reads `operation_preflight_failed:recipe_locked:<tech>`.
- The curated `automation-science-bootstrap` skill is retired. Skill cards flag
  an output recipe that is still locked and name the technology that unlocks it.
- Known follow-ups:
  - The skill cards and the requirements block pick the unlocking technology
    differently: fewest direct prerequisites versus fewest pending path nodes.
  - Resource-mined products are now treated as raw inputs even when an alternate
    crafting recipe is locked. This does not prove local deposit availability or
    extraction machinery; offshore-pumped fluids have not been checked here.
  - Optional higher-tier machine research can legitimately exceed the bounded
    path report. Red-science and assembler-1 paths are complete in this fixture;
    the assembler-3 alternative is explicitly truncated.
  - The `DURABLE_PLAN_PROMPT` paragraph and its ordering rule were approved
    by the owner on 2026-10-05.

## October 3 playable implementation candidates

The owner-approved red-science plan is being implemented in isolated local
branches. Native receipt fencing, physical corpse retrieval, planner stock
guidance and a conservative output candidate monitor have landed locally through
`38bd01c4`. Its combined gate passes **1,561 runtime and 920 mod tests**, typecheck,
Lua build and generated-Lua checks. Docker is available again.

The unmerged durable runtime ledger passes 1,570 tests and has passed semantic
review. Task retention passes 1,585 tests at `4ac4b8df`, but review found missing
clock/lineage fences on completion handoff and repair is still required. The circuit API
passes 920 mod tests in its own branch and still needs separate review. Campaign
transport/global persistence remains a work-in-progress candidate.

The output monitor deliberately reports `satisfied: false` and upstream automation
unverified until native conformance is established. Corpses can be tracked and
retrieved natively, but runtime kit selection, recovery priority, surplus returns
and repeated-death limits still need wiring. A native feature passing unit tests
does not establish a gameplay recovery or production pass.

The [implementation checklist](validation/PLAYABLE_BUILD_2026-10-03.md) records
candidate SHAs, evidence and remaining dependencies. Package promotion,
real-engine acceptance and the three-seed playable checkpoint have **not** passed.

## October 2 experimental playable-build checkpoint

The integration checkout is synchronized to remote checkpoint `c6f494aa` (MW1,
MW2 and U11 included). Local receipt hardening `e4e8238a`, integrated by `b3a7c701`,
keeps duplicate-effect guards for partially cancelled batches and uncertain idle
receipts after a reload or missing baseline. Three new scripted test groups cover
these paths and persistence; separate review found no blockers. This is runtime
evidence, not a new engine/provider pass or release promotion.

Final offline gate: 1,561 runtime tests, 895 mod tests, typecheck, Lua build,
generated-Lua check and all 9 installer tests passed; installer artifacts were
checked and repinned to `b3a7c701`.

The next build priorities are remaining MW2 correlation gaps, MW4 shared campaign
accounting, MW3 task-local questions/resume order, and MW5 planner recovery wiring.
The practical first gameplay target remains autonomous cold-start electricity;
powered assembler/inserter output is the next production gate. Details and resume
instructions: [October 2 checkpoint](validation/PLAYABLE_CHECKPOINT_2026-10-02.md).

The September 30 discussion below predates the October 1 implementation merges
and owner allowance decisions; the canonical macro design and this checkpoint
take precedence for current implementation status.

## September 30 macro design update — requirements, not verified capability

Owner decisions now define [Week 1 macro execution](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md):
ongoing Auto expansion, same-result recovery of player requests with explanations,
protection of player-built structures/reserved supplies, durable interrupted tasks,
task-local questions while independent work continues, and one persisted campaign
allowance across planner/executor/Jev. Week 1 is September 28–October 4; Week 2 is
October 5–11. No campaign amount or accounting unit has been selected.

The updated delegation document attributes Claude's newer partial build to its
integration checkpoint. This documentation update does not merge that runtime,
prove MW1–MW6, authorize live runs, or change any promotion result below. Record
implementing commits and integrated/engine evidence before claiming these behaviors.

## Promotion status

As of 2026-09-16, `feat/npc-transition-work` is the active promotion-candidate/integration branch. During the documentation cleanup the branch HEAD was `02167ac690c46b056ba2f0a62db056438c702419` (`fix(autorio): preserve skills close handler`) and ordinary repository CI was green.

That SHA is a status reference, not a permanent release pin. If the branch moves before promotion, freeze a new candidate SHA and rerun the promotion gates against that exact commit.

## Experimental Jev planning line — verified lifecycle checkpoint

The planning architecture described in `docs/NPC_PLANNING_ROADMAP.md` has a separate experimental implementation line on
`experiment/jev-agent-architecture`. This is not a promotion claim for `feat/npc-transition-work` or `main`.

As of 2026-09-20, code checkpoint
`8a64a2e6bc93e9b7dd8d23e3882d8ae6726dfa25` passed:

- GitHub Actions CI run `35544667059` — `pterodactyl-runtime`, `typescript-quality`, and `factorio-npc-deterministic` all successful;
- Pterodactyl release-gates run `35544667056` — successful.

That checkpoint verifies the redesigned planning acceptance path against real Factorio, including:

- reducer-owned Goal / Roadmap Shelf / Plan Tracker authority;
- player-facing Plan Tracker rendering from `planTrackerView()`, not stale legacy-board progress;
- bounded Jev pre-commit refinement with rejected drafts blocked from operation admission;
- durable plan-to-shelf lineage and verified-result feedback;
- boundary steering reaching the next Main-LLM draft;
- `VERTICAL -> HORIZONTAL -> VERTICAL` across bounded slices;
- real Factorio restart with active planning/shelf/steering lineage preserved;
- structural preflight blocker freezing without mutation;
- ordinary continuation remaining frozen while blocked;
- explicit user revision creating a versioned successor with `derived_from_plan_id`;
- committed completion semantics frozen against post-commit checkpoint rewriting;
- legacy Task Board and `[RUNTIME_COMPAT_STATE]` retained only as compatibility projections, with `[PLANNING_STATE]` the sole model-facing planning authority.

### 2026-09-24 hand trace of the rocket-goal tracks (unit/integration evidence only)

This round was traced and fixed without E2E. Each item has a deterministic regression test, but none of it has real-Factorio evidence yet.

- **Restart mid-slice:** the goal definition, Roadmap Shelf and committed step are restored, and there is no request to redefine the goal.
  - Fixed: a planner restating a *different* checkpoint for a committed step threw `committed_completion_contract_is_immutable` after the plan was already persisted as admitting. That killed the continuation, and after a restart it paused the plan as "could not safely recover".
  - The committed contract is now kept, the proposal is ignored and traced (`step.checkpoint_change_ignored`), and the planner is told why.
- **Between slices** (slice verified, goal still active): restart, a provider failure, and shutdown all silently stranded the goal. The legacy plan reads `completed` there, so neither restart recovery nor auto-resume picked it up.
  - `goalAwaitingNextSlice()` now makes the goal recoverable.
  - Recovery re-checks `doneWhen` in game (and completes the goal if it was met while down) before planning the next slice.
  - Transient failures there schedule auto-resume.
  - Shutdown no longer pauses the verified slice.
- **Space Age:** after a save load, the NPC body was searched only on `game.surfaces[1]`. A body on another planet or a space platform was treated as dead, and a second body spawned on Nauvis.
  - It is now found game-wide by unit number.
  - Known limits:
    - A body that really died respawns empty-handed at (0, 0) of the surface it was last alive on; the mod remembers that surface while the body lives.
    - Goal conditions are checked only at slice boundaries, not mid-slice.
    - An RCON failure during the goal check counts as "not yet met", so one extra slice may be planned.

### 2026-09-24 rocket-path edge cases and QoL (unit/integration evidence only)

A second offline round, again without E2E. Each item has a regression test.

- **Launch:** nothing could launch a built rocket.
  - `launch_rocket {unit_number}` now targets one exact, live-observed silo.
  - It never passes a character to `launch_rocket()`, because that would board the NPC.
  - It completes only when the force's `rockets_launched` rises.
  - `rocket_not_ready` reports the silo's `rocket_parts`, and `getEntityStatus` on a silo reports parts and readiness.
- **Counter goals:** `rockets_launched` and `items_produced` count from goal start, with a game-read baseline. A save that had already launched a rocket completed "launch a rocket" instantly.
- **Hand-crafted items in `items_produced`:** Factorio 2.0.77 does not record a player-less character's hand-crafted products in the force production statistics (ingredients only), and no craft event fires for it. The mod keeps a per-force counter (`storage.sgluna_crafted_items`), credited only when the native crafting queue finishes a craft, and `items_produced` adds it to the statistics (`production_statistics` + `hand_crafted` in the result). Engine proof: `tests/factorio/runner/hand_craft_statistics_cell.py` (production lane), whose first gate fails if the engine ever starts recording these products, because the two sources would then double count. Found live in `docs/validation/LIVE_DEEPSEEK_FLASH_2026-09-29.md` finding 8.
- **Dead body:** force-level goal checks now work with no body.
  - A body that died on a space platform respawns on Nauvis.
  - A failed respawn create falls back to Nauvis instead of retrying every tick.
- **Transfers:** NPC→entity and player transfers now move the whole held count, not just the first stack.
- **Player control:**
  - `status` (and `进度`, `状态`) answers without a model call.
  - `Stop!`, `pause`, `停止` and `暂停` now stop at once.
  - A progress line is printed after each verified slice.
- **CI and tracing:**
  - The runtime suite no longer uses `--test-force-exit`, which had silently dropped the last tests of `planning-state.test.mjs`.
  - Prompt tracing now recovers after a failed write.
- **Dry runs:** `rocket-goal-dry-run.test.mjs` runs a whole rocket goal through the real loop against the fake game. It covers a restart, a boundary provider failure, `status`, a death, `rocket_not_ready`, and the launch.

Still unverified in real Factorio:
- the launch confirmation bound (3600 ticks);
- base-game victory handling on a headless server after the first launch;
- whether transfers into a silo can spill into its non-input inventories;
- respawn on platforms.

### 2026-09-24 console redesign (unit evidence only, not yet seen in Factorio)

The left column of the NPC console was rebuilt from the approved "Chosen" mock-up. The right column (camera, inventory, wanted, equipped) is unchanged.

- **Title bar:** Learn, Old tasks and Debug are icon buttons before Close. A status sprite and label show the phase and its detail.
- **Tabs:**
  - NOW: the Goal card (the goal's game checks with progress), the Now card (current step, next steps, pause or block reasons, last result), the Latest card (the 3 newest feed rows plus an "All activity" button) and the conversation.
  - PLAN: the Goal card and the Roadmap Shelf / Active Plan tracker.
  - ACTIVITY: the execution feed with its filters and LIVE button. It was built but hidden before; Debug keeps its own copy.
- **Always visible:** a blocked plan is a banner above the tabs. The prompt and the PAUSE / FOLLOW / … row (NEW TASK and TERMINATE are in …) sit below the tabs.
- **Scroll positions:** pages are built once and a tab switch only flips visibility, so each scroll-pane keeps its position. The selected tab is stored per player, written only in the click handler.
- **Merged repeats:** consecutive identical feed lines show as one row with ×N, updated in place.
- **LuaJIT limit:** `new_combat_controller` was over LuaJIT's 60-upvalue limit. Its tuning constants are now one table.

The owner has since used this layout in the client (2026-09-25, see below) and considers the redesign finished.

2026-09-25 (morning): the owner tried the new console in the game and found many things wrong with it. Other agents' fixes (up to `e905cc4`, prompt focus and live conversation reading) did not fix it. The console UI is **P0** for the next work session, ahead of production-rate goals. Don't treat this layout as accepted.

Owner's P0 spec (2026-09-25):

- **Dragging feels laggy, and typing gets interrupted.** The console is refreshed
  continuously, even while the player drags it or types in it. A first look:
  `task_board_ui.ts` refreshes every open console every 60 ticks. Most of the left
  column only rebuilds when a signature changes, but the skills pop-out clears and
  rebuilds its whole body on every refresh, whether or not anything changed.
- **Fix:** split the console into sections that update independently. A section is
  rebuilt only when its own data changes, and an update must not touch the text
  input or the window being dragged.
- **Skills work like past plans:** a list of skills to select from, with a detail
  view for each. The player can also edit a skill.
- **Later, a bigger slice:** the player picks which skill the LLM must use. It is
  not part of P0.
- Buttons also felt laggy (owner): a rebuild between press and release destroys
  the button, so the click is lost.

Fix, `055538a` (unit evidence; not yet seen in the client). The root cause was a
lookup bug, not the refresh rate: since `af1adf3` the tracker refresh couldn't find
the plan list inside its new body flow, so it always failed. Every second and on
every snapshot, the whole console window was destroyed and rebuilt. Now each card
redraws only when its own content changes. Debug and Old tasks do the same, and the
skills pop-out is a skills window like Old tasks, with a list, a detail pane and
EDIT/EXPORT. A GUI stand-in test counts every add/clear/destroy: with all windows
open, a refresh or a repeated snapshot with nothing new changes nothing. Progress:
`docs/validation/CONSOLE_UI_P0_PLAN.md`.

Owner check in the client, 2026-09-25: the console feels a lot better, and the owner
considers the redesign finished. Follow-ups `5d2937b` (status light centred in the
title bar; the preview's clipped "X" coordinate button replaced by a map-pin locate
button) and `0fbd0d7` (the … menu crashed the server: `vertical_spacing` on a frame
is a non-recoverable mod error; the blocked banner had the same latent bug).

### 2026-09-25 log fixes, rate facts and think time (unit + engine-lane evidence)

Deployed locally at `6476fdc`. Plan and checklist:
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md`.

- **Provider HTTP 400 after an output-budget handoff** (`7acc1e3`): the skill
  context was inserted between an assistant `tool_calls` message and its replies. It
  now goes before the first model turn, and a split tool exchange fails locally
  instead of reaching the provider.
- **A refused semantic completion claim failed the request** (`aebbaf25`): claims
  are checked at parse time and go back to the planner as a correction. After a
  resume, a satisfied step closes on the next turn (owner's choice).
- **Router replies were all traced as invalid plans** (`109bc90`): trace-only fix.
- **DeepSeek chat narration** (unit evidence only): DeepSeek filled chatMessage
  with a status line on nearly every turn and narrated before tool calls. A
  provider style block (`PROVIDER_STYLE_PROMPTS` in `provider-base.mjs`) is now
  appended to the system message for the `deepseek` profile only: chatMessage
  stays empty while working and is used for replies, decisions, BLOCKED: reports
  and verified completion; content stays empty with tool calls. The interaction
  router keeps its own JSON-reply prompt. Not yet confirmed in a live run.
- **Recipe and mining rate facts** (W1, merge `96418eb`): `getRecipeDetails` machine
  rates and hand-craft time, new `getMiningDetails` and `estimateProductionTime`
  tools. The `production` engine lane checks the rates against prototypes and a
  measured 40 s window. The harness does the arithmetic; the model picks machine
  counts.
- **`crafting_speed` read on 2.0 prototypes raised** (`6476fdc`):
  `solveProduction` with a machine selection and prototype details now call
  `get_crafting_speed()`. Unit evidence only; no engine lane covers these paths yet.
- **Think time measured** (`a34b569`): plan authoring rounds take 99 s at the
  median (max, on every round of the request), ordinary planning 37 s. The Debug
  window shows the last request's think time. The per-round effort policy is next.

The compatibility projection should not be deleted merely for cosmetic cleanup while other runtime/UI
features still consume it. Future removal should be driven by eliminating those consumers, not by creating
another planning source of truth.

### 2026-09-30 context delegation build (unit/integration evidence only, no live run yet)

The design is in `docs/NPC_DELEGATION_DESIGN_2026-09-29.md`, and its §13 has the per-unit table. The goal is to keep the planning agent's context long-lived and uncluttered, and to give disposable execution work fresh contexts built from a harness handoff packet instead of the old transcript. The steam run's single request of about 904k input tokens is the case to beat.

Merged on `experiment/jev-agent-architecture` (head `aa4b30bd`; runtime 1292 tests, autorio 113 files / 892 tests, installer payload repinned):

- **Roles.** Planner on `OPENAI_MODEL[0]`, executor on `[1]`, falling back to `[0]`. The live config is DeepSeek flash for both.
- **Handoff packet.** The pure handoff packet has a byte-stable plan block for the provider cache, and restage limits are counted in provider tokens.
- **Restage seam.** Restage is sequential: it is refused while a round is in flight or a turn is open, unless that turn presents its own token. Late replies from a discarded context are dropped and the turn is re-driven at most twice, then it fails visibly. `CONTEXT_RESTAGED` is recorded with its `handoff_id`. A run that never restages is byte-identical to before (a golden replay test).
- **Output ceiling.** The request output ceiling is now per plan slice.
- **Recovery.** Budget handoff, Resume after a budget pause, restart and actor replacement rebuild the conversation from the packet. A blocked plan wakes no model.

Not done: the planner wiring (U7, built and reviewed, merge pending), the executor at plan commit (U6), Jev at the checkpoints (U11), and the flash-only live test, which is the first real evidence for any of this.

## Verified standalone-NPC foundation

User-reported real-Factorio acceptance work has covered the bounded single-NPC foundation at its stated scopes, including:

- zero connected players with a continuously advancing simulation;
- creation/reacquisition of a standalone `character` with stable actor identity;
- wait, movement, mining, native hand crafting, placement, and bidirectional inventory transfer;
- physical input cleanup after completion/cancellation;
- bounded research submission/follow-through;
- bounded combat, including no-target/no-ammo/cancellation behavior;
- save/process restart with actor reacquisition and fail-safe logical task reconciliation;
- NPC death/replacement with stale-work invalidation;
- bounded navigation around obstacles, moving-target repath, unreachable-target failure, and distinction between SGLuna-controlled walking and passive belt displacement.

See the archived harness records and `docs/NPC_RELIABILITY_WORK.md` for the detailed scenarios and limitations of those gates.

## Verified packaged Pterodactyl foundation

The historical v8 release-candidate checkpoint recorded passing package/deployment gates including:

- generated payload/egg integrity checks;
- production-runtime/staging tests;
- zero-player packaged Factorio boot;
- standalone actor readiness;
- graceful save/shutdown;
- existing-save upgrade and rollback without rewriting user saves/mods/config.

The exact historical candidate data is preserved at `docs/validation/PTERODACTYL_V8_RELEASE_CANDIDATE_2026-09-14.md`. It must not be mistaken for proof that every later integration-branch commit has run those same heavyweight gates.

## Current branch capabilities beyond the original baseline

The integration branch now contains substantially more than the original NPC transition. It includes work in areas such as:

- richer task/plan UI and console interaction;
- behavior tracing and provider recovery/steering;
- production-planning helpers and transport-capacity tooling;
- map construction/deconstruction/upgrade/orientation primitives;
- discovery/knowledge/learning/skill work;
- additional reliability and operation-receipt contracts;
- early swarm-facing identifiers/foundations.

These features do **not** all share the same level of real-engine/provider E2E evidence. Their presence on the branch should not be read as an assertion that they are all release-complete.

## Current promotion blockers

There is no longer a known architectural blocker that requires keeping the standalone-NPC baseline permanently off `main`.

Before promotion, however, the repository should still:

1. keep the frozen candidate's ordinary CI green;
2. reconcile the six main-only commits intentionally rather than overwriting them;
3. preserve main's Docker Compose WIP documentation and Python/CI decisions;
4. run the heavyweight Pterodactyl package smoke and real zero-player Factorio integration against the exact candidate SHA;
5. record the promotion SHA and gate results as a new validation checkpoint;
6. avoid pulling unrelated failing swarm work into the single-NPC promotion.

Target for `v0.1.0-pre.2` (owner, 2026-09-26): any model stronger than DeepSeek flash
takes a cold-start NPC to electricity (an electric mining drill working on steam power,
verified from world state); stretch goal automated red and green science. Not met yet:
the 2026-09-26 steam run (`docs/validation/E2E_STEAM_POWER_2026-09-26.md`) stopped at
step 2 of 6 on the per-request output cap. Plan: `docs/PARALLEL_PRODUCTION_WORK_PLAN.md`
"Next week".

## Known non-blocking limitations / future work

The next main promotion does not claim complete coverage of:

- autonomous end-to-end production-line design;
- validated inserter/belt-lane/stacking throughput reasoning across all relevant research states;
- map/remote operations: with zero connected players they now read the NPC's own 5x5 map knowledge (`docs/validation/NPC_MAP_KNOWLEDGE_LIVE_VALIDATION_2026-09-25.md`); the player-join map sync is unit-tested only, and neutral unit-numbered entities cannot be marked for deconstruction by the engine;
- vehicles, trains, or space platforms;
- swarm/multi-agent coordination;
- every provider/model-specific behavior in production conditions.

These remain roadmap work and should continue to be validated incrementally rather than hidden behind a larger prompt.

## Documentation authority

- Current roadmap: `docs/NPC_AGENT_HARNESS_PLAN.md`
- Planning architecture: `docs/NPC_PLANNING_ROADMAP.md` — canonical Goal / LOD Shelf / immutable Active Plan / Jev pre-commit review direction.
- Production validation: `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` — canonical production E2E ladder, historical canary, powered-assembler frontier, fluid known-red track, and promotion evidence.
- Stable actor architecture: `docs/NPC_CHARACTER_ARCHITECTURE.md`
- Current Pterodactyl operation/deployment: `deploy/pterodactyl/README.md`
- Detailed single-NPC reliability history: `docs/NPC_RELIABILITY_WORK.md`
- Historical checkpoints and superseded staging docs: `docs/validation/`
