import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { closeoutTrial } from './closeout.mjs'

const identity = { goalId: 'closeout-goal', session: 'external-test-session', actorId: 1, epoch: 7, surfaceIndex: 1, forceIndex: 1,
  revision: 'sgluna-deploy-v8-npc-staging' }
const resource = { id: 'owned-world', recoveryCommand: 'recover exact owned-world after preserving its save' }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-closeout-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const evidenceDir = path.join(root, 'closeout')
  const state = { epoch: 7, session: identity.session, allowed: true, idle: true, queue: 0,
    actorId: 1, tick: 100, saved: false, correction: false, snapshotCalls: 0, cleaned: [] }
  const guard = () => ({ revision: identity.revision, actor_id: state.actorId, epoch: state.epoch,
    session: state.session, allowed: state.allowed, idle: state.idle, mode: 'npc',
    actor_kind: 'standalone_character', connected_players: 0, surface_index: 1, force_index: 1 })
  const descriptor = (command, execute) => ({ command, execute })
  const callbacks = {
    stopController: descriptor('close admission; terminate and await model/MCP requests', async () => ({
      stopped: true, goalId: identity.goalId, session: identity.session })),
    snapshot: descriptor('fixed native snapshot', async () => {
      state.snapshotCalls++
      return JSON.stringify({ guard: guard(), tick: state.tick++, speed: 1,
        status: { task_state: state.idle ? 'idle' : 'working', queue_length: state.queue,
          queue_empty: state.queue === 0, active_batch: false, admission_journal: [] } })
    }),
    stop: descriptor('fixed native cancel then disable', async () => {
      const before = guard(); state.epoch += 2; state.session = ''; state.allowed = false
      return JSON.stringify({ before, cancelled: true, disabled: true, after: guard() })
    }),
    authorize: descriptor('fixed old/current epoch authorization', async () => JSON.stringify({ old: false, current: false })),
    correctGuard: descriptor('fixed disabled-session guard reconciliation', async () => {
      state.epoch++; state.allowed = false; state.correction = true; return 'true'
    }),
    save: descriptor('fixed native failure-preserving save', async () => { state.saved = true; return '' }),
    saveReady: descriptor('check exact new save readiness', async () => ({ ready: state.saved })),
    preserveSave: descriptor('fsync exact preserved save and hash', async () => ({ durable: true,
      path: path.join(root, 'preserved.zip'), sha256: 'a'.repeat(64), bytes: 100 })),
    verifySave: descriptor('full ZIP CRC and pristine exact-version load', async () => ({ zipIntegrity: true, exactVersionLoad: true })),
    cleanup: async owned => { state.cleaned.push(owned.id); return { absent: true } },
  }
  async function events() {
    const names = (await fs.readdir(evidenceDir)).filter(name => /^\d{6}\.json$/.test(name)).sort()
    return Promise.all(names.map(name => fs.readFile(path.join(evidenceDir, name), 'utf8').then(JSON.parse)))
  }
  const run = () => closeoutTrial({ identity, evidenceDir, callbacks, resources: [resource],
    limits: { commandMs: 30, savePollMs: 0, savePolls: 3 } })
  return { root, evidenceDir, callbacks, state, events, run }
}

test('original assert-before-capture baseline loses reply/save; shared boundary preserves both', async t => {
  // Minimal substitution of the sealed trial-server.mjs:194 ordering. Its raw
  // stop reply was not retained historically; this is an injected reply fixture.
  const control = { cancelled: true, disabled: true, after: { allowed: true } }
  let captured = false
  let saved = false
  assert.throws(() => {
    assert.equal(control.after.allowed, false)
    captured = true; saved = true
  })
  assert.equal(captured, false); assert.equal(saved, false)
  const f = await fixture(t)
  const originalStop = f.callbacks.stop.execute
  f.callbacks.stop.execute = async context => {
    const raw = JSON.parse(await originalStop(context)); f.state.allowed = true; raw.after.allowed = true
    return JSON.stringify(raw)
  }
  // An authoritative allow is not an advisory contradiction and must not be fixed
  // by retrying a world-changing stop. Preserve the failed world as failure-state.
  f.callbacks.authorize.execute = async () => '{"old":false,"current":true}'
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(result.strictStop, false)
  assert.equal(result.saveLabel, 'failure-state'); assert.equal(f.state.saved, true)
  assert.equal(result.preservationVerified, true); assert.equal(result.cleanupVerified, true)
  const events = await f.events()
  const reply = events.findIndex(event => event.phase === 'native_stop_reply')
  const receipt = events.findIndex(event => event.phase === 'operator_pause_receipt')
  assert.ok(reply >= 0 && reply < receipt)
  assert.equal(JSON.parse(events[reply].reply).after.allowed, true)
  assert.equal(events[reply - 1].command, 'fixed native cancel then disable')
})

test('strict success persists same-goal pause before save and preserves before cleanup', async t => {
  const f = await fixture(t)
  f.callbacks.save.execute = async () => {
    const events = await f.events()
    assert.equal(events.find(event => event.phase === 'operator_pause_receipt').receipt.goalId, identity.goalId)
    f.state.saved = true; return ''
  }
  f.callbacks.cleanup = async () => {
    assert.ok((await f.events()).some(event => event.phase === 'save_verify_reply'))
    return { absent: true }
  }
  const result = await f.run()
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.saveLabel, 'post-stop')
  assert.equal(result.evidenceDurable, true)
})

test('injected advisory residual is authoritatively denied, corrected once, and continues automatically', async t => {
  const f = await fixture(t)
  const original = f.callbacks.stop.execute
  f.callbacks.stop.execute = async context => {
    const reply = JSON.parse(await original(context)); f.state.allowed = true; reply.after.allowed = true
    return JSON.stringify(reply)
  }
  const result = await f.run()
  assert.equal(result.success, true); assert.equal(result.corrected, true)
  const events = await f.events()
  assert.equal(events.filter(event => event.phase === 'correction_reserved').length, 1)
  assert.ok(events.some(event => event.phase === 'corrected_authorization_reply'))
  assert.equal(f.state.cleaned.length, 1)
})

test('correction allowance survives host restart and exhaustion still saves the failure-state', async t => {
  const f = await fixture(t)
  const original = f.callbacks.stop.execute
  await fs.mkdir(f.evidenceDir)
  await fs.writeFile(path.join(f.evidenceDir, '000001.json'), JSON.stringify({ identity,
    phase: 'correction_reserved', attemptsUsed: 1, limit: 1 }))
  f.callbacks.stop.execute = async context => {
    const reply = JSON.parse(await original(context)); f.state.allowed = true; reply.after.allowed = true
    return JSON.stringify(reply)
  }
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(f.state.correction, false)
  assert.equal(result.saveLabel, 'failure-state'); assert.equal(result.preservationVerified, true)
  assert.ok(result.errors.some(error => error.code === 'correction_exhausted'))
})

for (const reply of [undefined, '', '{invalid']) {
  test(`absent/malformed stop reply ${String(reply)} remains failed but preserves authoritative idle world`, async t => {
    const f = await fixture(t)
    const original = f.callbacks.stop.execute
    f.callbacks.stop.execute = async context => { await original(context); return reply }
    const result = await f.run()
    assert.equal(result.success, false); assert.equal(result.saveLabel, 'failure-state')
    assert.equal(result.preservationVerified, true); assert.equal(result.cleanupVerified, true)
    assert.ok((await f.events()).some(event => event.phase === 'native_stop_reply'))
  })
}

test('cancel timeout captures original timeout and retains world with recovery instructions', async t => {
  const f = await fixture(t)
  f.callbacks.stop.execute = () => new Promise(() => {})
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(f.state.saved, false)
  assert.deepEqual(result.retainedResources, [resource]); assert.deepEqual(f.state.cleaned, [])
  assert.ok((await f.events()).some(event => event.phase === 'native_stop_reply' && event.outcome === 'timeout'))
})

for (const fault of ['busy', 'queue', 'unknown', 'actor', 'epoch', 'session', 'surface', 'force', 'journal', 'stale', 'humans', 'speed']) {
  test(`${fault} authoritative state fences save and resource disposal`, async t => {
    const f = await fixture(t)
    const original = f.callbacks.snapshot.execute
    f.callbacks.snapshot.execute = async context => {
      const snap = JSON.parse(await original(context))
      if (f.state.snapshotCalls > 1) {
        if (fault === 'busy') snap.status.task_state = 'working'
        if (fault === 'queue') snap.status.queue_length = 1
        if (fault === 'unknown') delete snap.status
        if (fault === 'actor') snap.guard.actor_id++
        if (fault === 'epoch') snap.guard.epoch++
        if (fault === 'session') snap.guard.session = 'replacement-session'
        if (fault === 'surface') snap.guard.surface_index++
        if (fault === 'force') snap.guard.force_index++
        if (fault === 'journal') delete snap.status.admission_journal
        if (fault === 'stale') snap.tick = 99
        if (fault === 'humans') snap.guard.connected_players = 1
        if (fault === 'speed') snap.speed = 2
      }
      return JSON.stringify(snap)
    }
    const result = await f.run()
    assert.equal(result.success, false); assert.equal(f.state.saved, false)
    assert.equal(result.retainedResources.length, 1); assert.deepEqual(f.state.cleaned, [])
  })
}

test('controller failure still captures native state but cannot cancel/save competing work', async t => {
  const f = await fixture(t)
  f.callbacks.stopController.execute = async () => { throw new Error('controller failure') }
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(f.state.epoch, identity.epoch)
  assert.equal(f.state.saved, false); assert.equal(f.state.snapshotCalls, 2)
  assert.equal(result.retainedResources.length, 1)
})

test('delayed save readiness is bounded and eventually preserves; exhaustion retains resources', async t => {
  const f = await fixture(t); let polls = 0
  f.callbacks.saveReady.execute = async () => ({ ready: ++polls === 3 })
  assert.equal((await f.run()).success, true); assert.equal(polls, 3)
  const exhausted = await fixture(t); let exhaustedPolls = 0
  exhausted.callbacks.saveReady.execute = async () => { exhaustedPolls++; return { ready: false } }
  const result = await exhausted.run()
  assert.equal(exhaustedPolls, 3); assert.equal(result.success, false)
  assert.equal(result.retainedResources.length, 1)
  assert.ok(result.errors.some(error => error.code === 'save_readiness_exhausted'))
})

for (const fault of ['zip', 'load', 'preservation', 'persistence']) {
  test(`${fault} failure cannot dispose world or erase the original stop reply`, async t => {
    const f = await fixture(t)
    if (fault === 'zip') f.callbacks.verifySave.execute = async () => { throw new Error('ZIP CRC error') }
    if (fault === 'load') f.callbacks.verifySave.execute = async () => ({ zipIntegrity: true, exactVersionLoad: false })
    if (fault === 'preservation') f.callbacks.preserveSave.execute = async () => ({ durable: false })
    if (fault === 'persistence') {
      f.callbacks.preserveSave.execute = async () => {
        // Make subsequent actual filesystem writes fail; retained existing event
        // files prove original command/reply capture happened before verification.
        const existing = await fs.readdir(f.evidenceDir)
        const next = Math.max(...existing.filter(name => /^\d{6}\.json$/.test(name)).map(name => Number(name.slice(0, 6)))) + 1
        await fs.mkdir(path.join(f.evidenceDir, `${String(next).padStart(6, '0')}.json`))
        return { durable: true, path: 'preserved.zip', bytes: 100, sha256: 'a'.repeat(64) }
      }
    }
    const result = await f.run()
    assert.equal(result.success, false); assert.equal(result.retainedResources.length, 1)
    assert.deepEqual(f.state.cleaned, [])
    const files = await fs.readdir(f.evidenceDir)
    const contents = await Promise.all(files.filter(name => /^\d{6}\.json$/.test(name)).map(async name => {
      try { return JSON.parse(await fs.readFile(path.join(f.evidenceDir, name), 'utf8')) } catch { return {} }
    }))
    assert.ok(contents.some(event => event.phase === 'native_stop_reply'))
    assert.equal(f.state.saved, true)
  })
}

test('identity replacement during awaited preservation fences disposal', async t => {
  const f = await fixture(t)
  const original = f.callbacks.preserveSave.execute
  f.callbacks.preserveSave.execute = async context => {
    await Promise.resolve(); f.state.actorId++; return original(context)
  }
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(result.retainedResources.length, 1)
  assert.ok(result.errors.some(error => error.code === 'disposal_identity_or_idle_unproven'))
})

test('failed command capture fences all subsequent native mutations while still stopping controller', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.evidenceDir)
  // The native_stop command is the fifth evidence entry. A directory at that
  // destination forces an actual durable-name write failure before native stop.
  await fs.mkdir(path.join(f.evidenceDir, '000005.json'))
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(result.evidenceDurable, false)
  assert.equal(f.state.epoch, identity.epoch); assert.equal(f.state.saved, false)
  assert.equal(result.retainedResources.length, 1)
  assert.ok(result.errors.some(error => error.code === 'mutation_fenced_by_evidence_failure'))
})

test('timed-out read cannot pass disposal or schedule a late persistence write after return', async t => {
  const f = await fixture(t)
  let completeLate
  let polls = 0
  f.callbacks.saveReady.execute = async () => {
    if (++polls === 1) return new Promise(resolve => { completeLate = resolve })
    return { ready: true }
  }
  const result = await f.run()
  assert.equal(result.success, false); assert.equal(result.preservationVerified, true)
  assert.equal(result.callbackQuiescenceUnproven, true)
  assert.equal(result.retainedResources.length, 1); assert.deepEqual(f.state.cleaned, [])
  // Any unjoined late persistence would now fail against this real invalid path.
  // The returned result cannot silently turn from success into an unseen error.
  const moved = `${f.evidenceDir}-complete`
  await fs.rename(f.evidenceDir, moved); await fs.writeFile(f.evidenceDir, 'not a directory')
  completeLate({ ready: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(result.evidenceDurable, true)
  const events = await Promise.all((await fs.readdir(moved)).filter(name => name.endsWith('.json'))
    .map(name => fs.readFile(path.join(moved, name), 'utf8').then(JSON.parse)))
  assert.equal(events.filter(event => event.phase.endsWith('_late_reply')).length, 0)
  assert.ok(events.some(event => event.phase === 'save_ready_reply' && event.outcome === 'timeout'))
})

test('one cleanup failure does not skip other preserved owned resources', async t => {
  const f = await fixture(t)
  const second = { id: 'owned-network', recoveryCommand: 'remove exact owned-network' }
  f.callbacks.cleanup = async owned => {
    f.state.cleaned.push(owned.id)
    if (owned.id === resource.id) throw new Error('cleanup failed')
    return { absent: true }
  }
  const result = await closeoutTrial({ identity, evidenceDir: f.evidenceDir,
    callbacks: f.callbacks, resources: [resource, second] })
  assert.equal(result.success, false); assert.equal(result.cleanupVerified, false)
  assert.deepEqual(f.state.cleaned, [resource.id, second.id])
  assert.deepEqual(result.retainedResources, [resource])
})
