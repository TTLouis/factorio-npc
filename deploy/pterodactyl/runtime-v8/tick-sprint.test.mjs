import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { aoWorld } from './run-ao-fixture.mjs'
import { TickSprintController, sprintSpeedValid, summarizeTickSprints, TICK_SPRINT } from './tick-sprint.mjs'

const binding = { profile: 'accelerated', run_id: 'test-ap', source_sha: 'a'.repeat(40) }

test('registered native player-join handler invokes arrival safety before optional UI/player lookup', async () => {
  const source = await fs.readFile(new URL('../../../packages/autorio/src/task_board_ui.ts', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('script.on_event(defines.events.on_player_joined_game,'))
  assert.ok(handler.indexOf("remote.call('sgluna_tick_sprint', 'safety_event', 'player_joined_game')") >= 0)
  assert.ok(handler.indexOf("remote.call('sgluna_tick_sprint', 'safety_event', 'player_joined_game')") < handler.indexOf('game.get_player(event.player_index)'))
})

async function world({ persist, emit, readHook } = {}) {
  const w = await aoWorld()
  let clock = 10000
  const guard = { version: TICK_SPRINT.version, phase: 'construction', speed: 1, tick: 10, binding, episodes: {} }
  const native = w.game.command.bind(w.game)
  const calls = []
  const command = async text => {
    calls.push(text)
    await readHook?.(w, text)
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
    persist: async ledger => { saved.push(structuredClone(ledger)); await persist?.(w) },
    emit: async (event, data) => { events.push({ event, data }); await emit?.(w, event, data) } })
  await controller.start({ timers: false })
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
