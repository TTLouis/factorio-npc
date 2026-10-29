import { compileQuantities } from './quantity-compiler.mjs'
import { materialAvailability, materialOwnerKey } from './material-ledger.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'
import { validateRefreshedEntity } from './entity-refresh.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { captureObligationProof, effectivePreservationProof, obligationProofOrigin, preservedProofMatches } from './contract-obligations.mjs'
import { STALE_REPLY_ERROR_CODE } from './agent-context.mjs'
import { productionBindings } from './production-task.mjs'
import { authorizationOf, checkGrant, evaluateOperationAdmission } from './authorization.mjs'

export const PRODUCTION_BINDING_CANDIDATE_LIMIT = 8
const nativeList = value => Array.isArray(value) ? value : value && typeof value === 'object' && Object.keys(value).length === 0 ? [] : undefined
export function missingProductionBindings(task, facts) {
  const stock = materialAvailability(task.ledger, { owner: task.owner, inventory: facts.inventory, fresh: facts.fresh })
  return compileQuantities({ targets: task.intent.targets, recipes: facts.recipes, inventory: stock.available }).nodes
    .filter(node => !node.hand_craftable && !productionBindings(task).some(row => row.recipe_name === node.name))
}

// A recipe candidate is not a grant. Automatic assignment is deliberately
// narrower than explicit executor binding: one exact NPC-owned empty machine,
// no shared production/route owner, and no recipe change. Each use still goes
// through the ordinary operation authorization and native preflight path.
export async function resolveProductionBindings(agent, s, task, facts, nodes, { residual = false } = {}) {
  const actor = { ...agent.epoch }; const conversation = agent.agentContext.conversationSeq
  const intake = agent.requestAdmissionOwner; const request = agent.traceRequest
  const grant = agent.memory.currentGoalGrant?.(s.owner.key)
  const source = JSON.stringify(task.intent); const scope = JSON.stringify(s.step)
  const fail = reason => { throw new Error(`production_binding_${reason}`) }
  const authorityCurrent = () => {
    const planning = agent.memory.planningState(s.owner.key)
    // Original player-request plans need no replacement grant. Reuse their
    // ordinary admission authority; replacement lineage still requires one.
    return evaluateOperationAdmission(planning, { operations: [], actor: { actor_id: actor.actor_id, actor_epoch: actor.epoch } }).ok
      && (!grant || checkGrant(authorizationOf(planning), planning.goal, { grant_id: grant.grant_id,
        grant_revision: grant.revision, actor_id: actor.actor_id, actor_epoch: actor.epoch }).ok)
  }
  // A missing/invalid prerequisite at entry is a guard refusal, not a stale
  // provider response. Only authority lost across an await is supersession.
  if (!authorityCurrent()) fail('authority_unproven')
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(s.owner)
    if (!agent.active || agent.traceRequest !== request || agent.requestAdmissionOwner !== intake
      || agent.agentContext.conversationSeq !== conversation || agent.currentPendingAmendment()
      || agent.epoch?.actor_id !== actor.actor_id || agent.epoch?.epoch !== actor.epoch || agent.epoch?.session !== actor.session
      || JSON.stringify(s.step) !== scope || JSON.stringify(task.intent) !== source) {
      const error = new Error('Production binding cancelled or superseded'); error.code = STALE_REPLY_ERROR_CODE; throw error
    }
    const execution = agent.memory.currentPlan(s.owner.key)
    if (agent.batchInFlight || agent.memory.pauseRecord?.(s.owner.key)?.paused
      || agent.memory.pendingOperations?.(s.owner.key)?.length || execution?.condition_wait?.state === 'active'
      || execution?.persistent_runtime?.active) fail('unsettled')
    if (!authorityCurrent()) {
      const error = new Error('production_binding_authority_unproven'); error.code = STALE_REPLY_ERROR_CODE; throw error
    }
  }
  // Keep the stronger intake/amendment/actor fence through the caller's trace,
  // durable claim and final wake, including an unproven result.
  s.owner.productionBindingFence = fence
  const read = async (tool, args = {}) => {
    await fence()
    const raw = String(await agent.rcon.command(agent.observationToolCommand(tool, args))); await fence()
    if (raw.length > 200000) fail('read_truncated')
    return raw
  }
  let forceIndex
  const idle = async () => {
    await fence()
    const runtime = await deploymentStatus(agent.rcon, { requireAllowed: true }); await fence()
    if (runtime.actor_id !== actor.actor_id || runtime.epoch !== actor.epoch || runtime.session !== actor.session
      || !Number.isSafeInteger(runtime.surface_index) || runtime.surface_index !== actor.surface_index) fail('actor_scope_changed')
    const body = JSON.parse(await read('getActorStatus'))
    if (body.actor?.actor_id !== actor.actor_id || body.surface_index !== runtime.surface_index
      || !Number.isSafeInteger(body.force_index) || body.force_index < 1
      || forceIndex !== undefined && forceIndex !== body.force_index) fail('body_scope_changed')
    forceIndex = body.force_index
    const raw = await agent.readTaskStatusRaw(); await fence()
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw
    const journal = nativeAdmissionJournal(status?.admission_journal?.records ?? status?.admission_journal)
    const crafting = JSON.parse(await read('getCraftingStatus')); const follow = JSON.parse(await read('getFollowStatus'))
    if (!journal.known || journal.unresolved) fail('native_outcome_uncertain')
    if (!runtime.idle || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch
      || status.actor?.mining_state?.mining || crafting.task_active !== false || !crafting.native_queue
      || Object.keys(crafting.native_queue).length || crafting.persisted_owner || follow.active !== false) fail('native_busy')
  }
  await idle()
  const planning = agent.memory.planningState(s.owner.key)
  // Legacy checkpoints without typed preservation cannot prove automatic reuse.
  if (!obligationProofOrigin(planning, s.step)) fail('preservation_unproven')
  const fresh = await captureObligationProof(agent, s.step.obligations, fence)
  if (!preservedProofMatches(effectivePreservationProof(s.plan, s.step, { plans: planning.plans }), fresh)) fail('preservation_changed')
  // A route's destination is occupied even if its input happens to be empty.
  const routeUnits = new Set(fresh.preserved.flatMap(row => [row.item_io?.pickup_target?.unit_number, row.item_io?.drop_target?.unit_number]).filter(Number.isSafeInteger))
  const placements = agent.memory.authorizationState(s.owner.key)?.world?.npc_placements ?? []
  const result = []
  for (const node of nodes) {
    const recipe = facts.recipes.find(row => row.name === node.name)
    if (!recipe || recipe.crafting_machines_truncated === true || !Array.isArray(recipe.crafting_machines)) fail('recipe_unreadable')
    const names = new Set(recipe.crafting_machines.map(row => row.name))
    const possible = placements.filter(row => row.actor_id === actor.actor_id && row.actor_epoch === actor.epoch && names.has(row.entity_name))
    if (possible.length > PRODUCTION_BINDING_CANDIDATE_LIMIT) fail('candidate_limit')
    const candidates = []
    for (const placement of possible) {
      const unit = placement.unit_number
      if (routeUnits.has(unit) || productionBindings(task).some(row => row.unit_number === unit)
        || result.some(row => row.unit_number === unit)) continue
      if ([...(agent.memory.productionTasks?.values() ?? [])].some(other => materialOwnerKey(other.owner) !== materialOwnerKey(task.owner)
        && other.status !== 'complete' && productionBindings(other).some(row => row.unit_number === unit))) continue
      const locator = agent.liveObservedExactTarget(unit) ?? agent.exactTargetLocator(unit)
      if (!locator?.name || !locator.position || locator.name !== placement.entity_name
        || locator.surface_index !== undefined && locator.surface_index !== actor.surface_index) fail('locator_unproven')
      const raw = await read('getEntityStatus', { unit_number: unit })
      const detail = validateRefreshedEntity(raw, { unit, locator, placement, actorId: actor.actor_id, surfaceIndex: actor.surface_index, forceIndex })
      const entity = detail.entity
      // No inventory/progress absence inference from a clipped response. Exact
      // indices 1/2/3 are the native fuel/source/result inventories.
      if (!['furnace', 'assembling-machine'].includes(entity.type) || entity.working !== false
        || typeof entity.energy_source !== 'string' || typeof entity.status_name !== 'string'
        || !Array.isArray(entity.inventories) || entity.inventories_truncated !== false || entity.inventory_items_truncated !== false
        || !Number.isFinite(entity.crafting_progress)
        || ![2, 3].every(index => entity.inventories.some(row => row.index === index && nativeList(row.items)))) fail('machine_unreadable')
      if (entity.recipe && entity.recipe !== node.name || entity.type === 'assembling-machine' && entity.recipe !== node.name
        || entity.crafting_progress !== 0
        || entity.inventories.filter(row => [2, 3].includes(row.index)).some(row => nativeList(row.items).length)) continue
      // A restored target-only record has no new fuel grant. Its setup executor
      // must establish fuel through ordinary operations before adoption.
      if (residual && !task.intent.fuel && entity.energy_source === 'burner' && entity.status_name === 'no_fuel') continue
      const supply = s.step.execution_guidance?.materialSupply
      if (supply?.mode === 'direct_feed') continue // Explicit feeder binding remains required.
      candidates.push({ recipe_name: node.name, unit_number: unit })
      agent.recordLiveEntityToolResult('getEntityStatus', raw)
    }
    if (candidates.length !== 1) {
      await idle()
      const error = new Error(`production_binding_${candidates.length ? 'ambiguous' : 'no_eligible_producer'}`)
      if (!candidates.length) error.productionBindingContinuation = { fence, idle }
      throw error
    }
    result.push(candidates[0])
  }
  await idle()
  return { bindings: result, fence, idle }
}
