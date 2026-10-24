# Run AS: next bounded harness patch

Status: **implementation-ready proposal; no implementation in this pass**.
Owner direction: consolidate first and prepare the next patch. Future implementation
starts from the consolidated Jev candidate, not a retained task branch or `main`.
Do not create the implementation branch until that work begins; use one
`fix/run-as-entity-refresh` branch/worktree after checking the shared registry.

## Inputs and dependencies

- Executable baseline `cdbc95eda101e6c2f559c0e2848bcaa923df1be6` and the
  [fix inventory](validation/FIX_CONSOLIDATION_2026-10-23.md).
- [Exact AS report](validation/RED_AUTOMATION_LIVE_RUN_AS_2026-10-23.md), complete
  responses, canonical plan and failure timeline under
  `test-results/red-automation-live-2026-10-23as/analysis/`.
- Goal `goal_0cfa0th_1`, plan `goal_0cfa0th_1_p3` version 1, step
  `goal_0cfa0th_1_p3_v1_s4_0twtp2q`; actor 12, surface 1, furnace unit 19 at
  (55,63). This identifies an exact regression fixture, never a production special case.
- Existing immutable-step/actor/request fences, durable observation/recovery limits,
  operation ledger, finite production controller and ordinary completion evaluator.
  Follow [E2E repair requirements](E2E_REPAIR_REQUIREMENTS.md).

## Unit A — refresh an executable entity binding in the harness

**Failure.** After a context transition, an operation names furnace 19 from durable
context but no current `liveEntityObservations` binding exists. The exact mutation
guard correctly refuses. `handleObservationRequest` also refuses the targeted
`getEntityStatus` request as `entity_not_grounded` unless the entity is live-bound
already or explicitly named in the completion contract. AS's inventory/research
checkpoint has no exact-entity requirement. Repeated model retries cannot repair
that missing shared read/admission path; the guard eventually pauses.

**Owner and consolidation point.** Add one harness-owned identity-refresh path
used by operation validation, targeted observations and finite-production entry.
Keep executable-identity validation authoritative. Reuse current native fact tools
and observation ledger; do not add another prompt, Jev correctness decision,
unrestricted native command, target substitution rule or parallel completion rule.

Proposed transition:

1. Capture exact request, actor/epoch/surface and goal/plan/version/step ownership.
   Retain the committed operation intent and its durable locator as advisory input.
2. At native idle with no pending/uncertain effect, wait, amendment or user stop,
   use an eligible **read-only** locator probe through existing observation budgets.
   A historical number alone never authorizes a mutation. Rebinding requires fresh
   native prototype/surface/position/force and identity facts for the intended target.
3. A still-existing exact entity can regain a current-request binding only after
   that validation. Disappearance, replacement at the same coordinates, ambiguity,
   different surface/force, stale owner or unreadable facts cannot silently choose
   another entity. Preserve any explicit target ownership/reservation restrictions.
4. Refresh actor inventory and relevant machine input/fuel/output through ordinary
   facts. Reconcile previous receipts before deciding further work. In AS, ten
   copper plates already exist in the furnace; a replay of the old supply proposal
   could overfeed it. Use the existing finite-production deficit/collection path
   where authority is proven; otherwise return a bounded ordinary decision wake
   with the fresh binding/facts. Do not auto-resubmit an old mutation blindly.
5. Use normal preflight/admission/native callbacks. Completion remains the existing
   checkpoint evaluator. Trace detection, probe, binding, continuation and exhaustion
   with request/goal/plan/step and original/successor operation identities.

The proposed refresh is one bounded attempt per target/rejection episode and must
charge applicable existing observation/recovery allowances. A restage, new callback
or restart cannot renew the same attempt. Final implementation must explicitly map
the durable claim into existing per-step/per-goal limits; a fresh independent budget
or a reset of campaign/provider/no-progress limits is not acceptable. Unproved or
exhausted correction ends in a durable visible guard pause.

Likely affected seams: `npc-agent-loop.mjs` (`handleObservationRequest`,
`parsePlanMessageStrict`, live entity observation and request/context transitions),
existing entity-reference/fact helpers, `production-task-runtime.mjs`, observation
and recovery ledgers. Extract a small shared boundary if needed; avoid spreading
more exception branches throughout the large agent loop.

| Proof | Required acceptance |
| --- | --- |
| Original negative | Exact AS executor replies plus the same durable locator/contract/context sequence fail on unchanged `cdbc95ed` because of the actual two-sided binding refusal, not missing fixture APIs. |
| Prevention | Normal and targeted read paths can obtain the same valid fresh identity under the existing allowance; ordinary exact mutation still refuses unobserved IDs. |
| Residual miss | Deliberately drop the live binding after prevention; drive the real Session/supervisor failure/wake path. Harness detects, probes, reconciles stock, admits only missing work and continues without a model repair promise or operator prompt. |
| Partial production | Furnace output already has the full required amount; collect through normal bounded machinery, do not re-supply ten more ore/fuel, and close the original checkpoint once. |
| Fences | Change owner during every meaningful await/trace: actor/epoch/surface, goal/plan/version/step, amended/stopped request. Include unreadable/ambiguous/replaced targets, player-owned entities, active native queue/follow/crafting and pending/uncertain effects. |
| Durable limits | Duplicate failures and restore/restage spend one logical claim, not renewed allowances. Interrupted claims cannot release uncertain effects. Exhaustion pauses visibly. |
| Diagnostics | Original failure is detected, successful native/step correction clears only after proof, and interrupted/failed refresh remains visible. Admission is not successful recovery. |
| Native | Deterministic Factorio 2.0.77 same-layout collection/rebinding with physical inventory, exact entity/actor correlation and no duplicate supply. A historical save's old epoch must remain refused; use an explicitly labelled new current-epoch fixture. |

## Unit B — classify an expected sprint shutdown boundary

AS retained stop submission at 23:16:00.616Z, fresh cancellation at .657Z, same-goal
operator pause at .685Z, `Sprint construction authority closed` alarm at .917Z, and
idle paired confirmation at .946Z. AR also retained a closed-authority stop alarm.

Review `TickSprintController.boundary`/restore/fail and the supervisor stop lifecycle.
An explicitly sealed same-run stop should produce a normal closed disposition
after confirmed restoration. Unexpected loss of authority, unknown guard state,
an armed/mismatched lease, failed restoration or active unsafe work must still fail
safely. Do not hide faults by string matching, allow new work after seal, suppress
native guard checks, or bypass the fresh cancellation/pause pair.

Regression gates: replay both original event orderings, closure during an in-flight
boundary, active-lease stop, duplicate stop, watchdog/restoration failure, restart
and stale owner. Prove restored 1× and no post-stop inference or admission, and keep
save/native-idle verification after the strict boundary. Report expected closure
separately from actual faults.

## Unit C — consolidate future run accounting helpers

AS's sealed UTC timestamps are correct, but the PowerShell JSON round-trip converted
date strings and produced negative derived build/preflight durations. Analysis
corrected this without modifying raw evidence. Factorio's default release lookup
also failed before inference; the trial required explicit validated version 2.0.77.

Prepare a reviewed reusable run/accounting entry point instead of cloning and
editing another complete run kit. Start with small shared identity, phase-timing,
archive and usage helpers; keep run-specific intent immutable. Use monotonic elapsed
measurements plus explicit UTC strings/`DateKind String`, freeze the validated
Factorio version, and preserve old kits untouched. Test UTC/local/DST/JSON round-trip,
phase overlap, failed build, cancellation, rotated traces and duplicate request IDs.
Unknown model rates/Jev usage remain unknown; this patch cannot invent price mappings.

## Delivery gate and exclusions

Implement A first; B and C are independent bounded follow-ups and must not delay a
correct A with unrelated refactoring. Each unit needs its own source commit,
applicable tests, trace contract and independent review. Then integrate once, repin
the installer payload if shipped files change, and run the required merged offline
and native gates. Keep the source fixed for any future trial.

No new gameplay goal, checkpoint weakening, exact-target substitution, broad new
recovery framework, history rewrite, provider retry, live trial, push or deployment
is authorized by this planning pass. Another E2E requires its own owner instruction.
