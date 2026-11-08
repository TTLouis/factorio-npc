import test from 'node:test'
import assert from 'node:assert/strict'
import {machineDeliverySpec,armMachineDeliveryCommand,bindMachineDeliveryCommand,evaluateMachineDelivery} from './machine-delivery.mjs'
import {sanitizeGoalDefinition,evaluateGoalDefinition} from './goal-definition.mjs'
import {readCanonicalLibraryTool} from './canonical-library-tools.mjs'
import {readLibrary} from '../../../tools/external-harness/library.mjs'
const spec={acceptance_key:'copper-goal',item_name:'copper-plate',minimum:10,producer_type:'furnace'}
test('finite exact delivery cannot be replaced by actor inventory and native goal key survives evaluation',async()=>{
 const definition=sanitizeGoalDefinition({scope:'finite',summary:'Deliver newly machine produced copper into exact chest',doneWhen:[{id:'delivery',kind:'machine_output_delivered',item_name:'copper-plate',minimum:10}]})
 assert.equal(definition.done_when[0].kind,'machine_output_delivered');let captured
 const result=await evaluateGoalDefinition({...definition,acceptance_key:spec.acceptance_key},async command=>{captured=command;return JSON.stringify({ok:true,satisfied:false,kind:'machine_output_delivered',reason:'exact_destination_unbound_or_gone'})})
 assert.match(captured,/copper-goal/);assert.equal(result.satisfied,false)
})
test('host helper fails closed on cross-goal/changed target claims and rejects injected metadata',async()=>{
 assert.deepEqual(machineDeliverySpec(spec),spec);assert.match(armMachineDeliveryCommand(spec),/arm_machine_delivery/)
 assert.throws(()=>bindMachineDeliveryCommand({acceptance_key:spec.acceptance_key,unit_number:1,lua:'anything'}))
 assert.throws(()=>bindMachineDeliveryCommand({acceptance_key:spec.acceptance_key,unit_number:0}))
 for(const changed of [{acceptance_key:'other'},{item_name:'iron-plate'},{minimum:1}]){
  const reply=await evaluateMachineDelivery(spec,async()=>JSON.stringify({ok:true,satisfied:true,...spec,...changed}))
  assert.equal(reply.satisfied,false)
 }
 assert.equal((await evaluateMachineDelivery(spec,async()=>'{')).satisfied,false)
})
test('internal knowledge/skill retrieval is identical to external canonical search and full gets',async()=>{
 for(const [kind,search,get] of [['knowledge','findKnowledge','getKnowledgeDetails'],['skill','findSkills','getSkillDetails']]){
  for(const query of ['copper smelting','power','fuel runs']){
   const input={kind,action:'search',query,limit:3};const expected=await readLibrary(input)
   assert.deepEqual(JSON.parse(await readCanonicalLibraryTool(search,{query,limit:3})),expected)
   for(const card of expected.results){assert.deepEqual(JSON.parse(await readCanonicalLibraryTool(get,{id:card.id})),await readLibrary({kind,action:'get',id:card.id}))}
  }
 }
})
