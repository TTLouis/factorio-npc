import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { inspectNextSliceLiveness, nextSliceControlView, settleNextSliceExit } from './next-slice-liveness.mjs'
import { recoverySession, settle } from './recovery-loop-fixtures.mjs'
import { completedSliceAnchor } from './next-slice-state.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/run-aw-next-slice.json', import.meta.url), 'utf8'))
for (const lane of fixture.lanes) {
  test(`AW ${lane.lane} verified predecessor has one durable allowance across draft/restage/restore`, () => {
    const memory = new CanonicalTaskBoardMemory()
    memory.restore(lane.snapshot)
    const key = lane.snapshot.planning_states[0].key
    const planning = memory.planningState(key)
    const anchor = completedSliceAnchor(planning)
    assert.equal(anchor.plan_id, planning.active_plan_id)
    assert.ok(anchor.plan_id.endsWith('_p7'))
    const before = structuredClone(planning.plans)
    const episode = memory.recordNextSliceTransition(key, { phase: 'pending', reason: 'verified_slice_complete' })
    assert.equal(episode.boundary_key, anchor.boundary_key)
    memory.dispatchPlanningEvent(key, { type: 'RUN_PAUSED', now: Date.now(), source: 'runtime', goal_id: anchor.goal_id, reason: 'provider_semantic_alignment_failed', pause_class: 'model_recoverable' })
    const allowance = memory.autoResumeAllowance(key)
    assert.equal(allowance.boundary_key, anchor.boundary_key)
    assert.equal(memory.recordAutoResumeStarted(key, { ...allowance, request_id: 'claimed_a' }).recorded, true)
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(memory.snapshot())
    assert.equal(restored.autoResumeAllowance(key).step_attempts, 1)
    const second = restored.autoResumeAllowance(key)
    assert.equal(restored.recordAutoResumeStarted(key, { ...second, request_id: 'claimed_b' }).recorded, true)
    const exhausted = restored.autoResumeAllowance(key)
    assert.equal(exhausted.limit_kind, 'step')
    assert.equal(restored.recordAutoResumeStarted(key, { ...exhausted, request_id: 'forbidden_c' }).recorded, false)
    assert.deepEqual(restored.planningState(key).plans, before)
  })
}

function awWorld(lane, provider) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(lane.snapshot)
  const key = lane.snapshot.planning_states[0].key
  const game = new FakeFactorio()
  const command = game.command.bind(game)
  let geometryReads = 0
  game.command = async text => {
    if (text.includes('entity_geometry')) {
      geometryReads++
      return JSON.stringify({ found: true, entity: { unit_number: lane.pump, name: 'offshore-pump', type: 'offshore-pump', position: { x: 48, y: 0 }, direction: 4 },
        fluid_box_count: 1, actor_id: game.status.actor_id, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1 })
    }
    if (text.includes('autorio_crafting')) return JSON.stringify({ task_active: false, native_queue: {}, persisted_owner: null })
    return command(text)
  }
  let calls = 0
  const rows = []
  const agent = new NpcAgentLoop({ memory, rcon: game, provider: async (...args) => { calls++; return provider(...args) },
    interactionDecisionProvider: async () => ({ answers: { recovery_semantics: { choice: 'semantic_replan', confidence: 0.99 }, one_observation_can_resolve: { noul: 0 } } }),
    systemPrompt: 'AW offline exact-state replay', npcId: 'npc-1', stateFile: null, traceFile: null, decisionTraceFile: null, goalDefinitionPolicy: 'required' })
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  agent.lastMemoryKey = key
  return { memory, game, agent, key, rows, geometryReads: () => geometryReads, calls: () => calls }
}
function startAuthoring(w) {
  w.agent.epoch = w.game.status
  w.agent.active = true
  w.agent.requestInfo = { memoryKey: w.key, turnId: w.memory.maxTurnId() + 1, sender: '<server>', text: w.memory.planningState(w.key).goal.objective }
  w.agent.traceRequest = { id: 'aw_original_authoring', seq: 0 }
  w.agent.replaceConversation({ baseMessages: [{ role: 'system', content: 'offline exact AW' }, { role: 'user', content: 'The previous immutable slice is complete. Author the next ordinary slice.' }] })
  w.agent.planUpdateReason = 'completion'
}
for (const lane of fixture.lanes) {
  test(`AW ${lane.lane} actual compact preservation exception leaves a visible guard pause`, async () => {
    const w = awWorld(lane, () => ({ content: lane.wire.content }))
    const before = structuredClone(w.memory.planningState(w.key).plans)
    startAuthoring(w)
    await assert.rejects(w.agent.runGuarded(), /provider_jev_recovery_route_failed: preservation_geometry_unproven/)
    assert.ok(w.geometryReads() > 0)
    assert.equal(w.memory.pauseRecord(w.key).paused, true)
    assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
    assert.deepEqual(w.memory.planningState(w.key).plans, before)
    assert.ok(w.rows.some(row => row.event === 'planning.next_slice_settled' && row.data.pause_class === 'guard'))
  })
}
test('actual supervisor detects injected AW orphan and automatically claims/commits same-goal ordinary next slice', async () => {
  const lane = fixture.lanes[0]
  const valid = planReply({ plan: ['Gather ten coal toward the existing factory goal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  const w = awWorld(lane, () => valid)
  const goal = structuredClone(w.memory.planningState(w.key).goal)
  const before = structuredClone(w.memory.planningState(w.key).plans)
  // Inject the original residual projection, bypassing worker exit prevention.
  w.agent.active = false
  w.agent.epoch = null
  w.agent.traceRequest = null
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
  await session.queueEvent(async () => null)
  await settle(session)
  assert.ok(session.modelResume, JSON.stringify({ pause: w.memory.pauseRecord(w.key), tail: w.rows.slice(-5) }))
  const scheduled = session.modelResume
  clearTimeout(scheduled.timer)
  scheduled.timer = null
  await session.fireModelResume(scheduled.token)
  await settle(session)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1)
  const after = w.memory.planningState(w.key)
  assert.deepEqual(after.goal, goal)
  assert.deepEqual(after.plans.slice(0, before.length), before)
  assert.ok(after.plans.some(plan => !before.some(old => old.plan_id === plan.plan_id) && ['COMMITTED', 'EXECUTING'].includes(plan.status)), JSON.stringify(w.rows.slice(-10)))
  assert.ok(w.calls() > 0)
  assert.equal(session.modelResume, null)
})

function orphanSession() {
  const w = awWorld(fixture.lanes[0], () => { throw new Error('Unexpected provider call') })
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
  return { ...w, session }
}
function stopWake(session) {
  if (session.modelResume?.timer) clearTimeout(session.modelResume.timer)
  session.cancelAutoResume('test_cleanup')
}
for (const kind of ['worker', 'provider', 'queued', 'intake', 'condition', 'event']) {
  test(`authoritative next-slice control view preserves live ${kind} ownership`, async () => {
    const w = orphanSession()
    if (kind === 'worker') w.agent.controllerBusyCount = 1
    if (kind === 'provider') w.agent.providerCallsByGeneration.set(w.agent.generation, 1)
    if (kind === 'queued') w.session.controllerQueuedEvents = 1
    if (kind === 'intake') w.agent.requestAdmissionOwner = {}
    if (kind === 'condition') w.session.conditionPollRunning = true
    if (kind === 'event') w.session.controllerEventRunning = 2
    assert.equal(nextSliceControlView(w.session).owned, true)
    assert.equal((await inspectNextSliceLiveness(w.session)).action, 'owned')
    assert.equal(w.memory.pauseRecord(w.key).paused, false)
    assert.equal(w.session.modelResume, null)
    assert.equal(w.calls(), 0)
  })
}
for (const change of ['cancel', 'intake', 'amendment', 'actor', 'queued', 'provider']) {
  test(`held native reconciliation refuses late ${change} without pausing or charging replacement`, async () => {
    const w = orphanSession()
    let release
    let entered
    const held = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { entered = resolve })
    const command = w.game.command.bind(w.game)
    w.game.command = async text => {
      if (text.includes('autorio_crafting')) { entered(); await held }
      return command(text)
    }
    const pending = inspectNextSliceLiveness(w.session)
    await reached
    if (change === 'cancel') { w.session.cancelAutoResume('user_stop_immediate'); w.agent.cancel('user_stop_immediate') }
    if (change === 'intake') w.agent.requestAdmissionOwner = { replacement: true }
    if (change === 'amendment') w.agent.pendingInteractionAmendment = { text: 'new instruction' }
    if (change === 'actor') w.session.lastStatus = { ...w.session.lastStatus, epoch: w.game.status.epoch + 1 }
    if (change === 'queued') w.session.controllerQueuedEvents = 1
    if (change === 'provider') w.agent.providerCallsByGeneration.set(w.agent.generation, 1)
    const replacement = structuredClone(w.memory.planningState(w.key))
    release()
    assert.equal((await pending).action, 'stale')
    assert.deepEqual(w.memory.planningState(w.key), replacement)
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
    assert.equal(w.session.modelResume, null)
    assert.equal(w.calls(), 0)
  })
}
for (const nativeState of ['busy', 'unknown', 'pending']) {
  test(`next-slice ${nativeState} native ownership never becomes automatic model permission`, async () => {
    const w = orphanSession()
    if (nativeState === 'busy') w.game.status.idle = false
    if (nativeState === 'unknown') {
      const command = w.game.command.bind(w.game)
      w.game.command = text => text.includes('autorio_crafting') ? '{}' : command(text)
    }
    if (nativeState === 'pending') w.memory.pendingOperations = () => [{ operation_id: 'unsettled' }]
    const result = await inspectNextSliceLiveness(w.session)
    assert.equal(result.action, nativeState === 'busy' ? 'native_owned' : 'paused')
    if (nativeState !== 'busy') assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
    assert.equal(w.session.modelResume, null)
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
    assert.equal(w.calls(), 0)
  })
}
test('unknown authoring failure remains a guard; operator pause stays untouched', async () => {
  const w = orphanSession()
  const result = await settleNextSliceExit(w.agent, { failure: new Error('unrecognized semantic corruption') })
  assert.equal(result.pause_class, 'guard')
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
  const state = structuredClone(w.memory.planningState(w.key))
  await settle(w.session)
  assert.equal((await inspectNextSliceLiveness(w.session)).action, 'paused')
  assert.deepEqual(w.memory.planningState(w.key), state)
  stopWake(w.session)
})

test('same-boundary retries survive restart and visibly exhaust existing two-attempt allowance', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session)
  stopWake(w.session)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const allowance = w.memory.autoResumeAllowance(w.key)
    assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...allowance, request_id: `crashed_${attempt}` }).recorded, true)
    // A crash after claiming a request spends it even when no response returned.
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(w.memory.snapshot())
    w.memory.restore(restored.snapshot())
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, attempt)
  }
  const allowance = w.memory.autoResumeAllowance(w.key)
  assert.equal(allowance.limit_kind, 'step')
  await w.session.reportModelResumeExhausted(allowance)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.equal(w.memory.planningState(w.key).run.pause_reason, 'next_slice_recovery_exhausted')
  await inspectNextSliceLiveness(w.session)
  assert.equal(w.session.modelResume, null)
  assert.equal(w.calls(), 0)
})
test('failed strict claim persistence never sends a model request and releases only its own wake', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  const pending = w.session.modelResume
  assert.ok(pending)
  clearTimeout(pending.timer)
  pending.timer = null
  w.agent.persistState = async options => { if (options?.strict) throw new Error('offline strict persistence refused') }
  await assert.rejects(w.session.runModelRecoverableResume(pending.correlation, pending.attempt, pending.token), /strict persistence refused/)
  assert.equal(w.calls(), 0)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1)
  // The failed save did not retain a false live model request.
  assert.notEqual(w.session.modelResume?.token, pending.token)
  stopWake(w.session)
})
test('a synthetic later rejected draft never resets the predecessor allowance or authorizes duplicate pump work', async () => {
  const lane = fixture.lanes[0]
  const valid = planReply({ plan: ['Gather ten coal toward the existing goal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  const w = awWorld(lane, () => valid)
  const completed = structuredClone(w.memory.planningState(w.key).plans)
  const legacy = w.memory.planByNpc.get(w.key)
  legacy.status = 'active'
  w.memory.ensurePlanningDraft(w.key, legacy)
  const draft = w.memory.planningState(w.key).plans.at(-1)
  assert.equal(draft.status, 'DRAFT')
  assert.notEqual(draft.plan_id, completed.at(-1).plan_id)
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
  await session.queueEvent(async () => null)
  await settle(session)
  const pending = session.modelResume
  assert.ok(pending)
  clearTimeout(pending.timer)
  pending.timer = null
  await session.fireModelResume(pending.token)
  await settle(session)
  const after = w.memory.planningState(w.key)
  assert.deepEqual(after.plans.slice(0, completed.length), completed)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1)
  assert.ok(after.plans.some(plan => plan.plan_id !== draft.plan_id && !completed.some(old => old.plan_id === plan.plan_id) && ['COMMITTED', 'EXECUTING'].includes(plan.status)), JSON.stringify({plans:after.plans.map(plan=>({id:plan.plan_id,status:plan.status})),tail:w.rows.slice(-14)}))
  const committed = after.plans.findLast(plan => ['COMMITTED', 'EXECUTING'].includes(plan.status))
  assert.deepEqual(committed.steps.map(step => step.description), JSON.parse(valid.content).plan)
  assert.equal(committed.steps[0].completion_contract.requirements[0].item_name, 'coal')
  assert.equal(committed.steps[0].completion_contract.requirements[0].minimum, 10)
  assert.equal(w.geometryReads(), 0)
  stopWake(session)
})

test('actual supervisor publishes live owner view and accepts only matching fresh settlement requests', async t => {
  const w = orphanSession()
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'next-slice-runtime-'))
  w.session.root = root
  t.after(async () => { stopWake(w.session); await w.session.publishNextSliceControl(); await fsp.rm(root, { recursive: true, force: true }) })
  await w.session.publishNextSliceControl()
  let view = JSON.parse(await fsp.readFile(path.join(root, '.sgluna/controller-state.json')))
  assert.equal(view.owned, false)
  const request = { schema: 1, request_id: 'offline_request', instance_id: view.instance_id, actor_id: view.actor_id,
    epoch: view.epoch, goal_id: view.goal_id, boundary_key: view.boundary_key, requested_at: Date.now() }
  const filename = path.join(root, '.sgluna/next-slice-settle-request.json')
  for (const mutation of [{ epoch: view.epoch + 1 }, { instance_id: 'retired-runtime' }, { goal_id: 'retired-goal' }, { requested_at: Date.now() - 31000 }]) {
    await fsp.writeFile(filename, JSON.stringify({ ...request, ...mutation }))
    assert.equal(await w.session.readNextSliceSettlementRequest(), undefined)
  }
  await fsp.writeFile(filename, JSON.stringify(request))
  assert.equal((await w.session.readNextSliceSettlementRequest()).request_id, request.request_id)
  w.session.pollControllerLiveness()
  await settle(w.session)
  await w.session.publishNextSliceControl()
  view = JSON.parse(await fsp.readFile(path.join(root, '.sgluna/controller-state.json')))
  assert.equal(view.settlement.request_id, request.request_id)
  assert.equal(view.run_paused, true)
  assert.equal(view.ownership.wake, 1)
  assert.equal(w.calls(), 0)
  assert.equal(await w.session.readNextSliceSettlementRequest(), undefined)
})

for (const protectedKind of ['committed', 'replacement', 'typed_successor']) {
  test(`ordinary next-slice authoring cannot rewrite ${protectedKind} semantics`, async () => {
    const w = orphanSession()
    const state = w.memory.planByNpc.get(w.key)
    state.status = 'active'
    w.memory.ensurePlanningDraft(w.key, state)
    const planning = w.memory.planningState(w.key)
    const held = planning.plans.at(-1)
    if (protectedKind === 'committed') held.status = 'COMMITTED'
    if (protectedKind === 'replacement') held.replacement = { reason: 'protected_test_lineage' }
    if (protectedKind === 'typed_successor') planning.goal.contract_defect_successors = [held.plan_id]
    // A stale episode cannot authorize edits across those semantic boundaries.
    planning.run.next_slice = { ...completedSliceAnchor({ ...planning, plans: planning.plans.slice(0, -1) }),
      schema: 1, phase: 'request_owned', claimed_attempt: 1, owner: { request_id: 'old_ordinary' } }
    const before = structuredClone(held.steps)
    w.memory.recordPlan(w.key, { sender: 'runtime', text: planning.goal.objective }, {
      plan: ['Unrelated new authoring body'], currentStep: 0, operations: [gather('coal', 10)] }, { continuation: true })
    assert.deepEqual(w.memory.planningState(w.key).plans.find(plan => plan.plan_id === held.plan_id).steps, before)
    assert.equal(w.memory.planningState(w.key).plans.at(-1).plan_id, held.plan_id)
  })
}

test('actual supervisor model failures spend two same-boundary wakes then durably guard-pause', async () => {
  const w = awWorld(fixture.lanes[0], () => { throw new Error('provider_semantic_alignment_failed: offline model produced no usable action') })
  const original = structuredClone(w.memory.planningState(w.key).plans)
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
  try {
    await session.queueEvent(async () => null)
    await settle(session)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pending = session.modelResume
      assert.ok(pending, `wake ${attempt} remains runtime owned`)
      clearTimeout(pending.timer); pending.timer = null
      await session.fireModelResume(pending.token)
      await settle(session)
      assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, attempt)
      assert.deepEqual(w.memory.planningState(w.key).plans, original)
    }
    assert.equal(session.modelResume, null)
    assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
    assert.equal(w.memory.planningState(w.key).run.pause_reason, 'next_slice_recovery_exhausted')
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(w.memory.snapshot())
    assert.equal(restored.autoResumeAllowance(w.key).limit_kind, 'step')
    assert.equal(restored.pauseRecord(w.key).pause_class, 'guard')
    assert.ok(w.calls() > 0 && w.calls() <= 10)
  } finally { stopWake(session) }
})
test('the existing goal-wide six-attempt cap dominates a fresh completed-slice boundary', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  stopWake(w.session)
  const planning = w.memory.planningState(w.key)
  planning.run.auto_resume = { goal_id: planning.goal.goal_id, goal_total: 6, steps: [] }
  const allowance = w.memory.autoResumeAllowance(w.key)
  assert.equal(allowance.limit_kind, 'goal')
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...allowance, request_id: 'forbidden_seventh' }).recorded, false)
  await w.session.reportModelResumeExhausted(allowance)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.equal(w.calls(), 0)
})

test('corrupt durable episode fails closed after restart instead of replenishing a wake', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  stopWake(w.session)
  const snapshot = w.memory.snapshot()
  snapshot.planning_states[0].state.run.next_slice.phase = 'corrupt_phase'
  snapshot.planning_states[0].state.run.paused = false
  w.memory.restore(snapshot)
  assert.equal(w.memory.planningState(w.key).run.next_slice_fault, true)
  assert.equal(w.memory.autoResumeAllowance(w.key).limit_kind, 'state')
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.match(w.memory.pauseRecord(w.key).pause_reason, /next_slice_episode_unreadable/)
  assert.equal(w.session.modelResume, null)
  assert.equal(w.calls(), 0)
})
for (const operation of ['slice_budget', 'planner_handoff']) {
  test(`late cancellation during ${operation} does not clear or spend newer request state`, async () => {
    const w = orphanSession()
    startAuthoring(w)
    let release
    let entered
    const held = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { entered = resolve })
    if (operation === 'slice_budget') w.agent.closeContinuationSlice = async () => { entered(); await held }
    else {
      const persist = w.agent.persistState.bind(w.agent)
      let first = true
      w.agent.persistState = async options => { if (first) { first = false; entered(); await held }; return persist(options) }
    }
    const pending = operation === 'slice_budget' ? w.agent.closeOutputSlice('next_shelf_slice') : w.agent.endSliceWithoutPlanner({ route: 'next_shelf_slice', reason: 'unproven_planner_return' })
    await reached
    w.agent.cancel('user_stop_immediate')
    w.agent.traceRequest = { id: 'replacement', seq: 0, aggregate_output_units: 42 }
    w.agent.requestAdmissionOwner = { replacement: true }
    const trace = structuredClone(w.agent.traceRequest)
    const planning = structuredClone(w.memory.planningState(w.key))
    release()
    await assert.rejects(pending, /cancelled or superseded/)
    assert.deepEqual(w.agent.traceRequest, trace)
    assert.deepEqual(w.memory.planningState(w.key), planning)
    assert.equal(w.calls(), 0)
  })
}

test('unknown supervisor-event errors stay classified guard errors at the shared finally boundary', async () => {
  const w = orphanSession()
  await w.session.queueEvent(async () => { throw new Error('unrecognized external controller error') })
  await settle(w.session)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.equal(w.session.modelResume, null)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
  assert.equal(w.calls(), 0)
})
