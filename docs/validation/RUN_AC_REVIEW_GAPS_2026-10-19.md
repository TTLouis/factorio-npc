# Run AC review gaps: read reopen and one planner review round (offline)

Task: `fix/run-ac-review-gaps`, based on Jev `50f099a0944acd16f3c45f6cd3dc2fd64edf20a9`.
The owner asked to fix the gaps from the latest Jev e2e run,
[Run AC](RED_AUTOMATION_LIVE_RUN_AC_2026-10-19.md), and chose the bounded
re-delegate option. This was an offline task: no live provider or Jev calls,
no gameplay trial and no deployment.

## Gaps observed in Run AC

1. **Read phase closed on an incomplete prediction.** The executor walked to
   iron ore. Jev's post-step relevance then selected only `research_state`,
   which the harness can answer with an argument-free read. Because that read
   covered the selection, the harness closed the decision's read phase
   (`post_batch_facts_cover_selected_families`, `tool_choice:none`). The executor
   had no ore-site, drill-coverage or output-geometry facts, so it requested
   `local_recovery_exhausted` review instead of reading them.
2. **Every review was terminal.** `handlePlannerReview` paused the plan with
   a guard pause, restored planner context, and completed the request. A guard
   pause is not auto-resumed, so the goal stopped and no provider call followed.

## Change

- **Read reopen, once per step.** An executor-authored review raised while
  the read phase was closed by post-batch coverage is not sent. That decision
  continues with read tools open, and a harness fact names the families the
  bundle covered. Reviews the harness raises itself, such as direct-feed drift,
  are never reopened. A second closed-phase review of the same step goes to the
  review path. Trace: `observation.phase_reopened_for_review`.
- **One planner review round per step.** A review of a non-BLOCKED plan
  claims a per-step allowance. The claim is durable in the goal state
  (`review_continuation_steps`, reducer event `REVIEW_CONTINUATION_CLAIMED`).
  Only the runtime can make it, and it is capped at
  `MAX_REVIEW_CONTINUATIONS_PER_GOAL` (8) steps per goal. The planner then gets
  one in-turn round: the `[EXECUTOR_REVIEW]` advisory plus a harness fact about
  what that round can do. The round can read. The committed plan and its
  guidance cannot change. An `operations:[]` reply goes through the existing
  `planner.committed_slice_returned` path (reason
  `review_round_returned_same_step`) to a fresh executor, and the reply's
  `chatMessage` is delivered as `[PLANNER_REVIEW_NOTES]`. A second review of the
  same step, or an unavailable planner, pauses exactly as before. BLOCKED plans
  still go only through the replacement wake. Trace: `planner.review_round`.

  2026-10-20 (X-1, after Runs AD to AF): that pause is model_recoverable now,
  so the supervisor's bounded auto-resume (2 per step, 6 per goal) restages a
  fresh executor instead of leaving the goal at a guard pause.

Unchanged: review authority stays advisory, `world_blocker_proven:false`; no
replacement without the existing world-evidence and grant checks; no reset of
fresh-recovery, provider-budget or continuation allowances.

## Evidence

- Scripted full-loop regressions (`role-contracts.test.mjs`):
  - **Planner round.** The Run AC rationale gets one planner round. The plan is
    unchanged, the notes reach a fresh executor, and the executor's action is
    admitted.
  - **Read reopen.** A closed-phase review reopens reads with tools allowed; the
    second closed-phase review of the step reaches the planner round.
  - **Allowance.** It is durable across restore, a model-sourced event is
    refused, and the per-goal cap holds.
  - **Updated tests.** Existing drift, Run AB legacy-blocker and act-or-review
    tests now pass through the planner round and pause on the second review.
- Docker runtime gate: 2,635 runtime tests passed, 0 failed. ESLint passed on
  the changed runtime files.

Not proven: whether a live planner uses the round well, and whether the reopened
reads lead to a working direct-fed iron cell. Both need an owner-approved live
trial.
