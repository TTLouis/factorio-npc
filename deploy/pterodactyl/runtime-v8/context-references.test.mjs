import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { findDanglingReferences, scanPromptRows } from './context-references.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const SYSTEM = { role: 'system', content: 'The [ENTITY_STATUS_BASELINE] and [STATIC_PROTOTYPE_CACHE] blocks explain diff/unchanged replies.' }

const entityStatus = (mode, reference = 'entity:55', extra = {}) => JSON.stringify({
  observation_mode: mode,
  source: 'live_factorio_entity_status',
  reference,
  query: { name: 'stone-furnace', unit_number: 55 },
  ...extra,
})

const nearby = (mode, query) => JSON.stringify({ observation_mode: mode, source: 'live_factorio_nearby_entities', query, entities: [] })

function toolExchange(id, name, args, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content },
  ]
}

test('a diff whose full observation is in the same request resolves', () => {
  const messages = [
    SYSTEM,
    ...toolExchange('a', 'getEntityStatus', { unit_number: 55 }, entityStatus('full', 'entity:55', { found: true })),
    ...toolExchange('b', 'getEntityStatus', { unit_number: 55 }, entityStatus('unchanged')),
  ]
  assert.deepEqual(findDanglingReferences(messages), [])
})

test('an unchanged entity status with no full observation and no baseline block dangles', () => {
  const messages = [SYSTEM, { role: 'user', content: '[HANDOFF] stable block' }, ...toolExchange('b', 'getEntityStatus', { unit_number: 55 }, entityStatus('unchanged'))]
  assert.deepEqual(findDanglingReferences(messages), [{ kind: 'entity_status', severity: 'high', key: 'entity:55', mode: 'unchanged', message_index: 3, role: 'tool' }])
})

test('the baseline block provides the reference; a different reference still dangles', () => {
  const block = `[ENTITY_STATUS_BASELINE] Last live mutable entity-status snapshots.\n${JSON.stringify([{ reference: 'entity:55', query: {}, found: true }])}`
  const messages = [
    SYSTEM,
    { role: 'user', content: block },
    ...toolExchange('b', 'getEntityStatus', {}, entityStatus('diff', 'entity:55', { changes: { entity: { status: 'working' } } })),
    ...toolExchange('c', 'getEntityStatus', {}, entityStatus('diff', 'entity:77', { changes: {} })),
  ]
  assert.deepEqual(findDanglingReferences(messages).map(item => item.key), ['entity:77'])
})

test('a baseline mentioned only in the system prompt does not count', () => {
  const messages = [SYSTEM, ...toolExchange('b', 'getEntityStatus', {}, entityStatus('unchanged'))]
  assert.equal(findDanglingReferences(messages).length, 1)
})

test('nearby queries match regardless of key order, and the nearby baseline block resolves them', () => {
  const full = nearby('full', { radius: 20, name: 'stone-furnace', limit: 10 })
  const unchanged = nearby('unchanged', { name: 'stone-furnace', limit: 10, radius: 20 })
  assert.deepEqual(findDanglingReferences([SYSTEM, ...toolExchange('a', 'getNearbyEntities', {}, full), ...toolExchange('b', 'getNearbyEntities', {}, unchanged)]), [])
  const block = `[NEARBY_ENTITIES_BASELINE] snapshots\n${JSON.stringify([{ query: { limit: 10, radius: 20, name: 'stone-furnace' }, entities: [] }])}`
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: block }, ...toolExchange('b', 'getNearbyEntities', {}, unchanged)]), [])
  const other = nearby('diff', { radius: 30, name: 'stone-furnace', limit: 10 })
  assert.equal(findDanglingReferences([SYSTEM, { role: 'user', content: block }, ...toolExchange('c', 'getNearbyEntities', {}, other)])[0].kind, 'nearby_entities')
})

test('a static prototype "unchanged" resolves against the cache block, a cached_static reply, or a raw read of the same name', () => {
  const unchanged = JSON.stringify({ observation_mode: 'unchanged', source: 'runtime_static_prototype_cache', reference: 'prototype:offshore-pump', note: 'already present' })
  const repeat = toolExchange('r', 'getPrototypeDetails', { name: 'offshore-pump' }, unchanged)
  assert.equal(findDanglingReferences([SYSTEM, ...repeat])[0].kind, 'static_prototype')
  const block = `[STATIC_PROTOTYPE_CACHE] facts\n${JSON.stringify([{ reference: 'prototype:offshore-pump', found: true }])}`
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: block }, ...repeat]), [])
  const cached = JSON.stringify({ observation_mode: 'cached_static', source: 'runtime_static_prototype_cache', reference: 'prototype:offshore-pump', found: true })
  assert.deepEqual(findDanglingReferences([SYSTEM, ...toolExchange('c', 'getPrototypeDetails', { name: 'offshore-pump' }, cached), ...repeat]), [])
  const raw = JSON.stringify({ found: true, query: 'offshore-pump', entity: { name: 'offshore-pump' } })
  assert.deepEqual(findDanglingReferences([SYSTEM, ...toolExchange('w', 'getPrototypeDetails', { name: 'offshore-pump' }, raw), ...repeat]), [])
  assert.equal(findDanglingReferences([SYSTEM, ...toolExchange('w', 'getPrototypeDetails', { name: 'boiler' }, raw), ...repeat]).length, 1)
})

test('a task receipt diff embedded in prose is found; it is low severity and resolved by any full task status', () => {
  const diff = '[MOD] Autorio operation batch completed. Detailed task receipt: {"observation_mode":"diff","task_state":"idle","queue_empty":true,"queue_length":0,"last_completed_batch":{"batch_id":9,"task_count":1,"task_types":["walking_to_entity"],"tick":37702}}'
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: diff }]), [{ kind: 'task_status', severity: 'low', key: 'task_status', mode: 'diff', message_index: 1, role: 'user' }])
  const full = '[MOD] receipt: {"observation_mode":"full","task_state":"running","queue_empty":false,"queue_length":2}'
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: full }, { role: 'user', content: diff }]), [])
})

test('strings containing braces and unrelated JSON do not confuse extraction', () => {
  const tricky = `note "{" ${entityStatus('unchanged', 'entity:9', { label: 'a } b { c' })} trailing }`
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: tricky }]).map(item => item.key), ['entity:9'])
  assert.deepEqual(findDanglingReferences([SYSTEM, { role: 'user', content: '{"observation_mode":"diff"' }]), [], 'an unterminated object is skipped')
  assert.deepEqual(findDanglingReferences('not messages'), [])
})

test('scanPromptRows reports each violation once per request and names the last swap before it', () => {
  const dangling = [SYSTEM, ...toolExchange('b', 'getEntityStatus', {}, entityStatus('unchanged'))]
  const rows = [
    { event: 'provider.request', ts: '2026-10-19T10:00:00.000Z', request_id: 'req_1', round: 1, payload: { messages: [SYSTEM] } },
    { event: 'provider.request', ts: '2026-10-19T10:00:02.000Z', request_id: 'req_1', round: 2, payload: { messages: dangling } },
    { event: 'provider.request', ts: '2026-10-19T10:00:03.000Z', request_id: 'req_1', round: 3, payload: { messages: [...dangling, { role: 'user', content: 'more' }] } },
  ]
  const behavior = [{ event: 'context.restaged', ts: '2026-10-19T10:00:01.000Z', request_id: 'req_1' }]
  const { requests, findings } = scanPromptRows(rows, behavior)
  assert.equal(requests, 3)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].round, 2)
  assert.equal(findings[0].after_swap, 'context.restaged')
  assert.equal(scanPromptRows(rows).findings[0].after_swap, undefined)
})

test('run-check: high-severity dangling rows are findings, task receipt diffs are informational', () => {
  const row = (severity, kind, key) => ({ schema: 1, ts: '2026-10-19T10:00:00.000Z', event: 'context.dangling_reference', request_id: 'req_1', data: { severity, kind, key, mode: 'unchanged' } })
  const report = analyzeBehaviorTrace([row('high', 'static_prototype', 'prototype:offshore-pump'), row('low', 'task_status', 'task_status')])
  assert.deepEqual(report.findings.map(finding => finding.signature), ['dangling_context_reference'])
  assert.match(report.findings[0].detail, /static_prototype:prototype:offshore-pump/)
  assert.deepEqual(report.informational.map(item => item.signature), ['dangling_task_receipt_diff'])
  assert.deepEqual(analyzeBehaviorTrace([row('low', 'task_status', 'task_status')]).findings, [])
})

// ---------------------------------------------------------------------------------------
// The live seam: the loop traces the invariant at every provider request
// ---------------------------------------------------------------------------------------

const KEY = 'npc:sgluna'
const PLAN = ['Mine 10 iron ore', 'Mine 10 copper ore']

class PrototypeFactorio extends FakeFactorio {
  async command(text) {
    if (text.includes('remote.call("autorio_prototypes","details"')) {
      return JSON.stringify({ found: true, query: 'offshore-pump', entity: { name: 'offshore-pump', type: 'offshore-pump', tile_width: 1, tile_height: 2 } })
    }
    return super.command(text)
  }
}

const prototypeRead = id => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'getPrototypeDetails', arguments: '{"name":"offshore-pump"}' } }],
})

function harness(replies) {
  const game = new PrototypeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const trace = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const reply = replies[calls.length - 1]
      assert.ok(reply, `unscripted provider call ${calls.length}`)
      return reply
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'dangling reference loop system prompt',
    executorHandoff: false,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  return { game, memory, agent, calls, trace }
}

test('a run without a conversation swap never sends a dangling reference', async () => {
  const world = harness([
    prototypeRead('p1'),
    planReply({ plan: PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) }),
    prototypeRead('p2'),
    planReply({ plan: PLAN, currentStep: 1, operations: [gather('copper-ore', 10)] }),
  ])
  await world.agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  assert.ok(world.calls.length >= 4)
  for (const [index, messages] of world.calls.entries()) assert.deepEqual(findDanglingReferences(messages), [], `provider call ${index}`)
  assert.equal(world.trace.filter(row => row.event === 'context.dangling_reference').length, 0)
})

// The latent bug the 10-19 analysis found by reading: a restage kept the
// request's prototype refs although its conversation had no
// [STATIC_PROTOTYPE_CACHE], so a repeat read could answer "already present"
// about nothing. B1 binds the refs to the conversation: the repeat read in the
// new conversation answers with the full cached facts.
test('after a restage, a repeat prototype read answers with full cached facts and nothing dangles', async (t) => {
  const world = harness([
    prototypeRead('p1'),
    planReply({ plan: PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) }),
    prototypeRead('p2'),
    planReply({ plan: PLAN, currentStep: 1, operations: [gather('copper-ore', 10)] }),
  ])
  await world.agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  const packet = buildHandoffPacket({ planningState: world.memory.planningState(KEY), role: 'executor', checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', now: 5000 })
  const restaged = await world.agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet, softLimitTokens: 100000 })
  assert.equal(restaged.restaged, true)
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()

  const sent = world.calls.map(messages => findDanglingReferences(messages))
  const traced = world.trace.filter(row => row.event === 'context.dangling_reference')
  const sentKeys = new Set(sent.flat().map(item => `${item.kind}:${item.key}`))
  assert.deepEqual(new Set(traced.map(row => `${row.data.kind}:${row.data.key}`)), sentKeys, 'every dangling reference that was sent is traced, and nothing else')
  for (const row of traced) {
    assert.equal(typeof row.data.conversation_seq, 'number')
    assert.ok(['high', 'low'].includes(row.data.severity))
  }
  const report = analyzeBehaviorTrace(world.trace)
  const flagged = report.findings?.some(finding => finding.signature === 'dangling_context_reference') ?? false
  assert.equal(flagged, traced.some(row => row.data.severity === 'high'), 'run-check reports high-severity dangling references')
  // Recorded for the A1 report: which way the current loop goes.
  const repeatCall = world.calls.find(messages => messages.some(message => message.role === 'tool' && message.tool_call_id === 'p2'))
  assert.ok(repeatCall, 'the repeat read reached the provider after the restage')
  const repeat = repeatCall.find(message => message.tool_call_id === 'p2').content
  const cacheVisible = repeatCall.some(message => String(message.content ?? '').startsWith('[STATIC_PROTOTYPE_CACHE]'))
  assert.equal(JSON.parse(repeat).observation_mode, 'cached_static')
  assert.equal(JSON.parse(repeat).reference, 'prototype:offshore-pump')
  assert.deepEqual(traced.filter(row => row.data.severity === 'high'), [])
  t.diagnostic(`prototype after restage: repeat=${JSON.parse(repeat).observation_mode ?? 'raw'} cache_block=${cacheVisible} dangling=${[...sentKeys].join(', ') || 'none'}`)
})

test('a dangling reference after a folded review handback is attributed to that swap', () => {
  const dangling = [SYSTEM, ...toolExchange('b', 'getEntityStatus', {}, entityStatus('unchanged'))]
  const rows = [{ event: 'provider.request', ts: '2026-10-19T10:00:02.000Z', request_id: 'req_1', round: 2, payload: { messages: dangling } }]
  const behavior = [
    { event: 'context.planner_resumed', ts: '2026-10-19T10:00:00.000Z', request_id: 'req_1' },
    { event: 'context.restage_folded', ts: '2026-10-19T10:00:01.000Z', request_id: 'req_1' },
  ]
  assert.equal(scanPromptRows(rows, behavior).findings[0].after_swap, 'context.restage_folded')
})
