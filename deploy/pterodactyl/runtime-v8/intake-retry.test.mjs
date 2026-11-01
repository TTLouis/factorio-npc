import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  failureCauseCode,
  transportFailureOf,
  transportTraceFields,
} from './pause-class.mjs'
import { PLANNING_EVENT } from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { autoResumeDelayMs, autoResumeMaxAttempts, Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const OBJECTIVE = 'get steam power going and run an electric mining drill on iron ore'
// Run F: the CLI-proxy host did not resolve. The hostname below is fake; the point is that it never reaches a trace row or a chat line.
const FAKE_HOST = 'cliproxy.fake-host.invalid'

// What undici raises when DNS fails: TypeError('fetch failed') with the real reason on error.cause.
function fetchFailed(code = 'ENOTFOUND') {
  const cause = Object.assign(new Error(`getaddrinfo ${code} ${FAKE_HOST}`), { code, errno: -3008, syscall: 'getaddrinfo', hostname: FAKE_HOST })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function contextWindowFailure() {
  return Object.assign(new Error('provider_context_window_exceeded: the prompt does not fit the model context window'), { code: 'provider_context_window_exceeded' })
}

// --- the classifier and the trace fields --------------------------------------------------------------------------------------

test('undici fetch failures classify as transport from the cause code, and only the code is read', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'EHOSTUNREACH']) {
    const error = fetchFailed(code)
    assert.deepEqual(transportFailureOf(error), { subkind: 'transport', source: 'structured' }, code)
    assert.equal(failureCauseCode(error), code)
    assert.deepEqual(transportTraceFields(error), { cause_code: code, pause_class: 'transport', transport_subkind: 'transport' })
  }
  // Undici's response timeouts stay on the timeout subkind, so unit 7's timeout handling is unchanged.
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    assert.deepEqual(transportFailureOf(fetchFailed(code)), { subkind: 'timeout', source: 'structured' }, code)
    assert.deepEqual(transportTraceFields(fetchFailed(code)), { cause_code: code, pause_class: 'transport', transport_subkind: 'timeout' })
  }
  // The cause message names the host; it is never copied into the fields.
  assert.equal(JSON.stringify(transportTraceFields(fetchFailed())).includes(FAKE_HOST), false)
  // An AggregateError cause (undici's refused connection to several addresses) carries the code on its members.
  const aggregate = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })], 'fixture connection failure'), { code: undefined }) })
  assert.equal(failureCauseCode(aggregate), 'ECONNREFUSED')
  assert.equal(transportFailureOf(aggregate)?.subkind, 'transport')
  // No cause at all: the legacy text still places it, and there is no code to report.
  assert.deepEqual(transportFailureOf(new TypeError('fetch failed')), { subkind: 'transport', source: 'legacy_text' })
  assert.deepEqual(transportTraceFields(new TypeError('fetch failed')), { pause_class: 'transport', transport_subkind: 'transport' })
})

test('a context-window or output-budget failure is never transport, whatever code or text accompanies it', () => {
  const windowFailure = Object.assign(contextWindowFailure(), { cause: { code: 'ENOTFOUND' } })
  assert.equal(transportFailureOf(windowFailure), undefined)
  assert.equal('pause_class' in transportTraceFields(windowFailure), false)
  const budget = Object.assign(new Error('provider_output_budget_exhausted: finish=length'), { cause: { code: 'ECONNRESET' } })
  assert.equal(transportFailureOf(budget), undefined)
  assert.equal(transportFailureOf(Object.assign(new Error('x'), { failureClass: 'provider_budget', cause: { code: 'ETIMEDOUT' } })), undefined)
  // A code that is not a short upper-case token (a loop code, free text) is not reported.
  assert.equal(failureCauseCode(contextWindowFailure()), undefined)
  assert.equal(failureCauseCode(Object.assign(new Error('x'), { code: `ENOTFOUND ${FAKE_HOST}` })), undefined)
  assert.equal(failureCauseCode('fetch failed'), undefined)
})

// --- the supervisor on the real agent -------------------------------------------------------------------------------------------

const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const plannerSlice = () => planReply({ plan: ['Gather 10 iron ore', 'Gather 10 copper ore'], currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: GOAL, roadmap: SHELF })

function makeWorld({ stateFile = null, failure = fetchFailed } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const trace = []
  const state = { failure, calls: 0 }
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const game = new FakeFactorio()
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      state.calls++
      if (state.failure) throw state.failure()
      return plannerSlice()
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'intake retry',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  // A synthetic clock, so rows written in the same millisecond keep their order when run-check sorts them.
  agent.behaviorTrace = { emit: async (record) => { trace.push({ ...record, ts: new Date(1_760_000_000_000 + trace.length * 10).toISOString() }) } }
  return { game, memory, agent, trace, state }
}

function sessionFor(agent, { actor_id: actorId = 18, epoch = 3 } = {}) {
  const chat = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent,
    npcId: 'sgluna',
    npcName: 'SGLuna',
    stopping: false,
    autoResume: null,
    modelResume: null,
    intakeRetry: null,
    lastPauseDecision: '',
    lastStatus: { actor_id: actorId, epoch },
    liveStatus: { actor_id: actorId, epoch },
    log: message => logs.push(message),
    printChat: async (message) => { chat.push(message) },
    eventQueue: Promise.resolve(),
    rawStatus: async () => ({ ...session.liveStatus }),
    syncTaskBoardUi: async () => {},
    ensureAuthorization: async () => ({}),
    appendUiConversation: () => {},
    rcon: { command: async () => '' },
  })
  return { session, chat, logs }
}

const rowsOf = (trace, name) => trace.filter(row => row.event === name)
const dataOf = (trace, name) => rowsOf(trace, name).map(row => row.data)

async function tempState(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-intake-retry-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  return path.join(dir, 'npc-state.json')
}

// The objective arrives as a player request, the first planner call fails on transport, and the supervisor keeps it.
async function failedAtIntake(t, options = {}) {
  const stateFile = options.stateFile ?? await tempState(t)
  const world = makeWorld({ stateFile, ...options.world })
  const harness = sessionFor(world.agent, options.actor)
  t.after(() => { if (harness.session.intakeRetry?.timer) clearTimeout(harness.session.intakeRetry.timer) })
  assert.equal(harness.session.queuePlayerRequest('TTLouis', OBJECTIVE), true)
  await harness.session.eventQueue
  return { ...world, ...harness, stateFile }
}

const fire = async (session) => {
  const pending = session.intakeRetry
  clearTimeout(pending.timer)
  pending.timer = null
  return session.runIntakeRetry(pending.token)
}

test('a transport failure on the first planner call keeps the objective as an intake retry, with the cause code and no host in any row', async t => {
  const run = await failedAtIntake(t)
  assert.equal(run.state.calls, 1)

  const providerError = dataOf(run.trace, 'provider.error').at(-1)
  assert.equal(providerError.message, 'fetch failed')
  assert.equal(providerError.cause_code, 'ENOTFOUND')
  assert.equal(providerError.pause_class, 'transport')
  assert.equal(providerError.transport_subkind, 'transport')
  const failed = rowsOf(run.trace, 'request.failed').at(-1)
  assert.equal(failed.data.recoverable, false)
  assert.equal(failed.data.message, 'fetch failed')
  assert.equal(failed.data.cause_code, 'ENOTFOUND')
  assert.equal(failed.data.pause_class, 'transport')
  assert.equal(failed.data.transport_subkind, 'transport')

  const [scheduled] = dataOf(run.trace, 'recovery.intake_retry_scheduled')
  assert.equal(rowsOf(run.trace, 'recovery.intake_retry_scheduled')[0].request_id, failed.request_id)
  assert.equal(scheduled.request_id, failed.request_id)
  assert.equal(scheduled.reason, 'transport_failure_at_intake')
  assert.equal(scheduled.attempt, 1)
  assert.equal(scheduled.limit, autoResumeMaxAttempts('transport'))
  assert.equal(scheduled.delay_ms, autoResumeDelayMs('transport', 0), 'the unit 7 transport schedule, not a new one')
  assert.equal(scheduled.transport_subkind, 'transport')
  assert.equal(scheduled.cause_code, 'ENOTFOUND')
  assert.equal(scheduled.interaction_intent, 'new_goal')
  assert.deepEqual([scheduled.actor_id, scheduled.actor_epoch], [18, 3])
  assert.ok(scheduled.goal_id, 'the orphan goal admitted at intake is named')

  // One chat line, no raw "Request failed" line, and nothing names the host.
  assert.equal(run.chat.length, 1)
  assert.match(run.chat[0], /could not reach the model provider \(transport\)/)
  assert.match(run.chat[0], /Retrying automatically in 30 s \(attempt 1\/6\)/)
  const everything = JSON.stringify([run.trace, run.chat, run.logs])
  assert.equal(everything.includes(FAKE_HOST), false, 'no hostname in any trace row, chat line or log')
  assert.equal(/https?:\/\//.test(JSON.stringify(run.trace)), false)

  // The durable record is the whole request.
  const record = run.memory.intakeRetry()
  assert.deepEqual([record.sender, record.text, record.interaction_intent, record.attempt, record.actor_id, record.epoch, record.cause_code],
    ['TTLouis', OBJECTIVE, 'new_goal', 1, 18, 3, 'ENOTFOUND'])
  assert.equal(record.request_id, failed.request_id)
  await run.agent.persistState()
  assert.equal(JSON.parse(await fsp.readFile(run.stateFile, 'utf8')).intake_retry.text, OBJECTIVE)

  // run-check: the failed request is informational, not a finding.
  const analysis = analyzeBehaviorTrace(run.trace)
  assert.deepEqual(analysis.findings.map(finding => finding.signature), [])
  assert.equal(analysis.informational.some(item => item.signature === 'intake_retry_scheduled' && /cause ENOTFOUND/.test(item.detail)), true)
})

test('the retry re-queues the same objective and it is admitted as the same goal; the record is dropped', async t => {
  const run = await failedAtIntake(t)
  const [scheduled] = dataOf(run.trace, 'recovery.intake_retry_scheduled')
  run.state.failure = undefined // the provider is reachable again
  const result = await fire(run.session)
  assert.ok(result, 'the retry ran the request')

  const [started] = dataOf(run.trace, 'recovery.intake_retry_started')
  assert.equal(started.request_id, scheduled.request_id)
  assert.equal(started.attempt, 1)
  assert.equal(started.reason, 'backoff_elapsed')
  assert.equal(started.limit, 6)
  const received = dataOf(run.trace, 'request.received').at(-1)
  assert.equal(received.text, OBJECTIVE)
  assert.equal(received.interaction_intent, 'new_goal')

  const planning = run.memory.planningState(KEY)
  // The orphan goal the failed attempt admitted is replaced by the retry's own admission of the same objective: one goal, not two.
  assert.equal(planning.goal.objective, OBJECTIVE)
  assert.equal(planning.goal.status, 'active')
  assert.equal(planning.plans.length, 1, 'the first plan of the goal was committed')
  assert.equal(planning.task_ledger?.tasks?.length ?? 0, 0, 'the plan-less goal was not recorded as an interrupted task')
  assert.equal(run.game.mutations.length, 1, 'the first batch of the plan was sent')
  assert.equal(run.memory.intakeRetry(), undefined)
  assert.equal(run.session.intakeRetry, null)
  await run.agent.persistState()
  assert.equal('intake_retry' in JSON.parse(await fsp.readFile(run.stateFile, 'utf8')), false)
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_cancelled').length, 0)
})

test('a player stop during the backoff cancels the retry synchronously and nothing is re-queued', async t => {
  const run = await failedAtIntake(t)
  const token = run.session.intakeRetry.token
  const timer = run.session.intakeRetry.timer
  assert.ok(timer)
  const callsBefore = run.state.calls

  run.session.queuePlayerRequest('TTLouis', 'stop')
  // Before anything queued has run: the token is cancelled and the durable record is gone.
  assert.equal(token.cancelled, true)
  assert.equal(token.reason, 'player_request')
  assert.equal(run.session.intakeRetry, null)
  assert.equal(run.memory.intakeRetry(), undefined)
  await run.session.eventQueue

  const [cancelled] = dataOf(run.trace, 'recovery.intake_retry_cancelled')
  assert.equal(cancelled.reason, 'player_request')
  assert.equal(cancelled.attempt, 1)
  assert.equal(cancelled.request_id, dataOf(run.trace, 'recovery.intake_retry_scheduled')[0].request_id)
  // A timer that was already in flight finds nothing to run.
  run.state.failure = undefined
  assert.equal(await run.session.runIntakeRetry(token), null)
  assert.equal(run.state.calls, callsBefore, 'no provider call after the stop')
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_started').length, 0)
  await run.agent.persistState()
  assert.equal('intake_retry' in JSON.parse(await fsp.readFile(run.stateFile, 'utf8')), false)
})

test('a new player request or a UI control cancels it the same way', async t => {
  for (const [label, cancel, reason] of [
    ['a new request', session => session.queuePlayerRequest('TTLouis', 'build me a furnace'), 'player_request'],
    ['a UI pause', session => session.cancelAutoResume('ui_pause'), 'ui_pause'],
    ['a UI new_task', session => session.cancelAutoResume('ui_new_task'), 'ui_new_task'],
  ]) {
    const run = await failedAtIntake(t)
    const token = run.session.intakeRetry.token
    cancel(run.session)
    assert.equal(token.cancelled, true, label)
    assert.equal(run.session.intakeRetry, null, label)
    assert.equal(run.memory.intakeRetry(), undefined, label)
    run.state.failure = () => new Error('stop the queued request here')
    await run.session.eventQueue
    assert.equal(dataOf(run.trace, 'recovery.intake_retry_cancelled')[0].reason, reason, label)
  }
})

test('a restart mid-backoff keeps the retry: the record is restored from disk and put back on its clock', async t => {
  const first = await failedAtIntake(t)
  const [scheduled] = dataOf(first.trace, 'recovery.intake_retry_scheduled')
  // A graceful stop keeps the durable record (the restart resumes it).
  first.session.stopping = true
  first.session.cancelAutoResume('session_stopping')
  assert.equal(first.session.intakeRetry, null)
  assert.equal(dataOf(first.trace, 'recovery.intake_retry_cancelled').at(-1).kept_for_restart, true)
  await first.agent.persistState()

  // The new process: a fresh agent on the same state file. The timer is gone, the record is not.
  const second = makeWorld({ stateFile: first.stateFile, failure: null })
  await second.agent.loadPersistentState()
  assert.equal(second.memory.intakeRetry().text, OBJECTIVE)
  const restarted = sessionFor(second.agent)
  t.after(() => { if (restarted.session.intakeRetry?.timer) clearTimeout(restarted.session.intakeRetry.timer) })
  assert.equal(restarted.session.queueStartupRecovery(undefined), 'intake_retry', 'it replaces the "restarted before the first plan" notice')
  await restarted.session.eventQueue
  const [restored] = dataOf(second.trace, 'recovery.intake_retry_scheduled')
  assert.equal(restored.reason, 'restored_after_restart')
  assert.equal(restored.restored, true)
  assert.equal(restored.attempt, 1)
  assert.equal(restored.cause_code, 'ENOTFOUND')
  assert.equal(restored.goal_id, scheduled.goal_id)
  assert.ok(restored.delay_ms <= autoResumeDelayMs('transport', 0))
  assert.match(restarted.chat.at(-1), /restarted while waiting to retry/)

  const result = await fire(restarted.session)
  assert.ok(result, JSON.stringify(dataOf(second.trace, 'recovery.intake_retry_cancelled')))
  assert.equal(second.memory.planningState(KEY).goal.objective, OBJECTIVE)
  assert.equal(second.memory.planningState(KEY).plans.length, 1)
  assert.equal(second.memory.intakeRetry(), undefined)
})

test('a restart onto another body drops the record with a reason and a chat line, never silently', async t => {
  const first = await failedAtIntake(t)
  await first.agent.persistState()
  const saved = await fsp.readFile(first.stateFile, 'utf8')
  for (const [live, reason] of [[{ actor_id: 19, epoch: 3 }, 'actor_changed'], [{ actor_id: 18, epoch: 4 }, 'epoch_changed']]) {
    await fsp.writeFile(first.stateFile, saved) // each restart starts from the state the first process left
    const second = makeWorld({ stateFile: first.stateFile, failure: null })
    await second.agent.loadPersistentState()
    const restarted = sessionFor(second.agent, live)
    await restarted.session.restoreIntakeRetry()
    const [cancelled] = dataOf(second.trace, 'recovery.intake_retry_cancelled')
    assert.equal(cancelled.reason, reason)
    assert.equal(cancelled.restored, true)
    assert.equal(restarted.session.intakeRetry, null)
    assert.equal(second.memory.intakeRetry(), undefined)
    assert.match(restarted.chat[0], new RegExp(`could not safely keep it \\(${reason}\\)`))
    assert.equal(second.state.calls, 0)
    // The startup goal notice the cancel queued writes state too: let it settle before the next restart reuses the file.
    await restarted.session.eventQueue
    await second.agent.persistState()
  }
})

test('the actor, the epoch and an admitted goal are fenced at fire time; no request is re-queued', async t => {
  const cases = [
    ['actor_changed', async run => { run.session.liveStatus = { actor_id: 19, epoch: 3 } }],
    ['epoch_changed', async run => { run.session.liveStatus = { actor_id: 18, epoch: 4 } }],
    ['goal_admitted', async run => {
      // Another goal was admitted while the retry waited.
      run.memory.dispatchPlanningEvent(KEY, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: Date.now(), goal_id: 'goal_other', owner: 'someone', objective: 'something else' })
    }],
  ]
  for (const [reason, change] of cases) {
    const run = await failedAtIntake(t)
    const callsBefore = run.state.calls
    await change(run)
    run.state.failure = undefined
    assert.equal(await fire(run.session), null, reason)
    const [cancelled] = dataOf(run.trace, 'recovery.intake_retry_cancelled')
    assert.equal(cancelled.reason, reason)
    assert.equal(cancelled.attempt, 1)
    assert.equal(run.state.calls, callsBefore, `${reason}: no provider call`)
    assert.equal(dataOf(run.trace, 'recovery.intake_retry_started').length, 0, reason)
    assert.equal(run.memory.intakeRetry(), undefined, reason)
    assert.equal(run.session.intakeRetry, null, reason)
  }
})

test('exhausting the limit leaves one chat line and one exhausted row, and the record is gone', async t => {
  const run = await failedAtIntake(t)
  const limit = autoResumeMaxAttempts('transport')
  for (let attempt = 1; attempt <= limit; attempt++) {
    assert.equal(run.session.intakeRetry.record.attempt, attempt)
    await fire(run.session) // the provider is still unreachable: this attempt fails and schedules the next, or reports the limit
  }
  assert.equal(run.session.intakeRetry, null)
  assert.equal(run.memory.intakeRetry(), undefined)
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_started').length, limit)
  assert.deepEqual(dataOf(run.trace, 'recovery.intake_retry_scheduled').map(row => row.attempt), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(dataOf(run.trace, 'recovery.intake_retry_scheduled').map(row => row.delay_ms), [0, 1, 2, 3, 4, 5].map(attempt => autoResumeDelayMs('transport', attempt)))

  const exhausted = dataOf(run.trace, 'recovery.intake_retry_exhausted')
  assert.equal(exhausted.length, 1)
  assert.equal(exhausted[0].reason, 'retry_limit_reached')
  assert.equal(exhausted[0].attempt, limit)
  assert.equal(exhausted[0].limit, limit)
  assert.equal(exhausted[0].cause_code, 'ENOTFOUND')
  assert.equal(exhausted[0].transport_subkind, 'transport')
  assert.ok(exhausted[0].request_id)
  const exhaustedLines = run.chat.filter(line => /I still cannot reach the model provider/.test(line))
  assert.equal(exhaustedLines.length, 1)
  assert.equal(run.chat.at(-1), exhaustedLines[0])
  assert.match(exhaustedLines[0], /after 6 automatic retries \(transport\).*did not start/)
  assert.equal(run.chat.some(line => line.startsWith('Request failed:')), false, 'no second, raw failure line')
  assert.equal(JSON.stringify([run.trace, run.chat, run.logs]).includes(FAKE_HOST), false)

  // run-check: the exhaustion is the finding, once; the earlier failures stay informational.
  const analysis = analyzeBehaviorTrace(run.trace)
  assert.deepEqual(analysis.findings.map(finding => finding.signature), ['intake_retry_exhausted'])
  assert.match(analysis.findings[0].detail, /exhausted after 6\/6 attempts.*cause ENOTFOUND/)
  await run.agent.persistState()
  assert.equal('intake_retry' in JSON.parse(await fsp.readFile(run.stateFile, 'utf8')), false)
})

test('a context-window failure at intake is not retried and keeps today\'s behaviour', async t => {
  const run = await failedAtIntake(t, { world: { failure: contextWindowFailure } })
  assert.equal(run.session.intakeRetry, null)
  assert.equal(run.memory.intakeRetry(), undefined)
  for (const name of ['scheduled', 'started', 'cancelled', 'exhausted']) assert.equal(rowsOf(run.trace, `recovery.intake_retry_${name}`).length, 0, name)
  const failed = rowsOf(run.trace, 'request.failed').at(-1)
  assert.equal(failed.data.recoverable, false)
  assert.equal('intake_retry_candidate' in failed.data, false)
  assert.equal('pause_class' in failed.data, false, 'not a transport failure')
  assert.match(failed.data.message, /provider_context_window_exceeded/)
  assert.equal(run.chat.length, 1)
  assert.match(run.chat[0], /^Request failed: provider_context_window_exceeded/)
  const analysis = analyzeBehaviorTrace(run.trace)
  assert.equal(analysis.findings.some(finding => finding.signature === 'request_failed_unrecoverable'), true)
})

test('any other failure at intake propagates as before', async t => {
  const run = await failedAtIntake(t, { world: { failure: () => Object.assign(new Error('Provider HTTP 400; request will not be retried automatically'), { http_status: 400 }) } })
  assert.equal(run.memory.intakeRetry(), undefined)
  assert.equal(rowsOf(run.trace, 'recovery.intake_retry_scheduled').length, 0)
  assert.match(run.chat[0], /^Request failed: Provider HTTP 400/)
})

test('a takeover that arrives while the retry is already running cancels its request and nothing is admitted', async t => {
  const run = await failedAtIntake(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => {
    run.state.failure = null
    const original = run.agent.provider
    run.agent.provider = async (...args) => { resolve(); await gate; return original(...args) }
  })
  const token = run.session.intakeRetry.token
  const firing = fire(run.session)
  await reached // the retry's request is inside its first planner call
  assert.equal(run.session.intakeRetry.running, true)
  run.session.cancelAutoResume('player_request')
  assert.equal(token.cancelled, true)
  assert.equal(run.session.intakeRetry, null)
  release()
  assert.equal(await firing, null, 'the cancelled retry reports nothing and is not rescheduled')
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_cancelled').at(-1).reason, 'player_request')
  assert.equal(rowsOf(run.trace, 'recovery.intake_retry_scheduled').length, 1, 'no new schedule')
  assert.equal(run.memory.intakeRetry(), undefined)
  assert.equal(run.game.mutations.length, 0, 'no operation was admitted for the superseded request')
  assert.equal(run.memory.planningState(KEY)?.plans?.length ?? 0, 0)
})

test('the durable record is sanitized: an incomplete or foreign record is dropped, a hostile cause code is not kept', () => {
  const memory = new CanonicalTaskBoardMemory()
  const whole = { sender: 'TTLouis', text: OBJECTIVE, interaction_intent: 'new_goal', request_id: 'req_1', actor_id: 18, epoch: 3, attempt: 1, transport_subkind: 'transport', cause_code: 'ENOTFOUND', next_at: 1 }
  assert.equal(memory.setIntakeRetry(whole).cause_code, 'ENOTFOUND')
  assert.equal(memory.setIntakeRetry({ ...whole, cause_code: `ENOTFOUND ${FAKE_HOST}` }).cause_code, undefined)
  for (const broken of [{ ...whole, text: '' }, { ...whole, interaction_intent: 'amend_current' }, { ...whole, actor_id: undefined }, { ...whole, attempt: 0 }, { ...whole, transport_subkind: 'nope' }]) {
    assert.equal(memory.setIntakeRetry(broken), undefined)
    assert.equal(memory.intakeRetry(), undefined)
  }
  memory.setIntakeRetry(whole)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.deepEqual(restored.intakeRetry(), memory.intakeRetry())
  assert.equal('intake_retry' in new CanonicalTaskBoardMemory().snapshot(), false)
})

test('a stop that lands during the retry own early awaits (ensureAuthorization) is not lost: no request, no goal, a cancelled row', async t => {
  const run = await failedAtIntake(t)
  run.state.failure = null
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const reached = new Promise(resolve => { entered = resolve })
  let calls = 0
  run.session.ensureAuthorization = async () => {
    if (++calls === 1) { entered(); await gate } // the retry's own RCON round trip
    return {}
  }
  const providerCalls = run.state.calls
  const receivedBefore = rowsOf(run.trace, 'request.received').length
  const firing = fire(run.session)
  await reached
  assert.equal(run.session.intakeRetry.running, true)
  run.session.queuePlayerRequest('TTLouis', 'stop') // agent.cancel is a no-op here: nothing is in flight yet
  release()
  assert.equal(await firing, null)
  await run.session.eventQueue
  assert.equal(run.state.calls, providerCalls, 'the agent was never asked to plan')
  assert.equal(rowsOf(run.trace, 'request.received').length, receivedBefore, 'agent.request was not called')
  assert.equal(run.memory.planningState(KEY)?.plans?.length ?? 0, 0)
  assert.equal(run.game.mutations.length, 0)
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_cancelled').at(-1).reason, 'player_request')
  assert.equal(rowsOf(run.trace, 'recovery.intake_retry_scheduled').length, 1, 'nothing was rescheduled')
  assert.equal(run.memory.intakeRetry(), undefined)
})

test('a stop that arrives while request A is in flight stands: the own transport failure of A schedules no retry', async t => {
  for (const takeover of ['cancel_auto_resume', 'stop_word']) {
    const world = makeWorld({ stateFile: await tempState(t), failure: null })
    const { session, chat } = sessionFor(world.agent)
    let release
    const gate = new Promise(resolve => { release = resolve })
    let entered
    const reached = new Promise(resolve => { entered = resolve })
    world.agent.provider = async () => { entered(); await gate; throw fetchFailed() } // A's first planner call, pending
    session.queuePlayerRequest('TTLouis', OBJECTIVE)
    await reached
    assert.equal(session.intakeRetry, null, 'nothing pending yet for the stop to cancel')
    if (takeover === 'stop_word') session.queuePlayerRequest('TTLouis', 'stop')
    else session.cancelAutoResume('player_request')
    release()
    await session.eventQueue
    assert.equal(session.intakeRetry, null, takeover)
    assert.equal(world.memory.intakeRetry(), undefined, takeover)
    assert.equal(rowsOf(world.trace, 'recovery.intake_retry_scheduled').length, 0, takeover)
    if (takeover === 'cancel_auto_resume') {
      assert.equal(dataOf(world.trace, 'recovery.intake_retry_cancelled').at(-1).reason, 'superseded_before_schedule')
      assert.equal(dataOf(world.trace, 'recovery.intake_retry_cancelled').at(-1).cause_code, 'ENOTFOUND')
      assert.equal(chat.some(line => /Retrying automatically/.test(line)), false)
    }
  }
})

test('exhaustion removes the plan-less goal: no restart notice, and no pending interrupted task for the next goal', async t => {
  const run = await failedAtIntake(t)
  assert.equal(run.memory.planningState(KEY).goal.status, 'active', 'the failed first attempt admitted a goal')
  for (let attempt = 1; attempt <= autoResumeMaxAttempts('transport'); attempt++) await fire(run.session)
  assert.equal(dataOf(run.trace, 'recovery.intake_retry_exhausted').length, 1)
  assert.equal(run.memory.planningState(KEY)?.goal, undefined, 'no active goal left behind')
  const [discarded] = dataOf(run.trace, 'planning.intake_goal_discarded')
  assert.equal(discarded.reason, 'intake_retry_exhausted')
  assert.ok(discarded.request_id)
  assert.ok(discarded.goal_id)
  assert.equal(run.session.startupGoalNoticeKind(), undefined, 'a restart would not announce a goal that never had a plan')

  // The next goal does not find an orphan to displace into the task ledger.
  run.state.failure = null
  run.session.queuePlayerRequest('TTLouis', 'build me a stone furnace')
  await run.session.eventQueue
  assert.equal(run.memory.planningState(KEY).task_ledger?.tasks?.length ?? 0, 0)
  assert.equal(run.memory.planningState(KEY).goal.objective, 'build me a stone furnace')
  await run.agent.persistState()
  assert.equal(JSON.parse(await fsp.readFile(run.stateFile, 'utf8')).planning_states.some(item => item.state?.goal?.objective === OBJECTIVE), false)
})
