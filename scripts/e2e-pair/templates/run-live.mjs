import { sprintSpeedValid, summarizeTickSprints, TICK_SPRINT } from './tick-sprint-policy.mjs';
import { measurementReady, measureFactory, topologyReviewApproved } from './automation-proof.mjs';
import { issueAndConfirmStrictStop, quiesceAndSave, stopStateConfirmed, waitForStop } from './runner-terminal.mjs';
import { trialStopDecision } from './trial-stop-policy.mjs';
import { operatorStopReason } from './pair-stop-policy.mjs';
import {frozenModels} from './frozen-models.mjs';
import {roleResponseMismatch} from './model-profile.mjs';
import {beginColdIntake,readLaunchStop} from './launch-control.mjs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv.includes('--go')) throw Error('Explicit --go required to submit the one authorized goal');
if (!process.env.TYPESAFE_API_KEY?.trim()) throw Error('Jev is required for this trial; missing dedicated token');
const release = path.dirname(await fsp.realpath('/opt/sgluna/start-sgluna.sh'));
const { Rcon } = await import(pathToFileURL(path.join(release, 'src/runtime-v8/common.mjs')));
const rcon = new Rcon(27015, process.env.SGLUNA_RCON_PASSWORD, 15000);
const root = '/data/logs';
const source=(await fsp.readFile('/opt/sgluna/SOURCE_SHA','utf8')).trim();
if(source!=='@@CANDIDATE@@' || process.env.SGLUNA_E2E_RUN_ID!=='@@RUN_ID@@')throw Error('Frozen lane/source mismatch');
const assertSeed=s=>{if(s.seed!==@@SEED@@)throw Error('Frozen native map seed mismatch');return s;};
const objective = '!luna Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.';const snapshot = await fsp.readFile('/e2e/snapshot.lua','utf8');
const json = async command => JSON.parse(await rcon.command(command));
// Retain rows across 10 MiB rotations, including archives closed since the
// previous 90s observation. Provider counters and terminal receipts must not
// disappear when the current file changes.
const retained = new Map();
const rows = async base => {
  const seen = retained.get(base) ?? new Map(); retained.set(base,seen);
  const names = (await fsp.readdir(root)).filter(name=>name===base || (name.startsWith(base+'.') && /^\d+$/.test(name.slice(base.length+1))));
  for (const name of names) for (const line of (await fsp.readFile(path.join(root,name),'utf8').catch(()=>'' )).split('\n')) {
    if (!line || seen.has(line)) continue;
    try { seen.set(line,JSON.parse(line)); } catch {}
  }
  return [...seen.values()].sort((a,b)=>(Date.parse(a.ts??a.timestamp??0)-Date.parse(b.ts??b.timestamp??0)) || ((a.seq??0)-(b.seq??0)));
};
const behavior = () => rows('sgluna-behavior.jsonl');
const prompts = () => rows('sgluna-prompts.jsonl');
const decisions = () => rows('sgluna-decision.jsonl');
const readState = async () => JSON.parse(await fsp.readFile('/data/.sgluna/npc-state.json','utf8').catch(()=>'{}'));
const readNative = async () => assertSeed(await json(snapshot));
const readStopReceipts = async () => (await behavior()).filter(e=>(e.event==='request.cancelled'&&e.data?.reason==='user_stop_immediate')||(e.event==='goal.paused'&&e.data?.cause==='user_stop'&&e.data?.pause_class==='operator'));
const receiptScope = { run_id:'@@RUN_ID@@',trace_source:'isolated_supervisor_behavior_trace',trace_path:path.join(root,'sgluna-behavior.jsonl') };
const started = Date.now();
const constructionLimitMs = 60 * 60000;
const runId = '@@RUN_ID@@';
const speedPolicy={profile:'normal',runId,sourceSha:source};
let result;
let terminalEvidence;
let before;
let last;
let goalId;
let pausedSince = null;
let launchControl;
const requestedStop=async()=>{
  if(launchControl)return readLaunchStop('/e2e',launchControl,goalId);
  const request=JSON.parse(await fsp.readFile('/e2e/operator-stop-request.json','utf8').catch(()=>'null'));
  if(request)return operatorStopReason(request,{runId,goalId,actorId:before?.actor_id});
  const early=(await fsp.readFile('/e2e/stop-before-admission','utf8').catch(()=>'')).trim();
  if(early)return operatorStopReason({runId,goalId,actorId:before?.actor_id,reason:early},{runId,goalId,actorId:before?.actor_id});
  return null;
};
try {
  await fsp.mkdir(root, { recursive: true });
  await rcon.connect();
  before = assertSeed(await json(snapshot));
  await fsp.writeFile(path.join(root,'e2e-before.json'),JSON.stringify(before,null,2));
  const inventory = before.inventory;
  const empty = Array.isArray(inventory) ? inventory.length===0 : Object.keys(inventory??{}).length===0;
  const machineCount = Array.isArray(before.machines) ? before.machines.length : Object.keys(before.machines??{}).length;
  if (before.humans!==0 || before.speed!==1 || !empty || before.red_unlocked || before.green_researched || before.board || machineCount>0) throw Error('Fresh-world precondition failed');
  if (await fsp.stat('/data/saves/@@SAVE_NAME@@.zip').catch(()=>null)) throw Error('paired lane checkpoint already exists before objective submission');
  if(await fsp.stat('/e2e/stop-before-admission').catch(()=>null))throw Error('Owner stopped lane before starter/objective admission');
  const intake=await beginColdIntake({root:'/e2e',logs:root,identity:{run_id:runId,source,actor_id:before.actor_id,epoch:before.epoch,started_at:started,speed_policy:speedPolicy,construction_limit_ms:constructionLimitMs},giveStarter:()=>json('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(not storage.luna_autonomy_starter_given,"Starter already given"); assert(#a.get_main_inventory().get_contents()==0,"Initial inventory nonempty"); local given={}; for n,c in pairs({["iron-plate"]=8,["burner-mining-drill"]=1,["stone-furnace"]=1,["pistol"]=1,["firearm-magazine"]=10}) do given[n]=a.insert{name=n,count=c}; assert(given[n]==c,"Incomplete starter") end; storage.luna_autonomy_starter_given=true; storage.airi_task_board_ui_inputs={}; rcon.print(helpers.table_to_json({starter=given}))'),prepareIntake:async starter=>{
  await fsp.writeFile(path.join(root,'e2e-contract.json'),JSON.stringify({started:new Date(started).toISOString(),model:process.env.OPENAI_MODEL,planner_model:frozenModels.planner,executor_model:frozenModels.executor,jev_enabled:true,construction_profile:speedPolicy,sprint_limits:TICK_SPRINT,objective,starter:starter.starter,stop_conditions:["native_automated_1_red_per_game_minute","authoritative_terminal_stop_policy","weekly_remaining_7_percent"],policy_reserve_remaining_percent:5,live_stop_remaining_percent:7,usage_window_duration_minutes:10080,max_provider_calls:null,max_decision_calls:null,operator_gameplay_actions_after_starter:0,corrective_prompts:0,observer_connections_allowed:false,measurement:{wall_minutes:5,game_speed:2,minimum_game_minutes:10,minimum_new_red_packs:10,red_per_game_minute:1,ai_mutations:false,enemy_removal:true,enemy_expansion:false,require_upstream_native_production:true,topology_review_required:true}},null,2));
  console.log(JSON.stringify({event:'trial.started',actor:before.actor_id,seed:before.seed,starter:starter.starter,objective}));
  await fsp.writeFile(path.join(root,'e2e-started.txt'),new Date().toISOString());
  },submitObjective:()=>rcon.command(objective)});
  launchControl=intake.control;
  console.log(intake.response);
  for (let n=0; ; n++) {
    last = assertSeed(await json(snapshot));
    const events = await behavior();
    await fsp.writeFile(path.join(root,'e2e-sprint-metrics.json'),JSON.stringify({...summarizeTickSprints(events),profile:speedPolicy.profile},null,2));
    // Preserve the first admitted goal even if transport fails before canonical
    // state is reached later in this observation pass.
    goalId ??= events.find(e=>e.event==='planning.goal_admission_steered'&&e.data?.goal_id)?.data.goal_id;
    const delegation={
      configured:{planner:frozenModels.planner,executor:frozenModels.executor},
      completion_protocol_version:3,
      commitments:events.filter(e=>e.event==='plan.delegation_committed').map(e=>({request_id:e.request_id,data:e.data})),
      contract_refusals:events.filter(e=>e.event==='role.contract_refused').map(e=>({request_id:e.request_id,data:e.data})),
      planner_reviews:events.filter(e=>e.event==='executor.planner_review_requested').map(e=>({request_id:e.request_id,data:e.data})),
      strategy_refusals:events.filter(e=>e.event==='executor.strategy_refused').map(e=>({request_id:e.request_id,data:e.data})),
      legacy_blocker_reviews:events.filter(e=>e.event==='executor.legacy_blocker_review').map(e=>({request_id:e.request_id,data:e.data})),
      responses:events.filter(e=>e.event==='provider.response').map(e=>({request_id:e.request_id??e.data?.request_id,round:e.data?.round,role:e.data?.role??'initial_planner_unattributed',handoff_id:e.data?.handoff_id,model:e.data?.provider?.model,has_tool_calls:e.data?.has_tool_calls})),
      handoffs:events.filter(e=>e.event.startsWith('context.')||e.event.startsWith('handoff.')).map(e=>({event:e.event,request_id:e.request_id,data:e.data})),
    };
    await fsp.writeFile(path.join(root,'e2e-delegation-proof.json'),JSON.stringify(delegation,null,2));
    if(delegation.responses.some(e=>roleResponseMismatch(frozenModels,e))){result='role_model_mismatch';break;}
    const promptEvents = await prompts();
    const calls = promptEvents.filter(e=>e.event==='provider.request').length;
    const decisionEvents = await decisions();
    const decisionCalls = decisionEvents.filter(e=>e.event==='decision.request').length;
    await fsp.appendFile(path.join(root,'e2e-world-snapshots.jsonl'),JSON.stringify({ts:new Date().toISOString(),provider_calls:calls,decision_calls:decisionCalls,...last})+'\n');
    console.log(JSON.stringify({event:'trial.observed',ts:new Date().toISOString(),tick:last.tick,actor:last.actor_id,position:last.position,inventory:last.inventory,red_unlocked:last.red_unlocked,green_researched:last.green_researched,red_consumed:last.red_consumed,machines:last.machines,provider_calls:calls,decision_calls:decisionCalls,recent:events.slice(-4).map(e=>({event:e.event,reason:e.data?.reason,message:e.data?.message})),recent_decisions:decisionEvents.slice(-3).map(e=>({event:e.event,reason:e.data?.reason,intent:e.data?.intent,confidence:e.data?.confidence}))}));
    // Success also requires canonical goal and board completion, checked below.
    if (last.actor_id!==before.actor_id || !sprintSpeedValid(last,speedPolicy) || last.humans!==0) { result='trial_invariant_changed';break; }
    const stateFile = await readState();
    // Preserve canonical goal, Shelf and every retained committed slice exactly
    // as observed; raw provider traces separately retain issued/rejected drafts.
    await fsp.appendFile(path.join(root,'e2e-planning-state-history.jsonl'),JSON.stringify({ts:new Date().toISOString(),kind:'canonical_snapshot_as_observed',source,planning_states:stateFile.planning_states??[],plans:stateFile.plans??[]})+'\n');
    await fsp.writeFile(path.join(root,'e2e-latest-npc-state.json'),JSON.stringify(stateFile,null,2));
    const canonical=stateFile.planning_states?.find(p=>p.state?.goal)?.state;
    if (canonical?.goal?.goal_id) {
      goalId ??= canonical.goal.goal_id;
      if (canonical.goal.goal_id !== goalId) { result='goal_identity_changed';break; }
    }
    if (goalId && !await fsp.stat(path.join(root,'e2e-trial-identity.json')).catch(()=>null)) {
      await fsp.writeFile(path.join(root,'e2e-trial-identity.json'),JSON.stringify({...launchControl,run_id:runId,goal_id:goalId,actor_id:before.actor_id,started_at:started,speed_policy:speedPolicy,construction_limit_ms:constructionLimitMs,helper_root:'/e2e'},null,2),{flag:'wx'});
    }
    const operatorReason=await requestedStop();
    if(operatorReason){result=operatorReason;break;}
    const stopDecision=trialStopDecision({canonical,events,startedAt:started,now:Date.now(),pausedSince,goalId,actorId:before.actor_id,native:last,controller:JSON.parse(await fsp.readFile('/data/.sgluna/controller-state.json','utf8').catch(()=>'null')),speedPolicy,constructionLimitMs,hardFloorReached:Boolean(await fsp.stat('/e2e/stop-at-hard-floor').catch(()=>null))});
    if(stopDecision.action==='request_settlement')await fsp.writeFile('/data/.sgluna/next-slice-settle-request.json',JSON.stringify(stopDecision.request));
    pausedSince=stopDecision.pausedSince;
    await fsp.writeFile(path.join(root,'e2e-stop-decision.json'),JSON.stringify(stopDecision,null,2));
    console.log(JSON.stringify(stopDecision.evidence));
    if(stopDecision.action==='stop'){
      // Repeat native and trace reads, then canonical state last, immediately
      // before accepting an automatic terminal result. A cleared pause may run.
      const refreshedNative=assertSeed(await json(snapshot));
      const refreshedEvents=await behavior();
      const refreshedState=JSON.parse(await fsp.readFile('/data/.sgluna/npc-state.json','utf8').catch(()=>'{}'));
      const refreshedCanonical=refreshedState.planning_states?.find(p=>p.state?.goal)?.state;
      const confirmedDecision=trialStopDecision({canonical:refreshedCanonical,events:refreshedEvents,startedAt:started,now:Date.now(),pausedSince,goalId,actorId:before.actor_id,native:refreshedNative,controller:JSON.parse(await fsp.readFile('/data/.sgluna/controller-state.json','utf8').catch(()=>'null')),speedPolicy,constructionLimitMs,hardFloorReached:Boolean(await fsp.stat('/e2e/stop-at-hard-floor').catch(()=>null))});
      pausedSince=confirmedDecision.pausedSince;
      await fsp.writeFile(path.join(root,'e2e-stop-decision.json'),JSON.stringify(confirmedDecision,null,2));
      if(confirmedDecision.action==='stop'){last=refreshedNative;result=confirmedDecision.result;terminalEvidence=confirmedDecision.evidence;break;}
      await new Promise(resolve=>setTimeout(resolve,90000));
      continue;
    }
    const constructionComplete=canonical?.goal?.status==='completed'||events.some(e=>e.event==='request.completed'&&e.data?.task_board?.goal_id===goalId&&e.data?.task_board?.status==='completed');
    if (constructionComplete && measurementReady(last)) {
      const measurementStop=await issueAndConfirmStrictStop({rcon,readState,readNative,readStopReceipts,receiptScope,goalId,actorId:before.actor_id});
      await fsp.writeFile(path.join(root,'e2e-measurement-stop-proof.json'),JSON.stringify(measurementStop,null,2),{flag:'wx'});
      const stoppedNative=await readNative();
      const packet={run_id:runId,goal_id:goalId,source,native:stoppedNative,requested_at:new Date().toISOString(),review_required:true};
      const packetText=JSON.stringify(packet,null,2);
      const packetSha=crypto.createHash('sha256').update(packetText).digest('hex');
      await fsp.writeFile(path.join(root,'e2e-topology-candidate.json'),packetText,{flag:'wx'});
      console.log(JSON.stringify({event:'measurement.topology_review_required',goal_id:goalId,actor_id:last.actor_id,packet_sha256:packetSha}));
      const reviewStarted=Date.now();let reviewed=false;
      while(Date.now()-reviewStarted<300000){
        if(await requestedStop())break;
        const review=JSON.parse(await fsp.readFile('/e2e/measurement-topology-approved.json','utf8').catch(()=>'{}'));
        if(topologyReviewApproved(packet,review,packetSha,{goal_id:goalId,actor_id:last.actor_id,source})){reviewed=true;break;}
        if(await fsp.stat('/e2e/stop-at-hard-floor').catch(()=>null))break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!reviewed){result=await requestedStop()??'native_topology_review_not_approved';break;}
      const fresh=await json(snapshot);
      const identity=s=>JSON.stringify((Array.isArray(s.machines)?s.machines:[]).map(m=>({id:m.id,name:m.name,position:m.position,direction:m.direction,recipe:m.recipe})).sort((a,b)=>a.id-b.id));
      if(fresh.actor_id!==packet.native.actor_id || identity(fresh)!==identity(packet.native)){result='native_topology_changed_after_review';break;}
      const verifyStopped=async()=>{
        const [state,native,receipts]=await Promise.all([readState(),readNative(),readStopReceipts()]);
        if(!stopStateConfirmed({state,native,receipts,receiptScope,issuedAt:measurementStop.submitted_at,goalId,actorId:before.actor_id,requirePairedReceipts:true}))throw Error('Measurement strict stop no longer valid');
        return native;
      };
      let proof;
      try { proof = await measureFactory({rcon,json,snapshot,root,behavior,before,goalId,canonical,verifyStopped,approvedNative:packet.native,requestedStop}); }
      catch(error){const reason=await requestedStop();if(reason){result=reason;break;}throw error;}
      await fsp.writeFile(path.join(root,'e2e-completion-proof.json'),JSON.stringify(proof,null,2));
      last=proof.final;result=proof.satisfied?'native_automated_red_rate_success':'unattended_factory_not_ready';break;
    }
    if (constructionComplete) { result='goal_closed_without_automated_chain';break; }    if (Date.now()-started>=90000 && stateFile.plans?.length===0 && stateFile.planning_states?.length===0 && promptEvents.some(e=>e.event==='provider.response')) { result='goal_not_admitted';break; }
    await new Promise(resolve=>setTimeout(resolve,90000));
  }
  if (!result) throw Error('Trial ended without a stop condition');
  // End the campaign before checkpoint I/O so an intake timer cannot start
  // another provider attempt while the observer is saving/finalizing.
  await quiesceAndSave({
    rcon,
    confirmStopped: ({ issuedAt }) => waitForStop({
      readState, readNative, readStopReceipts, receiptScope,
      issuedAt, goalId, actorId: before.actor_id, requirePairedReceipts: true,
    }),
    onIncomplete: async failure => {
      await fsp.writeFile(path.join(root,'e2e-incomplete.json'),JSON.stringify({...failure,intended_result:result,terminal_evidence:terminalEvidence,goal_id:goalId},null,2));
      console.log(JSON.stringify({event:'trial.stop_incomplete',...failure,intended_result:result}));
    },
    recordResult: async confirmation => {
      await fsp.writeFile(path.join(root,'e2e-result.json'),JSON.stringify({run_id:runId,result,terminal_evidence:terminalEvidence,stop_confirmation:confirmation,goal_id:goalId,elapsed_ms:Date.now()-started,operator_gameplay_actions_after_starter:0,corrective_prompts:0,before,final:last},null,2));
      console.log(JSON.stringify({event:'trial.finished',result,terminal_evidence:terminalEvidence}));
    },
    saveName: '@@SAVE_NAME@@',
    waitForSave: async ({saveRequestedAt}) => {
      let previous;
      for (let n=0;n<30;n++) {
        const stat=await fsp.stat('/data/saves/@@SAVE_NAME@@.zip').catch(()=>null);
        if(stat?.size>0 && stat.mtimeMs>=saveRequestedAt && previous?.size===stat.size && previous?.mtimeMs===stat.mtimeMs)return;
        previous=stat;await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw Error('Fresh stable paired lane checkpoint was not confirmed');
    },
  });
} catch(error) {
  if(error.code==='launch_canceled')await fsp.writeFile(path.join(root,'e2e-launch-canceled.json'),JSON.stringify({run_id:runId,result:error.reason,no_goal:true,strict_same_goal_confirmation:false,intake_submitted:false},null,2));
  throw error;
} finally {
  rcon.close();
}
