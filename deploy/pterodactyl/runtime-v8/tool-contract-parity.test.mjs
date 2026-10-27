import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as runtime from './structured-policy.mjs'
import * as staging from '../staging/structured-policy.mjs'

const root = new URL('../../../', import.meta.url)
const contract = JSON.parse(await readFile(new URL('contracts/factorio-tool-contract.json', root), 'utf8'))

test('fluid preservation projection and admission metadata remain native and versioned', async () => {
  const projection = contract.tools.getEntityGeometry.fluid_preservation_projection
  assert.equal(projection.version, 3)
  assert.equal(projection.storage_limit, 16)
  assert.equal(projection.connection_limit, 16)
  const knowledge = await readFile(new URL('packages/autorio/src/knowledge.ts', root), 'utf8')
  assert.match(knowledge, /fluid_geometry_version: 3/)
  for (const field of projection.storage_fields.concat(projection.connection_fields)) assert.match(knowledge, new RegExp(`\\b${field}:`))
  const placement = await readFile(new URL('packages/autorio/src/placement_candidates.ts', root), 'utf8')
  const items = await readFile(new URL('packages/autorio/src/placement_preflight.ts', root), 'utf8')
  for (const field of contract.operations.place_candidate.native_preservation_preflight_fields) assert.match(placement + items, new RegExp(`\\b${field}:`))
  const join = contract.operations.place_candidate.native_preservation_join_projection
  const argument = contract.operations.place_candidate.native_preservation_argument_projection
  assert.equal(argument.version, 1); assert.equal(argument.kind, 'relation_required'); assert.equal(argument.unknown_absent, true)
  assert.deepEqual(argument.not_authority, ['connection', 'placement', 'completion'])
  assert.equal(join.version, 4); assert.equal(join.closure_limit, 16)
  for (const field of join.required) assert.match(placement, new RegExp(`\\b${field}[:,]`))
  assert.deepEqual(join.harness_only_freeze_remote, ['autorio_preflight', 'fluid_preservation_candidate'])
  assert.equal(Object.hasOwn(contract.tools, 'fluid_preservation_candidate'), false)
  assert.equal(Object.hasOwn(contract.operations, 'fluid_preservation_candidate'), false)
})
test('exact geometry preserves explicit native actor/entity scope for obligation certificates', async () => {
  assert.deepEqual(contract.tools.getEntityGeometry.native_scope_fields,
    ['actor_id', 'actor_surface_index', 'actor_force_index', 'surface_index', 'force_index'])
  const source = await readFile(new URL('packages/autorio/src/knowledge.ts', root), 'utf8')
  for (const field of contract.tools.getEntityGeometry.native_scope_fields) assert.match(source, new RegExp(`\\b${field}:`))
  assert.match(runtime.toolCommand('getEntityGeometry', { unit_number: 21 }), /autorio_knowledge.*entity_geometry.*21/)
  assert.equal(runtime.toolCommand('getEntityGeometry', { unit_number: 21 }), staging.toolCommand('getEntityGeometry', { unit_number: 21 }))
})
function stagingOperationNames() {
  return staging.approvedOperationNames().sort()
}

function namesForSurface(definitions, surface) {
  return Object.entries(definitions)
    .filter(([, definition]) => definition.surfaces.includes(surface))
    .map(([name]) => name)
    .sort()
}

const toolSamples = {
  validateConstructionReservation: { goal_id: 'goal-1', plan_id: 'plan-1', x: 2, y: 2, width: 4, height: 4 },
  getConstructionReservations: {},
  getReservationDesignInput: { reservation_id: 1, revision: 1 },
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
  getFluidSourceTiles: { fluid_name: 'water' },
  getPumpSitePreparation: { x: 0, y: 0, direction: 0 },
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
  getMiningDetails: { resource_or_item: 'iron-ore' },
  estimateProductionTime: { target: 'iron-plate', count: 10, steps: [{ item: 'iron-plate', machine: 'stone-furnace' }] },
  getLocalSpatialObservation: { position: { x: 0, y: 0 } },
  planPlacement: { entity_name: 'assembling-machine-1', position: { x: 0, y: 0 } },
  findConstructionSites: { width: 4, height: 4, position: { x: 0, y: 0 } },
  validateConstructionPlan: { plan_id: 'plan-1', placements: [{ entity_name: 'stone-furnace', x: 0, y: 0 }] },
  resumeConstructionLayout: { layout_id: 1 },
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
  assert.deepEqual(extensions, ['place_candidate', 'prepare_pump_site', 'reserve_construction_area'])
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

test('runtime-v8 tool arguments match the contract where the contract lists them', () => {
  const withArgs = Object.entries(contract.tools).filter(([, definition]) => Array.isArray(definition.args))
  assert.ok(withArgs.some(([name]) => name === 'getRecipeDetails'))
  for (const [name, definition] of withArgs) {
    if (!definition.surfaces.includes('pterodactyl-runtime-v8')) continue
    const tool = runtime.toolDefinitions.find(entry => entry.function.name === name)
    assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(), [...definition.args].sort(), `${name} arguments drifted`)
  }
  // The optional fuel reaches the mod as recipe_details' third argument.
  assert.match(runtime.toolCommand('getRecipeDetails', { item_or_recipe: 'iron-plate', fuel_name: 'coal' }), /"recipe_details",'iron-plate',1,'coal'\)/)
})

test('intentional runtime-only tools stay explicit without requiring symmetry adapters', () => {
  const runtimeOnly = Object.entries(contract.tools)
    .filter(([, definition]) => definition.surface_policy === 'runtime-v8-only')
    .map(([name]) => name)
    .sort()
  assert.deepEqual(runtimeOnly, [
    'estimateProductionTime',
    'findSkills',
    'getConstructionReservations',
    'getFluidSourceTiles',
    'getLocalSpatialObservation',
    'getMiningDetails',
    'getPumpSitePreparation',
    'getResearchPath',
    'getResearchRequest',
    'getReservationDesignInput',
    'getSkillDetails',
    'measureTransportThroughput',
    'planPlacement',
    'resumeConstructionLayout',
    'validateConstructionPlan',
    'validateConstructionReservation',
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
  assert.deepEqual(advertised, ['assessmentOnly', 'chatMessage', 'checkpoint', 'currentStep', 'developmentMode', 'goal', 'observationRequest', 'operations', 'plan', 'roadmap', 'roadmapNodeIds', 'semanticCompletion', 'stepCompletions', 'stepId', 'timeReview'])
  assert.equal(advertised.includes('project'), false)

  const sample = { observationRequest: { stepId: 's', tool: 'getInventoryItems', args: {}, rationale: 'Need current inventory.' }, assessmentOnly: true, chatMessage: 'x', plan: [], currentStep: 0, operations: [], roadmap: [], roadmapNodeIds: [], developmentMode: 'vertical', checkpoint: {}, semanticCompletion: { stepId: 'step_1' }, stepCompletions: [], stepId: 'step_1', goal: { scope: 'finite', summary: 'x', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] }, timeReview: { decision: 'keep_serial', reason: 'x' } }
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

// The executor has its own submitPlan (same name): stepId and operations are required, plan and currentStep are not
// advertised, and every field it does advertise is one the parser accepts. The planner's definition above is unchanged.
test('the executor submitPlan advertises exactly the executor fields, all of which the parser accepts', () => {
  const [definition] = runtime.executorControlToolDefinitions
  assert.equal(definition.function.name, runtime.PLANNER_CONTROL_TOOL_NAME)
  assert.deepEqual(definition.function.parameters.required, ['stepId', 'operations'])
  const advertised = Object.keys(definition.function.parameters.properties).sort()
  assert.deepEqual(advertised, ['chatMessage', 'checkpoint', 'observationRequest', 'operations', 'semanticCompletion', 'stepId', 'timeReview'])
  const sample = { observationRequest: { stepId: 's', tool: 'getInventoryItems', args: {}, rationale: 'Need current inventory.' }, chatMessage: 'x', operations: [], checkpoint: {}, semanticCompletion: { stepId: 'step_1' }, stepId: 'step_1', timeReview: { decision: 'keep_serial', reason: 'x' } }
  for (const field of advertised) {
    assert.ok(Object.hasOwn(sample, field), `no parity sample for advertised field ${field}`)
    assert.doesNotThrow(() => runtime.plannerControlPayloadFromMessage({
      content: '',
      tool_calls: [{ id: 'control-1', type: 'function', function: { name: runtime.PLANNER_CONTROL_TOOL_NAME, arguments: JSON.stringify({ stepId: 'step_1', operations: [], [field]: sample[field] }) } }],
    }), `the executor submitPlan advertises ${field} but its parser refuses it`)
  }
  const executorTools = runtime.executorProviderToolDefinitions.map(tool => tool.function.name)
  assert.deepEqual(executorTools, runtime.providerToolDefinitions.map(tool => tool.function.name))
})

test('submitPlan preserves aligned deterministic and semantic completion declarations on the control boundary', () => {
  const declarations = [
    { kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'electronics' }] } },
    { kind: 'semantic', rationale: 'Assess the candidate approach using current observations.' },
  ]
  const payload = runtime.plannerControlPayloadFromMessage({ content: '', tool_calls: [{ id: 'control-completion', type: 'function', function: {
    name: runtime.PLANNER_CONTROL_TOOL_NAME,
    arguments: JSON.stringify({ chatMessage: 'x', plan: ['Unlock electronics', 'Assess approach'], currentStep: 0, operations: [], stepCompletions: declarations }),
  } }] })
  assert.deepEqual(payload.stepCompletions, declarations)
  const schema = runtime.plannerControlToolDefinitions.find(tool => tool.function.name === runtime.PLANNER_CONTROL_TOOL_NAME).function.parameters.properties.stepCompletions
  assert.equal(schema.type, 'array')
  assert.equal(schema.maxItems, 30)
  // A later step of an execution plan is {kind:"deterministic"} with no checkpoint (its checkpoint is bound when the step starts).
  assert.deepEqual(schema.items.oneOf.map(branch => branch.required), [['kind'], ['kind', 'rationale']])
  assert.ok(schema.items.oneOf[0].properties.checkpoint)
  assert.ok(schema.items.oneOf.every(branch => branch.additionalProperties === false))
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
test('execute_construction_plan keeps its harness-only native preservation witness in the contract and the mod', async () => {
  const operation = contract.operations.execute_construction_plan
  const witness = operation.native_preservation_witness
  assert.equal(witness.version, 1); assert.equal(witness.read_only, true); assert.equal(witness.local_plans_only, true)
  assert.deepEqual(witness.harness_only_preflight, ['autorio_preflight', 'operation', 'execute_construction_plan'])
  const execution = await readFile(new URL('packages/autorio/src/construction_execution.ts', root), 'utf8')
  for (const field of operation.native_preservation_preflight_fields.concat(witness.binds.filter(name => name !== 'actor_id' && name !== 'surface_index' && name !== 'force_index'))) {
    assert.match(execution, new RegExp(`\\b${field}[:,]`))
  }
  for (const code of witness.refusal_codes) assert.match(execution, new RegExp(`'${code}'`))
  const refusals = await readFile(new URL('packages/autorio/src/refusal_classes.ts', root), 'utf8')
  for (const code of witness.refusal_codes) assert.match(refusals, new RegExp(`\\b${code}:`))
  // The general operation metadata stays preflight-free: only the preservation seam asks for the witness.
  assert.equal(staging.operationMetadataForName('execute_construction_plan').preflight, false)
  assert.equal(staging.renderOperationPreflight({ name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 2 } }), null)
})

test('getPlacementCandidates region is part of the manifest args, the runtime schema and the ordinary-agent schema source', async () => {
  assert.deepEqual([...contract.tools.getPlacementCandidates.args].sort(),
    ['anchor', 'center', 'connects_to', 'covers_position', 'entity_name', 'limit', 'radius', 'region', 'target_resource'])
  const tool = runtime.toolDefinitions.find(entry => entry.function.name === 'getPlacementCandidates')
  assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(), [...contract.tools.getPlacementCandidates.args].sort())
  const command = runtime.toolCommand('getPlacementCandidates', { ...toolSamples.getPlacementCandidates, region: { shape: 'box', left_top: { x: 0, y: 0 }, right_bottom: { x: 4, y: 4 } } })
  assert.match(command, /remote\.call\("autorio_tools","get_placement_candidates",\{.*region=\{shape='box'/)
  const agentSource = await readFile(new URL('packages/agent/src/llm/tools.ts', root), 'utf8')
  for (const key of contract.tools.getPlacementCandidates.args) assert.match(agentSource.slice(agentSource.indexOf('const placementCandidatesSchema')), new RegExp(`(^|\\s)${key}:`), `${key} missing from the agent schema`)
})
