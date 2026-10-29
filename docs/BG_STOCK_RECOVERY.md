# BG stock dependency recovery

Owner: stock implementation subagent under the `fix/bg-harness-recovery` task.
Baseline: `34c43507df01223478f2ca286cd8214ce7c89d04`. Integration, independent
review, publication decisions and native test ownership remain with the parent.

## Failure and retained evidence

BG lane A proposed acquisition followed by furnace transfers in one batch. The
native admission snapshot could not establish the consumer's stock before the
acquisition ran. Whole-batch refusal was correct. The capability gap was that the
harness could only ask the executor to split the batch, spending the same durable
argument correction used by any later mistake on that semantic step.

The sealed original `tap_14` and `tap_24` operations are extracted without edits
in [bg-stock-original.json](../deploy/pterodactyl/runtime-v8/fixtures/bg-stock-original.json),
with response identities. Their source is the local run BG lane A sealed
`provider-full-responses.jsonl`; the corresponding causal review and original
behavior stream remain unchanged. `tap_14` gathered ore, withdrew furnace output
and supplied the furnace; `tap_24` gathered fuel then supplied the same furnace.
The earlier `tap_14` correction was still spent when `tap_24` exhausted it.

## Shared boundary and correction

Automatic splitting requires an existing current goal grant. Grant-less finite
plans pause explicitly with `stock_dependency_authority_unproven` and are outside
this bounded repair.

[bg-stock-dependency.mjs](../deploy/pterodactyl/runtime-v8/bg-stock-dependency.mjs)
implements one bounded ordered barrier. Its accepted shape is a nonempty leading
sequence of gather, coordinate mining, harvest or exact withdrawal operations,
followed exclusively by exact outbound transfers or `supply_entity`. It retains
the complete original ordered list and every original argument. Interleaved
placement, crafting, unrelated world operations and arbitrary list filtering are
outside this repair.

The ordinary preflight refusal boundary attempts deterministic scheduling before
the generic argument correction. It independently reruns the shared batch stock
ledger, requires the same unverified acquisition dependency and complete native
prefix preflights, checks whole-list authorization, and checks checkpoint stock
extraction. It then durably claims the barrier and admits only the ordered prefix
through ordinary `commitPlan`. The argument-correction boundary repeats this
reconciliation as the residual detector if the earlier barrier is missed.

Both segments use the existing prepare-before-send operation ledger, native
authorization, preflight and preservation boundaries. No mining product, recipe,
yield or transfer capacity is inferred from the model's words. A prefix receipt
must satisfy the existing exact protocol-2 `completedOperationReceipt` contract.
Fresh held inventory is then read, and the unchanged suffix passes normal
preflight again. Missing yield, changed destination or insufficient actual stock
therefore cannot be converted into a successful transfer.

The barrier intercepts ordinary native completion, failure and restart/restage
turn entry before provider continuation or checkpoint settlement. Fresh checkpoint
closing is suppressed while either segment is outstanding. Successful suffix
settlement returns to the ordinary checkpoint evaluator; it does not manufacture
step or goal completion. The suffix never asks a model to reconstruct the proposal.

## Ownership, durability and limits

The canonical snapshot includes the full proposal, split, operation signature,
actor/epoch/session/surface, goal/plan/version/step/semantic-step and current exact
pending witness. Preparing either segment binds that witness before the strict
state write and before transport. Clearing the ordinary pending operation after
a receipt cannot lose the barrier's original witness. A restored claimed record
without an admission witness pauses; it is never blindly resent.

Two barriers per semantic step, six per goal and 128 goal ledgers are hard durable
caps. Verified progress, new requests, restage and restore do not refund them.
The existing argument, provider, time, campaign and recovery limits are unchanged.
Malformed snapshot keys, scope, signatures, states, pending identities or bounds
set a durable fault. That fault pauses even if validation discarded the active
record, preventing hidden allowance renewal.

Every recovery await checks request/intake, amendment, checkpoint and actor
ownership. True supersession uses the existing stale-reply classification so the
generic dispatcher cannot reinterpret an old correction as work for a replacement.
The final pre-transport fence rechecks native idle. Unknown or unresolved native
journals use the shared `nativeAdmissionJournal` parser, including native empty
Lua `{}`. Waiting is allowed only for the exact owned admitted native operation;
unrelated native work pauses visibly. Stop, amendment, revoked authority, changed
actor/surface, partial effects and unreadable evidence never authorize continuation.

Named traces are `stock_dependency.barrier_staged`, `residual_detected`,
`prefix_settled`, `completed` and `exhausted`. They carry current request, goal,
plan/version and step identity plus the applicable operation key, native batch
reference, reason and disposition. Exhaustion uses a durable guard pause with a
distinct `stock_dependency_*` reason. The run checker integration is parent-owned.

## Proof and explicit substitutions

Focused tests run in the existing offline `npc-dev` Docker image using the
reviewed runtime mounts:

```sh
node --test deploy/pterodactyl/runtime-v8/bg-stock*.test.mjs
```

At the stock handoff, 52 tests pass. They exercise both original operation lists,
automatic prefix/suffix continuation with no new model reply, unchanged committed
steps, exact completed receipts, an injected missed early boundary reaching the
real fallback, restart after ordinary receipt settlement, duplicate callbacks,
two completed episodes and third-attempt exhaustion, malformed restore, unreadable
inventory, missing/partial/wrong-actor receipts, insufficient actual yield,
unknown journals, owned native busy waits, foreign work, and cancellation/amendment/
intake/epoch/authority changes during state writes and traces. Suffix admission
trace and persistence races prove exact unsent settlement without prefix replay.
Independent Sol review additionally identified the inner persistent-pause await
as an ownership boundary. Guard pauses now retain amendment, active and actor/
epoch/session/surface identity across their own load, persist and diagnostic
awaits; six composed fault cases prove an old correction cannot pause newer work.

The unchanged-baseline controls import only APIs already present in `34c43507`.
All three positive progress assertions fail there as expected: the original
proposals are refused with `batch_stock_unverified_dependency`; the original
second proposal with the public reducer's prior same-step correction claim fails
with `argument_correction_limit_exhausted` at baseline loop line 16100. The new
candidate passes those same controls and leaves the original argument claim spent.
The earlier native progress is represented by explicit held-stock fixture state
and the existing public claim API, not claimed to be a full replay of the BG world.

Local logs, overlay and expected baseline exit codes live under the shared
workspace `test-results/bg-harness-recovery-20261029/stock/`; they are unstaged
and unpushed. The baseline source export itself remains read-only. All focused
test containers are run-scoped, use `--rm`, and are verified absent by the reviewed
runner's teardown trap.

[bg_stock_recovery_factorio.mjs](../tests/factorio/runner/bg_stock_recovery_factorio.mjs)
is the exact-version native proof driver. It uses real acquisition and delivery,
real journals/receipts, restore after normal receipt settlement, native inventory
and destination verification, and ordinary final callback completion. Its small
scripted fixture is separate from the original BG operation replay. The parent
owns image freezing, execution, evidence, cleanup and final outcome reporting.
The first native attempt correctly stopped before sending when its empty native
journal `{}` exposed a parser disagreement; the shared parser and four native-shape
regressions now cover that discrepancy. No autonomous gameplay or broad factory
success is claimed by these offline checks.

The parent-owned second native attempt passed on its frozen source: real gather,
restore, exactly one unchanged suffix, destination and held-stock checks, and
ordinary callback goal completion. Later guard-pause review hardening and the
explicit staged-event semantic identity require the parent's final source-match
gate; the second attempt is not silently relabeled as that newer candidate.

Checkpoint: implementation and focused proof complete; independent Sol review,
parent-owned native rerun, combined offline gates and integration remain separate
acceptance steps. Record their immutable source hashes and final disposition in
the parent task closeout rather than rewriting sealed BG evidence.
