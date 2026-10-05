import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { craft_bootstrap_preflight_for_actor, recipe_bootstrap_for_actor } from './bootstrap_planning'

function recipe(name: string, product: string, {
  category = 'crafting',
  ingredient = 'iron-plate',
  ingredientAmount = 1,
}: { category?: string, ingredient?: string, ingredientAmount?: number } = {}) {
  return {
    name,
    enabled: true,
    hidden: false,
    category,
    additional_categories: [],
    ingredients: [{ type: 'item', name: ingredient, amount: ingredientAmount }],
    products: [{ type: 'item', name: product, amount: 1 }],
  }
}

function actorWith(recipes: Record<string, any>, inventory: Record<string, number>, craftable: Record<string, number> = {}) {
  return {
    is_valid: true,
    force: { recipes },
    character: {
      prototype: {
        crafting_categories: { crafting: true },
      },
    },
    get_main_inventory: () => ({
      get_item_count: (name: string) => inventory[name] ?? 0,
    }),
    get_craftable_count: (name: string) => craftable[name] ?? 0,
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, string>>) => {
    const category = filters[0]?.crafting_category
    if (category !== 'smelting') return {}
    return {
      'stone-furnace': {
        name: 'stone-furnace',
        type: 'furnace',
        items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
      },
    }
  }
})

describe('recipe bootstrap dependency closure', () => {
  it('resolves ore-present/plate-missing gear bootstrap to processing plate before gear craft', () => {
    const recipes = {
      'iron-gear-wheel': recipe('iron-gear-wheel', 'iron-gear-wheel', { ingredient: 'iron-plate', ingredientAmount: 2 }),
      'iron-plate': recipe('iron-plate', 'iron-plate', { category: 'smelting', ingredient: 'iron-ore', ingredientAmount: 1 }),
    }
    const actor = actorWith(recipes, {
      'iron-ore': 20,
      coal: 10,
      'stone-furnace': 4,
      'iron-plate': 0,
      'iron-gear-wheel': 0,
    })

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-gear-wheel', 3) as any

    expect(result.ok).toBe(false)
    expect(result.code).toBe('bootstrap_dependency_unresolved')
    expect(result.bootstrap.inventory_overlay.ingredients).toContainEqual({
      type: 'item',
      name: 'iron-plate',
      required: 6,
      held: 0,
      missing: 6,
      status: 'needs_acquisition/processing',
    })
    expect(result.bootstrap.first_unresolved).toMatchObject({
      name: 'iron-plate',
      status: 'needs_acquisition/processing',
      resolution: { kind: 'processing', recipe_name: 'iron-plate', crafts_needed: 6 },
      machine_dependency: {
        required: 1,
        held: 4,
        status: 'already_satisfied',
        satisfaction_scope: 'inventory_acquisition',
        placed_instance_required: true,
      },
    })
  })

  it('treats an already-held compatible processing machine as satisfied instead of crafting a duplicate', () => {
    const smelting = recipe('smelt-widget', 'plate-x', { category: 'smelting', ingredient: 'ore-x', ingredientAmount: 1 })
    const actor = actorWith({ 'smelt-widget': smelting }, { 'ore-x': 8, 'stone-furnace': 4 })

    const result = recipe_bootstrap_for_actor(actor, smelting, 4)

    expect(result.inventory_overlay.machine_dependency).toMatchObject({
      required: 1,
      held: 4,
      status: 'already_satisfied',
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
    })
    expect(result.inventory_overlay.machine_dependency?.selected_item_dependency).toBeUndefined()
  })

  it('subtracts partially held ingredients and bootstraps only the missing quantity', () => {
    const widget = recipe('widget', 'widget', { ingredient: 'plate-x', ingredientAmount: 3 })
    const actor = actorWith({ widget }, { 'plate-x': 2 })

    const result = recipe_bootstrap_for_actor(actor, widget, 2)

    expect(result.inventory_overlay.ingredients).toEqual([{
      type: 'item',
      name: 'plate-x',
      required: 6,
      held: 2,
      missing: 4,
      status: 'needs_acquisition/processing',
    }])
    expect(result.first_unresolved).toMatchObject({
      name: 'plate-x',
      required: 6,
      held: 2,
      missing: 4,
    })
  })

  it('keeps directly craftable requests on the direct craft path', () => {
    const widget = recipe('widget', 'widget', { ingredient: 'plate-x', ingredientAmount: 1 })
    const actor = actorWith({ widget }, { 'plate-x': 5 }, { widget: 5 })

    const result = craft_bootstrap_preflight_for_actor(actor, 'widget', 3) as any

    expect(result.ok).toBe(true)
    expect(result.craftable_now_count).toBe(5)
    expect(result.bootstrap.craftable_now).toBe(true)
    expect(result.bootstrap.first_unresolved).toBeUndefined()
  })

  it('names the unlocking technology and the next research node when the recipe is locked (still a terminal refusal)', () => {
    ;(globalThis as any).prototypes.technology = {
      'unlock-tech': { research_trigger: { type: 'craft-item', item: { name: 'plate-x' }, count: 10 } },
    }
    const locked = { ...recipe('locked-widget', 'locked-widget'), enabled: false }
    const technology = (name: string, prerequisites: Record<string, any> = {}, unlocks: string[] = []) => ({
      name,
      level: 1,
      researched: false,
      enabled: true,
      prerequisites,
      prototype: { max_level: 1, effects: unlocks.map(recipe_name => ({ type: 'unlock-recipe', recipe: recipe_name })) },
      research_unit_count: 10,
      research_unit_energy: 30,
      research_unit_ingredients: [{ name: 'pack-x', amount: 1 }],
    })
    const base = technology('base-tech')
    const unlock = technology('unlock-tech', { 'base-tech': base }, ['locked-widget'])
    const actor = actorWith({ 'locked-widget': locked }, { 'plate-x': 5 }, { 'locked-widget': 5 })
    ;(actor.force as any).research_enabled = true
    ;(actor.force as any).technologies = { 'base-tech': base, 'unlock-tech': unlock }

    const result = craft_bootstrap_preflight_for_actor(actor, 'locked-widget', 1) as any

    expect(result).toMatchObject({ ok: false, code: 'recipe_locked', identity: 'locked-widget', recipe_name: 'locked-widget' })
    expect(result.unlock).toMatchObject({
      unlocked_by: 'unlock-tech',
      pending_count: 2,
      next_actionable: { name: 'base-tech', mode: 'science', status: 'ready' },
    })

    ;(actor.force as any).technologies = {}
    const orphan = craft_bootstrap_preflight_for_actor(actor, 'locked-widget', 1) as any
    expect(orphan).toMatchObject({ ok: false, code: 'recipe_locked', unlock: { unlock_unknown: true } })
  })

  it('uses the live place-item count when bootstrapping a missing compatible machine', () => {
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, string>>) => {
      if (filters[0]?.crafting_category !== 'processing-x') return {}
      return {
        'processor-x': {
          name: 'processor-x',
          type: 'assembling-machine',
          items_to_place_this: [{ name: 'processor-kit', count: 2 }],
        },
      }
    }

    const processing = recipe('process-widget', 'plate-x', {
      category: 'processing-x',
      ingredient: 'ore-x',
      ingredientAmount: 1,
    })
    const actor = actorWith({ 'process-widget': processing }, { 'ore-x': 8, 'processor-kit': 1 })

    const result = recipe_bootstrap_for_actor(actor, processing, 1)

    expect(result.inventory_overlay.machine_dependency).toMatchObject({
      required: 1,
      held: 0,
      status: 'needs_acquisition/processing',
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
      candidates: [{
        name: 'processor-x',
        held_count: 0,
        place_items: [{ name: 'processor-kit', count: 2 }],
      }],
      selected_item_dependency: {
        name: 'processor-kit',
        required: 2,
        held: 1,
        missing: 1,
        role: 'crafting_machine',
      },
    })
    expect(result.first_unresolved).toMatchObject({
      name: 'processor-kit',
      required: 2,
      held: 1,
      missing: 1,
      role: 'crafting_machine',
    })
  })

})
