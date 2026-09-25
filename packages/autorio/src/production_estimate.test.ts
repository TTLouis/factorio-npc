import type { EstimateStepInput, EstimateSuccess } from './production_estimate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimate_production } from './production_estimate'
import { estimate_production_for_actor } from './production_estimate_live'

// Factorio 2.0 base values: burner drill 0.25 on 1 s iron ore = 4 s per ore;
// stone furnace speed 1 on the 3.2 s iron-plate recipe; coal 4 MJ, drill
// 150 kW and furnace 90 kW burners.
function drill(count: number, fuel = true): EstimateStepInput {
  return {
    item: 'iron-ore',
    kind: 'drill',
    source: 'iron-ore',
    machine: 'burner-mining-drill',
    machine_count: count,
    seconds_per_cycle: 4,
    output_per_cycle: 1,
    ingredients: [],
    fuel: fuel ? { name: 'coal', per_second_per_machine: 150000 / 4000000 } : undefined,
  }
}

function furnace(count: number): EstimateStepInput {
  return {
    item: 'iron-plate',
    kind: 'machine',
    source: 'iron-plate',
    machine: 'stone-furnace',
    machine_count: count,
    seconds_per_cycle: 3.2,
    output_per_cycle: 1,
    ingredients: [{ name: 'iron-ore', amount: 1 }],
    fuel: { name: 'coal', per_second_per_machine: 90000 / 4000000 },
  }
}

function ok(result: ReturnType<typeof estimate_production>): EstimateSuccess {
  expect(result.ok).toBe(true)
  return result as EstimateSuccess
}

describe('production time estimate', () => {
  it('finds the drill as the limit of one drill feeding one furnace, and what one more drill buys', () => {
    const result = ok(estimate_production({ target: 'iron-plate', count: 100, steps: [furnace(1), drill(1)] }))

    // 100 ore at 4 s each = 400 s, plus one 3.2 s smelt for the last plate.
    expect(result.total_seconds).toBe(403.2)
    expect(result.bottleneck).toEqual({ lane: 'step', item: 'iron-ore', finish_seconds: 403.2 })
    expect(result.steps).toEqual([
      {
        item: 'iron-plate', kind: 'machine', source: 'iron-plate', machine: 'stone-furnace', machine_count: 1,
        cycles: 100, amount: 100, seconds_per_cycle: 3.2, output_per_minute: 18.75, busy_seconds: 320, finish_seconds: 324,
        fuel: { name: 'coal', per_minute_per_machine: 1.35, total: 7.2 },
      },
      {
        item: 'iron-ore', kind: 'drill', source: 'iron-ore', machine: 'burner-mining-drill', machine_count: 1,
        cycles: 100, amount: 100, seconds_per_cycle: 4, output_per_minute: 15, busy_seconds: 400, finish_seconds: 403.2,
        fuel: { name: 'coal', per_minute_per_machine: 2.25, total: 15 },
      },
    ])
    expect(result.external_inputs).toEqual([])
    expect(result.unused_steps).toEqual([])
    // A second drill halves mining; the furnace becomes the limit.
    expect(result.one_more_on_bottleneck).toEqual({
      item: 'iron-ore',
      machine_count: 2,
      total_seconds: 324,
      saved_seconds: 79.2,
      new_bottleneck: { lane: 'step', item: 'iron-plate' },
    })
  })

  it('shares cycles evenly in whole cycles across a step\'s machines', () => {
    const result = ok(estimate_production({ target: 'iron-plate', count: 100, steps: [furnace(3), drill(3, false)] }))
    // 100 cycles over 3 machines: the busiest does 34.
    expect(result.steps[1]).toMatchObject({ item: 'iron-ore', busy_seconds: 136, output_per_minute: 45 })
    expect(result.steps[1].fuel).toBeUndefined()
    expect(result.steps[0]).toMatchObject({ item: 'iron-plate', busy_seconds: 108.8 })
    expect(result.total_seconds).toBe(139.2)
  })

  it('adds up demand where one input feeds two steps, and lists inputs without a step', () => {
    const steps: EstimateStepInput[] = [
      { item: 'circuit', kind: 'machine', source: 'circuit', machine: 'assembler', machine_count: 1, seconds_per_cycle: 1, output_per_cycle: 1, ingredients: [{ name: 'plate', amount: 1 }, { name: 'cable', amount: 3 }] },
      { item: 'cable', kind: 'machine', source: 'cable', machine: 'assembler', machine_count: 1, seconds_per_cycle: 1, output_per_cycle: 2, ingredients: [{ name: 'plate', amount: 1 }] },
      { item: 'plate', kind: 'machine', source: 'plate', machine: 'furnace', machine_count: 1, seconds_per_cycle: 2, output_per_cycle: 1, ingredients: [{ name: 'ore', amount: 1 }] },
    ]
    const result = ok(estimate_production({ target: 'circuit', count: 10, steps }))
    const by_item: Record<string, any> = {}
    for (const step of result.steps) by_item[step.item] = step
    expect(by_item.circuit.cycles).toBe(10)
    // 30 cable at 2 per craft.
    expect(by_item.cable).toMatchObject({ cycles: 15, amount: 30 })
    // 10 plates for circuits plus 15 for cable.
    expect(by_item.plate).toMatchObject({ cycles: 25, busy_seconds: 50 })
    expect(result.external_inputs).toEqual([{ name: 'ore', amount: 25 }])
    // Plate is the limit: 50 s busy (ore is on hand, so no wait for input), then
    // its last plate still passes one cable and one circuit craft.
    expect(result.bottleneck).toEqual({ lane: 'step', item: 'plate', finish_seconds: 52 })
  })

  it('treats hand work as one serial lane that more machines cannot shorten', () => {
    const steps: EstimateStepInput[] = [
      { item: 'gear', kind: 'hand_craft', source: 'gear', machine_count: 1, seconds_per_cycle: 0.5, output_per_cycle: 1, ingredients: [{ name: 'plate', amount: 2 }] },
      { item: 'ore', kind: 'hand_mine', source: 'ore', machine_count: 1, seconds_per_cycle: 2, output_per_cycle: 1, ingredients: [] },
      { item: 'plate', kind: 'machine', source: 'plate', machine: 'furnace', machine_count: 4, seconds_per_cycle: 3.2, output_per_cycle: 1, ingredients: [{ name: 'ore', amount: 1 }] },
    ]
    const result = ok(estimate_production({ target: 'gear', count: 10, steps }))
    // 20 ore by hand at 2 s plus 10 gears at 0.5 s share the actor.
    expect(result.hand_lane_seconds).toBe(45)
    expect(result.bottleneck.lane).toBe('hand')
    expect(result.one_more_on_bottleneck).toBeUndefined()
  })

  it('reports steps the target never uses', () => {
    const result = ok(estimate_production({ target: 'iron-ore', count: 5, steps: [furnace(1), drill(1, false)] }))
    expect(result.unused_steps).toEqual(['iron-plate'])
    expect(result.total_seconds).toBe(20)
  })

  it('refuses requests it cannot estimate instead of guessing', () => {
    expect(estimate_production({ target: 'iron-plate', count: 0, steps: [furnace(1)] })).toMatchObject({ ok: false, error: expect.stringContaining('count') })
    expect(estimate_production({ target: 'iron-plate', count: 1.5, steps: [furnace(1)] }).ok).toBe(false)
    expect(estimate_production({ target: 'iron-plate', count: 1, steps: [drill(1)] })).toEqual({ ok: false, error: 'no step makes the target iron-plate' })
    expect(estimate_production({ target: 'iron-plate', count: 1, steps: [furnace(1), furnace(2)] })).toEqual({ ok: false, error: 'more than one step makes iron-plate' })
    expect(estimate_production({ target: 'iron-plate', count: 1, steps: [furnace(0)] }).ok).toBe(false)
    expect(estimate_production({ target: 'iron-plate', count: 1, steps: [{ ...furnace(1), kind: 'hand_craft', machine_count: 2 }] }).ok).toBe(false)
    const loop: EstimateStepInput[] = [
      { ...furnace(1), item: 'a', ingredients: [{ name: 'b', amount: 1 }] },
      { ...furnace(1), item: 'b', ingredients: [{ name: 'a', amount: 1 }] },
    ]
    expect(estimate_production({ target: 'a', count: 1, steps: loop })).toEqual({ ok: false, error: 'steps form a cycle through a' })
  })
})

describe('production time estimate from live prototypes', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntities = (globalThis as any).prototypes.entity
  const originalItems = (globalThis as any).prototypes.item
  const originalGetEntityFiltered = (globalThis as any).prototypes.get_entity_filtered

  const ironOre = {
    name: 'iron-ore',
    type: 'resource',
    resource_category: 'basic-solid',
    infinite_resource: false,
    mineable_properties: { mining_time: 1, products: [{ type: 'item', name: 'iron-ore', amount: 1, probability: 1 }] },
  }

  function recipe(name: string, category: string, energy: number, ingredients: any[], products: any[]) {
    return { name, category, additional_categories: [], energy, enabled: true, ingredients, products, prototype: { hidden_from_player_crafting: false } }
  }

  function actor() {
    return {
      is_valid: true,
      force: {
        mining_drill_productivity_bonus: 0,
        manual_crafting_speed_modifier: 0,
        manual_mining_speed_modifier: 0,
        recipes: {
          'iron-plate': recipe('iron-plate', 'smelting', 3.2, [{ type: 'item', name: 'iron-ore', amount: 1 }], [{ type: 'item', name: 'iron-plate', amount: 1 }]),
          'iron-gear-wheel': recipe('iron-gear-wheel', 'crafting', 0.5, [{ type: 'item', name: 'iron-plate', amount: 2 }], [{ type: 'item', name: 'iron-gear-wheel', amount: 1 }]),
          'gear-alt': recipe('gear-alt', 'advanced', 1, [{ type: 'item', name: 'iron-plate', amount: 1 }], [{ type: 'item', name: 'iron-gear-wheel', amount: 1 }]),
        },
      },
      character: {
        character_crafting_speed_modifier: 0,
        character_mining_speed_modifier: 0,
        prototype: {
          get_crafting_speed: () => 1,
          crafting_categories: { crafting: true },
          mining_speed: 0.5,
          resource_categories: { 'basic-solid': true },
        },
      },
    } as any
  }

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes.entity = {
      ...originalEntities,
      'burner-mining-drill': {
        name: 'burner-mining-drill',
        type: 'mining-drill',
        mining_speed: 0.25,
        uses_force_mining_productivity_bonus: true,
        resource_categories: { 'basic-solid': true },
        get_max_energy_usage: () => 2500,
        burner_prototype: { effectivity: 1, fuel_categories: { chemical: true } },
      },
      'stone-furnace': {
        name: 'stone-furnace',
        type: 'furnace',
        crafting_categories: { smelting: true },
        get_crafting_speed: () => 1,
        get_max_energy_usage: () => 1500,
        burner_prototype: { effectivity: 1, fuel_categories: { chemical: true } },
      },
      'assembler': {
        name: 'assembler',
        type: 'assembling-machine',
        crafting_categories: { crafting: true, advanced: true },
        get_crafting_speed: () => 0.5,
        get_max_energy_usage: () => 1250,
        electric_energy_source_prototype: {},
      },
      'wooden-chest': { name: 'wooden-chest', type: 'container' },
    }
    ;(globalThis as any).prototypes.item = {
      ...originalItems,
      coal: { name: 'coal', fuel_category: 'chemical', fuel_value: 4000000 },
    }
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, unknown>>) =>
      filters[0]?.type === 'resource' ? { 'iron-ore': ironOre } : {}
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntities
    ;(globalThis as any).prototypes.item = originalItems
    ;(globalThis as any).prototypes.get_entity_filtered = originalGetEntityFiltered
  })

  it('resolves a burner drill and stone furnace chain to the engine rates', () => {
    const result = estimate_production_for_actor(actor(), {
      target: 'iron-plate',
      count: 100,
      steps: [
        { item: 'iron-plate', machine: 'stone-furnace', machine_count: 1, fuel: 'coal' },
        { item: 'iron-ore', machine: 'burner-mining-drill', machine_count: 1, fuel: 'coal' },
      ],
    }) as any
    expect(result.ok).toBe(true)
    expect(result.total_seconds).toBe(403.2)
    expect(result.bottleneck.item).toBe('iron-ore')
    expect(result.steps[0]).toMatchObject({ source: 'iron-plate', output_per_minute: 18.75, fuel: { name: 'coal', per_minute_per_machine: 1.35 } })
    expect(result.steps[1]).toMatchObject({ kind: 'drill', source: 'iron-ore', output_per_minute: 15, fuel: { name: 'coal', per_minute_per_machine: 2.25 } })
    expect(result.one_more_on_bottleneck).toMatchObject({ item: 'iron-ore', machine_count: 2, total_seconds: 324 })
    expect(result.rate_basis).toContain('excludes modules')
  })

  it('uses the actor\'s hands when no machine is named', () => {
    const result = estimate_production_for_actor(actor(), {
      target: 'iron-gear-wheel',
      count: 4,
      steps: [
        { item: 'iron-gear-wheel' },
        { item: 'iron-ore' },
        { item: 'iron-plate', machine: 'stone-furnace', machine_count: 2 },
      ],
    }) as any
    expect(result.ok).toBe(true)
    expect(result.steps.map((step: any) => [step.item, step.kind, step.seconds_per_cycle])).toEqual([
      ['iron-gear-wheel', 'hand_craft', 0.5],
      ['iron-plate', 'machine', 3.2],
      ['iron-ore', 'hand_mine', 2],
    ])
    // 8 ore at 2 s and 4 gears at 0.5 s by hand.
    expect(result.hand_lane_seconds).toBe(18)
  })

  it('asks for a recipe when several fit the chosen machine, and refuses unusable choices', () => {
    const run = (step: Record<string, unknown>) => estimate_production_for_actor(actor(), { target: 'iron-gear-wheel', count: 1, steps: [{ item: 'iron-gear-wheel', ...step }] }) as any

    expect(run({ machine: 'assembler' })).toEqual({
      ok: false,
      error: 'step iron-gear-wheel: several recipes fit (gear-alt, iron-gear-wheel); name one in recipe',
    })
    expect(run({ machine: 'assembler', recipe: 'gear-alt' })).toMatchObject({ ok: true, steps: [{ source: 'gear-alt', seconds_per_cycle: 2 }] })
    expect(run({ machine: 'stone-furnace' }).error).toBe('step iron-gear-wheel: no recipe stone-furnace can craft makes iron-gear-wheel')
    expect(run({ machine: 'wooden-chest' }).error).toBe('step iron-gear-wheel: wooden-chest is not a crafting machine or mining drill')
    expect(run({ machine: 'no-such-machine' }).error).toBe('step iron-gear-wheel: unknown machine no-such-machine')
    expect(run({ machine: 'assembler', recipe: 'gear-alt', fuel: 'coal' }).error).toBe('step iron-gear-wheel: assembler does not burn fuel')
    expect(run({ recipe: 'gear-alt' }).error).toBe('step iron-gear-wheel: hand crafting cannot craft recipe gear-alt')
  })
})
