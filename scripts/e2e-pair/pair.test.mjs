import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { definePair, freezePair, render, assertNativeSeed, imageTeardownDecision, sharedQuotaDecision, kitRoot, files } from './pair.mjs'
import {operatorStopReason} from './templates/pair-stop-policy.mjs'
import {verifyPeerSuccess} from './coordinator/verify-peer-success.mjs'
const sha=x=>crypto.createHash('sha256').update(x).digest('hex')
const repo=path.resolve(kitRoot,'../..')
const candidate=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
const opts={candidate,published:'b'.repeat(40),imageId:'sha256:'+ 'c'.repeat(64)}
const pair=definePair(opts)
const quota=(extra={})=>({pairId:pair.pairId,remainingPercent:25,observedAt:1000,source:'get_usage_limits',observedBy:'parent:/root',matchingWeeklyWindows:1,windowDurationMins:10080,...extra})
const cap={pairId:pair.pairId,imageId:pair.imageId,imageTag:pair.imageTag,tagInitiallyAbsent:true}
const lanes={a:{runId:pair.lanes[0].runId,cleanupVerified:true},b:{runId:pair.lanes[1].runId,cleanupVerified:true}}
test('two frozen worlds differ in seed and all host resources, share exactly one immutable source/image/profile',()=>{
  assert.deepEqual(pair.lanes.map(l=>l.seed),[2026102501,2026102502])
  for(const key of ['runId','project','resourcePrefix','saveName','container','tunnelPort','recorderPort','rconHostPort','gamePort'])assert.notEqual(pair.lanes[0][key],pair.lanes[1][key],key)
  assert.equal(pair.lanes[0].rconInternalPort,27015);assert.equal(pair.lanes[1].rconInternalPort,27015)
  assert.equal(pair.constructionLimitMs,3600000);assert.equal(pair.profile,'normal')
  for(const seeds of [[1,1],[0,2],[-1,2],[1,2.5],[1,2,3],[1,0x100000000]])assert.throws(()=>definePair({...opts,seeds}))
  for(const edit of [{candidate:'main'},{imageId:'factorio-npc:local'},{version:'a;bad'},{published:''}])assert.throws(()=>definePair({...opts,...edit}))
})
test('frozen map seed cannot drift to default, peer or string value',()=>{
  assert.doesNotThrow(()=>assertNativeSeed({seed:2026102501},2026102501))
  for(const seed of [undefined,0,2026102502,'2026102501'])assert.throws(()=>assertNativeSeed({seed},2026102501))
  assert.throws(()=>render('@@MISSING@@',{}));assert.equal(render('@@A@@ @@A@@',{A:42}),'42 42')
})
test('lane A ending never permits tag teardown while B remains; wrong capability/tag/resources retain it',()=>{
  const input={pair,ledger:cap,lanes,containers:[],networks:[],volumes:[],tagId:pair.imageId}
  assert.equal(imageTeardownDecision(input).action,'remove_unique_pair_tag')
  assert.equal(imageTeardownDecision({...input,tagId:null}).action,'already_absent')
  for(const edit of [{lanes:{...lanes,b:{...lanes.b,cleanupVerified:false}}},{lanes:{...lanes,b:{...lanes.b,runId:'other'}}},
    {ledger:{...cap,tagInitiallyAbsent:false}},{ledger:{...cap,imageId:'other'}},{tagId:'other'},
    {containers:['peer-running']},{networks:['stopped-lane-network']},{volumes:['owned-volume']}])assert.throws(()=>imageTeardownDecision({...input,...edit}))
})
test('shared quota fail-closed reasons distinguish stale/unavailable from actual floor, including before admission',()=>{
  assert.equal(sharedQuotaDecision(pair,quota(),2000),'continue')
  assert.equal(sharedQuotaDecision(pair,quota({remainingPercent:7}),2000),'stop_both_shared_quota_floor')
  assert.equal(sharedQuotaDecision(pair,quota({remainingPercent:5}),2000),'stop_both_shared_quota_floor')
  assert.equal(sharedQuotaDecision(pair,quota(),181001),'shared_quota_evidence_stale')
  for(const q of [null,{},quota({pairId:'peer'}),quota({matchingWeeklyWindows:2}),quota({source:'model'}),quota({observedBy:'unowned'}),quota({remainingPercent:null}),quota({observedAt:3000})])assert.equal(sharedQuotaDecision(pair,q,2000),'shared_quota_evidence_unavailable')
})
test('peer cancellation, owner stop and quota stops keep exact lane/actor/goal scope and distinct reasons',()=>{
  const identity={runId:pair.lanes[0].runId,goalId:'goal_a',actorId:42}
  const req={...identity,reason:'canceled_after_peer_verified_success',peerRunId:pair.lanes[1].runId,peerAcceptanceSha256:'a'.repeat(64)}
  assert.equal(operatorStopReason(null,identity),null)
  assert.equal(operatorStopReason(req,identity),'canceled_after_peer_verified_success')
  for(const edit of [{runId:pair.lanes[1].runId},{goalId:'goal_b'},{actorId:43},{reason:'gameplay_success'},{peerRunId:identity.runId},{peerAcceptanceSha256:''}])assert.throws(()=>operatorStopReason({...req,...edit},identity))
  for(const reason of ['owner_canceled','shared_quota_evidence_stale','shared_quota_evidence_unavailable','weekly_remaining_floor_reached'])assert.equal(operatorStopReason({...req,reason},identity),reason)
})

function fixture() {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sgluna-pair-kit-'))
  const nativeDir=path.join(temp,'compiled');fs.mkdirSync(nativeDir)
  fs.writeFileSync(path.join(nativeDir,'info.json'),'{"name":"autorio","version":"0.1.0"}\n')
  const nativeManifest=path.join(temp,'native.json')
  fs.writeFileSync(nativeManifest,JSON.stringify([{path:'info.json',sha256:sha(fs.readFileSync(path.join(nativeDir,'info.json')))}]))
  const output=path.join(temp,'pair')
  return {temp,nativeDir,nativeManifest,output,repo,nativeBuildSource:candidate,...opts}
}
test('real freezer is candidate agnostic, input-only and immutable; generated launch/cleanup/native proofs are lane bound',()=>{
  const input=fixture()
  try {
    const frozen=freezePair(input)
    assert.equal(frozen.candidate,candidate)
    assert.throws(()=>freezePair(input),/replace/)
    const read=(id,name)=>fs.readFileSync(path.join(input.output,id,name),'utf8')
    for(const lane of frozen.lanes) {
      const overlay=read(lane.id,'live.compose.yml')
      assert.ok(overlay.includes(`127.0.0.1:${lane.gamePort}:${lane.gamePort}/udp`))
      assert.ok(overlay.includes(`127.0.0.1:${lane.rconHostPort}:27015/tcp`))
      assert.ok(overlay.includes(pair.imageId));assert.ok(overlay.includes(`SERVER_PORT: "${lane.gamePort}"`))
      assert.ok(read(lane.id,'create-world.sh').includes('--map-gen-settings /proof/map-gen-settings.json --create'))
      assert.equal(JSON.parse(read(lane.id,'map-gen-settings.json')).seed,lane.seed)
      const runner=read(lane.id,'run-live.mjs')
      assert.ok(runner.includes(`s.seed!==${lane.seed}`))
      assert.ok(runner.indexOf('before = assertSeed')<runner.indexOf('const starter ='))
      for(const name of ['preflight.mjs','supervisor-preflight.mjs','prelaunch-cold-check.mjs'])assert.ok(read(lane.id,name).includes(String(lane.seed)),name)
      assert.ok(runner.includes("const constructionLimitMs = 60 * 60000"))
      const cleanup=read(lane.id,'finish-cleanup.ps1')
      assert.doesNotMatch(cleanup,/image rm|ancestor=|run-av|20261025av/)
      assert.ok(cleanup.includes(`label=owner.run=${lane.runId}`))
      for(const name of files(path.join(input.output,lane.id))) {
        if(name.startsWith('independent-native/'))continue
        assert.doesNotMatch(read(lane.id,name),/@@[A-Z_]+@@|red-automation-live-2026-10-25av|red-automation-20261025av|run-av-/)
      }
      assert.deepEqual(fs.readdirSync(path.join(input.output,lane.id,'data')),['logs','saves'])
      const manifest=JSON.parse(read(lane.id,'helper-manifest.json'))
      for(const e of manifest)assert.equal(sha(fs.readFileSync(path.join(input.output,lane.id,e.path))),e.sha256)
    }
    const manifest=JSON.parse(fs.readFileSync(path.join(input.output,'pair-manifest.json')))
    for(const e of manifest)assert.equal(sha(fs.readFileSync(path.join(input.output,e.path))),e.sha256)
  } finally {fs.rmSync(input.temp,{recursive:true,force:true})}
})
test('wrong native compile source, path set or digest is rejected before writing a pair',()=>{
  for(const mode of ['source','paths','digest']) {
    const input=fixture()
    try {
      if(mode==='source')input.nativeBuildSource='d'.repeat(40)
      if(mode==='paths')fs.writeFileSync(path.join(input.nativeDir,'extra.json'),'{}')
      if(mode==='digest')fs.writeFileSync(path.join(input.nativeDir,'info.json'),'{}')
      assert.throws(()=>freezePair(input));assert.equal(fs.existsSync(input.output),false)
    } finally {fs.rmSync(input.temp,{recursive:true,force:true})}
  }
})

test('peer success requires actual native measurement acceptance; wrapper exit, placement and claimed goal completion do not suffice',async()=>{
  const input=fixture()
  try {
    freezePair(input)
    const logs=path.join(input.output,'a/data/logs')
    fs.writeFileSync(path.join(input.output,'a/run-live-exit.txt'),'0\n')
    await assert.rejects(verifyPeerSuccess(input.output,'a'))
    const names=['iron-ore','copper-ore','coal','iron-plate','copper-plate','iron-gear-wheel','automation-science-pack']
    const sample=end=>({wall_ms:end?300001:0,tick:end?36000:0,speed:2,humans:0,actor_id:42,health:250,operations:{task_state:'idle',queue_empty:true,queue_length:0},crafting_queue:[],
      production:Object.fromEntries(names.map(n=>[n,{produced:end?10:0}])),machines:[{id:1,recipe:'automation-science-pack',health:350,products_finished:end?10:0,network:7,energy:100},
        {id:2,recipe:'iron-gear-wheel',health:350,products_finished:end?10:0,network:7,energy:100},{id:3,type:'electric-pole',network:7,health:100,network_producers:[{name:'steam-engine',flow:10}]},{id:4,name:'steam-engine',health:400,fluids:[{name:'steam',amount:10}]}]})
    const result={run_id:pair.lanes[0].runId,result:'native_automated_red_rate_success',goal_id:'goal_a',before:{actor_id:42,seed:pair.lanes[0].seed},stop_confirmation:{receipt_scope:{run_id:pair.lanes[0].runId},boundary:'fresh_supervisor_cancel_and_same_goal_operator_pause'}}
    const completion={satisfied:true,goal_id:'goal_a',initial_actor:42}
    const save=(name,data)=>fs.writeFileSync(path.join(logs,name),JSON.stringify(data))
    save('e2e-result.json',result);save('e2e-completion-proof.json',completion);save('e2e-measurement-samples.json',[sample(),sample(true)])
    assert.equal((await verifyPeerSuccess(input.output,'a')).verified,true)
    for(const edit of [r=>r.result='goal_closed_without_automated_chain',r=>r.before.seed=pair.lanes[1].seed,r=>r.stop_confirmation.receipt_scope.run_id=pair.lanes[1].runId]) {
      const changed=structuredClone(result);edit(changed);save('e2e-result.json',changed)
      await assert.rejects(verifyPeerSuccess(input.output,'a'))
    }
    save('e2e-result.json',result)
    const short=sample(true);short.tick=35999;save('e2e-measurement-samples.json',[sample(),short])
    await assert.rejects(verifyPeerSuccess(input.output,'a'))
  } finally {fs.rmSync(input.temp,{recursive:true,force:true})}
})
