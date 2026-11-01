import { describe, expect, it } from 'vitest'
import type { ProductionRecipeRate, ProductionSolveSuccess } from './production_planning'
import { production_topology_context } from './production_topology'

function solved(overrides: Partial<ProductionSolveSuccess>): ProductionSolveSuccess {
  return {
    ok: true,
    calculation_id: 'topology-test',
    target: { type: 'item', name: 'target', rate_per_second: 1 },
    recipe_rates: [],
    external_inputs: [],
    warnings: [],
    evidence_ids_used: [],
    fully_sized: false,
    sized_machine_count: 0,
    ...overrides,
  }
}

function recipeRate(
  recipe_name: string,
  product: { type: 'item' | 'fluid', name: string, amount: number },
  required_output_rate_per_second: number,
  ingredient_rates: Array<{ type: 'item' | 'fluid', name: string, rate_per_second: number }>,
  machine?: ProductionRecipeRate['machine'],
): ProductionRecipeRate {
  return {
    recipe_name,
    product,
    required_output_rate_per_second,
    crafts_per_second: required_output_rate_per_second,
    ingredient_rates,
    ...(machine ? { machine } : {}),
    evidence_ids: [],
  }
}

describe('production topology candidates', () => {
  it('offers belt-fed and direct-insertion for a one-to-one internal item edge', () => {
    const topology = production_topology_context(solved({
      target: { type: 'item', name: 'electronic-circuit', rate_per_second: 5 },
      recipe_rates: [
        recipeRate('copper-cable', { type: 'item', name: 'copper-cable', amount: 1 }, 10, [
          { type: 'item', name: 'copper-plate', rate_per_second: 5 },
        ]),
        recipeRate('electronic-circuit', { type: 'item', name: 'electronic-circuit', amount: 1 }, 5, [
          { type: 'item', name: 'copper-cable', rate_per_second: 10 },
          { type: 'item', name: 'iron-plate', rate_per_second: 5 },
        ]),
      ],
      external_inputs: [
        { type: 'item', name: 'copper-plate', rate_per_second: 5 },
        { type: 'item', name: 'iron-plate', rate_per_second: 5 },
      ],
    }))

    expect(topology.internal_transfers).toEqual([{
      material: { type: 'item', name: 'copper-cable' },
      from_recipe: 'copper-cable',
      to_recipes: ['electronic-circuit'],
      rate_per_second: 10,
    }])
    expect(topology.external_requirements).toEqual({ item_input_count: 2, fluid_input_count: 0 })
    expect(topology.layout_readiness).toMatchObject({
      ready: false,
      missing_machine_selections: ['copper-cable', 'electronic-circuit'],
      machine_groups: [],
    })
    expect(topology.candidate_ordering).toBe('canonical_not_ranked')
    expect(topology.candidates.map(candidate => candidate.kind)).toEqual(['belt-fed', 'direct-insertion'])
    expect(topology.candidates[1]).toMatchObject({
      external_item_strategy: 'unresolved',
      requires_validation: ['inserter_throughput', 'adjacency', 'external_item_transport'],
    })
    expect(topology.semantics.selection).toContain('not a ranking')
  })

  it('exposes compact machine groups only when every recipe is fully sized', () => {
    const topology = production_topology_context(solved({
      fully_sized: true,
      sized_machine_count: 5,
      recipe_rates: [
        recipeRate('a-recipe', { type: 'item', name: 'a', amount: 1 }, 2, [], {
          name: 'assembling-machine-2',
          crafting_speed: 0.75,
          machine_count: 2,
          nominal_output_rate_per_second: 2.25,
          utilization: 0.8888888889,
          evidence_ids: ['machine:a'],
        }),
        recipeRate('b-recipe', { type: 'item', name: 'target', amount: 1 }, 3, [
          { type: 'item', name: 'a', rate_per_second: 2 },
        ], {
          name: 'assembling-machine-1',
          crafting_speed: 0.5,
          machine_count: 3,
          nominal_output_rate_per_second: 3,
          utilization: 1,
          evidence_ids: ['machine:b'],
        }),
      ],
    }))

    expect(topology.layout_readiness).toEqual({
      ready: true,
      missing_machine_selections: [],
      machine_groups: [
        { recipe_name: 'a-recipe', machine_name: 'assembling-machine-2', machine_count: 2 },
        { recipe_name: 'b-recipe', machine_name: 'assembling-machine-1', machine_count: 3 },
      ],
      semantics: 'all recipe machine prototypes and counts are explicitly sized; spatial planning may use these machine groups but must still validate footprints, topology constraints, transport and live placement',
    })
  })

  it('offers a shared-intermediate strategy for one intermediate feeding multiple recipes', () => {
    const topology = production_topology_context(solved({
      target: { type: 'item', name: 'final', rate_per_second: 2 },
      recipe_rates: [
        recipeRate('shared', { type: 'item', name: 'shared', amount: 1 }, 4, [
          { type: 'item', name: 'raw', rate_per_second: 4 },
        ]),
        recipeRate('branch-a', { type: 'item', name: 'branch-a', amount: 1 }, 2, [
          { type: 'item', name: 'shared', rate_per_second: 2 },
        ]),
        recipeRate('branch-b', { type: 'item', name: 'branch-b', amount: 1 }, 2, [
          { type: 'item', name: 'shared', rate_per_second: 2 },
        ]),
        recipeRate('final', { type: 'item', name: 'final', amount: 1 }, 2, [
          { type: 'item', name: 'branch-a', rate_per_second: 2 },
          { type: 'item', name: 'branch-b', rate_per_second: 2 },
        ]),
      ],
      external_inputs: [{ type: 'item', name: 'raw', rate_per_second: 4 }],
    }))

    expect(topology.candidates.map(candidate => candidate.kind)).toEqual(['belt-fed', 'shared-intermediate'])
    expect(topology.candidates.some(candidate => candidate.kind === 'direct-insertion')).toBe(false)
    expect(topology.candidates[1]).toMatchObject({
      kind: 'shared-intermediate',
      internal_item_strategy: 'shared_distribution',
      external_item_strategy: 'unresolved',
      shared_materials: [{ type: 'item', name: 'shared' }],
      requires_validation: ['belt_capacity', 'inserter_throughput', 'external_item_transport'],
    })
    expect(topology.internal_transfers.find(transfer => transfer.material.name === 'shared')).toMatchObject({
      from_recipe: 'shared',
      to_recipes: ['branch-a', 'branch-b'],
      rate_per_second: 4,
    })
  })

  it('keeps a fluid-only graph on a pipe-fed candidate and marks throughput unverified', () => {
    const topology = production_topology_context(solved({
      target: { type: 'fluid', name: 'steam', rate_per_second: 20 },
      recipe_rates: [
        recipeRate('steam', { type: 'fluid', name: 'steam', amount: 1 }, 20, [
          { type: 'fluid', name: 'water', rate_per_second: 20 },
        ]),
      ],
      external_inputs: [{ type: 'fluid', name: 'water', rate_per_second: 20 }],
    }))

    expect(topology.external_requirements).toEqual({ item_input_count: 0, fluid_input_count: 1 })
    expect(topology.candidates).toEqual([{
      candidate_id: 'topology-pipe-fed',
      kind: 'pipe-fed',
      internal_item_strategy: 'none',
      external_item_strategy: 'none',
      fluid_strategy: 'pipe',
      requires_validation: ['fluid_throughput'],
    }])
  })
})
