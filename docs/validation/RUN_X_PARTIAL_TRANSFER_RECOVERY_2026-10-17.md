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
- [ ] Frozen source, payload repin and full canonical gates.
- [ ] Native reserved-iron furnace repair and unknown-proof control.
- [ ] Original-source failure controls and native regression canaries.
- [ ] Final review, integration, merged canonical gate and remote verification.

All tests use scripted providers, Docker and isolated local Factorio. Historical
Run X evidence and its checkpoint remain unchanged; the broader live goal stays
paused. Final results and immutable source/evidence mapping will be added here.
