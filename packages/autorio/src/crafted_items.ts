import type { LuaForce, LuaSurface } from 'factorio:runtime'
// Per-force counter of items the NPC really hand-crafted.
//
// Why this exists: Factorio 2.0.77 records a character's hand crafting in the
// force item production statistics only on the ingredient side (output counts).
// The products never reach the input counts when the crafter is a standalone
// `character` with no LuaPlayer attached, and `on_player_crafted_item` never
// fires for it either (measured in tests/factorio hand_craft_statistics_cell.py).
// Active craft-item research triggers receive a completion-only statistics
// bridge below; the overlap ledger keeps that flow from counting twice.
// Without this counter a goal such as "items_produced stone-furnace >= 1" can
// never be met by the NPC's own crafting.
//
// The count is credited only from the native crafting queue: when crafts leave
// the queue because the engine finished them, never from the order. Work the
// harness cancels is not credited.

import { record_hand_crafted_tick } from './hand_work'

export interface CraftedItemsStorage {
  sgluna_crafted_items?: Record<number, Record<string, number>>
  sgluna_craft_trigger_statistics?: Record<number, Record<string, number>>
}

declare const storage: CraftedItemsStorage

/** Remaining crafts per recipe name, as read from a native crafting queue. */
export type CraftQueueTotals = Record<string, number>

interface QueueEntry {
  recipe: string
  count: number
}

interface RecipeProduct {
  type: string
  name: string
  amount?: number
  probability?: number
}

export function crafted_item_count(force_index: number, item_name: string): number {
  return storage.sgluna_crafted_items?.[force_index]?.[item_name] ?? 0
}

export function record_crafted_items(force_index: number, item_name: string, count: number) {
  if (!(count > 0)) return
  // A rate goal's window must not contain the NPC crafting the measured item.
  record_hand_crafted_tick(force_index, item_name)
  const all = storage.sgluna_crafted_items ?? {}
  storage.sgluna_crafted_items = all
  const per_force = all[force_index] ?? {}
  all[force_index] = per_force
  per_force[item_name] = (per_force[item_name] ?? 0) + count
}

// Only completed native crafts may supply the engine's missing trigger flow.
// Keep the old counter for ordinary products; track overlap so goals count once.
export function craft_trigger_statistics_count(force_index: number, item_name: string): number {
  return storage.sgluna_craft_trigger_statistics?.[force_index]?.[item_name] ?? 0
}

export function credit_craft_trigger_statistics(force: LuaForce, surface: LuaSurface, item_name: string, count: number, request_id: string) {
  if (!(count > 0)) return
  let needed = false
  for (const [, technology] of pairs(force.technologies)) {
    const trigger = technology.prototype.research_trigger as any
    if (technology.researched || !technology.enabled || trigger?.type !== 'craft-item') continue
    const filter = trigger.item
    const name = typeof filter === 'string' ? filter : filter?.name
    if (name !== item_name || (filter?.quality !== undefined && filter.quality !== 'normal')) continue
    let ready = true
    for (const [, prerequisite] of pairs(technology.prerequisites)) {
      if (!prerequisite.researched) ready = false
    }
    if (ready) needed = true
  }
  if (!needed) return
  force.get_item_production_statistics(surface).on_flow(item_name, count)
  const all = storage.sgluna_craft_trigger_statistics ?? {}
  storage.sgluna_craft_trigger_statistics = all
  const per_force = all[force.index] ?? {}
  all[force.index] = per_force
  per_force[item_name] = (per_force[item_name] ?? 0) + count
  log(`[AUTORIO] crafting.trigger_flow request_id=${request_id} reason=completed_native_craft item_name=${item_name} count=${count}`)
}

export function craft_queue_totals(queue: readonly QueueEntry[]): CraftQueueTotals {
  const totals: CraftQueueTotals = {}
  for (const entry of queue) {
    totals[entry.recipe] = (totals[entry.recipe] ?? 0) + entry.count
  }
  return totals
}

// Items one craft of the recipe puts in the inventory. Probabilistic or
// variable-amount products are skipped rather than guessed: only what a craft
// deterministically yields is counted.
function certain_item_products(recipe_name: string): Array<{ name: string, amount: number }> {
  const recipe = (prototypes.recipe as unknown as Record<string, { products?: RecipeProduct[] } | undefined>)[recipe_name]
  const found: Array<{ name: string, amount: number }> = []
  for (const product of recipe?.products ?? []) {
    if (product.type !== 'item' || typeof product.amount !== 'number' || product.amount <= 0) continue
    if (product.probability !== undefined && product.probability < 1) continue
    found.push({ name: product.name, amount: product.amount })
  }
  return found
}

/**
 * Credit the crafts that left the queue between two snapshots. Queue entries
 * only shrink through completion (or a cancellation, which the caller settles
 * before it cancels, so a cancelled craft is never seen here as completed).
 * Returns the number of crafts credited.
 */
export function credit_finished_crafts(force_index: number, previous: CraftQueueTotals, current: CraftQueueTotals, on_product?: (item_name: string, count: number) => void): number {
  let crafts = 0
  for (const [recipe_name, before] of Object.entries(previous)) {
    const finished = before - (current[recipe_name] ?? 0)
    if (!(finished > 0)) continue
    crafts += finished
    for (const product of certain_item_products(recipe_name)) {
      record_crafted_items(force_index, product.name, finished * product.amount)
      on_product?.(product.name, finished * product.amount)
    }
  }
  return crafts
}
