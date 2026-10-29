#!/usr/bin/env node
// Deterministic static native fixtures, not autonomous gameplay/production proof.
// Parent owns fresh compiled mods, test fixture mod, copied save and teardown.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', kind: 'static exact-version native input requirement proof', providers: 0, comparisons: [] }
const trace = []
globalThis.fetch = async () => { evidence.providers++; throw new Error('Providers forbidden') }
const list = value => { if (Array.isArray(value)) return value; assert.deepEqual(value, {}, 'only native empty table normalizes to empty array'); return [] }
let connection
const rcon = { command: async command => { const response = await connection.command(command); trace.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const native = async (method, payload) => lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory",${luaString(method)}${payload === undefined ? '' : `,${typeof payload === 'string' ? luaString(payload) : `helpers.json_to_table(${luaString(JSON.stringify(payload))})`}`})))`)
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('rcon-port')), 'offline-fixture-only')
  await connection.connect()
  evidence.before = await lua('game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,humans=#game.connected_players,paused=game.tick_paused,active_mods=script.active_mods}))')
  assert.equal(evidence.before.active_mods.base, '2.0.77'); assert.equal(evidence.before.active_mods['factory-input-requirements-fixture'], '0.0.1')
  assert.equal(evidence.before.humans, 0); assert.equal(evidence.before.paused, true)
  await configureNpcSession(rcon, 'factory-input-requirements-native')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  let world = await native('world_identity')
  if (world.code === 'world_unbound') world = await native('bind_world_id', randomUUID())
  assert.equal(world.ok, true)
  // All fixture changes are declared test setup in an owned copy. Recipes and
  // deposit selections come from this engine's actual data, not authored bills.
  evidence.setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local ox=math.floor(a.position.x);local oy=math.floor(a.position.y)
    for _,e in pairs(s.find_entities_filtered{area={{ox-18,oy-18},{ox+18,oy+18}}}) do if e~=a and e.name~="sgluna-npc-vision" then e.destroy() end end
    local tiles={};for x=ox-18,ox+18 do for y=oy-18,oy+18 do tiles[#tiles+1]={name="landfill",position={x,y}} end end;s.set_tiles(tiles,true,false,true)
    local specs={{"item-recipe","assembling-machine-2",-12,-12},{"fluid-recipe","chemical-plant",-6,-12},{"second-fluid-recipe","oil-refinery",2,-12},{"dormant","stone-furnace",12,-12},{"boiler","boiler",-12,-4},{"generator","steam-engine",-6,-4},{"heat","heat-exchanger",6,-4},{"pipe","pipe",12,-4},{"burner","burner-inserter",-12,4},{"electric","inserter",-6,4},{"pole","small-electric-pole",6,4},{"storage","accumulator",12,4},{"mining-fluid","electric-mining-drill",-12,12},{"truncated","factory-input-bound-machine",-4,12},{"unsupported","lab",6,12},{"mining-dry","electric-mining-drill",12,12}}
    local function quality(q) if q==nil then return {state="nil"} end;local ok,n=pcall(function()return q.name end);return {state=ok and "known" or "error",native_type=type(q),name=ok and n or nil,error=not ok and tostring(n) or nil} end;local rows={};for _,v in pairs(specs) do local e=s.create_entity{name=v[2],position={ox+v[3],oy+v[4]},force=a.force};assert(e,v[2]);local row={label=v[1],locator={unit_number=e.unit_number,name=e.name,position=e.position,surface_index=s.index,force_index=e.force.index}}
      if v[1]=="item-recipe" or v[1]=="fluid-recipe" or v[1]=="second-fluid-recipe" then local recipes={};for n,r in pairs(a.force.recipes) do local hasfluid=false;for _,i in pairs(r.ingredients) do if i.type=="fluid" then hasfluid=true end end;if e.prototype.crafting_categories[r.category] and ((v[1]=="item-recipe" and not hasfluid) or (v[1]~="item-recipe" and hasfluid)) then recipes[#recipes+1]=n end end;table.sort(recipes);for _,n in pairs(recipes) do local ok=pcall(function()e.set_recipe(n)end);local r,q=e.get_recipe();if ok and r and r.name==n then row.recipe={name=r.name,ingredients=r.ingredients,quality=quality(q)};break end end;assert(row.recipe,"no native compatible fixture recipe: "..v[1]) end
      if v[1]=="truncated" then e.set_recipe("factory-input-bound-recipe");local r,q=e.get_recipe();assert(r and #r.ingredients==25);row.recipe={name=r.name,ingredients=r.ingredients,quality=quality(q)} end
      if v[1]=="mining-fluid" or v[1]=="mining-dry" then local names={};for n,p in pairs(prototypes.entity) do if p.type=="resource" and ((v[1]=="mining-fluid" and p.mineable_properties.required_fluid) or (v[1]=="mining-dry" and not p.mineable_properties.required_fluid)) and e.prototype.resource_categories[p.resource_category] then names[#names+1]=n end end;table.sort(names);assert(names[1]);local p=prototypes.entity[names[1]];assert(s.create_entity{name=p.name,position=e.position,amount=1000});row.deposit={name=p.name,required_fluid=p.mineable_properties.required_fluid,fluid_amount=p.mineable_properties.fluid_amount} end
      local p=e.prototype;local b=p.burner_prototype;if b then row.fuel_categories={};for n,ok in pairs(b.fuel_categories) do if ok then row.fuel_categories[#row.fuel_categories+1]=n end end;table.sort(row.fuel_categories) end
      local electric=p.electric_energy_source_prototype;row.energy={electric_priority=electric and electric.usage_priority,heat=p.heat_energy_source_prototype~=nil}
      row.fluid_inputs={};if e.type=="boiler" or e.type=="generator" then for _,f in pairs(p.fluidbox_prototypes) do if f.production_type=="input" or f.production_type=="input-output" then row.fluid_inputs[#row.fluid_inputs+1]={name=f.filter and f.filter.name,fluidbox_index=f.index,minimum_temperature=f.minimum_temperature,maximum_temperature=f.maximum_temperature} end end end
      rows[#rows+1]=row
    end;rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index,force_index=a.force.index,fixtures=rows}))`)
  const request = { schema_version: 1, request_id: 'native-input-requirements', world_id: world.world_id, actor_id: actor.actor_id,
    surface_index: evidence.setup.surface_index, force_index: evidence.setup.force_index, members: evidence.setup.fixtures.map(row => row.locator) }
  evidence.observation = await lua(`local before=helpers.table_to_json(storage.sgluna_entity_reference_hints or {});local id=storage.sgluna_factory_world_id;local result=remote.call("sgluna_factory","observe",helpers.json_to_table(${luaString(JSON.stringify(request))}));assert(before==helpers.table_to_json(storage.sgluna_entity_reference_hints or {}));assert(id==storage.sgluna_factory_world_id);rcon.print(helpers.table_to_json(result))`)
  assert.equal(evidence.observation.ok, true)
  const rows = evidence.observation.members
  for (const fixture of evidence.setup.fixtures) {
    const member = rows.find(row => row.locator.unit_number === fixture.locator.unit_number)
    assert.equal(member.state, 'observed', JSON.stringify({ fixture, member }))
    const input = member.input_requirements
    assert.equal(input.schema_version, 1)
    for (const field of ['supply', 'delivery', 'external_source', 'automation']) assert.equal(input[field], 'unverified')
    if (fixture.recipe && fixture.label !== 'truncated') {
      for (const [domain, kind] of [['material', 'item'], ['fluid', 'fluid']]) {
        const expected = fixture.recipe.ingredients.filter(row => row.type === kind)
        assert.equal(input[domain].state, expected.length ? 'known' : 'not_applicable')
        assert.equal(input[domain].required, expected.length > 0)
        const fields = ({ name, amount, minimum_temperature, maximum_temperature, temperature }) => ({ name, amount, minimum_temperature, maximum_temperature, temperature })
        assert.deepEqual(list(input[domain].inputs).map(fields), expected.map(fields))
      }
    }
    if (fixture.fuel_categories !== undefined) {
      assert.equal(input.fuel.required, true); assert.equal(input.fuel.state, 'known')
      assert.deepEqual(list(input.fuel.inputs)[0].accepted_categories, fixture.fuel_categories)
      assert.deepEqual(member.burner_fuel_requirement.fuel_categories, fixture.fuel_categories)
    } else { assert.equal(input.fuel.required, false); assert.equal(input.fuel.state, 'not_applicable'); assert.deepEqual(list(input.fuel.inputs), []) }
    if (fixture.fluid_inputs && list(fixture.fluid_inputs).length) {
      assert.equal(input.fluid.state, 'known')
      assert.deepEqual(list(input.fluid.inputs).map(({ name, fluidbox_index, minimum_temperature, maximum_temperature }) => ({ name, fluidbox_index, minimum_temperature, maximum_temperature })),
        fixture.fluid_inputs.map(({ name, fluidbox_index, minimum_temperature, maximum_temperature }) => ({ name, fluidbox_index, minimum_temperature, maximum_temperature })))
    }
    if (fixture.deposit?.required_fluid) {
      assert.equal(input.fluid.state, 'known')
      assert.deepEqual(list(input.fluid.inputs).map(({ name, native_fluid_amount, resource_name }) => ({ name, native_fluid_amount, resource_name })), [{ name: fixture.deposit.required_fluid, native_fluid_amount: fixture.deposit.fluid_amount, resource_name: fixture.deposit.name }])
    }
    if (fixture.label === 'mining-dry') { assert.equal(input.fluid.state, 'not_applicable'); assert.equal(input.fluid.required, false); assert.deepEqual(list(input.fluid.inputs), []) }
    if (fixture.label === 'dormant') { for (const kind of ['material', 'fluid']) { assert.equal(input[kind].state, 'unknown'); assert.equal(input[kind].code, 'current_recipe_unset') } }
    if (fixture.label === 'truncated') { for (const kind of ['material', 'fluid']) { assert.equal(input[kind].state, 'unknown'); assert.equal(input[kind].truncated, true); assert.equal(input[kind].code, 'recipe_ingredients_truncated'); assert.deepEqual(list(input[kind].inputs), []) } }
    if (fixture.label === 'unsupported') assert.equal(input.material.code, 'material_process_unsupported')
    const energy = fixture.energy
    if (energy.heat) { assert.equal(input.power.required, true); assert.equal(list(input.power.inputs)[0].kind, 'heat') }
    else if (['secondary-input', 'managed-accumulator'].includes(energy.electric_priority)) { assert.equal(input.power.required, true); assert.equal(list(input.power.inputs)[0].kind, 'electricity') }
    else { assert.equal(input.power.required, false); assert.equal(input.power.state, 'not_applicable') }
    assert.equal(input.coverage.state, ['dormant', 'truncated', 'unsupported'].includes(fixture.label) ? 'partial' : 'complete')
    evidence.comparisons.push({ label: fixture.label, unit_number: member.unit_number, native_inputs_match: true, coverage: input.coverage.state })
  }
  evidence.fences = {}
  for (const [label, override, code] of [['world', { world_id: randomUUID() }, 'world_identity_mismatch'], ['actor', { actor_id: actor.actor_id + 1 }, 'actor_identity_mismatch'], ['surface', { surface_index: request.surface_index + 1 }, 'scope_mismatch'], ['force', { force_index: request.force_index + 1 }, 'scope_mismatch']]) {
    const result = await native('observe', { ...request, ...override }); assert.equal(result.ok, false); assert.equal(result.code, code); evidence.fences[label] = result
  }
  const locator = request.members[0]
  evidence.refresh = await lua(`local s=game.surfaces[${locator.surface_index}];local e;for _,candidate in pairs(s.find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},radius=0.25,force=${locator.force_index},limit=9}) do if candidate.unit_number==${locator.unit_number} and candidate.position.x==${locator.position.x} and candidate.position.y==${locator.position.y} then e=candidate end end;assert(e);local old=e.get_recipe().name;local names={};for n,r in pairs(e.force.recipes) do if n~=old and e.prototype.crafting_categories[r.category] then local fluid=false;for _,i in pairs(r.ingredients) do if i.type=="fluid" then fluid=true end end;if not fluid then names[#names+1]=n end end end;table.sort(names);local chosen;for _,n in pairs(names) do local ok=pcall(function()e.set_recipe(n)end);local r=e.get_recipe();if ok and r and r.name==n then chosen={name=r.name,ingredients=r.ingredients};break end end;assert(chosen);rcon.print(helpers.table_to_json({old=old,current=chosen}))`)
  evidence.refreshed_observation = await native('observe', { ...request, request_id: 'native-input-requirements-refreshed', members: [locator] })
  const refreshed = evidence.refreshed_observation.members[0].input_requirements.material
  assert.notEqual(evidence.refresh.current.name, evidence.refresh.old)
  assert.equal(refreshed.state, 'known')
  assert.ok(list(refreshed.inputs).every(input => input.recipe === evidence.refresh.current.name))
  assert.deepEqual(list(refreshed.inputs).map(({ name, amount }) => ({ name, amount })), evidence.refresh.current.ingredients.map(({ name, amount }) => ({ name, amount })))
  evidence.fences.hidden = await native('observe', { ...request, members: [{ ...locator, position: { x: 100000, y: 100000 } }] })
  assert.equal(evidence.fences.hidden.members[0].code, 'member_not_visible'); assert.equal(evidence.fences.hidden.members[0].input_requirements, undefined)
  evidence.replacement = await lua(`local s=game.surfaces[${locator.surface_index}];local e;for _,candidate in pairs(s.find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},radius=0.25,force=${locator.force_index},limit=9}) do if candidate.unit_number==${locator.unit_number} and candidate.position.x==${locator.position.x} and candidate.position.y==${locator.position.y} then e=candidate end end;assert(e);local p=e.position;local f=e.force;local n=e.name;e.destroy();local replacement=s.create_entity{name=n,position=p,force=f};assert(replacement);rcon.print(helpers.table_to_json({unit_number=replacement.unit_number}))`)
  assert.notEqual(evidence.replacement.unit_number, locator.unit_number)
  evidence.fences.replacement = await native('observe', { ...request, members: [locator] })
  assert.equal(evidence.fences.replacement.members[0].code, 'member_not_found'); assert.equal(evidence.fences.replacement.members[0].input_requirements, undefined)
  evidence.after = await lua('rcon.print(helpers.table_to_json({tick=game.tick,humans=#game.connected_players,paused=game.tick_paused}))')
  assert.equal(evidence.after.tick, evidence.before.tick); assert.equal(evidence.after.humans, 0); assert.equal(evidence.after.paused, true); assert.equal(evidence.providers, 0)
  evidence.status = 'pass'
  console.log(`PASS: ${evidence.comparisons.length} native requirement fixtures; native selectors, unknowns, bounds and exact identity fences`)
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally { connection?.close(); await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'input-requirements-native.json'), JSON.stringify(evidence, null, 2)); await fs.writeFile(path.join(results, 'input-requirements-native-transcript.json'), JSON.stringify(trace, null, 2)) }
