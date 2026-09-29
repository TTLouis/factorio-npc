import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { crafted_item_count } from './crafted_items'
import { new_crafting_controller } from './crafting'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function make_context() {
  const inventory_counts: Record<string, number> = { 'iron-gear-wheel': 0, 'iron-plate': 100 }
  let queue: Array<{ index: number, recipe: string, count: number, prerequisite: boolean }> = []
  let actor_id = 1
  let begin_count: number | undefined

  const actor = {
    is_valid: true,
    character: { valid: true },
    surface: {},
    force: {
      index: 1,
      recipes: {
        'iron-gear-wheel': { enabled: true },
      },
    },
    position: { x: 0, y: 0 },
    get_main_inventory: vi.fn(() => ({
      get_item_count: (name: string) => inventory_counts[name] ?? 0,
    })),
    update_selected_entity: vi.fn(),
    get_mining_state: vi.fn(() => ({ mining: false })),
    set_mining_state: vi.fn(),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_craftable_count: vi.fn(() => 100),
    begin_crafting: vi.fn(({ count, recipe }: { count: number, recipe: string }) => {
      const started = begin_count ?? count
      if (started > 0) {
        queue = [{ index: 1, recipe, count: started, prerequisite: false }]
      }
      return started
    }),
    cancel_crafting: vi.fn(({ index, count }: { index: number, count: number }) => {
      const item = queue.find(candidate => candidate.index === index)
      if (!item) return
      item.count -= count
      if (item.count <= 0) {
        queue = queue.filter(candidate => candidate !== item)
      }
      queue = queue.map((candidate, i) => ({ ...candidate, index: i + 1 }))
    }),
    get_crafting_queue: vi.fn(() => queue.map(item => ({ ...item }))),
    get_crafting_queue_count: vi.fn((recipe: string) => queue
      .filter(item => item.recipe === recipe)
      .reduce((sum, item) => sum + item.count, 0)),
    owns_player_index: vi.fn(() => false),
    entity_build_args: vi.fn(() => ({ force: { index: 1 } })),
    status_snapshot: vi.fn(() => ({
      actor_id,
      kind: 'standalone_character',
      valid: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
      has_character: true,
    })),
  } as unknown as ControlledActor

  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_crafting_controller(resolve, manager)

  return {
    actor,
    manager,
    controller,
    inventory_counts,
    get queue() { return queue },
    set queue(value) { queue = value },
    set actor_id(value: number) { actor_id = value },
    set begin_count(value: number | undefined) { begin_count = value },
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('bounded crafting controller', () => {
  it('rejects invalid counts without queueing Autorio work', () => {
    const { controller, manager } = make_context()

    expect(controller.submit('iron-gear-wheel', 0)[0]).toBe(false)
    expect(controller.submit('iron-gear-wheel', 1001)[0]).toBe(false)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
    expect(controller.status().last_result?.code).toBe('invalid_count')
  })

  it('preserves a pre-existing native crafting queue by refusing to merge ownership', () => {
    const context = make_context()
    context.queue = [{ index: 1, recipe: 'transport-belt', count: 5, prerequisite: false }]

    const result = context.controller.submit('iron-gear-wheel', 2)

    expect(result[0]).toBe(false)
    expect(context.controller.status().last_result?.code).toBe('native_queue_busy')
    expect(context.actor.cancel_crafting).not.toHaveBeenCalled()
    expect(context.queue).toEqual([{ index: 1, recipe: 'transport-belt', count: 5, prerequisite: false }])
  })

  it('starts from an empty native queue and binds the exact actor identity', () => {
    const { actor, controller, manager } = make_context()

    expect(controller.submit('iron-gear-wheel', 2)[0]).toBe(true)
    controller.tick(actor)

    expect(actor.begin_crafting).toHaveBeenCalledWith({ count: 2, recipe: 'iron-gear-wheel' })
    expect(manager.player_state.parameters_craft_item).toMatchObject({
      owner_actor_id: 1,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      started: 2,
      owns_native_queue: true,
      output_count_before: 0,
    })
    expect(controller.status().last_result?.code).toBe('started')
  })

  it('requires real output after the owned native queue drains', () => {
    const context = make_context()
    context.controller.submit('iron-gear-wheel', 2)
    context.controller.tick(context.actor)

    context.queue = []
    context.inventory_counts['iron-gear-wheel'] = 2
    ;(globalThis as any).game.tick = 30
    context.controller.tick(context.actor)

    expect(context.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(context.controller.status().last_result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'completed',
      actor_id: 1,
      requested_count: 2,
      started_count: 2,
      output_count_before: 0,
      output_count_after: 2,
    })
  })

  it('fails closed when the queue disappears without producing the requested output', () => {
    const context = make_context()
    context.controller.submit('iron-gear-wheel', 2)
    context.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    context.controller.tick(context.actor)

    context.queue = []
    ;(globalThis as any).game.tick = 30
    context.controller.tick(context.actor)

    expect(context.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true, queue_length: 0 })
    expect(context.controller.status().last_result?.code).toBe('output_missing')
  })

  it('explicit cancellation removes the task-owned native queue and dependent Autorio work', () => {
    const context = make_context()
    context.controller.submit('iron-gear-wheel', 5)
    context.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    context.controller.tick(context.actor)
    expect(context.queue).toHaveLength(1)

    context.manager.cancel_all_tasks()

    expect(context.actor.cancel_crafting).toHaveBeenCalledWith({ index: 1, count: 5 })
    expect(context.queue).toHaveLength(0)
    expect(context.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true, queue_length: 0 })
    expect(context.controller.status().last_result?.code).toBe('cancelled')
  })

  it('cancels a partial native admission rather than silently completing fewer crafts', () => {
    const context = make_context()
    context.begin_count = 1
    context.controller.submit('iron-gear-wheel', 2)
    context.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })

    context.controller.tick(context.actor)

    expect(context.actor.cancel_crafting).toHaveBeenCalledWith({ index: 1, count: 1 })
    expect(context.queue).toHaveLength(0)
    expect(context.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true, queue_length: 0 })
    expect(context.controller.status().last_result?.code).toBe('partial_start')
  })

  describe('hand-crafted item counter', () => {
    beforeEach(() => {
      ;(globalThis as any).prototypes = {
        ...(globalThis as any).prototypes,
        recipe: {
          'iron-gear-wheel': { products: [{ type: 'item', name: 'iron-gear-wheel', amount: 1 }] },
          'transport-belt': { products: [{ type: 'item', name: 'transport-belt', amount: 2 }] },
        },
      }
    })

    it('credits a craft only when the engine takes it off the native queue', () => {
      const context = make_context()
      context.controller.submit('iron-gear-wheel', 3)
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(0)

      // The order alone (queue still full) counts nothing.
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(0)

      context.queue = [{ index: 1, recipe: 'iron-gear-wheel', count: 2, prerequisite: false }]
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(1)

      // Ticking again on the same queue does not double count.
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(1)

      context.queue = []
      context.inventory_counts['iron-gear-wheel'] = 3
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(3)
      expect(context.controller.status().last_result?.code).toBe('completed')
    })

    it('multiplies by the recipe yield and credits prerequisite crafts as what they produce', () => {
      const context = make_context()
      ;(context.actor.force as any).recipes['transport-belt'] = { enabled: true }
      context.controller.submit('transport-belt', 2)
      context.controller.tick(context.actor)
      context.queue = [
        { index: 1, recipe: 'iron-gear-wheel', count: 2, prerequisite: true },
        { index: 2, recipe: 'transport-belt', count: 2, prerequisite: false },
      ]
      // begin_crafting queued only the belt in the mock; re-take the snapshot as
      // the engine would have after queueing prerequisites.
      context.manager.player_state.parameters_craft_item!.queue_snapshot = { 'iron-gear-wheel': 2, 'transport-belt': 2 }

      context.queue = [{ index: 1, recipe: 'transport-belt', count: 2, prerequisite: false }]
      context.controller.tick(context.actor)

      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(2)
      expect(crafted_item_count(1, 'transport-belt')).toBe(0)
    })

    it('does not credit crafts the request cancels, but keeps those finished before the cancel', () => {
      const context = make_context()
      context.controller.submit('iron-gear-wheel', 5)
      context.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
      context.controller.tick(context.actor)

      // Two crafts finish, then the goal is cancelled before the next tick.
      context.queue = [{ index: 1, recipe: 'iron-gear-wheel', count: 3, prerequisite: false }]
      context.manager.cancel_all_tasks()

      expect(context.actor.cancel_crafting).toHaveBeenCalledWith({ index: 1, count: 3 })
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(2)
      context.controller.tick(context.actor)
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(2)
    })

    it('credits nothing for a craft that never started', () => {
      const context = make_context()
      context.controller.submit('iron-gear-wheel', 2)
      context.manager.cancel_all_tasks()
      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(0)
    })

    it('keeps one count per force', () => {
      const context = make_context()
      context.controller.submit('iron-gear-wheel', 1)
      context.controller.tick(context.actor)
      context.queue = []
      context.inventory_counts['iron-gear-wheel'] = 1
      context.controller.tick(context.actor)

      expect(crafted_item_count(1, 'iron-gear-wheel')).toBe(1)
      expect(crafted_item_count(2, 'iron-gear-wheel')).toBe(0)
    })
  })

  it('does not let an actor replacement inherit or cancel the old body native queue', () => {
    const context = make_context()
    context.controller.submit('iron-gear-wheel', 2)
    context.controller.tick(context.actor)
    context.actor_id = 99

    context.controller.tick(context.actor)

    expect(context.actor.cancel_crafting).not.toHaveBeenCalled()
    expect(context.controller.status().last_result?.code).toBe('actor_changed')
    expect(context.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})
