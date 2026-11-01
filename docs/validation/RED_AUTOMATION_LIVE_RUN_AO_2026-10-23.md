# Red automation live Run AO — 2026-10-23

**FAIL — `construction_wall_limit_60_minutes`.** The automated red-science acceptance contract was not met; no sustained rate is claimed.

Trial wall time: **3611.574s** from objective submission to strict-stop submission. One trial; no corrective gameplay prompts, manual resumes or extra supplies after the declared starter.

Full accounting: [metrics.json](../../test-results/red-automation-live-2026-10-23ao/analysis/metrics.json); [controller metrics](../../test-results/red-automation-live-2026-10-23ao/analysis/controller-metrics.json). Actual plans: [readable complete plans](../../test-results/red-automation-live-2026-10-23ao/analysis/plans.md), [original issued responses](../../test-results/red-automation-live-2026-10-23ao/analysis/full-issued-responses.json), [canonical plans/history](../../test-results/red-automation-live-2026-10-23ao/analysis/canonical-plans.json), [provenance/completeness](../../test-results/red-automation-live-2026-10-23ao/analysis/plan-provenance.json). Independent cheap-model review: [overwatch](../../test-results/red-automation-live-2026-10-23ao/overwatch/final-review.md).

## Frozen source and preflight

- Local candidate: `d33e9697dab4b96cbaebf21c8d551822d941dabb`; published Jev head freshly checked before freeze: `b9574fc4556eafb431f158ebee80fe3f1807a02d`. No push/deployment.
- Task branch/path: `test/run-ao-red-automation`, `.worktrees/test-run-ao-red-automation`; parent session `01a16167` owns this isolated run.
- Exact deployed matches: **67 runtime modules**, **32 independently compiled native files**, packaged prompt and release manifest; no mismatches. Factorio **2.0.77**.
- Payload source `cd757d8bf4e9fc38970ced87a51215c71268e7d7`, SHA-256 `6a800b4a96aee9675385dc84d40c673c9fedd9a4603ada3978dcc88d29623a14`.
- Offline gates: **3,166 runtime**, **1,346 mod**, typecheck/Lua/generated-Lua, **44 helper**, **9 payload**, **1 recorder**, **10 ZIP-integrity** tests; cleanup inventory negative check passed.
- Effective configured roles: CLI-proxy **gpt-6.1-sol planner / gpt-6-luna executor**, dedicated Jev. Overwatch uses **gpt-6-luna**, read-only host evidence, no NPC/provider/gameplay calls.
- Frozen helper manifest SHA-256 `7ea6a1c87f4c838907aad93f3e3bcadfdc77c93e7415f67414dad59f53146480`; source and helpers stayed fixed.

Cold actor **19**, seed **2875693838**, zero humans, speed 1, empty inventory/board/queues and no machines before the one vanilla starter. Starter: eight iron plates, one burner drill, one furnace, pistol and ten ammunition. No inference before objective.

A setup-only image build failed because the unpinned stable Factorio selector returned an unsupported release. A process-only 2.0.77 pin then built successfully without changing owner configuration or source. An archive-test discovery command selected zero tests; direct execution subsequently passed all ten. Both initial logs remain preserved. The inherited compact host observer also encountered a null plan before commitment; the unchanged runner continued, and a separate null-safe host summary was used. None was a provider retry or second trial.

## Native outcome

| Item | Native produced | Native consumed |
|---|---|---|
| iron-ore | 84 | 84 |
| copper-ore | 26 | 26 |
| coal | 16 | 13 |
| iron-plate | 84 | 42 |
| copper-plate | 26 | 15 |
| iron-gear-wheel | 0 | 14 |
| automation-science-pack | 0 | 0 |

These are raw native force-production counters. Standalone handcraft product counters can remain zero; they are not a complete count of every crafted intermediate. Native task receipts and held stock are separate evidence.

Final machine count: **3**. Research and machine identities/topology are retained in the native snapshots; handcraft, placement or admission do not establish automation.

## Actual committed plan outline

The following descriptions are copied from retained canonical plans. Full guidance, contracts, outcomes, Shelf revisions, initial and later issued plans, rejected drafts and review notes remain in the linked structured copies. No ideal plan was reconstructed.

Goal `goal_1tg451g_1`.

### goal_1tg451g_1_p3 — COMPLETED

1. Gather 16 coal for startup fueling of the held copper-production equipment.
2. Install the held burner-mining-drill on natural copper ore; observe its exact identity and actual output position before placing its receiver.
3. Install the held stone-furnace at a validated position receiving the drill output; observe its exact identity and verify the direct-feed relationship.
4. Fuel the copper cell, produce and collect 10 copper plates from naturally mined ore, and verify electronics is researched.

### goal_1tg451g_1_p4 — COMPLETED

1. Prepare one stone-furnace and retain at least 4 coal for the iron bootstrap; craft the furnace from 5 stone.
2. Install the new stone-furnace near natural iron ore; observe its exact identity before supplying it.
3. Smelt naturally sourced iron ore in the new furnace, collect 50 iron plates, and verify steam-power is researched.

### goal_1tg451g_1_p5 — COMPLETED

1. Collect 5 copper plates from the existing copper furnace at (-21, 3), reaching at least 15 held copper plates while retaining 50 iron plates.
2. Prepare the lab component kit: 10 iron-gear-wheel, 10 electronic-circuit and 4 transport-belt.
3. Craft one lab from the prepared components and verify automation-science-pack technology is researched.

### goal_1tg451g_1_p6 — EXECUTING

1. Reach 50 held iron plates for the steam-power kit, reusing the existing iron furnace at (-21, 1).
2. Prepare the remaining materials: 2 copper plates, 5 stone, 2 wood and 20 coal, while retaining 50 iron plates and one lab.
3. Prepare the complete steam construction kit: one offshore pump, one boiler, one steam engine, four small electric poles and eight spare pipes; retain 20 coal and one lab.

## Recovery and changed-path exercise

Control mechanisms are counted separately; nested retry and resume episodes are not added as independent gameplay incidents. Completed recovery means its documented control continuation, not factory success. Exact reason/plan/step groups are in metrics.

| Mechanism | Attempted | Completed | Failed | Unresolved |
|---|---|---|---|---|
| validation_or_observation_retry | 14 | 10 | 4 | 0 |
| runtime_condition_wake | 1 | 1 | 0 | 0 |
| planner_review | 1 | 1 | 0 | 0 |
| runtime_auto_resume_after_transient_provider_failure | 1 | 1 | 0 | 0 |

Context restages: **10**; operator gameplay recovery interventions: **0**. Normal handoffs/restages are reported separately.

New controller path events: `{"production.execute": 1, "production.read": 5, "production.started": 1}`. Prediction events: `{"plan.contract_prediction_bound": 6, "plan.contract_prediction_discarded": 2, "plan.contract_prediction_started": 8}`.

The [controller metrics](../../test-results/red-automation-live-2026-10-23ao/analysis/controller-metrics.json) records live exercise by changed subsystem, fresh deficit recovery outcomes and prediction discard reasons. Unexercised paths retain only their separate offline/native proof; this run does not promote them by source presence.

The finite production path emitted one execution, but no `production.complete` or `production.recovery` event. This live trial does not prove full task continuation or residual material self-correction; those retain their separate deterministic proof.

**Observed liveness failure:** after the contract-call failure at `2026-10-23T17:39:58.724Z`, no later provider request, tool call or native admission occurred for **1764.065s** before strict stop. The preceding prediction was discarded with `prediction_owner_changed`; the next contract call failed with `stale_prediction_owner_changed`. The plan advanced, native work became idle and canonical state remained unpaused. The frozen terminal classifier continued as `controller_running`, so its paused-controller timeout did not end this condition. This is retained failure evidence; no runtime repair or manual wake was applied during the trial.

## API usage and estimated prices

| Provider/model/role | Requests | Responses | Errors | Pending/cancelled | Input | Cached input | Output | Reasoning tokens |
|---|---|---|---|---|---|---|---|---|
| cli-proxy/gpt-6.1-sol/planner | 25 | 25 | 0 | 0 | 779,987 | 287,744 | 14,002 | 6,145 |
| cli-proxy/gpt-6-luna/executor | 58 | 57 | 1 | 0 | 1,676,568 | 1,051,520 | 18,507 | 12,516 |

Jev: **67 requests / 67 accepted responses / 67 exchanges**, **0 failures**. Models: `{"jev-1.14.0": 67}`. Usage fields present on 59 responses; reported units are partial and are not assumed complete billed tokens.

NPC LLM calls after strict-stop submission/confirmation: **0/0**; Jev: **0/0**. Request IDs, failures, cancellation, retries/fallback evidence, usage completeness and full response capture coverage are retained in metrics/provenance. Parent/overwatch per-agent tokens and billing telemetry are unavailable and separate from NPC accounting.

Complete ordinary responses and token usage survive for **82** completed calls. The executor timeout has unknown usage; no missing usage is treated as zero. The independent recorder retained 82 complete replies and one incomplete/error record. The harness performed one automatic resume after that timeout; the operator sent no retry or repair.

**Estimated total and actual billed cost: unavailable, USD; partial/unpriced accounting.** All **150** NPC requests have unknown verified alias-specific rates. Pricing source/date: no verified rate mapping or billing evidence as of 2026-10-23; input/cache/output rates and per-provider/model/role cost remain unavailable. Reported token totals are not zero-cost evidence. Reasoning tokens are already included in output and must not be counted twice. A subscription token-price equivalent would differ from an actual incremental charge. This run called no quota-reset action. The account usage API unexpectedly moved from 39% remaining to 100% and later 98%; its cause is unknown, and that change is not treated as negative trial usage or monetary cost.

## Tools and native execution

| Observation tool | Attempts ≥ | Harness calls | Success | Failed/refused | Cached |
|---|---|---|---|---|---|
| getRecipeDetails | 20 | 20 | 20 | 0 | 2 |
| getResearchPath | 3 | 3 | 3 | 0 | 0 |
| getMiningDetails | 5 | 5 | 5 | 0 | 0 |
| getPlacementCandidates | 4 | 4 | 4 | 0 | 0 |
| getNearbyEntities | 2 | 2 | 2 | 0 | 0 |
| findLongRangeEntities | 1 | 1 | 1 | 0 | 0 |
| getEntityStatus | 14 | 14 | 14 | 0 | 0 |
| estimateProductionTime | 3 | 3 | 3 | 0 | 0 |
| getInventoryItems | 3 | 3 | 3 | 0 | 0 |
| getTechnology | 1 | 1 | 1 | 0 | 0 |

Native admission: **24 batches / 24 acknowledgements**. Operation counts and native completed action receipts are retained separately; one submission is not one completed action. Native RCON execution and per-tool coalescing counts are unavailable where caches are not explicitly traced.

Harness production observations are separate from model tool calls: `[{"tool": "getEntityStatus", "completed_reads": 2, "attempted_reads": null, "successes": 2, "failures": null, "cached_or_coalesced": null, "duration_ms": null}, {"tool": "getInventoryItems", "completed_reads": 1, "attempted_reads": null, "successes": 1, "failures": null, "cached_or_coalesced": null, "duration_ms": null}, {"tool": "getRecipeDetails", "completed_reads": 2, "attempted_reads": null, "successes": 2, "failures": null, "cached_or_coalesced": null, "duration_ms": null}]`. Those completion-only read events do not expose failed attempts, cache/coalescing or per-call latency; those fields remain unknown.

## Time breakdown

| Interval | Duration |
|---|---|
| Trial wall | 3611.574s |
| Setup including build/preflight | 312.158s |
| Build alone | unavailable; log timestamps retained, no exclusive instrumented interval |
| Preflight alone | unavailable |
| Measurement | not entered |
| Stop/save/native-load/cleanup envelope | 25.865s |
| LLM wire interval union | 1387.174s |
| LLM + inferred Jev interval union | 1397.640s |
| Tool envelope union | 3.693s |

| Request-to-response/error envelopes | Count | Total | Mean | Range |
|---|---|---|---|---|
| planner | 25 | 457.323s | 18.293s | 3.147s–70.196s |
| executor | 58 | 933.531s | 16.095s | 1.969s–299.978s |

| Completed-reply provider latency | Total | Mean | Range |
|---|---|---|---|
| planner | 457.821s | 18.313s | 3.154s–70.240s |
| executor | 635.036s | 11.141s | 2.005s–106.752s |
| Jev | 12.091s | 0.180s | 0.105s–0.302s |

| Native action segments | Segments | Total | Mean | Range |
|---|---|---|---|---|
| crafting | 6 | 24.783s | 4.130s | 0.518s–12.926s |
| mining | 6 | 214.118s | 35.686s | 12.380s–84.706s |
| moving_items | 15 | 0.100s | 0.007s | 0.002s–0.017s |
| placing | 5 | 0.045s | 0.009s | 0.002s–0.019s |
| waiting | 1 | 60.007s | 60.007s | 60.007s–60.007s |
| walking_to_entity | 11 | 85.772s | 7.797s | 0.068s–12.562s |

Native action segments (navigation, mining, crafting, placement, transfer and waits), recovery/review intervals and averages/ranges are retained in metrics. Concurrent intervals overlap and must not be summed into an exclusive wall-time partition. Background research/production and exhaustive idle time are unavailable. **Measured thinking duration is unavailable**: request latency includes generation, queueing and network; reasoning tokens are not a duration. No private chain-of-thought was requested.

## Evidence and cleanup

Sources: current/rotated behavior, prompt and Jev decision traces; independent ordinary-response recorder; canonical planning/world histories; final NPC state; native Factorio log. Rows are deduplicated and correlated by request/round/recovery/response identity. Missing telemetry remains unavailable; exact prompt/source references and gaps are in provenance.

Strict fresh supervisor cancellation plus same-goal operator pause confirmed; native task state idle and queues/crafting empty. Post-boundary checkpoint passed full ZIP integrity (**56 entries**) and pristine exact-version native load with all 32 native files matching. Save SHA-256 `dc2db8c0911970470b78246d7de84bb1dbe40eeafa27308df10a9a553d5a886a`.

Final cleanup verified: **True**. Exact project `red-automation-20261023ao`, recorded containers/IDs, tunnel identity, recorder/listeners, networks/disposable volumes, unique image tag and temporary config marker are absent. Host evidence/task checkout and shared build/development/archive images remain. No owned background work remains. [cleanup proof](../../test-results/red-automation-live-2026-10-23ao/analysis/final-cleanup.json).

No source repair, second trial, push or production deployment was performed.
