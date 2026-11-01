// Expected finish of a running crafting machine, from game data only
// (plan 2.5, W2b "the harness computes waits from game data").
//
// The harness uses this to decide how long to keep the planner asleep while a
// furnace or assembler works toward a step checkpoint: seconds per craft is the
// recipe energy over the machine's live crafting speed (modules and beacons
// included), and the crafts still needed come from the current output count,
// the craft in progress and the loaded inputs and fuel. It is an expectation,
// never proof: the step still closes only on the verified checkpoint.
//
// Not modelled: power shortage (an electric machine at low power is flagged,
// not slowed), inputs arriving while it runs (a drill or inserter feeding the
// machine), and fluid ingredients (input cover is then unknown).
import type { LuaEntity, LuaRecipePrototype } from 'factorio:runtime'
import * as rates from './production_rates'

export const ETA_BASIS = 'recipe energy / live crafting speed; loaded inputs and fuel only; power shortage and new input not modelled'

export interface MachineEtaFacts {
  recipe: string
  /** Recipe seconds at crafting speed 1. */
  energy: number
  /** Live crafting speed of this machine. */
  crafting_speed: number
  /** Progress of the craft under way, 0..1. */
  progress: number
  /** A craft is under way; its ingredients are already taken. */
  crafting: boolean
  /** Expected amount of the target item per craft, productivity included. */
  output_per_craft?: number
  current?: number
  minimum?: number
  /** Further crafts the loaded inputs supply; undefined when unknown (fluids). */
  input_crafts?: number
  /** Seconds of full-load work the loaded fuel supplies (burner machines). */
  fuel_seconds?: number
  status?: string
}

export interface MachineEta {
  recipe: string
  seconds_per_craft: number
  crafts_needed?: number
  seconds_to_target?: number
  seconds_until_idle?: number
  limited_by?: 'inputs' | 'fuel' | 'power' | 'output_full'
  basis: string
}

function round1(value: number) {
  return math.floor(value * 10 + 0.5) / 10
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && value === value && value > 0 && value < math.huge
}

// Pure arithmetic over facts already read from the engine.
export function machine_eta_from_facts(facts: MachineEtaFacts): MachineEta | undefined {
  if (!positive(facts.energy) || !positive(facts.crafting_speed)) return undefined
  const seconds_per_craft = facts.energy / facts.crafting_speed
  const progress = facts.crafting ? math.max(0, math.min(1, facts.progress)) : 0
  const in_progress = facts.crafting ? 1 : 0
  const result: MachineEta = { recipe: facts.recipe, seconds_per_craft: rates.round_rate(seconds_per_craft), basis: ETA_BASIS }

  let limited_by: MachineEta['limited_by']
  if (facts.status === 'full_output') limited_by = 'output_full'
  else if (facts.status === 'no_power' || facts.status === 'low_power') limited_by = 'power'

  if (facts.input_crafts !== undefined) {
    const idle = (in_progress - progress + facts.input_crafts) * seconds_per_craft
    result.seconds_until_idle = round1(facts.fuel_seconds !== undefined ? math.min(idle, facts.fuel_seconds) : idle)
  }
  else if (facts.fuel_seconds !== undefined) {
    result.seconds_until_idle = round1(facts.fuel_seconds)
  }

  if (facts.minimum !== undefined && facts.current !== undefined) {
    const needed = facts.minimum - facts.current
    if (needed <= 0) {
      result.crafts_needed = 0
      result.seconds_to_target = 0
    }
    else if (positive(facts.output_per_craft)) {
      const crafts = math.ceil(needed / facts.output_per_craft - 1e-9)
      const seconds = (crafts - progress) * seconds_per_craft
      result.crafts_needed = crafts
      result.seconds_to_target = round1(seconds)
      if (limited_by === undefined && facts.input_crafts !== undefined && in_progress + facts.input_crafts < crafts) limited_by = 'inputs'
      if (limited_by === undefined && facts.fuel_seconds !== undefined && facts.fuel_seconds < seconds) limited_by = 'fuel'
    }
  }
  if (limited_by !== undefined) result.limited_by = limited_by
  return result
}

const CRAFTING_MACHINE_TYPES: Record<string, boolean> = { 'assembling-machine': true, 'furnace': true }

function status_name(status: defines.entity_status | undefined) {
  if (status === undefined) return undefined
  for (const [name, value] of pairs(defines.entity_status)) {
    if (value === status) return name as string
  }
  return undefined
}

function current_recipe(entity: LuaEntity): LuaRecipePrototype | undefined {
  const [recipe] = entity.get_recipe()
  if (recipe !== undefined) return recipe.prototype
  if (entity.type === 'furnace') return entity.previous_recipe?.name
  return undefined
}

function output_per_craft(recipe: LuaRecipePrototype, item_name: string, productivity: number) {
  let total = 0
  for (const product of recipe.products) {
    if (product.name !== item_name) continue
    const expected = rates.expected_product_amount(product)
    const ignored = (product as any).ignored_by_productivity ?? 0
    total += expected + math.max(0, expected - ignored) * productivity
  }
  return total
}

function input_crafts(entity: LuaEntity, recipe: LuaRecipePrototype) {
  const input = entity.get_inventory(defines.inventory.crafter_input)
  if (input === undefined) return undefined
  let crafts: number | undefined
  for (const ingredient of recipe.ingredients) {
    if (ingredient.type !== 'item') return undefined
    if (!(ingredient.amount > 0)) continue
    const supplied = math.floor(input.get_item_count(ingredient.name) / ingredient.amount)
    crafts = crafts === undefined ? supplied : math.min(crafts, supplied)
  }
  return crafts
}

function fuel_seconds(entity: LuaEntity) {
  const burner = entity.burner
  const burner_prototype = entity.prototype.burner_prototype
  if (burner === undefined || burner_prototype === undefined) return undefined
  let energy = burner.remaining_burning_fuel
  const fuel = burner.inventory
  if (fuel !== undefined) {
    for (const item of fuel.get_contents()) {
      const prototype = prototypes.item[item.name]
      if (prototype !== undefined) energy += (prototype.fuel_value ?? 0) * item.count
    }
  }
  const watts = entity.prototype.get_max_energy_usage(entity.quality) * 60 * math.max(0.2, 1 + entity.consumption_bonus)
  if (!(watts > 0)) return undefined
  return energy * burner_prototype.effectivity / watts
}

// Live facts for one crafting machine; undefined for anything else or when it
// has no recipe. item_name/minimum/current describe an output checkpoint.
export function machine_eta(entity: LuaEntity, item_name?: string, minimum?: number, current?: number): MachineEta | undefined {
  if (!entity.valid || CRAFTING_MACHINE_TYPES[entity.type] !== true) return undefined
  const recipe = current_recipe(entity)
  if (recipe === undefined) return undefined
  return machine_eta_from_facts({
    recipe: recipe.name,
    energy: recipe.energy,
    crafting_speed: entity.crafting_speed,
    progress: entity.crafting_progress,
    crafting: entity.is_crafting(),
    output_per_craft: item_name !== undefined ? output_per_craft(recipe, item_name, entity.productivity_bonus) : undefined,
    current,
    minimum,
    input_crafts: input_crafts(entity, recipe),
    fuel_seconds: fuel_seconds(entity),
    status: status_name(entity.status),
  })
}
