export class StagingConfigError extends Error {}

function check(ok, message) {
  if (!ok) throw new StagingConfigError(message)
}

function cleanName(value, label, max = 64) {
  check(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `Invalid ${label}`)
  return value
}

export function parseChatPlayers(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed === '*') return { mode: 'all', names: [] }
  if (trimmed.toLowerCase() === 'none') return { mode: 'disabled', names: [] }
  const seen = new Set()
  const names = []
  for (const part of trimmed.split(',')) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { mode: 'allowlist', names }
}

function hasEnv(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key)
}

export function stagingConfiguration(raw = {}, env = process.env) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'sgluna-config.json must be an object')
  const actorMode = hasEnv(env, 'SGLUNA_ACTOR_MODE') ? env.SGLUNA_ACTOR_MODE : hasEnv(env, 'AIRI_ACTOR_MODE') ? env.AIRI_ACTOR_MODE : raw.actorMode ?? 'player'
  check(actorMode === 'npc' || actorMode === 'player', 'SGLUNA_ACTOR_MODE must be npc or player')

  const legacyPlayer = cleanName(env.AIRI_PLAYER ?? raw.player ?? '', 'AIRI_PLAYER')
  const legacySingle = cleanName(env.AIRI_CHAT_PLAYER ?? raw.chatPlayer ?? (actorMode === 'npc' ? legacyPlayer : ''), 'AIRI_CHAT_PLAYER')
  const chatPlayersSource = cleanName(
    hasEnv(env, 'SGLUNA_CHAT_PLAYERS') ? env.SGLUNA_CHAT_PLAYERS
      : hasEnv(env, 'AIRI_CHAT_PLAYERS') ? env.AIRI_CHAT_PLAYERS
        : hasEnv(env, 'AIRI_CHAT_PLAYER') ? env.AIRI_CHAT_PLAYER
          : (actorMode === 'npc' && hasEnv(env, 'AIRI_PLAYER')) ? env.AIRI_PLAYER
            : raw.chatPlayers ?? legacySingle,
    'SGLUNA_CHAT_PLAYERS',
    512,
  )

  return {
    actorMode,
    // In player mode this retains the v7 controlled-player meaning. In NPC
    // mode it is never actor ownership; it is only accepted as a deprecated
    // chat-authorizer fallback when AIRI_CHAT_PLAYERS/AIRI_CHAT_PLAYER is unset.
    player: actorMode === 'player' ? legacyPlayer : '',
    chatPlayers: parseChatPlayers(chatPlayersSource),
  }
}

export function seedStagingConfigFromEnv(env = process.env) {
  const config = {}
  if (hasEnv(env, 'SGLUNA_ACTOR_MODE')) config.actorMode = env.SGLUNA_ACTOR_MODE
  else if (hasEnv(env, 'AIRI_ACTOR_MODE')) config.actorMode = env.AIRI_ACTOR_MODE
  if (hasEnv(env, 'SGLUNA_CHAT_PLAYERS')) config.chatPlayers = env.SGLUNA_CHAT_PLAYERS
  else if (hasEnv(env, 'AIRI_CHAT_PLAYERS')) config.chatPlayers = env.AIRI_CHAT_PLAYERS
  else if (hasEnv(env, 'AIRI_CHAT_PLAYER')) config.chatPlayers = env.AIRI_CHAT_PLAYER
  if (env.AIRI_PLAYER) config.player = env.AIRI_PLAYER
  return config
}

function actorSnapshot(status) {
  check(status && typeof status === 'object' && !Array.isArray(status), 'Missing actor status')
  const actor = status.actor
  check(actor && typeof actor === 'object', 'Controlled actor is missing')
  check(actor.valid === true && actor.has_character === true, 'Controlled actor is not a valid character')
  check(Number.isSafeInteger(actor.actor_id) && actor.actor_id > 0, 'Controlled actor has no stable identity')
  check(actor.kind === 'standalone_character' || actor.kind === 'connected_player', 'Unexpected actor kind')
  return actor
}

export function assertNpcReady(status) {
  check(status?.mode === 'npc', 'Autorio actor mode is not npc')
  const actor = actorSnapshot(status)
  check(actor.kind === 'standalone_character', 'NPC mode did not resolve a standalone character')
  const load = status.load_reconciliation
  check(load && load.pending === false, 'NPC load reconciliation is still pending')
  if (load.last_actor_id !== undefined) {
    check(load.last_actor_id === actor.actor_id, 'Load reconciliation belongs to a different actor')
  }
  // connected_players is deliberately not an authorization condition in NPC
  // mode. Zero, one, or many humans can exist without changing actor ownership.
  check(Number.isSafeInteger(status.connected_players) && status.connected_players >= 0, 'Invalid connected player count')
  return actor
}

export function actorEpoch(status) {
  const actor = assertNpcReady(status)
  return Object.freeze({
    mode: status.mode,
    actorId: actor.actor_id,
    actorKind: actor.kind,
  })
}

export function sameActorEpoch(expected, status) {
  try {
    const current = actorEpoch(status)
    return expected
      && expected.mode === current.mode
      && expected.actorId === current.actorId
      && expected.actorKind === current.actorKind
  }
  catch {
    return false
  }
}

export function requireActorEpoch(expected, status) {
  check(sameActorEpoch(expected, status), 'NPC actor epoch changed; stale model work rejected')
  return true
}

export function chatAuthorized(config, sender) {
  if (!config || config.actorMode !== 'npc') return false
  if (!sender) return false
  const chatPlayers = config.chatPlayers
  if (!chatPlayers) return false
  if (chatPlayers.mode === 'all') return true
  if (chatPlayers.mode === 'disabled') return false
  return chatPlayers.names.includes(sender)
}

export function npcStartupCommands() {
  return {
    setMode: '/silent-command local r=remote.call("autorio_actor","set_mode","npc"); rcon.print(helpers.table_to_json(r))',
    actorStatus: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))',
    taskStatus: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))',
  }
}

export function validateTaskStatus(status, epoch) {
  check(status && typeof status === 'object' && !Array.isArray(status), 'Missing Autorio task status')
  const actor = status.actor
  check(actor && actor.valid === true && actor.kind === epoch.actorKind && actor.actor_id === epoch.actorId, 'Task status belongs to a different actor')
  check(typeof status.task_state === 'string', 'Missing task state')
  check(typeof status.queue_empty === 'boolean' && Number.isSafeInteger(status.queue_length) && status.queue_length >= 0, 'Invalid task queue status')
  return status
}

export class NpcSessionEpoch {
  constructor(status) {
    this.value = actorEpoch(status)
  }

  authorize(status) {
    return sameActorEpoch(this.value, status)
  }

  assert(status) {
    return requireActorEpoch(this.value, status)
  }

  replace(status) {
    this.value = actorEpoch(status)
    return this.value
  }
}
