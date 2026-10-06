import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { recipe_unlock_summary } from './goal_requirements'
import { find_world_entities } from './npc_vision'

export type BootstrapDependencyStatus = 'already_satisfied' | 'needs_crafting' | 'needs_acquisition/processing'

export interface BootstrapMachineCandidate {
  name: string
  type?: string
  held_count: number
  place_items: Array<{ name: string, count: number }>
}

// A compatible machine already standing in the world. Acquisition, placement and operational readiness stay
// separate facts: `readiness` is the entity's own status (`working`, or the engine's status name such as
// `no_fuel`/`no_power`/`no_ingredients`/`full_output`), and `status_code` is the raw engine status value. Finding a
// machine never proves it is fueled or powered.
export interface BootstrapPlacedMachine {
  unit_number?: number
  name: string
  position: { x: number, y: number }
  distance: number
  working: boolean
  readiness: string
  status_code?: number
  // Crafting machines only (assembling machines and furnaces): the recipe currently set, so a machine set to the
  // wrong recipe is visible. Absent means no recipe is set (or the entity is not a crafting machine). A furnace with no
  // current recipe reports the one it last smelted as `previous_recipe_name`.
  recipe_name?: string
  previous_recipe_name?: string
}

export interface BootstrapMachineDependency {
  required: number
  held: number
  status: BootstrapDependencyStatus
  // `placed_instance`: a compatible machine is already placed (see `placed`, with unit_numbers), so acquisition is
  // not needed and `placed_instance_required` is false. `inventory_acquisition`: only held items were counted.
  satisfaction_scope: 'inventory_acquisition' | 'placed_instance'
  placed_instance_required: boolean
  matched_count: number
  truncated: boolean
  candidates: BootstrapMachineCandidate[]
  // Compatible machines placed on the actor's surface for the actor's force within `placed_search_radius` tiles of
  // the actor: the total, how many report `working`, and up to MAX_PLACED_MACHINES of them nearest first.
  placed_count: number
  placed_working_count: number
  // Compatible machines in range that are marked for deconstruction: not counted in `placed_count`, not listed in
  // `placed`, and they do not satisfy the dependency.
  placed_marked_for_deconstruction_count: number
  placed_truncated: boolean
  placed_search_radius: number
  placed: BootstrapPlacedMachine[]
  selected_item_dependency?: BootstrapDependency
}

export interface BootstrapDependency {
  type: 'item' | 'fluid' | 'machine'
  name: string
  required: number
  held: number
  missing: number
  status: BootstrapDependencyStatus
  role?: 'ingredient' | 'crafting_machine'
  reason?: string
  resolution?: {
    kind: 'crafting' | 'processing' | 'acquisition'
    recipe_name?: string
    categories?: string[]
    crafts_needed?: number
    producer_candidates?: string[]
  }
  machine_dependency?: BootstrapMachineDependency
  dependencies?: BootstrapDependency[]
}

export interface RecipeBootstrapPlan {
  requested_crafts: number
  craftable_now_count: number
  craftable_now: boolean
  inventory_overlay: {
    outputs: Array<Record<string, unknown>>
    ingredients: Array<Record<string, unknown>>
    machine_dependency?: BootstrapMachineDependency
  }
  dependencies: BootstrapDependency[]
  first_unresolved?: BootstrapDependency
}

const MAX_BOOTSTRAP_DEPTH = 6
const MAX_BOOTSTRAP_NODES = 32
const MAX_MACHINE_CANDIDATES = 8
const MAX_PRODUCER_CANDIDATES = 8
const MAX_PLACED_MACHINES = 6
const PLACED_MACHINE_SEARCH_RADIUS = 128
const MAX_REQUIRES_MACHINE_INGREDIENTS = 8
const MAX_REQUIRES_MACHINE_PRODUCTS = 8

function sort_strings(values: string[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j] < values[i]) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
}

function sort_named<T extends { name: string }>(values: T[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
}

function categories_for(recipe: any): string[] {
  const categories: string[] = []
  if (typeof recipe?.category === 'string') categories.push(recipe.category)
  for (const category of recipe?.additional_categories ?? []) {
    if (typeof category !== 'string') continue
    let duplicate = false
    for (const existing of categories) {
      if (existing === category) {
        duplicate = true
        break
      }
    }
    if (!duplicate) categories.push(category)
  }
  sort_strings(categories)
  return categories
}

function character_can_craft(actor: ControlledActor, categories: string[]) {
  const supported = actor.character?.prototype.crafting_categories
  if (!supported) return false
  for (const category of categories) {
    if (supported[category]) return true
  }
  return false
}

function inventory_count(actor: ControlledActor, item_name: string) {
  return actor.get_main_inventory()?.get_item_count(item_name) ?? 0
}

function deterministic_amount(value: any) {
  return typeof value?.amount === 'number' && value.amount > 0 ? value.amount : undefined
}

function item_product_amount(recipe: any, item_name: string) {
  for (const product of recipe?.products ?? []) {
    if (product?.type === 'item' && product?.name === item_name) return deterministic_amount(product)
  }
  return undefined
}

function enabled_producers(actor: ControlledActor, item_name: string) {
  const result: any[] = []
  for (const [, recipe] of pairs(actor.force.recipes)) {
    if (!recipe || recipe.enabled !== true || recipe.hidden === true) continue
    for (const product of recipe.products ?? []) {
      if (product?.type === 'item' && product?.name === item_name) {
        result.push(recipe)
        break
      }
    }
  }
  sort_named(result)
  return result
}

function pick_producer(actor: ControlledActor, item_name: string) {
  const producers = enabled_producers(actor, item_name)
  if (producers.length === 0) return { producers, recipe: undefined }

  for (const recipe of producers) {
    if (character_can_craft(actor, categories_for(recipe))) return { producers, recipe }
  }
  return { producers, recipe: producers[0] }
}

function place_items_for_machine(actor: ControlledActor, prototype: any) {
  const place_items: Array<{ name: string, count: number }> = []
  let held_count = 0
  for (const [, item] of pairs((prototype?.items_to_place_this ?? {}) as Record<number, any>)) {
    if (!item || typeof item.name !== 'string') continue
    const required = typeof item.count === 'number' && item.count > 0 ? item.count : 1
    place_items.push({ name: item.name, count: required })
    const held = inventory_count(actor, item.name)
    held_count += math.floor(held / required)
  }
  sort_named(place_items)
  return { place_items, held_count }
}

function machine_candidates(actor: ControlledActor, categories: string[]) {
  const seen: Record<string, boolean> = {}
  const candidates: BootstrapMachineCandidate[] = []
  const names: string[] = []

  for (const category of categories) {
    const matches = prototypes.get_entity_filtered([
      { filter: 'crafting-category', crafting_category: category },
    ])
    for (const [name, prototype] of pairs(matches)) {
      if (seen[name] === true) continue
      seen[name] = true
      names.push(name)
      const place = place_items_for_machine(actor, prototype)
      candidates.push({
        name,
        type: prototype.type,
        held_count: place.held_count,
        place_items: place.place_items,
      })
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i]
      const right = candidates[j]
      if (right.held_count > left.held_count || (right.held_count === left.held_count && right.name < left.name)) {
        candidates[i] = right
        candidates[j] = left
      }
    }
  }

  let held = 0
  for (const candidate of candidates) held = math.max(held, candidate.held_count)
  return {
    matched_count: candidates.length,
    truncated: candidates.length > MAX_MACHINE_CANDIDATES,
    held,
    candidates: candidates.slice(0, MAX_MACHINE_CANDIDATES),
    names,
  }
}

function status_name(status: defines.entity_status | undefined) {
  if (status === undefined) return undefined
  for (const [name, value] of pairs(defines.entity_status)) {
    if (value === status) return name as string
  }
  return undefined
}

function round_tenth(value: number) {
  return math.floor(value * 10 + 0.5) / 10
}

// Placed machines of the given prototypes on the actor's surface and force, nearest first. The engine scan is bounded
// by PLACED_MACHINE_SEARCH_RADIUS; only MAX_PLACED_MACHINES entries are reported, but every machine in range is counted.
function placed_machines(actor: ControlledActor, names: string[]) {
  const result = {
    placed_count: 0,
    placed_working_count: 0,
    placed_marked_for_deconstruction_count: 0,
    placed_truncated: false,
    placed_search_radius: PLACED_MACHINE_SEARCH_RADIUS,
    placed: [] as BootstrapPlacedMachine[],
  }
  const surface = actor.surface
  const origin = actor.position
  if (!surface || !origin || names.length === 0) return result

  const ranked: Array<{ entity: LuaEntity, distance_squared: number, unit_number: number }> = []
  for (const entity of find_world_entities(surface, { name: names, force: actor.force, position: origin, radius: PLACED_MACHINE_SEARCH_RADIUS })) {
    if (!entity.valid) continue
    if (entity.to_be_deconstructed()) {
      result.placed_marked_for_deconstruction_count++
      continue
    }
    const dx = entity.position.x - origin.x
    const dy = entity.position.y - origin.y
    ranked.push({ entity, distance_squared: dx * dx + dy * dy, unit_number: entity.unit_number ?? 0 })
    if (entity.status === defines.entity_status.working) result.placed_working_count++
  }
  result.placed_count = ranked.length
  result.placed_truncated = ranked.length > MAX_PLACED_MACHINES

  const keep = math.min(MAX_PLACED_MACHINES, ranked.length)
  for (let i = 0; i < keep; i++) {
    let best = i
    for (let j = i + 1; j < ranked.length; j++) {
      const left = ranked[j]
      const right = ranked[best]
      if (left.distance_squared < right.distance_squared || (left.distance_squared === right.distance_squared && left.unit_number < right.unit_number)) best = j
    }
    const swap = ranked[i]
    ranked[i] = ranked[best]
    ranked[best] = swap

    const entity = ranked[i].entity
    const status = entity.status
    const working = status === defines.entity_status.working
    let recipe_name: string | undefined
    let previous_recipe_name: string | undefined
    if (entity.type === 'assembling-machine' || entity.type === 'furnace') {
      const [recipe] = entity.get_recipe()
      recipe_name = recipe?.name
      if (recipe_name === undefined && entity.type === 'furnace') previous_recipe_name = entity.previous_recipe?.name.name
    }
    result.placed.push({
      unit_number: entity.unit_number,
      name: entity.name,
      position: { x: entity.position.x, y: entity.position.y },
      distance: round_tenth(math.sqrt(ranked[i].distance_squared)),
      working,
      readiness: working ? 'working' : status === undefined ? 'status_unavailable' : (status_name(status) ?? 'unmapped_status'),
      status_code: status,
      recipe_name,
      previous_recipe_name,
    })
  }
  return result
}

interface ResolveState {
  nodes: number
  trail: string[]
}

interface ResolveResult {
  node: BootstrapDependency
  first?: BootstrapDependency
}

function trail_contains(trail: string[], item_name: string) {
  for (const value of trail) {
    if (value === item_name) return true
  }
  return false
}

function producer_names(producers: any[]) {
  const names: string[] = []
  for (let index = 0; index < producers.length && index < MAX_PRODUCER_CANDIDATES; index++) names.push(producers[index].name)
  return names
}

function machine_dependency_for(
  actor: ControlledActor,
  recipe: any,
  depth: number,
  state: ResolveState,
): { dependency?: BootstrapMachineDependency, first?: BootstrapDependency } {
  const categories = categories_for(recipe)
  if (character_can_craft(actor, categories)) return {}

  const machines = machine_candidates(actor, categories)
  const placed = placed_machines(actor, machines.names)
  // A machine already standing in the world satisfies the acquisition dependency; whether it is fueled, powered or
  // supplied is reported separately per instance (`readiness`), never inferred from its existence.
  if (placed.placed_count >= 1 || machines.held >= 1) {
    return {
      dependency: {
        required: 1,
        held: machines.held,
        status: 'already_satisfied',
        satisfaction_scope: placed.placed_count >= 1 ? 'placed_instance' : 'inventory_acquisition',
        placed_instance_required: placed.placed_count < 1,
        matched_count: machines.matched_count,
        truncated: machines.truncated,
        candidates: machines.candidates,
        ...placed,
      },
    }
  }

  let selected_item_dependency: BootstrapDependency | undefined
  let first: BootstrapDependency | undefined
  for (const candidate of machines.candidates) {
    if (candidate.place_items.length === 0) continue
    const place_item = candidate.place_items[0]
    const resolved = resolve_item_dependency(actor, place_item.name, place_item.count, depth + 1, state)
    selected_item_dependency = { ...resolved.node, role: 'crafting_machine' }
    first = resolved.first ? { ...resolved.first, role: resolved.first.role ?? 'crafting_machine' } : selected_item_dependency
    break
  }

  return {
    dependency: {
      required: 1,
      held: 0,
      status: selected_item_dependency?.status ?? 'needs_acquisition/processing',
      satisfaction_scope: 'inventory_acquisition',
      placed_instance_required: true,
      matched_count: machines.matched_count,
      truncated: machines.truncated,
      candidates: machines.candidates,
      ...placed,
      selected_item_dependency,
    },
    first,
  }
}

function resolve_item_dependency(
  actor: ControlledActor,
  item_name: string,
  required: number,
  depth: number,
  state: ResolveState,
): ResolveResult {
  const held = inventory_count(actor, item_name)
  const missing = math.max(0, required - held)
  if (missing <= 0) {
    const node: BootstrapDependency = {
      type: 'item',
      name: item_name,
      required,
      held,
      missing: 0,
      status: 'already_satisfied',
    }
    return { node }
  }

  if (state.nodes >= MAX_BOOTSTRAP_NODES || depth > MAX_BOOTSTRAP_DEPTH) {
    const node: BootstrapDependency = {
      type: 'item',
      name: item_name,
      required,
      held,
      missing,
      status: 'needs_acquisition/processing',
      reason: 'bootstrap_dependency_limit',
      resolution: { kind: 'acquisition' },
    }
    return { node, first: node }
  }

  if (trail_contains(state.trail, item_name)) {
    const node: BootstrapDependency = {
      type: 'item',
      name: item_name,
      required,
      held,
      missing,
      status: 'needs_acquisition/processing',
      reason: 'recipe_cycle',
      resolution: { kind: 'acquisition' },
    }
    return { node, first: node }
  }

  state.nodes++
  const chosen = pick_producer(actor, item_name)
  const recipe = chosen.recipe
  if (!recipe) {
    const node: BootstrapDependency = {
      type: 'item',
      name: item_name,
      required,
      held,
      missing,
      status: 'needs_acquisition/processing',
      resolution: { kind: 'acquisition', producer_candidates: [] },
    }
    return { node, first: node }
  }

  const product_amount = item_product_amount(recipe, item_name)
  if (product_amount === undefined) {
    const node: BootstrapDependency = {
      type: 'item',
      name: item_name,
      required,
      held,
      missing,
      status: 'needs_acquisition/processing',
      reason: 'non_deterministic_product_amount',
      resolution: {
        kind: 'processing',
        recipe_name: recipe.name,
        categories: categories_for(recipe),
        producer_candidates: producer_names(chosen.producers),
      },
    }
    return { node, first: node }
  }

  const crafts_needed = math.ceil(missing / product_amount)
  const categories = categories_for(recipe)
  const hand_craftable = character_can_craft(actor, categories)
  const nested_state: ResolveState = { nodes: state.nodes, trail: [...state.trail, item_name] }
  const dependencies: BootstrapDependency[] = []
  let first: BootstrapDependency | undefined

  let machine_dependency: BootstrapMachineDependency | undefined
  if (!hand_craftable) {
    const machine = machine_dependency_for(actor, recipe, depth, nested_state)
    machine_dependency = machine.dependency
    if (machine.first) first = machine.first
  }

  for (const ingredient of recipe.ingredients ?? []) {
    const amount = deterministic_amount(ingredient)
    if (ingredient?.type !== 'item' || typeof ingredient?.name !== 'string' || amount === undefined) {
      const required_amount = amount === undefined ? crafts_needed : amount * crafts_needed
      const held_amount = ingredient?.type === 'item' && typeof ingredient?.name === 'string'
        ? inventory_count(actor, ingredient.name)
        : 0
      const unresolved: BootstrapDependency = {
        type: ingredient?.type === 'fluid' ? 'fluid' : 'item',
        name: typeof ingredient?.name === 'string' ? ingredient.name : 'unknown',
        required: required_amount,
        held: held_amount,
        missing: math.max(0, required_amount - held_amount),
        status: 'needs_acquisition/processing',
        reason: 'unsupported_or_non_deterministic_ingredient',
        resolution: { kind: 'acquisition' },
      }
      dependencies.push(unresolved)
      if (!first) first = unresolved
      continue
    }

    const resolved = resolve_item_dependency(actor, ingredient.name, amount * crafts_needed, depth + 1, nested_state)
    dependencies.push({ ...resolved.node, role: 'ingredient' })
    if (!first && resolved.first) first = resolved.first
  }

  state.nodes = nested_state.nodes
  const status: BootstrapDependencyStatus = hand_craftable ? 'needs_crafting' : 'needs_acquisition/processing'
  const node: BootstrapDependency = {
    type: 'item',
    name: item_name,
    required,
    held,
    missing,
    status,
    resolution: {
      kind: hand_craftable ? 'crafting' : 'processing',
      recipe_name: recipe.name,
      categories,
      crafts_needed,
      producer_candidates: producer_names(chosen.producers),
    },
    machine_dependency,
    dependencies,
  }
  return { node, first: first ?? node }
}

function direct_inventory_overlay(actor: ControlledActor, recipe: any, requested_crafts: number, dependencies: BootstrapDependency[], machine_dependency?: BootstrapMachineDependency) {
  const outputs: Array<Record<string, unknown>> = []
  for (const product of recipe.products ?? []) {
    if (typeof product?.name !== 'string') continue
    const amount = deterministic_amount(product)
    const record: Record<string, unknown> = {
      type: product.type,
      name: product.name,
      required: amount === undefined ? undefined : amount * requested_crafts,
    }
    if (product.type === 'item') record.held = inventory_count(actor, product.name)
    outputs.push(record)
  }

  const ingredients: Array<Record<string, unknown>> = []
  for (const dependency of dependencies) {
    ingredients.push({
      type: dependency.type,
      name: dependency.name,
      required: dependency.required,
      held: dependency.held,
      missing: dependency.missing,
      status: dependency.status,
    })
  }

  return { outputs, ingredients, machine_dependency }
}

export function recipe_bootstrap_for_actor(actor: ControlledActor, recipe: any, requested_crafts: number = 1): RecipeBootstrapPlan {
  const count = typeof requested_crafts === 'number' && requested_crafts === math.floor(requested_crafts) && requested_crafts >= 1
    ? requested_crafts
    : 1
  const categories = categories_for(recipe)
  const hand_craftable = character_can_craft(actor, categories)
  const craftable_now_count = hand_craftable ? actor.get_craftable_count(recipe.name) : 0
  const dependencies: BootstrapDependency[] = []
  const state: ResolveState = { nodes: 0, trail: [] }
  let first_unresolved: BootstrapDependency | undefined

  let machine_dependency: BootstrapMachineDependency | undefined
  if (!hand_craftable) {
    const machine = machine_dependency_for(actor, recipe, 0, state)
    machine_dependency = machine.dependency
    if (machine.first) first_unresolved = machine.first
  }

  for (const ingredient of recipe.ingredients ?? []) {
    const amount = deterministic_amount(ingredient)
    if (ingredient?.type === 'item' && typeof ingredient?.name === 'string' && amount !== undefined) {
      const resolved = resolve_item_dependency(actor, ingredient.name, amount * count, 1, state)
      dependencies.push({ ...resolved.node, role: 'ingredient' })
      if (!first_unresolved && resolved.first) first_unresolved = resolved.first
      continue
    }

    const required = amount === undefined ? count : amount * count
    const unresolved: BootstrapDependency = {
      type: ingredient?.type === 'fluid' ? 'fluid' : 'item',
      name: typeof ingredient?.name === 'string' ? ingredient.name : 'unknown',
      required,
      held: 0,
      missing: required,
      status: 'needs_acquisition/processing',
      role: 'ingredient',
      reason: 'unsupported_or_non_deterministic_ingredient',
      resolution: { kind: 'acquisition' },
    }
    dependencies.push(unresolved)
    if (!first_unresolved) first_unresolved = unresolved
  }

  const craftable_now = craftable_now_count >= count
  if (craftable_now) first_unresolved = undefined

  return {
    requested_crafts: count,
    craftable_now_count,
    craftable_now,
    inventory_overlay: direct_inventory_overlay(actor, recipe, count, dependencies, machine_dependency),
    dependencies,
    first_unresolved,
  }
}

function recipe_ingredient_facts(actor: ControlledActor, recipe: any) {
  const ingredients: Array<Record<string, unknown>> = []
  for (const ingredient of recipe?.ingredients ?? []) {
    if (ingredients.length >= MAX_REQUIRES_MACHINE_INGREDIENTS) break
    ingredients.push({
      type: ingredient.type,
      name: ingredient.name,
      amount: ingredient.amount,
      held: ingredient.type === 'item' ? inventory_count(actor, ingredient.name) : undefined,
    })
  }
  return ingredients
}

function recipe_product_facts(recipe: any) {
  const products: Array<Record<string, unknown>> = []
  for (const product of recipe?.products ?? []) {
    if (products.length >= MAX_REQUIRES_MACHINE_PRODUCTS) break
    products.push({
      type: product.type,
      name: product.name,
      amount: product.amount,
      amount_min: product.amount_min,
      amount_max: product.amount_max,
      probability: product.probability,
    })
  }
  return products
}

// The recipe is enabled but its categories are not hand-craftable: it is made in a machine. Facts only, all read from
// the live game (recipe, machine prototypes, held items, placed entities); no rule about which machine to use is baked in.
function requires_machine_result(actor: ControlledActor, recipe: any, item_name: string, count: number, categories: string[]) {
  const machines = machine_candidates(actor, categories)
  const placed = placed_machines(actor, machines.names)
  const held_machines: Array<{ name: string, held_count: number }> = []
  for (const candidate of machines.candidates) {
    if (candidate.held_count >= 1) held_machines.push({ name: candidate.name, held_count: candidate.held_count })
  }
  return {
    ok: false,
    code: 'requires_machine',
    operation: 'craft_item',
    field: 'item_name',
    identity: item_name,
    recipe_name: recipe.name,
    requested_count: count,
    hand_craftable: false,
    recipe: {
      name: recipe.name,
      categories,
      energy: recipe.energy,
      ingredients: recipe_ingredient_facts(actor, recipe),
      products: recipe_product_facts(recipe),
    },
    machines: {
      matched_count: machines.matched_count,
      truncated: machines.truncated,
      candidates: machines.candidates,
      held: held_machines,
      ...placed,
    },
  }
}

export function craft_bootstrap_preflight_for_actor(actor: ControlledActor, item_name: string, count: number = 1) {
  const recipe = actor.force.recipes[item_name]
  if (!recipe) {
    return {
      ok: false,
      code: 'unknown_recipe',
      operation: 'craft_item',
      field: 'item_name',
      identity: item_name,
      expected: 'force recipe',
    }
  }
  if (!recipe.enabled) {
    return {
      ok: false,
      code: 'recipe_locked',
      operation: 'craft_item',
      field: 'item_name',
      identity: item_name,
      recipe_name: recipe.name,
      // Still a terminal refusal: this only names what unlocks the recipe and what to research next.
      unlock: recipe_unlock_summary(actor, recipe.name),
    }
  }

  const categories = categories_for(recipe)
  if (!character_can_craft(actor, categories)) return requires_machine_result(actor, recipe, item_name, count, categories)

  const bootstrap = recipe_bootstrap_for_actor(actor, recipe, count)
  if (!bootstrap.craftable_now) {
    return {
      ok: false,
      code: 'bootstrap_dependency_unresolved',
      operation: 'craft_item',
      field: 'item_name',
      identity: item_name,
      recipe_name: recipe.name,
      requested_count: count,
      craftable_now_count: bootstrap.craftable_now_count,
      bootstrap,
    }
  }

  return {
    ok: true,
    operation: 'craft_item',
    field: 'item_name',
    identity: item_name,
    recipe_name: recipe.name,
    requested_count: count,
    craftable_now_count: bootstrap.craftable_now_count,
    bootstrap,
  }
}
