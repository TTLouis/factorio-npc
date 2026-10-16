import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placement_item_preflight } from './placement_preflight'

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
