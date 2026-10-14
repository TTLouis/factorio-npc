import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, worldRefusalCorrectionMessage, worldRefusalFacts, WORLD_REFUSAL_UNCORRECTED_REASON } from './npc-agent-loop.mjs'
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

function world(script, { game = gameRefusing() } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  const calls = []
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    completionProtocolVersion: 2,
    replacementWake: true,
    provider: answersStepContract(async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
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
  agent.behaviorTrace = { emit: async (record) => { rows.push({ ...record, retries: agent.worldCorrectionRetries }) } }
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
for (const [refusalClass, failureClass, worldCorrection] of [
  ['authority', 'authorization_brand_new_mod_code', false],
  ['argument', 'model_correctable_brand_new_mod_code', false],
  ['world', 'world_correction_brand_new_mod_code', true],
]) {
  test(`a ${refusalClass}-class refusal takes the ${refusalClass} path${worldCorrection ? ' (one correction turn) and then pauses' : ' and never the world-correction path'}`, async () => {
    const game = gameRefusing({ ok: false, code: 'brand_new_mod_code', refusal_class: refusalClass, operation: 'supply_entity', field: 'unit_number', identity: FURNACE }, text => text.includes("'supply_entity'"))
    const w = world([plannerDraft(), observation(), executor(RUN_G_BATCH()), executor(RUN_G_BATCH()), executor(RUN_G_BATCH())], { game })
    await runToExecutor(w).catch(() => {})
    const classes = w.named('operations.preflight_recoverable').map(row => row.data.failure_class)
    assert.deepEqual(classes, [failureClass])
    assert.equal(classes.some(name => name.startsWith('world_correction_')), worldCorrection)
    if (worldCorrection) assert.equal(w.memory.currentPlan(KEY).status, 'paused')
    else assert.equal(w.memory.currentPlan(KEY).status, 'blocked', 'the authority and argument paths still end blocked once their own retry is spent')
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
  const record = w.memory.pauseRecord(KEY)
  assert.deepEqual([record.paused, record.pause_reason, record.pause_class], [true, 'blocked_recipe_locked', 'guard'])
  assert.equal(w.named('goal.paused').length, 1)
  assert.equal(w.named('operations.blocked_end_paused').length, 1)

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

