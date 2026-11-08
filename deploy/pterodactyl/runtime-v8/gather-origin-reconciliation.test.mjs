import assert from 'node:assert/strict'
import test from 'node:test'
import {buildPendingOperation, reconcilePendingOperation, sanitizePendingOperation} from './operation-reconciliation.mjs'

const actor={actor_id:17,epoch:1}
const operations=[{name:'gather_resource',args:{resource_name:'copper-ore',count:10,search_radius:128}},
  {name:'gather_resource',args:{resource_name:'coal',count:1,search_radius:64}}]
const origin={x:-11.54296875,y:-52.33203125}
const witnesses=operations.map((op,index)=>({origin,position:index?{x:-12.5,y:-53.5}:{x:-39.5,y:14.5},
  radius:op.args.search_radius,amount:100,actor_id:17,surface_index:1,force_index:1,tick:100}))
function fixture(){
 const pending=buildPendingOperation({requestId:'origin-fixture',operationKey:'origin-fixture/batch',attemptId:'origin-fixture/batch',ordinal:1,protocolVersion:2,
  operations,actor,surfaceIndex:1,goalId:'goal-origin',planId:'goal-origin-p1',stepId:'goal-origin-p1-s1',now:1000,
  baseline:{generation:1,max_batch_id:3,active:null},preflight:witnesses.map((resource_search,index)=>({ok:true,operation:'gather_resource',identity:operations[index].args.resource_name,resource_search}))})
 const ref={batch_id:4,batch_generation:1,batch_ref:'batch-g1-4'}
 const admission={operation_key:pending.operation_key,attempt_id:pending.attempt_id,actor_id:17,epoch:1,signature:pending.signature,
  ordinal:1,operation_count:2,state:'uncertain',ok:true,error:'batch_reconciliation_required',generation:1,tick:101,
  slots:operations.map((op,index)=>({index:index+1,ok:true,operation:op.name,queued_tasks:2,batch_refs:[ref],
   gather_search_origin:{...origin,surface_index:1,force_index:1,tick:101}}))}
 const receipt={...ref,state:'cancelled',task_count:4,task_types:['walking_to_entity','mining','walking_to_entity','mining'],
  tasks_started:3,started_count:3,tick:200,reason:'navigation_no_target'}
 const status={task_state:'idle',queue_empty:true,queue_length:0,batch_generation:1,actor_surface_index:1,actor_force_index:1,
  admission_journal:[admission],receipt_journal:[receipt]}
 return {pending,admission,receipt,status}
}
test('pending persistence retains only a validated native gather source inside its original admission disk',()=>{
 const {pending}=fixture()
 assert.deepEqual(pending.operations.map(op=>op.resource_search),witnesses)
 assert.deepEqual(sanitizePendingOperation(JSON.parse(JSON.stringify(pending))).operations.map(op=>op.resource_search),witnesses)
 for(const patch of [{actor_id:99},{surface_index:2},{radius:4097},{radius:63},{position:{x:1000,y:1000}},
  {origin:{x:NaN,y:0}},{force_index:0},{tick:-1},{amount:0}]){
  const raw=structuredClone(pending);Object.assign(raw.operations[1].resource_search,patch)
  assert.equal(sanitizePendingOperation(raw).operations[1].resource_search,undefined,JSON.stringify(patch))
 }
})
test('exact navigation failure settles completed copper and untouched coal without inventing whole-batch success',()=>{
 const {pending,status}=fixture()
 const result=reconcilePendingOperation(pending,{status,actor})
 assert.equal(result.reason,'exact_terminal_gather_cancelled')
 assert.equal(result.effect,'partial_known')
 assert.equal(result.cancellation_reason,'navigation_no_target')
 assert.deepEqual(result.slot_outcomes,[{slot:1,operation:'gather_resource',state:'completed'},{slot:2,operation:'gather_resource',state:'navigation_failed_before_acquisition'}])
})
for(const [label,change] of [
 ['missing source',f=>{delete f.pending.operations[1].resource_search}],
 ['wrong native origin',f=>{f.admission.slots[1].gather_search_origin.x++}],
 ['missing native origin',f=>{delete f.admission.slots[1].gather_search_origin}],
 ['origin predates preflight',f=>{f.admission.slots[1].gather_search_origin.tick=99}],
 ['origin after receipt',f=>{f.admission.slots[1].gather_search_origin.tick=201}],
 ['wrong surface',f=>{f.status.actor_surface_index=2}],['wrong force',f=>{f.status.actor_force_index=2}],
 ['busy native',f=>{f.status.task_state='mining'}],['queued native',f=>{f.status.queue_length=1}],
 ['opaque cancellation',f=>{f.receipt.reason='navigation_unknown'}],['wrong failing task',f=>{f.receipt.tasks_started=2}],
 ['duplicate receipts',f=>{f.status.receipt_journal.push({...f.receipt})}],
])test(`gather-origin terminal proof retains uncertainty for ${label}`,()=>{
 const f=fixture();change(f)
 assert.notEqual(reconcilePendingOperation(f.pending,{status:f.status,actor}).reason,'exact_terminal_gather_cancelled')
})
