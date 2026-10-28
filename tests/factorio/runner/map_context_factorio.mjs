#!/usr/bin/env node
// M3 completion: map context, fog and selection-to-execution freshness, against the real engine with zero humans.
//
// The standalone NPC knows the map through its own record (storage.sgluna_map_knowledge): a 5x5 chunk window it sees now,
// every chunk it has explored, and a revision counter. Factorio 2.0.77 charts nothing for a force with no connected player,
// so in this lane the NPC's window is the only "visible now". This lane checks, through the production renderers and the
// authorized batch wrapper, with no provider and no inference:
//
//   CROP        getMapContext returns a bounded V/F/U crop with surface, origin, tick, revision and what it left out
//   BOUNDARY    a real walk across one chunk boundary moves the window, bumps the revision and turns the column the NPC
//               left into explored-but-fogged; facts still in view stay usable
//   SELECTION   while the fixtures are visible: a candidate (anchored), a drill candidate on ore, a validated plan and a
//               site search all succeed; another force's entity and another surface's entity are refused as anchors
//   MOVEMENT    a real walk takes the fixtures out of view: the stored candidates and the validated plan are refused at
//               the authoritative boundary as not visible, before any walk or mutation; the anchor, site search and
//               local observation are refused as not visible; destroying the anchor and the ore in the fog changes
//               none of those answers, and no read charts, generates or reserves anything
//   RELOAD      after game.server_save() and a real process restart: the knowledge record, revision and crop persist and
//               the stale candidate and plan are still refused
//   RETURN      a real walk back: the chunk is visible again, the destroyed anchor is now not found (not "not visible"),
//               the drill candidate whose ore was mined away is refused for the live world, and a fresh plan validated
//               and executed there builds (the gate is visibility, not a blanket refusal)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { parseOperation, renderOperation, toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the map context lane') }

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0 && process.argv[at + 1], `missing --${name}`); return process.argv[at + 1] }
const phase = arg('phase')
const results = path.resolve(arg('results'))
const statePath = path.join(results, 'map-context-state.json')
const transcript = []
const evidence = { phase }
let connection
let actorId

const command = async text => {
  const response = await connection.command(text)
  transcript.push({ command: text.slice(0, 800), response: String(response).slice(0, 4000) })
  return response
}
const lua = async body => {
  const raw = await command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; local inv=a.get_main_inventory(); ${body}`)
  try { return JSON.parse(raw) }
  catch { throw new Error(`Lua command did not return JSON: ${String(raw).slice(0, 800)}\nCommand: ${body.slice(0, 400)}`) }
}
const tool = async (name, args) => {
  const raw = await command(toolCommand(name, args))
  try { return JSON.parse(raw) }
  catch { throw new Error(`${name} did not return JSON: ${String(raw).slice(0, 800)}`) }
}
const tick = async () => (await lua('rcon.print(helpers.table_to_json({t=game.tick}))')).t
async function waitTicks(count) {
  const target = (await tick()) + count
  while ((await tick()) < target) await delay(50)
}

async function untilIdle(label, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) return status
    assert.ok(Date.now() < until, `${label}: native work did not finish`)
    await delay(200)
  }
}

// One operation through the production renderer and the authorized batch wrapper. A refusal at submission (the
// authoritative preflight) is returned, not thrown; an admitted operation is waited for and its last result returned.
async function attempt(label, operation) {
  const deployment = await deploymentStatus(rcon(), { requireAllowed: true })
  const batch = await executeAuthorizedBatch(rcon(), deployment.epoch, [renderOperation(parseOperation(operation))])
  const submitted = batch.results[0]
  if (submitted?.[0] === false) return { label, refused_at_submission: true, submitted }
  const status = await untilIdle(label)
  return { label, refused_at_submission: false, submitted, result: status.basic_operation?.last_result }
}
const rcon = () => ({ command: (text, options) => connection.command(text, options) })

async function walk(label, to) {
  const outcome = await attempt(label, { name: 'walk_to_position', args: { x: to.x, y: to.y, reach_distance: 2 } })
  assert.equal(outcome.refused_at_submission, false, `${label}: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.result?.completed, true, `${label}: ${JSON.stringify(outcome.result)}`)
  await waitTicks(10)
  const at = await actorFacts()
  assert.ok(Math.hypot(at.x - to.x, at.y - to.y) <= 3, `${label}: the NPC walked to ${JSON.stringify(to)}, stands at ${JSON.stringify(at)}`)
  return at
}

const actorFacts = () => lua('rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y,surface=s.name,chests=inv.get_item_count("wooden-chest"),drills=inv.get_item_count("burner-mining-drill"),humans=#game.connected_players}))')

// What no read may change: the engine chart and generated chunks around the test map, the NPC's knowledge record and the
// reservations (both read through the mod's own remotes, since RCON runs in the level's script context, not the mod's), and
// the entities standing in the fixture chunk. Hint freshness is internal mod storage with no remote; the unit tests cover it.
const sideEffects = () => lua('local charted=0; local generated=0; '
  + 'for cx=-8,8 do for cy=-8,8 do if a.force.is_chunk_charted(s,{cx,cy}) then charted=charted+1 end; if s.is_chunk_generated({cx,cy}) then generated=generated+1 end end end; '
  + 'local k=remote.call("autorio_map","context").map_knowledge; local c=k.visible_center; '
  + 'local standing=#s.find_entities_filtered{area={{-96,-32},{-64,0}}}; '
  + 'rcon.print(helpers.table_to_json({charted=charted,generated=generated,explored=k.explored_chunks,revision=k.revision,'
  + 'window=c and {surface_index=c.surface_index,x=c.x,y=c.y} or nil,reservations=#remote.call("autorio_reservations","status").reservations,standing=standing}))')

const START = { x: -48.5, y: -16.5 }        // chunk (-2, -1): window x -4..0
const ONE_OVER = { x: -20.5, y: -16.5 }     // chunk (-1, -1): window x -3..1; chunk x=-4 leaves the window
const FAR = { x: 40.5, y: 20.5 }            // chunk (1, 0): window x -1..3, y -2..2; the fixture chunk (-3, -1) is fogged
const FRAME = { position: { x: -48, y: -16 }, radius: 3 }  // one crop frame for every comparison: chunks x -5..1, y -4..2
const letter = (crop, chunk) => crop.rows[chunk.y - crop.origin.chunk.y][chunk.x - crop.origin.chunk.x]
const FIXTURE_CHUNK = { x: -3, y: -1 }

function assertCropShape(crop, label) {
  assert.equal(crop.source, 'npc_map_knowledge', label)
  assert.equal(crop.surface_name, 'nauvis', label); assert.equal(crop.surface_index, 1, label)
  assert.deepEqual(crop.center_chunk, { x: -2, y: -1 }, label); assert.equal(crop.radius_chunks, 3, label)
  assert.deepEqual(crop.origin, { chunk: { x: -5, y: -4 }, tile: { x: -160, y: -128 } }, label)
  assert.equal(crop.rows.length, 7, label); for (const row of crop.rows) assert.match(row, /^[VFU]{7}$/, label)
  assert.equal(crop.counts.total, 49, label)
  assert.equal(crop.counts.visible + crop.counts.fogged + crop.counts.unknown, 49, label)
  assert.equal(crop.counts.visible, crop.rows.join('').split('V').length - 1, label)
  assert.ok(Number.isSafeInteger(crop.observed_tick) && Number.isSafeInteger(crop.revision), label)
  assert.ok(Number.isSafeInteger(crop.explored_record.outside_crop), label)
}
const refusedFor = (outcome, code) => JSON.stringify(outcome).includes(code)

async function prepare() {
  await configureNpcSession(rcon(), 'map-context-engine-20261027')
  actorId = (await deploymentStatus(rcon(), { requireAllowed: true })).actor_id
  assert.ok(Number.isInteger(actorId), 'the deployment names its standalone actor')

  // ---- fixture: a cleared pad in chunk (-3, -1), another force, another surface ----------------
  const fixture = await lua('remote.call("autorio_operations","cancel_all_tasks"); game.speed=1; s.always_day=true; '
    + 'for _,e in pairs(s.find_entities_filtered{area={{-96,-32},{-64,0}}}) do if e.type~="character" and e.name~="sgluna-npc-vision" then e.destroy() end end; '
    + 'local tiles={}; for x=-96,-65 do for y=-32,-1 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end; s.set_tiles(tiles,true,false,true); '
    + 'local visitor=game.forces["m3-visitor"] or game.create_force("m3-visitor"); '
    + 'local anchor=s.create_entity{name="wooden-chest",position={-75.5,-15.5},force=a.force}; '
    + 'local foreign=s.create_entity{name="wooden-chest",position={-70.5,-24.5},force=visitor}; '
    + 'for x=-82,-79 do for y=-9,-6 do s.create_entity{name="iron-ore",position={x+0.5,y+0.5},amount=400} end end; '
    + 'local other=game.surfaces["m3-elsewhere"] or game.create_surface("m3-elsewhere"); other.request_to_generate_chunks({0,0},1); other.force_generate_chunk_requests(); '
    + 'for _,e in pairs(other.find_entities_filtered{area={{-4,-4},{4,4}}}) do e.destroy() end; '
    + 'local elsewhere=other.create_entity{name="car",position={0.5,0.5},force=a.force}; '
    + 'inv.clear(); inv.insert{name="wooden-chest",count=10}; inv.insert{name="burner-mining-drill",count=2}; '
    + 'local p=s.find_non_colliding_position("character",{-48.5,-16.5},6,0.5); assert(p,"no start spot"); a.teleport(p); '
    + 'rcon.print(helpers.table_to_json({humans=#game.connected_players,anchor=anchor.unit_number,foreign=foreign.unit_number,elsewhere=elsewhere.unit_number,elsewhere_indexed=game.get_entity_by_unit_number(elsewhere.unit_number)~=nil,'
    + 'anchor_position=anchor.position,actor_force=a.force.name,start=a.position}))')
  assert.equal(fixture.humans, 0, 'zero humans')
  evidence.fixture = fixture
  await waitTicks(120)
  const startFacts = await sideEffects()
  assert.deepEqual(startFacts.window, { surface_index: 1, x: -2, y: -1 }, `the NPC window is around its own chunk: ${JSON.stringify(startFacts)}`)

  // ---- CROP -----------------------------------------------------------------------------------
  const crop0 = (await tool('getMapContext', FRAME)).crop
  assertCropShape(crop0, 'crop at start')
  for (let x = -4; x <= 0; x++) for (let y = -3; y <= 1; y++) assert.equal(letter(crop0, { x, y }), 'V', `chunk ${x},${y} is in the window`)
  for (let y = -4; y <= 2; y++) assert.notEqual(letter(crop0, { x: -5, y }), 'V', 'chunk x=-5 is outside the window')
  assert.equal(crop0.revision, startFacts.revision)
  evidence.crop_start = crop0
  console.log(`PASS: CROP - bounded 7x7 crop, surface nauvis, origin chunk (-5,-4), revision ${crop0.revision}, ${crop0.counts.visible} visible`)

  // ---- SELECTION while visible ---------------------------------------------------------------
  // Chests are not indexed by unit number in the engine; an observation read gives the harness its identity hint, as the
  // model's own reads do. A unit number the NPC never observed is simply not found.
  const seen = await tool('getNearbyEntities', { name: 'wooden-chest', radius: 32, limit: 8 })
  assert.ok(JSON.stringify(seen).includes(String(fixture.anchor)), `the observation names the anchor chest: ${JSON.stringify(seen).slice(0, 600)}`)
  const anchored = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.anchor }, radius: 4, limit: 4 })
  assert.equal(anchored.ok, true, JSON.stringify(anchored).slice(0, 2000))
  assert.ok(anchored.candidates.length > 0)
  assert.equal(anchored.map_context.revision, crop0.revision, 'the candidate answer carries the same revision')
  assert.equal(anchored.map_context.crop.surface_name, 'nauvis'); assert.equal(anchored.map_context.observed_tick, anchored.generated_tick)
  const chestPick = anchored.candidates[0]
  const drills = await tool('getPlacementCandidates', { entity_name: 'burner-mining-drill', target_resource: 'iron-ore', center: { x: -80, y: -7.5 }, radius: 4, limit: 2 })
  assert.equal(drills.ok, true, JSON.stringify(drills).slice(0, 2000)); assert.ok(drills.candidates.length > 0)
  const drillPick = drills.candidates[0]
  const planAt = { x: chestPick.position.x + 3, y: chestPick.position.y }
  const planTick = await tick()
  const plan = await tool('validateConstructionPlan', { plan_id: 'm3-fogged-plan', placements: [{ entity_name: 'wooden-chest', x: planAt.x, y: planAt.y }] })
  assert.equal(plan.ok, true, JSON.stringify(plan).slice(0, 2000))
  const sites = await tool('findConstructionSites', { width: 2, height: 2, anchor_unit_number: fixture.anchor, search_radius: 8 })
  assert.equal(sites.ok, true, JSON.stringify(sites).slice(0, 2000)); assert.equal(sites.search_complete, true)
  const foreignAnchor = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.foreign }, radius: 4, limit: 2 })
  assert.equal(foreignAnchor.ok, false); assert.ok(refusedFor(foreignAnchor, 'anchor_entity_not_found'), JSON.stringify(foreignAnchor))
  const elsewhereAnchor = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.elsewhere }, radius: 4, limit: 2 })
  assert.equal(elsewhereAnchor.ok, false); assert.ok(refusedFor(elsewhereAnchor, 'anchor_entity_not_found'), JSON.stringify(elsewhereAnchor))
  const elsewhereSites = await tool('findConstructionSites', { width: 2, height: 2, anchor_unit_number: fixture.elsewhere })
  assert.equal(elsewhereSites.ok, false)
  // The engine indexes few prototypes by unit number; only an indexed entity on another surface is recognised as one.
  assert.ok(refusedFor(elsewhereSites, fixture.elsewhere_indexed ? 'another surface' : 'anchor entity not found'), JSON.stringify(elsewhereSites))
  evidence.selection = { chest_pick: chestPick, candidate_set_id: anchored.candidate_set_id, drill_pick: drillPick, drill_set_id: drills.candidate_set_id,
    plan: { validation_id: plan.validation_id, at: planAt }, sites: sites.candidates, foreign: foreignAnchor, elsewhere: { candidates: elsewhereAnchor, sites: elsewhereSites } }
  console.log('PASS: SELECTION - anchored candidates, a drill on ore, a validated plan and a site search while visible; another force and another surface refused as anchors')

  // ---- BOUNDARY ------------------------------------------------------------------------------
  await walk('walk-one-boundary', ONE_OVER)
  const crop1 = (await tool('getMapContext', FRAME)).crop
  assertCropShape(crop1, 'crop after one boundary')
  assert.ok(crop1.revision > crop0.revision, `the window move bumps the revision (${crop0.revision} -> ${crop1.revision})`)
  assert.deepEqual(crop1.visible_window.chunk, { x: -1, y: -1 })
  for (let y = -3; y <= 1; y++) assert.equal(letter(crop1, { x: -4, y }), 'F', `chunk -4,${y} left the window and is fogged`)
  assert.equal(letter(crop1, FIXTURE_CHUNK), 'V', 'the fixture chunk is still in view')
  const stillAnchored = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.anchor }, radius: 4, limit: 2 })
  assert.equal(stillAnchored.ok, true, 'a fact still in view stays usable across the boundary')
  evidence.crop_one_boundary = crop1
  console.log(`PASS: BOUNDARY - one chunk east: window (-1,-1), revision ${crop0.revision}->${crop1.revision}, column x=-4 fogged, fixture chunk still visible`)

  // ---- MOVEMENT -------------------------------------------------------------------------------
  await walk('walk-out-of-view', FAR)
  const crop2 = (await tool('getMapContext', FRAME)).crop
  assertCropShape(crop2, 'crop out of view')
  assert.ok(crop2.revision > crop1.revision)
  assert.equal(letter(crop2, FIXTURE_CHUNK), 'F', 'the fixture chunk is explored but fogged')
  const here = await actorFacts()
  const before = await sideEffects()
  const stale = {}
  stale.place_candidate = await attempt('stale-candidate', { name: 'place_candidate', args: { candidate_set_id: anchored.candidate_set_id, candidate_id: chestPick.id } })
  stale.place_drill = await attempt('stale-drill', { name: 'place_candidate', args: { candidate_set_id: drills.candidate_set_id, candidate_id: drillPick.id } })
  stale.execute_plan = await attempt('stale-plan', { name: 'execute_construction_plan', args: { validation_id: plan.validation_id, placement_count: 1 } })
  for (const key of ['place_candidate', 'place_drill']) assert.ok(refusedFor(stale[key], 'placement_candidate_not_visible'), `${key}: ${JSON.stringify(stale[key])}`)
  assert.ok(refusedFor(stale.execute_plan, 'NOT_VISIBLE'), `execute_plan: ${JSON.stringify(stale.execute_plan)}`)
  stale.anchor = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.anchor }, radius: 4, limit: 2 })
  assert.ok(refusedFor(stale.anchor, 'anchor_not_visible'), JSON.stringify(stale.anchor))
  stale.sites = await tool('findConstructionSites', { width: 2, height: 2, anchor_unit_number: fixture.anchor })
  assert.ok(refusedFor(stale.sites, 'ANCHOR_NOT_VISIBLE'), JSON.stringify(stale.sites))
  stale.sites_at = await tool('findConstructionSites', { width: 2, height: 2, position: fixture.anchor_position, search_radius: 4 })
  assert.equal(stale.sites_at.ok, false); assert.equal(stale.sites_at.search_complete, false)
  assert.ok(refusedFor(stale.sites_at, 'SEARCH_INCOMPLETE_NOT_VISIBLE'), JSON.stringify(stale.sites_at))
  stale.local_area = await tool('getLocalSpatialObservation', { position: fixture.anchor_position, half_size: 6 })
  assert.ok(refusedFor(stale.local_area, 'area_not_visible'), JSON.stringify(stale.local_area))
  stale.local_anchor = await tool('getLocalSpatialObservation', { anchor_unit_number: fixture.anchor, half_size: 6 })
  assert.ok(refusedFor(stale.local_anchor, 'does not see now'), JSON.stringify(stale.local_anchor))
  // The world changes in the fog: the anchor and the ore are gone. Nothing the NPC reads may notice.
  await lua(`local e=game.get_entity_by_unit_number(${fixture.anchor}); if e then e.destroy() end; `
    + 'for _,r in pairs(s.find_entities_filtered{area={{-82,-9},{-78,-5}},name="iron-ore"}) do r.destroy() end; rcon.print("{}")')
  stale.anchor_destroyed = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: fixture.anchor }, radius: 4, limit: 2 })
  stale.sites_destroyed = await tool('findConstructionSites', { width: 2, height: 2, anchor_unit_number: fixture.anchor })
  assert.equal(stale.anchor_destroyed.code ?? stale.anchor_destroyed.error?.code, stale.anchor.code ?? stale.anchor.error?.code, 'a destroyed anchor in the fog reads exactly like a standing one')
  assert.equal(stale.sites_destroyed.error.code, 'ANCHOR_NOT_VISIBLE')
  const after = await sideEffects()
  const afterActor = await actorFacts()
  assert.ok(Math.hypot(afterActor.x - here.x, afterActor.y - here.y) < 0.5, 'no stale refusal walked the NPC')
  assert.equal(afterActor.chests, here.chests); assert.equal(afterActor.drills, here.drills)
  assert.deepEqual({ ...after, standing: undefined }, { ...before, standing: undefined }, 'no read charted, generated, explored or reserved anything')
  assert.equal(after.standing, before.standing - 1 - 16, 'the only change in the fixture chunk is the anchor and ore removed by the fixture')
  evidence.movement = { crop: crop2, before, after, stale }
  console.log(`PASS: MOVEMENT - out of view (revision ${crop2.revision}): stale candidate, drill and plan refused at the boundary; anchor, site search and local observation not visible; fog removal unnoticed; no side effects`)

  // ---- save -------------------------------------------------------------------------------------
  await fs.writeFile(statePath, JSON.stringify({ actorId, fixture, anchored: anchored.candidate_set_id, chestPick, drills: drills.candidate_set_id, drillPick,
    plan: plan.validation_id, planTick, planAt, crop2, sideEffects: after }, null, 2))
  const save = arg('save'); const old = await fs.stat(save)
  await command('/silent-command game.server_save()')
  const deadline = Date.now() + 30000
  while ((await fs.stat(save)).mtimeMs <= old.mtimeMs) { assert.ok(Date.now() < deadline, 'the server save was written'); await delay(100) }
  console.log('PASS: prepared - knowledge, candidate sets and the validated plan saved with game.server_save()')
}

async function verify() {
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'))
  await configureNpcSession(rcon(), 'map-context-engine-20261027-verify')
  actorId = (await deploymentStatus(rcon(), { requireAllowed: true })).actor_id
  assert.equal(actorId, saved.actorId, 'the same standalone actor after the restart')
  const facts = await actorFacts()
  assert.equal(facts.humans, 0)

  // ---- RELOAD -----------------------------------------------------------------------------------
  const crop = (await tool('getMapContext', FRAME)).crop
  assertCropShape(crop, 'crop after restart')
  assert.deepEqual(crop.rows, saved.crop2.rows, 'the crop is the same after the restart')
  assert.equal(crop.revision, saved.crop2.revision, 'the revision persisted and nothing moved the window')
  assert.deepEqual(crop.visible_window, saved.crop2.visible_window)
  const reloaded = {}
  reloaded.place_candidate = await attempt('reload-stale-candidate', { name: 'place_candidate', args: { candidate_set_id: saved.anchored, candidate_id: saved.chestPick.id } })
  reloaded.execute_plan = await attempt('reload-stale-plan', { name: 'execute_construction_plan', args: { validation_id: saved.plan, placement_count: 1 } })
  assert.ok(refusedFor(reloaded.place_candidate, 'placement_candidate_not_visible'), JSON.stringify(reloaded.place_candidate))
  // A validation lives 3600 ticks (VALIDATION_MAX_AGE_TICKS). Inside that it must be refused as not visible; past it the
  // expiry check comes first, so the visibility gate is proven at validation time instead.
  const planAge = (await tick()) - saved.planTick
  if (planAge <= 3600) assert.ok(refusedFor(reloaded.execute_plan, 'NOT_VISIBLE'), JSON.stringify(reloaded.execute_plan))
  else assert.ok(refusedFor(reloaded.execute_plan, 'construction_plan_expired'), JSON.stringify(reloaded.execute_plan))
  reloaded.plan_age_ticks = planAge
  reloaded.revalidate = await tool('validateConstructionPlan', { plan_id: 'm3-reload-fogged', placements: [{ entity_name: 'wooden-chest', x: saved.planAt.x, y: saved.planAt.y }] })
  assert.equal(reloaded.revalidate.ok, false); assert.ok(refusedFor(reloaded.revalidate, 'NOT_VISIBLE'), JSON.stringify(reloaded.revalidate))
  evidence.reload = { crop, reloaded }
  console.log(`PASS: RELOAD - after a real restart the crop and revision ${crop.revision} persist; the stale candidate and plan are still refused`)

  // ---- RETURN -----------------------------------------------------------------------------------
  await walk('walk-back', START)
  const back = (await tool('getMapContext', FRAME)).crop
  assert.equal(letter(back, FIXTURE_CHUNK), 'V'); assert.ok(back.revision > crop.revision)
  const before = await sideEffects()
  const returned = {}
  returned.anchor = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: saved.fixture.anchor }, radius: 4, limit: 2 })
  assert.ok(refusedFor(returned.anchor, 'anchor_entity_not_found'), `seen again, the destroyed anchor is not found: ${JSON.stringify(returned.anchor)}`)
  returned.sites = await tool('findConstructionSites', { width: 2, height: 2, anchor_unit_number: saved.fixture.anchor })
  assert.equal(returned.sites.error.code, 'INVALID_ANCHOR')
  const drillsBefore = await actorFacts()
  returned.place_drill = await attempt('return-stale-drill', { name: 'place_candidate', args: { candidate_set_id: saved.drills, candidate_id: saved.drillPick.id } })
  assert.ok(!refusedFor(returned.place_drill, 'not_visible'), 'visibility is no longer the reason')
  assert.ok(returned.place_drill.refused_at_submission || returned.place_drill.result?.completed !== true, `a drill candidate whose ore was mined away does not place: ${JSON.stringify(returned.place_drill)}`)
  assert.equal((await actorFacts()).drills, drillsBefore.drills, 'no drill was placed')
  returned.foreign = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', anchor: { unit_number: saved.fixture.foreign }, radius: 4, limit: 2 })
  assert.ok(refusedFor(returned.foreign, 'anchor_entity_not_found'), JSON.stringify(returned.foreign))
  const after = await sideEffects()
  assert.equal(after.charted, before.charted); assert.equal(after.generated, before.generated); assert.equal(after.explored, before.explored)
  assert.equal(after.revision, before.revision); assert.equal(after.reservations, before.reservations)
  // The positive control: a fresh plan where the NPC sees now validates and builds.
  const fresh = await tool('validateConstructionPlan', { plan_id: 'm3-fresh-plan', placements: [{ entity_name: 'wooden-chest', x: saved.planAt.x, y: saved.planAt.y }] })
  assert.equal(fresh.ok, true, JSON.stringify(fresh).slice(0, 2000))
  const chestsBefore = (await actorFacts()).chests
  returned.fresh_plan = await attempt('return-fresh-plan', { name: 'execute_construction_plan', args: { validation_id: fresh.validation_id, placement_count: 1 } })
  assert.equal(returned.fresh_plan.refused_at_submission, false, JSON.stringify(returned.fresh_plan))
  assert.equal(returned.fresh_plan.result?.completed, true, JSON.stringify(returned.fresh_plan))
  const built = await lua(`rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{name="wooden-chest",position={${saved.planAt.x},${saved.planAt.y}},radius=0.6}}))`)
  assert.equal(built.count, 1, 'the fresh plan built its chest')
  assert.equal((await actorFacts()).chests, chestsBefore - 1, 'from the NPC inventory')
  evidence.return = { crop: back, before, after, returned }
  console.log('PASS: RETURN - visible again: the destroyed anchor is not found, the mined-out drill candidate does not place, a fresh plan builds from inventory')
}

try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  const ready = Date.now() + 30000
  for (;;) {
    try { await connection.connect(); break }
    catch (error) { connection.close(); if (Date.now() >= ready) throw error; await delay(200) }
  }
  assert.match(await command('/version'), /2\.0\.77/)
  if (phase === 'prepare') await prepare()
  else await verify()
  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, `map-context-${phase}-error.txt`), `${error?.stack ?? error}\n`)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, `map-context-${phase}.json`), JSON.stringify({ evidence, transcript }, null, 2))
  connection?.close()
}
