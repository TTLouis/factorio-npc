# Red automation live Run AN — 2026-10-22

**FAIL — the automated red-science goal was not achieved.** The reviewed runner stopped at its construction cap while the goal remained active. Native output was 133 iron plates and 26 copper plates. Ten hand-crafted science packs were consumed in automation research, but the final native automated science-production counter was zero and no assembler existed. The unattended throughput measurement was never entered; no automated rate is claimed.

The trial ran for **60m16.633s from objective submission to stop submission**; the runner reported 60m17.105s through its stop/result boundary. Its 90-second observation cadence detected the nominal 60-minute cap about 17 seconds late. This was one trial, with no corrective prompts, manual resumes or gameplay intervention after the declared starter.

Full accounting: [metrics.json](../../test-results/red-automation-live-2026-10-22an/analysis/metrics.json). Full original plans and notes: [readable plans](../../test-results/red-automation-live-2026-10-22an/analysis/plans.md), [original issued responses](../../test-results/red-automation-live-2026-10-22an/analysis/full-issued-responses.json), [canonical plans and history](../../test-results/red-automation-live-2026-10-22an/analysis/canonical-plans.json), [provenance and completeness](../../test-results/red-automation-live-2026-10-22an/analysis/plan-provenance.json). Independent cheap-model review: [overwatch](../../test-results/red-automation-live-2026-10-22an/overwatch/final-review.md).

## Frozen source and gates

- Local Jev candidate: `449e3769b177ae07206ea3e54a9852b5c1dbc2b1`; freshly fetched published head: `b9574fc4556eafb431f158ebee80fe3f1807a02d`, an ancestor 55 commits behind. No publication was performed.
- Task checkout/branch: `.worktrees/test-run-an-red-automation`, `test/run-an-red-automation`; parent session `01a16167` owned the isolated run. Integration source was inspected read-only; the tested source remained fixed.
- Official local image build passed; deployed runtime/prompt/release manifest matched the frozen candidate. All 62 installer-enumerated runtime modules and 32 independently compiled native files matched. Factorio version: 2.0.77.
- Immutable installer payload: source `19c4c42fbee3c74baf194401faa9b2a1fc62de85`, SHA-256 `c026a45de1c1512f1e62dbda673985e7cd494643ff9fe21a6b23817c91803acf`.
- Offline gates passed: runtime 3,123 tests; mod 1,346 tests; TypeScript/Lua build checks; runner/helper 44 tests; payload 9; recorder 1; archive integrity 10; cleanup inventory negative check.
- Final frozen helper manifest: `68a3ae92246aba95a8c8a8aaae7c4fc31b3671c9942c46b1863a03d44ea05202` (51 helpers). Verified unchanged after the trial.
- Effective roles: CLI-proxy `gpt-6.1-sol` planner, `gpt-6-luna` executor; dedicated Jev resolved as `jev-1.14.0`. Independent overwatch used `gpt-6-luna` and made no NPC/provider/gameplay calls.

Cold proof: actor 18, seed 766310622, zero humans, empty board/inventory/queues, no machines, speed 1, and zero inference before the starter and objective. One vanilla starter supplied eight iron plates, one burner drill, one furnace, pistol and ten ammunition.

Two failed setup attempts preceded the single trial and made no inference calls. The first exposed RCON readiness preceding NPC actor creation; its bounded 180-second local readiness wait was extended for that exact startup result. The second caught my mistaken removal of the reviewed dedicated E2E role override, which inherited a generic Qwen setting; I restored the original Sol/Luna roles without changing owner configuration. Both attempts and their cleanup proofs are preserved separately. An offline archive invocation also used a nonexistent `python` entry point; the retained failure was followed by a passing `python3` gate. None was a provider retry or another trial.

## Actual committed plan outline

These are the retained committed descriptions, not a reconstructed ideal plan. Rejected drafts, all guidance/completion contracts, just-in-time bindings, review notes, issued revisions, timestamps and IDs are preserved in the linked full copies. There were seven committed slices; the first six completed and the last remained active.

### goal_0rk4jnw_1_p3 — COMPLETED

1. Prepare the copper bootstrap kit: hold 10 copper ore, 10 coal, and 1 stone furnace, reusing the held furnace.
2. Place the stone furnace at a legal nearby bootstrap site; inspect the placed furnace to obtain its exact live identity.
3. Use the 10 copper ore and the coal reserve to smelt and collect 10 copper plates; verify electronics is researched.

### goal_0rk4jnw_1_p4 — COMPLETED

1. Prepare the iron bootstrap kit: recover the furnace at (28, 96), retain the held burner mining drill, and hold 16 coal plus both machines.
2. Install the burner mining drill on the observed iron patch near (-35.5, 63.5); verify resource coverage and inspect its actual output position.
3. Install the recovered stone furnace over the drill's actual output point; inspect the new furnace identity and verify the direct ore connection.
4. Fuel the iron cell from the 16-coal reserve, produce and collect 50 additional iron plates, and verify steam-power is researched; retain at least 58 iron plates total.

### goal_0rk4jnw_1_p5 — COMPLETED

1. Prepare the copper bootstrap kit: hold one stone furnace, five copper ore and one coal; preserve the 58 iron plates and ten copper plates.
2. Place the new stone furnace nearby and inspect its fresh identity before supplying it.
3. Smelt the five copper ore in the new furnace and collect the plates, bringing held copper plates to at least 15.
4. Craft one lab from ten gears, ten electronic circuits and four transport belts; verify automation-science-pack is researched.

### goal_0rk4jnw_1_p6 — COMPLETED

1. Smelt and collect one copper plate using the existing nearby furnace; retain the lab and at least 22 iron plates.
2. Prepare the steam-kit materials: hold 52 iron plates, five stone, one wood, ten coal, one copper plate and the lab.
3. Craft and verify the steam construction kit: one offshore pump, one boiler, one steam engine, two small electric poles and ten spare pipes; retain ten coal and the lab.

### goal_0rk4jnw_1_p7 — COMPLETED

1. Install one offshore pump near the observed shoreline site at (43.5, -56.5), within four tiles; inspect its fresh identity and water-output geometry.
2. Connect one boiler to the installed pump using up to ten held pipes, supply startup coal from the ten-coal reserve, and verify the boiler operates on water and produces steam.
3. Install one steam engine at the boiler's freshly observed steam connection; inspect the engine's identity and actual fluid linkage before wiring.
4. Install the held lab and up to two small electric poles; verify the steam engine is working and its electrical network powers the lab.

### goal_0rk4jnw_1_p8 — COMPLETED

1. Prepare the research bootstrap stock: hold 20 iron plates and 12 coal, reusing the observed iron-furnace output at (-44, 59) before producing additional iron.
2. Smelt and collect ten copper plates using natural copper ore and the existing furnace near (18, 109); retain 20 iron plates and at least ten coal for power.
3. Hand-craft ten iron gears and then ten automation-science-packs from the prepared plates; verify at least ten science packs are held.
4. Supply the ten science packs to the existing lab near (47.5, -65.5), replenish its boiler from the ten-coal reserve as needed, and verify automation research completes.

### goal_0rk4jnw_1_p9 — COMMITTED

1. Verify coal-extraction unlocks and resource coverage, then establish the material bill and feasible automatic fuel-delivery design for steam power and smelting.

The final slice concerns coal extraction and automatic fuel delivery; iron/copper/gear/red production-line construction remained outstanding. Full Roadmap Shelf revisions and rejected proposals are retained verbatim in the linked materials.

## Recovery and exercised paths

Counts below are distinct control attempts by mechanism, not independent gameplay incidents. Nested retries are separate from their containing resume/review, and several trace events for one attempt are counted once. Completion means that control mechanism reached its documented continuation boundary; it does not mean the factory goal succeeded. Unresolved means no proved completion/failure before the stop. Per-reason and exact plan/step grouping is in metrics.json.

| Mechanism | Attempted | Completed | Failed | Unresolved |
|---|---:|---:|---:|---:|
| automatic_resume | 3 | 2 | 1 | 0 |
| harness_checkpoint_reconciliation | 1 | 1 | 0 | 0 |
| planner_review | 7 | 5 | 1 | 1 |
| runtime_condition_wake | 1 | 1 | 0 | 0 |
| validation_or_observation_retry | 30 | 18 | 12 | 0 |

There were 23 context restages (normal handoffs and recoveries combined), 17 provider requests explicitly tagged as recovery attempts, and zero operator gameplay recoveries. Restages, advisory normalization and waiting counters are not added as extra recovery incidents.

The run exercised one **harness-owned checkpoint reconciliation** and four bounded review-advisory normalizations. Four deferred batch checkpoints preserved receipt evidence while later work completed. Observation rate control admitted 89 rounds and waited 16 times. It did not exercise the `place_candidate` receipt-variant match event (zero), busy-review deferral (zero), stale-reconciliation fence (zero), or construction reservations (no construction events); those paths remain covered only by their separate offline proofs, not validated by this live result.

## API usage and cost completeness

| Provider / role | Requests | Replies | Cancelled | Input | Cached input | Output | Reasoning tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| CLI-proxy gpt-6.1-sol / planner | 58 | 57 | 1 | 2,056,137 | 819,456 | 24,535 | 11,105 |
| CLI-proxy gpt-6-luna / executor | 172 | 172 | 0 | 5,635,460 | 3,073,152 | 45,264 | 24,617 |
| TypeSafe Jev / semantic checkpoints | 170 | 169 accepted; 170 exchanges | one stale/superseded fallback | unavailable | unavailable | unavailable | unavailable |

All 230 NPC LLM requests were independently recorded: 229 complete replies and one in-flight request cancelled by strict stop. There were no provider failures, no fallback model, no pending LLM calls at closeout and no new LLM/Jev requests after stop submission or confirmation. The last request began at 03:41:12.100Z and was cancelled at 03:41:31.212Z, before stop confirmation at 03:41:31.617Z. Two read-only model-catalog HTTP requests during preflight are not LLM inference requests.

Usage is complete for the 229 completed LLM replies; cancelled-call usage is unknown. Jev reported partial units (592,645 input / 39,164 output), with usage fields present on 155 of 169 accepted responses; these are not assumed to be complete billed token totals. One superseded judgment fell back to deterministic no-judgment handling. Parent/overwatch per-agent token and billing telemetry is unavailable and separate from NPC accounting. Shared weekly remaining quota moved from 54% to 50% during the run; this is not a monetary cost, and no reset credit was used.

**Prices and estimated total: unavailable, USD.** On 2026-10-22 no verified public rate mapping or billing evidence was available for these internal CLI-proxy aliases or the Jev units. All 400 NPC requests are explicitly unpriced; rates, cache rates, pricing source, token-price equivalent, total estimate and actual billed cost remain unknown. No zero-cost claim is made. Reasoning tokens are already included in output and must not be billed twice. A hypothetical subscription token-price equivalent would not establish an incremental charge.

## Tools and native execution

188 traced tool calls returned 188 results: 186 successes and two failures/refusals; six results were cached. Retained assistant material establishes at least 190 attempts, including deferred/refused attempts. Per-tool coalescing telemetry and exact RCON execution counts are unavailable; static knowledge caches may bypass native access even when a result is not marked cached.

| Tool | Attempts ≥ | Calls | Success | Failed/refused | Cached |
|---|---:|---:|---:|---:|---:|
| getRecipeDetails | 44 | 44 | 43 | 1 | 3 |
| getResearchPath | 6 | 6 | 6 | 0 | 0 |
| getMiningDetails | 8 | 8 | 8 | 0 | 1 |
| getActorStatus | 6 | 6 | 6 | 0 | 0 |
| getTechnology | 7 | 7 | 7 | 0 | 0 |
| getInventoryItems | 11 | 11 | 11 | 0 | 0 |
| getEntityStatus | 43 | 43 | 43 | 0 | 2 |
| getNearbyEntities | 13 | 12 | 11 | 1 | 0 |
| estimateProductionTime | 3 | 3 | 3 | 0 | 0 |
| findLongRangeEntities | 8 | 8 | 8 | 0 | 0 |
| getPlacementCandidates | 16 | 16 | 16 | 0 | 0 |
| getEntityGeometry | 2 | 2 | 2 | 0 | 0 |
| getLogisticsTopology | 1 | 1 | 1 | 0 | 0 |
| getEquipmentStatus | 1 | 1 | 1 | 0 | 0 |
| getResearchStatus | 5 | 5 | 5 | 0 | 0 |
| getFluidSourceTiles | 3 | 3 | 3 | 0 | 0 |
| getPrototypeDetails | 8 | 8 | 8 | 0 | 0 |
| getNavigationStatus | 1 | 1 | 1 | 0 | 0 |
| getLocalSpatialObservation | 1 | 1 | 1 | 0 | 0 |
| validateConstructionPlan | 1 | 1 | 1 | 0 | 0 |
| getRecipe | 1 | 1 | 1 | 0 | 0 |
| getPlayerStatus | 1 | 0 | 0 | 0 | 0 |

These tools are observations; structured submission/review tools and world operations are separate in metrics.json. The harness admitted and acknowledged 65 batches; all 65 native batch completions were retained. A tool submission is not counted as a completed game action. Native completed task receipts: walking_to_entity 23, mining 18, placing 13, moving_items 27, waiting 3, crafting 17, harvesting 1, researching 1.

## Time accounting

| Interval / category | Duration | Mean / range |
|---|---:|---|
| All setup before objective, including build/preflight | 13m08.500s | measured envelope; phases overlap |
| Official build | about 88.488s | filesystem log envelope estimate; not instrumented duration |
| Preflight alone | unavailable | attempt timestamps/logs retained separately; no exclusive instrumented duration |
| Trial, objective to strict-stop submission | 60m16.633s | measured |
| Measurement | not entered | no throughput result |
| Strict-stop confirmation | 0.418s | measured |
| Stop/save/native-load/cleanup | 22.077s | measured overlapping envelope from stop submission |
| planner completed LLM requests | 1116.528s total | 19.588s mean; 2.792–125.269s |
| executor completed LLM requests | 1370.633s total | 7.969s mean; 1.991–26.233s |
| Jev accepted requests | 31.093s total | 0.184s mean; 0.108–0.400s |
| Native crafting segments | 97.708s | 17 segments; 5.748s mean |
| Native harvesting segments | 1.030s | 2 segments; 0.515s mean |
| Native mining segments | 214.878s | 24 segments; 8.953s mean |
| Native moving_items segments | 0.264s | 31 segments; 0.009s mean |
| Native placing segments | 0.117s | 14 segments; 0.008s mean |
| Native researching segments | 0.007s | 1 segments; 0.007s mean |
| Native waiting segments | 139.987s | 3 segments; 46.662s mean |
| Native walking_to_entity segments | 188.405s | 35 segments; 5.383s mean |

LLM wire intervals occupy a union of 2,500.432s (41m40.432s), including the cancelled call; LLM plus inferred Jev intervals occupy 2,528.830s. Tool envelopes occupy a union of 12.872s. Recovery/review intervals and full latency ranges are retained in metrics.json. Native `researching` measures dispatch, not all background research time; background production/research and exhaustive exclusive waiting durations are unavailable. These views overlap and must not be summed into an artificial wall-time partition.

**Measured thinking duration is unavailable.** Request latency includes generation, queueing and network time. Reasoning token counts are a usage metric, not a duration; no private reasoning was requested.

## Evidence limitations

Every completed ordinary assistant reply and complete tool argument payload was captured, including all planner drafts and reviews. One executor request row is missing from the retained prompt trace: `tap_137`, response `resp_0b040dda94c7cad5016adad18bf66c87d1a8cd2b72efcf7739`, at 03:16:28.760Z. Its request timestamp/model/body hash and complete reply survive in the independent recorder and its response survives in the prompt trace. Accounting identifies it explicitly; its exact original input context is unavailable and was not reconstructed. The cause of that missing row is unproved. Recorder health reports zero recording errors. Canonical planning snapshots occur every 90 seconds and at termination; original issued responses supplement transient state changes.

Trace sources: current and rotated `sgluna-prompts.jsonl`, `sgluna-behavior.jsonl`, `sgluna-decision.jsonl`; `provider-full-responses.jsonl`; planning-state/world histories; final NPC state; Factorio native log. Structured rows are deduplicated across retained rotations and calls correlated by request/round/recovery identity plus response IDs. Independent recorder identity supplies the one missing request. Counts include trace activity after stop so boundary violations cannot disappear. Units are milliseconds/tokens/counts as labelled; missing values remain unavailable, not zero.

## Stop, save, and teardown

Fresh supervisor cancellation and same-goal operator pause were confirmed for goal `goal_0rk4jnw_1`, actor 18; native task state idle, queues empty and crafting queue empty. The checkpoint was saved after that boundary, passed full ZIP CRC/structure validation (55 entries), and loaded in a pristine exact-version Factorio 2.0.77 benchmark with all 32 native mod files matching. Save SHA-256: `6ae3ae84af094ce7e188ffe357021fb8228205abf9ed581129e08162c3a42d24`.

Exact project `red-automation-20261022an`, live container `red-automation-20261022an-sgluna-factorio-1`, run-owned proof containers, networks, disposable volumes, all three recorded SSH tunnel identities, recorder/listeners, unique image tag and zero-byte task configuration marker are absent. Final inventory verified all recorded container references and the static-gate names. Evidence, task checkout and shared development/archive images remain for preservation/reuse; no owned live resource or background agent remains. [final cleanup proof](../../test-results/red-automation-live-2026-10-22an/analysis/final-cleanup.json).

No runtime repair, second trial, push or production deployment was performed. This result establishes bootstrap progress and the exercised harness behavior, not an automated science factory.
