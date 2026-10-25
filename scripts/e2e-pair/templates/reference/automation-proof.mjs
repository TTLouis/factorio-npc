import fs from 'node:fs/promises';
const list=x=>Array.isArray(x)?x:[];
export function topologyReviewApproved(packet,review,packetSha,current) {
  return review?.approved===true && review?.native_chain_verified===true
    && /^[a-f0-9]{64}$/.test(packetSha) && review.packet_sha256===packetSha
    && review.goal_id===packet.goal_id && review.actor_id===packet.native.actor_id
    && review.source===packet.source && current.goal_id===packet.goal_id
    && current.actor_id===packet.native.actor_id && current.source===packet.source;
}
export const idle=s=>s.operations?.task_state==='idle' && s.operations?.queue_empty===true && s.operations?.queue_length===0 && list(s.crafting_queue).length===0 && s.operations?.follow?.active!==true && s.operations?.actor?.mining_state?.mining!==true;
export function steamPowered(s) {
 const networks=new Set(list(s.machines).filter(m=>m.type==='electric-pole'&&list(m.network_producers).some(p=>p.name==='steam-engine'&&p.flow>0)).map(m=>m.network));
 return list(s.machines).some(m=>m.name==='steam-engine'&&list(m.fluids).some(f=>f.name==='steam'&&f.amount>0))
   && ['iron-gear-wheel','automation-science-pack'].every(recipe=>list(s.machines).some(m=>m.recipe===recipe&&m.energy>0&&networks.has(m.network)));
}
export function measurementReady(s) {
  const machines=list(s.machines);
  return !s.truncated && machines.some(m=>m.recipe==='automation-science-pack' && m.products_finished>0)
    && machines.some(m=>m.recipe==='iron-gear-wheel' && m.products_finished>0)
    && machines.filter(m=>m.type==='furnace').length>=2
    && ['iron-ore','copper-ore','coal'].every(name=>machines.some(m=>m.type==='mining-drill'&&m.resource===name))
    && ['offshore-pump','boiler','steam-engine'].every(name=>machines.some(m=>m.name===name))
    && idle(s) && steamPowered(s);
}
export function evaluateMeasurement(samples, mutationEvents=[]) {
  const start=samples[0],end=samples.at(-1),minutes=(end.tick-start.tick)/3600;
  const deltas=Object.fromEntries(Object.keys(start.production).map(n=>[n,end.production[n].produced-start.production[n].produced]));
  const machineOutput=recipe=>list(end.machines).filter(m=>m.recipe===recipe).reduce((sum,m)=>{const prior=list(start.machines).find(p=>p.id===m.id);return sum+(prior?m.products_finished-prior.products_finished:0)},0);
  const failures=[];
  if(minutes<10)failures.push('fewer_than_ten_game_minutes');
  if(end.wall_ms-start.wall_ms<300000)failures.push('fewer_than_five_wall_minutes');
  if(samples.some(s=>s.speed!==2||s.humans!==0||s.actor_id!==start.actor_id||!idle(s)||s.truncated))failures.push('measurement_invariant_changed');
  if(samples.some(s=>s.health!==start.health))failures.push('actor_health_changed');
  if(samples.some(s=>!steamPowered(s)))failures.push('native_steam_power_not_proven');
  if(mutationEvents.length)failures.push('runtime_dispatched_during_lockout');
  if(deltas['automation-science-pack']/minutes<1 || machineOutput('automation-science-pack')/minutes<1)failures.push('red_rate_below_one_per_game_minute');
  if(Object.values(deltas).some(delta=>delta<=0))failures.push('upstream_stage_not_producing');
  if(machineOutput('iron-gear-wheel')<=0)failures.push('gear_assembler_not_producing');
  for(const m of list(start.machines)){const current=list(end.machines).find(e=>e.id===m.id);if(!current||current.health!==m.health)failures.push('factory_changed_or_damaged');}
  return {satisfied:failures.length===0,failures:[...new Set(failures)],game_minutes:minutes,wall_minutes:(end.wall_ms-start.wall_ms)/60000,deltas,red_per_game_minute:deltas['automation-science-pack']/minutes,red_per_wall_minute:deltas['automation-science-pack']/((end.wall_ms-start.wall_ms)/60000),red_assembler_output:machineOutput('automation-science-pack'),gear_assembler_output:machineOutput('iron-gear-wheel'),topology_review_required:true,final:end};
}
export async function measureFactory({rcon,json,snapshot,root,behavior,before,goalId,canonical}) {
  // Authorized benchmark setup: operator pause, enemy removal, speed change.
  // No player-factory edits, inventory insertion, terrain edits or chunk generation.
  await rcon.command('!luna stop');
  let stopped;
  for(let i=0;i<30;i++){stopped=await json(snapshot);if(idle(stopped))break;await new Promise(r=>setTimeout(r,1000));}
  if(!idle(stopped))throw Error('Cannot begin measurement with active native work');
  if(stopped.actor_id!==before.actor_id || stopped.humans!==0 || stopped.speed!==1)throw Error('Measurement actor/world changed before lockout');
  const peaceful=await json('/silent-command local removed=0; for _,s in pairs(game.surfaces) do for _,e in pairs(s.find_entities_filtered{force="enemy"}) do if e.valid and e.destroy() then removed=removed+1 end end end; game.map_settings.enemy_expansion.enabled=false; game.speed=2; rcon.print(helpers.table_to_json({removed_enemies=removed,enemy_expansion=false,speed=game.speed}))');
  const supervisor=[];
  for(const name of await fs.readdir('/proc'))if(/^\d+$/.test(name)&&Number(name)!==process.pid){const argv=await fs.readFile(`/proc/${name}/cmdline`,'utf8').catch(()=>'');if(argv.split('\0').some(arg=>arg.endsWith('/runtime-v8/supervisor.mjs')))supervisor.push(Number(name));}
  if(supervisor.length!==1)throw Error('Expected exactly one supervisor to lock');
  const samples=[],locked=Date.now();
  process.kill(supervisor[0],'SIGSTOP');
  try {
    const start={wall_ms:Date.now(),...await json(snapshot)};samples.push(start);
    console.log(JSON.stringify({event:'measurement.started',tick:start.tick,peaceful,supervisor_paused:true}));
    for(;;){await new Promise(r=>setTimeout(r,15000));const s={wall_ms:Date.now(),...await json(snapshot)};samples.push(s);await fs.writeFile(`${root}/e2e-measurement-samples.json`,JSON.stringify(samples,null,2));console.log(JSON.stringify({event:'measurement.observed',tick:s.tick,red_produced:s.red_produced_count,wall_seconds:(s.wall_ms-start.wall_ms)/1000}));if(s.wall_ms-start.wall_ms>=300000 && s.tick-start.tick>=36000)break;if(Date.now()-locked>390000)throw Error('Measurement could not reach ten game minutes within 6.5 wall minutes');}
    const events=(await behavior()).filter(e=>Date.parse(e.ts??0)>=samples[0].wall_ms && ['operations.batch_dispatched','operations.admitted','runtime.batch_admitted'].includes(e.event));
    return {...evaluateMeasurement(samples,events),goal_id:goalId,canonical_status_before_lockout:canonical?.goal?.status,peaceful,supervisor_paused:true,initial_actor:before.actor_id};
  } finally {process.kill(supervisor[0],'SIGCONT');await rcon.command('/silent-command game.speed=1');}
}
