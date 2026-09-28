import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_interaction_recovery } from './interaction_recovery'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function target(name: string, unit_number: number, x: number) {
  return {
    valid: true,
    name,
    type: name === 'assembling-machine-1' ? 'assembling-machine' : 'container',
    unit_number,
    position: { x, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
  } as any
}

function fixture() {
  const nearby: any[] = []
  const surface = {
    index: 1,
    find_entities_filtered: vi.fn(() => nearby),
    can_place_entity: vi.fn(() => true),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => position),
  }
  const actor = {
    is_valid: true,
    character: {
      valid: true,
      name: 'character',
      reach_distance: 3,
      build_distance: 6,
    },
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
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
  const recovery = new_interaction_recovery(manager)
  return { actor, nearby, surface, manager, controller, recovery }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
  ;(globalThis as any).game.get_player = () => undefined
  ;(globalThis as any).prototypes.entity['steel-chest'] = {
    collision_box: {
      left_top: { x: -0.8, y: -0.8 },
      right_bottom: { x: 0.8, y: 0.8 },
    },
  }
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {}
})

describe('generic interaction range recovery', () => {
  it('temporarily pathfinds to the exact entity before an item transfer without adding a user operation', () => {
    const f = fixture()
    const chest = target('steel-chest', 101, 5)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => chest)

    expect(f.controller.submit_move_exact('iron-plate', 101, 10, true)[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      entity_name: 'steel-chest',
      target_kind: 'exact_entity',
      target: chest,
      target_unit_number: 101,
      target_position: { x: 5, y: 0 },
      reach_distance: 2.75,
      owner_actor_id: 42,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MOVING_ITEMS],
      active_batch: {
        task_count: 1,
        task_types: [TaskStates.MOVING_ITEMS],
      },
    })
  })

  it('uses the same exact-entity recovery before setting a machine recipe', () => {
    const f = fixture()
    const machine = target('assembling-machine-1', 202, 5)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => machine)

    expect(f.controller.submit_set_recipe_exact(202, 'iron-gear-wheel')[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      entity_name: 'assembling-machine-1',
      target_kind: 'exact_entity',
      target_unit_number: 202,
      reach_distance: 2.75,
    })
    expect(f.manager.get_status_snapshot().queued_task_types).toEqual([TaskStates.SETTING_RECIPE])
  })

  it('uses the same exact-entity recovery before rotating a placed entity', () => {
    const f = fixture()
    const chest = target('steel-chest', 212, 5)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => chest)

    expect(f.controller.submit_rotate_exact(212, false)[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      entity_name: 'steel-chest',
      target_kind: 'exact_entity',
      target_unit_number: 212,
      reach_distance: 2.75,
    })
    expect(f.manager.get_status_snapshot().queued_task_types).toEqual([TaskStates.ROTATING])
  })

  it('tracks a moving connected player for player item transfers', () => {
    const f = fixture()
    const character = target('character', 303, 6)
    const player = {
      valid: true,
      connected: true,
      character,
      surface: { index: 1 },
      position: character.position,
    }
    ;(globalThis as any).game.get_player = vi.fn(() => player)

    expect(f.controller.submit_player_move('iron-plate', 'Louis', 5, true)[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      target_kind: 'player',
      target_player_name: 'Louis',
      target: character,
      reach_distance: 2.75,
    })
    expect(f.manager.get_status_snapshot().queued_task_types).toEqual([TaskStates.MOVING_ITEMS])
  })

  it('pathfinds only into build reach instead of walking onto an exact placement coordinate', () => {
    const f = fixture()

    expect(f.controller.submit_placement('steel-chest', 8, 0, 2)).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 8, y: 0 },
      target_position: { x: 8, y: 0 },
      reach_distance: 5.75,
      owner_actor_id: 42,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.PLACING],
      active_batch: {
        task_count: 1,
        task_types: [TaskStates.PLACING],
      },
    })
  })

  it('steps AIRI aside and resumes the same placement when its own body is the likely blocker', () => {
    const f = fixture()
    f.surface.can_place_entity.mockReturnValue(false)

    expect(f.controller.submit_placement('steel-chest', 0, 0, 0)).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.surface.can_place_entity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'steel-chest',
      position: { x: 0, y: 0 },
      direction: 0,
    }))
    expect(f.surface.find_non_colliding_position).toHaveBeenCalled()
    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 2.3, y: 0 },
      target_position: { x: 2.3, y: 0 },
      reach_distance: 0.75,
    })
    expect(f.manager.get_status_snapshot().queued_task_types).toEqual([TaskStates.PLACING])
  })

  it('does not wander away for a blocked placement when AIRI is already outside the requested footprint', () => {
    const f = fixture()
    f.surface.can_place_entity.mockReturnValue(false)

    expect(f.controller.submit_placement('steel-chest', 3, 0, 0)).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(false)

    expect(f.surface.find_non_colliding_position).not.toHaveBeenCalled()
    expect(f.manager.player_state().task_state).toBe(TaskStates.PLACING)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
  })

  it('leaves already-reachable interactions untouched', () => {
    const f = fixture()
    const chest = target('steel-chest', 404, 2)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => chest)

    expect(f.controller.submit_move_exact('iron-plate', 404, 1, true)[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(false)
    expect(f.manager.player_state().task_state).toBe(TaskStates.MOVING_ITEMS)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
  })

  it('approaches the nearest legacy named transfer target instead of failing merely because it is outside real reach', () => {
    const f = fixture()
    const far = target('steel-chest', 505, 5)
    f.nearby.push(far)

    expect(f.controller.submit_move('iron-plate', 'steel-chest', 1, true)[0]).toBe(true)
    expect(f.recovery.tick(f.actor)).toBe(true)

    expect(f.surface.find_entities_filtered).toHaveBeenCalledWith(expect.objectContaining({
      radius: 8,
      name: 'steel-chest',
    }))
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      target_kind: 'exact_entity',
      target: far,
      target_unit_number: 505,
      reach_distance: 2.75,
    })
  })
})
