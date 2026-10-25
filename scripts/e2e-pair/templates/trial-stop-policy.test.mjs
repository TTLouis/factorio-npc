import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { trialStopDecision, stopTrialIfTerminal } from './trial-stop-policy.mjs'
import { supervisorStop } from './trial-supervisor-stop.mjs'

const v = JSON.parse(fs.readFileSync('/candidate/deploy/pterodactyl/runtime-v8/fixtures/run-v-shoreline.json'))
const startedAt = Date.parse('2026-10-16T15:25:33.967Z')
const goalId = v.auto_resume[0].goal_id ?? 'goal_01zf04a_1'
const base = () => ({ startedAt, now: Date.parse(v.pause_at), goalId, actorId: 6,
  native: { actor_id: 6, speed: 1, humans: 0 }, events: [],
  canonical: { goal: { goal_id: goalId }, active_plan_id: 'p',
    plans: [{ plan_id: 'p', plan_version: 1, status: 'EXECUTING', active_step_index: 0, steps: [{ step_id: 's' }] }],
    run: { paused: true, pause_class: v.pause_class, pause_reason: v.pause_reason, paused_at: Date.parse(v.pause_at) } },
})

test('supervisor CLI exits before connecting when its explicit run identity is missing', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./trial-supervisor-stop.mjs', import.meta.url))], {
    env: {}, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Explicit expected run ID required/)
  assert.doesNotMatch(result.stderr, /ENOENT|ECONN|RCON/)
})
const exhausted = input => ({ event: 'recovery.auto_resume_exhausted', ts: new Date(input.now).toISOString(),
  request_id: 'recovery-current', data: { goal_id: goalId, plan_id: 'p', plan_version: 1, step_id: 's', reason: 'goal_limit_reached' } })

test('Run V observed omission exhaustion remains bounded recovery; a cleared pause cannot trigger supervisor stop', async () => {
  const input = base()
  const original = structuredClone(input)
  const first = trialStopDecision(input)
  assert.equal(first.action, 'wait')
  assert.equal(first.reason, 'bounded_automatic_recovery_pending')
  assert.equal(first.result, null)
  assert.deepEqual(input, original)
  let stops = 0
  const resumed = structuredClone(input)
  resumed.now = Date.parse(v.prestop_pause_cleared_at)
  resumed.canonical.run = { paused: v.prestop_paused, pause_class: '', pause_reason: '' }
  resumed.events = [{ event: 'operation.refused', data: v.native_refusal }]
  const checked = await stopTrialIfTerminal({ policy: input, readCurrent: async () => resumed, stop: async () => { stops++ } })
  assert.equal(checked.action, 'continue')
  assert.equal(checked.pausedSince, null)
  assert.equal(stops, 0, 'stale parent stop intent must be reclassified before mutation')
  const guard = structuredClone(input); guard.canonical.run.pause_class = 'guard'
  let reads = 0
  const raced = await stopTrialIfTerminal({ policy: {}, readCurrent: async () => ++reads === 1 ? guard : resumed, stop: async () => { stops++ } })
  assert.equal(raced.action, 'continue'); assert.equal(stops, 0); assert.equal(reads, 2)
})

test('canonical structural blocker stops even when run.paused is false; historical blockers do not', () => {
  const input = base(); input.canonical.run.paused = false
  const plan = input.canonical.plans[0]; plan.status = 'BLOCKED'
  assert.equal(trialStopDecision(input).result, 'controller_blocked:canonical_plan')
  plan.status = 'EXECUTING'; plan.blocker = { requires_user_decision: true }
  assert.equal(trialStopDecision(input).result, 'controller_blocked:requires_user_decision')
  input.canonical.plans.push({ plan_id: 'new', status: 'EXECUTING' }); input.canonical.active_plan_id = 'new'
  assert.equal(trialStopDecision(input).action, 'continue')
})

test('only current goal/plan/step exhaustion with a presently paused controller is terminal', () => {
  const input = base(); input.events = [exhausted(input)]
  assert.equal(trialStopDecision(input).result, 'auto_resume_exhausted')
  assert.equal(trialStopDecision(input).evidence.request_id, 'recovery-current')
  for (const field of ['goal_id', 'plan_id', 'plan_version', 'step_id', 'actor_id']) {
    const stale = structuredClone(input); stale.events[0].data[field] = 'other'
    assert.equal(trialStopDecision(stale).action, 'wait', field)
  }
  for (const ts of [startedAt - 1, input.now + 1, input.now - 1]) {
    const stale = structuredClone(input); stale.events[0].ts = new Date(ts).toISOString()
    assert.equal(trialStopDecision(stale).action, 'wait')
  }
  input.now += 1000
  input.events.push({ event: 'recovery.auto_resume_plan_resumed', ts: new Date(input.now).toISOString(), data: { goal_id: goalId } })
  assert.equal(trialStopDecision(input).action, 'wait', 'a completed resume invalidates old exhaustion evidence')
  input.canonical.run.paused = false
  assert.equal(trialStopDecision(input).action, 'continue')
})

test('model and transport pauses wait at most ten minutes; healthy observations clear the timer', () => {
  for (const pause_class of ['model_recoverable', 'transport']) {
    const input = base(); input.canonical.run.pause_class = pause_class
    input.now += 599999
    assert.equal(trialStopDecision(input).action, 'wait')
    input.now++
    assert.equal(trialStopDecision(input).result, `controller_paused_not_resumed:${pause_class}`)
    input.canonical.run.paused = false
    assert.equal(trialStopDecision(input).pausedSince, null)
  }
  const input = base(); delete input.canonical.run.paused_at
  const first = trialStopDecision(input)
  input.pausedSince = first.pausedSince; input.now += 600000
  assert.equal(trialStopDecision(input).reason, 'recoverable_pause_timeout')
})

test('guards, operator stops and unclassified pauses remain terminal', async () => {
  for (const pause_class of ['guard', 'operator', 'requires_user', '']) {
    const input = base(); input.canonical.run.pause_class = pause_class
    let calls = 0
    const decision = await stopTrialIfTerminal({ policy: {}, readCurrent: async () => input, stop: async d => {
      calls++; assert.equal(d.evidence.reason, 'nonresumable_controller_pause')
    } })
    assert.equal(decision.action, 'stop'); assert.equal(calls, 1)
  }
})

test('reserve, approved wall caps and actor/goal/human/speed fences apply during recovery', () => {
  const input = base()
  assert.equal(trialStopDecision({ ...input, hardFloorReached: true }).result, 'weekly_hard_floor')
  for (const minutes of [45, 60]) {
    const capped = { ...input, constructionLimitMs: minutes * 60000, now: startedAt + minutes * 60000 }
    assert.equal(trialStopDecision(capped).result, `construction_wall_limit_${minutes}_minutes`)
  }
  for (const [key, value] of [['actor_id', 7], ['humans', 1], ['speed', 2]]) {
    assert.equal(trialStopDecision({ ...input, native: { ...input.native, [key]: value } }).result, 'trial_invariant_changed')
  }
  input.canonical.goal.goal_id = 'changed'
  assert.equal(trialStopDecision(input).result, 'goal_identity_changed')
  assert.throws(() => trialStopDecision({ ...input, constructionLimitMs: Infinity }), /Invalid/)
})

test('actual supervisor entry point rereads files/native state and refuses Run V premature stop, then honors a real guard', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trial-supervisor-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await fsp.mkdir(path.join(root, 'logs')); await fsp.mkdir(path.join(root, '.sgluna'))
  const input = base(); const calls = []
  await fsp.writeFile(path.join(root, 'logs/e2e-trial-identity.json'), JSON.stringify({ run_id: 'run-v-replay',
    goal_id: goalId, actor_id: 6, started_at: startedAt, construction_limit_ms: 45 * 60000, helper_root: root }))
  await fsp.writeFile(path.join(root, 'logs/sgluna-behavior.jsonl'), '')
  const statePath = path.join(root, '.sgluna/npc-state.json')
  const writeState = () => fsp.writeFile(statePath, JSON.stringify({ planning_states: [{ state: input.canonical }] }))
  const rcon = { command: async command => { calls.push(command); return JSON.stringify(input.native) } }
  const check = () => supervisorStop({ rcon, root, expectedRunId: 'run-v-replay', snapshotCommand: 'native-snapshot', now: () => input.now })
  await writeState()
  assert.equal((await check()).action, 'wait')
  input.canonical.run.paused = false; await writeState()
  assert.equal((await check()).action, 'continue')
  assert.deepEqual(calls, ['native-snapshot', 'native-snapshot'])
  input.canonical.run = { paused: true, pause_class: 'guard' }; await writeState()
  assert.equal((await check()).action, 'stop')
  assert.equal(calls.at(-1), '!luna stop')
  assert.match(calls.at(-2), /sgluna_tick_sprint.*seal/)
  await assert.rejects(() => supervisorStop({ rcon, root, expectedRunId: 'wrong-run', snapshotCommand: 'native-snapshot' }), /identity mismatch/)
  assert.equal(calls.length, 6, 'identity mismatch must not issue RCON commands')
  input.canonical.run = { paused: true, pause_class: 'model_recoverable', paused_at: input.now - 600000 }
  await writeState()
  let interruptedStops = 0
  const delayedNative = { command: async command => {
    if (command === '!luna stop') { interruptedStops++; return '' }
    input.canonical.run = { paused: false, pause_class: '' }; await writeState()
    return JSON.stringify(input.native)
  } }
  const raced = await supervisorStop({ rcon: delayedNative, root, expectedRunId: 'run-v-replay', snapshotCommand: 'native-snapshot', now: () => input.now })
  assert.equal(raced.action, 'continue'); assert.equal(interruptedStops, 0, 'a pause cleared during native observation cannot be stopped')
})
