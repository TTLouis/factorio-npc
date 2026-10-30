import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { get_controlled_actor } from './actors/actor_controller'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'

// This fixture mocks engine globals, but enters through the shipped native
// remote and runs the real queued placement implementation. It specifically
// covers a blocker arriving AFTER submission, not only preflight.
const interfaces: Record<string, any> = {}
let control: typeof import('./control')
const FURNACE = {
  name: 'stone-furnace', type: 'furnace', tile_width: 2, tile_height: 2,
  collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
}

beforeAll(async () => {
  ;(globalThis as any).remote.add_interface = (name: string, value: any) => { interfaces[name] = value }
  control = await import('./control')
})

describe('external placement safety through native remote', () => {
  const originalEntities = (globalThis as any).prototypes.entity
  const originalItems = (globalThis as any).prototypes.item
  let inventory: any
  let surface: any
  const blockers: any[] = []

  beforeEach(() => {
    ;(globalThis as any).storage = { sgluna_actor_mode: 'player' }
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': FURNACE }
    ;(globalThis as any).prototypes.item = { 'stone-furnace': {} }
    blockers.length = 0
    inventory = { get_item_count: () => 1, insert: vi.fn(), remove: vi.fn() }
    surface = { index: 1, can_place_entity: vi.fn(() => blockers.length === 0),
      find_entities_filtered: vi.fn(() => blockers), create_entity: vi.fn() }
    ;(globalThis as any).game.connected_players = [{ valid: true, index: 1, name: 'fixture', connected: true,
      character: { valid: true, build_distance: 10 }, position: { x: 0, y: 0 }, surface,
      force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      walking_state: { walking: false }, mining_state: { mining: false }, crafting_queue: [],
      get_main_inventory: () => inventory }]
    control.task_manager.cancel_all_tasks()
  })

  afterEach(() => {
    control.task_manager.cancel_all_tasks()
    ;(globalThis as any).prototypes.entity = originalEntities
    ;(globalThis as any).prototypes.item = originalItems
    ;(globalThis as any).game.connected_players = []
  })

  it('preserves existing four-argument autonomous behavior', () => {
    expect(interfaces.autorio_operations.place_entity('stone-furnace', 2, 0, 0)).toBe(true)
    expect(control.task_manager.player_state.parameters_place_entity?.refuse_clearance).toBeUndefined()
  })

  it('advertises and retains the forced safety option in the queued task', () => {
    expect(interfaces.autorio_operations.status().placement_no_clear_supported).toBe(true)
    expect(interfaces.autorio_operations.place_entity('stone-furnace', 2, 0, 0, true)).toBe(true)
    expect(control.task_manager.player_state.parameters_place_entity?.refuse_clearance).toBe(true)
  })

  for (const type of ['tree', 'item-entity']) {
    it(`does not clear a late ${type} or consume stock after queue admission`, () => {
      expect(interfaces.autorio_operations.place_entity('stone-furnace', 2, 0, 0, true)).toBe(true)
      const blocker = { valid: true, name: 'late-blocker', type, position: { x: 2, y: 0 }, mine: vi.fn(), destroy: vi.fn() }
      blockers.push(blocker)
      const actor = get_controlled_actor()!
      const basic = new_basic_operation_controller(() => actor, control.task_manager)
      const runtime = new_basic_operation_runtime(control.task_manager, basic)
      expect(runtime.state_placing(actor)?.[0]).toBe(false)
      expect(basic.status().last_result).toMatchObject({ completed: false, code: 'construction_plan_blocked_no_clear' })
      expect(blocker.mine).not.toHaveBeenCalled()
      expect(blocker.destroy).not.toHaveBeenCalled()
      expect(inventory.insert).not.toHaveBeenCalled()
      expect(inventory.remove).not.toHaveBeenCalled()
      expect(surface.create_entity).not.toHaveBeenCalled()
      expect(control.task_manager.get_status_snapshot().last_cancelled_batch).toMatchObject({ failed_before_mutation: true })
    })
  }
})
