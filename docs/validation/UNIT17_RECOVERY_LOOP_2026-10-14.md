# Unit 17: composed recovery regressions completed

October 14, 2026. This completes Claude's unit-17 branch from the preserved WIP `d0c78ecd`; it does not authorize run J or claim real-engine/autonomous success.

## Delivered

- Fourteen static scenarios drive the real `Session` event queue, activity hook, player/UI inputs, startup dispatcher and mocked resume timers around `NpcAgentLoop` and canonical memory.
- The composed G→H→I scenario reaches verified inventory/goal completion after a furnace supply conflict, checkpoint-only recovery reply, rejected blocker and collection of machine output.
- New-process objects restore state from disk and preserve plan identity, verified receipts and durable retry counts. The first recovery packet rediscovers fresh output before the executor answers, then the collection finishes the goal.
- Cancellation cases cover stop/UI pause/new goal, actor/epoch changes before fire, and stop while the resumed provider call is pending.
- Unknown effects after reload remain guarded against identical and changed conflicting transfers. A completed transfer with lost acknowledgement and completion notification settles against historical native-shaped receipts, rejects unnecessary replay through fresh checkpoint verification and completes the goal.
- Discovery negatives prove denied reads, actor changes and in-flight work cannot credit unsafe output. The fixture checks unknown RCON commands, unscripted/unconsumed provider replies and activity-listener failures. Trace timestamps strictly preserve emission order instead of relying on distinct wall-clock milliseconds.

The fixture furnace is a deterministic fake, with declared initial stock. Inventory changes occur through admitted operations and explicit simulated smelting; this is not native physics evidence.

## Defects exposed and fixed

Runtime commit **`e1aaf952`**:

1. Restart discarded live machine observations, so unit 15's residual again requested production instead of collecting available furnace output. Genuine C7 recovery with no known crafting machine now performs one actor-fenced nearby scan (radius 32, at most 40 results), retains at most three crafting machines, and uses the existing fresh inventory reads and residual derivation. It does not persist stale exact targets or add model calls. Read denial is explicit; actor-fence failure refuses the handoff; in-flight work skips discovery.
2. Restart reconciliation could prove an operation completed while leaving its pending guard in place. That guard prevented fresh checkpoint settlement and induced an empty repeat transfer. For `runtime_restart` with exact completed evidence, the existing receipt-settlement function now receives the current captured actor and recovery request ID. Its native idle/empty-queue/proven-effect gates remain intact. Unknown effects remain held. Clearing the operation does not itself advance the board or prove the gameplay goal.

New trace events are `context.recovery_machines_discovered` and `operation.recovery_settled`, with request correlation and reasons asserted by tests. Retry limits, pause eligibility, grants, committed plans and accounting policies are unchanged. No scheduler refactor was necessary.

Test completion commit **`a9663f98`** follows the runtime fix. Original composed-test commit `96e0561c` and WIP `d0c78ecd` are retained in history.

## Verification

- Focused unit-17 suite, Docker with the canonical runtime mounts: **14 passed, zero failed/skipped/todo**, exit 0.
- `bash scripts/test-local.sh all` in Docker at the final code/test checkpoint: **2,352 runtime/staging tests passed; 1,142 mod tests across 128 files passed**, plus typecheck, Lua build and generated-Lua checks; exit 0.
- Existing completed-journal startup regression still proves no replay and no manufactured board progress; its assertions were not relaxed.
- Independent read-only review of the full unit and final production deltas found no merge-blocking issues.
- `git diff --check` passed. Installer payload source/copy list was not changed. No provider/Jev calls, native engine lane, server deployment or external publication was performed for this unit.

Local logs in the unit worktree (not committed): `unit17-runtime-baseline.log` retains the original failing TODO, `unit17-focused3.log` records the 14 passing scenarios, and `unit17-all-final2.log` records the final full static gate. Earlier follow-up logs retain the intermediate failures that led to the final fixes.

## Remaining before run J

Unit 18's native recovery-loop lane remains open. The fake furnace does not prove real slot semantics or smelting. The affected native lanes, frozen candidate build/file verification and Louis's live-run go remain outstanding under the [reconciled integration plan](RECOVERY_LOOP_RECONCILIATION_2026-10-14.md). Do not treat this static checkpoint as permission for another live run.
