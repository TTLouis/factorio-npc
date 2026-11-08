import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { MCP_TOOLS } from '../../../tools/external-harness/mcp-server.mjs'
import {
  createInProcessOperatorTools,
  OPERATOR_TOOL_METHODS,
  OPERATOR_TOOLS,
  operatorProviderToolDefinitions,
} from './operator-tool-surface.mjs'

const root = new URL('../../../', import.meta.url)
const contract = JSON.parse(await readFile(new URL('contracts/factorio-tool-contract.json', root), 'utf8'))

function fakeRuntime(overrides = {}) {
  const calls = []
  const runtime = {}
  for (const method of Object.values(OPERATOR_TOOL_METHODS)) {
    runtime[method] = async input => { calls.push([method, input]); return { ok: true, method } }
  }
  return { runtime: Object.assign(runtime, overrides), calls }
}

test('MCP server and in-process operator share one catalog that matches the contract manifest', () => {
  assert.equal(MCP_TOOLS, OPERATOR_TOOLS)
  assert.deepEqual(contract.external_harness.mcp_tools, OPERATOR_TOOLS.map(tool => tool.name))
  assert.deepEqual(Object.keys(OPERATOR_TOOL_METHODS), OPERATOR_TOOLS.map(tool => tool.name))
  assert.deepEqual(operatorProviderToolDefinitions.map(tool => tool.function.name), OPERATOR_TOOLS.map(tool => tool.name))
  for (const [index, tool] of OPERATOR_TOOLS.entries()) {
    const definition = operatorProviderToolDefinitions[index]
    assert.equal(definition.type, 'function')
    assert.equal(definition.function.description, tool.description)
    assert.equal(definition.function.parameters, tool.inputSchema)
  }
})

test('in-process call dispatches each tool to the same runtime method as MCP', async () => {
  const { runtime, calls } = fakeRuntime()
  const tools = createInProcessOperatorTools({ runtime })
  const result = await tools.call('factorio_receipt', { operation_id: 'op-1', wait_ms: 1000 })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { ok: true, method: 'get' })
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent))
  assert.deepEqual(calls, [['get', { operation_id: 'op-1', wait_ms: 1000 }]])
})

test('bad model input is refused before the runtime runs', async () => {
  const { runtime, calls } = fakeRuntime()
  const tools = createInProcessOperatorTools({ runtime })
  const unknown = await tools.call('factorio_lua', {})
  assert.equal(unknown.isError, true)
  assert.equal(unknown.structuredContent.code, 'unknown_tool')
  assert.equal(unknown.structuredContent.effect, 'not_happened')
  const extra = await tools.call('factorio_context', { verbose: true })
  assert.equal(extra.structuredContent.code, 'invalid_tool_arguments')
  const wait = await tools.call('factorio_receipt', { operation_id: 'op-1', wait_ms: 30001 })
  assert.equal(wait.structuredContent.code, 'invalid_tool_arguments')
  const missing = await tools.call('factorio_submit', { request_id: 'r1' })
  assert.equal(missing.structuredContent.code, 'invalid_tool_arguments')
  assert.deepEqual(calls, [])
})

test('runtime refusals keep the MCP error envelope, including not_happened details', async () => {
  const refusal = Object.assign(new Error('internal'), { code: 'preflight_rejected', effect: 'not_happened', publicMessage: 'Footprint occupied.', details: { blocker: 'character' } })
  const { runtime } = fakeRuntime({ submit: async () => { throw refusal } })
  const tools = createInProcessOperatorTools({ runtime })
  const result = await tools.call('factorio_submit', { request_id: 'r1', operation: { name: 'wait', args: { ticks: 60 } } })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, { code: 'preflight_rejected', message: 'Footprint occupied.', effect: 'not_happened', journal_slot_used: false, details: { blocker: 'character' } })
  const { runtime: crashing } = fakeRuntime({ context: async () => { throw new Error('secret path /x') } })
  const crash = await createInProcessOperatorTools({ runtime: crashing }).call('factorio_context', {})
  assert.equal(crash.structuredContent.code, 'runtime_error')
  assert.doesNotMatch(crash.content[0].text, /secret path/)
})

test('a runtime missing a method is rejected at construction', () => {
  const { runtime } = fakeRuntime()
  delete runtime.resume
  assert.throws(() => createInProcessOperatorTools({ runtime }), /runtime\.resume is required/)
})

// Goal binding is metadata, routed through the same public operator catalog.
test('machine destination binding reaches the runtime once and rejects an invented acceptance key', async () => {
  const { runtime, calls } = fakeRuntime()
  const tools = createInProcessOperatorTools({ runtime })
  const result = await tools.call('bindMachineDelivery', { unit_number: 41 })
  assert.equal(result.isError, false)
  assert.deepEqual(calls, [['bindMachineDelivery', { unit_number: 41 }]])
  const refused = await tools.call('bindMachineDelivery', { unit_number: 41, acceptance_key: 'invented' })
  assert.equal(refused.isError, true)
  assert.equal(calls.length, 1)
})
