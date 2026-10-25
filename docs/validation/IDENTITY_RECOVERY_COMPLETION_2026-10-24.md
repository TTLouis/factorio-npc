# Identity recovery completion regression

Owner: OpenCode session `ses_e8fbb4e9effexW9zoz5tJzPldo`.
Branch: `test/identity-recovery-completion`.
Source: current integration / cached origin Jev
`0102d24070fe951b59d01cda8b7463b79fdd5f26`.

## Scope and acceptance

Add an offline synthetic two-step regression crossing post-parse identity loss,
harness-owned identity reconciliation, collection, exact operation receipt,
unchanged deterministic checkpoint completion and ordinary next-step admission.
Do not suppress normal completion or continuation. Challenge the same chain with
restart, lost acknowledgement and actor replacement. Preserve committed intent,
durable recovery allowances and uncertainty fences.

The integrated AU repair is a dependency. No historical fixture/report changes,
live inference, deployment, push or integration are authorized by this task.
The game/provider are scripted edges; this proves runtime composition, not native
engine semantics or autonomous gameplay success.

- [x] Positive completion and next-step admission, with and without lost ack
- [x] Restart, lost-acknowledgement and actor-replacement tests implemented
- [ ] Restart completion acceptance: six strict regressions fail on source
- [x] Final independent diff review and whitespace/link review

## Result: restart evidence gap reproduced

The new [regression file](../../deploy/pterodactyl/runtime-v8/identity-recovery-completion.test.mjs)
adds 18 scenarios. Twelve pass; six deliberately retain the requested completion
assertions and fail against the unmodified runtime. They are not skipped, marked
TODO or changed to accept the defect. This is a local red regression checkpoint,
**not an integration-ready candidate**.

Passing coverage:

- Post-parse identity loss is detected at admission. The harness refreshes the
  recorded furnace identity under the original request, actor and epoch.
- It admits only the four-plate residual, not the stale ten-plate proposal.
  Scripted furnace output was produced from declared ore/fuel; admission itself
  changes no stock. Collection leaves ten actor-held and six furnace-held plates.
- Ordinary Session completion publishes verified per-step operation evidence,
  closes the unchanged inventory-plus-receipt checkpoint and admits the next
  committed step. That step cannot borrow its predecessor's receipt.
- Lost acknowledgement reconciles in flight without replay. A duplicate callback
  cannot close the next step; its own batch completes and verifies the finite goal.
- Unfinished mod reload and actor/epoch replacement retain unresolved work and
  admit nothing. Stale actor/epoch cases guard-pause before inference.
- Missing journal receipt, wrong signature, attempt, ordinal, operation key,
  receipt generation or batch reference cannot close from inventory alone.
  They retain unresolved work and stop before inference. Same-actor uncertainty
  is held by the pending controller, not claimed as a new visible guard pause.

Failing coverage:

- Process-only restart after collection, with/without lost acknowledgement.
- Process and mod restart after collection, with/without lost acknowledgement.
- Injected journal-only receipt visibility, with/without lost acknowledgement.

The native-shaped mod reload restores `last_completed_batch` from its persisted
journal, matching `packages/autorio/src/task_manager.ts:176-178`. Journal-only
visibility is a separately named residual fault, not the normal engine shape.
All restart cases serialize through the actual state file, instantiate a new
agent/memory/Session, load persistent state and use Session startup recovery.
Live identity bindings disappear; durable refresh claims and controller allowances
are unchanged. The old process never receives the completion callback.

`reconcileOutstandingOperation()` recognizes exact completed work and
`settleOutstandingOperation()` clears its duplicate-effect hold. Neither ingests
the missing callback's verified operation evidence. The fresh inventory condition
is satisfied, but the committed `authoritative_operation_receipt` condition is
not, so the first step remains active and the scripted next-step reply is rejected.
The test does not remove that requirement or suppress ordinary continuation.

The preliminary independent reviewer (`ses_e8f4f8893ffeoWMB2Y8y5jzsFU`) confirmed
the evidence-ingestion gap and identified the native restart fixture correction
above. This does not constitute approval of a production repair.

Final independent review (`ses_e8f497b37ffeXUu07w1iJ9p4Ua`) inspected both
additions and the actual gate logs. It found no actionable defects and confirmed
all six failures reach exact restart settlement before the unchanged step fails
to close. The subsequent next-step reply rejection is a consequence, not an
invalid test expectation. Accepted as a tests-only red checkpoint, not for
integration or as approval of a production repair.

## Validation

Commands ran through Git Bash and the existing `npc-dev` Docker runner, no
network or host dependency tools. The task date is local October 24; logs use
October 25 UTC. Full logs remain local, not staged or published:

- `bash scripts/test-local.sh all`: exit **1**. Agent: 103 pass. Runtime:
  3,426 tests, 3,420 pass, six new restart regressions fail; all 3,408 pre-existing
  runtime tests pass. The runner correctly stops before the mod lane.
  Log: `C:/Users/Louis/AppData/Local/Temp/opencode/identity-completion-gate-all.log`.
- `bash scripts/test-local.sh mod`: exit **0**. 1,378 mod tests, typecheck, Lua
  build and generated-Lua check pass.
  Log: `C:/Users/Louis/AppData/Local/Temp/opencode/identity-completion-gate-mod.log`.
- Staged `git diff --check`, relative-link review and final-newline checks pass.
  All ten exact task-owned container names from the local logs are absent,
  including stopped containers. Shared `npc-dev` image identity:
  `sha256:5ebe30259a5ad6e935317e9ad4e831bb9135c75c653c4e743029eaf5f511602f`.

## Next decision and limits

Discuss the confirmed defect before a separate bounded production repair. The
likely repair is shared completed-receipt ingestion for normal callbacks and
restart reconciliation: exact native admission/receipt proof must pass the
existing semantic verifier and be durably attributed to its original goal,
plan, step and actor. Effect settlement is not semantic completion. Fresh world
checks must still close the unchanged checkpoint, never a reconciliation verdict.

Additional repair acceptance would include supersession/async ownership fences,
missing or stale transfer-effect data, native busy state, insufficient current
stock, repeated restart, proof durability and exhaustion. These tests do not
claim that entire future repair matrix is complete.

Checkpoint: test-only implementation complete; strict restart regressions expose
an unfixed production defect. No runtime/mod/contract/installer changes, production
repair, native engine trial, live inference, merge, push or deployment performed.

## Authorized repair checkpoint (resumed)

The owner authorized fixing the restart defects after the test-only checkpoint,
then paused and explicitly resumed that work. Reuse this branch and checkout;
the preserved red baseline is `77765aa86d40b6d83712b5ad19e3187300c82de0`.
Earlier results above remain baseline evidence, not repaired-candidate results.

Acceptance: ingest exact completed native receipt evidence through the shared
runtime verifier, attribute it to the original goal/plan/step/actor/epoch, persist
before releasing the duplicate guard, and let fresh world checks close the
unchanged contract. Cover ownership changes during awaits, insufficient or stale
proof, native busy state, duplicate/repeated restart, and transport-paused recovery.
No new replay permission, allowance, gameplay mechanic, live call, integration,
push or deployment is part of this repair.

Checkpoint: implementation in progress; candidate validation and independent
review pending. No production repair is claimed by the baseline evidence.

## October 25 handoff and repaired candidate

The owner transferred this task to Codex chat `01a171d1` and authorized finishing,
validating and locally merging the repair. The test-only baseline above is
preserved unchanged at `77765aa8`; the current integration source is `0102d240`.

The inherited runtime repair shares exact completed-receipt ingestion between
ordinary callbacks and restart reconciliation. A receipt must match the durable
admission, operation signature, original goal/plan/step and actor/epoch, then pass
the existing semantic verifier. Evidence is persisted with the pending guard
before that guard is released. Startup recovery checks the unchanged checkpoint
against fresh world facts before briefing the executor on its next step.
Paused recovery records proof passively; resuming still uses the existing pause
classification and completion gates. This does not add replay or plan authority.

Fresh Docker validation, using existing `npc-dev` image
`sha256:5ebe30259a5ad6e935317e9ad4e831bb9135c75c653c4e743029eaf5f511602f`:

- Original baseline: 18 tests, 12 pass and the same six restart-completion
  failures. They reach exact settlement without verified semantic completion.
- Inherited repaired candidate: all 40 focused tests pass, including the original
  six positive restart regressions and 22 added safety/durability scenarios.
- Required `bash scripts/test-local.sh all`: exit 0; 103 ordinary-agent,
  3,448 runtime and 1,378 mod tests pass, plus typecheck, Lua build and generated
  Lua verification. The two failures in older repair logs do not recur on this
  candidate; no additional runtime correction was needed during this handoff.
- Scoped lint: exit 0 after moving an existing restart-test declaration before
  the scripted callback that references it. Assertions and execution order of
  the actual recovery are unchanged.

Safety coverage includes missing or mismatched receipt/admission identity,
superseded request ownership during awaits, missing/stale/wrong transfer effect,
native busy work, insufficient fresh inventory, changed goal/plan/step, historical
old-actor evidence, transport pause, persistence failure and repeated reconciliation.
The existing identity-recovery allowance remains durable across process restore;
this repair adds no retry loop or allowance reset. Unsupported semantic proof
leaves the unchanged completion contract unsatisfied. Exact effect settlement can
still release its pending guard; unresolved native work retains the existing
duplicate-effect fences. Existing recovery/exhaustion suites are included in
the complete gate; this is not a claim of new native gameplay coverage.

Full logs, inherited diff and the baseline source archive remain local under
`D:/SideProjects/airi-factorio-npc/handoffs/restart-fixes-2026-10-25/` and must not
be staged or published. Independent review, separate payload repin and merged
offline validation remain required before integration closeout. No Factorio
mechanics changed; no live provider/Jev call, autonomous trial or deployment was
performed. A local merge does not publish the repair to the remote branch.
