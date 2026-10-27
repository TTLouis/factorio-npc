// Commit-time reads for the direct_feed bootstrap check (direct-feed-bootstrap.mjs holds the verdict). Only raw native answers
// read through the ordinary observation path are used; a failed, clipped or unexpected answer is "unknown", never a fact.
import { parseInventoryCounts } from './inventory-facts.mjs'
import { directFeedBootstrapMessage, directFeedBootstrapVerdict, DIRECT_FEED_BOOTSTRAP_CODE, VERDICT } from './direct-feed-bootstrap.mjs'

export const DIRECT_FEED_BOOTSTRAP_LIMITS = Object.freeze({ recipe_reads: 40, placements: 8, raw_chars: 200000 })

class Unreadable extends Error {}

async function readJson(agent, cache, tool, args) {
  const key = JSON.stringify([tool, args])
  if (cache.has(key)) return cache.get(key)
  let raw
  try { raw = String(await agent.rcon.command(agent.observationToolCommand(tool, args))) }
  catch { raw = '' }
  if (raw.length > DIRECT_FEED_BOOTSTRAP_LIMITS.raw_chars) raw = ''
  let value
  try { value = JSON.parse(raw) }
  catch { value = undefined }
  cache.set(key, { raw, value })
  return cache.get(key)
}

// The recipe closure of one item: its canonical recipe row and every ingredient's, with raw items named. The same rules the
// production task uses (production-task-runtime.mjs factsFor): a natural resource outranks recycling recipes.
async function recipeClosure(agent, cache, item, rows, rawItems, budget) {
  const queue = [item]; const seen = new Set()
  while (queue.length) {
    const next = queue.shift()
    if (seen.has(next)) continue
    seen.add(next)
    if (rows.has(next) || rawItems.has(next)) continue
    if (budget.reads >= DIRECT_FEED_BOOTSTRAP_LIMITS.recipe_reads) throw new Unreadable('recipe_read_limit')
    budget.reads++
    const { value: detail } = await readJson(agent, cache, 'getRecipeDetails', { item_or_recipe: next, requested_count: 1 })
    if (!detail || typeof detail !== 'object') throw new Unreadable('recipe_unreadable')
    if (detail.truncated === true || detail.recipes?.some(row => row?.crafting_machines_truncated === true)) throw new Unreadable('recipe_incomplete')
    const canonical = Array.isArray(detail.recipes) ? detail.recipes.find(row => row?.name === next) : undefined
    if (detail.mined_from?.length || (detail.harvested_from?.length && canonical?.enabled !== true)) { rawItems.add(next); continue }
    if (detail.found === false && detail.code === 'no_recipe') { rawItems.add(next); continue }
    if (detail.found !== true || !Array.isArray(detail.recipes)) throw new Unreadable('recipe_unreadable')
    const row = canonical ?? (detail.recipes.length === 1 ? detail.recipes[0] : undefined)
    if (!row || !Array.isArray(row.ingredients)) throw new Unreadable('recipe_ambiguous')
    rows.set(next, row)
    // A locked recipe is not expanded: it is no way to build the cell now.
    if (row.enabled !== true || row.applicability?.state === 'unavailable') continue
    queue.push(...row.ingredients.map(ingredient => ingredient?.name).filter(name => typeof name === 'string'))
  }
}

// NPC-placed machines that the step does not preserve and that the game still shows under that unit number and prototype.
async function placedMachines(agent, cache, names, preserve) {
  const key = agent.activePlanKey?.()
  const placements = key ? agent.memory.authorizationState?.(key)?.world?.npc_placements : undefined
  const counts = {}
  if (!Array.isArray(placements)) return counts
  const candidates = placements.filter(row => names.has(row.entity_name) && !preserve.includes(row.unit_number)).slice(-DIRECT_FEED_BOOTSTRAP_LIMITS.placements)
  for (const placement of candidates) {
    const { value } = await readJson(agent, cache, 'getEntityStatus', { unit_number: placement.unit_number })
    if (value?.found === true && value.entity?.unit_number === placement.unit_number && value.entity.name === placement.entity_name) {
      counts[placement.entity_name] = (counts[placement.entity_name] ?? 0) + 1
    }
  }
  return counts
}

async function factsFor(agent, cache, resource, preserve) {
  const { value: mining } = await readJson(agent, cache, 'getMiningDetails', { resource_or_item: resource })
  if (mining?.found !== true || mining.truncated === true || !Array.isArray(mining.resources) || mining.resources.length === 0
    || mining.resources.some(row => row?.drills_truncated === true || !Array.isArray(row?.drills))) return undefined
  const drills = [...new Set(mining.resources.flatMap(row => row.drills.map(drill => drill?.name)))]
  if (drills.length === 0 || drills.some(name => typeof name !== 'string')) return undefined
  const { raw: inventoryRaw } = await readJson(agent, cache, 'getInventoryItems', {})
  const counts = parseInventoryCounts(inventoryRaw)
  if (!counts) return undefined
  const inventory = Object.fromEntries(counts)
  const rows = new Map(); const rawItems = new Set([resource]); const budget = { reads: 0 }
  // A recipe closure is needed only for a drill the NPC would have to craft; held ones need no bill.
  for (const drill of drills) {
    if ((inventory[drill] ?? 0) >= 1) continue
    try { await recipeClosure(agent, cache, drill, rows, rawItems, budget) }
    catch (error) { if (!(error instanceof Unreadable)) throw error }
  }
  const smelters = [...rows.values()].filter(row => row.crafting_machines?.length > 0).flatMap(row => row.crafting_machines.map(machine => machine?.name))
  const names = new Set([...drills, ...smelters.filter(name => typeof name === 'string')])
  const placed = await placedMachines(agent, cache, names, preserve)
  return { drills, recipes: [...rows.values()], raw: [...rawItems], inventory, placed }
}

/**
 * A refusal ({ code, message, details }) when a direct_feed step of this planner draft cannot bootstrap its cell without the
 * resource it forbids by hand, else undefined. Nothing here changes the plan: the planner corrects its own draft.
 */
export async function directFeedBootstrapRefusal(agent, plan) {
  const guidance = Array.isArray(plan.executionGuidance) ? plan.executionGuidance : []
  const cache = new Map()
  for (const [index, brief] of guidance.entries()) {
    const supply = brief?.materialSupply
    if (supply?.mode !== 'direct_feed') continue
    const completion = plan.stepCompletions?.[index]
    const preserve = Array.isArray(completion?.obligations?.preserve) ? completion.obligations.preserve : []
    const protect = (completion?.checkpoint?.requirements ?? []).filter(row => row?.kind === 'inventory_count')
    const facts = await factsFor(agent, cache, supply.resource, preserve)
    const verdict = facts ? directFeedBootstrapVerdict({ resource: supply.resource, protect, ...facts }) : { verdict: VERDICT.UNKNOWN, resource: supply.resource, reason: 'facts_unreadable', pairs: [] }
    await agent.traceEvent('plan.direct_feed_bootstrap_checked', { request_id: agent.traceRequest?.id, step_index: index, resource: supply.resource,
      verdict: verdict.verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), preserved: preserve,
      pairs: verdict.pairs.slice(0, 8).map(pair => ({ drill: pair.drill, smelter: pair.smelter, missing: pair.missing, status: pair.status, shortfall: pair.shortfall })) })
    if (verdict.verdict !== VERDICT.INFEASIBLE) continue
    return { code: DIRECT_FEED_BOOTSTRAP_CODE, message: directFeedBootstrapMessage(verdict, { stepNumber: index + 1, inventory: facts.inventory }),
      details: { step_index: index, resource: supply.resource } }
  }
  return undefined
}
