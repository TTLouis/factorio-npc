import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { TransferInventorySnapshot } from './basic_operations'

export type InventoryRole = TransferInventorySnapshot['role']

export interface RoledInventory {
  inventory: LuaInventory
  role: InventoryRole
}

// Entities whose output inventory is a separate result slot. For a container
// the engine reports the chest inventory itself as the output inventory, so
// output identity is only trusted for these types.
const SEPARATE_OUTPUT_ENTITY_TYPES: Record<string, boolean> = {
  'furnace': true,
  'assembling-machine': true,
  'rocket-silo': true,
}

// Inventory names (keys of defines.inventory) that hold products or waste.
// Factorio 2.0 names a furnace's slots crafter_input / crafter_output, and a
// script insert into crafter_output succeeds (engine lane, 2.0.77), so these
// are excluded by role, never by can_insert.
const OUTPUT_INVENTORY_NAMES: Record<string, InventoryRole> = {
  furnace_result: 'output',
  crafter_output: 'output',
  crafter_trash: 'output',
  assembling_machine_output: 'output',
  assembling_machine_dump: 'output',
  rocket_silo_output: 'output',
  rocket_silo_result: 'output',
  rocket_silo_trash: 'output',
  logistic_container_trash: 'output',
  burnt_result: 'burnt_result',
}

/** Machines with their own result slot (furnaces, crafting machines, silos). */
export function has_separate_output(entity_type: string) {
  return SEPARATE_OUTPUT_ENTITY_TYPES[entity_type] === true
}

export function entity_role_inventories(entity: LuaEntity) {
  const output = SEPARATE_OUTPUT_ENTITY_TYPES[entity.type] ? entity.get_output_inventory() : undefined
  const fuel = entity.get_fuel_inventory()
  const burnt = entity.get_burnt_result_inventory()
  const output_index = output ? output.index : undefined
  const fuel_index = fuel ? fuel.index : undefined
  const burnt_index = burnt ? burnt.index : undefined
  const inventories: RoledInventory[] = []
  const max_index = entity.get_max_inventory_index()
  for (let i = 1; i <= max_index; i++) {
    const inventory = entity.get_inventory(i)
    if (!inventory) continue
    const index = inventory.index ?? i
    const named_role = inventory.name !== undefined ? OUTPUT_INVENTORY_NAMES[inventory.name] : undefined
    let role: InventoryRole = 'input'
    if (burnt_index !== undefined && index === burnt_index) role = 'burnt_result'
    else if (output_index !== undefined && index === output_index) role = 'output'
    else if (named_role !== undefined) role = named_role
    else if (fuel_index !== undefined && index === fuel_index) role = 'fuel'
    inventories.push({ inventory, role })
  }
  return inventories
}
