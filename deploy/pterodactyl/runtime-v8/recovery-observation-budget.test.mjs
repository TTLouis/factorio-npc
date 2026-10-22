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
  const original = w.agent.jev.afterRestage.bind(w.agent.jev)
  let swapped = false
  w.agent.jev.afterRestage = async (prepared, result) => {
    await original(prepared, result)
    if (result.restaged && result.checkpoint === 'C7') {
      swapped = true
      w.agent.reset()
      w.agent.observationBudgetOverride = 1
      w.agent.observationBudgetRemaining = 1
      w.agent.observationRelevanceOverride = ['inventory']
      w.agent.reasoningBudgetOverride = 'deep'
      w.agent.planningHorizonOverride = 'current_step'
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
  assert.deepEqual(row.data, { request_id: 'req_w3_superseded', reason: 'executor_decision_superseded_after_handoff', recovery_reason: 'runtime_restart' })
  assert.equal(row.request_id ?? row.data.request_id, 'req_w3_superseded')
  assert.deepEqual([w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride,
    w.agent.observationBudgetRemaining, w.agent.planningHorizonOverride, w.agent.observationRelevanceOverride],
  ['deep', 1, 1, 'current_step', ['inventory']], 'the newer lineage owns all decision fields')
  const [cleanup] = w.rows('decision.budgets_restore_skipped', w.mark)
  assert.equal(cleanup.data.reason, 'decision_owner_superseded')
  assert.equal(cleanup.request_id ?? cleanup.data.request_id, 'req_w3_superseded')
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


const budgetFields = ['reasoningBudgetOverride', 'observationBudgetOverride', 'observationBudgetRemaining', 'observationRelevanceOverride', 'planningHorizonOverride']
const budgets = agent => budgetFields.map(field => agent[field])
const NEWER_BUDGETS = ['deep', 1, 1, ['inventory'], 'current_step']
function supersede(agent) {
  agent.reset()
  for (const [index, field] of budgetFields.entries()) agent[field] = NEWER_BUDGETS[index]
}
function holdTrace(w, predicate) {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const held = new Promise(resolve => { release = resolve })
  const emit = w.agent.behaviorTrace.emit
  let armed = true
  w.agent.behaviorTrace.emit = async record => {
    await emit(record)
    if (armed && predicate(record)) { armed = false; enter(record); await held }
  }
  return { entered, release }
}

for (const checkpoint of ['C3', 'C7']) {
  test(`${checkpoint} cancellation during the awaited decision-start trace preserves the newer owner and reports no decision`, async () => {
    const w = await executorWorld()
    const gate = holdTrace(w, row => row.event === 'context.executor_observation_started' && row.data.checkpoint === checkpoint)
    const pending = w.agent.restageBetweenTurns({ checkpoint, role: 'executor', parkPlanner: checkpoint === 'C3',
      reason: 'deferred_start_trace', actor: w.agent.epoch, requestId: `req_deferred_${checkpoint}` })
    await gate.entered
    supersede(w.agent)
    const messages = w.agent.messages
    gate.release()
    const result = await pending
    assert.equal(result.restaged, true)
    assert.equal(result.decision_started, false, 'a swapped conversation does not grant stale work a decision')
    assert.equal(result.decision_reason, 'executor_decision_superseded_after_handoff')
    assert.deepEqual(budgets(w.agent), NEWER_BUDGETS)
    assert.equal(w.agent.messages, messages)
    const [row] = w.rows('context.executor_decision_superseded', w.mark)
    assert.equal(row.data.request_id, `req_deferred_${checkpoint}`)
    assert.equal(row.data.reason, 'executor_decision_superseded_after_handoff')
  })
}

for (const event of ['context.executor_facts_carried', 'context.executor_observation_started', 'context.restage_folded', 'context.planner_parked']) {
  test(`folded handback superseded during ${event} does not reset budgets or append old notes`, async () => {
    const twoSteps = { ...slice('copper-ore'), plan: ['Gather ten copper ore', 'Gather ten iron ore'],
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) },
        { kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-ore', 10) }],
      executionGuidance: [brief('copper-ore'), brief('iron-ore')] }
    let reviewing = false
    const w = world([twoSteps, act('copper-ore'), review(AJ_RATIONALE), () => {
      reviewing = true
      return { ...twoSteps, currentStep: 1, chatMessage: 'Use the refreshed iron facts before acting.' }
    }, act('iron-ore')])
    w.agent.restageSoftLimitOption = { executor: 1 }
    await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' })
    const gate = holdTrace(w, row => reviewing && row.event === event)
    let handback
    const fold = w.agent.foldReviewHandback.bind(w.agent)
    w.agent.foldReviewHandback = async options => { handback = await fold(options); return handback }
    w.game.inventory['copper-ore'] = 10
    const pending = w.agent.completed().catch(error => error)
    const record = await gate.entered
    const callsBefore = w.calls.length
    supersede(w.agent)
    const messages = w.agent.messages
    gate.release()
    await pending
    assert.equal(handback?.restaged, true, 'the fold already swapped the conversation')
    assert.equal(handback?.decision_started, false, 'a superseded fold must stop its caller')
    assert.deepEqual(budgets(w.agent), NEWER_BUDGETS)
    assert.equal(w.agent.messages, messages, 'no old notes appended into the replacement conversation')
    assert.equal(w.calls.length, callsBefore, 'no stale provider call')
    const rows = w.rows('context.executor_decision_superseded')
    assert.equal(rows.at(-1)?.data.reason, 'executor_decision_superseded_after_handoff')
    assert.equal(rows.at(-1)?.data.request_id, record.request_id ?? record.data.request_id)
  })
}

for (const stage of ['provider', 'facts_error']) {
  test(`failed() cleans its entire decision scope after ${stage}`, async () => {
    const w = world([slice('copper-ore'), act('copper-ore'), ({ agent }) => {
      supersede(agent)
      return act('copper-ore')({ memory: w.memory })
    }])
    await w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' })
    const before = budgets(w.agent)
    if (stage === 'facts_error') {
      const route = w.agent.routePostStepDecision.bind(w.agent)
      w.agent.routePostStepDecision = async (...args) => ({ ...await route(...args), steering: {
        reasoning_budget: 'deep', observation_budget: 2, planning_horizon: 'current_step',
        observation_relevance: { source: 'typed_relevance', selected_families: ['inventory'] },
      } })
      w.agent.executorFactsRefreshText = async () => { throw new Error('scripted facts failure') }
    }
    const failure = w.game.failLastBatch({ type: 'mining', code: 'no_resource' })
    const result = await w.agent.failed(failure).catch(error => error)
    if (stage === 'facts_error') {
      assert.match(result.message, /scripted facts failure/)
      assert.deepEqual(budgets(w.agent), before, 'errors before continuation still restore the owned scope')
      assert.equal(w.rows('decision.budgets_restored').at(-1)?.data.reason, 'decision_scope_finished')
    }
    else {
      assert.deepEqual(budgets(w.agent), NEWER_BUDGETS, 'old failure cleanup cannot restore over the replacement')
      assert.equal(w.rows('decision.budgets_restore_skipped').at(-1)?.data.reason, 'decision_owner_superseded')
    }
  })
}

test('between-slices recovery cannot leak its spent executor budget into later planner observation rounds', async () => {
  const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
  const longGoal = { scope: 'long_horizon', summary: 'Launch one rocket.', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] }
  const draft = item => slice(item, { goal: longGoal })
  const w = world([draft('copper-ore'), act('copper-ore'), () => { throw new Error('scripted restart gap') },
    draft('iron-ore'), reads(nearby('spend1', 'rock-huge'), nearby('spend2', 'tree-01'), nearby('spend3', 'coal'), nearby('spend4', 'stone')),
    act('iron-ore'), reads(nearby('planner1', 'iron-ore'), nearby('planner2', 'water')),
    reads(['planner3', 'getPlacementCandidates', { entity_name: 'burner-mining-drill', target_resource: 'iron-ore', radius: 16, limit: 1 }]),
    draft('coal'), act('coal')])
  await w.agent.request('Launch one rocket.', { sender: 'Louis' })
  w.game.inventory['copper-ore'] = 10
  await assert.rejects(w.agent.completed(), /scripted restart gap/)
  assert.equal(w.agent.goalAwaitingNextSlice(), true)
  const before = budgets(w.agent)
  const allowance = w.memory.autoResumeAllowance(KEY)
  const recovered = await recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: 'req_slice_budget' })
  assert.equal(recovered.recovered, true)
  assert.equal(w.calls[4].remaining, 4)
  assert.equal(w.calls[5].remaining, 0, 'the recovery C3 executor really spent its four reads')
  assert.deepEqual(budgets(w.agent), before, 'the between-slices recovery wake restores all decision fields')
  const afterAllowance = w.memory.autoResumeAllowance(KEY)
  for (const field of ['per_step', 'per_goal', 'goal_attempts', 'step_attempts']) {
    assert.equal(afterAllowance[field], allowance[field], `${field} is unchanged by the recovery decision`)
  }
  const cleanup = w.rows('decision.budgets_restored').find(row => (row.request_id ?? row.data.request_id) === 'req_slice_budget')
  assert.equal(cleanup?.data.reason, 'decision_scope_finished')
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.deepEqual(w.calls.slice(6, 9).map(call => [call.role, call.allowTools]), [['planner', true], ['planner', true], ['planner', true]],
    'the following planner can perform multiple observation rounds')
  assert.ok(w.rows('tool.call').some(row => row.data.tool_call_id === 'planner3'))
  assert.equal(w.game.mutations.length, 3)
})


test('recovery cancelled during its start trace cannot restage or call a provider in the newer scope', async () => {
  const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
  const w = await executorWorld()
  const before = w.calls.length
  const gate = holdTrace(w, row => row.event === 'runtime.recovery_started')
  const pending = recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: 'req_early_recovery' })
  await gate.entered
  supersede(w.agent)
  const messages = w.agent.messages
  gate.release()
  const result = await pending
  assert.equal(result.recovered, false)
  assert.equal(result.reason, 'decision_owner_superseded')
  assert.deepEqual(budgets(w.agent), NEWER_BUDGETS)
  assert.equal(w.agent.messages, messages)
  assert.equal(w.calls.length, before)
  const [row] = w.rows('decision.budgets_restore_skipped', w.mark)
  assert.equal(row.data.reason, 'decision_owner_superseded')
  assert.equal(row.data.request_id, 'req_early_recovery')
})

test('recovery restores every owned override when preparation throws before the executor runs', async () => {
  const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
  const w = await executorWorld()
  for (const [index, field] of budgetFields.entries()) w.agent[field] = NEWER_BUDGETS[index]
  const before = budgets(w.agent)
  w.agent.resetRefusalRecoveryBudgets = async () => {
    for (const field of budgetFields) w.agent[field] = null
    throw new Error('scripted preparation error')
  }
  await assert.rejects(recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: 'req_prepare_error' }), /scripted preparation error/)
  assert.deepEqual(budgets(w.agent), before)
  const [row] = w.rows('decision.budgets_restored', w.mark)
  assert.equal(row.data.request_id, 'req_prepare_error')
  assert.equal(row.data.reason, 'decision_scope_finished')
})


test('C3 review handback cancelled during the final planner-park trace cannot append into the newer conversation', async () => {
  let reviewing = false
  const w = world([slice('copper-ore'), review(AJ_RATIONALE), () => {
    reviewing = true
    return slice('copper-ore', { chatMessage: 'Read the current copper facts before acting.' })
  }, act('copper-ore')])
  const gate = holdTrace(w, row => reviewing && row.event === 'context.planner_parked')
  let handback
  const start = w.agent.startExecutorAtCommit.bind(w.agent)
  w.agent.startExecutorAtCommit = async options => { const result = await start(options); if (reviewing) handback = result; return result }
  const pending = w.agent.request('Gather ten copper ore, then ten iron ore.', { sender: 'Louis' }).catch(error => error)
  const record = await gate.entered
  const callsBefore = w.calls.length
  supersede(w.agent)
  const messages = w.agent.messages
  gate.release()
  await pending
  assert.equal(handback?.restaged, true)
  assert.equal(handback?.decision_started, false)
  assert.equal(w.agent.messages, messages)
  assert.deepEqual(budgets(w.agent), NEWER_BUDGETS)
  assert.equal(w.calls.length, callsBefore)
  assert.equal(w.rows('context.executor_decision_superseded').at(-1)?.data.request_id, record.request_id ?? record.data.request_id)
})


test('request setup failure restores the selected decision overrides before the first planner turn', async () => {
  const w = world([])
  for (const [index, field] of budgetFields.entries()) w.agent[field] = NEWER_BUDGETS[index]
  const before = budgets(w.agent)
  w.agent.requestInteractionPlannerShape = async () => ({ reasoning_budget: 'normal', observation_budget: 2,
    planning_horizon: 'next_slice', observation_relevance: { source: 'typed_relevance', selected_families: ['entities'] } })
  w.memory.admitPlanningGoal = () => { throw new Error('scripted goal admission error') }
  await assert.rejects(w.agent.request('Gather ten copper ore.', { sender: 'Louis' }), /scripted goal admission error/)
  assert.deepEqual(budgets(w.agent), before)
  assert.equal(w.calls.length, 0)
  const [row] = w.rows('decision.budgets_restored')
  assert.ok(row.data.request_id)
  assert.equal(row.data.reason, 'decision_scope_finished')
})

// Startup recovery has no supervisor token. Hold a production preparation await,
// deliver the immediate player Stop, and install a newer request before releasing it.
function holdRecoveryMethod(agent, name, predicate = () => true) {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const held = new Promise(resolve => { release = resolve })
  const original = agent[name]?.bind(agent)
  let armed = true
  agent[name] = async (...args) => {
    const result = await original?.(...args)
    if (armed && predicate(...args)) { armed = false; enter(result); await held }
    return result
  }
  return { entered, release }
}

async function slicePreparationWorld() {
  const longGoal = { scope: 'long_horizon', summary: 'Launch one rocket.', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] }
  const w = world([slice('copper-ore', { goal: longGoal }), act('copper-ore'), () => { throw new Error('scripted preparation gap') }])
  await w.agent.request('Launch one rocket.', { sender: 'Louis' })
  w.game.inventory['copper-ore'] = 10
  await assert.rejects(w.agent.completed(), /scripted preparation gap/)
  assert.equal(w.agent.goalAwaitingNextSlice(), true)
  w.mark = w.trace.length
  return w
}

for (const stage of ['load', 'epoch', 'reconciliation', 'helper_status', 'refusal_budgets', 'helper_return', 'fallback_trace',
  'reactivation_persist', 'reactivation_trace', 'reactivation_callback', 'slice_load', 'slice_epoch', 'slice_reconciliation', 'slice_trace', 'lineage_epoch', 'superseded_trace', 'token_epoch']) {
  test(`no-token startup recovery refuses Stop during ${stage} preparation`, { timeout: 10000 }, async () => {
    const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
    const w = stage.startsWith('slice_') ? await slicePreparationWorld() : await executorWorld()
    if (stage.startsWith('reactivation_')) await w.agent.pausePersistentPlan('provider_transient: scripted timeout', { pause_class: 'transport' })
    let tokenCancelled = false
    const recoveryOptions = { requestId: `req_preparation_${stage}` }
    if (stage === 'token_epoch') recoveryOptions.isCancelled = () => tokenCancelled
    let helperReady = false
    const reset = w.agent.resetRefusalRecoveryBudgets.bind(w.agent)
    w.agent.resetRefusalRecoveryBudgets = async (...args) => { const result = await reset(...args); helperReady = true; return result }
    let gate
    if (stage === 'load' || stage === 'slice_load') gate = holdRecoveryMethod(w.agent, 'loadPersistentState')
    if (['epoch', 'slice_epoch', 'lineage_epoch', 'token_epoch'].includes(stage)) gate = holdRecoveryMethod(w.agent, 'captureEpoch')
    if (stage === 'reconciliation' || stage === 'slice_reconciliation') gate = holdRecoveryMethod(w.agent, 'reconcileOutstandingOperation')
    if (stage === 'helper_status') gate = holdRecoveryMethod(w.agent, 'readInteractionTaskStatus', () => helperReady)
    if (stage === 'refusal_budgets') gate = holdRecoveryMethod(w.agent, 'resetRefusalRecoveryBudgets')
    if (stage === 'helper_return') gate = holdRecoveryMethod(w.agent, 'restageBetweenTurns')
    if (stage === 'fallback_trace') {
      w.agent.restageBetweenTurns = async () => ({ restaged: false, reason: 'scripted_refusal' })
      gate = holdTrace(w, row => row.event === 'runtime.recovery_restage_fallback')
    }
    if (stage === 'superseded_trace') {
      const restage = w.agent.restageBetweenTurns.bind(w.agent)
      w.agent.restageBetweenTurns = async (...args) => ({
        ...await restage(...args), decision_started: false, decision_reason: 'executor_decision_superseded_after_handoff',
      })
      gate = holdTrace(w, row => row.event === 'runtime.recovery_decision_superseded')
    }
    if (stage === 'reactivation_persist') gate = holdRecoveryMethod(w.agent, 'persistState')
    if (stage === 'reactivation_trace') gate = holdTrace(w, row => row.event === 'recovery.auto_resume_plan_resumed')
    if (stage === 'reactivation_callback') {
      recoveryOptions.reactivate = { pause_classes: ['transport'], onResumed: async () => {} }
      gate = holdRecoveryMethod(recoveryOptions.reactivate, 'onResumed')
    }
    if (stage === 'slice_trace') gate = holdTrace(w, row => row.event === 'runtime.recovery_started')
    const requestId = recoveryOptions.requestId
    const calls = w.calls.length
    const mutations = w.game.mutations.length
    const pending = recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, recoveryOptions)
    try {
      await gate.entered
      tokenCancelled = true
      if (stage === 'lineage_epoch') w.agent.agentContext.lineageSequence += 1
      else w.agent.cancel('user_stop_immediate')
      for (const [index, field] of budgetFields.entries()) w.agent[field] = NEWER_BUDGETS[index]
      w.agent.replaceConversation({ baseMessages: [{ role: 'system', content: `Newer request after ${stage}` }] })
      const messages = w.agent.messages
      const baseMessages = w.agent.baseMessages
      const messageValues = structuredClone(messages)
      const baseValues = structuredClone(baseMessages)
      const requestInfo = { memoryKey: KEY, turnId: 999, text: 'Newer request', sender: 'Louis' }
      w.agent.requestInfo = requestInfo
      const traceRequest = { id: `req_newer_${stage}`, seq: 0 }
      w.agent.traceRequest = traceRequest
      w.agent.active = false
      gate.release()
      const result = await pending
      assert.equal(w.calls.length, calls, 'no stale provider call')
      assert.equal(w.game.mutations.length, mutations, 'no stale operation admission')
      assert.equal(w.agent.messages, messages, 'newer messages reference survives')
      assert.equal(w.agent.baseMessages, baseMessages, 'newer base messages reference survives')
      assert.deepEqual(messages, messageValues, 'no stale message appended')
      assert.deepEqual(baseMessages, baseValues, 'no stale base message appended')
      assert.equal(w.agent.requestInfo, requestInfo, 'newer requestInfo survives')
      assert.equal(w.agent.traceRequest, traceRequest, 'traces retain the newer request owner')
      assert.equal(w.agent.active, false, 'Stop remains inactive')
      assert.deepEqual(budgets(w.agent), NEWER_BUDGETS)
      assert.equal(result.recovered, false)
      const expectedReason = ['helper_return', 'superseded_trace'].includes(stage) ? 'executor_decision_superseded_after_handoff'
        : stage === 'token_epoch' ? 'cancelled_after_fire' : 'decision_owner_superseded'
      assert.equal(result.reason, expectedReason)
      const rows = w.rows('runtime.recovery_preparation_cancelled', w.mark)
      assert.ok(rows.some(row => row.data.reason === expectedReason
        && row.data.request_id === requestId),
      'refusal is traced under the original recovery request')
    }
    finally { gate.release() }
  })
}

for (const stage of ['loadPersistentState', 'captureEpoch', 'readInteractionTaskStatus']) {
  test(`same-owner startup recovery survives delayed ${stage} and exactly one preparation cancel`, { timeout: 10000 }, async () => {
    const { recoverInterruptedAgentPlan } = await import('./supervisor.mjs')
    const w = await executorWorld()
    w.agent.provider = async () => planReply(act('copper-ore')({ memory: w.memory }))
    const before = budgets(w.agent)
    const generation = w.agent.generation
    const lineage = w.agent.agentContext.lineageSequence
    const cancel = w.agent.cancel.bind(w.agent)
    const cancels = []
    w.agent.cancel = reason => { cancels.push(reason); return cancel(reason) }
    const gate = holdRecoveryMethod(w.agent, stage)
    const pending = recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: `req_valid_${stage}` })
    try {
      await gate.entered
      gate.release()
      const result = await pending
      assert.equal(result.recovered, true)
      assert.deepEqual(cancels, ['runtime_recovery_prepare:runtime_restart'])
      assert.equal(w.agent.generation, generation + 1)
      assert.equal(w.agent.agentContext.lineageSequence, lineage + 1, 'the intentional cancel starts one lineage')
      assert.deepEqual(budgets(w.agent), before)
      assert.equal(w.game.mutations.length, 2, 'same committed step continues normally')
      assert.equal(w.rows('runtime.recovery_preparation_cancelled', w.mark).length, 0)
    }
    finally { gate.release() }
  })
}
