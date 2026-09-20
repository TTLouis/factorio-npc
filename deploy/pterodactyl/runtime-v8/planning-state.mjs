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

export const DEVELOPMENT_MODES = Object.freeze(['vertical', 'horizontal', 'maintain', 'recover'])

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

// --- events ----------------------------------------------------------------

export const PLANNING_EVENT = Object.freeze({
  GOAL_ACCEPTED: 'GOAL_ACCEPTED',
  ROADMAP_REVISED: 'ROADMAP_REVISED',
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
  USER_REVISION_APPROVED: 'USER_REVISION_APPROVED',
  PLAN_SUPERSEDED: 'PLAN_SUPERSEDED',
  PLAN_CANCELLED: 'PLAN_CANCELLED',
})

const PLANNING_EVENT_TYPES = Object.freeze(Object.values(PLANNING_EVENT))

// Sources permitted to advance authoritative progress. The planner (Main LLM)
// and Jev are deliberately absent.
const EVIDENCE_AUTHORITIES = Object.freeze(['runtime', 'autorio', 'runtime_receipt'])
const USER_AUTHORITIES = Object.freeze(['user', 'human', 'user_steering'])

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
  let hash = 0x811c9dc5
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
  return {
    goal_id: goalId,
    owner: text(raw.owner, 128) || 'unknown',
    objective: text(raw.objective, 1000),
    constraints: stringList(raw.constraints, { max: 24, maxLength: 300 }),
    status: Object.values(GOAL_STATUS).includes(raw.status) ? raw.status : GOAL_STATUS.ACTIVE,
    created_at: finiteNumber(raw.created_at) ?? 0,
    updated_at: finiteNumber(raw.updated_at) ?? finiteNumber(raw.created_at) ?? 0,
  }
}

/**
 * Sanitize one Roadmap Shelf node. Shelf nodes are storage only: they carry
 * intent and lineage, never operations, never step contracts.
 */
export function sanitizeShelfNode(raw, { sequence = 0 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const intent = text(raw.intent, 400)
  if (!intent) return undefined
  const id = text(raw.id, 120) || `node_${sequence}_${fingerprint(intent)}`
  const developmentHint = DEVELOPMENT_MODES.includes(raw.development_hint) ? raw.development_hint : undefined
  return {
    id,
    intent,
    why_it_matters: text(raw.why_it_matters, 400),
    status: SHELF_NODE_STATUSES.includes(raw.status) ? raw.status : SHELF_NODE_STATUS.TENTATIVE,
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
    updated_at: 0,
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

function createRoadmapRevision(state, { now, nodes, reason, sequence }) {
  const previous = state.roadmap
  const revisionId = `${state.goal.goal_id}_r${sequence}`
  const previousById = new Map((previous?.nodes ?? []).map(node => [node.id, node]))
  const incoming = []
  const seen = new Set()

  boundedList(nodes, 64).forEach((raw, index) => {
    const node = sanitizeShelfNode(raw, { sequence: `${sequence}_${index + 1}` })
    if (!node || seen.has(node.id)) return
    seen.add(node.id)
    const prior = previousById.get(node.id)
    incoming.push({
      ...node,
      // lineage preservation: results and plan links survive revisions.
      resolved_by: Array.from(new Set([...(prior?.resolved_by ?? []), ...node.resolved_by])),
      verified_results: Array.from(new Set([...(prior?.verified_results ?? []), ...node.verified_results])),
      first_seen_revision_id: prior?.first_seen_revision_id ?? node.first_seen_revision_id ?? revisionId,
      derived_from_node_id: prior ? prior.id : node.derived_from_node_id,
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

  return {
    roadmap_revision_id: revisionId,
    goal_id: state.goal.goal_id,
    revision_index: (previous?.revision_index ?? 0) + 1,
    derived_from_revision_id: previous?.roadmap_revision_id ?? null,
    reason: text(reason, 300),
    created_at: now,
    nodes: incoming,
  }
}

function attachPlanResultsToShelf(roadmap, { nodeIds, planId, results, status }) {
  if (!roadmap) return roadmap
  const targets = new Set(nodeIds ?? [])
  if (targets.size === 0) return roadmap
  return {
    ...roadmap,
    nodes: roadmap.nodes.map(node => (targets.has(node.id)
      ? {
          ...node,
          status,
          resolved_by: Array.from(new Set([...node.resolved_by, planId])),
          verified_results: Array.from(new Set([...node.verified_results, ...stringList(results, { max: 32, maxLength: 300 })])).slice(0, 64),
        }
      : node)),
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
  const progress = {}
  sanitizedSteps.forEach((step, index) => {
    progress[step.step_id] = { ...emptyStepProgress(), status: index === 0 ? 'active' : 'pending' }
  })
  return {
    plan_id: planId,
    plan_version: planVersion,
    goal_id: state.goal.goal_id,
    roadmap_revision_id: state.roadmap?.roadmap_revision_id ?? null,
    roadmap_node_ids: stringList(roadmapNodeIds, { max: 16, maxLength: 120 }),
    development_mode: DEVELOPMENT_MODES.includes(developmentMode) ? developmentMode : 'maintain',
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

const HANDLERS = {
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
    return {
      ...fresh,
      sequence,
      goal,
      updated_at: now,
      log: logEntry(fresh, { type: PLANNING_EVENT.GOAL_ACCEPTED, at: now, goal_id: goal.goal_id }),
    }
  },

  [PLANNING_EVENT.ROADMAP_REVISED](state, event, now) {
    if (!state.goal) return state
    const sequence = nextSequence(state)
    const roadmap = createRoadmapRevision(state, {
      now,
      sequence,
      nodes: event.nodes,
      reason: event.reason,
    })
    return {
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
        derived_from_node_id: undefined,
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

    if (tailNodes.length > 0 && state.goal) {
      const sequence = nextSequence(next)
      const merged = [...(next.roadmap?.nodes ?? []), ...tailNodes]
      const roadmap = createRoadmapRevision(next, {
        now,
        sequence,
        nodes: merged,
        reason: text(event.reason ?? 'deferred_tail_from_jev_refine', 300),
      })
      next = {
        ...next,
        sequence,
        roadmap,
        roadmap_history: [...boundedList(next.roadmap_history, 31), ...(next.roadmap ? [next.roadmap] : [])].slice(-32),
      }
    }

    return {
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
    // Attach verified results back to shelf lineage before the next round.
    const roadmap = attachPlanResultsToShelf(state.roadmap, {
      nodeIds: plan.roadmap_node_ids,
      planId: plan.plan_id,
      results: event.verified_results,
      status: SHELF_NODE_STATUS.REALIZED,
    })
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
    if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return state
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

    return {
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
    }
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
    return {
      ...state,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? superseded : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_SUPERSEDED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.PLAN_CANCELLED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan) return state
    if ([PLAN_STATUS.COMPLETED, PLAN_STATUS.CANCELLED].includes(plan.status)) return state
    if (!isUserAuthority(event.source)) return state
    const cancelled = withStatus(plan, PLAN_STATUS.CANCELLED, { now, reason: text(event.reason, 200) || 'user_cancelled' })
    return {
      ...state,
      plans: state.plans.map(item => (item.plan_id === plan.plan_id ? cancelled : item)),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.PLAN_CANCELLED, at: now, plan_id: plan.plan_id }),
    }
  },
}

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
    updated_at: finiteNumber(current.updated_at) ?? 0,
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
  const nodes = boundedList(raw.nodes, 64)
    .map((node, index) => sanitizeShelfNode(node, { sequence: index + 1 }))
    .filter(Boolean)
  return {
    roadmap_revision_id: revisionId,
    goal_id: text(raw.goal_id, 120),
    revision_index: Number.isSafeInteger(raw.revision_index) ? raw.revision_index : 1,
    derived_from_revision_id: text(raw.derived_from_revision_id, 120) || null,
    reason: text(raw.reason, 300),
    created_at: finiteNumber(raw.created_at) ?? 0,
    nodes,
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
    updated_at: finiteNumber(raw.updated_at) ?? 0,
    log: boundedList(raw.log, 256).map(item => clone(item)),
  }
}
