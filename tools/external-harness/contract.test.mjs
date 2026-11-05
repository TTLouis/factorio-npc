import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { libraryMetadata } from './library.mjs'
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from './mcp-server.mjs'
import { capabilities, OBSERVATION_NAMES, OPERATION_NAMES } from './native-bridge.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../contracts/factorio-tool-contract.json', import.meta.url), 'utf8'))
const external = manifest.external_harness

test('external subset and MCP lifecycle exactly match the canonical manifest', () => {
  assert.deepEqual(external.operations, [...OPERATION_NAMES])
  assert.deepEqual(external.observations, [...OBSERVATION_NAMES])
  assert.deepEqual(external.place_entity_prototypes, capabilities().limits.placement_prototypes)
  assert.deepEqual(external.fluid_candidate_prototypes, capabilities().limits.fluid_candidate_prototypes)
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

test('external operation notes match the canonical manifest and name real operations', () => {
  const notes = capabilities().operation_notes
  assert.deepEqual(Object.keys(notes), external.operation_notes)
  for (const name of Object.keys(notes)) assert.ok(['submit_refusals', 'running_receipts'].includes(name) || external.operations.includes(name), name)
  assert.ok(notes.walk_to_position.includes(String(external.limits.walk_distance)))
})

test('external observation notes match the canonical manifest and name real observations', () => {
  const notes = capabilities().observation_notes
  assert.deepEqual(Object.keys(notes), external.observation_notes)
  for (const name of Object.keys(notes)) assert.ok(external.observations.includes(name), name)
})


test('external library manifest agrees with typed local capability metadata', () => {
  const meta = libraryMetadata()
  assert.equal(external.library.tool, meta.tool)
  assert.equal(external.library.source, meta.source)
  assert.equal(external.library.knowledge, meta.counts.knowledge)
  assert.equal(external.library.skills, meta.counts.skills)
  assert.equal(external.library.result_bytes, meta.result_bytes)
  assert.equal(external.library.read_only, true)
})

test('the declared fluid network limit is the native preservation guard bound', () => {
  const source = readFileSync(new URL('../../packages/autorio/src/placement_candidates.ts', import.meta.url), 'utf8')
  assert.equal(Number(source.match(/const MAX_PROTECTED_FLUID_ENTITIES = (\d+)/)?.[1]), external.limits.fluid_network_entities)
  assert.equal(capabilities().limits.fluid_network_entities, external.limits.fluid_network_entities)
  assert.ok(capabilities().operation_notes.place_candidate.includes(`at most ${external.limits.fluid_network_entities} entities`))
})
