// Verified-results message for the planner at a slice close (delegation plan
// U7, design note section 12c).
//
// When a committed slice closes and the planner wakes, it does not receive the
// slice's raw operation and tool traffic. It receives ONE harness-built
// message with what the harness verified:
//   - the closed plan's steps with their accepted evidence refs and the
//     receipts the reducer's ledger holds for each step;
//   - goal progress per doneWhen condition, as the game reported it at this
//     slice close (an explicit runtime reading passed in, not a reducer field);
//   - estimated versus measured time per step (harness estimate from game
//     rates versus wall clock; explicit runtime records passed in), and the
//     NPC time split of the slice (actor busy, model thinking, idle).
//
// Pure. Reads reducer state and the explicit records only. It never reads the
// legacy task board, the message history or any model output, and it never says
// the goal is done: goal completion still goes through evaluateGoalCompletion.
//
// The text is one paragraph (the loop's durable-text cleaner folds newlines);
// records are separated by ` || `. Whole records only: over the limit the
// optional records (receipts, evidence refs, per-step time) drop in a fixed
// order, then step and doneWhen lines collapse into a "...N more" line, so
// maxChars is a hard cap. Model-authored text cannot carry the separator or a
// bracketed harness marker.

import { sanitizeDurableModelText } from './durable-text.mjs'
import { goalUiView } from './goal-definition.mjs'
import { getActivePlan } from './planning-state.mjs'
import { formatDuration, sliceTimeSplitText } from './plan-time-estimate.mjs'

export const VERIFIED_RESULTS_LIMITS = Object.freeze({
  maxChars: 3600,
  evidenceRefsPerStep: 4,
  receiptsPerStep: 2,
  stepChars: 140,
  refChars: 120,
  summaryChars: 160,
  conditionChars: 200,
})

// First entry drops first; anything not listed is mandatory (header, plan line,
// step lines, goal progress lines).
export const VERIFIED_RESULTS_DROP_ORDER = Object.freeze(['receipt', 'evidence', 'time_step', 'time_split'])

export const VERIFIED_RESULTS_HEADER = '[VERIFIED_RESULTS] Built by the harness from the reducer ledger and the game, not from the conversation. It is evidence for this plan slice only: the game decides the goal from doneWhen at every slice close, and this message never claims the goal is done.'

// Model-authored text (step descriptions, receipt summaries, condition text)
// must not be able to imitate a harness record: the record separator and the
// bracketed harness markers ([MOD], [VERIFIED_RESULTS], ...) are neutralized.
// Unit numbers are redacted by the durable-text sanitizer.
function clip(value, max) {
  return sanitizeDurableModelText(value, max)
    .replace(/\|{2,}/g, '|')
    .replace(/\[([A-Za-z][A-Za-z0-9_]{2,})\]/g, '($1)')
}

function seconds(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function timeText(entry) {
  if (!entry) return 'time not recorded'
  const expected = seconds(entry.expected_seconds)
  const machine = seconds(entry.machine_wait_seconds)
  const measured = seconds(entry.elapsed_wall_seconds)
  const estimate = expected === undefined
    ? 'no game-rate estimate'
    : `estimated ${formatDuration(expected + (machine ?? 0))}`
  return `${estimate}, ${measured === undefined ? 'not measured' : `measured ${formatDuration(measured)}`}`
}

function planTimeLine(stepTimes, planSteps) {
  const known = stepTimes.filter(Boolean)
  const estimated = known.filter(entry => seconds(entry.expected_seconds) !== undefined)
  const measured = known.filter(entry => seconds(entry.elapsed_wall_seconds) !== undefined)
  const estimatedTotal = estimated.reduce((total, entry) => total + entry.expected_seconds + (seconds(entry.machine_wait_seconds) ?? 0), 0)
  const measuredTotal = measured.reduce((total, entry) => total + entry.elapsed_wall_seconds, 0)
  return `time: estimated ${estimated.length > 0 ? formatDuration(estimatedTotal) : 'unknown'} over ${estimated.length}/${planSteps} steps with a game-rate estimate; measured ${measured.length > 0 ? formatDuration(measuredTotal) : 'unknown'} over ${measured.length}/${planSteps} steps (wall clock, walking and placement included)`
}

/**
 * @param {object} args
 * @param {object} args.planningState reducer state; the closed plan is its active plan
 * @param {object} [args.goalEvaluation] the game's reading of the doneWhen conditions at this slice close ({satisfied, results})
 * @param {Array<{step_id:string, expected_seconds?:number, machine_wait_seconds?:number, elapsed_wall_seconds?:number}>} [args.stepTimes] runtime time records of the closed plan's steps
 * @param {object} [args.timeSplit] the NPC time split of this slice (PlanTiming.sliceTimeSplit); the line is omitted without one
 * @param {object} [args.limits] overrides for VERIFIED_RESULTS_LIMITS
 * @returns {{ text: string, chars: number, dropped: string[], over_limit: boolean, plan_id: string|undefined }}
 */
export function buildVerifiedResults({ planningState, goalEvaluation, stepTimes = [], timeSplit, limits: limitOverrides } = {}) {
  const limits = { ...VERIFIED_RESULTS_LIMITS, ...limitOverrides }
  const plan = getActivePlan(planningState)
  const times = Array.isArray(stepTimes) ? stepTimes : []
  const records = [{ key: 'header', text: VERIFIED_RESULTS_HEADER }]

  if (plan) {
    const verified = plan.steps.filter(step => plan.execution?.step_progress?.[step.step_id]?.status === 'completed').length
    records.push({ key: 'plan', text: `plan ${plan.plan_id} v${plan.plan_version} is ${plan.status}; ${verified}/${plan.steps.length} steps verified by the harness` })
    const timesByStep = new Map(times.map(entry => [entry?.step_id, entry]))
    plan.steps.forEach((step, index) => {
      const progress = plan.execution?.step_progress?.[step.step_id]
      records.push({ key: `step_${index}`, text: `step ${index + 1} ${step.step_id} ${progress?.status ?? 'pending'}: ${clip(step.description, limits.stepChars)}` })
      const refs = (Array.isArray(progress?.accepted_evidence) ? progress.accepted_evidence : []).slice(-limits.evidenceRefsPerStep)
      if (refs.length > 0) {
        records.push({ key: `evidence_${index}`, drop: 'evidence', rank: plan.steps.length - index, text: `step ${index + 1} evidence refs: ${refs.map(item => clip(item.ref, limits.refChars)).join(', ')}` })
      }
      const held = plan.execution?.receipts?.[step.step_id]
      const receipts = (Array.isArray(held) ? held : []).slice(-limits.receiptsPerStep)
      receipts.forEach((entry, receiptIndex) => {
        records.push({
          key: `receipt_${index}_${receiptIndex}`,
          drop: 'receipt',
          rank: (plan.steps.length - index) * 100 + (receipts.length - receiptIndex),
          text: `step ${index + 1} receipt ${clip(entry.kind, 64)} ${clip(entry.ref, limits.refChars)}: ${clip(entry.summary, limits.summaryChars)}`,
        })
      })
      const timing = timesByStep.get(step.step_id)
      if (timing) records.push({ key: `time_step_${index}`, drop: 'time_step', rank: plan.steps.length - index, text: `step ${index + 1} time: ${timeText(timing)}` })
    })
  }
  else {
    records.push({ key: 'plan', text: 'no plan is recorded for this slice' })
  }

  // Goal progress per doneWhen condition, as the game reported it.
  const view = goalUiView(planningState?.goal, goalEvaluation)
  if (view && view.checks.length > 0) {
    records.push({
      key: 'goal_progress',
      text: `goal progress (${view.read ? 'read from the game at this slice close' : 'the game could not be read just now'}): ${view.met}/${view.total} doneWhen conditions met`,
    })
    view.checks.forEach((check, index) => {
      records.push({ key: `done_${index}`, text: `doneWhen ${check.met ? 'met' : 'unmet'}: ${clip(check.text, limits.conditionChars)} - ${clip(check.progress, 80)}` })
    })
  }
  else {
    records.push({ key: 'goal_progress', text: 'goal progress: no doneWhen conditions are defined for this goal' })
  }
  if (plan) records.push({ key: 'time', text: planTimeLine(times, plan.steps.length) })
  const splitText = sliceTimeSplitText(timeSplit)
  if (splitText) records.push({ key: 'time_split', drop: 'time_split', text: splitText })

  const render = list => list.map(record => record.text).join(' || ')
  const dropped = []
  let kept = records
  const droppable = kept
    .filter(record => record.drop)
    .sort((left, right) => (VERIFIED_RESULTS_DROP_ORDER.indexOf(left.drop) - VERIFIED_RESULTS_DROP_ORDER.indexOf(right.drop))
      || ((right.rank ?? 0) - (left.rank ?? 0))
      || left.key.localeCompare(right.key))
  let text = render(kept)
  for (const record of droppable) {
    if (text.length <= limits.maxChars) break
    kept = kept.filter(item => item !== record)
    dropped.push(record.key)
    text = render(kept)
  }
  // Still over: the step lines and doneWhen lines are capped too. From the last
  // one back, they collapse into one "...N more" line, so the limit is a hard
  // cap (header, plan line, goal progress and time lines are bounded by
  // construction). Whole lines only.
  for (const { prefix, label } of [{ prefix: 'step_', label: 'steps' }, { prefix: 'done_', label: 'doneWhen conditions' }]) {
    const lines = kept.filter(record => record.key.startsWith(prefix))
    let collapsed = 0
    while (text.length > limits.maxChars && collapsed < lines.length) {
      const victim = lines[lines.length - 1 - collapsed]
      kept = kept.filter(item => item !== victim && item.key !== `${prefix}more`)
      collapsed += 1
      dropped.push(victim.key)
      const summary = { key: `${prefix}more`, text: `... ${collapsed} more ${label} not shown (bounded message)` }
      const lastKept = kept.map(item => item.key.startsWith(prefix)).lastIndexOf(true)
      kept = lastKept >= 0 ? [...kept.slice(0, lastKept + 1), summary, ...kept.slice(lastKept + 1)] : [...kept, summary]
      text = render(kept)
    }
  }
  return { text, chars: text.length, dropped, over_limit: text.length > limits.maxChars, plan_id: plan?.plan_id }
}
