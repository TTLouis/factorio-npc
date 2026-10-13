// Batch stock ledger (docs/validation/GOAL_PURSUIT_LESSONS_AND_OG_PORT_PLAN_2026-10-12.md, "Adapt: batch-wide stock accounting").
//
// The mod preflights every operation of a batch in isolation against the world as it is now. Two crafts that each need
// 20 of the 25 iron plates held both pass; the first one runs, the second fails at execution and cancels the batch with
// partial effects. This module is the batch-wide check: it replays the ORDERED operations over the stock the harness
// observed, so an operation earlier in the same batch both uses up stock and supplies stock for the later ones.
//
// It is a pure function of facts the harness already holds: the operations, the per-operation mod preflight results, the
// observed main inventory, and the recipe facts of the handoff cache (handoff-packet.mjs). Nothing here reads the game.
//
// What an operation does to the stock is declared ONCE, by meaning, in OPERATION_STOCK_EFFECTS below, keyed by operation
// kind. A kind with no entry is `unaccounted` and fails closed (the batch is refused); batch-stock.test.mjs fails when an
// approved operation has no entry, so a new operation cannot silently bypass the ledger.
//
// Supply rules (what an earlier operation may be counted as producing):
//  - counted: the product of a hand craft the recipe facts describe exactly; a gather / resource mining count (the
//    operation only completes once that many units are mined); a harvest count (completion is verified against the
//    inventory); what a withdrawal from an exact machine is expected to move, bounded by the stock the preflight read.
//  - never counted: anything whose yield is not deterministic (mining an entity, clearing an area, taking from a player,
//    a withdrawal with no read of the source). Such an operation is recorded as `uncertain`: it does not supply, but a
//    shortage after it is reported with it named, because it is the operation the model should have settled first.
//  - an operation whose facts are missing (a recipe nobody read) is `unaccounted` with `may_produce`: a shortage after it is
//    NOT proven, so it is not refused (the execution-time checks stay authoritative, as they were before this ledger).
//
// Engine semantics kept as they are: a transfer that moves part of the request succeeds, and only a transfer that finds
// nothing fails. So a supply or withdrawal claims what is left (never more) and is short only when nothing is left.
//
// A shortage is refusable only when the batch itself caused it: the operation was fine alone (observed stock covered it, or
// the mod already rejected it and an earlier operation of this batch bears on the same item) and no earlier operation has an
// unknown effect that could have produced the item.

import { expandableRecipe } from './handoff-packet.mjs'
import { REFUSAL_CLASS } from './refusal-class.mjs'

export const BATCH_STOCK_INSUFFICIENT_CODE = 'batch_stock_insufficient'
export const BATCH_STOCK_UNACCOUNTED_CODE = 'batch_stock_unaccounted'

export const STOCK_STATUS = Object.freeze({
  COVERED: 'covered',
  COVERED_BY_EARLIER_OP: 'covered_by_earlier_op',
  SHORT: 'short',
  UNACCOUNTED: 'unaccounted',
})

const MAX_CRAFT_DEPTH = 6
const MAX_REPORTED_ITEMS = 8
const MAX_REPORTED_OPERATIONS = 16

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// --- the one table: what each operation kind does to the actor's stock -----------------------------------------------
//
// effect(operation, preflightResult) returns any of:
//   takes:        [{ item_name, count, mode }]  from the actor's main inventory. mode 'all': the operation fails unless the
//                 whole count is there. mode 'some': it moves what is there and fails only when none is.
//   withdraw:     { unit_number, item_name, requested, source_count, expected_moved }  out of an exact machine/container
//   craft:        { recipe_name, crafts }       native hand craft (intermediates are crafted from held stock as needed)
//   gives:        [{ item_name, count }]        certain production into the actor's inventory
//   uncertain:    reason string                 production that is not deterministic: recorded, never counted as supply
//                 (`uncertain_items` names the only items it can yield; without it any item could come out)
//   unverifiable: { reason, may_produce }       the facts the ledger needs were not available
//   stack_moved:  [item_name]                   a whole stack leaves the main inventory (the remaining count is unknown)
// `claims` says whether the operation competes for stock, which decides when the ledger is worth running.

const NONE = Object.freeze({ claims: false, effect: () => ({}) })
const UNCERTAIN_YIELD = Object.freeze({ claims: false, effect: operation => ({ uncertain: `${operation.name}_yield_not_deterministic` }) })

function transferEffect(operation, fact) {
  const args = operation.args ?? {}
  const item_name = text(args.item_name)
  const requested = count(args.max_count)
  if (!item_name || requested === undefined || typeof args.to_entity !== 'boolean') return { unverifiable: { reason: 'transfer_arguments_unreadable', may_produce: false } }
  if (args.to_entity) return { takes: [{ item_name, count: requested, mode: 'some' }] }
  // A withdrawal is supply only where the harness read the source: the mod's exact-target transfer facts.
  const transfer = fact?.transfer
  const item = transfer?.items?.[0]
  if (operation.name === 'move_items_exact' && transfer?.direction === 'from_entity' && fact?.target?.unit_number === args.unit_number
    && item?.item_name === item_name && Number.isSafeInteger(item.source_count) && item.source_count >= 0) {
    const expected = Number.isSafeInteger(item.expected_moved) && item.expected_moved >= 0 ? item.expected_moved : 0
    return { withdraw: { unit_number: args.unit_number, item_name, requested, source_count: item.source_count, expected_moved: expected } }
  }
  return { uncertain: `${operation.name}_source_not_read`, uncertain_items: [item_name] }
}

function placementEffect(_operation, fact) {
  // Placement uses the item the mod's own resolver named (placement_item), never a table of ours.
  const item_name = text(fact?.placement_item?.item_name)
  const amount = count(fact?.placement_item?.count)
  if (!item_name || amount === undefined) return { unverifiable: { reason: 'placement_item_not_reported', may_produce: false } }
  return { takes: [{ item_name, count: amount, mode: 'all' }] }
}

function yieldEffect(resourceKey, reason) {
  return Object.freeze({
    claims: false,
    effect: (operation) => {
      const item_name = text(operation.args?.[resourceKey])
      const amount = count(operation.args?.count ?? 1)
      return item_name && amount !== undefined ? { gives: [{ item_name, count: amount }] } : { uncertain: reason }
    },
  })
}

const EQUIP = Object.freeze({
  claims: true,
  effect: (operation) => {
    const item_name = text(operation.args?.item_name)
    if (!item_name) return { unverifiable: { reason: 'equip_item_unreadable', may_produce: false } }
    // The engine swaps the first stack of the item into the slot: at least one leaves, and the rest of that stack too.
    return { takes: [{ item_name, count: 1, mode: 'all' }], stack_moved: [item_name] }
  },
})

export const OPERATION_STOCK_EFFECTS = Object.freeze({
  // Navigation, combat posture, research and waiting neither use nor yield items.
  walk_to_entity: NONE,
  walk_to_entity_exact: NONE,
  walk_to_position: NONE,
  walk_to_player: NONE,
  follow_player: NONE,
  stop_follow_player: NONE,
  set_auto_defense: NONE,
  select_weapon_slot: NONE,
  rotate_entity: NONE,
  set_machine_recipe: NONE,
  launch_rocket: NONE,
  attack_nearest_enemy: NONE,
  clear_enemy_area: NONE,
  research_technology: NONE,
  wait: NONE,
  equip_weapon: EQUIP,
  equip_ammo: EQUIP,
  equip_armor: EQUIP,
  // Mining an entity or clearing an area yields whatever the entity or its contents are: not deterministic here.
  mine_entity: UNCERTAIN_YIELD,
  mine_entity_exact: UNCERTAIN_YIELD,
  clear_construction_area: UNCERTAIN_YIELD,
  // A resource mining/gather count completes only once that many resource units are mined, one item each.
  gather_resource: yieldEffect('resource_name', 'gather_resource_arguments_unreadable'),
  mine_resource_at: yieldEffect('resource_name', 'mine_resource_at_arguments_unreadable'),
  // A harvest completes when the inventory gained the requested count of the product (harvest.ts verified_gain).
  harvest_product: yieldEffect('product_name', 'harvest_product_arguments_unreadable'),
  supply_entity: Object.freeze({
    claims: true,
    effect: (operation) => {
      const items = Array.isArray(operation.args?.items) ? operation.args.items : []
      const takes = items.map(entry => ({ item_name: text(entry?.item_name), count: count(entry?.count), mode: 'some' }))
      if (takes.length === 0 || takes.some(entry => !entry.item_name || entry.count === undefined)) return { unverifiable: { reason: 'supply_items_unreadable', may_produce: false } }
      return { takes }
    },
  }),
  move_items: Object.freeze({ claims: true, effect: transferEffect }),
  move_items_exact: Object.freeze({ claims: true, effect: transferEffect }),
  move_items_with_player: Object.freeze({
    claims: true,
    effect: (operation) => {
      const args = operation.args ?? {}
      const item_name = text(args.item_name)
      const requested = count(args.max_count)
      if (!item_name || requested === undefined || typeof args.to_player !== 'boolean') return { unverifiable: { reason: 'transfer_arguments_unreadable', may_produce: false } }
      return args.to_player ? { takes: [{ item_name, count: requested, mode: 'some' }] } : { uncertain: 'player_inventory_yield_not_observed', uncertain_items: [item_name] }
    },
  }),
  place_entity: Object.freeze({ claims: true, effect: placementEffect }),
  place_candidate: Object.freeze({ claims: true, effect: placementEffect }),
  // The materials of a validated construction plan live in the mod's validation record, not in the arguments.
  execute_construction_plan: Object.freeze({ claims: true, effect: () => ({ unverifiable: { reason: 'construction_materials_not_declared', may_produce: false } }) }),
  craft_item: Object.freeze({
    claims: true,
    effect: (operation) => {
      const recipe_name = text(operation.args?.item_name)
      const crafts = count(operation.args?.count ?? 1)
      if (!recipe_name || crafts === undefined) return { unverifiable: { reason: 'craft_arguments_unreadable', may_produce: true } }
      return { craft: { recipe_name, crafts } }
    },
  }),
})

/** Whether the operation competes for stock. An unknown kind is treated as claiming: it must reach the ledger to fail closed. */
export function stockClaimingOperation(name) {
  return Object.hasOwn(OPERATION_STOCK_EFFECTS, name) ? OPERATION_STOCK_EFFECTS[name].claims : true
}

// --- how an ingredient that is not held can still be had: hand-crafting it from held stock --------------------------------

// raw: nothing can make it by hand (or the game has no recipe for it); craftable: one exact hand recipe; unknown: not decidable.
function intermediateSource(item, recipes, noRecipeItems) {
  const producing = recipes.filter(recipe => recipe.products.some(product => product.name === item && product.type === 'item'))
  if (producing.length === 0) return noRecipeItems?.has?.(item) ? { kind: 'raw' } : { kind: 'unknown', reason: 'recipe_unavailable' }
  const hand = producing.filter(recipe => recipe.hand_craftable === true)
  if (hand.length === 0) return producing.every(recipe => recipe.hand_craftable === false) ? { kind: 'raw' } : { kind: 'unknown', reason: 'hand_craftability_unknown' }
  const expansion = expandableRecipe(item, hand)
  return expansion ? { kind: 'craftable', recipe: expansion.recipe, output: expansion.output } : { kind: 'unknown', reason: 'recipe_not_derivable' }
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right)
}

/**
 * Replay `operations` in order over the observed stock.
 *
 * @param {object} input
 * @param {Array<{name: string, args?: object}>} input.operations the batch, in order
 * @param {Array<object>} [input.preflight] the mod's preflight result per operation (same index); facts only
 * @param {Map<string, number>} input.inventory the observed main inventory of the actor
 * @param {Array<object>} [input.recipes] recipe facts (handoff cache entries)
 * @param {Set<string>} [input.noRecipeItems] items the game was read to have no recipe for
 */
export function evaluateBatchStock({ operations, preflight = [], inventory, recipes = [], noRecipeItems }) {
  const initial = new Map(inventory)
  const observed = new Map(inventory)
  const produced = new Map() // item -> [{ op, count }], oldest first
  const entityStock = new Map() // `entity:${unit}:${item}` -> count not yet claimed
  const touches = new Map() // item or entity key -> operation indexes that took from or gave to it
  const uncertainOps = []
  const blockingOps = [] // operations with an unknown effect that may have produced anything
  const stackMoved = new Set()
  const verdicts = []

  const touch = (key, op) => {
    if (!touches.has(key)) touches.set(key, new Set())
    touches.get(key).add(op)
  }
  const available = item => (observed.get(item) ?? 0) + (produced.get(item) ?? []).reduce((sum, lot) => sum + lot.count, 0)
  const take = (item, amount, op) => {
    const fromObserved = Math.min(observed.get(item) ?? 0, amount)
    observed.set(item, (observed.get(item) ?? 0) - fromObserved)
    let remaining = amount - fromObserved
    const fromOps = []
    for (const lot of produced.get(item) ?? []) {
      if (remaining <= 0) break
      const used = Math.min(lot.count, remaining)
      if (used <= 0) continue
      lot.count -= used
      remaining -= used
      fromOps.push(lot.op)
    }
    if (amount - remaining > 0) touch(item, op)
    return { taken: amount - remaining, fromOps }
  }
  const give = (item, amount, op) => {
    if (amount <= 0) return
    if (!produced.has(item)) produced.set(item, [])
    produced.get(item).push({ op, count: amount })
    touch(item, op)
  }

  operations.forEach((operation, index) => {
    const name = typeof operation?.name === 'string' ? operation.name : ''
    const verdict = { operation_index: index, operation: name, status: STOCK_STATUS.COVERED, supplied_by: [], short: [], proven: !blockingOps.some(op => op < index) }
    verdicts.push(verdict)
    if (!Object.hasOwn(OPERATION_STOCK_EFFECTS, name)) {
      verdict.status = STOCK_STATUS.UNACCOUNTED
      verdict.unaccounted = { reason: 'unknown_operation_kind', fail_closed: true }
      blockingOps.push(index)
      return
    }
    const effect = OPERATION_STOCK_EFFECTS[name].effect(operation, preflight[index]) ?? {}
    const touchedBy = key => sortedUnique([...(touches.get(key) ?? []), ...uncertainOps]).filter(op => op < index)
    const recordShort = ({ touch_key, ...entry }) => {
      verdict.short.push({ ...entry, touched_by: touchedBy(touch_key ?? entry.item_name) })
    }
    const supplied = (item, ops) => {
      for (const op of ops) verdict.supplied_by.push({ item_name: item, operation_index: op })
    }

    if (effect.withdraw) {
      const { unit_number, item_name, requested, source_count, expected_moved } = effect.withdraw
      const key = `entity:${unit_number}:${item_name}`
      const remaining = entityStock.has(key) ? entityStock.get(key) : source_count
      if (remaining <= 0) {
        recordShort({ item_name, needed: requested, available: 0, short_by: requested, source: 'entity', unit_number, touch_key: key, isolated_ok: source_count >= 1 })
        entityStock.set(key, 0)
      }
      else {
        // The earlier maximum is claimed, not what it is expected to move: stock can grow before execution, and the earlier
        // request may then take more than its preflight estimate. Only the expected amount counts as supply.
        const claimed = Math.min(requested, remaining)
        entityStock.set(key, remaining - claimed)
        touch(key, index)
        give(item_name, Math.min(expected_moved, claimed), index)
      }
    }

    for (const entry of effect.takes ?? []) {
      if (stackMoved.has(entry.item_name)) {
        verdict.unaccounted = { reason: 'stack_moved_by_equip', fail_closed: false }
        continue
      }
      const before = available(entry.item_name)
      const required = entry.mode === 'all' ? entry.count : 1
      if (before < required) {
        recordShort({
          item_name: entry.item_name,
          needed: entry.count,
          available: before,
          short_by: entry.count - before,
          source: 'actor',
          isolated_ok: (initial.get(entry.item_name) ?? 0) >= required,
        })
      }
      const { fromOps } = take(entry.item_name, Math.min(entry.count, before), index)
      supplied(entry.item_name, fromOps)
    }
    for (const item_name of effect.stack_moved ?? []) stackMoved.add(item_name)

    if (effect.craft) {
      const recipe = recipes.find(candidate => candidate.name === effect.craft.recipe_name && candidate.complete === true)
      const ingredients = recipe?.ingredients ?? []
      const products = (recipe?.products ?? []).filter(product => product.type === 'item')
      const exact = recipe && ingredients.length > 0 && ingredients.every(ingredient => ingredient.type === 'item' && ingredient.amount > 0) && products.length > 0
      if (!exact) {
        effect.unverifiable = { reason: recipe ? 'recipe_not_derivable' : 'recipe_unavailable', may_produce: true }
      }
      else {
        const leaves = new Map() // raw item -> { needed, available_before, short_by }
        let unknown
        const demand = (item, amount, depth, trail) => {
          const before = available(item)
          const { taken, fromOps } = take(item, Math.min(amount, before), index)
          supplied(item, fromOps)
          const remaining = amount - taken
          if (remaining <= 0) return
          const source = depth >= MAX_CRAFT_DEPTH || trail.has(item) ? { kind: 'unknown', reason: 'recipe_depth_or_cycle' } : intermediateSource(item, recipes, noRecipeItems)
          if (source.kind === 'craftable') {
            const crafts = Math.ceil(remaining / source.output)
            const nextTrail = new Set(trail).add(item)
            for (const ingredient of source.recipe.ingredients) demand(ingredient.name, ingredient.amount * crafts, depth + 1, nextTrail)
            // The crafted surplus stays in the inventory (a recipe yielding two per craft, three needed).
            give(item, crafts * source.output - remaining, index)
            return
          }
          if (source.kind === 'unknown') {
            unknown ??= source.reason
            return
          }
          const leaf = leaves.get(item) ?? { needed: 0, available_before: before, short_by: 0 }
          leaf.needed += amount
          leaf.short_by += remaining
          leaves.set(item, leaf)
        }
        for (const ingredient of ingredients) demand(ingredient.name, ingredient.amount * effect.craft.crafts, 0, new Set([effect.craft.recipe_name]))
        if (unknown) {
          effect.unverifiable = { reason: unknown, may_produce: true }
        }
        else if (leaves.size > 0) {
          for (const [item_name, leaf] of leaves) {
            recordShort({ item_name, needed: leaf.needed, available: leaf.available_before, short_by: leaf.short_by, source: 'actor', isolated_ok: (initial.get(item_name) ?? 0) >= leaf.needed })
          }
        }
        else {
          for (const product of products) {
            const certain = Number.isFinite(product.amount) && product.amount > 0 && product.amount_min === undefined && product.amount_max === undefined
              && (product.probability === undefined || product.probability === 1)
            if (certain) give(product.name, product.amount * effect.craft.crafts, index)
            else {
              effect.uncertain = 'craft_product_not_deterministic'
              effect.uncertain_items = [...(effect.uncertain_items ?? []), product.name]
            }
          }
        }
      }
    }

    for (const entry of effect.gives ?? []) give(entry.item_name, entry.count, index)
    if (effect.uncertain) {
      // An unbounded yield (mining an entity) may have produced any item; a bounded one only the items it names.
      if (effect.uncertain_items) for (const item_name of effect.uncertain_items) touch(item_name, index)
      else uncertainOps.push(index)
      verdict.uncertain = effect.uncertain
      if (effect.uncertain_items) verdict.uncertain_items = effect.uncertain_items
    }
    if (effect.unverifiable) {
      verdict.unaccounted = { reason: effect.unverifiable.reason, fail_closed: false }
      if (effect.unverifiable.may_produce) blockingOps.push(index)
    }
    if (verdict.short.length > 0) verdict.status = STOCK_STATUS.SHORT
    else if (verdict.unaccounted) verdict.status = STOCK_STATUS.UNACCOUNTED
    else if (verdict.supplied_by.length > 0) verdict.status = STOCK_STATUS.COVERED_BY_EARLIER_OP
  })

  // Per item the earliest operation that supplied it, with the operation's name.
  for (const verdict of verdicts) {
    const first = new Map()
    for (const entry of verdict.supplied_by) first.set(entry.item_name, Math.min(first.get(entry.item_name) ?? Infinity, entry.operation_index))
    verdict.dependencies = [...first].map(([item_name, operation_index]) => ({ item_name, operation_index, operation: verdicts[operation_index]?.operation }))
  }

  return {
    verdicts,
    short: verdicts.filter(verdict => verdict.status === STOCK_STATUS.SHORT).map(verdict => ({
      operation_index: verdict.operation_index,
      operation: verdict.operation,
      proven: verdict.proven,
      items: verdict.short.slice(0, MAX_REPORTED_ITEMS),
    })),
    deferred_by_earlier_op: verdicts.filter(verdict => verdict.status === STOCK_STATUS.COVERED_BY_EARLIER_OP).map(verdict => ({
      operation_index: verdict.operation_index,
      operation: verdict.operation,
      dependencies: verdict.dependencies.slice(0, MAX_REPORTED_ITEMS),
    })),
    unaccounted: verdicts.filter(verdict => verdict.unaccounted).map(verdict => ({
      operation_index: verdict.operation_index,
      operation: verdict.operation,
      reason: verdict.unaccounted.reason,
      fail_closed: verdict.unaccounted.fail_closed,
    })),
    uncertain: verdicts.filter(verdict => verdict.uncertain).map(verdict => ({
      operation_index: verdict.operation_index,
      operation: verdict.operation,
      reason: verdict.uncertain,
      ...(verdict.uncertain_items ? { items: verdict.uncertain_items } : {}),
    })),
  }
}

/** The per-operation lines for the trace, bounded. */
export function batchStockOperationLines(report) {
  return report.verdicts.slice(0, MAX_REPORTED_OPERATIONS).map(verdict => ({ index: verdict.operation_index, operation: verdict.operation, status: verdict.status }))
}

function shortFragment(item) {
  const where = item.source === 'entity' ? ` out of unit ${item.unit_number}` : ''
  return `${item.item_name}${where}: needs ${item.needed}, ${item.available} left`
}

/**
 * What the loop does with the report. `held` is the set of operation indexes whose own mod preflight rejected a missing stock
 * item (supply_missing, placement_item_missing) and was held for this ledger to settle.
 *
 *   { action: 'proceed', reason }                       nothing refusable: held operations are settled by the report
 *   { action: 'standalone', operation_index, reason }   a held operation short with nothing in this batch bearing on it:
 *                                                        the mod's own rejection stands
 *   { action: 'refuse', refusal, reason }               the batch is internally inconsistent
 */
export function batchStockDecision(report, held = new Set()) {
  const failClosed = report.unaccounted.find(entry => entry.fail_closed)
  if (failClosed) {
    return {
      action: 'refuse',
      reason: 'unaccounted_operation_kind',
      refusal: {
        ok: false,
        code: BATCH_STOCK_UNACCOUNTED_CODE,
        // A kind the ledger has no entry for is a harness gap the model cannot correct: it takes the blocked path.
        refusal_class: REFUSAL_CLASS.WORLD,
        operation: failClosed.operation,
        operation_index: failClosed.operation_index,
        detail: `operation ${failClosed.operation_index + 1} (${failClosed.operation || 'unnamed'}) has no declared stock effect, so the batch's stock cannot be accounted`,
        batch_stock: { unaccounted: report.unaccounted.slice(0, MAX_REPORTED_ITEMS) },
      },
    }
  }
  const candidates = []
  for (const entry of report.short) {
    if (!entry.proven) continue
    const touched = entry.items.some(item => item.touched_by.length > 0)
    if (held.has(entry.operation_index)) candidates.push({ entry, kind: touched ? 'refuse' : 'standalone' })
    // An operation the mod accepted alone is refused only when what is missing was there at the start of the batch.
    else if (touched && entry.items.every(item => item.isolated_ok)) candidates.push({ entry, kind: 'refuse' })
  }
  candidates.sort((left, right) => left.entry.operation_index - right.entry.operation_index)
  const first = candidates[0]
  if (!first) {
    const reason = report.short.length === 0
      ? 'batch_within_observed_stock'
      : report.short.some(entry => !entry.proven) ? 'shortage_not_proven_by_batch_facts' : 'shortage_not_caused_by_this_batch'
    return { action: 'proceed', reason }
  }
  if (first.kind === 'standalone') return { action: 'standalone', operation_index: first.entry.operation_index, reason: 'shortage_not_touched_by_earlier_operations' }
  const { entry } = first
  const uncertain = report.uncertain.filter(candidate => candidate.operation_index < entry.operation_index
    && (!candidate.items || candidate.items.some(item => entry.items.some(short => short.item_name === item))))
  const touchedBy = sortedUnique(entry.items.flatMap(item => item.touched_by))
  const facts = {
    operation_index: entry.operation_index,
    operation: entry.operation,
    short: entry.items.map(item => ({
      item_name: item.item_name,
      needed: item.needed,
      available: item.available,
      short_by: item.short_by,
      ...(item.source === 'entity' ? { source: 'entity', unit_number: item.unit_number } : {}),
      earlier_operations: item.touched_by,
    })),
    ...(uncertain.length > 0 ? { not_counted_as_supply: uncertain } : {}),
  }
  const earlier = touchedBy.map(index => `${index + 1} (${report.verdicts[index]?.operation})`).join(', ')
  const detail = `operation ${entry.operation_index + 1} (${entry.operation}) needs more than this batch leaves: ${entry.items.map(shortFragment).join('; ')}; earlier operations ${earlier} use or may change that stock`
  return {
    action: 'refuse',
    reason: 'batch_exceeds_observed_stock',
    refusal: {
      ok: false,
      code: BATCH_STOCK_INSUFFICIENT_CODE,
      // The model proposed an internally inconsistent batch: one bounded correction turn with the facts, plan unchanged.
      refusal_class: REFUSAL_CLASS.ARGUMENT,
      operation: entry.operation,
      operation_index: entry.operation_index,
      identity: entry.items[0]?.item_name,
      detail,
      batch_stock: facts,
      correction_message: `[HARNESS] Refused before admission: the operations in this batch need more stock together than the actor holds, so no operation from this batch ran. Each operation was accepted on its own against the same inventory, but ${detail}.${uncertain.length > 0 ? ' An operation whose yield is not deterministic (mining an entity, clearing an area) is not counted as supply for a later one.' : ''} The plan, the step and the requested result are unchanged. Resubmit a batch whose operations fit the stock the earlier ones leave (smaller counts, or only the operations that fit now), and use the settled inventory for what follows in a later decision. Facts: ${JSON.stringify(facts).slice(0, 900)}`,
    },
  }
}
