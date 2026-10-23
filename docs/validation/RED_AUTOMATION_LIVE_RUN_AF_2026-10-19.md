# Run AF: copper completes; valid iron candidates and review recovery are missed

One owner-authorized cold trial ran on 2026-10-19 at frozen published candidate
`b9d9630701158320cec0c660de2eee8eb764f64d`. It stopped after **7.51825 minutes**
with `controller_paused:guard`. It produced and collected **10 copper plates**,
completed the copper/electronics slice, and committed a direct-feed iron slice.
It produced **0 new iron plates and 0 automation science packs**. The automated
science objective was not achieved and throughput measurement did not run.

Two corroborated gaps remain: the executor described drill placement as blocked
despite eight legal native candidates, and action-omission recovery leaked across
the planner handback into a fresh executor, contradicting its advertised read
budget. No runtime change or second trial was made.

## Candidate, gates and cold start

The candidate contains ground-item placement code `8f1ffcf4` and the corrected
pickup receipts in `10948bf7`, payload repin `bb9a6cb8`, test-only review nits
`f3975f85`, and documentation tip `b9d96307`. Separate source review confirmed
the prior false `failed_before_mutation` blocker was closed, including the
committed real Factorio spill/build, partial-pickup and zero-pickup evidence.
The accepted limitation remains: a mutated failed placement is uncertain and
may guard-pause; this run did not encounter such a placement.

Exact-head hosted CI `39284326976` passed all seven jobs, including the 7m39s
deterministic Factorio job; release `39284326786` and Security `39284327020`
also passed. The prior checkpoint records 2,662 runtime and 1,249 mod tests,
typecheck/Lua, changed-file lint, nine payload tests and native verification.

The official local builder produced image
`sha256:53087faa1e77524ce50bf586a119a574a900249bc3a7516d0f5b62751b48dbfb`.
The prepared image was verified unchanged and retagged for this run after hosted
gates passed. All **55 installer-shipped runtime modules**, prompt and release
manifest matched the candidate; all **31 native mod files** matched an
independent compilation. Forty-six helper hashes were verified unchanged;
44 helper tests, ten archive tests and cleanup-inventory checks passed.
Historical untracked reports were backed up, hashed and restored for the build.
No `.env` values were read or changed.

Project: `red-automation-20261019af`; container `f11c4d2ce7cd` /
`red-automation-20261019af-sgluna-factorio-1`; unique image tag
`factorio-npc:run-af-20261019`; owned tunnel PID **43720**.

The fresh world had actor **15**, seed **996023954**, zero humans, speed 1,
empty inventory, no machines, board or canonical goal, idle queues and zero
provider/Jev calls. The starter was granted once: eight iron plates, one burner
drill, one furnace, a pistol and ten magazines. The objective was sent once:

`!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.`

Fresh goal: `goal_1qrfvw7_1`. Roles were CLI-proxy planner `gpt-6.1-sol`, executor
`gpt-6-luna`, and dedicated Jev. The unchanged limits were 60 construction wall
minutes, 7% weekly remaining live-stop and 5% reserve. Weekly remaining was 71%
before and after the trial. There were no corrective prompts, manual resumes,
allowance resets, operator gameplay mutations after starter, or follow-up trial.

## Native outcome and the three requested checks

There were **28 provider requests/replies** (Sol 9, Luna 19), **23 Jev
requests/replies**, and zero provider/Jev errors. One initial planner reply was
refused as `invalid_execution_guidance` and corrected before commitment; zero
transport errors does not imply every first reply was valid. Eight admissions and eight
native batches completed. The furnace, unit **31** at **(76,7)**, produced ten
copper plates; the actor collected all ten and completed plan slice
`goal_1qrfvw7_1_p3`. It then committed slice `goal_1qrfvw7_1_p4`, requiring 50 new
iron plates, 58 held iron plates total, and steam-power research.

Final inventory: one unused burner drill, eight starter iron plates, ten copper
plates, ten extra copper ore and twelve coal. The furnace remained the only
placed machine. Production totals were 20 copper ore, 13 coal, ten copper
plates, zero iron ore/new iron plates and zero science packs. The extra copper
batch is an observed inefficiency, not a placement or admission failure.

| Requested check | Live result |
| --- | --- |
| Furnace built over spilled ore, with `ground_items_picked_up` | **Unexercised.** No drill was placed, no drill spill occurred, and there were zero nonempty pickup trace records. The existing furnace used manual ore supply. |
| Fresh executor addresses the drill by `unit_number` directly | **Unexercised.** No placed drill existed. Fresh topology did retain furnace 31's ID, and the executor read that furnace by ID; that does not prove the requested drill behavior. |
| No `invalid_planner_review` refusals | **Passed for this run: zero.** Two valid advisory review requests occurred on the iron step. |

## Gap 1: sampled obstructions override valid candidate evidence

At **16:51:17 UTC**, the drill-placement read centered on the furnace area
returned **eight legal iron-covering candidates**, supplying five candidates to
the executor. At **16:52:01**, another read around the actor returned eight
legal candidates and supplied three. Both outputs also contained sampled rejected
footprints overlapping furnace 31. Those obstruction samples describe rejected
positions; they do not invalidate the legal candidate list.

Nevertheless, at **16:52:07** the executor said the observed drill candidates
were blocked by the furnace and requested planner review. It admitted no drill
placement and no furnace relocation. The harness correctly kept
`world_blocker_proven:false`; physical infeasibility is not established.

A useful regression should replay the actual mixed candidate/obstruction output
and executor continuation, checking that legal candidate IDs remain usable and
that rejected-footprint samples are not promoted into a universal blocker. The
cause of the model's selection error is not established by this run alone.

## Gap 2: planner handback inherits an incompatible action-omission limit

At **16:52:07**, the one bounded `planner.review_round` began. The planner's
planning-only, zero-operation reply then entered action-omission repair:
`recovery.action_omission_started` at **16:52:14**. It was prompted to provide an
executable operation despite the planner's planning-only role. A subsequent
reply returned the identical step at **16:52:20**, with **545 characters** of
advisory notes. Committed semantics were preserved.

The fresh executor request at **16:52:21.639** advertised:

- `toolsEnabled:true`, `allow_tools:true`, and `tool_choice:auto`;
- `observation_budget_remaining=4` and runtime-default observation families.

Its response at **16:52:27.043** requested four observations. None executed.
The next request instead contained:

> The action-omission repair permits exactly one targeted observation, but the provider requested 4.

It closed tools with `tool_choice:none`, while the decision envelope still
advertised four remaining observations. The fresh-role handback therefore did
not supply a coherent effective read contract. `handleToolBatch` applies the
session-level `actionOmissionRepairActive` one-read guard; the planner handback
calls `startExecutorAtCommit` and `runTurn` without clearing that recovery state.

At **16:52:34**, the executor requested review again because the geometry reads
were unavailable. The existing one-review-per-step bound caused a guard pause
with `executor_review:local_recovery_exhausted`. This was **not** the accepted
partial-pickup/duplicate-effect pause; there had been no pickup.

Follow-up should address planning-only zero-operation replies and recovery-state
ownership across the role handback, and make the advertised/effective read
allowance agree. Preserve numeric budgets, durable allowances, role authority and
the review bound; increasing or resetting them is not evidence of a correction.

## Stop, save, cleanup and evidence

The terminal classifier stopped the trial at **16:52:50 UTC**. Fresh cancellation
(`user_stop_immediate`) at **16:52:50.469** and same-goal operator pause
(`user_stop`) at **16:52:50.476** were confirmed by **16:52:50.809**. Intake retry
was cleared; native task state was idle with empty operation and crafting queues.

The fresh save was **949,676 bytes**, with native `Saving finished` after the
paired stop. All **56 ZIP entries** passed full CRC verification. A pristine
copy loaded under exact **Factorio 2.0.77**, with all 31 active mod files
matching, one benchmark tick and `--network none`; exit zero. Save/copy SHA256:
`4d3298c5a96c82e30601283396976c409aeb872e8b5c3c5141bac206aa9c6f7a`.

The wrapper exited zero. Wrapper cleanup and a separate parent inventory verified
that owned containers (including stopped/proof containers), project networks,
disposable volumes, unique image tag and tunnel 43720 were gone. The shared
official-build alias `factorio-npc:local`, saves and evidence were retained.

The repository trace checker exited one with a single heuristic
`stale_step_tracker_behind_batch` warning and no parse errors. Batch 8 gathered
coal, so it did not satisfy the iron/steam checkpoint. An unverified semantic
step after that batch is correct; this warning is not evidence of a tracker bug.

Evidence: `test-results/red-automation-live-2026-10-19af`, especially
`analysis/run-proof.json`, `analysis/acceptance-proof.json`, structured logs,
`data/logs/e2e-result.json`, `data/logs/final-save-proof.json`,
`native-save-load/`, `cleanup-proof.json`, `analysis/run-check.json` and
`analysis/parent-cleanup-verification.json`. A separate read-only reviewer checked
the raw traces, source attribution and operational evidence and approved the
report with the coverage limitations above. The final manifest seals the record.
No runtime edit, push, live
Pterodactyl deployment or second trial was performed.
