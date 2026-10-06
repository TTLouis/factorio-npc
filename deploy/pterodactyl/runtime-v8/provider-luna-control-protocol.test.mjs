import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EXECUTOR_ROLE_PROMPT, roleSystemPrompt } from './agent-roles.mjs'
import { normalizeProviderPlanContentDetailed, providerRequest } from './provider.mjs'

const fixture = JSON.parse(await fsp.readFile(new URL('./fixtures/luna-control-protocol-2026-10-06.json', import.meta.url), 'utf8'))
const config = { base: 'http://proxy.example-tailnet.ts.net:18317/v1', key: 'fixture-key', model: 'gpt-6-luna', profile: 'local' }
const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }
const plan = { chatMessage: '', plan: ['Gather copper ore'], currentStep: 0, operations: [], semanticCompletion: { stepId: 'step_1', rationale: 'The correlated completed gathering receipt grounds this judgment.' } }
const messages = [
  { role: 'system', content: roleSystemPrompt('You are SGLuna.', 'executor') },
  { role: 'user', content: '[HANDOFF] One committed gathering step.' },
  { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {"last_completed_batch":{"batch_id":1},"basic_operation":{"last_result":{"code":"completed"}}}' },
  { role: 'user', content: '[HARNESS] Decide on the committed step from its completed receipt.' },
]

function replyFetch(content, captured) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ id: 'recorded-control-fixture', model: config.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }))
  }
}

test('October 6 multiple-object reply is refused rather than silently dropping its checkpoint and goal', () => {
  assert.equal(fixture.mixed_plan_reply.length, 1720)
  const result = normalizeProviderPlanContentDetailed(fixture.mixed_plan_reply)
  assert.equal(result.refused, 'multiple_plan_objects_conflict')
  assert.equal(result.content, fixture.mixed_plan_reply)
})

test('multiple plan candidates compare completion meaning and operations, but tolerate chat wording and object key order', () => {
  const base = { chatMessage: '', plan: ['Gather copper ore'], currentStep: 0, operations: [] }
  for (const extension of [
    { checkpoint },
    { semanticCompletion: plan.semanticCompletion },
    { stepCompletions: [{ kind: 'deterministic', checkpoint }] },
    { goal: { scope: 'finite', summary: 'Hold copper', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] } },
    { operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 10, search_radius: 256 } }] },
  ]) {
    const result = normalizeProviderPlanContentDetailed(`Proposal: ${JSON.stringify({ ...base, ...extension })}\nAnswer: ${JSON.stringify(base)}`)
    assert.equal(result.refused, 'multiple_plan_objects_conflict')
  }
  const repeat = { operations: [], currentStep: 0, plan: base.plan, chatMessage: 'A different short message.' }
  const result = normalizeProviderPlanContentDetailed(`Proposal: ${JSON.stringify(base)}\nAnswer: ${JSON.stringify(repeat)}`)
  assert.equal(result.refused, undefined)
  assert.deepEqual(JSON.parse(result.content), repeat)
})

test('new step completion specifications survive bare and wrapped plan normalization', () => {
  const draft = { ...plan, semanticCompletion: undefined, stepCompletions: [{ kind: 'deterministic', checkpoint }] }
  for (const content of [JSON.stringify(draft), JSON.stringify({ submitPlan: draft })]) {
    assert.deepEqual(JSON.parse(normalizeProviderPlanContentDetailed(content).content), JSON.parse(JSON.stringify(draft)))
  }
})

test('closed executor round keeps the wire guard and accepts a semantic-only control decision', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-luna-control-'))
  try {
    const traceFile = path.join(dir, 'prompts.jsonl')
    const open = []
    await providerRequest(config, messages, { allowTools: true, triggerSource: 'failure', fetchImpl: replyFetch(JSON.stringify(plan), open), promptTraceFile: null })
    const closed = []
    const reply = await providerRequest(config, messages, { allowTools: false, triggerSource: 'failure', fetchImpl: replyFetch(JSON.stringify(plan), closed), promptTraceFile: traceFile, requestId: 'req_oct6_control' })
    assert.equal(closed[0].tool_choice, 'none')
    assert.deepEqual(closed[0].tools, open[0].tools)
    assert.equal(closed[0].messages[0].content, open[0].messages[0].content)
    assert.match(EXECUTOR_ROLE_PROMPT, /checkpoint and semanticCompletion are still accepted/)
    const control = closed[0].messages.find(message => message.content?.includes('[CONTROL_OUTPUT]'))
    assert.ok(control)
    assert.match(control.content, /Tool invocations are disabled/)
    assert.match(control.content, /ONE strict JSON object/)
    assert.match(control.content, /stepCompletions aligned to plan/)
    assert.match(control.content, /operations:\[\] is valid/)
    assert.match(closed[0].messages.at(-1).content, /^\[HARNESS\]/, 'terminal harness instruction stays last')
    assert.deepEqual(JSON.parse(reply.content), plan)
    const trace = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    const contract = trace.find(row => row.event === 'provider.control_output_contract')
    assert.equal(contract.request_id, 'req_oct6_control')
    assert.equal(contract.reason, 'observations_closed_control_json_allowed')
    assert.deepEqual(contract.allowed_completion_fields, ['checkpoint', 'semanticCompletion', 'stepCompletions'])
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('recorded no-action replies stay no-action replies; normalization invents no completion claim', () => {
  for (const content of fixture.no_action_replies) {
    const result = normalizeProviderPlanContentDetailed(content)
    assert.equal(result.content, content)
    const parsed = JSON.parse(result.content)
    assert.deepEqual(parsed.operations, [])
    assert.equal(parsed.semanticCompletion, undefined)
    assert.equal(parsed.checkpoint, undefined)
  }
})

test('interaction routing receives its own untouched prompt without gameplay steering or control instructions', async () => {
  const history = [{ role: 'system', content: 'Classify the interaction as one JSON object.' }, { role: 'user', content: '[CHAT] TTLouis: continue' }]
  const captured = []
  await providerRequest(config, history, { allowTools: false, interactionRouter: true, triggerSource: 'interaction_router', fetchImpl: replyFetch('{"route":"resume"}', captured), promptTraceFile: null })
  assert.deepEqual(captured[0].messages, history)
  assert.equal(captured[0].tools, undefined)
  assert.equal(captured[0].tool_choice, undefined)
})
