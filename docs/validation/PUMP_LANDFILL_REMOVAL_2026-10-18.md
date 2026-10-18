# Bounded offshore-pump landfill preparation — 2026-10-18

Owner-authorized follow-up to offshore candidate enforcement. Source: `98dde64982f09159236f591c67fe92b51fd7ae0b`, including the published unchanged-fact observation accounting fix. Prior sealed Run X, Run Y and offshore-water-first evidence remains unchanged.

The NPC first observes water, including native hidden-water cover hints. `getPumpSitePreparation` accepts an exact pump center and cardinal direction, derives the required water footprint from native prototype rules and accepts only one proven native landfill layer directly over water (layered covers and foundations are refused), and returns an expiring actor/surface/force-bound `pump-preparation-N`. This proposal is read-only and grants no pump-placement authority. `prepare_pump_site` admits a bounded terrain job using that reference. It rechecks native geometry, unchanged cover layers, protected structures, existing construction/deconstruction work, actor footing, reach and inventory capacity.

Factorio 2.0.77 mechanics were checked in an isolated native probe: tile deconstruction produces a native proxy; mining that proxy with the actor inventory and `force:false` exposes underlying water and returns the actual cover item. Actor work enforces the native tile mining duration. Production code does not replace terrain with `set_tiles` or insert recovery items. After the actor mining duration and final reach/state checks, the admitted mutation creates and mines only the exact validated tile proxy in one Lua invocation. It leaves no robot-actionable marks while waiting, creates no pump ghost and gives no incidental entity deconstruction orders. Partial mutation remains observable and cannot acquire a failed-before-mutation replay exemption.

The job has its own `preparing_pump_site` task and operation receipt. Completion proves only bounded cover removal. The runtime does not credit speculative reclaimed materials or treat preparation as a placed/working pump. The NPC must read water again, obtain fresh legal pump candidates and execute `place_candidate`. Generic offshore-pump placement remains refused.

The prepared job, tile set, execution strategy, progress and reclaimed-item receipt form a boundary that a future construction-robot backend can use. This release exposes actor execution only. A deconstruction mark or robot job assignment will never count as completed terrain work.

Named runtime trace `observation.pump_site_preparation_observed` includes request correlation and reason; existing operation admission/completion traces remain authoritative for execution. Native logs identify preparation and operation IDs and each verified cover removal.

## Build status

- [x] Task registered and isolated from current published integration.
- [x] Native mechanics probe: actual water exposure and reclaimed landfill.
- [x] Runtime: 2,555 tests, including strict contracts and a complete scripted preparation-to-working-pump loop.
- [x] Final mod: 1,223 tests, TypeScript, Lua build and generated-Lua checks. Changed-file lint passes.
- [x] Complete combined-source native regression: all 26 lanes and 92 Python checks pass at `b2019034`. Earlier broad run passed 23/25; the two failures were stale tool-count fixture assertions, corrected to require 41 tools including the new preparation read. Both affected lanes then passed. All original failures remain preserved.
- [x] Native 2.0.77 proof: six real landfill reclaimed after at least 360 ticks, fresh water/candidates then an actual pump sourcing water; cancellation, protected/foreign work, saved pending job/restart and actor death. Original native control fails specifically because the new API is absent.
- [x] Independent focused proof review. Frozen native production `bec16e77341bf8e793a1a6028368d4b2af1fc58e`; 31-file native manifest `4c2468824b21e3c9ce1de706d905b76694e4566c136b652d034e02952f2df606`, control Lua `56c9149193b83c7c8d51b215d6a06a9e913557429f159d759ecc3ced47d43285`.
- [x] Independent immutable review: task `804db699`, fixture amendment `2c9c0d89`, combined integration `b2019034`; no merge blockers.
- [x] Integrated published post-batch fact reads (`26510c2c`) without conflicts. Combined gate: 2,566 runtime, 1,223 mod, typecheck/Lua/generated-Lua and lint pass; nine payload tests pass. Payload repin `ade2cd55` targets production merge `b2019034`. Publication follows the final committed-source gate.
- [ ] Actual server release/native/runtime byte verification and CLI-proxy role routing.
- [ ] One authorized Run Z; same gameplay prompt, 60-minute cap and unchanged limits.
- [ ] Paired stop traces, native idle, validated save, evidence seal and owned resource teardown.

Live measurement remains supervisor-owned: pause AI mutations, remove enemies, observe five wall minutes at 2× speed and require at least ten new automation science packs from the complete automated natural-resource chain. No manual gameplay correction or allowance reset. Preserve approximately 5% usage at completion, with an earlier stop margin for evidence/cleanup.

## Reproducibility and evidence

Task evidence remains under the retained `feat/pump-landfill-removal` checkout, including native mechanics, original-code control, focused lifecycle proof and the first broad run. Combined integration proof is under `test-results/pump-landfill-integration/`; all 26 lane logs, saves and results are preserved. Runtime healthy-restage golden changes only provider body hashes for the new tool/catalog; call sequence, context hashes and message counts remain unchanged.

The native test image built from the combined integration has the same 31 independent native files after symmetric CR normalization for Lua/JSON/LICENSE, with binary files exact. The independent raw native manifest remains unchanged. Control Lua raw hashes differ only in two CR bytes introduced by checkout line endings: independent `56c9149193b83c7c8d51b215d6a06a9e913557429f159d759ecc3ced47d43285`, merged `a1edb85a173110403f232aa555cc29691d2cd97473a9dba564fef09b20d501af`; both normalize to `255c673b8ced6a7ede42ed6afa7b126c5ff9e759d2bc173dcf5dd4c9386f05ce`. Independent review verified equality after deleting only CR. The original failed raw comparison is retained. Actual release verification must derive expected hashes from those independent files using the same text normalization; packaged-versus-active mod comparison remains raw byte exact.
