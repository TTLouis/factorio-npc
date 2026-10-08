# NPC macro execution: Week 1 design

Status: **owner-approved behavior; implementation and integrated proof pending**.
Owner Q&A: 2026-09-30. Week 1 is September 28–October 4; Week 2 is October 5–11.

This is the authority for the September 30 macro decisions. It refines the lifecycle
in [NPC_PLANNING_ROADMAP.md](NPC_PLANNING_ROADMAP.md) and the sequential context split
in [NPC_DELEGATION_DESIGN_2026-09-29.md](NPC_DELEGATION_DESIGN_2026-09-29.md).
The [weekly plan](NPC_USER_EXPERIENCE_WEEKLY_PLAN_2026-09-28.md) preserves the Q&A and
Week 2 UX follow-up. These requirements are not evidence that the runtime implements
them, and do not authorize a provider run or deployment.

**Current build update, October 3, 2026:** the latest owner-approved playable plan
supersedes older implementation notes on eight-task eviction, wall-clock aging,
single pending-operation state and changed-batch replay. The target is 32 accepted
open tasks without eviction, game-tick aging excluding downtime, durable exact
operation correlation and task-local uncertainty holds. Legacy chest reservations
are retired in the task candidate; explicit task constraints and human inventory
exclusion remain. Shared campaign metering must cover planner, executor, interaction
and Jev calls; paid transport is disabled for this checkpoint.

Local integration `38bd01c4` contains native admission/prefix receipts with a durable
ordinal fence, physical own-corpse tracking/retrieval, compatible equipped-ammo
readiness, stock planner guidance and an unverified output candidate monitor. Its
combined Docker gate passed 1,561 runtime and 920 mod tests plus typecheck/Lua
checks. Runtime operation ledger, task scheduler/clock repairs, circuit contracts,
campaign transport, surplus returns and recovery orchestration still have pending
integration or implementation work. No three-seed gameplay or package promotion
pass is established. The
[current implementation checklist](validation/PLAYABLE_BUILD_2026-10-03.md) is the
authority for build evidence; dated MW1/MW2 sections below remain historical.

## 1. A continuing campaign, bounded executable slices

Auto pursues the active save's harness-supplied victory predicate. Resource discovery
and expansion continue throughout the campaign: develop deposits, connect transport,
extend power and processing, replace depleted sources, and prepare defenses. The
mandate is not limited to an initial resource area. Player constraints and validated
action capabilities still bound concrete operations; unknown capability is not permission.

The Main LLM authors the roadmap and plan drafts. The harness owns authorization,
state transitions, admission and evidence. Jev selects or ranks bounded candidates;
it cannot grant permission, write plans, advance progress or declare completion.
No-Jev operation retains the same authority and completion contracts.

The Roadmap Shelf holds non-executable future intent. Each committed slice remains
immutable. Replanning creates a new version, preserving the old plan, its reason,
lineage and still-valid verified evidence. A context restage changes neither plan
semantics nor permission. An executor proposes a recovery need; the planner authors
a semantic replacement through the normal draft/validate/commit path.

## 2. Authorization and explanations

Auto's standing mandate can authorize new infrastructure and semantic route changes
toward the same victory condition. A temporary player request likewise authorizes
necessary supporting work and recovery toward the same requested result. For example,
a destroyed NPC furnace or depleted deposit need not require approval before finding
another source or building replacement infrastructure to deliver 100 plates.

Ask before changing the requested outcome or destination, removing or substantially
redesigning player-built structures, consuming explicitly reserved supplies, or crossing
another player constraint. Do not change the old committed plan while awaiting an answer.
New infrastructure must still be admitted without unapproved changes to protected assets.

Shared factory storage is available by default; player inventories and explicitly
reserved supplies are excluded. Re-observe before spending. A withdrawal invalidates
old availability assumptions. How players mark protected assets and reserved supplies
is still an implementation-design question, not a reason to invent permissions.

Tell the player what happened, what approach changed, and why. Base explanations on
observed failures, shortages or capacity needs; report material disruption and revise
an estimate only when grounded. Ordinary expansion and in-scope recovery notifications
do not create approval gates. Avoid a notification for every low-level retry.

Proposed authorization records identify the mandate and its revision, task/goal,
permitted action scope, constraints, protected assets/materials, and the reason for
each replacement plan. The harness checks the current grant before committing and
again at admission. Exact schema/event names remain to be implemented.

## 3. Durable tasks, interruption and questions

The future Roadmap Shelf is separate from the durable ledger of accepted tasks.
Interruption preserves a task; explicit cancellation ends the selected task. After
the interrupting temporary task verifies complete, automatically resume the most
recent interrupted runnable temporary task after world and operation reconciliation.
Example: deliver coal, then resume the 100-plate request. No blind replay of a command
whose acknowledgement was lost, and no uncertain operation counted as successful.

Proposed task records include task/campaign/goal identity, original completion predicate
and destination, authorization revision, plan version and active step, verified evidence,
material claims, pending operation/receipt identities, question revision, suspension
reason and resume order. Preserve these across restage, save/restart and actor replacement.
Only one execution context may act on the body at a time. Stop or settle conflicting
physical work before changing tasks; reject stale responses and receipts by lineage.

A pending question blocks the affected work, not the whole NPC. Other runnable work
must be independently authorized and unable to interfere with that question or its
protected targets/materials. Apply deterministic priority and emergency rules; Jev
may rank eligible candidates but cannot make a blocked task eligible. Questions and
answers remain attached to the affected task and revision while another task runs.
Use bounded checkpoints/aging so suspended and blocked tasks are not forgotten.

After all temporary tasks finish, retain the established mode rule: Maintain, with
an offer to resume Auto if Auto was suspended. Failure, exhausted recovery and pending
approval are not completion and do not trigger that return rule. Background upkeep
does not silently authorize restarting a suspended victory campaign.

## 4. Campaign allowance and recovery accounting

Owner selected a shared campaign provider-usage allowance across planner, executor
and Jev. Attribute supporting work, recovery and interrupting tasks to the campaign
that pays for them; switching task, role, goal, plan version, context, actor or budget
generation must not mint a new allowance. Preserve the ledger through restart.
Per-turn, per-slice and hourly limits remain additional constraints.

Proposed allowance records include campaign/allowance identity and revision, accounting
unit, limit, consumed usage, pending reservations, and per-provider request attribution.
Account for input, cached input, output, failed/late requests and Jev usage as reported;
settle each call once. Preserve separate provider meters rather than pretending unlike
usage units are interchangeable. A cost allowance needs known billing data; do not
invent prices or treat missing usage as zero. The amount, accounting unit and warning
threshold have not been selected by the owner.

Before a call, reserve a conservative upper bound in the chosen unit. Unknown or
unreconciled usage must not create available allowance. If a call cannot fit safely,
pause provider-dependent work visibly and notify the player. No planner or Jev retry
may bypass that pause. Already-admitted physical work and authorized deterministic
defense/upkeep may continue where safe, with receipts reconciled. Resume requires an
explicit allowance extension or renewal; lifetime accounting remains intact.

Keep a separate per-task recovery history: cause, attempts, elapsed time and verified
progress. A fresh context, replacement plan or new slice must not erase stagnation.
When bounded recovery cannot progress, preserve the task and ask or pause visibly;
independent work remains subject to its own authorization and the shared allowance.
Exact recovery thresholds remain an implementation-design question.

## 5. Week 1 build sequence and acceptance

These are proposed implementation units, not completion claims. The integrator owns
sequencing and verification; no additional worker or background run is created here.

| Unit | Responsible area | Dependency | Completion evidence |
| --- | --- | --- | --- |
| MW1 | Runtime/reducer: authorization records and replacement-plan lineage | Existing immutable-plan commit/admission checks | Expansion and player-task recovery preserve the goal; protected redesign and changed outcomes ask; stale grants are refused. |
| MW2 | Runtime/supervisor: durable task ledger and operation reconciliation | MW1; receipt correlation | Interrupt/resume and restart preserve progress and destinations; lost acknowledgements cannot duplicate delivery. |
| MW3 | Scheduler/question handling: task-local blocking and resume order | MW2; current priority rules | Pending approval permits only independent authorized work; stale answers do nothing; older temporary tasks resume and do not starve. |
| MW4 | Provider accounting: shared campaign allowance | Durable campaign identity and provider usage | Planner/executor/Jev share one ledger; restages/restarts do not replenish it; exhaustion visibly prevents further provider calls. |
| MW5 | Planner/executor integration and notifications | MW1–MW4; delegation C3/C4/C7 wiring | Reasoned recovery runs through planner and executor roles; harness events explain meaningful changes; Jev absent/failing preserves the same result. |
| MW6 | Integration/validation | MW5 | One correlated trace demonstrates the integrated scenario below; relevant engine assertions prove actual output. |

Use a bounded multi-slice production request with a named delivery or output boundary.
Introduce source depletion or loss of an NPC-owned machine; recover with an explained,
authorized replacement plan. Interrupt with another player task, verify it, then resume
the earlier task. Introduce a separate protected redesign question and show independent
authorized work continuing. Restart with an outstanding operation; reconcile before
resuming and reject old-context results. Verify the original output predicate.

Run scripted variants for no Jev, Jev failure, stale answers, reserved-material changes,
and campaign exhaustion across a handoff and restart. Use Docker regression gates and
the relevant real-Factorio lane under repository rules. Record exact SHA, commands,
trace, usage and unresolved limits. Component tests are not integrated proof; scripted
models do not prove live autonomous gameplay. Any unfinished requirement is explicit
carryover, not silently relabeled future work.

A complete victory playthrough is not Week 1's acceptance test. Existing production
and release gates, including autonomous electricity evidence, remain in their own
roadmaps. The UI feedback request is saved for follow-up; layout discussion is deferred.

## 6. Remaining design choices

### Owner answers, 2026-09-30 evening Q&A

- **Build order.** Finish U11 (review fixes), then MW1 -> MW2 -> MW4 -> MW3 -> MW5,
  then the flash-only live test (owner still sets its spend cap before it runs), then
  MW6 with the delegation U10 docs pass folded in.
- **Allowance unit.** Reported provider tokens, one meter per provider and kind
  (DeepSeek input, cached input and output; Jev input). No price guessing: a CAD
  figure is reported beside the meters only when a price table is supplied.
- **First allowance size.** About 2 CAD equivalent at the 2026-09-29 Flash token mix,
  converted once into per-meter token limits and recorded with the conversion; a
  warning chat line at 75%, a visible pause at 100% until explicitly extended.
- **Player-built structures (MW1).** Use Factorio's per-entity last-user record
  (`LuaEntity.last_user`, the last player who built or changed the entity): a human
  `last_user` marks the entity player-built and protected. The NPC is not a `LuaPlayer`,
  so its own placements are identified by its placement receipts. The engine lane
  must confirm how `last_user` behaves for script/character placement and for
  pre-existing map entities before the rule is relied on.
- **Reserved supplies (MW1).** A chat command (and map tag) marks a container as
  reserved; its contents are never spent. Player inventories are always excluded;
  other shared storage stays available by default.
- **Stagnation (MW2/MW3).** Per task: 3 recovery attempts or 15 game-minutes with no
  newly verified progress, then preserve the task and ask or pause visibly. The
  count survives restages, new plan versions and restarts.
- **Task aging (MW3).** A suspended or blocked task that has waited 15 game-minutes
  is resurfaced: reconsidered for resume, or its pending question is repeated to the
  player, so background work cannot starve it.
- **C4 route (U11).** Keep the narrow "next step is clear" rule; measure where the
  observation wakes happen in the first live run before widening it.

### Still open

- The exact reserve chat-command syntax, and how a reservation is released.
- Concrete reducer event/schema names and integration with the existing task-board mirror.

Resolve these before the relevant build unit is declared complete. None of them reopens
the accepted authority, interruption, explanation or shared-allowance decisions.

## 7. MW1 build status

Status as of 2026-10-01: **MW1 reducer, harness checks and unit coverage are built on branch
`mw1-authorization`; the real-engine `last_user` lane is written but its run is recorded
separately (Docker engine permitting); planner/executor recovery wiring is MW5.** This section
records what exists; the owner text above is unchanged.

What is built:

- **Authorization record** (`runtime-v8/authorization.mjs`, pure; persisted in the planning
  state as `authorization`, versioned). A *grant* names the mandate kind (`standing_auto` |
  `player_task`), mandate/goal/task id, a revision, the requested result and destination, the
  permitted action scopes, constraints, protected materials/assets and the actor it is bound to.
  Revising or revoking bumps the revision; a revoked grant returns only at a newer revision.
  Only runtime or user authority can grant, revise, revoke or approve; the planner and Jev
  have no path (reducer source allowlist).
- **Replacement lineage.** `REPLACEMENT_PLAN_REQUESTED` (runtime authority only) classifies a
  request for a BLOCKED plan: *accept* creates a DRAFT successor (`plan_version + 1`,
  `derived_from_plan_id`, `replacement` = predecessor, grant id + revision, scope, grounded
  reason code + evidence refs, steps fingerprint) and keeps verified history in
  `carried_forward_evidence`; *ask* records a pending approval question and leaves the old plan
  frozen and untouched; *refuse* records a bounded refusal. A changed requested result or
  destination, a player-built structure to be removed/redesigned, a reserved container or
  protected material to be consumed, a crossed constraint, or a scope outside the grant all ask.
  A changed result/destination is not approvable through a grant approval (that is the user's own
  revision, `USER_REVISION_APPROVED`, unchanged). Every existing guard (`plan_blocked`,
  `goal_not_active` restage refusals, board/plan disagreement) is untouched.
- **Grant check twice.** At commit (`PLAN_COMMITTED` for a plan carrying `replacement`) and at
  operation admission (`evaluateOperationAdmission`, called from the agent loop right after
  preflight): a revoked grant, a stale revision, an inactive or different goal, a replaced actor,
  a changed actor epoch or an unverifiable actor is refused with a named reason. A replacement
  draft whose steps drifted from the classified ones is refused at commit.
- **Protected assets.** Engine fact (see the lane below): the standalone NPC leaves
  `LuaEntity.last_user` empty, so a human `last_user` means player-built. Exact-target preflight
  now reports `target.last_user`; `entityProtection` combines it with NPC placement receipts
  (`placed_last_user` is recorded at placement) and explicit grant-protected units. Admission
  refuses `mine_entity_exact`, `rotate_entity` and `set_machine_recipe` on a protected entity
  without a user approval record for that entity.
- **Reserved supplies.** A reservation record (world fact: survives goals and restarts, kept
  even with no goal) and the exclusion check: reserved containers are never withdrawn from
  (`move_items_exact` taking items) or mined; a name-based withdrawal is refused while a
  container of that name is reserved; a player's inventory is never a source
  (`move_items_with_player` with `to_player=false`); other shared storage stays available.
- **Trace events** (all carry `request_id` and a `reason`; each asserted in
  `authorization.test.mjs` / `authorization-wiring.test.mjs` / `reserve-command.test.mjs`):
  `authorization.granted`, `authorization.revised`, `authorization.revoked`,
  `authorization.approval_recorded`, `authorization.grant_checked` (stage `commit` | `admission`),
  `authorization.stale_refused`, `plan.replacement_drafted`, `plan.replacement_committed`,
  `plan.replacement_refused`, `plan.replacement_question_raised`, `admission.protected_refused`,
  `admission.reserved_refused`, `admission.player_inventory_refused`, `reservation.recorded`,
  `reservation.released`, `placement.npc_recorded`. Recoverable admission refusals also appear
  as `operations.preflight_recoverable` with `failure_class` `authorization_<code>`.

Review-round changes (2026-10-01):

- **Interim scope of the protected-asset gates (owner decision pending).** The protected-entity
  and player-inventory gates apply only to grant-backed work: a plan carrying replacement
  lineage, or any goal with an active grant. An ordinary user-requested goal behaves as before
  MW1 (the player's own request is their approval). Reserved-container exclusion applies to
  every goal. Revisit when the owner decides whether player-built protection should also bind
  ordinary requests.
- **Replacement only replaces the current blocked plan** (not a superseded plan, a healthy
  active plan or a second pending draft): named refusals `predecessor_not_active`,
  `predecessor_already_replaced`, `replacement_pending`.
- **World facts survive goal teardown.** `clearTaskContext`, `retireCompletedPlan` and the
  restore path keep reservations and NPC placement receipts as a goalless state (grants,
  questions and approvals still end with their goal).
- **Admission runs before commit**, so a protected/reserved refusal leaves the plan a DRAFT, as
  every other deterministic refusal does; the commit re-checks the grant again.
- **Name-based mining** (`mine_entity`) is refused while a container of that name is reserved.
  `clear_construction_area` remains a known gap (its targets are chosen inside the mod).
- Grants, approvals and reservations accept only `user`/`human` (or runtime) authority;
  `user_steering` does not.

What remains provisional or open:

- **Reserve syntax and release rule** are still the owner's to choose. The provisional parser in
  `runtime-v8/reserve-command.mjs` takes a whole message of `reserve` / `unreserve` (optionally
  with `this`/`the` and `chest`/`container`/`storage`), resolves the container the sender has
  selected, else the nearest container within 8 tiles, and releases only on an explicit
  `unreserve`. The map-tag marker is not implemented.
- **Concrete reducer names** used above (`authorization`, `REPLACEMENT_PLAN_REQUESTED`, the grant
  id form `<kind>:<mandate id>`) are proposals for the owner's "event/schema names" question.
- **MW5 wiring is not done.** Nothing yet issues a grant from Auto/Maintain or a player task,
  calls `requestReplacementPlan` from the planner/executor recovery flow, relays a pending
  question to the player, or lets the legacy board accept a replacement (its blocked-board
  guard still demands a user revision). The checks, events and facade methods are in place for it.
- **Not covered by the protected rule:** name-based `mine_entity` and `clear_construction_area`
  choose their targets inside the mod, so they cannot be checked against `last_user` from the
  harness; and `last_user` is also set by a human who merely configures an NPC-built entity
  (treated as protected, by design). The human arm of the engine rule cannot be exercised in
  the zero-player headless lane; it is recorded as not exercised.

### MW5 minimal wiring (2026-10-08, branch `feat/mw5-minimal-recovery`)

Static coverage only (scripted model replies, fake Factorio); no real-engine lane and no live provider run. Defaults below are
chosen, not owner-confirmed.

- **Grant at goal admission.** A chat-origin `new_goal` (`NpcAgentLoop.request`) issues a `player_task` grant: mandate id = goal id,
  requested result `goal:<goal_id>` with no destination, all five action scopes, not bound to an actor (it survives a respawn; actor
  and epoch are still fenced at the wake, the commit and every admission). Recovery runs, amendments, chat-only and status routes never
  mint one. Because MW1's protected-asset and player-inventory gates are grant-backed and still an interim owner decision, a bare
  `player_task` grant (no protected assets or materials) does not switch them on for an ordinary goal.
- **Replacement wake.** When the active plan becomes BLOCKED by a harness-evidenced preflight or admission blocker (an admission refusal
  counts only when the batch provably did not run) or by the deadlock detector, and the goal has a current grant and fewer than 3
  accepted replacements (read from the retained plan lineage, so it survives restart), the request does not end awaiting the player.
  The planner is resumed (or a fresh packet is built) through the explicit `replacement` restage reason, which is the only reason
  that may restage onto a BLOCKED plan, and receives a `[PLAN_BLOCKED]` facts message. Its ordinary `submitPlan` reply is turned into
  an MW1 `REPLACEMENT_PLAN_REQUESTED` by the harness (grant id and current revision, the grant's own requested result, scope
  `recovery`, empty impacts, the blocker's code, detail and evidence refs). Accept: the successor DRAFT commits through
  `commitReplacementPlan` and the executor is handed the new version. Ask: the old plan stays BLOCKED and untouched, a question is
  recorded and the player is told what needs their approval. Refuse, a stale grant, an exhausted cap or no grant: the request ends
  blocked as before.
- **Player notification.** A committed replacement emits `plan.replacement_announced` with the chat line; the supervisor prints it once
  per plan id.
- **Trace events** (each carries `request_id` and a `reason`): `plan.replacement_wake`, `plan.replacement_wake_skipped`,
  `plan.replacement_draft_repair`, `plan.replacement_announced`, plus the MW1 `plan.replacement_drafted|committed|refused|question_raised`
  and `authorization.granted|grant_checked` (stage `wake` is new). Tests: `replacement-wake.test.mjs`, `authorization.test.mjs`.
- **Not wired.** Unevidenced `BLOCKED:` replies still pause the goal. A semantic-step contract mismatch is prevented at commit by a
  separate unit. The deadlock trigger is hooked at one recovery branch and covered by a direct unit test, not by a looped deadlock
  scenario. The ask path has no player-answer flow beyond the existing keep_paused / revise / cancel controls; operation-level impacts
  (player-built structures, reserved supplies) are not computed at request time, admission re-checks them per operation.

## 8. MW2 build status

Status as of 2026-10-01: **MW2a (durable task ledger) and MW2b (operation reconciliation) are built on branch
`mw2-task-ledger` with unit and scripted-loop coverage; no real-engine lane was added or run.** Scheduler behavior (what
resumes when, aging action, question blocking) is MW3; the shared allowance is MW4; planner/executor notifications are MW5.

What is built:

- **Task ledger** (`runtime-v8/task-ledger.mjs`, pure; persisted in the planning state as `task_ledger`, carried across goal
  teardown, restage, slice changes and restart exactly like the MW1 world facts). It is separate from the Roadmap Shelf. A task
  is `interrupted` (it was running; holds a bounded checkpoint of its serialized planning state and compatibility board) or
  `pending` (accepted, never started). Each keeps the requested result (objective, game-checked `done_when`, optional
  destination from the grant or the caller), verified progress (plan id/version, completed step ids, receipt refs, a progress
  marker), the MW1 grant link, the interruption reason and state, the actor/epoch and the game tick it stopped at. Open tasks
  are bounded (8); a full ledger evicts the oldest visibly (`closed` history, `task_ledger.evicted`).
- **Reducer events** (runtime or user authority only; planner and Jev have no path): `TASK_INTERRUPTED` moves the running goal
  into the ledger (the planning state becomes goalless, so a task is never both running and parked); `TASK_RESUMED` restores the
  committed plan, step progress, receipts and locators exactly as they stopped, keeps the live world facts and ledger, and
  drops what described the stopped world (pause, condition wait, provider recovery); `TASK_QUEUED` and `TASK_CANCELLED`.
  Resume refuses while another task is running (one execution context), for an unknown task, for a paused/blocked task unless
  the user names it, and when the checkpoint cannot be restored.
- **Wiring.** A `new_goal` request that displaces an active goal records it first (`recordInterruptedTask`, before
  `clearTaskContext`); when a task completes, `finalizeCompletedTaskBoundary` resumes the most recent interrupted runnable
  temporary task and queues the ordinary interrupted-plan recovery (re-observe, never replay). Aging is recorded data only:
  15 game-minutes (54000 ticks) using the game tick when both ends are known, else wall-clock.
- **Operation reconciliation** (`runtime-v8/operation-reconciliation.mjs`, pure; the record lives in `run.pending_operation`).
  Before a batch is sent the runtime records a pending record (operations, signature, plan/step, actor/epoch, the mod's batch
  watermark from `autorio_operations.status`). The acknowledgement marks it acknowledged; the receipt settles it. A lost
  acknowledgement, a restart, an actor replacement or a death is reconciled against the mod's real batch ids, generation and
  the actor id/epoch: `admitted_in_flight|completed|cancelled`, `not_admitted`, `stale_actor`, `generation_changed`,
  `unknown`. Admitted: carry on as acknowledged, nothing is re-sent. Not admitted: one harness-told retry. Anything uncertain
  stays as `effect: unknown` and refuses an IDENTICAL delivery/craft/placement batch for the same plan step
  (`operation.duplicate_suppressed`); a changed batch, another step or a replaced plan is allowed. Recovery messages carry the
  reconciliation facts.
- **Trace events** (each carries `request_id` and a `reason`; asserted in `task-ledger.test.mjs`,
  `task-ledger-scenario.test.mjs`, `operation-reconciliation.test.mjs`, `operation-reconciliation-scenario.test.mjs`):
  `task_ledger.interrupted|queued|resumed|cancelled|evicted|refused|restored`, `operation.pending_recorded`,
  `operation.reconciled`, `operation.duplicate_suppressed`, `operation.stale_refused`.

Open or provisional: the checkpoint (a bounded copy of the planning state and board) is the resume mechanism; a task whose
checkpoint exceeds the size cap is kept but not runnable. Stagnation counters (3 attempts / 15 game-minutes) are not recorded
yet. An engine lane asserting that the mod's batch sequence and generation behave as reconciliation assumes across a real
save/load is not written (the autorio unit tests cover the counters; the harness side is covered by scripted fakes).

### October 2 receipt hardening

`e4e8238a` (integration `b3a7c701`) retains and persists the pending operation when
an idle receipt reports a cancelled batch with `partial_unknown`, a changed mod
generation, or a missing baseline. An earlier acknowledgement does not override
those unknown effects. Receipt traces carry the originating request ID when the
turn has already closed; normal correlated completion still clears the record.
Three additional scripted test groups and a separate review cover these paths.
No new engine evidence is claimed. Exact acknowledged-batch attribution,
joined-batch completion, multiple pending effects and verified-observation
clearance remain open; see the [October 2 checkpoint](validation/PLAYABLE_CHECKPOINT_2026-10-02.md).
