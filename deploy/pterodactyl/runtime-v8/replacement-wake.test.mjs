import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_SCOPE, authorizationOf, MANDATE_KIND } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'
import {
  buildPlanBlockedMessage,
  MAX_REPLACEMENTS_PER_GOAL,
  playerObjectiveGrant,
  replacementAnnouncement,
  replacementApprovalLine,
  replacementsUsed,
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
const executorInsert = () => planReply({ plan: IRON_PLAN, currentStep: 1, operations: [insertOre()] })
const replacementDraft = (overrides = {}) => planReply({
  chatMessage: 'The furnace is gone; placing a new one.',
  plan: REPLACED_PLAN,
  currentStep: 1,
  operations: [placeFurnace()],
  stepCompletions: [det(ore), det(plates), det(gears)],
  ...overrides,
})

// The furnace the executor was about to feed no longer exists when the harness preflights the batch.
function gameWithMissingFurnace(onBlocked) {
  const game = new FakeFactorio({
    preflight: (text) => {
      if (!text.includes(String(FURNACE))) return { ok: true }
      onBlocked?.()
      return { ok: false, code: 'target_not_found', operation: 'move_items_exact', field: 'unit_number', identity: FURNACE }
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
      const reply = script[calls.length - 1]
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
  const w = world([plannerDraft(), observation(), executorInsert(), replacementDraft()])
  const first = await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  assert.equal(first.operations[0].name, 'gather_resource')
  const goalId = w.planning().goal.goal_id
  const v1 = getActivePlan(w.planning())
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(v1.status))
  assert.equal(w.agent.agentContext.role, 'executor', 'the executor owns the committed slice')

  // Step 1 is verified by the game; the executor observes, then tries to feed a furnace that no longer exists.
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()

  // Calls: planner, executor observation, executor batch (blocked at preflight), planner replacement.
  assert.equal(w.calls.length, 4)
  const wakeText = chatText([w.calls[3]])
  assert.match(wakeText, /\[PLAN_BLOCKED\]/)
  assert.match(wakeText, new RegExp(`committed plan ${v1.plan_id} \\(version 1\\)`))
  assert.match(wakeText, /blocker: operation_preflight_failed:target_not_found/)
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
  assert.equal(v2.replacement.reason.code, 'operation_preflight_failed:target_not_found')
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
  assert.equal(wake.reason_code, 'operation_preflight_failed:target_not_found')
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
  assert.equal(announced.chat_message, `Changed plan: target not found. New plan v2 starts with: ${REPLACED_PLAN[1]}.`)
  assert.equal(announced.plan_id, v2.plan_id)
  assert.equal(w.named('plan.replacement_wake_skipped').length, 0)
  assert.equal(replacementsUsed(planning, `player_task:${goalId}`), 1)
})

test('MW5: a deadlock-blocked plan wakes the planner the same way, with synthesized evidence refs, and the replacement count survives a restart', async () => {
  const w = world([plannerDraft(), planReply({
    plan: ['Gather 10 iron ore from the second patch', IRON_PLAN[1], IRON_PLAN[2]],
    currentStep: 0,
    operations: [gather('iron-ore', 10)],
    checkpoint: ore,
    stepCompletions: [det(ore), det(plates), det(gears)],
  })])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const v1 = getActivePlan(w.planning())
  w.memory.dispatchPlanningEvent(KEY, {
    type: PLANNING_EVENT.DEADLOCK_DETECTED, source: 'runtime', now: Date.now(), plan_id: v1.plan_id, reason_code: 'repeating_failure',
    signals: [{ kind: 'repeating_failure', step_id: v1.steps[0].step_id, detail: 'the same failure three times' }],
  })
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const result = await w.agent.wakePlannerForReplacement({ trigger: 'deadlock_detected' })
  assert.equal(w.calls.length, 2)
  assert.match(chatText([w.calls[1]]), /blocker: repeating_failure - the same failure three times/)
  assert.match(chatText([w.calls[1]]), new RegExp(`evidence: ${v1.plan_id}/deadlock/repeating_failure`))
  const v2 = getActivePlan(w.planning())
  assert.equal(v2.plan_version, 2)
  assert.equal(v2.replacement.reason.code, 'repeating_failure')
  assert.deepEqual(v2.replacement.reason.evidence_refs, [`${v1.plan_id}/deadlock/repeating_failure`])
  assert.equal(result.operations[0].name, 'gather_resource')
  assert.equal(w.data(w.named('plan.replacement_wake')[0]).trigger, 'deadlock_detected')
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.equal(restored.replacementsUsed(KEY, v2.replacement.grant_id), 1, 'the cap reads the durable plan lineage')
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
  const w = world([plannerDraft(), observation(), executorInsert()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0]?.grant_id
      if (grantId) w.memory.revokeAuthorization(KEY, grantId, { reason: 'player withdrew' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 3, 'no planner wake')
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
  const w = world([plannerDraft(), observation(), executorInsert()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0]?.grant_id
      // The grant is revised to bind a different actor: the one executing is no longer covered by it.
      if (grantId) w.memory.reviseAuthorization(KEY, grantId, { actor: { actor_id: 99, actor_epoch: 1 } }, { reason: 'rebound' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 3)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'grant_stale')
  assert.equal(skipped.grant_reason, 'actor_replaced')
  assert.equal(w.named('plan.replacement_wake').length, 0)
})

test('MW5: after three accepted replacements the cap is reached and the request ends blocked, traced with the reason', async () => {
  const w = world([plannerDraft(), observation(), executorInsert()], {
    game: gameWithMissingFurnace(() => {
      const planning = w.planning()
      const grantId = authorizationOf(planning).grants[0].grant_id
      const template = getActivePlan(planning)
      const used = Array.from({ length: MAX_REPLACEMENTS_PER_GOAL }, (_, index) => ({
        ...structuredClone(template), plan_id: `old_${index}`, status: PLAN_STATUS.SUPERSEDED, replacement: { grant_id: grantId, grant_revision: 1, predecessor_plan_id: 'x' },
      }))
      w.memory.planningByNpc.set(KEY, { ...planning, plans: [...used, ...planning.plans] })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 3, 'no planner wake past the cap')
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'replacement_cap_reached')
  assert.equal(skipped.replacements_used, MAX_REPLACEMENTS_PER_GOAL)
  assert.equal(skipped.cap, 3)
})

test('MW5: an actor epoch that changes while the wake is deciding fails safe: nothing is woken or committed', async () => {
  const w = world([plannerDraft(), observation(), executorInsert()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  const persist = w.agent.persistState.bind(w.agent)
  w.agent.persistState = async (...args) => {
    const result = await persist(...args)
    if (getActivePlan(w.planning())?.status === PLAN_STATUS.BLOCKED && !w.bumped) { w.bumped = true; w.game.status.epoch += 1 }
    return result
  }
  w.game.inventory['iron-ore'] = 10
  await assert.rejects(w.agent.completed(), /epoch changed|superseded|cancelled/i)
  assert.equal(w.calls.length, 3, 'the planner was never woken')
  const skipped = w.data(w.named('plan.replacement_wake_skipped')[0])
  assert.equal(skipped.reason, 'turn_superseded')
  assert.equal(w.named('plan.replacement_wake').length, 0)
  assert.equal(w.planning().plans.filter(plan => plan.replacement).length, 0)
})

test('MW5: a replacement that leaves the grant (scope not granted) asks the player, the old plan stays untouched and a chat line says what needs approval', async () => {
  const w = world([plannerDraft(), observation(), executorInsert(), replacementDraft()], {
    game: gameWithMissingFurnace(() => {
      const grantId = authorizationOf(w.planning()).grants[0].grant_id
      w.memory.reviseAuthorization(KEY, grantId, { permitted_scope: [ACTION_SCOPE.SUPPORTING_WORK] }, { reason: 'player narrowed the request' })
    }),
  })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 4, 'the planner was woken and answered')
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
  const w = world([plannerDraft(), observation(), executorInsert(), noOps(), noOps(), noOps()])
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 6)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(w.named('plan.replacement_draft_repair').length, 2)
  assert.equal(w.data(w.named('plan.replacement_refused')[0]).reason, 'draft_without_operations_after_repair')
  assert.match(result.chatMessage, /could not author a replacement plan/)
  assert.equal(w.data(w.named('request.completed').at(-1)).outcome, 'replacement_not_authored')
})

test('MW5: existing BLOCKED-awaiting-user behaviour is unchanged when the goal has no grant at all', async () => {
  // A goal admitted outside the chat path has no grant; the same blocker ends exactly as before MW5.
  const w = world([plannerDraft(), observation(), executorInsert()], {
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
    blocker: { kind: 'structural', reason_code: 'operation_preflight_failed:target_not_found', detail: 'unit 77 is gone', evidence_refs: ['req_1/admission'] },
    carried_forward_evidence: [],
    steps: [
      { step_id: 's1', description: 'Gather 10 iron ore', completion_mode: 'deterministic' },
      { step_id: 's2', description: 'Smelt the ore', completion_mode: 'deterministic' },
    ],
    execution: { step_progress: { s1: { status: 'completed' }, s2: { status: 'active' } } },
  }
  const grant = { grant_id: 'player_task:g', revision: 2, mandate_kind: 'player_task', permitted_scope: ['recovery', 'route_change'], requested_result: { result_key: 'goal:g', destination: 'chest-1' } }
  const text = buildPlanBlockedMessage({ plan, grant, replacementsUsedCount: 1 })
  assert.equal(text, [
    '[PLAN_BLOCKED] The harness blocked committed plan g_p1 (version 1). It is preserved as history and cannot be edited.',
    'blocker: operation_preflight_failed:target_not_found - unit 77 is gone',
    'evidence: req_1/admission',
    'steps (status, completion mode, description):',
    '1. completed, deterministic: Gather 10 iron ore',
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
  const w = world([plannerDraft(), observation(), executorInsert()], { agentOptions: { replacementWake: undefined } })
  await w.agent.request(OBJECTIVE, { sender: 'Louis' })
  assert.deepEqual(authorizationOf(w.planning()).grants, [])
  w.game.inventory['iron-ore'] = 10
  const result = await w.agent.completed()
  assert.equal(w.calls.length, 3)
  assert.equal(getActivePlan(w.planning()).status, PLAN_STATUS.BLOCKED)
  assert.equal(result.operations.length, 0)
  assert.equal(w.named('plan.replacement_wake').length + w.named('plan.replacement_wake_skipped').length, 0)
  assert.equal(w.named('authorization.granted').length, 0)
  const supervisorSource = (await import('node:fs')).readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8')
  assert.match(supervisorSource, /replacementWake: true/)
})
