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
import { recoverInterruptedAgentPlan } from './supervisor.mjs'
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
    await assert.rejects(w.agent.runGuarded(), /provider_jev_recovery_route_failed: preservation_fluid_geometry_incomplete/)
    assert.ok(w.geometryReads() > 0)
    assert.equal(w.memory.pauseRecord(w.key).paused, true)
    assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
    assert.deepEqual(w.memory.planningState(w.key).plans, before)
    assert.ok(w.rows.some(row => row.event === 'planning.next_slice_settled' && row.data.pause_class === 'guard'
      && row.data.preservation_failure?.code === 'preservation_fluid_geometry_incomplete'
      && row.data.preservation_failure.category === 'unproven' && row.data.preservation_failure.stage === 'capture'))
  })
}
function retainedNavigation(w, { mismatch = false, changeSecondSample = false } = {}) {
  const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8'))
  const planning = w.memory.planningState(w.key)
  const plan = planning.plans.find(row => row.plan_id === planning.active_plan_id)
  const record = { ...ay.pending, goal_id: planning.goal.goal_id, plan_id: plan.plan_id,
    step_id: plan.steps.at(-1).step_id, actor: { actor_id: w.game.status.actor_id, epoch: w.game.status.epoch } }
  assert.ok(w.memory.recordPendingOperation(w.key, record))
  assert.ok(w.memory.clearPendingOperation(w.key, { operationKey: record.operation_key }))
  const native = w.game.command.bind(w.game)
  let samples = 0
  w.game.command = async text => {
    const result = await native(text)
    if (!text.includes('projection="next_slice_ownership_v1"')) return result
    const sample = JSON.parse(result)
    const status = structuredClone(ay.native)
    status.admission_journal[0].actor_id = record.actor.actor_id
    status.admission_journal[0].epoch = record.actor.epoch
    if (mismatch) status.admission_journal[0].signature = 'wrong'
    if (changeSecondSample && ++samples % 2 === 0) status.admission_journal[0].work_mark++
    sample.operations = status
    return JSON.stringify(sample)
  }
}

for (const navigation of [false, true]) test(`actual supervisor detects injected AW orphan and automatically commits next slice; retained AY navigation=${navigation}`, async () => {
  const lane = fixture.lanes[0]
  const valid = planReply({ plan: ['Gather ten coal toward the existing factory goal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  const w = awWorld(lane, () => valid)
  if (navigation) retainedNavigation(w)
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

for (const unsafe of ['mismatch', 'changeSecondSample']) test(`next-slice retained navigation preserves ${unsafe} guard`, async () => {
  const w = orphanSession()
  retainedNavigation(w, { [unsafe]: true })
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  stopWake(w.session)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.equal(w.calls(), 0)
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
      if (text.includes('projection="next_slice_ownership_v1"')) { entered(); await held }
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
      w.game.command = text => text.includes('projection="next_slice_ownership_v1"') ? '{}'  : command(text)
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
  const result = await settleNextSliceExit(w.agent, { failure: new Error('scripted preparation gap') })
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

test('native batch watermark advancing during reconciliation refuses an orphan recovery claim', async () => {
  const w = orphanSession()
  const command = w.game.command.bind(w.game)
  w.game.command = async text => {
    if (text.includes('projection="next_slice_ownership_v1"')) w.game.batchId++
    return command(text)
  }
  await inspectNextSliceLiveness(w.session)
  await settle(w.session)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.match(w.memory.pauseRecord(w.key).pause_reason, /next_slice_native_unproven/)
  assert.equal(w.session.modelResume, null)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
  assert.equal(w.calls(), 0)
})

test('duplicate fired callback cannot consume the next boundary wake or replenish an allowance', async () => {
  const w = awWorld(fixture.lanes[0], () => { throw new Error('provider_semantic_alignment_failed: offline model failure') })
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
  try {
    await session.queueEvent(async () => null)
    await settle(session)
    const first = session.modelResume
    clearTimeout(first.timer); first.timer = null
    const one = session.fireModelResume(first.token)
    const duplicate = session.fireModelResume(first.token)
    await Promise.all([one, duplicate])
    await settle(session)
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1)
    assert.ok(session.modelResume)
    assert.notEqual(session.modelResume.token, first.token)
    assert.equal(w.memory.pauseRecord(w.key).pause_class, 'model_recoverable')
  } finally { stopWake(session) }
})
test('recovery preload cannot cancel real B pre-Base intake while generation/trace still match', async () => {
  const w = orphanSession()
  let releaseA, enterA, releaseB, enterB
  const aHeld = new Promise(resolve => { releaseA = resolve })
  const aEntered = new Promise(resolve => { enterA = resolve })
  const bHeld = new Promise(resolve => { releaseB = resolve })
  const bEntered = new Promise(resolve => { enterB = resolve })
  const load = w.agent.loadPersistentState.bind(w.agent)
  let first = true
  w.agent.loadPersistentState = async () => { if (first) { first = false; enterA(); await aHeld }; return load() }
  const read = w.agent.readInteractionTaskStatus.bind(w.agent)
  w.agent.readInteractionTaskStatus = async () => { const result = await read(); enterB(); await bHeld; return result }
  w.agent.interactionDecisionProvider = undefined
  w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'chat_only', queue_conflict: false, reply: 'Here.' }) })
  const pending = recoverInterruptedAgentPlan(w.agent, 'offline_startup', {})
  await aEntered
  const runningB = w.agent.request('How is the factory?', { sender: 'Louis' })
  await bEntered
  const newer = w.agent.requestAdmissionOwner
  const trace = w.agent.traceRequest
  const generation = w.agent.generation
  const before = w.memory.snapshot()
  const messages = structuredClone(w.agent.messages)
  const base = structuredClone(w.agent.baseMessages)
  const budgets = [w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining]
  try {
    releaseA()
    const result = await pending.catch(error => ({ recovered: 'threw', message: error.message }))
    assert.equal(result.recovered, false, JSON.stringify({ result, offline_provider_calls: w.calls(), newer_owner_preserved: w.agent.requestAdmissionOwner === newer }))
    assert.equal(w.agent.requestAdmissionOwner, newer)
    assert.equal(w.agent.traceRequest, trace)
    assert.equal(w.agent.generation, generation)
    assert.deepEqual(w.memory.snapshot(), before)
    assert.deepEqual(w.agent.messages, messages)
    assert.deepEqual(w.agent.baseMessages, base)
    assert.deepEqual([w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], budgets)
    assert.equal(w.calls(), 0)
  } finally { releaseB(); await runningB.catch(() => undefined); stopWake(w.session) }
})

for (const disposition of ['return', 'error']) {
  test(`originating A ${disposition} cannot adopt real B held before Base generation/trace advance`, async () => {
    const w = orphanSession()
    startAuthoring(w)
    let finishA, enterA, finishB, enterB
    const aHeld = new Promise(resolve => { finishA = resolve })
    const aEntered = new Promise(resolve => { enterA = resolve })
    const bHeld = new Promise(resolve => { finishB = resolve })
    const bEntered = new Promise(resolve => { enterB = resolve })
    w.agent.runTurnRedriving = async () => { enterA(); await aHeld; if (disposition === 'error') throw new Error('old A failure'); return { chatMessage: 'old A return' } }
    const runningA = w.agent.runGuarded()
    const rejection = disposition === 'error' ? assert.rejects(runningA, /old A failure/) : undefined
    await aEntered
    const read = w.agent.readInteractionTaskStatus.bind(w.agent)
    w.agent.readInteractionTaskStatus = async () => { const result = await read(); enterB(); await bHeld; return result }
    w.agent.interactionDecisionProvider = undefined
    w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'chat_only', queue_conflict: false, reply: 'Here.' }) })
    const runningB = w.agent.request('How is the factory?', { sender: 'Louis' })
    await bEntered
    const token = w.agent.requestAdmissionOwner
    assert.equal(token.phase, 'intake')
    const trace = w.agent.traceRequest
    const generation = w.agent.generation
    const messages = structuredClone(w.agent.messages)
    const base = structuredClone(w.agent.baseMessages)
    const budgets = [w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining]
    const memory = w.memory.snapshot()
    try {
      finishA()
      if (rejection) await rejection; else await runningA
      assert.equal(w.agent.requestAdmissionOwner, token)
      assert.equal(w.agent.traceRequest, trace)
      assert.equal(w.agent.generation, generation)
      assert.deepEqual(w.agent.messages, messages)
      assert.deepEqual(w.agent.baseMessages, base)
      assert.deepEqual([w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], budgets)
      assert.deepEqual(w.memory.snapshot(), memory)
      assert.equal(w.calls(), 0)
    } finally {
      finishB()
      await runningB.catch(() => undefined)
      stopWake(w.session)
    }
  })
}
for (const mark of ['missing', 'malformed', 'inconsistent']) {
  test(`restored ${mark} progress mark cannot replenish an exhausted completed boundary`, async () => {
    const w = orphanSession()
    await inspectNextSliceLiveness(w.session)
    await settle(w.session)
    stopWake(w.session)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const allowance = w.memory.autoResumeAllowance(w.key)
      assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...allowance, request_id: `spent_${attempt}` }).recorded, true)
    }
    const snapshot = w.memory.snapshot()
    const run = snapshot.planning_states[0].state.run
    if (mark === 'missing') delete run.next_slice.progress_mark
    if (mark === 'malformed') run.next_slice.progress_mark = { forged: true }
    if (mark === 'inconsistent') run.next_slice.progress_mark = 'completed|999|999'
    w.memory.restore(snapshot)
    const claimed = w.memory.recordAutoResumeStarted(w.key, { ...w.memory.autoResumeAllowance(w.key), request_id: 'forbidden_third' })
    assert.equal(claimed.recorded, false)
    assert.equal(w.memory.planningState(w.key).run.next_slice_fault, true)
    assert.equal(w.memory.planningState(w.key).run.auto_resume.goal_total, 2)
    assert.equal(w.memory.autoResumeAllowance(w.key).limit_kind, 'state')
    assert.equal(w.calls(), 0)
  })
}
for (const transition of ['batch_pulse', 'crafting', 'follow', 'session', 'missing_projection']) {
  test(`protocol-real atomic ownership refuses late ${transition} without wake or reconciled acknowledgement`, async () => {
    const w = orphanSession()
    const command = w.game.command.bind(w.game)
    let projections = 0
    let deploymentReads = 0
    let changed = false
    const mutate = () => {
      if (changed) return
      changed = true
      if (transition === 'batch_pulse') w.game.batchId++
      if (transition === 'crafting') w.game.craftingStatus = { task_active: true, native_queue: { coal: 1 }, persisted_owner: { operation_id: 8 } }
      if (transition === 'follow') w.game.followStatus = { active: true, state: 'following', controller_live: true }
      if (transition === 'session') w.game.status.session = 'replacement-native-session-same-actor-and-epoch'
    }
    w.game.command = async text => {
      if (text.includes('projection="next_slice_ownership_v1"')) {
        if (++projections === 2) {
          mutate()
          if (transition === 'missing_projection') return '{}'
        }
      } else {
        // The same protocol-real fault also exercises the immutable earlier
        // sequential reader: task pulse after task read, craft after craft
        // read, follow/session after follow read. No nonexistent guard fields.
        if (text.includes('remote.call("sgluna_deployment","status")')) deploymentReads++
        if (transition === 'batch_pulse' && text.includes('remote.call("autorio_crafting","status")')) mutate()
        if (transition === 'crafting' && text.includes('remote.call("autorio_follow","status")')) mutate()
        if (['follow', 'session'].includes(transition) && deploymentReads === 2) mutate()
        if (text.includes('remote.call("autorio_crafting","status")') && w.game.craftingStatus) return JSON.stringify(w.game.craftingStatus)
        if (text.includes('remote.call("autorio_follow","status")') && w.game.followStatus) return JSON.stringify(w.game.followStatus)
      }
      return command(text)
    }
    try {
      const result = await inspectNextSliceLiveness(w.session)
      await settle(w.session)
      assert.equal(changed, true)
      assert.equal(w.session.modelResume, null)
      assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
      assert.equal(w.calls(), 0)
      assert.notEqual(result.native_reconciled, true)
      assert.equal(w.session.nextSliceSettlement, undefined)
    } finally { stopWake(w.session) }
  })
}

for (const takeover of ['new_pretrace_intake', 'runtime_replacement', 'native_inconsistent']) {
  test(`actual ownership publication refuses stale settlement acknowledgement after ${takeover}`, async t => {
    const w = orphanSession()
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'next-slice-ack-race-'))
    w.session.root = root
    t.after(async () => { stopWake(w.session); await w.session.publishNextSliceControl(); await fsp.rm(root, { recursive: true, force: true }) })
    await w.session.publishNextSliceControl()
    const initial = w.session.nextSliceControlView()
    const request = { schema: 1, request_id: 'race_request', instance_id: initial.instance_id, actor_id: initial.actor_id,
      epoch: initial.epoch, goal_id: initial.goal_id, boundary_key: initial.boundary_key, requested_at: Date.now() }
    await fsp.writeFile(path.join(root, '.sgluna/next-slice-settle-request.json'), JSON.stringify(request))
    let release, enter
    const held = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { enter = resolve })
    const command = w.game.command.bind(w.game)
    let projections = 0
    w.game.command = async text => {
      if (text.includes('projection="next_slice_ownership_v1"') && ++projections === 2) { enter(); await held }
      return command(text)
    }
    w.session.pollControllerLiveness()
    await entered
    let replacement
    if (takeover === 'new_pretrace_intake') w.agent.requestAdmissionOwner = { phase: 'intake', held: true }
    if (takeover === 'runtime_replacement') {
      replacement = awWorld(fixture.lanes[0], () => { throw new Error('Unexpected replacement provider call') })
      replacement.agent.controllerBusyCount = 1
      w.session.agent = replacement.agent
    }
    if (takeover === 'native_inconsistent') w.game.craftingStatus = { task_active: true, native_queue: { coal: 1 }, persisted_owner: { operation_id: 9 } }
    const state = w.memory.snapshot()
    const trace = w.agent.traceRequest
    release()
    await settle(w.session)
    await w.session.publishNextSliceControl()
    const view = JSON.parse(await fsp.readFile(path.join(root, '.sgluna/controller-state.json')))
    assert.equal(view.settlement, null)
    assert.equal(w.session.modelResume, null)
    assert.equal(w.calls(), 0)
    if (takeover !== 'native_inconsistent') {
      assert.deepEqual(w.memory.snapshot(), state)
      assert.equal(w.agent.traceRequest, trace)
      assert.equal(view.owned, true)
    }
    if (takeover === 'runtime_replacement') assert.notEqual(view.instance_id, initial.instance_id)
    if (takeover === 'native_inconsistent') assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  })
}

test('missing restored episode and later draft IDs retain the completed-predecessor ledger allowance', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session); await settle(w.session); stopWake(w.session)
  for (let attempt = 1; attempt <= 2; attempt++) assert.equal(w.memory.recordAutoResumeStarted(w.key,
    { ...w.memory.autoResumeAllowance(w.key), request_id: `spent_${attempt}` }).recorded, true)
  const legacy = w.memory.planByNpc.get(w.key)
  legacy.status = 'active'
  w.memory.ensurePlanningDraft(w.key, legacy)
  const snapshot = w.memory.snapshot()
  delete snapshot.planning_states[0].state.run.next_slice
  w.memory.restore(JSON.parse(JSON.stringify(snapshot)))
  const allowance = w.memory.autoResumeAllowance(w.key)
  assert.ok(allowance.plan_id.endsWith('_p7'))
  assert.equal(allowance.step_attempts, 2)
  assert.equal(allowance.goal_attempts, 2)
  assert.equal(allowance.limit_kind, 'step')
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...allowance, request_id: 'forbidden_draft_reset' }).recorded, false)
})
test('a post-completion ledger mark mismatch cannot manufacture verified progress', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session); await settle(w.session); stopWake(w.session)
  const first = w.memory.autoResumeAllowance(w.key)
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...first, request_id: 'spent_one' }).recorded, true)
  w.memory.planningState(w.key).run.auto_resume.steps[0].mark = 'forged_completed_progress'
  const allowance = w.memory.autoResumeAllowance(w.key)
  assert.equal(allowance.limit_kind, 'state')
  assert.equal(allowance.step_attempts, 1)
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...allowance, request_id: 'forbidden_progress_reset' }).recorded, false)
})
test('real verified terminal progress still refreshes only the terminal allowance and keeps the goal total', async () => {
  const w = orphanSession()
  await inspectNextSliceLiveness(w.session); await settle(w.session); stopWake(w.session)
  const allowance = w.memory.autoResumeAllowance(w.key)
  const plan = w.memory.planningState(w.key).plans.at(-1)
  w.memory.planningState(w.key).run.auto_resume = { goal_id: allowance.goal_id, goal_total: 1,
    steps: [{ step_key: allowance.step_key, plan_id: allowance.plan_id, plan_version: allowance.plan_version,
      step_id: allowance.step_id, attempts: 1, mark: 'active|0|0', last_at: plan.execution.step_progress[allowance.step_id].completed_at - 1 }] }
  const progressed = w.memory.autoResumeAllowance(w.key)
  assert.equal(progressed.progressed, true)
  assert.equal(progressed.step_attempts, 0)
  assert.equal(progressed.goal_attempts, 1)
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...progressed, request_id: 'verified_terminal_boundary' }).recorded, true)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 2)
})
for (const cut of ['before_claim', 'after_claim', 'request_owned']) {
  test(`restart at ${cut} automatically continues with the original boundary budget and no draft replay`, async () => {
    const old = orphanSession()
    await inspectNextSliceLiveness(old.session); await settle(old.session); stopWake(old.session)
    if (cut !== 'before_claim') {
      const allowance = old.memory.autoResumeAllowance(old.key)
      old.memory.recordAutoResumeStarted(old.key, { ...allowance, request_id: 'lost_worker' })
      if (cut === 'request_owned') {
        old.memory.dispatchPlanningEvent(old.key, { type: 'RUN_RESUMED', now: Date.now(), source: 'runtime', goal_id: allowance.goal_id, reason: 'lost_worker' })
        old.memory.recordNextSliceTransition(old.key, { phase: 'request_owned', boundary_key: allowance.boundary_key, owner: { request_id: 'lost_worker' } })
      }
    }
    const snapshot = JSON.parse(JSON.stringify(old.memory.snapshot()))
    const valid = planReply({ plan: ['Gather ten coal after restart'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
    const w = awWorld(fixture.lanes[0], () => valid)
    w.memory.restore(snapshot)
    const before = structuredClone(w.memory.planningState(w.key).plans)
    assert.deepEqual(JSON.parse(JSON.stringify(before)), fixture.lanes[0].snapshot.planning_states[0].state.plans)
    const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: w.game.status.actor_id, epoch: w.game.status.epoch })
    try {
      await session.queueEvent(async () => null); await settle(session)
      const pending = session.modelResume
      assert.ok(pending)
      clearTimeout(pending.timer); pending.timer = null
      await session.fireModelResume(pending.token); await settle(session)
      assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, cut === 'before_claim' ? 1 : 2)
      assert.deepEqual(w.memory.planningState(w.key).plans.slice(0, 5), before)
      assert.equal(w.game.mutations.length, 1)
      assert.equal(w.geometryReads(), 0)
    } finally { stopWake(session) }
  })
}

test('late claimed-wake cancellation diagnostic cannot charge or sequence a newer pretrace intake', async () => {
  const w = orphanSession()
  await w.session.queueEvent(async () => null); await settle(w.session)
  const pending = w.session.modelResume
  assert.ok(pending)
  clearTimeout(pending.timer); pending.timer = null
  let release, enter
  const held = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { enter = resolve })
  const persist = w.agent.persistState.bind(w.agent)
  let first = true
  w.agent.persistState = async options => { if (options?.strict && first) { first = false; enter(); await held }; return persist(options) }
  const fired = w.session.fireModelResume(pending.token)
  await entered
  const token = { phase: 'intake', held: true }
  w.agent.requestAdmissionOwner = token
  w.agent.traceRequest = { id: 'new_question_before_base', seq: 0 }
  w.agent.baseMessages = [{ role: 'user', content: 'newer request prefix' }]
  const trace = structuredClone(w.agent.traceRequest)
  const state = w.memory.snapshot()
  const base = structuredClone(w.agent.baseMessages)
  const budgets = [w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining]
  try {
    release(); await fired; await settle(w.session)
    assert.deepEqual(w.agent.traceRequest, trace)
    assert.equal(w.agent.requestAdmissionOwner, token)
    assert.deepEqual(w.agent.baseMessages, base)
    assert.deepEqual(w.memory.snapshot(), state)
    assert.deepEqual([w.agent.reasoningBudgetOverride, w.agent.observationBudgetOverride, w.agent.observationBudgetRemaining], budgets)
    assert.equal(w.calls(), 0)
  } finally { stopWake(w.session) }
})

for (const journalKind of ['admitting', 'uncertain', 'malformed', 'missing', 'nested_records', 'empty_array', 'empty_lua', 'late_identity', 'first_admitting', 'first_missing', 'late_state', 'malformed_terminal_slots', 'nested_terminal_fingerprint', 'oversized_terminal_fingerprint']) {
  test(`real Session residual with native journal ${journalKind} and empty host ledger cannot infer idle permission`, async t => {
    const w = orphanSession()
    assert.equal(w.memory.pendingOperations(w.key).length, 0)
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'next-slice-native-journal-'))
    w.session.root = root
    t.after(async () => { stopWake(w.session); await w.session.publishNextSliceControl(); await fsp.rm(root, { recursive: true, force: true }) })
    await w.session.publishNextSliceControl()
    const view = w.session.nextSliceControlView()
    await fsp.writeFile(path.join(root, '.sgluna/next-slice-settle-request.json'), JSON.stringify({ schema: 1,
      request_id: 'native_journal_request', instance_id: view.instance_id, goal_id: view.goal_id,
      actor_id: view.actor_id, epoch: view.epoch, boundary_key: view.boundary_key, requested_at: Date.now() }))
    const command = w.game.command.bind(w.game)
    let projections = 0
    const record = { operation_key: 'native/batch_1', attempt_id: 'native_attempt_1', signature: 'a'.repeat(64), ordinal: 1,
      actor_id: w.game.status.actor_id, epoch: w.game.status.epoch, generation: 1, operation_count: 1, tick: 1000,
      state: 'completed', slots: [{ index: 1, ok: true, batch_refs: [] }] }
    w.game.command = async text => {
      const raw = await command(text)
      if (!text.includes('projection="next_slice_ownership_v1"')) return raw
      projections++
      const value = JSON.parse(raw)
      if (['admitting', 'uncertain'].includes(journalKind)) value.operations.admission_journal = [{ ...record, state: journalKind, slots: {} }]
      if (journalKind === 'malformed') value.operations.admission_journal = [{ state: 'uncertain' }]
      if (journalKind === 'missing') delete value.operations.admission_journal
      if (journalKind === 'nested_records') value.operations.admission_journal = { records: [] }
      if (journalKind === 'empty_array') value.operations.admission_journal = []
      if (journalKind === 'empty_lua') value.operations.admission_journal = {}
      if (journalKind === 'late_identity') value.operations.admission_journal = [{ ...record, attempt_id: projections === 1 ? 'native_attempt_1' : 'native_attempt_2' }]
      if (journalKind === 'first_admitting') value.operations.admission_journal = projections === 1 ? [{ ...record, state: 'admitting', slots: {} }] : []
      if (journalKind === 'first_missing') { if (projections === 1) delete value.operations.admission_journal; else value.operations.admission_journal = [] }
      if (journalKind === 'late_state') value.operations.admission_journal = [{ ...record, state: projections === 1 ? 'completed' : 'uncertain' }]
      if (journalKind === 'malformed_terminal_slots') value.operations.admission_journal = [{ ...record, operation_count: 2, slots: [record.slots[0], record.slots[0]] }]
      if (journalKind === 'nested_terminal_fingerprint') value.operations.admission_journal = [{ ...record, error: { nested: true } }]
      if (journalKind === 'oversized_terminal_fingerprint') value.operations.admission_journal = [{ ...record, error: 'x'.repeat(513) }]
      return JSON.stringify(value)
    }
    w.session.pollControllerLiveness(); await settle(w.session); await w.session.publishNextSliceControl()
    const published = JSON.parse(await fsp.readFile(path.join(root, '.sgluna/controller-state.json')))
    if (['empty_array', 'empty_lua'].includes(journalKind)) {
      assert.ok(w.session.modelResume)
      assert.equal(published.settlement.native_reconciled, true)
    } else {
      assert.equal(w.session.modelResume, null)
      assert.equal(published.settlement, null)
      assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
    }
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 0)
    assert.equal(w.calls(), 0)
  })
}


test('direct unclaimed startup counts once before model and a settled duplicate claim cannot replenish it', async () => {
  const w = awWorld(fixture.lanes[0], () => {
    assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1, 'strictly counted before every model request')
    return planReply({ plan: ['Gather ten coal toward the existing goal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })
  const before = w.memory.autoResumeAllowance(w.key)
  assert.equal(before.goal_attempts, 0)
  const result = await recoverInterruptedAgentPlan(w.agent, 'offline_startup', {}, { requestId: 'startup_single_claim' })
  assert.equal(result.recovered, true)
  assert.ok(w.calls() > 0)
  assert.equal(w.memory.autoResumeAllowance(w.key).goal_attempts, 1)
  const counted = structuredClone(w.memory.planningState(w.key).run.auto_resume)
  const calls = w.calls()
  assert.equal(w.memory.recordAutoResumeStarted(w.key, { ...before, request_id: 'startup_single_claim' }).recorded, false)
  assert.deepEqual(w.memory.planningState(w.key).run.auto_resume, counted)
  assert.equal(w.calls(), calls)
})
