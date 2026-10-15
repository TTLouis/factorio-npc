# Unit 22: local shoreline exploration recovery

Owner request: fix Run M, add static and real-engine full-loop tests, integrate after checks; **local only, no push or live provider run**.

## Contract

The runtime keeps bounded native evidence from an empty offshore-pump placement search and an inconclusive water search. An executor's unsupported `BLOCKED` answer on that same request/goal/committed step is rejected through the existing three-attempt category correction. The correction supplies observed unexplored centers as optional exploration facts. The model chooses the next action; the harness neither picks a destination nor performs gameplay on its own. Normal observation caps, goal/step ownership and native admission remain authoritative.

Evidence is confined to the same actor, epoch, world-mutation sequence and request, expires after two minutes, and is discarded on mutation or process restart. Positive/failing/mismatched water reads replace old negative coverage. No carried center is a placement, reachable destination or global water guarantee. Fresh discovery follows movement receipts.

The native full loop also exposed a completion gap: `place_candidate` runs the same native `placing` task as direct placement but was absent from strict receipt mapping. A clean correlated candidate-placement receipt now permits the normal world checkpoint evaluation. It does not itself verify a powered lab. `step.candidate_placement_receipt_checked` records request/batch/step and reason `strict_native_placement_receipt_requires_world_checkpoint`; mismatched, failed, active or queued receipts remain unverified. The native fixture asserts unpowered placement cannot close the result before actual steam generation, power and science consumption.

## Checklist

- [x] Runtime guard and named request/reason trace; fail-closed bounded native facts.
- [x] Exact sanitized Run M search outputs replay through the production Session/Sol/Luna resolver to exploration, fresh discovery, verified output and unchanged checkpoint.
- [x] Static cancellation/epoch, existing-cap exhaustion, and lost-ack restart without walk replay. Candidate-receipt negatives retain scope and completion fences. Initial complete local gate passes 2,380 runtime/staging and 1,142 mod tests, typecheck/Lua checks (`all-first.log`).
- [ ] Native deterministic distant shoreline through real walking, fresh pump candidate, connected boiler/engine and powered lab/research; placement-only negative.
- [ ] Original-code static/native red replay; full Docker gate and existing native canaries.
- [ ] Frozen commit, separate read-only review, no-ff integration and merged canonical checks.
- [ ] Preserve root checkout's pre-existing changes; document local integration commit. No push, server build, live inference or E2E run.

Evidence: ignored `test-results/unit22/` in the unit/integration worktrees. The original Run M report and traces remain unchanged. Scripted Jev relevance uses valid live contract shapes and existing bounds; it is fixture setup, not a production limit change.
