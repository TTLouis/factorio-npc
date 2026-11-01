# Run AM recurrence and prior-claims audit

Independent read-only review, 2026-10-22. Baseline: `01ec0a1015eb76320a4b061ae2dba397d7c761f7`, the frozen Run AM candidate. Code references below refer to that commit, not the concurrently edited task checkout. This audit changes no production source, tests or sealed historical evidence. It does not run providers, Jev, Docker or another live trial and does not certify the new fix.

## Finding

The repeated failures are not evidence that the exact Run AL fix reverted. They expose uncovered neighboring paths in a fragmented contract/lifecycle implementation. Earlier regression tests proved the reported examples; they did not establish the broader promises that equivalent operation receipts always reconcile, or that every terminal refusal leaves a durable, visible controller state. Any conversational claim that the overall contract/recovery problem was fixed was too broad. The honest claim was that a named regression was fixed under its stated checks.

Three concrete gaps coincide in AM:

1. Completion contracts use operation names as semantic identities, while native completion proof already recognizes multiple operation names for the same physical task. No shared, explicit receipt-equivalence rule joined those layers.
2. Returned blocked results and thrown request failures have different terminal-state owners. The existing active-plus-idle safety net handles exceptions, but AM exhausted validation by returning a blocked result.
3. The diagnostic called `silent_blocked_stall` checks an older blocked-preflight shape. It does not detect AM's `blocked_before_mutation` result with canonical execution still active. A green assertion against that detector did not establish the desired lifecycle invariant.

## Exact AM chain

Retained evidence is in sibling checkout `.worktrees/test-run-am-red-automation/test-results/red-automation-live-2026-10-22am/analysis/`, especially `stall-evidence.json`, `full-issued-responses.json` and `run-check.json`; the human report is `docs/validation/RED_AUTOMATION_LIVE_RUN_AM_2026-10-22.md` in that checkout.

AM completed the iron slice. Copper step `goal_1a7uduh_1_p4_v1_s4_092rluk` required two burner drills plus an authoritative `place_entity` receipt. Its own guidance asked for native copper-bound placement candidates. Native batch 21 placed copper drill unit 17 using `place_candidate`; the receipt matcher required the other name, so the step stayed open. A planner review correctly refused to duplicate or dismantle the valid drill merely to manufacture a differently named receipt.

The final captured executor response, `resp_0e117675af0cc3b5016ada51fa74b487d1935cc39dc01324af`, requested review with a 402-character rationale. Both wire schema and runtime maximum were 400. This was an actual model violation, **not another mismatch between those two limits**. The exact response archive records `role.contract_refused`, then `recovery.classified` with `invalid_planner_review`, retry 4 / limit 3. At 18:12:26.414Z, the request ended `blocked_before_mutation`; the canonical plan remained `EXECUTING`, native work was idle, and the runner remained `controller_running`. The report records another 41.512 minutes from last response to stop submission, and zero science packs.

The malformed review is the immediate trigger; the harness's failure to close the active/idle state is its own correctness defect. A compliant shorter reply would avoid that particular trigger but would not fix the harness defect.

## Why the receipt fix escaped earlier work

At baseline, `runtime-v8/step-completion.mjs:10-11` recognizes both `place_entity` and `place_candidate` as strict `placing` operations. Its authoritative-receipt evaluator at lines 313-315 nevertheless tests exact name equality or exact membership in recorded names. Blame attributes that exact-name comparison to `e15431a7` (2026-09-18), before the fixes discussed here. Therefore this audit finds a pre-existing uncovered path, not evidence that AL introduced the alias failure.

The same concept crosses several owners: schema-supported operation names, current-batch grounding, immutable checkpoint retention, durable verified receipt names, and fact matching. Those owners agree on which names are allowed but did not agree on which proven operations satisfy a semantic receipt. Their separate exact-name decisions make a locally sensible change insufficient to establish the end-to-end promise. Native task-type equality alone must not be used to make every operation interchangeable: any fix needs explicitly scoped equivalence and the existing fresh, same-plan/step, successful native proof requirements.

| Earlier work | What its actual tests establish | What AM adds |
| --- | --- | --- |
| `d9af7954`, semantic completion proof; `SEMANTIC_COMPLETION_PROOF_FIX_2026-10-20.md` | Two regressions stop a supply batch receipt being promoted into semantic step/goal completion. The Run AG fixture keeps the committed iron/research contract open. | AM is the opposite error: valid placement proof fails a differently named receipt requirement. Keeping AM open does not contradict the earlier false-positive fix. |
| `42330385`, construction prompts/schema; `CONSTRUCTION_PLANNING_CONTRACTS_2026-10-22.md` | `completion-schema.test.mjs` aligns supported shapes/limits; construction boundary tests refresh identities between placements. | Syntactic acceptance does not prove equivalence across physical operation variants or graceful handling when a model violates a valid bound. The pump/boiler/engine fixture uses `place_entity` and entity-count checkpoints. |
| `3e937fe9`, Run AL; `RUN_AL_CONTRACT_SCOPE_FIX_2026-10-22.md` | `multi-batch-contract.test.mjs` preserves one immutable whole-step contract across separate `supply_entity` and `move_items_exact` batches. Both exact names match their requirements; controls reject premature world outcomes, stale/unverified proof and contract replacement. | Candidate placement recorded under another operation name was absent. AL changed accumulation/batch grounding, not the exact-name evaluator. AM's iron progress is supporting evidence for multi-batch execution, but its live iron contract did not select the exact AL two-receipt fixture. |

The composed delegation test looks close to AM because it uses `place_candidate`, review, a second review and automatic resume. However, its first checkpoint (`CP1`, line 70) requires only drill/furnace entity counts, and its review rationale is valid. It never combines a generic placement receipt requirement with candidate placement, nor a malformed review after the recovery allowance is spent. That missing combination explains why the impressive composed path could pass while AM failed.

## Why the refusal still stranded the controller

The production return path can be followed without a model:

- `staging/npc-agent-loop.mjs:1030` catches a plan-category validation error, increments its retry counter, and, after the limit, **returns** `blockedWithoutMutation`.
- The base implementation at line 877 sets `agent.active = false` and returns a blocked result. It does not transition the canonical plan.
- The v8 override at `runtime-v8/npc-agent-loop.mjs:10688` writes `request.completed` and clears the trace request, then returns. Its comment addresses a trace looking stalled; a terminal request event is not a canonical terminal state.
- `runGuardedTurn` at line 11189 returns the successful promise result. Its active/idle pause handling is in `catch`, which this path bypasses.
- `supervisor.mjs:3636` likewise invokes `pauseStrandedPlanAfterRequestError` only inside a rejected event-queue promise's `catch`. That guard's active/idle policy existed since `45c57999` (2026-09-18), with later classification work, but it never owns this normal returned result.

This is a missing lifecycle invariant across base agent, v8 wrapper and supervisor, rather than proof that all earlier exception handling stopped working. Durable state, transient `active`, request tracing and supervisor wake ownership are split. An exception-only safety net cannot cover every terminal return by construction.

The existing Run AE test (`role-contracts.test.mjs:574`) checks that a refused review explains its missing `stepId`, then supplies a valid review and reaches a mutation. It tests successful correction, not exhausted correction. Stale-step, immutable-contract and durable review-allowance cases cover other worthwhile paths, but not AM's terminal return.

Preventive consolidation (`ab47531d`, report `PREVENTIVE_CONSOLIDATION_2026-10-22.md`) tested stale-owner result/unwind fencing and same-owner failure controls. Those tests concern who may clean up or mutate state after supersession. They do not prove that every same-owner blocked return pauses a stranded active goal. Its hundreds of related tests cannot substitute for that missing terminal-return case. The report also explicitly left AK pure-validation recovery work plan-only; this audit finds no basis for treating that broader area as completed.

## Diagnostic blind spot

Baseline `run-check.mjs:814` considers only `request.completed` with `outcome=blocked_preflight` or `task_board.status=blocked`. AM's terminal event has neither shape. Consequently its retained `run-check.json` reports `blocked_before_mutation`, `stale_step_tracker_behind_batch` and `no_chat_reply`, but no `silent_blocked_stall`.

The detector regression at `run-check.test.mjs:774` faithfully covers Run G's blocked-preflight shape, plus subsequent wake/pause controls. The composed gate asserts zero silent-stall findings. Those are valid assertions about that detector and scenario, but they are not a general proof that requests cannot leave active goals idle. This is another uncovered sibling case and an overbroad interpretation risk, not evidence of missing AM traces.

## Required closure evidence and claim boundaries

The missing promises should become explicit production-path tests: (a) the exact immutable AM contract plus successful native candidate placement, with stale/failed/admission-only proof still rejected; (b) the exact 402-character review at exhausted validation through the public request/supervisor lifecycle, including after the bounded automatic resume; and (c) a diagnostic fixture for the resulting active-plus-idle terminal refusal, with legitimate pause/wake, busy/unknown native state, cancellation and stale-owner controls where relevant. Baseline negative controls should demonstrate that the new regressions really fail for the observed reasons. Contracts and world-proof requirements must remain intact.

Beyond the exact fixture, centralize the explicit receipt-equivalence policy and terminal-outcome invariant so authoring, grounding, proof evaluation and lifecycle owners cannot silently implement different meanings. A focused matrix of supported aliases and terminal return/throw categories is more informative than a larger count of unrelated passing cases.

Future closeouts should distinguish: exact failure reproduced and fixed; composed offline path verified; native engine path verified; and autonomous goal achieved. Those are separate claims. The historical reports reviewed here generally include these limits and do not claim autonomous red-science success. I cannot audit every earlier conversational assurance from repository artifacts alone; any broader assurance must be corrected rather than defended with suite totals. Run AM remains a failed gameplay trial, even if all new offline regressions pass.
