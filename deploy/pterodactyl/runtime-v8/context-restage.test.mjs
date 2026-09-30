import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentContext, conversationChars } from './agent-context.mjs'
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
  assert.equal(context.isStale(after), true, 'a reply that outlives a reset is stale too (the conversation sequence is monotonic across lineages)')
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
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() }), /already used in this conversation lineage/)
  assert.equal(context.restageCount, 1)
})

test('staleness follows a monotonic conversation sequence, not handoff ids: A, B, A cannot make an old A reply look current', () => {
  const context = seededContext()
  const packetA = fakePacket({ handoff_id: 'ho_aaaaaaaaaaaa' })
  const packetB = fakePacket({ handoff_id: 'ho_bbbbbbbbbbbb' })
  context.restage({ checkpoint: 'C3', reason: 'r', packet: packetA })
  const inA = context.beginRequest(10)
  context.restage({ checkpoint: 'C3', reason: 'r', packet: packetB })
  assert.equal(context.isStale(inA), true)

  // The id a reply carries is not what decides: a second restage with A's id is refused outright.
  assert.throws(() => context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket({ handoff_id: 'ho_aaaaaaaaaaaa' }) }), /already used in this conversation lineage/)
  assert.equal(context.handoffId, 'ho_bbbbbbbbbbbb')
  assert.equal(context.isStale(inA), true)

  // Even a forged attribution that repeats the active handoff id is stale if its sequence is old.
  const forged = { ...inA, handoffId: context.handoffId }
  assert.equal(context.isStale(forged), true)
  assert.equal(context.observeReply(forged, { input_units: 1 }), false)

  const seqs = new Set()
  for (let i = 0; i < 4; i++) {
    seqs.add(context.beginRequest(1).seq)
    context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket({ handoff_id: `ho_seq${i}` }) })
  }
  assert.equal(seqs.size, 4, 'every restage is a new conversation sequence')
})

test('a new lineage always starts as the planner, even after an executor restage', () => {
  const context = seededContext()
  context.restage({ checkpoint: 'C3', reason: 'r', packet: fakePacket() })
  assert.equal(context.role, 'executor')
  context.beginLineage()
  assert.equal(context.role, 'planner')
  assert.equal(context.model, 'planner-model')
})

// ---------------------------------------------------------------------------------------
// The loop seam
// ---------------------------------------------------------------------------------------

const KEY = 'npc:sgluna'
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
// An observation round: the model asks for a read, the loop runs it and appends the exchange.
const TOOL_CALL_REPLY = {
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'call_boundary_1', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }],
}

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
    npcId: 'sgluna',
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

// Restage is sequential: the guarded API refuses while a round is in flight or open. The stale-reply
// tests below therefore swap the conversation through `agentContext.restage` directly, which is the
// unguarded path a race (or a future concurrent caller) would take, to prove the defence in depth.
function forceRestage(world, packet) {
  world.agent.agentContext.restage({
    checkpoint: 'C3',
    reason: 'forced',
    packet,
    prefixMessages: [{ role: 'system', content: world.agent.systemPrompt }],
  })
}

const STALE_MARKER = 'STALE-REPLY-MARKER'
const staleReply = () => planReply({ chatMessage: STALE_MARKER, plan: PLAN, currentStep: 0, operations: [gather('coal', 99)] })

function assertRestagedConversationIntact(world, packet, callIndex) {
  const { messages } = world.calls[callIndex]
  assert.equal(messages[1].content, packet.stableText, 'the redriven request reads the restaged conversation')
  assert.equal(messages[2].content, packet.volatileText)
  assert.ok(!JSON.stringify(messages).includes(STALE_MARKER), 'nothing from the stale reply is in the active conversation')
  assert.equal(world.agent.agentContext.handoffId, packet.handoff_id)
  assert.equal(world.agent.agentContext.restageCount, 1)
  assert.equal(world.agent.agentContext.messages[1].content, packet.stableText, 'the restaged conversation was not wiped by a reset')
  assert.equal(world.agent.active, true, 'the loop is still active')
  assert.ok(!JSON.stringify(world.agent.messages).includes(STALE_MARKER))
}

test('restage refuses while a provider round is in flight, and the round then completes normally', async () => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise])
  const pending = world.say()
  await world.waitForProviderCall(1)
  const packet = world.packet()
  const handoffId = world.agent.agentContext.handoffId

  const refused = await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })

  assert.deepEqual(refused, { restaged: false, reason: 'round_in_flight' })
  assert.equal(world.agent.agentContext.handoffId, handoffId)
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  const [row] = world.rows(DELEGATION_TRACE_ROWS.events.restageRefused)
  assert.deepEqual(Object.keys(row.data).sort(), Object.keys(DELEGATION_TRACE_ROWS.examples.restageRefused.data).sort())
  assert.equal(row.data.reason, 'round_in_flight')
  assert.ok(row.request_id, 'the refusal carries the open request id')

  gate.resolve(firstPlan())
  const result = await pending
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 0)
})

test('restage refuses while the turn still holds the conversation (a reply may be awaiting admission), and goes through between turns', async () => {
  const world = loopHarness([firstPlan()])
  const attempts = []
  const original = world.game.command.bind(world.game)
  let armed = false
  world.game.command = async (text) => {
    if (armed && text.includes('sgluna_deployment","status"')) {
      attempts.push((await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet() })).reason)
    }
    return original(text)
  }
  world.calls.push = function push(...items) { // arm once the provider has been asked
    armed = true
    return Array.prototype.push.apply(this, items)
  }
  await world.say()

  assert.ok(attempts.includes('round_in_flight'), `attempts: ${attempts}`)
  assert.ok(attempts.includes('round_open'), `attempts: ${attempts}`)
  assert.ok(attempts.every(reason => ['round_in_flight', 'round_open'].includes(reason)), `no attempt succeeded: ${attempts}`)
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  assert.equal(world.game.mutations.length, 1, 'the turn carried on undisturbed')

  // Between turns nothing holds the conversation, so the same restage goes through without safePoint.
  assert.equal(world.agent.turnConversation, null)
  assert.equal((await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet() })).restaged, true)
})

test('stale reply: a reply that returns after a restage mid-request is dropped and traced, the restaged conversation is intact, and the turn is re-driven on it', async () => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise, firstPlan()])
  const settled = world.say()
  await world.waitForProviderCall(1)
  const staleId = world.agent.agentContext.handoffId // the conversation the in-flight request belongs to
  const packet = world.packet()
  forceRestage(world, packet)

  gate.resolve(staleReply()) // the reply of the discarded conversation arrives now
  const result = await settled

  assert.equal(result.goalStatus, 'active', 'the request ends visibly and healthy, not as a silent cancel')
  assert.equal(world.calls.length, 2, 'one re-drive on the restaged conversation, no call on the old messages')
  assertRestagedConversationIntact(world, packet, 1)
  assert.equal(world.game.mutations.length, 1, 'only the re-driven reply was admitted')
  assert.ok(!world.game.mutations[0].includes('coal'), 'nothing from the stale reply reached admission')
  assert.equal(world.rows('request.failed').length, 0)

  const [dropped] = world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped)
  assert.ok(dropped, 'a context.stale_reply_dropped row was written')
  assert.equal(dropped.request_id, world.rows('provider.request')[0].request_id)
  assert.deepEqual(dropped.data, { role: 'planner', handoff_id: staleId, active_handoff_id: packet.handoff_id, reason: 'handoff_superseded' })
  assert.equal(world.rows('context.stale_reply_redriven').length, 1)
  const staleResponse = world.rows('provider.response')[0]
  assert.equal(staleResponse.data.handoff_id, staleId, 'the stale response row is attributed so the drop can be paired with it')
  assert.equal(staleResponse.data.role, 'planner')
  assert.deepEqual(analyzeBehaviorTrace(world.trace).findings.filter(finding => finding.signature === 'stale_reply_not_dropped'), [])
})

test('stale error: a provider failure that belongs to a discarded conversation does not fail, pause or reset the active one', async () => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise, firstPlan()])
  const settled = world.say()
  await world.waitForProviderCall(1)
  const staleId = world.agent.agentContext.handoffId
  const packet = world.packet()
  forceRestage(world, packet)

  gate.reject(new Error('HTTP 503 upstream unavailable'))
  const result = await settled

  assert.equal(result.goalStatus, 'active')
  assert.equal(world.rows('goal.paused').length, 0, 'a discarded conversation cannot pause the goal')
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.rows('provider.error')[0].data.handoff_id, staleId)
  assert.equal(world.rows('context.stale_reply_dropped').length, 1)
  assertRestagedConversationIntact(world, packet, 1)
})

test('stale drops are bounded: after the re-drive limit the failure is visible, not a silent cancellation', async () => {
  let world
  const swapping = n => () => {
    forceRestage(world, world.packet({ now: 6000 + n }))
    return staleReply()
  }
  world = loopHarness([swapping(1), swapping(2), swapping(3), firstPlan()])

  await assert.rejects(world.say(), (error) => {
    assert.match(error.message, /provider_stale_reply_after_restage/)
    assert.doesNotMatch(error.message, /cancelled|superseded/, 'the supervisor must not read it as an expected cancellation')
    assert.doesNotMatch(error.message, /intact/, 'the text promises only what always holds: the normal failure path may reset the loop')
    assert.match(error.message, /goal and plan state are unchanged/)
    return true
  })

  assert.equal(world.calls.length, 3, 'the initial round and two re-drives, then it stops')
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 3)
  assert.equal(world.rows('context.stale_reply_redriven').length, 2)
  assert.equal(world.rows('request.failed').length, 1, 'a visible request.failed row')
  assert.equal(world.game.mutations.length, 0)
})

test('a restage that lands during the post-reply admission check does not let the old reply through', async () => {
  let armed = false
  let packet
  const world = loopHarness([() => { armed = true; return staleReply() }, firstPlan()])
  const original = world.game.command.bind(world.game)
  world.game.command = async (text) => {
    if (armed && text.includes('sgluna_deployment","status"')) {
      armed = false // the first status read after the reply is the post-reply assertCurrent
      packet = world.packet()
      forceRestage(world, packet)
    }
    return original(text)
  }

  const result = await world.say()

  assert.ok(packet, 'the restage happened during the post-reply await')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.game.mutations.length, 1)
  assert.ok(!world.game.mutations[0].includes('coal'), 'the old reply was not admitted')
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 1, 'and the drop is traced')
  assertRestagedConversationIntact(world, packet, 1)
})

test('a restage that lands during output-budget recovery never sends the old messages under the new conversation', async () => {
  const exhausted = { role: 'assistant', content: '' }
  Object.defineProperty(exhausted, '_sglunaProvider', {
    enumerable: false,
    value: { diagnostic_code: 'provider_output_budget_exhausted', output_budget_exhausted: true, finish_reason: 'length', usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } },
  })
  const world = loopHarness([exhausted, firstPlan()])
  let packet
  const recoveryWrites = []
  const setProviderRecovery = world.memory.setProviderRecovery.bind(world.memory)
  world.memory.setProviderRecovery = (key, recovery) => {
    recoveryWrites.push(recovery?.phase ?? null)
    return setProviderRecovery(key, recovery)
  }
  const emit = world.agent.behaviorTrace.emit
  world.agent.behaviorTrace = {
    emit: async (record) => {
      await emit(record)
      if (record.event === 'provider.output_budget_recovery_started' && !packet) {
        packet = world.packet()
        forceRestage(world, packet)
      }
    },
  }

  const result = await world.say()

  assert.ok(packet, 'the restage landed after the recovery started')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.calls.length, 2, 'no recovery request was built from the old messages')
  assert.ok(world.calls.every(call => call.context.recoveryKind !== 'output_budget_exhaustion'))
  assert.ok(!JSON.stringify(world.calls[1].messages).includes('OUTPUT_BUDGET') && world.calls[1].messages[1].content === packet.stableText)
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 1)
  assert.equal(world.game.mutations.length, 1)
  assert.deepEqual(recoveryWrites.slice(0, 2), ['in_flight', null], 'the in-flight recovery marker is cleared when the retry is dropped')
  assert.equal(world.memory.currentPlan(KEY)?.provider_recovery, undefined, 'and nothing is left for a restart to take the fail-closed pause on')
})

test('a restage that lands during the operations.admit await does not let the old reply\'s batch through', async () => {
  const world = loopHarness([staleReply(), firstPlan()])
  let packet
  const emit = world.agent.behaviorTrace.emit
  world.agent.behaviorTrace = {
    emit: async (record) => {
      await emit(record)
      if (record.event === 'operations.admit' && !packet) {
        packet = world.packet()
        forceRestage(world, packet)
      }
    },
  }

  const result = await world.say()

  assert.ok(packet, 'the restage landed between the admit trace and the batch')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.game.mutations.length, 1, 'only the re-driven reply was admitted')
  assert.ok(!world.game.mutations[0].includes('coal'), 'the stale reply\'s batch never reached Factorio')
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 1)
  assert.equal(world.rows('operations.admission_failed').length, 0, 'a stale drop is not an admission failure')
  assertRestagedConversationIntact(world, packet, 1)
})

test('a restage that lands before the tool batch is appended keeps the old assistant tool-call message out of the new conversation', async () => {
  const world = loopHarness([TOOL_CALL_REPLY, firstPlan()])
  let packet
  const emit = world.agent.behaviorTrace.emit
  world.agent.behaviorTrace = {
    emit: async (record) => {
      await emit(record)
      if (record.event === 'tool.call' && !packet) {
        packet = world.packet()
        forceRestage(world, packet)
      }
    },
  }

  const result = await world.say()

  assert.ok(packet)
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped).length, 1)
  assert.ok(!JSON.stringify(world.calls[1].messages).includes('call_boundary_1'), 'no tool-call message or result from the discarded conversation')
  assert.ok(!JSON.stringify(world.agent.messages).includes('call_boundary_1'))
  assertRestagedConversationIntact(world, packet, 1)
})

test('a turn restages at a real boundary with its own token: the next request holds only the packet conversation, admission and the plan stand; wrong or stale tokens are refused', async () => {
  let world
  let staleToken
  world = loopHarness([() => { staleToken = world.agent.turnToken; return firstPlan() }, TOOL_CALL_REPLY, secondPlan()]) // eslint-disable-line prefer-const
  const attempts = []
  let restaged
  let planBefore
  let planRightAfter
  let packet
  const original = world.game.command.bind(world.game)
  world.game.command = async (text) => {
    // With the tool exchange appended and no round in flight, the next status read is the
    // following round's assertCurrent, right before callProvider: the boundary U7/U8 restage at.
    const boundary = !restaged && world.calls.length === 2 && world.agent.providerCallsInFlight === 0
      && world.agent.messages.some(message => message.role === 'tool') && text.includes('sgluna_deployment","status"')
    if (boundary) {
      packet = world.packet()
      const args = { checkpoint: 'C3', reason: 'r', packet }
      const token = world.agent.turnToken
      assert.ok(token, 'the running turn exposes its token')
      planBefore = world.memory.planningState(KEY)
      attempts.push(
        (await world.agent.restageContext(args)).reason, // no token
        (await world.agent.restageContext({ ...args, safePoint: true })).reason, // the old boolean no longer works
        (await world.agent.restageContext({ ...args, safePoint: { ...token } })).reason, // a copy of the token
        (await world.agent.restageContext({ ...args, safePoint: staleToken })).reason, // the previous turn's token
      )
      restaged = await world.agent.restageContext({ ...args, safePoint: token })
      planRightAfter = world.memory.planningState(KEY)
    }
    return original(text)
  }

  await world.say() // turn 1
  assert.equal(world.agent.turnToken, null, 'no turn is open between turns')
  assert.equal((await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet(), safePoint: staleToken })).reason, 'round_open', 'a token when no turn is open is refused')
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  const mutationsBefore = world.game.mutations.length

  await world.finish('iron-ore') // turn 2: tool exchange, boundary, then the next plan

  assert.deepEqual(attempts, ['round_open', 'round_open', 'round_open', 'round_open'])
  assert.equal(restaged?.restaged, true, 'the correct token is accepted at the boundary')
  assert.deepEqual({ ...planRightAfter, context_restages: planBefore.context_restages }, planBefore, 'the restage itself changed no plan state')
  assert.equal(world.calls.length, 3)
  const { messages, context } = world.calls[2]
  assert.deepEqual(messages.slice(0, 3).map(message => message.content), [world.calls[0].messages[0].content, packet.stableText, packet.volatileText])
  assert.ok(!JSON.stringify(messages).includes('call_boundary_1'), 'the tool exchange of the ended conversation is gone')
  assert.ok(!messages.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')))
  assert.equal(context.role, 'executor')
  assert.equal(world.game.mutations.length, mutationsBefore + 1, 'the plan after the boundary was admitted exactly once')
  assert.equal(world.rows('context.stale_reply_dropped').length, 0)
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 1)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1, 'the verified step stands')
  assert.equal(world.agent.turnToken, null)
})

test('a turn entered without runGuarded still releases its conversation marker when it ends', async () => {
  const world = loopHarness([firstPlan(), firstPlan()])
  await world.say()
  world.agent.messages.push({ role: 'user', content: '[HARNESS] direct entry, as the supervisor\'s slice-boundary recovery does' })

  await world.agent.runTurn().catch(() => undefined)

  assert.equal(world.calls.length, 2, 'the direct turn asked the provider')
  assert.equal(world.agent.turnToken, null, 'the marker did not outlive the turn')
  assert.equal((await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet() })).restaged, true, 'so a restage between turns still goes through')
})

test('a restage refuses a packet whose plan is not the active plan, and the refusal is on the record', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  const packet = world.packet()
  packet.event = { ...packet.event, plan_id: undefined }

  const result = await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })

  assert.deepEqual(result, { restaged: false, reason: 'packet_plan_not_active' })
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  assert.equal(world.rows(DELEGATION_TRACE_ROWS.events.restageRefused).at(-1).data.reason, 'packet_plan_not_active')
})

test('the durable restage log records the handoff id the trace rows carry', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  const packet = world.packet()
  await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet })
  assert.equal(getContextRestages(world.memory.planningState(KEY))[0].handoff_id, packet.handoff_id)
  assert.equal(world.rows('context.restaged')[0].data.handoff_id, packet.handoff_id)
})

test('a new chat request starts a planner lineage even after an executor restage', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet: world.packet() })
  assert.equal(world.agent.agentContext.role, 'executor')
  world.agent.reset()
  assert.equal(world.agent.agentContext.role, 'planner')
  assert.equal(world.agent.agentContext.delegationActive, false)
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

test('redaction runs before truncation: a unit-number list that straddles the note cap leaks no digits', () => {
  const ids = [4242424, 4242425, 4242426, 4242427]
  for (const pad of [440, 470, 480, 490, 495, 499]) {
    const raw = `${'x'.repeat(pad - 10)} then look: observed_unit_numbers: [${ids.join(', ')}] and unit_number: ${ids[0]} elsewhere`
    for (const cleaned of [sanitizeHandoffNote(raw), sanitizeDurableModelText(raw, 500)]) {
      assert.ok(cleaned.length <= 500, `pad ${pad}: ${cleaned.length}`)
      assert.doesNotMatch(cleaned, /\d{3,}|\[\d/, `pad ${pad}: ${cleaned.slice(-60)}`)
    }
  }
  // The whole text is redacted first, then cut once.
  const long = `${'y '.repeat(200)}observed_unit_numbers: [1234567, 7654321]`
  assert.doesNotMatch(sanitizeDurableModelText(long, 420), /123|765/)
  // Text within the cap is unchanged by the ordering.
  assert.equal(sanitizeDurableModelText('mine at unit_number: 55 now', 100), 'mine at unit_number: [historical-id-omitted] now')
})

// --- U8 follow-ups: cross-lineage replies, per-generation in-flight, post-commit failures ---

// A reset plus a fresh turn mid-flight: what a supervisor cancel followed by the
// recovery (or a new chat request) leaves behind while an old flow is still awaiting.
async function supersedeTurn(world) {
  world.agent.reset()
  world.agent.active = true
  world.agent.epoch = await world.agent.captureEpoch()
  world.agent.requestInfo = { memoryKey: KEY, turnId: 99, sender: 'Louis', text: 'new request' }
}

test('a reply that outlives a reset is stale: dropped and traced against its own request, even after a new turn started', async () => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise, firstPlan()])
  const settled = world.say().then(() => 'admitted', error => `dropped: ${error.message}`)
  await world.waitForProviderCall(1)
  world.agent.reset() // the supervisor cancelled the turn (actor replaced)
  const second = world.agent.request('mine 10 iron then 10 copper', { sender: 'Louis' }) // a new request begins under a new lineage
  await second
  gate.resolve(staleReply())
  assert.match(await settled, /^dropped: .*(cancelled|superseded)/)
  const [dropped] = world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped)
  assert.ok(dropped, 'the old reply was traced as dropped')
  assert.ok(dropped.request_id, 'the row carries a request id')
  assert.equal(dropped.data.reason, 'handoff_superseded')
  assert.ok(!world.game.mutations.some(text => text.includes('coal')), 'nothing from the old reply was admitted')
  assert.ok(!JSON.stringify(world.agent.messages).includes(STALE_MARKER))
  assert.equal(analyzeBehaviorTrace(world.trace).findings.filter(finding => finding.signature === 'stale_reply_not_dropped').length, 0)
})

test('commitPlan pre-batch: a turn a reset outlived never reaches admission, whatever turn runs now', async () => {
  const world = loopHarness([firstPlan()])
  const emit = world.agent.behaviorTrace.emit
  let armed = true
  world.agent.behaviorTrace = {
    emit: async (record) => {
      await emit(record)
      if (armed && record.event === 'plan.accepted') { armed = false; await supersedeTurn(world) } // the awaits between the reply and the batch
    },
  }
  await assert.rejects(world.say(), /cancelled|superseded/)
  assert.equal(world.game.mutations.length, 0, 'the batch was never admitted')
  const [dropped] = world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped)
  assert.ok(dropped)
  assert.ok(dropped.request_id, 'the row carries a request id')
})

test('handleToolBatch pre-push: a turn a reset outlived pushes nothing and runs no tool', async () => {
  const read = { tool_calls: [{ id: 'call_00_inventory0000000000001', index: 0, type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] }
  const world = loopHarness([read, firstPlan()])
  const commands = []
  const original = world.game.command.bind(world.game)
  world.game.command = async (text) => { commands.push(text); return original(text) }
  const emit = world.agent.behaviorTrace.emit
  let armed = true
  let atTrigger = -1
  world.agent.behaviorTrace = {
    emit: async (record) => {
      await emit(record)
      if (armed && record.event === 'tool.call') { armed = false; atTrigger = commands.length; await supersedeTurn(world) }
    },
  }
  await assert.rejects(world.say(), /cancelled|superseded/)
  const [dropped] = world.rows(DELEGATION_TRACE_ROWS.events.staleReplyDropped)
  assert.ok(dropped, 'the drop is traced')
  assert.ok(dropped.request_id)
  assert.ok(!world.agent.messages.some(message => message.role === 'tool'), 'no tool reply was pushed into the new conversation')
  assert.ok(atTrigger >= 0 && !commands.slice(atTrigger).some(text => /inventory/i.test(text)), 'the read never ran after the reset')
})

test('a round of a reset generation does not refuse a restage; a round of the current generation still does', async () => {
  const gate = deferred()
  const world = loopHarness([() => gate.promise, firstPlan()])
  const settled = world.say().then(() => 'admitted', error => `dropped: ${error.message}`)
  await world.waitForProviderCall(1)
  assert.equal(world.agent.providerCallsInFlight, 1)
  // Same generation: refused (a round is open).
  const packet = world.packet()
  assert.deepEqual(await world.agent.restageContext({ checkpoint: 'C3', reason: 'r', packet }), { restaged: false, reason: 'round_in_flight' })
  // The turn is cancelled: its round is the discarded generation now.
  world.agent.reset()
  world.agent.active = true
  world.agent.epoch = await world.agent.captureEpoch()
  assert.equal(world.agent.providerCallsInFlight, 1, 'the old round is still open')
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'planner', reason: 'recovery:test', requestId: 'recovery_test' })
  assert.equal(result.restaged, true, JSON.stringify(result))
  gate.resolve(staleReply())
  assert.match(await settled, /^dropped:/)
  assert.equal(world.agent.providerCallsByGeneration.size, 0, 'the counters drain')
})

test('a persist failure after the swap is reported separately: the restage stands and is not a restage_error', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  world.agent.persistState = async () => { throw new Error('disk full') }
  const packet = world.packet()
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C3', reason: 'r', packet, requestId: 'req_persist' })
  assert.equal(result.restaged, true)
  assert.equal(world.agent.agentContext.handoffId, packet.handoff_id, 'the conversation was swapped')
  assert.equal(world.agent.messages[1].content, packet.stableText)
  const [failed] = world.rows('context.restage_persist_failed')
  assert.ok(failed)
  assert.ok(failed.request_id)
  assert.equal(failed.data.checkpoint, 'C3')
  assert.equal(failed.data.handoff_id, packet.handoff_id)
  assert.match(failed.data.message, /disk full/)
  assert.equal(world.rows('context.restage_error').length, 0)
})

test('a prebuilt packet restages in the role the packet names, not the loop role', async () => {
  const world = loopHarness([firstPlan()])
  await world.say()
  assert.equal(world.agent.agentContext.role, 'planner')
  const packet = world.packet({ role: 'executor' })
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C3', reason: 'r', packet })
  assert.equal(result.restaged, true)
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.rows('context.restaged')[0].data.role, 'executor')
})
