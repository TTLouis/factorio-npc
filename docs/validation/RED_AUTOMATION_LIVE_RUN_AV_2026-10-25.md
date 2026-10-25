# Run AV: automated red science, normal 1×, October 25, 2026

**Gameplay failed.** Run AV stopped at `auto_resume_exhausted` after 24.048 minutes from goal submission to stop submission (runner elapsed 1,443,298 ms). Native totals were **106 iron plates, 10 copper plates and zero automation science packs**. No automated red-science chain, power system or measurement window was reached. Wrapper exit 0 confirms closeout; it does not establish gameplay success.

The active checkpoint was slice p5 version 1 step 2, placing a new furnace while preserving the iron cell. Furnace 23 was present at (46,12); the retained checkpoint also required three furnaces globally, two burner drills and a `place_entity` receipt. Final native facts showed two furnaces and one drill. Although the successful placement used `place_candidate`, the deterministic check correctly marked the `place_entity` receipt predicate TRUE; only the global three-furnace/two-drill predicates failed. Subsequent repeat-placement proposals were refused for missing held furnace stock. Two automatic resumes returned to the same step without closing it; exhaustion was **step 2/2, goal 2/6**. Independent source diagnosis attributes the failure to contract-authoring drift after stale exact identities were rejected. At Run AV closeout, safe replacement authority for an already frozen malformed contract awaited an owner design decision; the later authorization is recorded in the dated addendum below. This report implements no runtime fix and starts no trial.

## Frozen candidate and trial contract

- Local source `11d182c1aa8650c9254a58ee8dc4bfc3fe7b936a`; published source `0102d24070fe951b59d01cda8b7463b79fdd5f26`, freshly checked by the parent before preparation. Task branch `test/run-av-red-automation`; no live source edits.
- Payload source `2014a0738d855d190dbc499c24cdcc658d1a93b1`; SHA-256 `6d9ff05468d450708b8ae00650f825380291c5022206f8963154512688245be4`.
- Reviewed 62-helper manifest `8dbb4ccf9bf0d0b54c3a01468d9e730f7258e408c0738ac8eef6cfb75af56559`; construction NORMAL 1×, unchanged 60-minute cap. Separate reviewed measurement contract was never entered.
- CLI-proxy planner `gpt-6.1-sol`, executor `gpt-6-luna`; dedicated Jev configured as `jev-latest`, resolved response model `jev-1.14.0`. Read-only overwatch used the owner’s Luna configuration; per-agent token/billing usage is unavailable.
- Cold actor 10, epoch 1, seed 2661940142; zero humans, empty board/inventory and idle queues before the declared one-time vanilla starter. No corrective gameplay prompts or manual resumes.
- Goal: “Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.” Goal ID `goal_0j69h7n_1`.

Offline candidate gates reported by the parent passed: 103 agent, 3,448 runtime, 1,378 mod, type/Lua/generated checks and 9 payload tests. Preparation passed 46 helper, 1 recorder and 10 archive tests, 15 mocked tunnel lifecycle and 3 cleanup assertions, plus 19 PowerShell syntax checks. Independent native compilation and deployed comparisons matched all 72 runtime modules and 32 native files with zero mismatches, exact Factorio 2.0.77. These checks are preparation evidence, separate from this failed gameplay outcome.

[Live source/profile/model/actor receipt](../../test-results/red-automation-live-2026-10-25av/source-freeze-live.json); [machine-readable metrics](../../test-results/red-automation-live-2026-10-25av/postrun/metrics.json); [concise machine summary](../../test-results/red-automation-live-2026-10-25av/postrun/final-summary.json).

## Actual committed plans

The first committed slice was p3; p1/p2 identifiers in drafts do not establish earlier committed plans. Three slices contain 12 steps: eight verified complete, one active and three pending. The descriptions below are copied from retained canonical plans. Full goal, Roadmap Shelf/history, execution guidance, completion contracts, exact final progress, every observed revision, issued/rejected drafts, planner review notes and prompt/observation references are preserved in [plans.md](../../test-results/red-automation-live-2026-10-25av/postrun/plans.md), [canonical-plans.json](../../test-results/red-automation-live-2026-10-25av/postrun/canonical-plans.json), [full-issued-responses.json](../../test-results/red-automation-live-2026-10-25av/postrun/full-issued-responses.json) and [plan-provenance.json](../../test-results/red-automation-live-2026-10-25av/postrun/plan-provenance.json). All 79 original response bodies and all 79 request bodies are retained across prompt rotation; derived disposition annotations are labeled and do not change the issued material.

| Slice | Step | Original description | Final retained state |
|---|---:|---|---|
| p3 v1 | 1 | Acquire 10 copper ore and 5 coal, retaining the held stone furnace for the copper bootstrap. | completed |
| p3 v1 | 2 | Place the held stone furnace and obtain its fresh exact identity before supplying it. | completed |
| p3 v1 | 3 | Use the furnace to smelt and collect 10 copper plates, then verify electronics is researched. | completed |
| p4 v1 | 1 | Recover the idle stone furnace and assemble a bootstrap kit of 12 coal, one stone furnace, and the owned burner mining drill. | completed |
| p4 v1 | 2 | Place the burner mining drill over the observed iron patch near (46.5, 14.5), then observe its fresh identity and actual output position. | completed |
| p4 v1 | 3 | Install the recovered furnace over the drill’s validated output position, then observe both exact identities and verify the direct-feed connection. | completed |
| p4 v1 | 4 | Fuel the direct-fed iron cell, produce and collect 50 additional iron plates to hold at least 58, and verify steam-power is researched. | completed |
| p5 v1 | 1 | Prepare a copper bootstrap kit containing one stone furnace, five copper ore, and one coal. | completed |
| p5 v1 | 2 | Place the new furnace within eight tiles of (46, 14), preserving the existing iron cell, then observe its fresh identity. | active |
| p5 v1 | 3 | Smelt and collect five additional copper plates to hold at least 15 copper plates, preserving the 58 iron plates for lab construction. | pending |
| p5 v1 | 4 | Prepare the lab components: 10 electronic circuits, 10 iron gear wheels, and four transport belts. | pending |
| p5 v1 | 5 | Craft one lab and verify that automation-science-pack technology is researched. | pending |

Canonical snapshots were taken at the reviewed 90-second cadence; intermediate issued material is retained verbatim in the full-response recorder and plan events. The final canonical goal remains active with an operator pause after archival stop; p5 is retained as executing with step 2 active. No later cleaner plan was reconstructed as the original.

## Recovery and tool accounting

Counts below describe control mechanisms, with exact request/plan/step source references and reason grouping in the metrics. They can nest and must not be summed as unique global recovery attempts. “Completed” means the named control transition or a following admission occurred; it never means the factory or semantic step succeeded.

| Mechanism | Attempted | Completed control | Failed control | Unresolved |
|---|---:|---:|---:|---:|
| validation or observation retry | 11 | 5 | 5 | 1 |
| planner review | 3 | 2 | 0 | 1 |
| automatic resume | 2 | 2 | 0 | 0 |
| action omission | 4 | 2 | 2 | 0 |
| preflight correction | 4 | 2 | 2 | 0 |
| fresh context restage | 1 | 1 | 0 | 0 |
| advisory normalization | 1 | 1 | 0 | 0 |

Automatic resumes completed two resumption transitions but **corrected zero furnace steps**; both returned to pause/review. The final exhaustion event denied another attempt and is not a third recovery. Planner review was requested three times, executed twice and returned notes twice; the final scope-change request did not execute another planner review. Context restages total 11, including ordinary handoffs and the single explicit fresh-context repair; operator gameplay recoveries total zero. Validation retry reasons were requirements grounding (1), duplicate observation (2), observation decision pressure (4), observation decision budget complete (1), observation decision budget exhausted (1), and invalid production task (2). Full grouping by reason and active plan/step is in metrics; between-slice attribution remains explicitly unknown where no committed slice existed.

Original wire responses contain 87 unique tool calls: 59 observation attempts and 28 `submitPlan` calls. Later prompt context contains 89 distinct IDs because it can include harness-generated observations; those are not 89 model attempts. The harness traced 59 observation calls/results, including two cached results. One returned `getNearbyEntities` call lacks an ordinary call event, while one harness `getEntityStatus` call lacks a matching original wire ID; these differences are retained, not silently equated. Native RCON execution per observation is unavailable because static/fact caches can bypass it even when cached=false; per-tool coalescing is also unavailable.

| Observation tool | Wire attempts | Harness calls/results | Success | Failure/refusal | Cached |
|---|---:|---:|---:|---:|---:|
| estimateProductionTime | 2 | 2/2 | 2 | 0 | 0 |
| findLongRangeEntities | 1 | 1/1 | 1 | 0 | 0 |
| getActorStatus | 3 | 3/3 | 3 | 0 | 0 |
| getEntityGeometry | 1 | 1/1 | 1 | 0 | 0 |
| getEntityStatus | 6 | 7/7 | 6 | 1 | 0 |
| getInventoryItems | 6 | 6/6 | 6 | 0 | 0 |
| getLogisticsTopology | 1 | 1/1 | 1 | 0 | 0 |
| getMiningDetails | 3 | 3/3 | 3 | 0 | 0 |
| getNearbyEntities | 4 | 3/3 | 3 | 0 | 0 |
| getPlacementCandidates | 12 | 12/12 | 12 | 0 | 1 |
| getPrototypeDetails | 1 | 1/1 | 1 | 0 | 0 |
| getRecipeDetails | 13 | 13/13 | 12 | 1 | 1 |
| getResearchPath | 3 | 3/3 | 3 | 0 | 0 |
| getTechnology | 2 | 2/2 | 2 | 0 | 0 |
| validateConstructionPlan | 1 | 1/1 | 1 | 0 | 0 |

The production controller separately records 526 resolved observation reads: getActorStatus 128, getEntityStatus 148, getInventoryItems 81 and getRecipeDetails 169. Failed attempts/cache/coalescing/durations are not exposed for those reads; they are separate from the model-tool table.

There were 108 normalized proposals and 94 admitted, acknowledged and natively completed batches, containing 96 admitted operation entries and 104 native completed tasks. Native tasks include internal navigation; proposal, operation and task counts are different units. Admitted operation entries: `gather_resource` 7, `place_entity` 1, `supply_entity` 5, `move_items_exact` 44, `wait` 32, `mine_entity_exact` 2, `place_candidate` 3, `execute_construction_plan` 1, `craft_item` 1. No rejected proposal is counted as a completed native action.

## API usage, time and prices

| Provider / model / role | Requests / responses | Input | Cached input | Uncached input | Output | Reasoning within output |
|---|---:|---:|---:|---:|---:|---:|
| CLI-proxy / gpt-6.1-sol / planner | 23 / 23 | 743,452 | 291,456 | 451,996 | 13,784 | 5,999 |
| CLI-proxy / gpt-6-luna / executor | 56 / 56 | 1,643,715 | 1,011,840 | 631,875 | 12,719 | 7,482 |
| TypeSafe / jev-1.14.0 / semantic checkpoints | 56 / 56 | unknown | unknown | unknown | unknown | unknown |

CLI-proxy token fields are complete for all 79 replies and reconcile against the independent response recorder: 2,387,167 input, 1,303,296 cached input, 1,083,871 uncached input, 26,503 output and 13,481 reasoning tokens. Jev exposes partial trace totals of 179,671 input units and 11,621 output units; 50/56 responses include unit fields, and runtime defaults can substitute zero for missing usage/cost. These are not established complete billed token totals.

Across 135 NPC API requests: zero transport errors, zero API cancellations, zero provider/Jev fallback events and no unmatched responses. Five CLI requests carried recovery_attempt>0; those are correction rounds inside the one trial, not separately authorized provider retries. Three harness request-cancel events (two recovery preparation, one strict stop) are distinct from zero cancelled API calls. There were **zero new CLI-proxy or Jev requests after stop submission or after strict confirmation**, through the retained trace end. Orchestration/overwatch usage is unavailable and excluded.

| Timing view | Duration | Interpretation |
|---|---:|---|
| Official build | unavailable | Successful build/log/image retained; no instrumented UTC start/end pair |
| Cold preflight | 22.083 s | Parent intent to ready receipt; excludes build and review delay |
| Trial | 1,442.883 s | 07:21:10.399Z goal submission to 07:45:13.282Z stop submission |
| Runner elapsed | 1,443.298 s | Includes 55 ms preobjective setup and strict-stop receipt interval |
| Planner requests | 593.429 s sum; 25.801 s mean | 23 calls; range 3.816–106.703 s |
| Executor requests | 411.038 s sum; 7.340 s mean | 56 calls; range 2.069–20.570 s |
| LLM wire intervals | 985.202 s union | Concurrent prediction/executor intervals merged |
| Jev requests | 8.715 s sum; 0.156 s mean | 56 calls; range 0.084–0.264 s |
| LLM + Jev intervals | 991.931 s union | Jev intervals inferred from response latency |
| Observation tool envelopes | 3.941 s union | Harness call-to-result envelopes |
| Measurement | not entered | Zero duration; no acceptance measurement |
| Strict stop | 0.360 s | Fresh cancellation + same-goal operator-pause confirmation |
| Stop/save/load/cleanup | 14.425 s | Stop submission to wrapper closeout |

Native process-log task segments give navigation 25.610 s (12 segments, mean 2.134 s), mining/gathering 93.931 s (11, mean 8.539 s), crafting 0.516 s (1), placement 0.082 s (8, mean 0.010 s), transfers 0.259 s (50, mean 0.005 s), and explicit production waits 129.139 s (32, mean 4.036 s). Segment counts can include internal navigation/resumed placement and are not top-level operation counts. These categories, API time, tools and recovery intervals overlap; they are not an additive partition of trial wall time. Exhaustive waiting and background research/production durations are unavailable. Per-recovery durations and latency distributions are in metrics. Measured thinking duration is **unavailable**: request latency includes queueing, generation and network time; reasoning-token counts are not a duration.

Prices as of 2026-10-25: **all 135 trial requests are unpriced**. USD rates, verified pricing source, token-price equivalent and actual billed cost are unknown; the estimate is explicitly partial. A future verified calculation must price uncached input, cached input and output separately, without adding reasoning tokens twice. CLI-proxy subscription token-price equivalents would not establish incremental billed charges. Trace-reported zero Jev cost and Codex quota percentages do not establish free usage or monetary cost.

## Stop, save, coverage and preservation

Fresh cancellation at 07:45:13.302Z and same-goal operator pause confirmed by 07:45:13.642Z. Native idle, empty operation/crafting queues and cleared intake retry were verified. Save written after that boundary: **742,874 bytes**, all **55 ZIP entries** passed CRC, SHA-256 `bb8efd81d6e1faa97e1ade4469f2aae0d59c41c7f664dfeebaf0c69668206d84`. A pristine copy loaded under exact Factorio **2.0.77** with the matched 32-file active mod set; benchmark exit 0. This validates archive/load integrity, not factory acceptance.

Read-only run-check exited 1 with four finding records: no_chat_reply for two requests, restage_loop for the first automatic-resume request (four C7/C5/C7/C3 restages without step progress), and auto_resume_exhausted. Two informational signatures were retained, with zero parse errors. [Full detector result](../../test-results/red-automation-live-2026-10-25av/postrun/run-check.json).

Live exercise evidence includes 94 ingested native receipts, 10 receipt-variant matches, one checkpoint-batch deferral, 62 semantic completion checks and one advisory-rationale normalization. There was no Factorio or supervisor restart, so the newly integrated restart receipt restoration and stale-owner race fixes are **not live-validated by AV**. Generic native operation/recovery execution does not prove those adversarial paths. Checkpoint reconciliation, busy review deferral and gather-residual correction events were absent.

The exact isolated Compose project, all stopped/live run proof containers, owned tunnel PID 76064 and recorder PID 42308 were removed; networks/disposable volumes were absent, the unique run image tag was removed, and no background work remained. The shared factorio-npc:local alias was untouched and retained. Parent receipts show temporary build config link removal. Final cleanup completed at 07:45:27.707Z. Save, compiled native files, traces and local analysis are intentionally retained.

Raw preservation sealed 163 files / 25,966,057 bytes under manifest SHA-256 `3ee58c5b6ba3f7072358401a5346984b3b1e09313d4254fbf791199f8379020b`; the supplemental final canonical-state/native-log manifest has SHA-256 `6dc9f24e9d410aa318cecfa1db173993626f7115e56730c80ce829c2ea2ca69f`. Overwatch was excluded while its owner finalized that directory. Independent checks reverified every raw/supplement hash, all 62 helper hashes, all API identities/usage totals, native batch/task counts and ZIP integrity. [Raw seal](../../test-results/red-automation-live-2026-10-25av/postrun/raw-seal.json), [count and integrity checks](../../test-results/red-automation-live-2026-10-25av/postrun/independent-count-checks.json), [derived failure fixture](../../test-results/red-automation-live-2026-10-25av/postrun/run-av-failure-fixture.json).

Further local source analysis: [diagnosis](../../../../handoffs/red-science-loop-2026-10-25/run-av-diagnosis.md) and [independent design-boundary review](../../../../handoffs/red-science-loop-2026-10-25/run-av-decision-review.md). These are later derived analyses, outside sealed raw evidence. The owner decision was pending when this report was first prepared; its later resolution is recorded below. Receipt aliases are already correct and are not a repair target.

All links to test-results refer to intentionally local ignored evidence. Full logs and private archives remain local and must not be staged/pushed. Derived analysis is outside sealed raw inputs; historical evidence and helpers were not rewritten. No new trial, provider call or source fix was performed for this report.

## Closeout addendum — October 25, 2026

At **08:00:24.879776Z**, the owner approved the narrowly bounded automatic contract-defect successor described in the [decision record](../../../../handoffs/red-science-loop-2026-10-25/decision-request.json). The harness must prove the defect using typed obligations/provenance and fresh native facts. The old plan remains immutable; a successor must preserve the same goal, semantic step and verified history. Authority is limited to **one successor per semantic step within the existing replacement limits**. Separate fix implementation and candidate validation remain pending; this approval is not evidence that Run AV repaired itself or achieved its goal.

The owner also requested **two side-by-side trials for the next version**, using distinct seeds and a dedicated Luna overwatch for each trial. The paired harness is being prepared separately; neither trial has run as of this addendum. Run AV's frozen source, original plans, failure result, strict-stop/save evidence and raw/helper seals remain unchanged.
