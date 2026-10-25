import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const {Rcon}=await import(pathToFileURL(path.join(root,'src/runtime-v8/common.mjs')));
const rcon=new Rcon(27015,process.env.SGLUNA_RCON_PASSWORD,15000);
try{await rcon.connect();const state=JSON.parse(await rcon.command(await fs.readFile('/e2e/snapshot.lua','utf8')));await fs.mkdir('/data/logs',{recursive:true});await fs.writeFile('/data/logs/preflight-native.json',JSON.stringify(state,null,2));if(state.seed!==@@SEED@@)throw Error('Frozen native map seed mismatch');if(state.humans!==0||state.speed!==1||state.board||state.machine_count!==0)throw Error('Cold-world preflight failed');console.log(JSON.stringify({actor_id:state.actor_id,seed:state.seed,humans:state.humans,speed:state.speed,machines:state.machine_count,board_empty:!state.board,inventory:state.inventory,operations_idle:state.operations.task_state==='idle'}));}finally{rcon.close();}
