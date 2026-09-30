import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheBreakpointIndexes,
  classifyPrefixBreak,
  insertTailBlock,
  lastUserOutsideTail,
  promptLayout,
  sharedPrefixMessages,
  tailStart,
} from './prompt-prefix.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { buildPrefixReport,DEFECT_PREFIX_REASONS, EXPECTED_PREFIX_REASONS, formatPrefixReport } from './prefix-report.mjs'
import { providerRequest } from './provider.mjs'
import { STEAM_SCRIPTED_BLOCKED_ANSWER, steamReplayHarness } from './steam-run-fixtures.mjs'

const user = content => ({ role: 'user', content })
const system = { role: 'system', content: 'SYSTEM' }

test('tail placement: blocks go after stored history and before a trailing terminal instruction', () => {
  const stored = [system, user('[CHAT] a: go'), { role: 'assistant', content: '', tool_calls: [{ id: 'c' }] }, { role: 'tool', tool_call_id: 'c', content: '{}' }]
  const withOffers = insertTailBlock(stored, user('[SKILL_OFFERS] cards'))
  assert.equal(withOffers.at(-1).content, '[SKILL_OFFERS] cards')
  assert.equal(tailStart(withOffers), 4)

  const terminal = [...stored, user('[MOD] Autorio operation batch completed. receipt')]
  const tailed = insertTailBlock(insertTailBlock(terminal, user('[SKILL_OFFERS] cards')), user('[STEERING] x'))
  assert.deepEqual(tailed.slice(-3).map(message => message.content.slice(0, 8)), ['[SKILL_O', '[STEERIN', '[MOD] Au'])
  assert.equal(tailStart(tailed), 4, 'the tail starts at the first tail block')
  assert.equal(tailStart(terminal), 4, 'a trailing terminal instruction is tail: blocks will go in front of it')
  // Round-type detection looks past offers and steering.
  assert.ok(lastUserOutsideTail(tailed).content.startsWith('[MOD]'))
  assert.ok(lastUserOutsideTail(withOffers).content.startsWith('[CHAT]'))
})

test('layout: breakpoints sit at the end of the system message and of the request context, never in the tail', () => {
  const messages = [
    system,
    user('[MEMORY] ctx'),
    user('[CHAT] a: go'),
    user('[OBSERVATIONS COMPACTED] a => b'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'c' }] },
    { role: 'tool', tool_call_id: 'c', content: '{}' },
    user('[SKILL_OFFERS] cards'),
    user('[STEERING] s'),
  ]
  const layout = promptLayout(messages, { tools: [{ type: 'function' }] })
  assert.equal(layout.stable_messages, 6)
  assert.equal(layout.request_context_end, 2)
  assert.deepEqual(layout.tail_markers, ['[SKILL_OFFERS]', '[STEERING]'])
  assert.deepEqual(cacheBreakpointIndexes(messages), [0, 2])
  assert.notEqual(layout.tools_key, 'none')
  assert.equal(promptLayout(messages).tools_key, 'none')
  // The key covers the stable region only: a different tail keeps it.
  const other = [...messages.slice(0, 7), user('[STEERING] different')]
  assert.equal(promptLayout(other, { tools: [{ type: 'function' }] }).prefix_key, layout.prefix_key)
})

// The steam run through the real provider stack (DeepSeek profile): every
// request body of a request must share the previous round's stable region.
async function steamBodies() {
  const world = steamReplayHarness({ transport: 'http', extraRounds: [STEAM_SCRIPTED_BLOCKED_ANSWER] })
  await world.request()
  await world.closeStep1()
  await world.failSupplyBatch()
  return world.calls.map(call => call.body)
}

test('layout: a handoff packet (delegation U6) is the whole request context; what a continuation adds after it is working context', () => {
  const messages = [
    system,
    user('[HANDOFF] Rebuilt from durable harness state.\n--- plan block (stable while this plan runs) ---\ngoal: x'),
    user('--- step block ---\nrestage: role=executor checkpoint=C3'),
    user('[NEARBY_ENTITIES_BASELINE] snapshot'),
    user('[RUNTIME_COMPAT_STATE] projection'),
    user('[MOD] Autorio operation batch completed.'),
  ]
  const layout = promptLayout(messages, { tools: [{ type: 'function' }] })
  assert.equal(layout.request_context_end, 2, 'the context ends after the packet step block')
  assert.deepEqual(cacheBreakpointIndexes(messages), [0, 2], 'the cache breakpoints sit at the system message and the end of the packet')
  // The next continuation restarts from the packet: that is a continuation reset, not a rewrite of stored history.
  const next = [system, messages[1], messages[2], { role: 'assistant', content: '{"plan":[]}' }, user('[NEARBY_ENTITIES_BASELINE] snapshot'), user('[MOD] Autorio operation error')]
  assert.equal(classifyPrefixBreak({ messages, tools: [{ type: 'function' }] }, { messages: next, tools: [{ type: 'function' }] }).reason, 'continuation_reset')
  // Without a packet the rule is unchanged.
  assert.equal(promptLayout([system, user('[CHAT] a: go'), user('[NEARBY_ENTITIES_BASELINE] s')]).request_context_end, 2)
})

test('two consecutive rounds of one request share an identical prefix up to the declared breakpoint', async () => {
  const bodies = await steamBodies()
  assert.ok(bodies.length >= 4)
  // Authoring round 0 -> 1: no compaction yet.
  const [first, second] = bodies
  const layout = promptLayout(first.messages, { tools: first.tools })
  assert.ok(layout.stable_messages >= 3)
  assert.deepEqual(second.messages.slice(0, layout.stable_messages), first.messages.slice(0, layout.stable_messages))
  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools), 'the tool block is byte-identical between rounds')
  assert.equal(second.messages[0].content, first.messages[0].content, 'the system message (with its style block) is identical')
  // The dynamic blocks are all in the tail of both rounds.
  assert.ok(layout.tail_markers.includes('[STEERING]'))
  assert.ok(layout.tail_markers.includes('[PLANNING_LOD]'))
  assert.equal(sharedPrefixMessages(first.messages, second.messages) >= layout.stable_messages, true)
})

test('across the whole steam replay every change of prefix is an expected one, never a defect', async () => {
  const bodies = await steamBodies()
  const reasons = bodies.slice(1).map((body, index) => classifyPrefixBreak(bodies[index], body).reason)
  for (const reason of reasons) assert.ok(EXPECTED_PREFIX_REASONS.includes(reason), `unexpected prefix break: ${reasons.join(', ')}`)
  assert.ok(reasons.includes('tail_only'))
  assert.ok(reasons.includes('compaction'), 'compaction only folds into the digest')
  assert.ok(reasons.includes('role_switch'), 'compact completion <-> full planner switches the whole prefix by design')
  assert.deepEqual(DEFECT_PREFIX_REASONS.filter(reason => reasons.includes(reason)), [])
})

const deepseek = { key: 'k', model: 'deepseek-flash', base: 'https://provider.invalid/v1', profile: 'deepseek', timeoutMs: 5000 }
const okResponse = () => new Response(JSON.stringify({ id: 'r', model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"chatMessage":"","plan":[],"currentStep":0,"operations":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
const history = [system, user('[CHAT] a: go'), { role: 'assistant', content: 'plan' }, user('[MOD] Autorio operation error: x')]

test('closed rounds keep the tool block on the deepseek profile (tool_choice none) and drop it on every other profile', async () => {
  for (const profile of ['deepseek', 'openai-reasoning', 'openrouter', 'generic', 'local']) {
    const bodies = []
    await providerRequest({ ...deepseek, profile }, history, {
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return okResponse() },
      allowTools: false,
      triggerSource: 'failure',
    })
    if (profile === 'deepseek') {
      assert.ok(Array.isArray(bodies[0].tools) && bodies[0].tools.length > 0, profile)
      assert.equal(bodies[0].tool_choice, 'none', profile)
    }
    else {
      assert.equal(bodies[0].tools, undefined, profile)
      assert.equal(bodies[0].tool_choice, undefined, profile)
    }
  }
})

test('with the switch on, a round that closes tool use keeps the same tool block (tool_choice none), so the prefix is not broken', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return okResponse() }
  const on = { ...deepseek, toolsKeptWhenClosed: true }
  await providerRequest(on, history, { fetchImpl, allowTools: true, triggerSource: 'failure' })
  await providerRequest(on, history, { fetchImpl, allowTools: false, triggerSource: 'failure' })
  const [open, closed] = bodies
  assert.equal(open.tool_choice, 'auto')
  assert.equal(closed.tool_choice, 'none')
  assert.equal(JSON.stringify(closed.tools), JSON.stringify(open.tools))
  assert.equal(classifyPrefixBreak(open, closed).reason, 'tail_only')

  // Generic and local drop them even with the switch on for a profile that supports it only.
  const generic = []
  await providerRequest({ ...deepseek, profile: 'generic' }, history, {
    fetchImpl: async (_url, init) => { generic.push(JSON.parse(init.body)); return okResponse() },
    allowTools: false,
    triggerSource: 'failure',
  })
  assert.equal(generic[0].tools, undefined)
  // The interaction router never gets tools.
  const router = []
  await providerRequest({ ...deepseek, toolsKeptWhenClosed: true }, history, {
    fetchImpl: async (_url, init) => { router.push(JSON.parse(init.body)); return okResponse() },
    allowTools: false,
    interactionRouter: true,
    triggerSource: 'interaction_router',
  })
  assert.equal(router[0].tools, undefined)
})

test('Anthropic breakpoints: the marked prefix is byte-identical between two rounds of a request', async () => {
  const config = { key: 'k', model: 'anthropic/claude-opus-4.5', base: 'https://openrouter.ai/api/v1', timeoutMs: 5000 }
  const bodies = []
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return okResponse() }
  const context = [system, user('[MEMORY] ctx'), user('[CHAT] a: go')]
  await providerRequest(config, context, { fetchImpl, allowTools: true, triggerSource: 'new_goal' })
  await providerRequest(config, [...context, { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: '{}' }], { fetchImpl, allowTools: true, triggerSource: 'new_goal' })
  const marked = body => body.messages.flatMap((message, index) => Array.isArray(message.content) && message.content.some(part => part.cache_control) ? [index] : [])
  assert.deepEqual(marked(bodies[0]), [0, 2])
  assert.deepEqual(marked(bodies[1]), [0, 2])
  assert.deepEqual(bodies[1].messages.slice(0, 3), bodies[0].messages.slice(0, 3))
  assert.equal(JSON.stringify(bodies[1].tools), JSON.stringify(bodies[0].tools))
})

test('compaction folds to a low watermark, so the rounds between folds are pure appends and share the whole prefix', () => {
  const agent = new NpcAgentLoop({
    rcon: { command: async () => '{}' },
    provider: async () => { throw new Error('no provider call') },
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'prefix test',
    stateFile: null,
    traceFile: null,
    maxWorkingChars: 30000,
    maxWorkingMessages: 60,
  })
  agent.baseMessages = [system, user('[CHAT] a: go')]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  const exchange = id => [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: 'x'.repeat(4000) },
  ]
  let previous
  const reasons = []
  for (let round = 0; round < 24; round++) {
    agent.messages.push(...exchange(`c${round}`))
    const payload = agent.providerMessages()
    if (previous) reasons.push(classifyPrefixBreak({ messages: previous }, { messages: payload }).reason)
    previous = payload
  }
  const folds = reasons.filter(reason => reason === 'compaction').length
  assert.ok(reasons.every(reason => reason === 'tail_only' || reason === 'compaction'), reasons.join(','))
  assert.ok(folds >= 1 && folds <= 6, `folds ${folds} of ${reasons.length} rounds`)
  assert.ok(agent.messages.reduce((total, message) => total + String(message.content ?? '').length, 0) <= 30000 + 4100)
})

test('prefix report: names why each call stopped sharing the previous prefix, with the cache it got', () => {
  const request = (round, messages, tools = [{ type: 'function' }], reason = 'ordinary_planning') => ({ event: 'provider.request', ts: `t${round}`, round, reasoning_policy_reason: reason, payload: { messages, tools } })
  const response = (hit, input = 1000) => ({ event: 'provider.response', usage: { prompt_tokens: input, prompt_cache_hit_tokens: hit } })
  const base = [system, user('[CHAT] a: go')]
  const rows = [
    request(0, [...base, user('[STEERING] s')]), response(0),
    request(1, [...base, { role: 'assistant', content: 'x', tool_calls: [{ id: 'c' }] }, { role: 'tool', tool_call_id: 'c', content: '{}' }, user('[STEERING] s')]), response(900),
    // Tools removed for a closed round: the defect this item fixed.
    request(2, [...base, { role: 'assistant', content: 'x', tool_calls: [{ id: 'c' }] }, { role: 'tool', tool_call_id: 'c', content: '{}' }, user('[STEERING] s')], null), response(300),
    { event: 'provider.request', ts: 'r', round: 0, reasoning_policy_reason: 'interaction_router', payload: { messages: [system] } },
  ]
  const report = buildPrefixReport(rows)
  assert.equal(report.calls, 3)
  assert.equal(report.defect_transitions, 1)
  assert.deepEqual(report.reasons.map(row => [row.reason, row.transitions]).sort(), [['first_call', 1], ['tail_only', 1], ['tools_removed', 1]])
  assert.equal(report.reasons.find(row => row.reason === 'tail_only').cached_input_share, 0.9)
  assert.equal(report.reasons.find(row => row.reason === 'tools_removed').cached_input_share, 0.3)
  assert.match(formatPrefixReport(report), /tools_removed \(DEFECT\): 1 calls · in 1,000 \(30% cached, 700 miss\)/)
})
