import assert from 'node:assert/strict'
import test from 'node:test'

import { ADMISSION_REFUSAL, authorizationOf, evaluateOperationAdmission } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  executeReserveCommand,
  parseReserveCommand,
  parseReserveTarget,
  RESERVE_COMMAND_STATUS,
  reserveTargetLookupCommand,
} from './reserve-command.mjs'
import { Session } from './supervisor.mjs'

// MW1 reserved supplies. The command SYNTAX is provisional (pending the owner) and lives in reserve-command.mjs; the
// record and the exclusion check are not. These tests pin the provisional syntax so a change to it is deliberate.

const KEY = 'npc:sgluna'
const CHEST = { ok: true, unit_number: 900, name: 'wooden-chest', surface_index: 1, position: { x: 4.5, y: 5.5 } }

function fakeRcon(reply) {
  const commands = []
  return {
    commands,
    async command(text) {
      commands.push(text)
      if (reply instanceof Error) throw reply
      return typeof reply === 'string' ? reply : JSON.stringify(reply)
    },
  }
}

test('MW1 reserve (PROVISIONAL syntax): the whole message is "reserve" or "unreserve", optionally with this/that/the chest/container', () => {
  assert.equal(RESERVE_COMMAND_STATUS, 'provisional_pending_owner')
  for (const text of ['reserve', 'Reserve', ' reserve ', 'reserve this', 'reserve this chest', 'reserve the container.', 'reserve storage!']) {
    assert.deepEqual(parseReserveCommand(text), { action: 'reserve' }, text)
  }
  for (const text of ['unreserve', 'UNRESERVE', 'unreserve this chest', 'unreserve the container']) {
    assert.deepEqual(parseReserveCommand(text), { action: 'release' }, text)
  }
  // A goal that merely starts with the word is a goal, not the command.
  for (const text of ['reserve iron for me', 'please reserve this chest', 'reserved', 'unreserve everything', 'reserve 5 chests', '', undefined]) {
    assert.equal(parseReserveCommand(text), null, String(text))
  }
})

test('MW1 reserve: the target lookup is a read-only game query for the selected container, else the nearest within 8 tiles', () => {
  const command = reserveTargetLookupCommand("Lou'is")
  assert.ok(command.startsWith('/silent-command '))
  assert.ok(command.includes("game.get_player('Lou\\'is')"), 'the player name is Lua-escaped')
  assert.ok(command.includes('p.selected'))
  assert.ok(command.includes("'container','logistic-container'"))
  assert.ok(command.includes('radius=8'))
  assert.ok(command.includes('rcon.print(helpers.table_to_json'))
  assert.equal(/destroy|insert|remove|teleport|create_entity/.test(command), false, 'the lookup mutates nothing')

  assert.deepEqual(parseReserveTarget(JSON.stringify(CHEST)), { ok: true, unit_number: 900, entity_name: 'wooden-chest', surface_index: 1, position: { x: 4.5, y: 5.5 } })
  assert.deepEqual(parseReserveTarget('{"ok":false,"code":"no_container"}'), { ok: false, code: 'no_container' })
  for (const bad of ['', 'not json', '[]', '{"ok":true}', '{"ok":true,"unit_number":0}', '{"ok":true,"unit_number":1.5}']) {
    assert.equal(parseReserveTarget(bad).ok, false, bad)
  }
})

test('MW1 reserve: reserve records the container, refuses a second reserve, and unreserve releases it; each emits a trace row', async () => {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  memory.traceSink = (name, payload) => rows.push({ name, ...payload })
  const rcon = fakeRcon(CHEST)

  const reserved = await executeReserveCommand({ rcon, memory, key: KEY, sender: 'louis', command: { action: 'reserve' }, requestId: 'req_chat_1', now: 100 })
  assert.equal(reserved.ok, true)
  assert.equal(reserved.code, 'reserved')
  assert.match(reserved.message, /wooden-chest #900/)
  assert.equal(rcon.commands.length, 1)
  assert.ok(rcon.commands[0].includes("get_player('louis')"))
  const record = authorizationOf(memory.planningState(KEY)).world.reservations[0]
  assert.deepEqual([record.unit_number, record.entity_name, record.reserved_by, record.status, record.surface_index], [900, 'wooden-chest', 'louis', 'active', 1])
  assert.deepEqual(record.position, { x: 4.5, y: 5.5 })
  assert.deepEqual([rows.at(-1).name, rows.at(-1).ok, rows.at(-1).request_id], ['reservation.recorded', true, 'req_chat_1'])

  // It takes effect at admission right away, with no goal and no plan (a world fact).
  const state = memory.planningState(KEY)
  const take = [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }]
  assert.equal(evaluateOperationAdmission(state, { operations: take, preflight: [{ ok: true }] }).code, ADMISSION_REFUSAL.RESERVED_SUPPLY)

  const again = await executeReserveCommand({ rcon, memory, key: KEY, sender: 'louis', command: { action: 'reserve' } })
  assert.deepEqual([again.ok, again.code], [false, 'already_reserved'])

  const released = await executeReserveCommand({ rcon, memory, key: KEY, sender: 'louis', command: { action: 'release' }, requestId: 'req_chat_2' })
  assert.deepEqual([released.ok, released.code], [true, 'released'])
  assert.deepEqual([rows.at(-1).name, rows.at(-1).ok, rows.at(-1).request_id], ['reservation.released', true, 'req_chat_2'])
  assert.deepEqual(evaluateOperationAdmission(memory.planningState(KEY), { operations: take, preflight: [{ ok: true }] }), { ok: true })
  const notReserved = await executeReserveCommand({ rcon, memory, key: KEY, sender: 'louis', command: { action: 'release' } })
  assert.deepEqual([notReserved.ok, notReserved.code], [false, 'not_reserved'])
})

test('MW1 reserve: a missing player, no container in reach or a failing lookup reserves nothing and never throws', async () => {
  const memory = new CanonicalTaskBoardMemory()
  for (const [reply, code] of [
    [{ ok: false, code: 'no_player' }, 'no_player'],
    [{ ok: false, code: 'no_container' }, 'no_container'],
    ['garbled', 'lookup_failed'],
    [new Error('rcon down'), 'lookup_failed'],
  ]) {
    const result = await executeReserveCommand({ rcon: fakeRcon(reply), memory, key: KEY, sender: 'louis', command: { action: 'reserve' } })
    assert.deepEqual([result.ok, result.code], [false, code])
    assert.ok(result.message.length > 0)
  }
  assert.equal(memory.planningState(KEY), undefined, 'nothing was recorded')
})

test('MW1 reserve: the supervisor handles the command itself - no model call, no goal - and the reservation survives a restart', async () => {
  const memory = new CanonicalTaskBoardMemory()
  const chat = []
  let persisted = 0
  let requests = 0
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    eventQueue: Promise.resolve(),
    npcName: 'SGLuna',
    npcId: 'sgluna',
    log: () => {},
    stopping: false,
    rcon: fakeRcon(CHEST),
    agent: {
      memory,
      activePlanKey: () => KEY,
      persistState: async () => { persisted++ },
      request: async () => { requests++ },
      cancel: () => {},
    },
    printChat: async message => { chat.push(message) },
    clearAutoResume: () => { throw new Error('a reserve command must not touch the automatic resume') },
  })

  assert.equal(session.queuePlayerRequest('louis', 'reserve'), true)
  await session.eventQueue
  assert.equal(requests, 0, 'the model is never asked')
  assert.equal(persisted, 1)
  assert.match(chat.at(-1), /Reserved wooden-chest #900/)
  assert.equal(authorizationOf(memory.planningState(KEY)).world.reservations[0].unit_number, 900)

  // A restart: the snapshot the loop persists restores the reservation and the exclusion still holds.
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  const take = [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }]
  assert.equal(evaluateOperationAdmission(restored.planningState(KEY), { operations: take, preflight: [{ ok: true }] }).code, ADMISSION_REFUSAL.RESERVED_SUPPLY)

  assert.equal(session.queuePlayerRequest('louis', 'unreserve this chest'), true)
  await session.eventQueue
  assert.match(chat.at(-1), /Released wooden-chest #900/)
  assert.equal(requests, 0)
})
