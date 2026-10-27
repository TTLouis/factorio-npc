import { reservation_intersection } from './area_reservations'
import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import type { LayoutConnection, LayoutConnectionInput } from './construction_layout'
import { batch_identity, begin_layout_execution, bind_layout_execution, create_layout_record, discard_layout_record, layout_record, layout_resume_problem, normalize_connections, open_task_batch, overlaps, plan_execution_order, plan_layout_remainder, prove_plan_connections, rollback_layout_execution, settle_construction_layout, valid_slot_name } from './construction_layout'
import { local_spatial_observation, prototype_spatial_geometry } from './construction_planning'
import { execute_prepared_remote_construction_plan, is_prepared_remote_construction_plan } from './map_construction'
import { placement_check_args } from './placement_geometry'
import { planned_placement_footprint, prototype_fluidbox_count } from './placement_preflight'
import { resolve_entity_placement_item } from './placement_item'
import type { new_task_manager } from './task_manager'

type BasicController = ReturnType<typeof new_basic_operation_controller>
type TaskManager = ReturnType<typeof new_task_manager>

type Position = { x: number, y: number }
type WorldBox = { left_top: Position, right_bottom: Position }

export interface ConstructionExecutionPlacement {
  entity_name: string
  x: number
  y: number
  direction?: number
  /** Names this placement inside the plan so a connection can refer to it (1..40 chars of a-z, 0-9, _ and -; unique). */
  slot?: string
}

export interface ConstructionExecutionValidationRequest {
  plan_id: string
  placements: ConstructionExecutionPlacement[]
  /** Typed links between the plan's placements (and existing entities): at most 8, and then at most 6 placements. */
  connections?: LayoutConnectionInput[]
}

interface StoredConstructionPlan {
  validation_id: number
  plan_id: string
  actor_id: number
  surface_index: number
  force_index: number
  created_tick: number
  placements: ConstructionExecutionPlacement[]
  connections?: LayoutConnection[]
  /**
   * Set when the token validates only the unplaced remainder of an existing layout (resume_construction_layout): that layout,
   * and for each placement the index of the layout node it stands for. Executing it continues the same layout record.
   */
  resume_layout_id?: number
  resume_node_indices?: number[]
}

declare const storage: {
  sgluna_validated_construction_plan?: StoredConstructionPlan
  sgluna_next_construction_validation_id?: number
}

const MAX_PLACEMENTS = 16
const MAX_PLAN_ID = 200
const MAX_COORDINATE = 1000000
const MAX_LOCAL_DISTANCE = 10
const VALIDATION_MAX_AGE_TICKS = 60 * 60

// Execution builds every placement at its grid-snapped centre (basic_operation_runtime snaps the task position), and the
// footprint geometry rotates cardinally, so a plan accepts only the four cardinal directions.
const CARDINAL_DIRECTIONS = [0, 4, 8, 12]

type PlannedFootprint = NonNullable<ReturnType<typeof planned_placement_footprint>>

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -MAX_COORDINATE && value <= MAX_COORDINATE
}

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function overlap_box(a: WorldBox, b: WorldBox): WorldBox {
  return {
    left_top: {
      x: math.max(a.left_top.x, b.left_top.x),
      y: math.max(a.left_top.y, b.left_top.y),
    },
    right_bottom: {
      x: math.min(a.right_bottom.x, b.right_bottom.x),
      y: math.min(a.right_bottom.y, b.right_bottom.y),
    },
  }
}

// Whether two planned footprints may not share space: the rule batch-footprint.mjs applies to one batch's placements.
// Unreadable collision layers count as colliding, so a joint proof never rests on what could not be read.
function footprints_collide(a: PlannedFootprint, b: PlannedFootprint) {
  if (a.colliding_with_tiles_only === true || b.colliding_with_tiles_only === true) return false
  if (a.entity_name === b.entity_name && a.not_colliding_with_itself === true) return false
  if (a.collision_unknown === true || b.collision_unknown === true) return true
  return a.collision_layers.some(layer => b.collision_layers.includes(layer))
}

function placement_geometry(placement: ConstructionExecutionPlacement, index: number, footprint: PlannedFootprint | undefined) {
  return {
    index,
    slot: placement.slot,
    entity_name: placement.entity_name,
    position: { x: placement.x, y: placement.y },
    // The centre execution builds at, and the collision box there.
    planned_position: footprint?.position,
    direction: placement.direction,
    prototype: prototype_spatial_geometry(placement.entity_name),
    world_collision_box: footprint?.world_box,
  }
}

function inventory_counts(actor: ControlledActor) {
  const inventory = actor.get_main_inventory()
  if (!inventory) return undefined
  const counts: Record<string, number> = {}
  for (const item of inventory.get_contents()) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count
  }
  return counts
}

function normalize_request(request: ConstructionExecutionValidationRequest) {
  if (!request || typeof request.plan_id !== 'string' || request.plan_id.length < 1 || request.plan_id.length > MAX_PLAN_ID) {
    return { error: { code: 'INVALID_REQUEST', message: 'plan_id is required and must be at most 200 characters' } }
  }
  if (!Array.isArray(request.placements) || request.placements.length < 1 || request.placements.length > MAX_PLACEMENTS) {
    return { error: { code: 'INVALID_REQUEST', message: `placements must contain between 1 and ${MAX_PLACEMENTS} entries` } }
  }

  const placements: ConstructionExecutionPlacement[] = []
  const slots: Record<string, boolean> = {}
  for (let index = 0; index < request.placements.length; index++) {
    const placement = request.placements[index]
    if (!placement || typeof placement.entity_name !== 'string' || placement.entity_name.length < 1 || placement.entity_name.length > 200) {
      return { error: { code: 'INVALID_PLACEMENT', message: `placement ${index} has an invalid entity_name`, index } }
    }
    if (!valid_coordinate(placement.x) || !valid_coordinate(placement.y)) {
      return { error: { code: 'INVALID_PLACEMENT', message: `placement ${index} has invalid coordinates`, index } }
    }
    if (placement.direction !== undefined && (!valid_integer(placement.direction, 0, 15) || !CARDINAL_DIRECTIONS.includes(placement.direction))) {
      return { error: { code: 'INVALID_PLACEMENT', message: `placement ${index} has invalid direction (a construction plan takes 0, 4, 8 or 12)`, index } }
    }
    if (placement.slot !== undefined) {
      if (!valid_slot_name(placement.slot)) {
        return { error: { code: 'INVALID_PLACEMENT', message: `placement ${index} has an invalid slot (1..40 characters of a-z, 0-9, _ and -)`, index } }
      }
      if (slots[placement.slot]) {
        return { error: { code: 'INVALID_CONNECTION', message: `placement ${index} repeats slot ${placement.slot}`, slot: placement.slot, placement_index: index } }
      }
      slots[placement.slot] = true
    }
    placements.push({
      entity_name: placement.entity_name,
      x: placement.x,
      y: placement.y,
      direction: placement.direction,
      slot: placement.slot,
    })
  }
  const normalized = normalize_connections(request.connections, placements)
  if ('error' in normalized) return { error: normalized.error }
  return { placements, connections: normalized.connections! }
}

// Two phases. The spatial (planning) phase answers whether the layout fits the world and its connections are geometrically
// consistent: a failure there is `spatially_invalid` with the first error. Only a spatially valid layout is then asked
// whether it can run now (the eligibility phase): stock, local reach, and connections that cannot be proved before their
// entities stand. Every eligibility blocker is collected, `error` is the first, and no token is ever stored for them.
interface PlanEvaluation {
  ok: boolean
  planning_status: 'spatially_invalid' | 'spatially_valid'
  execution_eligible: boolean
  /** The spatial failure, or the first eligibility blocker. */
  error?: Record<string, unknown>
  eligibility_blockers?: Array<Record<string, unknown>>
  placement_geometry?: Array<Record<string, unknown>>
  planned_footprints?: PlannedFootprint[]
  execution_order?: number[]
  connections?: Array<Record<string, unknown>>
}

function evaluate_plan(actor: ControlledActor, placements: ConstructionExecutionPlacement[], connections: LayoutConnection[]): PlanEvaluation {
  const spatial_failure = (error: Record<string, unknown>): PlanEvaluation => ({ ok: false, planning_status: 'spatially_invalid', execution_eligible: false, error })

  const required: Record<string, number> = {}
  const footprints: PlannedFootprint[] = []
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index]
    if (prototypes.entity[placement.entity_name]?.type === 'offshore-pump') return spatial_failure({
      code: 'PLACEMENT_CANDIDATE_REQUIRED', message: 'Offshore pumps require water-first discovery and place_candidate with live native registry ids', index,
    })
    const placement_item = resolve_entity_placement_item(placement.entity_name)
    if (!placement_item.ok) {
      return spatial_failure({
        code: 'PLACEMENT_ITEM_UNSUPPORTED',
        message: `cannot resolve placement item for entity ${placement.entity_name}: ${placement_item.code}`,
        index,
        entity_name: placement.entity_name,
        placement_item_error: placement_item.code,
        item_name: placement_item.item_name,
      })
    }
    const position = { x: placement.x, y: placement.y }
    const footprint = planned_placement_footprint(placement.entity_name, placement.x, placement.y, placement.direction)
    if (!footprint) return spatial_failure({ code: 'PLANNED_FOOTPRINT_UNKNOWN', message: `placement ${index} has no footprint to check against the rest of the plan`, index })
    if (reservation_intersection(actor.surface, footprint.world_box)) return spatial_failure({ code: 'NPC_AREA_RESERVED', message: 'placement overlaps an NPC reserved site', index })
    if (!actor.surface.can_place_entity({
      name: placement.entity_name,
      position,
      direction: placement.direction,
      force: actor.force,
      ...placement_check_args(placement.entity_name),
    })) {
      return spatial_failure({
        code: 'WORLD_COLLISION',
        message: `placement ${index} is not placeable in the current world`,
        index,
        placement: placement_geometry(placement, index, footprint),
        spatial_context: local_spatial_observation(actor, {
          position,
          half_size: 4,
          requested_entity_name: placement.entity_name,
        }),
      })
    }
    const requirement = placement_item.requirement
    required[requirement.item_name] = (required[requirement.item_name] ?? 0) + requirement.count
    footprints.push(footprint)
  }

  // The joint proof: each placement above was checked alone against the world as it is now, which says nothing about the
  // plan's other placements. Compare the footprints execution will build (grid-snapped centres, collision boxes and
  // layers from the prototypes), so a plan whose placements are each legal but collide with each other is refused here,
  // before anything is built.
  for (let left = 0; left < footprints.length; left++) {
    const left_footprint = footprints[left]
    for (let right = left + 1; right < footprints.length; right++) {
      const right_footprint = footprints[right]
      if (!footprints_collide(left_footprint, right_footprint) || !overlaps(left_footprint.world_box, right_footprint.world_box)) continue
      return spatial_failure({
        code: 'PLANNED_COLLISION',
        message: `placements ${left} and ${right} overlap before construction begins`,
        indices: [left, right],
        placements: [
          placement_geometry(placements[left], left, left_footprint),
          placement_geometry(placements[right], right, right_footprint),
        ],
        overlap_box: overlap_box(left_footprint.world_box, right_footprint.world_box),
      })
    }
  }

  // The virtual proof of the typed connections, still before anything is built: planned footprints and the live boxes of
  // existing endpoints. A connection that cannot hold is a spatial failure; one that cannot be predicted is an eligibility
  // matter below.
  const proved = prove_plan_connections(actor, placements, footprints, connections)
  if ('error' in proved) return spatial_failure(proved.error!)
  const ordering = plan_execution_order(placements, connections)
  if (ordering.cycle !== undefined) {
    return spatial_failure({
      code: 'LAYOUT_DEPENDENCY_CYCLE',
      message: `placements ${ordering.cycle.join(', ')} depend on each other through the layout connections`,
      indices: ordering.cycle,
    })
  }

  const blockers: Array<Record<string, unknown>> = []
  const counts = inventory_counts(actor)
  if (!counts) {
    blockers.push({ code: 'NO_INVENTORY', message: 'controlled actor inventory is unavailable' })
  }
  else {
    const item_names: string[] = []
    for (const item_name in required) item_names.push(item_name)
    item_names.sort()
    for (const item_name of item_names) {
      const needed = required[item_name] ?? 0
      if ((counts[item_name] ?? 0) < needed) {
        blockers.push({
          code: 'ITEMS_MISSING',
          message: `construction plan requires ${needed} ${item_name} but only ${counts[item_name] ?? 0} are available`,
          item_name,
          required_count: needed,
          available_count: counts[item_name] ?? 0,
        })
      }
    }
  }
  for (let index = 0; index < placements.length; index++) {
    const distance = math.sqrt(squared_distance(actor.position, { x: placements[index].x, y: placements[index].y }))
    if (distance > MAX_LOCAL_DISTANCE) {
      blockers.push({
        code: 'OUTSIDE_LOCAL_BUILD_REACH',
        message: `placement ${index} is farther than ${MAX_LOCAL_DISTANCE} tiles from the actor`,
        index,
        distance: math.floor(distance * 100 + 0.5) / 100,
        route: 'unproven',
      })
    }
  }
  for (const unproven of proved.unproven) blockers.push(unproven)

  const planned: PlanEvaluation = {
    ok: true,
    planning_status: 'spatially_valid',
    execution_eligible: true,
    placement_geometry: placements.map((placement, index) => placement_geometry(placement, index, footprints[index])),
    planned_footprints: footprints,
    execution_order: ordering.order,
    connections: proved.proofs,
  }
  if (blockers.length > 0) return { ...planned, ok: false, execution_eligible: false, eligibility_blockers: blockers, error: blockers[0] }
  return planned
}

export function validate_construction_execution_plan(actor: ControlledActor, request: ConstructionExecutionValidationRequest) {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return { ok: false, error: { code: 'ACTOR_UNAVAILABLE', message: 'controlled actor has no stable identity' } }
  }
  const normalized = normalize_request(request)
  if ('error' in normalized) return { ok: false, error: normalized.error }
  const placements = normalized.placements!
  const connections = normalized.connections!
  const evaluation = evaluate_plan(actor, placements, connections)
  if (!evaluation.ok) {
    // The planning status is separate from execution eligibility: a spatially valid layout that cannot run yet still
    // carries its geometry, order and connection proofs, and no token.
    return {
      ok: false,
      planning_status: evaluation.planning_status,
      execution_eligible: false,
      error: evaluation.error,
      eligibility_blockers: evaluation.eligibility_blockers,
      placement_geometry: evaluation.placement_geometry,
      execution_order: evaluation.execution_order,
      connections: evaluation.connections,
    }
  }

  const validation_id = (storage.sgluna_next_construction_validation_id ?? 0) + 1
  storage.sgluna_next_construction_validation_id = validation_id
  storage.sgluna_validated_construction_plan = {
    validation_id,
    plan_id: request.plan_id,
    actor_id: identity.actor_id,
    surface_index: actor.surface.index,
    force_index: actor.force.index,
    created_tick: game.tick,
    placements,
    connections: connections.length > 0 ? connections : undefined,
  }

  return {
    ok: true,
    planning_status: evaluation.planning_status,
    execution_eligible: true,
    validation_id,
    plan_id: request.plan_id,
    placement_count: placements.length,
    created_tick: game.tick,
    expires_tick: game.tick + VALIDATION_MAX_AGE_TICKS,
    placements,
    placement_geometry: evaluation.placement_geometry,
    execution_order: evaluation.execution_order,
    connections: connections.length > 0 ? evaluation.connections : undefined,
  }
}

// Why a token that validated a layout's remainder no longer applies, or undefined (also for a token that is not a resume
// token). Read-only: the layout must still be the one the token was made for, settled, unplaced exactly where validated, and
// within its allowance.
function resume_token_problem(plan: StoredConstructionPlan) {
  if (plan.resume_layout_id === undefined) return undefined
  const record = layout_record(plan.resume_layout_id)
  if (!record) return { code: 'LAYOUT_UNAVAILABLE', message: `construction layout ${plan.resume_layout_id} is no longer recorded` }
  if (record.actor_id !== plan.actor_id || record.surface_index !== plan.surface_index || record.force_index !== plan.force_index) {
    return { code: 'LAYOUT_SCOPE_MISMATCH', message: `construction layout ${record.layout_id} belongs to another actor, surface or force` }
  }
  return layout_resume_problem(record, plan.resume_node_indices ?? [], open_task_batch())
}

// Validates ONLY the unplaced remainder of a recorded layout, so a layout cancelled or interrupted after some of its nodes were
// built continues from what is proven instead of being replayed. The layout is settled first (a read of the engine and the
// task manager, never of the model). Each remainder node keeps the exact geometry it was recorded with; a connection to an
// already placed node refers to that node's entity as an existing endpoint. The same spatial and eligibility phases as
// validate_construction_execution_plan decide the answer, and only an eligible remainder stores a token. Nothing is built,
// and the layout record is not touched except by settlement.
export function resume_construction_layout(actor: ControlledActor, layout_id: unknown) {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return { ok: false, error: { code: 'ACTOR_UNAVAILABLE', message: 'controlled actor has no stable identity' } }
  }
  if (!valid_integer(layout_id as number, 1, 9007199254740991)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'layout_id must be a positive integer' } }
  }
  const record = layout_record(layout_id)
  if (!record) return { ok: false, layout_id, error: { code: 'LAYOUT_UNAVAILABLE', message: `no construction layout ${layout_id} is recorded` } }
  if (record.actor_id !== identity.actor_id || record.surface_index !== actor.surface.index || record.force_index !== actor.force.index) {
    return { ok: false, layout_id, error: { code: 'LAYOUT_SCOPE_MISMATCH', message: `construction layout ${layout_id} belongs to actor ${record.actor_id} on surface ${record.surface_index} and force ${record.force_index}` } }
  }
  const active_batch = open_task_batch()
  settle_construction_layout(record, { actor, active_batch })
  const problem = layout_resume_problem(record, undefined, active_batch)
  if (problem) return { ok: false, layout_id, layout_state: record.state, error: problem }

  const remainder = plan_layout_remainder(record)
  if ('error' in remainder) return { ok: false, layout_id, layout_state: record.state, error: remainder.error }
  const placements = remainder.placements!
  if (placements.length === 0) {
    return { ok: false, layout_id, layout_state: record.state, error: { code: 'LAYOUT_NOTHING_TO_RESUME', message: `construction layout ${layout_id} has no unplaced node to build` } }
  }
  const retained: Array<Record<string, unknown>> = []
  for (const node of remainder.retained!) retained.push({ node_id: node.node_id, entity_name: node.entity_name, unit_number: node.unit_number })
  const remainder_ids: string[] = []
  for (const node of remainder.remainder!) remainder_ids.push(node.node_id)
  const evaluation = evaluate_plan(actor, placements, remainder.connections!)
  if (!evaluation.ok) {
    return {
      ok: false,
      layout_id,
      plan_id: record.plan_id,
      planning_status: evaluation.planning_status,
      execution_eligible: false,
      error: evaluation.error,
      eligibility_blockers: evaluation.eligibility_blockers,
      placement_geometry: evaluation.placement_geometry,
      execution_order: evaluation.execution_order,
      connections: evaluation.connections,
      retained,
      remainder: remainder_ids,
    }
  }

  const validation_id = (storage.sgluna_next_construction_validation_id ?? 0) + 1
  storage.sgluna_next_construction_validation_id = validation_id
  storage.sgluna_validated_construction_plan = {
    validation_id,
    plan_id: record.plan_id,
    actor_id: identity.actor_id,
    surface_index: actor.surface.index,
    force_index: actor.force.index,
    created_tick: game.tick,
    placements,
    connections: remainder.connections!.length > 0 ? remainder.connections : undefined,
    resume_layout_id: record.layout_id,
    resume_node_indices: remainder.node_indices,
  }
  return {
    ok: true,
    layout_id: record.layout_id,
    planning_status: evaluation.planning_status,
    execution_eligible: true,
    validation_id,
    plan_id: record.plan_id,
    placement_count: placements.length,
    created_tick: game.tick,
    expires_tick: game.tick + VALIDATION_MAX_AGE_TICKS,
    executions_used: record.executions_used,
    executions_max: record.executions_max,
    retained,
    remainder: remainder_ids,
    placements,
    placement_geometry: evaluation.placement_geometry,
    execution_order: evaluation.execution_order,
    connections: evaluation.connections,
  }
}

// Read-only witness for the fluid-preservation admission seam: it resolves the exact stored LOCAL validated plan that
// `execute_validated_construction_plan` would run for (validation_id, placement_count) and proves every effect that matters
// to a protected fluid plant. It never writes storage, clears, reserves or queues anything. Execution repeats every check.
//
// ok:true always means "execution would not be refused by identity, scope, age or live geometry/stock right now". Only when
// every placement prototype declares zero fluidboxes does it also carry `preservation_nonfluid_output` (a local plan holds
// placements only: no clearing, rotation or removal, so `preservation_clears_count` is 0 by construction). A fluid-bearing
// plan stays ok:true WITHOUT that witness, exactly like a fluid single placement, so the harness treats it as unproven
// and keeps refusing it; the per-placement `fluidbox_count` says why.
export function construction_plan_preflight(actor: ControlledActor | undefined, validation_id: unknown, placement_count: unknown) {
  if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
  if (!valid_integer(validation_id as number, 1, 9007199254740991) || !valid_integer(placement_count as number, 1, MAX_PLACEMENTS)) {
    return { ok: false, code: 'invalid_preflight_args' }
  }
  const id = validation_id as number
  const count = placement_count as number
  // A prepared remote (ghost) plan is a different executor path; this witness does not describe it.
  if (is_prepared_remote_construction_plan(id)) return { ok: false, code: 'construction_plan_remote_unsupported' }
  const plan = storage.sgluna_validated_construction_plan
  if (!plan || plan.validation_id !== id) return { ok: false, code: 'construction_plan_unavailable' }
  if (plan.placements.length !== count) return { ok: false, code: 'construction_plan_count_mismatch' }
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined || identity.actor_id !== plan.actor_id
    || actor.surface.index !== plan.surface_index || actor.force.index !== plan.force_index) {
    return { ok: false, code: 'construction_plan_scope_mismatch' }
  }
  if (game.tick - plan.created_tick > VALIDATION_MAX_AGE_TICKS) return { ok: false, code: 'construction_plan_expired' }
  const resume_problem = resume_token_problem(plan)
  if (resume_problem) return { ok: false, code: 'construction_plan_stale', evaluation_code: resume_problem.code }
  const connections = plan.connections ?? []
  const evaluation = evaluate_plan(actor, plan.placements, connections)
  if (!evaluation.ok) return { ok: false, code: 'construction_plan_stale', evaluation_code: evaluation.error?.code }

  // `position` is the entity centre the engine uses (the grid snap a coordinate place_entity's planned_footprint uses), so the
  // runtime tests committed areas against resolved geometry rather than the requested coordinates. `planned_footprint` is
  // the same record a coordinate place_entity's preflight carries, so the runtime compares the plan's placements with the
  // rest of the batch. The rows stay in plan index order (the runtime compares them by index); a connected layout also
  // carries each row's `execution_rank`, the position at which execution builds it.
  const construction_placements: Array<{ entity_name: string, x: number, y: number, direction: number, position: { x: number, y: number }, planned_footprint: PlannedFootprint, fluidbox_count: number, execution_rank?: number }> = []
  const execution_ranks: number[] = []
  for (let index = 0; index < plan.placements.length; index++) execution_ranks.push(0)
  const execution_order = evaluation.execution_order ?? []
  for (let rank = 0; rank < execution_order.length; rank++) execution_ranks[execution_order[rank]] = rank
  const entity_names: string[] = []
  let fluidbox_total = 0
  const planned_footprints = evaluation.planned_footprints ?? []
  for (let index = 0; index < plan.placements.length; index++) {
    const placement = plan.placements[index]
    const footprint = planned_footprints[index]
    if (!footprint) return { ok: false, code: 'construction_plan_stale', evaluation_code: 'PLANNED_FOOTPRINT_UNKNOWN' }
    const fluidbox_count = prototype_fluidbox_count(placement.entity_name)
    fluidbox_total += fluidbox_count
    entity_names.push(placement.entity_name)
    construction_placements.push({
      entity_name: placement.entity_name,
      x: placement.x,
      y: placement.y,
      direction: placement.direction ?? 0,
      position: footprint.position,
      planned_footprint: footprint,
      fluidbox_count,
      ...(connections.length > 0 ? { execution_rank: execution_ranks[index] } : {}),
    })
  }
  return {
    ok: true,
    validation_id: id,
    plan_id: plan.plan_id,
    placement_count: count,
    created_tick: plan.created_tick,
    expires_tick: plan.created_tick + VALIDATION_MAX_AGE_TICKS,
    preservation_clears_count: 0,
    // True at execution, not only now: execute_validated_construction_plan queues every placement with refuse_clearance, so a
    // blocker or ground item that appears later fails the placing task before any mutation.
    execution_clearance: 'refused',
    construction_placements,
    ...(fluidbox_total === 0
      ? {
          preservation_nonfluid_output: {
            version: 1,
            actor_id: plan.actor_id,
            surface_index: plan.surface_index,
            force_index: plan.force_index,
            validation_id: id,
            placement_count: count,
            entity_names,
            execution_clearance: 'refused',
            fluid_port_count: 0,
          },
        }
      : {}),
  }
}

export function execute_validated_construction_plan(
  actor: ControlledActor,
  validation_id: number,
  placement_count: number,
  basic: BasicController,
  manager: TaskManager,
): [boolean, string] {
  if (!valid_integer(validation_id, 1, 9007199254740991) || !valid_integer(placement_count, 1, MAX_PLACEMENTS)) {
    return [false, 'invalid construction validation identity or placement count']
  }
  const remote = execute_prepared_remote_construction_plan(actor, validation_id, placement_count)
  if (remote) return remote
  const plan = storage.sgluna_validated_construction_plan
  if (!plan || plan.validation_id !== validation_id) return [false, 'validated construction plan is unavailable or superseded']
  if (plan.placements.length !== placement_count) return [false, 'construction placement count does not match validated plan']

  const identity = actor.status_snapshot()
  if (identity.actor_id !== plan.actor_id || actor.surface.index !== plan.surface_index || actor.force.index !== plan.force_index) {
    storage.sgluna_validated_construction_plan = undefined
    return [false, 'validated construction plan belongs to a different actor, surface, or force']
  }
  if (game.tick - plan.created_tick > VALIDATION_MAX_AGE_TICKS) {
    storage.sgluna_validated_construction_plan = undefined
    return [false, 'validated construction plan expired; validate the live world again']
  }

  // A token that validated a layout's remainder continues that layout, and only while the layout is still exactly what it was
  // validated against: settled (its last execution is over), unplaced where validated, and within its allowance. Expiry or
  // staleness of the token never touches the layout record.
  const resume_record = plan.resume_layout_id !== undefined ? layout_record(plan.resume_layout_id) : undefined
  if (plan.resume_layout_id !== undefined) {
    if (resume_record) settle_construction_layout(resume_record, { actor, active_batch: batch_identity(manager.get_status_snapshot().active_batch) })
    const problem = resume_token_problem(plan)
    if (problem) {
      storage.sgluna_validated_construction_plan = undefined
      return [false, `validated construction plan is stale: ${problem.code}: ${problem.message}`]
    }
  }

  const connections = plan.connections ?? []
  const evaluation = evaluate_plan(actor, plan.placements, connections)
  if (!evaluation.ok) {
    storage.sgluna_validated_construction_plan = undefined
    return [false, `validated construction plan became stale: ${evaluation.error?.code ?? 'UNKNOWN'}`]
  }

  // A connected layout is tracked from queueing on: its record exists before the first node can run, and each queued
  // placement carries its node so the runtime can check the connections against the actual entities (see construction_layout).
  // A resume continues its layout's record with the next execution, each placement standing for its original node.
  const execution_order = evaluation.execution_order ?? []
  const node_indices = plan.resume_node_indices
  const node_index = (placement_index: number) => node_indices !== undefined ? node_indices[placement_index] : placement_index
  const layout_id = resume_record !== undefined ? resume_record.layout_id : connections.length > 0 ? validation_id : undefined
  let resumed: ReturnType<typeof begin_layout_execution> | undefined
  if (resume_record !== undefined) {
    resumed = begin_layout_execution(resume_record, execution_order.map(node_index))
  }
  else if (layout_id !== undefined) {
    create_layout_record({
      layout_id,
      plan_id: plan.plan_id,
      actor_id: plan.actor_id,
      surface_index: plan.surface_index,
      force_index: plan.force_index,
      placements: plan.placements,
      footprints: evaluation.planned_footprints ?? [],
      execution_order,
      connections,
    })
  }

  let queued = 0
  for (const index of execution_order) {
    const placement = plan.placements[index]
    // Always placement-only: the task carries refuse_clearance, so nothing is mined or picked up to make room.
    if (!basic.submit_placement(placement.entity_name, placement.x, placement.y, placement.direction, undefined, undefined, undefined, {
      refuse_clearance: true,
      layout_node: layout_id !== undefined ? { layout_id, index: node_index(index) } : undefined,
    })) {
      if (queued > 0) manager.cancel_all_tasks('construction_plan_admission_failed')
      // A new layout was never built: its record is withdrawn. A resumed one keeps its history and goes back to paused.
      if (resumed !== undefined && resume_record !== undefined) rollback_layout_execution(resume_record, resumed)
      else if (layout_id !== undefined) discard_layout_record(layout_id)
      storage.sgluna_validated_construction_plan = undefined
      return [false, `unable to queue placement ${queued + 1}`]
    }
    queued += 1
  }

  // The execution is identified by the task batch its placements joined, so a later read can tell when it is over.
  if (layout_id !== undefined) bind_layout_execution(layout_id, batch_identity(manager.get_status_snapshot().active_batch))
  storage.sgluna_validated_construction_plan = undefined
  return [true, layout_id !== undefined ? `Validated construction plan started (layout_id ${layout_id})` : 'Validated construction plan started']
}
