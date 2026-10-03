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
//     Jev output is advisory and cannot advance authoritative progress.
//   * A deadlock or structural blocker FREEZES the plan as BLOCKED. There is no
//     code path from BLOCKED to automatic replanning OUTSIDE a current
//     authorization grant (MW1, authorization.mjs): inside a grant the harness
//     may request a replacement that keeps the requested result.
//   * A successor plan (plan_version + 1) exists only via USER_REVISION_APPROVED
//     or, within a current grant, REPLACEMENT_PLAN_REQUESTED (runtime authority
//     only; the grant is checked again at commit and at operation admission).
//   * The Roadmap Shelf is storage only. No export turns a shelf node into
//     operations or into plan steps.

import { completionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'
import { needsGoalBaseline, restoreGoalDefinition, sanitizeGoalDefinition } from './goal-definition.mjs'
import {
  authorizationHasContent,
  authorizationOf,
  carryAuthorizationAcrossGoals,
  checkReplacementAtCommit,
  classifyReplacement,
  consumeApproval,
  grantAuthorization,
  raiseQuestion,
  recordApproval,
  recordNpcPlacement,
  recordRefusal,
  recordReservation,
  releaseReservation,
  replacementLineage,
  replacementStepsFingerprint,
  REPLACEMENT_DECISION,
  restoreAuthorization,
  reviseAuthorization,
  revokeAuthorization,
  serializeAuthorization,
} from './authorization.mjs'
import { sanitizePendingOperation } from './operation-reconciliation.mjs'
import { operationLedger, recordOperation, settleOperation } from './operation-ledger.mjs'
import {
  addTask,
  carryTaskLedger,
  closeTask,
  findTask,
  mostRecentResumable,
  restoreTaskLedger,
  sanitizeTask,
  serializeTaskLedger,
  taskIdFor,
  taskLedgerHasContent,
  taskLedgerOf,
  taskRunnable,
  TASK_CLOSE,
  TASK_INTERRUPTION,
  TASK_LEDGER_LIMITS,
  TASK_LEDGER_REFUSAL,
  TASK_STATE_AT_INTERRUPTION,
  TASK_STATUS,
} from './task-ledger.mjs'

export const PLANNING_STATE_VERSION = 1

// --- lifecycle (roadmap section 5) -----------------------------------------

export const PLAN_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
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
    // The one horizontal code the steering state can show today: the roadmap
    // itself marks the next ready node as support work.
    'shelf_support_node_ready',
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

// What each pressure means in game terms, and which facts in the steering
// state could show it. Jev is a general-purpose judge: it can weigh supplied
// facts, but it cannot be expected to know Factorio mechanics or to see world
// state it was not given. A pressure is therefore asked only when the state
// carries every fact it requires; a pressure whose facts the runtime does not
// gather yet is not asked at all.
export const STEERING_PRESSURE_EVIDENCE = Object.freeze({
  throughput_starved: { definition: 'A production line makes less than what consumes its output needs.', requires: ['production'] },
  input_buffer_starved: { definition: 'Machine input slots or input chests are empty or nearly empty.', requires: ['production'] },
  output_backed_up: { definition: 'Machine outputs or output belts are full, so machines stop working.', requires: ['production'] },
  machine_idle_no_input: { definition: 'Placed machines are idle because an ingredient or fuel is missing.', requires: ['production'] },
  machine_idle_no_power: { definition: 'Placed electric machines are idle because they have no power.', requires: ['power'] },
  power_deficit: { definition: 'Electric demand is higher than generation.', requires: ['power'] },
  power_margin_low: { definition: 'Electric generation only barely covers demand.', requires: ['power'] },
  resource_patch_depleting: { definition: 'A resource patch that is being mined is running out.', requires: ['resources'] },
  logistics_bottleneck: { definition: 'Belts, inserters, or other transport limit a production line.', requires: ['logistics'] },
  repeated_manual_topup: { definition: 'The NPC has repeatedly hand-delivered the same items to keep something running.', requires: ['operation_history'] },
  defense_margin_low: { definition: 'Defenses are too weak for the enemy pressure nearby.', requires: ['defense'] },
  frontier_reached: { definition: 'Every Roadmap Shelf node that current capability allows is done; progress now needs a new capability.', requires: ['roadmap'] },
  capability_absent: { definition: 'The goal needs a building, recipe, or technology that save_progress shows this save does not have yet.', requires: ['save_progress'] },
  technology_blocked_missing_science: { definition: 'A needed research cannot start because its science packs are not being produced.', requires: ['research'] },
  recipe_locked_missing_technology: { definition: 'A needed recipe is locked behind technology that is not researched.', requires: ['research'] },
  required_item_uncraftable: { definition: 'A needed item cannot be crafted with the recipes and materials available.', requires: ['recipes'] },
  shelf_support_node_ready: { definition: 'A Roadmap Shelf node marked development_hint "horizontal" has its dependencies met, so the next slice widens or stabilizes what exists.', requires: ['roadmap'] },
  shelf_node_ready_to_refine: { definition: 'A Roadmap Shelf node has its dependencies met and can be planned in detail next.', requires: ['roadmap'] },
  goal_requires_new_capability: { definition: 'Finishing the goal from this save needs a capability that save_progress shows is not unlocked yet.', requires: ['save_progress'] },
  surplus_unconsumed: { definition: 'Some output keeps piling up with nothing consuming it.', requires: ['production'] },
})

// Facts the steering state can carry today. Add a detector here when the
// runtime starts gathering a new fact, and the pressures that need it start
// being asked automatically.
const STEERING_STATE_FACTS = Object.freeze({
  roadmap: state => Array.isArray(state?.roadmap?.nodes) && state.roadmap.nodes.length > 0,
  save_progress: state => Boolean(state?.save_progress) && typeof state.save_progress === 'object',
})

export function askableSteeringPressures(state) {
  const present = new Set(Object.entries(STEERING_STATE_FACTS)
    .filter(([, detect]) => detect(state))
    .map(([fact]) => fact))
  const askable = code => STEERING_PRESSURE_EVIDENCE[code]?.requires.every(fact => present.has(fact)) === true
  return {
    horizontal: STEERING_PRESSURE_VOCABULARY.horizontal.filter(askable),
    vertical: STEERING_PRESSURE_VOCABULARY.vertical.filter(askable),
  }
}

export function steeringPressureDefinitions() {
  return Object.fromEntries(Object.entries(STEERING_PRESSURE_EVIDENCE).map(([code, entry]) => [code, entry.definition]))
}

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
  // The system's structured understanding of the goal (scope + game-checkable
  // done_when conditions). Authored once by the Main LLM on the goal's first
  // plan; only the user may replace it afterwards.
  GOAL_DEFINED: 'GOAL_DEFINED',
  // Where each goal_start counter (rockets launched, items produced) stood
  // when the goal started, read from the game by the runtime. Fills missing
  // baselines only; a recorded baseline never moves.
  GOAL_BASELINES_RECORDED: 'GOAL_BASELINES_RECORDED',
  // Run state (3.3 move 3). The goal's run is paused or running; a pause never
  // touches plan semantics, the active step or approval state.
  RUN_PAUSED: 'RUN_PAUSED',
  RUN_RESUMED: 'RUN_RESUMED',
  // Single-writer runtime fields. null clears the field.
  CONDITION_WAIT_RECORDED: 'CONDITION_WAIT_RECORDED',
  PROVIDER_RECOVERY_RECORDED: 'PROVIDER_RECOVERY_RECORDED',
  PERSISTENT_RUNTIME_RECORDED: 'PERSISTENT_RUNTIME_RECORDED',
  // Entity locators and exact-identity proofs the runtime needs for recovery
  // (3.3 move 4): durable last operations, the exact-target audit, and the set
  // of unit_numbers the world proved gone.
  LOCATORS_RECORDED: 'LOCATORS_RECORDED',
  // Per-plan, per-step ledger of operation receipts (3.3 move 2). The reducer
  // is the writer; `task_board.evidence` is a mirror of it until Phase 8.
  OPERATION_RECEIPT_RECORDED: 'OPERATION_RECEIPT_RECORDED',
  // Ledger record that a role's conversation was restaged from a handoff
  // packet (3.3 move 6). It has NO plan effect and is separate from
  // `reasoning_epoch`: the planning agent's context is meant to stay long
  // lived, and restaging mostly targets executor subagents.
  CONTEXT_RESTAGED: 'CONTEXT_RESTAGED',
  // MW1 authorization (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 2). Grants and approvals come only
  // from runtime (harness-verified mandate) or user authority; never from the planner or Jev.
  AUTHORIZATION_GRANTED: 'AUTHORIZATION_GRANTED',
  AUTHORIZATION_REVISED: 'AUTHORIZATION_REVISED',
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  // A replacement for a BLOCKED plan: accepted inside a current grant (creates a DRAFT successor with lineage),
  // raised as an approval question when it would leave the grant (the old plan stays frozen), or refused.
  REPLACEMENT_PLAN_REQUESTED: 'REPLACEMENT_PLAN_REQUESTED',
  AUTHORIZATION_APPROVAL_RECORDED: 'AUTHORIZATION_APPROVAL_RECORDED',
  // World facts that outlive a goal: NPC placement receipts and reserved containers.
  NPC_PLACEMENT_RECORDED: 'NPC_PLACEMENT_RECORDED',
  RESERVATION_RECORDED: 'RESERVATION_RECORDED',
  RESERVATION_RELEASED: 'RESERVATION_RELEASED',
  // MW2 durable task ledger (task-ledger.mjs). An interruption MOVES the running goal into the ledger (the planning state
  // becomes goalless, keeping the world facts and the ledger); a resume moves a ledger task back, restoring its committed
  // plan and verified progress from the checkpoint. Runtime or user authority only: never the planner or Jev.
  TASK_INTERRUPTED: 'TASK_INTERRUPTED',
  TASK_QUEUED: 'TASK_QUEUED',
  TASK_RESUMED: 'TASK_RESUMED',
  TASK_CANCELLED: 'TASK_CANCELLED',
  // MW2b: the one operation batch the runtime may have in flight (operation-reconciliation.mjs). Written before a batch is sent,
  // updated by reconciliation, cleared (operation null) when its receipt settles it. Runtime sources only.
  PENDING_OPERATION_RECORDED: 'PENDING_OPERATION_RECORDED',
})

const PLANNING_EVENT_TYPES = Object.freeze(Object.values(PLANNING_EVENT))

// Runtime sources own deterministic facts. The Main LLM has one narrower
// authority: it may close a prose-only step semantically when the claim is
// explicitly bound to the active step and grounded in runtime evidence.
const EVIDENCE_AUTHORITIES = Object.freeze(['runtime', 'autorio', 'runtime_receipt'])
const SEMANTIC_COMPLETION_AUTHORITIES = Object.freeze(['main_planner'])
const USER_AUTHORITIES = Object.freeze(['user', 'human', 'user_steering'])
// Who may write run state. Not the Main LLM and not Jev: pausing, waiting and
// provider recovery are harness/operator facts. `legacy_adopted` marks a
// value seeded once from a pre-reducer snapshot or legacy record.
const RUN_EVENT_SOURCES = Object.freeze([...EVIDENCE_AUTHORITIES, ...USER_AUTHORITIES, 'server_lifecycle', 'legacy_adopted'])

export const RUN_STATE_LIMITS = Object.freeze({
  pauseReason: 300,
  pauseCode: 80,
  valueDepth: 6,
  valueString: 1200,
  valueKeys: 64,
  valueItems: 32,
  durableOperations: 16,
  exactTargetAudit: 32,
  staleIdentities: 256,
})

// Receipt ledger bounds (3.3 move 2). Summaries are short, machine-derived
// digests: the full receipt text stays in the board mirror, never here.
export const RECEIPT_LEDGER_LIMITS = Object.freeze({
  perStep: 24,
  closedPlanPerStep: 4,
  summary: 240,
  kind: 64,
  ref: 160,
  batchId: 80,
})

// Context restage log (3.3 move 6).
export const CONTEXT_RESTAGE_LIMITS = Object.freeze({
  entries: 32,
  reason: 200,
})
export const CONTEXT_RESTAGE_ROLES = Object.freeze(['planner', 'executor'])
export const CONTEXT_RESTAGE_CHECKPOINTS = Object.freeze(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'])

// Harness sources only. The Main LLM and Jev never write receipts or restages.
const RECEIPT_EVENT_SOURCES = Object.freeze([...EVIDENCE_AUTHORITIES, 'legacy_adopted'])
const RESTAGE_EVENT_SOURCES = Object.freeze([...EVIDENCE_AUTHORITIES, 'server_lifecycle'])

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
  // the plan was set aside, replaced or abandoned
  PLANNING_EVENT.PLAN_SUPERSEDED,
  PLANNING_EVENT.USER_REVISION_APPROVED,
  PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED,
  PLANNING_EVENT.PLAN_CANCELLED,
  // the running task moved into the ledger, or a ledger task came back as the running one
  PLANNING_EVENT.TASK_INTERRUPTED,
  PLANNING_EVENT.TASK_RESUMED,
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

// Rolling histories keep the most RECENT entries. boundedList keeps the oldest,
// which silently froze every rolling log once it filled and, on restore, dropped
// the newest (active) plan of any goal that ran past the plan cap.
function recentList(value, max) {
  return Array.isArray(value) ? value.slice(-max) : []
}

/**
 * JSON-safe, size-bounded copy of an opaque runtime record (condition wait,
 * provider recovery, follow status, locators). The reducer stores what the
 * runtime hands it, but never more than these limits, and never anything that
 * would not survive a JSON round trip.
 */
function boundedJson(value, depth = RUN_STATE_LIMITS.valueDepth) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, RUN_STATE_LIMITS.valueString)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (depth <= 0) return null
  if (Array.isArray(value)) return value.slice(0, RUN_STATE_LIMITS.valueItems).map(item => boundedJson(item, depth - 1))
  if (typeof value !== 'object') return null
  const out = {}
  for (const [key, inner] of Object.entries(value).slice(0, RUN_STATE_LIMITS.valueKeys)) {
    if (inner === undefined || typeof inner === 'function' || typeof inner === 'symbol') continue
    out[String(key).slice(0, 80)] = boundedJson(inner, depth - 1)
  }
  return out
}

function boundedRecord(value) {
  const bounded = value && typeof value === 'object' && !Array.isArray(value) ? boundedJson(value) : null
  return bounded && Object.keys(bounded).length > 0 ? bounded : null
}

function pauseCodeOf(reason) {
  return text(String(reason ?? '').split(':')[0], RUN_STATE_LIMITS.pauseCode)
}

export function createEmptyRunState() {
  return {
    paused: false,
    pause_reason: '',
    pause_code: '',
    paused_at: null,
    resumed_at: null,
    pause_count: 0,
    condition_wait: null,
    provider_recovery: null,
    persistent_runtime: null,
    // MW2b: the operation batch sent but not yet settled by a receipt (operation-reconciliation.mjs).
    pending_operation: null,
    // Entity locators and exact-identity proofs the runtime needs for
    // recovery (3.3 move 4).
    locators: { durable_last_operations: [], exact_target_audit: [] },
    stale_exact_identities: [],
    updated_at: 0,
  }
}

// A long goal (e.g. a rocket launch) commits many plan slices. Keep a bounded
// recent window, never dropping the active plan; lineage lookups of pruned
// plans already resolve to undefined.
export const MAX_RETAINED_PLANS = 64

function retainPlans(plans, activePlanId) {
  if (!Array.isArray(plans)) return []
  if (plans.length <= MAX_RETAINED_PLANS) return plans
  const recent = plans.slice(-MAX_RETAINED_PLANS)
  if (!activePlanId || recent.some(plan => plan?.plan_id === activePlanId)) return recent
  const active = plans.find(plan => plan?.plan_id === activePlanId)
  return active ? [active, ...recent.slice(1)] : recent
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
  const definition = restoreGoalDefinition(raw.definition)
  return {
    goal_id: goalId,
    ...(satisfaction ? { satisfaction, satisfied_at: finiteNumber(raw.satisfied_at) ?? satisfaction.at } : {}),
    ...(definition ? { definition } : {}),
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
    // Run state (pause, condition wait, provider recovery, follow runtime,
    // locators). null until the first run event: an old snapshot restores to
    // null and the memory facade seeds it once from the legacy record.
    run: null,
    // Bounded log of context restages (3.3 move 6). Ledger only: nothing here
    // is read by plan, step or epoch logic.
    context_restages: [],
    log: [],
  }
}

function nextSequence(state) {
  return (Number.isSafeInteger(state.sequence) ? state.sequence : 0) + 1
}

function logEntry(state, entry) {
  return [...recentList(state.log, 255), entry]
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
          // Divergence from advisory steering is recorded, not enforced.
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
    // `receipts`: bounded per-step ledger (3.3 move 2). A new plan has nothing
    // to adopt from a legacy board, so it starts seeded.
    execution: { step_progress: progress, batches_attempted: 0, receipts: {}, receipts_seeded: true },
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
    lifecycle: [...recentList(plan.lifecycle, 63), { status, at: now, reason: text(reason, 200) }],
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
  const linkedNodeIds = new Set(plan?.roadmap_node_ids ?? [])
  const roadmapShelf = boundedList(state?.roadmap?.nodes, 32).map(node => ({
    id: node.id,
    intent: node.intent,
    why_it_matters: node.why_it_matters,
    status: node.status,
    depends_on: [...node.depends_on],
    development_hint: node.development_hint,
    linked: linkedNodeIds.has(node.id),
  }))
  if (!plan) {
    return deepFreeze({
      kind: 'plan_tracker_view',
      goal_id: state?.goal?.goal_id ?? null,
      goal_status: state?.goal?.status ?? null,
      roadmap_revision_id: state?.roadmap?.roadmap_revision_id ?? null,
      roadmap_shelf: roadmapShelf,
      plan_id: null,
      steps: [],
    })
  }
  return deepFreeze({
    kind: 'plan_tracker_view',
    goal_id: plan.goal_id,
    goal_status: state?.goal?.status ?? null,
    roadmap_revision_id: plan.roadmap_revision_id,
    roadmap_shelf: roadmapShelf,
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
    recommendation: clone(record?.recommendation) ?? null,
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

function isSemanticCompletionAuthority(source) {
  return SEMANTIC_COMPLETION_AUTHORITIES.includes(text(source, 60))
}

function isUserAuthority(source) {
  return USER_AUTHORITIES.includes(text(source, 60))
}

// MW1: grants, approvals and reservations are consent. Only the user (or the harness acting for a verified mandate) gives
// them; `user_steering` (a steering nudge, not consent) does not.
function isConsentAuthority(source) {
  return ['user', 'human'].includes(text(source, 60))
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
  // The committed plan content is frozen. Main-LLM semantic completion is a
  // progress decision about a prose-only step, never a mutation of that content.
  deepFreeze(plan.steps)
  deepFreeze(plan.roadmap_node_ids)
  // The lineage a replacement committed under is as immutable as its steps.
  if (plan.replacement) deepFreeze(plan.replacement)
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
  // Operation identity is campaign state. A fresh goal or historical task checkpoint must never replace it.
  if (next && next !== current && type !== PLANNING_EVENT.PENDING_OPERATION_RECORDED
    && (current.operation_ledger || current.run?.pending_operation)) {
    const ledger = operationLedger(current.operation_ledger, current.run?.pending_operation)
    return { ...next, operation_ledger: ledger,
      ...(next.run ? { run: { ...next.run, pending_operation: ledger.records.at(-1) ?? null } } : {}) }
  }
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
    // World facts (NPC placement receipts, reserved containers) outlive a goal;
    // the previous goal's grants, questions and approvals do not.
    const carriedAuthorization = carryAuthorizationAcrossGoals(state.authorization)
    // MW2: the task ledger is not goal-scoped either; a new goal never drops an interrupted or queued task.
    const carriedLedger = carryTaskLedger(state.task_ledger)
    // The epoch is monotonic across the process lifetime, so it carries over
    // from the abandoned goal rather than restarting at 0.
    return withReasoningReset({
      ...fresh,
      ...(carriedAuthorization ? { authorization: carriedAuthorization } : {}),
      ...(carriedLedger ? { task_ledger: carriedLedger } : {}),
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
      roadmap_history: [...recentList(state.roadmap_history, 31), ...(state.roadmap ? [state.roadmap] : [])].slice(-32),
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
      history: [...recentList(record?.history, 31), entry],
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
    // Re-authoring or checkpoint-refreshing a PRE-COMMIT draft is still the
    // same successor attempt. USER_REVISION_APPROVED is the only transition
    // allowed to CREATE successor lineage; DRAFT_CREATED may only PRESERVE
    // lineage that already exists on the mutable draft it replaces.
    const replacedDraft = getActivePlan(state)
    const inheritedLineage = replacedDraft && PRE_COMMIT_STATUSES.includes(replacedDraft.status)
      ? replacedDraft
      : undefined
    // Attaching a newly grounded completion contract to an unreviewed draft is
    // an edit of that draft, not a new authoring attempt. Minting a successor
    // here left a throwaway SUPERSEDED record on every first commit and two per
    // refinement pass, so plan ids and the tracker churned for one submission.
    const inPlaceSequence = event.origin === 'checkpoint_contract_refresh' && inheritedLineage
      ? Number(inheritedLineage.plan_id.slice(inheritedLineage.plan_id.lastIndexOf('_p') + 2))
      : undefined
    if (Number.isSafeInteger(inPlaceSequence)) {
      const refreshed = createPlan(state, {
        now,
        sequence: inPlaceSequence,
        planVersion: inheritedLineage.plan_version,
        derivedFrom: inheritedLineage.derived_from_plan_id ?? null,
        steps: event.steps,
        roadmapNodeIds: event.roadmap_node_ids,
        developmentMode: event.development_mode,
        origin: inheritedLineage.origin,
        carriedForwardEvidence: inheritedLineage.carried_forward_evidence ?? [],
      })
      if (refreshed.plan_id !== inheritedLineage.plan_id || refreshed.steps.length === 0) return state
      return {
        ...state,
        plans: state.plans.map(existing => (existing.plan_id === refreshed.plan_id
          ? {
              ...refreshed,
              created_at: existing.created_at ?? refreshed.created_at,
              // A replacement draft keeps its lineage when its contracts are refreshed in place, so the
              // commit-time grant check still applies to it.
              ...(inheritedLineage.replacement ? { replacement: inheritedLineage.replacement } : {}),
            }
          : existing)),
        updated_at: now,
        log: logEntry(state, { type: PLANNING_EVENT.DRAFT_CREATED, at: now, plan_id: refreshed.plan_id, in_place: true }),
      }
    }
    const plan = createPlan(state, {
      now,
      sequence,
      planVersion: inheritedLineage?.plan_version ?? 1,
      derivedFrom: inheritedLineage?.derived_from_plan_id ?? null,
      steps: event.steps,
      roadmapNodeIds: event.roadmap_node_ids,
      developmentMode: event.development_mode,
      origin: event.origin ?? 'main_llm_draft',
      carriedForwardEvidence: inheritedLineage?.carried_forward_evidence ?? [],
    })
    if (plan.steps.length === 0) return state
    // Re-authoring a replacement draft must not shed the grant check: lineage is preserved, and the commit
    // refuses it if the steps drifted from what the grant was classified against.
    if (inheritedLineage?.replacement) plan.replacement = inheritedLineage.replacement
    // A new draft supersedes any still-uncommitted draft; committed plans are
    // untouched.
    const plans = state.plans.map(existing => (PRE_COMMIT_STATUSES.includes(existing.status)
      ? withStatus({ ...existing, superseded_by_plan_id: plan.plan_id }, PLAN_STATUS.SUPERSEDED, { now, reason: 'new_draft' })
      : existing))
    return {
      ...state,
      sequence,
      plans: retainPlans([...plans, plan], plan.plan_id),
      active_plan_id: plan.plan_id,
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.DRAFT_CREATED, at: now, plan_id: plan.plan_id }),
    }
  },

  [PLANNING_EVENT.PLAN_COMMITTED](state, event, now) {
    const plan = getPlan(state, event.plan_id ?? state.active_plan_id)
    if (!plan || !PRE_COMMIT_STATUSES.includes(plan.status)) return state
    // Commit authority is deterministic. Jev may advise routing/effort/context,
    // but a model verdict is never required to make a structurally valid draft
    // executable.
    if (event.runtime_validation?.passed !== true) return state
    if (plan.steps.length === 0) return state
    // A replacement plan commits only while its grant is still current (MW1): the revision it was authorized under,
    // the goal, the actor epoch and the steps that were classified. Refused, it stays an uncommitted DRAFT and the
    // refusal is recorded for the trace; nothing else about the state moves.
    if (plan.replacement) {
      const verdict = checkReplacementAtCommit(state, plan, event.grant_check)
      if (!verdict.ok) {
        return {
          ...state,
          authorization: recordRefusal(authorizationOf(state), {
            stage: 'commit',
            reason: verdict.reason,
            grant_id: verdict.grant_id ?? plan.replacement.grant_id,
            grant_revision: verdict.grant_revision ?? plan.replacement.grant_revision,
            plan_id: plan.plan_id,
          }, now),
          updated_at: now,
          log: logEntry(state, { type: 'REPLACEMENT_COMMIT_REFUSED', at: now, plan_id: plan.plan_id, reason: verdict.reason }),
        }
      }
    }

    const committed = freezeCommittedPlan(withStatus({
      ...plan,
      committed_at: now,
      runtime_validation: {
        passed: true,
        validated_at: now,
        unsupported_step_ids: stringList(event.runtime_validation?.unsupported_step_ids, { max: 16, maxLength: 200 }),
      },
    }, PLAN_STATUS.COMMITTED, { now, reason: 'auto_commit_runtime_validated' }))

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
    const index = plan.active_step_index
    const step = plan.steps[index]
    if (!step || text(event.step_id, 200) !== step.step_id) return state

    const runtimeCompletion = isRuntimeAuthority(event.source)
    const semanticCompletion = isSemanticCompletionAuthority(event.source)
      && event.semantic_claim === true
      && !step.completion_contract
    if (!runtimeCompletion && !semanticCompletion) return state

    let progress = plan.execution.step_progress[step.step_id] ?? emptyStepProgress()
    if (step.completion_contract) {
      // Deterministic step: only runtime evidence satisfying the immutable
      // contract may close it. A planner semantic claim is structurally barred.
      if (!runtimeCompletion || !progress.contract_satisfied) return state
    }
    else if (semanticCompletion) {
      const groundingRefs = stringList(event.grounding_refs, { max: 16, maxLength: 200 })
      if (groundingRefs.length === 0) return state
      progress = {
        ...progress,
        accepted_evidence: [...progress.accepted_evidence, {
          ref: groundingRefs[0],
          kind: 'semantic_completion_grounding',
          source: 'main_planner',
          batch_id: null,
          satisfied_requirement_ids: [],
          at: now,
        }].slice(-32),
        batches_since_evidence: 0,
      }
    }
    else if (progress.accepted_evidence.length === 0) {
      // Runtime may close an uncontracted step only when it already carries
      // authoritative evidence. Normal prose-only completion should use the
      // explicit Main-LLM semantic-completion path above.
      return state
    }

    const completed = updateProgress({ ...plan, execution: {
      ...plan.execution,
      step_progress: { ...plan.execution.step_progress, [step.step_id]: progress },
    } }, step.step_id, item => ({
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
    // The verified prefix is cumulative: what the predecessor itself carried
    // forward, then what it completed. A second revision must not shrink it
    // (the board's verified prefix keeps every earlier step).
    const carried = [
      ...(predecessor.carried_forward_evidence ?? []),
      ...predecessor.steps
        .filter(step => predecessor.execution.step_progress[step.step_id]?.status === 'completed')
        .map(step => `${predecessor.plan_id}:${step.step_id}`),
    ]
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
      plans: retainPlans([...plans, successor], successor.plan_id),
      active_plan_id: successor.plan_id,
      // The user's revision takes the goal out of its pause: a blocked plan
      // that was also paused must not leave the successor's run paused.
      run: state.run?.paused
        ? { ...state.run, paused: false, pause_reason: '', pause_code: '', resumed_at: now, updated_at: now }
        : state.run,
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

  // --- MW1 authorization -----------------------------------------------------

  [PLANNING_EVENT.AUTHORIZATION_GRANTED](state, event, now) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    if (!isRuntimeAuthority(event.source) && !isConsentAuthority(event.source)) return state
    const goalId = text(event.goal_id, 120)
    if (goalId && goalId !== state.goal.goal_id) return state
    const result = grantAuthorization(authorizationOf(state), { ...event.grant, goal_id: state.goal.goal_id }, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.AUTHORIZATION_GRANTED,
        at: now,
        grant_id: result.grant.grant_id,
        revision: result.grant.revision,
      }),
    }
  },

  [PLANNING_EVENT.AUTHORIZATION_REVISED](state, event, now) {
    if (!isRuntimeAuthority(event.source) && !isConsentAuthority(event.source)) return state
    const result = reviseAuthorization(authorizationOf(state), event, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.AUTHORIZATION_REVISED,
        at: now,
        grant_id: result.grant.grant_id,
        revision: result.grant.revision,
      }),
    }
  },

  [PLANNING_EVENT.AUTHORIZATION_REVOKED](state, event, now) {
    if (!isRuntimeAuthority(event.source) && !isConsentAuthority(event.source)) return state
    const result = revokeAuthorization(authorizationOf(state), event, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.AUTHORIZATION_REVOKED,
        at: now,
        grant_id: result.grant.grant_id,
        revision: result.grant.revision,
      }),
    }
  },

  [PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED](state, event, now) {
    // The harness owns this request. The planner authors the steps; it cannot invoke the transition.
    if (!isRuntimeAuthority(event.source)) return state
    const verdict = classifyReplacement(state, event)
    const auth = authorizationOf(state)
    const predecessorId = text(event.plan_id, 200)

    if (verdict.decision === REPLACEMENT_DECISION.REFUSE) {
      return {
        ...state,
        authorization: recordRefusal(auth, {
          stage: 'replacement',
          reason: verdict.reason,
          grant_id: verdict.grant_id ?? event.grant?.grant_id,
          grant_revision: verdict.grant_revision,
          plan_id: predecessorId,
        }, now),
        updated_at: now,
        log: logEntry(state, { type: PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED, at: now, plan_id: predecessorId, decision: 'refuse', reason: verdict.reason }),
      }
    }

    if (verdict.decision === REPLACEMENT_DECISION.ASK) {
      // The old committed plan is NOT touched while the question is pending.
      const subjects = Object.values(verdict.subjects ?? {}).flat()
      const raised = raiseQuestion(auth, {
        kind: 'replacement_approval',
        reason_codes: verdict.reason_codes,
        plan_id: predecessorId,
        goal_id: state.goal?.goal_id,
        grant_id: verdict.grant_id,
        grant_revision: verdict.grant_revision,
        subject_key: `${verdict.reason_codes.join('+')}:${subjects.join(',')}`,
        subjects,
        detail: text(event.reason?.detail, 400),
      }, now)
      return {
        ...state,
        authorization: raised.auth,
        updated_at: now,
        log: logEntry(state, { type: PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED, at: now, plan_id: predecessorId, decision: 'ask', reason: verdict.reason }),
      }
    }

    const predecessor = getPlan(state, predecessorId)
    const sequence = nextSequence(state)
    // The verified prefix is cumulative, exactly as for a user revision: what the predecessor carried forward, then
    // what it completed. Verified history is preserved, not recomputed or discarded.
    const carried = [
      ...(predecessor.carried_forward_evidence ?? []),
      ...predecessor.steps
        .filter(step => predecessor.execution.step_progress[step.step_id]?.status === 'completed')
        .map(step => `${predecessor.plan_id}:${step.step_id}`),
    ]
    const successor = createPlan(state, {
      now,
      sequence,
      planVersion: predecessor.plan_version + 1,
      derivedFrom: predecessor.plan_id,
      steps: event.steps,
      roadmapNodeIds: event.roadmap_node_ids ?? predecessor.roadmap_node_ids,
      developmentMode: event.development_mode ?? predecessor.development_mode,
      origin: 'authorized_replacement',
      carriedForwardEvidence: carried,
    })
    if (successor.steps.length === 0) return state
    successor.replacement = replacementLineage(
      { ...verdict, steps_fingerprint: replacementStepsFingerprint(successor.steps) },
      { predecessorPlanId: predecessor.plan_id, now },
    )
    const plans = state.plans.map(item => (item.plan_id === predecessor.plan_id
      ? { ...item, superseded_by_plan_id: successor.plan_id, updated_at: now }
      : item))
    const nextAuth = verdict.approval_id ? consumeApproval(auth, verdict.approval_id) : auth
    return withReasoningReset({
      ...state,
      sequence,
      plans: retainPlans([...plans, successor], successor.plan_id),
      active_plan_id: successor.plan_id,
      authorization: nextAuth,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED,
        at: now,
        plan_id: successor.plan_id,
        derived_from_plan_id: predecessor.plan_id,
        decision: 'accept',
        grant_id: verdict.grant_id,
        grant_revision: verdict.grant_revision,
        reason_code: verdict.replacement_reason.code,
      }),
    }, { now, eventType: PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED, reason: verdict.replacement_reason.code })
  },

  [PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED](state, event, now) {
    // An approval is the player's answer; only user authority can give one.
    if (!isConsentAuthority(event.source)) return state
    const result = recordApproval(authorizationOf(state), {
      ...event,
      goal_id: event.goal_id ?? state.goal?.goal_id,
    }, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED,
        at: now,
        approval_id: result.approval.approval_id,
        decision: result.approval.decision,
      }),
    }
  },

  [PLANNING_EVENT.NPC_PLACEMENT_RECORDED](state, event, now) {
    if (!isRuntimeAuthority(event.source)) return state
    const result = recordNpcPlacement(authorizationOf(state), event, now)
    if (!result.auth) return state
    return { ...state, authorization: result.auth, updated_at: now }
  },

  [PLANNING_EVENT.RESERVATION_RECORDED](state, event, now) {
    if (!isRuntimeAuthority(event.source) && !isConsentAuthority(event.source)) return state
    const result = recordReservation(authorizationOf(state), event, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, at: now, reservation_id: result.reservation.reservation_id }),
    }
  },

  [PLANNING_EVENT.RESERVATION_RELEASED](state, event, now) {
    if (!isRuntimeAuthority(event.source) && !isConsentAuthority(event.source)) return state
    const result = releaseReservation(authorizationOf(state), event, now)
    if (!result.auth) return state
    return {
      ...state,
      authorization: result.auth,
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.RESERVATION_RELEASED, at: now, reservation_id: result.reservation.reservation_id }),
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
  [PLANNING_EVENT.GOAL_DEFINED](state, event, now) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    if (text(event.goal_id, 120) && text(event.goal_id, 120) !== state.goal.goal_id) return state
    const source = text(event.source, 60)
    const fromPlanner = source === 'main_planner'
    if (!fromPlanner && !isUserAuthority(source)) return state
    // The planner defines a goal once; redefinition is the user's call.
    if (state.goal.definition && fromPlanner) return state
    let definition
    try { definition = sanitizeGoalDefinition(event.definition) }
    catch { return state }
    return {
      ...state,
      goal: {
        ...state.goal,
        definition: { ...definition, source, defined_at: now },
        updated_at: now,
      },
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.GOAL_DEFINED, at: now, goal_id: state.goal.goal_id }),
    }
  },

  [PLANNING_EVENT.GOAL_BASELINES_RECORDED](state, event, now) {
    const definition = state.goal?.definition
    if (!definition || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    if (text(event.goal_id, 120) && text(event.goal_id, 120) !== state.goal.goal_id) return state
    if (!isRuntimeAuthority(event.source)) return state
    const baselines = event.baselines && typeof event.baselines === 'object' && !Array.isArray(event.baselines) ? event.baselines : {}
    let changed = false
    const doneWhen = definition.done_when.map((condition) => {
      const value = baselines[condition.id]
      if (!needsGoalBaseline(condition) || !Number.isSafeInteger(value) || value < 0) return condition
      changed = true
      return { ...condition, baseline: value }
    })
    if (!changed) return state
    return {
      ...state,
      goal: { ...state.goal, definition: { ...definition, done_when: doneWhen }, updated_at: now },
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.GOAL_BASELINES_RECORDED, at: now, goal_id: state.goal.goal_id }),
    }
  },

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

  /**
   * Run-state events (3.3 move 3). The run is the goal's operating state, not
   * the plan's: none of these handlers can appear to touch `plans`, so a
   * pause/resume round trip leaves plan content, active step, blocker and
   * approval state exactly as they were. A BLOCKED plan stays BLOCKED.
   */
  [PLANNING_EVENT.RUN_PAUSED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    const run = state.run ?? createEmptyRunState()
    const reason = text(event.reason, RUN_STATE_LIMITS.pauseReason)
    return {
      ...state,
      // A paused run holds no wait and no follow controller. Provider recovery
      // is deliberately kept: it is what a budget-cap pause resumes from.
      run: {
        ...run,
        paused: true,
        pause_reason: reason,
        pause_code: text(event.reason_code, RUN_STATE_LIMITS.pauseCode) || pauseCodeOf(reason),
        paused_at: run.paused ? run.paused_at : now,
        pause_count: run.paused ? run.pause_count : run.pause_count + 1,
        condition_wait: null,
        persistent_runtime: null,
        updated_at: now,
      },
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.RUN_PAUSED,
        at: now,
        reason_code: text(event.reason_code, RUN_STATE_LIMITS.pauseCode) || pauseCodeOf(reason),
      }),
    }
  },

  [PLANNING_EVENT.RUN_RESUMED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    const run = state.run
    if (!run?.paused) return state
    return {
      ...state,
      run: { ...run, paused: false, pause_reason: '', pause_code: '', resumed_at: now, updated_at: now },
      updated_at: now,
      log: logEntry(state, {
        type: PLANNING_EVENT.RUN_RESUMED,
        at: now,
        reason_code: text(event.reason_code ?? event.reason, RUN_STATE_LIMITS.pauseCode) || null,
      }),
    }
  },

  [PLANNING_EVENT.CONDITION_WAIT_RECORDED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    return recordRunRecord(state, now, 'condition_wait', event.wait, {
      // A paused run holds no wait; a wait for another goal is stale work.
      refuse: (run, record) => run.paused || (text(record.goal_id, 120) && text(record.goal_id, 120) !== state.goal.goal_id),
      clearId: event.wait_id,
    })
  },

  [PLANNING_EVENT.PROVIDER_RECOVERY_RECORDED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    return recordRunRecord(state, now, 'provider_recovery', event.recovery, {
      refuse: (_run, record) => text(record.goal_id, 120) && text(record.goal_id, 120) !== state.goal.goal_id,
    })
  },

  // Existing campaign work can be reconciled even after its goal stops. New
  // admissions still require an active goal and that goal's exact identity.
  [PLANNING_EVENT.PENDING_OPERATION_RECORDED](state, event, now) {
    if (!isRuntimeAuthority(event.source)) return state
    const run = state.run ?? createEmptyRunState()
    const existing = operationLedger(state.operation_ledger, run.pending_operation)
    if (event.operation === null || event.operation === undefined) {
      const key = text(event.operation_key ?? run.pending_operation?.operation_key, 200)
      if (!existing.records.some(record => record.operation_key === key)) return state
      const ledger = settleOperation(existing, key)
      return { ...state, operation_ledger: ledger, run: { ...run, pending_operation: ledger.records.at(-1) ?? null, updated_at: now }, updated_at: now }
    }
    const record = sanitizePendingOperation(event.operation)
    if (!record) return state
    const prior = existing.records.find(item => item.operation_key === record.operation_key)
    if (!prior && (!runEventAllowed(state, event) || record.goal_id !== state.goal?.goal_id)) return state
    if (prior && (record.signature !== prior.signature || record.attempt_id !== prior.attempt_id
      || record.ordinal !== prior.ordinal || record.actor.actor_id !== prior.actor.actor_id || record.actor.epoch !== prior.actor.epoch)) return state
    const ledger = recordOperation(existing, record)
    if (!ledger) return state
    return { ...state, operation_ledger: ledger, run: { ...run, pending_operation: record, updated_at: now }, updated_at: now }
  },

  [PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    return recordRunRecord(state, now, 'persistent_runtime', event.runtime, {
      refuse: run => run.paused,
    })
  },

  /**
   * Locators and stale identities (3.3 move 4).
   *
   *   durable_last_operations  replaces the list (the last batch's locators)
   *   exact_target_audit       appends (or replaces with `exact_target_audit_mode: 'replace'`)
   *   stale_unit_numbers       unions into the stale-identity set
   *
   * unit_numbers are never reused, so a stale identity stays stale for the
   * goal: the set only grows (bounded, oldest dropped). It lives in reducer
   * state so it survives a restart with the snapshot.
   */
  [PLANNING_EVENT.LOCATORS_RECORDED](state, event, now) {
    if (!runEventAllowed(state, event)) return state
    const run = state.run ?? createEmptyRunState()
    let locators = run.locators
    let stale = run.stale_exact_identities
    if (Array.isArray(event.durable_last_operations)) {
      locators = { ...locators, durable_last_operations: sanitizeDurableOperations(event.durable_last_operations) }
    }
    if (Array.isArray(event.exact_target_audit)) {
      const incoming = sanitizeExactTargetAudit(event.exact_target_audit)
      locators = {
        ...locators,
        exact_target_audit: (event.exact_target_audit_mode === 'replace' ? incoming : [...locators.exact_target_audit, ...incoming])
          .slice(-RUN_STATE_LIMITS.exactTargetAudit),
      }
    }
    if (Array.isArray(event.stale_unit_numbers)) {
      stale = sanitizeStaleIdentities([...stale, ...event.stale_unit_numbers])
    }
    if (locators === run.locators && stale === run.stale_exact_identities) return state
    return {
      ...state,
      run: { ...run, locators, stale_exact_identities: stale, updated_at: now },
      updated_at: now,
    }
  },

  /**
   * Operation receipt ledger (3.3 move 2).
   *
   * One event carries one receipt (`kind`, `ref`, `summary`, `batch_id`, `at`)
   * or a `receipts` array. Each is appended to the ledger of ONE step of ONE
   * plan (`plan_id`/`step_id`, defaulting to the active plan's active step),
   * keeping only the most recent entries per step.
   *
   * Fails closed: harness sources only, the goal must be active and match the
   * event's `goal_id`, a stamped `plan_id`/`reasoning_epoch` must still be the
   * live one, and the step must exist in that plan. It changes no plan
   * content, step status, evidence acceptance, blocker or epoch.
   *
   * `source: 'legacy_adopted'` with an empty `receipts` list marks an old
   * snapshot's ledger as seeded without adding anything.
   */
  [PLANNING_EVENT.OPERATION_RECEIPT_RECORDED](state, event, now) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    const goalId = text(event.goal_id, 120)
    if (goalId && goalId !== state.goal.goal_id) return state
    const source = text(event.source, 60)
    if (!RECEIPT_EVENT_SOURCES.includes(source)) return state
    if (event.reasoning_epoch !== undefined && event.reasoning_epoch !== currentReasoningEpoch(state)) return state
    const planId = text(event.plan_id, 200) || state.active_plan_id
    const plan = planId ? findPlan(state, planId) : undefined
    if (!plan || plan.goal_id !== state.goal.goal_id) return state
    if (plan.status === PLAN_STATUS.CANCELLED || plan.status === PLAN_STATUS.SUPERSEDED) return state
    const stepId = text(event.step_id, 200) || plan.steps[plan.active_step_index]?.step_id
    if (!stepId || !plan.steps.some(step => step.step_id === stepId)) return state

    const raw = Array.isArray(event.receipts) ? event.receipts : [event]
    const incoming = raw.flatMap((item) => {
      const entry = sanitizeReceiptEntry(item, { source, now })
      return entry ? [entry] : []
    })
    const seeding = source === 'legacy_adopted' && Array.isArray(event.receipts)
    if (incoming.length === 0 && !(seeding && plan.execution.receipts_seeded !== true)) return state

    const ledger = plan.execution.receipts && typeof plan.execution.receipts === 'object' ? plan.execution.receipts : {}
    const held = Array.isArray(ledger[stepId]) ? ledger[stepId] : []
    let seq = held.reduce((max, item) => Math.max(max, item.seq ?? 0), 0)
    const appended = incoming.map(entry => ({ ...entry, seq: ++seq }))
    const nextLedger = appended.length === 0
      ? ledger
      : { ...ledger, [stepId]: [...held, ...appended].slice(-RECEIPT_LEDGER_LIMITS.perStep) }
    const seeded = plan.execution.receipts_seeded === true || seeding
    return {
      ...withPlan(state, plan.plan_id, current => ({
        ...current,
        execution: { ...current.execution, receipts: nextLedger, receipts_seeded: seeded },
      })),
      updated_at: now,
    }
  },

  /**
   * Context restage record (3.3 move 6). Pure ledger: it never touches plans,
   * the active step, `sequence`, `updated_at`, `reasoning_epoch` or
   * `last_reasoning_reset`. Harness sources only; stale goal fails closed.
   */
  [PLANNING_EVENT.CONTEXT_RESTAGED](state, event) {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return state
    const goalId = text(event.goal_id, 120)
    if (!goalId || goalId !== state.goal.goal_id) return state
    if (!RESTAGE_EVENT_SOURCES.includes(text(event.source, 60))) return state
    const role = text(event.role, 24)
    const checkpoint = text(event.checkpoint, 8)
    if (!CONTEXT_RESTAGE_ROLES.includes(role) || !CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint)) return state
    const planId = text(event.plan_id, 200)
    if (planId && !findPlan(state, planId)) return state
    const size = (value) => {
      const n = finiteNumber(value)
      return n !== undefined && n >= 0 ? Math.floor(n) : null
    }
    const entry = {
      goal_id: goalId,
      plan_id: planId || null,
      role,
      checkpoint,
      reason: text(event.reason, CONTEXT_RESTAGE_LIMITS.reason),
      handoff_id: text(event.handoff_id, 60) || null,
      packet_chars: size(event.packet_chars),
      previous_context_chars: size(event.previous_context_chars),
      at: finiteNumber(event.now) ?? 0,
    }
    return { ...state, context_restages: [...recentList(state.context_restages, CONTEXT_RESTAGE_LIMITS.entries - 1), entry] }
  },
})

// --- MW2 task ledger ---------------------------------------------------------
//
// The ledger holds ACCEPTED tasks that are not running: interrupted ones (with a checkpoint of the committed plan and
// verified progress) and queued ones. See task-ledger.mjs for the record; the transitions live here because only this
// module may change planning state.

function isLedgerAuthority(source) {
  return isRuntimeAuthority(source) || isUserAuthority(source)
}

function taskProgressRecord(plan) {
  if (!plan) return null
  const completed = plan.steps
    .filter(step => plan.execution.step_progress[step.step_id]?.status === 'completed')
    .map(step => step.step_id)
  const receiptRefs = []
  let evidenceCount = 0
  for (const step of plan.steps) {
    evidenceCount += plan.execution.step_progress[step.step_id]?.accepted_evidence?.length ?? 0
    for (const receipt of plan.execution.receipts?.[step.step_id] ?? []) {
      if (receipt.ref) receiptRefs.push(receipt.ref)
    }
  }
  return {
    plan_id: plan.plan_id,
    plan_version: plan.plan_version,
    plan_status: plan.status,
    active_step_index: plan.active_step_index,
    active_step_id: plan.steps[plan.active_step_index]?.step_id ?? null,
    steps_total: plan.steps.length,
    steps_completed: completed.length,
    completed_step_ids: completed,
    receipt_refs: receiptRefs.slice(-TASK_LEDGER_LIMITS.receiptRefs),
    progress_marker: fingerprint(`${completed.join(',')}|${evidenceCount}|${receiptRefs.length}`),
  }
}

function taskGrantLink(state) {
  const goalId = state.goal?.goal_id
  const grant = [...authorizationOf(state).grants].reverse().find(item => item.goal_id === goalId)
  return grant
    ? {
        grant_id: grant.grant_id,
        grant_revision: grant.revision,
        mandate_kind: grant.mandate_kind,
        mandate_id: grant.mandate_id,
        grant_status: grant.status,
      }
    : null
}

// A bounded copy of the stopped task's planning state for a later resume. Goal-scoped parts only: the world facts
// (reserved containers, NPC placements) and the ledger itself stay live and are never restored from here.
function taskCheckpointPlanning(state) {
  const serialized = serializePlanningState({ ...state, task_ledger: undefined, operation_ledger: undefined,
    run: state.run ? { ...state.run, pending_operation: null } : state.run })
  const activeId = serialized.active_plan_id
  const plans = Array.isArray(serialized.plans) ? serialized.plans : []
  let kept = plans.slice(-TASK_LEDGER_LIMITS.checkpointPlans)
  if (activeId && !kept.some(plan => plan?.plan_id === activeId)) {
    const active = plans.find(plan => plan?.plan_id === activeId)
    if (active) kept = [active, ...kept.slice(1)]
  }
  return {
    ...serialized,
    plans: kept,
    roadmap_history: [],
    context_restages: [],
    log: recentList(serialized.log, TASK_LEDGER_LIMITS.checkpointLog),
    ...(serialized.authorization
      ? { authorization: { ...serialized.authorization, world: { npc_placements: [], reservations: [] } } }
      : {}),
  }
}

const TASK_CHECKPOINT_PLAN_STATUSES = Object.freeze([
  PLAN_STATUS.COMMITTED,
  PLAN_STATUS.EXECUTING,
  PLAN_STATUS.BLOCKED,
  PLAN_STATUS.COMPLETED,
])

function interruptionReasonFor(state, event) {
  if (Object.values(TASK_INTERRUPTION).includes(event.reason_code)) return event.reason_code
  const plan = getActivePlan(state)
  if (plan?.status === PLAN_STATUS.BLOCKED) return TASK_INTERRUPTION.BLOCKER
  if (state.run?.paused === true) return TASK_INTERRUPTION.PAUSE
  return TASK_INTERRUPTION.NEW_GOAL
}

function stateAtInterruption(state) {
  if (getActivePlan(state)?.status === PLAN_STATUS.BLOCKED) return TASK_STATE_AT_INTERRUPTION.BLOCKED
  if (state.run?.paused === true) return TASK_STATE_AT_INTERRUPTION.PAUSED
  return TASK_STATE_AT_INTERRUPTION.ACTIVE
}

/**
 * Decide an interruption of the running task. The same function the TASK_INTERRUPTED handler uses, so a trace and the
 * state change cannot disagree. `ok` carries the sanitized ledger task that would be recorded.
 */
export function classifyTaskInterruption(state, event) {
  if (!isLedgerAuthority(event?.source)) return { ok: false, reason: TASK_LEDGER_REFUSAL.UNAUTHORIZED_SOURCE }
  if (!state?.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return { ok: false, reason: TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK }
  const goalId = text(event.goal_id, 120)
  // An event stamped for another goal is stale work from before a replacement, restart or cancel.
  if (goalId && goalId !== state.goal.goal_id) return { ok: false, reason: TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK }
  const taskId = taskIdFor(state.goal.goal_id)
  if (findTask(taskLedgerOf(state), taskId)) return { ok: false, reason: TASK_LEDGER_REFUSAL.ALREADY_RECORDED, task_id: taskId }
  const plan = getActivePlan(state)
  const started = Boolean(plan) && TASK_CHECKPOINT_PLAN_STATUSES.includes(plan.status)
  const grant = taskGrantLink(state)
  const grantRecord = grant ? authorizationOf(state).grants.find(item => item.grant_id === grant.grant_id) : undefined
  const by = event.interrupted_by && typeof event.interrupted_by === 'object' && !Array.isArray(event.interrupted_by) ? event.interrupted_by : {}
  const task = sanitizeTask({
    task_id: taskId,
    goal_id: state.goal.goal_id,
    owner: state.goal.owner,
    objective: state.goal.objective,
    status: started ? TASK_STATUS.INTERRUPTED : TASK_STATUS.PENDING,
    mandate_kind: grant?.mandate_kind ?? text(event.mandate_kind, 40),
    requested_result: {
      objective: state.goal.objective,
      result_key: grantRecord?.requested_result?.result_key ?? text(event.result_key, 200),
      done_when: state.goal.definition?.done_when ?? [],
      destination: event.destination ?? grantRecord?.requested_result?.destination,
    },
    authorization: grant,
    progress: taskProgressRecord(plan),
    interruption: {
      reason_code: interruptionReasonFor(state, event),
      detail: event.detail,
      state_at_interruption: stateAtInterruption(state),
      interrupted_by: { kind: by.kind ?? 'runtime', goal_id: by.goal_id, sender: by.sender },
      request_id: event.request_id,
      at: finiteNumber(event.now) ?? 0,
      game_tick: event.game_tick,
      actor: event.actor,
    },
    checkpoint: started
      ? { planning: taskCheckpointPlanning(state), legacy: event.legacy_checkpoint && typeof event.legacy_checkpoint === 'object' ? event.legacy_checkpoint : null }
      : undefined,
    recorded_at: finiteNumber(event.now) ?? 0,
  })
  if (!task) return { ok: false, reason: TASK_LEDGER_REFUSAL.INVALID_TASK }
  return { ok: true, task }
}

/**
 * Decide a resume. Refuses while another task is running (one execution context at a time), for an unknown or
 * unrunnable task, and when the checkpoint cannot be restored. `ok` carries the restored planning state for the task
 * (undefined for a queued task, which starts as a fresh goal).
 */
export function classifyTaskResume(state, event) {
  if (!isLedgerAuthority(event?.source)) return { ok: false, reason: TASK_LEDGER_REFUSAL.UNAUTHORIZED_SOURCE }
  if (state?.goal?.status === GOAL_STATUS.ACTIVE) return { ok: false, reason: TASK_LEDGER_REFUSAL.ANOTHER_TASK_ACTIVE, active_goal_id: state.goal.goal_id }
  const ledger = taskLedgerOf(state)
  const explicitId = text(event?.task_id, 130)
  const task = explicitId ? findTask(ledger, explicitId) : mostRecentResumable(ledger)
  if (!task) return { ok: false, reason: explicitId ? TASK_LEDGER_REFUSAL.TASK_NOT_FOUND : TASK_LEDGER_REFUSAL.NOTHING_TO_RESUME, task_id: explicitId || undefined }
  const runnable = taskRunnable(task)
  // An explicit user resume may continue a paused or blocked task; the harness alone resumes only runnable ones.
  const explicitUser = Boolean(explicitId) && isUserAuthority(event.source)
  if (!runnable.runnable && !(explicitUser && runnable.reason !== TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE)) {
    return {
      ok: false,
      reason: runnable.reason === TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE ? TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE : TASK_LEDGER_REFUSAL.TASK_NOT_RESUMABLE,
      detail: runnable.reason,
      task_id: task.task_id,
    }
  }
  if (task.status === TASK_STATUS.PENDING) return { ok: true, task, restored: undefined }
  const restored = restorePlanningState(task.checkpoint?.planning)
  if (!restored.goal || restored.goal.goal_id !== task.goal_id || restored.goal.status !== GOAL_STATUS.ACTIVE) {
    return { ok: false, reason: TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE, task_id: task.task_id }
  }
  return { ok: true, task, restored }
}

Object.assign(HANDLERS, {
  /**
   * Move the running task into the ledger. The planning state becomes goalless, keeping the world facts and the ledger,
   * so a task is never both running and parked. A refused interruption changes nothing.
   */
  [PLANNING_EVENT.TASK_INTERRUPTED](state, event, now) {
    const verdict = classifyTaskInterruption(state, { ...event, now })
    if (!verdict.ok) return state
    const added = addTask(taskLedgerOf(state), verdict.task, { now, requestId: event.request_id })
    const world = carryAuthorizationAcrossGoals(state.authorization)
    const fresh = createEmptyPlanningState()
    return withReasoningReset({
      ...fresh,
      ...(world ? { authorization: world } : {}),
      task_ledger: added.ledger,
      sequence: nextSequence(state),
      reasoning_epoch: currentReasoningEpoch(state),
      updated_at: now,
      log: logEntry(fresh, {
        type: PLANNING_EVENT.TASK_INTERRUPTED,
        at: now,
        task_id: added.task.task_id,
        goal_id: added.task.goal_id,
        reason: added.task.interruption?.reason_code ?? null,
      }),
    }, { now, eventType: PLANNING_EVENT.TASK_INTERRUPTED, reason: added.task.interruption?.reason_code ?? 'task_interrupted' })
  },

  // A task accepted but not started (nothing verified to preserve). Runs beside whatever is running now.
  [PLANNING_EVENT.TASK_QUEUED](state, event, now) {
    if (!isLedgerAuthority(event.source)) return state
    const objective = text(event.objective, TASK_LEDGER_LIMITS.objective)
    if (!objective) return state
    const sequence = nextSequence(state)
    const goalId = text(event.goal_id, 120) || `goal_q${sequence}_${fingerprint(`${now}|${objective}`)}`
    if (state.goal?.goal_id === goalId) return state
    const ledger = taskLedgerOf(state)
    const taskId = taskIdFor(goalId)
    if (findTask(ledger, taskId)) return state
    const task = sanitizeTask({
      task_id: taskId,
      goal_id: goalId,
      owner: event.owner,
      objective,
      status: TASK_STATUS.PENDING,
      mandate_kind: event.mandate_kind,
      requested_result: { objective, result_key: event.result_key, done_when: [], destination: event.destination },
      authorization: event.authorization,
      recorded_at: now,
    })
    if (!task) return state
    const added = addTask(ledger, task, { now, requestId: event.request_id })
    return {
      ...state,
      task_ledger: added.ledger,
      sequence,
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.TASK_QUEUED, at: now, task_id: taskId, goal_id: goalId }),
    }
  },

  /**
   * Move a ledger task back as the running task. An interrupted task comes back exactly as it stopped (its committed plan,
   * verified step progress, receipts and locators, restored through the reducer's own sanitizers); the live world facts and
   * the ledger are kept, never replaced by the checkpoint's. Pause, condition wait and provider recovery do not carry over:
   * they described the world at the time it stopped.
   */
  [PLANNING_EVENT.TASK_RESUMED](state, event, now) {
    const verdict = classifyTaskResume(state, event)
    if (!verdict.ok) return state
    const closed = closeTask(taskLedgerOf(state), verdict.task.task_id, {
      status: TASK_CLOSE.RESUMED,
      reason: text(event.reason, TASK_LEDGER_LIMITS.detail) || 'resumed',
      requestId: event.request_id,
      now,
    })
    if (!closed.task) return state
    const base = { ...state, task_ledger: closed.ledger }
    if (!verdict.restored) {
      // A queued task starts as a fresh goal under its own id.
      return HANDLERS[PLANNING_EVENT.GOAL_ACCEPTED](base, {
        goal_id: verdict.task.goal_id,
        owner: verdict.task.owner,
        objective: verdict.task.objective,
      }, now)
    }
    const restored = verdict.restored
    const liveAuth = authorizationOf(state)
    const checkpointAuth = restored.authorization
    const authorization = checkpointAuth
      ? { ...checkpointAuth, sequence: Math.max(checkpointAuth.sequence, liveAuth.sequence), world: liveAuth.world }
      : (liveAuth.world.npc_placements.length > 0 || liveAuth.world.reservations.length > 0
          ? { ...liveAuth, grants: [], questions: [], approvals: [], refusals: [] }
          : undefined)
    const run = restored.run
      ? { ...restored.run, paused: false, pause_reason: '', pause_code: '', condition_wait: null, provider_recovery: null, persistent_runtime: null, updated_at: now }
      : restored.run
    const next = {
      ...restored,
      run,
      ...(authorization ? { authorization } : {}),
      task_ledger: closed.ledger,
      sequence: Math.max(nextSequence(state), (restored.sequence ?? 0) + 1),
      reasoning_epoch: currentReasoningEpoch(state),
      updated_at: now,
      log: logEntry(restored, {
        type: PLANNING_EVENT.TASK_RESUMED,
        at: now,
        task_id: verdict.task.task_id,
        goal_id: verdict.task.goal_id,
      }),
    }
    if (!authorization) delete next.authorization
    return withReasoningReset(next, { now, eventType: PLANNING_EVENT.TASK_RESUMED, reason: 'task_resumed' })
  },

  // Explicit cancellation of a parked task: it leaves the ledger for the closed history and is never resumed.
  [PLANNING_EVENT.TASK_CANCELLED](state, event, now) {
    if (!isLedgerAuthority(event.source)) return state
    const closed = closeTask(taskLedgerOf(state), event.task_id, {
      status: TASK_CLOSE.CANCELLED,
      reason: event.reason || 'cancelled',
      requestId: event.request_id,
      now,
    })
    if (!closed.task) return state
    return {
      ...state,
      task_ledger: closed.ledger,
      sequence: nextSequence(state),
      updated_at: now,
      log: logEntry(state, { type: PLANNING_EVENT.TASK_CANCELLED, at: now, task_id: closed.task.task_id, goal_id: closed.task.goal_id }),
    }
  },
})

/**
 * What survives a goal's teardown (a new goal, a completed task's context clear, a restart with no goal): the MW1 world
 * facts and the MW2 task ledger. Callers merge the result over a fresh empty state.
 */
export function carriedAcrossGoals(state) {
  const authorization = carryAuthorizationAcrossGoals(state?.authorization)
  const ledger = carryTaskLedger(state?.task_ledger)
  return {
    ...(authorization ? { authorization } : {}),
    ...(ledger ? { task_ledger: ledger } : {}),
    ...((state?.operation_ledger || state?.run?.pending_operation) ? { operation_ledger: operationLedger(state.operation_ledger, state.run?.pending_operation) } : {}),
  }
}

/**
 * Build a CONTEXT_RESTAGED event for `state` (goal and plan ids come from the
 * reducer state, so the stamp cannot be wrong). The future handoff packet
 * builder calls this and applies the result; nothing else emits it yet.
 */
export function buildContextRestagedEvent(state, { role, checkpoint, reason, packetChars, previousContextChars, now, planId, handoffId, source = 'runtime' } = {}) {
  return {
    type: PLANNING_EVENT.CONTEXT_RESTAGED,
    now,
    source,
    goal_id: state?.goal?.goal_id,
    plan_id: planId ?? state?.active_plan_id ?? undefined,
    role,
    checkpoint,
    reason,
    handoff_id: handoffId,
    packet_chars: packetChars,
    previous_context_chars: previousContextChars,
  }
}

export function getContextRestages(state) {
  return Array.isArray(state?.context_restages) ? state.context_restages : []
}

// A compact, machine-derived digest of a receipt: JSON receipts keep only the
// fields a later reader needs, anything else is truncated text.
function shortReceiptSummary(summary) {
  const raw = typeof summary === 'string' ? summary : ''
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parts = []
        for (const key of ['outcome', 'verdict', 'failure_class', 'task_state', 'task_count', 'reason']) {
          const value = parsed[key]
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`)
        }
        const types = Array.isArray(parsed.task_types) ? parsed.task_types : Array.isArray(parsed.operations) ? parsed.operations : []
        if (types.length > 0) parts.push(`types=${types.slice(0, 8).map(item => String(item).slice(0, 40)).join(',')}`)
        if (parts.length > 0) return text(parts.join('; '), RECEIPT_LEDGER_LIMITS.summary)
      }
    }
    catch {}
  }
  return text(trimmed, RECEIPT_LEDGER_LIMITS.summary)
}

function receiptBatchId(item) {
  const explicit = item.batch_id
  if (typeof explicit === 'string' || Number.isSafeInteger(explicit)) return text(String(explicit), RECEIPT_LEDGER_LIMITS.batchId)
  const ref = text(item.ref, RECEIPT_LEDGER_LIMITS.ref)
  const fromRef = /^batch_(.+)$/.exec(ref)
  if (fromRef) return text(fromRef[1], RECEIPT_LEDGER_LIMITS.batchId)
  const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
  if (summary.startsWith('{') && summary.length <= 8000) {
    try {
      const parsed = JSON.parse(summary)
      const id = parsed?.batch_id ?? parsed?.batch_ref
      if (typeof id === 'string' || Number.isSafeInteger(id)) return text(String(id), RECEIPT_LEDGER_LIMITS.batchId)
    }
    catch {}
  }
  return ''
}

function sanitizeReceiptEntry(item, { source, now }) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
  const kind = text(item.kind, RECEIPT_LEDGER_LIMITS.kind)
  if (!kind) return undefined
  return {
    batch_id: receiptBatchId(item),
    kind,
    ref: text(item.ref, RECEIPT_LEDGER_LIMITS.ref),
    summary: shortReceiptSummary(item.summary),
    at: finiteNumber(item.at) ?? finiteNumber(item.now) ?? now,
    source,
  }
}

function runEventAllowed(state, event) {
  if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return false
  const goalId = text(event.goal_id, 120)
  // An event stamped for another goal is stale work from before a replacement,
  // restart or cancel. It fails closed.
  if (goalId && goalId !== state.goal.goal_id) return false
  return RUN_EVENT_SOURCES.includes(text(event.source, 60))
}

// Set (record is an object) or clear (record is null/undefined) one runtime
// record on the run. `refuse` may veto a set; a clear is vetoed only by an id
// mismatch. Returns the state unchanged when nothing would change.
function recordRunRecord(state, now, field, raw, { refuse, clearId } = {}) {
  const run = state.run ?? createEmptyRunState()
  if (raw === null || raw === undefined) {
    if (!run[field]) return state
    const id = text(clearId, 100)
    if (id && run[field].id !== id) return state
    return { ...state, run: { ...run, [field]: null, updated_at: now }, updated_at: now }
  }
  const record = boundedRecord(raw)
  if (!record || refuse?.(run, record)) return state
  return { ...state, run: { ...run, [field]: record, updated_at: now }, updated_at: now }
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
    plans: (clone(current.plans) ?? []).map(trimClosedPlanReceipts),
    active_plan_id: current.active_plan_id ?? null,
    steering: clone(current.steering) ?? null,
    updated_at: finiteNumber(current.updated_at) ?? 0,
    reasoning_epoch: currentReasoningEpoch(current),
    last_reasoning_reset: clone(current.last_reasoning_reset) ?? null,
    run: clone(current.run) ?? null,
    ...(current.operation_ledger ? { operation_ledger: clone(current.operation_ledger) } : {}),
    context_restages: clone(getContextRestages(current)),
    // MW1: persisted only when present, so a state that never saw authorization serializes exactly as before.
    ...(current.authorization && authorizationHasContent(current.authorization)
      ? { authorization: serializeAuthorization(current.authorization) }
      : {}),
    // MW2: persisted only when present, like authorization.
    ...(current.task_ledger && taskLedgerHasContent(current.task_ledger)
      ? { task_ledger: serializeTaskLedger(current.task_ledger) }
      : {}),
    log: clone(current.log) ?? [],
  }
}

const CLOSED_PLAN_STATUSES = Object.freeze([PLAN_STATUS.COMPLETED, PLAN_STATUS.SUPERSEDED, PLAN_STATUS.CANCELLED])

// A plan that can no longer execute keeps only the last few receipts per step:
// the packet builder reads the active plan's ledger, and the snapshot must not
// grow with every finished slice. Runs when the state is persisted or restored.
function trimClosedPlanReceipts(plan) {
  if (!plan || !CLOSED_PLAN_STATUSES.includes(plan.status) || !plan.execution?.receipts) return plan
  const receipts = {}
  for (const [stepId, entries] of Object.entries(plan.execution.receipts)) {
    if (Array.isArray(entries) && entries.length > 0) receipts[stepId] = entries.slice(-RECEIPT_LEDGER_LIMITS.closedPlanPerStep)
  }
  return { ...plan, execution: { ...plan.execution, receipts } }
}

function restoreReceiptLedger(raw, stepIds, { closed = false } = {}) {
  const ledger = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ledger
  const cap = closed ? RECEIPT_LEDGER_LIMITS.closedPlanPerStep : RECEIPT_LEDGER_LIMITS.perStep
  for (const stepId of stepIds) {
    const items = Array.isArray(raw[stepId]) ? raw[stepId] : []
    let seq = 0
    const entries = items.slice(-cap).flatMap((item) => {
      const entry = sanitizeReceiptEntry(item, { source: text(item?.source, 60) || 'runtime', now: 0 })
      return entry ? [{ ...entry, seq: Number.isSafeInteger(item.seq) && item.seq > 0 ? item.seq : ++seq }] : []
    })
    if (entries.length > 0) ledger[stepId] = entries
  }
  return ledger
}

function restoreContextRestages(raw) {
  return recentList(raw, CONTEXT_RESTAGE_LIMITS.entries).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const goalId = text(item.goal_id, 120)
    if (!goalId || !CONTEXT_RESTAGE_ROLES.includes(item.role) || !CONTEXT_RESTAGE_CHECKPOINTS.includes(item.checkpoint)) return []
    const size = value => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null)
    return [{
      goal_id: goalId,
      plan_id: text(item.plan_id, 200) || null,
      role: item.role,
      checkpoint: item.checkpoint,
      reason: text(item.reason, CONTEXT_RESTAGE_LIMITS.reason),
      handoff_id: text(item.handoff_id, 60) || null,
      packet_chars: size(item.packet_chars),
      previous_context_chars: size(item.previous_context_chars),
      at: finiteNumber(item.at) ?? 0,
    }]
  })
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
      receipts: restoreReceiptLedger(raw.execution?.receipts, steps.map(step => step.step_id), { closed: CLOSED_PLAN_STATUSES.includes(status) }),
      // Absent in a snapshot that predates the ledger: the memory facade seeds
      // it once from the legacy board evidence.
      receipts_seeded: raw.execution?.receipts_seeded === true,
    },
    advisory: clone(raw.advisory) ?? { planner_focus_step_id: null, planner_focus_at: null, steering_note: null },
    carried_forward_evidence: stringList(raw.carried_forward_evidence, { max: 64, maxLength: 200 }),
    lifecycle: recentList(raw.lifecycle, 64).map(item => clone(item)),
  }
  if (raw.runtime_validation) plan.runtime_validation = clone(raw.runtime_validation)
  const replacement = restoreReplacementLineage(raw.replacement)
  if (replacement) plan.replacement = replacement
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
    history: recentList(raw.history, 32)
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

/**
 * Restore the run state. Returns null when the snapshot predates it, so the
 * caller can seed it once from the legacy record instead of pretending the run
 * was recorded as empty.
 */
function restoreReplacementLineage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const grantId = text(raw.grant_id, 200)
  const predecessor = text(raw.predecessor_plan_id, 200)
  if (!grantId || !predecessor || !Number.isSafeInteger(raw.grant_revision)) return undefined
  const result = raw.requested_result && typeof raw.requested_result === 'object' && !Array.isArray(raw.requested_result)
    ? { result_key: text(raw.requested_result.result_key, 200), destination: text(raw.requested_result.destination, 200) }
    : null
  return {
    predecessor_plan_id: predecessor,
    grant_id: grantId,
    grant_revision: raw.grant_revision,
    mandate_kind: text(raw.mandate_kind, 40),
    action_scope: text(raw.action_scope, 60),
    requested_result: result,
    reason: {
      code: text(raw.reason?.code, 120),
      detail: text(raw.reason?.detail, 400),
      evidence_refs: stringList(raw.reason?.evidence_refs, { max: 16, maxLength: 200 }),
    },
    approval_id: text(raw.approval_id, 40) || null,
    steps_fingerprint: text(raw.steps_fingerprint, 20),
    requested_at: finiteNumber(raw.requested_at) ?? 0,
  }
}

function restoreRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const paused = raw.paused === true
  const reason = paused ? text(raw.pause_reason, RUN_STATE_LIMITS.pauseReason) : ''
  const locators = raw.locators && typeof raw.locators === 'object' && !Array.isArray(raw.locators) ? raw.locators : {}
  return {
    paused,
    pause_reason: reason,
    pause_code: paused ? (text(raw.pause_code, RUN_STATE_LIMITS.pauseCode) || pauseCodeOf(reason)) : '',
    paused_at: finiteNumber(raw.paused_at) ?? null,
    resumed_at: finiteNumber(raw.resumed_at) ?? null,
    pause_count: Number.isSafeInteger(raw.pause_count) && raw.pause_count >= 0 ? raw.pause_count : 0,
    condition_wait: paused ? null : boundedRecord(raw.condition_wait),
    provider_recovery: boundedRecord(raw.provider_recovery),
    persistent_runtime: paused ? null : boundedRecord(raw.persistent_runtime),
    pending_operation: sanitizePendingOperation(raw.pending_operation),
    locators: {
      durable_last_operations: sanitizeDurableOperations(locators.durable_last_operations),
      exact_target_audit: sanitizeExactTargetAudit(locators.exact_target_audit),
    },
    stale_exact_identities: sanitizeStaleIdentities(raw.stale_exact_identities),
    updated_at: finiteNumber(raw.updated_at) ?? 0,
  }
}

function sanitizeDurableOperations(value) {
  return (Array.isArray(value) ? value : [])
    .slice(-RUN_STATE_LIMITS.durableOperations)
    .map(item => (typeof item === 'string' ? item.slice(0, 800) : boundedRecord(item)))
    .filter(item => item !== null && item !== '')
}

function sanitizeExactTargetAudit(value) {
  return (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      if (!Number.isSafeInteger(entry?.unit_number)) return []
      return [{
        unit_number: entry.unit_number,
        operation_name: text(entry.operation_name, 100),
        locator: boundedJson(entry.locator),
        recorded_at: finiteNumber(entry.recorded_at) ?? null,
      }]
    })
    .slice(-RUN_STATE_LIMITS.exactTargetAudit)
}

function sanitizeStaleIdentities(value) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!Number.isSafeInteger(item) || item <= 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out.slice(-RUN_STATE_LIMITS.staleIdentities)
}

export function restorePlanningState(raw) {
  const empty = createEmptyPlanningState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const goal = sanitizeGoal(raw.goal)
  if (!goal) {
    // No goal, but world facts (reserved containers, NPC placement receipts) outlive goals and must survive a restart.
    const world = restoreAuthorization(raw.authorization)
    const ledger = restoreTaskLedger(raw.task_ledger)
    const operations = raw.operation_ledger || raw.run?.pending_operation
      ? operationLedger(raw.operation_ledger, raw.run?.pending_operation) : null
    return world || ledger || operations
      ? { ...empty, ...(world ? { authorization: world } : {}), ...(ledger ? { task_ledger: ledger } : {}),
          ...(operations ? { operation_ledger: operations, run: { ...empty.run, pending_operation: operations.records.at(-1) ?? null } } : {}) }
      : empty
  }
  const activePlanId = text(raw.active_plan_id, 200)
  const plans = retainPlans(Array.isArray(raw.plans) ? raw.plans : [], activePlanId).map(restorePlan).filter(Boolean)
  return {
    version: PLANNING_STATE_VERSION,
    sequence: Number.isSafeInteger(raw.sequence) ? raw.sequence : plans.length,
    goal,
    roadmap: restoreRoadmap(raw.roadmap),
    roadmap_history: recentList(raw.roadmap_history, 32).map(restoreRoadmap).filter(Boolean),
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
    run: restoreRun(raw.run),
    ...((raw.operation_ledger || raw.run?.pending_operation) ? { operation_ledger: operationLedger(raw.operation_ledger, raw.run?.pending_operation) } : {}),
    context_restages: restoreContextRestages(raw.context_restages),
    ...(() => {
      const authorization = restoreAuthorization(raw.authorization)
      return authorization ? { authorization } : {}
    })(),
    ...(() => {
      const ledger = restoreTaskLedger(raw.task_ledger)
      return ledger ? { task_ledger: ledger } : {}
    })(),
    log: recentList(raw.log, 256).map(item => clone(item)),
  }
}
