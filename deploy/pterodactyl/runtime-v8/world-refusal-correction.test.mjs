import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { EXECUTOR_REFUSAL_UNCORRECTED_REASON, NpcAgentLoop, worldRefusalCorrectionMessage, worldRefusalFacts, WORLD_REFUSAL_UNCORRECTED_REASON } from './npc-agent-loop.mjs'
import { MODEL_RECOVERABLE_OUTCOME_REASONS, validateOutcomeCandidate } from './outcome-authority.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { formatTaskCondition, pauseStrandedPlanAfterRequestError, Session } from './supervisor.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Unit 12 (run G, 2026-10-14). A world-class preflight refusal that is not a harness-evidenced structural blocker used to end the
// request with the step blocked and nothing to wake an idle NPC. It now gets one correction turn carrying the refusal's facts;
// a second refusal pauses the plan as model_recoverable, which the supervisor resumes. Static scenarios: the real NpcAgentLoop
// against a fake Factorio with scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const ore = inventoryCheckpoint('iron-ore', 10)
const plates = inventoryCheckpoint('iron-plate', 10)
const gears = inventoryCheckpoint('iron-gear-wheel', 5)
const det = checkpoint => ({ kind: 'deterministic', checkpoint })
const GOAL = { scope: 'finite', summary: 'Craft 5 iron gear wheels.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 5 }] }
const OBJECTIVE = 'Craft 5 iron gear wheels from ore you mine and smelt.'
const IRON_PLAN = ['Gather 10 iron ore', 'Smelt the ore into iron plates in the furnace', 'Craft 5 iron gear wheels']
const FURNACE = 34

// The preflight object of run G: the mod's supply_missing result for the three-item supply (coal, iron-ore and copper-ore), where
// iron-ore and copper-ore share the furnace's sole one-slot source inventory. The loop turns it into supply_destination_conflict.
const RUN_G_TRANSFER = {
  ok: false,
  code: 'supply_missing',
  operation: 'supply_entity',
  field: 'unit_number',
  identity: FURNACE,
  target: { unit_number: FURNACE, name: 'stone-furnace', position: { x: 23, y: -72 }, surface_index: 1, force_index: 1 },
  transfer: {
    direction: 'to_entity',
    items: [
      { item_name: 'coal', requested: 10, source_count: 0, destination_accepts: 50, expected_moved: 0, missing: 10, status: 'supply_missing', single_slot_destination: { inventory_index: 1, slot_count: 1 } },
      { item_name: 'iron-ore', requested: 50, source_count: 50, destination_accepts: 50, expected_moved: 50, missing: 0, status: 'ok', single_slot_destination: { inventory_index: 2, slot_count: 1 } },
      { item_name: 'copper-ore', requested: 10, source_count: 10, destination_accepts: 50, expected_moved: 10, missing: 0, status: 'ok', single_slot_destination: { inventory_index: 2, slot_count: 1 } },
    ],
  },
  refusal_class: 'world',
}

const plannerDraft = () => planReply({
  plan: IRON_PLAN,
  currentStep: 0,
  operations: [gather('iron-ore', 10)],
  checkpoint: ore,
  goal: GOAL,
  stepCompletions: [det(ore), det(plates), det(gears)],
})
const observation = () => ({ content: null, tool_calls: [{ id: 'call_obs', index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }] })
const supply = items => ({ name: 'supply_entity', args: { unit_number: FURNACE, items } })
const RUN_G_BATCH = () => [gather('coal', 10), supply([{ item_name: 'coal', count: 10 }, { item_name: 'iron-ore', count: 50 }, { item_name: 'copper-ore', count: 10 }])]
const CORRECTED_BATCH = () => [gather('coal', 10), supply([{ item_name: 'coal', count: 10 }, { item_name: 'iron-ore', count: 50 }])]
const executor = operations => planReply({ plan: IRON_PLAN, currentStep: 1, operations })

// Refuses a supply that names more than one ore (the shared slot); anything else passes.
function gameRefusing(refusal = RUN_G_TRANSFER, when = text => text.includes("'supply_entity'") && text.includes('copper-ore')) {
  const game = new FakeFactorio({
    preflight: text => (when(text) ? refusal : { ok: true }),
  })
  game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: FURNACE, position: { x: 23, y: -72 }, distance: 8 }] }
  return game
}

function world(script, { game = gameRefusing(), provider: roleProvider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  const calls = []
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    completionProtocolVersion: 2,
    replacementWake: true,
    provider: answersStepContract(async (messages, context) => {
      calls.push(messages.map(message => ({ ...message })))
      if (roleProvider) return roleProvider(messages, context)
      const reply = script[calls.length - 1]
      assert.ok(reply, `unscripted provider call ${calls.length}`)
      return { ...reply }
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'world refusal fixture',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  // retries is the world-correction counter at the moment the row was written.
  // The row ts is strictly increasing (the live log is 15 s apart between restages; here they would share a millisecond), so run-check
  // orders rows of different requests as they were written.
  agent.behaviorTrace = { emit: async (record) => { rows.push({ ...record, ts: new Date(1_800_000_000_000 + rows.length).toISOString(), retries: agent.worldCorrectionRetries }) } }
  const named = name => rows.filter(row => row.event === name)
  const planning = () => memory.planningState(KEY)
  return { agent, memory, game, rows, calls, named, planning }
}

// Step 1 is verified by the game; the executor then sends its batch.
async function runToExecutor(w) {
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  return w.agent.completed()
}

const harnessMessages = calls => calls.flat().map(message => (typeof message.content === 'string' ? message.content : '')).filter(text => text.startsWith('[HARNESS]'))

function sessionFor(agent) {
  const chat = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent,
    npcId: 'sgluna',
    stopping: false,
    autoResume: null,
    modelResume: null,
    lastPauseDecision: '',
    lastStatus: { actor_id: 18, epoch: 3 },
    liveStatus: { actor_id: 18, epoch: 3 },
    log: () => {},
    printChat: async (message) => { chat.push(message) },
    queueEvent: () => Promise.resolve(),
    eventQueue: Promise.resolve(),
    rawStatus: async () => ({ ...session.liveStatus }),
    syncTaskBoardUi: async () => {},
    ensureAuthorization: async () => ({}),
    rcon: { command: async () => '' },
    npcName: 'SGLuna',
  })
  return { session, chat }
}

// --- the facts ---------------------------------------------------------------------------------------------------------------

test('the correction message states the refusal facts per item and the shared one-slot destination, in a bounded text', () => {
  const preflight = {
    ...RUN_G_TRANSFER,
    code: 'supply_destination_conflict',
    operation_index: 1,
    transfer: { ...RUN_G_TRANSFER.transfer, destination_conflict: { inventory_index: 2, slot_count: 1, item_names: ['iron-ore', 'copper-ore'] } },
  }
  const message = worldRefusalCorrectionMessage(preflight, { name: 'supply_entity' })
  assert.match(message, /^\[HARNESS\] Operation 2 \(supply_entity\) was refused before admission: supply_destination_conflict\./)
  assert.match(message, /Nothing from this batch ran; the step and its contract are unchanged\./)
  assert.match(message, /Tools stay enabled/)
  assert.ok(message.length < 900, `message is ${message.length} chars`)
  const facts = worldRefusalFacts(preflight)
  assert.deepEqual(facts.destination_conflict, { inventory_index: 2, slot_count: 1, item_names: ['iron-ore', 'copper-ore'] })
  assert.deepEqual(facts.items.map(item => [item.item_name, item.requested, item.source_count, item.destination_accepts, item.missing, item.status]), [
    ['coal', 10, 0, 50, 10, 'supply_missing'],
    ['iron-ore', 50, 50, 50, 0, 'ok'],
    ['copper-ore', 10, 10, 50, 0, 'ok'],
  ])
  assert.equal(facts.items.some(item => 'single_slot_destination' in item), false, 'the conflict names the slot once')
  assert.deepEqual(facts.target, { unit_number: FURNACE, name: 'stone-furnace' })
  // Any preflight shape yields facts: a refusal with no transfer carries its code, target and detail only.
  assert.deepEqual(worldRefusalFacts({ code: 'no_actor', detail: 'no standalone actor is bound' }), { code: 'no_actor', detail: 'no standalone actor is bound' })
})

// --- one correction turn, then a corrected resubmission is admitted ---------------------------------------------------------

test('run G: the first refusal returns the facts to the executor, nothing blocks, and the corrected batch is admitted', async () => {
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(CORRECTED_BATCH())])
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 4, 'planner, observation, refused batch, corrected batch')
  assert.equal(result.blocker, undefined)
  assert.notEqual(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.notEqual(w.memory.currentPlan(KEY).status, 'blocked')

  const message = harnessMessages([w.calls[3]]).find(text => text.includes('supply_destination_conflict'))
  assert.ok(message, 'the retry carries the harness message')
  assert.match(message, /destination_conflict":\{"inventory_index":2,"slot_count":1,"item_names":\["iron-ore","copper-ore"\]\}/)
  assert.match(message, /"item_name":"coal","requested":10,"source_count":0,"destination_accepts":50,"missing":10,"status":"supply_missing"/)
  assert.match(message, /Nothing from this batch ran/)

  const [recoverable, ...extra] = w.named('operations.preflight_recoverable')
  assert.equal(extra.length, 0)
  assert.equal(recoverable.data.failure_class, 'world_correction_supply_destination_conflict')
  assert.equal(recoverable.data.retry, 1)
  assert.equal(recoverable.data.retry_budget, 1)
  assert.equal(recoverable.data.refusal_class, 'world')
  assert.ok(recoverable.data.request_id, 'the row names its request')
  assert.equal(recoverable.data.request_id, recoverable.request_id)
  assert.equal(recoverable.data.reason, 'world_refusal_one_correction_turn')
  assert.equal(recoverable.data.tools_enabled, true)
  assert.equal(w.named('operations.preflight_rejected').length, 0, 'the refusal did not end the request')
  assert.equal(w.named('operations.ack').length >= 2, true, 'the first batch and the corrected one were both admitted')
  assert.equal(w.agent.worldCorrectionRetries, 0, 'a passed preflight resets the budget')
  const evidence = (w.memory.currentPlan(KEY).task_board.evidence ?? []).find(item => item.kind === 'operation_preflight_recoverable')
  assert.ok(evidence)
  assert.match(evidence.summary, /supply_destination_conflict/)
})

// --- a second refusal pauses visibly and the supervisor resumes it ---------------------------------------------------------

test('run G: a second refusal in the same request pauses as model_recoverable with the reason and the supervisor schedules an auto-resume', async () => {
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())])
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 4)
  assert.equal(result.recoverableFailure.reason, WORLD_REFUSAL_UNCORRECTED_REASON)
  assert.match(result.chatMessage, /^\[Plan paused\] The game refused operation 2 \(supply_entity: supply_destination_conflict\)/)
  assert.equal(w.named('operations.preflight_recoverable').length, 1, 'one correction turn only')

  const plan = w.memory.currentPlan(KEY)
  assert.equal(plan.status, 'paused', 'paused, not blocked')
  assert.equal(plan.pause_reason, `recoverable_provider_failure:${WORLD_REFUSAL_UNCORRECTED_REASON}`)
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['model_recoverable', ''])

  const paused = w.named('goal.paused')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].data.pause_class, 'model_recoverable')
  assert.match(paused[0].data.pause_reason, new RegExp(WORLD_REFUSAL_UNCORRECTED_REASON))
  assert.ok(paused[0].data.request_id)
  const rejected = w.named('operations.preflight_rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].data.reason, WORLD_REFUSAL_UNCORRECTED_REASON)
  assert.ok(rejected[0].data.request_id)
  assert.equal(w.named('operations.preflight_recovery_exhausted')[0].data.failure_class, WORLD_REFUSAL_UNCORRECTED_REASON)
  assert.equal(w.named('request.completed').at(-1).data.outcome, 'recoverable_provider_failure')

  const { session } = sessionFor(w.agent)
  const events = []
  session.traceRecovery = async (event, data) => { events.push({ event, data }) }
  assert.equal(await session.considerPauseForAutoResume(), true)
  if (session.modelResume?.timer) clearTimeout(session.modelResume.timer)
  const scheduled = events.find(item => item.event === 'recovery.auto_resume_scheduled')
  assert.ok(scheduled, 'the supervisor decided on the pause')
  assert.equal(scheduled.data.pause_class, 'model_recoverable')
  assert.equal(scheduled.data.attempt, 1)
  assert.equal(scheduled.data.limit, 2)
  assert.equal(scheduled.data.goal_limit, 6)

  assert.equal(analyzeBehaviorTrace(w.rows).findings.some(finding => finding.signature === 'silent_blocked_stall'), false)
})

// --- the other classes keep their paths --------------------------------------------------------------------------------------

// A code nobody listed anywhere: the producer's declared class alone picks the path.
// Unit 13: the pause class follows who can fix the refusal. An authority refusal still ends blocked (a person is needed); an argument
// refusal after its own retry is the executor's to fix and ends paused (model_recoverable) with the step untouched.
for (const [refusalClass, failureClass, worldCorrection, endStatus] of [
  ['authority', 'authorization_brand_new_mod_code', false, 'blocked'],
  ['argument', 'model_correctable_brand_new_mod_code', false, 'paused'],
  ['world', 'world_correction_brand_new_mod_code', true, 'paused'],
]) {
  test(`a ${refusalClass}-class refusal takes the ${refusalClass} path${worldCorrection ? ' (one correction turn) and then pauses' : ' and never the world-correction path'}`, async () => {
    const game = gameRefusing({ ok: false, code: 'brand_new_mod_code', refusal_class: refusalClass, operation: 'supply_entity', field: 'unit_number', identity: FURNACE }, text => text.includes("'supply_entity'"))
    const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game })
    await runToExecutor(w).catch(() => {})
    const classes = w.named('operations.preflight_recoverable').map(row => row.data.failure_class)
    assert.deepEqual(classes, [failureClass])
    assert.equal(classes.some(name => name.startsWith('world_correction_')), worldCorrection)
    assert.equal(w.memory.currentPlan(KEY).status, endStatus)
    assert.equal(w.memory.pauseRecord(KEY).pause_class, endStatus === 'blocked' ? 'guard' : 'model_recoverable')
  })
}

// The furnace the executor feeds is gone: harness-evidenced world change (the mod's own last-observed record proves it existed).
const staleFurnace = () => gameRefusing({
  ok: false,
  code: 'stale_exact_target',
  refusal_class: 'world',
  operation: 'supply_entity',
  field: 'unit_number',
  identity: FURNACE,
  last_observed: { unit_number: FURNACE, name: 'stone-furnace', surface_index: 1, force_index: 1, position: { x: 23, y: -72 }, observed_tick: 100 },
}, text => text.includes("'supply_entity'"))
const REPLACED_PLAN = [IRON_PLAN[0], 'Place a new stone furnace and smelt 10 iron plates', IRON_PLAN[2]]
const replacementDraft = () => planReply({
  chatMessage: 'The furnace is gone; placing a new one.',
  plan: REPLACED_PLAN,
  currentStep: 1,
  operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace' } }],
  stepCompletions: [det(ore), det(plates), det(gears)],
})
const noCorrection = w => w.named('operations.preflight_recoverable').filter(row => row.data.failure_class.startsWith('world_correction_'))

test('a refusal that is harness-evidenced world change keeps the MW5 wake and takes neither the world-correction turn nor the terminal pause', async () => {
  // stale_exact_target has its own one-round rebinding, so the executor sends the batch twice before the plan blocks and the wake fires.
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH()), replacementDraft()], { game: staleFurnace() })
  await runToExecutor(w)
  assert.equal(w.calls.length, 5, 'planner, observation, refused batch, refused again, replacement draft')
  assert.equal(w.named('plan.replacement_wake').length, 1)
  assert.equal(w.named('plan.replacement_wake_skipped').length, 0)
  assert.equal(noCorrection(w).length, 0)
  assert.equal(w.named('operations.blocked_end_paused').length, 0)
  assert.equal(w.named('goal.paused').length, 0)
  assert.equal(w.memory.pauseRecord(KEY).paused, false)
})

test('a world-evidence refusal whose wake was skipped (no current grant) ends in exactly one guard pause, not a silent blocked end', async () => {
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game: staleFurnace() })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.memory.revokeAuthorization(KEY, w.memory.currentGoalGrant(KEY).grant_id, { reason: 'test' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 4)
  assert.equal(w.named('plan.replacement_wake').length, 0)
  assert.equal(w.named('plan.replacement_wake_skipped')[0].data.reason, 'no_current_grant')
  assert.equal(noCorrection(w).length, 0)
  assert.equal(result.blocker.code, 'stale_exact_target')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED, 'the plan stays frozen')
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_stale_exact_target', 'guard'])
  const paused = w.named('goal.paused')
  assert.equal(paused.length, 1)
  assert.deepEqual([paused[0].data.pause_class, paused[0].data.pause_reason], ['guard', 'blocked_stale_exact_target'])
  assert.ok(paused[0].data.request_id)
  const [ended] = w.named('operations.blocked_end_paused')
  assert.equal(ended.data.request_id, ended.request_id)
  assert.equal(ended.data.reason, 'blocked_stale_exact_target')
  const [classified] = w.named('operations.blocked_end_classified')
  assert.equal(classified.data.request_id, classified.request_id)
  assert.deepEqual([classified.data.pause_class, classified.data.reason], ['guard', 'world_evidence_wake_skipped'])
  assert.equal(w.named('request.completed').at(-1).data.outcome, 'blocked_preflight')
  assert.equal(analyzeBehaviorTrace(w.rows).findings.some(finding => finding.signature === 'silent_blocked_stall'), false, 'run-check sees the pause')
})

test('a recipe_locked refusal gets no correction turn and ends in exactly one guard pause that no timer resumes', async () => {
  const locked = { ok: false, code: 'recipe_locked', refusal_class: 'world', operation: 'supply_entity', field: 'item_name', identity: 'automation-science-pack', recipe_name: 'automation-science-pack' }
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH())], { game: gameRefusing(locked, text => text.includes("'supply_entity'")) })
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 3, 'planner, observation, the refused batch: no correction turn')
  assert.equal(noCorrection(w).length, 0)
  assert.equal(result.blocker.code, 'recipe_locked')
  assert.equal(result.goalStatus, 'blocked')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_recipe_locked', 'guard'])
  assert.equal(w.named('goal.paused').length, 1)
  assert.equal(w.named('operations.blocked_end_paused').length, 1)
  const [classified] = w.named('operations.blocked_end_classified')
  assert.equal(classified.data.request_id, classified.request_id)
  assert.deepEqual([classified.data.pause_class, classified.data.reason], ['guard', 'executor_cannot_fix:plan_level'])

  const { session } = sessionFor(w.agent)
  const events = []
  session.traceRecovery = async (event, data) => { events.push({ event, data }) }
  assert.equal(await session.considerPauseForAutoResume(), null)
  assert.equal(session.modelResume, null)
  assert.equal(session.autoResume, null)
  assert.deepEqual(events.filter(item => item.event.startsWith('recovery.auto_resume')), [])
})

test('preflight_transport_error is a transport fault: no correction turn, the request fails with a declared transport class and the pause is transport', async () => {
  const game = gameRefusing()
  game.preflight = text => (text.includes("'supply_entity'") ? undefined : { ok: true }) // the game answers nothing readable
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const failure = await w.agent.completed().then(() => undefined, error => error)
  assert.ok(failure, 'the request fails instead of asking the model to correct a fault it did not cause')
  assert.equal(failure.preflight.code, 'preflight_transport_error')
  assert.deepEqual([failure.pause_class, failure.pause_subkind], ['transport', 'transport'])
  assert.equal(w.calls.length, 3, 'planner, observation, the batch whose preflight was unreadable: no correction turn')
  assert.equal(noCorrection(w).length, 0)
  assert.equal(w.named('operations.blocked_end_paused').length, 0)
  const [fault] = w.named('operations.preflight_transport_fault')
  assert.equal(fault.data.request_id, fault.request_id)
  assert.equal(fault.data.reason, 'preflight_response_unreadable')
  assert.equal(fault.data.pause_class, 'transport')

  // The supervisor pauses the stranded plan from the declared class, and the transport backoff owns the resume.
  const { session } = sessionFor(w.agent)
  const paused = await pauseStrandedPlanAfterRequestError(session, failure)
  assert.equal(paused?.status, 'paused')
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['transport', 'transport'])
})

test('the world-correction budget starts over only once a batch was actually sent', async () => {
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(CORRECTED_BATCH())])
  await runToExecutor(w)
  const at = event => w.named(event).map(row => row.retries)
  assert.deepEqual(at('operations.preflight_recoverable'), [1], 'the refusal spent the budget')
  assert.deepEqual(at('operations.admit').slice(-1), [1], 'admission begins with the budget still spent: nothing was sent yet')
  assert.deepEqual(at('operations.ack').slice(-1), [0], 'the game took the batch: the budget starts over')
})

// --- the allowlist, the player line and run-check ---------------------------------------------------------------------------

test('the uncorrected world refusal is a model_recoverable outcome reason; its retry-exhausted cousins stay guard pauses', () => {
  assert.equal(MODEL_RECOVERABLE_OUTCOME_REASONS.has(WORLD_REFUSAL_UNCORRECTED_REASON), true)
  const idle = { task_state: 'idle', queue_length: 0 }
  const classOf = reasonCode => validateOutcomeCandidate({ kind: 'recoverable_provider_failure', source: 'world_refusal_recovery', reason_code: reasonCode }, { world: idle }).pause_class
  assert.equal(classOf(WORLD_REFUSAL_UNCORRECTED_REASON), 'model_recoverable')
  for (const reason of ['requires_machine_retry_exhausted', 'research_preflight_retry_exhausted']) assert.equal(classOf(reason), 'guard', reason)
  assert.match(formatTaskCondition(`recoverable_provider_failure:${WORLD_REFUSAL_UNCORRECTED_REASON}`, 'pause').summary, /^Paused: the game refused the planned operation twice/)
  assert.match(formatTaskCondition('blocked_recipe_locked', 'pause').summary, /^Paused: the game refused the next operation and the plan is blocked\./)
})


// --- unit 13: the pause class follows who can fix the refusal ------------------------------------------------------------------
//
// A request that ends on a refusal ends in exactly one place (classifyBlockedEnd, refusal-class.mjs). The NPC runs with zero connected
// humans, so a guard pause is a dead end there; it is reserved for refusals only a person or a planning decision can resolve. A refusal
// an executor caused and can fix on a fresh restage ends as a model_recoverable pause that unit 7's supervisor resumes under its caps.

// The mod's own argument refusal for a name the executor invented: the loop gives it one bounded correction turn.
const ARGUMENT_REFUSAL = { ok: false, code: 'unknown_prototype', refusal_class: 'argument', operation: 'supply_entity', field: 'item_name', identity: 'coal-lump' }
// The mod's supply_missing for a single-item supply the NPC's inventory cannot cover (the NPC's own inventory accounting).
const SUPPLY_MISSING = {
  ok: false,
  code: 'supply_missing',
  operation: 'supply_entity',
  field: 'unit_number',
  identity: FURNACE,
  target: { unit_number: FURNACE, name: 'stone-furnace', position: { x: 23, y: -72 }, surface_index: 1, force_index: 1 },
  transfer: {
    direction: 'to_entity',
    items: [{ item_name: 'coal', requested: 10, source_count: 0, destination_accepts: 50, expected_moved: 0, missing: 10, status: 'supply_missing' }],
  },
  refusal_class: 'world',
}
const SUPPLY_ONLY_BATCH = () => [supply([{ item_name: 'coal', count: 10 }])]
const supplyEntity = text => text.includes("'supply_entity'")
const blockedEnds = w => w.named('operations.blocked_end_classified')

// Schedules (or declines) the supervisor's decision on the pause the request left, with the recovery rows captured.
async function superviseOnce(w) {
  const { session } = sessionFor(w.agent)
  const events = []
  session.traceRecovery = async (event, data) => { events.push({ event, data }) }
  const decision = await session.considerPauseForAutoResume()
  if (session.modelResume?.timer) clearTimeout(session.modelResume.timer)
  return { session, events, decision }
}

test('unit 13: an argument refusal after its retry budget ends in exactly one model_recoverable pause, with the step untouched, and the supervisor schedules an auto-resume', async () => {
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game: gameRefusing(ARGUMENT_REFUSAL, supplyEntity) })
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 4, 'planner, observation, refused batch, refused again after its one argument correction')
  assert.equal(result.blocker, undefined, 'nothing is blocked')
  assert.equal(result.recoverableFailure.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON)
  assert.deepEqual(result.recoverableFailure.preflight, { code: 'unknown_prototype', target: { unit_number: 'coal-lump' } }, 'the facts of the refusal travel with the failure')
  assert.match(result.chatMessage, /^\[Plan paused\] The game refused operation 2 \(supply_entity: unknown_prototype\) again after the correction\./)
  assert.deepEqual(w.named('operations.preflight_recoverable').map(row => row.data.failure_class), ['model_correctable_unknown_prototype'], 'one argument correction turn only')

  assert.notEqual(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const plan = w.memory.currentPlan(KEY)
  assert.equal(plan.status, 'paused', 'paused, not blocked')
  assert.equal(plan.pause_reason, `recoverable_provider_failure:${EXECUTOR_REFUSAL_UNCORRECTED_REASON}`)
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.pause_class, record.pause_subkind], ['model_recoverable', ''])
  const paused = w.named('goal.paused')
  assert.equal(paused.length, 1, 'exactly one pause')
  assert.equal(paused[0].data.pause_class, 'model_recoverable')
  assert.equal(w.named('operations.blocked_end_paused').length, 0, 'the guard end was not taken')
  assert.equal(w.named('request.completed').at(-1).data.outcome, 'recoverable_provider_failure')

  const [classified, ...extra] = blockedEnds(w)
  assert.equal(extra.length, 0)
  assert.ok(classified.data.request_id)
  assert.equal(classified.data.request_id, classified.request_id)
  assert.deepEqual({ ...classified.data, request_id: undefined }, {
    request_id: undefined,
    code: 'unknown_prototype',
    refusal_class: 'argument',
    recovery_spent: ['argument_retry'],
    pause_class: 'model_recoverable',
    reason: 'argument_refusal_after_retry',
  })
  const [rejected] = w.named('operations.preflight_rejected')
  assert.equal(rejected.data.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON)
  assert.ok(rejected.data.request_id)

  const { events, decision } = await superviseOnce(w)
  assert.equal(decision, true)
  const scheduled = events.find(item => item.event === 'recovery.auto_resume_scheduled')
  assert.ok(scheduled, 'the supervisor decided on the pause')
  assert.equal(scheduled.data.pause_class, 'model_recoverable')
  assert.equal(scheduled.data.attempt, 1)
  assert.equal(analyzeBehaviorTrace(w.rows).findings.some(finding => finding.signature === 'silent_blocked_stall'), false)
})

test('unit 13: supply_missing that survives its supply recovery gets one world-correction turn, then a model_recoverable pause', async () => {
  const batch = () => executor(SUPPLY_ONLY_BATCH())
  // Two supply recoveries, the world-correction turn, then the refusal that ends the request.
  const w = world([plannerDraft(), observation(), batch(), batch(), batch(), batch()], { game: gameRefusing(SUPPLY_MISSING, supplyEntity) })
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 6)
  assert.deepEqual(w.named('operations.preflight_recoverable').map(row => row.data.failure_class), [
    'transfer_supply_missing',
    'transfer_supply_missing',
    'world_correction_supply_missing',
  ])
  assert.equal(noCorrection(w).length, 1, 'supply_missing is no longer excluded from the world-correction turn')
  assert.equal(result.blocker, undefined)
  assert.equal(result.recoverableFailure.reason, WORLD_REFUSAL_UNCORRECTED_REASON)
  assert.notEqual(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_class], [true, 'model_recoverable'])
  assert.equal(w.named('goal.paused').length, 1)
  assert.equal(w.named('operations.blocked_end_paused').length, 0)
  const { events, decision } = await superviseOnce(w)
  assert.equal(decision, true)
  assert.equal(events.find(item => item.event === 'recovery.auto_resume_scheduled').data.pause_class, 'model_recoverable')
})

test('unit 13: an authority refusal after its retry stays exactly one guard pause, with no auto-resume', async () => {
  const refusal = { ok: false, code: 'protected_entity_refused', refusal_class: 'authority', operation: 'supply_entity', field: 'unit_number', identity: FURNACE, detail: 'the furnace was built by a player' }
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game: gameRefusing(refusal, supplyEntity) })
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 4, 'planner, observation, refused batch, refused again after its one authorization retry')
  assert.equal(result.blocker.code, 'protected_entity_refused')
  assert.deepEqual(w.named('operations.preflight_recoverable').map(row => row.data.failure_class), ['authorization_protected_entity_refused'])
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_protected_entity_refused', 'guard'])
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(w.named('goal.paused').length, 1)
  assert.equal(w.named('operations.blocked_end_paused').length, 1)
  const [classified, ...extra] = blockedEnds(w)
  assert.equal(extra.length, 0)
  assert.equal(classified.data.request_id, classified.request_id)
  assert.deepEqual([classified.data.code, classified.data.refusal_class, classified.data.pause_class, classified.data.reason],
    ['protected_entity_refused', 'authority', 'guard', 'authority_refusal_needs_a_person'])
  const { events, decision, session } = await superviseOnce(w)
  assert.equal(decision, null)
  assert.equal(session.modelResume, null)
  assert.deepEqual(events.filter(item => item.event.startsWith('recovery.auto_resume')), [])
})

test('unit 13: no_actor is a lifecycle refusal: no correction turn and exactly one guard pause', async () => {
  const refusal = { ok: false, code: 'no_actor', refusal_class: 'world', operation: 'supply_entity', detail: 'no standalone actor is bound' }
  const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH())], { game: gameRefusing(refusal, supplyEntity) })
  const result = await runToExecutor(w)
  assert.equal(w.calls.length, 3, 'planner, observation, the refused batch: no correction turn')
  assert.equal(noCorrection(w).length, 0)
  assert.equal(result.blocker.code, 'no_actor')
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_no_actor', 'guard'])
  assert.equal(w.named('goal.paused').length, 1)
  const [classified] = blockedEnds(w)
  assert.equal(classified.data.request_id, classified.request_id)
  assert.deepEqual([classified.data.pause_class, classified.data.reason, classified.data.recovery_spent], ['guard', 'executor_cannot_fix:lifecycle', []])
})

test('unit 13: every guard end names its reason: recipe_locked, a world-evidence refusal whose wake was skipped, and a refusal with no declared class', async () => {
  const locked = { ok: false, code: 'recipe_locked', refusal_class: 'world', operation: 'supply_entity', field: 'item_name', identity: 'automation-science-pack', recipe_name: 'automation-science-pack' }
  const a = world([plannerDraft(), observation(), executor(RUN_G_BATCH())], { game: gameRefusing(locked, supplyEntity) })
  await runToExecutor(a)
  const [lockedEnd] = blockedEnds(a)
  assert.equal(lockedEnd.data.request_id, lockedEnd.request_id)
  assert.deepEqual([lockedEnd.data.code, lockedEnd.data.pause_class, lockedEnd.data.reason], ['recipe_locked', 'guard', 'executor_cannot_fix:plan_level'])

  const b = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game: staleFurnace() })
  await b.agent.request(OBJECTIVE, { sender: 'Louis' })
  b.memory.revokeAuthorization(KEY, b.memory.currentGoalGrant(KEY).grant_id, { reason: 'test' })
  b.game.inventory['iron-ore'] = 10
  await b.agent.completed()
  const [evidenceEnd] = blockedEnds(b)
  assert.equal(evidenceEnd.data.request_id, evidenceEnd.request_id)
  assert.deepEqual([evidenceEnd.data.code, evidenceEnd.data.pause_class, evidenceEnd.data.reason], ['stale_exact_target', 'guard', 'world_evidence_wake_skipped'])

  const unclassified = { ok: false, code: 'brand_new_mod_code', operation: 'supply_entity', field: 'unit_number', identity: FURNACE }
  const c = world([plannerDraft(), observation(), executor(RUN_G_BATCH())], { game: gameRefusing(unclassified, supplyEntity) })
  await runToExecutor(c)
  assert.equal(c.named('operations.preflight_unclassified').length, 1)
  const [unclassifiedEnd] = blockedEnds(c)
  assert.deepEqual([unclassifiedEnd.data.refusal_class, unclassifiedEnd.data.pause_class, unclassifiedEnd.data.reason], ['unclassified', 'guard', 'unclassified_refusal_fails_closed'])
  assert.equal(c.memory.pauseRecord(KEY).pause_class, 'guard')
})

test('unit 13: a repeating executor refusal is bounded end to end: two restages, then one visible guard pause, never a silent blocked stall', async () => {
  const w = world([], {
    game: gameRefusing(ARGUMENT_REFUSAL, supplyEntity),
    // The planner commits the plan; every executor, restaged or not, observes once (an exact unit number needs a live binding) and then
    // sends the same refused batch.
    provider: async (messages, context) => {
      if (context?.role !== 'executor') return plannerDraft()
      return messages.some(message => message.role === 'tool') ? executor(RUN_G_BATCH()) : observation()
    },
  })
  const result = await runToExecutor(w)
  assert.equal(result.recoverableFailure.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON)

  const { session } = sessionFor(w.agent)
  assert.equal(await session.considerPauseForAutoResume(), true)
  for (const attempt of [1, 2]) {
    clearTimeout(session.modelResume.timer)
    await session.runModelRecoverableResume(session.modelResume.correlation, attempt)
  }
  assert.equal(session.modelResume, null, 'no third attempt is scheduled')

  const rows = event => w.rows.filter(row => row.event === event)
  assert.deepEqual(rows('recovery.auto_resume_scheduled').map(row => row.data.attempt), [1, 2])
  assert.equal(rows('recovery.auto_resume_started').length, 2, 'exactly two restaged executors')
  const ends = blockedEnds(w)
  assert.equal(ends.length, 3, 'the original request and each restage ended on the same refusal')
  assert.equal(new Set(ends.map(row => row.data.request_id)).size, 3, 'each end belongs to its own request')
  assert.equal(ends.every(row => row.data.pause_class === 'model_recoverable' && row.data.reason === 'argument_refusal_after_retry'), true)
  assert.equal(w.named('operations.blocked_end_paused').length, 0)
  // Every restaged executor got its own argument correction turn before its refusal ended the request: one per request, three in all.
  assert.deepEqual(w.named('operations.preflight_recoverable').map(row => row.data.failure_class), Array.from({length: 3}).fill('model_correctable_unknown_prototype'))
  assert.equal(new Set(w.named('operations.preflight_recoverable').map(row => row.request_id)).size, 3)
  assert.equal(rows('operations.refusal_budget_reset').length, 2, 'one reset per restage')

  // The deadlock detector counts the third identical failure on the step (DEADLOCK_REPEATED_FAILURE_LIMIT = 3: the request plus the two
  // allowed restages) and freezes the plan. That is the end of the bound, and it is one visible guard pause: durable, with the
  // goal.paused row, and nothing schedules a resume for it. (The supervisor's own cap, recovery.auto_resume_exhausted, is covered by
  // pause-class-auto-resume.test.mjs; for this reason code the detector reaches its limit on the same attempt.)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(getActivePlan(w.planning()).blocker.reason_code, 'repeating_failure')
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_repeating_failure', 'guard'])
  const [frozen, ...extra] = rows('operations.recovery_failure_frozen')
  assert.equal(extra.length, 0)
  assert.equal(frozen.data.request_id, frozen.request_id)
  assert.deepEqual([frozen.data.reason, frozen.data.failure_class, frozen.data.pause_class], ['blocked_repeating_failure', EXECUTOR_REFUSAL_UNCORRECTED_REASON, 'guard'])
  const pauses = rows('goal.paused')
  assert.deepEqual(pauses.map(row => row.data.pause_class), ['model_recoverable', 'model_recoverable', 'guard'])
  assert.equal(pauses.at(-1).data.request_id, frozen.data.request_id)
  assert.equal(await session.considerPauseForAutoResume(), null, 'a frozen plan is never auto-resumed')
  assert.equal(rows('recovery.auto_resume_scheduled').length, 2)

  // run-check: each model_recoverable pause was followed by a scheduling decision and the freeze ended in a pause.
  const signatures = analyzeBehaviorTrace(w.rows).findings.map(finding => finding.signature)
  assert.equal(signatures.includes('silent_blocked_stall'), false)
  assert.equal(signatures.includes('model_recoverable_pause_not_resumed'), false)
})

test('unit 13: the new reason is a model_recoverable outcome reason with its own player line', () => {
  assert.equal(MODEL_RECOVERABLE_OUTCOME_REASONS.has(EXECUTOR_REFUSAL_UNCORRECTED_REASON), true)
  const idle = { task_state: 'idle', queue_length: 0 }
  const outcome = validateOutcomeCandidate({ kind: 'recoverable_provider_failure', source: 'executor_refusal_recovery', reason_code: EXECUTOR_REFUSAL_UNCORRECTED_REASON }, { world: idle })
  assert.equal(outcome.pause_class, 'model_recoverable')
  assert.match(formatTaskCondition(`recoverable_provider_failure:${EXECUTOR_REFUSAL_UNCORRECTED_REASON}`, 'pause').summary, /^Paused: the game refused the planned operation again after a correction/)
})

test('unit 13: a restaged executor gets its own correction turn with the refusal facts, then its second refusal pauses', async () => {
  const w = world([], {
    game: gameRefusing(ARGUMENT_REFUSAL, supplyEntity),
    provider: async (messages, context) => {
      if (context?.role !== 'executor') return plannerDraft()
      return messages.some(message => message.role === 'tool') ? executor(RUN_G_BATCH()) : observation()
    },
  })
  const result = await runToExecutor(w)
  assert.equal(result.recoverableFailure.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON)
  assert.equal(w.named('operations.preflight_recoverable').length, 1, 'the first request spent its one correction turn')
  assert.equal(w.agent.modelCorrectablePreflightRetries, 1, 'the pause left the budget spent')

  const { session } = sessionFor(w.agent)
  assert.equal(await session.considerPauseForAutoResume(), true)
  clearTimeout(session.modelResume.timer)
  await session.runModelRecoverableResume(session.modelResume.correlation, 1)

  const [started] = w.rows.filter(row => row.event === 'recovery.auto_resume_started')
  const requestId = started.data.request_id
  const [reset] = w.named('operations.refusal_budget_reset')
  assert.equal(reset.data.request_id, requestId)
  assert.equal(reset.request_id, requestId)
  assert.equal(reset.data.reason, 'fresh_restage_correction_budget')
  assert.deepEqual(reset.data.before, { argument_retries: 1, world_correction_retries: 0 })
  const ofRequest = event => w.named(event).filter(row => row.data.request_id === requestId || row.request_id === requestId)
  // The restaged executor's first refusal returned the facts to it; its second ended the request.
  const [correction, ...extra] = ofRequest('operations.preflight_recoverable')
  assert.equal(extra.length, 0)
  assert.equal(correction.data.failure_class, 'model_correctable_unknown_prototype')
  assert.equal(correction.data.retry, 1)
  const [end] = ofRequest('operations.blocked_end_classified')
  assert.deepEqual([end.data.pause_class, end.data.reason, end.data.recovery_spent], ['model_recoverable', 'argument_refusal_after_retry', ['argument_retry']])
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
  assert.equal(w.memory.currentPlan(KEY).status, 'paused')
})

// --- unit 13 review: when the outcome authority declines the pause, the request still ends visibly ----------------------------------
//
// The outcome authority pauses a recoverable failure only for an idle runtime. While a task runs, or when the task status cannot be
// read, it keeps the plan active; but finishPreflightRecoveryFailure ends the request (agent.active = false), and the supervisor
// drops an 'All operations completed' line when the agent is not active, so nothing would wake the NPC. The end is a pause instead.

const ARGUMENT_BATCHES = () => [plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())]
// The task status is the fixture's own until the executor's batch is refused; from then on the game answers with `status`, which is
// what the request's end reads (the earlier step verification must not see it).
function gameWithStatusAfterRefusal(refusal, status) {
  let refused = false
  const game = gameRefusing(refusal, (text) => {
    if (!supplyEntity(text)) return false
    refused = true
    return true
  })
  const command = game.command.bind(game)
  game.command = async (text) => {
    if (refused && text.includes('remote.call("autorio_operations","status")')) {
      if (status instanceof Error) throw status
      return typeof status === 'string' ? status : JSON.stringify(status)
    }
    return command(text)
  }
  return game
}

test('unit 13: with a task still running the request ends as a visible pause, the line says what happened, and a completion signal would wake nothing', async () => {
  const game = gameWithStatusAfterRefusal(ARGUMENT_REFUSAL, { task_state: 'walking', queue_empty: false, queue_length: 2 })
  const w = world(ARGUMENT_BATCHES(), { game })
  const result = await runToExecutor(w)
  assert.equal(result.recoverableFailure.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON)
  assert.match(result.chatMessage, /^\[Plan paused\] The game refused operation 2/)
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, `recoverable_provider_failure:${EXECUTOR_REFUSAL_UNCORRECTED_REASON}`, 'model_recoverable'])
  assert.equal(w.memory.currentPlan(KEY).status, 'paused')
  const [gate, ...extra] = w.named('operations.recovery_failure_runtime_gate')
  assert.equal(extra.length, 0)
  assert.equal(gate.data.request_id, gate.request_id)
  assert.ok(gate.data.request_id)
  assert.deepEqual([gate.data.decision, gate.data.pause_class, gate.data.paused], ['paused_runtime_active', 'model_recoverable', true])
  assert.deepEqual([gate.data.runtime.active, gate.data.runtime.task_state, gate.data.runtime.queue_length], [true, 'walking', 2])
  assert.equal(w.named('goal.paused').length, 1)
  // Why it pauses: the request is over, so a later completion of the queued work is ignored (npc-agent-loop completed() returns null
  // when the agent is not active, and the supervisor does not call it then).
  assert.equal(w.agent.active, false)
  assert.equal(await w.agent.completed(), null)
  // The supervisor's auto-resume owns the wake instead.
  const { decision } = await superviseOnce(w)
  assert.equal(decision, true)
})

test('unit 13: a task status that cannot be read ends as a visible system pause, never an active plan with no pending work', async () => {
  for (const [label, status] of [['unreadable json', 'not json'], ['rcon error', new Error('rcon connection reset')]]) {
    const game = gameWithStatusAfterRefusal(ARGUMENT_REFUSAL, status)
    const w = world(ARGUMENT_BATCHES(), { game })
    const result = await runToExecutor(w)
    assert.equal(result.recoverableFailure.reason, EXECUTOR_REFUSAL_UNCORRECTED_REASON, label)
    const record = w.memory.pauseRecord(KEY)
    assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, `runtime_status_unknown:${EXECUTOR_REFUSAL_UNCORRECTED_REASON}`, 'system'], label)
    assert.equal(w.memory.currentPlan(KEY).status, 'paused', label)
    const [gate] = w.named('operations.recovery_failure_runtime_gate')
    assert.equal(gate.data.request_id, gate.request_id, label)
    assert.deepEqual([gate.data.decision, gate.data.pause_class], ['paused_runtime_status_unknown', 'system'], label)
    assert.ok(gate.data.runtime.status_error, label)
    assert.equal(w.named('goal.paused').length, 1, label)
    // A system pause is for its own lifecycle recovery: the auto-resume timer never fires for it.
    const { decision } = await superviseOnce(w)
    assert.equal(decision, null, label)
  }
})

test('unit 13: an idle runtime keeps the declared pause and never traces the runtime gate', async () => {
  const w = world(ARGUMENT_BATCHES(), { game: gameRefusing(ARGUMENT_REFUSAL, supplyEntity) })
  await runToExecutor(w)
  assert.equal(w.named('operations.recovery_failure_runtime_gate').length, 0)
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
})

test('unit 13: a failure line that did not pause anything does not say "[Plan paused]"', async () => {
  const w = world([])
  // No request is open (nothing to pause): the line states the facts without the prefix.
  const result = await w.agent.finishPreflightRecoveryFailure(undefined, { chatMessage: '', plan: [], operations: [] }, { epoch: 3, actor_id: 18 }, { code: 'unknown_prototype', operation_index: 0 }, {
    source: 'executor_refusal_recovery',
    reason: EXECUTOR_REFUSAL_UNCORRECTED_REASON,
    retryBudget: 1,
    chatMessage: '[Plan paused] The game refused operation 1 (craft_item: unknown_prototype) again after the correction.',
    facts: { code: 'unknown_prototype' },
  })
  assert.equal(result.chatMessage, 'The game refused operation 1 (craft_item: unknown_prototype) again after the correction.')
})


test('offshore pump generic placement uses the existing argument correction and preserves the active plan', async () => {
  const pump = { name: 'place_entity', args: { entity_name: 'offshore-pump' } }
  const correction = 'Read water first, inspect covered_fluid_hints, then getPlacementCandidates and place_candidate. No generic pump placement.'
  const game = gameRefusing({ ok: false, code: 'placement_candidate_required', operation: 'place_entity', refusal_class: 'argument', correction_message: correction }, text => text.includes("'place_entity'"))
  const w = world([plannerDraft(), executor([pump]), executor(CORRECTED_BATCH())], { game })
  await runToExecutor(w)
  assert.equal(w.named('operations.pump_candidate_required').length, 1)
  const trace = w.named('operations.pump_candidate_required')[0]
  assert.ok(trace.request_id)
  assert.equal(trace.data.reason, 'generic_offshore_pump_placement_refused')
  assert.ok(w.calls.flat().some(row => row.content === correction))
  assert.equal(w.game.admissions.some(row => JSON.stringify(row).includes('offshore-pump')), false)
  assert.equal(w.agent.modelCorrectablePreflightRetries, 1)
  assert.equal(w.agent.worldCorrectionRetries ?? 0, 0)
  assert.equal(getActivePlan(w.planning()).steps[1].description, IRON_PLAN[1])
})
