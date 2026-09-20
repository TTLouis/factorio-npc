import { NpcDialogueMemory } from './npc-agent-loop.mjs'
import { reconcileTaskBoard, setTaskBoardStatus } from './common.mjs'
import { completionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  evaluateDeadlockSignals,
  getActivePlan,
  PLAN_STATUS,
  PLANNING_EVENT,
  reasoningEpochOf,
  restorePlanningState,
  serializePlanningState,
  STEERING_BOUNDARY,
} from './planning-state.mjs'

// Outcome kinds that represent an ATTEMPT on the active step. `verified_complete`
// is excluded: it carries evidence, and evidence is progress, not an attempt to
// make progress. `world_blocked` and `cancelled` are terminal and route
// elsewhere.
const ATTEMPT_OUTCOME_KINDS = new Set([
  'execution_required',
  'recoverable_provider_failure',
])

// The subset of the above whose reason code should count toward the repeating
// failure signal.
const FAILED_ATTEMPT_OUTCOME_KINDS = new Set(['recoverable_provider_failure'])

const STRICT_TASKS_BY_OPERATION = new Map([
  ['walk_to_entity', ['walking_to_entity']],
  ['walk_to_entity_exact', ['walking_to_entity']],
  ['walk_to_player', ['walking_to_entity']],
  ['mine_entity', ['mining']],
  ['mine_entity_exact', ['mining']],
  ['gather_resource', ['walking_to_entity', 'mining']],
  ['harvest_product', ['harvesting']],
  ['clear_construction_area', ['clearing_area']],
  ['place_entity', ['placing']],
  ['move_items', ['moving_items']],
  ['move_items_exact', ['moving_items']],
  ['move_items_with_player', ['moving_items']],
  ['set_machine_recipe', ['setting_recipe']],
  ['craft_item', ['crafting']],
  ['attack_nearest_enemy', ['attacking']],
  ['clear_enemy_area', ['attacking']],
])

const TRANSFER_OPERATION_NAMES = new Set(['move_items', 'move_items_exact', 'move_items_with_player', 'supply_entity'])

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function revisionSuffix(previousBoard, incomingPlan) {
  const incoming = Array.isArray(incomingPlan) ? incomingPlan.filter(step => typeof step === 'string' && step.trim()) : []
  const completed = Number.isSafeInteger(previousBoard?.completed_count)
    ? Math.max(0, Math.min(previousBoard.completed_count, previousBoard.steps?.length ?? 0))
    : 0
  if (completed === 0 || incoming.length < completed) return incoming
  const includesVerifiedPrefix = Array.from({ length: completed }, (_, index) =>
    clean(incoming[index]) === clean(previousBoard.steps?.[index]?.description)).every(Boolean)
  return includesVerifiedPrefix ? incoming.slice(completed) : incoming
}

function sameSemanticSteps(planSteps, incomingSteps) {
  const current = (Array.isArray(planSteps) ? planSteps : []).map(step => clean(step?.description))
  const incoming = (Array.isArray(incomingSteps) ? incomingSteps : []).map(clean)
  return current.length === incoming.length && current.every((description, index) => description === incoming[index])
}

function safeDurableStepCompletionContract(value) {
  const contract = sanitizeStepCompletionContract(value)
  return completionContractSupported(contract) ? contract : undefined
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  const name = value.slice(0, separator)
  let args
  try { args = JSON.parse(value.slice(separator + 1)) }
  catch { return undefined }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return { name, args }
}

function parseReceiptSummary(evidence) {
  if (!['operation_receipt', 'operation_error_receipt'].includes(evidence?.kind) || typeof evidence.summary !== 'string') return undefined
  try {
    const parsed = JSON.parse(evidence.summary)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  }
  catch { return undefined }
}

function taskTypesMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  return expected.every((taskType, index) => actual[index] === taskType)
}

function strictTaskTypesForOperation(operation) {
  if (operation.name === 'supply_entity') {
    const items = operation.args?.items
    if (!Array.isArray(items) || items.length < 1 || items.length > 8) return undefined
    return Array.from({ length: items.length }, () => 'moving_items')
  }
  if (operation.name === 'execute_construction_plan') {
    const count = operation.args?.placement_count
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) return undefined
    return Array.from({ length: count }, () => 'placing')
  }
  return STRICT_TASKS_BY_OPERATION.get(operation.name)
}

function stateHasUnverifiedTransferIntent(state) {
  if (!state) return false
  const stored = Array.isArray(state.last_operations) ? state.last_operations.slice(-16) : []
  const hasTransfer = stored.map(parseStoredOperation).some(operation => operation && TRANSFER_OPERATION_NAMES.has(operation.name))
  if (!hasTransfer) return false
  if (state.admission_status === 'admission_failed') return true
  return state.last_mutation_verified !== true
}

function transferFailureReason(evidence) {
  const receipt = parseReceiptSummary(evidence)
  const basic = receipt?.basic_operation
  const code = typeof basic?.code === 'string' && basic.code ? basic.code : undefined
  const reason = typeof receipt?.reason === 'string' && receipt.reason ? receipt.reason : undefined
  return code ?? reason ?? 'operation_failed'
}

export function verifyDeterministicReceipt(state, evidence) {
  const receipt = parseReceiptSummary(evidence)
  if (!receipt) return { verified: false, reason: 'not_completed_operation_receipt' }
  if (receipt.correlation?.goal_id && receipt.correlation.goal_id !== state?.goal_id) {
    return { verified: false, reason: 'receipt_goal_mismatch' }
  }
  if (receipt.correlation?.step_id && receipt.correlation.step_id !== state?.task_board?.active_step_id) {
    return { verified: false, reason: 'receipt_step_mismatch' }
  }
  if (receipt.outcome !== 'completed' || receipt.task_state !== 'idle' || receipt.queue_length !== 0) {
    return { verified: false, reason: 'batch_not_cleanly_completed' }
  }
  if (!Number.isSafeInteger(receipt.batch_id) || receipt.batch_id < 1) {
    return { verified: false, reason: 'missing_batch_identity' }
  }

  const stored = Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []
  if (stored.length === 0) return { verified: false, reason: 'missing_operation_intent' }
  const operations = stored.map(parseStoredOperation)
  if (operations.some(operation => !operation)) return { verified: false, reason: 'invalid_operation_intent' }

  const expectedTaskTypes = []
  for (const operation of operations) {
    const taskTypes = strictTaskTypesForOperation(operation)
    if (!taskTypes) {
      return { verified: false, reason: `operation_requires_additional_verification:${operation.name}` }
    }
    expectedTaskTypes.push(...taskTypes)
  }

  if (receipt.task_count !== expectedTaskTypes.length || !taskTypesMatch(receipt.task_types, expectedTaskTypes)) {
    return { verified: false, reason: 'receipt_operation_mismatch' }
  }

  const transferOperations = operations.filter(operation => TRANSFER_OPERATION_NAMES.has(operation.name))
  if (transferOperations.length > 0) {
    const basic = receipt.basic_operation
    if (!basic
      || basic.accepted !== true
      || basic.completed !== true
      || basic.code !== 'completed'
      || basic.type !== 'moving_items'
      || !Number.isSafeInteger(basic.moved_count)
      || basic.moved_count <= 0) {
      return { verified: false, reason: 'transfer_effect_not_verified' }
    }
    const finalOperation = operations[operations.length - 1]
    if (TRANSFER_OPERATION_NAMES.has(finalOperation.name)) {
      const expectedTarget = finalOperation.name === 'supply_entity'
        ? finalOperation.args?.unit_number
        : finalOperation.args?.unit_number
      if (Number.isSafeInteger(expectedTarget) && basic.target_unit_number !== expectedTarget) {
        return { verified: false, reason: 'transfer_target_mismatch' }
      }
      const expectedToEntity = finalOperation.name === 'move_items_with_player'
        ? undefined
        : finalOperation.name === 'supply_entity'
          ? true
          : finalOperation.args?.to_entity
      if (typeof expectedToEntity === 'boolean' && basic.to_entity !== expectedToEntity) {
        return { verified: false, reason: 'transfer_direction_mismatch' }
      }
    }
  }

  return {
    verified: true,
    batchId: receipt.batch_id,
    taskTypes: expectedTaskTypes,
    operationNames: operations.map(operation => operation.name),
  }
}

export function canonicalContinuationPlan(previousBoard, plan, { allowReplan = false, previousState: _previousState } = {}) {
  if (!previousBoard || previousBoard.kind !== 'task_board_lite' || !Array.isArray(previousBoard.steps)) return plan
  const canonical = previousBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
  if (canonical.length === 0) return plan

  const currentIndex = Number.isSafeInteger(previousBoard.active_index)
    ? Math.min(Math.max(previousBoard.active_index, 0), canonical.length - 1)
    : 0
  const incoming = Array.isArray(plan?.plan) ? plan.plan : []
  const incomingIndex = Number.isSafeInteger(plan?.currentStep)
    ? Math.min(Math.max(plan.currentStep, 0), Math.max(0, incoming.length - 1))
    : 0
  const incomingActive = incoming[incomingIndex]
  const matched = incomingActive === undefined
    ? -1
    : canonical.findIndex(description => clean(description) === clean(incomingActive))

  // BLOCKED is a user-controlled freeze, not a continuation boundary. Do not
  // admit planner operations or a replacement suffix while it is frozen.
  if (previousBoard.status === 'blocked') {
    return { ...plan, plan: canonical, currentStep: currentIndex, operations: [] }
  }
  if (allowReplan) return plan
  return {
    ...plan,
    plan: canonical,
    // currentStep is advisory proposed focus only. Runtime completion authority
    // remains at currentIndex until grounded evidence is accepted.
    currentStep: matched >= 0 ? matched : currentIndex,
  }
}

export class CanonicalTaskBoardMemory extends NpcDialogueMemory {
  constructor(options = {}) {
    super(options)
    this.planningByNpc = new Map()
  }

  planningState(key) {
    return key ? this.planningByNpc.get(key) : undefined
  }

  syncPlanningState(key, legacyState = key ? this.planByNpc.get(key) : undefined) {
    const planning = this.planningState(key)
    const plan = getActivePlan(planning)
    if (!planning || !plan || !legacyState) return legacyState
    const choice = plan.blocker?.user_choice
    const reducerSteps = Array.isArray(plan.steps) ? plan.steps.map(step => step.description) : []
    if (reducerSteps.length > 0 && legacyState.task_board?.kind === 'task_board_lite') {
      const boardBefore = legacyState.task_board
      const carriedPrefix = Array.isArray(plan.carried_forward_evidence) ? plan.carried_forward_evidence.length : 0
      const suffixAligned = boardBefore.steps.length === carriedPrefix + reducerSteps.length
        && reducerSteps.every((description, index) => clean(description) === clean(boardBefore.steps[carriedPrefix + index]?.description))
      const sameSemanticPlan = carriedPrefix === 0 && suffixAligned
      const authoritativeIndex = suffixAligned
        ? carriedPrefix + plan.active_step_index
        : plan.active_step_index
      const proposedFocusIndex = boardBefore.proposed_focus_index
      const proposedFocusStepId = boardBefore.proposed_focus_step_id
      const semanticPlan = suffixAligned
        ? boardBefore.steps.map(step => String(step?.description ?? '')).filter(Boolean)
        : reducerSteps
      legacyState.task_board = reconcileTaskBoard(
        boardBefore,
        semanticPlan,
        authoritativeIndex,
        { now: planning.updated_at || legacyState.updated_at || Date.now(), authoritativeAdvance: true, allowReplan: false },
      )
      // The reducer owns verified progress, not planner focus. On an unchanged
      // semantic plan, preserve the provider's advisory focus exactly.
      if (sameSemanticPlan && Number.isSafeInteger(proposedFocusIndex)) {
        legacyState.task_board = {
          ...legacyState.task_board,
          proposed_focus_index: proposedFocusIndex,
          proposed_focus_step_id: proposedFocusStepId,
        }
      }
    }
    if (plan.status === PLAN_STATUS.BLOCKED) {
      legacyState.status = 'blocked'
      legacyState.blocker = String(plan.blocker?.reason_code ?? legacyState.blocker ?? 'blocked').slice(0, 500)
      legacyState.pause_reason = ''
      legacyState.task_board = setTaskBoardStatus(legacyState.task_board, 'blocked', {
        blocker: legacyState.blocker,
        now: planning.updated_at || legacyState.updated_at || Date.now(),
      })
    }
    else if (plan.status === PLAN_STATUS.COMPLETED) {
      legacyState.status = 'completed'
      legacyState.blocker = ''
      legacyState.pause_reason = ''
      legacyState.task_board = setTaskBoardStatus(legacyState.task_board, 'completed', {
        now: planning.updated_at || legacyState.updated_at || Date.now(),
      })
    }
    legacyState.planning = {
      reasoning_epoch: reasoningEpochOf(planning),
      plan: {
        plan_id: plan.plan_id,
        plan_version: plan.plan_version,
        roadmap_node_id: plan.roadmap_node_ids?.[0],
        derived_from: plan.derived_from_plan_id ?? undefined,
        superseded_by: plan.superseded_by_plan_id ?? undefined,
      },
      blocked: plan.status === PLAN_STATUS.BLOCKED
        ? {
            reason: String(plan.blocker?.reason_code ?? legacyState.blocker ?? 'blocked').slice(0, 500),
            summary: String(plan.blocker?.detail ?? legacyState.blocker ?? '').slice(0, 500),
            awaiting_choice: choice === undefined,
            ...(choice ? { choice: choice.choice } : {}),
          }
        : undefined,
    }
    this.planByNpc.set(key, legacyState)
    return legacyState
  }

  dispatchPlanningEvent(key, event) {
    if (!key) return undefined
    const before = this.planningByNpc.get(key) ?? createEmptyPlanningState()
    const after = applyPlanningEvent(before, event)
    if (after !== before || this.planningByNpc.has(key)) this.planningByNpc.set(key, after)
    this.syncPlanningState(key)
    return after
  }

  /**
   * Record the advisory steering mode at a planning boundary (roadmap 4.3).
   *
   * The HARNESS emits this, deterministically, at every boundary it reaches --
   * not the Main LLM and not Jev. Two reasons, both structural:
   *
   *   - "the model is never the steering authority" is only true if the model
   *     is not the thing deciding when steering happens;
   *   - a model-emitted event stops arriving the moment the model forgets,
   *     and steering that silently stops running looks exactly like steering
   *     that decided to hold.
   *
   * A Jev recommendation, when there is one, rides along as PROVENANCE in
   * `recommended_by` / `recommended_mode` / `pressure`. The reducer decides
   * what the mode actually becomes, and refuses outright if anything is still
   * in flight.
   *
   * `user_revision_approved` and `user_priority_change` are deliberately NOT
   * emitted here: the reducer requires user authority for those, and the
   * harness does not have it.
   */
  evaluateSteeringAtBoundary(key, { boundary, now = Date.now(), planId, recommendation } = {}) {
    if (!key) return undefined
    if (boundary !== STEERING_BOUNDARY.GOAL_ADMISSION && boundary !== STEERING_BOUNDARY.PLAN_COMPLETED) return undefined
    const advice = recommendation ?? this.steeringAdviceByNpc?.get(key)
    return this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.STEERING_EVALUATED,
      source: 'runtime',
      now,
      boundary,
      ...(planId ? { plan_id: planId } : {}),
      ...(advice
        ? {
            recommended_mode: advice.recommended_mode ?? advice.mode,
            confidence: advice.confidence,
            pressure: advice.pressure,
            reason_codes: advice.reason_codes,
            critical_path: advice.critical_path_summary ?? advice.critical_path,
            candidate_shelf_nodes: advice.candidate_shelf_nodes,
            recommended_by: advice.recommended_by ?? 'jev',
          }
        : {}),
    })
  }

  /**
   * Stash Jev's latest steering advice so the next boundary can carry it.
   *
   * Stored, never applied: advice that never reaches a boundary never becomes
   * a mode, and it is consumed once so a stale recommendation cannot steer a
   * second boundary it was not written for.
   */
  recordSteeringAdvice(key, recommendation) {
    if (!key) return
    this.steeringAdviceByNpc ??= new Map()
    if (recommendation) this.steeringAdviceByNpc.set(key, recommendation)
    else this.steeringAdviceByNpc.delete(key)
  }

  /**
   * Deterministic-verification refs recorded since the shelf last moved.
   *
   * This is the runtime's own receipt log, not anything the planner said. It
   * is the only evidence a roadmap revision is allowed to stand on, so it
   * deliberately has no parameter a caller could use to supply its own.
   */
  verifiedWorldChangeRefsSinceRoadmap(key) {
    const planning = this.planningState(key)
    const since = Number.isFinite(planning?.roadmap?.created_at) ? planning.roadmap.created_at : 0
    const evidence = (key ? this.planByNpc.get(key) : undefined)?.task_board?.evidence
    if (!Array.isArray(evidence)) return []
    return evidence
      .filter(item => item?.kind === 'deterministic_verification' && Number.isFinite(item?.at) && item.at > since)
      .map(item => String(item.ref ?? item.id ?? '').slice(0, 200))
      .filter(Boolean)
      .slice(-16)
  }

  /**
   * Put the Main LLM's coarse roadmap guidance onto the Roadmap Shelf.
   *
   * The reducer has always known how to do this; nothing on the live path ever
   * asked it to, so the shelf was permanently empty and the whole LOD layer --
   * refinement readiness, fan-out parking, demotion -- was inert in the running
   * agent. This is the emitter.
   *
   * Authorship and authority are different things, and this is where the
   * difference is enforced. The Main LLM AUTHORS the nodes (Jev never does,
   * and the harness never invents one), but the reducer only moves long-horizon
   * guidance for explicit user direction or a grounded verified world change
   * (roadmap 3). So:
   *
   *   - the FIRST shelf of an admitted goal is not a revision of anything. It
   *     is the user's own objective restated at LOD 1, and carries the user's
   *     direction -- hence `user_steering`, not `runtime`;
   *   - every later revision is a claim that the world moved under the
   *     guidance, and is admitted only against deterministic verification refs
   *     this adapter already holds. Those come from the runtime's receipt log,
   *     so a planner cannot mint the evidence that authorizes its own revision.
   *
   * A submission with neither is dropped: preferring a different shelf is not
   * a reason for the shelf to move.
   *
   * Node contents are NOT sanitized here on purpose. `sanitizeShelfNode` in
   * the reducer is the single definition of "a shelf node is non-executable";
   * stripping `steps`/`operations` here too would be a second copy of that
   * rule to keep in sync, and the copy that drifts is the one that lets an
   * executable node onto the shelf.
   */
  reviseRoadmap(key, nodes, { now = Date.now(), reason } = {}) {
    if (!key || !Array.isArray(nodes) || nodes.length === 0) return undefined
    const planning = this.planningState(key)
    const goalId = planning?.goal?.goal_id
    if (!goalId) return planning
    const firstShelfForGoal = planning.roadmap?.goal_id !== goalId
    const evidenceRefs = firstShelfForGoal ? [] : this.verifiedWorldChangeRefsSinceRoadmap(key)
    if (!firstShelfForGoal && evidenceRefs.length === 0) return planning
    return this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.ROADMAP_REVISED,
      now,
      source: firstShelfForGoal ? 'user_steering' : 'runtime',
      nodes,
      reason: String(reason ?? (firstShelfForGoal ? 'goal_decomposed_to_shelf' : 'verified_world_change')).slice(0, 300),
      ...(evidenceRefs.length > 0 ? { evidence_refs: evidenceRefs } : {}),
    })
  }

  ensurePlanningDraft(key, state, { now = Date.now(), migrated = false } = {}) {
    if (!key || !state) return undefined
    let planning = this.planningByNpc.get(key)
    const existingPlan = getActivePlan(planning)
    const terminalReusableSlot = existingPlan
      && [PLAN_STATUS.COMPLETED, PLAN_STATUS.CANCELLED, PLAN_STATUS.SUPERSEDED].includes(existingPlan.status)
    let goalAdmitted = false
    if (!planning?.goal || planning.goal.goal_id !== state.goal_id || terminalReusableSlot) {
      goalAdmitted = true
      planning = applyPlanningEvent(planning ?? createEmptyPlanningState(), {
        type: PLANNING_EVENT.GOAL_ACCEPTED,
        now,
        goal_id: state.goal_id,
        owner: state.owner,
        objective: state.objective,
      })
    }
    if (!getActivePlan(planning) && Array.isArray(state.task_board?.steps) && state.task_board.steps.length > 0) {
      planning = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.DRAFT_CREATED,
        now,
        origin: migrated ? 'legacy_task_board_migration' : 'live_task_board',
        steps: state.task_board.steps.map(step => ({
          description: step.description,
          completion_contract: safeDurableStepCompletionContract(step.completion_contract),
        })),
      })
    }
    this.planningByNpc.set(key, planning)
    // Only on actual admission: the gate would happily accept a repeat while
    // nothing is committed, and re-evaluating the same boundary on every draft
    // would inflate the steering sequence without a boundary having occurred.
    if (goalAdmitted) planning = this.evaluateSteeringAtBoundary(key, { boundary: STEERING_BOUNDARY.GOAL_ADMISSION, now }) ?? planning
    this.syncPlanningState(key, state)
    return planning
  }

  /**
   * Commit the active draft, if and only if it earned it.
   *
   * This used to pass `jev_verdict: 'actionable'` and
   * `runtime_validation: { passed: true }` as literals. The reducer's commit
   * gate is strict and correct, so the effect was that every draft satisfied
   * it: scope review could not refuse anything, and the roadmap's central
   * claim -- that the system commits only what Jev found actionable -- was not
   * true of the running agent.
   *
   * Both inputs must now come from the caller, and a missing review is a
   * refusal rather than a pass. `review.verdict` is Jev's parsed scope review;
   * `review.runtime_validation` is the deterministic preflight result.
   */
  commitPlanningPlan(key, { now = Date.now(), migrated = false, review } = {}) {
    const legacy = key ? this.planByNpc.get(key) : undefined
    let planning = this.ensurePlanningDraft(key, legacy, { now, migrated })
    const plan = getActivePlan(planning)
    if (!plan) return planning
    if ([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(plan.status)) return planning
    // No review, no commit. Silence is not consent.
    if (!review || typeof review !== 'object') return planning

    planning = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.JEV_REVIEW_REQUESTED,
      now,
      source: 'jev',
      plan_id: plan.plan_id,
      verdict: review.verdict,
      reason_codes: review.reason_codes,
      confidence: review.confidence,
    })

    if (review.verdict !== 'actionable') {
      this.planningByNpc.set(key, planning)
      this.syncPlanningState(key, legacy)
      return planning
    }

    planning = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.PLAN_COMMITTED,
      now,
      plan_id: plan.plan_id,
      jev_verdict: review.verdict,
      runtime_validation: review.runtime_validation,
    })
    this.planningByNpc.set(key, planning)
    this.syncPlanningState(key, legacy)
    return planning
  }

  replayLegacyVerifiedPrefix(key, state, planning, { now = Date.now() } = {}) {
    if (!state?.task_board || !planning) return planning
    const completedCount = Number.isSafeInteger(state.task_board.completed_count)
      ? Math.max(0, Math.min(state.task_board.completed_count, state.task_board.steps?.length ?? 0))
      : 0
    let next = planning
    for (let index = 0; index < completedCount; index++) {
      const plan = getActivePlan(next)
      const step = plan?.steps?.[plan.active_step_index]
      if (!step) break
      const progress = plan.execution?.step_progress?.[step.step_id]
      if (progress?.status === 'completed') continue
      next = applyPlanningEvent(next, {
        type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
        now,
        plan_id: plan.plan_id,
        step_id: step.step_id,
        evidence: {
          source: 'runtime_receipt',
          kind: 'legacy_task_board_migration',
          ref: `migration/${state.goal_id}/${state.task_board.steps[index]?.id ?? index + 1}`,
          contract_satisfied: true,
        },
      })
      next = applyPlanningEvent(next, {
        type: PLANNING_EVENT.STEP_COMPLETED,
        now,
        source: 'runtime',
        plan_id: plan.plan_id,
        step_id: step.step_id,
      })
    }
    this.planningByNpc.set(key, next)
    return next
  }

  recordBlockedChoice(key, choice, approvedBy, { now = Date.now() } = {}) {
    const planning = this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.BLOCKED_CHOICE_RECORDED,
      now,
      source: 'user',
      approved_by: approvedBy,
      choice,
    })
    return this.syncPlanningState(key, key ? this.planByNpc.get(key) : undefined) ?? planning
  }

  setStepCompletionContract(key, stepId, contract, { now = Date.now() } = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    const normalized = safeDurableStepCompletionContract(contract)
    if (!state || state.status !== 'active' || !normalized || !state.task_board || !Array.isArray(state.task_board.steps)) return state
    const index = state.task_board.steps.findIndex(step => step?.id === stepId)
    if (index < 0) return state
    const previous = state.task_board.steps[index]
    const steps = state.task_board.steps.slice()
    steps[index] = {
      ...previous,
      completion_contract: normalized,
      completion_contract_at: now,
      revision: (Number.isSafeInteger(previous.revision) ? previous.revision : 0) + 1,
    }
    state.task_board = {
      ...state.task_board,
      steps,
      revision: (Number.isSafeInteger(state.task_board.revision) ? state.task_board.revision : 0) + 1,
      updated_at: now,
    }
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    // Completion contracts are still discovered after the initial draft is
    // accepted. Pre-commit reducer steps may be safely replaced with a fresh
    // draft carrying the newly grounded contract; immutable plans are never
    // edited in place.
    const planning = this.planningByNpc.get(key)
    const active = getActivePlan(planning)
    if (active && ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(active.status)) {
      const refreshed = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.DRAFT_CREATED,
        now,
        origin: 'checkpoint_contract_refresh',
        steps: state.task_board.steps.map(step => ({
          description: step.description,
          completion_contract: safeDurableStepCompletionContract(step.completion_contract),
        })),
      })
      this.planningByNpc.set(key, refreshed)
      this.syncPlanningState(key, state)
    }
    return state
  }

  retireCompletedPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'completed') return state
    this.planByNpc.delete(key)
    // The current slot is retired. Historical/learning surfaces own completed
    // task history; leaving this reducer under the reusable NPC key would make
    // the next goal inherit the completed plan identity.
    this.planningByNpc.delete(key)
    return undefined
  }

  clearTaskContext(key) {
    const result = super.clearTaskContext(key)
    if (key) this.planningByNpc.delete(key)
    return result
  }

  planningReasoningEpoch(key) {
    return reasoningEpochOf(this.planningByNpc.get(key))
  }

  planContext(key) {
    const state = this.retireCompletedPlan(key)
    if (!state) {
      return '[PLAN_STATE] No active durable goal. Completed goals are retired from the current task slot and remain only in bounded dialogue history. Do not resume or steer a completed goal merely because the human says continue; a new actionable instruction must start a new goal.'
    }
    return super.planContext(key)
  }

  currentPlan(key) {
    this.retireCompletedPlan(key)
    return super.currentPlan(key)
  }

  recordPlan(key, requestInfo, plan, options = {}) {
    // A completed goal is history, not an active task. Older persisted state may
    // still contain one from a previous runtime version, so retire it before a
    // new request can accidentally inherit its goal_id/objective.
    this.retireCompletedPlan(key)

    const priorLegacy = key ? this.planByNpc.get(key) : undefined
    const priorPlanning = key ? this.planningByNpc.get(key) : undefined
    const blockedPlan = getActivePlan(priorPlanning)
    const explicitRevision = blockedPlan?.status === PLAN_STATUS.BLOCKED
      && blockedPlan.blocker?.user_choice?.choice === 'revise'
      && typeof requestInfo?.sender === 'string'
      && requestInfo.sender.trim().length > 0
      && typeof requestInfo?.text === 'string'
      && requestInfo.text.trim().length > 0

    let userRevisionApproved = false
    if (explicitRevision && Array.isArray(plan?.plan) && plan.plan.length > 0) {
      const steps = revisionSuffix(priorLegacy?.task_board, plan.plan)
      const revised = applyPlanningEvent(priorPlanning, {
        type: PLANNING_EVENT.USER_REVISION_APPROVED,
        now: Date.now(),
        source: 'user',
        approved_by: requestInfo.sender,
        plan_id: blockedPlan.plan_id,
        steps: steps.map(description => ({ description })),
      })
      const successor = getActivePlan(revised)
      if (successor && successor.plan_id !== blockedPlan.plan_id) {
        this.planningByNpc.set(key, revised)
        userRevisionApproved = true
      }
    }

    // A fresh user instruction arriving while a committed slice is still in
    // flight REPLACES that slice. The reducer simply dropped this case before:
    // `ensurePlanningDraft` only drafts when there is no active plan, so the
    // legacy board was replanned while the reducer went on executing the old
    // plan, and the replaced slice recorded no lineage at all.
    //
    // Supersession is user authority and nothing else -- the reducer refuses
    // every other source -- so this fires only for a request that actually
    // carries a human sender and text, never for a harness continuation. The
    // blocked-revision path above already has its own lineage event and must
    // not supersede on top of it.
    const supersededPlanId = userRevisionApproved
      ? undefined
      : this.#supersedeInFlightPlan(key, requestInfo, plan, options)

    const result = super.recordPlan(key, requestInfo, plan, options)
    if (result?.state) {
      this.ensureTaskBoard(result.state)
      this.ensurePlanningDraft(key, result.state, { now: result.state.updated_at })
    }
    if (!userRevisionApproved && !supersededPlanId) return result
    return {
      ...result,
      ...(userRevisionApproved ? { userRevisionApproved: true } : {}),
      ...(supersededPlanId ? { supersededPlanId } : {}),
    }
  }

  #supersedeInFlightPlan(key, requestInfo, plan, options) {
    if (options?.continuation === true) return undefined
    if (typeof requestInfo?.sender !== 'string' || !requestInfo.sender.trim()) return undefined
    if (typeof requestInfo?.text !== 'string' || !requestInfo.text.trim()) return undefined
    const planning = key ? this.planningByNpc.get(key) : undefined
    const inFlight = getActivePlan(planning)
    if (!inFlight || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(inFlight.status)) return undefined
    const steps = (Array.isArray(plan?.plan) ? plan.plan : [])
      .filter(step => typeof step === 'string' && step.trim())
    // Re-emitting the same slice is continuation, not steering. Superseding on
    // it would churn plan identity every turn and reset reasoning each time.
    if (steps.length === 0 || sameSemanticSteps(inFlight.steps, steps)) return undefined

    // Draft first, supersede second: the successor's id is what makes the
    // replaced slice's `superseded_by_plan_id` resolvable, and it does not
    // exist until DRAFT_CREATED mints it. DRAFT_CREATED leaves committed plans
    // alone, so the in-flight slice survives this call untouched.
    const now = Date.now()
    let next = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.DRAFT_CREATED,
      now,
      origin: 'user_replan',
      steps: steps.map(description => ({ description })),
    })
    const successor = getActivePlan(next)
    if (!successor || successor.plan_id === inFlight.plan_id) return undefined

    next = applyPlanningEvent(next, {
      type: PLANNING_EVENT.PLAN_SUPERSEDED,
      now,
      source: 'user',
      plan_id: inFlight.plan_id,
      successor_plan_id: successor.plan_id,
      reason: 'user_replanned',
    })
    // If the reducer refused the supersession the draft is thrown away rather
    // than kept: a successor with no replaced predecessor is a silent second
    // plan, which is worse than leaving the in-flight slice alone.
    const replaced = next.plans.find(item => item.plan_id === inFlight.plan_id)
    if (replaced?.status !== PLAN_STATUS.SUPERSEDED) return undefined

    this.planningByNpc.set(key, next)
    return inFlight.plan_id
  }

  /**
   * Declare the user's goal satisfied. Only an authority may.
   *
   * There is deliberately no automatic emitter for this. A goal carries an
   * objective and constraints -- prose -- and no machine-checkable acceptance
   * criteria, so nothing the runtime observes can decide it has been met. The
   * roadmap draws the line explicitly: plan slice completed != capability
   * frontier reached != user goal satisfied != project ended, and the reducer
   * enforces it by refusing to derive satisfaction from any plan outcome.
   *
   * So the honest wiring is this: an explicit declaration, from a named human
   * (`user`) or from a runtime authority reporting a satisfied acceptance
   * check, always carrying its OWN evidence refs -- distinct from the evidence
   * that advanced any step. None is synthesized here; a declaration without
   * evidence is refused by the reducer and returns the state unchanged.
   */
  recordGoalSatisfaction(key, { source = 'user', declaredBy, evidenceRefs, rationale, now = Date.now() } = {}) {
    if (!key) return undefined
    const refs = (Array.isArray(evidenceRefs) ? evidenceRefs : [evidenceRefs])
      .filter(ref => typeof ref === 'string' && ref.trim())
    const before = this.planningByNpc.get(key)
    if (!before?.goal || refs.length === 0) return before
    const after = this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.GOAL_SATISFIED,
      now,
      source,
      goal_id: before.goal.goal_id,
      evidence_refs: refs,
      rationale: rationale ?? (declaredBy ? `declared_by:${declaredBy}` : undefined),
    })
    return after
  }

  applyOutcomeAuthority(key, candidate, options = {}) {
    const beforeLegacy = key ? this.planByNpc.get(key) : undefined
    if (beforeLegacy) this.ensurePlanningDraft(key, beforeLegacy, { now: beforeLegacy.updated_at })
    const result = super.applyOutcomeAuthority(key, candidate, options)
    if (!result?.decision?.accepted || !result?.state) return result

    let planning = this.planningByNpc.get(key)
    let plan = getActivePlan(planning)
    const now = result.state.updated_at ?? Date.now()
    if (!plan) return result
    // An outcome arriving is not a reason to commit a plan. These three
    // branches each used to force a commit so they had somewhere to record
    // themselves, which meant execution could admit its own plan retroactively.
    // Progress on an unreviewed draft is simply not recorded; the reducer
    // already refuses evidence for anything that is not the active committed
    // step, so this only removes the path that manufactured the exception.
    // A blocker may be recorded against a pre-commit plan; progress may not.
    const admitted = [PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)
    if (!admitted && result.decision.durable_status !== 'blocked') return result

    // Every attempt to move the active step forward is counted, including the
    // ones that fail. The deadlock signals are all progress measurements -- an
    // evidence stall, a failure code that keeps repeating -- so a batch that is
    // never counted is progress the harness cannot tell apart from success.
    if (ATTEMPT_OUTCOME_KINDS.has(result.decision.kind)) {
      plan = getActivePlan(planning)
      planning = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED,
        now,
        source: 'runtime',
        plan_id: plan?.plan_id,
        step_id: plan?.steps?.[plan.active_step_index]?.step_id,
        operation_count: Array.isArray(candidate?.operations) ? candidate.operations.length : 1,
        // Only failures carry a reason code: counting a successful batch under
        // its kind would make the repeating-failure signal fire on healthy work.
        ...(FAILED_ATTEMPT_OUTCOME_KINDS.has(result.decision.kind)
          ? { failure_reason_code: result.decision.reason_code }
          : {}),
      })
    }

    if (result.decision.durable_status === 'blocked') {
      plan = getActivePlan(planning)
      planning = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
        now,
        source: 'runtime',
        plan_id: plan?.plan_id,
        reason_code: result.state.blocker || result.decision.reason_code || 'structural_blocker',
        evidence_refs: (Array.isArray(candidate?.evidence) ? candidate.evidence : []).map(item => item?.ref).filter(Boolean),
        detail: result.state.blocker || result.decision.blocker || '',
      })
    }
    else if (result.decision.durable_status === 'completed') {
      plan = getActivePlan(planning)
      const step = plan?.steps?.[plan.active_step_index]
      if (step) {
        const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : []
        const ref = evidence.find(item => typeof item?.ref === 'string' && item.ref)?.ref
          ?? `outcome/${plan.plan_id}/${step.step_id}/${now}`
        planning = applyPlanningEvent(planning, {
          type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
          now,
          plan_id: plan.plan_id,
          step_id: step.step_id,
          evidence: {
            source: 'runtime',
            kind: 'outcome_authority',
            ref,
            contract_satisfied: true,
          },
        })
        planning = applyPlanningEvent(planning, {
          type: PLANNING_EVENT.STEP_COMPLETED,
          now,
          source: 'runtime',
          plan_id: plan.plan_id,
          step_id: step.step_id,
        })
        if (result.state.status === 'completed') {
          planning = applyPlanningEvent(planning, {
            type: PLANNING_EVENT.PLAN_COMPLETED,
            now,
            source: 'runtime',
            plan_id: plan.plan_id,
            verified_results: evidence.map(item => item?.summary).filter(Boolean),
          })
          // A completed plan is the boundary the roadmap cares about most: the
          // slice is immutable and done, nothing is in flight, and the next
          // draft has not been authored yet.
          this.planningByNpc.set(key, planning)
          const steeringBefore = planning.steering?.sequence ?? 0
          planning = this.evaluateSteeringAtBoundary(key, {
            boundary: STEERING_BOUNDARY.PLAN_COMPLETED,
            now,
            planId: plan.plan_id,
          }) ?? planning
          // Advice is written for one boundary and consumed by it -- but only
          // if the reducer actually accepted that boundary. The legacy board
          // can report `completed` before the reducer's last step lands, and
          // discarding the advice on a refused evaluation would silently drop
          // it before the real boundary arrived.
          if ((planning.steering?.sequence ?? 0) > steeringBefore) this.recordSteeringAdvice(key, null)
        }
      }
    }

    // Deterministic, harness-side, no model call (roadmap 7). Evaluated after
    // the batch is counted so a signal fires on the attempt that crossed the
    // threshold rather than one attempt late.
    const deadlock = evaluateDeadlockSignals(planning)
    if (deadlock.deadlocked) {
      planning = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.DEADLOCK_DETECTED,
        now,
        source: 'runtime',
        plan_id: deadlock.plan_id,
        reason_code: deadlock.signals[0]?.kind ?? 'deadlock_detected',
        signals: deadlock.signals,
      })
    }

    this.planningByNpc.set(key, planning)
    this.syncPlanningState(key, result.state)
    return { ...result, state: result.state }
  }

  snapshot() {
    const snapshot = super.snapshot()
    return {
      ...snapshot,
      planning_states: [...this.planningByNpc.entries()].map(([key, state]) => ({
        key,
        state: serializePlanningState(state),
      })),
    }
  }

  restore(snapshot) {
    // Rehydrate contracts before the generic memory sanitization can discard
    // unknown fields. This is deliberately independent of the retired project
    // hierarchy: the Task Board remains the compatibility projection for a
    // single ordinary plan.
    const persistedStepContracts = new Map(
      Array.isArray(snapshot?.plans)
        ? snapshot.plans
            .filter(item => item && typeof item.key === 'string')
            .map(item => [item.key, new Map(
              (Array.isArray(item?.state?.task_board?.steps) ? item.state.task_board.steps : [])
                .filter(step => typeof step?.id === 'string')
                .map(step => [step.id, {
                  contract: step.completion_contract,
                  at: step.completion_contract_at,
                }]),
            )])
        : [],
    )
    super.restore(snapshot)
    for (const [key, state] of this.planByNpc.entries()) {
      const stepContracts = persistedStepContracts.get(key)
      if (state.task_board && Array.isArray(state.task_board.steps) && stepContracts) {
        state.task_board.steps = state.task_board.steps.map(step => {
          const persisted = stepContracts.get(step.id)
          const contract = safeDurableStepCompletionContract(persisted?.contract)
          return contract
            ? {
                ...step,
                completion_contract: contract,
                completion_contract_at: Number.isFinite(persisted?.at) ? persisted.at : state.updated_at,
              }
            : step
        })
      }
      this.planByNpc.set(key, state)
    }

    this.planningByNpc.clear()
    for (const item of Array.isArray(snapshot?.planning_states) ? snapshot.planning_states.slice(0, 128) : []) {
      if (!item || typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) continue
      const restored = restorePlanningState(item.state)
      if (!restored.goal) continue
      this.planningByNpc.set(item.key, restored)
    }

    // Upgrade legacy snapshots in place. Active/blocked state in Task Board Lite
    // represents already-admitted work, so migration may commit it immediately.
    for (const [key, state] of this.planByNpc.entries()) {
      let planning = this.planningByNpc.get(key)
      if (!planning) {
        planning = this.ensurePlanningDraft(key, state, { now: state.updated_at, migrated: true })
        // Not a fresh admission: this plan was admitted by a previous run and
        // is being reconstructed from disk. The review is stated explicitly so
        // the provenance is visible, rather than defaulted into existence.
        planning = this.commitPlanningPlan(key, {
          now: state.updated_at,
          migrated: true,
          review: {
            verdict: 'actionable',
            reason_codes: ['restored_from_legacy_snapshot'],
            confidence: 0,
            runtime_validation: { passed: true },
          },
        })
        planning = this.replayLegacyVerifiedPrefix(key, state, planning, { now: state.updated_at })
        const plan = getActivePlan(planning)
        if (state.status === 'blocked' && plan) {
          planning = applyPlanningEvent(planning, {
            type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
            now: state.updated_at,
            source: 'runtime',
            plan_id: plan.plan_id,
            reason_code: state.blocker || 'restored_blocker',
            detail: state.blocker || '',
          })
          this.planningByNpc.set(key, planning)
        }
      }
      this.syncPlanningState(key, state)
    }
  }

  reconcileTaskBoard(key, previousBoard, plan, stateResult, options = {}) {
    const truthState = options.previousState ?? stateResult?.state
    // `recordPlan()` predates immutable planning and may have tentatively set
    // the legacy state back to active before reconciliation runs. A blocked
    // Task Board is authoritative: preserve its immutable steps and freeze
    // until an explicit user revision enters through the new planning-state
    // transition path.
    if (previousBoard?.kind === 'task_board_lite'
      && previousBoard.status === 'blocked'
      && stateResult?.state
      && stateResult?.userRevisionApproved !== true) {
      const state = stateResult.state
      state.status = 'blocked'
      state.blocker = previousBoard.blocker ?? state.blocker
      state.pause_reason = previousBoard.pause_reason ?? state.pause_reason
      state.task_board = previousBoard
      state.plan = previousBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
      state.current_step = Number.isSafeInteger(previousBoard.active_index) ? previousBoard.active_index : 0
      this.planByNpc.set(key, state)
      return { ...stateResult, state, blockedByHarness: true }
    }
    const durableContracts = new Map(
      (Array.isArray(previousBoard?.steps) ? previousBoard.steps : [])
        .flatMap(step => {
          const contract = safeDurableStepCompletionContract(step?.completion_contract)
          return typeof step?.id === 'string' && contract
            ? [[step.id, { contract, at: step.completion_contract_at }]]
            : []
        }),
    )
    const revisionApproved = stateResult?.userRevisionApproved === true
    // BLOCKED is frozen for ordinary continuation. The only exception is the
    // explicit user-revision path already authorized by USER_REVISION_APPROVED.
    const guarded = revisionApproved
      ? plan
      : canonicalContinuationPlan(previousBoard, plan, {
          ...options,
          previousState: truthState,
          allowReplan: options.allowReplan,
        })
    const result = super.reconcileTaskBoard(key, previousBoard, guarded, stateResult, {
      ...options,
      allowReplan: revisionApproved ? true : options.allowReplan,
    })
    if (result?.state?.task_board && Array.isArray(result.state.task_board.steps) && durableContracts.size > 0) {
      result.state.task_board.steps = result.state.task_board.steps.map(step => {
        const durable = durableContracts.get(step.id)
        return durable
          ? {
              ...step,
              completion_contract: durable.contract,
              completion_contract_at: Number.isFinite(durable.at) ? durable.at : result.state.updated_at,
            }
          : step
      })
      this.planByNpc.set(key, result.state)
    }
    if (result?.state) {
      this.ensurePlanningDraft(key, result.state, { now: result.state.updated_at })
      this.syncPlanningState(key, result.state)
    }
    if (result?.state?.status === 'completed') this.planByNpc.delete(key)
    return result
  }

  recordBoardEvidence(key, evidence) {
    const boardAfterReceipt = super.recordBoardEvidence(key, evidence)
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !boardAfterReceipt) return boardAfterReceipt

    if (evidence?.kind === 'operation_error_receipt' && stateHasUnverifiedTransferIntent(state)) {
      const reason = transferFailureReason(evidence)
      return this.applyOutcomeAuthority(key, {
        kind: 'world_blocked',
        source: 'autorio',
        reason_code: `transfer_failed:${reason}`,
        candidate_blocker: `transfer_failed:${reason}`,
        evidence: [evidence],
      }).state?.task_board ?? boardAfterReceipt
    }

    if (state.status !== 'active' || boardAfterReceipt.status !== 'active') return boardAfterReceipt

    const verification = verifyDeterministicReceipt(state, evidence)
    if (!verification.verified) return boardAfterReceipt
    const ref = `batch_${verification.batchId}`
    if ((boardAfterReceipt.evidence ?? []).some(item => item?.kind === 'deterministic_verification' && item?.ref === ref)) {
      return boardAfterReceipt
    }

    super.recordBoardEvidence(key, {
      kind: 'deterministic_verification',
      ref,
      summary: JSON.stringify({
        verdict: 'verified_complete',
        semantics: 'Every operation in this batch has strict runtime completion semantics; the completed batch receipt therefore proves the current step action finished without a model guess.',
        batch_id: verification.batchId,
        operations: verification.operationNames,
        task_types: verification.taskTypes,
      }),
    })

    const current = this.planByNpc.get(key)
    if (current) {
      current.last_mutation_verified = true
      current.last_verified_batch_id = verification.batchId
      this.planByNpc.set(key, current)
    }
    const verifiedBoard = this.ensureTaskBoard(current)
    if (!current || !verifiedBoard || verifiedBoard.status !== 'active') return verifiedBoard

    // Strict operation completion is grounded evidence, not semantic step
    // completion authority. The Runtime Completion Gate decides whether this
    // proof is sufficient for the active canonical step.
    return verifiedBoard
  }

  terminatePlan(key) {
    const previous = key ? this.planByNpc.get(key) : undefined
    if (!previous) return undefined
    const planning = this.planningByNpc.get(key)
    const plan = getActivePlan(planning)
    if (plan) {
      this.planningByNpc.set(key, applyPlanningEvent(planning, {
        type: PLANNING_EVENT.PLAN_CANCELLED,
        now: Date.now(),
        source: 'user',
        plan_id: plan.plan_id,
        reason: 'task_context_terminated',
      }))
    }
    this.planByNpc.delete(key)
    return previous
  }
}
