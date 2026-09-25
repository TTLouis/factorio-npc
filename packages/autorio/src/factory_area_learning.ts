import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { SkillDefinition } from './skills'
import { local_spatial_observation } from './construction_planning'

const MAX_RADIUS = 16
const MAX_AREA_SPAN = MAX_RADIUS * 2
const MAX_ENTITIES = 160
const MAX_RELATIONS = 256
const MAX_BLOCKS = 16
const MAX_ANALYSES = 8
const MAX_INVENTORY_ITEMS = 24
const MAX_FLUID_CONNECTIONS = 16
const MAX_RESOURCE_MATCHES = 8

export type FactoryRelationKind
  = | 'item_transfer'
    | 'belt_input'
    | 'belt_output'
    | 'direct_item_output'
    | 'fluid_connection'
    | 'boundary_input'
    | 'boundary_output'

export interface FactoryAreaBounds {
  left_top: { x: number, y: number }
  right_bottom: { x: number, y: number }
}

export interface FactoryAreaLearningRequest {
  surface_index?: number
  area?: FactoryAreaBounds
  position?: { x: number, y: number }
  radius?: number
}

export interface FactoryInventorySnapshot {
  role: string
  items: Array<{ name: string, count: number }>
}

export interface FactoryEntityObservation {
  id: string
  name: string
  type: string
  category: string
  unit_number?: number
  position: { x: number, y: number }
  direction: number
  footprint: any
  recipe?: {
    name: string
    ingredients: Array<{ type: string, name: string, amount?: number }>
    products: Array<{ type: string, name: string, amount?: number }>
  }
  inventories: FactoryInventorySnapshot[]
  belt?: { inputs: string[], outputs: string[] }
  inserter?: {
    pickup_position: { x: number, y: number }
    drop_position: { x: number, y: number }
    pickup_target?: string
    drop_target?: string
  }
  power?: { status?: unknown, energy?: number, electric_network_id?: number }
  mining?: { resources: string[], drop_position?: { x: number, y: number }, drop_target?: string }
  fluid_connections: Array<{
    fluidbox_index: number
    target?: string
    flow_direction?: unknown
    connection_type?: unknown
  }>
}

export interface FactoryGraphRelation {
  id: string
  kind: FactoryRelationKind
  from?: string
  to?: string
  via?: string
  item_names: string[]
  confidence: 'engine_exact'
  item_confidence: 'recipe_inferred' | 'ambiguous' | 'not_applicable'
  evidence_refs: string[]
  description: string
}

export interface FactoryProductionBlock {
  id: string
  title: string
  entity_ids: string[]
  relation_ids: string[]
  recipe_ids: string[]
  inputs: string[]
  intermediates: string[]
  outputs: string[]
  machine_ids: string[]
  boundary_inputs: string[]
  boundary_outputs: string[]
  ambiguities: string[]
}

export interface FactoryAreaAnalysis {
  schema_version: 1
  id: string
  tick: number
  surface_index: number
  surface_name: string
  area: FactoryAreaBounds
  spatial_source: 'local_spatial_observation'
  spatial: {
    center: { x: number, y: number }
    bounds: FactoryAreaBounds
    blocking_terrain: unknown
    entities_truncated: boolean
  }
  entities: FactoryEntityObservation[]
  relations: FactoryGraphRelation[]
  blocks: FactoryProductionBlock[]
  entity_count: number
  relations_truncated: boolean
  blocks_truncated: boolean
}

export interface FactoryBlockSummary {
  analysis_id: string
  block_id: string
  title: string
  inputs: string[]
  intermediates: string[]
  outputs: string[]
  recipes: string[]
  machines: string[]
  relation_count: number
  ambiguities: string[]
}

declare const storage: {
  airi_factory_area_analyses?: Record<string, FactoryAreaAnalysis>
  airi_factory_area_order?: string[]
  airi_factory_area_next_id?: number
}

// Read-only views. The console renders the latest analysis on every multiplayer
// peer, so these must not lazily create their tables: that write would land on
// one peer only and desync the game.
function analyses(): Record<string, FactoryAreaAnalysis> {
  return storage.airi_factory_area_analyses ?? {}
}

function analysis_order(): string[] {
  return storage.airi_factory_area_order ?? []
}

function ensure_analyses() {
  if (storage.airi_factory_area_analyses === undefined) storage.airi_factory_area_analyses = {}
  return storage.airi_factory_area_analyses
}

function ensure_analysis_order() {
  if (storage.airi_factory_area_order === undefined) storage.airi_factory_area_order = []
  return storage.airi_factory_area_order
}

function next_analysis_id() {
  const next = storage.airi_factory_area_next_id ?? 1
  storage.airi_factory_area_next_id = next + 1
  return `factory-area-${next}`
}

function finite_number(value: unknown) {
  return typeof value === 'number' && value === value && value !== math.huge && value !== -math.huge
}

function valid_position(value: any): value is { x: number, y: number } {
  return value !== undefined && value !== null && finite_number(value.x) && finite_number(value.y)
}

function valid_bounds(value: any): value is FactoryAreaBounds {
  return value !== undefined && value !== null && valid_position(value.left_top) && valid_position(value.right_bottom)
    && value.right_bottom.x > value.left_top.x && value.right_bottom.y > value.left_top.y
}

function resolve_area(actor: ControlledActor, request: FactoryAreaLearningRequest): { area: FactoryAreaBounds, center: { x: number, y: number }, half_size: number } | { error: string } {
  if (request.surface_index !== undefined && request.surface_index !== actor.surface.index) return { error: 'Factory Area Learning V1 only scans the controlled actor surface' }
  let area: FactoryAreaBounds
  if (request.area !== undefined) {
    if (!valid_bounds(request.area)) return { error: 'area must have finite left_top/right_bottom coordinates with positive size' }
    const width = request.area.right_bottom.x - request.area.left_top.x
    const height = request.area.right_bottom.y - request.area.left_top.y
    if (width > MAX_AREA_SPAN || height > MAX_AREA_SPAN) return { error: `area exceeds ${MAX_AREA_SPAN}x${MAX_AREA_SPAN} V1 bound` }
    area = request.area
  }
  else {
    const position = request.position ?? actor.position
    if (!valid_position(position)) return { error: 'position must contain finite x/y coordinates' }
    const radius = request.radius ?? 12
    if (!finite_number(radius) || radius < 1 || radius > MAX_RADIUS) return { error: `radius must be from 1 to ${MAX_RADIUS}` }
    area = {
      left_top: { x: position.x - radius, y: position.y - radius },
      right_bottom: { x: position.x + radius, y: position.y + radius },
    }
  }
  const center = { x: (area.left_top.x + area.right_bottom.x) / 2, y: (area.left_top.y + area.right_bottom.y) / 2 }
  const width = area.right_bottom.x - area.left_top.x
  const height = area.right_bottom.y - area.left_top.y
  const half_size = math.max(4, math.min(MAX_RADIUS, math.ceil(math.max(width, height) / 2)))
  return { area, center, half_size }
}

function point_in_area(position: { x: number, y: number }, area: FactoryAreaBounds) {
  return position.x >= area.left_top.x && position.x <= area.right_bottom.x
    && position.y >= area.left_top.y && position.y <= area.right_bottom.y
}

function relevant_entity(entity: LuaEntity) {
  return entity.type === 'assembling-machine' || entity.type === 'furnace' || entity.type === 'mining-drill'
    || entity.type === 'rocket-silo' || entity.type === 'inserter' || entity.type === 'transport-belt'
    || entity.type === 'underground-belt' || entity.type === 'splitter' || entity.type === 'linked-belt'
    || entity.type === 'loader' || entity.type === 'loader-1x1' || entity.type === 'container'
    || entity.type === 'logistic-container' || entity.type === 'infinity-container' || entity.type === 'electric-pole'
    || entity.type === 'pipe' || entity.type === 'pipe-to-ground' || entity.type === 'storage-tank'
    || entity.type === 'pump' || entity.type === 'offshore-pump' || entity.type === 'boiler' || entity.type === 'generator'
}

function entity_category(entity: LuaEntity) {
  if (entity.type === 'transport-belt' || entity.type === 'underground-belt' || entity.type === 'splitter' || entity.type === 'linked-belt') return 'belt'
  if (entity.type === 'loader' || entity.type === 'loader-1x1') return 'loader'
  if (entity.type === 'container' || entity.type === 'logistic-container' || entity.type === 'infinity-container') return 'storage'
  if (entity.type === 'assembling-machine' || entity.type === 'furnace' || entity.type === 'mining-drill' || entity.type === 'rocket-silo') return 'machine'
  if (entity.type === 'inserter') return 'inserter'
  if (entity.type === 'electric-pole') return 'electric-pole'
  if (entity.type === 'pipe' || entity.type === 'pipe-to-ground' || entity.type === 'storage-tank' || entity.type === 'pump' || entity.type === 'offshore-pump') return 'fluid'
  return 'production-support'
}

function entity_id(entity: LuaEntity) {
  if (entity.unit_number !== undefined) return `entity-${entity.unit_number}`
  return `entity-${entity.name}-${entity.position.x}-${entity.position.y}`
}

function sort_entities(values: LuaEntity[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const a = `${values[i].unit_number ?? 0}:${values[i].name}:${values[i].position.x}:${values[i].position.y}`
      const b = `${values[j].unit_number ?? 0}:${values[j].name}:${values[j].position.x}:${values[j].position.y}`
      if (b < a) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
}

// Factorio methods are called with dot syntax on typed values: TypeScriptToLua
// turns a call on an untyped value into a colon call whose self argument the
// engine rejects, and get_recipe raises on anything but a crafting machine.
const CRAFTING_MACHINE_TYPES = ['assembling-machine', 'furnace', 'rocket-silo']

function recipe_summary(entity: LuaEntity) {
  if (!CRAFTING_MACHINE_TYPES.includes(entity.type) || typeof entity.get_recipe !== 'function') return undefined
  const [recipe] = entity.get_recipe()
  if (!recipe) return undefined
  const ingredients: Array<{ type: string, name: string, amount?: number }> = []
  for (const ingredient of recipe.ingredients ?? []) {
    if (typeof ingredient?.name === 'string') ingredients.push({ type: ingredient.type ?? 'item', name: ingredient.name, amount: ingredient.amount })
  }
  const products: Array<{ type: string, name: string, amount?: number }> = []
  for (const product of recipe.products ?? []) {
    if (typeof product?.name === 'string') products.push({ type: product.type ?? 'item', name: product.name, amount: product.amount })
  }
  return { name: recipe.name, ingredients, products }
}

function inventory_items(inventory: LuaInventory | undefined) {
  if (!inventory || inventory.valid === false || typeof inventory.get_contents !== 'function') return []
  const contents: any = inventory.get_contents()
  const result: Array<{ name: string, count: number }> = []
  for (const key in contents) {
    if (result.length >= MAX_INVENTORY_ITEMS) break
    const value = contents[key]
    if (typeof value === 'number' && value > 0) result.push({ name: key, count: value })
    else if (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.count === 'number' && value.count > 0) result.push({ name: value.name, count: value.count })
  }
  return result
}

function inventory_snapshots(entity: LuaEntity) {
  if (typeof entity.get_inventory !== 'function') return []
  const slots: Array<{ role: string, id: any }> = []
  const inventory_defines = (defines.inventory as any)
  function add(role: string, id: any) { if (id !== undefined) slots.push({ role, id }) }
  if (entity.type === 'assembling-machine' || entity.type === 'rocket-silo') {
    add('input', inventory_defines.crafter_input)
    add('output', inventory_defines.crafter_output)
  }
  else if (entity.type === 'furnace') {
    add('input', inventory_defines.furnace_source)
    add('output', inventory_defines.furnace_result)
  }
  else if (entity.type === 'container' || entity.type === 'logistic-container' || entity.type === 'infinity-container') add('storage', inventory_defines.chest)
  const result: FactoryInventorySnapshot[] = []
  for (const slot of slots) {
    const items = inventory_items(entity.get_inventory(slot.id))
    if (items.length > 0) result.push({ role: slot.role, items })
  }
  return result
}

function belt_connectable(entity: LuaEntity) {
  return entity.type === 'transport-belt' || entity.type === 'underground-belt' || entity.type === 'splitter'
    || entity.type === 'loader' || entity.type === 'loader-1x1' || entity.type === 'linked-belt'
}

function target_id(entity: LuaEntity | undefined) {
  return entity?.valid ? entity_id(entity) : undefined
}

function mining_resources(entity: LuaEntity) {
  if (entity.type !== 'mining-drill') return []
  const matches = entity.surface.find_entities_filtered({ area: entity.bounding_box, type: 'resource', limit: MAX_RESOURCE_MATCHES })
  const names: string[] = []
  for (const resource of matches) if (!names.includes(resource.name)) names.push(resource.name)
  names.sort()
  return names
}

function fluid_connections(entity: LuaEntity) {
  const result: FactoryEntityObservation['fluid_connections'] = []
  const fluidbox = entity.fluidbox
  if (fluidbox === undefined) return result
  for (let index = 1; index <= fluidbox.length && result.length < MAX_FLUID_CONNECTIONS; index++) {
    const connections = fluidbox.get_pipe_connections(index) ?? []
    for (const connection of connections) {
      if (result.length >= MAX_FLUID_CONNECTIONS) break
      result.push({ fluidbox_index: index, target: target_id(connection.target?.owner), flow_direction: connection.flow_direction, connection_type: connection.connection_type })
    }
  }
  return result
}

function observation(entity: LuaEntity): FactoryEntityObservation {
  const recipe = recipe_summary(entity)
  const belt = belt_connectable(entity)
    ? { inputs: (entity.belt_neighbours?.inputs ?? []).map(target => entity_id(target)), outputs: (entity.belt_neighbours?.outputs ?? []).map(target => entity_id(target)) }
    : undefined
  const inserter = entity.type === 'inserter'
    ? { pickup_position: entity.pickup_position, drop_position: entity.drop_position, pickup_target: target_id(entity.pickup_target), drop_target: target_id(entity.drop_target) }
    : undefined
  const resources = mining_resources(entity)
  const mining = entity.type === 'mining-drill'
    ? { resources, drop_position: entity.drop_position, drop_target: target_id(entity.drop_target) }
    : undefined
  const raw: any = entity
  const power = entity.type === 'electric-pole' || entity.type === 'assembling-machine' || entity.type === 'furnace' || entity.type === 'mining-drill'
    ? { status: raw.status, energy: typeof raw.energy === 'number' ? raw.energy : undefined, electric_network_id: typeof raw.electric_network_id === 'number' ? raw.electric_network_id : undefined }
    : undefined
  return {
    id: entity_id(entity), name: entity.name, type: entity.type, category: entity_category(entity), unit_number: entity.unit_number,
    position: { x: entity.position.x, y: entity.position.y }, direction: entity.direction as number, footprint: entity.bounding_box,
    recipe, inventories: inventory_snapshots(entity), belt, inserter, power, mining, fluid_connections: fluid_connections(entity),
  }
}

function find_observation(entities: FactoryEntityObservation[], id: string | undefined) {
  if (!id) return undefined
  for (const entity of entities) if (entity.id === id) return entity
  return undefined
}

function recipe_inputs(entity: FactoryEntityObservation | undefined) {
  return entity?.recipe?.ingredients.map(value => value.name) ?? []
}

function recipe_outputs(entity: FactoryEntityObservation | undefined) {
  if (entity?.recipe) return entity.recipe.products.map(value => value.name)
  if (entity?.mining) return entity.mining.resources.slice()
  return []
}

function material_intersection(from: FactoryEntityObservation | undefined, to: FactoryEntityObservation | undefined) {
  const outputs = recipe_outputs(from)
  const inputs = recipe_inputs(to)
  const result: string[] = []
  for (const output of outputs) for (const input of inputs) if (output === input && !result.includes(output)) result.push(output)
  result.sort()
  return result
}

function relation_key(relation: Pick<FactoryGraphRelation, 'kind' | 'from' | 'to' | 'via'>) {
  return `${relation.kind}:${relation.from ?? ''}:${relation.via ?? ''}:${relation.to ?? ''}`
}

function build_relations(live_entities: LuaEntity[], entities: FactoryEntityObservation[], area: FactoryAreaBounds) {
  const result: FactoryGraphRelation[] = []
  const seen: Record<string, boolean> = {}
  let truncated = false
  function add(kind: FactoryRelationKind, from: string | undefined, to: string | undefined, via: string | undefined, description: string, forced_items?: string[]) {
    const key = relation_key({ kind, from, to, via })
    if (seen[key]) return
    seen[key] = true
    if (result.length >= MAX_RELATIONS) { truncated = true; return }
    const items = forced_items ?? material_intersection(find_observation(entities, from), find_observation(entities, to))
    result.push({
      id: `relation-${result.length + 1}`, kind, from, to, via, item_names: items, confidence: 'engine_exact',
      item_confidence: items.length > 0 ? 'recipe_inferred' : kind === 'fluid_connection' ? 'not_applicable' : 'ambiguous',
      evidence_refs: [`engine:${kind}:${from ?? 'outside'}:${via ?? 'none'}:${to ?? 'outside'}`], description,
    })
  }

  for (const entity of live_entities) {
    const id = entity_id(entity)
    if (belt_connectable(entity)) {
      const neighbours = entity.belt_neighbours
      for (const input of neighbours.inputs) {
        const input_id = entity_id(input)
        if (point_in_area(input.position, area) && find_observation(entities, input_id)) add('belt_input', input_id, id, undefined, 'Engine belt-neighbour input relation.')
        else add('boundary_input', input_id, id, undefined, 'Belt enters the selected area from an external neighbour.')
      }
      for (const output of neighbours.outputs) {
        const output_id = entity_id(output)
        if (point_in_area(output.position, area) && find_observation(entities, output_id)) add('belt_output', id, output_id, undefined, 'Engine belt-neighbour output relation.')
        else add('boundary_output', id, output_id, undefined, 'Belt leaves the selected area toward an external neighbour.')
      }
    }
    if (entity.type === 'inserter') {
      const pickup = entity.pickup_target
      const drop = entity.drop_target
      const pickup_id = target_id(pickup)
      const drop_id = target_id(drop)
      const pickup_inside = pickup?.valid === true && point_in_area(pickup.position, area) && find_observation(entities, pickup_id) !== undefined
      const drop_inside = drop?.valid === true && point_in_area(drop.position, area) && find_observation(entities, drop_id) !== undefined
      if (pickup_inside && drop_inside) {
        const direct = find_observation(entities, pickup_id)?.category === 'machine' && find_observation(entities, drop_id)?.category === 'machine'
        add('item_transfer', pickup_id, drop_id, id, direct ? 'Engine-confirmed direct insertion between production machines.' : 'Engine-confirmed inserter item transfer.')
      }
      else if (!pickup_inside && drop_inside) add('boundary_input', pickup_id, drop_id, id, 'Inserter picks up outside the selected area and drops into the block.')
      else if (pickup_inside && !drop_inside) add('boundary_output', pickup_id, drop_id, id, 'Inserter picks up inside the selected area and drops outside it.')
    }
    if (entity.type === 'mining-drill' && entity.drop_target?.valid) {
      const drop_id = entity_id(entity.drop_target)
      if (point_in_area(entity.drop_target.position, area) && find_observation(entities, drop_id)) add('direct_item_output', id, drop_id, undefined, 'Mining drill engine drop target is inside the selected area.', mining_resources(entity))
      else add('boundary_output', id, drop_id, undefined, 'Mining drill engine drop target is outside the selected area.', mining_resources(entity))
    }
    const fluidbox = entity.fluidbox
    if (fluidbox !== undefined) {
      for (let index = 1; index <= fluidbox.length; index++) {
        for (const connection of fluidbox.get_pipe_connections(index) ?? []) {
          const target = connection.target?.owner as LuaEntity | undefined
          if (target?.valid && point_in_area(target.position, area) && find_observation(entities, entity_id(target))) add('fluid_connection', id, entity_id(target), undefined, 'Engine-confirmed fluidbox connection.')
        }
      }
    }
  }
  return { relations: result, truncated }
}

function relation_nodes(relation: FactoryGraphRelation) {
  const nodes: string[] = []
  if (relation.from) nodes.push(relation.from)
  if (relation.via) nodes.push(relation.via)
  if (relation.to) nodes.push(relation.to)
  return nodes
}

function contains(values: string[], wanted: string) {
  for (const value of values) if (value === wanted) return true
  return false
}

function unique_sorted(values: string[]) {
  const result: string[] = []
  for (const value of values) if (!contains(result, value)) result.push(value)
  result.sort()
  return result
}

function is_internal_relation(relation: FactoryGraphRelation) {
  return relation.kind !== 'boundary_input' && relation.kind !== 'boundary_output'
}

function build_blocks(entities: FactoryEntityObservation[], relations: FactoryGraphRelation[]) {
  const adjacency: Record<string, string[]> = {}
  for (const entity of entities) adjacency[entity.id] = []
  for (const relation of relations) {
    if (!is_internal_relation(relation)) continue
    const nodes = relation_nodes(relation).filter(id => find_observation(entities, id) !== undefined)
    for (const a of nodes) for (const b of nodes) if (a !== b && !contains(adjacency[a], b)) adjacency[a].push(b)
  }

  const visited: Record<string, boolean> = {}
  const blocks: FactoryProductionBlock[] = []
  let truncated = false
  for (const seed of entities) {
    if (visited[seed.id]) continue
    const queue = [seed.id]
    const component: string[] = []
    visited[seed.id] = true
    while (queue.length > 0) {
      const current = queue.shift()!
      component.push(current)
      for (const neighbour of adjacency[current] ?? []) if (!visited[neighbour]) { visited[neighbour] = true; queue.push(neighbour) }
    }
    const component_entities = component.map(id => find_observation(entities, id)!).filter(value => value !== undefined)
    const machines = component_entities.filter(entity => entity.category === 'machine' && (entity.recipe !== undefined || entity.mining !== undefined))
    if (machines.length === 0) continue
    if (blocks.length >= MAX_BLOCKS) { truncated = true; break }

    const relation_ids: string[] = []
    const boundary_inputs: string[] = []
    const boundary_outputs: string[] = []
    const ambiguities: string[] = []
    for (const relation of relations) {
      const touches = (relation.from !== undefined && contains(component, relation.from)) || (relation.to !== undefined && contains(component, relation.to)) || (relation.via !== undefined && contains(component, relation.via))
      if (!touches) continue
      if (is_internal_relation(relation)) {
        let all_inside = true
        for (const node of relation_nodes(relation)) if (find_observation(entities, node) !== undefined && !contains(component, node)) all_inside = false
        if (all_inside) relation_ids.push(relation.id)
      }
      else if (relation.kind === 'boundary_input') {
        relation_ids.push(relation.id)
        if (relation.item_names.length > 0) boundary_inputs.push(...relation.item_names)
        else ambiguities.push(`Boundary input ${relation.id} has proven direction but unknown item identity.`)
      }
      else {
        relation_ids.push(relation.id)
        if (relation.item_names.length > 0) boundary_outputs.push(...relation.item_names)
        else ambiguities.push(`Boundary output ${relation.id} has proven direction but unknown item identity.`)
      }
    }

    const produced: string[] = []
    const consumed: string[] = []
    const recipe_ids: string[] = []
    for (const machine of machines) {
      if (machine.recipe) {
        recipe_ids.push(machine.recipe.name)
        for (const ingredient of machine.recipe.ingredients) consumed.push(ingredient.name)
        for (const product of machine.recipe.products) produced.push(product.name)
      }
      if (machine.mining) for (const resource of machine.mining.resources) produced.push(resource)
    }
    const inputs: string[] = []
    const intermediates: string[] = []
    const outputs: string[] = []
    for (const item of unique_sorted(consumed)) {
      if (contains(produced, item)) intermediates.push(item)
      else inputs.push(item)
    }
    for (const item of unique_sorted(produced)) if (!contains(consumed, item)) outputs.push(item)
    for (const item of unique_sorted(boundary_inputs)) if (!contains(inputs, item) && !contains(intermediates, item)) inputs.push(item)
    for (const item of unique_sorted(boundary_outputs)) if (!contains(outputs, item) && !contains(intermediates, item)) outputs.push(item)
    inputs.sort(); intermediates.sort(); outputs.sort()
    const title_items = outputs.length > 0 ? outputs : recipe_ids
    blocks.push({
      id: `block-${blocks.length + 1}`,
      title: title_items.length > 0 ? `${title_items.join(' + ')} production` : `Observed production block ${blocks.length + 1}`,
      entity_ids: component, relation_ids: unique_sorted(relation_ids), recipe_ids: unique_sorted(recipe_ids), inputs: unique_sorted(inputs),
      intermediates: unique_sorted(intermediates), outputs: unique_sorted(outputs), machine_ids: machines.map(machine => machine.id),
      boundary_inputs: unique_sorted(boundary_inputs), boundary_outputs: unique_sorted(boundary_outputs), ambiguities: unique_sorted(ambiguities),
    })
  }
  return { blocks, truncated }
}

function store_analysis(analysis: FactoryAreaAnalysis) {
  const registry = ensure_analyses()
  const order = ensure_analysis_order()
  registry[analysis.id] = analysis
  order.push(analysis.id)
  while (order.length > MAX_ANALYSES) {
    const removed = order.shift()
    if (removed) delete registry[removed]
  }
}

export function get_factory_area_analysis(id: string) { return analyses()[id] }

export function latest_factory_area_analysis() {
  const order = analysis_order()
  return order.length > 0 ? analyses()[order[order.length - 1]] : undefined
}

function block_summary(analysis: FactoryAreaAnalysis, block: FactoryProductionBlock): FactoryBlockSummary {
  const machines: string[] = []
  for (const id of block.machine_ids) {
    const entity = find_observation(analysis.entities, id)
    if (entity) machines.push(entity.recipe ? `${entity.name}:${entity.recipe.name}` : entity.name)
  }
  return {
    analysis_id: analysis.id, block_id: block.id, title: block.title, inputs: block.inputs, intermediates: block.intermediates,
    outputs: block.outputs, recipes: block.recipe_ids, machines, relation_count: block.relation_ids.length, ambiguities: block.ambiguities,
  }
}

export function list_analyzed_blocks(analysis_id?: string) {
  const analysis = analysis_id ? get_factory_area_analysis(analysis_id) : latest_factory_area_analysis()
  return analysis ? analysis.blocks.map(block => block_summary(analysis, block)) : []
}

export function analyze_factory_area(actor: ControlledActor, request: FactoryAreaLearningRequest = {}) {
  if (!actor || !actor.is_valid) return { ok: false as const, error: 'controlled actor is unavailable' }
  const resolved = resolve_area(actor, request)
  if ('error' in resolved) return { ok: false as const, error: resolved.error }
  const spatial: any = local_spatial_observation(actor, { position: resolved.center, half_size: resolved.half_size })
  if (!spatial?.ok) return { ok: false as const, error: spatial?.error ?? 'local spatial observation failed' }
  const matches = actor.surface.find_entities_filtered({ area: resolved.area })
  const relevant: LuaEntity[] = []
  for (const entity of matches) {
    if (relevant.length >= MAX_ENTITIES) break
    if (entity.valid && relevant_entity(entity)) relevant.push(entity)
  }
  sort_entities(relevant)
  const entities = relevant.map(observation)
  const graph = build_relations(relevant, entities, resolved.area)
  const grouped = build_blocks(entities, graph.relations)
  const analysis: FactoryAreaAnalysis = {
    schema_version: 1, id: next_analysis_id(), tick: game.tick, surface_index: actor.surface.index, surface_name: actor.surface.name,
    area: resolved.area, spatial_source: 'local_spatial_observation',
    spatial: { center: spatial.center, bounds: spatial.bounds, blocking_terrain: spatial.blocking_terrain, entities_truncated: spatial.entities_truncated === true || matches.length > MAX_ENTITIES },
    entities, relations: graph.relations, blocks: grouped.blocks, entity_count: entities.length, relations_truncated: graph.truncated, blocks_truncated: grouped.truncated,
  }
  store_analysis(analysis)
  return {
    ok: true as const, analysis_id: analysis.id, tick: analysis.tick, surface_index: analysis.surface_index, area: analysis.area,
    spatial_source: analysis.spatial_source, entity_count: analysis.entity_count, relation_count: analysis.relations.length,
    blocks: analysis.blocks.map(block => block_summary(analysis, block)), entities_truncated: analysis.spatial.entities_truncated,
    relations_truncated: analysis.relations_truncated, blocks_truncated: analysis.blocks_truncated,
  }
}

function ascii_lower(value: string) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (const character of value.split('')) {
    const index = upper.indexOf(character)
    result += index >= 0 ? lower[index] : character
  }
  return result
}

function slug(value: string) {
  let result = ''
  let previous_dash = false
  for (const raw of ascii_lower(value).split('')) {
    const allowed = 'abcdefghijklmnopqrstuvwxyz0123456789'.includes(raw)
    if (allowed) { result += raw; previous_dash = false }
    else if (!previous_dash && result.length > 0) { result += '-'; previous_dash = true }
    if (result.length >= 60) break
  }
  while (result.endsWith('-')) result = result.slice(0, -1)
  return result || 'observed-factory-block'
}

function human_name(value: string) {
  const result: string[] = []
  for (const word of value.split('-')) result.push(word.length > 0 ? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}` : word)
  return result.join(' ')
}

function find_block(analysis: FactoryAreaAnalysis, block_id: string) {
  for (const block of analysis.blocks) if (block.id === block_id) return block
  return undefined
}

function abstract_topology(analysis: FactoryAreaAnalysis, block: FactoryProductionBlock) {
  const nodes: SkillDefinition['topology']['nodes'] = []
  const relations: SkillDefinition['topology']['relations'] = []
  const ids: Record<string, string> = {}
  const counts: Record<string, number> = {}
  for (const entity_id_value of block.entity_ids) {
    const entity = find_observation(analysis.entities, entity_id_value)
    if (!entity) continue
    const stem = entity.recipe ? `recipe-${slug(entity.recipe.name)}` : slug(entity.category)
    counts[stem] = (counts[stem] ?? 0) + 1
    const id = `${stem}-${counts[stem]}`
    ids[entity.id] = id
    const role = entity.recipe
      ? `Produce ${entity.recipe.products.map(product => product.name).join(', ') || entity.recipe.name}`
      : entity.category === 'inserter' ? 'Transfer items between connected entities'
        : entity.category === 'belt' || entity.category === 'loader' ? 'Transport items through the production block'
          : entity.category === 'storage' ? 'Buffer or collect items'
            : entity.category === 'machine' && entity.mining ? `Mine ${entity.mining.resources.join(', ') || 'resource'}` : `Observed ${entity.category}`
    nodes.push({ id, role, entity_name: entity.name, recipe: entity.recipe?.name })
  }
  for (const relation_id of block.relation_ids) {
    let relation: FactoryGraphRelation | undefined
    for (const candidate of analysis.relations) if (candidate.id === relation_id) relation = candidate
    if (!relation || relation.kind === 'boundary_input' || relation.kind === 'boundary_output') continue
    relations.push({
      kind: relation.kind,
      from: relation.from ? ids[relation.from] : undefined,
      to: relation.to ? ids[relation.to] : undefined,
      via: relation.via ? ids[relation.via] : undefined,
      description: `${relation.description}${relation.item_names.length > 0 ? ` Material relationship: ${relation.item_names.join(', ')}.` : ''}`,
    })
  }
  return { nodes, relations }
}

export function skill_candidate_definition_from_block(analysis_id: string, block_id: string, revision: number = 1): SkillDefinition {
  const analysis = get_factory_area_analysis(analysis_id)
  if (!analysis) throw new Error(`unknown factory analysis: ${analysis_id}`)
  const block = find_block(analysis, block_id)
  if (!block) throw new Error(`unknown factory block: ${block_id}`)
  if (revision < 1 || math.floor(revision) !== revision) throw new Error('revision must be a positive integer')
  const primary = block.outputs[0] ?? block.recipe_ids[block.recipe_ids.length - 1] ?? `${analysis.id}-${block.id}`
  const topology = abstract_topology(analysis, block)
  const evidence_refs: string[] = [`factory-analysis:${analysis.id}`, `factory-block:${analysis.id}:${block.id}`]
  for (const relation_id of block.relation_ids) for (const relation of analysis.relations) if (relation.id === relation_id) evidence_refs.push(...relation.evidence_refs)
  const unit_numbers: number[] = []
  for (const entity_id_value of block.entity_ids) {
    const entity = find_observation(analysis.entities, entity_id_value)
    if (entity?.unit_number !== undefined) unit_numbers.push(entity.unit_number)
  }
  const ambiguity_failure = block.ambiguities.length > 0
    ? ['Some selected-area boundary transport has proven direction but ambiguous item identity; re-observe before assuming those boundary items elsewhere.']
    : []
  return {
    schema_version: 1, revision, id: `${slug(primary)}-production`, name: `${human_name(primary)} Production`, kind: 'production',
    stage: 'executable_candidate', status: 'candidate',
    summary: `Candidate production relationship reverse-engineered deterministically from an observed factory block with ${block.recipe_ids.length} recipe(s).`,
    source: {
      kind: 'observed_factory', observed_tick: analysis.tick,
      area: { surface_index: analysis.surface_index, left_top: analysis.area.left_top, right_bottom: analysis.area.right_bottom },
      entity_unit_numbers: unit_numbers.slice(0, 64), recipe_ids: block.recipe_ids, evidence_refs: unique_sorted(evidence_refs).slice(0, 64),
    },
    preconditions: block.inputs.map(item => ({ kind: 'item_available' as const, subject: item, description: `${item} must be available as an external input to the observed production relationship.` })),
    inputs: block.inputs.map(item => ({ item, role: 'external input inferred from observed recipe scope' })),
    outputs: block.outputs.map(item => ({ item, role: 'finished output inferred from observed recipe scope' })),
    topology,
    constraints: [
      { kind: 'placement', description: 'Absolute observed coordinates are provenance only; this V1 candidate has not been rebuilt at a new location.', validation: 'unvalidated', evidence_refs: [`factory-analysis:${analysis.id}`] },
      { kind: 'capacity', description: 'Inserter sustained throughput was not measured by Factory Area Learning V1.', validation: 'unvalidated', evidence_refs: [] },
    ],
    parameters: [
      { name: 'input_routing', description: 'Provide the required external inputs while preserving the learned material-flow relationships.', required: true },
      { name: 'output_routing', description: 'Route the learned output away from the final producer or output transport.', required: false },
    ],
    verification: {
      structural: 'passed', recipe_flow: block.recipe_ids.length > 0 ? 'passed' : 'not_tested', placement_rebuild: 'not_tested',
      production_output: 'not_tested', belt_capacity: 'not_tested', inserter_sustained_throughput: 'unvalidated', acceptance_conditions: [],
    },
    known_failure_modes: [
      'Observed connectivity does not prove spare throughput or sustained rate under a different layout.',
      'Observed power coverage and surrounding infrastructure may differ when this candidate is reused.',
      ...ambiguity_failure,
    ],
    confidence: {
      level: block.recipe_ids.length > 0 && block.relation_ids.length > 0 ? 'medium' : 'low',
      basis: [
        'Entity recipes were read from the Factorio engine.',
        'Production-block membership uses engine-confirmed logistics/direct-transfer connectivity rather than proximity.',
        'Input/intermediate/output roles are derived from the recipes inside the connected block.',
      ],
    },
    examples: [{
      summary: `Observed ${block.title} on surface ${analysis.surface_name}. Intermediates: ${block.intermediates.join(', ') || 'none'}.`,
      notes: 'World coordinates and unit numbers are retained only as provenance; reusable topology uses abstract role nodes and relationships.',
    }],
  }
}
