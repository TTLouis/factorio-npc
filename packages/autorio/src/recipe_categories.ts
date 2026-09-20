// Single source of truth for reading a recipe's crafting categories.
//
// Factorio 2.0's LuaRecipe exposes `category` (a single string) plus
// `additional_categories` (a table). There is NO `categories` field, and reading
// an absent key on a LuaObject RAISES rather than returning nil — so the common
// `recipe.categories ?? []` idiom does not degrade, it throws:
//
//   LuaRecipe doesn't contain key categories.
//
// Raised inside autorio::on_tick that is a non-recoverable error and the server
// dies. This shipped in three independent copies of the same helper
// (recipe_configuration, map_remote, production_planning_live), each with unit
// tests that mocked a `categories` array the engine never provides — so the
// suites were green while every live set_machine_recipe killed the server.
//
// Keep this the only place that reads recipe categories.
export function recipe_categories(recipe: any): string[] {
  const categories: string[] = []
  if (typeof recipe?.category === 'string') categories.push(recipe.category)
  for (const category of recipe?.additional_categories ?? []) {
    if (typeof category === 'string' && !categories.includes(category)) categories.push(category)
  }
  return categories
}

// True when `crafting_categories` (a prototype dictionary of category -> true)
// covers at least one of the recipe's categories.
export function crafting_categories_support_recipe(supported: any, recipe: any): boolean {
  if (!supported) return false
  for (const category of recipe_categories(recipe)) {
    if (supported[category] === true) return true
  }
  return false
}
