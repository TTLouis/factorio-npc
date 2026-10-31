import { factoryMetadataDigest } from './factory-dependencies.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'
import { factoryUseFailureWitness, factoryStepRequirement } from './factory-cell-use.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'

const clone = value => structuredClone(value)
const fail = code => { throw new FactoryRegistryError(code, code) }
const LIMIT = 3
const MAX_RECORDS = 256
export class FactoryUseRecoveryStore {
  #records = []
  #fault = false
  snapshot() { return { factory_use_recovery: { schema_version: 1, records: clone(this.#records), fault: this.#fault } } }
  restore(snapshot) {
    try {
      const raw = snapshot?.factory_use_recovery
      if (!raw) { if (this.#records.length) fail('factory_use_recovery_history_missing'); return }
      if (raw.schema_version !== 1 || raw.fault || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) fail('factory_use_recovery_schema')
      const ids = new Set()
      for (const row of raw.records) {
        if (typeof row.goal_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.requirement_digest) || !Array.isArray(row.attempts) || row.attempts.length > LIMIT) fail('factory_use_recovery_schema')
        const key = `${row.goal_id}/${row.requirement_digest}`
        if (ids.has(key)) fail('factory_use_recovery_schema'); ids.add(key)
        const attempts = new Set()
        for (const attempt of row.attempts) {
          if (typeof attempt.request_id !== 'string' || typeof attempt.plan_id !== 'string' || typeof attempt.code !== 'string'
            || !/^[a-f0-9]{64}$/.test(attempt.evidence_digest)) fail('factory_use_recovery_schema')
          const id = `${attempt.request_id}/${attempt.plan_id}`
          if (attempts.has(id)) fail('factory_use_recovery_schema'); attempts.add(id)
        }
      }
      for (const old of this.#records) {
        const row = raw.records.find(row => row.goal_id === old.goal_id && row.requirement_digest === old.requirement_digest)
        if (!row || factoryMetadataDigest(row.attempts.slice(0, old.attempts.length)) !== factoryMetadataDigest(old.attempts)) fail('factory_use_recovery_history_rewritten')
      }
      this.#records = clone(raw.records)
    } catch { this.#fault = true }
  }
  consume(goalId, requirement, attempt) {
    if (this.#fault) fail('factory_use_recovery_fault')
    const digest = factoryMetadataDigest(requirement)
    let row = this.#records.find(row => row.goal_id === goalId && row.requirement_digest === digest)
    const goalUsed = this.#records.filter(record => record.goal_id === goalId).reduce((sum, record) => sum + record.attempts.length, 0)
    if (!row && goalUsed >= LIMIT) return { allowed: false, exhausted: true, used: goalUsed, limit: LIMIT }
    if (!row) {
      if (this.#records.length >= MAX_RECORDS) fail('factory_use_recovery_capacity')
      row = { goal_id: goalId, requirement_digest: digest, attempts: [] }; this.#records.push(row)
    }
    const prior = row.attempts.find(value => value.request_id === attempt.request_id && value.plan_id === attempt.plan_id)
    if (prior) return { allowed: false, duplicate: true, used: goalUsed, limit: LIMIT }
    if (goalUsed >= LIMIT) return { allowed: false, exhausted: true, used: goalUsed, limit: LIMIT }
    row.attempts.push(clone(attempt))
    return { allowed: true, used: goalUsed + 1, limit: LIMIT }
  }
}

const wakeProofs = new WeakSet()
export const validFactoryRecoveryWake = proof => proof && wakeProofs.has(proof)

/** A residual miss consumes a durable same-goal allowance before the existing
 * guarded structural-successor route. The model authors the successor; the
 * canonical commit and every admission recheck its typed use independently. */
export async function recoverFactoryCellUse(agent, error) {
  const witness = factoryUseFailureWitness(error)
  if (!witness || !agent.replacementWakeEnabled || !agent.stateFile) return { handled: false }
  const owner = agent.captureCheckpointOwner(); const key = agent.activePlanKey()
  const state = agent.memory.planningState(key); const plan = getActivePlan(state)
  const requirement = factoryStepRequirement(plan?.steps?.[plan.active_step_index])
  if (!requirement || factoryMetadataDigest(requirement) !== factoryMetadataDigest(witness.requirement)) return { handled: false }
  if (!plan?.committed_at || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status) || state.goal?.status !== 'active' || state.run?.paused
    || !agent.memory.currentGoalGrant?.(key) || agent.batchInFlight || agent.memory.pendingOperations(key).length) return { handled: false }
  await agent.assertCurrent(); agent.assertCheckpointOwnerIdentity(owner)
  const raw = await agent.readTaskStatusRaw(); agent.assertCheckpointOwnerIdentity(owner)
  const status = typeof raw === 'string' ? JSON.parse(raw) : raw
  const journal = nativeAdmissionJournal(status.admission_journal)
  if (status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch || !journal.known || journal.unresolved) return { handled: false }
  if (witness.scope.goal_id !== state.goal.goal_id || witness.scope.request_id !== agent.traceRequest?.id
    || witness.scope.actor_id !== agent.epoch?.actor_id || witness.scope.actor_epoch !== agent.epoch?.epoch
    || witness.scope.session_id !== agent.epoch?.session || witness.scope.plan_id !== plan.plan_id || witness.scope.plan_version !== plan.plan_version
    || witness.registry_revision !== agent.memory.getFactoryRegistry().revision
    || witness.physical_revision !== agent.memory.factoryLifecycleRevision()) return { handled: false }
  const allowance = agent.memory.consumeFactoryUseRecovery(key, witness.requirement, {
    request_id: agent.traceRequest.id, plan_id: plan.plan_id, code: witness.code, evidence_digest: factoryMetadataDigest(witness),
  })
  await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(owner)
  if (!allowance.allowed) {
    await agent.traceEvent('factory_cell.recovery_exhausted', { goal_id: state.goal.goal_id, plan_id: plan.plan_id, code: witness.code, ...allowance })
    fail('factory_cell_recovery_exhausted')
  }
  agent.memory.recordBoardEvidence(key, { kind: 'factory_cell_resolution', ref: `${agent.traceRequest.id}/factory_use`, summary: JSON.stringify(witness) })
  agent.memory.dispatchPlanningEvent(key, { type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, source: 'runtime', now: Date.now(), plan_id: plan.plan_id,
    reason_code: witness.code, detail: 'Fresh exact factory facts cannot support the committed production requirement; assigned jobs remain unchanged.',
    evidence_refs: [`${agent.traceRequest.id}/factory_use`] })
  await agent.persistState({ strict: true })
  agent.assertCheckpointOwnerIdentity(owner)
  await agent.traceEvent('factory_cell.recovery_started', { goal_id: state.goal.goal_id, plan_id: plan.plan_id, witness, ...allowance })
  agent.assertCheckpointOwnerIdentity(owner)
  const proof = Object.freeze({ goal_id: state.goal.goal_id, plan_id: plan.plan_id, request_id: agent.traceRequest.id }); wakeProofs.add(proof)
  const result = await agent.wakePlannerForReplacement({ trigger: 'factory_cell_resolution', factoryWitness: proof })
  return result === undefined ? { handled: false } : { handled: true, result }
}
