import test from 'node:test'
import assert from 'node:assert/strict'
import { Rcon } from './common.mjs'

test('queued native sends recheck cancellation and deadline at the socket boundary', async () => {
  for (const cause of ['deadline', 'cancel']) {
    const rcon = new Rcon(1, 'fixture')
    let release, current = true, writes = 0
    rcon.queue = new Promise(done => { release = done })
    rcon.socket = { destroyed: false, write: () => { writes++ } }
    rcon.request = async () => 'response'
    const pending = rcon.command('fixture command', { deadlineAt: cause === 'deadline' ? Date.now() - 1 : Date.now() + 10000,
      isCurrent: () => current })
    if (cause === 'cancel') current = false
    release()
    await assert.rejects(pending, error => error.notSent === true)
    assert.equal(writes, 0)
  }
})
