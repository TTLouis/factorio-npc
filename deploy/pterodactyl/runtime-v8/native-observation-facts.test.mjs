import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { OBSERVATION_TOOL_TIER, isObservationToolName, observationToolFamily, toolCommand, toolDefinitions, providerToolDefinitions, executorProviderToolDefinitions } from './structured-policy.mjs'

// Native fluid-terrain reads and the unknown-entity-prototype refusal reach the model as ordinary observations; the
// loop adds named, request-correlated trace rows so a later run can be diagnosed from the logs.

const FLUID = { ok: true, fluid_name: 'water', actor_position: { x: 0, y: 0 }, surface_index: 1, observed_tick: 77,
  search_radius: 128, coverage: 'generated_bounding_square', checked_chunks: 81, matching_tile_prototypes: 2,
  samples: [{ name: 'water', fluid_name: 'water', position: { x: 22, y: 8 }, surface_index: 1 }],
  returned_count: 1, truncated: false, ordering: 'native_samples_not_nearest' }
const REFUSED = { ok: false, code: 'unknown_entity_prototype', field: 'name', identity: 'water', fluid_name: 'water', observation_tool: 'getFluidSourceTiles' }

function deployment() {
  return { revision: 'sgluna-deploy-v8-npc-staging', session: '0123456789abcdef0123456789abcdef', mode: 'npc', actor_id: 18,
    actor_kind: 'standalone_character', connected_players: 0, allowed: true, idle: true, epoch: 3, actor_interface: true,
    operations: true, tools: true }
}

class FakeRcon {
  constructor() { this.reads = [] }
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('"autorio_tools","get_fluid_source_tiles"')) { this.reads.push('fluid'); return JSON.stringify(FLUID) }
    if (text.includes('"autorio_tools","get_nearby_entities"')) { this.reads.push('nearby'); return JSON.stringify(REFUSED) }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'IDLE', queue_empty: true, queue_length: 0,
        last_completed_batch: { batch_id: 9, task_count: 1, task_types: ['waiting'], tick: 120 } })
    }
    return '{}'
  }
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

async function run() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-native-observation-'))
  const traceFile = path.join(dir, 'behavior.jsonl')
  const rcon = new FakeRcon()
  const inputs = []
  const replies = [
    { content: null, tool_calls: [call('fluid-1', 'getFluidSourceTiles', { fluid_name: 'water' }),
      call('nearby-1', 'getNearbyEntities', { name: 'water', radius: 64, limit: 5 })] },
    { content: JSON.stringify({ chatMessage: 'Done.', plan: [], currentStep: 0, operations: [] }) },
  ]
  const agent = new NpcAgentLoop({ rcon, systemPrompt: 'native observation test prompt', memory: new CanonicalTaskBoardMemory(),
    stateFile: null, traceFile, provider: async messages => { inputs.push(messages.map(message => ({ ...message }))); return replies.shift() } })
  await agent.request('Find water.', { sender: 'TTLouis' })
  await agent.completed()
  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { rcon, rows, inputs }
}

test('getFluidSourceTiles is a defined, admitted observation for planner and executor rounds', () => {
  for (const definitions of [toolDefinitions, providerToolDefinitions, executorProviderToolDefinitions]) {
    assert(definitions.some(row => row.function.name === 'getFluidSourceTiles'))
  }
  assert.equal(isObservationToolName('getFluidSourceTiles'), true)
  assert.equal(observationToolFamily('getFluidSourceTiles'), 'nearby_world')
  assert.equal(OBSERVATION_TOOL_TIER.getFluidSourceTiles, 'discovery')
  assert.equal(toolCommand('getFluidSourceTiles', { fluid_name: 'water' }),
    `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_fluid_source_tiles",{fluid_name='water'})))`)
  assert.match(toolCommand('getFluidSourceTiles', { fluid_name: 'modded-fluid', search_radius: 256, limit: 8 }), /search_radius=256,limit=8/)
  for (const args of [{}, { fluid_name: 'water', extra: 1 }, { fluid_name: 'water', search_radius: 257 },
    { fluid_name: 'water', search_radius: 1.5 }, { fluid_name: 'water', limit: 9 }, { fluid_name: 'water', limit: 0 }]) {
    assert.throws(() => toolCommand('getFluidSourceTiles', args))
  }
})

test('a fluid read and an unknown-entity refusal reach the model unchanged and write correlated observation trace rows', async () => {
  const { rcon, rows, inputs } = await run()
  assert.deepEqual(rcon.reads.sort(), ['fluid', 'nearby'])
  const toolMessages = inputs[1].filter(message => message.role === 'tool')
  assert.deepEqual(JSON.parse(toolMessages.find(message => message.tool_call_id === 'fluid-1').content), FLUID)
  assert.deepEqual(JSON.parse(toolMessages.find(message => message.tool_call_id === 'nearby-1').content), REFUSED)
  const requestId = rows.find(row => row.event === 'tool.call')?.request_id
  assert.ok(requestId)
  const fluid = rows.find(row => row.event === 'observation.fluid_sources_observed')
  assert.ok(fluid)
  assert.equal(fluid.request_id, requestId)
  assert.equal(fluid.data.reason, 'bounded_native_fluid_tile_read')
  assert.deepEqual({ fluid_name: fluid.data.fluid_name, readable: fluid.data.readable, ok: fluid.data.ok, returned_count: fluid.data.returned_count,
    truncated: fluid.data.truncated, surface_index: fluid.data.surface_index, coverage: fluid.data.coverage },
  { fluid_name: 'water', readable: true, ok: true, returned_count: 1, truncated: false, surface_index: 1, coverage: 'generated_bounding_square' })
  const refused = rows.find(row => row.event === 'observation.entity_read_refused')
  assert.ok(refused)
  assert.equal(refused.request_id, requestId)
  assert.equal(refused.data.reason, 'native_unknown_entity_prototype')
  assert.equal(refused.data.identity, 'water')
  assert.equal(refused.data.observation_tool, 'getFluidSourceTiles')
  assert.equal(rows.filter(row => row.event === 'observation.entity_read_refused').length, 1)
})


test('pump water prerequisites write a request-correlated no-scan event and tool guidance requires water first', async () => {
  const rows = []
  const agent = { traceRequest: { id: 'request-pump-water' }, traceEvent: async (event, data) => rows.push({ event, data }) }
  for (const code of ['water_search_required', 'water_source_not_exposed']) {
    await NpcAgentLoop.prototype.traceNativeObservationFact.call(agent, 'getPlacementCandidates', { entity_name: 'offshore-pump' }, JSON.stringify({ ok: false, code }))
  }
  const events = rows.filter(row => row.event === 'observation.pump_water_prerequisite')
  assert.equal(events.length, 2)
  assert.ok(events.every(row => row.data.request_id === 'request-pump-water' && row.data.placement_scan_performed === false))
  const guidance = toolDefinitions.find(row => row.function.name === 'getPlacementCandidates').function.description
  assert.match(guidance, /FIRST call getFluidSourceTiles/)
  assert.match(guidance, /covered_fluid_hints/)
  assert.match(guidance, /MUST use place_candidate/)
})
