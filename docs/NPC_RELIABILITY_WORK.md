# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole remaining single-NPC reliability scope first, without rushing a release. The user runs the tests. Do not merge to `main`, change the default actor mode, publish a release, or ship a Pterodactyl migration merely because one additional scenario passes.

## Latest user-reported checkpoint

The last fully successful combined Docker run reports:

- real zero-player simulation continued at approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- physical stop and cancellation semantics passed;
- native research completed through real labs while the NPC continued other work;
- bounded combat and its no-target/no-ammo/cancellation cases passed;
- an actively walking NPC plus queued work survived a real save/process restart as a world entity, while volatile Autorio work was deliberately discarded and serialized controls were reconciled;
- the restarted process reacquired the same `actor_id=1`, preserved force/inventory/world state, and completed fresh work;
- killing that body invalidated stale active/queued work, created empty replacement `actor_id=18` on the same force, and the replacement completed fresh movement;
- bounded navigation on replacement `actor_id=18` routed around an obstacle, repathed to a moved target, explicitly failed an unreachable water-island target while cancelling dependent work, and distinguished passive transport-belt displacement from AIRI-controlled walking;
- zero connected players were maintained throughout;
- the runtime smoke completed successfully.

This closes the bounded research, combat, save/restart, death-recovery, and navigation gates at their stated scopes. It does not close repeatable/trigger research, native crafting ownership/cancellation, generalized cross-actor ownership, explicit outcome semantics for every operation, or end-to-end autonomous planning.

## Research request semantics — user-verified bounded gate

`research_technology` enters NPC task order. Admission acknowledges the NPC request, not Factorio acceptance or technology completion. Execution revalidates the technology and requesting actor/force before calling `LuaForce.add_research`.

Research is asynchronous force-wide work. The NPC is released after submission and can keep working while labs run. Unknown/disabled technologies, disabled force research, missing prerequisites, gameplay-trigger technology, and conflicting force research are rejected. Existing different research is never replaced. Duplicate active/queued work is not duplicated; already researched technology is idempotent. Deferred requests bind to actor ID, actor kind and force index. `getResearchStatus()` and `getTechnology({ name })` distinguish request/submission state from native completion.

The user-verified gate supplied prerequisites, labs, power and exact science as a bounded fixture. It proves native research behavior, not autonomous bootstrap.

## Bounded real combat — user verified

The bounded combat controller binds combat to actor/force identity and one target, uses the selected weapon's real `can_shoot` result, stops walking before firing, limits no-progress/total duration, reports explicit failure codes, cancels dependent queued work on failure, and completes only after the bound target is actually gone. Production setup no longer deletes enemies.

The real-engine gate verified target destruction, real ammunition consumption (including rounds from a partially used magazine), stable NPC identity, no-target failure, no-ammo failure without target damage, dependent-queue cancellation, and stopping an out-of-range approach without target damage. A stopped control state is the ownership guarantee; world mechanics such as transport belts can still passively displace a character and must not be confused with AIRI continuing to walk.

## Real save/restart persistence — user verified

Factorio persists the standalone character entity and `storage`, while ordinary Lua module locals are rebuilt when a save loads. Autorio's logical task manager is intentionally volatile across load boundaries. The standalone character entity and engine state persist.

The verified base persistence policy is fail-safe:

1. persist/reacquire the same standalone character via stored unit number;
2. discard volatile Autorio logical active/queued operations on load rather than pretending they resumed safely;
3. `script.on_load` only marks local reconciliation work; it does not access `game` or mutate `storage`;
4. on first normal NPC resolution, stop serialized walking/mining/shooting inputs and clear stale path rendering;
5. expose reconciliation through `autorio_actor.status`;
6. operation-specific persistent native work must define its own ownership/reconciliation rule rather than being silently assumed complete.

The real gate saved an actively walking NPC with queued work, stopped the first Factorio process, started another process from the same save, reacquired the same `actor_id=1`, preserved expected inventory/force/world state, observed an idle empty Autorio queue with released controls, then completed a fresh movement task on the same body. Its quiet no-drift fixture is intentionally belt-free; released controls do not generally imply fixed coordinates.

## Bounded death recovery — user verified

A missing persisted NPC is an ownership boundary, not permission to continue its old task on a replacement body.

Verified behavior:

1. detect that the persisted standalone unit number no longer resolves to a live character;
2. invalidate active and queued Autorio work before replacement creation;
3. perform logical invalidation without resolving/controlling an actor, avoiding replacement recursion;
4. clear stale path rendering;
5. create a new standalone character on the same force;
6. do not copy the dead body's inventory (`inventory_policy: no_transfer`);
7. persist/expose a recovery receipt binding old/new actor IDs, force, tick, reason and inventory policy;
8. require fresh work on the replacement rather than inheriting old physical intent.

The real engine gate killed active `actor_id=1` while it was walking with queued work. The old target survived, a corpse was observed, replacement `actor_id=18` was created without copying marker inventory, and fresh movement completed at approximately 60 UPS.

## Bounded navigation reliability — user verified

The historical movement path discarded asynchronous path request IDs, could accept stale path events, blindly switched to direct walking after pathfinder failure, had no bounded path calculation/stuck policy, held stale moving-target coordinates, and treated raw coordinate displacement as progress.

The verified navigation controller now:

- validates search radius at 1..256 tiles;
- binds one target plus actor ID/kind/force;
- stores the exact `LuaSurface.request_path()` ID and accepts only its matching completion event;
- ignores stale/late results after cancellation, replacement, timeout or retry;
- handles `try_again_later` with bounded delayed retries;
- bounds path request waits, total duration, path attempts and no-progress time;
- never falls back from path failure to blind direct walking;
- repaths when the bound target materially moves;
- measures useful progress as reduction in distance to the current waypoint rather than raw position change;
- uses the actual character prototype's collision box/mask for pathfinding and character collision semantics for start validation;
- completes only within the bounded arrival distance of the exact bound target;
- reports explicit results including `reached`, `no_target`, `target_gone`, `unreachable`, `path_busy`, `path_timeout`, `stuck`, `timeout`, and `actor_changed`;
- cancels dependent queued operations on navigation failure;
- exposes target/path/result state through `getNavigationStatus()` / `autorio_navigation.status`.

### User-verified navigation acceptance

The real engine gate on replacement `actor_id=18` passed all four cases:

1. **Obstacle route** — AIRI routed around a solid stone-wall barrier to the exact steel chest.
2. **Moving target** — after an initial real path was accepted, the exact wooden chest moved eight tiles; AIRI issued another path and reached the relocated entity.
3. **Unreachable target** — an iron chest isolated by a water moat returned explicit `unreachable`, dependent work was cancelled, the target remained alive, controls stopped, and the belt-free fixture did not drift afterward.
4. **Passive belt displacement** — an idle NPC with walking/mining/shooting controls released was physically moved by a live transport-belt line. The harness correctly treated this as environment-driven displacement rather than stale AIRI movement.

User-reported success:

```text
PASS: zero-player NPC bounded navigation routed obstacles, repathed moving target, failed unreachable target, and distinguished passive belt displacement with actor_id=18
```

## Current slice: native crafting ownership and cancellation

Status: implemented; engine-verified by the `crafting` lane (`tests/factorio/runner/crafting.py`: owned native crafting completion and cancellation).

The old hand-crafting path had ambiguous ownership and completion semantics: `begin_crafting` was called directly from task activation, cancellation did not cancel task-owned native crafting, pre-existing native queue work could be mixed with an Autorio request, and queue disappearance could be treated as completion without proving requested output.

The new bounded crafting policy is intentionally conservative:

1. bind every admitted craft to actor ID, actor kind and force;
2. allow an Autorio-owned native craft to start only when the character's native crafting queue is empty;
3. if native work already exists, reject with `native_queue_busy` without cancelling/reordering/merging it;
4. once started from an empty queue, treat native entries created by that request, including prerequisites, as request-owned;
5. require the full requested count to be admitted; partial native admission fails closed and cancels the owned native queue;
6. verify completion using actual requested-item inventory increase after the owned native queue drains; queue disappearance alone returns `output_missing` rather than success;
7. explicit Autorio cancellation cancels the task-owned native queue and dependent Autorio work, then proves no additional output appears afterward;
8. missing ingredients, unavailable/locked recipes, invalid counts, timeout and actor identity changes produce explicit bounded failure receipts;
9. expose native queue state, persisted owner and last result through `autorio_crafting.status` / `getCraftingStatus()`;
10. structured `craft_item` is limited to 1..1000 crafts.

### Crafting save/restart ownership

A native character crafting queue is engine state and can persist through a save even though the logical task manager does not. Therefore active Autorio-owned crafting now writes a small ownership marker to Factorio `storage` containing actor identity, force, item, count and start tick.

On load:

- `script.on_load` still only marks reconciliation work;
- first normal resolution of the same standalone body checks the persisted owned-crafting marker;
- only a marker that exactly matches the reacquired actor/force authorizes native queue cancellation;
- that owned queue is cancelled before it can continue as orphaned post-restart work;
- unmarked/pre-existing native crafting is not cancelled merely because a save loaded;
- if the old body died, its matching crafting marker is discarded with that body so the replacement cannot inherit/cancel it;
- load reconciliation exposes an owned-crafting receipt with actor ID, item, requested count and cancelled native queue count.

### Crafting acceptance gate

The combined Docker path now continues after the verified navigation stage. It verifies:

1. **Real output completion** — craft three `iron-gear-wheel`; require native queue drain plus actual inventory increase and exact `completed` receipt.
2. **Pre-existing native queue preservation** — start a long unrelated native `copper-cable` queue outside Autorio; `craft_item` must reject with `native_queue_busy` while the unrelated queue remains present and unchanged in recipe identity.
3. **Owned cancellation** — start a long Autorio-owned gear queue with a dependent wait; cancel all Autorio work; require native queue empty, dependent queue empty, `cancelled` receipt, and no later output after a quiet interval.
4. **Explicit rejection** — prove `not_enough_ingredients`, `recipe_unavailable`, and `invalid_count` are bounded failures with no work left behind.
5. **Real restart while crafting** — save with a long Autorio-owned native craft active plus queued work, stop Factorio, start a new process from that save, require same actor reacquisition, volatile Autorio queue discarded, persisted owned native crafting cancelled by exact ownership marker, no later output, then complete a fresh owned craft on the same body.

Expected success lines include:

```text
PASS: zero-player NPC native crafting verified real output, preserved unrelated queue, and cancelled owned work with actor_id=18
PASS: zero-player NPC restart cancelled persisted owned native crafting and completed fresh craft with actor_id=18
```

The assistant has not executed this new build or real crafting gate. Do not treat crafting ownership/cancellation as proven until the user's Docker run reports it.

## Remaining section-4 work

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | Interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | Bounded real combat gate is user-verified. Broader combat/terrain interaction should consume verified navigation outcomes rather than invent separate success semantics. |
| Save/restart | Base real stop/restart gate is user-verified. The current crafting slice adds explicit persisted native-craft ownership reconciliation and still needs its user-run second-restart gate. Research follow-through persistence remains separate. |
| Death recovery | Real body-loss/replacement gate is user-verified. Crafting marker cleanup on body loss is implemented in the current slice and awaits the combined build/runtime gate. |
| Navigation | Bounded obstacle, moving-target, unreachable, stale-path and transport-belt semantics are user-verified. |
| Crafting and cancellation | Current user-run gate above; afterward evaluate remaining full-inventory/product/quality edge cases exposed by real Factorio behavior rather than weakening output verification. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Body loss and navigation/crafting ownership are partly covered, but deliberate mode/force transitions and remaining operations still need generalized ownership. |
| Outcome semantics | Explicit success/failure for all operation types; no generic "completed" on silent mining/place/transfer failures; stop dependent batches appropriately, including immediate rejection during submission. |
| End-to-end agent | Durable operational goal/step state, bounded runtime context, real prompt/tool/executor/Factorio loop with scripted model boundary, missing-material and changed-world recovery, verification before advancing, bounded provider/tool retries. |

Work in reviewable slices and keep previously passing scenarios in every combined run. Swarm/message-board execution remains out of scope until the single NPC is reliable. The swarm architecture document is planning material only and does not change this release gate.

## Later main and Pterodactyl migration (blocked)

The user requested a coordinated main/NPC/deployment update only after the single-NPC work is genuinely ready. The later deployment candidate must update installer source, generated installer payload, egg installation script, environment variables, startup/runtime behavior and deployment documentation together. Test clean install and update of an existing save/configuration; preserve backups and rollback. Separate chat authorization from NPC ownership; do not require a connected human or hard-coded player index.

No `main` merge, release/tag, default-NPC flip, or Pterodactyl installer/egg change is included in these reliability slices.

## API references

- [LuaForce 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaForce.html)
- [LuaTechnology 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaTechnology.html)
- [LuaEntity 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaEntity.html)
- [LuaBootstrap 2.0.77 on_load](https://lua-api.factorio.com/2.0.77/classes/LuaBootstrap.html)
- [LuaGameScript 2.0.77 server_save](https://lua-api.factorio.com/2.0.77/classes/LuaGameScript.html)
- [LuaSurface request_path](https://lua-api.factorio.com/2.0.77/classes/LuaSurface.html#request_path)
- [on_script_path_request_finished](https://lua-api.factorio.com/2.0.77/events.html#on_script_path_request_finished)
