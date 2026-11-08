import test from 'node:test'
import assert from 'node:assert/strict'
import {NpcAgentLoop} from './npc-agent-loop.mjs'
import {CanonicalTaskBoardMemory} from './canonical-task-board-memory.mjs'
import {FakeFactorio} from './task-loop-fixtures.mjs'
import {sanitizeOwnerGoal,sameOwnerGoalConditions} from './owner-goal-intake.mjs'
const input={goalId:'copper-goal',acceptanceKey:'copper-goal',sender:'Owner',text:'Deliver10newlymachine-smeltedcopperplatesintooneexactnewchest',definition:{scope:'finite',summary:'Finite exact new copper delivery',doneWhen:[{kind:'machine_output_delivered',item_name:'copper-plate',minimum:10}]}}
function fixture(){
 const game=new FakeFactorio();let generations=0
 const forbidden=async()=>{generations++;throw new Error('no preflight inference')}
 const agent=new NpcAgentLoop({memory:new CanonicalTaskBoardMemory(),rcon:game,provider:forbidden,interactionDecisionProvider:forbidden,steeringDecisionProvider:forbidden,skillDecisionProvider:forbidden,stateFile:null,traceFile:null,decisionTraceFile:null})
 return {game,agent,generations:()=>generations}
}
test('typed owner intake durably admits exact goal without any classifier/planner generation or early start',async()=>{
 const {agent,generations}=fixture();const result=await agent.acceptOwnerGoal(input)
 assert.equal(result.inferenceStarted,false);assert.equal(generations(),0)
 const goal=agent.memory.planningState(agent.activePlanKey()).goal
 assert.equal(goal.goal_id,input.goalId);assert.equal(goal.definition.source,'user');assert.equal(goal.definition.done_when[0].minimum,10)
 await assert.rejects(agent.request(input.text,{sender:input.sender}),/owner_goal_awaiting_explicit_start/)
 assert.equal(generations(),0)
 assert.throws(()=>agent.enforceGoalDefinition({goalDefinition:{scope:'finite',done_when:[{kind:'inventory_count',item_name:'copper-plate',minimum:10}]}}),/immutable/)
 assert.throws(()=>agent.enforceGoalDefinition({goalDefinition:{scope:'finite',done_when:[{kind:'machine_output_delivered',item_name:'copper-plate',minimum:1}]}}),/immutable/)
 assert.doesNotThrow(()=>agent.enforceGoalDefinition({}))
})
test('explicit start reaches normal planner with exact owner condition intact and no semantic side generation',async()=>{
 const {agent,generations}=fixture();await agent.acceptOwnerGoal(input)
 const calls=[]
 agent.provider=async(messages,context)=>{calls.push({messages,context});agent.cancel('offline-first-request-boundary');return {content:'offline stop',tool_calls:[]}}
 await agent.runOwnerGoal({goalId:input.goalId}).catch(()=>{})
 assert.equal(generations(),0,'classifier/steering/skill choice never generated')
 assert.equal(calls.length,1,'one ordinary gameplay planner request reached')
 const goal=agent.memory.planningState(agent.activePlanKey()).goal
 assert.equal(goal.goal_id,input.goalId);assert.equal(goal.definition.source,'user');assert.equal(goal.definition.done_when[0].minimum,10)
 await assert.rejects(agent.runOwnerGoal({goalId:input.goalId}),/not_ready/)
})
test('owner key and predicates are immutable, and actor epoch changes prevent starting',async()=>{
 assert.throws(()=>sanitizeOwnerGoal({...input,acceptanceKey:'other'}))
 assert.throws(()=>sanitizeOwnerGoal({...input,definition:{...input.definition,doneWhen:[{kind:'inventory_count',item_name:'copper-plate',minimum:10}]}}))
 const spec=sanitizeOwnerGoal(input);assert.ok(Object.isFrozen(spec.definition.done_when))
 assert.equal(sameOwnerGoalConditions(spec.definition,{...spec.definition,done_when:[{...spec.definition.done_when[0],minimum:9}]}),false)
 const {agent,game,generations}=fixture();await agent.acceptOwnerGoal(input);game.status.epoch++
 await assert.rejects(agent.runOwnerGoal({goalId:input.goalId}),/actor_changed/);assert.equal(generations(),0)
})
