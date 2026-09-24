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

function sanitizeCondition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_goal_condition', 'each goal.doneWhen entry must be an object')
  const kind = raw.kind
  if (!GOAL_CONDITION_KINDS.includes(kind)) {
    fail('invalid_goal_condition', `goal.doneWhen kind must be one of ${GOAL_CONDITION_KINDS.join(', ')}`)
  }
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(raw.id) ? raw.id : `done_${index + 1}`
  if (kind === 'research_completed') return { id, kind, technology: prototypeName(raw.technology, 'technology', kind) }
  if (kind === 'rockets_launched') return { id, kind, minimum: minimum(raw.minimum, kind) }
  if (kind === 'space_location_unlocked') return { id, kind, name: prototypeName(raw.name, 'name', kind) }
  return { id, kind, item_name: prototypeName(raw.item_name, 'item_name', kind), minimum: minimum(raw.minimum, kind) }
}

// Validates the planner-authored `goal` object from submitPlan. Throws a
// GoalDefinitionError whose message is written for the model to correct.
export function sanitizeGoalDefinition(raw) {
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
  const doneWhen = rawConditions.map(sanitizeCondition)
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
    const definition = sanitizeGoalDefinition(raw)
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
  const { id: _id, ...request } = condition
  return request
}

export function goalConditionCommand(condition) {
  const request = goalConditionRequest(condition)
  return `/silent-command local request=helpers.json_to_table(${luaString(JSON.stringify(request))}); rcon.print(helpers.table_to_json(remote.call("autorio_tools","evaluate_condition",request)))`
}

export function describeGoalCondition(condition) {
  switch (condition?.kind) {
    case 'research_completed': return `research "${condition.technology}" is completed`
    case 'rockets_launched': return `at least ${condition.minimum} rocket${condition.minimum === 1 ? '' : 's'} launched`
    case 'items_produced': return `at least ${condition.minimum} × ${condition.item_name} produced (all surfaces)`
    case 'inventory_count': return `AIRI holds at least ${condition.minimum} × ${condition.item_name}`
    case 'space_location_unlocked': return `space location "${condition.name}" is unlocked`
    default: return 'unknown condition'
  }
}

// Evaluates every condition through the game. `command` sends one RCON
// command and resolves to its printed text. An unreadable or failed check is
// "not satisfied": the goal only completes on positive evidence.
export async function evaluateGoalDefinition(definition, command) {
  const results = []
  for (const condition of definition?.done_when ?? []) {
    let observation
    try { observation = JSON.parse(String(await command(goalConditionCommand(condition))).trim()) }
    catch (error) { observation = { ok: false, error: error instanceof Error ? error.message : String(error) } }
    results.push({
      id: condition.id,
      kind: condition.kind,
      satisfied: observation?.ok === true && observation.satisfied === true,
      current: Number.isFinite(observation?.current) ? observation.current : undefined,
      error: observation?.ok === true ? undefined : String(observation?.error ?? 'unreadable_condition').slice(0, 120),
    })
  }
  return {
    satisfied: results.length > 0 && results.every(result => result.satisfied),
    results,
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

export function formatGoalProgress(evaluation) {
  const met = evaluation.results.filter(result => result.satisfied).length
  return `${met}/${evaluation.results.length} goal conditions met`
}
