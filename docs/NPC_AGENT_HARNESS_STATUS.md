# AIRI Factorio — NPC Agent Harness Status

This file tracks implementation progress against `docs/NPC_AGENT_HARNESS_PLAN.md` on `feat/npc-transition-work`.

## User-verified checkpoint (2026-09-13)

The user supplied a successful combined Docker runtime log after the `d34a4b3` handoff. The console output is retained at [validation/2026-09-13-npc-core.txt](https://github.com/TTLouis/factorio-npc/blob/8ee348578a87c85af30846772a896e53b8af5d7e/docs/validation/2026-09-13-npc-core.txt). It does not print a source commit or Docker build output, so this record does not independently attest the image revision or claim new build-time test results.

Reported results:

- 14 deterministic Python runner tests passed;
- the real zero-player world advanced 121 ticks across 2.02 quiet seconds, approximately 60 UPS;
- wait completed after 7 observed ticks;
- movement completed after 84 observed ticks;
- mining completed after 364 observed ticks / 6.08 seconds;
- crafting completed after 63 observed ticks / 1.07 seconds;
- the core wait → movement → mining → crafting runner passed with `actor_id=1`;
- placement and both inventory-transfer directions passed with the same actor;
- the complete runtime script reported success.

The 120-tick clock line inside the Python unit test is a mock result. The later 121-tick line after Factorio starts is the real-engine clock result. Likewise, `observed_ups=0.0` for an immediately idle placement/transfer observation means no additional tick was sampled during that wait, not that the world stopped.

This closes the existing deterministic core and placement/transfer gates at their implemented scope. It does not prove live-model planning, research/combat, persistence, death recovery, or every physical-control lifecycle condition.

### Follow-up found in the passing log: physical stop after movement

The core runner's final actor position was `{x=20.03515625, y=0.52734375}`, although its movement target was near `x=10` and arrival had been checked earlier. This exposes a gap: the runner checked arrival at one instant, not that AIRI remained stationary afterward. Source review found that movement completion cleared the task record but never cleared the character's walking input. This explains the apparent drift; the new physical-stop gate below must verify the correction in the engine.

`task_manager.reset_task_state()` now releases controls owned by the outgoing task before clearing its state or starting queued work:

- path/direct movement stops walking;
- mining stops mining;
- attacking stops walking and shooting;
- both cancellation entrypoints use the same cleanup;
- an already-idle reset does not resolve/spawn an actor;
- unrelated controls are not reset just because a wait/crafting task ends.

New deterministic TypeScript regressions cover completion, cancellation, cleanup ordering before queued crafting, missing/invalid actors, and preserving unrelated controls. Python assertion regressions reject drift, active controls hidden behind an idle label, a replacement actor, paused simulation, missing physical telemetry, queued work, or a connected human.

The new `control_lifecycle.py` engine stage runs after the existing gameplay stages in the same world. It checks stationary idle behavior, arrival followed by a quiet interval, movement → queued wait without drift, cancellation of active movement with queued work, and cancellation of active mining without further resource/inventory changes. It uses the original core actor ID, inspects real walking/mining/shooting flags, and leaves two quiet seconds between observations. Fixtures create terrain/targets only: they do not force-stop, teleport, speed up, or replace AIRI to make the assertions pass.

**New lifecycle patch: implemented, awaiting the user's tests.** This is not a complete navigation or combat rewrite. Path-request ID correlation, obstacle/stuck recovery, native hand-crafting queue cancellation, and cross-actor/mode-change ownership remain separate work. Combat stop behavior has new unit coverage but no new engine-combat acceptance result yet.

## Earlier correction — zero-player simulation clock (2026-09-13)

The earlier failing user transcript showed `character_mining_progress` increasing from about `0.0583` to `0.4917`, while the mining task had two cycles remaining and the resource amount remained 19. This was evidence of an unfinished, progressing mining cycle, not evidence that progress was frozen. That excerpt contained neither elapsed timestamps nor game ticks.

The harness previously started Factorio without `--server-settings` and used a 12-second wall-clock mining deadline. That left zero-player auto-pause implicit. A Factorio developer explains that queued RCON commands can temporarily override server pause and cause individual updates; apparent movement during polling therefore does not prove continuous zero-player simulation. See the [Factorio developer explanation](https://forums.factorio.com/viewtopic.php?p=545440) and [LuaGameScript clock API](https://lua-api.factorio.com/latest/classes/LuaGameScript.html).

The clock correction:

- explicitly loads private test-server settings with `auto_pause: false` and `auto_pause_when_players_connect: false`;
- checks that `game.tick` advances across a quiet two-second interval with no intervening RCON commands, before creating/controlling the NPC;
- retains simulation-time budgets for actions (the mining budget is 720 ticks), while applying a separate 120-second wall-clock safety cap per wait;
- fails separately for an exhausted tick budget, a stopped simulation clock, a wall-clock timeout, or a connected human;
- adds elapsed timestamps and `game.tick`, `game.tick_paused`, `game.speed`, and connected-player telemetry to runner observations;
- requires both idle state and an empty task queue before accepting operation completion;
- records the resource's actual engine position and requires the original 20-unit ore entity to remain with exactly 17 units plus exactly three additional ore in AIRI's inventory. A missing lookup is no longer treated as successful depletion;
- includes deterministic Python regressions in the user-run Docker entrypoint.

No production mining-speed boost, instant mining/crafting, fake player, or additional mining-controller rewrite was used to bypass that failure. The user has now reported the independent-clock and combined gameplay pass above. The assistant did not perform the engine run.

`NPC_TEST_WALL_TIMEOUT` can override the wall-clock cap in seconds through `docker run -e NPC_TEST_WALL_TIMEOUT=180 ...` on a slow host. This does not enlarge or reset the simulation tick budget. It is not a substitute for disabling auto-pause.

## Observed in real Factorio

### NPC foundation / passes 1–2

The previous zero-player Docker integration gate targeted Factorio 2.0.77. The user has now repeated the combined runtime successfully with the independent-clock check.

Observed in the real engine:

1. deterministic save creation;
2. Autorio loads successfully;
3. headless server reaches `InGame`;
4. RCON connects and the Factorio 2.0 Lua-console confirmation handshake succeeds;
5. actor mode switches from the migration-safe `player` default to `npc`;
6. a standalone `character` is created with no connected players;
7. the actor has a stable `unit_number` identity (`actor_id`);
8. repeated actor resolution returns the same NPC;
9. actor diagnostics work without a `LuaPlayer`;
10. a real `wait(3)` task reaches the `control.ts` on-tick dispatcher;
11. the task returns to idle;
12. actor identity stays stable and connected-player count remains zero.

### NPC movement / pass 3A

The deterministic movement scenario passed, including in the user's freely running world. Its existing checks prove arrival, not sustained physical stop; the new lifecycle gate covers the latter.

Observed:

1. the harness creates a clear deterministic corridor;
2. a unique `wooden-chest` target is created at a known position;
3. `walk_to_entity('wooden-chest', 50)` reaches the real path-request/on-tick movement path;
4. AIRI moves a meaningful distance;
5. AIRI finishes within the bounded target distance;
6. the operation returns to idle;
7. `actor_id` remains stable and connected-player count remains zero.

Earlier observed arrival: approximately `{x=8.90, y=0.53}` for a target at `{x=10, y=0}`. Do not confuse that arrival sample with the later end-of-core-run position reported above.

## Implemented

### NPC foundation

- Live control resolution goes through `ControlledActor`.
- Standalone NPC mode exists alongside the temporary player fallback.
- Standalone actor identity is persisted/reacquired by `unit_number`.
- Zero-player control-loop smoke harness exists in Docker.
- Docker runtime failures dump Factorio logs, runner errors, clock diagnostics, and incremental RCON transcripts.
- Factorio 2.0's first-Lua-command achievement confirmation is handled deterministically by the RCON runner.

### Agent observation

The source agent exposes bounded read tools:

- `getActorStatus()`
- `getTaskStatus()`
- `getInventoryItems()`
- `getRecipe(item)`
- `getNearbyEntities({ radius?, name?, type?, limit? })`
- `getEntityStatus({ name, radius? })`

`getNearbyEntities` is bounded to a 64-tile radius and 100 returned entities. It supports exact prototype-name and entity-type filters and returns compact summaries rather than raw Lua objects or a whole-map dump.

`getEntityStatus` is bounded to a 32-tile radius. It selects the nearest local entity with the requested exact prototype name and returns compact identity/position data plus bounded inventory summaries: at most eight entity inventories and at most fifty returned item records total. Inventory contents use Factorio 2.x `{name, quality, count}` records.

The production prompt tells AIRI to observe the local area before assuming that a resource, chest, machine, or other world target exists nearby, and to verify placement/item-transfer results before depending on them.

Recipe, nearby-entity, and entity-status tool inputs are validated and Lua-escaped before RCON execution.

### Structured operations

The production prompt asks the model for structured operations rather than Lua strings.

Example:

```json
{
  "name": "mine_entity",
  "args": {
    "entity_name": "iron-ore",
    "count": 8
  }
}
```

The harness:

1. validates operation names and argument shapes with Zod;
2. bounds operation batch size;
3. applies defaults for optional operation arguments;
4. renders only approved operations into Autorio `remote.call(...)` commands;
5. preserves the model's original structured JSON in conversation history.

The old `operationCommands` response field remains compatibility-only and is whitelist validated rather than accepting arbitrary Lua.

### Planning contract

The prompt explicitly teaches:

```text
understand
→ observe
→ plan
→ execute a bounded step
→ wait
→ verify
→ advance or replan
```

The response parser validates:

- chat message size;
- bounded plan length;
- valid `currentStep` indexing;
- exactly one action format;
- bounded/approved structured operations.

### Task observability

`task_manager.get_status_snapshot()` exposes a bounded status containing:

- task state;
- queue-empty state;
- queue length;
- queued task types;
- a current-task summary without exposing raw runtime Lua objects.

`autorio_operations.status()` includes this richer task snapshot while preserving the original `task_state`, `queue_empty`, and `actor` fields.

Crafting status includes the requested/started craft count and compact queued-craft count. Mining status includes remaining requested cycles, current target position, and the last observed resource amount. The integration runners add timing and physical-control telemetry to their own observations without changing the production status contract.

### NPC-native mining / pass 3B — user-reported deterministic engine pass

Standalone mining no longer depends on `on_player_mined_entity` for completion.

The NPC path now:

1. selects the target through the standalone character's inherited LuaControl selection API;
2. drives normal `mining_state` so Factorio performs real character mining;
3. polls the current target/resource state on ticks;
4. detects resource amount decreases or target disappearance as completed mining cycles;
5. decrements the requested remaining count;
6. stops mining and advances the task queue when the requested count is satisfied.

The earlier diagnostic/restart patch changed `StandaloneCharacterActor` to use `character_mining_progress` instead of the generic entity field. Earlier partial traces did not prove the complete three-cycle scenario. The subsequent user-run independent-clock and core gameplay gate now reports completion.

Existing unit regression coverage models both selection remaining on the resource at a zero-progress boundary and selection being cleared after a cycle. These modeled cases must not be confused with exhaustive engine-test results.

Connected-player mining remains event-driven. Its previous final-count off-by-one was also corrected so a one-count task finishes on the first successful mining event rather than waiting for an extra event.

The Docker runner creates deterministic `iron-ore` within AIRI's reach, requests three mining cycles, and checks exact resource depletion and AIRI inventory growth after idle completion.

### NPC-native crafting / pass 3C — user-reported deterministic engine pass

Standalone crafting no longer depends on `on_player_crafted_item` for completion.

`ControlledActor.begin_crafting` returns the number of crafts Factorio actually queued, and actors expose a bounded count of queued crafts for a recipe. The task manager records the pre-task queue baseline and the number actually started. The standalone on-tick path then polls its own crafting queue and completes the task when AIRI's newly queued crafts drain.

Connected players retain their existing event-driven crafting completion path.

The Docker runner seeds four deterministic iron plates, requests two `iron-gear-wheel` crafts, and verifies output inventory, ingredient consumption, an empty crafting queue, idle task state, stable actor identity, and zero connected players.

### Placement + inventory transfer — user-reported deterministic engine pass

This documented gameplay slice is included in the authoritative Docker path and passed in the supplied log.

After the core wait → movement → mining → crafting runner passes, a second zero-player runner:

1. keeps the already-running Factorio world and the same standalone AIRI actor;
2. seeds one `wooden-chest` and five `iron-plate` items into AIRI's own inventory as deterministic test setup;
3. calls the normal `place_entity('wooden-chest')` Autorio operation;
4. verifies a nearby player-force wooden chest exists and exactly one chest item was consumed;
5. calls `move_items('iron-plate', 'wooden-chest', 3, true)`;
6. verifies three plates leave AIRI and enter the placed chest;
7. calls `move_items('iron-plate', 'wooden-chest', 2, false)`;
8. verifies two plates return to AIRI and leave the chest;
9. verifies the same `actor_id` survives the sequence and connected-player count remains zero.

This runner uses the same clock-aware wait helper as the core runner.

Expected success prefix for this stage:

```text
PASS: zero-player NPC completed placement + inventory transfer
```

### Docker validation scope

The Docker build runs:

1. locked workspace dependency install;
2. agent prompt/tool/structured-response contract tests;
3. TSTL plugin build;
4. Autorio unit tests, including NPC completion and task-control lifecycle regressions;
5. Autorio TSTL typecheck;
6. Autorio mod build.

The Docker run then performs:

1. deterministic Python runner regressions (no Factorio/provider required);
2. deterministic save creation and startup with explicit private server settings;
3. a zero-player independent-clock preflight;
4. real Factorio 2.0.77 wait + movement + mining + crafting integration;
5. real Factorio placement + bidirectional inventory-transfer integration in the same zero-player world;
6. physical stop, queued-wait, and movement/mining cancellation integration using the original actor.

The Docker path remains the authoritative validation route without requiring host pnpm/node setup. The user performs the tests. The newly added lifecycle stage and regressions have not been run by the assistant or reported by the user yet.

## Current runtime gate

The original combined gate has a user-reported pass. The next run must retain those results and additionally prove that finished/cancelled tasks stop their physical inputs:

1. simulation advances without RCON polling or a connected human;
2. wait returns to idle;
3. deterministic movement reaches the target area;
4. standalone mining consumes exactly three units from the retained deterministic resource and adds exactly three ore to AIRI's own inventory;
5. the mining task returns to idle and mining state is stopped;
6. standalone crafting consumes four seeded iron plates and creates at least two iron gears;
7. AIRI's crafting queue drains and the crafting task returns to idle;
8. AIRI places a wooden chest from its own inventory;
9. AIRI transfers three iron plates into that chest;
10. AIRI retrieves two iron plates from that chest;
11. AIRI stays stationary after gameplay and after another completed movement;
12. a queued wait starts with walking stopped;
13. cancelling active movement stops it immediately, clears queued work, and remains stationary during a quiet interval;
14. cancelling active mining stops it and leaves resource/inventory counts unchanged during a quiet interval;
15. the same `actor_id` survives the complete sequence and connected-player count remains zero.

Expected success lines include:

```text
PASS: zero-player simulation advances without RCON polling
PASS: zero-player NPC completed wait + movement + mining + crafting
PASS: zero-player NPC completed placement + inventory transfer
PASS: zero-player NPC stops after movement and cancellation
```

## After this gate

Next implementation targets remain aligned with the roadmap:

1. research/combat acceptance scenarios, including task/result semantics and combat movement/stop behavior;
2. save/restart persistence and same-NPC reacquisition;
3. death detection/replacement actor recovery and a post-recovery task;
4. deterministic structured-agent scenarios combining observation, structured operations, verification, and replanning;
5. only after the single NPC is persistent/reliable, begin swarm/message-board architecture.

Pterodactyl migration remains separate from this core NPC/harness work.
