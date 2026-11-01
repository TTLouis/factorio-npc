import type { LuaEntity, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { construction_intent, execute_prepared_remote_construction_plan, inspect_remote_construction, stage_remote_entity_ghost } from './map_construction'

function make_network(overrides: Partial<LuaLogisticNetwork> = {}) {
  return {
    valid: true,
    network_id: 7,
    all_construction_robots: 4,
    available_construction_robots: 2,
    get_item_count: vi.fn(() => 10),
    ...overrides,
  } as unknown as LuaLogisticNetwork
}

function make_surface(networks: LuaLogisticNetwork[] = []) {
  const surface: any = {
    index: 1,
    name: 'nauvis',
    valid: true,
    can_place_entity: vi.fn(() => true),
    find_logistic_networks_by_construction_area: vi.fn(() => networks),
    create_entity: vi.fn(),
  }
  return surface as LuaSurface
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

beforeEach(() => {
  ;(globalThis as any).game.get_surface = vi.fn()
  ;(globalThis as any).prototypes.item['assembling-machine-1'] = {}
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    items_to_place_this: [{ name: 'assembling-machine-1', count: 1 }],
  }
})

describe('map remote construction', () => {
  it('refuses construction knowledge outside charted map space', () => {
    const surface = make_surface()
    const actor = make_actor(surface, false)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 320, 320, 'assembling-machine-1')

    expect(result).toMatchObject({ ok: false, code: 'area_uncharted' })
    expect(surface.can_place_entity).not.toHaveBeenCalled()
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

  it('does not inspect collision or robot state in charted fog', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface, true, false)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({ ok: false, code: 'area_not_visible' })
    expect(surface.can_place_entity).not.toHaveBeenCalled()
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

  it('reports when a visible ghost is placeable but no construction network can fulfill it', () => {
    const surface = make_surface([])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1', 4)

    expect(result).toMatchObject({
      ok: true,
      execution_mode: 'remote',
      can_place_ghost: true,
      fulfillment: 'blocked_no_construction_network',
      remotely_fulfillable: false,
      network_count: 0,
    })
  })

  it('reports robot and item availability from construction networks', () => {
    const network = make_network()
    const surface = make_surface([network])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      ok: true,
      fulfillment: 'ready',
      remotely_fulfillable: true,
      all_construction_robots: 4,
      available_construction_robots: 2,
      available_construction_items: 10,
    })
    expect(network.get_item_count).toHaveBeenCalledWith('assembling-machine-1')
  })

  it('reports all-busy construction robots as queued rather than ready or blocked', () => {
    const network = make_network({ available_construction_robots: 0 })
    const surface = make_surface([network])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      ok: true,
      fulfillment: 'queued_no_available_construction_robots',
      remotely_fulfillable: true,
      all_construction_robots: 4,
      available_construction_robots: 0,
    })
  })

  it('stages a ghost without pretending the building is already complete', () => {
    const network = make_network()
    const surface = make_surface([network])
    const ghost = {
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 4,
    } as unknown as LuaEntity
    ;(surface.create_entity as any).mockReturnValue(ghost)
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = stage_remote_entity_ghost(actor, 1, 64, 64, 'assembling-machine-1', 4)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'ghost_staged',
      world_completion: 'pending_robot_fulfillment',
      construction: { remotely_fulfillable: true },
    })
    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'entity-ghost',
      inner_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      direction: 4,
      force: actor.force,
      raise_built: true,
    })
  })

  it('can stage a ghost even when fulfillment is blocked, and reports the blocker', () => {
    const surface = make_surface([])
    const ghost = {
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 0,
    } as unknown as LuaEntity
    ;(surface.create_entity as any).mockReturnValue(ghost)
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = stage_remote_entity_ghost(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'ghost_staged',
      world_completion: 'blocked',
      construction: { fulfillment: 'blocked_no_construction_network' },
    })
  })
  it('uses the shared placement-item alias for remote fulfillment', () => {
    ;(globalThis as any).prototypes.item['custom-assembler-kit'] = {}
    ;(globalThis as any).prototypes.entity['custom-assembler'] = {
      items_to_place_this: [{ name: 'custom-assembler-kit', count: 2 }],
    }
    const network = make_network()
    const surface = make_surface([network])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'custom-assembler')

    expect(result).toMatchObject({
      ok: true,
      construction_item: { name: 'custom-assembler-kit', count: 2 },
    })
    expect(network.get_item_count).toHaveBeenCalledWith('custom-assembler-kit')
  })

  it('fails closed for ambiguous or non-placeable remote entities before querying fulfillment', () => {
    ;(globalThis as any).prototypes.item['kit-a'] = {}
    ;(globalThis as any).prototypes.item['kit-b'] = {}
    ;(globalThis as any).prototypes.entity['ambiguous-entity'] = {
      items_to_place_this: [{ name: 'kit-a', count: 1 }, { name: 'kit-b', count: 1 }],
    }
    ;(globalThis as any).prototypes.entity['script-only-entity'] = { items_to_place_this: [] }
    const network = make_network()
    const surface = make_surface([network])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    expect(inspect_remote_construction(actor, 1, 64, 64, 'ambiguous-entity')).toMatchObject({
      ok: false,
      code: 'entity_not_bot_placeable',
      placement_item_error: 'ambiguous_placement_item',
    })
    expect(inspect_remote_construction(actor, 1, 64, 64, 'script-only-entity')).toMatchObject({
      ok: false,
      code: 'entity_not_bot_placeable',
      placement_item_error: 'not_item_placeable',
    })
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

})


it('rejects pump remote intents, direct ghosts and legacy tokens before collision or robot mutation', () => {
  ;(globalThis as any).prototypes.entity['test-pump'] = { type: 'offshore-pump' }
  const surface = make_surface([make_network()])
  const actor = make_actor(surface)
  actor.status_snapshot = () => ({ actor_id: 18 }) as any
  ;(globalThis as any).game.get_surface.mockReturnValue(surface)
  for (const prepare of [false, true]) expect(construction_intent(actor, 1, 1, 1, 'test-pump', 0, prepare)).toMatchObject({ ok: false, code: 'placement_candidate_required', execution: { prepared: false } })
  expect(stage_remote_entity_ghost(actor, 1, 1, 1, 'test-pump', 0)).toMatchObject({ accepted: false, code: 'placement_candidate_required' })
  ;(globalThis as any).storage.sgluna_validated_remote_construction_plan = { validation_id: 1, actor_id: 18, force_index: 1, surface_index: 1, created_tick: game.tick, x: 1, y: 1, entity_name: 'test-pump', direction: 0 }
  expect(execute_prepared_remote_construction_plan(actor, 1, 1)?.[0]).toBe(false)
  expect(surface.can_place_entity).not.toHaveBeenCalled()
  expect(surface.create_entity).not.toHaveBeenCalled()
})
