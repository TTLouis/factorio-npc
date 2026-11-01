# CLI-proxy Run U: normal control observation exercised, closed provider response exceeded the size guard

One bounded local trial under the owner's active red-science goal. The supervising subagent preserved the terminal wire case, confirmed AI cancellation through the reviewed observer, saved and shut down the isolated stack. No operator gameplay correction, extra starter resources, second campaign, source/helper change during the run, push or deployment occurred.

## Target and preflight

- Complete natural-resource steam power, automatic iron/copper/coal mining and fuel delivery, smelting, gear/red assembly and native logistics. Construction may hand craft/feed. Acceptance remains **one new red pack per game minute**, five wall minutes at speed 2, at least ten game minutes and ten new packs, with AI mutations paused and generated enemies removed/expansion disabled during measurement.
- Physical supply/fuel topology, native upstream and machine production, steam/fluid/network evidence and an immutable SHA/source/goal/actor-bound packet require explicit parent review before measurement. **No readiness packet, measurement or measurement world changes occurred.**
- Frozen clean source **`6ceaa2ae65f2a00e479ba45d56bd64eb79ee457e`**, production/tests identical to reviewed normal-observation fix **`339c0cc6`**. Merged canonical gates passed **2,452 runtime/staging tests, 1,144 mod tests, typecheck/Lua checks**. The new native normal-observation lane plus thirteen prior canaries, original-code controls and independent review passed against identical production code.
- Official `scripts/build-docker-local.ps1 -NoEnvUpdate` image **`sha256:3e2bcf7cb25204ec3717c229a40b24ede5340df6c183a4d75effbba1bf7c7598`**. Exact **50 runtime/staging modules**, prompt and manifest match frozen source; all **31 active/release/native-tested mod files** match native-tested image **`sha256:547814b73f728ceec186daacec9a2ae31d5de2682b5284e2261bfc9911314c8b`**. No mixed runtime overlay.
- Resolver proved **Sol6.1 planner / Luna6 executor**, dedicated Jev present. Actual game-container model discovery returned unauthenticated HTTP 401 and authenticated HTTP 200 / 33 models, both roles available. Elevated process/listener checks verified the existing loopback SSH forward; it was left unchanged. **26/26 offline Docker observer checks** and syntax passed. The sixteen-artifact READY packet is SHA256 **`2d20e66cf8bbdddee70bfb7689dc56ad4a78dd51b8d5de53037c90d403a920a3`**.
- Cold seed **2298799268**, standalone actor **13**, empty inventory/board, no machines, zero humans, speed 1 and idle queues; zero pre-release provider calls. The released runner applied the original starter once: burner drill 1, furnace 1, iron plates 8, pistol 1 and ammunition 10. Goal **`goal_1avwofj_1`**, initial admission request **`req_mva5w2t0_1`**.

## Result and native progress

Started **23:20:18.434 UTC**. Actual terminal provider failure was **23:28:53.132 UTC**, followed by canonical guard pause at **23:28:53.182 UTC**. The runner finished **`controller_paused:guard`** after **541,024 ms (9m1.024s)**, including safe termination. No automatic resume followed the guard failure; only one of the six goal-level bounded recoveries had been used.

**33 provider requests / 32 responses / one provider error**, comprising **4 Sol / 29 Luna requests**. Jev **23 requests / 23 responses / zero errors**. One planner-parking handoff, three context restages, one automatic resume and one accepted just-in-time checkpoint call establish actual delegation. No baseline-rebase event occurred.

The NPC gathered **100 iron ore and ten copper ore**, and furnace **26** at **(-85, 59)** natively produced **ten copper plates**. Final actor inventory contains the original burner drill, four wood, **50 iron ore and eight starter iron plates**. The furnace contains **49 iron ore, eight wood and ten copper plates in its output**, with ten products finished. Native iron-plate production is **zero**; its copper output obstructed the switch to iron. The one consumed iron ore is not evidence of a completed iron plate.

Only the furnace was placed. **No lab, steam kit, connected power, automatic mining/fuel chain, gear/science assemblers or red output existed.** The active second bootstrap step required steam-power research. Humans stayed zero and speed 1. **The five-minute unattended full-chain proof did not start.**

## Exact provider-size boundary

Final executor request **`recovery_mva623o2`**, round 1, was submitted at **23:28:27.371 UTC**. Its actual payload contains only **`model`, `messages`, `max_tokens:4000`**. It has **no `tools`, `tool_choice` or `response_format`**. Trace metadata records **`allow_tools:false`** and **`capability_profile:"generic"`**. The immediately preceding round observed research state; the harness then closed the decision's exhausted observation window and requested structured action output.

The provider reader canceled when cumulative response bytes reached **270,557**, exceeding its **262,144-byte (256 KiB)** guard. `provider.response_error` records **`provider_response_too_large`**; the corresponding runtime error is **`Provider response too large`**, latency approximately 25.8 seconds, neither timeout nor cancellation. The supervisor guard-paused the goal instead of silently retrying.

**The oversized response body was not retained or parsed.** Its content, attachment shape, validity and model intent therefore remain unknown. An existing static CLI-proxy closed-round test covers a large attachment shape, but that fixture does not prove this live response contained an image. Parent owns diagnosis of capability/profile routing and the required transport contract; the evidence does not justify increasing the response cap or retrying the provider.

Settled **`run-u-provider-size-case.json`** preserves every actual recovery request through a deduplicated message pool, the preceding complete replies and tool-call/observation messages, size-guard metadata, source hash/line, canonical step/contract, operation admissions/receipts, native production/inventory and the sole resume cause. The unavailable failed body is stated explicitly, rather than represented as an empty or valid response.

## Observation and stop regressions exercised

The new **`observation.normal_from_control`** path was exercised once at **23:21:37.006 UTC**, for **`getInventoryItems`**. The corresponding actual provider/control/tool-result payloads are retained in **`normal-observation-live-proof.json`**. It used the existing observation allowance. **Closed targeted grants: zero.** This live use supports the normal-observation branch, not a claim that every later closed-observation recovery succeeded.

One Sol JIT call bound the steam-power checkpoint successfully; actual contract-only wire and trace are retained in **`jit-live-proof.json`**. The shoreline path and structural-BLOCKED termination branch were not exercised. Legacy transfers ran, but this trial does not independently prove that Run S's particular distant target-reacquisition branch executed.

The Run U observer's paired stop-confirmation repair **passed live**. Stop submission was **23:29:19.078 UTC**; cancellation trace arrived **23:29:19.086 UTC**, followed by same-goal operator-pause trace **23:29:19.104 UTC**. Durable `paused_at` still retained the earlier guard-pause time. The observer correctly required the fresh isolated trace pair, current same-goal durable operator pause, cleared intake and matching idle native actor/empty queues. It confirmed at **23:29:19.375 UTC before writing the result and saving**. No incomplete artifact or outer-save workaround was needed.

## Evidence and shutdown

Ignored **`test-results/red-automation-live-2026-10-15u/`** retains official build/exact deployment/native-image mapping, model/tunnel/provider-zero proofs, hash-bound READY packet, reviewed helper hashes/diff and 26-check logs, live provider/Jev/behavior traces, native frames/canonical state, exact terminal size case, normal-observation and JIT wire proofs, confirmed runner result, final summary, diagnostic analyzer and SHA256 evidence manifest. Save: **951,850-byte** `data/saves/red-automation-u-checkpoint.zip`.

Offline Docker run-check exits 1 with one stale-step diagnostic signature on the initial request; that does not independently establish another defect. The isolated Run U container/network were removed. Only the unrelated Endfield container remained running; the healthy SSH tunnel, VM services and prior run evidence were untouched. **No second trial followed this supervision cycle.** Parent owns subsequent diagnosis, fixes, review and local integration.
