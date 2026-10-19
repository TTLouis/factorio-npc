# Delegation regression ledger (2026-10-20)

This ledger covers every retained red-automation live run from 10-15n to 10-19af (19 runs; 10-15v was helper preparation only). The goal was to see why delegation keeps the system from automating red science, rather than fixing whichever blocker the last run hit. The ledger is offline work: it reads the retained traces read-only, and the CLI-proxy hostname is scrubbed.

Sources:
- each run's `checkpoint.md`, `analysis/`, `run-check.json` and `summary.json`;
- `data/logs/sgluna-behavior.jsonl` and `sgluna-prompts.jsonl` in `peaceful-saha-a52c6f/test-results/red-automation-live-2026-10-*`;
- the per-run docs in `docs/validation/`;
- `git log` of jev-arch at `c7dae64c`.

Cause classes, from the 10-19 step-back analysis:
1. a fact the model needed was lost at a restage, handoff or conversation swap;
2. lifecycle (pause, resume, auto-resume, epoch, recovery, turn scope);
3. role contract (planner/executor protocol, step binding, review round, checkpoint schema, handback);
0. not delegation (gameplay, mod, geometry, provider transport).

Ownership: class-2 items belong to option C (the lifecycle transition table, session "Delegation changes regressions", branch `test/restage-context-detectors`). Class-1 and class-3 items are fixed here, one unit each.

## Runs

| run | candidate | min | terminal | progress | restages | auto-resumes | reviews / rounds |
|---|---|---|---|---|---|---|---|
| 15n | 77e65f4b | 22.5 | auto_resume_exhausted | 72 Fe / 10 Cu plate | 8 | 4 | none |
| 15o | c0bad249 | 1.5 | proxy ECONNREFUSED | none | 0 | 0 | none |
| 15p | 36958714 | 15.0 | guard step_contract_unavailable | 50 Fe / 10 Cu, steam kit crafted | 10 | 6 | none |
| 15q | e77ed843 | 4.5 | auto_resume_exhausted (step) | ore only | 4 | 2 | none |
| 15r | 8bf6fc15 | 16.5 | auto_resume_exhausted | 50 Fe / 10 Cu, kit | 12 | 6 | none |
| 15s | 7ca69aed | 6.0 | structural blocker (silent stall) | furnace placed | 3 | 1 | none |
| 15t | 4da208b6 | 19.2 | auto_resume_exhausted | 74 Fe / 20 Cu | 10 | 6 | none |
| 15u | 6ceaa2ae | 9.0 | guard provider_response_too_large | 10 Cu | 3 | 1 | none |
| 16v | 4cc7b57e | 24.0 | parent stop on a recoverable pause | 50 Fe / 10 Cu, kit | 4 | 1 | none |
| 16w | 9e00fc5c | 21.0 | auto_resume_exhausted | pump and boiler placed, no power | 11 | 6 | none |
| 17x | ffc0a046 | 14.2 | structural target_rejects_item | 60 Fe / 10 Cu | 5 | 0 | none |
| 17y | 957ebedf | 57.2 | auto_resume_exhausted | 76 Fe / 25 Cu, kit and lab held | 15 | 6 (+4 transport) | none |
| 18z | e86934e2 | 19.5 | blocked unresolved_operation_effect | pump and boiler placed, engine refused | 8 | 4 | none |
| 18aa | 623d695d | 10.5 | blocked unresolved_operation_effect | 10 Cu | 1 | 0 | none |
| 18ab | 80eaf9e5 | 40.6 | auto_resume_exhausted | 95 Fe / 18 Cu, kit and lab held | 13 | 6 | 0 |
| 19ac | b1da8392 | 7.5 | guard executor_review | 10 Cu | 1 | 0 | 1 / 0 |
| 19ad | 053518b8 | 7.5 | guard executor_review (second review) | 10 Cu | 2 | 0 | 2 / 1 |
| 19ae | abdcb799 | 9.0 | guard executor_review (second review) | drill placed, no furnace | 2 | 0 | 2 / 1 |
| 19af | b9d96307 | 7.5 | guard executor_review (second review) | 10 Cu, electronics researched | 3 | 0 | 2 / 1 |

No run produced red science, built power or placed a lab.

The runs fall into two eras:
- **Before protocol 3 (15n to 18ab):** most runs ended with the goal-wide resume cap exhausted by one repeating loop (below).
- **From 19ac, with protocol 3 and the review round:** every run ended within 7.5 to 9 minutes at the second executor review of one step, which was a guard pause that nothing resumes.

## The repeating loop before protocol 3 (BL)

After a restage, the fresh executor spends its small observation allowance and finds the read phase closed. It replies `BLOCKED: … observations are closed / no live identity / no legal candidate` with no operations. The outcome authority rejects that blocker, the action-omission repair fails, and the goal takes a model_recoverable pause. The C7 auto-resume restages the executor and the loop repeats. The steps were often still progressing, so the loop spent the 6 goal-wide resumes before the hard step was reached:
- 15p at step 3;
- 15r at the shoreline;
- 15t at the lab;
- 16w at the engine;
- 17y at the pump;
- 18ab after seven claims.

Class 1 mixed with 3.

The mitigations have each been offline-tested, in order:
- `3ac91ec8`/`cd717daa` (diff baseline);
- `44a4fb2c` (closed-round action channel);
- `0e752542` (normal-observation phase);
- `bef4ff49` (unchanged reads are free);
- `093448e7`/`0f43c172` (predicted post-batch facts);
- `124be497` (reads reopen once per step, plus one planner review round);
- `54f2f18f` (open typed observation channel);
- `8f1ffcf4` (fresh topology keeps unit numbers);
- B1/B2 `7d8f6009`/`4f7af235` (caches bound to the conversation).

The runs from 19ac on no longer show the loop as such. Each of their ends has its own specific cause (below). Status: **mitigated, not live-verified.**

## Items

Status words:
- **fixed-live:** a later live run exercised the fix;
- **fixed-offline:** static or native tests only;
- **open**;
- **handed-off**;
- **superseded:** the path no longer exists or was not seen again.

### Fixed before this ledger

| item | runs | fix | status |
|---|---|---|---|
| diff baseline lost at restage | 15n | `3ac91ec8`, `cd717daa` | fixed-live (15p on) |
| JIT step-contract side call | 15p | `8f7ac8ee` | fixed-live (15r on) |
| closed-round action channel | 15q | `44a4fb2c` | fixed-live (15r) |
| normal-observation phase consumed the one-fact allowance | 15t | `0e752542` | fixed-live (15u) |
| missing `goal.paused` on operator stop | 17x | `2865d1b4` | fixed-live (17y) |
| batch overlap and prefix settlement | 18z | `aaf2882b`, `7ee18d4b`, `42d866c2` | fixed-live (18aa on) |
| zero-transfer no-mutation proof | 18aa | `930d0e2b` | fixed-offline |
| production skill offered but never loaded | 18aa | `19395ce5`, `439c65ab` | fixed-offline |
| manual bootstrap despite the direct-miner skill; legacy BLOCKED prose | 18ab | `736dc960` | fixed-offline |
| review was terminal | 19ac | `124be497` (one durable planner round per step) | fixed-live (19ad) |
| typed nearby observation refused by the closed-round whitelist; research-only coverage reclosed reads | 19ad | `54f2f18f`, `021a361a` | fixed-live (19ae) |
| ore spilled on the drop tile blocked every furnace; fresh topology dropped the drill's unit number; `getPrototypeDetails` crashed on drills; echoed checkpoint refused the review | 19ae | `8f1ffcf4` | fixed-offline (19af did not exercise the spill or the drill identity) |
| ground-item pickup receipts | 19af preflight | `10948bf7` | fixed-offline |
| task-receipt diff without its full receipt after a restage (191 rows) | 15n to 19af | B1/B2 `7d8f6009`, `4f7af235` | fixed-offline |

### Open after 19af, and what this ledger does with them

| id | runs | what | class | action |
|---|---|---|---|---|
| AF-1 | 19af | The planner's review-round reply (a plan with no operations, as its contract requires) triggered finite-goal continuation pressure. That started an action-omission repair and persisted `admission_status: action_omission_repair`. The handed-back executor's `continue_current` restage resumed the repair, so it got a one-act-or-block budget instead of the reads the planner's notes asked for. It requested a second review, which led to the guard pause. | 3 | unit 1 `fix/planner-review-pressure` |
| X-1 | 19ad, 19ae, 19af (19ac before the round existed) | A second executor review of the same step is a GUARD pause, and guard never auto-resumes. Nobody is connected in an autonomous run, so it is a dead end after about 8 minutes. | 3 (review contract outcome) | unit 2 |
| AB-2 / Z-2 | 18z, 18ab | After a C7 restage the executor claimed "the fresh inventory snapshot omits their counts" and "the live furnace snapshot doesn't identify its unit or recipe". | 1 | Verified open at `c7dae64c`. (a) 18ab seq 365 is a step-advance seam, not a restage. After a step closes, `fresh_topology.held` always says `held_scope: omitted_counts_unknown`, even with 5 items and nothing omitted, so absent items read as unknown instead of zero. `postBatchFactsContext` also withholds the inventory bundle on a step-key change. (b) The furnace unit number has been fixed since `8f1ffcf4`; the recipe is still absent. Both C7 packets dropped `held_counts`, `placed_machines` and the step contract under the 4050-char protocol-3 cap, because `attachCachedTriggerCrafting` keeps already-researched nodes (about 870 chars). | units U3 (held scope) and U4 (packet budget) |
| V-geometry | 16v | The handoff dropped earlier water/geometry samples under its size budget. | 1 | Verified open and worse since: `fba2a419` reserves 1950 chars for topology even when none is produced. The static `HANDOFF_DROP_ORDER` drops `fluid_source_hints` 5th, ahead of every executor fact. Meanwhile `deriveBuildBill`/`closureRoots` size the recipe closure without netting held counts, so records for already-held furnace roots crowd it out. The hints were kept in 2 of 23 handoffs across the runs. | unit U5 (held-netted closure, data-derived drop tier, no reserve without topology) |
| Y-refusal | 17y | The `harvest_product` copper-cable/gear refusal (`natural_harvest_source_not_found`) was retried after each restage and cost three resumes. | 1 | Verified open, but the cause is not lost refusal memory. `rawLeafFromRecipeDetails` treats any item with `harvested_from` as a raw leaf even when a crafting recipe exists, and `withoutRawLeafRecipes` then hides that recipe. So every packet named the fulgoran ruins as the only route for copper-cable and gears, although the executor hand-crafted cable twice. | unit U6 (raw leaf only when mined, or no recipe and only harvested) |
| AE-5 | 19ae | The handed-back executor spent its four reads on nearby searches and never re-read the furnace footprint. It is probably a consequence of the lost drill unit number (`8f1ffcf4`) and was not re-tested. | 1/3 | covered by the composed scenario |
| read edits | 16w, 17x, 17y, 18ab | `read_cannot_edit_or_complete_plan`: a targeted read carried plan or checkpoint fields. It appeared 0 times in 19ac to 19af. | 3 | superseded (protocol 3, `8f1ffcf4`) |
| AB-4 | 18ab | The steam-kit step's checkpoint did not cover the 10 pipes and 50 coal named in the step prose, and the step closed with 7 pipes held. That did not cause the stop (18ab ended at the shoreline). The offshore pump feeds the boiler directly, so the pipes were not required. | 3 | no failure; not fixed |
| X-2 | all | Restage still drops transcript memory: C7 is 49 of 104 executor restages. B1/B2 bound the caches; the transcript itself is gone by design. | 1/2 | measured (A2); see proposal P1 |
| AF-2 | 19af | `getPlacementCandidates` returned 8 legal drill candidates, but the obstruction samples (footprints overlapping furnace 31) came first, and both roles treated the candidates as blocked. The candidates were also about 15 tiles from the furnace. | 0 | open, not delegation |
| AB-3 | 18ab, 16v | A radius-128 water read was empty or incomplete, a radius-256 read found water, and the walk to it ended `navigation_unreachable`. | 0 | open, not delegation |
| lifecycle smalls | 15o, 15r, 15s, 15t, 15u, 17y | an intake retry after terminal; a tool-schema error escalated to a planner wake; a silent BLOCKED stall; a stale `paused_at` after an operator stop; `provider_response_too_large` as a guard pause; transport C7 restages | 2 | handed off to option C |

## Proposals that need the owner

- **P1: free re-establishing reads after a harness swap.** The observation budget limits exploration of new facts in one decision. After a swap, the harness itself discarded the tool results the step held, and B2 now (correctly) forgets `unchangedFactReads` at a swap, so re-reading them costs budget. A data-driven rule would not charge a fresh read whose key was in the dropped conversation's tool cache for the same step identity. That would remove the remaining budget pressure behind BL without a larger budget. It was not built, because 19ac to 19af show no budget-only end once AF-1 is fixed.
