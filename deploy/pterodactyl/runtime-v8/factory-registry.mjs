import { normalizeFactoryDependency, validateFactoryDependencies, factoryMetadataDigest } from './factory-dependencies.mjs'
export { factoryMetadataDigest } from './factory-dependencies.mjs'

// Declarations are durable assignments, never commissioning or live-world proof.
// No removal/reassignment reducer exists in stage 1. Future lifecycle changes must
// preserve identity counters and explicitly revision the affected cell design.
export const FACTORY_REGISTRY_LIMITS = Object.freeze({ cells: 256, members: 256, ports: 128, products: 64, dependencies: 4096, evidence_refs: 32, cell_revisions: 64, metadata_transactions: 1024 })

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
  record(raw, ['cell_id', 'revision', 'state', 'surface_index', 'force_index', 'assignment', 'members', 'ports', 'origin', 'observation', 'enrollment', 'port_bindings', 'metadata_history'], 'cell')
  generatedId(raw.cell_id, 'cell')
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision > FACTORY_REGISTRY_LIMITS.cell_revisions || raw.state !== 'unverified') fail('invalid_schema', 'Cell revision is bounded and metadata never verifies a cell')
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
  const result = {
    cell_id: raw.cell_id, revision: raw.revision, state: 'unverified', surface_index: surface, force_index: force, assignment,
    members: array(raw.members, 'members', FACTORY_REGISTRY_LIMITS.members, 1).map(value => member(value, surface, force)),
    ports, origin: history(raw.origin, 'origin'),
    ...(Object.hasOwn(raw, 'enrollment') ? { enrollment: enrollment(raw.enrollment) } : {}),
    ...(Object.hasOwn(raw, 'observation') ? { observation: observation(raw.observation) } : {}),
  }
  if (raw.revision === 1) {
    if (Object.hasOwn(raw, 'port_bindings') || Object.hasOwn(raw, 'metadata_history')) fail('factory_metadata_history_invalid', 'Legacy revision must not contain an explicit partial history')
  } else {
    result.port_bindings = bindings(raw.port_bindings, result)
    result.metadata_history = metadataHistory(raw.metadata_history, result)
  }
  return result
}

const equal = (a, b) => factoryMetadataDigest(a) === factoryMetadataDigest(b)
function metadataData(value, budget = { remaining: 524288 }, depth = 0) {
  if (--budget.remaining < 0 || depth > 16) fail('factory_metadata_capacity', 'Metadata body exceeds deterministic bounds')
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail('invalid_schema', 'Metadata must be plain serializable data')
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !desc.enumerable || !Object.hasOwn(desc, 'value')) fail('invalid_schema', 'Metadata cannot contain accessors or hidden values')
    metadataData(desc.value, budget, depth + 1)
  }
}
export function factoryCellIdentity(cell) {
  return Object.fromEntries(['cell_id', 'state', 'surface_index', 'force_index', 'assignment', 'members', 'origin', 'enrollment'].filter(k => Object.hasOwn(cell, k)).map(k => [k, structuredClone(cell[k])]))
}
function bindings(raw, cell) {
  const rows = array(raw, 'port bindings', FACTORY_REGISTRY_LIMITS.ports).map(value => {
    record(value, ['port_id', 'member', 'endpoint', 'state', 'evidence_refs'], 'port binding')
    const portId = string(value.port_id, 'binding port', 128)
    const declared = cell.ports.find(p => p.port_id === portId)
    if (!declared || value.state !== 'unverified') fail('factory_metadata_binding_invalid', 'Bindings reference declared ports and remain unverified')
    record(value.member, ['unit_number', 'name', 'position', 'surface_index', 'force_index'], 'binding member')
    const locator = { unit_number: integer(value.member.unit_number, 'binding member unit', 1), name: string(value.member.name, 'binding member name'),
      position: position(value.member.position), surface_index: integer(value.member.surface_index, 'binding surface', 1), force_index: integer(value.member.force_index, 'binding force', 1) }
    if (!cell.members.some(({ provenance, ...member }) => equal(member, locator))) fail('factory_metadata_binding_member_mismatch', 'Binding must identify an exact existing member')
    const endpoint = value.endpoint
    const expected = ['item', 'fuel'].includes(declared.kind) ? 'inventory' : declared.kind === 'fluid' ? 'fluidbox' : 'electric_network'
    const field = { inventory: 'inventory_index', fluidbox: 'fluidbox_index', electric_network: 'electric_network_id' }[expected]
    record(endpoint, ['kind', field], 'binding endpoint')
    if (endpoint.kind !== expected) fail('factory_metadata_endpoint_kind_mismatch', 'Endpoint kind must match port kind')
    return { port_id: portId, member: locator, endpoint: { kind: expected, [field]: integer(endpoint[field], 'native endpoint index', 1) }, state: 'unverified',
      evidence_refs: strings(value.evidence_refs, 'binding evidence references', FACTORY_REGISTRY_LIMITS.evidence_refs, 1, 512) }
  })
  if (new Set(rows.map(r => r.port_id)).size !== rows.length) fail('factory_metadata_duplicate_binding', 'A port has one exact declared endpoint')
  return rows
}
function baseMetadata(cell) {
  const row = { revision: 1, previous_digest: null, identity_digest: factoryMetadataDigest(factoryCellIdentity(cell)),
    registry_revision: null, transaction_id: null, request_digest: null, origin: null, ports: structuredClone(cell.ports), port_bindings: [], dependencies: [] }
  return { ...row, digest: factoryMetadataDigest(row) }
}
export function factoryCellMetadataHead(cell) { return cell.metadata_history?.at(-1)?.digest ?? baseMetadata(cell).digest }
function metadataHistory(raw, cell) {
  metadataData(raw)
  const rows = array(raw, 'metadata history', FACTORY_REGISTRY_LIMITS.cell_revisions, 2)
  if (rows.length !== cell.revision) fail('factory_metadata_history_invalid', 'Revision history cannot skip entries')
  const normalized = []
  for (const [i, value] of rows.entries()) {
    record(value, ['revision', 'previous_digest', 'identity_digest', 'registry_revision', 'transaction_id', 'request_digest', 'origin', 'ports', 'port_bindings', 'dependencies', 'digest'], 'metadata revision')
    if (value.revision !== i + 1 || value.identity_digest !== factoryMetadataDigest(factoryCellIdentity(cell))) fail('factory_metadata_history_invalid', 'Revision identity or sequence changed')
    const ports = array(value.ports, 'revision ports', FACTORY_REGISTRY_LIMITS.ports).map(p => port(p, cell.assignment.products))
    if (new Set(ports.map(p => p.port_id)).size !== ports.length) fail('duplicate_port', 'Revision contains duplicate ports')
    const portBindings = bindings(value.port_bindings, { ...cell, ports })
    const row = { revision: value.revision, previous_digest: value.previous_digest, identity_digest: value.identity_digest,
      registry_revision: value.registry_revision, transaction_id: value.transaction_id, request_digest: value.request_digest, origin: value.origin,
      ports, port_bindings: portBindings, dependencies: structuredClone(array(value.dependencies, 'revision dependencies', FACTORY_REGISTRY_LIMITS.ports)) }
    if (i === 0) {
      const base = baseMetadata({ ...cell, ports })
      if (!equal({ ...row, digest: value.digest }, base)) fail('factory_metadata_history_invalid', 'Initial revision anchor changed')
    } else {
      integer(row.registry_revision, 'revision registry sequence', 1); string(row.transaction_id, 'transaction ID', 128)
      if (!/^[a-f0-9]{64}$/.test(row.request_digest)) fail('factory_metadata_history_invalid', 'Request digest missing')
      row.origin = history(row.origin, 'metadata origin')
      const previous = normalized[i - 1]
      if (row.previous_digest !== previous.digest || (i > 1 && row.registry_revision <= previous.registry_revision)
        || !equal(ports.slice(0, previous.ports.length), previous.ports) || ports.slice(previous.ports.length).some(p => p.direction !== 'input')
        || !equal(portBindings.slice(0, previous.port_bindings.length), previous.port_bindings)) fail('factory_metadata_history_invalid', 'Metadata must preserve its complete additive prefix')
      const addedInputs = ports.slice(previous.ports.length)
      if (addedInputs.some(p => !portBindings.some(b => b.port_id === p.port_id) || !row.dependencies.some(d => d.consumer?.cell_id === cell.cell_id && d.consumer?.port_id === p.port_id))) fail('factory_metadata_half_publication', 'New inputs require endpoint and dependency together')
      if (portBindings.slice(previous.port_bindings.length).some(b => ports.find(p => p.port_id === b.port_id)?.direction === 'input'
        && !row.dependencies.some(d => d.consumer?.cell_id === cell.cell_id && d.consumer?.port_id === b.port_id))) fail('factory_metadata_half_publication', 'Input bindings require corresponding dependency metadata')
    }
    if (value.digest !== factoryMetadataDigest(row)) fail('factory_metadata_history_invalid', 'Revision digest mismatch')
    normalized.push({ ...row, digest: value.digest })
  }
  const last = normalized.at(-1)
  if (!equal(last.ports, cell.ports) || !equal(last.port_bindings, cell.port_bindings)) fail('factory_metadata_half_publication', 'Current projection differs from revision head')
  return normalized
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
  const transactions = new Set(); const revisedDependencies = new Set(); const metadataRevisions = new Set()
  for (const entry of cells) for (const revision of entry.metadata_history?.slice(1) ?? []) {
    if (revision.registry_revision > revisionNumber(raw.revision) || transactions.has(revision.transaction_id) || metadataRevisions.has(revision.registry_revision)) fail('factory_metadata_history_invalid', 'Transaction identity or registry sequence reused')
    transactions.add(revision.transaction_id)
    metadataRevisions.add(revision.registry_revision)
    for (const dependency of revision.dependencies) {
      if (!dependency.endpoint_bindings || dependency.consumer?.cell_id !== entry.cell_id || revisedDependencies.has(dependency.dependency_id)
        || !deps.some(d => equal(d, dependency))) fail('factory_metadata_half_publication', 'Revision dependency is missing, duplicated or changed')
      revisedDependencies.add(dependency.dependency_id)
    }
  }
  if (deps.some(d => d.endpoint_bindings && !revisedDependencies.has(d.dependency_id))) fail('factory_metadata_half_publication', 'Bound dependency has no atomic revision record')
  if (transactions.size > FACTORY_REGISTRY_LIMITS.metadata_transactions) fail('factory_metadata_capacity', 'Metadata transaction capacity exhausted')
  const dependencyIds = new Set()
  for (const dep of deps) {
    if (dependencyIds.has(dep.dependency_id)) fail('duplicate_id', 'Duplicate dependency ID')
    dependencyIds.add(dep.dependency_id)
    if (generatedId(dep.dependency_id, 'dependency') >= nextDependency) fail('invalid_counter', 'Dependency counter would reuse an identity')
  }
  // Legacy identities each consumed a revision; one metadata transaction may
  // atomically allocate several edges. Only its retained edge records discount
  // those allocations. Counter gaps remain reserved, never reused.
  if ((nextCell - 1) + (nextDependency - 1) - revisedDependencies.size + transactions.size > revision) fail('invalid_counter', 'Identity counters exceed committed revisions')
  return { schema_version: 1, world_id: world, revision, next_cell_id: nextCell, next_dependency_id: nextDependency, cells, dependencies: deps }
}

function revisionNumber(value) { return integer(value, 'registry revision') }

/** Host metadata only: additive input ports/endpoints/edges, no physical authority. */
export function appendFactoryCellMetadata(registry, change, origin) {
  const state = restoreFactoryRegistry(registry)
  metadataData(change)
  record(change, ['transaction_id', 'cell_id', 'expected_registry_revision', 'expected_cells', 'input_ports', 'port_bindings', 'dependencies'], 'metadata change')
  const transactionId = string(change.transaction_id, 'transaction ID', 128)
  const requestDigest = factoryMetadataDigest(change)
  const prior = state.cells.flatMap(c => (c.metadata_history ?? []).map(r => ({ cell_id: c.cell_id, ...r }))).find(r => r.transaction_id === transactionId)
  if (prior) {
    if (prior.request_digest !== requestDigest) fail('factory_metadata_transaction_conflict', 'Transaction ID cannot name a different change')
    return { registry: state, cell_id: prior.cell_id, duplicate: true }
  }
  if (change.expected_registry_revision !== state.revision) fail('factory_registry_revision_stale', 'Registry CAS failed')
  const target = state.cells.find(c => c.cell_id === change.cell_id)
  if (!target) fail('unknown_cell', 'Metadata target missing')
  const declarations = array(change.dependencies, 'metadata dependencies', FACTORY_REGISTRY_LIMITS.ports)
  const involved = [...new Set([target.cell_id, ...declarations.filter(d => d.supplier?.kind === 'cell').map(d => d.supplier.cell_id)])].sort()
  const expected = array(change.expected_cells, 'expected cells', FACTORY_REGISTRY_LIMITS.cells, 1)
  if (!equal(expected.map(e => e.cell_id).sort(), involved)) fail('factory_metadata_expected_cells_invalid', 'CAS must cover exactly every participating cell')
  for (const entry of expected) {
    record(entry, ['cell_id', 'revision', 'digest'], 'expected cell')
    const current = state.cells.find(c => c.cell_id === entry.cell_id)
    if (!current || current.revision !== entry.revision || factoryCellMetadataHead(current) !== entry.digest) fail('factory_cell_revision_stale', 'Cell CAS failed')
    if (current.surface_index !== target.surface_index || current.force_index !== target.force_index) fail('factory_metadata_scope_mismatch', 'Metadata cells must share scope')
  }
  if (target.revision >= FACTORY_REGISTRY_LIMITS.cell_revisions || state.cells.reduce((n, c) => n + (c.metadata_history?.length ?? 1) - 1, 0) >= FACTORY_REGISTRY_LIMITS.metadata_transactions) fail('factory_metadata_capacity', 'Metadata history cannot evict previous IDs')
  const inputs = array(change.input_ports, 'new input ports', FACTORY_REGISTRY_LIMITS.ports).map(p => port(p, target.assignment.products))
  if (inputs.some(p => p.direction !== 'input')) fail('factory_metadata_output_addition_forbidden', 'Output assignment is immutable')
  const candidate = structuredClone(state); const cell = candidate.cells.find(c => c.cell_id === target.cell_id)
  cell.ports.push(...inputs)
  cell.port_bindings = [...(target.port_bindings ?? []), ...bindings(change.port_bindings, cell)]
  if (!inputs.length && !change.port_bindings.length && !declarations.length) fail('factory_metadata_empty', 'Empty revision is not a transaction')
  cell.revision++
  const oldHistory = target.metadata_history ?? [baseMetadata(target)]
  const next = { revision: cell.revision, previous_digest: oldHistory.at(-1).digest, identity_digest: factoryMetadataDigest(factoryCellIdentity(cell)),
    registry_revision: increment(state.revision, 'registry revision'), transaction_id: transactionId, request_digest: requestDigest,
    origin: history(origin, 'metadata origin'), ports: structuredClone(cell.ports), port_bindings: structuredClone(cell.port_bindings), dependencies: [] }
  cell.metadata_history = [...oldHistory, next]
  const endpoint = (id, portId) => {
    const c = candidate.cells.find(c => c.cell_id === id); const binding = c?.port_bindings?.find(b => b.port_id === portId)
    if (!binding) fail('factory_metadata_endpoint_unbound', 'Every participating endpoint needs an exact declared member binding')
    return { cell_revision: c.revision, binding_digest: factoryMetadataDigest(binding) }
  }
  for (const declaration of declarations) {
    if (declaration.consumer?.cell_id !== target.cell_id || Object.hasOwn(declaration, 'dependency_id') || Object.hasOwn(declaration, 'endpoint_bindings')) fail('factory_metadata_dependency_authority', 'Metadata only adds target inputs and host-derived endpoint references')
    const normalized = normalizeFactoryDependency({ ...declaration, dependency_id: `dependency-${candidate.next_dependency_id}`,
      endpoint_bindings: { consumer: endpoint(target.cell_id, declaration.consumer.port_id), ...(declaration.supplier?.kind === 'cell'
        ? { supplier: endpoint(declaration.supplier.cell_id, declaration.supplier.port_id) } : {}) } }, candidate.cells)
    candidate.next_dependency_id = increment(candidate.next_dependency_id, 'dependency counter')
    candidate.dependencies.push(normalized); next.dependencies.push(normalized)
  }
  next.digest = factoryMetadataDigest(next)
  candidate.revision = next.registry_revision
  return { registry: restoreFactoryRegistry(candidate), cell_id: target.cell_id, duplicate: false }
}

/** Cold recovery only recognizes the two complete files our atomic writer can
 * leave. It never resends a mutation or lends the old owner's capability to a
 * new request. A previous file discards the uncommitted intent; a candidate file
 * retains its already-written, unverified metadata. Everything else faults. */
export function reconcileFactoryMetadataPublication(registry, marker, worldId) {
  metadataData(marker)
  record(marker, ['schema_version', 'transaction_id', 'candidate_digest', 'previous_digest', 'request_digest', 'owner',
    'previous_revision', 'state', 'previous_registry', 'change'], 'pending metadata publication')
  if (marker.schema_version !== 1 || marker.state !== 'publication_unconfirmed') fail('factory_metadata_publication_unconfirmed', 'Unsupported publication marker')
  const owner = marker.owner
  record(owner, ['world_id', 'surface_index', 'force_index', 'actor_id', 'actor_epoch', 'request_id', 'session_id',
    'goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id', 'expected_revision'], 'pending metadata owner')
  for (const key of ['request_id', 'session_id', 'goal_id', 'plan_id', 'step_id', 'semantic_step_id']) string(owner[key], `owner.${key}`, 512)
  for (const key of ['surface_index', 'force_index', 'actor_id']) integer(owner[key], `owner.${key}`, 1)
  for (const key of ['actor_epoch', 'plan_version', 'expected_revision']) integer(owner[key], `owner.${key}`)
  if (owner.world_id !== worldId) fail('factory_world_mismatch', 'Publication owner belongs to another world')
  const previous = restoreFactoryRegistry(marker.previous_registry, { worldId })
  const target = previous.cells.find(c => c.cell_id === marker.change?.cell_id)
  if (!target || target.surface_index !== owner.surface_index || target.force_index !== owner.force_index
    || previous.revision !== marker.previous_revision || previous.revision !== owner.expected_revision
    || factoryMetadataDigest(previous) !== marker.previous_digest || factoryMetadataDigest(marker.change) !== marker.request_digest
    || marker.change.transaction_id !== marker.transaction_id) fail('factory_metadata_reconciliation_conflict', 'Publication marker does not bind the complete predecessor and request')
  const candidate = appendFactoryCellMetadata(previous, marker.change, { source: 'runtime_metadata_declaration', goal_id: owner.goal_id,
    plan_id: owner.plan_id, plan_version: owner.plan_version, semantic_step_id: owner.semantic_step_id,
    request_id: owner.request_id, actor_id: owner.actor_id, actor_epoch: owner.actor_epoch })
  if (candidate.duplicate || factoryMetadataDigest(candidate.registry) !== marker.candidate_digest) fail('factory_metadata_reconciliation_conflict', 'Candidate cannot be reproduced exactly')
  const actual = factoryMetadataDigest(registry)
  if (actual !== marker.previous_digest && actual !== marker.candidate_digest) fail('factory_metadata_reconciliation_conflict', 'File is neither complete publication outcome')
  return { transaction_id: marker.transaction_id, request_id: owner.request_id, goal_id: owner.goal_id, plan_id: owner.plan_id,
    outcome: actual === marker.candidate_digest ? 'committed_unverified' : 'not_committed', registry_revision: registry.revision }
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
  if (state.cells.some(c => c.revision > 1 && (c.cell_id === declaration?.consumer?.cell_id || c.cell_id === declaration?.supplier?.cell_id))) fail('factory_metadata_transaction_required', 'Revised cells require atomic dependency metadata publication')
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
