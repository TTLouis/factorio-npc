import type { ControlledActor } from './actors/types'
import type { CandidateFluidPort } from './placement_spatial_features'
import { candidate_fluid_ports } from './placement_spatial_features'
import { placement_footprint, placement_footprint_covers_point, placement_grid_rule, snap_placement_center, type PlacementFootprint } from './placement_geometry'

const MAX_RADIUS = 24
const MAX_LIMIT = 8
const MAX_SCANNED_POSITIONS = 10000
const MAX_CANDIDATE_SETS = 16
const CANDIDATE_TTL_TICKS = 60 * 60
const CARDINAL_DIRECTIONS = [0, 4, 8, 12]

export interface PlacementCandidateRequest {
  entity_name: string
  center?: { x: number, y: number }
  radius?: number
  target_resource?: string
  // Only placements whose footprint covers this point, for example a drill's
  // item_output_position when the new entity must receive its output.
  covers_position?: { x: number, y: number }
  limit?: number
}

interface ResourceCoverage {
  name: string
  entities: number
  amount: number
}

export interface PlacementCandidate {
  id: string
  position: { x: number, y: number }
  direction: number
  distance_from_center: number
  item_output_position?: { x: number, y: number }
  fluid_ports?: CandidateFluidPort[]
  resource_coverage?: ResourceCoverage[]
  footprint: PlacementFootprint
}

interface PlacementCandidateSet {
  id: string
  generated_tick: number
  entity_name: string
  surface_index: number
  force_index: number
  target_resource?: string
  candidates: PlacementCandidate[]
}

declare const storage: {
  airi_placement_candidate_sets?: Record<string, PlacementCandidateSet>
  airi_placement_candidate_set_order?: string[]
  airi_placement_candidate_next_id?: number
}

function candidate_sets() {
  storage.airi_placement_candidate_sets ??= {}
  storage.airi_placement_candidate_set_order ??= []
  return storage.airi_placement_candidate_sets
}

function next_candidate_set_id() {
  const next = storage.airi_placement_candidate_next_id ?? 1
  storage.airi_placement_candidate_next_id = next + 1
  return `placement-${next}`
}

function store_candidate_set(value: PlacementCandidateSet) {
  const sets = candidate_sets()
  const order = storage.airi_placement_candidate_set_order as string[]
  sets[value.id] = value
  order.push(value.id)
  while (order.length > MAX_CANDIDATE_SETS) {
    const removed = order.shift()
    if (removed !== undefined) delete sets[removed]
  }
}

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

const COVERS_POSITION_DEFAULT_RADIUS = 3

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function rotate_cardinal(vector: { x: number, y: number }, direction: number) {
  if (direction === 4) return { x: -vector.y, y: vector.x }
  if (direction === 8) return { x: -vector.x, y: -vector.y }
  if (direction === 12) return { x: vector.y, y: -vector.x }
  return { x: vector.x, y: vector.y }
}

function sorted_resource_coverages(values: Record<string, ResourceCoverage>) {
  const result: ResourceCoverage[] = []
  for (const name in values) result.push(values[name])
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      if (result[j].name < result[i].name) {
        const tmp = result[i]
        result[i] = result[j]
        result[j] = tmp
      }
    }
  }
  return result
}

function resource_categories(prototype: any) {
  const result: Record<string, boolean> = {}
  const categories: Record<string, boolean> = prototype?.resource_categories ?? {}
  for (const name in categories) {
    if (categories[name] === true) result[name] = true
  }
  return result
}

function mining_radius(prototype: any) {
  // Read the field, not get_mining_drill_radius(): on an untyped object the
  // call compiles to a Lua method call that passes the prototype as the
  // quality argument ("Invalid QualityID" on 2.0.77).
  const radius = prototype?.mining_drill_radius
  return typeof radius === 'number' && radius > 0 && finite(radius) ? radius : undefined
}

// Factorio 2.0 returns prototype vectors in array form ({-0.5, -1.3}); older
// data and tests use {x, y}. Accept both.
function vector_xy(raw: any): { x: number, y: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const values = raw as number[]
  const x = typeof raw.x === 'number' ? raw.x : values[0]
  const y = typeof raw.y === 'number' ? raw.y : values[1]
  if (typeof x !== 'number' || typeof y !== 'number' || !finite(x) || !finite(y)) return undefined
  return { x, y }
}

function mining_offset(prototype: any, direction: number) {
  const offset = vector_xy(prototype?.radius_visualisation_specification?.offset)
  if (!offset) return { x: 0, y: 0 }
  return rotate_cardinal(offset, direction)
}

function resource_coverage(
  actor: ControlledActor,
  prototype: any,
  position: { x: number, y: number },
  direction: number,
  target_resource?: string,
) {
  const radius = mining_radius(prototype)
  if (radius === undefined) return undefined
  const offset = mining_offset(prototype, direction)
  const search_center = { x: position.x + offset.x, y: position.y + offset.y }

  const allowed_categories = resource_categories(prototype)
  const resources = actor.surface.find_entities_filtered({
    area: [
      { x: search_center.x - radius, y: search_center.y - radius },
      { x: search_center.x + radius, y: search_center.y + radius },
    ],
    type: 'resource',
  })

  const coverage_by_name: Record<string, ResourceCoverage> = {}
  for (const resource of resources) {
    if (!resource.valid || resource.type !== 'resource') continue
    if (target_resource !== undefined && resource.name !== target_resource) continue
    const category = (resource.prototype as any).resource_category
    if (category !== undefined && allowed_categories[category] !== true) continue
    const existing = coverage_by_name[resource.name]
    const amount = typeof resource.amount === 'number' ? resource.amount : 0
    if (existing !== undefined) {
      existing.entities += 1
      existing.amount += amount
    }
    else {
      coverage_by_name[resource.name] = { name: resource.name, entities: 1, amount }
    }
  }
  return sorted_resource_coverages(coverage_by_name)
}

function coverage_score(candidate: PlacementCandidate, target_resource?: string) {
  let entities = 0
  let amount = 0
  for (const coverage of candidate.resource_coverage ?? []) {
    if (target_resource !== undefined && coverage.name !== target_resource) continue
    entities += coverage.entities
    amount += coverage.amount
  }
  return { entities, amount }
}

function better(left: PlacementCandidate, right: PlacementCandidate, target_resource?: string) {
  const left_coverage = coverage_score(left, target_resource)
  const right_coverage = coverage_score(right, target_resource)
  if (left_coverage.entities !== right_coverage.entities) return left_coverage.entities > right_coverage.entities
  if (left_coverage.amount !== right_coverage.amount) return left_coverage.amount > right_coverage.amount
  if (left.distance_from_center !== right.distance_from_center) return left.distance_from_center < right.distance_from_center
  if (left.position.y !== right.position.y) return left.position.y < right.position.y
  if (left.position.x !== right.position.x) return left.position.x < right.position.x
  return left.direction < right.direction
}

function sort_candidates(values: PlacementCandidate[], target_resource?: string) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (better(values[j], values[i], target_resource)) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
}

function directions_for(prototype: any) {
  // `rotatable` exists on LuaEntity, not LuaEntityPrototype, and reading an
  // unknown key on a Factorio object raises; the prototype's equivalent is the
  // not-rotatable flag.
  if (prototype?.supports_direction === false || prototype?.flags?.['not-rotatable'] === true) return [0]
  return CARDINAL_DIRECTIONS
}

function item_output_position(prototype: any, position: { x: number, y: number }, direction: number) {
  const vector = vector_xy(prototype?.vector_to_place_result)
  if (!vector || (vector.x === 0 && vector.y === 0)) return undefined
  const rotated = rotate_cardinal(vector, direction)
  return { x: position.x + rotated.x, y: position.y + rotated.y }
}

function same_position(left: PlacementCandidate, right: PlacementCandidate) {
  return left.position.x === right.position.x && left.position.y === right.position.y
}

function port_signature(port: CandidateFluidPort) {
  return `${port.storage_index}:${port.connection_index}:${port.production_type ?? ''}:${port.filter ?? ''}:${port.flow_direction ?? ''}:${port.position.x}:${port.position.y}:${port.direction ?? ''}`
}

function spatial_signature(candidate: PlacementCandidate) {
  const parts: string[] = []
  if (candidate.item_output_position !== undefined) {
    parts.push(`out:${candidate.item_output_position.x}:${candidate.item_output_position.y}`)
  }
  for (const port of candidate.fluid_ports ?? []) parts.push(`fluid:${port_signature(port)}`)
  return parts.join('|')
}

/**
 * Keep the returned set compact but useful: reserve most slots for different
 * legal positions, then use remaining slots for alternate orientations only
 * when those orientations produce materially different output/fluid geometry.
 */
function diverse_top(values: PlacementCandidate[], limit: number) {
  const result: PlacementCandidate[] = []
  const primary_position_limit = limit <= 2 ? limit : limit - 2

  for (const candidate of values) {
    let position_seen = false
    for (const existing of result) {
      if (same_position(existing, candidate)) {
        position_seen = true
        break
      }
    }
    if (position_seen) continue
    result.push(candidate)
    if (result.length >= primary_position_limit) break
  }

  for (const candidate of values) {
    if (result.length >= limit) break
    let exact_selected = false
    let same_position_same_spatial = false
    for (const existing of result) {
      if (existing.position.x === candidate.position.x && existing.position.y === candidate.position.y && existing.direction === candidate.direction) {
        exact_selected = true
        break
      }
      if (same_position(existing, candidate) && spatial_signature(existing) === spatial_signature(candidate)) {
        same_position_same_spatial = true
      }
    }
    if (exact_selected || same_position_same_spatial) continue
    result.push(candidate)
  }

  return result
}

function candidate_has_target_resource(candidate: PlacementCandidate, target_resource: string) {
  for (const coverage of candidate.resource_coverage ?? []) {
    if (coverage.name === target_resource && coverage.entities > 0) return true
  }
  return false
}

/**
 * Enumerate legal placement choices locally using the running game's entity
 * prototype and LuaSurface.can_place_entity. Resource coverage, mining search
 * offsets, output vectors, and fluid-port geometry are derived from active
 * prototype/runtime data so modded entities participate without name cases.
 */
export function placement_candidates_for_actor(actor: ControlledActor, request: PlacementCandidateRequest) {
  const prototype = prototypes.entity[request.entity_name]
  if (!prototype) return { ok: false as const, error: 'entity prototype not found', entity_name: request.entity_name }

  const covers = request.covers_position
  if (covers !== undefined && (!finite(covers.x) || !finite(covers.y))) {
    return { ok: false as const, error: 'covers_position must be finite', entity_name: request.entity_name }
  }
  const center = request.center ?? covers ?? actor.position
  if (!finite(center.x) || !finite(center.y)) return { ok: false as const, error: 'center must be finite', entity_name: request.entity_name }
  const radius = math.max(1, math.min(MAX_RADIUS, math.floor(request.radius ?? (covers !== undefined ? COVERS_POSITION_DEFAULT_RADIUS : 8))))
  const limit = math.max(1, math.min(MAX_LIMIT, math.floor(request.limit ?? 5)))
  const directions = directions_for(prototype)
  const candidates: PlacementCandidate[] = []
  let scanned = 0

  for (const direction of directions) {
    const grid = placement_grid_rule(prototype, direction)
    const snapped_center = snap_placement_center(prototype, center, direction)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const position = { x: snapped_center.x + dx, y: snapped_center.y + dy }

        scanned += 1
        if (scanned > MAX_SCANNED_POSITIONS) break
        if (!actor.surface.can_place_entity({
          name: request.entity_name,
          position,
          direction,
          force: actor.force,
        })) continue
        if (covers !== undefined && !placement_footprint_covers_point(prototype, position, direction, covers)) continue

        const coverage = resource_coverage(actor, prototype, position, direction, request.target_resource)
        if (request.target_resource !== undefined) {
          let covered = false
          for (const value of coverage ?? []) if (value.name === request.target_resource && value.entities > 0) covered = true
          if (!covered) continue
        }

        const candidate: PlacementCandidate = {
          id: '',
          position,
          direction,
          distance_from_center: math.sqrt(squared_distance(position, center)),
          footprint: placement_footprint(prototype, position, direction),
        }
        const output = item_output_position(prototype, position, direction)
        if (output !== undefined) candidate.item_output_position = output
        const fluid_ports = candidate_fluid_ports(prototype, position, direction)
        if (fluid_ports !== undefined) candidate.fluid_ports = fluid_ports
        if (coverage !== undefined && coverage.length > 0) candidate.resource_coverage = coverage
        candidates.push(candidate)
      }
        if (scanned > MAX_SCANNED_POSITIONS) break
      }
      if (scanned > MAX_SCANNED_POSITIONS) break
    }
    if (scanned > MAX_SCANNED_POSITIONS) break
  }

  sort_candidates(candidates, request.target_resource)
  const selected = diverse_top(candidates, limit)
  for (let index = 0; index < selected.length; index++) selected[index].id = `candidate-${index + 1}`

  return {
    ok: true as const,
    entity_name: request.entity_name,
    center,
    radius,
    target_resource: request.target_resource,
    covers_position: covers,
    scanned,
    legal_candidate_count: candidates.length,
    returned_candidate_count: selected.length,
    candidates: selected,
  }
}

export function create_placement_candidate_set(actor: ControlledActor, request: PlacementCandidateRequest) {
  const result = placement_candidates_for_actor(actor, request)
  if (!result.ok) return result

  const id = next_candidate_set_id()
  const set: PlacementCandidateSet = {
    id,
    generated_tick: game.tick,
    entity_name: result.entity_name,
    surface_index: actor.surface.index,
    force_index: actor.force.index,
    target_resource: result.target_resource,
    candidates: result.candidates,
  }
  store_candidate_set(set)
  return {
    ...result,
    candidate_set_id: id,
    generated_tick: set.generated_tick,
    expires_tick: set.generated_tick + CANDIDATE_TTL_TICKS,
  }
}

export function execute_placement_candidate(
  actor: ControlledActor,
  candidate_set_id: string,
  candidate_id: string,
  submit_placement: (entity_name: string, x?: number, y?: number, direction?: number) => boolean,
): [boolean, string] {
  const set = candidate_sets()[candidate_set_id]
  if (!set) return [false, 'placement candidate set is unavailable']
  if (game.tick - set.generated_tick > CANDIDATE_TTL_TICKS) return [false, 'placement candidate set expired']
  if (actor.surface.index !== set.surface_index || actor.force.index !== set.force_index) return [false, 'placement candidate belongs to another actor surface/force']

  let candidate: PlacementCandidate | undefined
  for (const value of set.candidates) {
    if (value.id === candidate_id) {
      candidate = value
      break
    }
  }
  if (!candidate) return [false, 'placement candidate is unavailable']

  const prototype = prototypes.entity[set.entity_name]
  if (!prototype) return [false, 'entity prototype is no longer available']
  if (!actor.surface.can_place_entity({
    name: set.entity_name,
    position: candidate.position,
    direction: candidate.direction,
    force: actor.force,
  })) return [false, 'placement candidate is no longer placeable']

  if (set.target_resource !== undefined) {
    const coverage = resource_coverage(actor, prototype, candidate.position, candidate.direction, set.target_resource)
    const live_candidate: PlacementCandidate = { ...candidate, resource_coverage: coverage }
    if (!candidate_has_target_resource(live_candidate, set.target_resource)) {
      return [false, 'placement candidate no longer covers the requested resource']
    }
  }

  const accepted = submit_placement(set.entity_name, candidate.position.x, candidate.position.y, candidate.direction)
  return accepted
    ? [true, `placement candidate accepted: ${candidate_set_id}/${candidate_id}`]
    : [false, 'placement candidate could not be queued']
}
