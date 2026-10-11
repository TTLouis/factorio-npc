import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { providerCapabilityProfile, providerRequest } from './provider.mjs'
import { pursuitProvider } from './pursuit-runtime.mjs'

const config = { base: 'http://proxy.example-tailnet.ts.net:18317/v1', key: 'fixture-key', model: 'gpt-6-luna', profile: 'local' }
const messages = [{ role: 'system', content: 'Return a strict JSON plan.' }, { role: 'user', content: 'Produce red science.' }]
const plan = { chatMessage: '', plan: ['Gather iron ore'], currentStep: 0, operations: [{ name: 'gather_resource', args: { resource_name: 'iron-ore', count: 50, search_radius: 256 } }] }

test('owner Luna experiment reaches the actual wire with bounded headroom and correlated evidence', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'luna-profile-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'wire.jsonl'), captured = []
  const call = pursuitProvider((history, options) => providerRequest(config, history, {
    ...options, fetchImpl: gateway(captured, { pauseReason: 'Fixture boundary.' }), promptTraceFile: traceFile,
  }), async () => {}, { reasoningEffort: 'high', maxOutputTokens: 12000 })
  const reply = await call({}, { signal: new AbortController().signal, requestId: 'owner_profile_test' })
  assert.equal(reply.decision.pauseReason, 'Fixture boundary.')
  assert.equal(captured[0].reasoning_effort, 'high'); assert.equal(captured[0].max_tokens, 12000)
  assert.equal(captured[0].tools.length, 1); assert.equal(captured[0].tool_choice, 'auto')
  assert.equal(captured[0].tools[0].function.name, 'submitPursuitDecision')
  const contract = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    .find(row => row.event === 'provider.pursuit_wire_contract')
  assert.equal(contract.request_id, 'owner_profile_test')
  assert.equal(contract.reason, 'local_openai_pursuit_bounded_decision_tool')
  assert.equal(contract.selection_reason, 'owner_luna_pursuit_experiment')
  assert.equal(contract.max_output_tokens, 12000); assert.equal(contract.output_token_field, 'max_tokens')
  assert.equal(contract.reasoning_effort, 'high')
})

test('explicit Luna experiment rejects incompatible scope and caps before fetch', async () => {
  let fetches = 0
  const options = { allowTools: false, controlProtocol: 'pursuit', pursuitReasoningEffort: 'high',
    requestBodyPatch: { max_tokens: 12000 }, fetchImpl: async () => { fetches++; throw Error('unexpected fetch') } }
  for (const [target, override] of [
    [{ ...config, model: 'gpt-6-sol' }, {}], [{ ...config, profile: 'generic' }, {}],
    [config, { controlProtocol: 'legacy' }], [config, { allowTools: true }],
    [config, { pursuitReasoningEffort: 'max' }],
    [config, { requestBodyPatch: { max_tokens: 16001 } }],
  ]) await assert.rejects(providerRequest(target, messages, { ...options, ...override }))
  assert.equal(fetches, 0)
})

test('owner experiment keeps incomplete response and cancellation guards', async () => {
  const profile = { reasoningEffort: 'high', maxOutputTokens: 12000 }
  await assert.rejects(pursuitProvider(async () => ({ content: '{"pauseReason":"truncated"}',
    _sglunaProvider: { finish_reason: 'length' } }), async () => {}, profile)({},
  { signal: new AbortController().signal }), /pursuit_provider_incomplete/)
  let fetches = 0
  const controller = new AbortController(); controller.abort()
  await assert.rejects(pursuitProvider(async () => { fetches++ }, async () => {}, profile)({},
    { signal: controller.signal }), /pursuit_cancelled/)
  assert.equal(fetches, 0)
})

// Recorded wire shape: JSON-only replay returned a compact valid plan plus
// message.images containing a data URL. Capture exceeded 1 MiB. Retaining tools
// with tool_choice none alone returned 1,064 bytes and no images. No paid calls.
function gateway(captured, decision = plan) {
  return async (_url, options) => {
    const body = JSON.parse(options.body)
    captured.push(body)
    const message = { role: 'assistant', content: JSON.stringify(decision) }
    if (body.tool_choice !== 'none' && !(body.tools?.length === 1 && body.tools[0].function?.name === 'submitPursuitDecision')) message.images = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(271137)}` } }]
    return new Response(JSON.stringify({ id: 'recorded-wire-shape', model: config.model, choices: [{ finish_reason: 'stop', message }] }))
  }
}

test('CLI proxy pursuit exposes only the bounded decision tool without legacy planner schemas', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-pursuit-cliproxy-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'prompts.jsonl')
  const captured = []
  const decision = { observations: [{ name: 'getInventoryItems', args: {} }] }
  const reply = await providerRequest(config, messages, { controlProtocol: 'pursuit', allowTools: false,
    fetchImpl: gateway(captured, decision), promptTraceFile: traceFile, requestId: 'req_pursuit_proxy' })
  assert.deepEqual(JSON.parse(reply.content), decision)
  assert.equal(captured[0].tool_choice, 'auto')
  assert.equal(captured[0].reasoning_effort, 'medium')
  assert.equal(captured[0].tools.length, 1)
  const schema = captured[0].tools[0].function.parameters.properties.decision
  assert.equal(schema.properties.observations.minItems, 1)
  assert.equal(schema.properties.operations.minItems, 1)
  const trace = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const contract = trace.find(row => row.event === 'provider.pursuit_wire_contract')
  assert.equal(contract.request_id, 'req_pursuit_proxy')
  assert.equal(contract.reason, 'local_openai_pursuit_bounded_decision_tool')
  assert.equal(contract.response_format, 'unspecified')
  assert.equal(contract.reasoning_effort, 'medium')
  assert.deepEqual(contract.allowed_decision_fields, ['notes', 'operations', 'observations', 'pauseReason'])
  assert.ok(contract.allowed_operation_names.includes('place_entity'))
  assert.equal(contract.allowed_operation_names.includes('clear_construction_area'), false)
  assert.equal(trace.some(row => row.event === 'provider.control_output_contract'), false)
})

test('non-GPT pursuit requests preserve their existing JSON-only wire shape', async () => {
  const captured = []
  await providerRequest({ ...config, model: 'qwen3-coder-30b-a3b-instruct' }, messages, {
    controlProtocol: 'pursuit', allowTools: false,
    fetchImpl: async (_url, options) => {
      captured.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pauseReason":"fixture"}' } }] }))
    },
  })
  assert.equal('tools' in captured[0], false)
  assert.equal('tool_choice' in captured[0], false)
})

test('CLI proxy GPT closed rounds disable implicit tools and retain their schema with correlated diagnostics', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-cliproxy-'))
  try {
    const traceFile = path.join(dir, 'prompts.jsonl')
    const captured = []
    const reply = await providerRequest(config, messages, { allowTools: false, fetchImpl: gateway(captured), promptTraceFile: traceFile, requestId: 'req_recorded_proxy', triggerSource: 'new_goal' })
    assert.deepEqual(JSON.parse(reply.content), plan)
    assert.equal(captured[0].tool_choice, 'none')
    assert.ok(captured[0].tools.some(tool => tool.function.name === 'submitPlan'))
    const trace = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    const contract = trace.find(row => row.event === 'provider.closed_tool_contract')
    assert.equal(contract.request_id, 'req_recorded_proxy')
    assert.equal(contract.reason, 'local_openai_explicit_tool_choice_none')
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('the existing byte guard still rejects unsolicited image payloads', async () => {
  await assert.rejects(providerRequest(config, messages, { allowTools: true, fetchImpl: gateway([]), promptTraceFile: null }), /Provider response too large/)
})

test('only the local GPT family gains the closed-round wire contract', () => {
  assert.equal(providerCapabilityProfile({ ...config, model: 'gpt-6.1-sol' }).tools_kept_when_closed, true)
  for (const model of ['qwen3-coder-30b-a3b-instruct', 'qwen3.5-35b-a3b', 'google/gemma-4-e4b', 'deepseek-r1-0528-qwen3-8b']) {
    assert.equal(providerCapabilityProfile({ ...config, model }).tools_kept_when_closed, false)
  }
})
