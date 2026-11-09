#!/usr/bin/env node
// External-harness pick_up_ground_items against the real engine with zero humans, driven through the shipped NativeBridge
// (prepare -> submit -> receipt), never through a model. Trial 4r: ore a drill dropped on the ground blocked belt tiles and
// nothing could pick it up. Placement still never clears; the pickup is the separate, bounded operation.
//
//   PICKUP    three ground stacks in a 3x3 box are picked up by native mining: the receipt is completed, observed_effect
//             names the inventory delta of each item, the engine holds no item on the ground in the box, and the tree and
//             chest in the same box are untouched
//   UNBLOCK   an item on a belt tile refuses place_entity (pointing at pick_up_ground_items); after the pickup the same
//             place_entity is admitted and builds the belt
//   EMPTY     a box with no ground items is refused before sending and uses no journal ordinal
//   FULL      a stack the full inventory cannot take is refused before sending; the item stays on the ground
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { NativeBridge } from '../external-harness/tools/external-harness/native-bridge.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the external pickup lane') }

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0 && process.argv[at + 1], `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const transcript = []
const evidence = {}
let connection
let actorId
let origin

const command = async text => {
  const response = await connection.command(text)
  transcript.push({ command: text.slice(0, 800), response: String(response).slice(0, 4000) })
  return response
}
const parse = (raw, label) => {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} did not return JSON: ${String(raw).slice(0, 800)}`) }
}
// Test fixture Lua only (world setup and engine reads); the NPC acts solely through the bridge.
const lua = async body => parse(await command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; ${body}`), body.slice(0, 200))
const list = value => (Array.isArray(value) ? value : [])
const bridge = new NativeBridge({ rcon: { command: text => command(text) }, session: 'external-pickup-lane-20261105-a1b2c3d4e5f6' })

const held = name => lua(`rcon.print(helpers.table_to_json({count=a.get_item_count(${JSON.stringify(name)})}))`).then(row => row.count)
const drop = (name, count, x, y) => lua(`local e=s.create_entity{name="item-on-ground",position={${x},${y}},stack={name=${JSON.stringify(name)},count=${count}}}; rcon.print(helpers.table_to_json({ok=e~=nil and e.valid}))`)
const box = (x, y, r) => `{{${x - r - 0.5},${y - r - 0.5}},{${x + r + 0.5},${y + r + 0.5}}}`
// Everything in the box but resources and the actor, as the engine holds it.
const inBox = (x, y, r) => lua(`local out={}; for _,e in pairs(s.find_entities_filtered{area=${box(x, y, r)}}) do if e.valid and e.type~="resource" and e~=a then out[#out+1]={name=e.name,type=e.type,unit_number=e.unit_number,item=e.type=="item-entity" and e.stack and e.stack.valid_for_read and e.stack.name or nil,count=e.type=="item-entity" and e.stack and e.stack.valid_for_read and e.stack.count or nil} end end; rcon.print(helpers.table_to_json({rows=out}))`).then(row => list(row.rows))
const toStart = () => lua(`a.teleport({${origin.x},${origin.y}}); rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))`)

async function settle(pending, label) {
  const deadline = Date.now() + 60000
  for (;;) {
    const receipt = await bridge.receipt(pending)
    if (receipt.terminal || receipt.state === 'uncertain') return receipt
    assert.ok(Date.now() < deadline, `${label} reached a terminal receipt: ${JSON.stringify(receipt).slice(0, 1500)}`)
    await delay(100)
  }
}

async function run(operation, key) {
  const prepared = await bridge.prepare(operation, key)
  const submitted = await bridge.submit(prepared)
  assert.equal(submitted.admitted, true, `${key} admitted`)
  const receipt = await settle(prepared.pending, key)
  // The runtime's after-probe: the names the preflight found, read once the receipt is terminal.
  const after = await bridge.effectProbe(prepared.operation, Object.keys(prepared.observed_before?.items ?? {}))
  return { prepared, receipt, after }
}

async function refusal(operation, key) {
  const before = (await bridge.snapshot()).high_water
  let error
  try { await bridge.prepare(operation, key) }
  catch (caught) { error = caught }
  assert.ok(error, `${key} was refused`)
  assert.equal(error.notSent, true, `${key} was not sent`)
  assert.equal((await bridge.snapshot()).high_water, before, `${key} used no journal ordinal`)
  return error
}

async function pickup() {
  const x = origin.x + 5
  const y = origin.y
  // Each stack on its own tile; the tree and the chest stand on other tiles of the same box.
  await drop('iron-ore', 3, x - 0.7, y + 0.2)
  await drop('stone', 1, x + 0.1, y + 0.8)
  await drop('iron-ore', 2, x + 0.9, y + 0.1)
  await lua(`s.create_entity{name="tree-01",position={${x - 1},${y - 1}}}; s.create_entity{name="wooden-chest",position={${x + 1},${y - 1}},force=a.force}; rcon.print(helpers.table_to_json({ok=true}))`)
  const before = { ore: await held('iron-ore'), stone: await held('stone') }
  const { prepared, receipt, after } = await run({ name: 'pick_up_ground_items', args: { x, y, radius: 1 } }, 'pickup-three')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  assert.equal(receipt.execution_completed, true)
  assert.equal(receipt.goal_verified, false)
  assert.deepEqual(list(prepared.preflight.items).map(item => [item.name, item.count]).sort(), [['iron-ore', 2], ['iron-ore', 3], ['stone', 1]])
  assert.deepEqual(Object.keys(prepared.observed_before.items).sort(), ['iron-ore', 'stone'])
  assert.equal(after.items['iron-ore'] - prepared.observed_before.items['iron-ore'], 5, 'observed delta of iron-ore')
  assert.equal(after.items.stone - prepared.observed_before.items.stone, 1, 'observed delta of stone')
  assert.equal(await held('iron-ore'), before.ore + 5, 'the engine inventory gained all 5 ore')
  assert.equal(await held('stone'), before.stone + 1)
  const rows = await inBox(x, y, 1)
  assert.deepEqual(rows.filter(row => row.type === 'item-entity'), [], 'no item stays on the ground in the box')
  assert.deepEqual(rows.map(row => row.name).sort(), ['tree-01', 'wooden-chest'], 'the tree and the chest in the box are untouched')
  evidence.pickup = { receipt_state: receipt.state, preflight_items: prepared.preflight.items, observed_before: prepared.observed_before, after, remaining: rows }
  console.log('PASS: PICKUP - three ground stacks picked up by native mining; tree and chest in the box untouched')
}

async function unblock() {
  await toStart()
  const tile = { x: origin.x + 2, y: origin.y + 6 }
  await drop('iron-ore', 4, tile.x + 0.1, tile.y - 0.1)
  const place = { name: 'place_entity', args: { entity_name: 'transport-belt', x: tile.x, y: tile.y, direction: 4 } }
  const error = await refusal(place, 'unblock-refused')
  assert.equal(error.details.native_code, 'placement_footprint_occupied', JSON.stringify(error.details))
  assert.ok(list(error.details.blockers).some(blocker => blocker.item === 'iron-ore'), JSON.stringify(error.details))
  assert.match(error.publicMessage, /pick_up_ground_items/)
  const { receipt } = await run({ name: 'pick_up_ground_items', args: { x: tile.x, y: tile.y } }, 'unblock-pickup')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  const placed = await run(place, 'unblock-place')
  assert.equal(placed.receipt.state, 'completed', JSON.stringify(placed.receipt).slice(0, 1500))
  const rows = await inBox(tile.x, tile.y, 0)
  assert.deepEqual(rows.map(row => [row.name, row.type]), [['transport-belt', 'transport-belt']], JSON.stringify(rows))
  evidence.unblock = { refusal: error.details, pickup: receipt.state, place: placed.receipt.state, tile: rows }
  console.log('PASS: UNBLOCK - the ground item refused the belt; after the pickup the same placement built it')
}

async function empty() {
  const x = origin.x - 6
  const y = origin.y - 6
  const error = await refusal({ name: 'pick_up_ground_items', args: { x, y, radius: 2 } }, 'pickup-empty')
  assert.equal(error.code, 'preflight_rejected')
  assert.equal(error.details.native_code, 'no_ground_items', JSON.stringify(error.details))
  evidence.empty = error.details
  console.log('PASS: EMPTY - a box without ground items was refused before sending')
}

async function full() {
  await toStart()
  const x = origin.x - 4
  const y = origin.y + 4
  assert.equal(await held('copper-plate'), 0)
  await drop('copper-plate', 5, x, y)
  const filled = await lua('local inv=a.get_main_inventory(); local n=0; while inv.count_empty_stacks()>0 and n<200 do inv.insert{name="wooden-chest",count=50}; n=n+1 end; rcon.print(helpers.table_to_json({empty=inv.count_empty_stacks()}))')
  assert.equal(filled.empty, 0, 'the fixture filled every inventory slot')
  const error = await refusal({ name: 'pick_up_ground_items', args: { x, y } }, 'pickup-full')
  assert.equal(error.details.native_code, 'inventory_full', JSON.stringify(error.details))
  assert.deepEqual((await inBox(x, y, 0)).map(row => [row.item, row.count]), [['copper-plate', 5]], 'the stack stays on the ground')
  await lua('a.remove_item{name="wooden-chest",count=a.get_item_count("wooden-chest")}; rcon.print(helpers.table_to_json({ok=true}))')
  evidence.full = error.details
  console.log('PASS: FULL - a stack the full inventory cannot take was refused before sending and stayed on the ground')
}

try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  const ready = Date.now() + 30000
  for (;;) {
    try { await connection.connect(); break }
    catch (error) { connection.close(); if (Date.now() >= ready) throw error; await delay(200) }
  }
  assert.match(await command('/version'), /2\.1\.24/)
  const bound = await bridge.bind()
  actorId = bound.actor.actor_id
  assert.equal(bound.status.external_ground_pickup_supported, 1)
  assert.equal(parse(await command('/silent-command rcon.print(helpers.table_to_json({humans=#game.connected_players}))'), 'humans').humans, 0)
  // Fixture: a flat, empty 41x41 grass square around the actor, and belts in its inventory.
  const start = await lua('rcon.print(helpers.table_to_json({x=math.floor(a.position.x),y=math.floor(a.position.y)}))')
  origin = { x: start.x + 0.5, y: start.y + 0.5 }
  await lua(`local tiles={}; for dx=-20,20 do for dy=-20,20 do tiles[#tiles+1]={name="grass-1",position={${start.x}+dx,${start.y}+dy}} end end; s.set_tiles(tiles); for _,e in pairs(s.find_entities_filtered{area={{${start.x}-20,${start.y}-20},{${start.x}+21,${start.y}+21}}}) do if e.valid and e~=a and e.type~="resource" and e.type~="character" then e.destroy() end end; a.teleport({${origin.x},${origin.y}}); a.insert{name="transport-belt",count=10}; rcon.print(helpers.table_to_json({ok=true}))`)
  await pickup()
  await unblock()
  await empty()
  await full()
  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, 'external-pickup-error.txt'), `${error?.stack ?? error}\n${error?.details ? JSON.stringify(error.details) : ''}\n`)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, 'external-pickup.json'), JSON.stringify({ evidence, transcript }, null, 2))
  connection?.close()
}
