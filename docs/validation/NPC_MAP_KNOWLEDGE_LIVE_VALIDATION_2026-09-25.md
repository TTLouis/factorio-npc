# NPC Map Knowledge Live Validation — 2026-09-25

Follows `MAP_ENTITY_REFERENCE_LIVE_VALIDATION_2026-09-25.md`, which found that with
zero connected players the NPC force charts nothing, so every map operation stopped
at `area_uncharted`. Design: `docs/NPC_CHARACTER_ARCHITECTURE.md`, "Map knowledge"
(owner decision, 2026-09-25).

## Engine facts behind the change (2.0.77, zero players)

- On the local provider stack after a cold start, with chunks around the NPC
  generated, an explicit `force.chart` over them left the force with 0 charted
  chunks 2,000 ticks later. The old awareness radar charted nothing either.
- `order_deconstruction` by the player force accepts a neutral tree but refuses
  neutral unit-numbered containers (`wooden-chest`, `crash-site-chest-1`).

## Change

- The hidden awareness radar prototype and entity are removed. Saves from before the
  change drop the radar on load, and the controller clears the stale reference.
- On each chunk change, the NPC requests generation of its 5×5 window (without a
  synchronous drain), records it as visible and explored, and charts it for the
  force.
- Map remote, construction, deconstruction and upgrade treat a chunk as charted or
  visible if the engine says so or the mod's knowledge does.
- Sync with players: when a player joins, every explored chunk is queued to be
  charted, 8 per tick. While players are online, chunks the engine has charted are
  pulled into the explored record every 3,600 ticks and on each join.
- `autorio_map.context` reports `map_knowledge` (explored count, push queue,
  visible centre).
- The staging source preparer now fails closed if the radar prototype returns or
  the window grows beyond 5×5.

## Evidence

Local Docker harness, Factorio 2.0.77:

- The build stage passes: prompt tests, 108 Autorio test files, typecheck, TSTL
  build. `check:lua` and eslint pass on the changed files, and the preparer tests
  pass 5/5.
- `NPC_TEST_LANES=core` passes, and so does `NPC_TEST_LANES=production`. In the
  production lane:
  - MAP_REF: with 0 players, and the engine reporting the NPC's chunk as not
    charted, a map-observed `iron-chest` that the unit-number index doesn't cover
    was inspected, marked and unmarked for deconstruction.
  - FORCE: the enemy chest was rejected with `wrong_force`. The neutral crash-site
    wreck passed the policy, and the engine's refusal came back as
    `deconstruction_rejected`, unmarked.
  - NEARBY, SCOPE, CAPACITY, FACTORY, the belt cell and the powered assembler cell
    also passed.

Not yet exercised in the engine: the player-join push and the chart pull, because
the harness can't connect a client. Unit tests cover both.
