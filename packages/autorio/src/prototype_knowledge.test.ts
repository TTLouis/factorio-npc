import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ControlledActor } from './actors/types'
import { discover_prototypes_for_actor, prototype_details } from './prototype_knowledge'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function runtimeCollection<T>(values: T[]) {
  const result: Record<number, T> = {}
  for (let index = 0; index < values.length; index++) result[index + 1] = values[index]
  return result
}

describe('prototype build knowledge', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs

    const burnerMiningDrill = {
      name: 'burner-mining-drill',
      type: 'mining-drill',
      is_building: true,
      tile_width: 2,
      tile_height: 2,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'burner-mining-drill', count: 1 }],
      fluidbox_prototypes: [],
      mining_speed: 0.25,
      mining_drill_radius: 1.99,
      resource_categories: { 'basic-solid': true },
      energy_usage: 150000,
      burner_prototype: {},
    }
    const electricMiningDrill = {
      name: 'electric-mining-drill',
      type: 'mining-drill',
      is_building: true,
      tile_width: 3,
      tile_height: 3,
      collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
      selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
      items_to_place_this: [{ name: 'electric-mining-drill', count: 1 }],
      fluidbox_prototypes: [],
      mining_speed: 0.5,
      mining_drill_radius: 2.49,
      resource_categories: { 'basic-solid': true },
      energy_usage: 90000,
      electric_energy_source_prototype: {},
    }
    const chemicalPlant = {
      name: 'chemical-plant',
      type: 'assembling-machine',
      is_building: true,
      tile_width: 3,
      tile_height: 3,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'chemical-plant', count: 1 }],
      // 2.0 prototypes expose only the method; the old field raises in the engine.
      get_crafting_speed: () => 1,
      crafting_categories: { chemistry: true },
      ingredient_count: 3,
      energy_usage: 210000,
      fluidbox_prototypes: [
        { index: 1, production_type: 'input', filter: undefined, minimum_temperature: 15, maximum_temperature: 100, pipe_connections: [{}, {}] },
        { index: 2, production_type: 'output', filter: undefined, pipe_connections: [{}] },
      ],
    }
    const belt = {
      name: 'transport-belt',
      type: 'transport-belt',
      is_building: true,
      tile_width: 1,
      tile_height: 1,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'transport-belt', count: 1 }],
      fluidbox_prototypes: [],
      belt_speed: 0.03125,
      max_underground_distance: undefined,
    }
    const rockA = {
      name: 'mod-rock-a',
      type: 'simple-entity',
      mineable_properties: {
        mining_time: 0.4,
        products: runtimeCollection([{ type: 'item', name: 'stone', amount: 20 }]),
      },
    }
    const rockB = {
      name: 'mod-rock-b',
      type: 'simple-entity',
      mineable_properties: {
        mining_time: 0.6,
        products: runtimeCollection([{ type: 'item', name: 'stone', amount_min: 8, amount_max: 12, probability: 1 }]),
      },
    }
    const treeA = {
      name: 'mod-tree-a',
      type: 'tree',
      mineable_properties: {
        mining_time: 0.5,
        products: runtimeCollection([{ type: 'item', name: 'wood', amount: 4 }]),
      },
    }
    const treeB = {
      name: 'mod-tree-b',
      type: 'tree',
      mineable_properties: {
        mining_time: 0.5,
        products: runtimeCollection([{ type: 'item', name: 'wood', amount: 4 }]),
      },
    }
    const inserter = {
      name: 'inserter',
      type: 'inserter',
      is_building: true,
      tile_width: 1,
      tile_height: 1,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'inserter', count: 1 }],
      fluidbox_prototypes: [],
      inserter_pickup_position: { x: 0, y: -1 },
      inserter_drop_position: { x: 0, y: 1 },
      allow_custom_vectors: false,
      bulk: false,
      inserter_max_belt_stack_size: 1,
      energy_usage: 13000,
    }

    ;(globalThis as any).prototypes = {
      entity: {
        'iron-ore': { name: 'iron-ore', type: 'resource', resource_category: 'basic-solid' },
        'burner-mining-drill': burnerMiningDrill,
        'electric-mining-drill': electricMiningDrill,
        'chemical-plant': chemicalPlant,
        'transport-belt': belt,
        'mod-rock-a': rockA,
        'mod-rock-b': rockB,
        'mod-tree-a': treeA,
        'mod-tree-b': treeB,
        inserter,
      },
      item: {
        'burner-mining-drill': { name: 'burner-mining-drill', stack_size: 50, place_result: burnerMiningDrill },
        'electric-mining-drill': { name: 'electric-mining-drill', stack_size: 50, place_result: electricMiningDrill },
        'chemical-plant': { name: 'chemical-plant', stack_size: 10, place_result: chemicalPlant },
        'transport-belt': { name: 'transport-belt', stack_size: 100, place_result: belt },
        stone: { name: 'stone', stack_size: 50 },
        wood: { name: 'wood', stack_size: 100 },
        inserter: { name: 'inserter', stack_size: 50, place_result: inserter },
      },
      fluid: {
        water: { name: 'water', default_temperature: 15, max_temperature: 100, heat_capacity: 200, fuel_value: 0 },
      },
      resource_category: { 'basic-solid': { name: 'basic-solid' } },
      recipe_category: { crafting: { name: 'crafting' }, chemistry: { name: 'chemistry' } },
      get_entity_filtered: (filters: any[]) => {
        const filter = filters[0]
        if (filter?.filter === 'type' && filter.type === 'mining-drill') {
          return { 'burner-mining-drill': burnerMiningDrill, 'electric-mining-drill': electricMiningDrill }
        }
        if (filter?.filter === 'crafting-category' && filter.crafting_category === 'chemistry') return { 'chemical-plant': chemicalPlant }
        return {}
      },
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes = originalPrototypes
  })

  it('discovers force-available mining prototypes from a resource identity without guessing names', () => {
    const actor = {
      is_valid: true,
      force: {
        recipes: {
          'burner-mining-drill': {
            name: 'burner-mining-drill', enabled: true, hidden: false,
            products: [{ type: 'item', name: 'burner-mining-drill', amount: 1 }],
          },
        },
      },
      get_main_inventory: () => ({ get_contents: () => [] }),
    } as unknown as ControlledActor

    expect(discover_prototypes_for_actor(actor, { capability: 'mining', resource_name: 'iron-ore' })).toMatchObject({
      ok: true,
      inferred_resource_category: 'basic-solid',
      matched_count: 2,
      available_count: 1,
      returned_count: 1,
      candidates: [{
        name: 'burner-mining-drill',
        type: 'mining-drill',
        energy_source: 'burner',
        enabled_recipe: 'burner-mining-drill',
        force_available: true,
      }],
    })
  })

  it('handles runtime-shaped place-item collections without JS array methods or length', () => {
    const drill = (globalThis as any).prototypes.entity['burner-mining-drill']
    drill.items_to_place_this = runtimeCollection([
      { name: 'z-modded-drill-item', count: 1 },
      { name: 'burner-mining-drill', count: 1 },
      { name: 'a-modded-drill-item', count: 2 },
    ])

    const actor = {
      is_valid: true,
      force: {
        recipes: {
          'burner-mining-drill': {
            name: 'burner-mining-drill', enabled: true, hidden: false,
            products: runtimeCollection([{ type: 'item', name: 'burner-mining-drill', amount: 1 }]),
          },
        },
      },
      get_main_inventory: () => ({ get_contents: () => [] }),
    } as unknown as ControlledActor

    const discovery = discover_prototypes_for_actor(actor, { capability: 'mining', resource_name: 'iron-ore' }) as any
    expect(discovery.candidates[0]).toMatchObject({
      name: 'burner-mining-drill',
      place_items: [
        { name: 'a-modded-drill-item', count: 2 },
        { name: 'burner-mining-drill', count: 1 },
      ],
      place_items_truncated: true,
      enabled_recipe: 'burner-mining-drill',
    })
    expect((prototype_details('burner-mining-drill') as any).entity.place_items).toEqual([
      { name: 'a-modded-drill-item', count: 2 },
      { name: 'burner-mining-drill', count: 1 },
      { name: 'z-modded-drill-item', count: 1 },
    ])
  })

  it('returns explicit bounded narrowing evidence instead of dumping oversized candidate sets', () => {
    const entities: Record<string, any> = {}
    for (let i = 1; i <= 13; i++) entities[`mod-drill-${String(i).padStart(2, '0')}`] = {
      name: `mod-drill-${String(i).padStart(2, '0')}`, type: 'mining-drill', resource_categories: { 'basic-solid': true },
      items_to_place_this: [{ name: `mod-drill-${String(i).padStart(2, '0')}`, count: 1 }], electric_energy_source_prototype: {},
    }
    ;(globalThis as any).prototypes.get_entity_filtered = () => entities
    const recipes: Record<string, any> = {}
    for (const name of Object.keys(entities)) recipes[name] = { name, enabled: true, hidden: false, products: [{ type: 'item', name, amount: 1 }] }
    const actor = { is_valid: true, force: { recipes }, get_main_inventory: () => ({ get_contents: () => [] }) } as unknown as ControlledActor

    expect(discover_prototypes_for_actor(actor, { capability: 'mining', resource_name: 'iron-ore', limit: 12 })).toMatchObject({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED' },
      available_count: 13,
      max_limit: 12,
      narrowing: { energy_sources: ['electric'] },
    })
  })

  it('discovers non-resource harvest sources by mined item product across prototype variants', () => {
    const actor = {
      is_valid: true,
      force: { recipes: {} },
      get_main_inventory: () => ({ get_contents: () => [] }),
    } as unknown as ControlledActor

    const stone = discover_prototypes_for_actor(actor, { capability: 'harvest', product_name: 'stone' }) as any
    expect(stone).toMatchObject({
      ok: true,
      matched_count: 2,
      available_count: 2,
      candidates: [
        { name: 'mod-rock-a', type: 'simple-entity' },
        { name: 'mod-rock-b', type: 'simple-entity' },
      ],
    })
    expect(stone.candidates[0].mineable_products).toEqual([{ type: 'item', name: 'stone', amount: 20 }])

    const wood = discover_prototypes_for_actor(actor, { capability: 'harvest', product_name: 'wood' }) as any
    expect(wood.candidates.map((candidate: any) => candidate.name)).toEqual(['mod-tree-a', 'mod-tree-b'])
    expect(wood.candidates.every((candidate: any) => candidate.type === 'tree')).toBe(true)
  })

  it('exposes bounded mineable product data in prototype details', () => {
    expect((prototype_details('mod-rock-b') as any).entity.mineable).toEqual({
      mining_time: 0.6,
      required_fluid: undefined,
      fluid_amount: undefined,
      products: [{
        type: 'item',
        name: 'stone',
        amount: undefined,
        amount_min: 8,
        amount_max: 12,
        probability: 1,
      }],
      products_truncated: false,
    })
  })

  it('describes mining drill footprint, speed, radius and resource categories', () => {
    const result = prototype_details('electric-mining-drill') as any
    expect(result).toMatchObject({
      found: true,
      item: { stack_size: 50, place_result: 'electric-mining-drill' },
      entity: {
        type: 'mining-drill',
        tile_width: 3,
        tile_height: 3,
        place_items: [{ name: 'electric-mining-drill', count: 1 }],
        mining: {
          speed: 0.5,
          radius: 2.49,
          resource_categories: ['basic-solid'],
          energy_usage: 90000,
        },
      },
    })
  })

  it('describes crafting capability and bounded fluidbox roles without dumping Lua objects', () => {
    const result = prototype_details('chemical-plant') as any
    expect(result.entity).toMatchObject({
      crafting: {
        speed: 1,
        categories: ['chemistry'],
        ingredient_count: 3,
        energy_usage: 210000,
      },
      fluidboxes: [
        { index: 1, production_type: 'input', pipe_connection_count: 2 },
        { index: 2, production_type: 'output', pipe_connection_count: 1 },
      ],
      fluidboxes_truncated: false,
    })
  })

  it('describes belt and inserter build rules', () => {
    expect((prototype_details('transport-belt') as any).entity.belt).toEqual({
      speed: 0.03125,
      max_underground_distance: undefined,
    })
    expect((prototype_details('inserter') as any).entity.inserter).toMatchObject({
      pickup_position: { x: 0, y: -1 },
      drop_position: { x: 0, y: 1 },
      allow_custom_vectors: false,
      max_belt_stack_size: 1,
      energy_usage: 13000,
    })
  })

  it('returns fluid prototype details and a bounded missing-prototype result', () => {
    expect(prototype_details('water')).toMatchObject({
      found: true,
      fluid: { name: 'water', default_temperature: 15, max_temperature: 100, heat_capacity: 200 },
    })
    expect(prototype_details('missing-mod-prototype')).toEqual({
      found: false,
      query: 'missing-mod-prototype',
      error: 'prototype not found as item, fluid, or entity',
    })
  })
})
