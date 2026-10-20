import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { CandidateFluidPort, LiveFluidPort } from './placement_spatial_features'
import { candidate_fluid_ports, fluid_ports_join, live_fluid_ports } from './placement_spatial_features'
import { placement_check_args, placement_footprint, placement_footprint_covers_point, placement_grid_check, snap_placement_center, type PlacementFootprint } from './placement_geometry'
import { resolve_exact_entity } from './entity_reference'
import { pole_candidate_facts, pole_reach, protected_read } from './electric_facts'
import { find_world_entities } from './npc_vision'
import { placement_item_preflight, planned_placement_footprint } from './placement_preflight'
import { placement_obstruction_sample } from './placement_obstructions'
import { get_recent_fluid_source_observation } from './fluid_source_observation'
import { type ClearableEntity, type ClearanceMemo, placeable_or_clearable, placement_clearance } from './placement_clearing'
import type { GroundItem } from './placement_ground_items'

const MAX_RADIUS = 24
const MAX_LIMIT = 8
const MAX_SCANNED_POSITIONS = 10000
const MAX_CANDIDATE_SETS = 16
const CANDIDATE_TTL_TICKS = 60 * 60
// Refused footprints that pass the request's own filters are each checked for clearable blockers; past this
// many checks the rest count as rejected, so a dense forest or base cannot stall the single simulation thread.
const MAX_CLEARANCE_PROBES = 400
const CARDINAL_DIRECTIONS = [0, 4, 8, 12]

export interface PlacementCandidateRequest {
  entity_name: string
  center?: { x: number, y: number }
  radius?: number
  target_resource?: string
  // Only placements whose footprint covers this point, for example a drill's
  // item_output_position when the new entity must receive its output.
  covers_position?: { x: number, y: number }
  // Only footprints whose fluidbox connection joins this live entity port. The
  // footprint is derived from the prototype pipe connections, so it is exact
  // regardless of radius or limit.
  connects_to?: PlacementConnectsTo
  // The live entity the new one must serve (the furnace a drill should feed).
  // Candidates are ranked nearest this entity first, the search centres on it
  // when no centre is given, and a build never clears it.
  anchor?: PlacementAnchor
  limit?: number
}

export interface PlacementAnchor {
  unit_number: number
}

export interface PlacementConnectsTo {
  unit_number: number
  // Fluid storage and connection to join (1-based, as get_entity_status lists them).
  // Omitted, every open (unconnected) port of the entity is a target.
  storage_index?: number
  connection_index?: number
}

export interface PlacementCandidateJoin {
  unit_number: number
  entity_name: string
  target_port: { storage_index: number, connection_index: number }
  candidate_port: { storage_index: number, connection_index: number, direction?: number, filter?: string, flow_direction?: string }
  // The tile where the new entity port sits: the tile the live port opens onto.
  tile: { x: number, y: number }
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
  // Set when the placement legality is decided by tile rules (a shoreline).
  distance_from_actor?: number
  // Set when the request names an anchor entity: how far this spot is from it.
  distance_from_anchor?: number
  connects_to?: PlacementCandidateJoin
  // Electric-pole candidates only: wire links and supply coverage at this spot.
  electric?: Record<string, unknown>
  // Items lying in the footprint; placing this candidate picks them up first.
  ground_items?: GroundItem[]
  // Entities in the footprint (natural obstructions, the NPC's own idle entities)
  // that placing this candidate mines into the actor inventory first.
  clears?: ClearableEntity[]
}

interface PlacementCandidateSet {
  id: string
  generated_tick: number
  entity_name: string
  surface_index: number
  force_index: number
  actor_id?: number
  target_resource?: string
  // Entities placement must never clear: the request's anchor and join target.
  protected_unit_numbers?: number[]
  candidates: PlacementCandidate[]
}

declare const storage: {
  sgluna_placement_candidate_sets?: Record<string, PlacementCandidateSet>
  sgluna_placement_candidate_set_order?: string[]
  sgluna_placement_candidate_next_id?: number
}

function candidate_sets() {
  storage.sgluna_placement_candidate_sets ??= {}
  storage.sgluna_placement_candidate_set_order ??= []
  return storage.sgluna_placement_candidate_sets
}

/** Cover removal requires new water facts and a newly generated pump candidate. */
export function invalidate_actor_pump_candidates(actor: ControlledActor) {
  const sets = candidate_sets()
  const actor_id = actor.status_snapshot().actor_id
  for (const [id, set] of pairs(sets)) {
    if (set.actor_id === actor_id && set.force_index === actor.force.index && set.surface_index === actor.surface.index
      && prototypes.entity[set.entity_name]?.type === 'offshore-pump') delete sets[id]
  }
  storage.sgluna_placement_candidate_set_order = (storage.sgluna_placement_candidate_set_order ?? []).filter(id => sets[id] !== undefined)
}

function next_candidate_set_id() {
  const next = storage.sgluna_placement_candidate_next_id ?? 1
  storage.sgluna_placement_candidate_next_id = next + 1
  return `placement-${next}`
}

function store_candidate_set(value: PlacementCandidateSet) {
  const sets = candidate_sets()
  const order = storage.sgluna_placement_candidate_set_order as string[]
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
  const resources = find_world_entities(actor.surface, {
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

// Clearing costs hand-mining time and inventory room, and may take the NPC's own earlier work, so a footprint that
// needs nothing cleared outranks an otherwise equal one. With an anchor, distance to it still decides first (the
// new machine belongs beside what it serves) and the clear count only breaks ties; without one, fewer entities to
// clear come first. Fewer ground items is the last tie-break before position.
function clear_count(candidate: PlacementCandidate) {
  return candidate.clears === undefined ? 0 : candidate.clears.length
}

function ground_count(candidate: PlacementCandidate) {
  return candidate.ground_items === undefined ? 0 : candidate.ground_items.length
}

function better(left: PlacementCandidate, right: PlacementCandidate, target_resource?: string, origin?: { x: number, y: number }, anchor?: { x: number, y: number }) {
  if (anchor !== undefined) {
    const left_anchor = squared_distance(left.position, anchor)
    const right_anchor = squared_distance(right.position, anchor)
    if (left_anchor !== right_anchor) return left_anchor < right_anchor
  }
  if (clear_count(left) !== clear_count(right)) return clear_count(left) < clear_count(right)
  const left_coverage = coverage_score(left, target_resource)
  const right_coverage = coverage_score(right, target_resource)
  if (left_coverage.entities !== right_coverage.entities) return left_coverage.entities > right_coverage.entities
  if (left_coverage.amount !== right_coverage.amount) return left_coverage.amount > right_coverage.amount
  if (origin !== undefined) {
    const left_origin = squared_distance(left.position, origin)
    const right_origin = squared_distance(right.position, origin)
    if (left_origin !== right_origin) return left_origin < right_origin
  }
  if (left.distance_from_center !== right.distance_from_center) return left.distance_from_center < right.distance_from_center
  if (ground_count(left) !== ground_count(right)) return ground_count(left) < ground_count(right)
  if (left.position.y !== right.position.y) return left.position.y < right.position.y
  if (left.position.x !== right.position.x) return left.position.x < right.position.x
  return left.direction < right.direction
}

export function sort_candidates(values: PlacementCandidate[], target_resource?: string, origin?: { x: number, y: number }, anchor?: { x: number, y: number }) {
  // Bottom-up stable merge sort: a maximum-radius scan can yield ~10k legal
  // candidates. Quadratic sorting blocked the single simulation thread.
  const scratch: PlacementCandidate[] = []
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = math.min(start + width, values.length)
      const end = math.min(start + width * 2, values.length)
      let left = start
      let right = middle
      for (let index = start; index < end; index++) {
        if (left < middle && (right >= end || !better(values[right], values[left], target_resource, origin, anchor))) {
          scratch[index] = values[left++]
        }
        else scratch[index] = values[right++]
      }
    }
    for (let index = 0; index < values.length; index++) values[index] = scratch[index]
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
  return `${port.production_type ?? ''}:${port.filter ?? ''}:${port.flow_direction ?? ''}:${port.position.x}:${port.position.y}:${port.direction ?? ''}`
}

// Two orientations are the same geometry when they expose the same ports on the
// same tiles, whichever connection of the prototype each port came from: the
// two ends of a symmetric machine swap under a half turn. The fluid parts are
// therefore compared as a sorted set, not as a list.
function spatial_signature(candidate: PlacementCandidate) {
  const parts: string[] = []
  if (candidate.item_output_position !== undefined) {
    parts.push(`out:${candidate.item_output_position.x}:${candidate.item_output_position.y}`)
  }
  const fluid: string[] = []
  for (const port of candidate.fluid_ports ?? []) fluid.push(`fluid:${port_signature(port)}`)
  for (let i = 0; i < fluid.length; i++) {
    for (let j = i + 1; j < fluid.length; j++) {
      if (fluid[j] < fluid[i]) {
        const tmp = fluid[i]
        fluid[i] = fluid[j]
        fluid[j] = tmp
      }
    }
  }
  for (const part of fluid) parts.push(part)
  if (candidate.connects_to !== undefined) {
    const joined = candidate.connects_to.candidate_port
    parts.push(`joins:${candidate.connects_to.unit_number}:${candidate.connects_to.target_port.storage_index}:${candidate.connects_to.target_port.connection_index}:${joined.filter ?? ''}:${joined.flow_direction ?? ''}`)
  }
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

interface JoinTarget {
  unit_number: number
  entity_name: string
  ports: LiveFluidPort[]
}

function bounded_index(value: unknown, maximum: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= 1 && value <= maximum
}

function join_failure(code: string, error: string, unit_number?: number) {
  return { ok: false as const, code, error, unit_number }
}

/**
 * Resolve the live entity and the open fluid ports a connects_to request names.
 * The entity must be on the actor surface and force; with no connection_index only
 * unconnected ports are targets, because a connected port already has a neighbour.
 */
function resolve_join_target(actor: ControlledActor, request: PlacementConnectsTo) {
  if (typeof request !== 'object' || !bounded_index(request.unit_number, 9007199254740991)) {
    return join_failure('invalid_connects_to', 'connects_to.unit_number must be a positive integer')
  }
  if (request.storage_index !== undefined && !bounded_index(request.storage_index, 8)) {
    return join_failure('invalid_connects_to', 'connects_to.storage_index must be an integer from 1 to 8', request.unit_number)
  }
  if (request.connection_index !== undefined && !bounded_index(request.connection_index, 8)) {
    return join_failure('invalid_connects_to', 'connects_to.connection_index must be an integer from 1 to 8', request.unit_number)
  }
  const entity = resolve_exact_entity(actor, request.unit_number)
  if (!entity || !entity.valid || entity.surface.index !== actor.surface.index || entity.force.index !== actor.force.index) {
    return join_failure('connects_to_entity_not_found', 'connects_to entity is not on this surface and force', request.unit_number)
  }
  const ports: LiveFluidPort[] = []
  let matched = 0
  for (const port of live_fluid_ports(entity)) {
    if (request.storage_index !== undefined && port.storage_index !== request.storage_index) continue
    if (request.connection_index !== undefined && port.connection_index !== request.connection_index) continue
    matched += 1
    if (request.connection_index === undefined && port.connected) continue
    ports.push(port)
  }
  if (matched === 0) return join_failure('connects_to_port_not_found', 'connects_to entity has no such fluid port', request.unit_number)
  if (ports.length === 0) return join_failure('connects_to_port_unavailable', 'every matching fluid port is already connected', request.unit_number)
  return { ok: true as const, target: { unit_number: request.unit_number, entity_name: entity.name, ports } as JoinTarget }
}

/** Resolve the live entity an anchor request names: on the actor surface and force, as connects_to requires. */
function resolve_anchor(actor: ControlledActor, request: PlacementAnchor) {
  if (typeof request !== 'object' || !bounded_index(request.unit_number, 9007199254740991)) {
    return join_failure('invalid_anchor', 'anchor.unit_number must be a positive integer')
  }
  const entity = resolve_exact_entity(actor, request.unit_number)
  if (!entity || !entity.valid || entity.surface.index !== actor.surface.index || entity.force.index !== actor.force.index) {
    return join_failure('anchor_entity_not_found', 'anchor entity is not on this surface and force', request.unit_number)
  }
  return { ok: true as const, unit_number: request.unit_number, entity_name: entity.name, position: { x: entity.position.x, y: entity.position.y } }
}

function joining_port(candidate: PlacementCandidate, target: LiveFluidPort) {
  for (const port of candidate.fluid_ports ?? []) {
    if (fluid_ports_join(target, port)) return port
  }
  return undefined
}

/**
 * Enumerate legal placement choices locally using the running game entity
 * prototype and LuaSurface.can_place_entity. Resource coverage, mining search
 * offsets, output vectors, and fluid-port geometry are derived from active
 * prototype/runtime data so modded entities participate without name cases.
 *
 * With connects_to the footprints are solved from the prototype pipe connections
 * so that a port lands on the tile the live port opens onto, instead of scanning
 * a square and hoping an aligned footprint is among the first few. Placement whose
 * legality is decided by tile rules (a shoreline) is ordered nearest the actor first.
 */
// The super-force UI uses these native prototype rules when staging removal.
// They are preparation hints in north-facing coordinates, never proof that a
// covered site can be physically built or permission to change the terrain.
function pump_terrain_preparation(prototype: any) {
  const raw = (prototype.tile_buildability_rules ?? []) as Array<any>
  const rules: Array<Record<string, unknown>> = []
  function layers(mask: any) {
    const names: string[] = []
    let truncated = false
    const native_layers = (mask?.layers ?? {}) as Record<string, boolean>
    for (const [name, enabled] of pairs(native_layers)) {
      if (enabled !== true) continue
      if (names.length >= 16) { truncated = true; break }
      names.push(name)
    }
    return { layers: names, truncated }
  }
  for (let index = 0; index < math.min(raw.length, 8); index++) {
    const rule = raw[index]
    rules.push({ area: rule.area, colliding_tiles: layers(rule.colliding_tiles), required_tiles: layers(rule.required_tiles),
      remove_on_collision: rule.remove_on_collision === true })
  }
  return { source: 'native_prototype_tile_buildability_rules', orientation: 'north_unrotated', rules, truncated: raw.length > rules.length,
    interpretation: 'Super-force build may stage terrain deconstruction, not immediate water restoration. Inspect covered fluid hints, then revalidate physical candidates after native removal.',
    placement_authority: false }
}

export function placement_candidates_for_actor(actor: ControlledActor, request: PlacementCandidateRequest) {
  const prototype = prototypes.entity[request.entity_name]
  if (!prototype) return { ok: false as const, error: 'entity prototype not found', entity_name: request.entity_name }

  const covers = request.covers_position
  if (covers !== undefined && (!finite(covers.x) || !finite(covers.y))) {
    return { ok: false as const, error: 'covers_position must be finite', entity_name: request.entity_name }
  }
  let join_target: JoinTarget | undefined
  if (request.connects_to !== undefined) {
    const resolved = resolve_join_target(actor, request.connects_to)
    if (!resolved.ok) return { ok: false as const, error: resolved.error, code: resolved.code, entity_name: request.entity_name, unit_number: resolved.unit_number }
    join_target = resolved.target
  }
  const join_origin = join_target !== undefined ? join_target.ports[0].target_position : undefined
  let anchor: { unit_number: number, entity_name: string, position: { x: number, y: number } } | undefined
  if (request.anchor !== undefined) {
    const resolved = resolve_anchor(actor, request.anchor)
    if (!resolved.ok) return { ok: false as const, error: resolved.error, code: resolved.code, entity_name: request.entity_name, unit_number: resolved.unit_number }
    anchor = resolved
  }
  // A build never clears the entity it serves or the one it joins.
  const protect: number[] = []
  if (anchor !== undefined) protect.push(anchor.unit_number)
  if (join_target !== undefined) protect.push(join_target.unit_number)
  const clearance_memo: ClearanceMemo = { reasons: {} }
  let clearance_probes = 0
  let clearance_probes_capped = false
  let water_center: { x: number, y: number } | undefined
  let terrain_preparation: ReturnType<typeof pump_terrain_preparation> | undefined
  if (prototype.type === 'offshore-pump') {
    terrain_preparation = pump_terrain_preparation(prototype)
    const water = get_recent_fluid_source_observation(actor)
    if (!water) return { ok: false as const, code: 'water_search_required', entity_name: request.entity_name, terrain_preparation,
      error: 'Read getFluidSourceTiles for water before searching pump candidates; check its covered_fluid_hints before selecting a site.' }
    const samples = water.samples
    if (!samples || samples.length === 0) return { ok: false as const, code: 'water_source_not_exposed', entity_name: request.entity_name, terrain_preparation,
      error: 'No exposed water sample is known. Inspect covered_fluid_hints for removable cover, or explore the reported unknown area, then read water and validate candidates again.',
      water_search: water }
    water_center = samples[0].position
  }
  const center = request.center ?? covers ?? join_origin ?? water_center ?? anchor?.position ?? actor.position
  if (!finite(center.x) || !finite(center.y)) return { ok: false as const, error: 'center must be finite', entity_name: request.entity_name }
  const radius = math.max(1, math.min(MAX_RADIUS, math.floor(request.radius ?? (covers !== undefined ? COVERS_POSITION_DEFAULT_RADIUS : 8))))
  const limit = math.max(1, math.min(MAX_LIMIT, math.floor(request.limit ?? 5)))
  const directions = directions_for(prototype)
  const check_args = placement_check_args(request.entity_name)
  const nearest_first = check_args.build_check_type !== undefined
  const distance_origin = nearest_first ? { x: actor.position.x, y: actor.position.y } : undefined
  const candidates: PlacementCandidate[] = []
  let scanned = 0
  let rejected = 0
  const obstruction_samples: Array<ReturnType<typeof placement_obstruction_sample>> = []

  function consider(position: { x: number, y: number }, direction: number, target?: LiveFluidPort) {
    // Diagnose only compatible solved joins, not nearby but incompatible ports.
    if (target !== undefined) {
      let joins = false
      for (const port of candidate_fluid_ports(prototype, position, direction) ?? []) if (fluid_ports_join(target, port)) joins = true
      if (!joins) return undefined
    }
    const natively_placeable = actor.surface.can_place_entity({
      name: request.entity_name,
      position,
      direction,
      force: actor.force,
      ...check_args,
    })
    // The request's own filters come first: a footprint they drop is not worth a clearance check.
    if (covers !== undefined && !placement_footprint_covers_point(prototype, position, direction, covers)) return undefined

    const coverage = resource_coverage(actor, prototype, position, direction, request.target_resource)
    if (request.target_resource !== undefined) {
      let covered = false
      for (const value of coverage ?? []) if (value.name === request.target_resource && value.entities > 0) covered = true
      if (!covered) return undefined
    }

    let ground_items: GroundItem[] | undefined
    let clears: ClearableEntity[] | undefined
    if (!natively_placeable) {
      // Refused only for ground items and clearable entities: still a candidate, and placing it clears them.
      let clearance: ReturnType<typeof placement_clearance>
      if (clearance_probes < MAX_CLEARANCE_PROBES) {
        clearance_probes++
        clearance = placement_clearance(actor, prototype, request.entity_name, position, direction, protect, clearance_memo)
      }
      else clearance_probes_capped = true
      if (clearance === undefined) {
        rejected++
        if (obstruction_samples.length < 3) obstruction_samples.push(placement_obstruction_sample(actor, prototype, position, direction))
        return undefined
      }
      if (clearance.ground_items.length > 0) ground_items = clearance.ground_items
      if (clearance.blockers.length > 0) {
        clears = []
        for (const blocker of clearance.blockers) clears.push(blocker.info)
      }
    }

    const candidate: PlacementCandidate = {
      id: '',
      position,
      direction,
      distance_from_center: math.sqrt(squared_distance(position, center)),
      footprint: placement_footprint(prototype, position, direction),
    }
    if (distance_origin !== undefined) candidate.distance_from_actor = math.sqrt(squared_distance(position, distance_origin))
    if (anchor !== undefined) candidate.distance_from_anchor = math.sqrt(squared_distance(position, anchor.position))
    const output = item_output_position(prototype, position, direction)
    if (output !== undefined) candidate.item_output_position = output
    const fluid_ports = candidate_fluid_ports(prototype, position, direction)
    if (fluid_ports !== undefined) candidate.fluid_ports = fluid_ports
    if (coverage !== undefined && coverage.length > 0) candidate.resource_coverage = coverage
    if (ground_items !== undefined) candidate.ground_items = ground_items
    if (clears !== undefined) candidate.clears = clears
    return candidate
  }

  if (join_target !== undefined) {
    const seen: Record<string, boolean> = {}
    for (const target of join_target.ports) {
      for (const direction of directions) {
        for (const port of candidate_fluid_ports(prototype, { x: 0, y: 0 }, direction) ?? []) {
          scanned += 1
          const position = { x: target.target_position.x - port.position.x, y: target.target_position.y - port.position.y }
          if (!placement_grid_check(prototype, position, direction).valid) continue
          const key = `${target.storage_index}:${target.connection_index}:${position.x}:${position.y}:${direction}`
          if (seen[key] === true) continue
          seen[key] = true
          const candidate = consider(position, direction, target)
          if (candidate === undefined) continue
          const joined = joining_port(candidate, target)
          if (joined === undefined) continue
          candidate.connects_to = {
            unit_number: join_target.unit_number,
            entity_name: join_target.entity_name,
            target_port: { storage_index: target.storage_index, connection_index: target.connection_index },
            candidate_port: {
              storage_index: joined.storage_index,
              connection_index: joined.connection_index,
              direction: joined.direction,
              filter: joined.filter,
              flow_direction: joined.flow_direction,
            },
            tile: { x: target.target_position.x, y: target.target_position.y },
          }
          candidates.push(candidate)
        }
      }
    }
  }
  else {
    // Square rings outward from the search centre, every direction at each ring, so the scan and clearance
    // budgets are spent where the request is centred (the anchor, when it has one) and not on one corner or one direction.
    const snapped_centers: Array<{ x: number, y: number }> = []
    for (const direction of directions) snapped_centers.push(snap_placement_center(prototype, center, direction))
    const scan_ring = (direction: number, snapped_center: { x: number, y: number }, ring: number) => {
      for (let dy = -ring; dy <= ring; dy++) {
        const edge = dy === -ring || dy === ring
        for (let dx = -ring; dx <= ring; dx += edge || ring === 0 ? 1 : 2 * ring) {
          scanned += 1
          if (scanned > MAX_SCANNED_POSITIONS) return false
          const candidate = consider({ x: snapped_center.x + dx, y: snapped_center.y + dy }, direction)
          if (candidate !== undefined) candidates.push(candidate)
        }
      }
      return true
    }
    for (let ring = 0; ring <= radius; ring++) {
      let within_scan_limit = true
      for (let index = 0; index < directions.length; index++) {
        if (!scan_ring(directions[index], snapped_centers[index], ring)) { within_scan_limit = false; break }
      }
      if (!within_scan_limit) break
    }
  }

  sort_candidates(candidates, request.target_resource, distance_origin, anchor?.position)
  const selected = diverse_top(candidates, limit)
  for (let index = 0; index < selected.length; index++) selected[index].id = `candidate-${index + 1}`

  const incomplete_reason = clearance_probes_capped
    ? 'clearance_check_limit'
    : scanned > MAX_SCANNED_POSITIONS ? 'scan_limit' : undefined

  const reach = pole_reach(prototype)
  if (reach !== undefined) {
    for (const candidate of selected) candidate.electric = pole_candidate_facts(actor, prototype, candidate.position)
  }

  // The legal candidates come first and the rejected-footprint samples last, apart from the candidate list.
  return {
    ok: true as const,
    entity_name: request.entity_name,
    ordering: anchor !== undefined
      ? 'nearest_to_anchor_first'
      : nearest_first ? 'nearest_to_actor_first' : 'fewest_clears_then_resource_coverage_then_nearest_to_center',
    legal_candidate_count: candidates.length,
    returned_candidate_count: selected.length,
    candidates: selected,
    // Set beside the candidates, not among the rejected samples: more legal candidates may exist than were found.
    ...(incomplete_reason !== undefined ? { candidates_may_be_incomplete: true, candidates_incomplete_reason: incomplete_reason } : {}),
    clearance_probes,
    center,
    radius,
    target_resource: request.target_resource,
    covers_position: covers,
    anchor,
    connects_to: join_target === undefined
      ? undefined
      : {
          unit_number: join_target.unit_number,
          entity_name: join_target.entity_name,
          target_ports: join_target.ports.map(port => ({
            storage_index: port.storage_index,
            connection_index: port.connection_index,
            tile: port.target_position,
            own_tile: port.position,
            filter: port.filter,
            flow_direction: port.flow_direction,
          })),
        },
    terrain_preparation,
    electric_pole: reach,
    scanned,
    obstructions: {
      label: 'rejected_footprint_samples_not_candidates',
      source: 'native_placement_checks',
      observed_tick: game.tick,
      actor_id: protected_read(() => actor.status_snapshot().actor_id),
      interpretation: 'observed_collision_mask_intersections_not_exhaustive_rejection_causes',
      surface_index: actor.surface.index,
      force_index: actor.force.index,
      scope: 'sampled_footprints',
      examined_count: obstruction_samples.length,
      rejected_count: rejected,
      unknown_count: obstruction_samples.filter(sample => sample.unknown).length,
      samples: obstruction_samples,
      truncated: rejected > obstruction_samples.length || obstruction_samples.some(sample => sample.truncated),
    },
  }
}

function protect_list(result: { anchor?: { unit_number: number }, connects_to?: { unit_number: number } }) {
  const list: number[] = []
  if (result.anchor !== undefined) list.push(result.anchor.unit_number)
  if (result.connects_to !== undefined) list.push(result.connects_to.unit_number)
  return list
}

export function create_placement_candidate_set(actor: ControlledActor, request: PlacementCandidateRequest) {
  const result = placement_candidates_for_actor(actor, request)
  if (!result.ok) return result

  const id = next_candidate_set_id()
  // The set is persisted in the save: keep what execution revalidates, not the
  // live electric-network read, which is only for the answer.
  const stored: PlacementCandidate[] = []
  for (const candidate of result.candidates) {
    const copy: PlacementCandidate = { ...candidate }
    copy.electric = undefined
    stored.push(copy)
  }
  const set: PlacementCandidateSet = {
    id,
    generated_tick: game.tick,
    entity_name: result.entity_name,
    actor_id: actor.status_snapshot?.().actor_id,
    surface_index: actor.surface.index,
    force_index: actor.force.index,
    target_resource: result.target_resource,
    protected_unit_numbers: protect_list(result),
    candidates: stored,
  }
  store_candidate_set(set)
  return {
    ...result,
    candidate_set_id: id,
    generated_tick: set.generated_tick,
    expires_tick: set.generated_tick + CANDIDATE_TTL_TICKS,
  }
}

/**
 * Why a stored connection candidate no longer joins its target, or undefined when it still does: the live
 * port must still exist, be open, and sit where the footprint (recomputed from the prototype) puts its port.
 */
function join_change(target: LuaEntity, prototype: any, candidate: PlacementCandidate) {
  const join = candidate.connects_to
  if (join === undefined) return undefined
  let live: LiveFluidPort | undefined
  for (const port of live_fluid_ports(target)) {
    if (port.storage_index === join.target_port.storage_index && port.connection_index === join.target_port.connection_index) live = port
  }
  if (live === undefined) return 'the target fluid port no longer exists'
  if (live.connected) return 'the target fluid port is already connected'
  let own: CandidateFluidPort | undefined
  for (const port of candidate_fluid_ports(prototype, candidate.position, candidate.direction) ?? []) {
    if (port.storage_index === join.candidate_port.storage_index && port.connection_index === join.candidate_port.connection_index) own = port
  }
  if (own === undefined || !fluid_ports_join(live, own)) return 'the target fluid port no longer lines up with the stored footprint'
  return undefined
}

function resolve_placement_candidate(
  actor: ControlledActor,
  candidate_set_id: string,
  candidate_id: string,
) {
  const set = candidate_sets()[candidate_set_id]
  if (!set) return { ok: false as const, error: 'placement candidate set is unavailable' }
  if (game.tick < set.generated_tick || game.tick - set.generated_tick > CANDIDATE_TTL_TICKS) return { ok: false as const, error: 'placement candidate set expired' }
  if (actor.surface.index !== set.surface_index || actor.force.index !== set.force_index) return { ok: false as const, error: 'placement candidate belongs to another actor surface/force' }

  let candidate: PlacementCandidate | undefined
  for (const value of set.candidates) {
    if (value.id === candidate_id) {
      candidate = value
      break
    }
  }
  if (!candidate) return { ok: false as const, error: 'placement candidate is unavailable' }

  const prototype = prototypes.entity[set.entity_name]
  if (!prototype) return { ok: false as const, error: 'entity prototype is no longer available' }
  if (prototype.type === 'offshore-pump' && (set.actor_id === undefined || actor.status_snapshot?.().actor_id !== set.actor_id)) {
    return { ok: false as const, error: 'placement candidate belongs to another actor' }
  }
  if (candidate.connects_to !== undefined) {
    // A connection candidate is only meaningful next to the entity it was solved for.
    const target = resolve_exact_entity(actor, candidate.connects_to.unit_number)
    if (!target || !target.valid || target.surface.index !== set.surface_index || target.force.index !== set.force_index) {
      return { ok: false as const, error: 'placement candidate connection target is no longer available' }
    }
    const changed = join_change(target, prototype, candidate)
    if (changed !== undefined) return { ok: false as const, code: 'connects_to_port_changed', error: `connects_to_port_changed: ${changed}` }
  }
  if (!placeable_or_clearable(actor, prototype, set.entity_name, candidate.position, candidate.direction, set.protected_unit_numbers)) {
    return { ok: false as const, error: 'placement candidate is no longer placeable' }
  }

  if (set.target_resource !== undefined) {
    const coverage = resource_coverage(actor, prototype, candidate.position, candidate.direction, set.target_resource)
    const live_candidate: PlacementCandidate = { ...candidate, resource_coverage: coverage }
    if (!candidate_has_target_resource(live_candidate, set.target_resource)) {
      return { ok: false as const, error: 'placement candidate no longer covers the requested resource' }
    }
  }

  return { ok: true as const, set, candidate }
}

export function placement_candidate_matches(actor: ControlledActor, proof: { candidate_set_id: string, candidate_id: string }, entity_name: string, x?: number, y?: number, direction?: number) {
  const resolved = resolve_placement_candidate(actor, proof.candidate_set_id, proof.candidate_id)
  return resolved.ok && resolved.set.entity_name === entity_name && resolved.candidate.position.x === x
    && resolved.candidate.position.y === y && resolved.candidate.direction === direction
}

export function placement_candidate_preflight(actor: ControlledActor, candidate_set_id: string, candidate_id: string) {
  const resolved = resolve_placement_candidate(actor, candidate_set_id, candidate_id)
  // A changed join keeps the stale-candidate class; its error text starts with connects_to_port_changed.
  if (!resolved.ok) return { ok: false, code: 'placement_candidate_unavailable', error: resolved.error }
  // Only the native registry supplies entity identity and geometry.
  const { set, candidate } = resolved
  const planned_footprint = planned_placement_footprint(set.entity_name, candidate.position.x, candidate.position.y, candidate.direction)
  return { ...placement_item_preflight(actor, set.entity_name), ...(planned_footprint ? { planned_footprint } : {}) }
}

export function execute_placement_candidate(
  actor: ControlledActor,
  candidate_set_id: string,
  candidate_id: string,
  submit_placement: (entity_name: string, x?: number, y?: number, direction?: number, proof?: { candidate_set_id: string, candidate_id: string }, protected_unit_numbers?: number[]) => boolean,
): [boolean, string] {
  const resolved = resolve_placement_candidate(actor, candidate_set_id, candidate_id)
  if (!resolved.ok) return [false, resolved.error]
  const { set, candidate } = resolved
  const protected_unit_numbers = set.protected_unit_numbers !== undefined && set.protected_unit_numbers.length > 0 ? set.protected_unit_numbers : undefined
  const accepted = prototypes.entity[set.entity_name]?.type === 'offshore-pump'
    ? submit_placement(set.entity_name, candidate.position.x, candidate.position.y, candidate.direction, { candidate_set_id, candidate_id }, protected_unit_numbers)
    : protected_unit_numbers === undefined
      ? submit_placement(set.entity_name, candidate.position.x, candidate.position.y, candidate.direction)
      : submit_placement(set.entity_name, candidate.position.x, candidate.position.y, candidate.direction, undefined, protected_unit_numbers)
  return accepted
    ? [true, `placement candidate accepted: ${candidate_set_id}/${candidate_id}`]
    : [false, 'placement candidate could not be queued']
}
