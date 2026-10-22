# Run AM receipt and blocked-decision follow-up

Owner: Codex /root session01a16167. Branch fix/run-am-receipt-liveness.
Source: 01ec0a1015eb76320a4b061ae2dba397d7c761f7; published b9574fc4 freshly fetched.

Run AM built copper drill17 through place_candidate but its committed step demanded a place_entity receipt. Later a 402-character plannerReview rationale exceeded the already-aligned 400-character schema/runtime bound. Exhausted validation returned blocked_before_mutation without a durable pause, leaving active canonical work + idle native queues until the hour cap.

Acceptance:
- Exact preserved AM checkpoint + verified candidate receipt and fresh entity_count satisfy placement, with no contract rewrite or duplicate building.
- Missing/stale/unverified/wrong-step proof or unmet live world counts never complete that step; exact operation-specific requirements remain distinct.
- Exact402 review remains invalid and corrections stay bounded. Exhaustion on an idle owned committed step produces a visible durable classified pause; existing supervisor resume limits survive restart and eventually exhaust visibly. Busy/unknown/pending/stale/superseded work is untouched.
- Audit prior fixes, tests and validation claims against history; distinguish covered defects, missing sibling paths and unsupported claims. Independent review, Docker gates and local integration only. No live trial, provider/Jev call, push or deployment.

- [x] Reproduce both AM failures with negative controls on exact baseline.
- [x] Central explicit receipt-variant rule, preserving raw names and native effect verification.
- [x] Reconcile returned blocked decisions into durable pause at an idle ownership fence.
- [ ] Exact/composed/boundary regressions, full offline gates, payload repin.
- [ ] Recurrence audit, independent review and local merged verification.

Initial checkpoint: fixture extracted from sealed AM without changing historical evidence. Parent owns source; audit agent reads history independently.

## Changes and evidence boundaries

`operationReceiptMatchesRequirement` is shared by checkpoint grounding, frozen-batch deferral diagnostics and completion evaluation. A strictly verified `place_candidate` satisfies generic `place_entity`; the reverse is false. Other operations sharing a native task type remain distinct, including whole construction plans. Raw receipts and frozen contracts retain their original names. Fresh world counts and existing same-step native verification remain necessary.

Exhausted review validation passes its structured error code to the returned-blocked terminal boundary. Owned committed work pauses only after a fresh native idle/empty-queue reading and actor/epoch validation, with no pending operation or active condition wait. `invalid_planner_review` is model-recoverable; other blocked categories use a guard pause. Existing correction and automatic-resume limits remain unchanged. Every asynchronous boundary fences generation, lineage, request object, goal, plan ID/version and active step; a superseded refusal cannot pause, deactivate or complete replacement work.

New traces: `step.receipt_variant_matched`, `request.blocked_plan_paused`, and `request.blocked_result_dropped`, each with request identity and reason. The offline stall detector now includes `blocked_before_mutation`, tested against AM's original refusal/classification/terminal rows.

The recorded receipt replay restores AM's pre-stop memory and native batch21/unit17 into the real v8 completion path. The refusal replay preserves the original 402-character rationale and submitPlan transport, rebinds only the generated step ID, and uses an independent unmet inventory predicate so the repaired placement cannot mask the second defect. It drives the real agent, Session activity, bounded resume timer and persisted allowance. Boundary tests check 399/400 accepted and 401/402 rejected by both schema and runtime; busy/unknown/pending and cancel/actor/goal/version/step replacement controls remain safe, including the final base-helper status await.

Exact baseline overlays fail all five selected positive regressions: direct receipt matching, recorded frozen step closure, grounding, returned-refusal durable recovery and AM stall detection. This demonstrates the regressions reproduce the defects rather than merely retesting the new implementation. Independent review found and corrected plan-version field naming and a stale refusal's ability to deactivate replacement work; both now have negative controls.

No native mechanics changed and no new Factorio/provider/Jev trial ran. Recorded native evidence plus offline production-path replays establish these bounded repairs; they do not establish autonomous red-science success. AM remains a failed live trial. Sealed historical evidence is untouched.

## Recurrence audit

See [the independent audit](RUN_AM_RECURRENCE_AUDIT_2026-10-22.md). The older AL multi-batch fix was not reverted: it covers a different receipt seam. AM exposed pre-existing sibling paths: physical receipt variants had separate exact-name comparisons, returned failures bypassed exception-only pause guards, and the diagnostic covered an older event shape. Narrow scripted examples and green suite totals were interpreted more broadly than their proof allowed.

Future closeouts must state separately whether the exact regression, composed offline lifecycle, native engine path and autonomous gameplay goal were verified. No one of those substitutes for the others. The shared receipt rule, returned-outcome pause boundary and diagnostic fixture now enforce the specific missing invariants; this is not a claim that every contract or recovery path is proven.
