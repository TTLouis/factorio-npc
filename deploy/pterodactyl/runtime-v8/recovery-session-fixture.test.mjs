import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverySession, recoveryWorld } from './recovery-loop-fixtures.mjs'

test('native RCON fixture uses the observed session identity without fake game state', async () => {
  const observed = { actor_id: 712, epoch: 9, session: 'native-observed-session' }
  const commands = []
  const game = { command: async command => {
    commands.push(command)
    return JSON.stringify(observed)
  } }
  const world = recoveryWorld({ game })
  const { session } = recoverySession(world, {
    actorId: observed.actor_id, epoch: observed.epoch, sessionId: observed.session,
  })
  assert.deepEqual(session.lastStatus, observed)
  assert.deepEqual(await session.rawStatus(), observed)
  assert.equal(commands.length, 1)
  assert.match(commands[0], /sgluna_deployment/)
})
