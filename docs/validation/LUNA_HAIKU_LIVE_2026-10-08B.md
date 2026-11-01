# Luna Haiku live trial B and per-slice continuation accounting — October 8, 2026

## Live trial B (owner go, cheap model)

- Code: `a8610bb5` (step-identity repair merged at `0f337065`). Full local image built with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All 45 shipped runtime modules matched the commit (CR normalized), and the active `control.lua` matched the compiled release.
- Same isolated setup as the first October 8 trial (separate Compose project and data directory, loopback-only ports), model `claude-haiku-5-5` through the owner's CLI proxy (`AI_API_METHOD=local`), Jev enabled, zero connected humans, speed 1, fresh world, declared starter kit only, same red-to-green objective, 45-minute controller limit, no corrective prompts or operator gameplay. The controller now stops only on `request.failed` with `recoverable:false`.

### Result: `request_failed` after 542 s (goal `goal_1ymztes_1`)

- 41 Luna calls over two requests (about 1.90M usage units, 1.14M cached). No provider or HTTP errors.
- Luna committed and executed the whole first bounded slice: all four steps verified (`step.verified` ×4, the last by `plan.step_closed_on_fresh_read`). World at the end: 50 iron plates, 12 copper plates, two placed and fuelled stone furnaces.
- Step identity held: 11 executor replies bound by `stepId` (`executor.step_bound`), 9 used the legacy index rule with the correct index (`executor.legacy_step_index_used`), 0 stale-step refusals, 0 identity corrections. One invented tool name (`neglect_submitPlan`) was refused and retried normally.
- `run-check` exited 1 with one finding: `request_failed_unrecoverable`.

### Failure

The slice closed (`outcome.validated` `verified_final_step_of_bounded_slice`), the planner was woken for the next shelf slice, and `continueFromModMessage` paused the goal with `continuation_limit_10`. The continuation guard compared a request-wide counter (already 14) against a limit chosen by plan status: 64 while the plan is active, 10 otherwise. A completed slice is no longer active, so any slice needing more than 10 continuations could never hand over to the next one.

Evidence: ignored local directory `test-results/luna-haiku-live-2026-10-08b/`.

## Repair (merged `f9a8a627`; unit commits `703ac8b2`, `5ff3a06a`, `e3472217`)

Per-slice continuation accounting:

- The continuation limits (64 active, 10 otherwise) are measured from a slice baseline. The baseline moves only at the plan-slice-completed boundary (`closeOutputSlice`, both slice-close routes), never at an in-slice step close, restage or handoff.
- The reset is progress-gated: the closing slice must have at least one harness-verified deterministic step close and at least one admitted operation batch. Otherwise it is withheld (`no_deterministic_progress_in_slice` / `no_admitted_operations_in_slice`) and the old accounting holds. Progress credits are fenced by loop generation, so work finishing after a reset or actor replacement is dropped (`budget.continuation_slice_progress_dropped`).
- A request-wide backstop of 256 continuations (`REQUEST_CONTINUATION_BACKSTOP`, a chosen default awaiting owner confirmation) pauses with `request_continuation_backstop_256` through the same visible pause path.
- Trace events: `budget.continuation_slice_reset`, `budget.continuation_slice_reset_withheld`, `budget.request_continuation_backstop`.

Executor control schema:

- Delegated executor rounds get their own `submitPlan` definition: `stepId` and `operations` required, optional `chatMessage`, `observationRequest`, `checkpoint`, `semanticCompletion`, `timeReview`; no `plan`, `currentStep` or planner-only fields. The planner definition and planner prompt text are byte-identical.
- The executor's compact-continuation and closed-control prompt variants replace the plan/currentStep answer shape with `stepId` and drop planner-only field guidance (substitutions throw at load if the shared text drifts). Trace: `provider.executor_control_contract`.
- Legacy plan/currentStep replies still parse and bind by the index rule. A `{"submitPlan":{...}}` content wrapper is accepted when it names a `stepId`.

Gates on the merge: `bash scripts/test-local.sh all` exit 0 — runtime 1,928 pass, 0 fail, 0 todo; mod 1,045 tests in 120 files. No installer payload change.

Independent review found no merge blockers; its should-fix items (generation fence, admitted-operation gate, remaining planner-only executor wording, wrapper check, final-close credit) were applied in `e3472217`.

## Limits and follow-ups

- Not yet live-validated.
- The base system prompt (`prompt.md` / runtime reliability guidance) still describes plan/currentStep to every role, and compact executor rounds drop the `[ROLE: EXECUTOR]` suffix. Changing either is a prompt decision for the owner.
- The `verified_final_step` memory-close progress credit has no dedicated test.
