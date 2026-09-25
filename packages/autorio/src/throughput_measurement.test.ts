import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { remember_entity_reference } from './entity_reference'
import { new_throughput_measurement_controller } from './throughput_measurement'

const originalPrototypes = (globalThis as any).prototypes
const originalGame = (globalThis as any).game
const originalDefines = (globalThis as any).defines

function fixture() {
  let held: any = { valid_for_read: false, count: 0 }
  let beltItems: any[] = []
  const force: any = {
    index: 1,
    inserter_stack_size_bonus: 3,
    bulk_inserter_capacity_bonus: 0,
    belt_stack_size_bonus: 2,
  }
  const inserter: any = {
    valid: true,
    name: 'fast-inserter',
    type: 'inserter',
    unit_number: 42,
    surface: { index: 1 },
    force,
    position: { x: 0, y: 0 },
    direction: 0,
    active: true,
    held_stack: held,
    inserter_stack_size_override: 0,
    inserter_target_pickup_count: 4,
    pickup_from_left_lane: true,
    pickup_from_right_lane: true,
    pickup_position: { x: 0, y: -1 },
    drop_position: { x: 0, y: 1 },
    pickup_target: { valid: true, name: 'iron-chest', type: 'container', unit_number: 41, position: { x: 0, y: -1 }, direction: 0 },
    drop_target: { valid: true, name: 'assembling-machine-1', type: 'assembling-machine', unit_number: 43, position: { x: 0, y: 1 }, direction: 0 },
  }
  const line: any = {
    valid: true,
    get_detailed_contents: () => beltItems,
    get_line_item_position: (position: number) => ({ x: position, y: 0 }),
  }
  const belt: any = {
    valid: true,
    name: 'transport-belt',
    type: 'transport-belt',
    unit_number: 55,
    surface: { index: 1 },
    force,
    direction: 4,
    position: { x: 0, y: 0 },
    get_max_transport_line_index: () => 2,
    get_transport_line: () => line,
  }
  const entities = new Map<number, any>([[42, inserter], [55, belt]])
  // Factorio 2.0 only indexes prototypes flagged get-by-unit-number, which
  // belts and inserters are not: the entities resolve through the hint an
  // observation records, then a search at that position.
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = {
    tick: 0,
    get_entity_by_unit_number: () => undefined,
  }
  const find_entities_filtered = (filter: any) => [...entities.values()].filter(entity =>
    entity.name === filter.name && entity.position.x === filter.position.x && entity.position.y === filter.position.y)
  for (const entity of entities.values()) remember_entity_reference(entity)
  const actor = {
    is_valid: true,
    force,
    surface: { index: 1, find_entities_filtered },
    status_snapshot: () => ({ actor_id: 9, kind: 'standalone_character' }),
  } as unknown as ControlledActor
  const controller = new_throughput_measurement_controller(() => actor)
  return {
    actor,
    force,
    inserter,
    entities,
    controller,
    setHeld(next: any) {
      held = next
      inserter.held_stack = next
    },
    setBeltItems(next: any[]) { beltItems = next },
    tick(value: number) {
      ;(globalThis as any).game.tick = value
      controller.tick()
    },
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).defines = { direction: { north: 0, east: 4, south: 8, west: 12 } }
  ;(globalThis as any).prototypes = {
    item: { 'iron-plate': { stack_size: 100 } },
    entity: {
      'fast-inserter': {
        name: 'fast-inserter',
        type: 'inserter',
        bulk: false,
        uses_inserter_stack_size_bonus: true,
        inserter_stack_size_bonus: 0,
        inserter_max_belt_stack_size: 1,
        get_inserter_rotation_speed: () => 0.1,
        get_inserter_extension_speed: () => 0.05,
      },
      'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 },
    },
  }
})

afterEach(() => {
  ;(globalThis as any).prototypes = originalPrototypes
  ;(globalThis as any).game = originalGame
  ;(globalThis as any).defines = originalDefines
})

describe('live throughput measurement', () => {
  it('measures delivered inserter flow and proves only the conservative observed lower bound', () => {
    const f = fixture()
    const started = f.controller.start({
      kind: 'inserter_instance',
      unit_number: 42,
      item_name: 'iron-plate',
      warmup_ticks: 0,
      window_ticks: 60,
      required_rate_per_second: 6,
      utilization_limit: 0.8,
    })
    expect(started).toMatchObject({ ok: true, state: 'running', measurement_id: 1 })
    if (!started.ok) return

    for (let tick = 1; tick <= 60; tick++) {
      ;(globalThis as any).game.tick = tick
      if (tick === 10 || tick === 40) f.setHeld({ valid_for_read: true, name: 'iron-plate', count: 4 })
      if (tick === 30 || tick === 60) f.setHeld({ valid_for_read: false, count: 0 })
      f.controller.tick()
    }

    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: true,
      state: 'complete',
      items_per_second: 8,
      validation: {
        conservative_usable_rate_per_second: 6.4,
        fits_observed_lower_bound: true,
        verdict: 'proven_sufficient',
      },
      inserter: {
        delivered_items: 8,
        max_hand_observed: 4,
        pickup_target: { unit_number: 41 },
        drop_target: { unit_number: 43 },
      },
    })
  })

  it('does not turn an underfed live sample into a false impossibility claim', () => {
    const f = fixture()
    const started = f.controller.start({
      kind: 'inserter_instance', unit_number: 42, warmup_ticks: 0, window_ticks: 60,
      required_rate_per_second: 10, utilization_limit: 0.8,
    })
    if (!started.ok) throw new Error('measurement did not start')
    for (let tick = 1; tick <= 60; tick++) {
      ;(globalThis as any).game.tick = tick
      if (tick === 10) f.setHeld({ valid_for_read: true, name: 'iron-plate', count: 4 })
      if (tick === 30) f.setHeld({ valid_for_read: false, count: 0 })
      f.controller.tick()
    }
    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: true,
      items_per_second: 4,
      validation: { fits_observed_lower_bound: false, verdict: 'not_proven' },
    })
  })

  it('fails a running sample when research changes and invalidates the measurement context', () => {
    const f = fixture()
    const started = f.controller.start({ kind: 'inserter_instance', unit_number: 42, warmup_ticks: 0, window_ticks: 60 })
    if (!started.ok) throw new Error('measurement did not start')
    f.tick(1)
    f.force.inserter_stack_size_bonus = 4
    f.tick(2)
    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: false,
      state: 'failed',
      error: { code: 'STALE_CONTEXT' },
    })
  })

  it('counts actual belt-lane stack crossings instead of assuming researched stacking is present', () => {
    const f = fixture()
    const started = f.controller.start({
      kind: 'belt_lane', unit_number: 55, lane_index: 1, item_name: 'iron-plate',
      warmup_ticks: 0, window_ticks: 60, required_rate_per_second: 4,
      utilization_limit: 0.8, required_stack_size: 3,
    })
    if (!started.ok) throw new Error('measurement did not start')

    for (let tick = 1; tick <= 60; tick++) {
      ;(globalThis as any).game.tick = tick
      if (tick === 10) f.setBeltItems([{ unique_id: 1, position: -0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 3 } }])
      if (tick === 11) f.setBeltItems([{ unique_id: 1, position: 0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 3 } }])
      if (tick === 30) f.setBeltItems([{ unique_id: 2, position: -0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 3 } }])
      if (tick === 31) f.setBeltItems([{ unique_id: 2, position: 0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 3 } }])
      if (tick === 32) f.setBeltItems([])
      f.controller.tick()
    }

    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: true,
      items_per_second: 6,
      validation: { verdict: 'proven_sufficient', stacking_requirement_met: true },
      belt_lane: {
        crossing_items: 6,
        min_stack_observed: 3,
        max_stack_observed: 3,
        stacking_established: true,
      },
    })
  })

  it('returns not_proven when research permits stacks but observed crossings are unstacked', () => {
    const f = fixture()
    const started = f.controller.start({
      kind: 'belt_lane', unit_number: 55, lane_index: 1, warmup_ticks: 0, window_ticks: 60,
      required_rate_per_second: 1, required_stack_size: 3,
    })
    if (!started.ok) throw new Error('measurement did not start')
    for (let tick = 1; tick <= 60; tick++) {
      ;(globalThis as any).game.tick = tick
      if (tick === 10) f.setBeltItems([{ unique_id: 1, position: -0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 1 } }])
      if (tick === 11) f.setBeltItems([{ unique_id: 1, position: 0.1, stack: { valid_for_read: true, name: 'iron-plate', count: 1 } }])
      f.controller.tick()
    }
    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: true,
      validation: { verdict: 'not_proven', stacking_requirement_met: false },
      belt_lane: { stacking_established: false },
    })
  })

  it('uses the deterministic researched lane ceiling for hard rejection', () => {
    const f = fixture()
    const started = f.controller.start({
      kind: 'belt_lane', unit_number: 55, lane_index: 1, warmup_ticks: 0, window_ticks: 60,
      required_rate_per_second: 30,
    })
    if (!started.ok) throw new Error('measurement did not start')
    for (let tick = 1; tick <= 60; tick++) f.tick(tick)
    expect(f.controller.status(started.measurement_id)).toMatchObject({
      ok: true,
      validation: {
        verdict: 'exceeds_theoretical_capacity',
        theoretical_stacked_lane_capacity_items_per_second: 22.5,
      },
    })
  })

  it('freezes completed evidence so later research/entity changes cannot rewrite an old result', () => {
    const f = fixture()
    const started = f.controller.start({ kind: 'inserter_instance', unit_number: 42, warmup_ticks: 0, window_ticks: 60 })
    if (!started.ok) throw new Error('measurement did not start')
    for (let tick = 1; tick <= 60; tick++) {
      ;(globalThis as any).game.tick = tick
      if (tick === 10) f.setHeld({ valid_for_read: true, name: 'iron-plate', count: 4 })
      if (tick === 30) f.setHeld({ valid_for_read: false, count: 0 })
      f.controller.tick()
    }
    const first = f.controller.status(started.measurement_id)
    f.force.inserter_stack_size_bonus = 99
    f.entities.delete(42)
    expect(f.controller.status(started.measurement_id)).toEqual(first)
  })
})
