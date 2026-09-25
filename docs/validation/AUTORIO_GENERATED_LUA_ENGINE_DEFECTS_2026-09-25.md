# Autorio Generated-Lua Engine Defects — 2026-09-25

Follow-up to `PLACEMENT_CANDIDATES_LIVE_VALIDATION_2026-09-24.md`. Placement
candidates crashed in the live engine on constructs the unit tests could not
see. This record surveys the rest of the mod for the same classes of defect.
Each engine fact was probed over RCON on a stack with no goal, so no provider
calls were made.

## Scope and evidence

- Sandbox stack (`scripts/stack-cloud.sh up`), Factorio headless 2.0.77, zero
  connected players, no goal running.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `ea4ff01` (before
  the fix).
- Build survey: `pnpm --filter autorio.ts run build`, then a scan of
  `dist/control.lua`.

## Engine facts (probed in Factorio 2.0.77)

| Construct | Result |
|---|---|
| `fluidbox.length` on a `LuaFluidBox` | raises `LuaFluidBox doesn't contain key length.` |
| `#fluidbox` | `1` for a pipe, `0` for a stone furnace |
| `obj:method(...)` on any LuaObject | raises `Arguments count error … Expected N arguments but N+1 were given` |
| `prototype:get_mining_drill_radius()` | raises `Invalid QualityID` (the self argument lands in the quality slot) |
| `array.length`, `("abc").length` | `nil`, so a comparison raises and `=== 0` is never true |
| `game.get_entity_by_unit_number(u)` | `nil` for transport-belt, inserter, burner-inserter, wooden-chest, stone-furnace, burner-mining-drill, assembling-machine-1, pipe, small-electric-pole and offshore-pump |
| `chest.get_recipe()` | raises `Entity is not crafting-machine.` |
| `assembler.get_max_transport_line_index()` | raises `Entity is not transport-belt-connectable.` |
| `chest.held_stack` | raises `Entity is not inserter.` |
| `type(entity.get_recipe)`, `type(inventory.get_contents)` | `"function"` on every entity, so a JavaScript `typeof` guard never skips a call |
| `defines.inventory.crafter_output`, `defines.inventory.furnace_result` | both `3`: the same inventory |

`game.get_entity_by_unit_number` only indexes prototypes that carry the
`get-by-unit-number` flag. Ordinary buildings do not carry it, so the
lookup only works through `resolve_exact_entity`, which falls back to the hint
recorded when the NPC observed or placed the entity.

## How TypeScriptToLua produces the defects

TypeScriptToLua emits `#x`, 1-based indexing and dot calls only when it knows a
value's type. On an `any` value it emits the JavaScript form literally:

- `x.length` becomes a field read;
- `x.method(a)` becomes a colon call `x:method(a)`, which passes `x` as an
  extra argument;
- `const f = x.method; f(x)` becomes `f(nil, x)`, which passes two extra
  arguments;
- `x.slice(0, 16)` becomes `x:slice(0, 16)`, a nil method on a Lua table.

JavaScript mocks accept all of these, so unit tests pass while the live engine
raises.

## Defects found, by remote tool

| Tool (remote) | Defect | Effect in the engine |
|---|---|---|
| `autorio_planning.throughput_measurement_start` (belt lane) | raw unit-number lookup; colon calls to `get_max_transport_line_index`, `get_transport_line`, `get_detailed_contents` and `get_line_item_position`; untyped `.length` | `entity not found` for every belt or inserter; after the lookup, a raise on the first transport-line call |
| `autorio_planning.capacity` (inserter instance) | raw unit-number lookup | `entity not found` for every inserter |
| `autorio_planning.scope_context` | `(recipe.ingredients ?? []).length` on an untyped recipe | raises when a material with producers reaches `max_depth` |
| `autorio_skills.analyze_area`, `autorio_learning.observe_area`, skill verification re-observation | `get_recipe(nil, entity)` with no crafting-machine check; `get_inventory(nil, entity, id)`; colon `inventory:get_contents()`; `fluidbox.length`; colon `fluidbox:get_pipe_connections()` | raises on the first chest, belt, inserter, furnace, assembler or pipe in the area (reproduced: `Entity is not crafting-machine`) |
| skill verification (power and output checks) | raw unit-number lookups; `held_stack` and transport lines read on every entity type; the same inventory read as both `crafter_output` and `furnace_result` | rebuilt entities reported as disappeared; raises on non-inserters and non-belts; each machine's output counted twice |
| `autorio_learning.record_experiment` | `value.evidence_refs.slice(0, 16)` on an untyped table | raises whenever evidence refs are passed |
| skill verification batch identity | `batch.batch_ref.length === 0` | the empty-ref check never fires |
| live production candidates | `ingredient.name.length === 0` | the empty-name check never fires |
| Task Board blocked banner | `deadlock.detail?.length` | the deadlock detail is never shown |

The existing CI step that rejects `:slice(` in the generated Lua was already
failing on the three `evidence_refs` calls.

## Repairs

- Give each value its Factorio or array type, so the compiler emits `#`, dot
  calls and `ipairs`. Replace the string `.length === 0` checks with `=== ''`.
- Resolve unit numbers through `resolve_exact_entity` in throughput
  measurement, throughput capacity and skill verification. Skill verification
  records a hint when it finds each rebuilt entity.
- Gate engine reads by entity type: `get_recipe` on crafting machines,
  transport lines on belts, `held_stack` on inserters, and one output inventory
  per machine.
- Replace the CI `:slice(` grep, in the same CI step, with
  `packages/autorio/scripts/check-generated-lua.mjs`
  (`pnpm --filter autorio.ts run check:lua`). It rejects:
  - an untyped `.length` outside the lualib runtime;
  - JavaScript array methods called on tables;
  - colon calls of Factorio method names, except on the mod's own wrapper
    receivers;
  - detached Factorio methods called with a nil self.

  The method names are read from the typed-factorio declarations.

## Not changed — raw unit-number lookups outside these tools

The same raw lookup remains in:

- `map_remote.ts`, `map_deconstruction.ts` and `map_upgrade.ts` (inspect,
  deconstruct and upgrade an entity by unit number);
- `navigation.ts` (move to an exact entity);
- `construction_planning.ts` and `construction_site_planning.ts` (anchor unit
  number).

These paths also check charting and visibility, and some can target entities
of another force, which the hint resolver rejects. They need a separate design
decision. With the engine facts above, they cannot find an ordinary building
by unit number.
