import type { LuaEntity } from 'factorio:runtime'
import { find_world_entities } from './npc_vision'
import { electric_prototype_facts, protected_read } from './electric_facts'
import { rotate_cardinal, vector_xy } from './placement_geometry'
import type { SeenArea } from './visible_reads'
import { area_around, pipe_link_area, point_area, seen_link } from './visible_reads'

const MAX_FLUID_STORAGES = 8
const MAX_PIPE_CONNECTIONS_PER_STORAGE = 8
const MAX_MINING_RESOURCE_TYPES = 8

function entity_identity(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: entity.position,
  }
}

// A linked neighbour in a chunk the NPC does not see now: unknown, not absent.
const NOT_VISIBLE_TARGET = { not_visible: true }

function linked_identity(seen: SeenArea | undefined, position: { x: number, y: number } | undefined, read: () => LuaEntity | undefined) {
  const link = seen_link(seen, position ? point_area(position) : undefined, read)
  return link.seen ? entity_identity(link.entity) : NOT_VISIBLE_TARGET
}

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

function compact_fluidbox_prototype(value: any) {
  if (!value) return []
  const values: any[] = value.production_type ? [value] : value
  const result: Array<Record<string, unknown>> = []
  for (const prototype of values) {
    const summary: Record<string, unknown> = {
      index: prototype.index,
      production_type: prototype.production_type,
    }
    if (prototype.filter?.name !== undefined) summary.filter = prototype.filter.name
    if (prototype.minimum_temperature !== undefined) summary.minimum_temperature = prototype.minimum_temperature
    if (prototype.maximum_temperature !== undefined) summary.maximum_temperature = prototype.maximum_temperature
    result.push(summary)
  }
  return result
}

function compact_fluid_ports(entity: LuaEntity, seen?: SeenArea) {
  const fluidbox = entity.fluidbox
  const count = math.min(fluidbox.length, MAX_FLUID_STORAGES)
  if (count <= 0) return undefined

  const storages: Array<Record<string, unknown>> = []
  for (let index = 1; index <= count; index++) {
    const raw_connections = fluidbox.get_pipe_connections(index) ?? []
    const connection_count = math.min(raw_connections.length, MAX_PIPE_CONNECTIONS_PER_STORAGE)
    const connections: Array<Record<string, unknown>> = []

    for (let connection_index = 0; connection_index < connection_count; connection_index++) {
      const connection = raw_connections[connection_index]
      const summary: Record<string, unknown> = {
        // 1-based within this storage; getPlacementCandidates connects_to takes it as connection_index.
        connection_index: connection_index + 1,
        position: connection.position,
      }
      if (connection.flow_direction !== undefined) summary.flow_direction = connection.flow_direction
      if (connection.connection_type !== undefined) summary.connection_type = connection.connection_type
      if (connection.target_position !== undefined) summary.target_position = connection.target_position
      const link = seen_link(seen, seen ? pipe_link_area(entity, connection, index) : undefined, () => connection.target?.owner)
      if (!link.seen) {
        summary.target_not_visible = true
        connections.push(summary)
        continue
      }
      const target = entity_identity(link.entity)
      if (target !== undefined) summary.target = target
      if (target !== undefined && connection.target_fluidbox_index !== undefined) {
        const reverse = protected_read(() => connection.target!.owner.fluidbox.get_pipe_connections(connection.target_fluidbox_index!))
        if (reverse !== undefined) summary.reciprocal = reverse.some(other => other.target?.owner === entity && other.target_fluidbox_index === index)
      }
      if (connection.target_fluidbox_index !== undefined) summary.target_fluidbox_index = connection.target_fluidbox_index
      connections.push(summary)
    }

    const current = protected_read(() => entity.get_fluid(index))
    storages.push({
      index,
      capacity: protected_read(() => fluidbox.get_capacity(index)),
      contents: current ? { name: current.name, amount: current.amount, temperature: current.temperature } : undefined,
      prototypes: compact_fluidbox_prototype(fluidbox.get_prototype(index)),
      connections,
      connections_truncated: raw_connections.length > connection_count,
    })
  }

  return {
    storage_count: entity.fluids_count,
    fluidbox_count: fluidbox.length,
    storages_truncated: fluidbox.length > count,
    storages,
  }
}

function compact_item_io(entity: LuaEntity, seen?: SeenArea) {
  if (entity.type === 'inserter') {
    return {
      pickup_position: entity.pickup_position,
      drop_position: entity.drop_position,
      pickup_target: linked_identity(seen, entity.pickup_position, () => entity.pickup_target),
      drop_target: linked_identity(seen, entity.drop_position, () => entity.drop_target),
    }
  }

  if (entity.type === 'mining-drill') {
    return {
      drop_position: entity.drop_position,
      drop_target: linked_identity(seen, entity.drop_position, () => entity.drop_target),
    }
  }

  return undefined
}

function mining_radius(prototype: any) {
  // Read the field, not get_mining_drill_radius(): on an untyped object the
  // call compiles to a Lua method call that passes the prototype as the
  // quality argument ("Invalid QualityID" on 2.0.77).
  const radius = prototype?.mining_drill_radius
  return typeof radius === 'number' && radius > 0 && finite(radius) ? radius : undefined
}

function mining_offset(prototype: any, direction: number) {
  const offset = vector_xy(prototype?.radius_visualisation_specification?.offset)
  if (!offset) return { x: 0, y: 0 }
  return rotate_cardinal(offset, direction)
}

function mining_categories(prototype: any) {
  const result: Record<string, boolean> = {}
  const categories: Record<string, boolean> = prototype?.resource_categories ?? {}
  for (const name in categories) if (categories[name] === true) result[name] = true
  return result
}

function compact_mining_coverage(entity: LuaEntity, seen?: SeenArea) {
  if (entity.type !== 'mining-drill') return undefined
  const prototype: any = entity.prototype
  const radius = mining_radius(prototype)
  if (radius === undefined) return undefined
  const offset = mining_offset(prototype, entity.direction)
  const center = { x: entity.position.x + offset.x, y: entity.position.y + offset.y }
  const area = area_around(center, radius)
  // The mining area must be seen now before it is scanned; otherwise its resources are unknown.
  if (seen !== undefined && !seen(area)) return { radius, search_center: center, not_visible: true }
  const categories = mining_categories(prototype)
  const resources = find_world_entities(entity.surface, {
    area: [area.left_top, area.right_bottom],
    type: 'resource',
  })

  const by_name: Record<string, { name: string, entities: number, amount: number }> = {}
  for (const resource of resources) {
    if (!resource.valid || resource.type !== 'resource') continue
    const category = (resource.prototype as any).resource_category
    if (category !== undefined && categories[category] !== true) continue
    const amount = typeof resource.amount === 'number' ? resource.amount : 0
    const existing = by_name[resource.name]
    if (existing !== undefined) {
      existing.entities += 1
      existing.amount += amount
    }
    else {
      by_name[resource.name] = { name: resource.name, entities: 1, amount }
    }
  }

  const coverage: Array<{ name: string, entities: number, amount: number }> = []
  for (const name in by_name) coverage.push(by_name[name])
  coverage.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const truncated = coverage.length > MAX_MINING_RESOURCE_TYPES
  if (truncated) coverage.splice(MAX_MINING_RESOURCE_TYPES)
  return {
    radius,
    search_center: center,
    resource_coverage: coverage,
    resource_types_truncated: truncated,
  }
}

/**
 * Return only spatial semantics that the running Factorio instance actually
 * exposes for this placed entity. Keep the result compact so nearby scans can
 * include useful geometry without forcing a second LLM observation round.
 *
 * This intentionally does not encode vanilla prototype names or remembered
 * orientation rules. Geometry is read from the current LuaEntity/LuaFluidBox
 * and mining coverage is calculated from the live surface/prototype.
 *
 * With `seen` (a model-facing read, M3), linked neighbours and the mining area are read only where the NPC sees now;
 * the rest is marked not visible rather than absent.
 */
export function compact_spatial_summary(entity: LuaEntity, seen?: SeenArea) {
  const item_io = compact_item_io(entity, seen)
  const fluid = compact_fluid_ports(entity, seen)
  const mining = compact_mining_coverage(entity, seen)
  const prototype = electric_prototype_facts(entity.prototype)
  const has_power = prototype.power !== undefined || prototype.thermal !== undefined || prototype.electric_pole !== undefined
  if (item_io === undefined && fluid === undefined && mining === undefined && !has_power) return undefined

  const result: Record<string, unknown> = {}
  if (item_io !== undefined) result.item_io = item_io
  if (fluid !== undefined) result.fluid = fluid
  if (mining !== undefined) result.mining = mining
  if (has_power) result.power = {
    prototype,
    stored_energy_joules: protected_read(() => entity.energy),
    electric_network_id: protected_read(() => entity.electric_network_id),
  }
  return result
}
