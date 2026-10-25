// Durable identity for ordinary authoring after a verified completed slice.
// A draft is a proposal, never fresh progress or replacement authority.
const phases = new Set(['pending', 'claimed', 'request_owned', 'committed', 'paused'])
const finiteId = value => typeof value === 'string' && value.length > 0 && value.length <= 200

export function stepProgressMark(plan, stepId) {
  const progress = plan.execution?.step_progress?.[stepId]
  const receipts = Array.isArray(plan.execution?.receipts?.[stepId]) ? plan.execution.receipts[stepId] : []
  const lastReceiptSeq = receipts.reduce((max, item) => item.kind === 'deterministic_verification' && item.ref ? Math.max(max, item.seq ?? 0) : max, 0)
  return `${progress?.status ?? 'none'}|${progress?.accepted_evidence?.length ?? 0}|${lastReceiptSeq}`
}

export function completedSliceAnchor(state) {
  if (state?.goal?.status !== 'active' || (!state.goal.definition && !state.roadmap?.nodes?.length)) return undefined
  const plans = state.plans ?? []
  const plan = plans.findLast(candidate => candidate.status === 'COMPLETED')
  const index = plans.indexOf(plan)
  if (!plan || !plan.steps?.length || plans.slice(index + 1).some(candidate => ['COMMITTED', 'EXECUTING', 'BLOCKED'].includes(candidate.status))) return undefined
  const step = plan.steps.at(-1)
  if (plan.steps.some(candidate => plan.execution?.step_progress?.[candidate.step_id]?.status !== 'completed')) return undefined
  return { goal_id: state.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id, progress_mark: stepProgressMark(plan, step.step_id),
    boundary_key: `next_slice|${state.goal.goal_id}|${plan.plan_id}|${plan.plan_version}|${step.step_id}` }
}

export function restoreNextSlice(raw, state) {
  if (!raw || raw.schema !== 1 || !phases.has(raw.phase) || !finiteId(raw.goal_id) || raw.goal_id !== state?.goal?.goal_id) return null
  const plan = state.plans?.find(candidate => candidate.plan_id === raw.plan_id && candidate.plan_version === raw.plan_version)
  const step = plan?.steps?.at(-1)
  if (!plan || plan.status !== 'COMPLETED' || step?.step_id !== raw.step_id
    || plan.steps.some(candidate => plan.execution?.step_progress?.[candidate.step_id]?.status !== 'completed')) return null
  const boundary = `next_slice|${raw.goal_id}|${plan.plan_id}|${plan.plan_version}|${step.step_id}`
  if (raw.boundary_key !== boundary) return null
  const owner = raw.owner && typeof raw.owner === 'object' ? raw.owner : {}
  return { schema: 1, phase: raw.phase, goal_id: raw.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
    step_id: step.step_id, boundary_key: boundary, progress_mark: typeof raw.progress_mark === 'string' && raw.progress_mark.length <= 80 ? raw.progress_mark : stepProgressMark(plan, step.step_id),
    reason: String(raw.reason ?? '').slice(0, 240), failure_class: String(raw.failure_class ?? '').slice(0, 40),
    claimed_attempt: Number.isSafeInteger(raw.claimed_attempt) && raw.claimed_attempt > 0 ? raw.claimed_attempt : 0,
    owner: { request_id: finiteId(owner.request_id) ? owner.request_id : undefined,
      actor_id: Number.isSafeInteger(owner.actor_id) ? owner.actor_id : undefined,
      epoch: Number.isSafeInteger(owner.epoch) ? owner.epoch : undefined },
    updated_at: Number.isFinite(raw.updated_at) ? raw.updated_at : 0 }
}

export function nextSliceTransition(state, event, now) {
  if (state.run?.next_slice_fault) return state
  if (event.source !== 'runtime' || event.goal_id !== state.goal?.goal_id || !phases.has(event.phase)) return state
  const anchor = completedSliceAnchor(state)
  const held = restoreNextSlice(state.run?.next_slice, state)
  if (!anchor && !(held && event.phase === 'committed')) return state
  const identity = anchor ?? held
  if (event.boundary_key && event.boundary_key !== identity.boundary_key) return state
  if (held && held.boundary_key === identity.boundary_key && held.phase === 'paused'
    && ['operator', 'authority', 'guard', 'system'].includes(state.run?.pause_class) && event.phase !== 'paused') return state
  const episode = restoreNextSlice({ ...identity, schema: 1, phase: event.phase,
    reason: event.reason ?? held?.reason, failure_class: event.failure_class ?? held?.failure_class,
    progress_mark: held?.boundary_key === identity.boundary_key ? held.progress_mark : identity.progress_mark,
    claimed_attempt: held?.boundary_key === identity.boundary_key ? held.claimed_attempt : 0,
    owner: event.owner ?? held?.owner, updated_at: now }, state)
  if (!episode) return state
  return { ...state, run: { ...state.run, next_slice: episode, updated_at: now }, updated_at: now }
}
