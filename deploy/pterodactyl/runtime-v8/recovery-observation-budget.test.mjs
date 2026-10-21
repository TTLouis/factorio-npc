import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { Session } from './supervisor.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Run AJ (2026-10-21): a C3 committed inside a slice close seeded the executor's observation decision (4), the executor spent it
// to 0, and the 0 outlived completed(). Both C7 auto-resume executors then started with observationBudgetRemaining=0: no
// context.executor_observation_started row, budget_remaining_before:0 on their first reads, and the phase closed on the first
// fresh read, so getPlacementCandidates was never read and auto_resume_exhausted ended the run. A role handoff is a new bounded
// observation decision (not a new provider/campaign allowance), and a decision's budget does not outlive the wake that set it.

const KEY = 'npc:sgluna'
const GOAL = { scope: 'finite', summary: 'Gather copper, then iron.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] }
const brief = item => ({ approach: `Gather the ${item} this slice needs by hand.`, rationale: 'A small stock requirement does not repay extra setup yet.',
  constraints: ['Keep the requested quantity.'], skillIds: [] })
const slice = (item, overrides = {}) => ({ chatMessage: '', plan: [`Gather ten ${item}`], currentStep: 0, operations: [],
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint(item, 10) }], executionGuidance: [brief(item)], goal: GOAL, ...overrides })
const activeStepId = memory => { const held = getActivePlan(memory.planningState(KEY)); return held.steps[held.active_step_index].step_id }
const act = item => ({ memory }) => ({ stepId: activeStepId(memory), operations: [gather(item, 10)] })
const review = rationale => ({ memory }) => ({ stepId: activeStepId(memory), operations: [], plannerReview: { reason: 'local_recovery_exhausted', rationale } })
const reads = (...calls) => ({ content: '', tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
const nearby = (id, name) => [id, 'getNearbyEntities', { radius: 32, name, limit: 4 }]
const AJ_RATIONALE = 'No live iron-ore placement facts reached this decision; drill coverage and output geometry are unknown.'

function world(script) {
  const game = new FakeFactorio()
  const native = game.command.bind(game)
  game.command = async command => {
    if (command.includes('"get_placement_candidates"')) {
      return JSON.stringify({ ok: true, entity_name: 'burner-mining-drill', candidate_set_id: 'placement-7', legal_candidate_count: 1, returned_candidate_count: 1,
        candidates: [{ id: 'candidate-1', position: { x: -47.5, y: -12.5 }, direction: 4, resource_coverage: { resource_name: 'iron-ore', entity_count: 1, total_amount: 44 } }] })
    }
    return native(command)
  }
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const trace = []
  const agent = new NpcAgentLoop({ rcon: game, memory, completionProtocolVersion: 3, replacementWake: true,
    provider: answersStepContract(async (messages, context) => {
      // What this round was given: its role, whether reads were open, and the decision budget it ran under.
      calls.push({ role: context?.role, allowTools: context?.allowTools, remaining: agent.observationBudgetRemaining,
        override: agent.observationBudgetOverride, handoffId: agent.agentContext.handoffId, requestId: agent.traceRequest?.id })
      const next = script[calls.length - 1]
      // Past the script the executor just reviews again: an unscripted round must not throw inside the provider.
      const reply = typeof next === 'function' ? await next({ agent, game, memory, messages, context })
        : next ?? review('Unscripted round.')({ memory })
      return reply.tool_calls ? reply : planReply(reply)
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'Recovery observation budget fixture.', npcId: 'sgluna', stateFile: null, traceFile: null, decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const rows = (name, from = 0) => trace.slice(from).filter(row => row.event === name)
  return { agent, game, memory, calls, trace, rows }
}

function sessionFor(agent) {
  const chat = []
  const session = Object.create(Session.prototype)
  Object.assign(session, { agent, npcId: 'sgluna', npcName: 'SGLuna', stopping: false, autoResume: null, modelResume: null,
    lastPauseDecision: '', lastStatus: { actor_id: 18, epoch: 3 }, liveStatus: { actor_id: 18, epoch: 3 }, log: () => {},
    printChat: async message => { chat.push(message) }, queueEvent: () => Promise.resolve(), eventQueue: Promise.resolve(),
    rawStatus: async () => ({ ...session.liveStatus }), syncTaskBoardUi: async () => {}, ensureAuthorization: async () => ({}),
    rcon: { command: async () => '' } })
  return { session, chat }
}

// Slice 1 (copper) is acted on and verified; its completion closes the slice inside completed(), the planner commits slice 2
// (iron), and the C3 executor of slice 2 reviews, gets its planner round, spends its whole C3 allowance on four fresh reads and
// reviews again: a model_recoverable pause, all inside the completion wake that closed slice 1.
const AJ_SCRIPT = [
  slice('copper-ore'), // 1 planner: slice 1
  act('copper-ore'), // 2 executor (C3): acts
  slice('iron-ore'), // 3 planner: slice 2, at the slice close inside completed()
  review(AJ_RATIONALE), // 4 executor (C3): first review of the step
  slice('iron-ore', { chatMessage: 'Planner notes: read the iron-ore placement candidates before acting.' }), // 5 planner review round
  reads(nearby('r1', 'rock-huge'), nearby('r2', 'tree-01'), nearby('r3', 'coal'), nearby('r4', 'stone')), // 6 executor (C3 handback)
  review(AJ_RATIONALE), // 7 executor: allowance spent, second review -> model_recoverable pause
]

async function runAJToPause() {
  const w = world([...AJ_SCRIPT,
    reads(nearby('c1', 'iron-ore'), nearby('c2', 'water')), // 8 executor (C7): two fresh reads
    reads(['pc1', 'getPlacementCandidates', { entity_name: 'burner-mining-drill', target_resource: 'iron-ore', radius: 16, limit: 1 }]), // 9 executor (C7)
    act('iron-ore'), // 10 executor (C7): acts on the candidate facts
  ])
  await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' })
  w.game.inventory['copper-ore'] = 10
  w.beforeCompleted = { override: w.agent.observationBudgetOverride, remaining: w.agent.observationBudgetRemaining }
  w.completedResult = await w.agent.completed()
  w.afterCompleted = { override: w.agent.observationBudgetOverride, remaining: w.agent.observationBudgetRemaining }
  return w
}

function assertAJPausedAfterSpendingTheAllowance(w) {
  assert.deepEqual(w.calls.slice(0, 7).map(call => call.role), ['planner', 'executor', 'planner', 'executor', 'planner', 'executor', 'executor'], 'Run AJ shape up to the pause')
  assert.equal(w.calls[5].remaining, 4, 'the C3 handback seeded the executor allowance')
  assert.equal(w.calls[6].remaining, 0, 'the executor spent the whole allowance before its second review')
  assert.equal(w.calls[6].allowTools, false)
  assert.equal(w.completedResult?.blocker?.class, 'planner_review_required')
  assert.equal(w.memory.currentPlan(KEY).status, 'paused')
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
}

test('Run AJ: the C7 auto-resume executor starts a fresh traced observation decision and can still read placement candidates', async t => {
  const w = await runAJToPause()
  assertAJPausedAfterSpendingTheAllowance(w)
  const { session } = sessionFor(w.agent)
  t.after(() => { if (session.modelResume?.timer) clearTimeout(session.modelResume.timer) })
  assert.equal(await session.considerPauseForAutoResume(), true)
  clearTimeout(session.modelResume.timer)
  const providerBefore = { generation: w.agent.providerBudgetGeneration, handoffs: w.agent.providerBudgetHandoffCount }
  const allowanceBefore = w.memory.autoResumeAllowance(KEY)
  const planBefore = getActivePlan(w.memory.planningState(KEY))
  await session.runModelRecoverableResume(session.modelResume.correlation, 1)

  const [c7First, c7Second, c7Third] = w.calls.slice(7)
  assert.equal(c7First?.role, 'executor')
  assert.equal(c7First.remaining, 4, 'the recovery executor starts a new bounded decision, not the exhausted one')
  assert.equal(c7First.override, 4)
  assert.equal(c7First.allowTools, true)
  const restaged = w.rows('context.restaged').find(row => row.data.checkpoint === 'C7')
  assert.ok(restaged, 'the auto-resume rebuilt the executor from a C7 packet')
  const started = w.rows('context.executor_observation_started').filter(row => row.data.checkpoint === 'C7')
  assert.equal(started.length, 1)
  assert.deepEqual([started[0].data.handoff_id, started[0].data.reason, started[0].data.previous_remaining, started[0].data.observation_remaining],
    // previous_remaining: what the pause left behind. Run AJ left the spent 0; completed() now restores the value it found (the next test).
    [restaged.data.handoff_id, 'new_executor_decision_at_recovery', null, 4])
  assert.equal(started[0].request_id ?? started[0].data.request_id, restaged.request_id ?? restaged.data.request_id, 'traced under the recovery request')
  assert.equal(c7First.handoffId, restaged.data.handoff_id)

  // Two fresh reads, then the placement-candidate read is still admitted with tools open.
  assert.equal(c7Second.remaining, 2)
  assert.equal(c7Second.allowTools, true, 'reads stay open after two fresh reads')
  assert.ok(w.rows('tool.call').some(row => row.data.tool_call_id === 'pc1' && row.data.name === 'getPlacementCandidates'), 'getPlacementCandidates was admitted')
  assert.equal(c7Third.remaining, 1)
  const recoveryRequest = restaged.request_id ?? restaged.data.request_id
  const exhaustedRows = [...w.rows('observation.partial_admission'), ...w.rows('observation.tier_admitted')]
    .filter(row => (row.request_id ?? row.data.request_id) === recoveryRequest)
  assert.deepEqual(exhaustedRows.map(row => row.data.budget_remaining_before), [], 'no read of the recovery decision met a spent budget')
  assert.equal(w.game.mutations.length, 2, 'the resumed executor acted on the same step')

  // A role handoff is a new observation decision, not a new provider, campaign or resume allowance.
  assert.deepEqual({ generation: w.agent.providerBudgetGeneration, handoffs: w.agent.providerBudgetHandoffCount }, providerBefore)
  assert.equal(w.memory.autoResumeAllowance(KEY).step_attempts, allowanceBefore.step_attempts + 1)
  assert.equal(w.memory.autoResumeAllowance(KEY).goal_attempts, allowanceBefore.goal_attempts + 1)
  assert.equal(getActivePlan(w.memory.planningState(KEY)).plan_id, planBefore.plan_id, 'no plan was created or replaced')
})

test('Run AJ: a decision budget set inside the slice close does not outlive the completion wake that closed the slice', async () => {
  const w = await runAJToPause()
  assertAJPausedAfterSpendingTheAllowance(w)
  assert.deepEqual(w.afterCompleted, w.beforeCompleted, 'completed() leaves the decision budgets as it found them')
  assert.notEqual(w.afterCompleted.remaining, 0)
})

// Only the two handoffs that start an executor decision from nothing are seeded: C3 (the commit handoff) and C7 (runtime recovery,
// between turns, where no wake chose a budget). C6 and a non-folded C8 restage inside a wake whose budget Jev or the planner shape
// chose, and that budget carries over; C5 continues the same decision; a planner restage is not an executor handoff.
async function executorWorld() {
  const w = world([slice('copper-ore'), act('copper-ore')])
  await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' })
  assert.equal(w.agent.agentContext.role, 'executor')
  w.mark = w.trace.length // rows from here on belong to the restage under test, not the request's own C3 handoff
  return w
}
const spend = agent => { agent.observationBudgetOverride = 4; agent.observationBudgetRemaining = 0; agent.observationDecisionForced = true }

test('a fresh C7 executor conversation starts a new bounded observation decision, traced with its checkpoint', async () => {
  const w = await executorWorld()
  spend(w.agent)
  const restaged = await w.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'test_C7', actor: w.agent.epoch, requestId: 'req_fresh' })
  assert.equal(restaged.restaged, true)
  assert.equal(restaged.decision_started, true)
  assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining, w.agent.observationDecisionForced], [4, 4, false])
  const [row, ...extra] = w.rows('context.executor_observation_started', w.mark)
  assert.equal(extra.length, 0)
  assert.deepEqual([row.data.checkpoint, row.data.reason, row.data.handoff_id, row.data.previous_remaining, row.data.request_id],
    ['C7', 'new_executor_decision_at_recovery', restaged.handoff_id, 0, 'req_fresh'])
})

for (const [checkpoint, role] of [['C6', 'executor'], ['C8', 'executor'], ['C5', 'executor'], ['C1', 'planner']]) {
  test(`a ${checkpoint} ${role} restage keeps the current decision budget and starts no executor observation decision`, async () => {
    const w = await executorWorld()
    spend(w.agent)
    const restaged = await w.agent.restageBetweenTurns({ checkpoint, role, reason: `test_${checkpoint}`, actor: w.agent.epoch, requestId: `req_${checkpoint}` })
    assert.equal(restaged.restaged, true, JSON.stringify(restaged))
    assert.equal(restaged.decision_started, undefined)
    assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], [4, 0], 'the wake-chosen budget carries over')
    assert.equal(w.rows('context.executor_observation_started', w.mark).length, 0)
  })
}

test('a refused executor restage grants no new decision', async () => {
  const w = await executorWorld()
  spend(w.agent)
  // A turn holds the conversation and the caller has no token for it: round_open.
  w.agent.turnConversation = {}
  const refused = await w.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'test_refused', actor: w.agent.epoch, requestId: 'req_refused' })
  w.agent.turnConversation = null
  assert.equal(refused.restaged, false)
  assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining, w.agent.observationDecisionForced], [4, 0, true])
  assert.equal(w.rows('context.executor_observation_started', w.mark).length, 0)
})

test('a C7 recovery handoff superseded after the swap reports the restage that happened, starts no decision and is traced', async () => {
  const w = await executorWorld()
  const original = w.agent.jev.afterRestage.bind(w.agent.jev)
  w.agent.jev.afterRestage = async (prepared, result) => {
    await original(prepared, result)
    if (result.restaged) {
      w.agent.reset()
      w.agent.observationBudgetOverride = 1
      w.agent.observationBudgetRemaining = 1
      w.agent.observationDecisionForced = true
    }
  }
  const result = await w.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'test_superseded', actor: w.agent.epoch, requestId: 'req_superseded' })
  // restageContext already replaced the conversation: callers must not act as if nothing was restaged.
  assert.equal(result.restaged, true)
  assert.equal(result.checkpoint, 'C7')
  assert.deepEqual([result.decision_started, result.decision_reason], [false, 'executor_decision_superseded_after_handoff'])
  assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining, w.agent.observationDecisionForced], [1, 1, true],
    'the newer lineage keeps its own allowance')
  assert.equal(w.rows('context.executor_observation_started', w.mark).length, 0)
  const [row, ...extra] = w.rows('context.executor_decision_superseded', w.mark)
  assert.equal(extra.length, 0)
  assert.deepEqual([row.data.request_id, row.data.checkpoint, row.data.handoff_id, row.data.reason, row.data.fence],
    ['req_superseded', 'C7', result.handoff_id, 'executor_decision_superseded_after_handoff', 'generation'])
})

test('a C7 between turns after a reset (no loop epoch, the caller names the actor) still starts a fresh decision', async () => {
  const w = await executorWorld()
  const actor = w.agent.epoch
  w.agent.reset()
  assert.equal(w.agent.epoch, null)
  spend(w.agent)
  const restaged = await w.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:after_reset', actor, requestId: 'req_after_reset' })
  assert.equal(restaged.restaged, true, JSON.stringify(restaged))
  assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], [4, 4])
  const [row] = w.rows('context.executor_observation_started', w.mark)
  assert.deepEqual([row.data.checkpoint, row.data.reason, row.data.handoff_id], ['C7', 'new_executor_decision_at_recovery', restaged.handoff_id])
})

test('completed() does not restore its saved budgets over a newer lineage that superseded it mid-wake', async () => {
  const newer = { override: 1, remaining: 1, relevance: ['inventory'] }
  const w = world([slice('copper-ore'), act('copper-ore'), ({ agent }) => {
    // A player request (or an actor replacement) supersedes the slice-close wake and sets its own decision budgets.
    agent.reset()
    agent.observationBudgetOverride = newer.override
    agent.observationBudgetRemaining = newer.remaining
    agent.observationRelevanceOverride = newer.relevance
    return slice('iron-ore')
  }])
  await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' })
  w.game.inventory['copper-ore'] = 10
  assert.deepEqual([w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], [null, null])
  await w.agent.completed().catch(error => error)
  assert.deepEqual({ override: w.agent.observationBudgetOverride, remaining: w.agent.observationBudgetRemaining, relevance: w.agent.observationRelevanceOverride },
    newer, 'the superseded completion wake left the newer lineage\'s budgets alone')
})

test('runtime recovery stops after a superseded C7 swap without writing or calling the provider', async () => {
  const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
  const w = await executorWorld()
  const callsBefore = w.calls.length
  const saved = [w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride,
    w.agent.observationBudgetRemaining, w.agent.planningHorizonOverride]
  const original = w.agent.jev.afterRestage.bind(w.agent.jev)
  let swapped = false
  w.agent.jev.afterRestage = async (prepared, result) => {
    await original(prepared, result)
    if (result.restaged && result.checkpoint === 'C7') {
      swapped = true
      w.agent.reset()
      w.agent.observationBudgetOverride = 1
      w.agent.observationBudgetRemaining = 1
    }
  }
  const result = await recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: 'req_w3_superseded' })
  assert.equal(swapped, true, 'the C7 conversation swap happened')
  assert.equal(result.recovered, false, 'a superseded recovery must not report success')
  assert.equal(result.reason, 'executor_decision_superseded_after_handoff')
  for (const messages of [w.agent.baseMessages, w.agent.messages]) {
    assert.equal(messages.some(row => String(row.content).includes('[HARNESS] Runtime recovery after')), false,
      'no old recovery harness is appended to the swapped conversation')
  }
  assert.equal(w.calls.length, callsBefore, 'no provider call after the swap')
  const [row] = w.rows('runtime.recovery_decision_superseded', w.mark)
  assert.ok(row, 'the supervisor traces the superseded recovery')
  assert.deepEqual(row.data, { reason: 'executor_decision_superseded_after_handoff', recovery_reason: 'runtime_restart' })
  assert.equal(row.request_id ?? row.data.request_id, 'req_w3_superseded')
  assert.deepEqual([w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride,
    w.agent.observationBudgetRemaining, w.agent.planningHorizonOverride], saved, 'the early return restores saved budgets')
})

test('planner review handback rejects a superseded C3 before appending review notes', async () => {
  let armed = false
  const notes = `Read the copper facts before acting. ${'Preserve the requested quantity and verify the current step. '.repeat(14)}`
  const w = world([slice('copper-ore'), review(AJ_RATIONALE), () => {
    armed = true
    return slice('copper-ore', { chatMessage: notes })
  }])
  const original = w.agent.jev.afterRestage.bind(w.agent.jev)
  let swapped = false
  w.agent.jev.afterRestage = async (prepared, result) => {
    await original(prepared, result)
    if (armed && result.restaged && result.checkpoint === 'C3') {
      swapped = true
      w.agent.reset()
    }
  }
  const commit = w.agent.commitPlan.bind(w.agent)
  let handback
  w.agent.commitPlan = function (plan) {
    const result = commit(plan)
    if (armed && this.agentContext.role === 'planner') handback = result
    return result
  }
  await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' }).catch(() => {})
  assert.equal(swapped, true, 'the planner review used a C3 conversation swap')
  assert.ok(handback, 'the planner review reached commitPlan')
  await assert.rejects(handback, /planner_execution_handoff_superseded/)
  for (const messages of [w.agent.baseMessages, w.agent.messages]) {
    assert.equal(messages.some(row => String(row.content).startsWith('[PLANNER_REVIEW_NOTES]')), false,
      'no old planner notes are appended after supersession')
  }
})

test('normal C7 runtime recovery still starts a decision and carries the recovery message once', async () => {
  const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
  const w = await executorWorld()
  let restage
  const original = w.agent.restageBetweenTurns.bind(w.agent)
  w.agent.restageBetweenTurns = async options => {
    const result = await original(options)
    if (options.checkpoint === 'C7') restage = result
    return result
  }
  const provider = w.agent.provider
  w.agent.provider = async () => {
    w.agent.provider = provider
    return planReply(act('copper-ore')({ memory: w.memory }))
  }
  const result = await recoverInterruptedAgentPlan(w.agent, 'runtime_restart')
  assert.equal(result.recovered, true)
  assert.equal(restage?.decision_started, true)
  for (const messages of [w.agent.baseMessages, w.agent.messages]) {
    assert.equal(messages.filter(row => String(row.content).includes('[HARNESS] Runtime recovery after')).length, 1,
      'the normal recovery harness is present once')
  }
})
