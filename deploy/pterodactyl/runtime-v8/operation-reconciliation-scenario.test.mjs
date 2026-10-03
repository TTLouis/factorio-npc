// MW2b scripted scenarios (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3): a delivery whose acknowledgement is lost,
// and a restart with an outstanding operation. The real NpcAgentLoop against a fake Factorio that can apply a batch and then
// drop the acknowledgement, drop the batch before it arrives, reload the mod (new batch generation) or replace the actor, with
// scripted model replies. Nothing here calls a provider.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { recoverInterruptedAgentPlan } from './supervisor.mjs'
import { FakeFactorio, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const deliver = (count = 5) => ({ name: 'move_items', args: { item_name: 'coal', entity_name: 'wooden-chest', max_count: count, to_entity: true } })

class LossyGame extends FakeFactorio {
  constructor() {
    super()
    this.generation = 1
    this.activeBatch = undefined
    this.completedBatch = undefined
    this.dropAckOnce = false
    this.dropSendOnce = false
    this.statusUnreadable = false
    this.deliveries = []
  }

  completeBatch() {
    if (this.activeBatch) this.completedBatch = { ...this.activeBatch, tick: 900 + this.activeBatch.batch_id }
    this.activeBatch = undefined
    this.taskState = 'idle'
    this.queueLength = 0
    for (const record of this.admissions) if (record.batch_id === this.completedBatch?.batch_id) record.state = 'completed'
  }

  reloadMod() {
    // A save/load: the queue and the batch records are gone, the generation moves on.
    this.generation += 1
    this.activeBatch = undefined
    this.completedBatch = undefined
    this.taskState = 'idle'
    this.queueLength = 0
    for (const record of this.admissions) if (record.state !== 'completed') record.state = 'uncertain'
  }

  async command(text) {
    if (text.includes('remote.call("autorio_operations","status")')) {
      if (this.statusUnreadable) throw new Error('RCON timed out reading status')
      return JSON.stringify({
        task_state: this.taskState,
        batch_generation: this.generation,
        queue_empty: this.queueLength === 0,
        queue_length: this.queueLength,
        active_batch: this.activeBatch,
        last_completed_batch: this.completedBatch,
        last_cancelled_batch: this.cancelledBatch,
        admission_journal: this.admissionJournal(),
        receipt_journal: this.cancelledBatch ? [{ ...this.cancelledBatch, state: 'cancelled', batch_ref: `batch-g${this.generation}-${this.cancelledBatch.batch_id}` }] : [],
        basic_operation: this.completedBatch ? { last_result: { operation_id: this.batchId, tick: this.completedBatch.tick, actor_id: this.status.actor_id, accepted: true, completed: true, code: 'completed', type: 'moving_items', moved_count: 5, to_entity: true } } : undefined,
      })
    }
    if (text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      if (this.dropSendOnce) {
        this.dropSendOnce = false
        throw new Error('RCON connection closed before the command reached the game')
      }
      const reply = await super.command(text)
      this.deliveries.push(text)
      this.activeBatch = { batch_id: this.batchId, batch_generation: this.generation, task_count: 1, task_types: ['moving_items'] }
      this.taskState = 'moving_items'
      this.queueLength = 1
      if (this.dropAckOnce) {
        this.dropAckOnce = false
        return ''
      }
      return reply
    }
    return super.command(text)
  }
}

function harness({ memory = new CanonicalTaskBoardMemory(), game = new LossyGame(), replies }) {
  const world = { game, memory, calls: [], intent: 'new_goal' }
  const rows = []
  world.jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: world.intent, confidence: 0.9 } } } : undefined)
  const queue = [...replies]
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages) => {
      world.calls.push(messages.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join(String.fromCharCode(10)))
      assert.ok(queue.length > 0, 'the scripted model ran out of replies')
      return queue.shift()
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: world.jev,
    steeringDecisionProvider: world.jev,
    systemPrompt: 'operation reconciliation scenario',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  world.agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  world.named = name => rows.filter(row => row.event === name).map(row => ({ ...(row.data ?? {}), request_id: row.data?.request_id ?? row.request_id }))
  world.say = text => world.agent.request(text, { sender: 'Louis' })
  world.pending = () => memory.pendingOperation(KEY)
  return world
}

const deliveryPlan = (count = 5) => planReply({
  plan: ['Deliver coal to the chest'],
  operations: [deliver(count)],
  checkpoint: inventoryCheckpoint('coal', count),
})

test('lost acknowledgement, effect happened: reconciled as admitted, the delivery is not sent again and the goal is not blocked', async () => {
  const world = harness({ replies: [deliveryPlan(), planReply({ chatMessage: 'The coal is in the chest.', plan: [], currentStep: 0, operations: [] })] })
  world.game.dropAckOnce = true
  const result = await world.say('deliver 5 coal to the wooden chest')

  assert.equal(world.game.deliveries.length, 1, 'the delivery reached the game exactly once')
  assert.equal(world.calls.length, 1, 'no second model turn was needed')
  assert.notEqual(result.goalStatus, 'blocked')
  assert.equal(world.memory.currentPlan(KEY).status, 'active')
  assert.equal(world.named('operations.admission_failed').length, 0, 'a lost acknowledgement is not an admission failure when the game took the batch')

  const recorded = world.named('operation.pending_recorded')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].reason, 'recorded_before_send')
  assert.deepEqual(recorded[0].effect_classes, ['delivery'])

  const reconciled = world.named('operation.reconciled')
  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0].trigger, 'lost_acknowledgement')
  assert.equal(reconciled[0].verdict, 'admitted_in_flight')
  assert.equal(reconciled[0].effect, 'in_flight')
  assert.ok(reconciled[0].request_id)
  assert.equal(world.named('operations.ack').at(-1).reconciled, true)
  assert.equal(world.pending().state, 'admitted')
  assert.equal(world.pending().batch_id, world.game.batchId)

  // The completion receipt settles it; the step then closes on the real world state (the chest holds the coal).
  world.game.completeBatch()
  world.game.inventory.coal = 5
  const done = await world.agent.completed()
  assert.equal(world.game.deliveries.length, 1, 'completing issued nothing again')
  assert.equal(world.pending(), null, 'the receipt settled the pending operation')
  assert.equal(done.goalStatus, 'completed')
})

test('missing exact admission stays uncertain even when unrelated batch watermarks suggest no delivery', async () => {
  const world = harness({ replies: [deliveryPlan()] })
  world.game.dropSendOnce = true
  await assert.rejects(world.say('deliver 5 coal to the wooden chest'))

  const reconciled = world.named('operation.reconciled')
  assert.equal(reconciled[0].verdict, 'unknown')
  assert.equal(reconciled[0].effect, 'unknown')
  assert.equal(reconciled[0].reason, 'exact_admission_missing')
  assert.equal(world.calls.length, 1)
  assert.equal(world.game.deliveries.length, 0, 'uncertainty never authorizes a replay')
  assert.equal(world.pending().state, 'unreconciled')
})

test('lost acknowledgement with an unreadable game status is never counted as success: the effect stays unknown and guards the step', async () => {
  const world = harness({ replies: [deliveryPlan()] })
  world.game.dropAckOnce = true
  // The status read fails only AFTER the batch was sent (the baseline read before the send succeeded).
  const original = world.game.command.bind(world.game)
  world.game.command = async (text) => {
    const reply = await original(text)
    if (text.includes('"authorize"')) world.game.statusUnreadable = true
    return reply
  }
  await assert.rejects(world.say('deliver 5 coal to the wooden chest'))
  const reconciled = world.named('operation.reconciled')
  assert.equal(reconciled[0].verdict, 'unknown')
  assert.equal(reconciled[0].effect, 'unknown')
  assert.equal(world.pending().state, 'unreconciled')
  assert.equal(world.pending().effect, 'unknown')
  assert.equal(world.game.deliveries.length, 1)
})

test('restart with an outstanding operation: both identical and changed deliveries are suppressed', async () => {
  const first = harness({ replies: [deliveryPlan()] })
  await first.say('deliver 5 coal to the wooden chest')
  assert.equal(first.pending().state, 'acknowledged', 'the batch was acknowledged but its receipt never arrived before the restart')
  assert.equal(first.game.deliveries.length, 1)

  // The process restarts: state is persisted, the mod reloads (new batch generation, queue and batch records gone).
  const wire = JSON.parse(JSON.stringify(first.memory.snapshot()))
  first.game.reloadMod()
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(wire)
  assert.equal(memory.pendingOperation(KEY).operation_key, first.pending().operation_key, 'the outstanding operation survives the restart')

  const second = harness({ memory, game: first.game, replies: [deliveryPlan(), deliveryPlan(3), planReply({operations:[]})] })
  await recoverInterruptedAgentPlan(second.agent, 'runtime_restart', {})

  const reconciled = second.named('operation.reconciled').filter(row => row.trigger === 'runtime_restart')
  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0].trigger, 'runtime_restart')
  assert.equal(reconciled[0].verdict, 'generation_changed')
  assert.equal(reconciled[0].effect, 'partial_unknown')
  assert.match(second.calls[0], /Operation reconciliation/)
  assert.match(second.calls[0], /UNKNOWN, not as done and not as absent/)

  // The model replays the identical delivery: refused before admission, nothing reaches the game.
  const suppressed = second.named('operation.duplicate_suppressed')
  assert.equal(suppressed.length, 2)
  assert.equal(suppressed[0].reason, 'unresolved_operation_scope_conflict')
  assert.equal(suppressed[0].effect, 'partial_unknown')
  assert.deepEqual(suppressed[0].effect_classes, ['delivery'])
  assert.match(second.calls[1], /conflicts with unresolved work/)
  assert.equal(first.game.deliveries.length, 1, 'changing the amount cannot bypass uncertainty')
  assert.equal(first.game.deliveries.filter(text => text.includes(',5,true')).length, 1)
})

test('an idle partial-cancellation receipt keeps the duplicate delivery guard across persistence', async () => {
  for (const lostAck of [false, true]) {
    const world = harness({ replies: [deliveryPlan()] })
    world.game.dropAckOnce = lostAck
    await world.say('deliver 5 coal to the wooden chest')
    const operationKey = world.pending().operation_key
    world.game.cancelledBatch = { ...world.game.activeBatch, tick: 920 }
    world.game.activeBatch = undefined
    world.game.taskState = 'idle'
    world.game.queueLength = 0
    world.game.inventory.coal = 2 // Cancellation after only part of the delivery.
    await world.agent.taskStatusReceipt()

    assert.equal(world.pending()?.operation_key, operationKey, 'an idle queue does not prove the delivery is absent or complete')
    assert.equal(world.pending().effect, 'partial_unknown')
    assert.equal(world.pending().verdict, 'admitted_cancelled')
    const receipt = world.named('operation.reconciled').findLast(row => row.trigger === 'receipt')
    assert.equal(receipt.settled, false)
    assert.equal(receipt.reason, 'exact_batch_cancelled')
    assert.ok(receipt.request_id)
    assert.equal(receipt.request_id, operationKey.split('/')[0], 'receipt stays correlated to the originating request after its turn ends')
    assert.equal(world.memory.checkDuplicateEffect(KEY, { operations: [deliver()] }, { requestId: 'req_partial_retry' }).refuse, true)
    assert.equal(world.game.deliveries.length, 1)
    assert.equal(world.calls.length, 1, 'reading a receipt wakes no model')

    const restored = new CanonicalTaskBoardMemory()
    restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
    assert.equal(restored.pendingOperation(KEY).effect, 'partial_unknown')
    assert.equal(restored.checkDuplicateEffect(KEY, { operations: [deliver()] }, { requestId: 'req_restored_retry' }).refuse, true)
  }
})

test('an acknowledged delivery keeps its guard across reload and missing exact receipts', async () => {
  for (const missingReceipt of [false, true]) {
    const world = harness({ replies: [deliveryPlan()] })
    await world.say('deliver 5 coal to the wooden chest')
    assert.equal(world.pending().state, 'acknowledged')
    if (missingReceipt) {
      world.game.completeBatch()
      world.game.admissions = []
    }
    else {
      world.game.reloadMod()
    }
    await world.agent.taskStatusReceipt()

    assert.equal(world.pending()?.effect, missingReceipt ? 'unknown' : 'partial_unknown')
    assert.equal(world.pending().verdict, missingReceipt ? 'unknown' : 'generation_changed')
    assert.equal(world.pending().state, 'unreconciled')
    const receipt = world.named('operation.reconciled').findLast(row => row.trigger === 'receipt')
    assert.equal(receipt.settled, false)
    assert.equal(receipt.reason, missingReceipt ? 'exact_admission_missing' : 'admission_generation_changed')
    assert.ok(receipt.request_id)
    assert.equal(receipt.request_id, world.pending().operation_key.split('/')[0])
    assert.equal(world.memory.checkDuplicateEffect(KEY, { operations: [deliver()] }, { requestId: 'req_reload_retry' }).refuse, true)
    assert.equal(world.game.deliveries.length, 1)
  }
})

test('an acknowledged delivery with a correlated completion receipt still settles normally', async () => {
  const world = harness({ replies: [deliveryPlan()] })
  await world.say('deliver 5 coal to the wooden chest')
  world.game.completeBatch()
  await world.agent.taskStatusReceipt()
  assert.equal(world.pending(), null)
  assert.equal(world.game.deliveries.length, 1)
  assert.equal(world.calls.length, 1)
})

test('restart after an actor replacement: the old body\'s outstanding operation is refused as stale, never counted as done', async () => {
  const first = harness({ replies: [deliveryPlan()] })
  await first.say('deliver 5 coal to the wooden chest')
  const wire = JSON.parse(JSON.stringify(first.memory.snapshot()))
  // A new body (new actor id and epoch) comes up after the restart.
  first.game.status = { ...first.game.status, actor_id: 19, epoch: 4 }
  first.game.reloadMod()
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(wire)

  const second = harness({ memory, game: first.game, replies: [deliveryPlan(2), planReply({
    chatMessage: 'BLOCKED: The old actor delivery is uncertain; confirm the affected coal and chest before retrying.',
    plan: ['Deliver coal to the chest'], operations: [],
  })] })
  await recoverInterruptedAgentPlan(second.agent, 'actor_replaced', {})

  const stale = second.named('operation.stale_refused').filter(row => row.trigger === 'actor_replaced')
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'actor_replaced')
  assert.deepEqual(stale[0].pending_actor, { actor_id: 18, epoch: 3 })
  assert.equal(second.named('operation.reconciled')[0].verdict, 'stale_actor')
  assert.equal(memory.pendingOperation(KEY).effect, 'unknown')
  assert.equal(memory.pendingOperation(KEY).state === 'unreconciled' || memory.pendingOperation(KEY).state === 'acknowledged', true)
  assert.equal(first.game.deliveries.length, 1, 'the replacement body never replays the old delivery')
})
