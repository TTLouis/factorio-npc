// Goal-level usage accounting and the goal budget warning (work plan item
// 2.7, W2d).
//
// Provider usage is already summed per request (traceRequest.usage), and a
// request can span a whole goal or only part of one. This ledger sums it per
// goal instead: input (cached and cache-miss), output (reasoning and
// visible), provider calls, requests and verified steps. The first rounds of
// a new goal run before the goal exists; they are held per request and moved
// onto the goal when its first plan is persisted.
//
// The goal budget is a warning, not a stop: when a goal's output passes
// GOAL_WARNING_OUTPUT_CAPS per-step output budgets, the player is told once
// (budget.goal_warning carries the chat line). The hard stops stay where 1.5
// put them: the per-step output budget and the request-wide ceiling, both of
// which end in a visible pause.
//
// Units only. Prices are not configured anywhere in the runtime (no setting,
// no guessed default); the run report takes a price file when money is
// wanted (think-time-report.mjs --prices).

export const GOAL_WARNING_OUTPUT_CAPS = 3

function units(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function formatUnits(value) {
  const number = units(value)
  if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`
  if (number >= 10_000) return `${Math.round(number / 1000)}k`
  if (number >= 1000) return `${Math.round(number / 100) / 10}k`
  return String(number)
}

function emptyBucket() {
  return {
    provider_calls: 0,
    input_units: 0,
    cached_input_units: 0,
    cache_miss_input_units: 0,
    output_units: 0,
    reasoning_output_units: 0,
    visible_output_units: 0,
    usage_incomplete_calls: 0,
    requests: new Set(),
  }
}

function addUsage(bucket, usage, requestId) {
  bucket.provider_calls++
  if (requestId) bucket.requests.add(requestId)
  if (!usage || typeof usage !== 'object') {
    bucket.usage_incomplete_calls++
    return
  }
  for (const key of ['input_units', 'cached_input_units', 'cache_miss_input_units', 'output_units', 'reasoning_output_units', 'visible_output_units']) {
    bucket[key] += units(usage[key])
  }
  if (usage.usage_complete !== true) bucket.usage_incomplete_calls++
}

function mergeBucket(target, source) {
  for (const key of ['provider_calls', 'input_units', 'cached_input_units', 'cache_miss_input_units', 'output_units', 'reasoning_output_units', 'visible_output_units', 'usage_incomplete_calls']) {
    target[key] += source[key]
  }
  for (const id of source.requests) target.requests.add(id)
}

export function bucketSummary(bucket) {
  if (!bucket) return undefined
  return {
    provider_calls: bucket.provider_calls,
    requests: bucket.requests.size,
    input_units: bucket.input_units,
    cached_input_units: bucket.cached_input_units,
    cache_miss_input_units: bucket.cache_miss_input_units,
    cached_input_share: bucket.input_units > 0 ? Math.round(bucket.cached_input_units / bucket.input_units * 1000) / 1000 : undefined,
    output_units: bucket.output_units,
    reasoning_output_units: bucket.reasoning_output_units,
    visible_output_units: bucket.visible_output_units,
    usage_incomplete_calls: bucket.usage_incomplete_calls,
    verified_steps: bucket.verified_steps ?? 0,
    output_units_per_verified_step: bucket.verified_steps > 0 ? Math.round(bucket.output_units / bucket.verified_steps) : undefined,
  }
}

const STEP_CLOSE_EVENTS = new Set(['step.verified', 'step.semantic_completed'])
const TERMINAL_EVENTS = new Set(['request.completed', 'request.failed', 'request.cancelled', 'request.superseded'])

export class UsageLedger {
  constructor({ warningOutputUnits, outputCap = 100000 } = {}) {
    this.explicitWarning = Number.isSafeInteger(warningOutputUnits) && warningOutputUnits > 0 ? warningOutputUnits : undefined
    this.outputCap = outputCap
    this.goals = new Map()
    this.pending = new Map()
    this.newGoalRequests = new Set()
  }

  warningOutputUnits() {
    return this.explicitWarning ?? GOAL_WARNING_OUTPUT_CAPS * this.outputCap
  }

  goal(goalId) {
    let bucket = this.goals.get(goalId)
    if (!bucket) {
      bucket = { ...emptyBucket(), goal_id: goalId, verified_steps: 0, warned: false }
      this.goals.set(goalId, bucket)
      while (this.goals.size > 32) this.goals.delete(this.goals.keys().next().value)
    }
    return bucket
  }

  // `context.goalId` is the live goal when a round runs. A request that
  // starts a new goal charges nothing to the goal that was live before it:
  // its rounds wait in `pending` until the new goal's first plan is saved,
  // even while the old goal is still active, paused or blocked.
  observe(event, data = {}, context = {}) {
    const after = []
    const requestId = context.requestId
    if (event === 'request.received' && requestId && data?.interaction_intent === 'new_goal') {
      this.newGoalRequests.add(requestId)
      while (this.newGoalRequests.size > 64) this.newGoalRequests.delete(this.newGoalRequests.keys().next().value)
    }
    const authoringNewGoal = Boolean(requestId && this.newGoalRequests.has(requestId))
    const liveGoal = authoringNewGoal ? undefined : context.goalId
    if (event === 'provider.response') {
      if (liveGoal) addUsage(this.goal(liveGoal), data?.usage, requestId)
      else if (requestId) {
        if (!this.pending.has(requestId)) this.pending.set(requestId, emptyBucket())
        addUsage(this.pending.get(requestId), data?.usage, requestId)
      }
    }
    const persistedGoal = event === 'plan.persisted' && typeof data?.goal_id === 'string' && data.goal_id ? data.goal_id : undefined
    if (persistedGoal && requestId) {
      if (this.pending.has(requestId)) mergeBucket(this.goal(persistedGoal), this.pending.get(requestId))
      this.pending.delete(requestId)
      this.newGoalRequests.delete(requestId)
    }
    // A step that closes the goal leaves it completed, so the closing step is
    // counted against the goal it belonged to, whatever its status now.
    const closedGoal = context.stepGoalId ?? context.goalId
    if (STEP_CLOSE_EVENTS.has(event) && closedGoal) this.goal(closedGoal).verified_steps++
    if (TERMINAL_EVENTS.has(event) && requestId) {
      this.pending.delete(requestId)
      this.newGoalRequests.delete(requestId)
    }
    const goalId = persistedGoal ?? liveGoal
    const warning = goalId && (event === 'provider.response' || persistedGoal) ? this.warningFor(goalId) : undefined
    if (warning) after.push(warning)
    return { before: [], after }
  }

  warningFor(goalId) {
    const bucket = this.goals.get(goalId)
    const threshold = this.warningOutputUnits()
    if (!bucket || bucket.warned || bucket.output_units < threshold) return undefined
    bucket.warned = true
    const summary = bucketSummary(bucket)
    return ['budget.goal_warning', {
      goal_id: goalId,
      threshold_output_units: threshold,
      threshold_source: this.explicitWarning ? 'explicit' : `${GOAL_WARNING_OUTPUT_CAPS} x per-step output budget`,
      ...summary,
      next_action: 'continue',
      chat_message: `Heads-up: this goal has used ${formatUnits(summary.output_units)} model output units so far (${summary.provider_calls} model calls, ${summary.verified_steps} verified step${summary.verified_steps === 1 ? '' : 's'}), past the ${formatUnits(threshold)} warning mark. I'll keep going; pause or cancel it on the task board if you want me to stop.`,
    }]
  }

  goalSummary(goalId) {
    return bucketSummary(this.goals.get(goalId))
  }

  debugFields(goalId) {
    const summary = goalId ? this.goalSummary(goalId) : undefined
    if (!summary) return { goal_spend: '' }
    const cached = summary.cached_input_share !== undefined ? ` (${Math.round(summary.cached_input_share * 100)}% cached)` : ''
    const perStep = summary.output_units_per_verified_step !== undefined ? ` · ${formatUnits(summary.output_units_per_verified_step)} out per verified step` : ''
    return {
      goal_spend: `out ${formatUnits(summary.output_units)} · in ${formatUnits(summary.input_units)}${cached} · ${summary.provider_calls} calls · ${summary.verified_steps} verified${perStep} · warns at ${formatUnits(this.warningOutputUnits())} out`,
    }
  }
}
