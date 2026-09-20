// Durable planning state: Goal / Roadmap Shelf / Active Plan.
//
// Canonical direction: docs/NPC_PLANNING_ROADMAP.md (sections 1, 2, 3, 5, 6, 8,
// 9, 10). This module is pure data + one transition authority. It performs no
// I/O, never calls Date.now(), and never talks to a model. Wiring it into the
// runtime is a separate job; nothing here imports the agent loop.
//
// Ownership rules this module enforces structurally (not by convention):
//
//   * A COMMITTED plan's steps, ordering and completion meaning are frozen —
//     frozen against the Main LLM and against Jev, which authored/reviewed it.
//     After commit both are limited to FULFILLING the committed contracts.
//   * Only accepted RUNTIME evidence may advance progress. Planner focus and
//     Jev output are recorded as advisory metadata and cannot advance anything.
//   * A deadlock or structural blocker FREEZES the plan as BLOCKED. There is no
//     code path from BLOCKED to automatic replanning.
//   * A successor plan (plan_version + 1) exists only via USER_REVISION_APPROVED.
//   * The Roadmap Shelf is storage only. No export turns a shelf node into
//     operations or into plan steps.

import { completionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'

export const PLANNING_STATE_VERSION = 1

// --- lifecycle (roadmap section 5) -----------------------------------------

export const PLAN_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  JEV_REVIEW: 'JEV_REVIEW',
  RUNTIME_VALIDATION: 'RUNTIME_VALIDATION',
  READY: 'READY',
  COMMITTED: 'COMMITTED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
})

const PLAN_STATUSES = Object.freeze(Object.values(PLAN_STATUS))

// Statuses whose step content is frozen forever.
const IMMUTABLE_STATUSES = Object.freeze([
  PLAN_STATUS.COMMITTED,
  PLAN_STATUS.EXECUTING,
  PLAN_STATUS.COMPLETED,
  PLAN_STATUS.BLOCKED,
  PLAN_STATUS.SUPERSEDED,
  PLAN_STATUS.CANCELLED,
])

const PRE_COMMIT_STATUSES = Object.freeze([
  PLAN_STATUS.DRAFT,
  PLAN_STATUS.JEV_REVIEW,
  PLAN_STATUS.RUNTIME_VALIDATION,
  PLAN_STATUS.READY,
])

export const SHELF_NODE_STATUS = Object.freeze({
  TENTATIVE: 'tentative',
  READY_TO_REFINE: 'ready_to_refine',
  PARTIALLY_REALIZED: 'partially_realized',
  REALIZED: 'realized',
  INVALIDATED: 'invalidated',
})

const SHELF_NODE_STATUSES = Object.freeze(Object.values(SHELF_NODE_STATUS))

// Monotonic realization ladder. A node may only move forward along it; the
// ladder is driven by accumulated verified evidence, never by an assertion from
// the planner or from Jev. INVALIDATED is off-ladder and is set only by a
// roadmap revision that drops the node.
const SHELF_NODE_STATUS_RANK = Object.freeze({
  [SHELF_NODE_STATUS.TENTATIVE]: 0,
  [SHELF_NODE_STATUS.READY_TO_REFINE]: 1,
  [SHELF_NODE_STATUS.PARTIALLY_REALIZED]: 2,
  [SHELF_NODE_STATUS.REALIZED]: 3,
})

/**
 * A capability frontier is a PROPERTY OF A SHELF NODE — not a separate layer and
 * not derived on demand. It records what capability the node advances and how
 * the world would be recognized as having reached it.
 *
 * Roadmap section "Later factory-performance frontiers" distinguishes four
 * things this module deliberately keeps separate:
 *
 *   plan slice completed
 *   != capability frontier reached
 *   != user goal satisfied
 *   != project ended
 */
export const FRONTIER_STATUS = Object.freeze({
  NOT_REACHED: 'not_reached',
  PARTIALLY_REACHED: 'partially_reached',
  REACHED: 'reached',
})

const FRONTIER_STATUS_RANK = Object.freeze({
  [FRONTIER_STATUS.NOT_REACHED]: 0,
  [FRONTIER_STATUS.PARTIALLY_REACHED]: 1,
  [FRONTIER_STATUS.REACHED]: 2,
})

export const DEVELOPMENT_MODES = Object.freeze(['vertical', 'horizontal', 'maintain', 'recover'])

// The two modes that form the tick-tock cadence. `maintain` and `recover` are
// real modes but they are not directions: they must not erase which direction
// the cadence was last travelling in (roadmap 4.4).
export const DIRECTIONAL_MODES = Object.freeze(['vertical', 'horizontal'])

// --- roadmap shelf tuning (named, not magic) --------------------------------

// Fields a caller might attach to a shelf node that would make it executable.
// They are never read into a node; they are reported on the node as
// `dropped_executable_fields` so an attempt to smuggle execution onto the
// shelf is visible rather than silent (roadmap 3 / 14).
export const SHELF_FORBIDDEN_EXECUTABLE_FIELDS = Object.freeze([
  'steps',
  'plan',
  'plan_steps',
  'operations',
  'operation',
  'actions',
  'commands',
  'completion',
  'completion_contract',
  'step_contracts',
  'entities',
  'blueprint',
])

// Roadmap 14 non-goal: "the shelf becomes a hidden executable mega-plan".
// Refining one node may only produce a handful of coarser successors. Anything
// beyond this per-parent fan-out is dropped from the revision and recorded.
export const SHELF_REFINEMENT_MAX_FANOUT = 4

// Roadmap 4.4: `pressure` is the grounded evidence FOR a steering mode, so it
// has to be checkable against world state. A closed vocabulary per direction,
// not prose: an unrecognised entry is dropped rather than stored, so nothing
// can justify a steering mode with a pressure nobody can verify or assert on.
//
// Each code names a condition an observer could confirm from live state alone.
// Add codes here when the observation exists -- never to accommodate a phrase
// a model happened to emit.
export const STEERING_PRESSURE_VOCABULARY = Object.freeze({
  // Widen, scale or stabilize what already exists.
  horizontal: Object.freeze([
    'throughput_starved',
    'input_buffer_starved',
    'output_backed_up',
    'machine_idle_no_input',
    'machine_idle_no_power',
    'power_deficit',
    'power_margin_low',
    'resource_patch_depleting',
    'logistics_bottleneck',
    'repeated_manual_topup',
    'defense_margin_low',
  ]),
  // Push the critical path toward a capability that does not exist yet.
  vertical: Object.freeze([
    'frontier_reached',
    'capability_absent',
    'technology_blocked_missing_science',
    'recipe_locked_missing_technology',
    'required_item_uncraftable',
    'shelf_node_ready_to_refine',
    'goal_requires_new_capability',
    'surplus_unconsumed',
  ]),
})

const STEERING_PRESSURE_SETS = Object.freeze({
  horizontal: new Set(STEERING_PRESSURE_VOCABULARY.horizontal),
  vertical: new Set(STEERING_PRESSURE_VOCABULARY.vertical),
})

export const GOAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
})

// --- deadlock tuning (named, not magic) ------------------------------------

// (a) evidence stall: this many operation batches attempted against the active
//     step with zero accepted evidence advancing its completion contract.
export const DEADLOCK_EVIDENCE_STALL_BATCHES = 6
// (b) repeating failure: the same failure reason code this many times on one step.
export const DEADLOCK_REPEATED_FAILURE_LIMIT = 3
// backstop for prose-only steps, which have no contract and are therefore
// invisible to signals (a) and (c). Hard ceiling on operation batches.
export const PROSE_ONLY_STEP_OPERATION_CEILING = 12

export const DEADLOCK_SIGNAL_KIND = Object.freeze({
  EVIDENCE_STALL: 'evidence_stall',
  REPEATING_FAILURE: 'repeating_failure',
  UNSATISFIABLE_CONTRACT: 'unsatisfiable_contract',
  PROSE_ONLY_CEILING: 'prose_only_operation_ceiling',
})

// --- strategic steering (roadmap section 4) --------------------------------
//
// The steering record is ADVISORY PLANNING CONTEXT. It is not execution
// authority: nothing in this module reads it to choose a step, an operation or
// a completion, and no transition may touch a plan because of it.

/** The only boundaries at which steering may be (re-)evaluated (roadmap 4.3). */
export const STEERING_BOUNDARY = Object.freeze({
  GOAL_ADMISSION: 'goal_admission',
  PLAN_COMPLETED: 'plan_completed',
  USER_REVISION_APPROVED: 'user_revision_approved',
  USER_PRIORITY_CHANGE: 'user_priority_change',
})

const STEERING_BOUNDARIES = Object.freeze(Object.values(STEERING_BOUNDARY))

/**
 * Hysteresis tuning (roadmap 4.4). Tick-tock is a BIAS, not a state machine:
 * there is deliberately no cap on consecutive same-mode slices. These
 * constants only make it harder to FLIP direction on weak grounds.
 */
export const STEERING_HYSTERESIS = Object.freeze({
  // A directional flip needs at least this much confidence in the proposal.
  MIN_CONFIDENCE_TO_SWITCH: 0.6,
  // The mode being left must have owned at least this many evaluated slices.
  MIN_SLICES_BEFORE_SWITCH: 1,
  // Grounded pressure for the proposed direction must exceed pressure for the
  // current direction by at least this many distinct items.
  MIN_PRESSURE_MARGIN: 1,
  // Explicitly unbounded: consecutive vertical (or horizontal) slices are
  // legal whenever they are justified. Stored as null, never as a number.
  MAX_CONSECUTIVE_SAME_MODE: null,
})

export const STEERING_HOLD_REASON = Object.freeze({
  LOW_CONFIDENCE: 'confidence_below_switch_threshold',
  INSUFFICIENT_PRESSURE: 'insufficient_grounded_pressure_margin',
  MODE_TOO_NEW: 'current_mode_owned_too_few_slices',
  USER_PRIORITY_LOCKED: 'user_priority_locked',
})

// --- events ----------------------------------------------------------------

export const PLANNING_EVENT = Object.freeze({
  GOAL_ACCEPTED: 'GOAL_ACCEPTED',
  ROADMAP_REVISED: 'ROADMAP_REVISED',
  // Advisory steering evaluated at a safe planning boundary (roadmap 4.3).
  STEERING_EVALUATED: 'STEERING_EVALUATED',
  DRAFT_CREATED: 'DRAFT_CREATED',
  JEV_REVIEW_REQUESTED: 'JEV_REVIEW_REQUESTED',
  JEV_REFINEMENT_REQUESTED: 'JEV_REFINEMENT_REQUESTED',
  PLAN_COMMITTED: 'PLAN_COMMITTED',
  PLANNER_FOCUS_PROPOSED: 'PLANNER_FOCUS_PROPOSED',
  OPERATION_BATCH_ATTEMPTED: 'OPERATION_BATCH_ATTEMPTED',
  CONTRACT_PROVEN_UNSATISFIABLE: 'CONTRACT_PROVEN_UNSATISFIABLE',
  STEP_EVIDENCE_ACCEPTED: 'STEP_EVIDENCE_ACCEPTED',
  STEP_COMPLETED: 'STEP_COMPLETED',
  PLAN_COMPLETED: 'PLAN_COMPLETED',
  DEADLOCK_DETECTED: 'DEADLOCK_DETECTED',
  STRUCTURAL_BLOCKER_CONFIRMED: 'STRUCTURAL_BLOCKER_CONFIRMED',
  BLOCKED_CHOICE_RECORDED: 'BLOCKED_CHOICE_RECORDED',
  USER_REVISION_APPROVED: 'USER_REVISION_APPROVED',
  PLAN_SUPERSEDED: 'PLAN_SUPERSEDED',
  PLAN_CANCELLED: 'PLAN_CANCELLED',
  // Goal satisfaction is its OWN explicit event with its OWN evidence. No
  // amount of completed plans or reached frontiers produces it implicitly.
  GOAL_SATISFIED: 'GOAL_SATISFIED',
})

const PLANNING_EVENT_TYPES = Object.freeze(Object.values(PLANNING_EVENT))

// Sources permitted to advance authoritative progress. The planner (Main LLM)
// and Jev are deliberately absent.
const EVIDENCE_AUTHORITIES = Object.freeze(['runtime', 'autorio', 'runtime_receipt'])
const USER_AUTHORITIES = Object.freeze(['user', 'human', 'user_steering'])

// --- reasoning epoch (owner decision, 2026-09-19) ---------------------------
//
// When a plan is shelved or superseded, accumulated REASONING context does not
// carry forward. The next planning round restarts from durable state only —
// goal, shelf and verified evidence — not from accumulated reasoning or
// conversation history. Lineage is preserved; reasoning continuity is not.
//
// This module owns no I/O and therefore clears nothing itself. It publishes a
// monotonic signal that the agent loop consumes:
//
//   state.reasoning_epoch        monotonically increasing integer, never reset
//   state.last_reasoning_reset   { epoch, at, event_type, reason } | null
//
// A consumer caches the epoch it last reasoned under; when
// `state.reasoning_epoch` differs, it must discard accumulated reasoning /
// conversation context and rebuild the next round's context from durable state.
export const REASONING_RESET_EVENTS = Object.freeze([
  // a new goal: nothing from the previous one may be clung to
  PLANNING_EVENT.GOAL_ACCEPTED,
  // the shelf itself moved under the planner
  PLANNING_EVENT.ROADMAP_REVISED,
  // a deferred tail was shelved: the plan the model argued for no longer exists
  PLANNING_EVENT.JEV_REFINEMENT_REQUESTED,
  // the plan was set aside, replaced or abandoned
  PLANNING_EVENT.PLAN_SUPERSEDED,
  PLANNING_EVENT.USER_REVISION_APPROVED,
  PLANNING_EVENT.PLAN_CANCELLED,
])

function currentReasoningEpoch(state) {
  return Number.isSafeInteger(state?.reasoning_epoch) && state.reasoning_epoch >= 0 ? state.reasoning_epoch : 0
}

/**
 * Bump the reasoning epoch on a state that is already otherwise final.
 * Applied ONLY on the transitions listed in REASONING_RESET_EVENTS, and only
 * when the transition actually took effect.
 */
function withReasoningReset(state, { now, eventType, reason }) {
  const epoch = currentReasoningEpoch(state) + 1
  return {
    ...state,
    reasoning_epoch: epoch,
    last_reasoning_reset: {
      epoch,
      at: now,
      event_type: text(eventType, 80),
      reason: text(reason, 200) || null,
    },
  }
}

/** Current reasoning epoch of a state. Safe on undefined / restored junk. */
export function reasoningEpochOf(state) {
  return currentReasoningEpoch(state)
}

/**
 * True when applying an event moved the state across a reasoning-reset boundary.
 * The agent loop uses this to decide whether to drop accumulated reasoning.
 */
export function reasoningWasReset(before, after) {
  return currentReasoningEpoch(after) > currentReasoningEpoch(before)
}

// --- small pure helpers ----------------------------------------------------

function text(value, max = 500) {
  const cleaned = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max)
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined
}

function fingerprint(value) {
  // FNV-1a, deterministic and dependency-free. Used so step ids are not merely
  // positional (roadmap section 10).
  let hash = 0x811C9DC5
  const source = String(value ?? '')
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

function stringList(value, { max = 32, maxLength = 160 } = {}) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item, maxLength)).filter(Boolean).slice(0, max)
}

function boundedList(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : []
}

// --- sanitizers ------------------------------------------------------------

function sanitizeGoal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const goalId = text(raw.goal_id, 120)
  if (!goalId) return undefined
  const satisfaction = raw.satisfaction && typeof raw.satisfaction === 'object' && !Array.isArray(raw.satisfaction)
    ? {
        source: text(raw.satisfaction.source, 60),
        evidence_refs: stringList(raw.satisfaction.evidence_refs, { max: 32, maxLength: 200 }),
        rationale: text(raw.satisfaction.rationale, 400) || null,
        at: finiteNumber(raw.satisfaction.at) ?? 0,
      }
    : null
  return {
    goal_id: goalId,
    ...(satisfaction ? { satisfaction, satisfied_at: finiteNumber(raw.satisfied_at) ?? satisfaction.at } : {}),
    owner: text(raw.owner, 128) || 'unknown',
    objective: text(raw.objective, 1000),
    constraints: stringList(raw.constraints, { max: 24, maxLength: 300 }),
    status: Object.values(GOAL_STATUS).includes(raw.status) ? raw.status : GOAL_STATUS.ACTIVE,
    created_at: finiteNumber(raw.created_at) ?? 0,
    updated_at: finiteNumber(raw.updated_at) ?? finiteNumber(raw.created_at) ?? 0,
  }
}

/**
 * Sanitize the OPTIONAL capability frontier a shelf node advances.
 *
 * Like the node that owns it, a frontier is storage: intent plus recognition
 * criteria in prose. It carries no operations and no step contracts — its
 * recognition signals describe how the world would be recognized as having
 * reached the frontier; they are never executed and never compiled into steps.
 *
 * `continuous: true` marks an OPEN-ENDED frontier (sustained SPM, logistics or
 * power headroom, throughput scaling, resilience). "Launch a rocket" is not
 * assumed terminal. A continuous frontier can sit at `partially_reached`
 * indefinitely: it never latches to `reached`, so it can never become the
 * silent reason a goal completes.
 */
export function sanitizeCapabilityFrontier(raw, { nodeId = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const intent = text(raw.intent ?? raw.description, 400)
  if (!intent) return undefined
  const seen = new Set()
  const recognition = boundedList(raw.recognition ?? raw.reached_when, 16)
    .map((item, index) => {
      const source = typeof item === 'string' ? { description: item } : item
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
      const description = text(source.description ?? source.intent, 300)
      if (!description) return undefined
      const id = text(source.id, 120) || `recog_${fingerprint(`${nodeId}|${index}|${description}`)}`
      if (seen.has(id)) return undefined
      seen.add(id)
      return { id, description }
    })
    .filter(Boolean)
  const declaredIds = new Set(recognition.map(item => item.id))
  const satisfied = stringList(raw.satisfied_recognition_ids, { max: 16, maxLength: 120 })
    .filter(id => declaredIds.has(id))
  const status = Object.values(FRONTIER_STATUS).includes(raw.status) ? raw.status : FRONTIER_STATUS.NOT_REACHED
  const continuous = raw.continuous === true
  return {
    id: text(raw.id, 120) || `frontier_${nodeId || fingerprint(intent)}`,
    intent,
    continuous,
    recognition,
    // A continuous frontier never latches; clamp any stored REACHED back down.
    status: continuous && status === FRONTIER_STATUS.REACHED ? FRONTIER_STATUS.PARTIALLY_REACHED : status,
    satisfied_recognition_ids: Array.from(new Set(satisfied)),
    verified_results: stringList(raw.verified_results, { max: 32, maxLength: 300 }),
    resolved_by: stringList(raw.resolved_by, { max: 32, maxLength: 160 }),
    reached_at: continuous ? null : (finiteNumber(raw.reached_at) ?? null),
  }
}

/**
 * Sanitize one Roadmap Shelf node. Shelf nodes are storage only: they carry
 * intent and lineage, never operations, never step contracts.
 *
 * `trusted` distinguishes two callers:
 *   - restore (`trusted: true`) rehydrates a status this module itself derived;
 *   - a roadmap revision (`trusted: false`, the default) is INCOMING guidance,
 *     so its asserted status is discarded. Realization status is derived from
 *     verified evidence and lineage, never from what the author claims
 *     (roadmap 3). `invalidated` is the one status an author may assert,
 *     because dropping a node is a legitimate revision act and is a downgrade.
 */
export function sanitizeShelfNode(raw, { sequence = 0, trusted = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const intent = text(raw.intent, 400)
  if (!intent) return undefined
  const id = text(raw.id, 120) || `node_${sequence}_${fingerprint(intent)}`
  const developmentHint = DEVELOPMENT_MODES.includes(raw.development_hint) ? raw.development_hint : undefined
  const droppedExecutable = SHELF_FORBIDDEN_EXECUTABLE_FIELDS
    .filter(field => raw[field] !== undefined && raw[field] !== null)
  const assertedStatus = SHELF_NODE_STATUSES.includes(raw.status) ? raw.status : SHELF_NODE_STATUS.TENTATIVE
  const status = trusted || assertedStatus === SHELF_NODE_STATUS.INVALIDATED
    ? assertedStatus
    : SHELF_NODE_STATUS.TENTATIVE
  return {
    id,
    ready_since: finiteNumber(raw.ready_since) ?? null,
    // Set by the fan-out cap, not by the author: this node is remembered but
    // not yet refinable. Carried through revisions and restore so the cap
    // cannot be escaped by simply restating the node.
    ...(raw.deferred_by_fanout === true ? { deferred_by_fanout: true } : {}),
    ...(finiteNumber(raw.demoted_at) !== undefined ? { demoted_at: finiteNumber(raw.demoted_at) } : {}),
    ...(droppedExecutable.length > 0 ? { dropped_executable_fields: droppedExecutable } : {}),
    intent,
    why_it_matters: text(raw.why_it_matters, 400),
    status,
    depends_on: stringList(raw.depends_on, { max: 16, maxLength: 120 }),
    resolved_by: stringList(raw.resolved_by, { max: 32, maxLength: 160 }),
    assumptions: stringList(raw.assumptions, { max: 16, maxLength: 300 }),
    // Non-binding coarse steering hint (roadmap 4.8). Not an operation.
    development_hint: developmentHint,
    // lineage
    first_seen_revision_id: text(raw.first_seen_revision_id, 120) || undefined,
    derived_from_node_id: text(raw.derived_from_node_id, 120) || undefined,
    revision_reason: text(raw.revision_reason, 300) || undefined,
    verified_results: stringList(raw.verified_results, { max: 32, maxLength: 300 }),
    // The capability frontier this node advances, if it declares one.
    // A frontier normally inherits the shelf node's capability intent. Requiring
    // a duplicate `intent` field silently discarded otherwise valid frontiers
    // during persistence/restore and made their recognition evidence inert.
    capability_frontier: sanitizeCapabilityFrontier(
      raw.capability_frontier && typeof raw.capability_frontier === 'object'
        ? { ...raw.capability_frontier, intent: raw.capability_frontier.intent ?? raw.intent }
        : raw.capability_frontier,
      { nodeId: id },
    ) ?? null,
  }
}

/**
 * Sanitize a step's OPTIONAL completion contract.
 *
 * Product decision (deviates from roadmap section 6 strictness, deliberately):
 * contracts are BEST-EFFORT. A step may commit with a grounded predicate
 * contract, or prose-only. Prose-only steps are explicitly marked
 * reduced-confidence so the UI and the deadlock detector treat them differently.
 */
export function sanitizeOptionalCompletionContract(raw) {
  if (raw === undefined || raw === null) return undefined
  const contract = sanitizeStepCompletionContract(raw)
  return completionContractSupported(contract) ? contract : undefined
}

function sanitizeStep(raw, { planId, planVersion, sequence }) {
  if (raw === undefined || raw === null) return undefined
  const source = typeof raw === 'string' ? { description: raw } : raw
  if (typeof source !== 'object' || Array.isArray(source)) return undefined
  const description = text(source.description, 500)
  if (!description) return undefined
  const contract = sanitizeOptionalCompletionContract(source.completion_contract)
  const stepId = text(source.step_id, 200)
    || `${planId}_v${planVersion}_s${sequence}_${fingerprint(`${planId}|${sequence}|${description}`)}`
  return {
    step_id: stepId,
    description,
    completion_contract: contract ?? null,
    // Explicit reduced-confidence marker for prose-only steps.
    completion_confidence: contract ? 'grounded' : 'reduced',
    reduced_confidence: !contract,
  }
}

function sanitizeSteps(rawSteps, { planId, planVersion }) {
  const list = boundedList(rawSteps, 64)
  const steps = []
  const seen = new Set()
  list.forEach((raw, index) => {
    const step = sanitizeStep(raw, { planId, planVersion, sequence: index + 1 })
    if (!step || seen.has(step.step_id)) return
    seen.add(step.step_id)
    steps.push(step)
  })
  return steps
}

function emptyStepProgress() {
  return {
    status: 'pending',
    accepted_evidence: [],
    batches_attempted: 0,
    batches_since_evidence: 0,
    operations_attempted: 0,
    failure_counts: {},
    contract_satisfied: false,
    unsatisfiable: null,
    completed_at: null,
  }
}

// --- state construction ----------------------------------------------------

export function createEmptyPlanningState() {
  return {
    version: PLANNING_STATE_VERSION,
    sequence: 0,
    goal: null,
    roadmap: null,
    roadmap_history: [],
    plans: [],
    active_plan_id: null,
    // Durable ADVISORY steering record (roadmap 4.4). Planning context only.
    steering: null,
    updated_at: 0,
    // Reasoning continuity marker. See REASONING_RESET_EVENTS above.
    reasoning_epoch: 0,
    last_reasoning_reset: null,
    log: [],
  }
}

function nextSequence(state) {
  return (Number.isSafeInteger(state.sequence) ? state.sequence : 0) + 1
}

function logEntry(state, entry) {
  return [...boundedList(state.log, 255), entry].slice(-256)
}

function withPlan(state, planId, updater) {
  const plans = state.plans.map(plan => (plan.plan_id === planId ? updater(plan) : plan))
  return { ...state, plans }
}

function findPlan(state, planId) {
  return state.plans.find(plan => plan.plan_id === planId)
}

export function getPlan(state, planId) {
  const plan = findPlan(state ?? createEmptyPlanningState(), text(planId, 200))
  return plan ?? undefined
}

export function getActivePlan(state) {
  if (!state?.active_plan_id) return undefined
  return findPlan(state, state.active_plan_id)
}

export function getActiveStep(state) {
  const plan = getActivePlan(state)
  if (!plan) return undefined
  return plan.steps[plan.active_step_index] ?? undefined
}

export function isPlanImmutable(plan) {
  return !!plan && IMMUTABLE_STATUSES.includes(plan.status)
}

// --- roadmap shelf ---------------------------------------------------------

function mergeFrontierLineage(prior, next) {
  if (!next) return prior ? { ...prior } : null
  if (!prior) return next
  const declared = new Set(next.recognition.map(item => item.id))
  const satisfied = Array.from(new Set([
    ...prior.satisfied_recognition_ids.filter(id => declared.has(id)),
    ...next.satisfied_recognition_ids,
  ]))
  const allSatisfied = declared.size > 0 && next.recognition.every(item => satisfied.includes(item.id))
  let status = maxFrontierStatus(next.status, prior.status)
  // A restated frontier that added new recognition signals is no longer proven
  // reached by the old evidence alone.
  if (status === FRONTIER_STATUS.REACHED && !allSatisfied) status = FRONTIER_STATUS.PARTIALLY_REACHED
  if (next.continuous && status === FRONTIER_STATUS.REACHED) status = FRONTIER_STATUS.PARTIALLY_REACHED
  return {
    ...next,
    status,
    satisfied_recognition_ids: satisfied,
    verified_results: Array.from(new Set([...prior.verified_results, ...next.verified_results])).slice(0, 64),
    resolved_by: Array.from(new Set([...prior.resolved_by, ...next.resolved_by])).slice(0, 32),
    reached_at: status === FRONTIER_STATUS.REACHED ? (prior.reached_at ?? next.reached_at ?? null) : null,
  }
}

function createRoadmapRevision(state, { now, nodes, reason, sequence, authority, evidenceRefs }) {
  const previous = state.roadmap
  const revisionId = `${state.goal.goal_id}_r${sequence}`
  const previousById = new Map((previous?.nodes ?? []).map(node => [node.id, node]))
  const incoming = []
  const seen = new Set()
  // Roadmap 14 non-goal guard: one parent node may only fan out into a handful
  // of coarse successors, so a refinement cannot quietly deposit a step-by-step
  // mega-plan on the shelf.
  //
  // The cap limits what becomes REFINABLE now, not what is remembered. Overflow
  // successors are kept as tentative nodes marked `deferred_by_fanout` and are
  // held back from promotion; dropping them outright lost real guidance with no
  // surface the user or the model could see.
  const fanout = new Map()
  const deferredForCoarseness = []

  boundedList(nodes, 64).forEach((raw, index) => {
    const node = sanitizeShelfNode(raw, { sequence: `${sequence}_${index + 1}` })
    if (!node || seen.has(node.id)) return
    const prior = previousById.get(node.id)
    let deferred = node.deferred_by_fanout === true
    if (!prior && node.derived_from_node_id) {
      const used = fanout.get(node.derived_from_node_id) ?? 0
      if (used >= SHELF_REFINEMENT_MAX_FANOUT) deferred = true
      else fanout.set(node.derived_from_node_id, used + 1)
    }
    if (deferred) deferredForCoarseness.push(node.id)
    seen.add(node.id)
    incoming.push({
      ...node,
      ...(deferred ? { deferred_by_fanout: true } : {}),
      // Frontier evidence is durable state and survives roadmap revisions: a
      // revision may restate the frontier, but cannot erase what was verified.
      capability_frontier: mergeFrontierLineage(prior?.capability_frontier, node.capability_frontier),
      status: prior ? maxShelfNodeStatus(node.status, prior.status) : node.status,
      // How long a node has been refinable is lineage too: restating it must
      // not send it to the back of the refinement queue.
      ready_since: prior?.ready_since ?? node.ready_since,
      // lineage preservation: results and plan links survive revisions.
      resolved_by: Array.from(new Set([...(prior?.resolved_by ?? []), ...node.resolved_by])),
      verified_results: Array.from(new Set([...(prior?.verified_results ?? []), ...node.verified_results])),
      first_seen_revision_id: prior?.first_seen_revision_id ?? node.first_seen_revision_id ?? revisionId,
      // Parentage is lineage and comes from the PRIOR node, not from the
      // incoming restatement. This read `prior.id`, which is trivially the
      // node's own id, so restating any node made it its own ancestor and
      // erased the parent that put it on the shelf.
      derived_from_node_id: prior
        ? (prior.derived_from_node_id ?? node.derived_from_node_id)
        : node.derived_from_node_id,
      revision_reason: prior && prior.intent !== node.intent
        ? text(reason || 'node_revised', 300)
        : node.revision_reason,
    })
  })

  // Nodes dropped by the revision are preserved as invalidated with a reason
  // rather than silently disappearing (roadmap section 3).
  for (const prior of previousById.values()) {
    if (seen.has(prior.id)) continue
    incoming.push({
      ...prior,
      status: SHELF_NODE_STATUS.INVALIDATED,
      revision_reason: text(reason || 'dropped_in_roadmap_revision', 300),
    })
  }

  return promoteReadyNodes({
    roadmap_revision_id: revisionId,
    goal_id: state.goal.goal_id,
    revision_index: (previous?.revision_index ?? 0) + 1,
    derived_from_revision_id: previous?.roadmap_revision_id ?? null,
    reason: text(reason, 300),
    // Who was allowed to move long-horizon guidance, and on what evidence.
    authority: text(authority, 60) || null,
    evidence_refs: stringList(evidenceRefs, { max: 16, maxLength: 200 }),
    created_at: now,
    nodes: incoming,
    ...(deferredForCoarseness.length > 0
      ? { deferred_for_coarseness: { node_ids: deferredForCoarseness, max_fanout: SHELF_REFINEMENT_MAX_FANOUT } }
      : {}),
  }, now)
}

function maxShelfNodeStatus(current, candidate) {
  // Monotonic: the ladder only moves forward. INVALIDATED is off-ladder and is
  // never overwritten by accumulated evidence.
  if (current === SHELF_NODE_STATUS.INVALIDATED) return current
  const currentRank = SHELF_NODE_STATUS_RANK[current] ?? 0
  const candidateRank = SHELF_NODE_STATUS_RANK[candidate] ?? 0
  return candidateRank > currentRank ? candidate : current
}

function maxFrontierStatus(current, candidate) {
  const currentRank = FRONTIER_STATUS_RANK[current] ?? 0
  const candidateRank = FRONTIER_STATUS_RANK[candidate] ?? 0
  return candidateRank > currentRank ? candidate : current
}

/**
 * Advance one node's capability frontier from accumulated VERIFIED evidence.
 *
 * Structural guarantees:
 * - Completing a plan does NOT by itself reach a frontier. Only recognition
 *   signals the frontier itself declared, reported satisfied by a runtime
 *   authority, can do that. Unknown / fabricated ids are discarded.
 * - A frontier with no declared recognition signals can never be `reached`,
 *   because nothing was ever said about how to recognize it.
 * - A continuous frontier never latches to `reached`.
 */
function advanceFrontier(frontier, { now, planId, results, satisfiedRecognitionIds }) {
  const declared = new Set(frontier.recognition.map(item => item.id))
  const incoming = stringList(satisfiedRecognitionIds, { max: 16, maxLength: 120 }).filter(id => declared.has(id))
  const satisfied = Array.from(new Set([...frontier.satisfied_recognition_ids, ...incoming]))
  const allSatisfied = declared.size > 0 && frontier.recognition.every(item => satisfied.includes(item.id))

  let candidate = FRONTIER_STATUS.NOT_REACHED
  if (allSatisfied && !frontier.continuous) candidate = FRONTIER_STATUS.REACHED
  else if (satisfied.length > 0) candidate = FRONTIER_STATUS.PARTIALLY_REACHED

  let status = maxFrontierStatus(frontier.status, candidate)
  if (frontier.continuous && status === FRONTIER_STATUS.REACHED) status = FRONTIER_STATUS.PARTIALLY_REACHED

  return {
    ...frontier,
    status,
    satisfied_recognition_ids: satisfied,
    verified_results: Array.from(new Set([...frontier.verified_results, ...results])).slice(0, 64),
    resolved_by: planId ? Array.from(new Set([...frontier.resolved_by, planId])).slice(0, 32) : frontier.resolved_by,
    reached_at: status === FRONTIER_STATUS.REACHED ? (frontier.reached_at ?? now) : null,
  }
}

function shelfStatusForFrontier(frontier) {
  if (frontier.status === FRONTIER_STATUS.REACHED) return SHELF_NODE_STATUS.REALIZED
  if (frontier.status === FRONTIER_STATUS.PARTIALLY_REACHED) return SHELF_NODE_STATUS.PARTIALLY_REALIZED
  // Verified results landed, but nothing the frontier recognizes has been shown.
  return SHELF_NODE_STATUS.READY_TO_REFINE
}

// --- grounded shelf refinement readiness (roadmap 2 / 3 / 13 phase 5) -------

/**
 * Did this node actually acquire verified world evidence?
 *
 * `resolved_by` is only written by PLAN_COMPLETED, which itself requires
 * runtime authority and every committed step completed by accepted runtime
 * evidence. So all three of these are runtime-grounded; none can be written by
 * the planner or by Jev.
 */
function nodeHasVerifiedEvidence(node) {
  return node.resolved_by.length > 0
    || node.verified_results.length > 0
    || (node.capability_frontier?.satisfied_recognition_ids?.length ?? 0) > 0
}

/**
 * A dependency counts as satisfied only when the world says so.
 *
 * REALIZED is the normal case. A CONTINUOUS frontier is the documented
 * exception: it never latches to `reached`, so requiring REALIZED would leave
 * everything downstream of an open-ended frontier permanently unrefinable.
 * PARTIALLY_REALIZED on a continuous frontier therefore satisfies, but only
 * once that frontier has verified evidence behind it.
 */
function dependencySatisfied(dependency) {
  if (!dependency) return false
  if (dependency.status === SHELF_NODE_STATUS.INVALIDATED) return false
  if (!nodeHasVerifiedEvidence(dependency)) return false
  if (dependency.status === SHELF_NODE_STATUS.REALIZED) return true
  return dependency.status === SHELF_NODE_STATUS.PARTIALLY_REALIZED
    && dependency.capability_frontier?.continuous === true
}

/**
 * Readiness of one node, computed from the shelf itself. Never from an
 * assertion: `sanitizeShelfNode` has already discarded any status an author
 * claimed on an incoming revision.
 *
 * A node with no declared dependencies is ready because nothing on the shelf
 * says anything blocks it — readiness is grounded in the (empty) dependency
 * set, not in a claim. Coarse guidance that IS blocked has to say so.
 */
export function shelfNodeReadiness(roadmap, nodeId) {
  const nodes = roadmap?.nodes ?? []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const node = byId.get(text(nodeId, 120))
  if (!node) return { node_id: text(nodeId, 120), exists: false, ready: false, reason: 'unknown_node', blocked_by: [] }
  const blockedBy = []
  for (const dependencyId of node.depends_on) {
    const dependency = byId.get(dependencyId)
    if (!dependency) blockedBy.push({ node_id: dependencyId, reason: 'dependency_not_on_shelf' })
    else if (!dependencySatisfied(dependency)) {
      blockedBy.push({
        node_id: dependencyId,
        reason: nodeHasVerifiedEvidence(dependency) ? 'dependency_not_realized' : 'dependency_has_no_verified_evidence',
        status: dependency.status,
      })
    }
  }
  const terminal = node.status === SHELF_NODE_STATUS.INVALIDATED || node.status === SHELF_NODE_STATUS.REALIZED
  const ready = !terminal && blockedBy.length === 0
  return {
    node_id: node.id,
    exists: true,
    ready,
    status: node.status,
    reason: terminal ? `node_${node.status}` : (ready ? 'dependencies_satisfied' : 'dependencies_unsatisfied'),
    has_verified_evidence: nodeHasVerifiedEvidence(node),
    blocked_by: blockedBy,
  }
}

/**
 * Promote TENTATIVE nodes whose dependencies the world has satisfied to
 * READY_TO_REFINE. Monotonic, like the rest of the ladder: nothing is ever
 * demoted here, and nothing is promoted past READY_TO_REFINE — the higher rungs
 * belong to verified plan results only.
 */
/**
 * Release fan-out deferrals whose parent has room again.
 *
 * The cap is a limit on how much of one parent is refinable AT ONCE, not a
 * permanent cut: a node parked with nothing able to un-park it is just a
 * slower drop. A sibling that has been realized or invalidated no longer
 * occupies budget, so the longest-parked deferred child takes its place.
 *
 * Deterministic: siblings are released in shelf order, never by recency or by
 * any claim on the node itself.
 */
function releaseDeferredFanout(roadmap) {
  if (!roadmap) return roadmap
  const occupied = new Map()
  for (const node of roadmap.nodes) {
    const parent = node.derived_from_node_id
    if (!parent || node.deferred_by_fanout === true) continue
    if (node.status === SHELF_NODE_STATUS.REALIZED || node.status === SHELF_NODE_STATUS.INVALIDATED) continue
    occupied.set(parent, (occupied.get(parent) ?? 0) + 1)
  }

  let changed = false
  const nodes = roadmap.nodes.map((node) => {
    if (node.deferred_by_fanout !== true) return node
    const parent = node.derived_from_node_id
    if (!parent) return node
    const used = occupied.get(parent) ?? 0
    if (used >= SHELF_REFINEMENT_MAX_FANOUT) return node
    occupied.set(parent, used + 1)
    changed = true
    const { deferred_by_fanout: _released, ...released } = node
    return released
  })
  return changed ? { ...roadmap, nodes } : roadmap
}

/**
 * Reconcile the bottom of the ladder with what the shelf actually says.
 *
 * TENTATIVE <-> READY_TO_REFINE moves BOTH ways, deliberately breaking the
 * ladder's monotonicity at this one rung. A node is promoted when its
 * dependencies are satisfied and demoted when they stop being satisfied -- a
 * dependency invalidated, dropped from the shelf, or newly declared by a
 * revision. Otherwise a node promoted once stayed refinable forever on a
 * premise the world had since contradicted, and only contract validation at
 * commit time would ever notice.
 *
 * Both directions read the same `shelfNodeReadiness`, so demotion needs no new
 * authority and no claim: it is exactly the absence of the condition that
 * promoted the node.
 *
 * The upper rungs stay monotonic. PARTIALLY_REALIZED and REALIZED are backed by
 * verified plan results, and evidence does not stop having happened; a node
 * whose guidance is genuinely void is INVALIDATED instead.
 */
function promoteReadyNodes(rawRoadmap, now) {
  const roadmap = releaseDeferredFanout(rawRoadmap)
  if (!roadmap) return roadmap
  let changed = false
  const demote = node => ({
    ...node,
    status: SHELF_NODE_STATUS.TENTATIVE,
    // Cleared: an unready node has no standing in the longest-ready-first
    // refinement queue to preserve.
    ready_since: null,
    demoted_at: now,
  })
  const nodes = roadmap.nodes.map((node) => {
    // Held back by the fan-out cap: remembered, but not refinable yet.
    if (node.deferred_by_fanout === true) {
      if (node.status !== SHELF_NODE_STATUS.READY_TO_REFINE) return node
      changed = true
      return demote(node)
    }
    if (node.status !== SHELF_NODE_STATUS.TENTATIVE && node.status !== SHELF_NODE_STATUS.READY_TO_REFINE) return node

    const ready = shelfNodeReadiness(roadmap, node.id).ready
    if (ready && node.status === SHELF_NODE_STATUS.TENTATIVE) {
      changed = true
      return { ...node, status: SHELF_NODE_STATUS.READY_TO_REFINE, ready_since: node.ready_since ?? now }
    }
    if (!ready && node.status === SHELF_NODE_STATUS.READY_TO_REFINE) {
      changed = true
      return demote(node)
    }
    return node
  })
  return changed ? { ...roadmap, nodes } : roadmap
}

/**
 * The nearest useful nodes to refine next, ordered.
 *
 * "Nearest useful" means: work already underway first (PARTIALLY_REALIZED),
 * then nodes the world has unblocked, longest-ready first so guidance does not
 * starve. This is a READ. It returns intent and lineage — never steps, never
 * operations. The Main LLM chooses from it; nothing here commits anything.
 */
export function shelfRefinementCandidates(state, { limit = 8 } = {}) {
  const roadmap = state?.roadmap
  const nodes = roadmap?.nodes ?? []
  const order = { [SHELF_NODE_STATUS.PARTIALLY_REALIZED]: 0, [SHELF_NODE_STATUS.READY_TO_REFINE]: 1 }
  const candidates = nodes
    .map((node, index) => ({ node, index, readiness: shelfNodeReadiness(roadmap, node.id) }))
    .filter(entry => entry.readiness.ready && order[entry.node.status] !== undefined)
    .sort((left, right) => (order[left.node.status] - order[right.node.status])
      || ((left.node.ready_since ?? Number.MAX_SAFE_INTEGER) - (right.node.ready_since ?? Number.MAX_SAFE_INTEGER))
      || (left.index - right.index))
    .slice(0, Math.max(0, Math.min(32, limit)))
    .map(entry => ({
      node_id: entry.node.id,
      intent: entry.node.intent,
      why_it_matters: entry.node.why_it_matters,
      status: entry.node.status,
      // Non-binding (roadmap 4.8). Advice about KIND of work, not an operation.
      development_hint: entry.node.development_hint ?? null,
      depends_on: [...entry.node.depends_on],
      resolved_by: [...entry.node.resolved_by],
      verified_results: [...entry.node.verified_results],
      ready_since: entry.node.ready_since ?? null,
    }))
  return deepFreeze(candidates)
}

/** The single nearest useful node, or undefined when the shelf has none. */
export function nearestShelfRefinementTarget(state) {
  return shelfRefinementCandidates(state, { limit: 1 })[0]
}

/**
 * Attach a completed plan's verified results back to the shelf nodes it
 * resolved, moving each node along the realization ladder.
 *
 * Nodes that declare no capability frontier keep the original behaviour: the
 * plan that resolved them realizes them, because there is no frontier to
 * measure against.
 */
function attachPlanResultsToShelf(roadmap, { nodeIds, planId, results, satisfiedRecognitionIds, status, now }) {
  if (!roadmap) return roadmap
  const targets = new Set(nodeIds ?? [])
  if (targets.size === 0) return roadmap
  const cleanResults = stringList(results, { max: 32, maxLength: 300 })
  return {
    ...roadmap,
    nodes: roadmap.nodes.map((node) => {
      if (!targets.has(node.id)) return node
      const base = {
        ...node,
        resolved_by: Array.from(new Set([...node.resolved_by, planId])),
        verified_results: Array.from(new Set([...node.verified_results, ...cleanResults])).slice(0, 64),
      }
      if (!node.capability_frontier) return { ...base, status: maxShelfNodeStatus(node.status, status) }
      const frontier = advanceFrontier(node.capability_frontier, {
        now,
        planId,
        results: cleanResults,
        satisfiedRecognitionIds,
      })
      return {
        ...base,
        capability_frontier: frontier,
        status: maxShelfNodeStatus(node.status, shelfStatusForFrontier(frontier)),
      }
    }),
  }
}

// --- plan construction -----------------------------------------------------

function createPlan(state, {
  now,
  sequence,
  planVersion,
  derivedFrom,
  steps,
  roadmapNodeIds,
  developmentMode,
  origin,
  carriedForwardEvidence = [],
}) {
  const planId = `${state.goal.goal_id}_p${sequence}`
  const sanitizedSteps = sanitizeSteps(steps, { planId, planVersion })
  const nodeIds = stringList(roadmapNodeIds, { max: 16, maxLength: 120 })
  const mode = DEVELOPMENT_MODES.includes(developmentMode) ? developmentMode : 'maintain'
  // Which of the nodes this draft claims to refine had actually been unblocked
  // by the world when it was authored. Recorded, not enforced: the Main LLM
  // authors plans (roadmap 1.3) and may deliberately refine a node the shelf
  // still considers blocked. Making that visible is the point.
  const readiness = nodeIds.map(id => shelfNodeReadiness(state.roadmap, id))
  const progress = {}
  sanitizedSteps.forEach((step, index) => {
    progress[step.step_id] = { ...emptyStepProgress(), status: index === 0 ? 'active' : 'pending' }
  })
  return {
    plan_id: planId,
    plan_version: planVersion,
    goal_id: state.goal.goal_id,
    roadmap_revision_id: state.roadmap?.roadmap_revision_id ?? null,
    roadmap_node_ids: nodeIds,
    development_mode: mode,
    refinement_grounding: {
      ready_node_ids: readiness.filter(item => item.ready).map(item => item.node_id),
      not_ready: readiness.filter(item => !item.ready).map(item => ({ node_id: item.node_id, reason: item.reason })),
    },
    // Which advisory steering the draft was written under (roadmap 4.9:
    // steering is fed to the Main LLM BEFORE it drafts). Snapshot, not a rule.
    steering_at_draft: state.steering
      ? {
          mode: state.steering.current_mode,
          steering_sequence: state.steering.sequence,
          critical_path: state.steering.critical_path,
          // One dominant mode per slice (roadmap 4.5) is judged by Jev's scope
          // review; a divergence from the advisory mode is merely recorded.
          diverges_from_steering: state.steering.current_mode !== null && mode !== state.steering.current_mode,
        }
      : null,
    status: PLAN_STATUS.DRAFT,
    steps: sanitizedSteps,
    active_step_index: 0,
    derived_from_plan_id: derivedFrom ?? null,
    superseded_by_plan_id: null,
    origin: text(origin, 80) || 'main_llm_draft',
    created_at: now,
    updated_at: now,
    committed_at: null,
    completed_at: null,
    blocker: null,
    execution: { step_progress: progress, batches_attempted: 0 },
    jev_review: { refinement_count: 0, last_reason_codes: [], last_verdict: null, last_reviewed_at: null },
    advisory: { planner_focus_step_id: null, planner_focus_at: null, steering_note: null },
    carried_forward_evidence: stringList(carriedForwardEvidence, { max: 64, maxLength: 200 }),
    lifecycle: [{ status: PLAN_STATUS.DRAFT, at: now, reason: text(origin, 80) || 'draft_created' }],
  }
}

function withStatus(plan, status, { now, reason }) {
  return {
    ...plan,
    status,
    updated_at: now,
    lifecycle: [...boundedList(plan.lifecycle, 63), { status, at: now, reason: text(reason, 200) }].slice(-64),
  }
}

// --- deadlock detection (harness-side, deterministic, no model calls) -------

/**
 * Built-in deterministic deadlock evaluators.
 *
 * Seam note: a future SEMANTIC deadlock signal from Jev plugs in as another
 * entry with the same `{ id, evaluate(context) -> signal | undefined }` shape,
 * passed through `evaluateDeadlockSignals(state, { extraEvaluators })`. No
 * restructuring required. It is deliberately NOT implemented here — everything
 * in this array must stay deterministic and model-free.
 */
export const HARNESS_DEADLOCK_EVALUATORS = Object.freeze([
  Object.freeze({
    id: DEADLOCK_SIGNAL_KIND.EVIDENCE_STALL,
    evaluate({ step, progress, limits }) {
      if (!step.completion_contract) return undefined
      if (progress.batches_since_evidence < limits.evidenceStallBatches) return undefined
      return {
        kind: DEADLOCK_SIGNAL_KIND.EVIDENCE_STALL,
        step_id: step.step_id,
        detail: `${progress.batches_since_evidence} operation batches with no accepted evidence advancing the contract`,
        observed: progress.batches_since_evidence,
        limit: limits.evidenceStallBatches,
      }
    },
  }),
  Object.freeze({
    id: DEADLOCK_SIGNAL_KIND.REPEATING_FAILURE,
    evaluate({ step, progress, limits }) {
      const entries = Object.entries(progress.failure_counts ?? {})
      const worst = entries.reduce((best, entry) => (entry[1] > (best?.[1] ?? 0) ? entry : best), undefined)
      if (!worst || worst[1] < limits.repeatedFailureLimit) return undefined
      return {
        kind: DEADLOCK_SIGNAL_KIND.REPEATING_FAILURE,
        step_id: step.step_id,
        detail: `failure reason ${worst[0]} recurred ${worst[1]} times`,
        reason_code: worst[0],
        observed: worst[1],
        limit: limits.repeatedFailureLimit,
      }
    },
  }),
  Object.freeze({
    id: DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT,
    evaluate({ step, progress }) {
      if (!step.completion_contract || !progress.unsatisfiable) return undefined
      return {
        kind: DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT,
        step_id: step.step_id,
        detail: progress.unsatisfiable.reason,
        proof_ref: progress.unsatisfiable.proof_ref ?? null,
      }
    },
  }),
  Object.freeze({
    id: DEADLOCK_SIGNAL_KIND.PROSE_ONLY_CEILING,
    evaluate({ step, progress, limits }) {
      // Prose-only steps have no contract, so signals (a) and (c) cannot see
      // them. This hard ceiling is their backstop against looping forever.
      if (step.completion_contract) return undefined
      if (progress.batches_attempted < limits.proseOnlyOperationCeiling) return undefined
      return {
        kind: DEADLOCK_SIGNAL_KIND.PROSE_ONLY_CEILING,
        step_id: step.step_id,
        detail: `prose-only step reached the ${limits.proseOnlyOperationCeiling} operation batch ceiling`,
        observed: progress.batches_attempted,
        limit: limits.proseOnlyOperationCeiling,
      }
    },
  }),
])

export function defaultDeadlockLimits() {
  return {
    evidenceStallBatches: DEADLOCK_EVIDENCE_STALL_BATCHES,
    repeatedFailureLimit: DEADLOCK_REPEATED_FAILURE_LIMIT,
    proseOnlyOperationCeiling: PROSE_ONLY_STEP_OPERATION_CEILING,
  }
}

/**
 * Deterministic, harness-side deadlock evaluation for the active committed step.
 * Pure: takes only state and configuration. Never calls a model.
 */
export function evaluateDeadlockSignals(state, { limits = {}, extraEvaluators = [], planId } = {}) {
  const effectiveLimits = { ...defaultDeadlockLimits(), ...limits }
  const plan = planId ? getPlan(state, planId) : getActivePlan(state)
  const empty = { deadlocked: false, signals: [], plan_id: plan?.plan_id ?? null, step_id: null }
  if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return empty
  const step = plan.steps[plan.active_step_index]
  if (!step) return empty
  const progress = plan.execution.step_progress[step.step_id] ?? emptyStepProgress()
  const context = { plan, step, progress, limits: effectiveLimits }
  const evaluators = [...HARNESS_DEADLOCK_EVALUATORS, ...boundedList(extraEvaluators, 8)]
  const signals = evaluators
    .map(evaluator => {
      try { return evaluator?.evaluate?.(context) }
      catch { return undefined }
    })
    .filter(Boolean)
  return { deadlocked: signals.length > 0, signals, plan_id: plan.plan_id, step_id: step.step_id }
}

// --- read-only views (roadmap section 8) -----------------------------------

/**
 * Plan Tracker is a READ-ONLY view of one immutable plan. It renders committed
 * content and authoritative progress; it is not a planning workspace. The
 * returned object is deep-frozen.
 */
export function planTrackerView(state, { planId } = {}) {
  const plan = planId ? getPlan(state, planId) : getActivePlan(state)
  if (!plan) {
    return deepFreeze({
      kind: 'plan_tracker_view',
      goal_id: state?.goal?.goal_id ?? null,
      plan_id: null,
      steps: [],
    })
  }
  return deepFreeze({
    kind: 'plan_tracker_view',
    goal_id: plan.goal_id,
    roadmap_revision_id: plan.roadmap_revision_id,
    roadmap_node_ids: [...plan.roadmap_node_ids],
    plan_id: plan.plan_id,
    plan_version: plan.plan_version,
    status: plan.status,
    development_mode: plan.development_mode,
    active_step_id: plan.steps[plan.active_step_index]?.step_id ?? null,
    active_step_index: plan.active_step_index,
    steps: plan.steps.map((step, index) => {
      const progress = plan.execution.step_progress[step.step_id] ?? emptyStepProgress()
      return {
        step_id: step.step_id,
        index,
        description: step.description,
        completion_contract: clone(step.completion_contract),
        completion_confidence: step.completion_confidence,
        reduced_confidence: step.reduced_confidence,
        status: progress.status,
        evidence_refs: progress.accepted_evidence.map(item => item.ref),
      }
    }),
    verified_completed_step_ids: plan.steps
      .filter(step => plan.execution.step_progress[step.step_id]?.status === 'completed')
      .map(step => step.step_id),
    blocker: clone(plan.blocker),
    derived_from_plan_id: plan.derived_from_plan_id,
    superseded_by_plan_id: plan.superseded_by_plan_id,
    // Advisory only. Never advances anything.
    advisory_planner_focus_step_id: plan.advisory.planner_focus_step_id,
    carried_forward_evidence: [...plan.carried_forward_evidence],
  })
}

/** Full lineage chain for auditing: goal -> revision -> node -> plan -> step. */
export function lineageOf(state, { planId } = {}) {
  const plan = planId ? getPlan(state, planId) : getActivePlan(state)
  if (!plan) return undefined
  const roadmap = [state.roadmap, ...boundedList(state.roadmap_history, 32)]
    .find(revision => revision?.roadmap_revision_id === plan.roadmap_revision_id) ?? state.roadmap
  return deepFreeze({
    goal_id: plan.goal_id,
    roadmap_revision_id: plan.roadmap_revision_id,
    roadmap_node_ids: [...plan.roadmap_node_ids],
    shelf_node_intents: plan.roadmap_node_ids.map(id => roadmap?.nodes?.find(node => node.id === id)?.intent ?? null),
    plan_id: plan.plan_id,
    plan_version: plan.plan_version,
    derived_from_plan_id: plan.derived_from_plan_id,
    superseded_by_plan_id: plan.superseded_by_plan_id,
    step_ids: plan.steps.map(step => step.step_id),
  })
}

// --- strategic steering (roadmap section 4) --------------------------------

/**
 * Keep only pressure codes in the direction's grounded vocabulary.
 *
 * Unrecognised codes are dropped silently at this level; the caller reports
 * what it dropped so the loss is visible without letting prose through.
 */
function sanitizeSteeringPressure(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const keep = direction => Array.from(new Set(
    stringList(source[direction], { max: 12, maxLength: 200 })
      .map(code => code.trim().toLowerCase())
      .filter(code => STEERING_PRESSURE_SETS[direction].has(code)),
  ))
  return { vertical: keep('vertical'), horizontal: keep('horizontal') }
}

/** The pressure codes the caller offered that no direction recognises. */
function unknownSteeringPressure(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const unknown = []
  for (const direction of ['vertical', 'horizontal']) {
    for (const code of stringList(source[direction], { max: 12, maxLength: 200 })) {
      const normalized = code.trim().toLowerCase()
      if (!STEERING_PRESSURE_SETS[direction].has(normalized) && !unknown.includes(normalized)) {
        unknown.push(normalized)
      }
    }
  }
  return unknown.slice(0, 12)
}

function clamp01(value) {
  const number = finiteNumber(value)
  if (number === undefined) return 0
  return Math.max(0, Math.min(1, number))
}

/**
 * Is `boundary` a SAFE semantic boundary in the current state (roadmap 4.3)?
 *
 * Two independent gates, both required:
 *
 *   1. No plan may be in flight. If any plan is COMMITTED or EXECUTING,
 *      steering is refused outright — "steering" must never become a loophole
 *      for touching a healthy committed plan mid-flight.
 *   2. The claimed boundary must actually be true of durable state. Naming
 *      `plan_completed` does not make a plan complete.
 */
export function isSafeSteeringBoundary(state, { boundary, planId, source } = {}) {
  const current = state ?? createEmptyPlanningState()
  const name = text(boundary, 60)
  if (!STEERING_BOUNDARIES.includes(name)) return { safe: false, boundary: name, reason: 'unknown_boundary' }
  if (!current.goal) return { safe: false, boundary: name, reason: 'no_goal' }
  const inFlight = current.plans.find(plan => plan.status === PLAN_STATUS.COMMITTED || plan.status === PLAN_STATUS.EXECUTING)
  if (inFlight) return { safe: false, boundary: name, reason: 'plan_in_flight', plan_id: inFlight.plan_id }

  if (name === STEERING_BOUNDARY.GOAL_ADMISSION) {
    return current.plans.some(plan => plan.committed_at)
      ? { safe: false, boundary: name, reason: 'goal_already_past_admission' }
      : { safe: true, boundary: name, reason: 'initial_goal_admission' }
  }
  if (name === STEERING_BOUNDARY.PLAN_COMPLETED) {
    const plan = planId ? getPlan(current, planId) : [...current.plans].reverse().find(item => item.status === PLAN_STATUS.COMPLETED)
    return plan?.status === PLAN_STATUS.COMPLETED
      ? { safe: true, boundary: name, reason: 'immutable_plan_completed', plan_id: plan.plan_id }
      : { safe: false, boundary: name, reason: 'no_completed_plan' }
  }
  if (name === STEERING_BOUNDARY.USER_REVISION_APPROVED) {
    if (!isUserAuthority(source)) return { safe: false, boundary: name, reason: 'requires_user_authority' }
    const plan = planId ? getPlan(current, planId) : getActivePlan(current)
    return plan?.origin === 'user_approved_revision'
      ? { safe: true, boundary: name, reason: 'successor_plan_admitted', plan_id: plan.plan_id }
      : { safe: false, boundary: name, reason: 'no_user_approved_successor' }
  }
  // USER_PRIORITY_CHANGE
  return isUserAuthority(source)
    ? { safe: true, boundary: name, reason: 'explicit_user_priority_change' }
    : { safe: false, boundary: name, reason: 'requires_user_authority' }
}

/**
 * The tick-tock BIAS (roadmap 4.4): after a directional slice, the other
 * direction is the thing to consider next. It is a suggestion to weigh, never
 * a rule that fires — `evaluateSteeringTransition` will happily keep the same
 * mode forever when the grounded pressure keeps pointing that way.
 */
export function steeringBias(record) {
  const last = record?.last_directional_mode
  if (!DIRECTIONAL_MODES.includes(last)) return { bias: null, note: 'no directional history yet' }
  return {
    bias: last === 'vertical' ? 'horizontal' : 'vertical',
    after: last,
    note: 'advisory cadence bias only; consecutive same-mode slices remain legal when justified',
  }
}

/**
 * Pure hysteresis decision (roadmap 4.4).
 *
 * Deliberate asymmetries:
 *   - Proposing the SAME directional mode is always accepted. There is no cap
 *     on consecutive vertical or consecutive horizontal slices; tick-tock is a
 *     bias, not a state machine.
 *   - Flipping direction must clear all three named thresholds. Two of them
 *     (confidence, pressure margin) come from the boundary evaluation; the
 *     third makes a mode own at least one slice before it can be abandoned.
 *   - `recover` is exempt: a lost capability is not a cadence question.
 *   - `maintain` is "no strategic change", so it does not move — or reset —
 *     the directional cadence at all.
 */
export function evaluateSteeringTransition(record, proposal) {
  const previousMode = record?.current_mode ?? null
  const lastDirectional = DIRECTIONAL_MODES.includes(record?.last_directional_mode) ? record.last_directional_mode : null
  const consecutive = Number.isSafeInteger(record?.consecutive_mode_slices) ? record.consecutive_mode_slices : 0
  const proposed = DEVELOPMENT_MODES.includes(proposal?.mode) ? proposal.mode : 'maintain'
  const confidence = clamp01(proposal?.confidence)
  const pressure = sanitizeSteeringPressure(proposal?.pressure)

  const accept = (mode, extra = {}) => ({
    mode,
    previous_mode: previousMode,
    last_directional_mode: DIRECTIONAL_MODES.includes(mode) ? mode : lastDirectional,
    changed: mode !== previousMode,
    hysteresis_applied: false,
    hold_reasons: [],
    consecutive_mode_slices: consecutive,
    proposed_mode: proposed,
    ...extra,
  })

  if (proposed === 'recover') return accept('recover', { exempt: 'recover_is_not_a_cadence_decision' })
  if (proposed === 'maintain') return accept('maintain', { exempt: 'maintain_does_not_move_the_cadence' })
  if (!lastDirectional) return accept(proposed, { consecutive_mode_slices: 1, exempt: 'no_directional_history' })
  if (proposed === lastDirectional) {
    return accept(proposed, {
      consecutive_mode_slices: consecutive + 1,
      exempt: 'same_direction_sustained',
    })
  }

  const holdReasons = []
  if (confidence < STEERING_HYSTERESIS.MIN_CONFIDENCE_TO_SWITCH) holdReasons.push(STEERING_HOLD_REASON.LOW_CONFIDENCE)
  if (consecutive < STEERING_HYSTERESIS.MIN_SLICES_BEFORE_SWITCH) holdReasons.push(STEERING_HOLD_REASON.MODE_TOO_NEW)
  const margin = pressure[proposed].length - pressure[lastDirectional].length
  if (margin < STEERING_HYSTERESIS.MIN_PRESSURE_MARGIN) holdReasons.push(STEERING_HOLD_REASON.INSUFFICIENT_PRESSURE)

  if (holdReasons.length === 0) {
    return accept(proposed, { consecutive_mode_slices: 1, switched_from: lastDirectional, pressure_margin: margin })
  }
  return {
    mode: lastDirectional,
    previous_mode: previousMode,
    last_directional_mode: lastDirectional,
    changed: false,
    hysteresis_applied: true,
    hold_reasons: holdReasons,
    consecutive_mode_slices: consecutive + 1,
    proposed_mode: proposed,
    pressure_margin: margin,
  }
}

/** The durable advisory steering record, or null. Frozen; a copy, not the state. */
export function steeringRecord(state) {
  return state?.steering ? deepFreeze(clone(state.steering)) : null
}

/**
 * Everything the Main LLM should see BEFORE it drafts the next slice
 * (roadmap 4.9): what kind of development the boundary suggests, and which
 * shelf nodes the world has actually unblocked.
 *
 * Steering review and scope review stay separate questions. This answers
 * "what kind of development next?" only; nothing here says whether any
 * particular draft is committable, and nothing here is execution authority.
 */
export function steeringContextForDraft(state) {
  const record = state?.steering ?? null
  return deepFreeze({
    kind: 'steering_context',
    advisory: true,
    execution_authority: false,
    goal_id: state?.goal?.goal_id ?? null,
    current_mode: record?.current_mode ?? null,
    previous_mode: record?.previous_mode ?? null,
    last_directional_mode: record?.last_directional_mode ?? null,
    reason: record?.reason ?? null,
    critical_path: record?.critical_path ?? null,
    pressure: clone(record?.pressure) ?? { vertical: [], horizontal: [] },
    last_plan_id: record?.last_plan_id ?? null,
    consecutive_mode_slices: record?.consecutive_mode_slices ?? 0,
    hysteresis_applied: record?.hysteresis_applied ?? false,
    hold_reasons: [...(record?.hold_reasons ?? [])],
    user_priority: clone(record?.user_priority) ?? null,
    ...steeringBias(record),
    // Guidance, at LOD 1. Intent and lineage only — no steps, no operations.
    refinement_candidates: shelfRefinementCandidates(state, { limit: 5 }),
  })
}

// --- the one transition authority ------------------------------------------

function contractSatisfiedBy(step, progress, evidence) {
  const contract = step.completion_contract
  if (!contract) return false
  if (evidence.contract_satisfied === true) return true
  const satisfied = new Set([
    ...progress.accepted_evidence.flatMap(item => item.satisfied_requirement_ids ?? []),
    ...stringList(evidence.satisfied_requirement_ids, { max: 16, maxLength: 120 }),
  ])
  const requirementIds = contract.requirements.map(requirement => requirement.id)
  if (requirementIds.length === 0) return false
  return contract.mode === 'any'
    ? requirementIds.some(id => satisfied.has(id))
    : requirementIds.every(id => satisfied.has(id))
}

function isRuntimeAuthority(source) {
  return EVIDENCE_AUTHORITIES.includes(text(source, 60))
}

function isUserAuthority(source) {
  return USER_AUTHORITIES.includes(text(source, 60))
}

function updateProgress(plan, stepId, updater, { now }) {
  const current = plan.execution.step_progress[stepId] ?? emptyStepProgress()
  return {
    ...plan,
    updated_at: now,
    execution: {
      ...plan.execution,
      step_progress: { ...plan.execution.step_progress, [stepId]: updater(current) },
    },
  }
}

function freezeCommittedPlan(plan) {
  // The committed semantic content is frozen against the LLM and against Jev.
  // Execution bookkeeping stays outside the frozen region.
  deepFreeze(plan.steps)
  deepFreeze(plan.roadmap_node_ids)
  return plan
}

function blockPlan(state, plan, { now, blocker }) {
  // A blocker FREEZES the plan. There is deliberately no path from here to
  // automatic replanning: only USER_REVISION_APPROVED can produce a successor.
  const blocked = withStatus({ ...plan, blocker: clone(blocker) }, PLAN_STATUS.BLOCKED, {
    now,
    reason: blocker?.reason_code ?? 'blocked',
  })
  return withPlan(state, plan.plan_id, () => blocked)
}

/**
 * The ONLY way planning state may change.
 *
 * Pure: no I/O, no Date.now(); `now` comes from the event.
 * Total: unknown or malformed events return the state unchanged (never throws).
 */
const HANDLERS = {}

export function applyPlanningEvent(state, event) {
  const current = state && typeof state === 'object' && !Array.isArray(state) ? state : createEmptyPlanningState()
  if (!event || typeof event !== 'object' || Array.isArray(event)) return current
  const type = text(event.type, 80)
  if (!PLANNING_EVENT_TYPES.includes(type)) return current
  const now = finiteNumber(event.now)
  if (now === undefined) return current

  const handler = HANDLERS[type]
  const next = handler(current, event, now)
  return next ?? current
}

Object.assign(HANDLERS, {
  [PLANNING_EVENT.GOAL_ACCEPTED](state, event, now) {
    const sequence = nextSequence(state)
    const goal = sanitizeGoal({
      goal_id: text(event.goal_id, 120) || `goal_${fingerprint(`${sequence}|${now}|${text(event.objective, 200)}`)}_${sequence}`,
      owner: event.owner,
      objective: event.objective,
      constraints: event.constraints,
      status: GOAL_STATUS.ACTIVE,
      created_at: now,
      updated_at: now,
    })
    if (!goal || !goal.objective) return state
    // A new goal starts a fresh planning state. Previous goals are history held
    // by the caller's snapshot store, not silently merged here.
    const fresh = createEmptyPlanningState()
    // The epoch is monotonic across the process lifetime, so it carries over
    // from the abandoned goal rather than restarting at 0.
    return withReasoningReset({
      ...fresh,
      sequence,
      goal,
      reasoning_epoch: currentReasoningEpoch(state),
      updated_at: now,
      log: logEntry(fresh, { type: PLANNING_EVENT.GOAL_ACCEPTED, at: now, goal_id: goal.goal_id }),
    }, { now, eventType: PLANNING_EVENT.GOAL_ACCEPTED, reason: 'new_goal' })
  },

  [PLANNING_EVENT.ROADMAP_REVISED](state, event, now) {
    if (!state.goal) return state
    // Long-horizon guidance moves for exactly two reasons (roadmap 3):
    // explicit USER direction, or a grounded VERIFIED world change that
    // invalidates it. Planner preference and Jev output are neither, and are
    // structurally excluded here rather than by convention.
    const source = text(event.source, 60)
    const byUser = isUserAuthority(source)
    const byWorld = isRuntimeAuthority(source)
      && stringList(event.evidence_refs, { max: 16, maxLength: 200 }).length > 0
    if (!byUser && !byWorld) return state
    const sequence = nextSequence(state)
    const roadmap = createRoadmapRevision(state, {
      now,
      sequence,
      nodes: event.nodes,
      reason: event.reason,
      authority: byUser ? 'user' : 'verified_world_change',
      evidenceRefs: event.evidence_refs,
    })
    // The shelf moved under the planner: the next round restarts from durable
    // state rather than from reasoning about the previous shelf.
    return withReasoningReset({
      ...state,
      sequence,
      roadmap,
      roadmap_history: [...boundedList(state.roadmap_history, 31), ...(state.roadmap ? [state.roadmap] : [])].slice(-32),
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.ROADMAP_REVISED,
        at: now,
        roadmap_revision_id: roadmap.roadmap_revision_id,
        reason: roadmap.reason,
      }),
    }, { now, eventType: PLANNING_EVENT.ROADMAP_REVISED, reason: roadmap.reason || 'roadmap_revised' })
  },

  /**
   * Record advisory steering at a planning boundary (roadmap 4.3 / 4.4 / 4.7).
   *
   * What this handler can do: write `state.steering`.
   * What it can NOT do, structurally: touch a plan. It never appears in the
   * returned object's `plans`, so there is no expression of this transition
   * that mutates, replaces, unfreezes or re-scopes any plan — committed,
   * executing or otherwise. It is refused outright while anything is in flight.
   *
   * Jev and the Main LLM are excluded by the source allowlist. A Jev
   * recommendation may ride along in `recommended_by` / `reason_codes` as
   * PROVENANCE; it is never the authority.
   */
  [PLANNING_EVENT.STEERING_EVALUATED](state, event, now) {
    const source = text(event.source, 60)
    if (!isRuntimeAuthority(source) && !isUserAuthority(source)) return state
    const gate = isSafeSteeringBoundary(state, {
      boundary: event.boundary,
      planId: event.plan_id,
      source,
    })
    if (!gate.safe) return state

    const record = state.steering ?? null
    const byUser = isUserAuthority(source)

    // Explicit user priority outranks any recommendation, permanently, until
    // the user changes or clears it (roadmap 4.7: steering may not force a
    // mode against explicit user priorities).
    let userPriority = record?.user_priority ?? null
    if (byUser && event.clear_user_priority === true) userPriority = null
    if (byUser && DEVELOPMENT_MODES.includes(event.user_priority_mode)) {
      userPriority = {
        mode: event.user_priority_mode,
        set_by: text(event.approved_by, 128) || source,
        at: now,
      }
    }

    const proposal = {
      mode: event.recommended_mode ?? event.mode,
      confidence: event.confidence,
      pressure: event.pressure,
    }
    const decision = userPriority
      ? {
          mode: userPriority.mode,
          previous_mode: record?.current_mode ?? null,
          last_directional_mode: DIRECTIONAL_MODES.includes(userPriority.mode)
            ? userPriority.mode
            : (record?.last_directional_mode ?? null),
          changed: userPriority.mode !== (record?.current_mode ?? null),
          hysteresis_applied: false,
          hold_reasons: DEVELOPMENT_MODES.includes(proposal.mode) && proposal.mode !== userPriority.mode
            ? [STEERING_HOLD_REASON.USER_PRIORITY_LOCKED]
            : [],
          consecutive_mode_slices: Number.isSafeInteger(record?.consecutive_mode_slices)
            ? record.consecutive_mode_slices + 1
            : 1,
          proposed_mode: DEVELOPMENT_MODES.includes(proposal.mode) ? proposal.mode : null,
          forced_by_user: true,
        }
      : evaluateSteeringTransition(record, proposal)

    const entry = {
      mode: decision.mode,
      boundary: gate.boundary,
      at: now,
      plan_id: gate.plan_id ?? (text(event.plan_id, 200) || null),
      changed: decision.changed,
      hysteresis_applied: decision.hysteresis_applied,
      hold_reasons: [...decision.hold_reasons],
    }

    const steering = {
      // Roadmap 4.4 shape.
      current_mode: decision.mode,
      previous_mode: decision.previous_mode,
      reason: text(event.reason, 400) || record?.reason || null,
      critical_path: text(event.critical_path ?? event.critical_path_summary, 300) || null,
      pressure: sanitizeSteeringPressure(event.pressure),
      // Visible, not silent: a caller that invented a pressure can see it was
      // not counted rather than believing it justified the mode.
      dropped_pressure: unknownSteeringPressure(event.pressure),
      last_plan_id: entry.plan_id,
      // Hysteresis bookkeeping.
      last_directional_mode: decision.last_directional_mode,
      consecutive_mode_slices: decision.consecutive_mode_slices,
      hysteresis_applied: decision.hysteresis_applied,
      hold_reasons: [...decision.hold_reasons],
      proposed_mode: decision.proposed_mode ?? null,
      forced_by_user: decision.forced_by_user === true,
      // Provenance of the advice, never its authority.
      recommendation: {
        recommended_by: text(event.recommended_by, 60) || null,
        recommended_mode: DEVELOPMENT_MODES.includes(proposal.mode) ? proposal.mode : null,
        confidence: clamp01(event.confidence),
        reason_codes: stringList(event.reason_codes, { max: 8, maxLength: 80 }),
        candidate_shelf_nodes: stringList(event.candidate_shelf_nodes, { max: 5, maxLength: 120 })
          .filter(id => (state.roadmap?.nodes ?? []).some(node => node.id === id)),
      },
      user_priority: userPriority,
      boundary: gate.boundary,
      authority: source,
      sequence: (Number.isSafeInteger(record?.sequence) ? record.sequence : 0) + 1,
      updated_at: now,
      history: [...boundedList(record?.history, 31), entry].slice(-32),
    }

    return {
      ...state,
      steering,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.STEERING_EVALUATED,
        at: now,
        boundary: gate.boundary,
        mode: steering.current_mode,
        hysteresis_applied: steering.hysteresis_applied,
      }),
    }
  },

  [PLANNING_EVENT.DRAFT_CREATED](state, event, now) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    const sequence = nextSequence(state)
    const plan = createPlan(state, {
      now,
      sequence,
      planVersion: 1,
      derivedFrom: null,
      steps: event.steps,
      roadmapNodeIds: event.roadmap_node_ids,
      developmentMode: event.development_mode,
      origin: event.origin ?? 'main_llm_draft',
    })
    if (plan.steps.length === 0) return state
    // A new draft supersedes any still-uncommitted draft; committed plans are
    // untouched.
    const plans = state.plans.map(existing => (PRE_COMMIT_STATUSES.includes(existing.status)
      ? withStatus({ ...existing, superseded_by_plan_id: plan.plan_id }, PLAN_STATUS.SUPERSEDED, { now, reason: 'new_draft' })
      : existing))
    return {
      ...state,
      sequence,
      plans: [...plans, plan],
      active_plan_id: plan.plan_id,
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.DRAFT_CREATED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.JEV_REVIEW_REQUESTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || plan.status !== PLAN_STATUS.DRAFT) return state
    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id
        ? withStatus(item, PLAN_STATUS.JEV_REVIEW, { now, reason: 'jev_scope_review' })
        : item)),
    }
  },

  [PLANNING_EVENT.JEV_REFINEMENT_REQUESTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan) return state
    // Jev has no authority over committed content.
    if (isPlanImmutable(plan)) return state

    const reasonCodes = stringList(event.reason_codes, { max: 12, maxLength: 80 })
    const prefix = Number.isSafeInteger(event.actionable_prefix)
      ? Math.max(0, Math.min(event.actionable_prefix, plan.steps.length))
      : undefined

    // The deferred tail must land somewhere or it is simply dropped. It becomes
    // tentative Roadmap Shelf guidance in a new roadmap revision.
    const tailSteps = prefix === undefined ? [] : plan.steps.slice(prefix)
    const explicitTail = boundedList(event.shelved_tail, 32)
    const tailNodes = [
      ...explicitTail,
      ...tailSteps.map(step => ({
        id: `shelf_${plan.plan_id}_${fingerprint(step.step_id)}`,
        intent: step.description,
        why_it_matters: `deferred tail of ${plan.plan_id} (jev refine)`,
        status: SHELF_NODE_STATUS.TENTATIVE,
        // A deferred tail comes AFTER the slice it was cut from. Recording that
        // as a real dependency is what keeps the tail out of the refinement
        // candidate set until the world has actually realized the node in
        // front of it — instead of a whole plan tail appearing "ready".
        depends_on: [...plan.roadmap_node_ids],
        derived_from_node_id: plan.roadmap_node_ids[0],
      })),
    ]

    let next = withPlan(state, plan.plan_id, item => withStatus({
      ...item,
      jev_review: {
        refinement_count: item.jev_review.refinement_count + 1,
        last_reason_codes: reasonCodes,
        last_verdict: 'refine',
        last_reviewed_at: now,
        actionable_prefix: prefix ?? null,
        problem_step_ids: stringList(event.problem_step_ids, { max: 16, maxLength: 200 }),
        recommended_boundary: text(event.recommended_boundary, 200) || null,
      },
    }, PLAN_STATUS.DRAFT, { now, reason: 'jev_refine' }))

    let shelvedTail = false
    if (tailNodes.length > 0 && state.goal) {
      shelvedTail = true
      const sequence = nextSequence(next)
      const merged = [...(next.roadmap?.nodes ?? []), ...tailNodes]
      const roadmap = createRoadmapRevision(next, {
        now,
        sequence,
        nodes: merged,
        reason: text(event.reason ?? 'deferred_tail_from_jev_refine', 300),
        // Shelving a tail is additive bookkeeping about the draft Jev just
        // criticised, not a revision of long-horizon guidance. It is recorded
        // under its own authority so it can never be mistaken for one.
        authority: 'deferred_tail',
      })
      next = {
        ...next,
        sequence,
        roadmap,
        roadmap_history: [...boundedList(next.roadmap_history, 31), ...(next.roadmap ? [next.roadmap] : [])].slice(-32),
      }
    }

    const refined = {
      ...next,
      updated_at: now,
      log: logEntry(next, {
        type: PLANNING_EVENT.JEV_REFINEMENT_REQUESTED,
        at: now,
        plan_id: plan.plan_id,
        reason_codes: reasonCodes,
        shelved_tail: tailNodes.length,
      }),
    }
    // Reasoning resets only when a tail was actually SHELVED. A refinement that
    // shelves nothing is an ordinary pre-commit critique of the same draft.
    return shelvedTail
      ? withReasoningReset(refined, {
          now,
          eventType: PLANNING_EVENT.JEV_REFINEMENT_REQUESTED,
          reason: 'deferred_tail_shelved',
        })
      : refined
  },

  [PLANNING_EVENT.PLAN_COMMITTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || !PRE_COMMIT_STATUSES.includes(plan.status)) return state
    // Commit gate: Jev actionable + runtime validation pass. No user approval in
    // the normal path.
    if (text(event.jev_verdict, 40) !== 'actionable') return state
    if (event.runtime_validation?.passed !== true) return state
    if (plan.steps.length === 0) return state

    const committed = freezeCommittedPlan(withStatus({
      ...plan,
      committed_at: now,
      jev_review: { ...plan.jev_review, last_verdict: 'actionable', last_reviewed_at: now },
      runtime_validation: {
        passed: true,
        validated_at: now,
        unsupported_step_ids: stringList(event.runtime_validation?.unsupported_step_ids, { max: 16, maxLength: 200 }),
      },
    }, PLAN_STATUS.COMMITTED, { now, reason: 'auto_commit_actionable_and_validated' }))

    return {
      ...state,
      active_plan_id: committed.plan_id,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? committed : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_COMMITTED, at: now, plan_id: committed.plan_id }),
    }
  },

  [PLANNING_EVENT.PLANNER_FOCUS_PROPOSED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan) return state
    // Advisory only (roadmap section 8): recorded, never acted upon.
    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id
        ? {
            ...item,
            advisory: {
              ...item.advisory,
              planner_focus_step_id: text(event.step_id, 200) || null,
              planner_focus_at: now,
            },
          }
        : item)),
    }
  },

  [PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    const step = plan.steps[plan.active_step_index]
    if (!step) return state
    const stepId = text(event.step_id, 200) || step.step_id
    if (stepId !== step.step_id) return state
    const failureCode = text(event.failure_reason_code, 120)
    const updated = updateProgress(plan, stepId, progress => ({
      ...progress,
      batches_attempted: progress.batches_attempted + 1,
      batches_since_evidence: progress.batches_since_evidence + 1,
      operations_attempted: progress.operations_attempted
        + (Number.isSafeInteger(event.operation_count) && event.operation_count > 0 ? event.operation_count : 1),
      failure_counts: failureCode
        ? { ...progress.failure_counts, [failureCode]: (progress.failure_counts[failureCode] ?? 0) + 1 }
        : progress.failure_counts,
    }), { now })
    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id
        ? { ...updated, execution: { ...updated.execution, batches_attempted: plan.execution.batches_attempted + 1 } }
        : item)),
    }
  },

  [PLANNING_EVENT.CONTRACT_PROVEN_UNSATISFIABLE](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    // Only the runtime can prove the world cannot satisfy a contract.
    if (!isRuntimeAuthority(event.source)) return state
    const step = plan.steps[plan.active_step_index]
    if (!step || text(event.step_id, 200) !== step.step_id) return state
    const updated = updateProgress(plan, step.step_id, progress => ({
      ...progress,
      unsatisfiable: {
        reason: text(event.reason, 300) || 'contract_unsatisfiable',
        proof_ref: text(event.proof_ref, 200) || null,
        at: now,
      },
    }), { now })
    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? updated : item)),
    }
  },

  [PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    const evidence = event.evidence && typeof event.evidence === 'object' && !Array.isArray(event.evidence)
      ? event.evidence
      : undefined
    if (!evidence) return state
    // Only accepted RUNTIME evidence may advance progress. Jev and the planner
    // are structurally excluded here.
    if (!isRuntimeAuthority(evidence.source ?? event.source)) return state
    const step = plan.steps[plan.active_step_index]
    if (!step) return state
    // Evidence must correlate to the committed ACTIVE step, by stable step_id.
    if (text(event.step_id, 200) !== step.step_id) return state

    const record = {
      ref: text(evidence.ref, 200) || `evidence_${fingerprint(`${step.step_id}|${now}`)}`,
      kind: text(evidence.kind, 80) || 'runtime_evidence',
      source: text(evidence.source ?? event.source, 60),
      batch_id: Number.isSafeInteger(evidence.batch_id) ? evidence.batch_id : null,
      satisfied_requirement_ids: stringList(evidence.satisfied_requirement_ids, { max: 16, maxLength: 120 }),
      at: now,
    }

    const progressBefore = plan.execution.step_progress[step.step_id] ?? emptyStepProgress()
    if (progressBefore.accepted_evidence.some(item => item.ref === record.ref)) return state
    const satisfied = contractSatisfiedBy(step, progressBefore, { ...evidence, satisfied_requirement_ids: record.satisfied_requirement_ids })

    const updated = updateProgress(plan, step.step_id, progress => ({
      ...progress,
      status: 'active',
      accepted_evidence: [...progress.accepted_evidence, record].slice(-32),
      batches_since_evidence: 0,
      contract_satisfied: progress.contract_satisfied || satisfied,
    }), { now })

    const executing = plan.status === PLAN_STATUS.COMMITTED
      ? withStatus(updated, PLAN_STATUS.EXECUTING, { now, reason: 'first_accepted_evidence' })
      : updated

    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? executing : item)),
    }
  },

  [PLANNING_EVENT.STEP_COMPLETED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    // Completion is a runtime fact. Jev output and planner focus cannot assert it.
    if (!isRuntimeAuthority(event.source)) return state
    const index = plan.active_step_index
    const step = plan.steps[index]
    if (!step || text(event.step_id, 200) !== step.step_id) return state
    const progress = plan.execution.step_progress[step.step_id] ?? emptyStepProgress()
    if (step.completion_contract) {
      // Grounded step: the committed contract must actually be satisfied.
      if (!progress.contract_satisfied) return state
    }
    else if (progress.accepted_evidence.length === 0) {
      // Prose-only (reduced-confidence) step: still requires at least one piece
      // of accepted runtime evidence before it may advance.
      return state
    }

    const completed = updateProgress(plan, step.step_id, item => ({
      ...item,
      status: 'completed',
      completed_at: now,
    }), { now })
    const nextIndex = Math.min(index + 1, plan.steps.length - 1)
    const nextStep = plan.steps[index + 1]
    const advanced = nextStep
      ? updateProgress({ ...completed, active_step_index: nextIndex }, nextStep.step_id, item => ({
          ...item,
          status: item.status === 'completed' ? 'completed' : 'active',
        }), { now })
      : { ...completed, active_step_index: index }

    return {
      ...state,
      updated_at: now,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? advanced : item)),
      log: logEntry(state, { type: PLANNING_EVENT.STEP_COMPLETED, at: now, plan_id: plan.plan_id, step_id: step.step_id }),
    }
  },

  [PLANNING_EVENT.PLAN_COMPLETED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    if (!isRuntimeAuthority(event.source)) return state
    const allComplete = plan.steps.every(step => plan.execution.step_progress[step.step_id]?.status === 'completed')
    if (!allComplete) return state
    const completed = withStatus({ ...plan, completed_at: now }, PLAN_STATUS.COMPLETED, { now, reason: 'all_steps_completed' })
    // Attach verified results back to shelf lineage before the next round, and
    // move each resolved node along the realization ladder.
    //
    // A completed plan slice is NOT a reached frontier: only recognition
    // signals the frontier itself declared, reported satisfied here by the
    // runtime, can advance it. And a reached frontier is NOT a satisfied goal —
    // that needs its own GOAL_SATISFIED event with its own evidence.
    const roadmap = promoteReadyNodes(attachPlanResultsToShelf(state.roadmap, {
      now,
      nodeIds: plan.roadmap_node_ids,
      planId: plan.plan_id,
      results: event.verified_results,
      satisfiedRecognitionIds: event.satisfied_recognition_ids,
      status: SHELF_NODE_STATUS.REALIZED,
    }), now)
    // Attach first, THEN re-derive readiness: whatever the completed slice
    // realized is exactly what may unblock the next node to refine. The shelf
    // is the guide for the next round, not abandoned work.
    return {
      ...state,
      roadmap,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? completed : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_COMPLETED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.DEADLOCK_DETECTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
    const signals = boundedList(event.signals, 8).map(signal => ({
      kind: text(signal?.kind, 80),
      step_id: text(signal?.step_id, 200) || null,
      detail: text(signal?.detail, 300),
    }))
    const next = blockPlan(state, plan, {
      now,
      blocker: {
        kind: 'deadlock',
        reason_code: text(event.reason_code, 120) || 'deadlock_detected',
        detected_at: now,
        signals,
        // Explicitly: no automatic replanning. The user decides.
        requires_user_decision: true,
      },
    })
    return {
      ...next,
      updated_at: now,
      log: logEntry(next, { type: PLANNING_EVENT.DEADLOCK_DETECTED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    // A pre-commit plan can block too. Deterministic preflight runs BEFORE the
    // commit, so a draft it proves unexecutable would otherwise have to be
    // committed first purely to have somewhere to be marked blocked -- admitting
    // a plan already known to be invalid, to record that it is invalid.
    const blockable = [PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING, ...PRE_COMMIT_STATUSES]
    if (!plan || !blockable.includes(plan.status)) return state
    // The runtime owns the failure fact (roadmap 1.4 / 7).
    if (!isRuntimeAuthority(event.source)) return state
    const next = blockPlan(state, plan, {
      now,
      blocker: {
        kind: 'structural',
        reason_code: text(event.reason_code, 120) || 'structural_blocker',
        detected_at: now,
        evidence_refs: stringList(event.evidence_refs, { max: 16, maxLength: 200 }),
        detail: text(event.detail, 400),
        requires_user_decision: true,
      },
    })
    return {
      ...next,
      updated_at: now,
      log: logEntry(next, { type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.BLOCKED_CHOICE_RECORDED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || plan.status !== PLAN_STATUS.BLOCKED) return state
    if (!isUserAuthority(event.source)) return state
    const choice = text(event.choice, 40)
    if (!['keep_paused', 'revise', 'cancel'].includes(choice)) return state
    const approvedBy = text(event.approved_by, 128)
    if (!approvedBy) return state

    // A UI choice is durable planning input, not a loop-control side effect.
    // Recording the choice must not thaw or rewrite the immutable blocked plan.
    // In particular, "revise" only authorizes the next user-supplied revision;
    // USER_REVISION_APPROVED remains the sole successor-producing transition.
    const updated = {
      ...plan,
      blocker: {
        ...(plan.blocker ?? {}),
        requires_user_decision: true,
        user_choice: {
          choice,
          approved_by: approvedBy,
          at: now,
        },
      },
      updated_at: now,
    }
    return {
      ...state,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? updated : item)),
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.BLOCKED_CHOICE_RECORDED,
        at: now,
        plan_id: plan.plan_id,
        choice,
        approved_by: approvedBy,
      }),
    }
  },

  [PLANNING_EVENT.USER_REVISION_APPROVED](state, event, now) {
    const predecessor = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!predecessor) return state
    // Only a blocked or user-superseded predecessor may be revised, and only by
    // explicit user authority. This is the ONLY successor-producing path.
    if (![PLAN_STATUS.BLOCKED, PLAN_STATUS.SUPERSEDED].includes(predecessor.status)) return state
    if (!isUserAuthority(event.source) || !text(event.approved_by, 128)) return state

    const sequence = nextSequence(state)
    const carried = predecessor.steps
      .filter(step => predecessor.execution.step_progress[step.step_id]?.status === 'completed')
      .map(step => `${predecessor.plan_id}:${step.step_id}`)
    const successor = createPlan(state, {
      now,
      sequence,
      planVersion: predecessor.plan_version + 1,
      derivedFrom: predecessor.plan_id,
      steps: event.steps,
      roadmapNodeIds: event.roadmap_node_ids ?? predecessor.roadmap_node_ids,
      developmentMode: event.development_mode ?? predecessor.development_mode,
      origin: 'user_approved_revision',
      carriedForwardEvidence: carried,
    })
    if (successor.steps.length === 0) return state

    // The blocked predecessor is preserved, never edited in place: only its
    // lineage pointer is set.
    const plans = state.plans.map(item => (item.plan_id === predecessor.plan_id
      ? { ...item, superseded_by_plan_id: successor.plan_id, updated_at: now }
      : item))

    // Lineage is preserved; reasoning continuity is not. The successor is
    // planned from durable state, not from the argument for its predecessor.
    return withReasoningReset({
      ...state,
      sequence,
      plans: [...plans, successor],
      active_plan_id: successor.plan_id,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.USER_REVISION_APPROVED,
        at: now,
        plan_id: successor.plan_id,
        derived_from_plan_id: predecessor.plan_id,
        approved_by: text(event.approved_by, 128),
      }),
    }, { now, eventType: PLANNING_EVENT.USER_REVISION_APPROVED, reason: 'successor_plan_approved' })
  },

  [PLANNING_EVENT.PLAN_SUPERSEDED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan) return state
    if ([PLAN_STATUS.COMPLETED, PLAN_STATUS.CANCELLED, PLAN_STATUS.SUPERSEDED].includes(plan.status)) return state
    // Explicit user steering is an authority that may supersede the active plan
    // at any time. Nothing else may.
    if (!isUserAuthority(event.source)) return state
    const superseded = withStatus({
      ...plan,
      superseded_by_plan_id: text(event.successor_plan_id, 200) || plan.superseded_by_plan_id,
    }, PLAN_STATUS.SUPERSEDED, { now, reason: text(event.reason, 200) || 'user_steering' })
    // A set-aside plan must not keep steering the model's reasoning.
    return withReasoningReset({
      ...state,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? superseded : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_SUPERSEDED, at: now, plan_id: plan.plan_id }),
    }, { now, eventType: PLANNING_EVENT.PLAN_SUPERSEDED, reason: text(event.reason, 200) || 'user_steering' })
  },

  [PLANNING_EVENT.PLAN_CANCELLED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan) return state
    if ([PLAN_STATUS.COMPLETED, PLAN_STATUS.CANCELLED].includes(plan.status)) return state
    if (!isUserAuthority(event.source)) return state
    const cancelled = withStatus(plan, PLAN_STATUS.CANCELLED, { now, reason: text(event.reason, 200) || 'user_cancelled' })
    return withReasoningReset({
      ...state,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? cancelled : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_CANCELLED, at: now, plan_id: plan.plan_id }),
    }, { now, eventType: PLANNING_EVENT.PLAN_CANCELLED, reason: text(event.reason, 200) || 'user_cancelled' })
  },

  /**
   * Goal satisfaction is a separate, explicit event carrying its OWN evidence.
   *
   * Nothing in this module can produce it implicitly: not a completed plan, not
   * a realized shelf node, not a reached frontier, and never a continuous
   * frontier. Jev and the planner are excluded by the source allowlist.
   */
  [PLANNING_EVENT.GOAL_SATISFIED](state, event, now) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    if (text(event.goal_id, 120) && text(event.goal_id, 120) !== state.goal.goal_id) return state
    if (!isRuntimeAuthority(event.source) && !isUserAuthority(event.source)) return state
    // Its own evidence, distinct from the evidence that advanced any plan.
    const evidenceRefs = stringList(event.evidence_refs, { max: 32, maxLength: 200 })
    if (evidenceRefs.length === 0) return state
    return {
      ...state,
      goal: {
        ...state.goal,
        status: GOAL_STATUS.COMPLETED,
        updated_at: now,
        satisfied_at: now,
        satisfaction: {
          source: text(event.source, 60),
          evidence_refs: evidenceRefs,
          rationale: text(event.rationale, 400) || null,
          at: now,
        },
      },
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.GOAL_SATISFIED, at: now, goal_id: state.goal.goal_id }),
    }
  },
})

// --- persistence -----------------------------------------------------------

export function serializePlanningState(state) {
  const current = state ?? createEmptyPlanningState()
  return {
    version: PLANNING_STATE_VERSION,
    sequence: Number.isSafeInteger(current.sequence) ? current.sequence : 0,
    goal: clone(current.goal) ?? null,
    roadmap: clone(current.roadmap) ?? null,
    roadmap_history: clone(current.roadmap_history) ?? [],
    plans: clone(current.plans) ?? [],
    active_plan_id: current.active_plan_id ?? null,
    steering: clone(current.steering) ?? null,
    updated_at: finiteNumber(current.updated_at) ?? 0,
    reasoning_epoch: currentReasoningEpoch(current),
    last_reasoning_reset: clone(current.last_reasoning_reset) ?? null,
    log: clone(current.log) ?? [],
  }
}

function restorePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const planId = text(raw.plan_id, 200)
  const planVersion = Number.isSafeInteger(raw.plan_version) && raw.plan_version > 0 ? raw.plan_version : 1
  if (!planId) return undefined
  const status = PLAN_STATUSES.includes(raw.status) ? raw.status : PLAN_STATUS.DRAFT
  const steps = sanitizeSteps(raw.steps, { planId, planVersion })
  const stepIds = new Set(steps.map(step => step.step_id))
  const storedProgress = raw.execution?.step_progress ?? {}
  const progress = {}
  for (const step of steps) {
    const stored = storedProgress[step.step_id]
    const base = emptyStepProgress()
    progress[step.step_id] = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? {
          ...base,
          ...clone(stored),
          accepted_evidence: boundedList(stored.accepted_evidence, 32).map(item => clone(item)),
          failure_counts: { ...(stored.failure_counts ?? {}) },
        }
      : base
  }
  const plan = {
    plan_id: planId,
    plan_version: planVersion,
    goal_id: text(raw.goal_id, 120),
    roadmap_revision_id: text(raw.roadmap_revision_id, 120) || null,
    roadmap_node_ids: stringList(raw.roadmap_node_ids, { max: 16, maxLength: 120 }),
    development_mode: DEVELOPMENT_MODES.includes(raw.development_mode) ? raw.development_mode : 'maintain',
    refinement_grounding: raw.refinement_grounding && typeof raw.refinement_grounding === 'object' && !Array.isArray(raw.refinement_grounding)
      ? {
          ready_node_ids: stringList(raw.refinement_grounding.ready_node_ids, { max: 16, maxLength: 120 }),
          not_ready: boundedList(raw.refinement_grounding.not_ready, 16).map(item => clone(item)),
        }
      : { ready_node_ids: [], not_ready: [] },
    steering_at_draft: raw.steering_at_draft && DEVELOPMENT_MODES.includes(raw.steering_at_draft.mode)
      ? {
          mode: raw.steering_at_draft.mode,
          steering_sequence: Number.isSafeInteger(raw.steering_at_draft.steering_sequence) ? raw.steering_at_draft.steering_sequence : 0,
          critical_path: text(raw.steering_at_draft.critical_path, 300) || null,
          diverges_from_steering: raw.steering_at_draft.diverges_from_steering === true,
        }
      : null,
    status,
    steps,
    active_step_index: Number.isSafeInteger(raw.active_step_index)
      ? Math.max(0, Math.min(raw.active_step_index, Math.max(0, steps.length - 1)))
      : 0,
    derived_from_plan_id: text(raw.derived_from_plan_id, 200) || null,
    superseded_by_plan_id: text(raw.superseded_by_plan_id, 200) || null,
    origin: text(raw.origin, 80) || 'restored',
    created_at: finiteNumber(raw.created_at) ?? 0,
    updated_at: finiteNumber(raw.updated_at) ?? 0,
    committed_at: finiteNumber(raw.committed_at) ?? null,
    completed_at: finiteNumber(raw.completed_at) ?? null,
    blocker: clone(raw.blocker) ?? null,
    execution: {
      step_progress: progress,
      batches_attempted: Number.isSafeInteger(raw.execution?.batches_attempted) ? raw.execution.batches_attempted : 0,
    },
    jev_review: clone(raw.jev_review) ?? { refinement_count: 0, last_reason_codes: [], last_verdict: null, last_reviewed_at: null },
    advisory: clone(raw.advisory) ?? { planner_focus_step_id: null, planner_focus_at: null, steering_note: null },
    carried_forward_evidence: stringList(raw.carried_forward_evidence, { max: 64, maxLength: 200 }),
    lifecycle: boundedList(raw.lifecycle, 64).map(item => clone(item)),
  }
  if (raw.runtime_validation) plan.runtime_validation = clone(raw.runtime_validation)
  if (stepIds.size !== steps.length) return undefined
  // Restored committed content must be frozen again, or a restart would quietly
  // reopen an immutable plan to mutation.
  if (IMMUTABLE_STATUSES.includes(status)) freezeCommittedPlan(plan)
  return plan
}

function restoreRoadmap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const revisionId = text(raw.roadmap_revision_id, 120)
  if (!revisionId) return null
  // `trusted`: these statuses were derived by this module from verified
  // evidence before they were persisted. A restart must not silently demote
  // realized shelf lineage back to tentative.
  const nodes = boundedList(raw.nodes, 64)
    .map((node, index) => sanitizeShelfNode(node, { sequence: index + 1, trusted: true }))
    .filter(Boolean)
  return {
    roadmap_revision_id: revisionId,
    goal_id: text(raw.goal_id, 120),
    revision_index: Number.isSafeInteger(raw.revision_index) ? raw.revision_index : 1,
    derived_from_revision_id: text(raw.derived_from_revision_id, 120) || null,
    reason: text(raw.reason, 300),
    authority: text(raw.authority, 60) || null,
    evidence_refs: stringList(raw.evidence_refs, { max: 16, maxLength: 200 }),
    created_at: finiteNumber(raw.created_at) ?? 0,
    nodes,
    ...(raw.deferred_for_coarseness ? { deferred_for_coarseness: clone(raw.deferred_for_coarseness) } : {}),
  }
}

/**
 * Restore the advisory steering record. Everything is re-validated: a
 * hand-edited snapshot cannot inject a mode outside the allowlist, and cannot
 * pre-load hysteresis with a bogus slice count.
 */
function restoreSteering(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const mode = DEVELOPMENT_MODES.includes(raw.current_mode) ? raw.current_mode : null
  if (!mode) return null
  const userPriority = raw.user_priority && DEVELOPMENT_MODES.includes(raw.user_priority.mode)
    ? {
        mode: raw.user_priority.mode,
        set_by: text(raw.user_priority.set_by, 128) || 'user',
        at: finiteNumber(raw.user_priority.at) ?? 0,
      }
    : null
  const recommendation = raw.recommendation && typeof raw.recommendation === 'object' && !Array.isArray(raw.recommendation)
    ? {
        recommended_by: text(raw.recommendation.recommended_by, 60) || null,
        recommended_mode: DEVELOPMENT_MODES.includes(raw.recommendation.recommended_mode) ? raw.recommendation.recommended_mode : null,
        confidence: clamp01(raw.recommendation.confidence),
        reason_codes: stringList(raw.recommendation.reason_codes, { max: 8, maxLength: 80 }),
        candidate_shelf_nodes: stringList(raw.recommendation.candidate_shelf_nodes, { max: 5, maxLength: 120 }),
      }
    : { recommended_by: null, recommended_mode: null, confidence: 0, reason_codes: [], candidate_shelf_nodes: [] }
  return {
    current_mode: mode,
    previous_mode: DEVELOPMENT_MODES.includes(raw.previous_mode) ? raw.previous_mode : null,
    reason: text(raw.reason, 400) || null,
    critical_path: text(raw.critical_path, 300) || null,
    pressure: sanitizeSteeringPressure(raw.pressure),
    dropped_pressure: stringList(raw.dropped_pressure, { max: 12, maxLength: 200 }),
    last_plan_id: text(raw.last_plan_id, 200) || null,
    last_directional_mode: DIRECTIONAL_MODES.includes(raw.last_directional_mode) ? raw.last_directional_mode : null,
    consecutive_mode_slices: Number.isSafeInteger(raw.consecutive_mode_slices) && raw.consecutive_mode_slices >= 0
      ? raw.consecutive_mode_slices
      : 0,
    hysteresis_applied: raw.hysteresis_applied === true,
    hold_reasons: stringList(raw.hold_reasons, { max: 8, maxLength: 80 }),
    proposed_mode: DEVELOPMENT_MODES.includes(raw.proposed_mode) ? raw.proposed_mode : null,
    forced_by_user: raw.forced_by_user === true,
    recommendation,
    user_priority: userPriority,
    boundary: STEERING_BOUNDARIES.includes(raw.boundary) ? raw.boundary : null,
    authority: text(raw.authority, 60) || null,
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence > 0 ? raw.sequence : 1,
    updated_at: finiteNumber(raw.updated_at) ?? 0,
    history: boundedList(raw.history, 32)
      .filter(entry => entry && typeof entry === 'object' && DEVELOPMENT_MODES.includes(entry.mode))
      .map(entry => ({
        mode: entry.mode,
        boundary: STEERING_BOUNDARIES.includes(entry.boundary) ? entry.boundary : null,
        at: finiteNumber(entry.at) ?? 0,
        plan_id: text(entry.plan_id, 200) || null,
        changed: entry.changed === true,
        hysteresis_applied: entry.hysteresis_applied === true,
        hold_reasons: stringList(entry.hold_reasons, { max: 8, maxLength: 80 }),
      })),
  }
}

export function restorePlanningState(raw) {
  const empty = createEmptyPlanningState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const goal = sanitizeGoal(raw.goal)
  if (!goal) return empty
  const plans = boundedList(raw.plans, 64).map(restorePlan).filter(Boolean)
  const activePlanId = text(raw.active_plan_id, 200)
  return {
    version: PLANNING_STATE_VERSION,
    sequence: Number.isSafeInteger(raw.sequence) ? raw.sequence : plans.length,
    goal,
    roadmap: restoreRoadmap(raw.roadmap),
    roadmap_history: boundedList(raw.roadmap_history, 32).map(restoreRoadmap).filter(Boolean),
    plans,
    active_plan_id: plans.some(plan => plan.plan_id === activePlanId) ? activePlanId : null,
    steering: restoreSteering(raw.steering),
    updated_at: finiteNumber(raw.updated_at) ?? 0,
    // Reasoning epochs are durable: a restart must not look like a reset, and
    // must not silently re-use an epoch the loop has already reasoned under.
    reasoning_epoch: currentReasoningEpoch(raw),
    last_reasoning_reset: raw.last_reasoning_reset && typeof raw.last_reasoning_reset === 'object' && !Array.isArray(raw.last_reasoning_reset)
      ? {
          epoch: Number.isSafeInteger(raw.last_reasoning_reset.epoch) ? raw.last_reasoning_reset.epoch : currentReasoningEpoch(raw),
          at: finiteNumber(raw.last_reasoning_reset.at) ?? 0,
          event_type: text(raw.last_reasoning_reset.event_type, 80),
          reason: text(raw.last_reasoning_reset.reason, 200) || null,
        }
      : null,
    log: boundedList(raw.log, 256).map(item => clone(item)),
  }
}
