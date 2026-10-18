import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placement_item_preflight, planned_placement_footprint } from './placement_preflight'

beforeEach(() => {
  ;(globalThis as any).prototypes.item['placement-test-kit'] = {}
  ;(globalThis as any).prototypes.entity['placement-test-machine'] = { items_to_place_this: [{ name: 'placement-test-kit', count: 2 }] }
})

describe('current held placement item preflight', () => {
  it('uses the executor item alias and required count, re-reads stock and performs no inventory mutation', () => {
    let count = 1
    const inventory = { get_item_count: vi.fn((name) => { expect(name).toBe('placement-test-kit'); return count }), remove: vi.fn(), insert: vi.fn() }
    const actor = { is_valid: true, get_main_inventory: () => inventory } as any
    expect(placement_item_preflight(actor, 'placement-test-machine')).toEqual({ ok: false, code: 'placement_item_missing',
      placement_item: { entity_name: 'placement-test-machine', item_name: 'placement-test-kit', count: 2, held_count: 1 } })
    count = 2
    expect(placement_item_preflight(actor, 'placement-test-machine')).toEqual({ ok: true,
      placement_item: { entity_name: 'placement-test-machine', item_name: 'placement-test-kit', count: 2, held_count: 2 } })
    count = 0
    expect(placement_item_preflight(actor, 'placement-test-machine')).toMatchObject({ ok: false, code: 'placement_item_missing' })
    expect(inventory.remove).not.toHaveBeenCalled(); expect(inventory.insert).not.toHaveBeenCalled()
  })

  it('fails closed for absent actors/inventories and unreadable counts', () => {
    expect(placement_item_preflight(undefined, 'placement-test-machine')).toMatchObject({ ok: false, code: 'no_actor' })
    expect(placement_item_preflight({ is_valid: false } as any, 'placement-test-machine')).toMatchObject({ code: 'no_actor' })
    expect(placement_item_preflight({ is_valid: true, get_main_inventory: () => undefined } as any, 'placement-test-machine')).toMatchObject({ code: 'no_inventory' })
    for (const count of [undefined, '2', Number.NaN, Infinity, -Infinity, -1, 1.5, 9007199254740992]) {
      const actor = { is_valid: true, get_main_inventory: () => ({ get_item_count: () => count }) } as any
      expect(placement_item_preflight(actor, 'placement-test-machine')).toMatchObject({ ok: false, code: 'placement_item_unreadable' })
    }
  })

  it('preserves native resolver failures without reading or granting future stock', () => {
    const get_item_count = vi.fn(() => 100)
    const actor = { is_valid: true, get_main_inventory: () => ({ get_item_count }) } as any
    ;(globalThis as any).prototypes.entity['placement-script-only'] = { items_to_place_this: [] }
    ;(globalThis as any).prototypes.entity['placement-ambiguous'] = { items_to_place_this: [{ name: 'placement-test-kit', count: 1 }, { name: 'placement-test-kit', count: 2 }] }
    ;(globalThis as any).prototypes.entity['placement-invalid'] = { items_to_place_this: [{ name: 'placement-test-kit', count: 0 }] }
    for (const [name, code] of [['placement-unknown', 'unknown_entity'], ['placement-script-only', 'not_item_placeable'],
      ['placement-ambiguous', 'ambiguous_placement_item'], ['placement-invalid', 'invalid_placement_item']]) {
      expect(placement_item_preflight(actor, name)).toMatchObject({ ok: false, code })
    }
    expect(get_item_count).not.toHaveBeenCalled()
  })
})

describe('planned placement footprint', () => {
  // Run Z batch 21: the steam engine the game refused because the boiler of the same batch already stood there.
  const engine = { tile_width: 3, tile_height: 5, collision_box: { left_top: { x: -1.25, y: -2.35 }, right_bottom: { x: 1.25, y: 2.35 } },
    collision_mask: { layers: { player: true, object: true, item: true, water_tile: true, meltable: true, train: false } } }

  it('uses the execution snap and rotated collision box, and lists the enabled collision layers', () => {
    ;(globalThis as any).prototypes.entity['footprint-engine'] = engine
    expect(planned_placement_footprint('footprint-engine', 42.5, -48.5, 4)).toEqual({
      entity_name: 'footprint-engine',
      position: { x: 42.5, y: -48.5 },
      direction: 4,
      tile_box: { left_top: { x: 40, y: -50 }, right_bottom: { x: 45, y: -47 } },
      world_box: { left_top: { x: 40.15, y: -49.75 }, right_bottom: { x: 44.85, y: -47.25 } },
      collision_layers: ['item', 'meltable', 'object', 'player', 'water_tile'],
    })
    // An off-grid centre is described where execution will build it.
    expect(planned_placement_footprint('footprint-engine', 42.9, -48.4, 0)?.position).toEqual({ x: 42.5, y: -48.5 })
  })

  it('reports nothing without coordinates or a prototype, and marks collision it cannot read', () => {
    ;(globalThis as any).prototypes.entity['footprint-engine'] = engine
    expect(planned_placement_footprint('footprint-engine', undefined, undefined, 0)).toBeUndefined()
    expect(planned_placement_footprint('footprint-engine', Number.NaN, 1, 0)).toBeUndefined()
    expect(planned_placement_footprint('footprint-missing', 1, 1, 0)).toBeUndefined()
    ;(globalThis as any).prototypes.entity['footprint-maskless'] = { tile_width: 1, tile_height: 1 }
    expect(planned_placement_footprint('footprint-maskless', 0.5, 0.5, 0)).toMatchObject({ collision_layers: [], collision_unknown: true })
    ;(globalThis as any).prototypes.entity['footprint-self'] = { ...engine, collision_mask: { layers: { object: true }, not_colliding_with_itself: true, colliding_with_tiles_only: true } }
    expect(planned_placement_footprint('footprint-self', 42.5, -48.5, 0)).toMatchObject({ not_colliding_with_itself: true, colliding_with_tiles_only: true })
  })
})
