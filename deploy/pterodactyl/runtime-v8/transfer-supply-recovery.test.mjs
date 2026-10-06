import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  NpcAgentLoop,
  TRANSFER_SUPPLY_RECOVERABLE_KIND,
  TRANSFER_SUPPLY_RECOVERY_BUDGET,
  transferBatchDependency,
  transferSupplyRecoveryCount,
} from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'

// Transfer preflight facts (mod: supply_entity / move_items_exact) in the real agent loop: a proved missing supply is a
// recoverable acquisition dependency of the SAME committed step, bounded per step, while protected targets, stale actors
// and a spent budget keep their existing handling. A fake Factorio and scripted model replies; no provider is called.

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

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

function planMessage(operations, { plan = ['Load the furnace with coal'], currentStep = 0, checkpoint } = {}) {
  return { content: JSON.stringify({ chatMessage: '', plan, currentStep, operations, ...(checkpoint ? { checkpoint } : {}) }) }
}

const SUPPLY_CHECKPOINT = { mode: 'all', requirements: [{ id: 'loaded', kind: 'authoritative_operation_receipt', operation_name: 'supply_entity' }] }
const COAL_SUPPLY = { name: 'supply_entity', args: { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] } }
const GATHER_COAL = { name: 'gather_resource', args: { resource_name: 'coal', count: 10 } }

function missingCoal(overrides = {}) {
  return {
    ok: false,
    code: 'supply_missing',
    operation: 'supply_entity',
    field: 'unit_number',
    identity: 15,
    target: { unit_number: 15, name: 'stone-furnace' },
    transfer: {
      direction: 'to_entity',
      items: [{ item_name: 'coal', requested: 5, source_count: 0, destination_accepts: 1000, expected_moved: 0, missing: 5, status: 'supply_missing' }],
    },
    ...overrides,
  }
}

class Rcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.preflightCalls = []
    this.preflight = {} // operation name -> result | (args text) => result
    this.epoch = 3
    this.changeEpochOnPreflight = false
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [
        { name: 'stone-furnace', type: 'furnace', unit_number: 15, position: { x: 3, y: 0 }, distance: 3 },
        { name: 'wooden-chest', type: 'container', unit_number: 77, position: { x: 4, y: 1 }, distance: 4 },
        { name: 'assembling-machine-1', type: 'assembling-machine', unit_number: 289, position: { x: 8, y: 1 }, distance: 8 },
        { name: 'iron-chest', type: 'container', unit_number: 900, position: { x: 5, y: 2 }, distance: 5 },
      ],
    }
    this.operationStatus = { task_state: 'idle', queue_empty: true, queue_length: 0 }
    this.admissions = []
    this.batchSequence = 0
  }

  admissionJournal() {
    for (const record of this.admissions) {
      if (record.state !== 'admitted') continue
      const cancelled = this.operationStatus.last_cancelled_batch
      if (cancelled?.batch_id === record.batch_id) {
        const proven = cancelled.started_count === 1 && cancelled.failed_before_mutation === true
        Object.assign(record, proven ? { state: 'failed', ok: false, proven_refusal: true, error: 'refused_before_mutation' } : { state: 'uncertain', error: 'batch_reconciliation_required' })
      }
      else if (this.operationStatus.last_completed_batch?.batch_id === record.batch_id) record.state = 'completed'
    }
    return this.admissions
  }

  // The mod's receipt for a move that found nothing to move (basic_operation_runtime.ts state_moving_items).
  failMove(batchId, { code = 'item_missing', toEntity = true, item = 'coal', unit = 15, requested = 5 } = {}) {
    const tick = 200 + batchId
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_cancelled_batch: {
        batch_id: batchId,
        task_count: 1,
        task_types: ['moving_items'],
        tick,
        reason: `moving_items:${code}`,
        batch_generation: 1,
        batch_ref: `batch-g1-${batchId}`,
        started_count: 1,
        failed_before_mutation: true,
      },
      basic_operation: {
        last_result: {
          operation_id: batchId,
          type: 'moving_items',
          tick,
          actor_id: 18,
          accepted: false,
          completed: false,
          code,
          item_name: item,
          entity_name: 'stone-furnace',
          target_unit_number: unit,
          requested_count: requested,
          moved_count: 0,
          to_entity: toEntity,
        },
      },
    }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment(this.epoch))
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        ...this.operationStatus,
        batch_generation: 1,
        admission_journal: this.admissionJournal(),
        receipt_journal: this.operationStatus.last_cancelled_batch ? [{ ...this.operationStatus.last_cancelled_batch, state: 'cancelled' }] : [],
      })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const name = text.match(/"autorio_preflight","operation",'([a-z_]+)'/)?.[1]
      this.preflightCalls.push({ name, text })
      const entry = this.preflight[name]
      const result = typeof entry === 'function' ? entry(text) : (entry ?? { ok: true })
      if (this.changeEpochOnPreflight) this.epoch++
      return JSON.stringify(result)
    }
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

function harness(rcon, script, { memory = new CanonicalTaskBoardMemory() } = {}) {
  const calls = []
  const rows = []
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (messages, context) => {
      calls.push(messages.map(message => ({ ...message })))
      const next = script.shift()
      assert.ok(next, `unscripted provider call ${calls.length}`)
      return typeof next === 'function' ? next(messages, context) : next
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'transfer supply recovery test',
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
    harnessMessages: callIndex => calls[callIndex].map(message => String(message.content ?? '')).filter(content => content.startsWith('[HARNESS]')),
  }
}

const observe = (name = 'stone-furnace') => ({ content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name, limit: 4 })] })
const data = row => row.data ?? row

test('a transfer preceded in the same batch by an operation that could supply the item is not rejected', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [observe(), planMessage([GATHER_COAL, COAL_SUPPLY])])

  const result = await world.agent.request('load the furnace with coal', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1, 'the batch was admitted')
  assert.deepEqual(result.operations.map(operation => operation.name), ['gather_resource', 'supply_entity'])
  assert.equal(world.named('transfer.preflight_missing_supply').length, 0)
  assert.equal(world.named('transfer.supply_recovery').length, 0)
  const [deferred] = world.named('transfer.preflight_supply_deferred')
  assert.ok(deferred, 'the deferral is traced')
  assert.ok(data(deferred).request_id)
  assert.equal(data(deferred).operation_index, 1)
  assert.equal(data(deferred).code, 'supply_missing')
  assert.deepEqual(data(deferred).dependencies, [{ item_name: 'coal', status: 'supply_missing', operation_index: 0, operation: 'gather_resource' }])
  const ok = world.named('operations.preflight_ok').at(-1)
  assert.equal(data(ok).operations[1].preflight.deferred, 'batch_dependency')
  assert.equal(data(ok).operations[1].preflight.ok, true)
})

test('a craft that produces the transferred item defers a move_items_exact into a chest', async () => {
  const rcon = new Rcon()
  rcon.preflight.move_items_exact = {
    ...missingCoal(),
    operation: 'move_items_exact',
    identity: 77,
    target: { unit_number: 77, name: 'wooden-chest' },
    transfer: { direction: 'to_entity', items: [{ item_name: 'iron-gear-wheel', requested: 5, source_count: 0, destination_accepts: 32, expected_moved: 0, missing: 5, status: 'supply_missing' }] },
  }
  const world = harness(rcon, [observe('wooden-chest'), planMessage([
    { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 5 } },
    { name: 'move_items_exact', args: { item_name: 'iron-gear-wheel', unit_number: 77, max_count: 5, to_entity: true } },
  ], { plan: ['Put gears in the chest'] })])

  await world.agent.request('put five gears in the chest', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.named('transfer.preflight_supply_deferred').length, 1)
  assert.equal(world.named('transfer.preflight_missing_supply').length, 0)
})

test('the batch-dependency rule defers only for an operation that could supply the proved shortage', () => {
  const missing = missingCoal()
  const ops = names => names.map(name => ({ name, args: {} }))
  assert.equal(transferBatchDependency(ops(['walk_to_position', 'supply_entity']), 1, missing), undefined, 'a walk supplies nothing')
  assert.equal(transferBatchDependency([{ name: 'gather_resource', args: { resource_name: 'iron-ore' } }, COAL_SUPPLY], 1, missing), undefined, 'a gather of another resource does not supply coal')
  assert.equal(transferBatchDependency([{ name: 'craft_item', args: { item_name: 'iron-gear-wheel' } }, COAL_SUPPLY], 1, missing), undefined, 'a craft of another item does not supply coal')
  assert.equal(transferBatchDependency([COAL_SUPPLY, GATHER_COAL], 0, missing), undefined, 'only EARLIER operations count')
  assert.deepEqual(transferBatchDependency([GATHER_COAL, COAL_SUPPLY], 1, missing)?.[0].operation_index, 0)
  assert.ok(transferBatchDependency([{ name: 'mine_entity_exact', args: { unit_number: 9 } }, COAL_SUPPLY], 1, missing), 'a mining operation could yield the item')
  assert.ok(transferBatchDependency([{ name: 'move_items_exact', args: { item_name: 'coal', unit_number: 77, max_count: 5, to_entity: false } }, COAL_SUPPLY], 1, missing), 'an extraction of the item could supply it')
  // Every failing item needs its own supplier.
  const two = missingCoal({ transfer: { direction: 'to_entity', items: [
    { item_name: 'coal', status: 'supply_missing' },
    { item_name: 'iron-ore', status: 'supply_missing' },
  ] } })
  assert.equal(transferBatchDependency([GATHER_COAL, COAL_SUPPLY], 1, two), undefined)
  // An empty extraction is deferred by a wait, a full destination only by a same-unit extraction.
  const empty = { ...missingCoal(), code: 'extraction_empty', transfer: { direction: 'from_entity', items: [{ item_name: 'iron-plate', status: 'extraction_empty' }] } }
  assert.ok(transferBatchDependency([{ name: 'wait', args: { ticks: 600 } }, { name: 'move_items_exact', args: {} }], 1, empty))
  const full = { ...missingCoal(), code: 'destination_full', transfer: { direction: 'to_entity', items: [{ item_name: 'coal', status: 'destination_full' }] } }
  assert.equal(transferBatchDependency([GATHER_COAL, COAL_SUPPLY], 1, full), undefined)
  assert.ok(transferBatchDependency([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 15, max_count: 9, to_entity: false } }, COAL_SUPPLY], 1, full))
})

test('a proved missing supply is a recoverable dependency inside the same committed step: no freeze, no plan rewrite, no checkpoint change', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  let draft
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
    () => {
      draft = {
        state: world.plan(),
        plan: getActivePlan(world.memory.planningState(KEY)),
      }
      rcon.preflight.supply_entity = undefined // the model acquires coal; the corrected batch is admitted
      return planMessage([GATHER_COAL, COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT })
    },
  ])

  const result = await world.agent.request('load the furnace with coal', { sender: 'tester' })

  // Nothing ran for the rejected batch; the corrected one was admitted.
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /gather_resource/)
  assert.deepEqual(result.operations.map(operation => operation.name), ['gather_resource', 'supply_entity'])

  // The model got the live counts as a harness fact.
  const [message] = world.harnessMessages(2)
  assert.match(message, /^\[HARNESS\] Deterministic transfer preflight proved operation 1 \(supply_entity\) cannot move anything right now \(supply_missing/)
  assert.match(message, /not WORLD_BLOCKED/)
  assert.match(message, /Recovery 1 of 2/)
  const facts = JSON.parse(message.slice(message.indexOf('Facts from the live game: ') + 'Facts from the live game: '.length))
  assert.deepEqual(facts.items[0], { item_name: 'coal', requested: 5, source_count: 0, missing: 5, destination_accepts: 1000, status: 'supply_missing' })
  assert.deepEqual(facts.target, { unit_number: 15, name: 'stone-furnace' })

  // Same committed semantic step: the plan never froze, nothing was rewritten, and the checkpoint is the one committed.
  assert.equal(draft.state.status, 'active')
  assert.equal(draft.state.blocker, '')
  assert.equal(draft.state.task_board.status, 'active')
  assert.equal(draft.state.admission_status, 'preflight_rejected')
  const after = world.plan()
  assert.equal(after.task_board.status, 'active')
  assert.equal(after.blocker, '')
  assert.deepEqual(after.task_board.steps.map(step => step.description), draft.state.task_board.steps.map(step => step.description))
  assert.deepEqual(after.task_board.steps.map(step => step.completion_contract), draft.state.task_board.steps.map(step => step.completion_contract))
  assert.ok(after.task_board.steps[0].completion_contract, 'the committed checkpoint is still attached')
  assert.equal(getActivePlan(world.memory.planningState(KEY)).plan_id, draft.plan.plan_id, 'one plan: the draft that was rejected is the plan that committed')
  assert.equal(after.task_board.active_step_id, draft.state.task_board.active_step_id)

  // The persisted per-step counter.
  const evidence = after.task_board.evidence.filter(item => item.kind === TRANSFER_SUPPLY_RECOVERABLE_KIND)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].step_id, after.task_board.active_step_id)
  assert.equal(transferSupplyRecoveryCount(after.task_board), 1)
  assert.equal(after.task_board.evidence.some(item => item.kind === 'operation_preflight_blocker'), false)

  // Traces: request id, step id, operation index, item, counts and reason.
  const missing = world.named('transfer.preflight_missing_supply')[0]
  const recovery = world.named('transfer.supply_recovery')[0]
  for (const row of [missing, recovery]) {
    const payload = data(row)
    assert.ok(payload.request_id)
    assert.equal(payload.step_id, after.task_board.active_step_id)
    assert.equal(payload.operation_index, 0)
    assert.equal(payload.operation, 'supply_entity')
    assert.equal(payload.code, 'supply_missing')
    assert.deepEqual(payload.facts.items[0], { item_name: 'coal', requested: 5, source_count: 0, missing: 5, destination_accepts: 1000, status: 'supply_missing' })
  }
  assert.equal(data(missing).reason, 'preflight_proved_transfer_moves_nothing')
  assert.equal(data(recovery).reason, 'recoverable_acquisition_dependency_in_same_step')
  assert.equal(data(recovery).phase, 'preflight')
  assert.equal(data(recovery).attempt, 1)
  assert.equal(data(recovery).retry_budget, TRANSFER_SUPPLY_RECOVERY_BUDGET)
  assert.equal(data(recovery).plan_changed, false)
  assert.equal(world.named('transfer.supply_recovery_exhausted').length, 0)
})

test('the recovery is bounded at two per step: the third proved shortage takes the existing blocker path', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([COAL_SUPPLY]), planMessage([COAL_SUPPLY])])

  const result = await world.agent.request('load the furnace with coal', { sender: 'tester' })

  assert.equal(world.calls.length, 4, 'the model was asked twice to correct, then the third rejection blocked')
  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.blocker?.code, 'supply_missing')
  const state = world.plan()
  assert.equal(state.status, 'blocked')
  assert.equal(transferSupplyRecoveryCount(state.task_board), 2)
  const recoveries = world.named('transfer.supply_recovery')
  assert.deepEqual(recoveries.map(row => data(row).attempt), [1, 2])
  const [exhausted] = world.named('transfer.supply_recovery_exhausted')
  assert.ok(exhausted)
  assert.equal(data(exhausted).phase, 'preflight')
  assert.equal(data(exhausted).recoveries_used, 2)
  assert.equal(data(exhausted).retry_budget, 2)
  assert.equal(data(exhausted).code, 'supply_missing')
  assert.ok(data(exhausted).request_id)
  assert.equal(world.named('transfer.preflight_missing_supply').length, 3)
})

test('the per-step counter is persisted on the board: it survives a restart, and a new step starts at zero', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([GATHER_COAL, COAL_SUPPLY])])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
  const board = restored.currentPlan(KEY).task_board
  assert.equal(transferSupplyRecoveryCount(board), 1)

  // Evidence belongs to a step: another active step has its own count.
  assert.equal(transferSupplyRecoveryCount({ ...board, active_step_id: 'another_step' }), 0)
  assert.equal(transferSupplyRecoveryCount(undefined), 0)
})

test('an execution-time item_missing receipt routes to the same bounded recovery, with no human resume', async () => {
  const rcon = new Rcon()
  // The mod saw coal at preflight (another actor or a walk changed it before execution): preflight is ok.
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
    planMessage([GATHER_COAL, COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
  ])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  const before = world.plan()
  assert.equal(rcon.mutations.length, 1)

  rcon.failMove(1, { code: 'item_missing' })
  const retry = await world.agent.failed('moving_items:item_missing')

  const state = world.plan()
  assert.equal(state.status, 'active', 'the plan did not freeze')
  assert.equal(state.blocker, '')
  assert.equal(state.task_board.status, 'active')
  assert.deepEqual(state.task_board.steps.map(step => step.completion_contract), before.task_board.steps.map(step => step.completion_contract))
  assert.deepEqual(state.task_board.steps.map(step => step.description), before.task_board.steps.map(step => step.description))
  assert.equal(transferSupplyRecoveryCount(state.task_board), 1)
  assert.deepEqual(retry.operations.map(operation => operation.name), ['gather_resource', 'supply_entity'])
  assert.equal(rcon.mutations.length, 2, 'the corrected batch was admitted without a human resume')

  assert.ok(world.calls[2].some(message => String(message.content ?? '').includes('[HARNESS] The engine found nothing to move for coal (item_missing; requested 5, giving to unit 15)')), 'the model was told the live fact')
  const [row] = world.named('transfer.supply_recovery')
  assert.equal(data(row).phase, 'execution')
  assert.equal(data(row).code, 'item_missing')
  assert.equal(data(row).item_name, 'coal')
  assert.equal(data(row).requested, 5)
  assert.equal(data(row).to_entity, true)
  assert.equal(data(row).target_unit_number, 15)
  assert.equal(data(row).attempt, 1)
  assert.equal(data(row).reason, 'execution_item_missing')
  assert.ok(data(row).request_id)
  assert.equal(data(row).step_id, state.task_board.active_step_id)
})

test('an empty extraction (nothing_moved while taking) is a supply shortage; a destination refusal with the item held is not', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 15, max_count: 50, to_entity: false } }], { plan: ['Collect plates'] }),
    planMessage([{ name: 'wait', args: { ticks: 600 } }], { plan: ['Collect plates'] }),
  ])
  await world.agent.request('collect the plates from the furnace', { sender: 'tester' })

  rcon.failMove(1, { code: 'nothing_moved', toEntity: false, item: 'iron-plate', requested: 50 })
  await world.agent.failed('moving_items:nothing_moved')
  assert.equal(world.plan().status, 'active')
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)
  assert.equal(data(world.named('transfer.supply_recovery')[0]).code, 'nothing_moved')

  // A to_entity refusal (the destination would not take the held item) keeps the ordinary path.
  const refused = new Rcon()
  const other = harness(refused, [
    observe(),
    planMessage([{ name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: 15, max_count: 20, to_entity: true } }], { plan: ['Load ore'] }),
  ])
  await other.agent.request('load the furnace with ore', { sender: 'tester' })
  refused.failMove(1, { code: 'nothing_moved', toEntity: true, item: 'iron-ore', requested: 20 })
  await other.agent.failed('moving_items:nothing_moved').catch(() => undefined)
  assert.equal(transferSupplyRecoveryCount(other.plan().task_board), 0)
  assert.equal(other.plan().status, 'blocked')
  assert.equal(other.named('transfer.supply_recovery').length, 0)
})

test('execution-time shortages are bounded at two per step, then the existing transfer_failed blocker applies', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
    planMessage([COAL_SUPPLY], { checkpoint: SUPPLY_CHECKPOINT }),
  ])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })

  rcon.failMove(1)
  await world.agent.failed('moving_items:item_missing')
  assert.equal(world.plan().status, 'active')
  rcon.failMove(2)
  await world.agent.failed('moving_items:item_missing')
  assert.equal(world.plan().status, 'active')
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 2)

  rcon.failMove(3)
  await world.agent.failed('moving_items:item_missing')
  const state = world.plan()
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'transfer_failed:item_missing')
  assert.equal(transferSupplyRecoveryCount(state.task_board), 2, 'the third failure was not counted as a recovery')
  assert.deepEqual(world.named('transfer.supply_recovery').map(row => data(row).attempt), [1, 2])
  const [exhausted] = world.named('transfer.supply_recovery_exhausted')
  assert.ok(exhausted)
  assert.equal(data(exhausted).phase, 'execution')
  assert.equal(data(exhausted).blocker, 'transfer_failed:item_missing')
  assert.equal(data(exhausted).recoveries_used, 2)
})

test('a re-reported failure of the same batch is not counted as another recovery', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([COAL_SUPPLY]), planMessage([COAL_SUPPLY])])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  rcon.failMove(1)
  await world.agent.failed('moving_items:item_missing')
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)
  world.memory.recordBoardEvidence(KEY, {
    kind: 'operation_error_receipt',
    ref: 'batch-g1-1',
    summary: JSON.stringify({ outcome: 'failed', task_types: ['moving_items'], tick: 201, basic_operation: { type: 'moving_items', code: 'item_missing', completed: false, item_name: 'coal', to_entity: true, requested_count: 5, target_unit_number: 15 } }),
  })
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)
})

function emptyExtractionPreflight(rcon) {
  rcon.preflight.move_items_exact = (text) => {
    const unit = Number(text.match(/\['unit_number'\]=(\d+)/)?.[1])
    return {
      ok: false,
      code: 'extraction_empty',
      operation: 'move_items_exact',
      identity: unit,
      target: { unit_number: unit, name: 'iron-chest' },
      transfer: { direction: 'from_entity', items: [{ item_name: 'iron-plate', requested: 5, source_count: 0, destination_accepts: 100, expected_moved: 0, missing: 5, status: 'extraction_empty' }] },
    }
  }
}

test('a reserved container keeps its admission refusal and never enters supply recovery', async () => {
  const rcon = new Rcon()
  emptyExtractionPreflight(rcon)
  const world = harness(rcon, [
    observe('iron-chest'),
    planMessage([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }], { plan: ['Take the plates'] }),
    planMessage([{ name: 'wait', args: { ticks: 60 } }], { plan: ['Take the plates'] }),
  ])
  world.memory.recordReservation(KEY, { unit_number: 900, entity_name: 'iron-chest', reserved_by: 'louis' }, { now: Date.now() })

  await world.agent.request('take the plates out of the chest', { sender: 'tester' })

  assert.equal(world.named('admission.reserved_refused').length, 1)
  assert.equal(world.named('transfer.supply_recovery').length, 0)
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 0)
})

test('actor epoch replacement during preflight still cancels the stale turn: no supply recovery, no WORLD_BLOCKED', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  rcon.changeEpochOnPreflight = true
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY])])

  await assert.rejects(
    world.agent.request('load the furnace with coal', { sender: 'tester' }),
    /NPC actor epoch changed; stale model turn cancelled/,
  )

  assert.equal(rcon.mutations.length, 0)
  assert.equal(world.named('transfer.supply_recovery').length, 0)
  assert.equal(world.named('transfer.preflight_missing_supply').length, 0)
  const state = world.plan()
  assert.equal(transferSupplyRecoveryCount(state.task_board), 0)
  assert.notEqual(state.task_board.status, 'blocked')
  assert.equal(state.blocker, '')
})

test('a frozen (blocked) plan is never pulled into supply recovery', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([GATHER_COAL, COAL_SUPPLY])])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  world.agent.requestInfo = { memoryKey: KEY }
  // Simulate the plan having been frozen by a structural blocker since the draft.
  const state = world.plan()
  state.status = 'blocked'
  state.blocker = 'structural_blocker'
  const outcome = await world.agent.handleTransferSupplyPreflight(
    { preflight: { ...missingCoal(), operation_index: 0 } },
    { operations: [COAL_SUPPLY] },
    { actor_id: 18, epoch: 3 },
    undefined,
  )
  assert.equal(outcome.action, 'unhandled')
  assert.equal(world.plan().blocker, 'structural_blocker')
})

test('the budget is a monotonic board counter: more than 32 evidence items in a step cannot evict it, and a restore keeps it', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([GATHER_COAL, COAL_SUPPLY]), planMessage([COAL_SUPPLY])])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)

  // A long acquisition step: far more evidence than the board keeps. The recovery record itself is evicted ...
  for (let i = 0; i < 40; i++) world.memory.recordBoardEvidence(KEY, { kind: 'note', ref: `filler_${i}`, summary: 'acquisition progress' })
  const board = world.plan().task_board
  assert.ok(board.evidence.length <= 32)
  assert.equal(board.evidence.some(item => item.kind === TRANSFER_SUPPLY_RECOVERABLE_KIND), false, 'the evidence record was trimmed away')
  // ... but the budget was not reset.
  assert.equal(transferSupplyRecoveryCount(board), 1)

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
  assert.equal(transferSupplyRecoveryCount(restored.currentPlan(KEY).task_board), 1, 'a restore keeps the counter')

  // Execution-time shortages keep counting from the persisted value: one more recovery, then the blocker.
  const shortage = (n) => ({
    kind: 'operation_error_receipt',
    ref: `batch-g1-${n}`,
    summary: JSON.stringify({ outcome: 'failed', task_types: ['moving_items'], tick: 200 + n, basic_operation: { type: 'moving_items', code: 'item_missing', completed: false, item_name: 'coal', to_entity: true, requested_count: 5, target_unit_number: 15 } }),
  })
  world.memory.recordBoardEvidence(KEY, shortage(7))
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 2)
  assert.equal(world.plan().status, 'active')
  world.memory.recordBoardEvidence(KEY, shortage(8))
  assert.equal(world.plan().status, 'blocked')
  assert.equal(world.plan().blocker, 'transfer_failed:item_missing')
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 2)
})

test('the batch-ref de-dup is persisted on the board too, so a trimmed evidence window cannot double-count a batch', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY]), planMessage([COAL_SUPPLY])])
  await world.agent.request('load the furnace with coal', { sender: 'tester' })
  rcon.failMove(1)
  await world.agent.failed('moving_items:item_missing')
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)
  for (let i = 0; i < 40; i++) world.memory.recordBoardEvidence(KEY, { kind: 'note', ref: `filler_${i}`, summary: 'progress' })
  world.memory.recordBoardEvidence(KEY, {
    kind: 'operation_error_receipt',
    ref: 'batch-g1-1',
    summary: JSON.stringify({ outcome: 'failed', task_types: ['moving_items'], tick: 201, basic_operation: { type: 'moving_items', code: 'item_missing', completed: false, item_name: 'coal', to_entity: true, requested_count: 5, target_unit_number: 15 } }),
  })
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 1)
})

test('admission runs over operations 0..i first: a reserved container earlier in the batch refuses before any recovery budget is spent', async () => {
  const rcon = new Rcon()
  rcon.preflight.supply_entity = missingCoal()
  const world = harness(rcon, [
    observe(),
    planMessage([
      { name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } },
      COAL_SUPPLY,
    ], { plan: ['Take plates and load coal'] }),
    planMessage([{ name: 'wait', args: { ticks: 60 } }], { plan: ['Take plates and load coal'] }),
  ])
  world.memory.recordReservation(KEY, { unit_number: 900, entity_name: 'iron-chest', reserved_by: 'louis' }, { now: Date.now() })

  const result = await world.agent.request('take plates and load coal', { sender: 'tester' })

  const [refused] = world.named('admission.reserved_refused')
  assert.ok(refused, 'the earlier reserved target refused first')
  assert.equal(data(refused).unit_number, 900)
  assert.equal(world.named('transfer.supply_recovery').length, 0)
  assert.equal(world.named('transfer.preflight_missing_supply').length, 0)
  assert.equal(transferSupplyRecoveryCount(world.plan().task_board), 0, 'no recovery budget was spent')
  assert.equal(result.operations[0].name, 'wait')
})
