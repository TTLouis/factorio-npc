import { NpcDialogueMemory, OPERATION_FAILURE_RECOVERABLE_KIND } from './npc-agent-loop.mjs'
import { createTaskBoard, reconcileTaskBoard, setTaskBoardStatus } from './common.mjs'
import { validateOutcomeCandidate } from './outcome-authority.mjs'
import { completionContractSupported, provePermanentlyUnsatisfiable, sanitizeStepCompletionContract } from './step-completion.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  evaluateDeadlockSignals,
  getActivePlan,
  GOAL_STATUS,
  PLAN_STATUS,
  PLANNING_EVENT,
  planTrackerView,
  reasoningEpochOf,
  restorePlanningState,
  serializePlanningState,
  STEERING_BOUNDARY,
  steeringContextForDraft,
} from './planning-state.mjs'

// Which reducer event carries each legacy run field.
const RUN_FIELD_EVENTS = Object.freeze({
  condition_wait: { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, prop: 'wait' },
  provider_recovery: { type: PLANNING_EVENT.PROVIDER_RECOVERY_RECORDED, prop: 'recovery' },
  persistent_runtime: { type: PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED, prop: 'runtime' },
})

// The mirror must not share objects with the reducer state.
function cloneRunRecord(value) {
  return value ? JSON.parse(JSON.stringify(value)) : undefined
}

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

// Statuses whose plan may still be replaced outright by a new submission:
// nothing has been admitted yet, so nothing is frozen.
const PRE_COMMIT_REPLACEABLE_STATUSES = Object.freeze([
  PLAN_STATUS.DRAFT,
  PLAN_STATUS.RUNTIME_VALIDATION,
  PLAN_STATUS.READY,
])

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
  ['launch_rocket', ['launching_rocket']],
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

// Two step lists describe the same slice when their normalized descriptions
// match one for one. Long descriptions are compared on a bounded prefix so a
// truncation on either side cannot split them.
function stepKey(description) {
  return clean(description).slice(0, 200)
}

function carriedPrefixLength(plan) {
  return Array.isArray(plan?.carried_forward_evidence) ? plan.carried_forward_evidence.length : 0
}

/**
 * How the legacy board and the reducer plan line up: the board index of the
 * reducer plan's first step. A revised plan carries its verified predecessor
 * steps on the board only (offset = carried prefix); every other plan starts
 * at 0. `undefined` when the two do not describe the same steps.
 */
export function boardPlanAlignment(board, plan) {
  if (!Array.isArray(board?.steps) || !Array.isArray(plan?.steps) || plan.steps.length === 0) return undefined
  const aligned = offset => board.steps.length === offset + plan.steps.length
    && plan.steps.every((step, index) => stepKey(step?.description) === stepKey(board.steps[offset + index]?.description))
  const carried = carriedPrefixLength(plan)
  if (carried > 0 && aligned(carried)) return carried
  return aligned(0) ? 0 : undefined
}

/**
 * The steps a reducer DRAFT is built from. The legacy board of a revised plan
 * begins with the predecessor's verified steps; those live in the predecessor
 * and in `carried_forward_evidence`, never in the successor's own step list.
 * Copying the whole board into the draft gave the reducer a step the board had
 * already completed, and every later close landed one step off (live run
 * 2026-09-29, finding 7).
 */
function draftStepsFromBoard(board, draftPlan) {
  const steps = Array.isArray(board?.steps) ? board.steps : []
  const carried = carriedPrefixLength(draftPlan)
  const prefixVerified = carried > 0
    && steps.length > carried
    && steps.slice(0, carried).every(step => step?.status === 'completed')
  return (prefixVerified ? steps.slice(carried) : steps).map(step => ({
    description: step.description,
    completion_contract: safeDurableStepCompletionContract(step.completion_contract),
  }))
}

// Real evidence the legacy board holds for a step it closed. Only kinds the
// runtime itself recorded count: a checkpoint contract verified against the
// world, or a fresh-observation semantic judgment with a runtime receipt bound
// to the same step. Anything else is not proof.
function legacyStepCloseProof(board, legacyStep, reducerStep) {
  const forStep = (Array.isArray(board?.evidence) ? board.evidence : [])
    .filter(item => item?.step_id === legacyStep?.id && typeof item.ref === 'string' && item.ref)
  if (reducerStep?.completion_contract) {
    const proof = forStep.find(item => item.kind === 'verified_world_state' && item.ref === `checkpoint/${legacyStep.id}`)
    if (!proof) return undefined
    let parsed
    try { parsed = JSON.parse(proof.summary) }
    catch { return undefined }
    const satisfied = (Array.isArray(parsed?.results) ? parsed.results : [])
      .filter(result => result?.satisfied === true && typeof result.id === 'string')
      .map(result => result.id)
    return satisfied.length > 0 ? { kind: 'contract', ref: proof.ref, satisfied } : undefined
  }
  const semantic = forStep.find(item => item.kind === 'verified_world_state' && item.ref.includes('/semantic_fresh_observation/'))
  const receipted = forStep.some(item => item.kind === 'deterministic_verification' || item.kind === 'operation_receipt')
  return semantic && receipted ? { kind: 'semantic', ref: semantic.ref } : undefined
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

// The deterministic preflight rejection that proves an exact identity is gone.
// `npc-agent-loop` records it as board evidence on the recoverable path, which
// makes this the live seam where the world's proof reaches the reducer.
function staleExactTargetProof(evidence) {
  if (evidence?.kind !== 'operation_preflight_recoverable' || typeof evidence.summary !== 'string') return undefined
  let parsed
  try { parsed = JSON.parse(evidence.summary) }
  catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (parsed.code !== 'stale_exact_target') return undefined
  const identity = Number(parsed.identity)
  if (!Number.isSafeInteger(identity) || identity <= 0) return undefined
  return { unitNumber: identity, ref: typeof evidence.ref === 'string' ? evidence.ref : undefined }
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

// A placement the engine refused at a planner-chosen coordinate is a planning
// error the planner can correct from the refusal details (footprint, grid with
// nearest_valid_center, blockers), not proof that the world prevents the step.
// It goes back to the planner on the ordinary failure continuation with the
// committed step unchanged, and becomes a world blocker only when the same
// step has been refused this many times in a row.
export const CORRECTABLE_PLACEMENT_RETRY_BUDGET = 2
const CORRECTABLE_PLACEMENT_CODES = new Set(['not_placeable'])

function correctablePlacementRefusal(evidence) {
  if (evidence?.kind !== 'operation_error_receipt') return undefined
  const receipt = parseReceiptSummary(evidence)
  const basic = receipt?.basic_operation
  // basic_operation only survives the runtime receipt when it correlates with
  // this batch (task type, tick, actor), so it names the operation that failed.
  if (basic?.type !== 'placing' || basic.completed === true) return undefined
  if (!CORRECTABLE_PLACEMENT_CODES.has(basic.code)) return undefined
  const nearest = basic.placement_grid?.nearest_valid_center
  return {
    task_type: 'placing',
    code: basic.code,
    entity_name: typeof basic.entity_name === 'string' ? basic.entity_name : undefined,
    nearest_valid_center: nearest && Number.isFinite(nearest.x) && Number.isFinite(nearest.y)
      ? { x: nearest.x, y: nearest.y }
      : undefined,
    placement_blockers: Array.isArray(basic.placement_blockers)
      ? basic.placement_blockers.slice(0, 4).map(blocker => ({
          name: typeof blocker?.name === 'string' ? blocker.name : undefined,
          position: blocker?.position && Number.isFinite(blocker.position.x) && Number.isFinite(blocker.position.y)
            ? { x: blocker.position.x, y: blocker.position.y }
            : undefined,
        }))
      : undefined,
  }
}

// Consecutive recoverable refusals of the active step. A completed batch for
// the same step ends the streak, so a multi-placement step is not blocked by
// independent refusals it already corrected.
// A re-reported failure of the same batch (same ref) is not another attempt.
function consecutiveRecoverableFailures(board) {
  const stepId = board?.active_step_id
  const refs = new Set()
  let count = 0
  for (const item of [...(board?.evidence ?? [])].reverse()) {
    if (item?.step_id !== stepId) continue
    if (item.kind === OPERATION_FAILURE_RECOVERABLE_KIND) {
      count++
      if (item.ref) refs.add(item.ref)
    }
    else if (item.kind === 'operation_receipt' || item.kind === 'deterministic_verification') break
  }
  return { count, refs }
}

// The blocker names the operation that failed, not the batch's transfer
// intent: a refused placement in a place + supply batch is placement_failed,
// and transfer_failed means items really failed to move.
const OPERATION_FAILURE_LABELS = {
  moving_items: 'transfer',
  placing: 'placement',
  crafting: 'crafting',
  mining: 'mining',
  harvesting: 'harvest',
  walking_to_entity: 'movement',
  attacking: 'combat',
  researching: 'research',
  rotating: 'rotation',
  waiting: 'wait',
}

// A refused operation's batch reason is `<task type>:<code>:<cause>` (mod
// task_manager close_refused_batch), e.g.
// `moving_items:nothing_moved:input_slot_holds_other_item`. The cause is kept
// on the blocker so `nothing_moved` never reaches the plan without its why.
const REFUSAL_CAUSE_PATTERN = /^[a-z_]+$/

export function operationRefusalCause(receipt, basic) {
  if (typeof receipt?.reason !== 'string' || typeof basic?.type !== 'string' || typeof basic?.code !== 'string') return undefined
  const prefix = `${basic.type}:${basic.code}:`
  if (!receipt.reason.startsWith(prefix)) return undefined
  const cause = receipt.reason.slice(prefix.length)
  return REFUSAL_CAUSE_PATTERN.test(cause) && cause.length <= 64 ? cause : undefined
}

export function operationFailureReasonCode(evidence) {
  const receipt = parseReceiptSummary(evidence)
  const basic = receipt?.basic_operation
  const code = typeof basic?.code === 'string' && basic.code ? basic.code : undefined
  const reason = typeof receipt?.reason === 'string' && receipt.reason ? receipt.reason : undefined
  // basic_operation is only present when it correlates with this batch; without
  // it the failing operation is unknown, so the label doesn't guess.
  const label = Object.hasOwn(OPERATION_FAILURE_LABELS, basic?.type) ? OPERATION_FAILURE_LABELS[basic.type] : 'operation'
  const cause = code ? operationRefusalCause(receipt, basic) : undefined
  return `${label}_failed:${code ?? reason ?? 'operation_failed'}${cause ? `:${cause}` : ''}`
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
  if (previousBoard.status === 'completed') return plan
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
    // Board progress the reducer could not be brought up to on restore.
    this.restoreDiagnostics = []
    // Consecutive plan/board disagreements per NPC: { step_id, count }.
    this.disagreementStrikes = new Map()
  }

  planningState(key) {
    return key ? this.planningByNpc.get(key) : undefined
  }

  planningTrackerView(key) {
    return planTrackerView(this.planningState(key))
  }

  /**
   * The Plan Tracker step id for a legacy board step index, or undefined when
   * the board and the plan do not describe the same steps. A revised plan's
   * board starts with its predecessor's verified steps, so the two indexes
   * differ by the carried prefix.
   */
  trackerStepIdForBoardIndex(key, boardIndex) {
    const plan = getActivePlan(this.planningState(key))
    const state = key ? this.planByNpc.get(key) : undefined
    if (!plan || !state?.task_board || !Number.isSafeInteger(boardIndex)) return undefined
    const offset = boardPlanAlignment(state.task_board, plan)
    return offset === undefined ? undefined : plan.steps[boardIndex - offset]?.step_id
  }

  /**
   * An ACTIVE reducer goal that never got a plan or a legacy record: its
   * request failed before recordPlan. It must not capture a later, different
   * request (which would be rewritten to the old objective); that request is
   * admitted as a new goal instead.
   */
  #isOrphanGoalForObjective(key, planning, objective) {
    if (planning?.goal?.status !== GOAL_STATUS.ACTIVE) return false
    // A shelf on the goal means work was already built on it (the planner
    // decomposed the goal); only a bare goal, admitted and then abandoned, is
    // an orphan.
    if (getActivePlan(planning) || this.planByNpc.get(key) || planning.roadmap) return false
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000)
    const incoming = normalize(objective)
    return incoming.length > 0 && incoming !== normalize(planning.goal.objective)
  }

  admitPlanningGoal(key, { owner = 'unknown', objective = '', goalId, now = Date.now() } = {}) {
    if (!key || typeof objective !== 'string' || !objective.trim()) return this.planningState(key)
    const current = this.planningState(key)
    if (current?.goal?.status === GOAL_STATUS.ACTIVE && !this.#isOrphanGoalForObjective(key, current, objective)) return current
    // The reducer mints the goal id (GOAL_ACCEPTED). A caller-supplied id is
    // only honoured for tests/migration that must pin one.
    const next = applyPlanningEvent(current ?? createEmptyPlanningState(), {
      type: PLANNING_EVENT.GOAL_ACCEPTED,
      now,
      ...(typeof goalId === 'string' && goalId.trim() ? { goal_id: goalId.trim().slice(0, 120) } : {}),
      owner: String(owner ?? 'unknown').slice(0, 128),
      objective: objective.slice(0, 1000),
    })
    this.planningByNpc.set(key, next)
    return next
  }

  /**
   * Goal id for a legacy state that is about to be created. Reuses the
   * reducer's active goal (its plan not cancelled), otherwise admits a fresh
   * goal through GOAL_ACCEPTED and returns the id the reducer minted. Legacy
   * record paths call this instead of minting their own id.
   */
  resolveReducerGoalId(key, requestInfo, { now = Date.now() } = {}) {
    if (!key) return undefined
    const planning = this.planningByNpc.get(key)
    if (planning?.goal?.status === GOAL_STATUS.ACTIVE
      && getActivePlan(planning)?.status !== PLAN_STATUS.CANCELLED
      && !this.#isOrphanGoalForObjective(key, planning, requestInfo?.text)) {
      return planning.goal.goal_id
    }
    const objective = typeof requestInfo?.text === 'string' ? requestInfo.text.trim() : ''
    if (!objective) return undefined
    const next = applyPlanningEvent(planning ?? createEmptyPlanningState(), {
      type: PLANNING_EVENT.GOAL_ACCEPTED,
      now,
      owner: String(requestInfo?.sender ?? 'unknown').slice(0, 128),
      objective: objective.slice(0, 1000),
    })
    if (!next?.goal || next === planning) return undefined
    this.planningByNpc.set(key, next)
    return next.goal.goal_id
  }

  // --- run state (3.3 move 3) ----------------------------------------------
  //
  // pause / resume, condition wait, provider recovery and the follow runtime
  // are written by the reducer (RUN_PAUSED, RUN_RESUMED, *_RECORDED). The
  // legacy record keeps the same fields as a MIRROR of the reducer result, so
  // every existing reader keeps working until Phase 8 removes the board. The
  // base class calls these hooks at each place it used to write the field.

  #reducerHoldsGoal(key, legacyState) {
    const planning = key ? this.planningByNpc.get(key) : undefined
    return planning?.goal?.status === GOAL_STATUS.ACTIVE
      && typeof legacyState?.goal_id === 'string'
      && planning.goal.goal_id === legacyState.goal_id
  }

  #applyRunEvent(key, event) {
    const before = this.planningByNpc.get(key)
    if (!before) return undefined
    const after = applyPlanningEvent(before, { source: 'runtime', ...event, now: Date.now() })
    if (after !== before) this.planningByNpc.set(key, after)
    return after
  }

  writeRunField(key, state, field, value) {
    const spec = RUN_FIELD_EVENTS[field]
    if (!spec || !this.#reducerHoldsGoal(key, state)) return super.writeRunField(key, state, field, value)
    const after = this.#applyRunEvent(key, {
      type: spec.type,
      goal_id: state.goal_id,
      [spec.prop]: value ?? null,
    })
    state[field] = cloneRunRecord(after?.run?.[field])
    return undefined
  }

  recordRunPause(key, state, reason) {
    if (!this.#reducerHoldsGoal(key, state)) return super.recordRunPause(key, state, reason)
    const after = this.#applyRunEvent(key, { type: PLANNING_EVENT.RUN_PAUSED, goal_id: state.goal_id, reason })
    // The reducer refused (goal not active): fall back to the legacy write so
    // the record still pauses.
    if (!after?.run?.paused) return super.recordRunPause(key, state, reason)
    state.pause_reason = after.run.pause_reason
    state.persistent_runtime = undefined
    state.condition_wait = undefined
    return undefined
  }

  recordRunResume(key, state, reason) {
    if (this.#reducerHoldsGoal(key, state)) {
      this.#applyRunEvent(key, { type: PLANNING_EVENT.RUN_RESUMED, goal_id: state.goal_id, reason })
    }
    return super.recordRunResume(key, state, reason)
  }

  recordLocators(key, state, { durableOperations, exactTargetAudit, previousExactTargetAudit } = {}) {
    if (!this.#reducerHoldsGoal(key, state)) return super.recordLocators(key, state, { durableOperations, exactTargetAudit, previousExactTargetAudit })
    const held = this.planningByNpc.get(key)?.run?.locators?.exact_target_audit ?? []
    const previous = Array.isArray(previousExactTargetAudit) ? previousExactTargetAudit : []
    const incoming = Array.isArray(exactTargetAudit) ? exactTargetAudit : []
    // The reducer holds no audit yet but the legacy record does (a record that
    // predates the reducer field): carry the legacy entries over once.
    const carryOver = held.length === 0 && previous.length > 0
    const after = this.#applyRunEvent(key, {
      type: PLANNING_EVENT.LOCATORS_RECORDED,
      goal_id: state.goal_id,
      durable_last_operations: Array.isArray(durableOperations) ? durableOperations : [],
      exact_target_audit: carryOver ? [...previous, ...incoming] : incoming,
      ...(carryOver ? { exact_target_audit_mode: 'replace' } : {}),
    })
    const locators = after?.run?.locators
    if (locators) {
      state.durable_last_operations = cloneRunRecord(locators.durable_last_operations) ?? []
      state.exact_target_audit = cloneRunRecord(locators.exact_target_audit) ?? []
    }
    return undefined
  }

  /**
   * Bring a legacy record's run fields in line with the reducer run (the
   * reducer wins). Used after the legacy record was rebuilt wholesale.
   * Locators are mirrored only when asked: recordPlan mirrors them itself, and
   * a legacy record must not lose entries because the reducer never saw them.
   */
  mirrorRunToLegacy(key, legacyState = key ? this.planByNpc.get(key) : undefined, { locators = false } = {}) {
    const run = key ? this.planningByNpc.get(key)?.run : undefined
    if (!run || !this.#reducerHoldsGoal(key, legacyState)) return legacyState
    if (locators) {
      legacyState.durable_last_operations = cloneRunRecord(run.locators.durable_last_operations) ?? []
      legacyState.exact_target_audit = cloneRunRecord(run.locators.exact_target_audit) ?? []
    }
    legacyState.condition_wait = cloneRunRecord(run.condition_wait)
    legacyState.provider_recovery = cloneRunRecord(run.provider_recovery)
    legacyState.persistent_runtime = cloneRunRecord(run.persistent_runtime)
    if (legacyState.status === 'paused' && run.paused) legacyState.pause_reason = run.pause_reason
    return legacyState
  }

  /**
   * Seed the reducer run ONCE from a legacy record when the reducer has none:
   * an old snapshot (pre-run), a migrated legacy state, or a legacy record
   * that predates its reducer goal. After this the reducer is the writer.
   */
  seedRunFromLegacy(key, legacyState = key ? this.planByNpc.get(key) : undefined) {
    const planning = key ? this.planningByNpc.get(key) : undefined
    if (!planning || planning.run || !this.#reducerHoldsGoal(key, legacyState)) return planning
    const base = { source: 'legacy_adopted', goal_id: legacyState.goal_id }
    if (legacyState.status === 'paused') {
      this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.RUN_PAUSED, reason: legacyState.pause_reason })
    }
    if (legacyState.condition_wait) {
      this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, wait: legacyState.condition_wait })
    }
    if (legacyState.provider_recovery) {
      this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.PROVIDER_RECOVERY_RECORDED, recovery: legacyState.provider_recovery })
    }
    if (legacyState.persistent_runtime) {
      this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED, runtime: legacyState.persistent_runtime })
    }
    const durable = Array.isArray(legacyState.durable_last_operations) ? legacyState.durable_last_operations : []
    const audit = Array.isArray(legacyState.exact_target_audit) ? legacyState.exact_target_audit : []
    if (durable.length > 0 || audit.length > 0) {
      this.#applyRunEvent(key, {
        ...base,
        type: PLANNING_EVENT.LOCATORS_RECORDED,
        durable_last_operations: durable,
        exact_target_audit: audit,
        exact_target_audit_mode: 'replace',
      })
    }
    return this.planningByNpc.get(key)
  }

  // --- receipt ledger (3.3 move 2) -----------------------------------------
  //
  // Every board evidence item is recorded in the reducer's per-step receipt
  // ledger FIRST (OPERATION_RECEIPT_RECORDED); `task_board.evidence` is then
  // written as a MIRROR: the reducer's accepted identity (kind, ref, at) drives
  // it, while the full `summary` text comes from the receipt itself. The
  // ledger keeps only a short digest, and existing readers JSON.parse board
  // summaries (legacyStepCloseProof, the completion gate), so the board must
  // never be rebuilt from the digest. When the reducer refuses (no admitted
  // goal or plan, step outside the plan) the legacy write proceeds unchanged.

  #ledgerStepFor(planning, plan, board) {
    const offset = boardPlanAlignment(board, plan)
    if (offset === undefined) return plan?.steps?.[plan.active_step_index]?.step_id
    const index = (Number.isSafeInteger(board?.active_index) ? board.active_index : 0) - offset
    return plan.steps[index]?.step_id
  }

  appendBoardEvidence(key, state, board, item) {
    if (!this.#reducerHoldsGoal(key, state) || !item || typeof item !== 'object') {
      return super.appendBoardEvidence(key, state, board, item)
    }
    const before = this.planningByNpc.get(key)
    const plan = getActivePlan(before)
    const stepId = plan ? this.#ledgerStepFor(before, plan, board) : undefined
    if (!plan || !stepId) return super.appendBoardEvidence(key, state, board, item)
    const seqBefore = Math.max(0, ...(plan.execution.receipts?.[stepId] ?? []).map(entry => entry.seq ?? 0))
    const after = this.#applyRunEvent(key, {
      type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED,
      goal_id: state.goal_id,
      plan_id: plan.plan_id,
      step_id: stepId,
      kind: item.kind,
      ref: item.ref,
      summary: item.summary,
      at: item.now,
    })
    const recorded = (after?.plans.find(candidate => candidate.plan_id === plan.plan_id)?.execution.receipts?.[stepId] ?? [])
      .filter(entry => (entry.seq ?? 0) > seqBefore)
      .at(-1)
    if (!recorded) return super.appendBoardEvidence(key, state, board, item)
    return super.appendBoardEvidence(key, state, board, { ...item, kind: recorded.kind, ref: recorded.ref, now: recorded.at })
  }

  /**
   * Seed the active plan's receipt ledger ONCE from the legacy board evidence
   * when the snapshot predates the ledger. Board evidence for steps of the
   * plan (found through the board/plan alignment) is adopted per step; the
   * marker is set even when there is nothing to adopt, so it never runs twice.
   */
  seedReceiptLedgerFromLegacy(key, legacyState = key ? this.planByNpc.get(key) : undefined) {
    const planning = key ? this.planningByNpc.get(key) : undefined
    const plan = getActivePlan(planning)
    if (!plan || plan.execution.receipts_seeded === true || !this.#reducerHoldsGoal(key, legacyState)) return planning
    const board = legacyState.task_board
    const offset = boardPlanAlignment(board, plan)
    const base = { source: 'legacy_adopted', goal_id: legacyState.goal_id, plan_id: plan.plan_id }
    let seededAny = false
    if (offset !== undefined) {
      for (const [index, step] of plan.steps.entries()) {
        const boardStepId = board.steps[offset + index]?.id
        const receipts = (Array.isArray(board.evidence) ? board.evidence : [])
          .filter(item => item?.step_id === boardStepId)
          .map(item => ({ kind: item.kind, ref: item.ref, summary: item.summary, at: item.at }))
        if (receipts.length === 0) continue
        this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED, step_id: step.step_id, receipts })
        seededAny = true
      }
    }
    if (!seededAny) {
      this.#applyRunEvent(key, { ...base, type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED, receipts: [] })
    }
    return this.planningByNpc.get(key)
  }

  beginActionOmissionRecovery(key, requestInfo, plan, options = {}) {
    return super.beginActionOmissionRecovery(key, requestInfo, plan, {
      ...options,
      resolveGoalId: () => this.resolveReducerGoalId(key, requestInfo),
    })
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
      const projected = reconcileTaskBoard(
        boardBefore,
        semanticPlan,
        authoritativeIndex,
        { now: planning.updated_at || legacyState.updated_at || Date.now(), authoritativeAdvance: true, allowReplan: false },
      )
      // The projection only ever moves forward. A board that already shows
      // more verified progress than the reducer (a snapshot written before the
      // reducer caught up) is never regressed by a sync: restore converges the
      // reducer up to it where the board holds real evidence, and traces the
      // rest.
      legacyState.task_board = (projected?.completed_count ?? 0) < (boardBefore.completed_count ?? 0)
        ? boardBefore
        : projected
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

  ensurePlanningDraft(key, state, { now = Date.now(), migrated = false, roadmap, roadmapNodeIds, developmentMode, replacePrecommit = false } = {}) {
    if (!key || !state) return undefined
    let planning = this.planningByNpc.get(key)
    let goalAdmitted = false
    if (!planning?.goal
      || planning.goal.goal_id !== state.goal_id
      || planning.goal.status !== GOAL_STATUS.ACTIVE) {
      goalAdmitted = true
      planning = applyPlanningEvent(planning ?? createEmptyPlanningState(), {
        type: PLANNING_EVENT.GOAL_ACCEPTED,
        now,
        goal_id: state.goal_id,
        owner: state.owner,
        objective: state.objective,
      })
    }
    // The initial shelf and the draft may arrive in the same planner submission.
    // Admit the user goal first, then the non-executable shelf, and only then
    // mint the draft so its roadmap_node_ids point at a revision that already
    // exists. Otherwise the first slice can never be linked to the shelf it is
    // supposed to refine.
    this.planningByNpc.set(key, planning)
    if (Array.isArray(roadmap) && roadmap.length > 0) {
      planning = this.reviseRoadmap(key, roadmap, {
        now,
        reason: planning.roadmap?.goal_id !== planning.goal?.goal_id
          ? 'goal_decomposed_to_shelf'
          : 'verified_world_change',
      }) ?? planning
    }
    // Goal admission is a semantic boundary that exists BEFORE the first
    // draft. Evaluate it after the initial non-executable shelf is admitted
    // but before DRAFT_CREATED snapshots steering_at_draft. Production may
    // pre-admit the goal to obtain Jev advice; adapter/direct lanes still need
    // the same ordering with the reducer's default maintain recommendation.
    if (goalAdmitted || !planning.steering) {
      planning = this.evaluateSteeringAtBoundary(key, {
        boundary: STEERING_BOUNDARY.GOAL_ADMISSION,
        now,
      }) ?? planning
    }
    const draftBefore = getActivePlan(planning)
    const replaceableDraft = replacePrecommit
      && draftBefore
      && ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(draftBefore.status)
    // The next slice comes from the planner's next submission. A legacy state
    // that is itself completed is the finished slice; minting a draft from it
    // would copy completed steps into a new active plan.
    const completedSliceBoundary = draftBefore?.status === PLAN_STATUS.COMPLETED
      && planning.goal?.status === GOAL_STATUS.ACTIVE
      && state.status !== 'completed'
    if ((!draftBefore || replaceableDraft || completedSliceBoundary)
      && Array.isArray(state.task_board?.steps)
      && state.task_board.steps.length > 0) {
      const knownNodeIds = new Set((planning.roadmap?.nodes ?? []).map(node => node.id))
      const linkedNodeIds = Array.from(new Set(
        (Array.isArray(roadmapNodeIds) ? roadmapNodeIds : [])
          .filter(id => typeof id === 'string')
          .map(id => id.trim())
          .filter(id => id && knownNodeIds.has(id)),
      )).slice(0, 16)
      planning = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.DRAFT_CREATED,
        now,
        origin: migrated ? 'legacy_task_board_migration' : 'live_task_board',
        roadmap_node_ids: linkedNodeIds,
        ...(developmentMode ? { development_mode: developmentMode } : {}),
        // A replaced draft keeps its lineage (including a carried verified
        // prefix), so its steps exclude what the predecessor already holds.
        steps: draftStepsFromBoard(state.task_board, replaceableDraft ? draftBefore : undefined),
      })
    }
    this.planningByNpc.set(key, planning)
    // Whenever a goal is admitted for a record that already carries run state
    // (pause, wait, recovery, follow runtime, locators), seed the reducer run
    // now, so a later mirrorRunToLegacy cannot null those legacy fields.
    this.seedRunFromLegacy(key, state)
    this.seedReceiptLedgerFromLegacy(key, state)
    this.syncPlanningState(key, state)
    return planning
  }

  /**
   * Commit the active draft after deterministic runtime validation.
   *
   * Jev is deliberately absent from this authority boundary. A caller may
   * still pass the legacy review object during migration; only its embedded
   * runtime_validation field is read for backward compatibility.
   */
  commitPlanningPlan(key, {
    now = Date.now(),
    migrated = false,
    runtime_validation,
    runtimeValidation,
  } = {}) {
    const legacy = key ? this.planByNpc.get(key) : undefined
    let planning = this.ensurePlanningDraft(key, legacy, { now, migrated })
    const plan = getActivePlan(planning)
    if (!plan) return planning
    if ([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(plan.status)) return planning

    const validation = runtime_validation ?? runtimeValidation
    if (!validation || validation.passed !== true) return planning

    planning = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.PLAN_COMMITTED,
      now,
      plan_id: plan.plan_id,
      runtime_validation: validation,
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
    // Completion meaning freezes with the committed reducer plan. Guard BEFORE
    // touching the legacy compatibility board so no post-commit Jev/checkpoint
    // pass can make compatibility code reason from semantics different from the
    // immutable plan the runtime is actually executing.
    const planning = this.planningByNpc.get(key)
    const active = getActivePlan(planning)
    if (active && [PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, PLAN_STATUS.COMPLETED, PLAN_STATUS.BLOCKED].includes(active.status)) return state
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
    // Completion contracts are discovered before commit. A mutable pre-commit
    // reducer draft may be replaced with a fresh draft carrying the newly
    // grounded contract; immutable plans were already rejected above.
    if (active) {
      const refreshed = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.DRAFT_CREATED,
        now,
        origin: 'checkpoint_contract_refresh',
        roadmap_node_ids: [...(active.roadmap_node_ids ?? [])],
        development_mode: active.development_mode,
        // The draft keeps its lineage. On a revised plan the board leads with
        // the predecessor's verified steps, which are not this plan's steps.
        steps: draftStepsFromBoard(state.task_board, active),
      })
      this.planningByNpc.set(key, refreshed)
      this.syncPlanningState(key, state)
    }
    return state
  }

  /**
   * Record that the world destroyed an exact identity, and block the plan if
   * that kills the active step's contract (roadmap 6 / 7).
   *
   * `stale_exact_target` is the one impossibility the runtime can actually
   * PROVE. The game answered a deterministic preflight with "unit N does not
   * resolve", unit_numbers are never reused, so every requirement pinned to N
   * is dead for good. No threshold, no retry count, no model opinion -- which
   * is exactly what separates this from the repeating-failure signal, and why
   * the reducer refuses this event from any source but the runtime.
   *
   * Stale identities accumulate per NPC because an `any`-mode contract only
   * dies once EVERY branch is dead, and those branches are proven one rejected
   * preflight at a time.
   */
  recordStaleExactIdentity(key, unitNumber, { now = Date.now(), proofRef } = {}) {
    if (!key || !Number.isSafeInteger(unitNumber) || unitNumber <= 0) return undefined
    // The stale-identity set lives in reducer state (run.stale_exact_identities)
    // so it survives a restart with the snapshot.
    let planning = this.planningByNpc.get(key)
    const recorded = planning?.goal
      ? this.#applyRunEvent(key, {
          type: PLANNING_EVENT.LOCATORS_RECORDED,
          goal_id: planning.goal.goal_id,
          stale_unit_numbers: [unitNumber],
        })
      : undefined
    const stale = new Set([...(recorded?.run?.stale_exact_identities ?? planning?.run?.stale_exact_identities ?? []), unitNumber])
    planning = this.planningByNpc.get(key)
    const plan = getActivePlan(planning)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return planning
    const step = plan.steps?.[plan.active_step_index]
    if (!step?.completion_contract) return planning
    const proof = provePermanentlyUnsatisfiable(step.completion_contract, { staleUnitNumbers: [...stale] })
    if (!proof) return planning

    planning = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.CONTRACT_PROVEN_UNSATISFIABLE,
      now,
      source: 'runtime',
      plan_id: plan.plan_id,
      step_id: step.step_id,
      reason: proof.reason,
      proof_ref: proofRef ?? `stale_exact_target/${proof.unit_numbers.join('+')}`,
    })
    this.planningByNpc.set(key, planning)
    // The proof only matters if it reaches the deadlock detector: `unsatisfiable`
    // is inert state until a signal reads it and freezes the plan for the user.
    planning = this.evaluatePlanningDeadlock(key, planning, now)
    this.syncPlanningState(key)
    return planning
  }

  /**
   * Run the deterministic deadlock evaluators and freeze the plan on a signal.
   *
   * Kept separate from the copy inside `applyOutcomeAuthority` on purpose: that
   * one fires on the attempt that crossed a counting threshold, this one fires
   * the moment a proof lands, and the two paths reach the detector at different
   * times. Folding them together is a later cleanup, not this change.
   */
  evaluatePlanningDeadlock(key, planning, now) {
    const deadlock = evaluateDeadlockSignals(planning)
    if (!deadlock.deadlocked) return planning
    const next = applyPlanningEvent(planning, {
      type: PLANNING_EVENT.DEADLOCK_DETECTED,
      now,
      source: 'runtime',
      plan_id: deadlock.plan_id,
      reason_code: deadlock.signals[0]?.kind ?? 'deadlock_detected',
      signals: deadlock.signals,
    })
    this.planningByNpc.set(key, next)
    return next
  }

  /**
   * Carry the planner's advisory focus onto the reducer plan (roadmap 8).
   *
   * The legacy board has always tracked `proposed_focus_index` -- where the
   * provider THINKS work is -- next to `active_index`, which is where verified
   * evidence says it actually is. That focus never reached the reducer, so the
   * Plan Tracker had no way to show the divergence it exists to make visible.
   *
   * Recorded, never acted on: the reducer writes it to `advisory` and nothing
   * reads `advisory` when deciding progress. Focus cannot advance the active
   * step and cannot complete one -- only accepted runtime evidence does that.
   * The index is translated through the carried-forward prefix so the id stored
   * is a reducer step_id and not a legacy board position.
   */
  recordPlannerFocus(key, { now = Date.now() } = {}) {
    if (!key) return undefined
    const planning = this.planningByNpc.get(key)
    const plan = getActivePlan(planning)
    const board = this.planByNpc.get(key)?.task_board
    if (!plan || board?.kind !== 'task_board_lite') return planning
    const focusIndex = board.proposed_focus_index
    if (!Number.isSafeInteger(focusIndex)) return planning
    const carriedPrefix = Array.isArray(plan.carried_forward_evidence) ? plan.carried_forward_evidence.length : 0
    const step = plan.steps?.[focusIndex - carriedPrefix]
    // A focus pointing outside the committed slice is not a step to record.
    if (!step) return planning
    if (plan.advisory?.planner_focus_step_id === step.step_id) return planning
    return this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.PLANNER_FOCUS_PROPOSED,
      now,
      source: 'planner',
      plan_id: plan.plan_id,
      step_id: step.step_id,
    })
  }

  retireCompletedPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'completed') return state
    const planning = this.planningByNpc.get(key)
    // A goal with a shelf, or with game-checked done_when conditions that are
    // not yet met, is still live after one of its plans completes.
    const goalStillActive = planning?.goal?.status === GOAL_STATUS.ACTIVE
      && ((Array.isArray(planning?.roadmap?.nodes) && planning.roadmap.nodes.length > 0)
        || Boolean(planning.goal.definition))
    if (goalStillActive) return state
    this.planByNpc.delete(key)
    // The current slot is retired only when there is no active long-horizon
    // reducer goal. Completing one immutable slice must not discard its shelf.
    this.planningByNpc.delete(key)
    return undefined
  }

  clearTaskContext(key) {
    const result = super.clearTaskContext(key)
    if (key) {
      this.planningByNpc.delete(key)
      this.steeringAdviceByNpc?.delete(key)
    }
    return result
  }

  planningReasoningEpoch(key) {
    return reasoningEpochOf(this.planningByNpc.get(key))
  }

  planningContext(key) {
    const planning = this.planningState(key)
    if (!planning?.goal) return ''
    const roadmap = planning.roadmap
      ? {
          roadmap_revision_id: planning.roadmap.roadmap_revision_id,
          goal_id: planning.roadmap.goal_id,
          revision_index: planning.roadmap.revision_index,
          derived_from_revision_id: planning.roadmap.derived_from_revision_id,
          reason: planning.roadmap.reason,
          authority: planning.roadmap.authority,
          evidence_refs: [...(planning.roadmap.evidence_refs ?? [])],
          nodes: (planning.roadmap.nodes ?? []).map(node => ({ ...node })),
        }
      : null
    const visible = {
      goal: { ...planning.goal },
      roadmap,
      steering: steeringContextForDraft(planning),
      plan_tracker: planTrackerView(planning),
    }
    return `[PLANNING_STATE] Reducer-owned planning context. Goal is user-owned; Roadmap Shelf nodes are non-executable intent/lineage; steering is advisory; Plan Tracker is read-only authoritative progress.\n${JSON.stringify(visible)}`
  }

  planContext(key) {
    const state = this.retireCompletedPlan(key)
    const planningContext = this.planningContext(key)
    if (!state) {
      if (planningContext) {
        return `[RUNTIME_COMPAT_STATE] No legacy executable projection exists yet. This block is not planning authority; draft only from [PLANNING_STATE] plus live observations.\n${planningContext}`
      }
      return '[RUNTIME_COMPAT_STATE] No active compatibility task. Completed goals are history; do not infer a new goal from this empty projection.'
    }
    const compatibility = super.planContext(key)
      .replace(
        '[PLAN_STATE] Harness-owned durable goal/plan state.',
        '[RUNTIME_COMPAT_STATE] Legacy compatibility projection for runtime evidence, locators and recovery. Planning steps/progress are authoritative only in [PLANNING_STATE].',
      )
    return [compatibility, planningContext].filter(Boolean).join('\n')
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
    const orphanedGoal = this.#isOrphanGoalForObjective(key, priorPlanning, requestInfo?.text)
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
        ...(Array.isArray(plan?.roadmapNodeIds) ? { roadmap_node_ids: plan.roadmapNodeIds } : {}),
        ...(plan?.developmentMode ? { development_mode: plan.developmentMode } : {}),
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

    const result = super.recordPlan(key, requestInfo, plan, {
      ...options,
      resolveGoalId: () => this.resolveReducerGoalId(key, requestInfo),
    })
    const priorReducerPlan = getActivePlan(priorPlanning)
    const reuseReducerGoal = priorPlanning?.goal?.status === GOAL_STATUS.ACTIVE
      && priorReducerPlan?.status !== PLAN_STATUS.CANCELLED
      && !orphanedGoal
    if (result?.state && reuseReducerGoal) {
      result.state.goal_id = priorPlanning.goal.goal_id
      result.state.owner = priorPlanning.goal.owner
      result.state.objective = priorPlanning.goal.objective
      this.planByNpc.set(key, result.state)
    }
    if (result?.state) {
      this.ensureTaskBoard(result.state)
      this.ensurePlanningDraft(key, result.state, {
        now: result.state.updated_at,
        roadmap: plan?.roadmap,
        roadmapNodeIds: plan?.roadmapNodeIds,
        developmentMode: plan?.developmentMode,
      })
      this.seedRunFromLegacy(key, result.state)
      this.seedReceiptLedgerFromLegacy(key, result.state)
      this.mirrorRunToLegacy(key, result.state)
    }
    const activeAfterDraft = getActivePlan(this.planningByNpc.get(key))
    // Once an immutable bounded slice is COMPLETED, the reducer is allowed to
    // mint the next shelf-linked DRAFT. The legacy Task Board mirrors that new
    // semantic slice instead of preserving the completed board.
    const completedSliceDraftApproved = priorReducerPlan?.status === PLAN_STATUS.COMPLETED
      && activeAfterDraft?.status === PLAN_STATUS.DRAFT
      && activeAfterDraft.plan_id !== priorReducerPlan.plan_id
    if (!userRevisionApproved && !supersededPlanId && !completedSliceDraftApproved) return result
    return {
      ...result,
      ...(userRevisionApproved ? { userRevisionApproved: true } : {}),
      ...(supersededPlanId ? { supersededPlanId } : {}),
      ...(completedSliceDraftApproved ? { completedSliceDraftApproved: true } : {}),
    }
  }

  #supersedeInFlightPlan(key, requestInfo, plan, options) {
    if (options?.continuation === true) return undefined
    if (typeof requestInfo?.sender !== 'string' || !requestInfo.sender.trim()) return undefined
    if (typeof requestInfo?.text !== 'string' || !requestInfo.text.trim()) return undefined
    const planning = key ? this.planningByNpc.get(key) : undefined
    const inFlight = getActivePlan(planning)
    // A COMMITTED or EXECUTING slice is FROZEN and is deliberately excluded.
    //
    // This used to include them, which meant an ordinary submission replaced a
    // healthy committed plan at RECORD time -- before deterministic
    // preflight. When that replacement then failed preflight, the committed
    // slice had already been superseded and an extra plan was left behind: a
    // validated plan traded for a dead draft. The real Factorio lifecycle gate
    // catches exactly this, on a turn where the user only said "continue".
    //
    // Supersession is a handover, and a draft that has not passed deterministic admission is
    // not a successor. The roadmap has one path from a frozen slice to its
    // replacement -- structural blocker, then explicit user-approved revision --
    // and it produces plan_vN+1 with lineage rather than replacing in place.
    if (!inFlight || !PRE_COMMIT_REPLACEABLE_STATUSES.includes(inFlight.status)) return undefined
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
      ...(Array.isArray(plan?.roadmapNodeIds) ? { roadmap_node_ids: plan.roadmapNodeIds } : {}),
      ...(plan?.developmentMode ? { development_mode: plan.developmentMode } : {}),
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

  // The system's structured understanding of the active goal. Returns the
  // stored definition, or undefined when the reducer refused it.
  defineGoal(key, definition, { source = 'main_planner', now = Date.now() } = {}) {
    if (!key) return undefined
    const before = this.planningByNpc.get(key)
    if (!before?.goal) return undefined
    const after = this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.GOAL_DEFINED,
      now,
      source,
      goal_id: before.goal.goal_id,
      definition,
    })
    return after?.goal?.definition
  }

  // Records where goal_start counters stood when the goal began (runtime
  // authority only; existing baselines are kept).
  recordGoalBaselines(key, baselines, { now = Date.now() } = {}) {
    if (!key || !baselines || Object.keys(baselines).length === 0) return undefined
    const before = this.planningByNpc.get(key)
    if (!before?.goal?.definition) return undefined
    const after = this.dispatchPlanningEvent(key, {
      type: PLANNING_EVENT.GOAL_BASELINES_RECORDED,
      now,
      source: 'runtime',
      goal_id: before.goal.goal_id,
      baselines,
    })
    return after?.goal?.definition
  }

  goalDefinition(key) {
    return key ? this.planningByNpc.get(key)?.goal?.definition : undefined
  }

  /**
   * The reducer events that close the plan's active step for this outcome.
   * `main_planner` semantic claims are only ever a semantic claim; every other
   * completed outcome is runtime evidence followed by the runtime closing it.
   */
  #stepCloseEvents({ plan, step, candidate, decision, now }) {
    const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : []
    const ref = evidence.find(item => typeof item?.ref === 'string' && item.ref)?.ref
      ?? `outcome/${plan.plan_id}/${step.step_id}/${now}`
    if (decision.kind === 'semantic_complete') {
      return [{
        type: PLANNING_EVENT.STEP_COMPLETED,
        now,
        source: 'main_planner',
        semantic_claim: true,
        grounding_refs: Array.isArray(candidate?.metadata?.grounding_refs)
          ? candidate.metadata.grounding_refs
          : [ref],
        plan_id: plan.plan_id,
        step_id: step.step_id,
      }]
    }
    return [
      {
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
      },
      {
        type: PLANNING_EVENT.STEP_COMPLETED,
        now,
        source: 'runtime',
        plan_id: plan.plan_id,
        step_id: step.step_id,
      },
    ]
  }

  /**
   * Step close is decided in the REDUCER first (3.3 move 5 / 3.8).
   *
   * Before the legacy board is touched, a step-scope completion is run through
   * the reducer's own STEP_EVIDENCE_ACCEPTED / STEP_COMPLETED rules against the
   * step the reducer holds active. If the reducer will not close it the
   * outcome is refused and the board does not move, so the two can no longer
   * disagree about a close. Only after the reducer agrees does the legacy base
   * record the evidence, and the board is then re-projected from the reducer.
   *
   * The board and the plan must describe the same active step: the reducer
   * checks evidence against ITS step, so closing on evidence gathered for a
   * different one (a board that drifted from the plan) is exactly the bug that
   * lost progress on a revised plan. Such a drift refuses the close
   * (`#refuseDisagreement`); it is never closed on the board alone.
   *
   * Returns `{ refused }` to stop, `{ events }` to proceed, or undefined when
   * this is not a step close the reducer governs.
   */
  #decideStepClose(key, candidate, options) {
    if (!key || candidate?.metadata?.scope !== 'step') return undefined
    const decision = validateOutcomeCandidate(candidate, { world: options?.world ?? {} })
    if (!decision.accepted || decision.durable_status !== 'completed') return undefined
    const state = this.planByNpc.get(key)
    const planning = this.planningByNpc.get(key)
    const plan = getActivePlan(planning)
    if (!state || !plan) return undefined
    const refuse = reason => ({
      refused: {
        state,
        decision: { ...decision, accepted: false, rejection_reason: reason },
        changed: false,
      },
    })
    // A blocked plan is frozen until the user revises it; no outcome unfreezes it.
    if (plan.status === PLAN_STATUS.BLOCKED) return refuse('plan_blocked')
    // Nothing is admitted on a pre-commit draft, so the board may not run ahead
    // of a reducer that will record none of it.
    if (PRE_COMMIT_REPLACEABLE_STATUSES.includes(plan.status)) return refuse('plan_not_committed')
    if (![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return undefined

    const board = state.task_board
    const offset = boardPlanAlignment(board, plan)
    const boardActive = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const reducerIndex = offset === undefined || boardActive === undefined ? undefined : boardActive - offset
    if (reducerIndex !== plan.active_step_index) {
      const code = reducerIndex === undefined
        ? 'board_plan_unaligned'
        : reducerIndex < plan.active_step_index ? 'board_behind_plan' : 'plan_behind_board'
      return this.#refuseDisagreement(key, state, plan, decision, {
        code,
        plan_id: plan.plan_id,
        board_step_id: board?.active_step_id,
        plan_step_id: plan.steps[plan.active_step_index]?.step_id,
      })
    }

    const step = plan.steps[plan.active_step_index]
    const now = state.updated_at ?? Date.now()
    const events = this.#stepCloseEvents({ plan, step, candidate, decision, now })
    let simulated = planning
    for (const event of events) simulated = applyPlanningEvent(simulated, event)
    const closed = getActivePlan(simulated)?.execution?.step_progress?.[step.step_id]?.status === 'completed'
    return closed ? { events } : refuse('reducer_declined_step_close')
  }

  /**
   * The board and the plan disagree about the active step, so this close is
   * refused: the board never closes past the reducer silently. The planner is
   * handed the reason (the refusal), and the goal PAUSES visibly when the
   * disagreement repeats on the same step or sits on the final step, where a
   * drifted board would otherwise declare the goal finished while the plan is
   * still executing.
   *
   * A board that merely trails the reducer is lifted to it first; the retry
   * then finds them aligned and is not counted.
   */
  #refuseDisagreement(key, state, plan, decision, disagreement) {
    const board = state.task_board
    let current = state
    let paused = false
    if (disagreement.code === 'board_behind_plan') {
      current = this.syncPlanningState(key, state) ?? state
    }
    else {
      const stepId = board?.active_step_id
      const previous = this.disagreementStrikes.get(key)
      const count = previous?.step_id === stepId ? previous.count + 1 : 1
      this.disagreementStrikes.set(key, { step_id: stepId, count })
      const finalStep = Array.isArray(board?.steps) && board.active_index === board.steps.length - 1
      if (finalStep || count >= 2) {
        current = this.pausePlan(key, `plan_board_disagreement:${disagreement.code}`) ?? state
        paused = true
      }
    }
    return {
      refused: {
        state: current,
        decision: { ...decision, accepted: false, rejection_reason: 'plan_board_disagreement', ...(paused ? { paused: true } : {}) },
        changed: paused,
        progressDisagreement: disagreement,
      },
    }
  }

  applyOutcomeAuthority(key, candidate, options = {}) {
    const beforeLegacy = key ? this.planByNpc.get(key) : undefined
    if (beforeLegacy) this.ensurePlanningDraft(key, beforeLegacy, { now: beforeLegacy.updated_at })
    const stepClose = this.#decideStepClose(key, candidate, options)
    if (stepClose?.refused) return stepClose.refused
    const result = super.applyOutcomeAuthority(key, candidate, options)
    if (!result?.decision?.accepted || !result?.state) return result
    if (stepClose?.events?.length) this.disagreementStrikes.delete(key)

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
    if (!admitted && result.decision.durable_status !== 'blocked') {
      // A pause never unfreezes a BLOCKED plan: the reducer keeps it BLOCKED,
      // so the legacy record must not drift to plain `paused` and lose it.
      if (result.decision.durable_status === 'paused' && plan.status === PLAN_STATUS.BLOCKED) {
        this.syncPlanningState(key, result.state)
      }
      return result
    }

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
        // A step-scope close was already decided against the reducer before the
        // board moved (`#decideStepClose`); replay exactly those events. Any
        // other completion (a whole-goal verdict) still closes the active step
        // the reducer holds, as before.
        const closeEvents = stepClose
          ? stepClose.events
          : this.#stepCloseEvents({ plan, step, candidate, decision: result.decision, now })
        for (const event of closeEvents) planning = applyPlanningEvent(planning, event)
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
            recommendation: options.steeringRecommendation,
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

  /**
   * Catch the reducer up to steps the legacy board closed. Older runs closed
   * steps on the board that the reducer never recorded (a revised plan's step
   * ids never lined up), so a restart showed the reducer's smaller progress and
   * the NPC would redo finished work.
   *
   * Forward only, and only on real evidence: each step the board completed is
   * replayed into the reducer as its own STEP_EVIDENCE_ACCEPTED /
   * STEP_COMPLETED, using the board's recorded deterministic checkpoint
   * verification (or a fresh-observation semantic claim backed by a runtime
   * receipt for the same step). The reducer applies its normal rules, so a
   * proof its contract does not accept stops the replay. Whatever cannot be
   * proven is left as it is and recorded in `restoreDiagnostics`; the board is
   * not regressed to match.
   */
  #convergeReducerToBoardEvidence(key, state) {
    const board = state?.task_board
    let planning = this.planningByNpc.get(key)
    const first = getActivePlan(planning)
    if (!first || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(first.status)) return
    // Board evidence belongs to the goal it was recorded for.
    if (planning.goal?.goal_id !== state.goal_id) {
      this.restoreDiagnostics.push({
        key,
        code: 'board_goal_mismatch',
        plan_id: first.plan_id,
        board_goal_id: state.goal_id,
        plan_goal_id: planning.goal?.goal_id,
      })
      return
    }
    const offset = boardPlanAlignment(board, first)
    if (offset === undefined) {
      if ((board?.completed_count ?? 0) > 0) this.restoreDiagnostics.push({ key, code: 'board_plan_unaligned', plan_id: first.plan_id })
      return
    }
    for (;;) {
      const plan = getActivePlan(planning)
      const step = plan?.steps?.[plan.active_step_index]
      if (!step || plan.execution.step_progress[step.step_id]?.status === 'completed') break
      const boardStep = board.steps[offset + plan.active_step_index]
      if (boardStep?.status !== 'completed') break
      const proof = legacyStepCloseProof(board, boardStep, step)
      const now = state.updated_at ?? Date.now()
      const events = proof?.kind === 'contract'
        ? [
            {
              type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
              now,
              plan_id: plan.plan_id,
              step_id: step.step_id,
              evidence: {
                source: 'runtime_receipt',
                kind: 'legacy_board_verified_evidence',
                ref: proof.ref,
                satisfied_requirement_ids: proof.satisfied,
              },
            },
            { type: PLANNING_EVENT.STEP_COMPLETED, now, source: 'runtime', plan_id: plan.plan_id, step_id: step.step_id },
          ]
        : proof?.kind === 'semantic'
          ? [{
              type: PLANNING_EVENT.STEP_COMPLETED,
              now,
              source: 'main_planner',
              semantic_claim: true,
              grounding_refs: [proof.ref],
              plan_id: plan.plan_id,
              step_id: step.step_id,
            }]
          : []
      let next = planning
      for (const event of events) next = applyPlanningEvent(next, event)
      const closed = getActivePlan(next)?.execution?.step_progress?.[step.step_id]?.status === 'completed'
      if (!closed) {
        this.restoreDiagnostics.push({
          key,
          code: 'board_completed_step_unverified',
          plan_id: plan.plan_id,
          plan_step_id: step.step_id,
          board_step_id: boardStep.id,
        })
        break
      }
      planning = next
    }
    this.planningByNpc.set(key, planning)
    // Every step proven: the slice is done, through the normal PLAN_COMPLETED
    // rules (all steps completed, runtime authority) and its boundary steering.
    const last = getActivePlan(planning)
    if (last && last.steps.every(step => last.execution.step_progress[step.step_id]?.status === 'completed')) {
      const now = state.updated_at ?? Date.now()
      const completed = applyPlanningEvent(planning, {
        type: PLANNING_EVENT.PLAN_COMPLETED,
        now,
        source: 'runtime',
        plan_id: last.plan_id,
        verified_results: [],
      })
      if (getActivePlan(completed)?.status === PLAN_STATUS.COMPLETED) {
        this.planningByNpc.set(key, completed)
        this.evaluateSteeringAtBoundary(key, { boundary: STEERING_BOUNDARY.PLAN_COMPLETED, now, planId: last.plan_id })
      }
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
    this.restoreDiagnostics = []
    this.disagreementStrikes.clear()
    for (const [key, state] of this.planByNpc.entries()) {
      let planning = this.planningByNpc.get(key)
      // A reducer state that came with the snapshot may lag the board (a run
      // that closed steps only on the board). Bring the reducer up to what the
      // board can prove; never the other way round.
      if (planning) this.#convergeReducerToBoardEvidence(key, state)
      if (!planning) {
        planning = this.ensurePlanningDraft(key, state, { now: state.updated_at, migrated: true })
        // Not a fresh admission: this plan was admitted by a previous run and
        // is being reconstructed from disk through the deterministic admission
        // boundary used by live plans.
        planning = this.commitPlanningPlan(key, {
          now: state.updated_at,
          migrated: true,
          runtime_validation: { passed: true },
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
      if (this.planningByNpc.get(key)?.run) this.mirrorRunToLegacy(key, state, { locators: true })
      else this.seedRunFromLegacy(key, state)
      this.seedReceiptLedgerFromLegacy(key, state)
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
    const completedSliceDraftApproved = stateResult?.completedSliceDraftApproved === true
    // BLOCKED/COMMITTED work is frozen for ordinary continuation. Replacement
    // is allowed only for explicit user revision or a fresh draft after the
    // previous immutable slice completed.
    const semanticReplacementApproved = revisionApproved
      || completedSliceDraftApproved
    const guarded = semanticReplacementApproved
      ? plan
      : canonicalContinuationPlan(previousBoard, plan, {
          ...options,
          previousState: truthState,
          allowReplan: options.allowReplan,
        })
    // A completed slice needs a FRESH board, not a replan of the old one.
    //
    // `allowReplan` routes into `replanTaskBoardRemaining`, which is exactly
    // what its name says: it preserves `steps.slice(0, completed_count)` and
    // appends the incoming remainder. That is right when a slice is still in
    // progress, and wrong at a completed-slice boundary -- a board whose only
    // step had completed kept that step and gained the next slice's, so the
    // new board showed both slices at once.
    //
    // The completed steps belong to the finished immutable plan, which still
    // holds them. The next slice starts clean.
    const boardForReconcile = completedSliceDraftApproved
      ? createTaskBoard(
          Array.isArray(guarded?.plan) ? guarded.plan : [],
          guarded?.currentStep ?? 0,
          { goalId: truthState?.goal_id ?? '', now: truthState?.updated_at ?? Date.now() },
        )
      : previousBoard
    const result = super.reconcileTaskBoard(key, boardForReconcile, guarded, stateResult, {
      ...options,
      allowReplan: semanticReplacementApproved ? true : options.allowReplan,
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
      // After sync, because sync is what settles which focus survives.
      this.recordPlannerFocus(key, { now: result.state.updated_at })
    }
    if (result?.state?.status === 'completed') {
      const planning = this.planningByNpc.get(key)
      const keepForNextSlice = planning?.goal?.status === GOAL_STATUS.ACTIVE
        && Array.isArray(planning?.roadmap?.nodes)
        && planning.roadmap.nodes.length > 0
      if (!keepForNextSlice) this.planByNpc.delete(key)
    }
    return result
  }

  recordBoardEvidence(key, evidence) {
    const boardAfterReceipt = super.recordBoardEvidence(key, evidence)
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !boardAfterReceipt) return boardAfterReceipt

    const staleProof = staleExactTargetProof(evidence)
    if (staleProof) {
      this.recordStaleExactIdentity(key, staleProof.unitNumber, {
        now: state.updated_at ?? Date.now(),
        proofRef: staleProof.ref,
      })
      return this.planByNpc.get(key)?.task_board ?? boardAfterReceipt
    }

    // Before the transfer check: in a placing + dependent transfer batch the
    // transfer was cancelled because the placement was refused, so the
    // failure is the placement's, not the transfer's (live 2026-09-25 16:15).
    const refusal = state.status === 'active' ? correctablePlacementRefusal(evidence) : undefined
    if (refusal) {
      const streak = consecutiveRecoverableFailures(boardAfterReceipt)
      if (evidence.ref && streak.refs.has(evidence.ref)) return boardAfterReceipt
      const previousRefusals = streak.count
      if (previousRefusals >= CORRECTABLE_PLACEMENT_RETRY_BUDGET) {
        const reason = `placement_failed:${refusal.code}`
        return this.applyOutcomeAuthority(key, {
          kind: 'world_blocked',
          source: 'autorio',
          reason_code: reason,
          candidate_blocker: reason,
          evidence: [evidence],
        }).state?.task_board ?? boardAfterReceipt
      }
      return super.recordBoardEvidence(key, {
        kind: OPERATION_FAILURE_RECOVERABLE_KIND,
        ref: evidence.ref,
        summary: JSON.stringify({
          failure_class: `model_correctable_${refusal.task_type}_${refusal.code}`,
          ...refusal,
          attempt: previousRefusals + 1,
          retry_budget: CORRECTABLE_PLACEMENT_RETRY_BUDGET,
        }),
      }) ?? boardAfterReceipt
    }

    if (evidence?.kind === 'operation_error_receipt' && stateHasUnverifiedTransferIntent(state)) {
      const reasonCode = operationFailureReasonCode(evidence)
      return this.applyOutcomeAuthority(key, {
        kind: 'world_blocked',
        source: 'autorio',
        reason_code: reasonCode,
        candidate_blocker: reasonCode,
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
