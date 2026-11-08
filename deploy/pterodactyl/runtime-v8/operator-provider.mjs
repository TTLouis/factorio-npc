// OpenAI-compatible chat-completions client for the pursuit operator (CLI proxy
// or any compatible endpoint). Provider-native tool calling; no plan-mode prompt
// shaping. Never logs the key or request bodies.
import { providerEndpoint } from './provider-base.mjs'

export class OperatorProviderError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status }
}

/**
 * Build `complete({ messages, tools, signal })` for runOperatorLoop.
 * `cacheSystemPrompt` marks the fixed brief as a cache breakpoint for
 * providers that honour `cache_control` (Anthropic-family through the proxy).
 */
export function createOperatorCompletion({ base, key, model, fetchImpl = fetch, timeoutMs = 180000, maxTokens = 8192, cacheSystemPrompt = false, extraBody = {} }) {
  if (typeof key !== 'string' || !key.trim()) throw new OperatorProviderError('provider_key_missing')
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw new OperatorProviderError('provider_model_invalid')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new OperatorProviderError('provider_timeout_invalid')
  const endpoint = providerEndpoint(base)
  return async function complete({ messages, tools, signal }) {
    const body = {
      ...extraBody,
      model,
      max_tokens: maxTokens,
      messages: cacheSystemPrompt
        ? messages.map((message, index) => index === 0 && message.role === 'system' && typeof message.content === 'string'
          ? { ...message, content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] }
          : message)
        : messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    }
    catch (cause) {
      throw new OperatorProviderError(timeout.aborted ? 'provider_timeout' : signal?.aborted ? 'aborted' : 'provider_unreachable')
    }
    if (!response.ok) throw new OperatorProviderError(response.status === 429 ? 'provider_rate_limited' : 'provider_http_error', response.status)
    let json
    try { json = await response.json() }
    catch { throw new OperatorProviderError('provider_invalid_json') }
    const choice = json?.choices?.[0]
    if (!choice?.message || typeof choice.message !== 'object') throw new OperatorProviderError('provider_no_choice')
    if (choice.finish_reason === 'length' && !choice.message.tool_calls?.length) throw new OperatorProviderError('provider_output_truncated')
    const usage = json.usage ?? {}
    return {
      message: { content: typeof choice.message.content === 'string' ? choice.message.content : '', tool_calls: Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [] },
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, cached_tokens: usage.prompt_tokens_details?.cached_tokens,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens, total_tokens: usage.total_tokens },
      provider: { id: json.id, model: json.model, created: json.created, finish_reason: choice.finish_reason },
    }
  }
}
