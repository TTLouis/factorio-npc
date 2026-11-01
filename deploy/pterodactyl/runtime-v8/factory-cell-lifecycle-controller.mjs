import { emptyFurnaceAssignment } from './factory-reassignment.mjs'
import { authorizationOf, checkGrant, entityProtection, activeReservations } from './authorization.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { factoryMetadataDigest as digest } from './factory-dependencies.mjs'
import { prepareFactoryCellHost, prepareFactoryCellReconciliationHost } from './factory-cell-tools.mjs'
import { validateFactoryCellObservation } from './factory-cell-observation.mjs'
import { factoryLifecycleRuntime } from './factory-cell-lifecycle-runtime.mjs'
import { verifyFactoryRemovalReadiness } from './factory-cell-lifecycle.mjs'
import { getActivePlan } from './planning-state.mjs'
import { boardPlanAlignment } from './board-plan-alignment.mjs'
import { deploymentStatus } from '../staging/supervisor-adapter.mjs'
import { operationSignature } from './operation-reconciliation.mjs'

// These entry points are internal host capabilities. Model declarations cannot
// supply evidence, completion flags, native facts or callbacks to this module.
const clone = value => structuredClone(value)
const fail = code => { throw new FactoryRegistryError(code, code) }
const exact = (a, b) => ['unit_number', 'name', 'surface_index', 'force_index'].every(key => a?.[key] === b?.[key])
  && a?.position?.x === b?.position?.x && a?.position?.y === b?.position?.y
const list = value => Array.isArray(value) ? value : value && Object.getPrototypeOf(value) === Object.prototype && !Object.keys(value).length ? [] : undefined
const locator = row => Object.fromEntries(['unit_number', 'name', 'position', 'surface_index', 'force_index'].map(key => [key, row[key]]))
const active = agent => {
  const state = agent.memory.planningState(agent.activePlanKey()); const plan = getActivePlan(state)
  return { state, plan, step: plan?.steps?.[plan.active_step_index] }
}
const closeProofs = new WeakMap()
const controllers = new WeakSet()
export const isFactoryLifecycleControllerActive = agent => controllers.has(agent)
export function captureFactoryLifecycleCloseProof(agent, owner, details) {
  agent.assertCheckpointOwnerIdentity(owner)
  const { state, plan, step } = active(agent)
  const contract = details?.contract; const results = details?.results
  const board = agent.memory.currentPlan?.(owner.key)?.task_board
  const boardStep = board?.steps?.[board.active_index]
  const offset = boardPlanAlignment(board, plan)
  const committedContract = boardStep && agent.persistedStepCheckpoint(board, boardStep.id)?.contract
  // Board IDs are presentation identities; the checkpoint owner carries the
  // immutable canonical step ID. Successor boards also retain verified prefix
  // steps, so bind the current indices through the canonical board alignment.
  if (details?.key !== agent.activePlanKey() || !step || step.step_id !== owner.stepId
    || offset === undefined || board?.active_index !== offset + owner.stepIndex || !boardStep || details.step?.id !== boardStep.id
    || !committedContract || !contract || digest(contract) !== digest(committedContract)
    || !contract || !['all', 'any'].includes(contract.mode) || !Array.isArray(contract.requirements) || !contract.requirements.length
    || !Array.isArray(results) || results.length !== contract.requirements.length
    || contract.requirements.some(requirement => results.filter(row => row.id === requirement.id && row.kind === requirement.kind).length !== 1)
    || !(contract.mode === 'any' ? results.some(row => row.satisfied === true) : results.every(row => row.satisfied === true))) fail('factory_cleanup_completion_unproven')
  // The actual deterministic close boundary owns the original evaluated result;
  // a serialized lookalike cannot recreate this live capability after restart.
  const proof = Object.freeze({})
  closeProofs.set(proof, { agent, owner, goal_id: state.goal.goal_id, semantic_step_id: step.semantic_step_id ?? step.step_id,
    receipt_id: `checkpoint/${step.step_id}/${digest({ contract, results })}`, contract: clone(contract), results: clone(results) })
  return proof
}
function affected(registry, cellId) {
  const ids = new Set([cellId]); let changed = true
  while (changed) {
    changed = false
    for (const edge of registry.dependencies) if (edge.supplier.kind === 'cell' && ids.has(edge.supplier.cell_id) && !ids.has(edge.consumer.cell_id)) {
      ids.add(edge.consumer.cell_id); changed = true
    }
  }
  return [...ids].sort()
}
function absence(row) {
  const facts = row?.absence_facts
  return facts?.state === 'known' && facts.scope === 'exact_locator' && facts.coverage === 'complete'
    && facts.absent === true && facts.truncated === false
}
function directConsumers(row, tick) {
  // This cut covers direct item endpoints only. Native type plus explicit
  // interface absence must exclude every other service; an empty item list
  // cannot prove that unregistered power/fluid/heat consumers do not exist.
  const endpoints = row?.endpoint_facts; const services = endpoints?.services
  const fluid = endpoints?.fluidboxes; const fluidEndpoints = list(fluid?.endpoints)
  const heat = services?.heat; const network = services?.electric_network
  if (!['container', 'furnace', 'mining-drill'].includes(row?.type) || endpoints?.schema_version !== 1
    || services?.electricity?.state !== 'not_applicable' || network?.state !== 'known' || network.present !== false
    || heat?.state !== 'not_applicable' || heat.input_source?.state !== 'known' || heat.input_source.present !== false
    || heat.buffer?.state !== 'known' || heat.buffer.present !== false
    || fluid?.state !== 'known' || fluid.truncated !== false || !fluidEndpoints || fluidEndpoints.length !== 0
    || row.progress_facts?.electricity_production?.producer === true
    || list(row.recipe?.products)?.some(product => product.type !== 'item')) fail('factory_lifecycle_consumer_domain_unknown')
  const facts = row?.consumer_facts; const consumers = list(facts?.consumers)
  if (facts?.schema_version !== 1 || facts.tick !== tick || facts.identity_scope !== 'enclosing_exact_member'
    || facts.scope !== 'direct_native_item_consumers' || facts.state !== 'known' || facts.coverage !== 'complete'
    || facts.truncated !== false || facts.unresolved !== false || !consumers || consumers.length > 128
    || consumers.some(item => item.state !== 'connected' || !['inserter_pickup', 'mining_drop', 'loader_container'].includes(item.relation))) fail('factory_lifecycle_consumers_unknown')
  return consumers
}

// Pure projection of already owner-checked raw native replies. Nothing here
// manufactures capacity, liveness, empty consumers or global disappearance.
export function projectFactoryLifecycleEvidence({ registry, cell, change, scope, observation, consumers = [], replacement, temporary = [], phase = 'begin', operation }) {
  const native = observation?.native
  if (native?.schema_version !== 1 || native.ok !== true || native.world_id !== scope.world_id || native.actor_id !== scope.actor_id
    || native.request_id !== scope.request_id || native.surface_index !== scope.surface_index || native.force_index !== scope.force_index
    || !Number.isSafeInteger(native.tick) || !Array.isArray(native.members)) fail('factory_lifecycle_native_unknown')
  if (cell.ports.some(port => port.direction === 'output' && !['item', 'fuel'].includes(port.kind))) fail('factory_lifecycle_consumer_domain_unknown')
  const current = cell.members.map(member => {
    const matches = native.members.filter(row => exact(row.locator, member)); if (matches.length !== 1 || matches[0].state !== 'observed') fail('factory_lifecycle_member_unknown')
    const row = matches[0]; const ready = row.removal_readiness
    const valid = verifyFactoryRemovalReadiness(ready) && ready.tick === native.tick && exact(ready.snapshot.target, member)
    return { ...clone(member), ...(valid ? { quality: ready.snapshot.target.quality, removal_snapshot: clone(ready.snapshot) } : {}),
      contents_known: valid, recovery_capacity: valid ? 'verified' : 'unknown' }
  })
  const remove = new Set(change.operations.filter(op => op.kind === 'remove').map(op => op.member.unit_number))
  const rows = []
  for (const member of cell.members) {
    const row = native.members.find(row => exact(row.locator, member))
    for (const link of directConsumers(row, native.tick)) {
      const linked = registry.cells.find(candidate => candidate.members.some(target => exact(target, link.consumer)))
      if (!linked) fail('factory_lifecycle_unregistered_consumer')
      if (linked.cell_id === cell.cell_id && (!remove.has(member.unit_number) || remove.has(link.consumer.unit_number))) continue
      // A disconnected old endpoint is never inferred from metadata. The
      // concrete removal cannot proceed while this native edge still exists.
      if (remove.has(member.unit_number)) fail('factory_lifecycle_active_consumer')
    }
  }
  for (const id of affected(registry, cell.cell_id).filter(id => id !== cell.cell_id)) {
    const consumer = registry.cells.find(row => row.cell_id === id); const observed = consumers.find(row => row.cell_id === id)
    if (consumer.state === 'retired' && consumer.members.length === 0) rows.push({ cell_id: id, state: 'ceased', verified: true, evidence_ref: `retired/${id}/${consumer.physical_revision}` })
    else if (!['retire', 'cleanup'].includes(change.kind) && observed?.state === 'compatible') rows.push({ cell_id: id, state: 'preserved', verified: true, evidence_ref: `native/${id}/${observed.native.tick}` })
    else fail('factory_lifecycle_consumer_unresolved')
  }
  const validation = validateFactoryCellObservation({ registry, cell, native })
  const temporaryComplete = change.kind === 'cleanup' && cell.members.every(member => temporary.some(asset => asset.unit_number === member.unit_number && asset.eligible === true))
  const replaced = replacement?.state === 'compatible' && replacement.cell && digest(replacement.cell.assignment) === digest(cell.assignment)
    && replacement.cell.cell_id !== cell.cell_id && replacement.cell.members.length > 0
  const job = temporaryComplete || replaced || !['retire', 'cleanup'].includes(change.kind) && validation.state === 'compatible'
  if (!job) fail('factory_lifecycle_job_unproven')
  const next = operation ?? (phase === 'begin' ? change.operations[0] : undefined)
  if (next?.kind === 'remove' && !current.some(member => exact(member, next.member) && member.quality === next.quality
    && member.contents_known === true && member.recovery_capacity === 'verified')) fail('factory_lifecycle_removal_unproven')
  if (next?.kind === 'remove' && !temporaryComplete && !replaced) {
    const survivors = { ...cell, members: cell.members.filter(member => !exact(member, next.member)) }
    const surviving = { ...native, members: native.members.filter(row => survivors.members.some(member => exact(row.locator, member))) }
    if (!survivors.members.length || validateFactoryCellObservation({ registry, cell: survivors, native: surviving }).state !== 'compatible') fail('factory_lifecycle_remaining_job_unproven')
  }
  const inventories = native.members.filter(row => verifyFactoryRemovalReadiness(row.removal_readiness)).map(row => row.removal_readiness.actor_inventory)
  if (inventories.some(value => digest(value) !== digest(inventories[0]))) fail('factory_lifecycle_actor_inventory_changed')
  return { world_id: scope.world_id, registry_revision: registry.revision, request_id: scope.request_id, actor_id: scope.actor_id,
    actor_epoch: scope.actor_epoch, session_id: scope.session_id, fresh: true, truncated: false, native_idle: true, pending: false, uncertain: false,
    tick: native.tick, members: current, consumers: { coverage: 'complete', truncated: false, unresolved: false, rows }, job_preserved: true,
    evidence_ref: `native/${scope.request_id}/${native.tick}/${digest(native)}`, assignment: clone(cell.assignment),
    ...(inventories.length ? { actor_inventory: clone(inventories[0]) } : {}),
    ...(temporaryComplete ? { redundancy: 'verified' } : {}), ...(phase === 'finish' ? { installation: 'verified' } : {}),
    raw: { observation: clone(native), consumer_observations: clone(consumers), ...(replacement ? { replacement: clone(replacement) } : {}) } }
}

async function acquire(agent, change, { phase = 'begin', transaction, pending, operation } = {}) {
  const owner = agent.captureCheckpointOwner()
  const prepare = action => pending ? prepareFactoryCellReconciliationHost(agent, pending, action) : prepareFactoryCellHost(agent, action)
  const gathered = await prepare(async (observer, access) => {
    const scope = access.readContext(); const registry = agent.memory.getFactoryOperationalRegistry()
    const cell = registry.cells.find(row => row.cell_id === change.cell_id); if (!cell) fail('factory_cell_unknown')
    const historical = agent.memory.getFactoryRegistry().cells.find(row => row.cell_id === cell.cell_id)
    const union = [...cell.members]
    for (const member of transaction?.members ?? []) if (!union.some(row => exact(row, member))) union.push(member)
    const declaration = Object.fromEntries(['surface_index', 'force_index', 'assignment', 'ports', 'origin', 'support'].filter(key => historical[key] !== undefined).map(key => [key, historical[key]]))
    const observation = union.length ? await observer.observeCandidate({ ...declaration, members: union }) : await observer.observe({ cell_id: cell.cell_id })
    const consumers = []
    for (const id of affected(registry, cell.cell_id).filter(id => id !== cell.cell_id)) {
      if (registry.cells.find(row => row.cell_id === id).members.length) consumers.push({ ...await observer.observe({ cell_id: id }), cell_id: id })
    }
    let replacement
    if (change.replacement_cell_id) replacement = { ...await observer.observe({ cell_id: change.replacement_cell_id }), cell: registry.cells.find(row => row.cell_id === change.replacement_cell_id) }
    // Tombstones retain verified receipt custody; absent locator observations
    // corroborate the removed location without claiming global search coverage.
    let evidence
    if (!cell.members.length && transaction) {
      if (!transaction.claims.length || transaction.claims.some(row => row.state !== 'verified')) fail('factory_lifecycle_custody_unknown')
      if (change.kind === 'retire' && (replacement?.state !== 'compatible' || !replacement.cell?.members.length
        || digest(replacement.cell.assignment) !== digest(cell.assignment))) fail('factory_lifecycle_job_unproven')
      for (const claim of transaction.claims.filter(row => row.operation.kind === 'remove')) {
        if (!absence(observation.native.members.find(row => exact(row.locator, claim.operation.member)))) fail('factory_lifecycle_absence_unknown')
      }
      evidence = { ...clone(transaction.evidence), ...scope, registry_revision: registry.revision, tick: observation.native.tick, members: [],
        evidence_ref: `native/${scope.request_id}/${observation.native.tick}/${digest(observation.native)}`, installation: 'verified', assignment: clone(cell.assignment),
        raw: { observation: clone(observation.native) } }
      // Previously complete consumer coverage cannot be reused at finalization.
      if (affected(registry, cell.cell_id).some(id => id !== cell.cell_id && registry.cells.find(row => row.cell_id === id).state !== 'retired')) fail('factory_lifecycle_consumer_unresolved')
    } else evidence = projectFactoryLifecycleEvidence({ registry, cell, change, scope, observation, consumers, replacement,
      temporary: (agent.memory.factoryTemporaryAssets?.() ?? []).filter(row => row.beneficiaries_complete === true && row.goal_id === active(agent).state.goal.goal_id)
        .map(row => ({ ...row, eligible: true })), phase, operation })
    if (phase === 'rebind') {
      const status = JSON.parse(await agent.readTaskStatusRaw()); access.fence()
      const deployment = await deploymentStatus(agent.rcon, { requireAllowed: true }); access.fence()
      const actor = JSON.parse(await agent.rcon.command(agent.observationToolCommand('getActorStatus', {}))); access.fence()
      if (actor.actor?.kind !== 'standalone_character' || actor.actor?.actor_id !== scope.actor_id || actor.actor?.valid !== true) fail('factory_lifecycle_rebind_native_unknown')
      evidence.native_status = status
      evidence.native_owner = { ...deployment, actor_kind: actor.actor.kind, surface_index: actor.surface_index, force_index: actor.force_index }
      evidence.removed_members = transaction.claims.filter(row => row.state === 'verified' && row.operation.kind === 'remove').map(claim => {
        if (!absence(observation.native.members.find(row => exact(row.locator, claim.operation.member)))) fail('factory_lifecycle_absence_unknown')
        return { ...clone(claim.operation.member), state: 'absent', coverage: 'complete' }
      })
      const inventory = observation.native.actor_inventory; const binding = inventory?.binding
      if (inventory?.state === 'known' && binding?.world_id === scope.world_id && binding.actor_id === scope.actor_id
        && binding.epoch === scope.actor_epoch && binding.session === scope.session_id && binding.request_id === scope.request_id
        && binding.tick === observation.native.tick) evidence.actor_inventory = clone(inventory.items)
      else fail('factory_lifecycle_rebind_custody_unknown')
    }
    await access.refresh(); access.fence(); agent.assertCheckpointOwnerIdentity(owner)
    return { scope, registry, evidence }
  }).execute()
  agent.assertCheckpointOwnerIdentity(owner)
  return gathered
}
async function persisted(agent, action) {
  if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
  const owner = agent.captureCheckpointOwner(); const result = action()
  await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(owner)
  return result
}
export async function reassignEmptyFactoryFurnace(agent, declaration) {
  const owner = agent.captureCheckpointOwner()
  if (agent.agentContext.role !== 'planner' || !agent.stateFile) fail('factory_reassignment_planner_required')
  const proof = await prepareFactoryCellHost(agent, async (observer, access) => {
    const scope = access.readContext(); const registry = agent.memory.getFactoryOperationalRegistry()
    const cell = registry.cells.find(row => row.cell_id === declaration?.cell_id)
    if (!cell) fail('factory_cell_unknown')
    const observation = await observer.observe({ cell_id: cell.cell_id })
    const native = observation.native; const next = emptyFurnaceAssignment(cell, declaration, native)
    const row = native.members[0]; const member = cell.members[0]
    if (directConsumers(row, native.tick).length || registry.dependencies.some(edge => edge.consumer.cell_id === cell.cell_id || edge.supplier?.cell_id === cell.cell_id)) fail('factory_reassignment_consumers_present')
    // A narrow metadata transition still needs current native identity and user
    // grant, placement custody, protected-asset and reservation admission.
    const authorize = () => {
      const state = agent.memory.planningState(agent.activePlanKey()); const auth = authorizationOf(state)
      const grant = agent.memory.currentGoalGrant(agent.activePlanKey())
      const receipt = auth.world.npc_placements.find(item => item.unit_number === member.unit_number)
      if (!grant || !checkGrant(auth, state.goal, { grant_id: grant.grant_id, grant_revision: grant.revision, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch }).ok
        || !receipt || receipt.entity_name !== member.name || row.last_user_facts?.state !== 'known'
        || entityProtection(auth, { unit_number: member.unit_number, last_user: row.last_user_facts.last_user }, { goalId: state.goal.goal_id }).protected
        || activeReservations(auth).some(item => item.unit_number === member.unit_number)
        || auth.grants.some(item => item.status === 'active' && item.protected_materials.some(material => material.container_unit_number === member.unit_number))
        || getActivePlan(state)?.steps?.some(step => step.obligations?.preserve?.includes(member.unit_number))) fail('factory_reassignment_authority_missing')
      return { grant_id: grant.grant_id, grant_revision: grant.revision, placement: clone(receipt) }
    }
    const authorization = authorize()
    await access.refresh(); access.fence(); await agent.assertCheckpointOwnerCurrent(owner); authorize()
    const evidence = { ...scope, registry_revision: registry.revision, fresh: true, truncated: false, native_idle: true, pending: false, uncertain: false,
      tick: native.tick, members: clone(cell.members), consumers: { coverage: 'complete', truncated: false, unresolved: false, rows: [] },
      authorized: true, authorization, next, evidence_ref: `native/${scope.request_id}/${native.tick}/${digest(native)}`, raw: { observation: native } }
    const change = { cell_id: cell.cell_id, transaction_id: `reassign/${scope.request_id}/${cell.cell_id}`, declaration,
      expected_registry_revision: registry.revision, expected_lifecycle_revision: agent.memory.factoryLifecycleRevision(),
      expected_cells: [{ cell_id: cell.cell_id, revision: cell.revision, digest: digest(cell) }] }
    return { change, evidence, assert: () => { access.fence(); authorize() } }
  }).execute()
  await agent.assertCheckpointOwnerCurrent(owner)
  const result = await persisted(agent, () => { proof.assert(); return factoryLifecycleRuntime(agent, { idle: true }).reassign(proof.change, proof.evidence) })
  await agent.traceEvent('factory_lifecycle.reassigned', { transaction_id: result.transaction_id, cell_id: result.cell_id, previous_assignment: result.assignment, assignment: result.next_assignment, native_tick: proof.evidence.tick })
  agent.assertCheckpointOwnerIdentity(owner)
  return result
}

export async function beginFactoryCellLifecycle(agent, change, options) {
  const proof = await acquire(agent, change, options)
  return persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).begin(change, proof.evidence))
}
export async function declareFactoryTemporaryAsset(agent, intent) {
  await prepareFactoryCellHost(agent, () => true).execute()
  return persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).declareTemporary(intent))
}
export async function rebindFactoryCellLifecycle(agent, transactionId) {
  const tx = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
  if (!tx) fail('factory_lifecycle_transaction_unknown')
  const proof = await acquire(agent, tx.change, { phase: 'rebind', transaction: tx })
  return persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).rebind(transactionId, proof.evidence))
}
export async function validateFactoryLifecycleOperation(agent, rawOperation) {
  const tx = agent.memory.factoryLifecycleTransactions().find(row => row.state === 'degraded' && row.operations[row.next_operation]
    && operationSignature([row.operations[row.next_operation].operation]) === operationSignature([rawOperation]))
  if (!tx) fail('factory_lifecycle_operation_mismatch')
  await acquire(agent, tx.change, { transaction: tx, phase: 'operation', operation: tx.operations[tx.next_operation] })
  return { verified: true, transaction_id: tx.transaction_id }
}
export async function reconcileFactoryLifecycleResidual(agent, transactionId) {
  const tx = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
  const pending = agent.memory.pendingOperations(agent.activePlanKey()).find(row => row.operation_key === tx?.claims.at(-1)?.binding.operation_key)
  if (!tx || !pending || !['partial', 'refused'].includes(tx.state)) fail('factory_lifecycle_residual_unknown')
  const proof = await acquire(agent, tx.change, { transaction: tx, pending, phase: 'residual' })
  await persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).reconcileResidual(transactionId, proof.evidence))
  if (typeof agent.settleFactoryLifecycleResidual !== 'function') fail('factory_lifecycle_residual_settlement_unavailable')
  await agent.settleFactoryLifecycleResidual(pending)
  if (agent.memory.pendingOperations(agent.activePlanKey()).some(row => row.operation_key === pending.operation_key)) fail('factory_lifecycle_residual_settlement_held')
  return { reconciled: true, transaction_id: transactionId }
}
export async function reconcileFactoryCellLifecycle(agent, transactionId) {
  let tx = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
  if (!tx) fail('factory_lifecycle_transaction_unknown')
  if (['retired', 'installed'].includes(tx.state)) return { complete: true, transaction: tx }
  if (tx.state !== 'degraded') fail('factory_lifecycle_receipt_reconciliation_required')
  if (tx.owner.request_id !== agent.traceRequest?.id || tx.owner.actor_epoch !== agent.epoch?.epoch || tx.owner.session_id !== agent.epoch?.session) {
    await rebindFactoryCellLifecycle(agent, transactionId)
    tx = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
  }
  if (tx.next_operation < tx.operations.length) return { complete: false, next_operation: clone(tx.operations[tx.next_operation]), transaction_id: tx.transaction_id }
  const proof = await acquire(agent, tx.change, { phase: 'finish', transaction: tx })
  const result = await persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).finish(transactionId, proof.evidence))
  await agent.traceEvent('factory_lifecycle.completed', { transaction_id: transactionId, state: result.state })
  return { complete: true, transaction: result }
}

async function runLifecycle(agent, transactionId) {
  if (typeof agent.executeFactoryLifecycleOperation !== 'function') fail('factory_lifecycle_executor_unavailable')
  for (let count = 0; count < 64; count++) {
    const result = await reconcileFactoryCellLifecycle(agent, transactionId)
    if (result.complete) return result
    const tx = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
    if (tx.claims.length >= tx.action_limit) fail('factory_lifecycle_recovery_exhausted')
    // The shared pre-send boundary revalidates native custody, consumers and
    // surviving job capability before recording this exact next operation.
    await agent.executeFactoryLifecycleOperation(result.next_operation.operation)
    const next = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
    if (next.next_operation <= tx.next_operation) fail('factory_lifecycle_receipt_reconciliation_required')
  }
  fail('factory_lifecycle_recovery_exhausted')
}

async function ensureTemporaryCell(agent, asset) {
  const existing = agent.memory.getFactoryOperationalRegistry().cells.find(cell => cell.members.some(member => member.unit_number === asset.unit_number)
    || cell.support?.receipt_id === asset.receipt_id)
  if (existing) {
    if (existing.support?.kind !== 'temporary' || existing.support.intent_id !== asset.intent_id || existing.support.receipt_id !== asset.receipt_id) fail('factory_cleanup_permanent_asset')
    return existing
  }
  return prepareFactoryCellHost(agent, async (observer, access) => {
    const runtime = observer.runtime; const scope = runtime.scope(); const receipt = agent.memory.factoryPlacementReceipt(asset.receipt_id)
    if (!receipt || !exact(receipt, asset.placement_receipt)) fail('factory_temporary_authority_unknown')
    const member = runtime.recordPlacement({ ...locator(receipt), provenance: { receipt_id: receipt.receipt_id } }, scope)
    const declaration = { surface_index: scope.surface_index, force_index: scope.force_index,
      assignment: { products: [], purpose: asset.purpose, method: 'receipt_backed_temporary_support' }, members: [member], ports: [], origin: runtime.origin(),
      support: { kind: 'temporary', intent_id: asset.intent_id, receipt_id: asset.receipt_id } }
    const observed = await observer.observeCandidate(declaration)
    if (observed.native.members.length !== 1 || observed.native.members[0].state !== 'observed'
      || !exact(observed.native.members[0].locator, member)) fail('factory_cleanup_member_unknown')
    access.fence(); runtime.assertScope(scope)
    const cell = runtime.registerCell(declaration, scope); access.acceptPublishedRevision()
    await agent.persistState({ strict: true }); access.fence()
    return cell
  }).execute()
}
async function cleanupAsset(agent, candidate) {
  const asset = agent.memory.factoryTemporaryAssets().find(row => row.receipt_id === candidate.receipt_id && row.beneficiaries_complete === true)
  if (!asset) fail('factory_cleanup_beneficiary_incomplete')
  const cell = await ensureTemporaryCell(agent, asset)
  if (cell.state === 'retired') return
  const registry = agent.memory.getFactoryOperationalRegistry()
  const transactionId = `temporary-cleanup/${asset.intent_id}`
  const previous = agent.memory.factoryLifecycleTransactions().find(row => row.transaction_id === transactionId)
  if (!previous) {
    const raw = await prepareFactoryCellHost(agent, (observer) => observer.observe({ cell_id: cell.cell_id })).execute()
    const member = cell.members[0]; const readiness = raw.native.members.find(row => exact(row.locator, member))?.removal_readiness
    if (!verifyFactoryRemovalReadiness(readiness)) fail('factory_lifecycle_removal_unproven')
    const change = { transaction_id: transactionId, cell_id: cell.cell_id, kind: 'cleanup', assignment: clone(cell.assignment),
      expected_registry_revision: registry.revision, expected_lifecycle_revision: agent.memory.factoryLifecycleRevision(),
      expected_cells: affected(registry, cell.cell_id).map(id => { const row = registry.cells.find(cell => cell.cell_id === id); return { cell_id: id, revision: row.revision, digest: digest(row) } }),
      operations: [{ kind: 'remove', member: clone(member), quality: readiness.snapshot.target.quality,
        operation: { name: 'mine_entity_exact', args: { unit_number: member.unit_number } } }], action_limit: 3 }
    await beginFactoryCellLifecycle(agent, change)
  }
  await runLifecycle(agent, transactionId)
}

// Caller is the actual deterministic close path after evaluating the original
// checkpoint and before advancing its step. It cannot be reached by model JSON.
export async function closeFactoryCellLifecycles(agent, { proof } = {}) {
  const capability = closeProofs.get(proof)
  if (!capability || capability.agent !== agent || controllers.has(agent)) fail('factory_cleanup_completion_unproven')
  agent.assertCheckpointOwnerIdentity(capability.owner)
  const { state, step } = active(agent)
  if (capability.goal_id !== state?.goal?.goal_id || capability.semantic_step_id !== (step?.semantic_step_id ?? step?.step_id)) fail('factory_cleanup_completion_owner_stale')
  closeProofs.delete(proof); controllers.add(agent)
  try {
    const assets = agent.memory.factoryTemporaryAssets?.() ?? []
    const relevant = assets.filter(asset => asset.beneficiaries.some(row => row.goal_id === capability.goal_id && row.semantic_step_id === capability.semantic_step_id))
    const completions = [{ goal_id: capability.goal_id, semantic_step_id: capability.semantic_step_id, status: 'completed', verified: true, receipt_id: capability.receipt_id }]
    const eligible = relevant.length ? await persisted(agent, () => factoryLifecycleRuntime(agent, { idle: true }).scheduleCleanup(completions)) : []
    for (const tx of agent.memory.factoryLifecycleTransactions().filter(row => !['retired', 'installed'].includes(row.state))) await runLifecycle(agent, tx.transaction_id)
    for (const candidate of eligible) await cleanupAsset(agent, candidate)
    return { complete: true }
  } catch (error) {
    await agent.traceEvent('factory_lifecycle.close_held', { code: error.code ?? 'factory_lifecycle_unknown', goal_id: capability.goal_id,
      semantic_step_id: capability.semantic_step_id, disposition: 'classified_pause', pending: agent.memory.pendingOperations(agent.activePlanKey()).length })
    throw error
  } finally { controllers.delete(agent) }
}
