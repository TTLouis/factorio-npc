import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('machine-only recipes and placed machines', () => {
  const originalDefines = (globalThis as any).defines
  const STATUS = { working: 1, no_power: 2, no_fuel: 3, no_ingredients: 4 }

  beforeEach(() => {
    ;(globalThis as any).defines = { ...originalDefines, entity_status: { ...STATUS } }
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, string>>) => {
      if (filters[0]?.crafting_category !== 'smelting') return {}
      return {
        'stone-furnace': { name: 'stone-furnace', type: 'furnace', items_to_place_this: [{ name: 'stone-furnace', count: 1 }] },
        'electric-furnace': { name: 'electric-furnace', type: 'furnace', items_to_place_this: [{ name: 'electric-furnace', count: 1 }] },
      }
    }
  })

  afterEach(() => {
    ;(globalThis as any).defines = originalDefines
  })

  function placedEntity(unit_number: number, x: number, status: number | undefined, name = 'stone-furnace') {
    return { valid: true, name, type: 'furnace', unit_number, position: { x, y: 0 }, status, to_be_deconstructed: () => false, get_recipe: () => [undefined] }
  }

  function smeltingActor(placed: any[], inventory: Record<string, number> = {}, recipes?: Record<string, any>) {
    const smelting = { ...recipe('iron-plate', 'iron-plate', { category: 'smelting', ingredient: 'iron-ore' }), energy: 3.2 }
    const find = vi.fn((_query: any) => placed)
    const actor = {
      ...actorWith(recipes ?? { 'iron-plate': smelting }, inventory),
      surface: { find_entities_filtered: find },
      position: { x: 0, y: 0 },
    } as unknown as ControlledActor
    ;(actor.force as any).index = 1
    return { actor, find, smelting }
  }

  it('rejects a hand craft of a machine-only recipe with requires_machine and live facts (held and placed machines)', () => {
    const { actor, find } = smeltingActor(
      [placedEntity(11, 9, STATUS.no_fuel), placedEntity(10, 3, STATUS.working)],
      { 'iron-ore': 7, 'electric-furnace': 2 },
    )

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 5) as any

    expect(result).toMatchObject({
      ok: false,
      code: 'requires_machine',
      operation: 'craft_item',
      identity: 'iron-plate',
      recipe_name: 'iron-plate',
      requested_count: 5,
      hand_craftable: false,
    })
    expect(result.recipe).toMatchObject({
      name: 'iron-plate',
      categories: ['smelting'],
      energy: 3.2,
      products: [{ type: 'item', name: 'iron-plate', amount: 1 }],
      ingredients: [{ type: 'item', name: 'iron-ore', amount: 1, held: 7 }],
    })
    expect(result.machines.matched_count).toBe(2)
    expect(result.machines.truncated).toBe(false)
    expect(result.machines.candidates.map((candidate: any) => candidate.name)).toEqual(['electric-furnace', 'stone-furnace'])
    expect(result.machines.held).toEqual([{ name: 'electric-furnace', held_count: 2 }])
    expect(result.machines.placed_count).toBe(2)
    expect(result.machines.placed_working_count).toBe(1)
    expect(result.machines.placed_truncated).toBe(false)
    expect(result.machines.placed_search_radius).toBe(128)
    // Nearest first, each with its own readiness and unit_number.
    expect(result.machines.placed).toEqual([
      { unit_number: 10, name: 'stone-furnace', position: { x: 3, y: 0 }, distance: 3, working: true, readiness: 'working', status_code: STATUS.working },
      { unit_number: 11, name: 'stone-furnace', position: { x: 9, y: 0 }, distance: 9, working: false, readiness: 'no_fuel', status_code: STATUS.no_fuel },
    ])
    // The scan is bounded by radius, force and surface, over only the compatible machine prototypes.
    expect(find).toHaveBeenCalledWith({
      name: ['stone-furnace', 'electric-furnace'],
      force: actor.force,
      position: { x: 0, y: 0 },
      radius: 128,
    })
  })

  it('reports an unmapped or unavailable status honestly instead of calling the machine working', () => {
    const { actor } = smeltingActor([placedEntity(1, 1, 99), placedEntity(2, 2, undefined)])

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any

    expect(result.code).toBe('requires_machine')
    expect(result.machines.placed_working_count).toBe(0)
    expect(result.machines.placed[0]).toMatchObject({ unit_number: 1, working: false, readiness: 'unmapped_status', status_code: 99 })
    expect(result.machines.placed[1]).toMatchObject({ unit_number: 2, working: false, readiness: 'status_unavailable' })
    expect(result.machines.placed[1].status_code).toBeUndefined()
  })

  it('reports no held and no placed machines as empty lists', () => {
    const { actor } = smeltingActor([])

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any

    expect(result.code).toBe('requires_machine')
    expect(result.machines).toMatchObject({ held: [], placed: [], placed_count: 0, placed_working_count: 0, placed_truncated: false })
  })

  it('keeps a hand-craftable recipe on the direct craft path and a locked machine recipe on recipe_locked', () => {
    const widget = recipe('widget', 'widget', { ingredient: 'plate-x' })
    const direct = craft_bootstrap_preflight_for_actor(actorWith({ widget }, { 'plate-x': 5 }, { widget: 5 }), 'widget', 1) as any
    expect(direct.ok).toBe(true)
    expect(direct.code).toBeUndefined()

    const locked = { ...recipe('iron-plate', 'iron-plate', { category: 'smelting' }), enabled: false }
    ;(globalThis as any).prototypes.technology = {}
    const { actor } = smeltingActor([placedEntity(1, 1, STATUS.working)], {}, { 'iron-plate': locked })
    ;(actor.force as any).research_enabled = true
    ;(actor.force as any).technologies = {}
    const refused = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any
    expect(refused.code).toBe('recipe_locked')
    expect(refused.machines).toBeUndefined()

    const unknown = craft_bootstrap_preflight_for_actor(actor, 'no-such-recipe', 1) as any
    expect(unknown).toMatchObject({ ok: false, code: 'unknown_recipe' })
  })

  it('bounds the placed list to the nearest six while counting every machine in range', () => {
    const placed: any[] = []
    for (let i = 1; i <= 10; i++) placed.push(placedEntity(100 + i, 50 - i * 4, i === 3 ? STATUS.working : STATUS.no_ingredients))
    const { actor } = smeltingActor(placed)

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any

    expect(result.machines.placed_count).toBe(10)
    expect(result.machines.placed_working_count).toBe(1)
    expect(result.machines.placed_truncated).toBe(true)
    expect(result.machines.placed).toHaveLength(6)
    // x = 46, 42, ..., 10: the nearest to the origin are unit_numbers 110 down to 105.
    expect(result.machines.placed.map((machine: any) => machine.unit_number)).toEqual([110, 109, 108, 107, 106, 105])
  })

  it('counts a placed compatible furnace as satisfying the machine dependency and reports its readiness separately', () => {
    const { actor, smelting } = smeltingActor([placedEntity(21, 4, STATUS.no_fuel)], { 'iron-ore': 8 })

    const result = recipe_bootstrap_for_actor(actor, smelting, 4)
    const machine = result.inventory_overlay.machine_dependency

    expect(machine).toMatchObject({
      required: 1,
      held: 0,
      status: 'already_satisfied',
      satisfaction_scope: 'placed_instance',
      placed_instance_required: false,
      placed_count: 1,
      placed_working_count: 0,
      placed: [{ unit_number: 21, name: 'stone-furnace', working: false, readiness: 'no_fuel' }],
    })
    // No electric-furnace (or any) acquisition is demanded while a compatible machine already stands.
    expect(machine?.selected_item_dependency).toBeUndefined()
    expect(result.first_unresolved).toBeUndefined()
  })

  it('still demands machine acquisition when no compatible machine is held or placed', () => {
    const { actor, smelting } = smeltingActor([], { 'iron-ore': 8 })

    const machine = recipe_bootstrap_for_actor(actor, smelting, 4).inventory_overlay.machine_dependency

    expect(machine).toMatchObject({
      held: 0,
      status: 'needs_acquisition/processing',
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
      placed_count: 0,
      placed: [],
      selected_item_dependency: { name: 'electric-furnace', role: 'crafting_machine' },
    })
  })

  it('keeps held-only machines at inventory scope and prefers the placed scope when both exist', () => {
    const held = smeltingActor([], { 'stone-furnace': 3 })
    expect(recipe_bootstrap_for_actor(held.actor, held.smelting, 1).inventory_overlay.machine_dependency).toMatchObject({
      held: 3,
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
      placed_count: 0,
    })

    const both = smeltingActor([placedEntity(5, 2, STATUS.working)], { 'stone-furnace': 3 })
    expect(recipe_bootstrap_for_actor(both.actor, both.smelting, 1).inventory_overlay.machine_dependency).toMatchObject({
      held: 3,
      satisfaction_scope: 'placed_instance',
      placed_instance_required: false,
      placed_count: 1,
      placed_working_count: 1,
      placed: [{ unit_number: 5, readiness: 'working', working: true }],
    })
  })

  it('searches placed machines across every compatible prototype even when the candidate report is truncated', () => {
    const machines: Record<string, any> = {}
    for (let i = 1; i <= 12; i++) {
      const name = `kiln-${String(i).padStart(2, '0')}`
      machines[name] = { name, type: 'furnace', items_to_place_this: [{ name, count: 1 }] }
    }
    ;(globalThis as any).prototypes.get_entity_filtered = () => machines
    const { actor, find } = smeltingActor([placedEntity(7, 1, STATUS.working, 'kiln-12')])

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any

    expect(result.machines.matched_count).toBe(12)
    expect(result.machines.truncated).toBe(true)
    expect(result.machines.candidates).toHaveLength(8)
    expect((find.mock.calls[0] as any)[0].name).toHaveLength(12)
    expect(result.machines.placed).toMatchObject([{ unit_number: 7, name: 'kiln-12', readiness: 'working' }])
  })

  it('excludes machines marked for deconstruction from placed and counts them separately', () => {
    const marked = { ...placedEntity(31, 1, STATUS.working), to_be_deconstructed: () => true }
    const live = placedEntity(32, 6, STATUS.no_fuel)
    const { actor } = smeltingActor([marked, live])

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any

    expect(result.machines.placed_count).toBe(1)
    expect(result.machines.placed_working_count).toBe(0)
    expect(result.machines.placed_marked_for_deconstruction_count).toBe(1)
    expect(result.machines.placed.map((machine: any) => machine.unit_number)).toEqual([32])
  })

  it('does not let a machine marked for deconstruction satisfy the placed_instance dependency', () => {
    const marked = { ...placedEntity(31, 1, STATUS.working), to_be_deconstructed: () => true }
    const { actor, smelting } = smeltingActor([marked], { 'iron-ore': 8 })

    const machine = recipe_bootstrap_for_actor(actor, smelting, 2).inventory_overlay.machine_dependency

    expect(machine).toMatchObject({
      held: 0,
      status: 'needs_acquisition/processing',
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
      placed_count: 0,
      placed_marked_for_deconstruction_count: 1,
      placed: [],
      selected_item_dependency: { name: 'electric-furnace' },
    })
  })

  it('reports the current recipe of placed crafting machines so a wrong-recipe assembler is visible', () => {
    const assembler = {
      ...placedEntity(51, 2, STATUS.no_ingredients, 'assembler-x'),
      type: 'assembling-machine',
      get_recipe: () => [{ name: 'iron-gear-wheel' }],
    }
    const blankAssembler = { ...assembler, unit_number: 52, position: { x: 3, y: 0 }, get_recipe: () => [undefined] }
    const idleFurnace = { ...placedEntity(53, 4, STATUS.no_ingredients), previous_recipe: { name: 'iron-plate' } }
    const smeltingFurnace = { ...placedEntity(54, 5, STATUS.working), get_recipe: () => [{ name: 'copper-plate' }] }
    const chest = { ...placedEntity(55, 6, undefined, 'storage-x'), type: 'container', get_recipe: () => { throw new Error('not a crafting machine') } }
    const { actor } = smeltingActor([assembler, blankAssembler, idleFurnace, smeltingFurnace, chest])

    const result = craft_bootstrap_preflight_for_actor(actor, 'iron-plate', 1) as any
    const byUnit: Record<number, any> = {}
    for (const machine of result.machines.placed) byUnit[machine.unit_number] = machine

    expect(byUnit[51].recipe_name).toBe('iron-gear-wheel')
    expect(byUnit[52].recipe_name).toBeUndefined()
    expect(byUnit[52].previous_recipe_name).toBeUndefined()
    expect(byUnit[53].recipe_name).toBeUndefined()
    expect(byUnit[53].previous_recipe_name).toBe('iron-plate')
    expect(byUnit[54].recipe_name).toBe('copper-plate')
    expect(byUnit[54].previous_recipe_name).toBeUndefined()
    expect(byUnit[55].recipe_name).toBeUndefined()
  })
})
