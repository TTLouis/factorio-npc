import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'

const LOCAL_SAFETY_WINDOW_TICKS = 120

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).prototypes = {
    entity: {
      'gun-turret': { turret_range: 18 },
      'small-worm-turret': { attack_parameters: { range: 10 } },
      'medium-worm-turret': { attack_parameters: { range: 15 } },
      'big-worm-turret': { attack_parameters: { range: 20 } },
      'behemoth-worm-turret': { attack_parameters: { range: 30 } },
    },
  }
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

function enemy(unit_number: number, name: string, type: 'unit' | 'unit-spawner' | 'turret', x: number, attackRange?: number) {
  return {
    valid: true,
    name,
    type,
    unit_number,
    position: { x, y: 0 },
    health: type === 'unit' ? 30 : 350,
    prototype: attackRange === undefined ? undefined : { attack_parameters: { range: attackRange } },
  } as any
}

function makeTurret(unit_number: number, position: { x: number, y: number }) {
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

function world(initialEnemies: any[], turretCount = 0) {
  let nextPathId = 100
  let miningState: any = { mining: false }
  const enemies = [...initialEnemies]
  const createdTurrets: any[] = []
  const main = inventory([
    ...(turretCount > 0 ? [itemStack('gun-turret', turretCount), itemStack('firearm-magazine', turretCount * 40)] : []),
  ])
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
      if (filter.type !== undefined) found = found.filter(entity => entity.type === filter.type)
      if (filter.position && typeof filter.radius === 'number') {
        found = found.filter(entity => {
          const dx = entity.position.x - filter.position.x
          const dy = entity.position.y - filter.position.y
          return Math.sqrt(dx * dx + dy * dy) <= filter.radius
        })
      }
      return found
    }),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ ...position })),
    get_tile: vi.fn(() => ({ valid: true, collides_with: vi.fn(() => false) })),
    request_path: vi.fn(() => ++nextPathId),
    create_entity: vi.fn((args: any) => {
      const turret = makeTurret(500 + createdTurrets.length, args.position)
      createdTurrets.push(turret)
      return turret
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
  return { actor, character, controller, createdTurrets, enemies, main, manager, surface }
}

function tick(c: ReturnType<typeof world>, count = 1) {
  ;(globalThis as any).game.tick += count
  c.controller.tick(c.actor)
}

describe('sacrificial combat support frontline', () => {
  it('places a support turret between SGLuna and a static nest', () => {
    const nest = enemy(10, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)

    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position.x).toBeGreaterThan(c.actor.position.x)
    expect(c.createdTurrets[0].position.x).toBeLessThan(nest.position.x)
    expect(c.createdTurrets[0].position).toEqual({ x: 12, y: 0 })
  })

  it('uses each worm tier\'s own attack range and scans to at least twice that range', () => {
    const nest = enemy(15, 'biter-spawner', 'unit-spawner', 15)
    const smallOutside = enemy(16, 'small-worm-turret', 'turret', 21, 10)
    const behemothInside = enemy(17, 'behemoth-worm-turret', 'turret', 59, 30)
    const c = world([nest, smallOutside, behemothInside], 1)

    c.controller.submit_clear(20)
    c.controller.tick(c.actor)

    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 17, name: 'behemoth-worm-turret' },
    })

    behemothInside.valid = false
    tick(c)

    expect(c.controller.status().target).not.toMatchObject({ unit_number: 16 })
  })

  it('can discover and fund support for a worm outside the requested clear radius when it is within twice its attack range', () => {
    const worm = enemy(18, 'big-worm-turret', 'turret', 35, 20)
    const c = world([worm], 1)

    c.controller.submit_clear(10)
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', support_turret_budget: 0 })

    tick(c)
    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 18, name: 'big-worm-turret' },
      support_turret_budget: 2,
    })
  })

  it('establishes support for ranged mobile pressure outside panic distance', () => {
    const spitter = enemy(20, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)

    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position).toEqual({ x: 6, y: 0 })
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 20, name: 'medium-spitter' },
      support_stage_started: true,
      encounter_owned_turret_count: 1,
    })
  })

  it('retreats behind the support line instead of standing in front under ranged pressure', () => {
    const spitter = enemy(30, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)

    c.actor.position = { x: 10, y: 0 }
    tick(c)

    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 10, y: 0 },
      goal: { x: 3.5, y: 0 },
      radius: 1.5,
    }))
    expect(c.controller.status()).toMatchObject({
      path: { mode: 'retreat', target_position: { x: 3.5, y: 0 } },
    })
  })

  it('re-establishes destroyed support before blindly advancing when inventory permits', () => {
    const spitter = enemy(40, 'big-spitter', 'unit', 20)
    const c = world([spitter], 2)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)

    c.createdTurrets[0].valid = false
    tick(c)

    expect(c.createdTurrets).toHaveLength(2)
    expect(c.createdTurrets[1].position.x).toBeGreaterThan(c.actor.position.x)
    expect(c.controller.status()).toMatchObject({ encounter_owned_turret_count: 1, turrets_placed: 2 })
    expect(c.surface.request_path).not.toHaveBeenCalled()
  })

  it('opens a second support stage when the active swarm leaves current turret coverage without requiring stage spacing', () => {
    const spitter = enemy(45, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 2)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position).toEqual({ x: 6, y: 0 })

    c.actor.position = { x: 2, y: 0 }
    spitter.position = { x: 25, y: 0 }
    tick(c)

    expect(c.createdTurrets).toHaveLength(2)
    expect(c.createdTurrets[1].position).toEqual({ x: 8, y: 0 })
    expect(Math.abs(c.createdTurrets[1].position.x - c.createdTurrets[0].position.x)).toBeLessThan(3)
    expect(c.controller.status()).toMatchObject({
      support_stage_start_turret_count: 1,
      support_stage_target_turret_count: 2,
      encounter_owned_turret_count: 2,
    })
  })

  it('advances a stale support line into restaging range instead of retreating forever behind old turrets', () => {
    const nest = enemy(47, 'biter-spawner', 'unit-spawner', 20)
    const c = world([nest], 2)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)
    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position).toEqual({ x: 12, y: 0 })

    nest.position = { x: 40, y: 0 }
    tick(c)

    expect(c.createdTurrets).toHaveLength(1)
    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 6, y: 0 },
      goal: { x: 17, y: 0 },
      radius: 1.5,
    }))
    expect(c.controller.status()).toMatchObject({
      path: { mode: 'retreat', target_position: { x: 17, y: 0 } },
      encounter_owned_turret_count: 1,
    })
  })

  it('advances only to the protected rear point when ranged pressure is outside SGLuna weapon range, then resumes shooting', () => {
    const spitter = enemy(46, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 1)
    c.character.can_shoot.mockImplementation((_target: any, position: { x: number, y: number }) =>
      Math.abs(c.actor.position.x - position.x) <= 17)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)

    tick(c)
    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: 3.5, y: 0 },
      radius: 1.5,
    }))

    c.actor.position = { x: 3.5, y: 0 }
    tick(c)

    expect(c.actor.set_shooting_state).toHaveBeenLastCalledWith({
      state: (globalThis as any).defines.shooting.shooting_selected,
      position: { x: 20, y: 0 },
    })
    expect(c.actor.set_walking_state).toHaveBeenLastCalledWith({ walking: false, direction: 'north' })
  })

  it('preserves panic-range mobile preemption ahead of support placement', () => {
    const nest = enemy(50, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.enemies.push(enemy(51, 'small-biter', 'unit', 6))
    tick(c)

    expect(c.createdTurrets).toHaveLength(0)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 51, name: 'small-biter' } })

    tick(c)
    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: -6, y: 0 },
      radius: 1.5,
    }))
    expect(c.controller.status()).toMatchObject({ path: { mode: 'retreat', target_position: { x: -6, y: 0 } } })
  })

  it('kills a remaining worm in the clear area before collecting support even outside immediate worm threat range', () => {
    const nest = enemy(56, 'biter-spawner', 'unit-spawner', 30)
    const worm = enemy(57, 'small-worm-turret', 'turret', 50, 10)
    const c = world([nest, worm], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)
    expect(c.createdTurrets).toHaveLength(1)

    nest.valid = false
    tick(c)

    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 57, name: 'small-worm-turret' },
    })
    expect(c.actor.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })

  it('does not start support cleanup while a worm remains inside its doubled threat radius', () => {
    const nest = enemy(58, 'biter-spawner', 'unit-spawner', 30)
    const worm = enemy(59, 'medium-worm-turret', 'turret', 29, 15)
    worm.valid = false
    const c = world([nest, worm], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)
    expect(c.createdTurrets).toHaveLength(1)

    nest.valid = false
    tick(c)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', combat_safety_goal: 'cleanup' })

    worm.valid = true
    tick(c)

    expect(c.controller.status()).toMatchObject({
      combat_phase: 'engage',
      target: { unit_number: 59, name: 'medium-worm-turret' },
    })
    expect(c.actor.set_mining_state).not.toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })

  it('still recovers surviving encounter-owned support during cleanup', () => {
    const nest = enemy(60, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)
    expect(c.createdTurrets).toHaveLength(1)

    nest.valid = false
    tick(c)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', combat_safety_goal: 'cleanup' })

    tick(c, LOCAL_SAFETY_WINDOW_TICKS)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'cleanup', encounter_owned_turret_count: 1 })
    expect(c.actor.set_mining_state).toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })
})
