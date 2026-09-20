import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture() {
  let mining = false
  const surface: any = {
    index: 1,
    find_entities_filtered: vi.fn(),
  }
  const force = { index: 1 }
  const exactResource = {
    valid: true,
    name: 'coal',
    type: 'resource',
    position: { x: 2, y: 0 },
    amount: 100,
    surface,
    force,
  }
  const nearerResource = {
    valid: true,
    name: 'coal',
    type: 'resource',
    position: { x: 1, y: 0 },
    amount: 100,
    surface,
    force,
  }
  const exactEntity = {
    valid: true,
    name: 'steel-chest',
    type: 'container',
    unit_number: 91,
    position: { x: 2, y: 0 },
    surface,
    force,
    prototype: {
      is_building: true,
      mineable_properties: { minable: true, mining_time: 0.5, products: [] },
    },
  }

  surface.find_entities_filtered.mockImplementation((query: any) => {
    if (query.name === 'coal' && query.position?.x === 2 && query.position?.y === 0) return [exactResource]
    if (query.name === 'coal') return [nearerResource, exactResource]
    return []
  })

  const character: Record<string, any> = {
    valid: true,
    resource_reach_distance: 2.7,
    reach_distance: 10,
    selected: undefined,
  }
  const actor = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force,
    update_selected_entity: vi.fn((position: { x: number, y: number }) => {
      if (position.x !== 2 || position.y !== 0) character.selected = undefined
      else character.selected = (globalThis as any).game.get_entity_by_unit_number(91) ?? exactResource
    }),
    get_mining_state: vi.fn(() => ({ mining })),
    set_mining_state: vi.fn((state: { mining: boolean }) => { mining = state.mining }),
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
  return { actor, exactResource, nearerResource, exactEntity, surface, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
  ;(globalThis as any).prototypes.entity.coal = { type: 'resource' }
  ;(globalThis as any).prototypes.entity['steel-chest'] = { type: 'container' }
})

describe('precise mining targeting', () => {
  it('mines the requested resource position instead of substituting the nearer same-name resource', () => {
    const f = fixture()
    expect(f.controller.submit_mining_at('coal', 2, 0, 1)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.exactResource.position })
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith({ mining: true, position: f.nearerResource.position })
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      requested_position: { x: 2, y: 0 },
      position: { x: 2, y: 0 },
    })
  })

  it('mines one exact entity by unit number without a same-name nearest lookup', () => {
    const f = fixture()
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => unit === 91 ? f.exactEntity : undefined
    expect(f.controller.submit_mining_exact(91)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.surface.find_entities_filtered).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'steel-chest' }))
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.exactEntity.position })
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      target_unit_number: 91,
      position: { x: 2, y: 0 },
      count: 1,
    })
  })

  it('fails closed when an exact entity disappears instead of substituting another target', () => {
    const f = fixture()
    expect(f.controller.submit_mining_exact(999)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({ code: 'target_gone', target_unit_number: 999 })
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })

  it('rejects non-resource prototypes for exact-position resource mining', () => {
    const f = fixture()
    expect(f.controller.submit_mining_at('steel-chest', 2, 0, 1)).toBe(false)
    expect(f.controller.status().last_result).toMatchObject({ code: 'invalid_entity' })
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})
