import type { LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { compact_construction_fulfillment, inspect_construction_fulfillment } from './construction_fulfillment'
import { is_chunk_known_charted, is_chunk_known_visible } from './map_knowledge'
import { resolve_entity_placement_item } from './placement_item'

const MAX_SURFACE_INDEX = 4294967295
const MAX_COORDINATE = 1000000

type Position = { x: number, y: number }

interface StoredRemoteConstructionPlan {
  validation_id: number
  actor_id: number
  force_index: number
  surface_index: number
  created_tick: number
  x: number
  y: number
  entity_name: string
  direction?: number
}

declare const storage: {
  airi_validated_remote_construction_plan?: StoredRemoteConstructionPlan
  airi_next_construction_validation_id?: number
}

const VALIDATION_MAX_AGE_TICKS = 60 * 60

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -MAX_COORDINATE && value <= MAX_COORDINATE
}

function surface_by_index(surface_index: number) {
  if (!valid_integer(surface_index, 1, MAX_SURFACE_INDEX)) return undefined
  return game.get_surface(surface_index as LuaSurface['index'])
}

function chunk_position(position: Position) {
  return {
    x: math.floor(position.x / 32),
    y: math.floor(position.y / 32),
  }
}

function position_charted(actor: ControlledActor, surface: LuaSurface, position: Position) {
  return is_chunk_known_charted(actor.force, surface, chunk_position(position))
}

function position_visible(actor: ControlledActor, surface: LuaSurface, position: Position) {
  return is_chunk_known_visible(actor.force, surface, chunk_position(position))
}

function legacy_fulfillment(fixed: ReturnType<typeof inspect_construction_fulfillment>['fixed']) {
  if (fixed.state === 'ready') return 'ready'
  if (fixed.state === 'queued') return 'queued_no_available_construction_robots'
  if (fixed.reason === 'no_construction_robots') return 'blocked_no_construction_robots'
  if (fixed.reason === 'item_missing') return 'blocked_item_missing'
  return 'blocked_no_construction_network'
}

function remotely_fulfillable(fulfillment: string) {
  return fulfillment === 'ready' || fulfillment === 'queued_no_available_construction_robots'
}

export function inspect_remote_construction(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  entity_name: string,
  direction?: number,
) {
  if (!valid_coordinate(x) || !valid_coordinate(y)) {
    return { ok: false, code: 'invalid_position' }
  }
  if (direction !== undefined && !valid_integer(direction, 0, 15)) {
    return { ok: false, code: 'invalid_direction' }
  }
  if (typeof entity_name !== 'string' || entity_name.length === 0 || !prototypes.entity[entity_name]) {
    return { ok: false, code: 'invalid_entity_name', entity_name }
  }

  const surface = surface_by_index(surface_index)
  if (!surface || !surface.valid) {
    return { ok: false, code: 'invalid_surface', surface_index }
  }
  const position = { x, y }
  if (!position_charted(actor, surface, position)) {
    return { ok: false, code: 'area_uncharted', surface_index, position }
  }
  if (!position_visible(actor, surface, position)) {
    return { ok: false, code: 'area_not_visible', surface_index, position }
  }

  const placement_item = resolve_entity_placement_item(entity_name)
  if (!placement_item.ok) {
    return {
      ok: false,
      code: 'entity_not_bot_placeable',
      placement_item_error: placement_item.code,
      item_name: placement_item.item_name,
      surface_index,
      position,
      entity_name,
    }
  }
  const item = {
    name: placement_item.requirement.item_name,
    count: placement_item.requirement.count,
  }

  const can_place_ghost = surface.can_place_entity({
    name: 'entity-ghost',
    inner_name: entity_name,
    position,
    direction,
    force: actor.force,
  })

  const fulfillment_capability = inspect_construction_fulfillment(actor, surface, position, item)
  const fixed = fulfillment_capability.fixed
  const fulfillment = legacy_fulfillment(fixed)
  return {
    ok: true,
    code: 'ok',
    execution_mode: 'remote',
    surface_index,
    surface_name: surface.name,
    position,
    entity_name,
    direction,
    can_place_ghost,
    construction_item: item,
    fulfillment,
    remotely_fulfillable: can_place_ghost && remotely_fulfillable(fulfillment),
    current_fulfillment: fulfillment_capability.status,
    current_provider: fulfillment_capability.current_provider,
    fulfillment_capability,
    network_count: fixed.network_count,
    all_construction_robots: fixed.all_construction_robots,
    available_construction_robots: fixed.available_construction_robots,
    available_construction_items: fixed.available_construction_items,
    networks: fixed.networks,
  }
}

export function inspect_remote_construction_compact(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  entity_name: string,
  direction?: number,
) {
  const result = inspect_remote_construction(actor, surface_index, x, y, entity_name, direction)
  if (!result.ok) return result
  return {
    ok: true,
    code: 'ok',
    stageable: result.can_place_ghost,
    target: {
      surface_index: result.surface_index,
      x,
      y,
    },
    entity_name,
    direction,
    construction_item: result.construction_item,
    fulfillment: compact_construction_fulfillment(result.fulfillment_capability!),
  }
}

export function stage_remote_entity_ghost(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  entity_name: string,
  direction?: number,
) {
  const capability = inspect_remote_construction(actor, surface_index, x, y, entity_name, direction)
  if (!capability.ok) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      ...capability,
    }
  }
  if (!capability.can_place_ghost) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'world_collision',
      construction: capability,
    }
  }

  const surface = surface_by_index(surface_index)!
  const ghost = surface.create_entity({
    name: 'entity-ghost',
    inner_name: entity_name,
    position: { x, y },
    direction,
    force: actor.force,
    raise_built: true,
  })
  if (!ghost || !ghost.valid) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'ghost_creation_failed',
      construction: capability,
    }
  }

  const fulfillment_status = capability.fulfillment_capability?.status
  return {
    accepted: true,
    completed: true,
    execution_mode: 'remote',
    code: 'ghost_staged',
    world_completion: fulfillment_status === 'ready' || fulfillment_status === 'queued'
      ? 'pending_robot_fulfillment'
      : fulfillment_status === 'requires_planning'
        ? 'requires_planning'
        : 'blocked',
    ghost: {
      name: ghost.name,
      ghost_name: ghost.ghost_name,
      position: ghost.position,
      surface_index: ghost.surface.index,
      direction: ghost.direction,
    },
    construction: capability,
  }
}


export function construction_intent(
  actor: ControlledActor,
  surface_index: number | undefined,
  x: number,
  y: number,
  entity_name: string,
  direction: number | undefined,
  prepare_execution: boolean = false,
) {
  const resolved_surface_index = surface_index ?? actor.surface.index
  const result = inspect_remote_construction_compact(actor, resolved_surface_index, x, y, entity_name, direction)
  if (!result.ok || !prepare_execution || !('stageable' in result) || !result.stageable) {
    return {
      ...result,
      execution: { prepared: false },
    }
  }

  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return {
      ...result,
      execution: { prepared: false, reason: 'actor_has_no_stable_identity' },
    }
  }

  const validation_id = (storage.airi_next_construction_validation_id ?? 0) + 1
  storage.airi_next_construction_validation_id = validation_id
  storage.airi_validated_remote_construction_plan = {
    validation_id,
    actor_id: identity.actor_id,
    force_index: actor.force.index,
    surface_index: resolved_surface_index,
    created_tick: game.tick,
    x,
    y,
    entity_name,
    direction,
  }

  return {
    ...result,
    execution: {
      prepared: true,
      validation_id,
      placement_count: 1,
      expires_tick: game.tick + VALIDATION_MAX_AGE_TICKS,
      operation: 'execute_construction_plan',
    },
  }
}

export function execute_prepared_remote_construction_plan(
  actor: ControlledActor,
  validation_id: number,
  placement_count: number,
): [boolean, string] | undefined {
  const plan = storage.airi_validated_remote_construction_plan
  if (!plan || plan.validation_id !== validation_id) return undefined

  storage.airi_validated_remote_construction_plan = undefined
  if (placement_count !== 1) return [false, 'remote construction placement count must be 1']

  const identity = actor.status_snapshot()
  if (identity.actor_id !== plan.actor_id || actor.force.index !== plan.force_index) {
    return [false, 'validated remote construction plan belongs to a different actor or force']
  }
  if (game.tick - plan.created_tick > VALIDATION_MAX_AGE_TICKS) {
    return [false, 'validated remote construction plan expired; inspect the live world again']
  }

  const result = stage_remote_entity_ghost(
    actor,
    plan.surface_index,
    plan.x,
    plan.y,
    plan.entity_name,
    plan.direction,
  )
  if (!result.accepted) {
    return [false, `validated remote construction plan became stale: ${result.code}`]
  }
  return [true, `Remote ghost staged; world completion is ${result.world_completion}`]
}

export function create_map_construction_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_map_construction', {
    inspect: (surface_index: number, x: number, y: number, entity_name: string, direction?: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
      return inspect_remote_construction(actor, surface_index, x, y, entity_name, direction)
    },
    inspect_compact: (surface_index: number, x: number, y: number, entity_name: string, direction?: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
      return inspect_remote_construction_compact(actor, surface_index, x, y, entity_name, direction)
    },
    intent: (surface_index: number | undefined, x: number, y: number, entity_name: string, direction?: number, prepare_execution: boolean = false) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor', execution: { prepared: false } }
      return construction_intent(actor, surface_index, x, y, entity_name, direction, prepare_execution)
    },
    stage_ghost: (surface_index: number, x: number, y: number, entity_name: string, direction?: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor' }
      }
      return stage_remote_entity_ghost(actor, surface_index, x, y, entity_name, direction)
    },
  })
}
