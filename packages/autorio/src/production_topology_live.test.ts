import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { solve_live_production_candidates } from './production_planning_candidates_live'

function actor(recipes: Record<string, unknown>) {
  return { is_valid: true, force: { index: 1, recipes } } as unknown as ControlledActor
}

function recipe(name: string, ingredients: Array<Record<string, unknown>>, products: Array<Record<string, unknown>>) {
  return { name, enabled: true, hidden: false, energy: 1, category: 'crafting', additional_categories: [], ingredients, products }
}

describe('production topology integration', () => {
  const oldPairs = (globalThis as any).pairs
  beforeEach(() => { ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value) })
  afterEach(() => { ;(globalThis as any).pairs = oldPairs })

  it('adds topology to a single solved route', () => {
    const result = solve_live_production_candidates(actor({
      intermediate: recipe('intermediate', [{ type: 'item', name: 'raw', amount: 1 }], [{ type: 'item', name: 'intermediate', amount: 1 }]),
      target: recipe('target', [{ type: 'item', name: 'intermediate', amount: 2 }], [{ type: 'item', name: 'target', amount: 1 }]),
    }), { calculation_id: 'single-topology', target: { type: 'item', name: 'target', rate_per_second: 3 } })

    expect(result.ok).toBe(true)
    if (!result.ok || 'candidates' in result) throw new Error('expected one solved route')
    expect(result.topology.candidates.map(item => item.kind)).toEqual(['belt-fed', 'direct-insertion'])
    expect(result.topology.internal_transfers[0]).toMatchObject({ from_recipe: 'intermediate', to_recipes: ['target'], rate_per_second: 6 })
  })

  it('adds topology to every recipe candidate', () => {
    const result = solve_live_production_candidates(actor({
      first: recipe('first', [{ type: 'item', name: 'raw-a', amount: 1 }], [{ type: 'item', name: 'target', amount: 1 }]),
      second: recipe('second', [{ type: 'item', name: 'raw-b', amount: 1 }], [{ type: 'item', name: 'target', amount: 1 }]),
    }), { calculation_id: 'multi-topology', target: { type: 'item', name: 'target', rate_per_second: 2 } })

    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) throw new Error('expected multiple candidates')
    expect(result.candidates).toHaveLength(2)
    for (const candidate of result.candidates) {
      expect(candidate.solution.topology.candidate_ordering).toBe('canonical_not_ranked')
      expect(candidate.solution.topology.candidates.map(item => item.kind)).toEqual(['belt-fed'])
    }
  })
})
