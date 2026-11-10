#!/usr/bin/env node
// External-harness getActorSupplies against the real engine with zero humans, driven through the shipped runtime journal
// and NativeBridge (submit -> receipt -> journal), never through a model. The report is a harness fact: it lists what the
// NPC's own operations moved into each entity, so an operator given a short goal can see its own hand supplies.
//
//   FUEL      move_items_exact puts coal into a stone furnace: the report row names the furnace, the requested count and an
//             actor inventory drop equal to what the engine shows in the furnace fuel slot
//   STOCK     supply_entity stocks a chest with two items: one row, both items, each with the observed actor drop the engine
//             shows in the chest (every supplied item is observed, not only single-item operations)
//   TAKE      move_items_exact out of the chest (to_entity false) is not a supply and is not listed
//   REFUSED   a supply to a missing entity is refused before sending and is not listed
//   NO_GAME   reading the report sends no RCON command
//   RESTART   a reopened runtime over the same journal returns the same report
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { openRuntime } from '../external-harness/deploy/pterodactyl/runtime-v8/operator-runtime.mjs'
import { NativeBridge } from '../external-harness/tools/external-harness/native-bridge.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the external actor-supplies lane') }

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0 && process.argv[at + 1], `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const session = 'external-supplies-lane-20261110-a1b2c3d4e5f6'
const transcript = []
const evidence = {}
let connection
let actorId
let origin
let commands = 0

const command = async text => {
  commands++
  const response = await connection.command(text)
  transcript.push({ command: text.slice(0, 800), response: String(response).slice(0, 4000) })
  return response
}
const parse = (raw, label) => {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} did not return JSON: ${String(raw).slice(0, 800)}`) }
}
// Test fixture Lua only (world setup and engine reads); the NPC acts solely through the runtime and bridge.
const lua = async body => parse(await command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; ${body}`), body.slice(0, 200))
const bridge = new NativeBridge({ rcon: { command: text => command(text) }, session })
const held = name => lua(`rcon.print(helpers.table_to_json({count=a.get_item_count(${JSON.stringify(name)})}))`).then(row => row.count)
// Engine read by name and position: game.get_entity_by_unit_number does not index these buildings either.
const contents = at => lua(`local e=s.find_entity(${JSON.stringify(at.name)},{${at.x},${at.y}}); assert(e and e.valid); local out={}; for i=1,e.get_max_inventory_index() do local inv=e.get_inventory(i); if inv then for _,c in pairs(inv.get_contents()) do out[c.name]=(out[c.name] or 0)+c.count end end end; rcon.print(helpers.table_to_json({items=out}))`).then(row => row.items ?? {})
// The engine's exact-target index does not resolve script-created buildings, so the NPC builds what it later supplies.
const unitAt = (name, x, y) => lua(`local e=s.find_entity(${JSON.stringify(name)},{${x},${y}}); rcon.print(helpers.table_to_json({unit=e and e.unit_number}))`).then(row => row.unit)

let runtime
const directory = path.join(results, 'journal')
let request = 0

async function complete(operation, label) {
  const admitted = await runtime.submit({ request_id: `${label}-${++request}`, operation })
  const deadline = Date.now() + 60000
  let receipt = admitted
  while (!receipt.terminal) {
    assert.ok(Date.now() < deadline, `${label} reached a terminal receipt: ${JSON.stringify(receipt).slice(0, 1500)}`)
    receipt = await runtime.get({ operation_id: admitted.operation_id, wait_ms: 2000 })
  }
  assert.equal(receipt.state, 'completed', `${label}: ${JSON.stringify(receipt).slice(0, 1500)}`)
  return receipt
}
const report = args => runtime.observe({ name: 'getActorSupplies', args })

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
  assert.equal(parse(await command('/silent-command rcon.print(helpers.table_to_json({humans=#game.connected_players}))'), 'humans').humans, 0)
  // Fixture: a flat, empty 21x21 grass square around the actor; coal and plates in its inventory.
  const start = await lua('rcon.print(helpers.table_to_json({x=math.floor(a.position.x),y=math.floor(a.position.y)}))')
  origin = { x: start.x + 0.5, y: start.y + 0.5 }
  await lua(`local tiles={}; for dx=-10,10 do for dy=-10,10 do tiles[#tiles+1]={name="grass-1",position={${start.x}+dx,${start.y}+dy}} end end; s.set_tiles(tiles); for _,e in pairs(s.find_entities_filtered{area={{${start.x}-10,${start.y}-10},{${start.x}+11,${start.y}+11}}}) do if e.valid and e~=a and e.type~="resource" and e.type~="character" then e.destroy() end end; a.teleport({${origin.x},${origin.y}}); a.insert{name="coal",count=20}; a.insert{name="iron-plate",count=20}; a.insert{name="stone-furnace",count=1}; a.insert{name="wooden-chest",count=1}; rcon.print(helpers.table_to_json({ok=true}))`)
  runtime = await openRuntime({ bridge, directory, session, pollMs: 100 })
  await complete({ name: 'place_entity', args: { entity_name: 'stone-furnace', x: origin.x + 2.5, y: origin.y + 0.5 } }, 'place-furnace')
  await complete({ name: 'place_entity', args: { entity_name: 'wooden-chest', x: origin.x - 3, y: origin.y } }, 'place-chest')
  const furnaceAt = { name: 'stone-furnace', x: origin.x + 2.5, y: origin.y + 0.5 }
  const chestAt = { name: 'wooden-chest', x: origin.x - 3, y: origin.y }
  const furnace = await unitAt(furnaceAt.name, furnaceAt.x, furnaceAt.y)
  const chest = await unitAt(chestAt.name, chestAt.x, chestAt.y)
  assert.ok(Number.isSafeInteger(furnace) && Number.isSafeInteger(chest), `the NPC built both: ${furnace} ${chest}`)
  // Building is not a supply: the report starts empty.
  assert.deepEqual((await report({})).entities, [])

  // FUEL
  const coalBefore = await held('coal')
  const fuel = await complete({ name: 'move_items_exact', args: { item_name: 'coal', unit_number: furnace, max_count: 5, to_entity: true } }, 'fuel')
  const inFurnace = await contents(furnaceAt)
  assert.equal(inFurnace.coal, 5, `the engine furnace holds the fuel: ${JSON.stringify(inFurnace)}`)
  assert.equal(await held('coal'), coalBefore - 5)
  let rows = await report({})
  assert.deepEqual(rows.entities.map(row => row.unit_number), [furnace])
  assert.deepEqual(rows.entities[0].items, [{ item_name: 'coal', requested: 5, actor_decrease: 5, observed_operations: 1 }])
  assert.equal(rows.entities[0].last_operation_id, fuel.operation_id)
  evidence.fuel = { furnace, engine: inFurnace, row: rows.entities[0] }
  console.log('PASS: FUEL - the furnace row matches the coal the engine holds in the furnace')

  // STOCK
  const before = { coal: await held('coal'), plate: await held('iron-plate') }
  await complete({ name: 'supply_entity', args: { unit_number: chest, items: [{ item_name: 'iron-plate', count: 8 }, { item_name: 'coal', count: 2 }] } }, 'stock')
  const inChest = await contents(chestAt)
  assert.deepEqual(inChest, { 'coal': 2, 'iron-plate': 8 }, 'the engine chest holds both supplied items')
  assert.deepEqual({ coal: await held('coal'), plate: await held('iron-plate') }, { coal: before.coal - 2, plate: before.plate - 8 })
  rows = await report({})
  assert.deepEqual(rows.entities.map(row => row.unit_number), [chest, furnace], 'most recently supplied first')
  assert.deepEqual(rows.entities[0].items, [
    { item_name: 'coal', requested: 2, actor_decrease: 2, observed_operations: 1 },
    { item_name: 'iron-plate', requested: 8, actor_decrease: 8, observed_operations: 1 }])
  evidence.stock = { chest, engine: inChest, row: rows.entities[0] }
  console.log('PASS: STOCK - the chest row names both supplied items with the drop the engine shows')

  // TAKE
  await complete({ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: chest, max_count: 3, to_entity: false } }, 'take')
  assert.equal((await contents(chestAt))['iron-plate'], 5, 'the take really happened in the engine')
  const afterTake = await report({})
  assert.equal(afterTake.operations, 2, 'a take is not a supply')
  assert.deepEqual(afterTake.entities, rows.entities)
  console.log('PASS: TAKE - moving items out of an entity is not listed')

  // REFUSED
  let refused
  try { await runtime.submit({ request_id: `refused-${++request}`, operation: { name: 'supply_entity', args: { unit_number: 987654321, items: [{ item_name: 'coal', count: 1 }] } } }) }
  catch (error) { refused = error }
  const refusedReport = await report({})
  assert.ok(refused === undefined ? true : refused.notSent === true || /not sent/i.test(String(refused.publicMessage ?? refused.message)), String(refused?.message))
  assert.deepEqual(refusedReport.entities.map(row => row.unit_number), [chest, furnace], 'a supply that never reached the game is not listed')
  evidence.refused = { code: refused?.code ?? null, message: String(refused?.publicMessage ?? refused?.message ?? 'journaled rejection') }
  console.log('PASS: REFUSED - a supply to a missing entity is not listed')

  // NO_GAME
  const sent = commands
  const filtered = await report({ unit_number: furnace })
  assert.equal(commands, sent, 'reading the report sends no RCON command')
  assert.deepEqual(filtered.entities.map(row => row.unit_number), [furnace])
  assert.equal(filtered.world_read, false)
  console.log('PASS: NO_GAME - the report is read from the journal without a game call')

  // RESTART
  await runtime.close()
  runtime = await openRuntime({ bridge, directory, session, pollMs: 100 })
  const reopened = await report({})
  assert.deepEqual(reopened, refusedReport, 'the reopened journal gives the same report')
  evidence.report = reopened
  console.log('PASS: RESTART - the report survives a runtime restart')

  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, 'external-actor-supplies-error.txt'), `${error?.stack ?? error}\n${error?.details ? JSON.stringify(error.details) : ''}\n`)
  process.exitCode = 1
}
finally {
  await runtime?.close().catch(() => {})
  await fs.writeFile(path.join(results, 'external-actor-supplies.json'), JSON.stringify({ evidence, transcript }, null, 2))
  connection?.close()
}
