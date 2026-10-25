#!/usr/bin/env node
// Deterministic native contract proof. Fixture-only entities/stock, zero humans,
// 1x speed, no inference. Production growth may change inventories while the
// preservation projection stays stable; native rotation/force/surface/identity
// changes must not pass that projection.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand, parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { preservationGeometry, preservedProofMatches } from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', source: 'native_exact_geometry', transcript: [] }
let connection
const rcon = { command: async command => {
  const response = await connection.command(command)
  evidence.transcript.push({ command, response })
  return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a; for _,s in pairs(game.surfaces) do local chars=s.find_entities_filtered{name="character"}; if #chars>0 then a=chars[1]; break end end; assert(a); ${body}`))
const geometry = async id => JSON.parse(await rcon.command(toolCommand('getEntityGeometry', { unit_number: id })))
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  await configureNpcSession(rcon, 'contract-obligation-engine-20261025')
  const version = JSON.parse(await fsp.readFile('/opt/factorio/data/base/info.json', 'utf8')).version
  assert.equal(version, '2.0.77')
  evidence.factorio_version = version
  const fixture = await lua(`local s=a.surface; local ox=math.floor(a.position.x)+16; local oy=math.floor(a.position.y); game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{ox-4,oy-4},{ox+10,oy+6}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={}; for x=ox-4,ox+10 do for y=oy-4,oy+6 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);
    local f=s.create_entity{name="stone-furnace",position={ox+4,oy},force=a.force};
    for x=ox+4,ox+5 do for y=oy+1,oy+2 do s.create_entity{name="iron-ore",position={x+0.5,y+0.5},amount=1000} end end;
    local d=s.create_entity{name="burner-mining-drill",position={ox+5,oy+2},direction=defines.direction.north,force=a.force}; assert(f and d);
    a.get_main_inventory().clear(); assert(a.insert{name="coal",count=2}==2);
    storage.contract_obligation_fixture={f=f,d=d,x=a.position.x,y=a.position.y,s=s};
    remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100);
    rcon.print(helpers.table_to_json({furnace=f.unit_number,drill=d.unit_number,actor=a.unit_number,surface=s.index,force=a.force.index,humans=#game.connected_players,speed=game.speed,
      unfueled_drill=remote.call("autorio_knowledge","entity_geometry",d.unit_number),unfueled_furnace=remote.call("autorio_knowledge","entity_geometry",f.unit_number),iron_plates=f.get_item_count("iron-plate")}))`)
  evidence.fixture = fixture
  assert.equal(fixture.humans, 0)
  assert.equal(fixture.speed, 1)
  assert.equal(fixture.iron_plates, 0)
  const unfueled = { intent_signature: 'native-bootstrap', actor_id: fixture.actor, actor_epoch: 1,
    preserved: [preservationGeometry(fixture.unfueled_furnace, fixture.furnace), preservationGeometry(fixture.unfueled_drill, fixture.drill)] }
  assert.equal(unfueled.preserved[1].item_io.drop_target, null, 'native bootstrap begins with a genuinely unresolved lazy target')
  const fuelingActor = await deploymentStatus(rcon, { requireAllowed: true })
  await executeAuthorizedBatch(rcon, fuelingActor.epoch, [fixture.drill, fixture.furnace].map(unit_number =>
    renderOperation(parseOperation({ name: 'supply_entity', args: { unit_number, items: [{ item_name: 'coal', count: 1 }] } }))))
  const deadline = Date.now() + 25000
  let produced = 0
  while (Date.now() < deadline) {
    produced = await lua('rcon.print(storage.contract_obligation_fixture.f.get_item_count("iron-plate"))')
    if (produced > 0) break
    await delay(100)
  }
  assert.ok(produced > 0, 'native direct-feed mining/smelting must actually produce an iron plate')
  const before = preservationGeometry(await geometry(fixture.drill), fixture.drill)
  const furnace = preservationGeometry(await geometry(fixture.furnace), fixture.furnace)
  assert.equal(before.actor_id, fixture.actor)
  assert.equal(before.surface_index, fixture.surface)
  assert.equal(before.force_index, fixture.force)
  assert.equal(before.item_io.drop_target.unit_number, fixture.furnace)
  assert.equal(furnace.entity.unit_number, fixture.furnace)
  const producing = { ...unfueled, preserved: [furnace, before] }
  assert.equal(preservedProofMatches(unfueled, producing), true, 'only fresh native target resolution to the existing preserved furnace refines unknown')
  assert.equal(preservedProofMatches(producing, unfueled), false, 'resolved native knowledge cannot regress to unknown')
  evidence.bootstrap = { unfueled, producing, first_action: 'two_native_supply_entity_operations', output_before_first_fuel: 0 }
  const initialOutput = produced
  while (produced === initialOutput && Date.now() < deadline) {
    await delay(100)
    produced = await lua('rcon.print(storage.contract_obligation_fixture.f.get_item_count("iron-plate"))')
  }
  assert.ok(produced > initialOutput, 'additional normal native production must occur between geometry samples')
  assert.deepEqual(preservationGeometry(await geometry(fixture.drill), fixture.drill), before, 'normal native production preserves geometry')
  evidence.production = { iron_plates: produced, geometry: before }
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation({ name: 'rotate_entity', args: { unit_number: fixture.drill } }))])
  for (let n = 0; n < 100; n++) {
    const status = JSON.parse(await rcon.command(toolCommand('getTaskStatus', {})))
    if (status.task_state === 'idle' && status.queue_length === 0) break
    await delay(50)
  }
  const rotated = await geometry(fixture.drill)
  assert.notEqual(rotated.entity.direction, before.entity.direction, 'the native drill really rotated')
  assert.equal(preservedProofMatches(producing, { ...producing, preserved: [furnace, preservationGeometry(rotated, fixture.drill)] }), false,
    'rotation/lost target cannot replace already-established native preservation')
  evidence.rotated = rotated
  await lua('storage.contract_obligation_fixture.f.force=game.forces.enemy; rcon.print("{}")')
  const foreign = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(foreign, fixture.furnace), /preservation_geometry_unproven/)
  evidence.foreign = foreign
  await lua('local v=storage.contract_obligation_fixture; v.f.force=a.force; remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100); local other=game.create_surface("obligation-other",{width=32,height=32}); other.request_to_generate_chunks({0,0},1); other.force_generate_chunk_requests(); local tiles={}; for x=-3,3 do for y=-3,3 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; other.set_tiles(tiles,true,false,true); assert(a.teleport({0,0},other)); rcon.print("{}")')
  const away = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(away, fixture.furnace), /preservation_geometry_unproven/)
  evidence.other_surface = away
  await lua('local v=storage.contract_obligation_fixture; assert(a.teleport({v.x,v.y},v.s)); local p=v.f.position; v.f.destroy(); v.replacement=v.s.create_entity{name="stone-furnace",position=p,force=a.force}; assert(v.replacement); rcon.print("{}")')
  const stale = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(stale, fixture.furnace), /preservation_geometry_unproven/)
  evidence.stale = stale
  evidence.status = 'pass'
  console.log('PASS native 2.0.77 obligation geometry: production, item route, rotation, force/surface and stale identity')
} finally {
  if (connection) {
    try { await lua('local v=storage.contract_obligation_fixture; if v then if a.surface~=v.s then a.teleport({v.x,v.y},v.s) end; for _,e in pairs({v.f,v.d,v.replacement}) do if e and e.valid then e.destroy() end end end; local other=game.get_surface("obligation-other"); if other then game.delete_surface(other) end; rcon.print("{}")') } catch (error) { evidence.cleanup_error = error.message }
    connection.close()
  }
  await fsp.mkdir(results, { recursive: true })
  await fsp.writeFile(path.join(results, 'contract-obligation-geometry.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
