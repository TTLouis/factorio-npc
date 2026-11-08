import assert from 'node:assert/strict'
import test from 'node:test'

import { main, parseArguments } from './harness-cli.mjs'
import { HARNESS_MODES, requireHarnessMode, resolveHarnessMode } from './harness-modes.mjs'

test('selection is explicit, defaults to external and rejects conflicting or unknown modes', () => {
  assert.equal(resolveHarnessMode({ env: {} }), 'external')
  for (const mode of HARNESS_MODES) {
    assert.equal(resolveHarnessMode({ mode, env: {} }), mode)
    assert.equal(resolveHarnessMode({ env: { SGLUNA_HARNESS_MODE: mode } }), mode)
    assert.equal(requireHarnessMode(mode, { SGLUNA_HARNESS_MODE: mode }), mode)
    assert.deepEqual(parseArguments(['--mode', mode, '--help'], {}), { mode, args: ['--help'], help: false })
  }
  for (const mode of ['', 'PLAN', 'auto', '../pursuit']) {
    assert.throws(() => resolveHarnessMode({ mode, env: {} }), { code: 'invalid_harness_mode' })
    assert.throws(() => resolveHarnessMode({ env: { SGLUNA_HARNESS_MODE: mode } }), { code: 'invalid_harness_mode' })
  }
  assert.throws(() => parseArguments(['--mode'], {}), { code: 'invalid_cli_arguments' })
  assert.throws(() => parseArguments(['--mode', 'plan', '--mode', 'plan'], {}), { code: 'invalid_cli_arguments' })
  assert.throws(() => parseArguments(['--mode', 'plan'], { SGLUNA_HARNESS_MODE: 'pursuit' }), { code: 'conflicting_harness_mode' })
  assert.throws(() => requireHarnessMode('external', { SGLUNA_HARNESS_MODE: 'plan' }), { code: 'conflicting_harness_mode' })
})

for (const mode of HARNESS_MODES) test(`${mode} loads only its selected lifecycle and forwards unchanged arguments/environment`, async () => {
  const loaded = []
  const env = { SGLUNA_HARNESS_MODE: mode, marker: 'non-secret-fixture' }
  const forwarded = mode === 'plan' ? [] : mode === 'external' ? ['--bind'] : ['--profile', 'fixture.json']
  const loaders = Object.fromEntries(HARNESS_MODES.map(name => [name, async () => {
    loaded.push(name)
    assert.equal(name, mode, 'unselected lifecycle must not initialize')
    return { main: async (args, actualEnv) => {
      assert.deepEqual(args, forwarded)
      assert.equal(actualEnv, env)
      return { owner: mode }
    } }
  }]))
  assert.deepEqual(await main(['--mode', mode, ...forwarded], env, { loaders }), { owner: mode })
  assert.deepEqual(loaded, [mode])
})

test('invalid mode, conflicting mode, plan arguments and general help never initialize any lifecycle', async () => {
  let loads = 0
  const loaders = Object.fromEntries(HARNESS_MODES.map(mode => [mode, async () => { loads++; throw new Error('must not load') }]))
  for (const [args, env] of [[['--mode', 'unknown'], {}], [['--mode', 'plan'], { SGLUNA_HARNESS_MODE: 'external' }], [['--mode', 'plan', '--bind'], {}]]) {
    await assert.rejects(main(args, env, { loaders }))
  }
  const output = []
  await main(['--help'], {}, { loaders, stdout: { write: value => output.push(value) } })
  await main(['--mode', 'plan', '--help'], {}, { loaders, stdout: { write: value => output.push(value) } })
  assert.equal(loads, 0)
  assert.match(output[0], /external\|plan\|pursuit/)
  assert.match(output[1], /installed server supervisor/)
})
