# Run AK next-fix plan (review only)

Source reviewed: d651508c3c2d075352dffc6602c9181de1dbc188. This plan accompanies the approved preventive-consolidation work; it does not authorize its own implementation, another live trial, publication or deployment.

## Confirmed terminal cause

Run AK produced 99 iron plates and 10 copper plates, then native steam in a reciprocal offshore-pump 34 / boiler 35 network. Steam engine remained held and automated science remained zero. The controller stopped on recovery_mviybmwi at 2026-10-22T02:59:07.408Z.

The final provider response included this checkpoint:

```json
{"mode":"all","requirements":[{"kind":"entity_count","prototype":"steam-engine","minimum":1,"anchor":{"x":-69.5,"y":-65}}]}
```

It has an anchor but no radius. step-completion.mjs boundedRequirement explicitly rejects that combination; dropping scope would silently change the predicate. parsePlanMessage emits invalid_semantic_checkpoint before commitPlan can enforce the existing committed contract. Compact recoverPlan calls parsePlanMessage/commitPlan once, then wraps the validation error as provider_jev_recovery_route_failed. The ordinary bounded plan-category correction path is not used there.

The final prompt carried boiler 35 native steam outlet geometry, water/steam contents and one held engine. Therefore this failure does not prove missing physical geometry or impossible shoreline placement. The response proposed place_entity without an explicit connection/candidate, so repairing the checkpoint alone does not establish a correct factory.

## Proposed bounded units

1. Recovery-response validation repair. Replay the exact response through production compact recovery. Keep anchor-without-radius invalid; send precise reason-coded feedback and reuse the existing bounded pure-validation correction policy under the same request/provider/recovery allowances. A frozen executor continues the exact committed step and cannot replace its completion contract. Prove malformed response -> bounded valid correction -> safe admission; invalid repeat exhaustion; no effects from invalid responses; actor/epoch/cancellation supersession; no false step/goal completion. Do not retry transport/provider outages.
2. Recovery packet-pressure continuity. Replay AK-sized notes (1,168 characters), committed step, fluid hints, inventory and native topology through C6/C7 and provider-time fitting. At final request round 4, planner_review_notes was present; after round 5 C6 rebuild it was absent. active_step_contract was absent in these delivered blocks. A prior C6 block retained zero of two topology entities, but final round again carried boiler geometry. These are per-round facts, not proof that every equivalent fact was lost. Define which active-step facts must remain actionable under the unchanged overall cap, then fix only the reproduced loss with request-correlated delivery evidence. Do not increase budgets or silently relax semantic predicates.
3. Native engine join and power proof. In a disposable copy of the sealed AK save, under exact Factorio 2.0.77 and zero humans, ask the existing connection-aware candidate API for the held engine relative to the real boiler steam outlet; admit a returned candidate, verify native reciprocal fluid connection, steam consumption and electrical output under a real load. Retain a mismatched-orientation negative control and copies of all native receipts/save evidence. Use this deterministic lane to ground future autonomous behavior; placement alone is insufficient. The original save/evidence remains unchanged.

## Coordination and acceptance

Start at most two GPT 6.1 Sol workers. A recovery-runtime worker owns unit 1 and relevant runtime tests; a native-lane worker owns only tests/factorio runner/fixture files for unit 3. Run unit 2 after runtime ownership is returned, since its npc-agent-loop integration overlaps unit 1. Parent owns review, integration and final verification.

Required promotion sequence: exact source freeze; realistic scripted negative controls; independent invariant review; full Docker gate/lint/payload verification; exact-version deterministic steam/electric output proof. A later autonomous E2E remains a separate owner decision and one-trial authorization.

## Evidence provenance

Read-only source: .worktrees/test-run-ak-red-automation. Historical report SHA-256 verified as 72a254d3e8ebe0ae78b6ad2dece45d7f718b3775cd3506f58a36c8dd7e62428a. Frozen tracked diff remained empty.
Evidence: test-results/red-automation-live-2026-10-21ak/data/logs/sgluna-behavior.jsonl and sgluna-prompts.jsonl, analysis/acceptance-summary.json and independent overwatch/final-review.md. Extracted only runtime planning/observation fields; no environment files, credentials or private endpoint values read or reproduced.
