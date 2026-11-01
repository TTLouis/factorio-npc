import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {beginColdIntake,withLaunchGate,readLaunchStop} from './templates/launch-control.mjs'
import {definePair,kitRoot} from './pair.mjs'
const candidate='c'.repeat(40)
async function fixture(reason) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paired-launch-boundary-'))
  const pair=definePair({candidate,published:'b'.repeat(40),imageId:`sha256:${'d'.repeat(64)}`})
  await fs.writeFile(path.join(root,'pair.json'),JSON.stringify(pair))
  await fs.copyFile(path.join(kitRoot,'coordinator/pair-common.ps1'),path.join(root,'pair-common.ps1'))
  for(const id of ['a','b']) {
    await fs.mkdir(path.join(root,id,'data/logs'),{recursive:true})
    await fs.writeFile(path.join(root,id,'live-container.cid'),'a'.repeat(64))
    await fs.writeFile(path.join(root,id,'deployed-node-path.txt'),'/opt/sgluna/.sgluna/releases/fixture/node/bin/node')
  }
  await fs.writeFile(path.join(root,'quota-latest.json'),JSON.stringify({pairId:pair.pairId,source:'get_usage_limits',observedBy:'parent:/root',matchingWeeklyWindows:1,windowDurationMins:10080,
    remainingPercent:reason==='weekly_remaining_floor_reached'?7:20,observedAt:Date.now()-(reason==='shared_quota_evidence_stale'?180001:0)}))
  return {root,pair,laneRoot:path.join(root,'a'),identity:{run_id:pair.lanes[0].runId,source:candidate,epoch:3,actor_id:42}}
}
function stop(f,reason) {
  return execFileSync('pwsh',['-NoProfile','-File',path.join(kitRoot,'control-dispatch.test.ps1'),'-Root',f.root,'-Lane','a','-Reason',reason,'-Kit',kitRoot],{encoding:'utf8'})
}
for(const reason of ['owner_canceled','shared_quota_evidence_stale','weekly_remaining_floor_reached']) {
  test(`actual coordinator stop ${reason} from owned preflight identity prevents the starter and intake`,async()=>{
    const f=await fixture(reason);let starter=0; let intake=0
    try {
      await fs.writeFile(path.join(f.laneRoot,'data/logs/prelaunch-cold-proof.json'),JSON.stringify({...f.identity,helper_root:f.laneRoot,phase:'prelaunch'}))
      stop(f,reason)
      await assert.rejects(beginColdIntake({root:f.laneRoot,logs:path.join(f.laneRoot,'data/logs'),identity:f.identity,giveStarter:async()=>{starter++},prepareIntake:async()=>{},submitObjective:async()=>{intake++}}),{code:'launch_canceled',reason})
      assert.equal(starter,0);assert.equal(intake,0)
      const decision=JSON.parse(await fs.readFile(path.join(f.laneRoot,'data/logs/e2e-supervisor-stop-decision.json'),'utf8'))
      assert.equal(decision.goal_id,null);assert.equal(decision.strict_same_goal_confirmation,false)
    } finally {await fs.rm(f.root,{recursive:true,force:true})}
  })
  test(`actual coordinator stop ${reason} between starter and intake prevents submission without a goal identity`,async()=>{
    const f=await fixture(reason);let intake=0; let starter=0
    try {
      await assert.rejects(beginColdIntake({root:f.laneRoot,logs:path.join(f.laneRoot,'data/logs'),identity:f.identity,
        giveStarter:async()=>{starter++;return {}},prepareIntake:async()=>{stop(f,reason)},submitObjective:async()=>{intake++}}),{code:'launch_canceled',reason})
      assert.equal(starter,1);assert.equal(intake,0)
      const calls=(await fs.readFile(path.join(f.laneRoot,'control-rcon.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls.length,2);assert.equal(calls[1].command,'!luna stop')
      await assert.rejects(fs.stat(path.join(f.root,'b/control-rcon.jsonl')),{code:'ENOENT'})
      await assert.rejects(fs.stat(path.join(f.laneRoot,'data/logs/e2e-trial-identity.json')),{code:'ENOENT'})
      const decision=JSON.parse(await fs.readFile(path.join(f.laneRoot,'data/logs/e2e-supervisor-stop-decision.json'),'utf8'))
      assert.equal(decision.goal_id,null);assert.equal(decision.strict_same_goal_confirmation,false)
    } finally {await fs.rm(f.root,{recursive:true,force:true})}
  })
  for(const pendingRole of ['initial_llm','goal_admission_jev'])test(`actual coordinator stop ${reason} dispatches during ${pendingRole} with delayed persistence`,async()=>{
    const f=await fixture(reason);let release;const pending=new Promise(r=>release=r);let submits=0
    try {
      const launched=await beginColdIntake({root:f.laneRoot,logs:path.join(f.laneRoot,'data/logs'),identity:f.identity,giveStarter:async()=>({}),prepareIntake:async()=>{},
        submitObjective:async()=>{submits++;void pending;return 'intake queued'}})
      assert.equal(launched.control.phase,'intake_pending')
      stop(f,reason)
      const calls=(await fs.readFile(path.join(f.laneRoot,'control-rcon.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls[1].command,'!luna stop');assert.equal(submits,1)
      assert.equal(await fs.stat(path.join(f.laneRoot,'data/logs/e2e-trial-identity.json')).catch(()=>null),null)
      assert.equal(await fs.stat(path.join(f.root,'b/control-rcon.jsonl')).catch(()=>null),null)
      release();await pending
      // This proves kit dispatch and no duplicate intake. The unchanged runtime
      // abort-swallow defect is a separate launch gate, not hidden by this mock.
      assert.equal(submits,1)
    } finally {release();await fs.rm(f.root,{recursive:true,force:true})}
  })
}
test('launch gate serializes stop and intake control, and never steals a held owner',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paired-launch-gate-'));let release
  try {
    let entered;const ready=new Promise(r=>entered=r)
    const first=withLaunchGate(root,async()=>{entered();await new Promise(r=>release=r)})
    await ready
    await assert.rejects(withLaunchGate(root,async()=>assert.fail('stale takeover'),{timeoutMs:20}))
    release();await first
    await withLaunchGate(root,async()=>{})
  } finally {release?.();await fs.rm(root,{recursive:true,force:true})}
})
test('a launch-scoped stop adopts only its own newly persisted goal and rejects source/epoch/control drift',async()=>{
  const f=await fixture('owner_canceled')
  try {
    const launched=await beginColdIntake({root:f.laneRoot,logs:path.join(f.laneRoot,'data/logs'),identity:f.identity,giveStarter:async()=>({}),prepareIntake:async()=>{},submitObjective:async()=>''})
    await fs.mkdir(path.join(f.laneRoot,'data/.sgluna'))
    await fs.writeFile(path.join(f.laneRoot,'data/.sgluna/npc-state.json'),JSON.stringify({planning_states:[{state:{goal:{goal_id:'own_new_goal'}}}]}))
    stop(f,'owner_canceled')
    const decision=JSON.parse(await fs.readFile(path.join(f.laneRoot,'data/logs/e2e-supervisor-stop-decision.json'),'utf8'))
    assert.equal(decision.goal_id,'own_new_goal');assert.equal(decision.strict_same_goal_confirmation,false)
    assert.equal(await readLaunchStop(f.laneRoot,launched.control,'own_new_goal'),'owner_canceled')
    const file=path.join(f.laneRoot,'operator-stop-request.json'); const request=JSON.parse(await fs.readFile(file,'utf8'))
    for(const edit of [{source:'e'.repeat(40)},{epoch:4},{launchControlId:'other'},{runId:f.pair.lanes[1].runId}]) {
      await fs.writeFile(file,JSON.stringify({...request,...edit}))
      await assert.rejects(readLaunchStop(f.laneRoot,launched.control,'own_new_goal'))
    }
  } finally {await fs.rm(f.root,{recursive:true,force:true})}
})
