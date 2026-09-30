import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { drain_push_queue, KNOWLEDGE_CHUNK_RADIUS, observe_window, pull_engine_chart, queue_full_push } from './map_knowledge'

// How often to look for newly connected players and pull the engine chart.
const SYNC_CHECK_INTERVAL = 60
const PULL_INTERVAL = 3600

interface AwarenessChunkState {
  surface_index: number
  chunk_x: number
  chunk_y: number
}

declare const storage: {
  sgluna_awareness_chunk?: AwarenessChunkState
  // Saves from before the map-knowledge change hold the companion radar.
  sgluna_awareness_radar?: LuaEntity
  sgluna_map_sync_players?: number
  sgluna_map_sync_pulled_tick?: number
}

function chunk_coordinate(value: number) {
  return math.floor(value / 32)
}

function retire_legacy_radar() {
  const radar = storage.sgluna_awareness_radar
  if (radar === undefined) return
  if (radar.valid) radar.destroy()
  storage.sgluna_awareness_radar = undefined
}

// Sync the NPC's map knowledge with the force chart players see. Nothing is
// charted while no player is connected, so both directions wait for one.
function sync_with_players(actor: ControlledActor) {
  if (game.tick % SYNC_CHECK_INTERVAL === 0) {
    const players = actor.force.connected_players.length
    const previous = storage.sgluna_map_sync_players ?? 0
    storage.sgluna_map_sync_players = players
    if (players > 0) {
      if (players > previous) queue_full_push()
      const pulled = storage.sgluna_map_sync_pulled_tick
      if (players > previous || pulled === undefined || game.tick - pulled >= PULL_INTERVAL) {
        pull_engine_chart(actor.force, actor.surface)
        storage.sgluna_map_sync_pulled_tick = game.tick
      }
    }
  }
  drain_push_queue(actor.force)
}

export function new_awareness_controller() {
  function tick(actor: ControlledActor) {
    retire_legacy_radar()
    const identity = actor.status_snapshot()
    if (identity.kind !== 'standalone_character') {
      storage.sgluna_awareness_chunk = undefined
      return false
    }

    sync_with_players(actor)

    const chunk_x = chunk_coordinate(actor.position.x)
    const chunk_y = chunk_coordinate(actor.position.y)
    const previous = storage.sgluna_awareness_chunk
    const changed_chunk = !previous
      || previous.surface_index !== actor.surface.index
      || previous.chunk_x !== chunk_x
      || previous.chunk_y !== chunk_y
    if (!changed_chunk) return false

    // Load the 5x5 window around the NPC the way a player's character does.
    // Queue it and let the engine amortize it: force_generate_chunk_requests()
    // can block a whole simulation frame on chunk-boundary crossings.
    actor.surface.request_to_generate_chunks(actor.position, KNOWLEDGE_CHUNK_RADIUS)
    observe_window(actor.force, actor.surface, chunk_x, chunk_y)

    storage.sgluna_awareness_chunk = {
      surface_index: actor.surface.index,
      chunk_x,
      chunk_y,
    }
    return true
  }

  return { tick }
}
