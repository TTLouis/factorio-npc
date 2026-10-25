import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'
import { recoverySession, settle } from './recovery-loop-fixtures.mjs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NpcAgentLoop as StagingNpcAgentLoop } from '../staging/npc-agent-loop.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}
function world(options = {}) {
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const rows = []
  const agent = new NpcAgentLoop({ rcon: new FakeFactorio(), memory,
    provider: async () => { calls++; throw new Error('OFFLINE_PROVIDER_SENTINEL') },
    systemPrompt: 'offline cancellation regression', npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null, ...options })
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  return { agent, memory, rows, calls: () => calls }
}
for (const disposition of ['undefined', 'abort']) {
  test(`actual runtime fences explicit cancel during steering: ${disposition}`, async () => {
    const entered = deferred(); const held = deferred()
    const w = world({ steeringDecisionProvider: async () => { entered.resolve(); return held.promise } })
    const pending = w.agent.request('Build early automation', { sender: 'Louis' })
    const rejected = assert.rejects(pending, /cancelled or superseded/)
    await entered.promise
    w.agent.cancel('user_stop_immediate')
    if (disposition === 'abort') held.reject(Object.assign(new Error('fixture abort'), { name: 'AbortError' }))
    else held.resolve(undefined)
    await rejected
    assert.equal(w.calls(), 0)
    assert.equal(w.rows.filter(row => row.event === 'planning.goal_admission_steered').length, 0)
    assert.ok(w.rows.some(row => row.event === 'request.admission_refused'))
    assert.equal(w.rows.filter(row => row.event === 'actor.bound' || row.event === 'budget.reserved' || row.event === 'provider.request').length, 0)
  })
}
test('undefined steering with an owned intake retains legitimate default planning', async () => {
  const w = world({ steeringDecisionProvider: async () => undefined })
  await assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /OFFLINE_PROVIDER_SENTINEL/)
  assert.equal(w.calls(), 1)
  assert.ok(w.rows.some(row => row.event === 'planning.goal_admission_steered'))
})
for (const boundary of ['loadPersistentState', 'readInteractionTaskStatus']) {
  test(`stop before trace/goal exists fences ${boundary}`, async () => {
    const w = world(); const entered = deferred(); const held = deferred()
    const original = w.agent[boundary].bind(w.agent)
    w.agent[boundary] = async (...args) => { entered.resolve(); await held.promise; return original(...args) }
    const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    w.agent.cancel('user_stop_immediate')
    held.resolve()
    await pending
    assert.equal(w.calls(), 0)
    assert.equal(Boolean(w.memory.planningState('npc:sgluna')?.goal), false)
  })
}
test('superseding intake cannot steer, overwrite trace or spend replacement budget', async () => {
  const entered = deferred(); const held = deferred()
  let first = true
  const w = world({ steeringDecisionProvider: async () => { if (first) { first = false; entered.resolve(); return held.promise } return undefined } })
  const old = assert.rejects(w.agent.request('Old objective', { sender: 'Louis' }), /cancelled or superseded/)
  await entered.promise
  await assert.rejects(w.agent.request('Replacement objective', { sender: 'Louis' }), /OFFLINE_PROVIDER_SENTINEL/)
  const snapshot = w.memory.snapshot()
  const count = w.calls()
  held.resolve(undefined)
  await old
  assert.equal(w.calls(), count)
  assert.deepEqual(w.memory.snapshot(), snapshot)
})
for (const boundary of ['request.received', 'planning.goal_admitted', 'skill.offer_skipped', 'actor.bound']) {
  test(`late trace completion cannot reactivate intake after stop at ${boundary}`, async () => {
    const w = world(); const entered = deferred(); const held = deferred()
    w.agent.behaviorTrace.emit = async row => {
      w.rows.push(row)
      if (row.event === boundary) { entered.resolve(); await held.promise }
    }
    const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    w.agent.cancel('user_stop_immediate')
    held.resolve()
    await pending
    assert.equal(w.calls(), 0)
    assert.equal(w.agent.active, false)
  })
}
for (const changed of ['actor_id', 'epoch', 'session', 'npcId', 'trace']) {
  test(`intake fences changed ${changed} while steering is held`, async () => {
    const entered = deferred(); const held = deferred()
    const w = world({ steeringDecisionProvider: async () => { entered.resolve(); return held.promise } })
    const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    if (changed === 'npcId') w.agent.npcId = 'other'
    else if (changed === 'trace') w.agent.traceRequest = { id: 'replacement' }
    else w.agent.epoch = { [changed]: 'changed' }
    held.resolve(undefined)
    await pending
    assert.equal(w.calls(), 0)
  })
}
test('stale guarded pause cannot invalidate a replacement before its first trace/generation', async () => {
  const w = world(); const entered = deferred(); const held = deferred()
  const oldOwner = w.agent.captureCheckpointOwner()
  w.agent.loadPersistentState = async () => { entered.resolve(); await held.promise }
  const pending = w.agent.request('Replacement objective', { sender: 'Louis' })
  const stopped = assert.rejects(pending, /cancelled or superseded/)
  await entered.promise
  const replacement = w.agent.requestAdmissionOwner
  await assert.rejects(w.agent.pausePersistentPlan('old_guard', {}, oldOwner), /cancelled or superseded/)
  assert.equal(w.agent.requestAdmissionOwner, replacement)
  w.agent.cancel('user_stop_immediate')
  held.resolve()
  await stopped
})

test('real Session immediate stop fences a pending pre-goal intake without inventing a pause receipt', async () => {
  const w = world(); const entered = deferred(); const held = deferred()
  w.agent.loadPersistentState = async () => { entered.resolve(); await held.promise }
  const ctx = recoverySession({ ...w, game: w.agent.rcon, trace: w.rows })
  assert.equal(ctx.session.queuePlayerRequest('Louis', 'Build early automation'), true)
  await entered.promise
  assert.equal(ctx.session.queuePlayerRequest('Louis', 'stop'), true)
  held.resolve()
  await settle(ctx.session)
  assert.equal(w.calls(), 0)
  assert.equal(Boolean(w.memory.planningState('npc:sgluna')?.goal), false)
  assert.equal(w.rows.filter(row => row.event === 'goal.paused').length, 0)
  assert.equal(w.agent.active, false)
})

test('stale pause after its preload await leaves a replacement intake untouched', async () => {
  const w = world(); const entered = deferred(); const held = deferred()
  const original = w.agent.loadPersistentState.bind(w.agent)
  let first = true
  w.agent.loadPersistentState = async () => { if (first) { first = false; entered.resolve(); await held.promise } return original() }
  const owner = w.agent.captureCheckpointOwner()
  const pause = assert.rejects(w.agent.pausePersistentPlan('old_guard', {}, owner), /cancelled or superseded/)
  await entered.promise
  await assert.rejects(w.agent.request('Replacement objective', { sender: 'Louis' }), /OFFLINE_PROVIDER_SENTINEL/)
  const snapshot = w.memory.snapshot()
  held.resolve()
  await pause
  assert.deepEqual(w.memory.snapshot(), snapshot)
})
for (const field of ['actor_id', 'epoch', 'session']) {
  test(`fresh native ${field} change during steering refuses before further admission`, async () => {
    const entered = deferred(); const held = deferred()
    const w = world({ steeringDecisionProvider: async () => { entered.resolve(); return held.promise } })
    const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    w.agent.rcon.status[field] = field === 'session' ? 'fedcba9876543210fedcba9876543210' : w.agent.rcon.status[field] + 1
    held.resolve(undefined)
    await pending
    assert.equal(w.calls(), 0)
    assert.equal(w.rows.filter(row => row.event === 'planning.goal_admission_steered').length, 0)
  })
}
test('late refusal keeps old correlation and leaves replacement trace sequence untouched', async () => {
  const entered = deferred(); const held = deferred()
  const w = world({ steeringDecisionProvider: async () => { entered.resolve(); return held.promise } })
  const pending = assert.rejects(w.agent.request('Old objective', { sender: 'Louis' }), /cancelled or superseded/)
  await entered.promise
  const oldId = w.agent.traceRequest.id
  w.agent.cancel('user_stop_immediate')
  const replacement = w.agent.traceRequest = { id: 'replacement', seq: 15 }
  held.resolve(undefined)
  await pending
  assert.equal(replacement.seq, 15)
  const refusal = w.rows.find(row => row.event === 'request.admission_refused')
  assert.equal(refusal.request_id, oldId)
})

test('unchanged staging caller without owner callback still binds and reaches its provider', async () => {
  let calls = 0
  const agent = new StagingNpcAgentLoop({ rcon: new FakeFactorio(), memory: new CanonicalTaskBoardMemory(),
    provider: async () => { calls++; throw new Error('STAGING_OFFLINE_SENTINEL') }, systemPrompt: 'offline' })
  await assert.rejects(agent.request('Observe current world', { sender: 'Louis' }), /STAGING_OFFLINE_SENTINEL/)
  assert.equal(calls, 1)
})
test('late planner-shape response cannot overwrite a replacement goal reading', async () => {
  const entered = deferred(); const held = deferred()
  const w = world({ interactionDecisionProvider: async () => { entered.resolve(); return held.promise } })
  w.agent.classifyInteraction = async () => ({ route: { intent: 'new_goal', queue_conflict: false, reply: '' }, router_bypassed: true })
  const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
  await entered.promise
  w.agent.cancel('user_stop_immediate')
  const marker = w.agent.goalReading = { replacement: true }
  held.resolve(undefined)
  await pending
  assert.equal(w.agent.goalReading, marker)
  assert.equal(w.calls(), 0)
  assert.equal(Boolean(w.memory.planningState('npc:sgluna')?.goal), false)
})
test('cancellation while steering decision trace waits prevents the advisory provider call', async () => {
  const entered = deferred(); const held = deferred()
  let sideCalls = 0
  const w = world({ steeringDecisionProvider: async () => { sideCalls++; return undefined } })
  w.agent.decisionTrace = { emit: async row => { if (row.event === 'decision.request') { entered.resolve(); await held.promise } } }
  const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
  await entered.promise
  w.agent.cancel('user_stop_immediate')
  held.resolve()
  await pending
  assert.equal(sideCalls, 0)
  assert.equal(w.calls(), 0)
})
test('queued intake persistence refuses a cancelled snapshot before publishing it', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-admission-fence-'))
  try {
    const filename = path.join(directory, 'state.json')
    const w = world({ stateFile: filename }); const entered = deferred(); const held = deferred()
    w.agent.stateLoaded = true
    w.agent.persistQueue = held.promise
    const persist = w.agent.persistState.bind(w.agent)
    w.agent.persistState = async (...args) => { const write = persist(...args); entered.resolve(); return write }
    const pending = assert.rejects(w.agent.request('Build early automation', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    w.agent.cancel('user_stop_immediate')
    held.resolve()
    await pending
    await assert.rejects(fsp.access(filename), { code: 'ENOENT' })
    assert.equal(w.calls(), 0)
  }
  finally { await fsp.rm(directory, { recursive: true, force: true }) }
})
test('first durable restore is shared across cancellation and replacement intake', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-admission-restore-'))
  const originalRead = fsp.readFile
  const entered = deferred(); const held = deferred()
  const filename = path.join(directory, 'state.json')
  let reads = 0; let restores = 0; let statusReads = 0
  try {
    const seed = new CanonicalTaskBoardMemory()
    seed.admitPlanningGoal('npc:sgluna', { owner: 'Louis', objective: 'Durable prior objective', now: 100 })
    await fsp.writeFile(filename, JSON.stringify(seed.snapshot()))
    fsp.readFile = async (file, ...args) => {
      if (file === filename) { reads++; entered.resolve(); await held.promise }
      return originalRead(file, ...args)
    }
    const w = world({ stateFile: filename })
    const restore = w.memory.restore.bind(w.memory)
    w.memory.restore = (...args) => { restores++; return restore(...args) }
    const readStatus = w.agent.readInteractionTaskStatus.bind(w.agent)
    w.agent.readInteractionTaskStatus = async () => { statusReads++; return readStatus() }
    const old = assert.rejects(w.agent.request('Cancelled objective', { sender: 'Louis' }), /cancelled or superseded/)
    await entered.promise
    w.agent.cancel('user_stop_immediate')
    const next = assert.rejects(w.agent.request('Replacement objective', { sender: 'Louis' }), /OFFLINE_PROVIDER_SENTINEL/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(statusReads, 0, 'replacement cannot skip the durable restore barrier')
    held.resolve()
    await old
    await next
    assert.equal(reads, 1)
    assert.equal(restores, 1)
    assert.equal(w.memory.planningState('npc:sgluna').goal.objective, 'Replacement objective')
    assert.equal(w.calls(), 1)
  }
  finally {
    held.resolve()
    fsp.readFile = originalRead
    await fsp.rm(directory, { recursive: true, force: true })
  }
})
test('supersession during base actor capture cannot replace the newer conversation', async () => {
  const w = world()
  const entered = deferred()
  const held = deferred()
  const capture = w.agent.captureEpoch.bind(w.agent)
  let first = true
  w.agent.captureEpoch = async () => {
    if (first) { first = false; entered.resolve(); await held.promise }
    return capture()
  }
  const old = assert.rejects(w.agent.request('Old objective', { sender: 'Louis' }), /cancelled or superseded/)
  await entered.promise
  await assert.rejects(w.agent.request('Replacement objective', { sender: 'Louis' }), /OFFLINE_PROVIDER_SENTINEL/)
  const conversation = w.agent.messages
  const requestInfo = w.agent.requestInfo
  const snapshot = w.memory.snapshot()
  held.resolve()
  await old
  assert.equal(w.agent.messages, conversation)
  assert.equal(w.agent.requestInfo, requestInfo)
  assert.deepEqual(w.memory.snapshot(), snapshot)
  assert.equal(w.calls(), 1)
})
