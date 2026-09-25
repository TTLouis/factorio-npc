# AIRI Factorio — Autonomous Character Architecture

This note records the body/actor decision for the NPC transition on `feat/npc-transition-work`.

## Decision

AIRI should be represented in-world as a standalone Factorio `character` entity controlled by the mod, not as:

- a connected human `LuaPlayer`;
- a generic Factorio `unit`; or
- a custom fake actor that reimplements character mechanics outside the engine.

This keeps AIRI visually and mechanically consistent with another engineer living in the Factorio world while still allowing zero-player operation and later multi-agent/swarm behavior.

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

For AIRI, preserving those mechanics is more important than gaining `LuaCommandable`.

## Why a standalone character still works

Factorio exposes many character/player operations through `LuaControl`, which is shared by `LuaPlayer` and character `LuaEntity` objects. The official documentation explicitly notes that player-related `LuaControl` functions accessed through `LuaEntity` work when that entity is a `character`.

That gives the standalone AIRI character real engine-backed mechanics without requiring a connected player.

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
                                AIRI NPC
```

The existing `ControlledActor` / `StandaloneCharacterActor` work on this branch is therefore the correct foundation.

## Inventory must stay physical

AIRI should use the character's actual inventory through the shared control/inventory API.

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
AIRI inventory
    |
    v
begin_crafting(recipe, count)
    |
    v
Factorio crafting queue
    |
    v
output returns to AIRI inventory
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

1. resolve the AIRI character;
2. verify the entity/item exists;
3. verify AIRI owns the required item;
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

## Map knowledge (owner decision, 2026-09-25; not implemented yet)

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

## Controller boundary

The long-term API should remain semantic and actor-oriented.

Conceptually:

```text
AiriCharacterController
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
                     AIRI coordinator
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

- do not bind AIRI back to `game.connected_players[0]`;
- do not require a connected human player for AIRI to exist;
- do not create fake player accounts just to get inventory/crafting behavior;
- do not replace AIRI with a generic `unit` solely for easier movement;
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

**AIRI is an autonomous Factorio character first, and an AI agent second.**

The agent may reason at a high level, but actions should continue to respect the physical mechanics, inventory, crafting, movement, reach, and persistence of the in-world character wherever Factorio exposes those mechanics natively.
