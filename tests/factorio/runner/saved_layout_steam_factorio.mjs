#!/usr/bin/env node
// Offline A1 mechanics replay of an immutable captured save. No provider or
// Session runs, no goal is resumed, and every gameplay mutation uses the same
// structured operations and epoch-checked admission as the runtime.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'

globalThis.fetch = async () => { throw new Error('network/model inference forbidden in saved-layout replay') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = []; const evidence = { rung: 'A1 deterministic saved-layout mechanics; not autonomous success' }
let connection
const rcon = { command: async (command, options) => {
  const response = await connection.command(command, options)
  transcript.push({ command, response: String(response) }); return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); ${body}`))
const observe = async (method, args = '') => lua(`rcon.print(helpers.table_to_json(remote.call("autorio_tools","${method}"${args ? `,${args}` : ''})))`)
const snapshot = () => lua(`local entities={}; for _,e in pairs(a.surface.find_entities_filtered{force=a.force,name={"offshore-pump","boiler","pipe","steam-engine","small-electric-pole","inserter"}}) do
 local d={name=e.name,id=e.unit_number,position=e.position,direction=e.direction,energy=e.energy,status=e.status,fluid_targets={}};
 for i=1,#e.fluidbox do for _,c in pairs(e.fluidbox.get_pipe_connections(i)) do local t=c.target and c.target.owner; if t and t.valid then d.fluid_targets[#d.fluid_targets+1]=t.unit_number end end end;
 if e.name=="steam-engine" then d.generation=e.energy_generated_last_tick; d.network=e.electric_network_id; local f=e.fluidbox[1]; d.steam=f and f.amount or 0 end;
 if e.name=="inserter" then d.network=e.electric_network_id end;
 if e.name=="boiler" then d.fuel=e.get_fuel_inventory().get_contents(); d.remaining_fuel=e.burner.remaining_burning_fuel; d.water=e.fluidbox[1]; d.steam=e.fluidbox[2] end;
 entities[#entities+1]=d end;
 local o=remote.call("autorio_operations","status"); rcon.print(helpers.table_to_json({actor_id=a.unit_number,position=a.position,inventory=a.get_main_inventory().get_contents(),entities=entities,tick=game.tick,humans=#game.connected_players,speed=game.speed,queue_length=o.queue_length,task_state=o.task_state,last_cancelled=o.last_cancelled_batch,artificial=a.surface.count_entities_filtered{type={"electric-energy-interface","solar-panel","accumulator"}}}))`)
async function idle() {
 const deadline=Date.now()+120000
 for (;;) { const s=await snapshot(); assert.equal(s.humans,0); assert.equal(s.speed,1); assert.equal(s.artificial,0)
  if(s.queue_length===0 && s.task_state==='idle') return s
  assert(Date.now()<deadline,'native operation did not settle'); await delay(200) }
}
async function operation(name,args) {
 const before=await snapshot()
 const status=await deploymentStatus(rcon,{requireAllowed:true})
 assert.equal(status.actor_id,evidence.before.actor_id,'actor identity must remain stable')
 const command=renderOperation(parseOperation({name,args}))
 const receipt=await executeAuthorizedBatch(rcon,status.epoch,[command])
 evidence.operations??=[]; evidence.operations.push({name,args,epoch:status.epoch,receipt})
 const after=await idle()
 assert.equal(after.last_cancelled?.batch_id,before.last_cancelled?.batch_id,`${name}: newly cancelled native batch`)
 return after
}
const held=(s,name)=>s.inventory.filter(x=>x.name===name).reduce((n,x)=>n+x.count,0)
try {
 await fs.mkdir(results,{recursive:true})
 const deadline=Date.now()+30000
 for (;;) { connection=new Rcon(Number(arg('port')),arg('password'),15000,{host:'127.0.0.1'}); try { await connection.connect(); break } catch(error) { connection.close(); assert(Date.now()<deadline,String(error)); await delay(250) } }
 await configureNpcSession(rcon,'run-w-offline-saved-layout-20261017')
 evidence.before=await idle()
 assert.equal(evidence.before.actor_id,10)
 assert.equal(held(evidence.before,'steam-engine'),1)
 assert.equal(evidence.before.entities.filter(e=>e.name==='steam-engine').length,0)
 assert.equal(evidence.before.entities.filter(e=>e.name==='small-electric-pole').length,2)
 evidence.boiler=await observe('get_entity_status','nil,nil,21')
 assert.equal(evidence.boiler.entity.unit_number,21)
 evidence.candidates=await observe('get_placement_candidates','{entity_name="steam-engine",connects_to={unit_number=21,storage_index=2},limit=8}')
 evidence.layoutDiagnostic=await lua('local entities={}; for _,e in pairs(a.surface.find_entities_filtered{area={{-25,-97},{-17,-85}}}) do entities[#entities+1]={name=e.name,type=e.type,id=e.unit_number,position=e.position,box=e.bounding_box} end; local tiles={}; for x=-24,-19 do for y=-94,-89 do local t=a.surface.get_tile(x,y); tiles[#tiles+1]={name=t.name,x=x,y=y} end end; rcon.print(helpers.table_to_json({entities=entities,tiles=tiles,engine_collision_box=prototypes.entity["steam-engine"].collision_box,engine_selection_box=prototypes.entity["steam-engine"].selection_box,can_place=a.surface.can_place_entity{name="steam-engine",position={-21.5,-91.5},direction=0,force=a.force}}))')
 assert.equal(evidence.candidates.ok,true)
 if (!evidence.candidates.candidates?.length) {
  evidence.exactLayout={status:'blocked',reason:'no legal connected steam-engine candidate on exact saved layout'}
  evidence.counterfactual='Scripted layout repair on copied save: craft two pipes from held iron, turn steam inland, clear bounded natural obstruction, then fresh engine candidates. Existing buildings and both saved poles remain. This is not autonomous recovery.'
  evidence.pipeCraft=await operation('craft_item',{item_name:'pipe',count:1})
  evidence.pipeCandidates=await observe('get_placement_candidates','{entity_name="pipe",connects_to={unit_number=21,storage_index=2},limit=8}')
  assert(evidence.pipeCandidates.candidates?.length,'no legal steam outlet pipe candidate')
  const pipe=evidence.pipeCandidates.candidates[0]
  evidence.afterPipe=await operation('place_candidate',{candidate_set_id:evidence.pipeCandidates.candidate_set_id,candidate_id:pipe.id})
  evidence.pipeStatus=await observe('get_entity_status','"pipe",16')
  assert(evidence.pipeStatus.entity?.unit_number)
  evidence.pipeId=evidence.pipeStatus.entity.unit_number
  evidence.repairedCandidates=await observe('get_placement_candidates',`{entity_name="steam-engine",connects_to={unit_number=${evidence.pipeId}},limit=8}`)
  if (!evidence.repairedCandidates.candidates?.length) {
   evidence.afterClearing=await operation('clear_construction_area',{x:-24.5,y:-93.5,width:7,height:5})
   evidence.afterClearingCandidates=await observe('get_placement_candidates',`{entity_name="steam-engine",connects_to={unit_number=${evidence.pipeId}},limit=8}`)
   if (!evidence.afterClearingCandidates.candidates?.length) {
    evidence.secondPipeCraft=await operation('craft_item',{item_name:'pipe',count:1})
    evidence.secondPipeCandidates=await observe('get_placement_candidates',`{entity_name="pipe",connects_to={unit_number=${evidence.pipeId},storage_index=1,connection_index=4},limit=8}`)
    assert(evidence.secondPipeCandidates.candidates?.length,'no legal inland pipe candidate')
    const p=evidence.secondPipeCandidates.candidates[0]
    await operation('place_candidate',{candidate_set_id:evidence.secondPipeCandidates.candidate_set_id,candidate_id:p.id})
    evidence.secondPipeStatus=await lua(`local p=a.surface.find_entities_filtered{name="pipe",position={${p.position.x},${p.position.y}},radius=0.1}[1]; assert(p); rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",nil,nil,p.unit_number)))`)
    evidence.pipeId=evidence.secondPipeStatus.entity.unit_number
    evidence.routedCandidates=await observe('get_placement_candidates',`{entity_name="steam-engine",connects_to={unit_number=${evidence.pipeId}},limit=8}`)
   }
  }
 }
 {
  const set=evidence.routedCandidates??evidence.afterClearingCandidates??evidence.repairedCandidates??evidence.candidates
  assert(set.candidates?.length,'no connected engine candidate after bounded pipe route/clearing')
  const candidate=set.candidates[0]
  evidence.selected=candidate
  evidence.afterPlacement=await operation('place_candidate',{candidate_set_id:set.candidate_set_id,candidate_id:candidate.id})
  assert.equal(held(evidence.afterPlacement,'steam-engine'),0)
  const engine=evidence.afterPlacement.entities.find(e=>e.name==='steam-engine'); assert(engine)
  assert(engine.fluid_targets.includes(evidence.pipeId??21),'engine must connect to observed steam source')
  evidence.engineStatus=await observe('get_entity_status',`nil,nil,${engine.id}`)
  // A real inserter can be hand-crafted from the final held plates and copper.
  // Its native electric drain provides a load without adding artificial stock.
  evidence.loadCraft=await operation('craft_item',{item_name:'inserter',count:1})
  assert.equal(held(evidence.loadCraft,'inserter'),1)
  const savedPole=evidence.afterPlacement.entities.find(e=>e.id===22)
  evidence.loadCandidates=await observe('get_placement_candidates',`{entity_name="inserter",center={x=${savedPole.position.x},y=${savedPole.position.y}},radius=3,limit=8}`)
  const coverage=await lua('rcon.print(helpers.table_to_json({distance=prototypes.entity["small-electric-pole"].get_supply_area_distance()}))')
  evidence.polePrototype=coverage
  const poles=evidence.afterPlacement.entities.filter(e=>e.name==='small-electric-pole')
  const load=evidence.loadCandidates.candidates.find(c=>poles.some(p=>Math.abs(c.position.x-p.position.x)<=coverage.distance && Math.abs(c.position.y-p.position.y)<=coverage.distance))
  assert(load,'no legal inserter candidate within saved pole coverage')
  evidence.selectedLoad=load
  await operation('place_candidate',{candidate_set_id:evidence.loadCandidates.candidate_set_id,candidate_id:load.id})
  evidence.samples=[]
  const powerDeadline=Date.now()+20000
  for (;;) { const s=await snapshot(); evidence.samples.push(s); const e=s.entities.find(e=>e.name==='steam-engine'); const l=s.entities.find(e=>e.name==='inserter')
   if(e.generation>0 && e.steam>0 && l.energy>0 && Number.isSafeInteger(e.network) && e.network>0 && l.network===e.network) { evidence.after=s; break }
   assert(Date.now()<powerDeadline,'native steam failed to power the crafted load'); await delay(200) }
  evidence.steadySamples=[]
  for(let i=0;i<3;i++) {
   await delay(1000)
   const s=await snapshot(); const e=s.entities.find(e=>e.name==='steam-engine'); const l=s.entities.find(e=>e.name==='inserter')
   assert(e.steam>0 && e.generation>0 && l.energy>0 && Number.isSafeInteger(e.network) && e.network>0 && e.network===l.network,'native steam must continue powering the real inserter drain')
   assert.deepEqual(s.entities.filter(e=>e.name==='small-electric-pole').map(e=>e.id),[22,23])
   evidence.steadySamples.push(s)
  }
  evidence.after=evidence.steadySamples.at(-1)
  const pipes=evidence.after.entities.filter(e=>e.name==='pipe')
  assert(pipes.find(e=>e.id===evidence.pipeStatus.entity.unit_number).fluid_targets.includes(21))
  assert(pipes.find(e=>e.id===evidence.pipeId).fluid_targets.includes(engine.id))
  assert.equal(held(evidence.after,'steam-engine'),0)
  assert.equal(held(evidence.after,'inserter'),0)
  assert.equal(evidence.after.actor_id,evidence.before.actor_id)
  evidence.status='pass'
 }
 console.log(JSON.stringify({status:evidence.status,blocker:evidence.blocker,candidates:evidence.candidates.candidates?.length,operations:evidence.operations?.map(o=>o.name)}))
} catch(error) { evidence.status='error'; evidence.error=error.stack; throw error }
finally { connection?.close(); await fs.writeFile(path.join(results,'saved-layout-proof.json'),JSON.stringify(evidence,null,2)); await fs.writeFile(path.join(results,'saved-layout-transcript.json'),JSON.stringify(transcript,null,2)) }
