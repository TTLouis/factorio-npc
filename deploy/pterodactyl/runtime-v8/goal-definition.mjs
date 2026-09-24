// Goal definition: the system's structured understanding of a user goal.
//
// The Main LLM interprets the user's words once, on the first plan of a goal,
// into a scope and a short list of `done_when` conditions that the GAME can
// answer. The harness validates that definition, shows it to the player in
// game, and owns the completion check: a goal is complete when the game says
// its conditions hold, never because a plan's steps ran out.
//
// Conditions are force- or actor-level facts that survive long goals and
// transfer to Space Age: research, rockets, production totals across every
// surface, and unlocked space locations.

import { luaString } from '../staging/structured-policy.mjs'

export const GOAL_SCOPE = Object.freeze({
  FINITE: 'finite',
  LONG_HORIZON: 'long_horizon',
})

export const GOAL_CONDITION_KINDS = Object.freeze([
  'research_completed',
  'rockets_launched',
  'items_produced',
  'inventory_count',
  'space_location_unlocked',
])

// Kinds that read a cumulative force counter. "Launch a rocket" on a save
// that already launched one, or "make 100 gears" on a save that made thousands,
// must not read as done at once, so these count from when the goal started
// unless the planner explicitly asks for the save total.
export const GOAL_COUNTER_KINDS = Object.freeze(['rockets_launched', 'items_produced'])
export const GOAL_COUNT_FROM = Object.freeze({ GOAL_START: 'goal_start', SAVE_START: 'save_start' })

export const GOAL_DEFINITION_LIMITS = Object.freeze({
  maxConditions: 6,
  maxSummaryChars: 400,
})

const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/
const MAX_COUNT = 1_000_000_000

export class GoalDefinitionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new GoalDefinitionError(code, message)
}

function prototypeName(value, field, kind) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    fail('invalid_goal_condition', `goal.doneWhen ${kind}.${field} must be an exact Factorio internal name (lowercase, e.g. "automation" or "iron-plate")`)
  }
  return value
}

function minimum(value, kind) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNT) {
    fail('invalid_goal_condition', `goal.doneWhen ${kind}.minimum must be a positive integer lower bound`)
  }
  return value
}

function countFrom(raw, kind) {
  const value = raw.countFrom ?? raw.count_from ?? GOAL_COUNT_FROM.GOAL_START
  if (!Object.values(GOAL_COUNT_FROM).includes(value)) {
    fail('invalid_goal_condition', `goal.doneWhen ${kind}.countFrom must be "goal_start" (count only what happens from now on, the default) or "save_start" (the save's lifetime total)`)
  }
  return value
}

// Only a stored definition carries a baseline: it is read from the game by the
// harness, never taken from the planner.
function withCounter(condition, raw, { trusted }) {
  const counted = { ...condition, count_from: countFrom(raw, condition.kind) }
  if (trusted && counted.count_from === GOAL_COUNT_FROM.GOAL_START
    && Number.isSafeInteger(raw.baseline) && raw.baseline >= 0) {
    counted.baseline = raw.baseline
  }
  return counted
}

function sanitizeCondition(raw, index, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_goal_condition', 'each goal.doneWhen entry must be an object')
  const kind = raw.kind
  if (!GOAL_CONDITION_KINDS.includes(kind)) {
    fail('invalid_goal_condition', `goal.doneWhen kind must be one of ${GOAL_CONDITION_KINDS.join(', ')}`)
  }
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(raw.id) ? raw.id : `done_${index + 1}`
  if (kind === 'research_completed') return { id, kind, technology: prototypeName(raw.technology, 'technology', kind) }
  if (kind === 'rockets_launched') return withCounter({ id, kind, minimum: minimum(raw.minimum, kind) }, raw, options)
  if (kind === 'space_location_unlocked') return { id, kind, name: prototypeName(raw.name, 'name', kind) }
  const condition = { id, kind, item_name: prototypeName(raw.item_name, 'item_name', kind), minimum: minimum(raw.minimum, kind) }
  return kind === 'items_produced' ? withCounter(condition, raw, options) : condition
}

// Validates the planner-authored `goal` object from submitPlan. Throws a
// GoalDefinitionError whose message is written for the model to correct.
export function sanitizeGoalDefinition(raw, { trusted = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_goal_definition', 'goal must be an object with scope, summary and doneWhen')
  if (!Object.values(GOAL_SCOPE).includes(raw.scope)) fail('invalid_goal_definition', 'goal.scope must be "finite" (one plan of at most 30 steps completes it) or "long_horizon" (needs a Roadmap Shelf and several plan slices)')
  const summary = typeof raw.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').trim() : ''
  if (!summary) fail('invalid_goal_definition', 'goal.summary must restate, in one sentence, what the player asked for')
  // Planner wire shape is doneWhen; the stored shape is done_when.
  const rawConditions = raw.doneWhen ?? raw.done_when
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    fail('invalid_goal_definition', 'goal.doneWhen must list at least one game-checkable condition that proves the goal is complete')
  }
  if (rawConditions.length > GOAL_DEFINITION_LIMITS.maxConditions) {
    fail('invalid_goal_definition', `goal.doneWhen may list at most ${GOAL_DEFINITION_LIMITS.maxConditions} conditions`)
  }
  const doneWhen = rawConditions.map((condition, index) => sanitizeCondition(condition, index, { trusted }))
  const ids = new Set(doneWhen.map(condition => condition.id))
  if (ids.size !== doneWhen.length) fail('invalid_goal_definition', 'goal.doneWhen ids must be unique')
  return {
    scope: raw.scope,
    summary: summary.slice(0, GOAL_DEFINITION_LIMITS.maxSummaryChars),
    done_when: doneWhen,
  }
}

// Restores a stored definition; returns undefined for anything malformed so a
// corrupt snapshot degrades to "no definition" rather than a crash.
export function restoreGoalDefinition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  try {
    const definition = sanitizeGoalDefinition(raw, { trusted: true })
    return {
      ...definition,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 60) : 'main_planner',
      defined_at: Number.isFinite(raw.defined_at) ? raw.defined_at : 0,
    }
  }
  catch {
    return undefined
  }
}

// The mod-side request for one condition (autorio_tools.evaluate_condition).
export function goalConditionRequest(condition) {
  const { id: _id, count_from: _countFrom, baseline: _baseline, ...request } = condition
  return request
}

// A goal_start counter with no recorded baseline yet. It cannot be judged
// until the harness has read where the counter stood.
export function needsGoalBaseline(condition) {
  return GOAL_COUNTER_KINDS.includes(condition?.kind)
    && condition.count_from !== GOAL_COUNT_FROM.SAVE_START
    && !Number.isSafeInteger(condition.baseline)
}

export function goalConditionCommand(condition) {
  const request = goalConditionRequest(condition)
  return `/silent-command local request=helpers.json_to_table(${luaString(JSON.stringify(request))}); rcon.print(helpers.table_to_json(remote.call("autorio_tools","evaluate_condition",request)))`
}

export function describeGoalCondition(condition) {
  switch (condition?.kind) {
    case 'research_completed': return `research "${condition.technology}" is completed`
    case 'rockets_launched': return condition.count_from === GOAL_COUNT_FROM.SAVE_START
      ? `at least ${condition.minimum} rocket${condition.minimum === 1 ? '' : 's'} launched in this save`
      : `${condition.minimum} rocket${condition.minimum === 1 ? '' : 's'} launched from now on`
    case 'items_produced': return condition.count_from === GOAL_COUNT_FROM.SAVE_START
      ? `at least ${condition.minimum} × ${condition.item_name} produced in this save (all surfaces)`
      : `${condition.minimum} × ${condition.item_name} produced from now on (all surfaces)`
    case 'inventory_count': return `AIRI holds at least ${condition.minimum} × ${condition.item_name}`
    case 'space_location_unlocked': return `space location "${condition.name}" is unlocked`
    default: return 'unknown condition'
  }
}

// Evaluates every condition through the game. `command` sends one RCON
// command and resolves to its printed text. An unreadable or failed check is
// "not satisfied": the goal only completes on positive evidence.
//
// A goal_start counter is judged as current - baseline >= minimum. A counter
// with no baseline yet is unsatisfied; its current reading is returned in
// `baselines` for the caller to record.
export async function evaluateGoalDefinition(definition, command) {
  const results = []
  const baselines = {}
  for (const condition of definition?.done_when ?? []) {
    let observation
    try { observation = JSON.parse(String(await command(goalConditionCommand(condition))).trim()) }
    catch (error) { observation = { ok: false, error: error instanceof Error ? error.message : String(error) } }
    const ok = observation?.ok === true
    const current = Number.isFinite(observation?.current) ? observation.current : undefined
    const result = {
      id: condition.id,
      kind: condition.kind,
      satisfied: ok && observation.satisfied === true,
      current,
      error: ok ? undefined : String(observation?.error ?? 'unreadable_condition').slice(0, 120),
    }
    if (GOAL_COUNTER_KINDS.includes(condition.kind) && condition.count_from !== GOAL_COUNT_FROM.SAVE_START) {
      if (Number.isSafeInteger(condition.baseline)) {
        result.baseline = condition.baseline
        result.satisfied = ok && Number.isSafeInteger(current) && current - condition.baseline >= condition.minimum
      }
      else {
        result.satisfied = false
        result.needs_baseline = true
        if (ok && Number.isSafeInteger(current) && current >= 0) baselines[condition.id] = current
      }
    }
    results.push(result)
  }
  return {
    satisfied: results.length > 0 && results.every(result => result.satisfied),
    results,
    baselines,
  }
}

// In-game, player-facing statement of what the system understood. Factorio
// chat renders [color] rich text; each line is printed separately.
export function formatGoalUnderstanding(definition, { objective = '', roadmap = [] } = {}) {
  if (!definition) return []
  const lines = [
    `[color=0.4,0.8,1]Goal understood:[/color] ${definition.summary}`,
  ]
  if (objective && objective.trim() !== definition.summary) lines.push(`  Your words: "${objective.trim().slice(0, 200)}"`)
  lines.push(`  Scope: ${definition.scope === GOAL_SCOPE.LONG_HORIZON ? 'long-horizon — planned in rolling slices' : 'finite — one plan'}`)
  lines.push('  Done when (checked by the game):')
  for (const condition of definition.done_when) lines.push(`    • ${describeGoalCondition(condition)}`)
  const nodes = (Array.isArray(roadmap) ? roadmap : []).slice(0, 8).map(node => node?.intent).filter(Boolean)
  if (nodes.length > 0) lines.push(`  Roadmap: ${nodes.map(intent => String(intent).slice(0, 60)).join(' → ')}`)
  return lines
}

// One unmet condition for the planner. A goal_start counter reports progress
// since the goal began, not the save total, so the numbers match doneWhen.
export function describeUnmetGoalResult(result) {
  if (result.needs_baseline) return `${result.id} (starting count not read yet)`
  if (result.current === undefined) return result.id
  if (Number.isSafeInteger(result.baseline)) return `${result.id} (currently ${result.current - result.baseline} since the goal started)`
  return `${result.id} (currently ${result.current})`
}

// One in-game line after a verified slice whose goal is still open, so the
// player sees long-goal progress without asking. Undefined once the goal is
// met: the completion message covers that.
export function formatSliceProgressNote(evaluation) {
  if (!evaluation || evaluation.satisfied || !Array.isArray(evaluation.results) || evaluation.results.length === 0) return undefined
  const unmet = evaluation.results.filter(result => !result.satisfied).map(describeUnmetGoalResult)
  return `Slice done. Goal: ${formatGoalProgress(evaluation)}; still to do: ${unmet.join(', ')}. Planning the next slice.`
}

export function formatGoalProgress(evaluation) {
  const met = evaluation.results.filter(result => result.satisfied).length
  return `${met}/${evaluation.results.length} goal conditions met`
}

function conditionProgress(condition, result) {
  if (!result) return 'not read'
  if (result.error) return `could not read (${result.error})`
  if (result.needs_baseline) return 'starting count not read yet'
  if (condition.kind === 'research_completed' || condition.kind === 'space_location_unlocked') return result.satisfied ? 'done' : 'not yet'
  if (!Number.isFinite(result.current)) return result.satisfied ? 'done' : 'not yet'
  const counted = Number.isSafeInteger(result.baseline) ? result.current - result.baseline : result.current
  return `${Math.min(counted, condition.minimum)}/${condition.minimum}`
}

const STATUS_STEP_MAX_CHARS = 120

// The deterministic answer to "!airi status": no model call, read from durable
// planning state and, for the done-when checks, the game as of now.
export function formatGoalStatus({ goal, tracker, legacyStatus, evaluation } = {}) {
  if (!goal) return ['No goal yet. Tell me what to do with !airi <goal>.']
  const summary = goal.definition?.summary || goal.objective || 'unnamed goal'
  if (goal.status === 'completed') return [`Last goal completed: ${summary}`]
  if (goal.status === 'cancelled') return [`Last goal was cancelled: ${summary}`]
  const state = legacyStatus === 'paused'
    ? 'paused'
    : tracker?.blocker ? 'blocked' : 'in progress'
  const lines = [`[color=0.4,0.8,1]Goal:[/color] ${summary} — ${state}`]
  const conditions = goal.definition?.done_when ?? []
  if (conditions.length > 0) {
    lines.push(evaluation ? '  Done when (read from the game now):' : '  Done when (the game could not be read just now):')
    for (const condition of conditions) {
      const result = evaluation?.results?.find(entry => entry.id === condition.id)
      lines.push(`    ${result?.satisfied ? '✓' : '○'} ${describeGoalCondition(condition)} — ${conditionProgress(condition, result)}`)
    }
  }
  const steps = Array.isArray(tracker?.steps) ? tracker.steps : []
  if (steps.length > 0) {
    const verified = steps.filter(step => step.status === 'completed').length
    const index = Number.isSafeInteger(tracker.active_step_index) ? tracker.active_step_index : 0
    const current = steps[index]
    lines.push(`  This slice: ${verified}/${steps.length} steps verified${current && current.status !== 'completed' ? `; now: ${String(current.description ?? '').slice(0, STATUS_STEP_MAX_CHARS)}` : ''}`)
  }
  const nodes = (Array.isArray(tracker?.roadmap_shelf) ? tracker.roadmap_shelf : []).filter(node => node.status !== 'invalidated')
  if (nodes.length > 0) {
    const realized = nodes.filter(node => node.status === 'realized').length
    const next = nodes.find(node => node.status !== 'realized')
    lines.push(`  Roadmap: ${realized}/${nodes.length} milestones realized${next ? `; next: ${String(next.intent ?? '').slice(0, STATUS_STEP_MAX_CHARS)}` : ''}`)
  }
  if (tracker?.blocker) lines.push(`  Blocked: ${String(tracker.blocker.detail || tracker.blocker.reason_code || 'waiting for your decision').slice(0, STATUS_STEP_MAX_CHARS)}`)
  if (state === 'paused') lines.push('  Say continue to resume.')
  return lines
}
