import test from 'node:test'
import assert from 'node:assert/strict'
import {quiesceAndSave,waitForStop} from './runner-terminal.mjs'
import {operatorStopReason} from './pair-stop-policy.mjs'
import {supervisorStop} from './trial-supervisor-stop.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('shared stale/floor and owner/peer cancellation independently obtain fresh same-goal stop and save per lane',async()=>{
  for(const reason of ['shared_quota_evidence_stale','shared_quota_evidence_unavailable','weekly_remaining_floor_reached','owner_canceled','canceled_after_peer_verified_success']) {
    const worlds=['a','b'].map(id=>({id,runId:'pair-'+id,goalId:'goal_'+id,actorId:42,calls:[],receipts:[]}))
    for(const w of worlds) {
      let clock=1000
      const request={runId:w.runId,goalId:w.goalId,actorId:42,reason,peerRunId:'pair-'+(w.id==='a'?'b':'a'),peerAcceptanceSha256:'f'.repeat(64)}
      assert.equal(operatorStopReason(request,w),reason)
      const state={planning_states:[{state:{goal:{goal_id:w.goalId},run:{paused:true,pause_class:'operator',pause_reason:'user_stop',paused_at:500}}}]}
      const native={actor_id:42,speed:1,operations:{task_state:'idle',queue_empty:true,queue_length:0},crafting_queue:[]}
      let proof
      await quiesceAndSave({now:()=>clock,rcon:{command:async command=>{
        w.calls.push(command)
        if(command==='!luna stop') {
          clock++
          w.receipts=[{event:'request.cancelled',ts:new Date(clock).toISOString(),data:{reason:'user_stop_immediate'}},
            {event:'goal.paused',ts:new Date(clock).toISOString(),data:{goal_id:w.goalId,cause:'user_stop',pause_class:'operator'}}]
        }
      }},confirmStopped:({issuedAt})=>waitForStop({readState:async()=>state,readNative:async()=>native,readStopReceipts:async()=>w.receipts,
        receiptScope:{run_id:w.runId,trace_source:'isolated_supervisor_behavior_trace',trace_path:'/data/logs/sgluna-behavior.jsonl'},
        goalId:w.goalId,actorId:42,issuedAt,now:()=>clock,requirePairedReceipts:true}),
        recordResult:async p=>{proof=p;w.calls.push('persist:'+reason)},saveName:'checkpoint-'+w.id,waitForSave:async()=>w.calls.push('native-save-confirmed:'+w.id)})
      assert.equal(proof.receipt_scope.run_id,w.runId)
      assert.equal(proof.goal_id,w.goalId)
      assert.equal(proof.boundary,'fresh_supervisor_cancel_and_same_goal_operator_pause')
      assert.deepEqual(w.calls.slice(1),['!luna stop','persist:'+reason,'/server-save checkpoint-'+w.id,'native-save-confirmed:'+w.id])
    }
    assert.notEqual(worlds[0].receipts[1].data.goal_id,worlds[1].receipts[1].data.goal_id)
  }
})

test('external operator cancellation is immediate, lane scoped and leaves fresh confirmation/save to its own runner',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paired-supervisor-'))
  try {
    await fs.mkdir(path.join(root,'logs'))
    for(const id of ['a','b']) {
      const runId='pair-'+id,goalId='goal_'+id,calls=[]
      const identity={run_id:runId,goal_id:goalId,actor_id:42,helper_root:root}
      await fs.writeFile(path.join(root,'logs/e2e-trial-identity.json'),JSON.stringify(identity))
      const request={runId,goalId,actorId:42,reason:'shared_quota_evidence_stale'}
      await fs.writeFile(path.join(root,'operator-stop-request.json'),JSON.stringify(request))
      const decision=await supervisorStop({root,expectedRunId:runId,rcon:{command:async c=>calls.push(c)}})
      assert.equal(decision.result,'shared_quota_evidence_stale');assert.equal(decision.run_id,runId);assert.equal(decision.goal_id,goalId)
      assert.match(calls[0],/seal.*external_operator_stop/);assert.equal(calls[1],'!luna stop');assert.equal(calls.length,2)
      await fs.writeFile(path.join(root,'operator-stop-request.json'),JSON.stringify({...request,runId:'other'}))
      await assert.rejects(supervisorStop({root,expectedRunId:runId,rcon:{command:async()=>assert.fail('Cross-lane request reached RCON')}}))
    }
  } finally {await fs.rm(root,{recursive:true,force:true})}
})
