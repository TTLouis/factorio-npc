import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { committedFactoryCellIntent, readFactoryCellIntent, factoryCellIntentSignature, factoryIntentAssignment, factoryIntentMembers, factoryIntentOutputs, factoryIntentPorts } from './factory-cell-intent.mjs'
import { FACTORY_REGISTRY_LIMITS, FactoryRegistryError } from './factory-registry.mjs'
import { placedEntityName } from './operation-reconciliation.mjs'
import { prepareFactoryCellHost } from './factory-cell-tools.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'
import { reconcileFactoryCellUse, readFactoryProducerRecipe, factoryNativeOutput, factoryEstablishmentGrant, factoryDirectFeedRecipe, factoryStepRequirement } from './factory-cell-use.mjs'
import { REFUSAL_CLASS } from './refusal-class.mjs'
import { validateFactoryMiningSource } from './factory-cell-observation.mjs'

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

// The mod keeps one exact placement result per batch, so placement custody is
// derived only for a single-operation placement batch. A direct-feed step needs
// that custody for every machine it enrolls; without an explicit intent (which
// keeps its own pre-send refusal) a mixed or multi-placement batch is refused
// before any native read or send as a model-correctable argument error.
export function directFeedSingletonPlacementRefusal(agent, operations) {
  const index = operations.findIndex(placement)
  if (index < 0 || operations.length === 1) return undefined
  const plan = getActivePlan(agent.memory.planningState?.(agent.activePlanKey()))
  const legacy = agent.memory.currentPlan?.(agent.activePlanKey())
  const step = plan?.steps?.[plan.active_step_index] ?? legacy?.task_board?.steps?.[legacy.task_board.active_index]
  if (!step || committedFactoryCellIntent(step) || factoryStepRequirement(step)?.kind !== 'direct_feed') return undefined
  const second = operations.findIndex((op, i) => i > index && placement(op))
  const refused = second >= 0 ? second : index === 0 ? 1 : index
  return { ok: false, code: 'factory_direct_feed_single_placement_required', refusal_class: REFUSAL_CLASS.ARGUMENT, stage: 'preflight',
    operation_index: refused, operation: operations[refused]?.name, placements: operations.filter(placement).length, operations: operations.length,
    correction_message: '[HARNESS] Refused before admission (factory_direct_feed_single_placement_required); no operation from this batch ran. '
      + 'This step builds a direct-feed pair, and the game returns an exact placement receipt for only one placement per batch, so each machine placement must be the only operation in its batch. '
      + 'Resubmit the same step: one placement per batch, with any other operations in separate batches.' }
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
  const key = agent.activePlanKey(); const state = agent.memory.planningState?.(key)
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
    if (!intent) {
      if (i === (draft.currentStep ?? 0)) await reconcileFactoryCellUse(agent, { step: { execution_guidance: guidance, completion_contract: draft.stepCompletions?.[i]?.checkpoint }, phase: 'draft' })
      continue
    }
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
  const placements = operations.filter(placement)
  if (!placements.length) return undefined
  const current = active(agent)
  const legacy = agent.memory.currentPlan?.(agent.activePlanKey())
  const guidance = current.step?.execution_guidance ?? legacy?.task_board?.steps?.[legacy.task_board.active_index]?.execution_guidance
  // Explicit historical v1 replay has no new factory adoption authority. Live
  // protocol-3 placements always enter exact world/receipt capture below.
  if (agent.completionProtocolVersion === 1 && !current.intent && !guidance?.materialSupply
    && !(agent.memory.factoryTemporaryIntents?.() ?? []).length
    && ![...(agent.memory.productionTasks?.values() ?? [])].some(task => task.status !== 'complete')) return undefined
  if (current.intent && operations.some(op => op.name === 'execute_construction_plan')) fail('factory_enrollment_single_placement_required')
  if (current.intent && placements.length && (placements.length !== 1 || operations.length !== 1)) fail('factory_enrollment_single_placement_required')
  if (operations.length !== 1 || placements.length !== 1) return undefined
  if (current.intent) bound(agent)
  return prepareFactoryCellHost(agent, (_observer, access) => {
    const scope = access.readContext()
    if (current.intent) {
      const name = placedEntityName(operations[0], preflight?.[0])
      const intended = factoryIntentMembers(current.intent).filter(member => member.entity === name)
      if (!intended.length) fail('factory_enrollment_unexpected_member')
      const receipts = scopeReceipts(agent, current.state, current.step)
      if (receipts.filter(row => row.name === name).length >= intended.length) fail('factory_enrollment_duplicate_placement')
      const capacity = agent.memory.factoryPlacementCapacity()
      if (capacity.used >= capacity.limit) fail('factory_placement_capacity')
      if (agent.memory.getFactoryRegistry().cells.length >= FACTORY_REGISTRY_LIMITS.cells) fail('factory_registry_capacity')
    }
    return scope
  }).execute()
}

function membersForIntent(agent, current, scope) {
  const receipts = scopeReceipts(agent, current.state, current.step)
  const intended = factoryIntentMembers(current.intent)
  const assigned = new Set()
  return intended.map(member => {
    const matches = receipts.filter(row => row.name === member.entity).sort((a, b) => a.tick - b.tick || a.operation_id - b.operation_id || a.receipt_id.localeCompare(b.receipt_id))
    const expected = intended.filter(row => row.entity === member.entity).length
    if (matches.length !== expected) fail(matches.length > expected ? 'factory_enrollment_member_ambiguous' : 'factory_enrollment_placement_missing')
    const row = matches.find(receipt => !assigned.has(receipt.receipt_id))
    assigned.add(row.receipt_id)
    const original = current.state.plans.find(plan => plan.plan_id === row.plan_id && plan.plan_version === row.plan_version && plan.goal_id === row.goal_id)
    const step = original?.steps.find(step => step.step_id === row.step_id && (step.semantic_step_id ?? step.step_id) === row.semantic_step_id)
    if (!step || !committedFactoryCellIntent(step) || factoryCellIntentSignature(step.execution_guidance) !== current.signature
      || row.surface_index !== scope.surface_index || row.force_index !== scope.force_index) fail('factory_enrollment_placement_intent_mismatch')
    return { unit_number: row.unit_number, name: row.name, position: row.position, surface_index: row.surface_index, force_index: row.force_index,
      provenance: { receipt_id: row.receipt_id } }
  })
}

// Typed finite production can establish a newly placed machine without an
// optional model cell declaration. Old or random world entities cannot enroll.
export async function enrollFactoryProductionProducers(agent, producers) {
  if (!Array.isArray(producers) || producers.length > 16 || producers.some(row => !Number.isSafeInteger(row.unit_number) || typeof row.recipe_name !== 'string')) fail('factory_cell_producer_invalid')
  if (!producers.length) return []
  bound(agent)
  const current = active(agent); const owner = agent.captureCheckpointOwner()
  const unassigned = producers.filter(producer => !agent.memory.getFactoryOperationalRegistry().cells.some(cell => cell.members.some(member => member.unit_number === producer.unit_number)))
  if (!unassigned.length) return []
  if (!agent.stateFile) fail('factory_enrollment_persistence_unavailable')
  if (current.intent) {
    await ensureCommittedFactoryCellBeforeClose(agent, owner)
    return []
  }
  const enrolled = []
  for (const producer of unassigned) {
    const result = await prepareFactoryCellHost(agent, async (observer, access) => {
      const runtime = observer.runtime; const scope = runtime.scope()
      const matches = scopeReceipts(agent, current.state, current.step).filter(row => row.unit_number === producer.unit_number)
      if (matches.length !== 1) fail('factory_cell_producer_placement_unproven')
      const receipt = matches[0]
      if (agent.memory.factoryTemporaryAssets().some(asset => asset.receipt_id === receipt.receipt_id)
        || agent.memory.getFactoryRegistry().cells.some(cell => cell.members.some(member => member.unit_number === producer.unit_number))) fail('factory_enrollment_member_assigned')
      const native = await observer.observePlacement(receipt.receipt_id)
      const row = native.members[0]
      const recipe = await readFactoryProducerRecipe(agent, access, row, producer.recipe_name)
      if (!recipe.products?.length || recipe.products.length > 32 || recipe.products.some(product => !['item', 'fluid'].includes(product.type) || typeof product.name !== 'string')) fail('factory_cell_producer_output_unknown')
      const ports = recipe.products.map((product, index) => ({ port_id: `output-${index + 1}`, direction: 'output', kind: product.type, resource: product.name }))
      if (ports.some(port => !factoryNativeOutput(row, port))) fail('factory_cell_producer_output_unknown')
      const member = runtime.recordPlacement({ unit_number: receipt.unit_number, name: receipt.name, position: receipt.position,
        surface_index: receipt.surface_index, force_index: receipt.force_index, provenance: { receipt_id: receipt.receipt_id } }, scope)
      const declaration = { surface_index: scope.surface_index, force_index: scope.force_index,
        assignment: { products: [...new Set(ports.map(port => port.resource))], purpose: `Production for semantic step ${scope.semantic_step_id}`, method: `native_recipe:${producer.recipe_name}` },
        members: [member], ports, origin: runtime.origin() }
      access.fence(); runtime.assertScope(scope)
      const cell = runtime.registerCell(declaration, scope); access.acceptPublishedRevision()
      try { await agent.persistState({ strict: true }) }
      catch (error) { agent.memory.invalidateFactoryEnrollmentPersistence(); throw error }
      agent.assertCheckpointOwnerIdentity(owner); access.fence()
      await agent.traceEvent('factory_cell.enrolled_from_production', { cell_id: cell.cell_id, receipt_id: receipt.receipt_id, unit_number: receipt.unit_number,
        recipe_name: producer.recipe_name, goal_id: scope.goal_id, semantic_step_id: scope.semantic_step_id, native_tick: native.tick, commissioning: 'unverified' })
      access.fence()
      return cell
    }).execute()
    enrolled.push(result)
  }
  return enrolled
}

// Infer an omitted declaration only from new, retained placements in this
// unchanged semantic job. Existing/legacy entities never become candidates.
export async function enrollImplicitDirectFeed(agent, requirement, { targets = [] } = {}) {
  const current = active(agent)
  if (current.intent || current.step?.execution_guidance?.materialSupply?.mode !== 'direct_feed'
    || current.step.execution_guidance.materialSupply.resource !== requirement.resource
    || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(current.plan?.status)) return undefined
  const registry = agent.memory.getFactoryOperationalRegistry()
  if (targets.length && targets.every(unit => registry.cells.some(cell => cell.members.some(member => member.unit_number === unit)))) return undefined
  const receipts = scopeReceipts(agent, current.state, current.step).filter(receipt =>
    agent.memory.factoryPlacementAvailability({ unit_number: receipt.unit_number, entity_name: receipt.name }).status === 'unassigned'
    && !agent.memory.factoryTemporaryAssets().some(asset => asset.receipt_id === receipt.receipt_id))
  if (receipts.length < 2) return undefined
  if (receipts.length > 32) fail('factory_cell_resolution_capacity')
  const checkGrant = factoryEstablishmentGrant(agent, requirement)
  if (!checkGrant) fail('factory_establishment_authority_missing')
  if (!agent.stateFile) fail('factory_enrollment_persistence_unavailable')
  const owner = agent.captureCheckpointOwner()
  return prepareFactoryCellHost(agent, async (observer, access) => {
    const runtime = observer.runtime; const scope = runtime.scope()
    const members = receipts.map(receipt => runtime.recordPlacement({ unit_number: receipt.unit_number, name: receipt.name,
      position: receipt.position, surface_index: receipt.surface_index, force_index: receipt.force_index, provenance: { receipt_id: receipt.receipt_id } }, scope))
    const provisional = { surface_index: scope.surface_index, force_index: scope.force_index,
      assignment: { products: [requirement.resource], purpose: 'Inspect retained establishment receipts', method: 'provisional_direct_feed' },
      members, ports: [], origin: runtime.origin() }
    const observed = await observer.observeCandidate(provisional)
    checkGrant(); access.fence()
    const pairs = []
    for (const source of observed.native.members) {
      const mined = validateFactoryMiningSource(source, requirement.resource)
      if (mined.state !== 'compatible' || !mined.item_only || source.item_routes?.state !== 'known'
        || source.item_routes.truncated !== false || !Array.isArray(source.item_routes.routes)) continue
      const drops = source.item_routes.routes.filter(route => route.kind === 'drop')
      if (drops.length !== 1 || drops[0].state !== 'connected') continue
      const target = observed.native.members.find(row => ['unit_number', 'name', 'surface_index', 'force_index'].every(field => row.locator[field] === drops[0].target?.[field])
        && row.locator.position.x === drops[0].target?.position?.x && row.locator.position.y === drops[0].target?.position?.y)
      if (!target || targets.some(unit => ![source.locator.unit_number, target.locator.unit_number].includes(unit))) continue
      const recipe = factoryDirectFeedRecipe(target, mined.products)
      if (!recipe || !Array.isArray(recipe.products) || !recipe.products.length || recipe.products.length > 32
        || recipe.products.some(product => product.type !== 'item' || typeof product.name !== 'string')) continue
      const ports = recipe.products.map((product, index) => ({ port_id: `output-${index + 1}`, direction: 'output', kind: 'item', resource: product.name }))
      if (ports.some(port => !factoryNativeOutput(target, port))) continue
      pairs.push({ source, target, recipe, ports })
    }
    if (pairs.length !== 1) fail(pairs.length ? 'factory_enrollment_member_ambiguous' : 'factory_enrollment_native_unverified')
    const pair = pairs[0]
    const declaration = { surface_index: scope.surface_index, force_index: scope.force_index,
      assignment: { products: [...new Set(pair.ports.map(port => port.resource))], purpose: `Direct feed for semantic step ${scope.semantic_step_id}`,
        method: `native_direct_feed:${requirement.resource}:${pair.recipe.name}` },
      members: [pair.source, pair.target].map(row => members.find(member => member.unit_number === row.locator.unit_number)),
      ports: pair.ports, origin: runtime.origin() }
    checkGrant(); access.fence(); runtime.assertScope(scope)
    const cell = runtime.registerCell(declaration, scope); access.acceptPublishedRevision()
    try { await agent.persistState({ strict: true }) } catch (error) { agent.memory.invalidateFactoryEnrollmentPersistence(); throw error }
    agent.assertCheckpointOwnerIdentity(owner); checkGrant(); access.fence()
    await agent.traceEvent('factory_cell.enrolled_from_direct_feed', { ...scope, cell_id: cell.cell_id,
      receipt_ids: declaration.members.map(member => member.provenance.receipt_id), commissioning: 'unverified', delivery_ready: false })
    access.fence(); checkGrant()
    return cell
  }).execute()
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
  if (!current.intent) return reconcileFactoryCellUse(agent, { phase: 'close' })
  bound(agent)
  agent.assertCheckpointOwnerIdentity(owner)
  const result = await prepareFactoryCellHost(agent, async (observer, access) => {
    const runtime = observer.runtime; const scope = runtime.scope()
    const rawMembers = membersForIntent(agent, current, scope)
    const members = rawMembers.map(member => runtime.recordPlacement(member, scope))
    const enrollment = { goal_id: scope.goal_id, semantic_step_id: scope.semantic_step_id, intent_signature: current.signature,
      receipt_ids: members.map(member => member.provenance.receipt_id) }
    if (current.intent.kind === 'production_block') {
      enrollment.member_roles = factoryIntentMembers(current.intent).map((member, index) => ({ role: member.role, receipt_id: enrollment.receipt_ids[index] }))
      enrollment.output_roles = factoryIntentOutputs(current.intent).map((output, index) => ({ port_id: factoryIntentPorts(current.intent)[index].port_id, role: output.role }))
    }
    const declaration = { surface_index: scope.surface_index, force_index: scope.force_index,
      assignment: factoryIntentAssignment(current.intent), members,
      ports: factoryIntentPorts(current.intent), origin: runtime.origin(), enrollment }
    const registry = agent.memory.getFactoryRegistry()
    const previous = registry.cells.find(cell => cell.enrollment?.goal_id === scope.goal_id && cell.enrollment.semantic_step_id === scope.semantic_step_id)
    for (const member of members) {
      const assigned = registry.cells.find(cell => cell.members.some(row => row.unit_number === member.unit_number))
      if (assigned && assigned.cell_id !== previous?.cell_id) fail('factory_enrollment_member_assigned')
    }
    if (previous && ['surface_index', 'force_index', 'assignment', 'members', 'ports', 'enrollment'].some(field => JSON.stringify(field === 'ports' ? previous.metadata_history?.[0]?.ports ?? previous.ports : previous[field]) !== JSON.stringify(declaration[field]))) fail('factory_enrollment_conflict')
    if (!previous && registry.cells.length >= FACTORY_REGISTRY_LIMITS.cells) fail('factory_registry_capacity')
    const observation = await observer.observeCandidate(declaration, current.intent.kind === 'direct_feed'
      ? { source_unit_number: members[0].unit_number, target_unit_number: members[1].unit_number, product: current.intent.product } : undefined)
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
  await reconcileFactoryCellUse(agent, { phase: 'close' })
  agent.assertCheckpointOwnerIdentity(owner)
  return result
}
