# Unit 19: Run J completed-slice checkpoint recovery

October 15, 2026. Louis requested the Run J fix, a full-loop regression, integration after local checks, and one further CLI-proxy trial toward green science. The next live trial is conditional on the checks below; it has not started at this checkpoint.

## Fix and frozen code

Code/test candidate **`2e24b74f7a718de8b7ec44073c0cde254ea08c0a`** fixes the path that [Run J](LUNA_GREEN_LIVE_RUN_J_2026-10-15.md) exposed. A planner's no-operation `BLOCKED:` reply while the prior slice is COMPLETED now enters existing outcome authority and the one-per-goal fresh-context recovery before compatibility-board mutation or checkpoint persistence. It cannot overwrite completed history or use a nonexistent active checkpoint target.

The bounded planner recovery may author a valid successor as either a batch-bearing proposal or a planner-only draft. The latter still passes declaration validation, goal/turn checks and reducer commitment before a normal executor handoff. The exception is restricted to active-goal fresh recovery at a completed slice or its immediate successor draft. Committing that draft clears in-memory corrective flags, restoring the executor's normal tools; the persisted per-goal recovery claim remains spent. The active-step checkpoint guard, authority checks, retry caps and verified completion gates are unchanged.

Trace `planning.completed_slice_blocker_routed` carries request, goal, completed-plan identity and reason `completed_slice_has_no_active_checkpoint_target`; the regression asserts these fields.

## Full-loop regressions

Five scenarios use the real `Session` queue, player request, native-shaped batch receipts, completion game line, canonical reducer and scripted model/Jev boundaries. Fixture inventory changes only when an admitted fake-world batch completes; no expected stock is injected.

1. A real first slice completes, the next planner returns Run J's exact checkpoint-bearing blocker, bounded recovery submits a batch-bearing successor, its receipt closes the new slice and the finite goal verifies.
2. The same chain recovers with a zero-operation draft, commits it under a new identity, hands it to the executor, admits the executor batch and verifies the finite goal from its receipt and current inventory.
3. A repeated unsupported blocker consumes only the existing recovery, preserves completed steps/goal identity, admits no successor and does not turn into `checkpoint_requires_active_step` or invented steam-power completion.
4. Player stop while the bounded planner reply waits prevents its successor from dispatching.
5. An actor epoch change while that reply waits likewise prevents dispatch.

The first test failed on unchanged production code with **exactly `checkpoint_requires_active_step`** (`unit19-red-runtime.log`), proving the original regression. Both positive paths now reach verified completion; the cancellation/exhaustion negatives remain bounded. Independent read-only review of the final runtime/test delta found no concrete merge blockers.

## Local gates and integration

- [x] Canonical `bash scripts/test-local.sh all` in Docker: **2,358 runtime/staging tests and 1,142 mod tests across 128 files**, typecheck, Lua build and generated-Lua checks; exit 0 (`unit19-all.log`). No failed/skipped/TODO runtime tests.
- [x] Independent final review; no concrete merge blockers. `git diff --check` passed. Installer payload source/copy list is unchanged, so its bootstrap pin remains valid.
- [ ] Frozen-candidate native recovery-loop, production, craft-trigger, native-admission and steam-lab lanes.
- [ ] Local no-ff integration and canonical full Docker gate on the merged candidate.
- [ ] Push, required local server build and actual deployed-file/cold-world preflight before the newly authorized trial.

Local evidence is retained in `.claude/worktrees/unit19-completed-slice-checkpoint/`. Earlier logs preserve the original red replay and intermediate assertion/implementation corrections. This fake-world regression proves orchestration, not Factorio physics or autonomous green science.
