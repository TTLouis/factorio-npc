import { getActivePlan, isStepContractPending, PLAN_STATUS } from './planning-state.mjs'
import { completionContractSignature } from './luna-step-contracts.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'
import { parseInventoryCounts } from './inventory-facts.mjs'
import { recipeFactLine } from './handoff-packet.mjs'

function identity(agent) {
  const key = agent.activePlanKey(); const planning = agent.memory.planningState?.(key); const plan = getActivePlan(planning)
  return { key, planning, plan, generation: agent.generation, actor: agent.epoch?.actor_id, epoch: agent.epoch?.epoch }
}
function signature(contract) {
  try { return completionContractSignature(contract) }
  catch { return undefined }
}
function same(agent, prediction, { next = false } = {}) {
  const now = identity(agent); const previous = now.plan?.steps?.[prediction.index]
  return agent.active && !agent.currentPendingAmendment() && now.key === prediction.key
    && !prediction.invalidated && !prediction.controller.signal.aborted && agent.traceRequest === prediction.requestTrace
    && agent.agentContext.lineageSequence === prediction.lineage
    && now.planning?.goal?.goal_id === prediction.goalId && now.plan?.plan_id === prediction.planId && now.plan?.plan_version === prediction.planVersion
    && [PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(now.plan?.status)
    && now.generation === prediction.generation && now.actor === prediction.actor && now.epoch === prediction.epoch
    && now.plan?.active_step_index === prediction.index + (next ? 1 : 0)
    && previous?.step_id === prediction.previousId && previous.completion_contract
    && signature(previous.completion_contract) === prediction.signature
    && now.plan?.steps?.[prediction.index + 1]?.step_id === prediction.stepId
    && now.plan?.steps?.[prediction.index + 1]?.description === prediction.targetDescription
}
async function event(agent, record, name, reason) {
  await agent.traceEvent(`plan.contract_prediction_${name}`, { request_id: record.requestId, plan_id: record.planId,
    step_id: record.stepId, assumed_step_id: record.previousId, reason }, { requestId: record.requestId })
}
async function discarded(agent, record, reason) {
  if (record.discarded) return
  record.discarded = true
  await event(agent, record, 'discarded', reason)
}
async function nativeCurrent(agent, record, { next = false, eitherStep = false } = {}) {
  const owns = () => same(agent, record, { next }) || eitherStep && same(agent, record, { next: true })
  if (!owns()) return false
  const status = await deploymentStatus(agent.rcon, { requireAllowed: true })
  return status.actor_id === record.actor && status.epoch === record.epoch && owns()
}
async function predictionFacts(agent) {
  // This lane never refreshes shared topology/handoff caches. A cancelled read
  // may finish after a new request starts; its result must remain local here.
  const facts = { as_of: { ...agent.observationTag() }, scope: 'advisory_prediction_not_execution_stock', inventory: 'unavailable' }
  const observed = [...(agent.liveEntityObservations?.values?.() ?? [])].slice(-24)
  if (observed.length) facts.observed_entities = observed.map(row => ({ name: row.name, unit_number: row.unit_number,
    ...(row.type ? { type: row.type } : {}), ...(Number.isSafeInteger(row.observed_tick) ? { observed_tick: row.observed_tick } : {}) }))
  const recipes = [...(agent.handoffRecipeFacts?.values?.() ?? [])].slice(-12).map(row => recipeFactLine(row))
  if (recipes.length) facts.recipes = recipes
  try {
    const raw = String(await agent.rcon.command(agent.observationToolCommand('getInventoryItems', {})))
    if (raw.length <= 200000) {
      const counts = parseInventoryCounts(raw)
      if (counts) facts.inventory = Object.fromEntries([...counts].slice(0, 64))
    }
  } catch {}
  return facts
}

// One non-executable planner side call, started only after actual native
// admission. The parked conversations and the committed plan are untouched.
export function startContractPrediction(agent) {
  try { return beginContractPrediction(agent) }
  catch { return undefined } // Side preparation cannot turn an admitted batch into an admission failure.
}
function beginContractPrediction(agent) {
  if (agent.completionProtocolVersion < 3 || !agent.active || agent.currentPendingAmendment()) return
  const current = identity(agent); const plan = current.plan; const index = plan?.active_step_index
  const previous = plan?.steps?.[index]; const next = plan?.steps?.[index + 1]
  if (!previous?.completion_contract || !isStepContractPending(next) || previous.completion_mode === 'semantic') return
  // Runtime closes use the compatibility board's stable alias. Bind that alias
  // while admission still identifies the same canonical step; never infer it
  // from a later active index (replacement plans can carry a completed prefix).
  const board = agent.memory.currentPlan?.(current.key)?.task_board
  const boardStep = board?.steps?.find(step => step.id === board.active_step_id)
  if (!boardStep || boardStep.description !== previous.description || !boardStep.completion_contract
    || !signature(previous.completion_contract) || signature(boardStep.completion_contract) !== signature(previous.completion_contract)) return
  const held = agent.contractPrediction
  if (held && held.planId === plan.plan_id && held.planVersion === plan.plan_version && held.previousId === previous.step_id) return
  // Never allow a second in-flight prediction, including a superseded one.
  if (held && !held.settled) return
  const record = { key: current.key, generation: current.generation, actor: current.actor, epoch: current.epoch,
    lineage: agent.agentContext.lineageSequence, requestTrace: agent.traceRequest,
    goalId: current.planning.goal.goal_id, planId: plan.plan_id, planVersion: plan.plan_version, index,
    previousId: previous.step_id, previousBoardId: boardStep.id, stepId: next.step_id, signature: signature(previous.completion_contract),
    targetDescription: next.description,
    requestId: agent.traceRequest?.id, controller: new AbortController(), settled: false }
  agent.contractPrediction = record
  record.flight = (async () => {
    let outcome
    try {
      await event(agent, record, 'started', 'native_batch_admitted')
      const predictionCurrent = () => nativeCurrent(agent, record, { eitherStep: true })
      if (!(await predictionCurrent())) { outcome = { stale: 'prediction_owner_changed' }; return outcome }
      const facts = await predictionFacts(agent)
      if (!(await predictionCurrent())) { outcome = { stale: 'prediction_owner_changed' }; return outcome }
      outcome = await agent.requestStepContract({ key: record.key, step: next, requestId: record.requestId, facts, predictionCurrent, controller: record.controller,
        assumedOutcome: { step_id: previous.step_id, checkpoint: JSON.parse(record.signature), assumed_satisfied: true } })
      return outcome
    } catch { outcome = { ok: false, reason: 'prediction_call_failed' }; return outcome }
    finally {
      record.settled = true
      if (outcome?.stale || !outcome?.ok || record.invalidated || (!same(agent, record) && !same(agent, record, { next: true }))) {
        try { await discarded(agent, record, record.invalidated ?? outcome?.reason ?? `stale_${outcome?.stale ?? 'prediction_owner_changed'}`) }
        catch {} // A side-call trace failure cannot reject an unobserved promise.
      }
    }
  })()
}

// Returns an authored contract only after fresh validation. Binding remains in
// the existing append-only reducer/JIT path, with identical persistence checks.
export async function takeContractPrediction(agent, { plan, step, closedStepId, closedBy }) {
  const record = agent.contractPrediction
  if (!record || record.stepId !== step.step_id || record.planId !== plan.plan_id) return undefined
  const outcome = await record.flight
  let reason
  let stale = false
  if (!same(agent, record, { next: true })) { reason = 'prediction_owner_changed'; stale = true }
  else if (![record.previousId, record.previousBoardId].includes(closedStepId) || !['deterministic_completion_contract', 'condition_wait'].includes(closedBy)
    || plan.execution?.step_progress?.[record.previousId]?.status !== 'completed'
    || plan.execution?.step_progress?.[record.previousId]?.contract_satisfied !== true) reason = 'assumed_outcome_not_verified'
  else if (!outcome?.ok) { reason = outcome?.stale ? `stale_${outcome.stale}` : outcome?.reason ?? 'prediction_unavailable'; stale = Boolean(outcome?.stale) }
  else if (outcome.contract.requirements.every(row => row.kind === 'inventory_count')) reason = 'material_count_needs_fresh_state'
  else {
    try {
      const status = await deploymentStatus(agent.rcon, { requireAllowed: true })
      if (status.actor_id !== record.actor || status.epoch !== record.epoch) { reason = 'prediction_actor_changed'; stale = true }
      else {
        const validation = await agent.validatePlannerCheckpointContract(outcome.contract, [], { draft: true, plannerOnlyDraft: true })
        if (!(await nativeCurrent(agent, record, { next: true }))) { reason = 'prediction_owner_changed'; stale = true }
        else if (!validation.accepted) reason = `fresh_validation_${validation.reason}`
        else {
          if (agent.contractPrediction === record) agent.contractPrediction = null
          return { ...outcome, contract: validation.contract, prediction: true }
        }
      }
    }
    catch { reason = 'fresh_validation_unavailable' }
  }
  await discarded(agent, record, reason)
  // A trace write is an await too. A replacement during diagnostic output
  // must not fall through to a fresh JIT call for the discarded owner.
  if (!same(agent, record, { next: true })) { stale = true; reason = 'prediction_owner_changed' }
  if (!stale) {
    try { if (!(await nativeCurrent(agent, record, { next: true }))) { stale = true; reason = 'prediction_owner_changed' } }
    catch { stale = true; reason = 'prediction_actor_unreadable_after_discard' }
  }
  if (agent.contractPrediction === record) agent.contractPrediction = null
  return stale ? { stale: reason, attempts: outcome?.attempts ?? 0 } : undefined
}

export async function discardContractPrediction(agent, reason) {
  const record = agent.contractPrediction
  if (!record) return
  record.invalidated = reason
  record.controller.abort()
  await record.flight
  await discarded(agent, record, reason)
  if (agent.contractPrediction === record) agent.contractPrediction = null
}
