# Run AB: planner/executor contracts, red automation still incomplete

The owner requested merging `feat/planner-executor-contracts` into Jev and one
fresh red-science E2E. The reviewed integration was published as
`80eaf9e56d6359a1188a30ae3c46f4dc18e11ccb`. One trial ran on that exact release.
It stopped after **40.6362 minutes**, with **zero red science**, when the existing
goal recovery allowance reached 6/6. No automated-throughput measurement began.

## Candidate and gates

- Source feature `ec0cd65f`; reviewed runtime merge `3bc607f4`; separate immutable
  installer repin `5bec9163`; validation/publication checkpoint `80eaf9e5`.
- Integration review fixed selection of a cached skill whose details were absent
  from the rendered planner context. The real-loop regression rejects that choice
  before mutation and delivers every corrected selection to the executor.
- Merged gates: 2,620 runtime tests, 1,234 mod tests, typecheck, Lua build and
  generated-Lua checks; current-config lint and nine installer tests passed.
  Factorio 2.0.77 fresh-topology with `NPC_TEST_ROLE_CONTRACTS=1` and 92 Python
  regressions passed. [Contract validation](PLANNER_EXECUTOR_CONTRACTS_2026-10-18.md).
- Hosted [CI](https://github.com/TTLouis/factorio-npc/actions/runs/39159240760)
  passed in 6m37s, including the 6m32s deterministic engine job.
  [Release](https://github.com/TTLouis/factorio-npc/actions/runs/39159240758) and
  [security](https://github.com/TTLouis/factorio-npc/actions/runs/39159240787) passed.
- Official local build used the pushed source with `-NoEnvUpdate`. All 55 shipped
  runtime modules and 31 independently compiled native files matched; prompt and
  release manifest matched. Eight offline probes exercised actual protocol 3
  planner/executor serializers, open/closed and compact/ordinary. The old
  action-capable planner schema fails the negative control. All 44 JavaScript
  harness checks, ten archive checks and the PowerShell cleanup-failure test passed.

## Trial contract and result

The only objective was:

> Build a fully automated factory producing at least one automation-science-pack
> per game minute from natural resources.

The cold world had actor 18, seed 3882961768, zero humans, speed one, empty
inventory, no board/goal/machines and zero provider/Jev requests. The inherited
starter was eight iron plates, one burner miner, one stone furnace, pistol and
ten magazines. The construction cap was 60 minutes; weekly live-stop threshold
7%, reserve 5%. There were no corrective prompts, operator gameplay actions
after the starter, manual resumes, budget resets or additional trials.

| Evidence | Result |
| --- | --- |
| Goal | `goal_0yxfaqp_1` |
| Provider requests/replies/errors | 118 / 118 / 0 |
| Actual models | Sol 10 replies; Luna 108 replies |
| Jev requests/replies/errors | 86 / 86 / 0 |
| Committed delegations | Two plan slices |
| Gameplay admissions | 38 batches; every admission followed an executor reply |
| Planner review requests / role refusals | 0 / 0 |
| Native output | 95 iron plates, 18 copper plates, zero red packs |
| Final placed factory | One furnace; no deployed miner or power chain |
| Held equipment | Miner, lab, pump, boiler, engine, four poles, seven pipes, 50 coal |
| Stop | Current automatic recovery exhausted, goal 6/6 |

The first slice completed the copper and iron unlock checkpoints. The harness
then returned control to the planner, which committed the lab/steam slice.
The lab and main steam-kit checkpoints closed; installation remained active.
The final native world had red science unlocked, but no powered lab, automated
production chain or red output. The saved canonical tracker is authoritative;
the native board presentation lagged its completed prefix.

## What the delegation design demonstrated

Relevant details were actually loaded. The first copper brief selected
`direct-miner-smelting`; the iron brief also selected `scale-out-production-line`.
The later installation brief selected `steam-power-bootstrap`. The outgoing
executor requests retained the active brief and selected full skill details,
including recovery rounds. This run does not support a claim that the missing
details caused the observed manual behavior.

The planner framed another miner/furnace pair as an optional time-saving
investment with setup costs. It chose to reuse owned machines for bootstrap.
The executor hand-mined ore, supplied the furnace manually, then mined and
replaced that same furnace for iron. The changed entity ID did **not** represent
a second furnace. The burner miner stayed held throughout. Loaded guidance and
strategy consideration therefore did not establish efficient execution of direct
feeding, dedicated cells or final automation.

The two plan handoffs and executor-only admissions are positive live evidence
for role separation. No planner-review request occurred, so the advisory review
route and its replacement/budget fences remain static/native proof rather than
live-exercised capability in this trial.

## Failure boundary and follow-up

Seven requests ended with
`provider_action_omission_repair_failed: unverified_blocker_recovery_exhausted`.
The harness refused unsupported world-blocker claims and used the existing
bounded recovery allowance; it did not grant a new plan or reset the campaign.

At the final installation step, narrow radius-128 water reads returned no samples
in an **incomplete** generated-area search. Unknown chunks were explicitly
reported and `empty_result_is_conclusive` was false. A wider radius-256 read at
20:19:03 UTC found eight exposed-water samples, beginning at `(60,-36)`; an earlier
wide read had also found water. No legal reachable pump/connection geometry was
established. The attempted walk toward `(60,-36)` ended with native
`navigation_unreachable`. A subsequent narrow read again returned no samples,
and pump candidates returned `water_source_not_exposed`, with guidance to explore
unknown area and re-read. Those facts did not prove that no legal water site or
installation strategy existed. The final executor response instead returned
legacy `BLOCKED` prose with `operations:[]`, claiming it could not verify water
or connection geometry. It did not use `plannerReview`. The final request failed,
and the unchanged goal recovery limit stopped the trial.

The next offline investigation should replay this wider-water/narrow-reread and
navigation case, plus the legacy blocked response against protocol 3 review instructions,
preserving evidence, authority and budgets. Separately, compare actual bootstrap
time/cost choices and brief adherence; direct feeding should remain an investment
considered for time savings, not a mandatory layout.

A completion-contract limit also deserves follow-up: the steam-kit prose named
ten spare pipes and 50 coal, while its bound checkpoint checked only the pump,
boiler, engine and poles. That step closed with seven pipes held. This report does
not treat the entire prose inventory promise as verified. The read-only trace
checker also flags restage loops and tracker lag; those are diagnostic leads,
not independently established production defects here.

## Stop, save, cleanup and evidence

The stop at 20:20:24 UTC required a fresh supervisor cancellation and same-goal
operator pause, followed by native idle/empty queues and cleared intake retry.
A fresh **519,592-byte** save passed all **55 ZIP-entry CRCs**. A pristine copy
loaded with Factorio **2.0.77**, the exact active 31-file mod and network disabled,
then completed one benchmark tick. Original/copy SHA256:
`787571e702b90b5bd831a6c5106c894b7f23e131bcb5d98db86999dddd261395`.

The owned Compose project `red-automation-20261018ab`, containers, network,
disposable volumes, unique release image tag and SSH tunnel were removed.
The shared `factorio-npc:local` image alias is retained. The separate native
validation container/image and owned check browser were also removed/closed.
Parent Docker inventories independently confirmed absence. Cleanup inventory
commands fail closed on Docker errors, with an actual-function regression.

Evidence remains under
`test-results/red-automation-live-2026-10-18ab`: **216 files / 42,494,687 bytes**,
manifest SHA256
`7c0cbd4cec1d5c692c3e39e1427ac99f0b5323811b4055b174d998974de43fdd`.
All 43 frozen helpers remained unchanged; helper manifest SHA256
`213e65d2365d6fea99e1eefb1ee88164eaa7004f1cd126ca2673118e69262ab5`.
The historical untracked Run AA report was preserved byte-for-byte. Weekly
remaining at closeout was 79%; no reset credit was used. This single authorized
trial is complete. Autonomous red-science throughput remains unproven.
