import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentContext, conversationChars, STALE_REPLY_ERROR_CODE } from './agent-context.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { sanitizeDurableModelText } from './durable-text.mjs'
import { buildHandoffPacket, sanitizeHandoffNote } from './handoff-packet.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, getContextRestages, PLAN_STATUS } from './planning-state.mjs'
import { analyzeBehaviorTrace, DELEGATION_TRACE_ROWS } from './run-check.mjs'
import { STEAM_SCRIPTED_BLOCKED_ANSWER, steamReplayHarness } from './steam-run-fixtures.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_FILE = path.join(here, 'fixtures', 'context-restage', 'no-restage-steam-replay.golden.json')

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16)

// Timestamps, latencies and the random parts of generated ids are the only
// nondeterministic parts of a replay; everything else in a row must be
// byte-stable. Ids are replaced by first-seen placeholders, so a structural
// change (an id moving, appearing or vanishing) still changes the hash.
function normalizeRow(record, ids) {
  const text = JSON.stringify(record, (key, value) => {
    if (key === 'ts') return '<ts>'
    if (/(?:_ms|_at|_share|_seconds)$/.test(key) && typeof value === 'number') return 0
    return value
  })
  const placeholder = (id, label) => {
    if (!ids.has(id)) ids.set(id, `<${label}${ids.size + 1}>`)
    return ids.get(id)
  }
  return text
    .replace(/(?<!\d)1[6-9]\d{11}(?!\d)/g, '<epoch_ms>')
    .replace(/\breq_[a-z0-9]+_\d+/g, id => placeholder(id, 'req'))
    .replace(/\bgoal_[a-z0-9]{4,10}_\d+/g, id => placeholder(id, 'goal'))
    .replace(/(?<=_s\d+_)[a-z0-9]{4,10}(?![a-z0-9])/g, id => placeholder(id, 'sid'))
}

// The whole steam replay (recorded usage, 300-rule system prompt, tool results
// at their recorded sizes) through the real loop and the real provider stack.
// Captured: the exact HTTP body of every provider call, the context object the
// provider received, and every behavior-trace row.
async function steamReplayFingerprint() {
  const world = steamReplayHarness({ transport: 'http', extraRounds: [STEAM_SCRIPTED_BLOCKED_ANSWER] })
  await world.request()
  await world.closeStep1()
  await world.failSupplyBatch()
  const requestIds = new Map()
  const rows = world.trace.map(record => normalizeRow(record, requestIds))
  const calls = world.calls.map(call => ({
    body: sha(normalizeRow(call.body, requestIds)),
    context: sha(normalizeRow(call.context, requestIds)),
    messages: call.body.messages.length,
  }))
  return {
    calls,
    trace: world.trace.map((record, index) => ({ event: record.event, sha: sha(rows[index]) })),
  }
}

test('a run that never restages sends the same provider requests and writes the same trace rows', async () => {
  const actual = await steamReplayFingerprint()
  if (process.env.UPDATE_RESTAGE_GOLDEN === '1') {
    await fsp.mkdir(path.dirname(GOLDEN_FILE), { recursive: true })
    await fsp.writeFile(GOLDEN_FILE, `${JSON.stringify(actual, null, 2)}\n`)
  }
  const golden = JSON.parse(await fsp.readFile(GOLDEN_FILE, 'utf8'))
  assert.equal(actual.calls.length, golden.calls.length)
  assert.equal(actual.trace.length, golden.trace.length)
  golden.calls.forEach((expected, index) => assert.deepEqual(actual.calls[index], expected, `provider call ${index}`))
  golden.trace.forEach((expected, index) => assert.deepEqual(actual.trace[index], expected, `trace row ${index} (${expected.event})`))
})

// ---------------------------------------------------------------------------------------
// AgentContext (pure)
// ---------------------------------------------------------------------------------------

function fakePacket(overrides = {}) {
  return {
    stableText: '[HANDOFF] stable block',
    volatileText: '--- step block ---\nactive_step: 1',
    handoff_id: 'ho_0123456789ab',
    hash: '9f2c41d07a3be518',
    chars: 60,
    estimated_tokens: 15,
    event: { role: 'executor', checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit' },
    ...overrides,
  }
}

function seededContext() {
  const context = new AgentContext({ config: { models: ['planner-model', 'executor-model'], base: 'https://p.test/v1', key: 'k' } })
  context.baseMessages = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: '[CHAT] Louis: get steam going' },
  ]
  context.messages = [
    ...context.baseMessages,
    { role: 'assistant', content: 'plan', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'getInventory', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(4000) },
  ]
  return context
}

test('restage swaps in a fresh conversation: system prefix unchanged, then the packet stable block, then its volatile block', () => {
  const context = seededContext()
  const packet = fakePacket()
  const before = conversationChars(context.messages)
  const result = context.restage({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet })

  assert.deepEqual(context.messages, [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: packet.stableText },
    { role: 'user', content: packet.volatileText },
  ])
  assert.deepEqual(context.baseMessages, context.messages, 'the base conversation is the restaged one, so continuations rebuild from it')
  assert.notStrictEqual(context.messages, context.baseMessages)
  assert.equal(result.previous.message_count, 4)
  assert.equal(result.previous_context_chars, before)
  assert.equal(context.role, 'executor')
  assert.equal(context.model, 'executor-model', 'the role picks its model through agent-roles')
})

test('restage resets the counters and the size counter and assigns the packet handoff id', () => {
  const context = seededContext()
  const first = context.beginRequest(50000)
  context.observeReply(first, { input_units: 12000, output_units: 800 })
  assert.equal(context.counters.requests, 1)
  assert.equal(context.counters.replies, 1)
  assert.equal(context.counters.input_tokens, 12000)
  assert.equal(context.counters.output_units, 800)
  assert.equal(context.sizeTokens, 12500, 'chars/4 of the request outweighs the reported input here')
  const initialId = context.handoffId
  assert.match(initialId, /^ho_initial_\d+$/)

  const result = context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() })

  assert.equal(context.handoffId, 'ho_0123456789ab')
  assert.notEqual(context.handoffId, initialId)
  assert.deepEqual(context.counters, { requests: 0, replies: 0, input_tokens: 0, output_units: 0, last_input_tokens: 0 })
  assert.equal(context.sizeTokens, 0)
  assert.equal(context.restageCount, 1)
  assert.equal(result.previous.size_tokens, 12500)
  assert.equal(result.previous.counters.input_tokens, 12000)
})

test('the size counter falls back to chars/4 before the first reply and never falls back after growth', () => {
  const context = seededContext()
  context.beginRequest(40000)
  assert.equal(context.sizeTokens, 10000, 'no reply yet: chars / 4')
  const grown = context.beginRequest(60000)
  assert.equal(context.sizeTokens, 15000, 'only the growth is added')
  context.observeReply(grown, { input_units: 21000 })
  assert.equal(context.sizeTokens, 21000, 'provider-reported input tokens win once they exceed the estimate')
  context.beginRequest(20000) // a compaction fold shrank the prompt
  assert.equal(context.sizeTokens, 21000, 'monotonic: a fold does not hide growth')
})

test('role and handoff_id attribution is off until the first restage, then both fields appear together', () => {
  const context = seededContext()
  const before = context.beginRequest(1000)
  assert.deepEqual(context.traceFields(before), {})
  assert.deepEqual(context.providerContextFields(before), {})

  context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() })
  const after = context.beginRequest(1000)
  assert.deepEqual(context.traceFields(after), { role: 'executor', handoff_id: 'ho_0123456789ab' })
  assert.deepEqual(context.providerContextFields(after), { role: 'executor' })

  // The request sent before the restage is now stale and is attributed (both fields) so its drop row can be paired.
  assert.equal(context.isStale(before), true)
  assert.deepEqual(context.traceFields(before), { role: 'planner', handoff_id: before.handoffId })
  assert.equal(context.isStale(after), false)

  // A new lineage (the loop was reset for a new chat request) is unrestaged again.
  context.beginLineage()
  assert.equal(context.delegationActive, false)
  assert.deepEqual(context.traceFields(context.beginRequest(1)), {})
  assert.equal(context.isStale(after), false, 'a reply that outlives a reset is left to the generation check')
  assert.equal(context.observeReply(after, { input_units: 5 }), false, 'and is never counted into the new lineage')
})

test('a restage that does not fit its packet is refused before anything changes', () => {
  const context = seededContext()
  const messages = context.messages
  assert.throws(() => context.restage({ checkpoint: 'C9', reason: 'r', packet: fakePacket() }), /checkpoint/)
  assert.throws(() => context.restage({ checkpoint: 'C4', reason: 'r', packet: fakePacket() }), /does not match the packet's checkpoint/)
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', role: 'planner', packet: fakePacket() }), /does not match the packet's role/)
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket({ stableText: '' }) }), /stableText/)
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', packet: undefined }), /handoff packet/)
  assert.strictEqual(context.messages, messages)
  assert.equal(context.restageCount, 0)
  context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() })
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() }), /already the active conversation/)
  assert.equal(context.restageCount, 1)
})

// ---------------------------------------------------------------------------------------
// The loop seam
// ---------------------------------------------------------------------------------------

const KEY = 'npc:airi'
const PLAN = ['Mine 10 iron ore', 'Mine 10 copper ore']

function deferred() {
  const gate = {}
  gate.promise = new Promise((resolve, reject) => {
    gate.resolve = resolve
    gate.reject = reject
  })
  return gate
}

const firstPlan = () => planReply({
  plan: PLAN,
  currentStep: 0,
  operations: [gather('iron-ore', 10)],
  checkpoint: inventoryCheckpoint('iron-ore', 10),
})
const secondPlan = () => planReply({ plan: PLAN, currentStep: 1, operations: [gather('copper-ore', 10)] })

// The real loop against a fake Factorio, with scripted planner replies.
// `replies[n]` answers provider call n: a reply, or a function (messages, context) returning a promise.
function loopHarness(replies) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const trace = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages, context) => {
      calls.push({ messages, context })
      const reply = replies[calls.length - 1]
      assert.ok(reply, `unscripted provider call ${calls.length}`)
      return typeof reply === 'function' ? reply(messages, context) : reply
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'restage loop system prompt',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const world = { game, memory, agent, calls, trace }
  world.say = () => agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  world.finish = (resource, count = 10) => {
    game.inventory[resource] = (game.inventory[resource] ?? 0) + count
    return agent.completed()
  }
  world.packet = (overrides = {}) => buildHandoffPacket({
    planningState: memory.planningState(KEY),
    role: 'executor',
    checkpoint: 'C3',
    reason: 'executor_fresh_at_plan_commit',
    now: 5000,
    ...overrides,
  })
  world.rows = event => trace.filter(record => record.event === event)
  world.waitForProviderCall = async (count = 1) => {
    for (let spin = 0; spin < 500 && calls.length < count; spin++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(calls.length >= count, `provider call ${count} never happened`)
  }
  return world
}

test('restageContext dispatches CONTEXT_RESTAGED, the reducer log records it, and plan semantics are untouched', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  const before = world.memory.planningState(KEY)
  const plan = getActivePlan(before)
  assert.equal(plan.status, PLAN_STATUS.COMMITTED)
  assert.equal(getContextRestages(before).length, 0)

  const packet = world.packet()
  const result = await world.agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet, softLimitTokens: 100000 })

  assert.equal(result.restaged, true)
  const after = world.memory.planningState(KEY)
  const restages = getContextRestages(after)
  assert.equal(restages.length, 1)
  assert.equal(restages[0].role, 'executor')
  assert.equal(restages[0].checkpoint, 'C3')
  assert.equal(restages[0].plan_id, plan.plan_id)
  assert.equal(restages[0].packet_chars, packet.chars)
  assert.deepEqual({ ...after, context_restages: before.context_restages }, before, 'nothing but the restage ledger changed: plan, tracker, sequence and reasoning epoch stand')
  assert.equal(after.reasoning_epoch, before.reasoning_epoch)
  assert.equal(world.agent.agentContext.handoffId, packet.handoff_id)
  assert.deepEqual(world.agent.messages.map(message => message.role), ['system', 'user', 'user'])
  assert.equal(world.agent.messages[0].content, world.calls[0].messages[0].content, 'the system prefix is unchanged')
  assert.equal(world.agent.messages[1].content, packet.stableText)
  assert.equal(world.agent.messages[2].content, packet.volatileText)
})

test('the next provider request after a restage starts with the system prefix, the packet stable block, then its volatile block, and none of the earlier messages', async () => {
  const world = loopHarness([firstPlan(), secondPlan()])
  await world.say()
  const packet = world.packet()
  await world.agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet })
  await world.finish('iron-ore')

  assert.equal(world.calls.length, 2)
  const { messages, context } = world.calls[1]
  assert.equal(messages[0].content, world.calls[0].messages[0].content)
  assert.equal(messages[1].content, packet.stableText)
  assert.equal(messages[2].content, packet.volatileText)
  assert.ok(!messages.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')), 'the old request text is gone')
  assert.equal(context.role, 'executor', 'the provider is told which role this conversation runs as')
  assert.equal(Object.hasOwn(world.calls[0].context, 'role'), false, 'and was not told before any restage')

  const request = world.rows('provider.request').at(-1)
  assert.equal(request.data.role, 'executor')
  assert.equal(request.data.handoff_id, packet.handoff_id)
  const response = world.rows('provider.response').at(-1)
  assert.equal(response.data.role, 'executor')
  assert.equal(response.data.handoff_id, packet.handoff_id)
  for (const early of [world.rows('provider.request')[0], world.rows('provider.response')[0]]) {
    assert.equal(Object.hasOwn(early.data, 'role'), false, 'rows written before the restage are unchanged')
    assert.equal(Object.hasOwn(early.data, 'handoff_id'), false)
  }
})

test('the context.restaged row has exactly the DELEGATION_TRACE_ROWS shape, and analyzeBehaviorTrace finds nothing wrong in a healthy restaged run', async () => {
  const world = loopHarness([firstPlan(), secondPlan()])
  await world.say()
  const packet = world.packet()
  await world.agent.restageContext({ checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', packet, softLimitTokens: 100000 })
  await world.finish('iron-ore')

  const [row] = world.rows(DELEGATION_TRACE_ROWS.events.restaged)
  assert.ok(row, 'a context.restaged row was written')
  assert.ok(row.request_id, 'the row carries the request id every detector groups by')
  const example = DELEGATION_TRACE_ROWS.examples.restaged
  assert.deepEqual(Object.keys(row.data).sort(), Object.keys(example.data).sort())
  assert.equal(row.data.role, 'executor')
  assert.equal(row.data.checkpoint, 'C3')
  assert.equal(row.data.handoff_id, packet.handoff_id)
  assert.equal(row.data.packet_hash, packet.hash)
  assert.equal(row.data.packet_chars, packet.chars)
  assert.equal(row.data.packet_estimated_tokens, packet.estimated_tokens)
  assert.ok(row.data.previous_context_chars > 0)
  assert.equal(row.data.reason, 'executor_fresh_at_plan_commit')
  assert.equal(row.data.plan_id, getActivePlan(world.memory.planningState(KEY)).plan_id)
  assert.match(row.data.step_id, /_s1_/)
  assert.equal(row.data.soft_limit_tokens, 100000)

  const result = analyzeBehaviorTrace(world.trace)
  const delegation = ['restage_loop', 'restage_packet_oversize', 'stale_reply_not_dropped']
  assert.deepEqual(result.findings.filter(finding => delegation.includes(finding.signature)), [])
  assert.deepEqual(result.findings, [], 'a healthy scripted run has no findings at all')
})

test('a restage the reducer refuses restages nothing and says so', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  const packet = world.packet()
  const messages = world.agent.messages
  const handoffId = world.agent.agentContext.handoffId
  packet.event = { ...packet.event, goal_id: 'goal_from_another_run' }

  const result = await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })

  assert.deepEqual(result, { restaged: false, reason: 'reducer_rejected_context_restaged' })
  assert.strictEqual(world.agent.messages, messages)
  assert.equal(world.agent.agentContext.handoffId, handoffId)
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  assert.equal(world.rows('context.restaged').length, 0)
  assert.equal(world.rows('context.restage_refused').length, 1)
  await assert.rejects(() => world.agent.restageContext({ checkpoint: 'C1', reason: 'r', packet }), /does not match the packet's checkpoint/)
})

test('stale reply: a reply that returns after a restage mid-request is dropped, traced, never appended and never admitted', async (t) => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise])
  // A failed request would normally reset the loop and wipe the conversation; keep it so the test can look.
  t.mock.method(world.agent, 'reset', () => {})
  const settled = world.say().then(() => undefined, error => error)
  await world.waitForProviderCall(1)
  const staleId = world.agent.agentContext.handoffId // the conversation the in-flight request belongs to

  const packet = world.packet()
  const restaged = await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })
  assert.equal(restaged.restaged, true)
  const restagedMessages = world.agent.messages.map(message => ({ ...message }))

  gate.resolve(firstPlan()) // the reply of the discarded conversation arrives now
  const error = await settled

  assert.match(String(error?.message), /cancelled or superseded/)
  assert.equal(error.code, STALE_REPLY_ERROR_CODE)
  assert.equal(world.calls.length, 1, 'no retry or recovery call followed the drop')
  assert.equal(world.game.mutations.length, 0, 'nothing from the stale reply reached admission')
  assert.deepEqual(world.agent.messages, restagedMessages, 'nothing from the stale reply was appended to the active conversation')
  assert.equal(world.memory.planningState(KEY).plans.length, 0, 'and no plan was drafted from it')

  const [dropped] = world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped)
  assert.ok(dropped, 'a context.stale_reply_dropped row was written')
  assert.equal(dropped.request_id, world.rows('provider.request')[0].request_id)
  assert.deepEqual(dropped.data, { role: 'planner', handoff_id: staleId, active_handoff_id: packet.handoff_id, reason: 'handoff_superseded' })
  const staleResponse = world.rows('provider.response')[0]
  assert.equal(staleResponse.data.handoff_id, staleId, 'the stale response row is attributed so the drop can be paired with it')
  assert.equal(staleResponse.data.role, 'planner')

  const findings = analyzeBehaviorTrace(world.trace).findings
  assert.deepEqual(findings.filter(finding => finding.signature === 'stale_reply_not_dropped'), [])
})

test('stale error: a provider failure that belongs to a discarded conversation does not fail or pause the active one', async (t) => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise])
  t.mock.method(world.agent, 'reset', () => {})
  const settled = world.say().then(() => undefined, error => error)
  await world.waitForProviderCall(1)
  const staleId = world.agent.agentContext.handoffId
  const packet = world.packet()
  assert.equal((await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })).restaged, true)

  gate.reject(new Error('HTTP 503 upstream unavailable'))
  const error = await settled

  assert.equal(error.code, STALE_REPLY_ERROR_CODE)
  assert.equal(world.rows('goal.paused').length, 0, 'a discarded conversation cannot pause the goal')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.rows('provider.error')[0].data.handoff_id, staleId)
  assert.equal(world.rows('context.stale_reply_dropped').length, 1)
})

test('a reply for the active conversation is never dropped', async () => {
  const world = loopHarness([firstPlan(), secondPlan()])
  await world.say()
  await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet() })
  await world.finish('iron-ore')
  assert.equal(world.rows('context.stale_reply_dropped').length, 0)
  assert.equal(world.game.mutations.length, 2)
})

// ---------------------------------------------------------------------------------------
// One sanitizer
// ---------------------------------------------------------------------------------------

test('the handoff note and durable memory share one sanitizer; the rules exist in exactly one runtime module', async () => {
  const raw = 'furnace unit_number: 4242, then target_unit_number=77 and unit #9'
  assert.equal(sanitizeHandoffNote(raw), sanitizeDurableModelText(raw))
  assert.ok(!/4242|=77|#9/.test(sanitizeHandoffNote(raw)), sanitizeHandoffNote(raw))

  const sources = (await fsp.readdir(here)).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  const holders = []
  for (const name of sources) {
    if ((await fsp.readFile(path.join(here, name), 'utf8')).includes('historical-id-omitted')) holders.push(name)
  }
  assert.deepEqual(holders, ['durable-text.mjs'])
})
