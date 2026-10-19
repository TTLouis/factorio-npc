# Run AE placement gaps: ground items, fresh topology, drill details, review echo (offline)

Task: `fix/run-ae-placement-gaps`, based on Jev `abdcb799`. The owner asked to
fix the gaps from the latest Jev e2e run, Run AE. Its evidence is under
`test-results/red-automation-live-2026-10-19ae` in the run's checkout. For the
ground-item blocker, the owner chose "pick up on build": a footprint blocked
only by ground items is legal, and the build picks those items up, the way a
player build does. This was an offline task: no live provider or Jev calls, no
gameplay trial and no deployment.

## Gaps observed in Run AE

1. **Ore on the drop tile blocked every furnace.** Burner drill unit 19 at
   (-33,-34) was fueled before its furnace existed. It dropped copper ore on its
   drop point (-33.5,-35.297). The default script `can_place_entity` counts an
   item on the ground as a blocker, so all 52 furnace footprints covering that
   point were rejected. Rotating the drill only moved the spill to its new
   output tile.
2. **Fresh topology lost the drill's identity.** `fresh_topology` dropped
   `unit_number` and the drill's drop position. The fresh executor's first
   `getEntityStatus` call failed for lack of a `unit_number`, and its reads
   went to finding the drill again.
3. **`getPrototypeDetails` crashed on mining drills.** It read
   `require_resources_to_place`, which the 2.0 `LuaEntityPrototype` does not
   have.
4. **Two refused reviews.** The executor sent `plannerReview` and also echoed
   the committed `checkpoint`. Both rounds were refused as
   `invalid_planner_review`, and the refusal did not say why.

## Change

- **Ground items (`placement_ground_items.ts`).** When the native check refuses
  a footprint, `ground_item_blockers` samples the obstruction. If every
  colliding entity is an `item-entity` (1–16 of them, no terrain, no unknown or
  truncated sample), the footprint stays a candidate and lists them as
  `ground_items`. `state_placing` picks them up into the actor inventory, runs
  the native check again, then builds; the receipt carries
  `ground_items_picked_up`. If a stack does not fit, the remainder stays on the
  ground and the operation fails with `ground_items_inventory_full`, which is a
  correctable placement code. Tile-rule entities (offshore pump) keep the
  strict manual check. Scans go through the vision-safe world-scan wrappers.
  The `getPlacementCandidates` tool description states the fact; no prompt
  rule was added.
- **Fresh topology.** Each entity keeps `unit_number` and, from its item I/O,
  `drop_position` and `drop_target`. An entity with item I/O counts as
  relevant.
- **Prototype details.** The `require_resources_to_place` read is removed.
- **Review echo.** For an executor under a frozen plan, a checkpoint sent
  alongside `plannerReview` is stripped and traced
  (`executor.review_checkpoint_ignored`, reason
  `committed_completion_contract_is_immutable`); the committed checkpoint is
  unchanged. Any remaining conflict refuses the review and names it
  (`plannerReviewConflicts`: protocol, role, operations, semanticCompletion,
  checkpoint, missing stepId).

## Evidence

- Mod regressions (`placement_ground_items.test.ts`, 6 tests):
  - candidates over the drop point list the ore;
  - another blocker still rejects;
  - placing picks the ore up and builds (native check runs twice);
  - a full inventory leaves the remainder and does not build;
  - a candidate stays executable until a non-item blocker appears;
  - the offshore pump is excluded.
- `prototype_knowledge.test.ts`: drill details touch only keys the 2.0
  prototype has. The fake throws on the removed key.
- Runtime regressions:
  - `topology-context.test.mjs`: a placed drill keeps its unit number and
    open output point.
  - `role-contracts.test.mjs`: an echoed checkpoint reaches the planner round
    with no refused round, and a refused review names its conflict.
- The restage golden changed only in its 9 request-body hashes, from the tool
  description. Context and trace hashes are unchanged.
- Docker gates:
  - runtime: 2,658 tests passed, 0 failed;
  - mod: 1,241 tests passed in 132 files, plus typecheck, Lua build and the
    generated-Lua check;
  - ESLint passed on every changed file;
  - payload: build, `--check` and 9 tests passed.
- Commits: code `8f1ffcf4`, payload repin `a40d5fb5`.

## Boundary

Not live-tested. Next live run, check three things:

1. The furnace is placed over a spilled drop point, and the trace shows
   `ground_items_picked_up`.
2. The fresh executor addresses the drill by `unit_number` without a search.
3. No `invalid_planner_review` refusal repeats.

Picking items up changes the NPC inventory (one ore, here). Behavior when a
human's dropped stack does not fit is covered only offline.
