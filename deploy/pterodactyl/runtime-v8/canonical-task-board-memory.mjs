import { NpcDialogueMemory } from './npc-agent-loop.mjs'
import { reconcileTaskBoard, setTaskBoardStatus } from './common.mjs'
import { completionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  PLAN_STATUS,
  PLANNING_EVENT,
  reasoningEpochOf,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'

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
      const sameSemanticPlan = reducerSteps.length === boardBefore.steps.length
        && reducerSteps.every((description, index) => clean(description) === clean(boardBefore.steps[index]?.description))
      const proposedFocusIndex = boardBefore.proposed_focus_index
      const proposedFocusStepId = boardBefore.proposed_focus_step_id
      legacyState.task_board = reconcileTaskBoard(
        boardBefore,
        reducerSteps,
        plan.active_step_index,
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

  ensurePlanningDraft(key, state, { now = Date.now(), migrated = false } = {}) {
    if (!key || !state) return undefined
    let planning = this.planningByNpc.get(key)
    const existingPlan = getActivePlan(planning)
    const terminalReusableSlot = existingPlan
      && [PLAN_STATUS.COMPLETED, PLAN_STATUS.CANCELLED, PLAN_STATUS.SUPERSEDED].includes(existingPlan.status)
    if (!planning?.goal || planning.goal.goal_id !== state.goal_id || terminalReusableSlot) {
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
    this.syncPlanningState(key, state)
    return planning
  }

  commitPlanningPlan(key, { now = Date.now(), migrated = false } = {}) {
    const legacy = key ? this.planByNpc.get(key) : undefined
    let planning = this.ensurePlanningDraft(key, legacy, { now, migrated })
    const plan = getActivePlan(planning)
    if (!plan) return planning
    if ([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(plan.status)) return planning
    planning = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.PLAN_COMMITTED,
      now,
      plan_id: plan.plan_id,
      jev_verdict: 'actionable',
      runtime_validation: { passed: true },
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
      let refreshed = applyPlanningEvent(planning, {
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

    const result = super.recordPlan(key, requestInfo, plan, options)
    if (result?.state) {
      this.ensureTaskBoard(result.state)
      this.ensurePlanningDraft(key, result.state, { now: result.state.updated_at })
    }
    return userRevisionApproved ? { ...result, userRevisionApproved: true } : result
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

    if (result.decision.durable_status === 'blocked') {
      planning = this.commitPlanningPlan(key, { now, migrated: true })
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
      planning = this.commitPlanningPlan(key, { now, migrated: true })
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
        }
      }
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
        planning = this.commitPlanningPlan(key, { now: state.updated_at, migrated: true })
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
