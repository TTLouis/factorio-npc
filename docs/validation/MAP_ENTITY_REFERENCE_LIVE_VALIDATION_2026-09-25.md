# Map Entity Reference Live Validation — 2026-09-25

Follows `COMPILED_LUA_TOOLS_LIVE_VALIDATION_2026-09-25.md`. Design:
`docs/NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md`, "Resolution scopes" and "Nearby
observation ordering" (owner decisions of 2026-09-25).

## Change

- `entity_reference.ts` resolves by unit number in one of two scopes. `actor_body`
  keeps the old rule (the actor's surface and force). `map_visible` searches the
  hint's own surface on any force, and the caller then applies its own checks.
- Map inspect, recipe, deconstruct and upgrade, exact-entity navigation, and
  construction anchors use `map_visible` rather than the raw
  `game.get_entity_by_unit_number()`.
- Map-remote area observations now record hints.
- Navigation resolves once at submit and keeps the `LuaEntity` in the task.
- Deconstruction accepts the actor's own force or `neutral` and rejects other forces
  with `wrong_force`. Upgrade and recipe changes already required the actor's own force.
- `get_nearby_entities` keeps unit-numbered entities first, nearest first, and adds
  `type_counts` over every match.

## Evidence

Local Docker harness (`tests/factorio/Dockerfile`), Factorio 2.0.77,
`NPC_TEST_LANES=production`. Every production gate passes. The build stage passes
(prompt tests, 108 Autorio test files, typecheck, TSTL build), and so do `check:lua`
and eslint on the changed files.

New gates in `compiled_lua_tools_cell.py`:

| Gate | Result |
|---|---|
| MAP_REF | An `iron-chest` placed with `create_entity` is not indexed (`get_entity_by_unit_number` returns nil). Before any observation, `inspect_entity` returns `entity_not_found`. After a nearby observation, inspect and deconstruct both resolve it and stop at `area_uncharted`, and the chest is not marked. |
| FORCE | The enemy and neutral chests resolve and stop at `area_uncharted`. The force policy itself is covered by unit tests only (see below). |
| NEARBY | With 10 ore tiles in radius and a cap of 3, the call kept the awareness radar, the character and a pipe, nearest first, and reported `type_counts` with `resource: 10`. |

## Finding — zero-player worlds are uncharted

With no connected players, the NPC force (`player`) charts nothing:

- In the lane, the fixture chunks stayed uncharted and not visible. That held with
  the awareness radar running, `force.chart` over the area, and a powered radar with
  an energy interface.
- On the local provider stack after a cold start, 0 of 427 generated chunks were
  charted after 42,000 ticks. Calling `force.chart` didn't change that.

So every map-remote operation returns `area_uncharted` when no one is online. That
predates this change, and it conflicts with the rule that zero connected humans is
a valid operating state. The charted-only paths (mark/cancel, the force policy)
are asserted whenever the area is charted. In a zero-player run the cell records
them under `known_limits`; no assertion was weakened. The cause (engine charting
with no players, or the radar setup) is not established. How map operations should
work without charting is an open design decision.
