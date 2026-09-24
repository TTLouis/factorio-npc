import type { ControlledActor } from './actors/types'
import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { remember_entity_reference } from './entity_reference'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function inventory(initial: Record<string, number> = {}) {
  const counts = { ...initial }
  const api = {
    counts,
    find_item_stack: vi.fn((name: string) => {
      const count = counts[name] ?? 0
      return count > 0 ? [{ name, count }, 1] : [undefined, undefined]
    }),
    get_item_count: vi.fn((name: string) => counts[name] ?? 0),
    can_insert: vi.fn(() => true),
    insert: vi.fn(({ name, count }: { name: string, count: number }) => {
      counts[name] = (counts[name] ?? 0) + count
      return count
    }),
    remove: vi.fn(({ name, count }: { name: string, count: number }) => {
      const available = counts[name] ?? 0
      const removed = Math.min(available, count)
      counts[name] = available - removed
      return removed
    }),
  }
  return api as unknown as LuaInventory & { counts: Record<string, number> }
}

function entity(unit_number: number, targetInventory: LuaInventory, overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { x: 2, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
    get_max_inventory_index: vi.fn(() => 1),
    get_inventory: vi.fn(() => targetInventory),
    ...overrides,
  } as unknown as LuaEntity
}

function context() {
  const actorInventory = inventory({ 'firearm-magazine': 20 })
  const findEntities = vi.fn(() => [])
  const surface = {
    index: 1,
    find_entities_filtered: findEntities,
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    force: { index: 1 },
    position: { x: 0, y: 0 },
    surface,
    get_main_inventory: vi.fn(() => actorInventory),
    status_snapshot: vi.fn(() => ({
      actor_id: 18,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'Nova-1',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_basic_operation_controller(resolve, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  return { actor, actorInventory, findEntities, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
})

describe('exact entity item transfers', () => {
  it('loads only the requested unit number and never scans same-name neighbors', () => {
    const c = context()
    const selectedInventory = inventory()
    const distractorInventory = inventory()
    const selected = entity(101, selectedInventory)
    const distractor = entity(202, distractorInventory)
    c.findEntities.mockReturnValue([distractor] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn((unit: number) => unit === 101 ? selected : distractor)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 7, true)).toEqual([true, 'Task started'])
    expect(c.runtime.state_moving_items(c.actor)).toBe(7)

    expect(selectedInventory.counts['firearm-magazine']).toBe(7)
    expect(distractorInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['firearm-magazine']).toBe(13)
    expect(c.findEntities).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      moved_count: 7,
      target_unit_number: 101,
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('uses the actor current reach instead of a hard-coded eight-tile transfer limit', () => {
    const c = context()
    ;(c.actor.character as any).reach_distance = 10
    const selectedInventory = inventory()
    const selected = entity(101, selectedInventory, { position: { x: 9, y: 0 } })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => selected)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 5, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(5)

    expect(selectedInventory.counts['firearm-magazine']).toBe(5)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      moved_count: 5,
      target_unit_number: 101,
    })
  })

  it('fails closed when the observed unit is gone and only a replacement remains at the hint location', () => {
    const c = context()
    const selectedInventory = inventory()
    const distractorInventory = inventory()
    const selected = entity(101, selectedInventory)
    const replacement = entity(202, distractorInventory, { position: selected.position })
    remember_entity_reference(selected)
    c.findEntities.mockReturnValue([replacement] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 7, true)).toEqual([true, 'Task started'])
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)

    expect(c.findEntities).toHaveBeenCalled()
    expect(selectedInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(distractorInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'target_gone',
      completed: false,
      target_unit_number: 101,
    })
  })

  it.each([
    ['target_gone', undefined],
    ['different_surface', entity(101, inventory(), { surface: { index: 2 } })],
    ['wrong_force', entity(101, inventory(), { force: { index: 2 } })],
    ['too_far', entity(101, inventory(), { position: { x: 9, y: 0 } })],
  ])('fails closed with %s and never falls back to another entity', (expectedCode, selected) => {
    const c = context()
    const fallbackInventory = inventory()
    const fallback = entity(202, fallbackInventory)
    c.findEntities.mockReturnValue([fallback] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => selected)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 5, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)

    expect(c.controller.status().last_result).toMatchObject({
      code: expectedCode,
      accepted: false,
      target_unit_number: 101,
    })
    expect(fallbackInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['firearm-magazine']).toBe(20)
    expect(c.findEntities).not.toHaveBeenCalled()
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('moves more than one stack when the NPC holds several stacks of the item', () => {
    const c = context()
    c.actorInventory.counts['iron-plate'] = 250
    // A real find_item_stack returns one stack (100 plates); the transfer must
    // not be capped by it.
    ;(c.actorInventory.find_item_stack as any).mockImplementation((name: string) =>
      (c.actorInventory.counts[name] ?? 0) > 0 ? [{ name, count: Math.min(100, c.actorInventory.counts[name]) }, 1] : [undefined, undefined])
    const targetInventory = inventory()
    const target = entity(101, targetInventory, { name: 'wooden-chest', type: 'container' })
    remember_entity_reference(target)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    expect(c.controller.submit_move_exact('iron-plate', 101, 200, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(200)

    expect(targetInventory.counts['iron-plate']).toBe(200)
    expect(c.actorInventory.counts['iron-plate']).toBe(50)
    expect(c.controller.status().last_result).toMatchObject({ code: 'completed', moved_count: 200 })
  })
})
