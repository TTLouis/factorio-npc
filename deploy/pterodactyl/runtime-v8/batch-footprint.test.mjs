import assert from 'node:assert/strict'
import test from 'node:test'

import { BATCH_FOOTPRINT_OVERLAP_CODE, batchFootprintOverlap } from './batch-footprint.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

// Run Z batch 21 (docs/validation/RED_AUTOMATION_LIVE_RUN_Z_2026-10-18.md): boiler at (43.5, -49) facing north, then a
// steam engine at (42.5, -48.5) facing east, then a small pole at (44.5, -48.5). Each passed the held-item preflight
// alone; the boiler was built, the engine's footprint covered it (not_placeable) and the pole was cancelled. The boxes
// below are the ones the game reported: the engine's from that receipt, the boiler's from the save afterwards.
const LAYERS = ['item', 'meltable', 'object', 'player', 'water_tile']
const planned = (entity_name, position, direction, [ltx, lty, rbx, rby], extra = {}) => ({
  entity_name, position, direction,
  tile_box: { left_top: { x: Math.floor(ltx), y: Math.floor(lty) }, right_bottom: { x: Math.ceil(rbx), y: Math.ceil(rby) } },
  world_box: { left_top: { x: ltx, y: lty }, right_bottom: { x: rbx, y: rby } },
  collision_layers: LAYERS,
  ...extra,
})
const BOILER = planned('boiler', { x: 43.5, y: -49 }, 0, [42.2109375, -49.7890625, 44.7890625, -48.2109375])
const ENGINE = planned('steam-engine', { x: 42.5, y: -48.5 }, 4, [40.15234375, -49.75, 44.84765625, -47.25])
const POLE = planned('small-electric-pole', { x: 44.5, y: -48.5 }, 0, [44.35, -48.65, 44.65, -48.35])
const place = (entity_name, x, y, direction) => ({ name: 'place_entity', args: { entity_name, x, y, direction } })
const BATCH_21 = [place('boiler', 43.5, -49, 0), place('steam-engine', 42.5, -48.5, 4), place('small-electric-pole', 44.5, -48.5, 0)]
const ok = planned_footprint => ({ ok: true, operation: 'place_entity', placement_item: { count: 1, held_count: 1 }, planned_footprint })

test('Run Z batch 21: the engine overlapping the boiler placed earlier in the same batch is refused as an argument error', () => {
  const refusal = batchFootprintOverlap(BATCH_21, [ok(BOILER), ok(ENGINE), ok(POLE)])
  assert.equal(refusal.code, BATCH_FOOTPRINT_OVERLAP_CODE)
  assert.equal(refusal.refusal_class, 'argument')
  assert.equal(refusal.operation_index, 1, 'the first conflict in batch order: the engine, not the pole')
  assert.equal(refusal.batch_footprint.entity_name, 'steam-engine')
  assert.equal(refusal.batch_footprint.overlaps.operation_index, 0)
  assert.equal(refusal.batch_footprint.overlaps.entity_name, 'boiler')
  assert.deepEqual(refusal.batch_footprint.world_box, { left_top: { x: 40.152, y: -49.75 }, right_bottom: { x: 44.848, y: -47.25 } })
  assert.ok(refusal.batch_footprint.overlap_area > 3)
  assert.match(refusal.correction_message, /^\[HARNESS\] Refused before admission: no operation from this batch ran\./)
  assert.match(refusal.correction_message, /Operation 2 would place steam-engine on tiles that operation 1 of the same batch places boiler on/)
  assert.doesNotMatch(refusal.correction_message, /\b(should|must|try|instead)\b/i, 'facts, not advice')

  // The pole alone after the boiler overlaps it too; without the engine it is the one refused.
  const pole = batchFootprintOverlap([BATCH_21[0], BATCH_21[2]], [ok(BOILER), ok(POLE)])
  assert.equal(pole.operation_index, 1)
  assert.equal(pole.batch_footprint.entity_name, 'small-electric-pole')
})

test('footprints that only touch, or never share a collision layer, are not an overlap', () => {
  // A 3x2 boiler and a 3x5 engine on adjacent tiles: collision boxes are inset from the tile edges.
  const besideBoiler = planned('steam-engine', { x: 43.5, y: -45.5 }, 0, [42.15234375, -47.84765625, 44.84765625, -43.15234375])
  assert.equal(batchFootprintOverlap([BATCH_21[0], place('steam-engine', 43.5, -45.5, 0)], [ok(BOILER), ok(besideBoiler)]), null)
  const ghostly = { ...ENGINE, collision_layers: ['train'] }
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok(ghostly)]), null)
  const tilesOnly = { ...ENGINE, colliding_with_tiles_only: true }
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok(tilesOnly)]), null)
  const self = { ...BOILER, not_colliding_with_itself: true }
  assert.equal(batchFootprintOverlap([BATCH_21[0], BATCH_21[0]], [ok(self), ok(self)]), null)
  assert.ok(batchFootprintOverlap([BATCH_21[0], BATCH_21[0]], [ok(BOILER), ok(BOILER)]), 'the same entity twice on one spot collides with itself')
})

test('no footprint means no claim: placements without coordinates are left to execution; unknown collision layers collide', () => {
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), { ok: true, operation: 'place_entity' }]), null)
  // Milestone 4 L1: a joint proof never rests on what could not be read.
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok({ ...ENGINE, collision_unknown: true })]).operation_index, 1)
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok({ ...ENGINE, collision_layers: undefined })]).operation_index, 1)
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok({ ...ENGINE, collision_layers: undefined, colliding_with_tiles_only: true })]), null)
  assert.equal(batchFootprintOverlap(BATCH_21.slice(0, 2), [ok(BOILER), ok({ ...ENGINE, world_box: { left_top: { x: 1, y: 1 }, right_bottom: { x: 1, y: 2 } } })]), null)
  assert.equal(batchFootprintOverlap(undefined, undefined), null)
})

test('an operation between two placements that can remove or turn an entity ends the comparison with what came before', () => {
  const mine = { name: 'mine_entity', args: { entity_name: 'boiler', count: 1 } }
  assert.equal(batchFootprintOverlap([BATCH_21[0], mine, BATCH_21[1]], [ok(BOILER), { ok: true, operation: 'mine_entity' }, ok(ENGINE)]), null)
  const walk = { name: 'walk_to_position', args: { x: 40, y: -40, reach_distance: 2 } }
  assert.equal(batchFootprintOverlap([BATCH_21[0], walk, BATCH_21[1]], [ok(BOILER), { ok: true, operation: 'walk_to_position' }, ok(ENGINE)]).operation_index, 2,
    'a walk changes nothing in the world, so the pair is still compared')
  const candidate = { name: 'place_candidate', args: { candidate_set_id: 'set_1', candidate_id: 'c1' } }
  assert.equal(batchFootprintOverlap([candidate, BATCH_21[1]], [{ ok: true, operation: 'place_candidate', planned_footprint: BOILER }, ok(ENGINE)]).batch_footprint.overlaps.operation, 'place_candidate',
    'a candidate placement carries its registry footprint and is compared like any other')
})

test('milestone 4 L1: a validated construction plan in a batch is compared placement by placement with the batch\'s other placements', () => {
  const plan = { name: 'execute_construction_plan', args: { validation_id: 5, placement_count: 2 } }
  const row = footprint => ({ entity_name: footprint.entity_name, position: footprint.position, planned_footprint: footprint })
  const farPole = planned('small-electric-pole', { x: 30.5, y: -40.5 }, 0, [30.35, -40.65, 30.65, -40.35])
  const witness = { ok: true, operation: 'execute_construction_plan', construction_placements: [row(farPole), row(BOILER)] }
  assert.equal(batchFootprintOverlap([plan], [witness]), null)
  // The mod compared a plan's own rows when it validated the plan; they are not compared with each other again.
  assert.equal(batchFootprintOverlap([plan], [{ ...witness, construction_placements: [row(BOILER), row(POLE)] }]), null)

  const after = batchFootprintOverlap([plan, BATCH_21[1]], [witness, ok(ENGINE)])
  assert.equal(after.code, BATCH_FOOTPRINT_OVERLAP_CODE)
  assert.equal(after.operation_index, 1)
  assert.equal(after.batch_footprint.entity_name, 'steam-engine')
  assert.equal(after.batch_footprint.overlaps.operation, 'execute_construction_plan')
  assert.equal(after.batch_footprint.overlaps.construction_placement_index, 1, 'the plan\'s boiler, the first of its rows the engine overlaps')
  assert.equal(after.batch_footprint.overlaps.entity_name, 'boiler')

  const before = batchFootprintOverlap([BATCH_21[1], plan], [ok(ENGINE), witness])
  assert.equal(before.operation_index, 1)
  assert.equal(before.operation, 'execute_construction_plan')
  assert.equal(before.batch_footprint.construction_placement_index, 1)
  assert.equal(before.batch_footprint.overlaps.entity_name, 'steam-engine')

  // A plan witness without footprints (an older mod) makes no claim, as a placement without coordinates does.
  assert.equal(batchFootprintOverlap([plan, BATCH_21[1]], [{ ok: true, construction_placements: [{ entity_name: 'boiler' }] }, ok(ENGINE)]), null)
})

// --- the real agent loop ------------------------------------------------------------------------------------------------------

const KEY = 'npc:sgluna'
const deployment = () => ({
  revision: 'sgluna-deploy-v8-npc-staging', session: '0123456789abcdef0123456789abcdef', mode: 'npc', actor_id: 15,
  actor_kind: 'standalone_character', connected_players: 0, allowed: true, idle: true, epoch: 1, actor_interface: true, operations: true, tools: true,
})
const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const planMessage = (operations, plan) => ({ content: JSON.stringify({ chatMessage: '', plan, currentStep: 0, operations }) })
const observe = () => ({ content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 32, name: 'offshore-pump', limit: 4 })] })
const data = row => row.data ?? row
const FOOTPRINTS = { 'boiler@43.5,-49': BOILER, 'steam-engine@42.5,-48.5': ENGINE, 'steam-engine@39.5,-48.5': planned('steam-engine', { x: 39.5, y: -48.5 }, 4, [37.15234375, -49.75, 41.84765625, -47.25]), 'small-electric-pole@44.5,-48.5': POLE }

class PowerRcon {
  constructor() {
    this.inventory = { boiler: 1, 'steam-engine': 1, 'small-electric-pole': 2 }
    this.mutations = []
    this.batchSequence = 0
    this.admissions = []
  }

  preflight(text) {
    const str = key => new RegExp(String.raw`\['${key}'\]='([^']*)'`).exec(text)?.[1]
    const num = key => {
      const match = new RegExp(String.raw`\['${key}'\]=(-?\d+(?:\.\d+)?)`).exec(text)
      return match ? Number(match[1]) : undefined
    }
    const entity = str('entity_name')
    const footprint = FOOTPRINTS[`${entity}@${num('x')},${num('y')}`]
    return { ok: true, operation: 'place_entity', placement_item: { entity_name: entity, item_name: entity, count: 1, held_count: this.inventory[entity] ?? 0 },
      ...(footprint ? { planned_footprint: footprint } : {}) }
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      return JSON.stringify({ actor_position: { x: 44, y: -39 }, entities: [{ name: 'offshore-pump', type: 'offshore-pump', unit_number: 35, position: { x: 45.5, y: -48.5 }, distance: 9.6 }] })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1,
        admission_journal: this.admissions.map(record => ({ ...record, state: 'completed' })), receipt_journal: [] })
    }
    if (text.includes('"get_inventory_items"')) return `{\n${Object.entries(this.inventory).map(([name, count]) => `  {\n    count = ${count},\n    name = "${name}"\n  }`).join(',\n')}\n}`
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify(this.preflight(text))
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      const batchId = ++this.batchSequence
      const encoded = /"begin",helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(text)?.[1]
      if (encoded) {
        const identity = JSON.parse(JSON.parse(encoded))
        this.admissions.push({ ...identity, generation: 1, state: 'admitted', slots: Array.from({ length: count }, (_, index) => ({
          index: index + 1, ok: true, batch_refs: [{ batch_id: batchId, batch_generation: 1, batch_ref: `batch-g1-${batchId}` }] })) })
      }
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

test('in the loop, the Run Z batch is refused before admission with the overlap as a harness fact, and the corrected batch runs', async () => {
  const rcon = new PowerRcon()
  const calls = []
  const rows = []
  const memory = new CanonicalTaskBoardMemory()
  const plan = ['Install the steam power system']
  const script = [observe(), planMessage(BATCH_21, plan), planMessage([BATCH_21[0], place('steam-engine', 39.5, -48.5, 4)], plan)]
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const next = script.shift()
      assert.ok(next, `unscripted provider call ${calls.length}`)
      return next
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'batch footprint test',
    npcId: 'sgluna',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }

  const result = await agent.request('build steam power', { sender: 'tester' })

  const named = name => rows.filter(row => row.event === name)
  const [recoverable, ...more] = named('operations.preflight_recoverable')
  assert.equal(more.length, 0)
  assert.equal(data(recoverable).failure_class, 'model_correctable_batch_footprint_overlap')
  assert.equal(data(recoverable).refusal_class, 'argument')
  assert.equal(data(recoverable).preflight.operation_index, 1)
  assert.equal(data(recoverable).preflight.batch_footprint.overlaps.entity_name, 'boiler')
  const harness = calls[2].map(message => String(message.content ?? '')).filter(content => content.startsWith('[HARNESS] Refused before admission'))
  assert.equal(harness.length, 1)
  assert.match(harness[0], /"overlaps":\{"operation_index":0,"operation":"place_entity","entity_name":"boiler"/)
  assert.equal(rcon.mutations.length, 1, 'nothing from the overlapping batch was sent; only the corrected batch was admitted')
  assert.equal((rcon.mutations[0].match(/'place_entity'/g) ?? []).length, 2)
  assert.deepEqual(result.operations.map(operation => operation.args.entity_name), ['boiler', 'steam-engine'])
  assert.equal(named('operations.batch_stock_checked').length, 1, 'the overlap is refused before the batch stock read')
  assert.equal(memory.currentPlan(KEY).status, 'active', 'the plan is untouched by the correction')
})
