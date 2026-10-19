import assert from 'node:assert/strict'
import test from 'node:test'

import { LIFECYCLE_EVENTS, LIFECYCLE_SITES, lifecycleSnapshot } from './lifecycle.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { createEmptyRunState } from './planning-state.mjs'
import { findMethodBody, readLoopSources, stripCommentsAndStrings } from './state-scopes.mjs'

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
