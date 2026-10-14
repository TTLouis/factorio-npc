import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { reserveBudget } from './common.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { validateOutcomeCandidate } from './outcome-authority.mjs'
import {
  AUTO_RESUMABLE_PAUSE_CLASSES,
  classifyRequestFailure,
  isAutoResumable,
  MODEL_RECOVERABLE_RESUME_LIMITS,
  PAUSE_CLASS,
  PAUSE_CLASSES,
  pauseClassLabel,
  pauseClassOf,
  TRANSPORT_SUBKINDS,
} from './pause-class.mjs'
import {
  applyPlanningEvent,
  autoResumeAllowance,
  createEmptyPlanningState,
  getActivePlan,
  PLAN_STATUS,
  PLANNING_EVENT,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { executeUiControl, pauseStrandedPlanAfterRequestError, Session, transientProviderFailure } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
// The exact failure run E ended on (fixtures/run-check/luna-run-e-action-omission-pause.jsonl).
const RUN_E_FAILURE = 'provider_action_omission_repair_failed: bounded act-or-block repair returned no executable operation and no explicit BLOCKED: reason'

// --- the registry -------------------------------------------------------------------------------------------------------

test('pause classes are a closed set and only transport and model_recoverable can auto-resume', () => {
  assert.deepEqual([...PAUSE_CLASSES].sort(), ['authority', 'guard', 'model_recoverable', 'operator', 'system', 'transport'])
  assert.deepEqual([...AUTO_RESUMABLE_PAUSE_CLASSES].sort(), ['model_recoverable', 'transport'])
  for (const pauseClass of PAUSE_CLASSES) assert.equal(isAutoResumable(pauseClass), ['transport', 'model_recoverable'].includes(pauseClass), pauseClass)
  assert.deepEqual([...TRANSPORT_SUBKINDS].sort(), ['budget', 'rate_limited', 'server_error', 'timeout', 'transport'])
  // owner-delegated 2026-10-13
  assert.deepEqual({ ...MODEL_RECOVERABLE_RESUME_LIMITS }, { per_step: 2, per_goal: 6 })
})

test('request failures are classified from structured fields first, the loop failure codes second, legacy text last', () => {
  const structured = Object.assign(new Error('Provider HTTP 429; request will not be retried automatically'), { http_status: 429 })
  assert.deepEqual(classifyRequestFailure(structured), { pause_class: 'transport', pause_subkind: 'rate_limited', code: 'provider_transient', source: 'structured' })
  // The status wins over a message that says nothing: no regex is needed when the provider layer declared the cause.
  assert.equal(classifyRequestFailure(Object.assign(new Error('upstream'), { http_status: 503 })).pause_subkind, 'server_error')
  assert.equal(classifyRequestFailure(Object.assign(new Error('x'), { transport_subkind: 'timeout' })).pause_subkind, 'timeout')
  assert.equal(classifyRequestFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })).source, 'structured')
  // A 400 is not a transport condition: waiting does not fix it.
  const badRequest = classifyRequestFailure(Object.assign(new Error('Provider HTTP 400; request will not be retried automatically'), { http_status: 400 }))
  assert.equal(badRequest.pause_class, 'guard')
  // The loop's own codes.
  const omission = classifyRequestFailure(new Error(RUN_E_FAILURE))
  assert.deepEqual(omission, { pause_class: 'model_recoverable', pause_subkind: '', code: 'provider_action_omission_repair_failed', source: 'failure_code' })
  assert.equal(classifyRequestFailure('provider_output_budget_exhausted: provider response exhausted its output budget').pause_class, 'model_recoverable')
  assert.equal(classifyRequestFailure('request_output_ceiling: 10 > 5 output units').pause_class, 'guard')
  // Legacy text: an error that was re-wrapped into a plain message before it reached the classifier.
  assert.deepEqual(classifyRequestFailure('Provider response recovery exhausted after 3 attempts: Provider HTTP 503; request will not be retried automatically'),
    { pause_class: 'transport', pause_subkind: 'server_error', code: 'provider_transient', source: 'legacy_text' })
  assert.equal(classifyRequestFailure('Provider response recovery exhausted after 3 attempts: invalid JSON').pause_class, 'model_recoverable')
  // Declared at the raise site wins over the code table.
  assert.equal(classifyRequestFailure(Object.assign(new Error(RUN_E_FAILURE), { pause_class: 'authority' })).pause_class, 'authority')
  // Anything unplaceable fails closed.
  assert.deepEqual(classifyRequestFailure(new Error('executor_stale_step: choose new operations')), { pause_class: 'guard', pause_subkind: '', code: 'request_failed', source: 'fallback' })
  // transientProviderFailure is the same decision, kept for callers that only have text.
  assert.equal(transientProviderFailure('Provider timed out after 120000 ms'), 'timeout')
  assert.equal(transientProviderFailure(structured), 'rate_limited')
  assert.equal(transientProviderFailure(RUN_E_FAILURE), undefined)
})

test('a missing or unknown pause class reads as unclassified and never as an auto-resumable class', () => {
  for (const record of [undefined, {}, { pause_class: '' }, { pause_class: 'transprt' }, { pause_class: 7 }]) {
    assert.deepEqual(pauseClassOf(record), { pause_class: 'guard', pause_subkind: '', classified: false })
    assert.equal(pauseClassLabel(record), 'unclassified')
  }
  assert.equal(pauseClassLabel({ pause_class: 'operator' }), 'operator')
  assert.equal(pauseClassOf({ pause_class: 'transport', pause_subkind: 'bogus' }).pause_subkind, '')
})

test('the hourly request budget error carries its transport subkind where it is raised', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-pause-class-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const file = path.join(dir, 'provider-budget.json')
  await reserveBudget(file, 1, 1000)
  const failure = await reserveBudget(file, 1, 2000).then(() => undefined, error => error)
  assert.match(failure.message, /Hourly provider request budget reached/)
  assert.equal(failure.transport_subkind, 'budget')
  assert.equal(classifyRequestFailure(failure).source, 'structured')
})

test('outcome authority declares the class of the pauses it creates', () => {
  const idle = { task_state: 'idle', queue_length: 0 }
  const model = validateOutcomeCandidate({ kind: 'recoverable_provider_failure', source: 'x', reason_code: 'provider_budget' }, { world: idle })
  assert.equal(model.pause_class, 'model_recoverable')
  assert.equal(validateOutcomeCandidate({ kind: 'recoverable_provider_failure', source: 'x', reason_code: 'provider_safety' }, { world: idle }).pause_class, 'guard')
  const declared = validateOutcomeCandidate({ kind: 'cancelled', source: 'server_lifecycle', reason_code: 'user_stop', metadata: { server_authoritative: true, transition: 'paused', pause_reason: 'user_stop', pause_class: 'operator' } })
  assert.equal(declared.pause_class, 'operator')
  const undeclared = validateOutcomeCandidate({ kind: 'cancelled', source: 'server_lifecycle', reason_code: 'user_stop', metadata: { server_authoritative: true, transition: 'paused', pause_reason: 'user_stop' } })
  assert.equal(undeclared.accepted, true)
  assert.equal(undeclared.pause_class, undefined, 'an undeclared pause stays undeclared so it is reported')
})

// --- the durable reducer state ------------------------------------------------------------------------------------------

const GROUNDED_CONTRACT = {
  mode: 'all',
  requirements: [{ id: 'req_stone', kind: 'inventory_count', item_name: 'stone', minimum: 10 }],
  confidence: 0.9,
}

function committedPlan(stepCount = 4, goalId = 'goal_resume') {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: goalId, owner: 'louis', objective: 'Make iron plates' })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    steps: Array.from({ length: stepCount }, (_, index) => ({ description: `Step ${index + 1}`, completion_contract: GROUNDED_CONTRACT })),
  })
  return applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 30, runtime_validation: { passed: true } })
}

let clock = 1000
const tick = () => ++clock

function pause(state, pauseClass = PAUSE_CLASS.MODEL_RECOVERABLE) {
  return applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: RUN_E_FAILURE, pause_class: pauseClass })
}

function attempt(state, overrides = {}) {
  const allowance = autoResumeAllowance(state)
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.RUN_AUTO_RESUME_STARTED,
    now: tick(),
    source: 'runtime',
    goal_id: allowance.goal_id,
    plan_id: allowance.plan_id,
    plan_version: allowance.plan_version,
    step_id: allowance.step_id,
    ...overrides,
  })
}

function receipt(state, kind, ref) {
  return applyPlanningEvent(state, { type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED, now: tick(), source: 'runtime', goal_id: 'goal_resume', kind, ref, summary: '{}' })
}

function completeActiveStep(state) {
  const plan = getActivePlan(state)
  const stepId = plan.steps[plan.active_step_index].step_id
  const evidenced = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: tick(),
    plan_id: plan.plan_id,
    step_id: stepId,
    evidence: { source: 'runtime', kind: 'deterministic_verification', ref: `done_${stepId}`, batch_id: 7, satisfied_requirement_ids: ['req_stone'] },
  })
  return applyPlanningEvent(evidenced, { type: PLANNING_EVENT.STEP_COMPLETED, now: tick(), source: 'runtime', plan_id: plan.plan_id, step_id: stepId })
}

test('RUN_PAUSED records the declared class; a resume clears it; an unknown class is dropped', () => {
  const paused = pause(committedPlan())
  assert.equal(paused.run.pause_class, 'model_recoverable')
  assert.equal(applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_RESUMED, now: tick(), source: 'runtime' }).run.pause_class, '')
  const transport = applyPlanningEvent(committedPlan(), { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'provider_transient: x', pause_class: 'transport', pause_subkind: 'timeout' })
  assert.deepEqual([transport.run.pause_class, transport.run.pause_subkind], ['transport', 'timeout'])
  const unknown = applyPlanningEvent(committedPlan(), { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'x', pause_class: 'whatever' })
  assert.equal(unknown.run.paused, true)
  assert.equal(unknown.run.pause_class, '')
})

test('automatic resume attempts are counted per step identity and survive a serialize and restore (a restart)', () => {
  let state = pause(committedPlan())
  assert.deepEqual([autoResumeAllowance(state).step_attempts, autoResumeAllowance(state).goal_attempts], [0, 0])
  state = attempt(state)
  const before = autoResumeAllowance(state)
  assert.deepEqual([before.step_attempts, before.goal_attempts, before.limit_kind], [1, 1, undefined])

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  const after = autoResumeAllowance(restored)
  assert.deepEqual([after.step_attempts, after.goal_attempts, after.step_key], [1, 1, before.step_key])
  assert.equal(restored.run.paused, true)
  assert.equal(restored.run.pause_class, 'model_recoverable', 'the class is durable too')
  // A resume does not erase the count: the next pause for the same step continues from it.
  const resumed = applyPlanningEvent(restored, { type: PLANNING_EVENT.RUN_RESUMED, now: tick(), source: 'runtime' })
  assert.equal(autoResumeAllowance(resumed).step_attempts, 1)
})

test('verified batch receipts reset the step count; an unverified receipt and an admission do not', () => {
  let state = pause(committedPlan())
  state = attempt(attempt(state))
  assert.equal(autoResumeAllowance(state).limit_kind, 'step')
  // An operation_receipt is a batch the game finished, not an effect the harness verified; neither is an admission.
  state = receipt(state, 'operation_receipt', 'batch_5')
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: tick(), source: 'runtime', goal_id: 'goal_resume' })
  assert.equal(autoResumeAllowance(state).step_attempts, 2)
  assert.equal(autoResumeAllowance(state).limit_kind, 'step')
  // A receipt whose effect was verified is progress.
  state = receipt(state, 'deterministic_verification', 'batch_6')
  const reset = autoResumeAllowance(state)
  assert.deepEqual([reset.step_attempts, reset.progressed, reset.limit_kind], [0, true, undefined])
  assert.equal(reset.goal_attempts, 2, 'progress never resets the goal count')
  const next = autoResumeAllowance(attempt(state))
  assert.deepEqual([next.step_attempts, next.goal_attempts], [1, 3])
})

test('a stale or non-model_recoverable attempt is refused by the reducer', () => {
  const paused = pause(committedPlan())
  const allowance = autoResumeAllowance(paused)
  for (const overrides of [
    { goal_id: 'goal_other' },
    { plan_id: 'plan_other' },
    { plan_version: allowance.plan_version + 1 },
    { step_id: 'step_other' },
    { source: 'main_planner' },
  ]) assert.equal(attempt(paused, overrides), paused, JSON.stringify(overrides))
  assert.equal(attempt(pause(committedPlan(), PAUSE_CLASS.OPERATOR)).run.auto_resume, null, 'an operator pause is never counted as an automatic resume')
  const running = committedPlan()
  assert.equal(attempt(running), running, 'a run that is not paused is not resumed')
})

test('the goal limit is hit across several steps even though each step stays under its own limit', () => {
  let state = pause(committedPlan(5))
  const seen = []
  for (let step = 0; step < 4; step++) {
    // One attempt on this step (under the per-step limit of 2), then the step verifies and the identity moves on.
    state = attempt(state)
    const allowance = autoResumeAllowance(state)
    seen.push([allowance.step_attempts, allowance.goal_attempts, allowance.limit_kind])
    state = completeActiveStep(state)
  }
  // Two attempts on the next step bring the goal to 6.
  state = attempt(state)
  state = attempt(state)
  const last = autoResumeAllowance(state)
  assert.deepEqual(seen, [[1, 1, undefined], [1, 2, undefined], [1, 3, undefined], [1, 4, undefined]])
  assert.equal(last.goal_attempts, 6)
  assert.equal(last.limit_kind, 'goal')
  // A fresh step has no attempts of its own, but the goal is exhausted.
  state = receipt(state, 'deterministic_verification', 'batch_9')
  assert.equal(autoResumeAllowance(state).step_attempts, 0)
  assert.equal(autoResumeAllowance(state).limit_kind, 'goal')
})

test('the step limit is reached without progress; a new goal starts from zero', () => {
  let state = pause(committedPlan())
  state = attempt(attempt(state))
  assert.equal(autoResumeAllowance(state).limit_kind, 'step')
  // A new goal (new goal_id) never inherits the old goal's counts.
  let other = applyPlanningEvent(state, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: tick(), goal_id: 'goal_next', owner: 'louis', objective: 'Make copper plates' })
  other = applyPlanningEvent(other, { type: PLANNING_EVENT.DRAFT_CREATED, now: tick(), steps: [{ description: 'Mine copper', completion_contract: GROUNDED_CONTRACT }] })
  other = applyPlanningEvent(other, { type: PLANNING_EVENT.PLAN_COMMITTED, now: tick(), runtime_validation: { passed: true } })
  const fresh = autoResumeAllowance(other)
  assert.deepEqual([fresh.goal_id, fresh.step_attempts, fresh.goal_attempts, fresh.limit_kind], ['goal_next', 0, 0, undefined])
})

// --- the supervisor on a real agent (run E) -----------------------------------------------------------------------------

function sessionFor(agent, { actor_id: actorId = 18, epoch = 3, realQueue = false } = {}) {
  const chat = []
  const logs = []
  const queued = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent,
    npcId: 'sgluna',
    stopping: false,
    autoResume: null,
    modelResume: null,
    lastPauseDecision: '',
    lastStatus: { actor_id: actorId, epoch },
    liveStatus: { actor_id: actorId, epoch },
    log: message => logs.push(message),
    printChat: async (message) => { chat.push(message) },
    queueEvent: (fn) => { queued.push(fn); return Promise.resolve() },
    eventQueue: Promise.resolve(),
    rawStatus: async () => ({ ...session.liveStatus }),
    syncTaskBoardUi: async () => {},
    ensureAuthorization: async () => ({}),
    rcon: { command: async () => '' },
    npcName: 'SGLuna',
  })
  // The real queue keeps the ordering the supervisor relies on (one event at a time, in order).
  if (realQueue) delete session.queueEvent
  return { session, chat, logs, queued }
}

// The delegation harness of executor-wiring.test.mjs: the real loop, a committed two-step plan, a fresh executor per step.
const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const TWO_STEPS = ['Gather 10 iron ore', 'Gather 10 copper ore']
const plannerSlice = () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: GOAL, roadmap: SHELF })
// mode 'fail' is run E: the executor answers step 2 with a plan and no operation, again and again, until the repair is exhausted.
const executorStep = mode => planReply({ plan: TWO_STEPS, currentStep: 1, operations: mode === 'fail' ? [] : [gather('copper-ore', 10)] })

function makeWorld({ game = new FakeFactorio(), stateFile = null, mode = 'fail' } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const trace = []
  const state = { mode }
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (_messages, context) => (context?.role === 'executor' ? executorStep(state.mode) : plannerSlice()),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'pause class auto resume',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  return { game, memory, agent, events: trace, trace, state }
}

// Run E's shape: step 1 verifies, the executor takes step 2 and never produces an operation.
async function runEScenario({ stateFile, mode }) {
  const world = makeWorld({ stateFile, mode })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.game.inventory['iron-ore'] = 10
  const failure = await world.agent.completed().then(() => undefined, error => error)
  return { ...world, failure }
}

const recoveryRows = (events, name) => events.filter(row => row.event === name).map(row => row.data)

async function scheduledRunE(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-pause-class-resume-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const stateFile = path.join(dir, 'npc-state.json')
  const scenario = await runEScenario({ stateFile, ...options })
  assert.match(scenario.failure?.message ?? '', /provider_action_omission_repair_failed/)
  const harness = sessionFor(scenario.agent, { realQueue: options.realQueue })
  const paused = await pauseStrandedPlanAfterRequestError(harness.session, scenario.failure)
  t.after(() => { if (harness.session.modelResume?.timer) clearTimeout(harness.session.modelResume.timer) })
  return { ...scenario, ...harness, paused, stateFile, dir }
}

test("run E's action-omission pause is declared model_recoverable, scheduled, and the attempt restages a fresh context", async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  assert.equal(run.paused?.status, 'paused')
  // (The base loop may wrap a provider failure as provider_recovery_exhausted; both are model_recoverable codes.)
  assert.match(run.paused.pause_reason, /^(provider_action_omission_repair_failed|provider_recovery_exhausted): /)
  const record = run.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['model_recoverable', ''])

  assert.equal(await run.session.considerPauseForAutoResume(), true)
  const [scheduled] = recoveryRows(run.events, 'recovery.auto_resume_scheduled')
  assert.equal(scheduled.pause_class, 'model_recoverable')
  assert.equal(scheduled.attempt, 1)
  assert.equal(scheduled.limit, 2)
  assert.equal(scheduled.goal_limit, 6)
  assert.equal(scheduled.delay_ms, 15_000)
  assert.equal(scheduled.goal_id, run.paused.goal_id)
  assert.equal(scheduled.actor_id, 18)
  assert.equal(scheduled.actor_epoch, 3)
  assert.match(run.chat.at(-1), /Resuming automatically in 15 s with a fresh context \(attempt 1\/2 for this step, 1\/6 for this goal\)/)
  // Scheduling again for the same pause is a no-op (goal.paused can fire more than once).
  assert.equal(await run.session.considerPauseForAutoResume(), null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').length, 1)

  // The timer fires: the provider is healthy again and the resume goes through interrupted-plan recovery.
  clearTimeout(run.session.modelResume.timer)
  const correlation = run.session.modelResume.correlation
  run.state.mode = 'ok'
  const planBefore = run.memory.currentPlan(KEY)
  await run.session.runModelRecoverableResume(correlation, 1)

  const [started] = recoveryRows(run.events, 'recovery.auto_resume_started')
  assert.equal(started.attempt, 1)
  assert.equal(started.step_attempt, 1)
  assert.equal(started.goal_attempt, 1)
  assert.match(started.request_id, /^recovery_/)
  const restage = run.events.find(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7')
  assert.ok(restage, 'the attempt rebuilt the conversation from a handoff packet')
  assert.match(restage.data.reason, /^recovery:auto_resume_after_model_recoverable_pause/)
  assert.equal(restage.data.role, 'executor', 'a committed plan is carried by a fresh executor, not the old conversation')
  assert.equal(restage.request_id, started.request_id, 'the restage belongs to the recovery request the started row names')
  const planAfter = run.memory.currentPlan(KEY)
  assert.equal(planAfter.goal_id, planBefore.goal_id, 'the goal is preserved')
  assert.notEqual(planAfter.status, 'paused')
  assert.equal(run.game.mutations.length, 2, 'the committed step was acted on without a human')
  assert.deepEqual(run.memory.planningState(KEY).plans.map(plan => [plan.plan_id, plan.plan_version]),
    [[correlation.plan_id, correlation.plan_version]], 'no plan was created or replaced')
  // run-check reads the same rows: the pause was followed by a scheduling decision, so nothing is flagged.
  const flagged = analyzeBehaviorTrace(run.trace).findings.map(finding => finding.signature)
  assert.equal(flagged.includes('model_recoverable_pause_not_resumed'), false)
  assert.equal(flagged.includes('auto_resume_exhausted'), false)
})

test('a restart mid-backoff keeps the persisted attempt count', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  // Attempt 1 starts and fails again (the model still produces no action): the pause is renewed and attempt 2 is scheduled.
  await run.session.runModelRecoverableResume(run.session.modelResume.correlation, 1)
  const scheduled = recoveryRows(run.events, 'recovery.auto_resume_scheduled')
  assert.deepEqual(scheduled.map(row => row.attempt), [1, 2])
  assert.equal(run.memory.autoResumeAllowance(KEY).step_attempts, 1)
  clearTimeout(run.session.modelResume.timer)

  // Restart mid-backoff: a new process loads the same state file. The in-memory timer is gone, the count is not.
  const world = makeWorld({ stateFile: run.stateFile, mode: 'fail' })
  const { agent: restarted, events } = world
  await restarted.loadPersistentState()
  assert.equal(restarted.memory.autoResumeAllowance(KEY).step_attempts, 1, 'the count came back from disk')
  assert.equal(restarted.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
  const second = sessionFor(restarted)
  t.after(() => { if (second.session.modelResume?.timer) clearTimeout(second.session.modelResume.timer) })
  assert.equal(await second.session.considerPauseForAutoResume(), true)
  assert.deepEqual(recoveryRows(events, 'recovery.auto_resume_scheduled').map(row => [row.attempt, row.goal_attempt]), [[2, 2]],
    'attempt 2 of 2, not a fresh attempt 1')
})

test('the limit is reached: the plan stays paused, one exhausted event names the limit, and nothing is scheduled', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  for (const attemptNumber of [1, 2]) {
    clearTimeout(run.session.modelResume.timer)
    await run.session.runModelRecoverableResume(run.session.modelResume.correlation, attemptNumber)
  }
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.session.modelResume, null, 'no third attempt is scheduled')
  const [exhausted, ...extra] = recoveryRows(run.events, 'recovery.auto_resume_exhausted')
  assert.equal(extra.length, 0)
  assert.equal(exhausted.limit_kind, 'step')
  assert.equal(exhausted.step_attempts, 2)
  assert.equal(exhausted.step_limit, 2)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 2)
  assert.match(run.chat.at(-1), /automatic restarts on this step without verified progress.*say continue/)
  // Another goal.paused for the same pause does not repeat the report.
  assert.equal(await run.session.considerPauseForAutoResume(), null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_exhausted').length, 1)
})

test('verified progress between attempts resets the step count, so the plan is resumed again', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  for (const attemptNumber of [1, 2]) {
    clearTimeout(run.session.modelResume.timer)
    await run.session.runModelRecoverableResume(run.session.modelResume.correlation, attemptNumber)
  }
  assert.equal(run.memory.autoResumeAllowance(KEY).limit_kind, 'step')
  // A batch whose effect the harness verified lands in the step's receipt ledger.
  run.memory.recordBoardEvidence(KEY, { kind: 'deterministic_verification', ref: 'batch_8', summary: JSON.stringify({ verdict: 'verified_complete' }) })
  assert.equal(run.memory.autoResumeAllowance(KEY).step_attempts, 0)
  run.session.lastPauseDecision = ''
  assert.equal(await run.session.considerPauseForAutoResume(), true)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').at(-1).attempt, 1)
  clearTimeout(run.session.modelResume.timer)
})

test('the goal limit stops automatic resume after several verified steps, and says which limit', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  const key = KEY
  // Burn the goal allowance across progress resets: each cycle is one attempt, then verified progress.
  for (let cycle = 0; cycle < 6; cycle++) {
    const allowance = run.memory.autoResumeAllowance(key)
    run.memory.recordAutoResumeStarted(key, allowance)
    run.memory.recordBoardEvidence(key, { kind: 'deterministic_verification', ref: `batch_${20 + cycle}`, summary: '{}' })
  }
  const allowance = run.memory.autoResumeAllowance(key)
  assert.deepEqual([allowance.goal_attempts, allowance.step_attempts, allowance.limit_kind], [6, 0, 'goal'])
  assert.equal(await run.session.considerPauseForAutoResume(), false)
  const [exhausted] = recoveryRows(run.events, 'recovery.auto_resume_exhausted')
  assert.equal(exhausted.limit_kind, 'goal')
  assert.equal(exhausted.goal_attempts, 6)
  assert.equal(exhausted.goal_limit, 6)
  assert.match(run.chat.at(-1), /6 automatic restarts for this goal/)
  assert.equal(run.session.modelResume, null)
})

test('a stale actor, epoch, goal, step or pause cancels the scheduled resume with a trace event and no attempt', async t => {
  const reasons = {
    actor_changed: run => { run.session.liveStatus = { actor_id: 99, epoch: 3 } },
    epoch_changed: run => { run.session.liveStatus = { actor_id: 18, epoch: 4 } },
    no_longer_paused: run => { const state = run.memory.currentPlan(KEY); run.memory.recordRunResume(KEY, state, 'player_continue') },
    pause_class_changed: async run => { await run.agent.pausePersistentPlan('user_stop', { pause_class: PAUSE_CLASS.OPERATOR }) },
  }
  for (const [reason, mutate] of Object.entries(reasons)) {
    const run = await scheduledRunE(t, { mode: 'fail' })
    await run.session.considerPauseForAutoResume()
    const { correlation } = run.session.modelResume
    clearTimeout(run.session.modelResume.timer)
    await mutate(run)
    const before = run.memory.autoResumeAllowance(KEY)
    await run.session.runModelRecoverableResume(correlation, 1)
    const cancelled = recoveryRows(run.events, 'recovery.auto_resume_cancelled')
    assert.equal(cancelled.at(-1)?.reason, reason, reason)
    assert.equal(cancelled.at(-1).goal_id, correlation.goal_id)
    assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0, `${reason}: no attempt started`)
    assert.equal(run.memory.autoResumeAllowance(KEY).goal_attempts, before.goal_attempts, `${reason}: no attempt counted`)
    assert.equal(run.game.mutations.length, 1, `${reason}: nothing was sent to the game`)
  }
})

test('a changed goal or step identity cancels the resume', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  const stale = { ...run.session.modelResume.correlation }
  await run.session.runModelRecoverableResume({ ...stale, goal_id: 'goal_old' }, 1)
  await run.session.runModelRecoverableResume({ ...stale, step_id: 'step_old' }, 1)
  await run.session.runModelRecoverableResume({ ...stale, plan_version: stale.plan_version + 1 }, 1)
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_cancelled').map(row => row.reason), ['goal_changed', 'step_changed', 'plan_changed'])
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0)
})

test('a player request or a stop cancels the pending resume', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  assert.ok(run.session.modelResume.timer)
  assert.equal(run.session.cancelAutoResume('player_request'), true)
  assert.equal(run.session.modelResume, null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_cancelled').at(-1).reason, 'player_request')
  assert.equal(run.session.cancelAutoResume('player_request'), false, 'nothing pending: nothing to report')
})

async function startedAgent() {
  const world = makeWorld({ mode: 'ok' })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  return { agent: world.agent, events: world.events }
}

test('authority, operator, system and guard pauses never schedule an automatic resume', async t => {
  for (const pauseClass of [PAUSE_CLASS.AUTHORITY, PAUSE_CLASS.OPERATOR, PAUSE_CLASS.SYSTEM, PAUSE_CLASS.GUARD]) {
    const { agent, events } = await startedAgent()
    const { session } = sessionFor(agent)
    t.after(() => { if (session.modelResume?.timer) clearTimeout(session.modelResume.timer) })
    await agent.pausePersistentPlan(`declared_${pauseClass}`, { pause_class: pauseClass })
    assert.equal(agent.memory.pauseRecord(KEY).pause_class, pauseClass)
    assert.equal(await session.considerPauseForAutoResume(), null, pauseClass)
    assert.equal(session.modelResume, null, pauseClass)
    assert.equal(events.filter(row => row.event.startsWith('recovery.')).length, 0, `${pauseClass}: no recovery event`)
    assert.equal(agent.memory.currentPlan(KEY).status, 'paused')
  }
})

test('a pause that declared no class is reported as unclassified and is not resumed', async t => {
  const { agent, events } = await startedAgent()
  const { session } = sessionFor(agent)
  t.after(() => { if (session.modelResume?.timer) clearTimeout(session.modelResume.timer) })
  agent.traceRequest = null // the request has ended: pausePersistentPlan names the pause itself
  await agent.pausePersistentPlan('some_new_pause_path')
  assert.equal(agent.memory.pauseRecord(KEY).pause_class, '')
  assert.equal(await session.considerPauseForAutoResume(), null)
  const [row] = recoveryRows(events, 'recovery.pause_unclassified')
  assert.equal(row.reason, 'pause_created_without_declared_class')
  assert.equal(row.pause_reason, 'some_new_pause_path')
  assert.equal(row.auto_resume, 'none')
  assert.equal(session.modelResume, null)
  // Reported once per pause, not on every goal.paused row.
  await session.considerPauseForAutoResume()
  assert.equal(recoveryRows(events, 'recovery.pause_unclassified').length, 1)
  // The goal.paused trace row names the same fact for run-check.
  assert.equal(recoveryRows(events, 'goal.paused').at(-1).pause_class, 'unclassified')
})

test('every goal.paused row carries the pause class, and the supervisor reacts to it', async () => {
  const { agent, events } = await startedAgent()
  agent.traceRequest = null // the request has ended: pausePersistentPlan names the pause itself
  await agent.pausePersistentPlan('user_stop', { pause_class: PAUSE_CLASS.OPERATOR })
  assert.equal(recoveryRows(events, 'goal.paused').at(-1).pause_class, 'operator')

  const { session, queued } = sessionFor(agent)
  session.agentLive = {}
  try { session.onAgentActivity('goal.paused', {}) }
  catch { /* the stub has no UI wiring; only the queued decision matters here */ }
  assert.equal(queued.length >= 1, true, 'a pause queues the auto-resume decision')
})

test('transport pauses keep today\'s in-memory backoff: declared transport, same delays, no model_recoverable scheduling', async t => {
  const { agent, events } = await startedAgent()
  const { session, chat } = sessionFor(agent)
  const failure = Object.assign(new Error('Provider timed out after 120000 ms'), { transport_subkind: 'timeout' })
  const paused = await pauseStrandedPlanAfterRequestError(session, failure)
  assert.match(paused.pause_reason, /^provider_transient: /)
  const record = agent.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['transport', 'timeout'])
  // The model_recoverable engine leaves transport alone ...
  assert.equal(await session.considerPauseForAutoResume(), null)
  assert.equal(events.filter(row => row.event.startsWith('recovery.auto_resume')).length, 0)
  // ... and the existing scheduler does exactly what it did.
  t.after(() => session.clearAutoResume())
  assert.equal(await session.scheduleAutoResume(failure.message), true)
  assert.equal(session.autoResume.kind, 'timeout')
  assert.match(chat.at(-1), /Resuming automatically in 30 s \(attempt 1\/6\)/)
})

test('a user pause over a transport or model_recoverable pause re-pauses as operator and cancels the timer', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  assert.ok(run.session.modelResume.timer)
  run.session.currentPlanState = () => run.memory.currentPlan(KEY)
  run.session.rcon = { command: async () => '' }
  run.session.ensureAuthorization = async () => ({})
  await executeUiControl(run.session, { action: 'pause', player_index: 1 }).catch(() => {})
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'operator')
  assert.equal(run.session.modelResume, null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_cancelled').at(-1).reason, 'operator_pause')
})

test('a BLOCKED plan is a structural stop: it is never auto-resumed, whatever its pause class says', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  run.session.currentPlanState = () => ({ ...run.memory.currentPlan(KEY), status: 'blocked' })
  assert.equal(await run.session.considerPauseForAutoResume(), null)
  assert.equal(run.session.modelResume, null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').length, 0)
})

// --- review fixes -------------------------------------------------------------------------------------------------------

function gate() {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

test('a stop that arrives while a fired resume awaits the actor status cancels it: no attempt is counted and no recovery request runs', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  await run.session.considerPauseForAutoResume()
  const { token, timer } = run.session.modelResume
  clearTimeout(timer)
  const status = gate()
  run.session.rawStatus = async () => { await status.promise; return { actor_id: 18, epoch: 3 } }
  const before = run.memory.autoResumeAllowance(KEY)
  const recoveryRowsBefore = run.trace.filter(row => row.event.startsWith('runtime.recovery_')).length

  // The timer fires: the job is queued and parks on rawStatus.
  run.session.fireModelResume(token)
  await new Promise(resolve => setImmediate(resolve))
  // The player says stop. The cancel is marked synchronously, before the queued operator pause can run behind the job.
  assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
  assert.equal(token.cancelled, true, 'the token was invalidated synchronously')
  assert.equal(run.session.modelResume, null)
  status.open()
  await run.session.eventQueue

  const cancelled = recoveryRows(run.events, 'recovery.auto_resume_cancelled').map(row => row.reason)
  assert.deepEqual(cancelled.sort(), ['cancelled_after_fire', 'player_request'])
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0)
  assert.equal(run.trace.filter(row => row.event.startsWith('runtime.recovery_')).length, recoveryRowsBefore, 'no recovery request ran')
  assert.equal(run.memory.autoResumeAllowance(KEY).goal_attempts, before.goal_attempts, 'no attempt was counted')
  assert.equal(run.game.mutations.length, 1)
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'operator', 'the stop stands')
})

test('a cancel after the attempt was counted but before recovery runs still aborts the recovery', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  run.state.mode = 'ok' // the provider is healthy again: only the cancel can stop this attempt
  await run.session.considerPauseForAutoResume()
  const { token, timer, correlation } = run.session.modelResume
  clearTimeout(timer)
  const persisted = gate()
  const persist = run.agent.persistState.bind(run.agent)
  run.agent.persistState = async () => { await persisted.promise; return persist() }
  const job = run.session.runModelRecoverableResume(correlation, 1, token)
  await new Promise(resolve => setImmediate(resolve))
  run.session.cancelAutoResume('ui_pause')
  persisted.open()
  await job
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0)
  assert.equal(run.game.mutations.length, 1, 'recovery never ran')
  assert.ok(recoveryRows(run.events, 'recovery.auto_resume_cancelled').some(row => row.reason === 'cancelled_after_fire'))
})

test('a player request or a UI pause marks the cancel synchronously, before its queued work', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  await run.session.considerPauseForAutoResume()
  const first = run.session.modelResume.token
  run.session.queuePlayerRequest('TTLouis', 'what are you doing')
  assert.equal(first.cancelled, true)
  assert.equal(first.reason, 'player_request')
  await run.session.eventQueue.catch(() => {})
  run.session.lastPauseDecision = ''
  await run.session.considerPauseForAutoResume()
  const second = run.session.modelResume.token
  run.session.queueUiControl({ action: 'pause', player_index: 1 })
  assert.equal(second.cancelled, true)
  assert.equal(second.reason, 'ui_pause')
  await run.session.eventQueue.catch(() => {})
})

test('model_recoverable is an allowlist of outcome reasons: unknown and retry-exhausted reasons are guard pauses', () => {
  const idle = { task_state: 'idle', queue_length: 0 }
  const classOf = reasonCode => validateOutcomeCandidate({ kind: 'recoverable_provider_failure', source: 'x', reason_code: reasonCode }, { world: idle }).pause_class
  for (const reason of ['provider_budget', 'provider_format']) assert.equal(classOf(reason), 'model_recoverable', reason)
  for (const reason of ['requires_machine_retry_exhausted', 'research_preflight_retry_exhausted', 'provider_safety', 'a_reason_added_next_week', 'jev_invented_class']) {
    assert.equal(classOf(reason), 'guard', reason)
  }
})

test('context-window and output-budget failures are never transport, whatever status or code accompanies them', () => {
  for (const failure of [
    Object.assign(new Error('provider_context_window_exceeded: Provider HTTP 429 reported context/input token limit exhaustion'), { http_status: 429 }),
    Object.assign(new Error('x'), { http_status: 500, code: 'provider_context_window_exceeded' }),
    Object.assign(new Error('x'), { http_status: 503, failureClass: 'provider_budget' }),
    Object.assign(new Error('provider_output_budget_exhausted: finish=length'), { http_status: 502, transport_subkind: 'server_error' }),
  ]) {
    assert.equal(transientProviderFailure(failure), undefined, failure.message)
  }
  assert.equal(classifyRequestFailure(Object.assign(new Error('provider_context_window_exceeded: Provider HTTP 429'), { http_status: 429 })).pause_class, 'model_recoverable')
})

test('a resume is never scheduled without an actor and epoch, and an unreadable status at fire time cancels it', async t => {
  const missing = await scheduledRunE(t, { mode: 'fail' })
  missing.session.lastStatus = { actor_id: 18 }
  assert.equal(await missing.session.considerPauseForAutoResume(), false)
  assert.equal(missing.session.modelResume, null)
  assert.equal(recoveryRows(missing.events, 'recovery.auto_resume_cancelled').at(-1).reason, 'actor_unknown')
  assert.equal(recoveryRows(missing.events, 'recovery.auto_resume_scheduled').length, 0)

  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  const { correlation, timer } = run.session.modelResume
  clearTimeout(timer)
  run.session.rawStatus = async () => { throw new Error('RCON is not connected') }
  await run.session.runModelRecoverableResume(correlation, 1)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_cancelled').at(-1).reason, 'status_unreadable')
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0)
})

function blockPlan(run) {
  const plan = getActivePlan(run.memory.planningState(KEY))
  run.memory.dispatchPlanningEvent(KEY, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, source: 'runtime', now: Date.now(), plan_id: plan.plan_id, reason_code: 'missing_dependency', evidence_refs: ['ref_a'], detail: 'no route',
  })
}

test('a plan the reducer holds BLOCKED is never scheduled or fired, with a real blocked-plus-paused state', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  blockPlan(run)
  assert.equal(getActivePlan(run.memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)
  assert.equal(run.memory.pauseRecord(KEY).paused, true)
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'model_recoverable', 'the pause class alone would have scheduled a resume')
  assert.equal(await run.session.considerPauseForAutoResume(), null)
  assert.equal(run.session.modelResume, null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').length, 0)

  // A resume scheduled before the block is cancelled at fire time.
  const other = await scheduledRunE(t, { mode: 'fail' })
  await other.session.considerPauseForAutoResume()
  const { correlation, timer } = other.session.modelResume
  clearTimeout(timer)
  blockPlan(other)
  await other.session.runModelRecoverableResume(correlation, 1)
  assert.equal(recoveryRows(other.events, 'recovery.auto_resume_cancelled').at(-1).reason, 'plan_blocked')
  assert.equal(recoveryRows(other.events, 'recovery.auto_resume_started').length, 0)
})

test('RUN_PAUSED never downgrades an operator, authority or guard pause to model_recoverable or transport', () => {
  for (const sticky of [PAUSE_CLASS.OPERATOR, PAUSE_CLASS.AUTHORITY, PAUSE_CLASS.GUARD]) {
    const paused = applyPlanningEvent(committedPlan(), { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: `held_${sticky}`, pause_class: sticky })
    for (const [pauseClass, pauseSubkind] of [[PAUSE_CLASS.MODEL_RECOVERABLE, ''], [PAUSE_CLASS.TRANSPORT, 'timeout']]) {
      const again = applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'late failure', pause_class: pauseClass, pause_subkind: pauseSubkind })
      assert.equal(again.run.pause_class, sticky, `${sticky} stays over ${pauseClass}`)
      assert.equal(again.run.pause_reason, `held_${sticky}`)
    }
    // Moving to another non-resumable class, or being resumed and paused again, is still allowed.
    assert.equal(applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'user_stop', pause_class: PAUSE_CLASS.OPERATOR }).run.pause_class, PAUSE_CLASS.OPERATOR)
    const resumed = applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_RESUMED, now: tick(), source: 'runtime' })
    assert.equal(applyPlanningEvent(resumed, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'x', pause_class: PAUSE_CLASS.MODEL_RECOVERABLE }).run.pause_class, 'model_recoverable')
  }
  // A resumable pause is replaced freely.
  const model = pause(committedPlan())
  assert.equal(applyPlanningEvent(model, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'p', pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' }).run.pause_class, 'transport')
})

test('a late model failure after a stop does not turn the stop into a retry (through the agent)', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.agent.pausePersistentPlan('user_stop', { pause_class: PAUSE_CLASS.OPERATOR })
  await run.agent.pausePersistentPlan(`provider_recovery_exhausted: ${RUN_E_FAILURE}`, { pause_class: PAUSE_CLASS.MODEL_RECOVERABLE })
  const record = run.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_reason], ['operator', 'user_stop'])
  run.session.lastPauseDecision = ''
  assert.equal(await run.session.considerPauseForAutoResume(), null)
})

test('transport auto-resume schedules from the declared class and subkind: a structured-only ECONNRESET with a plain message still schedules', async t => {
  const { agent } = await startedAgent()
  const { session, chat } = sessionFor(agent, { realQueue: true })
  t.after(() => session.clearAutoResume())
  const failure = Object.assign(new Error('upstream closed'), { code: 'ECONNRESET' })
  await session.queueEvent(() => { throw failure }, { reportError: true })
  assert.equal(agent.memory.currentPlan(KEY).status, 'paused')
  const record = agent.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['transport', 'transport'])
  assert.equal(session.autoResume?.kind, 'transport')
  assert.ok(session.autoResume.timer)
  assert.ok(chat.some(line => /Resuming automatically in 30 s \(attempt 1\/6\)/.test(line)))
  // The durable subkind alone is enough when the failure object carries nothing.
  session.clearAutoResume()
  assert.equal(await session.scheduleAutoResume(new Error('opaque')), true)
  assert.equal(session.autoResume.kind, 'transport')
})

test('the startup branch schedules from a persisted model_recoverable pause, and leaves an operator pause alone', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  await run.session.runModelRecoverableResume(run.session.modelResume.correlation, 1)
  clearTimeout(run.session.modelResume.timer)

  const world = makeWorld({ stateFile: run.stateFile, mode: 'fail' })
  await world.agent.loadPersistentState()
  const second = sessionFor(world.agent, { realQueue: true })
  t.after(() => { if (second.session.modelResume?.timer) clearTimeout(second.session.modelResume.timer) })
  assert.equal(second.session.queueStartupRecovery(second.session.currentPlanState()), 'consider_pause')
  await second.session.eventQueue
  assert.deepEqual(recoveryRows(world.events, 'recovery.auto_resume_scheduled').map(row => [row.attempt, row.goal_attempt]), [[2, 2]])

  const stopped = await startedAgent()
  stopped.agent.traceRequest = null
  await stopped.agent.pausePersistentPlan('user_stop', { pause_class: PAUSE_CLASS.OPERATOR })
  const third = sessionFor(stopped.agent, { realQueue: true })
  assert.equal(third.session.queueStartupRecovery(third.session.currentPlanState()), 'consider_pause')
  await third.session.eventQueue
  assert.equal(third.session.modelResume, null)
  assert.equal(recoveryRows(stopped.events, 'recovery.auto_resume_scheduled').length, 0)
})
