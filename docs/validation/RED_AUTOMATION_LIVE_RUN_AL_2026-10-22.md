# Run AL — red-science automation, October 22, 2026

**Gameplay failed after 360.888 seconds (6.0148 minutes).** The controller paused on `deterministic_checkpoint_rejected: operation_receipt_not_semantically_grounded; requirement=requirement_2`. It had gathered 20 coal and placed the starter drill and furnace, but had produced **zero new iron plates, copper plates, or automation science packs**. The board had completed three of four steps in its first iron-bootstrap slice. No throughput measurement or success acceptance occurred.

Strict stop, post-stop save integrity, pristine Factorio 2.0.77 load, and owned-resource cleanup passed. Wrapper exit 0 means the trial closed safely; it does not mean the factory worked. No corrective gameplay prompts, manual resume, provider retry, second trial, push, or deployment occurred.

## Frozen candidate and procedure

- Latest local Jev integration candidate: `695eea0223015e7b0557747d5d71979249f7c280`, frozen throughout this run. Freshly fetched published Jev: `b9574fc4556eafb431f158ebee80fe3f1807a02d`. This tested the newer local candidate, including construction prompts/contracts, burst/refill observations, and reservations.
- Task checkout/branch: `.worktrees/test-run-al-red-automation`, `test/run-al-red-automation`; parent `/root`, session `01a16167`, owned the run. No runtime/source changes during the trial.
- Evidence: [Run AL directory](../../test-results/red-automation-live-2026-10-22al). Machine accounting: [metrics.json](../../test-results/red-automation-live-2026-10-22al/analysis/metrics.json). Source and counting provenance: [plan-provenance.json](../../test-results/red-automation-live-2026-10-22al/analysis/plan-provenance.json).
- Exact objective: `!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.`
- One cold world: seed `2981236939`, actor `14`, goal `goal_0bsah5e_1`, request `req_mvjrdlg8_1`; zero humans, empty initial board/inventory/machines, then one declared starter: eight iron plates, burner drill, stone furnace, pistol and ten magazines. Construction speed was 1; construction cap 60 wall minutes. Quota stop remained 7% with a 5% reserve.
- CLI-proxy planner `gpt-6.1-sol`, executor `gpt-6-luna`; dedicated Jev configuration. Read-only overwatch used `gpt-6-luna` and finished with the trial. Its observations were not repeated as parent status updates.
- Acceptance required native automation, independent physical-chain approval after strict AI stop, then five wall minutes at speed 2, at least ten new packs and at least one pack/game-minute with real upstream production. None of those measurement conditions were entered.

Offline gates passed: 3,076 runtime tests; 1,346 mod tests plus types, Lua build and generated-Lua checks; payload 9; reviewed runner helpers 41; archive helper 10; cleanup mock checks. The official local build passed. Deployment comparisons matched all 62 shipped runtime modules, all 32 independently compiled native files, prompt and manifest. Both protocol-3 role catalogs contained the exact 44 tools; preflight wire probes used scripted replies and made zero external inference calls. Burst 4/refill 15,000 ms and reservation tools/operation/checkpoint were confirmed in the deployed contract.

One preflight-only boot attempted RCON before it was ready and got local `ECONNREFUSED`. It submitted no goal and called no provider/Jev. Its stack and tunnel were cleaned and its data/logs archived under `preflight-attempt-1/`. A bounded local RCON readiness wait then passed on a new cold boot. This was one actual trial, not two provider trials. Temporary symlink creation was unavailable; Compose consumed the existing owner configuration internally, using a zero-byte task marker. That marker was removed at closeout; no credentials were copied into the task.

## Failure and paths exercised

At `16:33:59.547Z`, the planner committed one four-step iron-bootstrap plan. Later contracts were deliberately deferred and bound in three just-in-time planner calls. All three calls reported acceptance without repairs.

The contract for step 4 required receipts for both `supply_entity` and `move_items_exact`, plus inventory of 58 iron plates and completed `steam-power` research. At `16:37:06.708Z`, the executor's normalized proposal contained only two operations: supply one coal to drill unit 37 and one coal to furnace unit 38. It contained no `move_items_exact`. Runtime validation checks receipt names against the current submitted batch (`npc-agent-loop.mjs`, `validatePlannerCheckpointContract`), so requirement 2 failed before native admission. The controller recorded an unrecoverable guard pause at `16:37:06.757Z`; the next authoritative runner observation closed the trial.

This is a demonstrated mismatch between a step-wide contract and incremental executor batches. The planner-only binding accepts approved receipt names prospectively; executor validation requires them in the immediate batch. Fueling and later collecting iron are separate actions, but the contract coupled them. A future fix should reproduce this exact deferred-contract/two-supply proposal before changing the binding or execution semantics. No fix was made during this E2E.

The changed construction boundaries were exercised: drill placement ended before furnace selection; fresh geometry and placement candidates informed the furnace operation. The burst/refill policy emitted eight `observation.rate_admitted` events and two `observation.rate_wait` events, while the separate observation no-progress guard still steered one retry. The final native ledger contained no reservations. Reservation escrow, marker placement, approval, design handoff and restoration were **not exercised** by this trial; their existing deterministic native proofs do not establish autonomous use here.

## Actual plan and its inputs

Full captured goal, Roadmap Shelf, plans, guidance, completion contracts, progress and snapshot history are in [canonical-plans.json](../../test-results/red-automation-live-2026-10-22al/analysis/canonical-plans.json). [plan-events.json](../../test-results/red-automation-live-2026-10-22al/analysis/plan-events.json) preserves the accepted plan and each contract/verification event with source lines and timestamps. [normalized-submissions.json](../../test-results/red-automation-live-2026-10-22al/analysis/normalized-submissions.json) includes the final refused batch. Five `plan.accepted` records mean one normalized planner commit and four executor proposals, not five different successful plans; the last record precedes admission refusal.

The committed Shelf was: iron bootstrap → copper/electronics → science unlock → steam electricity → automation research → automatic resources/fuel/smelting → automatic science and measured throughput. Plan `goal_0bsah5e_1_p3`, version 1, refined only `iron-bootstrap`:

| Step | Original description | Final outcome / contract |
|---|---|---|
| 1 | Gather a bootstrap reserve of at least 20 coal. | Completed; inventory coal ≥20. |
| 2 | Install the held burner-mining-drill over iron ore; observe its new identity and actual output geometry before choosing furnace placement. | Completed; burner drill count ≥1. |
| 3 | Install the held stone-furnace to receive the drill’s observed output; observe the furnace identity and verify the direct-feed connection before fueling. | Completed by its presence contract: unit 37 exists and furnace count ≥1 within radius 1 of the output anchor. This does not prove sustained production. |
| 4 | Fuel the connected iron cell, produce and collect at least 50 new iron plates, verify steam-power is researched, and retain at least 58 iron plates. | Paused before fueling admission; two receipt requirements + inventory ≥58 + steam-power research. |

The planner obtained live recipe, research-trigger, mining, furnace-rate and inventory facts. A once-only requirements-grounding steering round clarified the actual unlock chain before commitment. Its committed explanation recognized electronics and steam-power as independently actionable triggers, chose iron first, reused the held pair, and left later capability milestones tentative. Placement candidate results, fresh entity geometry and logistics topology were supplied to the executor after construction boundaries. The exact system prompts and supplied facts/tool results are retained in each `provider.request.payload.messages`; [provider-calls.json](../../test-results/red-automation-live-2026-10-22al/analysis/provider-calls.json) indexes each call by request/round/time/source line. This describes supplied inputs and observable decisions, not private reasoning.

[Issued assistant material](../../test-results/red-automation-live-2026-10-22al/analysis/issued-assistant-material.json) preserves messages as actually recorded in later request payloads. There is a completeness limit: response traces contain bounded diagnostics and some conversation messages are clipped, including a 4,000-character pre-grounding draft. Full raw rejected response bodies cannot be recovered from those previews. Captured canonical plans and normalized proposals are preserved; missing draft text was not reconstructed or presented as original. No planner-review/replacement slice occurred; the three later contract bindings are retained separately.

## Recovery, tools and native actions

| Mechanism / reason / scope | Attempted | Completed | Failed |
|---|---:|---:|---:|
| Requirements-grounding retry, before plan commit | 1 | 1 | 0 |
| Observation decision-pressure retry, plan p3 step 2 | 1 | 1 | 0 |
| Automatic resume | 0 | 0 | 0 |
| Planner-review request | 0 | 0 | 0 |
| Normal C3 executor context handoff at plan commit | 1 | 1 | 0 |

“Completed retry” means the next provider response returned after steering, not that its gameplay objective succeeded. C3 was a normal context transition, not a failure recovery. One terminal guard failure remained unresolved. There were no operator gameplay recoveries. No provider transport error, fallback or provider retry occurred.

| Observation tool | Attempted / traced execution / successful result | Failed/refused | Cached flag |
|---|---:|---:|---:|
| getRecipeDetails | 3 / 3 / 3 | 0 | 0 |
| getPlacementCandidates | 2 / 2 / 2 | 0 | 0 |
| getPrototypeDetails | 2 / 2 / 2 | 0 | 0 |
| discoverPrototypes | 2 / 1 / 1 | 0 (one deferred) | 0 |
| getResearchPath, getMiningDetails, getActorStatus, getInventoryItems, findLongRangeEntities, getEntityGeometry, getLogisticsTopology | 1 / 1 / 1 each | 0 each | 0 each |

There were 16 observation-tool attempts and 15 successful traced executions/results. One `discoverPrototypes` attempt was deferred by relevance admission, then requested again and executed. Exact native RCON execution count is unavailable: static prototype caching can bypass native execution while the traced `cached` field is false. Traced duplicate calls and coalesced runtime events were both zero.

The separate `submitPlan` tool was attempted four times: all four reached parsing/validation; three proposals admitted operations and one was refused before admission. The planner also committed one plan as JSON content rather than a `submitPlan` tool call. Provider response metadata reports 20 tool calls in total: 16 observation attempts plus four `submitPlan` calls. The runtime terminal summary's 15 `tool_calls` counts ordinary traced observation execution and excludes those structured submissions and the deferred observation.

World proposals contained one `gather_resource`, two `place_candidate` and two `supply_entity` operations. Three batches/three operations were admitted and acknowledged: gather once and place twice. Both proposed supplies were refused together before admission. Native logs confirm three completed batches with receipt tasks: one walking, one mining and two placing. Eight internal next-task markers include walking and resumed placing; they are not eight independent top-level actions. Admission, queue completion and individual step completion are not factory success.

## Time, usage and price completeness

| Time view | Total | Mean / range where available |
|---|---:|---|
| Build/preflight before objective, including the local boot failure | 657.563 s | Build alone estimated 91.444 s from host file timestamps; not separately instrumented. |
| Trial to strict stop confirmation | 360.888 s | Includes terminal observation delay. |
| Planner request latency, 6 calls | 154.109 s | Mean 25.685 s; 5.219–67.550 s. |
| Executor request latency, 10 calls | 86.236 s | Mean 8.624 s; 5.096–14.917 s. |
| Jev latency, 13 calls | 2.741 s | Mean 0.211 s; 0.105–0.320 s. |
| Observation tool batch-envelope union | 1.000 s | Per-tool envelope averages/ranges in metrics; concurrent members overlap. |
| Two steering-to-response intervals | 61.664 s + 9.997 s | Include LLM request time already counted above. |
| Native navigation | 15.868 s | Three segments; mean 5.289 s, 0.214–9.698 s. |
| Native gathering/mining | 40.349 s | One mining segment. |
| Native placement | 0.058 s | Four internal segments for two placements, excluding walking. |
| Production measurement | Not entered | Zero measurement duration; no accepted rate. |
| Stop submission through save/load/cleanup | 15.831 s | Paired stop receipt took 0.335 s. |

These are overlapping views, **not additive categories of trial wall time**. Provider wire intervals union to 240.019 s; union with Jev intervals inferred from response latency is 242.261 s. Tool envelopes are not isolated backend execution timings. Native timing uses engine process elapsed wall seconds. No crafting or item-transfer action executed; research/production waits were not reached. Exclusive waiting and separately measured thinking duration are unavailable. Request latency includes generation, queueing and network time; reasoning tokens are a usage metric, not a duration.

| Provider / role / model | Requests / responses | Input | Cached input | Uncached input | Output | Reasoning within output |
|---|---:|---:|---:|---:|---:|---:|
| CLI proxy / planner / gpt-6.1-sol | 6 / 6 | 145,521 | 48,640 | 96,881 | 5,017 | 1,533 |
| CLI proxy / executor / gpt-6-luna | 10 / 10 | 279,077 | 172,800 | 106,277 | 2,481 | 1,533 |
| Total CLI proxy | 16 / 16 | 424,598 | 221,440 | 203,158 | 7,498 | 3,066 |
| TypeSafe / checkpoints / jev-1.14.0 | 13 / 13 | Incomplete | Unavailable | Unavailable | Incomplete | Unavailable |

CLI usage is complete for all 16 responses and independently reconciles with the runtime terminal summary. Wire requests, not duplicate behavior records, establish API counts. FIFO request identity plus response IDs/latencies distinguish legitimate calls sharing request/round values. There were zero errors, pending cancellations or fallbacks, and zero NPC provider/Jev requests after either strict stop submission or confirmation. Jev's model is present in all 13 exchange records; one response omits the model. Its usage fields appear on 11/13 responses, reporting a partial 33,950 input and 2,527 output units. Missing/default-zero telemetry prevents a complete Jev token or cost claim.

As of this report's October 22 assessment, pricing rates, rate sources, total estimated USD and actual billed USD are **unknown/unavailable** for all 29 NPC requests. No verified price mapping was established for the internal CLI-proxy aliases; Jev usage/billing is incomplete. All calls remain unpriced rather than assigned a fabricated zero. Reasoning output must not be charged twice. Subscription token-price equivalents would differ from actual incremental charges. Parent/overwatch tokens and billing are unavailable separately; shared Codex weekly remaining quota moved from 56% before work to 53% during closeout and is not a monetary estimate.

## Preservation and closeout

The runner submitted fresh cancellation and same-goal operator-pause at `16:37:43.684Z`; confirmation at `16:37:44.019Z` included native idle, queue length zero and empty crafting queue. Save modification followed that boundary. [Final-save proof](../../test-results/red-automation-live-2026-10-22al/data/logs/final-save-proof.json) records 810,074 bytes, 55 entries, full ZIP CRC pass, and SHA-256 `808fc39f3020d07183025a001c63ee2dbd7b3d206e38b16ee8f45503cf937106`. The reviewed runner retains the historical basename `red-automation-ak-checkpoint.zip` inside the new isolated AL data directory; it did not overwrite AK evidence.

An isolated pristine Factorio 2.0.77 process loaded the exact saved ZIP and completed a benchmark update with exit 0. All 32 active native files matched the expected paths/content. Raw traces, world and planning snapshots, failed preflight evidence, native mod copies and save/load logs remain in this run's directory. [Independent accounting verification](../../test-results/red-automation-live-2026-10-22al/analysis/verification.log) passed. The repository trace checker correctly exits 1 with one unrecoverable-request finding and no JSONL parse errors; that is the observed failure, not a broken checker.

The bounded [report review](../../test-results/red-automation-live-2026-10-22al/overwatch/report-review.md) reconciled the outcome, plans, usage and cleanup. Its one derived provenance-label issue was corrected and independently asserted; [review resolution](../../test-results/red-automation-live-2026-10-22al/analysis/review-resolution.json) records that correction and the separate deferred-tool accounting refinement. All 46 frozen helper hashes still match. [Evidence seal](../../test-results/red-automation-live-2026-10-22al/analysis/evidence-seal.json) covers the retained files and records this report's hash.

Compose project `red-automation-20261022al`, exact recorded container IDs, proof containers, networks, disposable volumes, hidden tunnel identities and the unique `factorio-npc:run-al-20261022` tag were removed. Final inventory includes analysis containers and the first preflight attempt. Shared `factorio-npc:local`, `npc-dev` and the existing archive-helper image remain intentionally; host evidence and this task checkout remain for diagnosis. The zero-byte task configuration marker was removed. No gameplay, inference or overwatch process remains. [Final cleanup inventory](../../test-results/red-automation-live-2026-10-22al/analysis/final-cleanup.json) and [overwatch review](../../test-results/red-automation-live-2026-10-22al/overwatch/final-review.md) provide the independent closeout evidence.
