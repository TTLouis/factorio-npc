#!/usr/bin/env node
// Read-only projections over explicitly declared isolated native fixtures.
// Parent owns resources. No provider, commissioning or sustained-flow claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results')); const evidence = { status: 'fail', providers: 0 }; const trace = []
globalThis.fetch = async () => { evidence.providers++; throw new Error('Providers forbidden') }
let connection
const rcon = { command: async command => { const response = await connection.command(command); trace.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const list = value => Array.isArray(value) ? value : (assert.deepEqual(value, {}), [])
const native = payload => lua(`local before=helpers.table_to_json(storage.sgluna_entity_reference_hints or {});local result=remote.call("sgluna_factory","observe",helpers.json_to_table(${luaString(JSON.stringify(payload))}));assert(before==helpers.table_to_json(storage.sgluna_entity_reference_hints or {}));rcon.print(helpers.table_to_json(result))`)
const locator = 'local function loc(e)return {unit_number=e.unit_number,name=e.name,position=e.position,surface_index=e.surface.index,force_index=e.force.index}end'
try {
  connection = new Rcon(Number(arg('rcon-port')), 'offline-fixture-only'); await connection.connect()
  const marker = '/silent-command rcon.print("native-activity-fixture-ready")'; await rcon.command(marker); assert.match(await rcon.command(marker), /native-activity-fixture-ready/)
  evidence.before = await lua('game.tick_paused=true;game.speed=1;rcon.print(helpers.table_to_json({tick=game.tick,humans=#game.connected_players,mods=script.active_mods}))')
  assert.equal(evidence.before.mods.base, '2.0.77'); assert.equal(evidence.before.humans, 0)
  await configureNpcSession(rcon, 'factory-native-activity-fixture')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
  assert.equal(world.ok, true)
  evidence.setup = await lua(`${locator};local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y)
    a.get_main_inventory().clear()
    for _,e in pairs(s.find_entities_filtered{area={{x-24,y-24},{x+24,y+24}}}) do if e~=a and e.name~="sgluna-npc-vision" then e.destroy() end end
    local tiles={};for tx=x-24,x+24 do for ty=y-24,y+24 do tiles[#tiles+1]={name="landfill",position={tx,ty}} end end;s.set_tiles(tiles,true,false,true)
    local specs={{"plain","steel-chest",-10,-10},{"furnace","stone-furnace",-5,-10},{"assembler","assembling-machine-2",2,-10},{"miner","burner-mining-drill",9,-10},{"generator","steam-engine",-10,0},{"pole","small-electric-pole",-4,0},{"power-pole","substation",-16,16},{"power-second-pole","substation",-2,16},{"power-producer","steam-engine",-21,16},{"power-consumer","assembling-machine-2",-16,21}}
    local rows={};for _,f in pairs(specs) do local e=s.create_entity{name=f[2],position={x+f[3],y+f[4]},force=a.force};assert(e);rows[#rows+1]={label=f[1],locator=loc(e)} end
    local i=s.create_entity{name="inserter",position={x+8,y+8},force=a.force};assert(i);local c=s.create_entity{name="steel-chest",position=i.pickup_position,force=a.force};assert(c);rows[#rows+1]={label="unregistered-consumer-source",locator=loc(c)}
    local loader_names={};for name,p in pairs(prototypes.entity)do if p.type=="loader"then loader_names[#loader_names+1]=name end end;table.sort(loader_names);assert(loader_names[1]);local l=s.create_entity{name=loader_names[1],position={x+17,y-14},direction=defines.direction.north,force=a.force};assert(l);storage.native_activity_fixture_loader=l
    local lc=s.create_entity{name="steel-chest",position={l.position.x,math.ceil(l.bounding_box.right_bottom.y)+0.5},force=a.force};assert(lc);rows[#rows+1]={label="loader-container",locator=loc(lc)}
    rcon.print(helpers.table_to_json({x=x,y=y,surface_index=s.index,force_index=a.force.index,fixtures=rows,inserter=loc(i),loader=loc(l)}))`)
  // One bounded tick refreshes native visibility/endpoint caches. Pause is
  // restored by native guard, before any proving observations below.
  await lua('local until_tick=game.tick+1;script.on_nth_tick(1,function()if game.tick>=until_tick then game.tick_paused=true;script.on_nth_tick(1,nil) end end);game.tick_paused=false;rcon.print("{}")')
  for (let i = 0; i < 50; i++) { evidence.paused = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused}))'); if (evidence.paused.paused) break; await delay(25) }
  assert.equal(evidence.paused.paused, true); assert.equal(evidence.paused.tick - evidence.before.tick, 1)
  const request = { schema_version: 1, request_id: 'activity-initial', world_id: world.world_id, actor_id: actor.actor_id,
    surface_index: evidence.setup.surface_index, force_index: evidence.setup.force_index, members: evidence.setup.fixtures.map(row => row.locator) }
  evidence.initial = await native(request); assert.equal(evidence.initial.ok, true)
  const row = label => { const id = evidence.setup.fixtures.find(f => f.label === label).locator.unit_number; return evidence.initial.members.find(m => m.unit_number === id) }
  const startup = row('furnace').startup_recipe_candidates
  assert.equal(row('furnace').recipe.state, 'none')
  assert.equal(startup.state, 'known', JSON.stringify(startup)); assert.equal(startup.coverage, 'complete'); assert.equal(startup.truncated, false)
  assert.equal(startup.selection, 'unselected'); assert.equal(startup.commissioning, 'unverified'); assert.ok(list(startup.candidates).length > 0)
  evidence.startup_direct = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});local p=prototypes.entity[${luaString(row('furnace').name)}];local rows={}
    local function project(values)local out={};for _,v in pairs(values)do out[#out+1]={type=v.type,name=v.name,amount=v.amount,amount_min=v.amount_min,amount_max=v.amount_max,probability=v.probability}end;return out end
    for _,r in pairs(a.force.recipes)do if r.enabled then local supported=p.crafting_categories[r.category]==true;for _,c in pairs(r.additional_categories or {})do if p.crafting_categories[c]then supported=true end end
      if supported then local available=true;for _,c in pairs(r.prototype.surface_conditions or {})do if not a.surface.ignore_surface_conditions then local value=a.surface.get_property(c.property);if not c.min or not c.max or value<c.min or value>c.max then available=false end end end
        if available then rows[#rows+1]={name=r.name,ingredients=project(r.ingredients),products=project(r.products)}end end end end;table.sort(rows,function(a,b)return a.name<b.name end);rcon.print(helpers.table_to_json(rows))`)
  assert.deepEqual(startup.candidates.map(({ name, ingredients, products }) => ({ name, ingredients, products })), evidence.startup_direct)
  const disabled = startup.candidates[0].name
  await lua(`local r=game.forces[${request.force_index}].recipes[${luaString(disabled)}];storage.native_activity_startup_recipe={recipe=r,enabled=r.enabled};r.enabled=false;rcon.print("{}")`)
  evidence.startup_locked = await native({ ...request, request_id: 'activity-startup-locked', members: [row('furnace').locator] })
  assert.equal(evidence.startup_locked.members[0].startup_recipe_candidates.coverage, 'complete')
  assert.ok(!list(evidence.startup_locked.members[0].startup_recipe_candidates.candidates).some(candidate => candidate.name === disabled))
  assert.equal(evidence.startup_locked.members[0].recipe.state, 'none')
  await lua('local r=storage.native_activity_startup_recipe;r.recipe.enabled=r.enabled;storage.native_activity_startup_recipe=nil;rcon.print("{}")')
  for (const label of ['plain', 'furnace']) assert.deepEqual({ state: row(label).consumer_facts.state, coverage: row(label).consumer_facts.coverage, consumers: list(row(label).consumer_facts.consumers) }, { state: 'known', coverage: 'complete', consumers: [] })
  const linked = row('unregistered-consumer-source').consumer_facts
  assert.ok(list(linked.consumers).some(c => c.consumer.unit_number === evidence.setup.inserter.unit_number && ['potential', 'connected'].includes(c.state)))
  assert.ok(list(row('loader-container').consumer_facts.consumers).some(c => c.relation === 'loader_output' && c.state === 'connected' && c.consumer.unit_number === evidence.setup.loader.unit_number))
  const readiness = row('plain').removal_readiness
  assert.equal(readiness.state, 'known', JSON.stringify(readiness)); assert.equal(readiness.recovery_capacity, 'verified')
  assert.equal(readiness.snapshot.target.unit_number, row('plain').unit_number)
  assert.deepEqual(list(readiness.actor_inventory), []); assert.deepEqual(list(readiness.snapshot.contents), [])
  evidence.direct_removal_products = await lua(`local p=prototypes.entity[${luaString(row('plain').name)}];local out={};for _,v in pairs(p.mineable_properties.products)do assert(v.type=="item" and v.probability==1 and v.amount);out[#out+1]={name=v.name,count=v.amount,quality=${luaString(readiness.snapshot.target.quality)}}end;rcon.print(helpers.table_to_json(out))`)
  assert.deepEqual(readiness.snapshot.products, evidence.direct_removal_products)
  evidence.capacity_fixture = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});local inv=a.get_main_inventory();local products=prototypes.entity[${luaString(row('plain').name)}].mineable_properties.products;local excluded={};for _,p in pairs(products)do excluded[p.name]=true end;local names={};for name,p in pairs(prototypes.item)do if p.type=="item"and not p.spoil_result and not excluded[name]then names[#names+1]=name end end;table.sort(names);assert(names[1]);local count=#inv*prototypes.item[names[1]].stack_size;assert(inv.insert{name=names[1],count=count}==count);rcon.print(helpers.table_to_json({name=names[1],count=count}))`)
  evidence.capacity_observation = await native({ ...request, request_id: 'activity-removal-capacity', members: [row('plain').locator] })
  assert.equal(evidence.capacity_observation.members[0].removal_readiness.state, 'refused')
  assert.equal(evidence.capacity_observation.members[0].removal_readiness.code, 'removal_inventory_full')
  await lua(`game.get_entity_by_unit_number(${actor.actor_id}).get_main_inventory().clear();rcon.print("{}")`)
  for (const label of ['furnace', 'assembler']) {
    assert.equal(row(label).progress_facts.products_finished.state, 'known'); assert.equal(row(label).progress_facts.products_finished.value, 0)
  }
  assert.equal(row('miner').progress_facts.products_finished.state, 'not_applicable')
  assert.equal(row('miner').progress_facts.mining_progress.state, 'known')
  assert.equal(row('generator').progress_facts.electricity_production.producer, true)
  assert.equal(row('generator').progress_facts.energy_generated_last_tick.state, 'known')
  assert.equal(row('generator').consumer_facts.coverage, 'partial')
  assert.equal(row('pole').progress_facts.electricity_production.state, 'not_applicable')
  const component = row('power-consumer').electric_component_facts
  assert.equal(component.coverage, 'complete', JSON.stringify(component)); assert.equal(component.unresolved, false)
  assert.deepEqual(component.capable_producers, [row('power-producer').unit_number])
  assert.equal(component.has_storage, false); assert.equal(component.has_interface, false)
  assert.ok(component.members.some(m => m.unit_number === row('power-consumer').unit_number && m.role === 'consumer' && m.energy.state === 'known'))
  assert.ok(component.members.some(m => m.unit_number === row('power-pole').unit_number && m.role === 'pole'))
  assert.ok(list(component.wire_edges).some(edge => edge.from_unit_number === row('power-pole').unit_number && edge.to_unit_number === row('power-second-pole').unit_number))
  for (const label of ['furnace', 'miner']) {
    const fuels = row(label).fuel_item_facts
    assert.equal(fuels.state, 'known'); assert.equal(fuels.coverage, 'complete'); assert.ok(list(fuels.items).length > 0)
    evidence[`${label}_direct_fuels`] = await lua(`local accepted=helpers.json_to_table(${luaString(JSON.stringify(row(label).burner_fuel_requirement.fuel_categories))});local items={};for name,p in pairs(prototypes.item)do for _,category in pairs(accepted)do if p.fuel_category==category and p.fuel_value>0 then items[#items+1]={name=name,category=category,fuel_value=p.fuel_value}end end end;table.sort(items,function(a,b)return a.name<b.name end);rcon.print(helpers.table_to_json(items))`)
    assert.deepEqual(fuels.items, evidence[`${label}_direct_fuels`])
  }
  evidence.direct = await lua(`local fixtures=helpers.json_to_table(${luaString(JSON.stringify(evidence.setup.fixtures))});local rows={};for _,f in pairs(fixtures) do local e;for _,v in pairs(game.surfaces[f.locator.surface_index].find_entities_filtered{position=f.locator.position,radius=0.25,name=f.locator.name}) do if v.unit_number==f.locator.unit_number then e=v end end;assert(e)
    local row={label=f.label};if e.type=="furnace" or e.type=="assembling-machine" then row.products_finished=e.products_finished;row.crafting_progress=e.crafting_progress end;if e.type=="mining-drill" then row.mining_progress=e.mining_progress end;if e.type=="generator" then row.energy_generated_last_tick=e.energy_generated_last_tick;row.maximum_energy_production=e.prototype.get_max_energy_production(e.quality) end;rows[#rows+1]=row end;rcon.print(helpers.table_to_json(rows))`)
  for (const direct of evidence.direct) {
    const projected = row(direct.label).progress_facts
    for (const key of ['products_finished', 'crafting_progress', 'mining_progress', 'energy_generated_last_tick']) if (direct[key] !== undefined) assert.equal(projected[key].value, direct[key])
    if (direct.maximum_energy_production !== undefined) assert.equal(projected.electricity_production.maximum_energy_production, direct.maximum_energy_production)
  }
  const plain = evidence.setup.fixtures.find(f => f.label === 'plain').locator
  evidence.loader_input_immediate = await lua(`${locator};local e=storage.native_activity_fixture_loader;e.loader_type="input";rcon.print(helpers.table_to_json({tick=game.tick,mode=e.loader_type,direction=e.direction,container=e.loader_container and loc(e.loader_container)}))`)
  // Native 2.0.77 flips direction immediately but refreshes loader_container on
  // the next tick. loader-01 also measured both item-flow directions; querying
  // in the setter tick is not a settled endpoint observation.
  await lua('local until_tick=game.tick+1;script.on_nth_tick(1,function()if game.tick>=until_tick then game.tick_paused=true;script.on_nth_tick(1,nil) end end);game.tick_paused=false;rcon.print("{}")')
  for (let i = 0; i < 50; i++) { evidence.loader_input_refresh = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused}))'); if (evidence.loader_input_refresh.paused) break; await delay(25) }
  assert.equal(evidence.loader_input_refresh.paused, true); assert.equal(evidence.loader_input_refresh.tick - evidence.loader_input_immediate.tick, 1)
  const loaderContainer = evidence.setup.fixtures.find(f => f.label === 'loader-container').locator
  evidence.loader_input_direct = await lua(`${locator};local e=storage.native_activity_fixture_loader;assert(e.loader_container);rcon.print(helpers.table_to_json({mode=e.loader_type,direction=e.direction,container=loc(e.loader_container)}))`)
  assert.equal(evidence.loader_input_direct.mode, 'input'); assert.deepEqual(evidence.loader_input_direct.container, loaderContainer)
  evidence.loader_input = await native({ ...request, request_id: 'activity-loader-input', members: [loaderContainer] })
  assert.ok(list(evidence.loader_input.members[0].incoming_item_facts.producers).some(p => p.relation === 'loader_input' && p.state === 'connected' && p.producer.unit_number === evidence.setup.loader.unit_number))
  evidence.belt = await lua(`local s=game.surfaces[${plain.surface_index}];local e=s.create_entity{name="transport-belt",position={${evidence.setup.x + 16},${evidence.setup.y + 16}},force=${plain.force_index}};assert(e);storage.native_activity_fixture_belt=e;rcon.print(helpers.table_to_json({unit_number=e.unit_number}))`)
  evidence.belt_observation = await native({ ...request, request_id: 'activity-belt', members: [plain] })
  assert.equal(evidence.belt_observation.members[0].consumer_facts.coverage, 'complete')
  assert.deepEqual(list(evidence.belt_observation.members[0].consumer_facts.consumers), [])
  await lua('storage.native_activity_fixture_belt.destroy();storage.native_activity_fixture_belt=nil;rcon.print("{}")')
  evidence.hidden = await lua(`local s=game.surfaces[${plain.surface_index}];s.request_to_generate_chunks({10000,10000},1);s.force_generate_chunk_requests();local e=s.create_entity{name="inserter",position={10000,10000},force=${plain.force_index}};assert(e);assert(not game.forces[${plain.force_index}].is_chunk_visible(s,{312,312}));storage.native_activity_fixture_hidden=e;rcon.print(helpers.table_to_json({unit_number=e.unit_number}))`)
  evidence.hidden_observation = await native({ ...request, request_id: 'activity-hidden-candidate', members: [plain] })
  assert.equal(evidence.hidden_observation.members[0].consumer_facts.coverage, 'complete', 'far hidden fixed-vector inserter is excluded by live prototype bounds')
  assert.ok(!JSON.stringify(evidence.hidden_observation).includes(`"unit_number":${evidence.hidden.unit_number}`))
  await lua(`local s=game.surfaces[${plain.surface_index}];storage.native_activity_fixture_hidden.destroy();storage.native_activity_fixture_hidden=nil;storage.native_activity_fixture_many={};for i=1,130 do local e=s.create_entity{name="inserter",position={10000+(i%16)*2,10000+math.floor(i/16)*2},force=${plain.force_index}};assert(e);storage.native_activity_fixture_many[#storage.native_activity_fixture_many+1]=e end;rcon.print("{}")`)
  evidence.truncated_observation = await native({ ...request, request_id: 'activity-truncated', members: [plain] })
  assert.equal(evidence.truncated_observation.members[0].consumer_facts.truncated, true)
  await lua('for _,e in pairs(storage.native_activity_fixture_many)do if e.valid then e.destroy()end end;storage.native_activity_fixture_many=nil;rcon.print("{}")')
  // Fixture-only external destruction proves the locator diagnostic, never a
  // custody receipt or global removed-item claim.
  await lua(`local s=game.surfaces[${plain.surface_index}];local found=false;for _,e in pairs(s.find_entities_filtered{position={${plain.position.x},${plain.position.y}},radius=0.25,name=${luaString(plain.name)}})do if e.unit_number==${plain.unit_number}then assert(e.destroy());found=true end end;assert(found);rcon.print("{}")`)
  evidence.absence = await native({ ...request, request_id: 'activity-absent-locator', members: [plain] })
  assert.equal(evidence.absence.members[0].code, 'member_not_found')
  assert.deepEqual(evidence.absence.members[0].absence_facts, { state: 'known', coverage: 'complete', scope: 'exact_locator', absent: true, truncated: false })
  assert.equal(evidence.absence.actor_inventory.state, 'known'); assert.deepEqual(list(evidence.absence.actor_inventory.items), [])
  assert.deepEqual(evidence.absence.actor_inventory.binding, { world_id: world.world_id, actor_id: actor.actor_id, epoch: actor.epoch, session: actor.session, request_id: 'activity-absent-locator', tick: evidence.absence.tick })
  evidence.after = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))')
  assert.equal(evidence.after.tick, evidence.loader_input_refresh.tick); assert.equal(evidence.after.paused, true); assert.equal(evidence.after.humans, 0); assert.equal(evidence.providers, 0)
  evidence.status = 'pass'
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  if (connection) { try { await rcon.command('/silent-command game.tick_paused=true;game.speed=1;script.on_nth_tick(1,nil);if storage.native_activity_startup_recipe then local r=storage.native_activity_startup_recipe;r.recipe.enabled=r.enabled;storage.native_activity_startup_recipe=nil end;if storage.native_activity_fixture_belt and storage.native_activity_fixture_belt.valid then storage.native_activity_fixture_belt.destroy()end;storage.native_activity_fixture_belt=nil;if storage.native_activity_fixture_hidden and storage.native_activity_fixture_hidden.valid then storage.native_activity_fixture_hidden.destroy()end;storage.native_activity_fixture_hidden=nil;for _,e in pairs(storage.native_activity_fixture_many or {})do if e.valid then e.destroy()end end;storage.native_activity_fixture_many=nil') } catch { evidence.fixture_cleanup = 'unconfirmed' } }
  connection?.close(); await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, 'native-activity-verify.json'), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, 'native-activity-transcript.json'), JSON.stringify(trace, null, 2))
}
