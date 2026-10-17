# Run X offline recovery fixes

Owner request: fix partial-transfer recovery, completion-contract rejection and
the missing stop trace; add full-loop static/native regressions and integrate
into `experiment/jev-agent-architecture`. No live provider run is authorized here.
Source: `de1b92c97dcf8d7cfb4188d72ff7a7d60d0cbe59`.

## Design and authority

Run X's four-task native receipt records three completed transfers and one
`nothing_moved:target_rejects_item` refusal. Cancellation alone remains uncertain.
A new narrow exact proof requires current actor/epoch and generation, the complete
admission signature/ordinal/slot identities, idle native queues, and fully
accounted transfer-only receipts. It archives `admitted_partial/partial_known`,
never whole-batch success or absence. Native admission records become terminal
`partial` so they do not pin unresolved capacity. Missing or malformed witnesses
keep the original uncertainty and scope guard. A closed-partial signature guard
refuses replay of the original batch for the same immutable step.

The existing persistent two-attempt transfer allowance covers the same-step
repair. The executor observes current counts and chooses the missing effects;
neither completed work nor the requested outcome is replaced. Its root checkpoint
cannot lower the committed fifteen-copper checkpoint. A structurally blocked
executor continuation reaches canonical blocked admission rather than being
misread as a new draft missing completion declarations. Planner replacement
drafts retain their original declaration validation.

The stop trace now uses canonical run pause truth, including an operator pause
while the plan projection remains BLOCKED. It preserves the blocker and uncertain
operations. Strict paired trace proof remains unchanged.

## Build checklist

- [x] Causal source fixes and named diagnostic events.
- [x] Full Session/provider static repair and blocked-continuation regressions.
- [x] Native admission positive and malformed-proof unit coverage.
- [x] Separate source review; fresh-actor fallback finding fixed and covered.
- [x] Frozen source, payload repin and full canonical gates.
- [ ] Native reserved-iron furnace repair and unknown-proof control.
- [ ] Original-source failure controls and native regression canaries.
- [ ] Final review, integration, merged canonical gate and remote verification.

All tests use scripted providers, Docker and isolated local Factorio. Historical
Run X evidence and its checkpoint remain unchanged; the broader live goal stays
paused. Final results and immutable source/evidence mapping will be added here.

## Static and build evidence

Production source is `2865d1b47eab22ccd71c6d243f3ef3c0de90f68e`.
Installer source pin commit `be270286f4c6d1f208e15d7eb538fff4337afb5e`
contains the payload pinned to that production source; generated payload SHA256
is `a4553af87969f67ace02763099d7b8760b13dc8b199dde884b5e7a0e1df41f27`.
Later static-test edits improve causal controls and lint without production changes.

Task canonical gate: **2,536 runtime/staging and 1,181 mod tests PASS**,
typecheck, Lua build and generated-Lua checks PASS. Repository lint and all nine
installer payload tests PASS. Targeted final Run X static suite: sixteen PASS.
Original `de1b92c9` runtime fails both positive-loop and blocked-continuation
controls on `missing_step_completions`; the stop-trace original-source control
fails all three new cases. Native admission focused suite: 53 PASS.

Ignored evidence is retained under this task's `test-results/`:
`run-x-task-all-final.log`, `run-x-runtime-final.log`,
`run-x-original-static-control-final.log`, `run-x-lint-payload-verified.log`,
`run-x-native-admission-focused.log` and `run-x-stop-trace/`.

The first official Factorio image build passed at production source 2865d1b4:
`sha256:ffee7fab1964ada41be0147a929b4ef3dc4a3f07ded25af2d2f40b221110a55a`.
Its first native execution independently reproduced the reserved iron craft,
three successful transfers, one copper rejection and exact partial reconciliation.
A fixture callback incorrectly assumed a full entity observation instead of
merging its legitimate diff; that initial failure and save are retained.
This initial execution is not counted as a passing full-loop gate.
