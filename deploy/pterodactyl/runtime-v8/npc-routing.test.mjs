import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, configuration, controlWord, routeNpcRequest } from './supervisor.mjs'

const baseEnv = {
  AIRI_ACTOR_MODE: 'npc',
  AIRI_CHAT_PLAYER: 'Louis',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_MODEL: 'test-model',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
  SERVER_PORT: '34197',
}

function fixture() {
  const commands = []
  const session = new Session({
    root: '/tmp/airi-root',
    app: '/tmp/app',
    game: '/tmp/game',
    config: configuration({}, baseEnv),
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
  })
  session.rcon = {
    command: async text => {
      commands.push(text)
      return 'ok'
    },
  }
  return { session, commands }
}

test('legacy !airi requests remain unchanged while an explicit current NPC name is stripped', () => {
  assert.equal(routeNpcRequest('follow me', 'Aster-1'), 'follow me')
  assert.equal(routeNpcRequest('Aster-1 follow me', 'Aster-1'), 'follow me')
  assert.equal(routeNpcRequest('aster-1 follow me', 'Aster-1'), 'follow me')
  assert.equal(routeNpcRequest('Nova-2 follow me', 'Aster-1'), 'Nova-2 follow me')
})

test('deployment identity gives the session a stable logical NPC id and visible generated name', () => {
  const { session } = fixture()
  session.updateNpcIdentity({ actor_name: 'Aster-1', npc_id: 'npc-1', actor_id: 42 })
  assert.equal(session.npcName, 'Aster-1')
  assert.equal(session.npcId, 'npc-1')
})

test('named NPC replies keep !airi as the command prefix but label the speaking NPC', async () => {
  const { session, commands } = fixture()
  session.npcName = 'Aster-1'

  await session.printChat('Ready.')

  assert.equal(commands.length, 1)
  assert.match(commands[0], /\[AIRI\/Aster-1\] Ready\./)
})

test('stop and status are recognised with punctuation, case and Chinese forms, but not inside a longer request', () => {
  for (const text of ['stop', 'Stop!', 'STOP.', 'pause', '停止', '暂停。', '停下！']) assert.equal(controlWord(text), 'stop', text)
  for (const text of ['status', 'Status?', '进度', '状态？']) assert.equal(controlWord(text), 'status', text)
  for (const text of ['stop mining iron', 'what is your status', 'continue', '不要停']) assert.equal(controlWord(text), undefined, text)
})
