#!/usr/bin/env node
// Run AE/AF: placement over ground items against the real engine.
//
// Run AE stalled because a burner drill, fuelled before its furnace existed,
// dropped ore on its output tile and the script build check refused every
// furnace footprint over it. Placement now picks those items up into the NPC
// inventory first, the way a player build does (Run AE fix). The Run AF
// preflight review found that a pickup followed by a failure still claimed
// "changed nothing" (failed_before_mutation), which admission and runtime
// reconciliation trust. This lane checks, in Factorio 2.0.77 with zero humans
// and the real standalone actor:
//
//   SPILL      a real burner drill drops copper ore on its output point, and
//              the native placement check refuses the furnace there
//   BUILT      the production place_candidate operation picks the ore up and
//              builds the furnace over the drop point; the drill feeds it
//   RECEIPT    ground_items_picked_up equals the NPC inventory change, and the
//              batch, admission and runtime reconciliation say completed
//   PARTIAL    a stack that only partly fits fails for real: the picked-up
//              and remaining counts match the engine, the batch carries no
//              no-mutation proof, admission stays uncertain, and runtime
//              reconciliation reports a partial unknown effect
//   ZERO       when nothing fits, the refusal keeps its legitimate proof and
//              reconciles as refused before mutation, with the world unchanged
//
// Fixture setup (terrain, ore patch, ground stack, inventory contents) is
// scripted between phases. Every operation goes through the production
// renderer and the protocol-2 authorized batch wrapper. No provider, no
// inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { provenRefusal, reconcilePendingOperation } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { parseOperation, renderOperation, toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the ground-item pickup lane') }

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}

const results = path.resolve(arg('results'))
const transcript = []
const evidence = {}
let connection
let ordinal = 0

const rcon = { command: async (command, options) => {
  const response = await connection.command(command, options)
  transcript.push({ command: command.slice(0, 800), response: String(response).slice(0, 2000) })
  return response
} }
// The standalone NPC by its deployment actor id, not the first character.
let actorId
const lua = async body => {
  const raw = await rcon.command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; local inv=a.get_main_inventory(); ${body}`)
  try { return JSON.parse(raw) }
  catch { throw new Error(`Lua command did not return JSON: ${String(raw).slice(0, 800)}\nCommand: ${body.slice(0, 400)}`) }
}
const tool = async (name, args) => {
  const raw = await rcon.command(toolCommand(name, args))
  try { return JSON.parse(raw) }
  catch { throw new Error(`${name} did not return JSON: ${String(raw).slice(0, 800)}`) }
}
// game.get_entity_by_unit_number does not index burner drills (see
// docs/validation/AUTORIO_GENERATED_LUA_ENGINE_DEFECTS_2026-09-25.md), so find
// the drill by name and match the unit number the placement receipt reported.
const drillByUnit = unit => `(function() for _,e in pairs(s.find_entities_filtered{name="burner-mining-drill"}) do if e.unit_number==${unit} then return e end end end)()`
const box = b => `{{${b.left_top.x},${b.left_top.y}},{${b.right_bottom.x},${b.right_bottom.y}}}`
// The furnace footprint at a centre (2x2, so the centre is a tile corner).
const furnaceBox = position => ({ left_top: { x: position.x - 1, y: position.y - 1 }, right_bottom: { x: position.x + 1, y: position.y + 1 } })
const world = (footprint, extra = '') => lua(`local ground=0; local stacks={}; for _,e in pairs(s.find_entities_filtered{area=${box(footprint)},type="item-entity"}) do `
  + 'if e.stack.valid_for_read and e.stack.name=="copper-ore" then ground=ground+e.stack.count; stacks[#stacks+1]={count=e.stack.count,x=e.position.x,y=e.position.y} end end; '
  + `rcon.print(helpers.table_to_json({ground=ground,stacks=stacks,held_ore=inv.get_item_count("copper-ore"),held_furnaces=inv.get_item_count("stone-furnace"),`
  + `furnaces=#s.find_entities_filtered{area=${box(footprint)},name="stone-furnace"},contents=inv.get_contents(),insertable=inv.get_insertable_count("copper-ore"),`
  + `humans=#game.connected_players,speed=game.speed${extra}}))`)

async function untilIdle(label, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) return status
    assert.ok(Date.now() < until, `${label}: native work did not finish`)
    await delay(200)
  }
}

// One production-rendered operation through the protocol-2 authorized batch
// wrapper, then the exact admission record, batch receipt and runtime verdict.
async function admitted(label, operation) {
  const deployment = await deploymentStatus(rcon, { requireAllowed: true })
  ordinal++
  const pending = {
    protocol_version: 2, operation_key: `ground-pickup/${label}`, attempt_id: `${label}-1`, signature: `ground-pickup-${label}`,
    actor: { actor_id: deployment.actor_id, epoch: deployment.epoch }, ordinal, operations: [operation],
  }
  const batch = await executeAuthorizedBatch(rcon, deployment.epoch, [renderOperation(parseOperation(operation))], undefined, pending)
  assert.equal(batch.results.length, 1)
  assert.notEqual(batch.results[0]?.[0], false, `${label} was refused at submission: ${JSON.stringify(batch.results[0])}`)
  const status = await untilIdle(label)
  const record = status.admission_journal.find(entry => entry.operation_key === pending.operation_key)
  assert.ok(record, `${label}: admission record missing`)
  const ref = record.slots[0].batch_refs[0]
  assert.ok(ref, `${label}: the admitted slot names no batch`)
  const receipt = status.receipt_journal.find(entry => entry.batch_ref === ref.batch_ref && entry.batch_id === ref.batch_id)
  assert.ok(receipt, `${label}: batch receipt missing`)
  const verdict = reconcilePendingOperation(pending, { status, actor: pending.actor })
  return { result: status.basic_operation?.last_result, record, receipt, verdict, proof: provenRefusal(record, status) }
}

async function main() {
  await fsp.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  await configureNpcSession(rcon, 'ground-item-pickup-engine-0001')
  actorId = (await deploymentStatus(rcon, { requireAllowed: true })).actor_id
  assert.ok(Number.isInteger(actorId), 'the deployment names its standalone actor')

  // ---- fixture: landfill pad, copper patch, drill/furnace/fuel stock ------
  const fixture = await lua('remote.call("autorio_operations","cancel_all_tasks"); game.speed=1; s.always_day=true; '
    + 'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); local area={{ox-12,oy-12},{ox+12,oy+12}}; '
    + 'for _,e in pairs(s.find_entities_filtered{area=area}) do if e~=a and e.type~="character" then e.destroy() end end; '
    + 'local tiles={}; for x=ox-12,ox+12 do for y=oy-12,oy+12 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); '
    + 'for x=ox+3,ox+6 do for y=oy-2,oy+1 do s.create_entity{name="copper-ore",position={x+0.5,y+0.5},amount=1000} end end; '
    + 'inv.clear(); inv.insert{name="burner-mining-drill",count=1}; inv.insert{name="stone-furnace",count=1}; inv.insert{name="coal",count=4}; '
    + 'rcon.print(helpers.table_to_json({ox=ox,oy=oy,humans=#game.connected_players,speed=game.speed,actor_unit=a.unit_number}))')
  assert.equal(fixture.humans, 0, 'zero humans')
  assert.equal(fixture.speed, 1)
  const { ox, oy } = fixture
  evidence.fixture = fixture

  // ---- SPILL: the drill drops ore before its furnace exists ---------------
  const drills = await tool('getPlacementCandidates', { entity_name: 'burner-mining-drill', center: { x: ox + 5, y: oy }, radius: 4, target_resource: 'copper-ore', limit: 3 })
  assert.equal(drills.ok, true, JSON.stringify(drills).slice(0, 600))
  const drillCandidate = drills.candidates[0]
  assert.ok(drillCandidate, 'a drill candidate covers the copper patch')
  const placedDrill = await admitted('drill', { name: 'place_candidate', args: { candidate_set_id: drills.candidate_set_id, candidate_id: drillCandidate.id } })
  assert.equal(placedDrill.result?.code, 'completed', JSON.stringify(placedDrill.result))
  const drillUnit = placedDrill.result.placed_unit_number
  const drill = await lua(`local d=${drillByUnit(drillUnit)}; local units={}; for _,e in pairs(s.find_entities_filtered{name="burner-mining-drill"}) do units[#units+1]=e.unit_number end; `
    + `rcon.print(helpers.table_to_json({found=d~=nil,drop=d and d.drop_position,unit=d and d.unit_number,drill_units=units,by_unit=game.get_entity_by_unit_number(${drillUnit})~=nil}))`)
  evidence.drill_lookup = drill
  assert.equal(drill.found, true, `placed_unit_number ${drillUnit} names no drill: ${JSON.stringify(drill)}`)
  const fuelled = await admitted('fuel', { name: 'supply_entity', args: { unit_number: drillUnit, items: [{ item_name: 'coal', count: 2 }] } })
  assert.equal(fuelled.result?.code, 'completed', JSON.stringify(fuelled.result))

  let spill
  for (const until = Date.now() + 30000; ;) {
    spill = await lua(`local found={}; for _,e in pairs(s.find_entities_filtered{position={${drill.drop.x},${drill.drop.y}},radius=0.75,type="item-entity"}) do `
      + 'found[#found+1]={name=e.stack.name,count=e.stack.count,x=e.position.x,y=e.position.y} end; rcon.print(helpers.table_to_json({items=found,tick=game.tick}))')
    if ((spill.items ?? []).length > 0) break
    assert.ok(Date.now() < until, 'the fuelled drill dropped no ore on its output point')
    await delay(250)
  }
  assert.equal(spill.items[0].name, 'copper-ore')
  evidence.spill = { drill, items: spill.items }

  const furnaces = await tool('getPlacementCandidates', { entity_name: 'stone-furnace', covers_position: drill.drop, limit: 4 })
  assert.equal(furnaces.ok, true, JSON.stringify(furnaces).slice(0, 600))
  assert.ok(furnaces.candidates.length > 0, 'ground ore no longer removes every furnace footprint over the drop point')
  for (const candidate of furnaces.candidates) assert.ok(candidate.ground_items?.some(item => item.name === 'copper-ore'), `candidate lists the ore: ${JSON.stringify(candidate)}`)
  const furnace = furnaces.candidates[0]
  const nativeCheck = await lua(`rcon.print(helpers.table_to_json({can_place=s.can_place_entity{name="stone-furnace",position={${furnace.position.x},${furnace.position.y}},force=a.force}}))`)
  assert.equal(nativeCheck.can_place, false, 'the spilled ore blocks the native placement check')
  const footprintA = furnaceBox(furnace.position)
  const beforeA = await world(footprintA)
  assert.ok(beforeA.ground > 0)
  evidence.spill.candidate = furnace
  evidence.spill.native_check_before = nativeCheck
  console.log(`PASS: SPILL - drill ${drillUnit} dropped ${beforeA.ground} copper ore at (${drill.drop.x}, ${drill.drop.y}); native check refuses the furnace there`)

  // ---- BUILT + RECEIPT -----------------------------------------------------
  const built = await admitted('furnace', { name: 'place_candidate', args: { candidate_set_id: furnaces.candidate_set_id, candidate_id: furnace.id } })
  const afterA = await world(footprintA)
  assert.equal(built.result?.code, 'completed', JSON.stringify(built.result))
  const pickedA = (built.result.ground_items_picked_up ?? []).reduce((sum, item) => sum + item.count, 0)
  assert.ok(pickedA > 0, 'the receipt names the picked-up ore')
  assert.equal(afterA.held_ore - beforeA.held_ore, pickedA, 'ground_items_picked_up equals the inventory change')
  assert.equal(afterA.furnaces, 1, 'the furnace stands over the drop point')
  assert.equal(afterA.held_furnaces, beforeA.held_furnaces - 1)
  // The drill's drop target is not refreshed in the build tick, so wait for
  // the native outcome instead: the drill targets the furnace and ore or
  // plates arrive in it.
  let feed
  for (const until = Date.now() + 30000; ;) {
    feed = await lua(`local d=${drillByUnit(drillUnit)}; local f=nil; for _,e in pairs(s.find_entities_filtered{area=${box(footprintA)},name="stone-furnace"}) do f=e end; `
      + 'rcon.print(helpers.table_to_json({tick=game.tick,drop_target=d.drop_target and d.drop_target.unit_number,furnace=f and f.unit_number,'
      + 'ore=f and f.get_item_count("copper-ore") or 0,plates=f and f.get_item_count("copper-plate") or 0}))')
    if (feed.drop_target === built.result.placed_unit_number && feed.ore + feed.plates > 0) break
    assert.ok(Date.now() < until, `the drill never fed the furnace: ${JSON.stringify(feed)}`)
    await delay(250)
  }
  assert.equal(feed.furnace, built.result.placed_unit_number)
  assert.equal(built.receipt.state, 'completed')
  assert.equal(built.record.state, 'completed')
  assert.equal(built.verdict.verdict, 'admitted_completed')
  assert.equal(built.verdict.effect, 'happened')
  evidence.built = { before: beforeA, after: afterA, feed, result: built.result, record: built.record, receipt: built.receipt, verdict: built.verdict }
  console.log(`PASS: BUILT - furnace ${built.result.placed_unit_number} over the drop point, picked up ${pickedA} ore; the drill feeds it`)
  console.log('PASS: RECEIPT - ground_items_picked_up matches the inventory; batch, admission and reconciliation completed')

  // ---- PARTIAL: room for one ore of a three-ore stack ----------------------
  const site = { x: ox - 4, y: oy + 4 }
  const footprintB = furnaceBox(site)
  const setupB = await lua(`s.create_entity{name="item-on-ground",position={${site.x + 0.3},${site.y + 0.3}},stack={name="copper-ore",count=3}}; `
    + 'inv.clear(); inv.insert{name="stone-furnace",count=1}; inv.insert{name="copper-ore",count=49}; inv.insert{name="iron-plate",count=100000}; '
    + 'rcon.print(helpers.table_to_json({insertable=inv.get_insertable_count("copper-ore")}))')
  assert.equal(setupB.insertable, 1, 'fixture leaves room for exactly one ore')
  const beforeB = await world(footprintB)
  assert.equal(beforeB.ground, 3)
  const partial = await admitted('partial', { name: 'place_entity', args: { entity_name: 'stone-furnace', x: site.x, y: site.y, direction: 0 } })
  const afterB = await world(footprintB)
  assert.equal(partial.result?.code, 'ground_items_inventory_full', JSON.stringify(partial.result))
  const pickedB = (partial.result.ground_items_picked_up ?? []).reduce((sum, item) => sum + item.count, 0)
  assert.equal(pickedB, 1)
  assert.equal(afterB.held_ore - beforeB.held_ore, pickedB, 'reported pickup equals the inventory change')
  assert.equal(partial.result.ground_item_left?.count, 2)
  assert.equal(afterB.ground, partial.result.ground_item_left.count, 'reported remainder equals the ground stack')
  assert.equal(afterB.ground + (afterB.held_ore - beforeB.held_ore), 3, 'no ore created or lost')
  assert.equal(afterB.furnaces, 0)
  assert.equal(afterB.held_furnaces, 1)
  assert.equal(partial.receipt.state, 'cancelled')
  assert.equal(partial.receipt.failed_before_mutation, undefined, 'no no-mutation proof after a pickup')
  assert.equal(partial.record.state, 'uncertain')
  assert.equal(partial.record.error, 'batch_reconciliation_required')
  assert.equal(partial.record.proven_refusal, undefined)
  assert.equal(partial.proof, null, 'runtime finds no refusal proof')
  assert.equal(partial.verdict.verdict, 'admitted_cancelled')
  assert.equal(partial.verdict.effect, 'partial_unknown')
  evidence.partial = { before: beforeB, after: afterB, result: partial.result, record: partial.record, receipt: partial.receipt, verdict: partial.verdict }
  console.log(`PASS: PARTIAL - picked ${pickedB}, left ${afterB.ground}; batch unproven, admission uncertain, reconciliation partial_unknown`)

  // ---- ZERO: nothing fits, so nothing changed ------------------------------
  const beforeC = await world(footprintB)
  assert.equal(beforeC.insertable, 0, 'the inventory has no room for ore')
  const zero = await admitted('zero', { name: 'place_entity', args: { entity_name: 'stone-furnace', x: site.x, y: site.y, direction: 0 } })
  const afterC = await world(footprintB)
  assert.equal(zero.result?.code, 'ground_items_inventory_full', JSON.stringify(zero.result))
  assert.equal(zero.result.ground_items_picked_up, undefined)
  assert.deepEqual(afterC, beforeC, 'a zero pickup leaves inventory and ground unchanged')
  assert.equal(zero.receipt.failed_before_mutation, true)
  assert.equal(zero.record.state, 'failed')
  assert.equal(zero.record.proven_refusal, true)
  assert.equal(zero.verdict.verdict, 'refused_before_mutation')
  assert.equal(zero.verdict.effect, 'not_happened')
  evidence.zero = { before: beforeC, after: afterC, result: zero.result, record: zero.record, receipt: zero.receipt, verdict: zero.verdict }
  console.log('PASS: ZERO - nothing picked up; proof kept and reconciled as refused before mutation')

  const closing = await lua('rcon.print(helpers.table_to_json({humans=#game.connected_players,speed=game.speed}))')
  assert.equal(closing.humans, 0)
  assert.equal(forbiddenFetchCalls, 0)
  evidence.closing = { ...closing, forbidden_fetch_calls: forbiddenFetchCalls }
}

try {
  await main()
  await fsp.writeFile(path.join(results, 'ground-item-pickup.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log('PASS: ground-item pickup lane')
}
catch (error) {
  await fsp.mkdir(results, { recursive: true }).catch(() => {})
  await fsp.writeFile(path.join(results, 'ground-item-pickup-error.txt'), `${error?.stack ?? error}\n`).catch(() => {})
  throw error
}
finally {
  await fsp.writeFile(path.join(results, 'ground-item-pickup-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`).catch(() => {})
  await connection?.close?.()
}
