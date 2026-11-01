// Run AA: real copper-to-iron furnace reuse, exact native admission proof,
// correction and semantic iron production. No model or Jev calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Rcon} from '../pterodactyl/runtime-v8/common.mjs'
import {configureNpcSession, deploymentStatus} from '../pterodactyl/staging/supervisor-adapter.mjs'
import {operationSignature, buildPendingOperation, batchWatermark, reconcilePendingOperation} from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'

globalThis.fetch=async()=>{throw new Error('Inference is forbidden in zero-transfer native regression')}
const arg=name=>{const i=process.argv.indexOf(`--${name}`);assert.ok(i>=0);return process.argv[i+1]}
const results=path.resolve(arg('results'))
const rcon=new Rcon(Number(arg('port')),arg('password'),15000,{host:arg('host')})
const transcript=[]
const command=async text=>{const answer=await rcon.command(text);transcript.push({command:text,answer});return answer}
const json=async body=>JSON.parse(await command(`/silent-command ${body}`))
const status=async()=>json('rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))')
let ordinal=0
let identity
const records=[]
const until=async(label,read)=>{
 const deadline=Date.now()+240000
 for(;;){const result=await read();if(result)return result;assert.ok(Date.now()<deadline,label);await delay(100)}
}
const snapshot=()=>json(`local a=game.get_entity_by_unit_number(${identity.actor_id});local f=game.surfaces["zero-transfer"].find_entities_filtered{name="stone-furnace"}[1];assert(f and f.unit_number==storage.zero_transfer_furnace);`
 +`local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;`
 +`rcon.print(helpers.table_to_json({tick=game.tick,actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,held=counts(a.get_main_inventory()),`
 +`output=counts(f.get_output_inventory()),source=counts(f.get_inventory(defines.inventory.crafter_input)),fuel=counts(f.get_fuel_inventory()),`
 +`iron=a.force.get_item_production_statistics(f.surface).get_input_count("iron-plate"),copper=a.force.get_item_production_statistics(f.surface).get_input_count("copper-plate")}))`)
async function run(operations,expectRefusal=false){
 const before=await status()
 const key=`zero-transfer/op-${++ordinal}`
 const signature=operationSignature(operations)
 const stamp={operation_key:key,attempt_id:key,signature,ordinal,operation_count:operations.length,actor_id:identity.actor_id,epoch:identity.epoch}
 const pending=buildPendingOperation({requestId:'zero-transfer',operationKey:key,attemptId:key,ordinal,protocolVersion:2,operations,actor:identity,baseline:batchWatermark(before)})
 const response=await json(`local id=helpers.json_to_table(${JSON.stringify(JSON.stringify(stamp))});`
 +`assert(remote.call("autorio_operation_admission","begin",id).ok);${
 operations.map((op,index)=>{
  const a=op.args
  const call=op.name==='move_items'
   ? `remote.call("autorio_operations","move_items",${JSON.stringify(a.item_name)},"stone-furnace",${a.max_count},${a.to_entity})`
   : `remote.call("autorio_operations","move_items_exact",${JSON.stringify(a.item_name)},${a.unit_number},${a.max_count},${a.to_entity})`
  return `local before=remote.call("autorio_operations","status"); local ok,result=pcall(function() return ${call} end); assert(ok and result[1]); local after=remote.call("autorio_operations","status"); local refs={}; if after.active_batch then refs[1]={batch_id=after.active_batch.batch_id,batch_generation=after.active_batch.batch_generation,batch_ref=after.active_batch.batch_ref} end; assert(remote.call("autorio_operation_admission","slot",id.operation_key,${index+1},{ok=true,operation=${JSON.stringify(op.name)},batch_refs=refs,queued_tasks=1}).ok);`
 }).join('')
 }assert(remote.call("autorio_operation_admission","finish",id.operation_key,{ok=true}).ok);rcon.print(helpers.table_to_json({ok=true}))`)
 assert.equal(response.ok,true)
 const terminal=await until('native queue drains',async()=>{const s=await status();return s.task_state==='idle'&&s.queue_length===0?s:false})
 terminal.admission_journal=(await json('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')).records
 const reconciled=reconcilePendingOperation(pending,{status:terminal,actor:identity})
 records.push({stamp,pending,terminal,reconciled})
 if(expectRefusal){
  assert.equal(terminal.basic_operation.last_result.code,'nothing_moved')
  assert.equal(terminal.basic_operation.last_result.moved_count,0)
  assert.equal(terminal.basic_operation.last_result.source_removed_count,0)
  assert.equal(terminal.last_cancelled_batch.failed_before_mutation,true)
  assert.equal(reconciled.verdict,'refused_before_mutation')
  assert.equal(reconciled.effect,'not_happened')
  // Delivery count alone is never accepted: removing the exact native proof
  // and its derived admission witness restores the uncertainty fence.
  const corrupt=structuredClone(terminal)
  delete corrupt.last_cancelled_batch.failed_before_mutation
  for(const receipt of corrupt.receipt_journal)delete receipt.failed_before_mutation
  const admission=corrupt.admission_journal.find(x=>x.operation_key===key)
  admission.state='uncertain';delete admission.proven_refusal;delete admission.applied_slot_count
  assert.equal(reconcilePendingOperation(pending,{status:corrupt,actor:identity}).effect,'partial_unknown')
  const wrongEpoch=structuredClone(terminal)
  wrongEpoch.admission_journal.find(x=>x.operation_key===key).epoch++
  assert.equal(reconcilePendingOperation(pending,{status:wrongEpoch,actor:identity}).reason,'admission_lineage_mismatch')
  // A historical no-effect receipt survives a new actor epoch; it grants no
  // permission to execute. Native begin must still reject a stale epoch.
  const stale={...stamp,operation_key:`${key}-stale`,attempt_id:`${key}-stale`,ordinal:ordinal+1,epoch:identity.epoch+1}
  const denied=await json(`rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","begin",helpers.json_to_table(${JSON.stringify(JSON.stringify(stale))}))))`)
  assert.equal(denied.ok,false)
  assert.equal(denied.error,'stale_actor_epoch')
 }
 return terminal
}
try{
 await fs.mkdir(results,{recursive:true})
 await rcon.connect()
 await configureNpcSession({command},'zero-transfer-session')
 identity=await deploymentStatus({command},{requireAllowed:true})
 const fixture=await json(`local a=game.get_entity_by_unit_number(${identity.actor_id});assert(a);game.speed=1;remote.call("autorio_operations","cancel_all_tasks");`
 +`local s=game.create_surface("zero-transfer",{seed=424242,width=64,height=64,water=0,autoplace_settings={entity={treat_missing_as_default=false,settings={}}}});`
 +`s.request_to_generate_chunks({0,0},1);s.force_generate_chunk_requests();for _,e in pairs(s.find_entities()) do e.destroy() end;`
 +`local tiles={};for x=-16,16 do for y=-16,16 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles);assert(a.teleport({0,3},s));`
 +`local inv=a.get_main_inventory();inv.clear();assert(inv.insert{name="copper-ore",count=10}==10);assert(inv.insert{name="iron-ore",count=50}==50);assert(inv.insert{name="coal",count=10}==10);`
 +`local f=s.create_entity{name="stone-furnace",position={0,0},force=a.force};assert(f);storage.zero_transfer_furnace=f.unit_number;`
 +`rcon.print(helpers.table_to_json({furnace=f.unit_number,engine=script.active_mods.base}))`)
 // Fixture setup ends: all inventory changes and production below use the
 // real bounded transfer APIs and real furnace crafting, without world edits.
 const move=(item,count,to_entity,exact=false)=>({name:exact?'move_items_exact':'move_items',args:{item_name:item,max_count:count,to_entity,...(exact?{unit_number:fixture.furnace}:{entity_name:'stone-furnace'})}})
 const before=await snapshot()
 await run([move('copper-ore',10,true),move('coal',10,true)])
 await until('ten real copper plates',async()=>{const s=await snapshot();return s.output['copper-plate']===10?s:false})
 await run([move('iron-ore',50,true)])
 const blocked=await snapshot()
 assert.equal(blocked.output['copper-plate'],10)
 const refusal=await run([move('iron-plate',50,false)],true)
 const unchanged=await snapshot()
 assert.deepEqual(unchanged.held,blocked.held)
 assert.deepEqual(unchanged.output,blocked.output)
 assert.equal(unchanged.source['iron-ore'],blocked.source['iron-ore'])
 await json('local observed=remote.call("autorio_tools","get_entity_status","stone-furnace",16);assert(observed.found);rcon.print(helpers.table_to_json(observed))')
 await run([move('copper-plate',10,false,true)])
 await until('fifty real iron plates after correcting the output',async()=>{const s=await snapshot();return s.output['iron-plate']===50?s:false})
 await run([move('iron-plate',50,false,true)])
 const final=await snapshot()
 assert.equal(final.held['copper-plate'],10);assert.equal(final.held['iron-plate'],50)
 assert.equal(final.iron-before.iron,50);assert.equal(final.copper-before.copper,10)
 assert.equal(final.actor_id,before.actor_id);assert.equal(final.humans,0);assert.equal(final.speed,1)
 await fs.writeFile(path.join(results,'zero-transfer-proof.json'),JSON.stringify({fixture,before,blocked,refusal,unchanged,final,records,external_inference_calls:0},null,2))
 console.log('PASS Run AA: zero-removal extraction settled exactly; missing-proof/stale-epoch controls held; corrected furnace produced 50 real iron plates')
}finally{
 await fs.writeFile(path.join(results,'zero-transfer-transcript.json'),JSON.stringify(transcript,null,2))
 rcon.close()
}
