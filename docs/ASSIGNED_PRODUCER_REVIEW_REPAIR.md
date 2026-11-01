# Assigned producer advisory review repair

Run BK's original executor proposed iron input into its immutable copper cell.
`factory_cell_input_unproven` correctly rejected the whole batch. The missing
capability was a bounded advisory review of that proposal under the existing
healthy committed plan. No producer conversion or structural replacement is
authorized by this repair.

## Proof matrix

`assigned-producer-review-loop.test.mjs` runs the real request/role/commit loop
against declared synthetic native facts. The fixture retains BK's original raw
operation and held stock; it isolates its active stock step, rather than claiming
to recreate the entire historical plan. Full sealed BK evidence stays local.

| Requirement | Proof |
| --- | --- |
| Baseline | On source `3f2fe5e5`, the real request fails with `factory_cell_input_unproven` at both commit and injected pre-send; local `baseline-05` logs. Earlier fixture setup failures are not baseline proof. |
| Shared prevention/residual | Same private fresh mismatch detector at commit/admission and pre-send; injected commit miss reaches the actual pre-send fence. |
| Safe continuation | Actual planner-role advisory reply, durable notes, fresh executor proposal, same immutable steps/guidance/contracts and unchanged registry; only compatible target is sent. |
| Neighbor forms | Raw JSON and submitPlan; supply_entity, inbound move_items_exact and new finite producer proposals. Existing assigned same-job admission remains unchanged. |
| Guard exclusions | Unknown recipe/fuel, unrelated material, mixed batch, private controller ownership and forged serialized witness cannot mint review eligibility. |
| Async fences | Busy/unknown/uncertain native status, actor/epoch/session/world/request/role changes, restore, revoked grant, owner pause, changed recipe and cancellation during durable persistence. |
| Durable limits | Strict save failure sends neither review nor mutation; one per-step advisory and shared three-attempt per-goal factory cap persist across disk restore; repeated wrong target exhausts. |
| Failure classification | Advisory provider failure remains provider failure; expected exhaustion is guard, no provider retry. |
| Composition | Existing structural factory recovery, advisory role contracts, finite production and AS entity-refresh tests remain unchanged. |

Focused fake-native results establish harness behavior only. The parent-owned
full offline gate and exact-version native canary remain required before live use.

## Native canary contract

Use an isolated fresh Factorio **2.0.77** world, zero humans, the exact candidate's
native mods, normal speed and a dedicated RCON port with fixture-only password
`offline-fixture-only`. Record exact container/project identities before starting;
the parent owns server startup, final save, pristine load and finally teardown.
The driver never calls external providers and rejects any fetch.

```sh
node tests/factorio/runner/assigned_producer_review_factorio.mjs \
  --repo /candidate --results /evidence/results --host FACTORIO_HOST --port RCON_PORT
```

The declared setup clears a small terrain region and seeds two held furnaces,
native-derived input and native-derived fuel. Separate actual placement batches
create exact custody receipts. An ordinary finite controller first produces and
collects copper and iron using distinct registered jobs. A later stock step
issues the wrong raw iron-to-copper proposal. One scripted **planner-role** review
returns notes, then a new **executor-role** proposal targets the iron producer
and the ordinary controller produces/collects additional iron. No live model
selection or autonomous throughput claim is made by this scripted proof.

The driver checks original placements and both registry assignments, unchanged
plan/steps, durable review/allowance state, actual native output, nullable native
recipe and exact bounded spatial identity. As in the existing cross-step canary,
canonical restore may trim only closed diagnostic receipt tails to exported
`RECEIPT_LEDGER_LIMITS.closedPlanPerStep`; every other field is compared exactly.
The fixture stops at the verified bootstrap slice using existing
`allowContinuation:false`; its long-horizon automation goal remains active.

Artifacts: `canary.json`, `transcript.json`, `events.json`,
`scripted-replies.json`, `canonical-state.json`. `canary.status` must be `passed`,
`providers` zero, and final native state paused, speed one, zero humans, idle with
empty queues. A fixture failure remains failed even if preceding gameplay worked.

Before reload, stop/save and preserve the original ZIP separately from the
working reload copy. Do not rerun the driver on reload. Read the same
`sgluna_factory.world_identity` and assert `canary.world_id`. For **both**
`canary.native_products` rows, use `placement`'s exact surface/force/name/position/
unit locator (at most eight results within radius 0.25; reject truncation or
ambiguity), matching native getEntityStatus and the actor identity. Assert held
`output_item` at least `expected_minimum`, unchanged `products_finished`, and
nullable actual `recipe` separately from immutable `expected_recipe`.
`final_snapshot.factory_registry` and `factory_placement_receipts` provide the
host metadata/provenance identity; do not confuse these with native commissioning.
Retain original/reload ZIP hashes, transcript, engine version, pause/idle proof
and exact cleanup receipt outside disposable resources.
