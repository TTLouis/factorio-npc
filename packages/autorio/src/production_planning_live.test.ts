import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { solve_live_production } from './production_planning_live'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function recipe({
  name,
  enabled = true,
  hidden = false,
  energy = 0.5,
  category = 'crafting',
  additional_categories = [],
  ingredients = [],
  products = [],
}: {
  name: string
  enabled?: boolean
  hidden?: boolean
  energy?: number
  category?: string
  additional_categories?: string[]
  ingredients?: Array<Record<string, unknown>>
  products?: Array<Record<string, unknown>>
}) {
  return { name, enabled, hidden, energy, category, additional_categories, ingredients, products }
}

function actorWith(recipes: Record<string, unknown>) {
  return {
    is_valid: true,
    force: { index: 1, recipes },
  } as unknown as ControlledActor
}

function baseRecipes() {
  return {
    'copper-cable': recipe({
      name: 'copper-cable',
      ingredients: [{ type: 'item', name: 'copper-plate', amount: 1 }],
      products: [{ type: 'item', name: 'copper-cable', amount: 2 }],
    }),
    'electronic-circuit': recipe({
      name: 'electronic-circuit',
      ingredients: [
        { type: 'item', name: 'iron-plate', amount: 1 },
        { type: 'item', name: 'copper-cable', amount: 3 },
      ],
      products: [{ type: 'item', name: 'electronic-circuit', amount: 1 }],
    }),
  }
}

describe('live production planning adapter', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).prototypes = {
      entity: {
        'assembling-machine-1': {
          name: 'assembling-machine-1',
          type: 'assembling-machine',
          crafting_speed: 0.5,
          crafting_categories: { crafting: true },
        },
        'assembling-machine-2': {
          name: 'assembling-machine-2',
          type: 'assembling-machine',
          crafting_speed: 0.75,
          crafting_categories: { crafting: true },
        },
        'chemical-plant': {
          name: 'chemical-plant',
          type: 'assembling-machine',
          crafting_speed: 1,
          crafting_categories: { chemistry: true },
        },
      },
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes = originalPrototypes
  })

  it('discovers the unique enabled recipe chain from live force recipes', () => {
    const result = solve_live_production(actorWith(baseRecipes()), {
      calculation_id: 'live-auto',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.external_inputs).toEqual([
      { type: 'item', name: 'copper-plate', rate_per_second: 15 },
      { type: 'item', name: 'iron-plate', rate_per_second: 10 },
    ])
    expect(result.recipe_rates.map(item => item.recipe_name)).toEqual(['copper-cable', 'electronic-circuit'])
    expect(result.fully_sized).toBe(false)
    expect(result.evidence_ids_used).toEqual(['engine:recipe:copper-cable', 'engine:recipe:electronic-circuit'])
  })

  it('does not let bootstrap inventory erase steady-state continuous-production inputs', () => {
    const actor = {
      ...actorWith(baseRecipes()),
      get_main_inventory: () => ({
        get_item_count: (name: string) => name === 'electronic-circuit' ? 100 : name === 'iron-plate' ? 50 : 0,
      }),
    } as unknown as ControlledActor

    const result = solve_live_production(actor, {
      calculation_id: 'steady-state-ignores-bootstrap-inventory',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.external_inputs).toEqual([
      { type: 'item', name: 'copper-plate', rate_per_second: 15 },
      { type: 'item', name: 'iron-plate', rate_per_second: 10 },
    ])
  })

  it('uses explicit machine selections without silently picking an assembler tier', () => {
    const result = solve_live_production(actorWith(baseRecipes()), {
      calculation_id: 'live-sized',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
      machine_selections: [
        { recipe_name: 'copper-cable', machine_name: 'assembling-machine-2' },
        { recipe_name: 'electronic-circuit', machine_name: 'assembling-machine-2' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fully_sized).toBe(true)
    expect(result.sized_machine_count).toBe(17)
    expect(result.evidence_ids_used).toEqual([
      'engine:prototype:assembling-machine-2',
      'engine:recipe:copper-cable',
      'engine:recipe:electronic-circuit',
    ])
  })

  it('treats an explicit recipe list as the internal project scope boundary', () => {
    const result = solve_live_production(actorWith(baseRecipes()), {
      calculation_id: 'scope-boundary',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
      included_recipe_names: ['electronic-circuit'],
      machine_selections: [
        { recipe_name: 'electronic-circuit', machine_name: 'assembling-machine-2' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recipe_rates.map(item => item.recipe_name)).toEqual(['electronic-circuit'])
    expect(result.external_inputs).toEqual([
      { type: 'item', name: 'copper-cable', rate_per_second: 30 },
      { type: 'item', name: 'iron-plate', rate_per_second: 10 },
    ])
    expect(result.external_inputs.some(item => item.name === 'copper-plate')).toBe(false)
  })

  it('surfaces automatic route ambiguity but allows an explicit bounded route', () => {
    const recipes = {
      ...baseRecipes(),
      'electronic-circuit-alt': recipe({
        name: 'electronic-circuit-alt',
        ingredients: [{ type: 'item', name: 'iron-plate', amount: 2 }],
        products: [{ type: 'item', name: 'electronic-circuit', amount: 1 }],
      }),
    }
    const actor = actorWith(recipes)

    expect(solve_live_production(actor, {
      calculation_id: 'ambiguous-live',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
    })).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_RECIPE' } })

    const explicit = solve_live_production(actor, {
      calculation_id: 'explicit-live',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 10 },
      included_recipe_names: ['copper-cable', 'electronic-circuit'],
    })
    expect(explicit.ok).toBe(true)
    if (!explicit.ok) return
    expect(explicit.external_inputs.find(item => item.name === 'copper-plate')?.rate_per_second).toBeCloseTo(15)
  })

  it('rejects unavailable included recipes and incompatible machine choices', () => {
    const recipes = {
      ...baseRecipes(),
      locked: recipe({
        name: 'locked',
        enabled: false,
        products: [{ type: 'item', name: 'locked-product', amount: 1 }],
      }),
    }
    const actor = actorWith(recipes)

    expect(solve_live_production(actor, {
      calculation_id: 'locked',
      target: { type: 'item', name: 'locked-product', rate_per_second: 1 },
      included_recipe_names: ['locked'],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    expect(solve_live_production(actor, {
      calculation_id: 'bad-machine',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 1 },
      included_recipe_names: ['electronic-circuit'],
      machine_selections: [{ recipe_name: 'electronic-circuit', machine_name: 'chemical-plant' }],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('keeps stochastic live products outside the deterministic v1 domain', () => {
    const actor = actorWith({
      random: recipe({
        name: 'random',
        ingredients: [{ type: 'item', name: 'raw', amount: 1 }],
        products: [{ type: 'item', name: 'target', amount_min: 1, amount_max: 2 }],
      }),
    })

    expect(solve_live_production(actor, {
      calculation_id: 'stochastic',
      target: { type: 'item', name: 'target', rate_per_second: 1 },
    })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PRODUCTION_MODEL', recipe_name: 'random' } })
  })

  it('rejects stale machine selections outside the active recipe scope', () => {
    expect(solve_live_production(actorWith(baseRecipes()), {
      calculation_id: 'stale-selection',
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 1 },
      included_recipe_names: ['electronic-circuit'],
      machine_selections: [{ recipe_name: 'copper-cable', machine_name: 'assembling-machine-2' }],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })
})
