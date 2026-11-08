import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentNotebookStore } from './agent-notebook.mjs'
import { createOperatorState, runOperatorLoop, storeNotebook } from './operator-loop.mjs'
import { createInProcessOperatorTools, OPERATOR_TOOL_METHODS } from './operator-tool-surface.mjs'

const GOAL = 'goal-1'
const WORLD = '00000000-0000-4000-8000-000000000001'

function fakeRuntime() {
  const calls = []
  const runtime = {}
  for (const method of Object.values(OPERATOR_TOOL_METHODS)) {
    runtime[method] = async input => { calls.push([method, input]); return method === 'context' ? { tick: calls.length } : { ok: true, method } }
  }
  return { runtime, calls }
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

// Scripted provider: each entry is the reply for one request. Records the
// messages it was sent so tests can check the conversation shape.
function scripted(replies) {
  const seen = []
  const complete = async ({ messages, tools }) => {
    seen.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.function.name) })
    const next = replies.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error('script exhausted')
    return next
  }
  return { complete, seen }
}

function setup(replies, extra = {}) {
  const { runtime, calls } = fakeRuntime()
  const store = new AgentNotebookStore()
  const persisted = []
  const notebook = storeNotebook({ store, world: WORLD, npc: 'npc-1', goal: GOAL, persist: async snapshot => { persisted.push(snapshot) } })
  const provider = scripted(replies)
  const state = createOperatorState()
  const events = []
  return { runtime, calls, store, persisted, notebook, provider, state, events,
    run: options => runOperatorLoop({ complete: provider.complete, tools: createInProcessOperatorTools({ runtime }), notebook,
      brief: 'BRIEF: make red science to unlock automation.', state, options, onEvent: event => events.push(event), ...extra }) }
}

test('operator observes, submits, reads the receipt, writes notes and yields', async () => {
  const t = setup([
    { message: { content: '', tool_calls: [call('a', 'factorio_capabilities', {})] }, usage: { prompt_tokens: 1000, completion_tokens: 20 } },
    { message: { content: '', tool_calls: [call('b', 'factorio_submit', { request_id: 'r1', operation: { name: 'wait', args: { ticks: 60 } } })] } },
    { message: { content: '', tool_calls: [call('c', 'factorio_receipt', { operation_id: 'op-r1', wait_ms: 1000 })] } },
    { message: { content: '', tool_calls: [call('d', 'updateNotebook', { scope: 'goal', expectedRevision: 0, text: 'plan: power first' })] } },
    { message: { content: 'Paused: waiting for research.' } },
  ])
  const result = await t.run()
  assert.equal(result.stop, 'operator_yield')
  assert.equal(result.content, 'Paused: waiting for research.')
  assert.deepEqual(t.calls.map(([method]) => method), ['context', 'capabilities', 'submit', 'get'])
  assert.deepEqual(t.store.read(WORLD, 'npc-1', GOAL, 'goal'), { revision: 1, text: 'plan: power first', goal_id: GOAL })
  assert.equal(t.persisted.length, 1)
  assert.equal(t.state.requests, 5)
  assert.equal(t.state.tool_calls, 4)
  assert.equal(t.state.submits, 1)
  const first = t.provider.seen[0]
  assert.equal(first.messages[0].role, 'system')
  assert.match(first.messages[1].content, /\[CURRENT CONTEXT from factorio_context\]/)
  assert.ok(first.tools.includes('factorio_submit') && first.tools.includes('updateNotebook'))
  const last = t.provider.seen.at(-1).messages
  assert.equal(last.at(-1).role, 'tool')
  assert.equal(last.at(-1).tool_call_id, 'd')
})

test('a second submit in one response is refused without reaching the runtime', async () => {
  const t = setup([
    { message: { tool_calls: [
      call('a', 'factorio_submit', { request_id: 'r1', operation: { name: 'wait', args: { ticks: 60 } } }),
      call('b', 'factorio_submit', { request_id: 'r2', operation: { name: 'wait', args: { ticks: 60 } } }),
    ] } },
    { message: { content: 'done' } },
  ])
  await t.run()
  assert.deepEqual(t.calls.filter(([method]) => method === 'submit').map(([, input]) => input.request_id), ['r1'])
  const refused = JSON.parse(t.provider.seen[1].messages.at(-1).content)
  assert.equal(refused.code, 'one_submit_per_response')
  assert.equal(refused.effect, 'not_happened')
})

test('malformed arguments and stale notebook writes come back as refusals', async () => {
  const t = setup([
    { message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'factorio_observe', arguments: '{not json' } }] } },
    { message: { tool_calls: [call('b', 'updateNotebook', { scope: 'goal', expectedRevision: 5, text: 'x' })] } },
    { message: { content: 'stop' } },
  ])
  await t.run()
  const sent = t.provider.seen[2].messages
  assert.equal(JSON.parse(sent.at(-3).content).code, 'invalid_tool_arguments')
  assert.equal(JSON.parse(sent.at(-1).content).code, 'notebook_revision_conflict')
  assert.equal(t.persisted.length, 0)
})

test('context rotates on message count, reseeds notebook and context, and keeps counters', async () => {
  const replies = []
  for (let index = 0; index < 4; index++) replies.push({ message: { tool_calls: [call(`o${index}`, 'factorio_context', {})] } })
  replies.push({ message: { content: 'yield' } })
  const t = setup(replies)
  const staged = t.store.stage(WORLD, 'npc-1', GOAL, 'persistent', 0, 'lesson: belts need power poles nearby')
  staged.commit(staged.snapshot())
  const result = await t.run({ rotateAtMessages: 6 })
  assert.equal(result.stop, 'operator_yield')
  assert.equal(t.state.rotations, 2)
  assert.equal(t.state.requests, 5)
  const rotated = t.provider.seen.find(entry => /CONTEXT ROTATION 1/.test(entry.messages[1].content))
  assert.ok(rotated)
  assert.equal(rotated.messages.length, 2)
  assert.equal(rotated.messages[0].content, 'BRIEF: make red science to unlock automation.')
  assert.match(rotated.messages[1].content, /lesson: belts need power poles nearby/)
  assert.ok(t.events.some(event => event.type === 'context_rotated'))
})

test('request budget is shared across runs and never resets', async () => {
  const replies = Array.from({ length: 10 }, (_, index) => ({ message: { tool_calls: [call(`c${index}`, 'factorio_context', {})] } }))
  const t = setup(replies)
  const first = await t.run({ maxRequests: 3 })
  assert.equal(first.stop, 'request_budget_exhausted')
  assert.equal(t.state.requests, 3)
  const second = await t.run({ maxRequests: 3 })
  assert.equal(second.stop, 'request_budget_exhausted')
  assert.equal(t.state.requests, 3)
})

test('provider failure and abort stop the loop without game calls', async () => {
  const failing = setup([Object.assign(new Error('upstream'), { code: 'provider_timeout' })])
  assert.equal((await failing.run()).stop, 'provider_error')
  assert.deepEqual(failing.calls.map(([method]) => method), ['context'])
  const controller = new AbortController()
  controller.abort()
  const aborted = setup([], { signal: controller.signal })
  assert.equal((await aborted.run()).stop, 'aborted')
  assert.equal(aborted.state.requests, 0)
})
