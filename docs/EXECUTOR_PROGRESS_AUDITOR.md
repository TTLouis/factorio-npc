# Experimental executor progress auditor

Owner: Codex chat `01a18409`, scratch branch `feat/executor-progress-auditor`.
Source: local Jev candidate `c3c68cf9fe70704845add91b8301261a510823c3`.
Dependencies: its reviewed preservation visibility recovery and exact operation
reconciliation. This task builds and tests locally; integration, live trials,
deployment and publication are outside its scope.

## Behavior and boundaries

The auditor is disabled by default. A future separately approved profile can set
`SGLUNA_EXECUTOR_PROGRESS_AUDIT=true` or `executorProgressAudit: true` in the
runtime configuration. The environment setting wins. It adds no model or Jev
judge. Planner consultation uses the existing guarded planner review path.

Before a structured batch is sent, the harness reads fresh contract facts and
persists the attempt with its exact operation/attempt identity and original
arguments. After receipt reconciliation, it compares native facts against the
previous attempt, episode baseline and durable per-predicate high-water marks.
Admission, arrival, visibility restoration, a receipt alone and controller health
earn no progress credit. Ordinary checkpoint authority still decides completion.

An initial batch without verified progress gets one retry. A subsequent batch
without progress automatically requests one planner refinement, carrying the
original submissions, reconciled receipt, before/after facts, constraints and
allowance use. The same failed submission is refused afterward. The planner's
reply cannot modify the committed checkpoint or waive native enforcement. A
review interrupted before its reply remains pending and stops safely on restore;
it does not silently execute or obtain another review allowance.

Verified progress permits another batch subject to every existing limit and two
additional ceilings: six attempts per equivalent obligation and 24 per goal.
These conservative experimental ceilings bound useful-looking but tiny repeated
work without changing provider, world-action, recovery or construction limits.
They count batches, including the initial batch and native deficit recovery;
they are not six extra retries. Records are retained without eviction up to 128
episodes; a full or malformed ledger fails closed. Canonical predicates exclude
IDs and sort requirements, so plan versions, predicate order and restaging cannot
refresh an equivalent obligation's allowance. Different obligations still share
the goal ceiling.

Quantity credit requires an integer gain of at least one item and 5% of the
predicate target beyond all earlier maxima, capped at that target. Boolean
world-state predicates earn at most one credit. Spent/reacquired stock and
placement/removal cycles do not buy another allowance. Consumption is not itself
a failure when another required predicate advances. Prerequisite navigation and
in-flight crafting/research progress currently receive no speculative credit;
only measured contract outcomes are supported. Unmeasurable/receipt-only
contracts stop safely in this experimental mode.

## Prevention and recovery

Existing plan validation, stock contradiction, authorization, duplicate-effect
and preservation guards remain authoritative. The new admission check refuses
opaque destinations when preservation is required, and requires explicit or
freshly bound destinations to lie within eight tiles of every preserved entity.
This includes implicit walking for placement, transfer and entity mining. Only
known stationary operations bypass destination checks. Candidate/layout movement
without an inspectable destination is conservatively refused. This is a bounded
admission policy, not a proof that native pathfinding stays inside that region.

A residual loss of visibility can use the existing single bounded native return
and reobservation. The return is exempt only through that recovery's private
admission witness. The auditor subsequently audits the original work, not the
return. The existing exact partial-gather recovery first reconciles stock/yield;
only its held, same-owner terminal-gather witness can exempt that exact row from
the auditor's unresolved-journal fence. Unknown effects and unrelated journal
rows still block execution. Audited planner/pause transitions consume the gather
recovery without allowing its old owner to replay a deficit.

Every async read, persist and trace is followed by an owner/actor fence. Native
work, pending operations, stale identity, missing facts and failed persistence
cannot grant continuation. Production requires a state file; only explicit
offline fixtures may use ephemeral storage.

## Evidence and acceptance

The lean additions reuse the real `NpcAgentLoop`, canonical memory, existing
preservation fixture and recorded Run AR partial-gather fixture. Native responses
and model replies are scripted; none of these tests is a real-engine or live
provider claim.

- `executor-progress-audit.test.mjs`: progress/no-progress, valid planner
  refinement, repeated approach refusal, exhaustion, disk restore, duplicate
  audit, uncertainty/native busy/stale ownership, high-water comparison,
  configuration, interrupted review and persistence failure.
- `contract-obligations.test.mjs`: shared implicit-travel prevention and an
  injected residual visibility miss followed by bounded reobservation and
  original-step completion. The residual injection uses the current typed native
  refusal; the historical BE refusal payload was incomplete.
- `run-ar-mining.test.mjs`: exact recorded partial-gather receipt composes with
  deficit recovery before audit/admission. The pre-attempt zero-stock baseline
  is explicitly synthetic because AR did not capture an auditor baseline.
- Disabled-feature control demonstrates the old repeated-work behavior without
  automatic planner consultation. This is a behavioral control on the candidate,
  not a claim of replaying the whole historical BE trial.

Correlated `executor.progress_audit` events distinguish attempt claims, progress,
no progress, planner requests, actual planner replies, pauses and ordinary
completion requirements. Audits, planner reviews, native recovery and checkpoint
completion remain separate events and counters.

Full logs stay local in
`D:/SideProjects/airi-factorio-npc/test-results/executor-progress-auditor-20261028`.
The required offline gate and independent Sol 6.1 review must pass before
closeout. The scratch payload must be repinned to the reviewed source commit.

## Remaining limits

No real Factorio trial or autonomous production success is established here.
The travel policy is intentionally conservative; distributed preservation,
candidate/layout destinations, route-shape proofs and prerequisite progress
credit need separate validation before broad adoption. Partial crafting and
research latency are not treated as measured advancement. Quantitative limits
are experimental policy choices, not demonstrated optimal thresholds. Current
live/frozen profiles remain unchanged.


## Static closeout

- Required offline gate: PASS, tooling + 104 agent + 4,351 runtime + 1,691 mod
  tests, TypeScript check, Lua build and generated-Lua validation.
- Thirteen focused regression additions reuse existing fixtures; no new engine
  lane or provider call was introduced.
- Sol 6.1 independent review: APPROVED for this experimental opt-in scratch
  implementation. Findings fixed: pending review crash window, retained original
  operation arguments, implicit travel coverage and partial-gather ordering.
- Exact partial-gather progress continuation is covered. A second partial-gather
  no-progress review through the deliberate transition marker remains additional
  adoption coverage; this is not claimed as verified by the progress fixture.
- First full run correctly caught missing installer module closure and option
  scope declarations; both were fixed before the passing gate.
- Integration and live adoption remain pending. Payload repin follows the source
  commit; local closeout records its exact identities and verification.
