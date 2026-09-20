import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as runtime from './structured-policy.mjs'
import * as staging from '../staging/structured-policy.mjs'

const root = new URL('../../../', import.meta.url)
const contract = JSON.parse(await readFile(new URL('contracts/factorio-tool-contract.json', root), 'utf8'))
const stagingSource = await readFile(new URL('deploy/pterodactyl/staging/structured-policy.mjs', root), 'utf8')

function stagingOperationNames() {
  const block = stagingSource.match(/const operationKeys = \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(block, 'operationKeys contract block must remain discoverable')
  return [...block.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map(match => match[1]).sort()
}

function namesForSurface(definitions, surface) {
  return Object.entries(definitions)
    .filter(([, definition]) => definition.surfaces.includes(surface))
    .map(([name]) => name)
    .sort()
}

const toolSamples = {
  getActorStatus: {},
  getTaskStatus: {},
  getInventoryItems: {},
  getEquipmentStatus: {},
  getRecipe: { item: 'iron-plate' },
  getRecipeDetails: { item_or_recipe: 'iron-plate' },
  discoverPrototypes: { capability: 'mining', resource_name: 'iron-ore' },
  getPrototypeDetails: { name: 'transport-belt' },
  findSkills: { query: 'early iron plate smelting', limit: 3 },
  getSkillDetails: { id: 'starter-smelting-row' },
  getPlayerStatus: { player_name: 'Louis' },
  getNearbyEntities: {},
  getPlacementCandidates: { entity_name: 'stone-furnace' },
  findLongRangeEntities: { name: 'iron-ore' },
  findNearestEnemy: {},
  getEntityStatus: { name: 'stone-furnace' },
  getEntityGeometry: { unit_number: 1 },
  getLogisticsTopology: { unit_number: 1 },
  measureTransportThroughput: { kind: 'inserter_instance', unit_number: 1 },
  getNavigationStatus: {},
  getFollowStatus: {},
  getDefenseStatus: {},
  getCraftingStatus: {},
  getResearchStatus: {},
  getResearchRequest: { request_id: 1 },
  getTechnology: { name: 'automation' },
  getCombatStatus: {},
  getProductionScope: { calculation_id: 'scope-1', target: { type: 'item', name: 'iron-plate' } },
  solveProduction: { calculation_id: 'solve-1', target: { type: 'item', name: 'iron-plate', rate_per_second: 1 } },
  getTransportCapacity: { kind: 'belt', prototype_name: 'transport-belt' },
  getLocalSpatialObservation: { position: { x: 0, y: 0 } },
  planPlacement: { entity_name: 'assembling-machine-1', position: { x: 0, y: 0 } },
  findConstructionSites: { width: 4, height: 4, position: { x: 0, y: 0 } },
  validateConstructionPlan: { plan_id: 'plan-1', placements: [{ entity_name: 'stone-furnace', x: 0, y: 0 }] },
  inspectConstructionIntent: { x: 0, y: 0, entity_name: 'stone-furnace' },
  getResearchPath: { name: 'automation' },
}

test('staging owns exactly the operations declared as the shared Pterodactyl base', () => {
  const expected = Object.entries(contract.operations)
    .filter(([, definition]) => definition.pterodactyl_layer === 'staging-base')
    .map(([name]) => name)
    .sort()
  assert.deepEqual(stagingOperationNames(), expected)
})

test('runtime-v8 delegates base operation behavior while owning place_candidate as an explicit extension', () => {
  const baseSample = { name: 'walk_to_position', args: { x: 0, y: 0 } }
  assert.deepEqual(runtime.parseOperation(baseSample), staging.parseOperation(baseSample))
  assert.equal(runtime.renderOperation(baseSample), staging.renderOperation(baseSample))

  const extensions = Object.entries(contract.operations)
    .filter(([, definition]) => definition.pterodactyl_layer === 'runtime-v8-extension')
    .map(([name]) => name)
    .sort()
  assert.deepEqual(extensions, ['place_candidate'])
  const candidate = runtime.parseOperation({ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } })
  assert.equal(candidate.name, 'place_candidate')
  assert.match(runtime.renderOperation(candidate), /remote\.call\(["']autorio_operations["']\s*,\s*["']place_candidate["']/)
})

test('runtime-v8 tool exposure exactly matches the complete declared runtime surface', () => {
  const runtimeNames = runtime.toolDefinitions.map(definition => definition.function.name).sort()
  assert.deepEqual(runtimeNames, namesForSurface(contract.tools, 'pterodactyl-runtime-v8'))
})

test('runtime-v8 tool commands target the canonical Factorio remote interface/function', () => {
  for (const name of namesForSurface(contract.tools, 'pterodactyl-runtime-v8')) {
    const expected = contract.tools[name]
    const command = runtime.toolCommand(name, toolSamples[name])
    const [interfaceName, functionName] = expected.remote
    assert.match(command, new RegExp(`remote\\.call\\(["']${interfaceName}["']\\s*,\\s*["']${functionName}["']`), `${name} remote mapping drifted`)
  }
})

test('intentional runtime-only tools stay explicit without requiring symmetry adapters', () => {
  const runtimeOnly = Object.entries(contract.tools)
    .filter(([, definition]) => definition.surface_policy === 'runtime-v8-only')
    .map(([name]) => name)
    .sort()
  assert.deepEqual(runtimeOnly, [
    'findSkills',
    'getLocalSpatialObservation',
    'getResearchPath',
    'getResearchRequest',
    'getSkillDetails',
    'measureTransportThroughput',
    'planPlacement',
    'validateConstructionPlan',
  ])
  for (const name of runtimeOnly) assert.deepEqual(contract.tools[name].surfaces, ['pterodactyl-runtime-v8'])
})

test('capabilities already present on both providers stay shared', () => {
  for (const name of ['getPlacementCandidates', 'findConstructionSites']) {
    assert.equal(contract.tools[name].surface_policy, 'shared')
    assert.deepEqual(contract.tools[name].surfaces, ['ordinary-agent', 'pterodactyl-runtime-v8'])
  }
})

test('canonical operation defaults remain aligned with the Pterodactyl base parser', () => {
  const defaults = {
    walk_to_entity_exact: { args: { unit_number: 1 }, expected: { reach_distance: 2.5 } },
    walk_to_position: { args: { x: 0, y: 0 }, expected: { reach_distance: 0.75 } },
    follow_player: { args: { player_name: 'Louis' }, expected: { follow_distance: 4 } },
    equip_weapon: { args: { item_name: 'pistol' }, expected: { slot: 1 } },
    equip_ammo: { args: { item_name: 'firearm-magazine' }, expected: { slot: 1 } },
    mine_entity: { args: { entity_name: 'tree-01' }, expected: { count: 1 } },
    mine_resource_at: { args: { resource_name: 'iron-ore', x: 0, y: 0 }, expected: { count: 1 } },
    gather_resource: { args: { resource_name: 'iron-ore' }, expected: { count: 1, search_radius: 256 } },
    rotate_entity: { args: { unit_number: 1 }, expected: { reverse: false } },
    craft_item: { args: { item_name: 'iron-gear-wheel' }, expected: { count: 1 } },
    attack_nearest_enemy: { args: {}, expected: { search_radius: 50 } },
    clear_enemy_area: { args: {}, expected: { search_radius: 96 } },
  }

  for (const [name, fixture] of Object.entries(defaults)) {
    const parsed = staging.parseOperation({ name, args: fixture.args })
    for (const [key, value] of Object.entries(fixture.expected)) {
      assert.equal(parsed.args[key], value, `${name}.${key} default drifted`)
      assert.equal(contract.operations[name].defaults[key], value, `${name}.${key} manifest default drifted`)
    }
  }
})


test('planner control tool is provider-only and does not pollute the Factorio observation surface', () => {
  const factorioNames = runtime.toolDefinitions.map(definition => definition.function.name)
  const providerNames = runtime.providerToolDefinitions.map(definition => definition.function.name)
  assert.equal(factorioNames.includes('submitPlan'), false)
  assert.equal(providerNames.includes('submitPlan'), true)
  assert.equal(providerNames.length, factorioNames.length + 1)
})

test('submitPlan accepts natural-language assistant content while keeping control state structured', () => {
  const payload = runtime.plannerControlPayloadFromMessage({
    content: 'I am mining the next ore batch now.',
    tool_calls: [{
      id: 'control-1',
      type: 'function',
      function: {
        name: 'submitPlan',
        arguments: JSON.stringify({
          chatMessage: 'fallback',
          plan: ['Mine iron ore'],
          currentStep: 0,
          operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
        }),
      },
    }],
  })
  assert.equal(payload.chatMessage, 'I am mining the next ore batch now.')
  assert.deepEqual(payload.plan, ['Mine iron ore'])
  assert.equal(payload.operations[0].name, 'mine_entity')
})

// The advertised schema and the parser's exact-key list are two statements of
// the same contract. `project` drifted between them: the parser accepted it long
// after anything consumed it, and the strict plan surface then rejected the whole
// submission as an unexpected argument. Pin them to each other.
test('submitPlan advertises exactly the fields its parser accepts', () => {
  const definition = runtime.plannerControlToolDefinitions
    .find(tool => tool.function.name === runtime.PLANNER_CONTROL_TOOL_NAME)
  const advertised = Object.keys(definition.function.parameters.properties).sort()
  assert.deepEqual(advertised, ['chatMessage', 'checkpoint', 'currentStep', 'operations', 'plan', 'roadmap', 'roadmapNodeIds'])
  assert.equal(advertised.includes('project'), false)

  const sample = { chatMessage: 'x', plan: [], currentStep: 0, operations: [], roadmap: [], roadmapNodeIds: [], checkpoint: {} }
  for (const field of advertised) {
    assert.ok(Object.hasOwn(sample, field), `no parity sample for advertised field ${field}`)
    assert.doesNotThrow(() => runtime.plannerControlPayloadFromMessage({
      content: '',
      tool_calls: [{
        id: 'control-1',
        type: 'function',
        function: {
          name: runtime.PLANNER_CONTROL_TOOL_NAME,
          arguments: JSON.stringify({ chatMessage: 'x', plan: [], currentStep: 0, operations: [], [field]: sample[field] }),
        },
      }],
    }), `submitPlan advertises ${field} but its parser refuses it`)
  }
})

test('the Roadmap Shelf surface cannot carry executable work', () => {
  const definition = runtime.plannerControlToolDefinitions
    .find(tool => tool.function.name === runtime.PLANNER_CONTROL_TOOL_NAME)
  const node = definition.function.parameters.properties.roadmap.items
  assert.equal(node.additionalProperties, false)
  // Not advertised, and not merely undocumented: a node that could carry steps,
  // operations or its own status would stop being coarse guidance.
  for (const forbidden of ['steps', 'plan', 'operations', 'status', 'currentStep']) {
    assert.equal(Object.hasOwn(node.properties, forbidden), false, `roadmap node must not advertise ${forbidden}`)
  }
})

test('submitPlan rejects mixed observation/control batches and malformed arguments', () => {
  assert.throws(() => runtime.plannerControlPayloadFromMessage({
    content: '',
    tool_calls: [
      { id: 'control-1', type: 'function', function: { name: 'submitPlan', arguments: '{"plan":[],"currentStep":0,"operations":[]}' } },
      { id: 'observe-1', type: 'function', function: { name: 'getTaskStatus', arguments: '{}' } },
    ],
  }), /submitPlan must be the only tool call/i)

  assert.throws(() => runtime.plannerControlPayloadFromMessage({
    content: '',
    tool_calls: [{ id: 'control-1', type: 'function', function: { name: 'submitPlan', arguments: '{bad json' } }],
  }), /valid JSON/i)
})
