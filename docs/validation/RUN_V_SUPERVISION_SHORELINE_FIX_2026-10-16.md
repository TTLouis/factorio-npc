# Run V follow-up — tested supervision and water-only exploration

Reviewed code `6fe763b7a8ff2bd72cdd1cc757597d07ad97f0ea` is integrated locally
through no-ff merge `1dce938f8a7746004177182e388bbf53e4da5cc9`. No new live
provider/Jev calls, Run V resume, push or deployment occurred. The owner wants
to review the next-trial plan before approving its proposed 60-minute/40%
limits; the broader goal remains paused.

## Supervisor classification and race fix

The external runner and supervisor now share a tested read-only stop policy.
A `model_recoverable` or transport pause remains eligible for bounded automatic
recovery. Diagnostic text such as `unverified_blocker_recovery_exhausted` cannot
make it terminal. Structural active-plan/user-decision blockers, nonresumable
pauses, fresh scoped auto-resume exhaustion, ten-minute uncleared pauses and
existing time/reserve/invariant limits still stop the trial.

The supervisor entry point reads native/trace observations first and canonical
state last, then repeats observation/classification before an automatic stop.
It binds the runner-written trial/goal/actor identity. Regressions replay Run
V's transient pause and clearance, stale exhaustion from other goals/steps,
guard preservation, timer reset, and recovery clearing during a delayed native
read or between terminal checks. A classified stop still needs the existing
paired cancellation, native-idle and final-save fences; RCON acknowledgement
alone is not finalization proof.

## Shoreline finding and bounded correction

Run V's exact radius-128 water read returned zero samples with 72 generated and
nine ungenerated chunks. Coverage was explicitly inconclusive and included
native unexplored chunk centers. No pump-candidate read occurred. The previous
specialized exploration correction required both water and empty-pump facts,
so this sequence fell into generic unsupported-blocker/omission recovery.

A fresh validated incomplete-empty water fact now suffices for the **same
existing plan-category correction**, with unchanged cap and identity/freshness,
mutation, pending/uncertain-effect and actor/epoch fences. A matching pump fact
is optional; foreign-center facts are omitted. The trace retains request/reason
and identifies `water_only` versus `water_and_pump` basis. No read, retry or
resume allowance is added. No destination or operation is chosen by the
harness; the model must choose exploration, receive movement completion and
use fresh discovery before placement. The committed result remains unchanged.

Earlier native water samples near (48,35) were outside the later actor-centered
search and were dropped from size-bounded handoffs. That remains a separate
context limitation, not contradictory water physics or a newly fixed hint
retention guarantee. Run V was truncated; no inevitable live outcome is claimed.

## Verification

| Check | Result |
| --- | --- |
| Final merged runtime/staging | 2,481 passed, including six water-only and seven supervisor cases |
| Final merged mod/typecheck/Lua/generated-Lua gate | 1,144 passed; all compilation checks pass |
| Official Factorio 2.0.77, network disabled | Five lanes pass: shoreline-recovery, targeted-water, step-contract, closed-action, normal-observation; 92 Python regressions pass |
| Shoreline lane | Existing paired-pump case and new isolated water-only world both pass |
| Original-runtime static control | All six new water-only tests fail as expected |
| Original-runtime native control | Old paired-pump canary passes; new water-only case fails specifically on missing exploration correction before admitting movement |
| Public next-trial helper wiring | Syntax and 26 existing stop/measurement regressions pass; final policy/entrypoint copies match reviewed source |

The water-only native case traverses real movement, fresh shoreline candidates,
strict placement receipts, physical fluid connections and sole steam power.
Final lab and engine share network 1; engine generation is 1,000 J/tick with
200 steam, boiler water 200, lab energy positive, science stock falls to nine,
and research advances to 0.10367. Zero humans/artificial power; actor identity
is stable. No post-setup teleporting, terrain changes, chunk-generation requests,
item insertion or corrective commands. This proves the bounded recovery path,
not unattended automated red-science throughput.

Tested native runtime and runner bytes match frozen code after CR normalization.
The official image ID is
`sha256:6782f116e0120c04413e0561db3ba9a0115b83fa773806454397ded32792ca31`;
the final test runner is mounted read-only for its clarified control assertion.
Independent review approved source and final positive/negative engine evidence.
No installer payload change or repin was necessary.

Task evidence lives under `.worktrees/fix-run-v-supervision-recovery/` in
`test-results/run-v-recovery/`. `EVIDENCE.md` distinguishes final results from
retained development failures. The 322-file manifest SHA-256 is
`509e3cfeb3a30f896674037ddee63384c73161511c929ad3075d11a627a76ae7`.
Native lane proofs, raw traces and saves are exported; completed owned test
containers were removed. Merged gate logs remain in integration
`test-results/run-v-followup-validation/`. Run V's historical evidence is intact.

See the [proposed next-trial plan](RED_AUTOMATION_NEXT_TRIAL_PLAN_2026-10-16.md).
The public helper preparation still needs final run-ID/save/receipt binding,
release freeze and owner approval before any live objective.
