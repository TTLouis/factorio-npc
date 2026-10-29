import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { committedFactoryCellIntent, readFactoryCellIntent, factoryCellIntentSignature } from './factory-cell-intent.mjs'
import { FACTORY_REGISTRY_LIMITS, FactoryRegistryError } from './factory-registry.mjs'
import { placedEntityName } from './operation-reconciliation.mjs'
import { prepareFactoryCellHost } from './factory-cell-tools.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'

const fail = code => { throw new FactoryRegistryError(code, code) }
const placement = op => ['place_entity', 'place_candidate'].includes(op?.name)

export class FactoryCellBoundaryError extends FactoryRegistryError {
  constructor(cause, phase) {
    super(cause.code, cause.message)
    this.name = 'FactoryCellBoundaryError'
    this.cause = cause
    this.failure_code = cause.code
    this.pause_class = PAUSE_CLASS.GUARD
    this.detail = { factory_boundary: phase, current_batch_sent: false, prior_world_effects: 'not_reclassified',
      ...(phase === 'draft' ? { draft_committed_at_boundary: false } : {}) }
  }
}

// Only these two internal factory boundaries stamp expected host refusals.
// Arbitrary errors/strings elsewhere retain existing request classification.
export async function atFactoryCellBoundary(agent, phase, action) {
  const owner = agent.captureCheckpointOwner()
  try { return await action() }
  catch (cause) {
    if (!(cause instanceof FactoryRegistryError) && cause?.code !== 'factory_cell_intent_invalid') throw cause
    if (!/^factory_[a-z0-9_]{2,70}$/.test(cause.code)) throw cause
    agent.assertCheckpointOwnerIdentity(owner)
    const failure = new FactoryCellBoundaryError(cause, phase)
    await agent.traceEvent('factory_cell.boundary_refused', { request_id: owner.requestTrace?.id, goal_id: owner.goalId,
      plan_id: owner.planId, step_id: owner.stepId, code: failure.failure_code, pause_class: failure.pause_class, ...failure.detail })
    agent.assertCheckpointOwnerIdentity(owner)
    throw failure
  }
}
function active(agent) {
  const key = agent.activePlanKey(); const state = agent.memory.planningState(key)
  const plan = getActivePlan(state); const step = plan?.steps?.[plan.active_step_index]
  const intent = committedFactoryCellIntent(step)
  if (intent && (state.goal?.status !== 'active' || state.run?.paused || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status))) fail('factory_enrollment_authority_missing')
  return { key, state, plan, step, intent, signature: intent ? factoryCellIntentSignature(step.execution_guidance) : null }
}
function bound(agent) {
  if (agent.memory.factoryRegistryStatus().status !== 'initialized' || !agent.memory.factoryWorldBinding().world_id) fail('factory_enrollment_world_unbound')
}
function scopeReceipts(agent, state, step) {
  return agent.memory.factoryPlacementReceipts({ world_id: agent.memory.factoryWorldBinding().world_id,
    goal_id: state.goal.goal_id, semantic_step_id: step.semantic_step_id ?? step.step_id })
}

// A draft declaration is not authority. This prerequisite is checked before
// recordPlan/commit; existing listFactoryCells supplies bind-once initialization.
export async function validateFactoryCellDraft(agent, draft) {
  const briefs = draft.executionGuidance ?? []
  let declared = false
  for (const [i, guidance] of briefs.entries()) {
    const intent = readFactoryCellIntent(guidance)
    if (!intent) continue
    if (draft.assessmentOnly === true || draft.stepCompletions?.[i]?.kind !== 'deterministic') fail('factory_cell_intent_invalid')
    declared = true
  }
  if (!declared) return
  bound(agent)
  const owner = agent.captureCheckpointOwner()
  await prepareFactoryCellHost(agent, (_observer, access) => ({ world_id: access.readContext().world_id })).execute()
  agent.assertCheckpointOwnerIdentity(owner)
  await agent.persistState({ strict: true })
  agent.assertCheckpointOwnerIdentity(owner)
}

// Shared pre-send boundary, including intentless placements when a world is
// already UUID-bound. Never fill pending.surface_index from model arguments.
export async function factoryPlacementAdmissionScope(agent, operations, preflight) {
  const current = active(agent)
  const placements = operations.filter(placement)
  if (current.intent && operations.some(op => op.name === 'execute_construction_plan')) fail('factory_enrollment_single_placement_required')
  if (current.intent && placements.length && (placements.length !== 1 || operations.length !== 1)) fail('factory_enrollment_single_placement_required')
  if (operations.length !== 1 || placements.length !== 1) return undefined
  if (!current.intent && agent.memory.factoryRegistryStatus().status !== 'initialized') return undefined
  bound(agent)
  return prepareFactoryCellHost(agent, (_observer, access) => {
    const scope = access.readContext()
    if (current.intent) {
      const name = placedEntityName(operations[0], preflight?.[0])
      if (![current.intent.sourceEntity, current.intent.targetEntity].includes(name)) fail('factory_enrollment_unexpected_member')
      const receipts = scopeReceipts(agent, current.state, current.step)
      if (receipts.some(row => row.name === name)) fail('factory_enrollment_duplicate_placement')
      const capacity = agent.memory.factoryPlacementCapacity()
      if (capacity.used >= capacity.limit) fail('factory_placement_capacity')
      if (agent.memory.getFactoryRegistry().cells.length >= FACTORY_REGISTRY_LIMITS.cells) fail('factory_registry_capacity')
    }
    return scope
  }).execute()
}

function membersForIntent(agent, current, scope) {
  const receipts = scopeReceipts(agent, current.state, current.step)
  return [current.intent.sourceEntity, current.intent.targetEntity].map(name => {
    const matches = receipts.filter(row => row.name === name)
    if (matches.length !== 1) fail(matches.length ? 'factory_enrollment_member_ambiguous' : 'factory_enrollment_placement_missing')
    const row = matches[0]
    const original = current.state.plans.find(plan => plan.plan_id === row.plan_id && plan.plan_version === row.plan_version && plan.goal_id === row.goal_id)
    const step = original?.steps.find(step => step.step_id === row.step_id && (step.semantic_step_id ?? step.step_id) === row.semantic_step_id)
    if (!step || !committedFactoryCellIntent(step) || factoryCellIntentSignature(step.execution_guidance) !== current.signature
      || row.surface_index !== scope.surface_index || row.force_index !== scope.force_index) fail('factory_enrollment_placement_intent_mismatch')
    return { unit_number: row.unit_number, name: row.name, position: row.position, surface_index: row.surface_index, force_index: row.force_index,
      provenance: { receipt_id: row.receipt_id } }
  })
}

// An already satisfied original goal may make wholly unbuilt investment steps
// moot. It cannot abandon actual members of an accepted assignment obligation.
export async function ensureFactoryCellBeforeGoalCompletion(agent, owner) {
  const status = agent.memory.factoryGoalEnrollmentStatus(agent.activePlanKey())
  if (!status.required) return { ok: true, ...status }
  // Recording the goal proof after an already completed plan needs no second
  // step authority. An active committed step always revalidates native facts,
  // including a durable assignment restored after cancellation or restart.
  const plan = getActivePlan(agent.memory.planningState(agent.activePlanKey()))
  if (status.enrolled && plan?.status === PLAN_STATUS.COMPLETED) return { ok: true, ...status }
  return ensureCommittedFactoryCellBeforeClose(agent, owner)
}

// All verified step-close routes call this before outcome authority. This only
// enrolls the already configured pair; it never advances a step or repairs it.
export async function ensureCommittedFactoryCellBeforeClose(agent, owner) {
  const current = active(agent)
  if (!current.intent) return { ok: true, applicable: false }
  bound(agent)
  agent.assertCheckpointOwnerIdentity(owner)
  return prepareFactoryCellHost(agent, async (observer, access) => {
    const runtime = observer.runtime; const scope = runtime.scope()
    const rawMembers = membersForIntent(agent, current, scope)
    const members = rawMembers.map(member => runtime.recordPlacement(member, scope))
    const enrollment = { goal_id: scope.goal_id, semantic_step_id: scope.semantic_step_id, intent_signature: current.signature,
      receipt_ids: members.map(member => member.provenance.receipt_id) }
    const declaration = { surface_index: scope.surface_index, force_index: scope.force_index,
      assignment: { products: [current.intent.product], purpose: current.intent.purpose, method: 'direct_feed' }, members,
      ports: [{ port_id: 'output', direction: 'output', kind: 'item', resource: current.intent.product }], origin: runtime.origin(), enrollment }
    const registry = agent.memory.getFactoryRegistry()
    const previous = registry.cells.find(cell => cell.enrollment?.goal_id === scope.goal_id && cell.enrollment.semantic_step_id === scope.semantic_step_id)
    for (const member of members) {
      const assigned = registry.cells.find(cell => cell.members.some(row => row.unit_number === member.unit_number))
      if (assigned && assigned.cell_id !== previous?.cell_id) fail('factory_enrollment_member_assigned')
    }
    if (previous && ['surface_index', 'force_index', 'assignment', 'members', 'ports', 'enrollment'].some(field => JSON.stringify(previous[field]) !== JSON.stringify(declaration[field]))) fail('factory_enrollment_conflict')
    if (!previous && registry.cells.length >= FACTORY_REGISTRY_LIMITS.cells) fail('factory_registry_capacity')
    const observation = await observer.observeCandidate(declaration, { source_unit_number: members[0].unit_number, target_unit_number: members[1].unit_number, product: current.intent.product })
    agent.assertCheckpointOwnerIdentity(owner); access.fence(); runtime.assertScope(scope)
    if (observation.state !== 'compatible') {
      await agent.traceEvent('factory_cell.enrollment_refused', { request_id: scope.request_id, goal_id: scope.goal_id, plan_id: scope.plan_id,
        step_id: scope.step_id, intent_signature: current.signature, receipt_ids: enrollment.receipt_ids,
        state: observation.state, codes: observation.checks.map(row => row.code), native_tick: observation.native.tick })
      agent.assertCheckpointOwnerIdentity(owner); access.fence()
      fail(observation.state === 'mismatch' ? 'factory_enrollment_native_mismatch' : 'factory_enrollment_native_unverified')
    }
    // Final scope/revision check and publication are synchronous. The immutable
    // enrollment key is part of the cell, so no separate ledger can half-commit.
    const cell = runtime.registerCell(declaration, scope)
    access.acceptPublishedRevision()
    try { await agent.persistState({ strict: true }) }
    catch (error) {
      agent.memory.invalidateFactoryEnrollmentPersistence()
      await agent.traceEvent('factory_cell.enrollment_persistence_failed', { request_id: scope.request_id, goal_id: scope.goal_id,
        plan_id: scope.plan_id, step_id: scope.step_id, cell_id: cell.cell_id, receipt_ids: enrollment.receipt_ids, native_effect: 'placements_already_applied' })
      throw error
    }
    agent.assertCheckpointOwnerIdentity(owner); access.fence()
    await agent.traceEvent('factory_cell.enrolled', { request_id: scope.request_id, goal_id: scope.goal_id, plan_id: scope.plan_id, step_id: scope.step_id,
      cell_id: cell.cell_id, intent_signature: current.signature, receipt_ids: enrollment.receipt_ids, duplicate: Boolean(previous),
      native_tick: observation.native.tick, commissioning: 'unverified', throughput: 'unverified', dependencies: 'unverified' })
    agent.assertCheckpointOwnerIdentity(owner); access.fence()
    return { ok: true, applicable: true, cell_id: cell.cell_id, duplicate: Boolean(previous) }
  }).execute()
}
