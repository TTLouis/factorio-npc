import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_SCOPE, authorizationOf, MANDATE_KIND } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'
import {
  blockerWorldEvidence,
  buildPlanBlockedMessage,
  MAX_REPLACEMENTS_PER_GOAL,
  playerObjectiveGrant,
  replacementAnnouncement,
  NEVER_WAKE_PREFLIGHT_CODES,
  replacementApprovalLine,
  replacementsUsed,
  WORLD_CHANGE_PREFLIGHT_CODES,
} from './replacement-wake.mjs'
import { recoverInterruptedAgentPlan, Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// MW5 (minimal): the player-task grant at goal admission and the replacement wake. Static scenarios: the real
// NpcAgentLoop against a fake Factorio with scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const ore = inventoryCheckpoint('iron-ore', 10)
const plates = inventoryCheckpoint('iron-plate', 10)
const gears = inventoryCheckpoint('iron-gear-wheel', 5)
const det = checkpoint => ({ kind: 'deterministic', checkpoint })
const GOAL = { scope: 'finite', summary: 'Craft 5 iron gear wheels.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 5 }] }
const OBJECTIVE = 'Craft 5 iron gear wheels from ore you mine and smelt.'
const IRON_PLAN = ['Gather 10 iron ore', 'Smelt the ore into iron plates in the furnace', 'Craft 5 iron gear wheels']
const REPLACED_PLAN = [IRON_PLAN[0], 'Place a new stone furnace and smelt 10 iron plates', IRON_PLAN[2]]
const FURNACE = 77
const insertOre = () => ({ name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: FURNACE, max_count: 10, to_entity: true } })
const placeFurnace = () => ({ name: 'place_entity', args: { entity_name: 'stone-furnace' } })

const plannerDraft = () => planReply({
  plan: IRON_PLAN,
  currentStep: 0,
  operations: [gather('iron-ore', 10)],
  checkpoint: ore,
  goal: GOAL,
  stepCompletions: [det(ore), det(plates), det(gears)],
})
const observation = () => ({ content: null, tool_calls: [{ id: 'call_obs', index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }] })
const executorInsert = (unit = FURNACE) => planReply({ plan: IRON_PLAN, currentStep: 1, operations: [{ ...insertOre(), args: { ...insertOre().args, unit_number: unit } }] })
// A stale exact target gets one rebinding round before it is a blocker, so the executor sends the batch twice.
const staleTwice = (unit = FURNACE) => [executorInsert(unit), executorInsert(unit)]
const replacementDraft = (overrides = {}) => planReply({
  chatMessage: 'The furnace is gone; placing a new one.',
  plan: REPLACED_PLAN,
  currentStep: 1,
  operations: [placeFurnace()],
  stepCompletions: [det(ore), det(plates), det(gears)],
  ...overrides,
})

// The furnace the executor was about to feed no longer exists when the harness preflights the batch.
function gameWithMissingFurnace(onBlocked, { code = 'stale_exact_target', unit = FURNACE, lastObserved = true } = {}) {
  const game = new FakeFactorio({
    preflight: (text) => {
      const target = Number(/unit_number[^0-9]*(\d+)/.exec(text)?.[1])
      if (target !== unit) return { ok: true }
      onBlocked?.()
      return {
        ok: false,
        code,
        operation: 'move_items_exact',
        field: 'unit_number',
        identity: unit,
        ...(lastObserved ? { last_observed: { unit_number: unit, name: 'stone-furnace', surface_index: 1, force_index: 1, position: { x: 8, y: 1 }, observed_tick: 100 } } : {}),
      }
    },
  })
  game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: FURNACE, position: { x: 8, y: 1 }, distance: 8 }] }
  return game
}

function world(script, { game = gameWithMissingFurnace(), intents = [], agentOptions = {} } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  const calls = []
  let routed = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    completionProtocolVersion: 2,
    replacementWake: true,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const reply = typeof script === 'function' ? script(calls.length, memory, calls) : script[calls.length - 1]
      assert.ok(reply, `unscripted provider call ${calls.length}`)
      return typeof reply === 'function' ? reply(memory, calls) : { ...reply }
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: intents[routed++] ?? 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'replacement wake fixture',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...agentOptions,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  const named = name => rows.filter(row => row.event === name)
  const data = row => row.data ?? row
  const planning = () => memory.planningState(KEY)
  return { agent, memory, game, rows, calls, named, data, planning }
}

const chatText = calls => calls.flat().map(message => (typeof message.content === 'string' ? message.content : '')).join('\n')

// --- the grant at goal admission -------------------------------------------------------------------------------------

test('MW5: a chat new_goal is admitted with a player_task grant for its own result, all five scopes, unbound to an actor', async () => {
  const w = world([plannerDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const goalId = w.planning().goal.goal_id
  const grants = authorizationOf(w.planning()).grants
  assert.equal(grants.length, 1)
  assert.equal(grants[0].grant_id, `player_task:${goalId}`)
  assert.equal(grants[0].mandate_kind, MANDATE_KIND.PLAYER_TASK)
  assert.deepEqual(grants[0].requested_result, { result_key: `goal:${goalId}`, destination: '' })
  assert.deepEqual([...grants[0].permitted_scope].sort(), Object.values(ACTION_SCOPE).sort())
  assert.equal(grants[0].actor, null, 'unbound, so it survives a respawn; actor and epoch are fenced at wake, commit and admission')
  assert.equal(grants[0].status, 'active')
  const row = w.named('authorization.granted')[0]
  assert.ok(row, 'the existing authorization.granted trace fired')
  assert.equal(w.data(row).ok, true)
  assert.equal(w.data(row).reason, 'granted')
  assert.ok(row.request_id)
  assert.deepEqual(playerObjectiveGrant(goalId).permitted_scope.length, 5)
})

test('MW5: the player-objective grant is a record of the request itself and does not switch on the protected-asset gates of MW1', async () => {
  const w = world([plannerDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const verdict = w.memory.checkOperationAdmission(KEY, {
    operations: [{ name: 'mine_entity_exact', args: { unit_number: 501 } }],
    preflight: [{ ok: true, target: { unit_number: 501, last_user: { name: 'louis', index: 1 } } }],
    actor: { actor_id: 18, actor_epoch: 3 },
  }, { requestId: 'req_interim' })
  assert.equal(verdict.ok, true, 'an ordinary player objective still behaves as before MW1 (interim owner decision)')
})

test('MW5: no grant is minted for chat-only, amendment or continue routes, or for a goal that already has one', async () => {
  for (const intent of ['chat_only', 'amend_current', 'continue_current', 'status_query']) {
    const w = world([plannerDraft(), planReply({ plan: IRON_PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], stepCompletions: [det(ore), det(plates), det(gears)] })], { intents: ['new_goal', intent] })
    await w.agent.request(OBJECTIVE, { sender: 'Louis' })
    const grantId = authorizationOf(w.planning()).grants[0].grant_id
    // The first grant is withdrawn so that any new one would be visible.
    w.memory.revokeAuthorization(KEY, grantId, { reason: 'test' })
    const revision = authorizationOf(w.planning()).grants[0].revision
    await w.agent.request('please do something else about it', { sender: 'Louis' }).catch(() => {})
    const grants = authorizationOf(w.planning()).grants
    assert.equal(grants.length, 1, `${intent}: no second grant`)
    assert.equal(grants[0].revision, revision, `${intent}: the revoked grant was not re-activated`)
    assert.equal(w.memory.currentGoalGrant(KEY), undefined, intent)
  }
})

test('MW5: a supervisor recovery run never mints a grant, and keeps the one the goal has', async () => {
  const w = world([plannerDraft(), planReply({ plan: IRON_PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], stepCompletions: [det(ore), det(plates), det(gears)] })])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const grantId = authorizationOf(w.planning()).grants[0].grant_id
  w.memory.revokeAuthorization(KEY, grantId, { reason: 'test' })
  const before = authorizationOf(w.planning()).grants
  const recovered = await recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {})
  assert.equal(recovered.recovered, true)
  assert.deepEqual(authorizationOf(w.planning()).grants, before, 'recovery re-entered without issuing or reactivating a grant')
  assert.equal(w.memory.currentGoalGrant(KEY), undefined)
})

// --- the replacement wake: the run-C shape, triggered by a harness-evidenced admission blocker -------------------------

test('MW5 scenario: a preflight blocker freezes the slice, the planner is woken with [PLAN_BLOCKED], the replacement commits under the grant and the executor is handed the new version', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice(), replacementDraft()])
  const first = await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  assert.equal(first.operations[0].name, 'gather_resource')
  const goalId = w.planning().goal.goal_id
  const v1 = getActivePlan(w.planning())
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(v1.status))
  assert.equal(w.agent.agentContext.role, 'executor', 'the executor owns the committed slice')

  // Step 1 is verified by the game; the executor observes, then tries to feed a furnace that no longer exists.
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()

  // Calls: planner, executor observation, executor batch twice (stale target, one rebinding round), planner replacement.
  assert.equal(w.calls.length, 5)
  const wakeText = chatText([w.calls[4]])
  assert.match(wakeText, /\[PLAN_BLOCKED\]/)
  assert.match(wakeText, new RegExp(`committed plan ${v1.plan_id} \\(version 1\\)`))
  assert.match(wakeText, /blocker: operation_preflight_failed:stale_exact_target/)
  assert.match(wakeText, /1\. completed, deterministic: Gather 10 iron ore/)
  assert.match(wakeText, /2\. blocked, deterministic: Smelt the ore into iron plates in the furnace/)
  assert.match(wakeText, /3\. pending, deterministic: Craft 5 iron gear wheels/)
  assert.match(wakeText, new RegExp(`authorization: player_task:${goalId} revision 1`))
  assert.match(wakeText, /replacements used for this goal: 0 of 3/)
  assert.equal(w.agent.agentContext.role, 'executor', 'handed back to a fresh executor after the replacement committed')

  // The old plan is preserved as history; the successor carries lineage and the verified prefix.
  const planning = w.planning()
  const old = planning.plans.find(plan => plan.plan_id === v1.plan_id)
  const v2 = getActivePlan(planning)
  assert.equal(old.status, PLAN_STATUS.BLOCKED)
  assert.equal(old.superseded_by_plan_id, v2.plan_id)
  assert.equal(v2.plan_version, 2)
  assert.equal(v2.derived_from_plan_id, v1.plan_id)
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(v2.status))
  assert.deepEqual(v2.carried_forward_evidence, [`${v1.plan_id}:${v1.steps[0].step_id}`], 'the completed step is carried forward as verified evidence')
  assert.equal(v2.replacement.predecessor_plan_id, v1.plan_id)
  assert.equal(v2.replacement.grant_id, `player_task:${goalId}`)
  assert.equal(v2.replacement.action_scope, ACTION_SCOPE.RECOVERY)
  assert.equal(v2.replacement.reason.code, 'operation_preflight_failed:stale_exact_target')
  assert.ok(v2.replacement.reason.evidence_refs.length > 0, 'grounded in the admission evidence')
  assert.equal(v2.steps[0].description, REPLACED_PLAN[1])

  // The replacement's batch was admitted: the gather, then the new furnace; the dead insert never reached the game.
  assert.equal(w.game.mutations.length, 2)
  assert.ok(w.game.mutations[1].includes('place_entity'))
  assert.ok(!w.game.mutations.some(text => text.includes('move_items_exact')))
  assert.equal(result.operations[0].name, 'place_entity')

  // Traces: every one carries the request id and a reason.
  const requestId = w.named('plan.replacement_wake')[0].request_id
  assert.ok(requestId)
  const wake = w.data(w.named('plan.replacement_wake')[0])
  assert.equal(wake.plan_id, v1.plan_id)
  assert.equal(wake.reason_code, 'operation_preflight_failed:stale_exact_target')
  assert.equal(wake.grant_id, `player_task:${goalId}`)
  assert.equal(wake.replacements_used, 0)
  assert.equal(wake.reason, 'structural_blocker_with_current_grant')
  for (const name of ['plan.replacement_drafted', 'plan.replacement_committed', 'plan.replacement_announced']) {
    const row = w.named(name)[0]
    assert.ok(row, name)
    assert.ok(row.request_id, `${name} carries the request id`)
    assert.ok(w.data(row).reason, `${name} carries a reason`)
  }
  assert.equal(w.named('plan.replacement_committed')[0].request_id, requestId)
  const stages = w.named('authorization.grant_checked').map(row => w.data(row).stage)
  assert.ok(stages.includes('wake') && stages.includes('commit') && stages.includes('admission'), `grant checked at ${stages}`)
  const announced = w.data(w.named('plan.replacement_announced')[0])
  assert.equal(announced.chat_message, `Changed plan: something I was working on is gone. New plan v2 starts with: ${REPLACED_PLAN[1]}.`)
  assert.equal(announced.plan_id, v2.plan_id)
  assert.equal(w.named('plan.replacement_wake_skipped').length, 0)
  assert.equal(replacementsUsed(planning, `player_task:${goalId}`), 1)
})

test('MW5: a deadlock-blocked plan is not woken: deadlock signals count provider failures, which pause the goal', async () => {
  const w = world([plannerDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const v1 = getActivePlan(w.planning())
  w.memory.dispatchPlanningEvent(KEY, {
    type: PLANNING_EVENT.DEADLOCK_DETECTED, source: 'runtime', now: Date.now(), plan_id: v1.plan_id, reason_code: 'repeating_failure',
    signals: [{ kind: 'repeating_failure', step_id: v1.steps[0].step_id, detail: 'the same failure three times' }],
  })
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(await w.agent.wakePlannerForReplacement({ trigger: 'deadlock_detected' }), undefined)
  assert.equal(w.calls.length, 1, 'no provider call: the blocked end stands')
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'blocker_not_world_evidence')
  assert.equal(skipped.evidence_detail, 'unsupported_trigger:deadlock_detected')
  assert.equal(w.named('plan.replacement_wake').length, 0)
})

test('MW5: the supervisor prints the replacement line once per plan and keeps it in the conversation', () => {
  const printed = []
  const kept = []
  const session = {
    npcName: 'SGLuna',
    appendUiConversation: (role, name, line) => kept.push([role, name, line]),
    printChat: async (line) => { printed.push(line) },
    log: () => {},
  }
  const data = { plan_id: 'g_p2', chat_message: 'Changed plan: target not found. New plan v2 starts with: Place a new stone furnace.' }
  Session.prototype.announceReplacement.call(session, data)
  Session.prototype.announceReplacement.call(session, data)
  Session.prototype.announceReplacement.call(session, { plan_id: 'g_p3', chat_message: 'Changed plan: another. New plan v3 starts with: x.' })
  Session.prototype.announceReplacement.call(session, { plan_id: '', chat_message: 'ignored' })
  assert.deepEqual(printed, [data.chat_message, 'Changed plan: another. New plan v3 starts with: x.'])
  assert.equal(kept.length, 2)
  assert.deepEqual(kept[0], ['assistant', 'SGLuna', data.chat_message])
})

test('MW5: the wake is traced and skipped, and the request ends blocked as before, when there is no grant', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0]?.grant_id
      if (grantId) w.memory.revokeAuthorization(KEY, grantId, { reason: 'player withdrew' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 4, 'no planner wake')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(w.named('plan.replacement_wake').length, 0)
  const skipped = w.named('plan.replacement_wake_skipped')[0]
  assert.equal(w.data(skipped).reason, 'no_current_grant')
  assert.ok(skipped.request_id)
  assert.equal(result.operations.length, 0)
  assert.match(result.chatMessage, /Plan blocked/)
  assert.equal(w.game.mutations.length, 1, 'nothing past the first gather ran')
})

test('MW5: a grant that is no longer current for this actor is stale and the request ends blocked', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0]?.grant_id
      // The grant is revised to bind a different actor: the one executing is no longer covered by it.
      if (grantId) w.memory.reviseAuthorization(KEY, grantId, { actor: { actor_id: 99, actor_epoch: 1 } }, { reason: 'rebound' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 4)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'grant_stale')
  assert.equal(skipped.grant_reason, 'actor_replaced')
  assert.equal(w.named('plan.replacement_wake').length, 0)
})

test('MW5: after three accepted replacements the cap is reached and the request ends blocked, traced with the reason', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()], {
    game: gameWithMissingFurnace(() => {
      // The durable per-goal counter, as three earlier accepted replacements would have left it.
      const planning = w.planning()
      w.memory.planningByNpc.set(KEY, { ...planning, goal: { ...planning.goal, replacements_accepted: MAX_REPLACEMENTS_PER_GOAL } })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 4, 'no planner wake past the cap')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'replacement_cap_reached')
  assert.equal(skipped.replacements_used, MAX_REPLACEMENTS_PER_GOAL)
  assert.equal(skipped.cap, 3)
})

test('MW5: an actor epoch that changes while the wake is deciding fails safe: nothing is woken or committed', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const persist = w.agent.persistState.bind(w.agent)
  w.agent.persistState = async (...args) => {
    const result = await persist(...args)
    if (getActivePlan(w.planning())?.status === PLAN_STATUS.BLOCKED && !w.bumped) { w.bumped = true; w.game.status.epoch += 1 }
    return result
  }
  w.game.inventory['iron-ore'] = 10
  await assert.rejects(w.agent.completed(), /epoch changed|superseded|cancelled/i)
  assert.equal(w.calls.length, 4, 'the planner was never woken')
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'turn_superseded')
  assert.equal(w.named('plan.replacement_wake').length, 0)
  assert.equal(w.planning().plans.filter(plan => plan.replacement).length, 0)
})

test('MW5: a replacement that leaves the grant (scope not granted) asks the player, the old plan stays untouched and a chat line says what needs approval', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice(), replacementDraft()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0].grant_id
      w.memory.reviseAuthorization(KEY, grantId, { permitted_scope: [ACTION_SCOPE.SUPPORTING_WORK] }, { reason: 'player narrowed the request' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 5, 'the planner was woken and answered')
  const planning = w.planning()
  const active = getActivePlan(planning)
  assert.equal(active.status, PLAN_STATUS.BLOCKED, 'the old plan stays blocked and untouched')
  assert.equal(active.plan_version, 1)
  assert.equal(planning.plans.filter(plan => plan.replacement).length, 0)
  const question = authorizationOf(planning).questions.find(item => item.status === 'pending')
  assert.ok(question)
  assert.deepEqual(question.reason_codes, ['scope_not_granted'])
  const asked = w.named('plan.replacement_question_raised')[0]
  assert.ok(asked.request_id)
  assert.equal(w.data(asked).old_plan_frozen, true)
  assert.match(result.chatMessage, /needs work outside what your request covers/)
  assert.match(result.chatMessage, /Revise, Keep paused or Cancel/)
  assert.equal(w.named('plan.replacement_committed').length, 0)
  assert.equal(w.game.mutations.length, 1)
  const completed = w.data(w.named('request.completed').at(-1))
  assert.equal(completed.outcome, 'replacement_needs_approval')
})

test('MW5: a planner reply without operations gets repair rounds, then the request ends blocked and says so', async () => {
  const noOps = () => replacementDraft({ operations: [] })
  const w = world([plannerDraft(), observation(), ...staleTwice(), noOps(), noOps(), noOps()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 7)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(w.named('plan.replacement_draft_repair').length, 2)
  assert.equal(w.data(w.named('plan.replacement_refused')[0]).reason, 'draft_without_operations_after_repair')
  assert.match(result.chatMessage, /could not author a replacement plan/)
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'replacement_not_authored')
})

test('MW5: existing BLOCKED-awaiting-user behaviour is unchanged when the goal has no grant at all', async () => {
  // A goal admitted outside the chat path has no grant; the same blocker ends exactly as before MW5.
  const w = world([plannerDraft(), observation(), ...staleTwice()], {
    game: gameWithMissingFurnace(() => {
      const grants = authorizationOf(w.planning()).grants
      w.memory.planningByNpc.set(KEY, { ...w.planning(), authorization: { ...authorizationOf(w.planning()), grants: grants.filter(() => false) } })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(result.operations.length, 0)
  assert.equal(w.named('plan.replacement_wake').length, 0)
  assert.equal(w.data(w.named('plan.replacement_wake_skipped')[0]).reason, 'no_current_grant')
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'blocked_preflight')
})

// --- the pure pieces -------------------------------------------------------------------------------------------------

test('MW5: the [PLAN_BLOCKED] message states facts only: blocker, steps, verified prefix, grant, what needs the player', () => {
  const plan = {
    plan_id: 'g_p1',
    plan_version: 1,
    active_step_index: 1,
    blocker: { kind: 'structural', reason_code: 'operation_preflight_failed:stale_exact_target', detail: 'unit 77 is gone', evidence_refs: ['req_1/admission'] },
    carried_forward_evidence: [],
    steps: [
      { step_id: 's1', description: 'Place and fuel a stone furnace', completion_mode: 'deterministic' },
      { step_id: 's2', description: 'Smelt the ore', completion_mode: 'deterministic' },
    ],
    execution: { step_progress: { s1: { status: 'completed' }, s2: { status: 'active' } } },
  }
  const grant = { grant_id: 'player_task:g', revision: 2, mandate_kind: 'player_task', permitted_scope: ['recovery', 'route_change'], requested_result: { result_key: 'goal:g', destination: 'chest-1' } }
  const text = buildPlanBlockedMessage({ plan, grant, replacementsUsedCount: 1 })
  assert.equal(text, [
    '[PLAN_BLOCKED] The harness blocked committed plan g_p1 (version 1). It is preserved as history and cannot be edited.',
    'blocker: operation_preflight_failed:stale_exact_target - unit 77 is gone',
    'evidence: req_1/admission',
    'steps (status, completion mode, description):',
    '1. completed, deterministic: Place and fuel a stone furnace',
    '2. blocked, deterministic: Smelt the ore',
    'verified prefix: steps 1. Verified work stays verified in the successor.',
    'authorization: player_task:g revision 2 (player_task) permits recovery, route_change. The requested result stays goal:g delivered to chest-1; a replacement cannot change it.',
    'needs the player: changing the requested result or destination, removing or redesigning player-built structures, using reserved supplies. The harness checks each operation at admission.',
    'replacements used for this goal: 1 of 3.',
    'reply: an ordinary submitPlan. List every step of the plan, completed steps unchanged, with stepCompletions for every step, currentStep set to the first unfinished step, and the operations for that step. The harness validates it and commits it as a new plan version.',
  ].join('\n'))
  assert.equal(replacementAnnouncement({ plan: { plan_version: 3 }, blocker: { reason_code: 'source_depleted' }, firstStep: 'Find another patch' }), 'Changed plan: source depleted. New plan v3 starts with: Find another patch.')
  assert.match(replacementApprovalLine({ reasonCodes: ['protected_redesign'], detail: '' }), /removing or changing something you built/)
})

test('MW5: a loop built without the replacementWake option keeps the pre-MW5 behaviour (no grant, no wake), and the supervisor turns it on', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()], { agentOptions: { replacementWake: undefined } })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  assert.deepEqual(authorizationOf(w.planning()).grants, [])
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 4)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(result.operations.length, 0)
  assert.equal(w.named('plan.replacement_wake').length + w.named('plan.replacement_wake_skipped').length, 0)
  assert.equal(w.named('authorization.granted').length, 0)
  const supervisorSource = (await import('node:fs')).readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8')
  assert.match(supervisorSource, /replacementWake: true/)
})

// --- what counts as world evidence ----------------------------------------------------------------------------------------

test('MW5: the world-change allowlist is explicit, default-deny, and never overlaps the codes that must keep the blocked end', () => {
  assert.deepEqual(Object.keys(WORLD_CHANGE_PREFLIGHT_CODES).sort(), ['destination_full', 'extraction_empty', 'stale_exact_target', 'supply_missing'])
  for (const code of Object.keys(WORLD_CHANGE_PREFLIGHT_CODES)) assert.ok(!NEVER_WAKE_PREFLIGHT_CODES.includes(code), code)
  for (const code of ['protected_entity_refused', 'reserved_supply_refused', 'player_inventory_excluded', 'authorization_stale', 'duplicate_effect_suppressed']) {
    assert.ok(NEVER_WAKE_PREFLIGHT_CODES.includes(code), code)
    assert.equal(blockerWorldEvidence({ trigger: 'operation_preflight_blocker', preflight: { code }, existed: true }).ok, false, code)
  }
  assert.equal(blockerWorldEvidence({ trigger: 'operation_preflight_blocker', preflight: { code: 'brand_new_code' }, existed: true }).ok, false, 'an unlisted code is denied')
  assert.equal(blockerWorldEvidence({ trigger: 'operation_preflight_blocker', preflight: { code: 'extraction_empty' } }).ok, true)
  assert.equal(blockerWorldEvidence({ trigger: 'operation_preflight_blocker', preflight: { code: 'stale_exact_target' }, existed: false }).detail, 'target_existence_unproven')
  assert.equal(blockerWorldEvidence({ trigger: 'operation_preflight_blocker', preflight: { code: 'stale_exact_target' }, existed: true }).ok, true)
  assert.equal(blockerWorldEvidence({ trigger: 'operation_admission_failure', provenRefusal: false }).ok, false)
  assert.equal(blockerWorldEvidence({ trigger: 'operation_admission_failure', provenRefusal: true }).ok, true)
})

test('MW5: an allowlisted code with a unit number nobody placed, observed or recorded is not evidence the target existed', async () => {
  // The loop already refuses an exact unit that no live observation bound before it reaches preflight
  // (exact_entity_requires_live_observation); the wake keeps its own check as a second line.
  const w = world([plannerDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const v1 = getActivePlan(w.planning())
  w.memory.dispatchPlanningEvent(KEY, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, source: 'runtime', now: Date.now(), plan_id: v1.plan_id,
    reason_code: 'operation_preflight_failed:stale_exact_target', detail: 'unit 999 is gone', evidence_refs: ['req_x/admission'],
  })
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const preflight = { code: 'stale_exact_target', identity: 999 }
  assert.equal(w.agent.unitHadExisted(999, preflight), false, 'invented: no placement receipt, no observation, no mod record')
  assert.equal(w.agent.unitHadExisted(999, { ...preflight, last_observed: { unit_number: 999 } }), true, 'the mod saw it')
  assert.equal(w.agent.unitHadExisted(77, preflight), false)
  assert.equal(await w.agent.wakePlannerForReplacement({ trigger: 'operation_preflight_blocker', preflight, existed: false }), undefined)
  assert.equal(w.calls.length, 1, 'no provider call')
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'blocker_not_world_evidence')
  assert.equal(skipped.evidence_detail, 'target_existence_unproven')
  assert.equal(w.named('plan.replacement_wake').length, 0)
  // An NPC placement receipt is evidence the unit existed.
  w.memory.recordNpcPlacement(KEY, { unit_number: 999, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 })
  assert.equal(w.agent.unitHadExisted(999, preflight), true)
})

test('MW5: an authorization refusal is never world evidence and keeps the blocked end', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice()], { game: gameWithMissingFurnace(undefined, { code: 'protected_entity_refused' }) })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 4, 'one correction round, then the blocked end')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'blocker_not_world_evidence')
  assert.equal(skipped.evidence_detail, 'code_not_world_change:protected_entity_refused')
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'blocked_preflight')
})

test('MW5: operations.preflight_rejected is traced before the wake, and a blocked pre-commit draft never wakes (plan_not_committed)', async () => {
  const draft = () => planReply({
    plan: ['Feed the ore into the furnace'],
    currentStep: 0,
    operations: [insertOre()],
    goal: GOAL,
    stepCompletions: [det(plates)],
  })
  const w = world([observation(), draft(), draft()])
  const result = await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const plan = getActivePlan(w.planning())
  assert.equal(plan.status, PLAN_STATUS.BLOCKED)
  assert.equal(plan.committed_at, null, 'the plan was never committed')
  assert.equal(w.calls.length, 3)
  assert.equal(w.data(w.named('plan.replacement_wake_skipped')[0]).reason, 'plan_not_committed')
  assert.equal(result.operations.length, 0)
  const order = w.rows.map(row => row.event)
  assert.ok(order.indexOf('operations.preflight_rejected') < order.indexOf('plan.replacement_wake_skipped'), 'the rejection is traced first')
})

// --- the admission-failure hook ---------------------------------------------------------------------------------------------

const executorPlace = () => planReply({ plan: IRON_PLAN, currentStep: 1, operations: [placeFurnace()] })

test('MW5: an admission refusal the game proved happened before any mutation wakes the planner; one that may have run does not', async () => {
  for (const proven of [true, false]) {
    const refuse = () => { w.game.syncRefusal = { slot: 1, operation: 'place_entity', error: 'no free tile', proven } }
    const w = world((call) => {
      if (call === 1) return plannerDraft()
      if (call === 2) { refuse(); return executorPlace() }
      return replacementDraft()
    }, { game: new FakeFactorio() })
    await w.agent.request(OBJECTIVE, { sender: 'Louis' })
    w.game.inventory['iron-ore'] = 10
    if (proven) {
      await w.agent.completed()
      assert.equal(w.named('plan.replacement_wake').length, 1, 'proven refusal: woken')
      assert.equal(w.data(w.named('plan.replacement_wake')[0]).trigger, 'operation_admission_failure')
      assert.equal(getActivePlan(w.planning()).plan_version, 2)
    }
    else {
      await assert.rejects(w.agent.completed())
      assert.equal(w.named('plan.replacement_wake').length, 0)
      assert.equal(w.data(w.named('plan.replacement_wake_skipped')[0]).reason, 'batch_may_have_run')
      assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
    }
  }
})

// --- verdict paths ----------------------------------------------------------------------------------------------------------

test('MW5: a refused verdict (the grant was revoked while the planner was answering) leaves the old plan blocked and says so', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice(), (memory) => {
    memory.revokeAuthorization(KEY, authorizationOf(memory.planningState(KEY)).grants[0].grant_id, { reason: 'player withdrew' })
    return replacementDraft()
  }])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 5)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(getActivePlan(w.planning()).plan_version, 1)
  const refused = w.named('plan.replacement_refused')[0]
  assert.ok(refused.request_id)
  assert.equal(w.data(refused).reason, 'grant_revoked')
  assert.match(result.chatMessage, /did not accept a replacement \(grant_revoked\)/)
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'replacement_refused')
  assert.equal(w.planning().goal.replacements_accepted ?? 0, 0, 'a refusal is not counted')
})

test('MW5: a wake with no parked planner restages a fresh planner whose packet carries the blocked plan facts', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice(), replacementDraft()], {
    game: gameWithMissingFurnace(() => { w.agent.agentContext.dropParkedPlanner() }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const v1 = getActivePlan(w.planning())
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  const restaged = w.named('context.restaged').find(row => w.data(row).role === 'planner')
  assert.ok(restaged, 'a fresh planner was built from a packet')
  assert.equal(w.data(restaged).checkpoint, 'C1')
  assert.match(w.data(restaged).reason, /planner_fresh_for_replacement_no_parked_context/)
  const plannerCall = chatText([w.calls[4]])
  assert.match(plannerCall, new RegExp(v1.plan_id), 'the packet names the blocked plan')
  assert.match(plannerCall, /BLOCKED/)
  assert.match(plannerCall, /Smelt the ore into iron plates in the furnace/)
  assert.match(plannerCall, /\[PLAN_BLOCKED\]/)
  assert.equal(getActivePlan(w.planning()).plan_version, 2, 'and the replacement still committed')
})

// --- several replacements in one request -------------------------------------------------------------------------------------

test('MW5: three real replacements in one request commit; the fourth block reaches the cap and ends blocked', async () => {
  let draftNumber = 1
  const w = world((call, memory, calls) => {
    const system = String(calls.at(-1)[0].content)
    if (/ROLE: EXECUTOR/.test(system)) {
      // The executor works from the reducer's plan block: a replacement's steps are the suffix after the verified prefix.
      const held = getActivePlan(memory.planningState(KEY))
      if (!calls.at(-1).some(message => message.role === 'tool')) return observation()
      return planReply({ plan: held.steps.map(step => step.description), currentStep: held.active_step_index, operations: [insertOre()] })
    }
    if (w.named('plan.replacement_wake').length >= draftNumber) { // one draft per wake the harness traced
      draftNumber += 1
      const board = memory.currentPlan(KEY).task_board
      const plan = board.steps.map((step, index) => (index === 1 ? `Place furnace attempt ${draftNumber}` : step.description))
      return planReply({ plan, currentStep: 1, operations: [placeFurnace()], stepCompletions: board.steps.map((_, index) => det([ore, plates, gears][index])) })
    }
    return plannerDraft()
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  for (let cycle = 1; cycle <= 3; cycle++) {
    await w.agent.completed()
    assert.equal(getActivePlan(w.planning()).plan_version, cycle + 1, `replacement ${cycle} committed`)
    assert.equal(w.planning().goal.replacements_accepted, cycle)
  }
  await w.agent.completed()
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED, 'the fourth block waits for the player')
  assert.equal(getActivePlan(w.planning()).plan_version, 4)
  assert.equal(w.named('plan.replacement_wake').length, 3)
  const skipped = w.data(w.named('plan.replacement_wake_skipped').at(-1))
  assert.equal(skipped.reason, 'replacement_cap_reached')
  assert.equal(skipped.replacements_used, 3)
  assert.equal(w.named('plan.replacement_announced').length, 3)
})

// --- re-drafting an accepted successor -----------------------------------------------------------------------------------------

function redraftWorld(secondDraft) {
  // The replacement's first batch hits a model-correctable preflight (unknown prototype) once, so the planner re-submits.
  let rejected = false
  const game = gameWithMissingFurnace()
  const base = game.preflight
  game.preflight = (text) => {
    if (text.includes('place_entity') && !rejected) {
      rejected = true
      return { ok: false, code: 'unknown_prototype', operation: 'place_entity', field: 'entity_name', identity: 'stone-furnace' }
    }
    return base(text)
  }
  return world([plannerDraft(), observation(), ...staleTwice(), replacementDraft(), secondDraft], { game })
}

test('MW5: re-submitting the same replacement steps after a correctable preflight passes through and commits once', async () => {
  const w = redraftWorld(replacementDraft())
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  const plan = getActivePlan(w.planning())
  assert.equal(plan.plan_version, 2)
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status))
  assert.equal(w.planning().goal.replacements_accepted, 1, 'the re-draft is not counted again')
  assert.equal(w.named('plan.replacement_drafted').length, 1)
  assert.equal(w.named('plan.replacement_committed').length, 1)
  assert.equal(w.named('plan.replacement_wake').length, 1, 'no second wake')
  assert.equal(result.operations[0].name, 'place_entity')
})

test('MW5: re-drafting the accepted successor with different steps ends BLOCKED visibly with a trace instead of failing at the commit and waking again', async () => {
  const changed = () => planReply({
    plan: [IRON_PLAN[0], 'Place a different furnace somewhere else', IRON_PLAN[2]],
    currentStep: 1,
    operations: [placeFurnace()],
    stepCompletions: [det(ore), det(plates), det(gears)],
  })
  const w = redraftWorld(changed())
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  const refused = w.named('plan.replacement_refused').find(row => w.data(row).reason === 'redraft_steps_changed_since_authorization')
  assert.ok(refused?.request_id)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(getActivePlan(w.planning()).blocker.reason_code, 'replacement_redraft_changed')
  assert.equal(w.named('plan.replacement_wake').length, 1, 'one wake only')
  assert.match(result.chatMessage, /changed after the harness checked it/)
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'replacement_redraft_refused')
  assert.equal(w.named('plan.replacement_committed').length, 0)
})

// --- grant issuance ----------------------------------------------------------------------------------------------------------

test('MW5: admission never re-activates a revoked player_task grant, and issues one only when the goal has none', async () => {
  const w = world([plannerDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const goal = w.planning().goal
  const grantId = authorizationOf(w.planning()).grants[0].grant_id
  assert.equal(w.memory.hasPlayerTaskGrant(KEY), true)
  assert.equal(await w.agent.grantPlayerObjective(KEY, goal, OBJECTIVE), undefined, 'already granted')
  w.memory.revokeAuthorization(KEY, grantId, { reason: 'player withdrew' })
  const before = authorizationOf(w.planning()).grants
  assert.equal(await w.agent.grantPlayerObjective(KEY, goal, OBJECTIVE), undefined, 'a revoked grant is not re-activated')
  assert.deepEqual(authorizationOf(w.planning()).grants, before)
})

test('MW5: the replacement counter lives on the goal record and survives snapshot and restore', async () => {
  const w = world([plannerDraft(), observation(), ...staleTwice(), replacementDraft()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.planning().goal.replacements_accepted, 1)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.equal(restored.replacementsUsed(KEY), 1)
  assert.equal(replacementsUsed(restored.planningState(KEY)), 1)
})
