# Run AH — recovery completion fix and autonomous E2E

**The completion bug is fixed and published on Jev. The factory E2E failed its gameplay objective at the construction cap.** No false goal completion occurred in this trial. The exact affected recovery path was not exercised live; the direct regression proof is the original-source failing fixture versus the passing fix.

Candidate: `2a90c8e07219d7c624114d64b2dcf3a22a4d0075`, branch `experiment/jev-agent-architecture`. Unit `d9af795480f84c892209b46f2378aa14b13b04ca`; separate installer repin `be36b2aa48efc00f5f0adbb09df130aa547facf2`. Published source was independently rechecked after teardown. Stable main was untouched; Claude's separate unpublished placement task was excluded.

## Fix and checks

Run AG had promoted batch 13's coal-transfer receipt into completion of an iron-production/research step and the whole plan. A successful batch proves its operations finished, not the semantic step or user goal. The fix removes recovery's unscoped completion-authority shortcut. Existing fresh-world step checkpoints and separate goal satisfaction gates remain authoritative. Recovery now records request-correlated `recovery.batch_proof_not_goal_completion` diagnostics when it encounters batch proof.

The two new regression fixtures cover final-step batch proof and a same-step supply receipt against a committed iron/research contract. Both fail on original `2bad4067` with false `completed`; both pass on the fix. Existing valid-completion and unmet-goal continuation coverage also passes. A separate reviewer approved the actual diff.

| Gate before the live objective | Result |
| --- | --- |
| Candidate and merged standard offline Docker gate | 2,825 runtime / 1,249 mod tests; typecheck, Lua build and generated-Lua check passed |
| Changed JavaScript ESLint | Zero errors/warnings |
| Installer generation, check and tests | 9/9 passed, separate repin commit |
| Exact-head [CI 39443433221](https://github.com/TTLouis/factorio-npc/actions/runs/39443433221) | All seven jobs passed; deterministic engine job 7m26s |
| Exact-head [package smoke](https://github.com/TTLouis/factorio-npc/actions/runs/39443433184) / [CodeQL](https://github.com/TTLouis/factorio-npc/actions/runs/39443433211) | Passed; conditional non-applicable jobs skipped |
| Run helpers | 44 offline tests, 10 archive tests, cleanup-inventory checks passed; 46 helper hashes frozen |
| Deployment identity | All 57 installer-enumerated modules, packaged prompt/release manifest and 31 independently compiled native files matched |

## One live trial

Owner explicitly authorized this run. Official local builder used the committed, pushed source and `-NoEnvUpdate`; no Pterodactyl deployment. Cold actor **3**, seed **2546891351**, goal **goal_01un879_1**. Zero humans, game speed 1, empty inventory/board and no machines before the approved starter kit (8 iron plates, burner drill, furnace, pistol/ammunition). Exactly one raw automation-science factory objective; no corrective prompts, manual resumes or gameplay actions after the starter.

The cheaper overwatch subagent used `gpt-6-luna`, observed host evidence periodically, and wrote durable notes. It controlled no gameplay or resources and ended after teardown. Its observations were kept out of routine user updates.

Result: `construction_wall_limit_60_minutes`, elapsed **3,611,097 ms (60.18495 minutes)**. The 90-second observation cadence classified the cap at 16:03:22 UTC. The canonical goal remained **active**, plan **p6 EXECUTING**, fifth of six steps active. The final operator pause is the runner's prescribed stop, not gameplay completion.

Native production: **65 iron plates**, **33 copper plates**, 66 iron ore, 33 copper ore, 44 coal, **0 automation-science-packs produced/consumed**. Remaining placed machines were iron drill 13, furnace 14 and offshore pump 15. Boiler and steam engine were still held, not placed; no automated science chain or rate measurement was reached.

The trial made three bounded slice completions and recorded 11 `step.verified` and 23 declined closes (19 target-unmet, four lacking authoritative receipt). Copper and iron production/research checkpoints closed on world-state proof while the broader goal stayed active. There were zero verified-goal completion claims and zero live occurrences of the new recovery diagnostic. This demonstrates non-recurrence and normal gated completion behavior; it does not claim a live replay of the removed shortcut.

## Remaining blocker

At 15:30:20.540 UTC, the executor registered a passive-progress wait for offshore pump **15** to be `working`, while the boiler/engine chain was incomplete. Readings reported `satisfied=true`, `progressing=true`, status 1; the wait held for 900 checks and timed out at **16:00:18.926**. Recovery then registered the same predicate at **16:00:37.780**; it reached 83/900 before the cap. No machines were added during that interval. This is evidence of repeated passive waiting on an incomplete power chain. It does not establish an erroneous native working-status mapping. No follow-up fix or second trial was started.

Whole-run provider totals: **114 requests / 114 responses / zero errors**, with 23 Sol planner and 91 Luna executor responses. Jev: **84 requests / exchanges / parsed responses**, zero errors. Two model-recoverable pauses automatically resumed. No provider request occurred after strict stop submission.

Combined retained/rotated traces contain 5,062 behavior, 417 prompt and 283 decision rows, zero malformed. Context-reference checker: 114 requests, zero parse errors/findings. Configured lifecycle flags: all four zero. Post-run `run-check` correctly remains red with two findings: a three-restage loop at p6 step 5 (C3/C7/C7), and tracker-behind-batch 31. Batch completion is not semantic chain completion; the missing boiler/engine corroborates keeping the step open. Restage report analyzed 15/17 swaps (two lacked an after snapshot), with zero blocker-after-swap findings; its dropped-context metrics are diagnostic, not correctness proof. Native UI retained an older completed assessment slice p5; final canonical state p6 and goal state are the authority.

## Stop, save and cleanup

Strict fresh cancellation plus same-goal operator-pause receipts were confirmed at **16:03:23.268 UTC**, following stop submission at **16:03:22.888**. Fresh checkpoint: **968,792 bytes**, **56 ZIP entries**, split native level chunks 0/1; CRC/archive validation and pristine **Factorio 2.0.77** native load passed. Save SHA256: `91999741954f6aa10acca3890a30e664d75fbbf8ae6f1bd2055372420429600c`.

Wrapper finished at 16:03:40, `failed=false`, Compose down exit 0. Parent independently verified cleanup at 16:04:19: all owned containers (including stopped proof/analysis containers), project network/volumes, unique run image tag and tunnel PID 59552 absent. Task-only ignored config hard link removed. Shared `factorio-npc:local` retained. No external background work remains. Weekly allowance stayed 94–95% remaining during the live trial and was 93% at finalization, above the 7% live-stop / 5% reserve policy.

Evidence is retained under `test-results/red-automation-live-2026-10-20ah/` in the task checkout, including `analysis/acceptance-proof.json`, analyzer outputs, final-save/load proof, cleanup proof and `overwatch/summary.md`. Static/negative-control logs are in `test-results/semantic-completion-proof/`. Historical AG267 / preparation711 / AF236 manifests and every listed file were rehashed unchanged; five protected integration reports were preserved.
