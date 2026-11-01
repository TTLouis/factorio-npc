import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_defense_controller } from './defense'

function equipment_inventory(items: Array<{ valid_for_read: boolean }>) {
  return items as any
}

function world(options: { kind?: string, enemy?: any, canShoot?: boolean, armed?: boolean } = {}) {
  const target = options.enemy === undefined
    ? {
        valid: true,
        name: 'small-biter',
        type: 'unit',
        unit_number: 77,
        position: { x: 8, y: 0 },
      }
    : options.enemy
  const weapon = { valid_for_read: options.armed !== false, prototype: { attack_parameters: { ammo_categories: ['bullet'] } } }
  const ammo = { valid_for_read: options.armed !== false, prototype: { ammo_category: { name: 'bullet' } } }
  const character: any = {
    valid: true,
    selected_gun_index: 1,
    can_shoot: vi.fn(() => options.canShoot !== false),
    get_inventory: vi.fn((kind: unknown) => {
      if (kind === (globalThis as any).defines.inventory.character_guns) return equipment_inventory([weapon])
      if (kind === (globalThis as any).defines.inventory.character_ammo) return equipment_inventory([ammo])
      return undefined
    }),
  }
  const surface: any = {
    find_nearest_enemy: vi.fn(() => target),
  }
  const set_shooting_state = vi.fn()
  const update_selected_entity = vi.fn()
  const actor: any = {
    is_valid: true,
    character,
    surface,
    force: { index: 1 },
    position: { x: 0, y: 0 },
    set_shooting_state,
    update_selected_entity,
    status_snapshot: () => ({
      kind: options.kind ?? 'standalone_character',
      valid: true,
      actor_id: 42,
      name: 'SGLuna',
      position: { x: 0, y: 0 },
      has_character: true,
    }),
  } as ControlledActor
  const controller = new_defense_controller(() => actor)
  return { actor, character, surface, target, controller, set_shooting_state, update_selected_entity }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('follow auto-defense controller', () => {
  it('fires at the nearest shootable enemy without taking over walking', () => {
    const actual = world()

    expect(actual.controller.tick(actual.actor)).toBe(true)
    expect(actual.surface.find_nearest_enemy).toHaveBeenCalledWith({
      position: actual.actor.position,
      max_distance: 24,
      force: actual.actor.force,
    })
    expect(actual.update_selected_entity).toHaveBeenCalledWith(actual.target.position)
    expect(actual.set_shooting_state).toHaveBeenCalledWith({ state: 'shooting_selected', position: actual.target.position })
    expect((actual.actor as any).set_walking_state).toBeUndefined()
    expect(actual.controller.status()).toMatchObject({ enabled: true, code: 'engaging', target_name: 'small-biter' })
  })

  it('stops firing when auto-defense is explicitly disabled', () => {
    const actual = world()

    expect(actual.controller.set_enabled(false)).toEqual([true, 'Auto-defense disabled'])
    expect(actual.controller.tick(actual.actor)).toBe(false)
    expect(actual.surface.find_nearest_enemy).not.toHaveBeenCalled()
    expect(actual.set_shooting_state).toHaveBeenCalledWith({ state: 'not_shooting', position: actual.actor.position })
    expect(actual.controller.status()).toMatchObject({ enabled: false, code: 'disabled' })
  })

  it('holds fire when no enemy is nearby', () => {
    const actual = world({ enemy: null })

    expect(actual.controller.tick(actual.actor)).toBe(false)
    expect(actual.controller.status()).toMatchObject({ enabled: true, code: 'idle' })
    expect(actual.set_shooting_state).toHaveBeenCalledWith({ state: 'not_shooting', position: actual.actor.position })
  })

  it('reports missing equipped weapon or ammo instead of inventing combat capability', () => {
    const actual = world({ armed: false })

    expect(actual.controller.tick(actual.actor)).toBe(false)
    expect(actual.controller.status()).toMatchObject({ enabled: true, code: 'no_weapon_or_ammo', target_name: 'small-biter' })
    expect(actual.character.can_shoot).not.toHaveBeenCalled()
  })

  it('never autonomously fights through a connected human actor', () => {
    const actual = world({ kind: 'connected_player' })

    expect(actual.controller.tick(actual.actor)).toBe(false)
    expect(actual.surface.find_nearest_enemy).not.toHaveBeenCalled()
    expect(actual.controller.status()).toMatchObject({ code: 'no_actor' })
  })
})
