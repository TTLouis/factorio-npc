import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { obligationProofOrigin, normalizeObligationProof, PreservationProofError } from './contract-obligations.mjs'
import { claimControllerRecovery } from './controller-liveness.mjs'
import { authorizationOf, checkGrant } from './authorization.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { operationSignature, unresolvedNativeAdmissions } from './operation-reconciliation.mjs'

// The only exemption is an internally held, exact, same-owner navigation batch.
// It cannot complete a checkpoint or authorize any production/world modification.
const admissions = new WeakMap()
export function preservationObservationAdmission(agent, operations) {
  const held = admissions.get(agent)
  if (held && (agent.epoch?.actor_id !== held.actor.actor_id || agent.epoch?.epoch !== held.actor.epoch || agent.epoch?.surface_index !== held.actor.surface_index)) return false
  return !!held && agent.checkpointOwnerCurrent(held.owner)
    && !agent.currentPendingAmendment() && operationSignature(operations) === held.signature
}
export function restorePreservationRecoveries(raw) {
  const records = new Map()
  let fault = raw !== undefined && (!Array.isArray(raw) || raw.length > 128)
  for (const row of Array.isArray(raw) ? raw : []) {
    let fields
    try { fields = JSON.parse(row?.[0]) } catch {}
    if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(fields) || fields.length !== 3
      || fields.some(v => typeof v !== 'string' || !v || v.length > 240)
      || records.has(row[0]) || !Number.isFinite(row[1]?.claimed_at)
      || !['claimed', 'admitted', 'verified'].includes(row[1]?.state)) { fault = true; continue }
    records.set(row[0], { claimed_at: row[1].claimed_at, state: row[1].state })
  }
  return { records, fault }
}

export async function recoverPreservationVisibility(agent, error, { trigger = 'settlement' } = {}) {
  if (error?.code !== 'preservation_entity_not_visible' || admissions.has(agent)) return undefined
  const owner = agent.captureCheckpointOwner()
  const planning = agent.memory.planningState(owner.key)
  const plan = getActivePlan(planning)
  const step = plan?.steps?.[plan.active_step_index]
  const proof = normalizeObligationProof(step?.obligation_proof, step?.obligations)
  if (!proof || !obligationProofOrigin(planning, step) || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status)) return undefined
  const actor = { ...agent.epoch }
  const expectedScope = proof.preserved[0]
  const semantic = step.semantic_step_id ?? step.step_id
  const key = JSON.stringify([owner.key, owner.goalId, semantic])
  let grant
  const grantFence = () => {
    if (!grant) return
    const current = agent.memory.planningState(owner.key)
    const live = agent.memory.currentGoalGrant?.(owner.key)
    if (!live?.permitted_scope?.includes('recovery') || !checkGrant(authorizationOf(current), current?.goal,
      { grant_id: grant.grant_id, grant_revision: grant.revision, actor_id: actor.actor_id, actor_epoch: actor.epoch }).ok) {
      throw new PreservationProofError('preservation_recovery_authority_changed', { stage: 'recovery' })
    }
  }
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    grantFence()
    if (agent.currentPendingAmendment() || agent.memory.pauseRecord?.(owner.key)?.paused
      || agent.epoch.actor_id !== actor.actor_id || agent.epoch.epoch !== actor.epoch
      || agent.epoch.surface_index !== actor.surface_index) throw new Error('preservation_recovery_owner_changed')
    const body = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getActorStatus', {}))))
    agent.assertCheckpointOwnerIdentity(owner)
    grantFence()
    if (agent.currentPendingAmendment()) throw new Error('preservation_recovery_owner_changed')
    if (body.actor?.actor_id !== actor.actor_id || body.surface_index !== expectedScope.surface_index
      || body.force_index !== expectedScope.force_index) throw new PreservationProofError('preservation_recovery_body_scope_changed', { stage: 'recovery' })
  }
  const checked = async promise => { const result = await promise; await fence(); return result }
  const emit = (event, reason) => checked(agent.traceEvent(`contract.preservation_${event}`, {
    request_id: owner.requestTrace?.id, goal_id: owner.goalId, plan_id: owner.planId, plan_version: owner.planVersion,
    step_id: owner.stepId, semantic_step_id: semantic, actor_id: actor.actor_id, actor_epoch: actor.epoch,
    trigger, reason, detail: error.detail, mechanism: 'native_return_and_reobserve',
  }))
  const pause = async reason => {
    await emit('recovery_exhausted', reason)
    return agent.pauseForStepContract({ reason, owner })
  }
  await fence()
  grant = agent.memory.currentGoalGrant?.(owner.key)
  if (!grant?.permitted_scope?.includes('recovery')) return pause('preservation_recovery_grant_required')
  grantFence()
  if (agent.batchInFlight || agent.memory.pendingOperation?.(owner.key)
    || agent.memory.currentPlan(owner.key)?.condition_wait || agent.memory.currentPlan(owner.key)?.persistent_runtime?.active) return pause('preservation_recovery_unsettled')
  const status = JSON.parse(String(await checked(agent.readTaskStatusRaw())))
  const journal = nativeAdmissionJournal(status.admission_journal)
  const records = [...(planning.operation_ledger?.records ?? []), ...(planning.operation_ledger?.closed ?? [])]
  if (status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch
    || !journal.known || unresolvedNativeAdmissions(status, records, actor).length) return pause('preservation_recovery_native_unsettled')
  const body = JSON.parse(String(await checked(agent.rcon.command(agent.observationToolCommand('getActorStatus', {})))))
  if (body.actor?.actor_id !== actor.actor_id || body.surface_index !== proof.preserved[0]?.surface_index
    || body.force_index !== proof.preserved[0]?.force_index || proof.actor_id !== actor.actor_id || proof.actor_epoch !== actor.epoch) return pause('preservation_recovery_scope_changed')
  const crafting = JSON.parse(String(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {})))))
  const follow = JSON.parse(String(await checked(agent.rcon.command(agent.observationToolCommand('getFollowStatus', {})))))
  if (crafting.task_active !== false || !crafting.native_queue || Object.keys(crafting.native_queue).length
    || crafting.persisted_owner || follow.active !== false || status.actor?.mining_state?.mining) return pause('preservation_recovery_native_busy')
  // Only a single compact observation neighborhood is supported. No stale tour
  // of distant machines can become one fresh preservation proof.
  const points = proof.preserved.map(row => row.entity.position)
  const target = { x: points.reduce((n, p) => n + p.x, 0) / points.length,
    y: points.reduce((n, p) => n + p.y, 0) / points.length }
  if (points.some(p => Math.hypot(p.x - target.x, p.y - target.y) > 8)
    || Math.hypot(body.actor?.position?.x - target.x, body.actor?.position?.y - target.y) > 256
    || !Number.isFinite(body.actor?.position?.x) || !Number.isFinite(body.actor?.position?.y)) return pause('preservation_recovery_neighborhood_unproven')
  agent.memory.preservationRecoveries ??= new Map()
  if (agent.memory.preservationRecoveryFault) return pause('preservation_recovery_ledger_unreadable')
  if (agent.memory.preservationRecoveries.has(key)) return pause('preservation_recovery_semantic_step_exhausted')
  if (agent.memory.preservationRecoveries.size >= 128) return pause('preservation_recovery_ledger_full')
  const allowance = claimControllerRecovery(agent.memory, owner)
  if (allowance.reason) return pause(allowance.reason)
  const claim = { claimed_at: Date.now(), state: 'claimed' }
  agent.memory.preservationRecoveries.set(key, claim)
  await checked(agent.persistState({ strict: true }))
  await emit('recovery_claimed', 'fresh_geometry_temporarily_not_visible')
  const operations = [{ name: 'walk_to_position', args: { ...target, reach_distance: 4 } }]
  admissions.set(agent, { owner, actor, fence, signature: operationSignature(operations) })
  try {
    const result = await agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, stepId: owner.stepId, operations })
    await fence()
    const pending = agent.memory.pendingOperation(owner.key)
    if (!pending || pending.goal_id !== owner.goalId || pending.plan_id !== owner.planId || pending.step_id !== owner.stepId
      || !['acknowledged', 'admitted'].includes(pending.state) || pending.signature !== operationSignature(operations)) return pause('preservation_recovery_navigation_not_admitted')
    claim.state = 'admitted'
    await checked(agent.persistState({ strict: true }))
    await emit('recovery_admitted', 'native_receipt_will_revalidate_original_checkpoint')
    return result
  } finally { admissions.delete(agent) }
}

export async function finishPreservationReobservation(agent, step, fence) {
  const owner = agent.captureCheckpointOwner()
  const key = JSON.stringify([owner.key, owner.goalId, step.semantic_step_id ?? step.step_id])
  const claim = agent.memory.preservationRecoveries?.get(key)
  if (claim?.state !== 'admitted') return
  await fence()
  claim.state = 'verified'
  await agent.persistState({ strict: true })
  await fence()
  await agent.traceEvent('contract.preservation_recovery_completed', { request_id: owner.requestTrace?.id,
    goal_id: owner.goalId, plan_id: owner.planId, plan_version: owner.planVersion, step_id: owner.stepId,
    semantic_step_id: step.semantic_step_id ?? step.step_id, reason: 'fresh_native_geometry_matches_original_baseline',
    disposition: 'ordinary_checkpoint_evaluation_required' })
  await fence()
}

export async function assertPreservationObservationAdmission(agent, operations) {
  if (!preservationObservationAdmission(agent, operations)) return false
  const held = admissions.get(agent)
  await held.fence()
  const status = JSON.parse(String(await agent.readTaskStatusRaw()))
  await held.fence()
  const journal = nativeAdmissionJournal(status.admission_journal)
  const planning = agent.memory.planningState(held.owner.key)
  const records = [...(planning.operation_ledger?.records ?? []), ...(planning.operation_ledger?.closed ?? [])]
  const pending = agent.memory.pendingOperations(held.owner.key)
  if (pending.length !== 1 || pending[0].signature !== held.signature || pending[0].state !== 'sent'
    || pending[0].request_id !== held.owner.requestTrace?.id || pending[0].plan_id !== held.owner.planId
    || pending[0].step_id !== held.owner.stepId || !journal.known
    || journal.records.some(r => ['admitting', 'uncertain'].includes(r.state))
    || unresolvedNativeAdmissions(status, records, held.actor).length
    || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch
    || status.actor?.mining_state?.mining) throw new PreservationProofError('preservation_recovery_admission_unsettled', { stage: 'admission' })
  const crafting = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
  await held.fence()
  const follow = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
  await held.fence()
  if (crafting.task_active !== false || !crafting.native_queue || Object.keys(crafting.native_queue).length
    || crafting.persisted_owner || follow.active !== false) throw new PreservationProofError('preservation_recovery_admission_busy', { stage: 'admission' })
  return preservationObservationAdmission(agent, operations)
}

export function preservationReobservationVerified(agent) {
  if (typeof agent.memory.planningState !== 'function') return false
  const owner = agent.captureCheckpointOwner()
  const plan = getActivePlan(agent.memory.planningState(owner.key))
  const step = plan?.steps?.[plan.active_step_index]
  const key = JSON.stringify([owner.key, owner.goalId, step?.semantic_step_id ?? step?.step_id])
  return !!step && agent.memory.preservationRecoveries?.get(key)?.state === 'verified'
}
