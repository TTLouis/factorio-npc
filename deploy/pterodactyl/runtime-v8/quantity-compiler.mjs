// Desired inventory units and recipe executions are different contracts. All
// execution counts below are compiled from complete, live deterministic yields.
export const QUANTITY_LIMITS = Object.freeze({ targets: 16, items: 64, depth: 12, quantity: 10000, crafts: 10000 })
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/
export function itemName(value) {
  if (typeof value !== 'string' || !namePattern.test(value)) throw new Error('invalid_item_name')
  return value
}
export function quantity(value, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > QUANTITY_LIMITS.quantity) throw new Error('invalid_item_quantity')
  return value
}
export function normalizeTargets(value) {
  if (!Array.isArray(value) || !value.length || value.length > QUANTITY_LIMITS.targets) throw new Error('invalid_quantity_targets')
  const seen = new Set()
  return value.map(row => {
    if (!row || Object.keys(row).some(key => !['item_name', 'count'].includes(key))) throw new Error('invalid_quantity_target')
    const item_name = itemName(row.item_name)
    if (seen.has(item_name)) throw new Error('duplicate_quantity_target')
    seen.add(item_name)
    return { item_name, count: quantity(row.count) }
  })
}
export function normalizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > QUANTITY_LIMITS.items) throw new Error('invalid_inventory_counts')
  const result = Object.create(null)
  for (const [name, count] of Object.entries(value)) result[itemName(name)] = quantity(count, { zero: true })
  return result
}
export function recipeForItem(recipes, item) {
  const candidates = recipes.filter(recipe => Array.isArray(recipe?.products) && recipe.products.some(p => p.type !== 'fluid' && p.name === item))
  if (candidates.length > 1) throw new Error(`ambiguous_recipe:${item}`)
  if (!candidates.length) return undefined
  const recipe = candidates[0]
  if (recipe.enabled !== true || recipe.applicability?.state === 'unavailable') throw new Error(`recipe_unavailable:${item}`)
  itemName(recipe.name)
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length > 32 || recipe.products.length > 16) throw new Error(`incomplete_recipe:${item}`)
  const parse = row => {
    if (row?.type === 'fluid' || row?.probability !== undefined && row.probability !== 1
      || row?.amount_min !== undefined || row?.amount_max !== undefined) throw new Error(`nondeterministic_or_fluid_recipe:${item}`)
    return { item_name: itemName(row.name), count: quantity(row.amount) }
  }
  const products = recipe.products.map(parse)
  // Multiple/byproduct recipes need an explicit allocation policy; do not count
  // speculative co-products as inventory for a different demand.
  if (products.length !== 1) throw new Error(`multiple_output_items_unsupported:${item}`)
  return { name: recipe.name, item_name: item, yield: products[0].count,
    ingredients: recipe.ingredients.map(row => parse(row)), hand_craftable: recipe.hand_craftable_category === true,
    categories: Array.isArray(recipe.categories) ? recipe.categories.slice(0, 8) : [], energy: recipe.energy }
}
export function compileQuantities({ targets, recipes, inventory, reserved = {} }) {
  targets = normalizeTargets(targets)
  const held = normalizeCounts(inventory)
  const excluded = normalizeCounts(reserved)
  if (!Array.isArray(recipes) || recipes.length > QUANTITY_LIMITS.items) throw new Error('invalid_recipe_graph')
  const stock = new Map(Object.entries(held).map(([name, n]) => [name, Math.max(0, n - (excluded[name] ?? 0))]))
  const targetHeld = new Map()
  // Hold finished targets aside before resolving other targets' ingredients.
  // A requested final copper reserve cannot be consumed by the pole task.
  for (const target of targets) {
    const n = Math.min(target.count, stock.get(target.item_name) ?? 0)
    targetHeld.set(target.item_name, n)
    stock.set(target.item_name, (stock.get(target.item_name) ?? 0) - n)
  }
  const nodes = []; const leaves = new Map(); const path = new Set(); const touched = new Set()
  function need(item, requested, depth) {
    if (depth > QUANTITY_LIMITS.depth || touched.size >= QUANTITY_LIMITS.items && !touched.has(item)) throw new Error('quantity_graph_limit')
    touched.add(item)
    const take = Math.min(requested, stock.get(item) ?? 0)
    stock.set(item, (stock.get(item) ?? 0) - take)
    const deficit = requested - take
    if (!deficit) return
    if (path.has(item)) throw new Error(`recipe_cycle:${item}`)
    const recipe = recipeForItem(recipes, item)
    if (!recipe) {
      const count = (leaves.get(item) ?? 0) + deficit
      quantity(count)
      leaves.set(item, count)
      return
    }
    const crafts = Math.ceil(deficit / recipe.yield)
    quantity(crafts)
    if (crafts * recipe.yield > QUANTITY_LIMITS.quantity) throw new Error('quantity_output_limit')
    path.add(item)
    const inputs = recipe.ingredients.map(input => ({ item_name: input.item_name, count: quantity(input.count * crafts) }))
    for (const input of inputs) need(input.item_name, input.count, depth + 1)
    path.delete(item)
    stock.set(item, (stock.get(item) ?? 0) + crafts * recipe.yield - deficit)
    nodes.push({ ...recipe, desired_items: deficit, crafts, produced_items: crafts * recipe.yield, inputs })
    if (nodes.length > QUANTITY_LIMITS.items) throw new Error('quantity_graph_limit')
  }
  for (const target of targets) need(target.item_name, target.count - targetHeld.get(target.item_name), 0)
  return { targets, nodes, acquisition: [...leaves].map(([item_name, count]) => ({ item_name, count })),
    fulfilled: targets.every(target => (targetHeld.get(target.item_name) ?? 0) >= target.count),
    retained: targets.map(target => ({ item_name: target.item_name, count: targetHeld.get(target.item_name) })),
    surplus: Object.fromEntries([...stock].filter(([, n]) => n > 0)) }
}
