import { authoredCompletionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'
import { sanitizeDurableModelText } from './durable-text.mjs'
import { goalUiView } from './goal-definition.mjs'
import { repairControlJson } from './control-json-repair.mjs'
import { getActivePlan } from './planning-state.mjs'
import { plannerControlToolDefinitions } from './structured-policy.mjs'

export function normalizeStepCompletions(descriptions, values) {
  if (!Array.isArray(values) || values.length !== descriptions.length) {
    throw new Error('stepCompletions must contain exactly one completion declaration per plan step')
  }
  return values.map((value, index) => {
    if (value?.kind === 'deterministic') {
      // No checkpoint at all declares a step whose contract is requested when the step is about to start. A checkpoint
      // that is present must still be supported: it is never silently downgraded to "pending".
      if (value.checkpoint === undefined) {
        if (Object.keys(value).some(key => !['kind', 'checkpoint'].includes(key))) throw new Error(`stepCompletions[${index}] has unexpected fields`)
        return { kind: 'deterministic' }
      }
      const checkpoint = sanitizeStepCompletionContract(value.checkpoint)
      if (!authoredCompletionContractSupported(checkpoint)) throw new Error(`stepCompletions[${index}] requires a supported checkpoint`)
      if (Object.keys(value).some(key => !['kind', 'checkpoint'].includes(key))) throw new Error(`stepCompletions[${index}] has unexpected fields`)
      return { kind: 'deterministic', checkpoint }
    }
    if (value?.kind === 'semantic' && typeof value.rationale === 'string' && value.rationale.trim()) {
      if (Object.keys(value).some(key => !['kind', 'rationale'].includes(key))) throw new Error(`stepCompletions[${index}] has unexpected fields`)
      return { kind: 'semantic', rationale: value.rationale.trim().slice(0, 600) }
    }
    throw new Error(`stepCompletions[${index}] must declare deterministic completion or a semantic assessment rationale`)
  })
}

export function completionContractSignature(contract) {
  const value = sanitizeStepCompletionContract(contract)
  return JSON.stringify({ mode: value.mode, requirements: value.requirements })
}

// --- The step contract call: the planner authors the completion checkpoint of ONE step when that step is about to start
// (docs/NPC_PLANNING_ROADMAP.md, "One-step contract prediction"). Pure module: a packet builder, the reply schema, and
// the parse/normalize half of the validation. The loop owns the provider call, staleness, accounting and binding.
//
// The planner prefix plus ONE user message `[STEP_CONTRACT_REQUEST] {packet}` is the whole exchange. The packet is
// facts only: the goal, the slice's step intents and statuses, what the harness already verified, the target step and
// the current facts. It carries no strategy and no advice. A later prediction call builds the same packet from facts
// already held, plus `assumed_outcome`, so the packet takes the facts as a parameter and never reads the game itself.

export const STEP_CONTRACT_MARKER = '[STEP_CONTRACT_REQUEST]'
export const STEP_CONTRACT_TRIGGER = 'step_contract'
// The reply is one small JSON object; the cap leaves room for the model's own reasoning before it.
export const STEP_CONTRACT_MAX_TOKENS = 6000
// The first ask plus one bounded correction.
export const STEP_CONTRACT_MAX_ATTEMPTS = 2

export const STEP_CONTRACT_LIMITS = Object.freeze({
  stepChars: 240,
  textChars: 300,
  doneWhen: 8,
  stepsInPacket: 30,
  verifiedSteps: 12,
  evidenceRefsPerStep: 3,
  receiptsPerStep: 2,
  summaryChars: 160,
})

const CHECKPOINT_SCHEMA = plannerControlToolDefinitions[0].function.parameters.properties.checkpoint

export const STEP_CONTRACT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['stepId', 'checkpoint'],
  properties: {
    stepId: { type: 'string', minLength: 1, maxLength: 200 },
    checkpoint: CHECKPOINT_SCHEMA,
  },
})

// A contract side call has no gameplay authority. The provider must deliver this
// schema directly: its ordinary closed-round submitPlan instructions describe a
// different reply and must never be appended to this exchange.
export const STEP_CONTRACT_OUTPUT_PROMPT = `[STEP_CONTRACT_OUTPUT] This is a completion-checkpoint authoring call for ONE target step, not a gameplay control turn. Return exactly one JSON object with only stepId and checkpoint. stepId must equal target.step_id in [STEP_CONTRACT_REQUEST]. Do not return a plan, operations, chatMessage, semanticCompletion or tool invocation. Use the supported requirement kinds and fields in the following canonical reply schema. entity_count names future placed prototypes; entity_exists and entity_state require a real observed unit_number and cannot use entity_name or minimum instead. The harness validates the checkpoint against current native facts; this call neither executes actions nor declares the step complete. Reply schema: ${JSON.stringify(STEP_CONTRACT_SCHEMA)}`

// Some CLI-proxy profiles require an explicit tool_choice:none with a schema to
// suppress implicit tools. Keep that wire guard, with only this non-executable
// declaration instead of the gameplay/observation tool catalog.
export const STEP_CONTRACT_TOOL_DEFINITIONS = Object.freeze([{
  type: 'function',
  function: {
    name: 'defineStepContract',
    description: 'Schema reference for the target-only checkpoint JSON response. Tool calls are disabled; return this object in assistant content.',
    parameters: STEP_CONTRACT_SCHEMA,
  },
}])

export function stepContractMessages(messages) {
  const result = messages.filter(message => !(message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[STEERING]')))
  let prefixEnd = 0
  while (result[prefixEnd]?.role === 'system') prefixEnd++
  result.splice(prefixEnd, 0, { role: 'system', content: STEP_CONTRACT_OUTPUT_PROMPT })
  return result
}

function clip(value, max) {
  return sanitizeDurableModelText(value, max)
}

function stepStatus(plan, step) {
  const status = plan.execution?.step_progress?.[step.step_id]?.status
  return status === 'completed' ? 'completed' : status === 'active' ? 'active' : 'pending'
}

/**
 * The facts-only packet for one step. `facts` is whatever the caller already holds or has just read (inventory counts,
 * observed entities, recipe facts); the builder passes them through bounded and never reads the game.
 * `assumedOutcome` is for a prediction call only (the contract of the active step the target is assumed to follow).
 */
export function buildStepContractPacket({ planningState, stepId, facts, assumedOutcome, limits: overrides } = {}) {
  const limits = { ...STEP_CONTRACT_LIMITS, ...overrides }
  const plan = getActivePlan(planningState)
  const target = plan?.steps?.find(step => step.step_id === stepId)
  if (!plan || !target) return undefined
  const targetIndex = plan.steps.indexOf(target)
  const goal = planningState?.goal
  const view = goalUiView(goal, undefined)
  const packet = {
    goal: {
      objective: clip(goal?.objective, limits.textChars),
      ...(view?.summary ? { summary: clip(view.summary, limits.textChars) } : {}),
    },
    done_when: (view?.checks ?? []).slice(0, limits.doneWhen).map(check => clip(check.text, limits.textChars)),
    slice: {
      plan_id: plan.plan_id,
      steps: plan.steps.slice(0, limits.stepsInPacket).map((step, index) => ({
        step_id: step.step_id,
        index,
        description: clip(step.description, limits.stepChars),
        status: stepStatus(plan, step),
        contract: step.contract_status === 'pending' ? 'pending' : step.completion_contract ? 'bound' : 'none',
      })),
    },
    verified_results: plan.steps
      .filter(step => stepStatus(plan, step) === 'completed')
      .slice(-limits.verifiedSteps)
      .map((step) => {
        const progress = plan.execution?.step_progress?.[step.step_id]
        const receipts = plan.execution?.receipts?.[step.step_id]
        return {
          step_id: step.step_id,
          description: clip(step.description, limits.stepChars),
          evidence_refs: (progress?.accepted_evidence ?? []).slice(-limits.evidenceRefsPerStep).map(item => clip(item.ref, 120)),
          receipts: (Array.isArray(receipts) ? receipts : []).slice(-limits.receiptsPerStep).map(entry => ({
            kind: clip(entry.kind, 64),
            summary: clip(entry.summary, limits.summaryChars),
          })),
        }
      }),
    target: {
      step_id: target.step_id,
      index: targetIndex,
      description: clip(target.description, limits.stepChars),
    },
    facts: facts && typeof facts === 'object' ? facts : {},
  }
  if (assumedOutcome !== undefined) packet.assumed_outcome = assumedOutcome
  return packet
}

export function stepContractUserMessage(packet) {
  return `${STEP_CONTRACT_MARKER} Author the completion checkpoint for the target step. Reply with ONE JSON object {"stepId":"<target step_id>","checkpoint":{"mode":"all"|"any","requirements":[...]}} and nothing else. ${JSON.stringify(packet)}`
}

export function stepContractCorrectionMessage(reason) {
  return `[HARNESS] ${clip(reason, 400)}; nothing was bound.`
}

// A fenced reply carries the object between the fences (the same rule the provider and the repair use).
function unfence(text) {
  if (text.startsWith('```') && text.endsWith('```') && text.length >= 6) {
    const inner = text.slice(3, -3).trim()
    return inner.slice(0, 4).toLowerCase() === 'json' ? inner.slice(4).trim() : inner
  }
  return text
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse and normalize one reply. Deterministic repair only (trailing commas, one-level JSON-encoded values), then the
 * same normalizer a draft's stepCompletions go through, so the checkpoint is a supported deterministic contract.
 * Grounding against the live game is the caller's job (it needs the game). Returns { ok, checkpoint, repairs } or
 * { ok: false, reason }.
 */
export function parseStepContractReply(content, { stepId } = {}) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'empty_reply' }
  const repaired = repairControlJson(content, STEP_CONTRACT_SCHEMA)
  let object = repaired?.object
  if (!object) {
    try { object = JSON.parse(unfence(content.trim())) }
    catch { return { ok: false, reason: 'reply_is_not_one_json_object' } }
  }
  if (!plainObject(object)) return { ok: false, reason: 'reply_is_not_one_json_object' }
  const extra = Object.keys(object).filter(key => !['stepId', 'checkpoint'].includes(key))
  if (extra.length > 0) return { ok: false, reason: `reply_has_unexpected_fields:${extra.slice(0, 4).join(',')}` }
  if (object.stepId !== stepId) return { ok: false, reason: 'reply_stepId_is_not_the_target_step' }
  if (!plainObject(object.checkpoint)) return { ok: false, reason: 'reply_has_no_checkpoint_object' }
  let declaration
  try {
    declaration = normalizeStepCompletions(['target'], [{ kind: 'deterministic', checkpoint: object.checkpoint }])[0]
  }
  catch (error) {
    return { ok: false, reason: `checkpoint_not_supported:${clip(error instanceof Error ? error.message : String(error), 160)}` }
  }
  if (declaration.kind !== 'deterministic' || !declaration.checkpoint) return { ok: false, reason: 'reply_is_not_a_deterministic_checkpoint' }
  return { ok: true, checkpoint: declaration.checkpoint, repairs: repaired?.repairs ?? [] }
}
