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
  const legacy = key && typeof memory?.currentPlan === 'function' ? memory.currentPlan(key) : undefined
  const planning = key && typeof memory?.planningState === 'function' ? memory.planningState(key) : undefined
  const plan = planning ? getActivePlan(planning) : undefined
  const run = planning?.run
  const board = legacy?.task_board
  const boardStep = Number.isSafeInteger(board?.active_index) ? board?.steps?.[board.active_index] : undefined
  const context = agent?.agentContext
  return {
    goal: legacy ? (GOAL_STATUSES.has(legacy.status) ? legacy.status : 'other') : typeof memory?.currentPlan === 'function' ? 'none' : 'unknown',
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
