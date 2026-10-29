import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { buildPendingOperation } from './operation-reconciliation.mjs'
import { captureFactoryPlacementContext, deriveFactoryPlacementReceipt, FactoryPlacementStore, FACTORY_PLACEMENT_LIMIT } from './factory-placement-provenance.mjs'

const KEY = 'npc:placement-provenance'
const WORLD = '1e837e91-4f33-43a2-a3aa-c891ee06ec66'
const ACTOR = { actor_id: 24, epoch: 2, session: 'fixture-session' }
const clone = value => structuredClone(value)
function fixture() {
  const memory = new CanonicalTaskBoardMemory()
  memory.initializeFactoryRegistry(WORLD)
  memory.recordPlan(KEY, { sender: 'owner', text: 'Preserve this assigned production task' }, {
    chatMessage: '', plan: ['Place one observed machine'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', confidence: 0.9,
      requirements: [{ id: 'stock', kind: 'inventory_count', item_name: 'fixture-product', minimum: 1 }] } }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const state = memory.planningState(KEY); const plan = getActivePlan(state); const step = plan.steps[0]
  const pending = buildPendingOperation({ requestId: 'original-placement-request', operationKey: 'original/batch-1', attemptId: 'original-attempt',
    ordinal: 1, protocolVersion: 2, actor: ACTOR, surfaceIndex: 1, goalId: state.goal.goal_id, planId: plan.plan_id, stepId: step.step_id,
    operations: [{ name: 'place_entity', args: { entity_name: 'fixture-machine', x: 3, y: 4 } }] })
  assert.ok(memory.recordPendingOperation(KEY, pending))
  const ref = { batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4' }
  const batch = { ...ref, state: 'completed', tick: 100, task_count: 1, started_count: 1, task_types: ['placing'] }
  const status = { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, last_completed_batch: clone(batch), receipt_journal: [batch],
    admission_journal: [{ operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
      actor_id: ACTOR.actor_id, epoch: ACTOR.epoch, ordinal: 1, operation_count: 1, generation: 1, state: 'completed', ok: true,
      slots: [{ index: 1, operation: 'place_entity', ok: true, queued_tasks: 1, batch_refs: [ref] }] }],
    basic_operation: { last_result: { operation_id: 7, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 100,
      actor_id: ACTOR.actor_id, actor_kind: 'standalone_character', entity_name: 'fixture-machine', placed_unit_number: 77,
      placed_position: { x: 3, y: 4 }, placed_surface_index: 1, placed_force_index: 1, placed_world_id: WORLD,
      placed_batch_id: 4, placed_batch_generation: 1, placed_batch_ref: 'batch-g1-4' } } }
  const context = captureFactoryPlacementContext(memory, KEY, ACTOR)
  const events = []; const writes = []
  const agent = new NpcAgentLoop({ rcon: { command: async () => { await agent.onRead?.(); return JSON.stringify(status) } }, memory,
    stateFile: null, traceFile: null, decisionTraceFile: null, npcId: 'placement-provenance', completionProtocolVersion: 2,
    provider: async () => { throw new Error('No provider authorized') }, jevCheckpoints: false })
  agent.active = true; agent.epoch = { ...ACTOR }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'later-poll-request', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async record => { events.push(record) } }
  agent.persistState = async () => { writes.push(memory.snapshot()) }
  return { memory, plan, step, pending, status, context, agent, events, writes }
}

test('actual post-batch path retains original ownership before settlement, with no goal, plan or budget changes', async () => {
  const w = fixture(); const goal = clone(w.memory.planningState(KEY).goal); const plan = clone(w.plan)
  const response = await w.agent.taskStatusReceipt()
  assert.equal(response.view.status_error, undefined)
  const receipt = w.memory.snapshot().factory_placement_receipts?.[0]
  assert.ok(receipt)
  assert.equal(receipt.request_id, 'original-placement-request')
  assert.equal(receipt.plan_id, w.pending.plan_id)
  assert.equal(receipt.step_id, w.pending.step_id)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.ok(w.writes.some(s => s.factory_placement_receipts?.length === 1))
  assert.deepEqual(w.memory.planningState(KEY).goal, goal)
  assert.deepEqual(getActivePlan(w.memory.planningState(KEY)), plan)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.ok(w.events.some(row => row.event === 'factory_placement.capture' && row.data.status === 'recorded'))
  assert.ok(w.events.some(row => row.event === 'operation.reconciled' && row.data.verdict === 'admitted_completed'))
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.deepEqual(restored.factoryPlacementReceipt(receipt.receipt_id), receipt)
  const copy = restored.factoryPlacementReceipt(receipt.receipt_id); copy.name = 'forged'
  assert.equal(restored.factoryPlacementReceipt(receipt.receipt_id).name, 'fixture-machine')
  // No repeated poll can attribute the old placement to the new request.
  await w.agent.taskStatusReceipt()
  assert.equal(w.memory.snapshot().factory_placement_receipts.length, 1)
})

test('default guarded runtime consumes retained native provenance after canonical restore', async () => {
  const w = fixture(); await w.agent.taskStatusReceipt()
  const memory = new CanonicalTaskBoardMemory(); memory.restore(w.memory.snapshot())
  const receipt = memory.snapshot().factory_placement_receipts[0]
  const runtime = memory.createFactoryRegistryRuntime(KEY, () => ({ world_id: WORLD, surface_index: 1, force_index: 1,
    actor_id: 24, actor_epoch: 2, request_id: 'registration-request', native_idle: true, pending: false, uncertain: false }))
  const member = runtime.recordPlacement({ unit_number: receipt.unit_number, name: receipt.name, position: receipt.position,
    surface_index: 1, force_index: 1, provenance: { receipt_id: receipt.receipt_id } }, runtime.scope())
  assert.equal(member.provenance.request_id, 'original-placement-request')
  assert.equal(memory.getFactoryRegistry().cells.length, 0)
})

test('capture context is immutable original admission; legacy, paused, cross-goal and stale actor contexts cannot qualify', () => {
  for (const change of [w => { w.memory.planningState(KEY).run.paused = true },
    w => { w.memory.planningState(KEY).goal.goal_id = 'other-goal' },
    w => { w.pending.protocol_version = 1; w.memory.updatePendingOperation(KEY, w.pending) }]) {
    const w = fixture(); change(w)
    assert.equal(deriveFactoryPlacementReceipt(w.status, captureFactoryPlacementContext(w.memory, KEY, ACTOR)), undefined)
  }
  const w = fixture()
  assert.equal(deriveFactoryPlacementReceipt(w.status, captureFactoryPlacementContext(w.memory, KEY, { ...ACTOR, epoch: 3 })), undefined)
  w.memory.clearPendingOperation(KEY)
  assert.ok(deriveFactoryPlacementReceipt(w.status, w.context), 'captured original remains historical evidence')
  assert.equal(deriveFactoryPlacementReceipt(w.status, captureFactoryPlacementContext(w.memory, KEY, ACTOR)), undefined)
})

test('every missing or contradictory native causal link leaves provenance unavailable', () => {
  const mutations = [
    s => { delete s.basic_operation.last_result.placed_world_id }, s => { s.basic_operation.last_result.placed_world_id = 'other' },
    s => { delete s.basic_operation.last_result.placed_force_index }, s => { s.basic_operation.last_result.actor_id++ },
    s => { s.basic_operation.last_result.actor_kind = 'player' }, s => { s.basic_operation.last_result.placed_last_user = 'human' },
    s => { s.basic_operation.last_result.placed_batch_id++ }, s => { s.basic_operation.last_result.tick-- },
    s => { s.basic_operation.last_result.entity_name = 'other' }, s => { s.basic_operation.last_result.placed_surface_index++ },
    s => { s.admission_journal[0].signature = 'wrong' }, s => { s.admission_journal[0].state = 'uncertain' },
    s => { s.admission_journal[0].slots[0].queued_tasks = 2 }, s => { s.receipt_journal = [] },
    s => { s.receipt_journal[0].outcome = 'refused' }, s => { s.receipt_journal[0].state = 'cancelled' },
    s => { s.receipt_journal[0].task_count = 2; s.receipt_journal[0].task_types.push('moving_items') },
    s => { s.last_completed_batch.batch_id++ }, s => { s.batch_generation++ }, s => { s.queue_length = 1 },
  ]
  for (const mutate of mutations) { const w = fixture(); mutate(w.status); assert.equal(deriveFactoryPlacementReceipt(w.status, w.context), undefined, mutate.toString()) }
})

test('unavailable provenance does not turn known applied placement into a failed or unsent operation', async () => {
  const w = fixture(); delete w.status.basic_operation.last_result.placed_world_id
  const result = await w.agent.taskStatusReceipt()
  assert.equal(result.view.status_error, undefined)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.equal(w.memory.snapshot().factory_placement_receipts, undefined)
  assert.ok(w.events.some(row => row.event === 'operation.reconciled' && row.data.verdict === 'admitted_completed'))
  assert.ok(w.events.some(row => row.event === 'factory_placement.capture' && row.data.status === 'unavailable'))
})

test('changed owner during native await prevents publication; restore invalidates captured capability', async () => {
  const w = fixture(); w.agent.onRead = () => { w.agent.traceRequest = { id: 'superseded' } }
  await assert.rejects(w.agent.taskStatusReceipt(), /cancelled|superseded/i)
  assert.equal(w.memory.snapshot().factory_placement_receipts, undefined)
  const v = fixture(); v.memory.restore(v.memory.snapshot())
  assert.throws(() => v.agent.retainFactoryPlacementReceipt(v.status, v.context), error => error.code === 'factory_runtime_stale')
})

test('bounded append-only store is idempotent, capacity refuses without eviction and conflict faults survive restore', () => {
  const w = fixture(); const original = deriveFactoryPlacementReceipt(w.status, w.context); const store = new FactoryPlacementStore()
  assert.equal(store.record(original, WORLD).status, 'recorded')
  assert.equal(store.record(original, WORLD).status, 'duplicate')
  for (let i = 1; i < FACTORY_PLACEMENT_LIMIT; i++) store.record({ ...original, receipt_id: `${WORLD}/batch-g1-${i + 4}/7`, batch_id: i + 4, batch_ref: `batch-g1-${i + 4}`, unit_number: i + 77 }, WORLD)
  assert.throws(() => store.record({ ...original, receipt_id: `${WORLD}/batch-g1-999/7`, batch_id: 999, batch_ref: 'batch-g1-999', unit_number: 999 }, WORLD), error => error.code === 'factory_placement_capacity')
  assert.deepEqual(store.read(original.receipt_id), original)
  assert.equal(store.snapshot().factory_placement_receipts.length, FACTORY_PLACEMENT_LIMIT)
  assert.throws(() => store.record({ ...original, name: 'conflicting' }, WORLD), error => error.code === 'factory_placement_identity_conflict')
  const restored = new FactoryPlacementStore(); restored.restore(store.snapshot(), WORLD)
  assert.throws(() => restored.read(original.receipt_id), error => error.code === 'factory_placement_store_fault')
  assert.deepEqual(restored.snapshot().factory_placement_receipts, store.snapshot().factory_placement_receipts)
})

test('malformed, wrong-world, duplicate and rollback restores fail closed without deleting retained evidence', () => {
  const w = fixture(); const original = deriveFactoryPlacementReceipt(w.status, w.context)
  for (const raw of [[{ ...original, actor_epoch: -1 }], [{ ...original, world_id: 'other' }], [original, original], []]) {
    const store = new FactoryPlacementStore(); store.record(original, WORLD)
    store.restore({ factory_placement_receipts: raw }, WORLD)
    assert.throws(() => store.read(original.receipt_id), error => error.code === 'factory_placement_store_fault')
    assert.deepEqual(store.snapshot().factory_placement_receipts, [original])
  }
})

test('capture persistence failure retains pending authority and known effects but prevents later receipt lookup', async () => {
  const w = fixture(); w.agent.persistState = async () => { throw new Error('fixture write failed') }
  const result = await w.agent.taskStatusReceipt()
  assert.match(result.view.status_error, /fixture write failed/)
  assert.equal(w.memory.pendingOperations(KEY).length, 1)
  const receipt = w.memory.snapshot().factory_placement_receipts[0]
  assert.throws(() => w.memory.factoryPlacementReceipt(receipt.receipt_id), error => error.code === 'factory_placement_store_fault')
  const trace = w.events.find(row => row.event === 'factory_placement.capture_persistence_failed')
  assert.equal(trace.data.native_effect, 'completed')
  assert.equal(trace.data.placement_request_id, 'original-placement-request')
})

test('actual capture identity-conflict refusal retains original causal trace and native completed settlement', async () => {
  const w = fixture()
  const original = w.agent.retainFactoryPlacementReceipt(w.status, w.context).receipt
  w.status.basic_operation.last_result.placed_unit_number++
  const response = await w.agent.taskStatusReceipt()
  assert.equal(response.view.status_error, undefined)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.deepEqual(w.memory.snapshot().factory_placement_receipts, [original])
  const trace = w.events.find(row => row.event === 'factory_placement.capture')
  assert.equal(trace.data.status, 'refused')
  assert.equal(trace.data.reason, 'factory_placement_identity_conflict')
  assert.equal(trace.data.placement_request_id, original.request_id)
  for (const field of ['receipt_id', 'operation_key', 'batch_ref', 'goal_id', 'plan_id', 'step_id']) assert.equal(trace.data[field], original[field])
  assert.ok(w.events.some(row => row.event === 'operation.reconciled' && row.data.verdict === 'admitted_completed'))
})
