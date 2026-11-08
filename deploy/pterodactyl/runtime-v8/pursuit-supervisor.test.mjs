import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentNotebookStore } from './agent-notebook.mjs'
import { storeNotebook } from './operator-loop.mjs'
import { createOperatorCompletion } from './operator-provider.mjs'
import { createInProcessOperatorTools, OPERATOR_TOOL_METHODS } from './operator-tool-surface.mjs'
import { createPursuitState, RED_SCIENCE_AUTOMATION_GOAL, runPursuitGoal } from './pursuit-supervisor.mjs'

const WORLD = '00000000-0000-4000-8000-000000000002'
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const submit = (id, error = false) => ({ message: { tool_calls: [call(id, 'factorio_submit', { request_id: id, operation: { name: 'wait', args: { ticks: 60 } } })] }, error })

function fakeRuntime(refuse = () => false) {
  const runtime = {}
  for (const method of Object.values(OPERATOR_TOOL_METHODS)) runtime[method] = async _input => ({ ok: true, method })
  runtime.submit = async input => {
    if (refuse(input)) throw Object.assign(new Error('x'), { code: 'preflight_rejected', effect: 'not_happened', publicMessage: 'refused' })
    return { operation_id: `op-${input.request_id}`, status: 'admitted' }
  }
  runtime.get = async input => ({ operation_id: input.operation_id, state: 'completed', terminal: true, effect: 'happened',
    operation: { name: input.operation_id.startsWith('op-w') ? 'wait' : 'walk_to_position', args: {} } })
  return runtime
}

// Native evaluation stub: each call returns the next scripted result, repeating the last.
function evaluator(results) {
  const calls = []
  const evaluate = async (definition, command, options) => {
    calls.push(options)
    const next = results.length > 1 ? results.shift() : results[0]
    return { satisfied: next.satisfied, baselines: {}, results: definition.done_when.map(condition => ({ id: condition.id, kind: condition.kind, satisfied: next.satisfied, current: next.current })) }
  }
  return { evaluate, calls }
}

function setup({ replies, evaluations, refuse, options }) {
  const sent = []
  const complete = async ({ messages }) => {
    sent.push(structuredClone(messages))
    const next = replies.shift()
    if (!next) throw Object.assign(new Error('done'), { code: 'script_exhausted' })
    return next
  }
  const notebook = storeNotebook({ store: new AgentNotebookStore(), world: WORLD, npc: 'npc-1', goal: 'goal-1', persist: async () => {} })
  const { evaluate, calls } = evaluator(evaluations)
  const state = createPursuitState()
  const events = []
  const saves = []
  const run = () => runPursuitGoal({ command: async () => '{}', complete, tools: createInProcessOperatorTools({ runtime: fakeRuntime(refuse) }), notebook,
    brief: 'BRIEF', state, options, evaluate, onEvent: event => events.push(event), saveState: async value => { saves.push(structuredClone(value)) } })
  return { run, sent, state, events, saves, evalCalls: calls }
}

test('an operator yield is accepted only by a satisfied native evaluation', async () => {
  const t = setup({ replies: [submit('r1'), { message: { content: 'Red science is running.' } }], evaluations: [{ satisfied: true, current: 5 }] })
  const result = await t.run()
  assert.equal(result.outcome, 'accepted')
  assert.equal(t.state.pursuit.outcome, 'accepted')
  assert.deepEqual(t.evalCalls, [{}])
  assert.equal(t.saves.at(-1).pursuit.outcome, 'accepted')
})

test('an unaccepted yield is answered with native unmet conditions in a fresh conversation', async () => {
  const t = setup({
    replies: [{ message: { content: 'I am done.' } }, { message: { content: 'Done again.' } }, { message: { content: 'Really done.' } }],
    evaluations: [{ satisfied: false, current: 0 }],
  })
  const result = await t.run()
  assert.equal(result.outcome, 'paused_operator_yielded_unaccepted')
  assert.equal(t.state.pursuit.yields, 3)
  assert.equal(t.sent[1].length, 2)
  assert.match(t.sent[1][1].content, /\[SUPERVISOR\] The goal is not accepted yet\. Native evaluation reports unmet: automation_researched/)
  assert.match(t.sent[1][1].content, /CONTEXT ROTATION 1/)
})

test('no native progress across checks pauses the goal', async () => {
  const replies = Array.from({ length: 20 }, (_, index) => submit(`r${index}`))
  const t = setup({ replies, evaluations: [{ satisfied: false, current: 3 }], options: { progressCheckEverySubmits: 2, noProgressChecks: 2 } })
  const result = await t.run()
  assert.equal(result.outcome, 'paused_no_progress')
  // First check records the signature; two more unchanged checks stop it.
  assert.equal(t.state.pursuit.evaluations, 3)
  assert.equal(t.state.submits, 6)
  assert.deepEqual(t.evalCalls, [{ samples: 1 }, { samples: 1 }, { samples: 1 }])
})

test('changing native progress keeps the goal running until a periodic check is satisfied', async () => {
  const replies = Array.from({ length: 20 }, (_, index) => submit(`r${index}`))
  const t = setup({ replies, evaluations: [{ satisfied: false, current: 1 }, { satisfied: false, current: 2 }, { satisfied: true, current: 3 }, { satisfied: true, current: 3 }],
    options: { progressCheckEverySubmits: 2, noProgressChecks: 1 } })
  const result = await t.run()
  assert.equal(result.outcome, 'accepted')
  // Periodic single read flagged a candidate; full sampling confirmed it.
  assert.deepEqual(t.evalCalls.at(-1), {})
})

test('a streak of refused submits pauses the goal', async () => {
  const replies = Array.from({ length: 10 }, (_, index) => submit(`r${index}`))
  const t = setup({ replies, evaluations: [{ satisfied: false }], refuse: () => true, options: { maxConsecutiveRefusedSubmits: 3 } })
  assert.equal((await t.run()).outcome, 'paused_refused_submit_streak')
  assert.equal(t.state.pursuit.refused_streak, 3)
})

test('provider failure pauses, and a finished goal is not resumed', async () => {
  const t = setup({ replies: [], evaluations: [{ satisfied: false }] })
  assert.equal((await t.run()).outcome, 'paused_provider_error')
  const again = await t.run()
  assert.equal(again.outcome, 'paused_provider_error')
  assert.equal(t.state.requests, 1)
})

test('red-science goal sanitizes and the operator never sees an acceptance tool', async () => {
  assert.equal(RED_SCIENCE_AUTOMATION_GOAL.doneWhen[0].technology, 'automation')
  const t = setup({ replies: [{ message: { content: 'x' } }], evaluations: [{ satisfied: true }] })
  await t.run()
  // The model has no tool to report completion; acceptance is native only.
  assert.ok(!JSON.stringify(t.sent[0]).includes('complete_goal'))
})

test('chat-completions client sends tools and parses tool calls without leaking the key in errors', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call('a', 'factorio_context', {})] } }], usage: { prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } }) }
  }
  const complete = createOperatorCompletion({ base: 'http://127.0.0.1:8317/v1', key: 'test-key', model: 'operator-model', fetchImpl, cacheSystemPrompt: true })
  const reply = await complete({ messages: [{ role: 'system', content: 'BRIEF' }, { role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'factorio_context', parameters: {} } }] })
  assert.equal(requests[0].url, 'http://127.0.0.1:8317/v1/chat/completions')
  assert.equal(requests[0].body.tool_choice, 'auto')
  assert.deepEqual(requests[0].body.messages[0].content[0].cache_control, { type: 'ephemeral' })
  assert.equal(reply.message.tool_calls[0].function.name, 'factorio_context')
  assert.equal(reply.usage.cached_tokens, 800)
  const failing = createOperatorCompletion({ base: 'http://127.0.0.1:8317/v1', key: 'test-key', model: 'm', fetchImpl: async () => ({ ok: false, status: 429 }) })
  await assert.rejects(failing({ messages: [], tools: [] }), error => error.code === 'provider_rate_limited' && !String(error.message).includes('test-key'))
  assert.throws(() => createOperatorCompletion({ base: 'http://remote.example/v1', key: 'k', model: 'm' }))
})

test('completed native receipts count as progress while goal conditions stay unchanged', async () => {
  const replies = []
  for (let index = 0; index < 8; index++) {
    replies.push(submit(`r${index}`))
    replies.push({ message: { tool_calls: [call(`g${index}`, 'factorio_receipt', { operation_id: `op-r${index}`, wait_ms: 1000 })] } })
  }
  const t = setup({ replies, evaluations: [{ satisfied: false, current: 0 }], options: { progressCheckEverySubmits: 2, noProgressChecks: 2 } })
  const result = await t.run()
  // Receipts report completed work each time, so the stop is the exhausted script, not no_progress.
  assert.equal(result.outcome, 'paused_provider_error')
  assert.equal(t.state.pursuit.progressed_operations.length, 8)
  assert.equal(t.state.pursuit.stale_checks, 0)
})

test('the same completed operation read twice counts once, and waits never count', async () => {
  const replies = [submit('w1')]
  for (let index = 0; index < 6; index++) replies.push({ message: { tool_calls: [call(`g${index}`, 'factorio_receipt', { operation_id: 'op-r0' })] } }, submit(`x${index}`))
  const t = setup({ replies, evaluations: [{ satisfied: false, current: 0 }], options: { progressCheckEverySubmits: 2, noProgressChecks: 2 } })
  const result = await t.run()
  assert.equal(result.outcome, 'paused_no_progress')
  assert.deepEqual(t.state.pursuit.progressed_operations, ['op-r0'])
})

test('token budget pauses the goal across conversations', async () => {
  const replies = Array.from({ length: 5 }, (_, index) => ({ message: { tool_calls: [call(`c${index}`, 'factorio_context', {})] }, usage: { prompt_tokens: 600, completion_tokens: 50 } }))
  const t = setup({ replies, evaluations: [{ satisfied: false }], options: { loop: { maxTotalTokens: 1200 } } })
  assert.equal((await t.run()).outcome, 'paused_token_budget_exhausted')
  assert.equal(t.state.requests, 2)
})
