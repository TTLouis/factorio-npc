// Pursuit-mode supervisor: owns goal intake, budgets, the no-progress stop and
// native acceptance. The operator never declares success; only a satisfied
// native goal evaluation (no model calls during it) ends the goal as accepted.
// No committed plan, no step contracts; factory cells stay an optional tool.
import { describeUnmetGoalResult, evaluateGoalDefinition, sanitizeGoalDefinition } from './goal-definition.mjs'
import { createOperatorState, runOperatorLoop } from './operator-loop.mjs'

export const GOAL_MODES = Object.freeze(['plan', 'pursuit'])

export const PURSUIT_DEFAULTS = Object.freeze({
  // Native goal check cadence and the no-progress rule, counted in admitted
  // submits so waits and observations cost nothing.
  progressCheckEverySubmits: 10,
  noProgressChecks: 4,
  maxConsecutiveRefusedSubmits: 12,
  // An operator reply without tool calls asks for acceptance; it is checked
  // natively, and an unaccepted yield is answered with the unmet conditions.
  maxUnacceptedYields: 3,
})

// First pursuit comparison (owner 2026-11-04): red science to unlock
// automation. Research completion plus a sustained native production rate.
// Native production_rate voids windows containing hand crafting, mining or
// input feeding. It does not establish the stronger automated_starter_base
// contract (power/fuel supply and replenished construction stocks).
export const RED_SCIENCE_AUTOMATION_GOAL = Object.freeze({
  scope: 'long_horizon',
  summary: 'Make red science automatically and research automation.',
  doneWhen: [
    { id: 'automation_researched', kind: 'research_completed', technology: 'automation' },
    { id: 'red_science_rate', kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 1, window_minutes: 10 },
  ],
})

export function createPursuitState() {
  return { ...createOperatorState(), pursuit: { schema: 1, evaluations: 0, stale_checks: 0, refused_streak: 0, yields: 0, submits_at_check: 0, progress: null, progressed_operations: [], progressed_at_check: 0, outcome: null } }
}

function progressSignature(evaluation) {
  return JSON.stringify(evaluation.results.map(result => [result.id, result.satisfied, result.current ?? null]))
}

function unmetSummary(evaluation) {
  const unmet = evaluation.results.filter(result => !result.satisfied).map(describeUnmetGoalResult)
  return unmet.length ? unmet.join('; ') : 'none reported'
}

/**
 * Pursue one goal. `command(text)` sends one RCON command and resolves its
 * printed output (used only for native goal evaluation). `saveState` must
 * persist `state` durably; it is called before each model request.
 */
export async function runPursuitGoal({ goal = RED_SCIENCE_AUTOMATION_GOAL, command, complete, tools, notebook, brief, state = createPursuitState(), options = {}, signal, onEvent = () => {}, saveState = async () => {}, evaluate = evaluateGoalDefinition }) {
  if (typeof command !== 'function' || !state?.pursuit || state.pursuit.schema !== 1) throw new TypeError('invalid pursuit configuration')
  const definition = sanitizeGoalDefinition(goal)
  const limits = { ...PURSUIT_DEFAULTS, ...options }
  const p = state.pursuit
  const finish = async (outcome, detail = {}) => {
    p.outcome = outcome
    await saveState(state)
    onEvent({ type: 'pursuit_finished', outcome, ...detail })
    return { outcome, state, ...detail }
  }
  if (p.outcome) return { outcome: p.outcome, state }

  const evaluateNow = async samples => {
    const evaluation = await evaluate(definition, command, samples === 1 ? { samples: 1 } : {})
    p.evaluations++
    onEvent({ type: 'goal_evaluated', satisfied: evaluation.satisfied, unmet: unmetSummary(evaluation), evaluation })
    return evaluation
  }

  const afterResponse = async ({ outcomes }) => {
    for (const { tool, result } of outcomes) {
      if (tool === 'factorio_submit') p.refused_streak = result.isError ? p.refused_streak + 1 : 0
      if (!['factorio_submit', 'factorio_receipt', 'factorio_resume'].includes(tool) || result.isError) continue
      // Construction changes no final goal condition, so completed native work
      // also counts as progress: a terminal, completed, effect-happened receipt,
      // each operation once, whichever tool reported it. Waits, admissions and
      // model claims are not progress. Budgets still bound busy-but-useless work.
      const receipt = result.structuredContent
      if (receipt?.terminal === true && receipt.state === 'completed' && receipt.effect === 'happened'
        && receipt.operation?.name !== 'wait' && typeof receipt.operation_id === 'string'
        && !p.progressed_operations.includes(receipt.operation_id)) p.progressed_operations.push(receipt.operation_id)
    }
    if (p.refused_streak >= limits.maxConsecutiveRefusedSubmits) return 'refused_submit_streak'
    if (state.submits - p.submits_at_check < limits.progressCheckEverySubmits) return undefined
    p.submits_at_check = state.submits
    const evaluation = await evaluateNow(1)
    if (evaluation.satisfied) return 'acceptance_candidate'
    const signature = progressSignature(evaluation)
    const progressed = p.progressed_operations.length
    p.stale_checks = signature === p.progress && progressed === p.progressed_at_check ? p.stale_checks + 1 : 0
    p.progress = signature
    p.progressed_at_check = progressed
    return p.stale_checks >= limits.noProgressChecks ? 'no_progress' : undefined
  }

  let note
  for (;;) {
    const run = await runOperatorLoop({ complete, tools, notebook, brief, state, options: limits.loop, signal, onEvent, saveState, afterResponse, seedNote: note })
    if (run.stop === 'aborted') { await saveState(state); return { outcome: 'aborted', state } }
    if (['request_budget_exhausted', 'tool_call_budget_exhausted', 'token_budget_exhausted', 'provider_error', 'refused_submit_streak', 'no_progress'].includes(run.stop)) {
      return finish(run.stop === 'provider_error' ? 'paused_provider_error' : `paused_${run.stop}`)
    }
    // operator_yield or acceptance_candidate: judge natively with full sampling.
    const evaluation = await evaluateNow()
    if (evaluation.satisfied) return finish('accepted', { evaluation })
    if (run.stop === 'operator_yield') {
      p.yields++
      if (p.yields >= limits.maxUnacceptedYields) return finish('paused_operator_yielded_unaccepted', { evaluation })
    }
    // A new conversation, so the reply is answered with native facts only.
    state.rotations++
    note = `The goal is not accepted yet. Native evaluation reports unmet: ${unmetSummary(evaluation)}. Continue the goal; the harness decides acceptance.`
  }
}
