import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { providerCapabilityProfile, providerRequest } from './provider.mjs'

const config = { base: 'https://proxy.example.test/v1', key: 'fixture-only', model: 'gpt-6-luna', profile: 'cli-proxy' }
const messages = [{ role: 'user', content: 'Return an empty JSON object.' }]

test('CLI-proxy has independent per-model capabilities without LM Studio context or pricing defaults', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const capability = providerCapabilityProfile({ ...config, model })
    assert.equal(capability.id, 'cli-proxy')
    assert.equal(capability.model_family, 'openai-gpt')
    assert.equal(capability.reasoning_effort, true)
    assert.equal(capability.reasoning_effort_range, 'low_to_high')
    assert.equal(capability.context_window, undefined)
    assert.equal(capability.cached_input_pricing, undefined)
    assert.equal(capability.auto_resolved, false)
  }
  assert.equal(providerCapabilityProfile({ ...config, contextWindow: 131072 }).context_window, 131072)
  for (const model of ['claude-opus-4', 'qwen3-coder', 'openai/gpt-6-luna', 'unknown']) {
    const capability = providerCapabilityProfile({ ...config, model })
    assert.equal(capability.id, 'cli-proxy')
    assert.equal(capability.reasoning_effort, false)
    assert.equal(capability.tools_kept_when_closed, false)
  }
  const legacy = providerCapabilityProfile({ ...config, profile: 'local' })
  assert.equal(legacy.id, 'local')
  assert.equal(legacy.context_window, 65536)
  assert.equal(legacy.cached_input_pricing, false)
  assert.equal(legacy.tools_kept_when_closed, true)
  assert.equal(providerCapabilityProfile({ ...config, profile: 'auto' }).id, 'generic')
})

test('CLI-proxy serializer sends bounded flat reasoning without a local context floor', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 75 } } }))
  }
  const reply = await providerRequest(config, messages, { allowTools: false, promptTraceFile: null, fetchImpl, requestBodyPatch: { reasoning_effort: 'high', max_tokens: 4000 } })
  assert.equal(bodies[0].reasoning_effort, 'high')
  assert.equal(bodies[0].reasoning, undefined)
  assert.equal(bodies[0].max_tokens, 4000)
  assert.equal(bodies[0].tool_choice, 'none')
  assert.equal(reply._sglunaProvider.provider_context_window, undefined)
  assert.equal(reply._sglunaProvider.reported_cached_tokens, 75)
  await providerRequest(config, messages, { promptTraceFile: null, fetchImpl, reasoningBudget: 'strategic', requestBodyPatch: { max_tokens: 4000 } })
  assert.equal(bodies[1].reasoning_effort, 'high', 'existing policy clamps max to the verified proxy range')
  await providerRequest(config, messages, { promptTraceFile: null, fetchImpl, recoveryAttempt: 1 })
  assert.equal(bodies[2].reasoning_effort, undefined)
})

test('both deployment eggs permit explicit CLI-proxy selection', async () => {
  for (const filename of ['egg-sgluna-factorio-server.json', 'egg-sgluna-factorio-npc-e2e.json']) {
    const egg = JSON.parse(await fs.readFile(new URL(`../${filename}`, import.meta.url), 'utf8'))
    const variable = egg.variables.find(row => row.env_variable === 'AI_API_METHOD')
    assert.equal(variable.rules, 'nullable|string|in:direct,router,local,cli-proxy')
    assert.match(variable.description, /upstream provider inference/)
  }
})
