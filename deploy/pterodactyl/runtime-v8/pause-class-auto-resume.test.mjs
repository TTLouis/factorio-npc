import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { reserveBudget } from './common.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { PreservationProofError } from './contract-obligations.mjs'
import { validateOutcomeCandidate } from './outcome-authority.mjs'
import {
  AUTO_RESUMABLE_PAUSE_CLASSES,
  classifyRequestFailure,
  HARNESS_STATE_FAULT_CODES,
  harnessStateFaultCode,
  isAutoResumable,
  isProviderFailurePause,
  MODEL_RECOVERABLE_RESUME_LIMITS,
  PAUSE_CLASS,
  PAUSE_CLASSES,
  pauseClassLabel,
  pauseClassOf,
  reviewPauseEvidence,
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
  reviewBlockerRepeat,
  serializePlanningState,
} from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { executeUiControl, pauseStrandedPlanAfterRequestError, recoverInterruptedAgentPlan, Session, transientProviderFailure } from './supervisor.mjs'
import { deployment, FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

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

// --- Run BB lane B: no generic resume on an unchanged executor-review blocker -------------------------------------------------
// Run BB: the executor asked for planner review four times about one missing iron plate; two generic resumes repeated it and the
// run ended auto_resume_exhausted. The pause keeps the evidence it was raised on beside the resume allowance (review reason + a
// digest of the rationale), so an identical repeat on the same step with no verified progress is recognised, durably.
const BLOCKER = 'The new burner drill needs 9 iron plates but only 8 are held, and direct_feed forbids hand-supplying iron ore.'
const reviewOf = (rationale = BLOCKER, reason = 'approach_infeasible') => reviewPauseEvidence({ reason, rationale })

function reviewPause(state, evidence) {
  const allowance = autoResumeAllowance(state)
  const paused = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: `executor_review:${evidence.reason}`, pause_class: PAUSE_CLASS.MODEL_RECOVERABLE })
  return applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_PAUSE_EVIDENCE_RECORDED, now: tick(), source: 'runtime', goal_id: allowance.goal_id,
    plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id, ...evidence })
}
const resumeAfterAttempt = state => applyPlanningEvent(attempt(state, { request_id: `recovery_${clock}` }), { type: PLANNING_EVENT.RUN_RESUMED, now: tick(), source: 'runtime' })

test('the review evidence is the reason plus a digest that ignores case, punctuation and spacing but not content', () => {
  const evidence = reviewOf()
  assert.deepEqual(Object.keys(evidence), ['kind', 'reason', 'digest'])
  assert.equal(evidence.kind, 'executor_review')
  assert.equal(reviewOf(BLOCKER.toUpperCase().replace(/ /g, '  ')).digest, evidence.digest)
  assert.notEqual(reviewOf(BLOCKER.replace('9 iron plates', '10 iron plates')).digest, evidence.digest, 'a changed number is a changed fact')
  assert.notEqual(reviewOf(BLOCKER, 'local_recovery_exhausted').digest, evidence.digest)
})

test('an identical executor-review repeat on the same step with no verified progress is recognised; a changed fact or progress is not', () => {
  const first = reviewPause(committedPlan(), reviewOf())
  assert.equal(reviewBlockerRepeat(first), undefined, 'nothing was resumed yet, so nothing repeats')
  const resumed = resumeAfterAttempt(first)
  assert.equal(resumed.run.auto_resume.steps[0].resumed_evidence.digest, reviewOf().digest, 'the resumed pause evidence is kept on the step')

  const repeat = reviewBlockerRepeat(reviewPause(resumed, reviewOf()))
  assert.deepEqual([repeat.evidence.reason, repeat.evidence.digest, repeat.step_attempts, repeat.goal_attempts], ['approach_infeasible', reviewOf().digest, 1, 1])
  assert.notEqual(repeat.previous_pause.pause_count, repeat.current_pause.pause_count, 'two distinct pauses')
  assert.match(repeat.previous_pause.resume_request_id, /^recovery_/)
  // Spacing and case alone do not make a new fact.
  assert.ok(reviewBlockerRepeat(reviewPause(resumed, reviewOf(`  ${BLOCKER.toUpperCase()}  `))))

  // A changed fact, a changed review reason, or a pause that carries no evidence resumes exactly as before.
  assert.equal(reviewBlockerRepeat(reviewPause(resumed, reviewOf(BLOCKER.replace('8 are held', '9 are held')))), undefined)
  assert.equal(reviewBlockerRepeat(reviewPause(resumed, reviewOf(BLOCKER, 'local_recovery_exhausted'))), undefined)
  const bare = applyPlanningEvent(resumed, { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'executor_review:approach_infeasible', pause_class: PAUSE_CLASS.MODEL_RECOVERABLE })
  assert.equal(reviewBlockerRepeat(bare), undefined)
  // Verified progress between the two pauses.
  const progressed = receipt(resumed, 'deterministic_verification', 'batch_21')
  assert.equal(autoResumeAllowance(progressed).progressed, true)
  assert.equal(reviewBlockerRepeat(reviewPause(progressed, reviewOf())), undefined)
  // The limits are unchanged: the repeat is a separate decision, not a bigger or smaller allowance.
  assert.deepEqual({ ...MODEL_RECOVERABLE_RESUME_LIMITS }, { per_step: 2, per_goal: 6 })
})

test('the review evidence is refused for a stale step, a non-model_recoverable pause, or an unknown goal', () => {
  const paused = applyPlanningEvent(committedPlan(), { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'executor_review:approach_infeasible', pause_class: PAUSE_CLASS.MODEL_RECOVERABLE })
  const allowance = autoResumeAllowance(paused)
  const record = overrides => applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_PAUSE_EVIDENCE_RECORDED, now: tick(), source: 'runtime', goal_id: allowance.goal_id,
    plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id, ...reviewOf(), ...overrides })
  assert.notEqual(record({}), paused)
  for (const overrides of [{ step_id: 'step_other' }, { plan_id: 'plan_other' }, { plan_version: allowance.plan_version + 1 }, { goal_id: 'goal_other' }, { source: 'main_planner' }, { digest: '' }]) {
    assert.equal(record(overrides), paused, JSON.stringify(overrides))
  }
  const operator = applyPlanningEvent(committedPlan(), { type: PLANNING_EVENT.RUN_PAUSED, now: tick(), source: 'runtime', reason: 'user_stop', pause_class: PAUSE_CLASS.OPERATOR })
  assert.equal(applyPlanningEvent(operator, { type: PLANNING_EVENT.RUN_PAUSE_EVIDENCE_RECORDED, now: tick(), source: 'runtime', goal_id: allowance.goal_id,
    plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id, ...reviewOf() }), operator)
})

test('the review evidence and the repeat verdict survive a serialize and restore (a restart)', () => {
  const standing = reviewPause(resumeAfterAttempt(reviewPause(committedPlan(), reviewOf())), reviewOf())
  const before = reviewBlockerRepeat(standing)
  assert.ok(before)
  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(standing))))
  assert.deepEqual(reviewBlockerRepeat(restored), before)
  assert.deepEqual(autoResumeAllowance(restored).step_attempts, 1)
  // A restored record that lost its evidence only means the next repeat resumes as before.
  const damaged = JSON.parse(JSON.stringify(serializePlanningState(standing)))
  delete damaged.run.auto_resume.pause_evidence
  assert.equal(reviewBlockerRepeat(restorePlanningState(damaged)), undefined)
  damaged.run.auto_resume.pause_evidence = { step_key: 'x', digest: 7 }
  assert.equal(reviewBlockerRepeat(restorePlanningState(damaged)), undefined)
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
// mode 'checkpoint' is run H's attempt 2: the executor answers with the active step's checkpoint and no operation. The contract is
// read from the board the way a model reads it from its handoff packet (the step's committed completion contract).
function checkpointOnlyStep(memory) {
  const board = memory.currentPlan(KEY)?.task_board
  const contract = board?.steps?.[board.active_index]?.completion_contract
  const checkpoint = contract?.requirements?.length
    ? { mode: contract.mode, requirements: contract.requirements.map(({ id, kind, item_name: itemName, minimum }) => ({ id, kind, item_name: itemName, minimum })) }
    : inventoryCheckpoint('copper-ore', 10)
  return planReply({ plan: TWO_STEPS, currentStep: 1, operations: [], checkpoint })
}

function makeWorld({ game = new FakeFactorio(), stateFile = null, mode = 'fail' } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const trace = []
  const state = { mode, executorCalls: 0, gate: undefined, onExecutorCall: undefined }
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (_messages, context) => {
      if (context?.role !== 'executor') return plannerSlice()
      state.executorCalls += 1
      await state.onExecutorCall?.()
      await state.gate?.promise
      return state.mode === 'checkpoint' ? checkpointOnlyStep(memory) : executorStep(state.mode)
    },
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

// --- unit 14: an automatic resume makes the plan active again before the executor is restaged (run H) --------------------------

test('run H: after a model_recoverable auto-resume the plan is ACTIVE when the restaged executor answers, so its checkpoint is not refused', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  const { correlation } = run.session.modelResume
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.memory.currentPlan(KEY).task_board.status, 'paused')

  // Run H's own sequence: a checkpoint with no operations reaches persistPlannerCheckpoint. On the paused plan it threw
  // checkpoint_requires_active_step (that is the precondition the resume removes) ...
  const checkpoint = () => JSON.parse(checkpointOnlyStep(run.memory).content).checkpoint
  run.agent.requestInfo = { memoryKey: KEY, sender: 'TTLouis', text: 'resume', origin: 'runtime' }
  await assert.rejects(() => run.agent.persistPlannerCheckpoint({ checkpoint: checkpoint(), operations: [] }), /checkpoint_requires_active_step/)
  run.agent.requestInfo = null

  // ... and on the plan the auto-resume made active it is handled, with no throw, while the executor is mid-restage.
  const during = []
  run.state.mode = 'checkpoint'
  run.state.onExecutorCall = async () => {
    if (during.length > 0) return
    const plan = run.memory.currentPlan(KEY)
    const entry = { status: plan.status, board: plan.task_board.status, runPaused: run.memory.pauseRecord(KEY).paused, pauseClass: run.memory.pauseRecord(KEY).pause_class }
    try {
      const result = await run.agent.persistPlannerCheckpoint({ checkpoint: checkpoint(), operations: [] })
      entry.stepId = result.stepId
      entry.statusAfter = run.memory.currentPlan(KEY).status
    }
    catch (error) {
      entry.threw = error instanceof Error ? error.message : String(error)
    }
    during.push(entry)
  }
  const before = run.memory.autoResumeAllowance(KEY)
  await run.session.runModelRecoverableResume(correlation, 1)

  assert.equal(during.length, 1, 'the restaged executor was asked')
  assert.deepEqual({ status: during[0].status, board: during[0].board, runPaused: during[0].runPaused, pauseClass: during[0].pauseClass, threw: during[0].threw, statusAfter: during[0].statusAfter },
    { status: 'active', board: 'active', runPaused: false, pauseClass: '', threw: undefined, statusAfter: 'active' })
  assert.ok(during[0].stepId)
  const [started] = recoveryRows(run.events, 'recovery.auto_resume_started')
  const [resumed, ...extra] = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
  assert.equal(extra.length, 0)
  assert.equal(resumed.request_id, started.request_id, 'the resume belongs to the recovery request')
  assert.equal(resumed.pause_class, 'model_recoverable')
  assert.equal(resumed.step_id, correlation.step_id)
  assert.equal(resumed.goal_id, correlation.goal_id)
  assert.match(resumed.reason, /^auto_resume_after_model_recoverable_pause/)
  const resumedAt = run.events.findIndex(row => row.event === 'recovery.auto_resume_plan_resumed')
  const restagedAt = run.events.findIndex(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7')
  assert.ok(resumedAt > -1 && restagedAt > resumedAt, 'the plan was made active before the executor was restaged')
  // Nothing in the recovery failed on the harness's own state.
  const failed = run.events.filter(row => row.event === 'request.failed').map(row => row.data.message)
  assert.equal(failed.some(message => /checkpoint_requires_active_step/.test(message)), false, 'the harness-state fault is unreachable from the auto-resume path')
  assert.equal(recoveryRows(run.events, 'recovery.harness_state_fault').length, 0)
  // The attempt still counted, exactly once.
  assert.equal(run.memory.autoResumeAllowance(KEY).step_attempts, before.step_attempts + 1)
  assert.equal(run.memory.autoResumeAllowance(KEY).goal_attempts, before.goal_attempts + 1)
  // run-check reads the same rows: no harness fault.
  assert.equal(analyzeBehaviorTrace(run.trace).findings.some(finding => finding.signature === 'harness_state_fault'), false)
})

test('an auto-resume that fails again pauses model_recoverable once more, and the next attempt makes the plan active again', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  await run.session.runModelRecoverableResume(run.session.modelResume.correlation, 1)

  // Attempt 1: the executor produced no operation, the request failed the way it failed originally, the plan is paused again.
  const [first] = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
  assert.equal(first.pause_class, 'model_recoverable')
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.memory.currentPlan(KEY).task_board.status, 'paused')
  assert.deepEqual([run.memory.pauseRecord(KEY).paused, run.memory.pauseRecord(KEY).pause_class], [true, 'model_recoverable'])
  assert.equal(run.memory.autoResumeAllowance(KEY).step_attempts, 1, 'the allowance accounting is untouched by the resume')
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_scheduled').map(row => row.attempt), [1, 2])

  // Attempt 2 (the model answers properly): the plan is resumed again, and stays active.
  clearTimeout(run.session.modelResume.timer)
  run.state.mode = 'ok'
  await run.session.runModelRecoverableResume(run.session.modelResume.correlation, 2)
  const resumed = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
  const started = recoveryRows(run.events, 'recovery.auto_resume_started')
  assert.deepEqual(resumed.map(row => row.request_id), started.map(row => row.request_id))
  assert.equal(new Set(resumed.map(row => row.request_id)).size, 2)
  const plan = run.memory.currentPlan(KEY)
  assert.equal(plan.status, 'active')
  assert.equal(plan.task_board.status, 'active')
  assert.deepEqual([run.memory.pauseRecord(KEY).paused, run.memory.pauseRecord(KEY).pause_class], [false, ''])
  assert.equal(run.memory.autoResumeAllowance(KEY).step_attempts, 2, 'both attempts are still counted against unit 7\'s caps')
  assert.equal(run.game.mutations.length, 2)
})

test('the transport auto-resume makes the plan active before the restage too', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.agent.pausePersistentPlan('provider_transient: Provider timed out after 120000 ms', { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' })
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'transport')
  run.state.mode = 'ok'
  await run.session.runAutoResume()
  const [resumed] = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
  assert.equal(resumed.pause_class, 'transport')
  assert.match(resumed.reason, /^auto_resume_after_transient_provider_failure/)
  assert.equal(run.memory.currentPlan(KEY).status, 'active')
  assert.equal(run.game.mutations.length, 2)
})

test('an operator, authority, guard, system or unclassified pause is never reactivated by an automatic resume', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  const ours = { pauseClasses: [PAUSE_CLASS.MODEL_RECOVERABLE, PAUSE_CLASS.TRANSPORT] }
  for (const declared of [PAUSE_CLASS.OPERATOR, PAUSE_CLASS.AUTHORITY, PAUSE_CLASS.GUARD, PAUSE_CLASS.SYSTEM, undefined]) {
    run.agent.traceRequest = null
    await run.agent.pausePersistentPlan(`declared_${declared ?? 'nothing'}`, declared ? { pause_class: declared } : {})
    const refused = run.memory.resumePausedPlan(KEY, ours)
    assert.equal(refused.resumed, false, String(declared))
    assert.equal(refused.reason, 'pause_class_not_resumable', String(declared))
    assert.equal(refused.pause_class, declared ?? 'unclassified')
    assert.equal(run.memory.currentPlan(KEY).status, 'paused', String(declared))
    assert.equal(run.memory.currentPlan(KEY).task_board.status, 'paused', String(declared))
    assert.equal(run.memory.pauseRecord(KEY).paused, true, String(declared))
  }
  // A transport pause is not ours when the caller only owns model_recoverable, and a stale identity is refused.
  await run.agent.pausePersistentPlan('provider_transient: x', { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' })
  assert.equal(run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.MODEL_RECOVERABLE] }).reason, 'pause_class_not_resumable')
  const allowance = run.memory.autoResumeAllowance(KEY)
  assert.equal(run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.TRANSPORT], identity: { goal_id: allowance.goal_id, plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: 'step_old' } }).reason, 'plan_identity_changed')
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  // The one class the caller owns resumes, on both the reducer and the legacy record, and the allowance is not touched.
  const before = run.memory.autoResumeAllowance(KEY)
  const resumed = run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.TRANSPORT], identity: { goal_id: allowance.goal_id, plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id } })
  assert.deepEqual([resumed.resumed, resumed.pause_class, resumed.step_id], [true, 'transport', allowance.step_id])
  assert.deepEqual([run.memory.currentPlan(KEY).status, run.memory.currentPlan(KEY).task_board.status, run.memory.pauseRecord(KEY).paused], ['active', 'active', false])
  assert.deepEqual([run.memory.autoResumeAllowance(KEY).step_attempts, run.memory.autoResumeAllowance(KEY).goal_attempts], [before.step_attempts, before.goal_attempts])
  assert.equal(run.memory.resumePausedPlan(KEY, ours).reason, 'not_paused')
})

test('an operator pause that reaches the restage is not resumed: the recovery ends before anything runs', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  run.agent.traceRequest = null
  await run.agent.pausePersistentPlan('user_stop', { pause_class: PAUSE_CLASS.OPERATOR })
  const allowance = run.memory.autoResumeAllowance(KEY)
  const result = await recoverInterruptedAgentPlan(run.agent, 'auto_resume_after_model_recoverable_pause', {}, {
    allowModelRecoverable: true,
    requestId: 'recovery_operator_fence',
    reactivate: { pause_classes: [PAUSE_CLASS.MODEL_RECOVERABLE], identity: { goal_id: allowance.goal_id, plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id }, required: true },
  })
  assert.equal(result.recovered, false)
  assert.equal(result.reason, 'plan_not_resumable')
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [])
  const [refused] = recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed')
  assert.deepEqual([refused.request_id, refused.reason, refused.pause_class], ['recovery_operator_fence', 'pause_class_not_resumable', 'operator'])
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'operator')
  assert.equal(run.game.mutations.length, 1, 'no executor ran')
})

test('a player stop between the fire and the restage cancels the attempt with no reactivation, and the stop stands', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  run.state.mode = 'ok'
  await run.session.considerPauseForAutoResume()
  const { token, timer } = run.session.modelResume
  clearTimeout(timer)
  // The attempt parks after it was counted, before recovery starts (the persist of the count).
  const persisted = gate()
  const persist = run.agent.persistState.bind(run.agent)
  run.agent.persistState = async () => { await persisted.promise; return persist() }
  run.session.fireModelResume(token)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
  assert.equal(token.cancelled, true)
  persisted.open()
  await run.session.eventQueue

  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [], 'the plan was never reactivated')
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_started').length, 0)
  assert.equal(run.game.mutations.length, 1, 'nothing was sent to the game')
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'operator', 'the stop stands')
})

test('a player stop during the restage still wins: the plan ends paused as operator and nothing more reaches the game', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  run.state.mode = 'ok'
  await run.session.considerPauseForAutoResume()
  const { token, timer } = run.session.modelResume
  clearTimeout(timer)
  // The restaged executor's model call is held open: the plan has already been made active again when the stop arrives.
  run.state.gate = gate()
  const calls = run.state.executorCalls
  run.session.fireModelResume(token)
  for (let spin = 0; spin < 400 && run.state.executorCalls === calls; spin++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.state.executorCalls, calls + 1, 'the restaged executor is waiting on the model')
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed').length, 1)
  assert.equal(run.memory.currentPlan(KEY).status, 'active')

  assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
  assert.equal(token.cancelled, true)
  run.state.gate.open()
  await run.session.eventQueue

  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.deepEqual([run.memory.pauseRecord(KEY).pause_class, run.memory.pauseRecord(KEY).pause_reason], ['operator', 'user_stop'])
  assert.equal(run.game.mutations.length, 1, 'the cancelled attempt sent nothing')
  assert.equal(run.session.modelResume, null, 'no new automatic resume was scheduled behind the stop')
})

// --- unit 14: a harness-state invariant is a system pause with its code, not a guard -------------------------------------------

test('checkpoint_requires_active_step is a harness-state fault: system class, a cause code, and run-check names it', async t => {
  assert.deepEqual([...HARNESS_STATE_FAULT_CODES].sort(), ['checkpoint_requires_active_step', 'deterministic_checkpoint_failed_to_persist'])
  assert.equal(harnessStateFaultCode(new Error('checkpoint_requires_active_step')), 'checkpoint_requires_active_step')
  assert.equal(harnessStateFaultCode('deterministic_checkpoint_failed_to_persist: x'), 'deterministic_checkpoint_failed_to_persist')
  assert.equal(harnessStateFaultCode('checkpoint_requires_active_step_but_more'), undefined)
  assert.equal(harnessStateFaultCode(RUN_E_FAILURE), undefined)
  assert.deepEqual(classifyRequestFailure(new Error('checkpoint_requires_active_step')), { pause_class: 'system', pause_subkind: '', code: 'checkpoint_requires_active_step', source: 'harness_state_fault' })

  // A recovery whose request throws it (stubbed here: after the fix the auto-resume path cannot reach it).
  const run = await scheduledRunE(t, { mode: 'fail' })
  await run.session.considerPauseForAutoResume()
  clearTimeout(run.session.modelResume.timer)
  run.agent.runGuarded = async () => { throw new Error('checkpoint_requires_active_step') }
  const scheduledBefore = recoveryRows(run.events, 'recovery.auto_resume_scheduled').length
  await run.session.runModelRecoverableResume(run.session.modelResume.correlation, 1)
  const record = run.memory.pauseRecord(KEY)
  assert.equal(record.pause_class, 'system')
  assert.match(record.pause_reason, /^runtime_recovery_failed:auto_resume_after_model_recoverable_pause:checkpoint_requires_active_step$/)
  const [started] = recoveryRows(run.events, 'recovery.auto_resume_started')
  const [fault] = recoveryRows(run.events, 'recovery.harness_state_fault')
  assert.deepEqual([fault.request_id, fault.reason, fault.pause_class], [started.request_id, 'checkpoint_requires_active_step', 'system'])
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').length, scheduledBefore, 'a system pause is never scheduled for an automatic resume')
  const finding = analyzeBehaviorTrace(run.trace).findings.find(item => item.signature === 'harness_state_fault')
  assert.match(finding.detail, /harness state fault checkpoint_requires_active_step/)
})

// --- unit 14 review fixes: stop and actor fences on every auto-resume, no restage onto a paused plan -------------------------------

// Parks the next call of `name` on the agent until the returned gate opens; `entered()` says whether it was reached.
function parkAgentCall(agent, name) {
  const hold = gate()
  const original = agent[name].bind(agent)
  let reached = 0
  agent[name] = async (...args) => { reached += 1; await hold.promise; return original(...args) }
  return { open: hold.open, entered: () => reached }
}

async function waitFor(condition, label) {
  for (let spin = 0; spin < 400 && !condition(); spin++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), `waited for ${label}`)
}

const assertStopStood = (run, label) => {
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [], `${label}: the plan was never reactivated`)
  assert.equal(run.memory.currentPlan(KEY).status, 'paused', label)
  assert.equal(run.memory.currentPlan(KEY).task_board.status, 'paused', label)
  assert.equal(run.memory.pauseRecord(KEY).pause_class, 'operator', `${label}: the stop stands`)
  assert.equal(run.game.mutations.length, 1, `${label}: nothing was sent to the game`)
  assert.equal(recoveryRows(run.events, 'runtime.recovery_started').length, 0, `${label}: no recovery turn started`)
}

test('a stop that arrives while the model_recoverable resume awaits captureEpoch or the reconcile read cancels it before the plan is made active', async t => {
  for (const name of ['captureEpoch', 'reconcileOutstandingOperation']) {
    const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
    run.state.mode = 'ok'
    await run.session.considerPauseForAutoResume()
    const { token, timer } = run.session.modelResume
    clearTimeout(timer)
    const parked = parkAgentCall(run.agent, name)
    run.session.fireModelResume(token)
    await waitFor(() => parked.entered() > 0, `${name} to be reached`)
    assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
    assert.equal(token.cancelled, true)
    parked.open()
    await run.session.eventQueue
    assertStopStood(run, name)
    assert.ok(recoveryRows(run.events, 'recovery.auto_resume_cancelled').some(row => row.reason === 'cancelled_after_fire'), name)
  }
})

test('a stop during the transport auto-resume\'s captureEpoch or reconcile window cancels it: the plan stays paused, nothing runs', async t => {
  for (const name of ['captureEpoch', 'reconcileOutstandingOperation']) {
    const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
    run.state.mode = 'ok'
    await run.agent.pausePersistentPlan('provider_transient: Provider timed out after 120000 ms', { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' })
    const parked = parkAgentCall(run.agent, name)
    run.session.queueEvent(() => run.session.runAutoResume(), { reportError: true })
    await waitFor(() => parked.entered() > 0, `${name} to be reached`)
    assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
    parked.open()
    await run.session.eventQueue
    assertStopStood(run, `transport ${name}`)
  }
})

test('a stop that arrives after the transport resume made the plan active still wins', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  run.state.mode = 'ok'
  await run.agent.pausePersistentPlan('provider_transient: Provider timed out after 120000 ms', { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' })
  run.state.gate = gate()
  const calls = run.state.executorCalls
  run.session.queueEvent(() => run.session.runAutoResume(), { reportError: true })
  await waitFor(() => run.state.executorCalls > calls, 'the restaged executor to wait on the model')
  assert.equal(run.memory.currentPlan(KEY).status, 'active')
  assert.equal(run.session.queuePlayerRequest('TTLouis', 'stop'), true)
  run.state.gate.open()
  await run.session.eventQueue
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.deepEqual([run.memory.pauseRecord(KEY).pause_class, run.memory.pauseRecord(KEY).pause_reason], ['operator', 'user_stop'])
  assert.equal(run.game.mutations.length, 1)
})

test('an actor or epoch change between the stale check and the resume refuses it: nothing is restaged and the plan stays paused', async t => {
  for (const [label, status] of [['actor', { actor_id: 19, epoch: 3 }], ['epoch', { actor_id: 18, epoch: 4 }]]) {
    const run = await scheduledRunE(t, { mode: 'fail' })
    run.state.mode = 'ok'
    await run.session.considerPauseForAutoResume()
    const { correlation, timer } = run.session.modelResume
    clearTimeout(timer)
    // The supervisor's own status read still says 18/3 at the stale check; the game answers differently when the recovery binds the actor.
    run.game.status = deployment(status)
    await run.session.runModelRecoverableResume(correlation, 1)
    clearTimeout(run.session.modelResume?.timer)
    const [refused] = recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed')
    assert.equal(refused.reason, 'actor_or_epoch_changed', label)
    assert.deepEqual([refused.scheduled_actor_id, refused.scheduled_epoch, refused.actor_id, refused.epoch], [18, 3, status.actor_id, status.epoch], label)
    assert.match(refused.request_id, /^recovery_/)
    assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [], label)
    assert.equal(recoveryRows(run.events, 'runtime.recovery_started').length, 0, label)
    assert.equal(run.memory.currentPlan(KEY).status, 'paused', label)
    assert.equal(run.memory.pauseRecord(KEY).pause_class, 'model_recoverable', label)
    assert.equal(run.game.mutations.length, 1, label)
    assert.ok(run.chat.some(line => /could not resume the paused plan automatically.*actor_or_epoch_changed.*stays paused/.test(line)), `${label}: said visibly`)
  }
})

test('a transport resume that cannot make the plan active ends visibly: a legacy prefix-only pause stays paused for a person', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  run.state.mode = 'ok'
  run.agent.traceRequest = null
  // The pre-class shape: only the reason prefix says transient; the class was never declared.
  await run.agent.pausePersistentPlan('provider_transient: Provider timed out after 120000 ms', {})
  assert.equal(run.memory.pauseRecord(KEY).pause_class, '')
  await run.session.runAutoResume()
  const [refused] = recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed')
  assert.deepEqual([refused.reason, refused.pause_class, refused.recovery_reason], ['pause_class_not_resumable', 'unclassified', 'auto_resume_after_transient_provider_failure'])
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [])
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  assert.equal(run.game.mutations.length, 1, 'nothing was restaged')
  assert.match(run.chat.at(-1), /could not resume the paused plan automatically after auto_resume_after_transient_provider_failure \(pause_class_not_resumable\), so it stays paused and nothing ran\. Say continue/)
})

test('a transport actor change between schedule and fire refuses the resume, and a stale step on the board is refused', async t => {
  const run = await scheduledRunE(t, { mode: 'fail' })
  run.state.mode = 'ok'
  await run.agent.pausePersistentPlan('provider_transient: x', { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' })
  run.session.autoResume = { attempt: 1, kind: 'timeout', timer: null, actor: { actor_id: 7, epoch: 1 } }
  await run.session.runAutoResume()
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed').at(-1).reason, 'actor_or_epoch_changed')
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')

  // The legacy board points at a step the reducer's committed plan is not on.
  const board = run.memory.currentPlan(KEY).task_board
  const active = board.active_index
  board.active_index = active === 0 ? 1 : 0
  const refused = run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.TRANSPORT] })
  assert.deepEqual([refused.resumed, refused.reason], [false, 'step_mismatch'])
  assert.equal(run.memory.currentPlan(KEY).status, 'paused')
  board.active_index = active
  assert.equal(run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.TRANSPORT] }).resumed, true)
})

// --- unit 14 review fixes: a restart never restages the executor onto a paused plan ---------------------------------------------

async function restartedRun(t, pause) {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  run.state.mode = 'ok'
  run.agent.traceRequest = null
  await run.agent.pausePersistentPlan(pause.reason, pause.info)
  const outcome = run.session.queueStartupRecovery(run.session.currentPlanState())
  await run.session.eventQueue
  return { ...run, outcome }
}

test('a restart with a transport-paused plan resumes it active, restages the executor and counts the attempt', async t => {
  const run = await restartedRun(t, { reason: 'provider_transient: Provider timed out after 120000 ms', info: { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: 'timeout' } })
  t.after(() => run.session.clearAutoResume())
  assert.equal(run.outcome, 'recover')
  const [resumed] = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
  assert.deepEqual([resumed.pause_class, resumed.reason], ['transport', 'runtime_restart'])
  assert.match(resumed.request_id, /^recovery_/)
  assert.equal(run.memory.currentPlan(KEY).status, 'active')
  assert.equal(run.memory.currentPlan(KEY).task_board.status, 'active')
  assert.equal(run.memory.pauseRecord(KEY).paused, false)
  assert.equal(run.session.autoResume.attempt, 1, 'the restart counts as the first automatic attempt')
  assert.equal(run.game.mutations.length, 2, 'the executor ran on an active plan')
})

test('a restart with a runtime-lifecycle pause (server stop, actor replacement) resumes it through the same path', async t => {
  for (const reason of ['server_stop_shutdown', 'actor_replaced', 'npc_identity_or_session_changed']) {
    const run = await restartedRun(t, { reason, info: { pause_class: PAUSE_CLASS.SYSTEM } })
    assert.equal(run.outcome, 'recover', reason)
    const [resumed] = recoveryRows(run.events, 'recovery.auto_resume_plan_resumed')
    assert.deepEqual([resumed.pause_class, resumed.reason], ['system', 'runtime_restart'], reason)
    assert.equal(run.memory.currentPlan(KEY).status, 'active', reason)
    assert.equal(run.game.mutations.length, 2, reason)
  }
})

test('a restart with a guard, operator or authority pause does not restage, and a lifecycle-looking reason on the wrong class is refused visibly', async t => {
  for (const declared of [PAUSE_CLASS.GUARD, PAUSE_CLASS.OPERATOR, PAUSE_CLASS.AUTHORITY]) {
    const run = await restartedRun(t, { reason: `declared_${declared}`, info: { pause_class: declared } })
    assert.notEqual(run.outcome, 'recover', declared)
    assert.equal(run.game.mutations.length, 1, declared)
    assert.equal(run.memory.currentPlan(KEY).status, 'paused', declared)
    assert.equal(recoveryRows(run.events, 'runtime.recovery_started').length, 0, declared)
  }
  for (const [reason, declared] of [['server_stop_shutdown', PAUSE_CLASS.OPERATOR], ['provider_transient: x', PAUSE_CLASS.GUARD], ['actor_replaced', undefined]]) {
    const run = await restartedRun(t, { reason, info: declared ? { pause_class: declared } : {} })
    assert.equal(run.outcome, 'recover', reason)
    const [refused] = recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed')
    assert.deepEqual([refused.reason, refused.pause_class, refused.recovery_reason], ['pause_class_not_resumable', declared ?? 'unclassified', 'runtime_restart'], reason)
    assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [], reason)
    assert.equal(run.game.mutations.length, 1, `${reason}: nothing restaged`)
    assert.equal(run.memory.currentPlan(KEY).status, 'paused', reason)
    assert.match(run.chat.at(-1), /could not resume the paused plan automatically after runtime_restart/, reason)
  }
})

test('a restart that finds an ACTIVE plan (a crash mid-step) restages it unchanged, with no resume event', async t => {
  const run = await scheduledRunE(t, { mode: 'fail', realQueue: true })
  run.state.mode = 'ok'
  run.agent.traceRequest = null
  // Make the plan active the way a player's continue does, then restart.
  assert.equal(run.memory.resumePausedPlan(KEY, { pauseClasses: [PAUSE_CLASS.MODEL_RECOVERABLE] }).resumed, true)
  assert.equal(run.session.queueStartupRecovery(run.session.currentPlanState()), 'recover')
  await run.session.eventQueue
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_resumed'), [])
  assert.deepEqual(recoveryRows(run.events, 'recovery.auto_resume_plan_not_resumed'), [])
  assert.equal(recoveryRows(run.events, 'runtime.recovery_started').length, 1)
  assert.equal(run.game.mutations.length, 2)
})

// --- Run BB lane C (2026-10-26): a harness guard keeps its own code and is never labelled a provider failure ---

test('run BB lane C: a PreservationProofError classifies as a guard under its own code, with or without a detail bag', () => {
  const bare = new PreservationProofError('argument_correction_limit_exhausted', { category: 'exhausted', stage: 'correction' })
  assert.deepEqual(classifyRequestFailure(bare), { pause_class: 'guard', pause_subkind: '', code: 'argument_correction_limit_exhausted', source: 'guard_code' })
  assert.equal(bare.detail, undefined)
  const detailed = new PreservationProofError('argument_correction_limit_exhausted', { stage: 'correction', detail: { preflight_code: 'not_recipe_machine' } })
  assert.deepEqual(detailed.detail, { preflight_code: 'not_recipe_machine' })
  // A guard code cannot be forged through the message and a transport signal still wins: waiting is what fixes those.
  assert.equal(classifyRequestFailure(Object.assign(new PreservationProofError('preservation_type_unsupported'), { http_status: 503 })).pause_class, 'transport')
  assert.equal(classifyRequestFailure(new Error('argument_correction_limit_exhausted')).code, 'request_failed')
})

test('run BB lane C: provider_failure follows the pause class and the failure code, not any "provider" or "request_failed" in the reason text', () => {
  const guard = { pause_class: 'guard' }
  assert.equal(isProviderFailurePause(guard, 'argument_correction_limit_exhausted: not_recipe_machine on set_machine_recipe'), false)
  assert.equal(isProviderFailurePause(guard, 'argument_correction_limit_exhausted: request_failed after provider timed out'), false, 'text after the code is not a classification')
  assert.equal(isProviderFailurePause(guard, 'request_output_ceiling: 10 > 5 output units'), false)
  assert.equal(isProviderFailurePause({ pause_class: 'system' }, 'checkpoint_requires_active_step: x'), false)
  // Genuine provider pauses stay provider failures.
  assert.equal(isProviderFailurePause({ pause_class: 'transport', pause_subkind: 'timeout' }, 'provider_transient: Provider timed out'), true)
  assert.equal(isProviderFailurePause(guard, 'request_failed: Provider HTTP 400'), true)
  for (const code of ['provider_recovery_exhausted', 'provider_action_omission_repair_failed', 'provider_semantic_alignment_failed', 'provider_output_budget_exhausted']) {
    assert.equal(isProviderFailurePause({ pause_class: 'model_recoverable' }, `${code}: x`), true, code)
  }
  assert.equal(isProviderFailurePause({ pause_class: 'model_recoverable' }, 'recoverable_provider_failure:requires_machine_retry_exhausted'), true)
})

test('run BB lane C: the stranded-plan pause of a guard error keeps the guard code and names the refusal; its goal.paused row is not a provider failure', async () => {
  const { agent, events } = await startedAgent()
  agent.traceRequest = null // the request has ended: pausePersistentPlan names the pause itself
  const { session } = sessionFor(agent)
  const failure = new PreservationProofError('argument_correction_limit_exhausted', { category: 'exhausted', stage: 'correction',
    detail: { preflight_code: 'not_recipe_machine', operation_index: 0, operation_name: 'set_machine_recipe' } })
  const paused = await pauseStrandedPlanAfterRequestError(session, failure)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pause_reason, 'argument_correction_limit_exhausted: not_recipe_machine on set_machine_recipe')
  const record = agent.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['guard', ''])
  const row = recoveryRows(events, 'goal.paused').at(-1)
  assert.equal(row.provider_failure, false)
  assert.equal(row.cause, 'argument_correction_limit_exhausted')
  assert.equal(row.pause_class, 'guard')
  assert.equal(await session.considerPauseForAutoResume(), null, 'a guard pause waits for a player Resume')
  // A genuinely unplaced request failure still reads as request_failed and as a provider failure, as before.
  const other = await startedAgent()
  other.agent.traceRequest = null
  await pauseStrandedPlanAfterRequestError(sessionFor(other.agent).session, new Error('Provider HTTP 400; request will not be retried automatically'))
  const generic = recoveryRows(other.events, 'goal.paused').at(-1)
  assert.deepEqual([generic.cause, generic.provider_failure], ['request_failed', true])
})

// --- Run BB lane B on the real supervisor and agent ---------------------------------------------------------------------------
// The review pause an executor raises (handlePlannerReview) is recreated with the memory calls it makes: the model_recoverable
// pause and the evidence it was raised on. A resume is what the supervisor does when its timer fires.
function raiseReview(run, evidence) {
  run.memory.pausePlan(KEY, `executor_review:${evidence.reason}`, { pause_class: PAUSE_CLASS.MODEL_RECOVERABLE })
  const allowance = run.memory.autoResumeAllowance(KEY)
  assert.equal(run.memory.recordPauseEvidence(KEY, { plan_id: allowance.plan_id, plan_version: allowance.plan_version, step_id: allowance.step_id, ...evidence }), true)
}
function resumeAttempt(run) {
  clearTimeout(run.session.modelResume.timer)
  const { correlation } = run.session.modelResume
  assert.equal(run.memory.recordAutoResumeStarted(KEY, { ...correlation, request_id: 'recovery_probe' }).recorded, true)
  assert.equal(run.memory.resumePausedPlan(KEY, { reason: 'auto_resume', pauseClasses: [PAUSE_CLASS.MODEL_RECOVERABLE] }).resumed, true)
  run.session.modelResume = null
}
async function firstReviewResumed(t) {
  const run = await scheduledRunE(t, { mode: 'fail' })
  raiseReview(run, reviewOf())
  assert.equal(await run.session.considerPauseForAutoResume(), true, 'the first review pause is resumed generically, as before')
  resumeAttempt(run)
  return run
}

test('Run BB lane B: an identical executor review on the same step ends in a visible guard pause and no second resume is scheduled', async t => {
  const run = await firstReviewResumed(t)
  raiseReview(run, reviewOf())
  assert.equal(await run.session.considerPauseForAutoResume(), false)
  assert.equal(run.session.modelResume, null)
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_scheduled').length, 1, 'only the first pause was scheduled')
  assert.equal(recoveryRows(run.events, 'recovery.auto_resume_exhausted').length, 0, 'the exhaustion guard was not what stopped it')
  const [row, ...extra] = recoveryRows(run.events, 'recovery.review_blocker_unchanged')
  assert.equal(extra.length, 0)
  assert.deepEqual([row.reason, row.pause_class, row.review_reason, row.evidence_digest], ['review_blocker_unchanged', 'guard', 'approach_infeasible', reviewOf().digest])
  assert.equal(row.previous_pause.resume_request_id, 'recovery_probe')
  assert.ok(row.current_pause.pause_count > row.previous_pause.pause_count, 'both pause identities are traced')
  assert.deepEqual([row.step_attempts, row.goal_attempts], [1, 1], 'the limits were not spent or changed')
  const record = run.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'review_blocker_unchanged', 'guard'])
  assert.match(run.chat.at(-1), /same blocker \(approach_infeasible\) on this step again with nothing verified in between/)
  // A guard pause is not resumed by a timer, and a repeated goal.paused does not repeat the report.
  assert.equal(await run.session.considerPauseForAutoResume(), null)
  assert.equal(recoveryRows(run.events, 'recovery.review_blocker_unchanged').length, 1)
  // run-check reads the new row as an auto-resume decision.
  assert.equal(analyzeBehaviorTrace([{ schema: 1, ts: 'x', seq: 1, event: 'goal.paused', data: { pause_class: 'model_recoverable', pause_reason: 'executor_review:approach_infeasible' } },
    { schema: 1, ts: 'y', seq: 2, event: 'recovery.review_blocker_unchanged', data: row }]).findings.some(finding => finding.signature === 'model_recoverable_pause_not_resumed'), false)
})

test('Run BB lane B: changed evidence or verified progress keeps the generic resume', async t => {
  const changed = await firstReviewResumed(t)
  raiseReview(changed, reviewOf(`${BLOCKER} The only furnace on the map is the copper one.`))
  assert.equal(await changed.session.considerPauseForAutoResume(), true)
  assert.deepEqual(recoveryRows(changed.events, 'recovery.auto_resume_scheduled').map(row => row.attempt), [1, 2])
  assert.equal(recoveryRows(changed.events, 'recovery.review_blocker_unchanged').length, 0)
  clearTimeout(changed.session.modelResume.timer)

  const progressed = await firstReviewResumed(t)
  progressed.memory.recordBoardEvidence(KEY, { kind: 'deterministic_verification', ref: 'batch_8', summary: JSON.stringify({ verdict: 'verified_complete' }) })
  raiseReview(progressed, reviewOf())
  assert.equal(await progressed.session.considerPauseForAutoResume(), true)
  assert.equal(recoveryRows(progressed.events, 'recovery.auto_resume_scheduled').at(-1).attempt, 1, 'progress reset the step count')
  assert.equal(recoveryRows(progressed.events, 'recovery.review_blocker_unchanged').length, 0)
  clearTimeout(progressed.session.modelResume.timer)
})

test('Run BB lane B: the decision survives a memory snapshot and a restart', async t => {
  const run = await firstReviewResumed(t)
  raiseReview(run, reviewOf())
  const restoredMemory = new CanonicalTaskBoardMemory()
  restoredMemory.restore(run.memory.snapshot())
  assert.deepEqual(restoredMemory.reviewBlockerRepeat(KEY), run.memory.reviewBlockerRepeat(KEY))
  assert.equal(restoredMemory.reviewBlockerRepeat(KEY).evidence.digest, reviewOf().digest)

  await run.agent.persistState()
  const world = makeWorld({ stateFile: run.stateFile, mode: 'fail' })
  await world.agent.loadPersistentState()
  assert.equal(world.agent.memory.reviewBlockerRepeat(KEY)?.evidence.digest, reviewOf().digest, 'the evidence came back from disk')
  const restarted = sessionFor(world.agent)
  assert.equal(await restarted.session.considerPauseForAutoResume(), false)
  assert.equal(recoveryRows(world.events, 'recovery.auto_resume_scheduled').length, 0)
  assert.equal(recoveryRows(world.events, 'recovery.review_blocker_unchanged').length, 1)
  assert.equal(world.agent.memory.pauseRecord(KEY).pause_class, 'guard')
})
