import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {quiesceAndSave,waitForStop} from './runner-terminal.mjs';
const release=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const {Rcon}=await import(pathToFileURL(path.join(release,'src/runtime-v8/common.mjs')));
const rcon=new Rcon(27015,process.env.SGLUNA_RCON_PASSWORD,15000);
const readState=async()=>JSON.parse(await fs.readFile('/data/.sgluna/npc-state.json','utf8'));
const state=await readState();
const goalId=state.planning_states?.find(p=>p.state?.goal)?.state.goal.goal_id;
const command=await fs.readFile('/e2e/snapshot.lua','utf8');
try {
 await rcon.connect();
 const readNative=async()=>JSON.parse(await rcon.command(command));
 const native=await readNative();
 if(!goalId) {await rcon.command('/silent-command if remote.interfaces.sgluna_tick_sprint then remote.call("sgluna_tick_sprint","seal","emergency_no_goal") end');await rcon.command('!luna stop');await rcon.command('/server-save @@SAVE_NAME@@-no-goal-emergency');throw Error('No admitted goal; emergency native save requested; strict same-goal proof unavailable');}
 const readStopReceipts=async()=>{
  const names=(await fs.readdir('/data/logs')).filter(n=>/^sgluna-behavior\.jsonl(?:\.\d+)?$/.test(n));
  return (await Promise.all(names.map(n=>fs.readFile('/data/logs/'+n,'utf8')))).flatMap(t=>t.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}));
 };
 const receiptScope={run_id:'@@RUN_ID@@',trace_source:'isolated_supervisor_behavior_trace',trace_path:'/data/logs/sgluna-behavior.jsonl'};
 await quiesceAndSave({rcon,
  confirmStopped:({issuedAt})=>waitForStop({readState,readNative,readStopReceipts,receiptScope,issuedAt,goalId,actorId:native.actor_id,requirePairedReceipts:true}),
  recordResult:async proof=>fs.writeFile('/data/logs/e2e-emergency-result.json',JSON.stringify({run_id:'@@RUN_ID@@',goal_id:goalId,stop_confirmation:proof,result:'runner_exception'},null,2)),
  onIncomplete:async failure=>fs.writeFile('/data/logs/e2e-emergency-incomplete.json',JSON.stringify(failure,null,2)),
  saveName:'@@SAVE_NAME@@',
  waitForSave:async({saveRequestedAt})=>{
   let previous;
   for(let i=0;i<30;i++){
    const stat=await fs.stat('/data/saves/@@SAVE_NAME@@.zip').catch(()=>null);
    if(stat?.size>0&&stat.mtimeMs>=saveRequestedAt&&previous?.size===stat.size&&previous?.mtimeMs===stat.mtimeMs)return;
    previous=stat;await new Promise(r=>setTimeout(r,1000));
   }
   throw Error('Emergency save did not stabilize');
  }
 });
}finally{rcon.close();}
