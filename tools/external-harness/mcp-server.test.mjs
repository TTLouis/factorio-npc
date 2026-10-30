import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { MAX_IN_FLIGHT, MAX_MESSAGE_BYTES, MAX_RESULT_BYTES, MCP_PROTOCOL_VERSION, MCP_TOOLS, startMcpServer } from './mcp-server.mjs'

// Protocol fixtures only: these fake runtime methods do NOT simulate Factorio
// mechanics or establish native gameplay success.
function fixture(overrides = {}) {
  const calls = []
  const runtime = Object.fromEntries(['capabilities', 'context', 'observe', 'submit', 'get', 'cancel', 'resume']
    .map(name => [name, async args => { calls.push({ name, args }); return { method: name, args } }]))
  Object.assign(runtime, overrides)
  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  const replies = []
  let buffer = ''
  output.on('data', chunk => {
    buffer += chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      replies.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
  const server = startMcpServer({ runtime, input, output, error })
  const send = value => input.write(`${JSON.stringify(value)}\n`)
  const request = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    await new Promise(resolve => setImmediate(resolve))
    return replies.find(reply => reply.id === id)
  }
  const initialize = async (version = MCP_PROTOCOL_VERSION) => {
    const result = await request('initialize', 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return result
  }
  return { runtime, calls, input, output, error, replies, server, send, request, initialize }
}

test('negotiates a supported MCP version and exposes exactly the bounded tool schemas', async t => {
  const f = fixture(); t.after(f.server.stop)
  const initialized = await f.initialize('2099-01-01')
  assert.equal(initialized.result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } })
  const listed = await f.request(1, 'tools/list')
  assert.deepEqual(listed.result.tools, MCP_TOOLS)
  assert.equal(listed.result.tools.length, 7)
  assert.equal(listed.result.tools.find(tool => tool.name === 'factorio_submit').annotations.readOnlyHint, false)
  assert.equal(listed.result.tools.find(tool => tool.name === 'factorio_resume').annotations.readOnlyHint, true)
  assert.equal(f.calls.length, 0)
})

test('requires initialization before tools and rejects malformed initialization', async t => {
  const f = fixture(); t.after(f.server.stop)
  assert.equal((await f.request(1, 'tools/call', { name: 'factorio_submit' })).error.code, -32002)
  assert.deepEqual((await f.request(2, 'ping')).result, {})
  assert.equal((await f.request(3, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION })).error.code, -32602)
  await f.initialize()
  assert.equal((await f.request(4, 'initialize', {})).error.code, -32600)
  assert.equal(f.calls.length, 0)
})

test('all seven MCP tools dispatch once with exact arguments and structured/text results', async t => {
  const f = fixture(); t.after(f.server.stop); await f.initialize()
  const invocations = [
    ['factorio_capabilities', 'capabilities', {}],
    ['factorio_context', 'context', {}],
    ['factorio_observe', 'observe', { name: 'getActorStatus', args: {} }],
    ['factorio_submit', 'submit', { request_id: 'task-1/step-1', operation: { name: 'wait', args: { ticks: 30 } } }],
    ['factorio_receipt', 'get', { operation_id: 'op-1', wait_ms: 30000 }],
    ['factorio_cancel', 'cancel', { operation_id: 'op-1' }],
    ['factorio_resume', 'resume', { operation_id: 'op-1' }],
  ]
  for (const [index, [tool, method, args]] of invocations.entries()) {
    const reply = await f.request(index, 'tools/call', { name: tool, arguments: args })
    assert.equal(reply.result.isError, false)
    assert.deepEqual(reply.result.structuredContent, { method, args })
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent)
  }
  assert.deepEqual(f.calls, invocations.map(([, name, args]) => ({ name, args })))
})

test('rejects invalid and unknown calls before entering the runtime', async t => {
  const f = fixture(); t.after(f.server.stop); await f.initialize()
  const badCalls = [
    { name: 'shell', arguments: { command: 'anything' } },
    { name: 'factorio_context', arguments: { extra: true } },
    { name: 'factorio_context', arguments: null },
    { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: {}, lua: 'anything' } } },
    { name: 'factorio_submit', arguments: { request_id: '', operation: { name: 'wait', args: {} } } },
    { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: [] } } },
    { name: 'factorio_submit', arguments: { request_id: 'x' } },
    { name: 'factorio_receipt', arguments: { operation_id: 'x', wait_ms: 30001 } },
    { name: 'factorio_receipt', arguments: { operation_id: 'x', wait_ms: -1 } },
    { name: 'factorio_receipt', arguments: { operation_id: 'x', wait_ms: 0.5 } },
    { name: 'factorio_cancel', arguments: { operation_id: 4 } },
    { name: 'factorio_observe', arguments: { name: 'x', args: 'not-object' } },
  ]
  for (const [index, params] of badCalls.entries()) assert.equal((await f.request(index, 'tools/call', params)).error.code, -32602)
  assert.equal((await f.request(100, 'resources/list')).error.code, -32601)
  assert.equal((await f.request(101, 'tools/list', { cursor: 'invented' })).error.code, -32602)
  assert.equal(f.calls.length, 0)
})

test('runtime errors use MCP isError and never expose raw exception details', async t => {
  const f = fixture({ submit: async () => { throw Object.assign(new Error('private-password-or-endpoint'), { code: 'actor_busy' }) } })
  t.after(f.server.stop); await f.initialize()
  const reply = await f.request(1, 'tools/call', { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: { ticks: 1 } } } })
  assert.equal(reply.result.isError, true)
  assert.equal(reply.result.structuredContent.code, 'actor_busy')
  assert.doesNotMatch(JSON.stringify(reply), /private-password-or-endpoint/)
})

test('runtime public errors are bounded and oversized results do not become false success', async t => {
  const f = fixture({
    observe: async () => ({ huge: 'x'.repeat(MAX_RESULT_BYTES) }),
    cancel: async () => { throw Object.assign(new Error('private'), { code: 'UPPER-invalid', publicMessage: 'p'.repeat(1500) }) },
  })
  t.after(f.server.stop); await f.initialize()
  const large = await f.request(1, 'tools/call', { name: 'factorio_observe', arguments: { name: 'getActorStatus' } })
  assert.equal(large.result.isError, true)
  assert.equal(large.result.structuredContent.code, 'result_too_large')
  const error = await f.request(2, 'tools/call', { name: 'factorio_cancel', arguments: { operation_id: 'x' } })
  assert.equal(error.result.structuredContent.message.length, 1000)
  assert.equal(error.result.structuredContent.code, 'runtime_error')
})

test('receipt waits do not block explicit cancellation or compact context', async t => {
  let release
  const f = fixture({ get: () => new Promise(resolve => { release = resolve }) })
  t.after(f.server.stop); await f.initialize()
  assert.equal(await f.request(1, 'tools/call', { name: 'factorio_receipt', arguments: { operation_id: 'x', wait_ms: 30000 } }), undefined)
  const cancelled = await f.request(2, 'tools/call', { name: 'factorio_cancel', arguments: { operation_id: 'x' } })
  assert.equal(cancelled.result.structuredContent.method, 'cancel')
  assert.equal((await f.request(3, 'tools/call', { name: 'factorio_context' })).result.structuredContent.method, 'context')
  release({ operation_id: 'x', state: 'cancelled', goal_completed: false })
  f.input.end(); await f.server.done
  assert.equal(f.replies.find(reply => reply.id === 1).result.structuredContent.state, 'cancelled')
})

test('reserves cancellation capacity under bounded concurrency and never admits overload', async t => {
  const releases = []
  const f = fixture({ get: () => new Promise(resolve => releases.push(resolve)) })
  t.after(f.server.stop); await f.initialize()
  for (let id = 0; id < MAX_IN_FLIGHT; id++) {
    f.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'factorio_receipt', arguments: { operation_id: 'x', wait_ms: 30000 } } })
  }
  assert.equal((await f.request(100, 'tools/call', { name: 'factorio_context' })).error.code, -32000)
  assert.equal((await f.request(101, 'tools/call', { name: 'factorio_cancel', arguments: { operation_id: 'x' } })).result.isError, false)
  assert.equal(releases.length, MAX_IN_FLIGHT)
  releases.forEach(release => release({ state: 'running' }))
  f.input.end(); await f.server.done
})

test('MCP notifications and client disconnect never silently cancel gameplay', async t => {
  let release
  const f = fixture({ submit: () => new Promise(resolve => { release = resolve }) })
  t.after(f.server.stop); await f.initialize()
  f.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: {} } } } })
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
  f.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'factorio_cancel', arguments: { operation_id: 'x' } } })
  f.input.end()
  release({ operation_id: 'x', state: 'running' })
  await f.server.done
  assert.equal(f.calls.length, 0)
  assert.equal(f.replies.length, 2)
  assert.equal(f.replies[1].result.structuredContent.state, 'running')
})

test('rejects duplicate active request IDs rather than dispatching a second mutation', async t => {
  let release
  let mutations = 0
  const f = fixture({ submit: () => { mutations++; return new Promise(resolve => { release = resolve }) } })
  t.after(f.server.stop); await f.initialize()
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: {} } } } }
  f.send(request); f.send(request)
  assert.equal(f.replies.at(-1).error.code, -32600)
  assert.equal(mutations, 1)
  release({ state: 'running' }); f.input.end(); await f.server.done
})

test('byte framing tolerates split UTF-8 and multiple lines in one chunk', async t => {
  const f = fixture(); t.after(f.server.stop); await f.initialize()
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'unicode-λ', method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
  const split = bytes.indexOf(Buffer.from('λ')) + 1
  f.input.write(bytes.subarray(0, split)); f.input.write(bytes.subarray(split))
  f.input.end(); await f.server.done
  assert.deepEqual(f.replies.slice(1).map(reply => reply.id), ['unicode-λ', 2])
})

test('rejects oversized, malformed, batch, and truncated messages without mutation, then recovers framing', async t => {
  const f = fixture(); t.after(f.server.stop); await f.initialize()
  f.input.write('x'.repeat(MAX_MESSAGE_BYTES + 1))
  f.input.write('tail\n{invalid}\n[]\n')
  f.input.write(Buffer.from([0xFF, 10]))
  const ping = await f.request(1, 'ping')
  assert.deepEqual(ping.result, {})
  f.input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'factorio_context' } }))
  await f.server.done
  assert.deepEqual(f.replies.filter(reply => reply.error).map(reply => reply.error.code), [-32600, -32700, -32600, -32700, -32700])
  assert.equal(f.calls.length, 0)
})

test('invalid JSON-RPC envelopes cannot reach tools', async t => {
  const f = fixture(); t.after(f.server.stop)
  for (const message of [null, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: 1.5, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]) f.send(message)
  assert.equal(f.replies.length, 5)
  assert.ok(f.replies.every(reply => reply.error.code === -32600 && reply.id === null))
  assert.equal(f.calls.length, 0)
})

test('stop detaches immediately without cancelling an in-flight gameplay call', async () => {
  let release
  let cancelled = false
  const f = fixture({ submit: () => new Promise(resolve => { release = resolve }), cancel: () => { cancelled = true } })
  await f.initialize()
  f.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'factorio_submit', arguments: { request_id: 'x', operation: { name: 'wait', args: {} } } } })
  f.server.stop(); await f.server.done
  release({ state: 'running' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, false)
  assert.equal(f.replies.length, 1)
})

test('real child-process stdio emits only newline-delimited MCP messages (fake runtime)', async () => {
  const moduleUrl = new URL('./mcp-server.mjs', import.meta.url).href
  const script = `import { startMcpServer } from ${JSON.stringify(moduleUrl)};
const runtime = Object.fromEntries(['capabilities','context','observe','submit','get','cancel','resume'].map(name => [name, async args => ({name,args})]));
startMcpServer({runtime});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = once(child, 'exit')
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'factorio_context' } },
  ].map(message => `${JSON.stringify(message)}\n`).join(''))
  assert.deepEqual(await exited, [0, null])
  assert.equal(stderr, '')
  assert.ok(stdout.endsWith('\n'))
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(replies.length, 2)
  assert.equal(replies[1].result.structuredContent.name, 'context')
})
