import { afterEach, expect, it } from 'vitest'
import { recipe_categories, crafting_categories_support_recipe } from './recipe_categories'
import { expected_product_amount, fuel_burn } from './production_rates'
import { retained_node_changed } from './construction_layout_record'

const originalItems = prototypes.item
afterEach(() => { (prototypes as any).item = originalItems })

it('reads only the 2.1 recipe categories on a strict native-shaped object', () => {
  const recipe = new Proxy({ categories: ['hand-crafting', 'custom', 'custom'] }, {
    get(target, key) {
      if (!(key in target)) throw new Error(`removed native property: ${String(key)}`)
      return target[key as keyof typeof target]
    },
  })
  expect(recipe_categories(recipe)).toEqual(['hand-crafting', 'custom'])
  expect(crafting_categories_support_recipe({ 'hand-crafting': true }, recipe)).toBe(true)
  expect(crafting_categories_support_recipe({ crafting: true }, recipe)).toBe(false)
})

it('accepts fuel through any current item fuel category', () => {
  ;(prototypes as any).item = { fuel: { fuel_categories: ['unrelated', 'accepted'], fuel_value: 600 } }
  const burner: any = { fuel_categories: { accepted: true }, effectivity: 1 }
  expect(fuel_burn(10, burner, 'fuel')).toMatchObject({ accepted: true, per_minute: 1 })
  expect(fuel_burn(10, { ...burner, fuel_categories: { other: true } }, 'fuel').accepted).toBe(false)
})

it('applies both independent and shared product rolls to expected production', () => {
  expect(expected_product_amount({ amount: 8, independent_probability: 0.5, shared_probability: { min: 0.25, max: 0.75 } })).toBe(2)
  expect(expected_product_amount({ amount: 8, independent_probability: 1, shared_probability: { min: 0.5, max: 0.5 } })).toBe(0)
})

it('invalidates a retained layout entity when mirroring changes without moving or rotating it', () => {
  const node: any = { entity_name: 'inserter', position: { x: 1, y: 2 }, direction: 0, placed_mirrored: true }
  const entity = { name: 'inserter', position: { x: 1, y: 2 }, direction: 0, mirrored: true }
  expect(retained_node_changed(node, entity)).toBe(false)
  expect(retained_node_changed(node, { ...entity, mirrored: false })).toBe(true)
})
