import type { LuaEntity, LuaInventory, LuaItemStack } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MAX_EQUIPMENT_SLOTS = 64

/** Read only the selected native slots; main-inventory ammo is not equipped. */
export function selected_weapon_readiness(character: LuaEntity) {
  const slot = character.selected_gun_index
  const gun = slot ? character.get_inventory(defines.inventory.character_guns)?.[slot - 1] : undefined
  const ammo = slot ? character.get_inventory(defines.inventory.character_ammo)?.[slot - 1] : undefined
  if (!gun?.valid_for_read || !ammo?.valid_for_read) return { ready: false, reason: 'missing_equipped_weapon_or_ammo' }
  const categories = gun.prototype?.attack_parameters?.ammo_categories
  const category = ammo.prototype?.ammo_category?.name
  const compatible = category !== undefined && categories?.some(value => value === category) === true
  return {
    ready: compatible,
    reason: compatible ? 'compatible_equipped_weapon_and_ammo' : 'incompatible_equipped_ammo',
    weapon: gun.name,
    ammunition: ammo.name,
    ammunition_count: ammo.count,
    ammo_category: category,
  }
}

type EquipmentInventoryKind = 'weapon' | 'ammo' | 'armor'

type StandaloneActorResult
  = | { actor: ControlledActor }
    | { error: string }

function stack_summary(stack: LuaItemStack | undefined) {
  if (!stack || !stack.valid_for_read) return undefined
  return {
    name: stack.name,
    count: stack.count,
  }
}

function inventory_summary(inventory: LuaInventory | undefined) {
  if (!inventory) return []
  const result: Array<{ slot: number, name: string, count: number }> = []
  for (let index = 0; index < inventory.length; index++) {
    const stack = inventory[index]
    const summary = stack_summary(stack)
    if (!summary) continue
    result.push({
      slot: index + 1,
      ...summary,
    })
  }
  return result
}

function valid_slot(slot: number) {
  return typeof slot === 'number'
    && slot === math.floor(slot)
    && slot >= 1
    && slot <= MAX_EQUIPMENT_SLOTS
}

function equipment_inventory(actor: ControlledActor, kind: EquipmentInventoryKind) {
  const character = actor.character
  if (!character) return undefined
  if (kind === 'weapon') return character.get_inventory(defines.inventory.character_guns)
  if (kind === 'ammo') return character.get_inventory(defines.inventory.character_ammo)
  return character.get_inventory(defines.inventory.character_armor)
}

function standalone_actor(get_actor: () => ControlledActor | undefined): StandaloneActorResult {
  const actor = get_actor()
  if (!actor || !actor.is_valid || !actor.character) return { error: 'no_actor' }
  if (actor.status_snapshot().kind !== 'standalone_character') return { error: 'standalone_npc_required' }
  return { actor }
}

export function new_equipment_controller(get_actor: () => ControlledActor | undefined) {
  function status() {
    const actor = get_actor()
    const character = actor?.character
    if (!actor || !actor.is_valid || !character) {
      return {
        available: false,
        error: 'no_actor',
      }
    }

    const guns = equipment_inventory(actor, 'weapon')
    const ammo = equipment_inventory(actor, 'ammo')
    const armor = equipment_inventory(actor, 'armor')
    const cursor = stack_summary(character.cursor_stack)

    return {
      available: true,
      actor: actor.status_snapshot(),
      health: character.health,
      max_health: character.max_health,
      selected_gun_slot: character.selected_gun_index,
      recovery_readiness: selected_weapon_readiness(character),
      guns: inventory_summary(guns),
      ammo: inventory_summary(ammo),
      armor: inventory_summary(armor),
      cursor_stack: cursor,
    }
  }

  function equip(item_name: string, kind: EquipmentInventoryKind, slot: number): [boolean, string] {
    const resolved = standalone_actor(get_actor)
    if ('error' in resolved) return [false, resolved.error]
    const actor = resolved.actor
    if (typeof item_name !== 'string' || item_name.length === 0) return [false, 'invalid_item']
    if (!valid_slot(slot)) return [false, 'invalid_slot']

    const destination = equipment_inventory(actor, kind)
    if (!destination || slot > destination.length) return [false, 'slot_unavailable']
    const main = actor.get_main_inventory()
    if (!main) return [false, 'no_main_inventory']
    const [source] = main.find_item_stack(item_name)
    if (!source || !source.valid_for_read) return [false, 'item_not_in_main_inventory']

    const target = destination[slot - 1]
    if (!target || !target.swap_stack(source)) return [false, 'equipment_rejected_item']

    if (kind === 'weapon' && actor.character) {
      actor.character.selected_gun_index = slot
    }
    return [true, `${kind} equipped in slot ${slot}`]
  }

  function equip_weapon(item_name: string, slot: number = 1): [boolean, string] {
    return equip(item_name, 'weapon', slot)
  }

  function equip_ammo(item_name: string, slot: number = 1): [boolean, string] {
    return equip(item_name, 'ammo', slot)
  }

  function equip_armor(item_name: string): [boolean, string] {
    return equip(item_name, 'armor', 1)
  }

  function select_weapon_slot(slot: number): [boolean, string] {
    const resolved = standalone_actor(get_actor)
    if ('error' in resolved) return [false, resolved.error]
    const actor = resolved.actor
    if (!actor.character) return [false, 'no_actor']
    if (!valid_slot(slot)) return [false, 'invalid_slot']
    const guns = equipment_inventory(actor, 'weapon')
    if (!guns || slot > guns.length) return [false, 'slot_unavailable']
    const gun = guns[slot - 1]
    if (!gun || !gun.valid_for_read) return [false, 'no_weapon_in_slot']
    actor.character.selected_gun_index = slot
    return [true, `Selected weapon slot ${slot}`]
  }

  return { status, equip_weapon, equip_ammo, equip_armor, select_weapon_slot }
}
