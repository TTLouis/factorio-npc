import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { AgentLoopError, NpcAgentLoop } from './npc-agent-loop.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { applyPlanningEvent, getActivePlan, MAX_REVIEW_CONTINUATIONS_PER_GOAL, PLANNING_EVENT } from './planning-state.mjs'
import { POST_BATCH_COVERAGE_REASON } from './post-batch-facts.mjs'
import { buildPendingOperation, EFFECT } from './operation-reconciliation.mjs'
import { manualSupplyDrift, normalizeExecutionGuidance, normalizePlannerReview } from './role-contracts.mjs'
import { classifyRequestFailure } from './pause-class.mjs'
import { Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { executionOnlyControlToolDefinitions, planningOnlyControlToolDefinitions } from './structured-policy.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const runAB = JSON.parse(await fs.readFile(new URL('./fixtures/run-ab-executor-review.json', import.meta.url), 'utf8'))
const brief = (skillIds = []) => ({ approach: 'Gather the copper needed for the current slice.',
  rationale: 'A small stock requirement does not repay extra setup yet.', constraints: ['Keep the requested quantity.'], skillIds })
const draft = (overrides = {}) => ({ chatMessage: '', plan: ['Gather ten copper ore'], currentStep: 0, operations: [],
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }],
  executionGuidance: [brief()],
  goal: { scope: 'finite', summary: 'Gather ten copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] },
  ...overrides })

function world(script, options = {}) {
  const { game = new FakeFactorio(), objective = 'Gather ten copper ore.', ...loopOptions } = options
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory, completionProtocolVersion: 3, replacementWake: true,
    provider: answersStepContract(async (messages, context) => {
      calls.push({ messages, context })
      const next = script[calls.length - 1]
      assert.ok(next, `Unexpected provider call ${calls.length}`)
      const reply = typeof next === 'function' ? await next({ agent, game, memory, messages, context }) : next
      return reply.tool_calls ? reply : planReply(reply)
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'Scripted role separation fixture.', npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null,
    onActivity: (event, data) => events.push({ event, data }), ...loopOptions,
  })
  return { agent, game, memory, calls, events, say: () => agent.request(objective, { sender: 'Louis' }),
    plan: () => getActivePlan(memory.planningState(KEY)) }
}

const action = ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id,
  operations: [gather('copper-ore', 10)] })

const submit = args => ({ content: '', tool_calls: [{ id: 'role-contract-submit', type: 'function',
  function: { name: 'submitPlan', arguments: JSON.stringify(args) } }] })

test('submitPlan tool transport carries the planner brief and executor step identity through the real loop', async () => {
  const w = world([submit(draft()), ctx => submit(action(ctx))])
  await w.say()
  assert.equal(w.calls.length, 2)
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief())
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'provider.plan_submission_invalid').length, 0)
})

test('protocol 3 commits planning-only guidance before the executor chooses the first action', async () => {
  let identity
  const w = world([draft(), ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.completionProtocolVersion, 3)
    assert.equal(ctx.game.mutations.length, 0)
    identity = ctx.agent.controlDecisionState(true)
    assert.deepEqual(identity.executionGuidance, brief())
    const outgoing = ctx.messages.map(row => row.content ?? '').join('\n')
    assert.match(outgoing, /execution_guidance.*Gather the copper/)
    assert.match(outgoing, /ROLE: EXECUTOR/)
    return action(ctx)
  }])
  await w.say()
  assert.equal(w.calls[0].context.role, 'planner')
  assert.equal(w.calls.length, 2)
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief())
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 0)
  const event = w.events.find(row => row.event === 'plan.delegation_committed')
  assert.ok(event.data.request_id)
  assert.equal(event.data.plan_id, identity.planId)
})

test('planner action proposals get a bounded correction before any admission', async () => {
  const w = world([draft({ operations: [gather('copper-ore', 10)] }), draft(), action])
  await w.say()
  assert.equal(w.calls.length, 3)
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'planner', 'executor'])
  assert.equal(w.game.mutations.length, 1)
  const event = w.events.find(row => row.event === 'role.contract_refused')
  assert.equal(event.data.reason, 'planner_cannot_mutate')
  assert.ok(event.data.request_id)
})

test('programmatic planner admission cannot bypass the action prohibition', async () => {
  const w = world([])
  await assert.rejects(w.agent.commitPlan(draft({ operations: [gather('copper-ore', 10)] })), /planner chooses strategy/)
  assert.equal(w.game.mutations.length, 0)
})

test('selecting an unloaded strategy skill is corrected instead of claiming its contents were considered', async () => {
  const w = world([draft({ executionGuidance: [brief(['not-loaded'])] }), draft(), action])
  await w.say()
  assert.equal(w.calls.length, 3)
  assert.equal(w.events.find(row => row.event === 'role.contract_refused').data.reason, 'invalid_execution_guidance')
})

test('three large cached details cannot select a skill omitted by the planner context ceiling', async () => {
  const ids = ['large-a', 'large-b', 'large-c']
  const visible = ids.slice(1)
  const w = world([
    { tool_calls: ids.map((id, index) => ({ id: `large-skill-${index}`, type: 'function',
      function: { name: 'getSkillDetails', arguments: JSON.stringify({ id }) } })) },
    ({ agent, game, messages }) => {
      assert.equal(agent.loadedSkillContext.size, 3, 'all three reads succeeded')
      const context = messages.find(row => String(row.content).startsWith('[SKILL_CONTEXT]')).content
      const details = JSON.parse(context.slice(context.indexOf('\n') + 1))
      assert.deepEqual(details.map(skill => skill.id), visible)
      assert.ok(context.length < 16500)
      assert.equal(game.mutations.length, 0)
      return draft({ executionGuidance: [brief(ids)] })
    },
    draft({ executionGuidance: [brief(visible)] }),
    ctx => {
      const context = ctx.messages.find(row => String(row.content).startsWith('[SKILL_CONTEXT]')).content
      const details = JSON.parse(context.slice(context.indexOf('\n') + 1))
      assert.deepEqual(details.map(skill => skill.id), visible, 'executor receives every selected detail')
      return action(ctx)
    },
  ])
  for (const id of ids) w.game.skills[id] = { id, summary: `Strategy ${id}`,
    constraints: Array.from({ length: 10 }, () => ({ description: 'x'.repeat(580) })) }
  await w.say()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'planner', 'planner', 'executor'])
  assert.deepEqual(w.plan().steps[0].execution_guidance.skillIds, visible)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'role.contract_refused' && row.data.reason === 'invalid_execution_guidance').length, 1)
})

test('the active brief persists through restart, isolates selected skills and cannot be rewritten by an executor', async () => {
  const w = world([({ agent }) => {
    agent.loadedSkillContext.set('selected', { id: 'selected', marker: 'SELECTED-DETAILS' })
    agent.loadedSkillContext.set('other', { id: 'other', marker: 'UNRELATED-ALTERNATIVE' })
    return draft({ executionGuidance: [brief(['selected'])] })
  }, ctx => {
    const context = ctx.agent.skillContext()
    assert.match(context, /SELECTED-DETAILS/)
    assert.doesNotMatch(context, /UNRELATED-ALTERNATIVE/)
    assert.equal(ctx.agent.roundTailBlocks().some(block => block.startsWith('[SKILL_OFFERS]')), false)
    return { ...action(ctx), plan: ['A different strategy'], executionGuidance: [brief(['other'])] }
  }])
  await w.say()
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief(['selected']))
  assert.ok(w.events.some(row => row.event === 'executor.plan_semantics_ignored' && row.data.ignored_fields.includes('executionGuidance')))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual(getActivePlan(restored.planningState(KEY)).steps[0].execution_guidance, brief(['selected']))
  const packet = buildHandoffPacket({ planningState: restored.planningState(KEY), role: 'executor', checkpoint: 'C6' })
  assert.match(packet.text, /execution_guidance.*selected/)
})

const plannerRound = draft({ chatMessage: 'Planner notes: the step stands.' })
const review = (reason, rationale = 'A strategic decision is needed.') => ({ memory }) =>
  ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [], plannerReview: { reason, rationale } })

for (const reason of ['approach_infeasible', 'scope_change', 'local_recovery_exhausted']) {
  test(`executor ${reason} gets one planner round, then a second review of the step takes a model_recoverable pause without blocker evidence or allowance reset`, async () => {
    let before
    const w = world([draft(), ctx => {
      before = ctx.memory.planningState(KEY)
      return review(reason)(ctx)
    }, ({ messages, context }) => {
      assert.equal(context.role, 'planner')
      assert.equal(context.allowTools, true, 'the review round may read before replying')
      const outgoing = messages.map(row => row.content ?? '').join('\n')
      assert.match(outgoing, /\[EXECUTOR_REVIEW\]/)
      assert.match(outgoing, /one planner review round for this step/)
      return draft({ chatMessage: 'Planner notes: the step stands.', plan: ['A tempting different strategy'] })
    }, ctx => {
      assert.equal(ctx.context.role, 'executor')
      return review(reason, 'Still blocked after the planner round.')(ctx)
    }])
    const result = await w.say()
    assert.equal(result.blocker.class, 'planner_review_required')
    assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor'], 'one bounded planner round, no further cycle')
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.agent.agentContext.role, 'planner')
    assert.ok(w.agent.messages.some(row => String(row.content).startsWith('[EXECUTOR_REVIEW]') && row.content.includes('Still blocked')))
    assert.deepEqual(w.memory.planningState(KEY).goal.review_continuation_steps, [getActivePlan(before).steps[0].step_id])
    assert.equal(w.events.filter(row => row.event === 'planner.review_round').length, 1)
    assert.match(JSON.stringify(w.memory.snapshot()), /Executor advisory; unverified/)
    assert.equal(w.memory.currentPlan(KEY).status, 'paused')
    assert.equal(w.memory.pauseRecord(KEY).pause_class, 'model_recoverable', 'advisory review pauses resume within the model_recoverable caps')
    assert.notEqual(w.plan().status, 'BLOCKED', 'model claim is not world proof')
    assert.equal(w.plan().plan_id, getActivePlan(before).plan_id)
    assert.deepEqual(w.plan().steps, getActivePlan(before).steps)
    assert.equal(w.memory.planningState(KEY).goal.fresh_context_recovery_used, before.goal.fresh_context_recovery_used)
    assert.equal(w.agent.providerBudgetGeneration, 1)
    assert.ok(w.events.find(row => row.event === 'executor.planner_review_requested').data.request_id)
    assert.equal(w.events.filter(row => row.event === 'plan.replacement_wake').length, 0)
  })
}

const PLANNER_NOTES = 'Planner notes: read the furnace footprint first.'

// Runs AD-AF (2026-10-19): the second review of a step was a guard pause and the unattended goal ended there. The pause is
// model_recoverable now: the supervisor schedules its bounded resume and a fresh executor acts on the same step, goal active.
test('a second executor review of the step is auto-resumed by the supervisor and the restaged executor acts on the same step', async t => {
  let planId
  const w = world([draft(), review('local_recovery_exhausted'), draft({ chatMessage: PLANNER_NOTES }),
    review('local_recovery_exhausted', 'Still blocked after the planner round.'), ctx => {
      assert.equal(ctx.context.role, 'executor')
      // The restage replaced the conversation that held the planner's reply; the durable notes ride in the handoff packet.
      const carried = ctx.messages.filter(message => typeof message.content === 'string' && message.content.includes(PLANNER_NOTES))
      assert.ok(carried.length > 0, 'the resumed executor still sees the planner notes for this step')
      assert.ok(carried.every(message => message.content.includes('planner_review_notes') && message.content.includes('advisory, not world evidence')))
      assert.equal(ctx.memory.currentPlan(KEY).status, 'active', 'the resume reactivates the goal before the executor restage')
      assert.equal(getActivePlan(ctx.memory.planningState(KEY)).plan_id, planId)
      return action(ctx)
    }])
  const result = await w.say()
  assert.equal(result.blocker.class, 'planner_review_required')
  planId = w.plan().plan_id
  const stepId = w.plan().steps[0].step_id
  const record = w.memory.pauseRecord(KEY)
  assert.equal(record.pause_class, 'model_recoverable')
  const chat = []
  const session = Object.create(Session.prototype)
  Object.assign(session, { agent: w.agent, npcId: 'sgluna', npcName: 'SGLuna', stopping: false, autoResume: null, modelResume: null,
    lastPauseDecision: '', lastStatus: { actor_id: 18, epoch: 3 }, liveStatus: { actor_id: 18, epoch: 3 }, log: () => {},
    printChat: async message => { chat.push(message) }, queueEvent: () => Promise.resolve(), eventQueue: Promise.resolve(),
    rawStatus: async () => ({ ...session.liveStatus }), syncTaskBoardUi: async () => {}, ensureAuthorization: async () => ({}),
    rcon: { command: async () => '' } })
  t.after(() => { if (session.modelResume?.timer) clearTimeout(session.modelResume.timer) })
  assert.equal(await session.considerPauseForAutoResume(), true)
  assert.match(chat.at(-1), /Resuming automatically in 15 s with a fresh context \(attempt 1\/2 for this step, 1\/6 for this goal\)/)
  clearTimeout(session.modelResume.timer)
  await session.runModelRecoverableResume(session.modelResume.correlation, 1)
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor', 'executor'])
  assert.equal(w.game.mutations.length, 1, 'the resumed executor acted without a human')
  assert.notEqual(w.memory.currentPlan(KEY).status, 'paused')
  assert.equal(w.plan().plan_id, planId, 'no plan was created or replaced')
  assert.equal(w.plan().steps[0].step_id, stepId)
  assert.equal(w.memory.autoResumeAllowance(KEY).goal_attempts, 1, 'the resume is counted against the goal cap')
  assert.equal(w.events.filter(row => row.event === 'planner.review_round').length, 1, 'the step keeps its one planner round')
})

// Run AC (2026-10-19, b1da8392): the executor's local_recovery_exhausted review ended the request in a guard pause and
// zero provider calls followed. The rationale below is the run's; the replies are scripted.
const RUN_AC_RATIONALE = 'The committed direct-feed approach requires live iron-ore location, drill coverage and output geometry. Current evidence provides none of those facts.'

test('Run AD: research-only post-batch coverage permits drill and output-covering furnace facts and same-step placements within one-read decisions', async () => {
  const game = new FakeFactorio({ inventory: { 'burner-mining-drill': 1, 'stone-furnace': 1, coal: 7, 'iron-plate': 8 } })
  game.status.connected_players = 0
  const native = game.command.bind(game)
  const placed = []
  const candidateReads = []
  const resource = { x: -47.5, y: -12.5 }
  const output = { x: -45.5, y: -12.5 }
  game.nearby = { source: 'live_factorio_nearby_entities', matched_count: 1,
    entities: [{ name: 'iron-ore', type: 'resource', position: resource, amount: 44 }] }
  game.command = async command => {
    if (command.includes("remote.call('autorio_preflight','operation','place_candidate'")) return '{"ok":true}'
    if (command.includes('"get_placement_candidates"')) {
      candidateReads.push(command)
      const drill = command.includes("entity_name='burner-mining-drill'")
      if (drill) assert.ok(command.includes("target_resource='iron-ore'"))
      else { assert.equal(placed[0], 'burner-mining-drill'); assert.ok(command.includes('covers_position={x=-45.5,y=-12.5}')) }
      return JSON.stringify({ ok: true, entity_name: drill ? 'burner-mining-drill' : 'stone-furnace',
        candidate_set_id: drill ? 'placement-11' : 'placement-12', legal_candidate_count: 1, returned_candidate_count: 1,
        candidates: [{ id: 'candidate-1', position: drill ? resource : output, direction: 4,
          ...(drill ? { resource_coverage: { resource_name: 'iron-ore', entity_count: 1, total_amount: 44 }, item_output_position: output } : { covers_position: output }) }] })
    }
    if (command.includes('"autorio_research","status"')) return '{"current":null,"queue":[]}'
    return native(command)
  }
  game.onMutation = command => {
    if (!command.includes("'place_candidate'")) return
    const name = command.includes("'placement-11'") ? 'burner-mining-drill' : 'stone-furnace'
    assert.equal(game.inventory[name], 1); game.inventory[name]--; placed.push(name)
    game.lastTaskTypes = ['placing']
  }
  const typed = (ctx, tool, args, transport = 'submit') => {
    assert.equal(ctx.context.allowTools, true)
    const stepId = ctx.agent.targetedObservationIdentity().data.stepId
    const intent = { stepId, operations: [], observationRequest: { stepId, tool, args, rationale: 'Need live resource coverage and direct-output placement facts.' } }
    return transport === 'submit' ? submit(intent) : intent
  }
  const lastFact = messages => JSON.parse(messages.findLast(row => row.role === 'tool').content)
  const place = ctx => {
    const fact = lastFact(ctx.messages)
    assert.equal(ctx.context.allowTools, false, 'the ordinary one-read budget still closes after its fresh fact')
    assert.equal(ctx.agent.observationBudgetRemaining, 0)
    assert.equal(fact.candidates.length, 1)
    return { stepId: ctx.agent.targetedObservationIdentity().data.stepId, operations: [{ name: 'place_candidate',
      args: { candidate_set_id: fact.candidate_set_id, candidate_id: fact.candidates[0].id } }] }
  }
  const w = world([
    draft({ plan: ['Produce fifty iron plates with the held direct-fed miner and furnace'],
      goal: { scope: 'finite', summary: 'Produce fifty iron plates', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 50 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-plate', 50) }],
      executionGuidance: [{ ...brief(), materialSupply: { mode: 'direct_feed', resource: 'iron-ore' } }] }),
    ctx => typed(ctx, 'getNearbyEntities', { name: 'iron-ore', radius: 32, limit: 1 }, 'json'),
    ctx => {
      assert.deepEqual(lastFact(ctx.messages).entities[0].position, resource)
      return { stepId: ctx.agent.targetedObservationIdentity().data.stepId, operations: [{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 32 } }] }
    },
    ctx => typed(ctx, 'getPlacementCandidates', { entity_name: 'burner-mining-drill', target_resource: 'iron-ore', center: resource, radius: 4, limit: 1 }),
    ctx => { assert.deepEqual(lastFact(ctx.messages).candidates[0].item_output_position, output); return place(ctx) },
    ctx => typed(ctx, 'getPlacementCandidates', { entity_name: 'stone-furnace', center: output, covers_position: output, radius: 4, limit: 1 }, 'json'),
    place,
    ctx => ({ stepId: ctx.agent.targetedObservationIdentity().data.stepId, operations: [{ name: 'wait', args: { ticks: 60 } }] }),
  ], { game, objective: 'Produce fifty iron plates using the held direct-fed miner and furnace.' })
  w.agent.routePostStepDecision = async () => ({ route: 'targeted_observation', decision_called: true,
    steering: { observation_budget: 1, observation_relevance: { source: 'typed_relevance', threshold: 0.5,
      selected_families: ['research_state'], budget: 1 } } })
  await w.say()
  const before = structuredClone(w.plan())
  assert.equal(w.calls.length, 3, JSON.stringify(w.events.slice(-6)))
  await w.agent.completed()
  assert.equal(w.calls.length, 5, JSON.stringify(w.events.slice(-8)))
  assert.equal(game.mutations.length, 2, JSON.stringify(w.events.slice(-10)))
  await w.agent.completed(); await w.agent.completed()
  assert.deepEqual(placed, ['burner-mining-drill', 'stone-furnace'], JSON.stringify(game.mutations))
  assert.equal(candidateReads.length, 2)
  assert.equal(game.mutations.length, 4, 'walk, drill placement, furnace placement and subsequent work were admitted')
  assert.equal(w.calls.length, 8)
  assert.deepEqual(w.plan().steps, before.steps, 'observations cannot rewrite or complete the committed step')
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(w.memory.targetedObservationLedger?.size ?? 0, 0)
  assert.equal(w.agent.closedRoundObservationUsed, false)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
  const opened = w.events.filter(row => row.event === 'observation.phase_kept_open')
  assert.equal(opened.length, 3)
  assert.ok(opened.every(row => row.data.request_id && row.data.step_id === before.steps[0].step_id
    && row.data.reason_code === 'direct_feed_requires_spatial_facts' && row.data.observation_budget_remaining === 1))
})

test('Run AC: the planner review round returns the unchanged step to a fresh executor with its notes, and execution continues', async () => {
  let before
  const w = world([draft(), ctx => {
    before = structuredClone(ctx.memory.planningState(KEY))
    return review('local_recovery_exhausted', RUN_AC_RATIONALE)(ctx)
  }, draft({ chatMessage: 'Copper ore is 12 tiles east of the actor.', plan: ['A tempting different strategy'] }), ctx => {
    assert.equal(ctx.context.role, 'executor')
    const notes = ctx.messages.find(row => String(row.content).startsWith('[PLANNER_REVIEW_NOTES]'))
    assert.match(notes.content, /Copper ore is 12 tiles east/)
    assert.equal(ctx.messages.some(row => String(row.content).startsWith('[EXECUTOR_REVIEW]')), false, 'the planner conversation stays parked')
    return action(ctx)
  }])
  await w.say()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor'])
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.plan().steps, getActivePlan(before).steps, 'the review round cannot change the committed plan')
  assert.notEqual(w.memory.currentPlan(KEY).status, 'paused')
  assert.equal(w.agent.providerBudgetGeneration, 1)
  assert.equal(w.memory.planningState(KEY).goal.fresh_context_recovery_used, before.goal.fresh_context_recovery_used)
  const returned = w.events.find(row => row.event === 'planner.committed_slice_returned')
  assert.equal(returned.data.reason, 'review_round_returned_same_step')
  assert.equal(w.events.filter(row => row.event === 'plan.replacement_wake').length, 0)
  assert.equal(w.events.find(row => row.event === 'planner.review_round').data.authority, 'advisory_only')
})

// Run AF (2026-10-19, req_mvfhjjj8_1): after a verified first step the executor asked for a review of the second, and the
// planner's contract reply (a plan, no operations) was met with finite-goal continuation pressure, which began an
// executor action-omission repair that the next executor restage resumed with a one-read budget.
const copperThenIron = overrides => draft({ plan: ['Gather ten copper ore', 'Gather ten iron ore'],
  goal: { scope: 'finite', summary: 'Gather copper and iron.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] },
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }, { kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-ore', 10) }],
  executionGuidance: [brief(), { ...brief(), approach: 'Gather iron for the next build.' }], ...overrides })
const activeStepId = memory => { const held = getActivePlan(memory.planningState(KEY)); return held.steps[held.active_step_index].step_id }
const readNearby = (id, name) => ({ content: '', tool_calls: [{ id, type: 'function',
  function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, name, limit: 4 }) } }] })
const afOutgoing = messages => messages.map(row => row.content ?? '').join('\n')

async function runToSecondStepReview(extra = []) {
  const w = world([copperThenIron(), action, ({ memory }) => ({ stepId: activeStepId(memory), operations: [],
    plannerReview: { reason: 'local_recovery_exhausted', rationale: RUN_AC_RATIONALE } }),
  copperThenIron({ chatMessage: 'Iron ore candidates must be re-read near the actor.', currentStep: 1 }), ...extra])
  return w
}

test('Run AF: a planner review-round reply is never met with executor continuation pressure and hands back a normal executor', async () => {
  const w = await runToSecondStepReview([ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.allowTools, true, 'ordinary read budget, not the action-omission single-read round')
    assert.equal(ctx.memory.currentPlan(KEY).admission_status === 'action_omission_repair', false)
    assert.equal(ctx.agent.actionOmissionRepairActive, false)
    assert.match(afOutgoing(ctx.messages), /\[PLANNER_REVIEW_NOTES\].*Iron ore candidates/)
    assert.doesNotMatch(afOutgoing(ctx.messages), /act-or-block/i)
    return readNearby('af-read-1', 'iron-ore')
  }, ctx => {
    assert.equal(ctx.context.allowTools, true, 'a second read is still open after the first')
    return readNearby('af-read-2', 'copper-ore')
  }, ctx => {
    assert.equal(ctx.context.allowTools, true)
    return { stepId: activeStepId(ctx.memory), operations: [gather('iron-ore', 10)] }
  }])
  await w.say()
  w.game.inventory['copper-ore'] = 10
  await w.agent.completed()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'executor', 'planner', 'executor', 'executor', 'executor'], JSON.stringify(w.events.slice(-8)))
  assert.equal(w.events.filter(row => row.event === 'recovery.action_omission_started').length, 0)
  assert.equal(w.events.filter(row => row.event === 'recovery.classified' && row.data.reason_code === 'finite_goal_continuation_pressure').length, 0)
  assert.equal(w.events.filter(row => row.event === 'planner.committed_slice_returned').length, 1)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 1)
  assert.notEqual(w.memory.currentPlan(KEY).admission_status, 'action_omission_repair')
  assert.equal(w.game.mutations.length, 2, 'the executor read twice and then acted on the same step')
  assert.equal(w.memory.currentPlan(KEY).status !== 'paused', true)
})

test('Run AF: the planner role cannot begin an executor action-omission repair on any path', async () => {
  let probed = false
  const w = world([copperThenIron(), action, ({ memory }) => ({ stepId: activeStepId(memory), operations: [],
    plannerReview: { reason: 'local_recovery_exhausted', rationale: RUN_AC_RATIONALE } }),
  async ctx => {
    assert.equal(ctx.context.role, 'planner')
    const held = ctx.memory.currentPlan(KEY)
    assert.equal(held.status, 'active')
    assert.equal(held.last_mutation_verified, true, 'every other finite-pressure precondition holds')
    assert.ok(held.task_board.evidence.some(item => item?.kind === 'deterministic_verification'), 'the verification evidence precondition holds')
    const noOperations = { chatMessage: '', plan: held.plan, currentStep: held.current_step, operations: [] }
    assert.equal(ctx.agent.planUpdateReason, 'completion')
    assert.equal(ctx.agent.finiteNoOperationPressure(noOperations), '')
    assert.equal(ctx.agent.pendingFiniteNoOperationPlan, null)
    for (const reason of ['finite_goal_continuation_pressure', 'no_operation_for_remaining_plan', 'observation_decision_pressure_complete']) {
      assert.equal(await ctx.agent.beginActionOmissionRepair(noOperations, reason), undefined, reason)
    }
    assert.equal(ctx.agent.actionOmissionRepairActive, false)
    assert.notEqual(ctx.memory.currentPlan(KEY).admission_status, 'action_omission_repair')
    probed = true
    return copperThenIron({ chatMessage: 'The step stands.', currentStep: 1 })
  }, ctx => ({ stepId: activeStepId(ctx.memory), operations: [gather('iron-ore', 10)] })])
  await w.say()
  w.game.inventory['copper-ore'] = 10
  await w.agent.completed()
  assert.equal(probed, true)
  assert.equal(w.events.filter(row => row.event === 'recovery.action_omission_started').length, 0)
  assert.equal(w.game.mutations.length, 2)
})

test('Run AF: an executor no-operation reply after a verified step still gets continuation pressure and repair', async () => {
  const w = world([copperThenIron(), action, ctx => ({ stepId: activeStepId(ctx.memory), plan: ['Gather ten copper ore', 'Gather ten iron ore'], currentStep: 1, operations: [] }),
    ctx => {
      assert.equal(ctx.context.role, 'executor')
      assert.match(afOutgoing(ctx.messages), /\[HARNESS\]/)
      return { stepId: activeStepId(ctx.memory), operations: [gather('iron-ore', 10)] }
    }])
  await w.say()
  w.game.inventory['copper-ore'] = 10
  await w.agent.completed()
  const pressure = w.events.filter(row => row.event === 'recovery.classified' && row.data.reason_code === 'finite_goal_continuation_pressure')
  assert.equal(pressure.length, 1, JSON.stringify(w.events.slice(-8)))
  const started = w.events.filter(row => row.event === 'recovery.action_omission_started')
  assert.equal(started.length, 1)
  assert.equal(started[0].data.reason_code, 'finite_goal_continuation_pressure')
  assert.equal(w.game.mutations.length, 2)
})

test('Run AF: a planner reply that is not a committable draft ends visibly as a model_recoverable failure, not a quiet no-operation finish', async () => {
  // A valid draft while the actor is not idle is not admitted as a planner-only draft (initialPlannerAdmission needs an idle
  // actor), so it reaches the remaining-canonical-work branch that used to begin an executor repair on the planner.
  const w = world([({ game }) => { game.status.idle = false; return copperThenIron() }])
  await assert.rejects(w.say(), error => {
    assert.match(error.message, /^provider_action_omission_repair_failed: planner reply left remaining canonical work/)
    assert.deepEqual(classifyRequestFailure(error).pause_class, 'model_recoverable', 'the supervisor pauses this class and auto-resumes it')
    return true
  })
  assert.equal(w.calls.length, 1, 'no second planner call carrying an executor repair prompt')
  assert.equal(w.events.filter(row => row.event === 'recovery.action_omission_started').length, 0)
  assert.equal(w.events.filter(row => row.event === 'request.completed').length, 0, 'it did not end as a quiet no-operation finish')
  assert.notEqual(w.memory.currentPlan(KEY)?.admission_status, 'action_omission_repair')
})

test('Run AF: observation-decision pressure on a planner forces the no-tools decision without executor repair flags, so the next executor can observe', async () => {
  const w = world([async ctx => {
    assert.equal(ctx.context.role, 'planner')
    const spent = new AgentLoopError('The targeted observation budget allowed by decision pressure is complete. Stop observing. Reuse the live evidence already collected and return the next executable action, or a truthful blocker.')
    await assert.rejects(ctx.agent.recoverPlan(ctx.agent.generation, spent, 1), /forced decision test stop/)
    assert.equal(ctx.agent.actionOmissionRepairActive, false)
    assert.equal(ctx.agent.actionOmissionObservationUsed, false)
    assert.equal(ctx.agent.actionOmissionForceNoTools, false)
    return copperThenIron()
  }, ctx => {
    assert.equal(ctx.context.role, 'planner')
    assert.equal(ctx.context.allowTools, false, 'the recovery decision is the no-tools round')
    throw new Error('forced decision test stop')
  }, ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.allowTools, true)
    assert.equal(ctx.agent.actionOmissionRepairActive, false)
    assert.equal(ctx.agent.actionOmissionObservationUsed, false)
    return readNearby('b-read-1', 'copper-ore')
  }, ctx => {
    assert.equal(ctx.messages.findLast(row => row.role === 'tool') !== undefined, true, 'the first targeted observation ran')
    return action(ctx)
  }])
  await w.say()
  assert.equal(w.events.filter(row => row.event === 'recovery.action_omission_started').length, 0)
  assert.equal(w.events.some(row => row.event === 'recovery.classified' && row.data.reason_code === 'action_omission_observation_budget'), false)
  assert.equal(w.game.mutations.length, 1)
})

test('Run AC: a review from a read phase the harness closed reopens reads once instead of pausing', async () => {
  const closedByCoverage = ({ agent }) => {
    agent.observationDecisionPressure = true
    agent.observationDecisionForced = true
    agent.observationPhaseClosedBy = POST_BATCH_COVERAGE_REASON
    agent.postBatchFacts = { reads: [], covered: ['research_state'] }
  }
  const w = world([draft(), ctx => {
    closedByCoverage(ctx)
    return review('local_recovery_exhausted', RUN_AC_RATIONALE)(ctx)
  }, ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.allowTools, true, 'the same decision continues with read tools open')
    const fact = ctx.messages.find(row => row.role === 'user' && String(row.content).includes('Review not sent'))?.content ?? ''
    assert.match(fact, /Review not sent/)
    assert.match(fact, /research_state/)
    // Same step, phase closed again: the reopen is spent, so this review goes to the planner round.
    closedByCoverage(ctx)
    return review('local_recovery_exhausted', RUN_AC_RATIONALE)(ctx)
  }, ctx => {
    assert.equal(ctx.context.role, 'planner')
    return plannerRound
  }, action])
  await w.say()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'executor', 'planner', 'executor'])
  assert.equal(w.game.mutations.length, 1)
  const reopened = w.events.filter(row => row.event === 'observation.phase_reopened_for_review')
  assert.equal(reopened.length, 1)
  assert.deepEqual(reopened[0].data.covered_families, ['research_state'])
  assert.equal(reopened[0].data.review_reason, 'local_recovery_exhausted')
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 1)
})

test('Run AE: a review that echoes the committed checkpoint reaches the planner round without a refused round', async () => {
  const echoed = { mode: 'all', requirements: [{ id: 'requirement_1', kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] }
  const w = world([draft(), ctx => ({ ...review('local_recovery_exhausted', RUN_AC_RATIONALE)(ctx), checkpoint: echoed }), ctx => {
    assert.equal(ctx.context.role, 'planner')
    return plannerRound
  }, action])
  await w.say()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor'])
  assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
  const ignored = w.events.find(row => row.event === 'executor.review_checkpoint_ignored')
  assert.equal(ignored.data.reason, 'committed_completion_contract_is_immutable')
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 1)
  assert.equal(w.game.mutations.length, 1)
})

test('Run AE: a refused review names what made it invalid', async () => {
  const w = world([draft(), () => ({ operations: [], plannerReview: { reason: 'scope_change', rationale: 'A strategic decision is needed.' } }),
    review('scope_change'), plannerRound, action])
  await w.say()
  const refused = w.events.find(row => row.event === 'recovery.classified' && row.data.reason_code === 'invalid_planner_review')
  assert.match(refused.data.reason, /this reply has no stepId$/)
  assert.equal(w.game.mutations.length, 1)
})

test('the review round allowance is durable, runtime-only and capped per goal', async () => {
  const w = world([draft(), review('scope_change'), plannerRound, review('scope_change')])
  await w.say()
  const stepId = w.plan().steps[0].step_id
  assert.deepEqual(w.memory.planningState(KEY).goal.review_continuation_steps, [stepId])
  assert.equal(w.memory.claimReviewContinuation(KEY, stepId), false, 'the live round already spent it')
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.equal(restored.claimReviewContinuation(KEY, stepId), false, 'a restart cannot mint a second round')
  const state = restored.planningState(KEY)
  const event = { type: PLANNING_EVENT.REVIEW_CONTINUATION_CLAIMED, goal_id: state.goal.goal_id, step_id: 'other-step' }
  assert.equal(applyPlanningEvent(state, { ...event, source: 'main_planner' }), state, 'a model cannot claim a round')
  for (let index = 1; index < MAX_REVIEW_CONTINUATIONS_PER_GOAL; index++) assert.equal(restored.claimReviewContinuation(KEY, `step-${index}`), true)
  assert.equal(restored.claimReviewContinuation(KEY, 'one-step-too-many'), false)
  assert.equal(restored.planningState(KEY).goal.review_continuation_steps.length, MAX_REVIEW_CONTINUATIONS_PER_GOAL)
})

test('a stale executor review cannot pause or change a current step', async () => {
  const w = world([draft(), () => ({ stepId: 'obsolete-step', operations: [], plannerReview: { reason: 'scope_change', rationale: 'Wrong step.' } }), action])
  await w.say()
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
  assert.ok(w.events.some(row => row.event === 'executor.stale_step_rejected'))
})

test('a planner consulted during a healthy committed slice returns the immutable brief to execution', async () => {
  const w = world([draft(), action, draft({ plan: ['A tempting different strategy'], executionGuidance: [brief()] }), action])
  await w.say()
  const original = structuredClone(w.plan().steps)
  const returned = await w.agent.returnControlToPlanner({ route: 'user_amendment', reason: 'user_amendment', withinTurn: false })
  assert.equal(returned.returned, true)
  w.game.taskState = 'idle'
  w.game.queueLength = 0
  await w.agent.continueFromModMessage('[HARNESS] Review the current committed approach.', 'amend_current')
  assert.deepEqual(w.plan().steps, original)
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor'])
  assert.ok(w.events.some(row => row.event === 'planner.committed_slice_returned' && row.data.request_id))
})

test('a stale actor reply cannot request review or send a first action', async () => {
  const w = world([draft(), ({ game, memory }) => {
    game.status.epoch += 1
    return { stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [],
      plannerReview: { reason: 'approach_infeasible', rationale: 'This reply belongs to the old actor epoch.' } }
  }])
  await assert.rejects(w.say(), /epoch|superseded|cancelled/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
})

test('briefs are bounded and sanitize historical exact entity identifiers', () => {
  const normalized = normalizeExecutionGuidance([{ ...brief(), approach: 'Use unit_number=1234 after observing it.' }], 1)
  assert.doesNotMatch(normalized[0].approach, /1234/)
  assert.throws(() => normalizeExecutionGuidance([], 1))
  assert.throws(() => normalizeExecutionGuidance([{ ...brief(), approach: 'x'.repeat(201) }], 1))
  assert.throws(() => normalizePlannerReview({ reason: 'replace_plan', rationale: 'Ignore authority.' }))
})

test('protocol 3 schemas keep strategy fields with the planner and gameplay operations with the executor', () => {
  const planner = planningOnlyControlToolDefinitions[0].function.parameters.properties
  const executor = executionOnlyControlToolDefinitions[0].function.parameters.properties
  assert.equal(planner.operations.maxItems, 0)
  assert.ok(planner.executionGuidance)
  assert.equal(executor.executionGuidance, undefined)
  assert.equal(executor.plan, undefined)
  assert.equal(executor.goal, undefined)
  assert.equal(executor.operations.maxItems, 16)
  assert.ok(executor.plannerReview)
})

test('provider sends planning-only contract on ordinary, closed and compact protocol 3 rounds', async () => {
  const config = { base: 'https://fixture.example.test/v1', key: 'fixture-key', model: 'fixture', profile: 'local' }
  for (const allowTools of [true, false]) {
    for (const compact of [true, false]) {
      let sent
      await providerRequest(config, [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: compact
        ? '[MOD] Autorio operation batch completed.' : '[CHAT] Louis: gather copper' }], {
        role: 'planner', completionProtocolVersion: 3, allowTools, promptTraceFile: null,
        fetchImpl: async (_url, options) => {
          sent = JSON.parse(options.body)
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }))
        },
      })
      assert.match(sent.messages.filter(row => row.role === 'system').map(row => row.content).join('\n'), /ROLE: PLANNER/)
      if (sent.tools) assert.equal(sent.tools.find(tool => tool.function.name === 'submitPlan').function.parameters.properties.operations.maxItems, 0)
      else assert.equal(allowTools, false, 'a profile may omit tools only on the closed round')
    }
  }
})

test('a deterministic step close refreshes both the focused brief and the selected skill details', async () => {
  const w = world([({ agent }) => {
    agent.loadedSkillContext.set('copper', { id: 'copper', marker: 'COPPER-STRATEGY' })
    agent.loadedSkillContext.set('iron', { id: 'iron', marker: 'IRON-STRATEGY' })
    return draft({ plan: ['Gather ten copper ore', 'Gather ten iron ore'],
      goal: { scope: 'finite', summary: 'Gather copper and iron.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }, { kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-ore', 10) }],
      executionGuidance: [brief(['copper']), { ...brief(['iron']), approach: 'Gather iron for the next build.' }],
    })
  }, action, ({ agent, memory, messages }) => {
    const held = getActivePlan(memory.planningState(KEY))
    assert.equal(held.active_step_index, 1)
    assert.equal(agent.controlDecisionState(true).executionGuidance.approach, 'Gather iron for the next build.')
    const skills = messages.find(row => String(row.content).startsWith('[SKILL_CONTEXT]')).content
    assert.match(skills, /IRON-STRATEGY/)
    assert.doesNotMatch(skills, /COPPER-STRATEGY/)
    return { stepId: held.steps[1].step_id, operations: [gather('iron-ore', 10)] }
  }])
  await w.say()
  w.game.inventory['copper-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 3)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 1)
})

const supplyBrief = mode => ({ ...brief(['direct-miner-smelting']),
  approach: 'Use the held miner and furnace for this resource; validate their direct output.',
  materialSupply: mode ? { mode, resource: 'copper-ore' } : null })

function supplyDraft(agent, mode) {
  agent.loadedSkillContext.set('direct-miner-smelting', { id: 'direct-miner-smelting', summary: 'Optional direct-feed time savings.' })
  return draft({ executionGuidance: [supplyBrief(mode)] })
}

test('selected direct-smelting knowledge requires a conscious planner method choice before commit', async () => {
  const w = world([({ agent }) => {
    const plan = supplyDraft(agent, 'direct_feed')
    delete plan.executionGuidance[0].materialSupply
    return plan
  }, ({ agent, game, messages }) => {
    assert.equal(game.mutations.length, 0)
    assert.ok(messages.some(row => row.role === 'user' && row.content.includes('Choose materialSupply explicitly')))
    return supplyDraft(agent, 'manual_bootstrap')
  }, action])
  await w.say()
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'manual_bootstrap')
  assert.ok(w.events.some(row => row.event === 'role.contract_refused' && row.data.reason === 'invalid_execution_guidance'))
})

test('direct-feed drift refuses the whole batch before startup fuel or manual ore can run', async () => {
  let before
  const drift = ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [gather('coal', 2), gather('copper-ore', 10)] })
  const w = world([({ agent }) => supplyDraft(agent, 'direct_feed'), ctx => {
    before = structuredClone(ctx.memory.planningState(KEY))
    return drift(ctx)
  }, plannerRound, drift])
  const result = await w.say()
  assert.equal(result.blocker.class, 'planner_review_required')
  assert.equal(w.game.mutations.length, 0)
  assert.deepEqual(w.plan().steps, getActivePlan(before).steps)
  assert.equal(w.agent.providerBudgetGeneration, 1)
  assert.equal(w.memory.planningState(KEY).goal.fresh_context_recovery_used, before.goal.fresh_context_recovery_used)
  const refused = w.events.find(row => row.event === 'executor.strategy_refused')
  assert.equal(refused.data.reason, 'manual_supply_would_replace_selected_direct_feed')
  assert.ok(refused.data.request_id)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 2)
  assert.equal(w.events.filter(row => row.event === 'observation.phase_reopened_for_review').length, 0)
  assert.equal(w.calls.length, 4, 'one bounded planner round, no new model allowance or planner loop')
})

for (const mode of ['manual_bootstrap', null]) {
  test(`selected skill with ${mode ?? 'non-production'} choice remains optional knowledge`, async () => {
    const w = world([({ agent }) => supplyDraft(agent, mode), action])
    await w.say()
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.events.filter(row => row.event === 'executor.strategy_refused').length, 0)
  })
}

test('direct-feed step can acquire startup fuel without a mandatory extra cell', async () => {
  const w = world([({ agent }) => supplyDraft(agent, 'direct_feed'), ({ memory }) => ({
    stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [gather('coal', 2)],
  })])
  await w.say()
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'executor.strategy_refused').length, 0)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual(getActivePlan(restored.planningState(KEY)).steps[0].execution_guidance.materialSupply, { mode: 'direct_feed', resource: 'copper-ore' })
})

test('direct-feed boundary covers resource and transfer aliases but preserves fuel and finished output', () => {
  const blocked = [gather('copper-ore', 1),
    { name: 'mine_resource_at', args: { resource_name: 'copper-ore' } },
    { name: 'harvest_product', args: { product_name: 'copper-ore' } },
    { name: 'mine_entity', args: { entity_name: 'copper-ore' } },
    { name: 'mine_entity_exact', args: { unit_number: 7 } },
    { name: 'supply_entity', args: { items: [{ item_name: 'copper-ore', count: 1 }] } },
    ...['move_items', 'move_items_exact'].map(name => ({ name, args: { item_name: 'copper-ore', to_entity: true } })),
    { name: 'move_items_with_player', args: { item_name: 'copper-ore', to_player: false } }]
  const allowed = [gather('coal', 1), gather('stone', 5),
    { name: 'supply_entity', args: { items: [{ item_name: 'coal', count: 2 }] } },
    { name: 'move_items_exact', args: { item_name: 'copper-plate', to_entity: false } },
    { name: 'mine_entity_exact', args: { unit_number: 8 } }]
  assert.deepEqual(manualSupplyDrift(supplyBrief('direct_feed'), [...blocked, ...allowed], id => ({ name: id === 7 ? 'copper-ore' : 'stone-furnace' })), blocked)
  assert.deepEqual(manualSupplyDrift(brief(), blocked), [], 'legacy persisted briefs do not acquire new constraints')
  assert.throws(() => normalizeExecutionGuidance([{ ...brief(), materialSupply: { mode: 'mandatory_cells', resource: 'copper-ore' } }], 1))
})

test('recorded Run AB legacy BLOCKED becomes one advisory review instead of seven failed requests', async () => {
  let before
  const legacy = ({ memory }) => ({ ...runAB.legacy_reply, stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id })
  const w = world([draft(), ctx => {
    before = structuredClone(ctx.memory.planningState(KEY))
    return legacy(ctx)
  }, plannerRound, legacy])
  let freshAttempts = 0
  w.agent.tryFreshContextActionRecovery = async () => { freshAttempts++; return { attempted: false } }
  const result = await w.say()
  assert.equal(result.blocker.class, 'planner_review_required')
  assert.equal(freshAttempts, 0)
  assert.equal(w.calls.length, 4, 'one bounded planner round between the two reviews')
  assert.equal(w.game.mutations.length, 0)
  assert.deepEqual(w.plan().steps, getActivePlan(before).steps)
  assert.notEqual(w.plan().status, 'BLOCKED')
  assert.equal(w.memory.planningState(KEY).goal.fresh_context_recovery_used, before.goal.fresh_context_recovery_used)
  assert.equal(w.agent.providerBudgetGeneration, 1)
  const routed = w.events.find(row => row.event === 'executor.legacy_blocker_review')
  assert.ok(routed.data.request_id)
  assert.equal(routed.data.world_blocker_proven, false)
  assert.ok(w.events.some(row => row.event === 'outcome.rejected'))
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 2)
  assert.equal(w.events.filter(row => row.event === 'plan.replacement_wake').length, 0)
})

test('a supersession while review returns cannot complete or overwrite the new request', async () => {
  const w = world([draft(), ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id,
    operations: [], plannerReview: { reason: 'scope_change', rationale: 'Needs strategic review.' } })])
  const original = w.agent.returnControlToPlannerWithRetry.bind(w.agent)
  w.agent.returnControlToPlannerWithRetry = async options => {
    const result = await original(options)
    w.agent.generation++
    return result
  }
  await assert.rejects(w.say(), /superseded|stale|cancelled/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.filter(row => row.event === 'request.completed' && row.data.outcome === 'planner_review_required').length, 0)
})

test('ordinary, compact, closed and repair protocol 3 wires advertise review without legacy BLOCKED directions', async () => {
  const actual = world([]).agent.rolePrefixMessages('executor')[0]
  assert.doesNotMatch(actual.content, /start chatMessage with "BLOCKED|say so with an explicit BLOCKED/)
  assert.match(actual.content, /plannerReview/)
  assert.match(world([], { completionProtocolVersion: 2 }).agent.rolePrefixMessages('executor')[0].content, /start chatMessage with "BLOCKED/)
  for (const allowTools of [true, false]) for (const compact of [true, false]) {
    let sent
    await providerRequest({ base: 'https://fixture.example.test/v1', key: 'fixture', model: 'gpt-6-luna', profile: 'cli-proxy' }, [
      actual,
      { role: 'user', content: '[HARNESS] Otherwise keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or truthful blocker.' },
      { role: 'user', content: compact ? '[MOD] Autorio operation batch completed.' : '[CHAT] Louis: continue' },
    ], { role: 'executor', completionProtocolVersion: 3, allowTools, promptTraceFile: null,
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body)
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }))
      } })
    const instructions = sent.messages.map(row => row.content).join('\n')
    assert.match(instructions, /plannerReview/)
    assert.match(instructions, /direct_feed/)
    assert.doesNotMatch(instructions, /start chatMessage with "BLOCKED|say so with an explicit BLOCKED/)
    assert.ok(sent.tools.find(tool => tool.function.name === 'submitPlan').function.parameters.properties.plannerReview)
    if (!allowTools) assert.match(instructions, /timeReview or plannerReview/)
  }
})

test('actual act-or-review repair and the existing single fresh recovery both retain review guidance', async () => {
  const empty = ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [] })
  const w = world([draft(), empty, ({ messages, memory }) => {
    assert.ok(messages.some(row => row.role === 'user' && /Finite canonical work remains/.test(row.content) && /plannerReview/.test(row.content)))
    return empty({ memory })
  }, ({ messages, memory }) => {
    const fresh = messages.find(row => row.role === 'user' && row.content.includes('one fresh-context recovery'))
    assert.ok(fresh)
    assert.match(fresh.content, /plannerReview/)
    assert.doesNotMatch(fresh.content, /state BLOCKED:/)
    return { ...empty({ memory }), plannerReview: { reason: 'local_recovery_exhausted', rationale: 'No grounded next action in the existing recovery budget.' } }
  }, plannerRound, review('local_recovery_exhausted', 'Still no grounded next action.')])
  const result = await w.say()
  assert.equal(result.blocker.class, 'planner_review_required')
  assert.equal(w.calls.length, 6)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.filter(row => row.event === 'recovery.fresh_context_started').length, 1)
})

test('protocol 3 accepted deterministic blockers and uncertain-effect holds cannot become advisory review', async () => {
  for (const uncertain of [false, true]) {
    const w = world([draft(), action])
    await w.say()
    w.game.taskState = 'idle'; w.game.queueLength = 0; w.agent.batchInFlight = false
    for (const record of w.memory.pendingOperations(KEY)) w.memory.clearPendingOperation(KEY, { operationKey: record.operation_key })
    let pending
    if (uncertain) {
      pending = buildPendingOperation({ requestId: 'uncertain', operationKey: 'uncertain/batch',
        goalId: w.memory.planningState(KEY).goal.goal_id, planId: w.plan().plan_id, stepId: w.plan().steps[0].step_id,
        actor: w.game.status, operations: [gather('copper-ore', 10)] })
      assert.ok(w.memory.recordPendingOperation(KEY, { ...pending, effect: EFFECT.PARTIAL_UNKNOWN }))
      w.agent.duplicateEffectHold = { operation_key: pending.operation_key }
    }
    w.agent.traceRequest = { id: 'blocked-current', usage: {} }
    const before = await w.agent.assertCurrent()
    const result = await w.agent.finishNoOperationBlock({ ...runAB.legacy_reply, plan: ['Gather ten copper ore'], currentStep: 0 }, before,
      'native_structural_blocker', 'Native evidence requires a hold.', uncertain ? 'provider_blocker' : 'deterministic_preflight')
    assert.equal(result.goalStatus, 'blocked')
    assert.equal(w.plan().status, 'BLOCKED')
    assert.equal(w.events.filter(row => row.event === 'executor.legacy_blocker_review').length, 0)
    assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
    if (uncertain) assert.equal(w.memory.pendingOperation(KEY).effect, EFFECT.PARTIAL_UNKNOWN)
  }
})

test('a stale actor legacy blocker cannot pause or review the replacement actor', async () => {
  const w = world([draft(), ({ game, memory }) => {
    game.status.epoch++
    return { ...runAB.legacy_reply, stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id }
  }])
  await assert.rejects(w.say(), /epoch|superseded|cancelled/i)
  assert.equal(w.events.filter(row => row.event === 'executor.legacy_blocker_review').length, 0)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
})
