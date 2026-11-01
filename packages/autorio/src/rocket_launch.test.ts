import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { LAUNCH_CONFIRMATION_TICKS, new_rocket_launch_runtime } from './rocket_launch'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function silo(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    name: 'rocket-silo',
    type: 'rocket-silo',
    unit_number: 301,
    position: { x: 3, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
    rocket_parts: 0,
    rocket_silo_status: 'rocket_ready',
    prototype: { rocket_parts_required: 50 },
    launch_rocket: vi.fn(() => true),
    ...overrides,
  }
}

function context() {
  const force = { index: 1, rockets_launched: 0 }
  const actor = {
    is_valid: true,
    character: { valid: true },
    force,
    surface: { index: 1 },
    position: { x: 0, y: 0 },
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
  const runtime = new_rocket_launch_runtime(manager, controller)
  return { actor, force, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
})

describe('exact rocket launch', () => {
  it('orders the launch without boarding the NPC, then completes only once the force counts the rocket', () => {
    const c = context()
    const target = silo()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn((unit: number) => unit === 301 ? target : undefined)

    expect(c.controller.submit_launch_rocket_exact(301)).toEqual([true, 'Task started'])
    c.runtime.state_launching_rocket(c.actor)

    // Called with no character and no destination.
    expect(target.launch_rocket).toHaveBeenCalledWith()
    expect(c.manager.player_state.task_state).toBe(TaskStates.LAUNCHING_ROCKET)

    // The order alone is not a launched rocket.
    ;(globalThis as any).game.tick = 400
    c.runtime.state_launching_rocket(c.actor)
    expect(c.manager.player_state.task_state).toBe(TaskStates.LAUNCHING_ROCKET)
    expect(target.launch_rocket).toHaveBeenCalledTimes(1)

    c.force.rockets_launched = 1
    c.runtime.state_launching_rocket(c.actor)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      target_unit_number: 301,
      rockets_launched: 1,
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('reports the silo progress when the rocket is not ready yet', () => {
    const c = context()
    const target = silo({ rocket_silo_status: 'building_rocket', rocket_parts: 12 })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    c.controller.submit_launch_rocket_exact(301)
    c.runtime.state_launching_rocket(c.actor)

    expect(target.launch_rocket).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({
      code: 'rocket_not_ready',
      completed: false,
      rocket_parts: 12,
      rocket_parts_required: 50,
    })
  })

  it('fails with launch_not_confirmed when the count never rises', () => {
    const c = context()
    const target = silo()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    c.controller.submit_launch_rocket_exact(301)
    c.runtime.state_launching_rocket(c.actor)
    ;(globalThis as any).game.tick = 100 + LAUNCH_CONFIRMATION_TICKS + 1
    c.runtime.state_launching_rocket(c.actor)

    expect(c.controller.status().last_result).toMatchObject({ code: 'launch_not_confirmed', completed: false })
  })

  it('does not fail a flying rocket because its silo became invalid after the order', () => {
    const c = context()
    const target = silo()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    c.controller.submit_launch_rocket_exact(301)
    c.runtime.state_launching_rocket(c.actor)
    target.valid = false
    c.force.rockets_launched = 1
    c.runtime.state_launching_rocket(c.actor)

    expect(c.controller.status().last_result).toMatchObject({ code: 'completed' })
  })

  it.each([
    ['target_gone', undefined],
    ['different_surface', silo({ surface: { index: 2 } })],
    ['wrong_force', silo({ force: { index: 2 } })],
    ['too_far', silo({ position: { x: 40, y: 0 } })],
    ['not_rocket_silo', silo({ type: 'assembling-machine' })],
  ])('fails closed with %s before ordering a launch', (expectedCode, target) => {
    const c = context()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    c.controller.submit_launch_rocket_exact(301)
    c.runtime.state_launching_rocket(c.actor)

    if (target) expect(target.launch_rocket).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({ code: expectedCode, completed: false })
  })

  it('reports launch_failed when the engine refuses the order', () => {
    const c = context()
    const target = silo({ launch_rocket: vi.fn(() => false) })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    c.controller.submit_launch_rocket_exact(301)
    c.runtime.state_launching_rocket(c.actor)

    expect(c.controller.status().last_result).toMatchObject({ code: 'launch_failed' })
  })
})
