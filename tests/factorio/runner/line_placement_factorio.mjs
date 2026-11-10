#!/usr/bin/env node
// External-harness place_line against the real engine with zero humans, driven through the shipped NativeBridge
// (prepare -> submit -> receipt), never through a model:
//
//   BELT       one admitted operation places an 8-tile east-facing transport-belt run; the completed receipt lists every
//              entity with its unit number, and the engine holds exactly those belts at those tiles
//   POLES      a 4-pole small-electric-pole line at spacing 5; the receipt lists every pole (wire connections recorded)
//   PARTIAL    an item put on the ground on tile 5 after admission (game paused) stops the line there: the receipt is
//              partial, never success, lists tiles 0-4 as placed and the first refusal at tile 5 with its blocker; the
//              ground item is not cleared and tiles 6-11 stay empty
//   SHORTFALL  holding 3 belts, a 6-tile line is refused before it is sent with the exact item accounting; nothing changes
//   BLOCKED    a ground item already on tile 2 refuses the whole line before it is sent, naming the tile and the item
//   STUMP      a tree stump (a corpse whose collision layers miss the belt's) on tile 1 does not block: native placement allows the
//              tile and the whole line completes (trial 5: stumps were refused as footprint blockers)
//   WIDE       no prototype list: a 2x2 stone-furnace line at spacing 2 completes; at spacing 1 it refuses before sending with
//              line_tiles_overlap at tile 1 (trial 6: place_line accepted only belts and poles)
//   WATER      a water tile under tile 1 refuses the line (native placement_not_clear) and names the tile as the blocker;
//              place_entity on the same tile names it too (trial 6: placement_not_clear carried no cause)
//   RECEIPT    a completed place_entity receipt names the engine entity it created (trial 6: the unit number was never read)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { NativeBridge } from '../external-harness/tools/external-harness/native-bridge.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the line-placement lane') }

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
// helpers.table_to_json writes an empty Lua table as {}.
const list = value => (Array.isArray(value) ? value : [])
const bridge = new NativeBridge({ rcon: { command: text => command(text) }, session: 'line-placement-lane-20261104-a1b2c3d4e5f6' })

const held = name => lua(`rcon.print(helpers.table_to_json({count=a.get_item_count(${JSON.stringify(name)})}))`).then(row => row.count)
const setHeld = (name, count) => lua(`local n=${JSON.stringify(name)}; local have=a.get_item_count(n); if have>${count} then a.remove_item{name=n,count=have-${count}} elseif have<${count} then a.insert{name=n,count=${count}-have} end; rcon.print(helpers.table_to_json({count=a.get_item_count(n)}))`)
// Every non-resource, non-actor entity in the row of a line, as the engine holds it.
const entitiesAt = tiles => lua(`local out={}; for i,p in ipairs({${tiles.map(t => `{${t.x},${t.y}}`).join(',')}}) do local row={}; for _,e in pairs(s.find_entities_filtered{area={{p[1]-0.45,p[2]-0.45},{p[1]+0.45,p[2]+0.45}}}) do if e.valid and e.type~="resource" and e~=a then row[#row+1]={name=e.name,type=e.type,unit_number=e.unit_number,x=e.position.x,y=e.position.y,direction=e.direction,item=e.type=="item-entity" and e.stack and e.stack.valid_for_read and e.stack.name or nil} end end; out[i]=row end; rcon.print(helpers.table_to_json({rows=out}))`).then(row => list(row.rows).map(list))
const groundItem = tile => lua(`local e=s.create_entity{name="item-on-ground",position={${tile.x},${tile.y}},stack={name="iron-plate",count=1}}; rcon.print(helpers.table_to_json({ok=e~=nil and e.valid}))`)
const toStart = () => lua(`a.teleport({${origin.x},${origin.y}}); rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))`)

function tilesOf({ x, y, line_direction, count, spacing = 1 }) {
  const step = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }[line_direction]
  return Array.from({ length: count }, (_, i) => ({ index: i, x: x + step[0] * spacing * i, y: y + step[1] * spacing * i }))
}

async function settle(pending, label) {
  const deadline = Date.now() + 60000
  for (;;) {
    const receipt = await bridge.receipt(pending)
    if (receipt.terminal || receipt.state === 'uncertain' && receipt.reason !== 'line_receipt_incomplete') return receipt
    assert.ok(Date.now() < deadline, `${label} reached a terminal receipt: ${JSON.stringify(receipt).slice(0, 1500)}`)
    await delay(100)
  }
}

async function run(operation, key, { beforeUnpause } = {}) {
  const prepared = await bridge.prepare(operation, key)
  if (beforeUnpause) await lua('game.tick_paused=true; rcon.print(helpers.table_to_json({paused=game.tick_paused}))')
  const submitted = await bridge.submit(prepared)
  assert.equal(submitted.admitted, true, `${key} admitted`)
  if (beforeUnpause) {
    await beforeUnpause()
    await lua('game.tick_paused=false; rcon.print(helpers.table_to_json({paused=game.tick_paused}))')
  }
  return { prepared, receipt: await settle(prepared.pending, key) }
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

function assertPlaced(line, engineRows, tiles, name, direction) {
  assert.equal(line.entity_name, name)
  for (const placed of line.placed) {
    const tile = tiles[placed.index]
    assert.deepEqual(placed.position, { x: tile.x, y: tile.y }, `placed ${placed.index} is at its tile`)
    assert.equal(placed.direction, direction)
    const row = engineRows[placed.index].filter(entity => entity.name === name)
    assert.equal(row.length, 1, `exactly one ${name} on tile ${placed.index}: ${JSON.stringify(engineRows[placed.index])}`)
    assert.equal(row[0].unit_number, placed.unit_number, `the receipt names the engine entity on tile ${placed.index}`)
    assert.equal(row[0].direction, direction)
  }
}

async function belt() {
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y - 4, direction: 4, line_direction: 4, count: 8 } }
  const tiles = tilesOf(operation.args)
  const before = await held('transport-belt')
  const { receipt } = await run(operation, 'line-belt')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  assert.equal(receipt.execution_completed, true)
  assert.equal(receipt.goal_verified, false)
  const line = receipt.line_placement
  assert.equal(line.count, 8)
  assert.equal(line.placed_count, 8)
  assert.deepEqual(line.placed.map(entity => entity.index), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(line.refusal, null)
  assertPlaced(line, await entitiesAt(tiles), tiles, 'transport-belt', 4)
  assert.equal(await held('transport-belt'), before - 8, 'native placement consumed exactly 8 belts')
  evidence.belt = { line, receipt_state: receipt.state }
  console.log('PASS: BELT - one admitted operation placed 8 belts; the completed receipt names each engine entity')
}

async function poles() {
  await toStart()
  const operation = { name: 'place_line', args: { entity_name: 'small-electric-pole', x: origin.x - 4, y: origin.y - 2, line_direction: 8, count: 4, spacing: 5 } }
  const tiles = tilesOf(operation.args)
  const before = await held('small-electric-pole')
  const { receipt } = await run(operation, 'line-poles')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  const line = receipt.line_placement
  assert.equal(line.placed_count, 4)
  assertPlaced(line, await entitiesAt(tiles), tiles, 'small-electric-pole', 0)
  assert.equal(await held('small-electric-pole'), before - 4)
  // Recorded, not asserted: whether script-created poles connect their copper wires natively.
  const wires = await lua(`local out={}; for i,t in ipairs({${line.placed.map(entity => `{${entity.position.x},${entity.position.y}}`).join(',')}}) do local e=game.surfaces[1].find_entity('small-electric-pole',{t[1],t[2]}); local ok,n=pcall(function() local total=0; for _,c in pairs(e.get_wire_connectors(false) or {}) do total=total+c.connection_count end; return total end); out[i]=ok and n or tostring(n) end; rcon.print(helpers.table_to_json({copper=out}))`)
  evidence.poles = { line, copper_connections: list(wires.copper) }
  console.log(`PASS: POLES - 4 poles at spacing 5 placed and receipted; copper connections per pole ${JSON.stringify(list(wires.copper))}`)
}

async function partial() {
  await toStart()
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y + 3, direction: 4, line_direction: 4, count: 12 } }
  const tiles = tilesOf(operation.args)
  const before = await held('transport-belt')
  const { receipt } = await run(operation, 'line-partial', { beforeUnpause: async () => {
    assert.equal((await groundItem(tiles[5])).ok, true, 'the fixture put an item on tile 5 after admission')
  } })
  assert.equal(receipt.state, 'partial', JSON.stringify(receipt).slice(0, 2000))
  assert.equal(receipt.execution_completed, false)
  assert.equal(receipt.requires_reconciliation, true)
  assert.equal(receipt.reason, 'exact_line_placement_partial')
  const line = receipt.line_placement
  assert.deepEqual(line.placed.map(entity => entity.index), [0, 1, 2, 3, 4])
  assert.equal(line.placed_count, 5)
  assert.equal(line.refusal?.index, 5, JSON.stringify(line.refusal))
  // A ground item passes can_place_entity, so only the execution-time line re-check (line_node_precheck) can refuse it.
  assert.equal(line.refusal.code, 'placement_footprint_occupied')
  assert.ok(list(line.refusal.blockers).some(blocker => blocker.item === 'iron-plate'), JSON.stringify(line.refusal))
  const rows = await entitiesAt(tiles)
  assertPlaced(line, rows, tiles, 'transport-belt', 4)
  assert.deepEqual(rows[5].map(entity => [entity.type, entity.item]), [['item-entity', 'iron-plate']], 'the ground item was neither cleared nor built over')
  for (let i = 6; i < 12; i++) assert.deepEqual(rows[i], [], `tile ${i} stayed empty`)
  assert.equal(await held('transport-belt'), before - 5, 'only the 5 placed belts were consumed')
  // The reconciliation names the same prefix and the unplaced remainder.
  const facts = receipt.reconciliation
  evidence.partial = { line, reason: receipt.reason, reconciliation: { verdict: facts?.verdict, reason: facts?.reason, partial: facts?.partial ?? facts?.facts } }
  console.log(`PASS: PARTIAL - tiles 0-4 placed, first refusal at tile 5 (${line.refusal.code}); receipt partial, never success`)
}

async function shortfall() {
  await toStart()
  await setHeld('transport-belt', 3)
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y + 7, direction: 4, line_direction: 4, count: 6 } }
  const tiles = tilesOf(operation.args)
  const error = await refusal(operation, 'line-shortfall')
  assert.equal(error.code, 'preflight_rejected')
  assert.equal(error.details.native_code, 'line_placement_items_insufficient')
  assert.deepEqual(error.details.placement_item, { item_name: 'transport-belt', required_count: 6, held_count: 3 })
  assert.match(error.publicMessage, /Requires 6 transport-belt, holds 3/)
  assert.equal(await held('transport-belt'), 3)
  for (const row of await entitiesAt(tiles)) assert.deepEqual(row, [])
  evidence.shortfall = { code: error.code, details: error.details }
  console.log('PASS: SHORTFALL - holding 3 belts, a 6-tile line was refused before sending with the exact accounting')
}

async function blocked() {
  await setHeld('transport-belt', 10)
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y + 10, line_direction: 4, count: 4 } }
  const tiles = tilesOf(operation.args)
  assert.equal((await groundItem(tiles[2])).ok, true)
  const error = await refusal(operation, 'line-blocked')
  assert.equal(error.details.tile_index, 2, JSON.stringify(error.details))
  assert.equal(error.details.native_code, 'placement_footprint_occupied', JSON.stringify(error.details))
  assert.ok(list(error.details.blockers).some(blocker => blocker.item === 'iron-plate'), JSON.stringify(error.details))
  assert.equal(await held('transport-belt'), 10)
  const rows = await entitiesAt(tiles)
  assert.deepEqual([rows[0], rows[1], rows[3]], [[], [], []])
  // Trial 4r (r4-034, r4-090): the actor's own character is not a blocker. A line starting under the actor is admitted,
  // the placing runtime steps the actor aside, and every tile is built.
  const actorAt = await toStart()
  const under = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x, y: origin.y, direction: 4, line_direction: 4, count: 2 } }
  const underTiles = tilesOf(under.args)
  const { receipt } = await run(under, 'line-actor-tile')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  assert.equal(receipt.line_placement.placed_count, 2)
  assertPlaced(receipt.line_placement, await entitiesAt(underTiles), underTiles, 'transport-belt', 4)
  const actorAfter = await lua('rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))')
  assert.ok(underTiles.every(tile => Math.abs(actorAfter.x - tile.x) >= 0.5 || Math.abs(actorAfter.y - tile.y) >= 0.5), `the actor stepped off its line: ${JSON.stringify(actorAfter)}`)
  evidence.blocked = { details: error.details, actor_tile: { actor: actorAt, after: actorAfter, line: receipt.line_placement } }
  console.log('PASS: BLOCKED - a ground item on tile 2 refused the whole line before sending, naming the tile and the item; a line under the actor was built after it stepped aside')
}

async function stump() {
  await setHeld('transport-belt', 10)
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y + 14, direction: 4, line_direction: 4, count: 3 } }
  const tiles = tilesOf(operation.args)
  const corpse = await lua(`local e=s.create_entity{name="tree-08-stump",position={${tiles[1].x},${tiles[1].y}}}; local n=0; local names={}; for k in pairs(e.prototype.collision_mask.layers) do n=n+1; names[#names+1]=k end; local belt={}; for k in pairs(prototypes.entity["transport-belt"].collision_mask.layers) do belt[#belt+1]=k end; rcon.print(helpers.table_to_json({ok=e.valid,type=e.type,layers=n,names=names,belt=belt,native=s.can_place_entity{name="transport-belt",position={${tiles[1].x},${tiles[1].y}},direction=defines.direction.east,force=a.force,build_check_type=defines.build_check_type.manual}}))`)
  assert.equal(corpse.ok, true)
  assert.equal(corpse.type, 'corpse')
  // Engine fact at 2.1.24: the stump's only layer (doodad) is not one of the belt's layers.
  assert.ok(list(corpse.names).length > 0 && !list(corpse.names).some(layer => list(corpse.belt).includes(layer)), JSON.stringify(corpse))
  assert.equal(corpse.native, true, 'native placement allows a belt on a stump')
  const { receipt } = await run(operation, 'line-stump')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  assert.equal(receipt.line_placement.placed_count, 3)
  assertPlaced(receipt.line_placement, await entitiesAt(tiles), tiles, 'transport-belt', 4)
  evidence.stump = { corpse, line: receipt.line_placement }
  console.log('PASS: STUMP - a stump whose collision layers miss the belt layers did not block; native placement allowed the tile and the line completed')
}

async function wide() {
  await toStart()
  await setHeld('stone-furnace', 3)
  const operation = { name: 'place_line', args: { entity_name: 'stone-furnace', x: origin.x - 15.5, y: origin.y - 10.5, line_direction: 4, count: 3, spacing: 2 } }
  const tiles = tilesOf(operation.args)
  const overlap = await refusal({ name: 'place_line', args: { ...operation.args, spacing: 1 } }, 'line-wide-overlap')
  assert.equal(overlap.details.native_code, 'line_tiles_overlap', JSON.stringify(overlap.details))
  assert.equal(overlap.details.tile_index, 1, JSON.stringify(overlap.details))
  assert.equal(await held('stone-furnace'), 3)
  const { receipt } = await run(operation, 'line-wide')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  assert.equal(receipt.line_placement.placed_count, 3)
  assertPlaced(receipt.line_placement, await entitiesAt(tiles), tiles, 'stone-furnace', 0)
  assert.equal(await held('stone-furnace'), 0)
  evidence.wide = { overlap: overlap.details, line: receipt.line_placement }
  console.log('PASS: WIDE - a 2x2 furnace line at spacing 2 completed; spacing 1 refused before sending with line_tiles_overlap at tile 1')
}

async function water() {
  await toStart()
  await setHeld('transport-belt', 10)
  const operation = { name: 'place_line', args: { entity_name: 'transport-belt', x: origin.x + 3, y: origin.y + 17, direction: 4, line_direction: 4, count: 3 } }
  const tiles = tilesOf(operation.args)
  const wet = { x: Math.floor(tiles[1].x), y: Math.floor(tiles[1].y) }
  await lua(`s.set_tiles({{name="water",position={${wet.x},${wet.y}}}}); rcon.print(helpers.table_to_json({tile=s.get_tile(${wet.x},${wet.y}).name}))`)
  const error = await refusal(operation, 'line-water')
  assert.equal(error.details.native_code, 'placement_not_clear', JSON.stringify(error.details))
  assert.equal(error.details.tile_index, 1, JSON.stringify(error.details))
  assert.ok(list(error.details.blockers).some(blocker => blocker.type === 'tile' && blocker.name === 'water'), JSON.stringify(error.details))
  const single = await refusal({ name: 'place_entity', args: { entity_name: 'transport-belt', x: tiles[1].x, y: tiles[1].y, direction: 4 } }, 'entity-water')
  assert.equal(single.details.native_code, 'placement_not_clear', JSON.stringify(single.details))
  assert.ok(list(single.details.blockers).some(blocker => blocker.type === 'tile' && blocker.name === 'water'), JSON.stringify(single.details))
  assert.match(single.message, /water \[tile\]/)
  assert.equal(await held('transport-belt'), 10)
  evidence.water = { line: error.details, place_entity: single.details }
  console.log('PASS: WATER - a water tile refused the line and place_entity with placement_not_clear, naming the tile')
}

async function placedReceipt() {
  await toStart()
  const at = { x: origin.x + 8, y: origin.y - 8 }
  const { receipt } = await run({ name: 'place_entity', args: { entity_name: 'transport-belt', x: at.x, y: at.y, direction: 4 } }, 'entity-receipt')
  assert.equal(receipt.state, 'completed', JSON.stringify(receipt).slice(0, 1500))
  const [row] = await entitiesAt([at])
  const engine = row.filter(entity => entity.name === 'transport-belt')
  assert.equal(engine.length, 1, JSON.stringify(row))
  assert.deepEqual(receipt.placed_entity, { unit_number: engine[0].unit_number, entity_name: 'transport-belt', entity_type: 'transport-belt',
    position: { x: at.x, y: at.y }, direction: 4, source: 'native_placement_result' }, JSON.stringify(receipt).slice(0, 1500))
  evidence.receipt = receipt.placed_entity
  console.log(`PASS: RECEIPT - the place_entity receipt names unit ${engine[0].unit_number}, the belt the engine holds there`)
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
  assert.equal(bound.status.external_line_placement_supported, 1)
  assert.equal(parse(await command('/silent-command rcon.print(helpers.table_to_json({humans=#game.connected_players}))'), 'humans').humans, 0)
  // Fixture: a flat, empty 41x41 grass square around the actor, and the line items in its inventory.
  const start = await lua('rcon.print(helpers.table_to_json({x=math.floor(a.position.x),y=math.floor(a.position.y)}))')
  origin = { x: start.x + 0.5, y: start.y + 0.5 }
  await lua(`local tiles={}; for dx=-20,20 do for dy=-20,20 do tiles[#tiles+1]={name="grass-1",position={${start.x}+dx,${start.y}+dy}} end end; s.set_tiles(tiles); for _,e in pairs(s.find_entities_filtered{area={{${start.x}-20,${start.y}-20},{${start.x}+21,${start.y}+21}}}) do if e.valid and e~=a and e.type~="resource" and e.type~="character" then e.destroy() end end; a.teleport({${origin.x},${origin.y}}); a.insert{name="transport-belt",count=40}; a.insert{name="small-electric-pole",count=10}; rcon.print(helpers.table_to_json({ok=true}))`)
  await belt()
  await poles()
  await partial()
  await shortfall()
  await blocked()
  await stump()
  await wide()
  await water()
  await placedReceipt()
  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, 'line-placement-error.txt'), `${error?.stack ?? error}\n${error?.details ? JSON.stringify(error.details) : ''}\n`)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, 'line-placement.json'), JSON.stringify({ evidence, transcript }, null, 2))
  connection?.close()
}
