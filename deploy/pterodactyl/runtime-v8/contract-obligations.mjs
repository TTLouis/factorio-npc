// Typed intent is authored before commitment. Native preservation facts are
// captured by the harness, never accepted from a model or reconstructed from an
// unmet checkpoint. This is also the certificate vocabulary for the approved
// contract-defect successor (not a world-change replacement).
import { createHash } from 'node:crypto'
import { authoredCompletionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
export const CONTRACT_DEFECT_REASON = 'contract_translation_defect'
export const CONTRACT_DEFECT_LIMIT = 1
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
export function compileObligations(raw) {
  const typed = normalizeObligations(raw)
  return sanitizeStepCompletionContract({ mode: 'all', requirements: [
    ...typed.outcome.requirements,
    ...typed.preserve.map(unit_number => ({ kind: 'entity_exists', unit_number })),
  ].map(({ id: _id, ...requirement }, index) => ({ ...requirement, id: `obligation_${index + 1}` })) })
}
function predicates(contract) {
  const normalized = sanitizeStepCompletionContract(contract)
  return JSON.stringify({ mode: normalized.mode, requirements: normalized.requirements.map(({ id: _id, ...row }) => row)
    .map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
    .map(row => JSON.stringify(row)).sort() })
}
export function obligationContractMatches(contract, obligations) {
  try { return predicates(contract) === predicates(compileObligations(obligations)) } catch { return false }
}
export function contractDefectShape(step) {
  const typed = storedObligations(step?.obligations)
  const proof = normalizeObligationProof(step?.obligation_proof, typed)
  if (!typed || !proof || !typed.preserve.length || obligationContractMatches(step.completion_contract, typed)) return false
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
    || !Number.isFinite(raw.position?.x) || !Number.isFinite(raw.position?.y)) throw new Error('preservation_identity_unreadable')
  return { unit_number: raw.unit_number, name: raw.name, type: raw.type, position: { x: raw.position.x, y: raw.position.y },
    ...(raw.direction !== undefined ? { direction: raw.direction } : {}) }
}
function point(raw) {
  if (!Number.isFinite(raw?.x) || !Number.isFinite(raw?.y)) throw new Error('preservation_geometry_unreadable')
  return { x: raw.x, y: raw.y }
}
// Geometry contains no changing fuel/output counters. Preserve engine-known
// item routes and reject unsupported fluid topology instead of guessing it.
export function preservationGeometry(raw, unitNumber) {
  if (raw?.found !== true || raw.entity?.unit_number !== unitNumber || raw.fluid_storages_truncated === true
    || !Number.isSafeInteger(raw.fluid_box_count) || raw.fluid_box_count !== 0
    || !Number.isSafeInteger(raw.surface_index) || !Number.isSafeInteger(raw.force_index)
    || !Number.isSafeInteger(raw.actor_id) || raw.actor_surface_index !== raw.surface_index
    || raw.actor_force_index !== raw.force_index) throw new Error('preservation_geometry_unproven')
  const entity = entityIdentity(raw.entity)
  if (!['furnace', 'mining-drill', 'inserter'].includes(entity.type)) throw new Error('preservation_type_unsupported')
  let item_io
  if (['mining-drill', 'inserter'].includes(entity.type)) {
    if (!raw.item_io) throw new Error('preservation_item_route_unreadable')
    item_io = { drop_position: point(raw.item_io.drop_position),
      drop_target: raw.item_io.drop_target ? entityIdentity(raw.item_io.drop_target) : null }
    if (entity.type === 'inserter') Object.assign(item_io, { pickup_position: point(raw.item_io.pickup_position),
      pickup_target: raw.item_io.pickup_target ? entityIdentity(raw.item_io.pickup_target) : null })
  }
  return { entity, actor_id: raw.actor_id, surface_index: raw.surface_index, force_index: raw.force_index, ...(item_io ? { item_io } : {}) }
}
export function normalizeObligationProof(raw, obligations) {
  const typed = storedObligations(obligations)
  if (!typed || raw?.version !== 1 || raw.intent_signature !== obligationSignature(typed)
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
      const normalized = preservationGeometry({ found: true, entity: row.entity, item_io: row.item_io, fluid_box_count: 0,
        actor_id: row.actor_id, surface_index: row.surface_index, force_index: row.force_index,
        actor_surface_index: row.surface_index, actor_force_index: row.force_index }, row.entity.unit_number)
      if (row.actor_id !== raw.actor_id || JSON.stringify(normalized) !== JSON.stringify(row)) return undefined
    }
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
    const raw = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getEntityGeometry', { unit_number: id }))))
    await fence()
    preserved.push(preservationGeometry(raw, id))
    if (raw.actor_id !== actor.actor_id || preserved.some(row => row.surface_index !== preserved[0].surface_index || row.force_index !== preserved[0].force_index)) throw new Error('preservation_native_scope_changed')
    // The exact identity was authoritatively refreshed, not copied from the
    // request's historical observation cache.
    agent.recordLiveEntityObservation?.(raw.entity)
  }
  const after = await agent.assertCurrent()
  await fence()
  if (actor.actor_id !== after.actor_id || actor.epoch !== after.epoch) throw new Error('preservation_actor_changed')
  return { version: 1, intent_signature: obligationSignature(typed), actor_id: actor.actor_id, actor_epoch: actor.epoch,
    request_id: agent.traceRequest?.id, captured_at: Date.now(), preserved }
}

export function preservedProofMatches(before, after) {
  if (before?.intent_signature !== after?.intent_signature || before?.actor_id !== after?.actor_id
    || before?.actor_epoch !== after?.actor_epoch || before?.preserved?.length !== after?.preserved?.length) return false
  const members = before.preserved.map(row => row.entity)
  const targetMatches = (old, current) => old ? JSON.stringify(old) === JSON.stringify(current)
    : !current || members.some(member => JSON.stringify(member) === JSON.stringify(current))
  return before.preserved.every((old, index) => {
    const current = after.preserved[index]
    const { item_io: oldIo, ...oldGeometry } = old
    const { item_io: currentIo, ...currentGeometry } = current
    if (JSON.stringify(oldGeometry) !== JSON.stringify(currentGeometry)) return false
    if (!oldIo || !currentIo) return !oldIo && !currentIo
    return JSON.stringify(oldIo.drop_position) === JSON.stringify(currentIo.drop_position)
      && JSON.stringify(oldIo.pickup_position) === JSON.stringify(currentIo.pickup_position)
      && targetMatches(oldIo.drop_target, currentIo.drop_target) && targetMatches(oldIo.pickup_target, currentIo.pickup_target)
  })
}

export function effectivePreservationProof(plan, step) {
  const baseline = normalizeObligationProof(step?.obligation_proof, step?.obligations)
  if (!baseline) return undefined
  if (plan.execution?.preservation_proofs?.invalid === true) return undefined
  const raw = plan.execution?.preservation_proofs?.[step.semantic_step_id ?? step.step_id]
  if (raw === undefined) return baseline
  const held = normalizeObligationProof(raw, step.obligations)
  return held && JSON.stringify(held.binding) === JSON.stringify(baseline.binding)
    && preservedProofMatches(baseline, held) ? held : undefined
}
