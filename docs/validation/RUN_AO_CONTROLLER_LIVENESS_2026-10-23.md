# Run AO: stale prediction and unpaused controller recovery

Owner/session: Codex /root 01a16167. Task `fix/run-ao-controller-liveness`.
Source: `d33e9697dab4b96cbaebf21c8d551822d941dabb`; published Jev head checked
at task start: `b9574fc4556eafb431f158ebee80fe3f1807a02d`.

Failure: transient provider timeout and auto-resume replaced the request owning
an already-authored prediction. Native batch **24** transferred **34** iron
plates; verified step completion advanced to P6 step 2. Rejecting the old
prediction incorrectly cancelled the fresh activation. The native completion
callback never scheduled its next wake; the supervisor ignored expected
cancellation and polled only condition waits/authorization. Run AO stayed
unpaused and idle for 1,764.065 seconds. Its sealed raw evidence remains read-only.

The earlier tests proved stale results could not bind; they did not compose old
prediction, transient recovery, native completion, verified close and a fresh
activation. A same-step in-flight contract promise also lacked owner identity.

Requested outcome: distinguish advisory and activation ownership, preserve JIT
fallback, and add deterministic supervisor detection plus bounded recovery for
unpaused controllers with no owned wake. No live trial/provider, push/deployment,
plan redesign or accelerated controller is authorized by this repair.

The October 23 accelerated rules and prepared guide at
`docs/e2e-tick-sprint` / `3a3e307d` were reviewed. They require an unimplemented
native guard, serialized restoration barrier, host watchdog and native proof.
Acceleration cannot repair missing wakes. This task keeps normal 1x semantics;
it does not adopt the accelerated profile or modify a frozen run.

Acceptance:

- [x] Preserve exact AO plan/contracts/transfer/trace; fail unchanged baseline
      because of the stale-prediction defect, not a missing new API.
- [x] Old advisory owners fall back JIT only for a separately verified current
      activation; replacements during awaits/traces cannot bind or pause it.
- [x] Inject a residual missed wake through the real supervisor lifecycle;
      detect authoritative idle, reconcile and automatically continue without
      replaying the transfer or an operator prompt.
- [x] Cover native busy/unreadable/uncertain effects, real in-flight work,
      conditions, amendments, cancellation and actor/goal/step/request changes.
- [x] Persist bounded recovery expenditure before action; demonstrate restart,
      duplicate probes and explicit guard exhaustion without renewing limits.
- [x] Checker catches original stale-contract idle shape and recognizes a
      corrected continuation. Assert correlated diagnostics.
- [ ] Independent review, offline gates, payload repin and merged checks pass;
      preserve original evidence and clean all owned Docker resources.

## Harness ownership and bounds

`ensureActiveStepContract` owns current-activation binding and owner-specific
in-flight calls. Discarding old advisory output permits JIT only for a new request
lineage carrying the same immutable goal/plan/version/target. Owner checks fence
native reads, reserve, provider processing, validation, diagnostic writes and
receipt settlement. An unreadable status remains a failed call with a visible
guard pause; it is never silently converted into stale cancellation.

The supervisor's serialized queue owns the liveness detector. Retained `active`
or trace flags are not work. Real turns/callbacks, contract flights, queued events,
condition waits, amendments and persistent native controllers fence recovery.
After 20 seconds without such work it probes at most once per 10 seconds (three
native reads per probe, plus fresh owner validation at recovery/pause boundaries).
It requires permitted actor/epoch, idle finite queues and affirmative persistent
status. Busy, unavailable or malformed native status grants no recovery authority.
Unsettled or uncertain effects pause without replay. Active persistent controllers
remain outside this finite-controller missing-wake repair.

Recovery expenditure is persisted strictly before restage or execution: two
attempts per canonical plan/version/step and six per NPC/goal. Restart, restage,
slice changes and duplicate timers cannot refill it. The ledger holds at most
128 goal records and fails closed on capacity or malformed restoration. Recovery
uses ordinary authoritative reconciliation/C7 resume and admission. Only a real
acknowledged next batch, verified step/goal transition or durable wait establishes
continuation; a restage alone records failure and consumes the allowance.

## Reproduction and validation

The fixture contains the complete recorded canonical planning state, Goal,
Roadmap Shelf, plan history, exact pending contract response and batch-24
34-plate transfer. Native scheduling is simulated; the actual strict AO receipt
is replayed with the simulator's tick. The subsequent stone-gathering response is
explicitly scripted and is not presented as AO's historical model choice.

An immutable `git archive` of d33e9697 plus only the fixture/helper/test reproduces
the original `stale_handoff_reply` stack through `applyStepClose` and also proves
the old checker missed the incident: **two expected failures**, exit 1, retained
in `test-results/run-ao-controller-liveness/baseline.log`. The fixture uses existing
baseline APIs; neither failure is an import or missing-method error.

The repaired full-loop replay binds the next contract JIT and admits the next
batch without repeating the transfer. An injected residual stale rejection after
verified close is swallowed by the real supervisor callback as in AO; its ordinary
poll detects the unpaused idle controller, spends one durable attempt, reconciles,
rebuilds the executor and admits the next batch. Separate tests prove persistent
follow occupancy, real blocked provider occupancy, request/goal/epoch/stop races,
receipt/JIT/trace races, strict persistence failure, step and goal exhaustion,
memory restoration, uncertain effects and checker false-positive controls.

Candidate gates: **3,225 runtime tests; 1,346 mod tests; TypeScript, Lua build,
generated-Lua check and changed-runtime ESLint pass**. There are 59 new named
regressions. The independent reviewer required four fixes (persistent occupancy,
receipt callbacks, JIT side-call ownership, checker supersession) and approved the
final reviewed file hashes. Earlier failing/debug logs remain retained.

Evidence is outside historical AO: `test-results/run-ao-controller-liveness/`
contains baseline/candidate/merged logs, independent review, scripted prevention,
residual recovery and exhaustion traces/outcomes, and final machine-readable
summary. The original AO seal was rechecked: 241 files / 45,596,444 bytes,
manifest SHA-256 `6927ff8a699dedb5067e084179176dd83a55ba4f62eab4c2fdc01d88f0963528`.

No Factorio mechanics changed and no new native gameplay, provider/Jev call,
accelerated run, publication or deployment was performed. Autonomous red-science
output remains unvalidated. Candidate review/offline gates are complete;
payload repin and local integration closeout follow in separate commits.
