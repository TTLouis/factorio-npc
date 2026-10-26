import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { ao, aoWorld, preserveAoRepair } from './run-ao-fixture.mjs'
import { CONTROLLER_LIVENESS, inspectControllerLiveness } from './controller-liveness.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { STALE_REPLY_ERROR_CODE, STALE_REPLY_MESSAGE } from './agent-context.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'

async function stranded(options) {
  const w = await aoWorld(options)
  const bind = w.agent.bindActiveStepContract
  w.agent.bindActiveStepContract = async args => {
    await w.agent.traceEvent('plan.contract_call_failed', { request_id: w.agent.traceRequest.id,
      plan_id: args.plan.plan_id, step_id: args.step.step_id, reason: 'stale_prediction_owner_changed' })
    const error = new Error(STALE_REPLY_MESSAGE)
    error.code = STALE_REPLY_ERROR_CODE
    throw error
  }
  w.finishNative()
  w.session.onGameLine('[AUTORIO] All operations completed')
  await w.session.eventQueue
  w.agent.bindActiveStepContract = bind
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.held().steps[1].completion_contract, null)
  assert.equal(w.memory.pauseRecord(ao.key).paused, false, w.memory.pauseRecord(ao.key).pause_reason)
  assert.equal(w.agent.batchInFlight, false)
  assert.equal(w.memory.pendingOperation(ao.key), null)
  assert.equal(w.game.mutations.length, 1)
  return w
}

async function poll(w, now) {
  const clock = Date.now
  Date.now = () => now
  try {
    assert.equal(w.session.pollControllerLiveness(), true)
    assert.equal(w.session.pollControllerLiveness(), false, 'duplicate timers coalesce before the queued probe')
    await w.session.eventQueue
  } finally { Date.now = clock }
}

test('missed AY navigation receipt is reconciled by Session watchdog and automatically continues with native uncertain row retained', async () => {
  const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
  const w = await stranded()
  // Native witness is the retained AY shape; AO supplies the existing real
  // Session next-transition fixture. Only ownership identities are substituted.
  const pending = { ...ay.pending, goal_id: w.held().goal_id, plan_id: w.held().plan_id,
    step_id: w.held().steps[1].step_id, actor: { actor_id: 19, epoch: 1 } }
  const status = structuredClone(ay.native)
  status.admission_journal[0].actor_id = 19
  assert.ok(w.memory.recordPendingOperation(ao.key, pending))
  const original = w.agent.readTaskStatusRaw.bind(w.agent)
  w.agent.readTaskStatusRaw = async () => w.game.mutations.length === 1 ? JSON.stringify(status) : original()
  const now = Date.now()
  await poll(w, now)
  await poll(w, now + CONTROLLER_LIVENESS.idleMs)
  await w.agent.contractPrediction?.flight
  assert.equal(w.memory.pendingOperations(ao.key).some(row => row.operation_key === pending.operation_key), false)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(status.admission_journal[0].state, 'uncertain')
  assert.ok(w.events.some(row => row.event === 'operation.reconciled' && row.data.reason === 'exact_terminal_navigation_cancelled' && row.data.settled))
  assert.ok(w.events.some(row => row.event === 'controller.recovery_completed'))
})

test('request replacement during navigation live-actor read cannot settle replacement work or spend recovery', async () => {
  const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
  let armed = false
  const w = await stranded({ readHook: ({ text, agent }) => {
    if (armed && text.includes('sgluna_deployment')) { armed = false; agent.traceRequest = { id: 'replacement', usage: {} } }
  } })
  const pending = { ...ay.pending, goal_id: w.held().goal_id, plan_id: w.held().plan_id,
    step_id: w.held().steps[1].step_id, actor: { actor_id: 19, epoch: 1 } }
  const status = structuredClone(ay.native); status.admission_journal[0].actor_id = 19
  assert.ok(w.memory.recordPendingOperation(ao.key, pending))
  armed = true
  await assert.rejects(w.agent.settleOutstandingOperation(JSON.stringify(status)), /cancelled|superseded|stale/i)
  assert.equal(w.memory.pendingOperation(ao.key).operation_key, pending.operation_key)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
})

test('injected exact AO missed wake is detected and automatically continues through the real supervisor queue', async () => {
  const w = await stranded()
  const steps = structuredClone(w.held().steps)
  const now = Date.now()
  await poll(w, now)
  await poll(w, now + CONTROLLER_LIVENESS.idleMs)
  await w.agent.contractPrediction?.flight
  assert.equal(w.held().steps[1].contract_binding.binding, 'just_in_time')
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.game.mutations.filter(text => text.includes("'move_items_exact'")).length, 1)
  assert.deepEqual(w.held().steps.map(s => s.description), steps.map(s => s.description))
  assert.equal(w.memory.planningState(ao.key).goal.status, 'active')
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
  assert.ok(w.events.some(row => row.event === 'controller.recovery_completed' && row.data.reason === 'verified_next_transition'))
  assert.equal(analyzeBehaviorTrace(w.events).findings.some(f => f.signature === 'unpaused_idle_controller'), false)
  preserveAoRepair('residual-recovery', w)
})

for (const fence of ['native_busy', 'pending', 'uncertain_journal', 'unreadable', 'condition_wait', 'amendment', 'provider_turn', 'queued_event', 'operator_pause']) {
  test(`idle watchdog respects ${fence} without replay or allowance renewal`, async () => {
    const w = await stranded()
    const now = Date.now()
    await inspectControllerLiveness(w.session, { now })
    if (fence === 'native_busy') { w.game.status.idle = false; w.game.taskState = 'mining'; w.game.queueLength = 1 }
    if (fence === 'pending') w.memory.pendingOperation = () => ({ state: 'unreconciled' })
    if (fence === 'uncertain_journal') w.game.admissionJournal = () => [{ state: 'uncertain' }]
    if (fence === 'unreadable') w.agent.readTaskStatusRaw = async () => '{bad json'
    if (fence === 'condition_wait') w.memory.currentPlan(ao.key).condition_wait = { state: 'active' }
    if (fence === 'amendment') w.agent.currentPendingAmendment = () => ({ text: 'new authorized instructions' })
    if (fence === 'provider_turn') w.agent.controllerBusyCount = 1
    if (fence === 'queued_event') w.session.controllerQueuedEvents = 1
    if (fence === 'operator_pause') await w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' })
    await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
    if (['pending', 'uncertain_journal'].includes(fence)) assert.equal(w.memory.pauseRecord(ao.key).pause_class, 'guard')
    if (fence === 'operator_pause') assert.equal(w.memory.pauseRecord(ao.key).pause_class, 'operator')
  })
}

for (const boundary of ['native_read', 'controller.liveness_checked', 'controller.idle_detected', 'persist', 'controller.recovery_started']) {
  for (const change of ['request', 'goal', 'epoch', 'stop']) {
    test(`${change} replacement during ${boundary} fences idle recovery and replacement state`, async () => {
      let armed = false
      const replace = ({ agent, game, memory, session }) => {
        if (!armed) return
        armed = false
        if (change === 'request') agent.traceRequest = { id: 'replacement-during-idle-probe', usage: {} }
        if (change === 'goal') memory.planningState(ao.key).goal.goal_id = 'replacement-goal'
        if (change === 'epoch') game.status.epoch++
        if (change === 'stop') { session.cancelGeneration++; agent.cancel('user_stop') }
      }
      const w = await stranded({
        traceHook: data => { if (data.row.event === boundary) replace(data) },
        readHook: data => { if (armed && boundary === 'native_read' && data.text.includes('sgluna_deployment')) replace({ ...data, session: w.session }) },
      })
      const now = Date.now()
      await inspectControllerLiveness(w.session, { now })
      if (boundary === 'persist') {
        const persist = w.agent.persistState.bind(w.agent)
        w.agent.persistState = async args => { await persist(args); replace(w) }
      }
      armed = true
      await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
      assert.equal(armed, false, 'replacement happened inside the tested await boundary')
      assert.equal(w.game.mutations.length, 1)
      assert.equal(w.memory.pauseRecord(ao.key).paused, false, 'old guard cannot pause replacement work')
      if (change === 'request') assert.deepEqual(w.agent.traceRequest.usage, {})
    })
  }
}

test('durable idle-recovery bounds survive restage/restore and exhaust into a visible guard pause', async () => {
  const w = await stranded()
  let resumed = 0
  w.session.recoverInterruptedPlan = async () => { resumed++; return null }
  let now = Date.now()
  for (let i = 0; i < CONTROLLER_LIVENESS.perStep; i++) {
    await inspectControllerLiveness(w.session, { now })
    await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
    const snapshot = w.memory.snapshot()
    w.memory.restore(snapshot)
    w.session.controllerIdleCandidate = undefined
    now += CONTROLLER_LIVENESS.idleMs + CONTROLLER_LIVENESS.probeMs
  }
  await inspectControllerLiveness(w.session, { now })
  const final = await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  assert.equal(resumed, CONTROLLER_LIVENESS.perStep)
  assert.equal(final.action, 'paused')
  assert.equal(w.memory.pauseRecord(ao.key).pause_class, 'guard')
  assert.ok(w.chats.some(line => line.includes('paused')))
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, CONTROLLER_LIVENESS.perStep)
  assert.equal(w.game.mutations.length, 1)
  preserveAoRepair('exhaustion', w)
})

test('corrupt persisted controller allowance fails closed instead of restoring a fresh budget', async () => {
  const w = await stranded()
  const snapshot = w.memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore({ ...snapshot, controller_recoveries: [['bad', { attempts: 0, steps: [{ key: 'spent', attempts: 2 }] }]] })
  assert.equal(restored.controllerRecoveryFault, true)
  w.agent.memory = w.memory = restored
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  assert.equal(restored.pauseRecord(ao.key).pause_reason, 'controller_recovery_ledger_unreadable')
  assert.equal(w.game.mutations.length, 1)
})

test('goal recovery cap survives a new slice and restored memory', async () => {
  const w = await stranded()
  const snapshot = w.memory.snapshot()
  const attempts = CONTROLLER_LIVENESS.perGoal
  snapshot.controller_recoveries = [[JSON.stringify([ao.key, ao.goal_id]), { attempts, last_at: Date.now(),
    steps: [1, 2, 3].map(i => ({ key: JSON.stringify([`previous-slice-${i}`, 1, `step-${i}`]), attempts: 2 })) }]]
  w.memory.restore(snapshot)
  assert.equal(w.memory.controllerRecoveryFault, false)
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  const result = await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  assert.equal(result.action, 'paused')
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, attempts)
  assert.equal(w.game.mutations.length, 1)
})

test('strict persistence failure cannot wake or mutate the world', async () => {
  const w = await stranded()
  w.agent.persistState = async () => { throw new Error('disk unavailable') }
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  const result = await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  assert.equal(result.action, 'deferred')
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.some(row => row.event === 'controller.recovery_started'), false)
})

test('contract flight joins only its current owner and old finally cannot delete replacement flight', async () => {
  const w = await stranded()
  const releases = []
  w.agent.bindActiveStepContract = () => new Promise(resolve => releases.push(resolve))
  const first = w.agent.ensureActiveStepContract()
  const same = w.agent.ensureActiveStepContract()
  assert.equal(releases.length, 1)
  w.agent.traceRequest = { id: 'new-contract-flight', usage: {} }
  const next = w.agent.ensureActiveStepContract()
  assert.equal(releases.length, 2)
  releases[0]({ old: true })
  await Promise.all([first, same])
  assert.equal(w.agent.stepContractsInFlight.size, 1)
  releases[1]({ current: true })
  assert.deepEqual(await next, { current: true })
  assert.equal(w.agent.stepContractsInFlight.size, 0)
})

test('idle probes are rate limited and emit read accounting', async () => {
  const w = await stranded()
  w.game.status.idle = false
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs + 1 })
  const probes = w.events.filter(row => row.event === 'controller.liveness_checked')
  assert.equal(probes.length, 1)
  assert.equal(probes[0].data.native_reads, 3)
})

for (const unreadable of [false, true]) test(`persistent follow ${unreadable ? 'unreadable' : 'holding'} is not an idle controller`, async () => {
  const w = await stranded()
  w.agent.active = false
  const command = w.game.command.bind(w.game)
  w.game.command = async text => {
    if (text.includes('"autorio_follow","status"')) {
      if (unreadable) throw new Error('follow status unavailable')
      return JSON.stringify({ active: true, healthy: true, controller_live: true, state: 'holding' })
    }
    return command(text)
  }
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  const result = await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })
  assert.equal(result.action, 'deferred')
  assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
  assert.equal(w.game.mutations.length, 1)
})

for (const status of [null, {}, { error: 'unknown_interface' }]) test(`unreadable persistent status ${JSON.stringify(status)} cannot authorize idle recovery`, async () => {
  const w = await stranded()
  const command = w.game.command.bind(w.game)
  w.game.command = text => text.includes('"autorio_follow","status"') ? JSON.stringify(status) : command(text)
  const now = Date.now()
  await inspectControllerLiveness(w.session, { now })
  assert.equal((await inspectControllerLiveness(w.session, { now: now + CONTROLLER_LIVENESS.idleMs })).action, 'deferred')
  assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
})

for (const replacement of ['cancelled', 'goal']) test(`checker recognizes ${replacement} before an obsolete contract call finally returns`, () => {
  const failure = ao.events.find(row => row.event === 'plan.contract_call_failed')
  const ts = new Date(Date.parse(failure.ts) - 1000).toISOString()
  const rows = [...ao.events, { event: replacement === 'cancelled' ? 'request.cancelled' : 'goal.defined',
    request_id: replacement === 'cancelled' ? failure.request_id : 'new-goal-request', ts,
    data: { goal_id: 'new-goal' } }]
  // Original AO failure row did not carry goal_id; correlate its actual plan.
  rows.push({ event: 'plan.persisted', request_id: failure.request_id, ts,
    data: { goal_id: ao.goal_id } })
  assert.equal(analyzeBehaviorTrace(rows).findings.some(row => row.signature === 'unpaused_idle_controller'), false)
})

for (const event of ['goal.paused', 'request.cancelled', 'provider.request']) test(`checker accepts timely ${event} but retains the original prolonged stall`, () => {
  const failure = ao.events.find(row => row.event === 'plan.contract_call_failed')
  const ts = new Date(Date.parse(failure.ts) + 1000).toISOString()
  const continuation = { event, request_id: failure.request_id, ts, data: { goal_id: ao.goal_id } }
  const corrected = [...ao.events, continuation]
  assert.equal(analyzeBehaviorTrace(corrected).findings.some(row => row.signature === 'unpaused_idle_controller'), false)
  assert.equal(analyzeBehaviorTrace(ao.events).findings.some(row => row.signature === 'unpaused_idle_controller'), true)
})

for (const boundary of ['factorio.completed_signal', 'native_receipt', 'factorio.status']) test(`receipt callback cannot mutate replacement at ${boundary}`, async () => {
  let armed = false
  const replace = agent => {
    if (!armed) return
    armed = false
    agent.traceRequest = { id: 'replacement-receipt', usage: {} }
    agent.batchInFlight = true
  }
  const w = await aoWorld({ traceHook: ({ row, agent }) => { if (row.event === boundary) replace(agent) },
    readHook: ({ text, agent }) => { if (boundary === 'native_receipt' && text.includes('"autorio_operations","status"')) replace(agent) } })
  armed = true
  await assert.rejects(w.close(), error => error.code === STALE_REPLY_ERROR_CODE)
  assert.equal(armed, false)
  assert.equal(w.agent.batchInFlight, true)
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.agent.traceRequest.usage, {})
})

for (const boundary of ['reserve', 'initial_native_read', 'plan.contract_call_attempt']) test(`JIT ownership replacement at ${boundary} cannot bind or call under replacement`, async () => {
  const w = await stranded()
  const calls = w.contracts.length
  const replace = () => { w.agent.traceRequest = { id: 'replacement-jit', usage: {} } }
  if (boundary === 'reserve') w.agent.reserve = async () => { replace() }
  if (boundary === 'initial_native_read') {
    const command = w.game.command.bind(w.game)
    let reads = 0
    w.game.command = async text => {
      const result = await command(text)
      if (text.includes('sgluna_deployment') && ++reads === 3) replace()
      return result
    }
  }
  if (boundary === 'plan.contract_call_attempt') {
    const emit = w.agent.behaviorTrace.emit
    w.agent.behaviorTrace.emit = async row => { await emit(row); if (row.event === boundary) replace() }
  }
  await assert.rejects(w.agent.ensureActiveStepContract(), error => error.code === STALE_REPLY_ERROR_CODE)
  assert.equal(w.agent.traceRequest.id, 'replacement-jit')
  assert.equal(w.held().steps[1].completion_contract, null)
  assert.deepEqual(w.agent.traceRequest.usage, {})
  assert.equal(w.contracts.length - calls, boundary === 'plan.contract_call_attempt' ? 1 : 0)
})

test('failure callback superseded during initial load cannot abort a replacement prediction', async () => {
  const w = await aoWorld()
  const replacement = { controller: new AbortController(), flight: Promise.resolve() }
  w.agent.loadPersistentState = async () => {
    w.agent.traceRequest = { id: 'replacement-failure', usage: {} }
    w.agent.contractPrediction = replacement
  }
  await assert.rejects(w.agent.failed('native refusal'), error => error.code === STALE_REPLY_ERROR_CODE)
  assert.equal(w.agent.contractPrediction, replacement)
  assert.equal(replacement.controller.signal.aborted, false)
  assert.equal(w.game.mutations.length, 1)
})

test('real pending executor request is owned work even when native queues are idle', async () => {
  const w = await stranded()
  let entered; let release
  const started = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const provider = w.agent.provider
  w.agent.provider = async (messages, context) => {
    if (context.triggerSource !== 'step_contract') { entered(); await blocked }
    return provider(messages, context)
  }
  const work = w.agent.runGuarded()
  await started
  const now = Date.now()
  try {
    assert.equal((await inspectControllerLiveness(w.session, { now })).action, 'healthy')
    assert.equal((await inspectControllerLiveness(w.session, { now: now + 60000 })).action, 'healthy')
    assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
  } finally { release(); await work }
})
