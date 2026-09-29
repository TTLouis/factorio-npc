import { beforeEach, describe, expect, it } from 'vitest'
import { craft_queue_totals, crafted_item_count, credit_finished_crafts, record_crafted_items } from './crafted_items'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).prototypes = {
    recipe: {
      'stone-furnace': { products: [{ type: 'item', name: 'stone-furnace', amount: 1 }] },
      'copper-cable': { products: [{ type: 'item', name: 'copper-cable', amount: 2 }] },
      'gamble': { products: [{ type: 'item', name: 'iron-plate', amount: 1, probability: 0.5 }] },
      'oil-thing': { products: [{ type: 'fluid', name: 'petroleum-gas', amount: 10 }, { type: 'item', name: 'sulfur', amount: 2 }] },
      'ranged': { products: [{ type: 'item', name: 'iron-plate', amount_min: 1, amount_max: 3 }] },
    },
  }
})

describe('crafted item counter', () => {
  it('starts at zero and accumulates per force and item', () => {
    expect(crafted_item_count(1, 'stone-furnace')).toBe(0)
    record_crafted_items(1, 'stone-furnace', 2)
    record_crafted_items(1, 'stone-furnace', 1)
    record_crafted_items(2, 'stone-furnace', 5)
    expect(crafted_item_count(1, 'stone-furnace')).toBe(3)
    expect(crafted_item_count(2, 'stone-furnace')).toBe(5)
    expect(crafted_item_count(1, 'iron-plate')).toBe(0)
  })

  it('ignores non-positive amounts', () => {
    record_crafted_items(1, 'stone-furnace', 0)
    record_crafted_items(1, 'stone-furnace', -3)
    expect(crafted_item_count(1, 'stone-furnace')).toBe(0)
  })

  it('sums queue entries per recipe', () => {
    expect(craft_queue_totals([
      { recipe: 'a', count: 2 },
      { recipe: 'b', count: 1 },
      { recipe: 'a', count: 3 },
    ])).toEqual({ a: 5, b: 1 })
  })

  it('credits crafts that left the queue, at the recipe yield', () => {
    const credited = credit_finished_crafts(1, { 'stone-furnace': 3, 'copper-cable': 2 }, { 'stone-furnace': 1, 'copper-cable': 2 })
    expect(credited).toBe(2)
    expect(crafted_item_count(1, 'stone-furnace')).toBe(2)
    expect(crafted_item_count(1, 'copper-cable')).toBe(0)

    credit_finished_crafts(1, { 'copper-cable': 2 }, {})
    expect(crafted_item_count(1, 'copper-cable')).toBe(4)
  })

  it('never credits growth of the queue or an unchanged queue', () => {
    expect(credit_finished_crafts(1, { 'stone-furnace': 2 }, { 'stone-furnace': 2 })).toBe(0)
    expect(credit_finished_crafts(1, { 'stone-furnace': 2 }, { 'stone-furnace': 5 })).toBe(0)
    expect(crafted_item_count(1, 'stone-furnace')).toBe(0)
  })

  it('counts only the certain item products of a recipe', () => {
    credit_finished_crafts(1, { 'gamble': 2, 'oil-thing': 1, 'ranged': 1, 'unknown-recipe': 4 }, {})
    expect(crafted_item_count(1, 'iron-plate')).toBe(0)
    expect(crafted_item_count(1, 'petroleum-gas')).toBe(0)
    expect(crafted_item_count(1, 'sulfur')).toBe(2)
  })
})
