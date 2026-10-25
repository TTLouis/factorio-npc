// AX B future-run proof: new GOAL_ACCEPTED creates the valid correction ledger.
// All decisions are scripted local packets; all native reads/results are real.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Rcon} from '../pterodactyl/runtime-v8/common.mjs'
import {CanonicalTaskBoardMemory} from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import {NpcAgentLoop} from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import {getActivePlan} from '../pterodactyl/runtime-v8/planning-state.mjs'
import {compileObligations,effectivePreservationProof,preservationGeometry} from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import {planReply,answersStepContract} from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import {toolCommand,parseOperation,renderOperation,renderOperationPreflight,luaString} from '../pterodactyl/runtime-v8/structured-policy.mjs'
import {configureNpcSession,deploymentStatus,executeAuthorizedBatch} from '../pterodactyl/staging/supervisor-adapter.mjs'

globalThis.fetch=async()=>{throw new Error('inference/network forbidden in native loop proof')}
const arg=name=>{const at=process.argv.indexOf(`--${name}`);assert.ok(at>=0);return process.argv[at+1]}
const results=path.resolve(arg('results'))
const baseline=JSON.parse(await fs.readFile(new URL('../pterodactyl/runtime-v8/fixtures/ax-b-candidate-boundary.json',import.meta.url),'utf8'))
const evidence={status:'fail',factorio:'2.0.77',scope:'AX B future new-goal ledger, real native eligibility/correction/helper/transport/receipt/certificate/unchanged fuel',
  residual_early_miss:process.env.AX_B_RESIDUAL==='1',historical_guard_resumed:false,
  substitutions:['New isolated actor/world and new goal identity; native-relative spatial fixture, not AX world replay.','All planner/executor choices scripted locally; original red-science goal result retained.'],
  transcript:[],events:[],scripted_calls:[],persisted:[]}
let connection,agent
let freshSet
const rcon={command:async command=>{const response=await connection.command(command);evidence.transcript.push({command,response});
  if(agent&&command.includes('get_placement_candidates'))freshSet=JSON.parse(response);return response}}
const tool=async(name,args)=>JSON.parse(await rcon.command(toolCommand(name,args)))
const lua=async body=>JSON.parse(await rcon.command(`/silent-command local a;for _,s in pairs(game.surfaces) do local c=s.find_entities_filtered{name="character"};if #c>0 then a=c[1];break end end;assert(a);${body}`))
async function idle(){const deadline=Date.now()+60000;for(;;){const s=await tool('getTaskStatus',{});if(s.task_state==='idle'&&s.queue_length===0&&!s.active_batch)return s;assert.ok(Date.now()<deadline,'native loop deadline');await delay(100)}}
try{
  await fs.mkdir(results,{recursive:true})
  connection=new Rcon(Number(arg('port')),arg('password'),15000,{host:arg('host')});await connection.connect()
  assert.equal(JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json','utf8')).version,'2.0.77')
  await configureNpcSession(rcon,'fluid-real-loop-fixture')
  const setup=await lua(`local s=a.surface;local ox=math.floor(a.position.x)+70;local oy=math.floor(a.position.y);game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{ox-14,oy-16},{ox+26,oy+20}}})do if e.type~="character" then e.destroy() end end;
    local tiles={};for x=ox-14,ox+26 do for y=oy-16,oy+20 do tiles[#tiles+1]={name=x<ox and "water" or "landfill",position={x,y}} end end;s.set_tiles(tiles,true,false,true);
    storage.fluid_real_loop_fixture={ox=ox,oy=oy,s=s};assert(a.teleport({ox+5,oy},s));a.get_main_inventory().clear();
    assert(a.insert{name="offshore-pump",count=1}==1);assert(a.insert{name="boiler",count=1}==1);assert(a.insert{name="coal",count=2}==2);
    assert(a.insert{name="steam-engine",count=1}==1);assert(a.insert{name="lab",count=1}==1);
    rcon.print(helpers.table_to_json({center={x=ox,y=oy},actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  evidence.setup=setup;assert.equal(setup.humans,0);assert.equal(setup.speed,1)
  await tool('getFluidSourceTiles',{fluid_name:'water',search_radius:16,limit:8})
  const pumpSet=await tool('getPlacementCandidates',{entity_name:'offshore-pump',center:setup.center,radius:8,limit:8})
  assert.ok(pumpSet.candidates?.length)
  const actor=await deploymentStatus(rcon,{requireAllowed:true})
  await executeAuthorizedBatch(rcon,actor.epoch,[renderOperation(parseOperation({name:'place_candidate',args:{candidate_set_id:pumpSet.candidate_set_id,candidate_id:pumpSet.candidates[0].id}}))])
  const pumpStatus=await idle();const pump=pumpStatus.basic_operation.last_result.placed_unit_number;assert.ok(pump)
  const set=await tool('getPlacementCandidates',{entity_name:'boiler',connects_to:{unit_number:pump},limit:8})
  assert.ok(set.candidates?.length)
  const candidate=set.candidates[0]
  const anchor=candidate.position
  const pumpBefore=preservationGeometry(await tool('getEntityGeometry',{unit_number:pump}),pump)
  const open=pumpBefore.fluid.storages[0].ports[0]
  const badSet=await tool('getPlacementCandidates',{entity_name:'boiler',anchor:{unit_number:pump},center:anchor,radius:8,limit:8})
  const bad=badSet.candidates.find(row=>row.fluid_ports?.some(port=>port.flow_direction==='output'
    &&port.position.x===open.target_position.x&&port.position.y===open.target_position.y))
  assert.ok(bad,'fresh native rotational layout must include the AX output/output failure class')
  assert.equal(bad.connects_to,undefined)
  const badOperation={name:'place_candidate',args:{candidate_set_id:badSet.candidate_set_id,candidate_id:bad.id}}
  const preflight=JSON.parse(await rcon.command(renderOperationPreflight(badOperation)))
  assert.equal(preflight.ok,true);assert.equal(preflight.preservation_clears_count,0)
  assert.equal(preflight.preservation_eligibility.kind,'relation_required');assert.equal(preflight.preservation_join,undefined)
  evidence.original_failure_class={badSet,bad,preflight,pump:pumpBefore,expected_historical_implicit_reply:'unknown'}
  const first={outcome:{mode:'all',requirements:[{kind:'entity_count',prototype:'boiler',minimum:1,anchor,radius:2},
    {kind:'inventory_count',item_name:'steam-engine',minimum:1},{kind:'inventory_count',item_name:'lab',minimum:1}]},preserve:[pump]}
  const second={outcome:{mode:'all',requirements:[{kind:'authoritative_operation_receipt',operation_name:'supply_entity'}]},preserve:[pump]}
  const memory=new CanonicalTaskBoardMemory();const key='npc:fluid-real-loop'
  let placed,round=0,immutable
  const beforeCorrection=await lua('rcon.print(helpers.table_to_json({inventory=a.get_main_inventory().get_contents(),boilers=a.surface.count_entities_filtered{name="boiler"}}))')
  const provider=answersStepContract(async(_messages,context)=>{
    evidence.scripted_calls.push({role:context.role,trigger:context.triggerSource})
    if(context.role==='planner')return planReply({plan:[`Install one boiler within two tiles of (${anchor.x}, ${anchor.y}), preserving offshore pump ${pump} and retaining one steam engine and one lab.`,'Fuel the installed boiler with one coal.'],currentStep:0,operations:[],
      goal:{scope:baseline.goal.definition.scope,summary:baseline.goal.definition.summary,doneWhen:baseline.goal.definition.done_when},
      roadmap:[{id:'steam',intent:'Run native fixture steam production.'}],
      stepCompletions:[{kind:'deterministic',checkpoint:compileObligations(first),obligations:first},{kind:'deterministic',checkpoint:compileObligations(second),obligations:second}],
      executionGuidance:['Join the preserved pump with one boiler.','Supply exactly one coal to the installed boiler.'].map(approach=>({approach,rationale:'Retain all old topology.',constraints:[],skillIds:[],materialSupply:null}))})
    const plan=getActivePlan(agent.memory.planningState(key));const step=plan.steps[plan.active_step_index]
    if(plan.active_step_index===0){
      immutable??=structuredClone(plan.steps)
      if(round++===0)return planReply({stepId:step.step_id,operations:[badOperation]})
      assert.equal(agent.memory.planningState(key).goal.argument_corrections.claims.length,1)
      if(round===2){
        evidence.zero_effect_before_fresh_proposal=await lua('rcon.print(helpers.table_to_json({inventory=a.get_main_inventory().get_contents(),boilers=a.surface.count_entities_filtered{name="boiler"}}))')
        assert.deepEqual(evidence.zero_effect_before_fresh_proposal,beforeCorrection)
        assert.deepEqual(preservationGeometry(await tool('getEntityGeometry',{unit_number:pump}),pump),pumpBefore)
        return {content:'',tool_calls:[{id:'fresh-native-certified-boiler',index:0,type:'function',function:{name:'getPlacementCandidates',arguments:JSON.stringify({entity_name:'boiler',connects_to:{unit_number:pump},center:anchor,radius:2,limit:8})}}]}
      }
      assert.ok(freshSet?.ok)
      const next=freshSet.candidates.find(row=>Math.hypot(row.position.x-anchor.x,row.position.y-anchor.y)<=2)
      assert.ok(next?.connects_to,'fresh proposal must fit original radius and have native join facts')
      evidence.fresh_proposal={set:freshSet.candidate_set_id,candidate:next}
      return planReply({stepId:step.step_id,operations:[{name:'place_candidate',args:{candidate_set_id:freshSet.candidate_set_id,candidate_id:next.id}}]})
    }
    assert.equal(plan.active_step_index,1,'no unexpected semantic step')
    assert.equal(plan.execution.preservation_certificates.length,1,'durable native certificate before requesting next fuel')
    assert.ok(placed)
    return planReply({stepId:step.step_id,operations:[{name:'supply_entity',args:{unit_number:placed,items:[{item_name:'coal',count:1}]}}]})
  })
  const stateFile=path.join(results,'fluid-real-loop-state.json')
  agent=new NpcAgentLoop({memory,rcon,npcId:'fluid-real-loop',completionProtocolVersion:3,requireTypedObligations:true,replacementWake:true,stateFile,traceFile:null,decisionTraceFile:null,
    systemPrompt:'Finite offline scripted fixture.',interactionProvider:async()=>({content:JSON.stringify({intent:'new_goal',queue_conflict:false,reply:''})}),provider})
  agent.behaviorTrace={emit:async row=>{evidence.events.push(row)}}
  const persist=agent.persistState.bind(agent)
  agent.persistState=async options=>{await persist(options);const file=JSON.parse(await fs.readFile(stateFile,'utf8'));evidence.persisted.push({strict:options?.strict===true,snapshot:file})}
  evidence.started=await agent.request(baseline.goal.objective,{sender:'Louis'})
  const held=()=>getActivePlan(agent.memory.planningState(key))
  assert.equal(held().active_step_index,0,JSON.stringify(evidence.started))
  assert.equal(Object.keys(held().execution.preservation_admissions).length,1)
  assert.deepEqual(held().steps,immutable)
  assert.equal(agent.memory.planningState(key).goal.objective,baseline.goal.objective)
  const definition=agent.memory.planningState(key).goal.definition
  assert.deepEqual(definition.done_when,baseline.goal.definition.done_when)
  const nativeDone=await idle();const basic=nativeDone.basic_operation.last_result
  assert.equal(basic.completed,true);assert.equal(basic.entity_name,'boiler');placed=basic.placed_unit_number;assert.ok(basic.preservation_binding)
  evidence.native_boiler_result=basic
  const claimsBefore=JSON.parse(await rcon.command('/silent-command __autorio__ assert(script.mod_name=="autorio");rcon.print(helpers.table_to_json({count=storage.sgluna_fluid_preservation_claim_count,high_water=storage.sgluna_operation_admission_high_water}))'))
  assert.equal(typeof claimsBefore.count,'number');assert.equal(typeof claimsBefore.high_water,'number')
  // Deliberately miss the first close callback: production taskStatusReceipt
  // normalizes the real native summary/receipt, but does not issue a certificate.
  evidence.receipt=await agent.taskStatusReceipt()
  assert.equal(held().execution.preservation_certificates,undefined)
  await agent.persistState({strict:true})
  const disk=JSON.parse(await fs.readFile(stateFile,'utf8'));const restored=new CanonicalTaskBoardMemory();restored.restore(disk);agent.memory=restored
  evidence.completion=await agent.completed()
  assert.equal(held().active_step_index,1,JSON.stringify({result:evidence.completion,events:evidence.events.slice(-12)}))
  assert.equal(held().execution.preservation_certificates.length,1)
  assert.deepEqual(held().steps.map(s=>({description:s.description,semantic_step_id:s.semantic_step_id,obligations:s.obligations,obligation_proof:s.obligation_proof})),immutable.map(s=>({description:s.description,semantic_step_id:s.semantic_step_id,obligations:s.obligations,obligation_proof:s.obligation_proof})))
  assert.equal(agent.memory.planningState(key).goal.replacements_accepted??0,0)
  const fueled=await idle();assert.equal(fueled.basic_operation.last_result.type,'moving_items');assert.equal(fueled.basic_operation.last_result.moved_count,1)
  const effective=effectivePreservationProof(held(),held().steps[0],{plans:agent.memory.planningState(key).plans});assert.ok(effective)
  evidence.effective=effective;evidence.final_plan=held();evidence.native_fuel_result=fueled.basic_operation.last_result
  assert.equal(evidence.events.filter(row=>row.event==='contract.fluid_admission_prepared').length,1)
  assert.equal(evidence.events.filter(row=>row.event==='contract.fluid_addition_certified').length,1)
  const sends=evidence.transcript.filter(row=>row.command.includes('SGLUNA_RESULT_')&&row.command.includes('autorio_operation_admission'))
  assert.equal(sends.filter(row=>row.command.includes("'place_candidate'")).length,1,'no placement replay')
  assert.equal(sends.filter(row=>row.command.includes("'supply_entity'")).length,1,'unchanged fuel exactly once')
  assert.equal(sends.length,2)
  const retries=evidence.events.filter(row=>row.event==='operations.preflight_recoverable'&&row.data.preflight?.code==='preservation_candidate_relation_required')
  assert.equal(retries.length,1);assert.equal(retries[0].data.durable_claim,true);assert.equal(retries[0].data.retry_budget,1)
  assert.equal(retries[0].data.zero_send.reason,'native_idle_journal_absent_exact_unsent_settled')
  assert.equal(evidence.events.filter(row=>row.event==='operation.not_sent').length,evidence.residual_early_miss?1:0)
  const prepared=Object.values(held().execution.preservation_admissions)[0]
  evidence.cleanup_capability=JSON.parse(await rcon.command(`/silent-command rcon.print(helpers.table_to_json({leave=remote.call("autorio_operation_admission","leave",${JSON.stringify(prepared.operation_key)})}))`))
  assert.equal(evidence.cleanup_capability.leave,true)
  evidence.claims_before_fuel=claimsBefore
  evidence.claims_after_fuel=JSON.parse(await rcon.command('/silent-command __autorio__ assert(script.mod_name=="autorio");rcon.print(helpers.table_to_json({count=storage.sgluna_fluid_preservation_claim_count,high_water=storage.sgluna_operation_admission_high_water}))'))
  assert.equal(evidence.claims_after_fuel.count,claimsBefore.count)
  evidence.status='pass'
}catch(error){evidence.error=String(error);throw error}
finally{if(agent){await agent.persistQueue;await fs.writeFile(path.join(results,'fluid-real-loop-memory.json'),JSON.stringify(agent.memory.snapshot(),null,2)+'\n')}connection?.close();await fs.writeFile(path.join(results,'fluid-real-loop-native.json'),JSON.stringify(evidence,null,2)+'\n')}
