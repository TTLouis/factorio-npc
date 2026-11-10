import { describe, expect, it, vi } from 'vitest'
import { ground_item_pickup_preflight, pickup_args_refusal, pickup_box } from './ground_item_pickup'

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

function item(name: string, count: number, x: number, y: number) {
  return { valid: true, name: 'item-on-ground', type: 'item-entity', position: { x, y }, stack: { valid_for_read: true, name, count } }
}

function actor(entities: any[], insertable: (stack: any) => number = stack => stack.count) {
  // The engine area filter matches collision-box overlap, so an item whose position lies just outside the box is found.
  const overlaps = (box: Box, p: { x: number, y: number }) => p.x >= box.left_top.x - 0.15 && p.x <= box.right_bottom.x + 0.15
    && p.y >= box.left_top.y - 0.15 && p.y <= box.right_bottom.y + 0.15
  const surface = {
    find_entities_filtered: vi.fn((filters: any) => entities
      .filter(entity => entity.valid && (!filters.type || entity.type === filters.type) && (!filters.area || overlaps(filters.area, entity.position)))
      .slice(0, filters.limit ?? 1000)),
  }
  const inventory = { get_insertable_count: vi.fn(insertable) }
  return { is_valid: true, character: { valid: true }, surface, get_main_inventory: () => inventory, inventory } as any
}

describe('external ground-item pickup preflight', () => {
  it('bounds the box to radius 0-2 around the given point', () => {
    expect(pickup_box(3.4, -2.7, 0)).toEqual({ left_top: { x: 2.9, y: -3.2 }, right_bottom: { x: 3.9, y: -2.2 } })
    expect(pickup_box(0, 0, 2)).toEqual({ left_top: { x: -2.5, y: -2.5 }, right_bottom: { x: 2.5, y: 2.5 } })
    expect(pickup_args_refusal(0, 0, 2)).toBeUndefined()
    expect(pickup_args_refusal(0, 0, 3)).toBe('radius')
    expect(pickup_args_refusal(0, 0, 1.5)).toBe('radius')
    expect(pickup_args_refusal(Number.NaN, 0, 0)).toBe('x')
    expect(pickup_args_refusal(0, 2000000, 0)).toBe('x')
  })

  it('lists the ground stacks in the box and nothing else', () => {
    const tree = { valid: true, name: 'tree-01', type: 'tree', position: { x: 0.2, y: 0.2 } }
    // coal at x=1.6 only overlaps the radius-1 box (edge 1.5) and is not counted, matching the task's position rule.
    const a = actor([item('iron-ore', 3, 0.3, -0.1), item('stone', 1, 0.9, 0.9), item('coal', 5, 4, 4), item('coal', 2, 1.6, 0), tree])
    const result: any = ground_item_pickup_preflight(a, { x: 0, y: 0, radius: 1 })
    expect(result.ok).toBe(true)
    expect(result.items).toEqual([
      { name: 'iron-ore', count: 3, quality: undefined, position: { x: 0.3, y: -0.1 } },
      { name: 'stone', count: 1, quality: undefined, position: { x: 0.9, y: 0.9 } },
    ])
    expect(a.surface.find_entities_filtered).toHaveBeenCalledWith(expect.objectContaining({ type: 'item-entity' }))
  })

  it('refuses an empty box, too many stacks, a stack that does not fit, and bad arguments', () => {
    expect(ground_item_pickup_preflight(actor([]), { x: 0, y: 0 })).toMatchObject({ ok: false, code: 'no_ground_items' })
    const many = Array.from({ length: 17 }, (_, index) => item('iron-ore', 1, -2 + (index % 5), -2 + Math.floor(index / 5)))
    expect(ground_item_pickup_preflight(actor(many), { x: 0, y: 0, radius: 2 })).toMatchObject({ ok: false, code: 'ground_items_over_limit', limit: 16 })
    // Room for 10 of the 50 stone: a partial fit is still a refusal.
    const full = actor([item('iron-ore', 3, 0, 0), item('stone', 50, 0.2, 0)], stack => stack.name === 'stone' ? 10 : stack.count)
    expect(ground_item_pickup_preflight(full, { x: 0, y: 0 })).toMatchObject({ ok: false, code: 'inventory_full', item: { name: 'stone', count: 50 } })
    expect(ground_item_pickup_preflight(actor([]), { x: 0, y: 0, radius: 5 })).toMatchObject({ ok: false, code: 'invalid_pickup_args', field: 'radius' })
    expect(ground_item_pickup_preflight(undefined, { x: 0, y: 0 })).toMatchObject({ ok: false, code: 'no_actor' })
  })
})
