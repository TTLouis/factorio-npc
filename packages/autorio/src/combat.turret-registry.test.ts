import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

function itemStack(name?: string, count = 0) {
  return { valid_for_read: !!name, name, count }
}

function inventory(items: any[] = []) {
  const value: any = items
  value.find_item_stack = vi.fn((name: string) => {
    const index = items.findIndex(item => item.valid_for_read && item.name === name && item.count > 0)
    return index >= 0 ? [items[index], index + 1] : [undefined, undefined]
  })
  value.remove = vi.fn(({ name, count }: { name: string, count: number }) => {
    const item = items.find(candidate => candidate.valid_for_read && candidate.name === name && candidate.count > 0)
    if (!item) return 0
    const removed = Math.min(item.count, count)
    item.count -= removed
    if (item.count <= 0) item.valid_for_read = false
    return removed
  })
  value.insert = vi.fn(({ name, count }: { name: string, count: number }) => {
    const existing = items.find(candidate => candidate.name === name)
    if (existing) existing.count += count
    else items.push(itemStack(name, count))
    return count
  })
  return value
}

function enemy(unit_number: number, x: number) {
  return {
    valid: true,
    name: 'biter-spawner',
    type: 'unit-spawner',
    unit_number,
    position: { x, y: 0 },
    health: 350,
  } as any
}

function turret(unit_number: number, position: { x: number, y: number }) {
  const ammo = inventory([])
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { ...position },
    get_inventory: vi.fn(() => ammo),
    destroy: vi.fn(),
  } as any
}

describe('combat encounter-owned turret registry', () => {
  it('keeps authoritative temporary-turret ownership across a cancelled combat batch and recovers it later', () => {
    const enemies = [enemy(90, 30), enemy(91, 40)]
    const main = inventory([itemStack('gun-turret', 2), itemStack('firearm-magazine', 80)])
    const created: any[] = []
    let nextPathId = 100
    const guns: any = [{ valid_for_read: true }]
    const magazines: any = [{ valid_for_read: true }]
    let miningState: any = { mining: false }
    const character: any = {
      health: 250,
      max_health: 250,
      selected_gun_index: 1,
      reach_distance: 8,
      prototype: {
        collision_box: [[-0.2, -0.2], [0.2, 0.2]],
        collision_mask: { layers: { player: true }, consider_tile_transitions: true },
      },
      can_shoot: vi.fn(() => false),
      get_inventory: vi.fn((index: unknown) => {
        if (index === (globalThis as any).defines.inventory.character_guns) return guns
        if (index === (globalThis as any).defines.inventory.character_ammo) return magazines
        return undefined
      }),
    }
    const surface: any = {
      find_entities_filtered: vi.fn((filter: any = {}) => filter.force === 'enemy' ? enemies : []),
      find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ ...position })),
      request_path: vi.fn(() => ++nextPathId),
      create_entity: vi.fn((args: any) => {
        const value = turret(500 + created.length, args.position)
        created.push(value)
        return value
      }),
    }
    const actor: any = {
      is_valid: true,
      character,
      position: { x: 0, y: 0 },
      surface,
      force: { index: 1 },
      status_snapshot: () => ({ kind: 'standalone_character', actor_id: 42 }),
      set_walking_state: vi.fn(),
      set_shooting_state: vi.fn(),
      update_selected_entity: vi.fn(),
      get_main_inventory: () => main,
      get_mining_state: vi.fn(() => miningState),
      set_mining_state: vi.fn((state: any) => { miningState = state }),
      entity_build_args: () => ({ force: actor.force }),
    }
    Object.defineProperty(character, 'position', { get: () => actor.position })
    const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
    const manager = new_task_manager(get_actor)
    const controller = new_combat_controller(get_actor, manager)

    controller.submit_clear(80)
    controller.tick(actor)
    actor.position = { x: 6, y: 0 }
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)

    expect(created).toHaveLength(2)
    expect(controller.status()).toMatchObject({
      encounter_owned_turret_count: 2,
      encounter_owned_turret_unit_numbers: [500, 501],
    })

    manager.cancel_all_tasks()
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)

    for (const hostile of enemies) hostile.valid = false
    controller.submit_clear(80)
    controller.tick(actor)

    ;(globalThis as any).game.tick += 120
    controller.tick(actor)

    expect(controller.status()).toMatchObject({
      combat_phase: 'cleanup',
      encounter_owned_turret_count: 2,
      encounter_owned_turret_unit_numbers: [500, 501],
    })
    expect(actor.set_mining_state).toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })
})
