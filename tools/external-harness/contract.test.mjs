import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { libraryMetadata } from './library.mjs'
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from './mcp-server.mjs'
import { capabilities, LINE_PROTOTYPES, OBSERVATION_NAMES, OPERATION_NAMES } from './native-bridge.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../contracts/factorio-tool-contract.json', import.meta.url), 'utf8'))
const external = manifest.external_harness

test('external subset and MCP lifecycle exactly match the canonical manifest', () => {
  assert.deepEqual(external.operations, [...OPERATION_NAMES])
  assert.deepEqual(external.observations, [...OBSERVATION_NAMES])
  assert.deepEqual(external.place_entity_prototypes, capabilities().limits.placement_prototypes)
  assert.deepEqual(external.fluid_candidate_prototypes, capabilities().limits.fluid_candidate_prototypes)
  assert.deepEqual(external.mcp_tools, MCP_TOOLS.map(tool => tool.name))
  assert.equal(MCP_TOOLS.length, 9)
  const binding = MCP_TOOLS.find(tool => tool.name === manifest.finite_machine_delivery.model_binding_tool)
  assert.deepEqual(Object.keys(binding.inputSchema.properties), manifest.finite_machine_delivery.model_binding_args)
  assert.deepEqual(binding.inputSchema.required, ['unit_number'])
  assert.equal(binding.inputSchema.additionalProperties, false)
  assert.equal(external.operations.includes(binding.name), false, 'destination selection is goal metadata, not an admitted world operation')
  assert.equal(external.observations.includes(binding.name), false, 'immutable metadata selection is not a cacheable observation')
  assert.equal(external.protocol_version, MCP_PROTOCOL_VERSION)
  assert.equal(external.operation_admission_protocol, 2)
  // External-only operations are not part of the shared ordinary-agent/runtime-v8 operation set.
  for (const name of external.operations) {
    if (Object.hasOwn(external.external_only_operations, name)) assert.ok(!Object.hasOwn(manifest.operations, name), name)
    else assert.ok(manifest.operations[name].surfaces.includes('pterodactyl-runtime-v8'), name)
  }
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
  for (const name of Object.keys(notes)) assert.ok(['submit_refusals', 'running_receipts', 'exact_adapters'].includes(name) || external.operations.includes(name), name)
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
  assert.equal(external.library.stages, meta.counts.stages)
  assert.deepEqual(external.library.knowledge_categories, meta.knowledge_categories)
  assert.equal(external.library.result_bytes, meta.result_bytes)
  assert.equal(external.library.read_only, true)
})

test('the declared fluid network limit is the native preservation guard bound', () => {
  const source = readFileSync(new URL('../../packages/autorio/src/placement_candidates.ts', import.meta.url), 'utf8')
  assert.equal(Number(source.match(/const MAX_PROTECTED_FLUID_ENTITIES = (\d+)/)?.[1]), external.limits.fluid_network_entities)
  assert.equal(capabilities().limits.fluid_network_entities, external.limits.fluid_network_entities)
  assert.ok(capabilities().operation_notes.place_candidate.includes(`at most ${external.limits.fluid_network_entities} entities`))
})

test('external-only line placement agrees with the bridge and the native mod', () => {
  const catalog = capabilities()
  const line = catalog.operations.find(operation => operation.name === 'place_line')
  assert.deepEqual(line.args, external.external_only_operations.place_line.args)
  assert.deepEqual(external.line_placement_prototypes, [...LINE_PROTOTYPES])
  assert.deepEqual(catalog.limits.line_prototypes, [...LINE_PROTOTYPES])
  assert.equal(catalog.limits.line_count, external.limits.line_count)
  assert.equal(catalog.limits.line_spacing, external.limits.line_spacing)
  const mod = readFileSync(new URL('../../packages/autorio/src/line_placement.ts', import.meta.url), 'utf8')
  assert.match(mod, new RegExp(`count: ${external.limits.line_count}, spacing: ${external.limits.line_spacing}, history: \\d+, blockers: ${external.limits.footprint_blockers},`))
  assert.equal(Number(mod.match(/EXTERNAL_FOOTPRINT_SCAN_LIMIT = (\d+)/)?.[1]), external.limits.footprint_scan)
  // A completed line's record must outlive its admission, or an old line's receipt turns uncertain and fences submissions.
  const admission = readFileSync(new URL('../../packages/autorio/src/operation_admission.ts', import.meta.url), 'utf8')
  const lineHistory = Number(mod.match(/LINE_PLACEMENT_LIMITS = \{[^}]*history: (\d+)/)?.[1])
  const admissionHistory = Number(admission.match(/ADMISSION_LIMITS = \{[^}]*history: (\d+)/)?.[1])
  assert.ok(Number.isSafeInteger(admissionHistory) && lineHistory >= admissionHistory, `line history ${lineHistory} >= admission history ${admissionHistory}`)
  assert.ok(mod.includes(`LINE_PLACEMENT_PROTOTYPES = [${LINE_PROTOTYPES.map(name => `'${name}'`).join(', ')}]`))
  const bridge = readFileSync(new URL('../../deploy/pterodactyl/runtime-v8/operator-native-bridge.mjs', import.meta.url), 'utf8')
  assert.ok(bridge.includes(`limit=${external.limits.footprint_scan}}); if #found>=${external.limits.footprint_scan} then`))
  assert.ok(bridge.includes(`#blockers<${external.limits.footprint_blockers} and blocks(e) then`))
  assert.ok(mod.includes(`blockers.length < LINE_PLACEMENT_LIMITS.blockers`) && mod.includes('footprint_blocker(entity, placed)'))
  const control = readFileSync(new URL('../../packages/autorio/src/control.ts', import.meta.url), 'utf8')
  assert.match(control, /external_line_placement_supported: 1/)
  assert.equal(external.line_placement_native_safety.required_capability, 'external_line_placement_supported')
  assert.ok(catalog.operation_notes.place_line.includes(String(external.limits.line_count)))
})

test('external-only ground-item pickup agrees with the bridge and the native mod', () => {
  const catalog = capabilities()
  const pickup = catalog.operations.find(operation => operation.name === 'pick_up_ground_items')
  assert.deepEqual(pickup.args, external.external_only_operations.pick_up_ground_items.args)
  assert.equal(pickup.arguments.radius.default, external.external_only_operations.pick_up_ground_items.defaults.radius)
  assert.equal(pickup.arguments.radius.maximum, external.limits.pickup_radius)
  assert.equal(catalog.limits.pickup_radius, external.limits.pickup_radius)
  assert.equal(catalog.limits.pickup_items, external.limits.pickup_items)
  const mod = readFileSync(new URL('../../packages/autorio/src/ground_item_pickup.ts', import.meta.url), 'utf8')
  assert.match(mod, new RegExp(`export const MAX_PICKUP_RADIUS = ${external.limits.pickup_radius}\\r?\\n`))
  const items = readFileSync(new URL('../../packages/autorio/src/placement_ground_items.ts', import.meta.url), 'utf8')
  assert.match(items, new RegExp(`export const MAX_GROUND_ITEMS = ${external.limits.pickup_items}\\r?\\n`))
  const control = readFileSync(new URL('../../packages/autorio/src/control.ts', import.meta.url), 'utf8')
  assert.match(control, /external_ground_pickup_supported: 1/)
  assert.match(control, /pick_up_ground_items: \(x: number, y: number, radius: number = 0\)/)
  assert.equal(external.ground_pickup_native_safety.required_capability, 'external_ground_pickup_supported')
  const admission = readFileSync(new URL('../../packages/autorio/src/operation_admission.ts', import.meta.url), 'utf8')
  assert.match(admission.match(/PURE_SUBMIT_OPERATIONS = \[[^\]]*\]/)?.[0] ?? '', /'pick_up_ground_items'/)
  assert.ok(catalog.operation_notes.pick_up_ground_items.includes(`1-${external.limits.pickup_items} ground stacks`))
})
