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
  assert.match(rcon.commands[0], /type\(r1\)=="table" and \(r1\[1\]==false or r1\.accepted==false or r1\.ok==false\)/)
})

test('correlated admissions persist each slot before continuing and expose a failed prefix without replay', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const correlation = { protocol_version: 2, operation_key: 'req/batch_1', attempt_id: 'req/batch_1', ordinal: 1,
    signature: 'hash', actor: { actor_id: 18, epoch: 3 } }
  const rcon = new FakeRcon([`${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 2',
    prefix: [[true, 'first admitted']], admission: { operation_key: 'req/batch_1', state: 'uncertain' } })}`])
  await assert.rejects(executeAuthorizedBatch(rcon,3,[
    'remote.call("autorio_operations","wait",60)', 'remote.call("autorio_operations","wait",60)',
  ],marker,correlation), error => {
    assert.equal(error.operationIndex,1)
    assert.deepEqual(error.results,[[true,'first admitted']])
    assert.equal(error.admission.state,'uncertain')
    assert.equal(error.noReplay,true)
    return true
  })
  assert.equal(rcon.commands.length,1)
  assert.match(rcon.commands[0],/operation_count/)
  assert.match(rcon.commands[0],/if not stored.ok then error/)
  assert.ok(rcon.commands[0].indexOf('"slot"') < rcon.commands[0].indexOf('local ok2,r2'))
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

test('everything rejected before the first RCON byte is provably not sent', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const wait = 'remote.call("autorio_operations","wait",60)'
  const base = { protocol_version: 2, operation_key: 'req/batch_1', attempt_id: 'req/batch_1', ordinal: 1, signature: 'hash', actor: { actor_id: 18, epoch: 3 } }
  const attempts = [
    [3, [wait], { ...base, ordinal: undefined }],
    [3, [wait], { ...base, operation_key: 'k'.repeat(193) }],
    [3, [wait], { ...base, actor: {} }],
    [3, [], base],
    [0, [wait], base],
    [3, ['game.clear()'], base],
  ]
  for (const [epoch, commands, correlation] of attempts) {
    const rcon = new FakeRcon([`${marker}${JSON.stringify({ ok: true, result: [true] })}`])
    await assert.rejects(executeAuthorizedBatch(rcon, epoch, commands, marker, correlation), error => error.notSent === true)
    assert.equal(rcon.commands.length, 0, 'nothing was sent')
  }
  // The runtime key limit equals the mod journal limit (192): exactly 192 is sent.
  const rcon = new FakeRcon([`${marker}${JSON.stringify({ ok: true, result: [true], admission: { state: 'completed' } })}`])
  await executeAuthorizedBatch(rcon, 3, [wait], marker, { ...base, operation_key: 'k'.repeat(192) })
  assert.equal(rcon.commands.length, 1)
})

test('a failure after the command was sent is never marked not sent, and only a begin refusal proves nothing was recorded', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const correlation = { protocol_version: 2, operation_key: 'req/batch_1', attempt_id: 'req/batch_1', ordinal: 1, signature: 'hash', actor: { actor_id: 18, epoch: 3 } }
  const wait = 'remote.call("autorio_operations","wait",60)'
  const lost = new FakeRcon(['no acknowledgement here'])
  await assert.rejects(executeAuthorizedBatch(lost, 3, [wait], marker, correlation), error => error.notSent !== true && error.notAdmitted !== true)
  for (const [code, expected] of [['admission_begin_refused:stale_actor_epoch', true], ['admission_begin_refused:expired_operation_ordinal', true],
    ['admission_begin_refused:admission_journal_full', true], ['admission_begin_refused:invalid_correlation', true], ['stale npc actor epoch', true],
    ['admission_begin_refused:operation_key_conflict', false], ['admission slot recording failed: invalid_slot', false],
    // finish() or slot() can return the same code after operations queued work: never a begin refusal.
    ['stale_actor_epoch', false], ['invalid_slot', false]]) {
    const rcon = new FakeRcon([`${marker}${JSON.stringify({ ok: false, result: code, prefix: [] })}`])
    await assert.rejects(executeAuthorizedBatch(rcon, 3, [wait], marker, correlation), error => error.notAdmitted === expected && error.notSent !== true, code)
  }
  // A begin-looking text after any slot ran (non-empty prefix) is not proof either.
  const ranSlots = new FakeRcon([`${marker}${JSON.stringify({ ok: false, result: 'admission_begin_refused:stale_actor_epoch', prefix: [[true, 'Task started']] })}`])
  await assert.rejects(executeAuthorizedBatch(ranSlots, 3, [wait], marker, correlation), error => error.notAdmitted === false)
  const finishStale = new FakeRcon([`${marker}${JSON.stringify({ ok: false, result: 'stale_actor_epoch', prefix: [[true, 'Task started']] })}`])
  await assert.rejects(executeAuthorizedBatch(finishStale, 3, [wait], marker, correlation), error => error.notAdmitted === false && error.notSent !== true)
  const recorded = new FakeRcon([`${marker}${JSON.stringify({ ok: false, result: 'stale_actor_epoch', prefix: [], admission: { state: 'uncertain' } })}`])
  await assert.rejects(executeAuthorizedBatch(recorded, 3, [wait], marker, correlation), error => error.notAdmitted === false)
})

test('correlated slots tell the mod the operation name and whether it was refused, never whether the refusal is safe', async () => {
  const marker = 'SGLUNA_RESULT_0123456789abcdef01234567:'
  const correlation = { protocol_version: 2, operation_key: 'req/batch_1', attempt_id: 'req/batch_1', ordinal: 1, signature: 'hash', actor: { actor_id: 18, epoch: 3 } }
  const rcon = new FakeRcon([`${marker}${JSON.stringify({ ok: true, result: [true], admission: { state: 'completed' } })}`])
  await executeAuthorizedBatch(rcon, 3, ['remote.call("autorio_operations","craft_item","iron-gear-wheel",1)'], marker, correlation)
  const command = rcon.commands[0]
  assert.match(command, /operation="craft_item",refused=refused/)
  assert.match(command, /local refused=ok1 and not accepted/)
  assert.doesNotMatch(command, /mutation_unknown/)
  assert.doesNotMatch(command, /refused_before_mutation/)
  assert.match(command, /"autorio rejected operation 1: "\.\.tostring\(detail\)/)
})
