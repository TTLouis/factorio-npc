import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from './mcp-server.mjs'
import { capabilities, OBSERVATION_NAMES, OPERATION_NAMES } from './native-bridge.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../contracts/factorio-tool-contract.json', import.meta.url), 'utf8'))
const external = manifest.external_harness

test('external subset and MCP lifecycle exactly match the canonical manifest', () => {
  assert.deepEqual(external.operations, [...OPERATION_NAMES])
  assert.deepEqual(external.observations, [...OBSERVATION_NAMES])
  assert.deepEqual(external.mcp_tools, MCP_TOOLS.map(tool => tool.name))
  assert.equal(external.protocol_version, MCP_PROTOCOL_VERSION)
  assert.equal(external.operation_admission_protocol, 2)
  for (const name of external.operations) assert.ok(manifest.operations[name].surfaces.includes('pterodactyl-runtime-v8'))
  for (const name of external.observations) assert.ok(manifest.tools[name].surfaces.includes('pterodactyl-runtime-v8'))
})

test('external observations expose the authoritative argument schemas on demand', () => {
  const catalog = capabilities()
  assert.deepEqual(catalog.observation_schemas.map(tool => tool.name).sort(), [...OBSERVATION_NAMES].sort())
  assert.ok(catalog.observation_schemas.find(tool => tool.name === 'getRecipeDetails').inputSchema.required.includes('item_or_recipe'))
  assert.ok(Object.hasOwn(catalog.observation_schemas.find(tool => tool.name === 'getEntityStatus').inputSchema.properties, 'unit_number'))
})

test('declared external bounds agree with executable capability limits', () => {
  const catalog = capabilities()
  for (const key of ['wait_ticks', 'count', 'transfer_count', 'walk_distance']) assert.equal(catalog.limits[key], external.limits[key])
  const wait = MCP_TOOLS.find(tool => tool.name === 'factorio_receipt').inputSchema.properties.wait_ms.maximum
  assert.equal(wait, external.limits.receipt_wait_ms)
})
