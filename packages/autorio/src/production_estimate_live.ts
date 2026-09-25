// Resolves a planner's production estimate request against live prototypes and
// the actor's force, then hands the per-cycle facts to production_estimate.ts.
//
// The planner names every choice: which item each step makes, which machine
// (none = by hand) and how many. When a choice is ambiguous (two recipes or two
// resources fit) the request is refused with the options instead of guessed.
import type { LuaEntityPrototype } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { EstimateStepInput } from './production_estimate'
import * as pure from './production_estimate'
import * as rates from './production_rates'
import { crafting_categories_support_recipe } from './recipe_categories'

export interface LiveEstimateStep {
  item: string
  /** Recipe to craft with; needed only when several recipes fit. */
  recipe?: string
  /** Resource to mine; needed only when several resources fit. */
  resource?: string
  /** Crafting machine or mining drill prototype; omitted means by hand. */
  machine?: string
  machine_count?: number
  /** Fuel for a burner machine, to report fuel burned. */
  fuel?: string
}

export interface LiveEstimateRequest {
  target: string
  count: number
  steps: LiveEstimateStep[]
}

const MAX_NAME_LENGTH = 200
const MAX_LISTED_OPTIONS = 4
const CRAFTING_MACHINE_TYPES: Record<string, boolean> = {
  'assembling-machine': true,
  'furnace': true,
  'rocket-silo': true,
}

function valid_name(value: unknown) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function optional_name(value: unknown) {
  return value === undefined || valid_name(value)
}

function listed(names: string[]) {
  const shown: string[] = []
  for (const name of names) {
    if (shown.length >= MAX_LISTED_OPTIONS) break
    shown.push(name)
  }
  let text = ''
  for (const name of shown) text = text === '' ? name : `${text}, ${name}`
  return names.length > MAX_LISTED_OPTIONS ? `${text}, +${names.length - MAX_LISTED_OPTIONS} more` : text
}

function sort_strings(values: string[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j] < values[i]) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
}

function amount_of(products: any[] | undefined, item: string) {
  let total = 0
  for (const product of products ?? []) {
    if (product.name === item) total += rates.expected_product_amount(product)
  }
  return total
}

function ingredients_of(recipe: any) {
  const result: Array<{ name: string, amount: number }> = []
  for (const ingredient of recipe.ingredients ?? []) result.push({ name: ingredient.name, amount: ingredient.amount })
  return result
}

interface RecipeChoice {
  recipe?: any
  error?: string
  /** True when nothing fits, as opposed to a bad name or an ambiguous choice. */
  none?: boolean
}

// Force recipes that make `item` and pass `accepts`, or the named one.
function choose_recipe(actor: ControlledActor, step: LiveEstimateStep, accepts: (recipe: any) => boolean, maker: string): RecipeChoice {
  if (step.recipe !== undefined) {
    const recipe = actor.force.recipes[step.recipe]
    if (recipe === undefined) return { error: `step ${step.item}: unknown recipe ${step.recipe}` }
    if (amount_of(recipe.products, step.item) <= 0) return { error: `step ${step.item}: recipe ${step.recipe} does not make ${step.item}` }
    if (!accepts(recipe)) return { error: `step ${step.item}: ${maker} cannot craft recipe ${step.recipe}` }
    return { recipe }
  }
  const names: string[] = []
  const found: Record<string, any> = {}
  for (const [name, recipe] of pairs(actor.force.recipes)) {
    if (amount_of(recipe.products, step.item) > 0 && accepts(recipe)) {
      names.push(name)
      found[name] = recipe
    }
  }
  if (names.length === 0) return { error: `step ${step.item}: no recipe ${maker} can craft makes ${step.item}`, none: true }
  sort_strings(names)
  if (names.length > 1) return { error: `step ${step.item}: several recipes fit (${listed(names)}); name one in recipe` }
  return { recipe: found[names[0]] }
}

function resource_categories_of(resource: LuaEntityPrototype) {
  return resource.resource_category ?? 'basic-solid'
}

// Resources that yield `item` and pass `accepts`, or the named one.
function choose_resource(step: LiveEstimateStep, accepts: (resource: LuaEntityPrototype) => boolean, miner: string): LuaEntityPrototype | string {
  const names: string[] = []
  const found: Record<string, LuaEntityPrototype> = {}
  const matches = prototypes.get_entity_filtered([{ filter: 'type', type: 'resource' }])
  for (const [name, resource] of pairs(matches)) {
    if (step.resource !== undefined && name !== step.resource) continue
    if (amount_of((resource.mineable_properties as any).products, step.item) > 0 && accepts(resource)) {
      names.push(name)
      found[name] = resource
    }
  }
  if (names.length === 0) {
    return step.resource !== undefined
      ? `step ${step.item}: ${miner} cannot mine ${step.item} from resource ${step.resource}`
      : `step ${step.item}: no resource ${miner} can mine yields ${step.item}`
  }
  sort_strings(names)
  if (names.length > 1) return `step ${step.item}: several resources fit (${listed(names)}); name one in resource`
  return found[names[0]]
}

function mining_step(actor: ControlledActor, step: LiveEstimateStep, resource: LuaEntityPrototype, seconds_factor: number, output_factor: number, warnings: string[]): EstimateStepInput | string {
  const mineable = resource.mineable_properties as any
  if (!(mineable.mining_time > 0)) return `step ${step.item}: resource ${resource.name} has no mining time`
  if (mineable.required_fluid !== undefined) {
    warnings.push(`mining ${resource.name} also consumes ${mineable.required_fluid}; not included`)
  }
  if (resource.infinite_resource === true) {
    warnings.push(`${resource.name} is infinite; its yield scales with the amount left, estimated at 100%`)
  }
  return {
    item: step.item,
    kind: step.machine === undefined ? 'hand_mine' : 'drill',
    source: resource.name,
    machine: step.machine,
    machine_count: step.machine_count ?? 1,
    seconds_per_cycle: mineable.mining_time * seconds_factor,
    output_per_cycle: amount_of(mineable.products, step.item) * output_factor,
    ingredients: [],
  }
}

function with_fuel(step: EstimateStepInput, machine: LuaEntityPrototype, fuel: string | undefined): EstimateStepInput | string {
  if (fuel === undefined) return step
  const burner = machine.burner_prototype
  if (burner === undefined) return `step ${step.item}: ${machine.name} does not burn fuel`
  const burn = rates.fuel_burn(machine.get_max_energy_usage() * 60, burner, fuel)
  if (burn.accepted !== true || burn.per_minute === undefined) return `step ${step.item}: ${machine.name} cannot burn ${fuel}`
  return { ...step, fuel: { name: fuel, per_second_per_machine: burn.per_minute / 60 } }
}

function resolve_step(actor: ControlledActor, step: LiveEstimateStep, warnings: string[]): EstimateStepInput | string {
  const machine_name = step.machine
  if (machine_name === undefined) {
    if (step.fuel !== undefined) return `step ${step.item}: fuel needs a machine`
    const character = actor.character
    if (character === undefined) return `step ${step.item}: the actor has no character for hand work`
    const categories = character.prototype.crafting_categories
    if (step.resource === undefined) {
      const hand_speed = rates.hand_crafting_speed(actor)
      const choice = choose_recipe(actor, step, recipe => crafting_categories_support_recipe(categories, recipe)
        && recipe.prototype?.hidden_from_player_crafting !== true, 'hand crafting')
      const recipe = choice.recipe
      if (recipe !== undefined) {
        if (hand_speed === undefined || !(hand_speed > 0)) return `step ${step.item}: the actor cannot hand craft`
        if (!(recipe.energy > 0)) return `step ${step.item}: recipe ${recipe.name} has no crafting time`
        return {
          item: step.item,
          kind: 'hand_craft',
          source: recipe.name,
          machine_count: step.machine_count ?? 1,
          seconds_per_cycle: recipe.energy / hand_speed,
          output_per_cycle: amount_of(recipe.products, step.item),
          ingredients: ingredients_of(recipe),
        }
      }
      // Nothing to hand craft: fall through to hand mining, unless the choice was
      // a bad recipe name or ambiguous.
      if (choice.none !== true) return choice.error ?? `step ${step.item}: no recipe`
    }
    const mining_speed = rates.hand_mining_speed(actor)
    const resource_categories = character.prototype.resource_categories
    const resource = choose_resource(step, resource => resource_categories?.[resource_categories_of(resource)] === true
      && (resource.mineable_properties as any).required_fluid === undefined, 'hand mining')
    if (typeof resource === 'string') return step.resource !== undefined ? resource : `step ${step.item}: nothing the actor can hand craft or hand mine makes ${step.item}`
    if (mining_speed === undefined || !(mining_speed > 0)) return `step ${step.item}: the actor cannot hand mine`
    return mining_step(actor, step, resource, 1 / mining_speed, 1, warnings)
  }

  const machine = prototypes.entity[machine_name]
  if (machine === undefined) return `step ${step.item}: unknown machine ${machine_name}`

  if (machine.type === 'mining-drill') {
    const mining_speed = machine.mining_speed ?? 0
    if (!(mining_speed > 0)) return `step ${step.item}: ${machine_name} has no mining speed`
    const categories = machine.resource_categories
    const resource = choose_resource(step, resource => categories?.[resource_categories_of(resource)] === true, machine_name)
    if (typeof resource === 'string') return resource
    const productivity = rates.drill_productivity_bonus(actor.force, machine)
    const mined = mining_step(actor, step, resource, 1 / mining_speed, 1 + productivity, warnings)
    if (typeof mined === 'string') return mined
    return with_fuel(mined, machine, step.fuel)
  }

  if (CRAFTING_MACHINE_TYPES[machine.type] !== true) return `step ${step.item}: ${machine_name} is not a crafting machine or mining drill`
  const crafting_speed = machine.get_crafting_speed()
  if (!(crafting_speed > 0)) return `step ${step.item}: ${machine_name} has no crafting speed`
  const categories = machine.crafting_categories
  const choice = choose_recipe(actor, step, recipe => crafting_categories_support_recipe(categories, recipe), machine_name)
  const recipe = choice.recipe
  if (recipe === undefined) return choice.error ?? `step ${step.item}: no recipe`
  if (!(recipe.energy > 0)) return `step ${step.item}: recipe ${recipe.name} has no crafting time`
  if (recipe.enabled !== true) warnings.push(`recipe ${recipe.name} is not researched yet`)
  return with_fuel({
    item: step.item,
    kind: 'machine',
    source: recipe.name,
    machine: machine_name,
    machine_count: step.machine_count ?? 1,
    seconds_per_cycle: recipe.energy / crafting_speed,
    output_per_cycle: amount_of(recipe.products, step.item),
    ingredients: ingredients_of(recipe),
  }, machine, step.fuel)
}

function request_shape_error(request: LiveEstimateRequest) {
  if (typeof request !== 'object' || request === undefined) return 'request must be a table'
  if (!valid_name(request.target)) return 'target must be an item or fluid name'
  if (typeof request.steps !== 'object' || request.steps === undefined) return 'steps must be a list'
  if (request.steps.length > pure.MAX_ESTIMATE_STEPS) return `at most ${pure.MAX_ESTIMATE_STEPS} steps`
  for (const step of request.steps) {
    if (typeof step !== 'object' || !valid_name(step.item)) return 'each step needs an item name'
    if (!optional_name(step.recipe) || !optional_name(step.resource) || !optional_name(step.machine) || !optional_name(step.fuel)) {
      return `step ${step.item}: names must be 1 to ${MAX_NAME_LENGTH} characters`
    }
    if (step.machine_count !== undefined && typeof step.machine_count !== 'number') return `step ${step.item}: machine_count must be a number`
  }
  return undefined
}

export function estimate_production_for_actor(actor: ControlledActor, request: LiveEstimateRequest) {
  const shape_error = request_shape_error(request)
  if (shape_error !== undefined) return { ok: false, error: shape_error }
  const warnings: string[] = []
  const steps: EstimateStepInput[] = []
  for (const step of request.steps) {
    const resolved = resolve_step(actor, step, warnings)
    if (typeof resolved === 'string') return { ok: false, error: resolved }
    steps.push(resolved)
  }
  const result = pure.estimate_production({ target: request.target, count: request.count, steps })
  if (result.ok !== true) return result
  return { ...result, rate_basis: rates.RATE_BASIS, warnings: warnings.length > 0 ? warnings : undefined }
}
