/* eslint-disable antfu/no-top-level-await, no-console */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { createSave, prepareServerSettings } from '../pterodactyl/runtime-v8/game-files.mjs'
import { sprintCommand, STARTUP_CLOCK_COMMAND } from '../pterodactyl/runtime-v8/tick-sprint.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const input = path.resolve(arg('save'))
const retained = JSON.parse(await fs.readFile(path.join(results, 'tick-sprint-proof.json'), 'utf8'))
const scenarios = []; let external = 0
globalThis.fetch = async () => { external++; throw new Error('External inference forbidden') }
Object.assign(process.env, { SGLUNA_E2E_PROFILE: retained.binding.profile,
  SGLUNA_E2E_RUN_ID: retained.binding.run_id, SGLUNA_E2E_SOURCE_SHA: retained.binding.source_sha })

async function scenario(name, fault, { existing = false, cold = false, expectedBoots, success } = {}) {
  const root = path.join(results, 'startup-worlds', name)
  await fs.mkdir(path.join(root, 'saves'), { recursive: true })
  await fs.mkdir(path.join(root, '.sgluna/tmp'), { recursive: true })
  await fs.mkdir(path.join(root, 'app/src'), { recursive: true })
  const save = path.join(root, 'saves/input.zip')
  if (!existing && !cold) await fs.copyFile(input, save)
  await fs.writeFile(path.join(root, 'app/src/prompt.md'), 'Deterministic native startup validation. No provider may be called.')
  const ini = path.join(root, 'config.ini')
  await fs.writeFile(ini, `[path]\nread-data=/opt/factorio/data\nwrite-data=${root}\n`)
  if (cold) await createSave(save, '/opt/factorio', arg('mods'), ini, root)
  const config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', AI_API_METHOD: 'local',
    OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: 'fixture',
    SERVER_PORT: arg('game-port'), SHUTDOWN_TIMEOUT_MS: '10000' })
  const settingsFile = await prepareServerSettings(root, '/opt/factorio', config.factorio, { pausedStartup: true })
  const logs = []; const snapshots = []; let boots = 0; let providerCalls = 0
  const session = new Session({ root, app: path.join(root, 'app'), game: '/opt/factorio', config, save,
    settingsFile, modDir: arg('mods'), ini, startupMs: 30000,
    rcon: { port: Number(arg('port')), password: arg('password'), bind: '127.0.0.1' },
    provider: async () => { providerCalls++; throw new Error('Provider forbidden in native startup proof') }, log: line => logs.push(line) })
  const startGame = session.startGameProcess.bind(session)
  session.startGameProcess = async (...args) => {
    boots++
    // Inject a residual settings miss at the actual pre-launch boundary.
    // The shared Session/harness, not the fixture, owns detection and correction.
    if (boots > 1 && (fault === 'always' || fault === 'once' && boots === 2)) {
      const settings = JSON.parse(await fs.readFile(session.settingsFile, 'utf8'))
      settings.auto_pause = true
      await fs.writeFile(session.settingsFile, JSON.stringify(settings))
    }
    await startGame(...args)
    const state = JSON.parse(await session.rcon.command(STARTUP_CLOCK_COMMAND))
    snapshots.push({ boot: boots, state })
    if (boots === 1 && !existing && !cold) {
      assert.equal(state.speed, 4); assert.equal(state.paused, true)
      assert.equal(state.guard.lease.lease_id, retained.saved.lease.lease_id)
      await delay(500)
      const quiet = JSON.parse(await session.rcon.command(STARTUP_CLOCK_COMMAND))
      assert.equal(quiet.tick, state.tick, 'Loaded active lease must remain inert before reconciliation')
    }
  }
  let failure
  try {
    try { await session.start() } catch (error) { failure = error }
    if (success) {
      assert.equal(failure, undefined, failure?.stack)
      if (cold) {
        const confirmations = logs.filter(line => line.startsWith('startup.lua_console_ready '))
          .map(line => JSON.parse(line.slice('startup.lua_console_ready '.length)))
        assert.deepEqual(confirmations.map(value => value.attempts), [2, 1], 'Fresh console refusal and saved-world confirmation must both execute')
      }
      assert.ok(session.startupClockProof.native_tick_delta >= 30)
      const status = JSON.parse(await session.rcon.command(sprintCommand('status')))
      assert.equal(status.speed, 1); assert.equal(status.lease, undefined)
      if (cold) assert.equal(Object.keys(status.episodes).length, 0)
      else assert.deepEqual(status.episodes, retained.saved.episodes)
      const sample = JSON.parse(await session.rcon.command(STARTUP_CLOCK_COMMAND))
      await delay(1000)
      const after = JSON.parse(await session.rcon.command(STARTUP_CLOCK_COMMAND))
      assert.ok(after.tick - sample.tick >= 45, 'Running zero-human server must advance independently near60UPS')
      await session.rcon.command(sprintCommand('seal', 'native_startup_verified'))
      assert.equal(JSON.parse(await session.rcon.command(sprintCommand('configure', retained.binding))).ok, false)
    } else {
      assert.match(failure?.message ?? '', /clock recovery exhausted/)
      assert.equal(session.agent, null, 'Exhaustion must fence NPC construction and all model calls')
      const status = JSON.parse(await session.rcon.command(STARTUP_CLOCK_COMMAND))
      assert.equal(status.speed, 1); assert.equal(status.paused, true)
    }
    assert.equal(boots, expectedBoots)
    assert.equal(providerCalls, 0); assert.equal(external, 0)
    const ledger = JSON.parse(await fs.readFile(path.join(root, '.sgluna/startup-clock-recovery.json'), 'utf8').catch(() => 'null'))
    if (fault) assert.equal(ledger.attempts, 1)
    else assert.equal(ledger, null)
    scenarios.push({ name, fault, boots, success, provider_calls: providerCalls, snapshots, ledger,
      proof: session.startupClockProof, failure: failure?.message })
  } finally {
    await session.stop('requested')
    await fs.writeFile(path.join(results, `startup-${name}-${existing ? 'restaged' : 'initial'}.log`), `${logs.join('\n')}\n`)
  }
}

try {
  await scenario('cold-console', null, { cold: true, expectedBoots: 2, success: true })
  await scenario('prevented', null, { expectedBoots: 2, success: true })
  await scenario('residual', 'once', { expectedBoots: 3, success: true })
  await scenario('exhausted', 'always', { expectedBoots: 3, success: false })
  await scenario('exhausted', 'always', { existing: true, expectedBoots: 1, success: false })
  await fs.writeFile(path.join(results, 'startup-clock-proof.json'), JSON.stringify({ status: 'pass', exact_native_version: '2.0.77',
    source: 'actual Session startup, real Factorio; settings fault injected before launch; no provider/Jev calls',
    zero_external_inference: external === 0, scenarios }, null, 2))
  console.log('PASS startup clock: actual Session prevention, residual self-correction, durable exhaustion and zero inference')
} catch (error) {
  await fs.writeFile(path.join(results, 'startup-clock-error.txt'), `${error.stack}\n${JSON.stringify(scenarios, null, 2)}`)
  throw error
}
