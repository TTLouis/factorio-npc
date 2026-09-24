// Goal reading: Jev's independent, blind reading of a new user goal.
//
// Jev never sees or reviews the Main LLM's goal definition. It answers closed
// questions about the player's words plus deterministic save-progress facts,
// before the planner runs. The harness then compares the two readings in code
// (`compareGoalReading`). Jev can cause at most one corrective retry per goal,
// and whatever the planner answers after that retry is final.

import { luaString } from '../staging/structured-policy.mjs'
import { GOAL_SCOPE } from './goal-definition.mjs'

// Milestones that tell how far along a save is. Names the running game does
// not know are simply omitted by the mod, so one list serves the base game and
// Space Age.
export const GOAL_PROGRESS_TECHNOLOGIES = Object.freeze([
  'automation',
  'electronics',
  'logistic-science-pack',
  'steel-processing',
  'oil-processing',
  'chemical-science-pack',
  'production-science-pack',
  'utility-science-pack',
  'rocket-silo',
  'space-platform',
  'planet-discovery-vulcanus',
  'planet-discovery-fulgora',
  'planet-discovery-gleba',
  'planet-discovery-aquilo',
])

export const GOAL_FAMILIES = Object.freeze([
  'rocket_launch',
  'research',
  'produce_items',
  'space_travel',
  'build',
  'gather',
  'other',
])

// A Jev label is only acted on above this confidence; below it Jev has no
// opinion and the planner's reading stands.
export const GOAL_READING_MIN_CONFIDENCE = 0.6

// Which done_when kinds can prove each family. Families without an entry are
// not checked (build/gather/other goals are too open to pin to one kind).
const FAMILY_CONDITION_KINDS = Object.freeze({
  rocket_launch: ['rockets_launched'],
  research: ['research_completed'],
  produce_items: ['items_produced', 'inventory_count'],
  space_travel: ['space_location_unlocked'],
})

export function goalProgressFactsCommand(technologies = GOAL_PROGRESS_TECHNOLOGIES) {
  const request = JSON.stringify({ technologies: technologies.slice(0, 16) })
  return `/silent-command local request=helpers.json_to_table(${luaString(request)}); rcon.print(helpers.table_to_json(remote.call("autorio_tools","goal_progress_facts",request)))`
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

// Compact, model-facing save facts. Returns undefined when the mod did not
// answer (older mod, no actor, RCON error) so the question degrades to
// "judge from the words alone".
export function parseGoalProgressFacts(text) {
  let raw
  try { raw = JSON.parse(String(text ?? '').trim()) }
  catch { return undefined }
  if (!raw || typeof raw !== 'object' || raw.ok !== true) return undefined
  const milestones = {}
  // table_to_json renders an empty Lua table as [].
  if (raw.milestones && typeof raw.milestones === 'object' && !Array.isArray(raw.milestones)) {
    for (const name of GOAL_PROGRESS_TECHNOLOGIES) {
      if (typeof raw.milestones[name] === 'boolean') milestones[name] = raw.milestones[name]
    }
  }
  return {
    rockets_launched: count(raw.rockets_launched) ?? 0,
    researched_technologies: count(raw.researched_technologies) ?? 0,
    enabled_technologies: count(raw.enabled_technologies) ?? 0,
    milestones_researched: milestones,
    space_age: raw.space_age === true,
  }
}

export function goalReadingQuestions() {
  return {
    goal_scope: {
      type: 'choice',
      instructions: 'Judge ONLY from the player message and save_progress (what this save has already researched and launched). How much work does it take to finish what the player asked, starting from this save? Ignore current_goal and runtime for this question.',
      criteria: {
        finite: 'One bounded plan of at most about 30 concrete steps finishes it from this save: a small build, gathering or crafting a known amount, one research the save is close to, or a goal the save has nearly reached already.',
        long_horizon: 'Finishing it from this save needs several stages of new capability (new science tiers, oil, a rocket silo, other planets) planned and built over many plans.',
        unclear: 'The message does not say enough to judge, or save_progress is missing and the words alone do not decide it.',
      },
    },
    goal_family: {
      type: 'choice',
      instructions: 'Judge ONLY from the player message. What kind of end state does the player want?',
      criteria: {
        rocket_launch: 'A rocket launched (or sent to space) is the end state.',
        research: 'A specific technology researched is the end state.',
        produce_items: 'Having made or holding some amount of an item is the end state.',
        space_travel: 'Reaching or unlocking another planet or space location is the end state.',
        build: 'A structure or production line existing and working is the end state.',
        gather: 'Collecting raw resources is the end state.',
        other: 'None of these, or the message is not a gameplay goal.',
      },
    },
    goal_measurable: {
      type: 'noul',
      instructions: 'Judge ONLY from the player message. Does it name an end state the game could check (a count, a technology, a launch, a location)?',
      criteria: {
        true: 'The message names a checkable end state.',
        false: 'The message is open-ended or does not name when it is done.',
      },
    },
  }
}

function choiceAnswer(answer, allowed) {
  if (!answer || !allowed.includes(answer.choice)) return undefined
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    ? Math.min(1, Math.max(0, answer.confidence))
    : 0
  return { choice: answer.choice, confidence }
}

// Returns undefined when the response has no usable goal answers; a partial
// answer keeps whatever parsed.
export function parseGoalReading(response) {
  const answers = response?.answers
  if (!answers || typeof answers !== 'object') return undefined
  const scope = choiceAnswer(answers.goal_scope, [GOAL_SCOPE.FINITE, GOAL_SCOPE.LONG_HORIZON, 'unclear'])
  const family = choiceAnswer(answers.goal_family, GOAL_FAMILIES)
  const measurable = answers.goal_measurable?.noul
  if (!scope && !family) return undefined
  return {
    scope: scope?.choice ?? 'unclear',
    scope_confidence: scope?.confidence ?? 0,
    family: family?.choice ?? 'other',
    family_confidence: family?.confidence ?? 0,
    measurable_probability: typeof measurable === 'number' && Number.isFinite(measurable)
      ? Math.min(1, Math.max(0, measurable))
      : undefined,
  }
}

function describeFacts(facts) {
  if (!facts) return ''
  const milestones = Object.entries(facts.milestones_researched ?? {})
  const done = milestones.filter(([, researched]) => researched).map(([name]) => name)
  const parts = [`${facts.researched_technologies}/${facts.enabled_technologies} technologies researched`]
  parts.push(done.length > 0 ? `milestones done: ${done.join(', ')}` : 'no milestone technologies researched yet')
  parts.push(`${facts.rockets_launched} rockets launched`)
  return parts.join('; ')
}

// The harness rule. Jev only counts when it is confident; a disagreement
// becomes one corrective hint for the planner, never a veto.
export function compareGoalReading(reading, definition, { facts } = {}) {
  if (!reading || !definition) return { verdict: 'no_reading', hints: [] }
  const hints = []
  const scopeKnown = reading.scope !== 'unclear' && reading.scope_confidence >= GOAL_READING_MIN_CONFIDENCE
  const scopeMismatch = scopeKnown && reading.scope !== definition.scope
  if (scopeMismatch) {
    const factText = describeFacts(facts)
    hints.push(`An independent reading of the player's words${factText ? ` against this save (${factText})` : ''} classified this goal as ${reading.scope}, but goal.scope is ${definition.scope}.`)
  }
  const expectedKinds = FAMILY_CONDITION_KINDS[reading.family]
  const familyKnown = expectedKinds && reading.family_confidence >= GOAL_READING_MIN_CONFIDENCE
  const familyMismatch = familyKnown
    && !definition.done_when.some(condition => expectedKinds.includes(condition.kind))
  if (familyMismatch) {
    hints.push(`The player's words read as a ${reading.family.replace(/_/g, ' ')} goal, but goal.doneWhen has no ${expectedKinds.join(' or ')} condition, so the game could report "done" without it.`)
  }
  if (hints.length === 0) {
    const agreed = scopeKnown || familyKnown
    return { verdict: agreed ? 'agree' : 'no_opinion', hints }
  }
  return {
    verdict: scopeMismatch && familyMismatch ? 'scope_and_family_mismatch' : scopeMismatch ? 'scope_mismatch' : 'family_mismatch',
    hints,
  }
}

export function goalReadingChallenge(comparison) {
  return `${comparison.hints.join(' ')} Re-check the goal: keep your goal {scope, summary, doneWhen} if you still judge it right, or correct it. Resend the complete submitPlan; this check is asked only once.`
}

// One in-game line when the second reading changed the conversation, so the
// player can see the goal was double-checked. Silent when both agreed.
export function formatGoalReadingNote(trace) {
  if (!trace?.after_challenge) return undefined
  const reread = trace.verdict === 'agree' || trace.verdict === 'no_opinion'
  return reread
    ? '  Double-checked: revised after an independent second reading.'
    : `  Double-checked: an independent reading suggested ${String(trace.jev_scope).replace(/_/g, '-')} / ${String(trace.jev_family).replace(/_/g, ' ')}; the planner kept this definition after re-checking.`
}
