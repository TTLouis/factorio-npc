# Delegation prerequisite audits (plan items 3.2 and 3.3)

Date: 2026-09-29. Base: `66ae86e7` (`experiment/jev-agent-architecture`). Read-only static audit: nothing was
run, nothing merged. Inputs: `docs/NPC_DELEGATION_DESIGN_2026-09-29.md` (sections 5, 9, 11),
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md` rows 3.2 and 3.3, `AGENTS.md`. Claims marked **(unsure)** were not
traced to the end. Paths below are under `deploy/pterodactyl/runtime-v8/` unless stated.

## Audit A: writers of plan and task state outside the reducer (3.3)

### A.0 Findings that shape the rest

1. **The agent loop never calls the reducer.** `npc-agent-loop.mjs` and `supervisor.mjs` contain no
   `PLANNING_EVENT`, `applyPlanningEvent` or `dispatchPlanningEvent`. Every write goes through the memory
   facade `CanonicalTaskBoardMemory` (`canonical-task-board-memory.mjs`), a subclass of the legacy
   `NpcDialogueMemory` (`npc-agent-loop.mjs:712`) whose own base lives in `staging/npc-agent-loop.mjs:158`.
2. **Order is legacy first, reducer second.** `applyOutcomeAuthority` (`canonical-task-board-memory.mjs:1203`)
   calls `super` (legacy decides status, blocker, step advance) and only then mirrors the result into reducer
   events. `syncPlanningState` (`:388`) then pushes reducer state back into the board. The comment at `:1330`
   admits the board can say "completed" before the reducer's last step lands. That is the 3.8 tracker lag.
3. **Drafts are built from the legacy board.** `ensurePlanningDraft` (`:599`) reads `state.task_board.steps`
   to mint `DRAFT_CREATED`, so the projection is an input to the reducer.
4. **Two stores, one snapshot file.** `snapshot()` (`:1346`) writes `plans` (legacy `planByNpc`) and
   `planning_states` (reducer). `restore()` (`:1357`) rebuilds the reducer from the legacy state when absent.
5. **The reducer has no pause.** `PLAN_STATUS` has no paused state (`planning-state.mjs:28`). Pause, resume,
   `pause_reason`, `condition_wait`, `persistent_runtime`, `provider_recovery`, admission state, locators and
   operation receipts have no reducer event. The reducer sees only step evidence refs (`STEP_EVIDENCE_ACCEPTED`),
   not receipt summaries.
6. `staging/` is not dead code: the installer copies it (`payload-src/installer.sh:162`), and runtime-v8 imports
   its base class. It has no plan writes beyond `terminatePlan`/`clearTaskContext` (`staging/npc-agent-loop.mjs:249-259`).

### A.1 Writers table

"Live" means reached from `NpcAgentLoop` or `supervisor.mjs` in normal runs. Class: **M** move to reducer,
**P** projection only, **L** leave.

| # | Writer (file:line) | Writes | Live callers | Reducer equivalent | Class |
|---|---|---|---|---|---|
| 1 | `NpcDialogueMemory.recordPlan` (`npc-agent-loop.mjs:991-1097`), wrapped at `canonical...:988-1100` | legacy `planByNpc` record: goal_id, objective, status, plan, `persistent_runtime`, `durable_last_operations`, `exact_target_audit`, history | `commitPlan` `:7792` | `GOAL_ACCEPTED`, `DRAFT_CREATED`, `USER_REVISION_APPROVED`, `PLAN_SUPERSEDED` (the wrapper already emits them) | **M**: parsed plan goes to `DRAFT_CREATED` first, board derived |
| 2 | `applyOutcomeAuthority` (`npc-agent-loop.mjs:855-957`, wrapper `canonical...:1203`) | status, blocker, pause_reason, `persistent_runtime`/`condition_wait` cleared, board step advance, evidence | step close `:3777`, `finishIfGoalMet` `:5180`, `pollConditionWait` `:3174`, `routeRecoveryDecision`/`recoverPlan` `:8479-8567`, `applySemanticCompletionClaim` `:7504`, `finishNoOperationBlock` `:7352-7368`, request start `:4557`, supervisor `:1780` | `STEP_EVIDENCE_ACCEPTED`, `STEP_COMPLETED`, `PLAN_COMPLETED`, `STRUCTURAL_BLOCKER_CONFIRMED`, `OPERATION_BATCH_ATTEMPTED`. **No event for "paused"** | **M**: decide in reducer, mirror legacy; add pause event |
| 3 | `pausePlan` (`:1224`) via `pausePersistentPlan` `:4907`, `pauseAfterProviderFailure` `:5505`, `pauseAtProviderBudgetCap` `:6154`, cancel `:4643`, supervisor `pausePlanIfPresent` `:1490` | legacy status `paused`, `pause_reason` | UI Pause, Follow, provider failure, budget cap, ceiling | none | **M** (needed by C5) |
| 4 | `blockRemainingPlan`, `setAdmissionState` (`:1207`, `:1139`) | blocker, `admission_status` | `markAdmissionFailure` `:7313`, preflight `:7129`, `commitPlan` `:8064` | blocker via `STRUCTURAL_BLOCKER_CONFIRMED` (already mirrored); `admission_status` none | blockers: covered by 2. `admission_status`: **L** |
| 5 | `reconcileTaskBoard` (`npc-agent-loop.mjs:1099`, `canonical...:1435`) and `common.mjs:603` | board steps, active index, `state.plan`, `current_step` | `commitPlan` `:7824` | reducer is authority for steps once committed | **P** after step-close flip |
| 6 | `recordBoardEvidence` (`:1128`, wrapper `canonical...:1530`) | `task_board.evidence` (receipts, `deterministic_verification`, recoverable failures, checkpoint validated) | `taskStatusReceipt` `:5559`, checkpoint `:3753`, preflight `:7219`, `:7934-7998` | only the accepted ref/kind at step close. **No receipt ledger** | **M** |
| 7 | `setStepCompletionContract` (`canonical...:755`) | board step contract, then `DRAFT_CREATED` refresh (`origin: checkpoint_contract_refresh`) | `persistPlannerCheckpoint` `:3746` | `DRAFT_CREATED` (pre-commit only) | **M**: contract set as a draft event; board mirrors |
| 8 | `registerConditionWait`, `updateConditionWait`, `clearConditionWait` (`:959-989`) | `condition_wait` | `commitPlan` `:7666`, `pollConditionWait` `:3138`, `:3197-3198` | none | **M** (packet "runtime state") |
| 9 | `setProviderRecovery` (`:834`) | `provider_recovery` (`budget_handoff`, `output_budget_exhaustion`) | `callProvider` `:6564`, `:6590`; `pauseAtProviderBudgetCap` `:6138`; `:4871`, `:8538-8719`; supervisor `:1787` | none | **M** (C5 packet replaces the capsule) |
| 10 | `persistent_runtime` (in #1, cleared in #2, restored `:1292`) | follow-controller status | source `persistentRuntimeStatus` `:5584` (RCON `getFollowStatus`) then `recordPlan` | none | **M** (S; it is a read of the mod) |
| 11 | Locators: `durable_last_operations`, `exact_target_audit` (in #1) | entity locators for recovery | `commitPlan` `:7774`; readers `:2270`, `:2316`, `:6731` | none | **M** |
| 12 | `beginActionOmissionRecovery` (`:1157`) | creates legacy state, mints a `goal_id`, sets board active | `beginActionOmissionRepair` `:7078`, `finishNoOperationBlock` `:7334` | none: bypasses the reducer entirely | **M** (also mint no goal here) |
| 13 | `recordStaleExactIdentity` (`canonical...:821`) | `staleExactIdentitiesByNpc` set (not persisted) | `recordBoardEvidence` `:1530` | `CONTRACT_PROVEN_UNSATISFIABLE` reads it; the set has no home | **M** (S; lost on restart today) |
| 14 | Goal minting: `admitPlanningGoal` (`:370`) only runs when a steering provider exists (`npc-agent-loop.mjs:4830`); otherwise `recordPlan` mints `goal_id` in legacy and `ensurePlanningDraft` follows | goal_id, owner, objective | request start | `GOAL_ACCEPTED` | **M** (S): always admit at `new_goal` |
| 15 | `clearTaskContext` (`canonical...:929`, base `staging:256`), `terminatePlan` (`:1621`), `retireCompletedPlan` (`:912`) | delete legacy and reducer state wholesale, no event | `finalizeCompletedTaskContext` `:4925`, `new_goal` `:4704`, supervisor `discardTaskContext` `:1516-1530`, `planContext` | `PLAN_CANCELLED` only in `terminatePlan` | **L** now; wrap in one function. Packet for C1 is built before the delete |
| 16 | Blocked choices (`recordBlockedChoice` `canonical...:744`, chat `:4679`, supervisor `:1580`), `recordGoalSatisfaction`, `defineGoal`, `recordGoalBaselines`, `reviseRoadmap`, `recordPlannerFocus`, steering | reducer only | `:5157`, `:5723`, `:7803-7811`, `:5135`, `:4832-4854` | `BLOCKED_CHOICE_RECORDED`, `GOAL_*`, `ROADMAP_REVISED`, steering events | already reducer (`recordSteeringAdvice` `:524` is transient advice, **L**) |
| 17 | `snapshot`/`restore` (`npc-agent-loop.mjs:1245-1340`, `canonical...:1346-1433`) | persistence and migration (`replayLegacyVerifiedPrefix` `:708`) | `persistState` `:2459`, `loadPersistentState` `:2443` | replay uses reducer events | **L**; the migration path retires with Phase 8 |
| 18 | Supervisor recovery: `recoverInterruptedAgentPlan` (`supervisor.mjs:1770`), `pauseStrandedPlanAfterRequestError` `:1730`, `executeUiControl` `:1574`, `finalizeCompletedTaskBoundary` `:1544` | only via rows 2, 3, 9, 15, 16 | restart `:2348`, request error `:2653`, UI input `:2696` | see rows | no direct writes: **L** (fix via rows 2, 3, 9, 15) |
| 19 | Mod side, `packages/autorio/src/task_board_ui.ts:1395-1425` (`autorio_task_board`: `set_snapshot`, `clear`, `ack_lifecycle`, `drain_inputs`, `status`) | `storage.airi_task_board_ui` snapshot, UI input queue, lifecycle pending | supervisor `:2434`, `:2407`, `:2413`, `:2443`, `:1949` | none needed | **P** (harness to mod snapshot) and an **input queue** (mod to harness user intents); neither mutates plan state. **L**. Snapshot is built by `taskBoardUiSnapshot` (`supervisor.mjs:1363`) from the legacy board plus tracker; switch to tracker only later (S) |
| 20 | Mod `task_manager.ts`, `task_state_runtime.ts`, `airi_validated_construction_plan` | Autorio operation queue and construction validation | operations | not plan state | **L** |

Pure helpers `createTaskBoard`, `reconcileTaskBoard`, `setTaskBoardStatus`, `addTaskBoardEvidence`,
`sanitizeTaskBoard` (`common.mjs:511-734`) only build board objects; they are write tools of rows 1, 2, 5, 6, not
separate writers. `NpcDialogueMemory.remember` and `setNextContextOverride` hold dialogue, not plan state.
Runtime-only agent fields the packet also needs (`providerBudgetGeneration`, `providerBudgetHandoffCount`,
loaded skill context, `usageLedger`) each already have one writer in the agent, so they enter the builder as
explicit runtime inputs, as design section 5 allows.

### A.2 What the packet builder needs, and where it lives today

| Packet field (design section 5) | Source today | Reducer-only? |
|---|---|---|
| goal, scope, `doneWhen`, progress | reducer `goal`, `GOAL_DEFINED`, baselines | yes |
| plan id/version, steps, active step, contract | reducer plan | yes (active step lags, see 3.8) |
| blockers and failure codes | reducer `blocker`, `OPERATION_BATCH_ATTEMPTED` | mostly (recoverable-failure evidence is board-only) |
| last N verified evidence refs and receipts | refs in reducer, receipts and summaries in `task_board.evidence` | **no** |
| runtime/task state (follow, condition wait, pause, provider recovery, admission) | legacy fields (rows 3, 8, 9, 10) | **no** |
| durable locators | legacy (row 11) | **no** |
| budget line | agent fields plus `UsageLedger` | runtime input, not state |
| `CONTEXT_RESTAGED` | absent | **no** |

### A.3 Minimum 3.3 move list before the packet builder reads only reducer state

| Order | Move | Rows | Size |
|---|---|---|---|
| 1 | Always admit the goal through the reducer at `new_goal`; stop minting `goal_id` in legacy | 14, 12 | S |
| 2 | Receipt ledger event (`OPERATION_RECEIPT_RECORDED`, bounded, per plan and step: batch id, kind, ref, summary) fed from `recordBoardEvidence` and the evidence items in `applyOutcomeAuthority`; board evidence becomes a mirror | 6 | M |
| 3 | Run-state events: `RUN_PAUSED`/`RUN_RESUMED` with reason code, and single-writer `condition_wait`, `provider_recovery`, `persistent_runtime` fields on the reducer plan | 3, 8, 9, 10 | M (three S pieces) |
| 4 | Locators event (`LOCATORS_RECORDED`) plus stale-identity set in reducer state | 11, 13 | S |
| 5 | Step close decided in the reducer first (reducer `STEP_COMPLETED`, then board mirrored). Same change as 3.8 | 2, 5 | M |
| 6 | `CONTEXT_RESTAGED` ledger event, no plan effect | none | S |

Not required for the first packet builder: `admission_status` (row 4), wholesale deletes (row 15, provided the
packet is built before the delete), the migration path (row 17), the mod snapshot switch (row 19), and full
board removal (Phase 8). Items 2 and 5 are the risky ones: they change which side wins when the two disagree.
Total: about one M+ (items 2, 3, 5) plus three S. Each can merge alone if the legacy write stays in place as a
mirror until Phase 8. Not verified: whether any consumer reads `task_board.evidence` in a way a mirror would
break **(unsure)**; there are about 120 `task_board` references in `npc-agent-loop.mjs`, mostly reads.

## Audit B: `origin/experiment/swarm-jev-integration` (3.2)

Merge base `5b023f8d` (2026-09-15). The fusion side is 1,593 commits ahead; the swarm branch is 282 commits ahead
(non-merge, 2026-09-15 to 2026-09-19, tip `8ee34857`), 177 files, +25,061 / -680. Docs are identical to the base.
Almost every swarm commit is a one-file feature or test. Line counts below are from the branch tip.

### B.1 Piece by piece

| Piece | Files (commits) | Verdict | Why |
|---|---|---|---|
| Record shapes: `WorkItem`, `WorkResult`, `EvidenceRef`, `Mission`/`Objective`/`Project`, `WorkClaim`, `BlackboardEvent` | `packages/autorio/src/swarm/types.ts` (404 lines; `e8c1b4a0`, `00e9b89d`) | **Port with changes** | Field set matches design section 3 (work item = committed plan, result with evidence refs). It is TypeScript compiled to Lua in the mod. 3.3-3.5 need a Node-side copy in the reducer, not mod storage |
| Revision protection and claim protocol: `expectedRevision`, `actorBodyRevision` on claims, leases, release reasons (`actor_death`, `actor_recovery`) | `swarm/claims.ts` (239), `blackboard.ts` (279) (`476b2506`, `b8b3c455`) | **Port the pattern** | Matches AGENTS.md "stale work after actor replacement must fail safely" and design gate (2). Single-body now, so claims are optional until a second body |
| Blackboard events with cursor, bounded snapshot | `swarm/queries.ts` (488), `blackboard.ts`; Node reader `swarm-coordination-snapshot.mjs` (124) (`8d76a989`, `0c352a06`) | **Ignore for now** | Useful only with several bodies; the reducer `log` already covers the single-body case |
| Reservations | `ReservationRecord` in `types.ts:245` (`items`, `area`, `entity`); `docs/SWARM_COORDINATION_ARCHITECTURE.md:671-677` | **Ignore** | Not lane reservations: no walk/mine/hand-craft lanes, and no admission enforcement anywhere (only created empty in `missions.ts:185`). Design gate (3) needs new code in admission. The architecture doc itself defers lane and belt reservations |
| Dependency graph and invariant audit: `validate_work_dependency_graph`, `audit_swarm_invariants` | `swarm/graphs.ts` (114), `diagnostics.ts` (161) | **Reuse the algorithms** | Small pure logic (cycles, orphans); fits a reducer self-check test |
| Outcome verdicts: `verdict_only`, `effects: []`, receipt-only vs semantic evidence | `swarm-outcome-verdict.mjs` (252, no imports), gate `swarm-strategic-transition-gate.mjs` (`7e53b35c`, `21278e0b`) | **Port with changes** | Same intent as AGENTS.md "verify world state, not admission". Overlaps `outcome-authority.mjs` and `step-completion.mjs` on fusion; take only the receipt-vs-semantic classification |
| Strategic project board: current/next milestones, `development_direction`, transition states, persisted store | `strategic-project-board.mjs` (179), `swarm-strategic-project-store.mjs` (240), `swarm-strategic-planner-contract.mjs` (102) (`8e9ae3a8`, `99aa8966`, `660ad2c1`, `dd0d930a`) | **Ignore** | A second plan hierarchy with its own writer. Conflicts with Goal / non-executable Shelf / immutable Plan and with 3.3 (one writer). The prompt change (`project` field, `[PROJECT_STATE]`) is a competing planner surface |
| Project Jev split gate before the first planner decision | `ae788666` (supervisor), `b88e8d22` (throws unless `project.currentMilestone` is split) | **Ignore** | Fusion deliberately deleted the `granularity` vote and hierarchy shim (`8c7c8f1f`, `b72c2f72`, `04c6ef37`; comment at `jev-decision-taxonomy.mjs:772`). A hard gate also contradicts "Jev critiques scope before commit, never mutates or blocks semantics" |
| Jev milestone transition decision | `f2de0646`, `2b22513a`, `swarm-project-jev-runtime.mjs` (280) | **Ignore; idea only** | Could inform 3.6(a/b) as a shadow probe later, but it drives milestone states that fusion does not have |
| Jev shadow controller, trigger policy, snapshot dedupe | `swarm-jev-shadow*.mjs`, `swarm-project-jev-trigger-policy.mjs` (86), `swarm-project-jev-service.mjs` | **Port the idea to 3.6** | Shadow-only invocation, dedupe by event cursor, retain latest queued trigger: matches shadow to advisory to gating. Rebase on fusion's `jev-decision-taxonomy.mjs`, do not copy |
| Recovery capsule/route, sidecar process, provider bootstrap, egg variables | `swarm-project-jev-process.mjs`, `-bootstrap.mjs`, `swarm-jev-provider.mjs`, `egg-airi-factorio-server.json` (`c53d2e93`, `06e47eb4`) | **Ignore** | Fusion has its own `recovery-route.mjs`; the sidecar adds env settings, and design section 6 says none |
| Mod work coordinator, item work executor, actor registry, actor pool, router | `swarm/work_coordinator.ts`, `item_work_executor.ts` (606), `runtime_service.ts` (528), `standalone_actor_pool.ts`, `actor_registry.ts` | **Ignore** | Mod executes work on ticks with its own admission and state. Conflicts with "harness owns authority, validation, admission, receipts" and with "do not mix swarm into a single-NPC promotion" |
| Actor-scoped rewrites of core ops, multi-actor E2E | `basic_operations.ts` (-184), `crafting.ts`, `control.ts`, `standalone_character_actor.ts`, `skills.ts` (+887), `map_remote.ts`, `factory_area_learning.ts`, `tests/factorio/runner/swarm_*.py` | **Ignore** | Diverged copies of code fusion has since rewritten; would conflict heavily |

### B.2 Conflicts with fusion invariants (AGENTS.md)

- One writer: a second persisted state (`SwarmStrategicProjectStore`) plus mod-side authoritative work records.
- Planning boundaries: milestone board and the Project Jev split gate replace, not extend, the Goal / Shelf / Plan model.
- Jev authority: gating a planner submission is a step past "select, rank, classify, route, critique scope".
- Runtime authority: the mod-side coordinator executes and completes work; admission and receipts must stay in the harness.
- Scope: the swarm/message-board layer is "later coordination"; it must not ride along with a single-NPC promotion.
- Zero connected humans remains valid on both branches; not re-verified for the swarm pool **(unsure)**.

### B.3 Top reusable pieces

1. Record shapes and revision-protection pattern (`types.ts`, `claims.ts`): port as Node-side reducer records, not the Lua module.
2. Receipt-versus-semantic evidence classification (`swarm-outcome-verdict.mjs`), with its `verdict_only, effects: []` shape.
3. Jev shadow trigger discipline (`swarm-project-jev-trigger-policy.mjs`, shadow controller): rebase for 3.6.
4. Pure graph and invariant checks (`graphs.ts`, `diagnostics.ts`).

Nothing here gives lane reservations; that gate (design section 8, item 3) is new work.
