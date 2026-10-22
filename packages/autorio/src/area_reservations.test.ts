import { beforeEach, expect, it, vi } from 'vitest'
import { designer_input, designer_returned, player_area_action, reservation_intersection, reservation_status, reserve_area, restore_area, RESERVED_TILE, validate_area_reservation } from './area_reservations'
import { register_area_reservations } from './area_reservation_ui'

// Contract/fault tests; native cloning fidelity is proved by the Factorio lane.
function fixture() {
  const force: any = { index: 1, is_chunk_visible: () => true, add_chart_tag: () => ({ valid: true, destroy: vi.fn() }) }
  const makeSurface = (name: string): any => {
    const tiles = new Map<string, any>()
    const surface: any = { name, valid: true, index: name === 'world' ? 1 : 2, map_gen_settings: {}, entities: [],
      get_tile: (a: any, b?: number) => { const p = typeof a === 'number' ? { x: a, y: b } : a; return tiles.get(`${p.x},${p.y}`) ?? { name: 'grass-1', position: p, hidden_tile: 'landfill', double_hidden_tile: 'water' } },
      set_tiles: (values: any[]) => { for (const v of values) tiles.set(`${v.position.x},${v.position.y}`, { ...surface.get_tile(v.position), ...v }) },
      set_hidden_tile: (p: any, name: string) => { const tile = surface.get_tile(p); tiles.set(`${p.x},${p.y}`, { ...tile, hidden_tile: name }) },
      set_double_hidden_tile: (p: any, name: string) => { const tile = surface.get_tile(p); tiles.set(`${p.x},${p.y}`, { ...tile, double_hidden_tile: name }) },
      find_entities_filtered: () => surface.entities.filter((e: any) => e.valid), count_entities_filtered: () => 0 }
    return surface
  }
  let serial = 100
  const makeEntity = (surface: any, name = 'tree-01', type = 'tree'): any => {
    const entity: any = { name, type, surface, valid: true, position: { x: 3.5, y: 3.5 }, bounding_box: { left_top: { x: 3, y: 3 }, right_bottom: { x: 4, y: 4 } },
      quality: { name: 'normal' }, force, direction: 0, health: 50, active: true, unit_number: ++serial,
      get_wire_connectors: () => ({}), get_max_inventory_index: () => 0,
      get_control_behavior: () => undefined,
      destroy: () => { entity.valid = false; return true },
      clone: ({ surface: target }: any) => makeEntity(target, name, type) }
    surface.entities.push(entity); return entity
  }
  const surface = makeSurface('world'); const entity = makeEntity(surface)
  const actor: any = { is_valid: true, character: {}, surface, force, position: { x: 0, y: 0 }, status_snapshot: () => ({ actor_id: 42 }) }
  const player: any = { valid: true, force, index: 1, controller_type: 'character', add_to_clipboard: vi.fn() }
  Object.assign(game, { tick: 100, create_surface: vi.fn(makeSurface), delete_surface: vi.fn(), get_player: () => player,
    create_inventory: () => ({ valid: true, destroy: vi.fn(), 0: { set_stack: vi.fn(), set_blueprint_tiles: vi.fn() } }) })
  Object.assign(rendering, { draw_rectangle: () => ({ valid: true, destroy: vi.fn() }) })
  ;(defines as any).controllers = { spectator: 'spectator' }
  const request = { goal_id: 'goal-1', plan_id: 'plan-1', x: 2, y: 2, width: 4, height: 4 }
  const propose = () => { const result = validate_area_reservation(actor, request); expect(result.ok).toBe(true); return (result as any).reservation_id }
  return { actor, surface, entity, player, propose, request, makeEntity }
}
beforeEach(() => { (globalThis as any).storage = {} })

it('auto mode backs up before cutting and restores exact tile layers and native identity mapping on design return', () => {
  const w = fixture(); const id = w.propose()
  expect(reservation_status().mode).toBe('auto')
  expect(reserve_area(w.actor, id, 1).ok).toBe(true)
  expect(w.entity.valid).toBe(false)
  expect(w.surface.get_tile(2, 2).name).toBe(RESERVED_TILE)
  expect(designer_input(id, 1).ok).toBe(true)
  expect(designer_returned(id, 2, 'stale').ok).toBe(false)
  expect(designer_returned(id, 1, 'design-1').ok).toBe(true)
  expect(w.surface.get_tile(2, 2)).toMatchObject({ name: 'grass-1', hidden_tile: 'landfill', double_hidden_tile: 'water' })
  expect(reservation_status(id).reservations[0].identity_map?.[0]).toMatchObject({ before: w.entity.unit_number })
  expect(designer_returned(id, 1, 'duplicate').ok).toBe(false)
})
it('review mode has a blueprint and pin but does not cut or block the world before actual approval', () => {
  const w = fixture(); expect(player_area_action(1, 'review').ok).toBe(true)
  const id = w.propose(); expect(reserve_area(w.actor, id, 1).ok).toBe(true)
  expect(w.entity.valid).toBe(true); expect(w.surface.get_tile(2, 2).name).toBe('grass-1')
  expect(reservation_intersection(w.surface, { left_top: { x: 2, y: 2 }, right_bottom: { x: 6, y: 6 } })).toBeUndefined()
  expect(game.create_surface).not.toHaveBeenCalled(); expect(designer_input(id, 1).ok).toBe(false)
  expect(player_area_action(1, 'approve', id, 1).ok).toBe(false)
  expect(player_area_action(1, 'approve', id, 2, w.actor).ok).toBe(false)
  expect(player_area_action(1, 'approve', id, 1, w.actor).ok).toBe(true)
  expect(designer_input(id, 1).ok).toBe(true)
})
it('review snapshot changes and cross-force approval are rejected without a cut', () => {
  const w = fixture(); player_area_action(1, 'review'); const id = w.propose(); reserve_area(w.actor, id, 1)
  w.player.force = { index: 2 }; expect(player_area_action(1, 'approve', id, 1, w.actor).ok).toBe(false)
  w.player.force = w.actor.force; w.entity.health = 49
  expect(player_area_action(1, 'approve', id, 1, w.actor).ok).toBe(false)
  expect(w.entity.valid).toBe(true); expect(game.create_surface).not.toHaveBeenCalled()
})
it('unsupported entities, crossed footprints and overlaps are refused before world mutation', () => {
  const w = fixture(); w.entity.type = 'car'; expect(validate_area_reservation(w.actor, w.request).ok).toBe(false)
  w.entity.type = 'tree'; w.entity.bounding_box.right_bottom.x = 7; expect(validate_area_reservation(w.actor, w.request).ok).toBe(false)
  w.entity.bounding_box.right_bottom.x = 4; const id = w.propose()
  expect(validate_area_reservation(w.actor, w.request).ok).toBe(false)
  expect(reservation_status(id).reservations[0].state).toBe('validated')
  expect(w.entity.valid).toBe(true)
})
it('failed backup validation leaves original entities and terrain intact and retires its vault', () => {
  const w = fixture(); const id = w.propose(); w.entity.clone = () => undefined
  expect(reserve_area(w.actor, id, 1).ok).toBe(false)
  expect(w.entity.valid).toBe(true); expect(w.surface.get_tile(2, 2).name).toBe('grass-1')
  expect(game.delete_surface).toHaveBeenCalled()
})
it('restoration preserves an intervening entity and retains the backup until the conflict is removed', () => {
  const w = fixture(); const id = w.propose(); reserve_area(w.actor, id, 1)
  const intruder = w.makeEntity(w.surface, 'car', 'car')
  expect(restore_area(id, 1, 'reverse').ok).toBe(false)
  expect(intruder.valid).toBe(true); expect(game.delete_surface).not.toHaveBeenCalled()
  intruder.destroy(); expect(restore_area(id, 1, 'reverse').ok).toBe(true)
  expect(restore_area(id, 1, 'repeat').ok).toBe(true)
})
it('a later restore clone hook changing an earlier entity retains the vault instead of sealing corrupted state', () => {
  const w = fixture(); w.makeEntity(w.surface, 'big-rock', 'simple-entity')
  const id = w.propose(); reserve_area(w.actor, id, 1)
  const vault = (game.create_surface as any).mock.results[0].value
  const originalClone = vault.entities[1].clone
  vault.entities[1].clone = (args: any) => { const clone = originalClone(args); w.surface.entities.find((entity: any) => entity.valid).health = 1; return clone }
  expect(restore_area(id, 1, 'reverse').ok).toBe(false)
  expect(game.delete_surface).not.toHaveBeenCalled()
})
it('changed clone flags are detected before cutting and unknown prototypes or control behaviors are ineligible', () => {
  const w = fixture(); const id = w.propose(); const clone = w.entity.clone
  w.entity.clone = (args: any) => { const out = clone(args); out.destructible = false; return out }
  expect(reserve_area(w.actor, id, 1).ok).toBe(false); expect(w.entity.valid).toBe(true)
  w.entity.name = 'modded-tree'; expect(validate_area_reservation(w.actor, w.request).ok).toBe(false)
  w.entity.name = 'tree-01'; w.entity.get_control_behavior = () => ({})
  expect(validate_area_reservation(w.actor, w.request).ok).toBe(false)
})
it('expired or changed validation releases its site and capacity without any player action', () => {
  const w = fixture(); const first = w.propose(); (game as any).tick += 3601
  const second = w.propose(); expect(second).not.toBe(first)
  expect(reservation_status(first).reservations[0].state).toBe('rejected')
  w.entity.health = 48; const third = w.propose(); expect(third).not.toBe(second)
  expect(reservation_status(second).reservations[0].state).toBe('rejected')
  expect(game.create_surface).not.toHaveBeenCalled()
})
it('an unsupported stack added after validation retires the proposal without wedging later validation', () => {
  const w = fixture(); w.entity.name = 'wooden-chest'; w.entity.type = 'container'
  const first = w.propose()
  w.entity.get_max_inventory_index = () => 1
  w.entity.get_inventory = () => ({ length: 1, 0: { valid_for_read: true, type: 'armor', spoil_tick: 0 }, supports_filters: () => false, supports_bar: () => false })
  expect(() => validate_area_reservation(w.actor, w.request)).not.toThrow()
  expect(reservation_status(first).reservations[0].state).toBe('rejected')
  w.entity.get_max_inventory_index = () => 0
  expect(w.propose()).not.toBe(first)
  expect(w.entity.valid).toBe(true); expect(game.create_surface).not.toHaveBeenCalled()
})
it('failed review blueprint creation releases the proposal and destroys its temporary inventory without cutting', () => {
  const w = fixture(); player_area_action(1, 'review'); const id = w.propose()
  const inventory: any = { valid: true, destroy: vi.fn(), 0: { set_stack: vi.fn(), set_blueprint_tiles: () => { throw new Error('native marker failure') } } }
  ;(game as any).create_inventory = () => inventory
  expect(reserve_area(w.actor, id, 1)).toMatchObject({ ok: false, code: 'reservation_marker_creation_failed' })
  expect(reservation_status(id).reservations[0].state).toBe('rejected')
  expect(inventory.destroy).toHaveBeenCalled(); expect(w.entity.valid).toBe(true)
  expect(game.create_surface).not.toHaveBeenCalled()
})
it('native event defenses remove empty ghosts, preserve real intruders and refund paving with its original quality', () => {
  const w = fixture(); const id = w.propose(); reserve_area(w.actor, id, 1)
  const events = new Map<number, any>()
  const register = vi.spyOn(script, 'on_event').mockImplementation(((event: number, handler: any) => events.set(event, handler)) as any)
  const eventIds: any = defines.events
  const previous = { built: eventIds.on_built_entity, tiles: eventIds.on_player_built_tile }
  eventIds.on_built_entity = 901; eventIds.on_player_built_tile = 902
  try {
    register_area_reservations(() => w.actor, () => true)
    const ghost = w.makeEntity(w.surface, 'entity-ghost', 'entity-ghost'); events.get(901)({ entity: ghost }); expect(ghost.valid).toBe(false)
    const real = w.makeEntity(w.surface, 'wooden-chest', 'container'); events.get(901)({ entity: real }); expect(real.valid).toBe(true)
    expect(reservation_status(id).reservations[0]).toMatchObject({ state: 'conflict', reason: 'unexpected_native_build_preserved' })
    Object.assign(game, { get_surface: () => w.surface }); w.surface.spill_item_stack = vi.fn()
    w.surface.set_tiles([{ name: 'landfill', position: { x: 2, y: 2 } }])
    const insert = vi.fn(() => 0)
    events.get(902)({ surface_index: 1, player_index: 1, item: { name: 'landfill' }, quality: { name: 'rare' }, inventory: { valid: true, insert }, tiles: [{ position: { x: 2, y: 2 } }] })
    expect(w.surface.get_tile(2, 2).name).toBe(RESERVED_TILE)
    expect(insert).toHaveBeenCalledWith({ name: 'landfill', quality: 'rare', count: 1 })
    expect(w.surface.spill_item_stack).toHaveBeenCalledWith(expect.objectContaining({ stack: { name: 'landfill', quality: 'rare', count: 1 } }))
  }
  finally { register.mockRestore(); eventIds.on_built_entity = previous.built; eventIds.on_player_built_tile = previous.tiles }
})
it('designer pages preserve the whole immutable snapshot without truncating JSON or exposing it before reservation', () => {
  const w = fixture(); const id = w.propose()
  expect(designer_input(id, 1).ok).toBe(false); reserve_area(w.actor, id, 1)
  const first: any = designer_input(id, 1)
  expect(first.total_entries).toBe(17); expect(first.entries).toHaveLength(16); expect(first.next_offset).toBe(16)
  const last: any = designer_input(id, 1, first.next_offset)
  expect(last.entries).toHaveLength(1); expect(last.entries[0].kind).toBe('entity'); expect(last.next_offset).toBeUndefined()
  expect(designer_input(id, 1, -1).ok).toBe(false); expect(designer_input(id, 1, 18).ok).toBe(false)
})
