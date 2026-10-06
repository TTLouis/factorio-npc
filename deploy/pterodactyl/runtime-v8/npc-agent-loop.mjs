import fsp from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

import { AgentLoopError, NpcAgentLoop as BaseNpcAgentLoop, NpcDialogueMemory as BaseNpcDialogueMemory } from '../staging/npc-agent-loop.mjs'
import {
  addTaskBoardEvidence,
  recordTaskBoardTransferSupplyRecovery,
  taskBoardTransferSupplyRecoveries,
  reconcileTaskBoard,
  sanitizeTaskBoard,
  setTaskBoardStatus,
  taskBoardProgress,
} from './common.mjs'
import { AgentContext, contextRestagedRow, conversationChars, STALE_REDRIVE_LIMIT, STALE_REPLY_ERROR_CODE, STALE_REPLY_MESSAGE } from './agent-context.mjs'
import { EXECUTOR_ROLE, PLANNER_ROLE, roleSystemPrompt } from './agent-roles.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { ADMISSION_REFUSAL, ADMISSION_REFUSAL_CODES } from './authorization.mjs'
import { JevCheckpoints } from './jev-checkpoints.mjs'
import { buildVerifiedResults } from './verified-results.mjs'
import { cleanMemoryText, sanitizeDurableModelText, sanitizeDurableModelValue } from './durable-text.mjs'
import { normalizeProviderPlanContent, providerCapabilityProfile } from './provider.mjs'
import { executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { OPERATION_LEDGER_LIMIT } from './operation-ledger.mjs'
import {
  batchWatermark,
  buildPendingOperation,
  EFFECT,
  isLostAcknowledgement,
  PENDING_STATE,
  reconcilePendingOperation,
  reconciliationFacts,
  reconciliationGuidance,
  RECONCILE_VERDICT,
} from './operation-reconciliation.mjs'
import {
  boundarySteeringGate,
  decisionConfidencePolicy,
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  observationRelevanceQuestions,
  observeRouteRelevanceFloor,
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
  PLANNING_EVENT,
  STEERING_BOUNDARY,
  STEERING_PRESSURE_VOCABULARY,
  askableSteeringPressures,
  shelfRefinementCandidates,
  steeringPressureDefinitions,
} from './planning-state.mjs'
import { decideRestage, estimateTokensFromChars, markRequestSliceClosed, requestSliceCeiling, RESTAGE_BOUNDARY } from './restage-policy.mjs'
import { emptyJevHealth, recordJevHealth, recordPendingDecisionRequest, settlePendingDecisionRequest, summarizeJevHealth, takePendingDecisionRequest } from './jev-health.mjs'
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
  approvedOperationListText,
  approvedOperationNames,
  isObservationToolName,
  observationToolFamily,
  observationToolTier,
  isPlannerControlToolName,
  parsePlan as parseRuntimePlan,
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
import { activeStepOf, parseTimeReview, PlanTiming } from './plan-time-estimate.mjs'
import { insertTailBlock } from './prompt-prefix.mjs'
import { ChatAcknowledger } from './responsiveness.mjs'
import { UsageLedger } from './usage-ledger.mjs'
import { checkpointMachineRequirements, checkpointWaitRequirement, compactMachineFacts, conditionEta, conditionWakeCause, freshReadCondition, isWaitOnlyBatch, mostRecentWorkingUnit, safeWaitSchedule, scheduleWait, waitOnlyTicks, WAIT_BASIS, WAIT_FACT_MAX_MACHINES, WAIT_FACT_RADIUS } from './production-wait.mjs'
import {
  combineGroundingWithChallenge,
  ensureGoalRequirements,
  goalRequirementsContext,
  groundFirstPlan,
  injectedRequirementsChars,
  lockedRecipeBlocker,
  describeLockedRecipePreflight,
  REQUIREMENTS_PREFIX,
  refreshGoalRequirementsAtShelfPickup,
  retireGoalRequirements,
} from './goal-requirements.mjs'
import { abortSkillChoice, ensureSkillOffers, injectedSkillChars, refreshSkillOffersAtShelfPickup, SKILL_OFFERS_PREFIX, skillOffersContext, traceSkillLoaded, traceSkillsFollowed } from './skill-offers.mjs'

export { AgentLoopError }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /authorization|api.?key|token|password|secret|cookie|session/i
const STATE_SCHEMA = 1
const PLAN_HISTORY_LIMIT = 24
const MAX_OBSERVATION_TOOL_CALLS_PER_BATCH = 4
const JEV_OBSERVATION_LOG_LIMIT = 12
const PLANNING_LOD_GUIDANCE = '[PLANNING_LOD] Your reply, including all reasoning, has a fixed output budget. Work at outline level. Before any reads, only decide which reads you need. In a plan, write the goal definition (on the first plan), one short line per step (plus Roadmap Shelf nodes for a long_horizon goal), and concrete operations only for the active step. Do not work out later steps\' operations, counts, or positions now; each step is refined when it becomes active.'
// Evidence kinds that let a semantic step completion claim through.
const SEMANTIC_GROUNDING_KINDS = new Set([
  'deterministic_verification',
  'operation_receipt',
  'verified_world_state',
  'condition_satisfied',
  'fresh_world_observation',
])
const DUPLICATE_OBSERVATION_MESSAGE = '[HARNESS] Duplicate observation suppressed. The result is unchanged from the earlier identical tool call already present in this decision context; reuse it and act or report a blocker.'
const OUTPUT_BUDGET_RECOVERY_MESSAGE = '[HARNESS] The immediately preceding provider response exhausted its output budget before emitting content or tool calls. Continue the same logical request and goal from this unchanged harness context. Tools remain available. Do not treat the empty response as an action, plan update, completion, or evidence. Do not replay any world mutation already proven complete by the supplied receipts or canonical Task Board. Return the next necessary observation tool call(s), or use submitPlan for the planner decision. Legacy strict-JSON content remains a compatibility fallback only.'
// The cap covers reasoning tokens too. Live (goal_mueryuql) a reasoning model spent
// 588 of 700 before emitting submitPlan, so the call was cut off mid-JSON
// (finish_reason=length) and the repair failed with no operation. Keep it bounded,
// but leave room for reasoning plus a complete submitPlan argument object.
const ACTION_OMISSION_MAX_TOKENS = 2048
const ACTION_OMISSION_BLOCKER_PREFIX = 'BLOCKED:'
// A shelf node's required field is `intent`. Models answering in plain JSON
// (no tool schema on a closed round) have written `text` or `description`
// instead, and the sanitizer then dropped every node without a word. Map those
// names onto intent; everything else still goes through sanitizeShelfNode.
export function normalizeRoadmapNodes(nodes) {
  return nodes.slice(0, 64).map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node
    if (typeof node.intent === 'string' && node.intent.trim()) return node
    const alias = ['text', 'description', 'title'].find(key => typeof node[key] === 'string' && node[key].trim())
    if (!alias) return node
    const { [alias]: value, ...rest } = node
    return { ...rest, intent: value }
  })
}

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
// MW1: operation-level authorization refusals. A protected, reserved or player-inventory target is something the model can
// route around inside its grant (one retry); a stale grant is not (it ends the request like any other blocker).
const AUTHORIZATION_RECOVERABLE_CODES = new Set(ADMISSION_REFUSAL_CODES.filter(code => code !== ADMISSION_REFUSAL.AUTHORIZATION_STALE))
const AUTHORIZATION_REFUSAL_RETRY_BUDGET = 1
// MW2b: an identical batch refused because an earlier one's effect is not proven absent, and a batch proven not to have reached the game.
const DUPLICATE_EFFECT_CODE = 'duplicate_effect_suppressed'
const DUPLICATE_EFFECT_RETRY_BUDGET = 1
const LOST_ACK_RETRY_BUDGET = 1
// Board evidence kind for an executed operation the engine refused in a way the
// planner can correct (a placement refused at its chosen coordinate). The board
// memory records it instead of freezing the plan and blocks once the bounded
// retries for the step run out.
export const OPERATION_FAILURE_RECOVERABLE_KIND = 'operation_failure_recoverable'
// A transfer the world proved cannot move anything yet (the NPC holds none of the item, the entity holds none to take, or
// the destination accepts none). It is an acquisition dependency inside the same committed step: the plan, checkpoint and
// result are untouched. The per-step counter is persisted on the board (board.transfer_supply_recoveries, survives
// continuation, restart and evidence trimming); evidence of this kind is kept for traceability (written both by the
// preflight path and, for an execution-time item_missing/nothing_moved receipt, by the board memory). The step is blocked through the ordinary path once the budget is spent.
export const TRANSFER_SUPPLY_RECOVERABLE_KIND = 'transfer_supply_recoverable'
export const TRANSFER_SUPPLY_RECOVERY_BUDGET = 2
export const TRANSFER_SUPPLY_PREFLIGHT_CODES = new Set(['supply_missing', 'extraction_empty', 'destination_full'])
const TRANSFER_SUPPLY_CODE_MEANING = {
  supply_missing: 'the NPC inventory holds none of the item',
  extraction_empty: 'the target entity holds none of the item to take',
  destination_full: 'the destination accepts none of the item',
}

// Recoveries already spent on the board's active step (both phases): the monotonic counter persisted on the board,
// not the (trimmed) evidence window.
export function transferSupplyRecoveryCount(board) {
  return taskBoardTransferSupplyRecoveries(board)
}

function parseEvidenceSummary(item) {
  try {
    const parsed = JSON.parse(item?.summary)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  }
  catch { return undefined }
}

// The newest board evidence when it is an execution-phase transfer-supply record (written right after the failure
// receipt it classified), so an older record can never relabel a later, unrelated failure.
function latestTransferSupplyExecutionRecovery(state) {
  const evidence = state?.status === 'active' ? state?.task_board?.evidence : undefined
  const latest = Array.isArray(evidence) ? evidence.at(-1) : undefined
  if (latest?.kind !== TRANSFER_SUPPLY_RECOVERABLE_KIND) return undefined
  const parsed = parseEvidenceSummary(latest)
  return parsed?.phase === 'execution' ? parsed : undefined
}

const SUPPLY_TO_ACTOR_OPERATIONS = new Set(['mine_entity', 'mine_entity_exact', 'recover_corpse'])

// Could an earlier operation of the same batch put `item` into the NPC inventory (supply_missing), give an empty source
// something to take (extraction_empty), or free room at the same destination (destination_full)? When it could, the
// preflight rejection is only a snapshot taken before that operation runs, so the decision is deferred to execution,
// whose own checks stay authoritative. Deliberately lenient and deterministic: it never asserts the supply is enough.
function batchSupplierFor(operations, index, status, item, direction, unitNumber) {
  for (let j = 0; j < index; j++) {
    const op = operations[j]
    const args = op?.args ?? {}
    if (status === 'supply_missing') {
      if (op?.name === 'craft_item' && args.item_name === item) return j
      if ((op?.name === 'gather_resource' || op?.name === 'mine_resource_at') && args.resource_name === item) return j
      if (op?.name === 'harvest_product' && args.product_name === item) return j
      if (SUPPLY_TO_ACTOR_OPERATIONS.has(op?.name)) return j
      if ((op?.name === 'move_items_exact' || op?.name === 'move_items') && args.to_entity === false && args.item_name === item) return j
    }
    else if (status === 'extraction_empty') {
      if (op?.name === 'wait') return j
      if (op?.name === 'move_items_exact' && args.to_entity === true && args.unit_number === unitNumber && args.item_name === item) return j
      if (op?.name === 'supply_entity' && args.unit_number === unitNumber && Array.isArray(args.items) && args.items.some(entry => entry?.item_name === item)) return j
    }
    else if (status === 'destination_full' && direction === 'to_entity') {
      if (op?.name === 'move_items_exact' && args.to_entity === false && args.unit_number === unitNumber) return j
    }
  }
  return undefined
}

// The batch-dependency rule for a transfer preflight rejection: undefined means "reject", otherwise the earlier operations
// that could supply every failing item.
export function transferBatchDependency(operations, index, result) {
  const items = Array.isArray(result?.transfer?.items) ? result.transfer.items : []
  const failing = items.filter(item => TRANSFER_SUPPLY_PREFLIGHT_CODES.has(item?.status))
  if (failing.length === 0) return undefined
  const dependencies = []
  for (const item of failing) {
    const supplier = batchSupplierFor(operations, index, item.status, item.item_name, result.transfer.direction, result.target?.unit_number ?? result.identity)
    if (supplier === undefined) return undefined
    dependencies.push({ item_name: item.item_name, status: item.status, operation_index: supplier, operation: operations[supplier]?.name })
  }
  return dependencies
}

// Bounded facts about a transfer preflight result, for trace rows, board evidence and the model message.
export function transferSupplyFacts(preflight) {
  const items = Array.isArray(preflight?.transfer?.items) ? preflight.transfer.items.slice(0, 8) : []
  return {
    code: preflight?.code,
    operation: preflight?.operation,
    operation_index: preflight?.operation_index,
    direction: preflight?.transfer?.direction,
    target: preflight?.target
      ? { unit_number: preflight.target.unit_number, name: preflight.target.name }
      : (preflight?.identity === undefined ? undefined : { unit_number: preflight.identity }),
    items: items.map(item => ({
      item_name: item?.item_name,
      requested: item?.requested,
      source_count: item?.source_count,
      missing: item?.missing,
      destination_accepts: item?.destination_accepts,
      status: item?.status,
      ...(item?.refusal_cause ? { refusal_cause: item.refusal_cause } : {}),
    })),
  }
}
const RESEARCH_PREFLIGHT_RETRY_BUDGET = 2
// Chained in-turn slice continuations (a claim that closes a slice, whose
// unmet goal plans the next slice inside the same planner turn) allowed per
// run. A model that keeps authoring claim-only slices ends the run visibly
// instead of spending the whole continuation limit.
const MAX_IN_TURN_SLICE_CONTINUATIONS = 3
const LOW_RISK_NAVIGATION_PROJECTION_MAX_CANDIDATES = 8
// Once the system commits a plan, its semantic content is immutable; later batches fulfil it rather than rewriting it.
const FROZEN_PLAN_STATUSES = new Set([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING])
// Decisions whose job is to author or revise a plan; closed-round operation
// calls are never turned into operations of the old plan for these.
const CLOSED_ROUND_AUTHORING_TRIGGERS = new Set(['new_goal', 'amend_current', 'plan_slice_completed', 'post_step_replan', 'recovery_replan_high', 'reanchor_plan'])

// True when the content holds a plan object the normal path would parse
// (bare, fenced, or embedded in prose).
function contentCarriesPlan(content) {
  const text = String(content ?? '').trim()
  if (!text) return false
  const normalized = normalizeProviderPlanContent(text)
  const candidates = [text, normalized]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const own = JSON.parse(candidate)
      if (own && typeof own === 'object' && Array.isArray(own.plan)) return true
    }
    catch {}
  }
  return false
}
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

Within [PLANNING_STATE], Shelf nodes are storage: they record intent and lineage, never operations and never plan steps. Only the node a slice names in roadmapNodeIds is turned into steps, and only by that slice.

Every goal starts with a goal definition. On the FIRST plan of a goal, add goal to submitPlan: {scope, summary, doneWhen}. summary restates in one sentence what the player asked for; the player sees it in game as your understanding. doneWhen lists the game-checkable conditions that together prove the goal is complete, each with exactly these fields and exact Factorio internal names: {"kind":"inventory_count","item_name":"stone-furnace","minimum":1}, {"kind":"items_produced","item_name":"iron-plate","minimum":100}, {"kind":"research_completed","technology":"automation"}, {"kind":"rockets_launched","minimum":1}, {"kind":"space_location_unlocked","name":"vulcanus"}, {"kind":"entity_working","entity_name":"electric-mining-drill","minimum":1}, {"kind":"electric_network_satisfied","entity_name":"electric-mining-drill","minimum":1}, {"kind":"production_rate","item_name":"iron-plate","per_minute":30,"window_minutes":1}. inventory_count is what SGLuna holds when the goal ends, after crafting consumed its ingredients. rockets_launched and items_produced count from when the goal starts (countFrom "goal_start", the default), so "launch a rocket" needs a new launch; use countFrom "save_start" only when the player means the save's lifetime total. A goal to build, power or run something is proven by what is running, never by items produced: "get steam power going and run a drill" is electric_network_satisfied plus entity_working for the drill, not items_produced of a steam engine and a drill, which crafting alone satisfies. entity_working counts entities of that prototype whose game status is working now; electric_network_satisfied counts ones not short of power on a network a real producer (steam engine, solar panel) is powering; the harness reads both a few times over a few seconds. A request to build production of an item ("make 30 iron plates a minute", "set up iron smelting") ends in production_rate: machine output per minute over the last window_minutes (1 or 10), read from the game. What SGLuna mines or crafts by hand never counts, and while SGLuna hand-mines the item, crafts it, or puts anything but fuel into a machine or chest by hand, the window is void, so the line must run on its own for a whole window. Any hand insert other than fuel, even stocking a chest, delays a rate goal by one window, and a machine you hand-fed keeps rate goals void until the input you put in is used up; let inserters and belts feed the line. items_produced is only for a requested quantity. The harness, not you, decides completion: it reads doneWhen from the game at the end of every plan slice, so finishing a plan's steps never completes a goal by itself, and you never need to claim the goal is done. Use scope "finite" only when one plan of at most 30 steps completes the goal; otherwise use "long_horizon" and send the roadmap shelf on that same first plan. Omit goal on later plans of the same goal.

You author the shelf through the optional roadmap field on submitPlan: a short list of coarse nodes, each stating what should eventually be true for the goal and why it matters, shaped {"id":"n1","intent":"...","why_it_matters":"...","depends_on":["n0"]} (intent is required). Write intent as a short label of about six words or fewer, such as "Smelt iron and copper plates" or "Research automation", and put the detail in why_it_matters; the player sees the intents as the roadmap outline. List the nodes in the order you expect to build them. Keep them at that altitude — a node is not a step, carries no operations, and never claims its own progress; the harness derives realization from verified results and strips anything executable. For a long-horizon goal, send the shelf on the first plan of that goal. Afterwards it only moves when verified world state has actually invalidated the guidance, so restate the nodes that still apply with their original ids (omitting a node marks it invalidated and keeps its lineage), and do not re-send an unchanged shelf just to restate a preference.

When a draft intentionally refines one or more existing Shelf nodes, add roadmapNodeIds beside plan/currentStep/operations and choose stable ids from [PLANNING_STATE].steering.refinement_candidates or the current shelf. On the first long-horizon submission you may create the shelf with roadmap and select ids from those same nodes in roadmapNodeIds. This is lineage, not execution authority; never invent an id for a node that is not on the admitted shelf. When the goal has a shelf, a plan slice holds only the steps for the node it names in roadmapNodeIds, normally the next one: its steps end when that node's intent is true. Work that belongs to a later node stays on the shelf and gets its own slice later; the harness asks for that slice when this one completes and the goal is not yet met. Do not restate the whole roadmap as steps. On the first long-horizon submission, send the shelf in roadmap, plan only its first node, and name that node in roadmapNodeIds.

For a bounded planning slice, add developmentMode as vertical, horizontal, maintain, or recover to describe the dominant direction YOU authored relative to the current critical path. Follow [PLANNING_STATE].steering when it remains appropriate, but this field describes the draft rather than granting steering authority. Small measured supporting work does not require a second mode; substantial mixed-direction work should be split at a better checkpoint.

For the active Plan Tracker step, you may add one optional root field named checkpoint beside chatMessage/plan/currentStep/operations. checkpoint is your semantic completion proposal for deterministic runtime validation and verification, not a claim that the step is already done. It must use a runtime-supported contract: {"mode":"all|any","requirements":[...]} with requirement kinds inventory_count, entity_inventory_count, entity_exists, entity_state, authoritative_operation_receipt, or runtime_controller_state. Prefer world-state outcomes over action occurrence. Example: if the step means "have 100 stone" and the next operation only gathers 40 more because 62 are already held, checkpoint must say inventory_count stone >= 100, not >= 40. The operation batch describes what to do next; checkpoint describes what would prove the semantic step complete. Runtime remains completion authority for supported deterministic contracts. Omit checkpoint when no safe deterministic predicate represents the step; prose-only semantic steps remain the Main LLM's responsibility rather than being delegated to a second AI judge.

For a prose-only active step that intentionally has no deterministic checkpoint, you may explicitly close that semantic step with semanticCompletion: {"stepId":"<exact active step id>","rationale":"..."}. Use the stable active step id from [PLANNING_STATE]. The harness accepts this only when the id is still current, the step has no deterministic completion contract, and recent authoritative runtime evidence or a fresh live observation grounds your judgment. Never use semanticCompletion to bypass an unmet deterministic checkpoint. You may pair a valid semanticCompletion with operations for the newly-active next step; the harness advances the semantic step first, then validates those operations normally. Keeping the same plan and moving currentStep exactly one step forward with operations for that next step is read as the same claim for the active step, under the same checks.

Write chatMessage and plan steps in the language of the player's most recent chat message (default English). Harness messages, tool results, memory and skill text do not change the reply language.

Plan entries must represent goal-bearing Factorio work or verification. Do not add terminal lifecycle/meta steps such as "Stop", "Done", "Finish", or "Report completion"; stopping after the verified goal is represented by returning plan: [], currentStep: 0, operations: [].

An empty operations array normally means no new Autorio world action will happen after your reply. Never claim that a finite action is continuing when neither a new operation nor a live persistent runtime mode exists. Persistent controllers such as follow are different: if a read-only status tool proves the controller is active, healthy, and live, operations: [] may accurately describe that background mode without submitting a duplicate operation. When the whole requested goal is actually verified complete, return plan: [], currentStep: 0, operations: [], and say it is complete.

To wait for a furnace or assembler, do not guess wait ticks: when you start it, give the step a checkpoint on that machine's output (entity_inventory_count); once an observation shows it working, return operations: []. The harness keeps you asleep until the checkpoint holds and wakes you if the machine stops or overruns the finish it derives from the recipe time and the machine's live crafting speed.

When finite canonical work remains but execution is truthfully impossible, keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or blocker. This is the explicit no-mutation blocker contract. Future-tense prose such as "I will take the items" is not a blocker and does not authorize the harness to invent an operation.

Before a non-empty operation batch, chatMessage should tell the human what concrete current plan step SGLuna is about to attempt. Do not say mining, construction, transfer, crafting, or any other mutation has started unless that mutation is in the admitted/running operation batch or authoritative runtime evidence proves it. Navigation completion proves arrival only; it never proves that a later mining or construction action started. [MOD] completion/error messages may include a detailed getTaskStatus snapshot. Use that receipt plus any needed read-only verification to advance, replan, complete, or report a blocker.

The harness may add a [REQUIREMENTS] block while you author or revise a plan, and may send it once as a correction right after your first plan. It is authoritative live game data read from the running game: which recipes and machines needed for the goal's targets are still locked, which technology unlocks each, and the dependency-ordered research with each node's exact kind (lab science, or a trigger completed by performing its exact trigger). Your roadmap and plan must order the unlocking research before any node or step that needs a locked recipe or machine; never plan to craft or build something the block lists as locked before that research is done. It supplies facts only: you still write the goal, shelf and plan.

Skill lifecycle is explicit. findSkills is discovery only: a search result is not a loaded skill and must not be relied on as the full pattern. Before following a discovered skill, call getSkillDetails for that exact id. A [SKILL_CONTEXT] message contains only skills explicitly opened with getSkillDetails for the current logical task. Reuse their structure and constraints, but revalidate mutable world state, recipes, inventory, geometry, and placement with live deterministic tools before acting.

### Complete operation list

Every operation you may emit, with its argument keys ("?" marks an optional key). The operation prose earlier in this prompt may omit some of them; any name not on this list is rejected. place_candidate takes ids from getPlacementCandidates, execute_construction_plan takes the validation_id from validateConstructionPlan, and launch_rocket needs a live rocket-silo unit_number.
${approvedOperationListText()}.
`.trim()

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
    ...safeWaitSchedule(value),
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
  const eta = observation?.ok === true ? conditionEta(observation) : undefined
  return observation?.ok === true
    ? {
        satisfied: observation.satisfied === true,
        progressing: observation.progressing === true,
        progress_known: observation.progress_known === true,
        ...(eta ? { eta } : {}),
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
    placed_last_user: typeof result.placed_last_user === 'string' ? cleanMemoryText(result.placed_last_user, 80) : undefined,
    placement_footprint: result.placement_footprint && typeof result.placement_footprint === 'object'
      ? sanitizeDurableModelValue(result.placement_footprint)
      : undefined,
    placement_grid: result.placement_grid && typeof result.placement_grid === 'object'
      ? sanitizeDurableModelValue(result.placement_grid)
      : undefined,
    placement_blockers: Array.isArray(result.placement_blockers)
      ? sanitizeDurableModelValue(result.placement_blockers.slice(0, 8))
      : undefined,
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

  // The goal id comes from the planning reducer (GOAL_ACCEPTED) through
  // `resolveGoalId`, which the canonical memory facade always supplies. The
  // local mint below is only the standalone-base fallback: it is reached when
  // no facade is in front of this class, or when the reducer refused the goal
  // (an empty objective). It must never be the id source under the facade.
  newGoalId(resolveGoalId, now) {
    const resolved = typeof resolveGoalId === 'function' ? resolveGoalId() : undefined
    return typeof resolved === 'string' && resolved ? resolved : `goal_${now.toString(36)}`
  }

  // Run-state write hooks. Every legacy write of pause_reason, condition_wait,
  // provider_recovery and persistent_runtime goes through these three, so the
  // canonical memory facade can make the planning reducer the writer
  // (RUN_PAUSED / RUN_RESUMED / *_RECORDED) and leave the legacy field as a
  // mirror of the reducer result. The base implementations are the standalone
  // behaviour: write the legacy field directly.
  writeRunField(_key, state, field, value) {
    state[field] = value
  }

  recordRunPause(_key, state, reason) {
    state.pause_reason = reason
    state.persistent_runtime = undefined
    state.condition_wait = undefined
  }

  recordRunResume(_key, state, _reason) {
    state.pause_reason = ''
  }

  // Locators recorded by recordPlan. The state literal already carries the
  // legacy values, so the base hook is a no-op; the canonical facade routes them
  // through the reducer (LOCATORS_RECORDED) and mirrors the result back.
  // `previousExactTargetAudit` is the audit before this call, `exactTargetAudit`
  // only the entries this call adds.
  recordLocators(_key, _state, _locators) {}

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
        lines.push(`[SGLUNA] ${sanitizeDurableModelText(turn.assistant, this.maxFieldChars)}`)
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
      this.writeRunField(key, state, 'provider_recovery', undefined)
    }
    else {
      this.writeRunField(key, state, 'provider_recovery', safeProviderRecovery({
        ...recovery,
        kind: recovery.kind === 'budget_handoff' ? 'budget_handoff' : 'output_budget_exhaustion',
        phase: recovery.kind === 'budget_handoff' ? 'planner_pending' : 'in_flight',
        goal_id: recovery.goal_id ?? state.goal_id,
        step_id: recovery.step_id ?? state.task_board?.active_step_id,
        started_at: Number.isFinite(recovery.started_at) ? recovery.started_at : Date.now(),
      }))
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
      if (!duplicate) board = this.appendBoardEvidence(key, state, board, { ...item, now: Number.isFinite(item.now) ? item.now : now })
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
      this.recordRunResume(key, state, 'blocked')
      this.writeRunField(key, state, 'persistent_runtime', undefined)
      this.writeRunField(key, state, 'condition_wait', undefined)
      board = setTaskBoardStatus(board, 'blocked', { blocker: state.blocker, now })
    }
    else if (decision.durable_status === 'paused') {
      state.status = 'paused'
      state.blocker = ''
      this.recordRunPause(key, state, cleanMemoryText(decision.pause_reason || decision.reason_code, 300))
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
        this.recordRunResume(key, state, 'step_advanced')
        this.writeRunField(key, state, 'condition_wait', undefined)
        state.plan = board.steps.map(step => step.description)
        state.current_step = board.active_index
      }
      else {
        state.status = 'completed'
        state.admission_status = undefined
        state.blocker = ''
        this.recordRunResume(key, state, 'completed')
        this.writeRunField(key, state, 'persistent_runtime', undefined)
        this.writeRunField(key, state, 'condition_wait', undefined)
        board = setTaskBoardStatus(board, 'completed', { now })
        state.plan = []
        state.current_step = 0
      }
    }
    else if (decision.durable_status === 'active' && state.status === 'active') {
      state.blocker = ''
      this.recordRunResume(key, state, 'active')
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
    this.writeRunField(key, state, 'condition_wait', safe)
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  updateConditionWait(key, wait) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !wait || state.condition_wait?.id !== wait.id) return undefined
    if (wait.state === 'active') this.writeRunField(key, state, 'condition_wait', safeConditionWait(wait))
    else this.writeRunField(key, state, 'condition_wait', undefined)
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  clearConditionWait(key, id) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !state.condition_wait || (id && state.condition_wait.id !== id)) return state
    this.writeRunField(key, state, 'condition_wait', undefined)
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  recordPlan(key, requestInfo, plan, { continuation = false, persistentRuntime, durableOperations = [], exactTargetAudit = [], verifiedCompletion = false, completionEvidence = [], resolveGoalId } = {}) {
    const previous = this.planByNpc.get(key)
    const hasOperations = plan.operations.length > 0
    const incomingDurableOperations = (Array.isArray(durableOperations) ? durableOperations : []).slice(0, 16).map(operation => sanitizeDurableModelValue(operation))
    const previousExactTargetAudit = Array.isArray(previous?.exact_target_audit) ? previous.exact_target_audit : []
    const incomingExactTargetAudit = Array.isArray(exactTargetAudit) ? exactTargetAudit : []
    const mergedExactTargetAudit = [...previousExactTargetAudit, ...incomingExactTargetAudit].slice(-32)
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
        goal_id: previous?.goal_id ?? this.newGoalId(resolveGoalId, now),
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
      this.recordLocators(key, state, {
        durableOperations: incomingDurableOperations,
        exactTargetAudit: incomingExactTargetAudit,
        previousExactTargetAudit: previousExactTargetAudit,
      })
      // A batch of operations resumes a paused run, drops any condition wait
      // and any provider recovery (both were for the previous request).
      this.recordRunResume(key, state, 'plan_recorded')
      this.writeRunField(key, state, 'condition_wait', undefined)
      this.writeRunField(key, state, 'provider_recovery', undefined)
      return { state, blockedByHarness: false, changed: true }
    }

    if (runtimeHealthy && incomingPlan.length > 0) {
      const state = {
        ...(previous ?? {}),
        goal_id: previous?.goal_id ?? this.newGoalId(resolveGoalId, now),
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
      this.recordLocators(key, state, {
        durableOperations: [],
        exactTargetAudit: incomingExactTargetAudit,
        previousExactTargetAudit: previousExactTargetAudit,
      })
      this.recordRunResume(key, state, 'plan_recorded')
      this.writeRunField(key, state, 'persistent_runtime', runtime)
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
    this.recordLocators(key, state, {
      durableOperations: [],
      exactTargetAudit: incomingExactTargetAudit,
      previousExactTargetAudit: previousExactTargetAudit,
    })

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

  // The one place a board evidence item is written. The canonical facade
  // overrides it to record the receipt in the reducer ledger first and mirror
  // the result here (3.3 move 2).
  appendBoardEvidence(_key, _state, board, item) {
    return addTaskBoardEvidence(board, item)
  }

  // Spend one transfer-supply recovery on the active step (monotonic, persisted with the board).
  noteTransferSupplyRecovery(key, ref) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const board = this.ensureTaskBoard(state)
    state.task_board = recordTaskBoardTransferSupplyRecovery(board, { ref, now: Date.now() })
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state.task_board
  }

  recordBoardEvidence(key, evidence) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const board = this.ensureTaskBoard(state)
    state.task_board = this.appendBoardEvidence(key, state, board, { ...evidence, now: Number.isFinite(evidence?.now) ? evidence.now : Date.now() })
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

  beginActionOmissionRecovery(key, requestInfo, plan, { resolveGoalId } = {}) {
    const previous = key ? this.planByNpc.get(key) : undefined
    const now = Date.now()
    if (!previous) {
      const incomingPlan = safePlan(plan?.plan)
      if (incomingPlan.length === 0) return undefined
      const incomingStep = 0
      const state = {
        goal_id: this.newGoalId(resolveGoalId, now),
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
    this.recordRunResume(key, previous, 'action_omission_repair')
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

// Chat-completions providers require every assistant `tool_calls` message to be
// followed directly by one tool reply per call id; DeepSeek answers anything
// else with HTTP 400, which pauses the goal. Returns the first violation.
export function toolReplySequenceViolation(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue
    const pending = new Set(message.tool_calls.map(call => call?.id))
    let next = index + 1
    while (next < messages.length && messages[next]?.role === 'tool') {
      pending.delete(messages[next].tool_call_id)
      next++
    }
    if (pending.size > 0) {
      return { index, unanswered: [...pending], next_role: messages[next]?.role }
    }
  }
  return undefined
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

// A provider response with no output usage still spent output. Charge the
// output cap that call requested, so the per-step cap and the request ceiling
// keep counting (1.5 review). Input stays unknown and the call stays marked
// usage-incomplete.
function estimatedOutputUsage(usage, metadata) {
  if (Number.isSafeInteger(usage?.output_units)) return usage
  const requested = metadata?.requested_output_cap
  if (!Number.isSafeInteger(requested) || requested <= 0) return usage
  return {
    ...(usage ?? {}),
    output_units: requested,
    output_units_estimated: true,
    usage_complete: false,
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
// 2.9: a compaction that starts (the working context passed its ceiling) folds
// older tool exchanges until the context is under this share of the ceiling.
const COMPACTION_LOW_WATERMARK = 0.75

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

// The recoverable record the board memory adds right after the failure receipt
// it classified; only the newest evidence item counts, so an older record can
// never relabel a later, unrelated failure.
function latestRecoverableOperationFailure(state) {
  const evidence = state?.status === 'active' ? state?.task_board?.evidence : undefined
  const latest = Array.isArray(evidence) ? evidence.at(-1) : undefined
  if (latest?.kind !== OPERATION_FAILURE_RECOVERABLE_KIND) return undefined
  try {
    const parsed = JSON.parse(latest.summary)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return {
      failure_class: cleanMemoryText(parsed.failure_class, 100),
      code: typeof parsed.code === 'string' ? parsed.code : 'operation_failed',
      entity_name: typeof parsed.entity_name === 'string' ? parsed.entity_name : undefined,
      attempt: Number.isSafeInteger(parsed.attempt) ? parsed.attempt : undefined,
      retry_budget: Number.isSafeInteger(parsed.retry_budget) ? parsed.retry_budget : undefined,
    }
  }
  catch { return undefined }
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
  if (typeof process.env.SGLUNA_NPC_STATE_FILE === 'string' && process.env.SGLUNA_NPC_STATE_FILE.trim()) return path.resolve(process.env.SGLUNA_NPC_STATE_FILE)
  if (process.env.NODE_TEST_CONTEXT) return null
  return path.join(path.resolve(process.env.CONTAINER_ROOT || '/home/container'), '.sgluna', 'npc-state.json')
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

export function planProgress(plan, stateResult) {
  const progress = taskBoardProgress(stateResult?.state?.task_board)
  if (stateResult?.blockedByHarness || stateResult?.state?.status === 'blocked') {
    const modelLine = cleanMemoryText(plan?.chatMessage, 600)
    // The model already told the player: keep its words, tagged, and add no
    // second explanation. Only an empty reply gets the harness explanation.
    if (modelLine) return `[Plan blocked] ${modelLine}`
    const reason = cleanMemoryText(stateResult?.state?.blocker, 200).replace(/[_:]+/g, ' ').trim()
    const because = reason ? ` because of: ${reason}` : ''
    return `[Plan blocked] ${progress?.step || 'Remaining work'} cannot continue${because}. Nothing was started, and continuing unchanged would hit the same blocker. Choose Revise or Cancel in the Task Board, or say in chat what to change (for example a different route or target).`
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
  return message?._sglunaProvider?.output_budget_exhausted === true
    || message?._sglunaProvider?.diagnostic_code === 'provider_output_budget_exhausted'
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

function providerBudgetStepMark(state) {
  const board = state?.task_board
  if (!Number.isSafeInteger(board?.completed_count)) return null
  return { goal_id: String(state?.goal_id ?? board?.goal_id ?? ''), completed_count: board.completed_count }
}

function terminalProviderBudgetCode(value) {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return /provider_context_window_exceeded|provider_output_budget_recovery_(?:exhausted|budget_unavailable)|provider_turn_output_cap_exceeded/i.exec(message)?.[0]?.toLowerCase()
    ?? 'provider_budget'
}

// Provider conditions that clear by waiting. The supervisor pauses these and
// resumes automatically, so the loop leaves them to it (same set as
// supervisor.mjs transientProviderFailure).
const TRANSIENT_PROVIDER_FAILURE = /Hourly provider request budget reached|\bHTTP 429\b|\bHTTP 5\d\d\b|Provider timed out|\btimed out after \d+ ?ms|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i

// The pause-reason code for a provider failure that ends a request. The codes
// match the supervisor's stranded-plan pause, so the in-game board shows the
// same summary for them.
function providerFailurePauseCause(message) {
  const text = String(message ?? '')
  if (!/provider/i.test(text) || /cancelled|superseded|epoch changed/i.test(text)) return undefined
  const budget = /provider_context_window_exceeded|provider_output_budget|finish=length/i.test(text)
  if (!budget && TRANSIENT_PROVIDER_FAILURE.test(text)) return undefined
  if (/provider_output_budget_exhausted|finish=length|output budget/i.test(text)) return 'provider_output_budget_exhausted'
  if (/^Provider response recovery exhausted after \d+ attempts/i.test(text)) return 'provider_recovery_exhausted'
  if (/provider_action_omission_repair_failed/i.test(text)) return 'provider_action_omission_repair_failed'
  if (/provider_semantic_alignment_failed/i.test(text)) return 'provider_semantic_alignment_failed'
  return 'request_failed'
}

const PROVIDER_PAUSE_TEXT = {
  provider_output_budget_exhausted: 'the model ran out of its response budget before giving a usable answer',
  provider_recovery_exhausted: 'I could not get a usable model response after retrying',
  provider_action_omission_repair_failed: 'the model kept planning without starting the next action',
  provider_semantic_alignment_failed: 'the model proposed work that did not match the current step',
  request_failed: 'the model request failed',
}

export const RESUME_HINT = 'Press Resume or say continue to retry from the verified task state.'
// The words that mean "go on with what you were doing" (English and Chinese). One list: the
// supervisor's navigation policy and the Resume re-drive of a goal with no plan both read it.
export const CONTINUATION_WORDS = Object.freeze(['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做'])
export function isBareContinuation(text) {
  const normalized = String(text ?? '').trim().toLocaleLowerCase().replace(/[\s.!?,，。！？、~]+$/u, '')
  return CONTINUATION_WORDS.includes(normalized)
}
// Pause reason of an active goal a restart found with no plan at all (never past its first plan).
export const RESTART_BEFORE_FIRST_PLAN_PAUSE = 'runtime_restart_before_first_plan'

// Triggers whose requests continue an active committed plan instead of
// authoring or revising one; only their tools-on rounds may be `gather` (1.3).
const CONTINUATION_TRIGGERS = new Set([
  'completion',
  'continue_current',
  'post_step_continue',
  'post_step_observe',
  'post_step_reanchor',
  'recovery_continue_low',
])

// A request's total output across budget generations may not exceed this many
// per-turn caps (1.5 review): the per-step roll bounds each step, this bounds
// the request. Before per-step rolls a request was bounded by about 5 caps.
const REQUEST_OUTPUT_CEILING_CAPS = 5

// Pause-reason prefix of a budget pause (matches the supervisor's board
// summary for an exhausted response budget).
const BUDGET_PAUSE_PREFIX = 'provider_output_budget_exhausted'


function isRequestOutputCeiling(value) {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return value?.code === 'request_output_ceiling' || /request_output_ceiling/.test(message)
}

const RECOVERABLE_PLANNER_FAILURE = /provider_action_omission_repair_failed|provider_output_budget_exhausted|provider_jev_recovery_route_failed|Provider strict recovery could not safely resolve remaining canonical work/i

function idleRuntimeStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status) || status.status_error) return false
  if (!Number.isSafeInteger(status.queue_length) || typeof status.task_state !== 'string') return false
  return status.queue_length === 0 && status.task_state.trim().toLowerCase() === 'idle'
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

// A plan that keeps the active and next step and moves currentStep exactly one
// step past the active step, with operations for that step, implies a semantic
// completion claim for the active step.
function impliedSemanticCompletion(plan, state) {
  const board = state?.task_board
  if (state?.status !== 'active' || !Array.isArray(board?.steps)) return undefined
  if (!Array.isArray(plan?.operations) || plan.operations.length === 0) return undefined
  const activeIndex = Number.isSafeInteger(board.active_index) ? board.active_index : -1
  const step = board.steps[activeIndex]
  if (!step || plan.currentStep !== activeIndex + 1 || activeIndex + 1 >= board.steps.length) return undefined
  // Later steps are proposals the committed plan ignores, and the planner
  // often rewords them; only the active and next step must be unchanged.
  const sameSteps = Array.isArray(plan.plan)
    && [activeIndex, activeIndex + 1].every(index =>
      cleanMemoryText(plan.plan[index], 500) === cleanMemoryText(board.steps[index]?.description, 500))
  if (!sameSteps) return undefined
  return {
    stepId: step.id,
    rationale: `Implied by moving currentStep to step ${activeIndex + 2} with its operations.`,
  }
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

// FALLBACK ONLY (U8). The budget handoff (checkpoint C5) restages from a handoff
// packet (restageInTurn with budgetHandoffPacketArgs). This capsule is used only when that restage is
// refused (no admitted reducer goal, the reducer rejected the event), so the
// fresh generation is never left on the exhausted thread. It is traced as
// budget.handoff_restage_fallback.
function providerBudgetHandoffCapsule(state, runtimeStatus, reason, semanticScope = 'keep_target', { admittedGoal, request } = {}) {
  const board = state?.task_board
  const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : state?.current_step ?? 0
  // The capsule replaces the whole conversation. On the first turn of a new
  // goal no plan is stored yet, so without the admitted goal and the player's
  // request the fresh generation would not know what it was asked to do.
  const goal = state
    ? {
        goal_id: sanitizeDurableModelText(state.goal_id, 100),
        objective: sanitizeDurableModelText(state.objective, 1000),
        status: state.status,
      }
    : admittedGoal
      ? {
          goal_id: sanitizeDurableModelText(admittedGoal.goal_id, 100),
          objective: sanitizeDurableModelText(admittedGoal.objective, 1000),
          status: admittedGoal.status,
          first_plan_of_goal: true,
        }
      : null
  const capsule = {
    goal,
    ...(!state && request?.text
      ? { player_request: { sender: cleanMemoryText(request.sender, 128), text: cleanMemoryText(request.text, 4000) } }
      : {}),
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

// Closed (completed) steps of a reducer plan: the step-close detector of the executor's
// hard-limit restage.
function completedStepCount(plan) {
  const progress = plan?.execution?.step_progress ?? {}
  return (Array.isArray(plan?.steps) ? plan.steps : []).filter(step => progress[step.step_id]?.status === 'completed').length
}

function normalizedStepText(value) {
  return cleanMemoryText(value, 500).replace(/\s+/g, ' ').trim().toLowerCase()
}

// Does an executor's restated step list change the committed one? 'unchanged' when it is
// the whole list or a contiguous run of it (a restated remaining suffix); 'order_changed'
// when every step is a committed step but the order differs; otherwise 'steps_changed'.
// A run that starts before the active step and does not cover the whole list (a completed prefix)
// is not one: it would put the advisory focus on a closed step.
export function restatedPlanVerdict(incoming, committed, activeIndex = 0) {
  if (incoming.length <= committed.length) {
    for (let start = 0; start + incoming.length <= committed.length; start++) {
      if (!incoming.every((step, offset) => committed[start + offset] === step)) continue
      const whole = start === 0 && incoming.length === committed.length
      if (whole || start >= activeIndex) return 'unchanged'
    }
  }
  const positions = incoming.map(step => committed.indexOf(step))
  const reordered = positions.some((position, index) => index > 0 && position < positions[index - 1])
  if (positions.every(position => position >= 0) && new Set(positions).size === positions.length && reordered) return 'order_changed'
  return 'steps_changed'
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
    this.maxProviderOutputUnits = Number.isSafeInteger(options.maxProviderOutputUnits) ? options.maxProviderOutputUnits : 100000
    if (this.maxProviderOutputUnits < 1000 || this.maxProviderOutputUnits > 200000) {
      throw new AgentLoopError('maxProviderOutputUnits must be an integer from 1000 to 200000')
    }
    this.maxProviderBudgetHandoffs = Number.isSafeInteger(options.maxProviderBudgetHandoffs) ? options.maxProviderBudgetHandoffs : 4
    if (this.maxProviderBudgetHandoffs < 1 || this.maxProviderBudgetHandoffs > 16) {
      throw new AgentLoopError('maxProviderBudgetHandoffs must be an integer from 1 to 16')
    }
    // Compaction ceiling (1.9 hook). Explicit maxWorking* options win; else a
    // provider profile that declares a context window scales the ceiling
    // (the local profile declares 65,536); else today's fixed defaults.
    this.explicitWorkingCeiling = options.maxWorkingMessages !== undefined || options.maxWorkingChars !== undefined
    this.defaultWorkingCeiling = { messages: this.maxWorkingMessages, chars: this.maxWorkingChars }
    this.workingCeiling = { ...this.defaultWorkingCeiling, source: this.explicitWorkingCeiling ? 'explicit_option' : 'default', context_window: undefined }
    this.workingCeilingTracedFor = null
    let profileWindow
    if (options.providerConfig && typeof options.providerConfig === 'object') {
      try { profileWindow = providerCapabilityProfile(options.providerConfig).context_window }
      catch { profileWindow = undefined }
    }
    this.applyContextWindowCeiling(profileWindow, 'provider_profile')
    this.interactionProvider = typeof options.interactionProvider === 'function' ? options.interactionProvider : null
    this.interactionDecisionProvider = this.recordedDecisionProvider(options.interactionDecisionProvider)
    this.steeringDecisionProvider = this.recordedDecisionProvider(options.steeringDecisionProvider)
    this.operationProjectionDecisionProvider = this.recordedDecisionProvider(options.operationProjectionDecisionProvider)
    this.skillDecisionProvider = this.recordedDecisionProvider(options.skillDecisionProvider) // 2.8: skill-offers.mjs
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
    // How running goal checks are sampled ({samples, intervalMs, sleep});
    // tests inject a sleep, production uses the goal-definition.mjs defaults.
    this.goalSampling = options.goalSampling && typeof options.goalSampling === 'object' ? options.goalSampling : undefined
    this.goalDefinitionRetries = 0
    this.lastGoalDefinitionError = null
    this.goalDefinitionBlock = null
    // Jev's blind reading of the current new goal (see goal-reading.mjs).
    this.goalReading = null
    this.pendingGoalReadingTrace = null
    // Live requirements for the goal's targets (goal-requirements.mjs): the authoring block, and whether the
    // one first-plan grounding round was already asked for this goal.
    this.goalRequirements = null
    this.requirementsGroundingAsked = false
    this.requirementsSequence = 0
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
    // The goal and completed-step count the current budget generation started
    // at; a step close past it rolls the generation (1.5).
    this.providerBudgetStepMark = null
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
    // 2.6: harness time estimates, the time review and the request time split.
    this.planTiming = new PlanTiming()
    // 2.7: usage per goal and the goal budget warning.
    this.usageLedger = new UsageLedger({ outputCap: this.maxProviderOutputUnits })
    // U11: Jev at the delegation checkpoints (jev-checkpoints.mjs). Every family starts in shadow and is promoted or
    // demoted from its scored judgments; there is no setting. `jevCheckpoints: false` is a construction option for the
    // tests that compare a run with and without these judgments (never an env setting).
    this.jev = new JevCheckpoints(this, { enabled: options.jevCheckpoints !== false })
    this.chatAcknowledger = new ChatAcknowledger() // 2.10
    this.agentContext.config = options.agentRoleConfig ?? options.providerConfig // names the role's model only (agent-roles.mjs)
    // U6: a committed plan slice is executed by a fresh executor conversation (C3). On by default
    // and in production; `executorHandoff: false` is a construction option for the tests of the
    // older seams (U4-U8), which exercise one conversation in isolation. It is not an env setting.
    this.executorHandoffEnabled = options.executorHandoff !== false
    this.restageSoftLimitOption = options.restageSoftLimitTokens // U7: a number, or { planner, executor }; default is prefix-aware (restageSoftLimitTokens)
    this.providerCallsInFlight = 0 // provider rounds between request start and the end of their reply processing
    this.providerCallsByGeneration = new Map() // the same count per loop generation: restageContext refuses only while a round of the CURRENT generation is in flight
    this.turnScope = new AsyncLocalStorage() // the running turn identity (lineage, generation, request id): every admission point of that turn judges staleness against it
    this.turnConversation = null // attribution of the conversation the running turn last read; null between turns
    // MW1: authorization events raised inside the memory facade (grant checks, replacement decisions, protected and
    // reserved refusals) become behavior-trace rows carrying their request_id.
    if (this.memory && 'traceSink' in this.memory) {
      this.memory.traceSink = (name, payload) => {
        Promise.resolve(this.traceEvent(name, payload, { requestId: payload?.request_id })).catch(() => {})
      }
    }
  }

  // Delegation U4 (agent-context.mjs): the running conversation lives in one
  // AgentContext, so a restage swaps exactly one thing. Created lazily because
  // the base constructor assigns `messages` (via reset) before this class runs.
  get agentContext() { return this._agentContext ??= new AgentContext() }
  get messages() { return this.agentContext.messages }
  set messages(value) { this.agentContext.messages = value }
  get baseMessages() { return this.agentContext.baseMessages }
  set baseMessages(value) { this.agentContext.baseMessages = value }

  reset() {
    this.turnConversation = null
    this.executorStepMark = null
    if (this.pendingInteractionAmendment) this.dropPendingAmendment('reset_discarded_the_conversation_holding_the_text') // its staged text lived in the conversation this reset discards
    this.pendingInteractionAmendment = null
    this.pendingAmendmentConversationSeq = undefined
    this.agentContext.beginLineage() // planner role: an executor role never leaks into the next chat
    super.reset()
  }

  // The running turn's token for restageContext({ safePoint }); null between turns.
  get turnToken() { return this.turnConversation }

  // The restage seam (U4). Swaps the running conversation for a fresh one built
  // from a handoff packet (handoff-packet.mjs), records CONTEXT_RESTAGED in the
  // reducer and writes the `context.restaged` trace row. Nothing calls this
  // yet: U5-U8 wire the checkpoints. It never changes plan semantics.
  //
  // Restage is SEQUENTIAL. It refuses (typed result + `context.restage_refused`)
  // while a provider round is in flight, and while a turn holds the current
  // conversation (`turnConversation`: a reply may be awaiting admission) unless
  // the caller presents that turn's own token, `safePoint: this.turnToken`, read
  // in the running turn's call chain. The token must be the current open turn's
  // (identity) and not stale; `true`, a copy, an older round's token, or any
  // token when no turn is open is refused as `round_open`. The contract for
  // U5-U8: call only from the running turn's own call chain, after the last
  // model reply has been fully admitted and appended (after commitPlan /
  // executeAuthorizedBatch and its messages.push) and before the next
  // callProvider. It also refuses a packet whose plan is not the active plan
  // and one the reducer rejects (stale goal, wrong source). Refusals change
  // nothing.
  //
  // Trace rows carry the current request id when a request is open. Between
  // requests there is none: pass `requestId` (the request the restage belongs
  // to) or the row is ignored by every run-check detector.
  async restageContext({ checkpoint, reason, packet, role, softLimitTokens, requestId, safePoint, parkPlanner } = {}) {
    const key = this.activePlanKey()
    const prepared = this.agentContext.prepareRestage({
      checkpoint,
      reason,
      packet,
      role,
      prefixMessages: this.rolePrefixMessages(role ?? packet?.event?.role ?? this.agentContext.role),
      parkPlanner,
    })
    const refuse = async (why) => {
      await this.traceEvent('context.restage_refused', { role: prepared.role, checkpoint, handoff_id: packet.handoff_id, reason: why }, { requestId })
      return { restaged: false, reason: why }
    }
    const guard = this.restageGuardRefusal(safePoint)
    if (guard) return refuse(guard)
    const before = this.memory.planningState?.(key)
    if (typeof this.memory.dispatchPlanningEvent !== 'function' || !before) throw new AgentLoopError('context restage needs reducer-backed memory with an admitted goal')
    if ((packet.event?.plan_id ?? null) !== (before.active_plan_id ?? null)) return refuse('packet_plan_not_active')
    const event = Number.isFinite(packet.event?.now) ? packet.event : { ...packet.event, now: Date.now() }
    if (this.memory.dispatchPlanningEvent(key, event) === before) return refuse('reducer_rejected_context_restaged')
    const result = this.agentContext.commitRestage(prepared)
    this.turnConversation = null // the flow that restaged reads the new conversation from its next round on
    // A fresh conversation carries none of the old exchanges (same resets as a reasoning-epoch rebuild).
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.resetObservationDecisionState()
    // The conversation is swapped from here on: whatever follows is reported
    // separately and can never turn this restage into a failure (a C5 caller
    // would then overwrite the fresh messages with the capsule).
    // Two independent steps: a failing trace write must not skip the persist of the reducer state
    // the restage just changed, and a failing persist must not hide the trace row.
    const failures = []
    try {
      const state = this.memory.planningState(key)
      const plan = getActivePlanningPlan(state)
      if (result.role === EXECUTOR_ROLE && plan) this.executorStepMark = { plan_id: plan.plan_id, closed: completedStepCount(plan) } // step-close restages count closes from here
      await this.traceEvent('context.restaged', contextRestagedRow(result, {
        planId: packet.event?.plan_id ?? plan?.plan_id,
        stepId: plan?.steps?.[plan.active_step_index]?.step_id,
        softLimitTokens,
      }), { requestId })
    }
    catch (error) {
      failures.push({ step: 'trace', message: cleanMemoryText(error instanceof Error ? error.message : String(error), 300) })
    }
    try {
      await this.persistState()
    }
    catch (error) {
      failures.push({ step: 'persist', message: cleanMemoryText(error instanceof Error ? error.message : String(error), 300) })
    }
    for (const failure of failures) {
      try {
        await this.traceEvent('context.restage_persist_failed', { role: result.role, checkpoint, handoff_id: result.handoff_id, ...failure }, { requestId })
      }
      catch {}
    }
    // A packet restage is a rebuild from durable state, so the reasoning epoch it was built at is the
    // one this loop has seen: refreshPlanningReasoningEpoch must not rebuild it a second time.
    this.markReasoningEpochSeen(key)
    // The packet carries the staged amendment text, so the flag follows it into the new conversation.
    if (packet.amendment_included === true && this.pendingInteractionAmendment) {
      this.pendingAmendmentConversationSeq = this.agentContext.conversationSeq
      try {
        await this.traceEvent('amendment.carried_in_packet', { request_id: requestId, role: result.role, checkpoint, handoff_id: result.handoff_id, reason: 'restage_would_drop_the_staged_text' }, { requestId })
      }
      catch {}
    }
    // The in-flight turn scope names the conversation now in place, so a later stale drop is attributed to it.
    const scope = this.turnScope.getStore()
    if (scope) { scope.role = this.agentContext.role; scope.handoffId = this.agentContext.handoffId }
    return { restaged: true, ...result }
  }

  // The system prefix of a role's conversation (U6): the shared system prompt, plus the
  // executor suffix for the executor. The prefix is the same for every conversation of
  // a role, so a restage within a role keeps the provider's cached prefix.
  rolePrefixMessages(role) {
    return [{ role: 'system', content: roleSystemPrompt(this.systemPrompt, role === EXECUTOR_ROLE ? EXECUTOR_ROLE : PLANNER_ROLE) }]
  }

  // The one place that decides whether the conversation may be swapped right now: not
  // while a provider round of the current generation is in flight, and not while a turn
  // holds the conversation unless the caller presents that turn's own token. Shared by
  // restageContext and the return to the planner (returnControlToPlanner).
  restageGuardRefusal(safePoint) {
    if ((this.providerCallsByGeneration.get(this.generation) ?? 0) > 0) return 'round_in_flight'
    const token = this.turnConversation
    if (token ? (safePoint !== token || this.agentContext.isStale(token)) : (safePoint !== undefined && safePoint !== false)) return 'round_open'
    return undefined
  }

  // --- packet-driven restages (U8: C5 budget handoff, C7 recovery; U7: planner slice close) ---

  // The ONE packet builder. `planningState` overrides the current reducer state
  // (the slice-close wake passes the state it just settled); `shelfCandidates`
  // rides a planner restage at a shelf pickup. Undefined when no goal has been
  // admitted (a reducer-less memory, a goal that never started).
  buildRestagePacket({ checkpoint, role, reason, budget, note, actor, runtime, shelfCandidates, planningState, jevFacts, jevHints } = {}) {
    const packetRole = role ?? this.agentContext.role
    const held = planningState ?? this.memory.planningState?.(this.activePlanKey())
    if (!held?.goal?.goal_id) return undefined
    // Loaded-skill refs ride the step block (ids only; the text loads through getSkillDetails).
    const skillIds = this.loadedSkillContext instanceof Map ? [...this.loadedSkillContext.keys()].slice(-3) : []
    const state = skillIds.length > 0 && held.loaded_skill_ids === undefined ? { ...held, loaded_skill_ids: skillIds } : held
    return buildHandoffPacket({
      planningState: state,
      role: packetRole,
      checkpoint,
      reason,
      budget,
      note,
      actor,
      runtime,
      shelfCandidates,
      jevFacts, // U11 advisory: bounded facts Jev's observation families add (never replacing a mandatory record)
      jevHints,
      // A staged user amendment belongs to the planner: it rides the packet of a planner restage (C5,
      // C1/C2) so the restage that replaces the conversation holding its text does not drop it. The
      // executor never gets it.
      amendment: packetRole === PLANNER_ROLE ? this.currentPendingAmendment() ?? undefined : undefined,
      previousContextChars: conversationChars(this.messages),
      now: Date.now(),
    })
  }

  // THE ONE PLACE a running turn presents its token to restageContext (the U4
  // seam contract). Call it only from the running turn's own call chain, after
  // the last reply of the current conversation is fully handled (or failed, as
  // the exhausted budget round did) and before the next callProvider. When no
  // turn is open the token is null and NOTHING is passed (a null/true safePoint
  // is refused as round_open). Never call it from the supervisor, chat or a
  // timer: those use restageBetweenTurns.
  // Accepts a prebuilt `packet` or the builder arguments of buildRestagePacket.
  async restageInTurn(args = {}) {
    return this.restageThrough(args, this.turnToken ?? undefined)
  }

  // Restage where no turn holds the conversation: supervisor-level recovery
  // (C7), a request's start (a Resume) and a slice-close wake that runs from the
  // completion signal. Passes no safePoint; a refusal ('round_in_flight' |
  // 'round_open') means "retry at the next boundary", never an error.
  async restageBetweenTurns(args = {}) {
    return this.restageThrough(args, undefined)
  }

  // Shared body of the two helpers. Never throws: a refusal is a typed result, a
  // failure (a packet that does not fit, a memory that cannot restage) is
  // `{ restaged: false, reason: 'restage_error' }` with a `context.restage_error`
  // row, so a C5 budget handoff falls back to its capsule. A frozen (BLOCKED)
  // plan and a goal that is not active are never restaged (the plan waits for the
  // user; there is nothing healthy to re-brief).
  async restageThrough(args, safePoint) {
    const requestId = args.requestId ?? this.traceRequest?.id
    const role = args.role ?? args.packet?.event?.role ?? this.agentContext.role
    const checkpoint = args.checkpoint ?? args.packet?.event?.checkpoint
    try {
      let state = args.planningState ?? this.memory.planningState?.(this.activePlanKey())
      if (!state?.goal?.goal_id) return { restaged: false, reason: 'no_admitted_goal' }
      const stateRefusal = (held) => (held.goal.status !== GOAL_STATUS.ACTIVE
        ? 'goal_not_active'
        : getActivePlanningPlan(held)?.status === PLAN_STATUS.BLOCKED ? 'plan_blocked' : undefined)
      let refusal = stateRefusal(state)
      if (refusal) {
        await this.traceEvent('context.restage_refused', { role, checkpoint, handoff_id: args.packet?.handoff_id, reason: refusal }, { requestId })
        return { restaged: false, reason: refusal }
      }
      // U11: Jev's observation families for this restage. Shadow asks nothing here and awaits nothing (the call starts
      // after the restage has landed). Advisory needs the answer for the packet: it asks only when the guard that could
      // refuse this restage passes NOW (never burn a call on a restage that will be refused), waits a bounded time, then
      // state is read again and the restage's own guard (restageContext) runs after the await.
      let prepared
      if (!args.packet && this.jev.available()) {
        const needsAnswer = this.jev.stage('observation_families') !== 'shadow'
        if (!needsAnswer || !this.restageGuardRefusal(safePoint)) {
          prepared = await this.jev.prepareRestage({ checkpoint, role, planningState: state, reason: args.reason, requestId })
          if (needsAnswer) {
            // The reducer is read again after the wait, for a caller-supplied state too (the slice-close wake passes the state it
            // settled): a goal that stopped being active or a plan that became BLOCKED refuses the restage, and a plan that is no
            // longer the one the caller settled means the state moved on. The caller's state is kept only while the plan is the same.
            const fresh = this.memory.planningState?.(this.activePlanKey()) ?? state
            refusal = stateRefusal(fresh)
            if (!refusal && args.planningState && (fresh.active_plan_id ?? null) !== (args.planningState.active_plan_id ?? null)) refusal = 'state_moved_on_during_jev_wait'
            if (refusal) {
              await this.jev.afterRestage(prepared, { restaged: false, reason: refusal })
              await this.traceEvent('context.restage_refused', { role, checkpoint, reason: refusal }, { requestId })
              return { restaged: false, reason: refusal }
            }
            if (!args.planningState) state = fresh
          }
        }
      }
      const packet = args.packet ?? this.buildRestagePacket({ ...args, role, planningState: state, jevFacts: prepared?.facts, jevHints: prepared?.hints })
      if (!packet) {
        await this.jev.afterRestage(prepared, { restaged: false, reason: 'no_admitted_goal' })
        return { restaged: false, reason: 'no_admitted_goal' }
      }
      const restaged = await this.restageContext({ checkpoint, reason: args.reason, packet, role, softLimitTokens: args.softLimitTokens, requestId, safePoint, parkPlanner: args.parkPlanner })
      await this.jev.afterRestage(prepared, restaged)
      return restaged
    }
    catch (error) {
      const message = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
      // The helper never throws: a trace writer that fails here must not turn a typed refusal into an exception.
      try {
        await this.traceEvent('context.restage_error', { role, checkpoint, message }, { requestId })
      }
      catch {}
      return { restaged: false, reason: 'restage_error' }
    }
  }

  // Soft limit of a role's context, in tokens. An explicit `restageSoftLimitTokens`
  // option (a number, or { planner, executor }) wins. The default is
  // prefix-aware: the fixed prefix (system prompt and tool schemas: measured from
  // the first reply that reports input tokens, else chars/4 of the system
  // prompt) plus the working-context ceiling in tokens (maxWorkingChars / 4).
  // The size counter includes the prefix, so the limit measures what the
  // conversation grew beyond it; without the prefix a real ~58k-character
  // system prompt alone would sit past a 40,000-character ceiling and every
  // slice close would restage. maxWorkingChars scales with a profile's
  // context window only for profiles that declare one (local); the others keep
  // the 40,000-character default. The hard limit is 2x this (decideRestage).
  // Per role today because the roles can run on different models.
  restageSoftLimitTokens(role = PLANNER_ROLE) {
    const option = this.restageSoftLimitOption
    const explicit = typeof option === 'number' ? option : option?.[role]
    if (Number.isFinite(explicit) && explicit > 0) return explicit
    return Math.max(1, this.agentContext.prefixTokens + estimateTokensFromChars(this.maxWorkingChars))
  }

  // The provider call context's role field. Unrestaged single-model runs send
  // exactly what they always did; naming the role only matters (and is only
  // sent) once delegation is active or the config runs the roles on
  // different models, where roleProvider needs it to pick the planner model.
  providerRoleFields(attribution) {
    const fields = this.agentContext.providerContextFields(attribution)
    if (fields.role === undefined && attribution?.role === PLANNER_ROLE && this.agentContext.rolesDiffer) return { role: PLANNER_ROLE }
    return fields
  }

  // The slice-close wake of the planner (next to closeOutputSlice, before
  // planner.wake). Two things, both harness-owned:
  //  1. the verified-results message text: reducer evidence and receipts, goal
  //     progress per doneWhen, estimated vs measured time (verified-results.mjs);
  //  2. the size decision (restage-policy.mjs decideRestage, boundary
  //     slice_close): past the soft limit, the planner conversation is replaced
  //     by a packet plus the shelf candidates (C2 when the wake picks up a shelf
  //     node, else C1). Below it nothing is discarded.
  // `withinTurn` says the wake runs inside the running turn's own call chain (it
  // uses restageInTurn); otherwise restageBetweenTurns. A restage that cannot
  // happen now (a round or turn is open) or fails is never an error: the wake
  // proceeds on the existing conversation and the next slice close retries.
  async planSliceCloseWake({ route, planningState, goalEvaluation, withinTurn = false }) {
    const requestId = this.traceRequest?.id ?? this.turnScope.getStore()?.requestId // captured before any await: a superseding reset can clear the request
    const plan = planningState ? getActivePlanningPlan(planningState) : undefined
    // The NPC time split of the slice just closed: the mark advances here, once per slice close.
    const timeSplit = this.planTiming?.sliceTimeSplit()
    const verified = buildVerifiedResults({
      planningState,
      goalEvaluation,
      timeSplit,
      stepTimes: this.planTiming?.closedStepTimes((plan?.steps ?? []).map(step => step.step_id), {
        goalId: this.peekPlanState(this.activePlanKey())?.goal_id, // the board's goal id, the key PlanTiming records carry
        sinceMs: plan?.committed_at ?? 0,
      }) ?? [],
    })
    if (timeSplit) {
      await this.traceEvent('slice.time_split', {
        since: timeSplit.since,
        wall_ms: timeSplit.wall_ms,
        think_ms: timeSplit.think_ms,
        actor_busy_ms: timeSplit.actor_busy_ms,
        idle_ms: timeSplit.idle_ms,
        walking: timeSplit.walking,
        shown_to_model: verified.text.includes('npc time this slice'),
        reason: 'slice_close',
      }, { requestId })
    }
    const wake = { verifiedResults: verified.text, restaged: false }
    if (!planningState?.goal) return wake
    // Never restage a planner that has nothing healthy to be re-briefed on: a
    // frozen (BLOCKED) plan waits for the user, and a goal that is met or no
    // longer active is not woken for another slice.
    if (planningState.goal.status !== GOAL_STATUS.ACTIVE || goalEvaluation?.satisfied === true || plan?.status === PLAN_STATUS.BLOCKED) return wake
    // U11: a verified slice scores the shelf ranking whose picked node it refined; then Jev ranks the complete
    // candidate set for this pickup (shadow: recorded and scored; advisory: orders the packet's candidates only).
    await this.jev.onSliceClosed()
    const { candidates: shelfCandidates, ranking } = await this.shelfCandidatesForPickup({ route, planningState, withinTurn })
    // U6: the slice is closed, so the executor's work is done. Control returns to the
    // planner conversation (parked at the plan commit, untouched by executor traffic),
    // which the wake below then briefs with the verified results.
    // When it cannot happen the executor is NEVER woken to author the next slice: the caller ends the
    // request visibly (endSliceWithoutPlanner) and no model runs.
    if (this.agentContext.role === EXECUTOR_ROLE) {
      const returned = await this.returnControlToPlannerWithRetry({ route, planningState, withinTurn, reason: 'slice_close', requestId, shelfCandidates })
      if (!returned.returned) return { ...wake, unavailable: { route, reason: returned.reason ?? 'planner_unavailable' } }
      if (!returned.resumed) {
        await this.jev.markShelfApplied(ranking) // the ordered candidates reached the fresh planner's packet
        return { ...wake, restaged: true, checkpoint: returned.checkpoint, result: returned.result }
      }
    }
    if (this.agentContext.role !== PLANNER_ROLE) return wake
    const softLimitTokens = this.restageSoftLimitTokens(PLANNER_ROLE)
    const decision = decideRestage({
      role: PLANNER_ROLE,
      boundary: RESTAGE_BOUNDARY.SLICE_CLOSE,
      contextTokens: this.agentContext.sizeTokens,
      softLimitTokens,
    })
    if (!decision.restage) return wake
    const candidates = shelfCandidates
    const checkpoint = route === 'next_shelf_slice' && candidates.length > 0 ? 'C2' : decision.checkpoint
    // An actor replacement or a reset during the awaits above must fail safe:
    // the conversation is not swapped for a turn that no longer exists.
    try {
      await this.assertCurrent()
    }
    catch (error) {
      await this.traceEvent('context.restage_refused', { role: PLANNER_ROLE, checkpoint, reason: 'turn_superseded', message: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) }, { requestId })
      throw error
    }
    const restage = withinTurn ? this.restageInTurn : this.restageBetweenTurns
    const result = await restage.call(this, {
      checkpoint,
      role: PLANNER_ROLE,
      reason: decision.reason,
      shelfCandidates: candidates,
      planningState,
      softLimitTokens,
      requestId,
    })
    if (result.restaged === true) await this.jev.markShelfApplied(ranking) // the ordered candidates reached the packet
    return { ...wake, restaged: result.restaged === true, checkpoint, result }
  }

  // The shelf candidates a planner wake shows (at most 5). The deterministic order is the default; Jev's ranking of
  // the COMPLETE ready set (U11) reorders it only once the family has earned advisory, and never adds or drops one.
  async shelfCandidatesForPickup({ route, planningState, withinTurn = false }) {
    const all = shelfRefinementCandidates(planningState, { limit: 32 })
    if (route !== 'next_shelf_slice') return { candidates: all.slice(0, 5), ranking: undefined }
    // Jev's answer is waited for (bounded) only when the ordering can reach a packet that is about to be built; shadow, and
    // an advisory pickup with no packet, are fire-and-forget.
    const needsAnswer = this.jev.available() && this.jev.stage('shelf_ranking') !== 'shadow' && this.shelfRestageExpected({ withinTurn })
    const ranking = await this.jev.rankShelf({ route, planningState, candidates: all, needsAnswer })
    return { candidates: ranking.ordered.slice(0, 5), ranking }
  }

  // Will this slice close build a planner packet (so a shelf ordering has somewhere to go)? An executor with a parked planner
  // resumes it (no packet); one without, and a planner past its soft limit, restage; a restage the guard refuses now is not
  // expected (and no Jev call is spent on it).
  shelfRestageExpected({ withinTurn = false } = {}) {
    if (this.restageGuardRefusal(withinTurn ? (this.turnToken ?? undefined) : undefined)) return false
    if (this.agentContext.role === EXECUTOR_ROLE) {
      // Without a parked planner a fresh one is built from a packet. With one, it is resumed as it was: a packet only
      // happens if the resumed planner's own size is past its soft limit (the wake then restages it in the same step).
      if (!this.agentContext.hasParkedPlanner) return true
      return decideRestage({
        role: PLANNER_ROLE,
        boundary: RESTAGE_BOUNDARY.SLICE_CLOSE,
        contextTokens: this.agentContext.parkedPlanner?.size?.tokens ?? 0,
        softLimitTokens: this.restageSoftLimitTokens(PLANNER_ROLE),
      }).restage
    }
    if (this.agentContext.role !== PLANNER_ROLE) return false
    return decideRestage({
      role: PLANNER_ROLE,
      boundary: RESTAGE_BOUNDARY.SLICE_CLOSE,
      contextTokens: this.agentContext.sizeTokens,
      softLimitTokens: this.restageSoftLimitTokens(PLANNER_ROLE),
    }).restage
  }

  // --- executor handoff (U6, plan items 3.4b/3.4d) ---------------------------------------------
  //
  // Owner rules (design note 12a): the planner conversation is long-lived and
  // uncluttered; the executor is disposable. At a plan commit (C3) the harness
  // starts a FRESH executor conversation from a packet (the immutable plan, the
  // active step and its contract, loaded-skill refs) plus the executor role suffix,
  // and PARKS the planner conversation: the planner receives no executor tool
  // traffic. Exactly one conversation acts; replies of the other are stale
  // (AgentContext conversation sequence, dropIfStale). At the slice close control
  // returns to the planner (returnControlToPlanner) and the executor conversation
  // is dropped. The executor never authors or changes the plan: enforceExecutorContract.

  // C3: called from commitPlan, in the running turn's call chain, after the batch
  // was admitted and the reply appended, and only when this reply committed the plan.
  async startExecutorAtCommit({ planId, requestId }) {
    const state = this.memory.planningState?.(this.activePlanKey())
    const plan = state ? getActivePlanningPlan(state) : undefined
    if (!plan || plan.plan_id !== planId || !FROZEN_PLAN_STATUSES.has(plan.status)) {
      await this.traceEvent('executor.handoff_skipped', { request_id: requestId, role: EXECUTOR_ROLE, reason: 'plan_not_committed', plan_id: planId }, { requestId })
      return { restaged: false, reason: 'plan_not_committed' }
    }
    const softLimitTokens = this.restageSoftLimitTokens(EXECUTOR_ROLE)
    const decision = decideRestage({
      role: EXECUTOR_ROLE,
      boundary: RESTAGE_BOUNDARY.PLAN_COMMIT,
      contextTokens: this.agentContext.sizeTokens,
      softLimitTokens,
    })
    const plannerHandoffId = this.agentContext.role === PLANNER_ROLE ? this.agentContext.handoffId : undefined
    const result = await this.restageInTurn({
      checkpoint: decision.checkpoint,
      role: EXECUTOR_ROLE,
      reason: decision.reason,
      actor: this.epoch,
      softLimitTokens,
      parkPlanner: true,
      requestId,
    })
    if (!result.restaged) {
      // The committed plan keeps running on the conversation that committed it; the next commit retries.
      await this.traceEvent('executor.handoff_failed', { request_id: requestId, role: EXECUTOR_ROLE, reason: result.reason, plan_id: planId }, { requestId })
      return result
    }
    await this.traceEvent('context.planner_parked', {
      request_id: requestId,
      role: PLANNER_ROLE,
      handoff_id: plannerHandoffId,
      executor_handoff_id: result.handoff_id,
      reason: 'executor_acts_on_committed_plan',
      parked: this.agentContext.hasParkedPlanner,
    }, { requestId })
    return result
  }

  // C6: ordinary bounded recovery (Jev routed wake_planner / targeted_observation on a
  // failure). Runs inside the recovery's turn chain, after the failed reply is done with.
  async startExecutorForRecovery({ route, reason, runtime }) {
    const requestId = this.traceRequest?.id
    if (!this.executorHandoffEnabled) return { restaged: false, reason: 'executor_handoff_disabled' }
    const state = this.memory.planningState?.(this.activePlanKey())
    const plan = state ? getActivePlanningPlan(state) : undefined
    if (!plan || !FROZEN_PLAN_STATUSES.has(plan.status)) return { restaged: false, reason: 'no_committed_plan' }
    // A user amendment is pending on the planner conversation: parking it would drop the text, and the
    // executor never gets user steering. The recovery stays on the planner, which holds it.
    if (this.agentContext.role === PLANNER_ROLE && this.currentPendingAmendment()) {
      await this.traceEvent('executor.recovery_handoff_skipped', { request_id: requestId, role: EXECUTOR_ROLE, reason: 'user_amendment_pending_on_planner', route }, { requestId })
      return { restaged: false, reason: 'user_amendment_pending_on_planner' }
    }
    const cause = cleanMemoryText(sanitizeDurableModelText(reason, 200), 150)
    const result = await this.restageInTurn({
      checkpoint: 'C6',
      role: EXECUTOR_ROLE,
      reason: `bounded_recovery route=${route} cause=${cause}`,
      actor: this.epoch,
      runtime,
      softLimitTokens: this.restageSoftLimitTokens(EXECUTOR_ROLE),
      parkPlanner: true,
      requestId,
    })
    if (!result.restaged) await this.traceEvent('executor.recovery_restage_fallback', { request_id: requestId, role: EXECUTOR_ROLE, reason: result.reason, route }, { requestId })
    return result
  }

  // The slice closed: the planner conversation acts again. Its parked messages come
  // back untouched; with none parked (a restart or an actor replacement rebuilt the
  // executor from a C7 packet) a fresh planner is built from a packet (C1, or C2
  // when a shelf node is picked up), exactly as a soft-limit restage would. A round
  // or turn that is open refuses it (the wake then proceeds on the existing
  // conversation and the next slice close retries).
  async returnControlToPlanner({ route, planningState, withinTurn = false, reason = 'slice_close', requestId, shelfCandidates } = {}) {
    const rid = requestId ?? this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
    const fromHandoffId = this.agentContext.handoffId
    const refusal = this.restageGuardRefusal(withinTurn ? (this.turnToken ?? undefined) : undefined)
    if (refusal) {
      await this.traceEvent('context.planner_resume_refused', { request_id: rid, role: PLANNER_ROLE, from_role: this.agentContext.role, from_handoff_id: fromHandoffId, reason: refusal, route }, { requestId: rid })
      return { returned: false, reason: refusal }
    }
    try {
      await this.assertCurrent()
    }
    catch (error) {
      await this.traceEvent('context.planner_resume_refused', { request_id: rid, role: PLANNER_ROLE, from_role: this.agentContext.role, from_handoff_id: fromHandoffId, reason: 'turn_superseded', route, message: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) }, { requestId: rid })
      throw error
    }
    if (this.agentContext.hasParkedPlanner) {
      const resumed = this.agentContext.resumePlanner()
      this.turnConversation = null // the flow that returned control reads the planner conversation from its next round on
      this.toolCache.clear()
      this.duplicateToolRounds = 0
      this.observationRecoveryRounds = 0
      this.observationOnlyRounds = 0
      this.resetObservationDecisionState()
      this.executorStepMark = null
      const scope = this.turnScope.getStore()
      if (scope) { scope.role = this.agentContext.role; scope.handoffId = this.agentContext.handoffId }
      await this.traceEvent('context.planner_resumed', {
        request_id: rid,
        role: PLANNER_ROLE,
        handoff_id: resumed.handoff_id,
        from_role: EXECUTOR_ROLE,
        from_handoff_id: fromHandoffId,
        reason,
        route,
        planner_message_count: resumed.message_count,
        dropped_executor_messages: resumed.dropped_executor.message_count,
        dropped_executor_chars: resumed.dropped_executor.chars,
      }, { requestId: rid })
      return { returned: true, resumed: true }
    }
    const candidates = shelfCandidates ?? (planningState ? shelfRefinementCandidates(planningState, { limit: 5 }) : [])
    const checkpoint = route === 'next_shelf_slice' && candidates.length > 0 ? 'C2' : 'C1'
    const restage = withinTurn ? this.restageInTurn : this.restageBetweenTurns
    const result = await restage.call(this, {
      checkpoint,
      role: PLANNER_ROLE,
      reason: 'planner_fresh_at_slice_close_no_parked_context',
      shelfCandidates: candidates,
      planningState,
      requestId: rid,
    })
    if (!result.restaged) {
      await this.traceEvent('context.planner_resume_failed', { request_id: rid, role: PLANNER_ROLE, from_role: EXECUTOR_ROLE, from_handoff_id: fromHandoffId, reason: result.reason, route }, { requestId: rid })
    }
    return { returned: result.restaged === true, resumed: false, checkpoint, result, reason: result.restaged === true ? undefined : result.reason }
  }

  // A refusal because a round or the turn is open is tried once more after the loop yields (the
  // round boundary); any other refusal, or a second one, is final.
  async returnControlToPlannerWithRetry(args) {
    const first = await this.returnControlToPlanner(args)
    // Only an in-flight round can finish and clear. `round_open` inside a turn never does (the token is
    // the same on a retry), so it goes straight to the deferred path.
    if (first.returned || first.reason !== 'round_in_flight') return first
    await new Promise(resolve => setImmediate(resolve))
    const rid = args.requestId ?? this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
    await this.traceEvent('context.planner_resume_retried', { request_id: rid, role: PLANNER_ROLE, reason: first.reason, route: args.route }, { requestId: rid })
    return this.returnControlToPlanner(args)
  }

  // The slice is verified complete but the planner cannot take the goal back. The request ends
  // visibly with the goal still active between slices (Resume re-drives it from the verified state);
  // no model is woken, and in particular the executor does not author the next slice.
  async endSliceWithoutPlanner({ route, reason }) {
    const requestId = this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
    await this.persistState()
    const state = this.peekPlanState(this.activePlanKey())
    this.active = false
    const chatMessage = `The plan slice is verified complete, but I could not hand the goal back to the planner (${reason}), so I stopped without waking a model. The goal stays active between slices. ${RESUME_HINT}`
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'slice_close_planner_unavailable',
      reason,
      task_board: visibleTaskBoard(state?.task_board),
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    // After request.completed (which reads as idle), so the UI shows a waiting marker for the goal and
    // the supervisor's activity hook syncs the task board; the row also carries the request id.
    await this.traceEvent('executor.slice_wake_deferred', {
      request_id: requestId,
      role: EXECUTOR_ROLE,
      handoff_id: this.agentContext.handoffId,
      reason,
      route,
      model_woken: false,
      chat_message: chatMessage,
    }, { requestId })
    return {
      chatMessage,
      plan: [],
      currentStep: 0,
      operations: [],
      epoch: this.epoch?.epoch,
      actorId: this.epoch?.actor_id,
      goalId: state?.goal_id,
      goalStatus: 'active',
      taskBoard: visibleTaskBoard(state?.task_board),
    }
  }

  // Hard-limit step-close restage (design note 12a rule 1, restage-policy C8). Called at
  // a verified step close INSIDE a slice: past the executor's hard limit (2x soft) the
  // executor conversation is rebuilt fresh from a packet (the plan block is
  // byte-identical to the previous executor's: it is the cache prefix); below it
  // nothing is discarded. A step close that ends the slice is the planner's slice-close
  // boundary, never this one. A step close is detected by the reducer's closed-step
  // count moving past the mark taken at the last executor restage.
  async executorStepCloseBoundary({ withinTurn = false, requestId } = {}) {
    if (this.agentContext.role !== EXECUTOR_ROLE) return undefined
    const rid = requestId ?? this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
    const state = this.memory.planningState?.(this.activePlanKey())
    const plan = state ? getActivePlanningPlan(state) : undefined
    if (!plan || !FROZEN_PLAN_STATUSES.has(plan.status)) return undefined
    const closed = completedStepCount(plan)
    const mark = this.executorStepMark
    if (!mark || mark.plan_id !== plan.plan_id) {
      this.executorStepMark = { plan_id: plan.plan_id, closed }
      return undefined
    }
    if (closed <= mark.closed) return undefined
    this.executorStepMark = { plan_id: plan.plan_id, closed }
    const softLimitTokens = this.restageSoftLimitTokens(EXECUTOR_ROLE)
    const decision = decideRestage({
      role: EXECUTOR_ROLE,
      boundary: RESTAGE_BOUNDARY.STEP_CLOSE,
      contextTokens: this.agentContext.sizeTokens,
      softLimitTokens,
    })
    await this.traceEvent('context.step_close_decision', {
      request_id: rid,
      role: EXECUTOR_ROLE,
      handoff_id: this.agentContext.handoffId,
      restage: decision.restage,
      checkpoint: decision.checkpoint ?? undefined,
      reason: decision.reason,
      size_tokens: this.agentContext.sizeTokens,
      soft_limit_tokens: softLimitTokens,
      hard_limit_tokens: 2 * softLimitTokens,
      closed_steps: closed,
      plan_id: plan.plan_id,
    }, { requestId: rid })
    if (!decision.restage) return { restaged: false, reason: decision.reason }
    const restage = withinTurn ? this.restageInTurn : this.restageBetweenTurns
    return restage.call(this, {
      checkpoint: decision.checkpoint,
      role: EXECUTOR_ROLE,
      reason: decision.reason,
      actor: this.epoch,
      softLimitTokens,
      requestId: rid,
    })
  }

  // The executor's plan contract. There is ONE submitPlan tool for both roles; the
  // role suffix asks the executor not to author the plan, and this is the harness's
  // side of it. A reply of the executor that restates the committed plan with
  // different steps or order, or that carries a goal definition (scope, doneWhen), a
  // roadmap or a development mode, leaves the committed plan and the Plan Tracker
  // exactly as they are: the goal, roadmap and development-mode fields are dropped
  // before admission (the step list is reconciled to the committed steps by the
  // unchanged admission, which has never let a continuation change them), and the
  // drop is traced (executor.plan_semantics_ignored). Operations, observations, a
  // checkpoint and a semantic completion claim for the committed active step go
  // through the unchanged admission. The contract is about the ROLE, not the plan status: an
  // executor reply while no plan is committed (the slice is COMPLETED, nothing is drafted) would
  // author or commit a new plan, so it is ignored, traced and ends the request visibly without
  // waking a model (executorCannotAuthor). User amendments never reach the executor: they are staged
  // in the planner conversation (stageCompatibleAmendment), so there is no bypass here.
  async enforceExecutorContract(plan) {
    if (this.agentContext.role !== EXECUTOR_ROLE) return plan
    const state = this.memory.planningState?.(this.activePlanKey())
    const committed = state ? getActivePlanningPlan(state) : undefined
    const authorable = !committed || [PLAN_STATUS.DRAFT, PLAN_STATUS.RUNTIME_VALIDATION, PLAN_STATUS.READY, PLAN_STATUS.COMPLETED, PLAN_STATUS.SUPERSEDED, PLAN_STATUS.CANCELLED].includes(committed.status)
    if (authorable) {
      const requestId = this.traceRequest?.id
      await this.traceEvent('executor.plan_semantics_ignored', {
        request_id: requestId,
        role: EXECUTOR_ROLE,
        handoff_id: this.agentContext.handoffId,
        plan_id: committed?.plan_id,
        reason: `executor_cannot_author_plan:plan_status_${committed?.status ?? 'none'}`,
        ignored_fields: ['plan', 'operations'],
        incoming_steps: Array.isArray(plan.plan) ? plan.plan.length : 0,
        committed_steps: committed?.steps?.length ?? 0,
      }, { requestId })
      return { ...plan, executorCannotAuthor: true }
    }
    const ignored = []
    const reasons = []
    let next = plan
    const strip = (field) => {
      const { [field]: _dropped, ...rest } = next
      next = rest
    }
    if (committed && FROZEN_PLAN_STATUSES.has(committed.status) && Array.isArray(plan.plan) && plan.plan.length > 0) {
      const board = this.memory.currentPlan?.(this.activePlanKey())?.task_board
      const incoming = plan.plan.map(normalizedStepText)
      const lists = [
        { steps: committed.steps.map(step => normalizedStepText(step.description)), active: committed.active_step_index },
        { steps: (Array.isArray(board?.steps) ? board.steps : []).map(step => normalizedStepText(step?.description)), active: Number.isSafeInteger(board?.active_index) ? board.active_index : 0 },
      ].filter(entry => entry.steps.length > 0)
      const verdicts = lists.map(entry => restatedPlanVerdict(incoming, entry.steps, entry.active))
      if (verdicts.length > 0 && !verdicts.includes('unchanged')) {
        ignored.push('plan')
        reasons.push(verdicts.includes('order_changed') ? 'order_changed' : 'steps_changed')
      }
    }
    if (next.goalDefinition !== undefined) {
      const held = state?.goal?.definition
      const conditions = value => JSON.stringify((Array.isArray(value) ? value : []).map(condition => ({ ...condition, id: undefined })))
      const same = held !== undefined && held !== null
        && next.goalDefinition?.scope === held.scope
        && conditions(next.goalDefinition?.doneWhen ?? next.goalDefinition?.done_when) === conditions(held.done_when)
      strip('goalDefinition')
      if (!same) { ignored.push('goal'); reasons.push('goal_definition_changed') }
    }
    if (next.roadmap !== undefined) { strip('roadmap'); ignored.push('roadmap'); reasons.push('roadmap_is_planner_authority') }
    if (next.roadmapNodeIds !== undefined) { strip('roadmapNodeIds'); ignored.push('roadmapNodeIds'); reasons.push('roadmap_is_planner_authority') }
    if (next.developmentMode !== undefined) { strip('developmentMode'); ignored.push('developmentMode'); reasons.push('development_mode_is_planner_authority') }
    if (ignored.length === 0) return plan
    const requestId = this.traceRequest?.id
    await this.traceEvent('executor.plan_semantics_ignored', {
      request_id: requestId,
      role: this.agentContext.role,
      handoff_id: this.agentContext.handoffId,
      plan_id: committed?.plan_id,
      reason: [...new Set(reasons)].join(','),
      ignored_fields: ignored,
      incoming_steps: Array.isArray(plan.plan) ? plan.plan.length : 0,
      committed_steps: committed?.steps?.length ?? 0,
    }, { requestId })
    return next
  }

  // C5: a provider-budget boundary. The fresh conversation runs in the SAME
  // role as the exhausted one and starts from the packet alone: the reducer's
  // goal, plan, active step and receipts, the reason code (with the semantic
  // scope) and a budget line (generation, handoff n of the limit). None of the
  // exhausted thread's messages, and never a model summary of them.
  // The role is the running conversation's: a budget handoff during step execution
  // restages the executor (U6), one during planning restages the planner.
  budgetHandoffPacketArgs({ reason, semanticScope, runtime }) {
    const cause = cleanMemoryText(sanitizeDurableModelText(reason, 200), 150)
    return {
      checkpoint: 'C5',
      role: this.agentContext.role,
      reason: `provider_budget_handoff scope=${semanticScope} cause=${cause}`,
      budget: `provider budget generation ${this.providerBudgetGeneration}; handoff ${this.providerBudgetHandoffCount} of ${this.maxProviderBudgetHandoffs}; output cap ${this.maxProviderOutputUnits} per generation`,
      actor: this.epoch,
      runtime,
    }
  }

  // A reply for a discarded conversation never resets the active one. The round
  // that produced it is dropped and the turn is re-driven on the conversation
  // now in place, at most STALE_REDRIVE_LIMIT times; after that the failure is
  // visible (a provider failure the normal pause/failed path reports), never a
  // silent cancellation.
  // Depth-counted: a turn entered without runGuarded (a direct runTurn, the
  // supervisor's slice-boundary recovery) still releases the conversation marker
  // when its outermost turn ends, and a nested turn (withinTurn) keeps it.
  async runTurn() {
    this.turnDepth = (this.turnDepth ?? 0) + 1
    try {
      // The outermost turn fixes the identity every nested admission is judged
      // against (see dropIfStale); a nested turn keeps it.
      const scope = this.currentTurnScope()
      return await this.turnScope.run(scope, () => super.runTurn())
    }
    finally {
      if (--this.turnDepth === 0) this.turnConversation = null
    }
  }

  async runTurnRedriving(generation) {
    for (let redrive = 0; ; redrive++) {
      try {
        return await this.runTurn()
      }
      catch (error) {
        if (error?.code !== STALE_REPLY_ERROR_CODE || generation !== this.generation || !this.active) throw error
        this.turnConversation = null
        if (redrive >= STALE_REDRIVE_LIMIT) {
          // The request ends here: the normal failure path may pause the goal or reset the loop, so
          // this text promises only what always holds (the durable plan state is untouched).
          throw new AgentLoopError('provider_stale_reply_after_restage: replies for discarded conversations kept arriving after a restage, so this request was stopped; the goal and plan state are unchanged and Resume restarts from them')
        }
        await this.traceEvent('context.stale_reply_redriven', { attempt: redrive + 1, limit: STALE_REDRIVE_LIMIT })
      }
    }
  }

  // Every admission point calls assertCurrent (an RCON round trip) before it
  // acts on a model reply; a restage that landed during that await must not let
  // the reply through.
  async assertCurrent() {
    const current = await super.assertCurrent()
    await this.dropIfStale(this.turnConversation)
    return current
  }

  // Two judgements. (1) The reply of a round of a conversation a restage or a
  // reset replaced (AgentContext.isStale, by conversation sequence). (2) Any flow
  // of a turn that a reset outlived: this.turnConversation belongs to whichever
  // turn runs now, so the running turn identity (turnScope) is compared to the
  // live lineage and generation. A reply of a cancelled or replaced-actor turn
  // must not reach admission even after a new turn has started.
  async dropIfStale(attribution) {
    const scope = this.turnScope.getStore()
    if (scope && (scope.lineage !== this.agentContext.lineageSequence || scope.generation !== this.generation)) {
      // The reply's own attribution names the conversation it came from; the scope's role and
      // handoff are those of the turn's first round and go stale after an in-turn restage.
      await this.dropStaleReply({ role: attribution?.role ?? scope.role, handoffId: attribution?.handoffId ?? scope.handoffId }, scope.requestId, 'superseded')
    }
    if (this.agentContext.isStale(attribution)) {
      // A reply of an earlier lineage was outlived by a reset; one of the same lineage by a restage.
      await this.dropStaleReply(attribution, undefined, attribution.lineage !== this.agentContext.lineageSequence ? 'superseded' : 'restage')
    }
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
      // U11: a persisted judgment stage the recorded evidence does not support was clamped down on restore.
      for (const clamp of this.memory.jevLedgerClamped ?? []) {
        await this.traceEvent('jev.stage_clamped_on_restore', { ...clamp, reason: 'persisted_stage_not_supported_by_the_recorded_evidence' })
      }
      for (const item of this.memory.restoreDiagnostics ?? []) {
        this.log(`[memory] plan progress disagrees with the task board after restore: ${JSON.stringify(item)}`)
      }
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
    return `[SKILL_CONTEXT] Explicitly loaded SGLuna skills for this logical task. They are reusable strategy/constraint context, not authoritative live world state. Revalidate mutable facts before acting.\n${payload}`
  }

  // Two defects lived in the inherited compaction:
  //  - it ran INSIDE the base tool batch, so a large fresh read could be
  //    spliced out before this class consumed it;
  //  - it could compact the NEWEST exchange, replacing fresh observations with
  //    an 800-char summary before the planner had read them once.
  // Compaction now waits until this class has consumed the batch, and never
  // takes the newest exchange; older exchanges still compact as before.
  // Scales the working-context ceiling from a declared context window. Half
  // the window goes to the working messages at a conservative 3 characters
  // per token (JSON-heavy tool results); the rest stays for tool schemas, the
  // output cap and a margin. Message count scales with the character ceiling.
  // No window, or explicit maxWorking* options: the ceiling is unchanged.
  // Returns true when the ceiling changed.
  applyContextWindowCeiling(contextWindow, source) {
    if (this.explicitWorkingCeiling) return false
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return false
    if (this.workingCeiling?.context_window === contextWindow) return false
    const chars = Math.max(8000, Math.floor(contextWindow * 1.5))
    const messages = Math.max(8, Math.min(64, Math.round(this.defaultWorkingCeiling.messages * chars / this.defaultWorkingCeiling.chars)))
    this.maxWorkingChars = chars
    this.maxWorkingMessages = messages
    this.workingCeiling = { messages, chars, source, context_window: contextWindow }
    this.workingCeilingTracedFor = null
    return true
  }

  // One compaction.ceiling event per request (and again whenever it changes),
  // so a run's compaction behavior can be read from the trace alone.
  async traceWorkingCeiling(reason) {
    const key = `${this.traceRequest?.id ?? ''}|${this.workingCeiling.chars}|${this.workingCeiling.messages}`
    if (!this.traceRequest || this.workingCeilingTracedFor === key) return
    this.workingCeilingTracedFor = key
    await this.traceEvent('compaction.ceiling', {
      reason,
      source: this.workingCeiling.source,
      context_window: this.workingCeiling.context_window,
      max_working_chars: this.workingCeiling.chars,
      max_working_messages: this.workingCeiling.messages,
      default_working_chars: this.defaultWorkingCeiling.chars,
      default_working_messages: this.defaultWorkingCeiling.messages,
    })
  }

  compactWorkingContext() {
    if (this.compactionDeferred) return
    const overBudget = () => this.messages.length > this.maxWorkingMessages
      || this.messages.reduce((total, message) => total + messageChars(message), 0) > this.maxWorkingChars - injectedSkillChars(this) - injectedRequirementsChars(this) // 2.8 hook: injected skill and requirements text counts
    // 2.9: every fold rewrites the digest and so breaks the provider's cached
    // prefix from the digest onward. Folding only down to the ceiling would
    // fold on every round once the working context is full; folding to a low
    // watermark makes the rounds in between pure appends.
    const overLowWater = () => this.messages.length > this.maxWorkingMessages * COMPACTION_LOW_WATERMARK
      || this.messages.reduce((total, message) => total + messageChars(message), 0) > (this.maxWorkingChars - injectedSkillChars(this) - injectedRequirementsChars(this)) * COMPACTION_LOW_WATERMARK
    if (!overBudget()) return
    while (overLowWater()) {
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
      && (message.content.startsWith('[SKILL_CONTEXT]') || message.content.startsWith(SKILL_OFFERS_PREFIX) || message.content.startsWith(REQUIREMENTS_PREFIX))))
    // 2.9: the skill offers are recomputed per round (shown only while a plan
    // is authored), so they are tail, like steering. Loaded skill context lives
    // for a whole logical task, so it stays in the fixed prefix.
    const offered = insertTailBlock(messages, skillOffersContext(this) ? { role: 'user', content: skillOffersContext(this) } : undefined) // 2.8 hook
    // Live game requirements for the goal's targets: tail too, shown only while a plan is authored or revised.
    const tailed = insertTailBlock(offered, goalRequirementsContext(this) ? { role: 'user', content: goalRequirementsContext(this) } : undefined)
    const skillContext = this.skillContext()
    if (!skillContext) return tailed
    // Skill context belongs to the fixed prefix, which ends before the first
    // model turn. `baseMessages` alone is not that prefix: a budget handoff
    // swaps the working messages for a shorter capsule prefix, and a staged
    // amendment grows `baseMessages` for the next continuation only. Indexing
    // by it put the skill context between an assistant `tool_calls` message
    // and its tool replies (live HTTP 400, 2026-09-25).
    const firstTurn = tailed.findIndex(message => message?.role === 'assistant' || message?.role === 'tool')
    const insertAt = Math.min(this.baseMessages.length, firstTurn < 0 ? tailed.length : firstTurn)
    return [
      ...tailed.slice(0, insertAt),
      { role: 'user', content: skillContext },
      ...tailed.slice(insertAt),
    ]
  }

  markReasoningEpochSeen(key) {
    const epoch = this.memory.planningReasoningEpoch?.(key)
    if (Number.isSafeInteger(epoch) && epoch >= 0) this.planningReasoningEpochSeen.set(key, epoch)
  }

  refreshPlanningReasoningEpoch() {
    const key = this.activePlanKey()
    const epoch = this.memory.planningReasoningEpoch?.(key)
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false
    const previous = this.planningReasoningEpochSeen.get(key)
    this.planningReasoningEpochSeen.set(key, epoch)
    if (previous === undefined || previous === epoch || !this.requestInfo) return false

    // U6: the executor's conversation IS a rebuild from durable state (its packet), and its prefix carries
    // the executor role suffix: a planner-shaped rebuild here would wipe the packet and the role. It keeps
    // its conversation. A planner parked across the bump went stale with it and is dropped, so the slice
    // close builds a fresh planner from a packet.
    if (this.agentContext.role === EXECUTOR_ROLE) {
      const droppedPlanner = this.agentContext.dropParkedPlanner()
      const requestId = this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
      void this.traceEvent('executor.reasoning_epoch_moved', {
        request_id: requestId,
        role: EXECUTOR_ROLE,
        handoff_id: this.agentContext.handoffId,
        reason: 'executor_keeps_packet_across_reasoning_epoch_bump',
        previous_epoch: previous,
        reasoning_epoch: epoch,
        parked_planner_dropped: droppedPlanner,
      }, { requestId })
      return false
    }

    // A reducer epoch bump is an explicit invalidation boundary. Rebuild the
    // working provider context from durable memory and the current user request;
    // never carry tool/scratch exchanges that argued for the predecessor plan.
    this.clearLoadedSkillContext()
    const memoryContext = this.memory.context?.(key) ?? ''
    this.baseMessages = [
      ...this.rolePrefixMessages(this.agentContext.role),
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
    this.pushTimeEstimateContext()
  }

  // 2.6: while a timed step runs, the planner sees its estimate against the
  // elapsed time, and a parallelization prompt when it is long on one lane or
  // has overrun (overrun traced once per step).
  pushTimeEstimateContext() {
    try {
      const context = this.planTiming?.continuationContext(this.peekPlanState(this.activePlanKey()), {
        actorId: this.epoch?.actor_id,
        epoch: this.epoch?.epoch,
      })
      if (!context) return
      this.messages.push({ role: 'user', content: context.text })
      if (context.event) void this.traceEvent(context.event[0], context.event[1])
    }
    catch (error) {
      this.log(`[time] continuation estimate failed: ${error instanceof Error ? error.message : String(error)}`)
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

    // MW1: the placement receipt is what identifies an entity as the NPC's own (a player-built entity is one whose
    // engine last_user is a human the NPC did not stamp). Recorded durably, once per entity.
    this.memory.recordNpcPlacement?.(this.activePlanKey(), {
      unit_number: result.placed_unit_number,
      entity_name: result.entity_name,
      actor_id: Number.isSafeInteger(result.actor_id) ? result.actor_id : this.epoch?.actor_id,
      actor_epoch: this.epoch?.epoch,
      placed_last_user: typeof result.placed_last_user === 'string' ? result.placed_last_user : undefined,
    }, { requestId: this.traceRequest?.id })

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

  // A completion wait on the active step's own checkpoint when it is one
  // output count on a machine last seen working (plan 2.5): the planner sleeps
  // until the checkpoint holds, the machine stops, or the game-data deadline.
  checkpointWaitCandidate(state = this.memory.currentPlan?.(this.activePlanKey()), isWorking = unitNumber => this.liveObservedExactTarget(unitNumber)?.working === true) {
    if (!state || state.status !== 'active' || !state.task_board?.active_step_id) return undefined
    const checkpoint = persistedStepCheckpoint(state.task_board, state.task_board.active_step_id)
    const requirement = checkpointWaitRequirement(checkpoint?.contract, isWorking)
    if (!requirement) return undefined
    return makeConditionWait(requirement, {
      goalId: state.goal_id,
      stepId: state.task_board.active_step_id,
      mode: 'completion',
      actorId: this.epoch?.actor_id,
      actorEpoch: this.epoch?.epoch,
    })
  }

  // `unitNumber` pins the wait to one machine a fresh read has just shown working (repair unit B); without
  // it the most recently observed working machine is used.
  passiveProgressWaitCandidate(state = this.memory.currentPlan?.(this.activePlanKey()), { unitNumber } = {}) {
    if (!state || state.status !== 'active' || !state.task_board?.active_step_id) return undefined
    const observations = [...(this.liveEntityObservations?.values?.() ?? [])].reverse()
    const working = Number.isSafeInteger(unitNumber)
      ? { unit_number: unitNumber }
      : observations.find(observation => Number.isSafeInteger(observation?.unit_number) && observation?.working === true)
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

  // A wait closes its step through the reducer, which only closes admitted work. On a turn with no
  // preflight commit (a zero-operation turn, or a wait-only batch routed here) a still-uncommitted draft is
  // committed as runtime-admitted work (there are no operations to preflight). If the reducer will not
  // admit it, no wait is registered and the caller takes its ordinary path instead of waiting on a step
  // that can never close. Returns the updated plan state, or undefined when nothing was registered.
  async registerCandidateConditionWait(candidate) {
    if (!candidate || !this.requestInfo) return undefined
    const key = this.requestInfo.memoryKey
    const draft = getActivePlanningPlan(this.memory.planningState?.(key))
    if (draft && [PLAN_STATUS.DRAFT, PLAN_STATUS.RUNTIME_VALIDATION, PLAN_STATUS.READY].includes(draft.status)
      && typeof this.memory.commitPlanningPlan === 'function') {
      this.memory.commitPlanningPlan(key, { now: Date.now(), runtime_validation: { passed: true } })
      await this.persistState()
    }
    const planAfter = getActivePlanningPlan(this.memory.planningState?.(key))
    const admitted = !planAfter || FROZEN_PLAN_STATUSES.has(planAfter.status)
    const waiting = admitted ? this.memory.registerConditionWait?.(key, candidate) : undefined
    if (!waiting?.condition_wait) return undefined
    await this.persistState()
    await this.traceEvent('runtime.condition_registered', {
      wait_id: waiting.condition_wait.id,
      goal_id: waiting.goal_id,
      step_id: waiting.task_board?.active_step_id,
      mode: waiting.condition_wait.mode,
      condition: waiting.condition_wait.condition,
    })
    return waiting
  }

  // One fresh, bounded read of one exact machine (repair unit B). The exact condition read answers working
  // state, the checkpoint's output count against its target, and the game-data expectation; getEntityStatus
  // adds input/fuel/output counts when the nearest machine of that name is this unit. No model call. The
  // read replaces any cached observation of the machine. Throws only when the actor epoch changed.
  async readFreshMachine(unitNumber, requirement, { wait } = {}) {
    await this.assertMachineReadFence(wait)
    const known = this.liveObservedExactTarget(unitNumber)
    let raw
    try {
      raw = JSON.parse(String(await this.rcon.command(runtimeConditionCommand(freshReadCondition(unitNumber, requirement)))).trim())
    }
    catch (error) {
      raw = { ok: false, error: `condition_transport_error:${cleanMemoryText(error instanceof Error ? error.message : String(error), 120)}` }
    }
    let entity
    let inventoryRead = 'unavailable'
    if (raw?.ok === true && known?.name) {
      try {
        const text = String(await this.rcon.command(toolCommand('getEntityStatus', { name: known.name, radius: WAIT_FACT_RADIUS }))).slice(0, 200_000)
        const parsed = JSON.parse(text)
        if (parsed?.found === true && parsed.entity?.unit_number === unitNumber) {
          this.recordLiveEntityToolResult('getEntityStatus', text)
          entity = parsed.entity
          inventoryRead = 'matched'
        }
        else {
          inventoryRead = parsed?.found === true ? 'nearest_is_other_unit' : 'not_in_radius'
        }
      }
      catch {
        inventoryRead = 'read_failed'
      }
    }
    if (raw?.ok === true && known && inventoryRead !== 'matched') {
      this.recordLiveEntityObservation({
        ...known,
        working: raw.progressing === true,
        status: Number.isFinite(raw.entity_status) ? raw.entity_status : known.status,
      }, undefined, 'fresh_machine_read', { surface: known.surface, surface_index: known.surface_index })
    }
    await this.assertMachineReadFence(wait)
    return compactMachineFacts({ unitNumber, known, raw, entity, inventoryRead, requirement })
  }

  // A read on behalf of a turn is fenced like any turn work. A read for a condition wait that ended runs with no
  // turn open (the supervisor polls it), so it is fenced the way the wait's own poll is: by the actor and epoch the
  // wait was registered under.
  async assertMachineReadFence(wait) {
    if (!wait) return this.assertCurrent()
    const status = await this.captureEpoch()
    if (!conditionWaitLifecycleMatches(wait, status)) throw new AgentLoopError('NPC actor epoch changed during the condition wake read')
    return status
  }

  // The machines a wait receipt reports on: the ones the active step's committed checkpoint names, else the
  // machine the blind wait was about (the one read when the batch was routed), else the most recently
  // observed working machine.
  waitFactTargets(state, preferredUnits = []) {
    const stepId = state?.task_board?.active_step_id
    const contract = stepId ? persistedStepCheckpoint(state.task_board, stepId)?.contract : undefined
    const requirements = checkpointMachineRequirements(contract)
    if (requirements.length > 0) return requirements.map(requirement => ({ unitNumber: requirement.unit_number, requirement }))
    const preferred = (preferredUnits ?? []).filter(unit => Number.isSafeInteger(unit)).slice(0, WAIT_FACT_MAX_MACHINES)
    if (preferred.length > 0) return preferred.map(unitNumber => ({ unitNumber }))
    const recent = mostRecentWorkingUnit(this.liveEntityObservations?.values?.())
    return Number.isSafeInteger(recent) ? [{ unitNumber: recent }] : []
  }

  // Repair unit B: a batch of only `wait` operations. When the active step's machine is working (checkpoint
  // machine, or the passive-progress machine) the timer never runs; the bounded condition wait is registered
  // through the zero-operation path's registration, so it carries the same actor/epoch/step fences and wakes the
  // model when the checkpoint holds, the machine stops or the game-data deadline passes. Waiting alone never
  // closes a step: only the verified world state does. Otherwise the timer runs as before and its receipt
  // carries a fresh machine read (completed()).
  async routeWaitOnlyBatch({ plan, previousState, remainingCanonicalWork, explicitBlocker }) {
    this.pendingBlindWait = null
    if (!isWaitOnlyBatch(plan?.operations) || !this.requestInfo) return { routed: false }
    const requestId = this.traceRequest?.id
    const stepId = previousState?.task_board?.active_step_id
    let readUnits = []
    const decline = reason => {
      this.pendingBlindWait = { request_id: requestId, step_id: stepId, reason, unit_numbers: readUnits }
      return { routed: false, reason }
    }
    if (!remainingCanonicalWork || explicitBlocker) return decline(explicitBlocker ? 'explicit_blocker' : 'no_remaining_canonical_work')
    if (previousState?.status !== 'active' || !stepId) return decline('no_active_step')

    const traceRouted = (conditionWait, reason, machine) => this.traceEvent('wait.routed_to_condition', {
      request_id: requestId,
      step_id: stepId,
      wait_id: conditionWait.id,
      unit_number: conditionWait.condition?.unit_number,
      reason,
      mode: conditionWait.mode,
      requested_ticks: waitOnlyTicks(plan.operations),
      operation_count: plan.operations.length,
      ...(machine ? { machine } : {}),
    })
    const existing = previousState.condition_wait?.state === 'active' ? previousState.condition_wait : undefined
    if (existing) {
      await traceRouted(existing, 'condition_wait_already_active')
      return { routed: true, conditionWait: existing }
    }

    const contract = persistedStepCheckpoint(previousState.task_board, stepId)?.contract
    const requirement = checkpointWaitRequirement(contract, () => true)
    const unitNumber = requirement?.unit_number ?? mostRecentWorkingUnit(this.liveEntityObservations?.values?.())
    if (!Number.isSafeInteger(unitNumber)) return decline('no_machine_known')
    // The cached working flag may be arbitrarily stale (it dates from whenever the model last looked), so the
    // machine is read once now and that answer decides.
    const fresh = await this.readFreshMachine(unitNumber, requirement)
    readUnits = [unitNumber]
    if (fresh.working !== true) return decline(requirement ? 'checkpoint_machine_not_working' : 'machine_not_working')
    const candidate = requirement
      ? this.checkpointWaitCandidate(previousState, unit => unit === unitNumber)
      : this.passiveProgressWaitCandidate(previousState, { unitNumber })
    if (!candidate) return decline('no_condition_wait_candidate')
    const waiting = await this.registerCandidateConditionWait(candidate)
    if (!waiting?.condition_wait) return decline('condition_wait_not_admitted')
    await traceRouted(
      waiting.condition_wait,
      requirement ? 'checkpoint_machine_working' : 'passive_progress_machine_working',
      fresh,
    )
    return { routed: true, conditionWait: waiting.condition_wait }
  }

  // The fresh machine read a blind wait's receipt carries (repair unit B). Fact reporting only: the line says
  // what the machines hold now and that elapsed time proves nothing. Never throws except on an epoch change.
  async blindWaitReceiptFacts(receipt) {
    const types = receipt?.view?.last_completed_batch?.task_types
    const waitOnly = Array.isArray(types) && types.length > 0 && types.every(type => type === 'waiting')
    const pending = this.pendingBlindWait
    this.pendingBlindWait = null
    if (!waitOnly) return undefined
    const state = this.peekPlanState(this.activePlanKey())
    let machines = []
    try {
      for (const target of this.waitFactTargets(state, pending?.unit_numbers).slice(0, WAIT_FACT_MAX_MACHINES)) {
        machines.push(await this.readFreshMachine(target.unitNumber, target.requirement))
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/epoch changed|cancelled|superseded/i.test(message)) throw error
      machines = [{ error: `fresh_read_failed:${cleanMemoryText(message, 120)}` }]
    }
    await this.traceEvent('wait.blind_with_fresh_read', {
      request_id: this.traceRequest?.id ?? pending?.request_id,
      wait_request_id: pending?.request_id,
      step_id: state?.task_board?.active_step_id ?? pending?.step_id,
      unit_numbers: machines.map(machine => machine.unit_number).filter(unit => Number.isSafeInteger(unit)),
      reason: pending?.reason ?? 'wait_only_batch_receipt',
      machines,
    })
    if (machines.length === 0) return undefined
    return `[HARNESS] Fresh machine read taken after the wait (facts only; time passing is not evidence that the step is done): ${JSON.stringify({ machines })}`
  }

  // The concrete state a routed condition wait ended on (repair unit B): the cause, and a fresh read of the
  // machine for every end except a verified one (whose evidence is the observation itself).
  async conditionWakeFacts({ action, reason, wait, observation, timing }) {
    const unitNumber = wait?.condition?.unit_number
    const lifecycle = typeof reason === 'string' && reason.startsWith('condition_lifecycle')
    let machine
    if (action !== 'verified' && !lifecycle && Number.isSafeInteger(unitNumber)) {
      try {
        machine = await this.readFreshMachine(unitNumber, wait.mode === 'completion' && wait.condition?.kind === 'entity_inventory_count' ? wait.condition : undefined, { wait })
      }
      catch (error) {
        machine = { unit_number: unitNumber, error: `fresh_read_failed:${cleanMemoryText(error instanceof Error ? error.message : String(error), 120)}` }
      }
    }
    return {
      cause: conditionWakeCause({ action, reason, machine }),
      ...(wait?.condition ? { condition: wait.condition } : {}),
      ...(action === 'verified'
        ? { evidence: observation }
        : { observation: { satisfied: observation?.satisfied === true, progressing: observation?.progressing === true } }),
      ...(machine ? { machine } : {}),
      ...(timing ?? {}),
    }
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
    // Plan 2.5: the machine's expected finish from game data sets the wake
    // deadline and the expected finish the planner sees.
    const schedule = scheduleWait(wait, normalizedObservation.eta)
    const result = applyConditionObservation(schedule.wait, normalizedObservation)
    return {
      action: result.action,
      healthy: result.action === 'waiting',
      state: current,
      wait: schedule.wait,
      identity,
      observation: normalizedObservation,
      result,
      scheduled: schedule.scheduled,
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
        if (inspected.scheduled) {
          await this.traceEvent('runtime.condition_scheduled', {
            wait_id: identity.wait_id,
            goal_id: identity.goal_id,
            step_id: identity.step_id,
            unit_number: result.wait?.condition?.unit_number,
            mode: result.wait?.mode,
            expected_seconds: result.wait?.expected_seconds,
            timeout_ms: result.wait?.timeout_ms,
            max_checks: result.wait?.max_checks,
            limited_by: result.wait?.eta_limited_by,
            eta: normalizedObservation?.eta,
            basis: WAIT_BASIS,
          })
        }
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
        if (reduced?.decision?.accepted !== true) {
          // The reducer would not close the step (3.3 move 5), so the board did
          // not move and the wait must not keep re-verifying it: hand the
          // decision back to the planner instead.
          const state = this.memory.clearConditionWait?.(key, identity.wait_id) ?? reduced?.state
          await this.persistState()
          if (reduced?.progressDisagreement) await this.traceEvent('step.progress_disagreement', { trigger: 'condition_wait', ...reduced.progressDisagreement })
          if (reduced?.decision?.paused === true) {
            const chatMessage = `I paused this goal: my plan tracker and my task board disagree about which step is active, so I stopped instead of guessing. ${RESUME_HINT}`
            await this.traceEvent('step.progress_disagreement_paused', { trigger: 'condition_wait', ...(reduced.progressDisagreement ?? {}) })
            return { action: 'paused', wait_id: identity.wait_id, state, chat_message: chatMessage }
          }
          await this.declineStepClose('condition_wait', reduced?.decision?.rejection_reason || 'outcome_authority_rejected_completion', {
            wait_id: identity.wait_id,
          })
          return { action: 'wake', wait_id: identity.wait_id, reason: reduced?.decision?.rejection_reason || 'step_close_declined', state }
        }
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
        await this.rollProviderBudgetAtStepClose('condition_wait', reduced?.state)
        const facts = await this.conditionWakeFacts({ action: 'verified', wait, observation: normalizedObservation })
        return { action: 'verified', wait_id: identity.wait_id, state: reduced?.state, observation: normalizedObservation, facts }
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
      // Expected vs elapsed is a fact for the woken planner, not a guess.
      const timing = Number.isFinite(wait?.expected_seconds)
        ? { expected_seconds: wait.expected_seconds, elapsed_seconds: Math.round((Date.now() - wait.registered_at) / 100) / 10 }
        : {}
      // Repair unit B: the woken model gets the concrete state (cause plus a fresh machine read), not only a reason code.
      const facts = await this.conditionWakeFacts({ action: result.action, reason: result.reason, wait, observation: normalizedObservation, timing })
      await this.traceEvent(event, {
        wait_id: identity.wait_id,
        condition: wait?.condition,
        reason: result.reason,
        observation: normalizedObservation,
        facts,
        ...timing,
      })
      return { action: result.action, wait_id: identity.wait_id, state: updated, reason: result.reason, observation: normalizedObservation, facts, ...timing }
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
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 8_000_000)
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
    if (intent === 'new_goal') {
      this.goalReading = null
      this.jevObservationLog = []
    }
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
      ...this.jevObservationContext(intent === 'new_goal' ? undefined : planState),
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
    if (reduced?.progressDisagreement) await this.traceEvent('step.progress_disagreement', { trigger, ...reduced.progressDisagreement })
    if (reduced?.decision?.accepted !== true) {
      const declined = await this.declineStepClose(trigger, reduced?.decision?.rejection_reason || 'outcome_authority_rejected_completion', {
        active_step_id: step.id,
        contract,
      })
      return {
        ...declined,
        state: reduced?.state,
        ...(reduced?.decision?.paused === true ? { paused: true, disagreement: reduced.progressDisagreement } : {}),
      }
    }
    await this.traceEvent('step.verified', {
      active_step_id: step.id,
      source,
      contract,
      task_board: visibleTaskBoard(reduced?.state?.task_board),
    })
    await this.rollProviderBudgetAtStepClose(source ?? trigger, reduced.state)
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
      save_progress: (await this.readGoalProgressFacts()) ?? null,
    }

    const steeringQuestionOptions = {
      candidateShelfNodes: state.roadmap?.nodes ?? [],
      pressureVocabulary: askableSteeringPressures(state),
      pressureDefinitions: steeringPressureDefinitions(),
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

  // One line for the model when a finished batch left a prose-only step open:
  // it names the missing contract and both ways to close the step. The Plan
  // Tracker id is the one [PLANNING_STATE] shows; the Task Board alias (step_N,
  // shown in [RUNTIME_COMPAT_STATE]) is accepted for the same step.
  stepStaysOpenHint(state) {
    const board = state?.task_board
    const index = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const step = index === undefined ? undefined : board?.steps?.[index]
    if (!step) return ''
    const tracker = getActivePlanningPlan(this.memory.planningState?.(this.activePlanKey()))
    const trackerId = tracker?.active_step_index === index ? tracker?.steps?.[index]?.step_id : undefined
    const stepId = trackerId ?? step.id
    const alias = trackerId && trackerId !== step.id ? ` (also accepted: ${step.id})` : ''
    return `[HARNESS] Step ${JSON.stringify(cleanMemoryText(step.description, 100))} stays open: it has no completion contract, so a finished batch cannot close it. In your next submitPlan add checkpoint {mode,requirements} for the world state that proves it, or semanticCompletion {"stepId":"${stepId}"}${alias} if your evidence already shows it is done.`
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
        ...(closed.paused ? { paused: true, disagreement: closed.disagreement } : {}),
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

  // The deterministic checks for work the RUNTIME already owns at a step boundary: queued or running Autorio work, a
  // healthy persistent controller, an active condition wait. ONE implementation, shared by the post-step gate below and
  // by the C4 judgment (jev-checkpoints.mjs): a boundary where any of them holds is never handed to a judgment, so a
  // deciding C4 route can never wake the executor over work the runtime owns. It also keeps latestCompletedBatchId
  // current, which the gate did as a side effect.
  async inspectAuthoritativeRuntime(receipt) {
    const persistentRuntime = await this.persistentRuntimeStatus()
    const autorioStatus = receipt?.view && typeof receipt.view === 'object'
      ? receipt.view
      : (receipt?.providerStatus && typeof receipt.providerStatus === 'object' ? receipt.providerStatus : {})
    if (Number.isSafeInteger(autorioStatus?.last_completed_batch?.batch_id)) {
      this.latestCompletedBatchId = autorioStatus.last_completed_batch.batch_id
    }
    // MW2: the latest game tick a runtime receipt carried; the ledger records it as aging data (15 game-minutes).
    if (Number.isSafeInteger(autorioStatus?.last_completed_batch?.tick)) {
      this.latestGameTick = Math.max(this.latestGameTick ?? 0, autorioStatus.last_completed_batch.tick)
    }
    const autorioRuntimeHealthy = interactionRuntimeHealthy(autorioStatus)
    const persistentControllerHealthy = persistentRuntimeHealthy(persistentRuntime)
    const conditionValidation = await this.validateConditionWaitHealth()
    const conditionWaitHealthy = conditionValidation.healthy === true
    const runtimeHealthy = autorioRuntimeHealthy || persistentControllerHealthy || conditionWaitHealthy
    const runtimeReason = autorioRuntimeHealthy
      ? 'autorio_active_work'
      : persistentControllerHealthy
        ? 'persistent_controller_active'
        : conditionWaitHealthy
          ? 'condition_wait_active'
          : ''
    return { persistentRuntime, autorioStatus, autorioRuntimeHealthy, persistentControllerHealthy, conditionValidation, conditionWaitHealthy, runtimeHealthy, runtimeReason }
  }

  // `inspected`: the runtime inspection C4 already made for this very receipt (one read per step close).
  async routePostStepDecision(receipt, { boundary = 'completion', failure = '', inspected: shared } = {}) {
    const generation = this.generation
    const current = await this.assertCurrent()
    const inspected = shared ?? await this.inspectAuthoritativeRuntime(receipt)
    const { persistentRuntime, autorioStatus, autorioRuntimeHealthy, persistentControllerHealthy } = inspected
    const planState = this.memory.planByNpc?.get?.(this.activePlanKey()) ?? this.memory.currentPlan?.(this.activePlanKey())
    let { conditionValidation, conditionWaitHealthy, runtimeHealthy, runtimeReason } = inspected

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
      ...this.jevObservationContext(planState),
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
      if (plannerShape && appliedRoute === 'targeted_observation') {
        const floored = observeRouteRelevanceFloor(plannerShape.observation_relevance)
        if (floored !== plannerShape.observation_relevance) {
          plannerShape.observation_relevance = floored
          plannerShape.observation_budget = floored.budget
        }
      }
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

  // A deferred user amendment is user steering: it belongs to the planner, never to the executor (whose
  // prompt forbids revising the plan). During an executor slice control returns to the planner first and
  // the text is staged in ITS conversation; when that cannot happen (a round is open) the amendment is not
  // deferred and takes the cancelling amend route instead. The flag is tied to the conversation that holds
  // the text (currentPendingAmendment) and dies with it.
  async stageCompatibleAmendment(sender, text) {
    if (!this.active || !this.epoch || !Array.isArray(this.baseMessages)) return false
    if (this.agentContext.role === EXECUTOR_ROLE) {
      const requestId = this.traceRequest?.id
      const returned = await this.returnControlToPlanner({
        route: 'amend_current',
        planningState: this.memory.planningState?.(this.activePlanKey()),
        withinTurn: false,
        reason: 'user_amendment',
        requestId,
      })
      if (!returned.returned) {
        await this.traceEvent('amendment.not_deferred', { request_id: requestId, reason: `planner_not_reachable:${returned.reason ?? 'restage_failed'}`, role: EXECUTOR_ROLE }, { requestId })
        return false
      }
    }
    const content = `[CHAT] ${cleanMemoryText(sender, 128)}: ${cleanMemoryText(text, 4000)}`
    const alreadyPresent = this.baseMessages.some(message => message?.role === 'user' && message?.content === content)
    if (!alreadyPresent) this.baseMessages.push({ role: 'user', content })
    this.pendingInteractionAmendment = { sender: cleanMemoryText(sender, 128), text: cleanMemoryText(text, 4000) }
    this.pendingAmendmentConversationSeq = this.agentContext.conversationSeq
    return true
  }

  // The staged amendment, if the conversation that holds its text is still the one acting. A restage, a
  // return to the planner or a reset drops that text; the flag must not outlive it.
  currentPendingAmendment() {
    const pending = this.pendingInteractionAmendment
    if (!pending) return null
    const seq = this.pendingAmendmentConversationSeq
    if (seq === undefined || seq === this.agentContext.conversationSeq) return pending
    this.dropPendingAmendment('conversation_holding_the_amendment_text_was_replaced')
    return null
  }

  // The staged amendment is being dropped. The player was told it would be applied, so they are told it
  // was not: a chat line (the supervisor prints `amendment.dropped`'s chat_message) asks them to send it
  // again. Both rows carry the request id and the reason.
  dropPendingAmendment(reason) {
    const pending = this.pendingInteractionAmendment
    this.pendingInteractionAmendment = null
    this.pendingAmendmentConversationSeq = undefined
    if (!pending || typeof this.traceEvent !== 'function') return
    const requestId = this.traceRequest?.id ?? this.turnScope?.getStore?.()?.requestId
    const preview = cleanMemoryText(pending.text, 120)
    void this.traceEvent('amendment.flag_cleared', {
      request_id: requestId,
      reason,
      role: this.agentContext.role,
      handoff_id: this.agentContext.handoffId,
    }, { requestId })
    void this.traceEvent('amendment.dropped', {
      request_id: requestId,
      reason,
      sender: pending.sender,
      chat_message: `Your change "${preview}" was not applied: the conversation that held it was replaced before I could use it (${reason}). Please send it again.`,
    }, { requestId })
  }

  // MW2: a new player goal displaces the running one. The running task is MOVED into the durable task ledger (its committed
  // plan, verified progress, requested result and destination) before the context is cleared, so it can be resumed later
  // instead of being lost. The request id is minted here so the ledger trace and the new request share it. A refusal is
  // traced by the memory facade (task_ledger.refused) and leaves the previous behaviour untouched.
  async recordInterruptedTask(memoryKey, { sender, text, epoch } = {}) {
    if (typeof this.memory.interruptActiveTask !== 'function') return undefined
    const planning = this.memory.planningState?.(memoryKey)
    if (planning?.goal?.status !== 'active') return undefined
    this.preMintedRequestId = `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`
    const actor = epoch ?? this.epoch
    const result = this.memory.interruptActiveTask(memoryKey, {
      interruptedBy: { kind: 'new_goal', sender: cleanMemoryText(sender, 128) },
      detail: `Displaced by a new request: ${cleanMemoryText(text, 160)}`,
      actor: actor ? { actor_id: actor.actor_id, epoch: actor.epoch } : undefined,
      gameTick: this.latestGameTick,
      requestId: this.preMintedRequestId,
    })
    if (result?.ok) await this.persistState()
    return result
  }

  // --- MW2b operation reconciliation -----------------------------------------------------------------------------------------

  async readTaskStatusRaw() {
    try {
      return String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 8_000_000)
    }
    catch {
      return undefined
    }
  }

  // Written BEFORE the batch is sent: what is about to be sent, for which plan step, by which actor and epoch, and where the
  // mod's batch counter stood. A lost acknowledgement or a restart then has something exact to reconcile against.
  async recordPendingOperationBeforeSend(operations, before) {
    if (!this.requestInfo || typeof this.memory.recordPendingOperation !== 'function') return undefined
    const key = this.requestInfo.memoryKey
    const planning = this.memory.planningState?.(key)
    const plan = planning ? getActivePlanningPlan(planning) : undefined
    const step = plan?.steps?.[plan.active_step_index]
    const baseline = batchWatermark(await this.readTaskStatusRaw()) ?? null
    const record = this.memory.recordPendingOperation(key, buildPendingOperation({
      requestId: this.traceRequest?.id,
      operationKey: `${this.traceRequest?.id ?? 'request'}/batch_${(planning?.operation_ledger?.sequence ?? 0) + 1}`,
      ordinal: (planning?.operation_ledger?.sequence ?? 0) + 1,
      protocolVersion: 2,
      operations,
      goalId: planning?.goal?.goal_id,
      planId: plan?.plan_id,
      stepId: step?.step_id,
      actor: { actor_id: before?.actor_id, epoch: before?.epoch },
      baseline,
      now: Date.now(),
    }), { requestId: this.traceRequest?.id })
    if (!record) {
      const held = this.memory.pendingOperations?.(key)?.length ?? 0
      const full = held >= OPERATION_LEDGER_LIMIT
      await this.traceEvent(full ? 'operation.ledger_full' : 'operation.record_refused', {
        request_id: this.traceRequest?.id, reason: full ? 'unresolved_operation_ledger_at_capacity' : 'record_refused_no_active_goal_or_invalid',
        unresolved: held, limit: OPERATION_LEDGER_LIMIT,
      })
      throw new AgentLoopError('Operation ledger full or record refused; no operation sent')
    }
    await this.persistState()
    return record
  }

  // A prepared attempt the game provably never saw (rejected before transport, or the game refused it before recording
  // anything): settle it as not happened so it leaves no hold.
  async settleUnsentOperation(pending, ownerKey, reason) {
    this.memory.updatePendingOperation?.(ownerKey, { effect: EFFECT.NOT_HAPPENED, reason }, pending.operation_key)
    if (this.memory.clearPendingOperation?.(ownerKey, { operationKey: pending.operation_key }) !== true) {
      await this.traceEvent('operation.settlement_refused', { request_id: pending.request_id, operation_key: pending.operation_key,
        reason: 'unsent_settlement_refused', attempted_reason: reason })
      throw new AgentLoopError('Prepared operation settlement refused')
    }
    await this.persistState()
    await this.traceEvent('operation.not_sent', { request_id: pending.request_id, operation_key: pending.operation_key, reason })
  }

  // A legacy (pre-journal) record that neither exact nor baseline evidence can settle must not hold silently: raise one
  // question the user can answer (idempotent per record).
  async surfaceLegacyOperation(memoryKey, pending, result, requestId) {
    if (pending?.legacy !== true || typeof this.memory.raiseOperationEffectQuestion !== 'function') return
    if ([RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.ADMITTED_IN_FLIGHT, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION].includes(result.verdict)) return
    const raised = this.memory.raiseOperationEffectQuestion(memoryKey, pending, { reason: result.reason, requestId })
    await this.persistState()
    await this.traceEvent('operation.legacy_unresolved', {
      request_id: requestId, operation_key: pending.operation_key, reason: result.reason,
      question_id: raised?.question?.question_id ?? null, already_pending: raised?.duplicate === true,
    }, { requestId })
  }

  // Reconcile the outstanding batch against the game's own batch records (exact batch id / generation / actor / epoch
  // correlation) and trace the verdict. A batch proven not to have reached the game is cleared (it may be issued again); one
  // proven or possibly admitted stays as the duplicate guard until its receipt settles it or its step is left.
  async reconcileOutstandingOperation({ trigger, requestId, operationKey } = {}) {
    if (typeof this.memory.pendingOperation !== 'function') return undefined
    const key = this.activePlanKey()
    const records = this.memory.pendingOperations?.(key) ?? [this.memory.pendingOperation(key)].filter(Boolean)
    if (!operationKey && records.length > 1) {
      let result
      for (const record of records) result = await this.reconcileOutstandingOperation({ trigger, requestId, operationKey: record.operation_key })
      return result
    }
    const pending = operationKey ? records.find(record => record.operation_key === operationKey) : records.at(-1)
    if (!pending) return undefined
    const rid = requestId ?? this.traceRequest?.id ?? `reconcile_${Date.now().toString(36)}`
    let actor
    try {
      const current = await super.captureEpoch()
      actor = { actor_id: current.actor_id, epoch: current.epoch }
    }
    catch {}
    const result = reconcilePendingOperation(pending, { status: await this.readTaskStatusRaw(), actor })
    const admitted = [RECONCILE_VERDICT.ADMITTED_IN_FLIGHT, RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.ADMITTED_CANCELLED].includes(result.verdict)
    let held = pending
    if ([RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION].includes(result.verdict)) {
      this.memory.clearPendingOperation?.(key, { operationKey: pending.operation_key })
    }
    else {
      held = this.memory.updatePendingOperation?.(key, {
        state: admitted ? PENDING_STATE.ADMITTED : PENDING_STATE.UNRECONCILED,
        effect: result.effect,
        verdict: result.verdict,
        reason: result.reason,
        batch_id: result.batch_id ?? null,
        reconciled_at: Date.now(),
      }, pending.operation_key) ?? pending
    }
    await this.persistState()
    await this.traceEvent('operation.reconciled', {
      request_id: rid,
      trigger,
      ...reconciliationFacts(result, pending),
      sent_operations: result.sent_operations,
      signature: pending.signature,
      plan_id: pending.plan_id,
      step_id: pending.step_id,
    }, { requestId: rid })
    if (result.verdict === RECONCILE_VERDICT.STALE_ACTOR) {
      await this.traceEvent('operation.stale_refused', {
        request_id: rid,
        trigger,
        reason: result.reason,
        operation_key: pending.operation_key,
        pending_actor: pending.actor,
        current_actor: actor ?? null,
      }, { requestId: rid })
    }
    await this.surfaceLegacyOperation(key, pending, result, rid)
    return { ...result, admitted, pending: held ?? pending, request_id: rid }
  }

  // An idle receipt settles a batch only when its effect is proven complete or absent. Cancellation may leave a partial
  // effect, and an acknowledgement before a mod reload cannot establish what survived: both keep the duplicate guard.
  async settleOutstandingOperation(rawStatus, operationKey) {
    try {
      if (typeof this.memory.pendingOperation !== 'function') return
      const key = this.activePlanKey()
      const records = this.memory.pendingOperations?.(key) ?? [this.memory.pendingOperation(key)].filter(Boolean)
      if (!operationKey && records.length > 1) {
        for (const record of records) await this.settleOutstandingOperation(rawStatus, record.operation_key)
        return
      }
      const pending = operationKey ? records.find(record => record.operation_key === operationKey) : records.at(-1)
      if (!pending) return
      const watermark = batchWatermark(rawStatus)
      if (!watermark || watermark.idle !== true || watermark.queue_length !== 0) return
      const actor = this.epoch ? { actor_id: this.epoch.actor_id, epoch: this.epoch.epoch } : undefined
      const result = reconcilePendingOperation(pending, { status: rawStatus, actor })
      const provable = [RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION].includes(result.verdict)
      const settled = provable && this.memory.clearPendingOperation?.(key, { operationKey: pending.operation_key }) === true
      const rid = this.traceRequest?.id ?? pending.operation_key.split('/')[0]
      // The ordinary case (acknowledged, then its receipt) settles silently; only a batch whose acknowledgement was lost or whose
      // lineage is in doubt is worth a reconciliation row.
      if (pending.state !== PENDING_STATE.ACKNOWLEDGED || !provable || result.verdict === RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION) {
        await this.traceEvent('operation.reconciled', {
          request_id: rid,
          trigger: 'receipt',
          ...reconciliationFacts(result, pending),
          settled,
          signature: pending.signature,
          plan_id: pending.plan_id,
          step_id: pending.step_id,
        }, { requestId: rid })
      }
      if (result.verdict === RECONCILE_VERDICT.STALE_ACTOR) {
        await this.traceEvent('operation.stale_refused', {
          request_id: rid,
          trigger: 'receipt',
          reason: result.reason,
          operation_key: pending.operation_key,
          pending_actor: pending.actor,
          current_actor: actor ?? null,
        }, { requestId: rid })
      }
      if (provable) {
        if (!settled) {
          await this.traceEvent('operation.settlement_refused', { request_id: rid, operation_key: pending.operation_key,
            reason: 'exact_settlement_refused', verdict: result.verdict }, { requestId: rid })
          throw new AgentLoopError('Exact operation settlement refused; unresolved record retained')
        }
        await this.persistState()
      }
      else {
        this.memory.updatePendingOperation?.(key, {
          state: result.verdict === RECONCILE_VERDICT.ADMITTED_CANCELLED ? PENDING_STATE.ADMITTED : PENDING_STATE.UNRECONCILED,
          effect: result.effect,
          verdict: result.verdict,
          reason: result.reason,
          batch_id: result.batch_id ?? null,
          reconciled_at: Date.now(),
        }, pending.operation_key)
        await this.persistState()
      }
    }
    catch (error) {
      this.log(`[reconcile] settle failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // MW2: bring the most recently interrupted runnable task (or the named one) back as the running task. Pure state: the
  // committed plan, verified progress and compatibility board come back exactly as they stopped; no model turn and no
  // operation is started here. The supervisor then runs the ordinary recovery path (re-observe, never replay).
  async resumeInterruptedTask({ taskId, reason, requestId } = {}) {
    if (typeof this.memory.resumeTask !== 'function') return undefined
    await this.loadPersistentState()
    const memoryKey = this.activePlanKey()
    const result = this.memory.resumeTask(memoryKey, {
      taskId,
      reason,
      requestId,
      gameTick: this.latestGameTick,
      source: 'runtime',
    })
    if (result?.ok) {
      this.planUpdateReason = 'recovery'
      await this.persistState()
    }
    return result
  }

  async request(text, options = {}) {
    const requestStartedAt = Date.now() // 2.10: time zero for reply-latency metrics
    this.preMintedRequestId = undefined
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

    // A bare Resume/continue on the goal a restart paused before its first plan re-drives that goal.
    const redriveGoal = isBareContinuation(text) ? this.redrivableGoalWithoutPlan(memoryKey) : undefined
    if (redriveGoal) routed.route = { ...routed.route, intent: 'continue_current', queue_conflict: false, reply: '' }
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

    if (!routed.router_bypassed && intent === 'continue_current' && healthyRuntime && !redriveGoal) {
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
      const reply = !state
        ? 'There is no active goal to cancel.'
        : state.status === 'blocked'
          ? 'Cancelled the remaining Autorio work. The plan is still blocked and waiting for your Revise or Cancel choice.'
          : 'Cancelled the remaining Autorio work and paused the current goal.'
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
    if (!routed.router_bypassed && intent === 'continue_current' && !planBefore && !healthyRuntime && !redriveGoal) {
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
      if (await this.stageCompatibleAmendment(sender, text)) {
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
      await this.recordInterruptedTask(memoryKey, { sender, text, epoch: routed.epoch })
      this.memory.clearTaskContext?.(memoryKey)
      await this.persistState()
    }

    if (redriveGoal) {
      // Same goal, same objective: the request below plans it from the goal text (the first plan
      // of the goal still carries the goal definition); the run is no longer paused.
      text = redriveGoal.objective
      this.memory.dispatchPlanningEvent?.(memoryKey, { type: PLANNING_EVENT.RUN_RESUMED, source: 'runtime', goal_id: redriveGoal.goal_id, reason: 'resume_before_first_plan', now: Date.now() })
      await this.persistState()
      await this.traceEvent('goal.redriven_after_restart', { goal_id: redriveGoal.goal_id, reason: RESTART_BEFORE_FIRST_PLAN_PAUSE, model_woken: true }, { requestId: this.traceRequest?.id ?? `redrive_${Date.now().toString(36)}` })
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
    this.authorizationRefusalRetries = 0
    this.duplicateEffectRetries = 0
    this.duplicateEffectHold = null
    this.lostAckRetries = 0
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
    this.providerBudgetStepMark = providerBudgetStepMark(planBefore)
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
    this.unmetGoalContinuationUsed = false
    this.inTurnSliceContinuations = 0
    this.pendingDroppedOperationsNote = ''
    this.lastGoalEvaluation = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    // C5 on Resume: a resumed budget handoff, or a Resume after the request
    // output ceiling / a generation-cap pause, restages from a handoff packet as
    // soon as the request's turn starts (applyStartRestage). The legacy capsule
    // is staged only as the fallback for a refused restage.
    const resumeAfterBudgetPause = intent === 'continue_current'
      && planBefore?.status === 'paused'
      && /^(request_output_ceiling|provider_output_budget_exhausted|recoverable_provider_failure:provider_budget)\b/.test(String(planBefore.pause_reason ?? ''))
    let pendingStartRestage
    if (resumeProviderBudgetHandoff || resumeAfterBudgetPause) {
      const recovery = planBefore.provider_recovery
      const semanticScope = resumeProviderBudgetHandoff ? (recovery.semantic_scope ?? 'keep_target') : 'keep_target'
      const reason = resumeProviderBudgetHandoff
        ? (recovery.reason || 'provider_budget_handoff_resume')
        : String(planBefore.pause_reason)
      pendingStartRestage = {
        reason,
        semanticScope,
        // The recovery capsule of an action-omission repair rides on top of the packet.
        extraMessage: resumeActionOmission ? actionOmissionRecoveryCapsule(planBefore, taskStatus) : undefined,
        runtime: taskStatus,
      }
      if (resumeProviderBudgetHandoff) {
        const budgetCapsule = providerBudgetHandoffCapsule(planBefore, taskStatus, reason, semanticScope)
        const repairCapsule = resumeActionOmission ? `\n${actionOmissionRecoveryCapsule(planBefore, taskStatus)}` : ''
        this.memory.setNextContextOverride?.(memoryKey, `${budgetCapsule}${repairCapsule}`)
      }
    }
    else if (resumeActionOmission) {
      this.memory.setNextContextOverride?.(memoryKey, actionOmissionRecoveryCapsule(planBefore, taskStatus))
    }
    if (this.traceRequest) await this.traceEvent('request.superseded', { usage: this.traceRequest.usage })
    this.traceRequest = {
      id: this.preMintedRequestId ?? `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
      usage: emptyUsageSummary(),
      // A request that starts on a paused goal and leaves it paused for the
      // same reason did not pause it (goal.paused is for new pauses).
      start_status: planBefore?.status,
      start_pause_reason: planBefore?.pause_reason,
    }
    await this.traceEvent('request.received', {
      sender,
      text,
      interaction_intent: intent,
      action_omission_recovery: resumeActionOmission,
      provider_budget_handoff_resume: resumeProviderBudgetHandoff,
      intake_ms: Date.now() - requestStartedAt,
    })
    // 2.10: one acknowledgement, from the goal text and route, before any
    // planner round. A player request only: recovery runs never enter here.
    const acknowledgement = this.chatAcknowledger.acknowledge({ requestId: this.traceRequest.id, text, intent, origin: 'chat', startedAt: requestStartedAt })
    if (acknowledgement) await this.traceEvent('chat.acknowledged', acknowledgement)

    // Goal admission is the reducer's (GOAL_ACCEPTED), and it happens at
    // `new_goal` whether or not a steering provider is configured. Steering
    // advice is the only part that needs a provider.
    if (intent === 'new_goal' && typeof this.memory.admitPlanningGoal === 'function') {
      const admitted = this.memory.admitPlanningGoal(memoryKey, {
        owner: sender,
        objective: text,
        now: Date.now(),
      })
      if (admitted?.goal && this.steeringDecisionProvider
        && typeof this.memory.evaluateSteeringAtBoundary === 'function') {
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
      else if (admitted?.goal) {
        // No steering provider: the reducer's default (maintain) steering is
        // recorded by ensurePlanningDraft at the first draft, as before.
        await this.persistState()
        await this.traceEvent('planning.goal_admitted', { goal_id: admitted.goal.goal_id })
      }
    }

    await ensureSkillOffers(this, { memoryKey, intent, text }) // 2.8 hook: skill-offers.mjs
    await ensureGoalRequirements(this, { memoryKey, intent }) // goal-requirements.mjs: reset on a new goal, re-read on a revision
    try {
      this.chatRequestPending = true
      this.startRestage = pendingStartRestage // consumed by the first turn (applyStartRestage); cleared in the finally below whatever happens
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
      this.chatRequestPending = false
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
      this.startRestage = undefined
      this.reasoningBudgetOverride = previousReasoningBudget
      this.observationBudgetOverride = previousObservationBudget
      this.observationBudgetRemaining = previousObservationBudgetRemaining
      this.observationRelevanceOverride = previousObservationRelevance
      this.planningHorizonOverride = previousPlanningHorizon
    }
  }

  // A restart found an active goal that never got a plan: pause its run in the reducer (goal
  // and plan content untouched) so the stall is visible, and wake no model. Returns
  // { goal_id, paused }.
  async pauseGoalWithoutPlan(reason, { requestId } = {}) {
    await this.loadPersistentState()
    const key = this.activePlanKey()
    const before = this.memory.planningState?.(key)
    if (!before?.goal || before.goal.status !== GOAL_STATUS.ACTIVE || getActivePlanningPlan(before)) return { goal_id: before?.goal?.goal_id, paused: false }
    const after = this.memory.dispatchPlanningEvent?.(key, { type: PLANNING_EVENT.RUN_PAUSED, source: 'runtime', goal_id: before.goal.goal_id, reason, now: Date.now() })
    await this.persistState()
    return { goal_id: before.goal.goal_id, paused: after?.run?.paused === true, requestId }
  }

  // Resume of that pause: the goal is re-driven from its own objective (no plan exists to
  // continue, and a bare "continue" must never become the objective of a new goal).
  redrivableGoalWithoutPlan(key) {
    const planning = this.memory.planningState?.(key)
    if (!planning?.goal || planning.goal.status !== GOAL_STATUS.ACTIVE || getActivePlanningPlan(planning)) return undefined
    if (this.memory.currentPlan?.(key)) return undefined
    if (planning.run?.paused !== true || planning.run.pause_reason !== RESTART_BEFORE_FIRST_PLAN_PAUSE) return undefined
    return planning.goal
  }

  async pausePersistentPlan(reason = 'user_stop') {
    await this.loadPersistentState()
    const key = this.activePlanKey()
    const state = this.memory.pausePlan?.(key, reason)
    await this.persistState()
    // Outside a request (the supervisor pausing a plan a failed request left
    // stranded, or a user stop) no terminal event follows, so name the pause
    // here, keyed by the request that just ended. Inside a request the
    // terminal event carries it.
    if (!this.traceRequest) {
      const paused = this.goalPausedTrace('pause_persistent_plan')
      if (paused) await this.traceEvent('goal.paused', paused, { requestId: paused.request_id })
    }
    abortSkillChoice(this, reason) // 2.8 hook: stop, identity/actor change
    super.cancel()
    return state
  }

  async finalizeCompletedTaskContext() {
    await this.loadPersistentState()
    const key = this.requestInfo?.memoryKey ?? this.lastMemoryKey ?? `npc:${this.npcId}`
    this.memory.clearTaskContext?.(key)
    this.clearLoadedSkillContext()
    this.skillOffers = null // 2.8 hook
    this.goalRequirements = null
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
    this.authorizationRefusalRetries = 0
    return true
  }

  // Every Jev call is written to the decision trace with the state it judged
  // and the answers it gave, so a round can be audited or replayed
  // offline against reworded questions without a new game run.
  recordedDecisionProvider(provider) {
    if (typeof provider !== 'function') return null
    return async (state, questions, context = {}) => {
      const pending = takePendingDecisionRequest(this, state, context)
      // The decision trace never copies the player's message; the behavior
      // trace already holds it for the same request.
      const tracedState = state && typeof state === 'object' && typeof state.message === 'string'
        ? { ...state, message: undefined, message_chars: state.message.length }
        : state
      const exchange = {
        decision_id: pending?.decision_id,
        contract: pending?.contract ?? (typeof state?.contract === 'string' ? state.contract : state?.reason),
        state: tracedState,
        question_ids: Object.keys(questions ?? {}),
      }
      const startedAt = Date.now()
      try {
        const response = await provider(state, questions, context)
        await this.decisionTraceEvent('decision.exchange', {
          ...exchange,
          model: typeof response?.model === 'string' ? response.model : undefined,
          answers: response?.answers,
          ...(response?.invalid_answers ? { invalid_answers: response.invalid_answers } : {}),
          latency_ms: Date.now() - startedAt,
        })
        return response
      }
      catch (error) {
        await this.decisionTraceEvent('decision.exchange', {
          ...exchange,
          error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
          latency_ms: Date.now() - startedAt,
        })
        throw error
      }
    }
  }

  decisionTraceEvent(event, data = {}) {
    if (event === 'decision.request') recordPendingDecisionRequest(this, data)
    else if (event === 'decision.response' || event === 'decision.fallback') settlePendingDecisionRequest(this, data)
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
    // A node without an intent is dropped by the shelf sanitizer, so count only
    // usable nodes: the live 2026-09-29 run sent {id, text} and got an empty shelf.
    const usableRoadmap = Array.isArray(plan.roadmap) && plan.roadmap.some(node => typeof node?.intent === 'string' && node.intent.trim())
    if (plan.goalDefinition.scope === GOAL_SCOPE.LONG_HORIZON && !usableRoadmap && !hasShelf) {
      throw this.goalDefinitionError(
        'long_horizon_goal_requires_roadmap',
        'goal.scope is long_horizon, so this first plan must also send roadmap: the coarse Roadmap Shelf nodes (what must eventually be true, in dependency order) that later plan slices will refine. Each node is {"id":"n1","intent":"what must eventually be true","why_it_matters":"...","depends_on":[]}; intent is required.',
      )
    }
    this.goalDefinitionRetries = 0
    this.lastGoalDefinitionError = null
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
    // Not in details (details are traced): lets the one corrective round also carry the live requirements.
    Object.defineProperty(error, 'goalDefinition', { value: definition, enumerable: false })
    throw error
  }

  goalDefinitionError(code, reason) {
    this.goalDefinitionRetries += 1
    const error = new AgentLoopError(reason)
    error.failureClass = 'plan_category'
    error.code = code
    // A repeated mistake stops at once; a model that fixes one different
    // mistake per retry is making progress and gets up to two corrections.
    const repeated = this.lastGoalDefinitionError === reason
    this.lastGoalDefinitionError = reason
    if (repeated || this.goalDefinitionRetries > 2) {
      this.goalDefinitionRetries = 0
      this.lastGoalDefinitionError = null
      this.goalDefinitionBlock = `I could not form a clear, game-checkable definition of this goal (${cleanMemoryText(reason, 300)}). Please restate the goal and what "done" means — for example "launch 1 rocket", "research automation", or "produce 1000 iron plates".`
      error.details = { deterministic_no_retry: true }
    }
    return error
  }

  async blockedWithoutMutation(reason, failureClass) {
    const goalBlock = this.goalDefinitionBlock
    this.goalDefinitionBlock = null
    const result = goalBlock
      ? { ...(await super.blockedWithoutMutation(goalBlock, 'goal_definition_needed')), chatMessage: goalBlock }
      : await super.blockedWithoutMutation(reason, failureClass)
    // This ending asks the player instead of acting; without a terminal event
    // the trace reads as a stalled request.
    if (this.traceRequest) {
      await this.traceEvent('request.completed', {
        outcome: 'blocked_before_mutation',
        chat_message: result.chatMessage,
        blocker: result.blocker,
        usage: this.traceRequest.usage,
      })
      this.traceRequest = null
    }
    return result
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
  async readGoalDefinition(key, definition, sampling = this.goalSampling) {
    const evaluation = await evaluateGoalDefinition(definition, command => this.rcon.command(command), sampling)
    if (Object.keys(evaluation.baselines ?? {}).length > 0 && typeof this.memory.recordGoalBaselines === 'function') {
      this.memory.recordGoalBaselines(key, evaluation.baselines)
      await this.traceEvent('goal.baselines_recorded', { baselines: evaluation.baselines })
    }
    return evaluation
  }

  async evaluateGoalCompletion({ record = true } = {}) {
    const key = this.activePlanKey()
    const definition = this.memory.goalDefinition?.(key)
    if (!definition) return undefined
    const evaluation = await this.readGoalDefinition(key, definition)
    this.lastGoalEvaluation = evaluation
    await this.traceEvent('goal.evaluated', {
      satisfied: evaluation.satisfied,
      progress: formatGoalProgress(evaluation),
      results: evaluation.results,
    })
    if (record && evaluation.satisfied) await this.recordGoalEvaluationSatisfied(evaluation)
    return evaluation
  }

  async recordGoalEvaluationSatisfied(evaluation) {
    if (typeof this.memory.recordGoalSatisfaction !== 'function') return
    this.memory.recordGoalSatisfaction(this.activePlanKey(), {
      source: 'runtime',
      evidenceRefs: evaluation.results.map(result => `goal_condition/${result.id}/${result.current ?? 'true'}`),
      rationale: 'goal_definition_conditions_satisfied',
    })
    await this.persistState()
  }

  // The planner declared the whole goal done while plan steps remain. With a
  // game-checked definition the game decides: met completes the goal and the
  // remaining steps are moot; unmet leaves the repair path to continue, now
  // told which conditions are still open.
  async finishIfGoalMet(plan, previousState) {
    const key = this.activePlanKey()
    if (!this.memory.goalDefinition?.(key)) return undefined
    const evaluation = await this.evaluateGoalCompletion({ record: false })
    if (!evaluation) return undefined
    const unverifiable = evaluation.results.filter(result => /^(?:unknown_|invalid_)/.test(result.error ?? ''))
    if (unverifiable.length > 0) return this.pauseForUnverifiableGoal(unverifiable)
    if (!evaluation.satisfied) return undefined
    // Close the legacy plan before recording satisfaction: recording first
    // would let the plan-close path re-admit the goal as a new active one.
    const reduced = this.memory.applyOutcomeAuthority?.(key, {
      kind: 'verified_complete',
      source: 'deterministic_runtime',
      reason_code: 'goal_definition_satisfied',
      evidence: [{
        kind: 'verified_world_state',
        ref: `${this.traceRequest?.id ?? 'request'}/goal_definition_satisfied`,
        summary: `The game reports ${formatGoalProgress(evaluation)}.`,
      }],
    }, { chatMessage: plan.chatMessage })
    await this.recordGoalEvaluationSatisfied(evaluation)
    this.clearActionOmissionRecovery()
    this.active = false
    // The legacy plan is completed and retired; its board is re-projected from
    // the reducer plan, whose remaining steps the met goal made moot.
    const completedBoard = { ...visibleTaskBoard(reduced?.state?.task_board ?? previousState?.task_board), status: 'completed' }
    const chatMessage = `The requested goal is verified complete: the game reports ${formatGoalProgress(evaluation)}.`
    await this.traceEvent('outcome.validated', {
      kind: 'verified_complete',
      source: 'goal_definition',
      reason_code: 'goal_definition_satisfied',
      task_board: completedBoard,
    })
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'goal_verified_complete',
      task_board: completedBoard,
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
      goalId: previousState?.goal_id,
      goalStatus: 'completed',
      taskBoard: completedBoard,
    }
  }

  unmetGoalNote() {
    const evaluation = this.lastGoalEvaluation
    if (!evaluation || evaluation.satisfied) return ''
    const unmet = evaluation.results.filter(result => !result.satisfied)
      .map(result => `${result.id}${result.current !== undefined ? ` (currently ${result.current})` : ''}`)
      .join(', ')
    return ` The goal is not complete: the game reports ${formatGoalProgress(evaluation)}; still unmet: ${unmet}.`
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

  // Every pause is named in the trace (1.5, widened 2026-09-28): a goal that
  // ends a request paused gets one goal.paused event with the cause, keyed by
  // the request that paused it, whichever path paused it. Pauses applied after
  // the request unwound (the supervisor's stranded-plan pause, a user stop)
  // are traced from pausePersistentPlan with the last request's id.
  // Every request carries a usage summary, whoever opened it. Supervisor
  // recovery runs (condition_satisfied, runtime_restart, actor_replaced,
  // auto-resume) assign `traceRequest = { id, seq }` directly; without a
  // usage summary their output was never counted, so the request-wide output
  // ceiling could not apply to them (1.5 review).
  get traceRequest() {
    return this.currentTraceRequest ?? null
  }

  set traceRequest(value) {
    if (value && typeof value === 'object') {
      if (!value.usage || typeof value.usage !== 'object') value.usage = emptyUsageSummary()
      if (!Number.isSafeInteger(value.seq)) value.seq = 0
    }
    this.currentTraceRequest = value ?? null
  }

  // Reads the durable plan state for tracing and budget bookkeeping without
  // currentPlan's side effects (it retires a completed plan on read).
  peekPlanState(key) {
    try {
      const state = this.memory?.planByNpc?.get?.(key)
      return state && typeof state === 'object' ? state : undefined
    }
    catch {
      return undefined
    }
  }

  goalPausedTrace(source, extra = {}) {
    const state = this.peekPlanState(this.activePlanKey())
    if (state?.status !== 'paused') return undefined
    const request = this.traceRequest
    if (request?.goal_paused_traced === state.pause_reason) return undefined
    if (request && request.start_status === 'paused' && request.start_pause_reason === state.pause_reason) return undefined
    if (request) request.goal_paused_traced = state.pause_reason
    const pauseReason = String(state.pause_reason ?? '')
    return {
      request_id: request?.id ?? this.lastTerminalRequestId,
      cause: cleanMemoryText(pauseReason.split(':')[0], 120) || 'paused',
      pause_reason: cleanMemoryText(pauseReason, 300),
      provider_failure: /provider|request_failed/i.test(pauseReason),
      source,
      goal_id: state.goal_id,
      active_step_id: state.task_board?.active_step_id,
      resume: 'Resume or say continue',
      ...extra,
    }
  }

  traceEvent(event, data = {}, { requestId } = {}) {
    if (event === 'request.completed' || event === 'request.failed') {
      data = { ...(data ?? {}), jev_health: this.takeJevHealthSummary() }
      if (this.traceRequest?.id) this.lastTerminalRequestId = this.traceRequest.id
      const paused = this.goalPausedTrace(event, {
        chat_message: typeof data.chat_message === 'string' ? data.chat_message : undefined,
        outcome: data.outcome,
        message: typeof data.message === 'string' ? cleanMemoryText(data.message, 300) : undefined,
      })
      if (paused) {
        const pausedWrite = this.traceEvent('goal.paused', paused)
        const terminalWrite = this.writeTraceEvent(event, data, requestId)
        return Promise.all([pausedWrite, terminalWrite]).then(() => undefined)
      }
    }
    return this.writeTraceEvent(event, data, requestId)
  }

  // Every event also passes through the time accounting (2.6) and the goal
  // usage ledger (2.7), which may add derived events (request.time_split
  // before a terminal event, plan.time_estimate after an admitted batch,
  // step.time_measured after a step closes, budget.goal_warning once per
  // goal). Derived events skip that pass.
  writeTraceEvent(event, data = {}, requestId) {
    const timing = this.observePlanTiming(event, data)
    const judged = this.observeJudgments(event, data, requestId)
    if (!timing && judged.length === 0) return this.emitTraceRecord(event, data, requestId)
    const writes = (timing?.before ?? []).map(([name, payload]) => this.emitTraceRecord(name, payload))
    writes.push(this.emitTraceRecord(event, data, requestId))
    for (const [name, payload] of timing?.after ?? []) writes.push(this.emitTraceRecord(name, payload))
    for (const [name, payload, rowRequestId] of judged) writes.push(this.emitTraceRecord(name, payload, rowRequestId))
    return Promise.all(writes).then(() => undefined)
  }

  // U11: the outcomes that score Jev's judgments arrive as ordinary trace rows (a step verified, an operation
  // batch admitted, a request ended). The ledger scores them and hands back the derived rows (jev.judgment_scored,
  // jev.stage_changed) to write right after. Never throws into a trace write.
  observeJudgments(event, data, requestId) {
    if (!this.jev) return []
    try {
      return this.jev.observe(event, data, requestId)
    }
    catch (error) {
      this.log(`[trace] jev judgment scoring failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  observePlanTiming(event, data) {
    if (!this.planTiming && !this.usageLedger) return undefined
    try {
      const state = this.peekPlanState(this.activePlanKey())
      const context = {
        requestId: this.traceRequest?.id,
        state: event === 'operations.ack' ? state : undefined,
        actorId: this.epoch?.actor_id,
        epoch: this.epoch?.epoch,
        goalId: state?.goal_id && state.status !== 'completed' ? state.goal_id : undefined,
        stepGoalId: state?.goal_id,
      }
      const timing = this.planTiming?.observe(event, data, context) ?? { before: [], after: [] }
      const usage = this.usageLedger?.observe(event, data, context) ?? { before: [], after: [] }
      const result = { before: [...timing.before, ...usage.before], after: [...timing.after, ...usage.after] }
      return result.before.length > 0 || result.after.length > 0 ? result : undefined
    }
    catch (error) {
      this.log(`[trace] time accounting failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  emitTraceRecord(event, data = {}, requestId) {
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
    if (['request.received', 'provider.error', 'plan.accepted', 'operations.ack', 'request.completed', 'request.failed', 'goal.paused'].includes(event)) {
      this.log(`[trace ${request?.id ?? '-'}] ${event}`)
    }
    // MW2: a task-ledger event names the request that caused it (a new goal interrupts the previous request's task before its
    // own request starts), so it keeps that id instead of the id of whatever request is still open.
    const exact = event.startsWith('task_ledger.') && typeof requestId === 'string' && requestId !== ''
    return this.behaviorTrace.emit({
      schema: 1,
      ts: new Date().toISOString(),
      seq: request && !exact ? ++request.seq : 0,
      event,
      request_id: exact ? requestId : (request?.id ?? (typeof requestId === 'string' ? requestId : undefined)),
      turn: request ? this.continuations + 1 : undefined,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      data,
    })
  }

  // The turn marks the conversation it reads (turnConversation) for as long as it runs; see restageContext.
  async runGuarded() {
    try {
      return await this.runGuardedTurn()
    }
    finally {
      this.turnConversation = null
    }
  }

  // C5 on Resume: restage from the packet before the request's first round.
  // No turn is open here, so no safePoint is passed. A refusal keeps the
  // conversation the request built (the fallback capsule where one was staged).
  async applyStartRestage() {
    const pending = this.startRestage
    this.startRestage = undefined
    if (!pending) return
    const restaged = await this.restageBetweenTurns({
      checkpoint: 'C5',
      role: this.agentContext.role,
      reason: `provider_budget_resume scope=${pending.semanticScope} cause=${cleanMemoryText(sanitizeDurableModelText(pending.reason, 200), 150)}`,
      budget: `provider budget generation ${this.providerBudgetGeneration}; handoff ${this.providerBudgetHandoffCount} of ${this.maxProviderBudgetHandoffs}; output cap ${this.maxProviderOutputUnits} per generation`,
      actor: this.epoch,
      runtime: pending.runtime,
      requestId: this.traceRequest?.id,
    })
    if (!restaged.restaged) {
      await this.traceEvent('budget.handoff_restage_fallback', { reason: restaged.reason, budget_generation: this.providerBudgetGeneration, source: 'resume' })
      return
    }
    if (pending.extraMessage) {
      const extra = { role: 'user', content: pending.extraMessage }
      this.baseMessages = [...this.baseMessages, extra]
      this.messages = [...this.messages, { ...extra }]
    }
  }

  // The identity of the running turn: what every admission point judges staleness against
  // (dropIfStale). runTurn takes it when it is the outermost turn; the recovery run of
  // runGuardedTurn (below) executes outside any runTurn and takes it here.
  currentTurnScope() {
    return this.turnScope.getStore() ?? {
      lineage: this.agentContext.lineageSequence,
      generation: this.generation,
      role: this.agentContext.role,
      handoffId: this.agentContext.handoffId,
      requestId: this.traceRequest?.id,
    }
  }

  async runGuardedTurn() {
    const generation = this.generation
    // The scope of THIS turn, fixed before it starts: the recovery that a failed turn
    // triggers (recoverPlan below) calls the provider, admits tool batches and commits a
    // plan outside any runTurn, so it needs the same identity to be judged against.
    const scope = this.currentTurnScope()
    // super.request() has just built requestInfo for a player chat request;
    // supervisor recovery runs build their own and enter here directly.
    if (this.chatRequestPending && this.requestInfo) this.requestInfo.origin = 'chat'
    this.chatRequestPending = false
    try {
      await this.applyStartRestage()
      return this.withPauseNotice(await this.runTurnRedriving(generation))
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const planState = this.memory.currentPlan?.(this.activePlanKey())
      // The request-wide output ceiling (5 per-turn caps) is final for this
      // request: no fresh generation, no recovery call. The goal ends
      // visibly and Resume starts a new request with a new allowance.
      if (isRequestOutputCeiling(error)
        && generation === this.generation
        && this.traceRequest) {
        return this.pauseAtProviderBudgetCap(error, planState, 'request_output_ceiling')
      }
      const terminalBudgetFailure = planState?.status === 'active' && terminalProviderBudgetFailure(error)
      if (terminalBudgetFailure && generation === this.generation && this.active) {
        // callProvider can surface the terminal exactly-once budget condition
        // before runTurn reaches its ordinary parse/recovery boundary. Reuse
        // the existing Outcome Authority path instead of leaking the provider
        // exception or spending another provider call.
        try {
          return this.withPauseNotice(await this.turnScope.run({ ...scope, role: this.agentContext.role, handoffId: this.agentContext.handoffId }, () => this.recoverPlan(generation, error, 0)))
        }
        catch (recoveryError) {
          // The fresh generations were spent too: pause visibly instead of
          // leaving the request to fail with no message.
          if (!(terminalProviderBudgetFailure(recoveryError) || isRequestOutputCeiling(recoveryError)) || generation !== this.generation || !this.traceRequest) throw recoveryError
          return this.pauseAtProviderBudgetCap(recoveryError, this.memory.currentPlan?.(this.activePlanKey()), 'budget_recovery_failed')
        }
      }
      // A budget failure on a plan that is not active (the steam run: blocked
      // on a failed transfer while the planner reasoned about it) used to end
      // here as request.failed with recoverable=false and nothing visible.
      if (terminalProviderBudgetFailure(error)
        && generation === this.generation
        && this.traceRequest
        && ['blocked', 'paused'].includes(planState?.status)) {
        return this.pauseAtProviderBudgetCap(error, planState, 'plan_not_active')
      }
      // Any other provider failure on an active goal with Autorio idle pauses
      // the goal here, with a chat line and a Resume, instead of leaving the
      // supervisor to pause it after the request unwound (the old silent
      // auto-pause). Transient conditions stay with the supervisor, which
      // resumes them automatically; live world work is never paused.
      // The recoverable planner failures keep failing upward: they leave the
      // plan active in a resumable repair state (admission_status
      // action_omission_repair, the compact recovery capsule) that a pause
      // would lose. The supervisor pauses them when Autorio is idle, and
      // pausePersistentPlan traces that pause as goal.paused.
      const failsUpward = RECOVERABLE_PLANNER_FAILURE.test(message)
        || planState?.admission_status === 'action_omission_repair'
      const pauseCause = failsUpward ? undefined : providerFailurePauseCause(message)
      if (pauseCause
        && planState?.status === 'active'
        && planState.condition_wait?.state !== 'active'
        && generation === this.generation
        && this.traceRequest) {
        const runtime = await this.readInteractionTaskStatus()
        if (idleRuntimeStatus(runtime)) return this.pauseAfterProviderFailure(pauseCause, message)
        await this.traceEvent('goal.pause_skipped', {
          cause: pauseCause,
          reason: 'autorio_runtime_not_idle',
          task_state: runtime?.task_state,
          queue_length: runtime?.queue_length,
          status_error: runtime?.status_error,
        })
      }
      const recoverablePlannerFailure = planState?.status === 'active' && RECOVERABLE_PLANNER_FAILURE.test(message)
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

  async pauseAfterProviderFailure(cause, message) {
    const key = this.activePlanKey()
    const pauseReason = cleanMemoryText(`${cause}: ${cleanMemoryText(message, 240)}`, 300)
    const state = this.memory.pausePlan?.(key, pauseReason)
    await this.persistState()
    this.active = false
    const chatMessage = `I paused this goal: ${PROVIDER_PAUSE_TEXT[cause] ?? PROVIDER_PAUSE_TEXT.request_failed}. ${RESUME_HINT}`
    const taskBoard = visibleTaskBoard(state?.task_board)
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'paused_provider_failure',
      reason: cause,
      message: cleanMemoryText(message, 600),
      task_board: taskBoard,
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    return {
      chatMessage,
      plan: state?.plan ?? [],
      currentStep: state?.current_step ?? 0,
      operations: [],
      epoch: this.epoch?.epoch,
      actorId: this.epoch?.actor_id,
      goalId: state?.goal_id,
      goalStatus: state?.status,
      taskBoard,
    }
  }

  // A turn that ends with the goal paused always tells the player how to go
  // on: one line, ending with the Resume hint. Paths that already say it are
  // left alone.
  withPauseNotice(result) {
    if (!result || typeof result !== 'object' || result.goalStatus !== 'paused') return result
    const text = String(result.chatMessage ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (/\bResume\b|say continue/i.test(text)) return text === result.chatMessage ? result : { ...result, chatMessage: text }
    return { ...result, chatMessage: `${text || 'I paused this goal.'} ${RESUME_HINT}` }
  }

  async captureEpoch() {
    const status = await super.captureEpoch()
    await this.traceEvent('actor.bound', actorFields(status))
    return status
  }

  async taskStatusReceipt() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 8_000_000)
      await this.settleOutstandingOperation(raw)
      this.recordPlacementReceipt(raw)
      const currentPlan = this.memory.currentPlan?.(this.activePlanKey())
      const evidence = receiptEvidence(raw, this.planUpdateReason === 'failure' ? 'failed' : 'completed', {
        goal_id: currentPlan?.goal_id,
        step_id: currentPlan?.task_board?.active_step_id,
        actor_id: this.epoch?.actor_id,
        actor_epoch: this.epoch?.epoch,
      })
      // The plan and step this batch was admitted under, when the memory
      // recorded one: lets the receipt ledger refuse a receipt whose plan has
      // since been superseded. Without a stamp the receipt binds as before.
      const admission = this.memory.admissionStamp?.(this.activePlanKey())
      const taskBoard = this.memory.recordBoardEvidence?.(this.activePlanKey(), admission ? { ...evidence, ...admission } : evidence)
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
      const raw = String(await this.rcon.command(toolCommand('getFollowStatus', {}))).slice(0, 8_000_000)
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

  // `withinTurn` is for a caller that is already inside a planner turn (for
  // example commitPlan): the next turn is then returned to that caller the way
  // every other in-turn correction is, not started as a second guarded run.
  async continueFromModMessage(modMessage, traceEventName, { withinTurn = false } = {}) {
    if (!this.active || !this.epoch) return null
    const currentPlan = this.memory.currentPlan?.(this.activePlanKey())
    const continuationLimit = currentPlan?.status === 'active' ? 64 : this.maxContinuations
    if (this.continuations >= continuationLimit) {
      await this.pausePersistentPlan(`continuation_limit_${continuationLimit}`)
      throw new AgentLoopError(`Continuation limit reached (${continuationLimit}); durable plan paused`)
    }
    if (withinTurn) {
      if (this.inTurnSliceContinuations >= MAX_IN_TURN_SLICE_CONTINUATIONS) {
        await this.traceEvent('plan.slice_continuation_chain_limit', { limit: MAX_IN_TURN_SLICE_CONTINUATIONS })
        await this.pausePersistentPlan(`slice_continuation_chain_limit_${MAX_IN_TURN_SLICE_CONTINUATIONS}`)
        throw new AgentLoopError(`Slice continuation chain limit reached (${MAX_IN_TURN_SLICE_CONTINUATIONS}); durable plan paused`)
      }
      this.inTurnSliceContinuations++
    }
    else {
      this.inTurnSliceContinuations = 0
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
    return withinTurn ? this.runTurn() : this.runGuarded()
  }

  // What a step closing on its verified contract means for the plan and goal:
  // the next Shelf slice, a verified finite goal, or an active goal to
  // reconcile. Returns undefined when the loop should carry on as normal.
  // A caller already inside a planner turn passes withinTurn: true so the
  // continuation is returned to it as that turn's next turn rather than being
  // started as a separate guarded run; allowContinuation: false suppresses the
  // continuation altogether. `droppedOperationsNote` tells the planner why the
  // operations in the reply that closed the slice were not run.
  async settleCompletedStepState(completionState, { pendingAmendment, allowContinuation = true, withinTurn = false, droppedOperationsNote = '' } = {}) {
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
      await this.closeOutputSlice('next_shelf_slice')
      const sliceClose = await this.planSliceCloseWake({ route: 'next_shelf_slice', planningState: planningAfterCompletion, goalEvaluation, withinTurn })
      if (sliceClose.unavailable) return this.endSliceWithoutPlanner(sliceClose.unavailable)
      await this.traceEvent('planner.wake', {
        source: 'planning_boundary',
        route: 'next_shelf_slice',
        steering_mode: planningAfterCompletion.steering?.current_mode,
      })
      await refreshSkillOffersAtShelfPickup(this, planningAfterCompletion) // 2.8 hook: shelf -> active plan skill search
      await refreshGoalRequirementsAtShelfPickup(this, planningAfterCompletion) // live requirements for the next slice
      this.reasoningTriggerSource = 'plan_slice_completed'
      try {
        const unmet = goalEvaluation
          ? ` The game reports ${formatGoalProgress(goalEvaluation)}; still unmet: ${goalEvaluation.results.filter(result => !result.satisfied).map(describeUnmetGoalResult).join(', ')}.`
          : ''
        const next = (planningAfterCompletion?.roadmap?.nodes?.length ?? 0) > 0
          ? 'Refine the next useful Roadmap Shelf node using [PLANNING_STATE]'
          : 'Author the next plan slice that moves the world toward the unmet goal conditions'
        return await this.continueFromModMessage(
          `[MOD] The current immutable plan slice is verified complete. The user goal remains active.${unmet} ${next}; do not treat plan completion as goal completion. Completed plan_id=${reducerPlanAfterCompletion.plan_id}. ${sliceClose.verifiedResults}${droppedOperationsNote ? ` ${droppedOperationsNote}` : ''}`,
          'planning.slice_completion_continuation',
          { withinTurn },
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
      await this.closeOutputSlice('active_goal_after_plan_completion')
      const sliceClose = await this.planSliceCloseWake({ route: 'active_goal_after_plan_completion', planningState: planningAfterCompletion, goalEvaluation, withinTurn })
      if (sliceClose.unavailable) return this.endSliceWithoutPlanner(sliceClose.unavailable)
      await this.traceEvent('planner.wake', {
        source: 'planning_boundary',
        route: 'active_goal_after_plan_completion',
        plan_status: reducerPlanAfterCompletion?.status,
      })
      await refreshGoalRequirementsAtShelfPickup(this, planningAfterCompletion, 'slice_authoring')
      this.reasoningTriggerSource = 'plan_slice_completed'
      try {
        return await this.continueFromModMessage(
          `[MOD] The current bounded work is complete, but the reducer-owned user goal is still active. Reconcile [PLANNING_STATE] and choose the next bounded action or explicitly surface why the goal cannot yet advance. Do not infer GOAL_SATISFIED from Task Board completion. ${sliceClose.verifiedResults}${droppedOperationsNote ? ` ${droppedOperationsNote}` : ''}`,
          'planning.active_goal_continuation',
          { withinTurn },
        )
      }
      finally {
        this.reasoningTriggerSource = null
      }
    }
    return undefined
  }

  // The plan finished but the game says the goal is not met. The planner gets
  // one turn in this request to author the next slice; a second "done"
  // without work ends the request honestly with the goal still open.
  async continueUnmetGoal(plan, stateResult) {
    const planning = this.memory.planningState?.(this.activePlanKey())
    const evaluation = this.lastGoalEvaluation
    if (planning?.goal?.status !== GOAL_STATUS.ACTIVE || !evaluation || evaluation.satisfied) return undefined
    const unmet = evaluation.results.filter(result => !result.satisfied)
      .map(result => `${result.id}${result.current !== undefined ? ` (currently ${result.current})` : ''}`)
      .join(', ')
    await this.traceEvent('goal.unmet_after_plan', {
      goal_id: planning.goal.goal_id,
      progress: formatGoalProgress(evaluation),
      unmet,
      continued: this.unmetGoalContinuationUsed !== true,
    })
    if (this.unmetGoalContinuationUsed !== true) {
      this.unmetGoalContinuationUsed = true
      // U6: the slice is closed and the next one is authored by the planner. Control returns to
      // the planner conversation, which never saw the executor's traffic, so the executor's
      // final reply is not appended to it.
      let handedToPlanner = false
      if (this.agentContext.role === EXECUTOR_ROLE) {
        const returned = await this.returnControlToPlannerWithRetry({ route: 'unmet_goal_after_plan', planningState: planning, withinTurn: true, reason: 'slice_close_unmet_goal' })
        handedToPlanner = returned.returned === true
        // Never ask the executor to author the next slice.
        if (!handedToPlanner) return this.endSliceWithoutPlanner({ route: 'unmet_goal_after_plan', reason: returned.reason ?? 'planner_unavailable' })
      }
      // commitPlan may already have recorded this reply (a claim that closed
      // the slice); two consecutive assistant messages are invalid.
      if (!handedToPlanner && this.messages.at(-1)?.role !== 'assistant') this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
      this.messages.push({
        role: 'user',
        content: `[HARNESS] The plan is finished, but the game reports ${formatGoalProgress(evaluation)}; still unmet: ${unmet}. The user goal remains active. Author the next plan slice that moves the world toward the unmet conditions; do not report the goal as complete.${this.pendingDroppedOperationsNote ? ` ${this.pendingDroppedOperationsNote}` : ''}`,
      })
      this.pendingDroppedOperationsNote = ''
      await refreshGoalRequirementsAtShelfPickup(this, planning, 'unmet_goal_authoring') // the planner authors the next slice: re-read the live game
      return this.runTurn()
    }
    this.active = false
    const chatMessage = `The plan is finished, but the goal is not met yet: the game reports ${formatGoalProgress(evaluation)} (still unmet: ${unmet}).`
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'goal_unmet_after_plan',
      task_board: visibleTaskBoard(stateResult?.state?.task_board),
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
      goalId: planning.goal.goal_id,
      goalStatus: 'active',
      taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
    }
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

  // The plan tracker and the task board disagree about the active step and the
  // close was refused twice (or on the final step): stop visibly instead of
  // letting the board drift from the plan. The player resumes with the usual
  // hint.
  async pauseForPlanBoardDisagreement(disagreement) {
    const key = this.activePlanKey()
    const state = this.peekPlanState(key)
    const chatMessage = `I paused this goal: my plan tracker and my task board disagree about which step is active, so I stopped instead of guessing. ${RESUME_HINT}`
    await this.persistState()
    await this.traceEvent('step.progress_disagreement_paused', { ...(disagreement ?? {}) })
    const taskBoard = visibleTaskBoard(state?.task_board)
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: 'paused_plan_board_disagreement',
      task_board: taskBoard,
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    this.active = false
    return {
      chatMessage,
      plan: state?.plan ?? [],
      currentStep: state?.current_step ?? 0,
      operations: [],
      epoch: this.epoch?.epoch,
      actorId: this.epoch?.actor_id,
      goalId: state?.goal_id,
      goalStatus: 'paused',
      taskBoard,
    }
  }

  async completed() {
    await this.loadPersistentState()
    if (!this.active) return null
    const pendingAmendment = this.currentPendingAmendment()
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
    if (stepCompletion?.paused) return this.pauseForPlanBoardDisagreement(stepCompletion.disagreement)

    // The reason a step did not close used to be trace-only: the model saw a
    // finished batch and nothing about why the step stayed open.
    const stepOpenHint = stepCompletion?.reason === 'semantic_completion_requires_planner'
      ? this.stepStaysOpenHint(stepCompletion.state)
      : ''
    const completionState = stepCompletion?.state
    const settled = await this.settleCompletedStepState(completionState, { pendingAmendment })
    if (settled) return settled
    // U6: a step verified inside the slice may put the executor past its hard limit (C8).
    await this.executorStepCloseBoundary({ withinTurn: false })

    // U11 (C4): is the next committed step clear? In shadow this only records Jev's judgment next to the gate below
    // (nothing changes); once the family has earned `deciding` and Jev confidently says direct_to_executor, the
    // gate, the planner-shape call and the observation budget are skipped. The completion gate above already owned
    // the step close; nothing here advances the tracker.
    const c4 = pendingAmendment ? undefined : await this.jev.c4Boundary({ stepCompletion, receipt, pendingAmendment })
    let routed
    if (c4?.acted) routed = await this.routeDirectToExecutor(c4)
    else {
      routed = pendingAmendment
        ? { route: 'fallback_planner', decision_called: false }
        : await this.routePostStepDecision(receipt, { inspected: this.jev.takeRuntimeInspection(receipt) })
      // The Jev decision calls the gate really made here (the gate call, and the planner-shape call when it woke): what a direct
      // route would not have made. Not LLM wakes.
      if (c4) await this.jev.noteGateRoute(c4, routed.route, routed.decision_called === true ? (routed.steering?.typed_state_mode ? 2 : 1) : 0)
    }
    if (routed.route === 'wait_runtime') {
      if (c4) await this.jev.discardHandle(c4, 'gate_waits_for_active_runtime')
      return null
    }

    // Repair unit B: a finished wait-only batch carries a fresh read of the step's machine, so the model never
    // plans its next move from a stale narrative observation.
    const blindWaitFacts = pendingAmendment ? undefined : await this.blindWaitReceiptFacts(receipt)

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
    this.jev.beginWake(c4)
    let wakeFailed = true
    try {
      const result = await this.continueFromModMessage(
        `[MOD] Autorio operation batch completed. ${stepOpenHint ? `${stepOpenHint} ` : ''}Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}${blindWaitFacts ? ` ${blindWaitFacts}` : ''}`,
        'factorio.completion_continuation',
      )
      wakeFailed = false
      if (pendingAmendment) { this.pendingInteractionAmendment = null; this.pendingAmendmentConversationSeq = undefined }
      return result
    }
    finally {
      // U11: what the wake that ran cost and did (scored when the step verifies). Never masks the wake's own result.
      try { await this.jev.endWake(c4, { error: wakeFailed }) }
      catch (error) { this.log(`[jev] wake measurement failed: ${error instanceof Error ? error.message : String(error)}`) }
      this.reasoningTriggerSource = null
      this.reasoningBudgetOverride = previousReasoningBudget
      this.observationBudgetOverride = previousObservationBudget
      this.observationBudgetRemaining = previousObservationBudgetRemaining
      this.observationRelevanceOverride = previousObservationRelevance
      this.planningHorizonOverride = previousPlanningHorizon
    }
  }

  // U11 (C4, deciding stage only): the next committed step is clear, so the executor continues on it directly.
  // The post-step gate, the planner-shape call and the observation budget are skipped; the route is the existing
  // `continue_current` (low reasoning). It cannot close or advance a step.
  async routeDirectToExecutor(c4) {
    const requestId = this.traceRequest?.id
    await this.traceEvent('c4.route_applied', {
      request_id: requestId,
      judgment_id: c4.judgment_id,
      mode: 'deciding',
      jev_choice: 'direct_to_executor',
      jev_confidence: c4.confidence,
      applied_route: 'continue_current',
      skipped: ['post_step_gate', 'planner_shape', 'targeted_observation'],
      reason: 'family_deciding_and_next_step_clear',
    })
    await this.traceEvent('planner.wake', { source: 'c4_next_step_clear', route: 'continue_current', reasoning_policy: 'low' })
    return {
      route: 'continue_current',
      decision_called: false,
      steering: { observation_budget: 0, observation_relevance: { source: 'typed_relevance', selected_families: [], budget: 0 } },
      c4: true,
    }
  }

  async failed(errorText) {
    await this.loadPersistentState()
    if (!this.active) return null
    await this.jev?.noteFailureBoundary() // U11: a C4 judgment whose step now fails did not verify on its first batch (scored now, whatever the request does next)
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
    const recoverable = latestRecoverableOperationFailure(this.memory.currentPlan?.(this.activePlanKey()))
    if (recoverable) {
      await this.traceEvent('operations.execution_recoverable', {
        failure_class: recoverable.failure_class,
        attempt: recoverable.attempt,
        retry_budget: recoverable.retry_budget,
      })
    }
    const supplyState = this.memory.currentPlan?.(this.activePlanKey())
    const supplyRecovery = latestTransferSupplyExecutionRecovery(supplyState)
    if (supplyRecovery) {
      await this.traceEvent('transfer.supply_recovery', {
        request_id: this.traceRequest?.id,
        step_id: supplyState?.task_board?.active_step_id,
        phase: 'execution',
        code: supplyRecovery.code,
        item_name: supplyRecovery.item_name,
        requested: supplyRecovery.requested_count,
        to_entity: supplyRecovery.to_entity,
        target_unit_number: supplyRecovery.target_unit_number,
        attempt: supplyRecovery.attempt,
        retry_budget: supplyRecovery.retry_budget,
        tools_enabled: true,
        plan_changed: false,
        reason: `execution_${supplyRecovery.code}`,
      })
    }
    else if (supplyState?.status === 'blocked'
      && /^transfer_failed:(?:item_missing|nothing_moved)$/.test(String(supplyState.blocker ?? ''))
      && transferSupplyRecoveryCount(supplyState.task_board) >= TRANSFER_SUPPLY_RECOVERY_BUDGET) {
      await this.traceEvent('transfer.supply_recovery_exhausted', {
        request_id: this.traceRequest?.id,
        step_id: supplyState.task_board?.active_step_id,
        phase: 'execution',
        reason: 'recovery_budget_spent_step_blocked_through_existing_path',
        blocker: supplyState.blocker,
        recoveries_used: transferSupplyRecoveryCount(supplyState.task_board),
        retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
      })
    }
    const supplyGuidance = supplyRecovery
      ? ` [HARNESS] The engine found nothing to move for ${cleanMemoryText(supplyRecovery.item_name ?? 'the requested item', 100)} (${cleanMemoryText(supplyRecovery.code, 64)}; requested ${supplyRecovery.requested_count ?? 'unknown'}, ${supplyRecovery.to_entity === false ? 'taking from' : 'giving to'} unit ${supplyRecovery.target_unit_number ?? 'unknown'}). This is a recoverable supply dependency inside the same committed step, not WORLD_BLOCKED: the plan, step contract and requested result are unchanged, and tools remain enabled. A destination that already holds the item does not by itself complete the transfer. Re-observe the real counts, then acquire the missing amount or submit a different valid transfer for this step. Recovery ${supplyRecovery.attempt} of ${supplyRecovery.retry_budget} before this step blocks.`
      : ''
    const recoverableGuidance = recoverable
      ? ` [HARNESS] The engine refused the ${cleanMemoryText(recoverable.entity_name ?? 'entity', 100)} placement at the coordinate you chose (${cleanMemoryText(recoverable.code, 64)}); this is a correctable placement error, not a world blocker, and the committed step is unchanged. Use the receipt's placement_footprint, placement_grid.nearest_valid_center and placement_blockers to choose a valid position (or clear the reported blocker); when the machine must cover or receive another entity's output, use getPlacementCandidates with covers_position and place the returned candidate instead of a hand-picked centre. Then resubmit the same step with its dependent operations. Do not change the plan's steps. Attempt ${recoverable.attempt} of ${recoverable.retry_budget} before the step is blocked.`
      : ''
    try {
      return await this.continueFromModMessage(
        `[MOD] Autorio operation error: ${cleanError}. A failure cancels the operations queued behind it; a refused item move (nothing moved, items still held) does not, so read the receipt for which operations completed. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}${recoverableGuidance}${supplyGuidance}`,
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
    this.jev?.abortAll(reason)
    this.interactionAbort?.abort()
    this.interactionAbort = null
    this.postStepDecisionAbort?.abort()
    this.postStepDecisionAbort = null
    this.recoveryDecisionAbort?.abort()
    this.recoveryDecisionAbort = null
    this.operationProjectionAbort?.abort()
    this.operationProjectionAbort = null
    abortSkillChoice(this, reason) // 2.8 hook
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

  // A fresh output budget per step (1.5, first slice of delegation). The
  // output cap is per budget generation, and a generation used to roll only
  // on an output-budget handoff, so one request carried a whole goal: the
  // 2026-09-26 steam run spent 42,915 units authoring the plan and step 1,
  // then died at 107,322 > 100,000 two steps later. A verified step close is a
  // safe boundary (the world state, not the conversation, carries the
  // progress), so every close starts a new generation. Called at each step
  // close and, as a catch-all for any other path that advances the board,
  // before every provider call.
  async rollProviderBudgetAtStepClose(source, stateOverride) {
    const key = this.activePlanKey()
    const current = providerBudgetStepMark(stateOverride ?? this.peekPlanState(key))
    if (!current) return false
    const mark = this.providerBudgetStepMark
    // A goal first seen in this request (no mark, or the mark belongs to an
    // earlier goal) started from zero closed steps.
    const baseline = mark && mark.goal_id === current.goal_id ? mark.completed_count : 0
    if (current.completed_count <= baseline) {
      // No close since the mark (or a board rebuilt by a revision): re-anchor
      // without spending a generation.
      this.providerBudgetStepMark = current
      return false
    }
    const previousGeneration = Math.max(1, this.providerBudgetGeneration)
    const previousOutputUnits = this.providerBudgetGenerationOutputUnits
    this.providerBudgetGeneration = previousGeneration + 1
    this.providerBudgetGenerationOutputUnits = 0
    // The compact output-budget retry is allowed once per generation.
    this.outputBudgetRecoveryUsed = false
    this.providerBudgetStepMark = current
    const board = (stateOverride ?? this.peekPlanState(key))?.task_board
    await this.traceEvent('budget.generation_rolled', {
      reason: 'step_closed',
      source,
      goal_id: current.goal_id || undefined,
      completed_count: current.completed_count,
      closed_steps: current.completed_count - baseline,
      active_step_id: board?.active_step_id,
      previous_generation: previousGeneration,
      previous_generation_output_units: previousOutputUnits,
      generation: this.providerBudgetGeneration,
      output_cap: this.maxProviderOutputUnits,
      request_output_units: this.traceRequest?.usage?.output_units,
    })
    return true
  }

  // A revised version of a BLOCKED plan needs the player's own revision
  // (AGENTS.md; planning-state: a recorded 'revise' choice authorizes only the
  // next user-supplied revision). recordPlan treats any requestInfo with a
  // sender and text as that revision. A run that is not a player chat request
  // (supervisor recovery, which sets sender=owner and text=objective) must
  // never carry that authority, so a lingering 'revise' choice cannot turn it
  // into an unapproved plan version.
  async revisionSafeRequestInfo() {
    const info = this.requestInfo
    if (!info || info.origin === 'chat') return info
    const planning = this.memory.planningState?.(info.memoryKey)
    const active = planning ? getActivePlanningPlan(planning) : undefined
    if (active?.status !== PLAN_STATUS.BLOCKED) return info
    await this.traceEvent('planning.revision_authority_withheld', {
      reason: 'not_a_player_chat_request',
      plan_id: active.plan_id,
      blocker: active.blocker?.reason_code,
      user_choice: active.blocker?.user_choice?.choice,
    })
    return { ...info, sender: undefined, text: undefined }
  }

  requestOutputCeiling() {
    return REQUEST_OUTPUT_CEILING_CAPS * this.maxProviderOutputUnits
  }

  // U5: the ceiling applies to one plan slice (aggregate - slice baseline).
  sliceOutputCeiling() {
    return requestSliceCeiling(this.traceRequest, this.requestOutputCeiling())
  }

  // The plan-slice-completed boundary (settleCompletedStepState, before the next
  // slice's planner wake): the next slice starts counting from here. A step
  // close inside a slice never resets it.
  async closeOutputSlice(route) {
    const before = this.sliceOutputCeiling()
    const baseline = markRequestSliceClosed(this.traceRequest)
    if (baseline === undefined) return
    await this.traceEvent('budget.slice_baseline_reset', {
      route,
      previous_slice_output_baseline: before.baseline,
      slice_output_units: before.used,
      slice_output_baseline: baseline,
      aggregate_output_units: before.aggregate,
      request_output_ceiling: this.requestOutputCeiling(),
    })
  }

  // A request that runs out of output budget (the per-step cap, the context
  // window, an exhausted budget recovery, or the request-wide ceiling) ends
  // visibly with one chat line (1.5); it never ends as a silent `blocked` plan
  // with no message, which is where the steam run stopped.
  //  - A plan that is not blocked is paused, and the line ends with
  //    RESUME_HINT; Resume starts a fresh request from the verified state.
  //  - A plan already blocked on a world blocker STAYS blocked (AGENTS.md: a
  //    structural blocker freezes the plan until the user approves a revision;
  //    the board keeps its Revise / Keep paused / Cancel controls and the
  //    supervisor's blocked guard). The budget stop is recorded as its own
  //    cause (budget_cause in the trace and the result), and the line names
  //    the blocker and the budget stop and asks for the same decision the
  //    blocked reply asks for. Resume on it gets that blocked reply.
  async pauseAtProviderBudgetCap(error, previousState, source) {
    const key = this.activePlanKey()
    const ceiling = isRequestOutputCeiling(error)
    const code = ceiling ? 'request_output_ceiling' : terminalProviderBudgetCode(error)
    const previousStatus = previousState?.status
    const blocked = previousStatus === 'blocked'
    const blocker = blocked ? cleanMemoryText(previousState?.blocker, 160) : ''
    const generation = this.providerBudgetGeneration
    const generationOutputUnits = this.providerBudgetGenerationOutputUnits
    // U5: the ceiling figures are the current slice's (the aggregate when no
    // slice has closed yet, so a single-slice request reads exactly as before).
    const sliceView = this.sliceOutputCeiling()
    const requestOutputUnits = sliceView.used
    const units = value => Number(value ?? 0).toLocaleString('en-US')
    const spent = ceiling
      ? sliceView.baseline > 0
        ? `this request used its whole output allowance for the current plan slice (${units(requestOutputUnits)} of ${units(this.requestOutputCeiling())} units across ${generation} step budget${generation === 1 ? '' : 's'}; ${units(sliceView.aggregate)} in all)`
        : `this request used its whole output allowance (${units(requestOutputUnits)} of ${units(this.requestOutputCeiling())} units across ${generation} step budget${generation === 1 ? '' : 's'})`
      : code === 'provider_turn_output_cap_exceeded'
        ? `the model used its whole output budget for this step (${units(generationOutputUnits)} of ${units(this.maxProviderOutputUnits)} units)`
        : `the model request ran out of budget (${code})`
    this.memory.setProviderRecovery?.(key, undefined)
    let state
    let pauseReason
    let chatMessage
    if (blocked) {
      await this.persistState()
      state = this.peekPlanState(key)
      chatMessage = `I stopped: ${spent}, and the plan is blocked on ${blocker || 'a world blocker'}. Continuing unchanged would hit the same blocker. Tell me how to revise it (for example a different route or target), or cancel it.`
    }
    else {
      pauseReason = cleanMemoryText(ceiling
        ? `request_output_ceiling: ${units(requestOutputUnits)} > ${units(this.requestOutputCeiling())} output units`
        : `${BUDGET_PAUSE_PREFIX}: ${code}`, 300)
      // Only a live goal is paused; a completed or missing plan is left as it
      // is, but the request still stops visibly and says so.
      state = ['active', 'paused'].includes(previousStatus)
        ? this.memory.pausePlan?.(key, pauseReason)
        : this.peekPlanState(key)
      await this.persistState()
      chatMessage = `I paused this goal: ${spent}. ${RESUME_HINT}`
      if (state?.status !== 'paused') {
        // The terminal-event hook names pauses of a plan state; with none to
        // pause, name this stop here so every budget stop has its goal.paused.
        await this.traceEvent('goal.paused', {
          request_id: this.traceRequest?.id,
          cause: code,
          pause_reason: pauseReason,
          provider_failure: false,
          source: 'budget_stop_without_live_plan',
          plan_status: state?.status ?? 'none',
          resume: 'Resume or say continue',
          chat_message: chatMessage,
        })
      }
    }
    this.active = false
    const taskBoard = visibleTaskBoard(state?.task_board)
    await this.traceEvent('budget.cap_reached', {
      reason: code,
      budget_cause: code,
      source,
      previous_status: previousStatus,
      blocker: blocker || undefined,
      goal_status: state?.status,
      next_action: blocked ? 'revise_or_cancel' : 'resume',
      pause_reason: pauseReason,
      generation,
      generation_output_units: generationOutputUnits,
      output_cap: this.maxProviderOutputUnits,
      request_output_units: requestOutputUnits,
      request_output_ceiling: this.requestOutputCeiling(),
      aggregate_output_units: sliceView.aggregate,
      slice_output_baseline: sliceView.baseline,
      chat_message: chatMessage,
    })
    await this.traceEvent('request.completed', {
      chat_message: chatMessage,
      outcome: blocked
        ? 'blocked_budget_stop'
        : ceiling ? 'paused_request_output_ceiling' : 'paused_output_cap',
      reason: code,
      budget_cause: code,
      task_board: taskBoard,
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    return {
      chatMessage,
      plan: state?.plan ?? [],
      currentStep: state?.current_step ?? 0,
      operations: [],
      epoch: this.epoch?.epoch,
      actorId: this.epoch?.actor_id,
      goalId: state?.goal_id,
      goalStatus: blocked ? 'blocked' : state?.status === 'paused' ? 'paused' : (state?.status ?? 'paused'),
      budgetCause: code,
      taskBoard,
    }
  }


  // What this round has to do (1.3). Every tools-on round offers submitPlan,
  // so in a request that authors or revises a plan (a new goal, an amendment,
  // a replan, a failure, a fresh slice) any round may write the plan: it is
  // `decide` and keeps the full bracket. Only a continuation round of an
  // active committed plan, with the observation phase open, is `gather`: it
  // executes the plan and cannot rewrite it. Once the harness closes or
  // narrows the observation phase (tools off, decision pressure, the
  // observation budget spent) the round is `decide` too. The provider maps
  // the phase onto effort and output cap; the reason is traced with it.
  providerRoundPhase(allowTools, triggerSource) {
    if (allowTools === false) return { phase: 'decide', reason: 'tools_off' }
    if (!CONTINUATION_TRIGGERS.has(triggerSource)) return { phase: 'decide', reason: 'plan_may_be_written' }
    const state = this.peekPlanState(this.activePlanKey())
    if (state?.status !== 'active' || !Array.isArray(state?.task_board?.steps) || state.task_board.steps.length === 0) {
      return { phase: 'decide', reason: 'no_active_committed_plan' }
    }
    if (this.observationDecisionForced === true) return { phase: 'decide', reason: 'observation_phase_closed' }
    if (this.observationDecisionPressure === true) return { phase: 'decide', reason: 'observation_decision_pressure' }
    if (Number.isSafeInteger(this.observationBudgetRemaining) && this.observationBudgetRemaining <= 0) {
      return { phase: 'decide', reason: 'observation_budget_spent' }
    }
    return { phase: 'gather', reason: 'observation_phase_open' }
  }

  resetObservationDecisionState() {
    super.resetObservationDecisionState()
    this.closedRoundObservationUsed = false
  }

  // A round that closed tool use can still name calls: operations the model
  // meant for the plan, or a read it wanted. The tool list stays visible on
  // closed rounds, but nothing executes from them directly.
  //  - Operations (names from the runtime-v8 catalog) become the operations of
  //    a plan reply for the CURRENT committed plan and step; the normal
  //    parsePlanMessage/commitPlan path admits or refuses them.
  //  - Observation-only calls get one bounded extra read per decision when the
  //    Jev observation budget allows, then the round closes again.
  //  - Anything else falls through to the existing format recovery.
  // Returns the message to use, or undefined to keep today's behaviour.
  async salvageClosedRoundCalls(message, calls, { current, generation, round, recoveryAttempt, recoveryKind, omissionRepair }) {
    // Content that already is a plan reply wins over stray calls, including a
    // plan in code fences or with prose around it (the normal path accepts
    // those and would otherwise lose its checkpoint/semanticCompletion).
    if (contentCarriesPlan(message.content)) return undefined
    const operationNames = new Set(approvedOperationNames())
    const operations = []
    const observations = []
    for (const call of calls) {
      if (operationNames.has(call.name)) operations.push(call)
      else if (isObservationToolName(call.name)) observations.push(call)
      else return undefined // unknown or planner-control names: not salvageable
    }
    const names = list => [...new Set(list.map(call => call.name))].slice(0, 16)

    if (operations.length > 0) {
      const state = this.memory.currentPlan?.(this.activePlanKey())
      if (!Array.isArray(state?.plan) || state.plan.length === 0 || operations.length > 16) return undefined
      // The harness may only supply plan intent that already exists: a
      // committed/executing plan, not a decision that authors a new or revised
      // one (blocked plan awaiting revise, user amendment, next slice, ...).
      const key = this.activePlanKey()
      const planning = this.memory.planningState?.(key)
      const reducerPlan = planning ? getActivePlanningPlan(planning) : undefined
      const step = Number.isSafeInteger(state.current_step) ? state.current_step : 0
      const trigger = this.reasoningTriggerSource ?? this.planUpdateReason
      const skipReason = !FROZEN_PLAN_STATUSES.has(reducerPlan?.status)
        ? `plan_status_${reducerPlan?.status ?? 'none'}`
        : this.currentPendingAmendment()
          ? 'pending_amendment'
          : (CLOSED_ROUND_AUTHORING_TRIGGERS.has(trigger))
              ? `authoring_${trigger}`
              : step < 0 || step >= state.plan.length
                ? 'current_step_out_of_range'
                : undefined
      if (skipReason) {
        await this.traceEvent('closed_round.salvage_skipped', { round, reason: skipReason, operation_count: operations.length })
        return undefined
      }
      const parsed = []
      for (const call of operations) {
        let args
        try { args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments) }
        catch { return undefined }
        if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
        parsed.push({ name: call.name, args })
      }
      const currentStep = Number.isSafeInteger(state.current_step) ? state.current_step : 0
      await this.traceEvent('closed_round.calls_salvaged', {
        round,
        operation_count: parsed.length,
        operations: names(operations),
        observation_calls_dropped: observations.length,
        observations_dropped: names(observations),
        plan_steps: state.plan.length,
        current_step: currentStep,
      })
      return {
        ...message,
        tool_calls: undefined,
        content: JSON.stringify({ chatMessage: '', plan: state.plan, currentStep, operations: parsed }),
      }
    }

    // Observation-only.
    const budgetAllows = this.observationBudgetRemaining === null
      || this.observationBudgetRemaining === undefined
      || (Number.isSafeInteger(this.observationBudgetRemaining) && this.observationBudgetRemaining > 0)
    if (!omissionRepair && this.closedRoundObservationUsed !== true && budgetAllows) {
      let prepared
      try {
        prepared = this.prepareToolBatch({
          ...message,
          tool_calls: observations.map((call, index) => ({
            id: `call_closed_${round}_${index + 1}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        })
      }
      catch { prepared = undefined }
      if (prepared) {
        this.closedRoundObservationUsed = true
        const before = this.messages.length
        await this.handleToolBatch({ ...message, tool_calls: prepared.map(entry => entry.tool) }, prepared)
        if (this.messages.length > before) {
          await this.traceEvent('closed_round.observation_granted', {
            round,
            observations: names(observations),
            budget_remaining: Number.isSafeInteger(this.observationBudgetRemaining) ? this.observationBudgetRemaining : undefined,
          })
          this.messages.push({
            role: 'user',
            content: '[HARNESS] One extra read-only observation was run for you on this closed round; its result is above. The observation phase is closed again: do not call any tool. Answer with the strict-JSON plan (or a truthful blocker) as content only.',
          })
          return this.callProvider(current, generation, { round, allowTools: false, recoveryAttempt, recoveryKind })
        }
      }
    }
    await this.traceEvent('closed_round.observation_dropped', {
      round,
      observations: names(observations),
      reason: this.closedRoundObservationUsed === true ? 'extra_observation_already_used' : (budgetAllows ? 'not_admitted' : 'observation_budget_spent'),
    })
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (!content.startsWith('{')) {
      this.messages.push({
        role: 'user',
        content: '[HARNESS] Tools are closed for this decision, so the tool call you wrote was not executed. Answer with the strict-JSON plan (or a truthful blocker) as content only, using the evidence already collected.',
      })
    }
    return undefined
  }

  // A reply for a conversation a restage has replaced (U4): traced, then the
  // turn is cancelled like any superseded one. Nothing from it is appended to
  // the active conversation and nothing from it reaches admission.
  // `kind` says what outlived the reply: 'restage' (the same lineage moved to another
  // conversation, so the turn is re-driven on the active one) or 'superseded' (a reset
  // replaced the whole lineage: the turn is dead and durable state now belongs to the new
  // one, so nothing of the stale turn may touch it).
  async dropStaleReply(attribution, requestId, kind = 'restage') {
    await this.traceEvent('context.stale_reply_dropped', this.agentContext.staleReplyRow(attribution), { requestId })
    const error = new AgentLoopError(STALE_REPLY_MESSAGE)
    error.code = STALE_REPLY_ERROR_CODE
    error.staleKind = kind
    throw error
  }

  // Counts provider rounds in flight (the request await and the reply processing
  // inside it) so restageContext can refuse while one is open. Rounds are also
  // counted per loop generation (U8): a round that outlives a reset (an aborted
  // turn, a stale provider) belongs to a discarded generation, its reply is
  // dropped as stale, and it can never touch the new conversation, so it must
  // not block the restage of the current generation (C7 recovery runs right
  // after the supervisor cancelled the old turn).
  async callProvider(current, generation, options) {
    this.providerCallsInFlight++
    this.providerCallsByGeneration.set(generation, (this.providerCallsByGeneration.get(generation) ?? 0) + 1)
    try {
      return await this.callProviderRound(current, generation, options)
    }
    finally {
      this.providerCallsInFlight--
      const remaining = (this.providerCallsByGeneration.get(generation) ?? 1) - 1
      if (remaining > 0) this.providerCallsByGeneration.set(generation, remaining)
      else this.providerCallsByGeneration.delete(generation)
    }
  }

  async callProviderRound(current, generation, {
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
    await this.rollProviderBudgetAtStepClose('provider_call_boundary')
    await this.traceWorkingCeiling('provider_call')

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
    // Heavy planning turns spend the whole output cap, reasoning included,
    // before emitting anything when the model works out every later step up
    // front. Plan at outline level; each step is refined when it is active.
    if (providerMessagesOverride === undefined
      && (triggerSource === 'new_goal' || ['deep', 'strategic'].includes(this.reasoningBudgetOverride))) {
      providerMessages = [...providerMessages, { role: 'user', content: PLANNING_LOD_GUIDANCE }]
    }
    // An assembly invariant, not a repair: a split tool exchange is a harness
    // bug, and sending it only turns that bug into a provider 400.
    const sequenceViolation = toolReplySequenceViolation(providerMessages)
    if (sequenceViolation) {
      await this.traceEvent('provider.message_sequence_invalid', { round, ...sequenceViolation })
      throw new AgentLoopError(`provider_message_sequence_invalid: assistant tool_calls at message ${sequenceViolation.index} lack tool replies for ${sequenceViolation.unanswered.join(', ')} (next role: ${sequenceViolation.next_role ?? 'none'})`)
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
    const roundPhase = this.providerRoundPhase(effectiveAllowTools, triggerSource)
    const requestChars = providerMessages.reduce((total, message) => total + messageChars(message), 0)
    const prefixChars = providerMessages.filter((message, index) => message?.role === 'system' && providerMessages.slice(0, index).every(before => before?.role === 'system')).reduce((total, message) => total + messageChars(message), 0)
    const attribution = this.agentContext.beginRequest(requestChars, { prefixChars }) // U4: which conversation this round belongs to
    this.turnConversation = attribution
    await this.traceEvent('provider.request', {
      round,
      trigger_source: triggerSource,
      round_phase: roundPhase.phase,
      round_phase_reason: roundPhase.reason,
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
      message_chars: requestChars,
      ...this.agentContext.traceFields(attribution),
    })
    let message
    try {
      message = await this.provider(providerMessages, {
        ...this.providerRoleFields(attribution),
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
        roundPhase: roundPhase.phase,
        // The prompt trace keys every provider row by this id (1.3); without
        // it requests had to be rebuilt from round-0 boundaries.
        requestId: this.traceRequest?.id,
        onReasoningPolicy: decision => this.traceEvent('provider.round_policy', {
          round,
          trigger_source: triggerSource,
          round_phase: roundPhase.phase,
          round_phase_reason: roundPhase.reason,
          effort: decision?.effort,
          reason: decision?.reason,
          output_cap: decision?.output_cap,
          output_cap_source: decision?.output_cap_source,
          capability_profile: decision?.capability_profile,
          recovery_attempt: effectiveRecoveryAttempt,
          recovery_kind: traceRecoveryKind,
        }),
        signal: controller.signal,
      })
      const usage = estimatedOutputUsage(normalizedProviderUsage(message?._sglunaProvider?.usage), message?._sglunaProvider)
      if (usage?.output_units_estimated === true) {
        if (this.traceRequest && this.traceRequest.usage_estimated_traced !== true) {
          this.traceRequest.usage_estimated_traced = true
          await this.traceEvent('budget.usage_estimated', {
            reason: 'provider_reported_no_output_usage',
            round,
            estimated_output_units: usage.output_units,
            estimate_source: 'requested_output_cap',
          })
        }
      }
      accumulateProviderUsage(this.traceRequest?.usage, usage)
      // U4: a reply for a discarded conversation still cost real usage (counted
      // request-wide above) but is not the active conversation's spend.
      const staleReply = this.agentContext.isStale(attribution)
      this.agentContext.observeReply(attribution, usage)
      if (Number.isSafeInteger(usage?.output_units) && !staleReply) this.providerBudgetGenerationOutputUnits += usage.output_units
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
        provider: compactProviderMetadata(message?._sglunaProvider),
        turn_output_cap: this.maxProviderOutputUnits,
        turn_output_units: Number.isSafeInteger(generationOutputUnits) ? generationOutputUnits : undefined,
        budget_generation: this.providerBudgetGeneration,
        request_output_units: Number.isSafeInteger(aggregateOutputUnits) ? aggregateOutputUnits : undefined,
        ...this.agentContext.traceFields(attribution),
      }
      if (responseTrace.provider) responseTrace.provider.usage_complete = usage?.usage_complete === true
      if (this.traceRequest && !staleReply) this.traceRequest.last_provider_event = responseTrace
      await this.traceEvent('provider.response', responseTrace)
      if (staleReply) await this.dropStaleReply(attribution, undefined, attribution.lineage !== this.agentContext.lineageSequence ? 'superseded' : 'restage')
      // provider-base reports the profile's context window on every response,
      // so the ceiling follows the configured profile even when the loop was
      // built without its provider config.
      if (this.applyContextWindowCeiling(message?._sglunaProvider?.provider_context_window, 'provider_response')) {
        await this.traceWorkingCeiling('context_window_reported')
      }
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
      const requestCeiling = this.requestOutputCeiling()
      const sliceCeiling = this.sliceOutputCeiling()
      if (sliceCeiling.exceeded) {
        await this.traceEvent('budget.request_ceiling_exceeded', {
          reason: 'request_output_ceiling',
          request_output_units: sliceCeiling.used,
          request_output_ceiling: requestCeiling,
          aggregate_output_units: sliceCeiling.aggregate,
          slice_output_baseline: sliceCeiling.baseline,
          output_cap: this.maxProviderOutputUnits,
          budget_generation: this.providerBudgetGeneration,
          provider_calls: this.traceRequest?.usage?.provider_calls,
        })
        const ceilingError = new AgentLoopError(`request_output_ceiling: request used ${sliceCeiling.used} > ${requestCeiling} output units across ${this.providerBudgetGeneration} budget generation(s)`)
        ceilingError.code = 'request_output_ceiling'
        throw ceilingError
      }
    }
    catch (error) {
      if (error?.code === STALE_REPLY_ERROR_CODE) throw error // already traced and dropped above
      const messageText = error instanceof Error ? error.message : String(error)
      const staleReply = this.agentContext.isStale(attribution)
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
        ...this.agentContext.traceFields(attribution),
      }
      if (this.traceRequest && !staleReply) this.traceRequest.last_provider_event = errorTrace
      await this.traceEvent('provider.error', errorTrace)
      // A failure that belongs to a discarded conversation must not fail the active one.
      if (staleReply) await this.dropStaleReply(attribution, undefined, attribution.lineage !== this.agentContext.lineageSequence ? 'superseded' : 'restage')
      throw error
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    if (generation !== this.generation || !this.active) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()
    await this.dropIfStale(attribution)
    if (!message || typeof message !== 'object') throw new AgentLoopError('Provider returned no message')
    // Calls a closed round made anyway (structured or leaked DSML text); provider-base
    // dropped them from the message and left them here for salvage.
    const closedRoundCalls = !effectiveAllowTools ? message._sglunaClosedRoundCalls : undefined

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
        finish_reason: message._sglunaProvider?.finish_reason,
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

    if (Array.isArray(closedRoundCalls) && closedRoundCalls.length > 0) {
      const salvaged = await this.salvageClosedRoundCalls(message, closedRoundCalls, {
        current, generation, round, recoveryAttempt, recoveryKind, omissionRepair,
      })
      if (salvaged) return salvaged
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
      await this.dropIfStale(attribution)
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
        // The retry rebuilds the request from this round's messages: never under another conversation's attribution.
        await this.dropIfStale(attribution)
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
        if (error?.code === STALE_REPLY_ERROR_CODE) {
          if (error.staleKind === 'restage' && generation === this.generation) {
            // A restage replaced the conversation of the same lineage: the retry never ran for
            // the active conversation and this turn is re-driven on it, so drop the in-flight
            // marker so a later restart does not take the fail-closed pause for a recovery that
            // did not happen.
            this.memory.setProviderRecovery?.(this.activePlanKey(), undefined)
            await this.persistState()
          }
          else {
            // A reset outlived this turn: the durable state belongs to the new lineage now, so a
            // stale turn writes nothing. The marker stays for the restart path's fail-closed
            // handling (recoverInterruptedAgentPlan), exactly as for any other superseded turn.
            // The reset that superseded the turn may have cleared the request: the turn's own scope still names it.
            const keptRequestId = this.traceRequest?.id ?? this.turnScope.getStore()?.requestId
            await this.traceEvent('provider.output_budget_recovery_marker_kept', {
              request_id: keptRequestId,
              reason: 'turn_superseded_by_reset',
              stale_kind: error.staleKind,
              round,
            }, { requestId: keptRequestId })
          }
          throw error
        }
        if (error?.code !== 'provider_output_budget_recovery_exhausted') {
          await this.traceEvent('provider.output_budget_recovery_failed', { round, recovery_attempt: 1, recovery_kind: 'output_budget_exhaustion', message: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
    }
    return message
  }

  // The prompt advertises this runtime's operation catalog, so the plan must be
  // admitted against the same catalog; the staging parser does not know
  // place_candidate and refused it live (2026-09-29, "Unapproved operation").
  parsePlanValue(raw) {
    return parseRuntimePlan(raw)
  }

  parsePlanMessage(message) {
    if (providerOutputBudgetExhausted(message)) {
      const error = new AgentLoopError('provider_output_budget_exhausted: provider response exhausted its output budget before emitting valid plan content')
      error.failureClass = 'provider_budget'
      error.code = 'provider_output_budget_exhausted'
      throw error
    }
    if (message?._sglunaProvider?.diagnostic_code === 'provider_safety_blocked') {
      const error = new AgentLoopError('provider_safety_blocked: provider refused the response through a safety/content filter')
      error.failureClass = 'provider_safety'
      error.code = 'provider_safety_blocked'
      throw error
    }
    // The provider named why it could not use the content (provider.plan_content_refused and
    // provider.dsml_rejected carry the same code in the prompt trace). Say the exact expected
    // shape instead of the generic "Invalid provider content JSON", so the bounded format
    // recovery tells the model what to change.
    const planContentRefused = message?._sglunaProvider?.plan_content_refused_reason
    if (typeof planContentRefused === 'string') {
      const error = new AgentLoopError(`plan_content_refused: ${planContentRefused}. Reply with ONE JSON object {"chatMessage":"","plan":[...],"currentStep":0,"operations":[...]} (optional members: semanticCompletion, checkpoint, goal, roadmap, roadmapNodeIds, developmentMode). Do not wrap it in a submitPlan member that disagrees with plan, currentStep or operations`)
      error.code = 'plan_content_refused'
      throw error
    }
    const dsmlRejected = message?._sglunaProvider?.dsml_rejected_reason
    if (typeof dsmlRejected === 'string') {
      const error = new AgentLoopError(`dsml_malformed: ${dsmlRejected}. The tool-call markup was not a valid call and tool calls cannot be used for this reply. Reply with ONE JSON object {"chatMessage":"","plan":[...],"currentStep":0,"operations":[...]} and no tool-call markup`)
      error.code = 'dsml_malformed'
      throw error
    }
    let checkpoint
    let goalDefinition
    let roadmap
    let roadmapNodeIds
    let developmentMode
    let semanticCompletion
    let timeReview
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
        if (Array.isArray(raw.roadmap)) roadmap = normalizeRoadmapNodes(raw.roadmap)
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
        // 2.6: the model's answer to a time review; traced, never executed.
        if (Object.prototype.hasOwnProperty.call(raw, 'timeReview')) timeReview = parseTimeReview(raw.timeReview)
        if (checkpoint || semanticCompletion || roadmap || roadmapNodeIds || developmentMode || goalDefinition
          || Object.prototype.hasOwnProperty.call(raw, 'timeReview')
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
            timeReview: _timeReview,
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
    if (timeReview) plan.timeReview = timeReview
    if (semanticCompletion) {
      // Refused here, the claim reaches the planner as a correction it can act
      // on; refused in commitPlan, it failed the request (live, 2026-09-25).
      this.semanticCompletionClaimCheck(
        semanticCompletion,
        this.memory.currentPlan?.(this.requestInfo?.memoryKey ?? this.activePlanKey()),
      )
    }
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

  // Goal requirements (goal-requirements.mjs): after the first plan's goal definition is accepted and before the plan is
  // committed or any operation admitted, the live game is read once for the targets' locked recipes, machines and
  // research. If anything is locked the planner gets ONE corrective round with those facts (combined with the
  // goal-reading challenge when that also fires). The harness never edits the plan, shelf or steps. A provider-error
  // recovery attempt never gets the round: it would spend the attempt on a valid plan.
  async parsePlanMessageChecked(message, options = {}) {
    let plan
    try {
      plan = this.parsePlanMessage(message)
    }
    catch (error) {
      if (error?.code === 'goal_reading_disagreement') await combineGroundingWithChallenge(this, error, options)
      throw error
    }
    const grounding = await groundFirstPlan(this, plan, options)
    if (grounding) {
      const error = new AgentLoopError(grounding.message)
      error.failureClass = 'plan_category'
      error.code = grounding.code
      error.details = grounding.details
      throw error
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
        Object.defineProperty(prepared, '_sglunaObservationAdmission', {
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

  recordJevObservations(names) {
    if (names.length === 0) return
    this.jev?.noteObservations(names) // U11: the lookups a fresh agent (or a C4 wake) actually makes
    this.jevObservationLog = [
      ...(this.jevObservationLog ?? []),
      ...names.map(tool => ({ tool, family: observationToolFamily(tool), after_batch: this.latestCompletedBatchId ?? 0 })),
    ].slice(-JEV_OBSERVATION_LOG_LIMIT)
  }

  // What the planner already knows, computed by code so Jev does not have to
  // infer it: recent fresh reads (stale once a newer batch has completed), the
  // plan's steps, and whether the active step has completion evidence yet.
  jevObservationContext(planState) {
    const latest = this.latestCompletedBatchId ?? 0
    const board = planState?.task_board
    const steps = Array.isArray(board?.steps) ? board.steps : []
    const activeStep = Number.isSafeInteger(board?.active_index) ? steps[board.active_index] : undefined
    return {
      known_observations: (this.jevObservationLog ?? []).map(entry => ({
        tool: entry.tool,
        family: entry.family,
        stale: entry.after_batch < latest,
      })),
      plan_steps: steps.slice(0, 16).map(step => ({
        description: sanitizeDurableModelText(step?.description, 200),
        status: step?.status,
      })),
      active_step_has_completion_evidence: activeStep
        ? (board?.evidence ?? []).some(item => item?.step_id === activeStep.id && SEMANTIC_GROUNDING_KINDS.has(item?.kind))
        : false,
    }
  }

  // With tools open the planner reply is a submitPlan call; without tools
  // (a closed observation phase, bounded recovery) it is the strict-JSON
  // content fallback, since no tool is offered to call.
  validReplyShape({ toolsEnabled }) {
    return toolsEnabled
      ? 'Valid next reply: approved observation tool call(s) with strict JSON arguments, or one submitPlan call (strict-JSON plan content with no tool_calls field also works).'
      : super.validReplyShape({ toolsEnabled })
  }

  planReplyName() {
    return 'one submitPlan call'
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

    const admission = prepared._sglunaObservationAdmission
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
    // Jev's budget bounds planner rounds, not which facts the planner may see
    // (see OBSERVATION_TOOL_TIER). Fact reads are always admitted; one
    // discovery read per batch is admitted even when Jev deferred it. Both
    // still count against the budget below, so an exhausted budget forces the
    // next decision without tools.
    const tierAdmitted = []
    let discoveryAdmitted = 0

    for (let index = 0; index < prepared.length; index++) {
      const fresh = cachedPrepared[index] !== true && staticCachedPrepared[index] !== true
      const name = prepared[index]?.tool?.function?.name
      const family = observationToolFamily(name)
      const tier = observationToolTier(name)
      const relevant = !fresh || selectedObservationFamilies === null || selectedObservationFamilies.has(family)
      const withinJev = relevant && (!fresh || freshSlots > 0)
      // Once the budget closed the observation phase, nothing is admitted:
      // that is what bounds the planner's rounds.
      const tierOverride = fresh && !withinJev && this.observationDecisionForced !== true
        && (tier === 'fact' || (tier === 'discovery' && discoveryAdmitted === 0))
      if (withinJev || tierOverride) {
        admittedPrepared.push(prepared[index])
        admittedCached.push(cachedPrepared[index])
        admittedStaticCached.push(staticCachedPrepared[index])
        if (tier === 'discovery') discoveryAdmitted++
        if (tierOverride) tierAdmitted.push({ tool: name, tier })
        else if (fresh && Number.isFinite(freshSlots)) freshSlots--
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

    if (tierAdmitted.length > 0) {
      await this.traceEvent('observation.tier_admitted', {
        tools: tierAdmitted,
        budget_remaining_before: Number.isSafeInteger(this.observationBudgetRemaining) ? this.observationBudgetRemaining : undefined,
        selected_families: selectedObservationFamilies ? [...selectedObservationFamilies] : undefined,
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
    // The base pushes the assistant tool-call message before its first assertCurrent.
    await this.dropIfStale(this.turnConversation)
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
        content: `[HARNESS] Observation batch partially admitted: executed ${admittedPrepared.length} read-only call(s) and deferred ${totalDeferredCount} (${[...new Set([...deferredPrepared.map(entry => entry.tool.function.name), ...rawDeferredTools.map(tool => tool?.function?.name).filter(Boolean)])].slice(0, 8).join(', ')}) due to the per-turn observation cap. Reuse the returned evidence first; request only still-needed deferred facts on a later observation turn.`,
      })
    }
    const freshResultObserved = results.some((_, index) => admittedCached[index] !== true && admittedStaticCached[index] !== true)
    if (freshResultObserved) this.freshObservationSinceContinuation = true
    this.recordJevObservations(admittedPrepared
      .filter((_, index) => admittedCached[index] !== true && admittedStaticCached[index] !== true)
      .map(entry => entry.tool.function.name))
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
        await traceSkillLoaded(this, loadedSkill) // 2.8 hook
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

  // Closing a step changes no world state, so a fresh read taken earlier in
  // this continuation still grounds the next step's claim. Any new batch
  // returns through a continuation, which clears it.
  resetRepairAfterClosedStep() {
    const freshObservation = this.freshObservationSinceContinuation
    this.clearActionOmissionRecovery()
    this.freshObservationSinceContinuation = freshObservation
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
      if (result?.ok !== true && TRANSFER_SUPPLY_PREFLIGHT_CODES.has(result?.code)) {
        // The mod answers from the world as it is NOW. An earlier operation of this batch that could supply the item
        // (a craft, a gather, an extraction) has not run yet, so the transfer is accepted with its dependency recorded
        // and the execution-time checks decide.
        const dependencies = transferBatchDependency(operations, index, result)
        if (dependencies) {
          results[results.length - 1] = { ...result, ok: true, deferred: 'batch_dependency', dependencies }
          await this.traceEvent('transfer.preflight_supply_deferred', {
            request_id: this.traceRequest?.id,
            step_id: this.memory.currentPlan?.(memoryKey)?.task_board?.active_step_id,
            operation_index: index,
            operation: operations[index].name,
            code: result.code,
            reason: 'earlier_operation_in_batch_could_supply',
            dependencies,
            facts: transferSupplyFacts({ ...result, operation_index: index }),
          })
          continue
        }
      }
      if (result?.ok !== true) {
        const failure = new AgentLoopError(`Operation preflight rejected operation ${index + 1} (${operations[index].name}): ${result?.code ?? 'unknown_preflight_failure'}`)
        failure.preflight = { ...result, operation_index: index }
        failure.preflightResults = results.slice()
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

  // A transfer preflight that proved the move cannot move anything yet (see TRANSFER_SUPPLY_RECOVERABLE_KIND). Protected
  // and reserved targets keep the admission handling; stale actor/epoch never reaches here (assertCurrent throws first).
  // 'recovered' re-enters the planner turn inside the same committed step; 'refused' hands back the admission failure;
  // 'unhandled' (no live plan, or the budget is spent) leaves the rejection to the ordinary blocker path.
  async handleTransferSupplyPreflight(failure, plan, before, stateResult) {
    const preflight = failure.preflight
    const key = this.requestInfo?.memoryKey
    const requestId = this.traceRequest?.id
    const index = Number.isSafeInteger(preflight.operation_index) ? preflight.operation_index : 0
    const operation = plan.operations?.[index]
    if (!key || !operation) return { action: 'unhandled' }

    if (typeof this.memory.checkOperationAdmission === 'function') {
      // Operations 0..index with the preflight results gathered so far (the failing one carries its target), so a
      // reserved/protected target earlier in the batch refuses first and no recovery budget is spent.
      const collected = Array.isArray(failure.preflightResults) ? failure.preflightResults : []
      const admission = this.memory.checkOperationAdmission(key, {
        operations: plan.operations.slice(0, index + 1),
        preflight: plan.operations.slice(0, index + 1).map((_, i) => (i === index ? { ok: true, operation: operation.name, target: preflight.target } : (collected[i] ?? { ok: true }))),
        actor: { actor_id: before.actor_id, actor_epoch: before.epoch },
      }, { requestId })
      if (admission?.ok === false) {
        const refusal = new AgentLoopError(`Operation admission refused operation ${index + 1}: ${admission.code}`)
        refusal.preflight = {
          ok: false,
          code: admission.code,
          reason: admission.reason,
          operation: admission.operation,
          operation_index: admission.operation_index ?? index,
          identity: admission.unit_number,
          detail: admission.reason,
          ...(admission.last_user ? { last_user: admission.last_user } : {}),
        }
        return { action: 'refused', error: refusal }
      }
    }

    const state = this.memory.currentPlan?.(key)
    if (state && state.status !== 'active') return { action: 'unhandled' }
    const board = state?.task_board
    const prior = transferSupplyRecoveryCount(board)
    const facts = transferSupplyFacts({ ...preflight, operation_index: index })
    const base = {
      request_id: requestId,
      step_id: board?.active_step_id,
      operation_index: index,
      operation: operation.name,
      code: preflight.code,
      facts,
    }
    await this.traceEvent('transfer.preflight_missing_supply', {
      ...base,
      reason: 'preflight_proved_transfer_moves_nothing',
      recoveries_used: prior,
      retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
    })
    if (prior >= TRANSFER_SUPPLY_RECOVERY_BUDGET) {
      await this.traceEvent('transfer.supply_recovery_exhausted', {
        ...base,
        phase: 'preflight',
        reason: 'recovery_budget_spent_step_blocked_through_existing_path',
        recoveries_used: prior,
        retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
      })
      return { action: 'unhandled' }
    }

    const attempt = prior + 1
    const admissionState = this.memory.setAdmissionState?.(key, 'preflight_rejected')
    if (admissionState) stateResult = { ...(stateResult ?? {}), state: admissionState }
    const recoveryRef = `${requestId ?? 'request'}/transfer_${preflight.code}_${index}`
    this.memory.noteTransferSupplyRecovery?.(key, recoveryRef)
    this.memory.recordBoardEvidence?.(key, {
      kind: TRANSFER_SUPPLY_RECOVERABLE_KIND,
      ref: recoveryRef,
      summary: JSON.stringify({
        phase: 'preflight',
        failure_class: `transfer_${preflight.code}`,
        ...facts,
        items: facts.items.slice(0, 3),
        attempt,
        retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
      }),
    })
    await this.persistState()
    await this.traceEvent('transfer.supply_recovery', {
      ...base,
      phase: 'preflight',
      attempt,
      retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
      tools_enabled: true,
      plan_changed: false,
      reason: 'recoverable_acquisition_dependency_in_same_step',
    })
    await this.traceEvent('operations.preflight_recoverable', {
      failure_class: `transfer_${preflight.code}`,
      preflight,
      tools_enabled: true,
      retry: attempt,
      retry_budget: TRANSFER_SUPPLY_RECOVERY_BUDGET,
    })
    this.messages.push({
      role: 'user',
      content: `[HARNESS] Deterministic transfer preflight proved operation ${index + 1} (${cleanMemoryText(operation.name, 80)}) cannot move anything right now (${preflight.code}: ${TRANSFER_SUPPLY_CODE_MEANING[preflight.code] ?? 'nothing would move'}); no operation from this batch ran. This is a recoverable supply dependency inside the same committed step, not WORLD_BLOCKED: the plan, step contract and requested result are unchanged, and tools remain enabled. A destination that already holds the item does not by itself complete the transfer. Choose how to acquire the missing amount, or submit a different valid transfer for this step. Recovery ${attempt} of ${TRANSFER_SUPPLY_RECOVERY_BUDGET} before this step blocks. Facts from the live game: ${JSON.stringify(facts)}`,
    })
    return { action: 'recovered', stateResult }
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
        // A locked recipe names its unlocking technology and the next research node (still a terminal blocker).
        ...(failure?.preflight?.code === 'recipe_locked' ? { locked_recipe: describeLockedRecipePreflight(failure.preflight).facts } : {}),
        factorio_error: factorioError,
        no_replay: failure?.noReplay === true,
      }),
    }
    const blocker = failure?.preflight?.code === 'recipe_locked'
      ? lockedRecipeBlocker(failure.preflight)
      : failure?.preflight?.code
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

    // An uncertain-effect hold is harness truth, rather than the provider's
    // guess about a world blocker. Only the exact still-open refused operation
    // may supply that evidence; a later receipt or another task cannot inherit it.
    const uncertaintyHold = evidenceKind === 'provider_blocker' && this.duplicateEffectHold
      ? (this.memory.pendingOperations?.(this.requestInfo.memoryKey) ?? []).find(record =>
        record.operation_key === this.duplicateEffectHold.operation_key
        && ![EFFECT.NOT_HAPPENED, EFFECT.HAPPENED].includes(record.effect)) : undefined
    if (uncertaintyHold) {
      blocker = 'unresolved_operation_effect'
      evidenceKind = 'deterministic_preflight'
      await this.traceEvent('operation.uncertainty_blocked', {
        reason: 'unresolved_operation_scope_conflict', operation_key: uncertaintyHold.operation_key,
        effect: uncertaintyHold.effect, request_id: this.traceRequest?.id,
      })
    }
    const blockerCandidate = {
      kind: 'world_blocked',
      source: uncertaintyHold ? 'operation_reconciliation' : evidenceKind === 'provider_blocker' ? 'main_planner' : 'action_omission_repair',
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

  // Every check a semantic completion claim must pass before the reducer sees
  // it. None of them mutates state, so parsePlanMessage runs them too: a
  // refused claim then goes back to the planner as a plan correction instead
  // of failing the whole request from inside commitPlan.
  semanticCompletionClaimCheck(claim, state) {
    if (!this.requestInfo?.memoryKey || !state || state.status !== 'active') {
      // A paused goal is resumed only when this turn's operations are
      // admitted, so a claim in a resume turn (the player's "continue", the
      // UI Resume, an automatic resume) still meets the paused board. The
      // guard stands: a paused plan must not advance before it is resumed.
      const status = state?.status ?? 'none'
      const pause = state?.status === 'paused' && state.pause_reason ? ` (${cleanMemoryText(state.pause_reason, 200)})` : ''
      const error = new AgentLoopError(state?.status === 'paused'
        ? `semantic_completion_requires_active_step: the goal is paused${pause}, so no step can be closed in this turn. Resubmit the plan and its operations without semanticCompletion. The goal resumes when this turn's operations are admitted; a step that is already satisfied can then be closed on the next turn with the evidence you hold.`
        : `semantic_completion_requires_active_step: the goal is ${status}, so there is no active step to close. Resubmit without semanticCompletion.`)
      error.failureClass = 'plan_category'
      error.code = 'invalid_semantic_completion'
      throw error
    }

    const board = state.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
    const step = activeIndex === undefined ? undefined : board?.steps?.[activeIndex]
    // The prompt tells the planner to use the Plan Tracker id from
    // [PLANNING_STATE]; the Task Board projection names the same step
    // step_N. Accept the tracker id only while both point at the same step.
    const trackerPlan = getActivePlanningPlan(this.memory.planningState?.(this.requestInfo.memoryKey))
    // A revised plan's board leads with its predecessor's verified steps, so
    // the board index is mapped onto the tracker's step list, not compared
    // with the tracker's own index.
    const boardStepTrackerId = typeof this.memory.trackerStepIdForBoardIndex === 'function'
      ? this.memory.trackerStepIdForBoardIndex(this.requestInfo.memoryKey, activeIndex)
      : trackerPlan?.steps?.[activeIndex]?.step_id
    const trackerStepId = boardStepTrackerId !== undefined
      && trackerPlan?.steps?.[trackerPlan.active_step_index]?.step_id === boardStepTrackerId
      ? boardStepTrackerId
      : undefined
    if (!step || (claim.stepId !== step.id && claim.stepId !== trackerStepId)) {
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

    const grounding = [...(board?.evidence ?? [])]
      .filter(item => item?.step_id === step.id
        && typeof item?.ref === 'string'
        && item.ref
        && SEMANTIC_GROUNDING_KINDS.has(item?.kind))
      .slice(-4)
      .map(item => ({
        kind: item.kind,
        ref: item.ref,
        summary: cleanMemoryText(item.summary, 1200),
      }))

    if (this.freshObservationSinceContinuation) {
      grounding.push({
        kind: 'verified_world_state',
        // One record per step: the evidence store drops a repeated ref, which
        // would leave the next step's claim with nothing bound to it.
        ref: `${this.traceRequest?.id ?? 'request'}/semantic_fresh_observation/${step.id}`,
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
    return { step, grounding: deduped }
  }

  async applySemanticCompletionClaim(plan, state) {
    const claim = plan?.semanticCompletion
    if (!claim) return { applied: false, state }
    const { step, grounding: deduped } = this.semanticCompletionClaimCheck(claim, state)

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
      error.rejectionReason = reduced?.decision?.rejection_reason
      if (reduced?.progressDisagreement) {
        await this.traceEvent('step.progress_disagreement', { trigger: 'semantic_completion', ...reduced.progressDisagreement })
      }
      if (reduced?.decision?.paused === true) {
        error.pausedForDisagreement = true
        error.disagreement = reduced.progressDisagreement
        await this.persistState()
      }
      throw error
    }
    await this.persistState()
    if (reduced?.progressDisagreement) await this.traceEvent('step.progress_disagreement', { trigger: 'semantic_completion', ...reduced.progressDisagreement })
    await this.traceEvent('step.semantic_completed', {
      active_step_id: step.id,
      source: 'main_planner',
      grounding_refs: groundingRefs,
      rationale: cleanMemoryText(claim.rationale, 600),
      task_board: visibleTaskBoard(reduced?.state?.task_board),
    })
    await this.rollProviderBudgetAtStepClose('main_planner_semantic', reduced.state)
    return { applied: true, state: reduced.state }
  }

  // 2.6 (W2c): the harness estimates the draft batch from game rates before
  // anything is recorded. A draft that runs long on the NPC's one lane, from a
  // request with no estimate tool call, is held for one review round: the
  // draft is not committed, so no committed plan changes, and the model may
  // resubmit it unchanged with a traced reason.
  async reviewPlanTime(plan) {
    if (!this.planTiming || !this.traceRequest || !Array.isArray(plan?.operations) || plan.operations.length === 0) return undefined
    let result
    try {
      const state = this.peekPlanState(this.activePlanKey())
      result = await this.planTiming.reviewDraft(this.rcon, plan, {
        actorId: this.epoch?.actor_id,
        epoch: this.epoch?.epoch,
        requestId: this.traceRequest.id,
        currentStep: plan.currentStep,
        activeStep: activeStepOf(state),
        estimateToolCalled: this.planTiming.estimateToolCalledThisRequest(),
        // Recovery rounds run without tools, and a blocked plan waits for the
        // player: neither gets a review round.
        recoveryMode: Boolean((this.recoveryCommitDepth ?? 0) > 0 || this.genericRecoveryDecisionActive
          || this.outputBudgetRecoveryGuard || this.actionOmissionRepairActive || state?.status === 'blocked'),
      })
    }
    catch (error) {
      this.log(`[time] plan estimate failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    for (const [name, payload] of result.events) await this.traceEvent(name, payload)
    if (!result.hold) return undefined
    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    this.messages.push({ role: 'user', content: result.message })
    return { held: true, result: await this.runTurn() }
  }

  async commitPlan(plan) {
    plan = await this.enforceExecutorContract(plan) // U6: an executor reply never changes plan semantics
    if (plan.executorCannotAuthor) return this.endSliceWithoutPlanner({ route: 'executor_reply_without_committed_plan', reason: 'executor_cannot_author_plan' })
    const timeReview = await this.reviewPlanTime(plan)
    if (timeReview?.held === true) return timeReview.result
    plan = await this.applyLowRiskTypedProjection(plan)
    const triggerSource = this.reasoningTriggerSource ?? this.planUpdateReason
    let commands = plan.operations.map(renderOperation)
    let operations = plan.operations.map((operation, index) => ({
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
    await traceSkillsFollowed(this, plan) // 2.8 hook
    await retireGoalRequirements(this, plan)

    const before = await this.assertCurrent()
    const persistentRuntime = commands.length === 0 && plan.plan.length > 0
      ? await this.persistentRuntimeStatus()
      : undefined
    let previousState = this.requestInfo
      ? this.memory.currentPlan?.(this.requestInfo.memoryKey)
      : undefined
    const implied = plan.semanticCompletion ? undefined : impliedSemanticCompletion(plan, previousState)
    if (implied) {
      // The planner moved on to the next step without the explicit claim.
      // Apply the claim it implies under the same checks; if they fail, keep
      // the step open exactly as before instead of failing the request.
      try {
        const semantic = await this.applySemanticCompletionClaim({ ...plan, semanticCompletion: implied }, previousState)
        previousState = semantic.state ?? previousState
        if (semantic.applied === true) this.resetRepairAfterClosedStep()
      }
      catch (error) {
        await this.traceEvent('step.implied_completion_skipped', {
          active_step_id: implied.stepId,
          reason: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        })
      }
    }
    let assistantReplyRecorded = false
    if (plan.semanticCompletion) {
      let semantic
      try {
        semantic = await this.applySemanticCompletionClaim(plan, previousState)
      }
      catch (error) {
        // The reducer (or the plan/board agreement) declined an explicit claim.
        // That is a correctable planner message, not a failed request: the step
        // stays open and the reason goes back to the model. A repeat is not
        // retried again; it fails as before.
        if (error?.code !== 'semantic_completion_rejected') throw error
        if (error.pausedForDisagreement) return this.pauseForPlanBoardDisagreement(error.disagreement)
        const request = this.traceRequest
        if (!request || (request.semantic_claim_declines ?? 0) >= 2) throw error
        request.semantic_claim_declines = (request.semantic_claim_declines ?? 0) + 1
        const reason = cleanMemoryText(error.rejectionReason ?? error.message, 200)
        await this.traceEvent('step.semantic_completion_declined', {
          active_step_id: plan.semanticCompletion.stepId,
          reason,
        })
        this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
        this.messages.push({
          role: 'user',
          content: `[HARNESS] Your semanticCompletion for step ${JSON.stringify(cleanMemoryText(plan.semanticCompletion.stepId, 100))} was not applied (${reason}); the step stays open. ${reason.startsWith('plan_not_committed')
            ? 'The plan is not committed yet, so no step can close; the claim can be made again once the plan has been committed by submitting its operations.'
            : 'Do not repeat the claim. Continue the step\'s work, or add a checkpoint {mode,requirements} whose world state the runtime can verify.'}`,
        })
        return this.runTurn()
      }
      previousState = semantic.state ?? previousState
      // A closed step is progress: the next step gets a fresh act-or-block
      // repair instead of failing on the one this claim just resolved.
      if (semantic.applied === true) this.resetRepairAfterClosedStep()
      // The claim closed the last step of the committed slice. Operations in
      // the same reply belong to no committed plan, so they never run, and
      // dropping them must not fail the request (live 2026-09-29: the request
      // failed after the claim was applied, the slice-boundary settle never
      // ran, and the goal sat idle until the player typed "continue"). The
      // slice settles through the normal path instead: the game evaluates the
      // goal, and an unmet goal plans its next slice in this same request.
      let droppedOperationsNote = ''
      if (previousState?.status === 'completed' && commands.length > 0) {
        if (semantic.applied !== true) {
          const error = new AgentLoopError('semantic_completion_final_step_cannot_have_followup_operations')
          error.failureClass = 'plan_category'
          error.code = 'semantic_completion_after_final_step'
          throw error
        }
        const dropped = plan.operations.length
        await this.traceEvent('plan.followup_operations_dropped', {
          reason: 'final_step_closed_by_claim',
          count: dropped,
          operations: plan.operations.slice(0, 8).map(operation => cleanMemoryText(operation.name, 80)),
          step_id: plan.semanticCompletion?.stepId,
        })
        droppedOperationsNote = `Your reply that closed the final step also carried ${dropped} operation${dropped === 1 ? '' : 's'}; the harness did not run ${dropped === 1 ? 'it' : 'them'} because operations outside the committed plan are never executed. Put any further work into the next plan slice.`
        plan = { ...plan, operations: [] }
        commands = []
        operations = []
      }
      if (previousState?.status === 'completed' && commands.length === 0) {
        // Inside a planner turn: an unmet goal continues into its next slice
        // as this turn's next turn, so the request does not end idle.
        this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
        assistantReplyRecorded = true
        const settled = await this.settleCompletedStepState(previousState, { withinTurn: true, droppedOperationsNote })
        if (settled) return settled
        // Nothing settled the slice, so this reply is not a plan to persist:
        // the committed slice is immutable and the restated plan, checkpoint,
        // roadmap or goal never replace it. The request ends on the committed
        // state, and the player hears why the operations did not run.
        this.pendingDroppedOperationsNote = droppedOperationsNote
        const { roadmap, roadmapNodeIds, checkpoint, developmentMode, goalDefinition, ...kept } = plan
        plan = {
          ...kept,
          plan: Array.isArray(previousState.plan) ? previousState.plan : plan.plan,
          currentStep: Number.isSafeInteger(previousState.current_step) ? previousState.current_step : plan.currentStep,
          ...(droppedOperationsNote ? { chatMessage: `${plan.chatMessage ?? ''} ${droppedOperationsNote}`.trim() } : {}),
        }
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
    if (commands.length === 0 && plan.plan.length === 0 && remainingCanonicalWork && !runtimeHealthy && !explicitBlocker) {
      const finished = await this.finishIfGoalMet(plan, previousState)
      if (finished) return finished
    }
    // A batch of only `wait` operations is a blind timer. When the committed step's machine is working it is
    // routed to the bounded condition wait instead, through the same registration a zero-operation turn uses.
    const waitRoute = commands.length > 0
      ? await this.routeWaitOnlyBatch({ plan, previousState, remainingCanonicalWork, explicitBlocker })
      : undefined
    if (waitRoute?.routed === true) {
      // The reply as the model wrote it stays in the conversation; the timer itself never runs.
      this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
      assistantReplyRecorded = true
      plan = { ...plan, operations: [] }
      commands = []
      operations = []
    }
    let conditionWait = waitRoute?.routed === true
      ? waitRoute.conditionWait
      : previousState?.condition_wait?.state === 'active'
        ? previousState.condition_wait
        : undefined
    // An explicit BLOCKED reply is recorded as a blocker; it never becomes a wait.
    if (!conditionWait && commands.length === 0 && remainingCanonicalWork && !runtimeHealthy && !explicitBlocker) {
      const candidate = this.checkpointWaitCandidate(previousState) ?? this.passiveProgressWaitCandidate(previousState)
      const waiting = candidate ? await this.registerCandidateConditionWait(candidate) : undefined
      if (waiting?.condition_wait) conditionWait = waiting.condition_wait
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
        this.messages.push({ role: 'user', content: `[HARNESS] ${actionOmissionRepairMessage(state)}${plan.plan.length === 0 ? this.unmetGoalNote() : ''}` })
        return this.runTurn()
      }
    }

    if (runtimeHealthy || conditionWaitActive) this.clearActionOmissionRecovery()
    if (!assistantReplyRecorded) this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
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
      stateResult = this.memory.recordPlan?.(this.requestInfo.memoryKey, await this.revisionSafeRequestInfo(), durablePlan, {
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
          // Only the baselines are wanted here, so running checks are read once.
          if (definition.done_when.some(needsGoalBaseline)) await this.readGoalDefinition(this.requestInfo.memoryKey, definition, { ...this.goalSampling, samples: 1 })
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
        chat_message: planProgress(plan, stateResult),
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

    let committedPlanId // set when THIS reply committed the plan (C3: the executor takes over after admission)
    if (commands.length > 0) {
      let preflight
      try {
        preflight = await this.preflightOperations(plan.operations)
        this.staleExactPreflightRetries = 0
        this.modelCorrectablePreflightRetries = 0
        this.researchPreflightRetries = 0
        this.bootstrapDependencyPreflightRetries = 0
        // MW1 admission gate, run BEFORE the plan is committed so a refusal leaves the plan a DRAFT exactly as every other
        // deterministic refusal does: a replacement plan's grant is re-checked for this actor and epoch, an exact operation on
        // a player-built entity (grant-backed work) needs an approval record, reserved containers are never withdrawn from,
        // and (grant-backed work) a player's inventory is never a source. Commit re-checks the grant again below.
        if (this.requestInfo && typeof this.memory.checkOperationAdmission === 'function') {
          const admission = this.memory.checkOperationAdmission(this.requestInfo.memoryKey, {
            operations: plan.operations,
            preflight,
            actor: { actor_id: before.actor_id, actor_epoch: before.epoch },
          }, { requestId: this.traceRequest?.id })
          if (admission?.ok === false) {
            const failure = new AgentLoopError(`Operation admission refused operation ${(admission.operation_index ?? 0) + 1}: ${admission.code}`)
            failure.preflight = {
              ok: false,
              code: admission.code,
              reason: admission.reason,
              operation: admission.operation,
              operation_index: admission.operation_index ?? 0,
              identity: admission.unit_number,
              detail: admission.reason,
              ...(admission.last_user ? { last_user: admission.last_user } : {}),
            }
            throw failure
          }
          this.authorizationRefusalRetries = 0
        }
        // Recover exact receipts even when the notification was lost and this
        // turn arrived through recovery rather than completed().
        if (this.memory.pendingOperation?.(this.activePlanKey())) {
          await this.settleOutstandingOperation(await this.readTaskStatusRaw())
        }
        // Uncertain target/material effects remain fenced across plans and goals.
        if (this.requestInfo && typeof this.memory.checkDuplicateEffect === 'function') {
          const duplicate = this.memory.checkDuplicateEffect(this.requestInfo.memoryKey, { operations: plan.operations }, { requestId: this.traceRequest?.id })
          if (duplicate?.refuse) {
            const failure = new AgentLoopError('Operation admission refused: conflicting unresolved work may already have taken effect')
            failure.preflight = {
              ok: false,
              code: DUPLICATE_EFFECT_CODE,
              reason: duplicate.reason,
              operation_index: 0,
              detail: `effect=${duplicate.effect} verdict=${duplicate.verdict ?? 'none'} state=${duplicate.state}`,
              duplicate,
            }
            throw failure
          }
        }
        const planningBeforeCommit = this.requestInfo ? this.memory.planningState?.(this.requestInfo.memoryKey) : undefined
        const reducerPlanBeforeCommit = planningBeforeCommit ? getActivePlanningPlan(planningBeforeCommit) : undefined
        const planFrozen = FROZEN_PLAN_STATUSES.has(reducerPlanBeforeCommit?.status)
        if (!planFrozen && this.requestInfo && typeof this.memory.commitPlanningPlan === 'function') {
          // Preflight is the authoritative commit gate. Jev may help decide
          // what to observe or when to wake the planner, but it does not review
          // whether the Main LLM's draft is "correct" before execution.
          if ([PLAN_STATUS.DRAFT, PLAN_STATUS.RUNTIME_VALIDATION, PLAN_STATUS.READY].includes(reducerPlanBeforeCommit?.status)) committedPlanId = reducerPlanBeforeCommit.plan_id
          if (reducerPlanBeforeCommit?.replacement && typeof this.memory.commitReplacementPlan === 'function') {
            // MW1: a replacement plan commits only while its grant is current for THIS actor and epoch.
            const replaced = this.memory.commitReplacementPlan(this.requestInfo.memoryKey, {
              current: { actor_id: before.actor_id, actor_epoch: before.epoch },
              now: Date.now(),
              requestId: this.traceRequest?.id,
            })
            if (!replaced.ok) {
              const failure = new AgentLoopError(`Replacement plan commit refused: ${replaced.reason}`)
              failure.preflight = { ok: false, code: ADMISSION_REFUSAL.AUTHORIZATION_STALE, reason: replaced.reason, stage: 'commit', operation_index: 0 }
              throw failure
            }
          }
          else {
            this.memory.commitPlanningPlan(this.requestInfo.memoryKey, {
              now: Date.now(),
              runtime_validation: { passed: true },
            })
          }
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
        if (TRANSFER_SUPPLY_PREFLIGHT_CODES.has(error.preflight.code)) {
          const supply = await this.handleTransferSupplyPreflight(error, plan, before, stateResult)
          if (supply.action === 'recovered') {
            stateResult = supply.stateResult
            return this.runTurn()
          }
          // A protected/reserved target takes the admission refusal; a spent budget falls through to the blocker path.
          if (supply.action === 'refused') error = supply.error
          else if (supply.stateResult) stateResult = supply.stateResult
        }
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
        if (error?.preflight?.code === DUPLICATE_EFFECT_CODE
          && (this.duplicateEffectRetries ?? 0) < DUPLICATE_EFFECT_RETRY_BUDGET) {
          this.duplicateEffectRetries = (this.duplicateEffectRetries ?? 0) + 1
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: DUPLICATE_EFFECT_CODE,
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.duplicateEffectRetries,
            retry_budget: DUPLICATE_EFFECT_RETRY_BUDGET,
          })
          const held = error.preflight.duplicate ?? {}
          this.duplicateEffectHold = { operation_key: held.operation_key }
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Refused before admission: this batch conflicts with unresolved work whose effect is not proven absent (effect=${held.effect}, reconciliation verdict=${held.verdict ?? 'none'}); nothing from this batch ran. Do not bypass this hold by changing quantities, arguments, steps or plans. Reobserve the affected targets and materials within the recovery limits, then surface the blocker if uncertainty remains. Independently authorized work may continue only with disjoint targets and materials. Facts: ${JSON.stringify({ operation_key: held.operation_key, effect_classes: held.effect_classes, batch_id: held.batch_id })}`,
          })
          return this.runTurn()
        }
        if (AUTHORIZATION_RECOVERABLE_CODES.has(error?.preflight?.code)
          && (this.authorizationRefusalRetries ?? 0) < AUTHORIZATION_REFUSAL_RETRY_BUDGET) {
          this.authorizationRefusalRetries = (this.authorizationRefusalRetries ?? 0) + 1
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
                detail: cleanMemoryText(error.preflight.detail ?? '', 300),
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: `authorization_${error.preflight.code}`,
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.authorizationRefusalRetries,
            retry_budget: AUTHORIZATION_REFUSAL_RETRY_BUDGET,
          })
          const index = Number.isSafeInteger(error.preflight.operation_index) ? error.preflight.operation_index : 0
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Admission refused operation ${index + 1} (${cleanMemoryText(plan.operations[index]?.name, 80)}) with code ${error.preflight.code} (${cleanMemoryText(error.preflight.detail ?? '', 120)}); no operation from this batch ran. That target belongs to a player, is a reserved container, or is a player's inventory, and it is not available to you without the player's approval. Do not retry it and do not change the requested result. Choose a different supported approach that leaves protected and reserved assets alone (another source, or new infrastructure elsewhere), or tell the player which approval you need. Facts: ${JSON.stringify({ code: error.preflight.code, operation: error.preflight.operation, unit_number: error.preflight.identity, last_user: error.preflight.last_user })}`,
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
          chat_message: planProgress(plan, stateResult),
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

      const pendingAdmission = await this.recordPendingOperationBeforeSend(operations, before)
      const operationOwnerKey = this.activePlanKey()
      // A restage that landed during that await must not let this reply's batch through
      // (outside the try below: a stale drop is not an admission failure).
      try {
        await this.traceEvent('operations.admit', { operations })
        await this.assertCurrent()
      }
      catch (error) {
        // Transport has not been invoked. This local boundary proves this exact
        // prepared attempt absent; a later restart without this proof stays uncertain.
        if (pendingAdmission) await this.settleUnsentOperation(pendingAdmission, operationOwnerKey, 'cancelled_before_transport')
        throw error
      }
      let reconciledAdmitted = false
      try {
        const acknowledgement = await executeAuthorizedBatch(this.rcon, before.epoch, commands, undefined, pendingAdmission)
        await this.traceEvent('operations.ack', {
          operations: operations.map((operation, index) => ({ ...operation, admission_result: acknowledgement.results[index] })),
        })
        if (this.requestInfo) this.memory.updatePendingOperation?.(this.requestInfo.memoryKey, { state: PENDING_STATE.ACKNOWLEDGED }, pendingAdmission?.operation_key)
        if (this.requestInfo && stateResult?.state) {
          const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitted')
          if (state) stateResult = { ...stateResult, state }
          await this.persistState()
        }
        await this.assertCurrent()
      }
      catch (error) {
        // MW2b: the command was sent but no valid acknowledgement came back. Ask the game what really happened (exact batch,
        // actor and epoch correlation) before anything is issued again or the goal is blocked.
        // Rejected before the first byte reached RCON, or refused by the game before it recorded anything: provably not sent.
        if (pendingAdmission && (error?.notSent === true || error?.notAdmitted === true)) {
          await this.settleUnsentOperation(pendingAdmission, operationOwnerKey, error.notSent === true ? 'rejected_before_transport' : 'admission_refused_before_record')
        }
        let reconciliation
        if ((isLostAcknowledgement(error) || error?.admission) && this.requestInfo && typeof this.memory.pendingOperation === 'function') {
          reconciliation = await this.reconcileOutstandingOperation({ trigger: 'lost_acknowledgement', operationKey: pendingAdmission?.operation_key })
        }
        if (reconciliation?.admitted) {
          // The game took the batch; only its receipt is outstanding. Carry on as acknowledged: nothing is sent again.
          reconciledAdmitted = true
          await this.traceEvent('operations.ack', {
            operations: operations.map(operation => ({ ...operation, admission_result: 'reconciled_admitted' })),
            reconciled: true,
            reconciliation: reconciliationFacts(reconciliation, reconciliation.pending),
          })
          if (stateResult?.state) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitted')
            if (state) stateResult = { ...stateResult, state }
          }
          await this.persistState()
          await this.assertCurrent()
        }
        else if (reconciliation?.verdict === RECONCILE_VERDICT.NOT_ADMITTED && (this.lostAckRetries ?? 0) < LOST_ACK_RETRY_BUDGET) {
          this.lostAckRetries = (this.lostAckRetries ?? 0) + 1
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: 'lost_acknowledgement_not_admitted',
            tools_enabled: true,
            retry: this.lostAckRetries,
            retry_budget: LOST_ACK_RETRY_BUDGET,
            reconciliation: reconciliationFacts(reconciliation, reconciliation.pending),
          })
          this.messages.push({
            role: 'user',
            content: `[HARNESS] The game never acknowledged the last operation batch. ${reconciliationGuidance(reconciliation, reconciliation.pending)}`,
          })
          return this.runTurn()
        }
        if (!reconciledAdmitted) {
          stateResult = await this.markAdmissionFailure(stateResult, operations, error, 'operation_admission_failure')
          const operationIndex = Number.isSafeInteger(error?.operationIndex) ? error.operationIndex : undefined
          await this.traceEvent('operations.admission_failed', {
            failure_class: 'mutation_admission',
            request_id: this.traceRequest?.id,
            operation_index: operationIndex === undefined ? undefined : operationIndex + 1,
            operation: operationIndex !== undefined ? operations[operationIndex] : undefined,
            factorio_error: error?.factorioError,
            no_replay: error?.notSent !== true && error?.notAdmitted !== true,
            no_replay_reason: error?.notSent === true || error?.notAdmitted === true
              ? 'The game never received or recorded this batch; nothing from it ran.'
              : 'Earlier operations in the admitted batch may already have produced side effects.',
            reconciliation: reconciliation ? reconciliationFacts(reconciliation, reconciliation.pending) : undefined,
            task_board: visibleTaskBoard(stateResult?.state?.task_board),
          })
          throw error
        }
      }
    }

    // U6. The reply is admitted and appended; nothing is in flight. A reply that
    // committed the plan hands the slice to a fresh executor (C3). Otherwise a step this
    // reply closed may put an executor past its hard limit (C8).
    if (this.requestInfo && this.executorHandoffEnabled) {
      const boundaryRequestId = this.traceRequest?.id
      if (committedPlanId !== undefined && commands.length > 0) await this.startExecutorAtCommit({ planId: committedPlanId, requestId: boundaryRequestId })
      else await this.executorStepCloseBoundary({ withinTurn: true, requestId: boundaryRequestId })
    }

    // A planner "done" that finished the plan is not a finished goal: when
    // the goal has a game-checked definition, the game decides.
    // After the one extra turn, a second "done" without work ends honestly.
    if (commands.length === 0 && this.requestInfo && this.memory.goalDefinition?.(this.requestInfo.memoryKey)) {
      const planFinished = finalCompletionVerified && stateResult?.state?.status === 'completed'
      if (planFinished) {
        const settled = await this.settleCompletedStepState(stateResult.state, { allowContinuation: false })
        if (settled) return settled
      }
      if (planFinished || this.unmetGoalContinuationUsed === true) {
        const unmet = await this.continueUnmetGoal(plan, stateResult)
        if (unmet) return unmet
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
        chat_message: stateResult?.blockedByHarness ? planProgress(plan, stateResult) : plan.chatMessage,
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

  // Every commit reached through recovery (Jev recovery routes, the budget
  // handoff's fresh generation, format recovery) runs with the 2.6 time
  // review off: a held draft there would run a full planner turn inside the
  // recovery and could turn a recovery that commits into a failed one.
  async recoverPlan(generation, reason, roundBase) {
    this.recoveryCommitDepth = (this.recoveryCommitDepth ?? 0) + 1
    try {
      return await this.recoverPlanRoute(generation, reason, roundBase)
    }
    finally {
      this.recoveryCommitDepth--
    }
  }

  async recoverPlanRoute(generation, reason, roundBase) {
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
      await this.traceEvent('request.waiting', {
        reason: routed.rejection_reason ?? 'recovery_wait_runtime',
        task_board: visibleTaskBoard(state?.task_board),
        usage: this.traceRequest?.usage,
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
        // The request ends here; without a terminal event a paused goal
        // reads as a stalled request in the trace.
        await this.traceEvent('request.completed', {
          outcome: 'paused_recoverable',
          reason: routed.rejection_reason ?? routed.failure_class ?? recoveryFailureClassHint(reasonText),
          task_board: visibleTaskBoard(reduced.state?.task_board),
          usage: this.traceRequest?.usage,
        })
        this.traceRequest = null
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
      await this.traceEvent('request.completed', {
        outcome: 'asked_user',
        task_board: visibleTaskBoard(state?.task_board),
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
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
      // C5: the fresh generation is a restage from a handoff packet (same
      // role, fresh conversation, none of the exhausted thread's messages).
      const restaged = await this.restageInTurn(this.budgetHandoffPacketArgs({
        reason: reasonText,
        semanticScope,
        runtime: routed.runtime,
      }))
      if (!restaged.restaged) {
        // Refused (no admitted reducer goal, the reducer rejected the event): the
        // fresh generation must still not run on the exhausted thread.
        await this.traceEvent('budget.handoff_restage_fallback', { reason: restaged.reason, budget_generation: this.providerBudgetGeneration })
        const admittedGoal = this.memory.planningState?.(key)?.goal
        const capsule = providerBudgetHandoffCapsule(
          this.memory.currentPlan?.(key),
          routed.runtime ?? routed.persistentRuntime,
          reasonText,
          semanticScope,
          {
            admittedGoal: admittedGoal?.status === GOAL_STATUS.ACTIVE ? admittedGoal : undefined,
            request: this.requestInfo,
          },
        )
        this.messages = [
          ...this.rolePrefixMessages(this.agentContext.role),
          { role: 'user', content: capsule },
        ]
        // The capsule fallback replaces the conversation too: a staged amendment rides it.
        const held = this.currentPendingAmendment()
        if (held) this.messages.push({ role: 'user', content: `[CHAT] ${held.sender}: ${held.text}` })
      }
      // The fresh conversation carries none of the earlier reads, so the fresh
      // generation gets a fresh observation phase with the new-goal bootstrap
      // minimum; inheriting a closed phase left it unable to re-observe anything.
      this.resetObservationDecisionState()
      if (Number.isSafeInteger(this.observationBudgetOverride)) {
        this.observationBudgetRemaining = Math.max(3, this.observationBudgetOverride)
      }
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
      // C6: ordinary bounded recovery keeps the committed semantic step, so it gets a
      // FRESH executor conversation from a C6 packet (no user interruption, the plan and
      // its tracker untouched). Only an active committed plan is executed; a recovery that
      // is still authoring a first plan stays on the conversation that is authoring it. A
      // refused restage keeps the conversation as it was (traced). An approved Revise (a
      // user-approved plan revision wakes the planner for a new draft) is the C2-shaped
      // restage and is not wired here.
      await this.startExecutorForRecovery({ route: routed.route, reason: reasonText, runtime: routed.runtime ?? routed.persistentRuntime })
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
