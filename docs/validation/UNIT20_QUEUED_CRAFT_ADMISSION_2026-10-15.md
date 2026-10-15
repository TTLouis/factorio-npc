# Unit 20: Run K queued transfer/craft admission

Owner request: fix Run K, add static and native full-loop regressions, integrate after checks, then one CLI-proxy green-science trial. Red/green production automation is the next milestone after the unlock trial.

## Contract and ownership

Run K credited a queued copper withdrawal toward the next craft. The native craft API calls `get_craftable_count` synchronously before queueing. Its current-stock rejection must therefore remain authoritative even when the execution ledger proves that earlier queued work would supply the item later.

The batch-stock decision now converts that attempted override into the existing argument-refusal correction path, before batch dispatch. Guidance preserves the goal and semantic step, requests acquisition alone, its receipt and settled inventory before crafting. No native validation, retry limits, authority, admission ledger or exact-prefix reconciliation changes. A craft already admissible from held ingredients, native recursive intermediate crafting, and craft-to-placement execution dependencies retain their existing contracts.

`craft.preflight_receipt_required` records request/step, operation index, dependency facts and reason `craft_requires_settled_inventory`. Tests assert the event and correlation.

## Evidence and completion checklist

- [x] Static full-loop: mixed batch refused before mutation, corrected collection admitted, collection receipt leads to craft, craft receipt verifies the finite science goal. Same goal/step, two dispatches, no provider failure.
- [x] Static positives/negatives: held copper permits admission; repeated refusal spends only the existing correction; stop and epoch change while correction waits dispatch nothing; lost collection acknowledgement and process/mod restart settle the exact prefix and craft once without replay.
- [x] Pure decision and focused loop tests preserve execution-time consumer contracts and correct the formerly false withdrawal-to-craft admission assumption.
- [ ] Final frozen static Docker gate and original-code red replay.
- [ ] Native `queued-craft` lane. Separate pristine control proves operation 2 refuses synchronously and operation 1 actually transfers the plate. Proof uses real Session/agent, scripted providers, production discovery/preflight/admission/receipts and verifies one real red pack. Zero humans, speed 1, no network inference or post-setup repair.
- [ ] Frozen native recovery-loop, production, craft-trigger, native-admission and steam-lab canaries.
- [ ] Separate review, no-ff integration, merged static gate and push to `experiment/jev-agent-architecture`.
- [ ] Pushed-candidate server build, deployed-byte/cold-world verification and one authorized CLI-proxy run.

Evidence is kept under the unit worktree's ignored `test-results/unit20/`. The native control resolves the furnace through the actual discovery API; a bare fixture ID is insufficient. The isolated native proof starts from an independent pristine map, rather than treating the unsafe control's partial effects as a successful recovery.

## Next milestone: automate both sciences

Unlocking green science is separate from automation. The next milestone must demonstrate real powered assembler/inserter production of both red and green packs, native output over a measured interval, and lab consumption/research continuity. Follow `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`: exact-layout deterministic engine proof before guided/autonomous provider trials; placement-only or hand-crafted output does not prove automation. Preserve the burner drill/furnace canary and keep fluid-network validation separate.
