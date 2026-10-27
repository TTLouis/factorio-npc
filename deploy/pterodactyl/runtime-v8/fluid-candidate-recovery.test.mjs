import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { candidateWorld, KEY } from './fluid-candidate-recovery-fixtures.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { argumentCorrectionAvailable, restorePlanningState, serializePlanningState, applyPlanningEvent } from './planning-state.mjs'
import { checkFluidPreservationEligibility } from './contract-obligation-runtime.mjs'
import { buildPendingOperation, sanitizePendingOperation } from './operation-reconciliation.mjs'
import { planReply } from './task-loop-fixtures.mjs'

for (const mismatch of [false, true]) test(`fluid candidate lifecycle after retained terminal navigation; host proof mismatch=${mismatch}`, async () => {
  const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8'))
  const w = await candidateWorld()
  let installed = false
  const native = w.game.command.bind(w.game)
  w.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('autorio_operations","status')) return raw
    const status = JSON.parse(raw)
    const planning = w.memory.planningState(KEY)
    const plan = planning?.plans.find(row => row.plan_id === planning.active_plan_id)
    if (!plan) return raw
    if (!installed) {
      const record = { ...ay.pending, goal_id: plan.goal_id, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
        actor: { actor_id: 10, epoch: 3 } }
      assert.ok(w.memory.recordPendingOperation(KEY, record))
      assert.ok(w.memory.clearPendingOperation(KEY, { operationKey: record.operation_key }))
      installed = true
    }
    const admission = structuredClone(ay.native.admission_journal[0])
    Object.assign(admission, { actor_id: 10, epoch: 3 })
    if (mismatch) admission.signature = 'wrong'
    status.admission_journal = [...status.admission_journal, admission]
    status.receipt_journal = [...status.receipt_journal, ...ay.native.receipt_journal]
    return JSON.stringify(status)
  }
  if (mismatch) {
    await assert.rejects(w.start(), /preservation_pre_admission_receipt_boundary_unproven/)
    assert.equal(w.game.mutations.length, 0)
  } else {
    await w.start()
    assert.equal(w.game.mutations.length, 1)
    assert.ok(w.rows.some(row => row.event === 'operations.preflight_recoverable'))
    assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
  }
})

test('early native known-argument eligibility -> durable existing allowance -> fresh certified proposal -> one placement -> unchanged fuel', async () => {
  const w = await candidateWorld()
  await w.start()
  assert.equal(w.game.mutations.length, 1, JSON.stringify(w.rows.filter(row => /failed|paused|refused/.test(row.event)).slice(-4)))
  assert.equal(w.prepared.length, 1, 'bad candidate was rejected before a pending admission')
  assert.ok(w.nativeReads.some(text => text.includes('get_placement_candidates')))
  assert.ok(w.game.mutations[0].includes('placement-2'))
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
  assert.equal(w.agent.modelCorrectablePreflightRetries, 0, 'ordinary success may reset the request counter; durable consumed credit cannot reset')
  const event = w.rows.find(row => row.event === 'operations.preflight_recoverable')
  assert.equal(event.data.retry_budget, 1); assert.equal(event.data.durable_claim, true)
  assert.equal(event.data.zero_send.reason, 'native_idle_journal_absent_exact_unsent_settled')
  assert.equal(event.data.zero_send.operation_key, null)
  assert.deepEqual(w.held().steps, w.originalSteps())
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 2); assert.ok(w.game.mutations[1].includes('supply_entity'))
  assert.equal(w.held().execution.preservation_certificates.length, 1)
  assert.equal(w.held().active_step_index, 1)
})

test('injected early miss reaches actual late helper catch, exact unsent settlement and same automatic continuation', () => {
  const directory = new URL('./', import.meta.url)
  const hook = `import { registerHooks } from 'node:module'; registerHooks({load(url,context,next){ const result=next(url,context); if(!url.endsWith('/runtime-v8/npc-agent-loop.mjs'))return result; const needle='    await checkFluidPreservationEligibility(this, { operations, preflight: results })'; const source=String(result.source); if(!source.includes(needle))throw Error('missing exact prevention seam');return {...result,source:source.replace(needle,'    // injected prevention miss')};}})`
  const driver = `import assert from 'node:assert/strict'; import {candidateWorld,KEY} from ${JSON.stringify(new URL('./fluid-candidate-recovery-fixtures.mjs', directory).href)};
const w=await candidateWorld();await w.start();assert.equal(w.game.mutations.length,1,JSON.stringify(w.rows.filter(row=>/failed|refused|paused/.test(row.event)).slice(-4)));assert.equal(w.prepared.length,2);
const notSent=w.rows.find(row=>row.event==='operation.not_sent');assert.ok(notSent);const retry=w.rows.find(row=>row.event==='operations.preflight_recoverable');assert.equal(retry.data.zero_send.operation_key,notSent.data.operation_key);assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length,1);assert.deepEqual(w.held().steps,w.originalSteps());await w.agent.completed();assert.equal(w.held().active_step_index,1);assert.equal(w.game.mutations.length,2);assert.equal(w.held().execution.preservation_certificates.length,1);console.log(JSON.stringify({actual_late_catch:true,old_key:notSent.data.operation_key,placements:1,certificates:1,unchanged_next_step:true}));`
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, '--input-type=module', '-e', driver], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('second known argument mistake exhausts ONE credit; restore/restage/new request cannot renew it', async () => {
  const w = await candidateWorld({ repeated: true })
  await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
  assert.equal(w.rows.filter(row => row.event === 'operations.preflight_recoverable').length, 1)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  const state = restored.planningState(KEY)
  state.run.paused = false
  assert.equal(argumentCorrectionAvailable(state), false)
  state.plans.find(plan => plan.plan_id === state.active_plan_id).plan_id += '_successor'
  state.active_plan_id += '_successor'
  assert.equal(argumentCorrectionAvailable(state), false)
})

for (const [label, change] of [
  ['old-missing-dto', result => { delete result.preservation_eligibility }],
  ['wrong-actor', result => { result.preservation_eligibility.actor_id++ }],
  ['wrong-surface', result => { result.preservation_eligibility.surface_index++ }],
  ['wrong-candidate', result => { result.preservation_eligibility.candidate_id = 'other' }],
  ['clearing', result => { result.preservation_clears_count = 1 }],
  ['unknown-version', result => { result.preservation_eligibility.version = 2 }],
]) test(`unknown/unsafe ${label} cannot become known argument credit`, async () => {
  const w = await candidateWorld({ response: ({ text }) => {
    if (text.includes('autorio_preflight') && text.includes('place_candidate')) {
      const result = { ok: true, preservation_clears_count: 0, preservation_eligibility: { version: 1, kind: 'relation_required',
        actor_id: 10, surface_index: 1, force_index: 1, candidate_set_id: 'placement-1', candidate_id: 'candidate-1',
        entity_name: 'boiler', generated_tick: 80, observed_tick: 90, fluid_port_count: 3 } }
      change(result); return result
    }
  } })
  await assert.rejects(w.start(), /preservation_/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 0)
  assert.equal(w.rows.filter(row => row.event === 'operations.preflight_recoverable').length, 0)
})

for (const seam of ['persist', 'trace']) for (const action of ['amendment', 'cancel', 'intake', 'busy', 'session', 'epoch', 'native_queue', 'revoke']) {
  test(`actual correction ${seam} ${action} keeps zero-send and cannot wake executor`, async () => {
    let injected = false; let amendment; let callsAtInjection
    const inject = ({ agent, memory, game }) => {
      if (injected || memory.planningState(KEY)?.goal?.argument_corrections?.claims.length !== 1) return
      injected = true; callsAtInjection = w.calls.length
      if (action === 'amendment') agent.pendingInteractionAmendment = amendment = { text: 'owner change during correction' }
      if (action === 'cancel') agent.cancel('user_stop_immediate')
      if (action === 'intake') agent.requestAdmissionOwner = { newer: true }
      if (action === 'busy') agent.batchInFlight = true
      if (action === 'session') game.status.session = 'changed-native-session'
      if (action === 'epoch') game.status.epoch++
      if (action === 'native_queue') { game.taskState = 'working'; game.queueLength = 1 }
      if (action === 'revoke') memory.revokeAuthorization(KEY, memory.currentGoalGrant(KEY).grant_id, { reason: 'owner revoked during correction' })
    }
    const w = await candidateWorld(seam === 'persist' ? { persist: inject } : { trace: context => { if (context.row.event === 'operations.preflight_recoverable') inject(context) } })
    await assert.rejects(w.start(), /cancelled|superseded|preservation_|epoch changed|argument_correction_authority_changed/i)
    assert.equal(injected, true); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.calls.length, callsAtInjection, 'no subsequent model request after the owner/safety change')
    if (action === 'amendment') assert.equal(w.agent.pendingInteractionAmendment, amendment)
    assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1, 'interrupted durable claim cannot renew')
  })
}

test('missing or malformed legacy ledger/lineage cannot restore as a fresh allowance', async () => {
  const w = await candidateWorld({ repeated: true })
  await assert.rejects(w.start())
  const original = serializePlanningState(w.memory.planningState(KEY))
  for (const change of [state => { delete state.goal.argument_corrections }, state => { state.goal.argument_corrections = null },
    state => { state.goal.argument_corrections.claims = [{ semantic_step_id: 'bad' }] },
    state => { state.goal.argument_corrections.claims[0].plan_version++ }, state => { state.goal.argument_corrections.claims[0].goal_id = 'other' },
    state => { state.goal.argument_corrections = { ...state.goal.argument_corrections, goal_id: 'copied-empty-goal', claims: [] } },
    state => { state.goal.argument_corrections = { ...state.goal.argument_corrections, initialized_at: state.goal.created_at + 1, claims: [] } }]) {
    const raw = structuredClone(original); change(raw)
    const restored = restorePlanningState(raw); restored.run.paused = false
    assert.equal(argumentCorrectionAvailable(restored), false)
  }
})

test('generic argument correction and fluid candidate correction share the SAME request and semantic allowance', async () => {
  let first = true
  const w = await candidateWorld({ repeated: true, response: ({ text }) => {
    if (first && text.includes('autorio_preflight') && text.includes('place_candidate')) {
      first = false
      return { ok: false, code: 'invalid_fixture_argument', refusal_class: 'argument' }
    }
  } })
  await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  assert.equal(w.game.mutations.length, 0)
  const retries = w.rows.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(retries.length, 1); assert.equal(retries[0].data.preflight.code, 'invalid_fixture_argument')
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
})

test('a consumed old in-memory request allowance cannot be bypassed by an empty durable ledger', async () => {
  const w = await candidateWorld({ response: ({ text, agent }) => {
    if (text.includes('autorio_preflight') && text.includes('place_candidate')) agent.modelCorrectablePreflightRetries = 1
  } })
  await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 0)
})

test('legacy absence at the actual correction boundary is unproven, not lazily initialized', async () => {
  const w = await candidateWorld({ response: ({ text, memory }) => {
    if (text.includes('autorio_preflight') && text.includes('place_candidate')) delete memory.planningState(KEY).goal.argument_corrections
  } })
  await assert.rejects(w.start(), /argument_correction_lineage_unproven/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(Object.hasOwn(w.memory.planningState(KEY).goal, 'argument_corrections'), false)
})

for (const [label, journal] of [['unreadable', () => null], ['unresolved', () => [{ operation_key: 'another', state: 'admitting' }]]]) {
  test(`actual ${label} native journal cannot certify zero-send argument correction`, async () => {
    const w = await candidateWorld({ journal })
    await assert.rejects(w.start(), /preservation_pre_admission_receipt_boundary_unproven/)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 0)
  })
}

test('normal >64-plan churn pins consumed claim origin, active plan and active native-proof dependency without renewing credit', async () => {
  const w = await candidateWorld(); await w.start()
  const raw = serializePlanningState(w.memory.planningState(KEY)); raw.run.paused = false
  const origin = raw.plans[0]
  const future = index => {
    const plan = structuredClone(origin); plan.plan_id = `${origin.goal_id}_future_${index}`
    plan.status = index === 75 ? 'COMMITTED' : 'COMPLETED'; plan.active_step_index = 0
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]; step.step_id = `${plan.plan_id}_s${i}`; step.semantic_step_id = step.step_id
      if (step.obligation_proof?.binding) Object.assign(step.obligation_proof.binding, { plan_id: plan.plan_id,
        step_id: step.step_id, semantic_step_id: step.semantic_step_id })
    }
    return plan
  }
  raw.plans = [origin, ...Array.from({ length: 75 }, (_, index) => future(index + 1))]
  const dependency = raw.plans[1]; const active = raw.plans.at(-1)
  active.steps[0].obligation_proof.binding.plan_id = dependency.plan_id
  active.steps[0].obligation_proof.binding.step_id = dependency.steps[0].step_id
  active.steps[0].obligation_proof.binding.semantic_step_id = dependency.steps[0].semantic_step_id
  active.steps[0].semantic_step_id = dependency.steps[0].semantic_step_id
  raw.active_plan_id = active.plan_id
  const restored = restorePlanningState(raw)
  assert.equal(restored.plans.length, 64)
  for (const id of [origin.plan_id, dependency.plan_id, active.plan_id]) assert.ok(restored.plans.some(plan => plan.plan_id === id), id)
  assert.equal(restored.goal.argument_corrections.claims.length, 1)
  assert.equal(argumentCorrectionAvailable(restored), true, 'unrelated semantic step retains existing credit after normal origin churn')
  const altered = structuredClone(restored)
  altered.plans.find(plan => plan.plan_id === active.plan_id).steps[0].semantic_step_id = origin.steps[0].semantic_step_id
  assert.equal(argumentCorrectionAvailable(altered), false, 'old semantic identity never receives another correction')
})

for (const seam of ['persist', 'trace']) for (const generic of [false, true]) test(`actual planner handback and stageCompatibleAmendment during ${generic ? 'generic' : 'fluid'} correction ${seam} retain owning conversation`, async () => {
  let injected = false; let staged; let calls
  const inject = async ({ agent, memory }) => {
    if (injected || memory.planningState(KEY)?.goal?.argument_corrections?.claims.length !== 1) return
    injected = true; calls = w.calls.length
    // stageCompatibleAmendment correctly refuses an open executor round. Use
    // the existing safe in-turn handback API, then stage in that real planner
    // conversation; no fake canonical amendment or direct flag assignment.
    const returned = await agent.returnControlToPlanner({ route: 'amend_current', withinTurn: true,
      reason: 'user_amendment', planningState: memory.planningState(KEY), requestId: agent.traceRequest?.id })
    assert.equal(returned.returned, true)
    assert.equal(await agent.stageCompatibleAmendment('Louis', 'Hold this work for a compatible owner instruction.'), true,
      JSON.stringify({ active: agent.active, epoch: agent.epoch, base: Array.isArray(agent.baseMessages), events: w.rows.slice(-5) }))
    staged = agent.currentPendingAmendment(); assert.ok(staged)
    assert.equal(agent.pendingAmendmentConversationSeq, agent.agentContext.conversationSeq)
  }
  let first = true
  const w = await candidateWorld({
    ...(seam === 'persist' ? { persist: inject } : { trace: context => context.row.event === 'operations.preflight_recoverable' ? inject(context) : undefined }),
    response: generic ? ({ text }) => {
      if (first && text.includes('autorio_preflight') && text.includes('place_candidate')) {
        first = false; return { ok: false, code: 'invalid_fixture_argument', refusal_class: 'argument' }
      }
    } : undefined,
  })
  await assert.rejects(w.start(), /cancelled|superseded|preservation_/i)
  assert.equal(injected, true); assert.equal(w.calls.length, calls); assert.equal(w.game.mutations.length, 0)
  assert.equal(w.agent.currentPendingAmendment(), staged)
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
  // Existing conversation contract: a later discarded conversation drops the
  // amendment and records that loss; it never renews the durable claim.
  w.agent.agentContext.conversationSeq++
  assert.equal(w.agent.currentPendingAmendment(), null)
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
})

test('actual Memory restore plus request-counter reset and new request identity cannot spend the semantic credit again', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot()); w.agent.memory = restored
  const state = restored.planningState(KEY)
  restored.dispatchPlanningEvent(KEY, { type: 'RUN_RESUMED', source: 'runtime', goal_id: state.goal.goal_id, now: Date.now(), reason: 'offline restore-boundary substitution' })
  w.agent.modelCorrectablePreflightRetries = 0
  w.agent.traceRequest = { id: 'offline-restored-request', seq: 0 }
  // Explicit future fixture re-entry prerequisites, not an automatic resume of
  // historical AX: the normal guard remains a nonresumable pause.
  w.agent.active = true; w.agent.epoch = await w.agent.captureEpoch()
  const operations = [{ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }]
  const preflight = [{ ok: true, preservation_clears_count: 0, preservation_eligibility: { version: 1, kind: 'relation_required',
    actor_id: 10, surface_index: 1, force_index: 1, candidate_set_id: 'placement-1', candidate_id: 'candidate-1',
    entity_name: 'boiler', generated_tick: 80, observed_tick: 90, fluid_port_count: 3 } }]
  let error
  try { await checkFluidPreservationEligibility(w.agent, { operations, preflight }) } catch (caught) { error = caught }
  assert.equal(error?.code, 'preservation_candidate_relation_required', String(error))
  const calls = w.calls.length
  await assert.rejects(w.agent.recoverArgumentPreflight(error, { operations }, {}), /argument_correction_limit_exhausted/)
  assert.equal(w.calls.length, calls); assert.equal(w.game.mutations.length, 0)
  assert.equal(restored.planningState(KEY).goal.argument_corrections.claims.length, 1)
})

test('duplicate GOAL_ACCEPTED for the same immutable goal cannot reinitialize its consumed allowance', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start())
  const state = w.memory.planningState(KEY)
  const duplicate = applyPlanningEvent(state, { type: 'GOAL_ACCEPTED', source: 'runtime', goal_id: state.goal.goal_id,
    objective: 'A duplicate event must not erase the old objective or claims.', now: Date.now() })
  assert.equal(duplicate, state); assert.deepEqual(duplicate.goal.argument_corrections, state.goal.argument_corrections)
  const newGoal = applyPlanningEvent(state, { type: 'GOAL_ACCEPTED', source: 'runtime', objective: 'A genuinely new owner goal.', now: Date.now() })
  assert.notEqual(newGoal.goal.goal_id, state.goal.goal_id)
  assert.equal(newGoal.goal.argument_corrections.goal_id, newGoal.goal.goal_id)
  assert.equal(newGoal.goal.argument_corrections.initialized_at, newGoal.goal.created_at)
  assert.deepEqual(newGoal.goal.argument_corrections.claims, [])
})

test('argument allowance remains durable execution state and never leaks through model planning context', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start())
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 1)
  const context = w.memory.planningContext(KEY)
  assert.equal(context.includes('argument_corrections'), false)
  assert.equal(context.includes('operation_signature'), false)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.deepEqual(restored.planningState(KEY).goal.argument_corrections, w.memory.planningState(KEY).goal.argument_corrections)
  assert.equal(restored.planningContext(KEY).includes('argument_corrections'), false)
})

test('inactive model recovery stop is scope-bound and preserves every native and authority owner', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start())
  const state = structuredClone(w.memory.planningState(KEY)); state.goal.status = 'completed'; state.run.paused = false
  const plan = state.plans.find(row => row.plan_id === state.active_plan_id); const step = plan.steps[plan.active_step_index]
  const event = { type: 'RUN_MODEL_RECOVERY_STOPPED', source: 'runtime', goal_id: state.goal.goal_id,
    now: Date.now(), goal_status: 'completed', plan_id: plan.plan_id, plan_version: plan.plan_version,
    step_id: step.step_id, request_id: 'offline-inactive-goal', native_idle: false }
  const guarded = applyPlanningEvent(state, event)
  assert.equal(guarded.run.paused, false); assert.equal(guarded.run.model_recovery_stop.native_idle, false)
  assert.deepEqual(guarded.goal, state.goal); assert.deepEqual(guarded.plans, state.plans)
  assert.equal(applyPlanningEvent(guarded, { type: 'GOAL_ACCEPTED', source: 'runtime', goal_id: state.goal.goal_id,
    objective: state.goal.objective, now: Date.now() }), guarded)
  for (const change of [row => { row.source = 'planner' }, row => { row.goal_id = 'other' },
    row => { row.plan_id = 'other' }, row => { row.plan_version++ }, row => { row.step_id = 'other' },
    row => { row.goal_status = 'cancelled' }, row => { delete row.request_id }]) {
    const invalid = structuredClone(event); change(invalid)
    assert.equal(applyPlanningEvent(state, invalid).run.model_recovery_stop, undefined)
  }
  const record = sanitizePendingOperation(buildPendingOperation({ operationKey: 'unresolved-effect', requestId: 'owned-request',
    protocolVersion: 2, goalId: state.goal.goal_id, planId: plan.plan_id, stepId: step.step_id,
    actor: { actor_id: 10, epoch: 3, session: 'fixture' }, operations: [{ name: 'wait', args: { ticks: 60 } }], now: 1 }))
  assert.ok(record)
  for (const shape of ['ledger', 'legacy']) for (const pause of ['operator', 'authority']) {
    const pending = structuredClone(state)
    pending.run = { ...pending.run, paused: true, pause_class: pause, pause_reason: 'owned stop',
      condition_wait: { id: 'owned-wait' }, persistent_runtime: { id: 'owned-controller' } }
    pending.run.pending_operation = record
    if (shape === 'ledger') pending.operation_ledger = { version: 1, sequence: 1, records: [record], closed: [] }
    const stopped = applyPlanningEvent(pending, event)
    const { model_recovery_stop, ...run } = stopped.run
    assert.ok(model_recovery_stop); assert.deepEqual(run, pending.run)
    const restored = restorePlanningState(serializePlanningState(stopped))
    assert.deepEqual(restored.run.condition_wait, pending.run.condition_wait)
    assert.deepEqual(restored.run.persistent_runtime, pending.run.persistent_runtime)
    assert.equal(restored.operation_ledger.records.length, 1)
    assert.deepEqual(restored.goal, pending.goal)
  }
})

test('current-schema malformed or missing goal status fails closed on restore with exact consumed ledger and both pending shapes', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start())
  const original = w.memory.snapshot()
  for (const status of ['active', 'completed', 'cancelled', 'paused', ' active ', 'active\n', ['active'], undefined, null, '']) for (const shape of ['ledger', 'legacy']) {
    const snapshot = structuredClone(original)
    const state = snapshot.planning_states.find(row => row.key === KEY).state
    const plan = state.plans.find(row => row.plan_id === state.active_plan_id)
    const pending = sanitizePendingOperation(buildPendingOperation({ operationKey: 'restore-owned-effect', requestId: 'restore-request',
      protocolVersion: 2, goalId: state.goal.goal_id, planId: plan.plan_id, stepId: plan.steps[plan.active_step_index].step_id,
      actor: { actor_id: 10, epoch: 3 }, operations: [{ name: 'wait', args: { ticks: 1 } }], now: 1 }))
    if (status === undefined) delete state.goal.status
    else state.goal.status = status
    if (shape === 'ledger') state.operation_ledger = { version: 1, sequence: 1, records: [pending], closed: [] }
    else { delete state.operation_ledger; state.run.pending_operation = pending }
    const restored = new CanonicalTaskBoardMemory(); restored.restore(snapshot)
    const after = restored.planningState(KEY)
    assert.equal(after.goal.status, typeof status === 'string' && status ? status : 'invalid')
    assert.equal(after.goal.goal_id, state.goal.goal_id)
    assert.equal(after.goal.objective, state.goal.objective)
    assert.deepEqual(after.goal.argument_corrections, state.goal.argument_corrections)
    assert.deepEqual(restored.pendingOperations(KEY), [pending])
    if (status !== 'active') {
      w.agent.memory = restored
      const calls = w.calls.length; const mutations = w.game.mutations.length
      await assert.rejects(w.agent.callProviderRound(w.agent.epoch, w.agent.generation, { round: 1 }), /inactive_goal_recovery_refused/)
      await assert.rejects(w.agent.recordPendingOperationBeforeSend([{ name: 'wait', args: { ticks: 1 } }], w.agent.epoch), /inactive_goal_recovery_refused/)
      assert.equal(w.calls.length, calls); assert.equal(w.game.mutations.length, mutations)
      assert.deepEqual(restored.pendingOperations(KEY), [pending])
    }
  }
  // Pre-canonical Task Board Lite migration has explicit admitted-work
  // provenance and still mints its ACTIVE goal through GOAL_ACCEPTED.
  const legacy = structuredClone(original); delete legacy.planning_states
  const restored = new CanonicalTaskBoardMemory(); restored.restore(legacy)
  assert.equal(restored.planningState(KEY).goal.status, 'active')
  assert.equal(restored.planningState(KEY).goal.objective, w.memory.planningState(KEY).goal.objective)
})

for (const seam of ['prepared_persist', 'operations_admit', 'late_preflight']) test(`goal terminal at ${seam} refuses native transport and settles only its exact unsent record`, async () => {
  let injected = false; let prepared; let unrelated
  const terminate = ({ memory }) => {
    if (injected) return
    const records = memory.pendingOperations(KEY)
    if (!records.length) return
    injected = true; prepared = structuredClone(records.at(-1))
    const state = memory.planningState(KEY)
    unrelated = { ...structuredClone(prepared), operation_key: `${prepared.operation_key}-unrelated`, attempt_id: 'unrelated-native-owner' }
    state.operation_ledger = { ...state.operation_ledger, records: [...state.operation_ledger.records, unrelated] }
    state.run = { ...state.run, pending_operation: unrelated }
    memory.planningByNpc.set(KEY, { ...state, goal: { ...state.goal, status: 'cancelled' } })
  }
  const w = await candidateWorld({
    persist: seam === 'prepared_persist' ? terminate : undefined,
    trace: seam === 'operations_admit' ? context => { if (context.row.event === 'operations.admit') terminate(context) } : undefined,
    response: seam === 'late_preflight' ? context => { if (context.text.includes('fluid_preservation_candidate') && context.text.includes('placement-2')) terminate(context) } : undefined,
  })
  await w.start()
  assert.equal(injected, true)
  assert.equal(w.game.mutations.length, 0)
  assert.deepEqual(w.memory.pendingOperations(KEY), [unrelated])
  const closed = w.memory.planningState(KEY).operation_ledger.closed.find(row => row.operation_key === prepared.operation_key)
  assert.equal(closed.effect, 'not_happened')
  assert.equal(w.memory.planningState(KEY).goal.status, 'cancelled')
  assert.equal(w.rows.filter(row => row.event === 'request.completed' && row.data.outcome === 'inactive_goal_recovery_stopped').length, 1)
})

test('malformed and other-goal stop markers fail closed without bypassing paused restore invariants', async () => {
  const w = await candidateWorld({ repeated: true }); await assert.rejects(w.start())
  const raw = serializePlanningState(w.memory.planningState(KEY))
  for (const marker of [true, 'invalid', {}, { goal_id: 'other' }, { version: 1, source: 'planner', goal_id: raw.goal.goal_id }, { value: 'x'.repeat(9000) }]) {
    const invalid = structuredClone(raw)
    invalid.run.model_recovery_stop = marker
    invalid.run.condition_wait = { id: 'invalid-owner' }; invalid.run.persistent_runtime = { id: 'invalid-controller' }
    const restored = restorePlanningState(invalid)
    assert.equal(restored.run.model_recovery_stop_fault, true)
    assert.equal(restored.run.model_recovery_stop, undefined)
    assert.equal(restored.run.condition_wait, null); assert.equal(restored.run.persistent_runtime, null)
    assert.deepEqual(restored.goal.argument_corrections, raw.goal.argument_corrections)
    assert.equal(applyPlanningEvent(restored, { type: 'RUN_RESUMED', source: 'runtime', goal_id: restored.goal.goal_id,
      reason: 'must remain fenced', now: Date.now() }), restored)
    w.memory.planningByNpc.set(KEY, restored)
    assert.throws(() => w.agent.assertModelRecoveryAllowed(), /model_recovery_stop_invalid/)
    assert.equal(restorePlanningState(serializePlanningState(restored)).run.model_recovery_stop_fault, true)
  }
})

// --- Run BB lane C (2026-10-26): the exhausted-correction guard names what spent and what tripped the credit ---

const STOCK_UNVERIFIED = { ok: false, code: 'batch_stock_unverified_dependency', refusal_class: 'argument', operation: 'place_candidate', operation_index: 0 }
const NOT_RECIPE_MACHINE = { ok: false, code: 'not_recipe_machine', refusal_class: 'argument', operation: 'set_machine_recipe', operation_index: 0,
  field: 'unit_number', identity: 23, observed_type: 'furnace', expected_type: 'assembling-machine' }
const setRecipe = unit => ({ name: 'set_machine_recipe', args: { unit_number: unit, recipe_name: 'iron-plate' } })
const observeFurnace = (agent, unit, type) => agent.recordLiveEntityObservation({ name: 'stone-furnace', ...(type ? { type } : {}), unit_number: unit,
  position: { x: 5, y: 5 } }, undefined, 'getNearbyEntities')

test('run BB lane C: batch_stock refusal spends the step claim, a later not_recipe_machine exhausts it, and the guard names both refusals', async () => {
  let preflights = 0
  const w = await candidateWorld({
    response: ({ text }) => {
      if (!text.includes('autorio_preflight')) return undefined
      if (text.includes('set_machine_recipe')) return NOT_RECIPE_MACHINE
      if (text.includes('place_candidate') && preflights++ === 0) return STOCK_UNVERIFIED
    },
    executor: ({ agent, step, round }) => {
      if (round === 0) return undefined // the first reply is the default place_candidate batch, refused batch_stock_unverified_dependency
      // The in-memory counter starts over (a passed preflight or a restage does that); only the durable claim remains.
      agent.modelCorrectablePreflightRetries = 0
      observeFurnace(agent, 23) // type not read: the mod's own preflight is the one that refuses it
      return planReply({ stepId: step.step_id, operations: [setRecipe(23)] })
    },
  })
  await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  assert.equal(w.game.mutations.length, 0, 'neither refused batch reached the game')
  const claims = w.memory.planningState(KEY).goal.argument_corrections.claims
  assert.equal(claims.length, 1)
  assert.deepEqual([claims[0].reason, claims[0].operation_index, claims[0].operation_name], ['batch_stock_unverified_dependency', 0, 'place_candidate'])

  const refused = w.rows.filter(row => row.event === 'contract.preservation_refused').at(-1)
  assert.equal(refused.data.code, 'argument_correction_limit_exhausted')
  assert.equal(refused.data.disposition, 'classified_guard_pause')
  assert.deepEqual([refused.data.preflight_code, refused.data.refusal_class, refused.data.operation_index, refused.data.operation_name],
    ['not_recipe_machine', 'argument', 0, 'set_machine_recipe'])
  assert.equal(refused.data.prior_claims.length, 1)
  assert.deepEqual([refused.data.prior_claims[0].reason, refused.data.prior_claims[0].operation_index, refused.data.prior_claims[0].operation_name],
    ['batch_stock_unverified_dependency', 0, 'place_candidate'])
  assert.ok(refused.data.prior_claims[0].request_id); assert.ok(Number.isFinite(refused.data.prior_claims[0].at))
  assert.deepEqual([refused.data.in_memory_retries, refused.data.retry_limit, refused.data.ledger_claims, refused.data.ledger_claim_cap], [0, 1, 1, 64])
  assert.equal(refused.data.semantic_step_id, claims[0].semantic_step_id)
  const failed = w.rows.filter(row => row.event === 'request.failed').at(-1)
  assert.equal(failed.data.failure_snapshot.guard.preflight_code, 'not_recipe_machine', 'the failed-request snapshot carries the same detail')

  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_class], [true, 'guard'])
  assert.match(record.pause_reason, /^argument_correction_limit_exhausted: /)
  const paused = w.rows.filter(row => row.event === 'goal.paused')
  assert.ok(paused.length >= 1)
  for (const row of paused) assert.deepEqual([row.data.provider_failure, row.data.cause], [false, 'argument_correction_limit_exhausted'], row.data.pause_reason)
})

test('run BB lane C: set_machine_recipe on a furnace the live read named is refused at parse, before the durable claim, and the corrected reply proceeds', async () => {
  const w = await candidateWorld({
    executor: ({ agent, step, round }) => {
      if (round !== 0) return undefined
      observeFurnace(agent, 23, 'furnace')
      return planReply({ stepId: step.step_id, operations: [setRecipe(23)] })
    },
  })
  await w.start()
  assert.equal(w.nativeReads.some(text => text.includes('set_machine_recipe')), false, 'no preflight or send named the doomed operation')
  assert.equal(w.game.mutations.some(text => text.includes('set_machine_recipe')), false)
  const classified = w.rows.find(row => row.event === 'recovery.classified' && row.data.reason_code === 'recipe_machine_not_configurable')
  assert.ok(classified, 'an ordinary parse correction')
  assert.deepEqual([classified.data.failure_class, classified.data.operation_name, classified.data.observed_type], ['plan_category', 'set_machine_recipe', 'furnace'])
  assert.match(classified.data.reason, /furnace.*selected automatically from the items placed in it/)
  assert.equal(w.rows.filter(row => row.event === 'operations.preflight_recoverable').length, 0, 'no argument correction was consumed')
  assert.equal(w.memory.planningState(KEY).goal.argument_corrections.claims.length, 0)
  assert.equal(w.game.mutations.length, 1, 'the corrected reply placed the boiler')
  assert.ok(w.game.mutations[0].includes('place_candidate'))
})

test('run BB lane C: a claim row restores with or without the optional operation fields, and malformed ones restore invalid', async () => {
  const w = await candidateWorld({ response: ({ text }) => text.includes('autorio_preflight') && text.includes('place_candidate')
    ? { ok: false, code: 'invalid_fixture_argument', refusal_class: 'argument', operation_index: 0 } : undefined })
  await w.start()
  const original = serializePlanningState(w.memory.planningState(KEY))
  const row = original.goal.argument_corrections.claims[0]
  assert.deepEqual([row.operation_index, row.operation_name], [0, 'place_candidate'])
  const restore = change => { const raw = structuredClone(original); change(raw.goal.argument_corrections.claims[0]); return restorePlanningState(raw).goal.argument_corrections }
  assert.equal(restore(claim => claim).claims.length, 1)
  const legacy = restore(claim => { delete claim.operation_index; delete claim.operation_name })
  assert.equal(legacy.invalid, undefined); assert.equal(legacy.claims.length, 1)
  for (const change of [claim => { claim.operation_index = -1 }, claim => { claim.operation_index = '0' }, claim => { claim.operation_name = 7 },
    claim => { claim.operation_name = 'x'.repeat(81) }, claim => { claim.extra = true }]) {
    assert.equal(restore(change).invalid, true)
  }
})
