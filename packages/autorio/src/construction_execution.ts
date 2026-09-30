import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import { local_spatial_observation, prototype_spatial_geometry } from './construction_planning'
import { execute_prepared_remote_construction_plan } from './map_construction'
import { placement_check_args } from './placement_geometry'
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

// Factorio direction is a discrete 0..15 value. Keep the collision geometry
// deterministic and portable instead of depending on host math.cos/math.sin
// implementations in the Node test harness.
const DIRECTION_COS = [
  1,
  0.9238795325112867,
  0.7071067811865476,
  0.38268343236508984,
  0,
  -0.3826834323650897,
  -0.7071067811865475,
  -0.9238795325112867,
  -1,
  -0.9238795325112868,
  -0.7071067811865477,
  -0.38268343236509034,
  0,
  0.38268343236509,
  0.7071067811865474,
  0.9238795325112865,
]

const DIRECTION_SIN = [
  0,
  0.3826834323650898,
  0.7071067811865475,
  0.9238795325112867,
  1,
  0.9238795325112867,
  0.7071067811865476,
  0.3826834323650899,
  0,
  -0.38268343236508967,
  -0.7071067811865475,
  -0.9238795325112865,
  -1,
  -0.9238795325112866,
  -0.7071067811865477,
  -0.3826834323650904,
]

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -MAX_COORDINATE && value <= MAX_COORDINATE
}

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function rotated_world_box(entity_name: string, position: Position, direction: number | undefined): WorldBox | undefined {
  const prototype = prototypes.entity[entity_name]
  const box = prototype?.collision_box
  if (!box) return undefined

  const direction_index = direction ?? 0
  const cosine = DIRECTION_COS[direction_index]
  const sine = DIRECTION_SIN[direction_index]
  const corners = [
    { x: box.left_top.x, y: box.left_top.y },
    { x: box.left_top.x, y: box.right_bottom.y },
    { x: box.right_bottom.x, y: box.left_top.y },
    { x: box.right_bottom.x, y: box.right_bottom.y },
  ]
  let min_x = math.huge
  let min_y = math.huge
  let max_x = -math.huge
  let max_y = -math.huge
  for (const corner of corners) {
    const x = corner.x * cosine - corner.y * sine + position.x
    const y = corner.x * sine + corner.y * cosine + position.y
    min_x = math.min(min_x, x)
    min_y = math.min(min_y, y)
    max_x = math.max(max_x, x)
    max_y = math.max(max_y, y)
  }
  return {
    left_top: { x: min_x, y: min_y },
    right_bottom: { x: max_x, y: max_y },
  }
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

function placement_geometry(placement: ConstructionExecutionPlacement, index: number) {
  const position = { x: placement.x, y: placement.y }
  return {
    index,
    entity_name: placement.entity_name,
    position,
    direction: placement.direction,
    prototype: prototype_spatial_geometry(placement.entity_name),
    world_collision_box: rotated_world_box(placement.entity_name, position, placement.direction),
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
    if (placement.direction !== undefined && !valid_integer(placement.direction, 0, 15)) {
      return { error: { code: 'INVALID_PLACEMENT', message: `placement ${index} has invalid direction`, index } }
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
  const boxes: Array<WorldBox | undefined> = []
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index]
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
          placement: placement_geometry(placement, index),
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
    boxes.push(rotated_world_box(placement.entity_name, position, placement.direction))
  }

  for (let left = 0; left < boxes.length; left++) {
    const left_box = boxes[left]
    if (!left_box) continue
    for (let right = left + 1; right < boxes.length; right++) {
      const right_box = boxes[right]
      if (!right_box) continue
      if (overlaps(left_box, right_box)) {
        return {
          ok: false,
          error: {
            code: 'PLANNED_COLLISION',
            message: `placements ${left} and ${right} overlap before construction begins`,
            indices: [left, right],
            placements: [
              placement_geometry(placements[left], left),
              placement_geometry(placements[right], right),
            ],
            overlap_box: overlap_box(left_box, right_box),
          },
        }
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
    placement_geometry: placements.map((placement, index) => placement_geometry(placement, index)),
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
    if (!basic.submit_placement(placement.entity_name, placement.x, placement.y, placement.direction)) {
      if (queued > 0) manager.cancel_all_tasks('construction_plan_admission_failed')
      storage.sgluna_validated_construction_plan = undefined
      return [false, `unable to queue placement ${queued + 1}`]
    }
    queued += 1
  }

  storage.sgluna_validated_construction_plan = undefined
  return [true, 'Validated construction plan started']
}
