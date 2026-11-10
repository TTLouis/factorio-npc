import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { new_area_clearing_controller } from './area_clearing'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function entity(
  name: string,
  type: string,
  x: number,
  options: { building?: boolean, mineable?: boolean, owned?: boolean, placeable?: boolean } = {},
) {
  const building = options.building ?? false
  const mineable = options.mineable !== false
  const owned = options.owned ?? building
  const placeable = options.placeable ?? building
  return {
    valid: true,
    minable: mineable,
    name,
    type,
    position: { x, y: 0 },
    prototype: {
      name,
      type,
      is_building: building,
      is_entity_with_owner: owned,
      items_to_place_this: placeable ? [{ name: `${name}-item`, count: 1 }] : undefined,
      mineable_properties: { minable: mineable, mining_time: 0.5, products: [] },
    },
  } as any
}

function fixture() {
  let mining = false
  const treeA = entity('mod-tree-a', 'tree', 1)
  const treeB = entity('mod-tree-b', 'tree', 2)
  const rock = entity('mod-rock-z', 'simple-entity', 2.4, { building: true, owned: false, placeable: false })
  const resource = entity('iron-resource-x', 'resource', 1.5)
  const machine = entity('existing-machine-x', 'assembling-machine', 2.5, { building: true })
  const treeOutside = entity('mod-tree-outside', 'tree', 8)
  const entities = [treeA, treeB, rock, resource, machine, treeOutside]

  const surface: any = {
    index: 1,
    find_entities_filtered: vi.fn((query: any) => {
      const leftTop = query.area?.left_top
      const rightBottom = query.area?.right_bottom
      return entities
        .filter(item => item.valid)
        .filter(item => !leftTop || !rightBottom
          || (item.position.x >= leftTop.x
            && item.position.x <= rightBottom.x
            && item.position.y >= leftTop.y
            && item.position.y <= rightBottom.y))
    }),
  }
  const character: any = { valid: true, reach_distance: 10, resource_reach_distance: 2.7, selected: undefined }
  const room = { fits: true }
  // Without room only part of the stack fits, which must still stop the pickup.
  const inventory = { get_insertable_count: vi.fn((stack: { count: number }) => room.fits ? stack.count : Math.max(0, stack.count - 1)) }
  const actor = {
    get_main_inventory: () => inventory,
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    update_selected_entity: vi.fn((position: { x: number, y: number }) => {
      character.selected = entities.find(item => item.valid && item.position.x === position.x && item.position.y === position.y)
    }),
    get_mining_state: vi.fn(() => ({ mining })),
    set_mining_state: vi.fn((state: { mining: boolean }) => { mining = state.mining }),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    owns_player_index: () => true,
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'SGLuna',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const controller = new_area_clearing_controller(() => actor, manager)
  return { actor, manager, controller, treeA, treeB, rock, resource, machine, treeOutside, entities, room, inventory }
}

function ground_item(name: string, count: number, x: number) {
  const item = entity('item-on-ground', 'item-entity', x)
  item.stack = { valid_for_read: true, name, count }
  return item
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('construction-area finite blocker clearing', () => {
  it('clears heterogeneous mineable non-resource blockers until a live rescan verifies the area is clear', () => {
    const f = fixture()
    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.manager.add_task({
      type: TaskStates.PLACING,
      entity_name: 'future-machine-x',
      position: { x: 2, y: 0 },
    })

    f.controller.tick(f.actor)
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.treeA.position })

    f.treeA.valid = false
    f.controller.on_player_mined_entity(f.actor, 1, f.treeA)
    f.controller.tick(f.actor)
    expect(f.manager.player_state.parameters_clear_construction_area?.target_name).toBe('mod-tree-b')

    f.treeB.valid = false
    f.controller.on_player_mined_entity(f.actor, 1, f.treeB)
    f.controller.tick(f.actor)
    expect(f.manager.player_state.parameters_clear_construction_area?.target_name).toBe('mod-rock-z')

    f.rock.valid = false
    f.controller.on_player_mined_entity(f.actor, 1, f.rock)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect(f.manager.player_state.parameters_place_entity).toMatchObject({
      entity_name: 'future-machine-x',
      position: { x: 2, y: 0 },
    })
    expect(f.resource.valid).toBe(true)
    expect(f.machine.valid).toBe(true)
    expect(f.treeOutside.valid).toBe(true)
  })

  it('ignores a connected-player mining event for a different blocker identity', () => {
    const f = fixture()
    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.parameters_clear_construction_area?.target).toBe(f.treeA)
    f.controller.on_player_mined_entity(f.actor, 1, f.treeB)
    expect(f.manager.player_state.parameters_clear_construction_area).toMatchObject({
      target: f.treeA,
      cleared_count: 0,
    })

    f.controller.on_player_mined_entity(f.actor, 1, f.treeA)
    expect(f.manager.player_state.parameters_clear_construction_area).toMatchObject({
      target: null,
      cleared_count: 1,
    })
  })

  it('repositions into real finite-mining reach, then mines the same observed blocker', () => {
    const f = fixture()
    f.treeA.position.x = 8
    f.treeB.valid = false
    f.rock.valid = false

    expect(f.controller.submit(8, 0, 4, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 8, y: 0 },
      reach_distance: 2.45,
    })
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith({ mining: true, position: f.treeA.position })

    ;(f.actor.position as any).x = 6.5
    f.manager.reset_task_state()
    f.manager.next_task()
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.CLEARING_AREA)
    expect(f.manager.player_state.parameters_clear_construction_area?.target).toBe(f.treeA)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: f.treeA.position })
  })

  it('polls standalone blocker disappearance and live-rescans without a player mining event', () => {
    const f = fixture()
    ;(f.actor as any).owns_player_index = () => false
    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)

    f.controller.tick(f.actor)
    f.treeA.valid = false
    f.controller.tick(f.actor)

    expect(f.manager.player_state.parameters_clear_construction_area).toMatchObject({
      cleared_count: 1,
      target: f.treeB,
      target_name: 'mod-tree-b',
    })
  })

  it('recovers when Factorio drops an accepted mining state on the next tick while the blocker is still live', () => {
    const f = fixture()
    f.treeB.valid = false
    f.rock.valid = false
    expect(f.controller.submit(1, 0, 4, 4)[0]).toBe(true)

    f.controller.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.CLEARING_AREA)
    expect(f.actor.get_mining_state().mining).toBe(true)

    f.actor.set_mining_state({ mining: false })
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 1, y: 0 },
      reach_distance: 0.5,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.CLEARING_AREA],
    })
  })

  it('treats an exact-selection miss as a bounded closer reposition instead of immediate failure', () => {
    const f = fixture()
    f.treeB.valid = false
    f.rock.valid = false
    ;(f.actor as any).update_selected_entity = vi.fn(() => {
      ;(f.actor.character as any).selected = undefined
    })

    expect(f.controller.submit(1, 0, 4, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 1, y: 0 },
      reach_distance: 0.5,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.CLEARING_AREA],
    })
  })

  it('bounds repeated engine-rejected mining starts instead of retrying forever', () => {
    const f = fixture()
    f.treeB.valid = false
    f.rock.valid = false
    ;(f.actor as any).get_mining_state = vi.fn(() => ({ mining: false }))
    ;(f.actor as any).set_mining_state = vi.fn()

    expect(f.controller.submit(1, 0, 4, 4)[0]).toBe(true)
    for (let attempt = 0; attempt < 4; attempt++) {
      f.controller.tick(f.actor)
      if (f.manager.player_state.task_state === TaskStates.IDLE) break
      expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
      f.manager.reset_task_state()
      f.manager.next_task()
    }

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.manager.get_status_snapshot().last_cancelled_batch?.reason).toBe('clear_construction_area:mining_rejected')
  })

  it('treats a natural simple-entity rock as clearable even though Factorio reports its prototype as a building', () => {
    const f = fixture()
    f.treeA.valid = false
    f.treeB.valid = false

    expect(f.rock.prototype.is_building).toBe(true)
    expect(f.rock.prototype.is_entity_with_owner).toBe(false)
    expect(f.rock.prototype.items_to_place_this).toBeUndefined()
    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)

    f.controller.tick(f.actor)

    expect(f.manager.player_state.parameters_clear_construction_area?.target).toBe(f.rock)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: f.rock.position })
  })

  it('does not clear a prototype-mineable blocker that is not currently minable in the live world', () => {
    const f = fixture()
    f.treeA.valid = false
    f.treeB.valid = false
    f.rock.minable = false

    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.rock.valid).toBe(true)
  })

  it('does not treat normal resource patches or placed buildings as finite natural clear targets', () => {
    const f = fixture()
    f.treeA.valid = false
    f.treeB.valid = false
    f.rock.valid = false

    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.resource.valid).toBe(true)
    expect(f.machine.valid).toBe(true)
    expect(f.treeOutside.valid).toBe(true)
  })
})

// Trial 4r: ore a drill dropped blocked belt tiles. The external pick_up_ground_items operation is this task restricted to
// item-on-ground entities: it mines them like a player picks them up and touches nothing else in the box.
describe('ground-item pickup (item-on-ground entities only)', () => {
  const PICKUP = { item_entities_only: true as const, max_clears: 32 }

  it('mines only the items on the ground, leaves trees, rocks and buildings, and finishes when the box holds none', () => {
    const f = fixture()
    const ore = ground_item('iron-ore', 3, 1.8)
    f.entities.push(ore)
    expect(f.controller.submit(1, 0, 5, 5, PICKUP)).toEqual([true, 'Ground-item pickup task started'])
    f.controller.tick(f.actor)
    expect(f.manager.player_state.parameters_clear_construction_area?.target).toBe(ore)
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: ore.position })
    expect(f.inventory.get_insertable_count).toHaveBeenCalledWith(ore.stack)

    ore.valid = false
    f.actor.set_mining_state({ mining: false })
    f.controller.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    for (const kept of [f.treeA, f.treeB, f.rock, f.resource, f.machine]) expect(kept.valid).toBe(true)
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ position: f.treeA.position }))
  })

  it('stops with a refusal instead of mining a stack the inventory cannot take', () => {
    const f = fixture()
    f.entities.push(ground_item('iron-ore', 50, 1.8))
    f.room.fits = false
    expect(f.controller.submit(1, 0, 5, 5, PICKUP)[0]).toBe(true)
    f.controller.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })

  it('stops after max_clears pickups rather than chasing a drop tile that keeps refilling', () => {
    const f = fixture()
    const first = ground_item('iron-ore', 1, 1.8)
    const second = ground_item('iron-ore', 1, 2.2)
    f.entities.push(first, second)
    expect(f.controller.submit(1, 0, 5, 5, { item_entities_only: true, max_clears: 1 })[0]).toBe(true)
    const cancel = vi.spyOn(f.manager, 'cancel_all_tasks')
    f.controller.tick(f.actor)
    first.valid = false
    f.actor.set_mining_state({ mining: false })
    f.controller.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(cancel).toHaveBeenCalledWith('clear_construction_area:ground_item_pickup_limit')
    expect(second.valid).toBe(true)
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith({ mining: true, position: second.position })
  })

  it('finishes, not fails, when the box is empty right after the last allowed pickup', () => {
    const f = fixture()
    const only = ground_item('iron-ore', 1, 1.8)
    f.entities.push(only)
    expect(f.controller.submit(1, 0, 5, 5, { item_entities_only: true, max_clears: 1 })[0]).toBe(true)
    const cancel = vi.spyOn(f.manager, 'cancel_all_tasks')
    f.controller.tick(f.actor)
    only.valid = false
    f.actor.set_mining_state({ mining: false })
    f.controller.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(cancel).not.toHaveBeenCalled()
  })
})
