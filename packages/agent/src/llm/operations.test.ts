import { describe, expect, it } from 'vitest'
import { isLegacyOperationCommand, parseStructuredOperations, renderStructuredOperation, renderStructuredOperations } from './operations'

describe('structured Autorio operations', () => {
  it('accepts only a validated pump preparation reference and preserves it in the native call', () => {
    const operation = { name: 'prepare_pump_site', args: { preparation_id: 'pump-preparation-7' } }
    const [parsed] = parseStructuredOperations([operation])
    expect(parsed).toEqual(operation)
    expect(renderStructuredOperation(parsed)).toBe("remote.call('autorio_operations', 'prepare_pump_site', 'pump-preparation-7')")
    for (const preparation_id of ['', 'pump-preparation-0', 'candidate-1', 'pump-preparation-1.5', "pump-preparation-1');game.clear()", 7]) {
      expect(() => parseStructuredOperations([{ name: 'prepare_pump_site', args: { preparation_id } }])).toThrow()
    }
    for (const args of [{}, { preparation_id: 'pump-preparation-7', x: 0 }, { preparation_id: 'pump-preparation-7', backend: 'robot' }, { preparation_id: 'pump-preparation-7', force: true }]) {
      expect(() => parseStructuredOperations([{ name: 'prepare_pump_site', args }])).toThrow()
    }
  })

  it('normalizes optional defaults while validating operation shape', () => {
    const operations = parseStructuredOperations([
      { name: 'mine_entity', args: { entity_name: 'iron-ore' } },
      { name: 'harvest_product', args: { product_name: 'stone', count: 6 } },
      { name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 } },
      { name: 'craft_item', args: { item_name: 'iron-gear-wheel' } },
      { name: 'attack_nearest_enemy', args: {} },
      { name: 'clear_enemy_area', args: {} },
      { name: 'follow_player', args: { player_name: 'Louis' } },
      { name: 'set_auto_defense', args: { enabled: false } },
      { name: 'walk_to_player', args: { player_name: 'Louis' } },
      { name: 'equip_weapon', args: { item_name: 'rocket-launcher' } },
      { name: 'equip_ammo', args: { item_name: 'atomic-bomb' } },
      { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true } },
      { name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel' } },
      { name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'Louis', max_count: 10, to_player: true } },
    ])

    expect(operations).toEqual([
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } },
      { name: 'harvest_product', args: { product_name: 'stone', count: 6, search_radius: 256 } },
      { name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 } },
      { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } },
      { name: 'attack_nearest_enemy', args: { search_radius: 50 } },
      { name: 'clear_enemy_area', args: { search_radius: 96 } },
      { name: 'follow_player', args: { player_name: 'Louis', follow_distance: 4 } },
      { name: 'set_auto_defense', args: { enabled: false } },
      { name: 'walk_to_player', args: { player_name: 'Louis' } },
      { name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 1 } },
      { name: 'equip_ammo', args: { item_name: 'atomic-bomb', slot: 1 } },
      { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true } },
      { name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel' } },
      { name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'Louis', max_count: 10, to_player: true } },
    ])
  })

  it('validates and renders bounded precise placement', () => {
    const [precise] = parseStructuredOperations([
      { name: 'place_entity', args: { entity_name: 'assembling-machine-1', x: 12.5, y: -4, direction: 6 } },
    ])
    expect(precise).toEqual({
      name: 'place_entity',
      args: { entity_name: 'assembling-machine-1', x: 12.5, y: -4, direction: 6 },
    })
    expect(renderStructuredOperation(precise)).toBe("remote.call('autorio_operations', 'place_entity', 'assembling-machine-1', 12.5, -4, 6)")

    const [directionOnly] = parseStructuredOperations([
      { name: 'place_entity', args: { entity_name: 'transport-belt', direction: 4 } },
    ])
    expect(renderStructuredOperation(directionOnly)).toBe("remote.call('autorio_operations', 'place_entity', 'transport-belt', nil, nil, 4)")

    expect(() => parseStructuredOperations([{ name: 'place_entity', args: { entity_name: 'steel-chest', x: 1 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'place_entity', args: { entity_name: 'steel-chest', y: 1 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'place_entity', args: { entity_name: 'steel-chest', x: 1, y: 1, direction: 16 } }])).toThrow()
  })

  it('rejects unknown operations and unexpected arguments', () => {
    expect(() => parseStructuredOperations([{ name: 'game.clear', args: {} }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'wait', args: { ticks: 60, arbitrary_lua: 'game.clear()' } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'set_auto_defense', args: { enabled: 'yes' } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'set_machine_recipe', args: { unit_number: 42, recipe_name: 'iron-gear-wheel', force: 'enemy' } }])).toThrow()
  })

  it('bounds operation batches, task counts, transfers, navigation, equipment, follow, crafting, machine recipes, and combat', () => {
    expect(() => parseStructuredOperations(Array.from({ length: 17 }, () => ({ name: 'wait', args: { ticks: 1 } })))).toThrow()
    expect(() => parseStructuredOperations([{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4097 } }])).toThrow()
    expect(parseStructuredOperations([{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4096 } }])[0]).toEqual({ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4096 } })
    expect(() => parseStructuredOperations([{ name: 'follow_player', args: { player_name: 'Louis', follow_distance: 65 } }])).toThrow()
    expect(parseStructuredOperations([
      { name: 'follow_player', args: { player_name: 'Louis', follow_distance: 6 } },
      { name: 'stop_follow_player', args: {} },
    ])).toEqual([
      { name: 'follow_player', args: { player_name: 'Louis', follow_distance: 6 } },
      { name: 'stop_follow_player', args: {} },
    ])
    expect(() => parseStructuredOperations([{ name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 65 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'select_weapon_slot', args: { slot: 0 } }])).toThrow()
    expect(parseStructuredOperations([
      { name: 'equip_armor', args: { item_name: 'modular-armor' } },
      { name: 'select_weapon_slot', args: { slot: 3 } },
    ])).toEqual([
      { name: 'equip_armor', args: { item_name: 'modular-armor' } },
      { name: 'select_weapon_slot', args: { slot: 3 } },
    ])
    expect(() => parseStructuredOperations([{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1001 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'harvest_product', args: { product_name: 'stone', count: 100001 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 4097 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'clear_construction_area', args: { x: 0, y: 0, width: 65, height: 1 } }])).toThrow()
    expect(parseStructuredOperations([{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1000 } }])[0]).toEqual({ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1000 } })
    expect(() => parseStructuredOperations([{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1001 } }])).toThrow()
    expect(parseStructuredOperations([{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1000 } }])[0]).toEqual({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1000 } })
    expect(() => parseStructuredOperations([{ name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'steel-chest', max_count: 100001, to_entity: true } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 0, max_count: 1, to_entity: true } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 1.5, max_count: 1, to_entity: true } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 42, max_count: 100001, to_entity: true } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'set_machine_recipe', args: { unit_number: 0, recipe_name: 'iron-gear-wheel' } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'set_machine_recipe', args: { unit_number: 1.5, recipe_name: 'iron-gear-wheel' } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'set_machine_recipe', args: { unit_number: 42, recipe_name: 'iron-gear-wheel\n/c game.clear()' } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'Louis', max_count: 100001, to_player: true } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'attack_nearest_enemy', args: { search_radius: 257 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'clear_enemy_area', args: { search_radius: 257 } }])).toThrow()
  })

  it('renders validated operations into the existing Autorio remote-call format', () => {
    expect(renderStructuredOperations([
      { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 1024 } },
      { name: 'walk_to_player', args: { player_name: 'Louis' } },
      { name: 'follow_player', args: { player_name: 'Louis', follow_distance: 5 } },
      { name: 'stop_follow_player', args: {} },
      { name: 'set_auto_defense', args: { enabled: false } },
      { name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 2 } },
      { name: 'equip_ammo', args: { item_name: 'atomic-bomb', slot: 2 } },
      { name: 'equip_armor', args: { item_name: 'modular-armor' } },
      { name: 'select_weapon_slot', args: { slot: 2 } },
      { name: 'clear_enemy_area', args: { search_radius: 128 } },
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 8 } },
      { name: 'harvest_product', args: { product_name: 'stone', count: 6, search_radius: 128 } },
      { name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 } },
      { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true } },
      { name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel' } },
      { name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'Louis', max_count: 10, to_player: true } },
    ])).toEqual([
      "remote.call('autorio_operations', 'walk_to_entity', 'iron-ore', 1024)",
      "remote.call('autorio_operations', 'walk_to_player', 'Louis')",
      "remote.call('autorio_operations', 'follow_player', 'Louis', 5)",
      "remote.call('autorio_operations', 'stop_follow_player')",
      "remote.call('autorio_operations', 'set_auto_defense', false)",
      "remote.call('autorio_operations', 'equip_weapon', 'rocket-launcher', 2)",
      "remote.call('autorio_operations', 'equip_ammo', 'atomic-bomb', 2)",
      "remote.call('autorio_operations', 'equip_armor', 'modular-armor')",
      "remote.call('autorio_operations', 'select_weapon_slot', 2)",
      "remote.call('autorio_operations', 'clear_enemy_area', 128)",
      "remote.call('autorio_operations', 'mine_entity', 'iron-ore', 8)",
      "remote.call('autorio_operations', 'harvest_product', 'stone', 6, 128)",
      "remote.call('autorio_operations', 'clear_construction_area', 10, -4, 12, 8)",
      "remote.call('autorio_operations', 'move_items_exact', 'firearm-magazine', 4242, 10, true)",
      "remote.call('autorio_operations', 'set_machine_recipe', 4242, 'iron-gear-wheel')",
      "remote.call('autorio_operations', 'move_items_with_player', 'stone', 'Louis', 10, true)",
    ])
  })

  it('allows only the exact legacy remote-call shape for exact entity transfers and machine recipes', () => {
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'move_items_exact', 'firearm-magazine', 4242, 10, true)")).toBe(true)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'move_items_exact', 'firearm-magazine', 0, 10, true)")).toBe(false)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'move_items_exact', 'firearm-magazine', 4242, 10, true); game.clear()")).toBe(false)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'harvest_product', 'stone', 6, 128)")).toBe(true)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'set_machine_recipe', 4242, 'iron-gear-wheel')")).toBe(true)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'set_machine_recipe', 0, 'iron-gear-wheel')")).toBe(false)
    expect(isLegacyOperationCommand("remote.call('autorio_operations', 'set_machine_recipe', 4242, 'iron-gear-wheel'); game.clear()")).toBe(false)
  })

  it('escapes strings before rendering Lua', () => {
    const [operation] = parseStructuredOperations([{ name: 'place_entity', args: { entity_name: "mod's-entity" } }])
    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'place_entity', 'mod\\'s-entity')")
  })
})
