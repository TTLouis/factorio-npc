import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_equipment_controller } from './equipment'

function stack(name?: string, count = 0) {
  return {
    valid_for_read: !!name,
    name,
    count,
    swap_stack: vi.fn(function (this: any, other: any) {
      if (!other?.valid_for_read) return false
      const old = { valid_for_read: this.valid_for_read, name: this.name, count: this.count }
      this.valid_for_read = other.valid_for_read
      this.name = other.name
      this.count = other.count
      other.valid_for_read = old.valid_for_read
      other.name = old.name
      other.count = old.count
      return true
    }),
  } as any
}

function inventory(slots: any[]) {
  const value: any = slots
  value.find_item_stack = vi.fn((name: string) => {
    const index = slots.findIndex(item => item.valid_for_read && item.name === name)
    return index >= 0 ? [slots[index], index + 1] : [undefined, undefined]
  })
  return value
}

function world(kind = 'standalone_character') {
  const rocket = stack('rocket-launcher', 1)
  const bombs = stack('atomic-bomb', 10)
  const armorItem = stack('modular-armor', 1)
  const main = inventory([rocket, bombs, armorItem, stack()])
  const guns = inventory([stack(), stack(), stack()])
  const ammo = inventory([stack(), stack(), stack()])
  const armor = inventory([stack()])
  const cursor = stack()
  const character: any = {
    valid: true,
    health: 220,
    max_health: 250,
    selected_gun_index: 1,
    cursor_stack: cursor,
    get_inventory: vi.fn((index: unknown) => {
      if (index === (globalThis as any).defines.inventory.character_guns) return guns
      if (index === (globalThis as any).defines.inventory.character_ammo) return ammo
      if (index === (globalThis as any).defines.inventory.character_armor) return armor
      return undefined
    }),
  }
  const actor: any = {
    is_valid: true,
    character,
    get_main_inventory: () => main,
    status_snapshot: () => ({ kind, actor_id: 42, valid: true, name: 'SGLuna', position: { x: 0, y: 0 }, has_character: true }),
  }
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  return { actor, character, main, guns, ammo, armor, rocket, bombs, armorItem, get_actor, controller: new_equipment_controller(get_actor) }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('standalone NPC equipment controller', () => {
  it('reports health, selected gun slot, equipment inventories, and cursor stack', () => {
    const { character, guns, ammo, armor, controller } = world()
    guns[0] = stack('pistol', 1)
    ammo[0] = stack('firearm-magazine', 22)
    armor[0] = stack('light-armor', 1)
    character.cursor_stack = stack('iron-plate', 5)

    expect(controller.status()).toMatchObject({
      available: true,
      health: 220,
      max_health: 250,
      selected_gun_slot: 1,
      guns: [{ slot: 1, name: 'pistol', count: 1 }],
      ammo: [{ slot: 1, name: 'firearm-magazine', count: 22 }],
      armor: [{ slot: 1, name: 'light-armor', count: 1 }],
      cursor_stack: { name: 'iron-plate', count: 5 },
    })
  })

  it('equips a weapon from main inventory and selects its Factorio slot', () => {
    const { character, main, guns, controller } = world()

    expect(controller.equip_weapon('rocket-launcher', 2)).toEqual([true, 'weapon equipped in slot 2'])
    expect(guns[1]).toMatchObject({ valid_for_read: true, name: 'rocket-launcher', count: 1 })
    expect(character.selected_gun_index).toBe(2)
    expect(main.find_item_stack).toHaveBeenCalledWith('rocket-launcher')
  })

  it('equips ammo and armor without discarding an item already in the target slot', () => {
    const { main, ammo, armor, controller } = world()
    ammo[0] = stack('firearm-magazine', 22)
    armor[0] = stack('light-armor', 1)

    expect(controller.equip_ammo('atomic-bomb', 1)[0]).toBe(true)
    expect(ammo[0]).toMatchObject({ name: 'atomic-bomb', count: 10 })
    expect(main.some((item: any) => item.valid_for_read && item.name === 'firearm-magazine')).toBe(true)

    expect(controller.equip_armor('modular-armor')[0]).toBe(true)
    expect(armor[0]).toMatchObject({ name: 'modular-armor', count: 1 })
    expect(main.some((item: any) => item.valid_for_read && item.name === 'light-armor')).toBe(true)
  })

  it('selects only a populated weapon slot', () => {
    const { character, guns, controller } = world()
    guns[2] = stack('pistol', 1)

    expect(controller.select_weapon_slot(3)).toEqual([true, 'Selected weapon slot 3'])
    expect(character.selected_gun_index).toBe(3)
    expect(controller.select_weapon_slot(2)).toEqual([false, 'no_weapon_in_slot'])
  })

  it('rejects equipment mutation for connected human actors and invalid slots', () => {
    const human = world('connected_player')
    expect(human.controller.equip_weapon('rocket-launcher', 1)).toEqual([false, 'standalone_npc_required'])

    const npc = world()
    expect(npc.controller.equip_weapon('rocket-launcher', 0)).toEqual([false, 'invalid_slot'])
    expect(npc.controller.equip_ammo('atomic-bomb', 65)).toEqual([false, 'invalid_slot'])
    expect(npc.controller.equip_weapon('missing-gun', 1)).toEqual([false, 'item_not_in_main_inventory'])
  })
})
