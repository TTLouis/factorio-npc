import { createHash } from 'node:crypto'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { sanitizeStepCompletionContract, evaluateCompletionContract } from './step-completion.mjs'
import { captureObligationProof, effectivePreservationProof, preservedProofMatches, PreservationProofError } from './contract-obligations.mjs'
import { reconcilePreservationProof } from './contract-obligation-runtime.mjs'
import { preservationObservationAdmission, recoverPreservationVisibility } from './preservation-recovery.mjs'
import { reconcilePendingOperation, RECONCILE_VERDICT, operationSignature, unresolvedNativeAdmissions } from './operation-reconciliation.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'

// Experimental, opt-in. These are additional ceilings, never refunds of the
// existing provider, action, recovery or construction-time budgets.
export const PROGRESS_AUDIT_LIMITS = Object.freeze({ attempts: 6, goalAttempts: 24, records: 128 })
export const PROGRESS_AUDIT_TRANSITION = Symbol('progressAuditTransition')
const transition = result => { if (result && typeof result === 'object') Object.defineProperty(result, PROGRESS_AUDIT_TRANSITION, { value: true }); return result }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const predicateKey = ({ id: _id, ...row }) => JSON.stringify(canonical(row))
export function progressObligationKey(contract, preserve = []) {
  return hash({ mode: contract.mode, requirements: contract.requirements.map(predicateKey).sort(), preserve: [...preserve].sort((a, b) => a - b) })
}

export function restoreProgressAudits(raw) {
  const records = new Map()
  let fault = raw !== undefined && (!Array.isArray(raw) || raw.length > PROGRESS_AUDIT_LIMITS.records)
  for (const pair of Array.isArray(raw) ? raw : []) {
    try {
      const [key, row] = pair
      const scope = JSON.parse(key)
      if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(scope) || scope.length !== 3
        || scope.some(v => typeof v !== 'string' || !v || v.length > 240) || records.has(key)
        || !/^[a-f0-9]{64}$/.test(scope[2]) || row.version !== 1
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > PROGRESS_AUDIT_LIMITS.attempts
        || !Number.isSafeInteger(row.reviews) || row.reviews < 0 || row.reviews > 1
        || !Array.isArray(row.history) || row.history.length > PROGRESS_AUDIT_LIMITS.attempts
        || !Array.isArray(row.blocked) || row.blocked.length > PROGRESS_AUDIT_LIMITS.attempts + 1
        || row.blocked.some(v => !/^[a-f0-9]{64}$/.test(v))
        || !['ready', 'claimed', 'review', 'paused'].includes(row.state)
        || ![row.baseline, row.previous, row.peak].every(facts => facts && typeof facts === 'object' && !Array.isArray(facts)
          && Object.keys(facts).length <= 16 && Object.values(facts).every(v => Number.isFinite(v) && v >= 0))
        || row.history.length + (row.state === 'claimed' ? 1 : 0) !== row.attempts
        || row.state === 'claimed' && (!row.claim || !/^[a-f0-9]{64}$/.test(row.claim.signature)
          || !Number.isSafeInteger(row.claim.actor?.actor_id) || !Number.isSafeInteger(row.claim.actor?.epoch)
          || ['operation_key', 'plan_id', 'step_id', 'attempt_id'].some(key => typeof row.claim[key] !== 'string' || !row.claim[key])
          || !Number.isSafeInteger(row.claim.ordinal) || !Array.isArray(row.claim.operations) || operationSignature(row.claim.operations) !== row.claim.signature)
        || row.history.some(item => !item || !['progress', 'no_progress'].includes(item.decision)
          || typeof item.operation_key !== 'string' || !item.before || !item.after || !item.receipt || !Array.isArray(item.operations))
        || new Set(row.history.map(item => item.operation_key)).size !== row.history.length
        || JSON.stringify(Object.keys(row.baseline).sort()) !== JSON.stringify(Object.keys(row.previous).sort())
        || JSON.stringify(Object.keys(row.baseline).sort()) !== JSON.stringify(Object.keys(row.peak).sort())
        || Object.keys(row.baseline).some(key => row.peak[key] < row.baseline[key] || row.peak[key] < row.previous[key])
        || JSON.stringify(row).length > 64000) throw new Error('invalid')
      records.set(key, structuredClone(row))
    } catch { fault = true }
  }
  return { records, fault }
}

// Integer quantities need at least one item and 5% of the declared target;
// boolean predicates can earn credit once. Never credit controller health,
// admission, a moving position, or a mere operation receipt as productivity.
export function progressVector(contract, facts) {
  const vector = {}
  const evaluation = evaluateCompletionContract(contract, facts)
  for (const requirement of contract.requirements) {
    if (requirement.kind === 'authoritative_operation_receipt') continue
    const fact = facts[requirement.id]
    if (!fact || fact.kind !== requirement.kind || fact.stale === true || fact.authoritative !== true) return undefined
    const key = predicateKey(requirement)
    if (['inventory_count', 'entity_inventory_count', 'entity_count'].includes(requirement.kind)) {
      if (!Number.isSafeInteger(fact.current) || fact.current < 0) return undefined
      vector[key] = Math.min(requirement.minimum, fact.current)
    }
    else if (['entity_exists', 'entity_state', 'research_completed', 'area_reservation_state'].includes(requirement.kind)) {
      vector[key] = evaluation.results.find(row => row.id === requirement.id)?.satisfied ? 1 : 0
    }
    else return undefined
  }
  return Object.keys(vector).length ? vector : undefined
}

export function compareProgress(contract, episode, after) {
  if (!after || Object.keys(episode.baseline).some(key => after[key] === undefined)) return 'unknown'
  return contract.requirements.some(requirement => {
    const key = predicateKey(requirement)
    const delta = Math.max(1, Math.ceil((requirement.minimum ?? 1) * 0.05))
    return after[key] - Math.max(episode.peak[key] ?? 0, episode.previous[key] ?? 0, episode.baseline[key] ?? 0) >= delta
  }) ? 'progress' : 'no_progress'
}

function scope(agent) {
  if (!agent.executorProgressAudit || agent.completionProtocolVersion < 3) return undefined
  const owner = agent.captureCheckpointOwner()
  const planning = agent.memory.planningState(owner.key)
  const plan = getActivePlan(planning)
  const step = plan?.steps?.[plan.active_step_index]
  if (!step || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status) || step.completion_mode === 'semantic') return undefined
  const contract = sanitizeStepCompletionContract(step.completion_contract, agent.currentContractContext())
  if (!contract.requirements.length) return undefined
  const key = JSON.stringify([owner.key, owner.goalId, progressObligationKey(contract, step.obligations?.preserve)])
  const actor = { ...agent.epoch }
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    if (agent.currentPendingAmendment() || agent.memory.pauseRecord?.(owner.key)?.paused
      || agent.epoch?.actor_id !== actor.actor_id || agent.epoch?.epoch !== actor.epoch) throw new PreservationProofError('progress_audit_owner_changed')
  }
  return { owner, planning, plan, step, contract, key, actor, fence }
}

async function persist(agent, s) {
  if ((!agent.stateFile || typeof agent.memory.snapshot !== 'function') && !agent.allowEphemeralProgressAudit) throw new PreservationProofError('progress_audit_persistence_required')
  const snapshot = agent.memory.snapshot?.()
  const stored = snapshot?.executor_progress_audits?.find(pair => pair[0] === s.key)?.[1]
  if (JSON.stringify(stored) !== JSON.stringify(agent.memory.progressAudits.get(s.key))) throw new PreservationProofError('progress_audit_snapshot_missing')
  try { await agent.persistState({ strict: true }) }
  catch (error) { agent.memory.progressAuditFault = true; throw error }
  await s.fence()
}

async function emit(agent, s, reason, extra = {}) {
  await agent.traceEvent('executor.progress_audit', { request_id: s.owner.requestTrace?.id,
    goal_id: s.owner.goalId, plan_id: s.owner.planId, plan_version: s.owner.planVersion,
    step_id: s.owner.stepId, semantic_step_id: s.step.semantic_step_id ?? s.step.step_id,
    actor_id: s.actor.actor_id, actor_epoch: s.actor.epoch, episode_id: s.key, reason, ...extra })
  await s.fence()
}

async function stop(agent, s, reason) {
  await emit(agent, s, reason, { disposition: 'guard_pause' })
  return agent.pauseForStepContract({ reason: `progress_audit:${reason}`, owner: s.owner })
}

async function freshFacts(agent, s) {
  await s.fence()
  if (agent.batchInFlight || agent.memory.pendingOperation?.(s.owner.key)) return undefined
  const raw = JSON.parse(String(await agent.readTaskStatusRaw())); await s.fence()
  const records = [...(s.planning.operation_ledger?.records ?? []), ...(s.planning.operation_ledger?.closed ?? [])]
  const unresolved = unresolvedNativeAdmissions(raw, records, s.actor).filter(row => {
    const owner = agent.gatherAdmission
    const closed = records.find(record => record.operation_key === row.operation_key && record.signature === row.signature)
    return !(owner && agent.checkpointOwnerCurrent(owner) && owner.reconciledOperationKey === row.operation_key
      && closed && reconcilePendingOperation(closed, { status: raw, actor: s.actor }).reason === 'exact_terminal_gather_cancelled')
  })
  if (raw.task_state !== 'idle' || raw.queue_empty !== true || raw.queue_length !== 0 || raw.active_batch
    || !nativeAdmissionJournal(raw.admission_journal).known || unresolved.length) return undefined
  const craft = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {})))); await s.fence()
  const follow = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getFollowStatus', {})))); await s.fence()
  if (craft.task_active !== false || !craft.native_queue || Object.keys(craft.native_queue).length || craft.persisted_owner
    || follow.active !== false || raw.actor?.mining_state?.mining) return undefined
  if (s.step.obligations) {
    let proof
    try { proof = await captureObligationProof(agent, s.step.obligations, s.fence) }
    catch (error) {
      if (error?.code !== 'preservation_entity_not_visible') throw error
      const recovery = await recoverPreservationVisibility(agent, error, { trigger: 'progress_audit' })
      return { recovery }
    }
    if (!preservedProofMatches(effectivePreservationProof(s.plan, s.step, { plans: s.planning.plans }), proof)
      && !await reconcilePreservationProof(agent, s.step, proof, s.fence)) return undefined
  }
  const facts = await agent.completionFactsForContract(s.contract, undefined, [], { committedIdentity: true }); await s.fence()
  return { facts, vector: progressVector(s.contract, facts), raw }
}

// With preservation obligations, opaque travel/search cannot be proved to keep
// the observation neighborhood. Refuse before transport rather than buying a
// return/reobserve loop. Native preservation still enforces the final boundary.
export function preservationTravelConflict(step, operations, observedEntity = () => undefined) {
  if (!step.obligations?.preserve?.length) return false
  const preserved = step.obligation_proof?.preserved ?? []
  const points = preserved.map(row => row.entity.position)
  // Explicit conservative support: only native operations known not to walk,
  // or a concrete destination in the compact preservation neighborhood. This
  // also covers implicit walks for placement, transfers and entity mining.
  const stationary = new Set(['craft_item', 'wait', 'start_research', 'stop_follow', 'cancel_all_tasks'])
  return operations.some(op => {
    if (stationary.has(op.name)) return false
    const args = op.args ?? {}
    const entity = Number.isSafeInteger(args.unit_number)
      ? preserved.find(row => row.entity.unit_number === args.unit_number)?.entity ?? observedEntity(args.unit_number) : undefined
    const position = ['walk_to_position', 'mine_resource_at', 'place_entity'].includes(op.name)
      ? args : entity?.position
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !points.length) return true
    return points.some(p => Math.hypot(p.x - position.x, p.y - position.y) > 8)
  })
}

async function review(agent, s, episode, reason, operations = []) {
  if (episode.reviews >= 1 || agent.agentContext.role !== 'executor') return stop(agent, s, 'review_exhausted')
  episode.reviews++
  episode.state = 'review'
  await persist(agent, s)
  const evidence = { episode_id: s.key, baseline: episode.baseline, previous: episode.previous, peak: episode.peak,
    attempts: episode.attempts, limit: PROGRESS_AUDIT_LIMITS.attempts, reason,
    constraints: s.step.obligations ?? s.contract, history: episode.history, refused_submission: operations }
  await emit(agent, s, reason, { disposition: 'planner_review', ...evidence })
  // This object is supplied to the planner through its ordinary review handoff;
  // it is diagnostic evidence, never permission to change committed semantics.
  return agent.handlePlannerReview({ operations: [], progressAuditEvidence: evidence,
    plannerReview: { reason: 'approach_infeasible', rationale: `Harness progress audit: ${reason}. Refine the executable approach using the attached native facts and attempts; preserve the committed goal, checkpoint and constraints.` } }, s.owner.stepId, { harnessRaised: true })
}

export async function auditExecutorProgress(agent) {
  const s = scope(agent)
  if (!s) return undefined
  const episode = agent.memory.progressAudits?.get(s.key)
  if (agent.memory.progressAuditFault) return stop(agent, s, 'ledger_unreadable')
  if (!episode) return undefined
  if (episode.state === 'review') return review(agent, s, episode, 'no_verified_progress')
  if (episode.state !== 'claimed') return undefined
  await s.fence()
  const claim = episode.claim
  const closed = agent.memory.planningState(s.owner.key).operation_ledger?.closed?.find(row => row.operation_key === claim.operation_key)
  if (!closed || claim.actor.actor_id !== s.actor.actor_id || claim.actor.epoch !== s.actor.epoch
    || closed.signature !== claim.signature || closed.attempt_id !== claim.attempt_id || closed.ordinal !== claim.ordinal
    || closed.goal_id !== s.owner.goalId || closed.plan_id !== claim.plan_id || closed.step_id !== claim.step_id) return stop(agent, s, 'unreconciled_attempt')
  const fresh = await freshFacts(agent, s)
  if (fresh?.recovery !== undefined) return fresh.recovery
  if (!fresh?.vector) return stop(agent, s, 'unknown_native_facts')
  const receipt = reconcilePendingOperation(closed, { status: fresh.raw, actor: s.actor })
  if (![RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, RECONCILE_VERDICT.ADMITTED_PARTIAL].includes(receipt.verdict)) return stop(agent, s, 'uncertain_effects')
  const decision = compareProgress(s.contract, episode, fresh.vector)
  const complete = agent.evaluateCompletionContract(s.contract, fresh.facts).satisfied
  const row = { request_id: s.owner.requestTrace?.id, operation_key: closed.operation_key, operations: claim.operations,
    receipt, before: episode.previous, after: fresh.vector, decision, complete, at: Date.now() }
  episode.history.push(row)
  episode.previous = fresh.vector
  // Every observed maximum is durable, including sub-threshold gains. Reaching
  // an earlier maximum again (or cycling placed/removed entities) buys nothing.
  for (const [key, value] of Object.entries(fresh.vector)) episode.peak[key] = Math.max(episode.peak[key] ?? 0, value)
  const needsReview = !complete && decision !== 'progress' && episode.attempts > 1
  if (needsReview && !episode.blocked.includes(claim.signature)) episode.blocked.push(claim.signature)
  episode.state = needsReview ? 'review' : 'ready'
  delete episode.claim
  await persist(agent, s)
  await emit(agent, s, decision, { disposition: complete ? 'ordinary_completion_required' : needsReview ? 'planner_review' : 'bounded_continuation',
    attempts: episode.attempts, limit: PROGRESS_AUDIT_LIMITS.attempts, baseline: episode.baseline, peak: episode.peak, ...row })
  if (needsReview) return review(agent, s, episode, 'no_verified_progress')
  return undefined
}

export async function prepareProgressAttempt(agent, operations) {
  if (preservationObservationAdmission(agent, operations)) return undefined
  let s = scope(agent)
  if (!s) return undefined
  // A missed native callback must be audited before a new admission as well.
  const audit = await auditExecutorProgress(agent)
  if (audit !== undefined) return { result: transition(audit) }
  await s.fence()
  s = scope(agent)
  if (agent.memory.progressAuditFault) return { result: transition(await stop(agent, s, 'ledger_unreadable')) }
  agent.memory.progressAudits ??= new Map()
  let episode = agent.memory.progressAudits.get(s.key)
  const fresh = await freshFacts(agent, s)
  if (fresh?.recovery !== undefined) return { result: fresh.recovery }
  if (!fresh?.vector) return { result: transition(await stop(agent, s, 'unknown_native_facts')) }
  if (!episode) {
    if (agent.memory.progressAudits.size >= PROGRESS_AUDIT_LIMITS.records) return { result: transition(await stop(agent, s, 'ledger_full')) }
    episode = { version: 1, attempts: 0, reviews: 0, state: 'ready', baseline: fresh.vector,
      previous: fresh.vector, peak: { ...fresh.vector }, history: [], blocked: [] }
    agent.memory.progressAudits.set(s.key, episode)
  }
  const signature = operationSignature(operations)
  if (preservationTravelConflict(s.step, operations, id => agent.liveObservedExactTarget(id))) {
    if (!episode.blocked.includes(signature)) episode.blocked.push(signature)
    await persist(agent, s)
    return { result: transition(await review(agent, s, episode, 'preservation_travel_incompatible', operations)) }
  }
  if (episode.blocked.includes(signature)) return { result: transition(await stop(agent, s, 'unchanged_failed_approach')) }
  const goalAttempts = [...agent.memory.progressAudits].filter(([key]) => {
    const fields = JSON.parse(key); return fields[0] === s.owner.key && fields[1] === s.owner.goalId
  }).reduce((sum, [, row]) => sum + row.attempts, 0)
  if (episode.attempts >= PROGRESS_AUDIT_LIMITS.attempts || goalAttempts >= PROGRESS_AUDIT_LIMITS.goalAttempts) return { result: transition(await stop(agent, s, 'attempt_limit_exhausted')) }
  return { s, episode, signature, before: fresh.vector, operations: structuredClone(operations) }
}

export async function bindProgressAttempt(agent, prepared, pending) {
  if (!prepared?.s) return
  const { s, episode, signature, before } = prepared
  await s.fence()
  if (!pending || pending.signature !== signature || pending.protocol_version !== 2) throw new PreservationProofError('progress_audit_admission_identity_missing')
  episode.attempts++
  episode.state = 'claimed'
  episode.previous = before
  for (const [key, value] of Object.entries(before)) episode.peak[key] = Math.max(episode.peak[key] ?? 0, value)
  episode.claim = { operation_key: pending.operation_key, signature, actor: pending.actor, plan_id: pending.plan_id, step_id: pending.step_id, attempt_id: pending.attempt_id, ordinal: pending.ordinal, operations: prepared.operations }
  await persist(agent, s)
  await emit(agent, s, 'attempt_claimed', { disposition: 'await_reconciliation', operation_key: pending.operation_key,
    attempts: episode.attempts, limit: PROGRESS_AUDIT_LIMITS.attempts, before })
}

// Called only by the ordinary planner handback for this same committed step.
// A crash after requesting review leaves state=review, which cannot execute.
export async function completeProgressReview(agent, notes) {
  const s = scope(agent)
  if (!s) return
  const episode = agent.memory.progressAudits?.get(s.key)
  if (episode?.state !== 'review' || episode.reviews !== 1) return
  await s.fence()
  episode.review_reply = { request_id: s.owner.requestTrace?.id, at: Date.now(), notes: String(notes ?? '').slice(0, 4000) }
  episode.state = 'ready'
  await persist(agent, s)
  await emit(agent, s, 'planner_refinement_received', { disposition: 'ordinary_admission_required', ...episode.review_reply })
}
