// Typed intent is authored before commitment. Native preservation facts are
// captured by the harness, never accepted from a model or reconstructed from an
// unmet checkpoint. This is also the certificate vocabulary for the approved
// contract-defect successor (not a world-change replacement).
import { createHash } from 'node:crypto'
import { authoredCompletionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'
import { operationSignature } from './operation-reconciliation.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
export const CONTRACT_DEFECT_REASON = 'contract_translation_defect'
export const CONTRACT_DEFECT_LIMIT = 1
export class PreservationProofError extends Error {
  constructor(code, { category = 'unproven', stage = 'capture' } = {}) {
    super(code)
    this.name = 'PreservationProofError'
    this.code = code
    this.category = category
    this.stage = stage
  }
}
export function preservationFailure(error) {
  return error instanceof PreservationProofError
    ? { code: error.code, category: error.category, stage: error.stage, pause_class: 'guard', retryable: false }
    : undefined
}
const unproven = code => { throw new PreservationProofError(code) }
const FLUID_TYPES = new Set(['offshore-pump', 'boiler', 'generator', 'pipe'])
const FLUID_PROTOTYPES = Object.freeze({ 'offshore-pump': 'offshore-pump', boiler: 'boiler', 'steam-engine': 'generator', pipe: 'pipe' })
const supportedFluid = entity => FLUID_PROTOTYPES[entity?.name] === entity?.type
const fluidFlows = new Set(['input', 'output', 'input-output'])
const fluidProduction = new Set([...fluidFlows, 'none'])
const finite = value => typeof value === 'number' && Number.isFinite(value)
const positiveIndex = value => Number.isSafeInteger(value) && value > 0 && value <= 16
export function obligationSignature(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function normalizeObligations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['outcome', 'preserve'].includes(key))) throw new Error('invalid_step_obligations')
  const outcome = sanitizeStepCompletionContract(raw.outcome)
  if (!authoredCompletionContractSupported(outcome) || outcome.mode !== 'all') throw new Error('obligation_outcome_requires_all_supported_predicates')
  if (!Array.isArray(raw.preserve) || raw.preserve.length > 8
    || raw.preserve.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(raw.preserve).size !== raw.preserve.length) throw new Error('obligation_preserve_requires_distinct_exact_identities')
  if (outcome.requirements.length + raw.preserve.length > 16) throw new Error('obligation_predicate_limit')
  return { outcome, preserve: [...raw.preserve].sort((a, b) => a - b) }
}
export function storedObligations(raw) {
  try { return normalizeObligations(raw) } catch { return undefined }
}
export function obligationContractContext(raw) {
  if (raw === undefined || raw === null) return undefined
  const typed = normalizeObligations(raw)
  return { expectedRequirements: [
    ...typed.outcome.requirements,
    ...typed.preserve.map(unit_number => ({ kind: 'entity_exists', unit_number })),
  ].map(({ id: _id, ...requirement }, index) => ({ ...requirement, id: `obligation_${index + 1}` })) }
}
export function compileObligations(raw) {
  const context = obligationContractContext(raw)
  return sanitizeStepCompletionContract({ mode: 'all', requirements: context.expectedRequirements }, context)
}

function predicates(contract, context) {
  const normalized = sanitizeStepCompletionContract(contract, context)
  return JSON.stringify({ mode: normalized.mode, requirements: normalized.requirements.map(({ id: _id, ...row }) => row)
    .map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
    .map(row => JSON.stringify(row)).sort() })
}
export function obligationContractMatches(contract, obligations) {
  try {
    const context = obligationContractContext(obligations)
    const expected = compileObligations(obligations)
    return predicates(contract, context) === predicates(expected, context)
      && sanitizeStepCompletionContract(contract, context).mode === 'all'
  } catch { return false }
}
// A draft checkpoint that states exactly the declared outcome leaves out only the entity_exists rows the harness derives
// from preserve, so its compiled contract is the same commitment. Any other difference is a real mismatch.
export function outcomeOnlyCheckpoint(contract, obligations) {
  try {
    const typed = normalizeObligations(obligations)
    return typed.preserve.length > 0 && sanitizeStepCompletionContract(contract).mode === 'all'
      && predicates(contract) === predicates(typed.outcome)
  } catch { return false }
}
export function contractDefectShape(step) {
  const typed = storedObligations(step?.obligations)
  const proof = normalizeObligationProof(step?.obligation_proof, typed)
  // Fluid authoring/projection is not a new automatic successor trigger.
  if (!typed || !proof || proof.version !== 1 || !typed.preserve.length || obligationContractMatches(step.completion_contract, typed)) return false
  const actual = sanitizeStepCompletionContract(step.completion_contract)
  if (actual.mode !== 'all') return false
  const rows = actual.requirements
  // The declared result cannot change. Only the bounded translation error
  // 'preservation became extra unscoped prototype counts' is certified here.
  if (!typed.outcome.requirements.every(row => rows.some(item => predicates({ mode: 'all', requirements: [row] }) === predicates({ mode: 'all', requirements: [item] })))) return false
  const extra = rows.filter(row => !typed.outcome.requirements.some(item => predicates({ mode: 'all', requirements: [row] }) === predicates({ mode: 'all', requirements: [item] })))
  return extra.length > 0 && extra.every(row => row.kind === 'entity_count' && row.anchor === undefined && row.radius === undefined
    && row.state === undefined && proof.preserved.some(item => item.entity.name === row.prototype))
}
function entityIdentity(raw) {
  if (!raw || !Number.isSafeInteger(raw.unit_number) || raw.unit_number < 1 || typeof raw.name !== 'string' || typeof raw.type !== 'string'
    || !Number.isSafeInteger(raw.direction) || raw.direction < 0 || raw.direction > 15
    || !Number.isFinite(raw.position?.x) || !Number.isFinite(raw.position?.y)) unproven('preservation_identity_unreadable')
  return { unit_number: raw.unit_number, name: raw.name, type: raw.type, position: { x: raw.position.x, y: raw.position.y },
    ...(raw.direction !== undefined ? { direction: raw.direction } : {}) }
}
function point(raw) {
  if (!Number.isFinite(raw?.x) || !Number.isFinite(raw?.y)) unproven('preservation_geometry_unreadable')
  return { x: raw.x, y: raw.y }
}
function fluidPrototype(raw) {
  if (!positiveIndex(raw?.index) || !fluidProduction.has(raw.production_type) || !finite(raw.volume) || raw.volume <= 0
    || raw.filter !== undefined && (typeof raw.filter !== 'string' || !raw.filter)
    || raw.minimum_temperature !== undefined && !finite(raw.minimum_temperature)
    || raw.maximum_temperature !== undefined && !finite(raw.maximum_temperature)) unproven('preservation_fluid_prototype_unproven')
  return { index: raw.index, production_type: raw.production_type, volume: raw.volume, filter: raw.filter ?? null,
    minimum_temperature: raw.minimum_temperature ?? null, maximum_temperature: raw.maximum_temperature ?? null }
}
function fluidPort(raw, scope, { stored = false } = {}) {
  const index = stored ? raw?.index : raw?.connection_index
  if (!positiveIndex(index) || raw.connection_type !== 'normal' || !fluidFlows.has(raw.flow_direction)
    || typeof raw.connected !== 'boolean' || (!stored && raw.target_valid !== true)) unproven('preservation_fluid_port_unproven')
  let target = null
  if (raw.connected) {
    const entity = entityIdentity(stored ? raw.target?.entity : raw.target)
    const surface = stored ? raw.target.surface_index : raw.target_surface_index
    const force = stored ? raw.target.force_index : raw.target_force_index
    const storage = stored ? raw.target.storage_index : raw.target_fluidbox_index
    const connection = stored ? raw.target.connection_index : raw.target_pipe_connection_index
    if (surface !== scope.surface_index || force !== scope.force_index || !positiveIndex(storage) || !positiveIndex(connection)) unproven('preservation_fluid_endpoint_unproven')
    target = { entity, surface_index: surface, force_index: force, storage_index: storage, connection_index: connection }
  } else if (raw.target !== undefined && raw.target !== null) unproven('preservation_fluid_open_port_contradiction')
  return { index, position: point(raw.position), target_position: point(raw.target_position),
    connection_type: raw.connection_type, flow_direction: raw.flow_direction, connected: raw.connected, target }
}
export function fluidPreservationGeometry(raw, scope, { stored = false } = {}) {
  const storages = stored ? raw?.storages : raw?.fluid_storages
  const count = stored ? storages?.length : raw?.fluid_box_count
  if ((stored ? raw?.version : raw?.fluid_geometry_version) !== 3 || !positiveIndex(count)
    || !Array.isArray(storages) || storages.length !== count
    || !stored && (raw.fluid_storages_truncated !== false || raw.non_fluidbox_storage_count !== 0)) unproven('preservation_fluid_geometry_incomplete')
  const projected = storages.map((storage, index) => {
    const prototypes = storage.prototypes
    const ports = stored ? storage.ports : storage.pipe_connections
    if (storage.index !== index + 1 || !finite(storage.local_volume) || storage.local_volume <= 0
      || !Array.isArray(prototypes) || !prototypes.length || prototypes.length > 16
      || !Array.isArray(ports) || !ports.length || ports.length > 16
      || !stored && (storage.pipe_connections_truncated !== false || storage.prototypes_truncated !== false)) unproven('preservation_fluid_storage_incomplete')
    const projected = { index: storage.index, local_volume: storage.local_volume,
      prototypes: prototypes.map(row => fluidPrototype(stored ? { ...row,
        filter: row.filter ?? undefined, minimum_temperature: row.minimum_temperature ?? undefined,
        maximum_temperature: row.maximum_temperature ?? undefined } : row)).sort((a, b) => a.index - b.index),
      ports: ports.map(row => fluidPort(row, scope, { stored })).sort((a, b) => a.index - b.index) }
    if (projected.local_volume !== projected.prototypes.reduce((total, row) => total + row.volume, 0)) unproven('preservation_local_volume_unproven')
    return projected
  })
  for (const storage of projected) {
    if (new Set(storage.prototypes.map(row => row.index)).size !== storage.prototypes.length
      || storage.ports.some((port, index) => port.index !== index + 1)) unproven('preservation_fluid_indices_incomplete')
  }
  return { version: 3, storages: projected }
}
// Geometry contains no changing fuel/output counters. Preserve engine-known
// item routes and reject unsupported fluid topology instead of guessing it.
export function preservationGeometry(raw, unitNumber) {
  if (raw?.found !== true || raw.entity?.unit_number !== unitNumber || raw.fluid_storages_truncated === true
    || !Number.isSafeInteger(raw.fluid_box_count) || raw.fluid_box_count !== 0
    || !Number.isSafeInteger(raw.surface_index) || !Number.isSafeInteger(raw.force_index)
    || !Number.isSafeInteger(raw.actor_id) || raw.actor_surface_index !== raw.surface_index
    || raw.actor_force_index !== raw.force_index) {
    // A complete supported fluid projection is validated below; missing facts
    // never borrow the old nonfluid zero-storage proof.
    if (!(raw?.found === true && raw.entity?.unit_number === unitNumber && FLUID_TYPES.has(raw.entity.type)
      && Number.isSafeInteger(raw.actor_id) && Number.isSafeInteger(raw.surface_index) && Number.isSafeInteger(raw.force_index)
      && raw.actor_surface_index === raw.surface_index && raw.actor_force_index === raw.force_index)) unproven('preservation_geometry_unproven')
  }
  const entity = entityIdentity(raw.entity)
  if (FLUID_TYPES.has(entity.type) && !supportedFluid(entity)) throw new PreservationProofError('preservation_fluid_prototype_unsupported', { category: 'unsupported' })
  if (FLUID_TYPES.has(entity.type)) return { entity, actor_id: raw.actor_id, surface_index: raw.surface_index,
    force_index: raw.force_index, fluid: fluidPreservationGeometry(raw, raw) }
  if (!['furnace', 'mining-drill', 'inserter'].includes(entity.type)) throw new PreservationProofError('preservation_type_unsupported', { category: 'unsupported' })
  let item_io
  if (['mining-drill', 'inserter'].includes(entity.type)) {
    if (!raw.item_io) unproven('preservation_item_route_unreadable')
    item_io = { drop_position: point(raw.item_io.drop_position),
      drop_target: raw.item_io.drop_target ? entityIdentity(raw.item_io.drop_target) : null }
    if (entity.type === 'inserter') Object.assign(item_io, { pickup_position: point(raw.item_io.pickup_position),
      pickup_target: raw.item_io.pickup_target ? entityIdentity(raw.item_io.pickup_target) : null })
  }
  return { entity, actor_id: raw.actor_id, surface_index: raw.surface_index, force_index: raw.force_index, ...(item_io ? { item_io } : {}) }
}
export function normalizeObligationProof(raw, obligations) {
  const typed = storedObligations(obligations)
  if (!typed || ![1, 2].includes(raw?.version) || raw.intent_signature !== obligationSignature(typed)
    || Object.keys(raw).some(key => !['version', 'intent_signature', 'actor_id', 'actor_epoch', 'request_id', 'captured_at', 'preserved', 'binding'].includes(key))
    || !Number.isSafeInteger(raw.actor_id) || !Number.isSafeInteger(raw.actor_epoch)
    || typeof raw.request_id !== 'string' || !raw.request_id || !Number.isFinite(raw.captured_at)
    || !Array.isArray(raw.preserved) || raw.preserved.length !== typed.preserve.length
    || raw.preserved.some((row, i) => row?.entity?.unit_number !== typed.preserve[i])) return undefined
  // Read-side normalization rejects malformed snapshots rather than blessing
  // a new baseline during restore. Capture is exclusively a runtime action.
  try {
    for (const row of raw.preserved) {
      entityIdentity(row.entity)
      if (!Number.isSafeInteger(row.surface_index) || !Number.isSafeInteger(row.force_index)) return undefined
      if (['mining-drill', 'inserter'].includes(row.entity.type) && !row.item_io) return undefined
      const normalized = row.fluid ? { entity: entityIdentity(row.entity), actor_id: row.actor_id,
        surface_index: row.surface_index, force_index: row.force_index, fluid: fluidPreservationGeometry(row.fluid, row, { stored: true }) }
        : preservationGeometry({ found: true, entity: row.entity, item_io: row.item_io, fluid_box_count: 0,
        actor_id: row.actor_id, surface_index: row.surface_index, force_index: row.force_index,
        actor_surface_index: row.surface_index, actor_force_index: row.force_index }, row.entity.unit_number)
      if (row.actor_id !== raw.actor_id || JSON.stringify(normalized) !== JSON.stringify(row)) return undefined
      if (row.fluid && !supportedFluid(row.entity) || !row.fluid && FLUID_TYPES.has(row.entity.type)) return undefined
    }
    if ((raw.preserved.some(row => row.fluid) ? 2 : 1) !== raw.version) return undefined
    return clone(raw)
  } catch { return undefined }
}

export function obligationProofOwned(proof, { goalId, semanticStepId } = {}) {
  const binding = proof?.binding
  return binding?.goal_id === goalId && binding?.semantic_step_id === semanticStepId
    && Object.keys(binding).every(key => ['goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id'].includes(key))
    && binding.step_id === semanticStepId && typeof binding.plan_id === 'string'
    && binding.plan_id.startsWith(`${goalId}_p`) && Number.isSafeInteger(binding.plan_version)
}

export function obligationProofOrigin(planning, step, { committingPlanId } = {}) {
  const proof = normalizeObligationProof(step?.obligation_proof, step?.obligations)
  const semantic = step?.semantic_step_id ?? step?.step_id
  if (!proof || !obligationProofOwned(proof, { goalId: planning?.goal?.goal_id, semanticStepId: semantic })) return false
  const origin = planning.plans?.find(row => row.plan_id === proof.binding.plan_id && row.plan_version === proof.binding.plan_version)
  const original = origin?.steps?.find(row => row.step_id === proof.binding.step_id)
  return !!original && origin.goal_id === planning.goal.goal_id
    && (origin.committed_at !== null && origin.committed_at !== undefined || origin.plan_id === committingPlanId)
    && JSON.stringify(original.obligations) === JSON.stringify(step.obligations)
    && JSON.stringify(original.obligation_proof) === JSON.stringify(proof)
}

export async function captureObligationProof(agent, obligations, fence) {
  const typed = normalizeObligations(obligations)
  await fence()
  const actor = await agent.assertCurrent()
  await fence()
  const preserved = []
  for (const id of typed.preserve) {
    let raw
    try { raw = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getEntityGeometry', { unit_number: id })))) }
    catch { await fence(); unproven('preservation_native_read_unavailable') }
    await fence()
    preserved.push(preservationGeometry(raw, id))
    if (raw.actor_id !== actor.actor_id || preserved.some(row => row.surface_index !== preserved[0].surface_index || row.force_index !== preserved[0].force_index)) unproven('preservation_native_scope_changed')
    // The exact identity was authoritatively refreshed, not copied from the
    // request's historical observation cache.
    agent.recordLiveEntityObservation?.(raw.entity)
  }
  const after = await agent.assertCurrent()
  await fence()
  if (actor.actor_id !== after.actor_id || actor.epoch !== after.epoch) unproven('preservation_actor_changed')
  return { version: preserved.some(row => row.fluid) ? 2 : 1, intent_signature: obligationSignature(typed), actor_id: actor.actor_id, actor_epoch: actor.epoch,
    request_id: agent.traceRequest?.id, captured_at: Date.now(), preserved }
}

export function preservedProofMatches(before, after, { addition } = {}) {
  if (before?.intent_signature !== after?.intent_signature || before?.actor_id !== after?.actor_id
    || before?.actor_epoch !== after?.actor_epoch || before?.preserved?.length !== after?.preserved?.length) return false
  const members = before.preserved.map(row => row.entity)
  const targetMatches = (old, current) => old ? JSON.stringify(old) === JSON.stringify(current)
    : !current || members.some(member => JSON.stringify(member) === JSON.stringify(current))
  return before.preserved.every((old, index) => {
    const current = after.preserved[index]
    const { item_io: oldIo, fluid: oldFluid, ...oldGeometry } = old
    const { item_io: currentIo, fluid: currentFluid, ...currentGeometry } = current
    if (JSON.stringify(oldGeometry) !== JSON.stringify(currentGeometry)) return false
    if (oldFluid || currentFluid) {
      if (!oldFluid || !currentFluid) return false
      const changed = structuredClone(currentFluid)
      for (const storage of changed.storages) for (const port of storage.ports) {
        const prior = oldFluid.storages.find(row => row.index === storage.index)?.ports.find(row => row.index === port.index)
        if (JSON.stringify(port) === JSON.stringify(prior)) continue
        if (!addition || old.entity.unit_number !== addition.source_unit_number
          || storage.index !== addition.source_storage_index || port.index !== addition.source_connection_index
          || prior?.connected !== false || port.connected !== true
          || JSON.stringify(port.target) !== JSON.stringify(addition.endpoint)) return false
        // Only the exact previously-open endpoint may gain the admitted object.
        port.connected = false; port.target = null
      }
      if (JSON.stringify(changed) !== JSON.stringify(oldFluid)) return false
    }
    if (!oldIo || !currentIo) return !oldIo && !currentIo
    return JSON.stringify(oldIo.drop_position) === JSON.stringify(currentIo.drop_position)
      && JSON.stringify(oldIo.pickup_position) === JSON.stringify(currentIo.pickup_position)
      && targetMatches(oldIo.drop_target, currentIo.drop_target) && targetMatches(oldIo.pickup_target, currentIo.pickup_target)
  })
}

const nativeOwnerFields = ['goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id', 'actor_id', 'actor_epoch', 'session']
function normalizeNativeOwner(raw) {
  if (!raw || Object.keys(raw).length !== 8 || nativeOwnerFields.some(key => !Object.hasOwn(raw, key))
    || ['goal_id', 'plan_id', 'step_id', 'semantic_step_id', 'session'].some(key => typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 240)
    || ['plan_version', 'actor_id', 'actor_epoch'].some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 1)) return undefined
  return Object.fromEntries(nativeOwnerFields.map(key => [key, raw[key]]))
}
function nativeOwnerMatches(left, right) {
  return normalizeNativeOwner(left) && normalizeNativeOwner(right)
    && nativeOwnerFields.every(key => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key])
}
export function normalizeFluidReceiptBinding(raw) {
  const keys = ['operation_key', 'attempt_id', 'signature', 'ordinal', 'owner', 'batch_id', 'batch_generation', 'batch_ref']
  const owner = normalizeNativeOwner(raw?.owner)
  if (!raw || !owner || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))
    || typeof raw.operation_key !== 'string' || !raw.operation_key || raw.operation_key.length > 192
    || typeof raw.attempt_id !== 'string' || !raw.attempt_id || raw.attempt_id.length > 128
    || typeof raw.signature !== 'string' || !/^[a-f0-9]{64}$/.test(raw.signature)
    || ['ordinal', 'batch_id', 'batch_generation'].some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 1)
    || raw.batch_ref !== `batch-g${raw.batch_generation}-${raw.batch_id}`) return undefined
  return { operation_key: raw.operation_key, attempt_id: raw.attempt_id, signature: raw.signature, ordinal: raw.ordinal,
    owner, batch_id: raw.batch_id, batch_generation: raw.batch_generation, batch_ref: raw.batch_ref }
}
// Allowed-empty native wire sequences have exactly one known representation in
// JSON: [] or Factorio's plain {}. Missing and exotic values are not emptiness.
export function isNativeEmptyPreservationSequence(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return Object.getPrototypeOf(value) === Array.prototype
    && value.length === 0 && Reflect.ownKeys(value).length === 1
  return Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === 0
}
function fluidAdmissionUnchecked(raw, plan, step) {
  const proof = normalizeObligationProof(raw?.baseline, step?.obligations)
  const owner = raw?.owner
  const candidate = raw?.candidate
  const operation = raw?.operation
  // Factorio's JSON serializer emits an empty Lua sequence as {}. Only this
  // exact empty native shape or an empty array proves the no-clearing field;
  // absent, nonempty and malformed values remain unknown/refused.
  const clears = candidate?.clears
  const noClears = isNativeEmptyPreservationSequence(clears)
  if (raw?.version !== 2 || !proof || proof.version !== 2 || !owner || !candidate
    || JSON.stringify(proof.binding) !== JSON.stringify(step.obligation_proof.binding)
    || owner.goal_id !== plan.goal_id || owner.plan_id !== plan.plan_id || owner.plan_version !== plan.plan_version
    || owner.step_id !== step.step_id || owner.semantic_step_id !== (step.semantic_step_id ?? step.step_id)
    || owner.actor_id !== proof.actor_id || owner.actor_epoch !== proof.actor_epoch
    || typeof raw.operation_key !== 'string' || !raw.operation_key || typeof raw.request_id !== 'string' || !raw.request_id
    || typeof raw.attempt_id !== 'string' || !raw.attempt_id || !Number.isSafeInteger(raw.ordinal) || raw.ordinal < 1
    || typeof raw.board_step_id !== 'string' || !raw.board_step_id
    || !finite(raw.created_at) || raw.native_idle !== true || !Number.isSafeInteger(raw.native_generation) || raw.native_generation < 1
    || !Number.isSafeInteger(raw.native_max_batch_id) || raw.native_max_batch_id < 0
    || operation?.name !== 'place_candidate' || raw.signature !== operationSignature([operation])
    || operation.args?.candidate_set_id !== candidate.candidate_set_id || operation.args?.candidate_id !== candidate.candidate_id
    || candidate.version !== 4 || candidate.operation_key !== raw.operation_key || candidate.signature !== raw.signature
    || candidate.native_baseline?.generation !== raw.native_generation || candidate.native_baseline.max_batch_id !== raw.native_max_batch_id
    || typeof candidate.owner?.session !== 'string' || !candidate.owner.session || candidate.owner.session.length > 240
    || !nativeOwnerMatches(candidate.owner, { ...owner, session: candidate.owner.session })
    || candidate.complete !== true || candidate.actor_id !== owner.actor_id
    || !Number.isSafeInteger(candidate.tick) || !Number.isSafeInteger(candidate.generated_tick)
    || candidate.tick < candidate.generated_tick || candidate.tick - candidate.generated_tick > 3600
    || !supportedFluid({ name: candidate.entity_name, type: candidate.entity_type })
    || !noClears
    || !Array.isArray(candidate.candidate_ports) || !candidate.candidate_ports.length || candidate.candidate_ports.length > 16
    || !Array.isArray(candidate.candidate_storages) || !candidate.candidate_storages.length || candidate.candidate_storages.length > 16) return undefined
  const proposedStorages = candidate.candidate_storages.map(fluidPrototype)
  if (!Array.isArray(candidate.protected_geometry) || candidate.protected_geometry.length > 16
    || candidate.protected_geometry.length < proof.preserved.length) return undefined
  const closure = candidate.protected_geometry.map(row => preservationGeometry(row, row.entity?.unit_number))
  if (new Set(closure.map(row => row.entity.unit_number)).size !== closure.length
    || proof.preserved.some(row => JSON.stringify(row) !== JSON.stringify(closure.find(item => item.entity.unit_number === row.entity.unit_number)))
    || closure.some(row => row.actor_id !== proof.actor_id || row.fluid?.storages.some(storage => storage.ports.some(port =>
      port.connected && !closure.some(endpoint => JSON.stringify(endpoint.entity) === JSON.stringify(port.target.entity)
        && endpoint.surface_index === port.target.surface_index && endpoint.force_index === port.target.force_index))))) return undefined
  if (proposedStorages.some((row, i) => row.index !== i + 1)
    || candidate.candidate_ports.some(row => !positiveIndex(row.storage_index) || !positiveIndex(row.connection_index)
      || !proposedStorages.some(storage => storage.index === row.storage_index)
      || proposedStorages.some(storage => storage.index === row.storage_index
        && (storage.production_type !== row.production_type || storage.filter !== (row.filter ?? null)))
      || row.connection_type !== 'normal' || !fluidFlows.has(row.flow_direction)
      || !finite(row.position?.x) || !finite(row.position?.y) || ![0, 4, 8, 12].includes(row.direction))
    || new Set(candidate.candidate_ports.map(row => `${row.storage_index}/${row.connection_index}`)).size !== candidate.candidate_ports.length) return undefined
  const join = candidate.connects_to
  const source = proof.preserved.find(row => row.entity.unit_number === join?.unit_number)
  const storage = source?.fluid?.storages.find(row => row.index === join.target_port?.storage_index)
  const port = storage?.ports.find(row => row.index === join.target_port?.connection_index)
  const own = candidate.candidate_ports.find(row => row.storage_index === join.candidate_port?.storage_index
    && row.connection_index === join.candidate_port?.connection_index)
  const ownStorage = own && proposedStorages.find(row => row.index === own.storage_index)
  if (!source || !port || port.connected !== false || source.entity.name !== join.entity_name || !own
    || candidate.surface_index !== source.surface_index || candidate.force_index !== source.force_index
    || !positiveIndex(own.storage_index) || !positiveIndex(own.connection_index)
    || own.connection_type !== 'normal' || !fluidFlows.has(own.flow_direction)
    || !finite(candidate.position?.x) || !finite(candidate.position?.y)
    || !Number.isSafeInteger(candidate.direction) || ![0, 4, 8, 12].includes(candidate.direction)
    || own.position?.x !== port.target_position.x || own.position?.y !== port.target_position.y
    || own.position?.x !== join.tile?.x || own.position?.y !== join.tile?.y
    || ![0, 4, 8, 12].includes(own.direction)
    || own.position.x + ({ 0: 0, 4: 1, 8: 0, 12: -1 })[own.direction] !== port.position.x
    || own.position.y + ({ 0: -1, 4: 0, 8: 1, 12: 0 })[own.direction] !== port.position.y
    || port.flow_direction === own.flow_direction && ['input', 'output'].includes(port.flow_direction)
    || !ownStorage || storage.prototypes.some(row => row.filter !== null && ownStorage.filter !== null && row.filter !== ownStorage.filter
      || row.minimum_temperature !== null && ownStorage.maximum_temperature !== null && row.minimum_temperature > ownStorage.maximum_temperature
      || row.maximum_temperature !== null && ownStorage.minimum_temperature !== null && row.maximum_temperature < ownStorage.minimum_temperature)
    || !step.obligations.outcome.requirements.some(row => row.kind === 'entity_count' && row.prototype === candidate.entity_name
      && (!row.anchor || Math.hypot(candidate.position.x - row.anchor.x, candidate.position.y - row.anchor.y) <= row.radius))) return undefined
  return clone({ ...raw, candidate: { ...candidate, clears: [] } })
}
export function normalizeFluidAdmission(raw, plan, step) {
  try { return fluidAdmissionUnchecked(raw, plan, step) } catch { return undefined }
}
export function fluidAdditionProof(envelope, receipt, built, fresh, plan, step) {
  const witness = normalizeFluidAdmission(envelope, plan, step)
  if (!witness || !normalizeObligationProof(fresh, step.obligations)) return undefined
  const basic = receipt?.basic_operation
  const admitted = receipt?.admitted_batch
  const candidate = witness.candidate
  const binding = normalizeFluidReceiptBinding(basic?.preservation_binding)
  if (receipt.outcome !== 'completed' || receipt.task_state !== 'idle' || receipt.queue_length !== 0
    || basic?.type !== 'placing' || basic.accepted !== true || basic.completed !== true || basic.code !== 'completed'
    || basic.actor_id !== witness.owner.actor_id || basic.entity_name !== candidate.entity_name
    || binding?.operation_key !== witness.operation_key || binding.signature !== witness.signature || binding.attempt_id !== witness.attempt_id
    || binding.ordinal !== witness.ordinal || !nativeOwnerMatches(binding.owner, candidate.owner)
    || binding.batch_id !== receipt.batch_id || binding.batch_generation !== receipt.batch_generation
    || binding.batch_ref !== `batch-g${receipt.batch_generation}-${receipt.batch_id}`
    || basic.placed_surface_index !== candidate.surface_index || basic.placed_direction !== candidate.direction
    || basic.placed_position?.x !== candidate.position.x || basic.placed_position?.y !== candidate.position.y
    || !Number.isSafeInteger(basic.placed_unit_number) || step.obligations.preserve.includes(basic.placed_unit_number)
    || admitted?.operation_key !== witness.operation_key || admitted.signature !== witness.signature
    || admitted.goal_id !== plan.goal_id || admitted.plan_id !== plan.plan_id || admitted.step_id !== step.step_id
    || admitted.actor_id !== witness.owner.actor_id || admitted.actor_epoch !== witness.owner.actor_epoch
    || receipt.correlation?.goal_id !== plan.goal_id || receipt.correlation.actor_id !== witness.owner.actor_id
    || receipt.correlation.actor_epoch !== witness.owner.actor_epoch || receipt.correlation.step_id !== witness.board_step_id
    || receipt.batch_generation !== witness.native_generation || admitted.batch_generation !== receipt.batch_generation
    || admitted.batch_id !== receipt.batch_id || receipt.batch_id <= witness.native_max_batch_id
    || !Number.isSafeInteger(basic.tick) || basic.tick < candidate.tick
    || fresh.captured_at < witness.created_at || built?.entity?.unit_number !== basic.placed_unit_number
    || built.entity.name !== candidate.entity_name || built.entity.type !== candidate.entity_type
    || built.entity.direction !== candidate.direction || built.entity.position.x !== candidate.position.x || built.entity.position.y !== candidate.position.y
    || built.surface_index !== candidate.surface_index || built.force_index !== candidate.force_index || built.actor_id !== witness.owner.actor_id) return undefined
  const join = candidate.connects_to
  const reciprocal = built.fluid?.storages.find(row => row.index === join.candidate_port.storage_index)?.ports.find(row => row.index === join.candidate_port.connection_index)
  const source = witness.baseline.preserved.find(row => row.entity.unit_number === join.unit_number)
  const endpoint = { entity: built.entity, surface_index: built.surface_index, force_index: built.force_index,
    storage_index: join.candidate_port.storage_index, connection_index: join.candidate_port.connection_index }
  const addition = { source_unit_number: join.unit_number, source_storage_index: join.target_port.storage_index,
    source_connection_index: join.target_port.connection_index, endpoint }
  const expectedReciprocal = { entity: source.entity, surface_index: source.surface_index, force_index: source.force_index,
    storage_index: addition.source_storage_index, connection_index: addition.source_connection_index }
  const sourcePort = source.fluid.storages.find(row => row.index === addition.source_storage_index).ports.find(row => row.index === addition.source_connection_index)
  if (!reciprocal?.connected || JSON.stringify(reciprocal.target) !== JSON.stringify(expectedReciprocal)
    || JSON.stringify(reciprocal.target_position) !== JSON.stringify(sourcePort.position)
    || !preservedProofMatches(witness.baseline, fresh, { addition })) return undefined
  // The created object cannot silently join a second existing structure.
  const targets = built.fluid.storages.flatMap(row => row.ports).filter(row => row.connected)
  if (targets.length !== 1) return undefined
  const ports = built.fluid.storages.flatMap(storage => storage.ports.map(port => ({ ...port, storage_index: storage.index })))
  const expectedStorages = candidate.candidate_storages.map(fluidPrototype)
  if (built.fluid.storages.length !== expectedStorages.length || built.fluid.storages.some(storage =>
    storage.prototypes.length !== 1 || JSON.stringify(storage.prototypes[0]) !== JSON.stringify(expectedStorages.find(row => row.index === storage.index)))) return undefined
  if (ports.length !== candidate.candidate_ports.length || candidate.candidate_ports.some(proposed => !ports.some(port =>
    port.storage_index === proposed.storage_index && port.index === proposed.connection_index
    && port.position.x === proposed.position.x && port.position.y === proposed.position.y
    && port.flow_direction === proposed.flow_direction && port.connection_type === proposed.connection_type))) return undefined
  return addition
}

export function effectivePreservationProof(plan, step, { plans = [plan] } = {}) {
  const baseline = normalizeObligationProof(step?.obligation_proof, step?.obligations)
  if (!baseline) return undefined
  if (plan.execution?.preservation_proofs?.invalid === true) return undefined
  if (plan.execution?.preservation_admissions?.invalid === true) return undefined
  let current = inheritedFluidProof(plan, step, baseline, plans)
  if (!current) return undefined
  const certificates = plan.execution?.preservation_certificates ?? []
  if (!Array.isArray(certificates) || certificates.length > 64 || certificates.some(row => row?.invalid === true)) return undefined
  const seen = new Set()
  for (const certificate of certificates) {
    if (certificate?.step_id !== step.step_id) continue
    if (seen.has(certificate.admission_key)) return undefined
    seen.add(certificate.admission_key)
    const admission = normalizeFluidAdmission(plan.execution?.preservation_admissions?.[certificate.admission_key], plan, step)
    const proved = normalizeFluidCertificate(certificate, plan, step)
    if (!admission || !proved || !preservedProofMatches(current, admission.baseline)) return undefined
    current = proved.proof
  }
  const raw = plan.execution?.preservation_proofs?.[step.semantic_step_id ?? step.step_id]
  if (raw === undefined) return current
  const held = normalizeObligationProof(raw, step.obligations)
  return held && JSON.stringify(held.binding) === JSON.stringify(baseline.binding)
    && preservedProofMatches(current, held) ? held : undefined
}

function inheritedFluidProof(plan, step, baseline, plans) {
  if (baseline.version !== 2) return baseline
  const current = clone(baseline)
  const targetIndex = plan.steps.findIndex(row => row.step_id === step.step_id)
  if (targetIndex > plan.active_step_index) return current
  const prefix = new Set(plan.carried_forward_evidence ?? [])
  const eligible = []
  const seen = new Set()
  for (const origin of plans) {
    if (!Array.isArray(origin.execution?.preservation_certificates ?? [])) return undefined
    for (const raw of origin.execution?.preservation_certificates ?? []) {
    if (raw?.step_id === step.step_id && origin.plan_id === plan.plan_id) continue
    const previousIndex = origin.steps.findIndex(row => row.step_id === raw.step_id)
    const previous = origin.steps[previousIndex]
    if (!previous || origin.goal_id !== plan.goal_id || raw.proof?.actor_id !== baseline.actor_id || raw.proof?.actor_epoch !== baseline.actor_epoch
      || origin.execution.step_progress?.[previous.step_id]?.status !== 'completed'
      || origin.execution.step_progress[previous.step_id].contract_satisfied !== true
      || !(origin.plan_id === plan.plan_id && previousIndex < targetIndex || prefix.has(`${origin.plan_id}:${previous.step_id}`))
      || raw.proof?.captured_at <= baseline.captured_at) continue
    const key = `${origin.plan_id}/${raw.admission_key}`
    if (seen.has(key)) continue
    seen.add(key)
    eligible.push({ origin, previous, raw })
    }
  }
  eligible.sort((a, b) => a.raw.certified_at - b.raw.certified_at || a.raw.admission_key.localeCompare(b.raw.admission_key))
  for (const { origin, previous, raw } of eligible) {
    const certificate = normalizeFluidCertificate(raw, origin, previous)
    if (!certificate) return undefined
    const admission = origin.execution.preservation_admissions[raw.admission_key]
    const addition = fluidAdditionProof(admission, raw.receipt, raw.built, raw.proof, origin, previous)
    const row = current.preserved.find(row => row.entity.unit_number === addition.source_unit_number)
    if (!row) continue
    const old = admission.baseline.preserved.find(item => item.entity.unit_number === row.entity.unit_number)
    const port = row.fluid?.storages.find(item => item.index === addition.source_storage_index)?.ports.find(item => item.index === addition.source_connection_index)
    if (!port) return undefined
    if (port.connected && JSON.stringify(port.target) === JSON.stringify(addition.endpoint)) continue
    // Future declarations captured before the predecessor's authorized build
    // inherit only its verified additive fact. They gain no new admission right.
    if (JSON.stringify(row) !== JSON.stringify(old) || port.connected) return undefined
    port.connected = true; port.target = clone(addition.endpoint)
    current.captured_at = Math.max(current.captured_at, raw.proof.captured_at)
  }
  return current
}

export function normalizeFluidCertificate(raw, plan, step, { seal = false, requireLive = false } = {}) {
  try {
    const admission = normalizeFluidAdmission(plan.execution?.preservation_admissions?.[raw?.admission_key], plan, step)
    const proof = normalizeObligationProof(raw?.proof, step.obligations)
    const built = raw?.built
    if (!admission || !proof || raw.step_id !== step.step_id || !finite(raw.certified_at)
      || raw.certified_at < proof.captured_at || JSON.stringify(proof.binding) !== JSON.stringify(step.obligation_proof.binding)
      || !FLUID_TYPES.has(built?.entity?.type) || built.actor_id !== proof.actor_id
      || JSON.stringify(fluidPreservationGeometry(built.fluid, built, { stored: true })) !== JSON.stringify(built.fluid)
      || !fluidAdditionProof(admission, raw.receipt, built, proof, plan, step)) return undefined
    const ledger = plan.execution.receipts?.[step.step_id] ?? []
    const receipt = row => row?.kind === 'operation_receipt' && row.source === 'runtime' && row.ref === raw.ref
    const verification = row => row?.kind === 'deterministic_verification' && row.source === 'runtime'
      && row.ref === `batch_${raw.receipt.batch_id}` && row.verified_operation_names?.length === 1
      && row.verified_operation_names[0] === 'place_candidate'
    const liveReceipt = ledger.find(receipt); const liveVerification = ledger.find(verification)
    const owner = { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id,
      operation_key: admission.operation_key, signature: admission.signature }
    const dependencies = seal && liveReceipt && liveVerification
      ? { version: 1, owner, receipt: clone(liveReceipt), verification: clone(liveVerification) }
      : raw.authority_dependencies
    if (!dependencies || dependencies.version !== 1 || JSON.stringify(dependencies.owner) !== JSON.stringify(owner)
      || !receipt(dependencies.receipt) || !verification(dependencies.verification)
      || requireLive && (!liveReceipt || !liveVerification
        || JSON.stringify(dependencies.receipt) !== JSON.stringify(liveReceipt)
        || JSON.stringify(dependencies.verification) !== JSON.stringify(liveVerification))) return undefined
    // These two bounded dependencies are sealed at runtime certification, before
    // ordinary prompt/history receipt retention can trim its rolling window.
    return { ...clone(raw), authority_dependencies: clone(dependencies) }
  } catch { return undefined }
}
