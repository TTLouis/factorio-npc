import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { evaluateCompletionContract } from './step-completion.mjs'
import { MAX_REPLACEMENTS_PER_GOAL } from './replacement-wake.mjs'
import { renderOperationPreflight, luaString } from './structured-policy.mjs'
import { batchWatermark, operationSignature } from './operation-reconciliation.mjs'
import { captureObligationProof, compileObligations, contractDefectShape, obligationContractMatches,
  obligationProofOrigin, preservedProofMatches, effectivePreservationProof, preservationGeometry, normalizeFluidAdmission,
  normalizeFluidCertificate, fluidAdditionProof, PreservationProofError, CONTRACT_DEFECT_REASON } from './contract-obligations.mjs'

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
  const effective = effectivePreservationProof(plan, step, { plans: agent.memory.planningState(agent.activePlanKey()).plans })
  if (!effective) return false
  // A completed witnessed placement must be reconciled even if someone later
  // made its old open port look unchanged. Omitted/corrupt execution facts may
  // not forget an already-created protected connection after restore.
  const fluid = await reconcileFluidAddition(agent, plan, step, fresh, fence)
  if (fluid !== undefined) return fluid
  if (!preservedProofMatches(effective, fresh)) return false
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

export async function prepareFluidPreservationAdmission(agent, { operations, pending } = {}) {
  const key = agent.activePlanKey()
  const planning = agent.memory.planningState?.(key)
  const plan = getActivePlan(planning)
  const step = plan?.steps?.[plan.active_step_index]
  if (step?.obligation_proof?.version !== 2) return undefined
  const fail = code => { throw new PreservationProofError(code, { stage: 'admission', category: code.endsWith('_limit_exhausted') ? 'exhausted' : 'unproven' }) }
  const owner = agent.captureCheckpointOwner()
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    const records = agent.memory.pendingOperations?.(key) ?? []
    if (agent.currentPendingAmendment() || agent.batchInFlight || records.length !== 1
      || records[0].operation_key !== pending?.operation_key || records[0].signature !== pending?.signature) fail('preservation_admission_not_safe')
  }
  await fence()
  if (!obligationProofOrigin(planning, step) || !pending || pending.signature !== operationSignature(operations)) fail('preservation_admission_owner_unproven')
  if (!await nativeIdle(agent, fence)) fail('preservation_admission_native_busy')
  const fresh = { ...await captureObligationProof(agent, step.obligations, fence), binding: step.obligation_proof.binding }
  const effective = effectivePreservationProof(plan, step, { plans: agent.memory.planningState(agent.activePlanKey()).plans })
  if (!effective || !preservedProofMatches(effective, fresh)) fail('preservation_baseline_changed')
  const protectedEntities = fluidPreservationEntities(planning, plan, step, effective)
  if (fluidPreservationMutationUnsafe(effective, operations, protectedEntities)) fail('preservation_protected_mutation_refused')
  const placements = operations?.filter(row => ['place_candidate', 'place_entity', 'execute_construction_plan'].includes(row.name)) ?? []
  if (!placements.length) return undefined
  // Nonfluid placement cannot add a fluid edge. This is fresh native prototype
  // evidence, never a name/prose assumption; candidates may not clear assets.
  let allNonfluid = true
  for (const operation of placements) {
    let checked
    try { checked = JSON.parse(String(await agent.rcon.command(renderOperationPreflight({ name: operation.name, args: operation.args })))) }
    catch { await fence(); fail('preservation_candidate_read_unavailable') }
    await fence()
    const output = checked?.preservation_nonfluid_output
    if (checked.ok !== true || output?.version !== 1 || output.fluid_port_count !== 0
      || output.actor_id !== fresh.actor_id || fresh.preserved.some(row => row.surface_index !== output.surface_index || row.force_index !== output.force_index)
      || operation.name === 'place_candidate' && checked.preservation_clears_count !== 0) allNonfluid = false
  }
  if (allNonfluid) {
    if (!await nativeIdle(agent, fence)) fail('preservation_admission_native_busy')
    await fence()
    return undefined
  }
  if (operations?.length !== 1 || operations[0].name !== 'place_candidate') fail('preservation_exact_single_candidate_required')
  let preflight
  const args = operations[0].args
  const current = await agent.assertCurrent(); await fence()
  if (typeof current.session !== 'string' || !current.session) fail('preservation_native_session_unproven')
  const nativeOwner = { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id,
    semantic_step_id: step.semantic_step_id ?? step.step_id, actor_id: fresh.actor_id, actor_epoch: fresh.actor_epoch, session: current.session }
  const context = { signature: pending.signature, owner: nativeOwner }
  const freeze = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_preflight","fluid_preservation_candidate",${luaString(args.candidate_set_id)},${luaString(args.candidate_id)},${luaString(pending.operation_key)},{${step.obligations.preserve.join(',')}},helpers.json_to_table(${luaString(JSON.stringify(context))}))))`
  try { preflight = JSON.parse(String(await agent.rcon.command(freeze))) }
  catch { await fence(); fail('preservation_candidate_read_unavailable') }
  await fence()
  if (preflight?.ok !== true && ['preservation_native_claim_limit_exhausted', 'preservation_claim_history_missing', 'preservation_guard_already_claimed'].includes(preflight?.code)) fail(preflight.code)
  const rawStatus = await agent.readTaskStatusRaw()
  await fence()
  const status = typeof rawStatus === 'string' ? JSON.parse(rawStatus) : rawStatus
  const baseline = batchWatermark(status)
  const journal = nativeAdmissionJournal(status?.admission_journal)
  if (!await nativeIdle(agent, fence) || !baseline || !baseline.idle || baseline.queue_length !== 0
    || baseline.generation !== pending.baseline?.generation || baseline.max_batch_id !== pending.baseline?.max_batch_id
    || !journal.known || journal.unresolved || journal.records.some(row => row.operation_key === pending.operation_key)) fail('preservation_pre_admission_receipt_boundary_unproven')
  const envelope = normalizeFluidAdmission({ version: 2, operation_key: pending.operation_key, attempt_id: pending.attempt_id,
    ordinal: pending.ordinal, signature: pending.signature,
    request_id: pending.request_id, board_step_id: agent.memory.currentPlan(key)?.task_board?.active_step_id,
    owner: { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id,
      semantic_step_id: step.semantic_step_id ?? step.step_id, actor_id: fresh.actor_id, actor_epoch: fresh.actor_epoch },
    baseline: fresh, operation: operations[0], candidate: preflight?.ok === true ? preflight.preservation_join : undefined,
    native_idle: true, native_generation: baseline.generation, native_max_batch_id: baseline.max_batch_id, created_at: Date.now() }, plan, step)
  if (!envelope) fail('preservation_candidate_join_unproven')
  await fence()
  if (!agent.memory.recordPreservationAdmission?.(key, envelope)) fail(Object.keys(plan.execution.preservation_admissions ?? {}).length >= 64
    ? 'preservation_admission_limit_exhausted' : 'preservation_admission_record_refused')
  await agent.persistState({ strict: true })
  await fence()
  if (!await nativeIdle(agent, fence)) fail('preservation_admission_native_busy')
  await agent.traceEvent('contract.fluid_admission_prepared', { request_id: envelope.request_id, goal_id: plan.goal_id,
    plan_id: plan.plan_id, step_id: step.step_id, operation_key: envelope.operation_key,
    reason: 'native_candidate_single_additive_join_before_transport' })
  await fence()
  const final = batchWatermark(await agent.readTaskStatusRaw())
  await fence()
  if (!final?.idle || final.queue_length !== 0 || final.generation !== baseline.generation
    || final.max_batch_id !== baseline.max_batch_id || !await nativeIdle(agent, fence)) fail('preservation_pre_admission_boundary_changed')
  await fence()
  return envelope
}

// The frozen edge endpoint is protected even when it is not separately named
// in preserve. Bulk cut/clear/opaque composites carry no complete affected-ID
// witness in this protocol, so they cannot prove preservation before transport.
export function fluidPreservationMutationUnsafe(proof, operations, extraEntities = []) {
  const entities = (proof?.preserved ?? []).flatMap(row => [row.entity,
    ...(row.fluid?.storages ?? []).flatMap(storage => storage.ports.flatMap(port => port.target ? [port.target.entity] : []))])
  entities.push(...extraEntities)
  return (operations ?? []).some(operation =>
    ['clear_construction_area', 'reserve_construction_area', 'prepare_pump_site', 'execute_construction_plan'].includes(operation.name)
    || ['rotate_entity', 'mine_entity_exact'].includes(operation.name) && entities.some(entity => entity.unit_number === operation.args?.unit_number)
    || operation.name === 'mine_entity' && entities.some(entity => entity.name === operation.args?.entity_name))
}

function fluidPreservationEntities(planning, plan, step, effective) {
  const entities = []
  const prefix = new Set(plan.carried_forward_evidence ?? [])
  for (const origin of planning.plans ?? []) {
    if (origin.goal_id !== plan.goal_id) continue
    for (const prior of origin.steps ?? []) {
      const same = origin.plan_id === plan.plan_id && prior.step_id === step.step_id
      const preceding = origin.plan_id === plan.plan_id && origin.steps.indexOf(prior) < plan.active_step_index
        || prefix.has(`${origin.plan_id}:${prior.step_id}`)
      if (!same && !(preceding && origin.execution.step_progress?.[prior.step_id]?.status === 'completed'
        && origin.execution.step_progress[prior.step_id].contract_satisfied === true)) continue
      if (!obligationProofOrigin(planning, prior)) continue
      for (const raw of Object.values(origin.execution.preservation_admissions ?? {})) {
        const admission = normalizeFluidAdmission(raw, origin, prior)
        if (!admission || admission.owner.actor_id !== effective.actor_id || admission.owner.actor_epoch !== effective.actor_epoch) continue
        entities.push(...admission.candidate.protected_geometry.map(row => row.entity))
      }
      for (const raw of origin.execution.preservation_certificates ?? []) {
        const certificate = normalizeFluidCertificate(raw, origin, prior)
        if (certificate && certificate.proof.actor_id === effective.actor_id && certificate.proof.actor_epoch === effective.actor_epoch) entities.push(certificate.built.entity)
      }
    }
  }
  return entities
}

async function reconcileFluidAddition(agent, plan, step, fresh, fence) {
  if (step.obligation_proof?.version !== 2) return undefined
  const admissions = plan.execution.preservation_admissions ?? {}
  const certificates = plan.execution.preservation_certificates ?? []
  const board = agent.memory.currentPlan(agent.activePlanKey())?.task_board
  for (const raw of Object.values(admissions)) {
    if (raw?.owner?.step_id !== step.step_id || certificates.some(row => row.admission_key === raw.operation_key)) continue
    const envelope = normalizeFluidAdmission(raw, plan, step)
    if (!envelope) return false
    const row = [...(board?.evidence ?? [])].reverse().find(row => {
      if (row.kind !== 'operation_receipt' || row.step_id !== board.active_step_id) return false
      try { return JSON.parse(row.summary).admitted_batch?.operation_key === envelope.operation_key } catch { return false }
    })
    if (!row) continue
    const receipt = JSON.parse(row.summary)
    const id = receipt.basic_operation?.placed_unit_number
    if (!Number.isSafeInteger(id)) return false
    let built
    try { built = preservationGeometry(JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getEntityGeometry', { unit_number: id })))), id) }
    catch { await fence(); return false }
    await fence()
    if (!fluidAdditionProof(envelope, receipt, built, fresh, plan, step)) return false
    const proof = { ...fresh, binding: step.obligation_proof.binding }
    const certificate = normalizeFluidCertificate({ admission_key: envelope.operation_key, step_id: step.step_id,
      ref: row.ref, receipt, built, proof, certified_at: Date.now() }, plan, step, { seal: true })
    if (!certificate || !agent.memory.certifyPreservationAddition?.(agent.activePlanKey(), certificate)) return false
    await agent.persistState({ strict: true })
    await fence()
    await agent.traceEvent('contract.fluid_addition_certified', { request_id: agent.traceRequest?.id, goal_id: plan.goal_id,
      plan_id: plan.plan_id, step_id: step.step_id, operation_key: envelope.operation_key, placed_unit_number: id,
      reason: 'pre_admission_witness_exact_receipt_reciprocal_native_join', replayed: false })
    await fence()
    return true
  }
  return undefined
}

export function stepCloseSettlementUnsafe(agent) {
  return agent.currentPendingAmendment() ? 'pending_amendment'
    : agent.batchInFlight ? 'batch_in_flight'
      : agent.memory.pendingOperation?.(agent.activePlanKey()) ? 'pending_operation' : undefined
}

export async function verifyPreservationBeforeClose(agent) {
  const plan = getActivePlan(agent.memory.planningState?.(agent.activePlanKey()))
  const step = plan?.steps?.[plan.active_step_index]
  if (!step?.obligations && step?.obligation_protocol !== 1) return { ok: true }
  const owner = agent.captureCheckpointOwner()
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    if (stepCloseSettlementUnsafe(agent)) throw new Error('preservation_settlement_not_safe')
  }
  if (!obligationProofOrigin(agent.memory.planningState(agent.activePlanKey()), step)) return { ok: false, reason: 'preservation_provenance_unproven' }
  if (stepCloseSettlementUnsafe(agent)) return { ok: false, reason: 'preservation_settlement_not_safe' }
  try {
    if (!await nativeIdle(agent, fence)) return { ok: false, reason: 'preservation_native_not_idle' }
    const fresh = await captureObligationProof(agent, step.obligations, fence)
    await fence()
    if (!await nativeIdle(agent, fence)) return { ok: false, reason: 'preservation_native_not_idle' }
    if (stepCloseSettlementUnsafe(agent)) return { ok: false, reason: 'preservation_settlement_not_safe' }
    if (!await reconcilePreservationProof(agent, step, fresh, fence)) return { ok: false, reason: 'preservation_baseline_changed' }
    // Reconciliation may persist/trace newly resolved native knowledge. Neither
    // ownership nor an earlier idle sample fences a same-owner amendment or
    // newly outstanding work arriving during those awaits.
    if (!await nativeIdle(agent, fence)) return { ok: false, reason: 'preservation_native_not_idle' }
    await fence()
    return { ok: true }
  } catch (error) {
    await agent.assertCheckpointOwnerCurrent(owner)
    if (stepCloseSettlementUnsafe(agent)) return { ok: false, reason: 'preservation_settlement_not_safe' }
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
  if (settled.completionDeferred) return settled.completionDeferred
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
