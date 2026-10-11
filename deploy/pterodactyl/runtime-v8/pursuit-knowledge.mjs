import { requirementTargets } from './goal-requirements.mjs'

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
const list = value => Array.isArray(value) ? value : []
const parse = raw => { try { return JSON.parse(String(raw)) } catch { return null } }

// Read prototype dependencies, never choose an executable plan. The only roots
// are trusted acceptance targets and names returned by bounded native reads.
export async function seedPursuitKnowledge(predicate, read) {
  const targets = requirementTargets(predicate)
  let truncated = targets.technologies.length > 2
  const take = (value, maximum) => {
    const rows = list(value)
    truncated ||= rows.length > maximum
    return rows.slice(0, maximum)
  }
  const queue = [], seen = new Set()
  const add = name => {
    if (typeof name !== 'string' || !NAME.test(name) || seen.has(name)) return
    if (queue.length >= 128) { truncated = true; return }
    seen.add(name); queue.push(name)
  }
  for (const item of targets.items) add(item.name)
  for (const entity of targets.entities) add(entity)
  let researchReads = 0, recipeReads = 0, unreadable = 0
  for (const technology of targets.technologies.slice(0, 2)) {
    const path = parse(await read({ name: 'getResearchPath', args: { name: technology, max_nodes: 32 } }))
    researchReads++
    if (!path || path.ok !== true) { unreadable++; continue }
    truncated ||= path.truncated === true
    for (const node of take(path.nodes, 32)) {
      if (node.research_trigger?.type === 'craft-item') add(node.research_trigger.item)
      truncated ||= node.science?.ingredients_truncated === true
      for (const ingredient of take(node.science?.ingredients, 6)) add(ingredient.name)
    }
  }
  while (queue.length && recipeReads < 12) {
    const name = queue.shift()
    const details = parse(await read({ name: 'getRecipeDetails', args: { item_or_recipe: name, requested_count: 1 } }))
    recipeReads++
    if (!details || typeof details.found !== 'boolean') { unreadable++; continue }
    if (!details.found) continue // A mined input is not an invented recipe.
    truncated ||= details.truncated === true
    for (const recipe of take(details.recipes, 8)) {
      truncated ||= recipe.ingredients_truncated === true
      for (const ingredient of take(recipe.ingredients, 16)) add(ingredient.name)
    }
  }
  return { research_reads: researchReads, recipe_reads: recipeReads, unreadable,
    truncated: truncated || queue.length > 0 }
}
