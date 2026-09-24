import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  classifyDecisionFallback,
  emptyJevHealth,
  JEV_MEASUREMENT,
  recordJevHealth,
  summarizeJevHealth,
} from './jev-health.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { liveAgentDebugEvent } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

test('fallback reasons from the live adapter are classified by failure kind', () => {
  const cases = [
    ['Decision provider state contains an unsupported value', 'request_contract'],
    ['Decision provider request exceeds 16000 characters', 'request_contract'],
    ['Decision request must contain 1 to 16 questions', 'request_contract'],
    ['Decision question scope_review_reason_codes has an unsupported type', 'request_contract'],
    ['Decision provider timed out after 5000 ms', 'timeout'],
    ['Decision provider request cancelled', 'cancelled'],
    ['Hourly provider request budget reached; recovery reserve preserved', 'budget'],
    ['Decision provider HTTP 429; request will not be retried automatically', 'rate_limited'],
    ['Decision provider HTTP 502; request will not be retried automatically', 'http'],
    ['Decision provider is not configured', 'not_configured'],
    ['Decision provider answer route returned an unknown choice', 'response_contract'],
    ['Decision provider returned invalid JSON', 'response_contract'],
    ['fetch failed', 'transport'],
    ['steering development answer is missing', 'runtime_parse'],
    ['', 'unknown'],
  ]
  for (const [reason, kind] of cases) assert.equal(classifyDecisionFallback(reason), kind, reason)
})

test('measurement is valid only when Jev was actually asked well-formed questions', () => {
  assert.equal(summarizeJevHealth(emptyJevHealth(), { configured: false }).measurement, JEV_MEASUREMENT.JEV_OFF)
  assert.equal(summarizeJevHealth(emptyJevHealth()).measurement, JEV_MEASUREMENT.NO_CALLS)

  const healthy = emptyJevHealth()
  for (let index = 0; index < 4; index++) {
    recordJevHealth(healthy, 'decision.request', { contract: 'post_step_planner_gate' })
    recordJevHealth(healthy, 'decision.response', { contract: 'post_step_planner_gate' })
  }
  recordJevHealth(healthy, 'decision.request', { contract: 'recovery_route' })
  recordJevHealth(healthy, 'decision.fallback', { contract: 'recovery_route', reason: 'Decision provider timed out after 5000 ms' })
  const summary = summarizeJevHealth(healthy)
  assert.equal(summary.measurement, JEV_MEASUREMENT.VALID)
  assert.equal(summary.fallback_rate_percent, 20)
  assert.deepEqual(summary.by_contract.recovery_route, { requests: 1, responses: 0, fallbacks: 1 })
  assert.deepEqual(summary.by_kind, { timeout: 1 })

  recordJevHealth(healthy, 'decision.request', { contract: 'recovery_route' })
  recordJevHealth(healthy, 'decision.fallback', { contract: 'recovery_route', reason: 'fetch failed' })
  assert.equal(summarizeJevHealth(healthy).measurement, JEV_MEASUREMENT.DEGRADED, 'above the fallback-rate limit')

  // One harness-built malformed request is enough: Jev never saw the question.
  const malformed = emptyJevHealth()
  for (let index = 0; index < 9; index++) recordJevHealth(malformed, 'decision.request', { contract: 'interaction_route' })
  recordJevHealth(malformed, 'decision.fallback', {
    contract: 'interaction_route',
    reason: 'Decision provider state contains an unsupported value',
    fallback_target: 'interaction_router',
  })
  const degraded = summarizeJevHealth(malformed)
  assert.equal(degraded.measurement, JEV_MEASUREMENT.DEGRADED)
  assert.deepEqual(degraded.last_fallback, {
    contract: 'interaction_route',
    kind: 'request_contract',
    reason: 'Decision provider state contains an unsupported value',
    target: 'interaction_router',
  })
})

test('a request whose Jev calls all fall back is logged, surfaced live, and marked degraded', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const logs = []
  const activity = []
  // Reproduces the 2026-09-24 live failure: the adapter rejects every call in
  // milliseconds, and the loop silently carries on without Jev.
  const jev = recordingJev(async () => {
    throw new Error('Decision provider state contains an unsupported value')
  })
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      checkpoint: inventoryCheckpoint('iron-ore', 10),
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'jev health',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    log: message => logs.push(message),
    onActivity: (event, data) => activity.push({ event, data }),
  })

  await agent.request('gather 10 iron ore', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.ok(jev.calls.length > 0, 'the scenario must reach at least one Jev boundary')
  assert.ok(logs.some(line => /^\[jev\] fallback contract=\S+ kind=request_contract /.test(line)), 'each fallback is logged with its contract and kind')

  const live = activity.filter(entry => entry.event === 'jev.health')
  assert.ok(live.some(entry => entry.data.outcome === 'fallback'))
  assert.equal(live.at(-1).data.measurement, JEV_MEASUREMENT.DEGRADED)

  const terminal = activity.find(entry => ['request.completed', 'request.failed'].includes(entry.event))
  assert.ok(terminal, 'the request reached a terminal event')
  assert.equal(terminal.data.jev_health.measurement, JEV_MEASUREMENT.DEGRADED)
  assert.equal(terminal.data.jev_health.fallbacks, terminal.data.jev_health.requests)
  assert.ok(logs.some(line => line.startsWith('[jev] request measurement degraded:')))

  // The Debug UI reads the same health the loop reported.
  let debug
  for (const { event, data } of activity) debug = liveAgentDebugEvent(event, data, debug)
  assert.equal(debug.jev_measurement, JEV_MEASUREMENT.DEGRADED)
  assert.equal(debug.jev_request_fallback_percent, 100)
  assert.ok(debug.decision_fallbacks_total >= 1)
  assert.match(debug.jev_last_fallback, / · request_contract · Decision provider state contains an unsupported value$/)
})

test('a run with no decision provider reports Jev as off, not as a failed measurement', async () => {
  const game = new FakeFactorio()
  const activity = []
  const agent = new NpcAgentLoop({
    rcon: game,
    memory: new CanonicalTaskBoardMemory(),
    provider: async () => planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      checkpoint: inventoryCheckpoint('iron-ore', 10),
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'jev off',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    onActivity: (event, data) => activity.push({ event, data }),
  })

  await agent.request('gather 10 iron ore', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.equal(activity.some(entry => entry.event === 'jev.health'), false)
  const terminal = activity.find(entry => ['request.completed', 'request.failed'].includes(entry.event))
  assert.ok(terminal)
  assert.equal(terminal.data.jev_health.measurement, JEV_MEASUREMENT.JEV_OFF)
})
