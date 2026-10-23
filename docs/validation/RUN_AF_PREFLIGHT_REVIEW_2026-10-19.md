# Run AF readiness: placement mutation proof blocks the live trial

The authorized follow-up checked published Jev candidate
`3fe2bcbf7675089688b3d59350791ce2ca7c2b5b` on 2026-10-19. It includes Claude's
Run AE fixes, code `8f1ffcf4` and payload repin `a40d5fb5`. The integration
checkout was fast-forwarded to that already-published candidate. No Run AF live
trial, provider request, Jev request or test container was started.

The exact candidate passed hosted CI `39272662568` (all seven jobs, including
the deterministic Factorio job), Pterodactyl release gates `39272662779`, and
Security `39272662722`. Claude's checkpoint records 2,658 runtime tests, 1,241
mod tests, typecheck/Lua, changed-file lint and nine payload tests passing.
Independent read-only source review nevertheless found one corroborated blocker.

## P1: placement pickup can mutate before a false no-effect receipt

At this frozen candidate:

- `packages/autorio/src/basic_operation_runtime.ts:496–500` calls
  `pick_up_ground_items`. A partially fitting stack changes the actor inventory
  and remaining ground stack, then calls `controller.fail` with
  `ground_items_inventory_full` and the pickup details.
- `packages/autorio/src/basic_operations.ts:563` unconditionally passes
  `failed_before_mutation:true` for every `PLACING` failure. Its comment assumes
  failed placement has no world effect, which the new pickup step invalidates.
- `packages/autorio/src/operation_admission.ts:197–205` consumes that cancellation
  flag to settle the started operation as a proven refusal before mutation.
  `deploy/pterodactyl/runtime-v8/operation-reconciliation.mjs:212` also trusts the
  flag. The resulting no-effect proof can therefore contradict the native state.
- The post-pickup native-check failure shares the same false flag. The
  `create_failed` path at `basic_operation_runtime.ts:536` additionally omits
  pickup details from its failure result.

The new `placement_ground_items.test.ts` already constructs a concrete example:
three ore on the ground, inventory accepting only one, a failed build, two ore
remaining and one picked up. It checks `last_result` but not the cancelled batch
and admission proof. Passing this test does not establish safe reconciliation.

The correction needs to track measured pickup effects across every subsequent
failure, withhold the no-effect flag after any pickup, retain pickup details even
on creation failure, and assert batch/admission/runtime reconciliation outcomes.
Measured zero-pickup refusal should retain its legitimate no-effect proof.

## Native evidence and next step

The new ground-item tests use mocks. This commit range adds no real-Factorio
ground-item placement lane or proof. Existing deterministic CI coverage is green,
but does not establish the new spilled-ore pickup behavior or its partial-failure
receipts. Obtain appropriate real-engine evidence after correcting the receipt
bug, before another provider trial.

The separate reviewer found no other corroborated source blockers. The parent
checked the mutation and receipt consumers directly and confirmed the finding.
Implementation remains with Claude; this chat made no runtime changes and sent
no message to another chat. The 15-minute follow-up remains active, waiting for
a distinct relevant reviewed, integrated and validated correction. This
candidate has not consumed its one-trial allowance.

Evidence is retained in `test-results/e2e-followup/candidate-3fe2bcbf`, including
the review, immutable source excerpts and hosted-gate browser snapshots. The
documentation-only browser was closed; no Run AF Docker resources were created.
Run AE and earlier sealed evidence remain unchanged.
