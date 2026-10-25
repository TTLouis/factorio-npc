# Paired Run AX: automated red science, normal 1×, October 25, 2026

**Both gameplay trials failed: zero automation science produced or consumed.** Each lane ended in the frozen runner’s `controller_paused:guard` / `nonresumable_controller_pause` terminal path. These were visible safety pauses, not AW-style unpaused orphan stalls, parent owner-cancellation, quota stops or native success. Wrapper exit 0 proves preservation/cleanup, not gameplay acceptance. No corrective gameplay prompt, manual resume, provider retry or live replay followed.

Lane A hit an accepted typed-declaration/legacy-checkpoint size mismatch when a future committed step activated. Lane B’s boiler proposal reached the final preservation check without a certified compatible fluid join and was refused **before transport**. Model replies succeeded; neither application failure establishes a failed provider API call.

Private local evidence root: `D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/`. All evidence links below are absolute workspace paths, usable from the task or integration checkout. Ignored raw/private files are not published with this report.

| Evidence | Lane A | Lane B |
|---|---|---|
| Run goal | goal_1ds0xn5_1 | goal_0moe2wn_1 |
| Cold seed / actor / epoch | 2026102501 / 14 / 1 | 2026102502 / 13 / 1 |
| Goal submitted UTC | 2026-10-25T14:45:24.214Z | 2026-10-25T14:45:24.242Z |
| Guard cause | step_contract_unavailable: unsupported_or_malformed_contract | request_failed: preservation_candidate_join_unproven |
| Strict stop submitted UTC | 2026-10-25T15:10:57.340000+00:00 | 2026-10-25T15:16:58.170000+00:00 |
| Goal → strict command, seconds | 1,533.126 | 1,893.928 |
| Runner elapsed, ms | 1,533,571 | 1,894,341 |
| Fresh strict receipt latency, ms | 353 | 338 |
| Native iron / copper / red produced | 86 / 33 / 0 | 100 / 66 / 0 |
| Native completed batches / tasks | 49 / 58 | 21 / 37 |
| Checkpoint ZIP bytes / CRC entries | 760,001 / 55 | 767,362 / 55 |
| Pristine Factorio load | 2.0.77, 32/32 active native files, exit 0 | 2.0.77, 32/32 active native files, exit 0 |

[Combined metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/metrics.json), [A metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/metrics.json), [B metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/metrics.json), [independent count checks](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/independent-count-checks.json) and [exact original failure fixture](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/replay-fixtures/run-ax-original-failures.json) retain full rules, IDs, sources and unavailable telemetry.

## Frozen source and contract

The unchanged goal was: “Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.” The two fresh worlds had independent sessions, actor/goal ownership, boards, inventories, data, recorders, tunnels, results and receipts. Different frozen seeds were injected through normal fresh-world generation and confirmed natively; repeating seed numbers across versions does not reuse an earlier world or goal.

- Final local candidate **`2959fd309f529b7af5bd69953ca8b4012d99006f`**; payload ref `0dde1167848758275f36061d2e50014b6a325695`, SHA-256 `19117c3b218685876c3d6fe71babd431ea0d3cc101f51557ae02961bacade104`. Frozen published ref `0102d24070fe951b59d01cda8b7463b79fdd5f26`, parent-verified at 14:22:45.4431397Z. No publication occurred.
- Unique image `factorio-npc:run-ax-20261025`, immutable ID `sha256:333302fdf417e4420bbb70793fd8624bd5b59e0e85af7301f3acfcfbd98fd0eb`. Offline source gates recorded 103 agent / 3,782 runtime / 1,382 mod, type/Lua and 9 payload tests passing. Image, independent installed runtime, native and cold preflights matched **77 runtime modules and 32 native files**, exact Factorio 2.0.77. These gates are separate from gameplay.
- Planner `gpt-6.1-sol`, executor `gpt-6-luna`, CLI-proxy. Dedicated TypeSafe Jev configured `jev-latest`; all observed decision replies identify **`jev-1.14.0`**. Dedicated read-only Luna overwatch per lane finished with the trials. Parent/overwatch usage remains unavailable and excluded from NPC wire totals.
- Both cold proofs showed zero humans, empty inventory/board, idle empty queues and no prior NPC inference. One vanilla starter each: eight iron plates, one burner drill, one furnace, pistol and ten magazines. Operator gameplay actions after that starter and corrective prompts were zero.
- NORMAL **1× construction**, unchanged 60-minute cap; no sprint leases. Separate five-wall-minute 2× / at-least-ten-game-minute measurement was **not entered**. Neither placement, research unlock, slice completion nor a clean wrapper establishes ≥1 native automated red per game minute or the upstream production chain.

Packaging distinction: the fresh canonical Git compile/image/cold/pristine artifacts independently pass **32/32**. Comparison against the older engine-tested package is **31/32 under the declared normalization and 27/32 raw**, not an exact 32-file match. The remaining nonexecuted provider README differs only by CRLF, a real Markdown manifest difference that was explicitly reviewed; the four Lua/JSON/LICENSE differences use the already declared normalization. No output edit or verifier-normalization expansion was used to hide this exception.

[Offline freeze](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/sealed/raw/source-freeze-offline.json), [live cold freeze](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/sealed/raw/source-freeze-live.json), [fresh compile receipt](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/supplemental/native-compile-receipt.json) and [older-package equivalence/README exception](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/supplemental/native-artifact-equivalence.json) preserve these identities.

## Guard failures and exact baseline phases

**A — accepted future step cannot compile at activation.** Corrected actual planner tap 67 committed p6 with a later step requesting six inventory outcomes (pump, boiler, engine, two poles, ten coal and existing lab) plus preservation of units 30/31/32. Typed normalization accepts the total nine, but compilation feeds nine requirements into a legacy sanitizer limited to eight and yields `semantic_unknown` with no requirements. A pure deterministic compile of that exact recorded declaration confirms the mismatch. The earlier tap 66 checkpoint/obligation mismatch was correctly rejected and corrected; it is separate from this terminal accepted representation gap.

P6 committed at 15:08:02.902Z. The advisory prediction discarded the unsupported contract; after step 1’s verified closure, JIT binding failed at 15:09:26.981Z with **attempts 0**, then the runtime visibly guard-paused at 15:09:27.018Z. `contract_call_failed` here does not mean a remote API call failed. The committed p6 step 2 remained uncompleted; the harness stopped rather than inventing a checkpoint. Independent source review finds the same 16-versus-8 inconsistency in pre-F1/F2 source `134fac9e`; AX does not establish that those repairs introduced it.

**B — legal placement is not a certified fluid connection.** Actual tap 83 committed p9 to install a boiler while preserving pump 30 and retaining an engine/lab. Tap 84 queried `getPlacementCandidates` with `anchor:{unit_number:30}` but no `connects_to`; all eight ordinary returned candidates lacked that relation. Tap 85 proposed `placement-10/candidate-1`. Ordinary stock/footprint preflight passed; the final preservation helper refused `preservation_candidate_join_unproven` at 15:16:34.760Z and settled pending batch 22 `operation.not_sent: cancelled_before_transport`. No boiler batch, native acknowledgment, preservation admission or additive certificate was produced for p9.

The selected boiler orientation faces its steam/output toward the pump output; retained geometry and source reject output-to-output as the intended water join. It is unsafe to fill in a missing witness or certify a different candidate after the fact. The implicit `fluid_preservation_candidate` freeze reply is not separately retained, so its exact native refusal code is unknown; the ordinary placement-candidate tool result is a different reply and is not substituted. The outer pause’s `provider_failure:true` conflicts with the inner nonprovider preservation refusal and does **not** establish a provider transport failure.

[A independent diagnosis, preserved provisional original](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/sealed/independent-diagnosis/ax-a-diagnosis.md) and [B independent diagnosis, preserved supplemental original](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/supplemental/ax-b-diagnosis.md) provide source locations, original sequences and limits. Their quoted trace identities reconcile with the seal; report annotation does not rewrite those provisional documents or authorize fixes.

Failure fixtures use exact timestamped pre-stop history, never overwritten latest state: **A line 18, 15:10:57.266Z**, p6 EXECUTING/guard-paused, 95 ms before fresh cancel 15:10:57.361Z; **B line 22, 15:16:58.024Z**, p9 COMMITTED/guard-paused, 168 ms before fresh cancel 15:16:58.192Z. Full emitted rows, file/line hashes, issued replies and missing-native-reply/null-substitution markers are retained. These rows are not reconstructed full pre-stop snapshots with unobserved ledgers. All goals remain unachieved.

## Actual goals, shelf and plans

Descriptions below are copied from retained canonical plans. Full original goal, Roadmap Shelf/history, all observed plan versions, execution guidance, typed obligations/proofs, completion contracts, step outcomes, review notes and issued/rejected drafts are preserved in the linked structured material. Commitment and final step progress are distinct from gameplay acceptance.

### Lane A

| Slice | Original step descriptions | Retained status |
|---|---|---|
| 3 v1 | 1. Acquire a bootstrap reserve of at least 20 coal for the held iron miner and furnace.<br>2. Install one held burner-mining-drill covering natural iron ore; observe its new exact identity and actual output position.<br>3. Install the held stone-furnace to receive the drill’s output, fuel both machines, and verify both are working.<br>4. Collect at least 50 iron plates into inventory and verify steam-power is researched through its native 50-iron-plate production trigger. | COMPLETED |
| 4 v1 | 1. Acquire at least 10 stone and 20 coal for the copper cell’s construction and startup fuel.<br>2. Craft one burner-mining-drill and one additional stone-furnace, retaining at least 20 coal.<br>3. Install the new drill covering natural copper ore; inspect its exact identity, resource coverage and actual output position.<br>4. Install the new furnace to receive the copper drill’s observed output; inspect the resulting direct-feed connection.<br>5. Fuel the copper cell, collect at least 10 copper plates, and verify electronics is researched through its native production trigger. | COMPLETED |
| 5 v1 | 1. Collect copper plates from the existing direct-fed copper cell until inventory holds at least 15, preserving the drill and furnace connection.<br>2. Craft one lab and verify automation-science-pack technology is researched through its native lab-production trigger. | COMPLETED |
| 6 v1 | 1. Collect iron plates from the existing direct-fed iron cell until inventory holds at least 42, preserving the existing smelting cells.<br>2. Prepare and verify one offshore pump, one boiler, one steam engine, two small electric poles, ten coal and the existing lab, preserving the existing smelting cells. | EXECUTING |

[Lane A readable/full issued plans](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/plans.md), [canonical goal/shelf/history](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/canonical-plans.json), [all exact ordinary assistant replies/tool arguments](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/full-issued-responses.json), [validation/review events](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/plan-events.json) and [request/prompt provenance](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/a/plan-provenance.json). All 73 original wire requests and replies reconcile across prompt rotations and the independent recorder; rejected material is not replaced by a cleaner later reconstruction.

### Lane B

| Slice | Original step descriptions | Retained status |
|---|---|---|
| 3 v1 | 1. Acquire 20 coal for the initial copper-production cell.<br>2. Install the held burner-mining-drill at a validated copper-ore placement; inspect its fresh identity and output geometry before placing the furnace.<br>3. Install the held stone-furnace at a validated receiving placement; inspect its fresh identity and the actual ore-output connection before supplying fuel.<br>4. Operate the direct-fed copper cell, collect at least 10 copper plates, and verify electronics is researched. | COMPLETED |
| 4 v1 | 1. Acquire 50 iron ore, 5 stone, and 4 coal for the iron bootstrap.<br>2. Craft one stone-furnace from the five stone.<br>3. Install the new furnace near the observed iron patch while preserving the copper cell; inspect its fresh identity before supplying it.<br>4. Smelt the fifty iron ore, collect the plates to hold at least 58 iron-plate, and verify steam-power is researched. | COMPLETED |
| 5 v1 | 1. Collect five copper plates from the existing copper furnace, reaching 15 copper-plate while retaining 58 iron-plate and preserving the existing machines.<br>2. Craft one lab from 36 iron plates and 15 copper plates, then verify automation-science-pack is researched while preserving the existing machines. | COMPLETED |
| 6 v1 | 1. Produce and collect 20 additional iron plates using the existing iron furnace, reaching 42 iron-plate while preserving both furnaces, the copper miner, and its direct output route. | COMPLETED |
| 7 v1 | 1. Gather five stone for a new boiler furnace, retaining 42 iron plates and preserving both existing furnaces and the copper miner’s direct output route.<br>2. Craft and hold one offshore pump, one boiler, and one steam engine from 42 iron plates and five stone, preserving both existing furnaces and the copper miner’s direct output route. | COMPLETED |
| 8 v1 | 1. Install one offshore pump within four tiles of (53.5, 5.5), retaining the boiler and steam engine for the next connection stage. | COMPLETED |
| 9 v1 | 1. Install one boiler within two tiles of (51.5, 5), preserving offshore pump 30 and retaining one steam engine and one lab. | COMMITTED |

[Lane B readable/full issued plans](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/plans.md), [canonical goal/shelf/history](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/canonical-plans.json), [all exact ordinary assistant replies/tool arguments](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/full-issued-responses.json), [validation/review events](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/plan-events.json) and [request/prompt provenance](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/b/plan-provenance.json). All 83 original wire requests and replies reconcile across prompt rotations and the independent recorder; rejected material is not replaced by a cleaner later reconstruction.

## Recovery, tools and native accounting

Each mechanism is counted by correlated episode/reason/goal/plan/step, with control completion distinct from semantic success. Nested normalization, validation retry, preflight correction, condition wake and planner review views must not be summed as unique overall recoveries. Polls/phase traces are not new attempts; full source-level groupings and boundaries remain in lane metrics.

| Mechanism | A attempted / completed / failed / unresolved | B attempted / completed / failed / unresolved |
|---|---|---|
| advisory_normalization | 1 / 1 / 0 / 0 | 0 / 0 / 0 / 0 |
| automatic_resume | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| jev_routed_recovery | 1 / 1 / 0 / 0 | 0 / 0 / 0 / 0 |
| planner_review | 1 / 1 / 0 / 0 | 1 / 1 / 0 / 0 |
| preflight_correction | 0 / 0 / 0 / 0 | 1 / 1 / 0 / 0 |
| runtime_condition_wake | 2 / 2 / 0 / 0 | 0 / 0 / 0 / 0 |
| validation_or_observation_retry | 13 / 8 / 5 / 0 | 21 / 10 / 11 / 0 |

Planner reviews requested/executed: 1/1 A and 1/1 B; one notes-delivery each. Context restages: 11 A / 14 B, including ordinary handoffs. B’s supply-recovery event is detail of the preflight-correction episode, not an additional global recovery. No manual gameplay recovery occurred.

F2 ordinary completed-predecessor ownership is positively exercised: `planning.next_slice_owned` **3 A / 6 B**, with zero `planning.next_slice_settled` events. This does not prove an injected orphan correction or new 2/6 allowance use live. A’s terminal step is still incomplete, outside the completed-predecessor orphan case. F1 preservation capture/admission safety is exercised, including B’s one classified refusal; there are no successful fluid-admission/certificate or contract-defect successor events. No restart occurred. Offline adversarial proofs remain separate from these live paths.

Original model tools, harness calls/results, preparation intents, native acknowledgments and completed tasks use different units. Observation result flags expose cache hits/refusals; exact native RCON executions and per-tool coalescing are unavailable because caches can bypass native calls.

| Observation tool | A wire / calls / results / success / refusal / cached | B wire / calls / results / success / refusal / cached |
|---|---|---|
| estimateProductionTime | 0 / 0 / 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| findLongRangeEntities | 1 / 1 / 1 / 1 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getActorStatus | 1 / 1 / 1 / 1 / 0 / 0 | 2 / 2 / 2 / 2 / 0 / 0 |
| getCraftingStatus | 1 / 1 / 1 / 1 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getEntityGeometry | 0 / 0 / 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getEntityStatus | 13 / 13 / 13 / 13 / 0 / 0 | 8 / 8 / 8 / 8 / 0 / 1 |
| getFluidSourceTiles | 0 / 0 / 0 / 0 / 0 / 0 | 9 / 9 / 9 / 9 / 0 / 1 |
| getInventoryItems | 4 / 4 / 4 / 4 / 0 / 1 | 9 / 9 / 9 / 9 / 0 / 0 |
| getLocalSpatialObservation | 0 / 0 / 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getLogisticsTopology | 2 / 1 / 1 / 1 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 |
| getMiningDetails | 3 / 3 / 3 / 3 / 0 / 0 | 3 / 3 / 3 / 3 / 0 / 0 |
| getNearbyEntities | 2 / 2 / 2 / 2 / 0 / 0 | 3 / 3 / 3 / 3 / 0 / 0 |
| getPlacementCandidates | 6 / 6 / 6 / 6 / 0 / 0 | 10 / 10 / 10 / 10 / 0 / 0 |
| getPrototypeDetails | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 4 / 4 / 4 / 0 / 0 |
| getRecipeDetails | 19 / 19 / 19 / 18 / 1 / 1 | 34 / 34 / 34 / 34 / 0 / 2 |
| getResearchPath | 2 / 2 / 2 / 2 / 0 / 0 | 2 / 2 / 2 / 2 / 0 / 0 |
| getResearchStatus | 1 / 1 / 1 / 1 / 0 / 0 | 0 / 1 / 1 / 1 / 0 / 0 |
| getTaskStatus | 0 / 0 / 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getTechnology | 6 / 6 / 6 / 6 / 0 / 2 | 3 / 3 / 3 / 3 / 0 / 0 |

A: 92 wire calls = 61 observations + 31 structured control submissions; 58 normalized proposals; B: 119 wire calls = 93 observations + 26 structured control submissions; 31 normalized proposals. `submitPlan` is outside ordinary tool.call/result accounting and never itself establishes native completion. Any wire/harness identity differences are listed in metrics.

A’s 49 `operations.admit` preparations reconcile with 49 acks/completed native batches, 58 tasks. B has **22 preparation intents but only 21 native-acknowledged/completed batches, 37 tasks**. Its last intent was explicitly settled unsent before the preservation refusal; counting 22 native batches would be wrong. Native tasks include internal navigation.

| Operation entries | A intended / native acknowledged | B intended / native acknowledged |
|---|---|---|
| craft_item | 9 / 9 | 8 / 8 |
| gather_resource | 3 / 3 | 7 / 7 |
| move_items_exact | 20 / 20 | 4 / 4 |
| place_candidate | 4 / 4 | 5 / 4 |
| supply_entity | 8 / 8 | 4 / 4 |
| wait | 10 / 10 | 0 / 0 |
| walk_to_position | 1 / 1 | 1 / 1 |

Internal production reads are separate: A getActorStatus 43, getEntityStatus 43, getInventoryItems 29, getRecipeDetails 57; B getInventoryItems 1, getRecipeDetails 1. Failed attempts/cache/coalescing/per-call duration for these internal reads are unavailable.

## API usage, time and prices

| Lane / provider / model / role | Requests / replies | Input | Cached | Uncached | Output | Reasoning within output |
|---|---|---|---|---|---|---|
| A / CLI-proxy / gpt-6.1-sol / planner | 16 / 16 | 701,177 | 290,048 | 411,129 | 16,855 | 5,720 |
| A / CLI-proxy / gpt-6-luna / executor | 57 / 57 | 1,735,587 | 952,320 | 783,267 | 11,136 | 6,424 |
| B / CLI-proxy / gpt-6.1-sol / planner | 34 / 34 | 1,440,809 | 770,304 | 670,505 | 25,779 | 10,548 |
| B / CLI-proxy / gpt-6-luna / executor | 49 / 49 | 1,416,208 | 853,120 | 563,088 | 9,782 | 5,335 |

All **156 CLI replies** expose complete token/cache/reasoning fields and reconcile independently by model/response identity: **5,293,781 input, 2,865,792 cached, 2,427,989 uncached, 63,552 output, 28,027 reasoning within output**. Lane run ID scopes identities; equal tap/turn labels across lanes do not deduplicate.

| TypeSafe / jev-1.14.0 / semantic checkpoints | Requests / replies | Partial trace input units | Partial trace output units | Replies with unit fields |
|---|---|---|---|---|
| A | 72 / 72 | 245,218 | 15,824 | 64 / 72 |
| B | 72 / 72 | 196,811 | 13,039 | 58 / 72 |

Across **300 NPC API requests/replies** (156 CLI, 144 Jev): zero transport errors, API cancellations, provider/Jev fallbacks or unmatched replies; no new requests after strict submission or logged fresh cancellation. Harness request-cancel events for preparation/cleanup/stop are separately grouped in metrics. Correlated recovery_attempt correction rounds are not provider transport retries. Recorder sequence also includes two non-chat forwarded requests per lane; they are not missing inference replies. Parent/overwatch usage is unavailable and excluded.

Jev cache/uncached-input/reasoning token totals are unavailable, and partial reported units are not complete billed-token totals. Runtime cost0 may be a missing-value default. All **300 NPC calls are unpriced**, USD estimate, actual billed cost and token-price equivalent **unknown** as of 2026-10-25: no verified alias-specific rates/public mapping or billing evidence is retained. Pricing source/rates are null. A future estimate would use uncached input × input rate + cached input × cache rate + output × output rate, without charging reasoning twice. A subscription/CLI-proxy token-price equivalent would not establish an incremental charge. Codex quota is not money.

| Timing view, seconds | A | B |
|---|---|---|
| Goal submission → strict command | 1,533.126 | 1,893.928 |
| Planner request latency sum | 606.045 | 1,011.558 |
| Executor request latency sum | 401.294 | 355.731 |
| Jev response-latency sum | 12.199 | 11.457 |
| CLI wire interval union | 1,005.739 | 1,365.334 |
| CLI + Jev interval union | 1,017.084 | 1,375.605 |
| Tool call/result envelope union | 3.919 | 5.161 |
| Visible guard → strict command | 90.322 | 23.402 |
| Strict command → wrapper finished | 13.837 | 17.129 |

Per-call mean/range seconds: A planner 37.878 (3.989–104.884), executor 7.040 (2.563–19.789); B planner 29.752 (4.473–112.020), executor 7.260 (2.197–20.178). Jev/tool/action averages and ranges are retained in metrics. Jev intervals are inferred backward from recorded response latency, CLI spans use wire UTC.

| Native process-wall task segments, seconds | A | B |
|---|---|---|
| crafting | 26.777 | 36.178 |
| mining | 100.923 | 278.473 |
| moving_items | 0.122 | 0.104 |
| placing | 0.075 | 0.047 |
| waiting | 31.992 | unavailable |
| walking_to_entity | 44.870 | 63.851 |

Pair wall from first goal to last strict submission is 1,893.956 s; absolute cross-lane CLI union 1,617.299 s, CLI+Jev union 1,626.752 s. Workload sums, native segments, API/tool/recovery envelopes overlap and are not an additive wall-time partition. Native markers can split/resume one task; unfinished or absent timed segments are not assigned fabricated duration. Smelting/research may progress concurrently; exclusive production/research-wait and exhaustive unclassified waiting duration are unavailable.

Build and complete per-lane preflight durations are unavailable as independent spans in sealed pair inputs; build/cold milestones remain receipts, not measured exclusive durations. Measurement duration is zero (not entered). **Measured thinking duration is unavailable**: request latency includes queueing/generation/network, and reasoning token counts do not establish a duration. Recovery control envelopes are separately retained, with overlap acknowledged.

## Quota, preservation and cleanup

The immutable quota history has **82 receipts**: nine manual preparation records and the parent-identified 73-record automatic segment, which bookends the trials; 71 records fall between the first goal and last strict confirmation. Whole-history maximum gap was **221.329 s before launch**, exceeding both 90 s and 180 s before NPC goal submission and trial inference. The automatic segment’s maximum observed gap was **32.772 s**; the reconstructed active-trial receipt-age upper bound including recording delay was **33.014 s**, below 180 s. Remaining quota ranged 56% to final55%, above the frozen 7% floor/5% reserve. No quota fault/stop occurred. This is shared account evidence, not a per-lane budget or monetary charge; no universal preparation cadence is claimed.

[Quota timing/phase methods and all gaps](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/quota-metrics.json) preserve observed/recorded timestamps without rewriting history. The 73-segment identification comes from the parent’s pump record and contiguous cadence, not an invented raw marker.

Both automatic terminal paths obtained fresh supervisor cancellation + same-goal operator pause, cleared intake retry and native idle/empty queues before saving. The operator-class archival command was issued by the harness, not a manual gameplay intervention. A strict confirmation took353 ms, B338 ms. Both saves were fresh after confirmation, full55-entry ZIP CRC/integrity passed, and unchanged pristine copies loaded exact Factorio2.0.77 with all32 active native files. This report rechecked ZIP/hash locally; it did not run native Factorio or replay either world. Lane A ended independently while B continued, and the shared pair image survived until both were terminal.

Both lane cleanup receipts are true. The pair finalizer removed its unique3333 image/tag at15:17:19.9607185Z. [Independent parent teardown](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/supplemental/ax-parent-cleanup-verification.json) verifies eight recorded CIDs absent, both exact project container/network/volume inventories empty, all four recorded tunnel/recorder processes and declared TCP/UDP ports absent, unique image/tag absent and shared `factorio-npc:local` / `6c791306…` unchanged. Parent wrapper exit0/wrapperFailurefalse and completed overwatches do not change either gameplay verdict.

[Raw seal](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/sealed/SEAL.json) was durable at 2026-10-25T15:29:31.793Z, before repair fixtures/source work: **563 included files /65,347,286 bytes**, A267/B268 plus28 pair controls, all four final overwatch files, exact2959 source archive. Raw index SHA256 `144fc7f0b3b3c5b9afc4269c959f82a4470636f077b79c64f832151d907f40c7`. Sixteen potential secret/account/config/tunnel-diagnostic files were excluded **without opening, hashing, copying or displaying values**; [exclusion names/reasons](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/sealed/secret-exclusions.json) are explicit and originals remain untouched. [Parent seal verification](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/ax-closeout/postrun/supplemental/ax-parent-seal-verification.json) independently rechecks originals/copies/manifests/archive. AW584 original and sealed files remain unchanged; no source/config/runner/frozen artifact was edited.

## Documentation checks

Deterministic JSON parsing, rotated request/response/usage and native-count reconciliation, original/copy preservation, ZIP integrity, source-scope and absolute private-link checks are retained beside the local metrics. Per parent direction this documentation-only closeout does not rerun the implementation all gate; the frozen source’s completed gates are recorded above. Independent report review and parent integration remain required. No push, new trial, source fix or background observer was performed by this report task.
