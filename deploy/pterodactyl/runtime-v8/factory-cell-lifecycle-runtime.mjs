import { getActivePlan } from './planning-state.mjs'
import { operationSignature } from './operation-reconciliation.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'

const fail = code => { throw new FactoryRegistryError(code, code) }
const active = agent => {
  const state = agent.memory.planningState(agent.activePlanKey()); const plan = getActivePlan(state)
  return { state, plan, step: plan?.steps?.[plan.active_step_index] }
}
export function factoryLifecycleOperation(agent, operations) {
  const transactions = agent.memory.factoryLifecycleTransactions?.() ?? []
  if (!transactions.length) return undefined
  const { state, plan, step } = active(agent)
  return transactions.find(tx => tx.state === 'degraded'
    && tx.owner.goal_id === state?.goal?.goal_id && tx.owner.plan_id === plan?.plan_id && tx.owner.plan_version === plan?.plan_version
    && tx.owner.semantic_step_id === (step?.semantic_step_id ?? step?.step_id) && tx.owner.request_id === agent.traceRequest?.id
    && tx.owner.actor_id === agent.epoch?.actor_id && tx.owner.actor_epoch === agent.epoch?.epoch && tx.owner.session_id === agent.epoch?.session
    && tx.operations[tx.next_operation] && operationSignature(operations) === operationSignature([tx.operations[tx.next_operation].operation]))
}
export function factoryLifecycleRuntime(agent, { pending, idle = false } = {}) {
  const owner = agent.captureCheckpointOwner(); const key = agent.activePlanKey()
  return agent.memory.createFactoryCellLifecycleRuntime(key, () => {
    agent.assertCheckpointOwnerIdentity(owner)
    if (pending && (pending.actor?.actor_id !== agent.epoch?.actor_id || pending.actor?.epoch !== agent.epoch?.epoch)) fail('factory_lifecycle_owner_stale')
    return { world_id: agent.memory.factoryWorldBinding().world_id, actor_id: agent.epoch?.actor_id, actor_epoch: agent.epoch?.epoch,
      session_id: agent.epoch?.session, request_id: pending?.request_id ?? agent.traceRequest?.id,
      native_idle: idle, pending: !idle, uncertain: !idle,
      ...(agent.epoch?.surface_index ? { surface_index: agent.epoch.surface_index } : {}),
      ...(agent.epoch?.force_index ? { force_index: agent.epoch.force_index } : {}) }
  })
}
export async function claimFactoryLifecycleOperation(agent, transaction, pending) {
  if (!transaction) return
  if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
  const owner = agent.captureCheckpointOwner()
  const runtime = factoryLifecycleRuntime(agent, { idle: true })
  runtime.claim(transaction.transaction_id, pending)
  const physicalRevision = agent.memory.factoryLifecycleRevision()
  await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(owner)
  if (agent.memory.factoryLifecycleRevision() !== physicalRevision) fail('factory_lifecycle_revision_stale')
  const admission = runtime.admission([transaction.operations[transaction.next_operation].operation], pending)
  if (!admission.ok || !admission.authorized) fail(admission.code ?? 'factory_lifecycle_admission_refused')
  await agent.traceEvent('factory_lifecycle.claimed', { transaction_id: transaction.transaction_id, operation_key: pending.operation_key, request_id: pending.request_id })
  agent.assertCheckpointOwnerIdentity(owner)
}
export async function bindTemporaryFactoryPlacement(agent, pending) {
  const intents = agent.memory.factoryTemporaryIntents?.().filter(intent => intent.owner.request_id === pending.request_id
    && intent.owner.goal_id === pending.goal_id && intent.owner.plan_id === pending.plan_id
    && operationSignature([intent.placement.operation]) === pending.signature) ?? []
  if (!intents.length) return
  if (intents.length !== 1) fail('factory_temporary_ambiguous_intent')
  if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
  const owner = agent.captureCheckpointOwner()
  factoryLifecycleRuntime(agent, { idle: true }).bindTemporaryPlacement(intents[0].intent_id, pending)
  const physicalRevision = agent.memory.factoryLifecycleRevision()
  await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(owner)
  if (agent.memory.factoryLifecycleRevision() !== physicalRevision) fail('factory_lifecycle_revision_stale')
}
export async function settleFactoryLifecycleOperation(agent, status, pending, receiptOwner) {
  const temporary = agent.memory.factoryTemporaryIntents?.().find(intent => intent.binding?.operation_key === pending.operation_key)
  if (temporary) {
    const receipt = agent.memory.factoryPlacementReceipts(temporary.owner).find(row => row.operation_key === pending.operation_key)
    if (receipt) {
      if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
      factoryLifecycleRuntime(agent, { pending }).temporary(temporary.intent_id, receipt)
      await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(receiptOwner)
    }
  }
  if (!agent.memory.factoryLifecycleTransactions?.().some(tx => tx.claims.some(claim => claim.binding.operation_key === pending.operation_key))) return { matched: false, hold: false }
  agent.assertCheckpointOwnerIdentity(receiptOwner)
  const runtime = factoryLifecycleRuntime(agent, { pending })
  const tx = agent.memory.factoryLifecycleTransactions().find(tx => tx.claims.some(claim => claim.binding.operation_key === pending.operation_key))
  const receipt = agent.memory.factoryPlacementReceipts({ world_id: tx.owner.world_id, goal_id: tx.owner.goal_id, semantic_step_id: tx.owner.semantic_step_id })
    .find(row => row.operation_key === pending.operation_key)
  let result = runtime.settle(status, pending, receipt)
  if (result.changed || result.needs_persistence) {
    if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
    await agent.persistState({ strict: true }); agent.assertCheckpointOwnerIdentity(receiptOwner)
    result = { ...runtime.settle(status, pending, receipt), changed: result.changed }
    await agent.traceEvent('factory_lifecycle.receipt', { operation_key: pending.operation_key, request_id: pending.request_id, ...result })
    agent.assertCheckpointOwnerIdentity(receiptOwner)
  }
  return result
}

export async function retainUnsentFactoryLifecycleOperation(agent, pending, reason, owner) {
  if (!agent.memory.factoryLifecycleTransactions?.().some(tx => tx.claims.some(claim => claim.binding.operation_key === pending.operation_key))) return
  if (owner) agent.assertCheckpointOwnerIdentity(owner)
  const result = factoryLifecycleRuntime(agent, { pending }).notSent(pending, {
    not_sent: true, reason, operation_key: pending.operation_key, attempt_id: pending.attempt_id,
  })
  if (result.changed) {
    if (!agent.stateFile) fail('factory_lifecycle_persistence_unavailable')
    await agent.persistState({ strict: true })
    if (owner) agent.assertCheckpointOwnerIdentity(owner)
  }
}
