# Goal pursuit experiment: budget checkpoint

Owner checkout: `D:/SideProjects/airi-factorio-npc/goal-pursuit-harness`,
branch `experiment/goal-pursuit-harness`. Do not modify other worktrees.

## Authorization and accounting

The original handoff is
`D:/SideProjects/airi-factorio-npc/GOAL_PURSUIT_EXPERIMENT_HANDOFF_2026-10-10.md`.
Read it and this checkout's AGENTS.md before resuming. The original five-hour
allowance stops at 61% total used, with checkpoint due at 56%. Usage on this
resume began at 51%, then measured 53% and 56%; weekly usage was 45% at the
checkpoint. The original window still resets at 2026-10-10 12:17:08 UTC
(08:17:08 Toronto). A reset does not renew authorization. No reset credit was
used. No experiment provider call or live attempt has occurred.

The single authorized isolated Luna trial remains unused, capped cumulatively
at 30 provider attempts or 20 minutes, whichever comes first. It must not run
until runtime integration, independent review, required Docker/native gates,
candidate commit and shipped-file verification pass. No pushes, PRs, production
deployment, changes to other worktrees, or additional live attempts.

## Preserved implementation and current scope

- `8415a486` is the existing direct-routing checkpoint. It bypasses routing
  overhead but still uses the legacy planner/executor lifecycle. It is not
  the requested pursuit harness.
- Preserved the existing uncommitted `goal-pursuit.mjs` and its tests. These
  implement a separate bounded protocol with revisable strategic notes and
  immutable dispatched operation identities, using the exact native journal
  reconciliation helper.
- Fixed the restart test to keep the fixture's clock, added restored budget
  validation, explicit observation-tool whitelist, stale read invalidation on
  restart, unreadable/unowned native work holds, cancellation of a provider
  ignoring AbortSignal, and backwards-clock refusal.
- Independent review identified a real replay risk: exact cancelled batches
  can have partial unknown effects. They now retain pending identity and pause
  instead of being cleared for another decision. Added a regression.
- Review also found idle cancellation was not durable and slow admission/save
  could dispatch beyond the wall deadline. Cancellation now immediately marks
  paused and persists when idle; final dispatch checks the deadline and passes
  it to the adapter. Both have regressions.

This is an unfinished core checkpoint. The module has no production caller.
Do not present it as runtime/provider integration or a verified live candidate.

## Validation and evidence

Docker runtime baseline: 2,080 tests, 2,079 passed, one failed (restart test
mixed fixture time with Date.now and hit the wall budget before the call budget).
Full output: `test-results/goal-pursuit-2026-10-10/runtime-before.log`.

Final `scripts/test-local.sh all` Docker gate: exit 0; 2,090 runtime tests
passed, 1,045 mod tests across 120 files passed; typecheck, Lua build and
generated-Lua check passed. Full output:
`test-results/goal-pursuit-2026-10-10/static-all.log`, SHA256
`23f79c716f67d14d219d7a652aba2def43725a643a81e110ff3219cee79374bc`.
Local evidence remains in this checkout. No real-engine lane was run at this
unfinished checkpoint; native runtime integration is still missing.
The sandbox initially denied Docker pipe access; the required tests ran with
approved access. No package command was run on the Windows host.

Independent reviewer `/root/pursuit_invariant_review` reviewed the core and its
reconciliation dependencies read-only. All three corroborated blocking findings
were fixed. The bounded re-review reported no remaining blocker in the unwired
core, explicitly excluding runtime/provider integration and adapter deadline
enforcement. The reviewer made no edits and called no providers. This is not
approval of a runtime candidate or live trial.

Shared usage after fixes and review was 58% (five-hour), 45% (weekly). Work now
closes at the durable checkpoint; remaining headroom is reserved for closure.

## Remaining work in dependency order

1. Finish opt-in runtime/provider integration. Keep legacy behavior unchanged.
   The current provider transport imposes legacy plan/control normalization;
   it needs an explicit pursuit protocol, bounded structured decisions and
   usage/latency capture. Do not use interactionRouter as an undocumented
   workaround. Persistent provider/campaign reservations must survive new
   turns, restaging, failures, restarts and the live run's process lifetime.
2. Implement trusted native adapters: authoritative actor/status reads,
   deterministic owner predicate, bounded observation tools, native physical
   preflight and protected/reserved/player asset permissions, exact correlated
   dispatch, atomic durable saves and trace logs. Generic adapter callbacks in
   the core are a contract, not evidence that permissions are wired.
3. Wire event/receipt/condition wakes, stop/resume/replacement behavior and
   restart reconciliation. Native actions must continue during provider awaits.
   Never clear uncertain effects to make progress. Add integration regressions,
   including retained October 8 blocker evidence with realistic reply sizes.
4. Run all Docker checks and the appropriate bounded real-engine lane. Obtain
   independent review of the integrated path. Freeze a clean candidate, handle
   installer payload pin requirements, and verify all shipped runtime/mod files.
5. Only then run the single authorized fresh-world red-to-green trial with
   isolated project/data/loopback ports, zero humans, declared starter fixture,
   exact owner predicate and native mechanics. Retain actual call/token/latency
   and world-state evidence. No extra retry, takeover or corrective prompt.

Repository source inspection confirmed that legacy `preflightOperations`
already fences actor identity and uses native preflight, while the legacy
admission path has additional grant/protected-asset checks. Reusing only the
operation renderer does not establish permission preservation. The reviewer
must review integration again after it exists.
