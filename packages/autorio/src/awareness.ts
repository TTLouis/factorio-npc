import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const RADAR_NAME = 'airi-npc-awareness-radar'
const RADAR_CHUNK_RADIUS = 1

interface AwarenessChunkState {
  surface_index: number
  chunk_x: number
  chunk_y: number
}

declare const storage: {
  airi_awareness_chunk?: AwarenessChunkState
  airi_awareness_radar?: LuaEntity
}

function chunk_coordinate(value: number) {
  return math.floor(value / 32)
}

function destroy_radar() {
  const radar = storage.airi_awareness_radar
  if (radar?.valid) radar.destroy()
  storage.airi_awareness_radar = undefined
}

function create_radar(actor: ControlledActor) {
  const radar = actor.surface.create_entity({
    name: RADAR_NAME,
    position: actor.position,
    force: actor.force,
  })
  if (!radar) return undefined
  radar.destructible = false
  radar.minable_flag = false
  radar.operable = false
  storage.airi_awareness_radar = radar
  return radar
}

export function new_awareness_controller() {
  function tick(actor: ControlledActor) {
    const identity = actor.status_snapshot()
    if (identity.kind !== 'standalone_character') {
      destroy_radar()
      storage.airi_awareness_chunk = undefined
      return false
    }

    const chunk_x = chunk_coordinate(actor.position.x)
    const chunk_y = chunk_coordinate(actor.position.y)
    const previous = storage.airi_awareness_chunk
    const changed_chunk = !previous
      || previous.surface_index !== actor.surface.index
      || previous.chunk_x !== chunk_x
      || previous.chunk_y !== chunk_y

    let radar = storage.airi_awareness_radar
    if (radar?.valid && radar.surface.index !== actor.surface.index) {
      radar.destroy()
      radar = undefined
      storage.airi_awareness_radar = undefined
    }

    if (!radar?.valid) {
      radar = create_radar(actor)
    }
    else if (changed_chunk) {
      // Radar visibility is chunk based. Moving it inside the same 32x32 chunk
      // cannot change the 3x3 nearby-sector footprint, so avoid a LuaEntity
      // teleport every simulation tick. Reposition only when the footprint can
      // actually change.
      radar.teleport(actor.position)
    }

    if (!changed_chunk) return false

    // The hidden RadarPrototype handles the actual continuously refreshed 3x3
    // fog-of-war visibility. Queue the nearby terrain as a bounded safety net,
    // but do NOT synchronously drain the global chunk-generation queue here.
    // force_generate_chunk_requests() can block an entire simulation frame and
    // made cold starts / chunk-boundary crossings look like hard mod freezes.
    // The engine can amortize this queued 3x3 request over subsequent ticks.
    actor.surface.request_to_generate_chunks(actor.position, RADAR_CHUNK_RADIUS)

    storage.airi_awareness_chunk = {
      surface_index: actor.surface.index,
      chunk_x,
      chunk_y,
    }
    return true
  }

  return { tick }
}
