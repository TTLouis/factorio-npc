# Run AG: a batch receipt falsely closes the iron step

Claude fixed all ten lint errors in `31338b7a`, published with payload repin
`2bad40672e2a6d4a057a6ca748ffbf5eae41739d`. One owner-authorized cold trial ran
on that published Jev SHA for **19.5414 minutes** on 2026-10-20. Gameplay
acceptance **failed**: 30 copper plates were produced and collected, a burner
drill produced two iron ore, but there were **zero new iron plates and zero
automation science packs**. No power network or throughput measurement ran.

The parent ended the run after verifying a false step completion and idle active
goal. The final runner result `controller_paused:operator` records that stop;
it is not an automatic terminal, usage-floor exhaustion, or a successful goal.
The runner, save/load verification and cleanup all exited zero.

## Candidate and gates

The source is the Jev branch, frozen at `2bad4067`. Claude's separate
`fix/placement-candidates-clear` work was unpublished and excluded. The lint
correction was reviewed as behavior-preserving. No runtime changes or pushes
were made by this E2E session, and `main` was untouched.

- [CI 39432352478](https://github.com/TTLouis/factorio-npc/actions/runs/39432352478):
  all seven jobs passed, including lint, quality and deterministic Factorio.
- [Package 39432352546](https://github.com/TTLouis/factorio-npc/actions/runs/39432352546):
  package smoke passed; optional native integration skipped.
- [Security 39432352548](https://github.com/TTLouis/factorio-npc/actions/runs/39432352548):
  CodeQL passed; push-inapplicable dependency review skipped.
- Local standard Docker gate: **2,824 runtime / 1,249 mod**, typecheck, Lua build
  and generated-Lua checks passed. Adapted helpers **44/44**, archive tests
  **10/10**, and fail-closed cleanup-inventory tests passed.
- Official pinned builder used `-NoEnvUpdate`, no restart, no forced pull/cache
  bypass. Image: `sha256:cc94f2e3c8c5402700cf36d5a45b6cbd3b8386f28b9113f23e14a24612e71dc7`.
  All **57** installer-enumerated modules, packaged prompt/release manifest and
  **31** independently compiled mod files matched. Forty-six helpers were frozen.

The earlier 14-lane gate on `ed15caca` remains separate historical preparation
evidence. The exact corrected SHA's hosted native gate and local checks above
are the gates for this trial.

## Trial identity and native outcome

Run `red-automation-live-2026-10-20ag`; project `red-automation-20261020ag`;
actor **14**, seed **1042957363**, goal **`goal_1kkn9ii_1`**. Preflight proved
zero humans, speed 1, empty inventory/board/queues, no prior goal and zero
provider/Jev requests. The existing starter was granted once. One raw objective:

`!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.`

Verified roles: CLI-proxy planner `gpt-6.1-sol`, executor `gpt-6-luna`, dedicated
Jev. There were **52 provider requests and 52 responses** (Sol 6, Luna 46), no
provider errors; **36 Jev requests/exchanges**, 34 parsed responses and two
fallbacks for cancelled/superseded observation-family decisions. Thirteen native
batches were admitted. Weekly remaining was 98% initially and 97% during the run,
well above the unchanged 7% live-stop and 5% reserve. Construction cap was 60
wall minutes. There was no corrective prompt, manual resume, allowance reset or
second trial. The parent-directed stop is the only intervention after starter.

Coal 12 was gathered. The copper step over-gathered ore before self-correcting
and collecting furnace output; electronics was verified. The furnace was then
recovered into inventory, and drill **30** was placed and fueled on iron.
Final inventory: furnace 1, coal 6, starter iron plates 8, copper plates 30.
Production: copper ore 30, copper plates 30, coal 12, iron ore 2, new iron
plates 0, red packs 0. The furnace was still held, so direct-feed iron smelting
was never established. Powered production and sustained throughput are unproven.

## Confirmed P1: batch-action proof is promoted into semantic completion

The committed final step required **inventory iron-plate >=58 AND steam-power
researched**. At **14:29:39.430 UTC**, legacy evidence `evidence_30` recorded
native batch **13**, `supply_entity`, moving three coal into drill 30. Its
`deterministic_verification` summary said `verdict: verified_complete`, with
semantics explicitly proving that the **batch action** had finished.

At **14:31:00.336 UTC**, duplicate-observation recovery entered `recoverPlan`.
`latestDeterministicCompletionEvidence` (`npc-agent-loop.mjs:2735`) checks only
the last board evidence kind and parsed verdict. The shortcut at line **16793**
also checks that the current board step is the last step, then sends
`verified_complete` / `recovery_final_completion_proven` to outcome authority.
It does not evaluate the current step's inventory/research contract or the
separate science goal.

At **14:31:00.356**, durable state recorded `STEP_COMPLETED` and `PLAN_COMPLETED`.
At **14:31:00.370**, `planner.skipped` reported deterministic recovery close.
The source returns “The requested goal is verified complete” and sets the loop
inactive, while the canonical user goal remains active. A fresh native snapshot
at **14:33:24** still showed only eight starter iron plates, zero iron/science
production, a held furnace and a drill blocked at its output. No further
provider decisions followed the false close.

This is **not old copper-step evidence**: it is current iron-step **action**
evidence being used to prove the whole step. Checking step identity alone would
not fix it. Require fresh evidence that satisfies the bound completion contract;
keep operation completion, step completion, slice completion and user-goal
satisfaction distinct. Recovery must preserve the unfinished step or safely
pause it rather than report completion. A regression should replay a completed
coal-transfer batch on this unmet final step followed by duplicate-read recovery.

Both the helper and shortcut are byte-identical after newline normalization to
Run AF's `b9d96307`. `analysis/source-attribution.json` and paired immutable
excerpts establish that this is a **newly exposed pre-existing bug**, not a
demonstrated regression introduced by the overnight fixes. No fix was attempted
within this single-trial task.

## Overnight-fix coverage and detector limits

One planner review round ran; four executor reviews occurred. Three
model-recoverable auto-resumes reactivated the plan before C7 restage. Scheduled
step-attempt indices were 1, 2, then 1 after native progress; goal attempts were
1, 2, 3. These recoveries allowed drill placement and fueling. Thirteen tool-result
rows carried `reestablished_read:true`. Review notes remained durable, and the
executor addressed drill 30 by exact identity after recovery. Ground-pickup
placement was unexercised: the held furnace was never rebuilt at the drill.

The frozen analyzers scanned 911 behavior rows, 52 provider requests and all
retained segments, with no malformed input. Context references found **zero
dangling references**, including receipt diffs. Lifecycle scanning found zero
configured lifecycle flags. These detectors do not prove semantic completion.
Restage-loss analysis saw nine swaps, six analyzable and three without a later
request. `run-check` exited 1 for one real restage-loop finding plus two
`stale_step_tracker_behind_batch` warnings. The latter are not demonstrated
bugs: recovering a furnace and fueling a drill do not satisfy the iron contract.

The existing trial stop policy continued reporting `controller_running` after
the false completion because the goal remained active and unpaused. The parent
preserved pre-stop state and snapshots and intentionally stopped this verified
acceptance/invariant failure. A future silent-stall/goal-plan-disagreement gate
would make this failure detectable without parent intervention.

## Stop, save, cleanup and evidence

Parent strict stop/save succeeded at approximately **14:34:02 UTC**. The runner
then observed the operator pause and issued its own fresh cancellation and
same-goal operator-pause pair before the final save. Native queues/crafting were
idle and intake retry was cleared. The fresh checkpoint was **568,254 bytes**;
all **55 ZIP entries** passed CRC, and a pristine copy loaded under exact
**Factorio 2.0.77**, network disabled, with all 31 active mod files matching.
Save/copy SHA256: `4c83b1fb4fff8a5bb44ae9aca4d45489d530af2f77b70e42e29d5a4e52f7573e`.

Wrapper completed at **14:35:07 UTC**, exit zero. Independent parent inventory
confirmed owned live/proof containers, project networks/volumes, unique image
tag and tunnel **51184** absent. Shared `factorio-npc:local` and evidence were
retained. Only the task checkout's borrowed configuration hard link was removed;
agents did not open or print credential values, and the builder's `-NoEnvUpdate`
preserved the original configuration. The owned CI browser was closed. No
Pterodactyl deployment occurred.

Evidence is under the owned checkout's
`test-results/red-automation-live-2026-10-20ag`: `analysis/acceptance-proof.json`,
`analysis/pre-stop/`, `analysis/parent-stop-reason.json`, combined/raw traces,
detector outputs, stop/save/load proofs and parent cleanup verification. The
owner-requested passive subagent's independent chronology and corroboration are
under `overwatch/`; it issued no runtime/RCON/provider or cleanup commands.
The first offline analyzer attempt lacked staging imports; its setup diagnostics
were preserved separately and the analyzers were rerun with the required
dependencies. This was an analysis setup error, not a trial failure.
