import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { NpcAgentLoop as BaseNpcAgentLoop } from '../staging/npc-agent-loop.mjs'
import { REJECTED_FOOTPRINTS_LABEL, renderPlacementCandidatesResult } from './placement-candidates-render.mjs'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'
import { topologyObstruction } from './topology-context.mjs'

// Run 19af: getPlacementCandidates returned 8 legal drill candidates, but the rejected-footprint samples (footprints
// overlapping furnace 31) were listed first and both roles read the answer as blocked. The mod serialises with
// helpers.table_to_json, whose key order is the Lua hash order, so the runtime fixes what the model reads: candidates
// first, the rejected footprints last and labelled. The request can name an anchor entity to rank candidates by.

const LIMIT = 12000 // the staging loop's message limit
const SAMPLE = (x, y) => ({ position: { x, y }, direction: 0, unknown: false, truncated: false,
  footprint: { tile_width: 2, tile_height: 2, tile_box: { left_top: { x: x - 1, y: y - 1 }, right_bottom: { x: x + 1, y: y + 1 } } },
  terrain_tiles: [], entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 31, position: { x: 3.5, y: 4.5 }, reason: 'entity_collision_mask_overlap' }] })
const CANDIDATES = [1, 2, 3, 4, 5, 6, 7, 8].map(index => ({ id: `candidate-${index}`, position: { x: index + 0.5, y: 10.5 }, direction: 0, distance_from_center: index,
  distance_from_anchor: index, item_output_position: { x: index + 0.5, y: 8.5 }, footprint: { tile_width: 2, tile_height: 2 },
  ...(index === 2 ? { clears: [{ name: 'tree-01', type: 'tree', unit_number: 900, position: { x: 2.5, y: 10.5 }, reason: 'natural_obstruction' }] } : {}) }))

// The order a Lua hash table can give: the sample block first, the candidates last.
function hashOrdered(extra = {}) {
  return {
    obstructions: { source: 'native_placement_checks', observed_tick: 500, actor_id: 7, surface_index: 1, force_index: 1, scope: 'sampled_footprints',
      examined_count: 3, rejected_count: 40, unknown_count: 0, samples: [SAMPLE(3, 4), SAMPLE(4, 4), SAMPLE(5, 4)], truncated: true },
    scanned: 961,
    candidate_set_id: 'placement-9',
    candidates: CANDIDATES,
    returned_candidate_count: 8,
    legal_candidate_count: 30,
    ordering: 'nearest_to_anchor_first',
    anchor: { unit_number: 31, entity_name: 'stone-furnace', position: { x: 3.5, y: 4.5 } },
    entity_name: 'burner-mining-drill',
    ok: true,
    ...extra,
  }
}

test('legal candidates come first and the rejected-footprint samples last, under a label that says they are not candidates', () => {
  const rendered = JSON.parse(renderPlacementCandidatesResult(JSON.stringify(hashOrdered()), LIMIT))
  const keys = Object.keys(rendered)
  assert.deepEqual(keys.slice(0, 6), ['ok', 'entity_name', 'ordering', 'legal_candidate_count', 'returned_candidate_count', 'candidates'])
  assert.equal(keys.at(-1), 'obstructions')
  assert.equal(rendered.obstructions.label, REJECTED_FOOTPRINTS_LABEL)
  assert.equal(REJECTED_FOOTPRINTS_LABEL, 'rejected_footprint_samples_not_candidates')
  // Every fact is carried through untouched.
  assert.deepEqual(rendered.candidates, CANDIDATES)
  assert.deepEqual(rendered.obstructions.samples, hashOrdered().obstructions.samples)
  assert.equal(rendered.candidate_set_id, 'placement-9')
  assert.deepEqual(rendered.anchor, hashOrdered().anchor)
})

test('a refusal keeps its code and error ahead of the rest and an answer with no sample block gains none', () => {
  const refusal = JSON.parse(renderPlacementCandidatesResult(JSON.stringify({ unit_number: 5, entity_name: 'boiler', error: 'anchor entity is not on this surface and force', code: 'anchor_entity_not_found', ok: false }), LIMIT))
  assert.deepEqual(Object.keys(refusal), ['ok', 'code', 'error', 'entity_name', 'unit_number'])
  const plain = { ok: true, entity_name: 'steam-engine', candidates: [], scanned: 4 }
  assert.deepEqual(JSON.parse(renderPlacementCandidatesResult(JSON.stringify(plain), LIMIT)), plain)
  assert.equal(Object.hasOwn(JSON.parse(renderPlacementCandidatesResult(JSON.stringify(plain), LIMIT)), 'obstructions'), false)
})

test('an answer too large for the message keeps its candidates whole and trims the samples, still valid JSON', () => {
  const many = hashOrdered()
  many.obstructions.samples = Array.from({ length: 3 }, (_, index) => ({ ...SAMPLE(index, 0), note: 'x'.repeat(4000) }))
  const raw = JSON.stringify(many)
  assert.ok(raw.length > 12000)
  const text = renderPlacementCandidatesResult(raw, LIMIT)
  assert.ok(text.length <= 12000)
  const rendered = JSON.parse(text)
  assert.deepEqual(rendered.candidates, CANDIDATES)
  assert.ok(rendered.obstructions.samples.length < 3)
  assert.equal(rendered.obstructions.samples_omitted_for_size, 3 - rendered.obstructions.samples.length)
  assert.equal(rendered.obstructions.label, REJECTED_FOOTPRINTS_LABEL)
})

test('candidates that alone exceed the message limit are trimmed from the tail, counted, and the text stays valid JSON', () => {
  const heavy = hashOrdered()
  heavy.candidates = CANDIDATES.map(candidate => ({ ...candidate, resource_coverage: [{ name: 'copper-ore', entities: 9, amount: 1000, note: 'x'.repeat(1800) }] }))
  const raw = JSON.stringify(heavy)
  assert.ok(raw.length > LIMIT * 1.5)
  const text = renderPlacementCandidatesResult(raw, LIMIT)
  assert.ok(text.length <= LIMIT)
  const rendered = JSON.parse(text)
  assert.ok(rendered.candidates.length > 0 && rendered.candidates.length < 8)
  assert.deepEqual(rendered.candidates, heavy.candidates.slice(0, rendered.candidates.length), 'the highest-ranked candidates are the ones kept')
  assert.equal(rendered.candidates_omitted_for_size, 8 - rendered.candidates.length)
  assert.equal(rendered.returned_candidate_count, rendered.candidates.length, 'the count tracks what is listed')
  assert.equal(rendered.legal_candidate_count, 30)
})

test('the incompleteness flag stays beside the candidates, ahead of the rejected samples', () => {
  const flagged = hashOrdered({ candidates_may_be_incomplete: true, candidates_incomplete_reason: 'clearance_check_limit' })
  const keys = Object.keys(JSON.parse(renderPlacementCandidatesResult(JSON.stringify(flagged), LIMIT)))
  assert.deepEqual(keys.slice(5, 8), ['candidates', 'candidates_may_be_incomplete', 'candidates_incomplete_reason'])
})

test('an answer whose headline alone cannot fit still degrades to valid JSON', () => {
  const text = renderPlacementCandidatesResult(JSON.stringify({ ok: true, entity_name: 'steam-engine', candidates: [], connects_to: { note: 'y'.repeat(20000) } }), 4000)
  assert.ok(text.length <= 4000)
  assert.deepEqual(JSON.parse(text), { ok: true, entity_name: 'steam-engine', truncated_for_size: true })
})

test('anything that is not a JSON object answer is delivered as read', () => {
  for (const raw of ['', 'RCON error: boom', '[1,2]', '"text"', '{"ok":true,', undefined, 42]) assert.equal(renderPlacementCandidatesResult(raw, LIMIT), raw)
})

test('the base loop delivers every answer as read and only a placement-candidate read is reshaped', async () => {
  const agent = new NpcAgentLoop({ rcon: new FakeRcon(hashOrdered()), systemPrompt: 'render hook test', memory: new CanonicalTaskBoardMemory(), stateFile: null,
    traceFile: path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-render-hook-')), 'behavior.jsonl'), provider: async () => ({ content: '{}' }) })
  const raw = JSON.stringify(hashOrdered())
  for (const name of ['getInventoryItems', 'getNearbyEntities', 'getEntityStatus', 'getPlacementCandidatesX']) assert.equal(agent.renderToolOutput(name, raw, LIMIT), raw)
  assert.equal(Object.keys(JSON.parse(agent.renderToolOutput('getPlacementCandidates', raw, LIMIT))).at(-1), 'obstructions')
  assert.equal(BaseNpcAgentLoop.prototype.renderToolOutput.call(agent, 'getPlacementCandidates', raw, LIMIT), raw, 'the base default is the identity')
})

test('getPlacementCandidates takes an anchor entity, renders it into the remote request, and rejects a malformed one', () => {
  const tool = toolDefinitions.find(row => row.function?.name === 'getPlacementCandidates')
  assert.deepEqual(tool.function.parameters.properties.anchor.required, ['unit_number'])
  assert.equal(tool.function.parameters.properties.anchor.additionalProperties, false)
  assert.match(tool.function.description, /anchor/)
  assert.match(tool.function.description, /clears/)
  assert.match(tool.function.description, /ordered by distance to it and, at equal distance, the one that clears less comes first/)
  assert.match(tool.function.description, /rejected_footprint_samples_not_candidates/)
  assert.equal(toolCommand('getPlacementCandidates', { entity_name: 'burner-mining-drill', target_resource: 'copper-ore', anchor: { unit_number: 31 }, limit: 4 }),
    `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_placement_candidates",{entity_name='burner-mining-drill',target_resource='copper-ore',anchor={unit_number=31},limit=4})))`)
  assert.doesNotMatch(toolCommand('getPlacementCandidates', { entity_name: 'stone-furnace' }), /anchor/)
  for (const anchor of [{}, { unit_number: 0 }, { unit_number: 1.5 }, { unit_number: 1, extra: 1 }, 'x', 31]) {
    assert.throws(() => toolCommand('getPlacementCandidates', { entity_name: 'stone-furnace', anchor }), undefined, JSON.stringify(anchor))
  }
})

test('the topology block labels its obstruction samples as rejected footprints', () => {
  const answer = { ...hashOrdered(), obstructions: { ...hashOrdered().obstructions } }
  assert.equal(topologyObstruction(answer).label, REJECTED_FOOTPRINTS_LABEL)
})

class FakeRcon {
  constructor(answer) { this.answer = answer; this.commands = [] }
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) {
      return JSON.stringify({ revision: 'sgluna-deploy-v8-npc-staging', session: '0123456789abcdef0123456789abcdef', mode: 'npc', actor_id: 18,
        actor_kind: 'standalone_character', connected_players: 0, allowed: true, idle: true, epoch: 3, actor_interface: true, operations: true, tools: true })
    }
    if (text.includes('"autorio_tools","get_placement_candidates"')) {
      this.commands.push(text)
      return JSON.stringify(this.answer)
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'IDLE', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 9, task_count: 1, task_types: ['waiting'], tick: 120 } })
    }
    return '{}'
  }
}

test('the model reads the answer candidates first, with the anchor in the request', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-placement-render-'))
  const rcon = new FakeRcon(hashOrdered())
  const inputs = []
  const read = id => ({ id, type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name: 'burner-mining-drill', target_resource: 'copper-ore', anchor: { unit_number: 31 } }) } })
  const replies = [
    { content: null, tool_calls: [read('first')] },
    { content: JSON.stringify({ chatMessage: 'Done.', plan: [], currentStep: 0, operations: [] }) },
  ]
  const agent = new NpcAgentLoop({ rcon, systemPrompt: 'placement render test prompt', memory: new CanonicalTaskBoardMemory(), stateFile: null,
    traceFile: path.join(dir, 'behavior.jsonl'), provider: async messages => { inputs.push(messages.map(message => ({ ...message }))); return replies.shift() } })
  await agent.request('Put a drill beside the furnace.', { sender: 'TTLouis' })
  await agent.completed()
  const rows = (await fsp.readFile(path.join(dir, 'behavior.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

  assert.match(rcon.commands[0], /anchor=\{unit_number=31\}/)
  const tools = inputs.at(-1).filter(message => message.role === 'tool')
  const first = JSON.parse(tools.find(message => message.tool_call_id === 'first').content)
  assert.deepEqual(Object.keys(first).slice(0, 6), ['ok', 'entity_name', 'ordering', 'legal_candidate_count', 'returned_candidate_count', 'candidates'])
  assert.equal(Object.keys(first).at(-1), 'obstructions')
  assert.equal(first.obstructions.label, REJECTED_FOOTPRINTS_LABEL)
  assert.equal(first.candidates.length, 8)
  const text = tools.find(message => message.tool_call_id === 'first').content
  assert.ok(text.indexOf('"candidates"') < text.indexOf('"obstructions"'))

  // The read leaves a named, request-correlated trace row saying what it ordered by and what a build would clear.
  const requestId = rows.find(row => row.event === 'tool.call')?.request_id
  const observed = rows.filter(row => row.event === 'observation.placement_candidates_observed')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].request_id, requestId)
  assert.deepEqual({ ordering: observed[0].data.ordering, anchor: observed[0].data.anchor_unit_number, clearing: observed[0].data.clearing_candidate_count, ground: observed[0].data.ground_item_candidate_count, returned: observed[0].data.returned_candidate_count },
    { ordering: 'nearest_to_anchor_first', anchor: 31, clearing: 1, ground: 0, returned: 8 })
})
