import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { operationSignature } from '../../deploy/pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { configuration } from './cli.mjs'
import { openRuntime } from './runtime.mjs'

const session = 'external-test-session-00000000000001'
const operation = { name: 'wait', args: { ticks: 60 } }

// Only the bridge/game is mocked here. Runtime journal, filesystem durability,
// restart handling, idempotency and concurrency use their real implementation.
async function fixture(t, prefix = 'factorio-external-runtime-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  let state = 'running'
  let high = 0
  let sendError
  let receiptError = false
  const calls = []
  const bridge = {
    capabilities: () => ({ operations: ['wait'] }),
    snapshot: async () => ({ guard: { session, actor_id: 1, epoch: 1, allowed: true }, status: { task_state: state === 'running' ? 'waiting' : 'idle', queue_length: 0 }, journal: { high_water: high }, tick: 100 }),
    prepare: async (value, key) => ({ operation: value, pending: { operation_key: key, signature: operationSignature([value]), actor: { actor_id: 1, epoch: 1 }, ordinal: high + 1 } }),
    submit: async prepared => {
      const data = JSON.parse(await fs.readFile(path.join(directory, 'ledger.json'), 'utf8'))
      assert.equal(data.records.at(-1).prepared.pending.operation_key, prepared.pending.operation_key, 'write-ahead record exists before send')
      calls.push(['submit', prepared])
      if (sendError?.notAdmitted !== true) high++
      if (sendError) throw sendError
    },
    receipt: async pending => {
      calls.push(['receipt', pending])
      if (receiptError) throw new Error('private failure contents')
      return { state, terminal: ['completed', 'cancelled', 'rejected'].includes(state), effect: state === 'completed' ? 'happened' : 'unknown', reason: `native_${state}`, high_water: high,
        requires_reconciliation: state === 'cancelled', evidence: { admission: { ordinal: pending.ordinal }, tick: 100 } }
    },
    observe: async (name, args) => ({ name, args }),
    cancel: async () => { calls.push(['cancel']); state = 'cancelled' },
  }
  const opened = []
  async function open() {
    const runtime = await openRuntime({ bridge, directory, session, pollMs: 5 })
    opened.push(runtime)
    return runtime
  }
  t.after(async () => { for (const runtime of opened) await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, bridge, calls, open, setState: value => { state = value }, setHigh: value => { high = value },
    setSendError: value => { sendError = value }, setReceiptError: value => { receiptError = value } }
}

test('write-ahead admission stays running; exact completion remains distinct from goal verification', async t => {
  const f = await fixture(t); const runtime = await f.open()
  const admitted = await runtime.submit({ request_id: 'first', operation })
  assert.equal(admitted.state, 'running'); assert.equal(admitted.terminal, false); assert.equal(admitted.goal_verified, false)
  f.setState('completed')
  const completed = await runtime.get({ operation_id: admitted.operation_id })
  assert.equal(completed.state, 'completed'); assert.equal(completed.goal_verified, false)
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('identical request is idempotent concurrently and conflicting payload cannot mutate', async t => {
  const f = await fixture(t); const runtime = await f.open()
  const [a, b] = await Promise.all([runtime.submit({ request_id: 'same', operation }), runtime.submit({ request_id: 'same', operation })])
  assert.equal(a.operation_id, b.operation_id)
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
  await assert.rejects(runtime.submit({ request_id: 'same', operation: { name: 'wait', args: { ticks: 61 } } }), { code: 'request_id_conflict' })
  await assert.rejects(runtime.submit({ request_id: 'new', operation }), { code: 'operation_unsettled' })
})

test('lost acknowledgement and process restart resume the original operation without replay', async t => {
  const f = await fixture(t); let runtime = await f.open()
  f.setSendError(new Error('socket closed after write'))
  f.setReceiptError(true)
  const initial = await runtime.submit({ request_id: 'crash', operation })
  assert.equal(initial.state, 'uncertain')
  assert.ok(!JSON.stringify(initial).includes('socket closed'))
  await runtime.close()
  runtime = await f.open()
  f.setReceiptError(false); f.setState('completed')
  assert.equal((await runtime.resume({ operation_id: initial.operation_id })).state, 'completed')
  assert.equal((await runtime.submit({ request_id: 'crash', operation })).operation_id, initial.operation_id)
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('an unsent write-ahead crash is uncertain; neither resume nor resubmit can replay it', async t => {
  const f = await fixture(t); let runtime = await f.open()
  f.bridge.submit = async () => { throw new Error('crash before network send') }
  f.setReceiptError(true)
  const original = await runtime.submit({ request_id: 'unsent', operation })
  await runtime.close(); runtime = await f.open()
  assert.equal((await runtime.resume({ operation_id: original.operation_id })).state, 'uncertain')
  assert.equal((await runtime.submit({ request_id: 'unsent', operation })).state, 'uncertain')
  await assert.rejects(runtime.submit({ request_id: 'replacement', operation }), { code: 'operation_unsettled' })
})

test('explicit proven nonadmission is safely rejected and same key is never reused', async t => {
  const f = await fixture(t); const runtime = await f.open()
  f.setSendError(Object.assign(new Error('atomic preflight refused'), { notAdmitted: true }))
  const result = await runtime.submit({ request_id: 'refused', operation })
  assert.equal(result.state, 'rejected'); assert.equal(result.effect, 'not_happened')
  f.setSendError(null)
  assert.equal((await runtime.submit({ request_id: 'refused', operation })).state, 'rejected')
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('bounded receipt waits release the mutex so exact cancel can interrupt', async t => {
  const f = await fixture(t); const runtime = await f.open()
  const result = await runtime.submit({ request_id: 'interrupt', operation })
  const waiting = runtime.get({ operation_id: result.operation_id, wait_ms: 1000 })
  const cancelled = await runtime.cancel({ operation_id: result.operation_id })
  assert.equal(cancelled.state, 'cancelled'); assert.equal((await waiting).state, 'cancelled')
  assert.equal((await runtime.context()).reconciliation_required.length, 1)
  await runtime.cancel({ operation_id: result.operation_id })
  assert.equal(f.calls.filter(([name]) => name === 'cancel').length, 1)
})

test('completed receipt survives restart but save rollback prevents fresh mutation', async t => {
  const f = await fixture(t); let runtime = await f.open()
  f.setState('completed')
  const result = await runtime.submit({ request_id: 'old-world', operation })
  await runtime.close(); runtime = await f.open(); f.setHigh(0)
  await assert.rejects(runtime.resume({ operation_id: result.operation_id }), { code: 'world_rollback_detected' })
  await assert.rejects(runtime.submit({ request_id: 'new-world', operation }), { code: 'world_rollback_detected' })
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('wrong world session cannot observe or submit', async t => {
  const f = await fixture(t); const runtime = await f.open()
  f.bridge.snapshot = async () => ({ guard: { session: 'different-world' }, journal: { high_water: 0 } })
  await assert.rejects(runtime.observe({ name: 'getActorStatus' }), { code: 'world_session_mismatch' })
  await assert.rejects(runtime.submit({ request_id: 'wrong', operation }), { code: 'world_session_mismatch' })
  assert.equal(f.calls.length, 0)
})

test('same-highwater restored in-flight save invalidates current completion without losing historical evidence', async t => {
  const f = await fixture(t); let runtime = await f.open()
  f.setState('completed')
  const result = await runtime.submit({ request_id: 'restored-inflight', operation })
  await runtime.close(); runtime = await f.open()
  f.setState('uncertain') // Same admission ordinal, but loaded generation no longer proves completion.
  assert.equal((await runtime.context()).pending.length, 1)
  const resumed = await runtime.resume({ operation_id: result.operation_id })
  assert.equal(resumed.state, 'uncertain'); assert.equal(resumed.terminal, false)
  assert.equal(resumed.historical_execution.state, 'completed')
  const cancel = await runtime.cancel({ operation_id: result.operation_id })
  assert.equal(cancel.state, 'uncertain'); assert.equal(cancel.terminal, false)
  assert.equal(f.calls.filter(([name]) => name === 'cancel').length, 0)
  await assert.rejects(runtime.submit({ request_id: 'unsafe-new', operation }), { code: 'operation_unsettled' })
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('legitimately evicted native receipt stays explicitly historical, never replayed', async t => {
  const f = await fixture(t); const runtime = await f.open()
  f.setState('completed')
  const result = await runtime.submit({ request_id: 'old-receipt', operation })
  f.bridge.receipt = async () => ({ state: 'uncertain', reason: 'exact_admission_missing', terminal: false })
  const resumed = await runtime.resume({ operation_id: result.operation_id })
  assert.equal(resumed.receipt_scope, 'historical_execution')
  assert.equal(resumed.current_world_verified, false)
  assert.equal(resumed.current_reconciliation.reason, 'exact_admission_missing')
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('exclusive journal lock refuses a second controller and preserves ownership', async t => {
  const f = await fixture(t); const first = await f.open()
  await assert.rejects(f.open(), { code: 'state_locked' })
  await first.close()
  const next = await f.open()
  assert.ok(next)
})

test('durable-write failure prevents send and poisons future mutations', async t => {
  const f = await fixture(t); const runtime = await f.open()
  await fs.mkdir(path.join(f.directory, 'ledger.json'))
  await assert.rejects(runtime.submit({ request_id: 'cannot-persist', operation }), { code: 'journal_write_failed' })
  await assert.rejects(runtime.submit({ request_id: 'still-cannot', operation }), { code: 'journal_write_failed' })
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
})

for (const phase of ['writeFile', 'sync', 'close']) {
  test(`write-ahead ${phase} failure is not ignored as a Windows compatibility error`, async t => {
    const f = await fixture(t); const runtime = await f.open()
    await runtime.context() // Persist initial world age before the injected admission failure.
    const originalOpen = fs.open.bind(fs)
    const fault = t.mock.method(fs, 'open', async (...args) => {
      const file = await originalOpen(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const original = file[phase].bind(file)
        file[phase] = async (...values) => {
          // Close the real handle before reporting a close failure, so this
          // deterministic fault test does not leak an operating-system handle.
          if (phase === 'close') await original(...values)
          throw Object.assign(new Error('injected filesystem denial'), { code: 'EPERM' })
        }
      }
      return file
    })
    try {
      await assert.rejects(runtime.submit({ request_id: `fault-${phase}`, operation }), { code: 'journal_write_failed' })
      await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
      assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
    }
    finally { fault.mock.restore() }
  })
}

test('Windows native replacement refusal preserves the old ledger and poisons admission', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const runtime = await f.open()
  await runtime.context()
  const ledgerPath = path.join(f.directory, 'ledger.json')
  const previous = await fs.readFile(ledgerPath, 'utf8')
  // A read-only Windows destination makes the real MoveFileExW call fail.
  await fs.chmod(ledgerPath, 0o444)
  try {
    await assert.rejects(runtime.submit({ request_id: 'readonly-destination', operation }), { code: 'journal_write_failed' })
    await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
    assert.equal(await fs.readFile(ledgerPath, 'utf8'), previous)
    assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
  }
  finally { await fs.chmod(ledgerPath, 0o600) }
})

test('Windows journal paths with spaces, Unicode and shell syntax remain literal argv data', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "factorio journal 雪 ' & $()-"); const runtime = await f.open()
  f.setState('completed')
  assert.equal((await runtime.submit({ request_id: 'literal-path', operation })).state, 'completed')
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1)
})

test('Windows junction state directory is refused before mutation', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const target = path.join(f.directory, 'owned-target')
  const junction = path.join(f.directory, 'owned-junction')
  await fs.mkdir(target)
  await fs.symlink(target, junction, 'junction')
  const runtime = await openRuntime({ bridge: f.bridge, directory: junction, session })
  try {
    await assert.rejects(runtime.submit({ request_id: 'junction', operation }), { code: 'journal_write_failed' })
    await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
    assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
    await assert.rejects(fs.stat(path.join(target, 'ledger.json')), { code: 'ENOENT' })
  }
  finally { await runtime.close() }
})

for (const code of ['ENOENT', 'ETIMEDOUT', 1]) {
  test(`Windows helper failure ${code} prevents send and poisons admission`, { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); const runtime = await f.open()
    await runtime.context()
    const fault = t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error('injected helper failure'), { code })))
    })
    try {
      await assert.rejects(runtime.submit({ request_id: 'child-failed', operation }), { code: 'journal_write_failed' })
      await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
      assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
      const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'))
      assert.equal(persisted.records.length, 0)
    }
    finally { fault.mock.restore() }
  })
}

for (const phase of ['rename', 'directory-sync']) {
  test(`POSIX ${phase} failure still fences admission`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t); const runtime = await f.open()
    await runtime.context()
    const denied = () => { throw Object.assign(new Error('injected filesystem denial'), { code: 'EPERM' }) }
    const originalOpen = fs.open.bind(fs)
    const fault = phase === 'rename' ? t.mock.method(fs, 'rename', denied) : t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] === f.directory) handle.sync = denied
      return handle
    })
    try {
      await assert.rejects(runtime.submit({ request_id: `fault-${phase}`, operation }), { code: 'journal_write_failed' })
      await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
      assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
    }
    finally { fault.mock.restore() }
  })
}

test('Windows lost helper acknowledgement after replacement fences send and restart never replays', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let runtime = await f.open()
  await runtime.context()
  const originalExec = childProcess.execFile.bind(childProcess)
  const fault = t.mock.method(childProcess, 'execFile', (file, args, options, callback) => originalExec(file, args, options,
    (error, stdout, stderr) => callback(error ?? Object.assign(new Error('helper acknowledgement lost'), { code: 'EIO' }), stdout, stderr)))
  try {
    await assert.rejects(runtime.submit({ request_id: 'helper-ack-lost', operation }), { code: 'journal_write_failed' })
    const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'))
    assert.equal(persisted.records[0].request_id, 'helper-ack-lost', 'real replacement completed before helper failure')
    await assert.rejects(runtime.submit({ request_id: 'poisoned', operation }), { code: 'journal_write_failed' })
    assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
  }
  finally { fault.mock.restore() }
  await runtime.close(); runtime = await f.open()
  f.setReceiptError(true)
  assert.equal((await runtime.submit({ request_id: 'helper-ack-lost', operation })).state, 'uncertain')
  await assert.rejects(runtime.submit({ request_id: 'replacement', operation }), { code: 'operation_unsettled' })
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0)
})

test('corrupt journal fails closed and releases acquired lock', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.directory, 'ledger.json'), '{not-json')
  await assert.rejects(f.open())
  await assert.rejects(fs.stat(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' })
  assert.equal(f.calls.length, 0)
})

test('bounded arguments and unapproved operations cannot reach bridge', async t => {
  const f = await fixture(t); const runtime = await f.open()
  await assert.rejects(runtime.submit({ request_id: '../escape', operation }), { code: 'invalid_request_id' })
  await assert.rejects(runtime.submit({ request_id: 'raw', operation: { name: 'lua', args: { command: 'danger' } } }))
  await assert.rejects(runtime.get({ operation_id: 'unknown', wait_ms: 30001 }), { code: 'invalid_wait' })
  await assert.rejects(runtime.get({ operation_id: 'unknown' }), { code: 'unknown_operation' })
  assert.equal(f.calls.length, 0)
})

test('context is compact rather than a full receipt or world dump', async t => {
  const f = await fixture(t); const runtime = await f.open()
  await runtime.submit({ request_id: 'context', operation })
  const context = await runtime.context()
  assert.equal(context.pending.length, 1)
  assert.ok(!JSON.stringify(context).includes('evidence'))
  assert.ok(JSON.stringify(context).length < 2000)
})

test('CLI configuration requires private state, strong session and loopback-only RCON', () => {
  const env = { SGLUNA_RCON_PASSWORD: 'test-only', EXTERNAL_HARNESS_SESSION: session, EXTERNAL_HARNESS_STATE_DIR: '/tmp/test-journal' }
  assert.equal(configuration(env).host, '127.0.0.1')
  assert.throws(() => configuration({ ...env, SGLUNA_RCON_HOST: '0.0.0.0' }), { code: 'loopback_required' })
  assert.throws(() => configuration({ ...env, SGLUNA_RCON_PORT: '99999' }), { code: 'invalid_port' })
  assert.throws(() => configuration({ ...env, SGLUNA_RCON_PASSWORD: '' }), { code: 'rcon_password_required' })
  assert.throws(() => configuration({ ...env, EXTERNAL_HARNESS_STATE_DIR: '' }), { code: 'state_directory_required' })
})
