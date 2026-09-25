import type { ControlledActor } from './actors/types'
import { resolve_entity_reference } from './entity_reference'

type Position = { x: number, y: number }
type Area = { left_top: Position, right_bottom: Position }

export interface ConstructionSiteRequest {
  width: number
  height: number
  anchor_unit_number?: number
  position?: Position
  search_radius?: number
  max_candidates?: number
}

const MIN_SIZE = 2
const MAX_SIZE = 32
const DEFAULT_SEARCH_RADIUS = 24
const MAX_SEARCH_RADIUS = 64
const DEFAULT_MAX_CANDIDATES = 4
const MAX_CANDIDATES = 8
const MAX_EVALUATIONS = 512

function valid_integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_position(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const position = value as Position
  return typeof position.x === 'number' && position.x === position.x && math.abs(position.x) <= 1000000
    && typeof position.y === 'number' && position.y === position.y && math.abs(position.y) <= 1000000
}

function resolve_anchor(actor: ControlledActor, request: ConstructionSiteRequest) {
  if (request.anchor_unit_number !== undefined) {
    if (!valid_integer(request.anchor_unit_number, 1, 9007199254740991)) return { error: 'invalid anchor_unit_number' }
    const entity = resolve_entity_reference(actor, request.anchor_unit_number, 'map_visible')
    if (!entity || !entity.valid) return { error: 'anchor entity not found' }
    if (entity.surface.index !== actor.surface.index) return { error: 'anchor entity is on another surface' }
    return { position: entity.position, unit_number: entity.unit_number, entity_name: entity.name }
  }
  if (request.position !== undefined) {
    if (!valid_position(request.position)) return { error: 'invalid anchor position' }
    return { position: request.position }
  }
  return { position: actor.position }
}

function blocking_tile_kind(name: string) {
  if (name.indexOf('water') >= 0) return 'water'
  if (name === 'out-of-map') return 'out-of-map'
  return undefined
}

function bounds_for(center: Position, width: number, height: number): Area {
  const left = math.floor(center.x - width / 2)
  const top = math.floor(center.y - height / 2)
  return {
    left_top: { x: left, y: top },
    right_bottom: { x: left + width, y: top + height },
  }
}

function center_of(bounds: Area) {
  return {
    x: (bounds.left_top.x + bounds.right_bottom.x) / 2,
    y: (bounds.left_top.y + bounds.right_bottom.y) / 2,
  }
}

function area_key(bounds: Area) {
  return `${bounds.left_top.x}:${bounds.left_top.y}:${bounds.right_bottom.x}:${bounds.right_bottom.y}`
}

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function inspect_area(actor: ControlledActor, bounds: Area) {
  const entities = actor.surface.find_entities_filtered({ area: bounds })
  let hard_entity_count = 0
  let transient_character_count = 0
  for (const entity of entities) {
    if (!entity || !entity.valid) continue
    if (entity.type === 'character') transient_character_count++
    else hard_entity_count++
  }
  if (hard_entity_count > 0) return { ok: false, reason: 'occupied_entity' as const, transient_character_count }

  for (let y = bounds.left_top.y; y < bounds.right_bottom.y; y++) {
    for (let x = bounds.left_top.x; x < bounds.right_bottom.x; x++) {
      const tile = actor.surface.get_tile(x, y)
      const kind = blocking_tile_kind(tile.name)
      if (kind) return { ok: false, reason: 'blocking_terrain' as const, transient_character_count, terrain_kind: kind }
    }
  }
  return { ok: true, transient_character_count }
}

function sort_candidates(values: Array<Record<string, any>>) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const left = values[i]
      const right = values[j]
      if (right.distance_from_anchor < left.distance_from_anchor
        || (right.distance_from_anchor === left.distance_from_anchor
          && (right.bounds.left_top.x < left.bounds.left_top.x
            || (right.bounds.left_top.x === left.bounds.left_top.x && right.bounds.left_top.y < left.bounds.left_top.y)))) {
        const previous = values[i]
        values[i] = values[j]
        values[j] = previous
      }
    }
  }
}

export function find_construction_sites(actor: ControlledActor, request: ConstructionSiteRequest) {
  if (!actor || !actor.is_valid) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
  if (!request || !valid_integer(request.width, MIN_SIZE, MAX_SIZE) || !valid_integer(request.height, MIN_SIZE, MAX_SIZE)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: `width and height must be integers from ${MIN_SIZE} to ${MAX_SIZE}` } }
  }
  if (request.anchor_unit_number !== undefined && request.position !== undefined) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'provide anchor_unit_number or position, not both' } }
  }
  const search_radius = request.search_radius ?? DEFAULT_SEARCH_RADIUS
  const max_candidates = request.max_candidates ?? DEFAULT_MAX_CANDIDATES
  if (!valid_integer(search_radius, 2, MAX_SEARCH_RADIUS)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: `search_radius must be an integer from 2 to ${MAX_SEARCH_RADIUS}` } }
  }
  if (!valid_integer(max_candidates, 1, MAX_CANDIDATES)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: `max_candidates must be an integer from 1 to ${MAX_CANDIDATES}` } }
  }

  const anchor = resolve_anchor(actor, request)
  if ('error' in anchor) return { ok: false, error: { code: 'INVALID_ANCHOR', message: anchor.error } }

  const base_center = { x: math.floor(anchor.position.x) + 0.5, y: math.floor(anchor.position.y) + 0.5 }
  const step = math.max(1, math.floor(math.min(request.width, request.height) / 2))
  const ring_limit = math.max(1, math.ceil(search_radius / step))
  const seen: Record<string, boolean> = {}
  const candidates: Array<Record<string, any>> = []
  const rejection_summary = { occupied_entity: 0, blocking_terrain: 0 }
  let evaluated_count = 0
  let evaluation_limit_reached = false

  for (let ring = 0; ring <= ring_limit; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && math.max(math.abs(dx), math.abs(dy)) !== ring) continue
        if (evaluated_count >= MAX_EVALUATIONS) {
          evaluation_limit_reached = true
          break
        }
        const desired = { x: base_center.x + dx * step, y: base_center.y + dy * step }
        if (math.sqrt(squared_distance(base_center, desired)) > search_radius + step) continue
        const bounds = bounds_for(desired, request.width, request.height)
        const key = area_key(bounds)
        if (seen[key]) continue
        seen[key] = true
        evaluated_count++
        const inspection = inspect_area(actor, bounds)
        if (!inspection.ok) {
          if (inspection.reason === 'occupied_entity') rejection_summary.occupied_entity++
          else rejection_summary.blocking_terrain++
          continue
        }
        const center = center_of(bounds)
        candidates.push({
          bounds,
          center,
          distance_from_anchor: math.sqrt(squared_distance(anchor.position, center)),
          transient_character_count: inspection.transient_character_count,
        })
      }
      if (evaluation_limit_reached) break
    }
    if (evaluation_limit_reached) break
  }

  sort_candidates(candidates)
  const selected = candidates.slice(0, max_candidates)
  for (let index = 0; index < selected.length; index++) selected[index].candidate_id = `site-${index + 1}`
  return {
    ok: selected.length > 0,
    surface: { index: actor.surface.index, name: actor.surface.name },
    anchor,
    requested_size: { width: request.width, height: request.height },
    search_radius,
    max_candidates,
    evaluated_count,
    evaluation_limit_reached,
    rejection_summary,
    candidates: selected,
    semantics: {
      occupancy: 'strict empty-envelope search: non-character entities and blocking water/out-of-map terrain reject a site; characters are transient and reported but do not reject the long-term site',
      validation: 'a site candidate is only a free rectangular envelope, not a machine layout or construction validation; choose exact placements and pass them to validateConstructionPlan before execution',
    },
    error: selected.length === 0 ? { code: 'NO_CLEAR_SITE', message: 'no clear construction site found within the bounded search' } : undefined,
  }
}
