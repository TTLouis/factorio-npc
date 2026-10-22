// Native reversible reservation proof; no providers, Jev or corrective prompts.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { renderOperation, toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'

globalThis.fetch = async () => { throw new Error('Inference forbidden in reservation native proof') }
const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0); return process.argv[at + 1] }
const phase = arg('phase')
const results = path.resolve(arg('results'))
const rcon = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
const trace = []
const command = async text => { const output = await rcon.command(text); trace.push({ text, output }); return output }
const lua = async body => { const out = await command(`/silent-command ${body}`); try { return JSON.parse(out) } catch { throw new Error(`Native JSON failed: ${out}`) } }
const read = async (name, args) => JSON.parse(await command(toolCommand(name, args)))
const call = (fn, args = '') => lua(`rcon.print(helpers.table_to_json(remote.call('autorio_reservations',${JSON.stringify(fn)}${args ? `,${args}` : ''})))`)
const summary = id => call('status', String(id)).then(out => out.reservations[0])
const state = () => lua(`local t=storage.reservation_proof;local s=game.surfaces[t.surface];local function item(e,i) return e.get_inventory(i).get_contents() end;local ch=s.find_entities_filtered{name='wooden-chest',position=t.chest}[1];local f=s.find_entities_filtered{name='stone-furnace',position=t.furnace}[1];rcon.print(helpers.table_to_json({humans=#game.connected_players,tile=s.get_tile(t.x,t.y).name,hidden=s.get_tile(t.x,t.y).hidden_tile,double_hidden=s.get_tile(t.x,t.y).double_hidden_tile,chest=ch and {unit=ch.unit_number,items=item(ch,defines.inventory.chest),blueprint_label=ch.get_inventory(defines.inventory.chest)[2].label},furnace=f and {unit=f.unit_number,progress=f.crafting_progress,fuel=item(f,defines.inventory.fuel),source=item(f,defines.inventory.furnace_source),output=item(f,defines.inventory.furnace_result)},vault=game.surfaces['sgluna-reservation-'..t.id]~=nil}))`)
async function reserve(id, revision) {
  const identity = await deploymentStatus(rcon, { requireAllowed: true })
  const result = await executeAuthorizedBatch(rcon, identity.epoch, [renderOperation({ name: 'reserve_construction_area', args: { reservation_id: id, revision } })])
  assert.equal(result.results[0][0], true)
  return summary(id)
}
try {
  await fs.mkdir(results, { recursive: true })
  const readyDeadline = Date.now() + 30000
  for (;;) {
    try { await rcon.connect(); break }
    catch (error) { rcon.close(); if (Date.now() >= readyDeadline) throw error; await delay(200) }
  }
  assert.match(await command('/version'), /2\.0\.77/)
  if (phase === 'prepare') {
    await configureNpcSession(rcon, 'reservation-native-20261022')
    const actor = (await deploymentStatus(rcon, { requireAllowed: true })).actor_id
    const setup = await lua(`local a=game.get_entity_by_unit_number(${actor});local s=a.surface;remote.call('autorio_operations','cancel_all_tasks');game.speed=1;local x=math.floor(a.position.x)+6;local y=math.floor(a.position.y)-4;local box={{x-2,y-2},{x+16,y+12}};for _,e in pairs(s.find_entities_filtered{area=box}) do if e.type~='character' and e.name~='sgluna-npc-vision' then e.destroy() end end;local tiles={};for xx=x-2,x+16 do for yy=y-2,y+12 do tiles[#tiles+1]={name='grass-1',position={xx,yy}} end end;s.set_tiles(tiles,true,false,false);s.set_hidden_tile({x,y},'landfill');s.set_double_hidden_tile({x,y},'water');local chest={x=x+1.5,y=y+2.5};local furnace={x=x+5,y=y+3};local ch=s.create_entity{name='wooden-chest',position=chest,force=a.force};ch.insert{name='iron-plate',count=17};ch.get_inventory(defines.inventory.chest)[2].set_stack{name='blueprint'};ch.get_inventory(defines.inventory.chest)[2].label='Native state proof';local f=s.create_entity{name='stone-furnace',position=furnace,force=a.force};f.active=false;f.insert{name='coal',count=3};f.get_inventory(defines.inventory.furnace_source).insert{name='iron-ore',count=5};f.get_inventory(defines.inventory.furnace_result).insert{name='iron-plate',count=2};f.crafting_progress=0.25;a.force.chart(s,box);storage.reservation_proof={actor=${actor},surface=s.name,x=x,y=y,chest=chest,furnace=furnace};rcon.print(helpers.table_to_json({x=x,y=y,humans=#game.connected_players}))`)
    assert.equal(setup.humans, 0)
    // Let the engine select the furnace recipe before freezing a legitimate
    // in-progress state. Inserting into an inactive, recipe-less furnace creates
    // an inconsistent fixture that native clone correctly normalizes.
    await lua(`local t=storage.reservation_proof;game.surfaces[t.surface].find_entities_filtered{name='stone-furnace',position=t.furnace}[1].active=true;rcon.print('{}')`)
    await delay(150)
    await lua(`local t=storage.reservation_proof;local f=game.surfaces[t.surface].find_entities_filtered{name='stone-furnace',position=t.furnace}[1];f.active=false;f.crafting_progress=0.25;assert(f.get_recipe(),'engine selected recipe');rcon.print('{}')`)
    const proposed = await read('validateConstructionReservation', { goal_id: 'native-goal', plan_id: 'native-plan', x: setup.x, y: setup.y, width: 10, height: 8 })
    assert.equal(proposed.ok, true, JSON.stringify(proposed))
    const id = proposed.reservation_id
    await lua(`storage.reservation_proof.id=${id};rcon.print('{}')`)
    const before = await state(); await fs.writeFile(path.join(results, 'before.json'), JSON.stringify(before))
    assert.equal((await reserve(id, 1)).state, 'reserved')
    const during = await state()
    assert.equal(during.tile, 'sgluna-reserved-area'); assert.equal(during.chest, undefined); assert.equal(during.furnace, undefined); assert.equal(during.vault, true)
    const blocked = await lua(`local t=storage.reservation_proof;local a=game.get_entity_by_unit_number(t.actor);local s=a.surface;local out={};for _,name in pairs({'wooden-chest','transport-belt','small-electric-pole','pipe','stone-furnace','inserter','straight-rail'}) do out[name]=s.can_place_entity{name=name,position={t.x+5,t.y+4},force=a.force,build_check_type=defines.build_check_type.manual} end;rcon.print(helpers.table_to_json(out))`)
    for (const [name, placeable] of Object.entries(blocked)) assert.equal(placeable, false, `${name} cannot build on reservation`)
    assert.equal((await call('designer_input', `${id},1`)).ok, true)
    assert.equal((await call('designer_returned', `${id},2,'stale'`)).ok, false)
    await fs.writeFile(path.join(results, 'during.json'), JSON.stringify({ during, blocked, proposed }))
    const save = arg('save'); const old = await fs.stat(save)
    await command('/silent-command game.server_save()')
    const deadline = Date.now() + 30000
    while ((await fs.stat(save)).mtimeMs <= old.mtimeMs) { assert.ok(Date.now() < deadline, 'reservation save'); await delay(100) }
  }
  else {
    const saved = await lua(`rcon.print(helpers.table_to_json(storage.reservation_proof))`)
    assert.equal((await summary(saved.id)).state, 'reserved', 'reservation survives pristine process restart')
    assert.equal((await call('designer_returned', `${saved.id},1,'native-design-1'`)).ok, true)
    const after = await state(); const before = JSON.parse(await fs.readFile(path.join(results, 'before.json'), 'utf8'))
    assert.equal(after.tile, before.tile); assert.equal(after.hidden, before.hidden); assert.equal(after.double_hidden, before.double_hidden); assert.equal(after.vault, false)
    assert.deepEqual(after.chest.items, before.chest.items); assert.equal(after.chest.blueprint_label, before.chest.blueprint_label)
    for (const k of ['progress', 'fuel', 'source', 'output']) assert.deepEqual(after.furnace[k], before.furnace[k], k)
    assert.notEqual(after.chest.unit, before.chest.unit); assert.equal((await summary(saved.id)).identity_map.length, 2)
    const autoStatus = await summary(saved.id)
    // Headless engine fixtures cannot manufacture a LuaPlayer. Mode selection
    // here is trusted fixture setup; real native UI approval is covered by the
    // contract tests. No approval capability is added to the inference catalog.
    await lua(`remote.call('reservation_test_fixture','mode','review');rcon.print('{}')`)
    const proposal = await read('validateConstructionReservation', { goal_id: 'review-goal', plan_id: 'review-plan', x: saved.x, y: saved.y, width: 10, height: 8 })
    assert.equal(proposal.ok, true)
    const reviewId = proposal.reservation_id
    assert.equal((await reserve(reviewId, 1)).state, 'awaiting_review')
    assert.equal((await state()).chest.unit, after.chest.unit, 'review marks do not cut')
    assert.equal((await call('designer_input', `${reviewId},1`)).ok, false)
    const markers = await lua(`rcon.print(helpers.table_to_json(remote.call('reservation_test_fixture','markers',${reviewId})))`)
    assert.deepEqual(markers, { blueprint_tiles: 32, pin: true, outline: true })
    assert.equal((await call('player_control', `1,'approve',${reviewId},1`)).ok, false)
    assert.equal((await call('reverse', `${reviewId},1`)).ok, true)
    const reviewStatus = await summary(reviewId); assert.equal(reviewStatus.state, 'rejected')
    await lua(`remote.call('reservation_test_fixture','mode','auto');rcon.print('{}')`)
    const active = await read('validateConstructionReservation', { goal_id: 'reverse-goal', plan_id: 'reverse-plan', x: saved.x, y: saved.y, width: 10, height: 8 })
    assert.equal(active.ok, true)
    const reverseId = active.reservation_id
    assert.equal((await reserve(reverseId, 1)).state, 'reserved')
    assert.equal((await call('designer_input', `${reverseId},1`)).ok, true)
    // Script intrusion is preserved; a restore must refuse instead of clearing it.
    const intrusion = await lua(`local t=storage.reservation_proof;local e=game.surfaces[t.surface].create_entity{name='wooden-chest',position=t.chest,force='player'};storage.reservation_intruder=e;rcon.print(helpers.table_to_json({unit=e.unit_number}))`)
    assert.equal((await call('reverse', `${reverseId},1`)).ok, false)
    assert.equal((await lua(`rcon.print(helpers.table_to_json({valid=storage.reservation_intruder.valid}))`)).valid, true)
    await lua(`storage.reservation_intruder.destroy();rcon.print('{}')`)
    assert.equal((await call('reverse', `${reverseId},1`)).ok, true)
    const final = await state(); assert.deepEqual(final.chest.items, before.chest.items); assert.equal(final.tile, before.tile)
    assert.equal((await summary(reverseId)).state, 'restored')
    const reverseStatus = await summary(reverseId)
    // Exercise every admitted vanilla prototype, plus non-default flags and
    // quality, with the native backup/restore verifier on both boundaries.
    const roundtrips = await lua(`local t=storage.reservation_proof;local a=game.get_entity_by_unit_number(t.actor);local s=a.surface;local x=t.x+14;local y=t.y;local box={{x,y},{x+8,y+8}};for _,e in pairs(s.find_entities_filtered{area=box}) do e.destroy() end;local tiles={};for xx=x,x+7 do for yy=y,y+7 do tiles[#tiles+1]={name='grass-1',position={xx,yy}} end end;s.set_tiles(tiles,true,false,false);a.force.chart(s,box);local names={'tree-01','tree-02','tree-02-red','tree-03','tree-04','tree-05','tree-06','tree-06-brown','tree-07','tree-08','tree-08-brown','tree-08-red','tree-09','tree-09-brown','tree-09-red','dead-dry-hairy-tree','dead-grey-trunk','dead-tree-desert','dry-hairy-tree','dry-tree','huge-rock','big-rock','big-sand-rock','coal','iron-ore','copper-ore','stone','uranium-ore','wooden-chest','iron-chest','steel-chest','stone-furnace','steel-furnace','electric-furnace','assembling-machine-1','assembling-machine-2','assembling-machine-3'};local out={};for _,name in pairs(names) do local e=s.create_entity{name=name,position={x+4,y+4},force=a.force,amount=1234,quality='uncommon'};assert(e,'create '..name);e.minable=false;e.destructible=false;e.operable=false;e.rotatable=false;if e.type=='furnace' or e.type=='assembling-machine' then e.active=false end;if e.type=='container' then e.insert{name='iron-plate',quality='rare',count=3};e.get_inventory(defines.inventory.chest).set_bar(3) end;local p=remote.call('autorio_reservations','validate',{goal_id='roundtrip',plan_id=name,x=x,y=y,width=8,height=8});assert(p.ok,name..' validate '..helpers.table_to_json(p));local r=remote.call('autorio_reservations','reserve',p.reservation_id,1);assert(r.ok,name..' cut '..helpers.table_to_json(r));r=remote.call('autorio_reservations','designer_returned',p.reservation_id,1,'roundtrip');assert(r.ok,name..' restore '..helpers.table_to_json(r));local restored=s.find_entities_filtered{area=box,name=name}[1];assert(restored and not restored.minable and not restored.destructible,name..' flags');if e.valid then error('source still valid '..name) end;out[#out+1]={name=name,state=r.reservation.state,quality=restored.quality.name};restored.destroy() end;rcon.print(helpers.table_to_json(out))`)
    assert.equal(roundtrips.length, 37)
    // Unsupported mobile/connected factories are refused before any cut.
    const rejected = await lua(`local t=storage.reservation_proof;local a=game.get_entity_by_unit_number(t.actor);local s=a.surface;local e=s.create_entity{name='transport-belt',position={t.x+8.5,t.y+5.5},force=a.force};local r=remote.call('autorio_reservations','validate',{goal_id='g',plan_id='p',x=t.x,y=t.y,width=10,height=8});local intact=e.valid;e.destroy();rcon.print(helpers.table_to_json({ok=r.ok,code=r.code,intact=intact}))`)
    assert.equal(rejected.ok, false); assert.equal(rejected.intact, true)
    const oil = await lua(`local t=storage.reservation_proof;local s=game.surfaces[t.surface];local e=s.create_entity{name='crude-oil',position={t.x+8,t.y+5},amount=1234};local r=remote.call('autorio_reservations','validate',{goal_id='g',plan_id='p',x=t.x,y=t.y,width=10,height=8});local intact=e.valid;e.destroy();rcon.print(helpers.table_to_json({ok=r.ok,code=r.code,intact=intact}))`)
    assert.equal(oil.ok, false); assert.equal(oil.intact, true)
    await fs.writeFile(path.join(results, 'verified.json'), JSON.stringify({ after, final, rejected, oil, intrusion, roundtrips, auto: autoStatus, review: reviewStatus, reverse: reverseStatus }, null, 2))
    console.log('PASS native auto/review/cut/restore/placement/metadata/restart/conflict/stale reservation contracts')
  }
}
catch (error) { await fs.writeFile(path.join(results, `reservation-${phase}-error.txt`), `${error.stack ?? error}`); throw error }
finally { await fs.writeFile(path.join(results, `reservation-${phase}-trace.json`), JSON.stringify(trace, null, 2)); rcon.close() }
