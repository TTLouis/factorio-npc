import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { nativeAdmissionJournal } from '../../deploy/pterodactyl/staging/native-admission-journal.mjs'

// Host/operator lifecycle only. This is deliberately not an MCP tool and normal
// stdio disconnect must not call it. Commands are fixed by the owning host.
// Each native descriptor is { command: string, execute: async ({ signal }) => rawReply }.
// snapshot returns JSON { guard, status, tick, speed }; guard has connected_players.
// stop returns JSON { before, cancelled, disabled, after }; authorize returns JSON
// { old: boolean, current: boolean }. Never pass model-authored commands here.
export async function closeoutTrial({ identity, evidenceDir, callbacks, resources = [], limits = {} }) {
  identity = Object.freeze({ ...identity })
  const limit = { commandMs: 5000, verifyMs: 120000, saveMs: 45000, savePollMs: 250, savePolls: 180, ...limits }
  if (!identity?.goalId || !identity.session || !Number.isSafeInteger(identity.actorId)
    || identity.actorId <= 0 || !Number.isSafeInteger(identity.epoch) || identity.epoch <= 0 || !identity.revision
    || !Number.isSafeInteger(limit.commandMs) || limit.commandMs <= 0 || limit.commandMs > 60000
    || !Number.isSafeInteger(limit.saveMs) || limit.saveMs <= 0 || limit.saveMs > 60000
    || !Number.isSafeInteger(limit.verifyMs) || limit.verifyMs <= 0 || limit.verifyMs > 120000
    || !Number.isSafeInteger(limit.savePolls) || limit.savePolls < 1 || limit.savePolls > 180
    || !Number.isSafeInteger(limit.savePollMs) || limit.savePollMs < 0 || limit.savePollMs > 1000
    || resources.some(resource => !resource.id || !resource.recoveryCommand)) throw new Error('invalid_closeout_configuration')
  const result = { identity, success: false, strictStop: false, preservationVerified: false,
    cleanupVerified: false, corrected: false, errors: [], resources, retainedResources: [...resources] }
  let healthy = true
  let sequence = 0
  let correctionUsed = false
  let previousTick = -1
  let controllerStopped = false
  let nativeUncertain = false
  let callbackUncertain = false
  let stoppedEpoch = identity.epoch + 2
  let snapshot, stop, authorization
  const error = (phase, code) => result.errors.push({ phase, code })
  try { await fs.mkdir(evidenceDir, { recursive: true }) }
  catch { healthy = false; error('evidence_directory', 'evidence_persistence_failed') }
  // Existing events carry the correction allowance across an interrupted host.
  let names = []
  try { names = (await fs.readdir(evidenceDir)).filter(name => /^\d{6}\.json$/.test(name)).sort() }
  catch { healthy = false; error('evidence_directory', 'evidence_persistence_failed') }
  for (const name of names) {
    let event
    try { event = JSON.parse(await fs.readFile(path.join(evidenceDir, name), 'utf8')) }
    catch { healthy = false; correctionUsed = true; error('evidence_restore', 'unreadable_durable_history'); continue }
    if (JSON.stringify(event.identity) !== JSON.stringify(identity)) {
      healthy = false; correctionUsed = true; error('evidence_restore', 'closeout_identity_mismatch')
    }
    if (event.phase === 'correction_reserved') correctionUsed = true
    sequence = Math.max(sequence, Number(name.slice(0, 6)))
  }
  async function persist(phase, value) {
    const event = { identity, phase, at: new Date().toISOString(), ...value }
    const filename = path.join(evidenceDir, `${String(++sequence).padStart(6, '0')}.json`)
    try {
      const temp = `${filename}.${process.pid}.tmp`
      if (await fs.stat(filename).catch(failure => { if (failure.code === 'ENOENT') return null; throw failure })) throw new Error('event_exists')
      const handle = await fs.open(temp, 'wx')
      try { await handle.writeFile(`${JSON.stringify(event, null, 2)}\n`); await handle.sync() }
      finally { await handle.close() }
      if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot
        if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('windows_system_root_required')
        await new Promise((resolve, reject) => childProcess.execFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./replace-journal-windows.ps1', import.meta.url)),
            '-Source', temp, '-Destination', filename],
          { windowsHide: true, timeout: 15000, maxBuffer: 4096,
            env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } },
          failure => failure ? reject(failure) : resolve()))
      } else {
        await fs.rename(temp, filename)
        const directory = await fs.open(evidenceDir, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      return true
    } catch { healthy = false; error(phase, 'evidence_persistence_failed'); return false }
  }
  // Persist the original reply, including malformed/empty replies, before any
  // interpretation. A timed-out mutation is never retried and fences disposal.
  async function call(phase, descriptor, { mutation = false, timeoutMs = limit.commandMs } = {}) {
    if (!descriptor || typeof descriptor.command !== 'string' || typeof descriptor.execute !== 'function') {
      error(phase, 'callback_missing'); return undefined
    }
    const recorded = await persist(`${phase}_command`, { command: descriptor.command })
    if (mutation && (!recorded || !healthy)) { error(phase, 'mutation_fenced_by_evidence_failure'); return undefined }
    const abort = new AbortController()
    let timer
    const invocation = Promise.resolve().then(() => descriptor.execute({ signal: abort.signal }))
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs) })
    const settled = await Promise.race([invocation.then(reply => ({ reply }), failure => ({ failure })), timeout])
    clearTimeout(timer)
    if (settled.timeout) {
      abort.abort()
      callbackUncertain = true
      if (mutation) nativeUncertain = true
      error(phase, 'command_timeout')
      await persist(`${phase}_reply`, { outcome: 'timeout', reply: null })
      // Abort is a request, not proof of settlement. Do not launch unjoined late
      // journal writes. The owning host must close transports/terminate workers;
      // any timed-out callback permanently fences disposal for this invocation.
      return undefined
    }
    if (settled.failure) {
      if (mutation) nativeUncertain = true
      error(phase, 'command_failed')
      await persist(`${phase}_reply`, { outcome: 'failed', code: settled.failure.code ?? 'callback_error' })
      return undefined
    }
    await persist(`${phase}_reply`, { outcome: 'returned', reply: settled.reply ?? null })
    return settled.reply
  }
  function json(raw, phase) {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw }
    catch { error(phase, 'invalid_json'); return undefined }
  }
  function owned(value, epoch, session) {
    const guard = value?.guard ?? value
    return guard?.revision === identity.revision && guard.actor_id === identity.actorId
      && guard.actor_kind === 'standalone_character' && guard.mode === 'npc'
      && guard.epoch === epoch && guard.session === session
      && (identity.surfaceIndex === undefined || guard.surface_index === identity.surfaceIndex)
      && (identity.forceIndex === undefined || guard.force_index === identity.forceIndex)
  }
  function idle(value) {
    const journal = nativeAdmissionJournal(value?.status?.admission_journal)
    const valid = owned(value, stoppedEpoch, '') && value?.status?.task_state === 'idle'
      && value.status.queue_length === 0 && value.status.queue_empty === true && !value.status.active_batch
      && value.guard.idle === true
      && journal.known && !journal.unresolved
      && value.guard.connected_players === 0 && value.speed === 1
      && Number.isSafeInteger(value.tick) && value.tick >= previousTick
    if (valid) previousTick = value.tick
    return valid
  }
  async function readSnapshot(phase) { return json(await call(phase, callbacks.snapshot), phase) }
  // Controllers must close admission and await/terminate outstanding model and
  // MCP requests before native stop. This reply is a host-goal pause boundary.
  const controller = await call('controller_stop', callbacks.stopController)
  controllerStopped = controller?.stopped === true && controller.goalId === identity.goalId
    && controller.session === identity.session
  if (!controllerStopped) error('controller_stop', 'controller_stop_unproven')
  const before = await readSnapshot('pre_stop_snapshot')
  const initialIdentity = owned(before, identity.epoch, identity.session)
  if (!initialIdentity || !Number.isSafeInteger(before?.tick)) error('pre_stop_snapshot', 'identity_or_freshness_mismatch')
  else previousTick = before.tick
  if (controllerStopped && initialIdentity) {
    stop = json(await call('native_stop', callbacks.stop, { mutation: true }), 'native_stop')
  }
  snapshot = await readSnapshot('post_stop_snapshot')
  let nativeIdle = controllerStopped && initialIdentity && idle(snapshot) && !nativeUncertain
  // Query authorization independently; allowed is advisory and cannot waive
  // identity/session/epoch/idle/queue checks or replace authoritative denial.
  if (nativeIdle) authorization = json(await call('authorization', callbacks.authorize), 'authorization')
  const denied = () => authorization?.old === false && authorization.current === false
  if (nativeIdle && denied() && snapshot.guard.allowed === true) {
    if (correctionUsed) error('guard_correction', 'correction_exhausted')
    else if (healthy && await persist('correction_reserved', { attemptsUsed: 1, limit: 1, reason: 'guard_advisory_contradiction' })) {
      correctionUsed = true
      const corrected = json(await call('guard_correction', callbacks.correctGuard, { mutation: true }), 'guard_correction')
      stoppedEpoch++
      snapshot = await readSnapshot('corrected_snapshot')
      nativeIdle = !nativeUncertain && idle(snapshot)
      authorization = nativeIdle ? json(await call('corrected_authorization', callbacks.authorize), 'corrected_authorization') : undefined
      result.corrected = corrected === true && nativeIdle && denied() && snapshot.guard.allowed === false
      if (!result.corrected) error('guard_correction', 'correction_unproven')
    }
  }
  result.strictStop = Boolean(nativeIdle && denied() && snapshot.guard.allowed === false
    && stop?.cancelled === true && stop.disabled === true && owned(stop.before, identity.epoch, identity.session)
    && owned(stop.after, identity.epoch + 2, '') && (stop.after.allowed === false || result.corrected))
  if (!result.strictStop) error('strict_stop', 'strict_stop_unproven')
  result.pauseReceipt = { goalId: identity.goalId, session: identity.session,
    disposition: controllerStopped && nativeIdle ? 'operator_paused' : 'pause_unproven',
    controllerStopped, strictStop: result.strictStop, nativeIdle, stoppedEpoch,
    stoppedSnapshot: snapshot ?? null, authorization: authorization ?? null }
  await persist('operator_pause_receipt', { receipt: result.pauseReceipt })
  // Failure-state saves preserve the world without claiming a successful stop.
  // Unknown/busy/changed actors or outstanding native mutations retain resources.
  if (nativeIdle) {
    const fresh = await readSnapshot('save_boundary_snapshot')
    if (!idle(fresh)) { nativeIdle = false; error('save', 'save_boundary_unproven') }
    if (fresh?.guard?.allowed !== false) result.strictStop = false
  }
  if (nativeIdle) {
    result.saveLabel = result.strictStop ? 'post-stop' : 'failure-state'
    const saveDeadline = Date.now() + limit.saveMs
    const requested = await call('save_request', callbacks.save, { mutation: true })
    let ready = false
    if (requested !== undefined && !nativeUncertain) {
      for (let attempt = 1; attempt <= limit.savePolls; attempt++) {
        const remaining = saveDeadline - Date.now()
        if (remaining <= 0) break
        const state = await call('save_ready', callbacks.saveReady, { timeoutMs: Math.min(limit.commandMs, remaining) })
        if (state?.ready === true) { ready = true; break }
        if (attempt < limit.savePolls) await delay(Math.min(limit.savePollMs, Math.max(0, saveDeadline - Date.now())))
      }
    }
    if (!ready) error('save', 'save_readiness_exhausted')
    else {
      const preserved = await call('save_preserve', callbacks.preserveSave)
      const durable = preserved?.durable === true && typeof preserved.path === 'string'
        && /^[a-f0-9]{64}$/i.test(preserved.sha256 ?? '') && Number.isSafeInteger(preserved.bytes) && preserved.bytes > 0
      if (!durable) error('save', 'save_preservation_unproven')
      const verified = durable ? await call('save_verify', callbacks.verifySave, { timeoutMs: limit.verifyMs }) : undefined
      result.save = { label: result.saveLabel, preserved: preserved ?? null, verification: verified ?? null }
      result.preservationVerified = durable && verified?.zipIntegrity === true && verified.exactVersionLoad === true
      if (!result.preservationVerified) error('save', 'save_integrity_or_load_unproven')
    }
  } else error('save', 'native_idle_unproven_resources_retained')
  // Recheck ownership after all awaited save/preservation/verification callbacks.
  // An identity change cannot inherit disposal permission from an older snapshot.
  if (result.preservationVerified) {
    const finalSnapshot = await readSnapshot('disposal_boundary_snapshot')
    if (!idle(finalSnapshot)) {
      result.strictStop = false; result.preservationVerified = false
      error('cleanup', 'disposal_identity_or_idle_unproven')
    } else if (finalSnapshot.guard.allowed !== false) result.strictStop = false
  }
  if (!result.strictStop && result.save) result.save.label = result.saveLabel = 'failure-state'
  await persist('preservation_disposition', { strictStop: result.strictStop,
    preservationVerified: result.preservationVerified, nativeUncertain, callbackUncertain, healthy })
  // Cleanup is per owned resource; one failure cannot skip other safe teardown.
  if (result.preservationVerified && healthy && !nativeUncertain && !callbackUncertain) {
    result.retainedResources = []
    for (const resource of resources) {
      const reply = await call('cleanup', { command: resource.recoveryCommand,
        execute: context => callbacks.cleanup(resource, context) })
      if (reply?.absent !== true) { result.retainedResources.push(resource); error('cleanup', 'resource_absence_unproven') }
    }
    result.cleanupVerified = result.retainedResources.length === 0
  }
  result.success = result.strictStop && result.preservationVerified && result.cleanupVerified && healthy
  result.callbackQuiescenceUnproven = callbackUncertain
  await persist('closeout_result', { result })
  // A final evidence error is also a failed closeout, even after safe teardown.
  result.success &&= healthy
  result.evidenceDurable = healthy
  return result
}
