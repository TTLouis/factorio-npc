import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { activeStepVerifiedOperationNames, getActivePlan } from './planning-state.mjs'
import { evaluateCompletionContract } from './step-completion.mjs'
import { normalizePlannerReview } from './role-contracts.mjs'
import { executionOnlyControlToolDefinitions } from './structured-policy.mjs'
import { validatesAgainstSchema } from './control-json-repair.mjs'
import { FakeFactorio, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { fireResumeTimer, recoverySession, recoveryWorld, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'

const am = JSON.parse(await fs.readFile(new URL('./fixtures/run-am-receipt-liveness.json', import.meta.url), 'utf8'))
const receiptContract = name => ({ mode: 'all', requirements: [{ id: 'receipt', kind: 'authoritative_operation_receipt', operation_name: name }] })
const proof = name => ({ kind: 'authoritative_operation_receipt', authoritative: true, operation_names: [name] })

test('Run AM exact generic placement requirement accepts verified place_candidate without rewriting either receipt or contract', () => {
  const contract = receiptContract('place_entity')
  const fact = proof('place_candidate')
  assert.equal(evaluateCompletionContract(contract, { receipt: fact }).satisfied, true)
  assert.equal(contract.requirements[0].operation_name, 'place_entity')
  assert.deepEqual(fact.operation_names, ['place_candidate'])
})

test('placement receipt variants are explicit and directional, not inferred from shared native task types', () => {
  for (const [required, actual] of [['place_candidate','place_entity'],['place_entity','execute_construction_plan'],['mine_entity','gather_resource'],['walk_to_entity_exact','walk_to_entity']]) {
    assert.equal(evaluateCompletionContract(receiptContract(required), { receipt: proof(actual) }).satisfied, false)
  }
  for (const extra of [{ authoritative: false }, { stale: true }]) {
    assert.equal(evaluateCompletionContract(receiptContract('place_entity'), { receipt: { ...proof('place_candidate'), ...extra } }).satisfied, false)
  }
})

function replay({ count = 2, verified = true } = {}) {
  const snapshot = structuredClone(am.memory)
  if (!verified) snapshot.plans[0].state.task_board.evidence = snapshot.plans[0].state.task_board.evidence.filter(e => !(e.kind === 'deterministic_verification' && e.step_id === 'step_4'))
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(snapshot)
  const game = new FakeFactorio()
  Object.assign(game.status, { actor_id: am.native.actor_id, epoch: 1, connected_players: 0 })
  const native = game.command.bind(game)
  game.command = async text => text.includes('evaluate_condition') && text.includes('entity_count')
    ? JSON.stringify({ ok: true, kind: 'entity_count', prototype: 'burner-mining-drill', minimum: 2, current: count, found: count, truncated: false, satisfied: count >= 2 })
    : native(text)
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    systemPrompt: 'Run AM recorded receipt replay', stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (_messages, context) => {
      assert.equal(context.triggerSource, 'step_contract', 'only the next step contract may be authored after verified advancement')
      const held = getActivePlan(memory.planningState(am.key))
      return { content: JSON.stringify({ stepId: held.steps[held.active_step_index].step_id,
        checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 2 }] } }) }
    } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: am.key,
    requestInfo: { memoryKey: am.key, turnId: 1, sender: '<server>', text: 'Continue the committed copper cell' },
    traceRequest: { id: 'run-am-recorded-batch21' } })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  return { agent, game, memory, events, plan: () => getActivePlan(memory.planningState(am.key)),
    receipt: { view: { last_completed_batch: am.native.last_completed_batch } } }
}

test('Run AM exact restored batch21, unit17 and frozen copper step close from candidate receipt plus fresh count=2', async () => {
  const w = replay()
  const before = structuredClone(w.plan().steps[3])
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(am.key)), ['place_candidate'])
  const result = await w.agent.routeStepCompletionDecision(w.receipt)
  assert.equal(result.verified, true, JSON.stringify(w.events.slice(-5)))
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.equal(w.plan().active_step_index, 4)
  assert.deepEqual(w.plan().steps[3], before, 'historical committed contract is unchanged')
  assert.equal(w.game.mutations.length, 0, 'no duplicate build, dismantling or receipt-manufacturing operation')
  assert.ok(w.events.some(r => r.event === 'step.receipt_variant_matched' && r.request_id
    && r.data.required_operation === 'place_entity' && r.data.verified_operation === 'place_candidate'))
})

for (const options of [{ count: 1 }, { verified: false }]) {
  test(`Run AM recorded completion stays open without fresh world count or verified same-step receipt ${JSON.stringify(options)}`, async () => {
    const w = replay(options)
    const result = await w.agent.routeStepCompletionDecision(w.receipt)
    assert.equal(result.verified, false)
    assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 3)
    assert.equal(w.game.mutations.length, 0)
  })
}

function refusalWorld(t, { atExhaustion } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new FakeFactorio()
  game.status.connected_players = 0
  const model = new ScriptedModel()
  const world = recoveryWorld({ game, model, completionProtocolVersion: 3 })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  const held = () => getActivePlan(world.memory.planningState('npc:sgluna'))
  model.push('planner', 'committed-step', planReply({ plan: [am.active_step.description], operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-plate', 999) }],
    executionGuidance: [{ ...am.active_step.execution_guidance, skillIds: [] }],
    goal: { scope: 'finite', summary: 'Finish the committed construction task.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 999 }] } }))
  const attempts = world.agent.maxToolValidationRetries + 1
  // Isolate the second AM failure from the repaired receipt path. The original
  // 402-character rationale and tool transport are unchanged. An invalid reason
  // makes this control unrepairable by advisory-length clipping. The exact
  // original review is covered by step-self-correction.test.mjs instead.
  const addInvalidCycle = label => {
    for (let i = 0; i < attempts; i++) model.push('executor', `${label}:${i}`, async () => {
      if (i === attempts - 1) await atExhaustion?.(ctx)
      const decision = { ...am.refused_decision, stepId: held().steps[0].step_id,
        plannerReview: { ...am.refused_decision.plannerReview, reason: 'invalid_reason' } }
      return { ...am.refused_reply, tool_calls: [{ ...am.refused_reply.tool_calls[0], function: { name: 'submitPlan', arguments: JSON.stringify(decision) } }] }
    })
  }
  addInvalidCycle('initial')
  t.after(() => { if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  return { ...ctx, addInvalidCycle, attempts, held }
}

test('Run AM exact 402-character review is invalid under both the transmitted 400-character schema and runtime', () => {
  assert.equal(am.refused_decision.plannerReview.rationale.length, 402)
  const schema = executionOnlyControlToolDefinitions.find(t => t.function.name === 'submitPlan').function.parameters.properties.plannerReview
  assert.equal(schema.properties.rationale.maxLength, am.schema_maximum)
  for (const length of [399, 400, 401, 402]) {
    const review = { ...am.refused_decision.plannerReview, rationale: 'x'.repeat(length) }
    assert.equal(validatesAgainstSchema(review, schema), length <= 400)
    if (length <= 400) assert.deepEqual(normalizePlannerReview(review), review)
    else assert.throws(() => normalizePlannerReview(review), /400/)
  }
  assert.throws(() => normalizePlannerReview(am.refused_decision.plannerReview), /400/)
})

test('candidate placement receipt grounding uses the same directional rule as completion', async () => {
  const w = replay()
  const ground = (required, actual) => w.agent.authoritativeGroundCheckpointRequirement(
    receiptContract(required).requirements[0], { allowedReceiptNames: new Set([actual]) })
  assert.equal((await ground('place_entity', 'place_candidate')).ok, true)
  assert.equal((await ground('place_candidate', 'place_entity')).ok, false)
  assert.equal((await ground('place_entity', 'execute_construction_plan')).ok, false)
})

for (const replacement of ['cancel', 'actor', 'goal', 'version', 'step']) {
  test(`returned-blocked reconciliation cannot pause ${replacement} replacement during native observation`, async () => {
    const w = replay()
    w.agent.readInteractionTaskStatus = async () => {
      if (replacement === 'cancel') w.agent.cancel('user_cancel')
      if (replacement === 'actor') w.game.status.actor_id++
      if (replacement === 'goal') w.memory.planningState(am.key).goal.goal_id = 'replacement-goal'
      if (replacement === 'version') w.plan().plan_version++
      if (replacement === 'step') w.plan().active_step_index++
      return { task_state: 'idle', queue_length: 0 }
    }
    try { await w.agent.blockedWithoutMutation('Run AM exhausted review', 'plan_category', { code: 'invalid_planner_review' }) }
    catch (error) { assert.match(error.message, /cancelled|superseded|epoch/) }
    assert.equal(w.memory.pauseRecord(am.key).paused, false)
    assert.equal(w.events.some(r => r.event === 'request.blocked_plan_paused'), false)
    if (['goal', 'version', 'step'].includes(replacement)) {
      assert.equal(w.agent.active, true, 'old refusal cannot deactivate replacement work')
      assert.equal(w.agent.traceRequest.id, 'run-am-recorded-batch21')
      assert.equal(w.events.some(r => r.event === 'request.completed'), false)
      assert.ok(w.events.some(r => r.event === 'request.blocked_result_dropped' && r.request_id && r.data.reason === 'blocked_decision_owner_superseded'))
    }
    assert.equal(w.game.mutations.length, 0)
  })
}

test('the final base terminal status await also fences replacement work', async () => {
  const w = replay()
  w.agent.readInteractionTaskStatus = async () => ({ task_state: 'placing', queue_length: 1 })
  const assertCurrent = w.agent.assertCurrent.bind(w.agent)
  w.agent.assertCurrent = async () => {
    const status = await assertCurrent()
    w.memory.planningState(am.key).goal.goal_id = 'replacement-at-final-await'
    return status
  }
  const result = await w.agent.blockedWithoutMutation('Run AM exhausted review', 'plan_category', { code: 'invalid_planner_review' })
  assert.equal(result.superseded, true)
  assert.equal(w.agent.active, true)
  assert.equal(w.agent.traceRequest.id, 'run-am-recorded-batch21')
  assert.equal(w.memory.pauseRecord(am.key).paused, false)
  assert.equal(w.events.some(r => r.event === 'request.completed'), false)
  assert.ok(w.events.some(r => r.event === 'request.blocked_result_dropped' && r.request_id))
})

test('unrepairable Run AM-shaped review exhaustion pauses durably and the real Session resumes only within existing 2/step,6/goal limits', async t => {
  const w = refusalWorld(t)
  w.session.queuePlayerRequest('Louis', 'Continue the construction task')
  await settle(w.session)
  const originalSteps = structuredClone(w.held().steps)
  assert.equal(w.world.memory.currentPlan('npc:sgluna').status, 'paused', JSON.stringify({ events: w.world.trace.slice(-8), calls: w.game.commands?.slice(-3) }))
  assert.equal(w.world.memory.pauseRecord('npc:sgluna').pause_class, 'model_recoverable')
  assert.ok(w.session.modelResume?.timer, 'the real activity hook scheduled bounded recovery')
  for (let attempt = 1; attempt <= 2; attempt++) {
    w.addInvalidCycle(`resume${attempt}`)
    await fireResumeTimer(w)
    assert.equal(w.world.memory.currentPlan('npc:sgluna').status, 'paused')
    assert.equal(w.world.memory.autoResumeAllowance('npc:sgluna').goal_attempts, attempt)
  }
  assert.equal(Boolean(w.session.modelResume?.timer), false, 'no third resume')
  assert.ok(w.world.trace.some(r => r.event === 'recovery.auto_resume_exhausted'))
  assert.ok(w.world.trace.some(r => r.event === 'request.blocked_plan_paused' && r.request_id
    && r.data.code === 'invalid_planner_review' && r.data.reason === 'blocked_decision_with_idle_native_runtime'))
  assert.deepEqual(w.held().steps, originalSteps)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.model.calls.length, 1 + 3 * w.attempts, 'correction/resume limits did not expand')
  assert.deepEqual(w.model.violations, [])
  assert.deepEqual(w.model.remaining, [])
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(w.world.memory.snapshot())))
  assert.equal(restored.pauseRecord('npc:sgluna').pause_class, 'model_recoverable')
  assert.equal(restored.autoResumeAllowance('npc:sgluna').goal_attempts, 2)
})

for (const status of ['busy','unknown','pending']) {
  test(`a refused review does not pause native ${status} work`, async t => {
    const w = refusalWorld(t, { atExhaustion: async ctx => {
      if (status === 'pending') ctx.world.memory.pendingOperation = () => ({ state: 'uncertain' })
      else ctx.world.agent.readInteractionTaskStatus = async () => status === 'busy'
        ? { task_state: 'placing', queue_length: 1 } : { status_error: 'unavailable' }
    } })
    w.session.queuePlayerRequest('Louis', 'Continue the construction task')
    await settle(w.session)
    assert.equal(w.world.memory.pauseRecord('npc:sgluna').paused, false)
    assert.equal(Boolean(w.session.modelResume?.timer), false)
    assert.equal(w.game.mutations.length, 0)
  })
}
