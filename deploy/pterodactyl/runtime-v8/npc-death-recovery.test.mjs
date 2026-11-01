import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, configuration } from './supervisor.mjs'

const baseEnv = {
  AIRI_ACTOR_MODE: 'npc',
  AIRI_CHAT_PLAYER: 'Louis',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_MODEL: 'test-model',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
  SERVER_PORT: '34197',
}

function fixture() {
  const logs = []
  const commands = []
  const session = new Session({
    root: '/tmp/sgluna-root',
    app: '/tmp/app',
    game: '/tmp/game',
    config: configuration({}, baseEnv),
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: line => logs.push(line),
  })
  session.ready = true
  session.rcon = {
    command: async (text) => {
      commands.push(text)
      return 'ok'
    },
  }
  return { session, logs, commands }
}

test('NPC body recovery cancels stale model work, reauthorizes, and notifies chat', async () => {
  const { session, commands } = fixture()
  let ensured = 0
  let cancelled = 0
  session.ensureAuthorization = async () => {
    ensured++
    return { actor_id: 42, epoch: 4 }
  }
  session.agent = {
    active: true,
    cancel: () => { cancelled++ },
  }

  session.onGameLine('2026-09-15 01:00:00 [AUTORIO] Recovered standalone NPC actor_id=18 -> 42 without inventory transfer')
  await session.eventQueue

  assert.equal(cancelled, 1)
  assert.equal(ensured, 1)
  assert.ok(commands.some(command => command.includes('[SGLuna] I was killed or lost my body and respawned.')))
  assert.ok(commands.some(command => command.includes('Previous actor 18, replacement actor 42')))
})

test('completion continuation is skipped if authorization rebind cancels the active turn', async () => {
  const { session } = fixture()
  let completed = 0
  const agent = {
    active: true,
    cancel: () => { agent.active = false },
    completed: async () => {
      completed++
      return { chatMessage: 'should not happen' }
    },
  }
  session.agent = agent
  session.ensureAuthorization = async () => {
    agent.cancel()
    return { actor_id: 42, epoch: 4 }
  }

  session.onGameLine('2026-09-15 01:00:00 [AUTORIO] All operations completed')
  await session.eventQueue

  assert.equal(completed, 0)
})
