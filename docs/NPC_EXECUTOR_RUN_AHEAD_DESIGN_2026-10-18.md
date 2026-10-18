# Executor run-ahead during a native batch: design note (2026-10-18)

**Status: SHELVED by the owner on 2026-10-18.** Nothing is built. Reopen only after the offline match-rate replay (3.4)
says a speculative round would match often enough, and after the round-count levers (section 4, point 3) have been
re-measured. What did ship for LLM wait time is read-side only: the unchanged-fact cache (98dde649) and the post-batch
fact bundle (26510c2c).

Design only: no e2e, no paid calls. Code was read from `experiment/jev-agent-architecture` at 26510c2c, and the trace
from Run Y `sgluna-behavior.jsonl` (a 57 min run on 2026-10-17). The cycle numbers below come from an offline replay
script that is not in the repo.

## 1. What Run Y actually shows (bounds the whole idea)

I rebuilt one "cycle" per batch: `request.waiting` (batch sent) -> `factorio.completed_signal` (receipt) -> first
`provider.request` ... last `provider.response` -> next `operations.admit`. 54 cycles, 166 post-step provider rounds
(3.1 per cycle), 30.6 min of model latency, 10.7 min of native batch time.

* **Batch time is very lumpy.** 33 of 54 batches finish in under 5 s (28 s in total, median 2.2 s). 12 batches of 15 s or
  more hold 8.7 of the 10.7 minutes; the 5 over 40 s hold 5.5 min (walks, gathers). Overlap only pays on those.
* **Perfect-hit ceilings** (overlap = min(batch, model time), summed): whole post-step chain 6.9 min; only the final
  deciding round 4.6 min (4.3 min on the 49 cycles with clean request/response pairing, 4.0 min when restricted to
  batches of 5 s or more); only the first round 2.4 min. That is 12% / 8% / 4% of a 57 min run, *at 100% hit rate*.
* **The bigger lever is round count, not overlap.** 14.2 of the 27.3 clean-cycle model minutes (52%) are spent in rounds
  that did not produce the operations (reads, "observation budget complete" retries: 63 recovery.classified
  `jev_observation_budget_complete`, 5 `observation_request_refused`). The post-batch bundle (26510c2c) attacks exactly
  this; its measured effect is not in this trace. Run-ahead overlap stacks on whatever is left after the bundle, so the
  deciding-round ceiling (4.6 min) is the honest number to plan with, not 10.7.
* **Receipts rarely close a step**: 50 `step.close_declined` vs 6 `step.verified`; only 3 of 53 consecutive batches had
  the same operation names. The next move after most receipts is "same step, adjust to what the receipt says", which is
  receipt-dependent. This is the main reason a speculative reply would often be wrong.
* Non-LLM time between receipt and next send is small (completed -> routed 0.8 s, routed -> first request 0.2 s,
  last response -> admit about 0.3 min total). Nothing to win there.

## 2. Where it would hook in

* Send: `npc-agent-loop.mjs` ~15705: `batchInFlightBeforeSend`, `noteWorldMutation({ sent: true })` (sets `batchInFlight`,
  bumps `worldMutationSeq`), then `executeAuthorizedBatch`. The await for the receipt is the idle window.
* Receipt: `completed()` ~10520: `taskStatusReceipt()` calls `noteWorldMutation()` and clears `batchInFlight`;
  then `routeStepCompletionDecision`, `settleCompletedStepState`, `jev.c4Boundary` / `routePostStepDecision`,
  `postBatchFactBundle`, and finally `continueFromModMessage(...)` which pushes the `[MOD] ... completed` message and runs
  the turn. `failed()` ~11021/11209 does the same with the error message plus recovery guidance (placement, transfer
  supply). Failure receipts are by construction the ones a prediction cannot cover.
* Fences that must keep holding: `batchInFlight` (blocks topology refresh, bounded native reads, and the fact bundle),
  `worldMutationSeq` (the bundle and every observation are tagged with it; stale ones are not shown),
  `assertCurrent()` before admission, and `operation.pending_recorded` before the send (pending-operation ledger).
* Prompt shape: tail blocks are inserted per round and never stored in `this.messages` (`insertTailBlock`, ~4710). A
  speculative round can reuse that mechanism without touching committed history.

## 3. Options

### Option A — speculative next round, adopted if the receipt matches the prediction

While the batch runs, build the round the model *would* get (committed history + a harness-authored fact:
"batch N in flight, expected X s, nominal result: ..." derived from the batch's own operations and the
`plan.time_estimate` it already computes). Run it on a copy of the messages (not `this.messages`). When the receipt
lands, run the normal receipt pipeline (completion check, C4/gate, fact bundle). If a deterministic **match test**
passes (task_state idle, every op completed in order, no refusal/partial, expected inventory/position deltas within the
nominal prediction, no step transition, same plan/step/epoch/actor, `worldMutationSeq` as expected), feed the held reply
into the *existing* admission path (preflight, `batch_stock_checked`, `operation.pending_recorded`, `operations.admit`).
Otherwise discard and run the real round as today.

* Minutes saved on Run Y shapes: ceiling 4.6 min (deciding round only; 6.9 min if the read rounds were also overlapped,
  which the bundle already mostly removes). Realistic with a 40% match rate: **about 1.5-2.5 min of 57 (3-4%)**. The 40%
  is an assumption (see 3.4 offline measurement), not a measured value. Value is concentrated in about 12 long batches.
* Correctness risks:
  * *Stale world / receipt-dependent replies*: the reply was written without the receipt. A match test that only compares
    "nominal vs actual" cannot see inventory-dependent choices the model made. Mitigation: restrict adoption to
    cycles where the held reply's operations pass the unchanged full preflight against the fresh post-receipt state AND
    the receipt equals the nominal prediction. Still weaker than the model reading the real receipt; a wrong-but-valid
    next batch costs real game time, which can exceed the saving. Hard to bound; the largest risk of the three.
  * *Epoch / mutation fences*: the speculative reply carries a `worldMutationSeq` older than the receipt's. Adoption must
    re-stamp nothing and instead re-run preflight; the held reply must be refused if the seq advanced for any reason other
    than the expected receipt read (amendment, pause, restage, cancel, actor replacement, auto-resume).
  * *Double send*: the speculative call must be incapable of sending: no `executeAuthorizedBatch` on that path, no
    `pending_recorded`, no ledger writes, no plan.accepted/persisted. Only adoption enters the send path, once, via the
    existing `operation_key` baseline check. Cancel/`cancel()` must abort the speculative request too.
  * *Jev contamination*: `jev.beginWake/endWake` and C4 scoring measure the cost and result of the wake that follows a
    receipt; C4 itself needs the receipt (`stepCompletion`). A speculative round must run outside a wake, and its cost
    be booked as adoption (counts toward that wake) or as separate "speculative waste", never as the C4 route's cost.
    Otherwise `jev.judgment_scored` would reward/punish routes for calls they did not make.
  * *Prompt cache*: committed prefix still cached (about 19.3k of 25-30k units per round in the trace). The speculative
    tail differs from the real tail, so a miss costs about 6k uncached units; on a miss both calls pay it. Provider
    calls rise up to +1 per cycle (about +54 on 166, +30%) if every batch speculates; gate by batch length (>= 10 s
    expected) to keep waste on about 12 cycles. Must not consume `continuations`, the 64/slice limit, or the budget
    counters (`budget.reserved`) until adopted.
  * *Owner rule "facts, not prompt advice"*: the injected "assume the batch completes" is borderline. It has to be a
    harness fact about the in-flight batch (expected outcome, ETA), not an instruction to act ahead. Needs an owner call.
* Build size: large. About 400-600 lines plus tests: a speculation scheduler, a nominal-outcome predictor, the match
  test, the held-reply adoption seam in the admission path, cancel/amend/restage fencing, budget/Jev accounting split,
  trace events, and static scenarios with scripted replies (match, mismatch, failure receipt, cancel mid-flight,
  amendment mid-flight, restage mid-flight). Realistically 2-3 build units and a gated live run.

### Option B — planning-only run-ahead (no operations can leave until the receipt)

Same background round, but the output is parked as a *draft*, never a candidate for direct send. After the receipt the
real round runs as today but receives the draft as a labelled tail fact ("draft prepared before the receipt, may be
stale") so the model confirms or edits it. Variant B2: only at step boundaries where Jev C4's `nextStepClarity` already
holds (next step contract fully specified), pre-drafting the next step's first batch.

* Minutes saved: B (confirm-or-edit) saves little. The real round is still a model call whose latency is dominated by
  reasoning and queue, not output length (trace: 168 of 185 output units are reasoning); expected saving **under 1 min**.
  B2 is limited by step closes: only 6 `step.verified` in Run Y, so about 6 chances at about 20-35 s, ceiling about 2 min,
  realistic **0.5-1 min**.
* Risks: no double-send or stale-send risk (nothing sends), epoch/mutation fences trivial (draft is dropped on any seq
  change). Real risks are anchoring (the model rubber-stamps a stale draft, which is exactly the planner-contamination the
  harness avoids) and the "facts not advice" boundary (a draft is a suggestion). Jev contamination as in A for any
  draft wake. Prompt cache: one extra miss per draft.
* Build size: medium, about 250-350 lines. No admission-path changes.

### Option C — parallel read-only observation during the batch

Run recipe/inventory/status reads while the batch executes.

* Minutes saved: **about 0**. Native reads take milliseconds over RCON; the cost in Run Y was model rounds, not read
  time. Mid-batch reads are also exactly what D2 forbids reusing: any observation taken before the receipt carries an
  older `worldMutationSeq` and is hidden from the prompt; topology/native-read helpers already refuse while
  `batchInFlight`. The only fence-safe reads are static ones (recipes, prototypes), which the unchanged-fact cache and the
  post-batch bundle already cover.
* Risks: stale world by construction; adds nothing.
* Build size: small, but not worth building.

### 3.4 Cheap, no-model measurement before any build (recommended first step)

Replay the Run Y (and Run X/W if available) logs offline: for every batch, compute the deterministic match predicate
from the receipt (all ops completed, no refusal, step not closed, inventory deltas close to the nominal estimate) and
report the **match rate on batches of 10 s or more**. No provider calls, no game. If the rate is below about 40%, Option A is
dead on arrival; if above 60%, it is worth one build unit. Also report how often the model's *actual* next operation
batch differs from the previous one (already 50 of 53 differ in op names, which is a bad sign for naive prediction).

## 4. Recommendation

1. **Do not build A, B or C now.** The honest ceiling is about 4.6 min of a 57 min run with a perfect predictor, and
   realistic is 1.5-2.5 min, against a large build that touches the admission path, the Jev accounting and the D2 fences:
   the very seams that have produced the silent failures in this project.
2. **First, run the offline match-rate replay (3.4)**: about 0.5 unit, zero cost. It also tells us how much of the post-step
   wait the bundle already removed in the next live run.
3. **Spend the effort on round count instead**: 52% of model time is in non-deciding rounds. After the bundle, re-measure
   rounds per cycle; if it is still above about 2, the remaining levers are (a) removing the forced
   `observation_budget_complete` retry round (63 occurrences: the model asks a second read, budget is gone, a no-tools
   round is forced), and (b) letting the model emit longer batches so there are fewer receipts to wait on. Both reduce
   waiting without any speculation risk, and both are facts/harness changes rather than prompt rules.
4. **If the owner still wants overlap later**, build A only in a restricted form: batches expected >= 10 s, single-step
   continuation (no step close), match test on a clean receipt, adoption through the unchanged admission path, speculative
   cost booked outside any Jev wake, behind a config flag default off, static scenarios first, then one gated live run.
   B2 is the safe fallback if A's risks are rejected, but expect under 1 min.
