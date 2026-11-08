import { describe, expect, it, vi } from 'vitest'
import { factory_input_requirements } from './factory_input_requirements'

// Synthetic shape/fault tests. Real API and LuaObject proof is a separate native
// lane; no constants below are recipe knowledge or production sizing.
const noFuel = { state: 'not_applicable', required: false, truncated: false, fuel_categories: [] }
const noResources = { state: 'not_applicable', resources: [], truncated: false }
const facts = (entity: any, burner = noFuel, resources = noResources) => factory_input_requirements(entity, burner, resources)
const machine = (type = 'assembling-machine', ingredients: any = [{ type: 'item', name: 'synthetic-feed', amount: 7 }]): any => ({
  type, prototype: {}, get_recipe: () => [{ name: 'synthetic-process', ingredients }],
})
const raises = () => { throw new Error('synthetic getter failure') }

describe('exact-member process input requirement projection', () => {
  it('separates live item/fluid inputs, preserves temperature and amount provenance without supply inference', () => {
    const member = machine('assembling-machine', [{ type: 'item', name: 'synthetic-feed', amount: 7 }, { type: 'fluid', name: 'synthetic-fluid', amount: 9, minimum_temperature: 12, maximum_temperature: 42 }])
    member.prototype.electric_energy_source_prototype = { usage_priority: 'secondary-input' }
    const row = facts(member)
    expect(row.material).toMatchObject({ state: 'known', required: true, inputs: [{ kind: 'item', name: 'synthetic-feed', amount: 7, recipe: 'synthetic-process', basis: 'per_current_recipe_execution' }] })
    expect(row.fluid).toMatchObject({ state: 'known', required: true, inputs: [{ kind: 'fluid', name: 'synthetic-fluid', amount: 9, minimum_temperature: 12, maximum_temperature: 42 }] })
    expect(row.power).toMatchObject({ state: 'known', inputs: [{ kind: 'electricity' }] })
    expect(row.coverage.state).toBe('complete')
    expect(row).toMatchObject({ supply: 'unverified', delivery: 'unverified', external_source: 'unverified', automation: 'unverified' })
    member.get_recipe = () => [{ name: 'changed-process', ingredients: [{ type: 'fluid', name: 'changed-fluid', amount: 3 }] }]
    expect(facts(member).material).toMatchObject({ state: 'not_applicable', required: false })
    expect(facts(member).fluid.inputs[0].name).toBe('changed-fluid')
  })
  it.each(['assembling-machine', 'furnace', 'rocket-silo'])('keeps dormant %s item AND fluid inputs unknown', type => {
    const member = machine(type); member.get_recipe = () => []
    expect(facts(member)).toMatchObject({ material: { state: 'unknown', code: 'current_recipe_unset' }, fluid: { state: 'unknown', code: 'current_recipe_unset' }, coverage: { state: 'partial' } })
  })
  it('distinguishes unreadable, malformed, complete empty and truncated current recipes', () => {
    const member = machine(); member.get_recipe = raises
    expect(facts(member).material.code).toBe('current_recipe_unreadable')
    for (const raw of [undefined, null, {}, 'bad', [{ type: 'item', name: 'x', amount: 0 }], [{ type: 'fluid', name: 'x', amount: 1, minimum_temperature: 8, maximum_temperature: 2 }]]) {
      member.get_recipe = () => [{ name: 'synthetic', ingredients: raw }]
      expect(facts(member).material.state).toBe('unknown'); expect(facts(member).fluid.state).toBe('unknown')
    }
    member.get_recipe = () => [{ name: 'synthetic', ingredients: [] }]
    expect(facts(member).material).toMatchObject({ state: 'not_applicable', required: false, truncated: false })
    const input = { type: 'item', name: 'synthetic', amount: 1 }
    member.get_recipe = () => [{ name: 'synthetic', ingredients: Array.from({ length: 24 }, () => input) }]
    expect(facts(member).material.inputs).toHaveLength(24)
    member.get_recipe = () => [{ name: 'synthetic', ingredients: Array.from({ length: 25 }, () => input) }]
    expect(facts(member).material).toMatchObject({ state: 'unknown', inputs: [], truncated: true, code: 'recipe_ingredients_truncated' })
    member.get_recipe = () => [{ name: 'synthetic', ingredients: [{ ...input, name: 'x'.repeat(161) }] }]
    expect(facts(member).material).toMatchObject({ state: 'unknown', inputs: [], truncated: true, code: 'recipe_ingredient_name_truncated' })
  })
  it('uses filtered native boiler/generator input boxes and ignores outputs, never their buffer contents', () => {
    for (const type of ['boiler', 'generator']) {
      const member = machine(type)
      member.prototype.minimum_input_temperature = 100
      member.prototype.fluidbox_prototypes = [{ index: 1, production_type: 'input', filter: { name: 'native-feed' }, minimum_temperature: 100 }, { index: 2, production_type: 'output', filter: { name: 'not-an-input' } }]
      member.fluidbox = [{ name: 'unrelated-buffer', amount: 500 }]
      expect(facts(member).fluid).toMatchObject({ state: 'known', required: true, inputs: [{ kind: 'fluid', name: 'native-feed', fluidbox_index: 1, minimum_temperature: 100 }] })
      expect(facts(member).fluid.inputs).toHaveLength(1)
    }
    expect(facts(machine('pipe')).fluid).toMatchObject({ state: 'not_applicable', required: false })
    expect(facts(machine('lab')).material).toMatchObject({ state: 'unknown', code: 'material_process_unsupported' })
  })
  it('keeps process-fluid getter/filter/role failures and truncation explicit', () => {
    const member = machine('boiler')
    for (const boxes of [undefined, null, [], [{ index: 1, production_type: 'none' }], [{ index: 1, production_type: 'input' }]]) {
      member.prototype.fluidbox_prototypes = boxes
      expect(facts(member).fluid.state).toBe('unknown')
    }
    member.prototype.minimum_input_temperature = Number.NaN
    member.prototype.fluidbox_prototypes = [{ index: 1, production_type: 'input', filter: { name: 'x' } }]
    expect(facts(member).fluid.state).toBe('unknown')
    delete member.prototype.minimum_input_temperature
    const boxes: any = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [index, { index: index + 1, production_type: 'input', filter: { name: 'native' } }]))
    member.prototype.fluidbox_prototypes = boxes
    expect(facts(member).fluid.state).toBe('known')
    const extra = vi.fn(raises); Object.defineProperty(boxes, 'extra', { enumerable: true, get: extra })
    expect(facts(member).fluid).toMatchObject({ state: 'unknown', truncated: true, inputs: [], code: 'process_fluidboxes_truncated' }); expect(extra).not.toHaveBeenCalled()
    Object.defineProperty(member.prototype, 'fluidbox_prototypes', { get: raises })
    expect(facts(member).fluid.code).toBe('process_fluidboxes_unreadable')
  })
  it('projects mining fluid from complete visible deposit facts and deduplicates tiles without summing amounts', () => {
    const member = machine('mining-drill')
    const deposit = { name: 'native-deposit', mining_fluid: { state: 'known', required_fluid: 'native-fluid', fluid_amount: 6 } }
    const resources: any = { state: 'known', truncated: false, resources: [deposit, deposit] }
    expect(facts(member, noFuel, resources).fluid).toMatchObject({ state: 'known', required: true, inputs: [{ kind: 'fluid', name: 'native-fluid', native_fluid_amount: 6, resource_name: 'native-deposit' }] })
    expect(facts(member, noFuel, resources).fluid.inputs).toHaveLength(1)
    resources.resources = [{ name: 'dry-deposit', mining_fluid: { state: 'known' } }]
    expect(facts(member, noFuel, resources).fluid.state).toBe('not_applicable')
    resources.truncated = true; expect(facts(member, noFuel, resources).fluid).toMatchObject({ state: 'unknown', truncated: true })
    resources.truncated = false; resources.resources = []; expect(facts(member, noFuel, resources).fluid.code).toBe('mining_resource_unset')
    resources.resources = [{ ...deposit, mining_fluid: { state: 'unknown' } }]; expect(facts(member, noFuel, resources).fluid.state).toBe('unknown')
  })
  it('distinguishes native electricity consumer, producer, storage and heat without using energy or network identity', () => {
    const member = machine('inserter'); member.energy = 999; member.electric_network_id = 123
    expect(facts(member).power).toMatchObject({ state: 'not_applicable', required: false })
    for (const priority of ['secondary-output', 'solar']) {
      member.prototype.electric_energy_source_prototype = { usage_priority: priority }
      expect(facts(member).power.required).toBe(false)
    }
    member.prototype.electric_energy_source_prototype = { usage_priority: 'managed-accumulator' }
    expect(facts(member).power.inputs[0]).toMatchObject({ kind: 'electricity', purpose: 'charging' })
    member.prototype.electric_energy_source_prototype = { usage_priority: 'unproved-priority' }
    expect(facts(member).power.code).toBe('electric_usage_priority_unsupported')
    delete member.prototype.electric_energy_source_prototype; member.prototype.heat_energy_source_prototype = {}
    expect(facts(member).power.inputs).toEqual([{ kind: 'heat', basis: 'native_heat_energy_source' }])
    Object.defineProperty(member.prototype, 'electric_energy_source_prototype', { get: raises })
    expect(facts(member).power.code).toBe('energy_source_unreadable')
  })
  it('retains alternative fuel selectors as one required input and preserves empty/error/unsupported distinctions', () => {
    const member = machine('inserter')
    const burner: any = { state: 'known', required: true, truncated: false, fuel_categories: ['native-a', 'native-b'] }
    expect(facts(member, burner).fuel.inputs).toEqual([{ kind: 'fuel', accepted_categories: ['native-a', 'native-b'], basis: 'native_burner_fuel_categories' }])
    burner.fuel_categories = []; expect(facts(member, burner).fuel.required).toBe(true)
    burner.state = 'unknown'; burner.truncated = true; burner.code = 'fuel_categories_truncated'
    expect(facts(member, burner).fuel).toMatchObject({ state: 'unknown', required: true, truncated: true })
    member.prototype.fluid_energy_source_prototype = {}
    expect(facts(member).fuel).toMatchObject({ state: 'unknown', required: true, code: 'fluid_energy_source_unsupported' })
    Object.defineProperty(member.prototype, 'fluid_energy_source_prototype', { get: raises })
    expect(facts(member).fuel).toMatchObject({ state: 'unknown', required: 'unknown', code: 'fluid_energy_source_unreadable' })
  })
})
