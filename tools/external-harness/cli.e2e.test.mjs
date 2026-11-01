import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Integration boundary: only Factorio itself is fake. These tests launch the
// actual CLI and use its stdio MCP, durable filesystem journal, NativeBridge,
// production Rcon TCP implementation, canonical admission wrapper and receipt
// reconciliation. Scripted engine answers do NOT prove native gameplay.
const SESSION = 'external-cli-fixture-00000000000000001'
const PASSWORD = 'public-test-fixture-not-a-secret'
const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const WAIT = { name: 'wait', args: { ticks: 120 } }

function packet(id, type, text) {
  const payload = Buffer.from(String(text))
  const result = Buffer.alloc(payload.length + 14)
  result.writeInt32LE(payload.length + 10, 0)
  result.writeInt32LE(id, 4)
  result.writeInt32LE(type, 8)
  payload.copy(result, 12)
  return result
}

async function fakeEngine() {
  const commands = []
  const failures = []
  const connections = new Set()
  let disconnectAfterAdmission = false
  let holdAdmission
  let disconnectAfterBind = false
  let readinessAttempts = 0
  const state = {
    guard: { revision: 'sgluna-deploy-v8-npc-staging', session: SESSION, mode: 'npc', actor_kind: 'standalone_character', actor_id: 1, epoch: 1, allowed: true, surface_index: 1, force_index: 1 },
    status: { task_state: 'idle', queue_length: 0, queue_empty: true, batch_generation: 1, tasks_added: 0, admission_journal: [], receipt_journal: [], actor: { position: { x: 0, y: 0 } } },
    journal: { records: [], high_water: 0 }, tick: 100, speed: 1,
  }
  function settle(kind) {
    const admission = state.status.admission_journal.at(-1)
    assert.ok(admission, 'fixture must have an admitted operation before settlement')
    admission.state = kind === 'completed' ? 'completed' : 'uncertain'
    state.tick += 10
    const ref = admission.slots[0].batch_refs[0]
    state.status.receipt_journal.push({ ...ref, state: kind, task_count: 1, task_types: ['waiting'], tick: state.tick,
      ...(kind === 'cancelled' ? { reason: 'cancelled', tasks_started: 1, started_count: 1 } : {}) })
    state.status.task_state = 'idle'; state.status.queue_length = 0; state.status.queue_empty = true
    delete state.status.active_batch
  }
  function respond(command) {
    commands.push(command)
    if (command === '/silent-command rcon.print("SGLUNA_UI_RCON_READY")') {
      readinessAttempts++
      return readinessAttempts === 1 ? 'Please repeat the command to proceed.' : 'SGLUNA_UI_RCON_READY'
    }
    if (command.includes('local g=') && command.includes('"sgluna_deployment","configure"')) {
      assert.equal(readinessAttempts, 2, 'only the fixed readiness read may repeat before configuration')
      assert.ok(command.includes('g.session~=""'))
      assert.ok(command.includes('s.task_state~="idle"'))
      assert.ok(command.includes('unresolved_native_operation'))
      assert.ok(command.includes(`"configure","npc",'${SESSION}'`))
      if (state.guard.session !== '') return '{"ok":false,"code":"session_already_bound"}'
      state.guard.session = SESSION; state.guard.allowed = true
      return '{"ok":true}'
    }
    if (command.includes('{guard=remote.call')) return JSON.stringify(state)
    if (command.includes('local refusal=')) {
      // Decode the identity emitted by the REAL v2 admission renderer. This
      // fixture refuses to invent a matching key/signature independently.
      const match = /helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(command)
      assert.ok(match, 'v2 wrapper must carry serialized admission correlation')
      const identity = JSON.parse(JSON.parse(match[1]))
      assert.equal(identity.actor_id, 1); assert.equal(identity.epoch, 1)
      assert.equal(identity.operation_count, 1)
      assert.ok(identity.ordinal > state.journal.high_water)
      assert.match(command, /remote\.call\('autorio_operations','wait',120\)/)
      assert.ok(command.includes(`g.session~='${SESSION}'`))
      const ref = { batch_id: identity.ordinal, batch_generation: 1, batch_ref: `batch-g1-${identity.ordinal}` }
      const admission = { ...identity, state: 'admitted', generation: 1, tick: state.tick, ok: true,
        slots: [{ index: 1, ok: true, operation: 'wait', queued_tasks: 1, batch_refs: [ref] }] }
      state.status.admission_journal.push(admission)
      state.journal.records = state.status.admission_journal
      state.journal.high_water = identity.ordinal
      state.status.active_batch = { ...ref, task_count: 1, task_types: ['waiting'] }
      state.status.task_state = 'waiting'; state.status.queue_empty = false; state.status.tasks_added++
      const marker = command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'queued']], admission })}`
    }
    if (command.includes('local g=') && command.includes('cancel_all_tasks')) {
      assert.ok(command.includes('r.signature=='))
      assert.ok(command.includes('r.slots[1].queued_tasks==s.active_batch.task_count'))
      settle('cancelled')
      return '{"ok":true,"code":"cancel_requested"}'
    }
    if (command.includes('autorio_preflight') || command.includes('validation="not_required"')) return '{"ok":true}'
    throw new Error('Unexpected RCON fixture command')
  }
  const server = net.createServer(socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', error => { if (error.code !== 'ECONNRESET') failures.push(error) })
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0)
        if (size < 10 || size > 1024 * 1024) { socket.destroy(); return }
        if (buffer.length < size + 4) return
        const frame = buffer.subarray(4, size + 4)
        buffer = buffer.subarray(size + 4)
        const id = frame.readInt32LE(0); const type = frame.readInt32LE(4)
        const body = frame.subarray(8, -2).toString()
        if (type === 3) { socket.write(packet(body === PASSWORD ? id : -1, 2, '')); continue }
        try {
          const response = respond(body)
          if (holdAdmission && body.includes('local refusal=')) {
            const admitted = holdAdmission; holdAdmission = undefined
            admitted() // No acknowledgement: the parent will kill the real CLI.
            return
          }
          if (disconnectAfterAdmission && body.includes('local refusal=')) {
            disconnectAfterAdmission = false
            socket.destroy() // Native work happened; acknowledgement was lost.
            return
          }
          if (disconnectAfterBind && body.includes('"sgluna_deployment","configure"')) {
            disconnectAfterBind = false
            socket.destroy() // Binding happened, but no acknowledgement arrived.
            return
          }
          socket.write(packet(id, 0, response))
        }
        catch (error) { failures.push(error); socket.write(packet(id, 0, '{"fixture_error":true}')) }
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    commands, failures, state, settle, port: server.address().port,
    disconnectNextAdmission: () => { disconnectAfterAdmission = true },
    holdNextAdmission: () => new Promise(resolve => { holdAdmission = resolve }),
    disconnectNextBind: () => { disconnectAfterBind = true },
    readinessAttempts: () => readinessAttempts,
    bindings: () => commands.filter(command => command.includes('"sgluna_deployment","configure"')).length,
    mutations: () => commands.filter(command => command.includes('local refusal=')).length,
    cancellations: () => commands.filter(command => command.includes('cancel_all_tasks')).length,
    close: async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

function client({ directory, port, session = SESSION, flags = [] }) {
  // Intentionally do not inherit process.env or load .env. The only password
  // used here is the public, loopback-only fixture value above.
  const child = spawn(process.execPath, [CLI, ...flags], { env: {
    SGLUNA_RCON_HOST: '127.0.0.1', SGLUNA_RCON_PORT: String(port), SGLUNA_RCON_PASSWORD: PASSWORD,
    EXTERNAL_HARNESS_SESSION: session, EXTERNAL_HARNESS_STATE_DIR: directory,
  }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''; let buffer = ''; let nextId = 0
  let exited = false
  const pending = new Map()
  const messages = []
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`CLI exited ${code}/${signal}: ${stderr}`)) }
    pending.clear(); resolve({ code, signal })
  }))
  child.stdout.on('data', chunk => {
    stdout += chunk.toString(); buffer += chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      messages.push(message)
      const waiter = pending.get(message.id)
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message) }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.stdin.on('error', () => {}) // Expected when a refused startup closes early.
  function send(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`) }
  function request(method, params) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for MCP ${method}; stderr: ${stderr}`)) }, 10000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    })
  }
  return {
    child, messages, exit, stdout: () => stdout, stderr: () => stderr,
    request, send,
    initialize: async () => {
      const reply = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-e2e-fixture', version: '1' } })
      assert.equal(reply.result.protocolVersion, '2025-06-18')
      send('notifications/initialized')
    },
    call: async (name, arguments_ = {}) => {
      const reply = await request('tools/call', { name, arguments: arguments_ })
      assert.equal(reply.error, undefined, JSON.stringify(reply))
      assert.equal(reply.result.isError, false, JSON.stringify(reply))
      return reply.result.structuredContent
    },
    disconnect: async () => { child.stdin.end(); const result = await exit; assert.deepEqual(result, { code: 0, signal: null }); assert.equal(stderr, '') },
    cleanup: async () => {
      if (!exited) { child.kill('SIGKILL'); await exit }
    },
  }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factorio-external-cli-test-'))
  const engine = await fakeEngine()
  const children = []
  t.after(async () => {
    await Promise.all(children.map(child => child.cleanup()))
    await engine.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, engine, start: (options = {}) => {
    const instance = client({ directory, port: engine.port, ...options }); children.push(instance); return instance
  } }
}

test('CLI end to end: admission is running, exact completion, durable duplicate protection, restart and resume (fake engine)', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let c = f.start(); await c.initialize()
  const context = await c.call('factorio_context')
  assert.equal(context.mode, 'external-harness')
  assert.equal(context.actor.actor_id, 1)
  const capabilities = await c.call('factorio_capabilities')
  assert.ok(capabilities.operations.some(operation => operation.name === 'wait'))
  const submitted = await c.call('factorio_submit', { request_id: 'wait-one', operation: WAIT })
  assert.equal(submitted.state, 'running')
  assert.equal(submitted.terminal, false)
  assert.equal(submitted.goal_verified, false)
  assert.equal(f.engine.mutations(), 1)
  const duplicate = await c.call('factorio_submit', { request_id: 'wait-one', operation: WAIT })
  assert.equal(duplicate.operation_id, submitted.operation_id)
  assert.equal(duplicate.state, 'running')
  assert.equal(f.engine.mutations(), 1)
  // A real child exit with outstanding native work leaves the operation intact.
  await c.disconnect()
  assert.equal(f.engine.cancellations(), 0)
  await assert.rejects(fs.stat(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' })
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'))
  assert.equal(persisted.records[0].operation_id, submitted.operation_id)
  assert.equal(persisted.records[0].state, 'running')
  assert.equal(persisted.records.length, 1)
  c = f.start(); await c.initialize()
  const resumed = await c.call('factorio_resume', { operation_id: submitted.operation_id })
  assert.equal(resumed.state, 'running')
  assert.equal(f.engine.mutations(), 1)
  f.engine.settle('completed')
  const completed = await c.call('factorio_receipt', { operation_id: submitted.operation_id, wait_ms: 1000 })
  assert.equal(completed.state, 'completed')
  assert.equal(completed.execution.execution_completed, true)
  assert.equal(completed.goal_verified, false)
  assert.equal(completed.current_world_verified, false)
  assert.equal(completed.execution.evidence.receipts[0].state, 'completed')
  const repeated = await c.call('factorio_submit', { request_id: 'wait-one', operation: WAIT })
  assert.equal(repeated.state, 'completed')
  assert.equal(f.engine.mutations(), 1)
  await c.disconnect()
  assert.deepEqual(f.engine.failures, [])
})

test('CLI end to end: exact cancellation can interrupt a concurrent receipt wait and never claims goal success (fake engine)', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const c = f.start(); await c.initialize()
  const operation = await c.call('factorio_submit', { request_id: 'wait-cancel', operation: WAIT })
  const waiting = c.call('factorio_receipt', { operation_id: operation.operation_id, wait_ms: 30000 })
  const cancelled = await c.call('factorio_cancel', { operation_id: operation.operation_id })
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.goal_verified, false)
  assert.equal(cancelled.execution.requires_reconciliation, true)
  const observed = await waiting
  assert.equal(observed.state, 'cancelled')
  assert.equal(observed.effect, 'partial_unknown')
  assert.equal(f.engine.mutations(), 1)
  assert.equal(f.engine.cancellations(), 1)
  const resumed = await c.call('factorio_resume', { operation_id: operation.operation_id })
  assert.equal(resumed.state, 'cancelled')
  assert.equal(f.engine.mutations(), 1)
  await c.disconnect()
  assert.deepEqual(f.engine.failures, [])
})

test('CLI refuses a wrong native session before exposing MCP and cleans its journal lock (fake engine)', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.engine.state.guard.session = 'another-controller-00000000000000001'
  const c = f.start()
  assert.deepEqual(await c.exit, { code: 1, signal: null })
  assert.equal(c.stdout(), '')
  assert.match(c.stderr(), /session_not_owned/)
  assert.equal(f.engine.mutations(), 0)
  assert.equal(f.engine.cancellations(), 0)
  await assert.rejects(fs.stat(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' })
  assert.deepEqual(f.engine.failures, [])
})

test('CLI survives a TCP loss after native admission: durable uncertainty reconciles on restart without replay (fake engine)', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let c = f.start(); await c.initialize()
  f.engine.disconnectNextAdmission()
  const uncertain = await c.call('factorio_submit', { request_id: 'lost-ack', operation: WAIT })
  assert.equal(uncertain.state, 'uncertain')
  assert.equal(uncertain.terminal, false)
  assert.equal(uncertain.effect, 'unknown')
  assert.equal(f.engine.mutations(), 1)
  await c.disconnect()
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'))
  assert.equal(persisted.records[0].state, 'uncertain')
  assert.equal(persisted.records[0].operation_id, uncertain.operation_id)
  f.engine.settle('completed')
  c = f.start(); await c.initialize()
  const resumed = await c.call('factorio_resume', { operation_id: uncertain.operation_id })
  assert.equal(resumed.state, 'completed')
  assert.equal(resumed.goal_verified, false)
  const repeated = await c.call('factorio_submit', { request_id: 'lost-ack', operation: WAIT })
  assert.equal(repeated.operation_id, uncertain.operation_id)
  assert.equal(repeated.state, 'completed')
  assert.equal(f.engine.mutations(), 1)
  assert.equal(f.engine.cancellations(), 0)
  await c.disconnect()
  assert.deepEqual(f.engine.failures, [])
})

test('CLI abrupt death after admission leaves its write-ahead fence and exclusive stale lock; restart cannot replay (fake engine)', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let c = f.start(); await c.initialize()
  const admitted = f.engine.holdNextAdmission()
  const request = c.call('factorio_submit', { request_id: 'process-killed', operation: WAIT }).catch(error => error)
  await admitted
  await c.cleanup() // SIGKILL/TerminateProcess, without runtime.close().
  assert.ok(await request instanceof Error)
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'))
  assert.equal(persisted.records[0].reason, 'write_ahead_before_send')
  assert.equal(persisted.records[0].state, 'uncertain')
  const locked = f.start()
  assert.deepEqual(await locked.exit, { code: 1, signal: null })
  assert.match(locked.stderr(), /state_locked/)
  assert.equal(locked.stdout(), '')
  assert.equal(f.engine.mutations(), 1)
  // Test operator recovery: original process has exited and competing startup
  // also exited. Remove only the stale lock, never the persisted operation.
  await fs.unlink(path.join(f.directory, 'owner.lock'))
  f.engine.settle('completed')
  c = f.start(); await c.initialize()
  const repeated = await c.call('factorio_submit', { request_id: 'process-killed', operation: WAIT })
  assert.equal(repeated.operation_id, persisted.records[0].operation_id)
  assert.equal(repeated.state, 'completed')
  assert.equal(f.engine.mutations(), 1)
  assert.equal(f.engine.cancellations(), 0)
  await c.disconnect()
  assert.deepEqual(f.engine.failures, [])
})

test('CLI explicit --bind repeats only the fixed console readiness read, configures a fresh save once, and leaves normal mode read-only at startup (fake engine)', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.engine.state.guard.session = ''; f.engine.state.guard.allowed = false
  const binding = f.start({ flags: ['--bind'] })
  assert.deepEqual(await binding.exit, { code: 0, signal: null })
  assert.equal(binding.stdout(), '')
  assert.match(binding.stderr(), /Fresh save bound to external session/)
  assert.equal(f.engine.readinessAttempts(), 2)
  assert.equal(f.engine.bindings(), 1)
  assert.equal(f.engine.mutations(), 0)
  assert.equal(f.engine.state.guard.session, SESSION)
  assert.deepEqual(f.engine.commands.slice(0, 2), [
    '/silent-command rcon.print("SGLUNA_UI_RCON_READY")',
    '/silent-command rcon.print("SGLUNA_UI_RCON_READY")',
  ])
  await assert.rejects(fs.stat(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' })
  const normal = f.start(); await normal.initialize()
  assert.equal((await normal.call('factorio_context')).session, SESSION)
  assert.equal(f.engine.readinessAttempts(), 2, 'normal MCP startup must not initiate console consent')
  assert.equal(f.engine.bindings(), 1, 'normal MCP startup must not configure the save')
  await normal.disconnect()
  assert.deepEqual(f.engine.failures, [])
})

test('CLI --bind never retries its mutation after a lost binding acknowledgement (fake engine)', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.engine.state.guard.session = ''; f.engine.state.guard.allowed = false
  f.engine.disconnectNextBind()
  const binding = f.start({ flags: ['--bind'] })
  assert.deepEqual(await binding.exit, { code: 1, signal: null })
  assert.equal(binding.stdout(), '')
  assert.match(binding.stderr(), /No automatic gameplay replay was attempted/)
  assert.doesNotMatch(binding.stderr(), /Fresh save bound/)
  assert.equal(f.engine.readinessAttempts(), 2)
  assert.equal(f.engine.bindings(), 1)
  assert.equal(f.engine.state.guard.session, SESSION, 'fixture binding happened before transport loss')
  await assert.rejects(fs.stat(path.join(f.directory, 'owner.lock')), { code: 'ENOENT' })
  const normal = f.start(); await normal.initialize()
  assert.equal((await normal.call('factorio_context')).session, SESSION)
  assert.equal(f.engine.bindings(), 1)
  assert.equal(f.engine.readinessAttempts(), 2)
  await normal.disconnect()
  assert.deepEqual(f.engine.failures, [])
})
