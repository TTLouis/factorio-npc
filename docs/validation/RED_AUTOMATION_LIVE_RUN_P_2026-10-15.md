# CLI-proxy Run P: baseline recovery continued, then shoreline-step contract binding stopped construction

One bounded local trial under the owner's active red-science goal. A subagent supervised preparation, native observations, evidence and shutdown. The trial is complete, its isolated stack is down, and no second trial occurred in this supervision cycle. No production code, credentials or provider configuration changed during the trial; no push or deployment occurred.

## Target and deployment

- Build the complete natural-resource chain: steam power, automatic iron/copper/coal mining and fuel routing, smelting, gear assembly, red science assembly and native logistics. Construction may hand craft and hand feed. The readiness target is **1 new red pack per game minute**, measured over **five wall minutes at speed 2**, at least ten game minutes and ten new packs.
- The measurement requires AI mutation lockout, idle native queues, zero humans, removal of generated enemies and disabled enemy expansion. Native upstream production, machine output, steam production, fluid connectivity, electric networks and the physical supply/fuel graph must support the claim. An immutable native topology packet and explicit SHA/source/goal/actor-bound review marker now gate measurement. No benchmark was reached in this trial.
- Frozen clean source **`369587144a09d785063acffbc822573fcc0ce078`**. Only documentation differs from tested `c0bad249`: identical production/runtime/mod/test code passed **2,390 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks and nine native lanes**, with original-code controls and independent review.
- Canonical server build: `scripts/build-docker-local.ps1 -NoEnvUpdate`; image **`sha256:9094966ae2ddd126190a0d454eaaf45f467e41fb17f0a13246f4e6eb4297e6bd`**. Exact comparison verified **50 shipped runtime/staging modules**, packaged prompt and manifest, and **31 active mod files** against the release and final native-tested mod. No mixed runtime overlay.
- The previously missing loopback-only forwarding path was restored before this trial. From the game container, unauthenticated model discovery returned HTTP401 and authenticated discovery HTTP200 with 33 models, including **`gpt-6.1-sol` planner / `gpt-6-luna` executor**. No inference occurred during this check. The existing SSH tunnel and VM services were left unchanged.
- Seven offline Docker observer checks passed, including rejecting a missing/stale topology marker, changed source/goal/actor, stored output without assembler production, missing native steam flow/fluid/network energy, upstream starvation, short windows, queued work, damage and lockout mutations. Parent and independent read-only review cleared the helper changes before release; helper bytes stayed fixed during the active run.
- Cold world: seed **1349015198**, standalone actor **7**, empty inventory/board, no machines, zero humans, speed 1 and idle native operations. Starter: burner drill 1, furnace 1, iron plates 8, pistol 1, ammunition 10. Goal **`goal_1xljrcg_1`**, initial request **`req_mv9x19vs_1`**.

## Result and established progress

Runner **19:12:24.333–19:27:25.630 UTC**, **15m1.297s**. Terminal **`controller_paused:guard`**, with the actual harness cause **`step_contract_unavailable`** recorded at **19:27:02.305 UTC** in **`recovery_mv9xjahe`**. The runner immediately issued the agreed stop command before saving; the later `user_stop` pause is cleanup, not the original blocker.

**64 provider requests / 64 responses / zero errors**: **12 Sol / 52 Luna**. Jev **42 requests / 42 responses / zero errors**. Two planner-parking handoffs, ten context restages and six bounded automatic resumes establish actual live delegation/recovery. No operator corrections or additional provider campaign occurred.

The NPC mined and smelted real resources, producing **50 iron plates and 10 copper plates**. It cleared copper output and reused the same furnace for iron smelting. It collected stone, wood and coal and crafted **one offshore pump, one boiler, one steam engine, ten pipes and four small electric poles**. The steam-power construction slice advanced through its first three steps, leaving its shoreline placement step next.

At termination only furnace **15** was placed. The actor held the crafted power equipment, coal 20, iron ore 50, copper ore 10, iron plates 6, copper plates 8, wood 4 and the original burner drill. **No pump/boiler/engine placement, connected power, automated mining/assembly chain, lab or red output.** Red science remained locked; green research remained incomplete. Actor health stayed 250, zero humans and speed 1.

**The five-minute benchmark did not start.** AI measurement lockout, enemy removal/expansion changes and speed 2 were not applied. There is no sustained-throughput or full-chain readiness claim.

## Baseline repair exercised live

At **19:18:48.512 UTC**, C7 rebuilt executor request **`recovery_mv9x9cau`** emitted **`observation.baseline_rebased`** for `getEntityStatus(unit_number:15,radius:8)`, conversation sequence 14, mode **`full`**, reason **`current_conversation_has_no_delivered_baseline`**.

The actual subsequent provider request, **round 2**, contained the full native furnace tool result. `baseline-live-proof.json` preserves that exact result and its related tool call. Native continuation then cleared the ten copper plates into actor inventory and supplied iron: the next snapshot showed 35 iron plates in furnace output, 14 iron ore still being smelted and 45 total furnace products. The furnace ultimately reached 50 iron plates plus the earlier ten copper plates. Three rebase events occurred across this run.

This demonstrates the repaired observation boundary and subsequent physical copper-to-iron recovery. It does not establish every compaction path or autonomous science completion.

Earlier valid admission refusals are preserved separately: attempting `set_machine_recipe` on a furnace was rejected as `not_recipe_machine`; a `supply_entity` plus `move_items_exact` batch that consumed the same iron stock twice was rejected as `batch_stock_insufficient`. No operation from that rejected batch ran. Recovery subsequently made valid progress, so these refusals are not independently established harness bugs.

## Concrete next boundary: completion-contract side call

The immutable next step was **“Place the water intake on a legal shoreline and connect the boiler using verified fluid ports.”** In request **`recovery_mv9xjahe`**, the harness asked the Sol planner to author that step's missing checkpoint after the equipment-crafting step completed.

1. First reply proposed an `all` checkpoint with two `entity_exists` requirements using `entity_name` and `minimum` for the pump and boiler. At **19:26:49.067 UTC**, validation rejected it: **`checkpoint_not_supported:stepCompletions[0] requires a supported checkpoint`**.
2. The repair reply returned `chatMessage`, `plan`, `currentStep` and `operations`, explicitly saying it needed the accepted `entity_exists/entity_state` requirement schema to represent placement and verified water connectivity. At **19:27:02.248 UTC**, validation rejected the extra fields: **`reply_has_unexpected_fields:chatMessage,plan,currentStep,operations`**.
3. Both bounded contract attempts were spent. The completed crafting step was verified, then the goal correctly paused before executing a shoreline step without a bound contract: **`step_contract_unavailable`**, guard class, active tracker step `step_4`.

`run-p-step-contract-case.json` preserves the exact two reply objects/texts (complete 216/824-character prompt previews), exact request target/facts/correction/steering messages, planner prefix hashes/metadata, model/actor/request correlation and validation reasons. The complete 62,131-character planner system prefix remains in ignored raw traces rather than being duplicated into this compact case. Both actual side-call payloads also contain provider-appended **`[CONTROL_OUTPUT]`** instructions requiring the gameplay envelope `chatMessage`, `plan`, `currentStep` and `operations`, conflicting with the narrow contract parser's accepted reply. Independent read-only review corroborated that conflict from the exact fixture; the strict parser and guard pause preserved the completed steps. Parent owns the task-specific instruction/schema correction and regressions before a further live trial. No live shoreline exploration was attempted here.

## Preserved evidence

Ignored **`test-results/red-automation-live-2026-10-15p/`** contains the durable supervision note, deployment/model/proxy proofs, fixed helper review diff and seven-check observer log, native snapshots/canonical state, baseline proof, exact contract case, preflight batch/refusal packet, provider/Jev traces and retained rotations, summary, a **sixteen-file SHA256 manifest**, and **569,966-byte** `data/saves/red-automation-p-checkpoint.zip`.

Offline Docker run-check exits **1** with six finding records: one restage-loop record, three tracker-behind-batch records, one no-chat record and the terminal `step_contract_unavailable` record. These are analyzer signatures, not six corroborated product defects. The exact contract exchange establishes the next investigation boundary.

The isolated Run P container/network were removed. The pre-existing SSH tunnel, VM services, unrelated containers and older dirty root checkout remain untouched. Parent owns the next deterministic fix, regressions, review and local integration; this supervision cycle did not retry the live run.
