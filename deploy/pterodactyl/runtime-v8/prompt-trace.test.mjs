import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { providerRequest } from './provider.mjs'

function fakeProviderResponse({
  finishReason = 'stop',
  message = { role: 'assistant', content: '{}' },
  usage,
} = {}) {
  return new Response(JSON.stringify({
    id: 'resp-prompt-trace',
    model: 'test-model',
    choices: [{ finish_reason: finishReason, message }],
    ...(usage ? { usage } : {}),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const config = {
  base: 'https://provider.example/v1',
  key: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
}

async function readTrace(filename) {
  const raw = await fsp.readFile(filename, 'utf8')
  return raw.trim().split('\n').filter(Boolean).map(JSON.parse)
}

test('prompt trace records the exact final provider body after continuation compaction and steering', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-prompt-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  let sentBody
  const fetchImpl = async (_url, options) => {
    sentBody = JSON.parse(options.body)
    return fakeProviderResponse()
  }

  await providerRequest(config, [
    { role: 'system', content: 'FULL SYSTEM PROMPT '.repeat(200) },
    { role: 'user', content: '[PLAN_STATE] Harness-owned durable goal/plan state.\n{"goal_id":"goal_1","objective":"continue factory","status":"active","plan":["continue factory"],"current_step":0,"revision":2}' },
    { role: 'user', content: '[CHAT] TTLouis: continue factory' },
    { role: 'assistant', content: '{"chatMessage":"","plan":["continue factory"],"currentStep":0,"operations":[{"name":"wait","args":{"ticks":1}}]}' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {"task_state":"IDLE","queue_empty":true,"queue_length":0,"last_completed_batch":{"batch_id":4,"task_count":1,"task_types":["waiting"],"tick":100}}' },
  ], {
    fetchImpl,
    allowTools: true,
    recoveryAttempt: 0,
    round: 6,
    epoch: 3,
    actorId: 18,
    requestId: 'req-test',
    promptTraceFile,
  })

  const rows = await readTrace(promptTraceFile)
  assert.equal(rows.length, 2)
  const requestRow = rows.find(row => row.event === 'provider.request')
  const responseRow = rows.find(row => row.event === 'provider.response')
  assert.ok(requestRow)
  assert.ok(responseRow)
  assert.equal(requestRow.request_id, 'req-test')
  assert.equal(requestRow.round, 6)
  assert.equal(requestRow.actor_id, 18)
  assert.equal(requestRow.epoch, 3)
  assert.equal(requestRow.trigger_source, 'completion')
  assert.equal(requestRow.recovery_attempt, 0)
  assert.equal(requestRow.allow_tools, true)
  assert.deepEqual(requestRow.payload, sentBody)
  assert.equal(requestRow.stats.body_chars, JSON.stringify(sentBody).length)
  assert.equal(requestRow.stats.message_count, sentBody.messages.length)
  assert.equal(requestRow.stats.tool_count, sentBody.tools.length)
  assert.equal(requestRow.payload.max_tokens, 8000)
  assert.match(requestRow.payload.messages[0].content, /Token-efficient continuation rules/)
  assert.ok(requestRow.payload.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[STEERING]')))
  assert.equal(responseRow.diagnostic_code, 'provider_content_schema_invalid')
  assert.equal(responseRow.response_id, 'resp-prompt-trace')
  assert.equal(responseRow.finish_reason, 'stop')
  assert.ok([0o600, 0o666].includes((await fsp.stat(promptTraceFile)).mode & 0o777))
})

test('prompt trace redacts common secrets without redacting max_tokens', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-prompt-redaction-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  const fetchImpl = async () => fakeProviderResponse()

  await providerRequest(config, [
    { role: 'system', content: 'NPC test prompt' },
    { role: 'user', content: '[CHAT] TTLouis: inspect Bearer abcdefghijklmnop and OPENAI_API_KEY=sk-abcdefghijklmnop' },
  ], {
    fetchImpl,
    allowTools: false,
    recoveryAttempt: 0,
    round: 1,
    epoch: 9,
    actorId: 21,
    promptTraceFile,
  })

  const raw = await fsp.readFile(promptTraceFile, 'utf8')
  assert.doesNotMatch(raw, /abcdefghijklmnop/)
  assert.match(raw, /\[REDACTED\]/)
  const rows = await readTrace(promptTraceFile)
  const requestRow = rows.find(row => row.event === 'provider.request')
  assert.ok(requestRow)
  assert.equal(requestRow.payload.max_tokens, 4000)
  assert.equal(requestRow.trigger_source, 'request')
})

test('response trace distinguishes output-budget exhaustion from language or UTF-8 damage', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-provider-diagnostics-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  const reasoning = '先分析发电布局，再输出严格 JSON。'.repeat(20)
  const fetchImpl = async () => fakeProviderResponse({
    finishReason: 'length',
    message: {
      role: 'assistant',
      content: '',
      reasoning_content: reasoning,
    },
    usage: {
      prompt_tokens: 13982,
      completion_tokens: 2000,
      total_tokens: 15982,
    },
  })

  const message = await providerRequest(config, [
    { role: 'system', content: 'Return strict JSON.' },
    { role: 'user', content: '[CHAT] TTLouis: 继续搭建发电' },
  ], {
    fetchImpl,
    allowTools: false,
    recoveryAttempt: 2,
    round: 5,
    epoch: 84,
    actorId: 10,
    requestId: 'req-length-zero-content',
    promptTraceFile,
  })

  assert.equal(message.content, '')
  assert.equal(message._airiProvider.diagnostic_code, 'provider_output_budget_exhausted')
  assert.equal(message._airiProvider.output_budget_exhausted, true)
  assert.equal(message._airiProvider.reasoning_content_chars, reasoning.length)
  assert.equal(message._airiProvider.content_chars, 0)
  assert.equal(message._airiProvider.content_replacement_chars, 0)

  const rows = await readTrace(promptTraceFile)
  const responseRow = rows.find(row => row.event === 'provider.response')
  assert.ok(responseRow)
  assert.equal(responseRow.request_id, 'req-length-zero-content')
  assert.equal(responseRow.finish_reason, 'length')
  assert.equal(responseRow.diagnostic_code, 'provider_output_budget_exhausted')
  assert.equal(responseRow.content_chars, 0)
  assert.equal(responseRow.reasoning_content_chars, reasoning.length)
  assert.ok(responseRow.message_keys.includes('reasoning_content'))
  assert.equal(responseRow.structured_content.error, 'empty content')
})

test('response trace reports malformed provider HTTP JSON without recording its raw body', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-provider-invalid-json-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  const fetchImpl = async () => new Response('{"choices":[', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  await assert.rejects(
    providerRequest(config, [
      { role: 'system', content: 'Return strict JSON.' },
      { role: 'user', content: '[CHAT] TTLouis: test malformed provider response' },
    ], {
      fetchImpl,
      allowTools: false,
      round: 1,
      requestId: 'req-malformed-provider-json',
      promptTraceFile,
    }),
    /Provider returned invalid JSON/,
  )

  const rows = await readTrace(promptTraceFile)
  const errorRow = rows.find(row => row.event === 'provider.response_error')
  assert.ok(errorRow)
  assert.equal(errorRow.diagnostic_code, 'provider_body_invalid_json')
  assert.match(errorRow.parse_error, /JSON|Unexpected|end/i)
  assert.equal(errorRow.response_first_nonspace, '{')
  assert.equal(Object.hasOwn(errorRow, 'response_preview'), false)
})


test('response trace reports a missing provider response body explicitly', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-provider-missing-body-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  const fetchImpl = async () => new Response(null, { status: 200 })

  await assert.rejects(
    providerRequest(config, [
      { role: 'system', content: 'Return strict JSON.' },
      { role: 'user', content: '[CHAT] TTLouis: test missing provider body' },
    ], {
      fetchImpl,
      allowTools: false,
      round: 1,
      requestId: 'req-missing-provider-body',
      promptTraceFile,
    }),
    /Provider returned no response body/,
  )

  const rows = await readTrace(promptTraceFile)
  const errorRow = rows.find(row => row.event === 'provider.response_error')
  assert.ok(errorRow)
  assert.equal(errorRow.diagnostic_code, 'provider_missing_response_body')
  assert.equal(errorRow.http_status, 200)
})

test('prompt tracing recovers after a failed write instead of staying off for the process', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-prompt-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  // The trace directory is blocked by a plain file, so the first write fails.
  const blocked = path.join(dir, 'logs')
  await fsp.writeFile(blocked, 'not a directory')
  const promptTraceFile = path.join(blocked, 'airi-prompts.jsonl')
  const fetchImpl = async () => fakeProviderResponse()
  const options = { fetchImpl, allowTools: false, recoveryAttempt: 0, promptTraceFile }

  // Tracing is best-effort: the provider call itself still succeeds.
  await providerRequest(config, [{ role: 'system', content: 'x' }, { role: 'user', content: '[CHAT] a: hi' }], options)

  await fsp.rm(blocked)
  await providerRequest(config, [{ role: 'system', content: 'x' }, { role: 'user', content: '[CHAT] a: hi again' }], options)
  const rows = await readTrace(promptTraceFile)
  assert.ok(rows.some(row => row.event === 'provider.request'))
})
