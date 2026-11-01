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
- [x] Lifecycle/fault/negative-control tests and exact2.0.77 native proof
- [x] Independent review, offline/payload gates, local integration
- [x] Freeze source/profile/helpers; AP startup failure, AQ preflight, fresh AR
- [x] Strict paired stop/save/pristine load, full metrics/plans and owned cleanup

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

Native adoption proof: attempt10 passed the complete exact2.0.77 lane, including
real600-tick disconnect fallback, independent RCON wall watchdog below3s, native
craft/smelt/wait progress, threat/damage restoration, synthetic arrival hook,
six-burst exhaustion, and paused reload of an explicitly saved active lease.
The loaded lease remains inert until replicated startup restoration; episode
spending survives, zero-human ticking resumes after explicit unpause, and sealed
construction cannot reopen. Evidence: native-lanes10/tick-sprint/results in the
evidence directory above. Attempt9 caught SIGTERM overwriting the base save; the
negative control now loads its separate named artifact and retains the active
lease assertion. Native compile/type/build succeeded in native-build7.log.

Run AP correction (current checkpoint): the startup claim above was disproved.
AP is invalid for performance/gameplay: unsupported auto-pause config left the
world console-driven. Full report: RED_AUTOMATION_LIVE_RUN_AP_2026-10-23.md.
The owner authorized one fresh follow-up because this was a harness error.
The shared startup boundary now cleanly saves/reloads the replicated paused
world with authoritative settings before quiet-clock proof and any NPC wake.
One fsynced, run/source-bound residual correction has durable attempted,
completed and exhausted states; interrupted/exhausted correction cannot reopen
on restage. Child input forwarding resumes after same-Session engine restart.
Exact AP fixture and actual Session native scenarios cover these paths without
providers/Jev. Final startup gates:3258 runtime/1366 mod, type/Lua/generated-Lua,
changed lint/shell syntax pass; native12 actual-Session prevention/residual continuation/exhaustion PASS; independent reviewer found no remaining blocking source gap.

AQ preflight checkpoint: no trial/goal/inference began. A fresh achievements-
enabled world refused the first Lua command. The prior native saved-world gate
missed this. Shared fixed read-only console confirmation now precedes all native
startup mutations and repeats at most once for the exact empty/known confirmation
reply. Unknown replies fail closed. Native14 creates a genuinely fresh world and
asserts first/reloaded confirmation attempts[2,1], then passes quiet clock,
residual correction and durable exhaustion scenarios with zero inference. Native13
hit the existing tick-cap proof deadline while heavy static tests co-ran; its
failure remains retained, no limit/assertion was relaxed. Native14 ran without
concurrent heavy gates. The final log adds a reason field after native14; its
correlated trace is asserted by the actual Session fixture. Full merged gates,
payload pin and fresh AR freeze remain required. AQ preflight is sealed/cleaned;
RED_AUTOMATION_PREFLIGHT_AQ_2026-10-23.md records its limits. The owner-authorized
fresh goal trial remains unspent and will use distinct Run AR evidence.

Final checkpoint: frozen AR source2f5f5282, native14/focused32/merged3261runtime /
1366mod/type/Lua/generated-Lua/payload9/helper45 gates PASS, independent review
approved. AR ended controller_blocked:canonical_plan in4m30.461s after native coal
mining rejection and unresolved partial-batch effects.6sprints/6restores/1836ticks,
8.278s native logged sprint wall;22.322s estimated1x-equivalent saving, not a measured
end-to-end comparison. No automated science, quantities/ledger/production tasks or
reservation construction proved. Strict stop/save/ZIP55/pristine2.0.77load/owned
cleanup PASS; a post-stop sealed-authority alarm remains visible. Reports AP, AQ
preflight and AR, complete actual plans and metrics, raw seals and overwatch retained.
No further provider trial, push/deploy or background work. Evidence is retained.