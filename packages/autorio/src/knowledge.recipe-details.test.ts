import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { recipe_details_for_actor } from './knowledge'

function recipe(name: string, product: string, category = 'crafting') {
  return {
    name,
    enabled: true,
    hidden: false,
    energy: 0.5,
    ingredients: [{ type: 'item', name: 'iron-plate', amount: 1 }],
    products: [{ type: 'item', name: product, amount: 1 }],
    prototype: { hidden_from_player_crafting: false },
    category,
    additional_categories: [],
  }
}

function actorWithRecipes(recipes: Record<string, any>, inventory: Record<string, number> = {}, craftable: Record<string, number> = {}) {
  return {
    is_valid: true,
    force: { recipes, manual_crafting_speed_modifier: 0 },
    character: {
      character_crafting_speed_modifier: 0,
      prototype: {
        crafting_categories: { crafting: true },
        get_crafting_speed: () => 1,
      },
    },
    get_main_inventory: () => ({
      get_item_count: (name: string) => inventory[name] ?? 0,
    }),
    get_craftable_count: (name: string) => craftable[name] ?? 0,
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).prototypes.recipe_category = {
    crafting: { name: 'crafting' },
    smelting: { name: 'smelting' },
  }
  ;(globalThis as any).prototypes.get_entity_filtered = () => ({})
})

describe('recipe details use Factorio 2.0 recipe category fields', () => {
  it('returns burner-mining-drill details from the Factorio 2.0 category field', () => {
    const actor = actorWithRecipes({
      'burner-mining-drill': recipe('burner-mining-drill', 'burner-mining-drill'),
    })

    const result = recipe_details_for_actor(actor, 'burner-mining-drill')
    expect(result.found).toBe(true)
    expect(result.recipes[0]).toMatchObject({
      name: 'burner-mining-drill',
      enabled: true,
      categories: ['crafting'],
      hand_craftable_category: true,
    })
  })

  it('includes deterministic additional categories without duplicates', () => {
    const multi = recipe('multi', 'multi') as any
    multi.additional_categories = ['smelting', 'crafting']
    const actor = actorWithRecipes({ multi })

    const result = recipe_details_for_actor(actor, 'multi')
    expect(result.recipes[0].categories).toEqual(['crafting', 'smelting'])
  })

  it('caps compatible machine summaries at eight and reports the full match count', () => {
    const machines: Record<string, any> = {}
    for (let i = 1; i <= 12; i++) machines[`assembler-${String(i).padStart(2, '0')}`] = {
      name: `assembler-${String(i).padStart(2, '0')}`,
      type: 'assembling-machine',
      get_crafting_speed: () => i,
      get_max_energy_usage: () => 1250,
      electric_energy_source_prototype: {},
    }
    ;(globalThis as any).prototypes.get_entity_filtered = () => machines
    const actor = actorWithRecipes({ widget: recipe('widget', 'widget') })
    const result = recipe_details_for_actor(actor, 'widget') as any
    expect(result.recipes[0].crafting_machine_count).toBe(12)
    expect(result.recipes[0].crafting_machines).toHaveLength(8)
    expect(result.recipes[0].crafting_machines_truncated).toBe(true)
    expect(result.recipes[0].crafting_machines[0]).toEqual({
      name: 'assembler-01',
      type: 'assembling-machine',
      crafting_speed: 1,
      seconds_per_craft: 0.5,
      crafts_per_second: 2,
      products_per_minute: [{ type: 'item', name: 'widget', per_minute: 120 }],
      energy_source: 'electric',
      energy_watts: 75000,
    })
  })

  it('gives each machine its crafting speed, crafts per second and output per minute', () => {
    // Factorio 2.0 values: iron-plate is 3.2 s; stone furnace speed 1 at 90 kW
    // burner; coal 4 MJ.
    const plate = recipe('iron-plate', 'iron-plate', 'smelting') as any
    plate.energy = 3.2
    plate.ingredients = [{ type: 'item', name: 'iron-ore', amount: 1 }]
    ;(globalThis as any).prototypes.get_entity_filtered = () => ({
      'stone-furnace': {
        name: 'stone-furnace',
        type: 'furnace',
        get_crafting_speed: () => 1,
        get_max_energy_usage: () => 1500,
        burner_prototype: { effectivity: 1, fuel_categories: { chemical: true } },
      },
    })
    const originalItems = (globalThis as any).prototypes.item
    ;(globalThis as any).prototypes.item = {
      ...originalItems,
      'coal': { name: 'coal', fuel_category: 'chemical', fuel_value: 4000000 },
      'iron-plate': { name: 'iron-plate' },
    }
    try {
      const actor = actorWithRecipes({ 'iron-plate': plate })
      const result = recipe_details_for_actor(actor, 'iron-plate', 1, 'coal') as any
      expect(result.rate_basis).toContain('excludes modules')
      expect(result.recipes[0].crafting_machines[0]).toEqual({
        name: 'stone-furnace',
        type: 'furnace',
        crafting_speed: 1,
        seconds_per_craft: 3.2,
        crafts_per_second: 0.3125,
        products_per_minute: [{ type: 'item', name: 'iron-plate', per_minute: 18.75 }],
        energy_source: 'burner',
        energy_watts: 90000,
        burner_effectivity: 1,
        fuel_categories: ['chemical'],
        fuel: { name: 'coal', accepted: true, fuel_value_joules: 4000000, per_minute: 1.35 },
      })
      // Smelting is not a hand-crafting category.
      expect(result.recipes[0].hand_crafting).toBeUndefined()

      const refused = recipe_details_for_actor(actor, 'iron-plate', 1, 'iron-plate') as any
      expect(refused.recipes[0].crafting_machines[0].fuel).toEqual({
        name: 'iron-plate', accepted: false, error: 'this burner does not accept this fuel',
      })
    }
    finally {
      ;(globalThis as any).prototypes.item = originalItems
    }
  })

  it('gives hand-craft seconds per craft from the character speed and both crafting modifiers', () => {
    const gear = recipe('iron-gear-wheel', 'iron-gear-wheel') as any
    const actor = actorWithRecipes({ 'iron-gear-wheel': gear }) as any
    actor.force.manual_crafting_speed_modifier = 0.5
    actor.character.character_crafting_speed_modifier = 0.5

    const result = recipe_details_for_actor(actor, 'iron-gear-wheel') as any
    // 0.5 s recipe at speed 1 * (1 + 0.5 + 0.5) = 2.
    expect(result.recipes[0].hand_crafting).toEqual({ crafting_speed: 2, seconds_per_craft: 0.25 })

    gear.prototype.hidden_from_player_crafting = true
    expect((recipe_details_for_actor(actor, 'iron-gear-wheel') as any).recipes[0].hand_crafting).toBeUndefined()
  })

  it('returns another ordinary enabled recipe with deterministic categories', () => {
    const actor = actorWithRecipes({
      'iron-gear-wheel': recipe('iron-gear-wheel', 'iron-gear-wheel'),
    })

    const result = recipe_details_for_actor(actor, 'iron-gear-wheel')
    expect(result.found).toBe(true)
    expect(result.recipes[0].categories).toEqual(['crafting'])
    expect(result.recipes[0].ingredients[0]).toMatchObject({ name: 'iron-plate', amount: 1 })
    expect(result.recipes[0].products[0]).toMatchObject({ name: 'iron-gear-wheel', amount: 1 })
  })

  it('attaches only dependency-relevant inventory counts for the requested craft quantity', () => {
    const gear = recipe('iron-gear-wheel', 'iron-gear-wheel') as any
    gear.ingredients = [{ type: 'item', name: 'iron-plate', amount: 2 }]
    const actor = actorWithRecipes(
      { 'iron-gear-wheel': gear },
      { 'iron-plate': 2, 'iron-gear-wheel': 1, coal: 99, stone: 50 },
    )

    const result = recipe_details_for_actor(actor, 'iron-gear-wheel', 3) as any

    expect(result.recipes[0].requested_crafts).toBe(3)
    expect(result.recipes[0].inventory_overlay.outputs).toEqual([
      { type: 'item', name: 'iron-gear-wheel', required: 3, held: 1 },
    ])
    expect(result.recipes[0].inventory_overlay.ingredients).toEqual([
      { type: 'item', name: 'iron-plate', required: 6, held: 2, missing: 4, status: 'needs_acquisition/processing' },
    ])
    expect(JSON.stringify(result.recipes[0].inventory_overlay)).not.toContain('coal')
    expect(JSON.stringify(result.recipes[0].inventory_overlay)).not.toContain('stone')
  })

  it('does not require JavaScript map methods on runtime recipe ingredient/product arrays', () => {
    const runtimeRecipe = recipe('runtime-array-shape', 'runtime-array-shape') as any
    runtimeRecipe.ingredients.map = undefined
    runtimeRecipe.products.map = undefined
    const actor = actorWithRecipes({ 'runtime-array-shape': runtimeRecipe })

    const result = recipe_details_for_actor(actor, 'runtime-array-shape')
    expect(result.found).toBe(true)
    expect(result.recipes[0].ingredients).toEqual([{ type: 'item', name: 'iron-plate', amount: 1 }])
    expect(result.recipes[0].products).toEqual([{ type: 'item', name: 'runtime-array-shape', amount: 1 }])
  })

  it('treats requested_count as recipe craft executions even when one craft has multiple outputs', () => {
    const batch = recipe('batch-widget', 'widget-x') as any
    batch.products = [{ type: 'item', name: 'widget-x', amount: 2 }]
    const actor = actorWithRecipes(
      { 'batch-widget': batch },
      { 'iron-plate': 3, 'widget-x': 1, unrelated: 77 },
      { 'batch-widget': 3 },
    )

    const result = recipe_details_for_actor(actor, 'batch-widget', 3) as any

    expect(result.recipes[0].requested_crafts).toBe(3)
    expect(result.recipes[0].inventory_overlay.outputs).toEqual([
      { type: 'item', name: 'widget-x', required: 6, held: 1 },
    ])
    expect(result.recipes[0].inventory_overlay.ingredients).toEqual([
      { type: 'item', name: 'iron-plate', required: 3, held: 3, missing: 0, status: 'already_satisfied' },
    ])
    expect(JSON.stringify(result.recipes[0].inventory_overlay)).not.toContain('unrelated')
  })

})
