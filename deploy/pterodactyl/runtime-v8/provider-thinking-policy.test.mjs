import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { providerRequest, selectReasoningPolicy } from './provider.mjs'

const VALID_PLAN = JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, operations: [] })
const COMPLETION = '[MOD] Autorio operation batch completed. Detailed task receipt: {"task_state":"completed"}'
const FAILURE = '[MOD] Autorio operation error: placement failed. Dependent queued operations may have been cancelled. Detailed task receipt: {"task_state":"idle","queue_length":0}'

function response(model = 'deepseek-flash') {
  return new Response(JSON.stringify({
    id: 'test-response',
    model,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: VALID_PLAN } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function config(overrides = {}) {
  return {
    key: 'test-key',
    model: 'deepseek-flash',
    base: 'https://proxy.example/v1',
    profile: 'deepseek',
    timeoutMs: 5000,
    ...overrides,
  }
}

async function captureRequest(messages, options = {}, providerConfig = config()) {
  let seen
  const message = await providerRequest(providerConfig, messages, {
    ...options,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) }
      return response(providerConfig.model)
    },
  })
  return { seen, message }
}

test('successful deterministic completion continuation uses low effort with thinking enabled', async () => {
  const { seen, message } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: build a furnace' },
    { role: 'user', content: COMPLETION },
  ], { allowTools: true })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 3000)
  assert.equal(message._airiProvider.reasoning_effort, 'low')
  assert.equal(message._airiProvider.reasoning_policy_reason, 'deterministic_completion')
})

test('Jev post-step reanchor stays compact and uses low reasoning', async () => {
  const { seen, message } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: keep the same goal aligned' },
    { role: 'user', content: COMPLETION },
  ], { allowTools: true, triggerSource: 'post_step_reanchor' })

  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 3000)
  assert.equal(message._airiProvider.reasoning_policy_reason, 'jev_post_step_reanchor')
})

test('Jev post-step replan overrides the compact completion path and uses high effort', async () => {
  const { seen, message } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: build a furnace' },
    { role: 'user', content: COMPLETION },
  ], { allowTools: true, triggerSource: 'post_step_replan' })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'max')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 32000)
  assert.equal(message._airiProvider.reasoning_policy_reason, 'plan_authoring')
})

test('Jev post-step continue overrides an error boundary to low reasoning', async () => {
  const { seen, message } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: keep building' },
    { role: 'user', content: FAILURE },
  ], { allowTools: true, triggerSource: 'post_step_continue' })

  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(message._airiProvider.reasoning_policy_reason, 'jev_post_step_continue')
})

test('new ordinary DeepSeek goal uses the plan-authoring bracket only when lifecycle routing marks it new_goal', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: automate iron production' },
  ], { allowTools: true, triggerSource: 'new_goal' })

  assert.equal(seen.body.reasoning_effort, 'max')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 32000)
})

test('strict JSON recovery uses none and disables thinking', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] Invalid provider content JSON. Retry with strict JSON only and no tool calls.' },
  ], { allowTools: false, recoveryAttempt: 1 })

  assert.equal(seen.body.reasoning_effort, 'none')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
})

test('output-budget recovery preserves compact budget and disables thinking', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] continue after output budget exhaustion' },
  ], {
    allowTools: true,
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
  })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'none')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
  assert.equal(seen.body.max_tokens, 3000)
})

test('meaningful failure following a low continuation escalates the next planning turn to high', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: COMPLETION },
    { role: 'user', content: '[HARNESS] Tool-validation failure (1/3; invalid_tool_call): malformed observation tool arguments.' },
  ]
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true }), {
    effort: 'high',
    reason: 'ordinary_replan',
  })
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'high')
  assert.equal(seen.body.max_tokens, 16000)
})

test('repeated meaningful failures switch to compact finalization instead of consuming the strategic budget', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: COMPLETION },
    { role: 'user', content: '[HARNESS] Tool-validation failure (1/3; invalid_tool_call): first failure.' },
    { role: 'assistant', content: VALID_PLAN },
    { role: 'user', content: '[HARNESS] Tool-validation failure (2/3; invalid_tool_call): second failure.' },
  ]
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 4000)
})

test('successful grounded execution de-escalates back to low after earlier failures', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: '[MOD] Autorio operation error: first failure.' },
    { role: 'user', content: '[MOD] Autorio operation error: second failure.' },
    { role: 'user', content: COMPLETION },
  ]
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
})

test('routed lifecycle drives main-planner reasoning instead of raw CHAT framing', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: 继续当前目标，但别清周围了' },
  ]
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, triggerSource: 'amend_current' }), {
    effort: 'max',
    reason: 'plan_authoring',
  })
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, triggerSource: 'continue_current' }), {
    effort: 'low',
    reason: 'same_goal_continue',
  })
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, triggerSource: 'new_goal' }), {
    effort: 'max',
    reason: 'plan_authoring',
  })
})

test('same-goal and Jev recovery continuations get a bounded 3000-token action budget', async () => {
  for (const triggerSource of ['continue_current', 'recovery_continue_low']) {
    const { seen } = await captureRequest([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[CHAT] tester: continue current work' },
    ], { allowTools: true, triggerSource })
    assert.equal(seen.body.reasoning_effort, 'low')
    assert.equal(seen.body.max_tokens, 8000)
  }
})

test('interaction router is tool-free, disables reasoning, and CHAT alone is not new_goal', async () => {
  const routed = await captureRequest([
    { role: 'system', content: 'classify only' },
    { role: 'user', content: '[CHAT] tester: 给我汇报一下你那里卡住了' },
  ], {
    allowTools: false,
    interactionRouter: true,
    triggerSource: 'interaction_router',
    requestBodyPatch: { max_tokens: 160, response_format: { type: 'json_object' } },
  })

  assert.equal(routed.seen.body.tools, undefined)
  assert.equal(routed.seen.body.reasoning_effort, 'none')
  assert.deepEqual(routed.seen.body.thinking, { type: 'disabled' })
  assert.equal(routed.seen.body.max_tokens, 160)
  assert.deepEqual(routed.seen.body.response_format, { type: 'json_object' })

  assert.deepEqual(selectReasoningPolicy(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue current work' },
  ], { allowTools: true }), {
    effort: 'high',
    reason: 'ordinary_planning',
  })
})

test('explicit caller max_tokens remains authoritative over reasoning policy budget', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: plan something difficult' },
  ], {
    allowTools: true,
    triggerSource: 'new_goal',
    requestBodyPatch: { max_tokens: 900 },
  })

  assert.equal(seen.body.reasoning_effort, 'max')
  assert.equal(seen.body.max_tokens, 900)
})

test('custom DeepSeek-compatible base URL keeps its endpoint while receiving model-gated reasoning policy', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { allowTools: true }, config({ model: 'deepseek/deepseek-v4-pro', base: 'https://gateway.example/custom/v1' }))

  assert.equal(seen.url, 'https://gateway.example/custom/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'high')
})

test('auto profile fails closed on an unknown DeepSeek-compatible gateway', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { allowTools: true, triggerSource: 'new_goal' }, config({
    model: 'deepseek/deepseek-v4-pro',
    base: 'https://gateway.example/custom/v1',
    profile: 'auto',
  }))

  assert.equal(seen.url, 'https://gateway.example/custom/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, undefined)
  assert.equal(seen.body.thinking, undefined)
  assert.equal(seen.body.max_tokens, 4000)
})

test('openai reasoning profile uses max_completion_tokens and capability-safe minimal recovery reasoning', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: plan a difficult build' },
  ]
  const first = await captureRequest(messages, { allowTools: true, triggerSource: 'new_goal' }, config({
    model: 'reasoning-model',
    base: 'https://gateway.example/openai/v1',
    profile: 'openai-reasoning',
  }))
  assert.equal(first.seen.body.max_tokens, undefined)
  assert.equal(first.seen.body.max_completion_tokens, 32000)
  assert.equal(first.seen.body.reasoning_effort, 'high')
  assert.equal(first.seen.body.thinking, undefined)

  const recovery = await captureRequest(messages, {
    allowTools: true,
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
  }, config({
    model: 'reasoning-model',
    base: 'https://gateway.example/openai/v1',
    profile: 'openai-reasoning',
  }))
  assert.equal(recovery.seen.body.max_tokens, undefined)
  assert.equal(recovery.seen.body.max_completion_tokens, 3000)
  assert.equal(recovery.seen.body.reasoning_effort, 'minimal')
  assert.equal(recovery.seen.body.thinking, undefined)
})

test('requestBodyPatch rejects transport-critical fields outside the allowlist', async () => {
  await assert.rejects(
    captureRequest([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[CHAT] tester: inspect the factory' },
    ], {
      allowTools: true,
      triggerSource: 'new_goal',
      requestBodyPatch: { messages: [] },
    }),
    /requestBodyPatch key is not allowed/i,
  )
})

test('non-DeepSeek providers do not receive DeepSeek-specific request fields', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { allowTools: true }, config({ model: 'gpt-5.6', base: 'https://provider.example/v1', profile: 'generic' }))

  assert.equal(seen.body.reasoning_effort, undefined)
  assert.equal(seen.body.thinking, undefined)
})

test('content-filter finish is classified separately from ordinary parse/budget recovery', async () => {
  const message = await providerRequest(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect' },
  ], {
    allowTools: true,
    triggerSource: 'new_goal',
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'safety-block',
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(message._airiProvider.diagnostic_code, 'provider_safety_blocked')
  assert.equal(message._airiProvider.output_budget_exhausted, false)
})

test('provider diagnostics flag a gateway that reports completion usage above the requested cap', async () => {
  const message = await providerRequest(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: concise plan' },
  ], {
    allowTools: true,
    triggerSource: 'new_goal',
    requestBodyPatch: { max_tokens: 10 },
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'ignored-cap',
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: VALID_PLAN } }],
      usage: { prompt_tokens: 20, completion_tokens: 11, total_tokens: 31, completion_tokens_details: { reasoning_tokens: 9 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(message._airiProvider.requested_token_field, 'max_tokens')
  assert.equal(message._airiProvider.requested_output_cap, 10)
  assert.equal(message._airiProvider.reported_reasoning_tokens, 9)
  assert.equal(message._airiProvider.usage_complete, true)
  assert.equal(message._airiProvider.cap_enforcement_anomaly, true)
  assert.equal(message._airiProvider.diagnostic_code, 'provider_output_cap_ignored')
})

test('provider prompt trace records selected effort and policy reason per call', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-reasoning-policy-'))
  const traceFile = path.join(dir, 'prompts.jsonl')
  try {
    await captureRequest([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[CHAT] tester: plan a production line' },
    ], { allowTools: true, triggerSource: 'new_goal', promptTraceFile: traceFile })

    const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const request = rows.find(row => row.event === 'provider.request')
    const result = rows.find(row => row.event === 'provider.response')
    assert.equal(request.reasoning_effort, 'max')
    assert.equal(request.reasoning_policy_reason, 'plan_authoring')
    assert.equal(request.payload.reasoning_effort, 'max')
    assert.deepEqual(request.payload.thinking, { type: 'enabled' })
    assert.equal(result.reasoning_effort, 'max')
    assert.equal(result.reasoning_policy_reason, 'plan_authoring')
  }
  finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('Jev semantic reasoning budget maps through the DeepSeek capability shim', () => {
  const messages = [{ role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' }]
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, reasoningBudget: 'micro' }), {
    effort: 'low',
    reason: 'jev_budget_micro',
  })
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, reasoningBudget: 'normal' }), {
    effort: 'high',
    reason: 'jev_budget_normal',
  })
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, reasoningBudget: 'deep' }), {
    effort: 'max',
    reason: 'jev_budget_deep',
  })
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true, reasoningBudget: 'strategic' }), {
    effort: 'max',
    reason: 'jev_budget_strategic',
  })
})

test('strict recovery still overrides Jev semantic reasoning budget', () => {
  const messages = [{ role: 'user', content: '[MOD] Autorio operation error: failed' }]
  assert.deepEqual(selectReasoningPolicy(config(), messages, {
    allowTools: false,
    recoveryAttempt: 1,
    reasoningBudget: 'strategic',
  }), {
    effort: 'none',
    reason: 'strict_recovery',
  })
})

test('non-DeepSeek providers ignore the DeepSeek-specific Jev reasoning mapping', () => {
  const messages = [{ role: 'user', content: '[CHAT] TTLouis: continue' }]
  assert.equal(selectReasoningPolicy(config({ model: 'gpt-5.6', profile: 'generic' }), messages, {
    allowTools: true,
    reasoningBudget: 'deep',
  }), undefined)
})


test('Jev deep and strategic completion decisions escape the compact 1000-token path', async () => {
  for (const reasoningBudget of ['deep', 'strategic']) {
    const { seen } = await captureRequest([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[CHAT] tester: continue the long project' },
      { role: 'user', content: COMPLETION },
    ], {
      allowTools: true,
      // A non-authoring trigger, so Jev's rating decides the bracket.
      triggerSource: 'post_step_continue',
      reasoningBudget,
    })
    assert.equal(seen.body.reasoning_effort, 'max')
    assert.equal(seen.body.max_tokens, reasoningBudget === 'strategic' ? 24000 : 16000)
  }
  // Plan-authoring triggers get the largest bracket whatever Jev rated.
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the long project' },
    { role: 'user', content: COMPLETION },
  ], { allowTools: true, triggerSource: 'recovery_replan_high', reasoningBudget: 'micro' })
  assert.equal(seen.body.reasoning_effort, 'max')
  assert.equal(seen.body.max_tokens, 32000)
})

test('Jev normal budget keeps its full planner output budget after completion', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: COMPLETION },
  ], {
    allowTools: true,
    triggerSource: 'post_step_reanchor',
    reasoningBudget: 'normal',
  })
  assert.equal(seen.body.reasoning_effort, 'high')
  assert.equal(seen.body.max_tokens, 12000)
})

test('Jev micro budget preserves compact completion behavior', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: COMPLETION },
  ], {
    allowTools: true,
    triggerSource: 'post_step_continue',
    reasoningBudget: 'micro',
  })
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.equal(seen.body.max_tokens, 3000)
})


test('retired hierarchy trigger names no longer force a hidden full-planner path', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: COMPLETION },
  ], {
    allowTools: true,
    triggerSource: 'hierarchy_collapse',
    reasoningBudget: 'micro',
  })
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.equal(seen.body.max_tokens, 3000)
})
