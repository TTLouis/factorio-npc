import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AIRI_CONFIG_DEFAULTS, SGLUNA_CONFIG_DEFAULTS, migrateCanonicalConfig, migrateConfig, migrateConfigFile } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-config-migration-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

test('a fresh SGLuna config uses explicit non-provider placeholders', () => {
  const next = migrateConfig({}, {})
  assert.equal(next.chatPlayers, 'none')
  assert.equal(SGLUNA_CONFIG_DEFAULTS.chatPlayers, 'none')
  assert.equal(next.providerUrl, 'https://provider.invalid/v1')
  assert.equal(next.model, 'replace-me')
  assert.equal(next.providerUrl, SGLUNA_CONFIG_DEFAULTS.providerUrl)
  assert.equal(next.model, SGLUNA_CONFIG_DEFAULTS.model)
  assert.equal(next.providerProfile, 'auto')
  assert.equal(next.maxProviderOutputTokensPerTurn, 100000)
})

test('an old config missing providerUrl is migrated to the default while preserving other values', () => {
  const next = migrateConfig({ model: 'foo' }, {})
  assert.equal(next.model, 'foo')
  assert.equal(next.providerUrl, SGLUNA_CONFIG_DEFAULTS.providerUrl)
  assert.equal(next.actorMode, SGLUNA_CONFIG_DEFAULTS.actorMode)
})

test('a custom stored providerUrl survives migration when there is no env override', () => {
  const next = migrateConfig({ providerUrl: 'https://custom.example/v1' }, {})
  assert.equal(next.providerUrl, 'https://custom.example/v1')
})

test('OPENAI_API_BASEURL is synchronized into providerUrl so the file reflects the effective endpoint', () => {
  const next = migrateConfig(
    { providerUrl: 'https://stale-stored-value.example/v1' },
    { OPENAI_API_BASEURL: 'https://env-override.example/v1' },
  )
  assert.equal(next.providerUrl, 'https://env-override.example/v1')
})

test('OPENAI_MODEL is synchronized into model so the file reflects the setup value', () => {
  const next = migrateConfig(
    { model: 'stale-stored-model' },
    { OPENAI_MODEL: 'setup-model' },
  )
  assert.equal(next.model, 'setup-model')
})

test('provider profile and per-turn output cap are explicit and validated', () => {
  const next = migrateConfig({}, { PROVIDER_PROFILE: 'openai-reasoning', MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN: '32000' })
  assert.equal(next.providerProfile, 'openai-reasoning')
  assert.equal(next.maxProviderOutputTokensPerTurn, 32000)
  assert.throws(() => migrateConfig({}, { PROVIDER_PROFILE: 'guess-from-hostname' }), /PROVIDER_PROFILE/)
})

test('OPENAI_API_KEY is never written into the migrated config', () => {
  const next = migrateConfig({}, { OPENAI_API_KEY: 'super-secret-key' })
  assert.equal('key' in next, false)
  assert.equal('apiKey' in next, false)
  assert.equal(JSON.stringify(next).includes('super-secret-key'), false)
})

test('factorioUsername is stripped from the migrated config, including from a legacy stored value', () => {
  const fresh = migrateConfig({}, { FACTORIO_USERNAME: 'ttlouis' })
  assert.equal('factorioUsername' in fresh, false)

  const legacy = migrateConfig({ factorioUsername: 'ttlouis-old' }, {})
  assert.equal('factorioUsername' in legacy, false)
})

test('migrateConfigFile writes a fresh file with explicit provider placeholders', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  const next = await migrateConfigFile(filename, {})
  const onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, SGLUNA_CONFIG_DEFAULTS.providerUrl)
  assert.equal(onDisk.model, SGLUNA_CONFIG_DEFAULTS.model)
  assert.deepEqual(onDisk, next)
})

test('migrateConfigFile migrates an existing file missing providerUrl without discarding user values', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await fsp.writeFile(filename, `${JSON.stringify({ model: 'foo' }, null, 2)}\n`)
  await migrateConfigFile(filename, {})
  const onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.model, 'foo')
  assert.equal(onDisk.providerUrl, SGLUNA_CONFIG_DEFAULTS.providerUrl)
})

test('migrateConfigFile does not rewrite an already-migrated, unchanged file', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, {})
  const before = (await fsp.stat(filename)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  await migrateConfigFile(filename, {})
  const after = (await fsp.stat(filename)).mtimeMs
  assert.equal(before, after)
})

test('migrateConfigFile keeps setup provider and model values visible across restarts', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, {})
  let onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, SGLUNA_CONFIG_DEFAULTS.providerUrl)
  assert.equal(onDisk.model, SGLUNA_CONFIG_DEFAULTS.model)

  await migrateConfigFile(filename, {
    OPENAI_API_BASEURL: 'https://env-override.example/v1',
    OPENAI_MODEL: 'setup-model',
  })
  onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, 'https://env-override.example/v1')
  assert.equal(onDisk.model, 'setup-model')

  // Removing the env overrides does not erase what was durably written: the
  // env-synced values are now the stored preferences until something else
  // overrides or edits them again.
  await migrateConfigFile(filename, {})
  onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, 'https://env-override.example/v1')
  assert.equal(onDisk.model, 'setup-model')
})

test('migrateConfigFile never persists OPENAI_API_KEY to disk', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, { OPENAI_API_KEY: 'super-secret-key' })
  const text = await fsp.readFile(filename, 'utf8')
  assert.equal(text.includes('super-secret-key'), false)
})


test('AIRI_CONFIG_DEFAULTS remains a compatibility alias of SGLUNA_CONFIG_DEFAULTS', () => {
  assert.equal(AIRI_CONFIG_DEFAULTS, SGLUNA_CONFIG_DEFAULTS)
})

test('canonical config creation writes sgluna-config.json on a fresh root', async (t) => {
  const root = await temp(t)
  const result = await migrateCanonicalConfig(root, {})
  assert.equal(result.filename, path.join(root, 'sgluna-config.json'))
  assert.equal(result.migratedFromLegacy, false)
  assert.deepEqual(JSON.parse(await fsp.readFile(result.filename, 'utf8')), result.config)
  await assert.rejects(fsp.access(path.join(root, 'airi-config.json')), /ENOENT/)
})

test('legacy airi-config.json is migrated forward once without discarding values', async (t) => {
  const root = await temp(t)
  const legacy = path.join(root, 'airi-config.json')
  await fsp.writeFile(legacy, JSON.stringify({ model: 'legacy-model', chatPlayers: 'LegacyUser' }, null, 2))
  const result = await migrateCanonicalConfig(root, {})
  assert.equal(result.migratedFromLegacy, true)
  assert.equal(result.config.model, 'legacy-model')
  assert.equal(result.config.chatPlayers, 'LegacyUser')
  const canonical = JSON.parse(await fsp.readFile(path.join(root, 'sgluna-config.json'), 'utf8'))
  assert.equal(canonical.model, 'legacy-model')
  assert.equal(JSON.parse(await fsp.readFile(legacy, 'utf8')).model, 'legacy-model')
})

test('sgluna-config.json is authoritative when both canonical and legacy files exist', async (t) => {
  const root = await temp(t)
  await fsp.writeFile(path.join(root, 'sgluna-config.json'), JSON.stringify({ model: 'canonical-model' }, null, 2))
  await fsp.writeFile(path.join(root, 'airi-config.json'), JSON.stringify({ model: 'legacy-model' }, null, 2))
  const result = await migrateCanonicalConfig(root, {})
  assert.equal(result.migratedFromLegacy, false)
  assert.equal(result.config.model, 'canonical-model')
  assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'airi-config.json'), 'utf8')).model, 'legacy-model')
})

test('SGLUNA deployment env wins over AIRI compatibility env during config migration', () => {
  const next = migrateConfig({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    AIRI_ACTOR_MODE: 'player',
    SGLUNA_CHAT_PLAYERS: 'Primary',
    AIRI_CHAT_PLAYERS: 'Legacy',
  })
  assert.equal(next.actorMode, 'npc')
  assert.equal(next.chatPlayers, 'Primary')
})


test('explicit legacy blank chat authority remains compatibility-all instead of being silently migrated', () => {
  const next = migrateConfig({ chatPlayers: '' }, {})
  assert.equal(next.chatPlayers, '')
})
