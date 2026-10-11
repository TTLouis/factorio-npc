import type { ControlledActor } from './actors/types'

export interface FluidSourceRequest {
  fluid_name: string
  search_radius?: number
  limit?: number
}

const MAX_TILE_PROTOTYPES = 2048
const MAX_SOURCE_TILE_NAMES = 128

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= minimum && value <= maximum
}

/** Read-only fluid-bearing terrain samples. No generation, navigation or placement authority. */
export function fluid_source_observation(actor: ControlledActor | undefined, request: FluidSourceRequest) {
  if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
  if (!request || typeof request.fluid_name !== 'string' || !prototypes.fluid[request.fluid_name]) return { ok: false, code: 'unknown_fluid' }
  const radius = request.search_radius ?? 128
  const limit = request.limit ?? 8
  if (!integer(radius, 1, 256) || !integer(limit, 1, 8)) return { ok: false, code: 'invalid_fluid_source_bounds' }
  const position = { x: actor.position.x, y: actor.position.y }
  if (!(math.abs(position.x) <= 10000000 && math.abs(position.y) <= 10000000)) return { ok: false, code: 'invalid_actor_position' }
  const surface = actor.surface
  const names: string[] = []
  let scanned = 0
  for (const [name, tile] of pairs(prototypes.tile)) {
    scanned += 1
    if (scanned > MAX_TILE_PROTOTYPES) return { ok: false, code: 'fluid_tile_catalog_incomplete', scanned_limit: MAX_TILE_PROTOTYPES }
    // Native fluid is exactly what an offshore pump produces on this tile.
    if (tile.fluid?.name === request.fluid_name) {
      if (names.length >= MAX_SOURCE_TILE_NAMES) return { ok: false, code: 'fluid_tile_catalog_incomplete', matching_name_limit: MAX_SOURCE_TILE_NAMES }
      names.push(name)
    }
  }

  // Check the bounded square covering the search circle before querying tiles.
  // Refuse unknown coverage rather than silently generating or reporting absence.
  let checked_chunks = 0
  for (let y = math.floor((position.y - radius) / 32); y <= math.floor((position.y + radius) / 32); y++) {
    for (let x = math.floor((position.x - radius) / 32); x <= math.floor((position.x + radius) / 32); x++) {
      checked_chunks += 1
      if (!surface.is_chunk_generated({ x, y })) return { ok: false, code: 'fluid_source_search_unexplored',
        fluid_name: request.fluid_name, actor_position: position, surface_index: surface.index, search_radius: radius,
        coverage: 'incomplete', checked_chunks, missing_chunk: { x, y } }
    }
  }
  const tiles = names.length > 0 ? surface.find_tiles_filtered({ name: names, position, radius, limit: limit + 1 }) : []
  const samples: Array<{ name: string, fluid_name: string, position: { x: number, y: number }, surface_index: number }> = []
  for (let index = 0; index < math.min(tiles.length, limit); index++) {
    const tile = tiles[index]
    if (tile.prototype.fluid?.name !== request.fluid_name || tile.surface.index !== surface.index) return { ok: false, code: 'fluid_source_result_unreadable' }
    samples.push({ name: tile.name, fluid_name: request.fluid_name, position: { x: tile.position.x, y: tile.position.y }, surface_index: surface.index })
  }
  return { ok: true, fluid_name: request.fluid_name, actor_position: position, surface_index: surface.index,
    observed_tick: game.tick, search_radius: radius, coverage: 'generated_bounding_square', checked_chunks,
    matching_tile_prototypes: names.length, samples, returned_count: samples.length, truncated: tiles.length > limit,
    ordering: 'native_samples_not_nearest' }
}
