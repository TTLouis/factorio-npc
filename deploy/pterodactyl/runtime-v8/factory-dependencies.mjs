// Stage 1 declarations only: these edges never prove connectivity, capacity,
// native fuel suitability, delivery, or supply. Evidence references are labels,
// not verification authority. This module never edits cells or assigned jobs.
const LIMIT = Object.freeze({ cells: 4096, ports: 128, products: 64, dependencies: 4096, evidence: 32 })
const PORT_KINDS = new Set(['item', 'fuel', 'fluid', 'power'])
const DELIVERY_KINDS = new Set(['direct', 'belt', 'inserter', 'fluid', 'electric', 'manual', 'unknown'])

function invalid(message) { throw new TypeError(`Invalid factory dependency: ${message}`) }
function record(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain record`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || (allowed && !allowed.includes(key))) invalid(`${label} has an unsupported field`)
  }
  return value
}
function list(value, label, max) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be a bounded array`)
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(`${label} must be dense without extra fields`)
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`${label} must contain data elements`)
  }
  return value
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)) invalid(`${label} must be a bounded nonempty string`)
  return value
}
function id(value, prefix) {
  text(value, `${prefix} ID`, 40)
  if (!new RegExp(`^${prefix}-[1-9][0-9]*$`).test(value)
    || !Number.isSafeInteger(Number(value.slice(prefix.length + 1)))) invalid(`${prefix} ID is malformed`)
  return value
}
function scope(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`)
  return value
}
function uniqueStrings(value, label, max, width) {
  const values = list(value, label, max).map(item => text(item, label, width))
  if (new Set(values).size !== values.length) invalid(`${label} has duplicates`)
  return values
}

// Validate the portion of cells used by dependency relationships independently
// of the registry reducer. Core owns member/origin/observation validation.
function cellIndex(cells) {
  const index = new Map()
  for (const raw of list(cells, 'cells', LIMIT.cells)) {
    record(raw, 'cell')
    const cellId = id(raw.cell_id, 'cell')
    if (index.has(cellId)) invalid('duplicate cell ID')
    scope(raw.surface_index, 'surface_index'); scope(raw.force_index, 'force_index')
    record(raw.assignment, 'assignment')
    const products = uniqueStrings(raw.assignment.products, 'products', LIMIT.products, 200)
    const ports = new Map()
    for (const port of list(raw.ports, 'ports', LIMIT.ports)) {
      record(port, 'port', ['port_id', 'direction', 'kind', 'resource'])
      const portId = text(port.port_id, 'port_id', 128)
      if (ports.has(portId)) invalid('duplicate port ID')
      if (!['input', 'output'].includes(port.direction) || !PORT_KINDS.has(port.kind)) invalid('invalid port type')
      if (port.kind === 'power') {
        if (Object.hasOwn(port, 'resource')) invalid('power is a service and cannot declare a commodity')
      }
      else {
        text(port.resource, 'port resource')
        if (port.direction === 'output' && !products.includes(port.resource)) invalid('supplier output is outside its assigned products')
      }
      ports.set(portId, port)
    }
    index.set(cellId, { raw, ports })
  }
  return index
}

function endpoint(raw, label) {
  record(raw, label, ['cell_id', 'port_id'])
  return { cell_id: id(raw.cell_id, 'cell'), port_id: text(raw.port_id, `${label} port_id`, 128) }
}
function shape(raw) {
  record(raw, 'declaration', ['dependency_id', 'consumer', 'supplier', 'delivery', 'state', 'evidence_refs'])
  const dependencyId = id(raw.dependency_id, 'dependency')
  const consumer = endpoint(raw.consumer, 'consumer')
  record(raw.supplier, 'supplier', ['kind', 'cell_id', 'port_id', 'reference'])
  let supplier
  if (raw.supplier.kind === 'cell') {
    record(raw.supplier, 'cell supplier', ['kind', 'cell_id', 'port_id'])
    supplier = { kind: 'cell', ...endpoint({ cell_id: raw.supplier.cell_id, port_id: raw.supplier.port_id }, 'supplier') }
  }
  else if (['external', 'manual'].includes(raw.supplier.kind)) {
    record(raw.supplier, 'boundary supplier', ['kind', 'reference'])
    supplier = { kind: raw.supplier.kind, reference: text(raw.supplier.reference, 'supplier reference', 1024) }
  }
  else if (raw.supplier.kind === 'unresolved') {
    record(raw.supplier, 'unresolved supplier', ['kind'])
    supplier = { kind: 'unresolved' }
  }
  else invalid('unknown supplier kind')
  record(raw.delivery, 'delivery', ['kind', 'reference'])
  if (!DELIVERY_KINDS.has(raw.delivery.kind)) invalid('unknown delivery kind')
  const delivery = { kind: raw.delivery.kind }
  if (Object.hasOwn(raw.delivery, 'reference')) delivery.reference = text(raw.delivery.reference, 'delivery reference', 1024)
  if (Object.hasOwn(raw, 'state') && raw.state !== 'unverified') invalid('only unverified declarations are allowed')
  const result = { dependency_id: dependencyId, consumer, supplier, delivery, state: 'unverified' }
  if (Object.hasOwn(raw, 'evidence_refs')) result.evidence_refs = uniqueStrings(raw.evidence_refs, 'evidence_refs', LIMIT.evidence, 512)
  return result
}
function resolve(index, value, direction) {
  const cell = index.get(value.cell_id)
  if (!cell) invalid(`${direction} cell does not exist`)
  const port = cell.ports.get(value.port_id)
  if (!port || port.direction !== direction) invalid(`${direction} port does not exist or has wrong direction`)
  return { cell: cell.raw, port }
}
function relate(dependency, index) {
  const consumer = resolve(index, dependency.consumer, 'input')
  const kind = consumer.port.kind
  const delivery = dependency.delivery.kind
  if ((delivery === 'electric' && kind !== 'power') || (delivery === 'fluid' && kind !== 'fluid')
    || (['belt', 'inserter'].includes(delivery) && !['item', 'fuel'].includes(kind))
    || (delivery === 'manual' && kind === 'power')) invalid('delivery kind is incompatible with the consumer port')
  if (dependency.supplier.kind === 'cell') {
    const supplier = resolve(index, dependency.supplier, 'output')
    if (supplier.cell.surface_index !== consumer.cell.surface_index || supplier.cell.force_index !== consumer.cell.force_index)
      invalid('cell supplier must share consumer surface and force; use an explicit external boundary otherwise')
    const compatible = supplier.port.kind === kind || (supplier.port.kind === 'item' && kind === 'fuel')
    if (!compatible || supplier.port.resource !== consumer.port.resource) invalid('supplier and consumer resource types differ')
  }
  return dependency
}

/** Normalize one declaration; allocate its stable ID in the registry reducer. */
export function normalizeFactoryDependency(raw, cells) {
  return relate(shape(raw), cellIndex(cells))
}

function declarations(raw) {
  const result = list(raw, 'dependencies', LIMIT.dependencies).map(shape)
  const ids = new Set(); const edges = new Set()
  for (const dependency of result) {
    if (ids.has(dependency.dependency_id)) invalid('duplicate dependency ID')
    ids.add(dependency.dependency_id)
    const key = JSON.stringify([dependency.consumer, dependency.supplier])
    if (edges.has(key)) invalid('duplicate consumer and supplier edge')
    edges.add(key)
  }
  return result
}

/** Restore validates every relationship atomically; cycles remain legitimate. */
export function validateFactoryDependencies(raw, cells) {
  const index = cellIndex(cells)
  return declarations(raw).map(dependency => relate(dependency, index))
}

function consumers(dependencies, cellId) {
  const reverse = new Map()
  for (const dependency of dependencies) {
    if (dependency.supplier.kind !== 'cell') continue
    const edges = reverse.get(dependency.supplier.cell_id) || []
    edges.push(dependency)
    reverse.set(dependency.supplier.cell_id, edges)
  }
  const direct = reverse.get(cellId) || []
  const visited = new Set([cellId]); const queue = [cellId]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const edge of reverse.get(queue[cursor]) || []) {
      const consumerId = edge.consumer.cell_id
      if (!visited.has(consumerId)) { visited.add(consumerId); queue.push(consumerId) }
    }
  }
  return {
    cell_id: cellId,
    basis: 'declared_dependencies',
    state: 'unverified',
    direct_consumer_ids: [...new Set(direct.map(edge => edge.consumer.cell_id))].filter(value => value !== cellId).sort(),
    // Includes direct consumers and all reachable downstream consumers, but
    // excludes the queried cell even when a cycle returns to it.
    transitive_consumer_ids: queue.slice(1).sort(),
    dependencies: direct,
  }
}

/** Structural-only reverse query; use summary to also validate live registry references. */
export function factoryConsumers(deps, cellId) {
  return consumers(declarations(deps), id(cellId, 'cell'))
}

/** A defensive projection of declarations, never an observed connectivity claim. */
export function factoryDependencySummary(cells, deps, cellId) {
  const index = cellIndex(cells)
  id(cellId, 'cell')
  if (!index.has(cellId)) invalid('summary cell does not exist')
  const dependencies = declarations(deps).map(dependency => relate(dependency, index))
  const inbound = dependencies.filter(dependency => dependency.consumer.cell_id === cellId)
  const outbound = dependencies.filter(dependency => dependency.supplier.kind === 'cell' && dependency.supplier.cell_id === cellId)
  return { cell_id: cellId, basis: 'declared_dependencies', state: 'unverified', inbound, outbound, impact: consumers(dependencies, cellId) }
}
