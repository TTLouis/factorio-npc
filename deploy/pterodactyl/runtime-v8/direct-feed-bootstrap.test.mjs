import assert from 'node:assert/strict'
import test from 'node:test'

import { directFeedBootstrapMessage, directFeedBootstrapVerdict, smeltingRecipes, VERDICT } from './direct-feed-bootstrap.mjs'
import { RAW_ITEMS, vanillaRecipes } from './direct-feed-bootstrap-fixtures.mjs'

// Run BB lane B: the planner committed a direct_feed iron cell while holding 8 iron plates. A new burner drill needs 9 (3 plates
// + 3 gears of 2), and the missing plate can only be smelted from the iron-ore the step forbids by hand.
const bb = (overrides = {}) => ({ resource: 'iron-ore', drills: ['burner-mining-drill', 'electric-mining-drill'],
  recipes: Object.values(vanillaRecipes()), raw: RAW_ITEMS, inventory: { 'iron-plate': 8, 'stone-furnace': 1, coal: 12 }, ...overrides })

test('the exact Run BB bootstrap is infeasible: every candidate pair ends in the forbidden resource', () => {
  const verdict = directFeedBootstrapVerdict(bb())
  assert.equal(verdict.verdict, VERDICT.INFEASIBLE)
  const burner = verdict.pairs.filter(pair => pair.drill === 'burner-mining-drill')
  assert.ok(burner.length >= 2, 'one pair per candidate smelter')
  for (const pair of burner) {
    assert.equal(pair.status, VERDICT.INFEASIBLE)
    assert.deepEqual(pair.missing, ['burner-mining-drill'])
    assert.equal(pair.shortfall, 1, 'nine plates needed, eight held: one plate, which only iron-ore smelts into')
    assert.deepEqual(pair.bill.acquisition, [{ item_name: 'iron-ore', count: 1 }])
  }
  assert.ok(verdict.pairs.filter(pair => pair.drill === 'electric-mining-drill').every(pair => pair.status === VERDICT.INFEASIBLE))
  const message = directFeedBootstrapMessage(verdict, { stepNumber: 1, inventory: bb().inventory })
  assert.match(message, /^direct_feed_bootstrap_infeasible: step 1 selects materialSupply direct_feed for iron-ore/)
  assert.match(message, /burner-mining-drill/)
  assert.match(message, /iron-gear-wheel x3 = 2 iron-plate/)
  assert.match(message, /you hold \(iron-plate 8, stone-furnace 1\) still needs 1 iron-ore/)
  assert.ok(message.length < 1500, 'the refusal stays a short list of facts')
  assert.match(message, /manual_bootstrap/)
})

test('a locked drill recipe is neither a way to build the cell nor a reason to doubt the verdict', () => {
  const verdict = directFeedBootstrapVerdict(bb({ drills: ['burner-mining-drill', 'electric-mining-drill', 'big-mining-drill'] }))
  assert.equal(verdict.verdict, VERDICT.INFEASIBLE)
  assert.ok(!verdict.pairs.some(pair => pair.drill === 'big-mining-drill'))
})

test('a held drill, or enough plates to craft one, is not refused', () => {
  const held = directFeedBootstrapVerdict(bb({ inventory: { 'burner-mining-drill': 1, 'iron-plate': 8, 'stone-furnace': 1 } }))
  assert.equal(held.verdict, VERDICT.FEASIBLE)
  assert.ok(held.pairs.find(pair => pair.drill === 'burner-mining-drill' && pair.smelter === 'stone-furnace').status === VERDICT.FEASIBLE)
  const funded = directFeedBootstrapVerdict(bb({ inventory: { 'iron-plate': 9, 'stone-furnace': 1 } }))
  assert.equal(funded.verdict, VERDICT.FEASIBLE)
  // Hand-acquirable leaves (stone for the furnace) are fine.
  const stone = directFeedBootstrapVerdict(bb({ inventory: { 'iron-plate': 9 } }))
  assert.equal(stone.verdict, VERDICT.FEASIBLE)
  assert.deepEqual(stone.pairs.find(pair => pair.drill === 'burner-mining-drill' && pair.smelter === 'stone-furnace').bill.acquisition, [{ item_name: 'stone', count: 10 }])
})

test('a placed drill that the step does not preserve counts as available', () => {
  const placed = directFeedBootstrapVerdict(bb({ placed: { 'burner-mining-drill': 1 } }))
  assert.equal(placed.verdict, VERDICT.FEASIBLE)
  const pair = placed.pairs.find(row => row.drill === 'burner-mining-drill' && row.smelter === 'stone-furnace')
  assert.deepEqual([pair.status, pair.missing], [VERDICT.FEASIBLE, []])
  // The caller never passes a preserved unit, so with none placed the same facts are refused.
  assert.equal(directFeedBootstrapVerdict(bb({ placed: {} })).verdict, VERDICT.INFEASIBLE)
})

test('unreadable, incomplete or ambiguous facts are unknown, never a refusal', () => {
  assert.equal(directFeedBootstrapVerdict(bb()).verdict, VERDICT.INFEASIBLE, 'complete facts do refuse')
  for (const facts of [
    { drills: undefined },
    { drills: [] },
    { recipes: undefined },
    { recipes: [] },
    // The drill's recipe was read but not the gear's: the bill cannot be completed.
    { recipes: Object.values(vanillaRecipes()).filter(recipe => recipe.name !== 'iron-gear-wheel') },
    // Two recipes make plates: the compiler cannot tell which a craft would use.
    { recipes: [...Object.values(vanillaRecipes()), { ...vanillaRecipes()['iron-plate'], name: 'iron-plate-other', hand_craftable_category: true }] },
  ]) {
    const verdict = directFeedBootstrapVerdict(bb(facts))
    assert.notEqual(verdict.verdict, VERDICT.INFEASIBLE, JSON.stringify(Object.keys(facts)))
  }
})

test('stock another checkpoint protects is excluded, but the cell\'s own product is not', () => {
  const funded = { 'iron-gear-wheel': 3, 'iron-plate': 3, 'stone-furnace': 1 }
  assert.equal(directFeedBootstrapVerdict(bb({ inventory: funded, drills: ['burner-mining-drill'] })).verdict, VERDICT.FEASIBLE)
  const protectedGears = directFeedBootstrapVerdict(bb({ inventory: funded, drills: ['burner-mining-drill'], protect: [{ kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 3 }] }))
  assert.equal(protectedGears.verdict, VERDICT.INFEASIBLE)
  assert.deepEqual(protectedGears.reserved, { 'iron-gear-wheel': 3 })
  // Plates are what the cell exists to make: a checkpoint counting them does not stop the drill's own plates being spent.
  const target = directFeedBootstrapVerdict(bb({ inventory: { 'iron-plate': 9, 'stone-furnace': 1 }, drills: ['burner-mining-drill'], protect: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 50 }] }))
  assert.equal(target.verdict, VERDICT.FEASIBLE)
})

test('smelting recipes are the hand-uncraftable recipes that consume the resource', () => {
  assert.deepEqual(smeltingRecipes(Object.values(vanillaRecipes()), 'iron-ore').map(recipe => recipe.name), ['iron-plate'])
  assert.deepEqual(smeltingRecipes(Object.values(vanillaRecipes()), 'stone'), [], 'stone is consumed only by a hand craft')
})
