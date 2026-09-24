import type { LuaEntity } from 'factorio:runtime'

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

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

function rotate_cardinal(vector: { x: number, y: number }, direction: number) {
  if (direction === 4) return { x: -vector.y, y: vector.x }
  if (direction === 8) return { x: -vector.x, y: -vector.y }
  if (direction === 12) return { x: vector.y, y: -vector.x }
  return { x: vector.x, y: vector.y }
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

function compact_fluid_ports(entity: LuaEntity) {
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
        position: connection.position,
      }
      if (connection.flow_direction !== undefined) summary.flow_direction = connection.flow_direction
      if (connection.connection_type !== undefined) summary.connection_type = connection.connection_type
      if (connection.target_position !== undefined) summary.target_position = connection.target_position
      const target = entity_identity(connection.target?.owner)
      if (target !== undefined) summary.target = target
      if (connection.target_fluidbox_index !== undefined) summary.target_fluidbox_index = connection.target_fluidbox_index
      connections.push(summary)
    }

    storages.push({
      index,
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

function compact_item_io(entity: LuaEntity) {
  if (entity.type === 'inserter') {
    return {
      pickup_position: entity.pickup_position,
      drop_position: entity.drop_position,
      pickup_target: entity_identity(entity.pickup_target),
      drop_target: entity_identity(entity.drop_target),
    }
  }

  if (entity.type === 'mining-drill') {
    return {
      drop_position: entity.drop_position,
      drop_target: entity_identity(entity.drop_target),
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
  const raw = prototype?.radius_visualisation_specification?.offset
  if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return { x: 0, y: 0 }
  if (!finite(raw.x) || !finite(raw.y)) return { x: 0, y: 0 }
  return rotate_cardinal({ x: raw.x, y: raw.y }, direction)
}

function mining_categories(prototype: any) {
  const result: Record<string, boolean> = {}
  const categories: Record<string, boolean> = prototype?.resource_categories ?? {}
  for (const name in categories) if (categories[name] === true) result[name] = true
  return result
}

function compact_mining_coverage(entity: LuaEntity) {
  if (entity.type !== 'mining-drill') return undefined
  const prototype: any = entity.prototype
  const radius = mining_radius(prototype)
  if (radius === undefined) return undefined
  const offset = mining_offset(prototype, entity.direction)
  const center = { x: entity.position.x + offset.x, y: entity.position.y + offset.y }
  const categories = mining_categories(prototype)
  const resources = entity.surface.find_entities_filtered({
    area: [
      { x: center.x - radius, y: center.y - radius },
      { x: center.x + radius, y: center.y + radius },
    ],
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
 */
export function compact_spatial_summary(entity: LuaEntity) {
  const item_io = compact_item_io(entity)
  const fluid = compact_fluid_ports(entity)
  const mining = compact_mining_coverage(entity)
  if (item_io === undefined && fluid === undefined && mining === undefined) return undefined

  const result: Record<string, unknown> = {}
  if (item_io !== undefined) result.item_io = item_io
  if (fluid !== undefined) result.fluid = fluid
  if (mining !== undefined) result.mining = mining
  return result
}
