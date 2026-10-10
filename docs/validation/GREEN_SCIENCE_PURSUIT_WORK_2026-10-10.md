# Green-science pursuit work — October 10, 2026

Owner instruction: actual autonomous E2E research of green science using GPT-6 Luna through CLI proxy; fix the system as needed. A parsed provider response or model pause is not success. Work stays on `experiment/goal-pursuit-harness`, under `D:/SideProjects/airi-factorio-npc/goal-pursuit-harness`. No production deployment, pushes, shared-save changes, operator gameplay takeover, resource replenishment or corrective gameplay prompts.

## Completion contract

Fresh natural world, standalone NPC, zero connected humans, normal speed. Declare the existing starter fixture once: eight iron plates, burner drill, furnace, pistol and ten magazines. Verify at least 75 red packs genuinely produced and consumed, completed `logistic-science-pack` research and enabled green recipe. Retain immutable goal identity, native receipts, provider usage and save. Each live attempt is isolated and capped at 30 provider calls or 20 minutes, with failures and restarts counted durably. Further fixes and bounded attempts are covered by the owner's current instruction; do not run unbounded provider retries.

## Checklist

- [x] Prior transport correction: `f41cd245`, explicit provider tool prohibition; one exact-prompt replay returned a generic pause in 3.5 seconds. This did not prove gameplay.
- [x] Clarify that external JSON actions/observations remain executable while provider-hosted tools are disabled; request concrete evidence for pauses.
- [x] Add a stricter native natural-harvest interface, protecting player assets and refusing ambiguous harvest when reservations exist.
- [x] Complete deterministic protection/correlation regressions and native tree-harvest proof: real wood gain=4, zero humans, speed=1; pending receipt preserved.
- [x] Independent invariant review and Docker gates: 2,111 runtime tests, 1,049 mod tests, typechecks and generated Lua checks pass.
- [ ] Freeze candidate, repin installer, full build and deployed-file/mod verification.
- [ ] Run bounded fresh-world green-science attempt; diagnose every failed outcome from actual traces.
- [ ] Fix corroborated runtime failures, add regression coverage, repeat bounded isolated validation as needed.
- [ ] Report actual native outcome and remaining limits.

Full working evidence: `test-results/green-science-pursuit-20261010/`. Current implementation owner: this chat; independent read-only reviewer: `/root/proxy_fix_review`.

## Native finding and correction

The first new tree-harvest lane exposed an existing Lua receipt defect: mapping missing receipts produced nil holes, and every() reported completion while native mining was still active. Retained acknowledgement proves the premature completed state. Reconciliation now iterates dense batch references and looks up each exact receipt; absent receipts stay in flight. Independent review found no blocker. Native replay remains pending before live validation.

## Live wire finding

Pinned candidate c7a1938a matched all49 shipped runtime modules and native-tested control.lua. Attempt01 stopped after one4.5second request returning an empty observations array; no resources or research progressed. A response schema diagnostic was accepted after moving the decision union below the root, but Luna still claimed no game access. An explicit sole submitPursuitDecision tool returned four concrete approved reads in3.7seconds. It submits bounded data; existing operation validation, admission and receipts remain authoritative. Unexpected/multiple/malformed tool calls and extra envelope fields are refused. Static final runtime gate and fresh attempt02 are pending. Native control bytes remain unchanged from the passing tree/provenance gate. All probes dispatch no gameplay.

## Resumed live attempt and read-memory correction

At scheduled 14:05 Toronto resume, five-hour usage was0%, weekly61%; no reset credit spent. Pinned bc328da0 matched all49 shipped runtime files and native control hash. Attempt02 made9 successful Luna requests, all observation-only, and paused after a read radius exceeded64. It consumed411293input characters and no gameplay occurred. Existing observations were replaced every read turn, and the trace showed repeated recipe/prerequisite queries.

The loop now retains at most12read records and48000serialized characters, marks earlier reads historical with observation timestamps, refreshes duplicate queries, and clears reads after mutation settlement or restart. Native JSON is compacted before the existing8000character per-read bound; oversized reads explicitly mark truncation. Deterministic operation/argument PolicyErrors return bounded no-effect correction feedback, while outer envelope/provider failures pause. Each correction still consumes durable allowance, and native admission remains authoritative. For new campaigns only, the input cap is2,000,000characters to cover the stable instruction prefix and bounded read memory across the existing30call20minute cap. Existing campaigns retain their original cap and spent counters. Independent review found no blocker. New native fixture verifies bad-radius recovery before the first real craft.

## Read-memory replay and planning candidate

Source6f21997a, installer pincab9f097: full Docker gate passed2115runtime and1049mod tests, typechecks and generated Lua checks. Native pursuit/provenance replay passed, including bad-radius correction, real craft and natural harvest. Evidence: memory-native-results/, memory-provenance-results/ and memory-native.log. Native control hash remains aa311b2deff7ec460b535ffe534941b5b181d60da733cdc9250d3a4e5cf3def6.

Attempt03 matched49shipped modules and the native-tested control. It completed four native batches, obtaining85copper ore and150iron ore, but produced/consumed zero red science and did not research green science. It stopped after642753ms with30durably reserved calls and1808338input characters; the last call was refused by the runtime hourly request guard with its recovery reserve intact. The isolated container stopped and retained its save. After bulk mining, Luna repeatedly inspected rather than placing/fueling its held furnace. Successful responses reported zero reasoning tokens; that observation does not establish why the provider chose this behavior.

The next candidate changes local GPT pursuit from forced function choice to automatic choice over the same sole bounded submitPursuitDecision tool and requests medium reasoning. Native position is included in the decision packet from existing fenced task-status reads. Instructions emphasize conserving remaining calls, recording prerequisite quantities, batching compatible work and considering concurrent machine production. The schema/parser/admission, output-size guard, exact receipts, provenance and campaign caps remain authoritative. Independent review found no blockers. Full Docker regression gate passed2115runtime/1049mod tests and generated Lua checks. Mocked transport tests establish request shape, not proxy support or improved gameplay; the next isolated trial must verify both.
