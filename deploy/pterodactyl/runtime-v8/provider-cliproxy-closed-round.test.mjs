import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { providerCapabilityProfile, providerRequest } from './provider.mjs'

const config = { base: 'http://proxy.example-tailnet.ts.net:18317/v1', key: 'fixture-key', model: 'gpt-6-luna', profile: 'local' }
const messages = [{ role: 'system', content: 'Return a strict JSON plan.' }, { role: 'user', content: 'Produce red science.' }]
const plan = { chatMessage: '', plan: ['Gather iron ore'], currentStep: 0, operations: [{ name: 'gather_resource', args: { resource_name: 'iron-ore', count: 50, search_radius: 256 } }] }

// Recorded wire shape: JSON-only replay returned a compact valid plan plus
// message.images containing a data URL. Capture exceeded 1 MiB. Retaining tools
// with tool_choice none alone returned 1,064 bytes and no images. No paid calls.
function gateway(captured) {
  return async (_url, options) => {
    const body = JSON.parse(options.body)
    captured.push(body)
    const message = { role: 'assistant', content: JSON.stringify(plan) }
    if (body.tool_choice !== 'none') message.images = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(271137)}` } }]
    return new Response(JSON.stringify({ id: 'recorded-wire-shape', model: config.model, choices: [{ finish_reason: 'stop', message }] }))
  }
}

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
