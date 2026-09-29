import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAnthropicCacheBreakpoints,
  openRouterModelFamily,
  providerCapabilityProfile,
  providerRequest,
} from './provider.mjs'

// Plan 1.7: an OpenRouter provider profile. OpenRouter proxies many upstream
// model families behind one host (openrouter.ai), so its capability must be
// resolved per model config, not once per process. The wire-shape facts
// below were checked against OpenRouter's public docs on 2026-09-27 (no API
// calls made):
// - reasoning effort: https://openrouter.ai/docs/use-cases/reasoning-tokens
//   `{"reasoning":{"effort":"high"|"medium"|"low"|...}}`; use either
//   `effort` or `max_tokens`, not both.
// - prompt caching: https://openrouter.ai/docs/features/prompt-caching
//   `cache_control: {"type":"ephemeral"}` on a content block, up to 4
//   breakpoints, cache hits reported at `usage.prompt_tokens_details.cached_tokens`.
// - provider routing: https://openrouter.ai/docs/features/provider-routing
//   `provider: {"order": ["<slug>"], "allow_fallbacks": false}` pins a
//   request to one upstream.

function openRouterConfig(model, extra = {}) {
  return {
    base: 'https://openrouter.ai/api/v1',
    key: 'test-key-1234',
    model,
    ...extra,
  }
}

function capturingFetch(captured, usage) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({
      id: 'resp-openrouter',
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

test('model family is resolved from the OpenRouter vendor prefix, not the transport', () => {
  assert.equal(openRouterModelFamily('deepseek/deepseek-chat-v3.1'), 'deepseek')
  assert.equal(openRouterModelFamily('anthropic/claude-opus-4.5'), 'anthropic')
  assert.equal(openRouterModelFamily('openai/gpt-5.1'), 'openai')
  assert.equal(openRouterModelFamily('x-ai/grok-4'), 'grok')
  assert.equal(openRouterModelFamily('google/gemini-3-pro'), 'google')
  assert.equal(openRouterModelFamily('meta-llama/llama-4'), 'generic')
  assert.equal(openRouterModelFamily(undefined), 'generic')
})

test('auto profile recognizes the openrouter.ai endpoint the same way it recognizes the DeepSeek endpoint', () => {
  const capability = providerCapabilityProfile(openRouterConfig('anthropic/claude-opus-4.5'))
  assert.equal(capability.id, 'openrouter')
  assert.equal(capability.auto_resolved, true)
  assert.equal(capability.model_family, 'anthropic')
})

test('an explicit openrouter profile resolves per model config even on a non-openrouter host', () => {
  const capability = providerCapabilityProfile({
    base: 'https://gateway.internal.test/v1',
    key: 'k',
    model: 'deepseek/deepseek-chat-v3.1',
    profile: 'openrouter',
  })
  assert.equal(capability.id, 'openrouter')
  assert.equal(capability.model_family, 'deepseek')
  assert.equal(capability.style_profile, 'deepseek')
})

test('two openrouter configs in the same process resolve independently by model family', () => {
  const anthropic = providerCapabilityProfile(openRouterConfig('anthropic/claude-opus-4.5'))
  const openai = providerCapabilityProfile(openRouterConfig('openai/gpt-5.1'))
  assert.equal(anthropic.cache_control, true)
  assert.equal(openai.cache_control, false)
  assert.notEqual(anthropic.model_family, openai.model_family)
})

test('reasoning effort is sent in the checked OpenRouter shape: reasoning.effort, not the flat key', async () => {
  const captured = []
  await providerRequest(openRouterConfig('anthropic/claude-opus-4.5'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.equal(typeof body.reasoning, 'object')
  // triggerSource 'new_goal' is a plan-authoring trigger, so the reasoning
  // policy picks 'max' (provider.mjs selectReasoningPolicy); what matters
  // for this profile is the wire shape, not the specific effort value.
  assert.equal(body.reasoning.effort, 'max')
  assert.equal(body.reasoning_effort, undefined)
})

test('the DeepSeek output style block still applies to a DeepSeek model routed through OpenRouter', async () => {
  const captured = []
  await providerRequest(openRouterConfig('deepseek/deepseek-chat-v3.1'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.match(body.messages[0].content, /Output style for this provider/)
})

test('a non-DeepSeek model routed through OpenRouter gets no output style block', async () => {
  const captured = []
  await providerRequest(openRouterConfig('openai/gpt-5.1'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.equal(body.messages[0].content, 'You are AIRI.')
})

test('cache_control breakpoints go where the stable prefix ends for an Anthropic model, and nowhere else', () => {
  const anthropic = providerCapabilityProfile({ base: 'https://openrouter.ai/api/v1', key: 'k', model: 'anthropic/claude-opus-4.5' })
  const { messages: withBreakpoint, breakpoints } = applyAnthropicCacheBreakpoints(messages, anthropic)
  // The end of the system message and the end of the request context.
  assert.equal(breakpoints, 2)
  assert.deepEqual(withBreakpoint[0].content, [
    { type: 'text', text: 'You are AIRI.', cache_control: { type: 'ephemeral' } },
  ])
  assert.deepEqual(withBreakpoint[1].content, [
    { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
  ])

  const openai = providerCapabilityProfile({ base: 'https://openrouter.ai/api/v1', key: 'k', model: 'openai/gpt-5.1' })
  const unbroken = applyAnthropicCacheBreakpoints(messages, openai)
  assert.equal(unbroken.breakpoints, 0)
  assert.equal(typeof unbroken.messages[0].content, 'string')
})

test('cache_control breakpoints reach the request body and the response trace for an Anthropic model', async () => {
  const captured = []
  const message = await providerRequest(openRouterConfig('anthropic/claude-opus-4.5'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.equal(Array.isArray(body.messages[0].content), true)
  assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(message._airiProvider.cache_control_breakpoints, 2)
  // Steering is tail: it carries no breakpoint.
  assert.equal(typeof body.messages.at(-1).content, 'string')
})

test('the upstream provider can be pinned per role/config so cache hits and comparisons stay stable', async () => {
  const captured = []
  const message = await providerRequest(openRouterConfig('anthropic/claude-opus-4.5', { upstreamProvider: 'anthropic' }), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  const [body] = captured
  assert.deepEqual(body.provider, { order: ['anthropic'], allow_fallbacks: false })
  assert.deepEqual(message._airiProvider.upstream_provider_pin, ['anthropic'])
})

test('without an explicit pin, no provider routing override is sent', async () => {
  const captured = []
  await providerRequest(openRouterConfig('anthropic/claude-opus-4.5'), messages, {
    fetchImpl: capturingFetch(captured),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(captured[0].provider, undefined)
})

test('cached and reasoning usage are parsed from OpenRouter-shaped usage into the trace', async () => {
  const captured = []
  const message = await providerRequest(openRouterConfig('anthropic/claude-opus-4.5'), messages, {
    fetchImpl: capturingFetch(captured, {
      prompt_tokens: 1200,
      completion_tokens: 340,
      total_tokens: 1540,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 200 },
    }),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(message._airiProvider.reported_cached_tokens, 900)
  assert.equal(message._airiProvider.reported_reasoning_tokens, 200)
  assert.equal(message._airiProvider.usage_complete, true)
})

test('capability_profile and model family are traced on every openrouter response', async () => {
  const message = await providerRequest(openRouterConfig('deepseek/deepseek-chat-v3.1'), messages, {
    fetchImpl: capturingFetch([]),
    allowTools: false,
    triggerSource: 'new_goal',
  })
  assert.equal(message._airiProvider.capability_profile, 'openrouter')
  assert.equal(message._airiProvider.provider_model_family, 'deepseek')
})
