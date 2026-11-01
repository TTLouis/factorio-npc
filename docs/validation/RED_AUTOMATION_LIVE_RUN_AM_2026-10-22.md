# Run AM: autonomous red science, 2026-10-22

**Gameplay acceptance: FAIL.** Result `construction_wall_limit_60_minutes` after 60.142 wall minutes. Native new red packs: **0**. Measurement was not entered. No placement, admission, slice completion or successful wrapper exit is counted as gameplay success.

Frozen local Jev candidate `01ec0a1015eb76320a4b061ae2dba397d7c761f7`; freshly fetched published Jev `b9574fc4556eafb431f158ebee80fe3f1807a02d`. The local candidate includes the reviewed multi-batch contract fix and Shelf guidance. Source stayed fixed. Actor `8`, goal `goal_1a7uduh_1`, seed `1616149025`. Planner `gpt-6.1-sol`; executor `gpt-6-luna`; independent read-only overwatch `gpt-6-luna`.

!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.

The trial began cold with zero humans, an empty board, empty inventory and no machines. The declared vanilla starter was given once: eight iron plates, one burner drill, one stone furnace, a pistol and ten magazines. Construction ran at speed 1 under the reviewed 60-minute cap. There were zero corrective gameplay prompts and zero operator gameplay recoveries. The parent followed the frozen terminal policy through the observed stall.

## What stopped progress

The first iron slice completed: fuel supply and plate collection occurred in separate native batches, at least 50 new iron plates were produced/collected, and steam-power unlocked. The copper slice then placed copper drill unit 17 using `place_candidate`. Its immutable step contract also demanded an `authoritative_operation_receipt` named `place_entity`; the recorded operation name was `place_candidate`, so the step remained unmet despite native placement.

A planner review returned the same committed step with notes forbidding a duplicate drill or dismantling the valid drill to manufacture a receipt. A later executor review rationale was 402 characters. Both the transmitted schema and runtime allow at most 400, so this was a model output violation rather than a disagreement between those two limits. The runtime refused it and emitted `request.completed` with `outcome=blocked_before_mutation`, while canonical plan execution and the runner stayed `EXECUTING` / `controller_running`. No subsequent provider traffic occurred before the construction cap. This exposes a completion receipt-name/reconciliation problem and a terminal-liveness gap after the refused review.

[Exact step, original review, lengths and native correlation](../../test-results/red-automation-live-2026-10-22am/analysis/stall-evidence.json); [all original issued responses with validation/disposition provenance](../../test-results/red-automation-live-2026-10-22am/analysis/full-issued-responses.json).

The interval from the last LLM response to stop submission was 41.512 minutes. This is an exact trace interval, not measured thinking time or an exclusive waiting partition. Native final production: iron-ore=146, copper-ore=0, coal=62, iron-plate=146, copper-plate=0, iron-gear-wheel=0, automation-science-pack=0.

## Source, gates and exercised paths

The official local builder pinned the source; deployed content matched 62 runtime modules, 32 independently compiled native files, the active prompt source and release manifest. Factorio was exactly 2.0.77 (build 84539). Zero-inference provider preflight verified both configured role models, CLI-proxy contracts, 44 closed-round tools and dedicated Jev credentials without reading or printing owner configuration. The loopback-only full-response recorder passed a compressed large-response forwarding test and an exact deployed-container-to-recorder health probe before provider access.

Frozen-head Docker gates passed: 3,082 runtime tests; 1,346 mod tests; typecheck, Lua build and generated-Lua checks; 44 runner/helper tests; nine payload tests; ten archive tests; one recorder test. Cleanup inventory negative controls also passed. An initial payload invocation omitted its read-only Compose mount (8/9 passed); the corrected mount passed all nine before the trial. Cold local RCON readiness needed six attempts; these were not provider retries. The compact observer could not handle the pre-plan state on its first read; the parent used the unchanged general observer thereafter. Neither affected gameplay or frozen controls.

Observed changed-path events: observation-rate admissions 28; rate waits 6; deterministic step checks 21; deferred multi-receipt batch events 1. The ledger retained verified operation names across batches. The exact Run AL contract requiring both supply and collection receipts was not selected in the completed iron step, so this trial does not independently reproduce that precise regression fixture. Reservation/designer/tile restoration paths were not established by this trial. Shelf wording was exercised in the actual ten-node draft; that is evidence of the model's output, not proof of universally consistent scope.

[verify-deployment.log](../../test-results/red-automation-live-2026-10-22am/verify-deployment.log); [verify-native-mod.log](../../test-results/red-automation-live-2026-10-22am/verify-native-mod.log); [helper-manifest.json](../../test-results/red-automation-live-2026-10-22am/helper-manifest.json); [machine-readable metrics](../../test-results/red-automation-live-2026-10-22am/analysis/metrics.json).

## Actual goal, Shelf and plan slices

The outline below copies canonical descriptions and statuses; it is not the complete plan payload. Full guidance, contracts, observed revisions and outcomes are in [analysis/canonical-plans.json](../../test-results/red-automation-live-2026-10-22am/analysis/canonical-plans.json) and [analysis/plans-readable.md](../../test-results/red-automation-live-2026-10-22am/analysis/plans-readable.md). Complete original ordinary assistant content and tool arguments, including held/rejected proposals and planner notes, are in [analysis/full-issued-responses.json](../../test-results/red-automation-live-2026-10-22am/analysis/full-issued-responses.json). Explicit provider reasoning fields were excluded; private chain-of-thought was neither requested nor fabricated. Every archived response links to the exact wire request containing its prompt, observations and prior tool results. See [analysis/plan-provenance.json](../../test-results/red-automation-live-2026-10-22am/analysis/plan-provenance.json).

Shelf `goal_1a7uduh_1_r2`:

- `iron-supply`: Establish natural-resource iron supply [partially_realized].
- `copper-supply`: Establish natural-resource copper supply [ready_to_refine].
- `science-access`: Unlock automation science [tentative].
- `electricity`: Establish working steam electricity [tentative].
- `assembly-unlock`: Research assembly automation [tentative].
- `automatic-fuel`: Automate natural-resource fuel delivery [tentative].
- `iron-delivery`: Automate iron plate delivery [tentative].
- `copper-delivery`: Automate copper plate delivery [tentative].
- `gear-production`: Automate iron gear production [tentative].
- `science-production`: Sustain automated science production [tentative].

Plan `goal_1a7uduh_1_p3` [COMPLETED]:

1. [completed] Acquire 20 coal for the initial iron cell.
2. [completed] Install the held burner mining drill on iron ore; obtain its fresh identity and actual output position.
3. [completed] Install the held stone furnace at the observed drill output; obtain its fresh identity and verify the direct-feed relationship.
4. [completed] Fuel both machines, produce and collect 50 additional iron plates, and verify the steam-power production-trigger unlock.

Plan `goal_1a7uduh_1_p4` [EXECUTING]:

1. [completed] Acquire 10 stone for the copper cell’s two furnace crafts.
2. [completed] Craft one burner mining drill and one additional stone furnace, using 9 iron plates and 10 stone in total.
3. [completed] Acquire 20 coal for the copper drill and furnace.
4. [active] Install the new burner mining drill on copper ore; observe its fresh identity, resource coverage, and actual output position.
5. [pending] Install the new stone furnace over the observed drill output; observe its fresh identity and verify the direct-feed relationship.
6. [pending] Fuel the copper cell, produce and collect 10 copper plates, and verify electronics is researched.

## Recovery accounting

One row per explicit retry classification, auto-resume start, correlated runtime wake or executor review request; the runtime start belonging to an auto-resume is not counted twice. Completed means the correlated control attempt returned and committed/admitted work, returned same-step planner notes or re-entered waiting before another retry/failure. It does not mean the gameplay goal succeeded. Missing plan/step IDs use explicitly labelled temporal attribution from canonical committed/completed timestamps and ordered step completed_at values; pre-commit or unresolved cases remain unknown. The goal is the one runner-verified immutable goal. Normal context handoffs are separate.

| Mechanism / reason | Plan / step | Attempted | Completed | Failed | Unresolved |
| --- | --- | ---: | ---: | ---: | ---: |
| validation_or_observation_retry / requirements_grounding | unknown / unknown | 1 | 1 | 0 | 0 |
| runtime_condition_wake / condition_wake | goal_1a7uduh_1_p3 / goal_1a7uduh_1_p3_v1_s4_0yfw3q4 | 2 | 2 | 0 | 0 |
| validation_or_observation_retry / duplicate_observation | unknown / unknown | 1 | 0 | 1 | 0 |
| validation_or_observation_retry / observation_decision_pressure | unknown / unknown | 1 | 1 | 0 | 0 |
| validation_or_observation_retry / semantic_completion_contract_exists | goal_1a7uduh_1_p4 / goal_1a7uduh_1_p4_v1_s4_092rluk | 2 | 1 | 1 | 0 |
| planner_review / local_recovery_exhausted | goal_1a7uduh_1_p4 / goal_1a7uduh_1_p4_v1_s4_092rluk | 2 | 1 | 0 | 1 |
| automatic_resume / None | goal_1a7uduh_1_p4 / goal_1a7uduh_1_p4_v1_s4_092rluk | 1 | 0 | 1 | 0 |
| validation_or_observation_retry / invalid_planner_review | goal_1a7uduh_1_p4 / goal_1a7uduh_1_p4_v1_s4_092rluk | 4 | 0 | 4 | 0 |
| validation_or_observation_retry / observation_decision_pressure | goal_1a7uduh_1_p4 / goal_1a7uduh_1_p4_v1_s4_092rluk | 1 | 0 | 1 | 0 |

Automatic resumes started: 1; executor review requests: 2; planner review rounds actually executed: 1; notes returned: 1; context restages: 7. Operator gameplay recovery: 0. Full episode evidence and folded-restage records are in metrics.json.

## Tools and native work

| Tool | Class | Attempt lower bound | Traced calls | Results | Success | Failed/refused | Cached |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| findLongRangeEntities | observation | 1 | 1 | 1 | 1 | 0 | 0 |
| getCraftingStatus | observation | 1 | 1 | 1 | 1 | 0 | 0 |
| getEntityStatus | observation | 17 | 17 | 17 | 17 | 0 | 0 |
| getInventoryItems | observation | 7 | 7 | 7 | 7 | 0 | 0 |
| getMiningDetails | observation | 4 | 4 | 4 | 4 | 0 | 0 |
| getPlacementCandidates | observation | 5 | 5 | 5 | 5 | 0 | 0 |
| getRecipeDetails | observation | 11 | 11 | 11 | 11 | 0 | 2 |
| getResearchPath | observation | 1 | 1 | 1 | 1 | 0 | 0 |
| getResearchStatus | observation | 3 | 2 | 2 | 2 | 0 | 0 |
| getTaskStatus | observation | 2 | 2 | 2 | 2 | 0 | 0 |
| getTechnology | observation | 6 | 6 | 6 | 6 | 0 | 0 |

Structured submission tool counts, separate from ordinary tool results: `{'submitPlan': 34}`. Provider-returned tool calls: 92. World operations admitted: `{'gather_resource': 6, 'place_candidate': 3, 'supply_entity': 6, 'move_items_exact': 6, 'craft_item': 3}` across 21 batches and 21 acknowledgements. Native logged batches started/completed: 21/21; native completed receipt task counts: `{'walking_to_entity': 6, 'mining': 6, 'placing': 3, 'moving_items': 12, 'crafting': 3}`.

Classifications use the frozen structured-policy observation registry, not name prefixes. Per-tool coalescing and exact RCON execution counts are unavailable; `cached=false` can still use static prototype facts. Deferred requests are not executed reads. Structured submissions are parsed/admitted separately from native receipt completion. Internal walking/resumed placement markers are not extra top-level game actions.

## API usage, latency and prices

| Provider/model/role | Requests/replies/errors | Input | Cached input | Uncached input | Output | Reasoning (within output) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| CLI-proxy / gpt-6.1-sol / planner | 14/14/0 | 405,283 | 123,520 | 281,763 | 8,737 | 2,741 |
| CLI-proxy / gpt-6-luna / executor | 55/55/0 | 1,592,760 | 966,400 | 626,360 | 14,424 | 8,556 |
| TypeSafe / {'jev-1.14.0': 55} / semantic checkpoints | 55/55/0 | unknown | unknown | unknown | unknown | unknown |

CLI-proxy cancellations/unanswered: 0; request rows marked recovery_attempt>0: 5; provider fallback events: 0. Jev exchanges: 55; fallback events: 0. Requests after stop submission/confirmation: CLI 0/0, Jev 0/0. Full request records: [analysis/provider-calls.json](../../test-results/red-automation-live-2026-10-22am/analysis/provider-calls.json).

All 69 wire responses have complete original response captures. CLI usage is marked complete for 69 calls. Jev trace-reported units input/output: 187026/12874; trace-reported partial cost USD 0. Missing Jev fields can be defaulted to zero by runtime, so neither full token usage nor billing completeness is established. Codex orchestration/overwatch per-agent tokens and billing are unavailable and excluded from NPC totals.

Estimated prices (USD, assessment date 2026-10-22): CLI-proxy planner rate/estimate **unknown**; CLI-proxy executor rate/estimate **unknown**; TypeSafe full applicable rates/estimate **unknown**; total estimate and actual billed total **unknown**. No verified public price mapping exists in the retained evidence for the internal model aliases, and no invoice is available. Pricing source and cache-specific rates are unavailable; all calls remain unpriced in the estimate. A subscription token-price equivalent would not establish an incremental charge. Reasoning tokens are already inside output and must not be counted twice. Quota percentages are not money.

| Timing view | Total minutes | Mean / range where exposed |
| --- | ---: | --- |
| Build plus preflight envelope | 7.462 | source intent to trial start; parallel work overlaps |
| Trial through strict stop receipt | 60.142 | 60-minute construction policy, checked every 90s |
| Measurement | 0.000 | not entered |
| Stop submission through save/load/cleanup | 0.305 | separate closeout envelope |
| planner LLM requests | 5.015 | mean 21491.929ms; range 3356–104697ms |
| executor LLM requests | 7.514 | mean 8197.382ms; range 2040–24635ms |
| Jev requests | 0.182 | mean 198.309ms; range 137–309ms |
| Tool batch envelope union | 0.071 | individual per-tool ranges in metrics |
| LLM + inferred Jev interval union | 12.667 | overlapping intervals merged |
| Native logged crafting segments | 0.077 | 3 segments; mean 1537.667ms; range 1042.0–2014.0ms |
| Native logged mining segments | 2.424 | 10 segments; mean 14544.9ms; range 16.0–40431.0ms |
| Native logged moving_items segments | 0.002 | 17 segments; mean 8.353ms; range 1.0–18.0ms |
| Native logged placing segments | 0.001 | 6 segments; mean 10.0ms; range 2.0–18.0ms |
| Native logged walking_to_entity segments | 0.629 | 18 segments; mean 2095.278ms; range 66.0–10780.0ms |

These timing categories overlap and must not be added into a wall-time partition. Separate thinking duration is unavailable: LLM latency includes generation, queueing and network time. Exhaustive exclusive waiting and separately measured crafting/research duration are unavailable where no native segment was emitted. Recovery steering spans, per-call timing ranges, raw task segments and explicitly labelled filesystem build estimates are retained in metrics.json and timing-evidence.json.

## Stop, save, load and cleanup

Strict stop used a fresh supervisor cancellation plus same-goal operator pause, with idle native state, empty operation/crafting queues and cleared intake retry. Fresh checkpoint: 958,414 bytes, all 56 ZIP entries checked for integrity; SHA256 `d0e1e91f3d1e02feb3cfc12b1ed721a6903847b53e6e1345350043520f2e2a9d`. The pristine copy loaded in isolated Factorio 2.0.77 with all 32 native files matching; original and copy save hashes remained equal. Wrapper closeout passed. Recorded owned containers, project networks/volumes, unique image tag, SSH tunnel, response-recorder process/listener and zero-byte task configuration marker were removed. Shared development/archive images and `factorio-npc:local`, evidence and the task checkout were retained. No background live work remains.

[data/logs/final-save-proof.json](../../test-results/red-automation-live-2026-10-22am/data/logs/final-save-proof.json); [native-save-load/active-mod-match-proof.json](../../test-results/red-automation-live-2026-10-22am/native-save-load/active-mod-match-proof.json); [analysis/final-cleanup.json](../../test-results/red-automation-live-2026-10-22am/analysis/final-cleanup.json); [analysis/verification.log](../../test-results/red-automation-live-2026-10-22am/analysis/verification.log); [overwatch/final-review.md](../../test-results/red-automation-live-2026-10-22am/overwatch/final-review.md).

Runtime run-check findings: 3; details are in [analysis/run-check.json](../../test-results/red-automation-live-2026-10-22am/analysis/run-check.json). Independent overwatch observations are retained under overwatch/. Evidence integrity is recorded in [analysis/evidence-seal.json](../../test-results/red-automation-live-2026-10-22am/analysis/evidence-seal.json) and [analysis/evidence-manifest.json](../../test-results/red-automation-live-2026-10-22am/analysis/evidence-manifest.json). Raw historical runs were not rewritten.
