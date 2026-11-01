import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

function itemStack(name: string, count: number) {
  return { valid_for_read: true, name, count }
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
    if (existing) {
      existing.valid_for_read = true
      existing.count += count
    }
    else {
      items.push(itemStack(name, count))
    }
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
    prototype: { turret_range: 18 },
    get_inventory: vi.fn(() => ammo),
    destroy: vi.fn(),
  } as any
}

describe('combat support stage cap', () => {
  it('caps one placement stage at eight and opens another only when the active target leaves support coverage', () => {
    const enemies = Array.from({ length: 13 }, (_, index) => enemy(100 + index, 30 + index))
    const created: any[] = []
    const main = inventory([itemStack('gun-turret', 20), itemStack('firearm-magazine', 400)])
    const guns: any = [{ valid_for_read: true }]
    const magazines: any = [{ valid_for_read: true }]
    const character: any = {
      health: 250,
      max_health: 250,
      selected_gun_index: 1,
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
    let nextPathId = 1000
    const surface: any = {
      find_entities_filtered: vi.fn((filter: any = {}) => {
        let found = enemies.filter(entity => entity.valid !== false && entity.health > 0)
        if (filter.type !== undefined) found = found.filter(entity => entity.type === filter.type)
        return found
      }),
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
      entity_build_args: () => ({ force: actor.force }),
    }
    Object.defineProperty(character, 'position', { get: () => actor.position })
    const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
    const manager = new_task_manager(get_actor)
    const controller = new_combat_controller(get_actor, manager)

    controller.submit_clear(80)
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ initial_threat_score: 52, support_turret_budget: 8 })

    actor.position = { x: 6, y: 0 }
    for (let i = 0; i < 8; i++) {
      ;(globalThis as any).game.tick += 1
      controller.tick(actor)
    }

    expect(created).toHaveLength(8)
    expect(controller.status()).toMatchObject({
      encounter_owned_turret_count: 8,
      support_stage_batch_size: 8,
      support_stage_start_turret_count: 0,
      support_stage_target_turret_count: 8,
    })

    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(created).toHaveLength(8)

    actor.position = { x: 14, y: 0 }
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(created).toHaveLength(8)

    enemies[0].position = { x: 34, y: 0 }
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)

    expect(created).toHaveLength(9)
    expect(controller.status()).toMatchObject({
      encounter_owned_turret_count: 9,
      turrets_placed: 9,
      support_turret_budget: 8,
      support_stage_batch_size: 8,
      support_stage_start_turret_count: 8,
      support_stage_target_turret_count: 16,
    })
  })
})
