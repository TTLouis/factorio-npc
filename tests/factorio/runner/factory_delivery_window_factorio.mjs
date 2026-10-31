#!/usr/bin/env node
// Bounded native delivery windows over declared synthetic initial hardware and
// stock. This is not commissioning, sustained supply or an autonomous trial.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i >= 0) return process.argv[i + 1]; assert.notEqual(fallback, undefined, `missing --${name}`); return fallback }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon } = await load('runtime-v8/common.mjs')
const { luaString } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { registerFactoryCell } = await load('runtime-v8/factory-registry.mjs')
const { prepareFactoryCellHost } = await load('runtime-v8/factory-cell-tools.mjs')
const { observeDirectFactoryDelivery, observeElectricFactoryDelivery } = await load('runtime-v8/factory-cell-delivery-window.mjs')
const KEY = 'npc:factory-native-windows'
const evidence = { status: 'fail', providers: 0, mode: 'bounded_native_delivery_windows', frames: [],
  fixture: 'Synthetic initial native hardware, ore patch, fuel and steam. Native recipes, fluid filters, capacities and temperatures are read live. No entity or inventory mutation occurs between owned positive frames.' }
const transcript = []; let connection
globalThis.fetch = async () => { evidence.providers++; throw new Error('Inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => { const raw = await rcon.command(`/silent-command ${body}`); try { return JSON.parse(raw) } catch { throw new Error(`native JSON invalid: ${raw}`) } }
const exactLua = (locator, variable) => `local ${variable};for _,v in pairs(game.surfaces[${locator.surface_index}].find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},force=${locator.force_index},limit=9})do if v.unit_number==${locator.unit_number} and v.position.x==${locator.position.x} and v.position.y==${locator.position.y} then assert(not ${variable});${variable}=v end end;assert(${variable});`
// Synthetic hardware uses the same authoritative placement-candidate path as
// the retained native observation fixture; candidate geometry comes from game.
const nativePairPlacement = `local dc=remote.call("autorio_tools","get_placement_candidates",{entity_name="burner-mining-drill",center={x=cx,y=cy},radius=4,target_resource=resourceName,limit=4});assert(dc.candidates and #dc.candidates>0,helpers.table_to_json(dc));local dp=dc.candidates[1];assert(dp.item_output_position);
  local d=s.create_entity{name="burner-mining-drill",position=dp.position,direction=dp.direction,force=a.force};assert(d);
  local fc=remote.call("autorio_tools","get_placement_candidates",{entity_name="stone-furnace",covers_position=dp.item_output_position,limit=4});assert(fc.candidates and #fc.candidates>0,helpers.table_to_json(fc));local fp=fc.candidates[1];
  local f=s.create_entity{name="stone-furnace",position=fp.position,direction=fp.direction,force=a.force};assert(f);`
async function ticks(count) {
  const before = await lua(`assert(game.tick_paused);local start=game.tick;local stop=start+${count};script.on_nth_tick(1,function()if game.tick>=stop then game.tick_paused=true;script.on_nth_tick(1,nil)end end);game.tick_paused=false;rcon.print(helpers.table_to_json({tick=start}))`)
  const end = Date.now() + 5000
  for (;;) {
    const state = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed}))')
    if (state.paused) { assert.equal(state.tick - before.tick, count); assert.equal(state.speed, 1); return state }
    assert.ok(Date.now() < end, 'native tick guard deadline'); await delay(25)
  }
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password', 'offline-fixture-only'), 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  await configureNpcSession(rcon, 'factory-native-windows-20261031')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  evidence.setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y);
    for _,e in pairs(s.find_entities_filtered{area={{x-24,y-24},{x+24,y+24}}})do if e~=a and e.name~="sgluna-npc-vision"then e.destroy()end end;
    local tiles={};for xx=x-24,x+24 do for yy=y-24,y+24 do tiles[#tiles+1]={name="landfill",position={xx,yy}}end end;s.set_tiles(tiles,true,false,true);
    local furnacePrototype=prototypes.entity["stone-furnace"];
    local recipes={};for name,r in pairs(a.force.recipes)do if r.enabled and furnacePrototype.crafting_categories[r.category] and #r.ingredients==1 and #r.products==1 and r.ingredients[1].type=="item"and r.products[1].type=="item"then recipes[#recipes+1]=name end end;table.sort(recipes);local recipe=a.force.recipes[recipes[1]];assert(recipe);
    local resourceNames={};for name,p in pairs(prototypes.entity)do if p.type=="resource"then for _,v in pairs(p.mineable_properties.products or {})do if v.type=="item"and v.name==recipe.ingredients[1].name then resourceNames[#resourceNames+1]=name end end end end;table.sort(resourceNames);assert(resourceNames[1]);
    for xx=x+7,x+9 do for yy=y-9,y-7 do assert(s.create_entity{name=resourceNames[1],position={xx,yy},amount=10000})end end;
    local cx=x+8;local cy=y-8;local resourceName=resourceNames[1];${nativePairPlacement}
    local fuels={};for name,p in pairs(prototypes.item)do if p.fuel_value>0 and f.prototype.burner_prototype.fuel_categories[p.fuel_category]and d.prototype.burner_prototype.fuel_categories[p.fuel_category]then fuels[#fuels+1]=name end end;table.sort(fuels);assert(fuels[1]);
    assert(d.get_fuel_inventory().insert{name=fuels[1],count=4}==4);assert(f.get_fuel_inventory().insert{name=fuels[1],count=4}==4);assert(f.get_inventory(defines.inventory.furnace_source).insert{name=recipe.ingredients[1].name,count=recipe.ingredients[1].amount}==recipe.ingredients[1].amount);
    local g=s.create_entity{name="steam-engine",position={x-21,y+16},force=a.force};assert(g);local p=s.create_entity{name="substation",position={x-16,y+16},force=a.force};assert(p);local p2=s.create_entity{name="substation",position={x-2,y+16},force=a.force};assert(p2);local c=s.create_entity{name="assembling-machine-2",position={x-16,y+21},force=a.force};assert(c);
    local cRecipes={};for name,r in pairs(a.force.recipes)do if r.enabled and c.prototype.crafting_categories[r.category]and #r.products==1 and r.products[1].type=="item"then cRecipes[#cRecipes+1]=name end end;table.sort(cRecipes);local cr=a.force.recipes[cRecipes[1]];assert(cr);c.set_recipe(cr.name);
    local function loc(e)return {unit_number=e.unit_number,name=e.name,position=e.position,surface_index=s.index,force_index=a.force.index}end;
    rcon.print(helpers.table_to_json({source=loc(d),target=loc(f),source_candidate=dp,target_candidate=fp,generator=loc(g),consumer=loc(c),pole=loc(p),second_pole=loc(p2),surface_index=s.index,force_index=a.force.index,resource=recipe.ingredients[1].name,product=recipe.products[1].name,recipe=recipe.name,consumer_recipe=cr.name,consumer_product=cr.products[1].name,fuel=fuels[1]}))`)
  const setup = evidence.setup
  const world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
  assert.equal(world.ok, true)
  evidence.native_warmup = []
  for (let attempt = 0; ; attempt++) {
    const row = await lua(`${exactLua(setup.source, 'd')}${exactLua(setup.target, 'f')}rcon.print(helpers.table_to_json({tick=game.tick,source_position=d.position,target_position=f.position,direction=d.direction,drop_position=d.drop_position,drop_target=d.drop_target and d.drop_target.unit_number,target_box=f.bounding_box,recipe=f.get_recipe() and f.get_recipe().name,products_finished=f.products_finished,output=f.get_inventory(defines.inventory.furnace_result).get_item_count(${luaString(setup.product)})}))`)
    evidence.native_warmup.push(row)
    if (row.drop_target === setup.target.unit_number && row.recipe === setup.recipe && row.products_finished > 1 && row.output > 1) break
    assert.ok(attempt < 30, `native connected fixture unavailable: ${JSON.stringify(row)}`); await ticks(120)
  }
  // Record every prerequisite while paused before testing it or mutating setup.
  evidence.pre_window_conditions = await lua(`${exactLua(setup.source, 'd')}${exactLua(setup.target, 'f')}${exactLua(setup.generator, 'g')}${exactLua(setup.consumer, 'c')}
    local filter=g.fluidbox.get_filter(1);local prototype=g.fluidbox.get_prototype(1);local name=type(filter)=="string"and filter or filter and filter.name;local p=name and prototypes.fluid[name];local capacity=g.fluidbox.get_capacity(1);local temperature=prototype.maximum_temperature or p and p.max_temperature;
    rcon.print(helpers.table_to_json({paused=game.tick_paused,tick=game.tick,drop_target=d.drop_target and d.drop_target.unit_number,recipe=f.get_recipe() and f.get_recipe().name,fluid=name,capacity=capacity,temperature=temperature,default_temperature=p and p.default_temperature,consumer_energy=c.energy,direct_consumer_active=f.active}))`)
  const conditions = evidence.pre_window_conditions
  assert.equal(conditions.paused, true); assert.equal(conditions.drop_target, setup.target.unit_number)
  assert.equal(conditions.recipe, setup.recipe); assert.equal(conditions.consumer_energy, 0)
  assert.equal(typeof conditions.fluid, 'string'); assert.ok(conditions.capacity > 0)
  assert.ok(conditions.temperature > conditions.default_temperature)
  evidence.pre_window_setup = await lua(`${exactLua(setup.target, 'f')}${exactLua(setup.generator, 'g')}assert(game.tick_paused);f.active=false;g.fluidbox[1]={name=${luaString(conditions.fluid)},amount=${conditions.capacity},temperature=${conditions.temperature}};rcon.print(helpers.table_to_json({tick=game.tick,direct_consumer_active=f.active,fluid=g.fluidbox[1]}))`)
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(world.world_id)
  let registry = memory.getFactoryRegistry()
  const add = (members, products, ports, purpose) => { registry = registerFactoryCell(registry, { surface_index: setup.surface_index, force_index: setup.force_index,
    assignment: { products, purpose, method: 'declared_synthetic_native_fixture' },
    members: members.map(row => ({ ...row, provenance: { source: 'declared_synthetic_native_fixture' } })), ports, origin: { source: 'declared_synthetic_native_fixture' } }) }
  add([setup.source, setup.target], [setup.product], [{ port_id: 'out', direction: 'output', kind: 'item', resource: setup.product }], 'Native direct delivery fixture')
  add([setup.generator], [], [{ port_id: 'power', direction: 'output', kind: 'power' }], 'Native power delivery fixture')
  add([setup.consumer], [setup.consumer_product], [{ port_id: 'out', direction: 'output', kind: 'item', resource: setup.consumer_product }], 'Native consumer fixture')
  memory.restore({ ...memory.snapshot(), factory_registry: registry })
  memory.recordPlan(KEY, { sender: 'owner', text: 'Measure bounded native delivery windows' }, { chatMessage: '', plan: ['Observe the exact fixture cells'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: setup.product, minimum: 1 }] } }] }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const agent = new NpcAgentLoop({ rcon, memory, npcId: 'factory-native-windows', completionProtocolVersion: 3, jevCheckpoints: false,
    stateFile: path.join(results, 'canonical-state.json'), traceFile: null, decisionTraceFile: null, provider: async () => { throw new Error('Providers forbidden') } })
  agent.active = true; agent.epoch = actor; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'native-owned-window', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0); agent.behaviorTrace = { emit: async () => {} }
  const capture = () => prepareFactoryCellHost(agent, async observer => {
    const scope = observer.runtime.scope()
    const direct = await observer.observe({ cell_id: 'cell-1' }); const source = await observer.observe({ cell_id: 'cell-2' }); const target = await observer.observe({ cell_id: 'cell-3' })
    const frame = { scope, direct: direct.native, producer: source.native.members[0], receiver: target.native.members[0], tick: source.native.tick }
    assert.equal(source.native.tick, target.native.tick); assert.equal(direct.native.tick, source.native.tick)
    frame.direct_result = observeDirectFactoryDelivery(memory, { scope, cell: registry.cells[0], native: frame.direct,
      source: setup.source, target: setup.target, resource: setup.resource, mutation: 0, connectedPlayers: 0 })
    frame.electric_result = observeElectricFactoryDelivery(memory, { scope, supplier: registry.cells[1], consumer: registry.cells[2],
      producer: frame.producer, receiver: frame.receiver, tick: frame.tick, mutation: 0, connectedPlayers: 0 })
    evidence.frames.push(frame); return frame
  }).execute()
  const first = await capture()
  assert.equal(first.direct_result.state, 'unverified'); assert.equal(first.electric_result.state, 'unverified')
  for (let i = 0; i < 12 && (!evidence.direct_delivered || !evidence.electric_delivered); i++) {
    await ticks(120); const frame = await capture()
    if (frame.direct_result.state === 'delivered') evidence.direct_delivered = frame.direct_result
    if (frame.electric_result.state === 'delivered') evidence.electric_delivered = frame.electric_result
  }
  assert.equal(evidence.direct_delivered?.state, 'delivered', JSON.stringify(evidence.frames.at(-1).direct_result))
  assert.equal(evidence.electric_delivered?.state, 'delivered', JSON.stringify(evidence.frames.at(-1).electric_result))
  // This deliberate mutation starts a new negative case after the positive
  // windows. The current native component must expose the added storage.
  evidence.storage = await lua(`${exactLua(setup.pole, 'p')}local e=p.surface.create_entity{name="accumulator",position={p.position.x+3,p.position.y},force=p.force};assert(e);rcon.print(helpers.table_to_json({unit_number=e.unit_number,name=e.name,position=e.position}))`)
  await ticks(1)
  const storage = await capture()
  assert.equal(storage.producer.electric_component_facts.has_storage, true)
  assert.equal(storage.electric_result.state, 'unverified')
  assert.equal(evidence.direct_delivered.continuous_supply, 'unverified'); assert.equal(evidence.electric_delivered.continuous_supply, 'unverified')
  assert.equal(evidence.providers, 0); evidence.status = 'pass'
  console.log('PASS: actual native direct/electric bounded delivery windows; native storage contamination refused')
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  if (connection) { try { evidence.final_native = await lua('game.speed=1;game.tick_paused=true;script.on_nth_tick(1,nil);rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))') } catch (error) { evidence.final_native_error = String(error) } connection.close() }
  await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'delivery-windows.json'), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, 'transcript.json'), JSON.stringify(transcript, null, 2))
}
