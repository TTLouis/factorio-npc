import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { activeStepVerifiedOperationNames, getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { ACTOR_ID, EPOCH, FurnaceFactorio, FURNACE_UNIT, KEY, recoverySession, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'
import { inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Synthetic two-step scenario, not a rewrite of AS/AU's historical plans. Only
// the game and provider edges are scripted; completion, continuation, admission
// and Session callbacks use their unmodified production implementations.
const STEPS = ['Collect ten copper plates from the recorded furnace', 'Gather three coal for the next task']
const receipt = operation_name => ({ kind: 'authoritative_operation_receipt', operation_name })
const PLATES = { mode: 'all', requirements: [...inventoryCheckpoint('copper-plate', 10).requirements, receipt('move_items_exact')] }
const COAL = { mode: 'all', requirements: [...inventoryCheckpoint('coal', 3).requirements, receipt('gather_resource')] }
const collect = count => ({ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: FURNACE_UNIT, max_count: count, to_entity: false } })
const gatherCoal = { name: 'gather_resource', args: { resource_name: 'coal', count: 3 } }

function initialMemory() {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, { sender: 'tester', text: 'Collect ten copper plates, then gather three coal' }, {
    chatMessage: '', plan: STEPS, currentStep: 0, operations: [],
    stepCompletions: [PLATES, COAL].map(checkpoint => ({ kind: 'deterministic', checkpoint })),
  }, { validatedPlannerAdmission: true })
  memory.defineGoal(KEY, { scope: 'finite', summary: 'Hold ten copper plates and three coal', doneWhen: [
    ...inventoryCheckpoint('copper-plate', 10).requirements, ...inventoryCheckpoint('coal', 3).requirements,
  ] })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  assert.equal(getActivePlan(memory.planningState(KEY))?.status, PLAN_STATUS.COMMITTED)
  memory.recordNpcPlacement(KEY, { unit_number: FURNACE_UNIT, entity_name: 'stone-furnace', actor_id: ACTOR_ID, actor_epoch: EPOCH })
  memory.recordLocators(KEY, memory.currentPlan(KEY), { exactTargetAudit: [{ unit_number: FURNACE_UNIT, operation_name: 'move_items_exact',
    locator: { name: 'stone-furnace', type: 'furnace', position: { x: 3, y: 3 } } }] })
  return memory
}

function world({ memory = initialMemory(), game, model = new ScriptedModel(), stateFile = null } = {}) {
  if (!game) {
    game = new FurnaceFactorio({ inventory: { 'copper-plate': 6 }, furnace: { source: { 'copper-ore': 10 }, fuel: { coal: 1 } } })
    game.status.surface_index = 1
    assert.equal(game.smelt(10), 10, 'declared fixture ore/fuel, not inventory fabrication, produces furnace output')
    const native = game.command.bind(game)
    game.command = async text => {
      if (text.includes('"autorio_actor","status"')) return JSON.stringify({ actor: { actor_id: game.status.actor_id }, surface_index: game.status.surface_index, force_index: 1 })
      if (text.includes('"autorio_crafting","status"')) return JSON.stringify({ task_active: false, native_queue: [] })
      if (text.includes('"get_entity_status"')) return JSON.stringify({ ...game.entityRead(), actor_id: game.status.actor_id,
        surface_index: game.status.surface_index, force_index: 1, observed_tick: game.gameTick,
        entity: { ...game.entityRead().entity, position: game.furnace.position, force: 'player' } })
      return native(text)
    }
  }
  const events = []; const agentLogs = []
  const agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'sgluna', completionProtocolVersion: 3,
    stateFile, traceFile: null, decisionTraceFile: null, log: line => agentLogs.push(String(line)),
    provider: (messages, context) => model.provide(messages, context) })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: KEY,
    requestInfo: { memoryKey: KEY, turnId: 1, sender: 'tester', text: 'Collect ten copper plates, then gather three coal' },
    traceRequest: { id: 'identity-completion-request', usage: {} } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => { events.push(row) } }
  agent.messages = []; agent.baseMessages = []
  const held = () => getActivePlan(memory.planningState(KEY))
  const act = operations => planReply({ stepId: held().steps[held().active_step_index].step_id, operations })
  const w = { memory, game, model, agent, events, agentLogs, held, act }
  return { ...w, ...recoverySession(w) }
}

async function startRecovery(w) {
  // Seed an ordinary live binding, then lose it AFTER parsing, immediately
  // before admission. The old ten-plate proposal must not be blindly replayed:
  // fresh stock proves only four plates are missing.
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify({ ...w.game.entityRead(), surface_index: 1,
    entity: { ...w.game.entityRead().entity, position: w.game.furnace.position } }))
  const commit = w.agent.commitPlan.bind(w.agent)
  let injected = false
  w.agent.commitPlan = plan => {
    if (!injected && plan.operations?.some(op => op.name === 'move_items_exact')) {
      injected = true
      w.agent.liveEntityObservations.clear()
    }
    return commit(plan)
  }
  w.model.push('executor', 'original collection proposal', () => w.act([collect(10)]))
  await w.session.queueEvent(() => w.agent.runTurn(), { reportError: true })
  await settle(w.session)
  assert.equal(injected, true, JSON.stringify({ logs: w.logs, calls: w.model.labels, events: w.events.slice(-15) }))
  assert.deepEqual(w.game.sent.map(batch => batch.operations), [[collect(4)]], JSON.stringify(w.logs))
  assert.equal(w.game.inventory['copper-plate'], 6, 'admission alone moves no items')
  assert.equal(w.held().active_step_index, 0)
  assert.ok(w.events.some(row => row.event === 'entity.refresh_detected' && row.data.source === 'admission_residual'))
  const bound = w.events.find(row => row.event === 'entity.refresh_bound')
  assert.equal(bound?.request_id, 'identity-completion-request')
  assert.equal(bound?.actor_id, ACTOR_ID)
  assert.equal(bound?.epoch, EPOCH)
  assert.equal(bound?.data.unit_number, FURNACE_UNIT)
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
}

async function report(w) {
  w.session.lastCompletionAt = 0
  w.session.onGameLine('[AUTORIO] All operations completed')
  await settle(w.session)
}

function assertBoundary(w) {
  assert.deepEqual(w.model.violations, [])
  assert.deepEqual(w.model.remaining, [])
  assert.deepEqual(w.game.unknown, [])
  assert.deepEqual([...w.logs, ...w.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed|\[reconcile\] settle failed/.test(line)), [])
}

function assertNextStep(w, original, pending) {
  assert.equal(w.game.inventory['copper-plate'], 10)
  assert.equal(w.game.furnace.output['copper-plate'], 6)
  const plan = w.held()
  assert.equal(plan.active_step_index, 1, JSON.stringify({ logs: w.logs, receipts: plan.execution.receipts, events: w.events }))
  assert.equal(plan.plan_id, original.plan_id)
  assert.equal(plan.plan_version, original.plan_version)
  assert.deepEqual(plan.steps, original.steps, 'no contract, description or step identity changed')
  assert.equal(plan.execution.step_progress[original.steps[0].step_id].status, 'completed')
  const verified = plan.execution.receipts[original.steps[0].step_id].filter(row => row.kind === 'deterministic_verification')
  assert.ok(verified.some(row => row.source === 'runtime' && row.verified_operation_names?.includes('move_items_exact')), JSON.stringify(verified))
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [], 'the next step cannot borrow the previous step receipt')
  assert.deepEqual(w.game.sent.map(batch => batch.operations), [[collect(4)], [gatherCoal]])
  assert.equal(w.memory.pendingOperations(KEY).some(row => row.operation_key === pending.operation_key), false)
  const next = w.memory.pendingOperation(KEY)
  assert.equal(next.step_id, original.steps[1].step_id)
  assert.notEqual(next.operation_key, pending.operation_key)
  assert.ok(w.agent.batchInFlight, 'ordinary continuation owns the next native batch')
  const evidence = w.memory.currentPlan(KEY).task_board.evidence.filter(row => row.kind === 'operation_receipt')
  assert.ok(evidence.some(row => row.ref === w.game.receipts[0].batch_ref), JSON.stringify(evidence))
  assertBoundary(w)
}

for (const lostAck of [false, true]) test(`identity recovery closes the unchanged checkpoint and admits the next step (lost ack=${lostAck})`, async () => {
  const w = world()
  const original = structuredClone(w.held())
  w.game.dropAckOnce = lostAck
  await startRecovery(w)
  const pending = structuredClone(w.memory.pendingOperation(KEY))
  assert.equal(pending.request_id, 'identity-completion-request')
  assert.equal(pending.plan_id, original.plan_id)
  assert.equal(pending.step_id, original.steps[0].step_id)
  assert.deepEqual(pending.actor, { actor_id: ACTOR_ID, epoch: EPOCH })
  if (lostAck) {
    const reconciled = w.events.find(row => row.event === 'operation.reconciled').data
    assert.deepEqual([reconciled.trigger, reconciled.verdict, reconciled.effect], ['lost_acknowledgement', 'admitted_in_flight', 'in_flight'])
    assert.equal(reconciled.operation_key, pending.operation_key)
  }
  w.model.push('executor', 'next committed step', () => w.act([gatherCoal]))
  w.game.completeBatch()
  await report(w)
  assertNextStep(w, original, pending)
  // A duplicate old console notification is not a receipt for the next batch.
  await report(w)
  assert.equal(w.game.sent.length, 2)
  assert.equal(w.held().active_step_index, 1)
  w.game.completeBatch()
  await report(w)
  assert.equal(w.game.inventory.coal, 3)
  assert.equal(w.events.filter(row => row.event === 'goal.evaluated').at(-1)?.data.satisfied, true)
  assert.equal(w.memory.currentPlan(KEY), undefined, 'verified finite goal is retired')
  assert.equal(w.memory.pendingOperation(KEY), null)
  assert.equal(w.game.sent.length, 2)
  assertBoundary(w)
})

async function stateFile(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'identity-completion-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'state.json')
}

async function restart(t, first, file, model) {
  first.session.stopping = true
  first.session.clearAutoResume()
  const w = world({ memory: new CanonicalTaskBoardMemory(), game: first.game, stateFile: file, model })
  t.after(() => { w.session.stopping = true; w.session.clearAutoResume() })
  await w.agent.loadPersistentState()
  assert.equal(w.agent.liveEntityObservations.size, 0, 'live identity bindings do not survive a process restart')
  assert.deepEqual([...w.memory.controllerRecoveries], [...first.memory.controllerRecoveries])
  assert.deepEqual([...w.memory.entityRefreshClaims], [...first.memory.entityRefreshClaims])
  w.session.queueStartupRecovery(w.session.currentPlanState())
  await settle(w.session)
  return w
}

// Native reconcile_startup restores last_completed_batch from its persisted
// journal (task_manager.ts). The base fake intentionally drops it; restore that
// field here for native-shaped reloads, and name journal-only visibility as a
// separate fault injection. Never reconstruct evidence or step progress.
function reloadGame(game, { journalOnly = false } = {}) {
  game.reloadMod()
  if (!journalOnly) game.lastCompleted = game.receipts.filter(row => row.state === 'completed').at(-1)
}

for (const mode of ['process', 'process_and_mod', 'journal_only']) for (const lostAck of [false, true]) test(`identity recovery completion survives ${mode} restart without replay (lost ack=${lostAck})`, async t => {
  const file = await stateFile(t)
  const first = world({ stateFile: file })
  const original = structuredClone(first.held())
  first.game.dropAckOnce = lostAck
  await startRecovery(first)
  const pending = structuredClone(first.memory.pendingOperation(KEY))
  first.game.completeBatch() // Neither the old process nor Session receives completion.
  if (mode !== 'process') reloadGame(first.game, { journalOnly: mode === 'journal_only' })
  const model = new ScriptedModel().push('executor', 'next committed step after restart', planReply({ stepId: original.steps[1].step_id, operations: [gatherCoal] }))
  const w = await restart(t, first, file, model)
  const settled = w.events.find(row => row.event === 'operation.recovery_settled')?.data
  assert.equal(settled?.operation_key, pending.operation_key, JSON.stringify({ events: w.events, logs: w.logs }))
  assert.equal(settled.reason, 'restart_exact_completed_receipt')
  assertNextStep(w, original, pending)
  assert.equal(w.memory.planningState(KEY).goal.goal_id, first.memory.planningState(KEY).goal.goal_id)
})

for (const change of ['reload', 'actor', 'epoch']) test(`identity recovery pending collection is held across ${change}, never completed or replayed`, async t => {
  const file = await stateFile(t)
  const first = world({ stateFile: file })
  const original = structuredClone(first.held())
  first.game.dropAckOnce = true
  await startRecovery(first)
  const pending = structuredClone(first.memory.pendingOperation(KEY))
  reloadGame(first.game) // No completion receipt: the queued effect is unknown.
  if (change === 'actor') first.game.status.actor_id++
  if (change === 'epoch') first.game.status.epoch++
  const model = new ScriptedModel() // The uncertainty fence must stop before inference.
  const w = await restart(t, first, file, model)
  const reconciled = w.events.find(row => row.event === 'operation.reconciled')?.data
  assert.equal(reconciled?.verdict, change === 'reload' ? 'generation_changed' : 'stale_actor', JSON.stringify(w.events))
  assert.equal(w.game.inventory['copper-plate'], 6)
  assert.deepEqual(w.game.sent.map(batch => batch.operations), [[collect(4)]])
  assert.equal(w.held().active_step_index, 0)
  assert.deepEqual(w.held().steps, original.steps)
  assert.equal(w.memory.pendingOperation(KEY).operation_key, pending.operation_key)
  assert.equal(w.memory.pendingOperation(KEY).state, 'unreconciled')
  assert.equal(w.memory.pendingOperation(KEY).effect, change === 'reload' ? 'partial_unknown' : 'unknown')
  if (change !== 'reload') assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  assert.equal(model.calls.length, 0)
  assert.equal(w.session.modelResume, null)
  assertBoundary(w)
})

for (const mismatch of ['missing_receipt', 'signature', 'attempt', 'ordinal', 'operation_key', 'generation', 'batch_ref']) test(`identity recovery cannot close from stock alone when restart proof has ${mismatch}`, async t => {
  const file = await stateFile(t)
  const first = world({ stateFile: file })
  const original = structuredClone(first.held())
  await startRecovery(first)
  first.game.completeBatch()
  reloadGame(first.game)
  const native = first.game.command.bind(first.game)
  first.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('remote.call("autorio_operations","status")')) return raw
    const status = JSON.parse(raw)
    const admission = status.admission_journal[0]
    if (mismatch === 'missing_receipt') status.receipt_journal = []
    if (mismatch === 'signature') admission.signature = 'wrong-signature'
    if (mismatch === 'attempt') admission.attempt_id = 'other-attempt'
    if (mismatch === 'ordinal') admission.ordinal++
    if (mismatch === 'operation_key') admission.operation_key = 'other-request/batch_1'
    if (mismatch === 'generation') status.receipt_journal[0].batch_generation++
    if (mismatch === 'batch_ref') status.receipt_journal[0].batch_ref = 'batch-g999-1'
    return JSON.stringify(status)
  }
  const model = new ScriptedModel() // No proposal is solicited over unresolved native work.
  const w = await restart(t, first, file, model)
  assert.equal(w.game.inventory['copper-plate'], 10, 'the world condition alone is satisfied')
  assert.equal(w.game.sent.length, 1, 'neither replay nor next-step admission is authorized by inventory alone')
  assert.equal(w.held().active_step_index, 0)
  assert.deepEqual(w.held().steps, original.steps)
  assert.ok(w.memory.pendingOperation(KEY))
  assert.equal(w.memory.pendingOperation(KEY).state, 'unreconciled')
  assert.equal(model.calls.length, 0)
  assert.equal(w.session.modelResume, null)
  assert.equal(w.events.some(row => row.event === 'operation.recovery_settled'), false)
  assertBoundary(w)
})

test('exact restart ingestion persists per-step verified proof before releasing the pending identity', async t => {
  const file = await stateFile(t)
  const w = world({ stateFile: file })
  await startRecovery(w)
  w.game.completeBatch()
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), ['move_items_exact'], JSON.stringify(w.held().execution.receipts))
  const restored = world({ stateFile: file, game: w.game, memory: new CanonicalTaskBoardMemory() })
  await restored.agent.loadPersistentState()
  assert.deepEqual(activeStepVerifiedOperationNames(restored.memory.planningState(KEY)), ['move_items_exact'], JSON.stringify(restored.held().execution.receipts))
  assert.equal(restored.memory.pendingOperation(KEY), null)
})

async function completedWorld(t) {
  const w = world({ stateFile: await stateFile(t) })
  await startRecovery(w)
  w.game.completeBatch()
  return w
}

for (const fault of ['missing_result', 'wrong_actor', 'wrong_tick', 'wrong_target', 'wrong_direction', 'zero_moved', 'intent']) {
  test(`restart cannot mint transfer verification from ${fault}`, async t => {
    const w = await completedWorld(t)
    if (fault === 'missing_result') w.game.lastBasicResult = undefined
    if (fault === 'wrong_actor') w.game.lastBasicResult.actor_id++
    if (fault === 'wrong_tick') w.game.lastBasicResult.tick++
    if (fault === 'wrong_target') w.game.lastBasicResult.target_unit_number++
    if (fault === 'wrong_direction') w.game.lastBasicResult.to_entity = true
    if (fault === 'zero_moved') w.game.lastBasicResult.moved_count = 0
    if (fault === 'intent') w.memory.currentPlan(KEY).last_operations = [`move_items_exact ${JSON.stringify(collect(5).args)}`]
    await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
    assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [])
    assert.equal((await w.agent.settleIdleStepCheckpoint()).closed, false)
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.game.sent.length, 1)
    assert.equal(w.model.calls.length, 1, 'only the original proposal called the model')
  })
}

for (const boundary of ['status_read', 'reconciled_trace', 'evidence_persist', 'evidence_trace']) {
  test(`restart receipt ownership is fenced during ${boundary}`, async t => {
    const w = await completedWorld(t)
    const pending = structuredClone(w.memory.pendingOperation(KEY))
    const replace = () => { w.agent.traceRequest = { id: 'replacement-request', usage: {} } }
    if (boundary === 'status_read') {
      const read = w.agent.readTaskStatusRaw.bind(w.agent)
      w.agent.readTaskStatusRaw = async () => { const raw = await read(); replace(); return raw }
    }
    if (boundary.endsWith('trace')) {
      const emit = w.agent.behaviorTrace.emit
      w.agent.behaviorTrace.emit = async row => {
        await emit(row)
        if (row.event === (boundary === 'reconciled_trace' ? 'operation.reconciled' : 'operation.completed_receipt_ingested')) replace()
      }
    }
    if (boundary === 'evidence_persist') {
      const persist = w.agent.persistState.bind(w.agent)
      w.agent.persistState = async options => { await persist(options); if (options?.strict) replace() }
    }
    await assert.rejects(w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' }), error => error.code === 'stale_handoff_reply')
    assert.equal(w.memory.pendingOperation(KEY).operation_key, pending.operation_key)
    assert.equal(w.agent.traceRequest.id, 'replacement-request')
    assert.equal(w.game.sent.length, 1)
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.events.some(row => row.event === 'operation.recovery_settled'), false)
    if (['status_read', 'reconciled_trace'].includes(boundary)) assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [])
  })
}

test('native busy work defers completed receipt ingestion and keeps its guard', async t => {
  const w = await completedWorld(t)
  w.game.taskState = 'placing'
  w.game.queueLength = 1
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.ok(w.memory.pendingOperation(KEY))
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [])
  assert.equal(w.events.some(row => row.event === 'operation.recovery_settled'), false)
  assert.equal(w.game.sent.length, 1)
})

test('evidence persistence failure retains the exact guard and repeated recovery is idempotent', async t => {
  const w = await completedWorld(t)
  const persist = w.agent.persistState.bind(w.agent)
  w.agent.persistState = async options => {
    if (options?.strict) throw new Error('injected evidence disk failure')
    await persist(options)
  }
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.ok(w.memory.pendingOperation(KEY))
  assert.equal(w.events.some(row => row.event === 'operation.recovery_settled'), false)
  w.agent.persistState = persist
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  const receipts = structuredClone(w.held().execution.receipts)
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  await w.agent.taskStatusReceipt()
  await w.agent.taskStatusReceipt()
  assert.deepEqual(w.held().execution.receipts, receipts)
  assert.equal(w.memory.pendingOperation(KEY), null)
  assert.equal(w.game.sent.length, 1)
})

test('historical completion does not substitute for insufficient fresh inventory', async t => {
  const w = await completedWorld(t)
  w.game.inventory['copper-plate'] = 9
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), ['move_items_exact'])
  assert.equal((await w.agent.settleIdleStepCheckpoint()).closed, false)
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.sent.length, 1)
})

for (const owner of ['goal', 'plan', 'step']) test(`completed historical work cannot mint proof for a superseded ${owner}`, async t => {
  const w = await completedWorld(t)
  if (owner === 'goal') w.memory.planningState(KEY).goal.goal_id = 'replacement-goal'
  if (owner === 'plan') w.held().plan_id = 'replacement-plan'
  if (owner === 'step') w.held().active_step_index = 1
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [])
  assert.equal(w.events.find(row => row.event === 'operation.completed_receipt_ingested')?.data.recorded, false)
  assert.equal(w.game.sent.length, 1)
})

for (const stock of [0, 10]) test(`sealed old-actor completion is historical proof, not replacement-actor inventory (stock=${stock})`, async t => {
  const first = await completedWorld(t)
  first.game.status.actor_id++
  first.game.status.epoch++
  first.game.inventory['copper-plate'] = stock
  const w = world({ memory: new CanonicalTaskBoardMemory(), stateFile: first.agent.stateFile, game: first.game })
  await w.agent.loadPersistentState()
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), ['move_items_exact'])
  const proof = w.memory.currentPlan(KEY).task_board.evidence.find(row => row.kind === 'operation_receipt')
  const context = JSON.parse(proof.summary).correlation
  assert.equal(context.actor_id, ACTOR_ID)
  assert.equal(context.actor_epoch, EPOCH)
  const fresh = await w.agent.settleIdleStepCheckpoint()
  assert.equal(fresh.closed, stock === 10, JSON.stringify({ fresh, events: w.events.slice(-8), logs: w.agentLogs }))
  assert.equal(w.held().active_step_index, stock === 10 ? 1 : 0)
  assert.equal(w.game.sent.length, 1)
})

test('transport-paused recovery records proof passively and reactivation checks the same contract', async t => {
  const first = await completedWorld(t)
  await first.agent.pausePersistentPlan('provider_transient: fixture timeout', { pause_class: 'transport', pause_subkind: 'timeout' })
  const w = world({ memory: new CanonicalTaskBoardMemory(), stateFile: first.agent.stateFile, game: first.game })
  await w.agent.loadPersistentState()
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), ['move_items_exact'])
  assert.equal(w.memory.currentPlan(KEY).status, 'paused')
  assert.equal((await w.agent.settleIdleStepCheckpoint()).closed, false)
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.sent.length, 1)
  assert.equal(w.memory.resumePausedPlan(KEY, { pauseClasses: ['transport'] }).resumed, true)
  const fresh = await w.agent.settleIdleStepCheckpoint()
  assert.equal(fresh.closed, true, JSON.stringify({ fresh, events: w.events.slice(-8), logs: w.agentLogs, state: w.memory.currentPlan(KEY) }))
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.sent.length, 1)
})

test('unreadable native status retains the exact recovery guard without proof or replay', async t => {
  const w = await completedWorld(t)
  w.agent.readTaskStatusRaw = async () => undefined
  await w.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  assert.ok(w.memory.pendingOperation(KEY))
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), [])
  assert.equal(w.events.some(row => row.event === 'operation.recovery_settled'), false)
  assert.equal(w.game.sent.length, 1)
})
