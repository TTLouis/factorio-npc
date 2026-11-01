import type { LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

type Position = { x: number, y: number }

export interface ConstructionItemRequirement {
  name: string
  count: number
}

export type ConstructionProviderState = 'ready' | 'queued' | 'requires_actor_relocation' | 'unavailable'

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function network_has_mobile_cell(network: LuaLogisticNetwork) {
  const cells = network.cells
  if (!cells) return false
  for (const cell of cells) {
    if (cell.valid && cell.mobile) return true
  }
  return false
}

function inventory_item_count(actor: ControlledActor, item_name: string) {
  const inventory = actor.get_main_inventory()
  if (!inventory) return 0
  return inventory.get_item_count(item_name as any)
}

function fixed_network_fulfillment(
  actor: ControlledActor,
  surface: LuaSurface,
  position: Position,
  item: ConstructionItemRequirement,
) {
  const found = surface.find_logistic_networks_by_construction_area(position, actor.force)
  const networks: Array<Record<string, unknown>> = []
  let all_construction_robots = 0
  let available_construction_robots = 0
  let available_construction_items = 0

  for (const network of found) {
    if (!network.valid || network_has_mobile_cell(network)) continue
    const item_count = network.get_item_count(item.name as any)
    all_construction_robots += network.all_construction_robots
    available_construction_robots += network.available_construction_robots
    available_construction_items += item_count
    networks.push({
      network_id: network.network_id,
      all_construction_robots: network.all_construction_robots,
      available_construction_robots: network.available_construction_robots,
      construction_item_count: item_count,
    })
  }

  let state: ConstructionProviderState = 'ready'
  let reason: string | undefined
  if (networks.length === 0) {
    state = 'unavailable'
    reason = 'no_network'
  }
  else if (all_construction_robots === 0) {
    state = 'unavailable'
    reason = 'no_construction_robots'
  }
  else if (available_construction_items < item.count) {
    state = 'unavailable'
    reason = 'item_missing'
  }
  else if (available_construction_robots === 0) {
    state = 'queued'
    reason = 'robots_busy'
  }

  return {
    mode: 'fixed_network' as const,
    state,
    reason,
    network_count: networks.length,
    all_construction_robots,
    available_construction_robots,
    available_construction_items,
    networks,
  }
}

export function personal_construction_fulfillment(
  actor: ControlledActor,
  surface: LuaSurface,
  position: Position,
  item: ConstructionItemRequirement,
) {
  const character = actor.character
  if (!character || !character.valid) {
    return { mode: 'personal_roboport' as const, state: 'unavailable' as const, reason: 'no_actor_character' }
  }
  if (surface.index !== actor.surface.index) {
    return { mode: 'personal_roboport' as const, state: 'unavailable' as const, reason: 'different_surface' }
  }

  const cell = character.logistic_cell
  if (!cell || !cell.valid || !cell.mobile) {
    return { mode: 'personal_roboport' as const, state: 'unavailable' as const, reason: 'no_personal_roboport' }
  }

  const network = cell.logistic_network
  const all_construction_robots = network?.all_construction_robots ?? cell.stationed_construction_robot_count
  const available_construction_robots = network?.available_construction_robots ?? cell.stationed_construction_robot_count
  const robot_limit = network?.robot_limit ?? 0
  const available_construction_items = inventory_item_count(actor, item.name)
  const construction_radius = cell.construction_radius
  const actor_distance = math.sqrt(squared_distance(actor.position, position))
  const target_in_range = cell.is_in_construction_range(position)
  const dispatch_enabled = character.allow_dispatching_robots
  const transmitting = cell.transmitting

  let state: ConstructionProviderState = 'ready'
  let reason: string | undefined
  if (!dispatch_enabled) {
    state = 'unavailable'
    reason = 'robot_dispatch_disabled'
  }
  else if (!transmitting) {
    state = 'unavailable'
    reason = 'personal_roboport_inactive'
  }
  else if (all_construction_robots === 0) {
    state = 'unavailable'
    reason = 'no_construction_robots'
  }
  else if (available_construction_items < item.count) {
    state = 'unavailable'
    reason = 'item_missing'
  }
  else if (!target_in_range) {
    state = 'requires_actor_relocation'
    reason = 'target_out_of_range'
  }
  else if (available_construction_robots === 0) {
    state = 'queued'
    reason = 'robots_busy'
  }

  return {
    mode: 'personal_roboport' as const,
    state,
    reason,
    target_in_range,
    dispatch_enabled,
    transmitting,
    construction_radius,
    actor_distance,
    robot_limit,
    all_construction_robots,
    available_construction_robots,
    available_construction_items,
  }
}

export function inspect_construction_fulfillment(
  actor: ControlledActor,
  surface: LuaSurface,
  position: Position,
  item: ConstructionItemRequirement,
) {
  const fixed = fixed_network_fulfillment(actor, surface, position, item)
  const personal = personal_construction_fulfillment(actor, surface, position, item)

  let status: 'ready' | 'queued' | 'requires_planning' | 'blocked' = 'blocked'
  let current_provider: 'fixed_network' | 'personal_roboport' | undefined

  if (fixed.state === 'ready') {
    status = 'ready'
    current_provider = 'fixed_network'
  }
  else if (personal.state === 'ready') {
    status = 'ready'
    current_provider = 'personal_roboport'
  }
  else if (fixed.state === 'queued') {
    status = 'queued'
    current_provider = 'fixed_network'
  }
  else if (personal.state === 'queued') {
    status = 'queued'
    current_provider = 'personal_roboport'
  }
  else if (personal.state === 'requires_actor_relocation') {
    status = 'requires_planning'
  }

  return {
    status,
    current_provider,
    fixed,
    personal,
  }
}

export function compact_construction_fulfillment(result: ReturnType<typeof inspect_construction_fulfillment>) {
  const personal = result.personal
  return {
    status: result.status,
    current_provider: result.current_provider,
    fixed: {
      state: result.fixed.state,
      reason: result.fixed.reason,
    },
    personal: {
      state: personal.state,
      reason: personal.reason,
      target_in_range: personal.target_in_range,
      construction_radius: personal.construction_radius,
      actor_distance: personal.actor_distance,
    },
  }
}
