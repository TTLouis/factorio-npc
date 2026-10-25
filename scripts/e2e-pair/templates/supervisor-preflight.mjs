import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {frozenModels} from './frozen-models.mjs';
import {assertCatalogModels,assertConfiguredModels} from './model-profile.mjs';
const release=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const {Rcon}=await import(pathToFileURL(path.join(release,'src/runtime-v8/common.mjs')));
const {configuration}=await import(pathToFileURL(path.join(release,'src/runtime-v8/supervisor.mjs')));
const {resolveAgentRole}=await import(pathToFileURL(path.join(release,'src/runtime-v8/agent-roles.mjs')));
const effectiveModels=assertConfiguredModels(frozenModels,configuration(JSON.parse(await fs.readFile('/data/sgluna-config.json','utf8')),process.env),resolveAgentRole);
const rcon=new Rcon(27015,process.env.SGLUNA_RCON_PASSWORD,15000);
try {
  await rcon.connect();
  const native=JSON.parse(await rcon.command(await fs.readFile('/e2e/snapshot.lua','utf8')));
  assert.equal(native.seed,@@SEED@@,'Frozen native map seed mismatch');
  const extra=JSON.parse(await rcon.command('/silent-command local i=remote.call("autorio_actor","status"); local a=game.get_entity_by_unit_number(i.actor.actor_id); local q=a.crafting_queue; rcon.print(helpers.table_to_json({actor_id=a.unit_number,walking=a.walking_state.walking,mining=a.mining_state.mining,crafting_queue_length=q and #q or 0,starter_given=storage.luna_autonomy_starter_given==true}))'));
  const empty=v=>Array.isArray(v)?v.length===0:Object.keys(v??{}).length===0;
  const o=native.operations;
  assert.equal(native.humans,0);assert.equal(native.speed,1);assert.ok(!native.board);
  assert.equal(native.machine_count,0);assert.ok(empty(native.inventory));assert.ok(empty(native.crafting_queue));
  assert.ok(native.actor_id>0);assert.equal(extra.actor_id,native.actor_id);assert.equal(extra.starter_given,false);
  assert.equal(extra.walking,false);assert.equal(extra.mining,false);assert.equal(extra.crafting_queue_length,0);
  assert.equal(o.task_state,'idle');assert.equal(o.queue_empty,true);assert.equal(o.queue_length,0);
  assert.equal(o.actor.actor_id,native.actor_id);assert.equal(o.actor.mining_state.mining,false);
  assert.equal(o.follow.active,false);assert.equal(o.follow.navigation.active,false);
  const state=JSON.parse(await fs.readFile('/data/.sgluna/npc-state.json','utf8').catch(()=>'{}'));
  assert.ok(!(state.planning_states??[]).some(p=>p.state?.goal));assert.ok(!state.intake_retry);
  const count=async(name,event)=>{
    const names=(await fs.readdir('/data/logs')).filter(n=>n===name||n.startsWith(name+'.'));
    let total=0;for(const n of names)for(const line of (await fs.readFile(path.join('/data/logs',n),'utf8')).split('\n')){
      try{if(JSON.parse(line).event===event)total++;}catch{}
    }return total;
  };
  const provider=await count('sgluna-prompts.jsonl','provider.request');
  const jev=await count('sgluna-decision.jsonl','decision.request');
  assert.equal(provider,0);assert.equal(jev,0);
  assert.equal(process.env.SGLUNA_E2E_PROFILE,'normal');
  assert.equal(process.env.SGLUNA_E2E_RUN_ID,'@@RUN_ID@@');
  assert.equal(process.env.SGLUNA_E2E_SOURCE_SHA,(await fs.readFile('/e2e/candidate-sha.txt','utf8')).trim());
  const clock={profile:'normal',run_id:process.env.SGLUNA_E2E_RUN_ID,source_sha:process.env.SGLUNA_E2E_SOURCE_SHA,reason:'normal_profile_requires_native_one_x_progress'};
  const before=JSON.parse(await rcon.command(await fs.readFile('/e2e/snapshot.lua','utf8')));
  const start=performance.now();await new Promise(resolve=>setTimeout(resolve,1000));
  const after=JSON.parse(await rcon.command(await fs.readFile('/e2e/snapshot.lua','utf8')));
  const elapsed=performance.now()-start;
  assert.equal(after.speed,1);assert.equal(after.humans,0);assert.ok(after.tick-before.tick>=elapsed*30/1000);
  await fs.writeFile('/data/logs/preflight-clock-proof.json',JSON.stringify({startup:clock,before_tick:before.tick,after_tick:after.tick,elapsed_ms:elapsed,native_tick_delta:after.tick-before.tick,external_inference_calls:0},null,2));
  const base=process.env.OPENAI_API_BASEURL.replace(/\/+$/,'');
  await fs.writeFile('/data/logs/supervisor-native-idle-proof.json',JSON.stringify({at:new Date().toISOString(),native,extra,provider_requests:provider,jev_requests:jev},null,2));
  let unauth,auth,body,stage='unauthenticated_get';
  try{
    unauth=await fetch(base+'/models',{signal:AbortSignal.timeout(15000)});
    stage='authenticated_get';
    auth=await fetch(base+'/models',{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(15000)});
    stage='authenticated_json';
    body=await auth.json();
  }catch(error){
    const diagnostic={at:new Date().toISOString(),stage,error_name:error?.name,error_code:error?.cause?.code??error?.code??null,unauth_status:unauth?.status??null,auth_status:auth?.status??null,external_inference_calls:0};
    await fs.writeFile('/data/logs/catalog-preflight-failure.json',JSON.stringify(diagnostic,null,2));
    console.log(JSON.stringify(diagnostic));
    throw Error('Read-only model catalog connectivity failed; private transport details suppressed');
  }
  assert.equal(unauth.status,401);assert.equal(auth.status,200);
  const ids=(body.data??[]).map(m=>m.id);
  const catalogRoles=assertCatalogModels(frozenModels,ids);
  const proof={at:new Date().toISOString(),actor_id:native.actor_id,seed:native.seed,humans:0,speed:1,goal:null,board:null,inventory_empty:true,machine_count:0,native_full_idle:true,empty_queues:true,walking:false,mining:false,follow:false,crafting:false,starter_given:false,provider_requests:provider,jev_requests:jev,catalog:{unauth_status:unauth.status,auth_status:auth.status,both_role_models_present:true,roles:catalogRoles,effective_role_models:effectiveModels,external_inference_calls:0}};
  await fs.writeFile('/data/logs/supervisor-preflight-proof.json',JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
}finally{rcon.close();}
