#!/usr/bin/env node
// Offline native facts only. Fixture terrain/stock are declared setup; every
// construction/fuel action uses normal epoch-checked operations at 1x, no model.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand, parseOperation, renderOperation, renderOperationPreflight, luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { preservationGeometry, preservedProofMatches } from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in fluid preservation fixture') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const evidence = { status: 'fail', factorio: '2.0.77', transcript: [], operations: [] }
let connection
const rcon = { command: async command => { const response = await connection.command(command); evidence.transcript.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a; for _,s in pairs(game.surfaces) do local c=s.find_entities_filtered{name="character"}; if #c>0 then a=c[1]; break end end; assert(a); ${body}`))
const tool = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const geometry = id => tool('getEntityGeometry', { unit_number: id })
async function operation(name, args) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const admission = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation({ name, args }))])
  evidence.operations.push({ name, args, admission })
  const deadline = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) {
      const result = status.basic_operation?.last_result
      assert.equal(result?.completed, true, JSON.stringify(status)); return result
    }
    assert.ok(Date.now() < deadline, `native ${name} timeout`); await delay(100)
  }
}
async function place(name, request, before) {
  const set = await tool('getPlacementCandidates', { entity_name: name, limit: 8, ...request })
  evidence.candidates ??= []; evidence.candidates.push(set)
  assert.ok(set.candidates?.length, `no native ${name} candidate`)
  const candidate = set.candidates[0]
  const args = { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id }
  const preflight = JSON.parse(await rcon.command(renderOperationPreflight({ name: 'place_candidate', args })))
  let preservedBefore
  if (request.connects_to) assert.equal(preflight.preservation_join?.complete, true, JSON.stringify(preflight))
  if (request.connects_to) {
    const guard = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_preflight","fluid_preservation_candidate",${luaString(args.candidate_set_id)},${luaString(args.candidate_id)},${luaString(`native-fixture/${evidence.operations.length}`)},{${request.connects_to.unit_number}})))`)
    assert.equal(guard.ok, true, JSON.stringify(guard)); preflight.preservation_join = guard.preservation_join
    preservedBefore = preservationGeometry(guard.preservation_join.protected_geometry.find(row => row.entity.unit_number === request.connects_to.unit_number), request.connects_to.unit_number)
  }
  if (before) await before(preflight.preservation_join)
  const result = await operation('place_candidate', args)
  assert.ok(result.placed_unit_number)
  if (preservedBefore) {
    const fresh = preservationGeometry(await geometry(request.connects_to.unit_number), request.connects_to.unit_number)
    const join = preflight.preservation_join.connects_to
    const port = fresh.fluid.storages.find(row => row.index === join.target_port.storage_index).ports.find(row => row.index === join.target_port.connection_index)
    const pair = row => ({ actor_id: row.actor_id, actor_epoch: 1, intent_signature: 'native-addition', preserved: [row] })
    assert.equal(preservedProofMatches(pair(preservedBefore), pair(fresh), { addition: { source_unit_number: join.unit_number,
      source_storage_index: join.target_port.storage_index, source_connection_index: join.target_port.connection_index, endpoint: port.target } }), true,
    JSON.stringify({ message: 'every allowed native additive output must preserve old layout/edges/constraints', preservedBefore, fresh }))
  }
  return { result, candidate, preflight }
}
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); await connection.connect()
  assert.equal(JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json', 'utf8')).version, '2.0.77')
  await configureNpcSession(rcon, 'fluid-preservation-native-20261025')
  evidence.setup = await lua(`local s=a.surface; local ox=math.floor(a.position.x)+20; local oy=math.floor(a.position.y); game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{ox-14,oy-16},{ox+26,oy+20}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={}; for x=ox-14,ox+26 do for y=oy-16,oy+20 do tiles[#tiles+1]={name=x<ox and "water" or "landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);
    storage.fluid_preservation_fixture={x=a.position.x,y=a.position.y,ox=ox,oy=oy,s=s}; assert(a.teleport({ox+5,oy},s)); a.get_main_inventory().clear();
    for _,item in pairs({{"offshore-pump",1},{"boiler",1},{"steam-engine",1},{"pipe",2},{"coal",5}}) do assert(a.insert{name=item[1],count=item[2]}==item[2]) end;
    rcon.print(helpers.table_to_json({center={x=ox,y=oy},actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(evidence.setup.humans, 0); assert.equal(evidence.setup.speed, 1)
  evidence.water = await tool('getFluidSourceTiles', { fluid_name: 'water', search_radius: 16, limit: 8 })
  assert.ok(evidence.water.samples?.length)
  const pump = await place('offshore-pump', { center: evidence.setup.center, radius: 8 })
  const pumpId = pump.result.placed_unit_number
  const open = preservationGeometry(await geometry(pumpId), pumpId)
  evidence.open = open
  assert.equal(open.fluid.storages[0].ports.some(port => port.connected), false)
  // A delayed, already-queued placement must revalidate at native mutation,
  // after host admission/freeze. The wait is fixture fault scheduling only;
  // production typed-fluid admission still allows exactly one placement/batch.
  const delayedSet = await tool('getPlacementCandidates', { entity_name: 'boiler', connects_to: { unit_number: pumpId }, limit: 8 })
  assert.ok(delayedSet.candidates?.length)
  const delayedCandidate = delayedSet.candidates[0]
  const delayedArgs = { candidate_set_id: delayedSet.candidate_set_id, candidate_id: delayedCandidate.id }
  const delayedGuard = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_preflight","fluid_preservation_candidate",${luaString(delayedArgs.candidate_set_id)},${luaString(delayedArgs.candidate_id)},"native-fixture/delayed",{${pumpId}})))`)
  assert.equal(delayedGuard.ok, true, JSON.stringify(delayedGuard))
  const otherPort = delayedGuard.preservation_join.candidate_ports.find(port => port.storage_index === 1
    && port.connection_index !== delayedCandidate.connects_to.candidate_port.connection_index)
  assert.ok(otherPort)
  const offset = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }[otherPort.direction]
  const delayedOwner = await deploymentStatus(rcon, { requireAllowed: true })
  await executeAuthorizedBatch(rcon, delayedOwner.epoch, [renderOperation(parseOperation({ name: 'wait', args: { ticks: 120 } })),
    renderOperation(parseOperation({ name: 'place_candidate', args: delayedArgs }))])
  evidence.late_neighbour = await lua(`local e=a.surface.create_entity{name="pipe",position={${otherPort.position.x + offset[0]},${otherPort.position.y + offset[1]}},force=a.force}; assert(e); storage.fluid_preservation_late=e; rcon.print(helpers.table_to_json({unit_number=e.unit_number,created_at_tick=game.tick}))`)
  const guardDeadline = Date.now() + 30000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) { evidence.delayed_refusal = status; break }
    assert.ok(Date.now() < guardDeadline); await delay(100)
  }
  assert.equal(evidence.delayed_refusal.basic_operation?.last_result?.code, 'placement_candidate_unavailable')
  assert.equal(evidence.delayed_refusal.basic_operation.last_result.completed, false)
  evidence.delayed_world = await lua('rcon.print(helpers.table_to_json({boilers=a.surface.count_entities_filtered{name="boiler"},held=a.get_main_inventory().get_item_count("boiler")}))')
  assert.equal(evidence.delayed_world.boilers, 0); assert.equal(evidence.delayed_world.held, 1)
  assert.deepEqual(preservationGeometry(await geometry(pumpId), pumpId), open)
  await lua('assert(storage.fluid_preservation_late.valid); storage.fluid_preservation_late.destroy(); rcon.print("{}")')
  const boiler = await place('boiler', { connects_to: { unit_number: pumpId } })
  assert.equal(boiler.preflight.preservation_join?.complete, true, JSON.stringify(boiler.preflight))
  const boilerId = boiler.result.placed_unit_number
  const joined = preservationGeometry(await geometry(pumpId), pumpId)
  const boilerRaw = await geometry(boilerId)
  const boilerProof = preservationGeometry(boilerRaw, boilerId)
  assert.deepEqual(boilerProof.fluid.storages.flatMap(row => row.prototypes), boiler.preflight.preservation_join.candidate_storages.map(row => ({
    index: row.index, production_type: row.production_type, filter: row.filter ?? null,
    minimum_temperature: row.minimum_temperature ?? null, maximum_temperature: row.maximum_temperature ?? null })))
  const witness = boiler.preflight.preservation_join.connects_to
  const port = joined.fluid.storages.find(row => row.index === witness.target_port.storage_index).ports.find(row => row.index === witness.target_port.connection_index)
  assert.equal(port.target.entity.unit_number, boilerId)
  const reciprocal = boilerProof.fluid.storages.find(row => row.index === witness.candidate_port.storage_index).ports.find(row => row.index === witness.candidate_port.connection_index)
  assert.equal(reciprocal.target.entity.unit_number, pumpId)
  const pair = row => ({ actor_id: evidence.setup.actor, actor_epoch: 1, intent_signature: 'native-facts', preserved: [row] })
  assert.equal(preservedProofMatches(pair(open), pair(joined)), false)
  const addition = { source_unit_number: pumpId, source_storage_index: witness.target_port.storage_index,
    source_connection_index: witness.target_port.connection_index, endpoint: port.target }
  assert.equal(preservedProofMatches(pair(open), pair(joined), { addition }), true)
  evidence.additive = { preflight: boiler.preflight, receipt: boiler.result, joined, boiler: boilerProof }
  const steam = boilerProof.fluid.storages.find(row => row.prototypes.some(p => p.filter === 'steam'))
  assert.ok(steam, JSON.stringify(boilerRaw))
  const pipe = await place('pipe', { connects_to: { unit_number: boilerId, storage_index: steam.index } })
  assert.equal(pipe.preflight.preservation_join?.complete, true, JSON.stringify(pipe.preflight))
  const pipeId = pipe.result.placed_unit_number
  const engine = await place('steam-engine', { connects_to: { unit_number: pipeId } })
  assert.equal(engine.preflight.preservation_join?.complete, true, JSON.stringify(engine.preflight))
  const engineId = engine.result.placed_unit_number
  await operation('supply_entity', { unit_number: boilerId, items: [{ item_name: 'coal', count: 1 }] })
  const deadline = Date.now() + 30000
  for (;;) {
    const raw = await geometry(engineId)
    if (raw.fluid_storages.some(row => row.current_fluid?.name === 'steam' && row.current_fluid.amount > 0)) { evidence.production = raw; break }
    assert.ok(Date.now() < deadline, 'normal unfueled→first fuel must produce actual steam'); await delay(100)
  }
  assert.deepEqual(preservationGeometry(await geometry(pumpId), pumpId), joined, 'production counters do not change protected pump topology')
  evidence.pipe = preservationGeometry(await geometry(pipeId), pipeId)
  evidence.engine = preservationGeometry(await geometry(engineId), engineId)
  await lua(`local s=a.surface; local e; for _,v in pairs(s.find_entities_filtered{name="boiler"}) do if v.unit_number==${boilerId} then e=v end end; assert(e); e.destroy(); rcon.print("{}")`)
  assert.equal(preservedProofMatches(pair(joined), pair(preservationGeometry(await geometry(pumpId), pumpId))), false, 'removing the receiver cannot erase an established edge')
  await lua(`for _,v in pairs(a.surface.find_entities_filtered{name="offshore-pump"}) do if v.unit_number==${pumpId} then v.force=game.forces.enemy end end; rcon.print("{}")`)
  assert.throws(() => preservationGeometry(evidence.open, pumpId)) // a stored projection is never a fresh native response
  assert.throws(() => preservationGeometry({ ...evidence.production, actor_force_index: -1 }, engineId))
  assert.throws(() => preservationGeometry({ ...evidence.production, fluid_storages_truncated: true }, engineId))
  evidence.foreign = await geometry(pumpId)
  assert.throws(() => preservationGeometry(evidence.foreign, pumpId))
  evidence.status = 'pass'
  console.log('PASS native2.0.77 fluid preservation: empty pump, exact boiler/pipe/engine joins, first-fuel steam and lost-edge/scope refusal')
} finally {
  if (connection) connection.close()
  await fs.mkdir(path.resolve(arg('results')), { recursive: true })
  await fs.writeFile(path.join(path.resolve(arg('results')), 'fluid-preservation-native.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
