import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

// Batch-wide stock accounting in the real agent loop (batch-stock.mjs). A fake Factorio answers the live shapes: the inventory
// as the serpent block the game prints, getRecipeDetails as JSON (real recipe shapes), and the mod's per-operation preflight
// computed from that same inventory (each operation judged ALONE against it, which is exactly why a batch can over-commit).
// Scripted model replies; no provider is called.

const KEY = 'npc:sgluna'

const deployment = () => ({
  revision: 'sgluna-deploy-v8-npc-staging',
  session: '0123456789abcdef0123456789abcdef',
  mode: 'npc',
  actor_id: 18,
  actor_kind: 'standalone_character',
  connected_players: 0,
  allowed: true,
  idle: true,
  epoch: 3,
  actor_interface: true,
  operations: true,
  tools: true,
})

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const planMessage = (operations, plan) => ({ content: JSON.stringify({ chatMessage: '', plan, currentStep: 0, operations }) })
const observe = () => ({ content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'wooden-chest', limit: 4 })] })
const data = row => row.data ?? row

const serpent = inventory => `{\n${Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => `  {\n    count = ${count},\n    name = "${name}"\n  }`).join(',\n')}\n}`

const detail = (name, ingredients, products, { hand = true } = {}) => ({
  name,
  enabled: true,
  allow_as_intermediate: true,
  allow_intermediates: true,
  hidden: false,
  energy: 0.5,
  categories: [hand ? 'crafting' : 'smelting'],
  hand_craftable_category: hand,
  ingredients: ingredients.map(([item, amount]) => ({ type: 'item', name: item, amount })),
  products: products.map(([item, amount]) => ({ type: 'item', name: item, amount })),
  crafting_machine_count: 1,
  crafting_machines: [{ name: hand ? 'assembling-machine-1' : 'stone-furnace', type: 'assembling-machine', crafting_speed: 0.5, seconds_per_craft: 1 }],
  crafting_machines_truncated: false,
})
const RECIPES = {
  'iron-gear-wheel': detail('iron-gear-wheel', [['iron-plate', 2]], [['iron-gear-wheel', 1]]),
  'transport-belt': detail('transport-belt', [['iron-plate', 1], ['iron-gear-wheel', 1]], [['transport-belt', 2]]),
  'stone-furnace': detail('stone-furnace', [['stone', 5]], [['stone-furnace', 1]]),
  'iron-plate': detail('iron-plate', [['iron-ore', 1]], [['iron-plate', 1]], { hand: false }),
}
const RAW = new Set(['iron-ore', 'stone'])

function preflightArgs(text) {
  const str = key => new RegExp(String.raw`\['${key}'\]='([^']*)'`).exec(text)?.[1]
  const num = key => {
    const match = new RegExp(String.raw`\['${key}'\]=(-?\d+(?:\.\d+)?)`).exec(text)
    return match ? Number(match[1]) : undefined
  }
  const bool = key => {
    const match = new RegExp(String.raw`\['${key}'\]=(true|false)`).exec(text)
    return match ? match[1] === 'true' : undefined
  }
  const items = [...text.matchAll(/\{\['count'\]=(\d+),\['item_name'\]='([^']+)'\}/g)].map(match => ({ item_name: match[2], count: Number(match[1]) }))
  return { name: /"autorio_preflight","operation",'([a-z_]+)'/.exec(text)?.[1], str, num, bool, items }
}

class StockRcon {
  constructor({ inventory = {}, entities = {}, recipes = RECIPES, inventoryReadable = true, recipeReadable = true } = {}) {
    this.inventory = { ...inventory }
    this.entities = entities // unit_number -> { name, stock }
    this.recipes = recipes
    this.inventoryReadable = inventoryReadable
    this.recipeReadable = recipeReadable
    this.commands = []
    this.mutations = []
    this.recipeReads = []
    this.inventoryReads = 0
    this.admissions = []
    this.batchSequence = 0
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [
        { name: 'stone-furnace', type: 'furnace', unit_number: 15, position: { x: 3, y: 0 }, distance: 3 },
        { name: 'wooden-chest', type: 'container', unit_number: 77, position: { x: 4, y: 1 }, distance: 4 },
      ],
    }
  }

  admissionJournal() {
    return this.admissions.map(record => ({ ...record, state: record.state === 'admitted' ? 'completed' : record.state }))
  }

  // Each operation judged alone against the inventory now, as the mod's preflight does.
  preflight(text) {
    const { name, str, num, bool, items } = preflightArgs(text)
    if (name === 'craft_item') {
      const item = str('item_name')
      const recipe = this.recipes[item]
      if (!recipe) return { ok: false, operation: name, code: 'unknown_recipe' }
      if (recipe.enabled === false) return { ok: false, operation: name, code: 'recipe_locked' }
      if (!recipe.hand_craftable_category) return { ok: false, operation: name, code: 'requires_machine' }
      const stock = { ...this.inventory }
      const make = (entry, crafts, trail = []) => {
        if (!entry || entry.enabled === false || !entry.hand_craftable_category || trail.includes(entry.name)) return false
        for (const ingredient of entry.ingredients) {
          const wanted = ingredient.amount * crafts
          const missing = Math.max(0, wanted - (stock[ingredient.name] ?? 0))
          if (missing) {
            const intermediate = this.recipes[ingredient.name]
            const output = intermediate?.products.find(product => product.name === ingredient.name)?.amount
            if (!output || !make(intermediate, Math.ceil(missing / output), [...trail, entry.name])) return false
          }
          stock[ingredient.name] = (stock[ingredient.name] ?? 0) - wanted
        }
        for (const product of entry.products) stock[product.name] = (stock[product.name] ?? 0) + product.amount * crafts
        return true
      }
      const covered = make(recipe, num('count') ?? 1)
      return { ok: covered, operation: name, ...(covered ? {} : { code: 'bootstrap_dependency_unresolved' }), recipe_name: item, craftable_now_count: covered ? num('count') ?? 1 : 0 }
    }
    if (name === 'place_entity') {
      const entity = str('entity_name')
      const held = this.inventory[entity] ?? 0
      const placement_item = { entity_name: entity, item_name: entity, count: 1, held_count: held }
      return held < 1 ? { ok: false, code: 'placement_item_missing', operation: name, placement_item } : { ok: true, operation: name, placement_item }
    }
    if (name === 'supply_entity' || (name === 'move_items_exact' && bool('to_entity') === true)) {
      const unit = num('unit_number')
      const wanted = name === 'supply_entity' ? items : [{ item_name: str('item_name'), count: num('max_count') }]
      const facts = wanted.map(({ item_name, count }) => {
        const source = this.inventory[item_name] ?? 0
        const room = this.entities[unit]?.capacity?.[item_name] ?? 1000
        return { item_name, requested: count, source_count: source, destination_accepts: room, expected_moved: Math.min(count, source, room), missing: Math.max(0, count - source), status: source <= 0 ? 'supply_missing' : room <= 0 ? 'destination_full' : source < count ? 'partial' : 'ok' }
      })
      const base = { operation: name, field: 'unit_number', identity: unit, target: { unit_number: unit, name: this.entities[unit]?.name ?? 'stone-furnace' }, transfer: { direction: 'to_entity', items: facts } }
      return facts.some(item => item.status === 'supply_missing') ? { ok: false, code: 'supply_missing', ...base } : { ok: true, ...base }
    }
    if (name === 'move_items_exact') {
      const unit = num('unit_number')
      const item_name = str('item_name')
      const requested = num('max_count')
      const source = this.entities[unit]?.stock?.[item_name] ?? 0
      const fact = { item_name, requested, source_count: source, destination_accepts: 1000, expected_moved: Math.min(requested, source), missing: Math.max(0, requested - source), status: source <= 0 ? 'extraction_empty' : source < requested ? 'partial' : 'ok' }
      const base = { operation: name, field: 'unit_number', identity: unit, target: { unit_number: unit, name: this.entities[unit]?.name ?? 'wooden-chest' }, transfer: { direction: 'from_entity', items: [fact] } }
      return source <= 0 ? { ok: false, code: 'extraction_empty', ...base } : { ok: true, ...base }
    }
    return { ok: true, operation: name }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, admission_journal: this.admissionJournal(), receipt_journal: [] })
    }
    if (text.includes('"get_inventory_items"')) {
      this.inventoryReads++
      return this.inventoryReadable ? serpent(this.inventory) : 'not an inventory'
    }
    if (text.includes('"recipe_details"')) {
      if (!this.recipeReadable) return 'unreadable recipe facts'
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      this.recipeReads.push(name)
      if (this.recipes[name]) return JSON.stringify({ found: true, query: name, truncated: false, recipes: [this.recipes[name]] })
      // The mod declares code no_recipe for a name no recipe makes (a raw resource); any other not-found answer is an unreadable read.
      return JSON.stringify(RAW.has(name) ? { found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name' } : { found: false, query: name })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify(this.preflight(text))
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      const batchId = ++this.batchSequence
      const encoded = /"begin",helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(text)?.[1]
      if (encoded) {
        const identity = JSON.parse(JSON.parse(encoded))
        this.admissions.push({ ...identity, generation: 1, batch_id: batchId, state: 'admitted', slots: Array.from({ length: count }, (_, index) => ({
          index: index + 1, ok: true, batch_refs: [{ batch_id: batchId, batch_generation: 1, batch_ref: `batch-g1-${batchId}` }] })) })
      }
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

function harness(rcon, script) {
  const calls = []
  const rows = []
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const next = script.shift()
      assert.ok(next, `unscripted provider call ${calls.length}`)
      return next
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'batch stock test',
    npcId: 'sgluna',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  return {
    agent,
    memory,
    calls,
    named: name => rows.filter(row => row.event === name),
    plan: () => memory.currentPlan(KEY),
    harnessMessages: callIndex => calls[callIndex].map(message => String(message.content ?? '')).filter(content => content.startsWith('[HARNESS]')),
  }
}

const craft = (item_name, count) => ({ name: 'craft_item', args: { item_name, count } })
const PLACE_FURNACE = { name: 'place_entity', args: { entity_name: 'stone-furnace' } }
const MINE_ROCK = { name: 'mine_entity', args: { entity_name: 'rock-big', count: 1 } }
const take = (unit_number, item_name, max_count) => ({ name: 'move_items_exact', args: { item_name, unit_number, max_count, to_entity: false } })

test('two crafts that together need more iron plates than held are refused before admission with the per-item shortfall, then the corrected batch runs', async () => {
  const rcon = new StockRcon({ inventory: { 'iron-plate': 25 } })
  const plan = ['Craft the gears']
  const world = harness(rcon, [observe(), planMessage([craft('iron-gear-wheel', 10), craft('iron-gear-wheel', 10)], plan), planMessage([craft('iron-gear-wheel', 10)], plan)])

  const result = await world.agent.request('craft twenty gears', { sender: 'tester' })

  // Each craft alone fits the 25 plates, so the mod accepted both; together they need 40.
  const [checked, ...later] = world.named('operations.batch_stock_checked')
  assert.equal(later.length, 0, 'the corrected single craft has nothing to compose, so it is not replayed')
  assert.ok(data(checked).request_id)
  assert.equal(data(checked).reason, 'batch_exceeds_observed_stock')
  assert.equal(data(checked).refused, 'batch_stock_insufficient')
  assert.deepEqual(data(checked).ops.map(op => op.status), ['covered', 'short'])
  assert.equal(data(checked).short[0].operation_index, 1)
  assert.deepEqual(data(checked).short[0].items.map(({ item_name, needed, available, short_by }) => ({ item_name, needed, available, short_by })), [{ item_name: 'iron-plate', needed: 20, available: 5, short_by: 15 }])
  assert.deepEqual(data(checked).deferred_by_earlier_op, [])
  assert.deepEqual(data(checked).unaccounted, [])
  assert.equal(data(checked).recipe_reads, 3, 'the gear recipe, the plate recipe, and iron-ore read once as having no recipe')

  // Nothing was admitted for the refused batch; the model got the shortage as a harness fact and the class-argument correction turn.
  const [recoverable] = world.named('operations.preflight_recoverable')
  assert.equal(data(recoverable).failure_class, 'model_correctable_batch_stock_insufficient')
  assert.equal(data(recoverable).refusal_class, 'argument')
  assert.equal(data(recoverable).retry, 1)
  assert.equal(data(recoverable).preflight.code, 'batch_stock_insufficient')
  assert.ok(data(recoverable).preflight.batch_stock.short.some(item => item.item_name === 'iron-plate' && item.needed === 20 && item.available === 5))
  const [message] = world.harnessMessages(2)
  assert.match(message, /^\[HARNESS\] Refused before admission/)
  assert.match(message, /iron-plate: needs 20, 5 left/)
  assert.match(message, /no operation from this batch ran/)
  assert.equal(rcon.mutations.length, 1, 'only the corrected batch was admitted')
  assert.equal((rcon.mutations[0].match(/'craft_item'/g) ?? []).length, 1)
  assert.deepEqual(result.operations.map(operation => operation.name), ['craft_item'])
  assert.equal(world.plan().status, 'active', 'the plan is untouched by the correction')
  assert.equal(world.named('operations.preflight_rejected').length, 0)
})

test('crafting gears and then belts from those gears is admitted: the earlier craft is supply, and the batch fits the plates', async () => {
  const rcon = new StockRcon({ inventory: { 'iron-plate': 30 } })
  const world = harness(rcon, [observe(), planMessage([craft('iron-gear-wheel', 10), craft('transport-belt', 5)], ['Craft belts'])])

  const result = await world.agent.request('craft belts', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1, 'the batch was admitted')
  assert.deepEqual(result.operations.map(operation => operation.name), ['craft_item', 'craft_item'])
  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'batch_within_observed_stock')
  assert.deepEqual(data(checked).short, [])
  assert.deepEqual(data(checked).deferred_by_earlier_op, [{ operation_index: 1, operation: 'craft_item', dependencies: [{ item_name: 'iron-gear-wheel', operation_index: 0, operation: 'craft_item' }] }])
  assert.deepEqual(data(checked).ops.map(op => op.status), ['covered', 'covered_by_earlier_op'])
  assert.equal(world.named('operations.preflight_recoverable').length, 0)
})

test('crafting a furnace and then placing it is admitted: the mod rejected the placement on the held snapshot, the ledger settles it with the craft as the dependency', async () => {
  const rcon = new StockRcon({ inventory: { stone: 5 } })
  const world = harness(rcon, [observe(), planMessage([craft('stone-furnace', 1), PLACE_FURNACE], ['Craft and place a furnace'])])

  const result = await world.agent.request('craft and place a furnace', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1, 'the batch was admitted')
  assert.deepEqual(result.operations.map(operation => operation.name), ['craft_item', 'place_entity'])
  const [deferred] = world.named('placement.preflight_item_deferred')
  assert.ok(data(deferred).request_id)
  assert.equal(data(deferred).code, 'placement_item_missing')
  assert.equal(data(deferred).operation_index, 1)
  assert.equal(data(deferred).reason, 'earlier_operation_in_batch_supplies_item')
  assert.deepEqual(data(deferred).dependencies, [{ item_name: 'stone-furnace', status: 'placement_item_missing', operation_index: 0, operation: 'craft_item' }])
  assert.equal(data(world.named('operations.preflight_ok').at(-1)).operations[1].preflight.deferred, 'batch_dependency')
  const [checked] = world.named('operations.batch_stock_checked')
  assert.deepEqual(data(checked).deferred_by_earlier_op.map(entry => entry.operation_index), [1])
})

test('placing two furnaces with one held and no craft is refused: each placement passed the held-item preflight alone', async () => {
  const rcon = new StockRcon({ inventory: { 'stone-furnace': 1 } })
  const plan = ['Place the furnaces']
  const world = harness(rcon, [observe(), planMessage([PLACE_FURNACE, PLACE_FURNACE], plan), planMessage([PLACE_FURNACE], plan)])

  await world.agent.request('place two furnaces', { sender: 'tester' })

  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'batch_exceeds_observed_stock')
  assert.deepEqual(data(checked).short[0].items.map(({ item_name, needed, available, touched_by }) => ({ item_name, needed, available, touched_by })), [{ item_name: 'stone-furnace', needed: 1, available: 0, touched_by: [0] }])
  assert.equal(data(world.named('operations.preflight_recoverable')[0]).failure_class, 'model_correctable_batch_stock_insufficient')
  assert.match(world.harnessMessages(2)[0], /stone-furnace: needs 1, 0 left/)
  assert.equal(rcon.mutations.length, 1)
  assert.equal((rcon.mutations[0].match(/'place_entity'/g) ?? []).length, 1, 'only the single placement that the stock covers was admitted')
})

test('a second refusal for the same batch ends in the blocked path, never a loop: the correction turn is bounded', async () => {
  const rcon = new StockRcon({ inventory: { 'stone-furnace': 1 } })
  const twice = planMessage([PLACE_FURNACE, PLACE_FURNACE], ['Place the furnaces'])
  const world = harness(rcon, [observe(), twice, twice])

  const result = await world.agent.request('place two furnaces', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 0, 'nothing was ever admitted')
  assert.equal(result.blocker?.code, 'batch_stock_insufficient')
  assert.equal(world.named('operations.preflight_recoverable').length, 1)
  const [rejected] = world.named('operations.preflight_rejected')
  assert.equal(data(rejected).preflight.code, 'batch_stock_insufficient')
  assert.equal(data(rejected).refusal_class, 'argument')
})

test('a placement short with nothing in the batch bearing on it keeps the mod rejection and its blocker', async () => {
  const rcon = new StockRcon({ inventory: { 'iron-plate': 25 } })
  const world = harness(rcon, [observe(), planMessage([{ name: 'walk_to_position', args: { x: 1, y: 1 } }, PLACE_FURNACE], ['Place a furnace'])])

  const result = await world.agent.request('place a furnace', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.blocker?.code, 'placement_item_missing')
  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'shortage_not_touched_by_earlier_operations')
  assert.equal(world.named('placement.preflight_item_deferred').length, 0)
  assert.equal(world.named('operations.preflight_recoverable').length, 0)
  assert.equal(data(world.named('operations.preflight_rejected')[0]).preflight.code, 'placement_item_missing')
})

test('mining an entity cannot overturn the native placement shortage', async () => {
  const rcon = new StockRcon({ inventory: {} })
  const plan = ['Mine the rock and place a furnace']
  const world = harness(rcon, [
    observe(),
    planMessage([MINE_ROCK, PLACE_FURNACE], plan),
    planMessage([MINE_ROCK], plan),
  ])

  await world.agent.request('mine the rock and place a furnace', { sender: 'tester' })

  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'earlier_supply_not_deterministically_known')
  assert.equal(data(world.named('operations.preflight_recoverable')[0]).preflight.code, 'batch_stock_unverified_dependency')
  assert.equal(rcon.mutations.length, 1, 'only the corrected acquisition runs')
  assert.equal(world.named('placement.preflight_item_deferred').length, 0)
})

test('two withdrawals from one machine share its stock; a withdrawal that finds plates supplies the craft behind it', async () => {
  const plan = ['Take plates']
  const rcon = new StockRcon({ entities: { 77: { name: 'wooden-chest', stock: { 'iron-plate': 5 } } } })
  const refused = harness(rcon, [observe(), planMessage([take(77, 'iron-plate', 5), take(77, 'iron-plate', 5)], plan), planMessage([take(77, 'iron-plate', 5)], plan)])
  await refused.agent.request('take plates twice', { sender: 'tester' })
  const [checked] = refused.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'batch_exceeds_observed_stock')
  assert.deepEqual(data(checked).short[0].items.map(({ item_name, source, unit_number, touched_by }) => ({ item_name, source, unit_number, touched_by })), [{ item_name: 'iron-plate', source: 'entity', unit_number: 77, touched_by: [0] }])
  assert.match(refused.harnessMessages(2)[0], /iron-plate out of unit 77: needs 5, 0 left/)
  assert.equal(rcon.mutations.length, 1)

  const chain = new StockRcon({ entities: { 77: { name: 'wooden-chest', stock: { 'iron-plate': 8 } } } })
  const chained = harness(chain, [observe(), planMessage([take(77, 'iron-plate', 20), craft('iron-gear-wheel', 4)], ['Take plates and craft gears'])])
  await chained.agent.request('take plates and craft gears', { sender: 'tester' })
  assert.equal(chain.mutations.length, 1, 'a partial positive withdrawal is allowed and its plates are supply')
  assert.deepEqual(data(chained.named('operations.batch_stock_checked')[0]).deferred_by_earlier_op[0].dependencies, [{ item_name: 'iron-plate', operation_index: 0, operation: 'move_items_exact' }])
  const craftDeferred = data(chained.named('craft.preflight_stock_deferred')[0])
  assert.equal(craftDeferred.code, 'bootstrap_dependency_unresolved')
  assert.equal(craftDeferred.reason, 'earlier_operation_in_batch_supplies_item')
  assert.ok(craftDeferred.request_id)
})

test('a held multi-item shortage never conceals another item destination refusal', async () => {
  const rcon = new StockRcon({ inventory: { coal: 1 }, entities: { 15: { capacity: { coal: 0 } } } })
  const world = harness(rcon, [])
  world.agent.epoch = deployment()
  world.agent.active = true
  await assert.rejects(world.agent.preflightOperations([
    { name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 32 } },
    { name: 'supply_entity', args: { unit_number: 15, items: [{ item_name: 'wood', count: 1 }, { item_name: 'coal', count: 1 }] } },
  ]), error => error.preflight?.code === 'destination_full')
  assert.equal(rcon.mutations.length, 0)
})

test('unreadable recipe facts cannot promote the native placement refusal', async () => {
  const rcon = new StockRcon({ inventory: { stone: 5 }, recipeReadable: false })
  const world = harness(rcon, [observe(), planMessage([craft('stone-furnace', 1), PLACE_FURNACE], ['Craft and place']), planMessage([craft('stone-furnace', 1)], ['Craft and place'])])

  const result = await world.agent.request('craft and place', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1)
  assert.deepEqual(result.operations.map(operation => operation.name), ['craft_item'])
  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'earlier_supply_not_deterministically_known')
  assert.deepEqual(data(checked).unaccounted, [{ operation_index: 0, operation: 'craft_item', reason: 'recipe_unavailable', fail_closed: false }])
  assert.equal(world.named('placement.preflight_item_deferred').length, 0)
})

test('an unreadable inventory leaves the mod rejection standing, with the gap traced', async () => {
  const rcon = new StockRcon({ inventory: { stone: 5 }, inventoryReadable: false })
  const world = harness(rcon, [observe(), planMessage([craft('stone-furnace', 1), PLACE_FURNACE], ['Craft and place a furnace'])])

  const result = await world.agent.request('craft and place a furnace', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.blocker?.code, 'placement_item_missing')
  const [checked] = world.named('operations.batch_stock_checked')
  assert.equal(data(checked).reason, 'inventory_unavailable')
  assert.ok(data(checked).request_id)
})

test('a batch with one stock-claiming operation and no held rejection is not replayed: the mod preflight is already exact', async () => {
  const rcon = new StockRcon({ inventory: { 'iron-plate': 25 } })
  const world = harness(rcon, [observe(), planMessage([{ name: 'walk_to_position', args: { x: 2, y: 2 } }, craft('iron-gear-wheel', 10), { name: 'wait', args: { ticks: 60 } }], ['Craft gears'])])

  await world.agent.request('craft ten gears', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.named('operations.batch_stock_checked').length, 0)
})
