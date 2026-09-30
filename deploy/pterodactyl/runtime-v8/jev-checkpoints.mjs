// Jev at the delegation checkpoints (delegation unit U11, design note section 7 and 12f).
//
// Four judgment families, all routed through one ledger (jev-judgments.mjs) that scores each judgment against
// its OUTCOME and promotes or demotes the family from the evidence (shadow -> advisory -> deciding; no setting):
//
//   c4_next_step          step close inside a slice: is the next committed step clear, so the executor may go
//                         straight on with no targeted-observation wake? Acts on its own only when deciding.
//   observation_families  at each restage: which observation families the fresh conversation will need.
//                         Advisory only ADDS bounded facts to the packet; mandatory fields never move.
//   shelf_ranking         the complete shelf-candidate set at a shelf pickup. Advisory only ORDERS the packet's
//                         candidates; the planner still chooses.
//   skill_order           skill card order (stays in shadow; scored for the evidence).
//
// Authority (AGENTS.md): Jev selects, ranks, classifies and routes. It never authors a plan, mutates a committed
// plan, advances the Plan Tracker or declares completion. The completion gate still owns every step close.
// The deterministic checks below can only make a route MORE cautious than Jev; fact reads stay ungated.
// A Jev call that fails, times out or is invalid records nothing as agreement and leaves behavior exactly as it was.

import { cleanMemoryText, sanitizeDurableModelText, sanitizeDurableModelValue } from './durable-text.mjs'
import { observationRelevanceQuestions, parseObservationRelevance } from './jev-decision-taxonomy.mjs'
import { JEV_MEASUREMENT, jevMeasurement } from './jev-health.mjs'
import {
  abandonJudgment,
  effectiveStage,
  emptyLedger,
  pendingJudgment,
  recordJudgment,
  scoreC4Judgment,
  scoreJudgment,
  scoreObservationFamilies,
  scoreShelfRanking,
  scoreSkillOrder,
  summarizeFamily,
  summarizeLedger,
  tokenBaseline,
} from './jev-judgments.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { observationToolFamily, toolCommand } from './structured-policy.mjs'

// Restage checkpoints the observation-family judgment covers (owner: C3/C4/C6/C8 and the planner C1/C2).
export const OBSERVATION_RESTAGE_CHECKPOINTS = Object.freeze(['C1', 'C2', 'C3', 'C4', 'C6', 'C8'])

// A deciding C4 route acts only on a confident direct answer; anything less keeps today's route.
export const C4_MIN_CONFIDENCE = 0.6

// Families whose deterministic fact is a parameterless harness read (fact tier, ungated). Jev picking any other
// family adds a one-line hint, never a fact.
export const PACKET_FACT_READERS = Object.freeze({
  inventory_equipment: 'getInventoryItems',
  research_state: 'getResearchStatus',
  runtime_status: 'getTaskStatus',
})
export const PACKET_FACT_CHARS = 300
export const PACKET_FACT_MAX_FAMILIES = 4

const SHELF_RANKING_LIMIT = 32
const TRACKER_LIMIT = 64

function clean(value, max) {
  return sanitizeDurableModelText(value, max)
}

function finiteTokens(usage) {
  const input = Number.isFinite(usage?.input_units) ? Math.max(0, usage.input_units) : 0
  const output = Number.isFinite(usage?.output_units) ? Math.max(0, usage.output_units) : 0
  return input + output
}

// --- deterministic clearness of the next committed step ------------------------------------------------------

function requirementSubject(requirement) {
  return requirement.item_name ?? requirement.entity_name ?? requirement.operation_name ?? requirement.controller ?? ''
}

// The contract described without any entity identity (a historical unit number must never steer a model).
export function contractSummary(contract, max = 300) {
  if (!contract || !Array.isArray(contract.requirements) || contract.requirements.length === 0) return ''
  const parts = contract.requirements.map((requirement) => {
    const subject = requirementSubject(requirement)
    const minimum = Number.isFinite(requirement.minimum) ? `>=${requirement.minimum}` : ''
    return `${requirement.kind}${subject ? ` ${subject}` : ''}${minimum}`
  })
  return cleanMemoryText(`${contract.mode}: ${parts.join('; ')}`, max)
}

function contractIsSpecified(contract) {
  return Boolean(contract)
    && contract.mode !== 'semantic_unknown'
    && Array.isArray(contract.requirements)
    && contract.requirements.length > 0
}

function unitNumbersOf(contract) {
  return (Array.isArray(contract?.requirements) ? contract.requirements : [])
    .map(requirement => requirement.unit_number)
    .filter(Number.isSafeInteger)
}

/**
 * Is the next committed step clear? Pure. All of these must hold, otherwise the route stays exactly as it is:
 *  - an ordinary completion boundary inside a slice: a committed plan, the step before it just closed, the next
 *    step pending (a slice close is the planner's boundary, never this one);
 *  - the next step's completion contract is fully specified (mode all/any with at least one requirement);
 *  - the facts it names are already held: the closing batch receipt is present, and every entity the contract
 *    names appears in the plan's receipts;
 *  - no blocker (the plan is not BLOCKED, the goal is active, the board carries no blocker or pause);
 *  - no pending user amendment.
 */
export function nextStepClarity({ planningState, board, pendingAmendment = false, receipt, boundary = 'completion' } = {}) {
  const failed = []
  const plan = planningState ? getActivePlan(planningState) : undefined
  if (boundary !== 'completion') failed.push('not_a_completion_boundary')
  if (pendingAmendment) failed.push('pending_amendment')
  if (planningState?.goal?.status !== 'active') failed.push('goal_not_active')
  if (!plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) failed.push('no_committed_plan')
  if (board?.blocker || board?.pause_reason) failed.push('blocker_or_pause_on_board')
  const index = Number.isInteger(plan?.active_step_index) ? plan.active_step_index : -1
  const step = plan && index >= 0 ? plan.steps?.[index] : undefined
  const progress = plan?.execution?.step_progress ?? {}
  if (plan && !step) failed.push('no_next_step')
  else if (step && progress[step.step_id]?.status === 'completed') failed.push('next_step_already_closed')
  const previous = plan && index > 0 ? plan.steps[index - 1] : undefined
  if (step && progress[previous?.step_id]?.status !== 'completed') failed.push('no_step_closed_just_before')
  const contract = step?.completion_contract
  const specified = contractIsSpecified(contract)
  if (step && !specified) failed.push('contract_not_fully_specified')
  const batchId = receipt?.view?.last_completed_batch?.batch_id ?? receipt?.providerStatus?.last_completed_batch?.batch_id
  const receiptPresent = Number.isSafeInteger(batchId)
  if (step && !receiptPresent) failed.push('no_completion_receipt')
  const units = unitNumbersOf(contract)
  let unitsKnown = true
  if (units.length > 0) {
    const ledgerText = JSON.stringify(plan?.execution?.receipts ?? {})
    unitsKnown = units.every(unit => new RegExp(`\\b${unit}\\b`).test(ledgerText))
    if (!unitsKnown) failed.push('named_entity_not_in_receipts')
  }
  return {
    clear: failed.length === 0,
    failed_checks: failed,
    evidence: {
      contract_specified: specified,
      facts_in_receipts: receiptPresent && unitsKnown,
      no_blocker: !failed.includes('blocker_or_pause_on_board') && plan?.status !== PLAN_STATUS.BLOCKED && planningState?.goal?.status === 'active',
      no_pending_amendment: !pendingAmendment,
      entities_named: units.length,
    },
    plan_id: plan?.plan_id,
    closed_step_id: previous?.step_id,
    next_step: step
      ? {
          step_id: step.step_id,
          index,
          description: clean(step.description, 300),
          contract: contractSummary(contract),
          requirement_kinds: [...new Set((contract?.requirements ?? []).map(requirement => requirement.kind))],
        }
      : undefined,
    closed_count: plan ? plan.steps.filter(item => progress[item.step_id]?.status === 'completed').length : 0,
    total_steps: plan?.steps?.length ?? 0,
  }
}

// --- Jev questions and answer parsers -------------------------------------------------------------------------

export function c4Questions() {
  return {
    next_step_route: {
      type: 'choice',
      instructions: {
        task: 'A verified step just closed inside a committed plan slice. Decide whether the executor can act on the NEXT committed step directly, or must ground itself with fresh read-only observations first.',
        rules: [
          'Routing only: never invent world facts, never change or replace the committed step, never judge completion.',
          'The harness_checks already hold (the step contract is fully specified, the facts it names are in the receipts, no blocker, no pending amendment); you may only be MORE cautious than them.',
          'Choose ground_first when the step depends on where things are, what is nearby, or what the last batch left in the world and the receipts do not say.',
        ],
      },
      criteria: {
        direct_to_executor: 'The next committed step is clear from its contract and the receipts: the executor can submit its operations now without extra observation rounds.',
        ground_first: 'The executor needs fresh observations before it can act on the next step safely.',
      },
    },
  }
}

export function parseC4Choice(response) {
  const answer = response?.answers?.next_step_route
  if (!answer || !['direct_to_executor', 'ground_first'].includes(answer.choice)) return undefined
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    ? Math.max(0, Math.min(1, answer.confidence))
    : 0
  return {
    choice: answer.choice,
    confidence,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : undefined,
  }
}

function shelfCriterion(candidate) {
  const parts = [`${clean(candidate.intent, 200)}`]
  if (candidate.why_it_matters) parts.push(`why: ${clean(candidate.why_it_matters, 120)}`)
  parts.push(`status: ${candidate.status}`)
  if (Array.isArray(candidate.depends_on) && candidate.depends_on.length > 0) parts.push(`depends_on: ${candidate.depends_on.slice(0, 6).join(',')}`)
  if (Array.isArray(candidate.verified_results) && candidate.verified_results.length > 0) parts.push(`verified: ${candidate.verified_results.slice(0, 3).map(item => clean(item, 60)).join(', ')}`)
  return `${candidate.node_id}: ${parts.join(' | ')}`
}

// Criteria keys are positional (c1..cN): model-authored node ids never become a wire identifier.
export function shelfRankingQuestions(candidates) {
  const criteria = {}
  candidates.forEach((candidate, index) => { criteria[`c${index + 1}`] = shelfCriterion(candidate) })
  return {
    shelf_ranking: {
      type: 'choice',
      instructions: 'Which Roadmap Shelf node is the most useful to refine into the next plan slice, given the goal and what is already verified? Judge usefulness to the goal only; this ranks candidates and never authors steps.',
      criteria,
    },
  }
}

// Jev's ranking over the candidates, highest probability first, the chosen one first.
export function parseShelfRanking(response, candidates) {
  const answer = response?.answers?.shelf_ranking
  if (!answer || typeof answer.choice !== 'string') return undefined
  const keys = candidates.map((_, index) => `c${index + 1}`)
  if (!keys.includes(answer.choice)) return undefined
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  const order = [...keys].sort((left, right) => (Number(probabilities[right]) || 0) - (Number(probabilities[left]) || 0)
    || keys.indexOf(left) - keys.indexOf(right))
  order.splice(order.indexOf(answer.choice), 1)
  order.unshift(answer.choice)
  const confidence = Number.isFinite(answer.confidence) ? Math.min(1, Math.max(0, answer.confidence)) : 0
  return { ordered: order.map(key => candidates[keys.indexOf(key)]), confidence }
}

/** Reorder `candidates` by the ranked list; any candidate the ranking lacks keeps its place after the ranked ones. Never drops one. */
export function applyShelfRanking(candidates, ranked) {
  const order = new Map(ranked.map((candidate, index) => [candidate.node_id, index]))
  return [...candidates].sort((left, right) => (order.get(left.node_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.node_id) ?? Number.MAX_SAFE_INTEGER))
}

function observationState({ checkpoint, role, planningState, reason }) {
  const plan = planningState ? getActivePlan(planningState) : undefined
  const progress = plan?.execution?.step_progress ?? {}
  const index = Number.isInteger(plan?.active_step_index) ? plan.active_step_index : -1
  const step = plan && index >= 0 ? plan.steps?.[index] : undefined
  return {
    contract: 'restage_observation_families',
    checkpoint,
    role,
    reason: clean(reason, 160),
    goal: planningState?.goal
      ? { goal_id: clean(planningState.goal.goal_id, 100), objective: clean(planningState.goal.objective, 300) }
      : null,
    plan: plan ? { plan_id: plan.plan_id, status: plan.status, step_count: plan.steps.length } : null,
    active_step: step
      ? { index, description: clean(step.description, 300), contract: contractSummary(step.completion_contract) }
      : null,
    // The fresh conversation has read nothing yet.
    known_observations: [],
    plan_steps: (plan?.steps ?? []).slice(0, 16).map(item => ({ description: clean(item.description, 200), status: progress[item.step_id]?.status ?? 'pending' })),
    active_step_has_completion_evidence: Boolean(step && (progress[step.step_id]?.accepted_evidence ?? []).length > 0),
  }
}

// --- the runtime controller -----------------------------------------------------------------------------------

export class JevCheckpoints {
  constructor(loop, { enabled = true } = {}) {
    this.loop = loop
    this.enabled = enabled !== false
    this.trackers = new Map() // judgment_id -> what the running process still waits for (never persisted)
    this.aborts = new Set()
    // Judgment ids stay unique across restarts (the ledger's counter persists, but a restart can lose the last
    // increments): a per-process salt keeps every id in a trace distinct.
    this.salt = Date.now().toString(36).slice(-5)
  }

  get ledger() {
    const memory = this.loop.memory
    if (!memory.jevLedger) memory.jevLedger = emptyLedger()
    return memory.jevLedger
  }

  set ledger(value) {
    this.loop.memory.jevLedger = value
  }

  stage(family) {
    return effectiveStage(this.ledger, family)
  }

  summary() {
    return summarizeLedger(this.ledger)
  }

  available() {
    return this.enabled && typeof this.loop.interactionDecisionProvider === 'function'
  }

  healthDegraded() {
    return jevMeasurement(this.loop.jevHealth, { configured: true }) === JEV_MEASUREMENT.DEGRADED
  }

  abortAll(reason = 'cancelled') {
    for (const controller of this.aborts) controller.abort(new Error(`jev checkpoint call cancelled: ${reason}`))
    this.aborts.clear()
  }

  async emit(rows) {
    for (const [event, data, requestId] of rows) {
      try {
        await this.loop.traceEvent(event, data, { requestId })
      }
      catch {}
    }
  }

  persist() {
    try {
      void this.loop.persistState()
    }
    catch {}
  }

  // One bounded Jev call through the loop's recorded decision provider. Resolves to { ok, response } and never
  // rejects: a failure is traced as a decision fallback and records NO judgment. Shadow calls stay out of the
  // per-request Jev health window (a shadow judgment steers nothing), exactly like the skill_choice shadow.
  async ask({ contract, state, questions, stage }) {
    const loop = this.loop
    const shadow = stage === 'shadow'
    const generation = loop.generation
    const controller = new AbortController()
    this.aborts.add(controller)
    const decisionId = `decision_${Date.now().toString(36)}_u11_${(++loop.decisionRequestSequence).toString(36)}`
    const startedAt = Date.now()
    try {
      await loop.decisionTraceEvent('decision.request', { decision_id: decisionId, contract, mode: stage, shadow, question_ids: Object.keys(questions) })
      const response = await loop.interactionDecisionProvider(state, questions, {
        epoch: loop.epoch?.epoch,
        actorId: loop.epoch?.actor_id,
        signal: controller.signal,
        decisionId,
      })
      if (controller.signal.aborted || generation !== loop.generation || !loop.active) throw new Error('Model turn was cancelled or superseded')
      const latency = Date.now() - startedAt
      await loop.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract,
        mode: stage,
        shadow,
        provider: typeof response?.provider === 'string' ? response.provider : undefined,
        model: typeof response?.model === 'string' ? response.model : undefined,
        latency_ms: latency,
        input_units: Number.isFinite(response?.usage?.input_tokens) ? Math.max(0, Math.trunc(response.usage.input_tokens)) : 0,
        output_units: Number.isFinite(response?.usage?.output_tokens) ? Math.max(0, Math.trunc(response.usage.output_tokens)) : 0,
      })
      return { ok: true, response, latency_ms: latency }
    }
    catch (error) {
      const reason = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
      try {
        await loop.decisionTraceEvent('decision.fallback', {
          decision_id: decisionId,
          contract,
          mode: stage,
          shadow,
          fallback_target: 'deterministic_no_judgment',
          reason,
          latency_ms: Date.now() - startedAt,
        })
      }
      catch {}
      return { ok: false, reason }
    }
    finally {
      this.aborts.delete(controller)
    }
  }

  async skipped(family, reason, extra = {}) {
    await this.loop.traceEvent('jev.judgment_skipped', {
      request_id: this.loop.traceRequest?.id,
      family,
      reason,
      stage: this.stage(family),
      recorded_as_agreement: false,
      ...extra,
    })
  }

  // Whether a judgment may be asked for at all right now. A run with no decision provider (Jev is not configured)
  // writes nothing: it is exactly today's run. A configured Jev whose health is degraded records why it was skipped.
  async mayJudge(family) {
    if (!this.available()) return false
    if (this.healthDegraded()) {
      await this.skipped(family, 'jev_health_degraded')
      return false
    }
    return true
  }

  async record(input) {
    const result = recordJudgment(this.ledger, input, { salt: this.salt })
    if (!result) return undefined
    this.ledger = result.ledger
    const judgment = result.judgment
    await this.loop.traceEvent('jev.judgment_recorded', {
      request_id: judgment.request_id,
      judgment_id: judgment.judgment_id,
      family: judgment.family,
      stage: judgment.stage,
      acted: judgment.acted,
      shadow: judgment.stage === 'shadow',
      reason: input.reason,
      jev_choice: judgment.jev_choice,
      jev_confidence: judgment.jev_confidence,
      alternative: judgment.alternative,
      goal_id: judgment.goal_id,
      plan_id: judgment.plan_id,
      step_id: judgment.step_id,
      handoff_id: judgment.handoff_id,
      checkpoint: judgment.checkpoint,
      detail: judgment.detail,
      saving_estimate: judgment.saving_estimate,
    }, { requestId: judgment.request_id })
    return judgment
  }

  planIds(planningState) {
    const plan = planningState ? getActivePlan(planningState) : undefined
    const step = plan && Number.isInteger(plan.active_step_index) ? plan.steps?.[plan.active_step_index] : undefined
    return { goal_id: planningState?.goal?.goal_id, plan_id: plan?.plan_id, step_id: step?.step_id }
  }

  // Scores a pending judgment and returns the trace rows to write: [event, data, requestId].
  scoreNow(judgmentId, result, extra = {}) {
    const pending = pendingJudgment(this.ledger, judgmentId)
    if (!pending) return []
    const scored = scoreJudgment(this.ledger, judgmentId, result)
    if (!scored) return []
    this.ledger = scored.ledger
    this.trackers.delete(judgmentId)
    const family = summarizeFamily(this.ledger, pending.family)
    const rows = [[
      'jev.judgment_scored',
      {
        request_id: pending.request_id,
        judgment_id: judgmentId,
        family: pending.family,
        agreed: result.agreed === true,
        acted: pending.acted,
        reason: result.reason ?? (result.agreed === true ? 'outcome_matches_the_judgment' : 'outcome_differs_from_the_judgment'),
        stage: family.stage,
        earned_stage: family.earned_stage,
        recorded_stage: pending.stage,
        scored_total: family.scored,
        rolling_agreement: family.agreement,
        outcome: result.outcome,
        saving: result.agreed === true ? result.saving : undefined,
        realized: pending.acted === true,
        ledger: {
          scored: family.scored,
          agreement: family.agreement,
          stage: family.stage,
          would_save: family.would_save,
          saved: family.saved,
          removal_candidate: family.removal_candidate,
        },
        ...extra,
      },
      pending.request_id,
    ]]
    for (const transition of scored.transitions) {
      rows.push([
        'jev.stage_changed',
        {
          request_id: pending.request_id,
          judgment_id: judgmentId,
          ...transition,
          reason: transition.reason,
        },
        pending.request_id,
      ])
    }
    this.persist()
    return rows
  }

  abandonNow(judgmentId, reason) {
    const pending = pendingJudgment(this.ledger, judgmentId)
    const abandoned = abandonJudgment(this.ledger, judgmentId)
    this.trackers.delete(judgmentId)
    if (!abandoned) return []
    this.ledger = abandoned.ledger
    this.persist()
    return [['jev.judgment_unscored', { request_id: pending.request_id, judgment_id: judgmentId, family: pending.family, reason, recorded_as_agreement: false }, pending.request_id]]
  }

  async discard(judgmentId, reason) {
    await this.emit(this.abandonNow(judgmentId, reason))
  }

  track(tracker) {
    this.trackers.set(tracker.judgment_id, tracker)
    while (this.trackers.size > TRACKER_LIMIT) {
      const oldest = this.trackers.keys().next().value
      this.trackers.delete(oldest)
    }
  }

  // --- C4: the next committed step is clear -------------------------------------------------------------

  // Called at an ordinary completion boundary, after the completion gate and before the post-step gate. Returns
  // undefined (route unchanged) or { judgment_id, acted, direct, stage }. `acted` is true only when the family
  // has earned `deciding` AND Jev confidently chose direct_to_executor: the caller then skips the post-step gate,
  // the planner-shape call and the observation budget. It never closes a step: the gate already did.
  async c4Boundary({ stepCompletion, receipt, pendingAmendment = false }) {
    if (!this.available() || pendingAmendment || stepCompletion?.verified !== true) return undefined
    const loop = this.loop
    const requestId = loop.traceRequest?.id
    const planning = loop.memory.planningState?.(loop.activePlanKey())
    const clarity = nextStepClarity({
      planningState: planning,
      board: stepCompletion.state?.task_board,
      pendingAmendment,
      receipt,
      boundary: 'completion',
    })
    await loop.traceEvent('c4.next_step_clear', {
      request_id: requestId,
      clear: clarity.clear,
      reason: clarity.clear ? 'all_deterministic_checks_hold' : `not_clear: ${clarity.failed_checks.join(', ')}`,
      failed_checks: clarity.failed_checks,
      evidence: clarity.evidence,
      plan_id: clarity.plan_id,
      step_id: clarity.next_step?.step_id,
      stage: this.stage('c4_next_step'),
    }, { requestId })
    if (!clarity.clear) return undefined
    if (!await this.mayJudge('c4_next_step')) return undefined

    const stage = this.stage('c4_next_step')
    const plan = getActivePlan(planning)
    const closedReceipts = (plan?.execution?.receipts?.[clarity.closed_step_id] ?? []).slice(-3)
    const state = {
      contract: 'c4_next_step_route',
      phase: 'step_close',
      goal: { goal_id: clean(planning.goal.goal_id, 100), objective: clean(planning.goal.objective, 300) },
      progress: { closed: clarity.closed_count, total: clarity.total_steps },
      next_step: clarity.next_step,
      harness_checks: clarity.evidence,
      receipt_tail: closedReceipts.map(entry => ({ kind: clean(entry.kind, 60), summary: clean(entry.summary, 160) })),
      last_batch: {
        batch_id: receipt?.view?.last_completed_batch?.batch_id,
        task_types: Array.isArray(receipt?.view?.last_completed_batch?.task_types) ? receipt.view.last_completed_batch.task_types.slice(0, 6) : undefined,
      },
    }
    const asked = await this.ask({ contract: 'c4_next_step_route', state: sanitizeDurableModelValue(state), questions: c4Questions(), stage })
    if (!asked.ok) {
      await this.skipped('c4_next_step', 'jev_fallback', { error: asked.reason })
      return undefined
    }
    const parsed = parseC4Choice(asked.response)
    if (!parsed) {
      await this.skipped('c4_next_step', 'jev_answer_invalid')
      return undefined
    }
    const direct = parsed.choice === 'direct_to_executor'
    const acted = stage === 'deciding' && direct && parsed.confidence >= C4_MIN_CONFIDENCE
    const baseline = tokenBaseline(this.ledger, 'c4_next_step')
    const judgment = await this.record({
      family: 'c4_next_step',
      request_id: requestId,
      ...this.planIds(planning),
      step_id: clarity.next_step.step_id,
      checkpoint: 'C4',
      jev_choice: parsed.choice,
      jev_confidence: parsed.confidence,
      alternative: { kind: 'targeted_observation_wake', source: acted ? 'skipped_by_deciding_route' : 'post_step_gate_route_follows' },
      acted,
      reason: acted ? 'deciding_stage_direct_to_executor' : stage === 'shadow' ? 'shadow_no_behavior_change' : 'route_unchanged_low_confidence_or_ground_first',
      detail: { harness_checks: clarity.evidence, latency_ms: asked.latency_ms, closed_step_id: clarity.closed_step_id },
      saving_estimate: acted ? { wakes: baseline > 0 ? 1 : 0, tokens: baseline } : undefined,
    })
    if (!judgment) return undefined
    this.track({
      kind: 'c4',
      judgment_id: judgment.judgment_id,
      request_id: requestId,
      plan_id: clarity.plan_id,
      step_id: clarity.next_step.step_id,
      choice: parsed.choice,
      acted: judgment.acted,
      baseline_tokens: baseline,
      wake: undefined,
      had_failure: false,
      verified: undefined,
    })
    return { judgment_id: judgment.judgment_id, acted: judgment.acted, direct, stage, confidence: parsed.confidence }
  }

  noteGateRoute(judgmentId, route) {
    const tracker = this.trackers.get(judgmentId)
    if (tracker) tracker.gate_route = route
  }

  beginWake(c4) {
    const tracker = c4 ? this.trackers.get(c4.judgment_id) : undefined
    if (!tracker) return
    tracker.wake = { open: true, rounds: [], fresh: 0, families: new Set() }
  }

  async endWake(c4, { error = false } = {}) {
    const tracker = c4 ? this.trackers.get(c4.judgment_id) : undefined
    if (!tracker?.wake) return
    const wake = tracker.wake
    wake.open = false
    const observationTokens = wake.rounds.filter(round => round.tools).reduce((total, round) => total + round.tokens, 0)
    const wakeTokens = wake.rounds.reduce((total, round) => total + round.tokens, 0)
    tracker.measured = {
      fresh_lookups: wake.fresh,
      lookup_families: [...wake.families],
      rounds: wake.rounds.length,
      wake_tokens: wakeTokens,
      observation_round_tokens: observationTokens,
    }
    await this.loop.traceEvent('c4.wake_measured', {
      request_id: tracker.request_id,
      judgment_id: tracker.judgment_id,
      mode: tracker.acted ? 'deciding' : 'shadow',
      reason: tracker.acted ? 'executor_continued_directly' : 'the_wake_that_ran_under_the_current_gate_route',
      gate_route: tracker.gate_route,
      ...tracker.measured,
      estimated_saving_tokens: tracker.acted ? Math.max(0, tracker.baseline_tokens - observationTokens) : observationTokens,
      failed: error,
    }, { requestId: tracker.request_id })
    if (error) {
      await this.emit(this.abandonNow(tracker.judgment_id, 'wake_failed'))
      return
    }
    await this.emit(this.tryScoreC4(tracker))
  }

  // Scoring waits for both halves of the outcome: the wake measurement and whether the step verified.
  tryScoreC4(tracker) {
    if (!tracker.measured || tracker.verified === undefined) return []
    const measured = tracker.measured
    const result = scoreC4Judgment({
      choice: tracker.choice,
      fresh_lookups: measured.fresh_lookups,
      verified: tracker.verified,
      first_try: !tracker.had_failure,
    })
    if (!result) return this.abandonNow(tracker.judgment_id, 'outcome_not_scoreable')
    // Saving counts only when Jev said direct and it held. A judgment that did not act saved nothing real: its
    // figure is what skipping the observation rounds WOULD have saved (an upper bound, the wake did run them).
    const saving = tracker.choice === 'direct_to_executor'
      ? (tracker.acted
          ? { wakes: tracker.baseline_tokens > 0 ? 1 : 0, tokens: Math.max(0, tracker.baseline_tokens - measured.observation_round_tokens) }
          : { wakes: measured.observation_round_tokens > 0 ? 1 : 0, tokens: measured.observation_round_tokens })
      : undefined
    return this.scoreNow(tracker.judgment_id, {
      ...result,
      saving,
      token_sample: tracker.acted ? undefined : measured.observation_round_tokens,
      outcome: {
        step_verified: tracker.verified,
        verified_first_try: tracker.verified === true && !tracker.had_failure,
        had_failure_boundary: tracker.had_failure,
        gate_route: tracker.gate_route,
        ...measured,
      },
    })
  }

  noteFailureBoundary() {
    for (const tracker of this.trackers.values()) if (tracker.kind === 'c4') tracker.had_failure = true
  }

  // --- observation families at a restage ---------------------------------------------------------------

  // Before the packet is built. Asks Jev which observation families the fresh conversation will need and
  // records the judgment. In the advisory stage it also reads the deterministic facts of the families that have
  // a parameterless fact tool, for the packet to ADD (bounded; never removing or replacing a mandatory record).
  // Never throws; undefined when nothing was judged.
  async prepareRestage({ checkpoint, role, planningState, reason, requestId }) {
    try {
      if (!this.enabled || !OBSERVATION_RESTAGE_CHECKPOINTS.includes(checkpoint)) return undefined
      if (!await this.mayJudge('observation_families')) return undefined
      const stage = this.stage('observation_families')
      const asked = await this.ask({
        contract: 'restage_observation_families',
        state: observationState({ checkpoint, role, planningState, reason }),
        questions: observationRelevanceQuestions(),
        stage,
      })
      if (!asked.ok) {
        await this.skipped('observation_families', 'jev_fallback', { error: asked.reason, checkpoint })
        return undefined
      }
      const relevance = parseObservationRelevance(asked.response)
      if (relevance.source !== 'typed_relevance') {
        await this.skipped('observation_families', 'jev_answer_invalid', { checkpoint })
        return undefined
      }
      const selected = relevance.selected_families
      let facts = []
      let hints = []
      if (stage !== 'shadow' && selected.length > 0) {
        const added = await this.packetFacts(selected)
        facts = added.facts
        hints = added.hints
      }
      const judgment = await this.record({
        family: 'observation_families',
        request_id: requestId ?? this.loop.traceRequest?.id,
        ...this.planIds(planningState),
        checkpoint,
        jev_choice: selected,
        jev_confidence: selected.length > 0 ? Math.max(...selected.map(family => relevance.probabilities[family] ?? 0)) : undefined,
        alternative: { kind: 'deterministic_packet', added_facts: [] },
        acted: facts.length > 0 || hints.length > 0,
        reason: stage === 'shadow' ? 'shadow_no_packet_change' : facts.length + hints.length > 0 ? 'advisory_facts_added_to_packet' : 'advisory_nothing_to_add',
        detail: { probabilities: relevance.probabilities, threshold: relevance.threshold, latency_ms: asked.latency_ms, role },
      })
      if (!judgment) return undefined
      await this.loop.traceEvent('jev.observation_families_selected', {
        request_id: judgment.request_id,
        judgment_id: judgment.judgment_id,
        checkpoint,
        role,
        stage,
        selected_families: selected,
        facts_added: facts.map(fact => fact.family),
        hints_added: hints,
        reason: stage === 'shadow' ? 'shadow_compared_with_the_lookups_the_agent_then_makes' : 'advisory_only_adds_facts_to_the_packet',
      }, { requestId: judgment.request_id })
      return { judgment_id: judgment.judgment_id, selected, stage, facts, hints }
    }
    catch (error) {
      try {
        await this.skipped('observation_families', 'prepare_failed', { error: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) })
      }
      catch {}
      return undefined
    }
  }

  async packetFacts(selected) {
    const facts = []
    const hints = []
    for (const family of selected.slice(0, PACKET_FACT_MAX_FAMILIES)) {
      const tool = PACKET_FACT_READERS[family]
      if (!tool) {
        hints.push(family)
        continue
      }
      try {
        const raw = String(await this.loop.rcon.command(toolCommand(tool, {}))).trim().slice(0, 16000)
        let parsed
        try { parsed = JSON.parse(raw) }
        catch { parsed = undefined }
        if (parsed === undefined || (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0)) continue
        const text = cleanMemoryText(JSON.stringify(sanitizeDurableModelValue(parsed)), PACKET_FACT_CHARS)
        if (text) facts.push({ family, text })
      }
      catch {}
    }
    return { facts, hints }
  }

  // After the restage attempt: a refused restage abandons the judgment; a landed one opens the window in which
  // the fresh agent's lookups are collected (closed by its first admitted operation).
  async afterRestage(prepared, result) {
    if (!prepared?.judgment_id) return
    if (result?.restaged !== true) {
      await this.emit(this.abandonNow(prepared.judgment_id, `restage_not_applied: ${result?.reason ?? 'unknown'}`))
      return
    }
    this.track({
      kind: 'observation',
      judgment_id: prepared.judgment_id,
      request_id: pendingJudgment(this.ledger, prepared.judgment_id)?.request_id,
      handoff_id: result.handoff_id,
      selected: prepared.selected,
      provided: prepared.facts.map(fact => fact.family),
      mode: prepared.facts.length > 0 ? 'recall_only' : 'two_sided',
      families: new Set(),
      fresh: 0,
    })
  }

  // --- shelf ranking at a shelf pickup ----------------------------------------------------------------

  // `candidates` is the complete ready set in the deterministic order. Returns { ordered, judgment_id, applied };
  // `ordered` equals `candidates` unless the family has earned advisory. Never drops or adds a candidate.
  async rankShelf({ route, planningState, candidates }) {
    const unchanged = { ordered: candidates, applied: false }
    try {
      if (!this.enabled || route !== 'next_shelf_slice' || !Array.isArray(candidates) || candidates.length < 2) return unchanged
      // A new pickup supersedes a ranking still waiting for its slice.
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind === 'shelf') await this.emit(this.abandonNow(tracker.judgment_id, 'superseded_by_a_newer_shelf_pickup'))
      }
      if (!await this.mayJudge('shelf_ranking')) return unchanged
      const stage = this.stage('shelf_ranking')
      const listed = candidates.slice(0, SHELF_RANKING_LIMIT)
      const state = {
        contract: 'shelf_ranking',
        phase: 'shelf_pickup',
        goal: planningState?.goal ? { goal_id: clean(planningState.goal.goal_id, 100), objective: clean(planningState.goal.objective, 300) } : null,
        candidate_count: listed.length,
      }
      const asked = await this.ask({ contract: 'shelf_ranking', state, questions: shelfRankingQuestions(listed), stage })
      if (!asked.ok) {
        await this.skipped('shelf_ranking', 'jev_fallback', { error: asked.reason })
        return unchanged
      }
      const parsed = parseShelfRanking(asked.response, listed)
      if (!parsed) {
        await this.skipped('shelf_ranking', 'jev_answer_invalid')
        return unchanged
      }
      const ranked = parsed.ordered.map(candidate => candidate.node_id)
      const applied = stage !== 'shadow'
      const judgment = await this.record({
        family: 'shelf_ranking',
        request_id: this.loop.traceRequest?.id,
        ...this.planIds(planningState),
        step_id: undefined,
        checkpoint: 'C2',
        jev_choice: ranked[0],
        jev_confidence: parsed.confidence,
        alternative: { kind: 'deterministic_order', first: listed[0].node_id },
        acted: applied,
        reason: applied ? 'advisory_orders_the_packet_candidates' : 'shadow_no_order_change',
        detail: { ranked: ranked.slice(0, SHELF_RANKING_LIMIT), candidate_count: listed.length, latency_ms: asked.latency_ms },
      })
      if (!judgment) return unchanged
      this.track({ kind: 'shelf', judgment_id: judgment.judgment_id, request_id: judgment.request_id, ranked, picked: undefined, awaiting_pick: true })
      if (applied) {
        await this.loop.traceEvent('jev.shelf_ranking_applied', {
          request_id: judgment.request_id,
          judgment_id: judgment.judgment_id,
          stage,
          ranked_first: ranked[0],
          deterministic_first: listed[0].node_id,
          reason: 'advisory_orders_candidates_only_the_planner_still_chooses',
        }, { requestId: judgment.request_id })
        return { ordered: applyShelfRanking(candidates, parsed.ordered), judgment_id: judgment.judgment_id, applied: true }
      }
      return { ordered: candidates, judgment_id: judgment.judgment_id, applied: false }
    }
    catch (error) {
      try {
        await this.skipped('shelf_ranking', 'rank_failed', { error: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) })
      }
      catch {}
      return unchanged
    }
  }

  // A plan slice verified complete: a ranking whose picked node this plan refined is scored now.
  async onSliceClosed({ plan }) {
    if (!this.enabled || !plan || plan.status !== PLAN_STATUS.COMPLETED) return
    const nodeIds = Array.isArray(plan.roadmap_node_ids) ? plan.roadmap_node_ids : []
    const rows = []
    for (const tracker of [...this.trackers.values()]) {
      if (tracker.kind !== 'shelf' || !tracker.picked || !nodeIds.includes(tracker.picked)) continue
      const result = scoreShelfRanking({ ranked: tracker.ranked, picked: tracker.picked, verified: true })
      if (!result) continue
      rows.push(...this.scoreNow(tracker.judgment_id, {
        ...result,
        outcome: { picked: tracker.picked, ranked_first: tracker.ranked[0], picked_rank: result.picked_rank, slice_verified: true, plan_id: plan.plan_id },
      }))
    }
    await this.emit(rows)
  }

  // --- skill card order (shadow) -----------------------------------------------------------------------

  async recordSkillOrder({ offer, choice, deterministicOrder, latencyMs }) {
    try {
      if (!this.enabled) return
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind === 'skill' && tracker.offer_seq !== offer.seq) await this.emit(this.abandonNow(tracker.judgment_id, 'superseded_by_a_newer_offer'))
      }
      const judgment = await this.record({
        family: 'skill_order',
        request_id: offer.request_id ?? this.loop.traceRequest?.id,
        checkpoint: offer.trigger === 'shelf_pickup' ? 'C2' : undefined,
        jev_choice: choice.pick,
        jev_confidence: choice.confidence,
        alternative: { kind: 'deterministic_order', top: deterministicOrder[0], order: deterministicOrder.slice(0, 5) },
        acted: false,
        reason: 'shadow_skill_order_never_reaches_the_prompt',
        detail: { jev_order: choice.order.slice(0, 5), offer_seq: offer.seq, trigger: offer.trigger, latency_ms: latencyMs },
      })
      if (!judgment) return
      this.track({ kind: 'skill', judgment_id: judgment.judgment_id, request_id: judgment.request_id, offer_seq: offer.seq, pick: choice.pick })
      // Jev answers in the background: when the plan was committed before its answer came, it is scored now
      // against what the agent had loaded at the commit.
      if (Array.isArray(offer.retired_loaded)) await this.scoreSkillOrderAtCommit({ offer, loaded: offer.retired_loaded })
    }
    catch {}
  }

  async scoreSkillOrderAtCommit({ offer, loaded }) {
    try {
      if (!this.enabled || !offer) return
      const rows = []
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind !== 'skill' || tracker.offer_seq !== offer.seq) continue
        const result = scoreSkillOrder({ pick: tracker.pick, loaded })
        rows.push(...this.scoreNow(tracker.judgment_id, { ...result, outcome: { jev_pick: tracker.pick, loaded_skills: loaded.slice(0, 5), deterministic_top: offer.cards?.[0]?.id } }))
      }
      await this.emit(rows)
    }
    catch {}
  }

  // --- what the running flows tell us ---------------------------------------------------------------------

  // Called for every fresh observation tool the agent ran (the loop's recordJevObservations).
  noteObservations(names) {
    if (this.trackers.size === 0) return
    for (const name of names) {
      const family = observationToolFamily(name)
      for (const tracker of this.trackers.values()) {
        if (tracker.kind === 'observation') {
          tracker.fresh++
          if (family) tracker.families.add(family)
        }
        else if (tracker.kind === 'c4' && tracker.wake?.open) {
          tracker.wake.fresh++
          if (family) tracker.wake.families.add(family)
        }
      }
    }
  }

  // Every behavior-trace row passes here. Returns extra rows to write after it. Synchronous and cheap when
  // nothing is waiting.
  observe(event, data, requestId) {
    if (!this.enabled || this.trackers.size === 0) return []
    if (event.startsWith('jev.') || event.startsWith('c4.')) return []
    const rows = []
    const planning = () => this.loop.memory.planningState?.(this.loop.activePlanKey())
    const stepClosed = (tracker) => {
      const plan = getActivePlan(planning())
      return plan?.plan_id === tracker.plan_id && plan.execution?.step_progress?.[tracker.step_id]?.status === 'completed'
    }
    const finishObservation = (tracker, abandon) => {
      if (abandon) { rows.push(...this.abandonNow(tracker.judgment_id, abandon)); return }
      const result = scoreObservationFamilies({ selected: tracker.selected, looked: [...tracker.families], provided: tracker.provided, mode: tracker.mode })
      rows.push(...this.scoreNow(tracker.judgment_id, {
        agreed: result.agreed,
        outcome: { selected_families: tracker.selected, looked_up_families: [...tracker.families], provided_families: tracker.provided, fresh_lookups: tracker.fresh, recall: result.recall, precision: result.precision, scoring: result.mode, handoff_id: tracker.handoff_id },
        // Calls the packet's deterministic facts replaced (advisory), or would have replaced (shadow: the
        // lookups the agent made of a family that has a parameterless fact read and that Jev predicted).
        saving: tracker.provided.length > 0
          ? { calls: tracker.provided.length }
          : { calls: [...tracker.families].filter(family => tracker.selected.includes(family) && Object.hasOwn(PACKET_FACT_READERS, family)).length },
      }))
    }

    if (event === 'provider.response') {
      const tokens = finiteTokens(data?.usage)
      for (const tracker of this.trackers.values()) {
        if (tracker.kind === 'c4' && tracker.wake?.open) tracker.wake.rounds.push({ tokens, tools: data?.has_tool_calls === true })
      }
      return rows
    }
    if (event === 'plan.accepted') {
      const ids = Array.isArray(data?.roadmap_node_ids) ? data.roadmap_node_ids : []
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind !== 'shelf' || !tracker.awaiting_pick) continue
        tracker.awaiting_pick = false
        if (ids.length > 0) tracker.picked = ids[0]
        else rows.push(...this.abandonNow(tracker.judgment_id, 'planner_named_no_shelf_node'))
      }
      return rows
    }
    if (event === 'operations.ack' || event === 'context.restaged') {
      for (const tracker of [...this.trackers.values()]) if (tracker.kind === 'observation') finishObservation(tracker)
      return rows
    }
    if (event === 'step.verified' || event === 'step.semantic_completed') {
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind !== 'c4' || tracker.verified !== undefined || !stepClosed(tracker)) continue
        tracker.verified = true
        rows.push(...this.tryScoreC4(tracker))
      }
      return rows
    }
    if (event === 'request.received' && data?.interaction_intent === 'new_goal') {
      for (const tracker of [...this.trackers.values()]) if (tracker.kind === 'shelf') rows.push(...this.abandonNow(tracker.judgment_id, 'new_goal'))
      return rows
    }
    if (['request.completed', 'request.failed', 'request.cancelled', 'request.superseded', 'goal.paused'].includes(event)) {
      const ended = event === 'request.completed' ? 'completed' : event === 'request.failed' || event === 'goal.paused' ? 'failed' : 'cancelled'
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind === 'observation') finishObservation(tracker, ended === 'completed' ? undefined : `request_${ended}`)
        else if (tracker.kind === 'c4') {
          // "The step failed to verify" is evidence only when the step itself failed (a failure boundary) and
          // the request then failed or paused; a provider error, a user cancel or a request that simply ended
          // is not evidence about Jev.
          if (tracker.verified === undefined && tracker.measured) {
            if (ended === 'completed' && stepClosed(tracker)) tracker.verified = true
            else if (ended === 'failed' && tracker.had_failure) tracker.verified = false
          }
          if (tracker.verified !== undefined && tracker.measured) rows.push(...this.tryScoreC4(tracker))
          else rows.push(...this.abandonNow(tracker.judgment_id, `request_${ended}_before_an_outcome`))
        }
      }
      return rows
    }
    return rows
  }
}
