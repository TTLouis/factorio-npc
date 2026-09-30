import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { state_moving_items, task_manager } from './control'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).storage.sgluna_actor_mode = 'player'
  task_manager.cancel_all_tasks()
})

function owned_move_task(overrides: Record<string, unknown> = {}) {
  return {
    type: TaskStates.MOVING_ITEMS,
    operation_id: 1,
    owner_actor_id: 1,
    owner_actor_kind: 'connected_player',
    owner_force_index: 1,
    item_name: 'iron-plate',
    entity_name: 'iron-chest',
    max_count: 5,
    to_entity: false,
    ...overrides,
  } as any
}

describe('Bug 3 (fixed): state_moving_items reports the actually-moved amount on pickup', () => {
  it('reports exactly what was moved when pulling items from a nearby entity', () => {
    const removed_from_entity = vi.fn(() => 5)
    const inserted_into_player = vi.fn(() => 5)

    const fake_inventory = {
      remove: removed_from_entity,
      insert: vi.fn(),
    }
    const fake_entity = {
      get_max_inventory_index: () => 1,
      get_inventory: (_index: number) => fake_inventory,
    }
    const fake_player_inventory = {
      can_insert: () => true,
      insert: inserted_into_player,
    }
    const fake_actor = {
      is_valid: true,
      character: { valid: true },
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [fake_entity] },
      force: { index: 1 },
      get_main_inventory: () => fake_player_inventory,
      status_snapshot: () => ({ actor_id: 1, kind: 'connected_player', valid: true, has_character: true }),
    } as unknown as ControlledActor

    task_manager.add_task(owned_move_task())

    const moved_total = state_moving_items(fake_actor)

    expect(removed_from_entity).toHaveBeenCalledTimes(1)
    expect(inserted_into_player).toHaveBeenCalledTimes(1)
    expect(moved_total).toBe(5)
  })

  it('reports only what was actually inserted when the actor inventory can only take part of it', () => {
    const fake_inventory = {
      remove: vi.fn(() => 5),
      insert: vi.fn(),
    }
    const fake_entity = {
      get_max_inventory_index: () => 1,
      get_inventory: (_index: number) => fake_inventory,
    }
    const fake_actor_inventory = {
      can_insert: () => true,
      insert: vi.fn(() => 3),
    }
    const fake_actor = {
      is_valid: true,
      character: { valid: true },
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [fake_entity] },
      force: { index: 1 },
      get_main_inventory: () => fake_actor_inventory,
      status_snapshot: () => ({ actor_id: 1, kind: 'connected_player', valid: true, has_character: true }),
    } as unknown as ControlledActor

    task_manager.add_task(owned_move_task())

    const moved_total = state_moving_items(fake_actor)

    expect(fake_inventory.insert).toHaveBeenCalledWith({ name: 'iron-plate', count: 2 })
    expect(moved_total).toBe(3)
  })
})

describe('Player-sourced completion events are gated by actor identity', () => {
  function connect_controlled_actor(index: number) {
    ;(globalThis as any).game.connected_players = [
      {
        valid: true,
        index,
        name: 'SGLuna',
        character: {},
        position: { x: 0, y: 0 },
        surface: { find_entities_filtered: () => [] },
        force: { index: 1 },
        crafting_queue: [],
        begin_crafting: () => {},
      },
    ]
  }

  function add_owned_mining(count: number) {
    task_manager.add_task({
      type: TaskStates.MINING,
      operation_id: 1,
      owner_actor_id: 1,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
      entity_name: 'iron-ore',
      count,
      requested_count: count,
      position: { x: 0, y: 0 },
    })
  }

  it('ignores a crafted-item event from a player_index that is not the controlled actor', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 5,
      crafted: 0,
    })

    const on_player_crafted_item = get_handler('on_player_crafted_item')
    on_player_crafted_item({ player_index: 2, item_stack: { name: 'iron-gear-wheel', count: 1 } })

    expect(task_manager.player_state.parameters_craft_item?.crafted).toBe(0)
  })

  it('does not let a controlled-player craft event bypass native queue/output verification', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 5,
      crafted: 0,
    })

    const on_player_crafted_item = get_handler('on_player_crafted_item')
    on_player_crafted_item({ player_index: 1, item_stack: { name: 'iron-gear-wheel', count: 1 } })

    expect(task_manager.player_state.parameters_craft_item?.crafted).toBe(0)
    expect(task_manager.player_state.task_state).toBe(TaskStates.CRAFTING)
  })

  it('ignores a mined-entity event from another player', () => {
    connect_controlled_actor(1)
    add_owned_mining(3)

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 2, entity: { name: 'iron-ore', position: { x: 0, y: 0 } } })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(3)
  })

  it('counts a mined-entity event from the controlled player', () => {
    connect_controlled_actor(1)
    add_owned_mining(3)

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1, entity: { name: 'iron-ore', position: { x: 0, y: 0 } } })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(2)
  })

  it('does not let an unrelated entity event advance exact-identity mining', () => {
    connect_controlled_actor(1)
    task_manager.add_task({
      type: TaskStates.MINING,
      operation_id: 1,
      owner_actor_id: 1,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
      target_unit_number: 91,
      count: 1,
      requested_count: 1,
      position: { x: 0, y: 0 },
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({
      player_index: 1,
      entity: { unit_number: 92, name: 'steel-chest', position: { x: 0, y: 0 } },
    })

    expect(task_manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(1)
  })

  it('does not let any LuaPlayer mining event advance an NPC task', () => {
    ;(globalThis as any).storage.sgluna_actor_mode = 'npc'
    const force = {
      name: 'player',
      index: 1,
      get_spawn_position: () => ({ x: 0, y: 0 }),
    }
    const character: Record<string, any> = {
      valid: true,
      unit_number: 42,
      position: { x: 0, y: 0 },
      force,
      mining_state: { mining: false },
      walking_state: { walking: false, direction: 'north' },
      shooting_state: { state: 'not_shooting', position: { x: 0, y: 0 } },
      crafting_queue: [],
      get_main_inventory: vi.fn(),
      get_craftable_count: vi.fn(() => 0),
      begin_crafting: vi.fn(),
      cancel_crafting: vi.fn(),
    }
    const surface = {
      name: 'nauvis',
      find_entities_filtered: vi.fn(() => []),
      find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
      create_entity: vi.fn(() => character),
      is_chunk_generated: vi.fn(() => true),
      request_to_generate_chunks: vi.fn(),
      force_generate_chunk_requests: vi.fn(),
    }
    character.surface = surface
    ;(globalThis as any).game.surfaces[1] = surface
    ;(globalThis as any).game.forces = { player: force }

    task_manager.add_task({
      type: TaskStates.MINING,
      operation_id: 1,
      owner_actor_id: 42,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      entity_name: 'iron-ore',
      count: 3,
      requested_count: 3,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1, entity: { name: 'iron-ore', position: { x: 0, y: 0 } } })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(3)
  })
})

describe('Bug 4 (fixed): ATTACKING is dispatched through the bounded combat controller', () => {
  function enemy(x: number) {
    return {
      valid: true,
      name: 'small-biter',
      unit_number: 88,
      position: { x, y: 0 },
      health: 15,
    }
  }

  function connect_player_seeing(entities: unknown[], can_shoot = false) {
    const weapon_slot = { valid_for_read: true }
    const character = {
      selected_gun_index: 1,
      can_shoot: vi.fn(() => can_shoot),
      get_inventory: vi.fn((index: unknown) => {
        if (index === (globalThis as any).defines.inventory.character_guns) return [weapon_slot]
        if (index === (globalThis as any).defines.inventory.character_ammo) return [weapon_slot]
        return undefined
      }),
    }
    const surface = { find_entities_filtered: vi.fn(() => entities) }
    const fake_player = {
      valid: true,
      index: 1,
      name: 'SGLuna',
      character,
      position: { x: 0, y: 0 },
      surface,
      force: { index: 1 },
      update_selected_entity: vi.fn(),
    }
    ;(globalThis as any).game.connected_players = [fake_player]
    return fake_player as any
  }

  function add_owned_attack(search_radius: number, target: any = null) {
    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius,
      target,
      owner_actor_id: 1,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
    })
  }

  it('completes the attack task instead of hanging when no enemy is found', () => {
    const on_tick = get_handler('on_tick')
    connect_player_seeing([])
    add_owned_attack(50)
    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('shoots the bound enemy while moving instead of freezing in melee range', () => {
    const on_tick = get_handler('on_tick')
    const target = enemy(5)
    const fake_player = connect_player_seeing([target], true)
    add_owned_attack(50)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.character.can_shoot).toHaveBeenCalledWith(target, target.position)
    expect(fake_player.shooting_state).toEqual({ state: 'shooting_selected', position: target.position })
    expect(fake_player.walking_state).toEqual({ walking: true, direction: 'west' })
    expect(fake_player.update_selected_entity).toHaveBeenCalledWith(target.position)
  })

  it('walks toward the bound enemy when Factorio reports it cannot yet be shot', () => {
    const on_tick = get_handler('on_tick')
    const target = enemy(100)
    const fake_player = connect_player_seeing([target], false)
    add_owned_attack(200)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.character.can_shoot).toHaveBeenCalledWith(target, target.position)
    expect(fake_player.walking_state).toEqual({ walking: true, direction: 'east' })
    expect(fake_player.shooting_state).toEqual({ state: 'not_shooting', position: fake_player.position })
  })

  it('completes the single-target task once its bound target is no longer valid', () => {
    const on_tick = get_handler('on_tick')
    const replacement = enemy(6)
    replacement.unit_number = 99
    const fake_player = connect_player_seeing([replacement])
    const dead_target = { ...enemy(5), valid: false }
    add_owned_attack(50, dead_target)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(fake_player.surface.find_entities_filtered).not.toHaveBeenCalled()
  })
})
