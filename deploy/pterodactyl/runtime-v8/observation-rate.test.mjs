import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { OBSERVATION_RATE, observationRateClaim, restoreObservationRates } from './observation-rate.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, planReply, answersStepContract } from './task-loop-fixtures.mjs'

test('executor burst replenishes without accumulating unbounded credit or credit on clock rollback', () => {
  const spent = observationRateClaim(undefined, 4, 100_000)
  assert.equal(spent.admitted, true)
  assert.equal(spent.state.tokens, 0)
  assert.equal(observationRateClaim(spent.state, 1, 114_999).retryAfterMs, 1)
  const next = observationRateClaim(spent.state, 1, 115_000)
  assert.equal(next.admitted, true)
  assert.equal(next.state.tokens, 0)
  assert.equal(observationRateClaim(next.state, 1, 90_000).admitted, false)
  const full = observationRateClaim(next.state, 4, 1_000_000)
  assert.equal(full.admitted, true)
  assert.equal(observationRateClaim(full.state, 1, 1_000_000).admitted, false)
  assert.equal(observationRateClaim(spent.state, 4, 130_000).retryAfterMs, 30_000)
  for (const count of [-1, 5, 1.2, Number.NaN]) assert.throws(() => observationRateClaim(undefined, count, 0))
})

test('snapshot restore retains spent tokens and malformed buckets do not become a free burst', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.executorObservationRates = new Map([['sgluna', observationRateClaim(undefined, 4, 100_000).state]])
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.deepEqual(restored.executorObservationRates.get('sgluna'), { tokens: 0, at: 100_000 })
  assert.equal(observationRateClaim(restored.executorObservationRates.get('sgluna'), 1, 100_001).admitted, false)
  const malformed = restoreObservationRates([['sgluna', { tokens: 999, at: -1 }]])
  const claim = observationRateClaim(malformed.get('sgluna'), 1, 100_000)
  assert.equal(claim.admitted, false)
  assert.equal(claim.retryAfterMs, OBSERVATION_RATE.refillMs)
})

const reads = (...names) => ({ content: '', tool_calls: names.map((name, index) => ({ id: `${name}-${index}`, type: 'function',
  function: { name: 'getNearbyEntities', arguments: JSON.stringify({ name, radius: 8, limit: 4 }) } })) })
const key = 'npc:sgluna'
function fixture(options = {}) {
  let now = 100_000
  const sleeps = []
  const events = []
  const calls = []
  const memory = options.memory ?? new CanonicalTaskBoardMemory()
  const game = new FakeFactorio()
  const commands = []
  const native = game.command.bind(game)
  game.command = async text => { commands.push(text); return native(text) }
  const provider = answersStepContract(async (messages, context) => {
    calls.push({ context, messages })
    if (context.role === 'planner') return planReply({ plan: ['Gather ten coal.'], currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Have ten coal.', doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 10 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'coal', minimum: 10 }] } }],
      executionGuidance: [{ approach: 'Gather coal.', rationale: 'Use fresh local facts.', constraints: [], skillIds: [], materialSupply: null }],
    })
    const index = calls.filter(call => call.context.role === 'executor').length
    if (options.reply) return options.reply(index, { agent, game, memory })
    if (index === 1) return reads('tree-01', 'rock-huge', 'coal', 'stone')
    if (index === 2) {
      assert.equal(context.allowTools, true, 'spending the burst does not permanently close reads')
      return reads('iron-ore')
    }
    assert.equal(index, 3, 'rate waits do not invoke the provider')
    const plan = getActivePlan(memory.planningState(key))
    return planReply({ stepId: plan.steps[plan.active_step_index].step_id,
      operations: [{ name: 'gather_resource', args: { resource_name: 'coal', count: 10 } }] })
  })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', completionProtocolVersion: 3,
    executorObservationRate: true, replacementWake: true, stateFile: null, traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Rate fixture.', interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    observationRateClock: { now: () => now, sleep: options.sleep ?? (async (ms, signal) => { signal.throwIfAborted(); sleeps.push(ms); now += ms; await options.onSleep?.() }) },
    onActivity: (event, data) => events.push({ event, data }) })
  return { agent, memory, game, sleeps, events, calls, commands }
}

test('full loop can read beyond a burst, waits in harness, then admits the grounded action', async () => {
  const world = fixture()
  await world.agent.request('Gather ten coal.', { sender: 'Louis' })
  assert.deepEqual(world.sleeps, [15_000])
  assert.equal(world.calls.length, 4, 'one planner and three executor calls')
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.agent.observationRateAbort, null)
  assert.equal(world.memory.executorObservationRates.get('sgluna').tokens, 0)
  const rates = world.events.filter(row => row.event.startsWith('observation.rate_'))
  assert.equal(rates.filter(row => row.event === 'observation.rate_wait').length, 1)
  assert.ok(rates.every(row => row.data.request_id && row.data.reason), 'rate decisions are request-correlated')
  assert.equal(world.events.some(row => row.event === 'observation.forced_decision' && /jev_observation_budget/.test(row.data.reason_code)), false)
})

test('cache hits are free, but live re-establishing reads are charged; handoffs and resets do not mint tokens', async () => {
  const world = fixture()
  await world.agent.request('Gather ten coal.', { sender: 'Louis' })
  const before = structuredClone(world.memory.executorObservationRates.get('sgluna'))
  const cached = reads('iron-ore')
  await world.agent.handleToolBatch(cached)
  assert.deepEqual(world.memory.executorObservationRates.get('sgluna'), before)
  await world.agent.startExecutorObservationDecision({ requestId: 'handoff-test', reason: 'test_handoff' })
  assert.deepEqual(world.memory.executorObservationRates.get('sgluna'), before)
  world.agent.toolCache.clear()
  await world.agent.handleToolBatch(cached)
  assert.deepEqual(world.sleeps, [15_000, 15_000], 'a native read is charged even if its lost result is being re-established')
  const after = structuredClone(world.memory.executorObservationRates.get('sgluna'))
  world.agent.reset()
  assert.deepEqual(world.memory.executorObservationRates.get('sgluna'), after)
})

for (const stop of ['cancel', 'reset', 'stale']) {
  test(`rate wait ${stop} cannot read or write into the replacement request`, async () => {
    let enter
    const entered = new Promise(resolve => { enter = resolve })
    let release
    const waiting = new Promise(resolve => { release = resolve })
    const world = fixture({ sleep: async (_ms, signal) => {
      enter()
      if (stop === 'stale') { await waiting; return }
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('wait aborted')), { once: true }))
    } })
    const running = world.agent.request('Gather ten coal.', { sender: 'Louis' }).catch(error => error)
    await entered
    const atBoundary = world.commands.length
    if (stop === 'stale') { world.agent.agentContext.beginLineage(); world.agent.generation++ }
    else world.agent[stop]()
    const ledger = structuredClone([...world.memory.executorObservationRates])
    release()
    await running
    assert.equal(world.game.mutations.length, 0)
    assert.equal(world.commands.slice(atBoundary).some(text => text.includes('get_nearby_entities')), false, 'no stale native read follows the wait')
    assert.deepEqual([...world.memory.executorObservationRates], ledger)
    assert.equal(world.agent.observationRateAbort, null)
  })
}

test('strict rate persistence rejects before native reads when durable writing fails', async () => {
  const world = fixture()
  world.agent.agentContext.beginLineage('executor')
  world.agent.persistState = async ({ strict }) => { assert.equal(strict, true); throw new Error('disk full') }
  const before = world.commands.length
  await assert.rejects(world.agent.claimExecutorObservationRate(1, () => {}), /disk full/)
  assert.equal(world.commands.length, before)
  assert.equal(world.agent.observationRateAbort, null)
})

test('targeted eligibility changing during refill cannot debit or run an unchanged-fact preread', async () => {
  let armed = false
  let eligible = true
  const world = fixture({ onSleep: () => { if (armed) eligible = false } })
  await world.agent.request('Gather ten coal.', { sender: 'Louis' })
  world.agent.toolCache.clear()
  const before = structuredClone([...world.memory.executorObservationRates])
  const commandCount = world.commands.length
  const message = { content: '', tool_calls: [{ id: 'targeted-inventory', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] }
  const prepared = world.agent.prepareToolBatch(message)
  prepared._sglunaTargetedRecovery = true
  prepared[0]._sglunaReadFence = async () => { if (!eligible) throw new Error('targeted eligibility changed') }
  armed = true
  await assert.rejects(world.agent.handleToolBatch(message, prepared), /targeted eligibility changed/)
  assert.deepEqual([...world.memory.executorObservationRates], before)
  assert.equal(world.commands.slice(commandCount).some(text => /get_inventory_items/.test(text)), false)
})

test('relevance-deferred discovery tools never consume fresh-read tokens', async () => {
  const world = fixture()
  await world.agent.request('Gather ten coal.', { sender: 'Louis' })
  world.agent.toolCache.clear()
  world.agent.observationRelevanceOverride = []
  const beforeSleeps = world.sleeps.length
  const before = world.commands.length
  await world.agent.handleToolBatch(reads('tree-02', 'copper-ore', 'uranium-ore', 'water'))
  assert.deepEqual(world.sleeps.slice(beforeSleeps), [15_000], 'one discovery read admitted by tier, three deferred')
  assert.equal(world.commands.slice(before).filter(text => text.includes('get_nearby_entities')).length, 1)
  const admission = world.events.filter(row => row.event === 'observation.partial_admission').at(-1)
  assert.equal(admission.data.admitted_count, 1)
  assert.equal(admission.data.deferred_count, 3)
})

test('deployed supervisor selects rate policy; historical callers and no-progress/closed-round guards retain their limits', async () => {
  const source = await readFile(new URL('./supervisor.mjs', import.meta.url), 'utf8')
  assert.match(source, /new NpcAgentLoop\(\{\s*completionProtocolVersion: 3,\s*executorObservationRate: true/)
  const world = fixture()
  world.agent.agentContext.beginLineage('executor')
  assert.equal(world.agent.observationDecisionPressureBudget(), 1, 'base no-progress allowance stays finite')
  world.agent.closedRoundObservationUsed = true
  assert.equal(world.agent.controlDecisionState(false).targetedAllowanceUsed, true)
  world.agent.executorObservationRate = false
  world.agent.observationBudgetRemaining = 0
  assert.equal(world.agent.observationDecisionPressureBudget(), 0, 'legacy decision-cap replay stays supported')
})
