import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { machine_eta, machine_eta_from_facts } from './production_eta'

// Factorio 2.0 base data: stone furnace speed 1, iron-plate 3.2 s, 90 kW,
// burner effectivity 1, coal 4 MJ.
const furnaceFacts = {
  recipe: 'iron-plate',
  energy: 3.2,
  crafting_speed: 1,
  progress: 0.5,
  crafting: true,
  output_per_craft: 1,
}

describe('machine expected finish from game data', () => {
  it('counts the craft under way and the whole crafts still needed', () => {
    // 2 plates held, 5 wanted: 3 crafts, the first half done.
    expect(machine_eta_from_facts({ ...furnaceFacts, current: 2, minimum: 5, input_crafts: 9, fuel_seconds: 400 })).toMatchObject({
      recipe: 'iron-plate',
      seconds_per_craft: 3.2,
      crafts_needed: 3,
      seconds_to_target: 8, // (3 - 0.5) x 3.2
      seconds_until_idle: 30.4, // (1 - 0.5 + 9) x 3.2
    })
  })

  it('names the limit when loaded inputs or fuel cannot reach the target', () => {
    expect(machine_eta_from_facts({ ...furnaceFacts, current: 0, minimum: 10, input_crafts: 3 }).limited_by).toBe('inputs')
    expect(machine_eta_from_facts({ ...furnaceFacts, current: 0, minimum: 10, input_crafts: 20, fuel_seconds: 10 })).toMatchObject({
      limited_by: 'fuel',
      seconds_until_idle: 10,
    })
    expect(machine_eta_from_facts({ ...furnaceFacts, current: 0, minimum: 2, input_crafts: 20, status: 'full_output' }).limited_by).toBe('output_full')
    expect(machine_eta_from_facts({ ...furnaceFacts, current: 0, minimum: 2, status: 'low_power' }).limited_by).toBe('power')
  })

  it('uses the live crafting speed and reports a met target as zero', () => {
    const assembler = { recipe: 'iron-gear-wheel', energy: 0.5, crafting_speed: 0.75, progress: 0, crafting: false, output_per_craft: 1 }
    expect(machine_eta_from_facts({ ...assembler, current: 0, minimum: 3 })).toMatchObject({ seconds_per_craft: 0.6667, crafts_needed: 3, seconds_to_target: 2 })
    expect(machine_eta_from_facts({ ...assembler, current: 4, minimum: 3 })).toMatchObject({ crafts_needed: 0, seconds_to_target: 0 })
    expect(machine_eta_from_facts({ ...assembler, crafting_speed: 0 })).toBeUndefined()
  })
})

describe('machine expected finish from a live entity', () => {
  const originalDefines = (globalThis as any).defines
  const originalItems = (globalThis as any).prototypes.item

  beforeEach(() => {
    ;(globalThis as any).defines = { ...originalDefines, entity_status: { working: 1, no_input_fluid: 2, full_output: 3 } }
    ;(globalThis as any).prototypes.item = { ...originalItems, coal: { name: 'coal', fuel_value: 4000000 } }
  })

  afterEach(() => {
    ;(globalThis as any).defines = originalDefines
    ;(globalThis as any).prototypes.item = originalItems
  })

  function furnace(overrides: Record<string, unknown> = {}) {
    const recipe = {
      name: 'iron-plate',
      energy: 3.2,
      ingredients: [{ type: 'item', name: 'iron-ore', amount: 1 }],
      products: [{ type: 'item', name: 'iron-plate', amount: 1 }],
    }
    return {
      valid: true,
      type: 'furnace',
      status: 1,
      crafting_speed: 1,
      crafting_progress: 0.25,
      productivity_bonus: 0,
      consumption_bonus: 0,
      quality: 'normal',
      is_crafting: () => true,
      get_recipe: () => [{ prototype: recipe }, undefined],
      previous_recipe: { name: recipe },
      get_inventory: () => ({ get_item_count: (name: string) => (name === 'iron-ore' ? 4 : 0) }),
      burner: { remaining_burning_fuel: 1000000, inventory: { get_contents: () => [{ name: 'coal', count: 1 }] } },
      prototype: { burner_prototype: { effectivity: 1 }, get_max_energy_usage: () => 1500 },
      ...overrides,
    } as any
  }

  it('reads recipe, progress, inputs and fuel from the machine', () => {
    // 5 MJ at 90 kW = 55.6 s of fuel; 4 ore + the craft under way.
    expect(machine_eta(furnace(), 'iron-plate', 3, 0)).toMatchObject({
      recipe: 'iron-plate',
      crafts_needed: 3,
      seconds_to_target: 8.8, // (3 - 0.25) x 3.2
      seconds_until_idle: 15.2, // (0.75 + 4) x 3.2
    })
  })

  it('falls back to the furnace\'s previous recipe while it waits for input', () => {
    const idle = furnace({ is_crafting: () => false, get_recipe: () => [undefined, undefined], get_inventory: () => ({ get_item_count: () => 0 }) })
    expect(machine_eta(idle, 'iron-plate', 1, 0)).toMatchObject({ recipe: 'iron-plate', crafts_needed: 1, seconds_to_target: 3.2, limited_by: 'inputs' })
  })

  it('answers nothing for machines it cannot model', () => {
    expect(machine_eta(furnace({ type: 'mining-drill' }))).toBeUndefined()
    expect(machine_eta(furnace({ type: 'assembling-machine', get_recipe: () => [undefined, undefined] }))).toBeUndefined()
  })
})
