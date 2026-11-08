import type { LuaEntity } from 'factorio:runtime'
import { protected_read } from './electric_facts'

// These are software output/work bounds, never recipe or production constants.
export const FACTORY_INPUT_LIMITS = { inputs: 24, name: 160, fluidboxes: 16 }
type Required = boolean | 'unknown'
interface Input { kind: string, name?: string, amount?: number, basis?: string, [key: string]: unknown }
interface Requirement {
  state: 'known' | 'not_applicable' | 'unknown'
  required: Required
  scope: string
  inputs: Input[]
  truncated: boolean
  code?: string
}
function finite(value: unknown): value is number { return typeof value === 'number' && value === value && value !== math.huge && value !== -math.huge }
function name(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= FACTORY_INPUT_LIMITS.name }
function long_name(value: unknown): boolean { return typeof value === 'string' && value.length > FACTORY_INPUT_LIMITS.name }
// TSTL's direct typeof x === 'object' only recognizes tables, not LuaObjects.
function native_type(value: unknown): string { return typeof value }
function record(value: unknown): value is Record<string, any> {
  const kind = native_type(value)
  return value !== null && (kind === 'object' || kind === 'table' || kind === 'userdata')
}
const unknown = (scope: string, code: string, truncated = false, required: Required = 'unknown'): Requirement => ({ state: 'unknown', required, scope, inputs: [], truncated, code })
const complete = (scope: string, inputs: Input[]): Requirement => ({ state: inputs.length > 0 ? 'known' : 'not_applicable', required: inputs.length > 0, scope, inputs, truncated: false })
const CRAFTERS = ['assembling-machine', 'furnace', 'rocket-silo']
// Type applicability, not lists of game recipes or ingredient bills. Unsupported
// processes (for example research or ammunition) never become known empty.
const NO_PROCESS_ITEMS = ['mining-drill', 'boiler', 'generator', 'burner-generator', 'reactor', 'offshore-pump', 'pump', 'pipe', 'pipe-to-ground', 'storage-tank', 'electric-pole', 'accumulator', 'solar-panel', 'inserter', 'transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt', 'container', 'logistic-container', 'infinity-container', 'heat-pipe', 'electric-energy-interface']

function recipe_inputs(entity: LuaEntity): { material: Requirement, fluid: Requirement } {
  const materialScope = 'current_recipe_item_inputs'
  const fluidScope = 'current_recipe_fluid_inputs'
  const fail = (code: string, truncated = false) => ({ material: unknown(materialScope, code, truncated), fluid: unknown(fluidScope, code, truncated) })
  const read = protected_read(() => {
    const [current] = entity.get_recipe()
    if (current === undefined) return fail('current_recipe_unset')
    if (record(current) && long_name(current.name)) return fail('recipe_name_truncated', true)
    if (!record(current) || !name(current.name)) return fail('current_recipe_malformed')
    const raw: unknown = current.ingredients
    if (!Array.isArray(raw)) return fail('recipe_ingredients_malformed')
    if (raw.length > FACTORY_INPUT_LIMITS.inputs) return fail('recipe_ingredients_truncated', true)
    const material: Input[] = []
    const fluid: Input[] = []
    for (const value of raw) {
      if (record(value) && long_name(value.name)) return fail('recipe_ingredient_name_truncated', true)
      if (!record(value) || !['item', 'fluid'].includes(value.type) || !name(value.name)
        || !finite(value.amount) || value.amount <= 0) return fail('recipe_ingredient_malformed')
      const input: Input = { kind: value.type, name: value.name, amount: value.amount, basis: 'per_current_recipe_execution', recipe: current.name }
      for (const key of ['minimum_temperature', 'maximum_temperature', 'temperature']) {
        if (value[key] !== undefined) {
          if (value.type !== 'fluid' || !finite(value[key])) return fail('recipe_ingredient_temperature_malformed')
          input[key] = value[key]
        }
      }
      if (finite(input.minimum_temperature) && finite(input.maximum_temperature) && input.minimum_temperature > input.maximum_temperature) return fail('recipe_ingredient_temperature_malformed')
      if (value.type === 'item') material.push(input)
      else fluid.push(input)
    }
    return { material: complete(materialScope, material), fluid: complete(fluidScope, fluid) }
  })
  return read ?? fail('current_recipe_unreadable')
}

function mining_fluid(resources: any): Requirement {
  const scope = 'visible_mineable_resource_fluid_inputs'
  if (resources.state !== 'known' || resources.truncated !== false || !Array.isArray(resources.resources)) return unknown(scope, 'mining_resources_incomplete', resources.truncated === true)
  const deposits: any[] = resources.resources
  // No visible deposit is not proof of an assigned mining process's inputs.
  if (deposits.length === 0) return unknown(scope, 'mining_resource_unset')
  const inputs: Input[] = []
  for (const resource of deposits) {
    const read = resource.mining_fluid
    if (read?.state !== 'known') return unknown(scope, 'mining_fluid_unreadable')
    if (read.required_fluid === undefined && read.fluid_amount === undefined) continue
    if (long_name(resource.name) || long_name(read.required_fluid)) return unknown(scope, 'mining_fluid_name_truncated', true)
    if (!name(resource.name) || !name(read.required_fluid) || !finite(read.fluid_amount) || read.fluid_amount <= 0) return unknown(scope, 'mining_fluid_malformed')
    // A patch can contain many tiles of the same deposit. This is a requirement
    // per native mining operation, not a sum across the visible tiles.
    if (inputs.some(input => input.resource_name === resource.name && input.name === read.required_fluid && input.native_fluid_amount === read.fluid_amount)) continue
    if (inputs.length >= FACTORY_INPUT_LIMITS.inputs) return unknown(scope, 'mining_fluid_inputs_truncated', true)
    inputs.push({ kind: 'fluid', name: read.required_fluid, resource_name: resource.name,
      native_fluid_amount: read.fluid_amount, basis: 'native_mineable_properties_fluid_amount' })
  }
  return complete(scope, inputs)
}

function process_fluid(entity: LuaEntity): Requirement {
  const scope = 'native_process_fluid_inputs'
  const read = protected_read(() => {
    const raw: unknown = entity.prototype.fluidbox_prototypes
    if (!record(raw)) return unknown(scope, 'process_fluidboxes_malformed')
    const inputs: Input[] = []
    let count = 0
    // Lua's fluidbox prototype collection is a numeric dictionary; bound its
    // traversal, including boxes with no input role, before reading each value.
    for (const key in raw) {
      if (count >= FACTORY_INPUT_LIMITS.fluidboxes) return unknown(scope, 'process_fluidboxes_truncated', true)
      count++
      const box = raw[key]
      if (!record(box) || !finite(box.index) || box.index < 1 || math.floor(box.index) !== box.index
        || !['input', 'output', 'input-output', 'none'].includes(box.production_type)) return unknown(scope, 'process_fluidbox_malformed')
      if (box.production_type === 'output') continue
      if (!['input', 'input-output'].includes(box.production_type)) return unknown(scope, 'process_fluidbox_role_unknown')
      const filter = box.filter
      if (filter === undefined) return unknown(scope, 'process_fluid_filter_unset', false, true)
      if (record(filter) && long_name(filter.name)) return unknown(scope, 'process_fluid_filter_name_truncated', true, true)
      if (!record(filter) || !name(filter.name)) return unknown(scope, 'process_fluid_filter_malformed', false, true)
      const input: Input = { kind: 'fluid', name: filter.name, fluidbox_index: box.index, basis: 'native_process_input_filter' }
      const temperatures = { minimum_temperature: entity.prototype.minimum_input_temperature, maximum_temperature: entity.prototype.maximum_input_temperature }
      for (const field of ['minimum_temperature', 'maximum_temperature'] as const) {
        const value = temperatures[field]
        if (value !== undefined) {
          if (!finite(value)) return unknown(scope, 'process_fluid_temperature_malformed', false, true)
          input[field] = value
        }
      }
      if (finite(input.minimum_temperature) && finite(input.maximum_temperature) && input.minimum_temperature > input.maximum_temperature) return unknown(scope, 'process_fluid_temperature_malformed', false, true)
      inputs.push(input)
    }
    if (inputs.length === 0) return unknown(scope, 'process_fluid_input_unavailable')
    return complete(scope, inputs)
  })
  return read ?? unknown(scope, 'process_fluidboxes_unreadable')
}

function power_requirement(entity: LuaEntity): Requirement {
  const scope = 'native_electricity_or_heat_input'
  const read = protected_read(() => {
    const prototype = entity.prototype
    const electric = prototype.electric_energy_source_prototype
    const heat = prototype.heat_energy_source_prototype
    if (electric !== undefined && !record(electric)) return unknown(scope, 'electric_source_malformed')
    if (heat !== undefined && !record(heat)) return unknown(scope, 'heat_source_malformed')
    if (electric !== undefined && heat !== undefined) return unknown(scope, 'energy_sources_ambiguous')
    if (heat !== undefined) return complete(scope, [{ kind: 'heat', basis: 'native_heat_energy_source' }])
    if (electric === undefined) return complete(scope, [])
    const priority = electric.usage_priority
    if (priority === 'secondary-input') return complete(scope, [{ kind: 'electricity', usage_priority: priority, basis: 'native_electric_energy_source' }])
    if (priority === 'managed-accumulator') return complete(scope, [{ kind: 'electricity', usage_priority: priority, purpose: 'charging', basis: 'native_electric_energy_source' }])
    if (priority === 'secondary-output' || priority === 'solar') return complete(scope, [])
    return unknown(scope, 'electric_usage_priority_unsupported')
  })
  return read ?? unknown(scope, 'energy_source_unreadable')
}

function fuel_requirement(entity: LuaEntity, burner: any): Requirement {
  const scope = 'native_burner_or_fluid_fuel_input'
  const read = protected_read(() => ({ source: entity.prototype.fluid_energy_source_prototype }))
  if (!read) return unknown(scope, 'fluid_energy_source_unreadable', burner.truncated === true, burner.required === true ? true : 'unknown')
  if (read.source !== undefined) {
    // Native nil has been proved; no current engine fixture in the API probe
    // exposed a fluid energy source. Do not guess its fuel selection semantics.
    return unknown(scope, record(read.source) ? 'fluid_energy_source_unsupported' : 'fluid_energy_source_malformed', false, record(read.source) ? true : 'unknown')
  }
  if (burner.state === 'not_applicable' && burner.required === false) return complete(scope, [])
  if (burner.state !== 'known' || burner.required !== true || burner.truncated !== false) return unknown(scope, burner.code ?? 'burner_requirement_unknown', burner.truncated === true, burner.required === true ? true : 'unknown')
  // Accepted categories are alternatives for ONE fuel input, never an invented
  // resource name or a requirement to supply every category simultaneously.
  return complete(scope, [{ kind: 'fuel', accepted_categories: burner.fuel_categories, basis: 'native_burner_fuel_categories' }])
}

export function factory_input_requirements(entity: LuaEntity, burner: any, resources: any) {
  const process = CRAFTERS.includes(entity.type) ? recipe_inputs(entity) : {
    material: NO_PROCESS_ITEMS.includes(entity.type) ? complete('nonrecipe_process_item_inputs', []) : unknown('nonrecipe_process_item_inputs', 'material_process_unsupported'),
    fluid: entity.type === 'mining-drill' ? mining_fluid(resources)
      : ['boiler', 'generator'].includes(entity.type) ? process_fluid(entity)
      : NO_PROCESS_ITEMS.includes(entity.type) ? complete('nonrecipe_process_fluid_inputs', []) : unknown('nonrecipe_process_fluid_inputs', 'fluid_process_unsupported'),
  }
  const power = power_requirement(entity)
  const fuel = fuel_requirement(entity, burner)
  const domains = { material: process.material, fluid: process.fluid, power, fuel }
  const codes: string[] = []
  for (const domain of ['material', 'fluid', 'power', 'fuel'] as const) {
    if (domains[domain].state === 'unknown') codes.push(`${domain}:${domains[domain].code}`)
  }
  return { schema_version: 1, ...domains,
    coverage: { state: codes.length > 0 ? 'partial' : 'complete', codes,
      scope: 'current_process_consumable_inputs_only', transport_contents: 'not_a_consumable_requirement', resource_deposits: 'see_source_resources',
      rates_and_sizing: 'unverified', all_operating_constraints: 'unverified' },
    supply: 'unverified', delivery: 'unverified', external_source: 'unverified', automation: 'unverified' }
}
