import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { solve_live_production_candidates } from './production_planning_candidates_live'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function recipe({
  name,
  ingredients = [],
  products = [],
}: {
  name: string
  ingredients?: Array<Record<string, unknown>>
  products?: Array<Record<string, unknown>>
}) {
  return {
    name,
    enabled: true,
    hidden: false,
    energy: 1,
    category: 'crafting', additional_categories: [],
    ingredients,
    products,
  }
}

function actorWith(recipes: Record<string, unknown>) {
  return {
    is_valid: true,
    force: { index: 1, recipes },
  } as unknown as ControlledActor
}

function candidateSolutions(result: ReturnType<typeof solve_live_production_candidates>) {
  expect(result.ok).toBe(true)
  if (!result.ok || !('candidates' in result)) throw new Error('expected production route candidates')
  return result.candidates
}

function externalRate(candidate: ReturnType<typeof candidateSolutions>[number], name: string) {
  const input = candidate.solution.external_inputs.find(item => item.name === name)
  if (!input) throw new Error(`missing external input ${name}`)
  return input.rate_per_second
}

describe('live production route candidate solver', () => {
  const originalPairs = (globalThis as any).pairs

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
  })

  it('returns deterministic exact candidates instead of failing on a top-level recipe ambiguity', () => {
    const actor = actorWith({
      'route-a': recipe({
        name: 'route-a',
        ingredients: [{ type: 'item', name: 'raw-a', amount: 2 }],
        products: [{ type: 'item', name: 'target', amount: 1 }],
      }),
      'route-b': recipe({
        name: 'route-b',
        ingredients: [{ type: 'item', name: 'raw-b', amount: 3 }],
        products: [{ type: 'item', name: 'target', amount: 2 }],
      }),
    })

    const candidates = candidateSolutions(solve_live_production_candidates(actor, {
      calculation_id: 'two-routes',
      target: { type: 'item', name: 'target', rate_per_second: 4 },
    }))

    expect(candidates.map(item => item.route_recipe_names)).toEqual([
      ['route-a'],
      ['route-b'],
    ])
    expect(candidates.map(item => item.route_choices)).toEqual([
      [{ material: { type: 'item', name: 'target', rate_per_second: 4 }, recipe_name: 'route-a' }],
      [{ material: { type: 'item', name: 'target', rate_per_second: 4 }, recipe_name: 'route-b' }],
    ])
    expect(externalRate(candidates[0], 'raw-a')).toBeCloseTo(8)
    expect(externalRate(candidates[1], 'raw-b')).toBeCloseTo(6)
  })

  it('solves nested alternative recipes locally before returning candidates', () => {
    const actor = actorWith({
      target: recipe({
        name: 'target',
        ingredients: [{ type: 'item', name: 'intermediate', amount: 2 }],
        products: [{ type: 'item', name: 'target', amount: 1 }],
      }),
      'intermediate-a': recipe({
        name: 'intermediate-a',
        ingredients: [{ type: 'item', name: 'raw-a', amount: 1 }],
        products: [{ type: 'item', name: 'intermediate', amount: 1 }],
      }),
      'intermediate-b': recipe({
        name: 'intermediate-b',
        ingredients: [{ type: 'item', name: 'raw-b', amount: 3 }],
        products: [{ type: 'item', name: 'intermediate', amount: 2 }],
      }),
    })

    const candidates = candidateSolutions(solve_live_production_candidates(actor, {
      calculation_id: 'nested-routes',
      target: { type: 'item', name: 'target', rate_per_second: 5 },
    }))

    expect(candidates.map(item => item.route_recipe_names)).toEqual([
      ['intermediate-a', 'target'],
      ['intermediate-b', 'target'],
    ])
    expect(externalRate(candidates[0], 'raw-a')).toBeCloseTo(10)
    expect(externalRate(candidates[1], 'raw-b')).toBeCloseTo(15)
    expect(candidates[0].solution.recipe_rates.find(item => item.recipe_name === 'target')?.ingredient_rates[0].rate_per_second).toBeCloseTo(10)
  })

  it('keeps a shared ambiguous intermediate on one consistent recipe route per candidate', () => {
    const actor = actorWith({
      final: recipe({
        name: 'final',
        ingredients: [
          { type: 'item', name: 'branch-a', amount: 1 },
          { type: 'item', name: 'branch-b', amount: 1 },
        ],
        products: [{ type: 'item', name: 'final-product', amount: 1 }],
      }),
      'branch-a': recipe({
        name: 'branch-a',
        ingredients: [{ type: 'item', name: 'shared', amount: 1 }],
        products: [{ type: 'item', name: 'branch-a', amount: 1 }],
      }),
      'branch-b': recipe({
        name: 'branch-b',
        ingredients: [{ type: 'item', name: 'shared', amount: 1 }],
        products: [{ type: 'item', name: 'branch-b', amount: 1 }],
      }),
      'shared-a': recipe({
        name: 'shared-a',
        ingredients: [{ type: 'item', name: 'raw-a', amount: 1 }],
        products: [{ type: 'item', name: 'shared', amount: 1 }],
      }),
      'shared-b': recipe({
        name: 'shared-b',
        ingredients: [{ type: 'item', name: 'raw-b', amount: 1 }],
        products: [{ type: 'item', name: 'shared', amount: 1 }],
      }),
    })

    const candidates = candidateSolutions(solve_live_production_candidates(actor, {
      calculation_id: 'shared-choice',
      target: { type: 'item', name: 'final-product', rate_per_second: 2 },
    }))

    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      const sharedRecipes = candidate.route_recipe_names.filter(name => name === 'shared-a' || name === 'shared-b')
      expect(sharedRecipes).toHaveLength(1)
      expect(candidate.route_choices).toHaveLength(1)
      expect(candidate.solution.recipe_rates.find(item => item.recipe_name === sharedRecipes[0])?.required_output_rate_per_second).toBeCloseTo(4)
    }
  })

  it('fails closed when the complete route set exceeds the five-candidate contract', () => {
    const recipes: Record<string, unknown> = {}
    for (let i = 0; i < 6; i++) {
      recipes[`route-${i}`] = recipe({
        name: `route-${i}`,
        ingredients: [{ type: 'item', name: `raw-${i}`, amount: 1 }],
        products: [{ type: 'item', name: 'target', amount: 1 }],
      })
    }

    expect(solve_live_production_candidates(actorWith(recipes), {
      calculation_id: 'too-many-routes',
      target: { type: 'item', name: 'target', rate_per_second: 1 },
    })).toMatchObject({
      ok: false,
      error: {
        code: 'LIMIT_EXCEEDED',
        message: 'production route candidates exceed 5; provide included_recipe_names to narrow the production scope',
      },
    })
  })
})
