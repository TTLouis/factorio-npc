import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BATCH_STOCK_INSUFFICIENT_CODE,
  BATCH_STOCK_UNACCOUNTED_CODE,
  BATCH_STOCK_UNVERIFIED_CODE,
  batchStockDecision,
  evaluateBatchStock,
  OPERATION_STOCK_EFFECTS,
  STOCK_STATUS,
  stockClaimingOperation,
} from './batch-stock.mjs'
import { normalizeRecipeFact } from './handoff-packet.mjs'
import { REFUSAL_CLASS } from './refusal-class.mjs'
import { approvedOperationNames } from './structured-policy.mjs'

// The batch stock ledger as a pure function: ordered operations over the observed inventory, with real Factorio recipe shapes
// (the same facts the handoff recipe cache holds). The loop wiring is covered in batch-stock-preflight.test.mjs.

const recipe = (name, ingredients, products, { hand = true } = {}) => normalizeRecipeFact({
  name,
  hand_craftable: hand,
  enabled: true,
  allow_as_intermediate: true,
  allow_intermediates: true,
  categories: [hand ? 'crafting' : 'smelting'],
  energy: 0.5,
  ingredients: ingredients.map(([item, amount]) => ({ type: 'item', name: item, amount })),
  products: products.map(([item, amount]) => ({ type: 'item', name: item, amount })),
}, { source: 'getRecipeDetails' })

const RECIPES = [
  recipe('iron-gear-wheel', [['iron-plate', 2]], [['iron-gear-wheel', 1]]),
  recipe('transport-belt', [['iron-plate', 1], ['iron-gear-wheel', 1]], [['transport-belt', 2]]),
  recipe('stone-furnace', [['stone', 5]], [['stone-furnace', 1]]),
  recipe('copper-cable', [['copper-plate', 1]], [['copper-cable', 2]]),
  recipe('electronic-circuit', [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]]),
  // Smelted in a furnace, never by hand: a shortage of plates cannot be crafted away.
  recipe('iron-plate', [['iron-ore', 1]], [['iron-plate', 1]], { hand: false }),
  recipe('copper-plate', [['copper-ore', 1]], [['copper-plate', 1]], { hand: false }),
]
const RAW = new Set(['iron-ore', 'copper-ore', 'stone', 'coal'])

const craft = (item_name, count = 1) => ({ name: 'craft_item', args: { item_name, count } })
const placeFurnace = { name: 'place_entity', args: { entity_name: 'stone-furnace' } }
const FURNACE_ITEM = held => ({ ok: true, placement_item: { entity_name: 'stone-furnace', item_name: 'stone-furnace', count: 1, held_count: held } })
const supply = (unit_number, item_name, count) => ({ name: 'supply_entity', args: { unit_number, items: [{ item_name, count }] } })
const withdraw = (unit_number, item_name, max_count) => ({ name: 'move_items_exact', args: { item_name, unit_number, max_count, to_entity: false } })
const withdrawFacts = (unit_number, item_name, requested, source_count) => ({
  ok: true,
  target: { unit_number },
  transfer: { direction: 'from_entity', items: [{ item_name, requested, source_count, destination_accepts: 1000, expected_moved: Math.min(requested, source_count), missing: Math.max(0, requested - source_count), status: 'ok' }] },
})

const run = (operations, inventory, preflight = [], extra = {}) => evaluateBatchStock({
  operations, preflight: operations.map((operation, index) => preflight[index] ?? (operation.name === 'supply_entity' ? {
    ok: true, target: { unit_number: operation.args.unit_number }, transfer: { direction: 'to_entity', items: operation.args.items.map(item => ({ ...item, destination_accepts: 1000 })) },
  } : undefined)), inventory: new Map(Object.entries(inventory)), recipes: RECIPES, noRecipeItems: RAW, ...extra,
})
const statuses = report => report.verdicts.map(verdict => verdict.status)

test('every approved operation declares its stock effect, and the table names no operation that is not approved', () => {
  const approved = approvedOperationNames()
  assert.deepEqual(approved.filter(name => !Object.hasOwn(OPERATION_STOCK_EFFECTS, name)), [], 'an approved operation with no declared stock effect would bypass the ledger')
  assert.deepEqual(Object.keys(OPERATION_STOCK_EFFECTS).filter(name => !approved.includes(name)), [], 'a declared effect for an operation the model cannot send')
  assert.ok(Object.isFrozen(OPERATION_STOCK_EFFECTS))
})

test('two crafts that together need more iron plates than held: the second is short with the per-item shortfall, and the batch is refused', () => {
  const operations = [craft('iron-gear-wheel', 10), craft('iron-gear-wheel', 10)]
  const report = run(operations, { 'iron-plate': 25 })

  assert.deepEqual(statuses(report), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.equal(report.short.length, 1)
  const [shortage] = report.short
  assert.equal(shortage.operation_index, 1)
  assert.equal(shortage.proven, true)
  assert.deepEqual(shortage.items.map(({ item_name, needed, available, short_by, touched_by, isolated_ok }) => ({ item_name, needed, available, short_by, touched_by, isolated_ok })),
    [{ item_name: 'iron-plate', needed: 20, available: 5, short_by: 15, touched_by: [0], isolated_ok: true }])

  const decision = batchStockDecision(report)
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.reason, 'batch_exceeds_observed_stock')
  assert.equal(decision.refusal.ok, false)
  assert.equal(decision.refusal.code, BATCH_STOCK_INSUFFICIENT_CODE)
  assert.equal(decision.refusal.refusal_class, REFUSAL_CLASS.ARGUMENT, 'the model proposed an internally inconsistent batch: one correction turn')
  assert.equal(decision.refusal.operation_index, 1)
  assert.deepEqual(decision.refusal.batch_stock.short, [{ item_name: 'iron-plate', needed: 20, available: 5, short_by: 15, earlier_operations: [0] }])
  assert.match(decision.refusal.correction_message, /^\[HARNESS\] Refused before admission/)
  assert.match(decision.refusal.correction_message, /iron-plate: needs 20, 5 left/)
})

test('crafting gears and then a belt from those gears is covered by the earlier craft: the gears are supply', () => {
  const report = run([craft('iron-gear-wheel', 10), craft('transport-belt', 5)], { 'iron-plate': 30 })
  // 20 plates for ten gears; the belts take five of those gears and five more plates: 25 of 30.
  assert.deepEqual(statuses(report), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED_BY_EARLIER_OP])
  assert.deepEqual(report.deferred_by_earlier_op, [{ operation_index: 1, operation: 'craft_item', dependencies: [{ item_name: 'iron-gear-wheel', operation_index: 0, operation: 'craft_item' }] }])
  assert.equal(batchStockDecision(report).action, 'proceed')

  // The same belts one plate short: the dependency does not hide a real shortage.
  const tight = run([craft('iron-gear-wheel', 10), craft('transport-belt', 5)], { 'iron-plate': 24 })
  assert.deepEqual(statuses(tight), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.equal(batchStockDecision(tight).refusal.code, BATCH_STOCK_INSUFFICIENT_CODE)
})

test('execution-time supply cannot overturn a native craft rejection at admission', () => {
  const report = run([withdraw(77, 'iron-plate', 8), craft('iron-gear-wheel', 4)], {}, [withdrawFacts(77, 'iron-plate', 8, 8), { ok: false, code: 'bootstrap_dependency_unresolved' }])
  assert.equal(report.verdicts[1].status, STOCK_STATUS.COVERED_BY_EARLIER_OP)
  const decision = batchStockDecision(report, new Set([1]))
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.reason, 'craft_requires_settled_inventory')
  assert.equal(decision.refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
  assert.equal(decision.refusal.refusal_class, REFUSAL_CLASS.ARGUMENT)
  assert.match(decision.refusal.correction_message, /wait for its receipt/)
  // A different consumer with execution-time validation keeps the existing
  // craft -> place contract; this rule belongs to craft admission specifically.
  const placement = run([craft('stone-furnace'), placeFurnace], { stone: 5 }, [{ ok: true }, FURNACE_ITEM(0)])
  assert.equal(batchStockDecision(placement, new Set([1])).action, 'proceed')
})

test('a hand craft takes held intermediates first and crafts the missing ones from raw stock, keeping the surplus', () => {
  // Five belt crafts: five plates, and five gears that are crafted from ten more plates because none are held.
  assert.deepEqual(statuses(run([craft('transport-belt', 5)], { 'iron-plate': 15 })), [STOCK_STATUS.COVERED])
  const short = run([craft('transport-belt', 5)], { 'iron-plate': 14 })
  assert.equal(short.short[0].items[0].item_name, 'iron-plate')
  assert.equal(short.short[0].items[0].short_by, 1)
  // Held gears are used before any are crafted.
  assert.deepEqual(statuses(run([craft('transport-belt', 5)], { 'iron-plate': 5, 'iron-gear-wheel': 5 })), [STOCK_STATUS.COVERED])
  // Three cables are needed per circuit; a craft yields two, and the surplus cable stays in the inventory for the next craft.
  const circuits = run([craft('electronic-circuit', 1), craft('copper-cable', 1)], { 'iron-plate': 1, 'copper-plate': 2 })
  // circuit: 1 plate + 3 cables = 2 cable crafts (2 copper plates, 4 cables, 1 spare); the next cable craft needs a copper plate: none left.
  assert.deepEqual(statuses(circuits), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  const sparing = run([craft('electronic-circuit', 1), craft('copper-cable', 1)], { 'iron-plate': 1, 'copper-plate': 3 })
  assert.deepEqual(statuses(sparing), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED])
})

test('a plate shortage is not crafted away: smelting is not a hand recipe', () => {
  const report = run([craft('copper-cable', 3), craft('copper-cable', 2)], { 'copper-plate': 4 })
  assert.deepEqual(statuses(report), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.equal(report.short[0].items[0].item_name, 'copper-plate')
  assert.equal(report.short[0].items[0].available, 1)
})

test('crafting a furnace and then placing it is covered; placing two furnaces with one held and no craft is short', () => {
  const crafted = run([craft('stone-furnace', 1), placeFurnace], { stone: 5 }, [{ ok: true }, FURNACE_ITEM(0)])
  assert.deepEqual(statuses(crafted), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED_BY_EARLIER_OP])
  assert.deepEqual(crafted.verdicts[1].dependencies, [{ item_name: 'stone-furnace', operation_index: 0, operation: 'craft_item' }])
  assert.equal(batchStockDecision(crafted, new Set([1])).action, 'proceed')

  const twice = run([placeFurnace, placeFurnace], { 'stone-furnace': 1 }, [FURNACE_ITEM(1), FURNACE_ITEM(1)])
  assert.deepEqual(statuses(twice), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  const decision = batchStockDecision(twice)
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.refusal.code, BATCH_STOCK_INSUFFICIENT_CODE)
  assert.deepEqual(decision.refusal.batch_stock.short, [{ item_name: 'stone-furnace', needed: 1, available: 0, short_by: 1, earlier_operations: [0] }])

  // A craft whose stone is already spent leaves nothing for the furnace to come from.
  const spent = run([craft('stone-furnace', 1), craft('stone-furnace', 1), placeFurnace], { stone: 5 }, [{ ok: true }, { ok: true }, FURNACE_ITEM(0)])
  assert.deepEqual(statuses(spent), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT, STOCK_STATUS.COVERED_BY_EARLIER_OP])
})

test('a held placement rejection with nothing in the batch bearing on it stands on its own; a refusal needs the batch to be involved', () => {
  const alone = run([{ name: 'walk_to_position', args: { x: 1, y: 1, reach_distance: 0.75 } }, placeFurnace], {}, [{ ok: true }, FURNACE_ITEM(0)])
  assert.deepEqual(statuses(alone), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.deepEqual(batchStockDecision(alone, new Set([1])), { action: 'standalone', operation_index: 1, reason: 'shortage_not_touched_by_earlier_operations' })

  // The same shortage on an operation the mod accepted (so the inventory disagrees with its read) is not the batch's doing.
  const disagreement = run([{ name: 'walk_to_position', args: { x: 1, y: 1, reach_distance: 0.75 } }, placeFurnace], {}, [{ ok: true }, FURNACE_ITEM(1)])
  assert.equal(batchStockDecision(disagreement).action, 'proceed')
  assert.equal(batchStockDecision(disagreement).reason, 'shortage_not_caused_by_this_batch')
})

test('supplies share the stock: a partial move still succeeds, and only a transfer that finds nothing is short', () => {
  const partial = run([supply(15, 'coal', 50), supply(16, 'coal', 80)], { coal: 100 })
  assert.deepEqual(statuses(partial), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED], 'the second moves the 50 left, which the engine accepts')
  const none = run([supply(15, 'coal', 100), supply(16, 'coal', 10)], { coal: 100 })
  assert.deepEqual(statuses(none), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.equal(batchStockDecision(none).refusal.code, BATCH_STOCK_INSUFFICIENT_CODE)
})

test('two withdrawals from one machine share its stock; what a withdrawal is expected to move supplies a later craft', () => {
  const preflight = [withdrawFacts(77, 'iron-plate', 5, 5), withdrawFacts(77, 'iron-plate', 5, 5)]
  const doubled = run([withdraw(77, 'iron-plate', 5), withdraw(77, 'iron-plate', 5)], {}, preflight)
  assert.deepEqual(statuses(doubled), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.deepEqual(doubled.short[0].items.map(({ item_name, source, unit_number, touched_by }) => ({ item_name, source, unit_number, touched_by })),
    [{ item_name: 'iron-plate', source: 'entity', unit_number: 77, touched_by: [0] }])
  assert.equal(batchStockDecision(doubled).refusal.code, BATCH_STOCK_INSUFFICIENT_CODE)

  // A single partial positive withdrawal is allowed, and the plates it takes are supply for the gears that follow.
  const chained = run([withdraw(77, 'iron-plate', 20), craft('iron-gear-wheel', 4)], {}, [withdrawFacts(77, 'iron-plate', 20, 8), { ok: true }])
  assert.deepEqual(statuses(chained), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED_BY_EARLIER_OP])
  const tooMany = run([withdraw(77, 'iron-plate', 20), craft('iron-gear-wheel', 5)], {}, [withdrawFacts(77, 'iron-plate', 20, 8), { ok: true }])
  assert.equal(tooMany.verdicts[1].status, STOCK_STATUS.SHORT, 'only the eight plates the machine held are counted')
})

test('uncertain production cannot overturn a native shortage or prove a batch shortage', () => {
  const operations = [{ name: 'mine_entity_exact', args: { unit_number: 9 } }, placeFurnace]
  const report = run(operations, {}, [{ ok: true }, FURNACE_ITEM(0)])
  assert.deepEqual(statuses(report), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.deepEqual(report.uncertain, [{ operation_index: 0, operation: 'mine_entity_exact', reason: 'mine_entity_exact_yield_not_deterministic' }])
  const decision = batchStockDecision(report, new Set([1]))
  assert.equal(decision.refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
  assert.equal(report.short[0].proven, false)

  // A withdrawal nobody read the source of is uncertain too.
  const unread = run([{ name: 'move_items', args: { item_name: 'stone-furnace', entity_name: 'wooden-chest', max_count: 1, to_entity: false } }, placeFurnace], {}, [{ ok: true }, FURNACE_ITEM(0)])
  assert.equal(batchStockDecision(unread, new Set([1])).refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
})

test('resource cycles have unknown item yield; harvest supplies only its verified minimum', () => {
  const gathered = run([{ name: 'gather_resource', args: { resource_name: 'stone', count: 10, search_radius: 64 } }, craft('stone-furnace', 2)], {})
  assert.deepEqual(statuses(gathered), [STOCK_STATUS.COVERED, STOCK_STATUS.SHORT])
  assert.equal(gathered.short[0].proven, false)
  const tooLittle = run([{ name: 'mine_resource_at', args: { resource_name: 'stone', x: 1, y: 2, count: 9 } }, craft('stone-furnace', 2)], {})
  assert.equal(tooLittle.verdicts[1].status, STOCK_STATUS.SHORT)
  assert.equal(tooLittle.short[0].items[0].available, 0)
  assert.equal(tooLittle.short[0].proven, false)
  assert.equal(batchStockDecision(tooLittle).action, 'proceed', 'a shortage that was already there before the batch is for the mod preflight, not for this ledger')
  const wood = run([{ name: 'harvest_product', args: { product_name: 'wood', count: 4, search_radius: 32 } }, supply(15, 'wood', 4)], {})
  assert.deepEqual(statuses(wood), [STOCK_STATUS.COVERED, STOCK_STATUS.COVERED_BY_EARLIER_OP])
})

test('a recipe nobody read cannot be accounted for: the shortage after it is not proven, so nothing is refused', () => {
  const operations = [craft('mystery-machine', 1), placeFurnace]
  const report = run(operations, {}, [{ ok: true }, FURNACE_ITEM(0)])
  assert.equal(report.verdicts[0].status, STOCK_STATUS.UNACCOUNTED)
  assert.deepEqual(report.unaccounted, [{ operation_index: 0, operation: 'craft_item', reason: 'recipe_unavailable', fail_closed: false }])
  assert.equal(report.short[0].proven, false)
  assert.equal(batchStockDecision(report, new Set([1])).refusal.code, BATCH_STOCK_UNVERIFIED_CODE)

  // The same for an intermediate nobody read: raw and craftable are not the same thing, and the ledger does not guess.
  const unknownIntermediate = run([craft('lab', 1)], { 'iron-plate': 100 }, [], {
    recipes: [...RECIPES, recipe('lab', [['electronic-circuit', 10], ['iron-gear-wheel', 10], ['transport-belt', 4], ['mystery-part', 1]], [['lab', 1]])],
  })
  assert.equal(unknownIntermediate.verdicts[0].status, STOCK_STATUS.UNACCOUNTED)
  assert.equal(unknownIntermediate.verdicts[0].unaccounted.reason, 'recipe_unavailable')
})

test('an operation kind with no declared stock effect is unaccounted and fails closed', () => {
  const report = run([{ name: 'teleport_to_chest', args: {} }], { coal: 5 })
  assert.deepEqual(statuses(report), [STOCK_STATUS.UNACCOUNTED])
  assert.deepEqual(report.unaccounted, [{ operation_index: 0, operation: 'teleport_to_chest', reason: 'unknown_operation_kind', fail_closed: true }])
  assert.equal(stockClaimingOperation('teleport_to_chest'), true, 'an unknown kind always reaches the ledger')
  const decision = batchStockDecision(report)
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.reason, 'unaccounted_operation_kind')
  assert.equal(decision.refusal.code, BATCH_STOCK_UNACCOUNTED_CODE)
  assert.equal(decision.refusal.refusal_class, REFUSAL_CLASS.WORLD, 'a harness gap is not something the model can correct')
  // It also blocks every proof after it.
  const after = run([{ name: 'teleport_to_chest', args: {} }, placeFurnace], {}, [{ ok: true }, FURNACE_ITEM(0)])
  assert.equal(after.short[0].proven, false)
})

test('an equipped stack leaves an unknown remainder: a later claim on that item is not accounted, not refused', () => {
  const equip = { name: 'equip_ammo', args: { item_name: 'firearm-magazine', slot: 1 } }
  const report = run([equip, supply(15, 'firearm-magazine', 5)], { 'firearm-magazine': 20 })
  assert.equal(report.verdicts[0].status, STOCK_STATUS.COVERED)
  assert.deepEqual(report.unaccounted, [{ operation_index: 1, operation: 'supply_entity', reason: 'stack_moved_by_equip', fail_closed: false }])
  assert.equal(batchStockDecision(report).action, 'proceed')
  const missing = run([equip], {})
  assert.equal(missing.verdicts[0].status, STOCK_STATUS.SHORT)
})

test('only stock-claiming operations decide whether the ledger is worth running', () => {
  for (const name of ['craft_item', 'place_entity', 'place_candidate', 'supply_entity', 'move_items_exact', 'move_items', 'equip_weapon', 'execute_construction_plan']) assert.equal(stockClaimingOperation(name), true, name)
  for (const name of ['walk_to_position', 'wait', 'gather_resource', 'mine_entity', 'research_technology']) assert.equal(stockClaimingOperation(name), false, name)
})

test('an uncertain withdrawal of one item implicates only that item: an unrelated shortage stands on its own', () => {
  const unread = { name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'wooden-chest', max_count: 5, to_entity: false } }
  const coal = run([unread, supply(15, 'coal', 5)], {}, [{ ok: true }, { ok: false, code: 'supply_missing' }])
  assert.equal(coal.verdicts[1].status, STOCK_STATUS.SHORT)
  assert.deepEqual(batchStockDecision(coal, new Set([1])), { action: 'standalone', operation_index: 1, reason: 'shortage_not_touched_by_earlier_operations' })
  const plates = run([unread, supply(15, 'iron-plate', 5)], {}, [{ ok: true }, { ok: false, code: 'supply_missing' }])
  assert.equal(batchStockDecision(plates, new Set([1])).refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
  assert.equal(plates.short[0].proven, false)
})

test('consuming a held intermediate exposes the later native craft shortage', () => {
  const report = run([supply(15, 'iron-gear-wheel', 5), craft('transport-belt', 5)], { 'iron-gear-wheel': 5, 'iron-plate': 5 })
  assert.equal(batchStockDecision(report).action, 'refuse')
  assert.deepEqual(report.short[0].items[0].touched_by, [0])
  assert.equal(report.short[0].items[0].isolated_ok, true)
})

test('outbound capacity preserves stock and a supply replenishes a previously emptied entity', () => {
  const deposit = (unit, item, room) => ({ ok: true, target: { unit_number: unit }, transfer: { direction: 'to_entity', items: [{ item_name: item, destination_accepts: room }] } })
  const bounded = run([supply(15, 'coal', 100), supply(16, 'coal', 10)], { coal: 100 }, [deposit(15, 'coal', 1), deposit(16, 'coal', 100)])
  assert.equal(batchStockDecision(bounded).action, 'proceed')
  assert.equal(bounded.short.length, 0)
  const roundtrip = run([withdraw(77, 'coal', 5), supply(77, 'coal', 5), withdraw(77, 'coal', 5)], { coal: 5 }, [withdrawFacts(77, 'coal', 5, 5), deposit(77, 'coal', 100), withdrawFacts(77, 'coal', 5, 5)])
  assert.equal(batchStockDecision(roundtrip).action, 'proceed')
  assert.equal(roundtrip.short.length, 0)
})

test('harvest surplus cannot prove a shortage after its minimum has been spent', () => {
  const report = run([{ name: 'harvest_product', args: { product_name: 'wood', count: 1 } }, supply(15, 'wood', 1), supply(16, 'wood', 1)], {})
  assert.equal(report.short[0].proven, false)
  assert.equal(batchStockDecision(report).action, 'proceed')
  assert.equal(batchStockDecision(report, new Set([2])).refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
})

test('an incomplete craft cannot supply simulated intermediate surplus to a held rejection', () => {
  const report = run([craft('widget'), supply(15, 'part-a', 1)], { raw: 1 }, [], { recipes: [
    recipe('widget', [['part-a', 2], ['part-b', 1]], [['widget', 1]]),
    recipe('part-a', [['raw', 1]], [['part-a', 3]]),
  ], noRecipeItems: new Set(['raw']) })
  assert.equal(report.verdicts[0].status, STOCK_STATUS.UNACCOUNTED)
  assert.equal(report.verdicts[1].status, STOCK_STATUS.SHORT)
  assert.equal(report.verdicts[1].supplied_by.length, 0)
  assert.equal(batchStockDecision(report, new Set([1])).refusal.code, BATCH_STOCK_UNVERIFIED_CODE)
})

test('waiting invalidates exact entity stock without claiming production or a proven shortage', () => {
  const report = run([withdraw(77, 'iron-plate', 5), { name: 'wait', args: { ticks: 600 } }, withdraw(77, 'iron-plate', 5)], {}, [withdrawFacts(77, 'iron-plate', 5, 5), { ok: true }, withdrawFacts(77, 'iron-plate', 5, 5)])
  assert.equal(report.short[0].proven, false)
  assert.equal(batchStockDecision(report).action, 'proceed')
})

test('withdrawals share observed actor capacity and waiting invalidates destination capacity', () => {
  const oneRoom = unit => ({ ...withdrawFacts(unit, 'iron-plate', 1, 10), transfer: { direction: 'from_entity', items: [{ item_name: 'iron-plate', source_count: 10, destination_accepts: 1, expected_moved: 1 }] } })
  const inbound = run([withdraw(77, 'iron-plate', 1), withdraw(78, 'iron-plate', 1)], {}, [oneRoom(77), oneRoom(78)])
  assert.equal(inbound.verdicts[1].status, STOCK_STATUS.SHORT)
  assert.equal(batchStockDecision(inbound).action, 'refuse')
  const cap = { ok: true, target: { unit_number: 15 }, transfer: { direction: 'to_entity', items: [{ item_name: 'coal', destination_accepts: 100 }] } }
  const afterWait = run([supply(15, 'coal', 100), { name: 'wait', args: { ticks: 600 } }, supply(15, 'coal', 1)], { coal: 101 }, [cap, undefined, cap])
  assert.equal(afterWait.verdicts[2].status, STOCK_STATUS.UNACCOUNTED)
  assert.equal(batchStockDecision(afterWait).action, 'proceed')
})

test('native intermediate permissions are required before replacing consumed held intermediates', () => {
  for (const key of ['allow_as_intermediate', 'allow_intermediates']) {
    const recipes = structuredClone(RECIPES)
    if (key === 'allow_as_intermediate') recipes.find(recipe => recipe.name === 'iron-gear-wheel')[key] = false
    else recipes.find(recipe => recipe.name === 'transport-belt')[key] = false
    const report = run([supply(15, 'iron-gear-wheel', 1), craft('transport-belt')], { 'iron-gear-wheel': 1, 'iron-plate': 3 }, [], { recipes })
    assert.notEqual(report.verdicts[1].status, STOCK_STATUS.COVERED)
    assert.notEqual(report.verdicts[1].status, STOCK_STATUS.COVERED_BY_EARLIER_OP)
  }
})
