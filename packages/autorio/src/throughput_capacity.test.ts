import type { ControlledActor } from './actors/types'
import { afterEach, describe, expect, it } from 'vitest'
import { remember_entity_reference } from './entity_reference'
import { throughput_capacity } from './throughput_capacity'

const originalPrototypes = (globalThis as any).prototypes
const originalGame = (globalThis as any).game

function actor(force: Record<string, unknown> = {}, surfaceIndex = 1) {
  return { is_valid: true, force, surface: { index: surfaceIndex } } as unknown as ControlledActor
}

afterEach(() => {
  ;(globalThis as any).prototypes = originalPrototypes
  ;(globalThis as any).game = originalGame
})

describe('deterministic throughput capacity facts', () => {
  it('derives lane, full-belt, and researched stacking capacity from live belt speed', () => {
    ;(globalThis as any).prototypes = {
      entity: { 'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 } },
      item: {},
    }
    const result = throughput_capacity(actor({ belt_stack_size_bonus: 2 }), {
      kind: 'belt', prototype_name: 'transport-belt', required_rate_per_second: 40,
    })
    expect(result).toMatchObject({
      ok: true, kind: 'belt', scope: 'belt', force_belt_stack_size_bonus: 2, effective_belt_stack_size: 3,
      capacity: {
        unstacked_lane_items_per_second: 7.5, unstacked_belt_items_per_second: 15,
        stacked_lane_items_per_second: 22.5, stacked_belt_items_per_second: 45,
      },
      validation: {
        scope: 'belt', required_rate_per_second: 40,
        unstacked_capacity_items_per_second: 15, stacked_capacity_items_per_second: 45,
        fits_unstacked: false, fits_stacked: true,
      },
      semantics: { transport_capacity_only: true, stacked_capacity_requires_matching_item_stacks: true },
    })
  })

  it('validates a single lane independently from a whole belt', () => {
    ;(globalThis as any).prototypes = {
      entity: { 'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 } }, item: {},
    }
    const result = throughput_capacity(actor({ belt_stack_size_bonus: 2 }), {
      kind: 'belt', prototype_name: 'transport-belt', scope: 'lane', required_rate_per_second: 20,
    })
    expect(result).toMatchObject({
      ok: true,
      validation: {
        scope: 'lane', unstacked_capacity_items_per_second: 7.5, stacked_capacity_items_per_second: 22.5,
        fits_unstacked: false, fits_stacked: true,
      },
    })
  })

  it('reports researched inserter hand capacity but refuses to invent a fixed items-per-second rate', () => {
    ;(globalThis as any).prototypes = {
      entity: {
        'bulk-inserter': {
          name: 'bulk-inserter', type: 'inserter', bulk: true, uses_inserter_stack_size_bonus: true,
          inserter_stack_size_bonus: 1, inserter_max_belt_stack_size: 1,
          inserter_pickup_position: { x: 0, y: -1 }, inserter_drop_position: { x: 0, y: 1 },
          get_inserter_rotation_speed: () => 0.1, get_inserter_extension_speed: () => 0.05,
        },
      },
      item: { 'iron-plate': { name: 'iron-plate', stack_size: 100 } },
    }
    const result = throughput_capacity(actor({ belt_stack_size_bonus: 3, bulk_inserter_capacity_bonus: 10, inserter_stack_size_bonus: 3 }), {
      kind: 'inserter', prototype_name: 'bulk-inserter', item_name: 'iron-plate',
    })
    expect(result).toMatchObject({
      ok: true, kind: 'inserter', bulk: true, built_in_stack_size_bonus: 1,
      force_capacity_bonus: 10, hand_capacity_items: 12, belt_drop_stack_limit: 1,
      movement: { rotation_speed: 0.1, extension_speed: 0.05 }, transfer_rate: { validated: false },
    })
  })

  it('reads the placed inserter target count and actual pickup/drop topology', () => {
    const pickup = { valid: true, name: 'iron-chest', type: 'container', unit_number: 41, position: { x: 0, y: 0 }, direction: 0 }
    const drop = { valid: true, name: 'assembling-machine-2', type: 'assembling-machine', unit_number: 43, position: { x: 2, y: 0 }, direction: 0 }
    const inserter = {
      valid: true,
      name: 'fast-inserter',
      type: 'inserter',
      unit_number: 42,
      surface: { index: 1 },
      force: { index: 1 },
      position: { x: 1, y: 0 },
      active: true,
      inserter_target_pickup_count: 4,
      inserter_stack_size_override: 3,
      pickup_from_left_lane: true,
      pickup_from_right_lane: false,
      pickup_position: { x: 0.5, y: 0 },
      drop_position: { x: 1.5, y: 0 },
      pickup_target: pickup,
      drop_target: drop,
      held_stack: { valid_for_read: true, name: 'iron-plate', count: 2 },
    }
    // Inserters lack the get-by-unit-number flag, so the native lookup misses
    // in Factorio 2.0; the observation hint resolves the same identity.
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game = { tick: 1, get_entity_by_unit_number: () => undefined }
    remember_entity_reference(inserter as any)
    const observer = actor({ index: 1 }, 1) as any
    observer.surface.find_entities_filtered = () => [inserter]

    const result = throughput_capacity(observer, { kind: 'inserter_instance', unit_number: 42 })
    expect(result).toMatchObject({
      ok: true,
      kind: 'inserter_instance',
      unit_number: 42,
      prototype_name: 'fast-inserter',
      active: true,
      target_pickup_count: 4,
      stack_size_override: 3,
      pickup_from_left_lane: true,
      pickup_from_right_lane: false,
      pickup_target: { unit_number: 41, name: 'iron-chest' },
      drop_target: { unit_number: 43, name: 'assembling-machine-2' },
      held_stack: { name: 'iron-plate', count: 2 },
      transfer_rate: { validated: false },
    })
  })

  it('rejects an inserter instance on another surface', () => {
    ;(globalThis as any).game = {
      tick: 1,
      get_entity_by_unit_number: () => ({ valid: true, name: 'inserter', type: 'inserter', unit_number: 7, surface: { index: 2 }, force: { index: 1 }, position: { x: 0, y: 0 } }),
    }
    expect(throughput_capacity(actor({}, 1), { kind: 'inserter_instance', unit_number: 7 })).toEqual({
      ok: false, error: { code: 'INVALID_REQUEST', message: 'entity is on another surface' },
    })
  })

  it('caps hand capacity by the selected item stack size', () => {
    ;(globalThis as any).prototypes = {
      entity: { 'mod-inserter': { name: 'mod-inserter', type: 'inserter', bulk: false, uses_inserter_stack_size_bonus: true, inserter_stack_size_bonus: 20, get_inserter_rotation_speed: () => 0.02, get_inserter_extension_speed: () => 0.03 } },
      item: { fish: { name: 'fish', stack_size: 5 } },
    }
    const result = throughput_capacity(actor({ inserter_stack_size_bonus: 20, belt_stack_size_bonus: 0 }), {
      kind: 'inserter', prototype_name: 'mod-inserter', item_name: 'fish',
    })
    expect(result).toMatchObject({ ok: true, hand_capacity_items: 5, item_stack_size: 5 })
  })
})
