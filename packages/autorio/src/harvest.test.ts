import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { find_harvest_source, is_unowned_natural_harvest_source, new_harvest_controller } from './harvest'
import { natural_harvest_source_names } from './prototype_knowledge'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function mineable(name: string, type: string, product: string, amount: number, x: number) {
  const prototype = {
    name,
    type,
    // The engine marks every simple-entity (map rocks) as a building.
    is_building: type === 'simple-entity',
    mineable_properties: {
      minable: true,
      mining_time: 0.5,
      products: [{ type: 'item', name: product, amount }],
    },
  }
  const entity: any = {
    valid: true,
    name,
    type,
    position: { x, y: 0 },
    prototype,
    force: { name: 'neutral' },
  }
  return { prototype, entity }
}

function fixture() {
  let mining = false
  let stone = 0
  let wood = 0

  const rockA = mineable('mod-rock-a', 'simple-entity', 'stone', 20, 1)
  const rockB = mineable('mod-rock-b', 'simple-entity', 'stone', 4, 1.5)
  const treeA = mineable('mod-tree-a', 'tree', 'wood', 2, 1)
  const treeB = mineable('mod-tree-b', 'tree', 'wood', 3, 1.5)
  const all = [rockA.entity, rockB.entity, treeA.entity, treeB.entity]

  const surface: any = {
    index: 1,
    find_entities_filtered: vi.fn((query: any) => {
      const names = Array.isArray(query.name) ? query.name : [query.name]
      return all
        .filter(entity => entity.valid && names.includes(entity.name))
        .filter(entity => ((entity.position.x ** 2 + entity.position.y ** 2) ** 0.5) <= query.radius)
        .slice(0, query.limit)
    }),
  }
  const force = { index: 1 }
  const character: any = { valid: true, reach_distance: 10, resource_reach_distance: 2.7, selected: undefined }
  const actor = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force,
    get_main_inventory: () => ({
      get_contents: () => [
        ...(stone > 0 ? [{ name: 'stone', count: stone }] : []),
        ...(wood > 0 ? [{ name: 'wood', count: wood }] : []),
      ],
    }),
    update_selected_entity: vi.fn((position: { x: number, y: number }) => {
      character.selected = all.find(entity => entity.valid && entity.position.x === position.x && entity.position.y === position.y)
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
      name: 'SGLuna',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor

  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const harvest = new_harvest_controller(get_actor, manager)
  return {
    actor,
    manager,
    harvest,
    rockA: rockA.entity,
    rockB: rockB.entity,
    treeA: treeA.entity,
    treeB: treeB.entity,
    setStone: (count: number) => { stone = count },
    setWood: (count: number) => { wood = count },
  }
}

beforeEach(() => {
  ;(globalThis as any).pairs = luaPairs
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  const rockA = mineable('mod-rock-a', 'simple-entity', 'stone', 20, 1)
  const rockB = mineable('mod-rock-b', 'simple-entity', 'stone', 4, 1.5)
  const treeA = mineable('mod-tree-a', 'tree', 'wood', 2, 1)
  const treeB = mineable('mod-tree-b', 'tree', 'wood', 3, 1.5)
  ;(globalThis as any).prototypes = {
    item: {
      stone: { name: 'stone' },
      wood: { name: 'wood' },
    },
    entity: {
      'mod-rock-a': rockA.prototype,
      'mod-rock-b': rockB.prototype,
      'mod-tree-a': treeA.prototype,
      'mod-tree-b': treeB.prototype,
      'stone-patch': {
        name: 'stone-patch',
        type: 'resource',
        mineable_properties: { products: [{ type: 'item', name: 'stone', amount: 1 }] },
      },
    },
  }
})

describe('product-oriented finite harvesting', () => {
  it('shares a bounded absent-source search with admission without mining or queuing work', () => {
    const f = fixture()
    f.rockA.valid = false; f.rockB.valid = false
    const before = f.manager.get_status_snapshot()
    expect(find_harvest_source(f.actor, natural_harvest_source_names('stone'), 64)).toBeUndefined()
    expect((f.actor.surface.find_entities_filtered as any).mock.calls.map((call: any[]) => call[0].radius)).toEqual([8, 16, 32, 64])
    expect((f.actor.surface.find_entities_filtered as any).mock.calls.every((call: any[]) => call[0].limit === 32)).toBe(true)
    expect(f.manager.get_status_snapshot()).toEqual(before)
    expect(f.actor.set_mining_state).not.toHaveBeenCalled()
  })

  it('shares exact-radius positive source selection and excludes player-touched sources', () => {
    const f = fixture()
    f.rockA.position.x = 3
    const names = natural_harvest_source_names('stone')
    expect(find_harvest_source(f.actor, names, 1)).toBeUndefined()
    expect(find_harvest_source(f.actor, names, 2)).toBe(f.rockB)
    f.rockB.last_user = { index: 1 }
    expect(find_harvest_source(f.actor, names, 2)).toBeUndefined()
    expect(find_harvest_source(f.actor, names, 4)).toBe(f.rockA)
  })

  it('natural-only harvesting skips human-touched trees and rechecks ownership before mining', () => {
    const f = fixture()
    f.treeA.last_user = { valid: true, name: 'owner', index: 1 }
    // Keep the eligible tree distinct from the rock at the same fixture x.
    // Exact native selection must resolve to the tree, rather than a neighbour.
    f.treeB.position.y = 0.5
    expect(f.harvest.submit('wood', 1, 64)[0]).toBe(true)
    f.harvest.tick(f.actor)
    expect(f.manager.player_state.parameters_harvest_product?.target).toBe(f.treeB)
    expect(f.actor.set_mining_state).not.toHaveBeenCalledWith({ mining: true, position: f.treeA.position })
    f.treeB.force = { name: 'player' }
    f.harvest.tick(f.actor)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: false })
    expect(f.manager.get_status_snapshot().last_cancelled_batch?.reason).toBe('harvest:no_target')
  })

  it('never offers a built entity as a harvest source, even when mining it yields the product', () => {
    const f = fixture()
    ;(globalThis as any).prototypes.item['stone-furnace'] = { name: 'stone-furnace' }
    ;(globalThis as any).prototypes.entity['stone-furnace'] = {
      name: 'stone-furnace',
      type: 'furnace',
      is_building: true,
      mineable_properties: { minable: true, mining_time: 0.2, products: [{ type: 'item', name: 'stone-furnace', amount: 1 }] },
    }
    expect(natural_harvest_source_names('stone-furnace')).toEqual([])
    expect(f.harvest.submit('stone-furnace', 1, 64)[0]).toBe(false)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
    expect(natural_harvest_source_names('stone')).toEqual(['mod-rock-a', 'mod-rock-b'])
    ;(globalThis as any).prototypes.entity['mod-placed-stone'] = {
      ...mineable('mod-placed-stone', 'simple-entity', 'stone', 1, 9).prototype,
      items_to_place_this: [{ name: 'stone', count: 1 }],
    }
    expect(natural_harvest_source_names('stone')).toEqual(['mod-rock-a', 'mod-rock-b'])
  })

  it('natural-only source guards refuse buildings, non-neutral assets and unreadable provenance', () => {
    const f = fixture()
    expect(is_unowned_natural_harvest_source(f.treeA)).toBe(true)
    expect(f.rockA.prototype.is_building).toBe(true)
    expect(is_unowned_natural_harvest_source(f.rockA)).toBe(true)
    f.treeA.prototype.is_building = true
    f.treeA.prototype.items_to_place_this = [{ name: 'mod-tree-a', count: 1 }]
    expect(is_unowned_natural_harvest_source(f.treeA)).toBe(false)
    f.treeA.prototype.items_to_place_this = undefined
    f.treeA.prototype.is_entity_with_owner = true
    expect(is_unowned_natural_harvest_source(f.treeA)).toBe(false)
    f.treeA.prototype.is_entity_with_owner = false
    f.treeA.prototype.is_building = false
    f.treeA.force = { name: 'player' }
    expect(is_unowned_natural_harvest_source(f.treeA)).toBe(false)
    f.treeA.force = { name: 'neutral' }
    ;(globalThis as any).pcall = () => [false, 'unsupported property']
    try { expect(is_unowned_natural_harvest_source(f.treeA)).toBe(false) }
    finally { delete (globalThis as any).pcall }
  })
  it('stops after one entity when its verified stone gain exceeds the requested quantity', () => {
    const f = fixture()
    expect(f.harvest.submit('stone', 6, 64)[0]).toBe(true)

    f.harvest.tick(f.actor)
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.rockA.position })

    f.setStone(20)
    f.rockA.valid = false
    f.harvest.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.manager.get_status_snapshot().last_completed_batch).toMatchObject({
      task_types: [TaskStates.HARVESTING],
    })
  })

  it('continues with another compatible rock prototype when the first source disappears', () => {
    const f = fixture()
    expect(f.harvest.submit('stone', 6, 64)[0]).toBe(true)

    f.harvest.tick(f.actor)
    f.setStone(4)
    f.rockA.valid = false
    f.harvest.tick(f.actor)

    expect(f.manager.player_state.parameters_harvest_product).toMatchObject({
      target_name: 'mod-rock-b',
      verified_gain: 4,
    })
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.rockB.position })

    f.setStone(8)
    f.rockB.valid = false
    f.harvest.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('builds one harvest set from multiple tree variants that yield wood', () => {
    const f = fixture()
    f.rockA.valid = false
    f.rockB.valid = false
    expect(f.harvest.submit('wood', 4, 64)[0]).toBe(true)

    expect(f.manager.player_state.parameters_harvest_product?.source_names).toEqual(['mod-tree-a', 'mod-tree-b'])
    f.harvest.tick(f.actor)
    f.setWood(2)
    f.treeA.valid = false
    f.harvest.tick(f.actor)

    expect(f.manager.player_state.parameters_harvest_product).toMatchObject({
      target_name: 'mod-tree-b',
      verified_gain: 2,
    })
  })

  it('ignores a connected-player mining event for a different harvest source identity', () => {
    const f = fixture()
    ;(f.actor as any).owns_player_index = () => true
    expect(f.harvest.submit('stone', 6, 64)[0]).toBe(true)
    f.harvest.tick(f.actor)

    expect(f.manager.player_state.parameters_harvest_product?.target).toBe(f.rockA)
    f.harvest.on_player_mined_entity(f.actor, 1, f.rockB)
    expect(f.manager.player_state.parameters_harvest_product?.target).toBe(f.rockA)

    f.harvest.on_player_mined_entity(f.actor, 1, f.rockA)
    expect(f.manager.player_state.parameters_harvest_product?.target).toBeNull()
  })

  it('uses verified inventory delta rather than destroyed entity count for completion', () => {
    const f = fixture()
    f.setStone(5)
    expect(f.harvest.submit('stone', 4, 64)[0]).toBe(true)

    f.harvest.tick(f.actor)
    f.rockA.valid = false
    f.harvest.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.HARVESTING)
    expect(f.manager.player_state.parameters_harvest_product?.verified_gain).toBe(0)

    f.setStone(9)
    f.harvest.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('uses finite-mining reach for harvest sources and resumes the same source after approach', () => {
    const f = fixture()
    f.rockA.position.x = 8
    f.rockB.valid = false
    expect(f.harvest.submit('stone', 1, 64)[0]).toBe(true)

    f.harvest.tick(f.actor)
    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 8, y: 0 },
      reach_distance: 2.45,
    })

    ;(f.actor.position as any).x = 6.5
    f.manager.reset_task_state()
    f.manager.next_task()
    f.harvest.tick(f.actor)

    expect(f.manager.player_state.parameters_harvest_product?.target).toBe(f.rockA)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: true, position: f.rockA.position })
  })

  it('recovers from an exact-selection miss by approaching closer instead of cancelling harvest', () => {
    const f = fixture()
    f.rockB.valid = false
    ;(f.actor as any).update_selected_entity = vi.fn(() => {
      ;(f.actor.character as any).selected = undefined
    })
    expect(f.harvest.submit('stone', 1, 64)[0]).toBe(true)

    f.harvest.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state.parameters_walk_to_entity).toMatchObject({
      target_kind: 'position',
      requested_position: { x: 1, y: 0 },
      reach_distance: 0.5,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.HARVESTING],
    })
  })

  it.each(['exact_selection_unavailable', 'native_mining_start_rejected', 'mining_stopped_before_gain'])(
    'records the actual harvest rejection phase: %s', reason => {
    const trace = vi.spyOn(globalThis, 'log')
      const f = fixture()
      f.rockB.valid = false
      if (reason === 'exact_selection_unavailable') vi.mocked(f.actor.update_selected_entity).mockImplementation(() => {
        ;(f.actor.character as any).selected = f.treeA
      })
      else if (reason === 'native_mining_start_rejected') vi.mocked(f.actor.get_mining_state).mockReturnValue({ mining: false })
      expect(f.harvest.submit('stone', 1, 64)[0]).toBe(true)
      f.harvest.tick(f.actor)
      if (reason === 'mining_stopped_before_gain') {
        vi.mocked(f.actor.get_mining_state).mockReturnValue({ mining: false })
        f.harvest.tick(f.actor)
      }
      expect(trace).toHaveBeenCalledWith(expect.stringContaining(`harvest.mining_rejected reason=${reason}`))
      expect(trace).toHaveBeenCalledWith(expect.stringContaining('batch_ref=batch-g1-1'))
    trace.mockRestore()
  })

  it('stops before a tick of mining if native exact selection changes on mining start', () => {
    const f = fixture()
    f.rockB.valid = false
    f.rockA.surface = f.actor.surface
    f.rockA.selection_box = { left_top: { x: 0.5, y: -0.5 }, right_bottom: { x: 1.5, y: 0.5 } }
    vi.mocked(f.actor.update_selected_entity).mockImplementation(() => { (f.actor.character as any).selected = f.treeA })
    vi.mocked(f.actor.set_mining_state).mockImplementation(state => {
      if (state.mining) (f.actor.character as any).selected = f.treeA
    })
    expect(f.harvest.submit('stone', 1, 64)[0]).toBe(true)
    f.harvest.tick(f.actor)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: false })
    expect(f.manager.get_status_snapshot().last_cancelled_batch?.reason).toBe('harvest:exact_selection_changed_on_start')
    expect(f.rockA.valid).toBe(true)
    expect(f.treeA.valid).toBe(true)
  })

  it('excludes ordinary resource patches from the harvest source set', () => {
    const f = fixture()
    expect(f.harvest.submit('stone', 1, 64)[0]).toBe(true)
    expect(f.manager.player_state.parameters_harvest_product?.source_names).toEqual(['mod-rock-a', 'mod-rock-b'])
  })
})
