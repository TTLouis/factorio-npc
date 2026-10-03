import test from 'node:test'
import assert from 'node:assert/strict'
import { operationLedger, recordOperation, settleOperation, conflictingOperation } from './operation-ledger.mjs'
import { buildPendingOperation, reconcilePendingOperation, EFFECT } from './operation-reconciliation.mjs'
import { applyPlanningEvent, createEmptyPlanningState, PLANNING_EVENT, serializePlanningState, restorePlanningState, carriedAcrossGoals } from './planning-state.mjs'
const actor = { actor_id: 18, epoch: 3 }
function record(key, item = 'coal') {
  return buildPendingOperation({ requestId:'req', operationKey:key, ordinal:1, protocolVersion:2, goalId:'goal', actor,
    operations:[{name:'move_items_exact',args:{item_name:item,unit_number:42,max_count:5,to_entity:true}}] })
}
test('unresolved operations survive new operations, task teardown and restart without overwriting', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(),{type:PLANNING_EVENT.GOAL_ACCEPTED,goal_id:'goal',owner:'Louis',objective:'deliver coal',now:1})
  for (const key of ['one','two']) state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',goal_id:'goal',operation:record(key),now:2})
  assert.deepEqual(state.operation_ledger.records.map(item=>item.operation_key),['one','two'])
  state=restorePlanningState(serializePlanningState(state))
  assert.equal(state.operation_ledger.records[0].signature.length,64)
  assert.equal(state.operation_ledger.records[0].signature,record('one').signature)
  assert.equal(carriedAcrossGoals(state).operation_ledger.records.length,2)
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',goal_id:'goal',operation:null,operation_key:'one',now:3})
  assert.deepEqual(state.operation_ledger.records.map(item=>item.operation_key),['two'])
})
test('ledger retains all 64 unresolved records and refuses overflow', () => {
  let ledger=operationLedger()
  for(let index=0;index<64;index++) ledger=recordOperation(ledger,record(String(index)))
  assert.equal(recordOperation(ledger,record('overflow')),null)
  assert.equal(ledger.records.length,64)
  assert.equal(settleOperation(ledger,'0').records.length,63)
})
test('changed count, changed step and replacement plan do not evade unresolved scope guard', () => {
  const state={operation_ledger:recordOperation(null,record('one'))}
  const guard=conflictingOperation(state,{operations:[{name:'move_items_exact',args:{item_name:'coal',unit_number:43,max_count:1}}],planId:'new',stepId:'new'})
  assert.equal(guard.refuse,true)
  assert.equal(conflictingOperation(state,{operations:[{name:'move_items_exact',args:{item_name:'copper-plate',unit_number:99}}]}).refuse,false)
})

test('exact mining and placement cannot claim material independence from related transfers', () => {
  for (const operation of [{name:'mine_entity_exact',args:{unit_number:43}},
    {name:'place_entity',args:{entity_name:'fast-transport-belt',position:{x:1,y:2}}}]) {
    const pending=buildPendingOperation({operationKey:'unknown_material',ordinal:1,protocolVersion:2,actor,operations:[operation]})
    const state={operation_ledger:recordOperation(null,pending)}
    assert.equal(conflictingOperation(state,{operations:[{name:'move_items_exact',args:{unit_number:44,item_name:'wood',max_count:1}}]}).refuse,true)
  }
})
test('unrelated completed batches cannot settle an exact admission, nor can missing identity', () => {
  const pending=record('one')
  const status={task_state:'idle',queue_length:0,batch_generation:2,last_completed_batch:{batch_id:100}}
  assert.equal(reconcilePendingOperation(pending,{status,actor}).effect,EFFECT.UNKNOWN)
  const admission={operation_key:'one',attempt_id:'one',signature:pending.signature,actor_id:18,epoch:3,state:'completed',ordinal:1,operation_count:1,generation:2}
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[admission]},actor}).effect,EFFECT.HAPPENED)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[admission]},actor:{}}).effect,EFFECT.UNKNOWN)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[{...admission,signature:'other'}]},actor}).effect,EFFECT.UNKNOWN)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[{...admission,state:'not_admitted'}]},actor}).effect,EFFECT.NOT_HAPPENED)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,batch_generation:3,admission_journal:[admission]},actor}).effect,EFFECT.PARTIAL_UNKNOWN)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[admission]},actor:{actor_id:19,epoch:4}}).effect,EFFECT.HAPPENED)
  assert.equal(reconcilePendingOperation(pending,{status:{...status,admission_journal:[{...admission,state:'admitted'}]},actor:{actor_id:19,epoch:4}}).verdict,'stale_actor')
})

test('new goals and historical task checkpoints cannot rewind operation ordinals or forget unresolved work', () => {
  let state=applyPlanningEvent(createEmptyPlanningState(),{type:PLANNING_EVENT.GOAL_ACCEPTED,goal_id:'goal',objective:'deliver',owner:'Louis',now:1})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.DRAFT_CREATED,now:1,steps:[{description:'Deliver the coal'}]})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.PLAN_COMMITTED,now:1,runtime_validation:{passed:true}})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',goal_id:'goal',operation:record('one'),now:2})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.TASK_INTERRUPTED,source:'runtime',goal_id:'goal',now:3,game_tick:100})
  assert.equal(state.operation_ledger.records.length,1)
  const checkpoint=state.task_ledger.tasks.find(task=>task.goal_id==='goal').checkpoint.planning
  assert.equal(checkpoint.operation_ledger,undefined)
  assert.equal(checkpoint.run.pending_operation,null)
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.GOAL_ACCEPTED,goal_id:'other',objective:'independent work',owner:'Louis',now:4})
  assert.equal(state.operation_ledger.sequence,1)
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',goal_id:'other',operation:{...record('two','copper-plate'),goal_id:'other'},now:5})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.TASK_INTERRUPTED,source:'runtime',goal_id:'other',now:6,game_tick:200})
  state=applyPlanningEvent(state,{type:PLANNING_EVENT.TASK_RESUMED,source:'user',task_id:'task:goal',now:7})
  assert.equal(state.operation_ledger.sequence,2)
  assert.deepEqual(state.operation_ledger.records.map(item=>item.operation_key),['one','two'])
})

test('goalless restore preserves uncertainty and upgrades legacy watermark records conservatively', () => {
  const legacy={...record('legacy'),protocol_version:1,ordinal:null}
  const restored=restorePlanningState({operation_ledger:{sequence:9,records:[legacy]}})
  assert.equal(restored.operation_ledger.sequence,9)
  assert.equal(restored.operation_ledger.records[0].protocol_version,2)
  assert.deepEqual(restored.operation_ledger.records[0].scopes,['*'])
  assert.equal(reconcilePendingOperation(restored.operation_ledger.records[0],{actor,status:{task_state:'idle',queue_length:0,batch_generation:1,last_completed_batch:{batch_id:100}}}).effect,EFFECT.UNKNOWN)
})

test('runtime can reconcile existing work after goal teardown but cannot admit new work or change its identity', () => {
  for (const goal of [null, {goal_id:'goal',status:'cancelled'}, {goal_id:'goal',status:'completed'}]) {
    let state={...createEmptyPlanningState(),goal,operation_ledger:recordOperation(null,record('one'))}
    state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',operation:{...record('one'),effect:EFFECT.PARTIAL_UNKNOWN},now:1})
    assert.equal(state.operation_ledger.records[0].effect,EFFECT.PARTIAL_UNKNOWN)
    const held=state
    assert.equal(applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',operation:record('new'),now:2}),held)
    assert.equal(applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',operation:{...record('one'),signature:'changed'},now:2}),held)
    assert.equal(applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'model',operation:null,operation_key:'one',now:2}),held)
    state=applyPlanningEvent(state,{type:PLANNING_EVENT.PENDING_OPERATION_RECORDED,source:'runtime',operation:null,operation_key:'one',now:3})
    assert.equal(state.operation_ledger.records.length,0)
    assert.equal(state.operation_ledger.closed.at(-1).operation_key,'one')
  }
})
