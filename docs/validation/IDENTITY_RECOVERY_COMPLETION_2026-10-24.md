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
