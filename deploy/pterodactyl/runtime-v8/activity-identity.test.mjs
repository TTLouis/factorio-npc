import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './supervisor.mjs'

test('repeated identical live activities keep distinct stable identities', () => {
  const session = new Session({
    root: '/tmp/sgluna-test',
    app: '/tmp/sgluna-test/app',
    game: '/tmp/sgluna-test/game',
    config: {},
    save: '/tmp/sgluna-test/save.zip',
    settingsFile: '/tmp/sgluna-test/server-settings.json',
    modDir: '/tmp/sgluna-test/mods',
    ini: '/tmp/sgluna-test/config.ini',
    log: () => {},
  })
  session.requestTaskBoardUiSync = () => undefined

  session.onAgentActivity('tool.call', { name: 'getActorStatus' })
  session.onAgentActivity('tool.call', { name: 'getActorStatus' })

  const [first, second] = session.agentLive.activity
  assert.equal(first.text, 'Tool getActorStatus')
  assert.equal(second.text, 'Tool getActorStatus')
  assert.match(first.id, /^live_[0-9a-z]+_1$/)
  assert.match(second.id, /^live_[0-9a-z]+_2$/)
})

test('live ids from a restarted supervisor never reuse an earlier id', () => {
  const options = {
    root: '/tmp/sgluna-test',
    app: '/tmp/sgluna-test/app',
    game: '/tmp/sgluna-test/game',
    config: {},
    save: '/tmp/sgluna-test/save.zip',
    settingsFile: '/tmp/sgluna-test/server-settings.json',
    modDir: '/tmp/sgluna-test/mods',
    ini: '/tmp/sgluna-test/config.ini',
    log: () => {},
  }
  const before = new Session(options)
  before.requestTaskBoardUiSync = () => undefined
  before.activityEpoch = 'before'
  before.onAgentActivity('tool.call', { name: 'getActorStatus' })
  const after = new Session(options)
  after.requestTaskBoardUiSync = () => undefined
  after.activityEpoch = 'after'
  after.onAgentActivity('tool.call', { name: 'getActorStatus' })
  assert.notEqual(before.agentLive.activity[0].id, after.agentLive.activity[0].id)
})
