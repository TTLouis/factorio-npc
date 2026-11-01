import type { LuaLogisticCell, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { describe, expect, it, vi } from 'vitest'
import { compact_construction_fulfillment, inspect_construction_fulfillment } from './construction_fulfillment'

function make_network({ mobile = false, all = 4, available = 2, items = 10, id = 1 } = {}) {
  const cell = {
    valid: true,
    mobile,
    transmitting: true,
    construction_radius: 30,
    stationed_construction_robot_count: all,
    is_in_construction_range: vi.fn(() => true),
  } as unknown as LuaLogisticCell
  const network = {
    valid: true,
    network_id: id,
    all_construction_robots: all,
    available_construction_robots: available,
    robot_limit: 25,
    cells: [cell],
    get_item_count: vi.fn(() => items),
  } as unknown as LuaLogisticNetwork
  ;(cell as any).logistic_network = network
  return network
}

function make_surface(networks: LuaLogisticNetwork[] = []) {
  return {
    index: 1,
    name: 'nauvis',
    find_logistic_networks_by_construction_area: vi.fn(() => networks),
  } as unknown as LuaSurface
}

function make_actor(surface: LuaSurface, options: { personal?: LuaLogisticCell, inventory?: number, position?: { x: number, y: number }, dispatch?: boolean } = {}) {
  const inventory = options.inventory ?? 10
  return {
    is_valid: true,
    surface,
    position: options.position ?? { x: 0, y: 0 },
    force: { index: 1 },
    character: {
      valid: true,
      logistic_cell: options.personal,
      allow_dispatching_robots: options.dispatch ?? true,
    },
    get_main_inventory: () => ({ get_item_count: () => inventory }),
  } as unknown as ControlledActor
}

function personal_cell({ in_range = true, all = 3, available = 2, transmitting = true } = {}) {
  const network = make_network({ mobile: true, all, available, items: 999, id: 99 })
  const cell = (network as any).cells[0] as LuaLogisticCell
  ;(cell as any).transmitting = transmitting
  ;(cell as any).is_in_construction_range = vi.fn(() => in_range)
  return cell
}

const item = { name: 'assembling-machine-1', count: 1 }

describe('construction fulfillment resolver', () => {
  it('prefers ready fixed infrastructure without asking the model to reason about providers', () => {
    const surface = make_surface([make_network()])
    const result = inspect_construction_fulfillment(make_actor(surface), surface, { x: 5, y: 5 }, item)
    expect(result).toMatchObject({ status: 'ready', current_provider: 'fixed_network' })
  })

  it('uses an in-range personal roboport as a native mobile construction provider', () => {
    const surface = make_surface()
    const result = inspect_construction_fulfillment(
      make_actor(surface, { personal: personal_cell({ in_range: true }) }),
      surface,
      { x: 5, y: 5 },
      item,
    )
    expect(result).toMatchObject({
      status: 'ready',
      current_provider: 'personal_roboport',
      personal: { state: 'ready', target_in_range: true },
    })
  })

  it('reports out-of-range personal construction as a planning choice, not a hard failure', () => {
    const surface = make_surface()
    const result = inspect_construction_fulfillment(
      make_actor(surface, { personal: personal_cell({ in_range: false }), position: { x: 0, y: 0 } }),
      surface,
      { x: 40, y: 0 },
      item,
    )
    expect(result).toMatchObject({
      status: 'requires_planning',
      personal: {
        state: 'requires_actor_relocation',
        reason: 'target_out_of_range',
        actor_distance: 40,
      },
    })
  })

  it('checks carried construction items before proposing actor relocation', () => {
    const surface = make_surface()
    const result = inspect_construction_fulfillment(
      make_actor(surface, { personal: personal_cell({ in_range: false }), inventory: 0 }),
      surface,
      { x: 40, y: 0 },
      item,
    )
    expect(result).toMatchObject({ status: 'blocked', personal: { state: 'unavailable', reason: 'item_missing' } })
  })

  it('does not count a mobile personal network as fixed roboport infrastructure', () => {
    const personal = personal_cell({ in_range: true })
    const surface = make_surface([(personal as any).logistic_network])
    const result = inspect_construction_fulfillment(make_actor(surface, { personal }), surface, { x: 5, y: 5 }, item)
    expect(result.fixed.network_count).toBe(0)
    expect(result.current_provider).toBe('personal_roboport')
  })

  it('returns a compact model-facing view without raw networks or robot counters', () => {
    const surface = make_surface([make_network()])
    const result = compact_construction_fulfillment(
      inspect_construction_fulfillment(make_actor(surface), surface, { x: 5, y: 5 }, item),
    )
    expect(result.fixed).toEqual({ state: 'ready', reason: undefined })
    expect(result.personal).toHaveProperty('state')
    expect(result.personal).not.toHaveProperty('all_construction_robots')
    expect(result.fixed).not.toHaveProperty('networks')
  })
})
