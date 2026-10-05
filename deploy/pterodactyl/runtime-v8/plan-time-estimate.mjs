// Plan duration estimate and parallelization review (work plan item 2.6, W2c).
//
// The harness, not the model, works out how long an admitted batch keeps the
// NPC busy, from the same live prototype arithmetic that answers the
// `estimateProductionTime` tool (packages/autorio/src/production_estimate*.ts):
// hand mining is the resource's mining_time over the character's mining speed,
// hand crafting is the recipe energy over the hand crafting speed, `wait` is
// its tick count. Nothing here guesses a rate: an operation whose rate the game
// did not supply is `unknown`, and walking, placement and transfer time are
// listed as excluded rather than estimated.
//
// What the harness does with the number:
//  - it is traced (`plan.time_estimate`) and shown on the task board step and
//    in the Debug window next to the elapsed time;
//  - a draft whose batch runs long on the NPC's own serial lane, from a
//    request in which the model never called an estimate tool, gets ONE
//    review round before it is committed (`plan.time_review_requested`). The
//    draft is not committed yet, so no committed plan is changed; the model
//    may resubmit it unchanged with a reason (`timeReview`), which is traced;
//  - while the step runs, the planner's continuation context carries the
//    estimate against the elapsed time, and a parallelization prompt when the
//    step is long on one lane or has overrun (`step.time_overrun`).
// How to parallelize (more machines, or other work while the character mines)
// stays the model's choice; this module names mechanics, never a build order.

import { toolCommand } from './structured-policy.mjs'

export const STEP_LONG_SECONDS = 300
export const PLAN_LONG_SECONDS = 1200
// Elapsed above this multiple of the estimate is an overrun. The 2026-09-26
// steam run measured 13 min 26 s against 13 min derived (1.03x, walking
// included), so 1.5x stays clear of ordinary walking overhead. Tune from traces.
export const OVERRUN_FACTOR = 1.5
export const ESTIMATE_TOOL_NAMES = new Set(['estimateProductionTime', 'getMiningDetails'])
export const RATE_BASIS = 'live prototype rates via autorio_knowledge.production_estimate (hand mining: mining_time / character mining speed; hand crafting: recipe energy / hand crafting speed); wait: ticks / 60'
export const EXCLUDED_TIME = Object.freeze(['walking', 'placement', 'transfer'])
const MAX_RATE_LOOKUPS = 8
const TICKS_PER_SECOND = 60
const DEFAULT_SEARCH_RADIUS = 256

const HAND_MINE_OPERATIONS = new Set(['gather_resource', 'mine_resource_at'])
const WALK_OPERATIONS = new Set(['walk_to_entity', 'walk_to_entity_exact', 'walk_to_position', 'walk_to_player'])
// Actions that take a few ticks once the character is in reach. They have no
// rate to estimate; the walk before them is the excluded walking time.
const QUICK_OPERATIONS = new Set([
  'place_entity', 'place_candidate', 'rotate_entity', 'supply_entity', 'move_items', 'move_items_exact',
  'move_items_with_player', 'set_machine_recipe', 'equip_weapon', 'equip_ammo', 'equip_armor',
  'select_weapon_slot', 'set_auto_defense', 'stop_follow_player',
])

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function round1(value) {
  return Math.round(value * 10) / 10
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown'
  if (seconds < 90) return `${Math.round(seconds)} s`
  return `${round1(seconds / 60).toFixed(1)} min`
}

// Share of a time split in which the NPC was not working: model thinking plus
// idle over wall time. Undefined when no wall time passed.
function notWorkingPercent(split) {
  return split?.wall_ms > 0 ? Math.round((split.think_ms + split.idle_ms) / split.wall_ms * 100) : undefined
}

// The slice-close line of the planner's verified results: a measured fact
// about the slice just closed, never a rate or an estimate. Undefined when
// there is no split (no request) or no wall time passed, so no zeros are shown.
export function sliceTimeSplitText(split) {
  const share = notWorkingPercent(split)
  if (share === undefined) return undefined
  const text = ms => formatDuration(ms / 1000)
  return `npc time this slice: actor busy ${text(split.actor_busy_ms)}, model thinking ${text(split.think_ms)}, idle ${text(split.idle_ms)} (NPC not working ${share}%; idle includes waiting on machines, harness and Jev; walking is inside actor busy)`
}

// The request-to-date clause of the [TIME_ESTIMATE] message.
export function requestTimeSplitClause(split) {
  const share = notWorkingPercent(split)
  if (share === undefined) return undefined
  const text = ms => formatDuration(ms / 1000)
  return `NPC not working ${share}% of this request so far: thinking ${text(split.think_ms)}, idle ${text(split.idle_ms)}.`
}

function cleanName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined
}

// What one operation asks of the actor, before any rate is known.
export function classifyOperation(operation) {
  const name = typeof operation?.name === 'string' ? operation.name : ''
  const args = operation?.args ?? {}
  if (HAND_MINE_OPERATIONS.has(name)) {
    const target = cleanName(args.resource_name)
    const count = Number.isSafeInteger(args.count) && args.count > 0 ? args.count : 1
    return {
      name,
      kind: target ? 'hand_mine' : 'unknown',
      target,
      count,
      ...(name === 'gather_resource' ? { search_radius: Number.isSafeInteger(args.search_radius) ? args.search_radius : DEFAULT_SEARCH_RADIUS } : {}),
    }
  }
  if (name === 'craft_item') {
    const target = cleanName(args.item_name)
    const count = Number.isSafeInteger(args.count) && args.count > 0 ? args.count : 1
    return { name, kind: target ? 'hand_craft' : 'unknown', target, count }
  }
  if (name === 'wait') {
    const ticks = Number.isSafeInteger(args.ticks) && args.ticks > 0 ? args.ticks : undefined
    return ticks ? { name, kind: 'wait', seconds: ticks / TICKS_PER_SECOND } : { name, kind: 'unknown' }
  }
  if (WALK_OPERATIONS.has(name)) return { name, kind: 'walk' }
  if (QUICK_OPERATIONS.has(name)) return { name, kind: 'quick' }
  // Mining a named entity, harvesting, research, combat, construction plans:
  // the game offers no rate the harness can apply without guessing.
  return { name, kind: 'unknown' }
}

// The estimateProductionTime request that makes the mod resolve exactly this
// hand operation: a hand-mining step pinned to the resource, or a hand-crafting
// step (no machine, no resource).
export function rateLookupArgs(kind, target) {
  if (kind === 'hand_mine') return { target, count: 1, steps: [{ item: target, resource: target }] }
  if (kind === 'hand_craft') return { target, count: 1, steps: [{ item: target }] }
  return undefined
}

// Per-cycle facts from the mod's estimate answer, only when the mod resolved
// the step the way the operation performs it (a hand craft that fell through
// to hand mining is not a crafting rate).
export function parseRateAnswer(kind, raw) {
  let parsed
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return undefined }
  if (parsed?.ok !== true || !Array.isArray(parsed.steps)) return undefined
  const step = parsed.steps.find(entry => entry?.kind === kind)
  const secondsPerCycle = positiveNumber(step?.seconds_per_cycle)
  const cycles = positiveNumber(step?.cycles)
  const amount = positiveNumber(step?.amount)
  if (!secondsPerCycle || !cycles || !amount) return undefined
  return { seconds_per_cycle: secondsPerCycle, output_per_cycle: amount / cycles }
}

export class PlanTimeEstimator {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
  }

  // Read fresh for every batch (deduplicated within it), not cached across
  // batches: research such as a manual mining or crafting speed bonus changes
  // the rate, and the runtime sees no research-finished event to invalidate a
  // cache on. The read is one small computation in the mod.
  async rate(rcon, kind, target) {
    try {
      const raw = await rcon.command(toolCommand('estimateProductionTime', rateLookupArgs(kind, target)))
      return parseRateAnswer(kind, raw)
    }
    catch {
      return undefined
    }
  }

  // Serial time the batch keeps the actor busy, from game rates only.
  async estimateOperations(rcon, operations) {
    const entries = (Array.isArray(operations) ? operations : []).slice(0, 16).map(classifyOperation)
    const lookups = []
    for (const entry of entries) {
      if ((entry.kind === 'hand_mine' || entry.kind === 'hand_craft')
        && !lookups.some(item => item.kind === entry.kind && item.target === entry.target)
        && lookups.length < MAX_RATE_LOOKUPS) {
        lookups.push({ kind: entry.kind, target: entry.target })
      }
    }
    const rates = new Map()
    for (const lookup of lookups) {
      rates.set(`${lookup.kind}|${lookup.target}`, rcon ? await this.rate(rcon, lookup.kind, lookup.target) : undefined)
    }
    let known = 0
    let unknown = 0
    let lowerBound = false
    const detail = entries.map((entry, index) => {
      const base = { index, name: entry.name, kind: entry.kind }
      if (entry.kind === 'wait') {
        known += entry.seconds
        return { ...base, seconds: round1(entry.seconds) }
      }
      if (entry.kind === 'hand_mine' || entry.kind === 'hand_craft') {
        const rate = rates.get(`${entry.kind}|${entry.target}`)
        const common = { ...base, target: entry.target, count: entry.count, ...(entry.search_radius !== undefined ? { search_radius: entry.search_radius } : {}) }
        if (!rate) {
          unknown++
          return { ...common, kind: 'unknown', wanted: entry.kind }
        }
        const cycles = Math.ceil(entry.count / rate.output_per_cycle - 1e-9)
        const seconds = cycles * rate.seconds_per_cycle
        known += seconds
        // The native craft queue also crafts missing intermediates; only the
        // named recipe is counted, so a craft is a lower bound.
        if (entry.kind === 'hand_craft') lowerBound = true
        return {
          ...common,
          seconds: round1(seconds),
          seconds_per_unit: Math.round(rate.seconds_per_cycle / rate.output_per_cycle * 1000) / 1000,
          ...(entry.kind === 'hand_craft' ? { bound: 'lower', note: 'named recipe only; intermediates the queue crafts are not counted' } : {}),
        }
      }
      if (entry.kind === 'unknown') unknown++
      return base
    })
    const timed = detail.filter(item => Number.isFinite(item.seconds))
    const handWork = entries.some(entry => entry.kind === 'hand_mine' || entry.kind === 'hand_craft' || entry.kind === 'wait')
    const widestRadius = Math.max(0, ...detail.map(item => item.search_radius ?? 0))
    return {
      schema: 1,
      lane: 'actor',
      single_lane: true,
      expected_seconds: timed.length > 0 ? round1(known) : undefined,
      complete: unknown === 0 && !lowerBound && timed.length > 0,
      lower_bound: unknown > 0 || lowerBound,
      unknown_operations: unknown,
      hand_work: handWork,
      basis: timed.length > 0 ? RATE_BASIS : 'unknown: the game supplied no rate for this batch',
      excluded: [...EXCLUDED_TIME],
      ...(widestRadius > 0 ? { widest_search_radius: widestRadius } : {}),
      operations: detail,
    }
  }
}

export function isLongEstimate(estimate, { stepExpectedSeconds } = {}) {
  const step = Number.isFinite(stepExpectedSeconds) ? stepExpectedSeconds : estimate?.expected_seconds
  if (!Number.isFinite(step) || estimate?.single_lane !== true) return { long: false }
  if (step >= PLAN_LONG_SECONDS) return { long: true, reason: 'plan_over_threshold', threshold_seconds: PLAN_LONG_SECONDS, seconds: step }
  if (step >= STEP_LONG_SECONDS) return { long: true, reason: 'step_over_threshold', threshold_seconds: STEP_LONG_SECONDS, seconds: step }
  return { long: false, threshold_seconds: STEP_LONG_SECONDS, seconds: step }
}

function operationSummary(estimate) {
  const mined = estimate.operations.filter(item => item.kind === 'hand_mine')
  const crafted = estimate.operations.filter(item => item.kind === 'hand_craft')
  const parts = []
  if (mined.length > 0) parts.push(`hand mining ${mined.reduce((total, item) => total + item.count, 0)} items (${mined.map(item => `${item.count} ${item.target} at ${item.seconds_per_unit} s each`).join(', ')})`)
  if (crafted.length > 0) parts.push(`hand crafting ${crafted.map(item => `${item.count} ${item.target}`).join(', ')}`)
  return parts.join('; ') || 'hand work'
}

const PARALLEL_MECHANICS = 'Parallel here means machines doing this job (for mining, mining drills), or different work overlapping it (the native hand-craft queue keeps crafting while the character mines or walks). Whether and how to parallelize is your choice; test alternatives with estimateProductionTime (machine and machine_count per step) and getMiningDetails.'

export function timeReviewMessage(estimate, trigger, { estimateToolCalled = false, stepNumber } = {}) {
  const step = Number.isSafeInteger(stepNumber) ? `step ${stepNumber}` : 'this step'
  const unknownNote = estimate.unknown_operations > 0
    ? ` ${estimate.unknown_operations} operation(s) have no game rate and are not counted, so this is a lower bound.`
    : ''
  const radius = estimate.widest_search_radius > DEFAULT_SEARCH_RADIUS
    ? ` The widest search_radius is ${estimate.widest_search_radius} tiles; walking to a far patch is extra time not in this figure.`
    : ''
  return [
    `[HARNESS] Time review before this draft is committed (asked once per step). The harness estimates ${step} at about ${formatDuration(estimate.expected_seconds)} of serial work on the NPC's own lane: ${operationSummary(estimate)}. Basis: ${estimate.basis}; ${estimate.excluded.join(', ')} excluded.${unknownNote}${radius}`,
    `That is over the ${formatDuration(trigger.threshold_seconds)} review threshold${estimateToolCalled ? '' : ', and this request made no estimateProductionTime or getMiningDetails call'}.`,
    PARALLEL_MECHANICS,
    'Then submit the plan again: revised, or unchanged with timeReview {"decision":"keep_serial","reason":"..."} (or "parallelize" when you changed it for that). Nothing from this draft has run.',
  ].join(' ')
}

// A review is asked at most once per step in a request, and at most once per
// step of the same plan text (a revision changes the text), so a reply that
// tweaks the draft cannot ping-pong into a second round.
export function timeReviewKey({ requestId, currentStep }) {
  return `${requestId || 'request'}|step_${Number.isSafeInteger(currentStep) ? currentStep : 0}`
}

export function timeReviewRevisionKey({ planSteps, currentStep }) {
  let text = ''
  try { text = JSON.stringify(Array.isArray(planSteps) ? planSteps : []) }
  catch {}
  return `step_${Number.isSafeInteger(currentStep) ? currentStep : 0}|${text}`
}

export function operationsSignature(operations) {
  try { return JSON.stringify((operations ?? []).map(operation => [operation?.name, operation?.args])) }
  catch { return '' }
}

export function parseTimeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!['keep_serial', 'parallelize'].includes(value.decision)) return undefined
  const reason = typeof value.reason === 'string' ? value.reason.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  return { decision: value.decision, reason }
}

const BUSY_END_EVENTS = new Set([
  'factorio.completed_signal',
  'factorio.error_continuation',
  'factorio.completion_continuation',
  'factorio.event_coalesced',
  'post_step.routed',
])
const TERMINAL_EVENTS = new Set(['request.completed', 'request.failed', 'request.cancelled', 'request.superseded'])
const STEP_CLOSE_EVENTS = new Set(['step.verified', 'step.semantic_completed'])

// Oldest entries go first (Map and Set keep insertion order).
function prune(collection, limit) {
  while (collection.size > limit) {
    const oldest = collection.keys().next().value
    collection.delete(oldest)
  }
}

function ackSignature(operations) {
  return operationsSignature((Array.isArray(operations) ? operations : []).map(operation => ({ name: operation?.name, args: operation?.args })))
}

export function activeStepOf(state) {
  const board = state?.task_board
  const index = Number.isSafeInteger(board?.active_index) ? board.active_index : undefined
  const step = index === undefined ? undefined : board?.steps?.[index]
  if (!state?.goal_id || !step?.id) return undefined
  return { goal_id: state.goal_id, step_id: step.id, step_index: index, status: state.status }
}

// Machine work beyond the step's hand work: the latest machine finish past the
// hand estimate (plan 2.5). Zero when no machine wait was scheduled.
export function machineWaitSeconds(record) {
  const finishes = Object.values(record?.machine_finish_offsets ?? {}).filter(Number.isFinite)
  if (finishes.length === 0) return 0
  return round1(Math.max(0, Math.max(...finishes) - (record.expected_seconds ?? 0)))
}

// Per-loop timing state: the draft estimate at commit, one record per step
// that admitted batches, and the current request's time split. Records live
// in memory only; after a restart an active step has no elapsed time, and the
// harness says nothing rather than guessing.
export class PlanTiming {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.estimator = new PlanTimeEstimator({ now })
    this.request = null
    this.steps = new Map()
    this.activeStepKey = null
    this.reviews = new Map()
    this.reviewedRevisions = new Set()
    this.pendingBatch = null
  }

  stepRecord(goalId, stepId) {
    return this.steps.get(`${goalId}|${stepId}`)
  }

  // Called at commit, before the draft touches durable state. Returns whether
  // the draft is held for one review round, and the events to trace.
  async reviewDraft(rcon, plan, context = {}) {
    const events = []
    const estimate = await this.estimator.estimateOperations(rcon, plan?.operations, context)
    if (!estimate.hand_work) {
      this.pendingBatch = null
      return { hold: false, events }
    }
    const active = context.activeStep
    const prior = active ? this.stepRecord(active.goal_id, active.step_id) : undefined
    const priorSeconds = prior && !prior.closed && prior.step_index === context.currentStep && Number.isFinite(prior.expected_seconds) ? prior.expected_seconds : 0
    const stepSeconds = Number.isFinite(estimate.expected_seconds) ? priorSeconds + estimate.expected_seconds : undefined
    const trigger = isLongEstimate(estimate, { stepExpectedSeconds: stepSeconds })
    const key = timeReviewKey(context)
    const revisionKey = timeReviewRevisionKey({ planSteps: plan?.plan, currentStep: context.currentStep })
    const signature = operationsSignature(plan?.operations)
    const answer = parseTimeReview(plan?.timeReview)
    const previous = this.reviews.get(key)
    let review
    if (!previous && this.reviewedRevisions.has(revisionKey)) {
      review = 'already_reviewed'
    }
    else if (previous) {
      review = 'answered'
      if (!previous.answered) {
        previous.answered = true
        const revised = previous.signature !== signature
        events.push(['plan.time_review_answered', {
          review_key: key,
          decision: answer?.decision ?? (revised ? 'revised_without_reason' : 'kept_without_reason'),
          reason: answer?.reason || undefined,
          operations_revised: revised,
          expected_seconds_before: previous.expected_seconds,
          expected_seconds_after: estimate.expected_seconds,
          lane: estimate.lane,
        }])
      }
    }
    else if (trigger.long && context.estimateToolCalled !== true && context.recoveryMode !== true) {
      this.reviews.set(key, { signature, expected_seconds: estimate.expected_seconds, answered: false })
      this.reviewedRevisions.add(revisionKey)
      prune(this.reviews, 256)
      prune(this.reviewedRevisions, 256)
      const message = timeReviewMessage(estimate, trigger, {
        estimateToolCalled: false,
        stepNumber: Number.isSafeInteger(context.currentStep) ? context.currentStep + 1 : undefined,
      })
      events.push(['plan.time_review_requested', {
        review_key: key,
        step_index: context.currentStep,
        expected_seconds: estimate.expected_seconds,
        step_expected_seconds: stepSeconds,
        trigger: trigger.reason,
        threshold_seconds: trigger.threshold_seconds,
        lane: estimate.lane,
        single_lane: estimate.single_lane,
        basis: estimate.basis,
        excluded: estimate.excluded,
        lower_bound: estimate.lower_bound,
        estimate_tool_called: false,
        operations: estimate.operations,
        message,
      }])
      this.pendingBatch = null
      return { hold: true, message, events, estimate }
    }
    else {
      review = !Number.isFinite(estimate.expected_seconds)
        ? 'no_game_rate'
        : trigger.long
          ? (context.recoveryMode === true ? 'skipped_recovery_round' : 'skipped_estimate_tool_called')
          : 'below_threshold'
      if (answer) {
        events.push(['plan.time_review_answered', {
          review_key: key,
          decision: answer.decision,
          reason: answer.reason || undefined,
          unprompted: true,
          expected_seconds_after: estimate.expected_seconds,
          lane: estimate.lane,
        }])
      }
    }
    this.pendingBatch = { signature, estimate, review }
    return { hold: false, events, estimate }
  }

  // Every trace event passes through here once; it returns derived events to
  // write before (`before`) or after (`after`) the observed one.
  observe(event, data = {}, context = {}) {
    const before = []
    const after = []
    const now = this.now()
    if (event === 'request.received') {
      this.request = { id: context.requestId, started_at: now, think_ms: 0, busy_ms: 0, busy_since: undefined, batches: 0, estimate_tool_calls: 0 }
      return { before, after }
    }
    const request = this.request
    if (event === 'provider.response' && request && Number.isFinite(data?.latency_ms) && data.latency_ms >= 0) {
      request.think_ms += data.latency_ms
    }
    if (event === 'tool.call' && request && ESTIMATE_TOOL_NAMES.has(data?.name)) request.estimate_tool_calls++
    if (event === 'runtime.condition_scheduled') this.noteMachineWait(data, now)
    if (event === 'operations.ack') {
      if (request) {
        if (request.busy_since === undefined) request.busy_since = now
        request.batches++
      }
      const recorded = this.recordAdmittedBatch(data, context, now)
      if (recorded) after.push(recorded)
    }
    const statusIdle = event === 'factorio.status'
      && (data?.task_status?.queue_empty === true || data?.task_status?.task_state === 'idle')
    if (request && request.busy_since !== undefined && (BUSY_END_EVENTS.has(event) || statusIdle || TERMINAL_EVENTS.has(event))) {
      request.busy_ms += Math.max(0, now - request.busy_since)
      request.busy_since = undefined
    }
    if (STEP_CLOSE_EVENTS.has(event)) {
      const measured = this.closeStep(data, context, now)
      if (measured) after.push(measured)
    }
    if (TERMINAL_EVENTS.has(event) && request) {
      before.push(['request.time_split', { ...this.timeSplit(now), outcome: typeof data?.outcome === 'string' ? data.outcome : undefined }])
      this.request = null
    }
    return { before, after }
  }

  // Plan 2.5: a completion wait on a machine checkpoint of a timed step adds
  // the machine's game-data finish to that step, so elapsed is compared with
  // hand work plus machine work, not hand work alone. Each machine keeps only
  // its latest expected finish (time since the step started + remaining), so a
  // second wait on the same machine replaces, never adds to, the first.
  noteMachineWait(data, now = this.now()) {
    if (data?.mode !== 'completion' || !Number.isFinite(data?.expected_seconds) || data.expected_seconds < 0) return
    const record = this.steps.get(`${data.goal_id}|${data.step_id}`)
    if (!record || record.closed || !record.timed) return
    const machine = Number.isSafeInteger(data.unit_number) ? `unit:${data.unit_number}` : `wait:${data.wait_id}`
    record.machine_finish_offsets ??= {}
    record.machine_finish_offsets[machine] = round1(Math.max(0, (now - record.started_at) / 1000) + data.expected_seconds)
  }

  estimateToolCalledThisRequest() {
    return (this.request?.estimate_tool_calls ?? 0) > 0
  }

  recordAdmittedBatch(data, context, now) {
    const pending = this.pendingBatch
    this.pendingBatch = null
    if (!pending || pending.signature !== ackSignature(data?.operations)) return undefined
    const active = activeStepOf(context.state)
    if (!active) return undefined
    const key = `${active.goal_id}|${active.step_id}`
    let record = this.steps.get(key)
    if (!record || record.closed) {
      record = {
        goal_id: active.goal_id,
        step_id: active.step_id,
        step_index: active.step_index,
        started_at: now,
        actor_id: context.actorId,
        epoch: context.epoch,
        expected_seconds: 0,
        timed: false,
        lower_bound: false,
        batches: 0,
        hand_mined_items: 0,
        overrun_traced: false,
        closed: false,
      }
      this.steps.set(key, record)
      prune(this.steps, 64)
    }
    const estimate = pending.estimate
    record.batches++
    if (Number.isFinite(estimate.expected_seconds)) {
      record.expected_seconds = round1(record.expected_seconds + estimate.expected_seconds)
      record.timed = true
    }
    record.lower_bound = record.lower_bound || estimate.lower_bound
    record.hand_mined_items += estimate.operations.filter(item => item.kind === 'hand_mine').reduce((total, item) => total + item.count, 0)
    record.caption = estimate.operations.some(item => item.kind === 'hand_mine')
      ? 'hand mining'
      : estimate.operations.some(item => item.kind === 'hand_craft') ? 'hand crafting' : 'hand work'
    record.long = isLongEstimate(estimate, { stepExpectedSeconds: record.timed ? record.expected_seconds : undefined })
    this.activeStepKey = key
    return ['plan.time_estimate', {
      goal_id: active.goal_id,
      step_id: active.step_id,
      step_index: active.step_index,
      batch_expected_seconds: estimate.expected_seconds,
      step_expected_seconds: record.timed ? record.expected_seconds : undefined,
      lane: estimate.lane,
      single_lane: estimate.single_lane,
      basis: estimate.basis,
      excluded: estimate.excluded,
      lower_bound: record.lower_bound,
      unknown_operations: estimate.unknown_operations,
      widest_search_radius: estimate.widest_search_radius,
      long: record.long.long === true,
      trigger: record.long.reason,
      threshold_seconds: record.long.threshold_seconds,
      review: pending.review,
      operations: estimate.operations,
    }]
  }

  closeStep(data, context, now) {
    let record
    if (typeof data?.active_step_id === 'string') {
      record = [...this.steps.values()].find(item => !item.closed && item.step_id === data.active_step_id)
    }
    record ??= this.activeStepKey ? this.steps.get(this.activeStepKey) : undefined
    if (!record || record.closed) return undefined
    record.closed = true
    const sameBody = record.actor_id === context.actorId && record.epoch === context.epoch
    const elapsed = (now - record.started_at) / 1000
    const expected = record.timed ? record.expected_seconds : undefined
    // Machine work the step waited on (plan 2.5) is expected time too.
    const machine = machineWaitSeconds(record)
    const total = expected !== undefined ? expected + machine : undefined
    // Kept on the record (U7) so the planner's slice-close message can show
    // estimated against measured time without re-deriving either.
    record.elapsed_wall_seconds = sameBody ? round1(elapsed) : undefined
    return ['step.time_measured', {
      goal_id: record.goal_id,
      step_id: record.step_id,
      step_index: record.step_index,
      expected_seconds: expected,
      ...(machine > 0 ? { machine_wait_seconds: machine } : {}),
      elapsed_wall_seconds: sameBody ? round1(elapsed) : undefined,
      ratio: sameBody && total > 0 ? Math.round(elapsed / total * 100) / 100 : undefined,
      // What the estimate leaves out (walking, placement, transfer) plus
      // harness overhead, not separated. Recorded so later estimates can be
      // checked against it; never passed to the model as a rate.
      unexplained_seconds: sameBody && total !== undefined ? round1(elapsed - total) : undefined,
      hand_mined_items: record.hand_mined_items || undefined,
      measured_seconds_per_hand_mined_item: sameBody && record.hand_mined_items > 0 && record.caption === 'hand mining'
        ? Math.round(Math.max(0, elapsed - machine) / record.hand_mined_items * 100) / 100
        : undefined,
      lower_bound: record.lower_bound,
      batches: record.batches,
      stale: sameBody ? undefined : 'actor_or_epoch_changed',
    }]
  }

  // Time records of one plan's steps (U7): the harness estimate and the wall
  // clock measured at each step's close. Records are keyed by the legacy board's
  // step id (`step_N`), which repeats across plans and goals, so a record counts
  // only when it is the SAME goal (`goalId`), the same step position, and
  // started at or after `sinceMs` (the plan's commit time): a step of this slice
  // with no admitted hand work must not read an earlier slice's time. Without a
  // goal id nothing matches. A step with no matching record reads as `{ step_id }`.
  closedStepTimes(stepIds, { goalId, sinceMs = 0 } = {}) {
    return (Array.isArray(stepIds) ? stepIds : []).map((stepId, index) => {
      const record = goalId === undefined || goalId === null
        ? undefined
        : [...this.steps.values()]
            .filter(item => item.closed && item.goal_id === goalId && item.step_index === index && item.started_at >= (Number.isFinite(sinceMs) ? sinceMs : 0))
            .sort((left, right) => right.started_at - left.started_at)[0]
      if (!record) return { step_id: stepId }
      const machine = machineWaitSeconds(record)
      return {
        step_id: stepId,
        expected_seconds: record.timed ? record.expected_seconds : undefined,
        machine_wait_seconds: machine > 0 ? machine : undefined,
        elapsed_wall_seconds: record.elapsed_wall_seconds,
      }
    })
  }

  // The active step's record, only while it belongs to the same body.
  activeRecord(state, { actorId, epoch } = {}) {
    const active = activeStepOf(state)
    if (!active || active.status !== 'active') return undefined
    const record = this.stepRecord(active.goal_id, active.step_id)
    if (!record || record.closed || !record.timed) return undefined
    if (record.actor_id !== actorId || record.epoch !== epoch) return undefined
    return record
  }

  // The planner's continuation context while a timed step runs. Returns the
  // text and, the first time the step overruns, the event to trace.
  continuationContext(state, identity = {}) {
    const record = this.activeRecord(state, identity)
    if (!record) return undefined
    const elapsed = (this.now() - record.started_at) / 1000
    const machine = machineWaitSeconds(record)
    const total = record.expected_seconds + machine
    const ratio = total > 0 ? elapsed / total : undefined
    const overrun = Number.isFinite(ratio) && ratio > OVERRUN_FACTOR
    const lines = [
      `[TIME_ESTIMATE] Harness-computed from game rates, not a model guess. Active step ${record.step_index + 1}: about ${formatDuration(record.expected_seconds)} of serial ${record.caption} on the NPC's own lane${record.lower_bound ? ' (lower bound)' : ''}${machine > 0 ? `, then about ${formatDuration(machine)} of machine work (recipe time over live crafting speed)` : ''}; ${EXCLUDED_TIME.join(', ')} excluded. Running for ${formatDuration(elapsed)}${Number.isFinite(ratio) ? ` (${Math.round(ratio * 100) / 100}x the estimate)` : ''}.`,
    ]
    if (overrun) lines.push(`Overrun: elapsed is above ${OVERRUN_FACTOR}x the estimate.`)
    const requestSplit = requestTimeSplitClause(this.timeSplit())
    if (requestSplit) lines.push(requestSplit)
    if (overrun || record.long?.long === true) lines.push(PARALLEL_MECHANICS)
    let event
    if (overrun && !record.overrun_traced) {
      record.overrun_traced = true
      event = ['step.time_overrun', {
        goal_id: record.goal_id,
        step_id: record.step_id,
        step_index: record.step_index,
        expected_seconds: record.expected_seconds,
        ...(machine > 0 ? { machine_wait_seconds: machine } : {}),
        elapsed_wall_seconds: round1(elapsed),
        ratio: Math.round(ratio * 100) / 100,
        overrun_factor: OVERRUN_FACTOR,
      }]
    }
    return { text: lines.join(' '), event }
  }

  timeSplit(now = this.now()) {
    const request = this.request
    if (!request) return undefined
    const wall = Math.max(0, now - request.started_at)
    const busy = request.busy_ms + (request.busy_since !== undefined ? Math.max(0, now - request.busy_since) : 0)
    const think = request.think_ms
    const idle = Math.max(0, wall - busy - think)
    return {
      request_id: request.id,
      wall_ms: wall,
      think_ms: think,
      actor_busy_ms: busy,
      idle_ms: idle,
      idle_share: wall > 0 ? Math.round(idle / wall * 1000) / 1000 : undefined,
      batches: request.batches,
      estimate_tool_calls: request.estimate_tool_calls,
      // Walking is inside actor_busy (the mod runs walk and work as one
      // batch); idle includes harness, RCON and Jev time.
      walking: 'inside_actor_busy',
    }
  }

  // The split of the time since the request's previous slice close (or since
  // the request started), then advances the mark so the next slice counts only
  // its own time. Deltas of one request add up to its timeSplit; a new request
  // resets the mark. Undefined without a request.
  sliceTimeSplit(now = this.now()) {
    const request = this.request
    if (!request) return undefined
    const since = request.slice_mark ? 'previous_slice_close' : 'request_start'
    const mark = request.slice_mark ?? { at: request.started_at, think_ms: 0, busy_ms: 0 }
    const busyTotal = request.busy_ms + (request.busy_since !== undefined ? Math.max(0, now - request.busy_since) : 0)
    const wall = Math.max(0, now - mark.at)
    const busy = Math.max(0, busyTotal - mark.busy_ms)
    const think = Math.max(0, request.think_ms - mark.think_ms)
    request.slice_mark = { at: now, think_ms: request.think_ms, busy_ms: busyTotal }
    return {
      request_id: request.id,
      since,
      wall_ms: wall,
      think_ms: think,
      actor_busy_ms: busy,
      idle_ms: Math.max(0, wall - busy - think),
      walking: 'inside_actor_busy',
    }
  }

  // Ready-to-show Debug and task board text.
  debugFields(state, identity = {}) {
    const fields = { time_estimate: '', time_split: '', step_time_index: -1, step_time_caption: '' }
    const record = this.activeRecord(state, identity)
    if (record) {
      const elapsed = (this.now() - record.started_at) / 1000
      const total = record.expected_seconds + machineWaitSeconds(record)
      const ratio = total > 0 ? elapsed / total : undefined
      fields.time_estimate = `step ${record.step_index + 1}: ~${formatDuration(record.expected_seconds)} ${record.caption} on the NPC lane${record.lower_bound ? ' (lower bound)' : ''} · running ${formatDuration(elapsed)}${Number.isFinite(ratio) && ratio > OVERRUN_FACTOR ? ' · OVERRUN' : ''} · walking excluded`
      fields.step_time_index = record.step_index
      fields.step_time_caption = `~${formatDuration(record.expected_seconds)} · NPC lane${record.long?.long ? ' · long, one lane' : ''}`
    }
    const split = this.timeSplit()
    if (split) {
      const minutes = ms => formatDuration(ms / 1000)
      fields.time_split = `think ${minutes(split.think_ms)} · actor busy ${minutes(split.actor_busy_ms)} · idle ${minutes(split.idle_ms)}${split.idle_share !== undefined ? ` (${Math.round(split.idle_share * 100)}%)` : ''}`
      // Idle share of the request so far, next to the step estimate (W2c).
      if (fields.step_time_caption && split.idle_share !== undefined) fields.step_time_caption += ` · idle ${Math.round(split.idle_share * 100)}%`
    }
    return fields
  }
}
