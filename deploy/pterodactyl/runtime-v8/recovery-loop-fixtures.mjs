// Fixtures for the composed recovery-loop scenarios (recovery-loop.test.mjs, unit 17).
//
// Earlier focused recovery tests often stopped at checkpoint acceptance or batch admission, or called
// resume helpers directly with scripted inventory readings. These fixtures let a scenario run the real
// chain end to end: the real NpcAgentLoop, the real Session scheduling (goal.paused -> considerPauseForAutoResume -> the timer ->
// fireModelResume -> runModelRecoverableResume -> recoverInterruptedAgentPlan), a scripted model that throws on an unexpected
// call, and a fake game whose world changes ONLY through admitted operations and the explicit passage of smelting time.
//
//   - FurnaceFactorio: a FakeFactorio with one stone furnace. Gathering adds ore; supply_entity and move_items_exact move items
//     between the actor and the furnace's fuel / source / output slots; smelting turns source ore into output plates while fuel
//     lasts. Nothing sets the actor inventory to an expected answer.
//   - ScriptedModel: queue-based provider. An unscripted call, a role mismatch or an unconsumed reply fails the scenario.
//   - recoveryWorld / recoverySession: the production Session wired to the agent through the same onActivity hook, with a real
//     event queue and the real game-line, player-request and UI-control entry points.

import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { MODEL_RECOVERABLE_RESUME_DELAY_MS } from './pause-class.mjs'
import { productionEstimateAnswer } from './steam-run-fixtures.mjs'
import { Session } from './supervisor.mjs'
import { answersStepContract, deployment, FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

export const KEY = 'npc:sgluna'
export const FURNACE_UNIT = 26
export const ACTOR_ID = 18
export const EPOCH = 3

// --- the world ---------------------------------------------------------------------------------------------------------------

const SMELTS_TO = { 'copper-ore': 'copper-plate', 'iron-ore': 'iron-plate', stone: 'stone-brick' }
const FUEL_KJ = { coal: 4000, wood: 2000, 'solid-fuel': 12000 }
const STACK = { coal: 50, wood: 100, 'copper-ore': 50, 'iron-ore': 50, stone: 50, 'copper-plate': 100, 'iron-plate': 100, 'stone-brick': 100 }
const CRAFT_KJ = 288 // 3.2 s of a 90 kW stone furnace
const SLOT = { fuel: 1, source: 2, output: 3 }
const stackOf = item => STACK[item] ?? 50

const total = counts => Object.values(counts).reduce((sum, count) => sum + count, 0)
const withoutZeros = counts => Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0))
// The live game prints an empty Lua table as {} and a populated inventory as a list.
const slotItems = counts => (total(counts) === 0 ? {} : Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })))

// The recipe the executor handoff reads for the contract item (the live getRecipeDetails shape for copper-plate).
export const COPPER_PLATE_RECIPE = {
  name: 'copper-plate',
  enabled: true,
  requested_crafts: 1,
  craftable_now_count: 0,
  craftable_now: false,
  inventory_overlay: {},
  bootstrap: { dependencies: [], first_unresolved: null },
  hidden: false,
  energy: 3.2,
  categories: ['smelting'],
  hand_craftable_category: false,
  ingredients: [{ type: 'item', name: 'copper-ore', amount: 1 }],
  products: [{ type: 'item', name: 'copper-plate', amount: 1 }],
  crafting_machine_count: 1,
  crafting_machines: [{
    name: 'stone-furnace', type: 'furnace', placed_by_item: 'stone-furnace', crafting_speed: 1, seconds_per_craft: 3.2, crafts_per_second: 0.3125,
    products_per_minute: [{ type: 'item', name: 'copper-plate', per_minute: 18.75 }], energy_source: 'burner', energy_watts: 90000,
    burner_effectivity: 1, fuel_categories: ['chemical'],
  }],
  crafting_machines_truncated: false,
}
const BURNER_FUELS = { categories: ['chemical'], matched_count: 3, truncated: false, items: [
  { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
  { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000 },
  { name: 'wood', category: 'chemical', fuel_value: 2000000 },
] }

const serpent = inventory => `{\n${Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => `  {\n    count = ${count},\n    name = "${name}"\n  }`).join(',\n')}\n}`

// operation -> the strict task types its receipt carries (task-loop-fixtures' map has no move_items_exact).
const TASK_TYPES = {
  gather_resource: ['walking_to_entity', 'mining'],
  supply_entity: ['moving_items'],
  move_items_exact: ['moving_items'],
}

// Every admitted operation in a mutation text, in order, parsed back from the Lua the harness rendered.
export function parseAdmittedOperations(text) {
  const operations = []
  const calls = [...text.matchAll(/remote\.call\('autorio_operations','([a-z_]+)'(,|\))/g)]
  for (const call of calls) {
    const rest = text.slice(call.index + call[0].length)
    const name = call[1]
    let match
    if (name === 'gather_resource' && (match = /^'([^']+)',(\d+),(\d+)\)/.exec(rest))) operations.push({ name, args: { resource_name: match[1], count: Number(match[2]) } })
    else if (name === 'supply_entity' && (match = /^(\d+),\{(.*?)\}\)/.exec(rest))) {
      const items = [...match[2].matchAll(/item_name='([^']+)',count=(\d+)/g)].map(item => ({ item_name: item[1], count: Number(item[2]) }))
      operations.push({ name, args: { unit_number: Number(match[1]), items } })
    }
    else if (name === 'move_items_exact' && (match = /^'([^']+)',(\d+),(\d+),(true|false)\)/.exec(rest))) {
      operations.push({ name, args: { item_name: match[1], unit_number: Number(match[2]), max_count: Number(match[3]), to_entity: match[4] === 'true' } })
    }
    else operations.push({ name, args: { raw: rest.slice(0, 80) } })
  }
  return operations
}

// The mod's preflight operation arguments, parsed from the rendered Lua table (keys sorted by the renderer).
function parsePreflight(text) {
  const name = /"autorio_preflight","operation",'([a-z_]+)'/.exec(text)?.[1]
  if (name === 'supply_entity') {
    const unit = Number(/\['unit_number'\]=(\d+)/.exec(text)?.[1])
    const items = [...text.matchAll(/\['count'\]=(\d+),\['item_name'\]='([^']+)'/g)].map(item => ({ item_name: item[2], count: Number(item[1]) }))
    return { name, args: { unit_number: unit, items } }
  }
  if (name === 'move_items_exact') {
    return { name, args: {
      item_name: /\['item_name'\]='([^']+)'/.exec(text)?.[1],
      max_count: Number(/\['max_count'\]=(\d+)/.exec(text)?.[1]),
      to_entity: /\['to_entity'\]=true/.test(text),
      unit_number: Number(/\['unit_number'\]=(\d+)/.exec(text)?.[1]),
    } }
  }
  return { name, args: {} }
}

export class FurnaceFactorio extends FakeFactorio {
  constructor({ inventory = {}, furnace = {}, connectedPlayers = 0 } = {}) {
    super({ inventory })
    this.status = deployment({ connected_players: connectedPlayers, actor_id: ACTOR_ID, epoch: EPOCH })
    this.furnace = {
      unit_number: FURNACE_UNIT,
      name: 'stone-furnace',
      position: { x: 3, y: 3 },
      fuel: {},
      source: {},
      output: {},
      energy_kj: 0,
      ...furnace,
    }
    this.preflight = text => this.furnacePreflight(text)
    this.pendingBatch = null
    this.completedBatches = []
    this.sent = [] // every admitted batch's parsed operations, in order (a replay shows up as a second entry)
    this.effects = [] // what each operation actually moved, in the order it ran
    this.dropAckOnce = false
    this.generation = 1
    this.cancels = []
    this.stopFollows = 0
    this.lastCompleted = undefined
    this.receipts = []
    this.readCommands = []
    this.preflights = [] // every preflight the harness asked, with the world answer
  }

  // --- the furnace -----------------------------------------------------------------------------------------------------------

  slotAccepts(slot, item) {
    const held = this.furnace[slot]
    const heldItem = Object.keys(withoutZeros(held))[0]
    if (slot === 'fuel' && !(item in FUEL_KJ)) return 0
    if (slot === 'source' && !(item in SMELTS_TO)) return 0
    if (heldItem && heldItem !== item) return 0
    return Math.max(0, stackOf(item) - (held[item] ?? 0))
  }

  // Smelting time passes: each craft turns one source ore into one plate while the furnace has energy or fuel to burn.
  smelt(crafts) {
    let done = 0
    for (; done < crafts; done++) {
      const ore = Object.keys(withoutZeros(this.furnace.source))[0]
      if (!ore) break
      if (total(this.furnace.output) >= stackOf(SMELTS_TO[ore])) break
      if (this.furnace.energy_kj < CRAFT_KJ) {
        const fuel = Object.keys(withoutZeros(this.furnace.fuel))[0]
        if (!fuel) break
        this.furnace.fuel[fuel] -= 1
        this.furnace.energy_kj += FUEL_KJ[fuel]
      }
      this.furnace.energy_kj -= CRAFT_KJ
      this.furnace.source[ore] -= 1
      const plate = SMELTS_TO[ore]
      this.furnace.output[plate] = (this.furnace.output[plate] ?? 0) + 1
    }
    this.furnace.source = withoutZeros(this.furnace.source)
    this.furnace.fuel = withoutZeros(this.furnace.fuel)
    return done
  }

  entityStatus() {
    const { source, fuel, output } = this.furnace
    if (total(source) === 0) return { status: 20, status_name: 'no_ingredients', working: false }
    if (total(fuel) === 0 && this.furnace.energy_kj < CRAFT_KJ) return { status: 6, status_name: 'no_fuel', working: false }
    if (total(output) >= 100) return { status: 26, status_name: 'full_output', working: false }
    return { status: 1, status_name: 'working', working: true }
  }

  nearbySnapshot() {
    const status = this.entityStatus()
    return {
      actor_position: { x: 0, y: 0 },
      entities: [{ name: this.furnace.name, type: 'furnace', unit_number: this.furnace.unit_number, position: this.furnace.position, distance: 4.2, status: status.status, working: status.working }],
    }
  }

  entityRead() {
    const status = this.entityStatus()
    return { found: true, entity: {
      unit_number: this.furnace.unit_number,
      name: this.furnace.name,
      type: 'furnace',
      status_name: status.status_name,
      working: status.working,
      inventories: [
        { index: SLOT.fuel, items: slotItems(this.furnace.fuel) },
        { index: SLOT.source, items: slotItems(this.furnace.source) },
        { index: SLOT.output, items: slotItems(this.furnace.output) },
      ],
    } }
  }

  // --- preflight: the mod's transfer facts, computed from the world as it is NOW ------------------------------------------------

  furnacePreflight(text) {
    const { name, args } = parsePreflight(text)
    const result = name === 'supply_entity' ? this.supplyPreflight(args) : name === 'move_items_exact' ? this.collectPreflight(args) : { ok: true }
    this.preflights.push({ name, args, result })
    return result
  }

  targetFacts() {
    return { unit_number: this.furnace.unit_number, name: this.furnace.name, position: this.furnace.position, surface_index: 1, force_index: 1 }
  }

  supplyPreflight({ unit_number: unit, items }) {
    const entries = items.map((item) => {
      const slot = item.item_name in FUEL_KJ ? 'fuel' : 'source'
      const held = this.inventory[item.item_name] ?? 0
      const accepts = this.slotAccepts(slot, item.item_name)
      const expected = Math.min(item.count, held, accepts)
      return {
        item_name: item.item_name,
        requested: item.count,
        source_count: held,
        destination_accepts: accepts,
        expected_moved: expected,
        missing: Math.max(0, item.count - held),
        status: held < item.count ? 'supply_missing' : accepts === 0 ? 'destination_full' : 'ok',
        single_slot_destination: { inventory_index: SLOT[slot], slot_count: 1 },
      }
    })
    const result = { operation: 'supply_entity', field: 'unit_number', identity: unit, target: this.targetFacts(), transfer: { direction: 'to_entity', items: entries }, refusal_class: 'world' }
    // Two different item kinds competing for the one slot of the same inventory.
    const bySlot = new Map()
    let conflict
    for (const entry of entries) {
      const index = entry.single_slot_destination.inventory_index
      if (bySlot.has(index) && bySlot.get(index) !== entry.item_name) conflict ??= { inventory_index: index, slot_count: 1, item_names: [bySlot.get(index), entry.item_name] }
      bySlot.set(index, entry.item_name)
    }
    if (entries.some(entry => entry.status === 'supply_missing')) return { ok: false, code: 'supply_missing', ...result }
    if (conflict) return { ok: false, code: 'supply_destination_conflict', ...result, transfer: { ...result.transfer, destination_conflict: conflict } }
    const full = entries.find(entry => entry.status === 'destination_full')
    if (full) return { ok: false, code: 'destination_full', ...result }
    return { ok: true, ...result }
  }

  collectPreflight({ item_name: item, max_count: max, to_entity: toEntity, unit_number: unit }) {
    if (toEntity) return { ok: true }
    const available = this.furnace.output[item] ?? 0
    const entry = { item_name: item, requested: max, source_count: available, destination_accepts: 1000, expected_moved: Math.min(max, available), missing: 0, status: available > 0 ? 'ok' : 'extraction_empty' }
    const result = { operation: 'move_items_exact', field: 'unit_number', identity: unit, target: this.targetFacts(), transfer: { direction: 'from_entity', items: [entry] }, refusal_class: 'world' }
    return available > 0 ? { ok: true, ...result } : { ok: false, code: 'extraction_empty', ...result }
  }

  // --- admission and completion -------------------------------------------------------------------------------------------------

  async command(text) {
    if (text.includes('remote.call("autorio_operations","status")')) {
      const pending = this.pendingBatch
      return JSON.stringify({
        task_state: this.taskState,
        batch_generation: this.generation,
        queue_empty: this.queueLength === 0,
        queue_length: this.queueLength,
        active_batch: pending ? { batch_id: pending.batch_id, batch_generation: this.generation, task_count: this.lastTaskTypes.length, task_types: this.lastTaskTypes } : undefined,
        last_completed_batch: this.lastCompleted,
        last_cancelled_batch: this.cancelledBatch,
        admission_journal: this.admissionJournal(),
        receipt_journal: [...this.receipts],
        basic_operation: this.batchId > 0 ? { last_result: this.lastBasicResult } : undefined,
      })
    }
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearbySnapshot())
    if (text.includes('remote.call("autorio_operations","stop_follow_player")')) {
      this.stopFollows += 1
      return ''
    }
    if (text.includes('remote.call("sgluna_deployment","cancel")')) {
      // A stop cancels queued work that has not run: nothing it would have moved ever moves.
      this.cancels.push({ pending: this.pendingBatch })
      this.pendingBatch = null
      this.taskState = 'idle'
      this.queueLength = 0
      return ''
    }
    if (text.includes('"autorio_discovery","find_entities"')) {
      // Static resource patches: the nearest patch of the named resource, far from the furnace.
      const resource = /"find_entities",'([^']+)'/.exec(text)?.[1]
      return JSON.stringify({ found: true, name: resource, actor_position: { x: 0, y: 0 }, searched_radius: 193, max_radius: 1024, matched_count: 1, returned_count: 1, truncated: false,
        entities: [{ name: resource, type: 'resource', position: { x: 192.5, y: 8.5 }, distance: 192.69, amount: 2200, force: 'neutral' }] })
    }
    if (text.includes('remote.call("autorio_skills","offer"')) return JSON.stringify({ ok: true, cards: [] })
    if (text.includes('"autorio_knowledge","production_estimate"')) return JSON.stringify(productionEstimateAnswer(text))
    if (text.includes('"evaluate_condition"') && text.includes('entity_state')) {
      const status = this.entityStatus()
      return JSON.stringify({ ok: true, kind: 'entity_state', satisfied: status.working, progressing: status.working, progress_known: true, entity_status: status.status, unit_number: this.furnace.unit_number })
    }
    if (text.includes('get_entity_status')) {
      this.readCommands.push('get_entity_status')
      return JSON.stringify(this.entityRead())
    }
    if (text.includes('"get_inventory_items"')) return serpent(this.inventory)
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      if (name === 'copper-plate') return JSON.stringify({ found: true, query: name, truncated: false, recipes: [COPPER_PLATE_RECIPE], mined_from: ['copper-ore'], burner_fuels: BURNER_FUELS })
      if (name === 'copper-ore') return JSON.stringify({ found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name', mined_from: ['copper-ore'] })
      return JSON.stringify({ found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name' })
    }
    if (text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      const before = this.batchId
      const reply = await super.command(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      const parsed = marker && reply.startsWith(marker) ? JSON.parse(reply.slice(marker.length)) : undefined
      if (parsed?.ok === true && this.batchId > before) {
        const operations = parseAdmittedOperations(text)
        this.pendingBatch = { batch_id: this.batchId, operations }
        this.sent.push({ batch_id: this.batchId, operations })
        // One moving_items task per supplied item, like the mod's receipt.
        this.lastTaskTypes = operations.flatMap(operation => (operation.name === 'supply_entity'
          ? operation.args.items.map(() => 'moving_items')
          : (TASK_TYPES[operation.name] ?? ['waiting'])))
        this.taskState = this.lastTaskTypes[0] ?? 'waiting'
        this.queueLength = 1
        if (this.dropAckOnce) {
          this.dropAckOnce = false
          return ''
        }
      }
      return reply
    }
    return super.command(text)
  }

  // The game finishes the pending batch: each operation runs in order against the world as it is when it runs.
  completeBatch() {
    const batch = this.pendingBatch
    assert.ok(batch, 'completeBatch: no admitted batch is pending')
    let moved
    for (const operation of batch.operations) {
      const { args } = operation
      if (operation.name === 'gather_resource') {
        this.inventory[args.resource_name] = (this.inventory[args.resource_name] ?? 0) + args.count
        this.effects.push({ batch_id: batch.batch_id, operation: operation.name, item: args.resource_name, moved: args.count })
      }
      else if (operation.name === 'supply_entity') {
        for (const item of args.items) {
          const slot = item.item_name in FUEL_KJ ? 'fuel' : 'source'
          const count = Math.min(item.count, this.inventory[item.item_name] ?? 0, this.slotAccepts(slot, item.item_name))
          if (count > 0) {
            this.inventory[item.item_name] -= count
            this.furnace[slot][item.item_name] = (this.furnace[slot][item.item_name] ?? 0) + count
          }
          moved = { item: item.item_name, count: (moved?.operation === operation ? moved.count : 0) + count, to_entity: true, unit: args.unit_number, operation }
          this.effects.push({ batch_id: batch.batch_id, operation: operation.name, item: item.item_name, moved: count, to_entity: true })
        }
      }
      else if (operation.name === 'move_items_exact') {
        const slot = args.to_entity ? (args.item_name in FUEL_KJ ? 'fuel' : 'source') : 'output'
        const count = args.to_entity
          ? Math.min(args.max_count, this.inventory[args.item_name] ?? 0, this.slotAccepts(slot, args.item_name))
          : Math.min(args.max_count, this.furnace.output[args.item_name] ?? 0)
        if (count > 0) {
          if (args.to_entity) {
            this.inventory[args.item_name] -= count
            this.furnace[slot][args.item_name] = (this.furnace[slot][args.item_name] ?? 0) + count
          }
          else {
            this.furnace.output[args.item_name] -= count
            this.inventory[args.item_name] = (this.inventory[args.item_name] ?? 0) + count
          }
        }
        moved = { item: args.item_name, count, to_entity: args.to_entity, unit: args.unit_number, operation }
        this.effects.push({ batch_id: batch.batch_id, operation: operation.name, item: args.item_name, moved: count, to_entity: args.to_entity })
      }
    }
    for (const key of Object.keys(this.inventory)) if (this.inventory[key] === 0) delete this.inventory[key]
    this.furnace.fuel = withoutZeros(this.furnace.fuel)
    this.furnace.source = withoutZeros(this.furnace.source)
    this.furnace.output = withoutZeros(this.furnace.output)
    this.completedBatches.push(batch)
    this.lastCompleted = { batch_id: batch.batch_id, batch_generation: this.generation, batch_ref: `batch-g${this.generation}-${batch.batch_id}`, task_count: this.lastTaskTypes.length, task_types: this.lastTaskTypes, tick: 600 + batch.batch_id }
    this.receipts.push({ ...this.lastCompleted, state: 'completed' })
    for (const record of this.admissions) if (record.batch_id === batch.batch_id) record.state = 'completed'
    this.pendingBatch = null
    this.taskState = 'idle'
    this.queueLength = 0
    this.lastBasicResult = {
      operation_id: batch.batch_id, tick: 600 + batch.batch_id, actor_id: this.status.actor_id, accepted: true, completed: true, code: 'completed',
      type: 'moving_items', moved_count: moved?.count ?? 0, to_entity: moved?.to_entity ?? true, target_unit_number: moved?.unit,
    }
    return batch
  }

  // A save/load: the queue and the batch records are gone, the batch generation moves on, and an admission the journal cannot prove
  // completed is uncertain. A batch that was still queued never ran.
  reloadMod() {
    this.generation += 1
    this.pendingBatch = null
    this.lastCompleted = undefined // the live batch records are gone; the receipt journal is saved with the map
    this.taskState = 'idle'
    this.queueLength = 0
    for (const record of this.admissions) if (record.state !== 'completed') record.state = 'uncertain'
  }

  // Item counts that exist anywhere in the world the fake models (actor + furnace); conservation checks use it.
  worldTotals() {
    const totals = { ...this.inventory }
    for (const slot of ['fuel', 'source', 'output']) for (const [item, count] of Object.entries(this.furnace[slot])) totals[item] = (totals[item] ?? 0) + count
    return totals
  }
}

// --- the model -----------------------------------------------------------------------------------------------------------------

// A queue of replies, each tagged with the role that must ask for it. An unscripted call, a role mismatch and a reply left over
// at the end all fail the scenario; there is no success fallback.
export class ScriptedModel {
  constructor() {
    this.queue = []
    this.calls = []
    this.violations = []
  }

  push(role, label, reply, times = 1) {
    for (let index = 0; index < times; index++) this.queue.push({ role, label, reply })
    return this
  }

  async provide(messages, context) {
    const role = context?.role ?? 'planner'
    const next = this.queue.shift()
    const call = { index: this.calls.length, role, label: next?.label, messages: messages.map(message => ({ ...message })), context }
    this.calls.push(call)
    if (!next) {
      const failure = `unscripted provider call ${call.index + 1} (role=${role}, trigger=${context?.triggerSource ?? '-'})`
      this.violations.push(failure)
      throw new Error(failure)
    }
    if (next.role !== role) {
      const failure = `provider call ${call.index + 1} came from role ${role} but "${next.label}" is scripted for ${next.role}`
      this.violations.push(failure)
      throw new Error(failure)
    }
    return typeof next.reply === 'function' ? next.reply(messages, context, call) : { ...next.reply }
  }

  get remaining() {
    return this.queue.map(entry => entry.label)
  }

  get labels() {
    return this.calls.map(call => call.label)
  }
}

// --- the agent, the session ----------------------------------------------------------------------------------------------------

export function recoveryWorld({ game, model, stateFile = null, memory = new CanonicalTaskBoardMemory(), agentRoleConfig, roleProvider } = {}) {
  const trace = []
  let lastTraceAt = 0
  const agentLogs = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    completionProtocolVersion: 2,
    replacementWake: true,
    provider: answersStepContract((messages, context) => roleProvider ? roleProvider(messages, context, model) : model.provide(messages, context)),
    ...(agentRoleConfig ? { agentRoleConfig } : {}),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    log: line => agentLogs.push(String(line)),
    systemPrompt: 'recovery loop scenario',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  // The row ts is strictly increasing so run-check orders rows of different requests as they were written.
  agent.behaviorTrace = { emit: async (record) => {
    lastTraceAt = Math.max(Date.parse(record.ts) || Date.now(), lastTraceAt + 1)
    trace.push({ ...record, ts: new Date(lastTraceAt).toISOString() })
  } }
  const named = name => trace.filter(row => row.event === name).map(row => row.data)
  return { game, model, memory, agent, trace, named, jev, agentLogs }
}

// The production Session around an agent: the real event queue, the real onAgentActivity hook, the real game-line, player-request and
// UI-control entry points. Only the I/O edges are stubbed (chat goes to an array, the Task Board UI is a no-op).
export function recoverySession(world, { actorId = ACTOR_ID, epoch = EPOCH } = {}) {
  const { agent } = world
  const chat = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent,
    npcId: 'sgluna',
    npcName: 'SGLuna',
    ready: true,
    stopping: false,
    autoResume: null,
    modelResume: null,
    intakeRetry: null,
    lastPauseDecision: '',
    lastCompletionAt: 0,
    lastErrorAt: 0,
    cancelGeneration: 0,
    config: { chatPlayers: { allow_all: true } },
    lastStatus: { actor_id: actorId, epoch },
    liveStatus: { actor_id: actorId, epoch },
    eventQueue: Promise.resolve(),
    agentLive: { phase: 'idle', activity: [], debug: undefined },
    activityEpoch: 1,
    activitySequence: 0,
    log: (message) => { logs.push(String(message)) },
    printChat: async (message) => { chat.push(String(message)) },
    // The status the supervisor reads from the game: the fake's own deployment status, like the production rawStatus.
    rawStatus: async () => JSON.parse(await world.game.command('/silent-command rcon.print(helpers.table_to_json(remote.call("sgluna_deployment","status")))')),
    syncTaskBoardUi: async () => {},
    clearTaskBoardUi: async () => {},
    requestTaskBoardUiSync: () => {},
    ackTaskBoardUiLifecycle: async () => {},
    appendUiConversation: () => {},
    startNewUiConversation: () => {},
    applyNavigationObstaclePolicy: async () => {},
    ensureAuthorization: async () => ({}),
    rcon: world.game,
  })
  // The agent reports through the same hook the production Session installs (supervisor.mjs, onActivity), so goal.paused queues
  // the pause decision exactly as it does live.
  agent.onActivity = (event, data) => session.onAgentActivity(event, data)
  return { session, chat, logs }
}

// Drains the session's event queue to quiescence: events that queue more events (a pause queues its auto-resume decision, a fired
// timer queues the resume job, a failed attempt queues the next decision) are all awaited.
export async function settle(session) {
  for (let spin = 0; spin < 200; spin++) {
    const queue = session.eventQueue
    await queue
    await new Promise(resolve => setImmediate(resolve))
    if (queue === session.eventQueue) return
  }
  throw new Error('the session event queue never settled')
}

// --- the run G -> H -> I scenario ------------------------------------------------------------------------------------------------
//
// One finite goal, one long step: hold 10 copper plates. The world is a stone furnace (unit 26) and an actor with coal, copper ore
// and some iron ore it does not need.
//   batch 1  the planner loads the furnace: 5 coal and all 12 copper ore.
//   (time)   nine plates are smelted; the executor collects the nine that are ready (batch 2).
//   (time)   the last three plates finish smelting while the executor is deciding what to do next.
//   run G    the executor does not account for the three plates in the furnace; it plans to mine more ore and load iron ore and
//            copper ore into the furnace's one source slot. The game refuses that preflight, twice (one correction turn).
//   run H    the automatic resume restages a fresh executor, which answers with a checkpoint and no operation, then claims BLOCKED.
//   run I    the next automatic resume restages the executor onto the same world, now with the furnace output in its packet.

export const STEP = 'Smelt copper ore in the furnace and collect 10 copper plates'
export const OBJECTIVE = 'smelt ten copper plates in the furnace'
export const PLATES = inventoryCheckpoint('copper-plate', 10)
export const GOAL = { scope: 'finite', summary: 'Have 10 copper plates.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] }
export const det = checkpoint => ({ kind: 'deterministic', checkpoint })

export const observation = () => ({ content: null, tool_calls: [{ id: 'call_obs', index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }] })
export const supply = items => ({ name: 'supply_entity', args: { unit_number: FURNACE_UNIT, items } })
export const collect = count => ({ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: FURNACE_UNIT, max_count: count, to_entity: false } })
export const executorPlan = (operations, extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, ...extra })
export const plannerDraft = () => planReply({
  plan: [STEP],
  currentStep: 0,
  operations: [supply([{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 12 }])],
  checkpoint: PLATES,
  goal: GOAL,
  stepCompletions: [det(PLATES)],
})
// Run G's batch: mine more copper ore, then load iron ore and copper ore into the furnace's one source slot.
export const mixedOreBatch = () => [gather('copper-ore', 10), supply([{ item_name: 'coal', count: 5 }, { item_name: 'iron-ore', count: 20 }, { item_name: 'copper-ore', count: 10 }])]
export const BLOCKED_REPLY = () => planReply({ chatMessage: 'BLOCKED: no copper ore is within reach and the furnace cannot take another ore', plan: [STEP], currentStep: 0, operations: [] })

export const newCopperGame = options => new FurnaceFactorio({ inventory: { coal: 10, 'copper-ore': 12, 'iron-ore': 20 }, ...options })

// The harness identifies a built step block by its header.
export const stepBlockLines = (messages) => {
  const block = messages.find(message => typeof message?.content === 'string' && message.content.startsWith('--- step block ---'))
  return typeof block?.content === 'string' ? block.content.split('\n') : []
}

// The game finishes the pending batch (optionally with smelting time passing) and reports "All operations completed" the way the
// mod's console line does; the supervisor turns that into agent.completed().
export async function reportCompletion(ctx) {
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
}

export async function completeAndReport(ctx, { smelt = 0 } = {}) {
  ctx.game.completeBatch()
  if (smelt > 0) ctx.game.smelt(smelt)
  await reportCompletion(ctx)
}

// The scheduled resume timer fires (mock time), and everything it queues runs to quiescence.
export async function fireResumeTimer(ctx) {
  assert.ok(ctx.session.modelResume?.timer, 'a model_recoverable resume timer is pending')
  ctx.t.mock.timers.tick(MODEL_RECOVERABLE_RESUME_DELAY_MS)
  await settle(ctx.session)
}

// Starts the goal and drives it to run G's second refusal: a model_recoverable pause with a resume timer pending.
// Everything goes through the production entry points: a player request, the mod's completion line, the agent's goal.paused
// activity, the session's event queue and its (mocked) timer.
export async function reachRunG(t, { stateFile = null, game = newCopperGame(), model = new ScriptedModel() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  model
    .push('planner', 'planner:observe', observation())
    .push('planner', 'planner:load-furnace', plannerDraft())
    .push('executor', 'executor:observe', observation())
    .push('executor', 'executor:collect-ready-plates', executorPlan([collect(9)]))
    .push('executor', 'executor:observe-again', observation())
    .push('executor', 'executor:mixed-ore-batch', executorPlan(mixedOreBatch()))
    .push('executor', 'executor:mixed-ore-batch-again', executorPlan(mixedOreBatch()))
  const world = recoveryWorld({ game, model, stateFile })
  const { session, chat, logs } = recoverySession(world)
  const ctx = { t, game, model, world, session, chat, logs, stateFile }

  assert.equal(session.queuePlayerRequest('TTLouis', OBJECTIVE), true)
  await settle(session)
  await completeAndReport(ctx, { smelt: 9 }) // batch 1 landed; nine plates are ready
  // batch 2 landed (nine plates collected); the last three finish smelting while the executor decides what to do next
  game.completeBatch()
  game.smelt(3)
  ctx.worldBeforeRefusal = JSON.parse(JSON.stringify({ totals: game.worldTotals(), sent: game.sent.length, effects: game.effects.length }))
  await reportCompletion(ctx)
  return ctx
}

// What every scenario must hold at the end: the fake world saw no command it does not model, the scripted model was asked exactly
// what the scenario scripted, and nothing in the session or the agent logged a failure of its own.
export function assertStrictBoundary(ctx, { allowedLogs = [] } = {}) {
  assert.deepEqual(ctx.game.unknown, [], 'the fake game saw a command it does not model')
  assert.deepEqual(ctx.model.violations, [], 'the scripted model was asked for something unscripted')
  assert.deepEqual(ctx.model.remaining, [], 'scripted replies were never asked for')
  const bad = [...ctx.logs, ...(ctx.world.agentLogs ?? [])].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line) && !allowedLogs.some(allowed => allowed.test(line)))
  assert.deepEqual(bad, [])
}
