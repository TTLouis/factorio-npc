# Run AL contract and Shelf scope follow-up

Owner: Codex /root session01a16167. Branch `fix/multi-batch-step-contracts`.
Source: `695eea0223015e7b0557747d5d71979249f7c280` (latest local Jev candidate).

Problem: Run AL's immutable iron-bootstrap step 4 required supply and collection
receipts plus 58 held iron plates and steam-power research. The first batch only
supplied one coal to each of units 37 and 38. Revalidation demanded a collection
operation in that immediate batch, then would also have forgotten the earlier
supply receipt when collection completed. The exact failure is retained in
`runtime-v8/fixtures/run-al-multi-batch-contract.json`, extracted from sealed AL
canonical state and its normalized final proposal, with source/result identity.

Acceptance: the real protocol-3 scripted loop commits an initially unbound later
step, binds AL's exact step-4 contract, observes both machine identities, admits
AL's two-supply batch and later a separate collection batch. Neither admission
nor fueling alone completes the step. Both verified action types and fresh
inventory/research must pass. Earlier receipt proof survives serialization.
Other plans/steps, failed/unproven transfers and executor contract edits cannot
satisfy or weaken it. No native gameplay mechanic or permission gate changes.

- [x] Extract exact failure fixture; reproduce both batch validation and receipt accumulation defects.
- [x] Implement immutable whole-step validation and durable same-step verified receipts.
- [x] Audit Shelf scope and deliver one consistent milestone rule through planner/schema guidance.
- [x] Docker gates (3082 runtime; 1346 mod/types/Lua), lint and two failing baseline controls; prompt golden refreshed. Payload repin follows in its own commit.
- [x] Independent review APPROVED; evidence `test-results/multi-batch-step-contracts/review.md`.
- [x] Local integration `47e807027e91577d902544e8dba78f2e0fa1c018`; fresh merged 3082 runtime / 1346 mod / types / Lua / lint / payload 9 / installer syntax PASS. No push or live trial.

## Scope audit of the actual Run AL Shelf

The first five nodes name capability/unlock outcomes. Their different durations
are reasonable. `automatic-resources` combines independent iron, copper and
shared fuel outputs; `automatic-science` combines gear supply, science assembly
and final rate acceptance. Those two nodes are appreciably broader than their
siblings. Observation boundaries inside the iron slice are appropriate step
detail, not an argument to make every building a Shelf node.

The new rule is one independently verifiable capability/output per node, with an
explicit exit boundary in `why_it_matters`. An illustrative consistent outline
for a *new* red-science draft is:

| Node | Capability boundary |
| --- | --- |
| Iron bootstrap | Produce the native iron trigger quantity and verify steam-power unlocked. |
| Copper bootstrap | Produce the native copper trigger quantity and verify electronics unlocked. |
| Science recipe unlock | Satisfy the lab-production trigger and verify the science recipe enabled. |
| Steam electricity | Verify a connected water/steam/electric network operating under load. |
| Assembler unlock | Complete automation research and verify assembling-machine crafting enabled. |
| Automatic fuel delivery | Deliver naturally mined fuel automatically to the required consumers. |
| Automatic iron supply | Produce and deliver iron plates continuously from natural iron ore. |
| Automatic copper supply | Produce and deliver copper plates continuously from natural copper ore. |
| Automatic gear supply | Produce and deliver gears from the established iron supply. |
| Automatic science assembly | Connect automatic ingredients, powered science assembly and unblocked output. |
| Sustained science throughput | Verify the requested native output rate over the required window without hand feeding. |

This is a scope example, not a hardcoded build order, layout or recipe graph.
Dependencies and quantities still come from live facts; unrelated unlocks are
not made artificially serial. Mining/smelting/local transport for one output
remain one useful capability. Shared fuel is one utility capability. Unknown
future details remain tentative. The old sealed Shelf is preserved unchanged;
existing committed state is not automatically rewritten for consistency.

The harness can enforce schema/authority, not prove that arbitrary natural
language always describes comparable semantic scope. The change supplies a
shared authoring rule and explicit schema guidance; autonomous compliance needs
a separately authorized future trial. No real model/Jev calls are part of this task.

## Receipt semantics and limitations

Only runtime-created `deterministic_verification` records preserve structured
verified operation names in the existing bounded per-step reducer ledger.
Admission, error, prose and shortened legacy digests do not mint that proof.
Reading uses only the active immutable plan's active step. Existing native
completion, actor/epoch, exact-target and admission checks remain in front of
proof ingestion. Each mutable world requirement is re-read at completion.

The existing receipt retention cap still applies. If old proof has aged out,
completion fails conservatively rather than inventing it; historical snapshots
without structured verified names do not gain proof by parsing display prose.
This does not claim new native engine capability or successful autonomous
red-science production.

## Verified closeout

Code commit: `3e937fe9641079504605218f585b1518f4cf11fc`. Separate payload repin: `410c2e15aa5f26c869fd48876263a6608e618964` (payload bytes unchanged, SHA-256 `c026a45de1c1512f1e62dbda673985e7cd494643ff9fe21a6b23817c91803acf`).

The exact baseline NPC overlay fails both positive AL regressions: the resent checkpoint is rejected with requirement_2, and omitting the resend still cannot combine the later receipt with fueling. The fixed candidate and merged candidate pass all six new cases. Initial prompt-fingerprint expectations were refreshed for the deliberate policy/schema change; the synthetic usage-threshold test retains its provider-versus-character distinction at a larger test-only scale. Production budget limits are unchanged.

Evidence is retained in the task checkout under `test-results/multi-batch-step-contracts/`: `negative-final.log`, `targeted-pass.log`, `all-gates.log`, `merged-all-gates.log`, `merged-package.log`, `review.md` and `final-summary.json`. All tests are offline/scripted. No real provider/Jev or engine trial was started. Owned Docker containers are removed; shared npc-dev is retained. The five integration historical reports and all sealed Run AL evidence are preserved.
