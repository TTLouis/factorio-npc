import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Session } from './supervisor.mjs'
import { initializeSprintStartupClock, persistSprintLedger, probeSprintStartupClock, STARTUP_CLOCK_COMMAND, TICK_SPRINT } from './tick-sprint.mjs'

const binding = { profile: 'accelerated', run_id: 'test-startup-clock', source_sha: 'a'.repeat(40) }
const recorded = JSON.parse(readFileSync(new URL('./fixtures/run-ap-startup-clock.json', import.meta.url), 'utf8'))

function nativeClock() {
  const state = { tick: 100, paused: true, speed: 1, humans: 0, idle: true, autoPaused: true }
  let wall = 0
  const calls = []
  const rcon = { command: async command => {
    calls.push(command)
    if (command.includes('game.tick_paused=true')) {
      state.paused = true; state.speed = 1
      return JSON.stringify({ version: TICK_SPRINT.version, speed: 1, tick_paused: true })
    }
    if (command.includes('game.tick_paused=false')) state.paused = false
    if (!state.paused) state.tick++ // Native console traffic advances ticks even while auto-paused.
    if (command === recorded.rejected_command) return recorded.native_reply
    return JSON.stringify(state)
  } }
  const probeOptions = { monotonic: () => wall, sleep: async ms => {
    wall += ms
    if (!state.autoPaused && !state.paused) state.tick += ms * 60 / 1000
  } }
  return { state, rcon, calls, probeOptions }
}

test('exact Run AP baseline: rejected config plus positive RCON-driven tick delta falsely passed the old proof', async () => {
  const w = nativeClock()
  assert.equal(await w.rcon.command(recorded.rejected_command), 'Unknown config: auto-pause\n')
  await w.rcon.command('/silent-command game.tick_paused=false')
  const before = JSON.parse(await w.rcon.command(STARTUP_CLOCK_COMMAND))
  await w.probeOptions.sleep(250)
  const after = JSON.parse(await w.rcon.command(STARTUP_CLOCK_COMMAND))
  assert.ok(after.tick > before.tick, 'historical assertion accepted a console-driven tick')
  assert.equal(w.state.autoPaused, true)
  assert.ok(recorded.observed_tick_delta / recorded.observed_wall_ms * 1000 < 30)
  await assert.rejects(probeSprintStartupClock(w.rcon, w.probeOptions), { code: 'sprint_startup_clock_stalled' })
  assert.equal(w.state.paused, true)
  assert.equal(w.state.speed, 1)
})

async function initialize(w, { restart, load = async () => null, persist = async () => {}, record } = {}) {
  return initializeSprintStartupClock({ rcon: () => w.rcon, binding,
    restartAtNormalSpeed: restart ?? (async () => { w.state.autoPaused = false }),
    load, persist, record, probeOptions: w.probeOptions })
}

test('prevention reloads the replicated paused world before proving an independent clock; no unsupported config command', async () => {
  const w = nativeClock(); let restarts = 0
  const proof = await initialize(w, { restart: async () => {
    assert.equal(w.state.paused, true); assert.equal(w.state.speed, 1)
    restarts++; w.state.autoPaused = false
  } })
  assert.equal(restarts, 1)
  assert.ok(proof.native_tick_delta >= 60)
  assert.equal(w.state.paused, true)
  assert.equal(w.calls.some(text => text.startsWith('/config')), false)
})

test('injected residual settings miss is detected, durably spent once and automatically continued', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-clock-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const ledger = path.join(dir, 'recovery.json')
  const w = nativeClock(); const events = []; let restarts = 0
  const proof = await initialize(w, {
    restart: async () => {
      assert.equal(w.state.paused, true)
      if (++restarts === 2) {
        assert.equal(JSON.parse(await fs.readFile(ledger, 'utf8')).attempts, 1)
        w.state.autoPaused = false
      }
    }, persist: value => persistSprintLedger(ledger, value), record: value => events.push(value.reason),
  })
  assert.ok(proof.native_tick_delta >= 60)
  assert.deepEqual(events, ['startup_clock_recovery_attempted', 'startup_clock_recovery_completed'])
  assert.equal(restarts, 2)
  assert.equal(w.state.paused, true)
})

test('residual exhaustion survives restaging and cannot refill the durable recovery allowance', async () => {
  const w = nativeClock(); let saved; let restarts = 0
  const options = { restart: async () => { restarts++ }, load: async () => saved, persist: async value => { saved = structuredClone(value) } }
  await assert.rejects(initialize(w, options), /recovery exhausted/)
  assert.equal(restarts, 2); assert.equal(saved.attempts, 1)
  assert.equal(saved.state, 'exhausted')
  w.state.autoPaused = false
  await assert.rejects(initialize(w, options), /recovery exhausted/)
  assert.equal(restarts, 2, 'an exhausted run cannot reopen even with a healthy clock on restage')
  assert.equal(saved.attempts, 1); assert.equal(w.state.paused, true)
})

for (const [field, value] of [['humans', 1], ['idle', false], ['speed', 4]]) test(`unsafe ${field} cannot authorize a clock correction`, async () => {
  const w = nativeClock(); w.state[field] = value
  let saved = 0; let restarts = 0
  await assert.rejects(initialize(w, { restart: async () => {
    restarts++; w.state[field] = value
  }, persist: async () => { saved++ } }), /unsafe/)
  assert.equal(restarts, 1); assert.equal(saved, 0)
  assert.equal(w.state.paused, true); assert.equal(w.state.speed, 1)
})

test('disk failure before residual correction stays paused and cannot restart or construct an agent', async () => {
  const w = nativeClock(); let restarts = 0
  await assert.rejects(initialize(w, { restart: async () => { restarts++ }, persist: async () => { throw new Error('disk failed') } }), /disk failed/)
  assert.equal(restarts, 1); assert.equal(w.state.paused, true)
})

test('actual Session startup cannot construct/wake the NPC when the clock correction is exhausted', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-session-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const names = ['SGLUNA_E2E_PROFILE', 'SGLUNA_E2E_RUN_ID', 'SGLUNA_E2E_SOURCE_SHA']
  const previous = names.map(name => process.env[name])
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i] }))
  Object.assign(process.env, { SGLUNA_E2E_PROFILE: binding.profile, SGLUNA_E2E_RUN_ID: binding.run_id, SGLUNA_E2E_SOURCE_SHA: binding.source_sha })
  const w = nativeClock(); let calls = 0
  const session = new Session({ root: dir, app: dir, game: dir, config: { gamePort: 12345, factorio: {}, stopMs: 1000 },
    save: 'fixture', settingsFile: 'fixture', modDir: 'fixture', ini: 'fixture', rcon: { port: 12346, password: 'fixture' },
    provider: async () => { calls++; throw new Error('Provider forbidden before startup proof') }, log: () => {} })
  session.startGameProcess = async () => { session.rcon = w.rcon }
  session.restartPausedSprintGame = async () => {}
  await assert.rejects(session.start(), /recovery exhausted/)
  assert.equal(session.agent, null); assert.equal(calls, 0); assert.equal(session.ready, false)
  assert.equal(w.state.paused, true)
})
