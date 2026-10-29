import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { ensureCommittedFactoryCellBeforeClose, validateFactoryCellDraft } from './factory-cell-enrollment.mjs'

const KEY = 'npc:enrollment-test'
const WORLD = '1e837e91-4f33-43a2-a3aa-c891ee06ec66'
const INTENT = { kind: 'direct_feed', product: 'copper-plate', sourceEntity: 'burner-mining-drill', targetEntity: 'stone-furnace', purpose: 'Keep copper production assigned' }
const CHECKPOINT = { mode: 'all', confidence: 0.9, requirements: [{ id: 'held', kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] }
const clone = v => structuredClone(v)
function fixture({ intent = true, bound = true } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  if (bound) memory.initializeFactoryRegistry(WORLD)
  const draft = { chatMessage: '', plan: ['Build and configure one dedicated copper pair'], currentStep: 0, operations: [],
    executionGuidance: [{ approach: 'Build the observed direct-feed pair', rationale: 'Retain its intended output', constraints: [], skillIds: [],
      materialSupply: { mode: 'direct_feed', resource: 'copper-ore' }, ...(intent ? { cellIntent: clone(INTENT) } : {}) }],
    stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }] }
  memory.recordPlan(KEY, { sender: 'owner', text: 'Build dedicated copper production' }, draft, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const events = []; const writes = []; const game = {
    world: WORLD, count: 0, observeCount: 0,
    deployment: { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', session: 'enrollment-session', actor_id: 24, actor_kind: 'standalone_character', epoch: 2,
      allowed: true, idle: true, actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 },
    status: { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, admission_journal: [], receipt_journal: [] },
  }
  const rcon = { command: async text => {
    await game.onCommand?.(text)
    if (text.includes('sgluna_deployment') && text.includes('status')) return JSON.stringify(game.deployment)
    if (text.includes('autorio_actor') && text.includes('status')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: 24, valid: true }, surface_index: 1, force_index: 1 })
    if (text.includes('autorio_operations') && text.includes('status')) return JSON.stringify(game.status)
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: Boolean(game.world), code: game.world ? 'ok' : 'world_unbound', world_id: game.world })
    if (text.includes("'sgluna_factory','observe'")) {
      game.observeCount++
      const request = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1])
      const [source, target] = request.members
      const response = { ...request, ok: true, tick: 1000, members: [
        { locator: source, state: 'observed', source_resources: { state: 'known', truncated: false, resources: [
          { name: 'copper-ore', amount: 100, products_truncated: false, products: [{ name: 'copper-ore', type: 'item' }] }] },
        recipe: { state: 'unsupported' }, item_routes: { state: 'known', truncated: false, routes: [{ kind: 'drop', state: 'connected', target }] } },
        { locator: target, state: 'observed', recipe: { state: 'known', truncated: false, name: 'copper-plate',
          ingredients: [{ name: 'copper-ore', type: 'item' }], products: [{ name: 'copper-plate', type: 'item' }] }, source_resources: { state: 'not_applicable', resources: [], truncated: false } },
      ] }
      await game.onObserve?.(response)
      return JSON.stringify(response)
    }
    throw new Error(`Unexpected native command: ${text}`)
  } }
  const agent = new NpcAgentLoop({ rcon, memory, stateFile: null, traceFile: null, decisionTraceFile: null,
    npcId: 'enrollment-test', completionProtocolVersion: 3, jevCheckpoints: false, provider: async () => { throw new Error('No provider authorized') } })
  agent.active = true; agent.epoch = { ...game.deployment }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'enrollment-request', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async record => { events.push(record); await game.onTrace?.(record) } }
  agent.persistState = async () => { writes.push(memory.snapshot()); await game.onPersist?.() }
  const w = { memory, agent, game, events, writes, draft }
  w.place = async (name, unit = ++game.count + 70) => {
    const pending = await agent.recordPendingOperationBeforeSend([{ name: 'place_entity', args: { entity_name: name, x: unit, y: 4 } }], game.deployment, [{ operation: 'place_entity', ok: true }])
    assert.equal(pending.surface_index, 1, 'actual shared pre-send supplies authoritative native surface')
    const n = pending.ordinal; const ref = { batch_id: n, batch_generation: 1, batch_ref: `batch-g1-${n}` }
    const batch = { ...ref, state: 'completed', task_count: 1, task_types: ['placing'], started_count: 1, tick: 100 + n }
    game.status.last_completed_batch = clone(batch); game.status.receipt_journal.push(batch)
    game.status.admission_journal.push({ operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, actor_id: 24, epoch: 2,
      ordinal: n, operation_count: 1, generation: 1, state: 'completed', ok: true, tick: 100 + n,
      slots: [{ index: 1, ok: true, operation: 'place_entity', queued_tasks: 1, batch_refs: [ref] }] })
    game.status.basic_operation = { last_result: { accepted: true, completed: true, code: 'completed', type: 'placing', operation_id: n, tick: batch.tick,
      actor_id: 24, actor_kind: 'standalone_character', entity_name: name, placed_unit_number: unit, placed_position: { x: unit, y: 4 }, placed_world_id: WORLD,
      placed_surface_index: 1, placed_force_index: 1, placed_batch_id: n, placed_batch_generation: 1, placed_batch_ref: ref.batch_ref } }
    const response = await agent.taskStatusReceipt()
    assert.equal(response.view.status_error, undefined)
    assert.equal(memory.pendingOperations(KEY).length, 0)
    assert.ok(memory.snapshot().factory_placement_receipts?.some(row => row.unit_number === unit))
    return pending
  }
  w.build = async () => { await w.place(INTENT.sourceEntity); await w.place(INTENT.targetEntity); return w }
  w.enroll = () => ensureCommittedFactoryCellBeforeClose(agent, agent.captureCheckpointOwner())
  return w
}

test('real pre-send to settlement captures intended AND intentless UUID-bound placements', async () => {
  for (const intent of [true, false]) {
    const w = fixture({ intent }); await w.place(INTENT.sourceEntity)
    assert.equal(w.memory.snapshot().factory_placement_receipts.length, 1)
    assert.equal(w.memory.snapshot().factory_placement_receipts[0].surface_index, 1)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  }
})

test('world prerequisite refuses unbound/assessment/unknown native identity before accepting draft intent', async () => {
  const w = fixture({ bound: false })
  await assert.rejects(validateFactoryCellDraft(w.agent, w.draft), error => error.code === 'factory_enrollment_world_unbound')
  const v = fixture(); v.game.world = undefined
  await assert.rejects(validateFactoryCellDraft(v.agent, v.draft), error => error.code === 'factory_world_identity_missing')
  await assert.rejects(validateFactoryCellDraft(v.agent, { ...v.draft, assessmentOnly: true }), error => error.code === 'factory_cell_intent_invalid')
  v.game.world = WORLD; const before = clone(v.memory.planningState(KEY))
  await validateFactoryCellDraft(v.agent, v.draft)
  assert.deepEqual(v.memory.planningState(KEY), before)
})

test('production pair enrollment preserves committed intent and is durable/idempotent across restore', async () => {
  const w = await fixture().build(); const before = clone(w.memory.planningState(KEY))
  const result = await w.enroll()
  assert.equal(result.ok, true); assert.equal(result.duplicate, false)
  assert.deepEqual(w.memory.planningState(KEY), before)
  const cell = w.memory.getFactoryRegistry().cells[0]
  assert.deepEqual(cell.assignment.products, ['copper-plate']); assert.equal(cell.enrollment.receipt_ids.length, 2)
  assert.equal(cell.state, 'unverified')
  assert.equal((await w.enroll()).cell_id, cell.cell_id)
  const snapshot = w.memory.snapshot(); w.memory.restore(snapshot)
  assert.equal((await w.enroll()).duplicate, true)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0], cell)
  assert.ok(w.events.some(row => row.event === 'factory_cell.enrolled' && row.data.dependencies === 'unverified'))
})

test('actual shared step-close barrier enrolls durably before outcome authority; missing provenance cannot close', async () => {
  const w = await fixture().build(); const order = []
  w.game.onPersist = () => { if (w.memory.getFactoryRegistry().cells.length) order.push('persisted') }
  const original = w.memory.applyOutcomeAuthority.bind(w.memory)
  w.memory.applyOutcomeAuthority = (...args) => { order.push('outcome'); assert.ok(order.includes('persisted')); return original(...args) }
  const plan = getActivePlan(w.memory.planningState(KEY)); const board = w.memory.currentPlan(KEY).task_board
  const closed = await w.agent.applyStepClose('fixture', { key: KEY, step: board.steps[board.active_index], contract: CHECKPOINT, results: [], reasonCode: 'fixture_native_checkpoint', source: 'deterministic_runtime' })
  assert.equal(closed.closed, true)
  assert.equal(getActivePlan(w.memory.planningState(KEY)).execution.step_progress[plan.steps[0].step_id].status, 'completed')
  const v = fixture(); v.agent.pauseForStepContract = async () => ({ paused: true })
  const vb = v.memory.currentPlan(KEY).task_board
  const refused = await v.agent.applyStepClose('fixture', { key: KEY, step: vb.steps[vb.active_index], contract: CHECKPOINT, results: [], reasonCode: 'fixture_native_checkpoint' })
  assert.equal(refused.closed, false); assert.equal(refused.reason, 'factory_enrollment_placement_missing')
  assert.equal(v.memory.getFactoryRegistry().cells.length, 0)
})

test('canonical completion cannot bypass missing committed enrollment through another outcome route', () => {
  const w = fixture()
  const result = w.memory.applyOutcomeAuthority(KEY, { kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'fixture_checkpoint',
    evidence: [{ kind: 'verified_world_state', ref: 'fixture', summary: 'fixture native checkpoint' }], metadata: { scope: 'step' } })
  assert.equal(result.decision.accepted, false)
  assert.equal(result.decision.rejection_reason, 'factory_enrollment_required')
})

test('copper remains copper: wrong source/product/route and unknown native facts never publish', async () => {
  for (const mutate of [
    r => { r.members[0].source_resources.resources[0].name = 'iron-ore'; r.members[0].source_resources.resources[0].products[0].name = 'iron-ore' },
    r => { r.members[1].recipe.products[0].name = 'iron-plate' },
    r => { r.members[1].recipe.products[0].type = 'fluid' },
    r => { delete r.members[1].recipe.products[0].type },
    r => { r.members[0].item_routes.routes[0].target.unit_number++ },
    r => { r.members[0].source_resources.state = 'unknown' }, r => { r.members[1].state = 'hidden' },
  ]) {
    const w = await fixture().build(); const before = clone(w.memory.planningState(KEY))
    w.game.onObserve = mutate
    await assert.rejects(w.enroll(), /factory_enrollment_native_|factory_native_observation_members_mismatch/)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
    assert.deepEqual(w.memory.planningState(KEY), before)
  }
})

test('original scope and intent are required; generic old hardware, ambiguous receipts and another step cannot enroll', async () => {
  const absent = await fixture({ intent: false }).build()
  assert.equal((await absent.enroll()).applicable, false)
  assert.equal(absent.memory.getFactoryRegistry().cells.length, 0)
  for (const change of [
    s => { s.factory_placement_receipts[0].semantic_step_id = 'other-step' },
    s => { s.factory_placement_receipts[0].goal_id = 'other-goal' },
    s => { s.factory_placement_receipts.push({ ...s.factory_placement_receipts[0], unit_number: 999, receipt_id: `${WORLD}/batch-g1-999/999`, batch_id: 999, batch_ref: 'batch-g1-999', operation_id: 999 }) },
    s => { delete s.factory_placement_receipts },
  ]) {
    const w = await fixture().build(); const snapshot = w.memory.snapshot(); change(snapshot)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(snapshot); w.agent.memory = restored
    await assert.rejects(w.enroll(), /factory_enrollment_|factory_placement_/)
    assert.equal(restored.getFactoryRegistry().cells.length, 0)
  }
})

test('pre-send shape, duplicate, busy and stale ownership fences prevent another placement record', async () => {
  const w = fixture()
  await assert.rejects(w.agent.recordPendingOperationBeforeSend([{ name: 'place_entity', args: { entity_name: INTENT.sourceEntity } }, { name: 'wait', args: {} }], w.game.deployment), /factory_enrollment_single_placement_required/)
  await w.place(INTENT.sourceEntity)
  await assert.rejects(w.place(INTENT.sourceEntity), /factory_enrollment_duplicate_placement/)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  const busy = fixture(); busy.game.status.queue_length = 1
  await assert.rejects(busy.place(INTENT.sourceEntity), /factory_runtime_not_idle/)
  const stale = fixture(); stale.game.onCommand = text => { if (text.includes('autorio_actor')) stale.agent.traceRequest = { id: 'superseded' } }
  await assert.rejects(stale.place(INTENT.sourceEntity), /stale|superseded/)
  assert.equal(stale.memory.pendingOperations(KEY).length, 0)
})

test('cancellation, new native work and persistence failure cannot advance or publish a verified assignment', async () => {
  for (const mutate of [w => { w.agent.traceRequest = { id: 'superseded' } }, w => { w.game.status.queue_length = 1 }, w => { w.memory.restore(w.memory.snapshot()) }]) {
    const w = await fixture().build(); w.game.onObserve = () => mutate(w)
    await assert.rejects(w.enroll(), /stale|superseded|not_idle/)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  }
  const w = await fixture().build(); w.game.onPersist = () => { throw new Error('fixture persistence failure') }
  await assert.rejects(w.enroll())
  assert.equal(w.memory.factoryRegistryStatus().status, 'fault')
  assert.equal(w.memory.snapshot().factory_registry.cells.length, 1, 'applied assignment is preserved behind the durable fault')
  assert.notEqual(getActivePlan(w.memory.planningState(KEY)).status, 'COMPLETED')
})

test('actual early-goal completion enrolls built pair, pauses partial pair and permits wholly unbuilt intent to become moot', async () => {
  for (const built of [0, 1, 2]) {
    const w = fixture()
    if (built >= 1) await w.place(INTENT.sourceEntity)
    if (built === 2) await w.place(INTENT.targetEntity)
    // Supply a deterministic goal-evaluation fixture at the existing evaluator
    // boundary; the actual finish/registry/outcome/satisfaction methods run.
    w.memory.goalDefinition = () => ({ scope: 'finite' })
    const evaluation = { satisfied: true, results: [{ id: 'held', satisfied: true, current: 1 }], _sglunaGoalFence: { key: KEY } }
    w.agent.evaluateGoalCompletion = async () => evaluation
    w.agent.assertGoalEvaluationCurrent = async () => {}
    w.agent.pauseForStepContract = async ({ reason }) => ({ paused: true, reason })
    const result = await w.agent.finishIfGoalMet({ chatMessage: 'Goal native condition met' }, w.memory.currentPlan(KEY))
    if (built === 1) {
      assert.equal(result.paused, true); assert.equal(result.reason, 'factory_enrollment_placement_missing')
      assert.equal(w.memory.planningState(KEY).goal.status, 'active')
      assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
      assert.ok(w.events.some(row => row.event === 'factory_cell.goal_completion_refused' && row.data.original_goal_satisfied === true))
    }
    else {
      assert.equal(result.goalStatus, 'completed')
      assert.equal(w.memory.getFactoryRegistry().cells.length, built === 2 ? 1 : 0)
      assert.equal(w.memory.planningState(KEY).goal.status, 'completed')
    }
  }
})

test('canonical goal-completion and runtime satisfaction backstops cannot abandon a partially built intent', async () => {
  const w = fixture(); await w.place(INTENT.sourceEntity)
  const before = clone(w.memory.planningState(KEY))
  const result = w.memory.applyOutcomeAuthority(KEY, { kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'goal_definition_satisfied',
    evidence: [{ kind: 'verified_world_state', ref: 'fixture-goal-proof', summary: 'native goal fixture satisfied' }] })
  assert.equal(result.decision.accepted, false)
  assert.equal(result.decision.rejection_reason, 'factory_enrollment_required')
  w.memory.recordGoalSatisfaction(KEY, { source: 'runtime', evidenceRefs: ['fixture-goal-proof'] })
  assert.deepEqual(w.memory.planningState(KEY), before)
})
