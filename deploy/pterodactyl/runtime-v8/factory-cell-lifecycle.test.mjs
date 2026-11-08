import test from 'node:test'
import assert from 'node:assert/strict'
import { FactoryCellLifecycleStore, verifyFactoryRemovalCustody, verifyFactoryResidualCustody } from './factory-cell-lifecycle.mjs'
import { createFactoryRegistry, registerFactoryCell, factoryCellMetadataHead, factoryMetadataDigest as digest } from './factory-registry.mjs'
import { buildPendingOperation, operationIdentity } from './operation-reconciliation.mjs'
import { deriveFactoryPlacementReceipt } from './factory-placement-provenance.mjs'
import fsp from 'node:fs/promises'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { factoryLifecycleOperation, claimFactoryLifecycleOperation } from './factory-cell-lifecycle-runtime.mjs'
import { reconcileFactoryLifecycleResidual } from './factory-cell-lifecycle-controller.mjs'

// Synthetic inventory counts/fixtures are not game recipes or capacity facts.
const WORLD = '1f207b33-f2b7-4104-b04d-21bb089a304e'
const clone = value => structuredClone(value)
const throws = (fn, code) => assert.throws(fn, error => error.code === code)
const item = (name, count = 1, quality = 'normal') => ({ name, quality, count })
function fixture(kind = 'retire') {
  const retainedPlacements = new Map()
  const store = new FactoryCellLifecycleStore({ readPlacementReceipt: id => clone(retainedPlacements.get(id)),
    readPlacementReceipts: scope => [...retainedPlacements.values()].filter(row => row.world_id === scope.world_id && row.goal_id === scope.goal_id && row.semantic_step_id === scope.semantic_step_id).map(clone) })
  const context = { world_id: WORLD, surface_index: 1, force_index: 1, actor_id: 24, actor_epoch: 2, session_id: 'lifecycle-session', request_id: 'lifecycle-request',
    goal_id: 'lifecycle-goal', plan_id: 'lifecycle-plan', plan_version: 1, step_id: 'lifecycle-step', semantic_step_id: 'lifecycle-step', native_idle: true, pending: false, uncertain: false }
  const member = { unit_number: 27, name: 'fixture-machine', position: { x: 2, y: 3 }, surface_index: 1, force_index: 1,
    provenance: { source: 'fixture', receipt_id: 'fixture-original' } }
  const registry = registerFactoryCell(createFactoryRegistry(WORLD), { surface_index: 1, force_index: 1,
    assignment: { products: ['fixture-product'], purpose: 'Retain the assigned job', method: 'native production' },
    members: [member], ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: 'fixture-product' }], origin: { source: 'fixture' } })
  const cell = registry.cells[0]
  const operations = kind === 'expand' ? [{ kind: 'add', name: 'fixture-machine', position: { x: 4, y: 3 },
    operation: { name: 'place_entity', args: { entity_name: 'fixture-machine', x: 4, y: 3 }, placed_entity: 'fixture-machine' } }]
    : [{ kind: 'remove', member: clone(member), quality: 'normal', operation: { name: 'mine_entity_exact', args: { unit_number: 27 } } }]
  const change = { transaction_id: 'lifecycle-1', cell_id: cell.cell_id, kind, expected_registry_revision: registry.revision,
    expected_lifecycle_revision: store.revision(), expected_cells: [{ cell_id: cell.cell_id, revision: cell.revision, digest: digest(cell) }],
    assignment: clone(cell.assignment), operations, action_limit: operations.length }
  const evidence = { world_id: WORLD, registry_revision: registry.revision, request_id: context.request_id, actor_id: 24, actor_epoch: 2,
    session_id: context.session_id, fresh: true, truncated: false, native_idle: true, pending: false, uncertain: false, tick: 80,
    members: [{ ...clone(member), quality: 'normal', contents_known: true, recovery_capacity: 'verified' }],
    consumers: { coverage: 'complete', truncated: false, unresolved: false, rows: [] }, job_preserved: true, evidence_ref: 'synthetic-live-proof' }
  const pending = buildPendingOperation({ requestId: context.request_id, operationKey: 'lifecycle/batch-1', attemptId: 'lifecycle-attempt', ordinal: 1,
    protocolVersion: 2, actor: { actor_id: 24, epoch: 2, session: context.session_id }, surfaceIndex: 1,
    goalId: context.goal_id, planId: context.plan_id, stepId: 'lifecycle-step', operations: [operations[0].operation] })
  const ref = { batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4' }
  const receipt = { schema_version: 1, state: 'verified', code: 'removal_custody_verified', world_id: WORLD, operation_id: 7, before_tick: 90, after_tick: 100,
    binding: { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, ordinal: pending.ordinal,
      actor_id: 24, epoch: 2, session: context.session_id, ...ref },
    before: { target: { ...clone(member), type: 'container', quality: 'normal' }, contents: [item('fixture-stock', 3)], products: [item('fixture-machine')],
      inventories: [{ index: 1, size: 4, items: [item('fixture-stock', 3)] }], fluidboxes: 1, fluids_empty: true },
    actor_before: [item('fixture-held', 2)], actor_after: [item('fixture-held', 2), item('fixture-stock', 3), item('fixture-machine')],
    recovered_items: [item('fixture-stock', 3), item('fixture-machine')], target_gone: true, native_call: 'returned_true' }
  delete receipt.before.target.provenance
  const batch = { ...ref, state: 'completed', tick: 100, task_count: 1, started_count: 1, task_types: ['mining'] }
  const status = { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, last_completed_batch: clone(batch), receipt_journal: [batch],
    admission_journal: [{ operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
      actor_id: 24, epoch: 2, ordinal: 1, operation_count: 1, generation: 1, state: 'completed', ok: true, entity_removal: receipt,
      slots: [{ index: 1, operation: pending.operations[0].name, ok: true, queued_tasks: 1, batch_refs: [ref] }] }] }
  if (kind === 'expand') delete status.admission_journal[0].entity_removal
  const persist = () => { const snapshot = store.snapshot(); assert.equal(store.markPersisted(snapshot), true); return snapshot }
  const start = () => { store.begin(change, registry, context, evidence); persist(); store.claim(change.transaction_id, pending, registry, context); persist() }
  const finalEvidence = () => ({ ...clone(evidence), members: store.current(change.transaction_id).current_members,
    installation: 'verified', assignment: clone(cell.assignment) })
  return { store, retainedPlacements, registry, cell, member, context, change, evidence, pending, receipt, status, persist, start, finalEvidence }
}
function negativeTerminal(w, state = 'partial') {
  w.receipt.state = state; w.receipt.native_call = 'returned_false'; w.receipt.target_gone = false
  w.status.admission_journal[0].state = 'uncertain'
  Object.assign(w.status.receipt_journal[0], { state: 'cancelled', reason: state === 'refused' ? 'mining:entity_removal_refused' : 'mining:entity_removal_uncertain' })
  w.status.last_cancelled_batch = clone(w.status.receipt_journal[0]); delete w.status.last_completed_batch
}

test('retirement preserves assignment history; native custody and strict durability precede tombstone publication', () => {
  const w = fixture(); const original = clone(w.registry)
  w.store.begin(w.change, w.registry, w.context, w.evidence)
  assert.equal(w.store.project(w.cell).state, 'degraded')
  throws(() => w.store.claim(w.change.transaction_id, w.pending, w.registry, w.context), 'factory_lifecycle_persistence_required')
  w.persist(); w.store.claim(w.change.transaction_id, w.pending, w.registry, w.context)
  assert.equal(w.store.admission([w.change.operations[0].operation], w.pending, w.context).ok, false)
  w.persist(); assert.equal(w.store.admission([w.change.operations[0].operation], w.pending, w.context).authorized, true)
  assert.deepEqual(w.store.settle(w.status, w.pending, w.context), { matched: true, changed: true, hold: false, state: 'verified' })
  throws(() => w.store.finish(w.change.transaction_id, w.registry, w.context, w.finalEvidence()), 'factory_lifecycle_persistence_required')
  w.persist(); w.store.finish(w.change.transaction_id, w.registry, w.context, w.finalEvidence()); w.persist()
  const projected = w.store.project(w.cell)
  assert.equal(projected.state, 'retired'); assert.deepEqual(projected.members, []); assert.deepEqual(projected.assignment, w.cell.assignment)
  assert.equal(projected.physical_revision, 1); assert.deepEqual(w.registry, original)
  assert.equal(w.store.snapshot().factory_lifecycle.events.length, 4)
  assert.equal(w.store.settle(w.status, w.pending, w.context).changed, false)
})

test('true/disappeared, partial false, fluid loss, inventory loss and quality substitutions never prove custody', () => {
  const w = fixture(); assert.equal(verifyFactoryRemovalCustody(w.receipt), true)
  const emptyLua = clone(w.receipt); emptyLua.actor_before = {}; emptyLua.before.contents = {}; emptyLua.before.inventories[0].items = {}
  emptyLua.actor_after = [item('fixture-machine')]; emptyLua.recovered_items = [item('fixture-machine')]
  const originalLua = clone(emptyLua)
  assert.equal(verifyFactoryRemovalCustody(emptyLua), true, 'native empty Lua arrays serialize as {}')
  assert.deepEqual(emptyLua, originalLua, 'retain native receipt bytes/data; do not rewrite evidence')
  for (const mutate of [r => { r.actor_after = r.actor_before }, r => { r.recovered_items = [] }, r => { r.native_call = 'returned_false' },
    r => { r.before.fluids_empty = false }, r => { r.before.contents[0].quality = 'different' }, r => { r.actor_after[1].count-- },
    r => { r.before.inventories.push(clone(r.before.inventories[0])) }, r => { delete r.actor_before }]) {
    const receipt = clone(w.receipt); mutate(receipt); assert.equal(verifyFactoryRemovalCustody(receipt), false, mutate.toString())
  }
  for (const state of ['partial', 'uncertain', 'refused']) {
    const x = fixture(); x.start(); negativeTerminal(x, state)
    const result = x.store.settle(x.status, x.pending, x.context); assert.equal(result.hold, true)
    x.persist(); assert.equal(x.store.project(x.cell).members.length, 1)
    assert.equal(x.store.admission(x.pending.operations, x.pending, x.context).ok, false)
    throws(() => x.store.finish(x.change.transaction_id, x.registry, x.context, x.finalEvidence()), 'factory_lifecycle_incomplete')
  }
})

test('journal expiry cannot grant replay; retained claim restores and consumes exact receipt once', () => {
  const w = fixture(); w.start(); const snapshot = w.persist()
  const restored = new FactoryCellLifecycleStore(); restored.restore(snapshot, WORLD)
  throws(() => restored.claim(w.change.transaction_id, w.pending, w.registry, w.context), 'factory_lifecycle_claim_forbidden')
  const expired = clone(w.status); expired.admission_journal = []
  assert.equal(restored.settle(expired, w.pending, w.context).hold, true)
  assert.equal(restored.settle(w.status, w.pending, w.context).state, 'verified')
  restored.markPersisted(restored.snapshot())
  const again = new FactoryCellLifecycleStore(); again.restore(restored.snapshot(), WORLD)
  assert.equal(again.settle(w.status, w.pending, w.context).changed, false)
  assert.equal(again.project(w.cell).members.length, 0)
  const bad = clone(w.status); bad.admission_journal[0].entity_removal.actor_after = []
  throws(() => again.settle(bad, w.pending, w.context), 'factory_lifecycle_receipt_conflict')
})

test('native identity, owner, busy and acknowledgement fences cannot publish stale effects', () => {
  for (const field of ['actor_id', 'actor_epoch', 'session_id', 'request_id', 'goal_id', 'plan_id', 'plan_version', 'semantic_step_id']) {
    const w = fixture(); w.start(); const context = clone(w.context); context[field] = typeof context[field] === 'number' ? context[field] + 1 : `${context[field]}-other`
    throws(() => w.store.settle(w.status, w.pending, context), 'factory_lifecycle_owner_stale')
  }
  for (const mutate of [s => { s.receipt_journal = [] }, s => { s.admission_journal[0].signature = 'other' }, s => { s.admission_journal[0].generation++ }]) {
    const w = fixture(); w.start(); mutate(w.status)
    assert.equal(w.store.settle(w.status, w.pending, w.context).state, 'uncertain')
    assert.equal(w.store.project(w.cell).members.length, 1)
  }
  const w = fixture(); w.start(); w.status.queue_length = 1
  assert.equal(w.store.settle(w.status, w.pending, w.context).hold, true)
  assert.equal(w.store.current(w.change.transaction_id).state, 'awaiting_receipt')
})

test('active, unresolved and incomplete native consumers fence retirement, even with empty declarations', () => {
  for (const mutate of [e => { e.consumers.coverage = 'unknown' }, e => { e.consumers.unresolved = true },
    e => { e.consumers.rows.push({ cell_id: 'unregistered-native-consumer', state: 'preserved', verified: true, evidence_ref: 'native' }) },
    e => { e.members[0].recovery_capacity = 'unknown' }, e => { e.fresh = false }]) {
    const w = fixture(); mutate(w.evidence)
    assert.throws(() => w.store.begin(w.change, w.registry, w.context, w.evidence))
    assert.equal(w.store.revision(), 0)
  }
  const w = fixture(); w.change.assignment.products = ['different-job']
  throws(() => w.store.begin(w.change, w.registry, w.context, w.evidence), 'factory_lifecycle_change_invalid')
})

test('expansion adds only a same-job placement receipt and requires fresh installation reconciliation', () => {
  const w = fixture('expand'); w.start()
  w.status.receipt_journal[0].task_types = ['placing']; w.status.last_completed_batch.task_types = ['placing']
  w.status.basic_operation = { last_result: { operation_id: 7, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 100,
    actor_id: 24, actor_kind: 'standalone_character', entity_name: 'fixture-machine', placed_unit_number: 28,
    placed_position: { x: 4, y: 3 }, placed_surface_index: 1, placed_force_index: 1, placed_world_id: WORLD,
    placed_batch_id: 4, placed_batch_generation: 1, placed_batch_ref: 'batch-g1-4' } }
  const receipt = deriveFactoryPlacementReceipt(w.status, { world_id: WORLD, actor: { actor_id: 24, epoch: 2 },
    candidates: [{ pending: w.pending, plan_version: 1, semantic_step_id: w.context.semantic_step_id }] })
  assert.ok(receipt)
  assert.equal(w.store.settle(w.status, w.pending, w.context, receipt).state, 'verified'); w.persist()
  assert.equal(w.store.project(w.cell).members.length, 2); assert.equal(w.store.project(w.cell).state, 'degraded')
  const bad = w.finalEvidence(); bad.installation = 'unknown'
  throws(() => w.store.finish(w.change.transaction_id, w.registry, w.context, bad), 'factory_lifecycle_installation_unverified')
  w.store.finish(w.change.transaction_id, w.registry, w.context, w.finalEvidence()); w.persist()
  assert.equal(w.store.project(w.cell).state, 'unverified', 'installed never means commissioned')
  assert.deepEqual(w.store.project(w.cell).assignment, w.cell.assignment)
})

test('temporary receipt requires durable pre-placement classification and every beneficiary before cleanup eligibility', () => {
  const w = fixture('cleanup'); const context = { ...w.context }
  const operation = { name: 'place_entity', args: { entity_name: w.member.name, x: w.member.position.x, y: w.member.position.y } }
  const intent = { intent_id: 'temporary-1', classification: 'temporary', purpose: 'Support an explicitly bounded setup',
    retirement_condition: 'beneficiaries_complete_and_redundant', placement_intent_digest: operationIdentity(operation),
    placement: { name: w.member.name, position: w.member.position, surface_index: 1, force_index: 1, operation },
    beneficiaries: [{ goal_id: context.goal_id, semantic_step_id: 'beneficiary-a' }, { goal_id: context.goal_id, semantic_step_id: 'beneficiary-b' }] }
  const placement = buildPendingOperation({ requestId: context.request_id, operationKey: 'temporary/place', attemptId: 'temporary-attempt', ordinal: 2,
    protocolVersion: 2, actor: { actor_id: 24, epoch: 2 }, surfaceIndex: 1, goalId: context.goal_id, planId: context.plan_id, stepId: context.step_id, operations: [operation] })
  const receipt = { ...clone(w.member), world_id: WORLD, goal_id: context.goal_id, actor_id: 24, actor_epoch: 2, receipt_id: 'temporary-placement',
    request_id: context.request_id, plan_id: context.plan_id, plan_version: 1, step_id: context.step_id, semantic_step_id: context.semantic_step_id, operation_key: placement.operation_key }
  throws(() => w.store.temporary(intent, receipt, context), 'factory_temporary_authority_unknown')
  w.store.declareTemporary(intent, context)
  throws(() => w.store.temporary(intent, receipt, context), 'factory_lifecycle_persistence_required')
  w.persist(); w.store.bindTemporaryPlacement(intent.intent_id, placement, context); w.persist()
  w.retainedPlacements.set(receipt.receipt_id, clone(receipt)); w.store.temporary(intent, receipt, context); w.persist()
  const done = id => ({ goal_id: context.goal_id, semantic_step_id: id, status: 'completed', verified: true, receipt_id: `completion-${id}` })
  assert.deepEqual(w.store.scheduleCleanup([done('beneficiary-a')], context), []); w.persist()
  assert.equal(w.store.scheduleCleanup([done('beneficiary-b')], context)[0].state, 'reconciliation_required'); w.persist()
  w.change.expected_lifecycle_revision = w.store.revision()
  throws(() => w.store.begin(w.change, w.registry, context, w.evidence), 'factory_cleanup_redundancy_unknown')
  w.evidence.redundancy = 'verified'
  assert.equal(w.store.begin(w.change, w.registry, context, w.evidence).kind, 'cleanup')
})

test('history tampering and rollback fault durably; duplicate intent cannot renew action allowance', () => {
  const w = fixture(); w.start(); const before = w.store.revision()
  assert.equal(w.store.begin(w.change, w.registry, w.context, w.evidence).claims.length, 1)
  assert.equal(w.store.revision(), before)
  const conflict = clone(w.change); conflict.action_limit++
  throws(() => w.store.begin(conflict, w.registry, w.context, w.evidence), 'factory_lifecycle_transaction_conflict')
  const snapshot = w.persist(); snapshot.factory_lifecycle.events[0].payload.assignment.products = ['other-job']
  const restored = new FactoryCellLifecycleStore(); restored.restore(snapshot, WORLD)
  assert.equal(restored.pending(), true); throws(() => restored.project(w.cell), 'factory_lifecycle_fault')
  const fresh = new FactoryCellLifecycleStore(); fresh.restore(w.persist(), WORLD); fresh.restore({}, WORLD)
  throws(() => fresh.assertDurable(), 'factory_lifecycle_fault')
})

test('partially moved contents require fresh exact reconciliation; retry allowance survives restore and exhausts', () => {
  const w = fixture(); w.change.action_limit = 2; w.start()
  negativeTerminal(w); w.receipt.code = 'removal_contents_partially_moved'
  w.receipt.recovered_items = [item('fixture-stock', 1)]; w.receipt.actor_after = [item('fixture-held', 2), item('fixture-stock', 1)]
  w.receipt.after = clone(w.receipt.before); w.receipt.after.contents = [item('fixture-stock', 2)]; w.receipt.after.inventories[0].items = [item('fixture-stock', 2)]
  assert.equal(verifyFactoryResidualCustody(w.receipt), true)
  assert.equal(w.store.settle(w.status, w.pending, w.context).hold, true); w.persist()
  const evidence = clone(w.evidence); evidence.tick = 100; evidence.members[0].removal_snapshot = clone(w.receipt.after); evidence.actor_inventory = clone(w.receipt.actor_after)
  const changed = clone(evidence); changed.actor_inventory[0].count++
  throws(() => w.store.reconcileResidual(w.change.transaction_id, w.registry, w.context, changed), 'factory_lifecycle_residual_changed')
  w.store.reconcileResidual(w.change.transaction_id, w.registry, w.context, evidence)
  assert.equal(w.store.settle(w.status, w.pending, w.context).hold, true, 'reconciliation must first be durable'); w.persist()
  assert.equal(w.store.settle(w.status, w.pending, w.context).hold, false)
  const restored = new FactoryCellLifecycleStore(); restored.restore(w.persist(), WORLD)
  const retry = clone(w.pending); retry.operation_key = 'lifecycle/batch-2'; retry.attempt_id = 'lifecycle-retry'; retry.ordinal = 2
  restored.claim(w.change.transaction_id, retry, w.registry, w.context); restored.markPersisted(restored.snapshot())
  const status = clone(w.status); Object.assign(status.admission_journal[0], { operation_key: retry.operation_key, attempt_id: retry.attempt_id, ordinal: 2 })
  Object.assign(status.admission_journal[0].entity_removal.binding, { operation_key: retry.operation_key, attempt_id: retry.attempt_id, ordinal: 2 })
  restored.settle(status, retry, w.context); restored.markPersisted(restored.snapshot())
  throws(() => restored.reconcileResidual(w.change.transaction_id, w.registry, w.context, evidence), 'factory_lifecycle_recovery_exhausted')
  assert.equal(restored.current(w.change.transaction_id).claims.length, 2)
  assert.equal(restored.project(w.cell).members.length, 1)
})

test('trusted pretransport cancellation releases the exact pending claim without refunding allowance', () => {
  const w = fixture(); w.start()
  const witness = { not_sent: true, reason: 'prepared_operation_cancelled_before_transport', operation_key: w.pending.operation_key, attempt_id: w.pending.attempt_id }
  throws(() => w.store.notSent(w.pending, w.context, { ...witness, not_sent: false }), 'factory_lifecycle_no_send_unproven')
  assert.equal(w.store.notSent(w.pending, { ...w.context, cancelled: true }, witness).changed, true); w.persist()
  assert.equal(w.store.notSent(w.pending, w.context, witness).changed, false)
  assert.equal(w.store.current(w.change.transaction_id).claims.length, 1)
  assert.equal(w.store.project(w.cell).members.length, 1)
  const retry = clone(w.pending); retry.operation_key = 'new'; retry.attempt_id = 'new'
  throws(() => w.store.claim(w.change.transaction_id, retry, w.registry, w.context), 'factory_lifecycle_claim_forbidden')
  const sent = fixture(); sent.start(); sent.store.settle(sent.status, sent.pending, sent.context)
  throws(() => sent.store.notSent(sent.pending, sent.context, witness), 'factory_lifecycle_no_send_conflict')
})

function canonicalFixture(kind = 'retire') {
  const w = fixture(kind); const key = 'npc:lifecycle-canonical'
  const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
  memory.restore({ ...memory.snapshot(), factory_registry_world_id: WORLD, factory_registry: w.registry })
  memory.recordPlan(key, { sender: 'owner', text: 'Preserve the dedicated job while retiring the unneeded installation' }, {
    chatMessage: '', plan: ['Reconcile the authorized physical change'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', confidence: 0.9,
      requirements: [{ id: 'fixture-verification', kind: 'inventory_count', item_name: 'fixture-product', minimum: 1 }] } }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(key, { runtime_validation: { passed: true } })
  const state = memory.planningState(key); const plan = getActivePlan(state); const step = plan.steps[plan.active_step_index]
  Object.assign(w.context, { goal_id: state.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: step.step_id, semantic_step_id: step.semantic_step_id ?? step.step_id })
  Object.assign(w.pending, { goal_id: state.goal.goal_id, plan_id: plan.plan_id, step_id: step.step_id })
  const runtime = memory.createFactoryCellLifecycleRuntime(key, () => clone(w.context))
  const agent = new NpcAgentLoop({ memory, rcon: { command: async () => { throw new Error('No native write in deterministic seam fixture') } },
    stateFile: '/fixture/lifecycle-state.json', traceFile: null, decisionTraceFile: null, npcId: 'lifecycle-canonical',
    completionProtocolVersion: 3, jevCheckpoints: false, provider: () => assert.fail('No inference authorized') })
  agent.active = true; agent.epoch = { actor_id: 24, epoch: 2, session: w.context.session_id, surface_index: 1, force_index: 1 }
  agent.requestInfo = { memoryKey: key }; agent.traceRequest = { id: w.context.request_id, seq: 0 }; agent.turnConversation = agent.agentContext.beginRequest(0)
  const logs = []; const events = []; agent.log = message => logs.push(message); agent.behaviorTrace = { emit: async record => events.push(record) }
  return { ...w, memory, runtime, agent, key, plan, goal: clone(state.goal), logs, events }
}
async function canonicalFilesystem(action, hooks = {}) {
  const original = { mkdir: fsp.mkdir, writeFile: fsp.writeFile, rename: fsp.rename }; const files = new Map(); const writes = []; let renames = 0
  fsp.mkdir = async () => {}
  fsp.writeFile = async (name, text) => { files.set(name, text); writes.push(JSON.parse(text)); await hooks.write?.(writes.length) }
  fsp.rename = async (from, to) => { await hooks.beforeRename?.(++renames); files.set(to, files.get(from)); await hooks.afterRename?.(renames) }
  try { return await action({ files, writes }) } finally { Object.assign(fsp, original) }
}

test('actual canonical facade and shared settlement persist native custody before clearing pending; immutable goal/plan survive', async () => {
  const w = canonicalFixture(); const plan = clone(w.plan)
  await canonicalFilesystem(async io => {
    w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
    assert.ok(w.memory.recordPendingOperation(w.key, w.pending))
    const operation = factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]); assert.ok(operation)
    await claimFactoryLifecycleOperation(w.agent, operation, w.pending)
    assert.equal(io.writes.at(-1).factory_lifecycle.events.at(-1).type, 'claim')
    await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
    assert.deepEqual(w.logs, [])
    assert.equal(w.memory.pendingOperations(w.key).length, 0)
    const receiptSave = io.writes.find(row => row.factory_lifecycle?.events.at(-1)?.type === 'receipt')
    assert.ok(receiptSave)
    const heldOnDisk = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); heldOnDisk.restore(receiptSave)
    assert.equal(heldOnDisk.pendingOperations(w.key).length, 1, 'receipt must be durable with original pending guard')
    assert.equal(heldOnDisk.factoryLifecycleTransactions()[0].claims[0].state, 'verified')
    const evidence = { ...clone(w.evidence), members: [], installation: 'verified', assignment: clone(w.cell.assignment) }
    w.runtime.finish(w.change.transaction_id, evidence); await w.agent.persistState({ strict: true })
    assert.equal(w.memory.getFactoryOperationalRegistry().cells[0].state, 'retired')
    assert.equal(w.memory.getFactoryRegistry().cells[0].members.length, 1, 'birth assignment remains immutable history')
    assert.deepEqual(w.memory.planningState(w.key).goal, w.goal); assert.deepEqual(getActivePlan(w.memory.planningState(w.key)), plan)
    const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restored.restore(JSON.parse(io.files.get(w.agent.stateFile)))
    assert.equal(restored.getFactoryOperationalRegistry().cells[0].state, 'retired')
    assert.equal(restored.factoryLifecycleTransactions()[0].claims.length, 1)
  })
})

function rebindEvidence(w, context) {
  const native = clone(w.status); native.admission_journal[0].tick = 100
  return { ...clone(w.evidence), request_id: context.request_id, actor_epoch: context.actor_epoch, session_id: context.session_id,
    tick: 110, members: [], actor_inventory: clone(w.receipt.actor_after), native_status: native,
    native_owner: { allowed: true, idle: true, actor_kind: 'standalone_character', actor_id: context.actor_id,
      epoch: context.actor_epoch, session: context.session_id, surface_index: 1, force_index: 1 },
    removed_members: [{ ...clone(w.member), state: 'absent', coverage: 'complete' }] }
}

test('fresh canonical host rebind retains job, claims and allowance across request/session/epoch restage', async () => {
  const w = canonicalFixture(); w.change.kind = 'modify'
  w.change.operations.push(clone(fixture('expand').change.operations[0])); w.change.action_limit = 2
  await canonicalFilesystem(async () => {
    w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
    w.memory.recordPendingOperation(w.key, w.pending)
    await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
    await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
    const original = clone(w.memory.factoryLifecycleTransactions()[0]); const snapshot = w.memory.snapshot()
    const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); memory.restore(snapshot)
    const fresh = { ...clone(w.context), request_id: 'fresh-host-request', session_id: 'fresh-host-session', actor_epoch: 3 }
    const runtime = memory.createFactoryCellLifecycleRuntime(w.key, () => fresh)
    const resumed = runtime.rebind(w.change.transaction_id, rebindEvidence(w, fresh))
    assert.deepEqual(resumed.claims, original.claims); assert.equal(resumed.action_limit, original.action_limit)
    assert.deepEqual(resumed.original_owner, original.owner); assert.equal(resumed.owner_history.length, 1)
    assert.equal(resumed.owner.actor_epoch, 3); assert.equal(resumed.next_operation, 1)
    const next = buildPendingOperation({ requestId: fresh.request_id, operationKey: 'fresh-host/add', attemptId: 'fresh-host-attempt', ordinal: 2,
      protocolVersion: 2, actor: { actor_id: 24, epoch: 3, session: fresh.session_id }, surfaceIndex: 1,
      goalId: fresh.goal_id, planId: fresh.plan_id, stepId: fresh.step_id, operations: [w.change.operations[1].operation] })
    throws(() => runtime.claim(w.change.transaction_id, next), 'factory_lifecycle_persistence_required')
    memory.markFactoryLifecyclePersisted(memory.snapshot())
    const old = memory.createFactoryCellLifecycleRuntime(w.key, () => clone(w.context))
    throws(() => old.claim(w.change.transaction_id, w.pending), 'factory_lifecycle_owner_stale')
    runtime.claim(w.change.transaction_id, next); memory.markFactoryLifecyclePersisted(memory.snapshot())
    assert.equal(memory.factoryLifecycleTransactions()[0].claims.length, 2)
    const again = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); again.restore(memory.snapshot())
    assert.equal(again.factoryLifecycleTransactions()[0].claims.length, 2)
    assert.deepEqual(again.planningState(w.key).goal, w.goal); assert.deepEqual(getActivePlan(again.planningState(w.key)), w.plan)
    assert.equal(again.factoryLifecycleTransactions()[0].owner.actor_epoch, 3)
  })
})

test('fresh rebind refuses changed authority, unknown native effects and unproved custody', async () => {
  const w = canonicalFixture()
  await canonicalFilesystem(async () => {
    w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
    w.memory.recordPendingOperation(w.key, w.pending)
    await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
    const pendingSnapshot = w.memory.snapshot()
    await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
    const settled = w.memory.snapshot()
    for (const mode of ['actor', 'world', 'amended_plan', 'operator_pause', 'pending', 'journal_unknown', 'native_busy', 'lost_items', 'absence_unknown']) {
      const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); const snapshot = clone(mode === 'pending' ? pendingSnapshot : settled)
      if (mode === 'amended_plan') getActivePlan(snapshot.planning_states.find(row => row.key === w.key).state).steps[0].description = 'An amended semantic job'
      memory.restore(snapshot)
      const fresh = { ...clone(w.context), request_id: 'fresh-request', session_id: 'fresh-session', actor_epoch: 3 }
      const proof = rebindEvidence(w, fresh)
      if (mode === 'actor') fresh.actor_id++
      if (mode === 'world') fresh.world_id = 'other-world'
      if (mode === 'operator_pause') memory.recordRunPause(w.key, memory.currentPlan(w.key), 'operator stop', { pause_class: 'operator' })
      if (mode === 'journal_unknown') delete proof.native_status.admission_journal
      if (mode === 'native_busy') proof.native_status.queue_length = 1
      if (mode === 'lost_items') proof.actor_inventory = []
      if (mode === 'absence_unknown') proof.removed_members[0].coverage = 'unknown'
      const runtime = memory.createFactoryCellLifecycleRuntime(w.key, () => fresh)
      assert.throws(() => runtime.rebind(w.change.transaction_id, proof), undefined, mode)
      assert.equal(memory.factoryLifecycleTransactions()[0].owner_history.length, 0, mode)
      assert.equal(memory.factoryLifecycleTransactions()[0].claims.length, 1, mode)
    }
  })
})

test('actual shared settlement holds partial native custody and strict persistence failure', async () => {
  for (const mode of ['partial', 'write_failure']) {
    const w = canonicalFixture()
    await canonicalFilesystem(async () => {
      w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
      w.memory.recordPendingOperation(w.key, w.pending)
      await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
      if (mode === 'partial') negativeTerminal(w)
      await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
      assert.equal(w.memory.pendingOperations(w.key).length, 1)
      assert.equal(w.memory.getFactoryOperationalRegistry().cells[0].state, 'degraded')
      if (mode === 'partial') assert.equal(w.memory.factoryLifecycleTransactions()[0].state, 'partial')
      else {
        assert.ok(w.logs.some(line => line.includes('synthetic write failure')))
        await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
        assert.equal(w.memory.pendingOperations(w.key).length, 0, 'repeat settlement flushes the same receipt without reissuing native work')
        assert.equal(w.memory.factoryLifecycleTransactions()[0].claims.length, 1)
      }
    }, { beforeRename: count => { if (mode === 'write_failure' && count === 3) throw new Error('synthetic write failure') } })
  }
})

test('actual expansion then metadata update restores one operational installation and rejects stale physical CAS', async () => {
  const w = canonicalFixture('expand'); const historical = clone(w.memory.getFactoryRegistry())
  await canonicalFilesystem(async io => {
    w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
    w.memory.recordPendingOperation(w.key, w.pending)
    await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
    w.status.receipt_journal[0].task_types = ['placing']; w.status.last_completed_batch.task_types = ['placing']
    w.status.basic_operation = { last_result: { operation_id: 7, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 100,
      actor_id: 24, actor_kind: 'standalone_character', entity_name: 'fixture-machine', placed_unit_number: 28,
      placed_position: { x: 4, y: 3 }, placed_surface_index: 1, placed_force_index: 1, placed_world_id: WORLD,
      placed_batch_id: 4, placed_batch_generation: 1, placed_batch_ref: 'batch-g1-4' } }
    const receipt = deriveFactoryPlacementReceipt(w.status, { world_id: WORLD, actor: { actor_id: 24, epoch: 2 },
      candidates: [{ pending: w.pending, plan_version: w.context.plan_version, semantic_step_id: w.context.semantic_step_id }] })
    w.memory.recordFactoryPlacementReceipt(receipt, w.memory.factoryWorldBinding().generation)
    await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
    assert.equal(w.memory.pendingOperations(w.key).length, 0, JSON.stringify(w.logs))
    let installed = w.memory.getFactoryOperationalRegistry().cells[0]
    w.runtime.finish(w.change.transaction_id, { ...clone(w.evidence), members: installed.members,
      assignment: clone(installed.assignment), installation: 'verified' }); await w.agent.persistState({ strict: true })
    installed = w.memory.getFactoryOperationalRegistry().cells[0]
    const { provenance, ...added } = installed.members.find(row => row.unit_number === 28)
    assert.equal(w.memory.getFactoryMemberAssignment({ world_id: WORLD, ...added }).cell_id, installed.cell_id)
    assert.equal(w.memory.factoryPlacementAvailability({ unit_number: 28, entity_name: added.name }).status, 'assigned')
    const metadata = w.memory.createFactoryRegistryRuntime(w.key, () => clone(w.context))
    const raw = w.memory.getFactoryRegistry().cells[0]
    const change = { transaction_id: 'metadata-after-expansion', cell_id: raw.cell_id, expected_registry_revision: historical.revision,
      expected_lifecycle_revision: w.memory.factoryLifecycleRevision(), expected_cells: [{ cell_id: raw.cell_id, revision: raw.revision,
        digest: factoryCellMetadataHead(raw), physical_revision: installed.physical_revision }], input_ports: [], dependencies: [],
      port_bindings: [{ port_id: 'out', member: added, endpoint: { kind: 'inventory', inventory_index: 1 }, state: 'unverified', evidence_refs: ['fixture-exact-added-endpoint'] }] }
    const oldLifecycle = clone(change); oldLifecycle.expected_lifecycle_revision--
    throws(() => metadata.prepareMetadata(oldLifecycle, metadata.scope()), 'factory_lifecycle_revision_stale')
    const oldPhysical = clone(change); oldPhysical.expected_cells[0].physical_revision = 0
    throws(() => metadata.prepareMetadata(oldPhysical, metadata.scope()), 'factory_cell_physical_revision_stale')
    const { ticket } = metadata.prepareMetadata(change, metadata.scope())
    await w.agent.persistState({ strict: true, requiredFactoryMetadata: { ticket, phase: 'prepare' } })
    await w.agent.persistState({ strict: true, requiredFactoryMetadata: { ticket, phase: 'commit' } })
    w.memory.finishFactoryMetadata(ticket); await w.agent.persistState({ strict: true })
    const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restored.restore(JSON.parse(io.files.get(w.agent.stateFile)))
    const projected = restored.getFactoryOperationalRegistry().cells[0]
    assert.equal(projected.members.length, 2); assert.equal(projected.revision, 2); assert.equal(projected.physical_revision, 1)
    assert.equal(projected.port_bindings[0].member.unit_number, 28)
    assert.deepEqual(restored.getFactoryRegistry().cells[0].members, historical.cells[0].members)
    assert.equal(restored.getFactoryMemberAssignment({ world_id: WORLD, ...added }).cell_id, raw.cell_id)
    assert.equal(restored.checkOperationAdmission(w.key, { operations: [{ name: 'mine_entity_exact', args: { unit_number: 28 } }],
      actor: w.agent.epoch }, { requestId: w.context.request_id }).code, 'factory_cell_change_forbidden')
    const staleChange = clone(w.change); staleChange.transaction_id = 'stale-physical-again'
    throws(() => restored.createFactoryCellLifecycleRuntime(w.key, () => clone(w.context)).begin(staleChange, w.evidence), 'factory_lifecycle_revision_stale')
  })
})

test('uncorrelated partial terminal records stay held through real settlement, residual reconciliation and claim', async () => {
  for (const mutate of [w => { w.status.admission_journal[0].signature = 'wrong' },
    w => { w.status.admission_journal[0].generation++ }, w => { w.status.batch_generation++ },
    w => { w.status.admission_journal = [] }, w => { w.status.receipt_journal = [] },
    w => { w.status.receipt_journal[0].tick++ }, w => { w.status.admission_journal[0].slots[0].batch_refs[0].batch_id++ }]) {
    const w = canonicalFixture(); w.change.action_limit = 2
    await canonicalFilesystem(async () => {
      w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true }); w.memory.recordPendingOperation(w.key, w.pending)
      await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
      negativeTerminal(w)
      w.receipt.recovered_items = [item('fixture-stock')]; w.receipt.actor_after = [item('fixture-held', 2), item('fixture-stock')]
      w.receipt.after = clone(w.receipt.before); w.receipt.after.contents = [item('fixture-stock', 2)]; w.receipt.after.inventories[0].items = [item('fixture-stock', 2)]
      w.status.basic_operation = { last_result: { entity_removal: clone(w.receipt) } }
      assert.equal(verifyFactoryResidualCustody(w.receipt), true)
      mutate(w); await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
      assert.equal(w.memory.pendingOperations(w.key).length, 1, mutate.toString())
      assert.equal(w.memory.factoryLifecycleTransactions()[0].state, 'uncertain', mutate.toString())
      const evidence = { ...clone(w.evidence), tick: 100, actor_inventory: clone(w.receipt.actor_after) }
      evidence.members[0].removal_snapshot = clone(w.receipt.after)
      throws(() => w.runtime.reconcileResidual(w.change.transaction_id, evidence), 'factory_lifecycle_residual_unknown')
      throws(() => w.runtime.claim(w.change.transaction_id, { ...w.pending, operation_key: 'retry', attempt_id: 'retry' }), 'factory_lifecycle_claim_forbidden')
    })
  }
})

test('residual verifier rejects contradictory before and after native inventory and fluid domains', () => {
  const w = fixture(); negativeTerminal(w)
  w.receipt.recovered_items = [item('fixture-stock')]; w.receipt.actor_after = [item('fixture-held', 2), item('fixture-stock')]
  w.receipt.after = clone(w.receipt.before); w.receipt.after.contents = [item('fixture-stock', 2)]; w.receipt.after.inventories[0].items = [item('fixture-stock', 2)]
  assert.equal(verifyFactoryResidualCustody(w.receipt), true)
  for (const mutate of [r => { r.before.inventories[0].items[0].count++ }, r => { r.before.inventories.push(clone(r.before.inventories[0])) },
    r => { r.after.inventories.push(clone(r.after.inventories[0])) }, r => { r.before.fluidboxes = -1 }, r => { r.after.fluidboxes = 33 },
    r => { r.before.inventories[0].size = 513 }, r => { delete r.after.fluids_empty }, r => { r.before.inventories[0].index = 0 }]) {
    const bad = clone(w.receipt); mutate(bad); assert.equal(verifyFactoryResidualCustody(bad), false, mutate.toString())
  }
})

function temporaryIntent(w) {
  const op = w.change.operations[0]
  return { intent_id: 'temporary-new-placement', classification: 'temporary', purpose: 'Temporary setup for the committed step',
    retirement_condition: 'beneficiaries_complete_and_redundant', placement_intent_digest: operationIdentity(op.operation),
    placement: { name: op.name, position: clone(op.position), surface_index: 1, force_index: 1, operation: clone(op.operation) },
    beneficiaries: [{ goal_id: w.context.goal_id, semantic_step_id: w.context.semantic_step_id }] }
}
function temporaryPlacementReceipt(w) {
  w.status.receipt_journal[0].task_types = ['placing']; w.status.last_completed_batch.task_types = ['placing']
  w.status.basic_operation = { last_result: { operation_id: 7, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 100,
    actor_id: 24, actor_kind: 'standalone_character', entity_name: 'fixture-machine', placed_unit_number: 28,
    placed_position: { x: 4, y: 3 }, placed_surface_index: 1, placed_force_index: 1, placed_world_id: WORLD,
    placed_batch_id: 4, placed_batch_generation: 1, placed_batch_ref: 'batch-g1-4' } }
  return deriveFactoryPlacementReceipt(w.status, { world_id: WORLD, actor: { actor_id: 24, epoch: 2 },
    candidates: [{ pending: w.pending, plan_version: w.context.plan_version, semantic_step_id: w.context.semantic_step_id }] })
}

test('actual facade binds temporary classification before placement and only accepts its canonical qualified receipt', async () => {
  for (const [label, mutate] of [['positive', () => {}], ['unretained', () => {}],
    ['step', r => { r.step_id = 'different-step'; r.semantic_step_id = 'different-semantic-step' }],
    ['prototype', r => { r.name = 'different-machine' }], ['position', r => { r.position.x++ }],
    ['surface', r => { r.surface_index++ }], ['force', r => { r.force_index++ }],
    ['operation', r => { r.operation_key = 'different-operation' }], ['request', r => { r.request_id = 'different-request' }]]) {
    const w = canonicalFixture('expand'); const intent = temporaryIntent(w)
    await canonicalFilesystem(async () => {
      w.runtime.declareTemporary(intent); await w.agent.persistState({ strict: true })
      w.runtime.bindTemporaryPlacement(intent.intent_id, w.pending); await w.agent.persistState({ strict: true })
      const receipt = temporaryPlacementReceipt(w); assert.ok(receipt); mutate(receipt)
      if (label !== 'unretained') w.memory.recordFactoryPlacementReceipt(receipt, w.memory.factoryWorldBinding().generation)
      if (label === 'positive') {
        w.runtime.temporary(intent.intent_id, receipt); await w.agent.persistState({ strict: true })
        const snapshot = w.memory.snapshot(); assert.equal(snapshot.factory_lifecycle.events.at(-1).type, 'temporary')
        assert.equal(snapshot.factory_lifecycle.events.at(-1).payload.unit_number, 28)
      } else throws(() => w.runtime.temporary(intent.intent_id, receipt), 'factory_temporary_authority_unknown')
      assert.deepEqual(w.memory.getFactoryRegistry().cells[0].members, w.registry.cells[0].members, 'permanent existing cell unaffected')
    })
  }
  const w = canonicalFixture('expand'); const intent = temporaryIntent(w); const old = temporaryPlacementReceipt(w)
  w.memory.recordFactoryPlacementReceipt(old, w.memory.factoryWorldBinding().generation)
  await canonicalFilesystem(async () => {
    w.runtime.declareTemporary(intent); await w.agent.persistState({ strict: true })
    throws(() => w.runtime.bindTemporaryPlacement(intent.intent_id, w.pending), 'factory_temporary_placement_already_applied')
    throws(() => w.runtime.temporary(intent.intent_id, old), 'factory_temporary_authority_unknown')
  })
})

test('qualified temporary support enrollment restores without inventing products and cannot adopt a permanent asset', async () => {
  const w = canonicalFixture('expand'); const intent = temporaryIntent(w); const receipt = temporaryPlacementReceipt(w)
  await canonicalFilesystem(async () => {
    w.runtime.declareTemporary(intent); await w.agent.persistState({ strict: true })
    w.runtime.bindTemporaryPlacement(intent.intent_id, w.pending); await w.agent.persistState({ strict: true })
    w.memory.recordFactoryPlacementReceipt(receipt, w.memory.factoryWorldBinding().generation)
    w.runtime.temporary(intent.intent_id, receipt); await w.agent.persistState({ strict: true })
    w.memory.recordNpcPlacement(w.key, { unit_number: receipt.unit_number, entity_name: receipt.name, actor_id: receipt.actor_id, actor_epoch: receipt.actor_epoch })
    const registry = w.memory.createFactoryRegistryRuntime(w.key, () => clone(w.context)); const scope = registry.scope()
    const member = registry.recordPlacement({ unit_number: receipt.unit_number, name: receipt.name, position: receipt.position,
      surface_index: 1, force_index: 1, provenance: { receipt_id: receipt.receipt_id } }, scope)
    const declaration = { surface_index: 1, force_index: 1, assignment: { products: [], purpose: intent.purpose, method: 'receipt_backed_temporary_support' },
      members: [member], ports: [], origin: registry.origin(), support: { kind: 'temporary', intent_id: intent.intent_id, receipt_id: receipt.receipt_id } }
    assert.throws(() => registry.registerCell({ ...clone(declaration), support: { ...declaration.support, intent_id: 'unretained' } }, scope))
    const cell = registry.registerCell(declaration, scope); await w.agent.persistState({ strict: true })
    assert.deepEqual(cell.assignment.products, []); assert.equal(cell.support.intent_id, intent.intent_id)
    const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restored.restore(w.memory.snapshot())
    assert.equal(restored.factoryRegistryStatus().status, 'initialized')
    assert.deepEqual(restored.getFactoryOperationalRegistry().cells.find(row => row.cell_id === cell.cell_id), cell)
    assert.equal(restored.factoryTemporaryAssets()[0].beneficiaries_complete, false)
    const lifecycle = restored.createFactoryCellLifecycleRuntime(w.key, () => clone(w.context))
    const eligible = lifecycle.scheduleCleanup([{ goal_id: w.context.goal_id, semantic_step_id: w.context.semantic_step_id,
      status: 'completed', verified: true, receipt_id: 'actual-host-checkpoint-fixture' }])
    assert.equal(eligible.length, 1); restored.markFactoryLifecyclePersisted(restored.snapshot())
    assert.equal(restored.factoryTemporaryAssets()[0].beneficiaries_complete, true)
    const forged = w.memory.snapshot(); forged.factory_lifecycle.events = forged.factory_lifecycle.events.filter(event => event.type !== 'temporary')
    const bad = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); bad.restore(forged)
    assert.equal(bad.factoryRegistryStatus().status, 'fault')
    assert.deepEqual(w.memory.getFactoryRegistry().cells[0].members, w.registry.cells[0].members)
  })
})

test('actual exact-pending readonly controller reconciles partial contents and closes only that durable partial ledger', async () => {
  const w = canonicalFixture(); w.change.kind = 'modify'; w.change.action_limit = 2
  Object.assign(w.agent.epoch, { mode: 'npc', actor_kind: 'standalone_character' })
  negativeTerminal(w); w.receipt.after = clone(w.receipt.before)
  w.receipt.after.contents = [item('fixture-stock', 1)]; w.receipt.after.inventories[0].items = [item('fixture-stock', 1)]
  w.receipt.actor_after = [item('fixture-held', 2), item('fixture-stock', 2)]; w.receipt.recovered_items = [item('fixture-stock', 2)]
  w.status.admission_journal[0].tick = 100
  const calls = []
  w.agent.rcon.command = async text => {
    calls.push(text)
    if (text.includes('"sgluna_deployment","status"')) return JSON.stringify({ revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc',
      session: w.context.session_id, actor_id: 24, actor_kind: 'standalone_character', epoch: 2, allowed: true, idle: true,
      actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 })
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: 24, valid: true }, surface_index: 1, force_index: 1 })
    if (text.includes('"autorio_operations","status"')) return JSON.stringify(w.status)
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: true, world_id: WORLD })
    if (text.includes("'sgluna_factory','observe'")) {
      const body = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1])
      return JSON.stringify({ ...body, ok: true, tick: 110, members: body.members.map(locator => ({ locator, ...locator, type: 'container', state: 'observed',
        endpoint_facts: { schema_version: 1, fluidboxes: { state: 'known', truncated: false, endpoints: [] }, services: {
          electricity: { state: 'not_applicable' }, electric_network: { state: 'known', present: false },
          heat: { state: 'not_applicable', input_source: { state: 'known', present: false }, buffer: { state: 'known', present: false } } } },
        recipe: { state: 'known', truncated: false, ingredients: [], products: [{ name: 'fixture-product', type: 'item' }] },
        consumer_facts: { schema_version: 1, tick: 110, identity_scope: 'enclosing_exact_member', scope: 'direct_native_item_consumers',
          state: 'known', coverage: 'complete', truncated: false, unresolved: false, consumers: [] },
        removal_readiness: { schema_version: 1, scope: 'exact_building_only', tick: 110, state: 'known', recovery_capacity: 'verified',
          snapshot: clone(w.receipt.after), actor_inventory: clone(w.receipt.actor_after) } })) })
    }
    throw new Error(`Unexpected native fixture command: ${text}`)
  }
  await canonicalFilesystem(async () => {
    w.runtime.begin(w.change, w.evidence); await w.agent.persistState({ strict: true })
    w.memory.recordPendingOperation(w.key, w.pending)
    await claimFactoryLifecycleOperation(w.agent, factoryLifecycleOperation(w.agent, [w.change.operations[0].operation]), w.pending)
    await w.agent.settleOutstandingOperation(w.status, w.pending.operation_key)
    assert.equal(w.memory.pendingOperations(w.key).length, 1)
    w.status.admission_journal[0].signature = 'wrong-native-signature'
    await assert.rejects(reconcileFactoryLifecycleResidual(w.agent, w.change.transaction_id))
    assert.equal(w.memory.pendingOperations(w.key).length, 1)
    assert.equal(w.memory.factoryLifecycleTransactions()[0].claims[0].state, 'partial')
    w.status.admission_journal[0].signature = w.pending.signature
    const result = await reconcileFactoryLifecycleResidual(w.agent, w.change.transaction_id)
    assert.equal(result.reconciled, true); assert.equal(w.memory.pendingOperations(w.key).length, 0)
    const tx = w.memory.factoryLifecycleTransactions()[0]
    assert.equal(tx.claims.length, 1); assert.equal(tx.claims[0].state, 'residual_reconciled'); assert.equal(tx.action_limit, 2)
    assert.equal(tx.next_operation, 0); assert.equal(tx.state, 'degraded')
    assert.equal(calls.some(text => text.includes('autorio_operation_admission')), false, 'reconciliation issues no world operation')
  })
})
