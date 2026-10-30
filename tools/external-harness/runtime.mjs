import { createHash, randomUUID } from 'node:crypto'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { operationSignature } from '../../deploy/pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { parseOperation } from '../../deploy/pterodactyl/runtime-v8/structured-policy.mjs'

const MAX_RECORDS = 512
const MAX_LEDGER_BYTES = 32 * 1024 * 1024
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/
const windowsReplace = fileURLToPath(new URL('./replace-journal-windows.ps1', import.meta.url))

export function failure(code, publicMessage = code) {
  return Object.assign(new Error(publicMessage), { code, publicMessage })
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw failure('invalid_arguments', 'Unexpected arguments')
  }
}

function operationId(session, request) {
  return `external/${createHash('sha256').update(`${session}\0${request}`).digest('hex')}`
}

function receipt(record) {
  return {
    operation_id: record.operation_id,
    request_id: record.request_id,
    operation: record.operation,
    state: record.state,
    reason: record.reason,
    effect: record.effect,
    terminal: record.terminal,
    receipt_scope: 'historical_execution',
    current_world_verified: false,
    goal_verified: false,
    ...(record.result ? { execution: record.result } : {}),
  }
}

// The local journal is a write-ahead duplicate fence, not a second world state.
// Native receipts remain authoritative. Never evict an idempotency key silently.
export async function openRuntime({ bridge, directory, session, pollMs = 500 }) {
  if (!bridge || !directory || !ID.test(session ?? '')) throw failure('invalid_configuration')
  const root = path.resolve(directory)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const lockPath = path.join(root, 'owner.lock')
  const ledgerPath = path.join(root, 'ledger.json')
  const owner = randomUUID()
  let lock
  try { lock = await fs.open(lockPath, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Do not steal a stale lock automatically: PID reuse and another host can
    // make a seemingly dead owner ambiguous. The CLI documents safe recovery.
    throw failure('state_locked', 'State directory is locked; verify the old process has stopped before removing owner.lock')
  }
  await lock.writeFile(JSON.stringify({ owner, pid: process.pid }))
  await lock.sync()
  let closed = false
  let poisoned = false
  let chain = Promise.resolve()
  let ledger = { version: 1, session, native_high_water: 0, native_tick: 0, records: [] }

  async function release() {
    await lock.close()
    const held = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    if (held.owner === owner) await fs.unlink(lockPath)
  }

  try {
    const stat = await fs.stat(ledgerPath).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat) {
      if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw failure('invalid_ledger')
      ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
      if (ledger.version !== 1 || ledger.session !== session || !Array.isArray(ledger.records)
        || ledger.records.length > MAX_RECORDS || !Number.isSafeInteger(ledger.native_high_water) || ledger.native_high_water < 0
        || !Number.isSafeInteger(ledger.native_tick) || ledger.native_tick < 0) throw failure('invalid_ledger')
      const ids = new Set()
      for (const row of ledger.records) {
        if (!ID.test(row.request_id ?? '') || row.operation_id !== operationId(session, row.request_id)
          || ids.has(row.operation_id) || row.signature !== operationSignature([parseOperation(row.operation)])
          || row.prepared?.pending?.operation_key !== row.operation_id || row.prepared.pending.signature !== row.signature
          || typeof row.terminal !== 'boolean') throw failure('invalid_ledger')
        ids.add(row.operation_id)
      }
    }
  }
  catch (error) { await release(); throw error }

  async function save() {
    const temp = `${ledgerPath}.${owner}.tmp`
    const data = `${JSON.stringify(ledger)}\n`
    if (Buffer.byteLength(data) > MAX_LEDGER_BYTES) throw failure('ledger_full')
    try {
      const file = await fs.open(temp, 'w', 0o600)
      try { await file.writeFile(data); await file.sync() }
      finally { await file.close() }
      if (process.platform === 'win32') {
        // Node cannot fsync Windows directories. Request a native write-through
        // replacement instead; never reinterpret EPERM as successful persistence.
        const systemRoot = process.env.SystemRoot
        if (!systemRoot || !path.isAbsolute(systemRoot)) throw failure('windows_system_root_required')
        await new Promise((resolve, reject) => childProcess.execFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsReplace, '-Source', temp, '-Destination', ledgerPath],
          { windowsHide: true, timeout: 15000, maxBuffer: 4096,
            env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } },
          error => error ? reject(error) : resolve()))
      }
      else {
        await fs.rename(temp, ledgerPath)
        const directoryHandle = await fs.open(root, 'r')
        try { await directoryHandle.sync() }
        finally { await directoryHandle.close() }
      }
    }
    catch {
      poisoned = true
      throw failure('journal_write_failed', 'Durable journal write failed; no further mutations are allowed in this process')
    }
  }

  function serialized(fn) {
    const run = chain.then(() => {
      if (closed) throw failure('runtime_closed')
      if (poisoned) throw failure('journal_write_failed')
      return fn()
    })
    chain = run.catch(() => {})
    return run
  }

  function find(id) {
    const found = ledger.records.find(row => row.operation_id === id)
    if (!found) throw failure('unknown_operation', 'Operation ID does not belong to this journal')
    return found
  }

  async function refresh(row) {
    if (row.terminal) {
      // A sealed execution receipt is historical evidence, not a claim that a
      // restored/current world still contains its effects. Verify world age
      // even when returning cached idempotent results.
      await snapshot()
      if (row.result?.evidence?.admission_refused_before_mutation === true) return receipt(row)
      const current = await bridge.receipt(row.prepared.pending)
      const historical = receipt(row)
      if (current.reason === 'exact_admission_missing') {
        return { ...historical, current_reconciliation: current,
          guidance: 'Historical receipt retained; native journal no longer contains this operation. Current effects are not reverified.' }
      }
      if (current.state !== row.state) {
        // Keep immutable history, but never substitute it for resume's current
        // native result. A contradiction is a durable scheduling fence.
        row.current_fence = current.reason ?? 'historical_receipt_not_revalidated'
        await save()
        return { ...historical, state: current.state, reason: row.current_fence,
          effect: current.effect, terminal: false, receipt_scope: 'current_reconciliation',
          historical_execution: row.result, execution: current }
      }
      if (row.current_fence) { delete row.current_fence; await save() }
      return { ...historical, receipt_scope: 'native_reconciled_execution', execution: current }
    }
    try {
      const result = await bridge.receipt(row.prepared.pending)
      if (!result || typeof result.state !== 'string' || typeof result.terminal !== 'boolean') throw failure('invalid_native_receipt')
      row.result = result
      row.state = result.state
      row.reason = result.reason
      row.effect = result.effect
      row.terminal = result.terminal
      if (!Number.isSafeInteger(result.high_water) || result.high_water < ledger.native_high_water
        || !Number.isSafeInteger(result.evidence?.tick) || result.evidence.tick < ledger.native_tick) throw failure('world_rollback_detected')
      ledger.native_high_water = result.high_water
      ledger.native_tick = result.evidence.tick
    }
    catch {
      row.state = 'uncertain'
      row.reason = 'receipt_unavailable'
      row.effect = 'unknown'
      row.terminal = false
    }
    row.updated_at = new Date().toISOString()
    await save()
    return receipt(row)
  }

  async function snapshot() {
    const snap = await bridge.snapshot()
    if (snap?.guard?.session !== session) throw failure('world_session_mismatch')
    const high = snap?.journal?.high_water
    if (!Number.isSafeInteger(high) || high < ledger.native_high_water
      || !Number.isSafeInteger(snap.tick) || snap.tick < ledger.native_tick) throw failure('world_rollback_detected', 'Native history or tick is older than this journal; restore the matching save and journal')
    if (high > ledger.native_high_water || snap.tick > ledger.native_tick) { ledger.native_high_water = high; ledger.native_tick = snap.tick; await save() }
    return snap
  }

  const runtime = {
    capabilities: () => bridge.capabilities(),
    context: () => serialized(async () => {
      for (const row of ledger.records.filter(row => !row.terminal)) await refresh(row)
      if (ledger.records.at(-1)?.terminal) await refresh(ledger.records.at(-1))
      const snap = await snapshot()
      return {
        mode: 'external-harness', session,
        actor: { actor_id: snap.guard.actor_id, epoch: snap.guard.epoch, allowed: snap.guard.allowed,
          surface_index: snap.guard.surface_index, force_index: snap.guard.force_index },
        native: { task_state: snap.status.task_state, queue_length: snap.status.queue_length },
        pending: ledger.records.filter(row => !row.terminal || row.current_fence).map(row => ({ operation_id: row.operation_id, state: row.current_fence ? 'uncertain' : row.state, reason: row.current_fence ?? row.reason })),
        reconciliation_required: ledger.records.filter(row => row.result?.requires_reconciliation).map(row => ({ operation_id: row.operation_id, state: row.state, reason: row.reason })),
        recent: ledger.records.slice(-5).map(row => ({ operation_id: row.operation_id, name: row.operation.name, state: row.state })),
        journal_capacity_remaining: MAX_RECORDS - ledger.records.length,
        guidance: 'Plan externally. Fetch bounded observations on demand. Native execution completion is not overall goal verification.',
      }
    }),
    observe: input => serialized(async () => {
      object(input, ['name', 'args'])
      await snapshot()
      return bridge.observe(input.name, input.args ?? {})
    }),
    submit: input => serialized(async () => {
      object(input, ['request_id', 'operation'])
      if (typeof input.request_id !== 'string' || !ID.test(input.request_id)) throw failure('invalid_request_id')
      const operation = parseOperation(input.operation)
      const signature = operationSignature([operation])
      const id = operationId(session, input.request_id)
      const previous = ledger.records.find(row => row.operation_id === id)
      if (previous) {
        if (signature !== previous.signature) throw failure('request_id_conflict', 'Request ID was already used with different operation arguments')
        return refresh(previous)
      }
      for (const row of ledger.records.filter(row => !row.terminal)) await refresh(row)
      if (ledger.records.at(-1)?.terminal) await refresh(ledger.records.at(-1))
      if (ledger.records.some(row => !row.terminal || row.current_fence)) throw failure('operation_unsettled', 'Reconcile the outstanding operation before scheduling more work')
      if (ledger.records.length >= MAX_RECORDS) throw failure('ledger_full', 'Journal capacity reached; archive this world/session rather than deleting replay protection')
      await snapshot()
      const prepared = await bridge.prepare(operation, id)
      if (prepared?.pending?.operation_key !== id || prepared.pending.signature !== signature) throw failure('invalid_preparation')
      const row = { operation_id: id, request_id: input.request_id, signature, operation, prepared,
        state: 'uncertain', reason: 'write_ahead_before_send', effect: 'unknown', terminal: false,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      ledger.records.push(row)
      await save() // No mutation can happen before this durable fence.
      try { await bridge.submit(prepared) }
      catch (error) {
        if (error.notAdmitted === true) {
          row.state = 'rejected'; row.reason = 'native_refused_before_admission'; row.effect = 'not_happened'; row.terminal = true
          row.result = { state: row.state, reason: row.reason, effect: row.effect, terminal: true, goal_verified: false,
            evidence: { admission_refused_before_mutation: true } }
        }
        else row.reason = 'submission_acknowledgement_unavailable'
        await save()
      }
      return refresh(row) // Admission is never reported as completion.
    }),
    get: async input => {
      object(input, ['operation_id', 'wait_ms'])
      const wait = input.wait_ms ?? 0
      if (!Number.isInteger(wait) || wait < 0 || wait > 30_000) throw failure('invalid_wait')
      const deadline = Date.now() + wait
      let result
      while (true) {
        result = await serialized(() => refresh(find(input.operation_id)))
        if (result.terminal || result.state !== 'running' || Date.now() >= deadline) return result
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
        if (closed) return result
      }
    },
    resume: input => {
      object(input, ['operation_id'])
      return serialized(() => refresh(find(input.operation_id)))
    },
    cancel: input => serialized(async () => {
      object(input, ['operation_id'])
      const row = find(input.operation_id)
      const current = await refresh(row)
      if (row.terminal) return current
      await snapshot()
      row.reason = 'cancel_requested'
      await save()
      try { await bridge.cancel(row.prepared.pending) }
      catch { row.reason = 'cancellation_unconfirmed'; await save() }
      return refresh(row)
    }),
    close: async () => {
      await chain
      if (closed) return
      closed = true
      await release()
    },
  }
  return runtime
}
