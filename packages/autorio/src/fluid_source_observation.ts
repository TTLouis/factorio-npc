import type { ControlledActor } from './actors/types'

export interface FluidSourceRequest {
  fluid_name: string
  search_radius?: number
  limit?: number
}

const MAX_TILE_PROTOTYPES = 2048
const MAX_SOURCE_TILE_NAMES = 128
// Native tile results examined per read; the nearest `limit` of them are returned.
const MAX_SCANNED_TILES = 256
const MAX_REPORTED_UNGENERATED_CHUNKS = 8
const RECENT_FLUID_TTL_TICKS = 60 * 60
const MAX_RECENT_FLUID_READS = 16
// Where a character could stand near a water sample: asked of the engine for the actor's own character prototype.
const APPROACH_SEARCH_RADIUS = 16
const APPROACH_PRECISION = 0.5
const MAX_LATER_READS = 3

interface FluidSourceSample {
  name: string
  fluid_name: string
  position: { x: number, y: number }
  surface_index: number
  distance: number
  // A position the actor's character can stand on within APPROACH_SEARCH_RADIUS of the tile; absent when the engine found none.
  // The sample itself is a tile of the fluid, so walking onto it is walking into collision.
  approach?: { x: number, y: number }
}

interface CoveredFluidHint extends FluidSourceSample {
  hidden_tile: string
  double_hidden_tile?: string
  removal_layers: number
  cover_minable: true
  requires_terrain_removal: true
  placement_authority: false
}

interface RecentFluidSourceObservation {
  ok: boolean
  fluid_name: string
  actor_position: { x: number, y: number }
  surface_index: number
  observed_tick: number
  search_radius: number
  samples: FluidSourceSample[]
  covered_fluid_hints: CoveredFluidHint[]
  covered_scan_truncated: boolean
  covered_empty_result_is_conclusive: boolean
  coverage_complete: boolean
  empty_result_is_conclusive: boolean
  // Newer reads that did not replace this one (see remember_fluid_read), newest first.
  later_reads?: LaterFluidRead[]
}

interface LaterFluidRead {
  observed_tick: number
  search_radius: number
  actor_position: { x: number, y: number }
  returned_count: number
  coverage_complete: boolean
  empty_result_is_conclusive: boolean
}

interface RecentFluidRead {
  actor_id: number
  force_index: number
  observation: RecentFluidSourceObservation
}

declare const storage: { sgluna_recent_fluid_reads?: RecentFluidRead[] }

/** A recent bounded fact, never placement authority. Re-read after movement/terrain changes. */
export function get_recent_fluid_source_observation(actor: ControlledActor | undefined, fluid_name?: string) {
  if (!actor?.is_valid) return undefined
  const actor_id = actor.status_snapshot().actor_id
  if (actor_id === undefined) return undefined
  for (const read of storage.sgluna_recent_fluid_reads ?? []) {
    const fact = read.observation
    if (read.actor_id === actor_id && read.force_index === actor.force.index && fact.surface_index === actor.surface.index
      && (fluid_name === undefined || fact.fluid_name === fluid_name) && game.tick >= fact.observed_tick && game.tick - fact.observed_tick <= RECENT_FLUID_TTL_TICKS) return fact
  }
  return undefined
}

// True when a read proves the remembered samples are gone: it is an empty answer that is conclusive (every chunk of its square
// generated, nothing left unscanned), at least as wide as the remembered read, and its circle contains every remembered sample.
function read_shows_samples_gone(remembered: RecentFluidSourceObservation, read: RecentFluidSourceObservation) {
  if (read.samples.length > 0 || !read.empty_result_is_conclusive || read.search_radius < remembered.search_radius) return false
  for (const sample of remembered.samples) {
    if (squared_distance(read.actor_position, sample.position) > read.search_radius ** 2) return false
  }
  return true
}

// One remembered read per actor, surface and fluid. A positive read (it has samples) is a fact about terrain, and terrain does
// not move unless something mutates it (which calls invalidate_actor_fluid_source_observations). A newer read is not more
// truthful about tiles it did not see, so an empty or smaller re-read never evicts a positive one (AB-3: a radius-128 empty
// read replaced the radius-256 find, and placement then said no water was exposed). The newer read is recorded beside the
// positive one instead, newest first and bounded, and the positive keeps its own observed_tick so it still expires by TTL.
// A positive is replaced by a newer positive read, or dropped when an empty read proves the samples gone
// (read_shows_samples_gone: conclusive, at least as wide, covering every remembered sample).
function remember_fluid_read(actor: ControlledActor, observation: RecentFluidSourceObservation) {
  const actor_id = actor.status_snapshot().actor_id
  if (actor_id === undefined) return
  const same_scope = (read: RecentFluidRead) => read.actor_id === actor_id && read.force_index === actor.force.index
    && read.observation.surface_index === actor.surface.index && read.observation.fluid_name === observation.fluid_name
  const reads = (storage.sgluna_recent_fluid_reads ?? []).filter(read => !same_scope(read))
  let remembered: RecentFluidSourceObservation | undefined
  for (const read of storage.sgluna_recent_fluid_reads ?? []) {
    if (same_scope(read)) remembered = read.observation
  }
  if (remembered && remembered.samples.length > 0 && observation.samples.length === 0
    && game.tick >= remembered.observed_tick && game.tick - remembered.observed_tick <= RECENT_FLUID_TTL_TICKS
    && !read_shows_samples_gone(remembered, observation)) {
    const later_reads: LaterFluidRead[] = [{ observed_tick: observation.observed_tick, search_radius: observation.search_radius,
      actor_position: observation.actor_position, returned_count: 0, coverage_complete: observation.coverage_complete,
      empty_result_is_conclusive: observation.empty_result_is_conclusive }]
    for (const earlier of remembered.later_reads ?? []) {
      if (later_reads.length < MAX_LATER_READS) later_reads.push(earlier)
    }
    observation = { ...remembered, later_reads }
  }
  reads.unshift({ actor_id, force_index: actor.force.index, observation })
  if (reads.length > MAX_RECENT_FLUID_READS) reads.pop()
  storage.sgluna_recent_fluid_reads = reads
}

/** Terrain mutation invalidates prior water facts for this exact actor scope. */
export function invalidate_actor_fluid_source_observations(actor: ControlledActor) {
  const actor_id = actor.status_snapshot().actor_id
  storage.sgluna_recent_fluid_reads = (storage.sgluna_recent_fluid_reads ?? []).filter(read => read.actor_id !== actor_id
    || read.force_index !== actor.force.index || read.observation.surface_index !== actor.surface.index)
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= minimum && value <= maximum
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
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

  // Walk the bounded square covering the search circle and say which chunks are
  // generated. Ungenerated chunks hold no tiles to sample yet, so they are
  // reported (nearest first, bounded) instead of refusing the read: the samples
  // from generated terrain are still real, and only an empty answer over partial
  // coverage is inconclusive.
  let checked_chunks = 0
  let generated_chunks = 0
  const missing: Array<{ x: number, y: number, distance_squared: number }> = []
  for (let y = math.floor((position.y - radius) / 32); y <= math.floor((position.y + radius) / 32); y++) {
    for (let x = math.floor((position.x - radius) / 32); x <= math.floor((position.x + radius) / 32); x++) {
      checked_chunks += 1
      if (surface.is_chunk_generated({ x, y })) {
        generated_chunks += 1
        continue
      }
      const distance_squared = squared_distance(position, { x: x * 32 + 16, y: y * 32 + 16 })
      if (missing.length < MAX_REPORTED_UNGENERATED_CHUNKS) {
        missing.push({ x, y, distance_squared })
        continue
      }
      let farthest = 0
      for (let index = 1; index < missing.length; index++) {
        if (missing[index].distance_squared > missing[farthest].distance_squared) farthest = index
      }
      if (distance_squared < missing[farthest].distance_squared) missing[farthest] = { x, y, distance_squared }
    }
  }
  missing.sort((left, right) => left.distance_squared < right.distance_squared ? -1 : left.distance_squared > right.distance_squared ? 1 : 0)
  const ungenerated_chunks = missing.map(chunk => ({ x: chunk.x, y: chunk.y, center: { x: chunk.x * 32 + 16, y: chunk.y * 32 + 16 } }))
  const ungenerated_count = checked_chunks - generated_chunks
  const coverage_complete = ungenerated_count === 0
  const chunk_report = {
    checked_chunks,
    generated_chunk_count: generated_chunks,
    ungenerated_chunk_count: ungenerated_count,
    ungenerated_chunks,
    ungenerated_chunks_truncated: ungenerated_count > ungenerated_chunks.length,
  }
  if (generated_chunks === 0) {
    return { ok: false, code: 'fluid_source_search_unexplored', fluid_name: request.fluid_name, actor_position: position,
      surface_index: surface.index, search_radius: radius, coverage: 'none', coverage_complete: false, ...chunk_report }
  }

  const tiles = names.length > 0 ? surface.find_tiles_filtered({ name: names, position, radius, limit: MAX_SCANNED_TILES + 1 }) : []
  const scan_truncated = tiles.length > MAX_SCANNED_TILES
  const found: Array<{ name: string, position: { x: number, y: number }, distance_squared: number }> = []
  for (let index = 0; index < math.min(tiles.length, MAX_SCANNED_TILES); index++) {
    const tile = tiles[index]
    if (tile.prototype.fluid?.name !== request.fluid_name || tile.surface.index !== surface.index) return { ok: false, code: 'fluid_source_result_unreadable' }
    // A tile in a chunk that is not generated yet is not terrain the engine has settled.
    if (!surface.is_chunk_generated({ x: math.floor(tile.position.x / 32), y: math.floor(tile.position.y / 32) })) continue
    const tile_position = { x: tile.position.x, y: tile.position.y }
    found.push({ name: tile.name, position: tile_position, distance_squared: squared_distance(position, tile_position) })
  }
  found.sort((left, right) => left.distance_squared < right.distance_squared ? -1 : left.distance_squared > right.distance_squared ? 1 : 0)
  const samples: FluidSourceSample[] = []
  for (let index = 0; index < math.min(found.length, limit); index++) {
    const tile = found[index]
    // Ask the engine where this actor's own character fits near the tile centre (its collision mask decides, not a tile list).
    const character = actor.character
    const standing = character?.valid
      ? surface.find_non_colliding_position(character.name, { x: tile.position.x + 0.5, y: tile.position.y + 0.5 }, APPROACH_SEARCH_RADIUS, APPROACH_PRECISION)
      : undefined
    samples.push({ name: tile.name, fluid_name: request.fluid_name, position: tile.position, surface_index: surface.index,
      distance: math.floor(math.sqrt(tile.distance_squared) * 10 + 0.5) / 10,
      ...(standing ? { approach: { x: standing.x, y: standing.y } } : {}) })
  }
  // Factorio preserves water beneath removable landfill/foundation in native
  // hidden tile layers. These are recovery hints, not present fluid sources or
  // permission to mine terrain (which can expose water under built entities).
  const covered = surface.find_tiles_filtered({ position, radius, has_hidden_tile: true, limit: MAX_SCANNED_TILES + 1 })
  const covered_scan_truncated = covered.length > MAX_SCANNED_TILES
  const covered_found: Array<CoveredFluidHint & { distance_squared: number }> = []
  for (let index = 0; index < math.min(covered.length, MAX_SCANNED_TILES); index++) {
    const tile = covered[index]
    if (tile.surface.index !== surface.index) return { ok: false, code: 'fluid_source_result_unreadable' }
    if (!surface.is_chunk_generated({ x: math.floor(tile.position.x / 32), y: math.floor(tile.position.y / 32) })) continue
    if (!tile.prototype.mineable_properties?.minable || !tile.hidden_tile || tile.prototype.fluid) continue
    const hidden = prototypes.tile[tile.hidden_tile]
    const double_hidden = tile.double_hidden_tile ? prototypes.tile[tile.double_hidden_tile] : undefined
    const direct = hidden?.fluid?.name === request.fluid_name
    const layered = hidden?.mineable_properties?.minable && double_hidden?.fluid?.name === request.fluid_name
    if (!direct && !layered) continue
    const tile_position = { x: tile.position.x, y: tile.position.y }
    const distance_squared = squared_distance(position, tile_position)
    covered_found.push({ name: tile.name, fluid_name: request.fluid_name, position: tile_position, surface_index: surface.index,
      distance: math.floor(math.sqrt(distance_squared) * 10 + 0.5) / 10, distance_squared,
      hidden_tile: tile.hidden_tile, ...(tile.double_hidden_tile ? { double_hidden_tile: tile.double_hidden_tile } : {}),
      removal_layers: direct ? 1 : 2, cover_minable: true, requires_terrain_removal: true, placement_authority: false })
  }
  covered_found.sort((left, right) => left.distance_squared < right.distance_squared ? -1 : left.distance_squared > right.distance_squared ? 1 : 0)
  const covered_fluid_hints: CoveredFluidHint[] = covered_found.slice(0, limit).map(({ distance_squared: _distance, ...hint }) => hint)
  const result = { ok: true, fluid_name: request.fluid_name, actor_position: position, surface_index: surface.index,
    observed_tick: game.tick, search_radius: radius,
    // Samples come from generated terrain in the bounding square; coverage_complete says whether every chunk of it was.
    coverage: 'generated_bounding_square', coverage_complete, ...chunk_report,
    // An empty answer proves there is no such fluid in the square only when coverage is complete and nothing was left unscanned.
    empty_result_is_conclusive: coverage_complete && !scan_truncated,
    matching_tile_prototypes: names.length, samples, returned_count: samples.length, truncated: found.length > samples.length || scan_truncated,
    // Present when the samples could be given an approach: how far from each tile the engine was asked to look for standing room.
    ...(actor.character?.valid ? { approach_search_radius: APPROACH_SEARCH_RADIUS } : {}),
    scanned_tile_limit: MAX_SCANNED_TILES, scan_truncated,
    ordering: scan_truncated ? 'nearest_first_among_scanned_tiles' : 'nearest_first',
    covered_fluid_hints, covered_returned_count: covered_fluid_hints.length,
    covered_scan_truncated, covered_scanned_tile_limit: MAX_SCANNED_TILES,
    covered_truncated: covered_found.length > covered_fluid_hints.length || covered_scan_truncated,
    covered_empty_result_is_conclusive: coverage_complete && !covered_scan_truncated,
    covered_ordering: covered_scan_truncated ? 'nearest_first_among_scanned_tiles' : 'nearest_first',
    covered_hint_requires_native_mining_validation: true }
  remember_fluid_read(actor, result)
  return result
}
