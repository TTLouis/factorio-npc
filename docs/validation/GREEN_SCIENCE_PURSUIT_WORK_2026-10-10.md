# Green-science pursuit work — October 10, 2026

Owner instruction: actual autonomous E2E research of green science using GPT-6 Luna through CLI proxy; fix the system as needed. A parsed provider response or model pause is not success. Work stays on `experiment/goal-pursuit-harness`, under `D:/SideProjects/airi-factorio-npc/goal-pursuit-harness`. No production deployment, pushes, shared-save changes, operator gameplay takeover, resource replenishment or corrective gameplay prompts.

## Completion contract

Fresh natural world, standalone NPC, zero connected humans, normal speed. Declare the existing starter fixture once: eight iron plates, burner drill, furnace, pistol and ten magazines. Verify at least 75 red packs genuinely produced and consumed, completed `logistic-science-pack` research and enabled green recipe. Retain immutable goal identity, native receipts, provider usage and save. Each live attempt is isolated and capped at 30 provider calls or 20 minutes, with failures and restarts counted durably. Further fixes and bounded attempts are covered by the owner's current instruction; do not run unbounded provider retries.

## Checklist

- [x] Prior transport correction: `f41cd245`, explicit provider tool prohibition; one exact-prompt replay returned a generic pause in 3.5 seconds. This did not prove gameplay.
- [x] Clarify that external JSON actions/observations remain executable while provider-hosted tools are disabled; request concrete evidence for pauses.
- [x] Add a stricter native natural-harvest interface, protecting player assets and refusing ambiguous harvest when reservations exist.
- [ ] Complete deterministic protection/correlation regressions and native tree-harvest proof.
- [x] Independent invariant review and Docker gates: 2,111 runtime tests, 1,049 mod tests, typechecks and generated Lua checks pass.
- [ ] Freeze candidate, repin installer, full build and deployed-file/mod verification.
- [ ] Run bounded fresh-world green-science attempt; diagnose every failed outcome from actual traces.
- [ ] Fix corroborated runtime failures, add regression coverage, repeat bounded isolated validation as needed.
- [ ] Report actual native outcome and remaining limits.

Full working evidence: `test-results/green-science-pursuit-20261010/`. Current implementation owner: this chat; independent read-only reviewer: `/root/proxy_fix_review`.

## Native finding and correction

The first new tree-harvest lane exposed an existing Lua receipt defect: mapping missing receipts produced nil holes, and every() reported completion while native mining was still active. Retained acknowledgement proves the premature completed state. Reconciliation now iterates dense batch references and looks up each exact receipt; absent receipts stay in flight. Independent review found no blocker. Native replay remains pending before live validation.
