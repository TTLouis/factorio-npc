import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

// Repair unit G (G1/G2): the harness closes the active step as soon as a FRESH read of its committed, machine-checkable
// checkpoint shows it already met, before a batch is admitted or a wait runs. It reuses the ordinary step-close evaluator;
// it closes only on a verified read, never on an unreadable, stale or other-actor one, never on a prose-only step, and
// never closes a step twice. The committed plan never changes; only its progress advances. A fake Factorio and scripted
// model replies; no provider is called.

const KEY = 'npc:sgluna'

function deployment(epoch = 3) {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

const TWO_STEPS = ['Smelt iron plates until furnace 15 holds 50', 'Craft one gear wheel']
const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const planMessage = (operations, { plan = TWO_STEPS, currentStep = 0, checkpoint } = {}) =>
  ({ content: JSON.stringify({ chatMessage: '', plan, currentStep, operations, ...(checkpoint ? { checkpoint } : {}) }) })

const furnaceCheckpoint = (minimum = 50) => ({
  mode: 'all',
  requirements: [{ id: 'furnace_plates', kind: 'entity_inventory_count', unit_number: 15, item_name: 'iron-plate', minimum }],
})
const COAL_SUPPLY = { name: 'supply_entity', args: { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] } }
const WAIT = { name: 'wait', args: { ticks: 600 } }
const TAKE_PLATES = { name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 15, max_count: 50, to_entity: false } }
const GEAR = { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }

class Rcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.epoch = 3
    this.stock = { '15:iron-plate': 20 }
    this.unreadable = undefined // 'garbage' | 'not_ok' | 'throw'
    this.changeEpochOnCondition = false
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 15, position: { x: 3, y: 0 }, distance: 3 }],
    }
    this.operationStatus = { task_state: 'idle', queue_empty: true, queue_length: 0 }
    this.admissions = []
    this.batchSequence = 0
  }

  admissionJournal() {
    for (const record of this.admissions) {
      if (record.state !== 'admitted') continue
      if (this.operationStatus.last_completed_batch?.batch_id === record.batch_id) record.state = 'completed'
    }
    return this.admissions
  }

  conditionReads() { return this.commands.filter(text => text.includes('"evaluate_condition"')).length }

  evaluate(text) {
    if (this.changeEpochOnCondition) this.epoch++
    const request = JSON.parse(text.match(/json_to_table\('(\{.*\})'\)/)[1])
    if (request.kind === 'entity_inventory_count') {
      const current = this.stock[`${request.unit_number}:${request.item_name}`] ?? 0
      return { ok: true, kind: request.kind, unit_number: request.unit_number, item_name: request.item_name, current, minimum: request.minimum, satisfied: current >= request.minimum, progressing: false, progress_known: true }
    }
    return { ok: true, kind: request.kind, unit_number: request.unit_number, exists: true, satisfied: true, progressing: false, progress_known: true }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment(this.epoch))
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_tools","evaluate_condition"')) {
      if (this.unreadable === 'throw') throw new Error('rcon transport error')
      if (this.unreadable === 'garbage') return 'not json'
      if (this.unreadable === 'not_ok') return JSON.stringify({ ok: false, error: 'condition_unavailable' })
      return JSON.stringify(this.evaluate(text))
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ ...this.operationStatus, batch_generation: 1, admission_journal: this.admissionJournal(), receipt_journal: [] })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
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
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const rows = []
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
    systemPrompt: 'fresh read step close test',
    npcId: 'sgluna',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  return {
    agent,
    memory,
    rows,
    calls,
    named: name => rows.filter(row => row.event === name),
    plan: () => memory.currentPlan(KEY),
    tracker: () => getActivePlan(memory.planningState(KEY)),
    harnessMessages: callIndex => calls[callIndex].map(message => String(message.content ?? '')).filter(content => content.startsWith('[HARNESS]')),
  }
}

const observe = () => ({ content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] })
const data = row => row.data ?? row
const continuation = world => world.agent.continueFromModMessage('[MOD] Autorio operation batch completed.', 'factorio.completion_continuation')

// The first reply commits the plan with its first batch (the checkpoint, when given, is attached to step 1); that batch has finished.
async function committedStep(world, rcon, { stock = 20, hasCheckpoint = true } = {}) {
  rcon.stock['15:iron-plate'] = stock
  await world.agent.request('get fifty iron plates', { sender: 'tester' })
  assert.equal(rcon.mutations.length, 1, 'the first batch was admitted')
  rcon.operationStatus = { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1', task_count: 1, task_types: ['moving_items'], tick: 300 } }
  const tracker = getActivePlan(world.memory.planningState(KEY))
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(tracker.status), `committed (was ${tracker.status})`)
  assert.equal(world.plan().task_board.steps[0].completion_contract !== undefined, hasCheckpoint)
  return structuredClone(tracker)
}

const firstTwo = (extra = []) => [observe(), planMessage([COAL_SUPPLY], { checkpoint: furnaceCheckpoint() }), ...extra]

test('G1: a wait-only batch whose committed checkpoint is already met closes the step first, runs no timer, and the model authors the next step', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([WAIT]), planMessage([GEAR], { currentStep: 1 })]))
  const committed = await committedStep(world, rcon, { stock: 60 })
  const readsBefore = rcon.conditionReads()

  await continuation(world)

  // The wait never ran (not as a timer, not routed to a condition wait); only the next step's batch did.
  assert.equal(rcon.mutations.length, 2)
  assert.doesNotMatch(rcon.mutations[1], /'wait'/)
  assert.match(rcon.mutations[1], /craft_item/)
  assert.equal(world.plan().condition_wait, undefined)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
  assert.ok(rcon.conditionReads() > readsBefore, 'a fresh read was taken')
  assert.equal(world.plan().task_board.completed_count, 1)
  assert.equal(world.plan().task_board.active_step_id, 'step_2')

  const [closed] = world.named('plan.step_closed_on_fresh_read')
  const payload = data(closed)
  assert.ok(payload.request_id)
  assert.equal(payload.reason, 'checkpoint_met_before_wait')
  assert.equal(payload.plan_id, committed.plan_id)
  assert.equal(payload.step_index, 0)
  assert.equal(payload.step_id, 'step_1')
  assert.deepEqual(payload.operations_not_run, ['wait'])
  assert.deepEqual(payload.evidence.map(item => [item.id, item.kind, item.satisfied]), [['furnace_plates', 'entity_inventory_count', true]])
  // The ordinary evaluator closed it: its own verified trace and the contract verdict, with the checkpoint as evidence.
  assert.ok(world.named('step.verified').some(row => data(row).source === 'deterministic_completion_contract'))
  assert.equal(world.named('plan.step_close_skipped_on_fresh_read').length, 0)
  const [fact] = world.harnessMessages(3).filter(message => message.includes('closed that step'))
  assert.match(fact, /\(wait\) was written for the step that closed and did not run/)
  assert.match(fact, /The active step is now "Craft one gear wheel"/)

  // The committed plan never changes; only the Plan Tracker's progress advanced.
  const after = world.tracker()
  assert.equal(after.plan_id, committed.plan_id)
  assert.deepEqual(after.steps, committed.steps)
  assert.equal(after.active_step_index, committed.active_step_index + 1)
  assert.equal(world.plan().status, 'active')
})

test('G2: a batch for a step whose committed checkpoint is already met closes the step before admission and never runs for the closed step', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([TAKE_PLATES]), planMessage([GEAR], { currentStep: 1 })]))
  const committed = await committedStep(world, rcon, { stock: 60 })

  await continuation(world)

  assert.equal(rcon.mutations.length, 2)
  assert.doesNotMatch(rcon.mutations.join('\n'), /move_items_exact/, 'the collection was never admitted')
  assert.match(rcon.mutations[1], /craft_item/)
  assert.equal(rcon.stock['15:iron-plate'], 60)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  const [closed] = world.named('plan.step_closed_on_fresh_read')
  assert.equal(data(closed).reason, 'checkpoint_met_before_batch')
  assert.deepEqual(data(closed).operations_not_run, ['move_items_exact'])
  assert.ok(data(closed).request_id)
  assert.deepEqual(world.tracker().steps, committed.steps)
  assert.equal(world.plan().task_board.completed_count, 1)
  // The re-authored batch went through the ordinary admission for the new active step (its craft was preflighted).
  assert.ok(world.named('operations.preflight_ok').length >= 2)
})

test('the final step closes through the ordinary settlement, with no further model call', async () => {
  const rcon = new Rcon()
  const one = { plan: [TWO_STEPS[0]] }
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY], { ...one, checkpoint: furnaceCheckpoint() }), planMessage([TAKE_PLATES], one)])
  await committedStep(world, rcon, { stock: 60 })

  await continuation(world)

  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.calls.length, 3, 'no re-authoring turn after a completed plan')
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, PLAN_STATUS.COMPLETED)
  assert.equal(data(world.named('plan.step_closed_on_fresh_read')[0]).reason, 'checkpoint_met_before_batch')
})

test('an unmet checkpoint changes nothing: the batch is handled exactly as before and no close or skip is traced', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([GEAR])]))
  await committedStep(world, rcon, { stock: 20 })

  await continuation(world)

  assert.equal(rcon.mutations.length, 2)
  assert.match(rcon.mutations[1], /craft_item/)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)
  assert.equal(world.named('plan.step_close_skipped_on_fresh_read').length, 0)
  assert.equal(world.plan().task_board.completed_count, 0)
  assert.equal(world.plan().task_board.active_step_id, 'step_1')
  assert.equal(world.calls.length, 3)
})

test('an unreadable checkpoint never closes the step: the skip is traced and the batch proceeds as before', async () => {
  for (const mode of ['throw', 'garbage', 'not_ok']) {
    const rcon = new Rcon()
    const world = harness(rcon, firstTwo([planMessage([GEAR])]))
    await committedStep(world, rcon, { stock: 60 })
    rcon.unreadable = mode

    await continuation(world)

    assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0, mode)
    assert.equal(world.plan().task_board.completed_count, 0, mode)
    assert.equal(rcon.mutations.length, 2, `${mode}: the batch proceeded`)
    const [skipped] = world.named('plan.step_close_skipped_on_fresh_read')
    assert.ok(skipped, `${mode}: traced`)
    assert.ok(data(skipped).request_id)
    assert.equal(data(skipped).reason, 'checkpoint_unreadable')
    assert.equal(data(skipped).trigger, 'checkpoint_met_before_batch')
    assert.equal(data(skipped).requirement_id, 'furnace_plates')
    assert.equal(data(skipped).step_id, 'step_1')
  }
})

test('a checkpoint whose exact target is not bound to this request is stale: no close, skip traced', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([GEAR])]))
  await committedStep(world, rcon, { stock: 60 })
  world.agent.liveEntityObservations = new Map() // nothing observed since the actor or request changed

  await continuation(world)

  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)
  assert.equal(world.plan().task_board.completed_count, 0)
  assert.equal(rcon.mutations.length, 2)
  assert.equal(data(world.named('plan.step_close_skipped_on_fresh_read')[0]).reason, 'checkpoint_target_stale')
})

test('an actor or epoch change during the read fails safely: nothing closes, nothing runs, the skip is traced', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([WAIT])]))
  await committedStep(world, rcon, { stock: 60 })
  rcon.changeEpochOnCondition = true

  await assert.rejects(continuation(world), /NPC actor epoch changed/)

  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)
  assert.equal(world.plan().task_board.completed_count, 0)
  assert.equal(world.plan().status, 'active')
  const [skipped] = world.named('plan.step_close_skipped_on_fresh_read')
  assert.ok(data(skipped).request_id)
  assert.equal(data(skipped).reason, 'stale_actor_or_epoch')
})

test('a prose-only step never closes here: no checkpoint, no read, no trace', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([GEAR])])
  await committedStep(world, rcon, { stock: 60, hasCheckpoint: false })
  const readsBefore = rcon.conditionReads()

  await continuation(world)

  assert.equal(rcon.conditionReads(), readsBefore)
  assert.equal(rcon.mutations.length, 2)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)
  assert.equal(world.named('plan.step_close_skipped_on_fresh_read').length, 0)
  assert.equal(world.plan().task_board.completed_count, 0)
})

test('a receipt-based contract is not machine-checkable by a fresh read: it never closes here', async () => {
  const rcon = new Rcon()
  const receipt = { mode: 'all', requirements: [{ id: 'supplied', kind: 'authoritative_operation_receipt', operation_name: 'supply_entity' }] }
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY], { checkpoint: receipt }), planMessage([GEAR])])
  await committedStep(world, rcon)
  const readsBefore = rcon.conditionReads()

  await continuation(world)

  assert.equal(rcon.conditionReads(), readsBefore)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)
  assert.equal(world.named('plan.step_close_skipped_on_fresh_read').length, 0)
  assert.equal(world.plan().task_board.completed_count, 0)
})

test('a step closes at most once: a stale second attempt and a later batch for the next step close nothing', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, firstTwo([planMessage([WAIT]), planMessage([GEAR], { currentStep: 1 })]))
  await committedStep(world, rcon, { stock: 60 })
  const staleState = structuredClone(world.plan()) // step 1 still active in this snapshot

  await continuation(world)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 1)
  assert.equal(world.plan().task_board.completed_count, 1)

  // A second evaluation holding the old snapshot reads the same met checkpoint but finds the step already closed.
  const again = await world.agent.closeActiveStepOnFreshRead({ previousState: staleState, trigger: 'checkpoint_met_before_batch', operations: [GEAR] })
  assert.equal(again.closed, false)
  assert.equal(again.reason, 'step_changed_during_read')
  assert.equal(world.plan().task_board.completed_count, 1)
  assert.equal(world.plan().task_board.active_step_id, 'step_2')
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 1)
  assert.equal(data(world.named('plan.step_close_skipped_on_fresh_read')[0]).reason, 'step_changed_during_read')

  // The current state has the next, prose-only step active: nothing to close.
  const next = await world.agent.closeActiveStepOnFreshRead({ previousState: world.plan(), trigger: 'checkpoint_met_before_batch', operations: [GEAR] })
  assert.equal(next.closed, false)
  assert.equal(world.plan().task_board.completed_count, 1)
})
