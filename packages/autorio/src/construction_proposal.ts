import type { ControlledActor } from './actors/types'
import type { PlannedFootprint } from './construction_execution'
import type { EndpointView, LayoutConnection, LayoutConnectionInput } from './construction_layout'
import { check_single_placement, evaluate_plan, footprints_collide } from './construction_execution'
import { inserter_partial_mismatch, MAX_LAYOUT_PLACEMENTS, normalize_connections, overlaps, planned_view, prove_connection, resolve_existing_view, roles_of, valid_slot_name } from './construction_layout'
import { planned_placement_footprint } from './placement_preflight'

// Milestone 4, acceptance L6: a read-only proposal of small connected layouts. The planner fixes some placements exactly and
// bounds others to a zone; the harness enumerates which native-legal positions inside each zone make the same slots and
// connections hold, and the model chooses one. Fixed means fixed: a fixed placement is carried unchanged into every
// alternative and is never moved or rotated to make a layout fit. Nothing is stored, built or reserved here; the only route to
// execution stays validate_construction_plan with a fully fixed plan, which stores its token.

export interface LayoutProposalZone {
  center: { x: number, y: number }
  radius: number
}

export interface LayoutProposalPlacement {
  entity_name: string
  slot: string
  /** A fixed placement: the exact position (and optional direction). */
  x?: number
  y?: number
  direction?: number
  /** A zoned placement: the bounded area its centre may be chosen from, and the directions it may face. */
  zone?: LayoutProposalZone
  directions?: number[]
}

export interface LayoutProposalRequest {
  placements: LayoutProposalPlacement[]
  connections: LayoutConnectionInput[]
  max_alternatives?: number
}

export const PROPOSAL_MAX_ZONE_RADIUS = 8
export const PROPOSAL_MAX_ZONE_CANDIDATES = 64
export const PROPOSAL_EVALUATION_BUDGET = 256
export const PROPOSAL_MAX_ALTERNATIVES = 4

const CARDINAL_DIRECTIONS = [0, 4, 8, 12]
const MAX_COORDINATE = 1000000
const ZONE_EPSILON = 0.000001
const DISTANCE_SCALE = 1000000

type Position = { x: number, y: number }

interface ProposalSlot {
  index: number
  slot: string
  entity_name: string
  fixed: boolean
  /** Fixed: the requested position. Zoned: the zone centre. */
  x: number
  y: number
  /** Fixed: the requested direction, when one was given. */
  direction?: number
  radius: number
  /** Zoned: the directions its candidates face. */
  directions: number[]
}

interface Candidate {
  x: number
  y: number
  direction: number
  distance_squared: number
  footprint: PlannedFootprint
}

interface Found {
  placements: Array<Record<string, unknown>>
  planning_status: string
  execution_eligible: boolean
  eligibility_blockers?: Array<Record<string, unknown>>
  connections: Array<Record<string, unknown>>
  score: number
  /** The y, x and direction of each zoned placement in plan order: the final tie-break. */
  keys: Array<{ y: number, x: number, direction: number }>
}

function refusal(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, error: { code, message, ...extra } }
}

function valid_coordinate(value: unknown) {
  return typeof value === 'number' && value === value && value >= -MAX_COORDINATE && value <= MAX_COORDINATE
}

function valid_integer(value: unknown, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function round2(value: number) {
  return math.floor(value * 100 + 0.5) / 100
}

function prototype_directions(entity_name: string) {
  const prototype: any = prototypes.entity[entity_name]
  // `rotatable` exists on LuaEntity, not LuaEntityPrototype; the prototype's equivalent is supports_direction and the
  // not-rotatable flag.
  if (prototype?.supports_direction === false || prototype?.flags?.['not-rotatable'] === true) return [0]
  return CARDINAL_DIRECTIONS
}

function bump(counts: Record<string, number>, reason: string) {
  counts[reason] = (counts[reason] ?? 0) + 1
}

function reason_of(code: unknown) {
  return typeof code === 'string' ? code.toLowerCase() : 'unknown'
}

// Shape, limits and roles only. The world is not read.
function normalize_proposal(request: LayoutProposalRequest) {
  if (!request || typeof request !== 'object') return refusal('INVALID_REQUEST', 'the request must be an object')
  const raw: any = request
  const placement_inputs: any[] = Array.isArray(raw.placements) ? raw.placements : []
  if (placement_inputs.length < 1 || placement_inputs.length > MAX_LAYOUT_PLACEMENTS) {
    return refusal('INVALID_REQUEST', `placements must contain between 1 and ${MAX_LAYOUT_PLACEMENTS} entries`)
  }
  const slots: ProposalSlot[] = []
  const seen: Record<string, boolean> = {}
  for (let index = 0; index < placement_inputs.length; index++) {
    const placement = placement_inputs[index]
    const entity_name: unknown = placement?.entity_name
    if (!placement || typeof placement !== 'object' || typeof entity_name !== 'string' || entity_name.length < 1 || entity_name.length > 200) {
      return refusal('INVALID_PLACEMENT', `placement ${index} has an invalid entity_name`, { index })
    }
    if (!valid_slot_name(placement.slot)) {
      return refusal('INVALID_PLACEMENT', `placement ${index} needs a slot (1..40 characters of a-z, 0-9, _ and -)`, { index })
    }
    if (seen[placement.slot]) {
      return refusal('INVALID_CONNECTION', `placement ${index} repeats slot ${placement.slot}`, { slot: placement.slot, placement_index: index })
    }
    seen[placement.slot] = true
    const zoned = placement.zone !== undefined
    const positioned = placement.x !== undefined || placement.y !== undefined
    if (zoned === positioned) {
      return refusal('INVALID_PLACEMENT', `placement ${index} is either fixed (x, y) or zoned (zone), not both and not neither`, { index })
    }
    if (zoned) {
      const zone = placement.zone
      if (!zone || typeof zone !== 'object' || !zone.center || typeof zone.center !== 'object' || !valid_coordinate(zone.center.x) || !valid_coordinate(zone.center.y)) {
        return refusal('INVALID_PLACEMENT', `placement ${index} has an invalid zone centre`, { index })
      }
      if (typeof zone.radius !== 'number' || zone.radius !== zone.radius || zone.radius <= 0 || zone.radius > PROPOSAL_MAX_ZONE_RADIUS) {
        return refusal('INVALID_PLACEMENT', `placement ${index} has an invalid zone radius (more than 0 and at most ${PROPOSAL_MAX_ZONE_RADIUS} tiles)`, { index })
      }
      if (placement.direction !== undefined) {
        return refusal('INVALID_PLACEMENT', `placement ${index} is zoned and takes directions, not direction`, { index })
      }
      const supported = prototype_directions(placement.entity_name)
      let directions: number[] = supported
      if (placement.directions !== undefined) {
        const direction_inputs: unknown[] = Array.isArray(placement.directions) ? placement.directions : []
        if (direction_inputs.length < 1 || direction_inputs.length > CARDINAL_DIRECTIONS.length) {
          return refusal('INVALID_PLACEMENT', `placement ${index} has invalid directions (1 to 4 of 0, 4, 8, 12)`, { index })
        }
        const requested: number[] = []
        for (const direction of direction_inputs) {
          if (!valid_integer(direction, 0, 15) || !CARDINAL_DIRECTIONS.includes(direction as number) || requested.includes(direction as number)) {
            return refusal('INVALID_PLACEMENT', `placement ${index} has invalid directions (1 to 4 distinct values of 0, 4, 8, 12)`, { index })
          }
          requested.push(direction as number)
        }
        directions = supported.filter(direction => requested.includes(direction))
        if (directions.length === 0) {
          return refusal('INVALID_PLACEMENT', `placement ${index} asks for directions ${placement.entity_name} does not support`, { index, supported })
        }
      }
      directions = [...directions].sort((a, b) => a - b)
      slots.push({ index, slot: placement.slot, entity_name: placement.entity_name, fixed: false, x: zone.center.x, y: zone.center.y, radius: zone.radius, directions })
      continue
    }
    if (!valid_coordinate(placement.x) || !valid_coordinate(placement.y)) {
      return refusal('INVALID_PLACEMENT', `placement ${index} has invalid coordinates`, { index })
    }
    if (placement.directions !== undefined) {
      return refusal('INVALID_PLACEMENT', `placement ${index} is fixed and takes direction, not directions`, { index })
    }
    if (placement.direction !== undefined && (!valid_integer(placement.direction, 0, 15) || !CARDINAL_DIRECTIONS.includes(placement.direction))) {
      return refusal('INVALID_PLACEMENT', `placement ${index} has invalid direction (a construction plan takes 0, 4, 8 or 12)`, { index })
    }
    slots.push({ index, slot: placement.slot, entity_name: placement.entity_name, fixed: true, x: placement.x, y: placement.y, direction: placement.direction, radius: 0, directions: [] })
  }
  let zoned_count = 0
  for (const slot of slots) if (!slot.fixed) zoned_count++
  if (zoned_count === 0) {
    return refusal('NO_ZONED_PLACEMENT', 'a proposal needs at least one zoned placement; a fully fixed plan goes to validate_construction_plan')
  }

  const connection_inputs: unknown[] = Array.isArray(raw.connections) ? raw.connections : []
  if (connection_inputs.length < 1) {
    return refusal('INVALID_REQUEST', 'connections are required: at least 1')
  }
  const normalized = normalize_connections(connection_inputs, slots.map(slot => ({ entity_name: slot.entity_name, x: slot.x, y: slot.y, slot: slot.slot })))
  if ('error' in normalized) return { ok: false as const, error: normalized.error }
  const connections = normalized.connections!
  for (const slot of slots) {
    if (slot.fixed) continue
    let used = false
    for (const connection of connections) {
      for (const role of roles_of(connection)) if (connection.endpoints[role].slot === slot.slot) used = true
    }
    if (!used) return refusal('ZONED_SLOT_UNCONNECTED', `zoned slot ${slot.slot} is not part of any connection`, { slot: slot.slot })
  }

  let max_alternatives = PROPOSAL_MAX_ALTERNATIVES
  if (raw.max_alternatives !== undefined) {
    if (!valid_integer(raw.max_alternatives, 1, PROPOSAL_MAX_ALTERNATIVES)) {
      return refusal('INVALID_REQUEST', `max_alternatives must be an integer from 1 to ${PROPOSAL_MAX_ALTERNATIVES}`)
    }
    max_alternatives = raw.max_alternatives
  }
  return { ok: true as const, slots, connections, max_alternatives }
}

function footprints_conflict(a: PlannedFootprint, b: PlannedFootprint) {
  return footprints_collide(a, b) && overlaps(a.world_box, b.world_box)
}

// The native-legal cells of one zone: every grid-snapped centre within the radius, at each allowed direction, that passes the
// single-placement spatial checks and does not collide with a fixed placement. At most PROPOSAL_MAX_ZONE_CANDIDATES are kept,
// the nearest to the zone centre first.
function zone_candidates(actor: ControlledActor, slot: ProposalSlot, fixed_footprints: PlannedFootprint[]) {
  const reasons: Record<string, number> = {}
  const candidates: Candidate[] = []
  const low_x = math.floor(slot.x - slot.radius) - 1
  const high_x = math.ceil(slot.x + slot.radius) + 1
  const low_y = math.floor(slot.y - slot.radius) - 1
  const high_y = math.ceil(slot.y + slot.radius) + 1
  const limit = slot.radius * slot.radius + ZONE_EPSILON
  for (const direction of slot.directions) {
    for (let iy = low_y; iy <= high_y; iy++) {
      for (let ix = low_x; ix <= high_x; ix++) {
        const snapped = planned_placement_footprint(slot.entity_name, ix, iy, direction)
        if (!snapped) {
          // No footprint for this entity: say why with the same check validation applies.
          const unknown = check_single_placement(actor, { entity_name: slot.entity_name, x: ix, y: iy, direction, slot: slot.slot }, slot.index, false)
          return { error: { ...(unknown.ok ? { code: 'PLANNED_FOOTPRINT_UNKNOWN', message: `slot ${slot.slot} has no footprint to propose` } : unknown.error), slot: slot.slot } }
        }
        const distance_squared = (snapped.position.x - slot.x) ** 2 + (snapped.position.y - slot.y) ** 2
        if (distance_squared > limit) continue
        const checked = check_single_placement(actor, { entity_name: slot.entity_name, x: snapped.position.x, y: snapped.position.y, direction, slot: slot.slot }, slot.index, false)
        if (!checked.ok) {
          const code = checked.error.code
          // These do not depend on the cell: no position in the zone can help.
          if (code === 'PLACEMENT_ITEM_UNSUPPORTED' || code === 'PLACEMENT_CANDIDATE_REQUIRED') return { error: { ...checked.error, slot: slot.slot } }
          bump(reasons, reason_of(code))
          continue
        }
        let blocked = false
        for (const fixed of fixed_footprints) if (footprints_conflict(checked.footprint, fixed)) blocked = true
        if (blocked) {
          bump(reasons, 'fixed_collision')
          continue
        }
        candidates.push({ x: checked.footprint.position.x, y: checked.footprint.position.y, direction, distance_squared, footprint: checked.footprint })
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.distance_squared !== b.distance_squared) return a.distance_squared < b.distance_squared ? -1 : 1
    if (a.y !== b.y) return a.y < b.y ? -1 : 1
    if (a.x !== b.x) return a.x < b.x ? -1 : 1
    return a.direction - b.direction
  })
  const truncated = candidates.length > PROPOSAL_MAX_ZONE_CANDIDATES
  while (candidates.length > PROPOSAL_MAX_ZONE_CANDIDATES) candidates.pop()
  return { candidates, truncated, reasons }
}

// The mismatch code of a connection from the endpoints known so far, or undefined when it holds, cannot be predicted, or still
// depends on an endpoint that is not assigned. With every endpoint known this is the full geometric proof; an inserter with
// some endpoints missing is checked against the ones it has.
function connection_mismatch(connection: LayoutConnection, slot_views: Record<string, EndpointView | undefined>, unit_views: Record<number, EndpointView | undefined>) {
  const views: Record<string, EndpointView | undefined> = {}
  let complete = true
  for (const role of roles_of(connection)) {
    const endpoint = connection.endpoints[role]
    const view = endpoint.slot !== undefined ? slot_views[endpoint.slot] : unit_views[endpoint.unit_number!]
    views[role] = view
    if (view === undefined) complete = false
  }
  if (!complete) return connection.kind === 'inserter' ? inserter_partial_mismatch(views) : undefined
  const proof = prove_connection(connection, views)
  if (proof.status !== 'mismatch') return undefined
  return proof.code ?? 'CONNECTION_GEOMETRY_MISMATCH'
}

export function propose_construction_layout(actor: ControlledActor, request: LayoutProposalRequest) {
  const normalized = normalize_proposal(request)
  if (!normalized.ok) return normalized
  const slots = normalized.slots
  const connections = normalized.connections
  const max_alternatives = normalized.max_alternatives
  const fixed_slots: string[] = []
  const zoned_slots: string[] = []
  for (const slot of slots) (slot.fixed ? fixed_slots : zoned_slots).push(slot.slot)

  // Fixed placements: each alone, then against each other. A fixed placement that does not hold is refused as it is.
  const fixed_footprints: PlannedFootprint[] = []
  const fixed_views: Record<string, EndpointView | undefined> = {}
  for (const slot of slots) {
    if (!slot.fixed) continue
    const checked = check_single_placement(actor, { entity_name: slot.entity_name, x: slot.x, y: slot.y, direction: slot.direction, slot: slot.slot }, slot.index, true)
    if (!checked.ok) return { ok: false, error: { ...checked.error, fixed: true, slot: slot.slot } }
    for (let earlier = 0; earlier < fixed_footprints.length; earlier++) {
      if (!footprints_conflict(checked.footprint, fixed_footprints[earlier])) continue
      return refusal('PLANNED_COLLISION', `fixed placements ${fixed_slots[earlier]} and ${slot.slot} overlap`, { fixed: true, slots: [fixed_slots[earlier], slot.slot] })
    }
    fixed_footprints.push(checked.footprint)
    fixed_views[slot.slot] = planned_view(slot.entity_name, checked.footprint)
  }

  // Existing entities named by unit_number are fixed endpoints too: resolve them once.
  const unit_views: Record<number, EndpointView | undefined> = {}
  for (const connection of connections) {
    for (const role of roles_of(connection)) {
      const endpoint = connection.endpoints[role]
      if (endpoint.unit_number === undefined) continue
      const view = resolve_existing_view(actor, endpoint.unit_number)
      if (view === undefined) {
        return refusal('CONNECTION_ENDPOINT_UNAVAILABLE', `connection ${connection.index}: ${role} ${endpoint.unit_number} is not an existing entity of this surface and force`, { index: connection.index, kind: connection.kind, role, unit_number: endpoint.unit_number })
      }
      unit_views[endpoint.unit_number] = view
    }
  }

  // Zone candidates, then the most constrained zoned slot first (ties by plan index).
  const candidate_lists: Record<string, Candidate[]> = {}
  let zone_truncated: Record<string, boolean> | undefined
  for (const slot of slots) {
    if (slot.fixed) continue
    const found = zone_candidates(actor, slot, fixed_footprints)
    if ('error' in found) return { ok: false, error: found.error }
    if (found.candidates.length === 0) {
      return refusal('ZONE_EXHAUSTED', `no position inside the zone of ${slot.slot} passes the native placement checks`, { slot: slot.slot, reasons: found.reasons })
    }
    candidate_lists[slot.slot] = found.candidates
    if (found.truncated) {
      zone_truncated = zone_truncated ?? {}
      zone_truncated[slot.slot] = true
    }
  }
  const order: ProposalSlot[] = []
  for (const slot of slots) if (!slot.fixed) order.push(slot)
  order.sort((a, b) => {
    const left = candidate_lists[a.slot].length
    const right = candidate_lists[b.slot].length
    if (left !== right) return left - right
    return a.index - b.index
  })

  // A connection is checked after every assignment of a zoned slot it names (the full proof once its last slot is assigned,
  // an inserter's known endpoints before that), and once up front against the fixed placements and existing entities alone.
  const depth_of: Record<string, number> = {}
  for (let depth = 0; depth < order.length; depth++) depth_of[order[depth].slot] = depth
  const checks_at: LayoutConnection[][] = []
  for (let depth = 0; depth < order.length; depth++) checks_at.push([])
  const pruned: Record<string, number> = {}
  let fixed_connection_fails = false
  for (const connection of connections) {
    const mismatch = connection_mismatch(connection, fixed_views, unit_views)
    if (mismatch !== undefined) {
      bump(pruned, `connection_mismatch:${mismatch}`)
      fixed_connection_fails = true
    }
    for (const role of roles_of(connection)) {
      const slot = connection.endpoints[role].slot
      if (slot !== undefined && depth_of[slot] !== undefined && !checks_at[depth_of[slot]].includes(connection)) checks_at[depth_of[slot]].push(connection)
    }
  }

  let evaluated = 0
  let budget_exhausted = false
  let stopped = fixed_connection_fails
  const found: Found[] = []
  const chosen: Record<string, Candidate> = {}
  const slot_views: Record<string, EndpointView | undefined> = { ...fixed_views }
  const assigned: PlannedFootprint[] = [...fixed_footprints]

  // One more evaluated combination, unless the budget is spent.
  function spend() {
    if (evaluated >= PROPOSAL_EVALUATION_BUDGET) {
      budget_exhausted = true
      stopped = true
      return false
    }
    evaluated++
    return true
  }

  function complete() {
    if (!spend()) return
    const plan = slots.map((slot) => {
      if (slot.fixed) return { entity_name: slot.entity_name, x: slot.x, y: slot.y, direction: slot.direction, slot: slot.slot }
      const candidate = chosen[slot.slot]
      return { entity_name: slot.entity_name, x: candidate.x, y: candidate.y, direction: candidate.direction, slot: slot.slot }
    })
    const evaluation = evaluate_plan(actor, plan, connections)
    if (evaluation.planning_status !== 'spatially_valid') {
      bump(pruned, `full_check:${reason_of(evaluation.error?.code)}`)
      return
    }
    let score = 0
    const placements: Array<Record<string, unknown>> = []
    const keys: Array<{ y: number, x: number, direction: number }> = []
    for (const slot of slots) {
      if (slot.fixed) {
        const out: Record<string, unknown> = { entity_name: slot.entity_name, slot: slot.slot, x: slot.x, y: slot.y }
        if (slot.direction !== undefined) out.direction = slot.direction
        out.fixed = true
        placements.push(out)
        continue
      }
      const candidate = chosen[slot.slot]
      const distance = math.sqrt(candidate.distance_squared)
      score += math.floor(distance * DISTANCE_SCALE + 0.5)
      placements.push({ entity_name: slot.entity_name, slot: slot.slot, x: candidate.x, y: candidate.y, direction: candidate.direction, fixed: false, zone_distance: round2(distance) })
      keys.push({ y: candidate.y, x: candidate.x, direction: candidate.direction })
    }
    found.push({
      placements,
      planning_status: evaluation.planning_status,
      execution_eligible: evaluation.execution_eligible,
      eligibility_blockers: evaluation.eligibility_blockers,
      connections: (evaluation.connections ?? []).map(proof => ({ index: proof.index, kind: proof.kind, virtual_proof: proof.virtual_proof })),
      score,
      keys,
    })
    if (found.length >= max_alternatives) stopped = true
  }

  function descend(depth: number) {
    if (depth >= order.length) {
      complete()
      return
    }
    const slot = order[depth]
    const candidates = candidate_lists[slot.slot]
    for (let i = 0; i < candidates.length; i++) {
      if (stopped) return
      if (!spend()) return
      const candidate = candidates[i]
      let collides = false
      for (const other of assigned) if (footprints_conflict(candidate.footprint, other)) collides = true
      if (collides) {
        bump(pruned, 'joint_collision')
        continue
      }
      chosen[slot.slot] = candidate
      slot_views[slot.slot] = planned_view(slot.entity_name, candidate.footprint)
      assigned.push(candidate.footprint)
      let mismatch: string | undefined
      for (const connection of checks_at[depth]) {
        mismatch = connection_mismatch(connection, slot_views, unit_views)
        if (mismatch !== undefined) break
      }
      if (mismatch !== undefined) bump(pruned, `connection_mismatch:${mismatch}`)
      else descend(depth + 1)
      assigned.pop()
      delete slot_views[slot.slot]
      delete chosen[slot.slot]
    }
  }
  if (!stopped) descend(0)

  if (found.length === 0) {
    return refusal('NO_LAYOUT_ALTERNATIVE', 'no assignment of the zoned slots inside their zones keeps every fixed placement and connection', {
      evaluated,
      budget: PROPOSAL_EVALUATION_BUDGET,
      budget_exhausted,
      pruned,
      ...(zone_truncated !== undefined ? { zone_truncated } : {}),
    })
  }

  // Eligible alternatives first, then the nearest to the zone centres, then a fixed lexicographic order.
  found.sort((a, b) => {
    if (a.execution_eligible !== b.execution_eligible) return a.execution_eligible ? -1 : 1
    if (a.score !== b.score) return a.score < b.score ? -1 : 1
    for (let i = 0; i < a.keys.length; i++) {
      if (a.keys[i].y !== b.keys[i].y) return a.keys[i].y < b.keys[i].y ? -1 : 1
      if (a.keys[i].x !== b.keys[i].x) return a.keys[i].x < b.keys[i].x ? -1 : 1
      if (a.keys[i].direction !== b.keys[i].direction) return a.keys[i].direction < b.keys[i].direction ? -1 : 1
    }
    return 0
  })

  // Fail closed: every zoned position is inside its zone and every fixed one is exactly as requested, whatever the search did.
  const alternatives: Array<Record<string, unknown>> = []
  for (let i = 0; i < found.length; i++) {
    const alternative = found[i]
    for (let j = 0; j < slots.length; j++) {
      const slot = slots[j]
      const placement = alternative.placements[j] as { x: number, y: number, direction?: number }
      if (slot.fixed) {
        if (placement.x !== slot.x || placement.y !== slot.y || placement.direction !== slot.direction) {
          return refusal('INTERNAL_FIXED_VIOLATION', `slot ${slot.slot} left its fixed position`, { slot: slot.slot })
        }
      }
      else if ((placement.x - slot.x) ** 2 + (placement.y - slot.y) ** 2 > slot.radius * slot.radius + ZONE_EPSILON) {
        return refusal('INTERNAL_ZONE_VIOLATION', `slot ${slot.slot} left its zone`, { slot: slot.slot })
      }
    }
    alternatives.push({
      id: `alt-${i + 1}`,
      placements: alternative.placements,
      planning_status: alternative.planning_status,
      execution_eligible: alternative.execution_eligible,
      eligibility_blockers: alternative.eligibility_blockers,
      connections: alternative.connections,
    })
  }

  return {
    ok: true,
    alternatives,
    evaluated,
    budget: PROPOSAL_EVALUATION_BUDGET,
    budget_exhausted,
    zone_truncated,
    fixed_slots,
    zoned_slots,
  }
}
