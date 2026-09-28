import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture(target_x: number) {
  let mining = false
  const resource = {
    valid: true,
    name: 'iron-ore',
    type: 'resource',
    position: { x: target_x, y: 0 },
    amount: 100,
    unit_number: 91,
  }
  const surface = {
    index: 1,
    find_entities_filtered: vi.fn(() => [resource]),
  }
  const set_mining_state = vi.fn((state: { mining: boolean }) => {
    mining = state.mining
  })
  const actor = {
    is_valid: true,
    character: {
      valid: true,
      resource_reach_distance: 2.7,
      reach_distance: 10,
    },
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    update_selected_entity: vi.fn(),
    get_mining_state: vi.fn(() => ({ mining })),
    set_mining_state,
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    owns_player_index: () => false,
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const controller = new_basic_operation_controller(get_actor, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  return { actor, resource, surface, set_mining_state, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['iron-ore'] = {}
})

describe('mining reach recovery', () => {
  it('temporarily pathfinds closer when the next resource is outside real resource reach', () => {
    const f = fixture(3)
    expect(f.controller.submit_mining('iron-ore', 20)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      entity_name: 'iron-ore',
      target: f.resource,
      target_position: { x: 3, y: 0 },
      reach_distance: 2.45,
      owner_actor_id: 42,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
      active_batch: {
        task_count: 1,
        task_types: [TaskStates.MINING],
      },
    })
    expect(f.set_mining_state).toHaveBeenCalledWith({ mining: false })
  })

  it('starts mining immediately when the target is already inside real resource reach', () => {
    const f = fixture(2)
    expect(f.controller.submit_mining('iron-ore', 20)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state().task_state).toBe(TaskStates.MINING)
    expect(f.manager.player_state().parameters_mine_entity).toMatchObject({
      count: 20,
      position: { x: 2, y: 0 },
      last_target_amount: 100,
    })
    expect(f.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: { x: 2, y: 0 } })
  })
})
