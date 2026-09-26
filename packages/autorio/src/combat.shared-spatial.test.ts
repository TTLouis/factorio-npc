import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).log = vi.fn()
})

function itemStack(name?: string, count = 0) {
  return { valid_for_read: !!name, name, count }
}

function inventory(items: any[] = []) {
  const value: any = items
  value.find_item_stack = vi.fn((name: string) => {
    const index = items.findIndex(item => item.valid_for_read && item.name === name)
    return index >= 0 ? [items[index], index + 1] : [undefined, undefined]
  })
  value.remove = vi.fn(({ name, count }: { name: string, count: number }) => {
    const item = items.find(candidate => candidate.valid_for_read && candidate.name === name)
    if (!item) return 0
    const removed = Math.min(item.count, count)
    item.count -= removed
    if (item.count <= 0) item.valid_for_read = false
    return removed
  })
  value.insert = vi.fn(({ count }: { count: number }) => count)
  return value
}

function world(targetType: 'unit' | 'unit-spawner' = 'unit') {
  let nextPathId = 200
  const target: any = {
    valid: true,
    name: targetType === 'unit' ? 'small-biter' : 'biter-spawner',
    type: targetType,
    unit_number: 88,
    position: { x: 30, y: 0 },
    health: 250,
  }
  const enemies: any[] = [target]
  const main = inventory([])
  const guns: any = [{ valid_for_read: true }]
  const magazines: any = [{ valid_for_read: true }]
  const character: any = {
    name: 'character',
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
  const surface: any = {
    name: 'nauvis',
    index: 1,
    find_entities_filtered: vi.fn(() => enemies.filter(entity => entity.valid !== false)),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ ...position })),
    can_place_entity: vi.fn(() => true),
    get_tile: vi.fn(() => ({ name: 'grass-1' })),
    request_path: vi.fn(() => ++nextPathId),
    create_entity: vi.fn(),
  }
  const identity = { kind: 'standalone_character', actor_id: 42 }
  const actor: any = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1, name: 'player' },
    status_snapshot: () => identity,
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
  return { actor, target, enemies, character, main, surface, manager, controller }
}

function waypoint(x: number, y = 0) {
  return { position: { x, y }, needs_destroy_to_reach: false }
}

describe('combat shared spatial navigation and placement', () => {
  it('pathfinds toward mobile enemies instead of walking directly at them', () => {
    const c = world('unit')
    c.controller.submit(80)
    c.controller.tick(c.actor)

    expect(c.surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: 30, y: 0 },
      radius: 2.5,
    }))
    expect(c.controller.status()).toMatchObject({ path: { mode: 'approach', attempts: 1 } })
  })

  it('repaths after about 1.5 seconds of zero physical displacement', () => {
    const c = world('unit-spawner')
    c.controller.submit(80)
    c.controller.tick(c.actor)
    const firstRequest = c.controller.status().path.request_id
    c.controller.on_path_finished({ id: firstRequest, path: [waypoint(10, 4), waypoint(20, 4)], try_again_later: false } as any)

    ;(globalThis as any).game.tick += 91
    c.controller.tick(c.actor)

    expect(c.surface.request_path).toHaveBeenCalledTimes(2)
    expect(c.controller.status()).toMatchObject({
      path: { attempts: 2, last_recovery_reason: 'physical_stuck' },
    })
  })

  it('uses shared spatial escape selection after repeated path failures', () => {
    const c = world('unit-spawner')
    c.target.position = { x: 40, y: 0 }
    c.controller.submit(80)
    c.controller.tick(c.actor)

    let requestId = c.controller.status().path.request_id
    c.controller.on_path_finished({ id: requestId, path: undefined, try_again_later: false } as any)
    ;(globalThis as any).game.tick += 30
    c.controller.tick(c.actor)

    requestId = c.controller.status().path.request_id
    c.controller.on_path_finished({ id: requestId, path: undefined, try_again_later: false } as any)
    ;(globalThis as any).game.tick += 30
    c.controller.tick(c.actor)

    const lastCall = c.surface.request_path.mock.calls.at(-1)?.[0]
    expect(lastCall.goal).not.toEqual(c.target.position)
    expect(c.controller.status()).toMatchObject({
      path: {
        attempts: 3,
        recovery_stage: 'escape',
        last_recovery_reason: 'unreachable',
      },
    })
    expect(c.controller.status().path.spatial_observation).toMatchObject({ ok: true })
  })

  it('routes support-turret placement through the shared placement planner', () => {
    const c = world('unit-spawner')
    c.main.push(itemStack('gun-turret', 1), itemStack('piercing-rounds-magazine', 20))
    const turretAmmo = inventory([])
    const turret: any = {
      valid: true,
      unit_number: 501,
      get_inventory: vi.fn(() => turretAmmo),
      destroy: vi.fn(),
    }
    c.surface.create_entity.mockReturnValue(turret)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    expect(c.surface.can_place_entity).toHaveBeenCalled()
    expect(c.surface.find_non_colliding_position).not.toHaveBeenCalled()
    expect(c.controller.status()).toMatchObject({
      turrets_placed: 1,
      last_turret_unit_number: 501,
      last_turret_placement_plan: { ok: true, entity_name: 'gun-turret' },
    })
  })

  it('reaches into turret range when staging stops short of the planned distance', () => {
    const c = world('unit-spawner')
    c.main.push(itemStack('gun-turret', 1), itemStack('piercing-rounds-magazine', 20))
    // Live pistol: range 15, so support must land within 12.5 of the nest.
    c.character.get_inventory(defines.inventory.character_guns)[0].prototype = { attack_parameters: { range: 15 } }
    const turret: any = { valid: true, unit_number: 502, get_inventory: vi.fn(() => inventory([])), destroy: vi.fn() }
    c.surface.create_entity.mockReturnValue(turret)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    // The live clear-area lane stopped 18.95 tiles out: a fixed 6-tile advance
    // leaves every whole-tile turret centre near its anchor out of range.
    c.actor.position = { x: 11.05, y: 1 }
    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    const placed = c.surface.create_entity.mock.calls.find(([args]: any[]) => args.name === 'gun-turret')?.[0]
    expect(placed).toBeDefined()
    expect(Math.hypot(placed.position.x - c.target.position.x, placed.position.y - c.target.position.y)).toBeLessThanOrEqual(12.5)
    expect(c.controller.status()).toMatchObject({ turrets_placed: 1, last_turret_unit_number: 502 })
  })
})
