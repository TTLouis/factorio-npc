# Luna Haiku live trial C — October 8, 2026

## Setup (owner go)

- Code: `2281bd1f` (per-slice continuation accounting and executor `submitPlan` schema merged at `f9a8a627`). Full local image built with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All 45 shipped runtime modules matched the commit (CR normalized), and the active `control.lua` matched the compiled release.
- Same isolated setup as trials A and B: separate Compose project and data directory, loopback-only ports, model `claude-haiku-5-5` through the owner's CLI proxy (`AI_API_METHOD=local`), Jev enabled, zero connected humans, speed 1, fresh world, declared starter kit only, same red-to-green objective, 45-minute controller limit, no corrective prompts or operator gameplay.

## Result: `controller_paused` after 1,023 s (goal `goal_128ds1s_1`)

- 47 Luna calls (about 1.94M usage units, 0.98M cached) and 54 Jev calls. No provider or HTTP errors.
- Two full bounded slices completed, then one step of the third: 9 `step.verified`, 2 `outcome.validated` `verified_final_step_of_bounded_slice`. Research reached by the end: `automation-science-pack` (red science unlocked). World at the end: 130 iron ore, 22 iron plates, 10 copper plates, an unplaced lab, two stone furnaces.
- Step identity: 23 executor replies bound by `stepId`, 0 legacy-index replies, 0 stale-step refusals. `provider.executor_control_contract` on 41 executor rounds.
- Per-slice continuations worked at the hand-over that stopped trial B. Slice 2 closed with `budget.continuation_slice_reset` (`slice_verified_deterministic_progress`, 9 continuations, 4 deterministic closes, 7 admitted batches) and slice 3 was committed. Slice 1 closed in a fresh wake request with `budget.continuation_slice_reset_withheld` (`no_admitted_operations_in_slice`; that request had used 1 continuation, so nothing was lost).
- `run-check` exited 0 with no findings (a recoverable pause is not a finding).

## Pause

1. The planner committed slice 3 (`goal_128ds1s_1_p5`) as: mine 100 iron ore (deterministic), "Smelt the mined iron ore and the held copper ore into plates for 75 automation-science-packs" (declared **semantic**, rationale "observed via furnace inventories and held plate counts"), then craft packs and research `logistic-science-pack` (deterministic).
2. After step 1 closed, the executor tried to insert ore into furnaces under the semantic step. `validateStepCompletionDeclarations` refused it: `semantic_step_cannot_mutate` ("semantic assessment steps permit observations only; world changes require a new authorized deterministic step").
3. The executor then reported `BLOCKED` with `operations: []`, correctly stating the step was not complete. The blocker had no authoritative evidence (`world_blocked_without_authoritative_evidence`), so the goal paused as `recoverable_provider_failure:provider_reported_blocker`.

Root cause: the planner can declare a world-changing step semantic and the commit accepts it; nothing in the planner-visible contract says semantic steps are observation-only, and the executor has no route back to the planner for a step it cannot execute.

## Also found

- Executor schema regression (code reading, no live hit): bound executor replies carrying `semanticCompletion` keep no `currentStep`, and the executor schema no longer offers one, so the existing "close the semantic step and act on the next deterministic step in the same reply" route (`declaredTransition` / `explicitNextStepClaim`, both requiring `currentStep === active + 1`) is unreachable for executor replies. A zero-operation `semanticCompletion` close is not affected.
- Slice progress credit is fenced by request generation, so a slice whose work and close fall in different requests earns no reset. Harmless while the continuation counter is per request.

Evidence: ignored local directory `test-results/luna-haiku-live-2026-10-08c/`.
