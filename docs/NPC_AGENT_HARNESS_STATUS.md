# SGLuna Factorio — NPC Agent Harness Status

This file is the current status summary for the single-NPC integration line. Historical detailed checkpoints are retained under `docs/validation/`.

For the unfinished playable-checkpoint work, preserved candidate refs, review
blockers and settled owner decisions, read the
[October 5 handoff](validation/PLAYABLE_HANDOFF_2026-10-05.md). It accounts for later
ledger/refusal-clearance and goal-requirements changes; the earlier chat handoff
must not be used to reset current integration.

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
