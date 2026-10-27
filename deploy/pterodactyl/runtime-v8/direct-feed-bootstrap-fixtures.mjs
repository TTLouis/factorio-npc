// Vanilla recipe facts in the shape the mod's getRecipeDetails / getMiningDetails answer (knowledge.ts), for the direct_feed
// bootstrap tests (Run BB lane B). Burner drill = 3 iron-gear-wheel + 3 iron-plate + 1 stone-furnace; gear = 2 iron-plate;
// stone-furnace = 5 stone; a plate is smelted from one iron-ore.
const item = (name, amount) => ({ type: 'item', name, amount })

function row(name, ingredients, { amount = 1, hand = true, enabled = true, machines = [], category } = {}) {
  return { name, enabled, applicability: { state: enabled ? 'available' : 'unavailable', reason: 'no_surface_conditions', surface_bound: false },
    energy: 2, categories: [category ?? (hand ? 'crafting' : 'smelting')], hand_craftable_category: hand,
    ingredients: ingredients.map(([ingredient, count]) => item(ingredient, count)), products: [item(name, amount)],
    crafting_machine_count: machines.length, crafting_machines: machines, crafting_machines_truncated: false }
}

const furnace = name => ({ name, type: 'furnace', placed_by_item: name, crafting_speed: 1, energy_source: 'burner', energy_watts: 90000 })

export const RAW_ITEMS = Object.freeze(['iron-ore', 'copper-ore', 'stone', 'coal'])

export function vanillaRecipes() {
  return {
    'burner-mining-drill': row('burner-mining-drill', [['iron-gear-wheel', 3], ['iron-plate', 3], ['stone-furnace', 1]]),
    'electric-mining-drill': row('electric-mining-drill', [['electronic-circuit', 3], ['iron-gear-wheel', 5], ['iron-plate', 10]]),
    'big-mining-drill': row('big-mining-drill', [['steel-plate', 20], ['electric-mining-drill', 1]], { enabled: false }),
    'iron-gear-wheel': row('iron-gear-wheel', [['iron-plate', 2]]),
    'electronic-circuit': row('electronic-circuit', [['iron-plate', 1], ['copper-cable', 3]]),
    'copper-cable': row('copper-cable', [['copper-plate', 1]], { amount: 2 }),
    'stone-furnace': row('stone-furnace', [['stone', 5]]),
    'iron-plate': row('iron-plate', [['iron-ore', 1]], { hand: false, machines: [furnace('stone-furnace'), furnace('steel-furnace')] }),
    'copper-plate': row('copper-plate', [['copper-ore', 1]], { hand: false, machines: [furnace('stone-furnace'), furnace('steel-furnace')] }),
  }
}

export function miningDetails(resource = 'iron-ore', drills = ['burner-mining-drill', 'electric-mining-drill']) {
  return { found: true, query: resource, truncated: false, resources: [{ name: resource, category: 'basic-solid', drill_count: drills.length,
    drills: drills.map(name => ({ name, mining_speed: 0.25 })), drills_truncated: false }] }
}

/**
 * What getRecipeDetails answers for `name`: the canonical row, the raw-resource answer, or the mod's no-recipe answer.
 * `recipes` is `vanillaRecipes()` or a subset/override of it.
 */
export function recipeDetails(name, recipes = vanillaRecipes(), ambiguous = []) {
  if (RAW_ITEMS.includes(name)) return { found: true, query: name, truncated: false, mined_from: [name], recipes: [] }
  const recipe = recipes[name]
  // Two recipes make the item and none carries its name: the facts do not say which one a craft would use.
  if (recipe && ambiguous.includes(name)) return { found: true, query: name, truncated: false, recipes: [{ ...recipe, name: `${name}-a` }, { ...recipe, name: `${name}-b` }] }
  return recipe ? { found: true, query: name, truncated: false, recipes: [recipe] }
    : { found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name' }
}

/**
 * Answers the reads the bootstrap check makes, or returns undefined for any other command. Options: `inventory` (name -> count),
 * `recipes`, `drills`, `entities` (unit_number -> entity name that getEntityStatus reports), `unreadable` (tool names answered
 * with text that is not JSON).
 */
export function answerBootstrapRead(text, { inventory = {}, recipes = vanillaRecipes(), drills, entities = {}, unreadable = [], ambiguous = [] } = {}) {
  const mining = /"mining_details",\s*['"]([^'"]+)['"]/.exec(text)?.[1]
  if (mining !== undefined) return unreadable.includes('getMiningDetails') ? 'not json' : JSON.stringify(miningDetails(mining, drills))
  const recipe = /"recipe_details",\s*['"]([^'"]+)['"]/.exec(text)?.[1]
  if (recipe !== undefined) return unreadable.includes('getRecipeDetails') ? 'not json' : JSON.stringify(recipeDetails(recipe, recipes, ambiguous))
  const unit = /"get_entity_status",\s*nil,\s*nil,\s*(\d+)/.exec(text)?.[1]
  if (unit !== undefined) {
    const name = entities[Number(unit)]
    return JSON.stringify(name ? { found: true, entity: { unit_number: Number(unit), name } } : { found: false })
  }
  if (text.includes('"get_inventory_items"')) {
    return unreadable.includes('getInventoryItems') ? 'not an inventory' : JSON.stringify(Object.entries(inventory).map(([itemName, count]) => ({ name: itemName, count })))
  }
  return undefined
}
