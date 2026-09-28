import assert from 'node:assert/strict'
import test from 'node:test'

import { localModelFamily, providerCapabilityProfile, providerRequest } from './provider.mjs'

// Plan 1.9 (remainder): a `local` capability profile for LM Studio's
// OpenAI-compatible server (owner, 2026-09-26: qwen3-coder-30b-a3b-instruct
// first, qwen3.5-35b-a3b second; small models for side jobs only;
// deepseek-r1-0528-qwen3-8b is a reasoning distill and not used as a
// tool-calling model). No live model call is made anywhere in this file.

function localConfig(model, extra = {}) {
  return {
    base: 'http://host.docker.internal:1234/v1',
    key: 'test-key-1234',
    model,
    profile: 'local',
    ...extra,
  }
}

function capturingFetch(captured, usage) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({
      id: 'resp-local',
      model: 'test-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
      ...(usage ? { usage } : {}),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const messages = [
  { role: 'system', content: 'You are AIRI.' },
  { role: 'user', content: 'hello' },
]

test('local model family is resolved from the model config, matching the owner\'s current LM Studio lineup', () => {
  assert.equal(localModelFamily('qwen3-coder-30b-a3b-instruct'), 'qwen3-coder')
  assert.equal(localModelFamily('qwen3.5-35b-a3b-uncensored-hauhaucs-aggressive'), 'qwen3.5')
  assert.equal(localModelFamily('qwen/qwen3.5-9b'), 'qwen3.5')
  assert.equal(localModelFamily('google/gemma-4-e4b'), 'gemma')
  assert.equal(localModelFamily('deepseek-r1-0528-qwen3-8b'), 'reasoning-distill')
  assert.equal(localModelFamily(undefined), 'generic')
})

test('local profile declares a 64k context window by default', () => {
  const capability = providerCapabilityProfile(localConfig('qwen3-coder-30b-a3b-instruct'))
  assert.equal(capability.id, 'local')
  assert.equal(capability.context_window, 65536)
})

test('a model config can override the declared context window', () => {
  const capability = providerCapabilityProfile(localConfig('qwen3-coder-30b-a3b-instruct', { contextWindow: 32768 }))
  assert.equal(capability.context_window, 32768)
})

test('local profile reports no cached-input pricing', () => {
  const capability = providerCapabilityProfile(localConfig('qwen3-coder-30b-a3b-instruct'))
  assert.equal(capability.cached_input_pricing, false)
})

test('reasoning control is resolved per model family; today\'s known local families send no reasoning field', () => {
  // LM Studio's OpenAI-compatible server is not documented to accept an
  // OpenAI-style reasoning_effort/thinking request field for these locally
  // served GGUF builds, and no live call was made to check one that might
  // (AGENTS.md: no unvalidated assumptions become planning facts). The
  // decision is per family so a verified reasoning-capable local family can
  // be turned on later without restructuring the resolver.
  for (const model of ['qwen3-coder-30b-a3b-instruct', 'qwen3.5-35b-a3b', 'google/gemma-4-e4b', 'deepseek-r1-0528-qwen3-8b']) {
    const capability = providerCapabilityProfile(localConfig(model))
    assert.equal(capability.reasoning_effort, false, model)
  }
})

test('the local profile never sends a reasoning field, even when a caller asks for effort', async () => {
  const captured = []
  await providerRequest(localConfig('qwen3-coder-30b-a3b-instruct'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.equal(body.reasoning, undefined)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.thinking, undefined)
})

test('usage is parsed from LM Studio\'s plain OpenAI-compatible usage shape', async () => {
  const message = await providerRequest(localConfig('qwen3-coder-30b-a3b-instruct'), messages, {
    fetchImpl: capturingFetch([], {
      prompt_tokens: 4096,
      completion_tokens: 512,
      total_tokens: 4608,
    }),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(message._airiProvider.usage_complete, true)
  assert.equal(message._airiProvider.reported_output_tokens, 512)
  // LM Studio's plain usage carries no cache/reasoning breakdown.
  assert.equal(message._airiProvider.reported_cached_tokens, undefined)
  assert.equal(message._airiProvider.reported_reasoning_tokens, undefined)
})

test('capability_profile, model family and the declared context window are traced on every local response', async () => {
  const message = await providerRequest(localConfig('qwen3-coder-30b-a3b-instruct'), messages, {
    fetchImpl: capturingFetch([]),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(message._airiProvider.capability_profile, 'local')
  assert.equal(message._airiProvider.provider_model_family, 'qwen3-coder')
  assert.equal(message._airiProvider.provider_context_window, 65536)
})

test('an http provider URL is accepted for host.docker.internal, the container\'s route to LM Studio on the host', async () => {
  const message = await providerRequest(localConfig('qwen3-coder-30b-a3b-instruct'), messages, {
    fetchImpl: capturingFetch([]),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(message._airiProvider.diagnostic_code !== 'provider_http_error', true)
})
