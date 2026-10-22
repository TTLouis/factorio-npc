# Committed-step self-correction

Owner: /root session01a16167; resumed fix/run-am-receipt-liveness.
Source: aae61149dbde0a6869caeb4b370ed36ce14d8196; freshly fetched published b9574fc4556eafb431f158ebee80fe3f1807a02d.

Problem: valid receipt variants now match, and refusals pause safely, but a review bypasses fresh checkpoint settlement. Mixed receipt/world contracts cannot use fresh settlement, so an already-complete step can still escalate or repeat work. A slightly oversized advisory reason can consume correction rounds despite unchanged valid control semantics.

Acceptance: exact restored Run AM active step advances from its durable verified candidate receipt plus a fresh native drill count, before review or duplicate mutation; ordinary next-step/slice/goal continuation follows automatically. Unmet/unreadable/stale facts, absent/wrong-step receipts, busy/pending work, amendments and replaced owners cannot close it. A 401..800-character otherwise-valid rationale may be clipped to 400 with an explicit trace; unknown keys, invalid reasons, identities, actions and oversized payloads remain invalid. Native proof, immutable plan, exact identity, provider and resume limits remain authoritative. No live trial, provider/Jev calls, push or deployment.

- [x] Exact AM and composed automatic continuation regressions fail on baseline.
- [x] Shared fresh settlement supports durable verified receipts before repeat work/review.
- [x] Advisory-only bounded repair; unrepaired errors retain bounded pause/recovery.
- [x] Negative/fence cases, full offline gates, independent review, payload repin.
- [x] Reviewed local integration and fresh merged checks; owned resources absent.

Evidence: test-results/step-self-correction/. Prior Run AM and prior-fix evidence stay sealed.

## Implemented behavior

The existing fresh checkpoint evaluator now accepts supported combinations of world requirements and authoritative receipt requirements. Receipt facts still come only from the active immutable step's durable runtime-verified ledger; display prose, admission, legacy-adopted evidence and old-step receipts do not gain authority. World requirements are freshly read, native queues must be idle, and pending operations/amendments still prevent closure. Both an executor batch proposal and planner review use the same evaluator and ordinary Plan Tracker close. A batch written for an already-complete step is discarded before admission; execution authors a fresh action for the next step.

Review settlement runs before any review allowance is claimed or planner conversation is resumed. If the checkpoint is already satisfied, no review round is spent. Shared continuation handles in-slice advancement and final slice/goal settlement; slice completion is never user-goal completion by itself. Missing proof and unmet facts use the existing bounded review/correction/resume paths rather than manufacturing success or changing the committed plan.

The wire schema and strict review normalizer still cap rationale at400, now through one shared constant. A deterministic parse-boundary repair clips only an otherwise-valid rationale of401..800characters. It does not change reason, step ID, operations, completion claims, keys or authority. The original response remains input evidence; a request-correlated `executor.review_advisory_repaired` event records original/retained lengths. Malformed/oversized controls remain refused and retain existing correction/resume limits.

Ownership is checked after settlement whether facts satisfy the step or not, and before continuation side effects. Generation, lineage, request, goal, plan/version and original step identity must still match, with only the verified one-step progress advance allowed. `step.reconciliation_superseded` records a stale owner. A deliberately cancelled turn after next-contract failure preserves its terminal paused result; replacement during its final trace invalidates that receipt.

If a newer native task-status read finds running/queued work, or an operation becomes unsettled during reconciliation, review defers to the existing native completion/error callbacks. The turn and trace remain active, with no review allowance spent, planner call, pause or cancellation. `executor.review_deferred` and `request.waiting` record the handoff back to native work. Unknown status is not treated as positive proof of running work.

## Regression scope and proof limits

`step-self-correction.test.mjs` reuses AM's original402-character review, immutable copper-step contract and restored runtime-verified batch21/unit17 state. It verifies automatic advancement and a freshly authored next-step operation with no duplicate drill, review planner call or automatic-resume spend. Other tests cover idle settlement without a completion callback, redundant placement proposals, final-slice settlement, next-contract failure, stale/unmet/unreadable facts, absent proof, busy/pending work, amendments, actor/goal/version/step changes, and replacement during trace writes. The fixture's next action is scripted to exercise controller continuation; it does not prove a native copper layout or autonomous production.

The previous AM refusal-exhaustion fixture now uses an invalid reason while retaining the original402-character rationale, so it still tests the unrepairable fallback rather than demanding that a newly repairable advisory remain refused. The original strict400-character boundary tests remain, and the exact unmodified AM review is exercised through the new automatic continuation test. The old legacy-receipt test now asserts the explicit missing verified-proof diagnostic while preserving its no-completion assertion.

Four selected positive regressions fail against the previous candidate's unchanged NPC-loop overlay: exact review recovery, signal-free mixed-contract settlement, redundant-placement suppression and final-slice continuation. No new engine semantics or live model/Jev trial is claimed; all new behavior is tested offline against recorded/scripted evidence. The frozen historical run remains unchanged.

Independent review found three issues during implementation: unmet settlement could escalate after ownership changed; the active-owner assertion could discard an intentional next-contract pause; and a newer busy native reading could still fall through to review. Each was corrected in source and receives a direct review-path regression. The final reviewer reports no remaining blocker, subject to fresh complete gates and payload verification.

## Verified closeout

Code `19c4c42fbee3c74baf194401faa9b2a1fc62de85`; separate installer repin `5e79c53f1892cc5fd7a761bf5a1d96eb04cd7630`; local integration merge `095eb958571899d52a90f06cd93f7685445ef543`. Installer payload bytes are unchanged, SHA-256 `c026a45de1c1512f1e62dbda673985e7cd494643ff9fe21a6b23817c91803acf`. No push, deployment or live provider/Jev trial.

The reviewed candidate and fresh merged candidate pass3123runtime tests (23added),1346mod tests, TypeScript, Lua/generated-Lua checks, changed-JavaScript lint, nine payload tests, generated-artifact verification and installer syntax. The four selected baseline controls fail as expected. Independent source/test review is approved after all three findings were corrected. Initial fixture/schema mistakes and earlier failed checks are retained in the evidence; the closeout uses `reviewed-all-gates.log`, `merged-all-gates.log`, `merged-package.log`, their exit files, `negative-final.log` and `review.md`.

All22exact owned container names and15captured CIDs are absent, including stopped containers; no task networks/volumes/images, live stack, tunnel or temporary configuration links remain. Shared npc-dev and host source/evidence are retained. The reviewer finished and no background work remains. The five integration historical reports, all293sealed Run AM entries and all39prior-fix evidence entries were re-hashed unchanged. The merged shipped-source tree equals the reviewed task candidate; this final closeout changes documentation only.
