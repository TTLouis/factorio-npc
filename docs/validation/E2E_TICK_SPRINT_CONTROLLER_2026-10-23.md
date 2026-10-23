# Bounded E2E tick sprint controller

Owner: Codex /root session01a16167. Task `feat/e2e-tick-sprint`.
Base: `2889b39a492b3c239f5ea492edd3494f7311e643`; freshly checked remote:
`b9574fc4556eafb431f158ebee80fe3f1807a02d`. Approved guide: `3a3e307d`.

Requested outcome: implement and validate the accelerated profile, integrate it
locally, then run exactly one frozen red-science automation trial with Luna
read-only overwatch. No publication or production deployment.

Initial eligibility is deliberately limited to confirmed finite admitted native
batches, including explicit native waits. Producer-only acceleration while a
model request is outstanding is deferred; it grants no eligibility in this version.
Normal construction remains 1x. The accelerated profile leases up to4x,600ticks,
3wallseconds/burst,3600ticks per durable exact-batch episode. All observation,
response, admission, transition, stop and save boundaries restore/verify1x first.

- [x] Native guard, durable limits, safety and independent restoration
- [x] Host barrier/watchdog and authoritative freshness/ownership integration
- [x] Runner/classifier/snapshot/measurement/stop/save/metrics contract
- [ ] Lifecycle/fault/negative-control tests and exact2.0.77 native proof
- [ ] Independent review, offline/payload gates, local integration
- [ ] Freeze source/profile/helpers; one cold Run AP
- [ ] Strict paired stop/save/pristine load, full metrics/plans and owned cleanup

Evidence: `test-results/e2e-tick-sprint/`; later run evidence separate and frozen.
Checkpoint: implementation in progress. No live provider/Jev call yet.

Implementation checkpoint: full Docker gates passed 3245 runtime and1366 mod
tests, typecheck, Lua build and generated-Lua checks; latest focused34 tests and
changed-module lint pass. Additional final merged gates remain required. Review
findings corrected canonical operation ownership, fault-safe stop/pause, native
identity-bracketed refresh, durable600-tick counter validation, best-effort fault
telemetry and honest missing-duration/count reporting.

Accelerated startup now auto-pauses before simulation, performs replicated lease
invalidation and actor/batch reconciliation, preserves episode expenditure, and
unpauses only after guard/ledger initialization. No peer-local on_load flag grants
mutation authority. Native proof is still pending the active-lease reload case.

The native player-arrival control calls the arrival-safety hook directly; source
wiring and per-tick connected-human refusals have separate regressions. This does
not validate real engine join delivery, networking or peer-load synchronization.
Native smelting/crafting, disconnect tick cap and independent real-RCON wall
watchdog have executed in retained attempts. Earlier failed fixture attempts are
retained, including nonexistent player API/console-handler assumptions and the
missing isolated save-directory failure. None called an external provider.
