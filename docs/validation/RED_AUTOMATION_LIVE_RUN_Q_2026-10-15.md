# CLI-proxy Run Q: first furnace placement never began before bounded recovery exhausted

One bounded local trial under the owner's active red-science goal, supervised by the existing subagent. The trial is complete and its isolated stack is down. No production code or observer behavior changed during the run; no corrective prompt, second trial, push or deployment occurred in this supervision cycle.

## Target and verified candidate

- Complete the natural-resource steam-power, automatic mining/fuel, smelting, gear assembly, red science assembly and native-logistics chain. Construction may hand craft/feed; readiness requires **1 new red pack per game minute** over **five wall minutes at speed 2**, at least ten game minutes and ten new packs.
- The unchanged reviewed observer requires an immutable native topology packet and explicit SHA/source/goal/actor-bound review before measurement. Measurement pauses AI mutations, verifies idle native queues and zero humans, removes generated enemies and disables expansion. Native upstream output, assembler counters, steam/fluid/electric-network evidence and the physical supply/fuel graph must support any full-chain claim.
- Frozen clean source **`e77ed843c0a60453d1f5e5b476808e073741d89d`**, local merge `449a0014`, containing reviewed step-contract fix `8f7ac8ee`. Merged canonical checks passed **2,398 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks**. All **ten native lanes** passed against identical production code; original-code static/native controls reproduced the conflicting contract instruction failure. Only documentation differs from the native-tested candidate.
- Canonical local build: `scripts/build-docker-local.ps1 -NoEnvUpdate`; image **`sha256:cbeb915181eabd1712b35219c36e3339c587664e7e4c40e0a1cb6be59a8eb538`**. Exact source/release comparison passed for **50 shipped runtime/staging modules**, prompt and manifest. All **31 active mod files** match the release and native-tested mod. No runtime overlay.
- Role resolver proved **`gpt-6.1-sol` planner / `gpt-6-luna` executor**, dedicated Jev present. Actual game-container model discovery returned unauthenticated HTTP401 and authenticated HTTP200 with 33 models, including both selected models. Seven unchanged offline observer checks passed. Pre-release provider requests: zero.
- Narrow elevated process/listener inspection confirmed the existing SSH tunnel alive on loopback. An initial sandbox-only check could not see it; no tunnel restart or VM-service change occurred. Private endpoints, credentials, environment and process arguments were not printed.
- Cold seed **2680521750**, standalone actor **13**, empty inventory/board, no machines, zero humans, speed 1 and idle operations. Starter: burner drill 1, furnace 1, iron plates 8, pistol 1 and ammunition 10. Goal **`goal_0903mkl_1`**, initial request **`req_mv9yvci1_1`**.

## Result

Runner **20:03:47.035–20:08:17.431 UTC**, **4m30.396s**. Terminal **`auto_resume_exhausted`**. The actual exhaustion event occurred at **20:07:05.217 UTC**, final request **`recovery_mv9yzdqs`**, reason **`step_limit_reached_without_verified_progress`**: **two of two step resumes**, two of six goal resumes. The runner stopped AI before checkpoint I/O; later `user_stop` is cleanup.

**18 provider requests / 18 responses / zero errors**: **3 Sol / 15 Luna**. Jev **9 requests / 9 responses / zero errors**. One planner-parking handoff, four context restages and two automatic resumes establish actual delegated execution. No operator intervention or additional provider campaign occurred.

Native gathering acquired **ten copper ore and ten coal**. No furnace was placed, no plate was smelted, and no power or automation equipment was built. The actor still held the original furnace, burner drill and eight iron plates, plus the gathered ore/fuel. Zero humans and speed 1 remained invariant. Red science remained locked and green research incomplete.

**The five-minute benchmark did not start.** No measurement lockout, enemy removal/expansion changes or speed 2 was applied. No automation throughput claim follows from this run.

## Exact next investigation boundary

The immutable active slice required:

1. **“Smelt ten copper plates and verify electronics is researched.”**
2. **“Smelt fifty iron plates and verify steam-power is researched.”**

In final recovery request **`recovery_mv9yzdqs`**, Luna claimed:

> BLOCKED: Electronics requires producing 10 new copper plates, but copper-plate smelting requires a placed stone furnace; I only have the furnace item, and tools are closed so I cannot place it or observe a live furnace identity.

Outcome authority rejected the unsupported world-blocker claim. The absence of a placed furnace was real; no authoritative world fact established that the held furnace could not be placed. Recovery spent its bounded attempts without placing it.

The actual first provider call of that rebuilt recovery request had **tools open**, including `getPlacementCandidates`, `findConstructionSites`, `validateConstructionPlan` and `submitPlan`. Its subsequent action-omission repair call had tools closed. The exact payload therefore does **not** establish global placement-observation unavailability. Investigate the model's surviving context, available placement/action schemas and bounded action-recovery transition before deciding whether runtime behavior needs correction. Do not weaken the valid blocker rejection or raise recovery limits to hide the failure.

Ignored `run-q-first-furnace-case.json` preserves the committed steps, exact surviving request messages and tool availability, provider reply previews, actor/epoch/role correlation, control-state/tool observations and rejected blocker/exhaustion events. System-prefix hashes and bounded excerpts replace duplicated full system prompts in this compact case; complete traces remain local.

**The new step-contract fix was not exercised live**: zero `plan.contract_call_attempt` events. The trial stopped before equipment crafting or just-in-time shoreline contract binding. There were also zero `observation.baseline_rebased` events; the prior Run P actual baseline recovery proof remains the live evidence for that boundary.

## Preserved evidence

Ignored **`test-results/red-automation-live-2026-10-15q/`** contains the durable supervisor checkpoint, build and exact-deployment proofs, proxy/tunnel checks, seven-check observer log, native snapshots/canonical state, compact first-furnace case, provider/Jev traces, final summary, a **fifteen-file SHA256 manifest**, and **835,103-byte** `data/saves/red-automation-q-checkpoint.zip`.

Offline Docker run-check exits **1**; its findings are recorded in `run-check.json` and the summary. Analyzer signatures are diagnostic leads, not independent defect counts. Parent owns deterministic investigation, regressions, review and local integration before any next trial. The isolated Run Q container/network were removed; the existing tunnel, VM services, unrelated container and older dirty root checkout remain untouched.
