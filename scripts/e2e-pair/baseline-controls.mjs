// Immutable ff98d3e5 controls for R1-R3. No real container/process/provider
// boundaries are invoked; actual entry-point source runs with explicit mocks.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {render,kitRoot} from './pair.mjs'
const [repo,evidence,fixture]=process.argv.slice(2)
const baseline='ff98d3e5df2fe69006b3803092c131bc445656db'
const source=name=>execFileSync('git',['-C',repo,'show',`${baseline}:scripts/e2e-pair/${name}`],{encoding:'utf8'})
const pair=JSON.parse(fs.readFileSync(path.join(fixture,'pair.json'),'utf8'))
const base=path.join(evidence,'baseline-controls');fs.mkdirSync(base)
const hash=x=>crypto.createHash('sha256').update(x).digest('hex')
const results=[]
function ps(name,args) {
  const r=spawnSync('pwsh',['-NoProfile','-File',path.join(kitRoot,name),...args],{encoding:'utf8'})
  return {status:r.status,text:(r.stdout??'')+(r.stderr??'')}
}

// R2: the unchanged top-level launch refuses missing quota before its finally.
const coordinator=path.join(base,'r2-pair');fs.cpSync(fixture,coordinator,{recursive:true})
for(const name of ['pair-common.ps1','run-pair.ps1','prepare-pair.ps1'])fs.writeFileSync(path.join(coordinator,name),source('coordinator/'+name))
const r2=ps('coordinator-top.test.ps1',['-Fixture',coordinator])
fs.writeFileSync(path.join(base,'r2.log'),r2.text)
assert.notEqual(r2.status,0);assert.match(r2.text,/Missing lane teardown a missing/)
results.push({finding:'R2',baseline,expectedFailure:'Missing lane teardown a missing',exit:r2.status})

// R3: unchanged stack source consumes the mutable repo paths, not snapshots.
const stack=path.join(base,'r3-pair'),external=path.join(base,'mutable-external');fs.cpSync(fixture,stack,{recursive:true});fs.mkdirSync(external)
for(const lane of pair.lanes)fs.writeFileSync(path.join(stack,lane.id,'stack.ps1'),render(source('templates/stack.ps1'),{CANDIDATE:pair.candidate,REPO:external.replaceAll('\\','/'),RCON_HOST_PORT:lane.rconHostPort,GAME_PORT:lane.gamePort,PROJECT:lane.project}))
const r3=ps('stack-freeze.test.ps1',['-Fixture',stack,'-ExternalRepo',external])
fs.writeFileSync(path.join(base,'r3.log'),r3.text)
assert.notEqual(r3.status,0);assert.match(r3.text,/Compose input escaped frozen pair/)
results.push({finding:'R3',baseline,expectedFailure:'Compose input escaped frozen pair',exit:r3.status})

// R1: evaluate the complete old run-live entry point. Its filesystem and RCON
// dependencies are deterministic substitutes; the old coordinator is invoked
// exactly after e2e-started and before objective submission, with no goal file.
const lane=pair.lanes[0],r1=path.join(base,'r1-pair');fs.cpSync(fixture,r1,{recursive:true})
fs.writeFileSync(path.join(r1,'pair-common.ps1'),source('coordinator/pair-common.ps1'))
const laneRoot=path.join(r1,'a')
const stopScript=path.join(r1,'old-stop.ps1')
fs.writeFileSync(stopScript,`. (Join-Path $PSScriptRoot 'pair-common.ps1')\n$p=Read-Pair\nWrite-LaneStop $p.lanes[0] owner_canceled\n$sent=Invoke-LaneSupervisorStop $p.lanes[0]\n@{sent=$sent}|ConvertTo-Json -Compress\n`)
let submitted=0,dispatch
const code=render(source('templates/run-live.mjs'),{CANDIDATE:pair.candidate,RUN_ID:lane.runId,SEED:lane.seed,SAVE_NAME:lane.saveName})
fs.writeFileSync(path.join(base,'r1-runner-baseline.mjs'),code)
const map=file=>{file=String(file);if(file.startsWith('/data/'))return path.join(laneRoot,'data',file.slice(6));if(file.startsWith('/e2e/'))return path.join(laneRoot,file.slice(5));return file}
const fakeFs={...fsp,realpath:async()=>'/opt/sgluna/.sgluna/releases/fixture/start-sgluna.sh',
  readFile:async(file,...args)=>file==='/opt/sgluna/SOURCE_SHA'?pair.candidate:fsp.readFile(map(file),...args),
  stat:async(file,...args)=>fsp.stat(map(file),...args),mkdir:async(file,...args)=>fsp.mkdir(map(file),...args),
  writeFile:async(file,...args)=>{await fsp.writeFile(map(file),...args);if(file==='/data/logs/e2e-started.txt')dispatch=execFileSync('pwsh',['-NoProfile','-File',stopScript],{encoding:'utf8'})}}
class Rcon {
  async connect(){} close(){}
  async command(command) {
    if(command.startsWith('!luna Build')){submitted++;throw Error('BASELINE_LATE_INTAKE_SENTINEL')}
    if(command.includes('Starter already given'))return JSON.stringify({starter:{}})
    return JSON.stringify({seed:lane.seed,humans:0,speed:1,inventory:[],machines:[],red_unlocked:false,green_researched:false,board:null,actor_id:42,epoch:3})
  }
}
const context=vm.createContext({console:{log:()=>{}},process:{argv:['node','run-live.mjs','--go'],env:{TYPESAFE_API_KEY:'offline',SGLUNA_E2E_RUN_ID:lane.runId}},setTimeout,clearTimeout})
async function moduleWith(exports) {const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v)},{context});await m.link(()=>{});await m.evaluate();return m}
const common=await moduleWith({Rcon})
const imports={
  './tick-sprint-policy.mjs':{sprintSpeedValid:()=>true,summarizeTickSprints:()=>({}),TICK_SPRINT:{}},
  './automation-proof.mjs':{measurementReady:()=>false,measureFactory:()=>{},topologyReviewApproved:()=>false},
  './runner-terminal.mjs':Object.fromEntries(['issueAndConfirmStrictStop','quiesceAndSave','stopStateConfirmed','waitForStop'].map(k=>[k,()=>{}])),
  './trial-stop-policy.mjs':{trialStopDecision:()=>{}},'./pair-stop-policy.mjs':{operatorStopReason:()=>null},
  'node:crypto':{default:crypto},'node:fs/promises':{default:fakeFs},'node:path':{default:path.posix},'node:url':{pathToFileURL}}
const runner=new vm.SourceTextModule(code,{context,importModuleDynamically:()=>common})
await runner.link(async name=>{assert.ok(imports[name],name);return moduleWith(imports[name])})
await assert.rejects(runner.evaluate(),/BASELINE_LATE_INTAKE_SENTINEL/)
assert.equal(submitted,1);assert.equal(JSON.parse(dispatch).sent,false)
assert.equal(fs.existsSync(path.join(laneRoot,'operator-stop-request.json')),false)
const r1Proof={finding:'R1',baseline,objectiveSubmissionsAfterOwnerStop:submitted,immediateCancelDispatched:false,goalPersistenceAbsent:true,runnerSha256:hash(code),controlSourceSha256:hash(source('coordinator/pair-common.ps1'))}
fs.writeFileSync(path.join(base,'r1.json'),JSON.stringify(r1Proof,null,2))
results.push(r1Proof)
fs.writeFileSync(path.join(base,'summary.json'),JSON.stringify({baseline,findings:results,scope:'Original defects reproduced with actual entry-point sources and explicit offline resource/RCON substitutes; no gameplay/provider claim'},null,2))
console.log('PASS three immutable ff98d3e5 negative controls reproduce R1/R2/R3; expected failures retained')
