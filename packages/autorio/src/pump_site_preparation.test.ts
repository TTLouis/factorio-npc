import { beforeEach, expect, it, vi } from 'vitest'
import { cleanup_pump_preparation, get_pump_site_preparation, pump_site_preflight, tick_pump_preparation } from './pump_site_preparation'
import { TaskStates } from './types'
import { get_recent_fluid_source_observation } from './fluid_source_observation'
import { new_task_manager } from './task_manager'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).pairs = Object.entries
  ;(globalThis as any).log = vi.fn()
})

function fixture() {
  let actorId = 12
  const covered = { mineable_properties: { minable: true, mining_time: 0.5, products: [{ name: 'landfill', type: 'item', amount: 1 }] } }
  const water = { fluid: { name: 'water' }, mineable_properties: { minable: false } }
  const ground = { mineable_properties: { minable: false } }
  const prototype = { type: 'offshore-pump', tile_width: 1, tile_height: 1, tile_buildability_rules: [
    { area: { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } }, required_tiles: { layers: { ground_tile: true } } },
    { area: { left_top: { x: -1, y: -2 }, right_bottom: { x: 1, y: -1 } }, required_tiles: { layers: { water_tile: true } } },
  ] }
  ;(globalThis as any).prototypes = { entity: { 'offshore-pump': prototype }, tile: { landfill: covered, water, 'grass-1': ground }, item: { landfill: { stack_size: 100 } } }
  const proxies: any[] = []
  const tiles = new Map<string, any>()
  let protectedEntity: any
  let full = false
  let held = 0
  const inventory = { can_insert: () => !full, count_empty_stacks: () => full ? 0 : 3, get_item_count: () => held }
  const surface: any = { index: 1, is_chunk_generated: () => true, find_entities_filtered: (args: any) => {
    if (args.type) return proxies.filter(p => p.valid)
    return protectedEntity ? [protectedEntity] : []
  } }
  surface.get_tile = (p: any) => {
    const key = `${p.x},${p.y}`
    if (!tiles.has(key)) {
      const isCover = p.y < 0
      const tile: any = { position: p, name: isCover ? 'landfill' : 'grass-1', hidden_tile: isCover ? 'water' : undefined,
        prototype: isCover ? covered : ground, collides_with: () => true, to_be_deconstructed: () => proxies.some(proxy => proxy.valid && proxy.position.x===p.x+0.5 && proxy.position.y===p.y+0.5) }
      tile.order_deconstruction = () => {
        const proxy: any = { valid: true, position: { x:p.x+0.5, y:p.y+0.5 }, surface:{index:1}, force: { index: 1 }, type: 'deconstructible-tile-proxy',
          destroy: vi.fn(() => { proxy.valid=false }), mine: vi.fn(() => { proxy.valid=false; tile.name='water'; tile.hidden_tile=undefined; tile.prototype=water; held++; return true }) }
        proxies.push(proxy); return proxy
      }
      tiles.set(key,tile)
    }
    return tiles.get(key)
  }
  const actor: any = { is_valid: true, force: { index: 1, manual_mining_speed_modifier: 0 }, surface,
    position: { x: 0.5, y: 2.5 }, status_snapshot: () => ({actor_id:actorId,kind:'standalone_character'}),
    set_walking_state:vi.fn(),set_mining_state:vi.fn(),
    get_main_inventory: () => inventory, character: { reach_distance: 10, prototype: { mining_speed: 0.5 }, character_mining_speed_modifier: 0,
      bounding_box: { left_top: { x:0.2,y:2.2 },right_bottom:{x:0.8,y:2.8} } } }
  const observe = () => { (globalThis as any).storage.sgluna_recent_fluid_reads = [{ actor_id: actorId, force_index: 1, observation: {
    ok:true,fluid_name:'water',surface_index:1,observed_tick:100,covered_fluid_hints:[{position:{x:0,y:-1}}] } }] }
  const blueprint = { set_stack: vi.fn(), set_blueprint_entities: vi.fn(), build_blueprint: vi.fn(() => []) }
  ;(globalThis as any).game.create_inventory = vi.fn(() => ({ 0: blueprint, destroy: vi.fn() }))
  ;(globalThis as any).defines.build_mode = { superforced: 3 }
  return { actor, surface, tiles, proxies, inventory, observe, blueprint, held: () => held,
    protect: () => { protectedEntity = { valid:true, name:'wooden-chest' } }, full: () => {full=true}, replace: () => {actorId++},
    plan: () => get_pump_site_preparation(actor,{x:0.5,y:0.5}) as any }
}

it('requires water first and makes terrain proposals without any native mutation', () => {
  const f=fixture()
  expect(f.plan()).toMatchObject({ok:false,code:'water_search_required'})
  f.observe(); const p=f.plan()
  expect(p).toMatchObject({ok:true,placement_authority:false,execution_strategy:'actor',direction:0})
  expect(p.removal_tiles).toHaveLength(6)
  expect(f.blueprint.build_blueprint).not.toHaveBeenCalled()
  expect(f.proxies).toHaveLength(0)
})
it.each(['actor','surface','force','expiry','rewind','world','structure','footing','inventory','reach'] as const)('fails closed for %s changed before mutation', change => {
  const f=fixture(); f.observe(); const p=f.plan()
  if(change==='actor')f.replace()
  if(change==='surface')f.actor.surface.index=2
  if(change==='force')f.actor.force.index=2
  if(change==='expiry')(globalThis as any).game.tick=3701
  if(change==='rewind')(globalThis as any).game.tick=99
  if(change==='world')f.surface.get_tile({x:0,y:-1}).name='grass-1'
  if(change==='structure')f.protect()
  if(change==='footing')f.actor.character.bounding_box={left_top:{x:0.1,y:-0.9},right_bottom:{x:0.9,y:-0.1}}
  if(change==='inventory')f.full()
  if(change==='reach')f.actor.character.reach_distance=1
  expect(pump_site_preflight(f.actor,p.preparation_id).ok).toBe(false)
  expect(f.proxies).toHaveLength(0)
  expect(f.blueprint.build_blueprint).not.toHaveBeenCalled()
})
it.each(['foundation','paving','layered'] as const)('does not authorize unproven %s cover demolition', kind => {
  const f=fixture(); f.observe()
  const tile=f.surface.get_tile({x:0,y:-1})
  if(kind==='foundation')tile.name='foundation'
  if(kind==='paving')tile.name='concrete'
  if(kind==='layered') { tile.hidden_tile='landfill'; tile.double_hidden_tile='water' }
  expect(f.plan()).toMatchObject({ok:false,code:'pump_site_cover_not_supported'})
  expect(f.proxies).toHaveLength(0)
})
it('waits the native hand duration, natively reclaims each tile, and leaves no owned marks', () => {
  const f=fixture(); f.observe(); const p=f.plan()
  const task: any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,operation_id:6,owner_force_index:1,owner_surface_index:1}
  const saved=(globalThis as any).storage
  saved.sgluna_placement_candidate_sets={
    own:{actor_id:12,force_index:1,surface_index:1,entity_name:'offshore-pump'},
    otherActor:{actor_id:13,force_index:1,surface_index:1,entity_name:'offshore-pump'},
    ordinary:{actor_id:12,force_index:1,surface_index:1,entity_name:'stone-furnace'},
  }
  saved.sgluna_placement_candidate_set_order=['own','otherActor','ordinary']
  expect(tick_pump_preparation(f.actor,task).state).toBe('pending')
  expect(f.held()).toBe(0)
  ;(globalThis as any).game.tick=159
  expect(tick_pump_preparation(f.actor,task).state).toBe('pending')
  expect(f.held()).toBe(0)
  ;(globalThis as any).game.tick=160
  expect(tick_pump_preparation(f.actor,task).state).toBe('pending')
  expect(f.held()).toBe(1)
  expect(get_recent_fluid_source_observation(f.actor,'water')).toBeUndefined()
  expect(saved.sgluna_placement_candidate_sets.own).toBeUndefined()
  expect(saved.sgluna_placement_candidate_sets.otherActor).toBeDefined()
  expect(saved.sgluna_placement_candidate_sets.ordinary).toBeDefined()
  for(let index=0;index<12;index++) { (globalThis as any).game.tick+=61; if(tick_pump_preparation(f.actor,task).state==='complete')break }
  expect(f.held()).toBe(6)
  expect(task.reclaimed_items).toEqual({landfill:6})
  expect(f.proxies.every(proxy=>!proxy.valid)).toBe(true)
  expect(pump_site_preflight(f.actor,p.preparation_id)).toMatchObject({ok:false,code:'pump_preparation_world_changed'})
  expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('pump_site.cover_removed preparation_id='))
})
it('cancels only owned staging proxies and cannot remove cover after cancellation', () => {
  const f=fixture(); f.observe(); const p=f.plan()
  const task:any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,owner_force_index:1,owner_surface_index:1}
  tick_pump_preparation(f.actor,task)
  const foreign={valid:true,destroy:vi.fn()}
  cleanup_pump_preparation(task)
  expect(foreign.destroy).not.toHaveBeenCalled()
  expect(f.held()).toBe(0)
  expect(f.proxies.every(proxy=>!proxy.valid)).toBe(true)
})
it('does not report success if terrain changes between final removal and completion', () => {
  const f=fixture(); f.observe(); const p=f.plan()
  const task:any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,owner_force_index:1,owner_surface_index:1}
  tick_pump_preparation(f.actor,task)
  while((task.tile_index??0)<6) { (globalThis as any).game.tick+=61; tick_pump_preparation(f.actor,task) }
  f.surface.get_tile({x:0,y:-1}).name='landfill'
  expect(tick_pump_preparation(f.actor,task)).toEqual({state:'failed',reason:'pump_preparation_world_changed'})
})
it('preserves partial real effects when a new obstruction stops subsequent tiles', () => {
  const f=fixture(); f.observe(); const p=f.plan()
  const task:any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,owner_force_index:1,owner_surface_index:1}
  tick_pump_preparation(f.actor,task)
  ;(globalThis as any).game.tick+=61
  tick_pump_preparation(f.actor,task)
  f.protect()
  expect(tick_pump_preparation(f.actor,task)).toEqual({state:'failed',reason:'pump_site_protected_entity'})
  expect(task.removed_layers).toBe(1)
  expect(task.reclaimed_items).toEqual({landfill:1})
  expect(pump_site_preflight(f.actor,p.preparation_id)).toMatchObject({ok:false,code:'pump_preparation_world_changed'})
})
it('rejects pre-existing marks and never destroys a proxy whose ownership changed', () => {
  const f=fixture(); f.observe(); const p=f.plan()
  const prior=f.surface.get_tile({x:0,y:-1}).order_deconstruction()
  expect(pump_site_preflight(f.actor,p.preparation_id)).toMatchObject({ok:false,code:'pump_site_existing_deconstruction'})
  expect(prior.destroy).not.toHaveBeenCalled()
  prior.destroy()
  const task:any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,owner_force_index:1,owner_surface_index:1}
  tick_pump_preparation(f.actor,task)
  const proxy=f.surface.get_tile({x:0,y:-1}).order_deconstruction()
  task.owned_proxies.push(proxy)
  proxy.force.index=2
  cleanup_pump_preparation(task)
  expect(proxy.destroy).not.toHaveBeenCalled()
})
it.each(['startup','actor-loss'] as const)('cleans serialized owned marks without resolving an actor on %s', lifecycle => {
  const f=fixture(); f.observe(); const p=f.plan()
  const manager=new_task_manager(()=>f.actor)
  const proxy=f.surface.get_tile({x:0,y:-1}).order_deconstruction()
  const foreign=f.surface.get_tile({x:1,y:-1}).order_deconstruction()
  foreign.force.index=2
  const task:any={type:TaskStates.PREPARING_PUMP_SITE,preparation_id:p.preparation_id,owner_force_index:1,owner_surface_index:1,owned_proxies:[proxy,foreign]}
  manager.add_task(task)
  if(lifecycle==='startup')manager.reconcile_startup('pump-restart-test')
  else manager.discard_all_tasks_after_actor_loss()
  expect(proxy.destroy).toHaveBeenCalledOnce()
  expect(foreign.destroy).not.toHaveBeenCalled()
  expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  expect(f.held()).toBe(0)
  if(lifecycle==='startup') expect(pump_site_preflight(f.actor,p.preparation_id)).toMatchObject({ok:false,code:'pump_preparation_unavailable'})
})
