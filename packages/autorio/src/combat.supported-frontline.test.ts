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

function world() {
  let nextPathId = 100
  const nest: any = {
    valid: true,
    name: 'biter-spawner',
    type: 'unit-spawner',
    unit_number: 10,
    position: { x: 30, y: 0 },
    health: 350,
  }
  const enemies: any[] = [nest]
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
  const actor: any = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    force: { index: 1 },
    status_snapshot: () => ({ kind: 'standalone_character', actor_id: 42 }),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    update_selected_entity: vi.fn(),
    get_main_inventory: vi.fn(() => undefined),
    entity_build_args: () => ({ force: actor.force }),
  }
  Object.defineProperty(character, 'position', { get: () => actor.position })
  const surface: any = {
    find_entities_filtered: vi.fn((filter: any) => enemies.filter((entity) => {
      if (entity.valid === false || (entity.health !== undefined && entity.health <= 0)) return false
      if (filter.type && entity.type !== filter.type) return false
      if (filter.position && typeof filter.radius === 'number') {
        const dx = entity.position.x - filter.position.x
        const dy = entity.position.y - filter.position.y
        if (Math.sqrt(dx * dx + dy * dy) > filter.radius) return false
      }
      return true
    })),
    request_path: vi.fn(() => ++nextPathId),
  }
  actor.surface = surface
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_combat_controller(get_actor, manager)
  return { actor, character, nest, enemies, manager, controller }
}

function support(unit_number: number, position: { x: number, y: number }) {
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { ...position },
    prototype: { turret_range: 18 },
  } as any
}

function lockNestWithSupport(position = { x: 0, y: 0 }) {
  const c = world()
  c.controller.submit_clear(80)
  c.controller.tick(c.actor)
  const task = c.manager.player_state.parameters_attack_nearest_enemy as any
  const turret = support(500, position)
  task.encounter_owned_turrets = [turret]
  task.last_turret_position = { ...position }
  task.last_turret_unit_number = turret.unit_number
  return c
}

describe('supported clear-area frontline', () => {
  it('keeps pressure on the locked nest when a healthy actor has turret coverage on a non-panic mobile threat', () => {
    const c = lockNestWithSupport({ x: 0, y: 0 })
    c.enemies.push({
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 20,
      position: { x: 9, y: 0 },
      health: 15,
    })

    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    expect(c.controller.status()).toMatchObject({ target: { name: 'biter-spawner', unit_number: 10 } })
  })

  it('still preempts when a covered mobile threat reaches panic distance', () => {
    const c = lockNestWithSupport({ x: 0, y: 0 })
    c.enemies.push({
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 21,
      position: { x: 6, y: 0 },
      health: 15,
    })

    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    expect(c.controller.status()).toMatchObject({ target: { name: 'small-biter', unit_number: 21 } })
  })

  it('still preempts a nearby mobile threat that no owned turret can cover', () => {
    const c = lockNestWithSupport({ x: -11, y: 0 })
    c.enemies.push({
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 22,
      position: { x: 8, y: 0 },
      health: 15,
    })

    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    expect(c.controller.status()).toMatchObject({ target: { name: 'small-biter', unit_number: 22 } })
  })
})
