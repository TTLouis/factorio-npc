#!/usr/bin/env node
// Parent-owned isolated native API/projection proof. Fixture writes are explicit;
// zero autonomous inference, no production/delivery or compatibility claims.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const phase = arg('phase')
const evidence = { status: 'fail', phase, providers: 0 }
const trace = []
globalThis.fetch = async () => { evidence.providers++; throw new Error('Providers forbidden') }
let connection
const rcon = { command: async command => { const response = await connection.command(command); trace.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const native = async (method, value) => lua(`local before=helpers.table_to_json(storage.sgluna_entity_reference_hints or {});local world=storage.sgluna_factory_world_id;local result=remote.call("sgluna_factory",${luaString(method)}${value === undefined ? '' : `,helpers.json_to_table(${luaString(JSON.stringify(value))})`});${method === 'observe' ? 'assert(before==helpers.table_to_json(storage.sgluna_entity_reference_hints or {}));assert(world==storage.sgluna_factory_world_id);' : ''}rcon.print(helpers.table_to_json(result))`)
const list = value => { if (Array.isArray(value)) return value; assert.deepEqual(value, {}); return [] }
const helpers = `
  local function plain(v,depth)
    if type(v)=="userdata" then local ok,n=pcall(function()return v.name end);return {native_type=type(v),name=ok and n or nil} end
    if type(v)=="table" then if depth>4 then return {truncated=true} end;local out={};local n=0;for k,x in pairs(v) do n=n+1;if n>128 then out.truncated=true;break end;out[k]=plain(x,depth+1) end;return out end
    if type(v)=="function" then return {native_type="function"} end;return v
  end
  local function read(f) local ok,v=pcall(f);if not ok then return {state="error",error=tostring(v)} end;if v==nil then return {state="nil"} end;return {state="known",native_type=type(v),value=plain(v,0)} end
  local function locator(e) if not e or not e.valid then return nil end;return {unit_number=e.unit_number,name=e.name,position=e.position,surface_index=e.surface.index,force_index=e.force.index} end
`
try {
  assert.ok(['probe', 'verify'].includes(phase))
  connection = new Rcon(Number(arg('rcon-port')), 'offline-fixture-only')
  await connection.connect()
  evidence.before = await lua('game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,humans=#game.connected_players,active_mods=script.active_mods}))')
  assert.equal(evidence.before.active_mods.base, '2.0.77'); assert.equal(evidence.before.humans, 0); assert.equal(evidence.before.paused, true)
  await configureNpcSession(rcon, 'factory-native-endpoints')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  evidence.setup = await lua(`${helpers}
    local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local ox=math.floor(a.position.x);local oy=math.floor(a.position.y)
    for _,e in pairs(s.find_entities_filtered{area={{ox-24,oy-24},{ox+24,oy+24}}}) do if e~=a and e.name~="sgluna-npc-vision" then e.destroy() end end
    local tiles={};for x=ox-24,ox+24 do for y=oy-24,oy+24 do tiles[#tiles+1]={name="landfill",position={x,y}} end end;s.set_tiles(tiles,true,false,true)
    local specs={{"assembler","assembling-machine-2",-12,-12},{"fluid-crafter","chemical-plant",-6,-12},{"refinery","oil-refinery",2,-12},{"furnace","stone-furnace",12,-12},{"boiler","boiler",-12,-4},{"generator","steam-engine",-6,-4},{"heat-input","heat-exchanger",6,-4},{"heat-output","nuclear-reactor",12,-4},{"heat-link","heat-pipe",-12,4},{"pole","small-electric-pole",-6,4},{"storage","accumulator",6,4},{"chest","steel-chest",12,4},{"miner","burner-mining-drill",-12,12},{"inserter","inserter",-6,12}}
    local rows={};for _,v in pairs(specs) do local e=s.create_entity{name=v[2],position={ox+v[3],oy+v[4]},force=a.force};assert(e,v[2]);local row={label=v[1],locator=locator(e)}
      if e.type=="assembling-machine" then local names={};for n,r in pairs(a.force.recipes) do local fluid=false;for _,i in pairs(r.ingredients) do if i.type=="fluid" then fluid=true end end;if e.prototype.crafting_categories[r.category] and ((v[1]=="assembler" and not fluid) or (v[1]~="assembler" and fluid)) then names[#names+1]=n end end;table.sort(names);for _,n in pairs(names) do local ok=pcall(function()e.set_recipe(n)end);local r=e.get_recipe();if ok and r and r.name==n then row.selected_recipe=n;break end end;assert(row.selected_recipe) end
      if v[1]=="miner" then local p=e.drop_position;local target=s.create_entity{name="stone-furnace",position=p,force=a.force};assert(target);row.declared_drop_receiver=locator(target);rows[#rows+1]={label="drop-receiver",locator=locator(target)} end
      rows[#rows+1]=row
    end
    local filtered={};for _,f in pairs(rows) do if f.label=="boiler" then local l=f.locator;local e;for _,v in pairs(s.find_entities_filtered{position=l.position,radius=0.25,name=l.name,force=l.force_index,limit=9}) do if v.unit_number==l.unit_number then e=v end end;assert(e);local names={};for n,p in pairs(prototypes.item) do if p.fuel_category and e.prototype.burner_prototype.fuel_categories[p.fuel_category] then names[#names+1]=n end end;table.sort(names);local qualities={};for n in pairs(prototypes.quality) do qualities[#qualities+1]=n end;table.sort(qualities);assert(names[1] and qualities[1]);filtered={locator=l,item=names[1],quality=qualities[1],category=prototypes.item[names[1]].fuel_category};filtered.set_filter=read(function()return e.get_inventory(defines.inventory.fuel).set_filter(1,{name=names[1],quality=qualities[1],comparator="="})end) end end
    rcon.print(helpers.table_to_json({fixtures=rows,filtered_fixture=filtered,surface_index=s.index,force_index=a.force.index,actor_id=a.unit_number}))`)
  const capture = async () => lua(`${helpers}
    local fixtures=helpers.json_to_table(${luaString(JSON.stringify(evidence.setup.fixtures))});local rows={}
    for _,fixture in pairs(fixtures) do local l=fixture.locator;local e;for _,c in pairs(game.surfaces[l.surface_index].find_entities_filtered{position=l.position,radius=0.25,name=l.name,force=l.force_index,limit=9}) do if c.unit_number==l.unit_number and c.position.x==l.position.x and c.position.y==l.position.y then e=c end end;assert(e)
      local row={label=fixture.label,locator=l,roles={}};for _,role in pairs({"crafter_input","crafter_output","furnace_source","furnace_result","fuel","burnt_result","chest","cargo_wagon","lab_input"}) do row.roles[role]=read(function()return defines.inventory[role]end) end
      row.max_inventory=read(function()return e.get_max_inventory_index()end);row.inventories={};for i=1,math.min(e.get_max_inventory_index(),32) do local inv=e.get_inventory(i);if inv then local r={lookup_index=i,native_type=type(inv),index=read(function()return inv.index end),size=#inv,filter_support=read(function()return inv.supports_filters()end),filters={}};if inv.supports_filters() then for slot=1,math.min(#inv,64) do r.filters[#r.filters+1]={slot=slot,filter=read(function()return inv.get_filter(slot)end)} end end;row.inventories[#row.inventories+1]=r end end
      row.recipe=read(function()local r,q=e.get_recipe();return {name=r and r.name,ingredients=r and r.ingredients,products=r and r.products,quality=plain(q,0)}end)
      row.drop_position=read(function()return e.drop_position end);row.drop_target=read(function()return locator(e.drop_target)end)
      row.fluidboxes={};for i=1,math.min(#e.fluidbox,16) do row.fluidboxes[#row.fluidboxes+1]={index=i,prototype=read(function()local p=e.fluidbox.get_prototype(i);local definitions={};local function add(x) definitions[#definitions+1]={native_type=type(x),index=x.index,production_type=x.production_type,filter=plain(x.filter,0)} end;if p.production_type then add(p) else for _,x in pairs(p) do if #definitions>=16 then break end;add(x) end end;return {native_type=type(p),definitions=definitions}end),filter=read(function()return e.fluidbox.get_filter(i)end),locked_fluid=read(function()return e.fluidbox.get_locked_fluid(i)end),capacity=read(function()return e.fluidbox.get_capacity(i)end)} end
      row.electric={source=read(function()local x=e.prototype.electric_energy_source_prototype;return x and {usage_priority=x.usage_priority}end),network=read(function()return e.electric_network_id end),connected=read(function()return e.is_connected_to_electric_network()end),production=read(function()return e.prototype.get_max_energy_production()end)}
      row.heat={source=read(function()local x=e.prototype.heat_energy_source_prototype;if not x then return nil end;return {native_type=type(x),connections=read(function()return x.connections end)}end),buffer=read(function()local x=e.prototype.heat_buffer_prototype;if not x then return nil end;return {native_type=type(x),connections=read(function()return x.connections end)}end),temperature=read(function()return e.temperature end)}
      rows[#rows+1]=row
    end;rcon.print(helpers.table_to_json(rows))`)
  evidence.advance = { maximum_ticks: 120, maximum_wall_ms: 3000, speed: 1 }
  const advanceStarted = Date.now()
  evidence.advance.before = await lua('local until_tick=game.tick+120;script.on_nth_tick(1,function()if game.tick>=until_tick then game.tick_paused=true;script.on_nth_tick(1,nil) end end);game.speed=1;game.tick_paused=false;rcon.print(helpers.table_to_json({tick=game.tick}))')
  await new Promise(resolve => setTimeout(resolve, 500))
  evidence.advance.after = await lua('game.tick_paused=true;script.on_nth_tick(1,nil);rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed}))')
  evidence.advance.wall_ms = Date.now() - advanceStarted
  assert.ok(evidence.advance.after.tick - evidence.advance.before.tick <= 120)
  assert.ok(evidence.advance.after.tick > evidence.advance.before.tick)
  assert.ok(evidence.advance.wall_ms <= 3000)
  assert.equal(evidence.advance.after.paused, true); assert.equal(evidence.advance.after.speed, 1)
  evidence.initial = await capture()
  let request
  if (phase === 'verify') {
    const current = await native('world_identity')
    const world = current.code === 'world_unbound' ? await native('bind_world_id', randomUUID()) : current
    assert.equal(world.ok, true)
    request = { schema_version: 1, request_id: 'native-endpoint-initial', world_id: world.world_id, actor_id: actor.actor_id,
      surface_index: evidence.setup.surface_index, force_index: evidence.setup.force_index, members: evidence.setup.fixtures.map(row => row.locator) }
    evidence.observation = await native('observe', request)
    assert.equal(evidence.observation.ok, true)
  }
  evidence.quality_change = await lua(`${helpers}local f=helpers.json_to_table(${luaString(JSON.stringify(evidence.setup.fixtures.find(row => row.label === 'assembler').locator))});local e;for _,c in pairs(game.surfaces[f.surface_index].find_entities_filtered{position=f.position,radius=0.25,name=f.name,force=f.force_index,limit=9}) do if c.unit_number==f.unit_number then e=c end end;assert(e);local r,old=e.get_recipe();local names={};for n in pairs(prototypes.quality) do if n~=old.name then names[#names+1]=n end end;table.sort(names);local q=names[1];assert(q);local result=read(function()return e.set_recipe(r.name,q)end);rcon.print(helpers.table_to_json({requested=q,set_result=result}))`)
  evidence.refreshed = await capture()
  if (phase === 'verify') {
    assert.equal(evidence.setup.filtered_fixture.set_filter.value, true)
    const initialQuality = evidence.initial.find(row => row.label === 'assembler').recipe.value.quality.name
    const refreshedQuality = evidence.refreshed.find(row => row.label === 'assembler').recipe.value.quality.name
    assert.notEqual(initialQuality, refreshedQuality)
    assert.equal(refreshedQuality, evidence.quality_change.requested)
    evidence.refreshed_observation = await native('observe', { ...request, request_id: 'native-endpoint-refreshed' })
    assert.equal(evidence.refreshed_observation.ok, true)
    evidence.comparisons = []
    for (const [captureRows, observation] of [[evidence.initial, evidence.observation], [evidence.refreshed, evidence.refreshed_observation]]) {
      for (const source of captureRows) {
        const member = observation.members.find(row => row.locator.unit_number === source.locator.unit_number)
        assert.equal(member.state, 'observed')
        const endpoints = member.endpoint_facts
        assert.equal(endpoints.schema_version, 1)
        assert.equal(endpoints.identity_scope, 'enclosing_exact_member')
        assert.equal(endpoints.coverage.quality_compatibility, 'unverified')
        assert.equal(endpoints.coverage.supplier, 'unverified')
        assert.equal(endpoints.coverage.delivery, 'unverified')
        assert.equal(endpoints.inventories.state, 'known')
        assert.equal(endpoints.inventories.truncated, false)
        assert.deepEqual(list(endpoints.inventories.endpoints).map(row => [row.inventory_index, row.size]), list(source.inventories).map(row => [row.lookup_index, row.size]))
        for (const expected of list(source.inventories)) {
          const actual = list(endpoints.inventories.endpoints).find(row => row.inventory_index === expected.lookup_index)
          assert.equal(actual.state, 'known'); assert.equal(actual.endpoint_kind, 'inventory')
          assert.equal(actual.inventory_index, expected.index.value)
          const roles = list(member.inventories).filter(row => row.state === 'known' && row.index === actual.inventory_index).map(row => row.role)
          assert.deepEqual(list(actual.roles.values), roles)
          assert.equal(actual.roles.state, roles.length > 0 ? 'known' : 'unknown')
          if (!expected.filter_support.value) assert.equal(actual.filters.state, 'not_applicable')
          else {
            assert.equal(actual.filters.state, 'known'); assert.equal(actual.filters.truncated, false)
            assert.equal(list(actual.filters.slots).length, expected.size)
            for (const filter of list(expected.filters)) {
              const slot = list(actual.filters.slots).find(row => row.slot === filter.slot)
              if (filter.filter.state === 'nil') assert.deepEqual(slot, { slot: filter.slot, state: 'known', filter: 'none' })
              else { assert.equal(slot.state, 'known'); assert.deepEqual(slot.filter, filter.filter.value) }
            }
          }
        }
        assert.equal(endpoints.fluidboxes.state, 'known')
        assert.equal(endpoints.fluidboxes.truncated, false)
        assert.equal(list(endpoints.fluidboxes.endpoints).length, list(source.fluidboxes).length)
        for (const expected of list(source.fluidboxes)) {
          const actual = list(endpoints.fluidboxes.endpoints).find(row => row.fluidbox_index === expected.index)
          assert.equal(actual.state, 'known'); assert.equal(actual.endpoint_kind, 'fluidbox')
          assert.equal(actual.prototypes.state, 'known')
          assert.equal(actual.prototypes.truncated, false)
          assert.deepEqual(list(actual.prototypes.definitions).map(row => [row.prototype_index, row.production_type]), list(expected.prototype.value.definitions).map(row => [row.index, row.production_type]))
          for (const [index, definition] of list(expected.prototype.value.definitions).entries()) {
            assert.deepEqual(actual.prototypes.definitions[index].filter,
              { state: 'known', filter: definition.filter ? { name: definition.filter.name } : 'none' })
          }
          assert.equal(actual.filter.state, 'known')
          assert.deepEqual(actual.filter.filter, expected.filter.state === 'nil' ? 'none' : expected.filter.value)
          assert.deepEqual(actual.locked_fluid, expected.locked_fluid.state === 'nil'
            ? { state: 'known', locked: false } : { state: 'known', locked: true, name: expected.locked_fluid.value })
          assert.equal(actual.recipe_association.state, 'unknown')
        }
        const selected = source.recipe.value
        if (selected?.name) {
          assert.equal(endpoints.recipe_selection.recipe, selected.name)
          assert.deepEqual(endpoints.recipe_selection.quality, { state: 'known', name: selected.quality.name })
        } else assert.equal(endpoints.recipe_selection.state, source.recipe.state === 'error' ? 'not_applicable' : 'unknown')
        assert.equal(endpoints.services.electricity.state, source.electric.source.state === 'known' || source.label === 'pole' ? 'known' : 'not_applicable')
        assert.equal(endpoints.services.electricity.usage_priority, source.electric.source.value?.usage_priority)
        assert.equal(endpoints.services.electric_network.stable_endpoint, false)
        assert.equal(endpoints.services.electric_network.state, 'known')
        assert.equal(endpoints.services.electric_network.present, source.electric.network.state === 'known')
        assert.equal(endpoints.services.electric_network.electric_network_id, source.electric.network.value)
        assert.equal(endpoints.services.heat.input_source.present, source.heat.source.state === 'known')
        assert.equal(endpoints.services.heat.buffer.present, source.heat.buffer.state === 'known')
        assert.equal(endpoints.services.heat.input_source.state, 'known')
        assert.equal(endpoints.services.heat.buffer.state, 'known')
        assert.equal(endpoints.services.heat.state, source.heat.source.state === 'known' || source.heat.buffer.state === 'known' ? 'known' : 'not_applicable')
        if (source.label === 'miner' || source.label === 'inserter') {
          assert.equal(endpoints.item_drop.state, 'known')
          assert.equal(list(endpoints.item_drop.routes).length, 1)
          const drop = list(endpoints.item_drop.routes)[0]
          assert.deepEqual(drop, list(member.item_routes.routes).find(row => row.kind === 'drop'))
          assert.deepEqual(drop.position, source.drop_position.value)
          if (source.drop_target.state === 'nil') { assert.equal(drop.state, 'disconnected'); assert.equal(drop.target, undefined) }
          else {
            assert.equal(drop.state, 'connected')
            for (const [key, value] of Object.entries(source.drop_target.value)) assert.deepEqual(drop.target[key], value)
          }
          assert.equal(endpoints.item_drop.target_inventory, 'unverified')
        } else assert.equal(endpoints.item_drop.state, 'not_applicable')
        evidence.comparisons.push({ unit_number: member.unit_number, label: source.label, matched: true })
      }
    }
    evidence.fences = {}
    for (const [label, override, code] of [['world', { world_id: randomUUID() }, 'world_identity_mismatch'], ['actor', { actor_id: actor.actor_id + 1 }, 'actor_identity_mismatch'], ['surface', { surface_index: request.surface_index + 1 }, 'scope_mismatch'], ['force', { force_index: request.force_index + 1 }, 'scope_mismatch']]) {
      const result = await native('observe', { ...request, ...override }); assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.members, undefined); evidence.fences[label] = result
    }
    evidence.fences.hidden = await native('observe', { ...request, members: [{ ...request.members[0], position: { x: 100000, y: 100000 } }] })
    assert.equal(evidence.fences.hidden.members[0].code, 'member_not_visible')
    assert.equal(evidence.fences.hidden.members[0].endpoint_facts, undefined)
  }
  evidence.after = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,humans=#game.connected_players}))')
  assert.equal(evidence.after.tick, evidence.advance.after.tick); assert.equal(evidence.after.paused, true); assert.equal(evidence.after.humans, 0); assert.equal(evidence.providers, 0)
  evidence.status = 'pass'
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally { if (connection) { try { await rcon.command('/silent-command game.tick_paused=true;game.speed=1;script.on_nth_tick(1,nil)') } catch { evidence.pause_cleanup = 'unconfirmed' } } connection?.close(); await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, `native-endpoints-${phase}.json`), JSON.stringify(evidence, null, 2)); await fs.writeFile(path.join(results, `native-endpoints-${phase}-transcript.json`), JSON.stringify(trace, null, 2)) }
