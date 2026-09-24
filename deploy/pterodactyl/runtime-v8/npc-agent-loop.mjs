import fsp from 'node:fs/promises'
import path from 'node:path'

import { AgentLoopError, NpcAgentLoop as BaseNpcAgentLoop, NpcDialogueMemory as BaseNpcDialogueMemory } from '../staging/npc-agent-loop.mjs'
import {
  addTaskBoardEvidence,
  reconcileTaskBoard,
  sanitizeTaskBoard,
  setTaskBoardStatus,
  taskBoardProgress,
} from './common.mjs'
import { executeAuthorizedBatch } from './supervisor-adapter.mjs'
import {
  boundarySteeringGate,
  decisionConfidencePolicy,
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  observationRelevanceQuestions,
  parseBoundarySteeringTelemetry,
  parseDecisionFamily,
  parseObservationRelevance,
  parseSteeringRecommendation,
  parseTypedStateDistillation,
  steeringRecommendationQuestions,
  typedStateDistillationQuestions,
  typedStateProvenance,
} from './jev-decision-taxonomy.mjs'
import { isLifecycleMetaStep, normalizeCanonicalPlan, validateOutcomeCandidate } from './outcome-authority.mjs'
import {
  getActivePlan as getActivePlanningPlan,
  GOAL_STATUS,
  PLAN_STATUS,
  STEERING_BOUNDARY,
  STEERING_PRESSURE_VOCABULARY,
} from './planning-state.mjs'
import { emptyJevHealth, recordJevHealth, summarizeJevHealth } from './jev-health.mjs'
import { describeUnmetGoalResult, evaluateGoalDefinition, formatGoalProgress, GOAL_SCOPE, needsGoalBaseline, sanitizeGoalDefinition } from './goal-definition.mjs'
import {
  compareGoalReading,
  goalProgressFactsCommand,
  goalReadingChallenge,
  goalReadingQuestions,
  parseGoalProgressFacts,
  parseGoalReading,
} from './goal-reading.mjs'
import { RECOVERY_SEMANTIC_SCOPES, deterministicRecoveryRoute, parseRecoveryDecision, recoveryDecisionQuestions, recoveryFailureClassHint, validateRecoveryRoute } from './recovery-route.mjs'
import {
  applyConditionObservation,
  completionContractSupported,
  evaluateCompletionContract,
  makeConditionWait,
  sanitizeStepCompletionContract,
} from './step-completion.mjs'
import {
  isObservationToolName,
  observationToolFamily,
  isPlannerControlToolName,
  plannerControlPayloadFromMessage,
  renderOperation,
  renderOperationPreflight,
  runtimeConditionCommand,
  toolCommand,
} from './structured-policy.mjs'
import {
  parseTypedProjection,
  routeTypedProjectionByRisk,
  typedProjectionOperationPolicy,
  typedProjectionQuestions,
} from './jev-typed-projection.mjs'

export { AgentLoopError }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /authorization|api.?key|token|password|secret|cookie|session/i
const STATE_SCHEMA = 1
const PLAN_HISTORY_LIMIT = 24
const MAX_OBSERVATION_TOOL_CALLS_PER_BATCH = 4
const DUPLICATE_OBSERVATION_MESSAGE = '[HARNESS] Duplicate observation suppressed. The result is unchanged from the earlier identical tool call already present in this decision context; reuse it and act or report a blocker.'
const OUTPUT_BUDGET_RECOVERY_MESSAGE = '[HARNESS] The immediately preceding provider response exhausted its output budget before emitting content or tool calls. Continue the same logical request and goal from this unchanged harness context. Tools remain available. Do not treat the empty response as an action, plan update, completion, or evidence. Do not replay any world mutation already proven complete by the supplied receipts or canonical Task Board. Return the next necessary observation tool call(s), or use submitPlan for the planner decision. Legacy strict-JSON content remains a compatibility fallback only.'
// The cap covers reasoning tokens too. Live (goal_mueryuql) a reasoning model spent
// 588 of 700 before emitting submitPlan, so the call was cut off mid-JSON
// (finish_reason=length) and the repair failed with no operation. Keep it bounded,
// but leave room for reasoning plus a complete submitPlan argument object.
const ACTION_OMISSION_MAX_TOKENS = 2048
const ACTION_OMISSION_BLOCKER_PREFIX = 'BLOCKED:'
const ACTION_OMISSION_REPAIR_MESSAGE = 'Finite canonical work remains, but no executable operation was submitted. Reuse the authoritative evidence already collected and do not repeat completed observations. If that evidence already parameterizes the next action, submit the next executable operation now. If exactly one mutable fact is genuinely missing, use exactly one targeted observation for that fact; after it, no more observation turns are allowed. Do not stop and wait for a human "continue" message. Otherwise keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or truthful blocker.'
// The act-or-block repair also has to offer the Slice C close: a planner that
// judges a prose-only step already done has no operation to submit, and live
// (goal_mueryuql) it repeated plan: [] until the repair failed.
function actionOmissionRepairMessage(state) {
  const board = state?.task_board
  const index = Number.isSafeInteger(board?.active_index) ? board.active_index : -1
  const step = index >= 0 && Array.isArray(board?.steps) ? board.steps[index] : undefined
  if (!step?.id || completionContractSupported(step.completion_contract)) return ACTION_OMISSION_REPAIR_MESSAGE
  return `${ACTION_OMISSION_REPAIR_MESSAGE} If the evidence you already hold shows that the active prose-only step ${JSON.stringify(cleanMemoryText(step.description, 200))} is complete, close it with semanticCompletion {"stepId":${JSON.stringify(step.id)},"rationale":"..."} and add the operations for the next step if one remains. Do not answer plan: [] while later steps remain.`
}
const ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE = 'The targeted observation budget for this decision is complete. Do not observe again or switch to another read-only tool. Submit the next executable operation now, or keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact still-missing fact or truthful blocker.'
const RESEARCH_PREFLIGHT_RECOVERABLE_CODES = new Set(['missing_prerequisites', 'trigger_research', 'force_busy'])
// Preflight codes that mean the planner named something wrongly (a prototype,
// recipe, identity or argument), not that the world blocks the step. They get
// one bounded correction turn before the plan is frozen as BLOCKED.
const MODEL_CORRECTABLE_PREFLIGHT_CODES = new Set(['unknown_prototype', 'unknown_recipe', 'invalid_unit_number', 'invalid_target_kind', 'invalid_preflight_args'])
const MODEL_CORRECTABLE_PREFLIGHT_RETRY_BUDGET = 1
const RESEARCH_PREFLIGHT_RETRY_BUDGET = 2
const LOW_RISK_NAVIGATION_PROJECTION_MAX_CANDIDATES = 8
// Once the system commits a plan, its semantic content is immutable; later batches fulfil it rather than rewriting it.
const FROZEN_PLAN_STATUSES = new Set([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING])
const WORLD_STATE_REQUIREMENT_KINDS = new Set(['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'])
const EXACT_ENTITY_TARGET_OPERATIONS = new Set([
  'walk_to_entity_exact',
  'mine_entity_exact',
  'supply_entity',
  'rotate_entity',
  'move_items_exact',
  'set_machine_recipe',
  'launch_rocket',
])

const JEV_PIPELINE_RUNTIME_GUARDS = [
  ['decisionEnvelopeQuestions', typeof decisionEnvelopeQuestions],
  ['developmentDecisionQuestions', typeof developmentDecisionQuestions],
  ['boundarySteeringGate', typeof boundarySteeringGate],
  ['parseDecisionFamily', typeof parseDecisionFamily],
  ['steeringRecommendationQuestions', typeof steeringRecommendationQuestions],
  ['parseSteeringRecommendation', typeof parseSteeringRecommendation],
  ['parseBoundarySteeringTelemetry', typeof parseBoundarySteeringTelemetry],
  ['typedStateDistillationQuestions', typeof typedStateDistillationQuestions],
  ['parseTypedStateDistillation', typeof parseTypedStateDistillation],
  ['completionContractSupported', typeof completionContractSupported],
  ['sanitizeStepCompletionContract', typeof sanitizeStepCompletionContract],
  ['plannerControlPayloadFromMessage', typeof plannerControlPayloadFromMessage],
]
for (const [name, type] of JEV_PIPELINE_RUNTIME_GUARDS) {
  if (type !== 'function') throw new Error(`Jev pipeline dependency ${name} is unavailable`)
}

function steeringPressureFromReasonCodes(reasonCodes) {
  const codes = new Set(Array.isArray(reasonCodes) ? reasonCodes : [])
  return {
    vertical: STEERING_PRESSURE_VOCABULARY.vertical.filter(code => codes.has(code)),
    horizontal: STEERING_PRESSURE_VOCABULARY.horizontal.filter(code => codes.has(code)),
  }
}

const DURABLE_PLAN_PROMPT = `
## Durable goal and plan state

### Planner submission protocol

When tools are available, prefer the submitPlan control tool for the planner decision instead of serializing the whole decision as assistant JSON content. Your normal assistant content may be concise natural-language text for the human. Put canonical plan/currentStep/operations plus an optional checkpoint proposal in submitPlan.

submitPlan is a proposal boundary, not execution authority: the deterministic harness validates structured plan/checkpoint shape, Outcome Authority owns durable completion/blocking truth, and Autorio validates mutations before admission. Jev is not a plan-commit or operation-admission gate. Do not mix submitPlan with observation tool calls in the same assistant message. Observe first when needed, then submit one control decision.

Strict JSON assistant content is retained only as a compatibility/fallback path, especially when tools are disabled during bounded recovery. It is no longer the preferred normal-path protocol.

The Pterodactyl harness may provide two durable context blocks with different authority. [PLANNING_STATE] is the sole planning-semantic authority: it contains the user-owned Goal, non-executable Roadmap Shelf, reducer-owned Plan Tracker and advisory steering. [RUNTIME_COMPAT_STATE] is a legacy compatibility projection retained for runtime evidence, durable locators, recovery metadata and older integrations; its task_board/plan/current_step fields must never override, advance or reinterpret the Plan Tracker. Neither block is authoritative live Factorio state: re-observe mutable game state before depending on it.

Your plan/currentStep submission fields are proposals only. currentStep is advisory focus, not evidence that earlier work completed, and it cannot advance the reducer Plan Tracker. Only accepted grounded runtime evidence satisfying the committed step contract advances semantic progress. Compatibility Task Board counters may mirror that result for older consumers, but they are not a second planning authority.

For a multi-step request, keep the plan stable enough that the harness can track progress across Autorio batches. currentStep must identify the step you are actually executing or verifying now. If you replan, preserve already-completed intent instead of silently replacing the whole task with a vague new one.

Once a plan is COMMITTED its steps, their order and their completion meaning are frozen. Jev is outside plan-authoring and correctness authority. From that point you are fulfilling committed step checkpoints, not authoring them. Re-proposing different steps during ordinary continuation changes nothing; the committed plan is what runs. A committed plan is replaced only by an explicit user-approved revision, and a structural blocker or detected deadlock freezes it as BLOCKED and asks the user rather than silently replanning.

Within [PLANNING_STATE], Shelf nodes are storage: they record intent and lineage, never operations and never plan steps. Do not compile a shelf node into steps on your own initiative.

Every goal starts with a goal definition. On the FIRST plan of a goal, add goal to submitPlan: {scope, summary, doneWhen}. summary restates in one sentence what the player asked for; the player sees it in game as your understanding. doneWhen lists the game-checkable conditions that together prove the goal is complete (research_completed, rockets_launched, items_produced, inventory_count, space_location_unlocked) with exact Factorio internal names. rockets_launched and items_produced count from when the goal starts (countFrom "goal_start", the default), so "launch a rocket" needs a new launch; use countFrom "save_start" only when the player means the save's lifetime total. The harness, not you, decides completion: it reads doneWhen from the game at the end of every plan slice, so finishing a plan's steps never completes a goal by itself, and you never need to claim the goal is done. Use scope "finite" only when one plan of at most 30 steps completes the goal; otherwise use "long_horizon" and send the roadmap shelf on that same first plan. Omit goal on later plans of the same goal.

You author the shelf through the optional roadmap field on submitPlan: a short list of coarse nodes, each stating what should eventually be true for the goal and why it matters. Keep them at that altitude — a node is not a step, carries no operations, and never claims its own progress; the harness derives realization from verified results and strips anything executable. For a long-horizon goal, send the shelf on the first plan of that goal. Afterwards it only moves when verified world state has actually invalidated the guidance, so restate the nodes that still apply with their original ids (omitting a node marks it invalidated and keeps its lineage), and do not re-send an unchanged shelf just to restate a preference.

When a draft intentionally refines one or more existing Shelf nodes, add roadmapNodeIds beside plan/currentStep/operations and choose stable ids from [PLANNING_STATE].steering.refinement_candidates or the current shelf. On the first long-horizon submission you may create the shelf with roadmap and select ids from those same nodes in roadmapNodeIds. This is lineage, not execution authority; never invent an id for a node that is not on the admitted shelf.

For a bounded planning slice, add developmentMode as vertical, horizontal, maintain, or recover to describe the dominant direction YOU authored relative to the current critical path. Follow [PLANNING_STATE].steering when it remains appropriate, but this field describes the draft rather than granting steering authority. Small measured supporting work does not require a second mode; substantial mixed-direction work should be split at a better checkpoint.

For the active Plan Tracker step, you may add one optional root field named checkpoint beside chatMessage/plan/currentStep/operations. checkpoint is your semantic completion proposal for deterministic runtime validation and verification, not a claim that the step is already done. It must use a runtime-supported contract: {"mode":"all|any","requirements":[...]} with requirement kinds inventory_count, entity_inventory_count, entity_exists, entity_state, authoritative_operation_receipt, or runtime_controller_state. Prefer world-state outcomes over action occurrence. Example: if the step means "have 100 stone" and the next operation only gathers 40 more because 62 are already held, checkpoint must say inventory_count stone >= 100, not >= 40. The operation batch describes what to do next; checkpoint describes what would prove the semantic step complete. Runtime remains completion authority for supported deterministic contracts. Omit checkpoint when no safe deterministic predicate represents the step; prose-only semantic steps remain the Main LLM's responsibility rather than being delegated to a second AI judge.

For a prose-only active step that intentionally has no deterministic checkpoint, you may explicitly close that semantic step with semanticCompletion: {"stepId":"<exact active step id>","rationale":"..."}. Use the stable active step id from [PLANNING_STATE]. The harness accepts this only when the id is still current, the step has no deterministic completion contract, and recent authoritative runtime evidence or a fresh live observation grounds your judgment. Never use semanticCompletion to bypass an unmet deterministic checkpoint. You may pair a valid semanticCompletion with operations for the newly-active next step; the harness advances the semantic step first, then validates those operations normally.

Plan entries must represent goal-bearing Factorio work or verification. Do not add terminal lifecycle/meta steps such as "Stop", "Done", "Finish", or "Report completion"; stopping after the verified goal is represented by returning plan: [], currentStep: 0, operations: [].

An empty operations array normally means no new Autorio world action will happen after your reply. Never claim that a finite action is continuing when neither a new operation nor a live persistent runtime mode exists. Persistent controllers such as follow are different: if a read-only status tool proves the controller is active, healthy, and live, operations: [] may accurately describe that background mode without submitting a duplicate operation. When the whole requested goal is actually verified complete, return plan: [], currentStep: 0, operations: [], and say it is complete.

When finite canonical work remains but execution is truthfully impossible, keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or blocker. This is the explicit no-mutation blocker contract. Future-tense prose such as "I will take the items" is not a blocker and does not authorize the harness to invent an operation.

Before a non-empty operation batch, chatMessage should tell the human what concrete current plan step AIRI is about to attempt. Do not say mining, construction, transfer, crafting, or any other mutation has started unless that mutation is in the admitted/running operation batch or authoritative runtime evidence proves it. Navigation completion proves arrival only; it never proves that a later mining or construction action started. [MOD] completion/error messages may include a detailed getTaskStatus snapshot. Use that receipt plus any needed read-only verification to advance, replan, complete, or report a blocker.

Skill lifecycle is explicit. findSkills is discovery only: a search result is not a loaded skill and must not be relied on as the full pattern. Before following a discovered skill, call getSkillDetails for that exact id. A [SKILL_CONTEXT] message contains only skills explicitly opened with getSkillDetails for the current logical task. Reuse their structure and constraints, but revalidate mutable world state, recipes, inventory, geometry, and placement with live deterministic tools before acting.
`.trim()

function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function sanitizeDurableModelText(value, max = 2000) {
  let text = cleanMemoryText(value, max)
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return cleanMemoryText(JSON.stringify(sanitizeDurableModelValue(JSON.parse(trimmed))), max)
    }
    catch {}
  }
  text = text
    .replace(/(["']?(?:target_)?unit_number["']?\s*[:=]\s*)\d+/gi, '$1[historical-id-omitted]')
    .replace(/(["']?observed_unit_numbers["']?\s*[:=]\s*)\[[^\]]*\]/gi, '$1[historical-ids-omitted]')
    .replace(/\b(?:unit_number|target_unit_number)[_:#-]?\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\bunit[_:#-]\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\b(?:exact\s+entity\s+target\s+|target\s+)?unit\s+#?\d+\b/gi, 'historical exact identity [omitted]')
  return cleanMemoryText(text, max)
}

function sanitizeDurableModelValue(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeDurableModelValue(item))
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeDurableModelText(value, Math.max(2000, value.length)) : value
  }
  const staleExact = value.code === 'stale_exact_target' || value.reason_code === 'stale_exact_target'
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)unit_number$/i.test(key) || /(?:^|_)unit_numbers$/i.test(key)) continue
    if (key === 'unit' && Number.isSafeInteger(child)) continue
    if (staleExact && key === 'identity' && Number.isSafeInteger(child)) continue
    result[key] = sanitizeDurableModelValue(child)
  }
  return result
}

function durableEntityLocator(observation, semanticRole = '') {
  if (!observation || typeof observation !== 'object') return undefined
  const position = observation.position && Number.isFinite(observation.position.x) && Number.isFinite(observation.position.y)
    ? { x: observation.position.x, y: observation.position.y }
    : undefined
  const surface = typeof observation.surface === 'string' && observation.surface
    ? cleanMemoryText(observation.surface, 128)
    : undefined
  const locator = {
    name: typeof observation.name === 'string' ? cleanMemoryText(observation.name, 200) : undefined,
    type: typeof observation.type === 'string' ? cleanMemoryText(observation.type, 100) : undefined,
    surface,
    surface_index: Number.isSafeInteger(observation.surface_index) ? observation.surface_index : undefined,
    position,
    role: semanticRole ? sanitizeDurableModelText(semanticRole, 500) : undefined,
  }
  return Object.fromEntries(Object.entries(locator).filter(([, child]) => child !== undefined && child !== ''))
}

function durableOperationView(operation, { observation, semanticRole = '' } = {}) {
  if (!operation || typeof operation !== 'object') return sanitizeDurableModelValue(operation)
  const name = cleanMemoryText(operation.name, 100)
  const args = sanitizeDurableModelValue(operation.args ?? {})
  const hadExactIdentity = Number.isSafeInteger(operation.args?.unit_number)
  const targetLocator = durableEntityLocator(observation, semanticRole)
  return {
    name,
    args,
    ...(targetLocator && Object.keys(targetLocator).length > 0 ? { target_locator: targetLocator } : {}),
    ...(hadExactIdentity ? { exact_identity_lifetime: 'request_scoped; re-observe before any later exact operation' } : {}),
    ...(!targetLocator && semanticRole ? { role: sanitizeDurableModelText(semanticRole, 500) } : {}),
  }
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  try {
    const args = JSON.parse(value.slice(separator + 1))
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
    return { name: value.slice(0, separator), args }
  }
  catch {
    return undefined
  }
}

function storedOperationView(value, semanticRole = '', observation) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.target_locator || value.exact_identity_lifetime) return sanitizeDurableModelValue(value)
    return durableOperationView(value, { observation, semanticRole })
  }
  const parsed = parseStoredOperation(value)
  if (parsed) return durableOperationView(parsed, { observation, semanticRole })
  return sanitizeDurableModelText(value, 800)
}

function historicalExactTargetLocator(state, unitNumber) {
  if (!state || !Number.isSafeInteger(unitNumber)) return undefined
  const role = currentPlanStep(state.plan, state.current_step)
  for (const entry of [...(Array.isArray(state.exact_target_audit) ? state.exact_target_audit : [])].reverse()) {
    if (entry?.unit_number === unitNumber && entry.locator) return sanitizeDurableModelValue(entry.locator)
  }
  const raw = Array.isArray(state.last_operations) ? state.last_operations : []
  const durable = Array.isArray(state.durable_last_operations) ? state.durable_last_operations : []
  for (let index = raw.length - 1; index >= 0; index--) {
    const operation = parseStoredOperation(raw[index])
    if (operation?.args?.unit_number !== unitNumber) continue
    const locator = durable[index]?.target_locator
    if (locator) return sanitizeDurableModelValue(locator)
  }
  const evidence = Array.isArray(state.task_board?.evidence) ? state.task_board.evidence : []
  for (const item of [...evidence].reverse()) {
    if (typeof item?.summary !== 'string') continue
    try {
      const parsed = JSON.parse(item.summary)
      if (parsed?.identity === unitNumber && parsed?.last_observed) {
        return durableEntityLocator(parsed.last_observed, role)
      }
      const basic = parsed?.basic_operation
      if (basic?.target_unit_number === unitNumber) {
        return durableEntityLocator({ name: basic.entity_name }, role)
      }
    }
    catch {}
  }
  return undefined
}

function modelFacingLastOperations(state) {
  const role = currentPlanStep(state?.plan, state?.current_step)
  const durable = Array.isArray(state?.durable_last_operations) && state.durable_last_operations.length > 0
    ? state.durable_last_operations
    : undefined
  if (durable) return durable.slice(-16).map(operation => storedOperationView(operation, role))
  return (Array.isArray(state?.last_operations) ? state.last_operations : []).slice(-16).map((value) => {
    const parsed = parseStoredOperation(value)
    const unitNumber = parsed?.args?.unit_number
    const locator = Number.isSafeInteger(unitNumber) ? historicalExactTargetLocator(state, unitNumber) : undefined
    return storedOperationView(value, role, locator)
  })
}

function modelFacingEntityReferences(state) {
  if (!state) return []
  const role = currentPlanStep(state.plan, state.current_step)
  const references = []
  for (const entry of Array.isArray(state.exact_target_audit) ? state.exact_target_audit : []) {
    if (entry?.locator) references.push(sanitizeDurableModelValue(entry.locator))
  }
  for (const operation of Array.isArray(state.durable_last_operations) ? state.durable_last_operations : []) {
    if (operation?.target_locator) references.push(sanitizeDurableModelValue(operation.target_locator))
  }
  for (const item of Array.isArray(state.task_board?.evidence) ? state.task_board.evidence : []) {
    if (typeof item?.summary !== 'string') continue
    try {
      const parsed = JSON.parse(item.summary)
      if (parsed?.last_observed) references.push(durableEntityLocator(parsed.last_observed, role))
    }
    catch {}
  }
  const unique = new Map()
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue
    const safe = sanitizeDurableModelValue(reference)
    const position = safe.position
    const key = JSON.stringify([
      safe.name ?? '',
      safe.type ?? '',
      safe.surface ?? '',
      safe.surface_index ?? '',
      position?.x ?? '',
      position?.y ?? '',
      safe.role ?? '',
    ])
    unique.set(key, safe)
  }
  return [...unique.values()].slice(-16)
}

function modelFacingTaskBoard(board) {
  return sanitizeDurableModelValue(visibleTaskBoard(board))
}

function sanitizeTraceValue(value, key = '') {
  if (SENSITIVE_TRACE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .slice(0, 20000)
  }
  if (Array.isArray(value)) return value.map(item => sanitizeTraceValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeTraceValue(childValue, childKey)]))
}

function safePlan(plan) {
  return normalizeCanonicalPlan(plan).plan
}

function currentPlanStep(plan, currentStep) {
  if (!Array.isArray(plan) || plan.length === 0) return ''
  return plan[Math.min(Math.max(currentStep, 0), plan.length - 1)] ?? ''
}

function safePersistentRuntime(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.kind !== 'follow') return undefined
  return {
    kind: 'follow',
    active: value.active === true,
    healthy: value.healthy === true,
    controller_live: value.controller_live === true,
    state: cleanMemoryText(value.state, 32),
    target_player: cleanMemoryText(value.target_player, 128),
    current_distance: Number.isFinite(value.current_distance) ? value.current_distance : undefined,
    desired_distance: Number.isFinite(value.desired_distance) ? value.desired_distance : undefined,
    last_progress_tick: Number.isFinite(value.last_progress_tick) ? value.last_progress_tick : undefined,
    stuck_for_ticks: Number.isFinite(value.stuck_for_ticks) ? value.stuck_for_ticks : undefined,
    path_request_id: Number.isSafeInteger(value.path_request_id) ? value.path_request_id : undefined,
    path_attempts: Number.isSafeInteger(value.path_attempts) ? value.path_attempts : undefined,
    waypoints_remaining: Number.isSafeInteger(value.waypoints_remaining) ? value.waypoints_remaining : undefined,
    last_repath_tick: Number.isFinite(value.last_repath_tick) ? value.last_repath_tick : undefined,
    last_failure: cleanMemoryText(value.last_failure, 300),
  }
}

function safeConditionWait(value) {
  if (!value || typeof value !== 'object' || value.state !== 'active') return undefined
  const condition = value.condition
  if (!condition || typeof condition !== 'object') return undefined
  if (!['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(condition.kind)) return undefined
  if (['entity_inventory_count', 'entity_exists', 'entity_state'].includes(condition.kind)
    && (!Number.isSafeInteger(condition.unit_number) || condition.unit_number < 1)) return undefined
  if (['inventory_count', 'entity_inventory_count'].includes(condition.kind)
    && (typeof condition.item_name !== 'string' || !Number.isSafeInteger(condition.minimum) || condition.minimum < 1)) return undefined
  if (condition.kind === 'entity_state' && !['working', 'not_working', 'exists'].includes(condition.expected)) return undefined
  if (!Number.isSafeInteger(value.actor_id) || value.actor_id < 1) return undefined
  if (!Number.isSafeInteger(value.actor_epoch) || value.actor_epoch < 0) return undefined

  const safeCondition = { kind: condition.kind }
  if (Number.isSafeInteger(condition.unit_number)) safeCondition.unit_number = condition.unit_number
  if (typeof condition.item_name === 'string') safeCondition.item_name = cleanMemoryText(condition.item_name, 160)
  if (Number.isSafeInteger(condition.minimum)) safeCondition.minimum = condition.minimum
  if (typeof condition.expected === 'string') safeCondition.expected = condition.expected

  return {
    id: cleanMemoryText(value.id, 100),
    goal_id: cleanMemoryText(value.goal_id, 100),
    step_id: cleanMemoryText(value.step_id, 80),
    actor_id: value.actor_id,
    actor_epoch: value.actor_epoch,
    mode: value.mode === 'passive_progress' ? 'passive_progress' : 'completion',
    condition: safeCondition,
    state: 'active',
    checks: Number.isSafeInteger(value.checks) ? Math.max(0, value.checks) : 0,
    max_checks: Number.isSafeInteger(value.max_checks) ? Math.max(1, Math.min(value.max_checks, 7200)) : 900,
    timeout_ms: Number.isSafeInteger(value.timeout_ms) ? Math.max(1000, Math.min(value.timeout_ms, 2 * 60 * 60 * 1000)) : 30 * 60 * 1000,
    registered_at: Number.isFinite(value.registered_at) ? value.registered_at : Date.now(),
    updated_at: Number.isFinite(value.updated_at) ? value.updated_at : Date.now(),
  }
}

function safeProviderRecovery(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.kind === 'output_budget_exhaustion' && value.phase === 'in_flight') {
    return {
      kind: 'output_budget_exhaustion',
      phase: 'in_flight',
      goal_id: cleanMemoryText(value.goal_id, 100),
      step_id: cleanMemoryText(value.step_id, 120),
      started_at: Number.isFinite(value.started_at) ? value.started_at : Date.now(),
    }
  }
  if (value.kind !== 'budget_handoff' || value.phase !== 'planner_pending') return undefined
  const semanticScope = RECOVERY_SEMANTIC_SCOPES.has(value.semantic_scope) ? value.semantic_scope : 'keep_target'
  const route = ['wake_planner', 'targeted_observation', 'retry_compact', 'continue_low', 'replan_high'].includes(value.route)
    ? value.route
    : 'wake_planner'
  return {
    kind: 'budget_handoff',
    phase: 'planner_pending',
    goal_id: cleanMemoryText(value.goal_id, 100),
    step_id: cleanMemoryText(value.step_id, 120),
    semantic_scope: semanticScope,
    route,
    reason: cleanMemoryText(value.reason, 1200),
    budget_generation: Number.isSafeInteger(value.budget_generation)
      ? Math.max(2, Math.min(value.budget_generation, 1000000))
      : 2,
    handoff_count: Number.isSafeInteger(value.handoff_count)
      ? Math.max(1, Math.min(value.handoff_count, 16))
      : 1,
    started_at: Number.isFinite(value.started_at) ? value.started_at : Date.now(),
  }
}

function worldStateContract(contract) {
  return completionContractSupported(contract)
    && contract.mode !== 'semantic_unknown'
    && contract.requirements?.length > 0
    && contract.requirements.every(requirement => WORLD_STATE_REQUIREMENT_KINDS.has(requirement?.kind))
}

function activeStepCheckpointSnapshot(board) {
  const index = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
  const step = index === undefined ? undefined : board?.steps?.[index]
  return step ? { stepId: step.id, checkpoint: persistedStepCheckpoint(board, step.id) } : undefined
}

function persistedStepCheckpoint(board, stepId) {
  if (!board || !stepId) return undefined
  const step = Array.isArray(board.steps) ? board.steps.find(item => item?.id === stepId) : undefined
  const contract = sanitizeStepCompletionContract(step?.completion_contract)
  return completionContractSupported(contract) ? { contract, durable: true } : undefined
}

function conditionWaitLifecycleMatches(wait, deployment) {
  return Boolean(wait
    && deployment
    && Number.isSafeInteger(wait.actor_id)
    && Number.isSafeInteger(wait.actor_epoch)
    && wait.actor_id === deployment.actor_id
    && wait.actor_epoch === deployment.epoch)
}

function normalizedConditionObservation(observation) {
  return observation?.ok === true
    ? {
        satisfied: observation.satisfied === true,
        progressing: observation.progressing === true,
        progress_known: observation.progress_known === true,
        summary: cleanMemoryText(JSON.stringify({
          kind: observation.kind,
          current: observation.current,
          minimum: observation.minimum,
          unit_number: observation.unit_number,
          entity_status: observation.entity_status,
          progressing: observation.progressing,
        }), 600),
      }
    : {
        stale: observation?.stale === true,
        error: cleanMemoryText(observation?.error || 'condition_evaluation_failed', 160),
      }
}

function visibleTaskBoard(board) {
  if (!board || board.kind !== 'task_board_lite') return undefined
  return {
    kind: board.kind,
    goal_id: board.goal_id,
    status: board.status,
    blocker: board.blocker,
    pause_reason: board.pause_reason,
    revision: board.revision,
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    active_step_id: board.active_step_id,
    proposed_focus_index: board.proposed_focus_index,
    proposed_focus_step_id: board.proposed_focus_step_id,
    steps: board.steps,
    evidence: (board.evidence ?? []).slice(-8),
    events: (board.events ?? []).slice(-12),
  }
}

function compactBasicOperationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  return {
    operation_id: Number.isSafeInteger(result.operation_id) ? result.operation_id : undefined,
    tick: Number.isFinite(result.tick) ? result.tick : undefined,
    actor_id: Number.isSafeInteger(result.actor_id) ? result.actor_id : undefined,
    type: typeof result.type === 'string' ? cleanMemoryText(result.type, 64) : undefined,
    accepted: result.accepted === true,
    completed: result.completed === true,
    code: typeof result.code === 'string' ? cleanMemoryText(result.code, 64) : undefined,
    entity_name: typeof result.entity_name === 'string' ? cleanMemoryText(result.entity_name, 200) : undefined,
    target_unit_number: Number.isSafeInteger(result.target_unit_number) ? result.target_unit_number : undefined,
    player_name: typeof result.player_name === 'string' ? cleanMemoryText(result.player_name, 128) : undefined,
    item_name: typeof result.item_name === 'string' ? cleanMemoryText(result.item_name, 200) : undefined,
    requested_count: Number.isSafeInteger(result.requested_count) ? result.requested_count : undefined,
    moved_count: Number.isSafeInteger(result.moved_count) ? result.moved_count : undefined,
    placed_unit_number: Number.isSafeInteger(result.placed_unit_number) ? result.placed_unit_number : undefined,
    placed_entity_type: typeof result.placed_entity_type === 'string' ? cleanMemoryText(result.placed_entity_type, 100) : undefined,
    placed_position: result.placed_position && Number.isFinite(result.placed_position.x) && Number.isFinite(result.placed_position.y)
      ? { x: result.placed_position.x, y: result.placed_position.y }
      : undefined,
    placed_surface_index: Number.isSafeInteger(result.placed_surface_index) ? result.placed_surface_index : undefined,
    placed_direction: Number.isSafeInteger(result.placed_direction) ? result.placed_direction : undefined,
    to_entity: typeof result.to_entity === 'boolean' ? result.to_entity : undefined,
    to_player: typeof result.to_player === 'boolean' ? result.to_player : undefined,
    rocket_parts: Number.isSafeInteger(result.rocket_parts) ? result.rocket_parts : undefined,
    rocket_parts_required: Number.isSafeInteger(result.rocket_parts_required) ? result.rocket_parts_required : undefined,
    rockets_launched: Number.isSafeInteger(result.rockets_launched) ? result.rockets_launched : undefined,
  }
}

const BASIC_OPERATION_TASK_TYPE = new Map([
  ['walking_to_entity', 'walking_to_entity'],
  ['mining', 'mining'],
  ['placing', 'placing'],
  ['moving_items', 'moving_items'],
  ['setting_recipe', 'setting_recipe'],
  ['launching_rocket', 'launching_rocket'],
  ['crafting', 'crafting'],
  ['attacking', 'attacking'],
])

export function correlateBasicOperationResult(receipt, result, { actorId } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result: undefined }
  const reasons = []
  const expectedTaskType = BASIC_OPERATION_TASK_TYPE.get(result.type)
  if (!expectedTaskType || !Array.isArray(receipt?.task_types) || !receipt.task_types.includes(expectedTaskType)) {
    reasons.push('task_type_mismatch')
  }
  if (Number.isFinite(receipt?.tick)) {
    if (!Number.isFinite(result.tick)) reasons.push('missing_tick_identity')
    else if (receipt.tick !== result.tick) reasons.push('tick_mismatch')
  }
  if (Number.isSafeInteger(actorId)) {
    if (!Number.isSafeInteger(result.actor_id)) reasons.push('missing_actor_identity')
    else if (actorId !== result.actor_id) reasons.push('actor_mismatch')
  }
  return reasons.length > 0
    ? { result: undefined, stale: { code: 'stale_operation_result', reasons, operation_id: result.operation_id } }
    : { result: compactBasicOperationResult(result) }
}

export function receiptEvidence(raw, outcome, context = {}) {
  try {
    const parsed = JSON.parse(raw)
    const receipt = outcome === 'failed'
      ? (parsed?.last_cancelled_batch ?? parsed?.last_completed_batch)
      : (parsed?.last_completed_batch ?? parsed?.last_cancelled_batch)
    const batchId = Number.isSafeInteger(receipt?.batch_id) ? receipt.batch_id : undefined
    const batchGeneration = Number.isSafeInteger(receipt?.batch_generation) ? receipt.batch_generation : undefined
    const batchRef = typeof receipt?.batch_ref === 'string' && receipt.batch_ref.length > 0
      ? cleanMemoryText(receipt.batch_ref, 160)
      : undefined
    const correlated = correlateBasicOperationResult(receipt, parsed?.basic_operation?.last_result, {
      actorId: context.actor_id ?? parsed?.actor?.actor_id,
    })
    return {
      kind: outcome === 'failed' ? 'operation_error_receipt' : 'operation_receipt',
      ref: batchRef ?? (batchId === undefined ? '' : `batch_${batchId}`),
      summary: JSON.stringify({
        outcome,
        task_state: parsed?.task_state,
        queue_length: parsed?.queue_length,
        batch_id: batchId,
        batch_generation: batchGeneration,
        batch_ref: batchRef,
        task_count: receipt?.task_count,
        task_types: Array.isArray(receipt?.task_types) ? receipt.task_types.slice(0, 16) : undefined,
        tick: receipt?.tick,
        reason: receipt?.reason,
        basic_operation: correlated.result,
        stale_operation_result: correlated.stale,
        correlation: {
          goal_id: context.goal_id,
          step_id: context.step_id,
          actor_id: context.actor_id,
          actor_epoch: context.actor_epoch,
        },
      }),
    }
  }
  catch {
    return {
      kind: outcome === 'failed' ? 'operation_error_receipt' : 'operation_receipt',
      ref: '',
      summary: cleanMemoryText(raw, 1200),
    }
  }
}

export class NpcDialogueMemory extends BaseNpcDialogueMemory {
  constructor(options = {}) {
    super(options)
    this.planByNpc = new Map()
    this.nextContextOverride = new Map()
  }

  ensureTaskBoard(state) {
    if (!state) return undefined
    if (!state.task_board) {
      state.task_board = sanitizeTaskBoard(undefined, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now: state.updated_at,
      })
      state.task_board = setTaskBoardStatus(state.task_board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now: state.updated_at,
      })
    }
    return state.task_board
  }

  remember(key, turnId, { sender, user, assistant, operations = [] }) {
    const bucket = this.bucket(key)
    const actionText = operations.length
      ? cleanMemoryText(operations.map(operation => JSON.stringify(storedOperationView(operation))).join('; '), this.maxFieldChars)
      : ''
    const next = {
      id: turnId,
      sender: cleanMemoryText(sender, 128),
      user: cleanMemoryText(user, this.maxFieldChars),
      assistant: cleanMemoryText(assistant, this.maxFieldChars),
      actions: actionText,
    }
    const index = bucket.recent.findIndex(turn => turn.id === turnId)
    if (index >= 0) {
      const previous = bucket.recent[index]
      next.actions = actionText || previous.actions
      bucket.recent[index] = next
    }
    else {
      bucket.recent.push(next)
    }
    this.compact(bucket)
  }

  dialogueContext(key) {
    const bucket = this.byNpc.get(key)
    if (!bucket || (!bucket.summary && bucket.recent.length === 0)) return ''
    const lines = [
      '[MEMORY] Bounded prior dialogue for this NPC. Historical exact entity identities are non-executable; re-observe mutable game state before depending on it.',
    ]
    if (bucket.summary) lines.push(`Compacted earlier dialogue:\n${sanitizeDurableModelText(bucket.summary, this.maxSummaryChars)}`)
    if (bucket.recent.length) {
      lines.push('Recent dialogue:')
      for (const turn of bucket.recent) {
        lines.push(`[CHAT] ${sanitizeDurableModelText(turn.sender, 128)}: ${sanitizeDurableModelText(turn.user, this.maxFieldChars)}`)
        lines.push(`[AIRI] ${sanitizeDurableModelText(turn.assistant, this.maxFieldChars)}`)
        if (turn.actions) lines.push(`[ACTIONS] ${sanitizeDurableModelText(turn.actions, this.maxFieldChars)}`)
      }
    }
    const text = lines.join('\n')
    if (text.length <= this.maxContextChars) return text
    const prefix = `${lines[0]}\nCompacted earlier dialogue:\n[older memory compacted]\n`
    return `${prefix}${text.slice(-Math.max(0, this.maxContextChars - prefix.length))}`
  }

  planContext(key) {
    const state = this.planByNpc.get(key)
    if (!state) return ''
    const taskBoard = this.ensureTaskBoard(state)
    const visible = {
      goal_id: sanitizeDurableModelText(state.goal_id, 100),
      owner: sanitizeDurableModelText(state.owner, 128),
      objective: sanitizeDurableModelText(state.objective, 1000),
      status: state.status,
      admission_status: state.admission_status,
      blocker: sanitizeDurableModelText(state.blocker, 500),
      pause_reason: sanitizeDurableModelText(state.pause_reason, 300),
      persistent_runtime: sanitizeDurableModelValue(state.persistent_runtime),
      task_board: modelFacingTaskBoard(taskBoard),
      entity_references: modelFacingEntityReferences(state),
      plan: (state.plan ?? []).map(step => sanitizeDurableModelText(step, 500)),
      current_step: state.current_step,
      current_step_text: sanitizeDurableModelText(currentPlanStep(state.plan, state.current_step), 500),
      revision: state.revision,
      last_chat_message: sanitizeDurableModelText(state.last_chat_message, 2000),
      last_operations: modelFacingLastOperations(state),
      history: (state.history ?? []).slice(-8).map(entry => sanitizeDurableModelValue(entry)),
    }
    return `[PLAN_STATE] Harness-owned durable goal/plan state. Absolute location and semantic role may be durable, but any historical unit_number is non-executable. Re-observe the current entity in this active request before issuing an exact operation.\n${JSON.stringify(visible)}`
  }

  setNextContextOverride(key, content) {
    if (!key || typeof content !== 'string' || content.length === 0) return
    this.nextContextOverride.set(key, content)
  }

  context(key) {
    const override = this.nextContextOverride.get(key)
    if (override !== undefined) {
      this.nextContextOverride.delete(key)
      return override
    }
    return [this.dialogueContext(key), this.planContext(key)].filter(Boolean).join('\n')
  }

  clearTaskContext(key) {
    const result = super.clearTaskContext(key)
    if (key) this.nextContextOverride.delete(key)
    return result
  }

  currentPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    this.ensureTaskBoard(state)
    return state
  }

  setProviderRecovery(key, recovery) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return state
    if (!recovery) {
      state.provider_recovery = undefined
    }
    else {
      state.provider_recovery = safeProviderRecovery({
        ...recovery,
        kind: recovery.kind === 'budget_handoff' ? 'budget_handoff' : 'output_budget_exhaustion',
        phase: recovery.kind === 'budget_handoff' ? 'planner_pending' : 'in_flight',
        goal_id: recovery.goal_id ?? state.goal_id,
        step_id: recovery.step_id ?? state.task_board?.active_step_id,
        started_at: Number.isFinite(recovery.started_at) ? recovery.started_at : Date.now(),
      })
    }
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  applyOutcomeAuthority(key, candidate, { world = {}, chatMessage = '' } = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    const decision = validateOutcomeCandidate(candidate, { world })
    if (!state || !decision.accepted) return { state, decision, changed: false }

    const now = Date.now()
    const previousStatus = state.status
    let board = this.ensureTaskBoard(state)
    const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : []
    for (const item of evidence) {
      if (!item || typeof item !== 'object') continue
      const duplicate = (board?.evidence ?? []).some(existing => existing?.kind === item.kind && item.ref && existing?.ref === item.ref)
      if (!duplicate) board = addTaskBoardEvidence(board, { ...item, now: Number.isFinite(item.now) ? item.now : now })
    }
    if (decision.durable_status === 'completed' && candidate?.metadata?.scope === 'step') {
      const activeStepId = board?.active_step_id
      const candidateKeys = evidence
        .filter(item => item && typeof item === 'object' && typeof item.kind === 'string' && item.kind && typeof item.ref === 'string' && item.ref)
        .map(item => ({ kind: item.kind, ref: item.ref }))
      const boundToActiveStep = Boolean(activeStepId) && candidateKeys.some(key =>
        (board?.evidence ?? []).some(existing => existing?.kind === key.kind && existing?.ref === key.ref && existing?.step_id === activeStepId))
      if (!boundToActiveStep) {
        state.task_board = board
        this.planByNpc.set(key, state)
        return {
          state,
          decision: { ...decision, accepted: false, rejection_reason: 'completion_evidence_not_bound_to_active_step' },
          changed: false,
        }
      }
    }

    if (decision.durable_status === 'blocked') {
      state.status = 'blocked'
      if (state.admission_status !== 'admission_failed') state.admission_status = undefined
      state.blocker = cleanMemoryText(decision.blocker || candidate?.candidate_blocker || decision.reason_code, 500)
      state.pause_reason = ''
      state.persistent_runtime = undefined
      state.condition_wait = undefined
      board = setTaskBoardStatus(board, 'blocked', { blocker: state.blocker, now })
    }
    else if (decision.durable_status === 'paused') {
      state.status = 'paused'
      state.blocker = ''
      state.pause_reason = cleanMemoryText(decision.pause_reason || decision.reason_code, 300)
      state.persistent_runtime = undefined
      state.condition_wait = undefined
      board = setTaskBoardStatus(board, 'paused', { pauseReason: state.pause_reason, now })
    }
    else if (decision.durable_status === 'completed') {
      const stepScope = candidate?.metadata?.scope === 'step'
      const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : 0
      const finalIndex = Array.isArray(board?.steps) ? board.steps.length - 1 : -1
      if (stepScope && activeIndex >= 0 && activeIndex < finalIndex) {
        const nextIndex = activeIndex + 1
        board = reconcileTaskBoard(
          board,
          board.steps.map(step => step.description),
          nextIndex,
          { now, authoritativeAdvance: true },
        )
        state.status = 'active'
        state.admission_status = undefined
        state.blocker = ''
        state.pause_reason = ''
        state.condition_wait = undefined
        state.plan = board.steps.map(step => step.description)
        state.current_step = board.active_index
      }
      else {
        state.status = 'completed'
        state.admission_status = undefined
        state.blocker = ''
        state.pause_reason = ''
        state.persistent_runtime = undefined
        state.condition_wait = undefined
        board = setTaskBoardStatus(board, 'completed', { now })
        state.plan = []
        state.current_step = 0
      }
    }
    else if (decision.durable_status === 'active' && state.status === 'active') {
      state.blocker = ''
      state.pause_reason = ''
      board = setTaskBoardStatus(board, 'active', { now })
    }

    if (chatMessage) state.last_chat_message = cleanMemoryText(chatMessage, 2000)
    state.task_board = board
    if (previousStatus !== state.status) {
      state.history = [...(state.history ?? []), {
        revision: state.revision,
        status: previousStatus,
        current_step: state.current_step,
        step: currentPlanStep(state.plan, state.current_step),
        chat: state.last_chat_message,
      }].slice(-PLAN_HISTORY_LIMIT)
    }
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return { state, decision, changed: previousStatus !== state.status || evidence.length > 0 || candidate?.metadata?.scope === 'step' }
  }

  registerConditionWait(key, wait) {
    const state = key ? this.planByNpc.get(key) : undefined
    const safe = safeConditionWait(wait)
    if (!state || !safe || state.status !== 'active' || safe.goal_id !== state.goal_id || safe.step_id !== state.task_board?.active_step_id) return undefined
    state.condition_wait = safe
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  updateConditionWait(key, wait) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !wait || state.condition_wait?.id !== wait.id) return undefined
    if (wait.state === 'active') state.condition_wait = safeConditionWait(wait)
    else state.condition_wait = undefined
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  clearConditionWait(key, id) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !state.condition_wait || (id && state.condition_wait.id !== id)) return state
    state.condition_wait = undefined
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  recordPlan(key, requestInfo, plan, { continuation = false, persistentRuntime, durableOperations = [], exactTargetAudit = [], verifiedCompletion = false, completionEvidence = [] } = {}) {
    const previous = this.planByNpc.get(key)
    const hasOperations = plan.operations.length > 0
    const incomingDurableOperations = (Array.isArray(durableOperations) ? durableOperations : []).slice(0, 16).map(operation => sanitizeDurableModelValue(operation))
    const mergedExactTargetAudit = [
      ...(Array.isArray(previous?.exact_target_audit) ? previous.exact_target_audit : []),
      ...(Array.isArray(exactTargetAudit) ? exactTargetAudit : []),
    ].slice(-32)
    const normalized = normalizeCanonicalPlan(plan.plan, plan.currentStep)
    const incomingPlan = normalized.plan
    const now = Date.now()
    const runtime = safePersistentRuntime(persistentRuntime)
    const runtimeHealthy = runtime?.active === true && runtime.healthy === true && runtime.controller_live === true

    if (!hasOperations && !continuation && !runtimeHealthy && !verifiedCompletion) {
      return { state: previous, blockedByHarness: false, changed: false }
    }

    const history = previous
      ? [...previous.history, {
          revision: previous.revision,
          status: previous.status,
          current_step: previous.current_step,
          step: currentPlanStep(previous.plan, previous.current_step),
          chat: previous.last_chat_message,
        }].slice(-PLAN_HISTORY_LIMIT)
      : []

    if (hasOperations) {
      const state = {
        goal_id: previous?.goal_id ?? `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? previous?.owner ?? 'unknown', 128),
        objective: cleanMemoryText(previous?.objective ?? requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: 'proposed',
        blocker: '',
        pause_reason: '',
        persistent_runtime: previous?.persistent_runtime,
        condition_wait: undefined,
        plan: incomingPlan,
        current_step: previous?.current_step ?? 0,
        revision: (previous?.revision ?? 0) + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: plan.operations.slice(0, 16).map(operation => cleanMemoryText(`${operation.name} ${JSON.stringify(operation.args ?? {})}`, 800)),
        durable_last_operations: incomingDurableOperations,
        exact_target_audit: mergedExactTargetAudit,
        last_mutation_verified: false,
        last_verified_batch_id: undefined,
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: false, changed: true }
    }

    if (runtimeHealthy && incomingPlan.length > 0) {
      const state = {
        ...(previous ?? {}),
        goal_id: previous?.goal_id ?? `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? previous?.owner ?? 'unknown', 128),
        objective: cleanMemoryText(previous?.objective ?? requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: undefined,
        blocker: '',
        pause_reason: '',
        persistent_runtime: runtime,
        condition_wait: previous?.condition_wait,
        plan: incomingPlan,
        current_step: previous?.current_step ?? 0,
        revision: (previous?.revision ?? 0) + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: [],
        durable_last_operations: [],
        exact_target_audit: mergedExactTargetAudit,
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: false, persistentRuntimeActive: true, changed: true }
    }

    if (!previous) return { state: undefined, blockedByHarness: false, changed: false }

    const state = {
      ...previous,
      plan: incomingPlan.length > 0 ? incomingPlan : previous.plan,
      current_step: previous.current_step,
      last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
      durable_last_operations: [],
      exact_target_audit: mergedExactTargetAudit,
      updated_at: now,
      history,
    }
    this.planByNpc.set(key, state)

    if (verifiedCompletion) {
      const reduced = this.applyOutcomeAuthority(key, {
        kind: 'verified_complete',
        source: 'deterministic_runtime',
        reason_code: 'verified_final_step',
        evidence: completionEvidence,
      }, { chatMessage: plan.chatMessage })
      return { state: reduced.state, blockedByHarness: false, changed: reduced.changed, outcomeDecision: reduced.decision }
    }

    return { state, blockedByHarness: false, changed: incomingPlan.length > 0 }
  }

  reconcileTaskBoard(key, previousBoard, plan, stateResult, { allowReplan = false, authoritativeAdvance = false } = {}) {
    const state = stateResult?.state
    if (!state) return stateResult
    const now = state.updated_at ?? Date.now()
    let board = previousBoard
      ? sanitizeTaskBoard(previousBoard, { fallbackPlan: state.plan, fallbackCurrentStep: state.current_step, goalId: state.goal_id, now })
      : sanitizeTaskBoard(state.task_board, { fallbackPlan: state.plan, fallbackCurrentStep: state.current_step, goalId: state.goal_id, now })

    if (state.status === 'completed') {
      board = setTaskBoardStatus(board, 'completed', { now })
    }
    else {
      board = reconcileTaskBoard(board, plan.plan, plan.currentStep, { now, allowReplan, authoritativeAdvance })
      board = setTaskBoardStatus(board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now,
      })
    }

    state.task_board = board
    if (state.status !== 'completed') {
      state.plan = board.steps.map(step => step.description)
      state.current_step = board.active_index
    }
    this.planByNpc.set(key, state)
    return { ...stateResult, state }
  }

  recordBoardEvidence(key, evidence) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const board = this.ensureTaskBoard(state)
    state.task_board = addTaskBoardEvidence(board, evidence)
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state.task_board
  }

  setAdmissionState(key, admissionStatus, { blocker = '', evidence } = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    state.admission_status = admissionStatus
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    if (admissionStatus !== 'admission_failed') return state

    return this.applyOutcomeAuthority(key, {
      kind: 'world_blocked',
      source: 'deterministic_runtime',
      reason_code: blocker || 'operation_admission_failed',
      candidate_blocker: blocker || 'operation_admission_failed',
      evidence: evidence ? [evidence] : [],
    }).state
  }

  beginActionOmissionRecovery(key, requestInfo, plan) {
    const previous = key ? this.planByNpc.get(key) : undefined
    const now = Date.now()
    if (!previous) {
      const incomingPlan = safePlan(plan?.plan)
      if (incomingPlan.length === 0) return undefined
      const incomingStep = 0
      const state = {
        goal_id: `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? 'unknown', 128),
        objective: cleanMemoryText(requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: 'action_omission_repair',
        blocker: '',
        pause_reason: '',
        persistent_runtime: undefined,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: 1,
        last_chat_message: cleanMemoryText(plan?.chatMessage, 2000),
        last_operations: [],
        durable_last_operations: [],
        exact_target_audit: [],
        last_mutation_verified: false,
        last_verified_batch_id: undefined,
        updated_at: now,
        history: [],
      }
      state.task_board = sanitizeTaskBoard(undefined, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now,
      })
      state.task_board = setTaskBoardStatus(state.task_board, 'active', { now })
      this.planByNpc.set(key, state)
      return state
    }

    if (previous.status !== 'active') return previous
    previous.admission_status = 'action_omission_repair'
    previous.blocker = ''
    previous.pause_reason = ''
    previous.task_board = setTaskBoardStatus(this.ensureTaskBoard(previous), 'active', { now })
    previous.revision += 1
    previous.updated_at = now
    this.planByNpc.set(key, previous)
    return previous
  }

  blockRemainingPlan(key, { blocker, reason = '', chatMessage = '', evidenceKind = 'lifecycle_blocker' } = {}) {
    const evidence = reason
      ? [{
          kind: evidenceKind,
          ref: `${this.planByNpc.get(key)?.goal_id ?? 'goal'}/${cleanMemoryText(blocker || 'blocker', 120)}`,
          summary: JSON.stringify({ blocker, reason: sanitizeDurableModelText(reason, 1200) }),
        }]
      : []
    return this.applyOutcomeAuthority(key, {
      kind: 'world_blocked',
      source: evidenceKind === 'provider_blocker' ? 'main_planner' : 'deterministic_runtime',
      reason_code: blocker || 'candidate_world_blocker',
      candidate_blocker: blocker || 'candidate_world_blocker',
      evidence,
    }, { chatMessage }).state
  }

  pausePlan(key, reason = 'cancelled') {
    return this.applyOutcomeAuthority(key, {
      kind: 'cancelled',
      source: 'server_lifecycle',
      reason_code: reason,
      metadata: {
        server_authoritative: true,
        transition: 'paused',
        pause_reason: reason,
      },
    }).state
  }

  maxTurnId() {
    let max = 0
    for (const bucket of this.byNpc.values()) {
      for (const turn of bucket.recent ?? []) if (Number.isSafeInteger(turn.id)) max = Math.max(max, turn.id)
    }
    return max
  }

  snapshot() {
    return {
      version: STATE_SCHEMA,
      dialogue: [...this.byNpc.entries()].map(([key, bucket]) => ({ key, summary: bucket.summary, recent: bucket.recent })),
      plans: [...this.planByNpc.entries()].map(([key, state]) => ({ key, state })),
    }
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== STATE_SCHEMA || !Array.isArray(snapshot.dialogue) || !Array.isArray(snapshot.plans)) {
      throw new AgentLoopError('Invalid persisted NPC state')
    }
    this.byNpc.clear()
    this.planByNpc.clear()

    for (const item of snapshot.dialogue.slice(0, 128)) {
      if (!item || typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) continue
      const bucket = this.bucket(item.key)
      bucket.summary = cleanMemoryText(item.summary, this.maxSummaryChars)
      bucket.recent = []
      const recent = Array.isArray(item.recent) ? item.recent.slice(-this.maxRecentTurns * 2) : []
      for (const turn of recent) {
        if (!turn || !Number.isSafeInteger(turn.id) || turn.id < 1) continue
        bucket.recent.push({
          id: turn.id,
          sender: cleanMemoryText(turn.sender, 128),
          user: cleanMemoryText(turn.user, this.maxFieldChars),
          assistant: cleanMemoryText(turn.assistant, this.maxFieldChars),
          actions: cleanMemoryText(turn.actions, this.maxFieldChars),
        })
      }
      this.compact(bucket)
    }

    for (const item of snapshot.plans.slice(0, 128)) {
      if (!item || typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) continue
      const value = item.state
      if (!value || typeof value !== 'object' || typeof value.goal_id !== 'string') continue
      if (!['active', 'blocked', 'paused', 'completed'].includes(value.status)) continue
      const state = {
        goal_id: cleanMemoryText(value.goal_id, 100),
        owner: cleanMemoryText(value.owner, 128),
        objective: cleanMemoryText(value.objective, 1000),
        status: value.status,
        admission_status: ['proposed', 'admitting', 'admitted', 'admission_failed', 'action_omission_repair'].includes(value.admission_status) ? value.admission_status : undefined,
        blocker: cleanMemoryText(value.blocker, 500),
        pause_reason: cleanMemoryText(value.pause_reason, 300),
        persistent_runtime: safePersistentRuntime(value.persistent_runtime),
        condition_wait: safeConditionWait(value.condition_wait),
        provider_recovery: safeProviderRecovery(value.provider_recovery),
        plan: safePlan(value.plan),
        current_step: Number.isSafeInteger(value.current_step) && value.current_step >= 0 ? value.current_step : 0,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        last_chat_message: cleanMemoryText(value.last_chat_message, 2000),
        last_operations: (Array.isArray(value.last_operations) ? value.last_operations : []).slice(-16).map(operation => cleanMemoryText(operation, 800)),
        durable_last_operations: (Array.isArray(value.durable_last_operations) ? value.durable_last_operations : []).slice(-16).map(operation => sanitizeDurableModelValue(operation)),
        exact_target_audit: (Array.isArray(value.exact_target_audit) ? value.exact_target_audit : []).slice(-32).flatMap(entry => {
          if (!Number.isSafeInteger(entry?.unit_number)) return []
          return [{
            unit_number: entry.unit_number,
            operation_name: cleanMemoryText(entry.operation_name, 100),
            locator: sanitizeDurableModelValue(entry.locator),
            recorded_at: Number.isFinite(entry.recorded_at) ? entry.recorded_at : undefined,
          }]
        }),
        last_mutation_verified: value.last_mutation_verified === true,
        last_verified_batch_id: Number.isSafeInteger(value.last_verified_batch_id) && value.last_verified_batch_id > 0 ? value.last_verified_batch_id : undefined,
        updated_at: Number.isFinite(value.updated_at) ? value.updated_at : Date.now(),
        history: (Array.isArray(value.history) ? value.history : []).slice(-PLAN_HISTORY_LIMIT).map(entry => ({
          revision: Number.isSafeInteger(entry?.revision) ? entry.revision : 0,
          status: cleanMemoryText(entry?.status, 32),
          current_step: Number.isSafeInteger(entry?.current_step) ? entry.current_step : 0,
          step: cleanMemoryText(entry?.step, 500),
          chat: cleanMemoryText(entry?.chat, 2000),
        })),
      }
      state.task_board = sanitizeTaskBoard(value.task_board, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now: state.updated_at,
      })
      state.task_board = setTaskBoardStatus(state.task_board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now: state.updated_at,
      })
      if (state.status !== 'completed') {
        state.plan = state.task_board.steps.map(step => step.description)
        state.current_step = state.task_board.active_index
      }
      this.planByNpc.set(item.key, state)
    }
  }
}

class BehaviorTraceWriter {
  constructor(filename, log) {
    this.filename = filename
    this.log = log
    this.queue = Promise.resolve()
    this.bytes = null
    this.warned = false
  }

  async initialize() {
    if (this.bytes !== null) return
    await fsp.mkdir(path.dirname(this.filename), { recursive: true })
    try { this.bytes = (await fsp.stat(this.filename)).size }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.bytes = 0
    }
  }

  async rotate(incomingBytes) {
    await this.initialize()
    if (this.bytes + incomingBytes <= TRACE_MAX_BYTES) return
    await fsp.rm(`${this.filename}.${TRACE_FILES - 1}`, { force: true })
    for (let index = TRACE_FILES - 2; index >= 1; index--) {
      try { await fsp.rename(`${this.filename}.${index}`, `${this.filename}.${index + 1}`) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    try { await fsp.rename(this.filename, `${this.filename}.1`) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    this.bytes = 0
  }

  emit(event) {
    const line = `${JSON.stringify(sanitizeTraceValue(event))}\n`
    const bytes = Buffer.byteLength(line)
    this.queue = this.queue.then(async () => {
      await this.rotate(bytes)
      await fsp.appendFile(this.filename, line, { encoding: 'utf8', mode: 0o600 })
      this.bytes += bytes
    }).catch((error) => {
      if (!this.warned) {
        this.warned = true
        this.log(`Behavior trace write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return this.queue
  }
}

function actorFields(status) {
  if (!status || typeof status !== 'object') return undefined
  return {
    mode: status.mode,
    actor_id: status.actor_id,
    actor_kind: status.actor_kind,
    epoch: status.epoch,
    idle: status.idle,
    connected_players: status.connected_players,
  }
}

function messageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeUsageInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function firstUsageInteger(...values) {
  for (const value of values) {
    const valid = safeUsageInteger(value)
    if (valid !== undefined) return valid
  }
  return undefined
}

export function normalizedProviderUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const inputDetails = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {}
  const outputDetails = usage.completion_tokens_details ?? usage.output_tokens_details ?? {}
  const cachedRaw = firstUsageInteger(inputDetails?.cached_tokens, usage.prompt_cache_hit_tokens, usage.input_cache_hit_tokens, usage.cache_hit_tokens)
  const explicitMissRaw = firstUsageInteger(usage.prompt_cache_miss_tokens, usage.input_cache_miss_tokens, usage.cache_miss_tokens)
  const directInput = firstUsageInteger(usage.prompt_tokens, usage.input_tokens)
  const input = directInput ?? (cachedRaw !== undefined && explicitMissRaw !== undefined ? cachedRaw + explicitMissRaw : undefined)
  const cached = cachedRaw !== undefined && (input === undefined || cachedRaw <= input) ? cachedRaw : undefined
  const explicitMiss = explicitMissRaw !== undefined && (input === undefined || cached === undefined || cached + explicitMissRaw <= input) ? explicitMissRaw : undefined
  const miss = explicitMiss ?? (input !== undefined && cached !== undefined ? input - cached : undefined)
  const output = firstUsageInteger(usage.completion_tokens, usage.output_tokens)
  const reasoning = firstUsageInteger(outputDetails?.reasoning_tokens, usage.reasoning_tokens)
  const reasoningValid = reasoning === undefined || (output !== undefined && reasoning <= output)
  const visibleOutput = output !== undefined && reasoning !== undefined && reasoningValid ? output - reasoning : undefined
  const directTotal = firstUsageInteger(usage.total_tokens)
  const total = directTotal ?? (input !== undefined && output !== undefined ? input + output : undefined)
  const usageComplete = input !== undefined && output !== undefined && total !== undefined
    && total >= input && total >= output && (cachedRaw === undefined || cached !== undefined) && reasoningValid
  return {
    input_units: input,
    cached_input_units: cached,
    cache_miss_input_units: miss,
    output_units: output,
    visible_output_units: visibleOutput,
    reasoning_output_units: reasoningValid ? reasoning : undefined,
    total_units: total,
    usage_complete: usageComplete,
  }
}

function emptyUsageSummary() {
  return {
    provider_calls: 0,
    input_units: 0,
    cached_input_units: 0,
    cache_miss_input_units: 0,
    output_units: 0,
    visible_output_units: 0,
    reasoning_output_units: 0,
    total_units: 0,
    usage_complete: true,
    usage_incomplete_calls: 0,
    tool_calls: 0,
    duplicate_tool_calls: 0,
    tool_result_chars: 0,
    coalesced_runtime_events: 0,
  }
}

function accumulateProviderUsage(summary, usage) {
  if (!summary) return
  summary.provider_calls++
  if (!usage) {
    summary.usage_complete = false
    summary.usage_incomplete_calls++
    return
  }
  const add = key => {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) summary[key] += usage[key]
  }
  add('input_units')
  add('cached_input_units')
  add('cache_miss_input_units')
  add('output_units')
  add('visible_output_units')
  add('reasoning_output_units')
  add('total_units')
  if (usage.usage_complete !== true) {
    summary.usage_complete = false
    summary.usage_incomplete_calls++
  }
}

function compactProviderMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const structured = metadata.structured_content && typeof metadata.structured_content === 'object'
    ? {
        json_valid: metadata.structured_content.json_valid,
        plan_valid: metadata.structured_content.plan_valid,
        error: cleanMemoryText(metadata.structured_content.error, 800),
      }
    : undefined
  return {
    response_id: metadata.response_id,
    model: metadata.model,
    finish_reason: metadata.finish_reason,
    diagnostic_code: metadata.diagnostic_code,
    response_bytes: finiteNonNegative(metadata.response_bytes),
    content_chars: finiteNonNegative(metadata.content_chars),
    content_utf8_bytes: finiteNonNegative(metadata.content_utf8_bytes),
    content_non_ascii_chars: finiteNonNegative(metadata.content_non_ascii_chars),
    content_replacement_chars: finiteNonNegative(metadata.content_replacement_chars),
    normalized_content_chars: finiteNonNegative(metadata.normalized_content_chars),
    reasoning_content_chars: finiteNonNegative(metadata.reasoning_content_chars),
    reasoning_effort: cleanMemoryText(metadata.reasoning_effort, 32),
    reasoning_policy_reason: cleanMemoryText(metadata.reasoning_policy_reason, 80),
    capability_profile: cleanMemoryText(metadata.capability_profile, 40),
    requested_token_field: cleanMemoryText(metadata.requested_token_field, 40),
    requested_output_cap: safeUsageInteger(metadata.requested_output_cap),
    requested_reasoning_effort: cleanMemoryText(metadata.requested_reasoning_effort, 32),
    requested_thinking_mode: cleanMemoryText(metadata.requested_thinking_mode, 32),
    reported_reasoning_tokens: safeUsageInteger(metadata.reported_reasoning_tokens),
    reported_output_tokens: safeUsageInteger(metadata.reported_output_tokens),
    usage_complete: metadata.usage_complete === true,
    cap_enforcement_anomaly: metadata.cap_enforcement_anomaly === true,
    tool_call_count: finiteNonNegative(metadata.tool_call_count),
    structured_content: structured,
    content_preview: typeof metadata.content_preview === 'string' ? metadata.content_preview.slice(0, 1200) : undefined,
  }
}

function compactPlanFailureState(state) {
  if (!state || typeof state !== 'object') return undefined
  return {
    goal_id: state.goal_id,
    status: state.status,
    blocker: cleanMemoryText(state.blocker, 300),
    revision: state.revision,
    current_step: state.current_step,
    current_step_text: currentPlanStep(state.plan, state.current_step),
  }
}

function compactTaskBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return undefined
  return {
    batch_id: Number.isSafeInteger(batch.batch_id) ? batch.batch_id : undefined,
    task_count: Number.isSafeInteger(batch.task_count) ? batch.task_count : undefined,
    task_types: Array.isArray(batch.task_types) ? batch.task_types.slice(0, 16) : undefined,
    tick: Number.isFinite(batch.tick) ? batch.tick : undefined,
    reason: typeof batch.reason === 'string' ? cleanMemoryText(batch.reason, 800) : undefined,
  }
}

function taskStatusDecisionView(raw) {
  try {
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!status || typeof status !== 'object' || Array.isArray(status)) return { status_error: 'invalid_task_status' }
    return {
      task_state: status.task_state,
      queue_empty: status.queue_empty,
      queue_length: status.queue_length,
      last_completed_batch: compactTaskBatch(status.last_completed_batch),
      last_cancelled_batch: compactTaskBatch(status.last_cancelled_batch),
      basic_operation: status.basic_operation?.last_result
        ? { last_result: status.basic_operation.last_result }
        : undefined,
    }
  }
  catch {
    return { status_error: 'invalid_task_status_json' }
  }
}

const INTERACTION_INTENTS = new Set([
  'continue_current',
  'status_query',
  'amend_current',
  'new_goal',
  'cancel_current',
  'chat_only',
])

const INTERACTION_DIRECT_INTENT_CONFIDENCE = 0.9
const INTERACTION_AMEND_CONFLICT_LOW = 0.2
const INTERACTION_AMEND_CONFLICT_HIGH = 0.8

const POST_STEP_ROUTES = new Set([
  'continue_current',
  'targeted_observation',
  'reanchor_plan',
  'replan',
  'wait_runtime',
  'ask_user',
  'fallback_planner',
])
const SKILL_CONTEXT_MAX_SKILLS = 3
const SKILL_CONTEXT_MAX_CHARS = 16000

function boundedSkillValue(value, depth = 0) {
  if (depth > 4) return undefined
  if (typeof value === 'string') return cleanMemoryText(value, 600)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 12)
      .map(item => boundedSkillValue(item, depth + 1))
      .filter(item => item !== undefined)
  }
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value).slice(0, 24)
    .map(([key, child]) => [key, boundedSkillValue(child, depth + 1)])
    .filter(([, child]) => child !== undefined)
  return Object.fromEntries(entries)
}

function compactLoadedSkill(raw, expectedId) {
  let skill
  try { skill = typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return undefined }
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return undefined
  const id = typeof skill.id === 'string' ? cleanMemoryText(skill.id, 80) : ''
  if (!id || (expectedId && id !== expectedId)) return undefined

  const keys = [
    'schema_version', 'revision', 'id', 'name', 'kind', 'stage', 'status', 'summary',
    'preconditions', 'inputs', 'outputs', 'topology', 'constraints', 'parameters',
    'verification', 'known_failure_modes', 'confidence', 'examples',
  ]
  const compact = {}
  for (const key of keys) {
    if (skill[key] === undefined) continue
    const value = boundedSkillValue(skill[key])
    if (value !== undefined) compact[key] = value
  }
  let serialized = JSON.stringify(compact)
  if (serialized.length <= 7000) return compact

  delete compact.examples
  delete compact.known_failure_modes
  serialized = JSON.stringify(compact)
  if (serialized.length <= 7000) return compact

  return {
    id,
    revision: Number.isSafeInteger(skill.revision) ? skill.revision : undefined,
    name: typeof skill.name === 'string' ? cleanMemoryText(skill.name, 160) : undefined,
    kind: typeof skill.kind === 'string' ? cleanMemoryText(skill.kind, 80) : undefined,
    stage: typeof skill.stage === 'string' ? cleanMemoryText(skill.stage, 80) : undefined,
    status: typeof skill.status === 'string' ? cleanMemoryText(skill.status, 80) : undefined,
    summary: typeof skill.summary === 'string' ? cleanMemoryText(skill.summary, 1200) : undefined,
    preconditions: Array.isArray(skill.preconditions) ? boundedSkillValue(skill.preconditions.slice(0, 6)) : undefined,
    topology: boundedSkillValue(skill.topology),
    constraints: Array.isArray(skill.constraints) ? boundedSkillValue(skill.constraints.slice(0, 8)) : undefined,
    parameters: Array.isArray(skill.parameters) ? boundedSkillValue(skill.parameters.slice(0, 8)) : undefined,
    verification: boundedSkillValue(skill.verification),
  }
}

function postStepDecisionQuestions() {
  return {
    route: {
      type: 'choice',
      instructions: {
        task: 'After one authoritative Autorio completion or error boundary, choose the cheapest useful next reasoning route.',
        rules: [
          'Routing only: do not invent world facts, mutation success, blockers, or goal completion.',
          'continue_runtime is only a request; deterministic code independently verifies active runtime work.',
          'observe requests bounded deterministic grounding before semantic reasoning.',
          'ask_user is only valid when runtime lifecycle state already requires explicit user authority.',
        ],
      },
      criteria: {
        continue_runtime: 'Authoritative deterministic runtime work is already active and should continue without waking the Main LLM.',
        observe: 'A bounded deterministic read is useful before the next semantic decision.',
        wake_planner: 'The Main LLM must reason about the next semantic step, local repair, or broader strategy.',
        ask_user: 'The runtime is already at a lifecycle boundary that requires an explicit user choice.',
      },
    },
  }
}

function parsePostStepDecision(response) {
  const answer = response?.answers?.route
  if (!answer) throw new AgentLoopError('Decision provider returned invalid post-step route')
  const normalizedRoute = answer.choice === 'continue_runtime'
    ? 'continue_current'
    : answer.choice === 'observe'
      ? 'targeted_observation'
      : answer.choice === 'wake_planner'
        ? 'replan'
        : answer.choice
  if (!POST_STEP_ROUTES.has(normalizedRoute)) throw new AgentLoopError('Decision provider returned invalid post-step route')
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new AgentLoopError('Decision provider returned invalid post-step confidence')
  }
  return {
    route: normalizedRoute,
    requested_route: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

const INTERACTION_ROUTER_PROMPT = `Classify one incoming human message relative to the currently active Factorio goal.
You are a side-channel interaction router only. You have no Factorio tools and must never propose or execute world operations.

Intents:
- continue_current: asks to keep/resume the same goal without changing its constraints.
- status_query: asks what is happening, progress, blocker, or why it is stuck.
- amend_current: changes instructions/constraints for the same goal, including "continue but ignore X".
- new_goal: requests a materially different goal.
- cancel_current: asks to stop/cancel the current goal.
- chat_only: social/conversational text that should not alter task state.

Use current_goal and runtime only to classify relationship/lifecycle. Never infer world facts beyond them.
For amend_current, set queue_conflict=true only when the amendment conflicts with work that is already running or queued. Otherwise set it false.
For every non-amend intent, queue_conflict must be false.
Return exactly one JSON object with exactly three fields:
{"intent":"continue_current|status_query|amend_current|new_goal|cancel_current|chat_only","queue_conflict":false,"reply":""}
reply must be empty except for chat_only, where it may contain one brief conversational response. No markdown.`

export function interactionDecisionQuestions() {
  return {
    intent: {
      type: 'choice',
      instructions: 'Classify the incoming human message relative to the current Factorio goal and authoritative runtime state. This is an independent typed signal; natural-language interpretation and user-facing language remain with the Main LLM.',
      criteria: {
        continue_current: 'The player asks SGLuna to keep or resume the same goal without changing its constraints.',
        status_query: 'The player asks what is happening, current progress, a blocker, or why the agent is stuck.',
        amend_current: 'The player changes instructions or constraints for the same active goal.',
        new_goal: 'The player requests a materially different world goal.',
        cancel_current: 'The player asks to stop or cancel the current goal.',
        chat_only: 'The message is social or conversational and should not change task state.',
      },
    },
    queue_conflict: {
      type: 'noul',
      instructions: 'Only when the message amends the current goal: would applying that amendment conflict with world work that is already running or queued? For every other intent, answer false.',
      criteria: {
        true: 'The amendment conflicts with work that is already running or queued and should not be deferred.',
        false: 'There is no amendment, or the amendment is compatible with the work already running or queued.',
      },
    },
  }
}

export function interactionPlannerShapeQuestions() {
  const envelope = decisionEnvelopeQuestions()
  return {
    reasoning_budget: envelope.reasoning_budget,
    planning_horizon: envelope.planning_horizon,
    ...observationRelevanceQuestions(),
  }
}

export function parseInteractionDecisionShadow(response) {
  const intentAnswer = response?.answers?.intent
  const conflictAnswer = response?.answers?.queue_conflict
  if (!intentAnswer || !INTERACTION_INTENTS.has(intentAnswer.choice)) throw new AgentLoopError('Decision provider returned invalid interaction intent')
  if (typeof intentAnswer.confidence !== 'number' || !Number.isFinite(intentAnswer.confidence) || intentAnswer.confidence < 0 || intentAnswer.confidence > 1) {
    throw new AgentLoopError('Decision provider returned invalid interaction confidence')
  }
  if (!conflictAnswer || typeof conflictAnswer.noul !== 'number' || !Number.isFinite(conflictAnswer.noul) || conflictAnswer.noul < 0 || conflictAnswer.noul > 1) {
    throw new AgentLoopError('Decision provider returned invalid queue-conflict probability')
  }
  return {
    intent: intentAnswer.choice,
    intent_confidence: intentAnswer.confidence,
    intent_probabilities: intentAnswer.probabilities,
    queue_conflict_probability: conflictAnswer.noul,
    queue_conflict: intentAnswer.choice === 'amend_current' && conflictAnswer.noul >= 0.5,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

function interactionDecisionNeedsLanguageRouter(decision) {
  if (!decision) return true
  if (decision.intent === 'chat_only') return true
  if (decision.intent_confidence < INTERACTION_DIRECT_INTENT_CONFIDENCE) return true
  if (decision.intent === 'amend_current') {
    const conflict = decision.queue_conflict_probability
    if (conflict > INTERACTION_AMEND_CONFLICT_LOW && conflict < INTERACTION_AMEND_CONFLICT_HIGH) return true
  }
  return false
}

function interactionRouteFromTypedDecision(decision) {
  return {
    intent: decision.intent,
    queue_conflict: decision.intent === 'amend_current' ? decision.queue_conflict === true : false,
    reply: '',
  }
}

export function parseInteractionRoute(message) {
  if (!message || typeof message !== 'object' || message.tool_calls !== undefined) {
    throw new AgentLoopError('Interaction router returned tools or no message')
  }
  let parsed
  try { parsed = JSON.parse(String(message.content ?? '')) }
  catch { throw new AgentLoopError('Interaction router returned invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentLoopError('Interaction router returned invalid object')
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 3 || keys[0] !== 'intent' || keys[1] !== 'queue_conflict' || keys[2] !== 'reply') throw new AgentLoopError('Interaction router returned unexpected fields')
  if (!INTERACTION_INTENTS.has(parsed.intent)) throw new AgentLoopError('Interaction router returned invalid intent')
  if (typeof parsed.queue_conflict !== 'boolean') throw new AgentLoopError('Interaction router returned invalid queue_conflict')
  if (parsed.intent !== 'amend_current' && parsed.queue_conflict !== false) throw new AgentLoopError('Interaction router queue_conflict is only valid for amendments')
  if (typeof parsed.reply !== 'string' || parsed.reply.length > 500) throw new AgentLoopError('Interaction router returned invalid reply')
  return { intent: parsed.intent, queue_conflict: parsed.intent === 'amend_current' ? parsed.queue_conflict : false, reply: cleanMemoryText(parsed.reply, 500) }
}

function compactInteractionTaskStatus(raw) {
  try {
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!status || typeof status !== 'object' || Array.isArray(status)) return { status_error: 'invalid_task_status' }
    return {
      task_state: typeof status.task_state === 'string' ? status.task_state : undefined,
      queue_empty: status.queue_empty === true,
      queue_length: Number.isSafeInteger(status.queue_length) ? status.queue_length : undefined,
      current_task: status.current_task && typeof status.current_task === 'object' && !Array.isArray(status.current_task)
        ? status.current_task
        : undefined,
      last_completed_batch: compactTaskBatch(status.last_completed_batch),
      last_cancelled_batch: compactTaskBatch(status.last_cancelled_batch),
    }
  }
  catch {
    return { status_error: 'invalid_task_status_json' }
  }
}

export function interactionRuntimeHealthy(status) {
  if (!status || status.status_error) return false
  const taskState = typeof status.task_state === 'string' ? status.task_state.trim().toLowerCase() : ''
  return (taskState !== '' && taskState !== 'idle')
    || (Number.isSafeInteger(status.queue_length) && status.queue_length > 0)
}

function interactionStatusReply(status, plan) {
  if (status?.status_error) return `I could not read authoritative Autorio task state: ${status.status_error}`
  const task = status?.task_state || 'idle'
  const queue = Number.isSafeInteger(status?.queue_length) ? status.queue_length : 0
  const objective = cleanMemoryText(plan?.objective ?? '', 180)
  const step = Number.isSafeInteger(plan?.task_board?.active_index) ? plan.task_board.active_index + 1 : undefined
  const total = Number.isSafeInteger(plan?.task_board?.total_steps) ? plan.task_board.total_steps : undefined
  const progress = step && total ? `, canonical step ${Math.min(step, total)}/${total}` : ''
  return `Autorio is currently ${task} with ${queue} queued task${queue === 1 ? '' : 's'}${progress}.${objective ? ` Current goal: ${objective}` : ''}`
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function taskStatusDelta(previous, current) {
  if (!previous) return { observation_mode: 'full', ...current }
  const delta = {
    observation_mode: 'diff',
    task_state: current.task_state,
    queue_empty: current.queue_empty,
    queue_length: current.queue_length,
  }
  let changed = false
  for (const key of ['last_completed_batch', 'last_cancelled_batch', 'basic_operation', 'status_error']) {
    if (!sameJsonValue(previous[key], current[key])) {
      delta[key] = current[key]
      changed = true
    }
  }
  if (!sameJsonValue(previous.task_state, current.task_state)
    || !sameJsonValue(previous.queue_empty, current.queue_empty)
    || !sameJsonValue(previous.queue_length, current.queue_length)) changed = true
  if (!changed) delta.observation_mode = 'unchanged'
  return delta
}

function runtimeReceiptKey(kind, view, detail = '', epoch) {
  const batch = kind === 'failure'
    ? (view?.last_cancelled_batch ?? view?.last_completed_batch)
    : (view?.last_completed_batch ?? view?.last_cancelled_batch)
  const batchId = Number.isSafeInteger(batch?.batch_id) ? batch.batch_id : undefined
  const prefix = `${epoch ?? 'no-epoch'}:${kind}`
  if (batchId !== undefined) return `${prefix}:batch:${batchId}:${cleanMemoryText(detail, 300)}`
  return `${prefix}:state:${JSON.stringify(view)}:${cleanMemoryText(detail, 300)}`
}

function stateFileFromOptions(options) {
  if (options.stateFile === null) return null
  if (typeof options.stateFile === 'string' && options.stateFile.length > 0) return path.resolve(options.stateFile)
  if (typeof process.env.AIRI_NPC_STATE_FILE === 'string' && process.env.AIRI_NPC_STATE_FILE.trim()) return path.resolve(process.env.AIRI_NPC_STATE_FILE)
  if (process.env.NODE_TEST_CONTEXT) return null
  return path.join(path.resolve(process.env.CONTAINER_ROOT || '/home/container'), '.airi', 'npc-state.json')
}

// Cut a truncated JSON object back to its last complete top-level member.
// Never invents content: it only drops an incomplete trailing member.
export function salvageTruncatedJsonObject(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trimStart()
  if (!text.startsWith('{')) return undefined
  const cuts = []
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (char === ',' && depth === 1) cuts.push(index)
  }
  for (let index = cuts.length - 1; index >= 0; index--) {
    const candidate = `${text.slice(0, cuts[index])}}`
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { text: candidate, cut: cuts[index], keys: Object.keys(parsed) }
      }
    }
    catch {}
  }
  return undefined
}

function blockedPlanReply(plan) {
  const reason = cleanMemoryText(plan?.blocker?.detail || plan?.blocker?.reason_code || 'a structural blocker', 240)
  const step = plan?.steps?.[plan?.active_step_index ?? 0]?.description
  const where = step ? ` at "${cleanMemoryText(step, 160)}"` : ''
  return `The current plan is blocked${where}: ${reason}. Continuing unchanged would hit the same blocker. Tell me how to revise it (for example a different route or target), or cancel it.`
}

function planProgress(plan, stateResult) {
  const progress = taskBoardProgress(stateResult?.state?.task_board)
  if (stateResult?.blockedByHarness || stateResult?.state?.status === 'blocked') {
    const blocker = stateResult?.state?.blocker ? ` (${cleanMemoryText(stateResult.state.blocker, 200)})` : ''
    return `[Plan blocked] ${progress?.step || 'Remaining work'}${blocker}: no Autorio operation was submitted. Tell me how to revise the plan, or cancel it.`
  }
  if (stateResult?.persistentRuntimeActive) return plan.chatMessage
  if (plan.operations.length > 0 && progress?.total > 0) {
    return `[Plan ${progress.index}/${progress.total}] ${progress.step}${plan.chatMessage ? ` — ${plan.chatMessage}` : ''}`
  }
  if (stateResult?.state?.status === 'completed') {
    return plan.chatMessage ? `[Plan complete] ${plan.chatMessage}` : '[Plan complete] Goal verified complete.'
  }
  return plan.chatMessage
}

function providerOutputBudgetExhausted(message) {
  return message?._airiProvider?.output_budget_exhausted === true
    || message?._airiProvider?.diagnostic_code === 'provider_output_budget_exhausted'
}

function operationSignature(operation) {
  return cleanMemoryText(`${operation?.name ?? ''} ${JSON.stringify(operation?.args ?? {})}`, 800)
}

function replayedCompletedOperations(plan, guard) {
  if (!guard || !Array.isArray(guard.completed_operations) || guard.completed_operations.length === 0) return []
  const completed = new Set(guard.completed_operations)
  return (plan?.operations ?? []).map(operationSignature).filter(signature => completed.has(signature))
}

function latestDeterministicCompletionEvidence(state) {
  const latest = state?.task_board?.evidence?.at(-1)
  if (latest?.kind !== 'deterministic_verification') return false
  try {
    const summary = JSON.parse(latest.summary)
    return summary?.verdict === 'verified_complete'
  }
  catch {
    return false
  }
}

function outputBudgetRecoveryEvidenceAvailable(state, reason) {
  if (reason === 'failure') return true
  return reason === 'completion' && latestDeterministicCompletionEvidence(state)
}

function protectOutputBudgetRecoveryPlan(plan, state, guard) {
  if (!guard || guard.world_evidence_observed || !state?.task_board || (guard.goal_id && guard.goal_id !== state.goal_id)) return plan
  const canonical = Array.isArray(state.task_board.steps)
    ? state.task_board.steps.map(step => String(step?.description ?? '')).filter(Boolean)
    : []
  if (canonical.length === 0) return plan
  const currentStep = Number.isSafeInteger(state.task_board.active_index)
    ? Math.min(Math.max(state.task_board.active_index, 0), canonical.length - 1)
    : 0
  return {
    ...plan,
    plan: canonical,
    currentStep,
  }
}

function providerBlockerReason(plan) {
  const text = cleanMemoryText(plan?.chatMessage, 2000)
  if (!text.toUpperCase().startsWith(ACTION_OMISSION_BLOCKER_PREFIX)) return ''
  return cleanMemoryText(text.slice(ACTION_OMISSION_BLOCKER_PREFIX.length), 1200)
}

function terminalProviderBudgetFailure(value) {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return /provider_context_window_exceeded|provider_output_budget_recovery_(?:exhausted|budget_unavailable)|provider_turn_output_cap_exceeded/i.test(message)
}

function canonicalWorkRemains(state) {
  if (state?.status !== 'active') return false
  const board = state?.task_board
  if (board?.kind !== 'task_board_lite' || !Array.isArray(board.steps) || board.steps.length === 0) return false
  return board.status === 'active' && (board.completed_count ?? 0) < board.steps.length
}

function persistentRuntimeHealthy(runtime) {
  return runtime?.active === true && runtime.healthy === true && runtime.controller_live === true
}

function finalStepCanCloseFromFreshObservation(state) {
  const stored = Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []
  if (state?.last_mutation_verified === true) return true
  // The flag is reset when a later plan (e.g. a semanticCompletion turn) is
  // recorded, but the batch's authoritative receipt still stands; the caller
  // only gets here on a completion trigger. Live rung 1: a verify-only final
  // step after a semantically closed gather could not close.
  const evidence = Array.isArray(state?.task_board?.evidence) ? state.task_board.evidence : []
  const latestReceipt = [...evidence].reverse().find(item =>
    ['operation_receipt', 'operation_error_receipt', 'deterministic_verification'].includes(item?.kind))
  if (latestReceipt && latestReceipt.kind !== 'operation_error_receipt' && String(latestReceipt.ref ?? '')) return true
  // No operation since the last recorded plan means no mutation is pending.
  if (stored.length === 0) return true
  return stored.every(value => /^wait(?:\s|$)/i.test(String(value ?? '').trim()))
}

function terminalControlOnlyPlanStep(value) {
  return isLifecycleMetaStep(value)
}

function verifiedFinalCompletion(plan, state, triggerSource, { freshObservation = false } = {}) {
  if (triggerSource !== 'completion' || plan?.operations?.length !== 0 || plan?.plan?.length !== 0) return false
  const board = state?.task_board
  if (state?.status !== 'active') return false
  if (!board || board.kind !== 'task_board_lite' || !Array.isArray(board.steps) || board.steps.length === 0) return false
  const activeIndex = Number.isSafeInteger(board.active_index) ? board.active_index : -1
  if (activeIndex < 0 || activeIndex >= board.steps.length) return false
  // A step with a deterministic contract must still meet it (checked by the
  // caller). A prose-only final step has no contract, and its completion is
  // the Main LLM's judgment: an explicit final-completion claim (plan: [])
  // counts as that judgment under the same grounding rule as
  // semanticCompletion -- an authoritative receipt for this step, or a fresh
  // observation. Without this, a verified "place one furnace" ended as an
  // action omission because no Jev receipt normalizer records a contract.
  const trailingSteps = board.steps.slice(activeIndex + 1)
  if (trailingSteps.some(step => !terminalControlOnlyPlanStep(step?.description))) return false
  const ref = Number.isSafeInteger(state.last_verified_batch_id) ? `batch_${state.last_verified_batch_id}` : ''
  const deterministicCurrentStep = [...(board.evidence ?? [])].reverse().some(item => item?.kind === 'deterministic_verification'
    && item?.step_id === board.active_step_id
    && (!ref || item?.ref === ref))
  if (deterministicCurrentStep) return true
  return freshObservation === true && finalStepCanCloseFromFreshObservation(state)
}

function activeStepEvidence(board, limit = 4) {
  const activeStepId = board?.active_step_id
  if (!activeStepId) return []
  return (Array.isArray(board?.evidence) ? board.evidence : [])
    .filter(item => item?.step_id === activeStepId)
    .slice(-Math.max(1, limit))
}

function providerControlPlaneBlocker(value) {
  return /invalid provider content json|provider_output_budget_exhausted|provider strict recovery|provider_action_omission_repair_failed|provider_jev_recovery_route_failed/i.test(String(value ?? ''))
}

function actionOmissionRecoveryCapsule(state, runtimeStatus) {
  const board = state?.task_board
  const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : state?.current_step ?? 0
  const activeStep = Array.isArray(board?.steps) ? board.steps[activeIndex] : undefined
  const capsule = {
    goal_id: sanitizeDurableModelText(state?.goal_id, 100),
    objective: sanitizeDurableModelText(state?.objective, 1000),
    canonical_step: {
      index: activeIndex,
      id: sanitizeDurableModelText(activeStep?.id, 100),
      description: sanitizeDurableModelText(activeStep?.description ?? currentPlanStep(state?.plan, activeIndex), 500),
    },
    remaining_steps: (Array.isArray(board?.steps) ? board.steps : [])
      .slice(activeIndex, activeIndex + 8)
      .map(step => ({
        id: sanitizeDurableModelText(step?.id, 100),
        description: sanitizeDurableModelText(step?.description, 500),
        status: sanitizeDurableModelText(step?.status, 32),
      })),
    progress: {
      completed_count: Number.isSafeInteger(board?.completed_count) ? board.completed_count : 0,
      total_steps: Array.isArray(board?.steps) ? board.steps.length : 0,
    },
    authoritative_evidence: activeStepEvidence(board).map(item => sanitizeDurableModelValue(item)),
    runtime: sanitizeDurableModelValue(runtimeStatus ?? state?.persistent_runtime),
    durable_locators: modelFacingEntityReferences(state).slice(-4),
    reason: 'action_omission_recovery',
    contract: {
      normal_path_extra_calls: 0,
      allowed_targeted_observations: 1,
      next_response: 'submit the next executable operation, or start chatMessage with BLOCKED: and name the exact missing fact/truthful blocker',
      exact_identity: 'historical unit_number values are non-executable; bind any exact identity from a live observation in this active request',
    },
  }
  return `[ACTION_OMISSION_RECOVERY] Compact recovery capsule. It intentionally omits unrelated dialogue and historical tool results.\n${JSON.stringify(capsule)}`
}

function providerBudgetTriggerSource(semanticScope, route) {
  if (semanticScope === 'reanchor_target') return 'post_step_reanchor'
  return route === 'replan_high' ? 'recovery_replan_high' : 'recovery_continue_low'
}

function providerBudgetHandoffCapsule(state, runtimeStatus, reason, semanticScope = 'keep_target') {
  const board = state?.task_board
  const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : state?.current_step ?? 0
  const capsule = {
    goal: state
      ? {
          goal_id: sanitizeDurableModelText(state.goal_id, 100),
          objective: sanitizeDurableModelText(state.objective, 1000),
          status: state.status,
        }
      : null,
    task_board: board ? modelFacingTaskBoard(board) : null,
    active_target: sanitizeDurableModelText(board?.steps?.[activeIndex]?.description ?? currentPlanStep(state?.plan, activeIndex), 500),
    authoritative_evidence: activeStepEvidence(board).map(item => sanitizeDurableModelValue(item)),
    runtime: sanitizeDurableModelValue(runtimeStatus ?? state?.persistent_runtime),
    durable_locators: modelFacingEntityReferences(state).slice(-4),
    provider_budget: {
      semantic_scope: semanticScope,
      reason: cleanMemoryText(reason, 1200),
    },
    contract: {
      completion_authority: 'unchanged',
      committed_plan: 'provider budget exhaustion is not completion evidence and never reopens a committed plan',
      verified_prefix: 'preserve every verified Task Board step',
      next_turn: 'resume from this bounded capsule; re-observe mutable world facts when needed before mutation',
    },
  }
  return `[PROVIDER_BUDGET_HANDOFF] Fresh planner generation after a provider-budget boundary. The user goal and durable verified prefix continue; the exhausted provider generation does not pause, complete, or advance the project by itself.\n${JSON.stringify(capsule)}`
}

export class NpcAgentLoop extends BaseNpcAgentLoop {
  constructor(options) {
    const memory = options.memory ?? new NpcDialogueMemory()
    super({
      ...options,
      memory,
      systemPrompt: `${options.systemPrompt}\n\n${DURABLE_PLAN_PROMPT}`,
    })
    this.stateFile = stateFileFromOptions(options)
    this.stateLoaded = false
    this.maxProviderOutputUnits = Number.isSafeInteger(options.maxProviderOutputUnits) ? options.maxProviderOutputUnits : 20000
    if (this.maxProviderOutputUnits < 1000 || this.maxProviderOutputUnits > 200000) {
      throw new AgentLoopError('maxProviderOutputUnits must be an integer from 1000 to 200000')
    }
    this.maxProviderBudgetHandoffs = Number.isSafeInteger(options.maxProviderBudgetHandoffs) ? options.maxProviderBudgetHandoffs : 4
    if (this.maxProviderBudgetHandoffs < 1 || this.maxProviderBudgetHandoffs > 16) {
      throw new AgentLoopError('maxProviderBudgetHandoffs must be an integer from 1 to 16')
    }
    this.interactionProvider = typeof options.interactionProvider === 'function' ? options.interactionProvider : null
    this.interactionDecisionProvider = typeof options.interactionDecisionProvider === 'function' ? options.interactionDecisionProvider : null
    this.steeringDecisionProvider = typeof options.steeringDecisionProvider === 'function'
      ? options.steeringDecisionProvider
      : null
    this.operationProjectionDecisionProvider = typeof options.operationProjectionDecisionProvider === 'function'
      ? options.operationProjectionDecisionProvider
      : null
    this.interactionAbort = null
    this.postStepDecisionAbort = null
    this.recoveryDecisionAbort = null
    this.operationProjectionAbort = null
    this.lastRecoveryDecisionKey = ''
    this.lastRecoveryDecision = null
    this.loadedSkillContext = new Map()
    this.reasoningTriggerSource = null
    this.reasoningBudgetOverride = null
    this.observationBudgetOverride = null
    this.observationBudgetRemaining = null
    this.observationRelevanceOverride = null
    this.planningHorizonOverride = null
    this.planningReasoningEpochSeen = new Map()
    this.persistQueue = Promise.resolve()
    this.traceRequest = null
    this.traceRequestSequence = 0
    this.decisionRequestSequence = 0
    this.decisionTraceSequence = 0
    this.jevHealth = emptyJevHealth()
    // 'required': the first plan of every goal must carry a game-checkable goal
    // definition (production). 'optional': accepted when present.
    this.goalDefinitionPolicy = options.goalDefinitionPolicy === 'required' ? 'required' : 'optional'
    this.goalDefinitionRetries = 0
    this.goalDefinitionBlock = null
    // Jev's blind reading of the current new goal (see goal-reading.mjs).
    this.goalReading = null
    this.pendingGoalReadingTrace = null
    this.planUpdateReason = 'request'
    this.requestLifecycle = 'new_goal'
    this.pendingInteractionAmendment = null
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.providerBudgetGeneration = 0
    this.providerBudgetGenerationOutputUnits = 0
    this.providerBudgetHandoffCount = 0
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.observationRelevanceOverride = null
    this.genericRecoveryDecisionActive = false
    this.conditionPollPromise = null
    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.modelCorrectablePreflightRetries = 0
    this.researchPreflightRetries = 0
    this.onActivity = typeof options.onActivity === 'function' ? options.onActivity : null
    this.turnSequence = Math.max(this.turnSequence, memory.maxTurnId?.() ?? 0)
    const traceFile = options.traceFile ?? process.env.SGLUNA_BEHAVIOR_TRACE_FILE ?? process.env.AIRI_BEHAVIOR_TRACE_FILE
      ?? (process.env.NODE_TEST_CONTEXT ? null : path.resolve(process.cwd(), 'logs', 'sgluna-behavior.jsonl'))
    this.behaviorTrace = traceFile ? new BehaviorTraceWriter(traceFile, message => this.log(`[trace] ${message}`)) : null
    const decisionTraceFile = Object.prototype.hasOwnProperty.call(options, 'decisionTraceFile')
      ? options.decisionTraceFile
      : (process.env.SGLUNA_DECISION_TRACE_FILE
        ?? (this.interactionDecisionProvider && !process.env.NODE_TEST_CONTEXT
          ? path.resolve(process.cwd(), 'logs', 'sgluna-decision.jsonl')
          : null))
    this.decisionTrace = this.interactionDecisionProvider && decisionTraceFile
      ? new BehaviorTraceWriter(decisionTraceFile, message => this.log(`[decision-trace] ${message}`))
      : null
  }

  async loadPersistentState() {
    if (this.stateLoaded) return
    this.stateLoaded = true
    if (!this.stateFile || typeof this.memory.restore !== 'function') return
    try {
      const parsed = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'))
      this.memory.restore(parsed)
      this.turnSequence = Math.max(this.turnSequence, this.memory.maxTurnId?.() ?? 0)
      this.log(`[memory] restored durable NPC state from ${this.stateFile}`)
    }
    catch (error) {
      if (error?.code === 'ENOENT') return
      this.log(`[memory] ignored unreadable durable NPC state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async persistState() {
    if (!this.stateFile || typeof this.memory.snapshot !== 'function') return
    const filename = this.stateFile
    const snapshot = this.memory.snapshot()
    this.persistQueue = this.persistQueue.then(async () => {
      await fsp.mkdir(path.dirname(filename), { recursive: true })
      const temp = `${filename}.${process.pid}.tmp`
      await fsp.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fsp.rename(temp, filename)
    }).catch(error => this.log(`[memory] durable NPC state write failed: ${error instanceof Error ? error.message : String(error)}`))
    return this.persistQueue
  }

  activePlanKey() {
    return this.requestInfo?.memoryKey ?? this.lastMemoryKey ?? `npc:${this.npcId}`
  }

  clearLoadedSkillContext() {
    if (!(this.loadedSkillContext instanceof Map)) {
      this.loadedSkillContext = new Map()
      return
    }
    this.loadedSkillContext.clear()
  }

  recordLoadedSkillToolResult(toolName, args, raw) {
    if (toolName !== 'getSkillDetails') return false
    const skill = compactLoadedSkill(raw, typeof args?.id === 'string' ? args.id : undefined)
    if (!skill) return false
    if (!(this.loadedSkillContext instanceof Map)) this.loadedSkillContext = new Map()
    if (this.loadedSkillContext.has(skill.id)) this.loadedSkillContext.delete(skill.id)
    this.loadedSkillContext.set(skill.id, skill)
    while (this.loadedSkillContext.size > SKILL_CONTEXT_MAX_SKILLS) {
      const oldest = this.loadedSkillContext.keys().next().value
      if (oldest === undefined) break
      this.loadedSkillContext.delete(oldest)
    }
    return skill
  }

  skillContext() {
    if (!(this.loadedSkillContext instanceof Map) || this.loadedSkillContext.size === 0) return ''
    const skills = [...this.loadedSkillContext.values()]
    while (skills.length > 1 && JSON.stringify(skills).length > SKILL_CONTEXT_MAX_CHARS) skills.shift()
    const payload = JSON.stringify(skills)
    if (payload.length > SKILL_CONTEXT_MAX_CHARS) return ''
    return `[SKILL_CONTEXT] Explicitly loaded AIRI skills for this logical task. They are reusable strategy/constraint context, not authoritative live world state. Revalidate mutable facts before acting.\n${payload}`
  }

  // Two defects lived in the inherited compaction:
  //  - it ran INSIDE the base tool batch, so a large fresh read could be
  //    spliced out before this class consumed it;
  //  - it could compact the NEWEST exchange, replacing fresh observations with
  //    an 800-char summary before the planner had read them once.
  // Compaction now waits until this class has consumed the batch, and never
  // takes the newest exchange; older exchanges still compact as before.
  compactWorkingContext() {
    if (this.compactionDeferred) return
    const overBudget = () => this.messages.length > this.maxWorkingMessages
      || this.messages.reduce((total, message) => total + messageChars(message), 0) > this.maxWorkingChars
    while (overBudget()) {
      const newest = this.messages.findLastIndex(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
      const start = this.messages.findIndex((message, index) => index >= this.baseMessages.length
        && index !== newest
        && message.role === 'assistant'
        && Array.isArray(message.tool_calls))
      if (start < 0) break
      let end = start + 1
      while (end < this.messages.length && this.messages[end].role === 'tool') end++
      const removed = this.messages.splice(start, end - start)
      const summary = this.summarizeToolExchange(removed)
      const previous = this.messages[start - 1]
      if (previous?.role === 'user' && typeof previous.content === 'string' && previous.content.startsWith('[OBSERVATIONS COMPACTED]')) {
        previous.content = cleanMemoryText(`${previous.content}\n${summary}`, 12000)
      }
      else {
        this.messages.splice(start, 0, { role: 'user', content: `[OBSERVATIONS COMPACTED] ${summary}` })
      }
    }
  }

  providerMessages() {
    const messages = super.providerMessages().filter(message => !(message?.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith('[SKILL_CONTEXT]')))
    const skillContext = this.skillContext()
    if (!skillContext) return messages
    const insertAt = Math.min(this.baseMessages.length, messages.length)
    return [
      ...messages.slice(0, insertAt),
      { role: 'user', content: skillContext },
      ...messages.slice(insertAt),
    ]
  }

  refreshPlanningReasoningEpoch() {
    const key = this.activePlanKey()
    const epoch = this.memory.planningReasoningEpoch?.(key)
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false
    const previous = this.planningReasoningEpochSeen.get(key)
    this.planningReasoningEpochSeen.set(key, epoch)
    if (previous === undefined || previous === epoch || !this.requestInfo) return false

    // A reducer epoch bump is an explicit invalidation boundary. Rebuild the
    // working provider context from durable memory and the current user request;
    // never carry tool/scratch exchanges that argued for the predecessor plan.
    this.clearLoadedSkillContext()
    const memoryContext = this.memory.context?.(key) ?? ''
    this.baseMessages = [
      { role: 'system', content: this.systemPrompt },
      ...(memoryContext ? [{ role: 'user', content: memoryContext }] : []),
      { role: 'user', content: `[CHAT] ${this.requestInfo.sender}: ${this.requestInfo.text}` },
    ]
    this.messages = this.baseMessages.map(message => ({ ...message }))
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.resetObservationDecisionState()
    void this.traceEvent('planning.reasoning_epoch_reset', {
      previous_epoch: previous,
      reasoning_epoch: epoch,
      goal_id: this.memory.currentPlan?.(key)?.goal_id,
    })
    return true
  }

  prepareContinuationContext() {
    const reset = this.refreshPlanningReasoningEpoch()
    if (!reset) {
      super.prepareContinuationContext()
      const planContext = this.memory.planContext?.(this.activePlanKey())
      if (planContext) this.messages.push({ role: 'user', content: planContext })
    }
  }

  isObservationToolName(name) {
    return isObservationToolName(name)
  }

  observationToolCommand(name, args) {
    return toolCommand(name, args)
  }

  recordLiveEntityObservation(entity, actorPosition, source, observationMeta = {}) {
    if (!entity || typeof entity !== 'object' || typeof entity.name !== 'string') return
    const unitNumber = Number.isSafeInteger(entity.unit_number) ? entity.unit_number : undefined
    const position = entity.position && Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)
      ? { x: entity.position.x, y: entity.position.y }
      : undefined
    let distance = Number.isFinite(entity.distance) ? entity.distance : undefined
    if (distance === undefined && position && actorPosition
      && Number.isFinite(actorPosition.x) && Number.isFinite(actorPosition.y)) {
      distance = Math.hypot(position.x - actorPosition.x, position.y - actorPosition.y)
    }
    if (unitNumber !== undefined && position) {
      for (const [existingKey, existing] of this.liveEntityObservations.entries()) {
        if (existing?.unit_number === unitNumber || existing?.name !== entity.name || !existing?.position) continue
        if (existing.position.x === position.x && existing.position.y === position.y) {
          this.liveEntityObservations.delete(existingKey)
        }
      }
    }
    const key = unitNumber !== undefined
      ? `unit:${unitNumber}`
      : `fallback:${entity.name}:${entity.type ?? 'unknown'}:${position?.x ?? '?'}:${position?.y ?? '?'}`
    const surface = [entity.surface_name, entity.surface, observationMeta.surface_name, observationMeta.surface]
      .find(value => typeof value === 'string' && value)
    const surfaceIndex = [entity.surface_index, observationMeta.surface_index]
      .find(value => Number.isSafeInteger(value))
    this.liveEntityObservations.set(key, {
      name: entity.name,
      type: entity.type,
      unit_number: unitNumber,
      position,
      distance,
      surface,
      surface_index: surfaceIndex,
      source,
      working: entity.working === true,
      status: Number.isFinite(entity.status) ? entity.status : undefined,
      inventories: Array.isArray(entity.inventories) ? sanitizeDurableModelValue(entity.inventories) : undefined,
      recipe: typeof entity.recipe === 'string' ? cleanMemoryText(entity.recipe, 160) : undefined,
    })
  }

  recordLiveEntityToolResult(toolName, raw) {
    if (!['getNearbyEntities', 'getEntityStatus', 'findLongRangeEntities'].includes(toolName)) return
    let parsed
    try { parsed = JSON.parse(String(raw ?? '')) }
    catch { return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const actorPosition = parsed.actor_position
    const observationMeta = {
      surface: parsed.surface,
      surface_name: parsed.surface_name,
      surface_index: parsed.surface_index,
    }
    if (Array.isArray(parsed.entities)) {
      for (const entity of parsed.entities) this.recordLiveEntityObservation(entity, actorPosition, toolName, observationMeta)
    }
    if (parsed.entity && typeof parsed.entity === 'object') {
      this.recordLiveEntityObservation(parsed.entity, actorPosition, toolName, observationMeta)
    }
  }

  recordPlacementReceipt(raw) {
    let parsed
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw }
    catch { return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    const batch = parsed.last_completed_batch
    const result = parsed.basic_operation?.last_result
    if (!batch || !result || result.completed !== true || result.code !== 'completed' || result.type !== 'placing') return
    if (!Array.isArray(batch.task_types) || !batch.task_types.includes('placing')) return
    if (Number.isFinite(batch.tick) && Number.isFinite(result.tick) && result.tick > batch.tick) return
    if (Number.isSafeInteger(result.actor_id) && Number.isSafeInteger(this.epoch?.actor_id)
      && result.actor_id !== this.epoch.actor_id) return
    if (!Number.isSafeInteger(result.placed_unit_number)
      || typeof result.entity_name !== 'string'
      || !result.placed_position
      || !Number.isFinite(result.placed_position.x)
      || !Number.isFinite(result.placed_position.y)) return

    this.recordLiveEntityObservation({
      name: result.entity_name,
      type: result.placed_entity_type,
      unit_number: result.placed_unit_number,
      position: { x: result.placed_position.x, y: result.placed_position.y },
      surface_index: result.placed_surface_index,
    }, parsed.actor?.position, 'placement_receipt', {
      surface_index: result.placed_surface_index,
    })
  }

  liveObservedExactTarget(unitNumber) {
    return Number.isSafeInteger(unitNumber)
      ? this.liveEntityObservations?.get?.(`unit:${unitNumber}`)
      : undefined
  }

  liveExactEntityFreshnessToken(unitNumber) {
    if (!Number.isSafeInteger(unitNumber)) return undefined
    const epoch = Number.isSafeInteger(this.epoch?.epoch) ? this.epoch.epoch : 0
    const actorId = Number.isSafeInteger(this.epoch?.actor_id) ? this.epoch.actor_id : 0
    return `entity:${actorId}:${epoch}:${unitNumber}`
  }

  lowRiskNavigationProjectionCandidates(operation) {
    if (operation?.name !== 'walk_to_entity') return []
    const entityName = operation.args?.entity_name
    const searchRadius = operation.args?.search_radius
    if (typeof entityName !== 'string' || !Number.isFinite(searchRadius)) return []

    return [...(this.liveEntityObservations?.values?.() ?? [])]
      .filter(observation => observation?.name === entityName
        && Number.isSafeInteger(observation?.unit_number)
        && Number.isFinite(observation?.distance)
        && observation.distance <= searchRadius)
      .sort((left, right) => left.distance - right.distance || left.unit_number - right.unit_number)
      .slice(0, LOW_RISK_NAVIGATION_PROJECTION_MAX_CANDIDATES)
      .map(observation => ({
        id: `walk-unit-${observation.unit_number}`,
        freshness_token: this.liveExactEntityFreshnessToken(observation.unit_number),
        operation: {
          name: 'walk_to_entity_exact',
          args: { unit_number: observation.unit_number },
        },
        description: cleanMemoryText(
          `Observed ${observation.name} unit ${observation.unit_number}`
            + `${observation.type ? ` type ${observation.type}` : ''}`
            + `${observation.position ? ` at (${observation.position.x}, ${observation.position.y})` : ''}`
            + ` distance ${Number(observation.distance.toFixed(2))} from the controlled actor`
            + `${observation.source ? ` via ${observation.source}` : ''}.`,
          400,
        ),
      }))
  }

  async applyLowRiskTypedProjection(plan) {
    if (!this.operationProjectionDecisionProvider) return plan
    if (!plan || !Array.isArray(plan.operations) || plan.operations.length !== 1) return plan
    const sourceOperation = plan.operations[0]
    if (sourceOperation?.name !== 'walk_to_entity') return plan

    const candidates = this.lowRiskNavigationProjectionCandidates(sourceOperation)
    if (candidates.length < 2) return plan

    const generation = this.generation
    const current = await this.assertCurrent()
    const questions = typedProjectionQuestions({ scope: 'navigation', candidates })
    const state = {
      contract: 'typed_operation_projection',
      mode: 'active_low_risk_navigation_exactification',
      semantic_intent: {
        step: cleanMemoryText(currentPlanStep(plan.plan, plan.currentStep), 500),
        chat_message: cleanMemoryText(plan.chatMessage, 800),
        source_operation: {
          name: sourceOperation.name,
          args: sanitizeDurableModelValue(sourceOperation.args),
        },
      },
      candidate_count: candidates.length,
      safety: {
        projection_may_only_replace_name_navigation_with_observed_exact_navigation: true,
        normal_preflight_still_required: true,
        fallback_preserves_main_llm_operation: true,
      },
    }

    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    this.operationProjectionAbort?.abort()
    const controller = new AbortController()
    this.operationProjectionAbort = controller
    const startedAt = Date.now()
    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'typed_operation_projection',
      mode: 'active',
      projection_scope: 'navigation',
      candidate_count: candidates.length,
      source_operation: sourceOperation.name,
      question_ids: Object.keys(questions),
    })

    try {
      const response = await this.operationProjectionDecisionProvider(state, questions, {
        epoch: current.epoch,
        actorId: current.actor_id,
        signal: controller.signal,
      })
      if (generation !== this.generation || !this.active || controller.signal.aborted) {
        throw new AgentLoopError('Model turn was cancelled or superseded')
      }
      await this.assertCurrent()

      const projection = parseTypedProjection(response, { scope: 'navigation', candidates })
      const selectedUnit = Number.isSafeInteger(projection.operation?.args?.unit_number)
        ? projection.operation.args.unit_number
        : undefined
      const currentObservation = selectedUnit === undefined ? undefined : this.liveObservedExactTarget(selectedUnit)
      const routed = routeTypedProjectionByRisk(projection, {
        currentFreshnessToken: currentObservation ? this.liveExactEntityFreshnessToken(selectedUnit) : undefined,
      })
      const latencyMs = Date.now() - startedAt
      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'typed_operation_projection',
        mode: 'active',
        provider: typeof response?.provider === 'string' ? response.provider : undefined,
        model: typeof response?.model === 'string' ? response.model : undefined,
        route: routed.route,
        candidate_id: routed.candidate_id,
        operation_type: routed.operation_type,
        confidence: routed.confidence,
        confidence_policy: routed.confidence_policy,
        projection_failure: routed.projection_failure,
        latency_ms: latencyMs,
      })

      if (routed.route !== 'emit_operation' || routed.operation?.name !== 'walk_to_entity_exact') {
        await this.traceEvent('projection.skipped', {
          contract: 'typed_operation_projection',
          scope: 'navigation',
          reason: routed.projection_failure ?? routed.route,
          source_operation: sourceOperation.name,
          candidate_count: candidates.length,
        })
        return plan
      }

      await this.traceEvent('projection.applied', {
        contract: 'typed_operation_projection',
        scope: 'navigation',
        source_operation: sourceOperation.name,
        projected_operation: routed.operation.name,
        candidate_id: routed.candidate_id,
        confidence: routed.confidence,
        confidence_policy: routed.confidence_policy ?? typedProjectionOperationPolicy(routed.operation.name),
        minimum_confidence: routed.confidence_policy?.minimum_confidence,
        normal_preflight_required: true,
      })
      return { ...plan, operations: [routed.operation] }
    }
    catch (error) {
      if (/cancelled|superseded|epoch changed/i.test(String(error?.message ?? error))) throw error
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'typed_operation_projection',
        mode: 'active',
        fallback_target: 'main_llm_operation',
        reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        latency_ms: Date.now() - startedAt,
      })
      await this.traceEvent('projection.skipped', {
        contract: 'typed_operation_projection',
        scope: 'navigation',
        reason: 'decision_provider_failure',
        source_operation: sourceOperation.name,
        candidate_count: candidates.length,
      })
      return plan
    }
    finally {
      if (this.operationProjectionAbort === controller) this.operationProjectionAbort = null
    }
  }

  passiveProgressWaitCandidate(state = this.memory.currentPlan?.(this.activePlanKey())) {
    if (!state || state.status !== 'active' || !state.task_board?.active_step_id) return undefined
    const observations = [...(this.liveEntityObservations?.values?.() ?? [])].reverse()
    const working = observations.find(observation => Number.isSafeInteger(observation?.unit_number) && observation?.working === true)
    if (!working) return undefined
    return makeConditionWait(
      { kind: 'entity_state', unit_number: working.unit_number, expected: 'working' },
      {
        goalId: state.goal_id,
        stepId: state.task_board.active_step_id,
        mode: 'passive_progress',
        maxChecks: 900,
        actorId: this.epoch?.actor_id,
        actorEpoch: this.epoch?.epoch,
      },
    )
  }

  async inspectConditionWait() {
    const key = this.activePlanKey()
    const state = this.memory.planByNpc?.get?.(key) ?? this.memory.currentPlan?.(key)
    const rawWait = state?.condition_wait
    if (!state || state.status !== 'active' || !rawWait || rawWait.state !== 'active') {
      return { action: 'absent', healthy: false, state }
    }

    const wait = safeConditionWait(rawWait)
    const identity = {
      goal_id: state.goal_id,
      step_id: state.task_board?.active_step_id,
      wait_id: rawWait.id,
    }
    if (!wait) {
      return {
        action: 'failed',
        healthy: false,
        state,
        wait: rawWait,
        identity,
        result: {
          action: 'failed',
          reason: 'invalid_condition_wait',
          wait: { ...rawWait, state: 'failed' },
        },
      }
    }

    identity.actor_id = wait.actor_id
    identity.actor_epoch = wait.actor_epoch

    let before
    try {
      before = await this.captureEpoch()
    }
    catch (error) {
      return {
        action: 'failed',
        healthy: false,
        state,
        wait,
        identity,
        result: {
          action: 'failed',
          reason: `condition_lifecycle_status_error:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
          wait: { ...wait, state: 'failed' },
        },
      }
    }
    if (!conditionWaitLifecycleMatches(wait, before)) {
      return {
        action: 'failed',
        healthy: false,
        state,
        wait,
        identity,
        result: {
          action: 'failed',
          reason: 'condition_lifecycle_changed',
          wait: { ...wait, state: 'failed' },
        },
      }
    }

    let observation
    try {
      observation = JSON.parse(String(await this.rcon.command(runtimeConditionCommand(wait.condition))).trim())
    }
    catch (error) {
      observation = { error: `condition_transport_error:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}` }
    }

    let after
    try {
      after = await this.captureEpoch()
    }
    catch (error) {
      return {
        action: 'failed',
        healthy: false,
        state,
        wait,
        identity,
        result: {
          action: 'failed',
          reason: `condition_lifecycle_status_error:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
          wait: { ...wait, state: 'failed' },
        },
      }
    }

    const current = this.memory.planByNpc?.get?.(key)
    if (!current
      || current.goal_id !== identity.goal_id
      || current.task_board?.active_step_id !== identity.step_id
      || current.condition_wait?.id !== identity.wait_id) {
      return { action: 'stale', healthy: false, state: current, wait, identity }
    }
    if (!conditionWaitLifecycleMatches(wait, after)) {
      return {
        action: 'failed',
        healthy: false,
        state: current,
        wait,
        identity,
        result: {
          action: 'failed',
          reason: 'condition_lifecycle_changed',
          wait: { ...wait, state: 'failed' },
        },
      }
    }

    const normalizedObservation = normalizedConditionObservation(observation)
    const result = applyConditionObservation(wait, normalizedObservation)
    return {
      action: result.action,
      healthy: result.action === 'waiting',
      state: current,
      wait,
      identity,
      observation: normalizedObservation,
      result,
    }
  }

  async validateConditionWaitHealth() {
    const inspected = await this.inspectConditionWait()
    return {
      healthy: inspected.healthy === true,
      action: inspected.action,
      reason: inspected.result?.reason,
      wait: inspected.wait,
      observation: inspected.observation,
      state: inspected.state,
    }
  }

  async pollConditionWait() {
    if (this.conditionPollPromise) return this.conditionPollPromise
    this.conditionPollPromise = (async () => {
      const inspected = await this.inspectConditionWait()
      if (!inspected || inspected.action === 'absent') return null

      const key = this.activePlanKey()
      const identity = inspected.identity ?? {}
      if (inspected.action === 'stale') {
        await this.traceEvent('runtime.condition_stale', identity)
        return { action: 'stale', wait_id: identity.wait_id }
      }

      const wait = inspected.wait
      const result = inspected.result
      const normalizedObservation = inspected.observation
      if (!result) return null

      if (result.action === 'waiting') {
        const updated = this.memory.updateConditionWait?.(key, result.wait)
        await this.persistState()
        await this.traceEvent('runtime.condition_waiting', {
          wait_id: identity.wait_id,
          condition: wait.condition,
          observation: normalizedObservation,
          checks: result.wait?.checks,
        })
        return { action: 'waiting', wait_id: identity.wait_id, state: updated, observation: normalizedObservation }
      }

      if (result.action === 'verified') {
        const evidence = {
          kind: 'condition_satisfied',
          ref: identity.wait_id,
          summary: JSON.stringify({
            verdict: 'verified_complete',
            condition: wait.condition,
            observation: normalizedObservation,
          }),
        }
        const reduced = this.memory.applyOutcomeAuthority?.(key, {
          kind: 'verified_complete',
          source: 'condition_wait',
          reason_code: 'condition_satisfied',
          evidence: [evidence],
          metadata: { scope: 'step' },
        })
        await this.persistState()
        await this.traceEvent('runtime.condition_satisfied', {
          wait_id: identity.wait_id,
          condition: wait.condition,
          task_board: visibleTaskBoard(reduced?.state?.task_board),
        })
        await this.traceEvent('step.verified', {
          source: 'condition_wait',
          wait_id: identity.wait_id,
          task_board: visibleTaskBoard(reduced?.state?.task_board),
        })
        return { action: 'verified', wait_id: identity.wait_id, state: reduced?.state, observation: normalizedObservation }
      }

      const updated = result.wait
        ? this.memory.updateConditionWait?.(key, result.wait)
        : this.memory.clearConditionWait?.(key, identity.wait_id)
      await this.persistState()
      const event = result.action === 'timeout'
        ? 'runtime.condition_timeout'
        : result.action === 'wake'
          ? 'runtime.condition_progress_stopped'
          : 'runtime.condition_failed'
      await this.traceEvent(event, {
        wait_id: identity.wait_id,
        condition: wait?.condition,
        reason: result.reason,
        observation: normalizedObservation,
      })
      return { action: result.action, wait_id: identity.wait_id, state: updated, reason: result.reason, observation: normalizedObservation }
    })()
    try {
      return await this.conditionPollPromise
    }
    finally {
      this.conditionPollPromise = null
    }
  }


  observedMiningTargets(entityName) {
    const byReference = new Map()
    const remember = (entity, actorPosition) => {
      if (!entity || entity.name !== entityName) return
      const reference = Number.isSafeInteger(entity.unit_number)
        ? `entity:${entity.unit_number}`
        : `fallback:${entity.name}:${entity.type ?? 'unknown'}:${entity.position?.x ?? '?'}:${entity.position?.y ?? '?'}`
      let distance = Number.isFinite(entity.distance) ? entity.distance : undefined
      if (distance === undefined && actorPosition && entity.position
        && Number.isFinite(actorPosition.x) && Number.isFinite(actorPosition.y)
        && Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)) {
        distance = Math.hypot(entity.position.x - actorPosition.x, entity.position.y - actorPosition.y)
      }
      byReference.set(reference, {
        name: entity.name,
        type: entity.type,
        unit_number: Number.isSafeInteger(entity.unit_number) ? entity.unit_number : undefined,
        position: entity.position,
        distance,
      })
    }

    for (const entity of this.liveEntityObservations?.values?.() ?? []) remember(entity, undefined)
    return [...byReference.values()]
  }

  legacyMiningApproachVerified(entityName) {
    const state = this.memory.currentPlan?.(this.activePlanKey())
    if (state?.last_mutation_verified !== true || !Array.isArray(state.last_operations)) return false
    return state.last_operations.some((value) => {
      const separator = typeof value === 'string' ? value.indexOf(' ') : -1
      if (separator < 1 || value.slice(0, separator) !== 'walk_to_entity') return false
      try {
        const args = JSON.parse(value.slice(separator + 1))
        return args?.entity_name === entityName
      }
      catch {
        return false
      }
    })
  }

  failureSnapshot(stage, message) {
    const request = this.traceRequest
    const planState = this.memory.currentPlan?.(this.activePlanKey())
    return {
      stage,
      message: cleanMemoryText(message, 2000),
      request_id: request?.id,
      turn: request ? this.continuations + 1 : undefined,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      provider: request?.last_provider_event,
      recovery: request?.recovery,
      last_tool: request?.last_tool,
      plan: compactPlanFailureState(planState),
      usage: request?.usage,
    }
  }

  async readInteractionTaskStatus() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      return compactInteractionTaskStatus(raw)
    }
    catch (error) {
      return { status_error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300) }
    }
  }

  async classifyInteraction(text, sender, taskStatus, planState) {
    const current = await super.captureEpoch()
    await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
    const currentGoal = planState
      ? {
          goal_id: sanitizeDurableModelText(planState.goal_id, 100),
          objective: sanitizeDurableModelText(planState.objective, 500),
          status: planState.status,
          active_step: Number.isSafeInteger(planState.task_board?.active_index)
            ? sanitizeDurableModelText(planState.task_board?.steps?.[planState.task_board.active_index]?.description, 300)
            : undefined,
        }
      : null

    const state = {
      message: cleanMemoryText(text, 4000),
      sender: cleanMemoryText(sender, 128),
      current_goal: currentGoal,
      runtime: taskStatus,
    }

    this.interactionAbort?.abort()
    const controller = new AbortController()
    this.interactionAbort = controller

    const decisionQuestions = interactionDecisionQuestions()
    const decisionId = this.interactionDecisionProvider
      ? `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
      : undefined
    let typedDecision
    let decisionError
    let decisionLatencyMs

    try {
      if (decisionId) {
        await this.decisionTraceEvent('decision.request', {
          decision_id: decisionId,
          contract: 'interaction_route',
          mode: 'hybrid_signal',
          question_ids: Object.keys(decisionQuestions),
          message_chars: state.message.length,
          has_current_goal: currentGoal !== null,
          runtime_task_state: cleanMemoryText(taskStatus?.task_state, 64),
          runtime_queue_length: Number.isSafeInteger(taskStatus?.queue_length) ? taskStatus.queue_length : 0,
        })

        const decisionStartedAt = Date.now()
        try {
          const response = await this.interactionDecisionProvider(state, decisionQuestions, {
            epoch: current.epoch,
            actorId: current.actor_id,
            signal: controller.signal,
          })
          typedDecision = parseInteractionDecisionShadow(response)
          decisionLatencyMs = Date.now() - decisionStartedAt
          await this.decisionTraceEvent('decision.response', {
            decision_id: decisionId,
            contract: 'interaction_route',
            mode: 'hybrid_signal',
            provider: typedDecision.provider,
            model: typedDecision.model,
            intent: typedDecision.intent,
            confidence: typedDecision.intent_confidence,
            queue_conflict_probability: typedDecision.queue_conflict_probability,
            latency_ms: decisionLatencyMs,
            input_units: Number.isFinite(typedDecision.usage?.input_tokens) ? Math.max(0, Math.trunc(typedDecision.usage.input_tokens)) : 0,
            output_units: Number.isFinite(typedDecision.usage?.output_tokens) ? Math.max(0, Math.trunc(typedDecision.usage.output_tokens)) : 0,
            cost_usd: Number.isFinite(typedDecision.usage?.cost) && typedDecision.usage.cost >= 0 ? typedDecision.usage.cost : 0,
          })
        }
        catch (error) {
          decisionLatencyMs = Date.now() - decisionStartedAt
          decisionError = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
          await this.decisionTraceEvent('decision.fallback', {
            decision_id: decisionId,
            contract: 'interaction_route',
            mode: 'hybrid_signal',
            fallback_target: 'interaction_router',
            reason: decisionError,
            latency_ms: decisionLatencyMs,
          })
        }
      }

      if (controller.signal.aborted) {
        throw new AgentLoopError('Interaction routing cancelled or superseded')
      }

      if (typedDecision && !interactionDecisionNeedsLanguageRouter(typedDecision)) {
        const route = interactionRouteFromTypedDecision(typedDecision)
        await this.decisionTraceEvent('decision.route_applied', {
          decision_id: decisionId,
          contract: 'interaction_route',
          mode: 'active_typed',
          active_source: 'jev',
          active_intent: route.intent,
          typed_intent: typedDecision.intent,
          typed_confidence: typedDecision.intent_confidence,
          language_router_called: false,
        })
        return {
          route,
          epoch: current,
          decision_id: decisionId,
          decision_shadow: typedDecision,
          decision_shadow_error: decisionError,
          decision_shadow_latency_ms: decisionLatencyMs,
          interaction_router_called: false,
          route_source: 'jev',
          router_bypassed: false,
        }
      }

      if (!this.interactionProvider) {
        throw new AgentLoopError('Interaction router provider is unavailable for ambiguous or conversational interaction')
      }

      const message = await this.interactionProvider([
        { role: 'system', content: INTERACTION_ROUTER_PROMPT },
        { role: 'user', content: JSON.stringify(state) },
      ], {
        epoch: current.epoch,
        actorId: current.actor_id,
        round: 0,
        allowTools: false,
        recoveryAttempt: 0,
        triggerSource: 'interaction_router',
        interactionRouter: true,
        signal: controller.signal,
        requestBodyPatch: {
          max_tokens: 180,
          response_format: { type: 'json_object' },
        },
      })
      const route = parseInteractionRoute(message)
      if (decisionId) {
        await this.decisionTraceEvent('decision.route_applied', {
          decision_id: decisionId,
          contract: 'interaction_route',
          mode: typedDecision ? 'hybrid_double_evaluation' : 'language_router_fallback',
          active_source: 'interaction_router',
          active_intent: route.intent,
          typed_intent: typedDecision?.intent ?? '',
          agreement: typedDecision ? typedDecision.intent === route.intent : undefined,
          typed_available: Boolean(typedDecision),
          language_router_called: true,
        })
      }
      return {
        route,
        epoch: current,
        decision_id: decisionId,
        decision_shadow: typedDecision,
        decision_shadow_error: decisionError,
        decision_shadow_latency_ms: decisionLatencyMs,
        interaction_router_called: true,
        route_source: 'interaction_router',
        router_bypassed: false,
      }
    }
    finally {
      controller.abort()
      if (this.interactionAbort === controller) this.interactionAbort = null
    }
  }

  async readGoalProgressFacts() {
    try { return parseGoalProgressFacts(await this.rcon.command(goalProgressFactsCommand())) }
    catch { return undefined }
  }

  async requestInteractionPlannerShape(text, sender, taskStatus, planState, intent, epoch) {
    if (intent === 'new_goal') this.goalReading = null
    if (!this.interactionDecisionProvider) return undefined
    // A new goal also gets Jev's blind goal reading in the same request: the
    // player's words plus save-progress facts, never the planner's answer.
    const readGoal = intent === 'new_goal' && this.goalDefinitionPolicy === 'required'
    const saveProgress = readGoal ? await this.readGoalProgressFacts() : undefined
    const questions = readGoal
      ? { ...interactionPlannerShapeQuestions(), ...goalReadingQuestions() }
      : interactionPlannerShapeQuestions()
    const state = {
      contract: 'interaction_planner_shape',
      active_intent: INTERACTION_INTENTS.has(intent) ? intent : 'continue_current',
      message: cleanMemoryText(text, 4000),
      sender: cleanMemoryText(sender, 128),
      current_goal: planState
        ? {
            goal_id: sanitizeDurableModelText(planState.goal_id, 100),
            objective: sanitizeDurableModelText(planState.objective, 500),
            status: planState.status,
            active_step: Number.isSafeInteger(planState.task_board?.active_index)
              ? sanitizeDurableModelText(planState.task_board?.steps?.[planState.task_board.active_index]?.description, 300)
              : undefined,
          }
        : null,
      runtime: taskStatus,
      ...(readGoal ? { save_progress: saveProgress ?? null } : {}),
    }

    this.interactionAbort?.abort()
    const controller = new AbortController()
    this.interactionAbort = controller
    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    const startedAt = Date.now()

    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'interaction_planner_shape',
      mode: 'active_advisory',
      active_intent: state.active_intent,
      question_ids: Object.keys(questions),
    })

    try {
      const response = await this.interactionDecisionProvider(state, questions, {
        epoch: epoch?.epoch ?? this.epoch?.epoch,
        actorId: epoch?.actor_id ?? this.epoch?.actor_id,
        signal: controller.signal,
      })
      const steering = parseBoundarySteeringTelemetry(response)
      const observationRelevance = parseObservationRelevance(response)
      if (readGoal) {
        const reading = parseGoalReading(response)
        this.goalReading = reading
          ? { ...reading, decision_id: decisionId, facts: saveProgress, challenged: false }
          : null
      }
      const shape = {
        reasoning_budget: steering.reasoning_budget,
        reasoning_confidence: steering.reasoning_confidence,
        planning_horizon: steering.planning_horizon,
        observation_relevance: observationRelevance,
        observation_budget: observationRelevance.budget,
        model: typeof response?.model === 'string' ? response.model : undefined,
        provider: typeof response?.provider === 'string' ? response.provider : undefined,
        usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
      }
      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'interaction_planner_shape',
        mode: 'active_advisory',
        active_intent: state.active_intent,
        reasoning_budget: shape.reasoning_budget,
        reasoning_confidence: shape.reasoning_confidence,
        planning_horizon: shape.planning_horizon,
        observation_families: shape.observation_relevance?.selected_families,
        observation_budget: shape.observation_budget,
        ...(readGoal
          ? {
              goal_reading: this.goalReading
                ? {
                    scope: this.goalReading.scope,
                    scope_confidence: this.goalReading.scope_confidence,
                    family: this.goalReading.family,
                    family_confidence: this.goalReading.family_confidence,
                    measurable_probability: this.goalReading.measurable_probability,
                  }
                : null,
              save_progress_available: saveProgress !== undefined,
            }
          : {}),
        provider: shape.provider,
        model: shape.model,
        latency_ms: Date.now() - startedAt,
        input_units: Number.isFinite(shape.usage?.input_tokens) ? Math.max(0, Math.trunc(shape.usage.input_tokens)) : 0,
        output_units: Number.isFinite(shape.usage?.output_tokens) ? Math.max(0, Math.trunc(shape.usage.output_tokens)) : 0,
        cost_usd: Number.isFinite(shape.usage?.cost) && shape.usage.cost >= 0 ? shape.usage.cost : 0,
      })
      return shape
    }
    catch (error) {
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'interaction_planner_shape',
        mode: 'active_advisory',
        active_intent: state.active_intent,
        fallback_target: 'main_planner_defaults',
        reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        latency_ms: Date.now() - startedAt,
      })
      return undefined
    }
    finally {
      controller.abort()
      if (this.interactionAbort === controller) this.interactionAbort = null
    }
  }

  async authoritativeGroundCheckpointRequirement(requirement, { allowedReceiptNames = new Set() } = {}) {
    const one = sanitizeStepCompletionContract({ mode: 'all', requirements: [requirement] })
    const normalized = one.requirements?.[0]
    if (!completionContractSupported(one) || !normalized) {
      return { ok: false, reason: 'unsupported_or_malformed_predicate' }
    }

    if (['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(normalized.kind)) {
      const exact = Number.isSafeInteger(normalized.unit_number)
        ? this.liveObservedExactTarget(normalized.unit_number)
        : undefined
      if (Number.isSafeInteger(normalized.unit_number) && !exact) {
        return { ok: false, reason: 'exact_identity_not_bound_to_current_request' }
      }
      const { id: _id, ...condition } = normalized
      try {
        const raw = JSON.parse(String(await this.rcon.command(runtimeConditionCommand(condition))).trim())
        if (!raw || raw.ok !== true) {
          return {
            ok: false,
            reason: cleanMemoryText(raw?.error || 'condition_not_authoritatively_evaluable', 160),
          }
        }
        return {
          ok: true,
          requirement: normalized,
          entity: exact,
          fact: {
            ...(Number.isFinite(raw.current) ? { current: raw.current } : {}),
            ...(Number.isSafeInteger(normalized.unit_number) ? { exists: true } : {}),
            ...(raw.progressing !== undefined ? { working: raw.progressing === true } : {}),
          },
        }
      }
      catch (error) {
        return {
          ok: false,
          reason: `condition_grounding_failed:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
        }
      }
    }

    if (normalized.kind === 'authoritative_operation_receipt') {
      if (!allowedReceiptNames.has(normalized.operation_name)) {
        return { ok: false, reason: 'operation_receipt_not_semantically_grounded' }
      }
      return { ok: true, requirement: normalized }
    }

    if (normalized.kind === 'runtime_controller_state') {
      if (normalized.controller !== 'follow') {
        return { ok: false, reason: 'unsupported_runtime_controller' }
      }
      try {
        const raw = JSON.parse(String(await this.rcon.command(toolCommand('getFollowStatus', {}))).trim())
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          return { ok: false, reason: 'runtime_controller_not_authoritatively_evaluable' }
        }
        return {
          ok: true,
          requirement: normalized,
          fact: {
            active: raw.active === true,
            healthy: raw.healthy === true,
            controller_live: raw.controller_live === true,
          },
        }
      }
      catch (error) {
        return {
          ok: false,
          reason: `controller_grounding_failed:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
        }
      }
    }

    return { ok: false, reason: 'unsupported_predicate_kind' }
  }

  async validatePlannerCheckpointContract(contract, operations = []) {
    const normalized = sanitizeStepCompletionContract(contract)
    if (!completionContractSupported(normalized)) {
      return { accepted: false, reason: 'unsupported_or_malformed_contract' }
    }
    const allowedReceiptNames = new Set(
      (Array.isArray(operations) ? operations : [])
        .map(operation => operation?.name)
        .filter(name => typeof name === 'string' && name),
    )
    for (const requirement of normalized.requirements ?? []) {
      const grounded = await this.authoritativeGroundCheckpointRequirement(requirement, { allowedReceiptNames })
      if (!grounded.ok) {
        return {
          accepted: false,
          reason: grounded.reason,
          requirement_id: requirement.id,
          requirement_kind: requirement.kind,
        }
      }
    }
    return { accepted: true, contract: normalized }
  }

  async persistPlannerCheckpoint(plan) {
    if (!plan?.checkpoint || !this.requestInfo?.memoryKey) {
      return { state: this.memory.currentPlan?.(this.activePlanKey()) }
    }
    const key = this.requestInfo.memoryKey
    const state = this.memory.currentPlan?.(key)
    const board = state?.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const step = activeIndex === undefined ? undefined : board?.steps?.[activeIndex]
    if (!state || state.status !== 'active' || !step) {
      throw new AgentLoopError('checkpoint_requires_active_step')
    }

    const validation = await this.validatePlannerCheckpointContract(plan.checkpoint, plan.operations)
    if (!validation.accepted) {
      const error = new AgentLoopError(
        `deterministic_checkpoint_rejected: ${validation.reason}${validation.requirement_id ? `; requirement=${validation.requirement_id}` : ''}`,
      )
      error.failureClass = 'plan_category'
      error.code = 'invalid_semantic_checkpoint'
      error.details = validation
      throw error
    }

    const planning = this.memory.planningState?.(key)
    const reducerPlan = planning ? getActivePlanningPlan(planning) : undefined
    const frozen = FROZEN_PLAN_STATUSES.has(reducerPlan?.status)
    const existing = persistedStepCheckpoint(board, step.id)
    const incomingSignature = JSON.stringify(validation.contract)
    const existingSignature = existing ? JSON.stringify(existing.contract) : ''

    if (frozen) {
      if (!existing || existingSignature !== incomingSignature) {
        // A committed step's meaning is immutable, so the resent contract is
        // ignored and the committed one (or none) stays authoritative. This
        // used to throw after the plan was already persisted as admitting,
        // which killed continuation and restart recovery whenever the planner
        // re-stated a checkpoint with, say, an adjusted minimum.
        await this.traceEvent('step.checkpoint_change_ignored', {
          active_step_id: step.id,
          reason: 'committed_completion_contract_is_immutable',
          committed_contract: existing?.contract,
          proposed_contract: validation.contract,
        })
        this.messages.push({
          role: 'user',
          content: `[HARNESS] Step ${step.id} is committed, so its completion contract cannot change; the checkpoint you sent was ignored and ${existing ? 'the committed checkpoint still decides completion' : 'the step keeps its committed completion rules'}. Do not resend a different checkpoint for this step.`,
        })
        return { state, contract: existing?.contract, stepId: step.id, ignored: true }
      }
      return { state, contract: existing.contract, stepId: step.id }
    }

    this.memory.setStepCompletionContract?.(key, step.id, validation.contract)
    const updated = this.memory.currentPlan?.(key)
    const persisted = persistedStepCheckpoint(updated?.task_board, step.id)
    if (!persisted || JSON.stringify(persisted.contract) !== incomingSignature) {
      throw new AgentLoopError('deterministic_checkpoint_failed_to_persist')
    }

    this.memory.recordBoardEvidence?.(key, {
      kind: 'step_completion_contract_validated',
      ref: `checkpoint/${step.id}`,
      summary: JSON.stringify({
        source: 'main_planner',
        validation: 'deterministic_runtime',
        contract: persisted.contract,
      }),
    })
    await this.persistState()
    await this.traceEvent('step.checkpoint_validated', {
      active_step_id: step.id,
      contract: persisted.contract,
      authority: 'deterministic_runtime',
    })
    return { state: this.memory.currentPlan?.(key), contract: persisted.contract, stepId: step.id }
  }

  async declineStepClose(trigger, reason, detail = {}) {
    await this.traceEvent('step.close_declined', { trigger, reason, ...detail })
    return { closed: false, reason }
  }

  async applyStepClose(trigger, { key, step, contract, results, reasonCode, source, plannerStep, extraEvidence = [], steeringRecommendation }) {
    const reduced = this.memory.applyOutcomeAuthority?.(key, {
      kind: 'verified_complete',
      source: 'deterministic_runtime',
      reason_code: reasonCode,
      evidence: [...extraEvidence, {
        kind: 'verified_world_state',
        ref: `checkpoint/${step.id}`,
        summary: JSON.stringify({ contract, results, planner_step: plannerStep }),
      }],
      metadata: { scope: 'step' },
    }, { steeringRecommendation })
    await this.persistState()
    if (reduced?.decision?.accepted !== true) {
      const declined = await this.declineStepClose(trigger, reduced?.decision?.rejection_reason || 'outcome_authority_rejected_completion', {
        active_step_id: step.id,
        contract,
      })
      return { ...declined, state: reduced?.state }
    }
    await this.traceEvent('step.verified', {
      active_step_id: step.id,
      source,
      contract,
      task_board: visibleTaskBoard(reduced?.state?.task_board),
    })
    return { closed: true, state: reduced.state }
  }

  async evaluateWorldStateCheckpoint(checkpoint) {
    const contract = checkpoint?.contract
    if (!worldStateContract(contract)) return undefined
    const facts = await this.completionFactsForContract(contract, undefined, [])
    return evaluateCompletionContract(contract, facts)
  }

  async completionFactsForContract(contract, verification, operationNames) {
    const facts = {}
    const normalized = sanitizeStepCompletionContract(contract)
    for (const requirement of normalized.requirements ?? []) {
      if (requirement.kind === 'authoritative_operation_receipt') {
        facts[requirement.id] = {
          kind: requirement.kind,
          authoritative: verification !== undefined,
          operation_name: operationNames.length === 1 ? operationNames[0] : undefined,
          operation_names: operationNames,
          summary: cleanMemoryText(verification?.summary, 600),
        }
        continue
      }
      if (['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(requirement.kind)) {
        if (Number.isSafeInteger(requirement.unit_number) && !this.liveObservedExactTarget(requirement.unit_number)) {
          facts[requirement.id] = {
            kind: requirement.kind,
            unit_number: requirement.unit_number,
            stale: true,
            summary: 'exact_identity_not_bound_to_current_request',
          }
          continue
        }
        const { id: _id, ...condition } = requirement
        try {
          const raw = JSON.parse(String(await this.rcon.command(runtimeConditionCommand(condition))).trim())
          const observation = normalizedConditionObservation(raw)
          facts[requirement.id] = {
            kind: requirement.kind,
            ...(Number.isSafeInteger(requirement.unit_number) ? { unit_number: requirement.unit_number } : {}),
            ...(typeof requirement.item_name === 'string' ? { item_name: requirement.item_name } : {}),
            ...(Number.isFinite(raw?.current) ? { current: raw.current } : {}),
            ...(Number.isSafeInteger(requirement.unit_number) && raw?.ok === true ? { exists: true } : {}),
            ...(raw?.exists !== undefined ? { exists: raw.exists === true } : {}),
            ...(raw?.working !== undefined ? { working: raw.working === true } : {}),
            ...(raw?.progressing !== undefined ? { working: raw.progressing === true } : {}),
            ...(raw?.stale !== undefined ? { stale: raw.stale === true } : {}),
            satisfied: observation.satisfied === true,
            progressing: observation.progressing === true,
            summary: observation.summary,
          }
        }
        catch (error) {
          facts[requirement.id] = {
            kind: requirement.kind,
            summary: `condition_observation_failed:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
          }
        }
        continue
      }
      if (requirement.kind === 'runtime_controller_state') {
        try {
          const raw = requirement.controller === 'follow'
            ? JSON.parse(String(await this.rcon.command(toolCommand('getFollowStatus', {}))).trim())
            : undefined
          const authoritative = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw))
          const satisfied = authoritative && (
            requirement.expected === 'idle'
              ? raw.active !== true
              : requirement.expected === 'active'
                ? raw.active === true
                : raw.active === true && raw.healthy === true && raw.controller_live === true
          )
          facts[requirement.id] = {
            kind: requirement.kind,
            authoritative,
            controller: requirement.controller,
            state: satisfied
              ? requirement.expected
              : raw?.active === true
                ? 'active'
                : 'idle',
            summary: authoritative
              ? `${requirement.controller}:${raw.active === true ? 'active' : 'idle'}:${raw.healthy === true && raw.controller_live === true ? 'healthy' : 'not_healthy'}`
              : 'runtime_controller_not_authoritatively_evaluable',
          }
        }
        catch (error) {
          facts[requirement.id] = {
            kind: requirement.kind,
            authoritative: false,
            controller: requirement.controller,
            summary: `controller_observation_failed:${cleanMemoryText(error instanceof Error ? error.message : String(error), 160)}`,
          }
        }
      }
    }
    return facts
  }

  async requestBoundarySteeringRecommendation(memoryKey, {
    boundary,
    receipt,
    world,
  } = {}) {
    if (!this.steeringDecisionProvider) return undefined
    const planning = this.memory.planningState?.(memoryKey)
    if (!planning?.goal) return undefined

    const activePlan = getActivePlanningPlan(planning)
    const state = {
      contract: 'planning_boundary_steering',
      boundary,
      goal: {
        goal_id: sanitizeDurableModelText(planning.goal.goal_id, 120),
        objective: sanitizeDurableModelText(planning.goal.objective, 600),
        status: planning.goal.status,
      },
      roadmap: planning.roadmap
        ? {
            roadmap_revision_id: planning.roadmap.roadmap_revision_id,
            nodes: (planning.roadmap.nodes ?? []).slice(0, 24).map(node => ({
              id: sanitizeDurableModelText(node.id, 120),
              intent: sanitizeDurableModelText(node.intent, 400),
              status: node.status,
              depends_on: Array.isArray(node.depends_on) ? node.depends_on.slice(0, 16) : [],
              development_hint: node.development_hint ?? null,
              verified_results: Array.isArray(node.verified_results) ? node.verified_results.slice(-8) : [],
            })),
          }
        : null,
      steering: sanitizeDurableModelValue(planning.steering),
      active_plan: activePlan
        ? {
            plan_id: activePlan.plan_id,
            status: activePlan.status,
            roadmap_node_ids: [...(activePlan.roadmap_node_ids ?? [])],
            development_mode: activePlan.development_mode,
            steps: (activePlan.steps ?? []).slice(0, 16).map(step => ({
              step_id: step.step_id,
              description: sanitizeDurableModelText(step.description, 400),
              status: activePlan.execution?.step_progress?.[step.step_id]?.status,
            })),
          }
        : null,
      verified_world: sanitizeDurableModelValue(receipt?.providerStatus ?? receipt?.view ?? world),
    }

    const steeringQuestionOptions = {
      candidateShelfNodes: state.roadmap?.nodes ?? [],
      pressureVocabulary: STEERING_PRESSURE_VOCABULARY,
    }
    const questions = steeringRecommendationQuestions(steeringQuestionOptions)
    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    const startedAt = Date.now()
    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'planning_boundary_steering',
      boundary,
      question_ids: Object.keys(questions),
    })

    try {
      const response = await this.steeringDecisionProvider(state, questions, {
        epoch: this.epoch?.epoch,
        actorId: this.epoch?.actor_id,
      })
      const parsed = parseSteeringRecommendation(response, steeringQuestionOptions)
      const recommendation = {
        ...parsed,
        pressure: steeringPressureFromReasonCodes(parsed.reason_codes),
        recommended_by: 'jev',
      }
      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'planning_boundary_steering',
        boundary,
        recommended_mode: recommendation.recommended_mode,
        confidence: recommendation.confidence,
        reason_codes: recommendation.reason_codes,
        candidate_shelf_nodes: recommendation.candidate_shelf_nodes,
        shelf_node_confidence: recommendation.shelf_node_confidence,
        pressure_probabilities: recommendation.pressure_probabilities,
        pressure: recommendation.pressure,
        provider: recommendation.provider,
        model: recommendation.model,
        latency_ms: Date.now() - startedAt,
      })
      await this.traceEvent('planning.steering_recommendation', {
        boundary,
        recommended_mode: recommendation.recommended_mode,
        confidence: recommendation.confidence,
        reason_codes: recommendation.reason_codes,
        candidate_shelf_nodes: recommendation.candidate_shelf_nodes,
        pressure: recommendation.pressure,
      })
      return recommendation
    }
    catch (error) {
      const message = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'planning_boundary_steering',
        boundary,
        fallback_target: 'runtime_boundary_default',
        reason: message,
        latency_ms: Date.now() - startedAt,
      })
      await this.traceEvent('planning.steering_recommendation_failed', { boundary, reason: message })
      return undefined
    }
  }

  async routeStepCompletionDecision(receipt) {
    const key = this.activePlanKey()
    const planState = this.memory.planByNpc?.get?.(key) ?? this.memory.currentPlan?.(key)
    const board = planState?.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const step = activeIndex === undefined ? undefined : board?.steps?.[activeIndex]
    const batchId = Number.isSafeInteger(receipt?.view?.last_completed_batch?.batch_id)
      ? receipt.view.last_completed_batch.batch_id
      : undefined
    const ref = batchId ? `batch_${batchId}` : ''
    const verification = ref
      ? [...(board?.evidence ?? [])].reverse().find(item =>
          item?.kind === 'deterministic_verification'
          && item?.ref === ref
          && item?.step_id === step?.id)
      : undefined

    if (!planState || planState.status !== 'active' || !step || !verification) {
      await this.declineStepClose('batch_receipt', 'no_authoritative_operation_receipt', {
        active_step_id: step?.id,
        batch_id: batchId,
      })
      return { verified: false, reason: 'no_authoritative_operation_receipt', state: planState }
    }

    const checkpoint = persistedStepCheckpoint(board, step.id)
    if (!checkpoint?.contract) {
      await this.declineStepClose('batch_receipt', 'semantic_completion_requires_planner', {
        active_step_id: step.id,
      })
      return {
        verified: false,
        reason: 'semantic_completion_requires_planner',
        state: planState,
      }
    }

    let operationNames = []
    try {
      const parsed = JSON.parse(verification.summary)
      operationNames = Array.isArray(parsed?.operations)
        ? parsed.operations.filter(name => typeof name === 'string').slice(0, 8)
        : []
    }
    catch {}

    const facts = await this.completionFactsForContract(checkpoint.contract, verification, operationNames)
    const evaluation = evaluateCompletionContract(checkpoint.contract, facts)
    await this.traceEvent('step.completion_checked', {
      active_step_id: step.id,
      status: evaluation.status,
      contract: evaluation.contract,
      evidence: evaluation.results,
      authority: 'deterministic_runtime',
    })
    if (!evaluation.satisfied) {
      await this.declineStepClose('batch_receipt', 'target_unmet', {
        active_step_id: step.id,
        contract: checkpoint.contract,
        results: evaluation.results,
      })
      return {
        verified: false,
        reason: 'checkpoint_requirements_unsatisfied',
        state: planState,
        contract: checkpoint.contract,
      }
    }

    const finalPlanStep = activeIndex === (Array.isArray(board?.steps) ? board.steps.length - 1 : -1)
    const steeringRecommendation = finalPlanStep && this.steeringDecisionProvider
      ? await this.requestBoundarySteeringRecommendation(key, {
          boundary: STEERING_BOUNDARY.PLAN_COMPLETED,
          receipt,
        })
      : undefined

    const closed = await this.applyStepClose('batch_receipt', {
      key,
      step,
      contract: checkpoint.contract,
      results: evaluation.results,
      reasonCode: 'deterministic_checkpoint_satisfied',
      source: 'deterministic_completion_contract',
      extraEvidence: [verification],
      steeringRecommendation,
    })
    if (!closed.closed) {
      return {
        verified: false,
        reason: closed.reason,
        state: closed.state ?? planState,
        contract: checkpoint.contract,
      }
    }
    return { verified: true, state: closed.state, contract: checkpoint.contract }
  }

  // Planner-shape judgments (reasoning budget, horizon, observation relevance,
  // and trace-only typed state) only matter when the Main LLM is about to wake,
  // so they are not bought on boundaries where deterministic runtime continues.
  // Returns undefined on failure: the planner then wakes without Jev shaping.
  async requestPostStepPlannerShape(state, { current, generation, signal }) {
    const questions = {
      ...interactionPlannerShapeQuestions(),
      ...typedStateDistillationQuestions(),
    }
    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    const startedAt = Date.now()
    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'post_step_planner_shape',
      mode: 'active_advisory',
      boundary: state.boundary,
      question_ids: Object.keys(questions),
    })
    try {
      const response = await this.interactionDecisionProvider(state, questions, {
        epoch: current.epoch,
        actorId: current.actor_id,
        signal,
      })
      if (generation !== this.generation || !this.active || signal.aborted) {
        throw new AgentLoopError('Model turn was cancelled or superseded')
      }
      // Same parsing as the former single post-step call; `development` is
      // not asked here and is owned by the gate call.
      const { reasoning_budget, reasoning_confidence, planning_horizon, observation_budget } = parseBoundarySteeringTelemetry(response)
      const observationRelevance = parseObservationRelevance(response)
      const typedState = parseTypedStateDistillation(response, { provenance: typedStateProvenance(state) })
      const shape = {
        reasoning_budget,
        reasoning_confidence,
        planning_horizon,
        observation_budget,
        observation_relevance: observationRelevance,
        typed_state: typedState,
        typed_state_mode: 'experimental_trace_only',
      }
      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'post_step_planner_shape',
        mode: 'active_advisory',
        boundary: state.boundary,
        provider: typeof response?.provider === 'string' ? response.provider : undefined,
        model: typeof response?.model === 'string' ? response.model : undefined,
        reasoning_budget: shape.reasoning_budget,
        planning_horizon: shape.planning_horizon,
        observation_budget: shape.observation_budget,
        typed_state_experimental: typedState.available === true,
        typed_state_context_injected: false,
        latency_ms: Date.now() - startedAt,
        input_units: Number.isFinite(response?.usage?.input_tokens) ? Math.max(0, Math.trunc(response.usage.input_tokens)) : 0,
        output_units: Number.isFinite(response?.usage?.output_tokens) ? Math.max(0, Math.trunc(response.usage.output_tokens)) : 0,
        cost_usd: Number.isFinite(response?.usage?.cost) && response.usage.cost >= 0 ? response.usage.cost : 0,
      })
      return shape
    }
    catch (error) {
      if (generation !== this.generation || !this.active || signal.aborted) throw error
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'post_step_planner_shape',
        mode: 'active_advisory',
        boundary: state.boundary,
        fallback_target: 'main_planner_defaults',
        reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        latency_ms: Date.now() - startedAt,
      })
      return undefined
    }
  }

  async routePostStepDecision(receipt, { boundary = 'completion', failure = '' } = {}) {
    const generation = this.generation
    const current = await this.assertCurrent()
    const persistentRuntime = await this.persistentRuntimeStatus()
    const autorioStatus = receipt?.view && typeof receipt.view === 'object'
      ? receipt.view
      : (receipt?.providerStatus && typeof receipt.providerStatus === 'object' ? receipt.providerStatus : {})
    const autorioRuntimeHealthy = interactionRuntimeHealthy(autorioStatus)
    const persistentControllerHealthy = persistentRuntimeHealthy(persistentRuntime)
    const planState = this.memory.planByNpc?.get?.(this.activePlanKey()) ?? this.memory.currentPlan?.(this.activePlanKey())
    let conditionValidation = await this.validateConditionWaitHealth()
    let conditionWaitHealthy = conditionValidation.healthy === true
    let runtimeHealthy = autorioRuntimeHealthy || persistentControllerHealthy || conditionWaitHealthy
    let runtimeReason = autorioRuntimeHealthy
      ? 'autorio_active_work'
      : persistentControllerHealthy
        ? 'persistent_controller_active'
        : conditionWaitHealthy
          ? 'condition_wait_active'
          : ''

    if (!this.interactionDecisionProvider) {
      if (conditionWaitHealthy) {
        await this.traceEvent('planner.skipped', {
          source: 'condition_wait',
          route: 'wait_runtime',
          authoritative_runtime_reason: 'condition_wait_active',
        })
        return {
          route: 'wait_runtime',
          decision_called: false,
          runtime: persistentRuntime,
          runtime_reason: 'condition_wait_active',
          condition_wait: conditionValidation.wait,
        }
      }
      return { route: 'fallback_planner', decision_called: false }
    }

    const board = planState?.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const skills = this.loadedSkillContext instanceof Map
      ? [...this.loadedSkillContext.values()].slice(-SKILL_CONTEXT_MAX_SKILLS).map(skill => ({
          id: typeof skill?.id === 'string' ? cleanMemoryText(skill.id, 80) : undefined,
          name: typeof skill?.name === 'string' ? cleanMemoryText(skill.name, 160) : undefined,
          revision: Number.isSafeInteger(skill?.revision) ? skill.revision : undefined,
          stage: typeof skill?.stage === 'string' ? cleanMemoryText(skill.stage, 80) : undefined,
          status: typeof skill?.status === 'string' ? cleanMemoryText(skill.status, 80) : undefined,
          summary: typeof skill?.summary === 'string' ? cleanMemoryText(skill.summary, 1000) : undefined,
        }))
      : []
    const state = {
      reason: 'post_step_planner_gate',
      phase: 'post_step',
      boundary: boundary === 'failure' ? 'failure' : 'completion',
      goal: planState
        ? {
            goal_id: sanitizeDurableModelText(planState.goal_id, 100),
            objective: sanitizeDurableModelText(planState.objective, 500),
            status: planState.status,
          }
        : null,
      task_board: board
        ? {
            active_index: activeIndex,
            active_step: activeIndex !== undefined
              ? sanitizeDurableModelText(board?.steps?.[activeIndex]?.description, 300)
              : undefined,
            completed_count: Number.isSafeInteger(board?.completed_count) ? board.completed_count : undefined,
            total_steps: Number.isSafeInteger(board?.total_steps)
              ? board.total_steps
              : (Array.isArray(board?.steps) ? board.steps.length : undefined),
            blocker: cleanMemoryText(board?.blocker, 300),
            pause_reason: cleanMemoryText(board?.pause_reason, 300),
          }
        : null,
      autorio: {
        task_state: typeof autorioStatus?.task_state === 'string' ? cleanMemoryText(autorioStatus.task_state, 64) : undefined,
        queue_length: Number.isSafeInteger(autorioStatus?.queue_length) ? autorioStatus.queue_length : undefined,
        last_completed_batch: sanitizeDurableModelValue(autorioStatus?.last_completed_batch),
        last_cancelled_batch: sanitizeDurableModelValue(autorioStatus?.last_cancelled_batch),
        latest_basic_operation_result: sanitizeDurableModelValue(autorioStatus?.basic_operation?.last_result),
      },
      deterministic_evidence: (Array.isArray(board?.evidence) ? board.evidence : [])
        .slice(-4)
        .map(item => sanitizeDurableModelValue(item)),
      ...(planState?.dependency_context
        ? { dependency_context: sanitizeDurableModelValue(planState.dependency_context) }
        : {}),
      ...(skills.length > 0 ? { skills } : {}),
      persistent_runtime: sanitizeDurableModelValue(persistentRuntime),
      persistent_runtime_healthy: persistentControllerHealthy,
      condition_wait_active: conditionWaitHealthy,
      ...(conditionWaitHealthy ? { condition_wait: sanitizeDurableModelValue(conditionValidation.wait) } : {}),
      ...(failure ? { failure: cleanMemoryText(failure, 1200) } : {}),
    }
    // Gate call: only the judgments that decide whether the Main LLM wakes.
    // Planner-shape questions are asked separately, and only on a wake.
    const questions = {
      ...postStepDecisionQuestions(),
      ...developmentDecisionQuestions(),
    }
    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    this.postStepDecisionAbort?.abort()
    const controller = new AbortController()
    this.postStepDecisionAbort = controller
    const startedAt = Date.now()

    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'post_step_planner_gate',
      mode: 'active',
      boundary: state.boundary,
      question_ids: Object.keys(questions),
      runtime_healthy: runtimeHealthy,
      runtime_reason: runtimeReason,
      canonical_step: activeIndex,
    })

    try {
      const response = await this.interactionDecisionProvider(state, questions, {
        epoch: current.epoch,
        actorId: current.actor_id,
        signal: controller.signal,
      })
      if (generation !== this.generation || !this.active || controller.signal.aborted) {
        throw new AgentLoopError('Model turn was cancelled or superseded')
      }
      await this.assertCurrent()
      const decision = parsePostStepDecision(response)
      const development = parseDecisionFamily(response, 'development', 'maintain')
      const steeringTelemetry = {
        development: development.decision,
        development_confidence: development.confidence,
      }
      const latency_ms = Date.now() - startedAt
      if (decision.route === 'wait_runtime' && conditionWaitHealthy) {
        conditionValidation = await this.validateConditionWaitHealth()
        conditionWaitHealthy = conditionValidation.healthy === true
        runtimeHealthy = autorioRuntimeHealthy || persistentControllerHealthy || conditionWaitHealthy
        runtimeReason = autorioRuntimeHealthy
          ? 'autorio_active_work'
          : persistentControllerHealthy
            ? 'persistent_controller_active'
            : conditionWaitHealthy
              ? 'condition_wait_active'
              : ''
      }
      let appliedRoute = decision.route
      let fallbackReason = ''
      const steeringGate = boundarySteeringGate(steeringTelemetry, {
        runtimeHealthy,
        boundary: state.boundary,
      })

      // Boundary steering is advisory: it may only SUPPRESS a planner wake when
      // authoritative runtime work is already active and Jev says the current
      // direction still holds. It can never author, split or replace a plan.
      if (decision.requested_route === 'continue_runtime' && !runtimeHealthy) {
        appliedRoute = 'fallback_planner'
        fallbackReason = 'continue_runtime_without_authoritative_active_runtime'
      }
      else if (steeringGate.allow_runtime_continuation && decision.route === 'continue_current') {
        appliedRoute = 'wait_runtime'
        fallbackReason = 'steering_maintain_authoritative_runtime'
      }
      else if (decision.route === 'wait_runtime' && !runtimeHealthy) {
        appliedRoute = 'fallback_planner'
        fallbackReason = 'wait_runtime_without_authoritative_active_runtime'
      }
      else if (decision.route === 'wait_runtime' && !steeringGate.allow_runtime_continuation) {
        appliedRoute = 'fallback_planner'
        fallbackReason = steeringGate.reason
      }
      else if (decision.route === 'ask_user' && planState?.status !== PLAN_STATUS.BLOCKED) {
        appliedRoute = 'fallback_planner'
        fallbackReason = 'ask_user_without_authoritative_user_boundary'
      }
      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'post_step_planner_gate',
        mode: 'active',
        boundary: state.boundary,
        provider: decision.provider,
        model: decision.model,
        route: decision.route,
        confidence: decision.confidence,
        confidence_policy: decisionConfidencePolicy(decision.requested_route),
        steering_telemetry: steeringTelemetry,
        boundary_steering_gate: steeringGate,
        steering_budget_shadow_only: true,
        latency_ms,
        input_units: Number.isFinite(decision.usage?.input_tokens) ? Math.max(0, Math.trunc(decision.usage.input_tokens)) : 0,
        output_units: Number.isFinite(decision.usage?.output_tokens) ? Math.max(0, Math.trunc(decision.usage.output_tokens)) : 0,
        cost_usd: Number.isFinite(decision.usage?.cost) && decision.usage.cost >= 0 ? decision.usage.cost : 0,
      })
      await this.decisionTraceEvent('decision.route_applied', {
        decision_id: decisionId,
        contract: 'post_step_planner_gate',
        mode: 'active',
        boundary: state.boundary,
        requested_route: decision.route,
        applied_route: appliedRoute,
        fallback_reason: fallbackReason,
        runtime_healthy: runtimeHealthy,
        runtime_reason: runtimeReason,
        boundary_steering_gate: steeringGate,
      })

      const plannerShape = appliedRoute === 'wait_runtime'
        ? undefined
        : await this.requestPostStepPlannerShape(state, { current, generation, signal: controller.signal })
      const steeringContext = {
        ...steeringTelemetry,
        ...(plannerShape ?? {}),
      }
      await this.traceEvent('post_step.routed', {
        mode: 'active',
        boundary: state.boundary,
        route: decision.route,
        applied_route: appliedRoute,
        fallback_reason: fallbackReason,
        runtime_healthy: runtimeHealthy,
        runtime_reason: runtimeReason,
        decision: {
          provider: decision.provider,
          model: decision.model,
          route: decision.route,
          confidence: decision.confidence,
          steering: steeringContext,
          boundary_steering: steeringContext,
          planner_shape_called: plannerShape !== undefined,
          typed_state_experimental: plannerShape?.typed_state?.available === true,
          typed_state_context_injected: false,
          boundary_steering_gate: steeringGate,
          steering_budget_shadow_only: true,
          usage: decision.usage,
        },
        decision_latency_ms: latency_ms,
      })

      if (appliedRoute === 'wait_runtime') {
        await this.traceEvent('planner.skipped', {
          source: 'decision_provider',
          route: appliedRoute,
          authoritative_runtime_reason: runtimeReason,
        })
      }
      else {
        await this.traceEvent('planner.wake', {
          source: 'decision_provider',
          route: appliedRoute,
          reasoning_policy: appliedRoute === 'continue_current' || appliedRoute === 'targeted_observation'
            ? 'low'
            : appliedRoute === 'reanchor_plan'
              ? 'low'
              : appliedRoute === 'replan'
                ? 'high'
                : 'existing_fallback',
        })
      }
      return {
        route: appliedRoute,
        requested_route: decision.route,
        runtime: persistentRuntime,
        runtime_reason: runtimeReason,
        decision,
        steering: steeringContext,
        steering_gate: steeringGate,
        fallback_reason: fallbackReason,
        decision_called: true,
      }
    }
    catch (error) {
      if (generation !== this.generation || !this.active || controller.signal.aborted) {
        throw new AgentLoopError('Model turn was cancelled or superseded')
      }
      const latency_ms = Date.now() - startedAt
      const message = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'post_step_planner_gate',
        mode: 'active',
        boundary: state.boundary,
        fallback_target: 'main_planner',
        reason: message,
        latency_ms,
      })
      await this.traceEvent('post_step.routed', {
        mode: 'active',
        boundary: state.boundary,
        route: 'fallback_planner',
        applied_route: 'fallback_planner',
        fallback_reason: message,
        runtime_healthy: runtimeHealthy,
        runtime_reason: runtimeReason,
        decision_latency_ms: latency_ms,
      })
      await this.traceEvent('planner.wake', {
        source: 'decision_provider',
        route: 'fallback_planner',
        fallback_reason: message,
        reasoning_policy: 'existing_fallback',
      })
      return { route: 'fallback_planner', runtime: persistentRuntime, runtime_reason: runtimeReason, error: message, decision_called: true }
    }
    finally {
      if (this.postStepDecisionAbort === controller) this.postStepDecisionAbort = null
    }
  }

  async cancelInteractionWorldWork(epoch) {
    if (!epoch || !Number.isSafeInteger(epoch.epoch)) return
    await executeAuthorizedBatch(
      this.rcon,
      epoch.epoch,
      [`remote.call('autorio_operations','cancel_all_tasks')`],
    )
  }

  async rememberRoutedInteraction(key, sender, text, assistant) {
    if (!this.memory?.remember) return
    this.memory.remember(key, ++this.turnSequence, {
      sender,
      user: text,
      assistant,
      operations: [],
    })
    await this.persistState()
  }

  stageCompatibleAmendment(sender, text) {
    if (!this.active || !this.epoch || !Array.isArray(this.baseMessages)) return false
    const content = `[CHAT] ${cleanMemoryText(sender, 128)}: ${cleanMemoryText(text, 4000)}`
    const alreadyPresent = this.baseMessages.some(message => message?.role === 'user' && message?.content === content)
    if (!alreadyPresent) this.baseMessages.push({ role: 'user', content })
    this.pendingInteractionAmendment = { sender: cleanMemoryText(sender, 128), text: cleanMemoryText(text, 4000) }
    return true
  }

  async request(text, options = {}) {
    await this.loadPersistentState()
    const sender = options.sender ?? 'unknown'
    this.lastMemoryKey = `npc:${this.npcId}`
    const memoryKey = this.activePlanKey()
    let planBefore = this.memory.currentPlan?.(memoryKey)
    const taskStatus = await this.readInteractionTaskStatus()
    const healthyRuntime = interactionRuntimeHealthy(taskStatus)

    // Upgrade safety: older builds could persist a provider/control-plane
    // failure as durable WORLD_BLOCKED. That is not Factorio truth. Demote it
    // before interaction routing while preserving the verified Task Board.
    if (planBefore?.status === 'blocked' && providerControlPlaneBlocker(planBefore.blocker)) {
      const recovered = this.memory.applyOutcomeAuthority?.(memoryKey, {
        kind: 'recoverable_provider_failure',
        source: 'state_upgrade',
        reason_code: /budget/i.test(planBefore.blocker) ? 'provider_budget' : 'provider_format',
      }, {
        world: taskStatus,
      })
      if (recovered?.decision?.accepted) {
        planBefore = recovered.state
        await this.persistState()
      }
    }
    let routed
    if (!this.interactionProvider && !this.interactionDecisionProvider) {
      routed = {
        route: { intent: planBefore ? 'continue_current' : 'new_goal', queue_conflict: false, reply: '' },
        epoch: undefined,
        router_bypassed: true,
        classifier_skipped: 'interaction_classifiers_unavailable',
      }
    }
    else {
      try {
        routed = await this.classifyInteraction(text, sender, taskStatus, planBefore)
      }
      catch (error) {
        const fallbackIntent = healthyRuntime ? 'continue_current' : (planBefore ? 'amend_current' : 'new_goal')
        routed = {
          route: { intent: fallbackIntent, queue_conflict: false, reply: '' },
          epoch: healthyRuntime ? await super.captureEpoch() : undefined,
          router_error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        }
      }
    }

    const intent = routed.route.intent
    const jevNewGoalAligned = intent === 'new_goal' && routed.decision_shadow?.intent === 'new_goal'
    await this.traceEvent('interaction.routed', {
      sender,
      text,
      intent,
      queue_conflict: routed.route.queue_conflict,
      runtime_healthy: healthyRuntime,
      task_state: taskStatus.task_state,
      queue_length: taskStatus.queue_length,
      router_error: routed.router_error,
      classifier_skipped: routed.classifier_skipped,
      router_bypassed: routed.router_bypassed === true,
      interaction_router_called: routed.interaction_router_called === true,
      interaction_route_source: routed.route_source,
      decision_shadow: routed.decision_shadow,
      decision_shadow_error: routed.decision_shadow_error,
      decision_shadow_latency_ms: routed.decision_shadow_latency_ms,
      jev_new_goal_aligned: jevNewGoalAligned,
      hybrid_interaction_policy: 'main_llm_language_plus_jev_typed_signal',
      decision_shadow_status: routed.classifier_skipped
        ? 'classifier_skipped'
        : routed.decision_shadow
          ? 'called_success'
          : routed.decision_shadow_error
            ? 'call_failed'
            : this.interactionDecisionProvider
              ? 'configured_not_called'
              : 'not_configured',
    })

    if (!routed.router_bypassed && intent === 'continue_current' && healthyRuntime) {
      const reply = `Current Autorio work is still running (${taskStatus.task_state ?? 'active'}, queue ${taskStatus.queue_length ?? 0}); I will let it continue without restarting the planner.`
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'status_query') {
      const reply = interactionStatusReply(taskStatus, planBefore)
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'chat_only') {
      const reply = routed.route.reply || 'I am here.'
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'cancel_current') {
      if (healthyRuntime) await this.cancelInteractionWorldWork(routed.epoch)
      const state = this.memory.pausePlan?.(memoryKey, 'user_cancel')
      await this.persistState()
      this.clearLoadedSkillContext()
      super.cancel()
      const reply = state
        ? 'Cancelled the remaining Autorio work and paused the current goal.'
        : 'There is no active goal to cancel.'
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    // A BLOCKED plan is frozen until the user decides. The Task Board offers
    // Revise, but a player talking only in chat must be able to decide too:
    // an explicit amendment from a human IS user steering, which roadmap
    // authority allows to supersede the plan. A bare "continue" is not a
    // revision, so it gets the blocker explained instead of a planner turn
    // whose output the frozen plan would silently discard.
    const planningBeforeRequest = this.memory.planningState?.(memoryKey)
    const reducerPlanBeforeRequest = planningBeforeRequest ? getActivePlanningPlan(planningBeforeRequest) : undefined
    const blockedAwaitingUser = reducerPlanBeforeRequest?.status === PLAN_STATUS.BLOCKED
      && reducerPlanBeforeRequest.blocker?.user_choice?.choice !== 'revise'
    // Nothing to continue: the last goal finished (and was retired) or there
    // never was one. Planning from here would admit the chat text itself --
    // literally "continue" -- as a brand-new goal objective.
    if (!routed.router_bypassed && intent === 'continue_current' && !planBefore && !healthyRuntime) {
      const reply = 'There is no current goal to continue; the last one is finished. Tell me what you want me to do next.'
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }
    if (!routed.router_bypassed && blockedAwaitingUser && intent === 'continue_current') {
      const reply = blockedPlanReply(reducerPlanBeforeRequest)
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true, goalStatus: 'blocked' }
    }
    if (!routed.router_bypassed && blockedAwaitingUser && intent === 'amend_current'
      && typeof this.memory.recordBlockedChoice === 'function') {
      this.memory.recordBlockedChoice(memoryKey, 'revise', sender, { now: Date.now() })
      await this.persistState()
      await this.traceEvent('planning.blocked_revision_from_chat', {
        plan_id: reducerPlanBeforeRequest.plan_id,
        blocker: reducerPlanBeforeRequest.blocker?.reason_code,
        approved_by: sender,
      })
    }

    if (!routed.router_bypassed && intent === 'amend_current' && healthyRuntime && routed.route.queue_conflict !== true) {
      if (this.stageCompatibleAmendment(sender, text)) {
        const reply = `The amendment is compatible with the Autorio work already running (queue ${taskStatus.queue_length ?? 0}), so I will not cancel that batch. I will apply the amendment at the next main-planner boundary.`
        await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
        return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true, amendmentDeferred: true }
      }
    }

    if (!routed.router_bypassed && intent === 'amend_current' && healthyRuntime) {
      await this.cancelInteractionWorldWork(routed.epoch)
      super.cancel()
    }
    else if (!routed.router_bypassed && intent === 'new_goal') {
      if (healthyRuntime) await this.cancelInteractionWorldWork(routed.epoch)
      this.clearLoadedSkillContext()
      super.cancel()
      this.memory.clearTaskContext?.(memoryKey)
      await this.persistState()
    }

    const resumeProviderBudgetHandoff = intent === 'continue_current'
      && planBefore?.status === 'active'
      && planBefore?.provider_recovery?.kind === 'budget_handoff'
      && planBefore?.provider_recovery?.phase === 'planner_pending'
      && !healthyRuntime
    const plannerShape = !resumeProviderBudgetHandoff
      && ['new_goal', 'amend_current', 'continue_current'].includes(intent)
      ? await this.requestInteractionPlannerShape(text, sender, taskStatus, planBefore, intent, routed.epoch)
      : undefined

    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.modelCorrectablePreflightRetries = 0
    this.researchPreflightRetries = 0
    this.bootstrapDependencyPreflightRetries = 0
    this.planUpdateReason = intent === 'new_goal'
      ? 'new_goal'
      : intent === 'amend_current'
        ? 'amend_current'
        : 'continue_current'
    this.requestLifecycle = intent
    this.reasoningTriggerSource = resumeProviderBudgetHandoff
      ? providerBudgetTriggerSource(planBefore.provider_recovery.semantic_scope, planBefore.provider_recovery.route)
      : null
    const previousReasoningBudget = this.reasoningBudgetOverride
    const previousObservationBudget = this.observationBudgetOverride
    const previousObservationBudgetRemaining = this.observationBudgetRemaining
    const previousObservationRelevance = this.observationRelevanceOverride
    const previousPlanningHorizon = this.planningHorizonOverride
    if (plannerShape) {
      const requestedReasoningBudget = plannerShape.reasoning_budget
      const requestedObservationBudget = Number.isSafeInteger(plannerShape.observation_budget)
        ? plannerShape.observation_budget
        : 0
      const selectedObservationFamilies = plannerShape.observation_relevance?.source === 'typed_relevance'
        && Array.isArray(plannerShape.observation_relevance.selected_families)
        ? plannerShape.observation_relevance.selected_families
        : []

      if (intent === 'new_goal') {
        // A fresh goal has no request-local world grounding. Keep the existing
        // minimum bootstrap reserve and do not let a cheap under-informed
        // budget judgment starve the first natural-language planner turn.
        this.reasoningBudgetOverride = requestedReasoningBudget === 'deep' || requestedReasoningBudget === 'strategic'
          ? requestedReasoningBudget
          : 'normal'
        this.observationRelevanceOverride = selectedObservationFamilies.length > 0
          ? selectedObservationFamilies
          : null
        this.observationBudgetOverride = Math.max(3, requestedObservationBudget)
      }
      else {
        this.reasoningBudgetOverride = requestedReasoningBudget ?? null
        this.observationRelevanceOverride = plannerShape.observation_relevance?.source === 'typed_relevance'
          ? selectedObservationFamilies
          : null
        this.observationBudgetOverride = requestedObservationBudget
      }
      this.observationBudgetRemaining = this.observationBudgetOverride
      this.planningHorizonOverride = plannerShape.planning_horizon ?? null
    }
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.providerBudgetGeneration = Number.isSafeInteger(planBefore?.provider_recovery?.budget_generation)
      ? planBefore.provider_recovery.budget_generation
      : 1
    this.providerBudgetGenerationOutputUnits = 0
    this.providerBudgetHandoffCount = Number.isSafeInteger(planBefore?.provider_recovery?.handoff_count)
      ? planBefore.provider_recovery.handoff_count
      : 0
    const resumeActionOmission = intent === 'continue_current'
      && planBefore?.status === 'active'
      && planBefore?.admission_status === 'action_omission_repair'
      && !healthyRuntime
    this.actionOmissionRepairActive = resumeActionOmission
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    if (resumeProviderBudgetHandoff) {
      const budgetCapsule = providerBudgetHandoffCapsule(
        planBefore,
        taskStatus,
        planBefore.provider_recovery.reason || 'provider_budget_handoff_resume',
        planBefore.provider_recovery.semantic_scope,
      )
      const repairCapsule = resumeActionOmission ? `\n${actionOmissionRecoveryCapsule(planBefore, taskStatus)}` : ''
      this.memory.setNextContextOverride?.(memoryKey, `${budgetCapsule}${repairCapsule}`)
    }
    else if (resumeActionOmission) {
      this.memory.setNextContextOverride?.(memoryKey, actionOmissionRecoveryCapsule(planBefore, taskStatus))
    }
    if (this.traceRequest) await this.traceEvent('request.superseded', { usage: this.traceRequest.usage })
    this.traceRequest = {
      id: `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
      usage: emptyUsageSummary(),
    }
    await this.traceEvent('request.received', {
      sender,
      text,
      interaction_intent: intent,
      action_omission_recovery: resumeActionOmission,
      provider_budget_handoff_resume: resumeProviderBudgetHandoff,
    })

    if (intent === 'new_goal'
      && this.steeringDecisionProvider
      && typeof this.memory.admitPlanningGoal === 'function'
      && typeof this.memory.evaluateSteeringAtBoundary === 'function') {
      const admitted = this.memory.admitPlanningGoal(memoryKey, {
        owner: sender,
        objective: text,
        now: Date.now(),
      })
      if (admitted?.goal) {
        const recommendation = await this.requestBoundarySteeringRecommendation(memoryKey, {
          boundary: STEERING_BOUNDARY.GOAL_ADMISSION,
          world: taskStatus,
        })
        if (recommendation && typeof this.memory.recordSteeringAdvice === 'function') {
          this.memory.recordSteeringAdvice(memoryKey, recommendation)
        }
        const beforeSequence = admitted.steering?.sequence ?? 0
        const steered = this.memory.evaluateSteeringAtBoundary(memoryKey, {
          boundary: STEERING_BOUNDARY.GOAL_ADMISSION,
          now: Date.now(),
        }) ?? admitted
        if ((steered.steering?.sequence ?? 0) > beforeSequence
          && typeof this.memory.recordSteeringAdvice === 'function') {
          this.memory.recordSteeringAdvice(memoryKey, null)
        }
        await this.persistState()
        await this.traceEvent('planning.goal_admission_steered', {
          goal_id: steered.goal?.goal_id,
          steering_mode: steered.steering?.current_mode,
          recommended_mode: steered.steering?.recommendation?.recommended_mode,
        })
      }
    }

    try {
      const result = await super.request(text, options)
      if (this.requestInfo?.memoryKey) this.lastMemoryKey = this.requestInfo.memoryKey
      if (resumeProviderBudgetHandoff) {
        this.memory.setProviderRecovery?.(memoryKey, undefined)
        await this.persistState()
        await this.traceEvent('budget.handoff_resumed', {
          generation: this.providerBudgetGeneration,
          handoff_count: this.providerBudgetHandoffCount,
          semantic_scope: planBefore.provider_recovery.semantic_scope,
        })
      }
      return { ...result, interactionIntent: intent, routedOnly: false }
    }
    catch (error) {
      if (this.traceRequest) {
        const message = error instanceof Error ? error.message : String(error)
        await this.traceEvent('request.failed', {
          stage: 'bind',
          message,
          usage: this.traceRequest.usage,
          failure_snapshot: this.failureSnapshot('bind', message),
        })
        this.traceRequest = null
      }
      throw error
    }
    finally {
      this.reasoningBudgetOverride = previousReasoningBudget
      this.observationBudgetOverride = previousObservationBudget
      this.observationBudgetRemaining = previousObservationBudgetRemaining
      this.observationRelevanceOverride = previousObservationRelevance
      this.planningHorizonOverride = previousPlanningHorizon
    }
  }

  async pausePersistentPlan(reason = 'user_stop') {
    await this.loadPersistentState()
    const key = this.activePlanKey()
    const state = this.memory.pausePlan?.(key, reason)
    await this.persistState()
    super.cancel()
    return state
  }

  async finalizeCompletedTaskContext() {
    await this.loadPersistentState()
    const key = this.requestInfo?.memoryKey ?? this.lastMemoryKey ?? `npc:${this.npcId}`
    this.memory.clearTaskContext?.(key)
    this.clearLoadedSkillContext()
    await this.persistState()

    // Completion is a hard planner boundary. Do not carry the completed task's
    // provider working set, continuation counters, recovery state, or dialogue
    // context into the next goal.
    super.cancel()
    this.traceRequest = null
    this.planUpdateReason = 'request'
    this.requestLifecycle = 'new_goal'
    this.pendingInteractionAmendment = null
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.clearActionOmissionRecovery()
    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.modelCorrectablePreflightRetries = 0
    this.researchPreflightRetries = 0
    this.bootstrapDependencyPreflightRetries = 0
    return true
  }

  decisionTraceEvent(event, data = {}) {
    this.recordJevHealthEvent(event, data)
    if (!this.decisionTrace) return Promise.resolve()
    const { decision_id, ...details } = data ?? {}
    return this.decisionTrace.emit({
      schema: 1,
      ts: new Date().toISOString(),
      seq: ++this.decisionTraceSequence,
      event,
      decision_id,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      data: details,
    })
  }

  // The first plan of a goal must say what the goal IS in game-checkable
  // terms (and bring a Roadmap Shelf when it is long-horizon). One corrective
  // retry is allowed; a second failure stops and asks the player.
  enforceGoalDefinition(plan) {
    if (this.goalDefinitionPolicy !== 'required') return
    if (!Array.isArray(plan.plan) || plan.plan.length === 0) return
    const key = this.activePlanKey()
    const planning = this.memory.planningState?.(key)
    const legacy = this.memory.currentPlan?.(key)
    const continuing = planning?.goal?.status === GOAL_STATUS.ACTIVE
      && legacy?.goal_id === planning.goal.goal_id
    if (continuing && planning.goal.definition) return
    if (!plan.goalDefinition) {
      throw this.goalDefinitionError(
        'goal_definition_required',
        'This is the first plan of this goal: add submitPlan.goal {scope, summary, doneWhen} stating how you understood the goal and which game-checkable conditions prove it is complete (for example {"kind":"rockets_launched","minimum":1} or {"kind":"research_completed","technology":"automation"}).',
      )
    }
    const hasShelf = continuing && (planning.roadmap?.nodes?.length ?? 0) > 0
    if (plan.goalDefinition.scope === GOAL_SCOPE.LONG_HORIZON && !(plan.roadmap?.length > 0) && !hasShelf) {
      throw this.goalDefinitionError(
        'long_horizon_goal_requires_roadmap',
        'goal.scope is long_horizon, so this first plan must also send roadmap: the coarse Roadmap Shelf nodes (what must eventually be true, in dependency order) that later plan slices will refine.',
      )
    }
    this.goalDefinitionRetries = 0
    this.challengeGoalDefinition(plan.goalDefinition)
  }

  // Harness rule for Jev's blind goal reading: agreement or no opinion
  // accepts; a confident disagreement costs the planner one corrective retry
  // with the reason; after that retry the planner's answer is final.
  challengeGoalDefinition(definition) {
    const reading = this.goalReading
    if (!reading) return
    const comparison = compareGoalReading(reading, definition, { facts: reading.facts })
    const challenge = !reading.challenged && comparison.hints.length > 0
    this.pendingGoalReadingTrace = {
      decision_id: reading.decision_id,
      verdict: comparison.verdict,
      challenged: challenge,
      after_challenge: reading.challenged,
      jev_scope: reading.scope,
      jev_scope_confidence: reading.scope_confidence,
      jev_family: reading.family,
      jev_family_confidence: reading.family_confidence,
      planner_scope: definition.scope,
      planner_condition_kinds: definition.done_when.map(condition => condition.kind),
    }
    if (!challenge) return
    reading.challenged = true
    const error = new AgentLoopError(goalReadingChallenge(comparison))
    error.failureClass = 'plan_category'
    error.code = 'goal_reading_disagreement'
    error.details = { goal_reading: this.pendingGoalReadingTrace }
    throw error
  }

  goalDefinitionError(code, reason) {
    this.goalDefinitionRetries += 1
    const error = new AgentLoopError(reason)
    error.failureClass = 'plan_category'
    error.code = code
    if (this.goalDefinitionRetries > 1) {
      this.goalDefinitionRetries = 0
      this.goalDefinitionBlock = `I could not form a clear, game-checkable definition of this goal (${cleanMemoryText(reason, 300)}). Please restate the goal and what "done" means — for example "launch 1 rocket", "research automation", or "produce 1000 iron plates".`
      error.details = { deterministic_no_retry: true }
    }
    return error
  }

  async blockedWithoutMutation(reason, failureClass) {
    const goalBlock = this.goalDefinitionBlock
    this.goalDefinitionBlock = null
    if (goalBlock) {
      const result = await super.blockedWithoutMutation(goalBlock, 'goal_definition_needed')
      return { ...result, chatMessage: goalBlock }
    }
    return super.blockedWithoutMutation(reason, failureClass)
  }

  // The harness, not the plan, decides whether the user's goal is met: every
  // done_when condition is read from the game. Records GOAL_SATISFIED on
  // positive evidence only.
  // True between plan slices of a long goal: the last committed slice is
  // verified complete but the user goal is still active and has a way to
  // continue (a game-checked definition or a Roadmap Shelf). The legacy plan
  // reads "completed" here, so without this check a restart or a provider
  // failure at the slice boundary stranded the goal silently.
  goalAwaitingNextSlice(key = this.activePlanKey()) {
    const legacy = this.memory.currentPlan?.(key)
    if (legacy?.status !== 'completed') return false
    const planning = this.memory.planningState?.(key)
    if (planning?.goal?.status !== GOAL_STATUS.ACTIVE) return false
    if (legacy.goal_id && planning.goal.goal_id && legacy.goal_id !== planning.goal.goal_id) return false
    const hasShelf = (planning.roadmap?.nodes?.length ?? 0) > 0
    if (!planning.goal.definition && !hasShelf) return false
    const plan = getActivePlanningPlan(planning)
    return !plan || plan.status === PLAN_STATUS.COMPLETED
  }

  // Reads the goal's conditions from the game and records any baseline a
  // goal_start counter still lacks. Called when the goal is defined, so the
  // baseline is where the counter stood then, and again at every evaluation in
  // case that first read failed.
  async readGoalDefinition(key, definition) {
    const evaluation = await evaluateGoalDefinition(definition, command => this.rcon.command(command))
    if (Object.keys(evaluation.baselines ?? {}).length > 0 && typeof this.memory.recordGoalBaselines === 'function') {
      this.memory.recordGoalBaselines(key, evaluation.baselines)
      await this.traceEvent('goal.baselines_recorded', { baselines: evaluation.baselines })
    }
    return evaluation
  }

  async evaluateGoalCompletion() {
    const key = this.activePlanKey()
    const definition = this.memory.goalDefinition?.(key)
    if (!definition) return undefined
    const evaluation = await this.readGoalDefinition(key, definition)
    await this.traceEvent('goal.evaluated', {
      satisfied: evaluation.satisfied,
      progress: formatGoalProgress(evaluation),
      results: evaluation.results,
    })
    if (evaluation.satisfied && typeof this.memory.recordGoalSatisfaction === 'function') {
      this.memory.recordGoalSatisfaction(key, {
        source: 'runtime',
        evidenceRefs: evaluation.results.map(result => `goal_condition/${result.id}/${result.current ?? 'true'}`),
        rationale: 'goal_definition_conditions_satisfied',
      })
      await this.persistState()
    }
    return evaluation
  }

  // Counts every Jev boundary's outcome independently of the decision trace
  // file, so a run whose Jev calls silently fall back is visible in the log,
  // the live Debug UI, and the request's terminal behavior-trace event.
  recordJevHealthEvent(event, data = {}) {
    if (!['decision.request', 'decision.response', 'decision.fallback'].includes(event)) return
    this.jevHealth ??= emptyJevHealth()
    const fallback = recordJevHealth(this.jevHealth, event, data)
    if (fallback) {
      this.log(`[jev] fallback contract=${fallback.contract} kind=${fallback.kind} target=${fallback.target || '-'} reason=${fallback.reason}`)
    }
    if (this.onActivity) {
      const summary = summarizeJevHealth(this.jevHealth, { configured: this.jevConfigured() })
      try {
        this.onActivity('jev.health', {
          outcome: event.slice('decision.'.length),
          contract: data?.contract,
          measurement: summary.measurement,
          requests: summary.requests,
          fallbacks: summary.fallbacks,
          fallback_rate_percent: summary.fallback_rate_percent,
          last_fallback: summary.last_fallback,
        })
      }
      catch (error) { this.log(`[trace] activity listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  jevConfigured() {
    return Boolean(this.interactionDecisionProvider || this.steeringDecisionProvider || this.operationProjectionDecisionProvider)
  }

  // Attach the request's Jev health to its terminal event, then start a fresh
  // window. The interaction-route call runs before request.received, so the
  // window resets at request end rather than at request start.
  takeJevHealthSummary() {
    this.jevHealth ??= emptyJevHealth()
    const summary = summarizeJevHealth(this.jevHealth, { configured: this.jevConfigured() })
    this.jevHealth = emptyJevHealth()
    if (summary.measurement === 'degraded') {
      this.log(`[jev] request measurement degraded: ${summary.fallbacks}/${summary.requests} decisions fell back (${Object.entries(summary.by_kind).map(([kind, count]) => `${kind}=${count}`).join(', ')})`)
    }
    return summary
  }

  traceEvent(event, data = {}) {
    if (event === 'request.completed' || event === 'request.failed') {
      data = { ...(data ?? {}), jev_health: this.takeJevHealthSummary() }
    }
    if (this.onActivity) {
      try { this.onActivity(event, data) }
      catch (error) { this.log(`[trace] activity listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (!this.behaviorTrace) return Promise.resolve()
    const request = this.traceRequest
    // interaction.routed is a pre-request side-channel lifecycle signal. Keep it
    // available to the live UI via onActivity above, but do not write it into
    // the main planner behavior trace before a canonical request_id exists.
    if (event === 'interaction.routed' && !request) return Promise.resolve()
    if (['request.received', 'provider.error', 'plan.accepted', 'operations.ack', 'request.completed', 'request.failed'].includes(event)) {
      this.log(`[trace ${request?.id ?? '-'}] ${event}`)
    }
    return this.behaviorTrace.emit({
      schema: 1,
      ts: new Date().toISOString(),
      seq: request ? ++request.seq : 0,
      event,
      request_id: request?.id,
      turn: request ? this.continuations + 1 : undefined,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      data,
    })
  }

  async runGuarded() {
    const generation = this.generation
    try {
      return await this.runTurn()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const planState = this.memory.currentPlan?.(this.activePlanKey())
      const terminalBudgetFailure = planState?.status === 'active' && terminalProviderBudgetFailure(error)
      if (terminalBudgetFailure && generation === this.generation && this.active) {
        // callProvider can surface the terminal exactly-once budget condition
        // before runTurn reaches its ordinary parse/recovery boundary. Reuse
        // the existing Outcome Authority path instead of leaking the provider
        // exception or spending another provider call.
        return this.recoverPlan(generation, error, 0)
      }
      const recoverablePlannerFailure = planState?.status === 'active'
        && /provider_action_omission_repair_failed|provider_output_budget_exhausted|provider_jev_recovery_route_failed|Provider strict recovery could not safely resolve remaining canonical work/i.test(message)
      if (!recoverablePlannerFailure && generation === this.generation) this.reset()
      if (this.traceRequest) {
        await this.traceEvent('request.failed', {
          stage: 'runtime',
          message,
          recoverable: recoverablePlannerFailure,
          usage: this.traceRequest.usage,
          failure_snapshot: this.failureSnapshot('runtime', message),
        })
        this.traceRequest = null
      }
      throw error
    }
  }

  async captureEpoch() {
    const status = await super.captureEpoch()
    await this.traceEvent('actor.bound', actorFields(status))
    return status
  }

  async taskStatusReceipt() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      this.recordPlacementReceipt(raw)
      const currentPlan = this.memory.currentPlan?.(this.activePlanKey())
      const evidence = receiptEvidence(raw, this.planUpdateReason === 'failure' ? 'failed' : 'completed', {
        goal_id: currentPlan?.goal_id,
        step_id: currentPlan?.task_board?.active_step_id,
        actor_id: this.epoch?.actor_id,
        actor_epoch: this.epoch?.epoch,
      })
      const taskBoard = this.memory.recordBoardEvidence?.(this.activePlanKey(), evidence)
      if (taskBoard) await this.persistState()
      const view = taskStatusDecisionView(raw)
      const providerStatus = taskStatusDelta(this.lastTaskStatusView, view)
      this.lastTaskStatusView = view
      // The UI refresh must observe the board after receipt reconciliation. Emitting
      // factorio.status before recordBoardEvidence let the console snapshot the old
      // active_index and leave Plan Tracker one step behind until a later event.
      await this.traceEvent('factorio.status', {
        observation_mode: providerStatus.observation_mode,
        raw_chars: raw.length,
        task_status: providerStatus,
      })
      return { raw, view, providerStatus, taskBoard: visibleTaskBoard(taskBoard) }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const view = { status_error: message }
      const providerStatus = taskStatusDelta(this.lastTaskStatusView, view)
      this.lastTaskStatusView = view
      await this.traceEvent('factorio.status_error', { message })
      return { raw: JSON.stringify(view), view, providerStatus }
    }
  }

  async persistentRuntimeStatus() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getFollowStatus', {}))).slice(0, 16000)
      const follow = JSON.parse(raw)
      if (!follow || follow.active !== true) return undefined
      const status = safePersistentRuntime({ kind: 'follow', ...follow })
      await this.traceEvent('persistent_runtime.status', { runtime: status })
      return status
    }
    catch (error) {
      await this.traceEvent('persistent_runtime.status_error', { message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  async continueFromModMessage(modMessage, traceEventName) {
    if (!this.active || !this.epoch) return null
    const currentPlan = this.memory.currentPlan?.(this.activePlanKey())
    const continuationLimit = currentPlan?.status === 'active' ? 64 : this.maxContinuations
    if (this.continuations >= continuationLimit) {
      await this.pausePersistentPlan(`continuation_limit_${continuationLimit}`)
      throw new AgentLoopError(`Continuation limit reached (${continuationLimit}); durable plan paused`)
    }
    await this.assertCurrent()
    this.continuations++
    this.prepareContinuationContext()
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.resetObservationDecisionState()
    this.finiteNoOperationPressureUsed = false
    this.toolValidationRetries = 0
    this.planCategoryRetries = 0
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    this.staleExactPreflightRetries = 0
    this.modelCorrectablePreflightRetries = 0
    this.researchPreflightRetries = 0
    this.messages.push({ role: 'user', content: cleanMemoryText(modMessage, 18000) })
    await this.traceEvent(traceEventName)
    return this.runGuarded()
  }

  // What a step closing on its verified contract means for the plan and goal:
  // the next Shelf slice, a verified finite goal, or an active goal to
  // reconcile. Returns undefined when the loop should carry on as normal.
  // Callers already inside a planner turn pass allowContinuation: false so
  // this never starts a nested planner run.
  async settleCompletedStepState(completionState, { pendingAmendment, allowContinuation = true } = {}) {
    let planningAfterCompletion = this.memory.planningState?.(this.activePlanKey())
    const reducerPlanAfterCompletion = planningAfterCompletion
      ? getActivePlanningPlan(planningAfterCompletion)
      : undefined
    // A defined goal is complete only when the game says so. Check it at every
    // finished plan slice; a finished slice is never proof on its own.
    const goalDefinition = planningAfterCompletion?.goal?.definition
    let goalEvaluation
    if (goalDefinition
      && !pendingAmendment
      && completionState?.status === 'completed'
      && planningAfterCompletion?.goal?.status === GOAL_STATUS.ACTIVE
      && reducerPlanAfterCompletion?.status === PLAN_STATUS.COMPLETED) {
      goalEvaluation = await this.evaluateGoalCompletion()
      planningAfterCompletion = this.memory.planningState?.(this.activePlanKey())
      const unverifiable = goalEvaluation?.results.filter(result => /^(?:unknown_|invalid_)/.test(result.error ?? '')) ?? []
      if (unverifiable.length > 0) return this.pauseForUnverifiableGoal(unverifiable)
    }
    const goalUnmet = goalEvaluation !== undefined && !goalEvaluation.satisfied
    const boundedSliceCompleted = !pendingAmendment
      && completionState?.status === 'completed'
      && planningAfterCompletion?.goal?.status === 'active'
      && ((Array.isArray(planningAfterCompletion?.roadmap?.nodes) && planningAfterCompletion.roadmap.nodes.length > 0) || goalUnmet)
      && reducerPlanAfterCompletion?.status === PLAN_STATUS.COMPLETED

    if (boundedSliceCompleted && allowContinuation) {
      const completedBoard = visibleTaskBoard(completionState.task_board)
      await this.traceEvent('outcome.validated', {
        kind: 'plan_slice_completed',
        source: 'step_completion_gate',
        reason_code: 'verified_final_step_of_bounded_slice',
        plan_id: reducerPlanAfterCompletion.plan_id,
        task_board: completedBoard,
      })
      await this.traceEvent('planner.wake', {
        source: 'planning_boundary',
        route: 'next_shelf_slice',
        steering_mode: planningAfterCompletion.steering?.current_mode,
      })
      this.reasoningTriggerSource = 'plan_slice_completed'
      try {
        const unmet = goalEvaluation
          ? ` The game reports ${formatGoalProgress(goalEvaluation)}; still unmet: ${goalEvaluation.results.filter(result => !result.satisfied).map(describeUnmetGoalResult).join(', ')}.`
          : ''
        const next = (planningAfterCompletion?.roadmap?.nodes?.length ?? 0) > 0
          ? 'Refine the next useful Roadmap Shelf node using [PLANNING_STATE]'
          : 'Author the next plan slice that moves the world toward the unmet goal conditions'
        return await this.continueFromModMessage(
          `[MOD] The current immutable plan slice is verified complete. The user goal remains active.${unmet} ${next}; do not treat plan completion as goal completion. Completed plan_id=${reducerPlanAfterCompletion.plan_id}.`,
          'planning.slice_completion_continuation',
        )
      }
      finally {
        this.reasoningTriggerSource = null
      }
    }

    // GOAL_SATISFIED completes the goal; there is no separate SATISFIED status.
    const reducerGoalSatisfied = planningAfterCompletion?.goal?.status === GOAL_STATUS.COMPLETED
    const hasLongHorizonRoadmap = Array.isArray(planningAfterCompletion?.roadmap?.nodes)
      && planningAfterCompletion.roadmap.nodes.length > 0
    // A defined goal completes only through its game-checked conditions.
    const legacyCompatibleCompletion = !goalDefinition
      && (!planningAfterCompletion?.goal || !hasLongHorizonRoadmap)
    if (!pendingAmendment
      && completionState?.status === 'completed'
      && (reducerGoalSatisfied || legacyCompatibleCompletion)) {
      // A finite goal has no Shelf, so no frontier exists that could stand in
      // for satisfaction; the runtime's own deterministic verification of the
      // final step is the evidence. Record it, or the reducer keeps the goal
      // active while the user is told it is done, and nothing else ever
      // decides it.
      if (!reducerGoalSatisfied
        && !hasLongHorizonRoadmap
        && planningAfterCompletion?.goal?.status === GOAL_STATUS.ACTIVE
        && typeof this.memory.recordGoalSatisfaction === 'function') {
        const evidenceRefs = [...(completionState.task_board?.evidence ?? [])]
          .reverse()
          .filter(item => item?.kind === 'deterministic_verification' && typeof item?.ref === 'string' && item.ref)
          .slice(0, 2)
          .map(item => item.ref)
        if (evidenceRefs.length > 0) {
          this.memory.recordGoalSatisfaction(this.activePlanKey(), {
            source: 'runtime',
            evidenceRefs,
            rationale: 'finite_goal_final_step_verified',
          })
          await this.persistState()
        }
      }
      this.active = false
      const completedBoard = visibleTaskBoard(completionState.task_board)
      await this.traceEvent('outcome.validated', {
        kind: 'verified_complete',
        source: 'step_completion_gate',
        reason_code: 'verified_final_step',
        task_board: completedBoard,
      })
      await this.traceEvent('planner.skipped', {
        source: 'outcome_authority',
        route: 'deterministic_close',
      })
      const completionMessage = goalEvaluation?.satisfied
        ? `The requested goal is verified complete: the game reports ${formatGoalProgress(goalEvaluation)}.`
        : 'The requested goal is verified complete.'
      await this.traceEvent('request.completed', {
        chat_message: completionMessage,
        outcome: 'verified_complete',
        task_board: completedBoard,
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
      return {
        chatMessage: completionMessage,
        plan: [],
        currentStep: 0,
        operations: [],
        epoch: this.epoch?.epoch,
        actorId: this.epoch?.actor_id,
        goalId: completionState.goal_id,
        goalStatus: 'completed',
        taskBoard: completedBoard,
      }
    }

    if (!pendingAmendment
      && completionState?.status === 'completed'
      && (hasLongHorizonRoadmap || goalDefinition)
      && allowContinuation
      && planningAfterCompletion?.goal?.status === GOAL_STATUS.ACTIVE) {
      await this.traceEvent('planner.wake', {
        source: 'planning_boundary',
        route: 'active_goal_after_plan_completion',
        plan_status: reducerPlanAfterCompletion?.status,
      })
      this.reasoningTriggerSource = 'plan_slice_completed'
      try {
        return await this.continueFromModMessage(
          '[MOD] The current bounded work is complete, but the reducer-owned user goal is still active. Reconcile [PLANNING_STATE] and choose the next bounded action or explicitly surface why the goal cannot yet advance. Do not infer GOAL_SATISFIED from Task Board completion.',
          'planning.active_goal_continuation',
        )
      }
      finally {
        this.reasoningTriggerSource = null
      }
    }
    return undefined
  }

  // A done_when condition names something the game does not know (a typo'd
  // technology or item). Rolling more slices can never satisfy it, so stop and
  // ask the player instead of planning forever.
  async pauseForUnverifiableGoal(unverifiable) {
    const detail = unverifiable.map(result => `${result.id}: ${result.error}`).join(', ')
    const chatMessage = `I cannot verify this goal's completion in game (${detail}). Please restate what "done" means so I can check it.`
    const state = await this.pausePersistentPlan(`goal_definition_unverifiable: ${cleanMemoryText(detail, 200)}`)
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'goal_definition_unverifiable',
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    return {
      chatMessage,
      plan: [],
      currentStep: 0,
      operations: [],
      epoch: this.epoch?.epoch,
      actorId: this.epoch?.actor_id,
      goalId: state?.goal_id,
      goalStatus: 'paused',
    }
  }

  async completed() {
    await this.loadPersistentState()
    if (!this.active) return null
    const pendingAmendment = this.pendingInteractionAmendment
    this.planUpdateReason = pendingAmendment ? 'amend_current' : 'completion'
    if (pendingAmendment) this.requestLifecycle = 'amend_current'
    await this.traceEvent('factorio.completed_signal', pendingAmendment ? { pending_amendment: true } : {})
    const receipt = await this.taskStatusReceipt()
    const receiptKey = runtimeReceiptKey('completion', receipt.view, '', this.epoch?.epoch)
    if (this.lastHandledRuntimeReceipt.completion === receiptKey) {
      if (this.traceRequest?.usage) this.traceRequest.usage.coalesced_runtime_events++
      await this.traceEvent('factorio.event_coalesced', {
        kind: 'completion',
        receipt_key: receiptKey,
        observation_mode: receipt.providerStatus.observation_mode,
      })
      return null
    }
    this.lastHandledRuntimeReceipt.completion = receiptKey

    const stepCompletion = pendingAmendment
      ? { verified: false, reason: 'pending_amendment' }
      : await this.routeStepCompletionDecision(receipt)
    const completionState = stepCompletion?.state
    const settled = await this.settleCompletedStepState(completionState, { pendingAmendment })
    if (settled) return settled

    const routed = pendingAmendment
      ? { route: 'fallback_planner', decision_called: false }
      : await this.routePostStepDecision(receipt)
    if (routed.route === 'wait_runtime') return null

    this.reasoningTriggerSource = routed.route === 'continue_current'
      ? 'post_step_continue'
      : routed.route === 'targeted_observation'
        ? 'post_step_observe'
        : routed.route === 'reanchor_plan'
          ? 'post_step_reanchor'
          : routed.route === 'replan'
            ? 'post_step_replan'
            : null
    if (routed.route === 'reanchor_plan') this.planUpdateReason = 'reanchor_plan'
    const previousReasoningBudget = this.reasoningBudgetOverride
    const previousObservationBudget = this.observationBudgetOverride
    const previousObservationBudgetRemaining = this.observationBudgetRemaining
    const previousObservationRelevance = this.observationRelevanceOverride
    const previousPlanningHorizon = this.planningHorizonOverride
    this.reasoningBudgetOverride = routed.steering?.reasoning_budget ?? null
    this.observationBudgetOverride = Number.isSafeInteger(routed.steering?.observation_budget) ? routed.steering.observation_budget : null
    this.observationBudgetRemaining = this.observationBudgetOverride
    this.observationRelevanceOverride = routed.steering?.observation_relevance?.source === 'typed_relevance'
      && Array.isArray(routed.steering.observation_relevance.selected_families)
      ? routed.steering.observation_relevance.selected_families
      : null
    this.planningHorizonOverride = routed.steering?.planning_horizon ?? null
    try {
      const result = await this.continueFromModMessage(
        `[MOD] Autorio operation batch completed. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}`,
        'factorio.completion_continuation',
      )
      if (pendingAmendment) this.pendingInteractionAmendment = null
      return result
    }
    finally {
      this.reasoningTriggerSource = null
      this.reasoningBudgetOverride = previousReasoningBudget
      this.observationBudgetOverride = previousObservationBudget
      this.observationBudgetRemaining = previousObservationBudgetRemaining
      this.observationRelevanceOverride = previousObservationRelevance
      this.planningHorizonOverride = previousPlanningHorizon
    }
  }

  async failed(errorText) {
    await this.loadPersistentState()
    if (!this.active) return null
    this.planUpdateReason = 'failure'
    this.reasoningTriggerSource = null
    const cleanError = cleanMemoryText(errorText, 4000)
    const receipt = await this.taskStatusReceipt()
    const receiptKey = runtimeReceiptKey('failure', receipt.view, cleanError, this.epoch?.epoch)
    if (this.lastHandledRuntimeReceipt.failure === receiptKey) {
      if (this.traceRequest?.usage) this.traceRequest.usage.coalesced_runtime_events++
      await this.traceEvent('factorio.event_coalesced', {
        kind: 'failure',
        receipt_key: receiptKey,
        observation_mode: receipt.providerStatus.observation_mode,
      })
      return null
    }
    this.lastHandledRuntimeReceipt.failure = receiptKey

    const routed = await this.routePostStepDecision(receipt, {
      boundary: 'failure',
      failure: cleanError,
    })
    if (routed.route === 'wait_runtime') return null

    this.reasoningTriggerSource = routed.route === 'continue_current'
      ? 'post_step_continue'
      : routed.route === 'targeted_observation'
        ? 'post_step_observe'
        : routed.route === 'reanchor_plan'
          ? 'post_step_reanchor'
          : routed.route === 'replan'
            ? 'post_step_replan'
            : null
    const previousReasoningBudget = this.reasoningBudgetOverride
    const previousObservationBudget = this.observationBudgetOverride
    const previousObservationBudgetRemaining = this.observationBudgetRemaining
    const previousObservationRelevance = this.observationRelevanceOverride
    const previousPlanningHorizon = this.planningHorizonOverride
    this.reasoningBudgetOverride = routed.steering?.reasoning_budget ?? null
    this.observationBudgetOverride = Number.isSafeInteger(routed.steering?.observation_budget) ? routed.steering.observation_budget : null
    this.observationBudgetRemaining = this.observationBudgetOverride
    this.observationRelevanceOverride = routed.steering?.observation_relevance?.source === 'typed_relevance'
      && Array.isArray(routed.steering.observation_relevance.selected_families)
      ? routed.steering.observation_relevance.selected_families
      : null
    this.planningHorizonOverride = routed.steering?.planning_horizon ?? null
    try {
      return await this.continueFromModMessage(
        `[MOD] Autorio operation error: ${cleanError}. Dependent queued operations may have been cancelled. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}`,
        'factorio.error_continuation',
      )
    }
    finally {
      this.reasoningTriggerSource = null
      this.reasoningBudgetOverride = previousReasoningBudget
      this.observationBudgetOverride = previousObservationBudget
      this.observationBudgetRemaining = previousObservationBudgetRemaining
      this.observationRelevanceOverride = previousObservationRelevance
      this.planningHorizonOverride = previousPlanningHorizon
    }
  }

  cancel(reason = 'cancelled') {
    this.interactionAbort?.abort()
    this.interactionAbort = null
    this.postStepDecisionAbort?.abort()
    this.postStepDecisionAbort = null
    this.recoveryDecisionAbort?.abort()
    this.recoveryDecisionAbort = null
    this.operationProjectionAbort?.abort()
    this.operationProjectionAbort = null
    if (/terminate|new_task|cancel_current|user_cancel/i.test(String(reason))) this.clearLoadedSkillContext()
    this.reasoningTriggerSource = null
    void this.traceEvent('request.cancelled', { reason, usage: this.traceRequest?.usage })
    this.traceRequest = null
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    this.lastRecoveryDecisionKey = ''
    this.lastRecoveryDecision = null
    return super.cancel()
  }

  async callProvider(current, generation, {
    round,
    allowTools = true,
    recoveryAttempt = 0,
    recoveryKind,
    providerMessagesOverride,
  }) {
    const omissionRepair = this.actionOmissionRepairActive && recoveryKind !== 'output_budget_exhaustion'
    const effectiveAllowTools = omissionRepair && this.actionOmissionForceNoTools ? false : allowTools
    const effectiveRecoveryAttempt = omissionRepair ? Math.max(1, recoveryAttempt) : recoveryAttempt
    const traceRecoveryKind = omissionRepair ? 'action_omission' : recoveryKind
    const budgetStartedAt = Date.now()
    let budget
    try {
      budget = await this.reserve({ epoch: current.epoch, actorId: current.actor_id, recoveryKind, recoveryAttempt: effectiveRecoveryAttempt })
      await this.traceEvent('budget.reserved', { latency_ms: Date.now() - budgetStartedAt, usage: budget, recovery_attempt: effectiveRecoveryAttempt, recovery_kind: traceRecoveryKind })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.traceEvent('budget.rejected', { latency_ms: Date.now() - budgetStartedAt, message, recovery_attempt: effectiveRecoveryAttempt, recovery_kind: traceRecoveryKind })
      if (recoveryKind === 'output_budget_exhaustion') {
        const wrapped = new AgentLoopError(`provider_output_budget_recovery_budget_unavailable: ${message}`)
        wrapped.failureClass = 'provider_budget'
        wrapped.code = 'provider_output_budget_recovery_budget_unavailable'
        throw wrapped
      }
      throw error
    }
    if (generation !== this.generation || !this.active || !this.epoch) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()

    const controller = new AbortController()
    this.providerAbort = controller
    let providerMessages = providerMessagesOverride ?? this.providerMessages()
    const triggerSource = this.reasoningTriggerSource ?? this.planUpdateReason
    if (providerMessagesOverride === undefined && this.planningHorizonOverride) {
      const horizonGuidance = {
        immediate: 'Choose only the next concrete action needed from current grounded state.',
        checkpoint: 'Plan only far enough to reach and verify the active semantic checkpoint.',
        subgoal: 'Plan only the bounded current milestone/subgoal; do not flatten later milestones into this Plan Tracker.',
        strategic: 'Choose or revise bounded milestone direction, but keep execution plan scoped to the current milestone and keep future milestones tentative.',
      }[this.planningHorizonOverride]
      const envelope = `[DECISION_ENVELOPE] planning_horizon=${this.planningHorizonOverride}; observation_budget_remaining=${Number.isSafeInteger(this.observationBudgetRemaining) ? this.observationBudgetRemaining : 'runtime-default'}; observation_families=${Array.isArray(this.observationRelevanceOverride) ? this.observationRelevanceOverride.join(',') : 'runtime-default'}. ${horizonGuidance ?? ''}`
      providerMessages = [...providerMessages, { role: 'user', content: envelope }]
    }
    const startedAt = Date.now()
    if (recoveryAttempt > 0 && this.traceRequest) {
      this.traceRequest.recovery = {
        ...(this.traceRequest.recovery ?? {}),
        attempt: recoveryAttempt,
        round,
        ...(traceRecoveryKind ? { kind: traceRecoveryKind } : {}),
      }
    }
    await this.traceEvent('provider.request', {
      round,
      trigger_source: triggerSource,
      reasoning_budget: this.reasoningBudgetOverride ?? undefined,
      planning_horizon: this.planningHorizonOverride ?? undefined,
      observation_budget: this.observationBudgetOverride ?? undefined,
      observation_relevance_families: Array.isArray(this.observationRelevanceOverride)
        ? this.observationRelevanceOverride
        : undefined,
      allow_tools: effectiveAllowTools,
      recovery_attempt: effectiveRecoveryAttempt,
      recovery_kind: traceRecoveryKind,
      message_count: providerMessages.length,
      message_chars: providerMessages.reduce((total, message) => total + messageChars(message), 0),
    })
    let message
    try {
      message = await this.provider(providerMessages, {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
        allowTools: effectiveAllowTools,
        recoveryAttempt: effectiveRecoveryAttempt,
        recoveryKind,
        triggerSource,
        reasoningBudget: this.reasoningBudgetOverride ?? undefined,
        lifecycle: this.requestLifecycle,
        actionOmissionRepair: omissionRepair,
        requestBodyPatch: omissionRepair ? { max_tokens: ACTION_OMISSION_MAX_TOKENS } : undefined,
        signal: controller.signal,
      })
      const usage = normalizedProviderUsage(message?._airiProvider?.usage)
      accumulateProviderUsage(this.traceRequest?.usage, usage)
      if (Number.isSafeInteger(usage?.output_units)) this.providerBudgetGenerationOutputUnits += usage.output_units
      const aggregateOutputUnits = this.traceRequest?.usage?.output_units
      const generationOutputUnits = this.providerBudgetGenerationOutputUnits
      const turnOutputCapExceeded = Number.isSafeInteger(generationOutputUnits) && generationOutputUnits > this.maxProviderOutputUnits
      const responseTrace = {
        kind: 'response',
        round,
        trigger_source: triggerSource,
        recovery_attempt: effectiveRecoveryAttempt,
        recovery_kind: traceRecoveryKind,
        latency_ms: Date.now() - startedAt,
        has_tool_calls: message?.tool_calls !== undefined,
        content_chars: typeof message?.content === 'string' ? message.content.length : 0,
        usage,
        provider: compactProviderMetadata(message?._airiProvider),
        turn_output_cap: this.maxProviderOutputUnits,
        turn_output_units: Number.isSafeInteger(generationOutputUnits) ? generationOutputUnits : undefined,
        budget_generation: this.providerBudgetGeneration,
        request_output_units: Number.isSafeInteger(aggregateOutputUnits) ? aggregateOutputUnits : undefined,
      }
      if (responseTrace.provider) responseTrace.provider.usage_complete = usage?.usage_complete === true
      if (this.traceRequest) this.traceRequest.last_provider_event = responseTrace
      await this.traceEvent('provider.response', responseTrace)
      if (turnOutputCapExceeded) {
        await this.traceEvent('budget.output_units_exceeded', {
          output_units: generationOutputUnits,
          request_output_units: aggregateOutputUnits,
          output_cap: this.maxProviderOutputUnits,
          budget_generation: this.providerBudgetGeneration,
          provider_calls: this.traceRequest?.usage?.provider_calls,
        })
        const capError = new AgentLoopError(`provider_turn_output_cap_exceeded: generation ${this.providerBudgetGeneration} used ${generationOutputUnits} > ${this.maxProviderOutputUnits}`)
        capError.failureClass = 'provider_budget'
        capError.code = 'provider_turn_output_cap_exceeded'
        throw capError
      }
    }
    catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      const errorTrace = {
        kind: 'error',
        round,
        trigger_source: triggerSource,
        recovery_attempt: effectiveRecoveryAttempt,
        recovery_kind: traceRecoveryKind,
        latency_ms: Date.now() - startedAt,
        message: messageText,
        timeout: /timed out/i.test(messageText),
        cancelled: /cancelled/i.test(messageText),
      }
      if (this.traceRequest) this.traceRequest.last_provider_event = errorTrace
      await this.traceEvent('provider.error', errorTrace)
      throw error
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    if (generation !== this.generation || !this.active) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()
    if (!message || typeof message !== 'object') throw new AgentLoopError('Provider returned no message')

    let plannerSubmission
    try {
      plannerSubmission = effectiveAllowTools ? plannerControlPayloadFromMessage(message) : undefined
    }
    catch (error) {
      // A malformed submitPlan call is a plan-format error, exactly like
      // malformed JSON content. Throwing here skipped the bounded format
      // recovery and ended the whole request (recoverable:false) on one bad
      // tool call. Hand the raw arguments on as content so parsePlanMessage
      // fails into recoverPlan, and keep a bounded preview for diagnosis.
      const call = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
        .find(item => isPlannerControlToolName(item?.function?.name))
      const rawArgs = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
      await this.traceEvent('provider.plan_submission_invalid', {
        reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        tool_call_count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
        arguments_chars: rawArgs.length,
        arguments_head: cleanMemoryText(rawArgs.slice(0, 300), 300),
        arguments_tail: cleanMemoryText(rawArgs.slice(-200), 200),
        finish_reason: message._airiProvider?.finish_reason,
      })
      // Live, deepseek reproducibly stops a submitPlan mid-way through an
      // optional trailing member (`..."operations":[...], "checkpoint"::`)
      // while reporting a clean finish. Everything before that member is a
      // complete plan. Keep it -- but only if the salvaged object passes the
      // same validation as an intact submission.
      const salvaged = salvageTruncatedJsonObject(rawArgs)
      if (salvaged) {
        try {
          plannerSubmission = plannerControlPayloadFromMessage({
            ...message,
            tool_calls: [{ ...call, function: { ...call.function, arguments: salvaged.text } }],
          })
          await this.traceEvent('provider.plan_submission_salvaged', {
            kept_keys: salvaged.keys,
            dropped_chars: rawArgs.length - salvaged.cut,
          })
        }
        catch {}
      }
      if (!plannerSubmission) message = { ...message, tool_calls: undefined, content: rawArgs }
    }
    if (plannerSubmission) {
      await this.traceEvent('provider.plan_submission', {
        source: 'submitPlan',
        plan_steps: Array.isArray(plannerSubmission.plan) ? plannerSubmission.plan.length : 0,
        operation_count: Array.isArray(plannerSubmission.operations) ? plannerSubmission.operations.length : 0,
        has_checkpoint: plannerSubmission.checkpoint !== undefined,
        roadmap_nodes: Array.isArray(plannerSubmission.roadmap) ? plannerSubmission.roadmap.length : 0,
        natural_content_chars: typeof message.content === 'string' ? message.content.length : 0,
      })
      message = {
        ...message,
        tool_calls: undefined,
        content: JSON.stringify(plannerSubmission),
      }
    }

    if (omissionRepair && !effectiveAllowTools && message.tool_calls !== undefined) {
      const state = this.memory.currentPlan?.(this.activePlanKey())
      await this.traceEvent('recovery.action_omission_observation_rejected', {
        reason_code: 'observation_budget_exhausted',
        requested_tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      })
      message = {
        ...message,
        tool_calls: undefined,
        content: JSON.stringify({
          chatMessage: 'Action-omission repair attempted another observation after the bounded observation budget was exhausted.',
          plan: Array.isArray(state?.plan) ? state.plan : [],
          currentStep: Number.isSafeInteger(state?.current_step) ? state.current_step : 0,
          operations: [],
        }),
      }
    }

    // Scope output-budget recovery to this provider decision rather than the
    // entire human request. The recursive retry is recoveryAttempt=1, so it
    // cannot re-enter here; a later independent planner decision still gets
    // its own single bounded recovery.
    if (effectiveAllowTools && !omissionRepair && effectiveRecoveryAttempt === 0 && providerOutputBudgetExhausted(message)) {
      this.outputBudgetRecoveryUsed = true
      const state = this.memory.currentPlan?.(this.activePlanKey())
      this.outputBudgetRecoveryGuard = {
        goal_id: state?.goal_id,
        world_evidence_observed: outputBudgetRecoveryEvidenceAvailable(state, this.planUpdateReason),
        fresh_tool_evidence: false,
        completed_operations: this.planUpdateReason === 'completion' && Array.isArray(state?.last_operations)
          ? state.last_operations.slice(0, 16)
          : [],
      }
      if (this.traceRequest) {
        this.traceRequest.recovery = {
          reason: 'provider_output_budget_exhausted',
          attempt: 1,
          round,
          kind: 'output_budget_exhaustion',
        }
      }
      await this.traceEvent('provider.output_budget_recovery_started', {
        round,
        recovery_attempt: 1,
        recovery_kind: 'output_budget_exhaustion',
        canonical_goal_id: state?.goal_id,
        canonical_step: state?.task_board?.active_index,
        world_evidence_observed: this.outputBudgetRecoveryGuard.world_evidence_observed,
        completed_operation_count: this.outputBudgetRecoveryGuard.completed_operations.length,
      })
      this.memory.setProviderRecovery?.(this.activePlanKey(), {
        kind: 'output_budget_exhaustion',
        phase: 'in_flight',
        goal_id: state?.goal_id,
        step_id: state?.task_board?.active_step_id,
        started_at: Date.now(),
      })
      await this.persistState()
      try {
        const recovered = await this.callProvider(current, generation, {
          round,
          allowTools: true,
          recoveryAttempt: 1,
          recoveryKind: 'output_budget_exhaustion',
          providerMessagesOverride: [
            ...providerMessages.map(item => ({ ...item })),
            { role: 'user', content: OUTPUT_BUDGET_RECOVERY_MESSAGE },
          ],
        })
        if (providerOutputBudgetExhausted(recovered)) {
          await this.traceEvent('provider.output_budget_recovery_exhausted', { round, recovery_attempt: 1, recovery_kind: 'output_budget_exhaustion' })
          const exhausted = new AgentLoopError('provider_output_budget_recovery_exhausted: compact no-reasoning recovery also exhausted its output budget')
          exhausted.failureClass = 'provider_budget'
          exhausted.code = 'provider_output_budget_recovery_exhausted'
          throw exhausted
        }
        this.memory.setProviderRecovery?.(this.activePlanKey(), undefined)
        await this.persistState()
        await this.traceEvent('provider.output_budget_recovery_succeeded', { round, recovery_attempt: 1, recovery_kind: 'output_budget_exhaustion' })
        return recovered
      }
      catch (error) {
        if (error?.code !== 'provider_output_budget_recovery_exhausted') {
          await this.traceEvent('provider.output_budget_recovery_failed', { round, recovery_attempt: 1, recovery_kind: 'output_budget_exhaustion', message: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
    }
    return message
  }

  parsePlanMessage(message) {
    if (providerOutputBudgetExhausted(message)) {
      const error = new AgentLoopError('provider_output_budget_exhausted: provider response exhausted its output budget before emitting valid plan content')
      error.failureClass = 'provider_budget'
      error.code = 'provider_output_budget_exhausted'
      throw error
    }
    if (message?._airiProvider?.diagnostic_code === 'provider_safety_blocked') {
      const error = new AgentLoopError('provider_safety_blocked: provider refused the response through a safety/content filter')
      error.failureClass = 'provider_safety'
      error.code = 'provider_safety_blocked'
      throw error
    }
    let checkpoint
    let goalDefinition
    let roadmap
    let roadmapNodeIds
    let developmentMode
    let semanticCompletion
    let baseMessage = message
    if (typeof message?.content === 'string') {
      let raw
      try { raw = JSON.parse(message.content) }
      catch {}
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // `parsePlan` is strict-exact-keys over the executable plan surface, so
        // anything that is not a step/operation has to be lifted off here or the
        // whole submission is rejected as an unexpected argument. `project` used
        // to be parsed by submitPlan and then die exactly here.
        if (Array.isArray(raw.roadmap)) roadmap = raw.roadmap
        if (Object.prototype.hasOwnProperty.call(raw, 'goal')) {
          try { goalDefinition = sanitizeGoalDefinition(raw.goal) }
          catch (error) {
            throw this.goalDefinitionError(error?.code ?? 'invalid_goal_definition', error instanceof Error ? error.message : String(error))
          }
        }
        if (Array.isArray(raw.roadmapNodeIds)) {
          roadmapNodeIds = Array.from(new Set(raw.roadmapNodeIds
            .filter(id => typeof id === 'string')
            .map(id => cleanMemoryText(id, 120))
            .filter(Boolean)))
            .slice(0, 16)
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'developmentMode')) {
          if (!['vertical', 'horizontal', 'maintain', 'recover'].includes(raw.developmentMode)) {
            const error = new AgentLoopError('developmentMode must be vertical, horizontal, maintain, or recover')
            error.failureClass = 'plan_category'
            error.code = 'invalid_development_mode'
            throw error
          }
          developmentMode = raw.developmentMode
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'semanticCompletion')) {
          const value = raw.semanticCompletion
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || typeof value.stepId !== 'string' || !value.stepId.trim()) {
            const error = new AgentLoopError('semanticCompletion must identify the exact active prose-only step')
            error.failureClass = 'plan_category'
            error.code = 'invalid_semantic_completion'
            throw error
          }
          semanticCompletion = {
            stepId: cleanMemoryText(value.stepId, 200),
            rationale: cleanMemoryText(value.rationale, 600),
          }
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'checkpoint')) {
          checkpoint = sanitizeStepCompletionContract(raw.checkpoint)
          if (!completionContractSupported(checkpoint)) {
            const error = new AgentLoopError('checkpoint must be a runtime-supported semantic completion contract or be omitted')
            error.failureClass = 'plan_category'
            error.code = 'invalid_semantic_checkpoint'
            throw error
          }
          checkpoint = { ...checkpoint, source: 'planner_semantic_checkpoint' }
        }
        if (checkpoint || semanticCompletion || roadmap || roadmapNodeIds || developmentMode || goalDefinition
          || Object.prototype.hasOwnProperty.call(raw, 'goal')
          || Object.prototype.hasOwnProperty.call(raw, 'roadmap')
          || Object.prototype.hasOwnProperty.call(raw, 'roadmapNodeIds')
          || Object.prototype.hasOwnProperty.call(raw, 'developmentMode')
          || Object.prototype.hasOwnProperty.call(raw, 'semanticCompletion')) {
          const {
            checkpoint: _checkpoint,
            semanticCompletion: _semanticCompletion,
            roadmap: _roadmap,
            roadmapNodeIds: _roadmapNodeIds,
            developmentMode: _developmentMode,
            goal: _goal,
            ...base
          } = raw
          baseMessage = { ...message, content: JSON.stringify(base) }
        }
      }
    }
    const plan = super.parsePlanMessage(baseMessage)
    if (checkpoint) plan.checkpoint = checkpoint
    if (semanticCompletion) plan.semanticCompletion = semanticCompletion
    if (roadmap) plan.roadmap = roadmap
    if (roadmapNodeIds) plan.roadmapNodeIds = roadmapNodeIds
    if (developmentMode) plan.developmentMode = developmentMode
    if (goalDefinition) plan.goalDefinition = goalDefinition
    this.enforceGoalDefinition(plan)
    const normalizedPlan = normalizeCanonicalPlan(plan.plan, plan.currentStep)
    plan.plan = normalizedPlan.plan
    plan.currentStep = normalizedPlan.currentStep
    for (const operation of plan.operations) {
      if (!EXACT_ENTITY_TARGET_OPERATIONS.has(operation.name)) continue
      const unitNumber = operation.args?.unit_number
      if (this.liveObservedExactTarget(unitNumber)) continue
      const repeated = this.rejectedExactTargets.has(unitNumber)
      this.rejectedExactTargets.add(unitNumber)
      const locator = historicalExactTargetLocator(this.memory.currentPlan?.(this.activePlanKey()), unitNumber)
      const location = locator?.position && Number.isFinite(locator.position.x) && Number.isFinite(locator.position.y)
        ? ` Durable semantic locator: ${locator.name ?? 'entity'} at absolute position (${locator.position.x}, ${locator.position.y})${locator.surface ? ` on surface ${locator.surface}` : ''}.`
        : locator?.name
          ? ` Durable semantic context identifies ${locator.name}, but no executable exact identity is retained.`
          : ''
      const error = new AgentLoopError(
        repeated
          ? `Exact entity target unit ${unitNumber} was already rejected in this active request and still has no live observation binding. Repeating the same historical exact identity cannot make it executable. Do not resubmit it; use durable location/context, obtain a fresh getNearbyEntities/getEntityStatus/findLongRangeEntities observation, and only then use the exact unit_number returned by that observation.${location}`
          : `Exact entity target unit ${unitNumber} is not bound by a live observation in this active request. Historical unit_number values are non-executable even when they appear in old diagnostics. Do not resubmit the rejected id. Use durable location/context to navigate with walk_to_position if needed, obtain a fresh getNearbyEntities/getEntityStatus/findLongRangeEntities observation, and then bind the exact unit_number returned by that current observation.${location}`,
      )
      error.failureClass = 'plan_category'
      error.code = 'exact_entity_requires_live_observation'
      error.details = {
        operation_name: operation.name,
        unit_number: unitNumber,
        durable_locator: locator,
        repeated_stale_exact_target: repeated,
        deterministic_no_retry: repeated,
      }
      throw error
    }
    for (const operation of plan.operations) {
      if (operation.name !== 'mine_entity') continue
      const targets = this.observedMiningTargets(operation.args.entity_name)
      const exact = targets.filter(target => Number.isSafeInteger(target.unit_number))
      if (exact.length > 0) {
        const error = new AgentLoopError(
          `Exact live identity was already observed for ${operation.args.entity_name}; use mine_entity_exact with an observed unit_number instead of falling back to legacy name-based mining. Exact mining owns runtime repositioning when the target is outside mining reach.`,
        )
        error.failureClass = 'plan_category'
        error.code = 'exact_identity_available_for_mining'
        error.details = {
          entity_name: operation.args.entity_name,
          observed_unit_numbers: exact.slice(0, 8).map(target => target.unit_number),
        }
        throw error
      }

      const remote = targets.filter(target => Number.isFinite(target.distance) && target.distance > 5)
      if (remote.length > 0 && !this.legacyMiningApproachVerified(operation.args.entity_name)) {
        const requiredRadius = Math.max(6, Math.min(4096, Math.ceil(Math.max(...remote.map(target => target.distance))) + 2))
        const error = new AgentLoopError(
          `The observed ${operation.args.entity_name} target is outside legacy local mining resolution and has no usable exact identity. Approach it first with walk_to_entity {entity_name:"${operation.args.entity_name}",search_radius:${requiredRadius}}, wait for authoritative navigation completion, then continue the same finite goal into mine_entity. A remote name observation is not proof that local mine_entity can resolve the target.`,
        )
        error.failureClass = 'plan_category'
        error.code = 'remote_name_mining_requires_approach'
        error.details = { entity_name: operation.args.entity_name, search_radius: requiredRadius }
        throw error
      }
    }

    const replayed = replayedCompletedOperations(plan, this.outputBudgetRecoveryGuard)
    if (replayed.length > 0) {
      void this.traceEvent('provider.output_budget_recovery_replay_rejected', {
        replayed_operation_count: replayed.length,
        replayed_operations: replayed,
      })
      throw new AgentLoopError('Output-budget recovery attempted to replay a completed world mutation')
    }
    return plan
  }

  prepareToolBatch(message) {
    try {
      const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
      const partialBatchEligible = rawCalls.length > MAX_OBSERVATION_TOOL_CALLS_PER_BATCH
        && rawCalls.every(tool => isObservationToolName(tool?.function?.name))
        && rawCalls.every(tool => tool?.function?.name !== 'measureTransportThroughput')
      const admittedMessage = partialBatchEligible
        ? { ...message, tool_calls: rawCalls.slice(0, MAX_OBSERVATION_TOOL_CALLS_PER_BATCH) }
        : message
      const prepared = super.prepareToolBatch(admittedMessage)
      if (partialBatchEligible) {
        Object.defineProperty(prepared, '_airiObservationAdmission', {
          configurable: true,
          enumerable: false,
          value: {
            requested_count: rawCalls.length,
            deferred_tools: rawCalls.slice(MAX_OBSERVATION_TOOL_CALLS_PER_BATCH),
          },
        })
      }
      return prepared
    }
    catch (error) {
      void this.traceEvent('tool.rejected', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  observationDecisionPressureBudget() {
    if (Number.isSafeInteger(this.observationBudgetRemaining)) return Math.max(0, Math.min(8, this.observationBudgetRemaining))
    return super.observationDecisionPressureBudget()
  }

  async handleToolBatch(message, prepared = this.prepareToolBatch(message)) {
    if (this.actionOmissionRepairActive && (this.actionOmissionObservationUsed || prepared.length !== 1)) {
      this.actionOmissionForceNoTools = true
      const reason = this.actionOmissionObservationUsed
        ? 'The action-omission repair already consumed its one targeted observation.'
        : `The action-omission repair permits exactly one targeted observation, but the provider requested ${prepared.length}.`
      this.messages.push({
        role: 'user',
        content: `[HARNESS] ${reason} No observation from this batch was executed. ${ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE}`,
      })
      await this.recoveryDiagnostic({
        failure_class: 'action_omission',
        reason_code: 'action_omission_observation_budget',
        reason,
        retry: 1,
        retry_limit: 1,
        tools_enabled: false,
      })
      return
    }

    const admission = prepared._airiObservationAdmission
    const cachedPrepared = prepared.map(entry => this.toolCache.has(entry.signature))
    const staticCachedPrepared = prepared.map(entry => entry.tool.function.name === 'getPrototypeDetails' && this.staticPrototypeCache.has(entry.signature))
    const admittedPrepared = []
    const admittedCached = []
    const admittedStaticCached = []
    const deferredPrepared = []
    const deferredByRelevance = []
    const selectedObservationFamilies = Array.isArray(this.observationRelevanceOverride)
      ? new Set(this.observationRelevanceOverride)
      : null
    let freshSlots = Number.isSafeInteger(this.observationBudgetRemaining)
      ? Math.max(0, this.observationBudgetRemaining)
      : Number.POSITIVE_INFINITY

    for (let index = 0; index < prepared.length; index++) {
      const fresh = cachedPrepared[index] !== true && staticCachedPrepared[index] !== true
      const family = observationToolFamily(prepared[index]?.tool?.function?.name)
      const relevant = !fresh || selectedObservationFamilies === null || selectedObservationFamilies.has(family)
      if (relevant && (!fresh || freshSlots > 0)) {
        admittedPrepared.push(prepared[index])
        admittedCached.push(cachedPrepared[index])
        admittedStaticCached.push(staticCachedPrepared[index])
        if (fresh && Number.isFinite(freshSlots)) freshSlots--
      }
      else {
        deferredPrepared.push(prepared[index])
        if (fresh && !relevant) deferredByRelevance.push(prepared[index])
      }
    }

    const rawDeferredTools = Array.isArray(admission?.deferred_tools) ? admission.deferred_tools : []
    const totalDeferredCount = deferredPrepared.length + rawDeferredTools.length
    if (totalDeferredCount > 0) {
      await this.traceEvent('observation.partial_admission', {
        requested_count: Number.isSafeInteger(admission?.requested_count) ? admission.requested_count : prepared.length,
        admitted_count: admittedPrepared.length,
        deferred_count: totalDeferredCount,
        budget_remaining_before: Number.isSafeInteger(this.observationBudgetRemaining) ? this.observationBudgetRemaining : undefined,
        selected_families: selectedObservationFamilies ? [...selectedObservationFamilies] : undefined,
        deferred_by_relevance_count: deferredByRelevance.length,
        deferred_tools: [
          ...deferredPrepared.map(entry => entry.tool.function.name),
          ...rawDeferredTools.map(tool => tool?.function?.name).filter(Boolean),
        ],
      })
    }

    const freshRequestedCount = admittedPrepared.reduce(
      (total, _entry, index) => total + (admittedCached[index] !== true && admittedStaticCached[index] !== true ? 1 : 0),
      0,
    )
    if (admittedPrepared.length === 0) {
      const reason = deferredByRelevance.length > 0
        ? `Jev typed observation relevance did not select the requested fresh observation family; selected families: ${selectedObservationFamilies ? [...selectedObservationFamilies].join(', ') || 'none' : 'runtime-default'}.`
        : `Jev observation cap had ${this.observationBudgetRemaining ?? 0} fresh call(s) remaining, so the requested fresh observations were deferred.`
      await this.forceDecisionFromObservations(reason, 'jev_observation_budget_exhausted')
      return
    }

    for (let index = 0; index < admittedPrepared.length; index++) {
      const entry = admittedPrepared[index]
      if (this.traceRequest?.usage) {
        this.traceRequest.usage.tool_calls++
        if (admittedCached[index]) this.traceRequest.usage.duplicate_tool_calls++
      }
      const toolTrace = {
        phase: 'call',
        tool_call_id: entry.tool.id,
        name: entry.tool.function.name,
        args: entry.args,
        cached: admittedCached[index],
      }
      if (this.traceRequest) this.traceRequest.last_tool = toolTrace
      await this.traceEvent('tool.call', toolTrace)
    }
    const beforeCount = this.messages.length
    const admittedMessage = { ...message, tool_calls: admittedPrepared.map(entry => entry.tool) }
    this.compactionDeferred = true
    try {
      await super.handleToolBatch(admittedMessage, admittedPrepared)
    }
    catch (error) {
      await this.traceEvent('tool.error', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
    finally {
      this.compactionDeferred = false
    }
    const results = this.messages.slice(beforeCount + 1).filter(item => item.role === 'tool')
    if (!this.actionOmissionRepairActive && Number.isSafeInteger(this.observationBudgetRemaining) && freshRequestedCount > 0) {
      this.observationBudgetRemaining = Math.max(0, this.observationBudgetRemaining - freshRequestedCount)
      if (this.observationBudgetRemaining === 0) {
        await this.forceDecisionFromObservations(
          totalDeferredCount > 0
            ? `Jev observation budget is exhausted for this decision after partially admitting the useful subset; ${totalDeferredCount} observation call(s) were deferred.`
            : 'Jev observation budget is exhausted for this decision.',
          'jev_observation_budget_complete',
        )
      }
    }
    else if (totalDeferredCount > 0) {
      this.messages.push({
        role: 'user',
        content: `[HARNESS] Observation batch partially admitted: executed ${admittedPrepared.length} read-only call(s) and deferred ${totalDeferredCount} due to the per-turn observation cap. Reuse the returned evidence first; request only still-needed deferred facts on a later observation turn.`,
      })
    }
    const freshResultObserved = results.some((_, index) => admittedCached[index] !== true && admittedStaticCached[index] !== true)
    if (freshResultObserved) this.freshObservationSinceContinuation = true
    if (this.outputBudgetRecoveryGuard && freshResultObserved) {
      this.outputBudgetRecoveryGuard.world_evidence_observed = true
      this.outputBudgetRecoveryGuard.fresh_tool_evidence = true
    }
    for (let index = 0; index < results.length; index++) {
      const original = String(results[index].content ?? '')
      const toolName = admittedPrepared[index]?.tool?.function?.name
      this.recordLiveEntityToolResult(toolName, original)
      const loadedSkill = this.recordLoadedSkillToolResult(toolName, admittedPrepared[index]?.args, original)
      if (loadedSkill) {
        await this.traceEvent('skill.context_loaded', {
          skill_id: loadedSkill.id,
          revision: loadedSkill.revision,
          loaded_skill_count: this.loadedSkillContext.size,
        })
      }
      if (admittedCached[index]) results[index].content = DUPLICATE_OBSERVATION_MESSAGE
      const output = String(results[index].content ?? '')
      if (this.traceRequest?.usage) this.traceRequest.usage.tool_result_chars += output.length
      const toolTrace = {
        phase: 'result',
        tool_call_id: admittedPrepared[index]?.tool.id,
        name: admittedPrepared[index]?.tool.function.name,
        cached: admittedCached[index],
        original_output_chars: original.length,
        output_chars: output.length,
      }
      if (this.traceRequest) this.traceRequest.last_tool = toolTrace
      await this.traceEvent('tool.result', { ...toolTrace, output })
    }
    this.compactWorkingContext()
    if (this.actionOmissionRepairActive) {
      this.actionOmissionObservationUsed = true
      this.actionOmissionForceNoTools = true
      this.messages.push({ role: 'user', content: `[HARNESS] ${ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE}` })
      await this.traceEvent('recovery.action_omission_observation_complete', {
        cached: admittedCached[0] === true,
        observation: admittedPrepared[0]?.tool?.function?.name,
        tools_enabled_next_round: false,
      })
    }
  }

  clearActionOmissionRecovery() {
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
  }

  async beginActionOmissionRepair(plan, reasonCode) {
    if (!this.requestInfo) return undefined
    const state = this.memory.beginActionOmissionRecovery?.(this.requestInfo.memoryKey, this.requestInfo, plan)
    if (!state || state.status !== 'active') return state
    this.actionOmissionRepairActive = true
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    await this.persistState()
    await this.traceEvent('recovery.action_omission_started', {
      reason_code: reasonCode,
      goal_id: state.goal_id,
      active_step: state.task_board?.active_index,
      completed_count: state.task_board?.completed_count,
      provider_call_budget: '1 act-or-block call; one targeted observation may require one final no-tools decision call',
    })
    return state
  }

  async recoveryDiagnostic(details) {
    if (details?.reason_code === 'finite_goal_continuation_pressure' && this.pendingFiniteNoOperationPlan) {
      const omittedPlan = this.pendingFiniteNoOperationPlan
      this.pendingFiniteNoOperationPlan = null
      const state = await this.beginActionOmissionRepair(omittedPlan, 'finite_goal_continuation_pressure')
      if (state?.status === 'active') {
        this.messages.push({ role: 'assistant', content: JSON.stringify(omittedPlan) })
      }
    }
    if (this.traceRequest) this.traceRequest.recovery = { ...(this.traceRequest.recovery ?? {}), ...details }
    await this.traceEvent('recovery.classified', details)
  }

  finiteNoOperationPressure(plan) {
    if (plan?.operations?.length > 0 || !Array.isArray(plan?.plan) || plan.plan.length === 0) return ''
    if (providerBlockerReason(plan)) return ''
    const state = this.memory.currentPlan?.(this.activePlanKey())
    if (this.planUpdateReason !== 'completion' || state?.status !== 'active' || state?.last_mutation_verified !== true) return ''
    const latestVerification = [...(state?.task_board?.evidence ?? [])].reverse().find(item => item?.kind === 'deterministic_verification')
    if (!latestVerification) return ''
    this.pendingFiniteNoOperationPlan = plan
    return actionOmissionRepairMessage(state)
  }

  async preflightOperations(operations) {
    const results = []
    const memoryKey = this.requestInfo?.memoryKey
    const assertPreflightCurrent = async () => {
      try {
        return await this.assertCurrent()
      }
      catch (error) {
        if (memoryKey && /NPC actor epoch changed/i.test(error instanceof Error ? error.message : String(error))) {
          this.memory.setAdmissionState?.(memoryKey, 'preflight_rejected')
          await this.persistState()
        }
        throw error
      }
    }

    for (let index = 0; index < operations.length; index++) {
      const command = renderOperationPreflight(operations[index])
      if (!command) {
        results.push({ ok: true, operation: operations[index].name, validation: 'not_required' })
        continue
      }
      await assertPreflightCurrent()
      let result
      try {
        result = JSON.parse(String(await this.rcon.command(command)).trim())
      }
      catch (error) {
        const failure = new AgentLoopError(`Deterministic operation preflight failed to return valid JSON for operation ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
        failure.preflight = { ok: false, code: 'preflight_transport_error', operation_index: index }
        throw failure
      }
      await assertPreflightCurrent()
      results.push(result)
      if (result?.ok !== true) {
        const failure = new AgentLoopError(`Operation preflight rejected operation ${index + 1} (${operations[index].name}): ${result?.code ?? 'unknown_preflight_failure'}`)
        failure.preflight = { ...result, operation_index: index }
        throw failure
      }
    }
    return results
  }

  researchPreflightFacts(preflight) {
    return {
      code: preflight?.code,
      technology: preflight?.technology,
      requested: preflight?.requested,
      next_actionable: preflight?.next_actionable,
      research_trigger: preflight?.research_trigger,
      current_research: preflight?.current_research,
      queue: Array.isArray(preflight?.queue) ? preflight.queue.slice(0, 8) : undefined,
      queue_length: preflight?.queue_length,
      queue_truncated: preflight?.queue_truncated,
      research_path: preflight?.research_path,
    }
  }

  researchPreflightEvidenceSummary(preflight) {
    const next = preflight?.next_actionable
    return JSON.stringify({
      code: preflight?.code,
      operation_index: preflight?.operation_index,
      operation: preflight?.operation,
      technology: preflight?.technology,
      next_actionable: next
        ? {
            name: next.name,
            mode: next.mode,
            status: next.status,
            research_trigger: next.research_trigger,
          }
        : undefined,
      research_trigger: preflight?.research_trigger,
      current_research: preflight?.current_research,
      queue: Array.isArray(preflight?.queue) ? preflight.queue.slice(0, 4) : undefined,
      queue_length: preflight?.queue_length,
    })
  }

  researchPreflightCorrectionMessage(preflight) {
    const facts = this.researchPreflightFacts(preflight)
    let guidance = 'Use the supplied deterministic facts to choose the next executable decision.'
    if (preflight?.code === 'missing_prerequisites') {
      guidance = 'Follow next_actionable exactly. If its mode is science, research that technology; if its mode is trigger, perform its exact research_trigger and then verify. Do not retry the requested locked technology until deterministic eligibility changes.'
    }
    else if (preflight?.code === 'trigger_research') {
      guidance = 'If next_actionable is an earlier prerequisite, resolve it first. If the requested trigger technology itself is next_actionable, perform the exact research_trigger returned here and then verify it before continuing.'
    }
    else if (preflight?.code === 'force_busy') {
      guidance = 'Preserve the existing force research/queue. Use the exact current/queue identities to wait, observe, or do other work that remains part of this semantic step; do not clear or replace the force queue just to admit this request.'
    }
    return `[HARNESS] Deterministic research preflight rejected the requested operation before any Autorio batch admission, so no operation from that batch ran. This is a recoverable dependency/control-state result, not WORLD_BLOCKED. Preserve the same user goal and active canonical semantic step. Tools remain enabled. ${guidance} Deterministic facts: ${JSON.stringify(facts)}`
  }

  async recordRecoverableResearchPreflight(stateResult, preflight) {
    if (!this.requestInfo) return stateResult
    const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
    if (state) stateResult = { ...(stateResult ?? {}), state }
    this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
      kind: 'operation_preflight_recoverable',
      ref: `${this.traceRequest?.id ?? 'request'}/research_${preflight?.code ?? 'recoverable'}`,
      summary: this.researchPreflightEvidenceSummary(preflight),
    })
    await this.persistState()
    return stateResult
  }

  async finishResearchPreflightRecoveryFailure(stateResult, plan, before, preflight) {
    let state = stateResult?.state
    if (this.requestInfo) {
      const runtime = await this.readInteractionTaskStatus()
      const persistentRuntime = await this.persistentRuntimeStatus()
      const failureCandidate = {
        kind: 'recoverable_provider_failure',
        source: 'research_preflight_recovery',
        reason_code: 'research_preflight_retry_exhausted',
        evidence: [],
      }
      await this.traceEvent('outcome.candidate', failureCandidate)
      const reduced = this.memory.applyOutcomeAuthority?.(this.requestInfo.memoryKey, failureCandidate, {
        world: {
          ...runtime,
          persistent_runtime: persistentRuntime,
          persistent_runtime_healthy: persistentRuntimeHealthy(persistentRuntime),
          condition_wait_active: state?.condition_wait?.state === 'active',
          condition_wait: state?.condition_wait,
        },
        chatMessage: plan.chatMessage,
      })
      state = reduced?.state ?? state
      if (state) stateResult = { ...(stateResult ?? {}), state }
      await this.traceEvent(reduced?.decision?.accepted ? 'outcome.validated' : 'outcome.rejected', reduced?.decision ?? failureCandidate)
      await this.persistState()
    }

    this.active = false
    await this.traceEvent('operations.preflight_recovery_exhausted', {
      failure_class: 'research_preflight_retry_exhausted',
      retry_budget: RESEARCH_PREFLIGHT_RETRY_BUDGET,
      preflight,
      task_board: visibleTaskBoard(state?.task_board),
    })
    await this.traceEvent('request.completed', {
      chat_message: plan.chatMessage,
      outcome: 'recoverable_provider_failure',
      task_board: visibleTaskBoard(state?.task_board),
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    return {
      chatMessage: '[Plan paused] Deterministic research correction was ignored repeatedly; planner/control recovery stopped without declaring a world blocker.',
      plan: state?.plan ?? plan.plan,
      currentStep: state?.current_step ?? plan.currentStep,
      operations: [],
      epoch: before.epoch,
      actorId: before.actor_id,
      goalId: state?.goal_id,
      goalStatus: state?.status,
      taskBoard: visibleTaskBoard(state?.task_board),
      recoverableFailure: {
        class: 'provider_control_plane',
        reason: 'research_preflight_retry_exhausted',
        preflight: this.researchPreflightFacts(preflight),
      },
    }
  }

  async markAdmissionFailure(stateResult, operations, failure, kind = 'admission_failure') {
    if (!this.requestInfo) return stateResult
    const operationIndex = Number.isSafeInteger(failure?.operationIndex)
      ? failure.operationIndex
      : Number.isSafeInteger(failure?.preflight?.operation_index)
        ? failure.preflight.operation_index
        : undefined
    const operation = operationIndex !== undefined ? operations[operationIndex] : undefined
    const factorioError = cleanMemoryText(failure?.factorioError ?? failure?.message ?? String(failure), 1600)
    const evidence = {
      kind,
      ref: `${this.traceRequest?.id ?? 'request'}/admission`,
      summary: JSON.stringify({
        request_id: this.traceRequest?.id,
        operation_index: operationIndex === undefined ? undefined : operationIndex + 1,
        operation_name: operation?.name,
        operation_args: sanitizeTraceValue(operation?.args ?? {}),
        reason_code: failure?.preflight?.code,
        factorio_error: factorioError,
        no_replay: failure?.noReplay === true,
      }),
    }
    const blocker = failure?.preflight?.code
      ? `operation_preflight_failed:${failure.preflight.code}`
      : 'operation_admission_failed'
    const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admission_failed', { blocker, evidence })
    await this.persistState()
    return state ? { ...(stateResult ?? {}), state } : stateResult
  }

  async finishNoOperationBlock(plan, before, blocker, reason, evidenceKind) {
    if (!this.requestInfo) {
      this.active = false
      this.clearActionOmissionRecovery()
      return {
        chatMessage: plan.chatMessage,
        plan: plan.plan,
        currentStep: plan.currentStep,
        operations: [],
        epoch: before.epoch,
        actorId: before.actor_id,
      }
    }

    let state = this.memory.currentPlan?.(this.requestInfo.memoryKey)
    if (!state && Array.isArray(plan.plan) && plan.plan.length > 0) {
      state = this.memory.beginActionOmissionRecovery?.(this.requestInfo.memoryKey, this.requestInfo, plan)
    }
    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
      sender: this.requestInfo.sender,
      user: this.requestInfo.text,
      assistant: plan.chatMessage,
      operations: [],
    })

    const blockerCandidate = {
      kind: 'world_blocked',
      source: evidenceKind === 'provider_blocker' ? 'main_planner' : 'action_omission_repair',
      reason_code: blocker,
      candidate_blocker: blocker,
      evidence: reason ? [{ kind: evidenceKind, ref: `${state?.goal_id ?? 'goal'}/candidate_blocker`, summary: cleanMemoryText(reason, 1200) }] : [],
    }
    await this.traceEvent('outcome.candidate', blockerCandidate)
    const blockerDecision = this.memory.applyOutcomeAuthority?.(this.requestInfo.memoryKey, blockerCandidate, { chatMessage: plan.chatMessage })
    await this.traceEvent(blockerDecision?.decision?.accepted ? 'outcome.validated' : 'outcome.rejected', {
      ...blockerDecision?.decision,
      candidate_blocker: blocker,
    })

    if (!blockerDecision?.decision?.accepted) {
      const runtime = await this.readInteractionTaskStatus()
      const persistentRuntime = await this.persistentRuntimeStatus()
      const failureCandidate = {
        kind: 'recoverable_provider_failure',
        source: evidenceKind === 'provider_blocker' ? 'main_planner' : 'action_omission_repair',
        reason_code: blocker || 'provider_recovery_failed',
        evidence: [],
      }
      await this.traceEvent('outcome.candidate', failureCandidate)
      const reduced = this.memory.applyOutcomeAuthority?.(this.requestInfo.memoryKey, failureCandidate, {
        world: {
          ...runtime,
          persistent_runtime: persistentRuntime,
          persistent_runtime_healthy: persistentRuntimeHealthy(persistentRuntime),
          condition_wait_active: state?.condition_wait?.state === 'active',
          condition_wait: state?.condition_wait,
        },
        chatMessage: plan.chatMessage,
      })
      state = reduced?.state ?? state
      await this.traceEvent(reduced?.decision?.accepted ? 'outcome.validated' : 'outcome.rejected', reduced?.decision ?? failureCandidate)
      if (reduced?.changed) {
        await this.traceEvent('task_state.transition', {
          status: state?.status,
          blocker: state?.blocker,
          pause_reason: state?.pause_reason,
          task_board: visibleTaskBoard(state?.task_board),
        })
      }
    }
    else {
      state = blockerDecision.state ?? state
    }

    await this.persistState()
    this.active = false
    await this.traceEvent('request.completed', {
      chat_message: plan.chatMessage,
      outcome: state?.status === 'blocked' ? 'world_blocked' : 'recoverable_provider_failure',
      task_board: visibleTaskBoard(state?.task_board),
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    this.clearActionOmissionRecovery()
    const visibleReason = providerBlockerReason(plan) || cleanMemoryText(reason, 800) || blocker
    return {
      chatMessage: state?.status === 'blocked'
        ? `[Plan blocked] ${visibleReason}`
        : `[Plan paused for recoverable provider failure] ${visibleReason}`,
      plan: state?.plan ?? plan.plan,
      currentStep: state?.current_step ?? plan.currentStep,
      operations: [],
      epoch: before.epoch,
      actorId: before.actor_id,
      goalId: state?.goal_id,
      goalStatus: state?.status,
      taskBoard: visibleTaskBoard(state?.task_board),
      blocker: state?.status === 'blocked' ? { class: blocker, reason: cleanMemoryText(reason, 1200) } : undefined,
    }
  }

  async applySemanticCompletionClaim(plan, state) {
    const claim = plan?.semanticCompletion
    if (!claim) return { applied: false, state }
    if (!this.requestInfo?.memoryKey || !state || state.status !== 'active') {
      const error = new AgentLoopError('semantic_completion_requires_active_step')
      error.failureClass = 'plan_category'
      error.code = 'invalid_semantic_completion'
      throw error
    }

    const board = state.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const step = activeIndex === undefined ? undefined : board?.steps?.[activeIndex]
    if (!step || claim.stepId !== step.id) {
      const error = new AgentLoopError(
        `semantic_completion_step_mismatch: claimed=${claim.stepId || 'none'} active=${step?.id || 'none'}`,
      )
      error.failureClass = 'plan_category'
      error.code = 'semantic_completion_step_mismatch'
      throw error
    }
    if (completionContractSupported(step.completion_contract)) {
      const error = new AgentLoopError('semantic_completion_cannot_bypass_deterministic_contract')
      error.failureClass = 'plan_category'
      error.code = 'semantic_completion_contract_exists'
      throw error
    }

    const groundingKinds = new Set([
      'deterministic_verification',
      'operation_receipt',
      'verified_world_state',
      'condition_satisfied',
      'fresh_world_observation',
    ])
    const grounding = [...(board?.evidence ?? [])]
      .filter(item => item?.step_id === step.id
        && typeof item?.ref === 'string'
        && item.ref
        && groundingKinds.has(item?.kind))
      .slice(-4)
      .map(item => ({
        kind: item.kind,
        ref: item.ref,
        summary: cleanMemoryText(item.summary, 1200),
      }))

    if (this.freshObservationSinceContinuation) {
      grounding.push({
        kind: 'verified_world_state',
        ref: `${this.traceRequest?.id ?? 'request'}/semantic_fresh_observation`,
        summary: 'The Main LLM made this semantic completion judgment after a fresh authoritative read-only world observation in the active request.',
      })
    }
    const deduped = Array.from(new Map(
      grounding.map(item => [`${item.kind}:${item.ref}`, item]),
    ).values()).slice(-4)
    if (deduped.length === 0) {
      const error = new AgentLoopError('semantic_completion_requires_runtime_grounding')
      error.failureClass = 'plan_category'
      error.code = 'semantic_completion_requires_grounding'
      throw error
    }

    const groundingRefs = deduped.map(item => item.ref)
    const reduced = this.memory.applyOutcomeAuthority?.(this.requestInfo.memoryKey, {
      kind: 'semantic_complete',
      source: 'main_planner',
      reason_code: 'planner_semantic_step_complete',
      evidence: deduped,
      metadata: {
        scope: 'step',
        step_id: step.id,
        grounding_refs: groundingRefs,
        rationale: cleanMemoryText(claim.rationale, 600),
      },
    }, { chatMessage: plan.chatMessage })

    if (reduced?.decision?.accepted !== true) {
      const error = new AgentLoopError(
        `semantic_completion_rejected:${reduced?.decision?.rejection_reason || 'unknown'}`,
      )
      error.failureClass = 'plan_category'
      error.code = 'semantic_completion_rejected'
      throw error
    }
    await this.persistState()
    await this.traceEvent('step.semantic_completed', {
      active_step_id: step.id,
      source: 'main_planner',
      grounding_refs: groundingRefs,
      rationale: cleanMemoryText(claim.rationale, 600),
      task_board: visibleTaskBoard(reduced?.state?.task_board),
    })
    return { applied: true, state: reduced.state }
  }

  async commitPlan(plan) {
    plan = await this.applyLowRiskTypedProjection(plan)
    const triggerSource = this.reasoningTriggerSource ?? this.planUpdateReason
    const commands = plan.operations.map(renderOperation)
    const operations = plan.operations.map((operation, index) => ({
      trace_operation_id: `${this.traceRequest?.id ?? 'request'}/op_${index + 1}`,
      name: operation.name,
      args: operation.args,
    }))
    await this.traceEvent('plan.accepted', {
      trigger_source: triggerSource,
      chat_message: plan.chatMessage,
      plan: plan.plan,
      current_step: plan.currentStep,
      operations,
      ...(Array.isArray(plan.roadmap) && plan.roadmap.length > 0 ? { roadmap: plan.roadmap } : {}),
      ...(Array.isArray(plan.roadmapNodeIds) && plan.roadmapNodeIds.length > 0 ? { roadmap_node_ids: plan.roadmapNodeIds } : {}),
      ...(plan.developmentMode ? { development_mode: plan.developmentMode } : {}),
      ...(plan.checkpoint ? { checkpoint: plan.checkpoint } : {}),
      ...(plan.semanticCompletion ? { semantic_completion: plan.semanticCompletion } : {}),
    })

    const before = await this.assertCurrent()
    const persistentRuntime = commands.length === 0 && plan.plan.length > 0
      ? await this.persistentRuntimeStatus()
      : undefined
    let previousState = this.requestInfo
      ? this.memory.currentPlan?.(this.requestInfo.memoryKey)
      : undefined
    if (plan.semanticCompletion) {
      const semantic = await this.applySemanticCompletionClaim(plan, previousState)
      previousState = semantic.state ?? previousState
      // A closed step is progress: the next step gets a fresh act-or-block
      // repair instead of failing on the one this claim just resolved.
      if (semantic.applied === true) this.clearActionOmissionRecovery()
      if (previousState?.status === 'completed' && commands.length > 0) {
        const error = new AgentLoopError('semantic_completion_final_step_cannot_have_followup_operations')
        error.failureClass = 'plan_category'
        error.code = 'semantic_completion_after_final_step'
        throw error
      }
      if (previousState?.status === 'completed' && commands.length === 0) {
        const settled = await this.settleCompletedStepState(previousState, { allowContinuation: false })
        if (settled) return settled
      }
    }
    // The active step's own checkpoint as it stood BEFORE this batch; the
    // checkpoint pass below re-records one shaped by the new batch.
    const checkpointBeforeBatch = activeStepCheckpointSnapshot(previousState?.task_board)
    const runtimeHealthy = persistentRuntimeHealthy(persistentRuntime)
    let finalCompletionVerified = verifiedFinalCompletion(plan, previousState, this.planUpdateReason, {
      freshObservation: this.freshObservationSinceContinuation,
    })
    // "The batch ran" is not "the deterministic step is done". A final
    // completion claim still has to satisfy the immutable runtime contract.
    if (finalCompletionVerified && checkpointBeforeBatch?.checkpoint) {
      const evaluation = await this.evaluateWorldStateCheckpoint(checkpointBeforeBatch.checkpoint)
      if (!evaluation?.satisfied) finalCompletionVerified = false
    }
    const remainingCanonicalWork = !finalCompletionVerified && (
      canonicalWorkRemains(previousState)
      || (!previousState && Array.isArray(plan.plan) && plan.plan.length > 0)
    )
    const explicitBlocker = providerBlockerReason(plan)
    let conditionWait = previousState?.condition_wait?.state === 'active'
      ? previousState.condition_wait
      : undefined
    if (!conditionWait && commands.length === 0 && remainingCanonicalWork && !runtimeHealthy) {
      const candidate = this.passiveProgressWaitCandidate(previousState)
      if (candidate && this.requestInfo) {
        const waiting = this.memory.registerConditionWait?.(this.requestInfo.memoryKey, candidate)
        if (waiting?.condition_wait) {
          conditionWait = waiting.condition_wait
          await this.persistState()
          await this.traceEvent('runtime.condition_registered', {
            wait_id: conditionWait.id,
            goal_id: waiting.goal_id,
            step_id: waiting.task_board?.active_step_id,
            mode: conditionWait.mode,
            condition: conditionWait.condition,
          })
        }
      }
    }
    const conditionWaitActive = conditionWait?.state === 'active'

    if (commands.length === 0 && this.actionOmissionRepairActive && !runtimeHealthy && !conditionWaitActive && !finalCompletionVerified) {
      if (explicitBlocker) {
        return this.finishNoOperationBlock(plan, before, 'provider_reported_blocker', explicitBlocker, 'provider_blocker')
      }
      await this.traceEvent('recovery.action_omission_failed', {
        reason_code: 'repair_no_executable_action',
        detail: 'bounded repair returned no executable operation and no explicit BLOCKED reason',
      })
      throw new AgentLoopError(
        'provider_action_omission_repair_failed: bounded act-or-block repair returned no executable operation and no explicit BLOCKED: reason',
      )
    }

    if (commands.length === 0 && remainingCanonicalWork && !runtimeHealthy && !conditionWaitActive) {
      if (this.genericRecoveryDecisionActive) {
        // Generic strict recovery exists because the provider already failed to
        // produce a valid decision. Tools are intentionally disabled there, so
        // a no-op/"BLOCKED" answer can describe the recovery sandbox rather
        // than a real Factorio blocker. Never persist that as semantic world
        // truth. Let the request fail upward; the supervisor will pause the
        // durable plan when Autorio is authoritatively idle, preserving the
        // verified prefix for a fresh tool-capable Continue turn.
        const attemptedBlocker = explicitBlocker
          ? ` Recovery attempted BLOCKED: ${cleanMemoryText(explicitBlocker, 600)}`
          : ''
        throw new AgentLoopError(
          `Provider strict recovery could not safely resolve remaining canonical work without a fresh normal tool-capable turn.${attemptedBlocker}`,
        )
      }
      if (explicitBlocker) {
        return this.finishNoOperationBlock(plan, before, 'provider_reported_blocker', explicitBlocker, 'provider_blocker')
      }
      if (this.outputBudgetRecoveryGuard && this.outputBudgetRecoveryGuard.world_evidence_observed !== true) {
        // Output-budget recovery is provider orchestration, not Factorio world
        // truth. If the bounded recovery cannot produce grounded evidence or an
        // executable operation, fail the request upward instead of persisting a
        // durable BLOCKED task. The supervisor will pause the durable plan only
        // when Autorio is authoritatively idle, preserving the verified prefix
        // for a fresh normal tool-capable Continue turn.
        throw new AgentLoopError(
          'provider_output_budget_exhausted: bounded output-budget recovery produced no fresh world evidence and no executable operation for remaining canonical work',
        )
      }
      if (this.actionOmissionRepairActive) {
        await this.traceEvent('recovery.action_omission_failed', {
          reason_code: 'repair_no_executable_action',
          detail: 'bounded repair returned no executable operation and no explicit BLOCKED reason',
        })
        throw new AgentLoopError(
          'provider_action_omission_repair_failed: bounded act-or-block repair returned no executable operation and no explicit BLOCKED: reason',
        )
      }
      const state = await this.beginActionOmissionRepair(plan, 'no_operation_for_remaining_plan')
      if (state?.status === 'active') {
        this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
        this.messages.push({ role: 'user', content: `[HARNESS] ${actionOmissionRepairMessage(state)}` })
        return this.runTurn()
      }
    }

    if (runtimeHealthy || conditionWaitActive) this.clearActionOmissionRecovery()
    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    let stateResult
    let durablePlan = plan
    if (this.requestInfo) {
      this.lastMemoryKey = this.requestInfo.memoryKey
      const previousBoard = previousState?.task_board
      durablePlan = protectOutputBudgetRecoveryPlan(plan, previousState, this.outputBudgetRecoveryGuard)
      if (durablePlan !== plan) {
        await this.traceEvent('provider.output_budget_recovery_plan_guarded', {
          goal_id: previousState?.goal_id,
          canonical_step: durablePlan.currentStep,
          incoming_step: plan.currentStep,
          incoming_plan_length: plan.plan.length,
          canonical_plan_length: durablePlan.plan.length,
        })
      }
      const semanticRole = currentPlanStep(durablePlan.plan, durablePlan.currentStep)
      const durableOperations = plan.operations.slice(0, 16).map(operation => {
        const observation = Number.isSafeInteger(operation.args?.unit_number)
          ? this.liveObservedExactTarget(operation.args.unit_number)
          : undefined
        return durableOperationView(operation, { observation, semanticRole })
      })
      const exactTargetAudit = plan.operations.slice(0, 16).flatMap(operation => {
        const unitNumber = operation.args?.unit_number
        if (!Number.isSafeInteger(unitNumber)) return []
        const observation = this.liveObservedExactTarget(unitNumber)
        if (!observation) return []
        return [{
          unit_number: unitNumber,
          operation_name: cleanMemoryText(operation.name, 100),
          locator: durableEntityLocator(observation, semanticRole),
          recorded_at: Date.now(),
        }]
      })
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: durableOperations,
      })
      const completionEvidence = finalCompletionVerified
        ? [
            ...[...(previousState?.task_board?.evidence ?? [])].reverse().filter(item => item?.kind === 'deterministic_verification').slice(0, 1),
            ...(this.freshObservationSinceContinuation
              ? [{ kind: 'verified_world_state', ref: `${this.traceRequest?.id ?? 'request'}/fresh_observation`, summary: 'Fresh authoritative observation plus the canonical completion guard satisfied the final step.' }]
              : []),
          ].slice(0, 2)
        : []
      stateResult = this.memory.recordPlan?.(this.requestInfo.memoryKey, this.requestInfo, durablePlan, {
        continuation: this.continuations > 0,
        persistentRuntime,
        durableOperations,
        exactTargetAudit,
        verifiedCompletion: finalCompletionVerified,
        completionEvidence,
      })
        // The shelf can only be revised once the goal it belongs to has been
      // admitted, and `recordPlan` is what admits it, so this runs after it and
      // not with the rest of the plan-surface parsing.
      if (Array.isArray(plan.roadmap) && typeof this.memory.reviseRoadmap === 'function') {
        this.memory.reviseRoadmap(this.requestInfo.memoryKey, plan.roadmap, {
          now: Date.now(),
          reason: this.reasoningTriggerSource ?? this.planUpdateReason ?? 'planner_submission',
        })
      }
      if (plan.goalDefinition && typeof this.memory.defineGoal === 'function'
        && !this.memory.goalDefinition?.(this.requestInfo.memoryKey)) {
        const definition = this.memory.defineGoal(this.requestInfo.memoryKey, plan.goalDefinition)
        if (definition) {
          const planning = this.memory.planningState?.(this.requestInfo.memoryKey)
          await this.traceEvent('goal.defined', {
            goal_id: planning?.goal?.goal_id,
            objective: planning?.goal?.objective,
            definition,
            roadmap: (planning?.roadmap?.nodes ?? []).slice(0, 8).map(node => ({ id: node.id, intent: node.intent })),
            jev_goal_reading: this.pendingGoalReadingTrace ?? undefined,
          })
          if (definition.done_when.some(needsGoalBaseline)) await this.readGoalDefinition(this.requestInfo.memoryKey, definition)
        }
      }
      stateResult = this.memory.reconcileTaskBoard?.(this.requestInfo.memoryKey, previousBoard, durablePlan, stateResult, {
        // A committed suffix is immutable. Runtime recovery re-observes and
        // continues it; only USER_REVISION_APPROVED may replace it.
        allowReplan: false,
        previousState,
      }) ?? stateResult
      if (commands.length > 0 && stateResult?.state && stateResult?.blockedByHarness !== true) {
        const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitting')
        if (state) stateResult = { ...stateResult, state }
      }
      await this.persistState()
      await this.traceEvent('plan.persisted', {
        lifecycle: stateResult?.blockedByHarness === true ? 'blocked' : commands.length > 0 ? 'admitting' : 'accepted',
        goal_id: stateResult?.state?.goal_id,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
      })
      if (stateResult?.blockedByHarness !== true && plan.checkpoint) {
        const checkpointResult = await this.persistPlannerCheckpoint(plan)
        if (checkpointResult?.state) stateResult = { ...(stateResult ?? {}), state: checkpointResult.state }
      }
    }

    this.outputBudgetRecoveryGuard = null
    if (commands.length > 0) this.clearActionOmissionRecovery()

    if (commands.length > 0 && stateResult?.blockedByHarness === true) {
      this.active = false
      await this.traceEvent('operations.skipped', {
        reason: 'plan_blocked_awaiting_user',
        blocker: stateResult?.state?.blocker,
        operations,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
      })
      await this.traceEvent('request.completed', {
        chat_message: plan.chatMessage,
        outcome: 'blocked_no_operation',
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
      return {
        chatMessage: planProgress(plan, stateResult),
        plan: stateResult?.state?.plan ?? durablePlan.plan,
        currentStep: stateResult?.state?.current_step ?? durablePlan.currentStep,
        operations: [],
        epoch: before.epoch,
        actorId: before.actor_id,
        goalId: stateResult?.state?.goal_id,
        goalStatus: stateResult?.state?.status,
        taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
        blocker: {
          class: 'plan_blocked_awaiting_user',
          reason: stateResult?.state?.blocker ?? 'plan_blocked_awaiting_user',
        },
      }
    }

    if (commands.length > 0) {
      let preflight
      try {
        preflight = await this.preflightOperations(plan.operations)
        this.staleExactPreflightRetries = 0
        this.modelCorrectablePreflightRetries = 0
        this.researchPreflightRetries = 0
        this.bootstrapDependencyPreflightRetries = 0
        const planningBeforeCommit = this.requestInfo ? this.memory.planningState?.(this.requestInfo.memoryKey) : undefined
        const reducerPlanBeforeCommit = planningBeforeCommit ? getActivePlanningPlan(planningBeforeCommit) : undefined
        const planFrozen = FROZEN_PLAN_STATUSES.has(reducerPlanBeforeCommit?.status)
        if (!planFrozen && this.requestInfo && typeof this.memory.commitPlanningPlan === 'function') {
          // Preflight is the authoritative commit gate. Jev may help decide
          // what to observe or when to wake the planner, but it does not review
          // whether the Main LLM's draft is "correct" before execution.
          this.memory.commitPlanningPlan(this.requestInfo.memoryKey, {
            now: Date.now(),
            runtime_validation: { passed: true },
          })
          const committed = this.memory.currentPlan?.(this.requestInfo.memoryKey)
          if (committed) stateResult = { ...(stateResult ?? {}), state: committed }
          await this.persistState()
        }
        await this.traceEvent('operations.preflight_ok', {
          operations: operations.map((operation, index) => ({ ...operation, preflight: preflight[index] })),
        })
      }
      catch (error) {
        if (!error?.preflight) throw error
        if (error.preflight.operation === 'research_technology' && RESEARCH_PREFLIGHT_RECOVERABLE_CODES.has(error.preflight.code)) {
          this.researchPreflightRetries++
          stateResult = await this.recordRecoverableResearchPreflight(stateResult, error.preflight)
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: `research_${error.preflight.code}`,
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.researchPreflightRetries,
            retry_budget: RESEARCH_PREFLIGHT_RETRY_BUDGET,
          })
          if (this.researchPreflightRetries <= RESEARCH_PREFLIGHT_RETRY_BUDGET) {
            this.messages.push({
              role: 'user',
              content: this.researchPreflightCorrectionMessage(error.preflight),
            })
            return this.runTurn()
          }
          return this.finishResearchPreflightRecoveryFailure(stateResult, plan, before, error.preflight)
        }
        if (error?.preflight?.code === 'bootstrap_dependency_unresolved' && this.bootstrapDependencyPreflightRetries < 2) {
          this.bootstrapDependencyPreflightRetries++
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
              kind: 'operation_preflight_recoverable',
              ref: `${this.traceRequest?.id ?? 'request'}/bootstrap_dependency_unresolved`,
              summary: JSON.stringify({
                code: 'bootstrap_dependency_unresolved',
                operation_index: error.preflight.operation_index,
                operation: error.preflight.operation,
                item_name: error.preflight.identity,
                requested_count: error.preflight.requested_count,
                craftable_now_count: error.preflight.craftable_now_count,
                first_unresolved: error.preflight.bootstrap?.first_unresolved,
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: 'bootstrap_dependency_unresolved',
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.bootstrapDependencyPreflightRetries,
          })
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Deterministic craft preflight rejected the requested craft before Autorio admission because it is not currently craftable. Resolve the first unresolved bootstrap dependency before retrying the downstream craft. Reuse held items/buildings marked already_satisfied; bootstrap only missing quantities. A machine dependency with satisfaction_scope=inventory_acquisition means the machine item is already owned, not that a placed live machine instance exists. If processing requires that machine, first use an existing live observed compatible instance or place one from the held item; after placement, re-observe it and bind its real unit_number before any exact supply/configuration operation. Never invent a unit_number. This bootstrap inventory is for construction/startup only and does not remove steady-state recipe flow from a continuous production topology. Preflight: ${JSON.stringify(error.preflight.bootstrap ?? {})}`,
          })
          return this.runTurn()
        }
        if (MODEL_CORRECTABLE_PREFLIGHT_CODES.has(error?.preflight?.code)
          && (this.modelCorrectablePreflightRetries ?? 0) < MODEL_CORRECTABLE_PREFLIGHT_RETRY_BUDGET) {
          this.modelCorrectablePreflightRetries = (this.modelCorrectablePreflightRetries ?? 0) + 1
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
              kind: 'operation_preflight_recoverable',
              ref: `${this.traceRequest?.id ?? 'request'}/${error.preflight.code}`,
              summary: JSON.stringify({
                code: error.preflight.code,
                operation_index: error.preflight.operation_index,
                operation: error.preflight.operation,
                detail: cleanMemoryText(error.preflight.detail ?? error.preflight.identity ?? '', 300),
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: `model_correctable_${error.preflight.code}`,
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.modelCorrectablePreflightRetries,
            retry_budget: MODEL_CORRECTABLE_PREFLIGHT_RETRY_BUDGET,
          })
          const index = Number.isSafeInteger(error.preflight.operation_index) ? error.preflight.operation_index : 0
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Deterministic preflight rejected operation ${index + 1} (${cleanMemoryText(plan.operations[index]?.name, 80)}) before Autorio admission with code ${error.preflight.code}; no mutation from this batch ran. This is a naming/argument error in the proposed operation, not a world blocker. Correct the prototype, recipe, identity or argument using exact Factorio names already confirmed by observation (observe once if the exact name is unknown), then resubmit the same step. Do not change the plan's steps to avoid the error. Preflight: ${JSON.stringify(error.preflight).slice(0, 600)}`,
          })
          return this.runTurn()
        }
        if (error?.preflight?.code === 'stale_exact_target' && this.staleExactPreflightRetries < 1) {
          this.staleExactPreflightRetries++
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
              kind: 'operation_preflight_recoverable',
              ref: `${this.traceRequest?.id ?? 'request'}/stale_exact_target`,
              summary: JSON.stringify({
                code: 'stale_exact_target',
                operation_index: error.preflight.operation_index,
                operation: error.preflight.operation,
                identity: error.preflight.identity,
                last_observed: error.preflight.last_observed,
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: 'stale_exact_target',
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.staleExactPreflightRetries,
          })
          const previous = error.preflight.last_observed
          const location = previous?.position && Number.isFinite(previous.position.x) && Number.isFinite(previous.position.y)
            ? ` The old identity was last observed at absolute position (${previous.position.x}, ${previous.position.y}) as ${previous.name ?? 'an entity'}.`
            : ''
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Exact target unit ${error.preflight.identity ?? 'unknown'} is stale; deterministic preflight rejected it before Autorio admission, so no mutation from that operation ran.${location} A replacement at the same coordinate is a new identity. If the active task semantically means the entity at that location, use walk_to_position for the known coordinate as needed, then make one targeted live observation near the location and bind the current entity's returned unit_number before issuing any exact mutation. Tools remain enabled; do not silently substitute by name or reuse the stale unit_number.`,
          })
          return this.runTurn()
        }
        stateResult = await this.markAdmissionFailure(stateResult, operations, error, 'operation_preflight_blocker')
        await this.traceEvent('operations.preflight_rejected', {
          failure_class: 'deterministic_preflight',
          reason: error instanceof Error ? error.message : String(error),
          preflight: error?.preflight,
          operations,
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
        })
        this.active = false
        await this.traceEvent('request.completed', {
          chat_message: plan.chatMessage,
          outcome: 'blocked_preflight',
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
          usage: this.traceRequest?.usage,
        })
        this.traceRequest = null
        return {
          chatMessage: planProgress(plan, stateResult),
          plan: stateResult?.state?.plan ?? durablePlan.plan,
          currentStep: stateResult?.state?.current_step ?? durablePlan.currentStep,
          operations: [],
          epoch: before.epoch,
          actorId: before.actor_id,
          goalId: stateResult?.state?.goal_id,
          goalStatus: stateResult?.state?.status,
          taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
          blocker: error?.preflight,
        }
      }

      await this.traceEvent('operations.admit', { operations })
      try {
        const acknowledgement = await executeAuthorizedBatch(this.rcon, before.epoch, commands)
        await this.traceEvent('operations.ack', {
          operations: operations.map((operation, index) => ({ ...operation, admission_result: acknowledgement.results[index] })),
        })
        if (this.requestInfo && stateResult?.state) {
          const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitted')
          if (state) stateResult = { ...stateResult, state }
          await this.persistState()
        }
        await this.assertCurrent()
      }
      catch (error) {
        stateResult = await this.markAdmissionFailure(stateResult, operations, error, 'operation_admission_failure')
        const operationIndex = Number.isSafeInteger(error?.operationIndex) ? error.operationIndex : undefined
        await this.traceEvent('operations.admission_failed', {
          failure_class: 'mutation_admission',
          request_id: this.traceRequest?.id,
          operation_index: operationIndex === undefined ? undefined : operationIndex + 1,
          operation: operationIndex !== undefined ? operations[operationIndex] : undefined,
          factorio_error: error?.factorioError,
          no_replay: true,
          no_replay_reason: 'Earlier operations in the admitted batch may already have produced side effects.',
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
        })
        throw error
      }
    }

    if (commands.length === 0) {
      this.active = false
      const outcome = stateResult?.blockedByHarness
        ? 'blocked_no_operation'
        : conditionWaitActive
          ? 'condition_wait_active'
          : stateResult?.persistentRuntimeActive
            ? 'persistent_runtime_active'
            : 'no_operations'
      await this.traceEvent('request.completed', {
        chat_message: plan.chatMessage,
        outcome,
        persistent_runtime: persistentRuntime,
        condition_wait: conditionWait,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
    }
    else {
      await this.traceEvent('request.waiting', {
        operation_count: commands.length,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
    }

    const canonicalPlan = stateResult?.state?.plan ?? durablePlan.plan
    const canonicalStep = stateResult?.state?.current_step ?? durablePlan.currentStep
    this.planUpdateReason = 'continuation'
    return {
      chatMessage: planProgress(plan, stateResult),
      plan: canonicalPlan,
      currentStep: canonicalStep,
      operations: plan.operations,
      epoch: before.epoch,
      actorId: before.actor_id,
      goalId: stateResult?.state?.goal_id,
      goalStatus: stateResult?.state?.status,
      taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
      persistentRuntime: stateResult?.state?.persistent_runtime,
      conditionWait: stateResult?.state?.condition_wait,
    }
  }

  async routeRecoveryDecision(reason, roundBase = 0) {
    const generation = this.generation
    const current = await this.assertCurrent()
    const reasonText = cleanMemoryText(reason instanceof Error ? reason.message : String(reason), 1600)
    let conditionValidation = await this.validateConditionWaitHealth()
    const planState = this.memory.currentPlan?.(this.activePlanKey())
    const board = planState?.task_board
    const runtime = await this.readInteractionTaskStatus()
    const persistentRuntime = await this.persistentRuntimeStatus()
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const evidence = activeStepEvidence(board)
    const failureClass = recoveryFailureClassHint(reasonText)
    const key = [
      generation,
      planState?.goal_id ?? '',
      board?.revision ?? 0,
      roundBase,
      failureClass,
      conditionValidation.healthy ? `wait:${conditionValidation.wait?.id ?? ''}` : `wait:${conditionValidation.action ?? 'none'}`,
      reasonText.slice(0, 240),
    ].join('|')
    if (this.lastRecoveryDecisionKey === key && this.lastRecoveryDecision) {
      await this.traceEvent('recovery.route_coalesced', {
        failure_class: failureClass,
        route: this.lastRecoveryDecision.route,
      })
      return { ...this.lastRecoveryDecision, duplicate: true }
    }

    const recoveryWorld = {
      ...runtime,
      persistent_runtime: persistentRuntime,
      persistent_runtime_healthy: persistentRuntimeHealthy(persistentRuntime),
      condition_wait_active: conditionValidation.healthy === true,
      condition_wait: conditionValidation.healthy ? conditionValidation.wait : undefined,
    }
    const observationBudgetAvailable = this.actionOmissionObservationUsed !== true
      && (!Number.isSafeInteger(this.observationBudgetRemaining) || this.observationBudgetRemaining > 0)
    const deterministicRoute = deterministicRecoveryRoute({
      failureClass,
      world: recoveryWorld,
      observationBudgetAvailable,
      userDecisionRequired: planState?.status === PLAN_STATUS.BLOCKED,
    })
    if (deterministicRoute) {
      const result = {
        route: deterministicRoute.route,
        requested_route: deterministicRoute.route,
        failure_class: failureClass,
        rejection_reason: deterministicRoute.reason,
        runtime,
        persistentRuntime,
        conditionWaitHealthy: conditionValidation.healthy === true,
        conditionWait: conditionValidation.wait,
        runtime_state: deterministicRoute.runtime,
        decision_called: false,
        source: 'deterministic_recovery',
      }
      this.lastRecoveryDecisionKey = key
      this.lastRecoveryDecision = result
      await this.traceEvent('recovery.routed', {
        failure_class: failureClass,
        route: deterministicRoute.route,
        applied_route: deterministicRoute.route,
        fallback_reason: deterministicRoute.reason,
        decision_called: false,
        source: 'deterministic_recovery',
        runtime: deterministicRoute.runtime,
      })
      return result
    }

    if (!this.interactionDecisionProvider) {
      const result = {
        route: 'fallback_runtime',
        failure_class: failureClass,
        runtime,
        persistentRuntime,
        conditionWaitHealthy: conditionValidation.healthy === true,
        conditionWait: conditionValidation.wait,
        decision_called: false,
        source: 'jev_unavailable',
      }
      this.lastRecoveryDecisionKey = key
      this.lastRecoveryDecision = result
      return result
    }

    const state = {
      contract: 'ambiguous_semantic_recovery',
      failure: {
        hint: failureClass,
        reason_code: cleanMemoryText(this.traceRequest?.recovery?.reason_code || failureClass, 120),
        detail: reasonText,
        provider_finish_reason: cleanMemoryText(this.traceRequest?.last_provider_event?.provider?.finish_reason, 80) || undefined,
        invalid_json: /invalid provider|invalid json|strict json|malformed|parse/i.test(reasonText),
        recovery_attempt: Number.isSafeInteger(this.traceRequest?.recovery?.attempt) ? this.traceRequest.recovery.attempt : 0,
      },
      task: planState
        ? {
            goal_id: sanitizeDurableModelText(planState.goal_id, 100),
            objective: sanitizeDurableModelText(planState.objective, 500),
            active_step: activeIndex === undefined ? undefined : sanitizeDurableModelText(board?.steps?.[activeIndex]?.description, 300),
            completed_count: Number.isSafeInteger(board?.completed_count) ? board.completed_count : 0,
            total_steps: Array.isArray(board?.steps) ? board.steps.length : 0,
            canonical_status: planState.status,
          }
        : null,
      world: {
        task_state: cleanMemoryText(runtime?.task_state, 64),
        queue_length: Number.isSafeInteger(runtime?.queue_length) ? runtime.queue_length : undefined,
        persistent_runtime_healthy: persistentRuntimeHealthy(persistentRuntime),
        condition_wait_active: conditionValidation.healthy === true,
        condition_wait: conditionValidation.healthy ? conditionValidation.wait : undefined,
      },
      evidence: {
        latest_relevant_deterministic_evidence: evidence.map(item => sanitizeDurableModelValue(item)),
        fresh_observation_available: this.freshObservationSinceContinuation === true,
      },
      provider: {
        previous_reasoning_mode: cleanMemoryText(this.traceRequest?.last_provider_event?.provider?.reasoning_effort, 32),
        previous_trigger_source: cleanMemoryText(this.traceRequest?.last_provider_event?.trigger_source, 80),
      },
      decision_budget: {
        observation_remaining: Number.isSafeInteger(this.observationBudgetRemaining) ? this.observationBudgetRemaining : undefined,
        reasoning_budget: cleanMemoryText(this.reasoningBudgetOverride, 32) || undefined,
        planning_horizon: cleanMemoryText(this.planningHorizonOverride, 32) || undefined,
      },
      context: {
        loaded_skill_ids: this.loadedSkillContext instanceof Map ? [...this.loadedSkillContext.keys()].slice(-3) : [],
        dependency_summary: planState?.dependency_context ? sanitizeDurableModelValue(planState.dependency_context) : undefined,
      },
    }

    const questions = recoveryDecisionQuestions()
    const decisionId = `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
    this.recoveryDecisionAbort?.abort()
    const controller = new AbortController()
    this.recoveryDecisionAbort = controller
    const startedAt = Date.now()
    await this.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: 'recovery_route',
      mode: 'active',
      failure_class_hint: failureClass,
      question_ids: Object.keys(questions),
      canonical_step: activeIndex,
    })

    try {
      const response = await this.interactionDecisionProvider(state, questions, {
        epoch: current.epoch,
        actorId: current.actor_id,
        signal: controller.signal,
      })
      if (generation !== this.generation || !this.active || controller.signal.aborted) {
        throw new AgentLoopError('Model turn was cancelled or superseded')
      }
      await this.assertCurrent()
      const decision = parseRecoveryDecision(response)
      const validated = validateRecoveryRoute(decision, {
        world: recoveryWorld,
        observationBudgetAvailable,
        failureClassHint: failureClass,
        userDecisionRequired: false,
      })
      const result = {
        route: validated.route,
        requested_route: validated.requested_route,
        failure_class: decision.failure_class,
        rejection_reason: validated.rejection_reason,
        runtime,
        persistentRuntime,
        conditionWaitHealthy: conditionValidation.healthy === true,
        conditionWait: conditionValidation.wait,
        runtime_state: validated.runtime,
        decision,
        decision_called: true,
      }
      this.lastRecoveryDecisionKey = key
      this.lastRecoveryDecision = result

      await this.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract: 'recovery_route',
        mode: 'active',
        provider: decision.provider,
        model: decision.model,
        failure_class: decision.failure_class,
        semantic_class: decision.semantic_class,
        observation_probability: decision.observation_probability,
        route: decision.route,
        confidence: decision.confidence,
        confidence_policy: decisionConfidencePolicy(decision.route),
        latency_ms: Date.now() - startedAt,
        input_units: Number.isFinite(decision.usage?.input_tokens) ? Math.max(0, Math.trunc(decision.usage.input_tokens)) : 0,
        output_units: Number.isFinite(decision.usage?.output_tokens) ? Math.max(0, Math.trunc(decision.usage.output_tokens)) : 0,
        cost_usd: Number.isFinite(decision.usage?.cost) && decision.usage.cost >= 0 ? decision.usage.cost : 0,
      })
      await this.decisionTraceEvent('decision.route_applied', {
        decision_id: decisionId,
        contract: 'recovery_route',
        mode: 'active',
        requested_route: decision.route,
        applied_route: validated.route,
        fallback_reason: validated.rejection_reason,
      })
      await this.traceEvent('recovery.routed', {
        failure_class: decision.failure_class,
        route: decision.route,
        applied_route: validated.route,
        fallback_reason: validated.rejection_reason,
        confidence: decision.confidence,
        decision_latency_ms: Date.now() - startedAt,
        runtime: validated.runtime,
        decision: {
          provider: decision.provider,
          model: decision.model,
          usage: decision.usage,
        },
      })
      return result
    }
    catch (error) {
      if (generation !== this.generation || controller.signal.aborted) throw new AgentLoopError('Model turn was cancelled or superseded')
      if (conditionValidation.healthy) conditionValidation = await this.validateConditionWaitHealth()
      const message = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
      await this.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: 'recovery_route',
        mode: 'active',
        fallback_target: 'runtime',
        reason: message,
        latency_ms: Date.now() - startedAt,
      })
      await this.traceEvent('recovery.routed', {
        failure_class: failureClass,
        route: 'fallback_runtime',
        applied_route: 'fallback_runtime',
        fallback_reason: message,
        decision_latency_ms: Date.now() - startedAt,
      })
      const result = {
        route: conditionValidation.healthy ? 'wait_runtime' : failureClass === 'provider_budget' ? 'pause_recoverable' : 'fallback_runtime',
        failure_class: failureClass,
        runtime,
        persistentRuntime,
        conditionWaitHealthy: conditionValidation.healthy === true,
        conditionWait: conditionValidation.wait,
        error: message,
        decision_called: true,
      }
      this.lastRecoveryDecisionKey = key
      this.lastRecoveryDecision = result
      return result
    }
    finally {
      if (this.recoveryDecisionAbort === controller) this.recoveryDecisionAbort = null
    }
  }

  async recoverPlan(generation, reason, roundBase) {
    const reasonText = reason instanceof Error ? reason.message : String(reason)
    const recovery = {
      reason: reasonText,
      round_base: roundBase,
      attempt: 0,
    }
    if (this.traceRequest) this.traceRequest.recovery = recovery
    await this.traceEvent('replan.started', recovery)

    const providerBudgetFailure = recoveryFailureClassHint(reasonText) === 'provider_budget'

    const observationDecisionComplete = /(?:single targeted observation allowed|targeted observation budget allowed) by decision pressure is complete/i.test(reasonText)
    const currentState = this.memory.currentPlan?.(this.activePlanKey())
    if (observationDecisionComplete && !this.actionOmissionRepairActive) {
      if (canonicalWorkRemains(currentState)) {
        await this.beginActionOmissionRepair({
          chatMessage: '',
          plan: currentState.plan,
          currentStep: currentState.current_step,
          operations: [],
        }, 'observation_decision_pressure_complete')
      }
      else {
        this.actionOmissionRepairActive = true
      }
      this.actionOmissionObservationUsed = true
      this.actionOmissionForceNoTools = true
    }

    if (observationDecisionComplete) {
      // This is a controlled decision boundary, not a provider/world failure.
      // The observation allowance was intentionally spent; routing it through
      // generic recovery can incorrectly choose pause_recoverable while the
      // planner still owes an act-or-block decision.
      await this.traceEvent('recovery.observation_budget_force_decision', {
        reason_code: 'observation_decision_pressure_complete',
        trigger_source: this.reasoningTriggerSource ?? this.planUpdateReason,
        tools_enabled: false,
        canonical_work_remaining: canonicalWorkRemains(currentState),
      })
      return super.recoverPlan(
        generation,
        new AgentLoopError('The targeted observation budget for this decision is complete. Reuse the grounded evidence already collected and return the required strict-JSON plan decision now; do not request another observation.'),
        roundBase,
      )
    }

    const recoveryState = this.memory.planByNpc?.get?.(this.activePlanKey()) ?? this.memory.currentPlan?.(this.activePlanKey())
    const recoveryBoard = recoveryState?.task_board
    const recoveryActiveIndex = Number.isSafeInteger(recoveryBoard?.active_index) ? recoveryBoard.active_index : undefined
    const recoveryFinalIndex = Array.isArray(recoveryBoard?.steps) ? recoveryBoard.steps.length - 1 : -1
    const deterministicFinalCompletion = latestDeterministicCompletionEvidence(recoveryState)
      && Number.isSafeInteger(recoveryActiveIndex)
      && recoveryActiveIndex === recoveryFinalIndex
    if (deterministicFinalCompletion) {
      const proof = [...(recoveryBoard?.evidence ?? [])].reverse().find(item => item?.kind === 'deterministic_verification')
      const reduced = this.memory.applyOutcomeAuthority?.(this.activePlanKey(), {
        kind: 'verified_complete',
        source: 'deterministic_runtime',
        reason_code: 'recovery_final_completion_proven',
        evidence: proof ? [proof] : [],
      })
      if (reduced?.decision?.accepted) {
        await this.persistState()
        this.active = false
        await this.traceEvent('planner.skipped', {
          source: 'deterministic_runtime',
          contract: 'recovery_route',
          route: 'deterministic_close',
        })
        return {
          chatMessage: 'The requested goal is verified complete.',
          plan: [],
          currentStep: 0,
          operations: [],
          epoch: this.epoch?.epoch,
          actorId: this.epoch?.actor_id,
          goalId: reduced.state?.goal_id,
          goalStatus: 'completed',
          taskBoard: visibleTaskBoard(reduced.state?.task_board),
        }
      }
    }

    let routed
    try {
      routed = await this.routeRecoveryDecision(reason, roundBase)
    }
    catch (error) {
      if (/cancelled|superseded|epoch changed/i.test(String(error?.message ?? error))) throw error
      routed = { route: 'fallback_runtime', error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300) }
    }

    const plannerRecoveryRoutes = ['wake_planner', 'targeted_observation']
    if (providerBudgetFailure
      && this.providerBudgetHandoffCount >= this.maxProviderBudgetHandoffs
      && plannerRecoveryRoutes.includes(routed.route)) {
      const runtimeActive = interactionRuntimeHealthy(routed.runtime)
        || persistentRuntimeHealthy(routed.persistentRuntime)
        || routed.conditionWaitHealthy === true
      routed = {
        ...routed,
        route: runtimeActive ? 'wait_runtime' : 'pause_recoverable',
        rejection_reason: 'provider_budget_handoff_limit_reached',
      }
      await this.traceEvent('budget.handoff_limit_reached', {
        handoff_count: this.providerBudgetHandoffCount,
        handoff_limit: this.maxProviderBudgetHandoffs,
        fallback_route: routed.route,
      })
    }

    if (routed.route === 'wait_runtime') {
      const state = this.memory.currentPlan?.(this.activePlanKey())
      if (providerBudgetFailure) {
        this.memory.setProviderRecovery?.(this.activePlanKey(), undefined)
        await this.persistState()
      }
      await this.traceEvent('planner.skipped', {
        source: routed.source ?? 'decision_provider',
        contract: 'recovery_route',
        route: 'wait_runtime',
      })
      return {
        chatMessage: 'Autorio is still working; no recovery planner call was needed.',
        plan: state?.plan ?? [],
        currentStep: state?.current_step ?? 0,
        operations: [],
        epoch: this.epoch?.epoch,
        actorId: this.epoch?.actor_id,
        goalId: state?.goal_id,
        goalStatus: state?.status,
        taskBoard: visibleTaskBoard(state?.task_board),
        persistentRuntime: routed.persistentRuntime,
      }
    }

    if (routed.route === 'pause_recoverable') {
      if (providerBudgetFailure) this.memory.setProviderRecovery?.(this.activePlanKey(), undefined)
      const reduced = this.memory.applyOutcomeAuthority?.(this.activePlanKey(), {
        kind: 'recoverable_provider_failure',
        source: 'jev',
        reason_code: routed.failure_class || recoveryFailureClassHint(reasonText),
      }, {
        world: {
          ...(routed.runtime ?? {}),
          persistent_runtime: routed.persistentRuntime,
          persistent_runtime_healthy: persistentRuntimeHealthy(routed.persistentRuntime),
          condition_wait_active: routed.conditionWaitHealthy === true,
          condition_wait: routed.conditionWaitHealthy ? routed.conditionWait : undefined,
        },
      })
      if (reduced?.decision?.accepted) {
        await this.persistState()
        this.active = false
        await this.traceEvent('planner.skipped', {
          source: 'decision_provider',
          contract: 'recovery_route',
          route: 'pause_recoverable',
        })
        return {
          chatMessage: 'The provider failure is recoverable; the canonical task was paused without creating a world blocker.',
          plan: reduced.state?.plan ?? [],
          currentStep: reduced.state?.current_step ?? 0,
          operations: [],
          epoch: this.epoch?.epoch,
          actorId: this.epoch?.actor_id,
          goalId: reduced.state?.goal_id,
          goalStatus: reduced.state?.status,
          taskBoard: visibleTaskBoard(reduced.state?.task_board),
        }
      }
    }

    if (routed.route === 'ask_user') {
      const state = this.memory.currentPlan?.(this.activePlanKey())
      this.active = false
      await this.traceEvent('planner.skipped', {
        source: routed.source ?? 'decision_provider',
        contract: 'recovery_route',
        route: 'ask_user',
        reason: 'authoritative_user_boundary',
      })
      return {
        chatMessage: `The current plan is blocked and requires your decision before it can change. ${cleanMemoryText(state?.blocker, 500)}`,
        plan: state?.plan ?? [],
        currentStep: state?.current_step ?? 0,
        operations: [],
        epoch: this.epoch?.epoch,
        actorId: this.epoch?.actor_id,
        goalId: state?.goal_id,
        goalStatus: state?.status,
        taskBoard: visibleTaskBoard(state?.task_board),
      }
    }

    if (providerBudgetFailure && plannerRecoveryRoutes.includes(routed.route)) {
      const semanticScope = 'keep_target'
      const key = this.activePlanKey()
      this.providerBudgetHandoffCount++
      this.providerBudgetGeneration = Math.max(1, this.providerBudgetGeneration) + 1
      this.providerBudgetGenerationOutputUnits = 0
      this.outputBudgetRecoveryGuard = null
      this.outputBudgetRecoveryUsed = false
      this.memory.setProviderRecovery?.(key, {
        kind: 'budget_handoff',
        phase: 'planner_pending',
        goal_id: this.memory.currentPlan?.(key)?.goal_id,
        step_id: this.memory.currentPlan?.(key)?.task_board?.active_step_id,
        semantic_scope: semanticScope,
        route: routed.route,
        reason: reasonText,
        budget_generation: this.providerBudgetGeneration,
        handoff_count: this.providerBudgetHandoffCount,
        started_at: Date.now(),
      })
      await this.persistState()
      await this.traceEvent('budget.generation_started', {
        generation: this.providerBudgetGeneration,
        handoff_count: this.providerBudgetHandoffCount,
        semantic_scope: semanticScope,
        route: routed.route,
      })

      const previousTrigger = this.reasoningTriggerSource
      const previousReasoningBudget = this.reasoningBudgetOverride
      this.reasoningTriggerSource = providerBudgetTriggerSource(semanticScope, routed.route)
      this.reasoningBudgetOverride = null
      const state = this.memory.currentPlan?.(key)
      const capsule = providerBudgetHandoffCapsule(
        state,
        routed.runtime ?? routed.persistentRuntime,
        reasonText,
        semanticScope,
      )
      this.messages = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: capsule },
      ]
      await this.traceEvent('planner.wake', {
        source: 'decision_provider',
        contract: 'provider_budget_handoff',
        route: routed.route,
        semantic_scope: semanticScope,
        budget_generation: this.providerBudgetGeneration,
        reasoning_policy: 'low',
      })
      try {
        let result
        try {
          result = await this.runTurn()
        }
        catch (error) {
          if (terminalProviderBudgetFailure(error) && generation === this.generation && this.active) {
            await this.traceEvent('budget.handoff_reentered', {
              generation: this.providerBudgetGeneration,
              handoff_count: this.providerBudgetHandoffCount,
              next_round_base: roundBase + 1,
              reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 600),
            })
            return await this.recoverPlan(generation, error, roundBase + 1)
          }
          throw error
        }
        this.memory.setProviderRecovery?.(key, undefined)
        await this.persistState()
        await this.traceEvent('budget.handoff_committed', {
          generation: this.providerBudgetGeneration,
          handoff_count: this.providerBudgetHandoffCount,
          semantic_scope: semanticScope,
          route: routed.route,
        })
        return result
      }
      finally {
        this.reasoningTriggerSource = previousTrigger
        this.reasoningBudgetOverride = previousReasoningBudget
      }
    }

    if (plannerRecoveryRoutes.includes(routed.route)) {
      const previousTrigger = this.reasoningTriggerSource
      const previousReasoningBudget = this.reasoningBudgetOverride
      const highRecoveryReasoning = routed.failure_class === 'semantic_replan'
        || routed.failure_class === 'grounded_world_failure'
      this.reasoningTriggerSource = highRecoveryReasoning ? 'recovery_replan_high' : 'recovery_continue_low'
      // Jev chooses the canonical route/failure class; deterministic code maps
      // that bounded classification onto the existing low/high planner budget.
      this.reasoningBudgetOverride = null
      const state = this.memory.currentPlan?.(this.activePlanKey())
      const board = state?.task_board
      const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : state?.current_step ?? 0
      this.messages.push({
        role: 'user',
        content: `[RECOVERY_ROUTE] Jev selected ${routed.route}. Preserve the verified canonical prefix and use only current runtime truth. This route has no completion or blocker authority. Failure: ${cleanMemoryText(reasonText, 1000)}. Active step: ${cleanMemoryText(board?.steps?.[activeIndex]?.description ?? currentPlanStep(state?.plan, activeIndex), 500)}.`,
      })
      await this.traceEvent('planner.wake', {
        source: routed.source ?? 'decision_provider',
        contract: 'recovery_route',
        route: routed.route,
        reasoning_policy: highRecoveryReasoning ? 'high' : 'low',
      })
      try {
        const current = await this.assertCurrent()
        const message = await this.callProvider(current, generation, {
          round: roundBase,
          allowTools: routed.route === 'targeted_observation',
          recoveryAttempt: 0,
        })
        if (message?.tool_calls !== undefined) {
          if (routed.route !== 'targeted_observation') {
            throw new AgentLoopError('compact recovery returned observation tools outside targeted_observation route')
          }
          const prepared = this.prepareToolBatch(message)
          if (prepared.length !== 1) throw new AgentLoopError('targeted observation route permits exactly one observation call')
          await this.handleToolBatch(message, prepared)
          this.actionOmissionObservationUsed = true
          this.actionOmissionForceNoTools = true
          return this.recoverPlan(
            generation,
            new AgentLoopError('The single targeted recovery observation is complete. Reuse that fresh evidence and choose a bounded next recovery route.'),
            roundBase + 1,
          )
        }
        const plan = this.parsePlanMessage(message)
        return await this.commitPlan(plan)
      }
      catch (error) {
        if (/cancelled|superseded|epoch changed/i.test(String(error?.message ?? error))) throw error
        throw new AgentLoopError(`provider_jev_recovery_route_failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      finally {
        this.reasoningTriggerSource = previousTrigger
        this.reasoningBudgetOverride = previousReasoningBudget
      }
    }

    // Deterministic format recovery repairs a reply; it is not planning, so it
    // must not inherit a strategic budget from the turn that failed.
    const previousTrigger = this.reasoningTriggerSource
    const previousReasoningBudget = this.reasoningBudgetOverride
    this.reasoningTriggerSource = 'recovery_continue_low'
    this.reasoningBudgetOverride = null
    this.genericRecoveryDecisionActive = true
    try {
      return await super.recoverPlan(generation, reason, roundBase)
    }
    finally {
      this.genericRecoveryDecisionActive = false
      this.reasoningTriggerSource = previousTrigger
      this.reasoningBudgetOverride = previousReasoningBudget
    }
  }
}
