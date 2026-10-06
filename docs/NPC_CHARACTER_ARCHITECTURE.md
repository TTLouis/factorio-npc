# SGLuna Factorio — Autonomous Character Architecture

This note records the body/actor decision for the NPC transition on `feat/npc-transition-work`.

## Decision

SGLuna should be represented in-world as a standalone Factorio `character` entity controlled by the mod, not as:

- a connected human `LuaPlayer`;
- a generic Factorio `unit`; or
- a custom fake actor that reimplements character mechanics outside the engine.

This keeps SGLuna visually and mechanically consistent with another engineer living in the Factorio world while still allowing zero-player operation and later multi-agent/swarm behavior.

Official API references:

- `LuaControl`: https://lua-api.factorio.com/latest/classes/LuaControl.html
- `LuaEntity`: https://lua-api.factorio.com/latest/classes/LuaEntity.html
- `LuaSurface.request_path`: https://lua-api.factorio.com/latest/classes/LuaSurface.html
- `CharacterPrototype`: https://lua-api.factorio.com/latest/prototypes/CharacterPrototype.html

## Why `character` instead of `unit`

A normal Factorio `unit` has a major advantage: native `LuaCommandable` movement and combat commands. However, that abstraction is designed for AI units such as enemies and other commandable actors, not for an engineer-style actor.

Using a `unit` would make movement simpler but would force this project to recreate or fake many mechanics that a real character already has:

- main inventory;
- hand crafting and crafting queues;
- mining state and mining animation;
- armor and equipment;
- gun/ammo inventories;
- character reach/build distance;
- repair/shooting state;
- vehicle interaction;
- character-specific speed modifiers;
- normal character death/corpse behavior.

For SGLuna, preserving those mechanics is more important than gaining `LuaCommandable`.

## Why a standalone character still works

Factorio exposes many character/player operations through `LuaControl`, which is shared by `LuaPlayer` and character `LuaEntity` objects. The official documentation explicitly notes that player-related `LuaControl` functions accessed through `LuaEntity` work when that entity is a `character`.

That gives the standalone SGLuna character real engine-backed mechanics without requiring a connected player.

Conceptually:

```text
                    LuaControl
                        |
             +----------+----------+
             |                     |
          LuaPlayer             LuaEntity
                                   |
                               character
                                   |
                                SGLuna NPC
```

The existing `ControlledActor` / `StandaloneCharacterActor` work on this branch is therefore the correct foundation.

## Inventory must stay physical

SGLuna should use the character's actual inventory through the shared control/inventory API.

This means each future agent has its own real inventory and resource scarcity remains meaningful.

Example:

```text
Builder-01
  inventory:
    10 iron plate
    3 gear wheel

Logistics-01
  inventory:
    100 iron plate
```

Builder-01 should not magically see Logistics-01's items. It must craft, retrieve, or request resources and receive a real transfer.

This becomes important once the swarm/message-board work begins.

## Hand crafting must use Factorio's native queue

`begin_crafting()` belongs to `LuaControl`, so an autonomous character can use Factorio's normal hand-crafting system.

The desired flow is:

```text
SGLuna inventory
    |
    v
begin_crafting(recipe, count)
    |
    v
Factorio crafting queue
    |
    v
output returns to SGLuna inventory
```

Do not replace this with:

- instant item insertion;
- an external recipe simulator;
- a fake timer outside the game.

The branch already moves in this direction by making standalone crafting completion depend on actor/game state rather than `on_player_crafted_item` and `player_index`.

## Mining must remain character mining

The existing approach of driving `mining_state` is preferred because the real character performs the mining and keeps normal animation/engine behavior.

Standalone mining completion should be determined from actor/game state such as:

- mining target validity;
- resource amount changes;
- inventory delta;
- requested remaining count;
- mining state.

Do not make NPC mining depend on player-only events.

## Building is a scripted semantic action

A standalone character does not expose every `LuaPlayer` convenience method, so placement should remain an explicit controlled action.

A correct build operation should:

1. resolve the SGLuna character;
2. verify the entity/item exists;
3. verify SGLuna owns the required item;
4. verify destination/reach constraints;
5. verify placement is valid;
6. create the entity with the correct force and orientation;
7. raise the appropriate build behavior/events where needed;
8. consume the inventory item only after successful placement;
9. return a structured result.

The important rule is that scripted placement must still preserve physical scarcity and positioning.

## Movement is the main tradeoff

A `character` does not receive `LuaCommandable::set_command()`, so movement remains script-driven.

That is acceptable because Factorio exposes `LuaSurface.request_path()` specifically for scripted pathing. The current branch has already proven a standalone character can move in the real engine with zero connected players.

Target movement stack:

```text
semantic goal: walk_to(target)
        |
        v
request_path()
        |
        v
on_script_path_request_finished
        |
        v
waypoint follower
        |
        v
character.walking_state
```

The LLM should never decide per-tick directions.

### Navigation hardening still required

The current project still contains older path-following workarounds such as approximate bounding boxes / non-collision helpers inherited from player-control code. These should be considered technical debt.

The character controller should eventually track:

- actual character collision geometry;
- requested destination;
- acceptable arrival radius;
- active path request ID;
- current waypoint;
- last position/progress;
- stuck duration;
- repath attempts;
- moving/invalid targets;
- cancellation/replacement of movement tasks.

A stuck character should repath rather than fall back forever to blind direct walking.

## Map knowledge (owner decision, 2026-09-25)

A player's character loads and reveals the map around it. The standalone NPC
should behave the same way. Factorio's own chart state is unusable when nobody
is online: on 2.0.77 with zero connected players, the NPC's force had 0 charted
chunks, even with the awareness radar running and 2,000 ticks after an explicit
`force.chart` over generated chunks. Map operations gated on that state always
returned `area_uncharted`.

- The hidden awareness radar is removed.
- Around the NPC, the mod requests generation of the 5×5 chunks (like a player
  loading its surroundings) and calls `force.chart` on them, so players who join
  later see the map.
- The mod keeps its own map knowledge, saved with the game:
  - visible: the 5×5 chunks around the NPC right now;
  - explored: every chunk that was ever inside that 5×5 area.
- Map operations treat a chunk as visible if it's visible in the mod's record or
  in Factorio's (when a player is online), and as charted if it's explored or
  charted. The NPC still can't act on places it has never been near.
- The NPC's map and the players' map are synced periodically in both directions,
  like a team sharing one map:
  - push: chunks the NPC explored are charted for the force, so a player sees
    where the NPC has been. This happens when a player joins (the whole explored
    record) and on a periodic tick (only new chunks);
  - pull: chunks Factorio has charted for the force, for example by a player
    exploring, are added to the NPC's explored record;
  - the work per tick is bounded (a queue drained a few chunks at a time), and
    a sync does nothing while no player is online, because the engine charts
    nothing then.

### Live vision vehicle (hidden)

A character prototype has no `chunk_exploration_radius`, so continuous map vision
needs a separate entity. A hidden car, `sgluna-npc-vision`, follows the NPC and
charts a 5×5 chunk window around itself the way a spidertron does
(`chunk_exploration_radius = 2`, the same size as `KNOWLEDGE_CHUNK_RADIUS`; do not
grow it). It exists only so the NPC's force charts and sees the area around the
NPC. It must not interact with the world at all.

- **Prototype** (`packages/autorio/data.lua`): hidden; no item, recipe, technology
  unlock, `placeable_by` or `minable`; an empty collision mask and a zero collision
  box, so it never blocks placement, walking, belts, inserters, vehicles, trains,
  biters or projectiles; not selectable and no selection box; not a military
  target and a trigger target mask nothing matches; no passengers, no guns, no
  inventory, a void energy source (no fuel, no emissions); no graphics, light,
  sound, corpse or explosion; flags that remove map, blueprint, copy-paste,
  deconstruction, upgrade, repair, kill-statistics and fire interaction.
  `deploy/pterodactyl/staging/source-preparer.mjs` refuses a package that drops
  one of these.
- **Lifecycle** (`packages/autorio/src/npc_vision.ts`, driven from the awareness
  tick, so only for a standalone NPC): at most one vehicle per NPC actor, same
  force, built with `raise_built = false` and without disturbing ghosts or
  corpses under it. Right after creation it is made indestructible, unminable,
  inoperable and unrotatable. It teleports to the NPC when the NPC changes chunk
  or surface and is corrected every 60 ticks. It is destroyed when the actor is
  replaced, dies, is removed or is not a standalone NPC, and rebuilt only for the
  current live actor. `on_init` and `on_configuration_changed` (and every create)
  sweep all vehicles on all surfaces and keep only the one stored for the current
  actor. Each create, destroy, failed create and sweep writes an
  `npc.vision.*` log line with the actor id and a reason.
- **Invisible to the NPC**: every entity scan in the mod goes through
  `find_world_entities` / `count_world_entities`, which drop the vehicle (and
  match nothing when asked for it by name), and exact unit-number references to
  it do not resolve. Placement checks never see an obstacle because the collision
  mask is empty. A unit test fails on any direct engine entity scan.
- **Why `destructible = false` matters**: an enemy told to hunt an area attacks
  any destructible entity of the player force, military target or not (a plain
  chest dies the same way), so the prototype flags alone do not stop it. The real
  engine lane shows a destructible instance dying to a hunting biter and the
  runtime-flagged live one being ignored.
- **Zero connected players**: Factorio charts nothing for a force without a
  connected player: not `LuaForce.chart`, not a powered radar, and not this
  vehicle (active or inactive). The vehicle therefore adds live vision for
  connected observers; the mod's own map knowledge above still covers the
  zero-player case. Whether `active = false` would suppress exploration with a
  player connected cannot be observed headless, so the vehicle stays active (zero
  fuel and no driver, so it cannot move).

## Controller boundary

The long-term API should remain semantic and actor-oriented.

Conceptually:

```text
SglunaCharacterController
|- walk_to(...)
|- mine(...)
|- craft(...)
|- place(...)
|- take(...)
|- give(...)
|- shoot(...)
|- repair(...)
|- enter_vehicle(...)
|- inspect(...)
`- cancel(...)
```

The external agent/harness chooses goals and actions. The Factorio mod owns deterministic execution, ticking, path following, reach checks, inventory mutation, and completion detection.

## Multi-agent / swarm consequence

Once single-character reliability is proven, multiple autonomous characters can be represented independently:

```text
                     SGLuna coordinator
                           |
            +--------------+--------------+
            |              |              |
            v              v              v
       Builder-01       Miner-01      Logistics-01
        character        character        character
        inventory        inventory        inventory
        task queue       task queue       task queue
```

Each actor should have separate persistent state:

```text
ActorId -> character
ActorId -> task queue
ActorId -> active task
ActorId -> plan/state
ActorId -> observations
ActorId -> requests/results
```

The future in-game message board should sit above this actor model and carry coordination records such as:

- tasks;
- material requests;
- claims/leases;
- observations;
- warnings;
- completion results.

Example:

```text
Builder-01 posts:
  need 30 transport-belts

Logistics-01 claims request
  -> gathers belts
  -> walks to Builder-01
  -> transfers items
  -> marks request complete
```

This is preferable to giving all agents one shared magical inventory.

## Things we should not regress to

Unless a real engine limitation forces a fallback:

- do not bind SGLuna back to `game.connected_players[0]`;
- do not require a connected human player for SGLuna to exist;
- do not create fake player accounts just to get inventory/crafting behavior;
- do not replace SGLuna with a generic `unit` solely for easier movement;
- do not simulate character inventory outside Factorio;
- do not instant-craft items;
- do not make the LLM issue tick-level movement commands;
- do not let swarm agents silently share inventory/task state.

## Fallback only if navigation fails

If character path following proves fundamentally unreliable even after proper collision geometry, stuck detection, and repathing are implemented, an invisible commandable proxy unit could be investigated as a pathing helper.

That should remain a fallback because synchronizing a proxy unit and visible character introduces additional collision, position, and lifecycle complexity.

## Acceptance implications

The single-NPC acceptance path should prove the standalone character can perform normal engineer behavior with zero human players:

```text
spawn/reacquire character
-> walk
-> mine
-> craft
-> place
-> transfer items
-> research
-> fight
-> save/restart
-> reacquire same actor
-> death/recovery
-> continue work
```

Only after that foundation is reliable should the project enable multi-character swarm execution by default.

## Architectural rule

**SGLuna is an autonomous Factorio character first, and an AI agent second.**

The agent may reason at a high level, but actions should continue to respect the physical mechanics, inventory, crafting, movement, reach, and persistence of the in-world character wherever Factorio exposes those mechanics natively.
