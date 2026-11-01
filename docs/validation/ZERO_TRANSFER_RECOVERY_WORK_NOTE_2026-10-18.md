# Run AA zero-transfer recovery work note

Problem and trigger: a legacy furnace extraction requested iron plates while the output still held copper. Native `nothing_moved` reported zero delivery but supplied no no-mutation proof; the durable uncertainty fence stopped recovery.

Owner / branch / source: Codex `/root` session01a14fa4; `fix/zero-transfer-recovery`; `c0851bf2d32a536bc9329146695786431bbbc435` (current local integration includes the new workflow guardrails; fetched origin was `623d695d`). The owner explicitly transferred integration checkout ownership to this chat on 2026-10-18 after candidate validation.

Outcome: native extraction failures prove no source inventory removal only when their measured removal counter is zero. Existing exact admission reconciliation then permits bounded same-step recovery. A zero delivered count after any removal remains unknown. Player transfers and unrelated failures retain their guards.

Acceptance: real controller/task-manager tests distinguish empty extraction from rollback ambiguity; a scripted full-loop Run AA regression repairs the same immutable step with the existing allowance; real Factorio replays copper-to-iron furnace reuse and produces iron after the correction. Missing proof, stale actor/epoch/batch and partial-removal controls must remain held. No live provider/Jev calls or throughput claim.

- [x] Reproduce with deterministic regression and original-code negative control.
- [x] Implement bounded native proof and correlated classification trace; classification explicitly grants no mutation authority.
- [x] Full Docker gate, applicable native lanes, payload repin and checks; preserve exact exits and versions.
- [x] Independent review; resolve actionable findings.
- [x] Integrate through an available owned checkout; validate merged candidate.

Checkpoint: code `930d0e2b`, separate payload repin `0eb81b81`, task candidate `492bd5bd`, integration merge `6762d7a7795e568622639df22a423510382cb91b`. The merge has the identical tree to the reviewed task candidate. Fresh merged checks passed: 2,592 runtime/staging and 1,233 mod tests, typecheck, Lua/generated-Lua and nine payload tests. Targeted lint passed on the candidate. New Factorio 2.0.77 lane proves ten real copper plates, the unchanged zero-removal failure, exact refusal settlement, missing-proof/admission-lineage/stale-admission controls, and fifty real iron plates after correction. Existing `local-transfer-target`, `partial-transfer` and `production` lanes pass, including the burner-drill/furnace canary and powered assembler cell; all 92 Python checks pass. Original native mod fails the new proof; original TypeScript source fails three new assertions while twenty existing transfer tests pass. Independent reviewer reports no remaining blockers. All owned test containers and both uniquely named test images were removed. Historical Run AA evidence and its untracked validation report remain unchanged. No live trial, provider/Jev calls or deployment occurred.

Evidence: task `test-results/zero-transfer/` is sealed at 309 files / 29,258,422 bytes; manifest SHA-256 `9dd748b9a494537857433bdaceb5e831e9ae3eff7219962630fba563b9c370ac`. Merged gate and publication evidence is separate under integration `test-results/zero-transfer-integration/`. Fresh hosted CI is checked on the published head; local gates do not imply deployment readiness or autonomous red-science completion.

## Separate planning observation requested by the owner

Run AA offered `direct-miner-smelting` at `15:40:01.825Z`. The offer also contained `scale-out-production-line`, but there was no `getSkillDetails` call or `skill.loaded` event before the offer retired at plan commit (`15:40:49.698Z`). Thus the full miner-to-furnace pattern never entered loaded skill context. Jev ranking was shadow-only (`prompt_applied:false`). The deterministic card matching included weak words such as `least`, `one` and `game` for other patterns.

Current native skill text says to *consider* direct miner smelting, and the smelting-row example permits manual supply for tiny goals. The system prompt also says to reuse already-satisfied bootstrap items. The observed planner chose hand-fed research unlocks and reused the starter furnace; the evidence cannot establish its private reasoning or show a mandatory dedicated-furnace rule being violated. For an overall continuous-production goal, evaluating the relevant bootstrap production pattern before committing is a separate planning improvement. This bounded receipt fix does not force skill selection or prescribe a factory layout.
