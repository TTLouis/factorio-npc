import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { evaluateCompletionContract } from './step-completion.mjs'
import { MAX_REPLACEMENTS_PER_GOAL } from './replacement-wake.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'
import { captureObligationProof, compileObligations, contractDefectShape, obligationContractMatches,
  obligationProofOrigin, preservedProofMatches, effectivePreservationProof, preservationGeometry, CONTRACT_DEFECT_REASON } from './contract-obligations.mjs'

function placementReceipt(agent, plan, step) {
  const board = agent.memory.currentPlan(agent.activePlanKey())?.task_board
  for (const row of [...(board?.evidence ?? [])].reverse()) {
    if (row.kind !== 'operation_receipt' || row.step_id !== board.active_step_id) continue
    let receipt
    try { receipt = JSON.parse(row.summary) } catch { continue }
    const basic = receipt.basic_operation
    const admitted = receipt.admitted_batch
    if (receipt.outcome !== 'completed' || receipt.task_state !== 'idle' || receipt.queue_length !== 0
      || basic?.accepted !== true || basic?.completed !== true || basic.type !== 'placing'
      || basic.actor_id !== agent.epoch?.actor_id || !Number.isSafeInteger(basic.placed_unit_number)
      || admitted?.goal_id !== plan.goal_id || admitted.plan_id !== plan.plan_id || admitted.step_id !== step.step_id
      || admitted.actor_id !== agent.epoch.actor_id || admitted.actor_epoch !== agent.epoch.epoch
      || admitted.batch_id !== receipt.batch_id || admitted.batch_generation !== receipt.batch_generation
      || receipt.correlation?.goal_id !== plan.goal_id || receipt.correlation.actor_id !== agent.epoch.actor_id
      || receipt.correlation.actor_epoch !== agent.epoch.epoch || receipt.correlation.step_id !== board.active_step_id) continue
    return { receipt, ref: row.ref, basic }
  }
}

async function nativeIdle(agent, fence) {
  const raw = await agent.readTaskStatusRaw()
  await fence()
  const status = typeof raw === 'string' ? JSON.parse(raw) : raw
  const crafting = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
  await fence()
  const follow = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
  await fence()
  return status?.task_state === 'idle' && status.queue_empty === true && status.queue_length === 0 && !status.active_batch
    && !status.actor?.mining_state?.mining && crafting.task_active === false && crafting.native_queue
    && Object.keys(crafting.native_queue).length === 0 && !crafting.persisted_owner && follow.active === false
}

// An absent lazy target is advisory unknown, never an inferred connection.
// Fueling a cell can reveal the target through the native getter. Only a target
// already present in the frozen preservation set, with unchanged geometry and
// scope, may refine that unknown. Persist the refinement before proceeding so
// restart/restage cannot forget a known target or later accept its loss.
export async function reconcilePreservationProof(agent, step, fresh, fence) {
  const key = agent.activePlanKey()
  const plan = getActivePlan(agent.memory.planningState(key))
  const effective = effectivePreservationProof(plan, step)
  if (!effective || !preservedProofMatches(effective, fresh)) return false
  if (JSON.stringify(effective.preserved) === JSON.stringify(fresh.preserved)) return true
  // Predictions may check facts for a future step but cannot append execution
  // facts for it. Activation repeats this read and persists before binding.
  if (plan.steps[plan.active_step_index]?.step_id !== step.step_id) return true
  const proof = { ...fresh, binding: step.obligation_proof.binding }
  if (!agent.memory.recordPreservationProof(key, { planId: plan.plan_id, stepId: step.step_id, proof })) return false
  await agent.persistState({ strict: true })
  await fence()
  await agent.traceEvent('contract.preservation_resolved', { goal_id: plan.goal_id, plan_id: plan.plan_id,
    step_id: step.step_id, request_id: agent.traceRequest?.id, reason: 'native_target_resolved_to_preserved_identity',
    disposition: 'durable_advisory_fact_not_connection_completion' })
  await fence()
  return true
}

export async function verifyPreservationBeforeClose(agent) {
  const plan = getActivePlan(agent.memory.planningState?.(agent.activePlanKey()))
  const step = plan?.steps?.[plan.active_step_index]
  if (!step?.obligations && step?.obligation_protocol !== 1) return { ok: true }
  const owner = agent.captureCheckpointOwner()
  const fence = () => agent.assertCheckpointOwnerCurrent(owner)
  if (!obligationProofOrigin(agent.memory.planningState(agent.activePlanKey()), step)) return { ok: false, reason: 'preservation_provenance_unproven' }
  if (agent.currentPendingAmendment() || agent.batchInFlight || agent.memory.pendingOperation?.(agent.activePlanKey())) return { ok: false, reason: 'preservation_settlement_not_safe' }
  try {
    if (!await nativeIdle(agent, fence)) return { ok: false, reason: 'preservation_native_not_idle' }
    const fresh = await captureObligationProof(agent, step.obligations, fence)
    await fence()
    if (!await nativeIdle(agent, fence)) return { ok: false, reason: 'preservation_native_not_idle' }
    if (agent.currentPendingAmendment() || agent.batchInFlight || agent.memory.pendingOperation?.(agent.activePlanKey())) return { ok: false, reason: 'preservation_settlement_not_safe' }
    return await reconcilePreservationProof(agent, step, fresh, fence) ? { ok: true } : { ok: false, reason: 'preservation_baseline_changed' }
  } catch (error) {
    await fence()
    return { ok: false, reason: `preservation_unreadable:${error.message}` }
  }
}

export async function recoverContractObligations(agent, { trigger = 'settlement' } = {}) {
  const key = agent.activePlanKey()
  const planning = agent.memory.planningState?.(key)
  const plan = getActivePlan(planning)
  const step = plan?.steps?.[plan.active_step_index]
  if ((!step?.obligations && step?.obligation_protocol !== 1) || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status)) return undefined
  const mismatched = !step.obligations || !obligationContractMatches(step.completion_contract, step.obligations)
  let owner = agent.captureCheckpointOwner()
  const base = { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id,
    semantic_step_id: step.semantic_step_id ?? step.step_id, request_id: agent.traceRequest?.id, trigger }
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    if (agent.currentPendingAmendment()) throw new Error('contract_defect_pending_amendment')
  }
  const pause = async reason => {
    await agent.assertCheckpointOwnerCurrent(owner)
    await agent.traceEvent(/limit_exhausted|interrupted_claim/.test(reason) ? 'contract.defect_exhausted' : 'contract.defect_refused',
      { ...base, reason, disposition: 'classified_guard_pause' })
    await agent.assertCheckpointOwnerCurrent(owner)
    const result = await agent.pauseForStepContract({ reason: `${CONTRACT_DEFECT_REASON}:${reason}`, owner })
    return result
  }
  try {
  await fence()
  if (!obligationProofOrigin(planning, step)
    || step.obligation_proof.captured_at > plan.committed_at || mismatched && !contractDefectShape(step)) return pause('provenance_unproven')
  if (agent.batchInFlight || agent.memory.pendingOperation?.(key) || agent.memory.currentPlan?.(key)?.condition_wait) {
    return mismatched ? pause('operation_unsettled') : undefined
  }
  let idle
  try { idle = await nativeIdle(agent, fence) } catch { await fence(); return pause('native_status_unreadable') }
  if (!idle) return mismatched ? pause('native_busy') : undefined
  if (!mismatched) {
    let fresh
    try { fresh = await captureObligationProof(agent, step.obligations, fence) }
    catch (error) { await fence(); return pause(`preservation_proof_unreadable:${error.message}`) }
    return await reconcilePreservationProof(agent, step, fresh, fence) ? undefined : pause('preservation_baseline_changed')
  }
  if (planning.goal?.contract_defect_claims?.includes(base.semantic_step_id)) return pause('semantic_step_limit_exhausted')
  if ((planning.goal?.replacements_accepted ?? 0) >= MAX_REPLACEMENTS_PER_GOAL) return pause('goal_replacement_limit_exhausted')
  const grant = agent.memory.currentGoalGrant?.(key)
  if (!grant || !grant.permitted_scope?.includes('recovery')) return pause('current_recovery_grant_required')
  const placed = placementReceipt(agent, plan, step)
  if (!placed) return pause('same_step_completed_placement_receipt_required')
  let fresh
  let built
  try {
    fresh = await captureObligationProof(agent, step.obligations, fence)
    if (!await reconcilePreservationProof(agent, step, fresh, fence)) return pause('preservation_baseline_changed')
    if (fresh.preserved.some(row => row.item_io && (!row.item_io.drop_target || row.entity.type === 'inserter' && !row.item_io.pickup_target))) return pause('preservation_route_unresolved')
    const raw = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getEntityGeometry', { unit_number: placed.basic.placed_unit_number }))))
    await fence()
    built = preservationGeometry(raw, placed.basic.placed_unit_number)
  } catch (error) {
    // An old callback cannot pause its replacement; the fence throws first.
    await fence()
    return pause(`native_proof_unreadable:${error.message}`)
  }
  if (built.entity.name !== placed.basic.entity_name || built.entity.position.x !== placed.basic.placed_position?.x
    || built.entity.position.y !== placed.basic.placed_position?.y || step.obligations.preserve.includes(built.entity.unit_number)
    || built.actor_id !== fresh.actor_id || built.surface_index !== placed.basic.placed_surface_index
    || fresh.preserved.some(row => row.surface_index !== built.surface_index || row.force_index !== built.force_index)) return pause('placed_identity_mismatch')
  const scoped = step.obligations.outcome.requirements.filter(row => row.kind === 'entity_count' && row.prototype === built.entity.name && row.anchor && row.radius)
  if (!scoped.length || scoped.some(row => Math.hypot(built.entity.position.x - row.anchor.x, built.entity.position.y - row.anchor.y) > row.radius)) return pause('placed_output_scope_unproven')
  const expected = compileObligations(step.obligations)
  const facts = await agent.completionFactsForContract(expected, undefined, [], { committedIdentity: true })
  await fence()
  if (!evaluateCompletionContract(expected, facts).satisfied) return pause('declared_outcomes_not_verified')
  await agent.traceEvent('contract.defect_detected', { ...base, reason: CONTRACT_DEFECT_REASON, placement_ref: placed.ref,
    preserved_units: step.obligations.preserve, disposition: 'one_bounded_successor' })
  await fence()
  if (!await nativeIdle(agent, fence)) return pause('native_busy_before_claim')
  const beforeClaim = await captureObligationProof(agent, step.obligations, fence)
  if (!await reconcilePreservationProof(agent, step, beforeClaim, fence)) return pause('preservation_changed_before_claim')
  const claimed = agent.memory.claimContractDefect(key, { ...base, current: { actor_id: fresh.actor_id, actor_epoch: fresh.actor_epoch },
    grant_id: grant.grant_id, grant_revision: grant.revision, fresh_proof: fresh, evidence_ref: placed.ref })
  if (!claimed) return pause('claim_or_authority_refused')
  // The claim is durable BEFORE a successor can be drafted or committed.
  await agent.persistState({ strict: true })
  await fence()
  await agent.traceEvent('contract.defect_claimed', { ...base, reason: 'durable_one_attempt_per_semantic_step',
    attempt: 1, step_limit: 1, goal_replacement_limit: MAX_REPLACEMENTS_PER_GOAL })
  await fence()
  const successor = agent.memory.draftContractDefectSuccessor(key, { current: { actor_id: fresh.actor_id, actor_epoch: fresh.actor_epoch }, requestId: base.request_id })
  if (!successor.ok) return pause(`successor_refused:${successor.reason}`)
  owner = agent.captureCheckpointOwner()
  await agent.persistState({ strict: true })
  await fence()
  const current = await agent.assertCurrent()
  await fence()
  if (!await nativeIdle(agent, fence)) return pause('native_busy_before_commit')
  const beforeCommit = await captureObligationProof(agent, step.obligations, fence)
  if (!await reconcilePreservationProof(agent, step, beforeCommit, fence)) return pause('preservation_changed_before_commit')
  const committed = agent.memory.commitReplacementPlan(key, { current: { actor_id: current.actor_id, actor_epoch: current.epoch },
    runtime_validation: { passed: true, scope: 'completion_contracts' }, requestId: base.request_id })
  if (!committed.ok) return pause(`successor_commit_refused:${committed.reason}`)
  if (!agent.memory.activateContractDefectSuccessor(key, successor.plan.plan_id)) return pause('successor_activation_refused')
  await agent.persistState({ strict: true })
  await fence()
  await agent.traceEvent('contract.defect_corrected', { ...base, successor_plan_id: successor.plan.plan_id,
    reason: 'immutable_successor_from_frozen_obligations', placement_replayed: false })
  await fence()
  // Existing fresh settlement closes exactly once using the copied verified
  // ledger and current native facts, then supplies the unchanged next step.
  const settled = await agent.closeActiveStepOnFreshRead({ previousState: agent.memory.currentPlan(key), trigger: 'contract_defect_successor' })
  if (settled.contractPause) return settled.contractPause
  if (!settled.closed) return pause('successor_fresh_settlement_refused')
  owner = agent.captureCheckpointOwner()
  await agent.traceEvent('contract.defect_continued', { ...base, successor_plan_id: successor.plan.plan_id,
    next_step_id: owner.stepId, reason: 'declared_outcomes_and_preservation_verified' })
  await fence()
  return agent.continueAfterFreshStepClose(settled, { operations: [] }, current)
  } catch (error) {
    // A new amendment fences every delayed read/trace/flush; ownership is
    // checked before choosing a pause so an old request never pauses its heir.
    await agent.assertCheckpointOwnerCurrent(owner)
    if (agent.currentPendingAmendment()) return pause('pending_amendment')
    throw error
  }
}
