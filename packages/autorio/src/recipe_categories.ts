// Factorio 2.1 recipes expose categories; removed LuaObject fields must never be probed.
export function recipe_categories(recipe: any): string[] {
  const categories: string[] = []
  for (const category of recipe?.categories ?? []) {
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
