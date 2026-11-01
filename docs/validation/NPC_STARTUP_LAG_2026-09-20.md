# NPC startup / launch lag investigation — 2026-09-20

## Symptom

Interactive E2E testing reported a hard lag/freeze while launching or entering the game with the Autorio/SGLuna mod enabled.

This investigation separates ordinary Factorio/mod loading from control-stage work that can synchronously stall the simulation.

## What the packaged smoke shows

The packaged zero-player smoke before this change (code revision `b68f1da2ee3b2832a0218f5b80f860db88bc669b`) does **not** show Autorio's data stage or Lua bundle load taking seconds:

- Autorio `data.lua` entered around 0.171–0.180 s and the next mod began around 0.182–0.187 s: roughly 10–11 ms in this headless run.
- During map load, Autorio `control.lua` reached its `[AUTORIO] Mod loaded 1` marker roughly 31–32 ms after the level-script checksum line.
- The packaged server reached the SGLuna ready marker normally.

That makes ordinary prototype loading and parsing of the current ~36k-line generated control bundle poor explanations for a multi-second hard freeze.

Headless timings are not a client GPU/graphics benchmark, but they are enough to show that the obvious data/control load phases are small in the packaged runtime.

## High-risk synchronous chunk-generation path

Two Autorio paths were synchronously draining Factorio's chunk-generation queue:

1. Cold standalone-NPC creation in `actors/actor_controller.ts`
   - If the spawn chunk did not exist, the code requested radius 3 around spawn and immediately called `force_generate_chunk_requests()`.
   - Radius 3 is up to a 7x7 / 49-chunk request around the spawn point before the NPC can be created.

2. Standalone-NPC awareness in `awareness.ts`
   - On the first awareness update and every chunk-boundary crossing, Autorio requested a radius-1 / 3x3 window and then called `force_generate_chunk_requests()`.
   - This turns an otherwise amortizable terrain-generation request into a synchronous simulation stall.
   - The force call drains the surface's pending generation work at that point, so the visible pause can be larger than the small window Autorio itself requested.

These paths fit the reported symptom much better than mod parsing: they run after the map is entering live control state and can look like the whole game freezes.

## Fix

Code revision through `284e62dbdb423edd99ad134a513b9130c1b0002e` changes the launch/movement generation policy:

- Cold NPC creation still guarantees that enough terrain exists to create the character, but reduces the synchronous request from radius 3 to radius 1.
  - old worst-case local request: 7x7 / 49 chunks
  - new local request: 3x3 / 9 chunks
  - the 3x3 window is sufficient for the existing 32-tile non-colliding spawn search.

- Awareness still requests the 3x3 neighborhood when AIRI enters a new chunk, but no longer calls `force_generate_chunk_requests()`.
  - Factorio can process the queued nearby chunks over subsequent ticks instead of blocking one frame.
  - The hidden radar continues to provide the intended nearby awareness as terrain becomes generated.

This is deliberately narrower than removing synchronous cold-spawn generation completely. A zero-player world previously proved that creating the standalone character before its spawn chunk exists can fail, so the one required creation boundary remains synchronous but much smaller.

## Regression coverage

The Autorio tests now assert:

- a cold NPC spawn requests radius 1, not radius 3;
- the cold spawn still performs the required one-time synchronous generation before character creation;
- awareness requests its radius-1 neighborhood;
- awareness never calls `force_generate_chunk_requests()`, including first tick, same-chunk updates, chunk crossings, and actor-mode transitions.

## Validation

At code HEAD `284e62dbdb423edd99ad134a513b9130c1b0002e`:

- CI run `35557568193`: **success**
  - `factorio-npc-deterministic`: success
  - `typescript-quality`: success
  - `pterodactyl-runtime`: success
- Pterodactyl release gates run `35557568189`: **success**
  - packaged zero-player NPC smoke: success

The post-change package smoke still reaches SGLuna readiness normally. Its overall packaged-start timing is essentially unchanged because that smoke save already has its startup terrain available and therefore does not reproduce the missing-spawn cold-generation path; the gate is useful here as a no-regression check, not as proof of the client-side latency reduction.

## Next live check

Reinstall/restart the E2E build and pay attention to two separate moments:

1. Factorio's normal mod-loading screen.
2. The first second after the map becomes live / the standalone NPC is bound.

If the hard pause is materially reduced after the second moment, the synchronous chunk-generation path was the dominant problem.

If a hard launch pause remains, capture the corresponding `factorio-current.log` region around:

- `Loading mod autorio 0.1.0 (data.lua)`
- `[AUTORIO] Mod loaded 1`
- `[AUTORIO] Setup complete`
- the first actor/configure lines

The next candidate to quantify would be save-persisted Autorio state (Old Tasks/activity/learned-skill storage), not the data stage: those histories are bounded, but a mature E2E save can still retain materially more script state than a fresh smoke world.
