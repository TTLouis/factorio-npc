import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import crypto from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {definePair,render,kitRoot} from './pair.mjs'
import {roleResponseMismatch} from './templates/model-profile.mjs'
import {beginColdIntake,readLaunchStop} from './templates/launch-control.mjs'
import {operatorStopReason} from './templates/pair-stop-policy.mjs'
import {quiesceAndSave,waitForStop} from './templates/runner-terminal.mjs'

for(const models of [undefined,{planner:'gpt-6-luna',executor:'gpt-6-luna',overwatch:'gpt-6-luna'}]) for(const reason of ['owner_canceled','shared_quota_evidence_stale','weekly_remaining_floor_reached'])for(const stage of ['before_intake','pending_initial_llm','pending_goal_jev',...(reason==='owner_canceled'?['response_planner_mismatch','response_executor_mismatch']:[])]) {
  test(`complete runner entry + actual coordinator: ${models?'Luna/Luna':'Sol/Luna'} ${reason} at ${stage}`,async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'paired-runner-entry-'))
    const pair=definePair({candidate:'c'.repeat(40),published:'b'.repeat(40),imageId:'sha256:'+'d'.repeat(64),models}),lane=pair.lanes[0],laneRoot=path.join(root,'a')
    let submits=0,nativeReads=0,starters=0,stopped=false,closed=false,stopCommands=0
    const mismatch=stage.startsWith('response_')
    try {
      await fs.writeFile(path.join(root,'pair.json'),JSON.stringify(pair));await fs.copyFile(path.join(kitRoot,'coordinator/pair-common.ps1'),path.join(root,'pair-common.ps1'))
      for(const id of ['a','b']){await fs.mkdir(path.join(root,id,'data/logs'),{recursive:true});await fs.mkdir(path.join(root,id,'data/saves'));await fs.writeFile(path.join(root,id,'live-container.cid'),'a'.repeat(64));await fs.writeFile(path.join(root,id,'deployed-node-path.txt'),'/opt/sgluna/.sgluna/releases/fixture/node/bin/node')}
      if(mismatch)await fs.writeFile(path.join(laneRoot,'data/logs/sgluna-behavior.jsonl'),JSON.stringify({event:'provider.response',data:{role:stage.includes('planner')?'planner':'executor',provider:{model:'gpt-unapproved'}}})+'\n')
      await fs.copyFile(path.join(kitRoot,'templates/snapshot.lua'),path.join(laneRoot,'snapshot.lua'))
      await fs.writeFile(path.join(root,'quota-latest.json'),JSON.stringify({pairId:pair.pairId,source:'get_usage_limits',observedBy:'parent:/root',matchingWeeklyWindows:1,windowDurationMins:10080,remainingPercent:reason==='weekly_remaining_floor_reached'?7:20,observedAt:Date.now()-(reason==='shared_quota_evidence_stale'?180001:0)}))
      const dispatch=()=>{execFileSync('pwsh',['-NoProfile','-File',path.join(kitRoot,'control-dispatch.test.ps1'),'-Root',root,'-Lane','a','-Reason',reason,'-Kit',kitRoot],{encoding:'utf8'});stopped=true}
      const map=file=>{file=String(file);if(file.startsWith('/data/'))return path.join(laneRoot,'data',file.slice(6));if(file==='/e2e')return laneRoot;if(file.startsWith('/e2e/'))return path.join(laneRoot,file.slice(5));return file}
      const fakeFs={...fs,realpath:async()=>'/opt/sgluna/.sgluna/releases/fixture/start-sgluna.sh',readFile:async(file,...args)=>file==='/opt/sgluna/SOURCE_SHA'?pair.candidate:fs.readFile(map(file),...args),
        stat:async(file,...args)=>fs.stat(map(file),...args),mkdir:async(file,...args)=>fs.mkdir(map(file),...args),readdir:async(file,...args)=>fs.readdir(map(file),...args),appendFile:async(file,...args)=>fs.appendFile(map(file),...args),
        writeFile:async(file,...args)=>{await fs.writeFile(map(file),...args);if(stage==='before_intake'&&file==='/data/logs/e2e-started.txt')dispatch()}}
      class Rcon {
        async connect(){}close(){closed=true}
        async command(command) {
          if(command==='!luna stop')stopCommands++
          if(command.startsWith('!luna Build')){assert.equal(stopped,false,'No intake after acknowledged stop');submits++;return 'queued: '+stage}
          if(command.includes('Starter already given')){starters++;return JSON.stringify({starter:{}})}
          if(command.includes('local sprint_guard')){nativeReads++;if(stage.startsWith('pending_')&&nativeReads===2)dispatch()}
          return JSON.stringify({seed:lane.seed,humans:0,speed:1,inventory:[],machines:[],red_unlocked:false,green_researched:false,board:null,actor_id:42,epoch:3})
        }
      }
      const context=vm.createContext({console:{log:()=>{}},process:{argv:['node','run-live.mjs','--go'],env:{TYPESAFE_API_KEY:'offline',SGLUNA_E2E_RUN_ID:lane.runId}},setTimeout,clearTimeout})
      async function mod(exports){const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v)},{context});await m.link(()=>{});await m.evaluate();return m}
      const common=await mod({Rcon})
      const imports={
        './frozen-models.mjs':{frozenModels:pair.models},'./model-profile.mjs':{roleResponseMismatch},
        './tick-sprint-policy.mjs':{sprintSpeedValid:()=>true,summarizeTickSprints:()=>({}),TICK_SPRINT:{}},'./automation-proof.mjs':{measurementReady:()=>false,measureFactory:()=>{},topologyReviewApproved:()=>false},
        './runner-terminal.mjs':{quiesceAndSave,waitForStop:opts=>waitForStop({...opts,timeoutMs:20,pollMs:1}),stopStateConfirmed:()=>false,issueAndConfirmStrictStop:()=>assert.fail('No complete goal admitted')},
        './trial-stop-policy.mjs':{trialStopDecision:()=>assert.fail('Operator stop precedes automatic policy')},'./pair-stop-policy.mjs':{operatorStopReason},
        './launch-control.mjs':{beginColdIntake:opts=>beginColdIntake({...opts,root:map(opts.root),logs:map(opts.logs)}),readLaunchStop:(dir,...args)=>readLaunchStop(map(dir),...args)},
        'node:crypto':{default:crypto},'node:fs/promises':{default:fakeFs},'node:path':{default:path.posix},'node:url':{pathToFileURL}}
      const code=render(await fs.readFile(path.join(kitRoot,'templates/run-live.mjs'),'utf8'),{CANDIDATE:pair.candidate,RUN_ID:lane.runId,SEED:lane.seed,SAVE_NAME:lane.saveName})
      const runner=new vm.SourceTextModule(code,{context,importModuleDynamically:()=>common})
      await runner.link(async name=>{assert.ok(imports[name],name);return mod(imports[name])})
      await assert.rejects(runner.evaluate(),error=>stage==='before_intake'?error.code==='launch_canceled':error.code==='stop_confirmation_timeout')
      assert.equal(starters,1);assert.equal(submits,stage==='before_intake'?0:1);assert.equal(closed,true)
      assert.equal(await fs.stat(path.join(root,'b/control-rcon.jsonl')).catch(()=>null),null)
      assert.equal(await fs.stat(path.join(laneRoot,'data/logs/e2e-result.json')).catch(()=>null),null,'No fake same-goal/gameplay success')
      const proof=JSON.parse(await fs.readFile(path.join(laneRoot,'data/logs',stage==='before_intake'?'e2e-launch-canceled.json':'e2e-incomplete.json'),'utf8'))
      assert.equal(stage==='before_intake'?proof.result:proof.intended_result,mismatch?'role_model_mismatch':reason)
      if(mismatch){
        assert.equal(stopCommands,1);assert.equal(await fs.stat(path.join(laneRoot,'control-rcon.jsonl')).catch(()=>null),null)
        const contract=JSON.parse(await fs.readFile(path.join(laneRoot,'data/logs/e2e-contract.json'),'utf8'));assert.equal(contract.planner_model,pair.models.planner);assert.equal(contract.executor_model,pair.models.executor)
        const delegation=JSON.parse(await fs.readFile(path.join(laneRoot,'data/logs/e2e-delegation-proof.json'),'utf8'));assert.deepEqual(delegation.configured,{planner:pair.models.planner,executor:pair.models.executor})
      }else{
        const calls=(await fs.readFile(path.join(laneRoot,'control-rcon.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
        assert.equal(calls.at(-1).command,'!luna stop')
      }
    } finally {await fs.rm(root,{recursive:true,force:true})}
  })
}
