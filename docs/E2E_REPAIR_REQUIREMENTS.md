# E2E repair requirements

Owner direction, October 22, 2026: an E2E fix must address the failure class,
prevent recurrence at the harness boundary, and provide bounded harness-owned
self-correction when prevention misses. Replaying one failed example is necessary
evidence, but is not the complete repair.

This governs fixes arising from live or deterministic E2E findings. It supplements
the [development workflow](DEVELOPMENT_WORKFLOW.md),
[production validation ladder](NPC_PRODUCTION_VALIDATION_ROADMAP.md), and shared
workspace execution/reporting rules. It grants no live-trial, provider retry,
deployment, publication, plan-replacement or gameplay authority.

## The harness owns correction

Runtime code, validators, receipt processing and the supervisor own detection,
evidence checks, recovery transitions, retry allowances and completion. A better
prompt, a model promising to retry, or a planner/Jev opinion is not a correction
mechanism. Models may propose a permitted next action or strategy; the harness
must independently enforce its prerequisites, authority, admission and outcome.

Prefer deterministic rules and typed state over another model call when facts,
schemas or receipts can decide. Do not put the correctness loop inside the
planner/executor prompt or let a model waive a failed check.

## Required repair scope

1. **Name the broken invariant and its owner.** Preserve the original failure,
   exact source/deployed identities and causal sequence. Identify why existing
   prevention, recovery, diagnostics and tests missed it. Audit neighboring entry
   points and variants, including ordinary returns versus exceptions, restart,
   restage and native callbacks. State the bounded failure class being repaired.
2. **Prevent the class at a shared boundary.** Centralize the relevant contract,
   schema, receipt meaning or lifecycle rule and make its producers and consumers
   agree. Apply it wherever that invariant crosses a boundary. Do not special-case
   a run ID, response ID or step wording, or introduce a second divergent rule.
   Keep the change scoped; this does not require an unrelated framework rewrite.
3. **Detect residual misses from authoritative state.** Reconcile the committed
   checkpoint, verified receipts and fresh native facts before repeating a
   mutation, escalating review or declaring a blocker. Missing, stale, unreadable,
   admission-only or uncertain evidence cannot become completion proof.
4. **Correct safely in code.** Where the harness can prove a safe correction,
   normalize/reconcile the state or repair a strictly bounded advisory field,
   advance progress once, and resume the appropriate next step or native callback
   without corrective operator prompts. Keep committed semantics unchanged.
   Reconcile partial effects before considering replay; repeat a world action only
   when existing authority and deterministic evidence establish replay safety.
5. **Bound failure honestly.** Preserve existing call, time, observation,
   no-progress and durable recovery limits across restart/restage. If correction
   cannot be proved, route to the existing guarded review/replacement procedure or
   a durable, classified, visible pause. Recovery exhaustion must be explicit;
   neither endless retries nor fabricated success is an acceptable fallback.

Self-correction must preserve actor/epoch, goal/plan/version/step and request
ownership across every await and delayed callback. A replaced request cannot
pause, deactivate, complete, clear traces or spend allowance belonging to its
replacement. Respect pending operations, partial/uncertain effects, native work,
condition waits, staged amendments and user stops. A failed recovery must not
change the requested result, weaken a checkpoint or manufacture receipts.

An accepted nonterminal goal must have a responsible next transition: native work
or a condition wait with its wake path, bounded harness recovery, or a durable
visible pause. A returned `blocked` result or clean wrapper exit must not silently
leave canonical execution active with idle native queues and no next wake.
Preserve intentional terminal pauses as well as normal successful transitions.

## Proof required before calling the repair complete

| Layer | Required evidence |
| --- | --- |
| Original regression | Preserve and replay the actual failure. Run the new positive cases against the unchanged baseline and retain the expected failures. Label any fixture substitutions explicitly. |
| Prevention | Exercise the shared rule through its relevant producers/consumers and neighboring variants. A helper-only test or schema acceptance alone does not prove runtime agreement. |
| Residual miss | Deliberately bypass prevention in a fixture, then drive the real harness/supervisor path. Prove detection, safe correction and automatic continuation without an operator prompt, duplicate mutation or invented proof. |
| Safety | Cover applicable stale/wrong-step/actor/epoch/request evidence, unreadable facts, pending/partial effects, busy native queues, amendments and cancellation. Change ownership during awaits/trace writes, not only before entry. |
| Exhaustion and restart | Prove bounded correction/review/resume, durable allowance after restore, and a visible terminal result after exhaustion. A safe pause alone does not prove successful self-correction. |
| Diagnostics | Assert named traces with request/goal/plan/step identity, reason and disposition where available. Feed the original and corrected terminal event shapes to the checker; a zero finding count from a detector that misses the failure is not evidence of liveness. |
| Integration | Record immutable candidate/merged SHAs, required checks, independent review and payload identity where affected. Use native engine proof for changed game mechanics; another live trial needs its existing authorization. |

Use a small failure-class matrix rather than adding only variations of the same
happy path. Explain exclusions and remaining gaps. Tests must show both that valid
work can recover and that unsupported work cannot slip through. Do not weaken
acceptance assertions or erase raw evidence to make the repair appear successful.
A baseline control must fail because of the observed defect, not a missing new
test API, broken fixture or unrelated setup failure.

## Repair closeout

For each E2E-derived fix, include this in the task note or PR acceptance evidence:

```markdown
Failure / preserved evidence / baseline SHA:
Failure class, broken invariant and harness owner:
Why earlier prevention, recovery and tests missed it:
Shared prevention rule and affected entry points:
Residual-miss detector -> authoritative facts -> bounded correction -> next wake:
Safety fences, durable limits and exhaustion disposition:
Baseline negative control / prevention / composed recovery / safety tests:
Trace/checker coverage and independent review disposition:
Verified candidate/merged SHA and evidence paths:
Unproven native/gameplay behavior and remaining gaps:
```

Separate four claims: the exact regression is fixed; composed harness recovery is
verified; native engine behavior is verified; the autonomous gameplay goal was
achieved. State only what the evidence establishes. Green static checks, placement,
command admission, slice completion and a safe pause do not establish production
success or comprehensive recovery coverage. Keep derived analysis outside sealed
historical evidence and follow the existing E2E metrics/reporting requirements.
