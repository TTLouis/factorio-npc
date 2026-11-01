import type { LuaEntity, LuaEntityPrototype, LuaLogisticNetwork } from 'factorio:runtime'
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

function target_item(target: LuaEntityPrototype) {
  const first = target.items_to_place_this?.[0]
  if (!first) return undefined
  return { name: first.name, count: first.count }
}

function resolve_target(entity: LuaEntity, target_name?: string) {
  if (target_name !== undefined) {
    if (typeof target_name !== 'string' || target_name.length === 0) return { code: 'invalid_upgrade_target', target: undefined }
    const requested = prototypes.entity[target_name]
    if (!requested) return { code: 'invalid_upgrade_target', target: undefined }
    return { code: 'ok', target: requested }
  }

  const next = entity.prototype.next_upgrade
  if (!next) return { code: 'no_upgrade_target', target: undefined }
  return { code: 'ok', target: next }
}

function compatible(source: LuaEntityPrototype, target: LuaEntityPrototype) {
  const source_group = source.fast_replaceable_group
  const target_group = target.fast_replaceable_group
  return source_group !== undefined && source_group === target_group
}

function network_status(actor: ControlledActor, entity: LuaEntity, item: { name: string, count: number }) {
  const networks = entity.surface.find_logistic_networks_by_construction_area(entity.position, actor.force)
  const summaries: Array<Record<string, unknown>> = []
  let all_robots = 0
  let available_robots = 0
  let available_items = 0
  for (const network of networks as LuaLogisticNetwork[]) {
    if (!network.valid) continue
    const count = network.get_item_count(item.name as any)
    all_robots += network.all_construction_robots
    available_robots += network.available_construction_robots
    available_items += count
    summaries.push({
      network_id: network.network_id,
      all_construction_robots: network.all_construction_robots,
      available_construction_robots: network.available_construction_robots,
      upgrade_item_count: count,
    })
  }

  let fulfillment = 'ready'
  if (summaries.length === 0) fulfillment = 'blocked_no_construction_network'
  else if (all_robots === 0) fulfillment = 'blocked_no_construction_robots'
  else if (available_items < item.count) fulfillment = 'blocked_upgrade_item_missing'
  else if (available_robots === 0) fulfillment = 'queued_no_available_construction_robots'

  return {
    network_count: summaries.length,
    all_construction_robots: all_robots,
    available_construction_robots: available_robots,
    available_upgrade_items: available_items,
    required_upgrade_items: item.count,
    fulfillment,
    remotely_fulfillable: fulfillment === 'ready' || fulfillment === 'queued_no_available_construction_robots',
    completion_guaranteed: false,
    completion_uncertainty: 'robot pathing and storage capacity are not prevalidated',
    networks: summaries,
  }
}

export function inspect_remote_upgrade(actor: ControlledActor, unit_number: number, target_name?: string) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const entity = resolved.entity
  if (!entity) return { ok: false, code: resolved.code, unit_number }
  if (entity.force.index !== actor.force.index) return { ok: false, code: 'wrong_force', unit_number }

  const target_result = resolve_target(entity, target_name)
  const target = target_result.target
  if (!target) return { ok: false, code: target_result.code, unit_number, target_name }
  if (!compatible(entity.prototype, target)) {
    return { ok: false, code: 'incompatible_upgrade_target', unit_number, target_name: target.name }
  }

  const item = target_item(target)
  if (!item) return { ok: false, code: 'target_not_bot_placeable', unit_number, target_name: target.name }
  const [current_target] = entity.get_upgrade_target()

  return {
    ok: true,
    code: 'ok',
    execution_mode: 'remote',
    entity: {
      unit_number: entity.unit_number,
      name: entity.name,
      position: entity.position,
      surface_index: entity.surface.index,
      marked_for_upgrade: entity.to_be_upgraded(),
      current_upgrade_target: current_target?.name,
    },
    target: {
      name: target.name,
      item,
    },
    construction: network_status(actor, entity, item),
  }
}

export function mark_remote_upgrade(actor: ControlledActor, unit_number: number, target_name?: string) {
  const inspection = inspect_remote_upgrade(actor, unit_number, target_name)
  if (!inspection.ok || !inspection.target || !inspection.entity || !inspection.construction) {
    return { accepted: false, completed: false, execution_mode: 'remote', ...inspection }
  }

  const entity = resolve_entity_reference(actor, unit_number, 'map_visible')
  if (!entity || !entity.valid) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: 'entity_not_found', unit_number }
  }

  if (inspection.entity.marked_for_upgrade) {
    if (inspection.entity.current_upgrade_target === inspection.target.name) {
      return {
        accepted: true,
        completed: true,
        execution_mode: 'remote',
        code: 'already_marked',
        unit_number,
        target_name: inspection.target.name,
        world_completion: inspection.construction.remotely_fulfillable ? 'pending_robot_fulfillment' : 'blocked',
        construction: inspection.construction,
      }
    }
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'already_marked_different_target',
      unit_number,
      current_target_name: inspection.entity.current_upgrade_target,
      requested_target_name: inspection.target.name,
    }
  }

  const ordered = entity.order_upgrade({ target: inspection.target.name, force: actor.force })
  const [verified_target] = entity.get_upgrade_target()
  if (!ordered || !entity.to_be_upgraded() || verified_target?.name !== inspection.target.name) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'upgrade_rejected',
      unit_number,
      target_name: inspection.target.name,
      construction: inspection.construction,
    }
  }

  return {
    accepted: true,
    completed: true,
    execution_mode: 'remote',
    code: 'upgrade_marked',
    unit_number,
    target_name: inspection.target.name,
    world_completion: inspection.construction.remotely_fulfillable ? 'pending_robot_fulfillment' : 'blocked',
    construction: inspection.construction,
  }
}

export function cancel_remote_upgrade(actor: ControlledActor, unit_number: number) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const entity = resolved.entity
  if (!entity) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: resolved.code, unit_number }
  }
  if (entity.force.index !== actor.force.index) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: 'wrong_force', unit_number }
  }
  if (!entity.to_be_upgraded()) {
    return { accepted: true, completed: true, execution_mode: 'remote', code: 'not_marked', unit_number }
  }

  const cancelled = entity.cancel_upgrade(actor.force)
  if (!cancelled || entity.to_be_upgraded()) {
    return { accepted: false, completed: false, execution_mode: 'remote', code: 'cancel_failed', unit_number }
  }
  return { accepted: true, completed: true, execution_mode: 'remote', code: 'upgrade_cancelled', unit_number }
}

export function create_map_upgrade_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_map_upgrade', {
    inspect: (unit_number: number, target_name?: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor', unit_number }
      return inspect_remote_upgrade(actor, unit_number, target_name)
    },
    mark: (unit_number: number, target_name?: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor', unit_number }
      return mark_remote_upgrade(actor, unit_number, target_name)
    },
    cancel: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor', unit_number }
      return cancel_remote_upgrade(actor, unit_number)
    },
  })
}
