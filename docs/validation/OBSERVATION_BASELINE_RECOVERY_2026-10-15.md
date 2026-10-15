# Run N observation-baseline recovery

Local follow-up to [Run N](RED_AUTOMATION_LIVE_RUN_N_2026-10-15.md), from integration source `1bb4959e0fe14cf126f5e1f9cc95ebc736725148`. No live provider run, server build, deployment or push is part of this unit.

## Change

Compact entity/nearby observations require the exact baseline and required diff messages to remain present, unchanged, in the current conversation and actor/session/epoch scope. Exact entity queries retain their unit number in the query key. A full baseline explicitly carried through normal continuation can be used to interpret a subsequent fresh native read; a rebuilt context without that delivery receives a full native snapshot. Bounded historical metadata remains separate from live mutation authority.

Compaction repair expands an already-obtained native result when its dependency was removed while the newest diff survived. It does not perform an extra observation, reopen tools, spend another recovery generation or admit gameplay. The existing four-entry baseline bounds and context caps are unchanged. Repair records are pruned to tool messages still present in the working context; each expands at most once, so secondary compaction settles in a bounded number of passes. The provider boundary runs this repair after its last context fold. `observation.baseline_rebased` records request ID, tool/query, conversation sequence and reason `current_conversation_has_no_delivered_baseline`.

## Validation checklist

- [x] Canonical Docker gate: 2,390 runtime/staging, 1,142 mod tests, typecheck/Lua/generated-Lua checks, exit 0.
- [x] Static full-loop Run N replay: exact captured blocker/native recipe, closed C5 correction, actual Session recovery timer/C7, full entity/nearby snapshots, output clearing, copper processing, native-shaped crafting receipt and verified lab inventory goal. Same immutable checkpoint, four intended batches, one auto-resume and real scripted Sol/Luna role resolution.
- [x] Focused discarded/edited/compacted baseline and changed-surface cases; normal continuation diff/unchanged behavior preserved. Stop/epoch negatives admit no output collection.
- [x] Review-suggested secondary-compaction regression corroborated: 2,390 total, 2,389 passed and this single expected failure before the follow-up repair. Final full canonical gate is green with all 2,390 tests.
- [x] Frozen original-code static control fails at the missing-baseline boundary.
- [x] Official frozen real-engine image and nine native lanes pass.
- [x] Native original-code control fails at the C7 full-baseline assertion.
- [x] Independent frozen-candidate review finds no corroborated merge blocker.
- [ ] Local integration merge and merged canonical gate pass.

Native fixture setup declares one furnace and held ore/fuel with electronics and steam-power researched. After setup, production admission drives copper10 → output clearing → iron40 → output clearing → copper5 → native recursive lab crafting → lab placement. The lab recipe bill is derived from actual native recipes; the red-science trigger must unlock through real lab crafting. No post-setup inventory insertion, terrain edits, teleporting or forced completion. This lane proves the recovery/construction boundary, not automated red-science throughput; the existing connected-steam/powered-lab lane remains a separate canary.

Frozen code/tests **`cd717daaf43c227b26b2f4cbeb75a067392a8bea`**; official image **`sha256:883668dc617d1fa0d86930212786405a660045de2177f0680d67827ef50e7290`**, pinned Factorio **2.0.77**. All nine network-disabled lanes passed: observation-baseline, shoreline-recovery, invalid-reference, queued-craft, recovery-loop, production, craft-trigger, native-admission and steam-lab. The new proof records eight batches, one C7 auto-resume, zero humans, speed 1, one placed lab, red-science trigger/recipe unlocked through native crafting and the engine-derived 36 iron/15 copper lab bill (four iron plates remain). Scripted main-model/Jev only; no inference transport.

Original controls use the same frozen fixtures with only the two original production modules from `1bb4959e` substituted. Canonical static control: **2,390 total / 2,380 pass / 10 expected failures**, exit 1; all ten new cases fail and no old test fails. Native control fails specifically at the first C7 full-baseline assertion: actual `unchanged`, expected `full`. The secondary-compaction test also independently failed alone before its repair. Independent read-only review of `cd717daa` found no corroborated merge blockers after checking that follow-up.

Evidence is retained locally under `test-results/observation-baseline/`: `all-final.log`, `original-runtime-static.log`, `secondary-compaction-red.log`, `native-final-build.log`, `native-final.log`, `native-proof.json`, `native-original-control.log`, `native-original-error.txt` and native result logs. All frozen runtime/test files remain unchanged. Local merge/merged-gate results will be recorded after integration. The five-minute peaceful, AI-paused benchmark at speed 2 remains pending a separately authorized live trial.
