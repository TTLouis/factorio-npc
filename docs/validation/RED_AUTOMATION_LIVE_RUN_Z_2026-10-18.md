# Run Z: native landfill preparation shipped; automated red science remains unproven

## Release and scope

The owner authorized landfill removal followed by one fresh E2E trial. Run Z used frozen integration `e86934e22e280f09f720bea6997be51fd90f0781`, actor 15, seed 127907125 and goal `goal_1iqhmpf_1`. Its sole gameplay prompt was:

```text
!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.
```

The 60-minute construction cap and provider/recovery limits were unchanged. There were four automatic resumes, no manual gameplay corrections, manual resumes or budget resets. The supervisor retained the measurement contract: pause AI mutations, remove enemies, measure five wall minutes at 2× speed and require at least ten **new** red science from the full automated chain. Measurement never started because construction did not reach that chain.

The [landfill validation checkpoint](PUMP_LANDFILL_REMOVAL_2026-10-18.md) records production merge `b2019034`: 2,566 runtime/staging tests, 1,223 mod tests, typecheck/Lua/generated-Lua, lint, nine payload tests, all 26 native lanes and 92 Python checks passed. Water-first preparation reclaims only a validated native landfill layer directly over water through real timed tile-proxy mining. A separate completion receipt invalidates old water reads and pump candidates; fresh water discovery and validated candidate-ID placement remain required. Actor/force/surface, inventory, reach, footing, protected-work and lifecycle checks apply. The job/receipt/backend boundary permits future robots; this release exposes actor execution only.

The actual server release was built with `scripts/build-docker-local.ps1 -NoEnvUpdate`. Its image was `sha256:c643f425af6d1408b5db3a418cb6e9bb8f2989f14902f14347a88c82231c4a53`. Verification covered all 53 shipped runtime/staging modules, prompt/manifest, both complete 41-tool role catalogs and 31 native files. Active and packaged native files matched raw bytes. Independently compiled native files matched using the existing symmetric CR normalization for text; original raw manifests and the initial line-ending mismatch remain preserved. CLI-proxy authentication/catalog and closed-tool serialization passed before inference; actual request/reply logs prove `gpt-6.1-sol` planner and `gpt-6-luna` executor routing. Environment field names and secret values were unchanged.

## Result and exact blocker

Run Z began at `2026-10-18T11:25:11.541Z` and terminated after **1,172,707 ms (19.5451 minutes)** as `controller_blocked:canonical_plan`. It made 81 provider requests with 81 replies (seven Sol, 74 Luna), zero provider errors and 54 successful Jev exchanges. Native production reached 50 new iron plates, ten copper plates and **zero red science**. Pump 35 supplied water to boiler 36; the boiler was unfueled, the engine remained held and no electric generation or automated production chain existed.

The water-first gate refused a premature pump lookup without scanning. Automatic recovery then read exposed water and placed a legal candidate. This map had no covered-water hints and no `getPumpSitePreparation` events: **live landfill removal was not exercised**. Its capability is established by the deterministic native proof, including six reclaimed landfill, real mining time and a subsequent water-sourcing pump.

Batch 21, operation `recovery_mvdraq8y/batch_21`, admitted these individual placements:

1. Boiler at `(43.5, -49)`, direction 0.
2. Steam engine at `(42.5, -48.5)`, direction 4.
3. Small electric pole at `(44.5, -48.5)`, direction 0.

The boiler completed and consumed its item. The engine footprint (`x=40..45`, `y=-50..-47`) overlapped that new boiler, so native placement refused `not_placeable`; the pole tail was cancelled. Reconciliation retained `admitted_cancelled` / `partial_unknown` / `exact_batch_cancelled`. The duplicate-operation fence suppressed same-step repair, and `operation.uncertainty_blocked` at `11:44:02.334Z` produced canonical structural `unresolved_operation_effect`, requiring user decision. This was neither the construction cap nor usage exhaustion.

The receipt lists three tasks but reports `started_count=4`; preceding pump batch 20 similarly reports three starts for one listed task. Internal approach/resume activations may contribute, but that cause is not yet proven. Do not infer a simple two-start prefix or disable the uncertainty guard. Next offline work is an exact native replay that distinguishes top-level outcomes from internal activations and safely reconciles the completed boiler before admitting a repair. Same-batch footprint validation should also be assessed to reject this overlap before mutation. No follow-up fix, second trial or replay of the live operation was performed.

## Stop, save and cleanup

Fresh same-goal `request.cancelled` at `11:44:43.908Z` and operator `goal.paused` at `11:44:43.920Z` confirmed the submitted stop. Native idle, empty queues/crafting and inactive mining/follow state were verified. The fresh checkpoint completed after stop at `11:44:45.154Z`: **695,581 bytes**, SHA-256 `5c00bff13c2f509c71721e0d91f4b467519fcc13005a62ebc7c72e058a65fd3c`. All 55 ZIP entries pass CRC. A pristine copy loaded with the exact release's Factorio 2.0.77 and 31 native files, performed one update and exited zero with networking disabled; the original checkpoint was unchanged.

An initial archive wrapper swallowed stdin and produced incomplete metadata. Its failure and frozen helper remain archived; a separate post-stop helper corrected invocation and asserted nonempty PASS output. None of the 26 frozen gameplay/preflight helpers changed.

Compose project `red-automation-20261018z`, all owned test/load containers, networks, disposable volumes, four remaining image tags and exact owned SSH PID 48968/listener were removed and independently checked. The official build had replaced the unused previous `factorio-npc:local` image; restoration of that old untagged image failed because Docker no longer retained it. This failure is recorded, and both new release tags were removed. No global prune or Docker/VPN restart was used. Saves, local configuration and historical archives remain preserved.

Weekly usage remaining was 93% at launch and 92% at trial finish, above the owner's approximately 5% reserve and 7% live-stop threshold. Final publication-stage reading was 91%; no reset credit was used. The single authorized trial is complete; autonomous red-science throughput remains unproven.

## Sealed evidence

Evidence remains under integration `test-results/red-automation-live-2026-10-18z/`, including the checkpoint in `data/saves/`, complete logs, actual role proof, `blocker-batch21-packet.json`, stop/save/load and parent/independent cleanup receipts. Parent and independent reviewer verified the exact sealed file set and every size/hash:

| Evidence | Files | Bytes | Manifest SHA-256 |
| --- | ---: | ---: | --- |
| Run Z `final-evidence-manifest.json` | 186 | 32,316,818 | `463311f7b4b8bebee9bad8bb2245756d53f09775eb4896430f9f5e2b9a9a4f70` |
| Task `test-results/landfill-evidence-manifest.json` | 2,942 | 196,615,084 | `946b7284d0ac780d4ed65f21b1114e1f5b69ac0bec0ff6bf1314a57898bf5985` |
| Integration `test-results/pump-landfill-integration/landfill-evidence-manifest.json` | 1,675 | 148,944,099 | `28cff05cf98ea532bf340ce54e3dbdd67bbe225264e36e2d89724d7ce94d8939` |

The manifest and its self-hash are excluded from their own file sets. All 6,458 previously sealed offshore-water-first and Run Y files were also reverified unchanged. No sealed root receives later documentation edits. Publication preserves the separately published `cc2e5cb9` telemetry/tail-registry work; Run Z evidence applies specifically to frozen `e86934e2`, not that later runtime.
