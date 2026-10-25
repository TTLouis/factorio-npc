import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const release=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const {Rcon}=await import(pathToFileURL(path.join(release,'src/runtime-v8/common.mjs')));
const rcon=new Rcon(27015,process.env.SGLUNA_RCON_PASSWORD,15000);
try {
  await rcon.connect();
  const native=JSON.parse(await rcon.command(await fs.readFile('/e2e/snapshot.lua','utf8')));
  assert.equal(native.seed,@@SEED@@,'Frozen native map seed mismatch');
  assert.equal(process.env.SGLUNA_E2E_RUN_ID,'@@RUN_ID@@');
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
  const prior=JSON.parse(await fs.readFile('/data/logs/supervisor-preflight-proof.json','utf8'));assert.equal(native.actor_id,prior.actor_id);assert.equal(native.seed,prior.seed);
  const proof={at:new Date().toISOString(),run_id:'@@RUN_ID@@',source:'@@CANDIDATE@@',epoch:native.epoch,actor_id:native.actor_id,helper_root:'/e2e',phase:'prelaunch',seed:native.seed,provider_requests:provider,jev_requests:jev,starter_given:extra.starter_given,native_full_idle:true,goal:null,board:null,humans:0,speed:1,inventory_empty:true};
  await fs.writeFile('/data/logs/prelaunch-cold-proof.json',JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
}finally{rcon.close();}
