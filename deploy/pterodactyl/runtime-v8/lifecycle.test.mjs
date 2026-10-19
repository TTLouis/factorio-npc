import assert from 'node:assert/strict'
import test from 'node:test'

import { LIFECYCLE_EVENTS, LIFECYCLE_SITES, LIFECYCLE_TABLE, lifecycleRefusal, lifecycleResets, lifecycleSnapshot } from './lifecycle.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { createEmptyRunState } from './planning-state.mjs'
import { findMethodBody, LOOP_STATE_FIELDS, readLoopSources, stripCommentsAndStrings } from './state-scopes.mjs'

const sources = readLoopSources()

// ---------------------------------------------------------------------------------------
// C1: every entry point passes through lifecycleEnter with its own event
// ---------------------------------------------------------------------------------------

test('every lifecycle site exists and calls lifecycleEnter', () => {
  const missing = []
  for (const site of LIFECYCLE_SITES) {
    const text = sources[site.owner]
    const body = text === undefined ? null : findMethodBody(stripCommentsAndStrings(text), site.site, { owner: site.owner, fn: site.fn === true })
    if (body === null) missing.push(`${site.owner}#${site.site}: not found`)
    else if (!/\blifecycleEnter(?:\?\.)?\(/.test(body)) missing.push(`${site.owner}#${site.site}: no lifecycleEnter call`)
  }
  assert.deepEqual(missing, [])
})

test('each owner calls lifecycleEnter exactly once per listed event, and with no unlisted event', () => {
  const owners = [...new Set(LIFECYCLE_SITES.map(site => site.owner))]
  for (const owner of owners) {
    const calls = [...sources[owner].matchAll(/\blifecycleEnter(?:\?\.)?\('([a-z_.]+)'/g)].map(match => match[1]).sort()
    const listed = LIFECYCLE_SITES.filter(site => site.owner === owner).map(site => site.event).sort()
    assert.deepEqual(calls, listed, `${owner}: lifecycleEnter events do not match LIFECYCLE_SITES`)
  }
  assert.equal(LIFECYCLE_EVENTS.length, LIFECYCLE_SITES.length, 'one site per event')
})

// ---------------------------------------------------------------------------------------
// The snapshot: existing fields only, 'unknown' when an axis cannot be read
// ---------------------------------------------------------------------------------------

test('a bare agent reads unknown on every axis it cannot see', () => {
  assert.deepEqual(lifecycleSnapshot({}), {
    goal: 'unknown', board_step: null, run: 'unknown', pause_class: null, plan: 'unknown', step: null,
    role: 'unknown', parked_planner: null, batch: 'unknown', pending_operation: null, request: 'unknown', provider_recovery: null,
  })
})

const plannedMemory = ({ status = 'active', paused = false, pauseClass = '', planStatus = 'EXECUTING', pending = null } = {}) => ({
  currentPlan: () => ({ status, task_board: { active_index: 1, steps: [{ id: 'step_1' }, { id: 'step_2' }] } }),
  planningState: () => ({
    active_plan_id: 'plan_a',
    plans: [{ plan_id: 'plan_a', status: planStatus, active_step_index: 1, steps: [{ step_id: 'step_1' }, { step_id: 'step_2' }] }],
    run: { ...createEmptyRunState(), paused, pause_class: pauseClass, pending_operation: pending },
  }),
})

test('the snapshot reads the board, the reducer run and plan, the role, the batch and the request', () => {
  const agent = new NpcAgentLoop({ rcon: { command: async () => '' }, provider: async () => ({ content: '' }), systemPrompt: 'x', stateFile: null, traceFile: null, decisionTraceFile: null })
  agent.memory = plannedMemory({ status: 'paused', paused: true, pauseClass: 'model_recoverable', pending: { operation_key: 'k' } })
  agent.batchInFlight = true
  agent.active = true
  const state = lifecycleSnapshot(agent)
  assert.equal(state.goal, 'paused')
  assert.equal(state.board_step, 'step_2')
  assert.equal(state.run, 'paused')
  assert.equal(state.pause_class, 'model_recoverable')
  assert.equal(state.plan, 'EXECUTING')
  assert.equal(state.step, 'step_2')
  assert.equal(state.role, 'planner')
  assert.equal(state.parked_planner, false)
  assert.equal(state.batch, 'in_flight')
  assert.equal(state.pending_operation, true)
  assert.equal(state.request, 'active')
})

test('a running plan reads no pause class, and a goal without a board reads none', () => {
  const running = lifecycleSnapshot({ activePlanKey: () => 'npc:x', memory: plannedMemory(), batchInFlight: false, active: false })
  assert.equal(running.run, 'running')
  assert.equal(running.pause_class, null)
  assert.equal(running.batch, 'idle')
  assert.equal(running.request, 'idle')
  const empty = lifecycleSnapshot({ activePlanKey: () => 'npc:x', memory: { currentPlan: () => undefined } })
  assert.equal(empty.goal, 'none')
  assert.equal(empty.plan, 'unknown', 'no reducer memory: the plan axis cannot be read')
})

test('lifecycleEnter writes one lifecycle.entered row inside a request and none outside it', async () => {
  const agent = new NpcAgentLoop({ rcon: { command: async () => '' }, provider: async () => ({ content: '' }), systemPrompt: 'x', stateFile: null, traceFile: null, decisionTraceFile: null })
  const rows = []
  agent.traceEvent = async (event, data) => { rows.push({ event, data }) }
  agent.lifecycleEnter('reset')
  assert.deepEqual(rows, [], 'no request is open, so there is no request id to file the row under')
  agent.traceRequest = { id: 'req_1', seq: 0 }
  agent.lifecycleEnter('slice.close', { route: 'r' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'lifecycle.entered')
  assert.equal(rows[0].data.event, 'slice.close')
  assert.equal(rows[0].data.route, 'r')
  assert.equal(rows[0].data.state.role, 'planner')
})

// ---------------------------------------------------------------------------------------
// C2: the transition table, its refusals and its counter resets
// ---------------------------------------------------------------------------------------

const AXES = Object.keys(lifecycleSnapshot({}))
const GOALS = ['none', 'active', 'paused', 'completed', 'blocked', 'cancelled', 'other', 'unknown']
const siteOf = event => LIFECYCLE_SITES.find(site => site.event === event)
const strippedBody = site => findMethodBody(stripCommentsAndStrings(sources[site.owner]), site.site, { owner: site.owner, fn: site.fn === true })

test('the table lists every event once, and an event without a rule says why none is enforced', () => {
  assert.deepEqual(Object.keys(LIFECYCLE_TABLE).sort(), [...LIFECYCLE_EVENTS].sort())
  for (const [event, entry] of Object.entries(LIFECYCLE_TABLE)) {
    assert.ok(Array.isArray(entry.rules), event)
    assert.equal(typeof entry.resets, 'object', event)
    if (entry.rules.length === 0) assert.ok(typeof entry.open === 'string' && entry.open.length > 10, `${event}: no rule and no reason`)
    for (const rule of entry.rules) {
      assert.ok(AXES.includes(rule.axis), `${event}: unknown axis ${rule.axis}`)
      assert.ok(rule.reason && rule.evidence, `${event}: a rule names its refusal reason and its evidence`)
      assert.ok(Boolean(rule.refuse) !== Boolean(rule.require), `${event}: a rule either refuses values or requires them`)
      if (rule.axis === 'goal') for (const value of rule.refuse ?? rule.require) assert.ok(GOALS.includes(value), `${event}: goal ${value}`)
      assert.ok(!(rule.refuse ?? []).includes('unknown'), `${event}: an unreadable axis is never evidence of a wrong state`)
    }
  }
})

test('every site with a rule acts on the refusal, and every other site cannot', () => {
  for (const site of LIFECYCLE_SITES) {
    const body = strippedBody(site)
    const consumes = /=\s*(?:this|agent)\.lifecycleEnter(?:\?\.)?\(/.test(body)
    assert.equal(consumes, LIFECYCLE_TABLE[site.event].rules.length > 0, `${site.owner}#${site.site}: ${consumes ? 'reads a refusal no rule can give' : 'ignores the refusal its rule gives'}`)
  }
})

test('every event that resets counters applies them at its site, and the counters are declared loop state', () => {
  const calls = Object.values(sources).flatMap(text => [...text.matchAll(/\bapplyLifecycleResets\('([a-z_.]+)'\)/g)].map(match => match[1])).sort()
  const resetting = LIFECYCLE_EVENTS.filter(event => Object.keys(lifecycleResets(event)).length > 0).sort()
  assert.deepEqual(calls, resetting)
  for (const event of resetting) {
    assert.match(strippedBody(siteOf(event)), /\bapplyLifecycleResets\(/, event)
    for (const field of Object.keys(lifecycleResets(event))) assert.ok(LOOP_STATE_FIELDS[field], `${event}: ${field} is not a declared loop field`)
  }
})

test('the executor is never restaged onto a closed goal; the planner and an unreadable goal are not refused', () => {
  for (const goal of ['paused', 'completed', 'cancelled']) {
    assert.equal(lifecycleRefusal('restage', { goal }, { role: 'executor' })?.reason, 'executor_restage_on_closed_goal', goal)
    assert.equal(lifecycleRefusal('restage', { goal }, { role: 'planner' }), undefined, `planner ${goal}`)
  }
  for (const goal of ['active', 'blocked', 'unknown', 'none']) assert.equal(lifecycleRefusal('restage', { goal }, { role: 'executor' }), undefined, goal)
})

test('a checkpoint needs an active goal, and an unreadable goal fails closed as the inline check did', () => {
  assert.equal(lifecycleRefusal('checkpoint.persist', { goal: 'active' }), undefined)
  for (const goal of ['completed', 'paused', 'none', 'unknown']) assert.deepEqual(lifecycleRefusal('checkpoint.persist', { goal }), { reason: 'checkpoint_requires_active_step', axis: 'goal', value: goal })
})

test('a step recovery refuses a closed goal; a slice-boundary recovery is not narrowed', () => {
  assert.equal(lifecycleRefusal('recovery.interrupted', { goal: 'paused' }, { boundary: 'step' })?.reason, 'recovery_on_closed_goal')
  assert.equal(lifecycleRefusal('recovery.interrupted', { goal: 'paused' }, { boundary: 'plan_slice' }), undefined)
  assert.equal(lifecycleRefusal('recovery.interrupted', { goal: 'active' }, { boundary: 'step' }), undefined)
})

test('lifecycleEnter returns the refusal and traces it, under a named request when none is open', () => {
  const agent = new NpcAgentLoop({ rcon: { command: async () => '' }, provider: async () => ({ content: '' }), systemPrompt: 'x', stateFile: null, traceFile: null, decisionTraceFile: null })
  const rows = []
  agent.traceEvent = async (event, data, options) => { rows.push({ event, data, options }) }
  agent.memory = plannedMemory({ status: 'paused', paused: true, pauseClass: 'model_recoverable' })
  const refusal = agent.lifecycleEnter('restage', { role: 'executor', checkpoint: 'C7' }, { requestId: 'recovery_1' })
  assert.deepEqual(refusal, { reason: 'executor_restage_on_closed_goal', axis: 'goal', value: 'paused' })
  assert.deepEqual(rows.map(row => [row.event, row.options?.requestId]), [['lifecycle.entered', 'recovery_1'], ['lifecycle.refused', 'recovery_1']])
  assert.equal(rows[1].data.refusal, 'executor_restage_on_closed_goal')
  agent.toolValidationRetries = 2
  agent.planCategoryRetries = 1
  agent.finiteNoOperationPressureUsed = true
  agent.applyLifecycleResets('restage')
  assert.deepEqual([agent.toolValidationRetries, agent.planCategoryRetries, agent.finiteNoOperationPressureUsed], [0, 0, false])
  agent.toolValidationRetries = 2
  agent.applyLifecycleResets('continuation')
  assert.equal(agent.toolValidationRetries, 2, 'the continuation resets its counters itself')
})
