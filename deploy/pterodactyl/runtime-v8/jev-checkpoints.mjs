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
  markJudgmentActed,
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

// How long a stage that NEEDS Jev's answer (advisory facts in a packet, an advisory shelf order, a deciding route) waits
// for it. Shadow answers are never waited for. On a timeout the action simply does not happen.
export const ADVISORY_WAIT_MS = 1500

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
 *  - the runtime owns no work (no active condition wait, persistent controller or queued Autorio work);
 *  - no pending user amendment.
 */
export function nextStepClarity({ planningState, board, pendingAmendment = false, receipt, runtime, boundary = 'completion' } = {}) {
  const failed = []
  const plan = planningState ? getActivePlan(planningState) : undefined
  if (boundary !== 'completion') failed.push('not_a_completion_boundary')
  if (pendingAmendment) failed.push('pending_amendment')
  // The runtime already owns the work (a condition wait, a persistent controller, queued Autorio work): the post-step gate
  // routes that, never a judgment. The same inspection the gate makes (NpcAgentLoop.inspectAuthoritativeRuntime).
  if (runtime?.runtimeHealthy) failed.push('authoritative_runtime_active')
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
      no_runtime_work: !runtime?.runtimeHealthy,
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
//
// Timing rule (review of U11): a SHADOW judgment steers nothing, so it is never awaited on the critical path. Its
// Jev call is started without awaiting and its answer is bound to a tracker; when it arrives it is discarded (traced,
// never recorded) if the turn, the conversation or the step moved on. A stage that needs the answer (advisory facts
// in a packet, an advisory shelf order, a deciding route) asks AFTER the guard that could refuse the action, bounds
// the wait (ADVISORY_WAIT_MS), and the caller re-reads state and re-runs its guard after the await.

export class JevCheckpoints {
  constructor(loop, { enabled = true } = {}) {
    this.loop = loop
    this.enabled = enabled !== false
    this.trackers = new Map() // key -> what the running process still waits for (never persisted)
    this.aborts = new Set()
    this.inflight = new Set() // shadow calls started and not yet answered (idle() waits for them; tests only)
    this.waitMs = ADVISORY_WAIT_MS // the bound on a wait a stage needs (an instance field so a test can shorten it)
    this.trackerSeq = 0
    this.persistTimer = undefined
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

  // Resolves when every shadow call started so far has answered (or failed) and a scheduled persist has run.
  async idle() {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    await this.flushPersist()
  }

  async emit(rows) {
    for (const [event, data, requestId] of rows) {
      try {
        await this.loop.traceEvent(event, data, { requestId })
      }
      catch {}
    }
  }

  // The ledger changes inside trace writes (observe()), where the reducer may be mid-update. The snapshot is taken on
  // the next macrotask, once per burst, and a failed write is caught: nobody awaits it and it never delays a caller
  // that awaits persistState() itself.
  persist() {
    if (this.persistTimer) return
    this.persistTimer = setImmediate(() => {
      this.persistTimer = undefined
      this.writeNow()
    })
  }

  writeNow() {
    try {
      const written = this.loop.persistState()
      return written && typeof written.catch === 'function' ? written.catch(() => {}) : written
    }
    catch {
      return undefined
    }
  }

  async flushPersist() {
    if (this.persistTimer) {
      clearImmediate(this.persistTimer)
      this.persistTimer = undefined
      await this.writeNow()
    }
    await this.loop.persistQueue
  }

  // Starts a shadow action without awaiting it. Its failure is swallowed (a shadow judgment never breaks a run).
  fire(work) {
    const task = Promise.resolve().then(work).catch(() => {}).finally(() => { this.inflight.delete(task) })
    this.inflight.add(task)
    return task
  }

  // One bounded Jev call through the loop's recorded decision provider. Resolves to { ok, response } and never
  // rejects: a failure is traced as a decision fallback and records NO judgment. Shadow calls stay out of the
  // per-request Jev health window (a shadow judgment steers nothing), exactly like the skill_choice shadow.
  // `waitMs` bounds how long the caller waits for the answer (a stage that needs it); the call is aborted after it.
  async ask({ contract, state, questions, stage, waitMs }) {
    const loop = this.loop
    const shadow = stage === 'shadow'
    const generation = loop.generation
    const controller = new AbortController()
    this.aborts.add(controller)
    const decisionId = `decision_${Date.now().toString(36)}_u11_${(++loop.decisionRequestSequence).toString(36)}`
    const startedAt = Date.now()
    let timer
    try {
      await loop.decisionTraceEvent('decision.request', { decision_id: decisionId, contract, mode: stage, shadow, question_ids: Object.keys(questions) })
      const call = loop.interactionDecisionProvider(state, questions, {
        epoch: loop.epoch?.epoch,
        actorId: loop.epoch?.actor_id,
        signal: controller.signal,
        decisionId,
      })
      let response
      if (waitMs > 0) {
        call.catch?.(() => {})
        response = await Promise.race([
          call,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort(new Error(`wait exceeded ${waitMs} ms`))
              reject(new Error(`Decision provider timed out after ${waitMs} ms (bounded wait)`))
            }, waitMs)
          }),
        ])
      }
      else response = await call
      if (controller.signal.aborted || generation !== loop.generation || !loop.active) throw new Error('Model turn was cancelled or superseded')
      const latency = Date.now() - startedAt
      const usage = response?.usage
      await loop.decisionTraceEvent('decision.response', {
        decision_id: decisionId,
        contract,
        mode: stage,
        shadow,
        provider: typeof response?.provider === 'string' ? response.provider : undefined,
        model: typeof response?.model === 'string' ? response.model : undefined,
        latency_ms: latency,
        input_units: Number.isFinite(usage?.input_tokens) ? Math.max(0, Math.trunc(usage.input_tokens)) : 0,
        output_units: Number.isFinite(usage?.output_tokens) ? Math.max(0, Math.trunc(usage.output_tokens)) : 0,
        cost_usd: Number.isFinite(usage?.cost) && usage.cost >= 0 ? usage.cost : 0,
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
      if (timer) clearTimeout(timer)
      this.aborts.delete(controller)
    }
  }

  async skipped(family, reason, extra = {}) {
    await this.loop.traceEvent('jev.judgment_skipped', {
      request_id: extra.request_id ?? this.loop.traceRequest?.id,
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

  trackerOf(judgmentId) {
    for (const tracker of this.trackers.values()) if (tracker.judgment_id === judgmentId) return tracker
    return undefined
  }

  dropTracker(tracker) {
    if (tracker) this.trackers.delete(tracker.key)
  }

  // Scores a pending judgment and returns the trace rows to write: [event, data, requestId].
  scoreNow(judgmentId, result, extra = {}) {
    const pending = pendingJudgment(this.ledger, judgmentId)
    if (!pending) return []
    const scored = scoreJudgment(this.ledger, judgmentId, result)
    if (!scored) return []
    this.ledger = scored.ledger
    this.dropTracker(this.trackerOf(judgmentId))
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
    this.dropTracker(this.trackerOf(judgmentId))
    if (!abandoned) return []
    this.ledger = abandoned.ledger
    this.persist()
    return [['jev.judgment_unscored', { request_id: pending.request_id, judgment_id: judgmentId, family: pending.family, reason, recorded_as_agreement: false }, pending.request_id]]
  }

  async discard(judgmentId, reason) {
    await this.emit(this.abandonNow(judgmentId, reason))
  }

  async discardHandle(handle, reason) {
    const tracker = handle ? this.trackers.get(handle.key) : undefined
    if (!tracker) return
    if (tracker.judgment_id) await this.discard(tracker.judgment_id, reason)
    else this.dropUnanswered(tracker)
  }

  // Drops a tracker whose judgment was never recorded (its answer has not arrived): the answer, when it comes, is
  // discarded by the staleness check.
  dropUnanswered(tracker) {
    this.dropTracker(tracker)
  }

  track(tracker) {
    tracker.key = tracker.key ?? tracker.judgment_id ?? `slot_${++this.trackerSeq}`
    this.trackers.set(tracker.key, tracker)
    while (this.trackers.size > TRACKER_LIMIT) {
      const oldest = this.trackers.keys().next().value
      this.trackers.delete(oldest)
    }
    return tracker
  }

  // --- C4: the next committed step is clear -------------------------------------------------------------

  // Whether the plan still stands where a C4 judgment was asked: same plan, the judged step still the active one and
  // not closed, and the same conversation. Used when an answer arrives.
  c4StillApplies(tracker) {
    const loop = this.loop
    if (loop.traceRequest?.id !== tracker.request_id) return 'request_moved_on'
    if (loop.agentContext.conversationSeq !== tracker.conversation_seq) return 'conversation_moved_on'
    const plan = getActivePlan(loop.memory.planningState?.(loop.activePlanKey()))
    const step = plan && Number.isInteger(plan.active_step_index) ? plan.steps?.[plan.active_step_index] : undefined
    if (plan?.plan_id !== tracker.plan_id || step?.step_id !== tracker.step_id) return 'step_moved_on'
    if (plan.execution?.step_progress?.[step.step_id]?.status === 'completed') return 'step_moved_on'
    return undefined
  }

  // Called at an ordinary completion boundary, after the completion gate and before the post-step gate.
  //
  // The deterministic runtime checks come first and are the SAME ones the post-step gate makes
  // (NpcAgentLoop.inspectAuthoritativeRuntime: a condition wait, a persistent controller, queued Autorio work):
  // any of them active means the runtime owns the work, the step is not clear, no Jev call is made and the gate
  // routes exactly as it always does.
  //
  // Returns undefined (route unchanged) or a handle { key, acted, direct, stage, confidence }. In shadow the Jev call is
  // started without awaiting (the handle is returned at once, acted false). In deciding the answer is awaited for at
  // most `waitMs`; `acted` is true only for a confident direct_to_executor that still applies after the await (the
  // runtime checks and the amendment flag are read again). It never closes a step: the gate already did.
  async c4Boundary({ stepCompletion, receipt, pendingAmendment = false }) {
    if (!this.available() || pendingAmendment || stepCompletion?.verified !== true) return undefined
    const loop = this.loop
    const requestId = loop.traceRequest?.id
    const runtime = await loop.inspectAuthoritativeRuntime(receipt)
    const planning = loop.memory.planningState?.(loop.activePlanKey())
    const clarity = nextStepClarity({
      planningState: planning,
      board: stepCompletion.state?.task_board,
      pendingAmendment,
      receipt,
      runtime,
      boundary: 'completion',
    })
    await loop.traceEvent('c4.next_step_clear', {
      request_id: requestId,
      clear: clarity.clear,
      reason: clarity.clear ? 'all_deterministic_checks_hold' : `not_clear: ${clarity.failed_checks.join(', ')}`,
      failed_checks: clarity.failed_checks,
      evidence: clarity.evidence,
      ...(runtime?.runtimeHealthy ? { runtime_reason: runtime.runtimeReason } : {}),
      plan_id: clarity.plan_id,
      step_id: clarity.next_step?.step_id,
      stage: this.stage('c4_next_step'),
    }, { requestId })
    if (!clarity.clear) return undefined
    if (!await this.mayJudge('c4_next_step')) return undefined

    const stage = this.stage('c4_next_step')
    const plan = getActivePlan(planning)
    const closedReceipts = (plan?.execution?.receipts?.[clarity.closed_step_id] ?? []).slice(-3)
    const state = sanitizeDurableModelValue({
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
    })
    const tracker = this.track({
      kind: 'c4',
      judgment_id: undefined, // recorded when the answer arrives
      request_id: requestId,
      plan_id: clarity.plan_id,
      step_id: clarity.next_step.step_id,
      closed_step_id: clarity.closed_step_id,
      conversation_seq: loop.agentContext.conversationSeq,
      choice: undefined,
      acted: false,
      baseline_tokens: tokenBaseline(this.ledger, 'c4_next_step'),
      harness_checks: clarity.evidence,
      wake: undefined,
      had_failure: false,
      first_batch_unverified: false,
      verified: undefined,
    })
    const handle = { key: tracker.key, acted: false, direct: undefined, stage, confidence: undefined }

    if (stage !== 'deciding') {
      // Shadow (and advisory, which has no consumer for C4): never awaited on the critical path.
      this.fire(async () => {
        const asked = await this.ask({ contract: 'c4_next_step_route', state, questions: c4Questions(), stage })
        await this.answerC4(tracker, asked, { stage, receiptBatch: receipt?.view?.last_completed_batch?.batch_id })
      })
      return handle
    }

    const asked = await this.ask({ contract: 'c4_next_step_route', state, questions: c4Questions(), stage, waitMs: this.waitMs })
    // The wait is over: what may have changed while it ran is read again before the answer can act.
    const late = await this.c4LateChecks(tracker, receipt)
    const answered = await this.answerC4(tracker, asked, { stage, late })
    if (!answered) return undefined
    handle.acted = answered.acted
    handle.direct = answered.direct
    handle.confidence = answered.confidence
    handle.judgment_id = this.trackers.get(handle.key)?.judgment_id
    return handle
  }

  // The runtime, the amendment flag and the plan position read again after a Jev await (deciding only).
  async c4LateChecks(tracker, _receipt) {
    const loop = this.loop
    // A fresh read of the runtime (the receipt of the boundary is older than Jev's answer).
    const runtime = await loop.inspectAuthoritativeRuntime({ view: await loop.readInteractionTaskStatus() })
    if (runtime?.runtimeHealthy) return `authoritative_runtime_active:${runtime.runtimeReason}`
    if (loop.currentPendingAmendment?.()) return 'amendment_staged_during_the_jev_call'
    return this.c4StillApplies(tracker)
  }

  // Binds an answer to its tracker. Returns { acted, direct, confidence } or undefined (nothing recorded).
  async answerC4(tracker, asked, { stage, late }) {
    if (!this.trackers.has(tracker.key)) {
      await this.skipped('c4_next_step', 'answer_discarded_stale', { request_id: tracker.request_id, detail: 'the judgment was dropped before its answer arrived' })
      return undefined
    }
    if (!asked.ok) {
      this.dropUnanswered(tracker)
      await this.skipped('c4_next_step', 'jev_fallback', { request_id: tracker.request_id, error: asked.reason })
      return undefined
    }
    const parsed = parseC4Choice(asked.response)
    if (!parsed) {
      this.dropUnanswered(tracker)
      await this.skipped('c4_next_step', 'jev_answer_invalid', { request_id: tracker.request_id })
      return undefined
    }
    const stale = late ?? this.c4StillApplies(tracker)
    if (stale && stage !== 'deciding') {
      // A shadow answer for a turn, conversation or step that moved on is discarded.
      this.dropUnanswered(tracker)
      await this.skipped('c4_next_step', 'answer_discarded_stale', { request_id: tracker.request_id, detail: stale })
      return undefined
    }
    const direct = parsed.choice === 'direct_to_executor'
    // The late checks only ever make the route more cautious: a stale or newly blocked state records the judgment
    // (it is still evidence) but it does not act.
    const acted = stage === 'deciding' && direct && parsed.confidence >= C4_MIN_CONFIDENCE && !stale
    const judgment = await this.record({
      family: 'c4_next_step',
      request_id: tracker.request_id,
      goal_id: this.loop.memory.planningState?.(this.loop.activePlanKey())?.goal?.goal_id,
      plan_id: tracker.plan_id,
      step_id: tracker.step_id,
      checkpoint: 'C4',
      jev_choice: parsed.choice,
      jev_confidence: parsed.confidence,
      alternative: { kind: 'targeted_observation_wake', source: acted ? 'skipped_by_deciding_route' : 'post_step_gate_route_follows' },
      acted,
      reason: acted
        ? 'deciding_stage_direct_to_executor'
        : stale ? `route_unchanged_${stale.split(':')[0]}`
          : stage === 'shadow' ? 'shadow_no_behavior_change' : 'route_unchanged_low_confidence_or_ground_first',
      detail: { harness_checks: tracker.harness_checks, latency_ms: asked.latency_ms, closed_step_id: tracker.closed_step_id, ...(stale ? { late_check: stale } : {}) },
      saving_estimate: acted ? { wakes: tracker.baseline_tokens > 0 ? 1 : 0, tokens: tracker.baseline_tokens } : undefined,
    })
    if (!judgment) {
      this.dropUnanswered(tracker)
      return undefined
    }
    tracker.judgment_id = judgment.judgment_id
    tracker.choice = parsed.choice
    tracker.acted = judgment.acted
    tracker.stage = stage
    if (!judgment.acted) await this.emitUnchangedRoute(tracker)
    await this.emitWakeMeasured(tracker)
    // The outcome may already be known (a slow shadow answer): score now.
    await this.emit(this.tryScoreC4(tracker))
    return { acted: judgment.acted, direct, confidence: parsed.confidence }
  }

  // What the judgment would have done next to the route the gate really took. Written once, when both the answer and
  // the gate's route are known (a shadow answer may arrive after the gate).
  async emitUnchangedRoute(tracker) {
    if (tracker.route_row_emitted || !tracker.judgment_id || tracker.gate_route === undefined) return
    tracker.route_row_emitted = true
    const direct = tracker.choice === 'direct_to_executor'
    await this.loop.traceEvent('c4.route_applied', {
      request_id: tracker.request_id,
      judgment_id: tracker.judgment_id,
      mode: tracker.stage === 'deciding' ? 'route_unchanged' : 'shadow',
      jev_choice: tracker.choice,
      would_route: direct ? 'continue_current_without_observation_wake' : 'unchanged',
      applied_route: tracker.gate_route,
      reason: tracker.stage === 'shadow' ? 'shadow_no_behavior_change' : 'route_unchanged_low_confidence_or_ground_first_or_late_check',
      estimated_saving_basis: 'observation_round_tokens_of_the_wake_that_runs',
    }, { requestId: tracker.request_id })
  }

  async noteGateRoute(handle, route) {
    const tracker = handle ? this.trackers.get(handle.key) : undefined
    if (!tracker) return
    tracker.gate_route = route
    await this.emitUnchangedRoute(tracker)
  }

  async emitWakeMeasured(tracker) {
    if (tracker.wake_row_emitted || !tracker.judgment_id || !tracker.measured) return
    tracker.wake_row_emitted = true
    const measured = tracker.measured
    await this.loop.traceEvent('c4.wake_measured', {
      request_id: tracker.request_id,
      judgment_id: tracker.judgment_id,
      mode: tracker.acted ? 'deciding' : 'shadow',
      reason: tracker.acted ? 'executor_continued_directly' : 'the_wake_that_ran_under_the_current_gate_route',
      gate_route: tracker.gate_route,
      ...measured,
      estimated_saving_tokens: tracker.acted ? Math.max(0, tracker.baseline_tokens - measured.observation_round_tokens) : measured.observation_round_tokens,
      failed: tracker.wake_failed === true,
    }, { requestId: tracker.request_id })
  }

  beginWake(c4) {
    const tracker = c4 ? this.trackers.get(c4.key) : undefined
    if (!tracker) return
    tracker.wake = { open: true, rounds: [], fresh: 0, families: new Set() }
  }

  async endWake(c4, { error = false } = {}) {
    const tracker = c4 ? this.trackers.get(c4.key) : undefined
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
    tracker.wake_failed = error
    await this.emitWakeMeasured(tracker)
    if (error) {
      if (tracker.judgment_id) await this.emit(this.abandonNow(tracker.judgment_id, 'wake_failed'))
      else this.dropUnanswered(tracker)
      return
    }
    await this.emit(this.tryScoreC4(tracker))
  }

  // What "observation was needed" means, ONE label for both answers (jev-judgments.mjs c4ObservationNeeded):
  // the wake made fresh lookups, or the step did not verify on its first batch (a failure boundary, or the first
  // batch completing without the contract satisfied). direct_to_executor agrees iff it was not needed; ground_first
  // agrees iff it was. It is scored as soon as the label is known: lookups and a failed first batch are final
  // (whatever the request does next), a clean first batch waits for the step to verify.
  tryScoreC4(tracker) {
    if (!tracker.judgment_id || !tracker.choice || !tracker.measured) return []
    const measured = tracker.measured
    const firstTryFailed = tracker.had_failure || tracker.first_batch_unverified
    const result = scoreC4Judgment({
      choice: tracker.choice,
      fresh_lookups: measured.fresh_lookups,
      verified: tracker.verified,
      first_try: !firstTryFailed,
    })
    if (!result) return []
    // Saving counts only when Jev said direct and it held (observation was not needed). A judgment that did not act
    // saved nothing real: its figure is what skipping the observation rounds WOULD have saved.
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
        observation_needed: result.observation_needed,
        step_verified: tracker.verified,
        verified_first_try: tracker.verified === true && !firstTryFailed,
        had_failure_boundary: tracker.had_failure,
        first_batch_unverified: tracker.first_batch_unverified,
        gate_route: tracker.gate_route,
        ...measured,
      },
    })
  }

  // A failure boundary: a judged step whose batch failed did not verify on its first batch, whatever the request does
  // next (a recovery, a replan). Scored now.
  async noteFailureBoundary() {
    const rows = []
    for (const tracker of [...this.trackers.values()]) {
      if (tracker.kind !== 'c4') continue
      tracker.had_failure = true
      rows.push(...this.tryScoreC4(tracker))
    }
    await this.emit(rows)
  }

  // A batch completed and the completion gate did NOT close the step: for a judged step whose wake has run, that is
  // its first batch failing to verify. Transient or non-outcome gate results never count.
  async onCompletionBoundary(stepCompletion) {
    if (this.trackers.size === 0 || stepCompletion?.verified === true) return
    if (['pending_amendment', 'no_authoritative_operation_receipt'].includes(stepCompletion?.reason)) return
    const rows = []
    for (const tracker of [...this.trackers.values()]) {
      if (tracker.kind !== 'c4' || !tracker.measured || tracker.first_batch_unverified) continue
      tracker.first_batch_unverified = true
      rows.push(...this.tryScoreC4(tracker))
    }
    await this.emit(rows)
  }

  // --- observation families at a restage ---------------------------------------------------------------

  // Called by restageThrough AFTER the guard that could refuse the restage, before the packet is built.
  //  - shadow: nothing is asked here and nothing is awaited (the packet is unchanged); `afterRestage` starts the call
  //    once the restage has landed, so a refused restage never burns one.
  //  - advisory: Jev is asked now with a bounded wait; the harness reads the deterministic facts of the families
  //    Jev picked (only those with a parameterless fact tool) for the packet to ADD, and the judgment is recorded.
  // Never throws; undefined when nothing was judged.
  async prepareRestage({ checkpoint, role, planningState, reason, requestId }) {
    try {
      if (!this.enabled || !OBSERVATION_RESTAGE_CHECKPOINTS.includes(checkpoint)) return undefined
      if (!await this.mayJudge('observation_families')) return undefined
      const stage = this.stage('observation_families')
      const rid = requestId ?? this.loop.traceRequest?.id
      const context = { checkpoint, role, reason, requestId: rid, ids: this.planIds(planningState), state: observationState({ checkpoint, role, planningState, reason }) }
      if (stage === 'shadow') return { shadow: true, stage, context, selected: [], facts: [], hints: [] }
      const asked = await this.ask({ contract: 'restage_observation_families', state: context.state, questions: observationRelevanceQuestions(), stage, waitMs: this.waitMs })
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
      if (selected.length > 0) {
        const added = await this.packetFacts(selected)
        facts = added.facts
        hints = added.hints
      }
      const judgment = await this.recordObservation({ context, stage, relevance, selected, facts, hints, latency: asked.latency_ms })
      if (!judgment) return undefined
      return { judgment_id: judgment.judgment_id, selected, stage, facts, hints, context }
    }
    catch (error) {
      try {
        await this.skipped('observation_families', 'prepare_failed', { error: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) })
      }
      catch {}
      return undefined
    }
  }

  async recordObservation({ context, stage, relevance, selected, facts, hints, latency, handoffId }) {
    const judgment = await this.record({
      family: 'observation_families',
      request_id: context.requestId,
      ...context.ids,
      handoff_id: handoffId,
      checkpoint: context.checkpoint,
      jev_choice: selected,
      jev_confidence: selected.length > 0 ? Math.max(...selected.map(family => relevance.probabilities[family] ?? 0)) : undefined,
      alternative: { kind: 'deterministic_packet', added_facts: [] },
      acted: facts.length > 0 || hints.length > 0,
      reason: stage === 'shadow' ? 'shadow_no_packet_change' : facts.length + hints.length > 0 ? 'advisory_facts_added_to_packet' : 'advisory_nothing_to_add',
      detail: { probabilities: relevance.probabilities, threshold: relevance.threshold, latency_ms: latency, role: context.role },
    })
    if (!judgment) return undefined
    await this.loop.traceEvent('jev.observation_families_selected', {
      request_id: judgment.request_id,
      judgment_id: judgment.judgment_id,
      checkpoint: context.checkpoint,
      role: context.role,
      stage,
      selected_families: selected,
      facts_added: facts.map(fact => fact.family),
      hints_added: hints,
      reason: stage === 'shadow' ? 'shadow_compared_with_the_lookups_the_agent_then_makes' : 'advisory_only_adds_facts_to_the_packet',
    }, { requestId: judgment.request_id })
    return judgment
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

  // After the restage attempt. A refused restage abandons an advisory judgment (a shadow one was never asked). A
  // landed one opens the window in which the fresh agent's lookups are collected (closed by its first admitted
  // operation), and a shadow restage now starts its Jev call WITHOUT awaiting it.
  async afterRestage(prepared, result) {
    if (!prepared) return
    if (result?.restaged !== true) {
      if (prepared.judgment_id) await this.emit(this.abandonNow(prepared.judgment_id, `restage_not_applied: ${result?.reason ?? 'unknown'}`))
      return
    }
    const loop = this.loop
    const tracker = this.track({
      kind: 'observation',
      judgment_id: prepared.judgment_id,
      request_id: prepared.context.requestId,
      handoff_id: result.handoff_id,
      conversation_seq: loop.agentContext.conversationSeq,
      selected: prepared.selected,
      provided: prepared.facts.map(fact => fact.family),
      mode: prepared.facts.length > 0 ? 'with_supplied_facts' : 'two_sided',
      families: new Set(),
      fresh: 0,
    })
    if (!prepared.shadow) return
    this.fire(async () => {
      const asked = await this.ask({ contract: 'restage_observation_families', state: prepared.context.state, questions: observationRelevanceQuestions(), stage: 'shadow' })
      await this.answerObservation(tracker, prepared, asked)
    })
  }

  async answerObservation(tracker, prepared, asked) {
    const requestId = prepared.context.requestId
    if (!this.trackers.has(tracker.key) || tracker.closed) {
      this.dropTracker(tracker)
      await this.skipped('observation_families', 'answer_discarded_stale', { request_id: requestId, detail: 'the fresh agent had already acted (the window closed) before the answer arrived', checkpoint: prepared.context.checkpoint })
      return
    }
    if (!asked.ok) {
      this.dropTracker(tracker)
      await this.skipped('observation_families', 'jev_fallback', { request_id: requestId, error: asked.reason, checkpoint: prepared.context.checkpoint })
      return
    }
    const relevance = parseObservationRelevance(asked.response)
    if (relevance.source !== 'typed_relevance') {
      this.dropTracker(tracker)
      await this.skipped('observation_families', 'jev_answer_invalid', { request_id: requestId, checkpoint: prepared.context.checkpoint })
      return
    }
    if (this.loop.agentContext.conversationSeq !== tracker.conversation_seq) {
      this.dropTracker(tracker)
      await this.skipped('observation_families', 'answer_discarded_stale', { request_id: requestId, detail: 'conversation_moved_on', checkpoint: prepared.context.checkpoint })
      return
    }
    const selected = relevance.selected_families
    const judgment = await this.recordObservation({ context: prepared.context, stage: 'shadow', relevance, selected, facts: [], hints: [], latency: asked.latency_ms, handoffId: tracker.handoff_id })
    if (!judgment) {
      this.dropTracker(tracker)
      return
    }
    tracker.judgment_id = judgment.judgment_id
    tracker.selected = selected
  }

  // Scores (or, given a reason, abandons) the observation window of one restage. Returns trace rows.
  finishObservation(tracker, abandon) {
    if (!tracker.judgment_id) {
      this.dropTracker(tracker) // no answer yet: it is discarded when it comes
      return []
    }
    if (abandon) return this.abandonNow(tracker.judgment_id, abandon)
    const result = scoreObservationFamilies({ selected: tracker.selected, looked: [...tracker.families], provided: tracker.provided, mode: tracker.mode })
    if (result.neutral) return this.abandonNow(tracker.judgment_id, 'no_lookups_made_nothing_to_compare')
    return this.scoreNow(tracker.judgment_id, {
      agreed: result.agreed,
      outcome: { selected_families: tracker.selected, looked_up_families: [...tracker.families], provided_families: tracker.provided, fresh_lookups: tracker.fresh, recall: result.recall, precision: result.precision, scoring: result.mode, handoff_id: tracker.handoff_id },
      // Calls the packet's deterministic facts replaced (advisory), or would have replaced (shadow: the
      // lookups the agent made of a family that has a parameterless fact read and that Jev predicted).
      saving: tracker.provided.length > 0
        ? { calls: tracker.provided.length }
        : { calls: [...tracker.families].filter(family => tracker.selected.includes(family) && Object.hasOwn(PACKET_FACT_READERS, family)).length },
    })
  }

  // --- shelf ranking at a shelf pickup ----------------------------------------------------------------

  // `candidates` is the complete ready set in the deterministic order. `needsAnswer` is true only when the ordering
  // can reach a packet that is about to be built (the caller checked the restage guard). Returns
  // { ordered, judgment_id, applied }: `ordered` differs from `candidates` only when the family has earned advisory,
  // the answer was awaited (bounded) and arrived. The judgment is `acted` only once the ordering reaches the packet
  // (markShelfApplied). Shadow (and an advisory pickup with no packet) is fire-and-forget.
  async rankShelf({ route, planningState, candidates, needsAnswer = false }) {
    const unchanged = { ordered: candidates, applied: false }
    try {
      if (!this.enabled || route !== 'next_shelf_slice' || !Array.isArray(candidates) || candidates.length < 2) return unchanged
      // A new pickup supersedes a ranking still waiting for its slice.
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind !== 'shelf') continue
        if (tracker.judgment_id) await this.emit(this.abandonNow(tracker.judgment_id, 'superseded_by_a_newer_shelf_pickup'))
        else this.dropTracker(tracker)
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
      const requestId = this.loop.traceRequest?.id
      const ids = this.planIds(planningState)
      const tracker = this.track({ kind: 'shelf', judgment_id: undefined, request_id: requestId, ranked: undefined, picked: undefined, awaiting_pick: true })
      const answer = async (asked, advisory) => {
        if (!this.trackers.has(tracker.key)) {
          await this.skipped('shelf_ranking', 'answer_discarded_stale', { request_id: requestId, detail: 'superseded by a newer pickup' })
          return undefined
        }
        if (!asked.ok) {
          this.dropTracker(tracker)
          await this.skipped('shelf_ranking', 'jev_fallback', { request_id: requestId, error: asked.reason })
          return undefined
        }
        if (!advisory && (!tracker.awaiting_pick || this.loop.traceRequest?.id !== requestId)) {
          // The planner already picked its node (or the request moved on) while Jev thought: a shadow answer is discarded.
          this.dropTracker(tracker)
          await this.skipped('shelf_ranking', 'answer_discarded_stale', { request_id: requestId, detail: 'the planner had already picked a node' })
          return undefined
        }
        const parsed = parseShelfRanking(asked.response, listed)
        if (!parsed) {
          this.dropTracker(tracker)
          await this.skipped('shelf_ranking', 'jev_answer_invalid', { request_id: requestId })
          return undefined
        }
        const ranked = parsed.ordered.map(candidate => candidate.node_id)
        const judgment = await this.record({
          family: 'shelf_ranking',
          request_id: requestId,
          ...ids,
          step_id: undefined,
          checkpoint: 'C2',
          jev_choice: ranked[0],
          jev_confidence: parsed.confidence,
          alternative: { kind: 'deterministic_order', first: listed[0].node_id },
          acted: false, // set only when the ordering reaches the planner's packet
          reason: advisory ? 'advisory_ranking_ready_for_the_packet' : 'shadow_no_order_change',
          detail: { ranked: ranked.slice(0, SHELF_RANKING_LIMIT), candidate_count: listed.length, latency_ms: asked.latency_ms },
        })
        if (!judgment) {
          this.dropTracker(tracker)
          return undefined
        }
        tracker.judgment_id = judgment.judgment_id
        tracker.ranked = ranked
        tracker.parsed = parsed
        await this.emit(this.tryScoreShelf(tracker))
        return { judgment, parsed, ranked }
      }

      if (stage === 'shadow' || !needsAnswer) {
        this.fire(async () => { await answer(await this.ask({ contract: 'shelf_ranking', state, questions: shelfRankingQuestions(listed), stage }), false) })
        return unchanged
      }
      const result = await answer(await this.ask({ contract: 'shelf_ranking', state, questions: shelfRankingQuestions(listed), stage, waitMs: this.waitMs }), true)
      if (!result) return unchanged
      return { ordered: applyShelfRanking(candidates, result.parsed.ordered), judgment_id: result.judgment.judgment_id, applied: false, ranked_first: result.ranked[0], deterministic_first: listed[0].node_id }
    }
    catch (error) {
      try {
        await this.skipped('shelf_ranking', 'rank_failed', { error: cleanMemoryText(error instanceof Error ? error.message : String(error), 200) })
      }
      catch {}
      return unchanged
    }
  }

  // The ordering reached the planner's packet: only now is the judgment `acted`.
  async markShelfApplied(ranking) {
    if (!ranking?.judgment_id) return
    const marked = markJudgmentActed(this.ledger, ranking.judgment_id)
    if (!marked) return
    this.ledger = marked
    await this.loop.traceEvent('jev.shelf_ranking_applied', {
      request_id: pendingJudgment(this.ledger, ranking.judgment_id)?.request_id,
      judgment_id: ranking.judgment_id,
      stage: this.stage('shelf_ranking'),
      ranked_first: ranking.ranked_first,
      deterministic_first: ranking.deterministic_first,
      reason: 'advisory_orders_candidates_only_the_planner_still_chooses',
    }, { requestId: pendingJudgment(this.ledger, ranking.judgment_id)?.request_id })
  }

  // The outcome of the slice that refined the picked node, from the reducer: verified (COMPLETED), failed
  // (BLOCKED, SUPERSEDED, CANCELLED) or still running (undefined).
  shelfSliceOutcome(tracker) {
    if (!tracker.picked) return undefined
    const planning = this.loop.memory.planningState?.(this.loop.activePlanKey())
    const plans = (planning?.plans ?? []).filter(plan => Array.isArray(plan.roadmap_node_ids) && plan.roadmap_node_ids.includes(tracker.picked))
    const plan = plans.at(-1)
    if (!plan) return undefined
    if (plan.status === PLAN_STATUS.COMPLETED) return { verified: true, plan_id: plan.plan_id, status: plan.status }
    if ([PLAN_STATUS.BLOCKED, PLAN_STATUS.SUPERSEDED, PLAN_STATUS.CANCELLED].includes(plan.status)) return { verified: false, plan_id: plan.plan_id, status: plan.status }
    return undefined
  }

  tryScoreShelf(tracker) {
    if (!tracker.judgment_id || !tracker.picked || !tracker.ranked) return []
    const outcome = this.shelfSliceOutcome(tracker)
    if (!outcome) return []
    const result = scoreShelfRanking({ ranked: tracker.ranked, picked: tracker.picked, verified: outcome.verified })
    if (!result) return []
    return this.scoreNow(tracker.judgment_id, {
      ...result,
      outcome: { picked: tracker.picked, ranked_first: tracker.ranked[0], picked_rank: result.picked_rank, slice_verified: outcome.verified, slice_status: outcome.status, plan_id: outcome.plan_id },
    })
  }

  // A plan slice closed: a ranking whose picked node this plan refined is scored now.
  async onSliceClosed() {
    if (!this.enabled || this.trackers.size === 0) return
    const rows = []
    for (const tracker of [...this.trackers.values()]) if (tracker.kind === 'shelf') rows.push(...this.tryScoreShelf(tracker))
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
        if (tracker.kind === 'observation' && !tracker.closed) {
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
        else if (tracker.judgment_id) rows.push(...this.abandonNow(tracker.judgment_id, 'planner_named_no_shelf_node'))
        else this.dropTracker(tracker)
      }
      return rows
    }
    if (event === 'operations.ack' || event === 'context.restaged') {
      for (const tracker of [...this.trackers.values()]) if (tracker.kind === 'observation' && !tracker.closed) rows.push(...this.closeObservationWindow(tracker))
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
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind !== 'shelf') continue
        if (tracker.judgment_id) rows.push(...this.abandonNow(tracker.judgment_id, 'new_goal'))
        else this.dropTracker(tracker)
      }
      return rows
    }
    if (['request.completed', 'request.failed', 'request.cancelled', 'request.superseded', 'goal.paused'].includes(event)) {
      const ended = event === 'request.completed' ? 'completed' : event === 'request.failed' || event === 'goal.paused' ? 'failed' : 'cancelled'
      for (const tracker of [...this.trackers.values()]) {
        if (tracker.kind === 'observation') {
          if (!tracker.closed) rows.push(...(ended === 'completed' ? this.closeObservationWindow(tracker) : this.finishObservation(tracker, `request_${ended}`)))
          else if (!tracker.judgment_id) this.dropTracker(tracker)
        }
        else if (tracker.kind === 'c4') {
          if (!tracker.judgment_id) { this.dropUnanswered(tracker); continue }
          // A real cancel or supersede abandons. Anything else the request does next (complete, fail, pause, replan)
          // is an outcome: a step that did not verify on its first batch is a disagreement.
          if (ended === 'cancelled' || !tracker.measured) { rows.push(...this.abandonNow(tracker.judgment_id, `request_${ended}_before_an_outcome`)); continue }
          if (tracker.verified === undefined) tracker.verified = stepClosed(tracker)
          if (tracker.verified !== true) tracker.first_batch_unverified = true
          rows.push(...this.tryScoreC4(tracker))
        }
        else if (tracker.kind === 'shelf' && tracker.judgment_id && tracker.picked) rows.push(...this.tryScoreShelf(tracker))
      }
      return rows
    }
    return rows
  }

  // The fresh agent's window closed (its first admitted operation, the next restage, the request end).
  closeObservationWindow(tracker) {
    tracker.closed = true
    if (!tracker.judgment_id) {
      // Answer still in flight: the fresh agent has acted, so the answer, when it comes, is discarded.
      return []
    }
    return this.finishObservation(tracker)
  }
}
