import { normalizeFactoryDependency, validateFactoryDependencies } from './factory-dependencies.mjs'

// Declarations are durable assignments, never commissioning or live-world proof.
// No removal/reassignment reducer exists in stage 1. Future lifecycle changes must
// preserve identity counters and explicitly revision the affected cell design.
export const FACTORY_REGISTRY_LIMITS = Object.freeze({ cells: 256, members: 256, ports: 128, products: 64, dependencies: 4096, evidence_refs: 32 })

export class FactoryRegistryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FactoryRegistryError'
    this.code = code
  }
}

function fail(code, message) { throw new FactoryRegistryError(code, message) }

function record(raw, keys, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('invalid_schema', `${label} must be an object`)
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid_schema', `${label} has unsupported fields`)
  }
  return raw
}

function string(raw, label, max = 200) {
  if (typeof raw !== 'string' || !raw || raw.trim() !== raw || raw.length > max || /[\u0000-\u001F\u007F]/u.test(raw)) fail('invalid_schema', `${label} must be a bounded nonempty string`)
  return raw
}

function integer(raw, label, minimum = 0) {
  if (!Number.isSafeInteger(raw) || raw < minimum) fail('invalid_schema', `${label} must be a safe integer >= ${minimum}`)
  return raw
}

function array(raw, label, limit, minimum = 0) {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > limit) fail('invalid_schema', `${label} length must be ${minimum}..${limit}`)
  if (Reflect.ownKeys(raw).length !== raw.length + 1) fail('invalid_schema', `${label} must be dense without extra fields`)
  for (let i = 0; i < raw.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_schema', `${label} must contain data elements`)
  }
  return raw
}

function strings(raw, label, limit, minimum = 0, max = 200) {
  const result = array(raw, label, limit, minimum).map(value => string(value, label, max))
  if (new Set(result).size !== result.length) fail('duplicate_value', `${label} contains duplicates`)
  return result
}

function generatedId(raw, prefix) {
  if (typeof raw !== 'string' || !new RegExp(`^${prefix}-[1-9][0-9]*$`, 'u').test(raw)) fail('invalid_id', `Invalid ${prefix} ID`)
  const ordinal = Number(raw.slice(prefix.length + 1))
  if (!Number.isSafeInteger(ordinal)) fail('invalid_id', `${prefix} ID overflow`)
  return ordinal
}

const HISTORY_TEXT = ['source', 'receipt_id', 'goal_id', 'plan_id', 'semantic_step_id', 'request_id']
const HISTORY_NUMBERS = ['plan_version', 'actor_id', 'actor_epoch', 'tick']

function history(raw, label) {
  record(raw, [...HISTORY_TEXT, ...HISTORY_NUMBERS], label)
  const result = { source: string(raw.source, `${label}.source`, 128) }
  for (const key of HISTORY_TEXT.slice(1)) if (Object.hasOwn(raw, key)) result[key] = string(raw[key], `${label}.${key}`, 512)
  for (const key of HISTORY_NUMBERS) if (Object.hasOwn(raw, key)) result[key] = integer(raw[key], `${label}.${key}`, key === 'actor_id' ? 1 : 0)
  return result
}

function position(raw) {
  record(raw, ['x', 'y'], 'position')
  if (![raw.x, raw.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)) fail('invalid_schema', 'position must contain finite coordinates')
  return { x: raw.x, y: raw.y }
}

function member(raw, surface, force) {
  record(raw, ['unit_number', 'name', 'position', 'surface_index', 'force_index', 'provenance'], 'member')
  const result = {
    unit_number: integer(raw.unit_number, 'member.unit_number', 1),
    name: string(raw.name, 'member.name'),
    position: position(raw.position),
    surface_index: integer(raw.surface_index, 'member.surface_index', 1),
    force_index: integer(raw.force_index, 'member.force_index', 1),
    provenance: history(raw.provenance, 'member.provenance'),
  }
  if (result.surface_index !== surface || result.force_index !== force) fail('scope_mismatch', 'Member scope must equal its cell scope')
  return result
}

function port(raw, products) {
  record(raw, ['port_id', 'direction', 'kind', 'resource'], 'port')
  const result = { port_id: string(raw.port_id, 'port.port_id', 128), direction: raw.direction, kind: raw.kind }
  if (!['input', 'output'].includes(result.direction) || !['item', 'fuel', 'fluid', 'power'].includes(result.kind)) fail('invalid_schema', 'Invalid port direction or kind')
  if (result.kind === 'power') {
    if (Object.hasOwn(raw, 'resource')) fail('invalid_schema', 'Power ports do not have a material resource')
  }
  else {
    result.resource = string(raw.resource, 'port.resource')
    if (result.direction === 'output' && !products.includes(result.resource)) fail('assignment_mismatch', 'Output resource must belong to the immutable product assignment')
  }
  return result
}

function observation(raw) {
  record(raw, ['products', 'source', 'evidence_refs', 'tick', 'observed_at', 'state'], 'observation')
  if (Object.hasOwn(raw, 'state') && raw.state !== 'unverified') fail('invalid_schema', 'Observations cannot establish verification')
  const result = { products: strings(raw.products, 'observation.products', FACTORY_REGISTRY_LIMITS.products), source: string(raw.source, 'observation.source', 128), state: 'unverified' }
  if (Object.hasOwn(raw, 'evidence_refs')) result.evidence_refs = strings(raw.evidence_refs, 'observation.evidence_refs', FACTORY_REGISTRY_LIMITS.evidence_refs, 0, 512)
  if (Object.hasOwn(raw, 'tick')) result.tick = integer(raw.tick, 'observation.tick')
  if (Object.hasOwn(raw, 'observed_at')) result.observed_at = string(raw.observed_at, 'observation.observed_at', 128)
  return result
}

function enrollment(raw) {
  record(raw, ['goal_id', 'semantic_step_id', 'intent_signature', 'receipt_ids'], 'enrollment')
  const result = { goal_id: string(raw.goal_id, 'enrollment.goal_id', 512), semantic_step_id: string(raw.semantic_step_id, 'enrollment.semantic_step_id', 512),
    intent_signature: string(raw.intent_signature, 'enrollment.intent_signature', 64), receipt_ids: strings(raw.receipt_ids, 'enrollment.receipt_ids', 2, 2, 512) }
  if (!/^[a-f0-9]{64}$/.test(result.intent_signature)) fail('invalid_schema', 'Invalid intent signature')
  return result
}

function cell(raw) {
  record(raw, ['cell_id', 'revision', 'state', 'surface_index', 'force_index', 'assignment', 'members', 'ports', 'origin', 'observation', 'enrollment'], 'cell')
  generatedId(raw.cell_id, 'cell')
  if (raw.revision !== 1 || raw.state !== 'unverified') fail('invalid_schema', 'Stage 1 cells have revision 1 and unverified state')
  const surface = integer(raw.surface_index, 'cell.surface_index', 1)
  const force = integer(raw.force_index, 'cell.force_index', 1)
  record(raw.assignment, ['products', 'purpose', 'method'], 'assignment')
  const assignment = {
    products: strings(raw.assignment.products, 'assignment.products', FACTORY_REGISTRY_LIMITS.products),
    purpose: string(raw.assignment.purpose, 'assignment.purpose', 2000),
    method: string(raw.assignment.method, 'assignment.method', 2000),
  }
  const ports = array(raw.ports, 'ports', FACTORY_REGISTRY_LIMITS.ports).map(value => port(value, assignment.products))
  if (new Set(ports.map(value => value.port_id)).size !== ports.length) fail('duplicate_port', 'Port IDs must be unique within a cell')
  if (!assignment.products.length && !ports.some(value => value.direction === 'output' && value.kind === 'power')) fail('assignment_mismatch', 'A cell must have assigned material products or an explicit power output')
  return {
    cell_id: raw.cell_id, revision: 1, state: 'unverified', surface_index: surface, force_index: force, assignment,
    members: array(raw.members, 'members', FACTORY_REGISTRY_LIMITS.members, 1).map(value => member(value, surface, force)),
    ports, origin: history(raw.origin, 'origin'),
    ...(Object.hasOwn(raw, 'enrollment') ? { enrollment: enrollment(raw.enrollment) } : {}),
    ...(Object.hasOwn(raw, 'observation') ? { observation: observation(raw.observation) } : {}),
  }
}

function dependencies(raw, cells) {
  array(raw, 'dependencies', FACTORY_REGISTRY_LIMITS.dependencies)
  try { return validateFactoryDependencies(raw, cells) }
  catch (error) { fail('invalid_dependency', error.message) }
}

/** Missing legacy state is empty only when the caller supplies a world binding. */
export function restoreFactoryRegistry(raw, { worldId } = {}) {
  if (raw === undefined) return createFactoryRegistry(worldId)
  record(raw, ['schema_version', 'world_id', 'revision', 'next_cell_id', 'next_dependency_id', 'cells', 'dependencies'], 'registry')
  if (raw.schema_version !== 1) fail('invalid_schema', 'Unsupported factory registry schema')
  const world = string(raw.world_id, 'world_id', 512)
  if (worldId !== undefined && string(worldId, 'worldId', 512) !== world) fail('world_mismatch', 'Registry belongs to a different world')
  const revision = integer(raw.revision, 'revision')
  const nextCell = integer(raw.next_cell_id, 'next_cell_id', 1)
  const nextDependency = integer(raw.next_dependency_id, 'next_dependency_id', 1)
  const cells = array(raw.cells, 'cells', FACTORY_REGISTRY_LIMITS.cells).map(cell)
  const ids = new Set()
  const units = new Set()
  const locations = new Set()
  const enrollments = new Set()
  for (const entry of cells) {
    if (entry.enrollment) {
      const identity = JSON.stringify([entry.enrollment.goal_id, entry.enrollment.semantic_step_id])
      if (enrollments.has(identity)) fail('duplicate_enrollment', 'Semantic step already has a cell')
      enrollments.add(identity)
      if (entry.members.length !== 2 || entry.origin.goal_id !== entry.enrollment.goal_id || entry.origin.semantic_step_id !== entry.enrollment.semantic_step_id
        || entry.enrollment.receipt_ids.some((id, i) => entry.members[i].provenance.receipt_id !== id)) fail('invalid_enrollment', 'Enrollment members/origin mismatch')
    }
    if (ids.has(entry.cell_id)) fail('duplicate_id', 'Duplicate cell ID')
    ids.add(entry.cell_id)
    if (generatedId(entry.cell_id, 'cell') >= nextCell) fail('invalid_counter', 'Cell counter would reuse an identity')
    for (const entity of entry.members) {
      // A different declared scope cannot make an existing native unit a second
      // production asset. Lookups still require scope to prevent stale aliases.
      const unit = entity.unit_number
      const location = JSON.stringify([entity.surface_index, entity.force_index, entity.name, entity.position.x, entity.position.y])
      if (units.has(unit) || locations.has(location)) fail('duplicate_assignment', 'Entity is assigned more than once')
      units.add(unit)
      locations.add(location)
    }
  }
  const deps = dependencies(raw.dependencies, cells)
  const dependencyIds = new Set()
  for (const dep of deps) {
    if (dependencyIds.has(dep.dependency_id)) fail('duplicate_id', 'Duplicate dependency ID')
    dependencyIds.add(dep.dependency_id)
    if (generatedId(dep.dependency_id, 'dependency') >= nextDependency) fail('invalid_counter', 'Dependency counter would reuse an identity')
  }
  // Every allocated identity consumed a revision. Gaps remain reserved, never reused.
  if (nextCell - 1 > revision || nextDependency - 1 > revision - (nextCell - 1)) fail('invalid_counter', 'Identity counters exceed committed revisions')
  return { schema_version: 1, world_id: world, revision, next_cell_id: nextCell, next_dependency_id: nextDependency, cells, dependencies: deps }
}

export function createFactoryRegistry(worldId) {
  return { schema_version: 1, world_id: string(worldId, 'worldId', 512), revision: 0, next_cell_id: 1, next_dependency_id: 1, cells: [], dependencies: [] }
}

function increment(raw, label) {
  if (raw >= Number.MAX_SAFE_INTEGER) fail('counter_exhausted', `${label} is exhausted`)
  return raw + 1
}

export function registerFactoryCell(registry, declaration) {
  const state = restoreFactoryRegistry(registry)
  record(declaration, ['surface_index', 'force_index', 'assignment', 'members', 'ports', 'origin', 'enrollment'], 'cell declaration')
  const entry = cell({ ...declaration, cell_id: `cell-${state.next_cell_id}`, revision: 1, state: 'unverified' })
  return restoreFactoryRegistry({ ...state, revision: increment(state.revision, 'revision'), next_cell_id: increment(state.next_cell_id, 'cell counter'), cells: [...state.cells, entry] })
}

export function registerFactoryDependency(registry, declaration) {
  const state = restoreFactoryRegistry(registry)
  record(declaration, ['consumer', 'supplier', 'delivery', 'state', 'evidence_refs'], 'dependency declaration')
  let entry
  try { entry = normalizeFactoryDependency({ ...declaration, dependency_id: `dependency-${state.next_dependency_id}` }, state.cells) }
  catch (error) { fail('invalid_dependency', error.message) }
  return restoreFactoryRegistry({ ...state, revision: increment(state.revision, 'revision'), next_dependency_id: increment(state.next_dependency_id, 'dependency counter'), dependencies: [...state.dependencies, entry] })
}

export function observeFactoryCell(registry, cellId, rawObservation) {
  const state = restoreFactoryRegistry(registry)
  const entry = state.cells.find(value => value.cell_id === cellId)
  if (!entry) fail('unknown_cell', 'Cannot observe an unknown cell')
  entry.observation = observation(rawObservation)
  return { ...state, revision: increment(state.revision, 'revision') }
}

export function listFactoryCells(registry) { return restoreFactoryRegistry(registry).cells }
export function getFactoryCell(registry, cellId) { return listFactoryCells(registry).find(value => value.cell_id === cellId) ?? null }
export function findFactoryCellsByProduct(registry, product) {
  string(product, 'product')
  return listFactoryCells(registry).filter(value => value.assignment.products.includes(product))
}

/** Exact scope is mandatory. Optional name/position narrow, never widen, the match. */
export function findFactoryCellByMember(registry, locator) {
  const state = restoreFactoryRegistry(registry)
  record(locator, ['world_id', 'surface_index', 'force_index', 'unit_number', 'name', 'position'], 'member locator')
  const world = string(locator.world_id, 'locator.world_id', 512)
  const surface = integer(locator.surface_index, 'locator.surface_index', 1)
  const force = integer(locator.force_index, 'locator.force_index', 1)
  const unit = integer(locator.unit_number, 'locator.unit_number', 1)
  const name = Object.hasOwn(locator, 'name') ? string(locator.name, 'locator.name') : undefined
  const point = Object.hasOwn(locator, 'position') ? position(locator.position) : undefined
  if (world !== state.world_id) return null
  return state.cells.find(entry => entry.members.some(entity => entity.surface_index === surface && entity.force_index === force && entity.unit_number === unit
    && (name === undefined || name === entity.name) && (!point || (point.x === entity.position.x && point.y === entity.position.y)))) ?? null
}
