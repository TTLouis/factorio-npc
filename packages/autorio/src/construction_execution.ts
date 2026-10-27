import { reservation_intersection } from './area_reservations'
import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
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
}

export interface ConstructionExecutionValidationRequest {
  plan_id: string
  placements: ConstructionExecutionPlacement[]
}

interface StoredConstructionPlan {
  validation_id: number
  plan_id: string
  actor_id: number
  surface_index: number
  force_index: number
  created_tick: number
  placements: ConstructionExecutionPlacement[]
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
const OVERLAP_EPSILON = 0.001

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

function overlaps(a: WorldBox, b: WorldBox) {
  return a.left_top.x < b.right_bottom.x - OVERLAP_EPSILON
    && a.right_bottom.x > b.left_top.x + OVERLAP_EPSILON
    && a.left_top.y < b.right_bottom.y - OVERLAP_EPSILON
    && a.right_bottom.y > b.left_top.y + OVERLAP_EPSILON
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
    placements.push({
      entity_name: placement.entity_name,
      x: placement.x,
      y: placement.y,
      direction: placement.direction,
    })
  }
  return { placements }
}

function evaluate_plan(actor: ControlledActor, placements: ConstructionExecutionPlacement[]) {
  const counts = inventory_counts(actor)
  if (!counts) return { ok: false, error: { code: 'NO_INVENTORY', message: 'controlled actor inventory is unavailable' } }

  const required: Record<string, number> = {}
  const footprints: PlannedFootprint[] = []
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index]
    if (prototypes.entity[placement.entity_name]?.type === 'offshore-pump') return { ok: false, error: {
      code: 'PLACEMENT_CANDIDATE_REQUIRED', message: 'Offshore pumps require water-first discovery and place_candidate with live native registry ids', index,
    } }
    const placement_item = resolve_entity_placement_item(placement.entity_name)
    if (!placement_item.ok) {
      return {
        ok: false,
        error: {
          code: 'PLACEMENT_ITEM_UNSUPPORTED',
          message: `cannot resolve placement item for entity ${placement.entity_name}: ${placement_item.code}`,
          index,
          entity_name: placement.entity_name,
          placement_item_error: placement_item.code,
          item_name: placement_item.item_name,
        },
      }
    }
    const position = { x: placement.x, y: placement.y }
    if (squared_distance(actor.position, position) > MAX_LOCAL_DISTANCE ** 2) {
      return { ok: false, error: { code: 'OUTSIDE_LOCAL_BUILD_REACH', message: `placement ${index} is farther than ${MAX_LOCAL_DISTANCE} tiles from the actor`, index } }
    }
    const footprint = planned_placement_footprint(placement.entity_name, placement.x, placement.y, placement.direction)
    if (!footprint) return { ok: false, error: { code: 'PLANNED_FOOTPRINT_UNKNOWN', message: `placement ${index} has no footprint to check against the rest of the plan`, index } }
    if (reservation_intersection(actor.surface, footprint.world_box)) return { ok: false, error: { code: 'NPC_AREA_RESERVED', message: 'placement overlaps an NPC reserved site', index } }
    if (!actor.surface.can_place_entity({
      name: placement.entity_name,
      position,
      direction: placement.direction,
      force: actor.force,
      ...placement_check_args(placement.entity_name),
    })) {
      return {
        ok: false,
        error: {
          code: 'WORLD_COLLISION',
          message: `placement ${index} is not placeable in the current world`,
          index,
          placement: placement_geometry(placement, index, footprint),
          spatial_context: local_spatial_observation(actor, {
            position,
            half_size: 4,
            requested_entity_name: placement.entity_name,
          }),
        },
      }
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
      return {
        ok: false,
        error: {
          code: 'PLANNED_COLLISION',
          message: `placements ${left} and ${right} overlap before construction begins`,
          indices: [left, right],
          placements: [
            placement_geometry(placements[left], left, left_footprint),
            placement_geometry(placements[right], right, right_footprint),
          ],
          overlap_box: overlap_box(left_footprint.world_box, right_footprint.world_box),
        },
      }
    }
  }

  for (const item_name in required) {
    const needed = required[item_name] ?? 0
    if ((counts[item_name] ?? 0) < needed) {
      return {
        ok: false,
        error: {
          code: 'ITEMS_MISSING',
          message: `construction plan requires ${needed} ${item_name} but only ${counts[item_name] ?? 0} are available`,
          item_name,
          required_count: needed,
          available_count: counts[item_name] ?? 0,
        },
      }
    }
  }

  return {
    ok: true,
    placement_geometry: placements.map((placement, index) => placement_geometry(placement, index, footprints[index])),
    planned_footprints: footprints,
  }
}

export function validate_construction_execution_plan(actor: ControlledActor, request: ConstructionExecutionValidationRequest) {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return { ok: false, error: { code: 'ACTOR_UNAVAILABLE', message: 'controlled actor has no stable identity' } }
  }
  const normalized = normalize_request(request)
  if ('error' in normalized) return { ok: false, error: normalized.error }
  const placements = normalized.placements!
  const evaluation = evaluate_plan(actor, placements)
  if (!evaluation.ok) return evaluation

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
  }

  return {
    ok: true,
    validation_id,
    plan_id: request.plan_id,
    placement_count: placements.length,
    created_tick: game.tick,
    expires_tick: game.tick + VALIDATION_MAX_AGE_TICKS,
    placements,
    placement_geometry: evaluation.placement_geometry,
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
  const evaluation = evaluate_plan(actor, plan.placements)
  if (!evaluation.ok) return { ok: false, code: 'construction_plan_stale', evaluation_code: evaluation.error?.code }

  // `position` is the entity centre the engine uses (the grid snap a coordinate place_entity's planned_footprint uses), so the
  // runtime tests committed areas against resolved geometry rather than the requested coordinates. `planned_footprint` is
  // the same record a coordinate place_entity's preflight carries, so the runtime compares the plan's placements with the
  // rest of the batch.
  const construction_placements: Array<{ entity_name: string, x: number, y: number, direction: number, position: { x: number, y: number }, planned_footprint: PlannedFootprint, fluidbox_count: number }> = []
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

  const evaluation = evaluate_plan(actor, plan.placements)
  if (!evaluation.ok) {
    storage.sgluna_validated_construction_plan = undefined
    return [false, `validated construction plan became stale: ${evaluation.error?.code ?? 'UNKNOWN'}`]
  }

  let queued = 0
  for (const placement of plan.placements) {
    // Always placement-only: the task carries refuse_clearance, so nothing is mined or picked up to make room.
    if (!basic.submit_placement(placement.entity_name, placement.x, placement.y, placement.direction, undefined, undefined, undefined, { refuse_clearance: true })) {
      if (queued > 0) manager.cancel_all_tasks('construction_plan_admission_failed')
      storage.sgluna_validated_construction_plan = undefined
      return [false, `unable to queue placement ${queued + 1}`]
    }
    queued += 1
  }

  storage.sgluna_validated_construction_plan = undefined
  return [true, 'Validated construction plan started']
}
