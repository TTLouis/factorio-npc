# Run AC: selected supply method respected; planner review ends at a guard pause

One owner-authorized cold trial ran on latest Jev
`b1da8392a5bb4cdef323f013dade3abc8180b2f7`. It ended after **7.5161 minutes**
with **zero red science**, ten new copper plates and zero new iron plates.
The executor honored the committed method and requested advisory planner review.
The handback restored planner context but did not start another planner inference;
the guard pause ended autonomous progress. No throughput measurement began.

## Candidate and trial

The candidate contains the reviewed offline supply-method and review fixes:
[offline checkpoint](EXECUTOR_STRATEGY_REVIEW_2026-10-18.md). Its hosted CI,
release and Security gates were green before the trial. The official local build
used the exact pushed source with `-NoEnvUpdate`. All 55 installer-shipped runtime
modules, prompt/release manifest and 31 independently compiled native files matched.
Eight protocol 3 serializer probes, 44 helper tests, ten archive tests and the
actual cleanup-inventory failure regression passed before goal submission.

The sole objective remained:

> Build a fully automated factory producing at least one automation-science-pack
> per game minute from natural resources.

Cold preflight verified actor 5, seed 319115796, speed one, zero humans, empty
inventory, no machines/goal/board and zero provider/Jev calls. The inherited
starter was eight iron plates, one burner miner, one stone furnace, pistol and
ten magazines. Construction cap stayed 60 minutes; weekly stop/reserve stayed
7%/5%. No corrective prompt, manual resume, allowance reset or second trial ran.

| Evidence | Result |
| --- | --- |
| Goal | `goal_0h4bwdl_1` |
| Provider requests / replies / errors | 19 / 19 / 0 |
| Actual models | Sol 5 replies; Luna 14 replies |
| Jev requests / replies / errors | 23 / 23 / 0 |
| Committed slices / admitted batches | 1 / 8; every admission followed an executor reply |
| Executor review requests | 1, explicit `plannerReview: local_recovery_exhausted` |
| Strategy refusal / legacy-blocker fallback | 0 / 0; neither fallback was exercised |
| Final placed factory | One copper furnace; burner miner still held |
| Native production | 20 coal, 20 copper ore, ten copper plates; zero iron ore/new iron plates/red packs |
| Stop | `controller_paused:guard`, nonresumable controller pause |

## Supply-method adherence

The planner chose explicit `manual_bootstrap` for 20 startup coal and ten copper
plates, then `direct_feed` for the 50-iron unlock using the owned miner/furnace.
Its rationale compared finite bootstrap work, placement/relocation cost and saved
hand mining. Extra cells remained optional time-saving investments. The copper
step did gather ten additional ore after the first ten were supplied, leaving ten
ore held; this trial does not demonstrate efficient material/time use.

All 14 outgoing executor requests contained active execution guidance; selected
full skill details were present whenever selected. The coal and copper batches
used the permitted manual method. At the direct-fed iron step, the only admitted
operations were `wait` and `walk_to_entity` for iron ore. No iron ore was hand-mined
or hand-delivered, and no strategy-refusal intervention was needed. This proves
adherence through preparation and escalation, **not a working direct-fed cell**.

## Review behavior and remaining boundary

At 10:08:54 UTC (06:08:54 EDT), the executor explicitly requested
`local_recovery_exhausted`: iron location, drill coverage and output geometry
were not established in its current evidence, and it said manual ore collection
would violate the committed method. The trace recorded advisory-only authority
and `world_blocker_proven:false`.

A native walking task had completed at 10:08:29 UTC. The next post-batch bundle
contained inventory/research/recipe reads; its selected observation family was
`research_state`. The harness marked that family covered and closed the read
phase. The outgoing executor request had `tool_choice:none`. This sequence
supports investigating whether the selected observation families supplied the
site/geometry facts required by the active brief. It does not establish that the
iron site was physically infeasible or that all local discovery was exhausted.

`context.planner_resumed` followed the review, then a guard-class `goal.paused`
and request completion. **Zero provider requests followed the review.** The
committed plan remained on the same iron step, without a replacement or completed
iron checkpoint. The trial policy classifies a guard pause as nonresumable; it
stopped at the next observation and issued the final operator stop. The context
handback is live-proven; automatic planner review/continuation is not implemented
by this handback alone. This result does not justify bypassing plan authority,
resetting recovery allowances or manually resuming this test.

The read-only trace checker flags a tracker-behind-batch diagnostic after the
walking task. Native walking completion does not establish 50 iron plates or
steam-power research, so that diagnostic is not proof of an incorrect checkpoint.

## Stop, save and cleanup

Fresh supervisor cancellation and same-goal operator pause were confirmed,
followed by idle native operations, empty crafting/operation queues and cleared
intake retry. The fresh **579,452-byte** checkpoint passed all **55 ZIP-entry CRCs**.
A pristine copy loaded with exact Factorio **2.0.77** and the matching active mod,
network disabled, and completed one benchmark tick. Save/copy SHA256:
`6a9c847dd2520324315735d6acc88c37078dec679a1e27ddf12bb95581630a3d`.

Owned Compose project `red-automation-20261019ac`, its containers, network and
disposable volumes, all proof containers, the unique release image tag and SSH
PID 43040 were removed. Independent inventories confirmed absence. The shared
`factorio-npc:local` build alias and evidence/save are retained. All 46 frozen
helpers stayed unchanged; historical Run AB and the untracked Run AA report were
preserved. Weekly remaining was 76% after the trial; no reset credit was used.

Evidence is retained in `test-results/red-automation-live-2026-10-19ac`.
The detailed supply/review comparison is `analysis/supply-review-proof.json`.
Autonomous red-science production and direct-fed iron output remain unproven.

Sealed evidence: **208 files / 11,009,347 bytes**; manifest SHA256
`cebd886cfb787e88430335e3ee1e44210e3552dad7feff6868dd2c46281fba6e`.

Independent review corroborated the raw traces, all 208 evidence files, 46
frozen helpers, save/load and cleanup proofs. The final offline publication gate
passed 2,632 runtime and 1,234 mod tests, typecheck and Lua checks; evidence is
retained separately under `test-results/run-ac-publication`. Runtime is unchanged.
