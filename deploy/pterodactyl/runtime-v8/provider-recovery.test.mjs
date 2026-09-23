import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProviderPlanContent, providerRequest } from './provider.mjs'

const config = {
  base: 'https://api.example.test/v1',
  key: 'test-key-1234',
  model: 'test-model',
}
const messages = [{ role: 'user', content: 'hello' }]
const completionMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
]

function hangingFetch(_url, { signal }) {
  return new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 10000)
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(signal.reason)
    }, { once: true })
  })
}

function successfulFetch(captured) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function contentFetch(content, finishReason = 'stop') {
  return async () => new Response(JSON.stringify({
    id: 'resp-recovery',
    model: 'test-model',
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('provider timeout reports an explicit error instead of leaving the turn active', async () => {
  await assert.rejects(
    () => providerRequest({ ...config, timeoutMs: 1000 }, messages, { fetchImpl: hangingFetch }),
    /Provider timed out after 1000 ms/,
  )
})

test('external cancellation aborts an in-flight provider request', async () => {
  const controller = new AbortController()
  const pending = providerRequest({ ...config, timeoutMs: 5000 }, messages, {
    fetchImpl: hangingFetch,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(() => pending, /Provider request cancelled/)
})

test('recovery requests can disable the tool surface completely', async () => {
  const captured = []
  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: false })
  assert.equal(captured.length, 1)
  assert.equal('tools' in captured[0], false)
  assert.equal('tool_choice' in captured[0], false)

  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: true })
  assert.ok(Array.isArray(captured[1].tools))
  assert.equal(captured[1].tool_choice, 'auto')
})

test('official DeepSeek disables thinking only for successful completion continuation', async () => {
  const captured = []
  const deepSeek = { ...config, base: 'https://api.deepseek.com/v1' }
  await providerRequest(deepSeek, completionMessages, { fetchImpl: successfulFetch(captured) })
  assert.deepEqual(captured[0].thinking, { type: 'disabled' })
  assert.equal(captured[0].max_tokens, 1000)

  await providerRequest(deepSeek, messages, { fetchImpl: successfulFetch(captured) })
  assert.equal('thinking' in captured[1], false)
  assert.equal(captured[1].max_tokens, 2000)
})

test('unknown compatible providers use a bounded continuation fallback without private fields', async () => {
  const captured = []
  await providerRequest(config, completionMessages, { fetchImpl: successfulFetch(captured) })
  assert.equal(captured[0].max_tokens, 4000)
  assert.equal('thinking' in captured[0], false)
})

test('completion continuation pairs placement candidates with candidate-id execution in the provider contract', async () => {
  const captured = []
  await providerRequest(config, completionMessages, { fetchImpl: successfulFetch(captured) })
  assert.ok(captured[0].tools.some(tool => tool?.function?.name === 'getPlacementCandidates'))
  const systemPrompt = String(captured[0].messages.find(message => message.role === 'system')?.content ?? '')
  assert.match(systemPrompt, /place_candidate \{candidate_set_id,candidate_id\}/)
  assert.match(systemPrompt, /Do not copy candidate coordinates into place_entity/)
})

test('empty length response with zero tool calls is output-budget exhaustion', async () => {
  const message = await providerRequest(config, completionMessages, {
    fetchImpl: contentFetch('', 'length'),
  })
  assert.equal(message._airiProvider.diagnostic_code, 'provider_output_budget_exhausted')
  assert.equal(message._airiProvider.output_budget_exhausted, true)
  assert.equal(message._airiProvider.content_chars, 0)
  assert.equal(message._airiProvider.tool_call_count, 0)
})

test('explicit output-budget recovery retains compact tools and fallback budget', async () => {
  const captured = []
  await providerRequest(config, [
    ...completionMessages,
    { role: 'user', content: '[HARNESS] retry output budget exhaustion' },
  ], {
    fetchImpl: successfulFetch(captured),
    allowTools: true,
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
  })
  assert.equal(captured[0].max_tokens, 4000)
  assert.ok(Array.isArray(captured[0].tools))
  assert.equal(captured[0].tool_choice, 'auto')
})

test('provider strips a single JSON markdown fence before strict plan parsing', async () => {
  const plan = '{"chatMessage":"","plan":["continue"],"currentStep":0,"operations":[]}'
  const message = await providerRequest(config, messages, {
    fetchImpl: contentFetch(`\`\`\`json\n${plan}\n\`\`\``),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(message.content, plan)
})

test('normalizer handles a long unterminated markdown fence without regex backtracking', () => {
  const content = `\`\`\`json\n${'x'.repeat(100_000)}`
  assert.equal(normalizeProviderPlanContent(content), content)
})

test('provider extracts one unambiguous plan object from harmless prose', async () => {
  const plan = '{"chatMessage":"继续","plan":["继续"],"currentStep":0,"operations":[]}'
  const message = await providerRequest(config, messages, {
    fetchImpl: contentFetch(`Here is the requested JSON:\n${plan}\n`),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(message.content, plan)
})

test('normalizer refuses to guess when provider content contains multiple top-level objects', () => {
  const content = 'first {"a":1} second {"b":2}'
  assert.equal(normalizeProviderPlanContent(content), content)
})

test('normalizer extracts the final strict plan after reasoning JSON', () => {
  const plan = '{"chatMessage":"","plan":["continue"],"currentStep":0,"operations":[]}'
  assert.equal(normalizeProviderPlanContent(`thinking {"candidate":1}\n${plan}`), plan)
})

test('normalizer prefers the last valid plan candidate', () => {
  const draft = '{"chatMessage":"draft","plan":["draft"],"currentStep":0,"operations":[]}'
  const finalPlan = '{"chatMessage":"final","plan":[],"currentStep":0,"operations":[]}'
  assert.equal(normalizeProviderPlanContent(`draft ${draft}\nreason {"x":2}\nfinal ${finalPlan}`), finalPlan)
})

test('normalizer does not accept plan-like JSON that fails strict schema', () => {
  const invalid = '{"chatMessage":"x","plan":[],"currentStep":0,"operations":[],"reasoning":"no"}'
  assert.equal(normalizeProviderPlanContent(invalid), invalid)
})

test('normalizer validates operations through the plan policy', () => {
  const valid = '{"chatMessage":"","plan":["wait"],"currentStep":0,"operations":[{"name":"wait","args":{"ticks":60}}]}'
  const invalid = '{"chatMessage":"","plan":["bad"],"currentStep":0,"operations":[{"name":"shell","args":{}}]}'
  assert.equal(normalizeProviderPlanContent(`reason {"x":1}\n${valid}`), valid)
  assert.equal(normalizeProviderPlanContent(invalid), invalid)
})


test('normal tool-enabled provider requests advertise submitPlan as a control-plane tool', async () => {
  const captured = []
  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: true })
  const names = captured[0].tools.map(tool => tool?.function?.name)
  assert.equal(names.includes('submitPlan'), true)
})

test('tools-disabled recovery does not advertise submitPlan', async () => {
  const captured = []
  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: false, recoveryAttempt: 1 })
  assert.equal('tools' in captured[0], false)
})


test('provider diagnostics distinguish invalid content JSON from plan-schema failure', async () => {
  const invalidJson = await providerRequest(config, messages, {
    fetchImpl: contentFetch('not json'),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(invalidJson._airiProvider.diagnostic_code, 'provider_content_invalid_json')
  assert.equal(invalidJson._airiProvider.structured_content.json_valid, false)

  const invalidPlan = await providerRequest(config, messages, {
    fetchImpl: contentFetch('{"foo":"bar"}'),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(invalidPlan._airiProvider.diagnostic_code, 'provider_content_schema_invalid')
  assert.equal(invalidPlan._airiProvider.structured_content.json_valid, true)
  assert.equal(invalidPlan._airiProvider.structured_content.plan_valid, false)
})


test('provider classifies context-window HTTP failures as provider budget boundaries', async () => {
  const errorBody = {
    error: {
      message: "This model's maximum context length is 128000 tokens. Your messages resulted in 130412 tokens.",
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
    },
  }
  await assert.rejects(
    () => providerRequest(config, messages, {
      fetchImpl: async () => new Response(JSON.stringify(errorBody), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    error => {
      assert.equal(error?.code, 'provider_context_window_exceeded')
      assert.equal(error?.failureClass, 'provider_budget')
      assert.match(String(error?.message ?? ''), /provider_context_window_exceeded/)
      return true
    },
  )
})

test('ordinary provider HTTP failures remain transport failures rather than budget handoffs', async () => {
  await assert.rejects(
    () => providerRequest(config, messages, {
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    error => {
      assert.equal(error?.code, 'provider_http_error')
      assert.equal(error?.failureClass, undefined)
      assert.match(String(error?.message ?? ''), /Provider HTTP 429/)
      return true
    },
  )
})

// Live deepseek (goal_mubkwykj, goal_mubm2fdg) leaked its native tool-call
// markup as content twice per goal, which ended both goals as
// provider_content_invalid_json.
const DSML_SUBMIT_PLAN = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="submitPlan">',
  '<｜｜DSML｜｜ parameter name="chatMessage" string="true">熔炉已放置在(52,20)。</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="plan" string="false">["采集铁矿、煤和石头","放置熔炉并烧出 10 个 iron-plate"]</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="currentStep" string="false">1</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="operations" string="false">[{"name": "supply_entity", "args": {"unit_number": 69, "items": [{"item_name": "iron-ore", "count": 12}]}}]</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

test('leaked DSML tool-call markup is recovered as native tool calls', async () => {
  const message = await providerRequest(config, messages, { fetchImpl: contentFetch(DSML_SUBMIT_PLAN), allowTools: true })
  assert.equal(message._airiProvider.diagnostic_code, 'ok')
  assert.equal(message._airiProvider.dsml_recovery, 'tool_calls')
  assert.equal(message.content, '')
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'submitPlan')
  const args = JSON.parse(message.tool_calls[0].function.arguments)
  assert.equal(args.chatMessage, '熔炉已放置在(52,20)。')
  assert.deepEqual(args.plan, ['采集铁矿、煤和石头', '放置熔炉并烧出 10 个 iron-plate'])
  assert.equal(args.currentStep, 1)
  assert.equal(args.operations[0].args.unit_number, 69)
})

test('leaked DSML submitPlan becomes plan content when tools are disabled', async () => {
  const message = await providerRequest(config, messages, {
    fetchImpl: contentFetch(DSML_SUBMIT_PLAN),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(message.tool_calls, undefined)
  assert.equal(message._airiProvider.dsml_recovery, 'submit_plan_content')
  assert.equal(message._airiProvider.diagnostic_code, 'ok')
  assert.equal(JSON.parse(message.content).currentStep, 1)
})

test('several leaked DSML invokes become several tool calls', async () => {
  const content = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="craft_item">',
    '<｜｜DSML｜｜ parameter name="item_name" string="true">stone-furnace</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="count" string="false">1</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<｜DSML｜ invoke name="getInventory">',
    '</｜DSML｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n')
  const message = await providerRequest(config, messages, { fetchImpl: contentFetch(content), allowTools: true })
  assert.deepEqual(message.tool_calls.map(call => call.function.name), ['craft_item', 'getInventory'])
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { item_name: 'stone-furnace', count: 1 })
  assert.deepEqual(JSON.parse(message.tool_calls[1].function.arguments), {})
  assert.notEqual(message.tool_calls[0].id, message.tool_calls[1].id)
})

test('malformed DSML markup is left for the ordinary format recovery', async () => {
  const content = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="submitPlan">\n<｜｜DSML｜｜ parameter name="plan" string="false">[broken</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  const message = await providerRequest(config, messages, { fetchImpl: contentFetch(content), allowTools: true })
  assert.equal(message.tool_calls, undefined)
  assert.equal(message._airiProvider.diagnostic_code, 'provider_content_invalid_json')
  assert.equal(message._airiProvider.dsml_recovery, undefined)
})
