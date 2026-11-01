import type { new_basic_operation_controller } from './basic_operations'
import type { new_navigation_controller } from './navigation'
import type { new_task_manager } from './task_manager'

type BasicController = ReturnType<typeof new_basic_operation_controller>
type NavigationController = ReturnType<typeof new_navigation_controller>
type TaskManager = ReturnType<typeof new_task_manager>

const DEFAULT_RESOURCE_SEARCH_RADIUS = 256
const MAX_RESOURCE_SEARCH_RADIUS = 4096
const MAX_RESOURCE_COUNT = 1000
const MAX_SUPPLY_ITEMS = 8
const MAX_SUPPLY_COUNT = 100000

export interface SupplyItemRequest {
  item_name: string
  count: number
}

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_name(value: string) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
}

/**
 * High-level deterministic operations built only from existing serialized
 * Autorio tasks. These are intentionally thin orchestration helpers: the
 * underlying navigation/mining/interaction controllers remain the source of
 * truth for pathfinding, obstacle recovery, actor ownership and receipts.
 */
export function new_composite_operation_controller(
  navigation: NavigationController,
  basic: BasicController,
  manager: TaskManager,
) {
  function gather_resource(
    resource_name: string,
    count: number = 1,
    search_radius: number = DEFAULT_RESOURCE_SEARCH_RADIUS,
  ): [boolean, string] {
    if (!valid_name(resource_name)) {
      return [false, 'resource_name must be a valid Factorio resource prototype name']
    }
    if (!valid_integer(count, 1, MAX_RESOURCE_COUNT)) {
      return [false, `count must be an integer from 1 to ${MAX_RESOURCE_COUNT}`]
    }
    if (!valid_integer(search_radius, 1, MAX_RESOURCE_SEARCH_RADIUS)) {
      return [false, `search_radius must be an integer from 1 to ${MAX_RESOURCE_SEARCH_RADIUS}`]
    }

    const prototype = prototypes.entity[resource_name]
    if (!prototype) {
      return [false, `unknown_prototype: expected resource prototype; observed type=missing; target=${resource_name}`]
    }
    if (prototype.type !== 'resource') {
      return [false, `invalid_target_kind: expected resource prototype; observed type=${prototype.type}; target=${resource_name}`]
    }

    if (!navigation.submit(resource_name, search_radius)) {
      return [false, `Unable to queue navigation to ${resource_name}`]
    }
    if (!basic.submit_mining(resource_name, count)) {
      manager.cancel_all_tasks('gather_resource_admission_failed')
      return [false, `Unable to queue mining for ${resource_name}`]
    }

    return [true, 'Resource gathering task started']
  }

  function supply_entity(target_unit_number: number, items: SupplyItemRequest[]): [boolean, string] {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      return [false, 'unit_number must be a positive safe integer']
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_SUPPLY_ITEMS) {
      return [false, `items must contain between 1 and ${MAX_SUPPLY_ITEMS} entries`]
    }

    const seen: Record<string, boolean> = {}
    for (const item of items) {
      if (!item || !valid_name(item.item_name)) {
        return [false, 'each supply item must have a valid item_name']
      }
      if (!valid_integer(item.count, 1, MAX_SUPPLY_COUNT)) {
        return [false, `each supply count must be an integer from 1 to ${MAX_SUPPLY_COUNT}`]
      }
      if (seen[item.item_name]) {
        return [false, `duplicate supply item ${item.item_name}`]
      }
      seen[item.item_name] = true
    }

    let queued = 0
    for (const item of items) {
      const result = basic.submit_move_exact(item.item_name, target_unit_number, item.count, true)
      if (!result[0]) {
        if (queued > 0) manager.cancel_all_tasks('supply_entity_admission_failed')
        return [false, `Unable to queue ${item.item_name} supply`]
      }
      queued += 1
    }

    return [true, 'Exact entity supply task started']
  }

  return { gather_resource, supply_entity }
}
