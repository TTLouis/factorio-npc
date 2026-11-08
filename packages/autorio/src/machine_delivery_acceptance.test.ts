import { beforeEach, expect, it } from 'vitest'
import { arm_machine_delivery, bind_machine_delivery, bind_current_machine_delivery, evaluate_machine_delivery, note_machine_delivery_nonmachine_gain, note_machine_delivery_placement, tick_machine_delivery } from './machine_delivery_acceptance'

const spec={acceptance_key:'copper-test',item_name:'copper-plate',minimum:10,producer_type:'furnace'}
let total=0; let entities:any[]=[]; let identity:any; let actor:any; let force:any; let surface:any; let recipe:any
function entity(unit:number,type='container',count=0,aliases=1){
 const inv={valid:true,get_contents:()=>count?[{name:'copper-plate',count}]:[],get_item_count:()=>count}
 const e:any={valid:true,unit_number:unit,name:type==='furnace'?'test-furnace':'test-chest',type,force,surface,products_finished:0,crafting_progress:0,
  get_max_inventory_index:()=>aliases,get_inventory:()=>inv,get_recipe:()=>[recipe]}
 e.setCount=(n:number)=>{count=n};entities.push(e);return e
}
function place(e:any){
 const admission={state:'admitted',actor_id:1,epoch:1,slots:[{batch_refs:[{batch_id:e.unit_number,batch_generation:1}]}]}
 ;(globalThis as any).storage.sgluna_operation_admissions.push(admission)
 note_machine_delivery_placement(actor,e,{batch_id:e.unit_number,batch_generation:1});tick_machine_delivery(actor)
}
function produce(e:any,n:number,chest:any,stock=n){e.products_finished=n;total=n;chest.setCount(stock);tick_machine_delivery(actor)}
beforeEach(()=>{
 total=0;entities=[];recipe={name:'live-test-recipe',products:[{name:'copper-plate',type:'item',amount:1,independent_probability:1,shared_probability:{min:0,max:1}}]}
 identity={actor_id:1,epoch:1,session:'external-fixture',allowed:true}
 force={index:1,get_item_production_statistics:()=>({get_input_count:()=>total})}
 surface={index:1,find_entities_filtered:()=>entities}
 actor={is_valid:true,character:{valid:true},force,surface,status_snapshot:()=>({actor_id:1})}
 Object.assign(globalThis,{storage:{sgluna_operation_admissions:[]},math:Math,log:()=>{},prototypes:{item:{'copper-plate':{}}},defines:{inventory:{chest:1}},
  game:{tick:100,connected_players:[],forces:[[1,force]],surfaces:[[1,surface]]},
  remote:{interfaces:{sgluna_deployment:{status:true,authorize:true}},call:(_i:string,method:string)=>method==='status'?identity:identity.allowed},
  pcall:(f:()=>unknown)=>{try{return [true,f()]}catch{return [false,undefined]}}})
})
it('requires ten current new plates in the explicitly selected exact chest; supports automated transport',()=>{
 expect(arm_machine_delivery(actor,spec).ok).toBe(true)
 const furnace=entity(1,'furnace'); const chest=entity(2);place(furnace);place(chest)
 expect(bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:2}).ok).toBe(true)
 produce(furnace,9,chest);expect(evaluate_machine_delivery(actor,spec).satisfied).toBe(false)
 produce(furnace,10,chest);expect(evaluate_machine_delivery(actor,spec)).toMatchObject({satisfied:true,current:10,newly_machine_produced:10,destination_unit_number:2})
 chest.setCount(9);expect(evaluate_machine_delivery(actor,spec).satisfied).toBe(false)
})
it('excludes global seeded stock and rejects unrecorded or swapped destinations',()=>{
 const old=entity(99,'container',10);expect(arm_machine_delivery(actor,spec).baseline_stock).toBe(10)
 expect(bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:old.unit_number}).ok).toBe(false)
 const furnace=entity(1,'furnace'); const chest=entity(2); const other=entity(3);place(furnace);place(chest);place(other)
 expect(bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:2}).ok).toBe(true)
 expect(bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:3}).ok).toBe(false)
 produce(furnace,10,chest,10);expect(evaluate_machine_delivery(actor,spec)).toMatchObject({satisfied:false,new_delivered_lower_bound:0})
})
it('cannot double count an aliased destination inventory',()=>{
 arm_machine_delivery(actor,spec);const furnace=entity(1,'furnace'); const chest=entity(2,'container',0,2);place(furnace);place(chest)
 bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:2});produce(furnace,10,chest,5)
 expect(evaluate_machine_delivery(actor,spec)).toMatchObject({satisfied:false,current:5})
})
it('manual ore/fuel servicing remains valid; target hand-work cannot establish machine provenance',()=>{
 arm_machine_delivery(actor,spec);const furnace=entity(1,'furnace'); const chest=entity(2);place(furnace);place(chest);bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:2})
 note_machine_delivery_nonmachine_gain('coal');produce(furnace,10,chest);expect(evaluate_machine_delivery(actor,spec).satisfied).toBe(true)
 note_machine_delivery_nonmachine_gain('copper-plate');expect(evaluate_machine_delivery(actor,spec)).toMatchObject({satisfied:false,reason:'nonmachine_target_gain'})
})
it('retains native last-craft evidence when an empty furnace clears its recipe',()=>{
 arm_machine_delivery(actor,spec);const furnace=entity(1,'furnace'); const chest=entity(2);place(furnace);place(chest);bind_machine_delivery(actor,{acceptance_key:spec.acceptance_key,unit_number:2})
 produce(furnace,9,chest);furnace.crafting_progress=0.99;tick_machine_delivery(actor)
 recipe=undefined;produce(furnace,10,chest)
 expect(evaluate_machine_delivery(actor,spec)).toMatchObject({satisfied:true,newly_machine_produced:10})
})
it('refuses changed authority, epoch and incomplete baseline evidence',()=>{
 identity.allowed=false;expect(arm_machine_delivery(actor,spec).ok).toBe(false)
 identity.allowed=true;surface.find_entities_filtered=()=>{throw new Error('unreadable')};expect(arm_machine_delivery(actor,spec).ok).toBe(false)
 surface.find_entities_filtered=()=>entities;arm_machine_delivery(actor,spec);identity.epoch=2
 expect(evaluate_machine_delivery(actor,spec).satisfied).toBe(false)
})
it('public current-window binding cannot choose a goal key or reset its baseline',()=>{
 expect(bind_current_machine_delivery(actor,{unit_number:2}).ok).toBe(false)
 arm_machine_delivery(actor,spec);const chest=entity(2);place(chest)
 expect(bind_current_machine_delivery(actor,{unit_number:2,acceptance_key:'other'}).ok).toBe(false)
 expect(bind_current_machine_delivery(actor,{unit_number:2})).toMatchObject({ok:true,acceptance_key:spec.acceptance_key,unit_number:2})
 expect(arm_machine_delivery(actor,{...spec,minimum:1}).ok).toBe(false)
 identity.epoch++;expect(bind_current_machine_delivery(actor,{unit_number:2}).ok).toBe(false)
})

it('excludes the hidden vision vehicle from the complete world stock census', () => {
  entity(99, 'container', 7)
  entities.push({ valid: true, name: 'sgluna-npc-vision', get_max_inventory_index: () => { throw new Error('hidden vehicle is not world stock') } })
  expect(arm_machine_delivery(actor, spec)).toMatchObject({ ok: true, baseline_stock: 7 })
})
