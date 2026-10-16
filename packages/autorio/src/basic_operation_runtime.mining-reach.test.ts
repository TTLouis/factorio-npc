import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'
import { select_exact_mining_target } from './mining_reach'

function fixture(target_x: number) {
  let mining = false
  const resource = {
    valid: true,
    name: 'iron-ore',
    type: 'resource',
    position: { x: target_x, y: 0 },
    amount: 100,
    unit_number: 91,
    surface: undefined as any,
    force: { index: 1 },
  }
  const surface = {
    index: 1,
    find_entities_filtered: vi.fn(() => [resource]),
  }
  const set_mining_state = vi.fn((state: { mining: boolean }) => {
    mining = state.mining
  })
  const character: Record<string, any> = {
    valid: true,
    resource_reach_distance: 2.7,
    reach_distance: 10,
    selected: undefined,
  }
  resource.surface = surface
  const update_selected_entity = vi.fn(() => { character.selected = resource })
  const actor = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    update_selected_entity,
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
      name: 'SGLuna',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const controller = new_basic_operation_controller(get_actor, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  return { actor, character, resource, surface, set_mining_state, manager, controller, runtime, set_mining: (value: boolean) => { mining = value } }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['iron-ore'] = {}
})

describe('mining reach recovery', () => {
  it('selects a centre-occluded natural tree by exact object identity without a unit number', () => {
    const trace = vi.spyOn(globalThis, 'log')
    const f = fixture(2)
    const target = { ...f.resource, type: 'tree', name: 'tree-01', unit_number: undefined,
      prototype: { is_building: false, mineable_properties: { minable: true } },
      selection_box: { left_top: { x: 1, y: -2 }, right_bottom: { x: 3, y: 0.5 } } } as any
    const other = { ...target }
    vi.mocked(f.actor.update_selected_entity).mockImplementation(position => {
      f.character.selected = position.y < -1 ? target : other
    })
    expect(select_exact_mining_target(f.actor, target)).toBe(true)
    expect(f.character.selected).toBe(target)
    expect(trace).toHaveBeenCalledWith(expect.stringContaining('reason=natural_centre_occluded actor_id=42'))
    trace.mockRestore()
  })

  it('keeps non-harvest selection unchanged and placed buildings centre-only without an opt-in', () => {
    const f = fixture(2)
    const target = { ...f.resource, type: 'simple-entity', unit_number: undefined,
      prototype: { is_building: false, mineable_properties: { minable: true } },
      selection_box: { left_top: { x: 1, y: -1 }, right_bottom: { x: 3, y: 1 } } } as any
    const select = vi.mocked(f.actor.update_selected_entity)
    select.mockImplementation(() => { f.character.selected = { ...target } })
    expect(select_exact_mining_target(f.actor, target)).toBe(false)
    expect(select).toHaveBeenCalledTimes(9)
    select.mockClear()
    target.prototype.is_building = true
    target.prototype.items_to_place_this = [{ name: 'rock', count: 1 }]
    expect(select_exact_mining_target(f.actor, target)).toBe(false)
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('uses verified native exact selection only for an in-reach same-surface standalone natural target', () => {
    const f = fixture(2)
    const target = { ...f.resource, type: 'tree', unit_number: undefined,
      prototype: { is_building: false, mineable_properties: { minable: true } },
      selection_box: { left_top: { x: 1, y: -1 }, right_bottom: { x: 3, y: 1 } } } as any
    const other = { ...target }
    const recovered = vi.fn()
    vi.mocked(f.actor.update_selected_entity).mockImplementation(() => { f.character.selected = other })
    expect(select_exact_mining_target(f.actor, target, recovered)).toBe(true)
    expect(f.actor.update_selected_entity).toHaveBeenCalledTimes(9)
    expect(f.character.selected).toBe(target)
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(f.set_mining_state).not.toHaveBeenCalled()
  })

  it('never grants exact native selection across reach, surface, actor kind or native selection refusal', () => {
    for (const mode of ['far', 'surface', 'connected', 'native_refusal']) {
      const f = fixture(mode === 'far' ? 8 : 2)
      const target = { ...f.resource, type: 'tree', unit_number: undefined,
        prototype: { is_building: false, mineable_properties: { minable: true } },
        selection_box: { left_top: { x: 1, y: -1 }, right_bottom: { x: 3, y: 1 } } } as any
      const other = { ...target }; const recovered = vi.fn()
      if (mode === 'surface') target.surface = { index: 2 }
      if (mode === 'connected') (f.actor as any).status_snapshot = () => ({ actor_id: 42, kind: 'connected_player' })
      vi.mocked(f.actor.update_selected_entity).mockImplementation(() => { f.character.selected = other })
      if (mode === 'native_refusal') Object.defineProperty(f.character, 'selected', { get: () => other, set: () => {} })
      expect(select_exact_mining_target(f.actor, target, recovered)).toBe(false)
      expect(recovered).not.toHaveBeenCalled()
      expect(f.set_mining_state).not.toHaveBeenCalled()
    }
  })

  it('selects the exact resource through an interior point when an overlapping tree wins centre selection', () => {
    const trace = vi.spyOn(globalThis, 'log')
    const f = fixture(2)
    const tree = { valid: true, name: 'tree-05', unit_number: 200 }
    Object.assign(f.resource, { selection_box: { left_top: { x: 1.5, y: -0.5 }, right_bottom: { x: 2.5, y: 0.5 } } })
    const select = vi.mocked(f.actor.update_selected_entity)
    select.mockImplementation(position => { f.character.selected = position.y < 0 ? f.resource : tree })
    expect(f.controller.submit_mining('iron-ore', 1)).toBe(true)
    f.runtime.state_mining(f.actor)
    expect(select.mock.calls[0][0]).toEqual({ x: 2, y: 0 })
    expect(select.mock.calls[1][0]).toEqual({ x: 1.6, y: -0.4 })
    expect(f.character.selected).toBe(f.resource)
    expect(f.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: { x: 2, y: 0 } })
    expect(f.manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(trace).toHaveBeenCalledWith(expect.stringContaining('mining.exact_selection_recovered reason=resource_centre_occluded actor_id=42'))
    trace.mockRestore()
  })

  it('never mines a same-name substitute when every bounded resource selection point misses the exact target', () => {
    const f = fixture(2)
    Object.assign(f.resource, { selection_box: { left_top: { x: 1.5, y: -0.5 }, right_bottom: { x: 2.5, y: 0.5 } } })
    const other = { ...f.resource, unit_number: 92 }
    const select = vi.mocked(f.actor.update_selected_entity)
    select.mockImplementation(() => { f.character.selected = other })
    expect(f.controller.submit_mining('iron-ore', 1)).toBe(true)
    f.runtime.state_mining(f.actor)
    expect(select).toHaveBeenCalledTimes(9)
    expect(f.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
    for (const [point] of select.mock.calls.slice(1)) {
      expect(point.x).toBeGreaterThan(1.5); expect(point.x).toBeLessThan(2.5)
      expect(point.y).toBeGreaterThan(-0.5); expect(point.y).toBeLessThan(0.5)
    }
  })

  it('temporarily pathfinds closer when the next resource is outside real resource reach', () => {
    const f = fixture(3)
    expect(f.controller.submit_mining('iron-ore', 20)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      entity_name: 'iron-ore',
      target_kind: 'position',
      requested_position: { x: 3, y: 0 },
      target: null,
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

  it('uses resource mining reach for an exact finite natural entity instead of generic interaction reach', () => {
    const f = fixture(8)
    const natural = {
      valid: true,
      name: 'mod-tree-a',
      type: 'tree',
      unit_number: 191,
      position: { x: 8, y: 0 },
      surface: f.surface,
      force: { index: 1 },
      prototype: {
        is_building: false,
        mineable_properties: { minable: true, mining_time: 0.5, products: [] },
      },
    } as any
    ;(globalThis as any).prototypes.entity['mod-tree-a'] = natural.prototype
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => unit === 191 ? natural : undefined

    expect(f.controller.submit_mining_exact(191)).toBe(true)
    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      entity_name: 'mod-tree-a',
      target_kind: 'position',
      requested_position: { x: 8, y: 0 },
      target: null,
      target_unit_number: undefined,
      target_position: { x: 8, y: 0 },
      reach_distance: 2.45,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
    })
    f.manager.reset_task_state()
    f.manager.next_task()
    expect(f.manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      target_unit_number: 191,
      count: 1,
    })
    expect(f.set_mining_state).toHaveBeenCalledWith({ mining: false })
  })

  it('uses resource mining reach for a natural simple-entity rock even when the engine marks it as a building', () => {
    const f = fixture(8)
    const rock = {
      valid: true,
      minable: true,
      name: 'big-modded-rock',
      type: 'simple-entity',
      unit_number: 192,
      position: { x: 8, y: 0 },
      surface: f.surface,
      force: { index: 1 },
      prototype: {
        type: 'simple-entity',
        is_building: true,
        is_entity_with_owner: false,
        items_to_place_this: undefined,
        mineable_properties: { minable: true, mining_time: 0.5, products: [] },
      },
    } as any
    ;(globalThis as any).prototypes.entity['big-modded-rock'] = rock.prototype
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => unit === 192 ? rock : undefined

    expect(f.controller.submit_mining_exact(192)).toBe(true)
    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      entity_name: 'big-modded-rock',
      target_kind: 'position',
      requested_position: { x: 8, y: 0 },
      reach_distance: 2.45,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
    })

    f.manager.reset_task_state()
    f.manager.next_task()
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      target_unit_number: 192,
      count: 1,
    })
  })

  it('starts mining immediately when the target is already inside real resource reach', () => {
    const f = fixture(2)
    expect(f.controller.submit_mining('iron-ore', 20)).toBe(true)

    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      count: 20,
      position: { x: 2, y: 0 },
      last_target_amount: 100,
    })
    expect(f.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: { x: 2, y: 0 } })
  })

  it('moves farther toward the exact mining target when Factorio clears a started mining selection', () => {
    const f = fixture(2)
    expect(f.controller.submit_mining_exact(91)).toBe(true)
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => unit === 91 ? f.resource : undefined

    f.runtime.state_mining(f.actor)
    expect(f.manager.player_state.parameters_mine_entity).toMatchObject({
      target_unit_number: 91,
      mining_attempted: true,
    })

    f.character.selected = undefined
    f.set_mining(false)
    f.runtime.state_mining(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 2, y: 0 },
      reach_distance: 1.25,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
    })
  })

  it('fails closed after bounded repeated engine rejections instead of restarting mining every tick', () => {
    const f = fixture(2)
    expect(f.controller.submit_mining('iron-ore', 1)).toBe(true)
    f.runtime.state_mining(f.actor)

    for (let rejection = 1; rejection <= 4; rejection++) {
      f.character.selected = undefined
      f.set_mining(false)
      f.runtime.state_mining(f.actor)
      if (rejection <= 3) {
        expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
        f.manager.reset_task_state()
        f.manager.next_task()
        expect(f.manager.player_state.task_state).toBe(TaskStates.MINING)
        f.runtime.state_mining(f.actor)
      }
    }

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({
      accepted: false,
      completed: false,
      code: 'mining_rejected',
    })
    const starts = f.set_mining_state.mock.calls.filter(([state]) => state.mining === true)
    expect(starts).toHaveLength(4)
  })
})
