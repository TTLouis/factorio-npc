import type { LuaEntity, LuaLogisticCell, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  construction_intent,
  execute_prepared_remote_construction_plan,
  stage_remote_entity_ghost,
} from './map_construction'

function make_surface() {
  const surface: any = {
    index: 1,
    name: 'nauvis',
    valid: true,
    can_place_entity: vi.fn(() => true),
    find_logistic_networks_by_construction_area: vi.fn(() => []),
    create_entity: vi.fn(),
  }
  return surface as LuaSurface
}

function personal_cell(in_range: boolean) {
  const cell: any = {
    valid: true,
    mobile: true,
    transmitting: true,
    construction_radius: 30,
    stationed_construction_robot_count: 3,
    is_in_construction_range: vi.fn(() => in_range),
  }
  const network: any = {
    valid: true,
    network_id: 99,
    all_construction_robots: 3,
    available_construction_robots: 2,
    robot_limit: 10,
    cells: [cell],
  }
  cell.logistic_network = network as LuaLogisticNetwork
  return cell as LuaLogisticCell
}

function make_actor(surface: LuaSurface, in_range: boolean, position = { x: 0, y: 0 }) {
  return {
    is_valid: true,
    surface,
    position,
    force: {
      index: 1,
      is_chunk_charted: vi.fn(() => true),
      is_chunk_visible: vi.fn(() => true),
    },
    character: {
      valid: true,
      logistic_cell: personal_cell(in_range),
      allow_dispatching_robots: true,
    },
    get_main_inventory: () => ({ get_item_count: () => 10 }),
    status_snapshot: () => ({ actor_id: 42 }),
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1000
  ;(globalThis as any).game.get_surface = vi.fn()
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    items_to_place_this: [{ name: 'assembling-machine-1', count: 1 }],
  }
})

describe('personal roboport map construction', () => {
  it('stages a remote ghost but reports that an out-of-range personal provider still needs planning', () => {
    const surface = make_surface()
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)
    const ghost = {
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 0,
    } as unknown as LuaEntity
    ;(surface.create_entity as any).mockReturnValue(ghost)

    const result = stage_remote_entity_ghost(make_actor(surface, false), 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      accepted: true,
      world_completion: 'requires_planning',
      construction: {
        current_fulfillment: 'requires_planning',
        fulfillment_capability: { personal: { state: 'requires_actor_relocation' } },
      },
    })
  })

  it('prepares an existing execute_construction_plan token without mutating the world', () => {
    const surface = make_surface()
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)
    const actor = make_actor(surface, true, { x: 64, y: 64 })

    const intent = construction_intent(actor, undefined, 64, 64, 'assembling-machine-1', 0, true)

    expect(intent).toMatchObject({
      ok: true,
      stageable: true,
      fulfillment: { status: 'ready', current_provider: 'personal_roboport' },
      execution: { prepared: true, placement_count: 1, operation: 'execute_construction_plan' },
    })
    expect(surface.create_entity).not.toHaveBeenCalled()
  })

  it('executes a prepared remote validation through native ghost staging', () => {
    const surface = make_surface()
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)
    const actor = make_actor(surface, true, { x: 64, y: 64 })
    ;(surface.create_entity as any).mockReturnValue({
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 0,
    } as LuaEntity)
    const intent = construction_intent(actor, undefined, 64, 64, 'assembling-machine-1', 0, true) as any

    expect(execute_prepared_remote_construction_plan(actor, intent.execution.validation_id, 1)).toEqual([
      true,
      'Remote ghost staged; world completion is pending_robot_fulfillment',
    ])
    expect(surface.create_entity).toHaveBeenCalledTimes(1)
  })
})
