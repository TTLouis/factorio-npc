import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  CHECKPOINT_STOCK_EXTRACTION_CODE,
  CHECKPOINT_STOCK_REFUSAL_BUDGET,
  checkpointStockRefusalCount,
  NpcAgentLoop,
} from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { checkpointBatchContradiction } from './step-completion.mjs'

// A plan whose own actions remove the stock its checkpoint requires (live 2026-10-05: furnace 15 >= 50 iron plates,
// then the NPC collected the plates). Draft time: the contradicting draft is refused on the plan_category correction
// path and a split plan is accepted. Commit time: a later batch of the same step that would take the committed
// checkpoint's stock is refused as a recoverable preflight result, bounded per step. A fake Factorio and scripted
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

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

function planMessage(operations, { plan = ['Smelt iron plates in furnace 15'], currentStep = 0, checkpoint } = {}) {
  return { content: JSON.stringify({ chatMessage: '', plan, currentStep, operations, ...(checkpoint ? { checkpoint } : {}) }) }
}

const furnaceCheckpoint = (minimum = 50) => ({
  mode: 'all',
  requirements: [{ id: 'furnace_plates', kind: 'entity_inventory_count', unit_number: 15, item_name: 'iron-plate', minimum }],
})
const heldCheckpoint = (minimum = 50) => ({
  mode: 'all',
  requirements: [{ id: 'held_plates', kind: 'inventory_count', item_name: 'iron-plate', minimum }],
})

const COAL_SUPPLY = { name: 'supply_entity', args: { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] } }
const takePlates = (unit = 15, item = 'iron-plate') => ({ name: 'move_items_exact', args: { item_name: item, unit_number: unit, max_count: 50, to_entity: false } })
const mineFurnace = { name: 'mine_entity_exact', args: { unit_number: 15 } }

class Rcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.epoch = 3
    this.stock = { '15:iron-plate': 20 }
    this.held = { 'iron-plate': 0 }
    this.changeEpochOnCondition = false
    this.unreadable = undefined // 'garbage' | 'not_ok' | 'throw' once armed
    this.conditionCalls = 0
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [
        { name: 'stone-furnace', type: 'furnace', unit_number: 15, position: { x: 3, y: 0 }, distance: 3 },
        { name: 'wooden-chest', type: 'container', unit_number: 77, position: { x: 4, y: 1 }, distance: 4 },
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
      if (this.operationStatus.last_completed_batch?.batch_id === record.batch_id) record.state = 'completed'
    }
    return this.admissions
  }

  evaluate(text) {
    this.conditionCalls++
    if (this.changeEpochOnCondition) this.epoch++
    const request = JSON.parse(text.match(/json_to_table\('(\{.*\})'\)/)[1])
    if (request.kind === 'entity_inventory_count') {
      const current = this.stock[`${request.unit_number}:${request.item_name}`] ?? 0
      return { ok: true, kind: request.kind, unit_number: request.unit_number, item_name: request.item_name, current, minimum: request.minimum, satisfied: current >= request.minimum, progressing: false, progress_known: true }
    }
    if (request.kind === 'inventory_count') {
      const current = this.held[request.item_name] ?? 0
      return { ok: true, kind: request.kind, item_name: request.item_name, current, minimum: request.minimum, satisfied: current >= request.minimum, progress_known: false }
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
      return JSON.stringify({
        ...this.operationStatus,
        batch_generation: 1,
        admission_journal: this.admissionJournal(),
        receipt_journal: [],
      })
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
    systemPrompt: 'checkpoint contradiction test',
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
const continuation = world => world.agent.continueFromModMessage('[MOD] Autorio operation batch completed.', 'factorio.completion_continuation')

// ---------------------------------------------------------------------------------------------------------------
// The pure contradiction rule.
// ---------------------------------------------------------------------------------------------------------------

test('the contradiction rule matches only the exact unit and item, and mining the unit', () => {
  const contract = furnaceCheckpoint()
  const hit = checkpointBatchContradiction(contract, [COAL_SUPPLY, takePlates()])
  assert.equal(hit.requirement_id, 'furnace_plates')
  assert.equal(hit.unit_number, 15)
  assert.equal(hit.item_name, 'iron-plate')
  assert.equal(hit.minimum, 50)
  assert.equal(hit.operation_index, 1)
  assert.equal(hit.operation, 'move_items_exact')
  assert.equal(hit.effect, 'extracts_item')

  assert.equal(checkpointBatchContradiction(contract, [takePlates(15, 'iron-ore')]), undefined, 'a different item is not the stock')
  assert.equal(checkpointBatchContradiction(contract, [takePlates(77)]), undefined, 'a different unit is another machine')
  assert.equal(checkpointBatchContradiction(contract, [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 15, max_count: 5, to_entity: true } }]), undefined, 'loading the machine adds stock')
  assert.equal(checkpointBatchContradiction(contract, [{ name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'stone-furnace', max_count: 5, to_entity: false } }]), undefined, 'a name-based take is not an exact identity match')
  assert.equal(checkpointBatchContradiction(contract, []), undefined)

  const mined = checkpointBatchContradiction(contract, [mineFurnace])
  assert.equal(mined.effect, 'removes_entity')
  assert.equal(mined.operation_index, 0)
  assert.equal(checkpointBatchContradiction(contract, [{ name: 'mine_entity_exact', args: { unit_number: 77 } }]), undefined)

  // entity_exists / entity_state on the unit are undone by mining it, not by taking items out of it.
  const exists = { mode: 'all', requirements: [{ id: 'alive', kind: 'entity_exists', unit_number: 15 }] }
  assert.equal(checkpointBatchContradiction(exists, [mineFurnace]).effect, 'removes_entity')
  assert.equal(checkpointBatchContradiction(exists, [takePlates()]), undefined)
  const working = { mode: 'all', requirements: [{ id: 'run', kind: 'entity_state', unit_number: 15, expected: 'working' }] }
  assert.equal(checkpointBatchContradiction(working, [mineFurnace]).requirement_id, 'run')

  // A held-inventory contract is never contradicted by a collection.
  assert.equal(checkpointBatchContradiction(heldCheckpoint(), [takePlates()]), undefined)
})

test('an any-contract is contradicted only when every requirement is undone', () => {
  const both = {
    mode: 'any',
    requirements: [
      { id: 'furnace_plates', kind: 'entity_inventory_count', unit_number: 15, item_name: 'iron-plate', minimum: 50 },
      { id: 'held_plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 50 },
    ],
  }
  assert.equal(checkpointBatchContradiction(both, [takePlates()]), undefined, 'the held branch can still be met')
  const twoMachines = {
    mode: 'any',
    requirements: [
      { id: 'a', kind: 'entity_inventory_count', unit_number: 15, item_name: 'iron-plate', minimum: 50 },
      { id: 'b', kind: 'entity_inventory_count', unit_number: 77, item_name: 'iron-plate', minimum: 50 },
    ],
  }
  assert.equal(checkpointBatchContradiction(twoMachines, [takePlates(15)]), undefined)
  assert.ok(checkpointBatchContradiction(twoMachines, [takePlates(15), takePlates(77)]))
  assert.equal(checkpointBatchContradiction({ ...twoMachines, mode: 'all' }, [takePlates(15)]).requirement_id, 'a', 'an all-contract dies with one requirement')
})

// ---------------------------------------------------------------------------------------------------------------
// Draft time.
// ---------------------------------------------------------------------------------------------------------------

test('the live shape: a draft whose batch extracts the checkpoint stock is refused before admission, then the split plan is accepted', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([takePlates()], { plan: ['Collect 50 iron plates from furnace 15'], checkpoint: furnaceCheckpoint() }),
    planMessage([COAL_SUPPLY], { plan: ['Smelt iron plates until furnace 15 holds 50', 'Collect the plates'], checkpoint: furnaceCheckpoint() }),
  ])

  const result = await world.agent.request('get fifty iron plates', { sender: 'tester' })

  // Nothing of the contradicting batch reached the world; the accepted split step did.
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /supply_entity/)
  assert.doesNotMatch(rcon.mutations[0], /move_items_exact/)
  assert.deepEqual(result.operations.map(operation => operation.name), ['supply_entity'])

  // The planner was told the exact contradiction on the plan_category correction path.
  const [message] = world.harnessMessages(2)
  assert.match(message, /^\[HARNESS\] Plan\/tool category or targeting error \(1\/\d+; invalid_semantic_checkpoint\)/)
  assert.match(message, /checkpoint_contradicts_batch/)
  assert.match(message, /requirement=furnace_plates/)
  assert.match(message, /operation 1 \(move_items_exact\) takes iron-plate out of unit 15/)

  // The trace carries the request, step, requirement, unit, item, operation index and reason.
  const [row] = world.named('checkpoint.contradicts_batch')
  assert.ok(row)
  const payload = data(row)
  assert.ok(payload.request_id)
  // A first draft has no step on the board yet, so step_id is only present when a plan already exists.
  assert.equal(payload.reason, 'checkpoint_contradicts_batch')
  assert.equal(payload.requirement_id, 'furnace_plates')
  assert.equal(payload.unit_number, 15)
  assert.equal(payload.item_name, 'iron-plate')
  assert.equal(payload.minimum, 50)
  assert.equal(payload.operation_index, 0)
  assert.equal(payload.operation, 'move_items_exact')
  assert.equal(payload.effect, 'extracts_item')
  assert.equal(world.named('checkpoint.contradicts_batch').length, 1)

  // The rejected checkpoint never reached the board; the redraft's did.
  const state = world.plan()
  assert.equal(state.status, 'active')
  assert.equal(state.blocker, '')
  assert.deepEqual(state.task_board.steps[0].completion_contract.requirements[0].minimum, 50)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  assert.equal(checkpointStockRefusalCount(state.task_board), 0)
})

test('extracting a different item from the unit, or the same item from another unit, is not a contradiction', async () => {
  for (const batch of [[takePlates(15, 'iron-ore')], [takePlates(77)]]) {
    const rcon = new Rcon()
    const world = harness(rcon, [
      observe(),
      planMessage(batch, { plan: ['Move things around'], checkpoint: furnaceCheckpoint() }),
    ])
    await world.agent.request('move things', { sender: 'tester' })
    assert.equal(rcon.mutations.length, 1, 'the batch was admitted')
    assert.equal(world.named('checkpoint.contradicts_batch').length, 0)
    assert.equal(world.calls.length, 2, 'no correction round')
  }
})

test('mining the checkpoint entity is refused at draft time', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([mineFurnace], { plan: ['Pick up furnace 15'], checkpoint: furnaceCheckpoint() }),
    planMessage([COAL_SUPPLY], { plan: ['Smelt iron plates in furnace 15'], checkpoint: furnaceCheckpoint() }),
  ])

  await world.agent.request('smelt plates', { sender: 'tester' })

  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /mine_entity_exact/)
  const [row] = world.named('checkpoint.contradicts_batch')
  assert.equal(data(row).effect, 'removes_entity')
  assert.equal(data(row).operation, 'mine_entity_exact')
  assert.equal(data(row).requirement_id, 'furnace_plates')
  assert.match(world.harnessMessages(2)[0], /operation 1 \(mine_entity_exact\) mines unit 15/)
})

test('persistPlannerCheckpoint rejects a contradicting draft with the model-correctable plan_category error', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [observe(), planMessage([COAL_SUPPLY], { checkpoint: furnaceCheckpoint() })])
  // A request whose plan stays a draft: build the live draft state directly (no commit).
  await world.agent.request('smelt plates', { sender: 'tester' })
  // Rebuild a draft (uncommitted) state the way agentWithState does in the completion tests.
  const fresh = new CanonicalTaskBoardMemory()
  const state = JSON.parse(JSON.stringify(world.plan()))
  state.task_board.steps[0].completion_contract = undefined
  fresh.planByNpc.set(KEY, state)
  fresh.ensurePlanningDraft(KEY, state, { now: 100, migrated: true })
  const draftAgent = new NpcAgentLoop({
    rcon,
    memory: fresh,
    npcId: 'sgluna',
    systemPrompt: 'draft',
    provider: async () => { throw new Error('planner not expected') },
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  const rows = []
  draftAgent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  draftAgent.active = true
  draftAgent.epoch = deployment()
  draftAgent.lastMemoryKey = KEY
  draftAgent.requestInfo = { memoryKey: KEY, turnId: 1, sender: 'tester', text: 'smelt plates' }
  draftAgent.recordLiveEntityObservation(rcon.nearby.entities[0], rcon.nearby.actor_position, 'getNearbyEntities')

  assert.equal(getActivePlan(fresh.planningState(KEY)).status, PLAN_STATUS.DRAFT)
  await assert.rejects(
    draftAgent.persistPlannerCheckpoint({ checkpoint: furnaceCheckpoint(), operations: [takePlates()] }),
    (error) => {
      assert.equal(error.failureClass, 'plan_category')
      assert.equal(error.code, 'invalid_semantic_checkpoint')
      assert.equal(error.details.reason, 'checkpoint_contradicts_batch')
      assert.equal(error.details.requirement_id, 'furnace_plates')
      assert.equal(error.details.operation_index, 0)
      assert.match(error.message, /deterministic_checkpoint_rejected: checkpoint_contradicts_batch/)
      return true
    },
  )
  assert.equal(fresh.currentPlan(KEY).task_board.steps[0].completion_contract, undefined, 'nothing persisted')
  assert.equal(rows.filter(row => row.event === 'checkpoint.contradicts_batch').length, 1)

  // The split draft (the same checkpoint with a batch that does not undo it) is accepted and persisted.
  const accepted = await draftAgent.persistPlannerCheckpoint({ checkpoint: furnaceCheckpoint(), operations: [COAL_SUPPLY] })
  assert.equal(accepted.contract.requirements[0].unit_number, 15)
  assert.ok(fresh.currentPlan(KEY).task_board.steps[0].completion_contract)
})

// This proves the completion evaluator: a step that carries a furnace-stock contract closes when the furnace count is
// reached, and a step that carries a held-inventory contract closes when the held count is reached. It does not claim
// a pending collect step gets that contract after commit (it cannot). In the live flow a pending collect step without
// a checkpoint closes by the Main LLM's semantic completion claim, or gets its contract from its own draft/slice.
test('the evaluator closes a step that carries a furnace-stock contract and a step that carries a held-inventory contract, each from its own count', async () => {
  const rcon = new Rcon()
  const memory = new CanonicalTaskBoardMemory()
  const now = Date.now()
  const state = {
    goal_id: 'goal_split',
    owner: 'tester',
    objective: 'get fifty iron plates',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Smelt iron plates until furnace 15 holds 50', 'Collect the plates'],
    current_step: 0,
    revision: 2,
    last_chat_message: '',
    last_operations: [],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 7,
    updated_at: now,
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_split',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 2,
      event_sequence: 0,
      evidence_sequence: 1,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'Smelt iron plates until furnace 15 holds 50', status: 'active', completion_contract: furnaceCheckpoint() },
        { id: 'step_2', description: 'Collect the plates', status: 'pending', completion_contract: heldCheckpoint() },
      ],
      evidence: [{
        id: 'evidence_1',
        kind: 'deterministic_verification',
        ref: 'batch_7',
        summary: JSON.stringify({ verdict: 'operation_completed_but_semantic_step_not_yet_verified', operations: ['supply_entity'] }),
        step_id: 'step_1',
        at: now,
      }],
      events: [],
    },
  }
  memory.planByNpc.set(KEY, state)
  memory.ensurePlanningDraft(KEY, state, { now: 100, migrated: true })
  memory.commitPlanningPlan(KEY, { now: 110, migrated: true, runtime_validation: { passed: true } })
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    npcId: 'sgluna',
    systemPrompt: 'closure',
    provider: async () => { throw new Error('planner not expected') },
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async () => {} }
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = KEY
  agent.requestInfo = { memoryKey: KEY, turnId: 1, sender: 'tester', text: 'continue' }
  agent.recordLiveEntityObservation(rcon.nearby.entities[0], rcon.nearby.actor_position, 'getNearbyEntities')
  const receipt = batchId => ({ view: { last_completed_batch: { batch_id: batchId } } })

  // The furnace holds 20: the smelt step stays open.
  const open = await agent.routeStepCompletionDecision(receipt(7))
  assert.equal(open.verified, false)
  assert.equal(open.reason, 'checkpoint_requirements_unsatisfied')
  assert.equal(memory.currentPlan(KEY).task_board.active_step_id, 'step_1')

  // It reaches 50: the smelt step closes, from the furnace count and nothing else.
  rcon.stock['15:iron-plate'] = 50
  const smelted = await agent.routeStepCompletionDecision(receipt(7))
  assert.equal(smelted.verified, true)
  assert.equal(memory.currentPlan(KEY).task_board.active_step_id, 'step_2')

  // The collect step closes on the held count, not on the furnace.
  memory.recordBoardEvidence(KEY, { kind: 'deterministic_verification', ref: 'batch_8', summary: JSON.stringify({ verdict: 'operation_completed_but_semantic_step_not_yet_verified', operations: ['move_items_exact'] }) })
  rcon.stock['15:iron-plate'] = 0
  const notYet = await agent.routeStepCompletionDecision(receipt(8))
  assert.equal(notYet.verified, false)
  rcon.held['iron-plate'] = 50
  const collected = await agent.routeStepCompletionDecision(receipt(8))
  assert.equal(collected.verified, true)
})

// ---------------------------------------------------------------------------------------------------------------
// Commit time.
// ---------------------------------------------------------------------------------------------------------------

async function committedStep(world, rcon, { stock = 20 } = {}) {
  rcon.stock['15:iron-plate'] = stock
  await world.agent.request('get fifty iron plates', { sender: 'tester' })
  assert.equal(rcon.mutations.length, 1, 'the smelt batch was admitted')
  // The first batch finished, so no unresolved work fences the next one.
  rcon.operationStatus = { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1', task_count: 1, task_types: ['moving_items'], tick: 300 } }
  const planning = getActivePlan(world.memory.planningState(KEY))
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(planning.status), `committed (was ${planning.status})`)
  return { committed: world.plan(), planId: planning.plan_id }
}

const SMELT = { plan: ['Smelt iron plates until furnace 15 holds 50'] }

test('commit time: a later batch that would take the committed checkpoint stock is refused recoverably, with no freeze and no rewrite', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    // The model also tries to dodge the committed contract by re-stating it with a lower minimum.
    planMessage([takePlates()], { ...SMELT, checkpoint: furnaceCheckpoint(40) }),
    planMessage([{ name: 'wait', args: { ticks: 600 } }], SMELT),
  ])
  const { committed, planId } = await committedStep(world, rcon)
  const committedContract = committed.task_board.steps[0].completion_contract

  await continuation(world)

  // Nothing of the refused batch ran (the follow-up wait did).
  assert.equal(rcon.mutations.length, 2)
  assert.doesNotMatch(rcon.mutations.join('\n'), /move_items_exact/)

  // The committed contract and the plan are untouched; the ignored change is the existing behaviour.
  const after = world.plan()
  assert.equal(after.status, 'active')
  assert.equal(after.blocker, '')
  assert.equal(after.task_board.status, 'active')
  assert.deepEqual(after.task_board.steps[0].completion_contract, committedContract)
  assert.deepEqual(after.task_board.steps.map(step => step.description), committed.task_board.steps.map(step => step.description))
  assert.equal(getActivePlan(world.memory.planningState(KEY)).plan_id, planId)
  assert.equal(world.named('step.checkpoint_change_ignored').length, 1)
  assert.equal(data(world.named('step.checkpoint_change_ignored')[0]).reason, 'committed_completion_contract_is_immutable')

  // The model got the committed requirement, the live count and the conflicting operation.
  const messages = world.harnessMessages(3).filter(message => message.includes('Deterministic checkpoint guard refused'))
  assert.equal(messages.length, 1)
  const [message] = messages
  assert.match(message, /operation 1 \(move_items_exact\)/)
  assert.match(message, /not WORLD_BLOCKED/)
  assert.match(message, /Refusal 1 of 2/)
  assert.match(message, /requirement furnace_plates \(entity_inventory_count\) needs unit 15 to hold at least 50 iron-plate/)
  assert.match(message, /The latest live read shows 20\./)
  const facts = JSON.parse(message.slice(message.indexOf('Facts: ') + 'Facts: '.length))
  assert.deepEqual(facts, {
    requirement_id: 'furnace_plates',
    requirement_kind: 'entity_inventory_count',
    unit_number: 15,
    item_name: 'iron-plate',
    minimum: 50,
    current: 20,
    operation_index: 0,
    operation: 'move_items_exact',
    effect: 'extracts_item',
  })

  // Traces and the persisted per-step counter.
  const [refused] = world.named('checkpoint.stock_extraction_refused')
  const payload = data(refused)
  assert.ok(payload.request_id)
  assert.equal(payload.step_id, after.task_board.active_step_id)
  assert.equal(payload.requirement_id, 'furnace_plates')
  assert.equal(payload.unit_number, 15)
  assert.equal(payload.item_name, 'iron-plate')
  assert.equal(payload.operation_index, 0)
  assert.equal(payload.reason, 'committed_checkpoint_stock_would_be_removed')
  assert.equal(payload.attempt, 1)
  assert.equal(payload.retry_budget, CHECKPOINT_STOCK_REFUSAL_BUDGET)
  assert.equal(payload.plan_changed, false)
  assert.equal(payload.checkpoint_changed, false)
  assert.equal(checkpointStockRefusalCount(after.task_board), 1)
  assert.equal(world.named('checkpoint.stock_extraction_exhausted').length, 0)
  const recoverable = after.task_board.evidence.filter(item => item.kind === 'operation_preflight_recoverable' && item.summary.includes(CHECKPOINT_STOCK_EXTRACTION_CODE))
  assert.equal(recoverable.length, 1)
})

test('commit time: the refusal is bounded at two per step, then the existing blocker path applies', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates()], SMELT),
    planMessage([takePlates()], SMELT),
    planMessage([takePlates()], SMELT),
  ])
  await committedStep(world, rcon)

  const result = await continuation(world)

  assert.equal(rcon.mutations.length, 1, 'no extraction was ever admitted')
  assert.equal(result.operations.length, 0)
  assert.equal(result.blocker?.code, CHECKPOINT_STOCK_EXTRACTION_CODE)
  const state = world.plan()
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, `operation_preflight_failed:${CHECKPOINT_STOCK_EXTRACTION_CODE}`)
  assert.equal(checkpointStockRefusalCount(state.task_board), 2, 'the third refusal was not counted')
  assert.deepEqual(world.named('checkpoint.stock_extraction_refused').map(row => data(row).attempt), [1, 2])
  const [exhausted] = world.named('checkpoint.stock_extraction_exhausted')
  assert.ok(exhausted)
  assert.ok(data(exhausted).request_id)
  assert.equal(data(exhausted).refusals_used, 2)
  assert.equal(data(exhausted).retry_budget, 2)
  assert.equal(data(exhausted).requirement_id, 'furnace_plates')
  assert.equal(data(exhausted).operation_index, 0)
  assert.equal(state.task_board.steps[0].completion_contract.requirements[0].minimum, 50, 'the committed checkpoint is unchanged by the refusals')
})

test('commit time: the counter is persisted on the board and survives a restore; another step starts at zero', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates()], SMELT),
    planMessage([{ name: 'wait', args: { ticks: 600 } }], SMELT),
  ])
  await committedStep(world, rcon)
  await continuation(world)
  assert.equal(checkpointStockRefusalCount(world.plan().task_board), 1)

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
  const board = restored.currentPlan(KEY).task_board
  assert.equal(checkpointStockRefusalCount(board), 1)
  assert.equal(checkpointStockRefusalCount({ ...board, active_step_id: 'another_step' }), 0)
  assert.equal(checkpointStockRefusalCount(undefined), 0)

  // More evidence than the board keeps cannot evict the counter.
  for (let i = 0; i < 40; i++) world.memory.recordBoardEvidence(KEY, { kind: 'note', ref: `filler_${i}`, summary: 'progress' })
  assert.equal(checkpointStockRefusalCount(world.plan().task_board), 1)
})

test('commit time: an already satisfied checkpoint is never refused; the step closes on a fresh read before the extraction can empty it', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates()], SMELT),
  ])
  await committedStep(world, rcon, { stock: 60 })
  await world.agent.taskStatusReceipt()

  await continuation(world)

  // Unit C never refuses a met checkpoint, and unit G closes the step before the batch (it was the final step, so the
  // plan completes) instead of letting the extraction empty the stock of an open step.
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  assert.equal(rcon.mutations.length, 1, 'the extraction was not admitted')
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 1)
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, PLAN_STATUS.COMPLETED)
})

test('commit time: another item or another unit is unaffected, mining the checkpoint entity is refused', async () => {
  for (const [batch, refused] of [[[takePlates(15, 'iron-ore')], false], [[takePlates(77)], false], [[mineFurnace], true]]) {
    const rcon = new Rcon()
    const world = harness(rcon, [
      observe(),
      planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
      planMessage(batch, SMELT),
      planMessage([{ name: 'wait', args: { ticks: 600 } }], SMELT),
    ])
    await committedStep(world, rcon)
    await continuation(world)
    assert.equal(world.named('checkpoint.stock_extraction_refused').length, refused ? 1 : 0, JSON.stringify(batch))
    assert.equal(rcon.mutations.length, 2)
    assert.equal(/move_items_exact|mine_entity_exact/.test(rcon.mutations[1]), !refused, 'the refused batch never reached the world')
    if (refused) assert.equal(data(world.named('checkpoint.stock_extraction_refused')[0]).effect, 'removes_entity')
  }
})

test('commit time: a reserved target earlier in the batch refuses first and spends no checkpoint budget', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates(900), takePlates(15)], SMELT),
    planMessage([{ name: 'wait', args: { ticks: 60 } }], SMELT),
  ])
  world.memory.recordReservation(KEY, { unit_number: 900, entity_name: 'iron-chest', reserved_by: 'louis' }, { now: Date.now() })
  await committedStep(world, rcon)

  await continuation(world)

  const [reserved] = world.named('admission.reserved_refused')
  assert.ok(reserved, 'admission refused the reserved container first')
  assert.equal(data(reserved).unit_number, 900)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  assert.equal(checkpointStockRefusalCount(world.plan().task_board), 0)
})

test('commit time: an actor epoch change fails safely before any refusal is recorded', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates()], SMELT),
  ])
  await committedStep(world, rcon)
  rcon.changeEpochOnCondition = true

  await assert.rejects(continuation(world), /NPC actor epoch changed/)

  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  const state = world.plan()
  assert.equal(checkpointStockRefusalCount(state.task_board), 0)
  assert.notEqual(state.task_board.status, 'blocked')
  assert.equal(state.blocker, '')
})

test('the immutable committed contract still ignores a changed checkpoint when nothing conflicts', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates(15, 'iron-ore')], { ...SMELT, checkpoint: furnaceCheckpoint(10) }),
  ])
  const { committed } = await committedStep(world, rcon)

  await continuation(world)

  assert.equal(world.named('step.checkpoint_change_ignored').length, 1)
  assert.deepEqual(world.plan().task_board.steps[0].completion_contract, committed.task_board.steps[0].completion_contract)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
  assert.equal(world.named('checkpoint.contradicts_batch').length, 0)
})

test('commit time: an unreadable checkpoint stock fails open: the batch proceeds, no budget is spent, the gap is traced', async () => {
  for (const mode of ['throw', 'garbage', 'not_ok']) {
    const rcon = new Rcon()
    const world = harness(rcon, [
      observe(),
      planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
      planMessage([takePlates()], SMELT),
    ])
    // Already met, but the read fails: a refusal here would block a legitimate extraction and burn budget.
    await committedStep(world, rcon, { stock: 60 })
    rcon.unreadable = mode

    await continuation(world)

    assert.equal(rcon.mutations.length, 2, `${mode}: the extraction was admitted`)
    assert.match(rcon.mutations[1], /move_items_exact/)
    assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
    assert.equal(checkpointStockRefusalCount(world.plan().task_board), 0, `${mode}: no budget spent`)
    const [row] = world.named('checkpoint.stock_extraction_unverified')
    assert.ok(row, `${mode}: traced`)
    const payload = data(row)
    assert.ok(payload.request_id)
    assert.equal(payload.step_id, world.plan().task_board.active_step_id)
    assert.equal(payload.requirement_id, 'furnace_plates')
    assert.equal(payload.unit_number, 15)
    assert.equal(payload.item_name, 'iron-plate')
    assert.equal(payload.operation_index, 0)
    assert.equal(payload.reason, 'checkpoint_stock_unreadable_batch_not_refused')
    assert.equal(world.plan().status, 'active')
  }
})

test('commit time: a stale actor epoch during an unreadable read still throws instead of failing open', async () => {
  const rcon = new Rcon()
  const world = harness(rcon, [
    observe(),
    planMessage([COAL_SUPPLY], { ...SMELT, checkpoint: furnaceCheckpoint() }),
    planMessage([takePlates()], SMELT),
  ])
  await committedStep(world, rcon)
  rcon.unreadable = 'not_ok'
  rcon.changeEpochOnCondition = false
  const original = rcon.command.bind(rcon)
  rcon.command = async (text) => {
    const answer = await original(text)
    if (text.includes('"evaluate_condition"')) rcon.epoch++
    return answer
  }

  await assert.rejects(continuation(world), /NPC actor epoch changed/)
  assert.equal(rcon.mutations.length, 1)
  assert.equal(world.named('checkpoint.stock_extraction_unverified').length, 0)
  assert.equal(world.named('checkpoint.stock_extraction_refused').length, 0)
})
