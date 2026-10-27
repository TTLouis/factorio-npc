// Commit-time bootstrap feasibility of a planner's direct_feed supply choice (Run BB lane B).
//
// A direct_feed step may not hand-acquire or hand-supply its resource (manualSupplyDrift in role-contracts.mjs). Its cell still
// needs one drill and one smelter. A machine the NPC neither holds nor has placed is crafted from native recipes, and a recipe
// bill that ends in the resource itself (iron plates short, and a plate is only smelted from iron-ore) can never be finished by
// a step that forbids the resource by hand. This module is the pure facts -> verdict half: the loop reads the native facts
// (direct-feed-bootstrap-runtime.mjs) and this decides. Anything ambiguous, locked or unreadable is "unknown", never a refusal.
import { compileQuantities } from './quantity-compiler.mjs'

export const DIRECT_FEED_BOOTSTRAP_CODE = 'direct_feed_bootstrap_infeasible'
export const VERDICT = Object.freeze({ INFEASIBLE: 'infeasible', FEASIBLE: 'feasible', UNKNOWN: 'unknown' })

const PAIR_MESSAGE_LIMIT = 1

/** Recipes the resource is an ingredient of that only a placed machine can run (the resource's smelting recipes). */
export function smeltingRecipes(recipes, resource) {
  return (Array.isArray(recipes) ? recipes : []).filter(recipe => Array.isArray(recipe?.ingredients)
    && recipe.ingredients.some(row => row?.name === resource)
    && recipe.hand_craftable_category !== true
    && Array.isArray(recipe.crafting_machines) && recipe.crafting_machines.length > 0
    && recipe.crafting_machines_truncated !== true)
}

function craftable(recipe) {
  return recipe.enabled === true && recipe.applicability?.state !== 'unavailable'
}

/**
 * @param resource  the direct-feed resource (iron-ore)
 * @param drills    names of every drill the native mining facts list for it (complete list only)
 * @param recipes   raw native recipe rows: the drills' recipes and every ingredient's, one row per item
 * @param raw       items the native facts confirm are raw (mined or harvested, no recipe)
 * @param inventory held counts by item name
 * @param placed    NPC-placed machines the step does not preserve, counted by entity name
 * @param protect   the step checkpoint's inventory_count requirements ({ item_name, minimum })
 */
export function directFeedBootstrapVerdict({ resource, drills, recipes, raw = [], inventory = {}, placed = {}, protect = [] }) {
  const unknown = reason => ({ verdict: VERDICT.UNKNOWN, resource, reason, pairs: [] })
  if (typeof resource !== 'string' || !Array.isArray(drills) || drills.length === 0 || !Array.isArray(recipes)) return unknown('facts_incomplete')
  const rawItems = new Set([...raw, resource])
  const smelting = smeltingRecipes(recipes, resource)
  // What the cell is for is not protected from its own machines; any other counted stock is another checkpoint's (as
  // production-task-runtime protectedStock keeps the requirements outside a task's targets).
  const products = new Set(smelting.flatMap(recipe => (recipe.products ?? []).map(row => row?.name)))
  const reserved = {}
  for (const row of Array.isArray(protect) ? protect : []) {
    if (typeof row?.item_name === 'string' && Number.isSafeInteger(row.minimum) && !products.has(row.item_name)) reserved[row.item_name] = Math.max(reserved[row.item_name] ?? 0, row.minimum)
  }
  const held = item => Math.max(0, (inventory[item] ?? 0) - (reserved[item] ?? 0))
  const producerOf = item => recipes.find(recipe => recipe?.products?.some(row => row?.name === item))
  const side = ({ entity, item }) => {
    const count = (item ? held(item) : 0) + (placed[entity] ?? 0)
    if (count >= 1) return { entity, item, available: true, count }
    const recipe = item ? producerOf(item) : undefined
    if (!recipe) return { entity, item, unknown: true }
    return craftable(recipe) ? { entity, item, craft: true } : { entity, item, locked: true }
  }
  // A locked recipe is no way to build the cell now: it neither proves nor disproves the bootstrap.
  const drillSides = [...new Set(drills)].map(name => side({ entity: name, item: name })).filter(row => !row.locked)
  const machines = new Map()
  for (const recipe of smelting) for (const machine of recipe.crafting_machines) {
    if (typeof machine?.name === 'string' && !machines.has(machine.name)) machines.set(machine.name, { entity: machine.name, item: machine.placed_by_item })
  }
  const smelterSides = [...machines.values()].map(side).filter(row => !row.locked)
  // The compiler reads bounded counts of the items the bill can touch, never the whole backpack.
  const touched = new Set(recipes.flatMap(recipe => [...(recipe?.ingredients ?? []), ...(recipe?.products ?? [])].map(row => row?.name)))
  const stock = Object.fromEntries(Object.entries(inventory).filter(([item]) => touched.has(item)).map(([item, count]) => [item, Math.min(count, 10000)]))
  const reservedForBill = Object.fromEntries(Object.entries(reserved).filter(([item]) => touched.has(item)).map(([item, count]) => [item, Math.min(count, 10000)]))
  const billFor = rows => {
    try {
      const bill = compileQuantities({ targets: rows.map(row => ({ item_name: row.item, count: 1 })), recipes, inventory: stock, reserved: reservedForBill })
      return { nodes: bill.nodes, acquisition: bill.acquisition }
    }
    catch { return undefined }
  }
  const pairs = []
  for (const drill of drillSides) for (const smelter of smelterSides.length > 0 ? smelterSides : [undefined]) pairs.push(assess({ drill, smelter }))
  function assess({ drill, smelter }) {
    const base = { drill: drill.entity, ...(smelter ? { smelter: smelter.entity } : {}) }
    const missing = [drill, smelter].filter(row => row && !row.available)
    const names = missing.map(row => row.item ?? row.entity)
    // One machine whose own bill ends in the resource fails the pair whatever the other machine is: building both only
    // draws more from the same stock.
    for (const row of missing) {
      if (row.unknown) continue
      const alone = billFor([row])
      const leaf = alone?.acquisition.find(entry => entry.item_name === resource)
      if (leaf) return { ...base, missing: [row.item], status: VERDICT.INFEASIBLE, bill: alone, shortfall: leaf.count }
    }
    if (missing.length === 0) return { ...base, missing: [], status: smelter ? VERDICT.FEASIBLE : VERDICT.UNKNOWN }
    if (missing.some(row => row.unknown)) return { ...base, missing: names, status: VERDICT.UNKNOWN }
    const joint = billFor(missing)
    if (!joint) return { ...base, missing: names, status: VERDICT.UNKNOWN }
    const leaf = joint.acquisition.find(entry => entry.item_name === resource)
    const status = leaf ? VERDICT.INFEASIBLE
      : smelter && joint.acquisition.every(entry => rawItems.has(entry.item_name)) ? VERDICT.FEASIBLE : VERDICT.UNKNOWN
    return { ...base, missing: names, status, bill: joint, ...(leaf ? { shortfall: leaf.count } : {}) }
  }
  const verdict = pairs.length === 0 ? VERDICT.UNKNOWN
    : pairs.every(pair => pair.status === VERDICT.INFEASIBLE) ? VERDICT.INFEASIBLE
      : pairs.some(pair => pair.status === VERDICT.FEASIBLE) ? VERDICT.FEASIBLE : VERDICT.UNKNOWN
  return { verdict, resource, reserved, pairs }
}

function ingredientText(rows) {
  return rows.map(row => `${row.count} ${row.item_name}`).join(' + ')
}

// A craft bill as facts: each recipe once, its per-craft ingredients, and how many crafts (or smelts) the bill needs.
function billText(nodes) {
  return nodes.map(node => `${node.item_name}${node.crafts > 1 ? ` x${node.crafts}` : ''}${node.hand_craftable ? '' : ' (smelted/machine-made)'} = ${ingredientText(node.ingredients)}`).join('; ')
}

/** The planner-facing refusal text for an infeasible verdict: machine, bill, what is held, the shortfall, what would change it. */
export function directFeedBootstrapMessage(verdict, { stepNumber, inventory = {} } = {}) {
  const infeasible = verdict.pairs.filter(pair => pair.status === VERDICT.INFEASIBLE)
  const distinct = []
  for (const pair of infeasible) {
    const signature = JSON.stringify([pair.missing, pair.bill.nodes.map(node => [node.item_name, node.crafts])])
    if (!distinct.some(row => row.signature === signature)) distinct.push({ signature, pair })
  }
  distinct.sort((a, b) => a.pair.shortfall - b.pair.shortfall)
  const resource = verdict.resource
  const parts = distinct.slice(0, PAIR_MESSAGE_LIMIT).map(({ pair }) => {
    const inputs = [...new Set(pair.bill.nodes.flatMap(node => node.ingredients.map(row => row.item_name)))]
    const heldText = inputs.map(item => [item, inventory[item] ?? 0]).filter(([, count]) => count > 0).map(([item, count]) => `${item} ${count}`).join(', ') || 'none of its inputs'
    return `crafting ${pair.missing.join(' + ')} (${billText(pair.bill.nodes)}) from what you hold (${heldText}) still needs ${pair.shortfall} ${resource}`
  })
  const others = distinct.slice(PAIR_MESSAGE_LIMIT).map(({ pair }) => `${pair.missing.join(' + ')} needs ${pair.shortfall} ${resource}`)
  const pairs = infeasible.map(pair => (pair.smelter ? `${pair.drill}/${pair.smelter}` : pair.drill))
  const reserved = Object.entries(verdict.reserved ?? {}).map(([item, count]) => `${item} ${count}`)
  return `${DIRECT_FEED_BOOTSTRAP_CODE}: step ${stepNumber} selects materialSupply direct_feed for ${resource}, which forbids hand-mining or hand-supplying ${resource}, but its cell cannot be built without it. `
    + `Native facts: ${parts.join('; and ')}${others.length ? `; the other candidate bills are larger (${others.join(', ')})` : ''}. `
    + `Every candidate drill/smelter pair that is not already held or placed outside obligations.preserve ends this way (${pairs.join(', ')})`
    + `${reserved.length ? `; stock protected by this step's checkpoint is excluded (${reserved.join(', ')})` : ''}. `
    + `Nothing was committed. Resubmit with materialSupply manual_bootstrap for ${resource} (a finite bootstrap in a separate furnace), or with the missing machine held or funded first.`
}
