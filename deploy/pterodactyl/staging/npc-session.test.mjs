import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NpcSessionEpoch,
  actorEpoch,
  assertNpcReady,
  chatAuthorized,
  npcStartupCommands,
  requireActorEpoch,
  sameActorEpoch,
  seedStagingConfigFromEnv,
  stagingConfiguration,
  validateTaskStatus,
} from './npc-session.mjs'

function status(overrides = {}) {
  return {
    mode: 'npc',
    connected_players: 0,
    actor: {
      kind: 'standalone_character',
      valid: true,
      name: 'SGLuna',
      position: { x: 0, y: 0 },
      has_character: true,
      actor_id: 18,
    },
    load_reconciliation: {
      pending: false,
      last_actor_id: 18,
      last_tick: 100,
    },
    ...overrides,
  }
}

test('npc staging configuration separates actor ownership from chat authorization', () => {
  const config = stagingConfiguration({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    SGLUNA_CHAT_PLAYERS: 'Louis',
    AIRI_PLAYER: 'LegacyName',
  })
  assert.equal(config.actorMode, 'npc')
  assert.equal(config.player, '')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Louis'] })
  assert.equal(chatAuthorized(config, 'Louis'), true)
  assert.equal(chatAuthorized(config, 'LegacyName'), false)
})

test('blank AIRI_CHAT_PLAYERS allows every player', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc' })
  assert.deepEqual(config.chatPlayers, { mode: 'all', names: [] })
  assert.equal(chatAuthorized(config, 'AnyoneAtAll'), true)
})

test('"*" AIRI_CHAT_PLAYERS allows every player', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYERS: '*' })
  assert.equal(chatAuthorized(config, 'AnyoneAtAll'), true)
})

test('"none" AIRI_CHAT_PLAYERS rejects every player', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYERS: 'none' })
  assert.deepEqual(config.chatPlayers, { mode: 'disabled', names: [] })
  assert.equal(chatAuthorized(config, 'TTLouis'), false)
})

test('comma-separated AIRI_CHAT_PLAYERS trims whitespace, drops empties, and dedupes', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYERS: ' TTLouis , Alice ,,Bob, Alice ' })
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['TTLouis', 'Alice', 'Bob'] })
  assert.equal(chatAuthorized(config, 'TTLouis'), true)
  assert.equal(chatAuthorized(config, 'Alice'), true)
  assert.equal(chatAuthorized(config, 'Bob'), true)
  assert.equal(chatAuthorized(config, 'Eve'), false)
})

test('npc mode may use AIRI_CHAT_PLAYER as a backward-compatible single-name fallback', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYER: 'Louis' })
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Louis'] })
  assert.equal(chatAuthorized(config, 'Louis'), true)
})

test('AIRI_CHAT_PLAYERS explicitly blank does not fall back to a non-blank legacy AIRI_CHAT_PLAYER', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYER: 'Legacy', AIRI_CHAT_PLAYERS: '' })
  assert.deepEqual(config.chatPlayers, { mode: 'all', names: [] })
  assert.equal(chatAuthorized(config, 'AnyoneAtAll'), true)
})

test('npc mode may use AIRI_PLAYER only as an explicit compatibility chat fallback', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_PLAYER: 'Louis' })
  assert.equal(config.player, '')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Louis'] })
})

test('player mode retains the legacy controlled-player field', () => {
  const config = stagingConfiguration({}, { AIRI_ACTOR_MODE: 'player', AIRI_PLAYER: 'Louis' })
  assert.equal(config.actorMode, 'player')
  assert.equal(config.player, 'Louis')
  assert.deepEqual(config.chatPlayers, { mode: 'all', names: [] })
})

test('invalid actor mode and unsafe names fail closed', () => {
  assert.throws(() => stagingConfiguration({}, { AIRI_ACTOR_MODE: 'swarm' }))
  assert.throws(() => stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYER: 'bad\nname' }))
  assert.throws(() => stagingConfiguration({}, { AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYERS: 'bad\nname' }))
})

test('seeded staging config never invents unset values', () => {
  assert.deepEqual(seedStagingConfigFromEnv({}), {})
  assert.deepEqual(seedStagingConfigFromEnv({ AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYERS: 'Louis' }), {
    actorMode: 'npc',
    chatPlayers: 'Louis',
  })
  assert.deepEqual(seedStagingConfigFromEnv({ AIRI_ACTOR_MODE: 'npc', AIRI_CHAT_PLAYER: 'Louis' }), {
    actorMode: 'npc',
    chatPlayers: 'Louis',
  })
})

test('zero connected players is a valid ready NPC session', () => {
  const actor = assertNpcReady(status({ connected_players: 0 }))
  assert.equal(actor.actor_id, 18)
})

test('human joins do not redefine NPC actor ownership', () => {
  const base = actorEpoch(status({ connected_players: 0 }))
  assert.equal(sameActorEpoch(base, status({ connected_players: 1 })), true)
  assert.equal(sameActorEpoch(base, status({ connected_players: 4 })), true)
})

test('body replacement invalidates stale model work', () => {
  const base = actorEpoch(status())
  const replaced = status({
    actor: { ...status().actor, actor_id: 42 },
    load_reconciliation: { pending: false, last_actor_id: 42, last_tick: 200 },
  })
  assert.equal(sameActorEpoch(base, replaced), false)
  assert.throws(() => requireActorEpoch(base, replaced), /epoch changed/)
})

test('mode change, wrong actor kind, invalid body, and pending load reconciliation are denied', () => {
  assert.throws(() => assertNpcReady(status({ mode: 'player' })))
  assert.throws(() => assertNpcReady(status({ actor: { ...status().actor, kind: 'connected_player' } })))
  assert.throws(() => assertNpcReady(status({ actor: { ...status().actor, valid: false } })))
  assert.throws(() => assertNpcReady(status({ load_reconciliation: { pending: true } })))
})

test('load reconciliation receipt must belong to the current actor when present', () => {
  assert.throws(() => assertNpcReady(status({ load_reconciliation: { pending: false, last_actor_id: 1, last_tick: 100 } })))
})

test('task status is tied to the captured actor epoch', () => {
  const epoch = actorEpoch(status())
  const task = {
    task_state: 'idle',
    queue_empty: true,
    queue_length: 0,
    actor: status().actor,
  }
  assert.equal(validateTaskStatus(task, epoch), task)
  assert.throws(() => validateTaskStatus({ ...task, actor: { ...task.actor, actor_id: 99 } }, epoch))
})

test('session epoch can be replaced only from a newly verified NPC snapshot', () => {
  const session = new NpcSessionEpoch(status())
  assert.equal(session.authorize(status()), true)
  const replacement = status({
    actor: { ...status().actor, actor_id: 42 },
    load_reconciliation: { pending: false, last_actor_id: 42, last_tick: 200 },
  })
  assert.equal(session.authorize(replacement), false)
  assert.equal(session.replace(replacement).actorId, 42)
  assert.equal(session.authorize(replacement), true)
})

test('startup commands are fixed allowlisted Autorio calls', () => {
  assert.deepEqual(npcStartupCommands(), {
    setMode: '/silent-command local r=remote.call("autorio_actor","set_mode","npc"); rcon.print(helpers.table_to_json(r))',
    actorStatus: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))',
    taskStatus: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))',
  })
})

test('SGLUNA staging variables override AIRI compatibility values', () => {
  const config = stagingConfiguration({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    AIRI_ACTOR_MODE: 'player',
    SGLUNA_CHAT_PLAYERS: 'Primary',
    AIRI_CHAT_PLAYERS: 'Legacy',
  })
  assert.equal(config.actorMode, 'npc')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Primary'] })
})

test('seeded staging config prefers SGLUNA variables but accepts AIRI fallbacks', () => {
  assert.deepEqual(seedStagingConfigFromEnv({
    SGLUNA_ACTOR_MODE: 'npc',
    AIRI_ACTOR_MODE: 'player',
    SGLUNA_CHAT_PLAYERS: '',
    AIRI_CHAT_PLAYERS: 'Legacy',
  }), { actorMode: 'npc', chatPlayers: '' })
})
