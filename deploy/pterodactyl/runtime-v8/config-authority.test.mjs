import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareServerSettings } from './game-files.mjs'
import { configuration, factorioVisibilityDiagnostics, migrateCanonicalConfig, rconConfiguration, Session } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-config-authority-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

async function setupGame(root) {
  const game = path.join(root, 'game')
  await fsp.mkdir(path.join(game, 'data'), { recursive: true })
  await fsp.writeFile(path.join(game, 'data', 'server-settings.example.json'), JSON.stringify({
    name: 'Factorio server',
    description: 'Example server',
    visibility: { public: true, lan: true },
    username: '',
    token: '',
    game_password: '',
    max_players: 0,
    require_user_verification: true,
  }, null, 2))
  return game
}

function fixtureSecret(label) {
  return `fixture-${label}-${'x'.repeat(16)}`
}

function eggEnv(overrides = {}) {
  return {
    SGLUNA_ACTOR_MODE: 'npc',
    SGLUNA_CHAT_PLAYERS: 'Alice,Bob',
    OPENAI_API_KEY: fixtureSecret('provider-key'),
    OPENAI_MODEL: 'egg-model-a',
    OPENAI_API_BASEURL: 'https://provider-a.example.test/v1',
    PROVIDER_PROFILE: 'deepseek',
    PROVIDER_TIMEOUT_MS: '150000',
    SAVE_NAME: 'egg-a.zip',
    SERVER_PORT: '35123',
    MAX_PROVIDER_REQUESTS_PER_HOUR: '333',
    MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN: '24000',
    SHUTDOWN_TIMEOUT_MS: '71000',
    FACTORIO_USERNAME: 'egg-user',
    FACTORIO_TOKEN: fixtureSecret('factorio-token'),
    ...overrides,
  }
}

test('RCON remains private and random by default, with a bounded local test override', () => {
  const defaults = rconConfiguration({})
  assert.equal(defaults.port, null)
  assert.equal(defaults.bind, '127.0.0.1')
  assert.match(defaults.password, /^[A-Za-z0-9]+$/)

  const override = rconConfiguration({
    SGLUNA_RCON_PORT: '27015',
    SGLUNA_RCON_BIND: '0.0.0.0',
    SGLUNA_RCON_PASSWORD: fixtureSecret('rcon'),
  })
  assert.deepEqual(override, { port: 27015, bind: '0.0.0.0', password: fixtureSecret('rcon') })
  assert.throws(() => rconConfiguration({ SGLUNA_RCON_BIND: '192.168.1.20' }), /SGLUNA_RCON_BIND/)
})

test('SGLuna Egg environment overrides stored runtime config and is synchronized into sgluna-config.json on every restart', async t => {
  const root = await temp(t)
  const filename = path.join(root, 'sgluna-config.json')
  const legacyProviderKey = fixtureSecret('legacy-provider-key')
  const legacyFactorioToken = fixtureSecret('legacy-factorio-token')
  const stored = {
    actorMode: 'npc',
    chatPlayers: 'StoredPlayer',
    providerUrl: 'https://stored.example.test/v1',
    model: 'stored-model',
    save: 'stored.zip',
    providerTimeoutMs: 1001,
    gamePort: 35001,
    maxProviderRequestsPerHour: 2,
    shutdownTimeoutMs: 2001,
    key: legacyProviderKey,
    apiKey: legacyProviderKey,
    factorioUsername: 'stored-user',
    factorioToken: legacyFactorioToken,
    unknownLegacyField: 'drop-me',
  }
  await fsp.writeFile(filename, `${JSON.stringify(stored, null, 2)}\n`)

  const firstEnv = eggEnv()
  const direct = configuration(stored, firstEnv)
  assert.equal(direct.actorMode, 'npc')
  assert.deepEqual(direct.chatPlayers, { mode: 'allowlist', names: ['Alice', 'Bob'] })
  assert.equal(direct.model, 'egg-model-a')
  assert.equal(direct.base, 'https://provider-a.example.test/v1')
  assert.equal(direct.profile, 'deepseek')
  assert.equal(direct.key, firstEnv.OPENAI_API_KEY)
  assert.equal(direct.providerTimeoutMs, 150000)
  assert.equal(direct.save, 'egg-a.zip')
  assert.equal(direct.gamePort, 35123)
  assert.equal(direct.budget, 333)
  assert.equal(direct.maxProviderOutputUnits, 24000)
  assert.equal(direct.stopMs, 71000)
  assert.deepEqual(direct.factorio, {
    username: 'egg-user',
    token: firstEnv.FACTORIO_TOKEN,
    public: true,
  })

  const firstPersisted = (await migrateCanonicalConfig(root, firstEnv)).config
  assert.deepEqual(firstPersisted, {
    actorMode: 'npc',
    chatPlayers: 'Alice,Bob',
    providerUrl: 'https://provider-a.example.test/v1',
    providerProfile: 'deepseek',
    model: 'egg-model-a',
    save: 'egg-a.zip',
    providerTimeoutMs: 150000,
    gamePort: 35123,
    maxProviderRequestsPerHour: 333,
    maxProviderOutputTokensPerTurn: 24000,
    shutdownTimeoutMs: 71000,
  })
  let fileText = await fsp.readFile(filename, 'utf8')
  assert.equal(fileText.includes(firstEnv.OPENAI_API_KEY), false)
  assert.equal(fileText.includes(firstEnv.FACTORIO_TOKEN), false)
  assert.equal(fileText.includes(legacyProviderKey), false)
  assert.equal(fileText.includes(legacyFactorioToken), false)
  assert.equal(fileText.includes('factorioUsername'), false)
  assert.equal(fileText.includes('unknownLegacyField'), false)

  const secondEnv = eggEnv({
    SGLUNA_CHAT_PLAYERS: 'none',
    OPENAI_API_KEY: fixtureSecret('provider-key-b'),
    OPENAI_MODEL: 'egg-model-b',
    OPENAI_API_BASEURL: 'https://provider-b.example.test/v1',
    PROVIDER_PROFILE: 'generic',
    PROVIDER_TIMEOUT_MS: '190000',
    SAVE_NAME: '',
    SERVER_PORT: '35234',
    MAX_PROVIDER_REQUESTS_PER_HOUR: '444',
    MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN: '26000',
    SHUTDOWN_TIMEOUT_MS: '82000',
    FACTORIO_USERNAME: '',
    FACTORIO_TOKEN: '',
  })
  const secondPersisted = (await migrateCanonicalConfig(root, secondEnv)).config
  const secondEffective = configuration(secondPersisted, secondEnv)

  assert.deepEqual(secondPersisted, {
    actorMode: 'npc',
    chatPlayers: 'none',
    providerUrl: 'https://provider-b.example.test/v1',
    providerProfile: 'generic',
    model: 'egg-model-b',
    save: '',
    providerTimeoutMs: 190000,
    gamePort: 35234,
    maxProviderRequestsPerHour: 444,
    maxProviderOutputTokensPerTurn: 26000,
    shutdownTimeoutMs: 82000,
  })
  assert.deepEqual(secondEffective.chatPlayers, { mode: 'disabled', names: [] })
  assert.equal(secondEffective.model, 'egg-model-b')
  assert.equal(secondEffective.base, 'https://provider-b.example.test/v1')
  assert.equal(secondEffective.profile, 'generic')
  assert.equal(secondEffective.key, secondEnv.OPENAI_API_KEY)
  assert.equal(secondEffective.providerTimeoutMs, 190000)
  assert.equal(secondEffective.save, '')
  assert.equal(secondEffective.gamePort, 35234)
  assert.equal(secondEffective.budget, 444)
  assert.equal(secondEffective.maxProviderOutputUnits, 26000)
  assert.equal(secondEffective.stopMs, 82000)
  assert.deepEqual(secondEffective.factorio, { username: '', token: '', public: false })

  fileText = await fsp.readFile(filename, 'utf8')
  assert.equal(fileText.includes(secondEnv.OPENAI_API_KEY), false)
  assert.equal(fileText.includes('FACTORIO_TOKEN'), false)
})

test('decision provider auto-configures from TypeSafe credentials without persisting secrets or an enabled flag', async t => {
  const root = await temp(t)
  const filename = path.join(root, 'sgluna-config.json')
  const decisionKey = fixtureSecret('typesafe-key')
  const env = eggEnv({
    TYPESAFE_API_KEY: decisionKey,
    DECISION_PROVIDER_MAX_INPUT_CHARS: '6000',
    MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR: '45',
  })

  const effective = configuration({}, env)
  assert.equal(effective.decisionProvider?.provider, 'typesafe')
  assert.equal(effective.decisionProvider?.key, decisionKey)
  assert.equal(effective.decisionProvider?.model, 'jev-latest')
  assert.equal(effective.decisionProvider?.maxInputChars, 6000)
  assert.equal(effective.decisionProvider?.maxRequestsPerHour, 45)
  assert.equal(Object.prototype.hasOwnProperty.call(effective.decisionProvider, 'enabled'), false)

  const persisted = (await migrateCanonicalConfig(root, env)).config
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'decisionProvider'), false)
  const text = await fsp.readFile(filename, 'utf8')
  assert.equal(text.includes(decisionKey), false)
  assert.equal(text.includes('TYPESAFE_API_KEY'), false)
  assert.equal(text.includes('DECISION_PROVIDER'), false)

  const withoutDecisionCredentials = configuration({}, eggEnv())
  assert.equal(withoutDecisionCredentials.decisionProvider, undefined)
})

test('Factorio Egg credentials are rewritten into the exact launched server-settings.json on restart', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  const firstEnv = eggEnv()
  const firstConfig = configuration({}, firstEnv)
  const settingsFile = await prepareServerSettings(root, game, firstConfig.factorio)
  assert.equal(settingsFile, path.join(root, 'data', 'server-settings.json'))

  let settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'))
  assert.equal(settings.visibility.public, true)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.require_user_verification, true)
  assert.equal(settings.username, 'egg-user')
  assert.equal(settings.token, firstEnv.FACTORIO_TOKEN)

  const firstSession = new Session({
    root,
    app: root,
    game,
    config: firstConfig,
    save: path.join(root, 'saves', 'world.zip'),
    settingsFile,
    modDir: path.join(root, 'mods-run'),
    ini: path.join(root, 'config.ini'),
    log: () => {},
  })
  const firstArgs = firstSession.gameArgs(40001)
  assert.equal(firstArgs[firstArgs.indexOf('--server-settings') + 1], settingsFile)

  const secondEnv = eggEnv({ FACTORIO_USERNAME: '', FACTORIO_TOKEN: '' })
  const secondConfig = configuration({}, secondEnv)
  const settingsAfterRestart = await prepareServerSettings(root, game, secondConfig.factorio)
  assert.equal(settingsAfterRestart, settingsFile)

  settings = JSON.parse(await fsp.readFile(settingsAfterRestart, 'utf8'))
  assert.equal(settings.visibility.public, false)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.require_user_verification, false)
  assert.equal(settings.username, '')
  assert.equal(settings.token, '')

  const secondSession = new Session({
    root,
    app: root,
    game,
    config: secondConfig,
    save: path.join(root, 'saves', 'world.zip'),
    settingsFile: settingsAfterRestart,
    modDir: path.join(root, 'mods-run'),
    ini: path.join(root, 'config.ini'),
    log: () => {},
  })
  const secondArgs = secondSession.gameArgs(40002)
  assert.equal(secondArgs[secondArgs.indexOf('--server-settings') + 1], settingsAfterRestart)
})


test('public Factorio visibility warns when legacy chat authority still allows everyone', () => {
  assert.deepEqual(
    factorioVisibilityDiagnostics(
      { username: 'public-user', token: 'secret-token', public: true },
      { mode: 'all', names: [] },
    ),
    [
      'Factorio visibility: PUBLIC',
      'SECURITY WARNING: public Factorio listing with chat=all allows every player to issue !luna/!airi commands; configure SGLUNA_CHAT_PLAYERS=none or an explicit allowlist.',
    ],
  )

  assert.deepEqual(
    factorioVisibilityDiagnostics(
      { username: 'public-user', token: 'secret-token', public: true },
      { mode: 'allowlist', names: ['Alice'] },
    ),
    ['Factorio visibility: PUBLIC'],
  )

  assert.deepEqual(
    factorioVisibilityDiagnostics(
      { username: '', token: '', public: false },
      { mode: 'all', names: [] },
    ),
    ['Factorio visibility: PRIVATE/HIDDEN', 'No Factorio listing credentials supplied'],
  )
})


test('fresh effective config denies chat commands while an explicit legacy blank remains compatibility-all', () => {
  const baseEnv = {
    SGLUNA_ACTOR_MODE: 'npc',
    OPENAI_API_KEY: fixtureSecret('fresh-provider-key'),
    OPENAI_MODEL: 'fresh-model',
    OPENAI_API_BASEURL: 'https://fresh.example.test/v1',
  }
  assert.deepEqual(configuration({}, baseEnv).chatPlayers, { mode: 'disabled', names: [] })
  assert.deepEqual(configuration({ chatPlayers: '' }, baseEnv).chatPlayers, { mode: 'all', names: [] })
})
