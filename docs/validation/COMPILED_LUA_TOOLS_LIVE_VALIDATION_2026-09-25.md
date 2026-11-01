# Compiled-Lua Tools Live Validation — 2026-09-25

Adds real-engine gates to `AUTORIO_GENERATED_LUA_ENGINE_DEFECTS_2026-09-25.md`, which
records the defects, the engine facts behind them, the repairs and the
`check:lua` guard. This record covers only the new gates and what they showed.

## Scope

`belt_transport_cell.py` exercises the repaired belt-lane and inserter measurements,
inserter-instance capacity and area analysis of a belt/inserter cell. Three repaired
paths had no real-engine gate:

- `autorio_planning.scope_context` reaching `max_depth`;
- `autorio_planning.capacity` for an inserter prototype, which reads the movement
  speeds (reached otherwise only from a measurement's finalize);
- `autorio_skills.analyze_area` over fluid entities, which reads `#fluidbox` and
  `get_pipe_connections(index)`.

`tests/factorio/runner/compiled_lua_tools_cell.py` covers them in the `production`
lane. It scripts two joined pipes and a filled iron chest, then checks each tool's
answer, not only that it returned.

## Evidence

Local Docker harness (`tests/factorio/Dockerfile`), Factorio 2.0.77,
`NPC_TEST_LANES=production`.

Baseline: `ea4ff01`, plus the unit-number lookup and crafting-machine `get_recipe`
repairs so each gate reaches its generated-Lua path. Every gate raised in the engine:

| Gate | Engine error |
|---|---|
| SCOPE | `attempt to compare number with nil` (untyped `recipe.ingredients.length`) |
| CAPACITY | `Invalid QualityID: expected LuaQualityPrototype or string.` in `____opt_14` |
| FACTORY | `LuaFluidBox doesn't contain key length.` in `fluid_connections` |

The same baseline run's belt-lane measurement raised
`Arguments count error for 'get_transport_line': Expected 1 argument but 2 were given`.
The belt cell now covers that path.

On this branch, the whole `production` lane passes:

```text
PASS: SCOPE - depth-limited scope reports ['depth limit 0 reached']
PASS: CAPACITY - inserter rotation 0.014000000000000002, extension 0.035
PASS: FACTORY - analyzed 3 entities with 2 fluid relation(s)
PASS: MEASURED - belt lanes counted 9 iron-plate, the inserter delivered 8 in a 600-tick window, and area analysis read 9 entities and 8 relations
```

The burner-drill canary and the A1 transport and powered-assembler gates passed in the
same run. Upstream's `check:lua` reports nothing on the built bundle, and
`grep -n "\.length\b" dist/control.lua` finds only the two lualib helper lines.

## Windows checkout

With `core.autocrlf`, `scripts/check-generated-lua.mjs` was checked out with a CRLF
shebang. The Vitest transform rejects it, so `generated_lua_guard.test.ts` failed to
load, and a Docker harness built from a Windows checkout stopped at the autorio test
step. `.gitattributes` now pins `*.mjs` to LF, like `*.sh`.
