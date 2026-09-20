import type { ControlledActor } from './actors/types'

export type BootstrapDependencyStatus = 'already_satisfied' | 'needs_crafting' | 'needs_acquisition/processing'

export interface BootstrapMachineCandidate {
  name: string
  type?: string
  held_count: number
  place_items: Array<{ name: string, count: number }>
}

export interface BootstrapMachineDependency {
  required: number
  held: number
  status: BootstrapDependencyStatus
  satisfaction_scope: 'inventory_acquisition'
  placed_instance_required: boolean
  matched_count: number
  truncated: boolean
  candidates: BootstrapMachineCandidate[]
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

  for (const category of categories) {
    const matches = prototypes.get_entity_filtered([
      { filter: 'crafting-category', crafting_category: category },
    ])
    for (const [name, prototype] of pairs(matches)) {
      if (seen[name] === true) continue
      seen[name] = true
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
  }
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
  if (machines.held >= 1) {
    return {
      dependency: {
        required: 1,
        held: machines.held,
        status: 'already_satisfied',
        satisfaction_scope: 'inventory_acquisition',
        placed_instance_required: true,
        matched_count: machines.matched_count,
        truncated: machines.truncated,
        candidates: machines.candidates,
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
    }
  }

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
