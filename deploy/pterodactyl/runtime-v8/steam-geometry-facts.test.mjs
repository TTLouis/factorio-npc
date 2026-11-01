import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { OBSERVATION_TOOL_TIER, toolCommand, toolDefinitions } from './structured-policy.mjs'

// Steam and electric placement facts reach the executor as ordinary reads: getPlacementCandidates takes a live
// fluid port to join, and the mod answers carry which chunks are generated, which port a candidate joins, which
// poles a pole candidate could wire to, and the nearest pole of an unpowered entity. The loop adds named,
// request-correlated trace rows so a later run can be diagnosed from the logs.

const ENGINE = {
  ok: true, entity_name: 'steam-engine', ordering: 'resource_coverage_then_nearest_to_center', scanned: 12,
  legal_candidate_count: 2, returned_candidate_count: 1,
  connects_to: { unit_number: 200, entity_name: 'boiler', target_ports: [{ storage_index: 2, connection_index: 1, tile: { x: 10.5, y: 18.5 }, own_tile: { x: 10.5, y: 19.5 }, filter: 'steam', flow_direction: 'output' }] },
  candidates: [{ id: 'candidate-1', position: { x: 10.5, y: 16.5 }, direction: 0, distance_from_center: 2,
    connects_to: { unit_number: 200, entity_name: 'boiler', target_port: { storage_index: 2, connection_index: 1 },
      candidate_port: { storage_index: 1, connection_index: 2, direction: 8, filter: 'steam', flow_direction: 'input-output' }, tile: { x: 10.5, y: 18.5 } } }],
  candidate_set_id: 'placement-3',
}
const POLE = {
  ok: true, entity_name: 'small-electric-pole', ordering: 'resource_coverage_then_nearest_to_center',
  electric_pole: { supply_area_distance: 2.5, max_wire_distance: 7.5 }, legal_candidate_count: 2, returned_candidate_count: 2,
  candidates: [
    { id: 'candidate-1', position: { x: 3.5, y: 0.5 }, direction: 0, electric: { poles_in_wire_reach: [{ unit_number: 11 }, { unit_number: 12 }], poles_in_wire_reach_count: 2, covers_entities: [{ unit_number: 21 }], covers_entities_count: 1 } },
    { id: 'candidate-2', position: { x: 0.5, y: 5.5 }, direction: 0, electric: { poles_in_wire_reach: [{ unit_number: 11 }], poles_in_wire_reach_count: 1, covers_entities: [], covers_entities_count: 0 } },
  ],
}
const WATER = {
  ok: true, fluid_name: 'water', actor_position: { x: 0, y: 0 }, surface_index: 1, observed_tick: 77, search_radius: 128,
  coverage: 'generated_bounding_square', coverage_complete: false, checked_chunks: 81, generated_chunk_count: 79, ungenerated_chunk_count: 2,
  ungenerated_chunks: [{ x: 0, y: 0, center: { x: 16, y: 16 } }, { x: 1, y: 0, center: { x: 48, y: 16 } }], ungenerated_chunks_truncated: false,
  empty_result_is_conclusive: false, matching_tile_prototypes: 2,
  samples: [{ name: 'water', fluid_name: 'water', position: { x: 20, y: 40 }, surface_index: 1, distance: 44.7 }],
  returned_count: 1, truncated: false, scanned_tile_limit: 256, scan_truncated: false, ordering: 'nearest_first',
}
const LAB = {
  found: true, actor_position: { x: 0, y: 0 }, radius: 8, unit_number: 30,
  entity: { name: 'lab', type: 'lab', position: { x: 20.5, y: 0.5 }, unit_number: 30, status_name: 'not_plugged_in_electric_network', energy_source: 'electric',
    power_gap: { search_radius: 64, poles_found: 2, nearest_pole: { unit_number: 31, name: 'small-electric-pole', position: { x: 10.5, y: 0.5 }, distance: 10,
      supply_area_distance: 2.5, max_wire_distance: 7.5, supply_area_covers_entity: false, supply_gap_tiles: 6 } } },
}

function deployment() {
  return { revision: 'sgluna-deploy-v8-npc-staging', session: '0123456789abcdef0123456789abcdef', mode: 'npc', actor_id: 18,
    actor_kind: 'standalone_character', connected_players: 0, allowed: true, idle: true, epoch: 3, actor_interface: true,
    operations: true, tools: true }
}

class FakeRcon {
  constructor() { this.commands = [] }
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('"autorio_tools","get_placement_candidates"')) {
      this.commands.push(text)
      return JSON.stringify(text.includes("entity_name='small-electric-pole'") ? POLE : ENGINE)
    }
    if (text.includes('"autorio_tools","get_fluid_source_tiles"')) return JSON.stringify(WATER)
    if (text.includes('"autorio_tools","get_entity_status"')) return JSON.stringify(LAB)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'IDLE', queue_empty: true, queue_length: 0,
        last_completed_batch: { batch_id: 9, task_count: 1, task_types: ['waiting'], tick: 120 } })
    }
    return '{}'
  }
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

async function run() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-steam-geometry-'))
  const traceFile = path.join(dir, 'behavior.jsonl')
  const rcon = new FakeRcon()
  const inputs = []
  const replies = [
    { content: null, tool_calls: [
      call('engine-1', 'getPlacementCandidates', { entity_name: 'steam-engine', connects_to: { unit_number: 200, storage_index: 2 } }),
      call('pole-1', 'getPlacementCandidates', { entity_name: 'small-electric-pole', center: { x: 3.5, y: 0.5 } }),
      call('water-1', 'getFluidSourceTiles', { fluid_name: 'water' }),
      call('lab-1', 'getEntityStatus', { name: 'lab', radius: 8 }),
    ] },
    { content: JSON.stringify({ chatMessage: 'Done.', plan: [], currentStep: 0, operations: [] }) },
  ]
  const agent = new NpcAgentLoop({ rcon, systemPrompt: 'steam geometry test prompt', memory: new CanonicalTaskBoardMemory(),
    stateFile: null, traceFile, provider: async messages => { inputs.push(messages.map(message => ({ ...message }))); return replies.shift() } })
  await agent.request('Place the steam engine and power the lab.', { sender: 'TTLouis' })
  await agent.completed()
  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { rcon, rows, inputs }
}

test('getPlacementCandidates admits connects_to, renders it into the remote request and rejects malformed targets', () => {
  const tool = toolDefinitions.find(row => row.function?.name === 'getPlacementCandidates')
  assert.deepEqual(tool.function.parameters.properties.connects_to.required, ['unit_number'])
  assert.equal(tool.function.parameters.properties.connects_to.additionalProperties, false)
  assert.match(tool.function.description, /connects_to/)
  assert.equal(OBSERVATION_TOOL_TIER.getPlacementCandidates, 'fact')
  assert.equal(toolCommand('getPlacementCandidates', { entity_name: 'boiler', connects_to: { unit_number: 744, storage_index: 1, connection_index: 2 }, limit: 4 }),
    `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_placement_candidates",{entity_name='boiler',connects_to={unit_number=744,storage_index=1,connection_index=2},limit=4})))`)
  assert.match(toolCommand('getPlacementCandidates', { entity_name: 'boiler', connects_to: { unit_number: 5 } }), /connects_to=\{unit_number=5\}/)
  for (const connects_to of [{}, { unit_number: 0 }, { unit_number: 1.5 }, { unit_number: 1, extra: 1 }, { unit_number: 1, storage_index: 9 }, { unit_number: 1, connection_index: 0 }, 'x']) {
    assert.throws(() => toolCommand('getPlacementCandidates', { entity_name: 'boiler', connects_to }), undefined, JSON.stringify(connects_to))
  }
})

test('geometry reads reach the model unchanged and write named, request-correlated trace rows', async () => {
  const { rcon, rows, inputs } = await run()
  assert.equal(rcon.commands.length, 2)
  assert.match(rcon.commands[0], /connects_to=\{unit_number=200,storage_index=2\}/)
  const messages = inputs[1].filter(message => message.role === 'tool')
  assert.deepEqual(JSON.parse(messages.find(message => message.tool_call_id === 'engine-1').content), ENGINE)
  assert.deepEqual(JSON.parse(messages.find(message => message.tool_call_id === 'water-1').content), WATER)

  const requestId = rows.find(row => row.event === 'tool.call')?.request_id
  assert.ok(requestId)
  const placement = rows.filter(row => row.event === 'observation.placement_candidates_observed')
  assert.equal(placement.length, 2)
  for (const row of placement) { assert.equal(row.request_id, requestId); assert.equal(row.data.reason, 'bounded_native_placement_candidate_read') }
  const engine = placement.find(row => row.data.entity_name === 'steam-engine').data
  assert.deepEqual({ ok: engine.ok, ordering: engine.ordering, legal: engine.legal_candidate_count, returned: engine.returned_candidate_count,
    unit: engine.connects_to_unit_number, joined: engine.connects_to_joined_count, electric: engine.electric_candidate_count },
  { ok: true, ordering: 'resource_coverage_then_nearest_to_center', legal: 2, returned: 1, unit: 200, joined: 1, electric: 0 })
  const pole = placement.find(row => row.data.entity_name === 'small-electric-pole').data
  assert.deepEqual({ electric: pole.electric_candidate_count, links: pole.max_poles_in_wire_reach, covered: pole.max_covered_entities, joined: pole.connects_to_joined_count },
    { electric: 2, links: 2, covered: 1, joined: undefined })

  const fluid = rows.find(row => row.event === 'observation.fluid_sources_observed')
  assert.equal(fluid.request_id, requestId)
  assert.deepEqual({ complete: fluid.data.coverage_complete, generated: fluid.data.generated_chunk_count, ungenerated: fluid.data.ungenerated_chunk_count,
    conclusive: fluid.data.empty_result_is_conclusive, ordering: fluid.data.ordering },
  { complete: false, generated: 79, ungenerated: 2, conclusive: false, ordering: 'nearest_first' })
})

test('an entity that shows no power writes a power-gap row naming the nearest pole and the supply gap', async () => {
  const { rows } = await run()
  const requestId = rows.find(row => row.event === 'tool.call')?.request_id
  const gap = rows.find(row => row.event === 'observation.power_gap_observed')
  assert.ok(gap)
  assert.equal(gap.request_id, requestId)
  assert.deepEqual({ reason: gap.data.reason, unit: gap.data.unit_number, status: gap.data.status_name, found: gap.data.poles_found, pole: gap.data.nearest_pole_unit_number,
    distance: gap.data.nearest_pole_distance, covers: gap.data.supply_area_covers_entity, gap: gap.data.supply_gap_tiles },
  { reason: 'entity_shows_no_power', unit: 30, status: 'not_plugged_in_electric_network', found: 2, pole: 31, distance: 10, covers: false, gap: 6 })
})
