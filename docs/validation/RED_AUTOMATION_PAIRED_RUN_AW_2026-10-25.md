# Paired Run AW: automated red science, normal 1×, October 25, 2026

**Both gameplay trials failed: zero automation science produced or consumed.** The parent stopped both through the frozen `owner_canceled` control after independently confirming that their workers had reset with active long-horizon goals and no owned next wake. This was a test control intervention, not a corrective gameplay prompt, manual resume, quota stop, automatic runner terminal or native success. Parent/coordinator exit 0 proves closeout only.

A completed slice did not complete either goal. Both final boiler proposals crossed the supported preservation scope with an offshore-pump declaration, then failed during runtime plan authoring. The preceding CLI and Jev replies succeeded; no API transport failure occurred.

| Evidence | Lane A | Lane B |
|---|---|---|
| Seed | 2026102501 | 2026102502 |
| Actor / epoch | 14 / 1 | 13 / 1 |
| Goal | goal_1qurc42_1 | goal_0ug4b5j_1 |
| Goal submitted UTC | 2026-10-25T09:57:07.470Z | 2026-10-25T09:57:07.507Z |
| Runtime failure UTC | 2026-10-25T10:22:35.456Z | 2026-10-25T10:26:22.247Z |
| First supervisor cancel UTC | 2026-10-25T10:29:25.101Z | 2026-10-25T10:29:25.920Z |
| Goal submission → first cancel, minutes | 32.294 | 32.307 |
| No-work interval after failure → first cancel, seconds | 409.645 | 183.673 |
| Native produced iron / copper / red | 66 / 15 / 0 | 80 / 19 / 0 |
| Native completed batches / tasks | 28 / 34 | 81 / 89 |
| Fresh archival strict-stop receipt, ms | 364 | 77 |
| Checkpoint ZIP bytes / CRC entries | 759,174 / 55 | 766,810 / 55 |
| Pristine exact-version load | 2.0.77, 32/32 native files, exit 0 | 2.0.77, 32/32 native files, exit 0 |

Private local evidence root: `D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/`. These ignored files remain in this workspace and are not published with this report. The absolute evidence links below resolve from either checkout.

[Combined machine metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/metrics.json), [lane A metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/a/metrics.json), [lane B metrics](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/b/metrics.json), [independent count checks](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/independent-count-checks.json) and [raw seal](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/SEAL.json) retain units, counting rules and source references. Full logs/saves/private archives remain local and ignored.

## Frozen contract and preparation

The unchanged goal was: “Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.” Each lane used a different deterministic seed and its own actor, goal, canonical board, inventory, data, recorder, tunnel, project, result and stop receipts. Neither result was derived from its sibling.

- Final candidate `134fac9e3e249341445e36c8304070b5eb93e579`; payload pins combined source `2e3eff93565e26349ca93ba377ded1e8a7dee94f`. Frozen published ref `0102d24070fe951b59d01cda8b7463b79fdd5f26` was checked online by the parent at 09:52:06.5199297Z, per its retained receipt.
- Shared image `sha256:a72554d54a240773d1dceb241aa64ac207dee229bd1f1a1e765917a2bba5f2f9`, unique tag `factorio-npc:run-aw-20261025`. Installed and cold per-lane checks matched all **74 runtime modules and 32 native files**, Factorio **2.0.77**. Native seeds matched the frozen generation settings.
- Planner `gpt-6.1-sol`, executor `gpt-6-luna`, CLI-proxy; Jev configured `jev-latest`, observed response model `jev-1.14.0`. Each lane had dedicated read-only Luna overwatch. Parent/overwatch token and billing usage is unavailable and is separate from NPC trial usage.
- Both cold checks showed zero humans, empty board/inventory, idle queues and no prior NPC inference. One vanilla starter each: eight iron plates, one burner drill, one furnace, one pistol and ten magazines. No corrective prompts, manual resumes or gameplay changes followed.
- Construction stayed NORMAL 1× with the unchanged 60-minute cap. The separate five-wall-minute, 2×, at-least-ten-game-minute measurement and native upstream-chain/rate acceptance were **never entered**. Zero red output cannot pass ≥1 red per game minute. No sprint was leased.

The parent’s final offline source receipt records 103 agent, 3,566 runtime, 1,378 mod, type/Lua/generated and 9 payload checks passing, plus the 69-case composed cancellation proof and independent native equivalence proof. Those preparation checks are separate from this failed live outcome. The image was built once; each installed runtime/model/native/cold-world preflight was independent.

Preparation source/model/cold receipts remain in [offline freeze](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/raw/source-freeze-offline.json) and [live freeze](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/raw/source-freeze-live.json). Frozen pair input manifest SHA-256 is `e7e7d642897168089f552eaf8c9f3e56e2a898635e6b28aed5284fb1e9bacb19`.

## Failure and interpretation

A failed at 10:22:35.456Z (`recovery_mvnny9io`), B at 10:26:22.247Z (`recovery_mvno4unw`), both with `provider_jev_recovery_route_failed: preservation_geometry_unproven`, `recoverable:false`. Their canonical goals remained active and previous p7 slices were completed, while run pause was false and condition wait/provider recovery/persistent runtime/pending operation/auto-resume were absent. The observer and engine continued to advance with native idle queues. This supports an application-level unowned idle stall; it does not establish an OS process crash.

Exact original A tap 69 preserved offshore pump 31; B tap 72 preserved pump 30. Those next boiler proposals never committed. The frozen capture accepts only its supported zero-fluid geometry/type scope; the pump declarations cross that scope. The separate raw response for the implicit preservation capture is unavailable, so the error alone does not establish a stale identity, wrong force or a specific fluid count. The guard’s refusal is distinct from the subsequent missing durable pause/wake. The completed legacy plan status bypassed active-plan-only recovery/stranded-plan handling; the frozen runner continued to label an unpaused canonical run `controller_running`. No source or frozen control was changed during AW.

[Exact original failure fixture](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/replay-fixtures/run-aw-preservation-stall-v2.json) preserves both full replies, failure/reset context and baseline source archive. [Independent liveness diagnosis](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/independent-diagnosis/aw-live-liveness-check.md) gives source locations and limits. Repair work is separate; this report performs no replay or fix.

A’s earlier steam-power completion concern was cleared by [independent source/evidence review](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/independent-diagnosis/aw-a-completion-check.md). Its immutable step required held iron ≥58 and named `steam-power` research; native structured research and deterministic completion evidence satisfied both. The runner’s `green_researched` flag means `logistic-science-pack`, so its false value did not contradict steam-power. Slice completion still left the red-science goal active and unsatisfied.

## Actual plans and issued proposals

The first retained committed slice is p3 in each lane; earlier draft identifiers are not proof of committed p1/p2. The following descriptions are copied from final retained canonical plans, in their original order. Each lane has five COMPLETED model-issued committed slices (p3–p7, 11 steps), while both user goals remain active and were finally operator-paused. Final wire boiler proposals are separate uncommitted failures. The additional p8 DRAFT is a **harness stop-time projection**, not a model-authored boiler plan or pre-failure execution owner; it repeats the prior pump-step description and is preserved verbatim.

### Lane A

| Slice | Original step descriptions | Retained status |
|---|---|---|
| 3 v1 | 1. Acquire 20 coal for the starter iron cell.<br>2. Install the held burner-mining-drill on iron ore; obtain its fresh identity and actual output geometry before furnace placement.<br>3. Install the held stone-furnace at a freshly validated candidate covering the drill output; obtain its fresh identity before fueling.<br>4. Fuel the direct-fed iron cell, smelt 50 new iron plates, and collect at least 58 iron plates in total; verify steam-power is researched. | COMPLETED |
| 4 v1 | 1. Acquire 10 copper ore for the electronics bootstrap.<br>2. Use the existing furnace to smelt and collect 10 copper plates; verify electronics is researched while preserving both iron-cell structures and their direct-output route. | COMPLETED |
| 5 v1 | 1. Acquire 5 copper ore for the lab’s remaining copper requirement.<br>2. Smelt the 5 copper ore and collect enough plates to hold 15 copper plates, preserving the existing iron-cell structures and their direct-output route.<br>3. Craft one lab using 10 electronic circuits, 10 iron gear wheels and 4 transport belts; verify automation-science-pack technology is researched. | COMPLETED |
| 6 v1 | 1. Prepare one offshore pump and one boiler from 11 iron plates and 5 newly collected stone, preserving the existing iron-cell structures and their direct-output route. | COMPLETED |
| 7 v1 | 1. Install one offshore pump at the observed shoreline near (47.5, 1.5), using the held pump and preserving the existing iron-cell structures and direct-output route. | COMPLETED |
| 8 v1 | 1. Install one offshore pump at the observed shoreline near (47.5, 1.5), using the held pump and preserving the existing iron-cell structures and direct-output route. | DRAFT; harness stop-time projection, uncommitted |

Full original goal, Roadmap Shelf/history, committed and observed plan revisions, step guidance, contracts, outcomes, planner-review notes and exact issued/rejected bodies are in [lane A plans](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/a/plans.md), [canonical material](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/a/canonical-plans.json), [all issued responses](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/a/full-issued-responses.json) and [prompt/validation provenance](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/a/plan-provenance.json). Both prompt rotations are preserved. All 67 original requests and responses reconcile with the independent recorder; no cleaner later reconstruction is labeled original.

### Lane B

| Slice | Original step descriptions | Retained status |
|---|---|---|
| 3 v1 | 1. Acquire 16 coal for the copper-smelting bootstrap.<br>2. Install one held burner-mining-drill covering copper ore; observe its fresh identity and actual output position.<br>3. Install one held stone-furnace covering the drill’s observed output; verify the direct ore route using fresh identities.<br>4. Fuel the cell, produce and collect 10 copper plates, and verify that electronics is researched. | COMPLETED |
| 4 v1 | 1. Prepare one stone-furnace, 50 iron ore and at least 4 coal for the steam-power bootstrap.<br>2. Install the new stone-furnace within 16 tiles of (-75, -36), retaining the existing copper cell; observe the new furnace’s identity.<br>3. Smelt 50 new iron plates in the new furnace, collect them to hold at least 58 iron plates, and verify steam-power is researched. | COMPLETED |
| 5 v1 | 1. Collect five copper plates from the existing copper furnace, holding at least 15 copper plates and 36 iron plates for one lab.<br>2. Craft one lab from the prepared materials and verify automation-science-pack is researched. | COMPLETED |
| 6 v1 | 1. Prepare one offshore pump, one boiler, one steam engine, two small electric poles and ten spare pipes, preserving the existing copper drill and both furnaces. | COMPLETED |
| 7 v1 | 1. Install one offshore pump within 12 tiles of (51, 8), preserving the existing copper drill and both furnaces. | COMPLETED |
| 8 v1 | 1. Install one offshore pump within 12 tiles of (51, 8), preserving the existing copper drill and both furnaces. | DRAFT; harness stop-time projection, uncommitted |

Full original goal, Roadmap Shelf/history, committed and observed plan revisions, step guidance, contracts, outcomes, planner-review notes and exact issued/rejected bodies are in [lane B plans](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/b/plans.md), [canonical material](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/b/canonical-plans.json), [all issued responses](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/b/full-issued-responses.json) and [prompt/validation provenance](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/b/plan-provenance.json). Both prompt rotations are preserved. All 70 original requests and responses reconcile with the independent recorder; no cleaner later reconstruction is labeled original.

Pre-stop retained `active_plan_id` was `goal_1qurc42_1_p7` / `goal_0ug4b5j_1_p7`, both COMPLETED, and neither pre-stop snapshot/history contains p8. P8 `created_at` is 10:29:25.104Z / 10:29:25.921Z, respectively 3/1 ms after initial cancellation. Its origin/lifecycle reason is `live_task_board`, `committed_at` and `derived_from_plan_id` are null, and attempted batches/operations are zero. A bound copied checkpoint does not grant committed execution authority. [Exact pre/post-stop ownership and binding supplement](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/replay-fixtures/p8-stop-time-provenance-v2.json) preserves the distinction.

Extraction correction: the first derived fixture mislabeled an untimed `e2e-latest-npc-state.json` copy as pre-stop; that file had already been overwritten after initial operator pause. V2 uses exact sealed planning-history line 22: A 10:28:40.289Z, B 10:28:40.771Z, respectively 44.812/45.149 s before initial cancellation. Those original rows show legacy completed and canonical run.paused=false; the paused latest snapshots are kept separately as post-stop context. The complete emitted history rows and file/line hashes are preserved, without pretending they are full pre-stop npc-state snapshots with unobserved ledgers. Original V1 artifacts remain as superseded-label evidence; no sealed byte changed. [Correction provenance](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/replay-fixtures/snapshot-phase-correction.json).

## Recovery and tool accounting

Counts describe unique correlated episodes for the named mechanism. A completed control means the documented transition/notes/admission occurred, not native step or goal success. Mechanisms can nest and must not be summed as a unique global recovery count. Full reason, request and active goal/plan/step grouping is retained; between-slice scope is explicitly null when no active committed plan exists.

| Mechanism | A attempted / completed / failed / unresolved | B attempted / completed / failed / unresolved |
|---|---|---|
| action_omission | 0 / 0 / 0 / 0 | 1 / 1 / 0 / 0 |
| automatic_resume | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| jev_routed_planner_recovery | 1 / 0 / 1 / 0 | 1 / 0 / 1 / 0 |
| planner_review | 1 / 1 / 0 / 0 | 1 / 1 / 0 / 0 |
| runtime_condition_wake | 1 / 1 / 0 / 0 | 1 / 1 / 0 / 0 |
| validation_or_observation_retry | 16 / 10 / 6 / 0 | 18 / 10 / 8 / 0 |

Each lane had one condition-wake preparation/continuation, one requested/executed planner review with one notes-delivery event, and 12 context restages (including ordinary handoffs). Neither lane scheduled an automatic resume after its terminal failure. B’s one action-omission episode and its correction round are nested control recovery, not a retry of a failed API transport. Each successful Jev recovery-route decision was followed by a runtime authoring exception; its failed planner-recovery mechanism does not count as a failed Jev API response. Operator gameplay recoveries were zero. The parent’s one decision stopped both; two fresh supervisor stop boundaries per lane cover initial cancellation and archival revalidation.

Original wire tool identities reconcile exactly with ordinary harness observation calls/results in this pair. `submitPlan` is a structured control submission, outside `tool.call/result`; neither a proposal nor a tool submission is native completion. “Calls/results” are harness execution; exact native RCON executions per observation are unavailable because static/fact caches can bypass RCON even when cached=false. Per-tool coalescing is unavailable.

| Observation tool | A wire / calls / results / success / refusal / cached | B wire / calls / results / success / refusal / cached |
|---|---|---|
| estimateProductionTime | 1 / 1 / 1 / 1 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getActorStatus | 2 / 2 / 2 / 2 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getEntityGeometry | 1 / 1 / 1 / 1 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getEntityStatus | 16 / 16 / 16 / 16 / 0 / 1 | 12 / 14 / 14 / 14 / 0 / 0 |
| getFluidSourceTiles | 4 / 4 / 4 / 4 / 0 / 0 | 1 / 2 / 2 / 2 / 0 / 0 |
| getInventoryItems | 5 / 5 / 5 / 5 / 0 / 0 | 5 / 5 / 5 / 5 / 0 / 0 |
| getLocalSpatialObservation | 1 / 1 / 1 / 1 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getLogisticsTopology | 2 / 2 / 2 / 2 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 |
| getMiningDetails | 4 / 4 / 4 / 4 / 0 / 0 | 4 / 4 / 4 / 4 / 0 / 0 |
| getNavigationStatus | 1 / 1 / 1 / 1 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 |
| getNearbyEntities | 2 / 2 / 2 / 2 / 0 / 0 | 4 / 4 / 4 / 4 / 0 / 0 |
| getPlacementCandidates | 6 / 6 / 6 / 6 / 0 / 0 | 8 / 10 / 10 / 10 / 0 / 2 |
| getPrototypeDetails | 5 / 5 / 5 / 5 / 0 / 0 | 5 / 5 / 5 / 5 / 0 / 1 |
| getRecipeDetails | 20 / 20 / 20 / 20 / 0 / 2 | 17 / 17 / 17 / 15 / 2 / 1 |
| getResearchPath | 2 / 2 / 2 / 2 / 0 / 0 | 3 / 3 / 3 / 3 / 0 / 0 |
| getResearchStatus | 2 / 2 / 2 / 2 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getTaskStatus | 0 / 0 / 0 / 0 / 0 / 0 | 1 / 1 / 1 / 1 / 0 / 0 |
| getTechnology | 3 / 3 / 3 / 3 / 0 / 0 | 3 / 3 / 3 / 3 / 0 / 0 |

A returned 101 wire tool calls (77 observations, 24 structured control); B returned 94 (68 observations, 26 structured control). A had 35 normalized proposals, 30 admitted operation entries and 28 completed batches/34 native tasks; B had 89 proposals, 82 entries and 81 batches/89 tasks. Native tasks include internal navigation and are a different unit from top-level operations.

| Admitted operation entries | A | B |
|---|---:|---:|
| craft_item | 12 | 24 |
| gather_resource | 4 | 6 |
| harvest_product | 0 | 1 |
| move_items_exact | 5 | 27 |
| place_candidate | 3 | 3 |
| place_entity | 0 | 1 |
| supply_entity | 3 | 10 |
| wait | 2 | 9 |
| walk_to_position | 1 | 1 |

Harness production reads are a separate view: A getInventoryItems 15, getRecipeDetails 120; B getActorStatus 10, getEntityStatus 118, getInventoryItems 69, getRecipeDetails 898. Failed attempts, cache/coalescing and per-read duration are unavailable for these internal reads. Mining residual self-correction and typed contract-successor recovery have no corresponding live events here; their source presence/offline gates are not live proof.

## API usage, time and prices

| Lane / provider / model / role | Requests / replies | Input | Cached | Uncached | Output | Reasoning within output |
|---|---:|---:|---:|---:|---:|---:|
| A / CLI-proxy / gpt-6.1-sol / planner | 28 / 28 | 1,188,488 | 553,728 | 634,760 | 18,788 | 7,356 |
| A / CLI-proxy / gpt-6-luna / executor | 39 / 39 | 1,147,734 | 654,720 | 493,014 | 10,226 | 6,358 |
| B / CLI-proxy / gpt-6.1-sol / planner | 27 / 27 | 1,186,216 | 500,992 | 685,224 | 19,588 | 7,103 |
| B / CLI-proxy / gpt-6-luna / executor | 43 / 43 | 1,331,132 | 734,080 | 597,052 | 12,275 | 7,778 |

All 137 CLI-proxy replies expose complete input/cache/output/reasoning token fields and reconcile by response identity: **4,853,570 input, 2,443,520 cached, 2,410,050 uncached, 60,877 output, 28,595 reasoning within output**. Each lane is deduplicated by run/request/response identity; equal tap labels in different lanes are separate calls.

| Jev semantic checkpoints (`jev-1.14.0`) | Requests / replies | Trace input units | Trace output units | Replies with unit fields |
|---|---:|---:|---:|---:|
| A | 56 / 56 | 155,273 | 10,538 | 44 / 56 |
| B | 53 / 53 | 148,670 | 9,929 | 41 / 53 |

Jev cache, uncached-input and reasoning token totals are unavailable; partial trace units are not established complete billed tokens. Missing usage/cost can be defaulted to zero on runtime paths, so emitted zero cost does not establish free usage. Contract-role breakdown and all decision request/response identities remain in lane metrics.

Across **246 NPC API requests**: zero transport failures, API cancellations or provider/Jev fallback events; no unmatched responses; zero new CLI-proxy/Jev requests after either first cancellation or final strict stop. B has one `recovery_attempt>0` correction round; A has zero. These are not separately authorized provider retries. Three harness `request.cancelled` events per lane (one condition-wake preparation, initial stop, archival stop) are distinct from zero canceled API calls. The recorder additionally forwarded two non-chat requests per lane; those sequence entries are not missing model responses. Orchestration/overwatch usage is unavailable and excluded.

| Timing view, seconds | A | B |
|---|---:|---:|
| Goal submission → first supervisor cancel | 1,937.631 | 1,938.413 |
| Planner request latency sum | 638.710 | 639.161 |
| Executor request latency sum | 338.414 | 388.087 |
| Jev response-latency sum | 8.783 | 8.022 |
| CLI wire interval union | 975.808 | 1,025.850 |
| CLI + Jev interval union | 983.465 | 1,032.963 |
| Tool call/result envelope union | 5.048 | 4.985 |
| Initial cancel → archival strict submission | 45.384 | 45.123 |
| Final strict submission → wrapper finished | 14.381 | 14.199 |

Planner/executor per-call means and ranges: A planner mean 22.811 s, range 3.886–91.665 s, executor mean 8.677 s, range 3.032–24.482 s; B planner mean 23.673 s, range 3.522–94.473 s, executor mean 9.025 s, range 2.551–25.554 s. Jev per-call means/ranges and tool/action averages are in metrics. Jev intervals are inferred backward from response latency; CLI intervals use retained request/response UTC.

| Native task segment wall seconds | A | B |
|---|---:|---:|
| crafting | 28.354 | 42.295 |
| harvesting | unavailable | 1.027 |
| mining | 80.779 | 213.914 |
| moving_items | 0.086 | 0.192 |
| placing | 0.026 | 0.050 |
| waiting | 36.995 | 28.792 |
| walking_to_entity | 67.287 | 67.903 |

Pair elapsed wall from first goal to the last initial cancel is 1,938.450 s. The cross-lane absolute CLI wire interval union is 1,485.532 s, and CLI+Jev union 1,493.632 s. Summed lane workload and concurrent API/native/tool/recovery views are not an additive wall-time partition. Native segments use engine process-wall markers and can split/resume a task; totals are not distinct action counts. Smelting/research can progress concurrently, so exclusive production/research-wait duration and unclassified waiting remain unavailable. Recovery episode envelope durations are separately retained.

Build and complete per-lane preflight duration are unavailable as independently instrumented spans in the sealed pair; setup milestones are retained, not relabeled as measured build time. Measurement duration is zero (not entered). **Measured thinking duration is unavailable.** Request latency includes generation, queueing and network; reasoning tokens do not provide a duration.

All **246 NPC calls are unpriced**, USD estimate and actual billed charge **unknown**, as of 2026-10-25. No verified alias-specific public rates/mapping or billing evidence is retained; pricing source/rates are null. A future token-price equivalent would use uncached input × input rate + cached input × cache rate + output × output rate, without charging reasoning twice. It would not establish an incremental subscription/CLI-proxy charge. Jev’s missing usage and orchestration/overwatch usage would still make a total partial. Codex quota percentages are not money.

## Shared quota, stop/save and cleanup

The parent supplied **35** receipts selecting exactly one 10,080-minute window; remaining percentage ranged 82% → 81%, above the 7% stop/5% reserve policy. This is shared account evidence across both lanes and orchestration. Actual refresh gaps included 103.894 s before goal submission and 109.210 s crossing the stop/cleanup interval; neither exceeded the frozen 180 s expiry. No universal ≤90 s cadence, continuous age sampling, lane-specific quota consumption or floor-triggered stop is claimed. [Full timing/gaps](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/quota-metrics.json) are retained.

Parent decision at 10:29:24.3093400Z was followed by initial fresh supervisor cancellations at 10:29:25.101Z / 10:29:25.920Z. The runner subsequently repeated cancellation and obtained the archival **fresh supervisor cancel + same-goal operator pause**, native idle/empty queues and cleared intake retry, with 364/77 ms confirmation. Saves followed those final strict boundaries; both complete ZIPs pass 55-entry CRC checks and unchanged pristine copies load on exact Factorio 2.0.77 with all 32 active native files. The report rechecked ZIP CRC/hash locally; it did not run another native load. No inference occurred after either stop boundary.

Both exact lane cleanup receipts are true. The pair finalizer removed only its unique AW image tag after both lanes ended. [Independent parent cleanup supplement](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/postrun/supplemental/aw-parent-cleanup-verification.json), recorded at 10:35:50.7888935Z, verifies all eight recorded run container IDs absent, both project container/network/volume inventories empty, four exact tunnel/recorder start identities absent, declared TCP/UDP ports unused, AW tag absent and shared local image tag unchanged. Overwatches finished; no background work remains. Reporter created no live resources.

Original AW evidence was sealed before repairs at 2026-10-25T10:34:53.625Z: **584 files / 64,955,588 bytes**, A277/B277 plus 30 pair controls, with all three retained overwatch files. Full copied snapshots and per-file manifests remain in [sealed evidence](D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/paired-kit/aw-closeout/sealed/SEAL.json); raw-manifest SHA-256 `3c2a4b8ea3ff08765fc0927f1263b528ee08fda2525253d36f93fe07006c077d`. Both original failure taps and exact baseline source are preserved. Derived material is outside seals; historical AV evidence was not changed.

## Report validation

Report candidate required all gate: exit 0; 103 agent, 3566 runtime, 1378 mod plus type/Lua/generated checks passed. Exact report-gate cleanup and preservation receipts are local beside the full logs. Independent report review remains required before integration; no push or new trial is authorized by this report.
