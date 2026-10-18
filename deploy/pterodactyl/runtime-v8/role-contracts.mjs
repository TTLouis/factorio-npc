// Protocol 3 separates strategy from actions. These records are advisory:
// completion, permissions, exact entity identity and budgets remain harness-owned.
import { sanitizeDurableModelText } from './durable-text.mjs'

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected non-empty text up to ${max} characters`)
  return sanitizeDurableModelText(value, max).trim()
}

export function normalizeExecutionGuidance(value, stepCount) {
  if (!Array.isArray(value) || value.length !== stepCount) throw new Error('executionGuidance must have one brief per plan step')
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['approach', 'rationale', 'constraints', 'skillIds'].includes(key))) throw new Error('Invalid executionGuidance entry')
    if (!Array.isArray(entry.constraints) || entry.constraints.length > 3
      || !Array.isArray(entry.skillIds) || entry.skillIds.length > 3) throw new Error('A brief permits at most three constraints and three skills')
    return {
      approach: text(entry.approach, 200),
      rationale: text(entry.rationale, 240),
      constraints: entry.constraints.map(item => text(item, 100)),
      skillIds: [...new Set(entry.skillIds.map(item => text(item, 120)))],
    }
  })
}

export function storedExecutionGuidance(value) {
  if (value === undefined) return undefined
  try { return normalizeExecutionGuidance([value], 1)[0] }
  catch { return undefined }
}

export function normalizePlannerReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['reason', 'rationale'].includes(key))
    || !['approach_infeasible', 'scope_change', 'local_recovery_exhausted'].includes(value.reason)) throw new Error('Invalid plannerReview reason')
  return { reason: value.reason, rationale: text(value.rationale, 400) }
}

export const PLANNING_ONLY_PROMPT = [
  '[ROLE: PLANNER] Choose the approach, dependencies, build order, quantities and worthwhile investments for a bounded slice. Compare relevant loaded skills and deterministic recipe/rate/cost facts. Explain optional investments as possible time savings with setup costs; they are not mandatory layouts.',
  'You do not submit gameplay actions. In submitPlan or assistant JSON always use operations: []. For a new execution slice use currentStep:0, aligned stepCompletions (first checkpoint now; later deterministic checkpoints bind when active), and executionGuidance aligned with plan: {approach,rationale,constraints,skillIds}. Reference only skills whose details you have loaded. Keep the first slice actionable from known facts; the executor reads fresh geometry and inventory and chooses approved operations.',
  'The executor owns local execution and bounded repair within the committed meaning. You own strategic review and new drafts. A committed plan stays immutable; replacement needs the existing harness authority and evidence gates. A review request alone is not world evidence or permission. Assessment-only plans may use semantic steps, assessmentOnly:true and no executionGuidance.',
].join('\n')

export const EXECUTION_ONLY_PROMPT = '[EXECUTION BRIEF] Follow the active step execution_guidance and only its selected skills. Resolve fresh geometry, inventory, exact targets and operation arguments yourself. Do not switch production strategies or add investments outside the committed meaning. If infeasible, outside scope or local recovery is exhausted, submit plannerReview:{reason:"approach_infeasible"|"scope_change"|"local_recovery_exhausted",rationale:"..."}, the active stepId and operations:[]. This requests review only; it does not authorize a replacement or establish a world blocker. The harness may pause when evidence or authority is missing.'
