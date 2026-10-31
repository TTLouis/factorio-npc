import { randomUUID } from 'node:crypto'
import { createFactoryRegistry, registerFactoryCell, FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan } from './planning-state.mjs'

export const FACTORY_OBSERVATION_LIMITS = Object.freeze({ members: 32, body_chars: 262144, summaries: 256 })
const fail = code => { throw new FactoryRegistryError(code, code) }
const copy = value => structuredClone(value)
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160
const positive = value => Number.isSafeInteger(value) && value > 0
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const identity = (a, b) => a?.unit_number === b?.unit_number && a?.name === b?.name
  && a?.surface_index === b?.surface_index && a?.force_index === b?.force_index
  && a?.position?.x === b?.position?.x && a?.position?.y === b?.position?.y
const verdict = (state, code, extra = {}) => ({ state, code, ...extra })
const unknown = code => verdict('unverified', code)
const names = rows => Array.isArray(rows) && rows.length <= 24 && rows.every(row => token(row?.name)) ? rows.map(row => row.name) : undefined
const combine = checks => checks.some(row => row.state === 'mismatch') ? 'mismatch'
  : checks.length && checks.every(row => row.state === 'compatible') ? 'compatible' : 'unverified'

function nativeBody(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  if (typeof text !== 'string' || text.length > FACTORY_OBSERVATION_LIMITS.body_chars) fail('factory_observation_body_limit')
  try { return JSON.parse(text) }
  catch { fail('factory_observation_unreadable') }
}

// Only exact observed native facts support compatibility. These are topology and
// configuration checks, never commissioning, production, throughput or liveness.
export function validateFactoryMiningSource(row, resource) {
  const source = row?.source_resources
  if (source?.state !== 'known' || source.truncated !== false || !Array.isArray(source.resources)
    || source.resources.length > 64 || !source.resources.length) return unknown('mining_source_unknown')
  const resources = source.resources
  if (resources.some(entry => entry.products_truncated !== false || !names(entry.products) || entry.products.length === 0
    || entry.products.some(product => !['item', 'fluid'].includes(product.type)
      || (product.probability !== undefined && !(product.probability > 0))))) return unknown('mining_products_unknown')
  const matches = resources.filter(entry => entry.name === resource || entry.products.some(product => product.name === resource))
  if (!matches.length) return verdict('mismatch', 'mining_source_resource_mismatch')
  if (matches.length !== resources.length) return unknown('mining_source_mixed')
  return verdict('compatible', 'native_mining_products_match', { products: [...new Set(matches.flatMap(entry => names(entry.products)))],
    item_only: matches.every(entry => entry.products.every(product => product.type === 'item')) })
}

function recipe(row) {
  const value = row?.recipe
  if (value?.state !== 'known' || value.truncated !== false || !names(value.ingredients) || !names(value.products)) return undefined
  return value
}

function assignedOutput(row, product, kind) {
  // Resource entity names identify input sources, not their produced outputs.
  // A typed native product is required even when no output port declares a kind.
  const matches = products => names(products) && products.some(item => item.name === product
    && ['item', 'fluid'].includes(item.type) && (kind === undefined || item.type === kind)
    && (item.probability === undefined || (Number.isFinite(item.probability) && item.probability > 0 && item.probability <= 1)))
  if (matches(recipe(row)?.products)) return true
  const source = row?.source_resources
  return source?.state === 'known' && source.truncated === false && Array.isArray(source.resources)
    && source.resources.length <= 64 && source.resources.some(entry => entry?.products_truncated === false && matches(entry.products))
}

function recordedLocation(cell) {
  const points = cell.members.map(member => member.position)
  return { state: 'historical_unverified', anchor: copy(points[0]), member_position_bounds: {
    left_top: { x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y)) },
    right_bottom: { x: Math.max(...points.map(point => point.x)), y: Math.max(...points.map(point => point.y)) },
  } }
}

function directFeed(cell, rows, binding, supply) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).some(key => !['source_unit_number', 'target_unit_number', 'product'].includes(key))
    || !positive(binding.source_unit_number) || !positive(binding.target_unit_number)
    || binding.source_unit_number === binding.target_unit_number
    || (binding.product !== undefined && !token(binding.product))) fail('factory_binding_invalid')
  if (supply?.mode !== 'direct_feed' || !token(supply.resource)) fail('factory_direct_feed_authority_missing')
  const source = cell.members.find(row => row.unit_number === binding.source_unit_number)
  const target = cell.members.find(row => row.unit_number === binding.target_unit_number)
  if (!source || !target) fail('factory_binding_member_mismatch')
  if (binding.product !== undefined && !cell.assignment.products.includes(binding.product)) return verdict('mismatch', 'assigned_product_mismatch')
  const observedSource = rows.find(row => identity(row.locator, source))
  const observedTarget = rows.find(row => identity(row.locator, target))
  if (observedSource?.state !== 'observed' || observedTarget?.state !== 'observed') return unknown('binding_member_unverified')
  const mined = validateFactoryMiningSource(observedSource, supply.resource)
  if (mined.state !== 'compatible') return mined
  if (!mined.item_only) return unknown('direct_feed_product_type_unverified')
  const targetRecipe = recipe(observedTarget)
  if (!targetRecipe) return unknown('target_recipe_unknown')
  if (!mined.products.every(product => targetRecipe.ingredients.some(item => item.name === product && item.type === 'item'))) return verdict('mismatch', 'target_recipe_input_mismatch')
  if (binding.product !== undefined && !targetRecipe.products.some(item => item.name === binding.product)) return verdict('mismatch', 'target_recipe_product_mismatch')
  if (binding.product !== undefined) {
    const outputs = targetRecipe.products.filter(item => item.name === binding.product)
    if (outputs.some(item => item.type !== undefined && item.type !== 'item')) return verdict('mismatch', 'target_recipe_product_type_mismatch')
    if (outputs.some(item => item.type !== 'item')) return unknown('target_recipe_product_type_unknown')
  }
  const routes = observedSource.item_routes
  if (routes?.state !== 'known' || routes.truncated !== false || !Array.isArray(routes.routes)) return unknown('direct_feed_route_unknown')
  const drops = routes.routes.filter(route => route.kind === 'drop')
  if (drops.length !== 1 || drops[0].state === 'unknown') return unknown('direct_feed_route_unknown')
  if (drops[0].state !== 'connected' || !identity(drops[0].target, target)) return verdict('mismatch', 'direct_feed_route_mismatch')
  return verdict('compatible', 'native_direct_feed_compatible', { products: mined.products })
}

export function validateFactoryCellObservation({ registry, cell, native, binding, materialSupply }) {
  const checks = []
  const rows = native.members
  for (const member of cell.members) {
    const row = rows.find(candidate => identity(candidate.locator, member))
    checks.push(row?.state === 'observed' ? verdict('compatible', 'native_member_identity_match', { unit_number: member.unit_number })
      : unknown('native_member_unverified'))
  }
  if (binding) checks.push(directFeed(cell, rows, binding, materialSupply))
  // Assignment describes final products but stage 1 has no member roles. A known
  // intermediate recipe cannot refute the entire cell. Positive matching facts
  // are useful; absence of a matching machine is not a fabricated failure.
  if (cell.enrollment?.output_roles) {
    for (const output of cell.enrollment.output_roles) {
      const role = cell.enrollment.member_roles.find(row => row.role === output.role)
      const member = cell.members.find(row => row.provenance.receipt_id === role.receipt_id)
      const row = rows.find(row => identity(row.locator, member))
      const port = cell.ports.find(port => port.port_id === output.port_id)
      const found = row?.state === 'observed' && (port.kind === 'power'
        ? row.progress_facts?.electricity_production?.state === 'known' && row.progress_facts.electricity_production.producer === true
        : assignedOutput(row, port.resource, port.kind))
      checks.push(found ? verdict('compatible', 'assigned_role_native_capability', { role: output.role, port_id: port.port_id })
        : { ...unknown('assigned_role_capability_unverified'), role: output.role, port_id: port.port_id })
    }
  }
  else if (cell.assignment.products.length === 0) checks.push(unknown('assigned_service_capability_unverified'))
  for (const product of cell.enrollment?.output_roles ? [] : cell.assignment.products) {
    const kinds = [...new Set(cell.ports.filter(port => port.direction === 'output' && port.resource === product)
      .map(port => port.kind === 'fuel' ? 'item' : port.kind))]
    const found = (kinds.length ? kinds : [undefined]).every(kind => rows.some(row => row.state === 'observed' && assignedOutput(row, product, kind)))
    checks.push(found ? verdict('compatible', 'assigned_product_native_capability', { product }) : { ...unknown('assigned_product_capability_unverified'), product })
  }
  const dependencies = registry.dependencies.filter(dep => dep.consumer.cell_id === cell.cell_id).map(dep => ({
    dependency_id: dep.dependency_id, ...unknown(dep.supplier.kind === 'unresolved' ? 'dependency_supplier_unresolved' : 'dependency_port_members_unbound'),
  }))
  return { state: combine(checks), checks, dependencies, commissioning: 'unverified', throughput: 'unverified' }
}

// Summaries are historical display data, never admission evidence. Strictly
// bound restore before saving them again; fresh validation always queries native.
export function restoreFactoryObservationSummaries(raw, registry) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > FACTORY_OBSERVATION_LIMITS.summaries) fail('factory_observation_restore_invalid')
  const seen = new Set()
  return raw.map(row => {
    if (!row || Object.keys(row).some(key => !['cell_id', 'world_id', 'registry_revision', 'request_id', 'session_id', 'actor_id', 'actor_epoch', 'tick', 'state', 'freshness'].includes(key))
      || !registry?.cells.some(cell => cell.cell_id === row.cell_id) || seen.has(row.cell_id)
      || row.world_id !== registry.world_id || !Number.isSafeInteger(row.registry_revision) || row.registry_revision < 0 || row.registry_revision > registry.revision
      || !token(row.request_id) || !token(row.session_id) || !positive(row.actor_id) || !Number.isSafeInteger(row.actor_epoch) || row.actor_epoch < 0
      || !Number.isSafeInteger(row.tick) || row.tick < 0 || !['compatible', 'mismatch', 'unverified'].includes(row.state)) fail('factory_observation_restore_invalid')
    seen.add(row.cell_id)
    return { ...copy(row), freshness: 'historical' }
  })
}

export function createFactoryCellObserver({ memory, key, readContext, callNative, readPlacementReceipt, trace = () => {} }) {
  if (!memory || typeof readContext !== 'function' || typeof callNative !== 'function') fail('factory_observer_dependencies_required')
  let runtime
  let inFlight = false
  const emit = (name, payload) => {
    try { trace(name, payload)?.catch?.(() => {}) }
    catch { /* Trace failure grants no authority. */ }
  }
  const context = () => {
    const row = readContext()
    if (!row || !token(row.session_id) || !token(row.request_id) || !positive(row.actor_id) || !Number.isSafeInteger(row.actor_epoch) || row.actor_epoch < 0
      || !positive(row.surface_index) || !positive(row.force_index)) fail('factory_observation_context_invalid')
    if (row.native_idle !== true || row.pending !== false || row.uncertain !== false) fail('factory_runtime_not_idle')
    return copy(row)
  }
  const same = before => {
    const now = context()
    if (['world_id', 'session_id', 'request_id', 'actor_id', 'actor_epoch', 'surface_index', 'force_index'].some(field => now[field] !== before[field])) fail('factory_observation_owner_stale')
  }
  const guarded = async (action, body) => {
    if (inFlight) {
      let current
      try { current = context() } catch { /* Existing owner remains authoritative. */ }
      emit('factory_cell.observation_refused', { action, code: 'factory_observation_in_flight', request_id: current?.request_id, session_id: current?.session_id })
      fail('factory_observation_in_flight')
    }
    inFlight = true
    let owner
    try {
      owner = context()
      return await body(owner)
    }
    catch (error) {
      emit('factory_cell.observation_refused', { action, code: error?.code ?? 'factory_native_read_failed', request_id: owner?.request_id, actor_id: owner?.actor_id, actor_epoch: owner?.actor_epoch, session_id: owner?.session_id })
      if (error instanceof FactoryRegistryError) throw error
      fail('factory_native_read_failed')
    }
    finally { inFlight = false }
  }
  return Object.freeze({
    get runtime() { if (!runtime) fail('factory_world_unbound'); return runtime },
    initializeWorld: () => guarded('world_binding', async owner => {
      const initial = memory.factoryWorldBinding()
      let native = nativeBody(await callNative('world_identity'))
      same(owner)
      if (native.schema_version !== 1) fail('factory_world_identity_invalid')
      if (!native.world_id) {
        if (initial.world_id !== undefined || native.code !== 'world_unbound') fail('factory_world_identity_missing')
        native = nativeBody(await callNative('bind_world_id', randomUUID()))
        same(owner)
      }
      if (native.ok !== true || !uuid(native.world_id)) fail('factory_world_identity_invalid')
      if (memory.factoryWorldBinding().generation !== initial.generation) fail('factory_runtime_stale')
      if (initial.world_id !== undefined && initial.world_id !== native.world_id) fail('factory_world_mismatch')
      if (owner.world_id !== undefined && owner.world_id !== native.world_id) fail('factory_world_mismatch')
      memory.initializeFactoryRegistry(native.world_id)
      runtime = memory.createFactoryRegistryRuntime(key, readContext, readPlacementReceipt)
      emit('factory_cell.world_bound', { world_id: native.world_id, request_id: owner.request_id, session_id: owner.session_id })
      return native.world_id
    }),
    list: () => {
      const registry = memory.getFactoryOperationalRegistry?.() ?? memory.getFactoryRegistry()
      return { world_id: registry.world_id, revision: registry.revision, cells: registry.cells.map(cell => ({ cell_id: cell.cell_id, revision: cell.revision, assignment: cell.assignment,
        surface_index: cell.surface_index, force_index: cell.force_index, member_count: cell.members.length,
        location: recordedLocation(cell), commissioning: 'unverified' })) }
    },
    // Host-only provisional read. No assignment enters the registry and no
    // observation summary can turn this candidate into a commissioned cell.
    observePlacement: receiptId => guarded('observe_placement', async owner => {
      if (!runtime) fail('factory_world_unbound')
      const scope = runtime.scope(); const receipt = memory.factoryPlacementReceipt(receiptId)
      if (!receipt || ['world_id', 'goal_id', 'semantic_step_id', 'surface_index', 'force_index'].some(field => receipt[field] !== scope[field])) fail('factory_placement_unproven')
      const member = Object.fromEntries(['unit_number', 'name', 'position', 'surface_index', 'force_index'].map(field => [field, receipt[field]]))
      const request = { schema_version: 1, world_id: scope.world_id, actor_id: scope.actor_id, request_id: scope.request_id,
        surface_index: scope.surface_index, force_index: scope.force_index, members: [member] }
      const native = nativeBody(await callNative('observe', request))
      same(owner); runtime.assertScope(scope)
      if (native.schema_version !== 1 || native.ok !== true || ['world_id', 'actor_id', 'request_id', 'surface_index', 'force_index'].some(field => native[field] !== request[field])
        || !Number.isSafeInteger(native.tick) || native.tick < 0 || native.members?.length !== 1 || !identity(native.members[0]?.locator, member)) fail('factory_native_observation_members_mismatch')
      return native
    }),
    observeCandidate: (declaration, binding) => guarded('observe_candidate', async owner => {
      if (!runtime) fail('factory_world_unbound')
      const scope = runtime.scope()
      const registry = memory.getFactoryOperationalRegistry?.() ?? memory.getFactoryRegistry()
      const cell = registerFactoryCell(createFactoryRegistry(scope.world_id), declaration).cells[0]
      if (cell.members.length < 1 || cell.members.length > FACTORY_OBSERVATION_LIMITS.members || cell.surface_index !== scope.surface_index || cell.force_index !== scope.force_index) fail('factory_cell_scope_mismatch')
      const plan = getActivePlan(memory.planningState(key))
      const materialSupply = plan?.steps?.[plan.active_step_index]?.execution_guidance?.materialSupply
      if (binding) directFeed(cell, [], binding, materialSupply)
      const request = { schema_version: 1, world_id: scope.world_id, actor_id: scope.actor_id, request_id: scope.request_id,
        surface_index: scope.surface_index, force_index: scope.force_index, members: cell.members.map(({ provenance, ...member }) => member) }
      const native = nativeBody(await callNative('observe', request))
      same(owner); runtime.assertScope(scope)
      if (native.schema_version !== 1 || native.ok !== true) fail(token(native.code) ? native.code : 'factory_native_observation_refused')
      if (['world_id', 'actor_id', 'request_id', 'surface_index', 'force_index'].some(field => native[field] !== request[field])) fail('factory_native_observation_identity_mismatch')
      if (!Number.isSafeInteger(native.tick) || native.tick < 0 || !Array.isArray(native.members) || native.members.length !== cell.members.length
        || cell.members.some(member => native.members.filter(row => identity(row?.locator, member)).length !== 1)) fail('factory_native_observation_members_mismatch')
      return { ...validateFactoryCellObservation({ registry, cell, native, binding, materialSupply }), native }
    }),
    observe: ({ cell_id, binding } = {}) => guarded('observe', async owner => {
      if (!runtime) fail('factory_world_unbound')
      const scope = binding ? runtime.scope() : runtime.readScope()
      const registry = memory.getFactoryOperationalRegistry?.() ?? memory.getFactoryRegistry()
      const cell = registry.cells.find(row => row.cell_id === cell_id)
      if (!cell) fail('factory_cell_unknown')
      if (cell.surface_index !== scope.surface_index || cell.force_index !== scope.force_index) fail('factory_cell_scope_mismatch')
      if (cell.members.length > FACTORY_OBSERVATION_LIMITS.members) fail('factory_cell_observation_member_limit')
      const plan = getActivePlan(memory.planningState(key))
      const materialSupply = plan?.steps?.[plan.active_step_index]?.execution_guidance?.materialSupply
      // Validate a requested binding before native reads. Result is recomputed
      // against native evidence below; this call only rejects malformed claims.
      if (binding) directFeed(cell, [], binding, materialSupply)
      const request = { schema_version: 1, world_id: registry.world_id, actor_id: scope.actor_id,
        request_id: scope.request_id, surface_index: cell.surface_index, force_index: cell.force_index,
        members: cell.members.map(({ provenance, ...member }) => member) }
      emit('factory_cell.observation_started', { ...scope, session_id: owner.session_id, cell_id })
      const native = nativeBody(await callNative('observe', request))
      same(owner)
      if (binding) runtime.assertScope(scope)
      else runtime.assertReadScope(scope)
      if (native.schema_version !== 1 || native.ok !== true) fail(token(native.code) ? native.code : 'factory_native_observation_refused')
      if (['world_id', 'actor_id', 'request_id', 'surface_index', 'force_index'].some(field => native[field] !== request[field])) fail('factory_native_observation_identity_mismatch')
      if (!Number.isSafeInteger(native.tick) || native.tick < 0 || !Array.isArray(native.members) || native.members.length !== cell.members.length
        || cell.members.some(member => native.members.filter(row => identity(row?.locator, member)).length !== 1)) fail('factory_native_observation_members_mismatch')
      const result = validateFactoryCellObservation({ registry, cell, native, binding, materialSupply })
      if (binding) runtime.recordObservation({ cell_id, world_id: scope.world_id, registry_revision: scope.expected_revision,
        request_id: scope.request_id, session_id: owner.session_id, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch,
        tick: native.tick, state: result.state }, scope)
      const cache = binding ? { state: 'historical', reason: 'committed_binding_observation' }
        : { state: 'not_recorded', reason: 'read_only_observation' }
      emit('factory_cell.observation_completed', { ...scope, session_id: owner.session_id, cell_id, state: result.state, tick: native.tick, codes: result.checks.map(row => row.code) })
      return { schema_version: 1, cell_id, world_id: scope.world_id, registry_revision: scope.expected_revision,
        request_id: scope.request_id, session_id: owner.session_id, ...result, cache, native }
    }),
  })
}
