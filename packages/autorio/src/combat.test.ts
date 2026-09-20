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

function waypoint(x: number, y = 0) {
  return { position: { x, y }, needs_destroy_to_reach: false }
}

function world() {
  let nextPathId = 100
  const target: any = {
    valid: true,
    name: 'small-biter',
    type: 'unit',
    unit_number: 88,
    position: { x: 20, y: 0 },
    health: 15,
  }
  const enemies: any[] = [target]
  const gun = { valid_for_read: true }
  const ammo = { valid_for_read: true }
  const guns: any = [gun]
  const magazines: any = [ammo]
  const main = inventory([])
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
  const surface: any = {
    find_entities_filtered: vi.fn(() => enemies.filter(entity => entity.valid !== false && (entity.health === undefined || entity.health > 0))),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ x: position.x, y: position.y })),
    request_path: vi.fn(() => ++nextPathId),
    create_entity: vi.fn(),
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
    entity_build_args: () => ({ force: actor.force }),
  }
  Object.defineProperty(character, 'position', { get: () => actor.position })
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_combat_controller(get_actor, manager)
  return { actor, target, enemies, character, gun, ammo, guns, magazines, main, surface, identity, get_actor, manager, controller }
}

function makeTurret(unit_number: number, insertedAmmo?: number, position = { x: 0, y: 0 }) {
  const turretAmmo = inventory([])
  if (insertedAmmo !== undefined) turretAmmo.insert.mockReturnValue(insertedAmmo)
  const turret: any = {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { ...position },
    prototype: { turret_range: 18 },
    get_inventory: vi.fn(() => turretAmmo),
    destroy: vi.fn(),
  }
  return { turret, turretAmmo }
}

function stageSupport(c: ReturnType<typeof world>) {
  c.target.type = 'unit-spawner'
  c.target.name = 'biter-spawner'
  c.controller.submit_clear(80)
  c.controller.tick(c.actor)
  c.actor.position = { x: 6, y: 0 }
  ;(globalThis as any).game.tick += 1
  c.controller.tick(c.actor)
}

describe('bounded combat controller', () => {
  it('queues combat without selecting or damaging a target at admission', () => {
    const { surface, manager, controller } = world()
    expect(controller.submit(40)).toEqual([true, 'Combat task queued'])
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)
  })

  it('rejects malformed radius and missing actor without queueing work', () => {
    const { get_actor, manager, controller } = world()
    expect(controller.submit(0)).toEqual([false, 'invalid_radius'])
    expect(controller.submit(257)).toEqual([false, 'invalid_radius'])
    get_actor.mockReturnValue(undefined)
    expect(controller.submit(40)).toEqual([false, 'no_actor'])
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('fails a no-target one-shot task and cancels dependent work', () => {
    const { actor, enemies, manager, controller } = world()
    enemies.length = 0
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_target', accepted: false } })
  })

  it('converts the 1-based Factorio selected gun slot to the 0-based typed-factorio inventory view', () => {
    const { actor, manager, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(controller.status()).toMatchObject({ last_result: { code: 'started', accepted: true } })
  })

  it('kites a mobile enemy while shooting instead of stopping in melee range', () => {
    const { actor, target, character, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'not_shooting' }))

    actor.position = { x: 15, y: 0 }
    character.can_shoot.mockReturnValue(true)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(actor.update_selected_entity).toHaveBeenCalledWith(target.position)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith({ state: 'shooting_selected', position: target.position })
  })

  it('does not advance onto a nest once the selected weapon can fire at it', () => {
    const { actor, target, character, surface, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    character.can_shoot.mockReturnValue(true)
    controller.submit(40)
    controller.tick(actor)
    expect(surface.request_path).not.toHaveBeenCalled()
    expect(actor.set_walking_state).toHaveBeenLastCalledWith({ walking: false, direction: 'north' })
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith({ state: 'shooting_selected', position: target.position })
  })

  it('uses Factorio pathfinding from the real NPC position instead of walking straight into cliffs or water toward a nest', () => {
    const { actor, target, character, surface, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.position = { x: 30, y: 0 }
    character.can_shoot.mockReturnValue(false)

    controller.submit(40)
    controller.tick(actor)

    expect(surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: 30, y: 0 },
      radius: 8,
    }))
    expect(actor.set_walking_state).not.toHaveBeenCalledWith(expect.objectContaining({ walking: true }))
    const requestId = controller.status().path.request_id
    controller.on_path_finished({ id: requestId, path: [waypoint(0, 5), waypoint(15, 5)], try_again_later: false } as any)

    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
    expect(controller.status()).toMatchObject({ path: { mode: 'approach', attempts: 1, waypoints_remaining: 2 } })
  })

  it('bounds repeated no-path results and cancels dependent combat work with an explicit receipt', () => {
    const { actor, target, manager, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.position = { x: 40, y: 0 }
    controller.submit(80)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)

    for (let attempt = 1; attempt <= 4; attempt++) {
      const requestId = controller.status().path.request_id
      expect(requestId).toBeDefined()
      controller.on_path_finished({ id: requestId, path: undefined, try_again_later: false } as any)
      if (attempt < 4) {
        expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)
        ;(globalThis as any).game.tick += 30
        controller.tick(actor)
      }
    }

    expect(controller.status()).toMatchObject({ last_result: { code: 'path_unreachable', accepted: false } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
  })

  it('ignores a stale static-nest path after a mobile threat preempts the target', () => {
    const { actor, target, enemies, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.position = { x: 30, y: 0 }
    controller.submit_clear(80)
    controller.tick(actor)
    const staleRequest = controller.status().path.request_id

    enemies.push({
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 900,
      position: { x: 8, y: 0 },
      health: 15,
    })
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ target: { name: 'small-biter' }, path: { request_id: undefined, attempts: 0 } })

    controller.on_path_finished({ id: staleRequest, path: [waypoint(12, 6)], try_again_later: false } as any)
    expect(controller.status()).toMatchObject({ target: { name: 'small-biter' }, path: { waypoints_remaining: 0 } })
  })

  it('completes a one-shot task only after the acquired target is gone instead of retargeting forever', () => {
    const { actor, target, surface, manager, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    target.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect(controller.status()).toMatchObject({ last_result: { code: 'target_destroyed', completed: true } })
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('fails safely when weapon/ammo disappears and stops queued dependent work', () => {
    const { actor, ammo, manager, controller } = world()
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    ammo.valid_for_read = false
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_weapon_or_ammo' } })
    expect(manager.get_status_snapshot().queue_length).toBe(0)
    expect(actor.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: 'north' })
    expect(actor.set_shooting_state).toHaveBeenCalledWith({ state: 'not_shooting', position: actor.position })
  })

  it('fails if Factorio selects another slot that has no gun or matching ammo stack', () => {
    const { actor, character, manager, controller } = world()
    character.selected_gun_index = 2
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_weapon_or_ammo' } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
  })

  it.each(['actor', 'kind', 'force'] as const)('does not let a changed %s inherit combat', (change) => {
    const { actor, identity, controller } = world()
    controller.submit(40)
    if (change === 'actor') identity.actor_id = 99
    if (change === 'kind') identity.kind = 'connected_player'
    if (change === 'force') actor.force.index = 2
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'actor_changed', accepted: false } })
  })

  it('fails a chase that makes no positional progress for ten simulation seconds', () => {
    const { actor, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    ;(globalThis as any).game.tick += 601
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'stuck' } })
  })

  it('bounds a one-shot combat task to one simulation minute', () => {
    const { actor, character, controller } = world()
    character.can_shoot.mockReturnValue(true)
    controller.submit(40)
    controller.tick(actor)
    ;(globalThis as any).game.tick += 3601
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'timeout' } })
  })
})

describe('bounded area-clearing combat', () => {
  it('reacquires enemies until the bounded area is actually clear, then waits for stable local safety', () => {
    const { actor, target, enemies, manager, controller } = world()
    const second: any = {
      valid: true,
      name: 'biter-spawner',
      type: 'unit-spawner',
      unit_number: 99,
      position: { x: 30, y: 0 },
      health: 350,
    }
    enemies.push(second)

    expect(controller.submit_clear(80)).toEqual([true, 'Area-clear combat task queued'])
    controller.tick(actor)
    target.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ mode: 'clear_area', targets_destroyed: 1, target: { name: 'biter-spawner' } })

    second.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ combat_phase: 'safety', targets_destroyed: 2 })
    expect(controller.status().last_result).not.toMatchObject({ code: 'area_cleared' })
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    ;(globalThis as any).game.tick += 119
    controller.tick(actor)
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'area_cleared', completed: true, targets_destroyed: 2 } })
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('preempts a locked nest when a nearby mobile threat appears', () => {
    const { actor, target, enemies, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.unit_number = 90
    target.position = { x: 30, y: 0 }

    controller.submit_clear(80)
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ target: { name: 'biter-spawner', unit_number: 90 } })

    const spawned: any = {
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 91,
      position: { x: 8, y: 0 },
      health: 15,
    }
    enemies.push(spawned)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)

    expect(controller.status()).toMatchObject({ target: { name: 'small-biter', unit_number: 91 } })
    // Target handoff is atomic: movement toward/away from the new mobile target
    // starts on the following combat tick rather than continuing stale nest logic.
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
  })

  it('returns to the locked static encounter after a mobile preemption instead of chaining to distant units', () => {
    const { actor, target, enemies, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.unit_number = 92
    target.position = { x: 30, y: 0 }

    controller.submit_clear(80)
    controller.tick(actor)

    const immediate: any = {
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 93,
      position: { x: 8, y: 0 },
      health: 15,
    }
    const distant: any = {
      valid: true,
      name: 'medium-biter',
      type: 'unit',
      unit_number: 94,
      position: { x: 20, y: 0 },
      health: 75,
    }
    enemies.push(immediate, distant)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ target: { unit_number: 93 } })

    immediate.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)

    expect(controller.status()).toMatchObject({ target: { name: 'biter-spawner', unit_number: 92 } })
  })

  it('does not place the first support turret at the task origin and stages only after advancing toward a nest', () => {
    const c = world()
    c.target.type = 'unit-spawner'
    c.target.name = 'biter-spawner'
    c.target.position = { x: 30, y: 0 }
    c.main.push(itemStack('gun-turret', 2), itemStack('piercing-rounds-magazine', 50))
    const { turret } = makeTurret(500)
    c.surface.create_entity.mockReturnValue(turret)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.surface.create_entity).not.toHaveBeenCalled()
    expect(c.controller.status()).toMatchObject({
      initial_static_threats: 1,
      initial_threat_score: 4,
      support_turret_budget: 1,
      support_stage_started: false,
    })

    c.actor.position = { x: 6, y: 0 }
    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)
    expect(c.surface.create_entity).toHaveBeenCalledTimes(1)
    expect(c.controller.status()).toMatchObject({ support_stage_started: true, turrets_placed: 1 })
  })

  it('refuses a turret candidate inside the NPC clearance zone instead of trapping the actor', () => {
    const c = world()
    c.target.type = 'unit-spawner'
    c.target.name = 'biter-spawner'
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 20))
    c.surface.find_non_colliding_position.mockImplementation(() => ({ x: c.actor.position.x, y: c.actor.position.y }))
    const { turret } = makeTurret(501)
    c.surface.create_entity.mockReturnValue(turret)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)

    expect(c.surface.create_entity).not.toHaveBeenCalled()
    expect(c.controller.status()).toMatchObject({ turrets_placed: 0, support_stage_started: true })
  })

  it('scales support budget with enemy count and tier, capped at eight turrets', () => {
    const c = world()
    c.enemies.length = 0
    c.enemies.push(
      { valid: true, name: 'biter-spawner', type: 'unit-spawner', unit_number: 600, position: { x: 30, y: 0 }, health: 350 },
      { valid: true, name: 'medium-biter', type: 'unit', unit_number: 601, position: { x: 34, y: 1 }, health: 75 },
      { valid: true, name: 'big-spitter', type: 'unit', unit_number: 602, position: { x: 36, y: -1 }, health: 200 },
      { valid: true, name: 'behemoth-worm-turret', type: 'turret', unit_number: 603, position: { x: 38, y: 2 }, health: 750 },
    )

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({
      initial_static_threats: 2,
      initial_threat_score: 18,
      support_turret_budget: 5,
    })

    c.enemies.length = 0
    for (let i = 0; i < 8; i++) {
      c.enemies.push({
        valid: true,
        name: 'behemoth-worm-turret',
        type: 'turret',
        unit_number: 700 + i,
        position: { x: 30 + i, y: i },
        health: 750,
      })
    }
    const c2 = world()
    c2.enemies.length = 0
    c2.enemies.push(...c.enemies)
    c2.controller.submit_clear(80)
    c2.controller.tick(c2.actor)
    expect(c2.controller.status()).toMatchObject({ initial_threat_score: 64, support_turret_budget: 8 })
  })

  it('deploys a threat-sized support batch without restaging merely because AIRI advances', () => {
    const c = world()
    c.enemies.length = 0
    for (let i = 0; i < 5; i++) {
      c.enemies.push({
        valid: true,
        name: i % 2 === 0 ? 'biter-spawner' : 'small-worm-turret',
        type: i % 2 === 0 ? 'unit-spawner' : 'turret',
        unit_number: 800 + i,
        position: { x: 30 + i * 2, y: i },
        health: 350,
      })
    }
    c.main.push(itemStack('gun-turret', 8), itemStack('piercing-rounds-magazine', 200))
    let nextTurret = 900
    c.surface.create_entity.mockImplementation(({ position }: { position: { x: number, y: number } }) => makeTurret(nextTurret++, undefined, position).turret)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ initial_threat_score: 16, support_turret_budget: 4, turrets_placed: 0 })

    c.actor.position = { x: 6, y: 0 }
    for (let i = 0; i < 3; i++) {
      ;(globalThis as any).game.tick += 1
      c.controller.tick(c.actor)
    }
    expect(c.surface.create_entity).toHaveBeenCalledTimes(3)
    expect(c.controller.status()).toMatchObject({
      support_stage_anchor_position: { x: 6, y: 0 },
      support_stage_start_turret_count: 0,
      support_stage_target_turret_count: 3,
      encounter_owned_turret_count: 3,
    })

    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)
    expect(c.surface.create_entity).toHaveBeenCalledTimes(3)

    c.actor.position = { x: 14, y: 0 }
    ;(globalThis as any).game.tick += 1
    c.controller.tick(c.actor)
    expect(c.surface.create_entity).toHaveBeenCalledTimes(3)

    expect(c.controller.status()).toMatchObject({ support_turret_budget: 4, turrets_placed: 3, encounter_owned_turret_count: 3 })
  })

  it('places and loads a paid gun turret only after support staging is established', () => {
    const c = world()
    c.main.push(itemStack('gun-turret', 2), itemStack('piercing-rounds-magazine', 50))
    const { turret, turretAmmo } = makeTurret(510)
    c.surface.create_entity.mockReturnValue(turret)
    c.character.can_shoot.mockReturnValue(false)

    stageSupport(c)

    expect(c.surface.create_entity).toHaveBeenCalledWith(expect.objectContaining({ name: 'gun-turret' }))
    expect(turret.get_inventory).toHaveBeenCalledWith('turret_ammo')
    expect(c.main.remove).toHaveBeenCalledWith({ name: 'gun-turret', count: 1 })
    expect(c.main.remove).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 20 })
    expect(turretAmmo.insert).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 20 })
    expect(c.controller.status()).toMatchObject({
      mode: 'clear_area',
      turrets_placed: 1,
      support_turret_budget: 1,
      last_turret_unit_number: 510,
      turret_ammo_name: 'piercing-rounds-magazine',
      last_turret_ammo_loaded: 20,
    })
  })

  it('destroys an unpayable scripted turret instead of granting a free support entity', () => {
    const c = world()
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 20))
    const { turret } = makeTurret(502)
    c.surface.create_entity.mockReturnValue(turret)
    c.character.can_shoot.mockReturnValue(false)
    c.main.remove.mockImplementation(({ name, count }: { name: string, count: number }) => name === 'gun-turret' ? 0 : count)

    stageSupport(c)

    expect(turret.destroy).toHaveBeenCalledTimes(1)
    expect(c.controller.status()).toMatchObject({ turrets_placed: 0 })
    expect(c.controller.status().last_turret_unit_number).toBeUndefined()
  })

  it('returns the paid turret item when ammunition cannot be removed', () => {
    const c = world()
    c.main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 20))
    const { turret } = makeTurret(503)
    c.surface.create_entity.mockReturnValue(turret)
    c.character.can_shoot.mockReturnValue(false)
    const realRemove = c.main.remove.getMockImplementation()!
    c.main.remove.mockImplementation((args: { name: string, count: number }) => args.name === 'firearm-magazine' ? 0 : realRemove(args))

    stageSupport(c)

    expect(c.main.insert).toHaveBeenCalledWith({ name: 'gun-turret', count: 1 })
    expect(turret.destroy).toHaveBeenCalledTimes(1)
    expect(c.controller.status()).toMatchObject({ turrets_placed: 0 })
  })

  it('returns ammunition the turret could not accept and records only the amount actually loaded', () => {
    const c = world()
    c.main.push(itemStack('gun-turret', 1), itemStack('piercing-rounds-magazine', 20))
    const { turret } = makeTurret(504, 5)
    c.surface.create_entity.mockReturnValue(turret)
    c.character.can_shoot.mockReturnValue(false)

    stageSupport(c)

    expect(c.main.insert).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 15 })
    expect(turret.destroy).not.toHaveBeenCalled()
    expect(c.controller.status()).toMatchObject({
      turrets_placed: 1,
      last_turret_unit_number: 504,
      turret_ammo_name: 'piercing-rounds-magazine',
      last_turret_ammo_loaded: 5,
    })
  })

  it('keeps healthy mobile kiting bounded instead of pulling back to a support turret', () => {
    const { actor, target, character, manager, surface, controller } = world()
    controller.submit_clear(80)
    const task = manager.player_state.parameters_attack_nearest_enemy!
    const support = makeTurret(520, undefined, { x: -10, y: 0 }).turret
    task.last_turret_position = { x: -10, y: 0 }
    ;(task as any).encounter_owned_turrets = [support]
    task.turrets_placed = 1
    character.can_shoot.mockReturnValue(true)
    actor.position = { x: 15, y: 0 }
    target.position = { x: 20, y: 0 }

    controller.tick(actor)
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'shooting_selected' }))
    expect(surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      start: { x: 15, y: 0 },
      goal: { x: 8, y: 0 },
      radius: 1.5,
    }))
    expect(surface.request_path).not.toHaveBeenCalledWith(expect.objectContaining({ goal: { x: -10, y: 0 } }))
    expect(controller.status()).toMatchObject({ path: { mode: 'retreat', attempts: 1, target_position: { x: 8, y: 0 } } })

    const requestId = controller.status().path.request_id
    controller.on_path_finished({ id: requestId, path: [waypoint(12, 4), waypoint(8, 0)], try_again_later: false } as any)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'shooting_selected' }))
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
  })

  it('low health retreats only far enough to enter a live support turret firing envelope', () => {
    const { actor, target, character, manager, surface, controller } = world()
    character.health = 50
    character.max_health = 250
    character.can_shoot.mockReturnValue(false)
    controller.submit_clear(80)
    const task = manager.player_state.parameters_attack_nearest_enemy!
    const support = makeTurret(530, undefined, { x: 0, y: 0 }).turret
    task.last_turret_position = { x: 0, y: 0 }
    ;(task as any).encounter_owned_turrets = [support]
    task.turrets_placed = 1
    actor.position = { x: 25, y: 0 }
    target.position = { x: 30, y: 0 }

    controller.tick(actor)

    expect(surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      start: { x: 25, y: 0 },
      goal: { x: 16, y: 0 },
      radius: 1.5,
    }))
    expect(surface.request_path).not.toHaveBeenCalledWith(expect.objectContaining({ goal: { x: 0, y: 0 } }))
    expect(controller.status()).toMatchObject({ path: { mode: 'retreat', target_position: { x: 16, y: 0 } } })
    expect(controller.status().last_result).not.toMatchObject({ code: 'low_health' })
  })

  it('aborts instead of making a suicidal unsupported push at low health', () => {
    const { actor, character, manager, controller } = world()
    character.health = 50
    character.max_health = 250
    controller.submit_clear(80)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'low_health', accepted: false } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
  })
})
