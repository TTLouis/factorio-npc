import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remember_entity_reference } from './entity_reference'
import { new_navigation_controller } from './navigation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture() {
  let nextRequestId = 100
  const position = { x: 0, y: 0 }
  const target = {
    valid: true,
    name: 'steel-chest',
    unit_number: 88,
    position: { x: 20, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
  }
  const character = {
    valid: true,
    name: 'character',
    position,
    prototype: {
      collision_box: [[-0.2, -0.2], [0.2, 0.2]],
      collision_mask: { layers: { player: true }, consider_tile_transitions: true },
    },
  }
  const surface = {
    index: 1,
    valid: true,
    find_entities_filtered: vi.fn(() => []),
    find_non_colliding_position: vi.fn(() => ({ x: 6, y: 0 })),
    get_tile: vi.fn(() => ({ name: 'grass-1' })),
    request_path: vi.fn(() => ++nextRequestId),
  }
  const actor = {
    is_valid: true,
    character,
    position,
    surface,
    force: { index: 1 },
    status_snapshot: vi.fn(() => ({
      actor_id: 1,
      kind: 'standalone_character',
      valid: true,
      name: 'AIRI',
      position,
      has_character: true,
    })),
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_navigation_controller(resolve, manager)
  return { actor, controller, manager, position, surface, target }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)
})

describe('precise navigation primitives', () => {
  it('pathfinds to an exact world position without binding to a nearby entity', () => {
    const f = fixture()
    expect(f.controller.submit_position(24, 47, 0.75)).toEqual([true, 'Task started'])

    f.controller.tick(f.actor)

    expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(f.surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: 24, y: 47 },
      radius: 0.75,
    }))
    expect(f.controller.status()).toMatchObject({
      task_active: true,
      target_kind: 'position',
      reach_distance: 0.75,
      destination: { position: { x: 24, y: 47 } },
    })
  })

  it('binds exact entity navigation to unit_number instead of reselecting a nearer same-name entity', () => {
    const f = fixture()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => f.target)

    expect(f.controller.submit_exact(88, 2)).toEqual([true, 'Task started'])
    f.controller.tick(f.actor)

    expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(f.surface.request_path).toHaveBeenCalledWith(expect.objectContaining({ goal: { x: 20, y: 0 } }))
    expect(f.manager.player_state.parameters_walk_to_entity?.target_unit_number).toBe(88)
    expect(f.controller.status()).toMatchObject({
      target_kind: 'exact_entity',
      target: { unit_number: 88, name: 'steel-chest' },
    })
  })

  it('reaches an observed building the unit-number index does not cover, resolving it once', () => {
    const f = fixture()
    // Ordinary buildings are not indexed by game.get_entity_by_unit_number();
    // the observation hint on the target's surface finds the same identity.
    remember_entity_reference(f.target as any)
    f.surface.find_entities_filtered.mockReturnValue([f.target] as any)
    ;(globalThis as any).game.get_surface = vi.fn(() => f.surface)

    expect(f.controller.submit_exact(88, 2)).toEqual([true, 'Task started'])
    f.controller.tick(f.actor)

    expect(f.surface.request_path).toHaveBeenCalledWith(expect.objectContaining({ goal: { x: 20, y: 0 } }))
    expect(f.surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect((globalThis as any).game.get_entity_by_unit_number).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an exact unit disappears before movement starts', () => {
    const f = fixture()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn()

    expect(f.controller.submit_exact(88, 2)).toEqual([false, 'Entity unit 88 not found'])
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.surface.request_path).not.toHaveBeenCalled()
  })

  it('completes a coordinate target using the requested arrival radius', () => {
    const f = fixture()
    expect(f.controller.submit_position(4, 0, 0.75)[0]).toBe(true)
    f.controller.tick(f.actor)
    const requestId = f.manager.player_state.parameters_walk_to_entity!.path_request_id!
    f.controller.on_path_finished({ id: requestId, path: [{ position: { x: 4, y: 0 }, needs_destroy_to_reach: false }], try_again_later: false } as any)

    f.position.x = 3.5
    ;(globalThis as any).game.tick = 20
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({ code: 'reached', completed: true })
  })
})
