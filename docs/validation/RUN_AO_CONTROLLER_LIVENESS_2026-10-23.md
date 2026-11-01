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
- [x] Independent review, offline gates, payload repin and merged checks pass;
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
output remains unvalidated.

## Local integration closeout

Runtime commit `bf773cacd05a4a5a34c7285de988e34e0e138209`, separate payload pin
`46a6a653a818f94932aeb96dfe87186519b44305`, local merge
`e19fd0cf018f6b171e8440b955e3d4729ab550af`. Payload source SHA-256:
`320d73da083120e163c9fa6dea3ea2de858a7799cc1558ef376e72e32c2c902a`.
Merged source equals the reviewed/pinned candidate. Fresh merged checks passed:
3,225 runtime / 1,346 mod tests, TypeScript, Lua/generated-Lua, payload 9/9,
generated-artifact check, installer syntax and lint on all changed JS modules.

An additional broad runtime lint sweep has **16 pre-existing no-use-before-define
errors in unchanged tests/fixtures**. The identical sweep on frozen d33e9697
produces the exact same diagnostics, verified in `lint-baseline-comparison.json`.
This broader check is not green; no lint rule or assertion was weakened.

The retained task checkout is
`D:/SideProjects/airi-factorio-npc/.worktrees/fix-run-ao-controller-liveness`;
its ignored `test-results/run-ao-controller-liveness/final-summary.json` is the
machine-readable closeout. Residual recovery records one attempt, one completion,
zero failures and one original transfer. The exhaustion control records two
attempts, two failures, then one visible guard pause. Repeated trace rows are not
counted as additional recoveries. These are scripted harness results, not a new
live E2E result.

All 23 recorded Docker IDs and eight script container names are verified absent,
including stopped containers. No Compose project, network, disposable volume,
test image, tunnel or temporary configuration link was created. Existing shared
`npc-dev` is retained. Five integration historical reports and the 241-file AO
raw seal remain unchanged. The reviewer finished; no background work remains.
The final closeout commit changes documentation only; tested shipped bytes stay
identical. Local integration ownership is released; nothing was pushed/deployed.
