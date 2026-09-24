# Placement Candidates Live Validation — 2026-09-24

Follows `JEV_CLOUD_BURNER_CANARY_ATTEMPT4_2026-09-24.md`, which found
`getPlacementCandidates` crashing on every live call.

## Scope

The drill -> furnace path of the burner-drill canary through the harness candidate
system, on real Factorio 2.0.77 in the cloud stack, driven over RCON with no Main-LLM
or Jev calls:

```text
get_placement_candidates(burner-mining-drill, target_resource=iron-ore) -> place_candidate
get_placement_candidates(stone-furnace, covers_position=<drill output>) -> place_candidate
```

## Defects found only in the live engine

Unit tests use plain JavaScript mocks, which hid all four. Each surfaced in turn once
the previous one was fixed.

| # | Symptom on 2.0.77 | Cause | Fix |
|---|---|---|---|
| 1 | `LuaEntityPrototype doesn't contain key rotatable` | `rotatable` is a `LuaEntity` field; Factorio objects raise on unknown keys | use `supports_direction` and the `not-rotatable` flag (`f5719c6`) |
| 2 | `Invalid QualityID: expected LuaQualityPrototype or string` | `prototype.get_mining_drill_radius()` on an untyped object compiled to a Lua method call passing the prototype as the quality | read `mining_drill_radius` (`23cb0d2`) |
| 3 | `attempt to compare number with nil` in `candidate_fluid_ports` | untyped arrays: `.length` compiled to a nil field and indexes stayed 0-based | type the fluidbox arrays (`8811dd9`) |
| 4 | drill candidates had no `item_output_position` | 2.0 returns prototype vectors in array form (`{-0.5, -1.3}`) | accept array and `{x, y}` vectors (`f752f15`) |

Every other prototype field the candidate code reads was probed on 2.0.77 and exists.

## Result

On `f752f15`, over RCON:

- Drill query at a live iron-ore patch: 324 legal candidates; candidate-1 covers 4 ore
  tiles with output tile (204.5, -109.3).
- Furnace query with that `covers_position`: every candidate covers the tile.
- `place_candidate` placed both. Queried after the drill existed, the furnace
  candidates exclude the drill's footprint; candidates computed before the drill was
  placed can overlap it and fail, so the drill must be placed first.
- After fuelling: the drill's `drop_target` is the furnace; plates rose from 20 to 25
  over 20 s with nothing on the ground.

## Regression coverage

`tests/factorio/runner/burner_drill_placement_cell.py` runs this chain in the existing
`production` lane (no new CI job). Its fixture scripts an ore patch and the NPC's items;
placement and fuelling go through the NPC's remote interfaces. The lane passed with the
cell plus the existing belt and assembler gates.

## Found in passing, not changed

The same untyped-`.length` compile pattern exists outside placement: the production
scope depth-limit branch (`recipe.ingredients.length`), transport throughput
measurement (`get_detailed_contents().length`), several fluidbox counts in
`factory_area_learning.ts`, and string-length checks in
`production_planning_candidates_live.ts` and `skill_verification.ts`. Queued as a
separate task.
