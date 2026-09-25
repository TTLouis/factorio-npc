import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { resolve_entity_reference } from './entity_reference'

const DEFAULT_HALF_SIZE = 12
const MIN_HALF_SIZE = 4
const MAX_HALF_SIZE = 16
const DEFAULT_SEARCH_RADIUS = 8
const MAX_SEARCH_RADIUS = 12
const DEFAULT_MAX_CANDIDATES = 4
const MAX_CANDIDATES = 8
const MAX_REJECTIONS = 32
const MAX_ENTITIES = 160
const MAX_BLOCKING_TILES = 192
const MAX_TERRAIN_TYPES = 32
const MAX_TERRAIN_RUNS = 256
const MAX_PLACEMENT_DISTANCE = 10
const MAX_CANDIDATE_EVALUATIONS = 384

export type PlacementSide = 'north' | 'south' | 'east' | 'west' | 'any'

type Position = { x: number, y: number }

type AnchorResult = {
  position: Position
  entity?: LuaEntity
}

export interface ConstructionObservationRequest {
  anchor_unit_number?: number
  position?: Position
  half_size?: number
  requested_entity_name?: string
}

export interface PlacementPlanRequest extends ConstructionObservationRequest {
  entity_name: string
  side?: PlacementSide
  direction?: number
  search_radius?: number
  max_candidates?: number
  reserve_input?: boolean
  reserve_output?: boolean
  reserve_power?: boolean
  extension_direction?: PlacementSide
}

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function snap_center(value: number) {
  return math.floor(value) + 0.5
}

function bounded_integer(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || math.floor(value) !== value) return fallback
  return math.max(min, math.min(max, value))
}

function valid_position(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const position = value as Position
  return typeof position.x === 'number' && typeof position.y === 'number'
}

function resolve_anchor(actor: ControlledActor, request: ConstructionObservationRequest): AnchorResult | { error: string } {
  if (request.anchor_unit_number !== undefined) {
    if (request.anchor_unit_number < 1 || math.floor(request.anchor_unit_number) !== request.anchor_unit_number) {
      return { error: 'invalid anchor_unit_number' }
    }
    const entity = resolve_entity_reference(actor, request.anchor_unit_number, 'map_visible')
    if (!entity || !entity.valid) return { error: 'anchor entity not found' }
    if (entity.surface.index !== actor.surface.index) return { error: 'anchor entity is on another surface' }
    return { position: entity.position, entity }
  }
  if (request.position !== undefined) {
    if (!valid_position(request.position)) return { error: 'invalid anchor position' }
    return { position: request.position }
  }
  return { position: actor.position }
}

function entity_category(entity: LuaEntity) {
  if (entity.type === 'transport-belt' || entity.type === 'underground-belt' || entity.type === 'splitter' || entity.type === 'linked-belt') return 'belt'
  if (entity.type === 'loader' || entity.type === 'loader-1x1') return 'loader'
  if (entity.type === 'container' || entity.type === 'logistic-container' || entity.type === 'infinity-container') return 'storage'
  if (entity.type === 'assembling-machine' || entity.type === 'furnace' || entity.type === 'mining-drill' || entity.type === 'rocket-silo') return 'machine'
  if (entity.type === 'inserter') return 'inserter'
  if (entity.type === 'electric-pole') return 'electric-pole'
  if (entity.type === 'cliff') return 'cliff'
  if (entity.type === 'character') return 'character'
  return 'other'
}

function entity_summary(entity: LuaEntity, actor: ControlledActor) {
  return {
    name: entity.name,
    type: entity.type,
    category: entity_category(entity),
    unit_number: entity.unit_number,
    position: entity.position,
    direction: entity.direction,
    force: entity.force?.name,
    footprint: entity.bounding_box,
    is_npc: actor.character === entity,
  }
}

function sort_entities(entities: LuaEntity[]) {
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = `${entities[i].name}:${entities[i].unit_number ?? 0}:${entities[i].position.x}:${entities[i].position.y}`
      const b = `${entities[j].name}:${entities[j].unit_number ?? 0}:${entities[j].position.x}:${entities[j].position.y}`
      if (b < a) {
        const temp = entities[i]
        entities[i] = entities[j]
        entities[j] = temp
      }
    }
  }
}

function blocking_tile_kind(name: string) {
  if (name.indexOf('water') >= 0) return 'water'
  if (name === 'out-of-map') return 'out-of-map'
  return undefined
}

function sort_tile_types(values: Array<{ name: string, count: number, kind?: string }>) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i]
      const b = values[j]
      if (b.count > a.count || (b.count === a.count && b.name < a.name)) {
        const temp = values[i]
        values[i] = values[j]
        values[j] = temp
      }
    }
  }
}

function terrain_snapshot(actor: ControlledActor, center: Position, half_size: number) {
  const blocking: Array<Record<string, unknown>> = []
  const counts: Record<string, number> = {}
  const names: string[] = []
  const runs: Array<Record<string, unknown>> = []
  let blocking_count = 0
  let run_count = 0
  const center_x = math.floor(center.x)
  const center_y = math.floor(center.y)
  const min_x = center_x - half_size
  const max_x = center_x + half_size - 1
  const min_y = center_y - half_size
  const max_y = center_y + half_size - 1

  for (let y = min_y; y <= max_y; y++) {
    let run_name: string | undefined
    let run_start = min_x
    for (let x = min_x; x <= max_x; x++) {
      const tile = actor.surface.get_tile(x, y)
      const name = tile.name
      if (counts[name] === undefined) {
        counts[name] = 0
        names.push(name)
      }
      counts[name]++

      const kind = blocking_tile_kind(name)
      if (kind) {
        blocking_count++
        if (blocking.length < MAX_BLOCKING_TILES) blocking.push({ name, kind, position: { x, y } })
      }

      if (run_name === undefined) {
        run_name = name
        run_start = x
      }
      else if (name !== run_name) {
        run_count++
        if (runs.length < MAX_TERRAIN_RUNS) {
          runs.push({ y, x_start: run_start, x_end: x - 1, name: run_name, kind: blocking_tile_kind(run_name) })
        }
        run_name = name
        run_start = x
      }
    }
    if (run_name !== undefined) {
      run_count++
      if (runs.length < MAX_TERRAIN_RUNS) {
        runs.push({ y, x_start: run_start, x_end: max_x, name: run_name, kind: blocking_tile_kind(run_name) })
      }
    }
  }

  const types = names.map(name => ({ name, count: counts[name], kind: blocking_tile_kind(name) }))
  sort_tile_types(types)
  return {
    blocking: {
      matched_count: blocking_count,
      truncated: blocking_count > blocking.length,
      tiles: blocking,
    },
    tiles: {
      tile_count: (max_x - min_x + 1) * (max_y - min_y + 1),
      type_count: types.length,
      types: types.slice(0, MAX_TERRAIN_TYPES),
      types_truncated: types.length > MAX_TERRAIN_TYPES,
      run_count,
      runs,
      runs_truncated: run_count > runs.length,
      encoding: 'row_runs_inclusive',
    },
  }
}

export function prototype_spatial_geometry(name: string) {
  const prototype = prototypes.entity[name]
  if (!prototype) return { name, exists: false }
  return {
    name,
    exists: true,
    type: prototype.type,
    physical_footprint: {
      tile_width: prototype.tile_width,
      tile_height: prototype.tile_height,
      collision_box: prototype.collision_box,
      selection_box: prototype.selection_box,
    },
    working_area: prototype.type === 'mining-drill'
      ? { kind: 'mining', radius: prototype.mining_drill_radius }
      : undefined,
  }
}

function corridor_descriptors(anchor: Position, request: PlacementPlanRequest) {
  const side = request.side ?? 'any'
  const extension = request.extension_direction ?? side
  return {
    input: request.reserve_input === true ? { reserved: true, side } : { reserved: false },
    output: request.reserve_output === true ? { reserved: true, side: extension } : { reserved: false },
    power: request.reserve_power === true ? { reserved: true, around_anchor: anchor, clearance: 1 } : { reserved: false },
    future_extension: extension === 'any' ? { reserved: false } : { reserved: true, direction: extension, minimum_clear_tiles: 2 },
  }
}

export function local_spatial_observation(actor: ControlledActor, request: ConstructionObservationRequest = {}) {
  const anchor = resolve_anchor(actor, request)
  if ('error' in anchor) return { ok: false, error: anchor.error }
  const half_size = bounded_integer(request.half_size, DEFAULT_HALF_SIZE, MIN_HALF_SIZE, MAX_HALF_SIZE)
  const area = {
    left_top: { x: anchor.position.x - half_size, y: anchor.position.y - half_size },
    right_bottom: { x: anchor.position.x + half_size, y: anchor.position.y + half_size },
  }
  const matches = actor.surface.find_entities_filtered({ area })
  sort_entities(matches)
  const entities = matches.slice(0, MAX_ENTITIES).map(entity => entity_summary(entity, actor))
  const terrain = terrain_snapshot(actor, anchor.position, half_size)
  return {
    ok: true,
    tick: game.tick,
    surface: actor.surface.name,
    center: anchor.position,
    anchor: anchor.entity ? entity_summary(anchor.entity, actor) : undefined,
    bounds: area,
    size: { width: half_size * 2, height: half_size * 2 },
    actor: {
      position: actor.position,
      footprint: actor.character?.bounding_box,
    },
    requested_entity: request.requested_entity_name
      ? prototype_spatial_geometry(request.requested_entity_name)
      : undefined,
    entities,
    entity_count: matches.length,
    entities_truncated: matches.length > entities.length,
    blocking_terrain: terrain.blocking,
    terrain_tiles: terrain.tiles,
  }
}

function preferred_side_penalty(anchor: Position, candidate: Position, side: PlacementSide) {
  if (side === 'any') return 0
  if (side === 'north') return candidate.y <= anchor.y ? 0 : 100
  if (side === 'south') return candidate.y >= anchor.y ? 0 : 100
  if (side === 'west') return candidate.x <= anchor.x ? 0 : 100
  return candidate.x >= anchor.x ? 0 : 100
}

function direction_vector(side: PlacementSide): Position | undefined {
  if (side === 'north') return { x: 0, y: -1 }
  if (side === 'south') return { x: 0, y: 1 }
  if (side === 'west') return { x: -1, y: 0 }
  if (side === 'east') return { x: 1, y: 0 }
  return undefined
}

function nearby_blockers(actor: ControlledActor, position: Position) {
  const matches = actor.surface.find_entities_filtered({ position, radius: 1.5 })
  const blockers: Array<Record<string, unknown>> = []
  for (const entity of matches) {
    if (blockers.length >= 8) break
    blockers.push(entity_summary(entity, actor))
  }
  const tile = actor.surface.get_tile(math.floor(position.x), math.floor(position.y))
  const terrain = blocking_tile_kind(tile.name)
  return { entities: blockers, terrain: terrain ? { name: tile.name, kind: terrain } : undefined }
}

function extension_penalty(actor: ControlledActor, entity_name: string, position: Position, direction: number | undefined, extension: PlacementSide) {
  const vector = direction_vector(extension)
  if (!vector) return 0
  const future = { x: position.x + vector.x * 2, y: position.y + vector.y * 2 }
  return actor.surface.can_place_entity({ name: entity_name, position: future, direction, force: actor.force }) ? 0 : 25
}

function candidate_positions(anchor: Position, radius: number) {
  const result: Position[] = []
  let evaluations = 0
  for (let ring = 1; ring <= radius && evaluations < MAX_CANDIDATE_EVALUATIONS; ring++) {
    for (let dx = -ring; dx <= ring && evaluations < MAX_CANDIDATE_EVALUATIONS; dx++) {
      for (let dy = -ring; dy <= ring && evaluations < MAX_CANDIDATE_EVALUATIONS; dy++) {
        if (math.max(math.abs(dx), math.abs(dy)) !== ring) continue
        result.push({ x: snap_center(anchor.x + dx), y: snap_center(anchor.y + dy) })
        evaluations++
      }
    }
  }
  return result
}

function sort_candidates(values: Array<Record<string, any>>) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = values[i]
      const b = values[j]
      if (b.score < a.score || (b.score === a.score && (b.position.x < a.position.x || (b.position.x === a.position.x && b.position.y < a.position.y)))) {
        const temp = values[i]
        values[i] = values[j]
        values[j] = temp
      }
    }
  }
}

export function plan_placement(actor: ControlledActor, request: PlacementPlanRequest) {
  if (!request || typeof request.entity_name !== 'string' || request.entity_name.length === 0) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'entity_name is required' } }
  }
  const prototype = prototypes.entity[request.entity_name]
  if (!prototype) return { ok: false, error: { code: 'UNKNOWN_ENTITY', message: `unknown entity ${request.entity_name}` } }
  const anchor = resolve_anchor(actor, request)
  if ('error' in anchor) return { ok: false, error: { code: 'INVALID_ANCHOR', message: anchor.error } }

  const side = request.side ?? 'any'
  const extension = request.extension_direction ?? side
  const radius = bounded_integer(request.search_radius, DEFAULT_SEARCH_RADIUS, 1, MAX_SEARCH_RADIUS)
  const max_candidates = bounded_integer(request.max_candidates, DEFAULT_MAX_CANDIDATES, 1, MAX_CANDIDATES)
  const direction = request.direction
  const candidates: Array<Record<string, any>> = []
  const rejected: Array<Record<string, unknown>> = []

  for (const position of candidate_positions(anchor.position, radius)) {
    if (squared_distance(actor.position, position) > MAX_PLACEMENT_DISTANCE ** 2) {
      if (rejected.length < MAX_REJECTIONS) rejected.push({ position, reason: 'outside_local_build_reach' })
      continue
    }
    const placeable = actor.surface.can_place_entity({ name: request.entity_name, position, direction, force: actor.force })
    if (!placeable) {
      if (rejected.length < MAX_REJECTIONS) rejected.push({ position, reason: 'collision', blockers: nearby_blockers(actor, position) })
      continue
    }
    const score = preferred_side_penalty(anchor.position, position, side)
      + math.sqrt(squared_distance(anchor.position, position))
      + math.sqrt(squared_distance(actor.position, position)) * 0.1
      + extension_penalty(actor, request.entity_name, position, direction, extension)
    candidates.push({ position, direction, score })
  }

  sort_candidates(candidates)
  const selected = candidates.slice(0, max_candidates)
  return {
    ok: selected.length > 0,
    entity_name: request.entity_name,
    direction,
    anchor: anchor.entity ? entity_summary(anchor.entity, actor) : { position: anchor.position },
    side,
    search_radius: radius,
    max_candidates,
    prototype: prototype_spatial_geometry(request.entity_name),
    corridors: corridor_descriptors(anchor.position, request),
    best: selected[0],
    candidates: selected,
    rejected,
    rejected_truncated: rejected.length >= MAX_REJECTIONS,
    error: selected.length === 0 ? { code: 'NO_VALID_PLACEMENT', message: 'no locally reachable collision-free candidate' } : undefined,
  }
}

export function select_navigation_escape_point(actor: ControlledActor, target_position: Position, radius: number = 6) {
  const bounded_radius = math.max(2, math.min(10, math.floor(radius)))
  const candidates: Array<Record<string, any>> = []
  const seen: Record<string, boolean> = {}
  const character_name = actor.character?.name ?? 'character'
  const offsets = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
  ]
  for (let ring = 2; ring <= bounded_radius; ring += 2) {
    for (const offset of offsets) {
      const desired = { x: actor.position.x + offset.x * ring, y: actor.position.y + offset.y * ring }
      const safe = actor.surface.find_non_colliding_position(character_name, desired, 1.5, 0.5, true)
      if (!safe) continue
      const key = `${safe.x},${safe.y}`
      if (seen[key]) continue
      seen[key] = true
      if (squared_distance(actor.position, safe) < 1) continue
      const blockers = nearby_blockers(actor, safe)
      const terrain_penalty = blockers.terrain ? 1000 : 0
      candidates.push({
        position: safe,
        score: math.sqrt(squared_distance(safe, target_position)) + math.sqrt(squared_distance(actor.position, safe)) * 0.25 + terrain_penalty,
      })
    }
  }
  sort_candidates(candidates)
  return {
    ok: candidates.length > 0,
    actor_position: actor.position,
    target_position,
    radius: bounded_radius,
    best: candidates[0],
    candidates: candidates.slice(0, 8),
    spatial_observation: local_spatial_observation(actor, { position: actor.position, half_size: math.min(MAX_HALF_SIZE, bounded_radius) }),
  }
}
