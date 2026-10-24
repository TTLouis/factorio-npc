import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { aoWorld } from './run-ao-fixture.mjs'
import { TickSprintController, sprintSpeedValid, summarizeTickSprints, TICK_SPRINT } from './tick-sprint.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'

const binding = { profile: 'accelerated', run_id: 'test-ap', source_sha: 'a'.repeat(40) }

test('registered native player-join handler invokes arrival safety before optional UI/player lookup', async () => {
  const source = await fs.readFile(new URL('../../../packages/autorio/src/task_board_ui.ts', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('script.on_event(defines.events.on_player_joined_game,'))
  assert.ok(handler.indexOf("remote.call('sgluna_tick_sprint', 'safety_event', 'player_joined_game')") >= 0)
  assert.ok(handler.indexOf("remote.call('sgluna_tick_sprint', 'safety_event', 'player_joined_game')") < handler.indexOf('game.get_player(event.player_index)'))
})

async function world({ persist, emit, readHook, sleep, timers = false } = {}) {
  const w = await aoWorld()
  let clock = 10000
  const guard = { version: TICK_SPRINT.version, phase: 'construction', speed: 1, tick: 10, binding, episodes: {} }
  const native = w.game.command.bind(w.game)
  const calls = []
  const command = async text => {
    calls.push(text)
    await readHook?.(w, text)
    if (text.includes('SPRINT_BOUNDARY_')) {
      const marker = /SPRINT_BOUNDARY_[a-f0-9-]+:/.exec(text)[0]
      const last = /s.last.lease_id=='([^']*)'/.exec(text)?.[1]
      const executed = guard.speed === 1 && !guard.lease && (!guard.last || guard.last.lease_id === last)
      const proof = JSON.stringify({ guard: structuredClone(guard), executed })
      const source = text.slice(text.indexOf('if ok then do ') + 14, text.lastIndexOf('\n end end end'))
      return `${marker}${proof}\n${executed ? await native(`/silent-command ${source}`) : ''}`
    }
    if (text.includes('sgluna_tick_sprint')) {
      if (text.includes("'arm'")) {
        const raw = /json_to_table\('(.*)'\)/.exec(text)?.[1]
        const lease = JSON.parse(raw.replaceAll("\\'", "'").replaceAll('\\\\', '\\'))
        guard.lease = { ...lease, start_tick: guard.tick, end_tick: guard.tick + 600 }
        guard.speed = 4
        guard.episodes[lease.episode_id] = (guard.episodes[lease.episode_id] ?? 0) + 600
      }
      if (text.includes("'fail'")) { guard.fault = 'fault'; guard.phase = 'closed' }
      if (text.includes("'finish'") || text.includes("'fail'")) {
        if (guard.lease) guard.last = { ...guard.lease, restored_tick: guard.tick, actual_ticks: guard.tick - guard.lease.start_tick, reason: 'boundary' }
        guard.lease = undefined; guard.speed = 1
      }
      return JSON.stringify({ ok: true, ...guard })
    }
    const result = await native(text)
    if (text.includes('"autorio_operations","status"')) return JSON.stringify({ ...JSON.parse(result),
      active_batch: { batch_ref: 'batch-g1-24', batch_id: 24, batch_generation: 1 } })
    return result
  }
  w.session.rcon.command = command
  const saved = []; const events = []
  const controller = new TickSprintController({ session: w.session, binding, watchdog: { command }, now: () => clock, monotonic: () => clock,
    sleep: async ms => { await sleep?.(w, ms); clock += ms },
    persist: async ledger => { saved.push(structuredClone(ledger)); await persist?.(w) },
    emit: async (event, data) => { events.push({ event, data }); await emit?.(w, event, data) } })
  await controller.start({ timers })
  w.session.tickSprint = controller
  w.agent.tickSprintBoundary = reason => controller.boundary(reason)
  return { ...w, controller, guard, saved, events, calls, advance: ms => { clock += ms; guard.tick += Math.floor(ms * guard.speed * 60 / 1000) } }
}

test('actual AO admitted batch is leased only after strict persistence; public RCON restores and refreshes before read', async () => {
  const w = await world()
  assert.equal(await w.controller.trySprint(), true)
  assert.equal(w.saved.at(-1).episodes['batch-g1-24'], 600)
  assert.equal(w.guard.speed, 4)
  w.advance(200)
  const before = w.agent.worldMutationSeq
  await w.session.rcon.command('observation')
  assert.equal(w.guard.speed, 1)
  assert.ok(w.agent.worldMutationSeq > before)
  assert.equal(w.events.findLast(row => row.event === 'restored').data.actual_ticks, 48)
  assert.ok(w.calls.some(text => text.includes('get_inventory_items')))
  assert.equal(w.calls.at(-1), 'observation')
})

for (const field of ['goal_id', 'plan_id', 'step_id']) test(`retained acknowledged operation cannot borrow replacement ${field}`, async () => {
  const w = await world()
  const record = w.agent.memory.pendingOperation(w.agent.activePlanKey())
  w.agent.memory.pendingOperation = () => ({ ...record, [field]: 'replaced' })
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.guard.speed, 1)
})

test('fault persists guard pause and real Session operator-stop queue still cancels; execution remains fenced', async () => {
  const w = await world()
  await w.controller.trySprint()
  await w.controller.fail(new Error('injected watchdog miss'))
  await w.session.eventQueue
  assert.equal(w.guard.speed, 1)
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'guard')
  await assert.rejects(w.controller.boundary('guarded_turn'), /Sprint construction authority closed/)
  assert.equal(w.session.queuePlayerRequest('Louis', 'stop'), true)
  await w.session.eventQueue
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'operator')
  assert.ok(w.calls.some(text => text.includes('"sgluna_deployment","cancel"')))
  assert.equal(await w.controller.trySprint(), false)
})

test('throwing diagnostic writer cannot prevent durable fault pause through Session queue', async () => {
  const w = await world({ emit: (_fixture, event) => { if (event === 'fault') throw new Error('trace disk failed') } })
  await w.controller.trySprint()
  await w.controller.fail(new Error('injected polling failure'))
  await w.session.eventQueue
  assert.equal(w.guard.speed, 1)
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'guard')
  assert.equal(await w.controller.trySprint(), false)
})

test('replacement actor during fresh inventory read cannot acquire old-owner facts', async () => {
  let replace = false
  const w = await world({ readHook: (fixture, text) => {
    if (replace && text.includes('get_inventory_items')) fixture.game.status.actor_id = 20
  } })
  await w.controller.trySprint()
  const record = w.agent.recordHandoffToolFacts.bind(w.agent); let recorded = 0
  w.agent.recordHandoffToolFacts = (...args) => { recorded++; return record(...args) }
  replace = true
  await assert.rejects(w.controller.boundary('provider_response'), /actor identity changed/)
  assert.equal(w.guard.speed, 1)
  assert.equal(recorded, 0)
})

test('durable on-disk episode ledger survives controller restart and rejects corruption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tick-sprint-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const ledgerFile = path.join(dir, 'ledger.json')
  const w = await world()
  w.session.rcon.command = w.controller.raw
  const first = new TickSprintController({ session: w.session, binding, watchdog: {}, ledgerFile })
  await first.start({ timers: false })
  first.episodes['batch-g1-24'] = 3600
  await first.persist({ ...binding, episodes: first.episodes })
  w.session.rcon.command = first.raw
  const next = new TickSprintController({ session: w.session, binding, watchdog: {}, ledgerFile })
  await next.start({ timers: false })
  assert.equal(await next.trySprint(), false)
  assert.equal(next.episodes['batch-g1-24'], 3600)
  await fs.writeFile(ledgerFile, '{broken')
  await assert.rejects(new TickSprintController({ session: w.session, binding, watchdog: {}, ledgerFile }).start({ timers: false }))
})

test('malformed native counter cannot be merged into a fresh host allowance', async () => {
  const w = await world()
  w.guard.episodes['batch-g1-24'] = 101
  w.session.rcon.command = w.controller.raw
  const controller = new TickSprintController({ session: w.session, binding, watchdog: {}, persist: async () => {} })
  await assert.rejects(controller.start({ timers: false }), /Native sprint ledger unreadable/)
  assert.equal(w.guard.speed, 1)
})

test('sprint metrics deduplicate leases and cumulative polling without claiming measured savings', () => {
  const start = { event: 'sprint.started', data: { lease_id: 'lease', polling_instance_id: 'host', native_reads_by_lane: { arm: 2 } } }
  const restored = { event: 'sprint.restored', data: { lease_id: 'lease', actual_ticks: 120, native_checks: 121,
    host_observed_lease_wall_ms: 600, polling_instance_id: 'host', native_reads_by_lane: { arm: 2, identity_refresh: 2 } } }
  const summary = summarizeTickSprints([start, restored, start])
  assert.equal(summary.burst_count, 1)
  assert.equal(summary.actual_sprint_ticks, 120)
  assert.equal(summary.measured_sprint_wall_ms, null)
  assert.equal(summary.host_observed_lease_wall_ms, 600)
  assert.equal(summary.estimated_1x_equivalent_ms, 2000)
  assert.equal(summary.harness_native_reads_by_lane.identity_refresh, 2)
  const incomplete = summarizeTickSprints([start])
  assert.equal(incomplete.actual_sprint_ticks, null)
  assert.equal(incomplete.native_tick_guard_checks, null)
  assert.equal(incomplete.telemetry_complete, false)
  assert.equal(incomplete.estimated_saving_lower_bound_ms, null)
})

test('native completion callback barrier automatically corrects a residual active lease before settlement/next admission', async () => {
  const w = await world()
  await w.controller.trySprint()
  w.advance(100)
  await w.close()
  assert.equal(w.guard.speed, 1)
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.events.filter(row => row.event === 'restored').length, 1)
  assert.equal(w.agent.controllerBusyCount, 0)
})

for (const reason of ['busy_turn', 'queued', 'paused', 'pending_prediction', 'uncertain', 'no_batch']) test(`sprint refuses ${reason}`, async () => {
  const w = await world()
  if (reason === 'busy_turn') w.agent.controllerBusyCount = 1
  if (reason === 'queued') w.session.controllerQueuedEvents = 1
  if (reason === 'paused') await w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' })
  if (reason === 'pending_prediction') w.agent.contractPrediction = { settled: false }
  if (reason === 'uncertain') w.agent.memory.pendingOperation = () => ({ state: 'unreconciled' })
  if (reason === 'no_batch') w.agent.batchInFlight = false
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.guard.speed, 1)
  assert.equal(w.events.some(row => row.event === 'started'), false)
})

test('request replacement while persisting cannot arm or charge replacement', async () => {
  let armed = false
  const w = await world({ persist: fixture => { if (armed) fixture.agent.traceRequest = { id: 'replacement', usage: {} } } })
  armed = true
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.guard.speed, 1)
  assert.deepEqual(w.agent.traceRequest.usage, {})
})

test('persistence failure prevents speed change and independent watchdog restores an armed lease before wall cap', async () => {
  const bad = await world()
  bad.controller.persist = async () => { throw new Error('disk failed') }
  await assert.rejects(bad.controller.trySprint(), /disk failed/)
  assert.equal(bad.guard.speed, 1)
  const w = await world()
  await w.controller.trySprint()
  w.advance(2000)
  await w.controller.watchdogTick()
  assert.equal(w.guard.speed, 1)
  assert.equal(w.controller.lease, undefined)
})

test('bounded episodes cannot refill on duplicate probes or restages', async () => {
  const w = await world()
  for (let i = 0; i < 6; i++) {
    assert.equal(await w.controller.trySprint(), true)
    assert.equal(await w.controller.trySprint(), false)
    await w.controller.boundary('restage')
  }
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.saved.at(-1).episodes['batch-g1-24'], 3600)
  assert.equal(w.events.at(-1).event, 'refused')
})

test('runner/external speed policy requires the exact current lease and rejects normal4x and forged/expired owners', () => {
  const now = 10000
  const lease = { ...binding, actor_id: 19, epoch: 1, goal_id: 'goal', plan_id: 'plan', plan_version: 1,
    board_step_id: 'step_1', lease_id: 'lease', episode_id: 'batch-g1-24', batch_ref: 'batch-g1-24',
    start_tick: 100, end_tick: 700, wall_started_ms: now - 100, wall_deadline_ms: now + 2900 }
  const snapshot = { speed: 4, tick: 101, actor_id: 19, epoch: 1, goal_id: 'goal', plan_id: 'plan', plan_version: 1, board_step_id: 'step_1', active_batch_ref: 'batch-g1-24',
    sprint_guard: { speed: 4, phase: 'construction', binding, version: TICK_SPRINT.version, lease } }
  const policy = { profile: 'accelerated', runId: binding.run_id, sourceSha: binding.source_sha, now }
  assert.equal(sprintSpeedValid(snapshot, policy), true)
  assert.equal(sprintSpeedValid(snapshot), false)
  for (const field of ['actor_id', 'epoch', 'goal_id', 'plan_id', 'plan_version', 'board_step_id', 'active_batch_ref', 'tick']) {
    assert.equal(sprintSpeedValid({ ...snapshot, [field]: 'forged' }, policy), false, field)
  }
  assert.equal(sprintSpeedValid(snapshot, { ...policy, now: now + 4000 }), false)
  assert.equal(sprintSpeedValid({ ...snapshot, sprint_guard: {} }, policy), false)
})

const at = JSON.parse(await fs.readFile(new URL('./fixtures/run-at-polling.json', import.meta.url), 'utf8'))

test('checker detects exact uncorrelated AT fault and exhausted recovery while accepting verified recovery phases', () => {
  assert.equal(analyzeBehaviorTrace([at.fault]).findings[0].signature, 'sprint_polling_budget_unrecovered')
  const rows = ['attempted', 'completed'].map((phase, i) => ({ event: `sprint.polling_recovery_${phase}`, ts: new Date(i * 1000).toISOString(), data: { request_id: 'req' } }))
  assert.equal(analyzeBehaviorTrace(rows).findings.length, 0)
  assert.equal(summarizeTickSprints(rows).polling_recovery.completed, 1)
  assert.equal(analyzeBehaviorTrace([{ ...rows[0], event: 'sprint.polling_recovery_exhausted' }]).findings.length, 1)
})

test('Run AT exact polling failure: repeated public boundaries confirm native1x without6152 redundant finish RPCs', async () => {
  assert.equal(at.fault.data.reason, 'Sprint harness polling budget exhausted')
  assert.equal(at.fault.data.native_reads_by_lane.boundary_restore, 6152)
  const w = await world()
  for (let i = 0; i < at.fault.data.native_reads_by_lane.boundary_restore; i++) {
    await w.session.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_inventory_items")))')
  }
  assert.equal(w.controller.fault, undefined)
  assert.equal(w.controller.reads.boundary_restore ?? 0, 0)
  assert.equal(w.controller.reads.boundary_inline, 6152)
  assert.equal(w.controller.bucketReads, 1)
  assert.equal(w.guard.speed, 1)
})

test('Run AT injected residual saturation in real native callback restores, waits, refreshes and automatically continues once', async () => {
  const w = await world()
  await w.controller.trySprint()
  const spent = w.saved.at(-1).episodes['batch-g1-24']
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await w.close()
  assert.equal(w.guard.speed, 1)
  assert.equal(w.controller.fault, undefined)
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.controller.recovery.state, 'completed')
  assert.equal(w.saved.at(-1).episodes['batch-g1-24'], spent)
  assert.equal(await w.controller.trySprint(), false)
  const completed = w.events.filter(row => row.event === 'polling_recovery_completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].data.emergency_reads, 4)
  assert.equal(completed[0].data.disposition, 'continue_at_1x')
  assert.ok(completed[0].data.request_id)
  assert.ok(completed[0].data.step_id)
  assert.ok(w.calls.filter(text => text.includes('get_inventory_items')).length >= 2)
})

test('inline native proof withholds an untracked lease payload and repairs before exactly one execution', async () => {
  const w = await world()
  await w.controller.trySprint()
  w.controller.lease = undefined // injected missed host prevention, native is authoritative
  const before = w.game.mutations.length
  await w.session.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_inventory_items")))')
  assert.equal(w.guard.speed, 1)
  assert.equal(w.controller.reads.boundary_inline, 2)
  assert.equal(w.events.filter(row => row.event === 'restored').length, 1)
  assert.equal(w.game.mutations.length, before)
})

test('inline response from a superseded request is rejected without poisoning its replacement', async () => {
  let inject = false
  const w = await world({ readHook: (f, text) => {
    if (inject && text.includes('SPRINT_BOUNDARY_')) { inject = false; f.agent.traceRequest = { id: 'inline-replacement', usage: {} } }
  } })
  inject = true
  await assert.rejects(w.session.rcon.command('/silent-command rcon.print("stale")'), /owner superseded/)
  assert.equal(w.controller.fault, undefined)
  assert.equal(w.agent.traceRequest.id, 'inline-replacement')
  await w.controller.boundary('guarded_turn')
})

test('sprint eligibility saturation also enters shared recovery without arming or resetting allowance', async () => {
  const w = await world()
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.controller.recovery.state, 'completed')
  assert.equal(w.events.some(row => row.event === 'started'), false)
  assert.deepEqual(w.controller.episodes, {})
})

test('arm-budget miss preserves spent episode and recovers without issuing native arm', async () => {
  let saturate = false
  const w = await world({ persist: () => { if (saturate) w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute } })
  saturate = true
  assert.equal(await w.controller.trySprint(), false)
  assert.equal(w.controller.recovery.state, 'completed')
  assert.equal(w.saved.at(-1).episodes['batch-g1-24'], 600)
  assert.equal(w.guard.episodes['batch-g1-24'], undefined)
})

test('confirmed native-busy batch continues at1x and post-wait inventory replaces stale facts without replay', async () => {
  const w = await world({ sleep: f => { f.game.inventory['iron-plate'] = 987 } })
  const recorded = []
  const original = w.agent.recordHandoffToolFacts.bind(w.agent)
  w.agent.recordHandoffToolFacts = (name, answer) => { recorded.push(answer); return original(name, answer) }
  const pending = structuredClone(w.agent.memory.pendingOperation(w.agent.activePlanKey()))
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await w.controller.boundary('provider_response')
  assert.equal(w.game.taskState, 'moving_items')
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.agent.memory.pendingOperation(w.agent.activePlanKey()), pending)
  assert.ok(recorded.at(-1).includes('987'))
})

test('stalled monotonic rollover is bounded and exhausts visibly', async () => {
  const w = await world()
  w.controller.sleep = async () => {}
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'), /wait exhausted/)
  await w.session.eventQueue
  assert.equal(w.controller.recovery.state, 'exhausted')
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'guard')
})

test('watchdog saturation restores on independent emergency lane before recovery wait', async () => {
  let guard
  const w = await world({ sleep: () => { assert.equal(guard.speed, 1) } })
  guard = w.guard
  await w.controller.trySprint()
  w.advance(2000)
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await w.controller.watchdogTick()
  assert.equal(w.controller.recovery.state, 'completed')
  assert.equal(w.controller.watchBusy, false)
})

test('saturated watchdog restores native1x independently of a held primary serial barrier', async () => {
  const w = await world()
  await w.controller.trySprint()
  w.advance(2000)
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  let release
  w.controller.tail = new Promise(resolve => { release = resolve })
  const pending = w.controller.watchdogTick()
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(w.guard.speed, 1, 'native wall safety precedes primary serial release')
    assert.equal(w.controller.reads.wall_budget_emergency, 1)
  } finally { release() }
  await pending
  assert.equal(w.controller.recovery.state, 'completed')
})

test('second residual exhaustion is explicit durable guard pause, not another allowance', async () => {
  const w = await world()
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await w.controller.boundary('native_callback')
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'), /polling recovery exhausted/)
  await w.session.eventQueue
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'guard')
  assert.equal(w.events.filter(row => row.event === 'polling_recovery_attempted').length, 1)
  assert.equal(w.guard.speed, 1)
})

for (const atAwait of ['persist', 'trace', 'inventory', 'wait', 'completion_trace']) test(`replacement during recovery ${atAwait} cannot cancel or pause replacement`, async () => {
  let inject = false
  const replace = w => { if (inject) { inject = false; w.agent.traceRequest = { id: 'replacement', usage: {} } } }
  const w = await world({
    persist: f => { if (atAwait === 'persist') replace(f) },
    emit: (f, event) => { if (atAwait === 'trace' && event === 'polling_recovery_attempted'
      || atAwait === 'completion_trace' && event === 'polling_recovery_completed') replace(f) },
    readHook: (f, text) => { if (atAwait === 'inventory' && text.includes('get_inventory_items')) replace(f) },
    sleep: f => { if (atAwait === 'wait') replace(f) },
  })
  inject = true
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'), /superseded/)
  await w.session.eventQueue
  assert.equal(w.agent.traceRequest?.id, 'replacement')
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey())?.paused ?? false, false)
  assert.equal(w.controller.recovery.state, 'superseded')
  assert.equal(w.controller.fault, undefined)
  await w.controller.boundary('guarded_turn')
  assert.equal(w.agent.traceRequest?.id, 'replacement')
  assert.equal(w.game.mutations.length, 1)
})

test('operator stop during bounded polling wait releases barrier at first100ms wake and preserves operator pause', async () => {
  let stop = true; let sleeps = 0
  const w = await world({ sleep: f => { sleeps++; if (stop) { stop = false; f.session.queuePlayerRequest('Louis', 'stop') } } })
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'), /superseded/)
  await w.session.eventQueue
  assert.equal(sleeps, 1)
  assert.equal(w.agent.memory.pauseRecord(w.agent.activePlanKey()).pause_class, 'operator')
  assert.equal(w.guard.speed, 1)
  assert.equal(w.game.mutations.length, 1)
})

test('registered timer rejection cannot recapture and fault the replacement owner', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let replaced = false
  const w = await world({ timers: true, sleep: f => {
    if (!replaced) { replaced = true; f.agent.traceRequest = { id: 'timer-replacement', usage: {} } }
  } })
  t.after(() => { clearInterval(w.controller.poll); clearInterval(w.controller.watch) })
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  t.mock.timers.tick(TICK_SPRINT.pollMs)
  for (let i = 0; i < 20 && !replaced; i++) await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 20 && w.controller.probe; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(replaced, true)
  assert.equal(w.controller.fault, undefined)
  assert.equal(w.agent.traceRequest?.id, 'timer-replacement')
  await w.controller.boundary('guarded_turn')
  assert.equal(w.controller.fault, undefined)
})

test('shutdown during recovery wait skips cooldown and releases watchdog without delaying save boundary', async () => {
  let sleeps = 0; let shutdown
  const w = await world({ sleep: f => {
    sleeps++
    if (!shutdown) { f.session.stopping = true; shutdown = w.controller.stop('shutdown') }
  } })
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'), /superseded/)
  await shutdown
  assert.equal(sleeps, 1)
  assert.equal(w.guard.speed, 1)
  assert.equal(w.controller.fault, undefined)
})

for (const fence of ['uncertain', 'amendment', 'paused', 'actor_changed', 'unreadable', 'trace_failed', 'persist_failed']) test(`polling residual fails safely for ${fence}`, async () => {
  const w = await world()
  if (fence === 'uncertain') w.agent.memory.pendingOperation = () => ({ state: 'unreconciled' })
  if (fence === 'amendment') w.agent.currentPendingAmendment = () => ({ state: 'pending' })
  if (fence === 'paused') await w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' })
  if (fence === 'actor_changed') w.game.status.actor_id = 20
  if (fence === 'unreadable') w.controller.watchdog.command = async () => '{broken'
  if (fence === 'trace_failed') w.controller.emit = async () => { throw new Error('trace failed') }
  if (fence === 'persist_failed') w.controller.persist = async () => { throw new Error('persist failed') }
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await assert.rejects(w.controller.boundary('native_callback'))
  await w.session.eventQueue
  assert.equal(w.controller.fault !== undefined, true)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.some(row => row.event === 'polling_recovery_completed'), false)
})

test('durable completed recovery disables restart acceleration; interrupted recovery cannot restart or refill', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'at-polling-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const ledgerFile = path.join(dir, 'ledger.json')
  const w = await world()
  w.controller.bucketReads = TICK_SPRINT.maxControlReadsPerMinute
  await w.controller.boundary('native_callback')
  const saved = w.saved.at(-1)
  for (const state of ['completed', 'superseded', 'attempted', 'exhausted']) {
    await fs.writeFile(ledgerFile, JSON.stringify({ ...saved, polling_recovery: { ...saved.polling_recovery, state } }))
    w.session.rcon.command = w.controller.raw
    const next = new TickSprintController({ session: w.session, binding, watchdog: {}, ledgerFile })
    if (['completed', 'superseded'].includes(state)) {
      await next.start({ timers: false })
      assert.equal(await next.trySprint(), false)
      assert.equal(next.recovery.attempts, 1)
    } else await assert.rejects(next.start({ timers: false }), /recovery exhausted after restart/)
  }
})
