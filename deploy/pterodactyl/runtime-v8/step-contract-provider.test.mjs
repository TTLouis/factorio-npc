import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { providerCapabilityProfile, providerRequest } from './provider.mjs'
import { parseStepContractReply, STEP_CONTRACT_SCHEMA } from './luna-step-contracts.mjs'

const answer = { stepId: 'target', checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'boiler', minimum: 1 }] } }
const messages = [{ role: 'system', content: 'Shared planner prefix' }, { role: 'user', content: '[STEP_CONTRACT_REQUEST] Author target.' }]
const configs = [
  { profile: 'local', model: 'gpt-6.1-sol', base: 'https://proxy.example.test/v1' },
  { profile: 'deepseek', model: 'deepseek-flash', base: 'https://provider.example.test/v1' },
  { profile: 'generic', model: 'fixture-model', base: 'https://provider.example.test/v1' },
  { profile: 'openrouter', model: 'anthropic/claude-fixture', base: 'https://provider.example.test/v1' },
].map(c => ({ ...c, key: 'fixture-only' }))
function transport(captured, message = { content: JSON.stringify(answer) }) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ model: captured.at(-1).model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...message } }] }))
  }
}
const options = { allowTools: false, role: 'planner', triggerSource: 'step_contract', requestBodyPatch: { max_tokens: 6000, response_format: { type: 'json_object' } }, promptTraceFile: null }
const textOf = m => typeof m.content === 'string' ? m.content : m.content.map(block => block.text ?? '').join('\n')

test('checkpoint side calls deliver canonical schema without gameplay steering/control across profiles', async () => {
  const original = JSON.stringify(messages)
  for (const config of configs) {
    const captured = []
    const reply = await providerRequest(config, messages, { ...options, fetchImpl: transport(captured) })
    assert.equal(parseStepContractReply(reply.content, { stepId: 'target' }).ok, true)
    const body = captured[0]; const text = body.messages.map(textOf).join('\n')
    assert.ok(text.includes('[STEP_CONTRACT_OUTPUT]') && text.includes(JSON.stringify(STEP_CONTRACT_SCHEMA)))
    assert.equal(text.includes('[STEERING]'), false)
    assert.equal(text.includes('[CONTROL_OUTPUT]'), false)
    assert.equal(textOf(body.messages[0]), messages[0].content, 'role prefix remains unchanged')
    assert.equal(body.messages[1].role, 'system', 'stable schema follows prefix before dynamic facts')
    if (providerCapabilityProfile(config).tools_kept_when_closed) {
      assert.equal(body.tool_choice, 'none', 'CLI proxy implicit tools remain disabled')
      assert.deepEqual(body.tools.map(t => t.function.name), ['defineStepContract'])
      assert.deepEqual(body.tools[0].function.parameters, STEP_CONTRACT_SCHEMA)
    } else assert.equal(body.tools, undefined)
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 6000)
  }
  assert.equal(JSON.stringify(messages), original)
})

test('checkpoint wire contract has request-correlated trace and removes stale gameplay steering on correction', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-contract-wire-'))
  try {
    const traceFile = path.join(dir, 'prompts.jsonl'); const captured = []
    await providerRequest(configs[0], [...messages, { role: 'user', content: '[STEERING] stale gameplay guidance [CONTROL_OUTPUT]' },
      { role: 'assistant', content: '{}' }, { role: 'user', content: '[HARNESS] invalid checkpoint; nothing was bound.' }],
    { ...options, fetchImpl: transport(captured), requestId: 'req_contract_wire', promptTraceFile: traceFile })
    const text = captured[0].messages.map(m => m.content).join('\n')
    assert.equal(text.includes('[CONTROL_OUTPUT]'), false)
    assert.match(captured[0].messages.at(-1).content, /nothing was bound/)
    const rows = (await fs.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    const row = rows.find(r => r.event === 'provider.step_contract_output_contract')
    assert.equal(row.request_id, 'req_contract_wire')
    assert.equal(row.reason, 'step_contract_requires_target_checkpoint_json')
    assert.deepEqual(row.allowed_fields, ['stepId', 'checkpoint'])
    assert.equal(row.tool_choice, 'none')
    assert.equal(rows.some(r => r.event === 'provider.control_output_contract'), false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('contract round never salvages a gameplay tool or unwraps a submitPlan envelope into checkpoint authority', async () => {
  for (const message of [
    { content: JSON.stringify({ submitPlan: answer }) },
    { content: '', tool_calls: [{ id: 'leaked-control', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(answer) } }] },
  ]) {
    const reply = await providerRequest(configs[0], messages, { ...options, fetchImpl: transport([], message) })
    assert.equal(reply.tool_calls, undefined)
    assert.equal(parseStepContractReply(reply.content, { stepId: 'target' }).ok, false)
  }
})

test('a checkpoint caller cannot reopen tools or combine interaction-routing authority', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('must fail before transport') }
  for (const extra of [{ allowTools: true }, { interactionRouter: true }]) {
    await assert.rejects(providerRequest(configs[0], messages, { ...options, ...extra, fetchImpl }), /Step contract calls require tools disabled/)
  }
  assert.equal(calls, 0)
})
