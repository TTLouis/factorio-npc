import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

const LOCAL_SAFETY_WINDOW_TICKS = 120

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

function squaredDistance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function enemy(unit_number: number, type: 'unit' | 'unit-spawner', x: number, y = 0) {
  return {
    valid: true,
    name: type === 'unit' ? 'small-biter' : 'biter-spawner',
    type,
    unit_number,
    position: { x, y },
    health: type === 'unit' ? 15 : 350,
  } as any
}

function turret(unit_number: number, position = { x: 0, y: 0 }) {
  const ammo = inventory([])
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { ...position },
    get_inventory: vi.fn(() => ammo),
    destroy: vi.fn(),
    ammo,
  } as any
}

function world(initialEnemies: any[] = []) {
  let nextPathId = 100
  let miningState: any = { mining: false }
  const enemies = [...initialEnemies]
  const createdTurrets: any[] = []
  const main = inventory([])
  const guns: any = [{ valid_for_read: true }]
  const magazines: any = [{ valid_for_read: true }]
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
    find_entities_filtered: vi.fn((filter: any = {}) => {
      let found = enemies.filter(entity => entity.valid !== false && (entity.health === undefined || entity.health > 0))
      if (filter.force === 'enemy') found = found.filter(entity => entity.force === undefined || entity.force === 'enemy')
      if (filter.type !== undefined) found = found.filter(entity => entity.type === filter.type)
      if (filter.position && typeof filter.radius === 'number') {
        found = found.filter(entity => squaredDistance(entity.position, filter.position) <= filter.radius ** 2)
      }
      return found
    }),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ ...position })),
    request_path: vi.fn(() => ++nextPathId),
    create_entity: vi.fn((args: any) => {
      const created = turret(500 + createdTurrets.length, args.position)
      createdTurrets.push(created)
      return created
    }),
  }
  const identity = { kind: 'standalone_character', actor_id: 42 }
  const actor: any = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    status_snapshot: () => identity,
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
  return { actor, enemies, createdTurrets, character, main, surface, manager, controller }
}

function advance(c: ReturnType<typeof world>, ticks: number) {
  ;(globalThis as any).game.tick += ticks
  c.controller.tick(c.actor)
}

function stageTwoOwnedTurrets(c: ReturnType<typeof world>) {
  c.main.push(itemStack('gun-turret', 2), itemStack('firearm-magazine', 80))
  c.controller.submit_clear(80)
  c.controller.tick(c.actor)
  c.actor.position = { x: 6, y: 0 }
  advance(c, 1)
  advance(c, 1)
  expect(c.createdTurrets).toHaveLength(2)
}

describe('combat lifecycle regressions', () => {
  it('requires a deterministic local safety window before area_cleared handoff', () => {
    const c = world([])
    c.controller.submit_clear(40)

    c.controller.tick(c.actor)
    expect(c.manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety' })
    expect(c.controller.status().last_result).not.toMatchObject({ code: 'area_cleared' })

    advance(c, LOCAL_SAFETY_WINDOW_TICKS - 1)
    expect(c.manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    advance(c, 1)
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(c.controller.status()).toMatchObject({
      last_result: { code: 'area_cleared', completed: true },
    })
  })

  it('prioritizes an immediate threat around the NPC even when it is outside the original clear radius', () => {
    const staticTarget = enemy(80, 'unit-spawner', 10)
    const c = world([staticTarget])
    c.controller.submit_clear(20)
    c.controller.tick(c.actor)

    c.actor.position = { x: 100, y: 0 }
    staticTarget.valid = false
    c.enemies.push(enemy(81, 'unit', 104))
    advance(c, 1)

    expect(c.manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(c.controller.status().last_result).not.toMatchObject({ code: 'area_cleared' })

    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 81, name: 'small-biter' },
    })
  })

  it('keeps encounter-owned turrets while remaining static targets exist, then cleans them without touching a player turret', () => {
    const first = enemy(90, 'unit-spawner', 30)
    const second = enemy(91, 'unit-spawner', 40)
    const c = world([first, second])
    const playerTurret = turret(999, { x: 5, y: 5 })
    stageTwoOwnedTurrets(c)

    expect(c.controller.status()).toMatchObject({ encounter_owned_turret_count: 2 })
    first.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 91 },
      encounter_owned_turret_count: 2,
    })
    expect(c.actor.get_mining_state().mining).toBe(false)

    second.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', combat_safety_goal: 'cleanup', target: undefined })

    advance(c, LOCAL_SAFETY_WINDOW_TICKS)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'cleanup', target: undefined })
    expect(c.actor.set_mining_state).toHaveBeenCalledWith(expect.objectContaining({ mining: true }))

    c.createdTurrets[0].valid = false
    advance(c, 1)
    c.createdTurrets[1].valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'safety',
      encounter_owned_turret_count: 0,
      target: undefined,
    })
    expect(playerTurret.destroy).not.toHaveBeenCalled()
    for (const owned of c.createdTurrets) expect(owned.destroy).not.toHaveBeenCalled()
  })

  it('keeps fighting the current static encounter after a mobile preemption instead of cleaning support turrets early', () => {
    const first = enemy(90, 'unit-spawner', 30)
    const second = enemy(91, 'unit-spawner', 40)
    const c = world([first, second])
    stageTwoOwnedTurrets(c)

    const pursuer = enemy(92, 'unit', 8)
    c.enemies.push(pursuer)
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 92 },
      encounter_owned_turret_count: 2,
    })

    pursuer.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 90 },
      encounter_owned_turret_count: 2,
    })
    expect(c.actor.get_mining_state().mining).toBe(false)

    first.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 91 },
      encounter_owned_turret_count: 2,
    })

    second.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', combat_safety_goal: 'cleanup', target: undefined })
  })

  it('keeps panic-range mobile preemption ahead of a ready support placement', () => {
    const first = enemy(90, 'unit-spawner', 30)
    const c = world([first])
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 40))
    c.controller.submit_clear(80)
    c.controller.tick(c.actor)

    c.actor.position = { x: 6, y: 0 }
    c.enemies.push(enemy(91, 'unit', 12))
    advance(c, 1)

    expect(c.createdTurrets).toHaveLength(0)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 91 },
      encounter_owned_turret_count: 0,
    })
  })

  it('opens support staging after repeated mobile preemptions starve forward progress', () => {
    const first = enemy(90, 'unit-spawner', 18)
    const c = world([first])
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 40))
    c.controller.submit_clear(80)
    c.controller.tick(c.actor)

    const firstPursuer = enemy(91, 'unit', 6)
    c.enemies.push(firstPursuer)
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 91 },
      support_pressure_preemptions: 1,
      support_stage_started: false,
    })

    firstPursuer.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 90 } })

    const secondPursuer = enemy(92, 'unit', 6)
    c.enemies.push(secondPursuer)
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 92 },
      support_pressure_preemptions: 2,
      support_stage_started: false,
    })

    secondPursuer.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 90 } })

    advance(c, 1)
    expect(c.createdTurrets).toHaveLength(1)
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 90 },
      support_stage_started: true,
      support_pressure_preemptions: 2,
      encounter_owned_turret_count: 1,
    })
  })

  it('does not let distant mobile reinforcements starve the current static encounter', () => {
    const first = enemy(90, 'unit-spawner', 30)
    const second = enemy(91, 'unit-spawner', 40)
    const c = world([first, second])
    stageTwoOwnedTurrets(c)

    c.enemies.push(enemy(92, 'unit', 18))
    advance(c, 1)

    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 90 },
      encounter_owned_turret_count: 2,
    })
    expect(c.actor.get_mining_state().mining).toBe(false)
  })

  it('bounds close-threat retreat so a mobile preemption does not erase static-encounter progress', () => {
    const first = enemy(90, 'unit-spawner', 30)
    const second = enemy(91, 'unit-spawner', 40)
    const c = world([first, second])
    c.controller.submit_clear(80)
    c.controller.tick(c.actor)

    c.actor.position = { x: 6, y: 0 }
    c.surface.get_tile = vi.fn(() => ({ name: 'grass-1' }))
    c.character.can_shoot.mockReturnValue(true)
    const pursuer = enemy(92, 'unit', 14)
    c.enemies.push(pursuer)
    advance(c, 1)

    expect(c.controller.status()).toMatchObject({ target: { unit_number: 92 } })
    // Preemption binds the mobile target first; retreat planning starts on the
    // next tick so no stale static-target work leaks across the handoff.
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 92 }, path: { mode: 'retreat' } })
    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 6, y: 0 },
      goal: { x: 2, y: 0 },
      radius: 1.5,
    }))

    pursuer.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 90 }, combat_phase: 'engage' })
  })

  it('interrupts turret recovery when a mobile threat reappears and resumes cleanup only after safety is stable again', () => {
    const first = enemy(100, 'unit-spawner', 30)
    const c = world([first])
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 40))
    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    advance(c, 1)
    expect(c.createdTurrets).toHaveLength(1)

    first.valid = false
    advance(c, 1)
    advance(c, LOCAL_SAFETY_WINDOW_TICKS)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'cleanup' })

    const pursuer = enemy(101, 'unit', 8)
    c.enemies.push(pursuer)
    advance(c, 1)
    expect(c.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: false })
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 101 },
      encounter_owned_turret_count: 1,
    })

    pursuer.valid = false
    advance(c, 1)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', target: undefined })
    advance(c, LOCAL_SAFETY_WINDOW_TICKS)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'cleanup', encounter_owned_turret_count: 1 })
  })
})
