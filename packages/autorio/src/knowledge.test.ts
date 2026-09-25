import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entity_geometry_for_actor, mining_details_for_actor, recipe_details_for_actor } from './knowledge'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function recipe(name: string, options: {
  enabled?: boolean
  categories: string[]
  energy: number
  ingredients: Array<Record<string, unknown>>
  products: Array<Record<string, unknown>>
  hidden_from_player_crafting?: boolean
}) {
  return {
    name,
    enabled: options.enabled ?? true,
    hidden: false,
    energy: options.energy,
    category: options.categories[0],
    additional_categories: options.categories.slice(1),
    ingredients: options.ingredients,
    products: options.products,
    prototype: {
      hidden_from_player_crafting: options.hidden_from_player_crafting ?? false,
    },
  }
}

describe('recipe knowledge', () => {
  const originalPairs = (globalThis as any).pairs
  const originalGetEntityFiltered = (globalThis as any).prototypes.get_entity_filtered
  const originalRecipeCategory = (globalThis as any).prototypes.recipe_category

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).prototypes.recipe_category = {
      crafting: { name: 'crafting' },
      'oil-processing': { name: 'oil-processing' },
    }
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, unknown>>) => {
      const category = filters[0]?.crafting_category
      if (category === 'oil-processing') {
        return {
          'refinery-z': {
            type: 'assembling-machine',
            get_crafting_speed: () => 2,
            get_max_energy_usage: () => 7000,
            electric_energy_source_prototype: {},
            crafting_categories: { 'oil-processing': true },
          },
          'refinery-a': {
            type: 'assembling-machine',
            get_crafting_speed: () => 1,
            get_max_energy_usage: () => 7000,
            electric_energy_source_prototype: {},
            crafting_categories: { 'oil-processing': true },
          },
        }
      }
      if (category === 'crafting') {
        return {
          'assembling-machine-1': {
            type: 'assembling-machine',
            get_crafting_speed: () => 0.5,
            get_max_energy_usage: () => 1250,
            electric_energy_source_prototype: {},
            crafting_categories: { crafting: true },
          },
        }
      }
      return {}
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.recipe_category = originalRecipeCategory
    ;(globalThis as any).prototypes.get_entity_filtered = originalGetEntityFiltered
  })

  it('returns detailed fluid recipe data and deterministic compatible machines', () => {
    const advancedOil = recipe('advanced-oil-processing', {
      categories: ['oil-processing'],
      energy: 5,
      ingredients: [
        { type: 'fluid', name: 'crude-oil', amount: 100, fluidbox_index: 1 },
        { type: 'fluid', name: 'water', amount: 50, fluidbox_index: 2 },
      ],
      products: [
        { type: 'fluid', name: 'heavy-oil', amount: 25, fluidbox_index: 1, independent_probability: 1 },
        { type: 'fluid', name: 'petroleum-gas', amount: 55, fluidbox_index: 3, independent_probability: 1 },
      ],
    })
    const actor = {
      is_valid: true,
      force: { recipes: { 'advanced-oil-processing': advancedOil } },
      character: { prototype: { crafting_categories: { crafting: true }, get_crafting_speed: () => 1 } },
    } as any

    const result = recipe_details_for_actor(actor, 'advanced-oil-processing') as any
    expect(result.found).toBe(true)
    expect(result.recipes).toHaveLength(1)
    expect(result.recipes[0]).toMatchObject({
      name: 'advanced-oil-processing',
      enabled: true,
      energy: 5,
      categories: ['oil-processing'],
      hand_craftable_category: false,
      ingredients: [
        { type: 'fluid', name: 'crude-oil', amount: 100, fluidbox_index: 1 },
        { type: 'fluid', name: 'water', amount: 50, fluidbox_index: 2 },
      ],
      products: expect.arrayContaining([
        expect.objectContaining({ type: 'fluid', name: 'petroleum-gas', amount: 55, fluidbox_index: 3 }),
      ]),
      crafting_machines: [
        expect.objectContaining({ name: 'refinery-a', type: 'assembling-machine' }),
        expect.objectContaining({ name: 'refinery-z', type: 'assembling-machine' }),
      ],
    })
    // Speed 2 on a 5 s recipe: 0.4 crafts/s, so 55 petroleum per craft is 1320/min.
    expect(result.recipes[0].crafting_machines[1]).toMatchObject({
      crafting_speed: 2,
      seconds_per_craft: 2.5,
      crafts_per_second: 0.4,
      energy_source: 'electric',
      energy_watts: 420000,
    })
    expect(result.recipes[0].crafting_machines[1].products_per_minute).toEqual([
      { type: 'fluid', name: 'heavy-oil', per_minute: 600 },
      { type: 'fluid', name: 'petroleum-gas', per_minute: 1320 },
    ])
    // Oil processing is not a hand-crafting category.
    expect(result.recipes[0].hand_crafting).toBeUndefined()
  })

  it('resolves an item/fluid name through recipe products when recipe names differ', () => {
    const alternate = recipe('make-widget-with-a-different-name', {
      categories: ['crafting'],
      energy: 2,
      ingredients: [{ type: 'item', name: 'iron-plate', amount: 2 }],
      products: [{ type: 'item', name: 'widget', amount: 1, independent_probability: 1 }],
    })
    const actor = {
      is_valid: true,
      force: { recipes: { 'make-widget-with-a-different-name': alternate } },
      character: { prototype: { crafting_categories: { crafting: true }, get_crafting_speed: () => 1 } },
      get_main_inventory: () => ({ get_item_count: () => 0 }),
      get_craftable_count: () => 0,
    } as any

    const result = recipe_details_for_actor(actor, 'widget') as any
    expect(result.found).toBe(true)
    expect(result.recipes[0].name).toBe('make-widget-with-a-different-name')
    expect(result.recipes[0].hand_craftable_category).toBe(true)
    expect(result.recipes[0].crafting_machines[0].name).toBe('assembling-machine-1')
  })

  it('reports a bounded not-found result without inventing recipe knowledge', () => {
    const actor = {
      is_valid: true,
      force: { recipes: {} },
      character: { prototype: { crafting_categories: { crafting: true }, get_crafting_speed: () => 1 } },
    } as any

    expect(recipe_details_for_actor(actor, 'does-not-exist')).toEqual({
      found: false,
      query: 'does-not-exist',
      error: 'no recipe produces this item/fluid and no recipe has this name',
    })
  })
})

describe('mining knowledge', () => {
  const originalPairs = (globalThis as any).pairs
  const originalGetEntityFiltered = (globalThis as any).prototypes.get_entity_filtered
  const originalItems = (globalThis as any).prototypes.item

  // Factorio 2.0 base values: iron ore mines in 1 s; the burner drill has speed
  // 0.25 at 150 kW burner, the electric drill 0.5; the character mines at 0.5.
  const ironOre = {
    name: 'iron-ore',
    type: 'resource',
    resource_category: 'basic-solid',
    infinite_resource: false,
    mineable_properties: { mining_time: 1, products: [{ type: 'item', name: 'iron-ore', amount: 1, probability: 1 }] },
  }
  const crudeOil = {
    name: 'crude-oil',
    type: 'resource',
    resource_category: 'basic-fluid',
    infinite_resource: true,
    normal_resource_amount: 300000,
    mineable_properties: { mining_time: 1, products: [{ type: 'fluid', name: 'crude-oil', amount: 10, probability: 1 }] },
  }
  const drills = {
    'electric-mining-drill': {
      name: 'electric-mining-drill',
      type: 'mining-drill',
      mining_speed: 0.5,
      uses_force_mining_productivity_bonus: true,
      resource_categories: { 'basic-solid': true },
      get_max_energy_usage: () => 1500,
      electric_energy_source_prototype: {},
    },
    'burner-mining-drill': {
      name: 'burner-mining-drill',
      type: 'mining-drill',
      mining_speed: 0.25,
      uses_force_mining_productivity_bonus: true,
      resource_categories: { 'basic-solid': true },
      get_max_energy_usage: () => 2500,
      burner_prototype: { effectivity: 1, fuel_categories: { chemical: true } },
    },
    'pumpjack': {
      name: 'pumpjack',
      type: 'mining-drill',
      mining_speed: 1,
      uses_force_mining_productivity_bonus: true,
      resource_categories: { 'basic-fluid': true },
      get_max_energy_usage: () => 1500,
      electric_energy_source_prototype: {},
    },
  }

  function actor(force: Record<string, number> = {}) {
    return {
      is_valid: true,
      force: { mining_drill_productivity_bonus: 0, manual_mining_speed_modifier: 0, ...force },
      character: {
        character_mining_speed_modifier: 0,
        prototype: { mining_speed: 0.5, resource_categories: { 'basic-solid': true } },
      },
    } as any
  }

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, unknown>>) => {
      if (filters[0]?.type === 'resource') return { 'iron-ore': ironOre, 'crude-oil': crudeOil }
      if (filters[0]?.type === 'mining-drill') return drills
      return {}
    }
    ;(globalThis as any).prototypes.item = {
      ...originalItems,
      coal: { name: 'coal', fuel_category: 'chemical', fuel_value: 4000000 },
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.get_entity_filtered = originalGetEntityFiltered
    ;(globalThis as any).prototypes.item = originalItems
  })

  it('gives mining time, per-drill ore per minute and burner fuel per minute', () => {
    const result = mining_details_for_actor(actor(), 'iron-ore', 'coal') as any
    expect(result.found).toBe(true)
    expect(result.resources).toHaveLength(1)
    const ore = result.resources[0]
    expect(ore).toMatchObject({ name: 'iron-ore', category: 'basic-solid', mining_time: 1, infinite: false, drill_count: 2 })
    expect(ore.drills.map((drill: any) => drill.name)).toEqual(['burner-mining-drill', 'electric-mining-drill'])
    expect(ore.drills[0]).toEqual({
      name: 'burner-mining-drill',
      mining_speed: 0.25,
      productivity_bonus: 0,
      seconds_per_cycle: 4,
      products_per_minute: [{ type: 'item', name: 'iron-ore', per_minute: 15 }],
      energy_source: 'burner',
      energy_watts: 150000,
      burner_effectivity: 1,
      fuel_categories: ['chemical'],
      fuel: { name: 'coal', accepted: true, fuel_value_joules: 4000000, per_minute: 2.25 },
    })
    expect(ore.drills[1].products_per_minute).toEqual([{ type: 'item', name: 'iron-ore', per_minute: 30 }])
    expect(ore.hand_mining).toEqual({
      mining_speed: 0.5,
      seconds_per_cycle: 2,
      products_per_minute: [{ type: 'item', name: 'iron-ore', per_minute: 30 }],
    })
  })

  it('applies the force mining productivity bonus to drills but not to hand mining', () => {
    const result = mining_details_for_actor(actor({ mining_drill_productivity_bonus: 0.2, manual_mining_speed_modifier: 1 }), 'iron-ore') as any
    const ore = result.resources[0]
    expect(ore.drills[0]).toMatchObject({ productivity_bonus: 0.2, products_per_minute: [{ type: 'item', name: 'iron-ore', per_minute: 18 }] })
    expect(ore.drills[0].fuel).toBeUndefined()
    // Manual mining modifier 1 doubles the hand speed; productivity does not apply.
    expect(ore.hand_mining).toMatchObject({ mining_speed: 1, products_per_minute: [{ type: 'item', name: 'iron-ore', per_minute: 60 }] })
  })

  it('flags infinite fluid resources and leaves hand mining out when the character cannot mine them', () => {
    const result = mining_details_for_actor(actor(), 'crude-oil') as any
    const oil = result.resources[0]
    expect(oil).toMatchObject({ name: 'crude-oil', infinite: true, normal_resource_amount: 300000, drill_count: 1 })
    expect(oil.drills[0]).toMatchObject({ name: 'pumpjack', products_per_minute: [{ type: 'fluid', name: 'crude-oil', per_minute: 600 }] })
    expect(oil.hand_mining).toBeUndefined()
  })

  it('reports an unknown resource without inventing one, and points recipe lookups at mining', () => {
    expect(mining_details_for_actor(actor(), 'unobtainium')).toEqual({
      found: false,
      query: 'unobtainium',
      error: 'no resource has this name or yields this item/fluid',
    })
    const recipes = { ...actor(), force: { recipes: {} } } as any
    expect((recipe_details_for_actor(recipes, 'iron-ore') as any).mined_from).toEqual(['iron-ore'])
  })
})

describe('entity geometry knowledge', () => {
  const originalLookup = (globalThis as any).game.get_entity_by_unit_number
  const actor = {
    is_valid: true,
    position: { x: 0, y: 0 },
    surface: { index: 1 },
  } as any

  afterEach(() => {
    ;(globalThis as any).game.get_entity_by_unit_number = originalLookup
  })

  it('returns exact inserter pickup/drop geometry and bound targets', () => {
    const source = {
      valid: true,
      name: 'transport-belt',
      type: 'transport-belt',
      unit_number: 100,
      position: { x: 1, y: 0 },
      direction: 2,
      force: { name: 'player' },
    }
    const destination = {
      valid: true,
      name: 'assembling-machine-1',
      type: 'assembling-machine',
      unit_number: 101,
      position: { x: 3, y: 0 },
      direction: 0,
      force: { name: 'player' },
    }
    const inserter = {
      valid: true,
      name: 'inserter',
      type: 'inserter',
      unit_number: 42,
      position: { x: 2, y: 0 },
      direction: 2,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      pickup_position: { x: 1, y: 0 },
      drop_position: { x: 3, y: 0 },
      pickup_target: source,
      drop_target: destination,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => inserter

    expect(entity_geometry_for_actor(actor, 42)).toMatchObject({
      found: true,
      distance: 2,
      entity: { name: 'inserter', unit_number: 42, position: { x: 2, y: 0 } },
      item_io: {
        pickup_position: { x: 1, y: 0 },
        drop_position: { x: 3, y: 0 },
        pickup_target: { name: 'transport-belt', unit_number: 100 },
        drop_target: { name: 'assembling-machine-1', unit_number: 101 },
      },
      fluid_storages: [],
    })
  })

  it('returns mining-drill output position without inventing an input point', () => {
    const drill = {
      valid: true,
      name: 'electric-mining-drill',
      type: 'mining-drill',
      unit_number: 50,
      position: { x: 10, y: 5 },
      direction: 4,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      drop_position: { x: 10, y: 7 },
      drop_target: undefined,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => drill

    const result = entity_geometry_for_actor(actor, 50) as any
    expect(result.item_io).toEqual({
      drop_position: { x: 10, y: 7 },
      drop_target: undefined,
    })
    expect(result.item_io.pickup_position).toBeUndefined()
  })

  it('returns rotated absolute fluid connection positions, production roles, and connected targets', () => {
    const pipe = {
      valid: true,
      name: 'pipe',
      type: 'pipe',
      unit_number: 90,
      position: { x: 21, y: 20 },
      direction: 0,
      force: { name: 'player' },
    }
    const fluidbox = {
      length: 2,
      get_capacity: (index: number) => index === 1 ? 100 : 200,
      get_prototype: (index: number) => index === 1
        ? { index: 1, production_type: 'input', filter: undefined }
        : { index: 2, production_type: 'output', filter: { name: 'sulfuric-acid' } },
      get_pipe_connections: (index: number) => index === 1
        ? [{
            flow_direction: 'input',
            connection_type: 'normal',
            position: { x: 19, y: 20 },
            target_position: { x: 18, y: 20 },
          }]
        : [{
            flow_direction: 'output',
            connection_type: 'normal',
            position: { x: 21, y: 20 },
            target_position: { x: 22, y: 20 },
            target: { owner: pipe },
            target_fluidbox_index: 1,
            target_pipe_connection_index: 1,
          }],
    }
    const chemicalPlant = {
      valid: true,
      name: 'chemical-plant',
      type: 'assembling-machine',
      unit_number: 77,
      position: { x: 20, y: 20 },
      direction: 2,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 2,
      fluidbox,
      get_fluid: (index: number) => index === 1 ? { name: 'water', amount: 40, temperature: 15 } : undefined,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => chemicalPlant

    const result = entity_geometry_for_actor(actor, 77) as any
    expect(result).toMatchObject({
      fluid_storage_count: 2,
      fluid_box_count: 2,
      non_fluidbox_storage_count: 0,
    })
    expect(result.fluid_storages).toHaveLength(2)
    expect(result.fluid_storages[0]).toMatchObject({
      index: 1,
      capacity: 100,
      current_fluid: { name: 'water', amount: 40, temperature: 15 },
      prototypes: [{ index: 1, production_type: 'input' }],
      pipe_connections: [{
        flow_direction: 'input',
        position: { x: 19, y: 20 },
        target_position: { x: 18, y: 20 },
      }],
    })
    expect(result.fluid_storages[1]).toMatchObject({
      prototypes: [{ index: 2, production_type: 'output', filter: 'sulfuric-acid' }],
      pipe_connections: [{
        flow_direction: 'output',
        position: { x: 21, y: 20 },
        target: { name: 'pipe', unit_number: 90 },
      }],
    })
  })

  it('reports fluid storage that is not exposed through LuaFluidBox without probing an invalid port', () => {
    const entity = {
      valid: true,
      name: 'fluid-wagon',
      type: 'fluid-wagon',
      unit_number: 81,
      position: { x: 4, y: 4 },
      direction: 0,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 1,
      fluidbox: { length: 0 },
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => entity

    expect(entity_geometry_for_actor(actor, 81)).toMatchObject({
      found: true,
      fluid_storage_count: 1,
      fluid_box_count: 0,
      non_fluidbox_storage_count: 1,
      fluid_storages: [],
    })
  })

  it('fails closed for invalid ids, missing entities, and another surface', () => {
    expect(entity_geometry_for_actor(actor, 0)).toMatchObject({ found: false, error: 'invalid unit_number' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
    expect(entity_geometry_for_actor(actor, 999)).toMatchObject({ found: false, error: 'entity not found' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => ({
      valid: true,
      surface: { index: 2 },
    })
    expect(entity_geometry_for_actor(actor, 999)).toMatchObject({ found: false, error: 'entity is on another surface' })
  })
})
