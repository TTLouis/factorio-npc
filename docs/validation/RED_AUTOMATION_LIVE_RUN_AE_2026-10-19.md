# Run AE: copper miner works; furnace placement recovery still stalls

One owner-authorized cold E2E ran on 2026-10-19 at frozen source
`abdcb799ce21bea2905b0e1feb0a5b87db44567a`. It stopped after **9.0256 minutes**
with `controller_paused:guard`, on the first committed step. It mined **3 copper
ore and 10 coal**, but produced **0 copper plates, 0 new iron plates and 0
automation science packs**. The requested automated science throughput was not
achieved or measured.

The new direct-feed observation-closure exception fired twice and allowed further
ordinary reads. The agent placed, fueled and rotated a copper drill, but never
placed its furnace. After one advisory planner review and a same-step handback,
it exhausted its read budget without obtaining a new furnace placement candidate;
a second valid review request reached the existing per-step guard. This does not
prove that the direct-feed layout was physically infeasible.

## Candidate and trial contract

- Source includes code `54f2f18f`, payload repin `128765ed`, merge `021a361a` and
  documentation tip `abdcb799`. The remote integration ref matched the full
  frozen SHA immediately before preparation.
- Exact-head validation was already green: 2,655 runtime tests, 1,234 mod tests,
  typecheck/Lua and payload checks; hosted CI `39260281545` passed all seven jobs,
  with release `39260281576` and Security `39260281371` successful. Those gates
  were not rerun for this evidence-only trial.
- The official `scripts/build-docker-local.ps1 -NoEnvUpdate` built the server.
  Deployment verification compared all 55 installer-enumerated runtime modules,
  the prompt and release manifest, and all 31 native mod files against an
  independent compilation. No mismatches. Runtime and native sources were not
  edited during the trial.
- Image ID:
  `sha256:28bc686455997cd0a045616be7071e62021bab747c3887c189ec4ab215107c20`.
  Unique tag `factorio-npc:run-ae-20261019`; project
  `red-automation-20261019ae`; container `c3670087cc7c` /
  `red-automation-20261019ae-sgluna-factorio-1`.
- The unchanged objective was sent once as raw chat:
  `!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.`
- Construction cap: 60 wall minutes. Weekly live-stop threshold: 7% remaining;
  reserve: 5%. Recorded weekly remaining was 73% before preparation and 72% after
  the run. No allowance reset, corrective prompt, manual resume or second trial.
- Planner `gpt-6.1-sol`, executor `gpt-6-luna`, CLI proxy and dedicated Jev were
  verified without reading `.env`. Preflight model-catalog authentication and
  scripted provider/protocol contracts made zero external inference calls.
- Helper checks passed: 44 Node trial/stop/provider tests, 10 archive tests,
  PowerShell syntax and the fail-closed cleanup-inventory regression. Forty-six
  run helpers were frozen before inference.

## Cold world and autonomous outcome

Cold checks confirmed actor **7**, seed **268342245**, zero humans, speed 1,
empty inventory, no machines, no board or canonical goal, idle native queues,
and zero provider/Jev requests. Starter inventory was granted once before the
objective: eight iron plates, one burner drill, one stone furnace, a pistol and
ten firearm magazines. The fresh goal was `goal_0cy6j2m_1`; the committed plan was
`goal_0cy6j2m_1_p3`.

The first step required ten copper plates and electronics using a direct-fed
starter cell. A later step would reuse the equipment for iron and steam power.
Neither step completed. The native journal records six completed admitted
batches: gather ten coal, walk to origin, walk to the copper patch, place the
drill, supply ten coal to it, and rotate it. Final native state had one drill
(unit 19) at `(-33,-34)`, direction 4, waiting for output space with nine coal
still in its fuel inventory. The furnace and eight starter iron plates remained
in the actor inventory. Zero humans and speed 1 were preserved.

There were **32 provider requests and 32 replies**: Sol 4, Luna 28; **18 Jev
requests and 18 replies**. Provider and Jev error counts were zero. Model output
still incurred one deterministic invalid tool-argument rejection and two
`invalid_planner_review` contract refusals; zero transport errors does not imply
all decisions were valid.

## Observation and placement evidence

All times below are UTC on 2026-10-19, from the structured traces.

| Time | Observation |
| --- | --- |
| 13:49:27 / 13:49:58 | Research-only post-batch facts covered the selected `research_state` family. Both times `observation.phase_kept_open` reported `direct_feed_requires_spatial_facts`, `tools_enabled:true`, and one remaining observation round. |
| 13:49:40 / 13:50:05 | Subsequent ordinary reads executed `getPlacementCandidates` and `getNavigationStatus`, respectively. The first query was around the actor's coal location and returned no copper candidates. |
| 13:51:04 | A later drill-placement read returned 256 legal candidates, five supplied to the agent. |
| 13:51:23 / 13:51:54 | The drill was placed using a candidate, then supplied with ten coal. Native output subsequently reached three copper ore. |
| 13:52:00 | The furnace query used `covers_position:(-33.5,-35.296875)` at the drill's then-current output. It returned zero candidates. Native obstruction samples included `item-on-ground` and the drill. This is a bounded query result, not proof that all layouts were impossible. |
| 13:53:01 | The agent rotated the drill. Its native receipt confirmed direction 0 to 4; later geometry reported output `(-31.703125,-34.5)`. |
| 13:53:43 / 13:53:56 | One advisory `planner.review_round` (`local_recovery_exhausted`, `world_blocker_proven:false`) returned the same committed step with 948 characters of planner notes. |
| 13:54:01 | An attempted tool bundle was rejected because `unit_number` was not a valid positive integer. |
| 13:54:07–13:54:16 | Fresh executor reads obtained inventory, drill location, mining/recipe facts and drill geometry. The numeric observation budget then closed. No post-rotation furnace-placement query executed. |
| 13:54:51 | A second valid advisory review request hit the one-round-per-step bound; the controller guard-paused with `executor_review:local_recovery_exhausted`. |

Four typed observation requests were granted through the existing bounded
missing-fact route, including inventory, resource search and entity status.
These grants alone do **not** establish coverage of the newly changed ordinary
open typed-request path. Its scripted/native evidence remains in the preceding
fix checkpoint. This live run directly corroborates the post-batch closure fix,
but does not establish autonomous direct-feed smelting or the full science chain.

The next offline investigation should examine the recovery sequence around a
drill fueled before its output-covering furnace exists, and how the executor
spends the restored observation budget after planner handback. No recovery or
budget change was applied during this run.

The repository trace checker exited 1 with one
`stale_step_tracker_behind_batch` finding at batch 6 and no parse errors. Batch 6
only rotated the drill; it did not satisfy the ten-plate/electronics checkpoint.
Keeping that semantic step unverified was correct. This checker finding does
not supply evidence of a tracker bug in this run.

## Stop, save and cleanup

The runner classified the guard pause at 13:55:44.255 and issued `!luna stop`.
Fresh supervisor cancellation (`user_stop_immediate`) at 13:55:44.266 and
same-goal operator pause (`user_stop`) at 13:55:44.285 were both confirmed by
13:55:44.594. Intake retry was cleared; native task state was idle with empty
operation and crafting queues. No operator gameplay mutation followed the
starter grant.

The fresh checkpoint was **778,206 bytes**, with native `Saving finished` after
the paired stop. Full ZIP verification passed all **55 entries**. A pristine
copy loaded under exact Factorio **2.0.77** with the active candidate mod, one
benchmark tick and `--network none`; exit 0. Original/copy save hashes matched:
`c858271808ae5fbcbc9d958786c4d854f410f77704e9a529c864302db5514ddf`.

The wrapper exited zero. Its cleanup and a separate parent inventory verified
the absence of owned live/stopped containers, proof containers, project networks,
disposable volumes, the unique image tag, and tunnel PID **50424**. The shared
official-build alias `factorio-npc:local` was retained. Saves, logs and evidence
are retained outside the disposable resources. Run AD (215 files), AC (208), AB
(216), both historical AA/AD reports and all 46 frozen helpers were rehashed
unchanged.

Evidence directory: `test-results/red-automation-live-2026-10-19ae`.
Key records: `analysis/run-proof.json`, `analysis/run-check.json`,
`analysis/retained-verification.json`, `data/logs/e2e-result.json`,
`data/logs/final-save-proof.json`, `native-save-load/`, `cleanup-proof.json` and
`analysis/parent-cleanup-verification.json`. A separate read-only reviewer checked
the raw traces and stop/save/cleanup evidence and approved this report with the
coverage limitations above. The final manifest seals the reviewed evidence.
This is a local validation checkpoint; no runtime change,
push, second live trial or Pterodactyl deployment was performed.
