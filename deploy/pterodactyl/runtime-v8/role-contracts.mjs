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
      || Object.keys(entry).some(key => !['approach', 'rationale', 'constraints', 'skillIds', 'materialSupply'].includes(key))) throw new Error('Invalid executionGuidance entry')
    if (!Array.isArray(entry.constraints) || entry.constraints.length > 3
      || !Array.isArray(entry.skillIds) || entry.skillIds.length > 3) throw new Error('A brief permits at most three constraints and three skills')
    return {
      approach: text(entry.approach, 200),
      rationale: text(entry.rationale, 240),
      constraints: entry.constraints.map(item => text(item, 100)),
      skillIds: [...new Set(entry.skillIds.map(item => text(item, 120)))],
      ...(entry.materialSupply !== undefined ? { materialSupply: normalizeMaterialSupply(entry.materialSupply) } : {}),
    }
  })
}

function normalizeMaterialSupply(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'resource'].includes(key))
    || !['direct_feed', 'manual_bootstrap'].includes(value.mode)
    || typeof value.resource !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.resource)) throw new Error('Invalid materialSupply choice')
  return { mode: value.mode, resource: value.resource }
}

// A selected library is knowledge, not a layout mandate. Only the planner's
// explicit per-step supply choice constrains manual delivery of that resource.
export function manualSupplyDrift(guidance, operations, exactEntity = () => undefined) {
  const supply = guidance?.materialSupply
  if (supply?.mode !== 'direct_feed') return []
  return operations.filter(op => (['gather_resource', 'mine_resource_at'].includes(op.name) && op.args?.resource_name === supply.resource)
    || (op.name === 'harvest_product' && op.args?.product_name === supply.resource)
    || (op.name === 'mine_entity' && op.args?.entity_name === supply.resource)
    || (op.name === 'mine_entity_exact' && exactEntity(op.args?.unit_number)?.name === supply.resource)
    || (op.name === 'supply_entity' && op.args?.items?.some(item => item.item_name === supply.resource))
    || (['move_items', 'move_items_exact'].includes(op.name) && op.args?.to_entity === true && op.args?.item_name === supply.resource)
    || (op.name === 'move_items_with_player' && op.args?.to_player === false && op.args?.item_name === supply.resource))
}

// Protocol 1/2 retain their original instructions. Replace only known harness
// instructions, never observations, user text, receipts or arbitrary BLOCKED claims.
export function executionOnlyPrompt(value) {
  return value
    .replace('If the active step cannot be completed, say so with an explicit BLOCKED reason and do not improvise a different plan; the harness decides what happens next.', 'If the active approach cannot be completed, request plannerReview with the active stepId and operations:[]; do not improvise another strategy.')
    .replace('If genuinely blocked, start chatMessage with "BLOCKED: " and state the exact blocker.', 'If the approach is infeasible or local recovery is exhausted, return plannerReview with its reason and rationale, the active stepId and operations:[]. Missing observations are not proof of a world blocker.')
    .replace('Use chatMessage, stepId and operations, plus the applicable checkpoint, semanticCompletion or timeReview.', 'Use chatMessage, stepId and operations, plus the applicable checkpoint, semanticCompletion, timeReview or plannerReview.')
    .replace('the "BLOCKED: " contract is unchanged.', 'the protocol 3 plannerReview contract applies to executor difficulties.')
    .replace(/start chatMessage with "BLOCKED: " followed by the exact (?:still-)?missing fact or (?:truthful )?blocker\./g, 'return plannerReview:{reason:"local_recovery_exhausted",rationale:"<remaining difficulty>"}, the active stepId and operations:[]. This is advisory, not world evidence or replacement authority.')
    .replace('start chatMessage with BLOCKED: and name the exact missing fact/truthful blocker', 'return plannerReview with the active stepId and empty operations; missing facts are not world-blocker evidence')
    .replace('state BLOCKED: and explain it', 'return plannerReview with its reason and rationale, the active stepId and operations:[]')
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

// The parts of a reply that keep a plannerReview from being a review, named so
// a refusal says which one to drop.
export function plannerReviewConflicts(raw, protocolVersion, role) {
  const conflicts = []
  if (protocolVersion < 3) conflicts.push(`completion protocol ${protocolVersion}`)
  if (role !== 'executor') conflicts.push(`role ${role}`)
  if (raw.operations?.length !== 0) conflicts.push(Array.isArray(raw.operations) ? `${raw.operations.length} operations` : 'no operations array')
  if (raw.semanticCompletion) conflicts.push('semanticCompletion')
  if (raw.checkpoint) conflicts.push('checkpoint')
  if (!raw.stepId) conflicts.push('no stepId')
  return conflicts
}

export const PLANNING_ONLY_PROMPT = [
  '[ROLE: PLANNER] Choose the approach, dependencies, build order, quantities and worthwhile investments for a bounded slice. Compare relevant loaded skills and deterministic recipe/rate/cost facts. Explain optional investments as possible time savings with setup costs; they are not mandatory layouts.',
  'You do not submit gameplay actions. In submitPlan or assistant JSON always use operations: []. For a new execution slice use currentStep:0, aligned stepCompletions (first checkpoint now; later deterministic checkpoints bind when active), and executionGuidance aligned with plan: {approach,rationale,constraints,skillIds,materialSupply}. Reference only skills whose details you have loaded. For a resource-supply step select materialSupply:{mode:"direct_feed"|"manual_bootstrap",resource:"<native resource name>"}; use null for other work. Selecting a skill alone does not select its method. If selecting direct-miner-smelting, explicitly choose the method: compare remaining work, held machines, setup, travel, manual mining and hand-supply time using live facts. Reusing a held miner/furnace can still mean direct feeding; it does not mean manual smelting. Dedicated additional cells remain optional time savings. Explain why a manual bootstrap pays back sooner when choosing it. Keep the first slice actionable from known facts; the executor reads fresh geometry and inventory and chooses approved operations.',
  'The executor owns local execution and bounded repair within the committed meaning. You own strategic review and new drafts. A committed plan stays immutable; replacement needs the existing harness authority and evidence gates. A review request alone is not world evidence or permission. Assessment-only plans may use semantic steps, assessmentOnly:true and no executionGuidance.',
].join('\n')

export const EXECUTION_ONLY_PROMPT = '[EXECUTION BRIEF] Follow the active step execution_guidance and only its selected skills. materialSupply selects the resource method: direct_feed means deploy/validate the miner output into a compatible furnace, then fuel the machines separately; do not substitute hand mining or hand-delivery of that resource. Manual startup fuel is distinct from manual ore supply. manual_bootstrap explicitly permits manual supply for this bounded step. A selected skill is not permission to add dedicated cells: those remain optional time-saving investments for the planner. Resolve fresh geometry, inventory, exact targets and operation arguments yourself. Missing geometry calls for bounded relevant observations, not an automatic switch to manual production. Do not switch production strategies or add investments outside the committed meaning. If infeasible, outside scope or local recovery is exhausted, submit plannerReview:{reason:"approach_infeasible"|"scope_change"|"local_recovery_exhausted",rationale:"..."}, the active stepId and operations:[]. Use this in submitPlan or closed-round assistant JSON instead of legacy BLOCKED prose. This requests review only; it does not authorize a replacement or establish a world blocker. The harness may pause when evidence or authority is missing.'
