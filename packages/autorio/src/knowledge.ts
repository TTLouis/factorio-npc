import type { LuaEntity, LuaEntityPrototype, SurfaceCondition } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { recipe_bootstrap_for_actor } from './bootstrap_planning'
import { resolve_exact_entity } from './entity_reference'
import * as estimate from './production_estimate_live'
import * as rates from './production_rates'
import { recipe_categories } from './recipe_categories'
import { find_world_entities } from './npc_vision'

const MAX_RECIPE_MATCHES = 8
const MAX_MACHINE_MATCHES = 8
const MAX_FLUID_STORAGES = 16
const MAX_PIPE_CONNECTIONS = 16
const MAX_TOPOLOGY_RADIUS = 16
const MAX_TOPOLOGY_INSERTERS = 64
const MAX_TOPOLOGY_RELATIONS = 64

interface RecipeCandidate {
  name: string
  recipe: any
  applicability: ReturnType<typeof recipe_applicability>
}

interface MachineCandidate {
  name: string
  prototype: LuaEntityPrototype
}

function sort_named<T extends { name: string }>(values: T[]) {
  // Keep output deterministic without depending on Lua table iteration order.
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
}

// Prototype presence comes from the loaded game, not a base-game/expansion name list.
// Enabled is deliberately separate: locked recipes remain useful research dependencies.
function recipe_applicability(actor: ControlledActor, recipe: any) {
  const surface = actor.surface
  const scope = { surface_index: surface?.index }
  if (!recipe.prototype) return { ...scope, state: 'unknown', reason: 'recipe_prototype_unavailable', surface_bound: true }
  const conditions = recipe.prototype.surface_conditions as SurfaceCondition[] | undefined
  if (!conditions || conditions.length === 0) return { state: 'available', reason: 'no_surface_conditions', surface_bound: false }
  if (surface?.ignore_surface_conditions === true) return { ...scope, state: 'available', reason: 'surface_conditions_ignored', surface_bound: true }
  if (!surface) return { ...scope, state: 'unknown', reason: 'actor_surface_unavailable', surface_bound: true }
  try {
    for (const condition of conditions) {
      const value = surface.get_property(condition.property)
      if (typeof value !== 'number' || value !== value || typeof condition.min !== 'number' || typeof condition.max !== 'number') {
        return { ...scope, state: 'unknown', reason: 'surface_property_unavailable', surface_bound: true }
      }
      if (value < condition.min || value > condition.max) return { ...scope, state: 'unavailable', reason: 'surface_condition_mismatch', surface_bound: true }
    }
    return { ...scope, state: 'available', reason: 'surface_conditions_satisfied', surface_bound: true }
  }
  catch { return { ...scope, state: 'unknown', reason: 'surface_property_unavailable', surface_bound: true } }
}

function recipe_candidates(actor: ControlledActor, item_or_recipe: string) {
  const direct = actor.force.recipes[item_or_recipe]
  const direct_applicability = direct && recipe_applicability(actor, direct)
  if (direct !== undefined && direct_applicability?.state !== 'unavailable') {
    return { candidates: [{ name: direct.name, recipe: direct, applicability: direct_applicability! }], truncated: false }
  }

  const candidates: RecipeCandidate[] = []
  for (const [name, recipe] of pairs(actor.force.recipes)) {
    for (const product of recipe.products) {
      if (product.name === item_or_recipe) {
        candidates.push({ name, recipe, applicability: recipe_applicability(actor, recipe) })
        break
      }
    }
  }
  sort_named(candidates)
  // Irrelevant surface recipes must not fill the bounded response ahead of valid alternatives.
  const ordered = [...candidates.filter(candidate => candidate.applicability.state !== 'unavailable'),
    ...candidates.filter(candidate => candidate.applicability.state === 'unavailable')]
  if (direct && !candidates.some(candidate => candidate.name === direct.name)) {
    ordered.push({ name: direct.name, recipe: direct, applicability: direct_applicability! })
  }
  return {
    candidates: ordered.slice(0, MAX_RECIPE_MATCHES),
    truncated: ordered.length > MAX_RECIPE_MATCHES,
  }
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

function categories_for(recipe: any): string[] {
  // Reading the shape is recipe_categories' job -- see that module for why
  // `recipe.categories` is fatal rather than merely wrong. This was a fourth
  // hand-rolled copy of that read; it happened to be correct, but its existence
  // is what made three of the other copies survive unnoticed.
  //
  // The sort stays here: this is the only caller that needs a deterministic
  // order, because these categories reach the model as observation text.
  const categories = recipe_categories(recipe)
  sort_strings(categories)
  return categories
}

// The item whose placement creates this machine, read from the prototype (name-sorted when several do), or undefined.
// A fresh executor needs it to count how many of the machine the actor holds without assuming entity and item share a name.
function placed_by_item(prototype: LuaEntityPrototype): string | undefined {
  const names: string[] = []
  try {
    for (const stack of (prototype as any).items_to_place_this ?? []) {
      if (typeof stack?.name === 'string') names.push(stack.name)
    }
  }
  catch {
    // An unreadable placing-item list leaves the machine item unnamed rather than failing the whole recipe read.
  }
  sort_strings(names)
  return names[0]
}

function machine_summaries(categories: string[], recipe: any, fuel_name: string | undefined) {
  const seen: Record<string, boolean> = {}
  const candidates: MachineCandidate[] = []

  for (const category of categories) {
    const matches = prototypes.get_entity_filtered([
      { filter: 'crafting-category', crafting_category: category },
    ])
    for (const [name, prototype] of pairs(matches)) {
      if (seen[name] === true) continue
      seen[name] = true
      candidates.push({ name, prototype })
    }
  }

  sort_named(candidates)
  return {
    matched_count: candidates.length,
    truncated: candidates.length > MAX_MACHINE_MATCHES,
    machines: candidates.slice(0, MAX_MACHINE_MATCHES).map(({ name, prototype }) => ({
      name,
      type: prototype.type,
      placed_by_item: placed_by_item(prototype),
      ...rates.machine_craft_rate(prototype, recipe, fuel_name),
    })),
  }
}

// Seconds per craft by hand for this actor, only when its hands can make the recipe.
function hand_crafting_summary(actor: ControlledActor, recipe: any, hand_craftable: boolean) {
  if (!hand_craftable || recipe.prototype?.hidden_from_player_crafting === true) return undefined
  const crafting_speed = rates.hand_crafting_speed(actor)
  if (crafting_speed === undefined || !(crafting_speed > 0) || !(recipe.energy > 0)) return undefined
  return {
    crafting_speed: rates.round_rate(crafting_speed),
    seconds_per_craft: rates.round_rate(recipe.energy / crafting_speed),
  }
}

function character_can_craft(actor: ControlledActor, categories: string[]) {
  const supported = actor.character?.prototype.crafting_categories
  if (!supported) return false
  for (const category of categories) {
    if (supported[category]) return true
  }
  return false
}

function ingredient_summary(ingredient: any) {
  return {
    type: ingredient.type,
    name: ingredient.name,
    amount: ingredient.amount,
    minimum_temperature: ingredient.minimum_temperature,
    maximum_temperature: ingredient.maximum_temperature,
    temperature: ingredient.temperature,
    fluidbox_index: ingredient.fluidbox_index,
  }
}

function product_summary(product: any) {
  return {
    type: product.type,
    name: product.name,
    amount: product.amount,
    amount_min: product.amount_min,
    amount_max: product.amount_max,
    independent_probability: product.independent_probability,
    temperature: product.temperature,
    fluidbox_index: product.fluidbox_index,
  }
}

function ingredient_summaries(recipe: any) {
  const result: Array<Record<string, unknown>> = []
  for (const ingredient of recipe.ingredients ?? []) result.push(ingredient_summary(ingredient))
  return result
}

function product_summaries(recipe: any) {
  const result: Array<Record<string, unknown>> = []
  for (const product of recipe.products ?? []) result.push(product_summary(product))
  return result
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function entity_summary(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: entity.position,
    direction: entity.direction,
    force: entity.force?.name,
  }
}

function same_entity(a: LuaEntity | undefined, b: LuaEntity) {
  if (!a || !a.valid) return false
  if (a.unit_number !== undefined && b.unit_number !== undefined) return a.unit_number === b.unit_number
  return a === b
}

function fluidbox_prototype_summary(value: any) {
  if (!value) return []
  const values: any[] = value.production_type ? [value] : value
  const result: Array<Record<string, unknown>> = []
  for (const prototype of values) {
    result.push({
      index: prototype.index,
      production_type: prototype.production_type,
      filter: prototype.filter?.name,
      minimum_temperature: prototype.minimum_temperature,
      maximum_temperature: prototype.maximum_temperature,
    })
  }
  return result
}

function fluid_storage_summary(entity: LuaEntity, index: number) {
  const fluidbox = entity.fluidbox
  const prototypes_for_storage = fluidbox_prototype_summary(fluidbox.get_prototype(index))
  const connections = fluidbox.get_pipe_connections(index) ?? []
  const current_fluid = entity.get_fluid(index)

  return {
    index,
    capacity: fluidbox.get_capacity(index),
    current_fluid: current_fluid
      ? {
          name: current_fluid.name,
          amount: current_fluid.amount,
          temperature: current_fluid.temperature,
        }
      : undefined,
    prototypes: prototypes_for_storage,
    pipe_connections_truncated: connections.length > MAX_PIPE_CONNECTIONS,
    pipe_connections: connections.slice(0, MAX_PIPE_CONNECTIONS).map(connection => ({
      flow_direction: connection.flow_direction,
      connection_type: connection.connection_type,
      position: connection.position,
      target_position: connection.target_position,
      target: entity_summary(connection.target?.owner),
      target_fluidbox_index: connection.target_fluidbox_index,
      target_pipe_connection_index: connection.target_pipe_connection_index,
    })),
  }
}

function belt_connectable(entity: LuaEntity) {
  return entity.type === 'transport-belt'
    || entity.type === 'underground-belt'
    || entity.type === 'splitter'
    || entity.type === 'loader'
    || entity.type === 'loader-1x1'
    || entity.type === 'linked-belt'
}

function relation_sort_key(relation: any) {
  const from = relation.from?.unit_number ?? 0
  const via = relation.via?.unit_number ?? 0
  const to = relation.to?.unit_number ?? relation.neighbour?.unit_number ?? 0
  const storage = relation.fluidbox_index ?? 0
  return `${relation.kind}:${from}:${via}:${to}:${storage}`
}

function sort_relations(relations: Array<Record<string, unknown>>) {
  for (let i = 0; i < relations.length; i++) {
    for (let j = i + 1; j < relations.length; j++) {
      if (relation_sort_key(relations[j]) < relation_sort_key(relations[i])) {
        const tmp = relations[i]
        relations[i] = relations[j]
        relations[j] = tmp
      }
    }
  }
}

function push_relation(relations: Array<Record<string, unknown>>, relation: Record<string, unknown>) {
  if (relations.length < MAX_TOPOLOGY_RELATIONS) relations.push(relation)
}

function add_inserter_route(relations: Array<Record<string, unknown>>, inserter: LuaEntity) {
  push_relation(relations, {
    kind: 'item_transfer',
    from: entity_summary(inserter.pickup_target),
    via: entity_summary(inserter),
    to: entity_summary(inserter.drop_target),
    pickup_position: inserter.pickup_position,
    drop_position: inserter.drop_position,
  })
}

interface ResourceCandidate {
  name: string
  prototype: LuaEntityPrototype
}

function resource_yields(resource: LuaEntityPrototype, item_name: string) {
  for (const product of (resource.mineable_properties as any).products ?? []) {
    if (product.name === item_name) return true
  }
  return false
}

// Resource prototypes named `resource_or_item`, or whose mining yields it.
function resources_yielding(resource_or_item: string) {
  const result: ResourceCandidate[] = []
  const matches = prototypes.get_entity_filtered([{ filter: 'type', type: 'resource' }])
  for (const [name, prototype] of pairs(matches)) {
    if (name === resource_or_item || resource_yields(prototype, resource_or_item)) result.push({ name, prototype })
  }
  sort_named(result)
  return result
}

// Resource prototypes whose mining yields `item_name` as a product, by prototype data only. Unlike resources_yielding it
// does not match a resource merely named like the query: the answer says what is MINED as this item.
function resources_mining_product(item_name: string) {
  const result: ResourceCandidate[] = []
  const matches = prototypes.get_entity_filtered([{ filter: 'type', type: 'resource' }])
  for (const [name, prototype] of pairs(matches)) {
    if (resource_yields(prototype, item_name)) result.push({ name, prototype })
  }
  sort_named(result)
  return result
}

// Bounded, deterministic (name-sorted) resource names that mine into the queried item; undefined when none do.
function mined_from_names(item_name: string) {
  const names = resources_mining_product(item_name).map(resource => resource.name)
  return names.length > 0 ? names.slice(0, MAX_RECIPE_MATCHES) : undefined
}

const MAX_FUEL_ITEMS = 6

// Fuel facts for burner machines, from item and resource prototypes only: every item whose fuel category a burner
// accepts (with its fuel value), and the resources whose mining yields it. Items some resource yields come first, then
// name order, so the bounded list keeps the natively minable fuels. Non-resource sources (trees and the like) are not
// derived here: an item with no `mined_from` has no resource source, which is not a claim that nothing yields it.
function burner_fuel_summary(categories: string[]) {
  const accepted: Record<string, boolean> = {}
  for (const category of categories) accepted[category] = true
  const sourced: Array<{ name: string, category: string, fuel_value: number, mined_from: string[] }> = []
  const unsourced: Array<{ name: string, category: string, fuel_value: number, mined_from: undefined }> = []
  for (const [name, prototype] of pairs(prototypes.item)) {
    const category = (prototype as any).fuel_category as string | undefined
    const fuel_value = (prototype as any).fuel_value as number | undefined
    if (category === undefined || accepted[category] !== true || typeof fuel_value !== 'number' || !(fuel_value > 0)) continue
    const mined_from = mined_from_names(name)
    if (mined_from !== undefined) sourced.push({ name, category, fuel_value, mined_from })
    else unsourced.push({ name, category, fuel_value, mined_from: undefined })
  }
  sort_named(sourced)
  sort_named(unsourced)
  const ordered: Array<{ name: string, category: string, fuel_value: number, mined_from: string[] | undefined }> = [...sourced, ...unsourced]
  return {
    categories,
    matched_count: ordered.length,
    truncated: ordered.length > MAX_FUEL_ITEMS,
    items: ordered.slice(0, MAX_FUEL_ITEMS),
  }
}

function drill_summaries(actor: ControlledActor, resource: LuaEntityPrototype, category: string, fuel_name: string | undefined) {
  const candidates: MachineCandidate[] = []
  const matches = prototypes.get_entity_filtered([{ filter: 'type', type: 'mining-drill' }])
  for (const [name, prototype] of pairs(matches)) {
    if (prototype.resource_categories?.[category] === true) candidates.push({ name, prototype })
  }
  sort_named(candidates)
  return {
    matched_count: candidates.length,
    truncated: candidates.length > MAX_MACHINE_MATCHES,
    drills: candidates.slice(0, MAX_MACHINE_MATCHES).map(({ name, prototype }) => ({
      name,
      ...rates.drill_mining_rate(actor.force, prototype, resource, fuel_name),
    })),
  }
}

function hand_mining_summary(actor: ControlledActor, resource: LuaEntityPrototype, category: string, required_fluid: unknown) {
  const categories = actor.character?.prototype.resource_categories
  if (categories === undefined || categories[category] !== true || required_fluid !== undefined) return undefined
  const mining_speed = rates.hand_mining_speed(actor)
  const mining_time = rates.resource_mining_time(resource)
  if (mining_speed === undefined || !(mining_speed > 0) || !(mining_time > 0)) return undefined
  const cycles_per_second = mining_speed / mining_time
  return {
    mining_speed: rates.round_rate(mining_speed),
    seconds_per_cycle: rates.round_rate(mining_time / mining_speed),
    products_per_minute: rates.product_rates_per_minute((resource.mineable_properties as any).products, cycles_per_second),
  }
}

// Mining facts for a resource (or the resources that yield an item): mining
// time, and per compatible drill its speed and output per minute. Facts only;
// how many drills to place is the planner's decision.
export function mining_details_for_actor(actor: ControlledActor, resource_or_item: string, fuel_name?: string) {
  const resources = resources_yielding(resource_or_item)
  if (resources.length === 0) {
    return { found: false, query: resource_or_item, error: 'no resource has this name or yields this item/fluid' }
  }
  return {
    found: true,
    query: resource_or_item,
    rate_basis: rates.RATE_BASIS,
    truncated: resources.length > MAX_RECIPE_MATCHES,
    resources: resources.slice(0, MAX_RECIPE_MATCHES).map(({ name, prototype }) => {
      const mineable = prototype.mineable_properties as any
      const category = prototype.resource_category ?? 'basic-solid'
      const infinite = prototype.infinite_resource === true
      const drill_result = drill_summaries(actor, prototype, category, fuel_name)
      return {
        name,
        category,
        mining_time: mineable.mining_time,
        products: product_summaries(mineable),
        required_fluid: mineable.required_fluid,
        fluid_amount: mineable.fluid_amount,
        infinite,
        // An infinite resource's yield scales with its current amount; the rates
        // below are for the prototype's normal amount (100% yield).
        normal_resource_amount: infinite ? prototype.normal_resource_amount : undefined,
        drill_count: drill_result.matched_count,
        drills: drill_result.drills,
        drills_truncated: drill_result.truncated,
        hand_mining: hand_mining_summary(actor, prototype, category, mineable.required_fluid),
      }
    }),
  }
}

export function recipe_details_for_actor(actor: ControlledActor, item_or_recipe: string, requested_count: number = 1, fuel_name?: string) {
  const { candidates, truncated } = recipe_candidates(actor, item_or_recipe)
  if (candidates.length === 0) {
    return {
      found: false,
      query: item_or_recipe,
      // Declared by the producer so the harness never matches the sentence: the game has no recipe for this name.
      code: 'no_recipe',
      error: 'no recipe produces this item/fluid and no recipe has this name',
      mined_from: mined_from_names(item_or_recipe),
    }
  }

  const recipes = candidates.map(({ name, recipe, applicability }) => {
    const categories = categories_for(recipe)
    const machine_result = machine_summaries(categories, recipe, fuel_name)
    const hand_craftable = character_can_craft(actor, categories)
    const bootstrap = recipe_bootstrap_for_actor(actor, recipe, requested_count)
    return {
      name,
      enabled: recipe.enabled,
      applicability,
      requested_crafts: bootstrap.requested_crafts,
      craftable_now_count: bootstrap.craftable_now_count,
      craftable_now: bootstrap.craftable_now,
      inventory_overlay: bootstrap.inventory_overlay,
      bootstrap: {
        dependencies: bootstrap.dependencies,
        first_unresolved: bootstrap.first_unresolved,
      },
      hidden: recipe.hidden,
      energy: recipe.energy,
      categories,
      hand_craftable_category: hand_craftable,
      hand_crafting: hand_crafting_summary(actor, recipe, hand_craftable),
      hidden_from_player_crafting: recipe.prototype?.hidden_from_player_crafting,
      allow_as_intermediate: recipe.prototype?.allow_as_intermediate,
      allow_intermediates: recipe.prototype?.allow_intermediates,
      ingredients: ingredient_summaries(recipe),
      products: product_summaries(recipe),
      crafting_machine_count: machine_result.matched_count,
      crafting_machines: machine_result.machines,
      crafting_machines_truncated: machine_result.truncated,
    }
  })

  return {
    found: true,
    query: item_or_recipe,
    truncated,
    // Present whenever the queried item is also the mining product of a resource prototype: such an item is a raw leaf
    // (acquired by mining), whatever recycling or crushing recipes also list it as a product.
    mined_from: mined_from_names(item_or_recipe),
    rate_basis: rates.RATE_BASIS,
    // Present only when some listed crafting machine burns fuel: the fuels its categories accept, and which resources mine them.
    burner_fuels: burner_fuels_of(recipes),
    recipes,
  }
}

function burner_fuels_of(recipes: Array<{ crafting_machines: Array<Record<string, unknown>> }>) {
  const categories: string[] = []
  const seen: Record<string, boolean> = {}
  for (const recipe of recipes) {
    for (const machine of recipe.crafting_machines) {
      if (machine.energy_source !== 'burner') continue
      for (const category of (machine.fuel_categories as string[] | undefined) ?? []) {
        if (seen[category] === true) continue
        seen[category] = true
        categories.push(category)
      }
    }
  }
  if (categories.length === 0) return undefined
  sort_strings(categories)
  return burner_fuel_summary(categories)
}

export function entity_geometry_for_actor(actor: ControlledActor, unit_number: number) {
  if (unit_number < 1 || math.floor(unit_number) !== unit_number) {
    return {
      found: false,
      unit_number,
      error: 'invalid unit_number',
    }
  }

  const entity = resolve_exact_entity(actor, unit_number)
  if (!entity || !entity.valid) {
    return {
      found: false,
      unit_number,
      error: 'entity not found',
    }
  }
  if (entity.surface.index !== actor.surface.index) {
    return {
      found: false,
      unit_number,
      error: 'entity is on another surface',
    }
  }

  // Factorio 2.0 exposes connection geometry through LuaFluidBox. LuaFluidBox is
  // array-like in typed-factorio, so .length maps to the Lua length operator.
  const fluid_box_count = entity.fluidbox.length
  const returned_fluid_storages = math.min(fluid_box_count, MAX_FLUID_STORAGES)
  const fluid_storages: Array<Record<string, unknown>> = []
  for (let index = 1; index <= returned_fluid_storages; index++) {
    fluid_storages.push(fluid_storage_summary(entity, index))
  }

  const inserter = entity.type === 'inserter'
  const mining_drill = entity.type === 'mining-drill'

  return {
    found: true,
    distance: math.sqrt(squared_distance(actor.position, entity.position)),
    entity: entity_summary(entity),
    item_io: inserter
      ? {
          pickup_position: entity.pickup_position,
          drop_position: entity.drop_position,
          pickup_target: entity_summary(entity.pickup_target),
          drop_target: entity_summary(entity.drop_target),
        }
      : mining_drill
        ? {
            drop_position: entity.drop_position,
            drop_target: entity_summary(entity.drop_target),
          }
        : undefined,
    fluid_storage_count: entity.fluids_count,
    fluid_box_count,
    non_fluidbox_storage_count: math.max(0, entity.fluids_count - fluid_box_count),
    fluid_storages_truncated: fluid_box_count > MAX_FLUID_STORAGES,
    fluid_storages,
  }
}

export function logistics_topology_for_actor(actor: ControlledActor, unit_number: number, radius: number = 8) {
  if (unit_number < 1 || math.floor(unit_number) !== unit_number) {
    return { found: false, unit_number, error: 'invalid unit_number' }
  }
  if (radius < 1 || radius > MAX_TOPOLOGY_RADIUS || math.floor(radius) !== radius) {
    return { found: false, unit_number, radius, error: `radius must be an integer from 1 to ${MAX_TOPOLOGY_RADIUS}` }
  }

  const center = resolve_exact_entity(actor, unit_number)
  if (!center || !center.valid) return { found: false, unit_number, error: 'entity not found' }
  if (center.surface.index !== actor.surface.index) return { found: false, unit_number, error: 'entity is on another surface' }

  const relations: Array<Record<string, unknown>> = []

  if (belt_connectable(center)) {
    const neighbours = center.belt_neighbours
    for (const input of neighbours.inputs) {
      push_relation(relations, { kind: 'belt_input', from: entity_summary(input), to: entity_summary(center) })
    }
    for (const output of neighbours.outputs) {
      push_relation(relations, { kind: 'belt_output', from: entity_summary(center), to: entity_summary(output) })
    }
  }

  if (center.type === 'inserter') add_inserter_route(relations, center)

  if (center.type === 'mining-drill' && center.drop_target?.valid) {
    push_relation(relations, {
      kind: 'direct_item_output',
      from: entity_summary(center),
      to: entity_summary(center.drop_target),
      drop_position: center.drop_position,
    })
  }

  const nearby_inserters = find_world_entities(center.surface, {
    position: center.position,
    radius,
    type: 'inserter',
    force: center.force,
    limit: MAX_TOPOLOGY_INSERTERS,
  })
  for (const inserter of nearby_inserters) {
    if (same_entity(inserter, center)) continue
    if (same_entity(inserter.pickup_target, center) || same_entity(inserter.drop_target, center)) {
      add_inserter_route(relations, inserter)
    }
  }

  const fluid_box_count = math.min(center.fluidbox.length, MAX_FLUID_STORAGES)
  for (let index = 1; index <= fluid_box_count; index++) {
    const prototypes_for_storage = fluidbox_prototype_summary(center.fluidbox.get_prototype(index))
    const connections = center.fluidbox.get_pipe_connections(index) ?? []
    for (const connection of connections.slice(0, MAX_PIPE_CONNECTIONS)) {
      if (connection.target?.owner?.valid) {
        push_relation(relations, {
          kind: 'fluid_connection',
          center: entity_summary(center),
          neighbour: entity_summary(connection.target.owner),
          fluidbox_index: index,
          production_types: prototypes_for_storage.map(prototype => prototype.production_type),
          flow_direction: connection.flow_direction,
          connection_type: connection.connection_type,
          position: connection.position,
          target_position: connection.target_position,
          target_fluidbox_index: connection.target_fluidbox_index,
        })
      }
    }
  }

  sort_relations(relations)
  return {
    found: true,
    center: entity_summary(center),
    radius,
    relation_limit: MAX_TOPOLOGY_RELATIONS,
    inserter_scan_limit: MAX_TOPOLOGY_INSERTERS,
    relations_truncated: relations.length >= MAX_TOPOLOGY_RELATIONS,
    relations,
  }
}

export function create_knowledge_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_knowledge', {
    recipe_details: (item_or_recipe: string, requested_count: number = 1, fuel_name?: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return {
          found: false,
          query: item_or_recipe,
          error: 'no controlled actor',
        }
      }
      return recipe_details_for_actor(actor, item_or_recipe, requested_count, fuel_name)
    },
    mining_details: (resource_or_item: string, fuel_name?: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { found: false, query: resource_or_item, error: 'no controlled actor' }
      }
      return mining_details_for_actor(actor, resource_or_item, fuel_name)
    },
    production_estimate: (request: estimate.LiveEstimateRequest) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, error: 'no controlled actor' }
      return estimate.estimate_production_for_actor(actor, request)
    },
    entity_geometry: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return {
          found: false,
          unit_number,
          error: 'no controlled actor',
        }
      }
      return entity_geometry_for_actor(actor, unit_number)
    },
    logistics_topology: (unit_number: number, radius: number = 8) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { found: false, unit_number, radius, error: 'no controlled actor' }
      }
      return logistics_topology_for_actor(actor, unit_number, radius)
    },
  })
}
