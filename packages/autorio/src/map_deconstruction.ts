import type { LuaEntity, LuaLogisticNetwork } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { resolve_entity_reference } from './entity_reference'
import { is_chunk_known_charted, is_chunk_known_visible } from './map_knowledge'

function valid_unit_number(value: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= 1 && value <= 9007199254740991
}

function chunk_position(entity: LuaEntity) {
  return {
    x: math.floor(entity.position.x / 32),
    y: math.floor(entity.position.y / 32),
  }
}

function is_charted(actor: ControlledActor, entity: LuaEntity) {
  return is_chunk_known_charted(actor.force, entity.surface, chunk_position(entity))
}

function is_visible(actor: ControlledActor, entity: LuaEntity) {
  return is_chunk_known_visible(actor.force, entity.surface, chunk_position(entity))
}

function resolve_visible_entity(actor: ControlledActor, unit_number: number) {
  if (!valid_unit_number(unit_number)) return { code: 'entity_not_found', entity: undefined }
  const entity = resolve_entity_reference(actor, unit_number, 'map_visible')
  if (!entity || !entity.valid) return { code: 'entity_not_found', entity: undefined }
  if (!is_charted(actor, entity)) return { code: 'area_uncharted', entity: undefined }
  if (!is_visible(actor, entity)) return { code: 'area_not_visible', entity: undefined }
  return { code: 'ok', entity }
}

function network_status(actor: ControlledActor, entity: LuaEntity) {
  const networks = entity.surface.find_logistic_networks_by_construction_area(entity.position, actor.force)
  const summaries: Array<Record<string, unknown>> = []
  let all_robots = 0
  let available_robots = 0
  for (const network of networks as LuaLogisticNetwork[]) {
    if (!network.valid) continue
    all_robots += network.all_construction_robots
    available_robots += network.available_construction_robots
    summaries.push({
      network_id: network.network_id,
      all_construction_robots: network.all_construction_robots,
      available_construction_robots: network.available_construction_robots,
    })
  }

  let dispatch_readiness = 'ready'
  if (summaries.length === 0) dispatch_readiness = 'blocked_no_construction_network'
  else if (all_robots === 0) dispatch_readiness = 'blocked_no_construction_robots'
  else if (available_robots === 0) dispatch_readiness = 'queued_no_available_construction_robots'

  return {
    network_count: summaries.length,
    all_construction_robots: all_robots,
    available_construction_robots: available_robots,
    dispatch_readiness,
    remotely_fulfillable: dispatch_readiness === 'ready' || dispatch_readiness === 'queued_no_available_construction_robots',
    completion_guaranteed: false,
    completion_uncertainty: 'robot pathing and storage capacity are not prevalidated',
    networks: summaries,
  }
}

// Deconstruction may target the actor's own force or neutral entities (for
// example crash-site wrecks); other forces' entities are rejected.
function deconstructible_force(actor: ControlledActor, entity: LuaEntity) {
  return entity.force.index === actor.force.index || entity.force.name === 'neutral'
}

function pending_or_blocked(construction: { remotely_fulfillable: boolean }) {
  return construction.remotely_fulfillable ? 'pending_robot_fulfillment' : 'blocked'
}

export function inspect_remote_deconstruction(actor: ControlledActor, unit_number: number) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const entity = resolved.entity
  if (!entity) return { ok: false, code: resolved.code, unit_number }

  return {
    ok: true,
    code: 'ok',
    execution_mode: 'remote',
    entity: {
      unit_number: entity.unit_number,
      name: entity.name,
      type: entity.type,
      position: entity.position,
      surface_index: entity.surface.index,
      surface_name: entity.surface.name,
      force: entity.force?.name,
      marked_for_deconstruction: entity.to_be_deconstructed(),
    },
    construction: network_status(actor, entity),
  }
}

export function mark_remote_deconstruction(actor: ControlledActor, unit_number: number) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const entity = resolved.entity
  if (!entity) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: resolved.code,
      unit_number,
    }
  }
  if (!deconstructible_force(actor, entity)) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: 'wrong_force', unit_number }
  }

  const construction = network_status(actor, entity)
  if (entity.to_be_deconstructed()) {
    return {
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'already_marked',
      unit_number,
      world_completion: pending_or_blocked(construction),
      construction,
    }
  }

  const ordered = entity.order_deconstruction(actor.force)
  if (!ordered || !entity.to_be_deconstructed()) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'deconstruction_rejected',
      unit_number,
      construction,
    }
  }

  return {
    accepted: true,
    completed: true,
    execution_mode: 'remote',
    code: 'deconstruction_marked',
    unit_number,
    world_completion: pending_or_blocked(construction),
    construction,
  }
}

export function cancel_remote_deconstruction(actor: ControlledActor, unit_number: number) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const entity = resolved.entity
  if (!entity) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: resolved.code,
      unit_number,
    }
  }
  if (!deconstructible_force(actor, entity)) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: 'wrong_force', unit_number }
  }

  if (!entity.to_be_deconstructed()) {
    return {
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'not_marked',
      unit_number,
    }
  }

  entity.cancel_deconstruction(actor.force)
  if (entity.to_be_deconstructed()) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'cancel_failed',
      unit_number,
    }
  }

  return {
    accepted: true,
    completed: true,
    execution_mode: 'remote',
    code: 'deconstruction_cancelled',
    unit_number,
  }
}

export function create_map_deconstruction_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_map_deconstruction', {
    inspect: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor', unit_number }
      return inspect_remote_deconstruction(actor, unit_number)
    },
    mark: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor', unit_number }
      }
      return mark_remote_deconstruction(actor, unit_number)
    },
    cancel: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor', unit_number }
      }
      return cancel_remote_deconstruction(actor, unit_number)
    },
  })
}
