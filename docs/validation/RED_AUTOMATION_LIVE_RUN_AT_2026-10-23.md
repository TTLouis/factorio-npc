# Run AT: entity refresh recovered; polling guard stopped construction

The harness corrected the expired furnace binding and verified the copper/electronics checkpoint without an operator or a corrective model call. The science goal still failed: construction ended after **10 m 31.795 s** at the strict stop boundary (`trial_invariant_changed`); runner elapsed was 10 m 32.222 s. No automation-science packs were produced.

The later blocker was `Sprint harness polling budget exhausted`. This is a separate guard failure, not a repeat of AS’s unrecovered furnace binding. All 39 sprint bursts restored; the fault did not grant completion or a fresh allowance. No manual resume, corrective gameplay prompt, second trial or provider retry was performed.

## Frozen candidate and run

Local reviewed candidate `9b4037679688612f75ac1c49df6b188d6cf2adbc`; runtime approval `9a3c9e42`, source `a6989b92`. Published Jev was freshly checked as `b9574fc4556eafb431f158ebee80fe3f1807a02d`. Run branch `test/run-at-red-automation`, owning Codex /root `chat01a16ab4`. No push or production deployment.

Payload source `a6989b92965e4cb14c5b78757d804efa1fd57d25`, SHA-256 `6d9ff05468d450708b8ae00650f825380291c5022206f8963154512688245be4`. Official local-source build and 72 shipped runtime/prompt/manifest checks plus 32 independent native file checks matched exactly. Factorio 2.0.77. Fresh offline gates: 3,343 runtime/1,378 mod, type/Lua/generated-Lua, payload 9, runner 45, recorder 1, ZIP checker 10; derived recovery accounting 5 tests pass.

One cold isolated project `red-automation-20261023at`, fresh actor 1/seed 3164632854, zero humans, empty inventory/board/native queues before the one declared vanilla starter. The frozen accelerated profile retains 1× baseline, bounded 4× sprints, 600 native ticks / 3 wall seconds bursts and 3,600 ticks per wait episode. Native 14-case adoption/lifecycle/fault proof from AR remains applicable to unchanged sprint files; AT additionally required current exact guard/startup-clock/source matches. Results are separate from normal-speed baselines.

Effective NPC roles: CLI-proxy planner `gpt-6.1-sol`, executor `gpt-6-luna`; dedicated Jev `jev-1.14.0`. Independent read-only Luna overwatch finished with the trial; its [final review](../../test-results/red-automation-live-2026-10-23at/overwatch/final-review.md) corroborates recovery, failure and stop/load limits.

## Verified recovery and remaining failure

At 01:59:20.855Z, mutation validation detected furnace 3’s missing request binding in p3/v1/step 3. At 01:59:24.788Z the harness verified the same native entity. It discarded the previous proposal, collected the existing 10 copper plates through `collection_only`, then ordinary native/checkpoint validation closed the step at 01:59:35.143Z. Detection-to-verified-settlement span: 14.288 s, overlapping reads and native work.

**Entity refresh: 1 attempted, 1 completed, 0 failed.** Three phase events are one recovery. This naturally exercised `operation_validation` refresh and collection continuation. It did not exercise the injected `admission_residual` miss, restart/exhaustion, stale-owner, native-busy or uncertain-effect fences; those retain their separate offline/native regression proof. No gather-recovery or nearby-coordinate-correction event occurred.

At 02:05:31.679Z, the sprint controller faulted on its 1,200 control-reads-per-monotonic-minute limit and guard-paused the goal. The fault’s cumulative counters were boundary_restore 6152, eligibility 71, arm 39, identity_refresh 78, inventory_refresh 39, configure 1 and emergency_control 1. These are cumulative lane counts, not 6,152 reads in the failed minute. The source throws after exceeding the 1,200 bucket limit; the exact rejected bucket count was not logged. The runner observed the faulted guard and classified `trial_invariant_changed`, even though the world was at 1×.

The NPC had completed 6 of 7 committed steps and established a physical burner-drill→furnace iron feed. Native production reached 10 copper plates and 41 iron plates; final held stock was 10 copper plates, 10 copper ore and 39 iron plates, with 10 more iron plates in furnace 5. The active contract required 58 held iron plates and steam-power research, so it remained unmet. Measurement never began.

One checker finding, `stale_step_tracker_behind_batch` after batch 33, is retained. It is not by itself proof that the tracker should advance: the 58-held-plate/research contract was still false. There was no `exact_entity_binding_unrecovered` finding.

The trace also records an executor-issued second 10 copper-ore gather after supplying the first 10 ore to the furnace. It left 10 extra ore held. This observed over-acquisition is separate from the collection-only recovery; the recovery did not replay supply. The exact admissions and terminal state are retained in [failure evidence](../../test-results/red-automation-live-2026-10-23at/analysis/run-at-failure-fixture.json).

## Recovery accounting

| Mechanism / reason | Attempted | Continued/completed | Failed | Scope |
| --- | ---: | ---: | ---: | --- |
| Harness entity refresh | 1 | 1 verified checkpoint | 0 | p3/v1/s3, furnace 3 |
| Validation retry: requirements_grounding | 1 | 1 | 0 | Initial draft; no committed step |
| Validation retry: observation_decision_pressure | 2 | 0 | 2 | p4/s2 and p4/s4 |
| Validation retry: observation_decision_budget_complete | 1 | 1 | 0 | p4/s2 |
| Validation retry: invalid_production_task | 1 | 1 | 0 | p4/s4 |
| Planner review: approach_infeasible | 1 | 1 notes/continuation | 0 | p4/s2 |
| Automatic resume | 0 | 0 | 0 | No operator resume |
| Gather / production-controller residual recovery | 0 | 0 | 0 | Unexercised |

Five validation retries produced 3 continuations and 2 attempts superseded by the next classified retry; these are control outcomes, not three native gameplay repairs or provider errors. Planner review can contain a retry, so the table is not a sum of distinct physical recoveries. Four context restages include normal role handoffs and are counted separately. Automatic resumes 0, operator gameplay interventions 0. Full owner/reason/mechanism groups and evidence references are in [metrics](../../test-results/red-automation-live-2026-10-23at/analysis/metrics.json), [entity metrics](../../test-results/red-automation-live-2026-10-23at/analysis/entity-refresh-metrics.json) and [controller metrics](../../test-results/red-automation-live-2026-10-23at/analysis/controller-metrics.json).

## Tool and native action counts

| Observation tool | Attempts lower bound / traced calls | Results / failures | Cached | Envelope total / mean seconds |
| --- | ---: | ---: | ---: | ---: |
| getRecipeDetails | 7 / 7 | 7 / 0 | 0 | 2.095 / 0.299 |
| getResearchPath | 1 / 1 | 1 / 0 | 0 | 0.378 / 0.378 |
| getMiningDetails | 2 / 2 | 2 / 0 | 0 | 0.809 / 0.405 |
| getPlacementCandidates | 6 / 6 | 6 / 0 | 0 | 2.071 / 0.345 |
| getInventoryItems | 2 / 2 | 2 / 0 | 0 | 0.950 / 0.475 |
| getActorStatus | 4 / 4 | 4 / 0 | 0 | 1.414 / 0.353 |
| getEntityStatus | 5 / 5 | 5 / 0 | 0 | 3.116 / 0.623 |
| getTechnology | 1 / 1 | 1 / 0 | 0 | 0.433 / 0.433 |
| estimateProductionTime | 2 / 2 | 2 / 0 | 0 | 0.901 / 0.451 |
| findLongRangeEntities | 2 / 2 | 2 / 0 | 0 | 0.452 / 0.226 |
| getNavigationStatus | 1 / 1 | 1 / 0 | 0 | 0.139 / 0.139 |
| getNearbyEntities | 1 / 1 | 1 / 0 | 0 | 0.338 / 0.338 |
| getEquipmentStatus | 1 / 1 | 1 / 0 | 0 | 0.324 / 0.324 |
| getLogisticsTopology | 1 / 1 | 1 / 0 | 0 | 0.193 / 0.193 |

All 36 traced observation envelopes returned uncached results; one `getEntityStatus` call was harness-owned. Exact distinct native execution and coalescing totals are unavailable from these envelopes, not zero. Additional production-controller reads: getActorStatus 43, getEntityStatus 44, getInventoryItems 25, getRecipeDetails 50 (162 completed reads; failed attempts and individual durations unavailable). Sprint control reads above are separate again.

Provider responses returned 47 tool calls: 35 observation calls and 12`submitPlan` control calls. There were 35 normalized parsed proposals, which are not all executed actions. Native world operations follow their own channel:

| Admitted operation | Count |
| --- | ---: |
| gather_resource | 4 |
| place_entity | 2 |
| supply_entity | 3 |
| move_items_exact | 14 |
| mine_entity_exact | 1 |
| walk_to_position | 1 |
| place_candidate | 1 |
| wait | 8 |

There were 34 admitted operations across 33 batches, 33 acknowledgements and 33 native completed-batch receipts. Native receipts contain 39 tasks: 5 walking, 5 mining, 3 placing, 18 transfers and 8 waits. Internal walk/resume markers are not additional model actions. Admission alone is not checkpoint or goal completion.

## Timing

| Measured or explicitly labelled interval | Total seconds | Mean / range seconds |
| --- | ---: | --- |
| Official pinned build | 87.880 | Separate from trial |
| Cold preflight | 34.490 | Separate from build |
| Objective submission → strict stop submission | 631.795 | 60 minute construction cap |
| Planner requests (14) | 223.256 | 15.947; 3.383–66.244 |
| Executor requests (28) | 185.365 | 6.620; 3.001–11.364 |
| Jev requests (36) | 9.158 | 0.254; 0.117–0.867 |
| LLM wire interval union | 405.225 | Overlap deduplicated |
| LLM+Jev interval union | 412.815 | Jev intervals inferred from response latency |
| Observation envelope interval union | 7.521 | Per-tool sum can overlap |
| Entity-refresh detection → verified close | 14.288 | Trace wall span; overlaps native/tools |
| Strict stop confirmation | 0.367 | Included in stop/save/cleanup |
| Stop submission → wrapper cleanup complete | 27.458 | Save, integrity and pristine load included |
| Measurement | 0 | Not entered |

| Native task segments | Segment count | Wall seconds | Mean seconds |
| --- | ---: | ---: | ---: |
| mining | 6 | 33.322 | 5.554 |
| moving_items | 19 | 0.099 | 0.005 |
| placing | 5 | 0.031 | 0.006 |
| waiting | 8 | 13.785 | 1.723 |
| walking_to_entity | 9 | 35.069 | 3.897 |

Native segment durations come from Factorio process-log timestamps; resumed placement/navigation segments can exceed top-level task counts. No crafting task was traced. Exclusive passive smelting/research wait time and total idle time are unavailable; native wait segments are shown. Recovery retry spans, world work, LLM/Jev latency and tool envelopes can overlap, so these categories must not be added as a wall-time partition. Request latency includes generation, queueing and network time. **Measured thinking duration is unavailable**; reasoning tokens below are not a duration.

Accelerated telemetry: 39/39 bursts restored, 6,128 actual sprint ticks, 6,133 native checks;28.610 s measured sprint wall time. The estimated 1× equivalent is 102.133 s and estimated native-time saving 73.523 s. These estimates are not a separate measured normal-speed baseline or an end-to-end saving. One fault occurred before stop submission; none during/after confirmation.31 episode-budget refusals are bounded lease refusals, not 31 failed recoveries.

## Model usage and price completeness

| Provider/model/role | Requests / responses | Input | Cached input | Uncached input | Output | Reasoning included in output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CLI-proxy gpt-6.1-sol / planner | 14 / 14 | 414,305 | 173,824 | 240,481 | 7,618 | 2,419 |
| CLI-proxy gpt-6-luna / executor | 28 / 28 | 837,355 | 496,000 | 341,355 | 5,010 | 2,759 |
| Jev 1.14.0 / semantic checkpoints | 36 / 36 | unavailable tokens | unavailable | unavailable | unavailable tokens | unavailable |

NPC CLI totals: 42 requests/42 responses, 0 errors/cancellations/fallbacks;1,251,660 input, 669,824 cached, 581,836 uncached, 12,628 output and 5,178 reasoning tokens already included in output. All 42 wire responses have complete capture and original request bodies; recorder errors 0. Jev 36 requests/responses and 0 failures/fallbacks; partial trace-reported units 106,058 input/7,286 output have fields on 32 of 36 responses, but their token/billing mapping and completeness are unknown. Reported Jev cost 0 is not proof of free usage. No NPC/Jev request started after stop submission or confirmation. Two preflight model-catalog GETs are separate from inference.

Estimated USD cost per provider/model/role and total: **unavailable/partial**, with 78 unpriced inference requests. Rates and pricing sources are unavailable for the configured internal aliases/Jev mapping as of 2026- 10- 24 UTC; no verified public-alias mapping or billing record is retained. No assumed cache rate or extra reasoning charge is applied. A subscription token-price equivalent would differ from an incremental charge. Parent/overwatch use Codex quota; per-agent tokens/cost are unavailable and excluded from NPC totals. Quota percentages are not monetary cost.

## Actual plans

> Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.

The retained Roadmap Shelf has 10 nodes: Unlock electronics; Unlock steam power; Unlock automation science; Establish steam electricity; Research automated assembly; Automate fuel delivery; Automate iron plate supply; Automate copper plate supply; Automate iron gear production; Sustain automated science output. These are future intentions, not executed factories. Only p3 and p4 committed; issued/rejected drafts and review notes remain separately labelled.

| Committed plan / step | Description copied from canonical plan | Final outcome |
| --- | --- | --- |
| p3/v1/s1 | Acquire 10 copper ore and 4 coal for the electronics bootstrap. | completed |
| p3/v1/s2 | Place the held stone furnace for copper smelting and obtain its live identity. | completed |
| p3/v1/s3 | Fuel the furnace, smelt and collect 10 copper plates, and verify electronics is researched. | completed |
| p4/v1/s1 | Recover the existing stone furnace and assemble a bootstrap kit of 1 burner mining drill, 1 stone furnace and 12 coal. | completed |
| p4/v1/s2 | Install the burner mining drill over iron ore and observe its exact identity and item-output position. | completed |
| p4/v1/s3 | Install the recovered furnace covering the drill’s observed output position, then observe its identity and verify the direct-feed connection. | completed |
| p4/v1/s4 | Fuel both machines, produce and collect 50 additional iron plates, and verify steam-power is researched. | active |

Full goal/Shelf/history, step execution guidance, completion contracts and outcomes: [readable plans](../../test-results/red-automation-live-2026-10-23at/analysis/plans.md), [canonical structured copies](../../test-results/red-automation-live-2026-10-23at/analysis/canonical-plans.json), [original full issued responses](../../test-results/red-automation-live-2026-10-23at/analysis/full-issued-responses.json) and [request/response/source/observation provenance](../../test-results/red-automation-live-2026-10-23at/analysis/plan-provenance.json). They preserve actual messages and snapshots; no cleaner replacement plan is presented as original.

## Stop, preservation and cleanup

Strict fresh supervisor cancellation and same-goal operator pause were confirmed in 367 ms; native queues/crafting were empty and idle. Save followed that boundary: 907,146 bytes, 56 ZIP entries, full CRC/integrity PASS. A pristine copy loaded with exact Factorio 2.0.77 and the 32-file active native mod match; exit 0. Wrapper exit 0 establishes closeout only, not gameplay success.

All 13 recorded container IDs/12 names are absent including stopped state, along with the exact Compose network/volumes, tunnel, recorder/listeners and unique run image tag. Temporary configuration link removed; shared configuration was not read/modified, shared cached images and host evidence/saves retained. Foreground `--rm` proof identities are also retained from daemon create/start/die/destroy events. No background work remains.

Raw evidence is sealed: 238 files/19,187,286 bytes; manifest SHA-256 `57628bbfd1d17bfe7ae3f207dfcfd621e961ded85ae3cb4a5abe68626b953e13`. All 53 frozen helper inputs, 216 AR+222 AShistorical sealed files and 31 historical reports rehash unchanged. Derived analysis and overwatch are outside the seal. [Machine closeout](../../test-results/red-automation-live-2026-10-23at/analysis/final-summary.json), [raw seal](../../test-results/red-automation-live-2026-10-23at/raw-seal.json), [cleanup verification](../../test-results/red-automation-live-2026-10-23at/analysis/cleanup-final.json).

The next bounded repair is polling amplification/budget exhaustion at the shared restoration boundary, with prevention and bounded residual recovery that preserve freshness and limits. Raising the guard threshold alone is insufficient. This run authorizes no implementation or second trial.
