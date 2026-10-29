#!/usr/bin/env node
// Parent runs this read-only API probe against an isolated owned native world.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const trace = []
const evidence = { status: 'fail', kind: 'native input requirement API availability', providers: 0 }
globalThis.fetch = async () => { evidence.providers++; throw new Error('Providers forbidden') }
let connection
try {
  connection = new Rcon(Number(arg('rcon-port')), 'offline-fixture-only')
  await connection.connect()
  const run = async body => { const command = `/silent-command ${body}`; const response = await connection.command(command); trace.push({ command, response }); return JSON.parse(response) }
  evidence.before = await run('game.tick_paused=true; rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,humans=#game.connected_players,version=script.active_mods.base,active_mods=script.active_mods}))')
  assert.equal(evidence.before.paused, true); assert.equal(evidence.before.humans, 0); assert.equal(evidence.before.version, '2.0.77')
  evidence.prototypes = await run(`
    local function read(f) local ok,v=pcall(f); if not ok then return {state="error",error=tostring(v)} end; if v==nil then return {state="nil"} end; return {state="known",value=v} end
    local function source(p,k) return read(function() local s=p[k];if not s then return nil end;local r={native_type=type(s)};for _,f in pairs({"usage_priority","fuel_categories","burns_fluid","scale_fluid_usage","effectivity","filter","maximum_temperature","minimum_temperature"}) do r[f]=read(function() local v=s[f];if type(v)=="userdata" then return {name=v.name} end;return v end) end;return r end) end
    local wanted={"mining-drill","furnace","assembling-machine","offshore-pump","pump","boiler","generator","electric-pole","inserter","storage-tank","pipe","accumulator","solar-panel","reactor","lab"};local out={}
    for _,kind in pairs(wanted) do local names={};for n,p in pairs(prototypes.entity) do if p.type==kind then names[#names+1]=n end end;table.sort(names);for i=1,math.min(#names,8) do local p=prototypes.entity[names[i]];local r={name=p.name,type=p.type};for _,k in pairs({"electric_energy_source_prototype","burner_prototype","fluid_energy_source_prototype","heat_energy_source_prototype","void_energy_source_prototype"}) do r[k]=source(p,k) end
      r.fluidboxes=read(function() local rows={};for i,b in pairs(p.fluidbox_prototypes) do local row={key=i};for _,f in pairs({"index","production_type","volume","filter","minimum_temperature","maximum_temperature"}) do row[f]=read(function() local v=b[f];if type(v)=="userdata" then return {name=v.name} end;return v end) end;rows[#rows+1]=row end;return rows end)
      r.fluid_usage_per_tick=read(function()return p.get_fluid_usage_per_tick()end);r.max_energy_usage=read(function()return p.get_max_energy_usage()end);out[#out+1]=r
    end end;rcon.print(helpers.table_to_json(out))`)
  evidence.resources = await run(`local out={};for n,p in pairs(prototypes.entity) do if p.type=="resource" then local m=p.mineable_properties;out[#out+1]={name=n,category=p.resource_category,required_fluid=m.required_fluid,fluid_amount=m.fluid_amount,products=m.products} end end;rcon.print(helpers.table_to_json(out))`)
  evidence.recipes = await run(`local out={};local item,fluid=false,false;for n,r in pairs(prototypes.recipe) do local has=false;for _,i in pairs(r.ingredients) do if i.type=="fluid" then has=true end end;if (has and not fluid) or (not has and not item) then out[#out+1]={name=n,category=r.category,ingredients=r.ingredients};if has then fluid=true else item=true end end;if item and fluid then break end end;rcon.print(helpers.table_to_json(out))`)
  evidence.after = await run('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,humans=#game.connected_players}))')
  assert.equal(evidence.after.tick, evidence.before.tick); assert.equal(evidence.after.paused, true); assert.equal(evidence.after.humans, 0)
  evidence.status = 'pass'
} catch (error) { evidence.error = String(error?.stack ?? error); process.exitCode = 1 }
finally { connection?.close(); await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'input-requirements-probe.json'), JSON.stringify(evidence, null, 2)); await fs.writeFile(path.join(results, 'input-requirements-probe-transcript.json'), JSON.stringify(trace, null, 2)) }
