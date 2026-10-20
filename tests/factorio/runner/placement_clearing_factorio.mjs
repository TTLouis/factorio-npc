#!/usr/bin/env node
// Run 19af (ledger AF-2): placement over entities a build may clear, against the real engine.
//
// getPlacementCandidates used to treat every footprint touched by a tree, rock or the NPC's own
// entity as blocked. A footprint refused only for things a build may clear is now a candidate whose
// `clears` names them, and placing it hand-mines them into the NPC inventory first. This lane
// checks, in Factorio 2.0.77 with zero humans and the real standalone actor:
//
//   CANDIDATES  the engine's own collision masks put a tree, a rock and the NPC's idle chest in a
//               furnace footprint, and each footprint is a candidate with a matching `clears`
//   BLOCKED     a chest on another force, a chest holding items and a cliff keep their footprints
//               out of the candidates, and a raw placement there is refused with the world intact
//   CLEARED     placing a candidate walks into hand-mining reach, waits at least the native mining
//               time, mines the entity into the inventory (receipt items equal the inventory
//               change), and builds; the batch, admission and reconciliation say completed
//   FULL        when the inventory cannot take the yield the refusal is clearing_inventory_full,
//               before any mutation, with the tree still standing
//   ANCHOR      an anchor entity is accepted by the production tool and ranks candidates nearest it
//
// Every operation goes through the production renderer and the protocol-2 authorized batch
// wrapper. No provider, no inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { provenRefusal, reconcilePendingOperation } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { parseOperation, renderOperation, toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the placement clearing lane') }

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
const box = b => `{{${b.left_top.x},${b.left_top.y}},{${b.right_bottom.x},${b.right_bottom.y}}}`
// The furnace footprint at a centre (2x2, so the centre is a tile corner).
const furnaceBox = position => ({ left_top: { x: position.x - 1, y: position.y - 1 }, right_bottom: { x: position.x + 1, y: position.y + 1 } })

async function untilIdle(label, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) return status
    assert.ok(Date.now() < until, `${label}: native work did not finish`)
    await delay(200)
  }
}

async function admitted(label, operation) {
  const deployment = await deploymentStatus(rcon, { requireAllowed: true })
  ordinal++
  const pending = {
    protocol_version: 2, operation_key: `placement-clearing/${label}`, attempt_id: `${label}-1`, signature: `placement-clearing-${label}`,
    actor: { actor_id: deployment.actor_id, epoch: deployment.epoch }, ordinal, operations: [operation],
  }
  const started = (await lua('rcon.print(helpers.table_to_json({tick=game.tick}))')).tick
  const batch = await executeAuthorizedBatch(rcon, deployment.epoch, [renderOperation(parseOperation(operation))], undefined, pending)
  assert.equal(batch.results.length, 1)
  assert.notEqual(batch.results[0]?.[0], false, `${label} was refused at submission: ${JSON.stringify(batch.results[0])}`)
  const status = await untilIdle(label)
  const finished = (await lua('rcon.print(helpers.table_to_json({tick=game.tick}))')).tick
  const record = status.admission_journal.find(entry => entry.operation_key === pending.operation_key)
  assert.ok(record, `${label}: admission record missing`)
  const ref = record.slots[0].batch_refs[0]
  assert.ok(ref, `${label}: the admitted slot names no batch`)
  const receipt = status.receipt_journal.find(entry => entry.batch_ref === ref.batch_ref && entry.batch_id === ref.batch_id)
  assert.ok(receipt, `${label}: batch receipt missing`)
  const verdict = reconcilePendingOperation(pending, { status, actor: pending.actor })
  return { result: status.basic_operation?.last_result, record, receipt, verdict, proof: provenRefusal(record, status), ticks: finished - started }
}

// What the engine says about the character's hand-mining rate and an entity's mining time, to compare the wait with.
const nativeMiningTicks = unit => lua(`local e=${unit}; local speed=a.prototype.mining_speed*(1+a.character_mining_speed_modifier+a.force.manual_mining_speed_modifier); `
  + 'rcon.print(helpers.table_to_json({ticks=math.ceil(e.prototype.mineable_properties.mining_time/speed*60)}))')

const held = names => `{${names.map(name => `"${name}"`).join(',')}}`
const heldCounts = names => lua(`local out={}; for _,n in pairs(${held(names)}) do out[n]=inv.get_item_count(n) end; rcon.print(helpers.table_to_json({held=out}))`)
const standing = (footprint, name) => lua(`rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{area=${box(footprint)},name="${name}"}}))`)

async function main() {
  await fsp.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  await configureNpcSession(rcon, 'placement-clearing-engine-0001')
  actorId = (await deploymentStatus(rcon, { requireAllowed: true })).actor_id
  assert.ok(Number.isInteger(actorId), 'the deployment names its standalone actor')

  // ---- fixture: landfill pad, one blocker per site -------------------------
  const fixture = await lua('remote.call("autorio_operations","cancel_all_tasks"); game.speed=1; s.always_day=true; '
    + 'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); local area={{ox-14,oy-14},{ox+14,oy+14}}; '
    + 'for _,e in pairs(s.find_entities_filtered{area=area}) do if e~=a and e.type~="character" then e.destroy() end end; '
    + 'local tiles={}; for x=ox-14,ox+14 do for y=oy-14,oy+14 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); '
    + 'local visitor=game.forces["visitor"] or game.create_force("visitor"); '
    + 'local sx=ox+7.5; local made={}; '
    + 'made.tree=s.create_entity{name="tree-01",position={sx,oy-10.5}}; '
    + 'made.rock=s.create_entity{name="big-rock",position={sx,oy-6.5}}; '
    + 'made.own=s.create_entity{name="wooden-chest",position={sx,oy-2.5},force=a.force}; '
    + 'made.foreign=s.create_entity{name="wooden-chest",position={sx,oy+1.5},force=visitor}; '
    + 'made.loaded=s.create_entity{name="wooden-chest",position={sx,oy+5.5},force=a.force}; made.loaded.insert{name="iron-plate",count=5}; '
    + 'local ok,cliff=pcall(function() return s.create_entity{name="cliff",position={sx,oy+9.5},cliff_orientation="west-to-east"} end); made.cliff=ok and cliff or nil; '
    + 'inv.clear(); inv.insert{name="stone-furnace",count=8}; '
    + 'local info={}; for k,e in pairs(made) do info[k]={name=e.name,type=e.type,force=e.force.name,unit=e.unit_number,x=e.position.x,y=e.position.y,minable=e.minable} end; '
    + 'rcon.print(helpers.table_to_json({ox=ox,oy=oy,humans=#game.connected_players,speed=game.speed,actor_force=a.force.name,made=info}))')
  assert.equal(fixture.humans, 0, 'zero humans')
  assert.equal(fixture.speed, 1)
  assert.equal(fixture.made.tree?.force, 'neutral')
  assert.equal(fixture.made.own?.force, fixture.actor_force)
  evidence.fixture = fixture
  const { made } = fixture
  const at = site => ({ x: site.x, y: site.y })
  const candidatesAt = (site, extra = {}) => tool('getPlacementCandidates', { entity_name: 'stone-furnace', covers_position: at(site), center: at(site), radius: 3, limit: 3, ...extra })

  // ---- CANDIDATES ------------------------------------------------------------
  const treeRead = await candidatesAt(made.tree)
  assert.equal(treeRead.ok, true, JSON.stringify(treeRead).slice(0, 600))
  assert.ok(treeRead.candidates.length > 0, `a footprint over a tree is a candidate: ${JSON.stringify(treeRead).slice(0, 800)}`)
  for (const candidate of treeRead.candidates) {
    assert.ok(candidate.clears?.some(entry => entry.name === 'tree-01' && entry.reason === 'natural_obstruction'), `candidate names the tree: ${JSON.stringify(candidate)}`)
  }
  assert.equal(treeRead.obstructions?.label, 'rejected_footprint_samples_not_candidates')
  const rockRead = await candidatesAt(made.rock)
  assert.ok(rockRead.candidates.length > 0, `a footprint over a rock is a candidate: ${JSON.stringify(rockRead).slice(0, 800)}`)
  assert.ok(rockRead.candidates.every(candidate => candidate.clears?.some(entry => entry.name === 'big-rock' && entry.reason === 'natural_obstruction')))
  const ownRead = await candidatesAt(made.own)
  assert.ok(ownRead.candidates.length > 0, `a footprint over the NPC's idle chest is a candidate: ${JSON.stringify(ownRead).slice(0, 800)}`)
  assert.ok(ownRead.candidates.every(candidate => candidate.clears?.some(entry => entry.name === 'wooden-chest' && entry.reason === 'own_idle_entity' && entry.unit_number === made.own.unit)))
  evidence.candidates = { tree: treeRead.candidates[0], rock: rockRead.candidates[0], own: ownRead.candidates[0] }
  console.log('PASS: CANDIDATES - tree, rock and idle own chest footprints are candidates that name what they clear')

  // ---- BLOCKED ---------------------------------------------------------------
  const blocked = {}
  for (const [label, site] of [['foreign', made.foreign], ['loaded', made.loaded], ...(made.cliff ? [['cliff', made.cliff]] : [])]) {
    const read = await candidatesAt(site)
    assert.equal(read.ok, true, JSON.stringify(read).slice(0, 400))
    assert.equal(read.returned_candidate_count, 0, `${label} keeps its footprint out of the candidates: ${JSON.stringify(read.candidates)}`)
    assert.ok(read.obstructions.rejected_count > 0)
    assert.equal(read.obstructions.label, 'rejected_footprint_samples_not_candidates')
    blocked[label] = { rejected: read.obstructions.rejected_count, samples: read.obstructions.samples?.length }
  }
  const raw = await admitted('foreign-raw', { name: 'place_entity', args: { entity_name: 'stone-furnace', x: made.foreign.x + 0.5, y: made.foreign.y + 0.5, direction: 0 } })
  assert.equal(raw.result?.code, 'not_placeable', JSON.stringify(raw.result))
  assert.equal(raw.result.entities_cleared, undefined)
  assert.equal((await lua(`rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{name="wooden-chest",position={${made.foreign.x},${made.foreign.y}},radius=0.5,force="visitor"}}))`)).count, 1, 'the other force\'s chest is untouched')
  evidence.blocked = { ...blocked, foreign_raw: raw.result }
  console.log(`PASS: BLOCKED - ${Object.keys(blocked).join(', ')} keep their footprints blocked; a raw placement over the other force's chest is refused with the world intact`)

  // ---- CLEARED: tree, rock, own chest ---------------------------------------
  const cleared = {}
  for (const [label, site, read, product] of [['tree', made.tree, treeRead, 'wood'], ['rock', made.rock, rockRead, 'stone'], ['own', made.own, ownRead, 'wooden-chest']]) {
    const candidate = read.candidates[0]
    const footprint = furnaceBox(candidate.position)
    const expected = await nativeMiningTicks(`s.find_entities_filtered{name="${site.name}",position={${site.x},${site.y}},radius=0.5}[1]`)
    const before = await heldCounts([product, 'stone-furnace'])
    const built = await admitted(`build-over-${label}`, { name: 'place_candidate', args: { candidate_set_id: read.candidate_set_id, candidate_id: candidate.id } })
    const after = await heldCounts([product, 'stone-furnace'])
    assert.equal(built.result?.code, 'completed', JSON.stringify(built.result))
    const receipt = built.result.entities_cleared
    assert.equal(receipt?.length, 1, JSON.stringify(receipt))
    assert.equal(receipt[0].name, site.name)
    const gained = (receipt[0].items ?? []).filter(item => item.name === product).reduce((sum, item) => sum + item.count, 0)
    assert.ok(gained > 0, `the receipt names the ${product} the inventory gained`)
    assert.equal(after.held[product] - before.held[product], gained, 'entities_cleared items equal the inventory change')
    assert.equal(after.held['stone-furnace'], before.held['stone-furnace'] - 1)
    assert.equal((await standing(footprint, 'stone-furnace')).count, 1, 'the furnace stands where the blocker was')
    assert.ok(built.ticks >= expected.ticks, `the build waited at least the native mining time (${built.ticks} ticks, ${expected.ticks} needed)`)
    assert.equal(built.receipt.state, 'completed')
    assert.equal(built.record.state, 'completed')
    assert.equal(built.verdict.verdict, 'admitted_completed')
    assert.equal(built.verdict.effect, 'happened')
    cleared[label] = { result: built.result, ticks: built.ticks, native_ticks: expected.ticks, before, after }
    console.log(`PASS: CLEARED - ${label}: furnace built over it after ${built.ticks} ticks (native mining time ${expected.ticks}); +${gained} ${product}`)
  }
  evidence.cleared = cleared

  // ---- FULL: no room for the yield, so nothing is mined ---------------------
  // A tree beside the NPC, so the placement needs no approach walk: the batch then keeps its single-start no-mutation proof.
  const planted = await lua('local p=a.position; local tree=s.create_entity{name="tree-01",position={math.floor(p.x)+3.5,math.floor(p.y)+0.5}}; '
    + 'inv.clear(); inv.insert{name="stone-furnace",count=2}; inv.insert{name="iron-plate",count=100000}; '
    + 'rcon.print(helpers.table_to_json({planted=tree~=nil,x=tree and tree.position.x,y=tree and tree.position.y,insertable=inv.get_insertable_count("wood")}))')
  assert.equal(planted.planted, true, 'a second tree stands on the pad')
  const spare = { x: planted.x, y: planted.y }
  assert.equal(planted.insertable, 0, 'the inventory has no room for wood')
  const fullRead = await candidatesAt(spare)
  assert.ok(fullRead.candidates.length > 0)
  const beforeFull = await heldCounts(['wood', 'stone-furnace'])
  // A plain place_entity at the candidate's spot: only submit-pure operations can settle as a proven refusal.
  const pick = fullRead.candidates[0]
  const refused = await admitted('inventory-full', { name: 'place_entity', args: { entity_name: 'stone-furnace', x: pick.position.x, y: pick.position.y, direction: pick.direction } })
  assert.equal(refused.result?.code, 'clearing_inventory_full', JSON.stringify(refused.result))
  assert.equal(refused.result.entities_cleared, undefined)
  assert.equal(refused.result.clearing_left?.name, 'tree-01')
  assert.deepEqual(await heldCounts(['wood', 'stone-furnace']), beforeFull, 'the refusal left the inventory unchanged')
  assert.equal((await lua(`rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{name="tree-01",position={${spare.x},${spare.y}},radius=0.5}}))`)).count, 1, 'the tree still stands')
  assert.equal(refused.receipt.failed_before_mutation, true, JSON.stringify({ receipt: refused.receipt, result: refused.result }))
  assert.equal(refused.record.proven_refusal, true, JSON.stringify({ record: refused.record, receipt: refused.receipt, verdict: refused.verdict }))
  assert.equal(refused.verdict.verdict, 'refused_before_mutation')
  evidence.full = { result: refused.result, receipt: refused.receipt, verdict: refused.verdict }
  console.log('PASS: FULL - clearing_inventory_full before any mutation; proof kept and reconciled as refused before mutation')

  // ---- ANCHOR ---------------------------------------------------------------
  await lua('inv.clear(); inv.insert{name="stone-furnace",count=2}; rcon.print("{}")')
  // Chests are not indexed by unit number in the engine; an observation read gives the harness its identity hint, as the model's own reads do.
  const seen = await tool('getNearbyEntities', { name: 'wooden-chest', radius: 32, limit: 8 })
  assert.ok(JSON.stringify(seen).includes(String(made.loaded.unit)), `the observation names the loaded chest: ${JSON.stringify(seen).slice(0, 400)}`)
  const anchored = await tool('getPlacementCandidates', { entity_name: 'stone-furnace', center: at(made.own), radius: 6, limit: 5, anchor: { unit_number: made.loaded.unit } })
  assert.equal(anchored.ok, true, JSON.stringify(anchored).slice(0, 600))
  assert.equal(anchored.ordering, 'nearest_to_anchor_first')
  assert.equal(anchored.anchor?.unit_number, made.loaded.unit)
  const distances = anchored.candidates.map(candidate => candidate.distance_from_anchor)
  assert.ok(distances.length > 1 && distances.every(value => Number.isFinite(value)), JSON.stringify(distances))
  assert.deepEqual([...distances].sort((left, right) => left - right), distances)
  evidence.anchor = { ordering: anchored.ordering, distances }
  console.log('PASS: ANCHOR - candidates ranked nearest the anchor entity')

  const closing = await lua('rcon.print(helpers.table_to_json({humans=#game.connected_players,speed=game.speed}))')
  assert.equal(closing.humans, 0)
  assert.equal(forbiddenFetchCalls, 0)
  evidence.closing = { ...closing, forbidden_fetch_calls: forbiddenFetchCalls }
}

try {
  await main()
  await fsp.writeFile(path.join(results, 'placement-clearing.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log('PASS: placement clearing lane')
}
catch (error) {
  await fsp.mkdir(results, { recursive: true }).catch(() => {})
  await fsp.writeFile(path.join(results, 'placement-clearing-error.txt'), `${error?.stack ?? error}\n`).catch(() => {})
  throw error
}
finally {
  await fsp.writeFile(path.join(results, 'placement-clearing-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`).catch(() => {})
  await connection?.close?.()
}
