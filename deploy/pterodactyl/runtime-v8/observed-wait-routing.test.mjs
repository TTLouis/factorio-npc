import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, PASSIVE_ROUTE_MIN_WAIT_TICKS } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

// Repair unit B (docs/validation/LUNA_AUTONOMY_FAILURE_ANALYSIS_2026-10-05.md section 3). A batch of only `wait`
// operations on a machine-output checkpoint is routed to the bounded condition wait (no timer); a blind wait's
// receipt carries a fresh machine read; waiting alone never closes a step. Fake Factorio, no provider.

const KEY = 'npc:sgluna'
const FURNACE = 582
const CHECKPOINT = {
  mode: 'all',
  requirements: [{ id: 'plates', kind: 'entity_inventory_count', unit_number: FURNACE, item_name: 'iron-plate', minimum: 50 }],
}

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

function planState(goalId = 'goal_wait') {
  return {
    goal_id: goalId,
    owner: 'tester',
    objective: 'collect fifty iron plates from the furnace',
    status: 'active',
    admission_status: undefined,
    blocker: '',
    pause_reason: '',
    persistent_runtime: undefined,
    condition_wait: undefined,
    plan: ['Smelt fifty iron plates', 'Craft the requested item'],
    current_step: 0,
    revision: 1,
    last_chat_message: '',
    last_operations: [],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 8,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: goalId,
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 1,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'Smelt fifty iron plates', status: 'active', completion_contract: structuredClone(CHECKPOINT) },
        { id: 'step_2', description: 'Craft the requested item', status: 'pending' },
      ],
      evidence: [],
      events: [],
    },
  }
}

class WaitRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.actorEpoch = 3
    this.bumpEpochOnCondition = false
    // The furnace as the engine answers: working, 47 of 50 plates, fuel and ore loaded.
    this.machine = { working: true, current: 47, minimum: 50, limitedBy: undefined, fuel: [{ name: 'coal', quality: 'normal', count: 4 }], input: [{ name: 'iron-ore', quality: 'normal', count: 2 }], output: [{ name: 'iron-plate', quality: 'normal', count: 47 }] }
    this.nearestUnit = FURNACE
    this.operationStatus = { task_state: 'idle', queue_empty: true, queue_length: 0 }
    this.batchSequence = 0
    this.admissions = []
  }

  conditionAnswer(text) {
    const m = this.machine
    if (text.includes('entity_inventory_count')) {
      return {
        ok: true,
        kind: 'entity_inventory_count',
        satisfied: m.current >= m.minimum,
        current: m.current,
        minimum: m.minimum,
        unit_number: FURNACE,
        progressing: m.working,
        progress_known: true,
        entity_status: m.working ? 1 : 28,
        ...(m.current >= m.minimum ? {} : { eta: { recipe: 'iron-plate', seconds_per_craft: 3.2, crafts_needed: m.minimum - m.current, seconds_to_target: 9.6, seconds_until_idle: 12.5, ...(m.limitedBy ? { limited_by: m.limitedBy } : {}), basis: 'x' } }),
      }
    }
    return {
      ok: true,
      kind: 'entity_state',
      satisfied: m.working,
      unit_number: FURNACE,
      progressing: m.working,
      progress_known: true,
      entity_status: m.working ? 1 : 28,
      ...(m.working ? { eta: { recipe: 'iron-plate', seconds_per_craft: 3.2, seconds_until_idle: 12.5 } } : {}),
    }
  }

  admissionJournal() {
    for (const record of this.admissions) {
      if (record.state === 'admitted' && this.operationStatus.last_completed_batch?.batch_id === record.batch_id) record.state = 'completed'
    }
    return this.admissions
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment(this.actorEpoch))
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ ...this.operationStatus, batch_generation: 1, admission_journal: this.admissionJournal(), receipt_journal: [] })
    }
    if (text.includes('remote.call("autorio_tools","evaluate_condition"')) {
      if (this.bumpEpochOnCondition) this.actorEpoch++
      return JSON.stringify(this.conditionAnswer(text))
    }
    if (text.includes('remote.call("autorio_tools","get_entity_status"')) {
      const m = this.machine
      return JSON.stringify({
        found: true,
        actor_position: { x: 0, y: 0 },
        radius: 32,
        entity: {
          name: 'stone-furnace',
          type: 'furnace',
          position: { x: 4, y: 0 },
          force: 'player',
          unit_number: this.nearestUnit,
          direction: 0,
          supports_direction: false,
          rotatable: false,
          status: m.working ? 1 : 28,
          working: m.working,
          inventories: [
            { index: 1, items: m.fuel },
            { index: 2, items: m.input },
            { index: 3, items: m.output },
            { index: 4, items: [] },
            { index: 6, items: [] },
          ],
          inventories_truncated: false,
          inventory_items_truncated: false,
        },
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

  // The receipt the mod publishes once the queued batch finished.
  completeBatch(taskTypes) {
    const batchId = this.batchSequence
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_completed_batch: { batch_id: batchId, task_count: taskTypes.length, task_types: taskTypes, tick: 1000 + batchId, batch_generation: 1, batch_ref: `batch-g1-${batchId}` },
    }
  }
}

function makeWorld({ committed = false, draft = false, script = [], rcon = new WaitRcon(), memory = new CanonicalTaskBoardMemory() } = {}) {
  memory.planByNpc.set(KEY, planState())
  if (draft || committed) memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 1 })
  if (committed) memory.commitPlanningPlan(KEY, { now: 2, runtime_validation: { passed: true } })
  const calls = []
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    npcId: 'sgluna',
    systemPrompt: 'observed wait routing test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const next = script.shift()
      assert.ok(next, `unscripted provider call ${calls.length}`)
      return typeof next === 'function' ? next(messages) : next
    },
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = KEY
  agent.requestInfo = { memoryKey: KEY, turnId: 1, sender: 'tester', text: 'collect fifty iron plates from the furnace' }
  agent.traceRequest = { id: 'req_wait_1', seq: 0 }
  agent.baseMessages = [{ role: 'system', content: agent.systemPrompt }]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  const events = []
  const writeTrace = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data, options) => {
    events.push({ event, data })
    return writeTrace(event, data, options)
  }
  const named = name => events.filter(entry => entry.event === name).map(entry => entry.data)
  return { agent, memory, rcon, calls, events, named, plan: () => memory.planByNpc.get(KEY) }
}

const waitReply = (ticks = 600, extra = {}) => ({
  chatMessage: 'Waiting for the furnace to finish.',
  plan: ['Smelt fifty iron plates', 'Craft the requested item'],
  currentStep: 0,
  operations: [{ name: 'wait', args: { ticks } }],
  ...extra,
})

function observeFurnace(agent, { working = true } = {}) {
  agent.recordLiveEntityObservation({
    name: 'stone-furnace',
    type: 'furnace',
    unit_number: FURNACE,
    position: { x: 4, y: 0 },
    working,
    status: working ? 1 : 28,
    inventories: [{ index: 3, items: [{ name: 'iron-plate', quality: 'normal', count: 47 }] }],
  }, { x: 0, y: 0 }, 'getEntityStatus')
}

// The model's answer to a wake: it acts (a craft), so the request ends cleanly.
const sleepingModel = () => ({ content: JSON.stringify({ chatMessage: '', plan: ['Smelt fifty iron plates', 'Craft the requested item'], currentStep: 0, operations: [{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }] }) })

test('a wait-only batch on a machine-output checkpoint routes to the condition wait and no timer runs', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)

  const result = await world.agent.commitPlan(waitReply(600))

  assert.equal(world.rcon.mutations.length, 0, 'no wait batch was admitted: the timer never ran')
  assert.deepEqual(result.operations, [])
  assert.equal(result.goalStatus, 'active')
  const wait = world.plan().condition_wait
  assert.equal(wait?.state, 'active')
  assert.equal(wait.mode, 'completion')
  assert.deepEqual(wait.condition, { kind: 'entity_inventory_count', unit_number: FURNACE, item_name: 'iron-plate', minimum: 50 })
  // Same fences as the zero-operation registration.
  assert.equal(wait.actor_id, 18)
  assert.equal(wait.actor_epoch, 3)
  assert.equal(wait.step_id, 'step_1')
  assert.equal(wait.goal_id, 'goal_wait')
  assert.equal(world.named('runtime.condition_registered').length, 1)
  assert.equal(world.plan().task_board.completed_count, 0, 'waiting is not production')

  const [routed] = world.named('wait.routed_to_condition')
  assert.equal(routed.request_id, 'req_wait_1')
  assert.equal(routed.step_id, 'step_1')
  assert.equal(routed.wait_id, wait.id)
  assert.equal(routed.unit_number, FURNACE)
  assert.equal(routed.reason, 'checkpoint_machine_working')
  assert.equal(routed.requested_ticks, 600)
  assert.equal(routed.machine.working, true)
  assert.deepEqual(routed.machine.checkpoint, { item_name: 'iron-plate', minimum: 50, current: 47, satisfied: false })
  assert.equal(world.named('wait.blind_with_fresh_read').length, 0)
  assert.equal(world.named('request.completed').at(-1).outcome, 'condition_wait_active')
  assert.equal(world.agent.pendingBlindWait ?? null, null)
})

test('the routed reply stays in the conversation as the model wrote it', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply(600))
  const assistant = world.agent.messages.filter(message => message.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(JSON.parse(assistant[0].content).operations[0].name, 'wait')
})

test('a stale cached working flag is replaced by one fresh read before the decision', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent, { working: false })
  assert.equal(world.agent.liveObservedExactTarget(FURNACE).working, false)

  await world.agent.commitPlan(waitReply())

  assert.equal(world.rcon.mutations.length, 0)
  assert.equal(world.plan().condition_wait?.state, 'active', 'the machine is working now, so the wait is routed')
  assert.equal(world.agent.liveObservedExactTarget(FURNACE).working, true, 'the cached observation was superseded by the read')
  assert.equal(world.agent.liveObservedExactTarget(FURNACE).source, 'getEntityStatus')
  assert.ok(world.rcon.commands.some(command => command.includes('evaluate_condition')), 'one exact condition read')
})

test('an unobserved checkpoint machine is read exactly rather than trusted from nothing', async () => {
  const world = makeWorld({ committed: true })
  // Nothing observed this request (a restart clears the live observations).
  assert.equal(world.agent.liveObservedExactTarget(FURNACE), undefined)

  await world.agent.commitPlan(waitReply())

  assert.equal(world.rcon.mutations.length, 0)
  assert.equal(world.plan().condition_wait?.condition.unit_number, FURNACE)
  assert.equal(world.named('wait.routed_to_condition').length, 1)
})

test('registration commits a not-yet-committed draft the way the zero-operation turn does', async () => {
  const world = makeWorld({ draft: true })
  observeFurnace(world.agent)
  const before = world.memory.planningState(KEY).plans.at(-1)
  assert.ok([PLAN_STATUS.DRAFT, PLAN_STATUS.RUNTIME_VALIDATION, PLAN_STATUS.READY].includes(before.status), before.status)

  await world.agent.commitPlan(waitReply())

  const after = getActivePlan(world.memory.planningState(KEY))
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(after.status), after.status)
  assert.equal(world.plan().condition_wait?.state, 'active')
  assert.equal(world.rcon.mutations.length, 0)
})

test('a condition wait already running takes the wait-only batch without a second registration', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply())
  const first = world.plan().condition_wait

  world.agent.active = true
  await world.agent.commitPlan(waitReply())

  assert.equal(world.plan().condition_wait.id, first.id)
  assert.equal(world.rcon.mutations.length, 0)
  const routed = world.named('wait.routed_to_condition')
  assert.equal(routed.length, 2)
  assert.equal(routed[1].reason, 'condition_wait_already_active')
  assert.equal(routed[1].wait_id, first.id)
})

test('early completion wakes with the current evidence and closes the step only on the verified count', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply())

  // Still smelting: the planner stays asleep and nothing closes.
  const waiting = await world.agent.pollConditionWait()
  assert.equal(waiting.action, 'waiting')
  assert.equal(world.plan().task_board.completed_count, 0)

  world.rcon.machine.current = 50
  const verified = await world.agent.pollConditionWait()
  assert.equal(verified.action, 'verified')
  assert.equal(verified.facts.cause, 'satisfied')
  assert.equal(verified.facts.condition.minimum, 50)
  assert.match(verified.facts.evidence.summary, /"current":50/)
  assert.equal(verified.state.task_board.completed_count, 1)
  assert.equal(world.plan().condition_wait, undefined)
})

// A routed wait ends on the machine's real state: each cause reaches the woken planner as a concrete fact.
for (const [label, limitedBy, cause, working] of [
  ['no fuel', 'fuel', 'missing_fuel', false],
  ['depleted input', 'inputs', 'missing_input', false],
  ['blocked or full output', 'output_full', 'output_full', false],
]) {
  test(`a routed wait that ends on ${label} wakes with the concrete state and never closes the step`, async () => {
    const world = makeWorld({ committed: true })
    observeFurnace(world.agent)
    await world.agent.commitPlan(waitReply())

    world.rcon.machine = {
      ...world.rcon.machine,
      working,
      limitedBy,
      fuel: limitedBy === 'fuel' ? [] : world.rcon.machine.fuel,
      input: limitedBy === 'inputs' ? [] : world.rcon.machine.input,
    }
    const woken = await world.agent.pollConditionWait()

    assert.equal(woken.action, 'failed')
    assert.equal(woken.reason, 'condition_unsatisfied_and_not_progressing')
    assert.equal(woken.facts.cause, cause)
    assert.equal(woken.facts.machine.unit_number, FURNACE)
    assert.equal(woken.facts.machine.working, false)
    assert.deepEqual(woken.facts.machine.checkpoint, { item_name: 'iron-plate', minimum: 50, current: 47, satisfied: false })
    assert.equal(woken.facts.machine.eta.limited_by, limitedBy)
    assert.deepEqual(Object.keys(woken.facts.machine.inventories), ['fuel', 'input', 'output'])
    assert.deepEqual(woken.facts.machine.inventories.fuel, limitedBy === 'fuel' ? {} : { coal: 4 })
    assert.equal(world.plan().task_board.completed_count, 0)
    assert.equal(world.plan().condition_wait, undefined)
    assert.ok(JSON.stringify(woken.facts).length < 900, 'the wake facts stay bounded')
    assert.equal(world.named('runtime.condition_failed').at(-1).facts.cause, cause)
  })
}

test('a routed wait that passes its game-data deadline wakes as a timeout with the machine state', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply())
  const first = await world.agent.pollConditionWait()
  assert.equal(first.action, 'waiting')

  const wait = world.plan().condition_wait
  wait.registered_at -= wait.timeout_ms
  const overrun = await world.agent.pollConditionWait()

  assert.equal(overrun.action, 'timeout')
  assert.equal(overrun.facts.cause, 'timeout')
  assert.equal(overrun.facts.machine.working, true)
  assert.equal(overrun.facts.expected_seconds, 9.6)
  assert.equal(world.plan().task_board.completed_count, 0)
})

test('a routed passive-progress wait ends concretely when the machine stops', async () => {
  const world = makeWorld({ committed: true })
  // A step without a machine checkpoint: the most recently observed working machine is the passive candidate.
  world.plan().task_board.steps[0].completion_contract = undefined
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply())
  assert.equal(world.plan().condition_wait?.mode, 'passive_progress')
  assert.equal(world.named('wait.routed_to_condition')[0].reason, 'passive_progress_machine_working')

  world.rcon.machine = { ...world.rcon.machine, working: false, fuel: [] }
  const woken = await world.agent.pollConditionWait()

  assert.equal(woken.action, 'wake')
  assert.equal(woken.reason, 'passive_progress_stopped')
  assert.equal(woken.facts.cause, 'machine_stopped')
  assert.deepEqual(woken.facts.machine.inventories.fuel, {})
  assert.equal(world.plan().task_board.completed_count, 0)
})

test('restart while routed: the persisted wait resumes under a fresh loop and fails safely after an actor replacement', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  await world.agent.commitPlan(waitReply())
  const registered = world.plan().condition_wait

  // A new process over the same persisted state.
  const restarted = new NpcAgentLoop({
    rcon: world.rcon,
    memory: world.memory,
    npcId: 'sgluna',
    systemPrompt: 'restart',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('no model call while the wait resumes') },
  })
  restarted.active = true
  restarted.epoch = deployment()
  restarted.lastMemoryKey = KEY
  const resumed = await restarted.pollConditionWait()
  assert.equal(resumed.action, 'waiting')
  assert.equal(world.plan().condition_wait.id, registered.id)

  // The actor was replaced while the wait slept.
  world.rcon.actorEpoch = 4
  const failed = await restarted.pollConditionWait()
  assert.equal(failed.action, 'failed')
  assert.equal(failed.reason, 'condition_lifecycle_changed')
  assert.equal(failed.facts.cause, 'condition_lifecycle_changed')
  assert.equal(failed.facts.machine, undefined, 'a replaced actor reads no machine')
  assert.equal(world.plan().task_board.completed_count, 0)
  assert.equal(world.plan().condition_wait, undefined)
})

test('an actor epoch change during the fresh read fails the batch safely: nothing registered, nothing admitted', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)
  world.rcon.bumpEpochOnCondition = true

  await assert.rejects(world.agent.commitPlan(waitReply()), /epoch changed/i)

  assert.equal(world.plan().condition_wait, undefined)
  assert.equal(world.rcon.mutations.length, 0)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
})

test('a wait-only batch whose checkpoint machine is not working runs the timer and its receipt carries the fresh machine read', async () => {
  const world = makeWorld({ committed: true, script: [sleepingModel()] })
  observeFurnace(world.agent)
  world.rcon.machine = { ...world.rcon.machine, working: false, limitedBy: 'fuel', fuel: [] }

  const result = await world.agent.commitPlan(waitReply(600))

  assert.equal(world.rcon.mutations.length, 1, 'the timer was admitted as before')
  assert.match(world.rcon.mutations[0], /'wait'/)
  assert.deepEqual(result.operations.map(operation => operation.name), ['wait'])
  assert.equal(world.plan().condition_wait, undefined)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
  assert.equal(world.agent.pendingBlindWait.reason, 'checkpoint_machine_not_working')

  // The machine has since run out of fuel and the wait finished.
  world.agent.active = true
  world.rcon.completeBatch(['waiting'])
  await world.agent.completed()

  const [call] = world.calls
  const message = call.map(entry => String(entry.content ?? '')).find(content => content.includes('Fresh machine read taken after the wait'))
  assert.ok(message, 'the model-facing receipt carries the read')
  assert.match(message, /^\[MOD\] Autorio operation batch completed\./)
  const facts = JSON.parse(message.slice(message.indexOf('{"machines"')).replace(/\s+$/, ''))
  assert.equal(facts.machines.length, 1)
  const [machine] = facts.machines
  assert.equal(machine.unit_number, FURNACE)
  assert.equal(machine.name, 'stone-furnace')
  assert.equal(machine.working, false)
  assert.deepEqual(machine.checkpoint, { item_name: 'iron-plate', minimum: 50, current: 47, satisfied: false })
  assert.deepEqual(machine.inventories, { fuel: {}, input: { 'iron-ore': 2 }, output: { 'iron-plate': 47 } })
  assert.equal(machine.eta.limited_by, 'fuel')
  assert.equal(world.agent.liveObservedExactTarget(FURNACE).working, false, 'the cached observation is superseded')

  const [blind] = world.named('wait.blind_with_fresh_read')
  assert.ok(blind.request_id)
  assert.equal(blind.step_id, 'step_1')
  assert.deepEqual(blind.unit_numbers, [FURNACE])
  assert.equal(blind.reason, 'checkpoint_machine_not_working')
  assert.equal(blind.machines.length, 1)

  // Waiting is never production: the batch receipt does not close the step.
  assert.equal(world.plan().task_board.completed_count, 0)
  assert.ok(world.named('step.close_declined').some(entry => entry.reason === 'no_authoritative_operation_receipt'))
})

test('a blind wait with no machine to read says so in the trace and adds nothing to the receipt', async () => {
  const world = makeWorld({ committed: true, script: [sleepingModel()] })
  world.plan().task_board.steps[0].completion_contract = undefined
  // No machine observed at all.

  await world.agent.commitPlan(waitReply())
  assert.equal(world.rcon.mutations.length, 1)
  assert.equal(world.agent.pendingBlindWait.reason, 'no_machine_known')

  world.agent.active = true
  world.rcon.completeBatch(['waiting'])
  await world.agent.completed()

  const text = world.calls[0].map(entry => String(entry.content ?? '')).join('\n')
  assert.equal(text.includes('Fresh machine read taken after the wait'), false)
  const [blind] = world.named('wait.blind_with_fresh_read')
  assert.deepEqual(blind.unit_numbers, [])
  assert.equal(blind.reason, 'no_machine_known')
})

test('a mixed batch (wait plus another operation) is unchanged: no routing and no machine read', async () => {
  const world = makeWorld({ committed: true, script: [sleepingModel()] })
  observeFurnace(world.agent)
  const conditionReadsBefore = world.rcon.commands.filter(command => command.includes('evaluate_condition')).length

  const result = await world.agent.commitPlan(waitReply(600, {
    operations: [{ name: 'wait', args: { ticks: 600 } }, { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }],
  }))

  assert.equal(world.rcon.mutations.length, 1)
  assert.deepEqual(result.operations.map(operation => operation.name), ['wait', 'craft_item'])
  assert.equal(world.plan().condition_wait, undefined)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
  assert.equal(world.agent.pendingBlindWait ?? null, null)
  // The only read is unit G's one fresh read of the committed checkpoint before the batch (unmet here); routing adds none.
  assert.equal(world.rcon.commands.filter(command => command.includes('evaluate_condition')).length, conditionReadsBefore + 1)
  assert.equal(world.named('plan.step_closed_on_fresh_read').length, 0)

  world.agent.active = true
  world.rcon.completeBatch(['waiting', 'crafting'])
  await world.agent.completed()
  const text = world.calls[0].map(entry => String(entry.content ?? '')).join('\n')
  assert.equal(text.includes('Fresh machine read taken after the wait'), false)
  assert.equal(world.named('wait.blind_with_fresh_read').length, 0)
})

test('an explicit BLOCKED wait-only reply is never routed to a wait', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)

  await world.agent.commitPlan(waitReply(600, { chatMessage: 'BLOCKED: the furnace has no ore left and none is reachable.' }))

  assert.equal(world.plan().condition_wait, undefined)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
})

test('a zero-operation turn still registers its wait exactly as before and routes nothing', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)

  await world.agent.commitPlan({
    chatMessage: 'The furnace is smelting the plates.',
    plan: ['Smelt fifty iron plates', 'Craft the requested item'],
    currentStep: 0,
    operations: [],
  })

  assert.equal(world.plan().condition_wait?.mode, 'completion')
  assert.equal(world.named('runtime.condition_registered').length, 1)
  assert.equal(world.named('wait.routed_to_condition').length, 0)
  assert.equal(world.rcon.commands.filter(command => command.includes('evaluate_condition')).length, 0, 'no extra read on a zero-operation turn')
})

test('the passive route needs at least 300 requested ticks: below it the timer runs with the fresh-read receipt, at it the wait is routed', async () => {
  assert.equal(PASSIVE_ROUTE_MIN_WAIT_TICKS, 300)
  const short = makeWorld({ committed: true, script: [sleepingModel()] })
  short.plan().task_board.steps[0].completion_contract = undefined
  observeFurnace(short.agent)

  await short.agent.commitPlan(waitReply(299))

  assert.equal(short.rcon.mutations.length, 1, 'a short settle wait runs as a timer')
  assert.equal(short.plan().condition_wait, undefined)
  assert.equal(short.named('wait.routed_to_condition').length, 0)
  assert.equal(short.agent.pendingBlindWait.reason, 'short_wait_below_passive_threshold')
  assert.deepEqual(short.agent.pendingBlindWait.unit_numbers, [FURNACE])
  short.agent.active = true
  short.rcon.completeBatch(['waiting'])
  await short.agent.completed()
  const [blind] = short.named('wait.blind_with_fresh_read')
  assert.equal(blind.reason, 'short_wait_below_passive_threshold')
  assert.deepEqual(blind.unit_numbers, [FURNACE])

  // The sum of several waits counts.
  const summed = makeWorld({ committed: true })
  summed.plan().task_board.steps[0].completion_contract = undefined
  observeFurnace(summed.agent)
  await summed.agent.commitPlan(waitReply(150, { operations: [{ name: 'wait', args: { ticks: 150 } }, { name: 'wait', args: { ticks: 150 } }] }))
  assert.equal(summed.rcon.mutations.length, 0)
  assert.equal(summed.plan().condition_wait?.mode, 'passive_progress')

  const exact = makeWorld({ committed: true })
  exact.plan().task_board.steps[0].completion_contract = undefined
  observeFurnace(exact.agent)
  await exact.agent.commitPlan(waitReply(300))
  assert.equal(exact.rcon.mutations.length, 0)
  assert.equal(exact.plan().condition_wait?.mode, 'passive_progress')
})

test('a short wait on a committed machine checkpoint is still routed: only the passive route is gated', async () => {
  const world = makeWorld({ committed: true })
  observeFurnace(world.agent)

  await world.agent.commitPlan(waitReply(10))

  assert.equal(world.rcon.mutations.length, 0)
  assert.equal(world.plan().condition_wait?.mode, 'completion')
})

test('pendingBlindWait starts empty and a reset clears it', () => {
  const world = makeWorld({ committed: true })
  assert.equal(world.agent.pendingBlindWait, null)
  world.agent.pendingBlindWait = { request_id: 'req', reason: 'x', unit_numbers: [1] }
  world.agent.reset()
  assert.equal(world.agent.pendingBlindWait, null)
})
