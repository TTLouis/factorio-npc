import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './supervisor.mjs'

function sessionFixture() {
  const commands = []
  const session = new Session({
    root: '/tmp/airi-test',
    app: '/tmp/app',
    game: '/tmp/game',
    config: { chatPlayers: { mode: 'all', names: [] } },
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: () => {},
  })
  session.ready = true
  session.rcon = { command: async command => { commands.push(command); return 'ok' } }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  return { session, commands }
}

test('chat sender identity is passed into the NPC request context', async () => {
  const { session } = sessionFixture()
  let request
  session.agent = {
    active: false,
    request: async (text, options) => {
      request = { text, options }
      return { chatMessage: '' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-15 00:00:00 [CHAT] TTLouis: !luna follow me')
  await session.eventQueue

  assert.deepEqual(request, {
    text: 'follow me',
    options: { sender: 'TTLouis' },
  })
})

test('UI prompt sender identity enters the same NPC request path without an !luna prefix', async () => {
  const { session } = sessionFixture()
  let request
  session.agent = {
    active: false,
    request: async (text, options) => {
      request = { text, options }
      return { chatMessage: '' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('[AIRI_UI_PROMPT] {"version":1,"player_index":1,"player_name":"TTLouis","text":"build a steam power block","tick":42}')
  await session.eventQueue

  assert.deepEqual(request, {
    text: 'build a steam power block',
    options: { sender: 'TTLouis' },
  })
})

test('legacy !airi remains a compatibility alias for !luna', async () => {
  const { session } = sessionFixture()
  let request
  session.agent = {
    active: false,
    request: async (text, options) => {
      request = { text, options }
      return { chatMessage: '' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-15 00:00:00 [CHAT] TTLouis: !airi compatibility check')
  await session.eventQueue
  assert.deepEqual(request, { text: 'compatibility check', options: { sender: 'TTLouis' } })
})

test('stop pauses durable plan state before cancelling Autorio work', async () => {
  const { session, commands } = sessionFixture()
  let pausedReason
  session.agent = {
    active: true,
    pausePersistentPlan: async reason => { pausedReason = reason },
    request: async () => null,
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-15 00:00:00 [CHAT] TTLouis: !luna stop')
  await session.eventQueue

  assert.equal(pausedReason, 'user_stop')
  assert.ok(commands.some(command => command.includes('remote.call("airi_deployment","cancel")')))
  assert.ok(commands.some(command => command.includes('Paused the current SGLuna plan')))
})

test('Autorio errors are returned to the active goal for replanning instead of cancelling it blindly', async () => {
  const { session, commands } = sessionFixture()
  let receivedError
  session.agent = {
    active: true,
    request: async () => null,
    completed: async () => null,
    failed: async error => {
      receivedError = error
      return { chatMessage: 'I hit a blocker and replanned.' }
    },
    cancel: () => { throw new Error('should not cancel on Autorio error') },
  }

  session.onGameLine('123.456 Script @__autorio__/control.lua:99: [AUTORIO] [ERROR] mining failed: no_target; dependent operations cancelled')
  await session.eventQueue

  assert.equal(receivedError, 'mining failed: no_target; dependent operations cancelled')
  assert.ok(commands.some(command => command.includes('I hit a blocker and replanned.')))
})
