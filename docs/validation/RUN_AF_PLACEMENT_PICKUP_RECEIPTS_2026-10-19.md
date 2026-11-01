# Run AF preflight: placement pickup receipts fixed and verified natively

On 2026-10-19 the Run AF preflight review of Jev candidate `3fe2bcbf`
(`RUN_AF_PREFLIGHT_REVIEW_2026-10-19.md`, in the reviewer's checkout) found one
P1 blocker. A placement could pick spilled ground items into the NPC inventory
and then fail. Its batch receipt still said `failed_before_mutation`, so
admission and runtime reconciliation settled it as a refusal with no effect,
which contradicted the world. This note records the correction. The work was
offline only: no provider, Jev or live trial ran, and nothing was deployed.

## What changed

- **Measured pickups follow the task.** `state_placing` stores every stack the
  inventory actually took on the task (`ground_items_picked_up`). If a
  destroyed ground stack stays valid, it sets `ground_item_pickup_uncertain`
  and fails with `ground_item_pickup_failed`.
- **The no-mutation proof is withheld after any pickup.** A `PLACING` failure
  keeps `failed_before_mutation` only when nothing was picked up and no pickup
  was uncertain. This covers `ground_items_inventory_full`, a native recheck
  refusal (`not_placeable`), `create_failed` and the uncertain destroy. A
  measured zero pickup, such as an inventory with no room, keeps its proof.
- **The details are kept.** Every later failure result carries the pickup
  list. The remaining stack stays in `ground_item_left`. The runtime
  projection forwards `ground_item_pickup_uncertain`.
- **Safeguards are unchanged.** A mutated placement's cancelled batch has no
  proof, so `operation_admission` records it as `uncertain`
  (`batch_reconciliation_required`). Runtime reconciliation gives
  `admitted_cancelled` / `partial_unknown`, not `refused_before_mutation`. The
  actor/epoch, cancellation, admission and duplicate-effect guards are
  untouched.

## Regressions

These tests inspect receipts, admission records and reconciliation, not only
`last_result`. The mod tests in `placement_ground_items.test.ts`, under
"placement pickup mutation accounting (Run AF)", use the real task manager,
controller, runtime and admission journal:

- **Zero-pickup refusal:** the receipt keeps `failed_before_mutation`, and
  admission records `failed` / `proven_refusal` / `refused_before_mutation`.
- **Partial pickup, then inventory full:** no proof, admission `uncertain`,
  and items conserved (1 held + 2 on the ground = 3).
- **Multi-stack partial:** one stack is fully taken and the next partly. Both
  are recorded, and the 5 items are conserved.
- **Pickup, then a native recheck refusal or `create_failed`:** the pickup is
  reported, no proof is kept, and the furnace is not consumed.
- **Uncertain destroy:** `ground_item_pickup_failed`, with no proof.
- **Pickup, then a successful build:** the receipt and admission are
  completed, and `ground_items_picked_up` equals the inventory change.
- **A second placement after a pickup failure** does not inherit the pickup,
  so its own zero-pickup refusal keeps the proof.

The runtime matrix in `task-loop-matrix.test.mjs` ("Run AF: …") covers the same
cases:

- A zero-pickup refusal reconciles as `refused_before_mutation` /
  `not_happened`, and the corrected placement is admitted.
- A partial pickup, a post-pickup `not_placeable` or a `create_failed`:
  - is never reconciled as a refusal;
  - leaves the pending operation `partial_unknown` and the fixture admission
    `uncertain`;
  - has the duplicate-effect guard suppress the retry;
  - pauses the goal with `operation_preflight_failed:duplicate_effect_suppressed`.

Control against the `3fe2bcbf` sources: all six original Run AF mod tests fail
there. In five, the proof or the pickup details are wrong. In the zero-pickup
case, the only difference is that the old code reported an empty pickup list.

## Native Factorio 2.0.77 lane `ground-item-pickup`

`tests/factorio/runner/ground_item_pickup_factorio.mjs` is registered in
`run.sh`, `run_lane.sh` and CI. It uses zero humans, the real standalone actor,
`fetch` stubbed to throw, and production operations through the protocol-2
authorized batch (`executeAuthorizedBatch` with
`place_candidate`/`place_entity`/`supply_entity`). The fixture setup (pad,
copper patch, stock and the item stacks for the partial and zero phases) is
direct Lua. Each phase reads back the admission record, batch receipt,
`provenRefusal` and `reconcilePendingOperation`.

| Phase | Real-engine result |
| --- | --- |
| SPILL | A fuelled burner drill dropped 1 copper ore on its drop point before any furnace existed. Furnace candidates covering the point list `ground_items`, and native `can_place_entity` refuses. |
| BUILT | The approved `place_candidate` picked the ore up and built furnace 7 over the drop point. The drill targets it and fed ore into it. |
| RECEIPT | `ground_items_picked_up` (1) equals the inventory change. The batch receipt and admission are completed, and the runtime verdict is `admitted_completed` / `happened`. |
| PARTIAL | A 3-ore stack with room for 1 gives a real `ground_items_inventory_full`: picked 1, left 2, conserved. The receipt has no proof, admission is `uncertain`, `provenRefusal` is null, and the verdict is `admitted_cancelled` / `partial_unknown`. |
| ZERO | With no room, nothing is picked up. The world and inventory are unchanged, the proof is kept, admission is `failed` / `proven_refusal`, and the verdict is `refused_before_mutation` / `not_happened`. |

Evidence: `tests/factorio/evidence/ground-item-pickup-2026-10-19.json`. The
`native-admission` lane also passed as a canary on the same image.

Engine note: `game.get_entity_by_unit_number` returned nil for the placed drill,
which matches `AUTORIO_GENERATED_LUA_ENGINE_DEFECTS_2026-09-25.md`. The lane
therefore finds the drill by name and checks the unit number from the receipt.
Production `supply_entity` resolved the same unit number directly. The drill's
`drop_target` is not set in the build tick, so the lane waits for the drill to
feed the furnace.

## Gates

- Docker `scripts/test-local.sh all`: 2,662 runtime tests.
- Mod gate after the review nits: 1,249 tests, `tsc`, Lua build and the
  generated-Lua check.
- ESLint on the changed files.
- `build-payload.mjs` build and `--check`, plus 9 payload tests.
- The native lane and the `native-admission` canary.

The Factorio image build stage reran the autorio tests, typecheck and build.

Commits:

- code `10948bf7`;
- payload repin `bb9a6cb8`, which pins `PAYLOAD_REF` to `10948bf7`;
- review nits `f3975f85`, test-only and not shipped.

The independent read-only review (Sonnet 5.5) returned APPROVE WITH NITS with no
P0 or P1 findings. Its nits were fixed: the multi-stack and fresh-task mod
tests, an actor-clear guard on the fixed partial-pickup site, and the `printf`
newline.

## Limitations

- **A failed pickup pauses the goal.** After a measured pickup failure, the
  operation is held as `partial_unknown`, the duplicate-effect guard
  suppresses the retry, and the goal pauses
  (`operation_preflight_failed:duplicate_effect_suppressed`). The NPC does not
  replan around it. This is deliberately conservative. A "known partial
  effect" proof that lets the planner continue would be a follow-up.
- **`ground_items_inventory_full` is still labelled correctable** in the task
  board, but uncertain admission prevents an automatic retry.
- **Codex's next live E2E still has to check:**
  - furnace placement over spilled ore with `ground_items_picked_up`;
  - the fresh executor using the drill's `unit_number` directly;
  - no `invalid_planner_review` refusals.
