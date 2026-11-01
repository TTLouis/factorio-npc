// C3: the lifecycle table end to end. A matrix generated from LIFECYCLE_TABLE, one scenario per rule and per reset on
// the real entry points, the retained run G/H/J states replayed, and a lint that fails when a rule or reset has no
// scenario. lifecycle.test.mjs holds the static proofs; this file proves the sites behave.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildHandoffPacket } from './handoff-packet.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { LIFECYCLE_TABLE, lifecycleRefusal, lifecycleResets, lifecycleSnapshot } from './lifecycle.mjs'
import { parseLines, projectLifecycle, scanLifecycle, scanRun } from './lifecycle-scan.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'
import { createEmptyRunState, PLAN_STATUS } from './planning-state.mjs'
import { recoverInterruptedAgentPlan } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_FILE = path.join(here, 'fixtures', 'lifecycle', 'run-g-h-j-lifecycle.json')
const KEY = 'npc:sgluna'

// ---------------------------------------------------------------------------------------
// 1. The generated matrix: every rule of every event, from the table itself
// ---------------------------------------------------------------------------------------

// Every value a snapshot axis can read. A rule on an axis not listed here fails the matrix until the axis is added.
const AXIS_VALUES = {
  goal: ['none', 'active', 'paused', 'completed', 'blocked', 'cancelled', 'other', 'unknown'],
  run: ['running', 'paused', 'unknown'],
  pause_class: [...Object.values(PAUSE_CLASS), null],
  plan: [...Object.values(PLAN_STATUS), 'none', 'unknown'],
  role: ['planner', 'executor', 'unknown'],
  parked_planner: [true, false, null],
  batch: ['idle', 'in_flight', 'unknown'],
  pending_operation: [true, false, null],
  request: ['active', 'idle', 'unknown'],
}

const RULES = Object.entries(LIFECYCLE_TABLE).flatMap(([event, entry]) => entry.rules.map(rule => ({ event, rule })))
const ruleValues = rule => rule.refuse ?? rule.require
const refusingValues = (rule) => {
  const universe = AXIS_VALUES[rule.axis]
  return rule.refuse ? [...rule.refuse] : universe.filter(value => !rule.require.includes(value))
}
const readsAs = value => value ?? 'unknown'

test('the matrix has rules to generate from, and a universe for every axis they read', () => {
  assert.ok(RULES.length > 0)
  for (const { event, rule } of RULES) {
    assert.ok(AXIS_VALUES[rule.axis], `${event}: add axis ${rule.axis} to AXIS_VALUES`)
    for (const value of ruleValues(rule)) assert.ok(AXIS_VALUES[rule.axis].includes(value), `${event}: ${rule.axis}=${String(value)} is not a value the snapshot can read`)
  }
  // The universe really is what the snapshot reads: a goal status that is not listed reads 'other'.
  const goalOf = status => lifecycleSnapshot({ activePlanKey: () => KEY, memory: { currentPlan: () => ({ status }) } }).goal
  for (const status of AXIS_VALUES.goal.filter(value => !['none', 'other', 'unknown'].includes(value))) assert.equal(goalOf(status), status)
  assert.equal(goalOf('something_new'), 'other')
  assert.equal(lifecycleSnapshot({ activePlanKey: () => KEY, memory: { currentPlan: () => undefined } }).goal, 'none')
})

for (const { event, rule } of RULES) {
  const detailsFor = () => ({ ...(rule.when ?? {}) })
  const stateAt = value => ({ [rule.axis]: value })
  const passes = (state, details) => lifecycleRefusal(event, state, details)?.reason !== rule.reason

  test(`matrix ${event} / ${rule.reason}: every refusing value refuses with that reason`, () => {
    const values = refusingValues(rule)
    assert.ok(values.length > 0, 'a rule that refuses nothing')
    for (const value of values) {
      assert.deepEqual(lifecycleRefusal(event, stateAt(value), detailsFor()), { reason: rule.reason, axis: rule.axis, value: readsAs(value) }, `${rule.axis}=${String(value)}`)
    }
    if (rule.require) {
      for (const value of ['unknown', 'none']) if (AXIS_VALUES[rule.axis].includes(value)) assert.ok(values.includes(value), `a require rule fails closed on ${value}`)
    }
  })

  test(`matrix ${event} / ${rule.reason}: at least one allowed value passes`, () => {
    const allowed = AXIS_VALUES[rule.axis].filter(value => !refusingValues(rule).includes(value))
    assert.ok(allowed.length > 0, 'a rule that refuses every value')
    for (const value of allowed) assert.ok(passes(stateAt(value), detailsFor()), `${rule.axis}=${String(value)}`)
  })

  test(`matrix ${event} / ${rule.reason}: an unreadable axis refuses only a require rule`, () => {
    for (const state of [{}, stateAt(undefined), stateAt('unknown')]) {
      assert.equal(passes(state, detailsFor()), Boolean(rule.refuse), JSON.stringify(state))
    }
  })

  test(`matrix ${event} / ${rule.reason}: a mismatched when-detail passes, a missing one too`, () => {
    const when = Object.entries(rule.when ?? {})
    if (when.length === 0) return // the rule applies to every call of the event
    for (const value of refusingValues(rule)) {
      for (const [name, expected] of when) {
        assert.ok(passes(stateAt(value), { ...detailsFor(), [name]: `not_${expected}` }), `${name} differs`)
        assert.ok(passes(stateAt(value), { ...detailsFor(), [name]: undefined }), `${name} missing`)
        const without = detailsFor()
        delete without[name]
        assert.ok(passes(stateAt(value), without), `${name} absent`)
      }
      assert.ok(passes(stateAt(value), undefined), 'no details at all')
    }
  })
}

test('an event with no rule refuses nothing, whatever the state', () => {
  for (const [event, entry] of Object.entries(LIFECYCLE_TABLE).filter(([, entry]) => entry.rules.length === 0)) {
    for (const goal of AXIS_VALUES.goal) assert.equal(lifecycleRefusal(event, { goal }, { role: 'executor', boundary: 'step' }), undefined, `${event} ${goal}: ${entry.open}`)
  }
  assert.equal(lifecycleRefusal('not_an_event', { goal: 'paused' }), undefined)
})

// ---------------------------------------------------------------------------------------
// 4. The coverage lint: a rule or a reset without a site scenario fails
// ---------------------------------------------------------------------------------------

// Key: a rule reason, or `reset:<event>`. Value: the title of the test on the real entry point that covers it.
const SITE_SCENARIOS = {
  executor_restage_on_closed_goal: 'site restage: an executor on a paused goal is refused before it swaps anything, and traced',
  checkpoint_requires_active_step: 'site checkpoint.persist: a completed goal throws checkpoint_requires_active_step',
  recovery_on_closed_goal: 'site recovery.interrupted: a goal still paused after the resume is refused before it rebuilds or runs',
  'reset:restage': 'site restage: an active goal restages and resets the decision counters',
  'reset:planner.return': 'site planner.return: returning to a parked planner resets the decision counters',
  'reset:epoch.rebuild': 'site epoch.rebuild: a planner reasoning-epoch rebuild resets the decision counters',
}

const siteTest = (key, fn) => test(SITE_SCENARIOS[key], fn)

// ---------------------------------------------------------------------------------------
// 2. Site scenarios on the real loop (the supervisor with a fake agent)
// ---------------------------------------------------------------------------------------

const PLAN = ['Mine 10 iron ore', 'Mine 10 copper ore']
const firstPlan = () => planReply({ plan: PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) })
const onePlan = () => planReply({ plan: ['Mine 10 iron ore'], currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) })

// The real loop against a fake Factorio with scripted planner replies (the context-restage.test.mjs harness, trimmed).
function loopWorld(replies) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const trace = []
  let calls = 0
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      const reply = replies[calls++]
      assert.ok(reply, `unscripted provider call ${calls}`)
      return reply
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'lifecycle scenario system prompt',
    executorHandoff: false, // the scenarios restage by hand
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const world = { game, memory, agent, trace }
  world.say = () => agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  world.packet = (overrides = {}) => buildHandoffPacket({ planningState: memory.planningState(KEY), role: 'executor', checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', now: 5000, ...overrides })
  world.rows = event => trace.filter(record => record.event === event)
  // lifecycleEnter writes its rows without awaiting them.
  world.settle = () => new Promise(resolve => setImmediate(resolve))
  return world
}

// A request that completed its one step: the goal reads completed.
async function completedWorld() {
  const world = loopWorld([onePlan(), planReply({ plan: [], currentStep: 0, operations: [] })])
  await world.say()
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  assert.equal(world.memory.currentPlan(KEY).status, 'completed')
  return world
}

// Every counter the table resets, set to a value the reset must change.
function dirtyCounters(agent, event) {
  const fields = Object.entries(lifecycleResets(event))
  assert.ok(fields.length > 0, `${event} resets nothing`)
  for (const [field, reset] of fields) agent[field] = typeof reset === 'boolean' ? !reset : reset + 3
  return fields
}
function assertCountersReset(agent, event) {
  for (const [field, reset] of Object.entries(lifecycleResets(event))) assert.equal(agent[field], reset, `${event}: ${field}`)
}

// Run H: the paused plan carries a model_recoverable pause (an auto-resume was about to restage onto it).
async function pausedWorld(pauseClass = PAUSE_CLASS.MODEL_RECOVERABLE, packetOverrides = {}) {
  const world = loopWorld([firstPlan()])
  await world.say()
  const packet = world.packet(packetOverrides) // built while the plan is active
  world.memory.pausePlan(KEY, 'provider_action_omission_repair_failed', { pause_class: pauseClass })
  assert.equal(world.memory.currentPlan(KEY).status, 'paused')
  return { world, packet }
}

siteTest('executor_restage_on_closed_goal', async () => {
  const { world, packet } = await pausedWorld(PAUSE_CLASS.MODEL_RECOVERABLE, { checkpoint: 'C7', reason: 'recovery:auto_resume_after_model_recoverable_pause' })
  const { agent, memory } = world
  const messages = agent.messages
  const baseMessages = agent.baseMessages
  const copy = structuredClone({ messages, baseMessages })
  const planning = memory.planningState(KEY)
  const planningCopy = structuredClone(planning)
  const handoffId = agent.agentContext.handoffId
  const role = agent.agentContext.role
  agent.traceRequest = null // a recovery runs between requests: the rows are filed under the request it names

  const result = await agent.restageContext({ checkpoint: 'C7', reason: 'recovery:auto_resume_after_model_recoverable_pause', packet, requestId: 'recovery_scenario' })
  await world.settle()

  assert.deepEqual(result, { restaged: false, reason: 'executor_restage_on_closed_goal' })
  assert.strictEqual(agent.messages, messages)
  assert.strictEqual(agent.baseMessages, baseMessages)
  assert.deepEqual({ messages: agent.messages, baseMessages: agent.baseMessages }, copy)
  assert.equal(agent.agentContext.handoffId, handoffId)
  assert.equal(agent.agentContext.role, role)
  assert.strictEqual(memory.planningState(KEY), planning, 'no reducer event was dispatched')
  assert.deepEqual(memory.planningState(KEY), planningCopy)
  assert.equal(world.rows('context.restaged').length, 0)
  const [refused] = world.rows('context.restage_refused')
  assert.equal(refused.data.reason, 'executor_restage_on_closed_goal')
  assert.equal(refused.data.role, 'executor')
  assert.equal(refused.request_id, 'recovery_scenario')
  const entered = world.rows('lifecycle.entered').find(row => row.data.event === 'restage')
  assert.equal(entered.data.state.goal, 'paused')
  assert.equal(entered.data.state.pause_class, 'model_recoverable')
  const [lifecycleRefused] = world.rows('lifecycle.refused')
  assert.deepEqual({ ...lifecycleRefused.data }, { event: 'restage', role: 'executor', checkpoint: 'C7', refusal: 'executor_restage_on_closed_goal', axis: 'goal', value: 'paused' })

  // A planner restage of the same paused goal is not narrowed by the rule.
  const planner = await agent.restageContext({ checkpoint: 'C1', role: 'planner', reason: 'r', packet: world.packet({ role: 'planner', checkpoint: 'C1', reason: 'planner_fresh_at_slice_close_no_parked_context' }), requestId: 'recovery_scenario' })
  assert.notEqual(planner.reason, 'executor_restage_on_closed_goal')
})

siteTest('reset:restage', async () => {
  const world = loopWorld([firstPlan()])
  await world.say()
  const { agent } = world
  assert.equal(agent.memory.currentPlan(KEY).status, 'active')
  const packet = world.packet()
  dirtyCounters(agent, 'restage')

  const result = await agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet, requestId: 'req_scenario' })
  await world.settle()

  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.equal(agent.agentContext.role, 'executor')
  assertCountersReset(agent, 'restage')
  assert.equal(world.rows('lifecycle.refused').length, 0)
  assert.equal(world.rows('lifecycle.entered').filter(row => row.data.event === 'restage').length, 1)
  assert.equal(world.rows('context.restaged').length, 1)

  // A refused restage leaves the counters alone: nothing was swapped, so the retries still count.
  const { world: paused, packet: pausedPacket } = await pausedWorld()
  dirtyCounters(paused.agent, 'restage')
  const refused = await paused.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: pausedPacket, requestId: 'req_scenario' })
  assert.equal(refused.restaged, false)
  for (const [field, reset] of Object.entries(lifecycleResets('restage'))) assert.notEqual(paused.agent[field], reset, `${field} survives a refusal`)
})

siteTest('checkpoint_requires_active_step', async () => {
  const world = await completedWorld()
  const { agent } = world
  agent.requestInfo = { ...agent.requestInfo, memoryKey: KEY }
  agent.traceRequest = { id: 'req_checkpoint', seq: 0 }

  await assert.rejects(
    () => agent.persistPlannerCheckpoint({ checkpoint: inventoryCheckpoint('iron-ore', 10), operations: [] }),
    { message: 'checkpoint_requires_active_step' },
  )
  await world.settle()

  const [refused] = world.rows('lifecycle.refused')
  assert.deepEqual({ ...refused.data }, { event: 'checkpoint.persist', refusal: 'checkpoint_requires_active_step', axis: 'goal', value: 'completed' })
  assert.equal(world.rows('step.checkpoint_validated').filter(row => row.request_id === 'req_checkpoint').length, 0, 'nothing was validated or persisted in this request')

  // Without a checkpoint nothing is persisted and nothing is asked of the goal.
  agent.traceRequest = { id: 'req_nocheckpoint', seq: 0 }
  await agent.persistPlannerCheckpoint({ operations: [] })
  await world.settle()
  assert.equal(world.rows('lifecycle.entered').filter(row => row.request_id === 'req_nocheckpoint').length, 0)
})

// A fake memory whose pause does not lift: resumePausedPlan claims it resumed but the goal still reads paused.
function stuckPausedAgent({ status = 'paused' } = {}) {
  const calls = { resume: 0, onResumed: 0, replaceConversation: 0, runGuarded: 0, traces: [] }
  const state = { status, pause_class: 'model_recoverable', pause_reason: 'provider_action_omission_repair_failed', owner: 'Louis', objective: 'Reach green science', task_board: { active_index: 0, steps: [{ id: 'step_1' }] } }
  const memory = {
    currentPlan: key => key === KEY ? state : undefined,
    planningState: () => ({
      active_plan_id: 'plan_a',
      plans: [{ plan_id: 'plan_a', status: PLAN_STATUS.EXECUTING, active_step_index: 0, steps: [{ step_id: 'step_1' }] }],
      run: { ...createEmptyRunState(), paused: status === 'paused', pause_class: status === 'paused' ? 'model_recoverable' : '' },
    }),
    resumePausedPlan: () => { calls.resume++; return { resumed: true, pause_class: 'model_recoverable', step_id: 'step_1', state } },
    context: () => '[PLAN_STATE] {"status":"paused"}',
  }
  const agent = {
    npcId: 'sgluna',
    memory,
    systemPrompt: 'system',
    turnSequence: 0,
    active: false,
    traceRequest: null,
    loadPersistentState: async () => {},
    persistState: async () => {},
    cancel() { this.active = false },
    captureEpoch: async () => ({ actor_id: 3, epoch: 8 }),
    async traceEvent(event, data, options) { calls.traces.push({ event, data, requestId: options?.requestId }) },
    // The real entry point, reading the real snapshot of this fake.
    lifecycleEnter(event, details, options) { return NpcAgentLoop.prototype.lifecycleEnter.call(this, event, details, options) },
    replaceConversation({ baseMessages }) { calls.replaceConversation++; this.baseMessages = baseMessages; this.messages = baseMessages.map(message => ({ ...message })) },
    async runGuarded() { calls.runGuarded++; return { chatMessage: '' } },
  }
  return { agent, calls, state }
}

siteTest('recovery_on_closed_goal', async () => {
  const { agent, calls } = stuckPausedAgent()
  const recovery = await recoverInterruptedAgentPlan(agent, 'auto_resume_after_model_recoverable_pause', { attempt: 1 }, {
    allowModelRecoverable: true,
    requestId: 'recovery_scenario',
    reactivate: { pause_classes: [PAUSE_CLASS.MODEL_RECOVERABLE], onResumed: () => { calls.onResumed++ } },
  })

  assert.equal(calls.resume, 1, 'the resume ran and claimed success')
  assert.equal(calls.onResumed, 1)
  assert.equal(agent.memory.currentPlan(KEY).status, 'paused', 'and the goal still reads paused')
  assert.equal(recovery.recovered, false)
  assert.equal(recovery.reason, 'lifecycle_refused')
  assert.equal(recovery.refusal, 'recovery_on_closed_goal')
  assert.equal(recovery.state.status, 'paused')
  assert.equal(calls.replaceConversation, 0, 'the conversation was not rebuilt')
  assert.equal(calls.runGuarded, 0, 'no turn ran')
  assert.equal(agent.requestInfo, undefined)
  assert.equal(agent.active, false)
  await new Promise(resolve => setImmediate(resolve))
  const refused = calls.traces.filter(row => row.event === 'lifecycle.refused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].requestId, 'recovery_scenario')
  // The refusal rides its own field, so the recovery's own reason survives in both rows.
  assert.deepEqual({ ...refused[0].data }, { event: 'recovery.interrupted', reason: 'auto_resume_after_model_recoverable_pause', boundary: 'step', refusal: 'recovery_on_closed_goal', axis: 'goal', value: 'paused' })
  const entered = calls.traces.find(row => row.event === 'lifecycle.entered')
  assert.equal(entered.data.reason, 'auto_resume_after_model_recoverable_pause')
  assert.equal(entered.data.boundary, 'step')
  assert.equal(calls.traces.some(row => row.event === 'runtime.recovery_started'), false)

  // The same recovery on an active goal is not refused: it rebuilds the conversation and runs its turn.
  const active = stuckPausedAgent({ status: 'active' })
  const ok = await recoverInterruptedAgentPlan(active.agent, 'runtime_restart', {}, { requestId: 'recovery_scenario_ok' })
  assert.equal(ok.recovered, true, JSON.stringify(ok))
  assert.equal(active.calls.replaceConversation, 1)
  assert.equal(active.calls.runGuarded, 1)
  assert.equal(active.calls.traces.some(row => row.event === 'lifecycle.refused'), false)
})

siteTest('reset:planner.return', async () => {
  const world = loopWorld([firstPlan()])
  await world.say()
  const { agent } = world
  const restaged = await agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet: world.packet(), parkPlanner: true, requestId: 'req_scenario' })
  assert.equal(restaged.restaged, true)
  assert.equal(agent.agentContext.hasParkedPlanner, true)
  assert.equal(agent.agentContext.role, 'executor')
  agent.epoch = await agent.captureEpoch()
  dirtyCounters(agent, 'planner.return')

  const returned = await agent.returnControlToPlanner({ route: 'slice_close', requestId: 'req_scenario' })

  assert.deepEqual(returned, { returned: true, resumed: true })
  assert.equal(agent.agentContext.role, 'planner')
  assertCountersReset(agent, 'planner.return')
})

siteTest('reset:epoch.rebuild', async () => {
  const world = loopWorld([firstPlan()])
  await world.say()
  const { agent, memory } = world
  assert.equal(agent.agentContext.role, 'planner')
  agent.requestInfo = { ...agent.requestInfo, sender: 'Louis', text: 'mine 10 iron then 10 copper' }
  // The loop last saw another reasoning epoch than the reducer holds now.
  agent.planningReasoningEpochSeen.set(KEY, memory.planningReasoningEpoch(KEY) + 7)
  dirtyCounters(agent, 'epoch.rebuild')

  assert.equal(agent.refreshPlanningReasoningEpoch(), true)

  assertCountersReset(agent, 'epoch.rebuild')
  assert.equal(agent.planningReasoningEpochSeen.get(KEY), memory.planningReasoningEpoch(KEY))
  assert.equal(agent.messages.at(-1).content, '[CHAT] Louis: mine 10 iron then 10 copper', 'the planner conversation was rebuilt from the request')

  // The executor keeps its conversation across a bump, and the table resets nothing for it.
  const executorWorld = loopWorld([firstPlan()])
  await executorWorld.say()
  await executorWorld.agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet: executorWorld.packet(), requestId: 'req_scenario' })
  executorWorld.agent.requestInfo = { ...executorWorld.agent.requestInfo, sender: 'Louis', text: 'x' }
  executorWorld.agent.planningReasoningEpochSeen.set(KEY, executorWorld.memory.planningReasoningEpoch(KEY) + 7)
  dirtyCounters(executorWorld.agent, 'epoch.rebuild')
  assert.equal(executorWorld.agent.refreshPlanningReasoningEpoch(), false)
  for (const [field, reset] of Object.entries(lifecycleResets('epoch.rebuild'))) assert.notEqual(executorWorld.agent[field], reset, `${field} is the executor's own`)
})

// ---------------------------------------------------------------------------------------
// 3. Run G, H and J, replayed from a scrubbed fixture of the retained corpus
// ---------------------------------------------------------------------------------------

const fixture = JSON.parse(await fsp.readFile(FIXTURE_FILE, 'utf8'))
const jsonl = rows => `${rows.map(row => JSON.stringify({ schema: 1, event: row.event, data: row.data })).join('\n')}\n`

test('the fixture carries identifiers only: no text, hosts, urls or keys', () => {
  const text = JSON.stringify(fixture)
  assert.doesNotMatch(text, /https?:|:\/\/|\bwww\.|\.(?:com|net|org|io|dev|ai)\b|api[_-]?key|token|secret|authorization/i)
  const strings = []
  JSON.stringify(fixture, (key, value) => { if (typeof value === 'string' && !['note', 'scrubbed'].includes(key)) strings.push(value); return value })
  for (const value of strings) assert.match(value, /^[A-Za-z0-9_:.-]{1,120}$/, 'identifier-shaped strings only')
  assert.ok(text.length < 10_000, 'a small fixture')
  assert.equal(fixture.cases.length, 3)
})

for (const replay of fixture.cases) {
  test(`corpus ${replay.name}: the scan flags the executor restage on the paused plan`, async () => {
    const { rows, errors } = parseLines(jsonl(replay.rows))
    assert.equal(errors, 0)
    const { flags } = scanLifecycle(rows)
    assert.deepEqual(flags.map(flag => [flag.kind, flag.index]), [['executor_restage_while_paused', rows.length - 1]])
    assert.deepEqual({ goal: flags[0].state.goal, run: flags[0].state.run, pause_class: flags[0].state.pause_class, role: flags[0].state.role }, { goal: 'paused', run: 'paused', pause_class: 'model_recoverable', role: 'executor' })

    // Through the file reader the retained logs use.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifecycle-fixture-'))
    try {
      const file = path.join(dir, 'sgluna-behavior.jsonl')
      await fsp.writeFile(file, jsonl(replay.rows))
      const scanned = await scanRun(file)
      assert.equal(scanned.rows, replay.rows.length)
      assert.deepEqual(scanned.flags.map(flag => flag.kind), ['executor_restage_while_paused'])
    }
    finally { await fsp.rm(dir, { recursive: true, force: true }) }
  })

  test(`corpus ${replay.name}: the table refuses each lifecycle event the run made on the paused plan`, () => {
    const { rows } = parseLines(jsonl(replay.rows))
    const items = projectLifecycle(rows)
    const restage = items.at(-1)
    assert.equal(restage.lifecycle_event, 'restage.executor')
    assert.deepEqual(lifecycleRefusal('restage', restage.state, { role: 'executor' }), { reason: 'executor_restage_on_closed_goal', axis: 'goal', value: 'paused' })
    assert.equal(lifecycleRefusal('restage', restage.state, { role: 'planner' }), undefined, 'the planner may still be restaged')
    const recovery = items.find(item => item.lifecycle_event === 'recovery.interrupted')
    assert.equal(recovery?.state.goal, 'paused', 'the recovery started with the goal paused')
    assert.equal(lifecycleRefusal('recovery.interrupted', recovery.state, { boundary: 'step' })?.reason, 'recovery_on_closed_goal')
    assert.equal(recovery.state.pause_class, 'model_recoverable')
  })

  test(`corpus ${replay.name}: the real restage site refuses the replayed state`, async () => {
    const pauseClass = replay.rows.find(row => row.event === 'goal.paused').data.pause_class
    const restaged = replay.rows.at(-1).data
    assert.equal(restaged.role, 'executor')
    const { world, packet } = await pausedWorld(pauseClass, { checkpoint: restaged.checkpoint, reason: restaged.reason })
    const result = await world.agent.restageContext({ checkpoint: restaged.checkpoint, reason: restaged.reason, packet, requestId: 'recovery_replay' })
    assert.deepEqual(result, { restaged: false, reason: 'executor_restage_on_closed_goal' })
    assert.equal(world.rows('context.restaged').length, 0)
  })
}

test('corpus run J: the checkpoint on a completed goal is refused at its site and the scan flags what the site now traces', async () => {
  const replay = fixture.run_j
  const [persisted, failed] = replay.rows
  assert.equal(persisted.data.task_board.status, 'completed')
  assert.equal(failed.data.message, 'checkpoint_requires_active_step')
  assert.equal(failed.data.pause_class, 'system')

  // The refused persist wrote no row in run J. The site now traces lifecycle.entered with the state it refused in:
  // take that row from the real loop in the fixture's state (a completed board) and scan both.
  const world = await completedWorld()
  world.agent.requestInfo = { ...world.agent.requestInfo, memoryKey: KEY }
  world.agent.traceRequest = { id: 'req_replay_j', seq: 0 }
  await assert.rejects(() => world.agent.persistPlannerCheckpoint({ checkpoint: inventoryCheckpoint('iron-ore', 10), operations: [] }), { message: failed.data.message })
  await world.settle()
  const entered = world.rows('lifecycle.entered').find(row => row.request_id === 'req_replay_j' && row.data.event === 'checkpoint.persist')
  assert.equal(entered.data.state.goal, persisted.data.task_board.status)

  const { rows } = parseLines(jsonl([persisted, { event: entered.event, data: entered.data }]))
  const { flags } = scanLifecycle(rows)
  assert.deepEqual(flags.map(flag => [flag.kind, flag.event, flag.state.goal]), [['checkpoint_on_inactive_goal', 'checkpoint.persist', 'completed']])
  assert.equal(lifecycleRefusal('checkpoint.persist', { goal: persisted.data.task_board.status })?.reason, failed.data.message)
})

// ---------------------------------------------------------------------------------------
// 4. The coverage lint
// ---------------------------------------------------------------------------------------

test('every rule reason and every resetting event has exactly one site scenario in this file', async () => {
  const wanted = [
    ...RULES.map(({ rule }) => rule.reason),
    ...Object.entries(LIFECYCLE_TABLE).filter(([, entry]) => Object.keys(entry.resets).length > 0).map(([event]) => `reset:${event}`),
  ].sort()
  assert.deepEqual(Object.keys(SITE_SCENARIOS).sort(), wanted, 'SITE_SCENARIOS must list exactly the table\'s rule reasons and resetting events')
  assert.equal(new Set(wanted).size, wanted.length, 'a reason is used by one rule')
  assert.equal(new Set(Object.values(SITE_SCENARIOS)).size, wanted.length, 'one title per scenario')

  const source = await fsp.readFile(fileURLToPath(import.meta.url), 'utf8')
  const defined = [...source.matchAll(/siteTest\('([^']+)'/g)].map(match => match[1]).sort()
  assert.deepEqual(defined, wanted, 'each key is covered by one siteTest, and no siteTest is for an unlisted key')
  for (const title of Object.values(SITE_SCENARIOS)) assert.match(title, /^site [a-z_.]+: /, 'a title names its site')
})
