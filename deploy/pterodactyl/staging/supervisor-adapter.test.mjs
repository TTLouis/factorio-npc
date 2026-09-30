import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actorChanged,
  configureNpcSession,
  deploymentStatus,
  executeAuthorizedBatch,
  executeAuthorizedOperation,
  validatedOperationCall,
} from './supervisor-adapter.mjs'

const SESSION = '0123456789abcdef0123456789abcdef'
const CONFIG_MARKER = 'SGLUNA_CONFIG_0123456789abcdef01234567:'

function readyStatus(overrides = {}) {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: SESSION,
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
    ...overrides,
  }
}

class FakeRcon {
  constructor(responses = []) {
    this.responses = [...responses]
    this.commands = []
  }

  async command(text) {
    this.commands.push(text)
    if (!this.responses.length) throw new Error('unexpected RCON command')
    const next = this.responses.shift()
    return typeof next === 'function' ? next(text) : next
  }
}

function configureAck(result = SESSION) {
  return `${CONFIG_MARKER}${JSON.stringify({ ok: true, result })}`
}

test('configure handshake selects npc and verifies the native deployment status', async () => {
  const rcon = new FakeRcon([
    configureAck(),
    JSON.stringify(readyStatus()),
  ])
  const status = await configureNpcSession(rcon, SESSION, CONFIG_MARKER)
  assert.equal(status.actor_id, 18)
  assert.match(rcon.commands[0], /"configure","npc"/)
  assert.match(rcon.commands[0], /SGLUNA_CONFIG_0123456789abcdef01234567:/)
  assert.match(rcon.commands[1], /"sgluna_deployment","status"/)
})

test('configure handshake rebinds once when the actor changes immediately after configure', async () => {
  const rcon = new FakeRcon([
    configureAck(),
    JSON.stringify(readyStatus({ allowed: false, actor_id: 42, epoch: 4 })),
    configureAck(),
    JSON.stringify(readyStatus({ allowed: true, actor_id: 42, epoch: 5 })),
  ])

  const status = await configureNpcSession(rcon, SESSION, CONFIG_MARKER)
  assert.equal(status.allowed, true)
  assert.equal(status.actor_id, 42)
  assert.equal(status.epoch, 5)
  assert.equal(rcon.commands.length, 4)
  assert.equal(rcon.commands[0], rcon.commands[2])
  assert.match(rcon.commands[1], /"sgluna_deployment","status"/)
  assert.match(rcon.commands[3], /"sgluna_deployment","status"/)
})

test('configure handshake bounds repeated unauthorized rebinds and still fails closed', async () => {
  const rcon = new FakeRcon([
    configureAck(),
    JSON.stringify(readyStatus({ allowed: false, actor_id: 42, epoch: 4 })),
    configureAck(),
    JSON.stringify(readyStatus({ allowed: false, actor_id: 43, epoch: 5 })),
  ])

  await assert.rejects(() => configureNpcSession(rcon, SESSION, CONFIG_MARKER), /not authorized/)
  assert.equal(rcon.commands.length, 4)
})

test('configure handshake repeats the exact command when Factorio echoes the blocked command including the marker', async () => {
  const rcon = new FakeRcon([
    text => `Player <server> tried using the command ${text}. Lua console commands will disable achievements. Please repeat the command to proceed.`,
    configureAck(),
    JSON.stringify(readyStatus()),
  ])
  await configureNpcSession(rcon, SESSION, CONFIG_MARKER)
  assert.equal(rcon.commands[0], rcon.commands[1])
  assert.match(rcon.commands[0], new RegExp(CONFIG_MARKER))
  assert.notEqual(rcon.commands[1], rcon.commands[2])
})

test('configure handshake fails closed when the repeated command still has no execution acknowledgement', async () => {
  const rcon = new FakeRcon([
    'Please repeat the command to proceed.',
    'still no acknowledgement',
  ])
  await assert.rejects(() => configureNpcSession(rcon, SESSION, CONFIG_MARKER), /acknowledgement missing/)
  assert.equal(rcon.commands.length, 2)
  assert.equal(rcon.commands[0], rcon.commands[1])
})

test('deployment status can inspect an unauthorized replacement epoch but strict callers still fail closed', async () => {
  const inspect = new FakeRcon([JSON.stringify(readyStatus({ allowed: false, actor_id: 42 }))])
  const status = await deploymentStatus(inspect)
  assert.equal(status.allowed, false)
  assert.equal(status.actor_id, 42)

  const strict = new FakeRcon([JSON.stringify(readyStatus({ allowed: false, actor_id: 42 }))])
  await assert.rejects(() => deploymentStatus(strict, { requireAllowed: true }), /not authorized/)
})

test('deployment status requires native npc identity and interfaces', async () => {
  for (const broken of [
    { revision: 'airi-deploy-v7' },
    { mode: 'player' },
    { actor_kind: 'connected_player' },
    { actor_id: undefined },
    { epoch: 0 },
    { actor_interface: false },
    { operations: false },
    { tools: false },
  ]) {
    const rcon = new FakeRcon([JSON.stringify(readyStatus(broken))])
    await assert.rejects(() => deploymentStatus(rcon))
  }
})

test('authorized operation wraps the mutation with an atomic actor-epoch check', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const rcon = new FakeRcon([
    `tool output\n${marker}${JSON.stringify({ ok: true, result: [true, 'Task started'] })}`,
  ])
  const result = await executeAuthorizedOperation(
    rcon,
    3,
    'remote.call("autorio_operations","wait",60)',
    marker,
  )
  assert.deepEqual(result.result, [true, 'Task started'])
  assert.equal(result.output, 'tool output')
  assert.match(rcon.commands[0], /sgluna_deployment","authorize",3/)
  assert.match(rcon.commands[0], /autorio_operations","wait",60/)
})

test('authorized dependency batch admits every operation in one RCON/Lua transaction', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const rcon = new FakeRcon([
    `${marker}${JSON.stringify({ ok: true, result: [true, [true, 'second']] })}`,
  ])
  const result = await executeAuthorizedBatch(rcon, 3, [
    'remote.call("autorio_operations","mine_entity","iron-ore",1)',
    'remote.call("autorio_operations","wait",300)',
  ], marker)

  assert.equal(rcon.commands.length, 1)
  assert.deepEqual(result.results, [true, [true, 'second']])
  assert.equal((rcon.commands[0].match(/sgluna_deployment","authorize",3/g) ?? []).length, 1)
  const first = rcon.commands[0].indexOf('autorio_operations","mine_entity"')
  const second = rcon.commands[0].indexOf('autorio_operations","wait"')
  assert.ok(first >= 0 && second > first)
  assert.match(rcon.commands[0], /local ok1,r1=pcall\(function\(\) return remote\.call/)
  assert.match(rcon.commands[0], /local ok2,r2=pcall\(function\(\) return remote\.call/)
  assert.match(rcon.commands[0], /type\(r1\)=="table" and r1\[1\]==false/)
})

test('mutation rejection, missing acknowledgement, and stale authorization fail closed without retries', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  for (const raw of [
    `${marker}${JSON.stringify({ ok: false, result: 'stale npc actor epoch' })}`,
    `${marker}${JSON.stringify({ ok: true, result: false })}`,
    `${marker}${JSON.stringify({ ok: true, result: [false, 'no target'] })}`,
    'no acknowledgement here',
  ]) {
    const rcon = new FakeRcon([raw])
    await assert.rejects(() => executeAuthorizedOperation(rcon, 3, 'remote.call("autorio_operations","wait",60)', marker))
    assert.equal(rcon.commands.length, 1)
  }
})

test('batch rejection or missing acknowledgement fails closed without replaying admissions', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  for (const raw of [
    `${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 1' })}`,
    'no acknowledgement here',
  ]) {
    const rcon = new FakeRcon([raw])
    await assert.rejects(() => executeAuthorizedBatch(rcon, 3, [
      'remote.call("autorio_operations","wait",60)',
      'remote.call("autorio_operations","wait",60)',
    ], marker))
    assert.equal(rcon.commands.length, 1)
  }
})

test('operation renderer boundary rejects arbitrary Lua and control characters', () => {
  assert.equal(validatedOperationCall('remote.call("autorio_operations","wait",60)'), 'remote.call("autorio_operations","wait",60)')
  assert.throws(() => validatedOperationCall('game.clear()'))
  assert.throws(() => validatedOperationCall('remote.call("autorio_tools","get_inventory_items")'))
  assert.throws(() => validatedOperationCall('remote.call("autorio_operations","wait",60)\n/c game.clear()'))
})

test('actor epoch comparison ignores connected-player count but notices actor/epoch changes', () => {
  const first = readyStatus({ connected_players: 0 })
  assert.equal(actorChanged(first, readyStatus({ connected_players: 4 })), false)
  assert.equal(actorChanged(first, readyStatus({ actor_id: 42 })), true)
  assert.equal(actorChanged(first, readyStatus({ epoch: 4 })), true)
  assert.equal(actorChanged(first, readyStatus({ mode: 'player' })), true)
})
