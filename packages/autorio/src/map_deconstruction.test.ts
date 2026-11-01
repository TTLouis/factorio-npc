import type { LuaEntity, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remember_entity_reference } from './entity_reference'
import { cancel_remote_deconstruction, inspect_remote_deconstruction, mark_remote_deconstruction } from './map_deconstruction'

function make_network(overrides: Partial<LuaLogisticNetwork> = {}) {
  return {
    valid: true,
    network_id: 3,
    all_construction_robots: 2,
    available_construction_robots: 1,
    ...overrides,
  } as unknown as LuaLogisticNetwork
}

function make_surface(networks: LuaLogisticNetwork[] = []) {
  return {
    index: 1,
    name: 'nauvis',
    valid: true,
    find_logistic_networks_by_construction_area: vi.fn(() => networks),
  } as unknown as LuaSurface
}

function make_actor(surface: LuaSurface, charted = true, visible = charted) {
  return {
    is_valid: true,
    surface,
    force: {
      index: 1,
      name: 'player',
      is_chunk_charted: vi.fn(() => charted),
      is_chunk_visible: vi.fn(() => visible),
    },
  } as unknown as ControlledActor
}

function make_entity(surface: LuaSurface) {
  let marked = false
  return {
    valid: true,
    unit_number: 42,
    name: 'assembling-machine-1',
    type: 'assembling-machine',
    position: { x: 64, y: 64 },
    surface,
    force: { index: 1, name: 'player' },
    to_be_deconstructed: vi.fn(() => marked),
    order_deconstruction: vi.fn(() => {
      marked = true
      return true
    }),
    cancel_deconstruction: vi.fn(() => {
      marked = false
    }),
  } as unknown as LuaEntity
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn()
})

describe('map remote deconstruction', () => {
  it('refuses to expose uncharted entities', () => {
    const surface = make_surface()
    const actor = make_actor(surface, false)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = inspect_remote_deconstruction(actor, 42)

    expect(result).toEqual({ ok: false, code: 'area_uncharted', unit_number: 42 })
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

  it('does not inspect network state for charted entities hidden by fog', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface, true, false)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = inspect_remote_deconstruction(actor, 42)

    expect(result).toEqual({ ok: false, code: 'area_not_visible', unit_number: 42 })
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

  it('reports robot dispatch readiness without claiming guaranteed completion', () => {
    const network = make_network()
    const surface = make_surface([network])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = inspect_remote_deconstruction(actor, 42)

    expect(result).toMatchObject({
      ok: true,
      execution_mode: 'remote',
      entity: { unit_number: 42, marked_for_deconstruction: false },
      construction: {
        dispatch_readiness: 'ready',
        network_count: 1,
        all_construction_robots: 2,
        available_construction_robots: 1,
        completion_guaranteed: false,
      },
    })
  })

  it('reports all-busy construction robots as queued and still remotely fulfillable', () => {
    const network = make_network({ available_construction_robots: 0 })
    const surface = make_surface([network])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = inspect_remote_deconstruction(actor, 42)

    expect(result).toMatchObject({
      ok: true,
      construction: {
        dispatch_readiness: 'queued_no_available_construction_robots',
        remotely_fulfillable: true,
      },
    })
  })

  it('marks an exact visible entity for robot deconstruction', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = mark_remote_deconstruction(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'deconstruction_marked',
      unit_number: 42,
      world_completion: 'pending_robot_fulfillment',
    })
    expect(entity.order_deconstruction).toHaveBeenCalledWith(actor.force)
    expect(entity.destroy).toBeUndefined()
  })

  it('allows marking without a network but reports the world action as blocked', () => {
    const surface = make_surface([])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = mark_remote_deconstruction(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'deconstruction_marked',
      world_completion: 'blocked',
      construction: { dispatch_readiness: 'blocked_no_construction_network' },
    })
  })

  it('cancels an existing remote deconstruction marker', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    ;(entity.order_deconstruction as any)(actor.force)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = cancel_remote_deconstruction(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'deconstruction_cancelled',
      unit_number: 42,
    })
    expect(entity.cancel_deconstruction).toHaveBeenCalledWith(actor.force)
  })

  it('rejects deconstructing another force but allows neutral entities', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const enemy = make_entity(surface)
    ;(enemy as any).force = { index: 2, name: 'enemy' }
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(enemy)

    expect(mark_remote_deconstruction(actor, 42)).toMatchObject({ accepted: false, code: 'wrong_force' })
    expect(cancel_remote_deconstruction(actor, 42)).toMatchObject({ accepted: false, code: 'wrong_force' })
    expect(enemy.order_deconstruction).not.toHaveBeenCalled()

    const wreck = make_entity(surface)
    ;(wreck as any).force = { index: 3, name: 'neutral' }
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(wreck)

    expect(mark_remote_deconstruction(actor, 42)).toMatchObject({ accepted: true, code: 'deconstruction_marked' })
  })

  it('marks a map-observed building the unit-number index does not cover', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const entity = make_entity(surface)
    remember_entity_reference(entity)
    ;(surface as any).find_entities_filtered = vi.fn(() => [entity])
    ;(globalThis as any).game.get_surface = vi.fn(() => surface)

    expect(mark_remote_deconstruction(actor, 42)).toMatchObject({ accepted: true, code: 'deconstruction_marked' })
  })
})

