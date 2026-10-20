// Option C: the NPC's lifecycle as one tuple, and the entry points that act on it.
//
// Whether an entry point may act depends on several axes at once: the durable goal and run state
// (paused, pause class), the reducer plan and its active step, the conversation role, a batch in
// flight, the live request. Each used to be checked inline where it was needed, so a new path to an
// old action (an automatic resume restaging onto a paused board, run H; a checkpoint persisted on a
// completed plan, run J) skipped a rule the old path enforced. Here every entry point reads the same
// snapshot and traces it (`lifecycle.entered`), so the corpus shows which event ran in which state.
//
// The snapshot is read-only: it projects existing fields and stores nothing. An axis it cannot read
// (a fake memory without a reducer, a bare test agent) is 'unknown', never a guess.

import { getActivePlan } from './planning-state.mjs'

// Every entry point, where it lives and what it does. lifecycle.test.mjs proves each site calls
// lifecycleEnter with its event, so a new entry point must be added here to be seen.
export const LIFECYCLE_SITES = Object.freeze([
  { event: 'request.start', owner: 'runtime-v8/npc-agent-loop', site: 'request', note: 'a player chat request starts' },
  { event: 'reset', owner: 'runtime-v8/npc-agent-loop', site: 'reset', note: 'the request lineage is discarded (new request, actor replaced, death, recovery prepare)' },
  { event: 'restage', owner: 'runtime-v8/npc-agent-loop', site: 'restageContext', note: 'a role conversation is restaged from a handoff packet (details.role)' },
  { event: 'planner.return', owner: 'runtime-v8/npc-agent-loop', site: 'returnControlToPlanner', note: 'the executor hands control back to the planner' },
  { event: 'epoch.rebuild', owner: 'runtime-v8/npc-agent-loop', site: 'refreshPlanningReasoningEpoch', note: 'a reasoning epoch bump rebuilds the planner conversation' },
  { event: 'continuation', owner: 'runtime-v8/npc-agent-loop', site: 'continueFromModMessage', note: 'a mod message (receipt, error) continues the request' },
  { event: 'checkpoint.persist', owner: 'runtime-v8/npc-agent-loop', site: 'persistPlannerCheckpoint', note: 'a reply checkpoint is bound to the active step' },
  { event: 'slice.close', owner: 'runtime-v8/npc-agent-loop', site: 'closeOutputSlice', note: 'a plan slice closes' },
  { event: 'batch.send', owner: 'runtime-v8/npc-agent-loop', site: 'commitPlan', note: 'an admitted operation batch is sent to the game' },
  { event: 'plan.recover', owner: 'runtime-v8/npc-agent-loop', site: 'recoverPlanRoute', note: 'a failed turn is recovered inside the request' },
  { event: 'task.resume', owner: 'runtime-v8/npc-agent-loop', site: 'resumeInterruptedTask', note: 'a ledger task is moved back into the running goal' },
  { event: 'recovery.interrupted', owner: 'runtime-v8/supervisor', site: 'recoverInterruptedAgentPlan', fn: true, note: 'the supervisor restarts an interrupted plan (restart, auto-resume, actor replaced)' },
])

export const LIFECYCLE_EVENTS = Object.freeze([...new Set(LIFECYCLE_SITES.map(site => site.event))])

const GOAL_STATUSES = new Set(['active', 'paused', 'completed', 'blocked', 'cancelled'])

const short = (value, limit = 120) => typeof value === 'string' && value ? value.slice(0, limit) : null

export function lifecycleSnapshot(agent) {
  const memory = agent?.memory
  const key = typeof agent?.activePlanKey === 'function' ? agent.activePlanKey() : agent?.npcId ? `npc:${agent.npcId}` : undefined
  // Peek, never memory.currentPlan(): the canonical memory's currentPlan retires a completed goal and builds a missing
  // board, so a trace-only read would change the state it reports. A memory without the map (a test fake) is read through
  // currentPlan, which has no side effects there.
  const peekable = typeof memory?.planByNpc?.get === 'function'
  const legacy = !key ? undefined : peekable ? memory.planByNpc.get(key) : typeof memory?.currentPlan === 'function' ? memory.currentPlan(key) : undefined
  const planning = key && typeof memory?.planningState === 'function' ? memory.planningState(key) : undefined
  const plan = planning ? getActivePlan(planning) : undefined
  const run = planning?.run
  const board = legacy?.task_board
  const boardStep = Number.isSafeInteger(board?.active_index) ? board?.steps?.[board.active_index] : undefined
  const context = agent?.agentContext
  return {
    goal: legacy ? (GOAL_STATUSES.has(legacy.status) ? legacy.status : 'other') : peekable || typeof memory?.currentPlan === 'function' ? 'none' : 'unknown',
    board_step: short(boardStep?.id),
    run: run ? (run.paused ? 'paused' : 'running') : 'unknown',
    pause_class: run?.paused ? short(run.pause_class) : null,
    plan: plan ? plan.status : planning ? 'none' : 'unknown',
    step: short(plan?.steps?.[plan.active_step_index]?.step_id),
    role: short(context?.role) ?? 'unknown',
    parked_planner: context ? context.hasParkedPlanner === true : null,
    batch: agent?.batchInFlight === true ? 'in_flight' : agent?.batchInFlight === false ? 'idle' : 'unknown',
    pending_operation: run ? Boolean(run.pending_operation) : null,
    request: agent?.active === true ? 'active' : agent?.active === false ? 'idle' : 'unknown',
    provider_recovery: short(legacy?.provider_recovery?.phase ?? run?.provider_recovery?.phase, 60),
  }
}

// ---------------------------------------------------------------------------------------
// C2: the transition table
// ---------------------------------------------------------------------------------------
//
// One entry per event. `rules` say when the event is refused; `resets` are the per-decision counters a fresh
// conversation starts over (the model in it never saw the rejections they counted). A rule refuses only on positive
// evidence of a wrong state: `refuse` lists the values that refuse it (an axis that reads 'unknown' never matches),
// `require` lists the only values that pass (used where the site already failed closed on an unreadable state).
// `when` narrows a rule to the entry point's details (the restaged role, the recovery boundary). An event with no
// rule is listed with an empty list and the reason none is enforced (`open`), so no event is added unexamined.

const CLOSED_GOALS = Object.freeze(['paused', 'completed', 'cancelled'])

// A3 finding 4: these counted retries against messages a restage, a planner return or an epoch rebuild discards.
const DECISION_COUNTERS = Object.freeze({ finiteNoOperationPressureUsed: false, toolValidationRetries: 0, planCategoryRetries: 0 })

const NONE = Object.freeze({})

export const LIFECYCLE_TABLE = Object.freeze({
  'request.start': { rules: [], resets: NONE, open: 'a player request decides the goal itself (new goal, continue, amend)' },
  'reset': { rules: [], resets: NONE, open: 'discarding the request lineage is always allowed' },
  'restage': {
    rules: [{
      when: { role: 'executor' },
      axis: 'goal',
      refuse: CLOSED_GOALS,
      reason: 'executor_restage_on_closed_goal',
      evidence: 'runs G and H: an automatic resume restaged the executor onto a paused plan, whose next checkpoint was refused',
    }],
    resets: DECISION_COUNTERS,
  },
  'planner.return': { rules: [], resets: DECISION_COUNTERS, open: 'the replacement wake may return to a blocked plan (MW5); no wrong state was seen' },
  'epoch.rebuild': { rules: [], resets: DECISION_COUNTERS, open: 'the rebuild follows a reducer epoch bump the reducer already admitted' },
  'continuation': { rules: [], resets: NONE, open: 'the continuation resets these counters itself (continueFromModMessage)' },
  'checkpoint.persist': {
    rules: [{
      axis: 'goal',
      require: ['active'],
      reason: 'checkpoint_requires_active_step',
      evidence: 'run J: a checkpoint reached a completed plan; the inline goal check this replaces failed closed the same way',
    }],
    resets: NONE,
  },
  'slice.close': { rules: [], resets: NONE, open: 'the reducer settles the slice; no wrong state was seen' },
  'batch.send': { rules: [], resets: NONE, open: 'one-off requests act outside a running goal; run G sent one batch with the reducer run still paused (open)' },
  'plan.recover': { rules: [], resets: NONE, open: 'recovery inside a live request; no wrong state was seen' },
  'task.resume': { rules: [], resets: NONE, open: 'memory.resumeTask checks the ledger itself' },
  'recovery.interrupted': {
    rules: [{
      when: { boundary: 'step' },
      axis: 'goal',
      refuse: CLOSED_GOALS,
      reason: 'recovery_on_closed_goal',
      evidence: 'runs G and H: a step recovery runs on an active plan (a paused one is reactivated first, or the recovery ends)',
    }],
    resets: NONE,
  },
})

// The first rule the state breaks, or undefined when the event may run.
export function lifecycleRefusal(event, state, details = {}) {
  for (const rule of LIFECYCLE_TABLE[event]?.rules ?? []) {
    if (rule.when && Object.entries(rule.when).some(([name, value]) => details?.[name] !== value)) continue
    const value = state?.[rule.axis] ?? 'unknown'
    if (rule.refuse?.includes(value) || (rule.require && !rule.require.includes(value))) return { reason: rule.reason, axis: rule.axis, value }
  }
  return undefined
}

export function lifecycleResets(event) {
  return LIFECYCLE_TABLE[event]?.resets ?? NONE
}
