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
import { answerBootstrapRead } from './direct-feed-bootstrap-fixtures.mjs'
import { directFeedBootstrapRefusal } from './direct-feed-bootstrap-runtime.mjs'

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
    const carrying = ctx.messages.filter(row => String(row.content).includes('Copper ore is 12 tiles east'))
    assert.equal(carrying.length, 1, 'the executor sees the planner notes once')
    assert.match(carrying[0].content, /planner_review_notes/, 'notes that fit the packet ride in its record, not a second message')
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

test('review notes longer than the old 500-char record reach the executor whole, once, in the packet record', async () => {
  // Run AJ (2026-10-21): the 500-char record cut the notes, and the whole copy rode a message the next continuation dropped.
  const long = `Copper ore is 12 tiles east of the actor. ${'Keep the furnace fed before reading again. '.repeat(14)}`.trim()
  assert.ok(long.length > 500)
  const w = world([draft(), review('local_recovery_exhausted', RUN_AC_RATIONALE), draft({ chatMessage: long, plan: ['A tempting different strategy'] }), ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.messages.filter(row => String(row.content).startsWith('[PLANNER_REVIEW_NOTES]')).length, 0, 'no second copy as a message')
    const record = ctx.messages.flatMap(row => String(row.content).split('\n')).filter(line => line.startsWith('planner_review_notes'))
    assert.equal(record.length, 1)
    assert.ok(record[0].endsWith(long), 'the end of the notes is not lost')
    return action(ctx)
  }])
  await w.say()
  assert.equal(w.game.mutations.length, 1)
})

test('Run AF: a planner review-round reply is never met with executor continuation pressure and hands back a normal executor', async () => {
  const w = await runToSecondStepReview([ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.allowTools, true, 'ordinary read budget, not the action-omission single-read round')
    assert.equal(ctx.memory.currentPlan(KEY).admission_status === 'action_omission_repair', false)
    assert.equal(ctx.agent.actionOmissionRepairActive, false)
    assert.match(afOutgoing(ctx.messages), /planner_review_notes.*Iron ore candidates/)
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

// --- Run BB lane B: the planner's direct_feed cell must be buildable without the resource it forbids by hand --------------------
// Run BB: the committed step preserved the copper drill 27 and furnace 28 and chose direct_feed for iron-ore while 8 iron plates
// were held. A new burner drill costs 9 (3 plates + 3 gears of 2), and the missing plate can only be smelted from iron-ore.
const BB_OUTCOME = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'steam-power' }] }
const bbDraft = (agent, mode, preserve = [27, 28]) => {
  agent.loadedSkillContext.set('direct-miner-smelting', { id: 'direct-miner-smelting', summary: 'Optional direct-feed time savings.' })
  return draft({ plan: ['Produce the iron plates needed to trigger steam power, and verify the technology unlocks.'],
    goal: { scope: 'finite', summary: 'Complete steam power research.', doneWhen: [{ kind: 'research_completed', technology: 'steam-power' }] },
    stepCompletions: [{ kind: 'deterministic', checkpoint: BB_OUTCOME, obligations: { outcome: BB_OUTCOME, preserve } }],
    executionGuidance: [{ ...brief(['direct-miner-smelting']), approach: 'Establish a direct-fed iron miner and furnace, fuel both, and verify the steam-power trigger.',
      materialSupply: { mode, resource: 'iron-ore' } }] })
}
const burnerCell = unit => ({ unit_number: unit, name: unit === 27 ? 'burner-mining-drill' : 'stone-furnace', type: unit === 27 ? 'mining-drill' : 'furnace',
  position: { x: unit === 27 ? 47 : 46, y: unit === 27 ? 16 : 14 }, direction: 0 })
const burnerGeometry = unit => ({ found: true, entity: burnerCell(unit), actor_id: 18, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1,
  fluid_box_count: 0, fluid_storages_truncated: false, ...(unit === 27 ? { item_io: { drop_position: { x: 46.5, y: 14.7 }, drop_target: burnerCell(28) } } : {}) })

function bootstrapWorld(script, { inventory = { 'iron-plate': 8, 'stone-furnace': 1, coal: 12 }, ...read } = {}) {
  const game = new FakeFactorio({ inventory })
  game.knownTechnologies.add('steam-power')
  const native = game.command.bind(game)
  const reads = []
  game.command = async text => {
    const answered = answerBootstrapRead(text, { inventory: game.inventory, ...read })
    if (answered !== undefined) { reads.push(text); return answered }
    if (text.includes('entity_geometry')) return JSON.stringify(burnerGeometry(Number(/entity_geometry["'],\s*(\d+)/.exec(text)?.[1] ?? /unit_number[=: ]+(\d+)/.exec(text)?.[1])))
    return native(text)
  }
  return { ...world(script, { game, objective: 'Complete steam power research.' }), reads }
}
const bootstrapChecks = w => w.events.filter(row => row.event === 'plan.direct_feed_bootstrap_checked').map(row => row.data)
const startFuel = ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [gather('coal', 2)] })

test('Run BB: a direct_feed cell that cannot bootstrap without hand-supplied iron-ore is refused at commit with the shortfall, and the planner corrects it', async () => {
  const w = bootstrapWorld([({ agent }) => bbDraft(agent, 'direct_feed'), ({ agent, game, messages }) => {
    assert.equal(game.mutations.length, 0)
    const refusal = messages.findLast(row => row.role === 'user' && row.content.includes('direct_feed_bootstrap_infeasible'))
    assert.ok(refusal, 'the planner is told why, with a precise code')
    assert.match(refusal.content, /materialSupply direct_feed for iron-ore/)
    assert.match(refusal.content, /burner-mining-drill/)
    assert.match(refusal.content, /iron-plate 8/)
    assert.match(refusal.content, /still needs 1 iron-ore/)
    assert.match(refusal.content, /manual_bootstrap/)
    return bbDraft(agent, 'manual_bootstrap')
  }, startFuel])
  await w.say()
  assert.equal(w.calls.length, 3, 'one correction round, no new model allowance')
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'manual_bootstrap')
  assert.equal(w.game.mutations.length, 1, 'nothing ran before the corrected plan committed')
  const [checked, ...later] = bootstrapChecks(w)
  assert.equal(later.length, 0, 'a manual_bootstrap draft needs no check')
  assert.deepEqual([checked.verdict, checked.step_index, checked.resource, checked.preserved], ['infeasible', 0, 'iron-ore', [27, 28]])
  const refused = w.events.find(row => row.event === 'role.contract_refused')
  assert.equal(refused.data.reason, 'direct_feed_bootstrap_infeasible')
  assert.ok(w.reads.some(text => text.includes('mining_details')) && w.reads.some(text => text.includes('recipe_details')))
})

test('Run BB: a placed machine in obligations.preserve, or one the game no longer shows, does not rescue the bootstrap', async () => {
  const placeCopperCell = ({ memory }) => {
    memory.recordNpcPlacement(KEY, { unit_number: 27, entity_name: 'burner-mining-drill', actor_id: 18, actor_epoch: 3 })
    memory.recordNpcPlacement(KEY, { unit_number: 31, entity_name: 'burner-mining-drill', actor_id: 18, actor_epoch: 3 })
  }
  // 27 is still there but preserved; 31 was placed and has since been mined (the game answers found:false).
  const w = bootstrapWorld([ctx => { placeCopperCell(ctx); return bbDraft(ctx.agent, 'direct_feed') }, ({ agent }) => bbDraft(agent, 'manual_bootstrap'), startFuel],
    { entities: { 27: 'burner-mining-drill' } })
  await w.say()
  assert.equal(bootstrapChecks(w)[0].verdict, 'infeasible')
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'manual_bootstrap')
  const statusReads = w.reads.filter(text => text.includes('get_entity_status'))
  assert.equal(statusReads.length, 1, 'only the unpreserved placement was looked up')
  assert.match(statusReads[0], /,31\)/)
})

for (const [label, options] of [
  ['a held drill', { inventory: { 'burner-mining-drill': 1, 'iron-plate': 8, 'stone-furnace': 1 } }],
  ['enough plates for the drill', { inventory: { 'iron-plate': 9, 'stone-furnace': 1 } }],
]) {
  test(`Run BB: ${label} is not refused`, async () => {
    const w = bootstrapWorld([({ agent }) => bbDraft(agent, 'direct_feed'), startFuel], options)
    await w.say()
    assert.equal(w.calls.length, 2)
    assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
    assert.deepEqual(bootstrapChecks(w).map(row => row.verdict), ['feasible'])
    assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
  })
}

for (const [label, options] of [
  ['unreadable mining facts', { unreadable: ['getMiningDetails'] }],
  ['unreadable inventory facts', { unreadable: ['getInventoryItems'] }],
  ['unreadable recipe facts', { unreadable: ['getRecipeDetails'] }],
  ['ambiguous recipe facts', { ambiguous: ['iron-gear-wheel'] }],
]) {
  test(`Run BB: ${label} are not a refusal`, async () => {
    const w = bootstrapWorld([({ agent }) => bbDraft(agent, 'direct_feed'), startFuel], options)
    await w.say()
    assert.equal(w.calls.length, 2)
    assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
    assert.deepEqual(bootstrapChecks(w).map(row => row.verdict), ['unknown'])
    assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
  })
}

test('Run BB: a placed machine outside obligations.preserve counts as available', async () => {
  const w = bootstrapWorld([ctx => {
    ctx.memory.recordNpcPlacement(KEY, { unit_number: 31, entity_name: 'burner-mining-drill', actor_id: 18, actor_epoch: 3 })
    return bbDraft(ctx.agent, 'direct_feed')
  }, startFuel], { entities: { 31: 'burner-mining-drill' } })
  await w.say()
  assert.equal(w.calls.length, 2)
  assert.deepEqual(bootstrapChecks(w).map(row => row.verdict), ['feasible'])
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
  assert.ok(w.reads.some(text => /get_entity_status.*31/.test(text)), 'the placement was confirmed against the game, not trusted')
})

// B-R1-1: uncertainty about a recorded placement is never absence.
const recordDrills = (memory, units) => { for (const unit of units) memory.recordNpcPlacement(KEY, { unit_number: unit, entity_name: 'burner-mining-drill', actor_id: 18, actor_epoch: 3 }) }
for (const [label, options] of [
  ['a lookup that throws', { failing: ['getEntityStatus'] }],
  ['a lookup that cannot be read', { unreadable: ['getEntityStatus'] }],
  ['a lookup answered without an actor (found:false is not an absence)', { missingError: 'no controlled actor' }],
]) {
  test(`Run BB: ${label} for a recorded unpreserved drill is unresolved, not absent, and does not refuse`, async () => {
    const w = bootstrapWorld([ctx => { recordDrills(ctx.memory, [31]); return bbDraft(ctx.agent, 'direct_feed') }, startFuel], options)
    await w.say()
    assert.equal(w.calls.length, 2)
    assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
    const [checked] = bootstrapChecks(w)
    assert.equal(checked.verdict, 'unknown')
    assert.deepEqual(checked.unresolved, ['burner-mining-drill'])
    assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
  })
}

test('Run BB: a recorded drill past the placement examination cap is unresolved, not absent, and does not refuse', async () => {
  // Nine unpreserved placements, none shown by the game: the eight newest are looked up and confirmed gone, the oldest is never
  // examined, so the facts cannot say it is gone.
  const w = bootstrapWorld([ctx => { recordDrills(ctx.memory, [31, 32, 33, 34, 35, 36, 37, 38, 39]); return bbDraft(ctx.agent, 'direct_feed') }, startFuel])
  await w.say()
  assert.equal(w.calls.length, 2)
  assert.equal(w.reads.filter(text => text.includes('get_entity_status')).length, 8)
  const [checked] = bootstrapChecks(w)
  assert.equal(checked.verdict, 'unknown')
  assert.deepEqual(checked.unresolved, ['burner-mining-drill'])
  assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
})

test('Run BB: eight recorded drills the game confirms gone leave nothing unresolved, so the bootstrap is still refused', async () => {
  const w = bootstrapWorld([ctx => { recordDrills(ctx.memory, [31, 32, 33, 34, 35, 36, 37, 38]); return bbDraft(ctx.agent, 'direct_feed') }, ({ agent }) => bbDraft(agent, 'manual_bootstrap'), startFuel])
  await w.say()
  assert.equal(w.calls.length, 3)
  const [checked] = bootstrapChecks(w)
  assert.equal(checked.verdict, 'infeasible')
  assert.equal(checked.unresolved, undefined)
  assert.equal(w.events.find(row => row.event === 'role.contract_refused').data.reason, 'direct_feed_bootstrap_infeasible')
})

// B-R1-2: held units of the forbidden resource fund nothing.
test('Run BB: one held iron-ore does not fund the missing plate; the planner is refused and told the ore is held but forbidden by hand', async () => {
  const w = bootstrapWorld([({ agent }) => bbDraft(agent, 'direct_feed'), ({ agent, messages }) => {
    const refusal = messages.findLast(row => row.role === 'user' && row.content.includes('direct_feed_bootstrap_infeasible'))
    assert.ok(refusal, 'the held ore did not rescue the bootstrap')
    assert.match(refusal.content, /iron-ore 1 is held, but direct_feed forbids hand-supplying it/)
    assert.match(refusal.content, /still needs 1 iron-ore/)
    return bbDraft(agent, 'manual_bootstrap')
  }, startFuel], { inventory: { 'iron-plate': 8, 'stone-furnace': 1, 'iron-ore': 1, coal: 12 } })
  await w.say()
  assert.equal(w.calls.length, 3, 'one correction round')
  assert.equal(w.plan().steps[0].execution_guidance.materialSupply.mode, 'manual_bootstrap')
  assert.deepEqual(bootstrapChecks(w).map(row => row.verdict), ['infeasible'])
  assert.equal(w.events.find(row => row.event === 'role.contract_refused').data.reason, 'direct_feed_bootstrap_infeasible')
})

// B-R1-3: a later step follows steps that change inventory and placements.
const bbSupply = (mode, approach) => ({ ...brief(['direct-miner-smelting']), approach, materialSupply: { mode, resource: 'iron-ore' } })
const bbTwoStepDraft = agent => {
  agent.loadedSkillContext.set('direct-miner-smelting', { id: 'direct-miner-smelting', summary: 'Optional direct-feed time savings.' })
  const plates = inventoryCheckpoint('iron-plate', 12)
  return draft({ plan: ['Smelt the iron plates for a drill by hand in a separate furnace.', 'Build the direct-fed iron cell and verify the steam-power trigger.'],
    goal: { scope: 'finite', summary: 'Complete steam power research.', doneWhen: [{ kind: 'research_completed', technology: 'steam-power' }] },
    stepCompletions: [{ kind: 'deterministic', obligations: { outcome: plates, preserve: [27, 28] } }, { kind: 'deterministic', obligations: { outcome: BB_OUTCOME, preserve: [27, 28] } }],
    executionGuidance: [bbSupply('manual_bootstrap', 'Hand-smelt a few iron plates in a separate furnace.'), bbSupply('direct_feed', 'Establish a direct-fed iron miner and furnace and verify the steam-power trigger.')] })
}

test('Run BB: a direct_feed step after a manual_bootstrap step is not judged on today\'s inventory and commits', async () => {
  const w = bootstrapWorld([({ agent }) => bbTwoStepDraft(agent), startFuel])
  await w.say()
  assert.equal(w.calls.length, 2, 'no correction round')
  assert.deepEqual(w.plan().steps.map(step => step.execution_guidance.materialSupply.mode), ['manual_bootstrap', 'direct_feed'])
  const checks = bootstrapChecks(w)
  assert.deepEqual(checks.map(row => [row.step_index, row.verdict, row.reason]), [[1, 'unknown', 'prior_steps_change_facts']])
  assert.ok(!w.reads.some(text => text.includes('mining_details') || text.includes('get_entity_status')), 'no mining or placement fact is read for a step whose facts earlier steps change')
  assert.equal(w.events.filter(row => row.event === 'role.contract_refused').length, 0)
})

test('Run BB: only the first step still to run is judged on current facts; a restage\'s completed prefix does not count', async () => {
  const w = bootstrapWorld([])
  const plan = { executionGuidance: [bbSupply('manual_bootstrap', 'Already done.'), bbSupply('direct_feed', 'Build the cell.')],
    stepCompletions: [{ kind: 'deterministic', obligations: { preserve: [27, 28] } }, { kind: 'deterministic', obligations: { preserve: [27, 28] } }] }
  assert.equal(await directFeedBootstrapRefusal(w.agent, plan, { firstStep: 0 }), undefined, 'step 1 follows step 0, which still has to run')
  assert.deepEqual(bootstrapChecks(w).map(row => [row.step_index, row.verdict, row.reason]), [[1, 'unknown', 'prior_steps_change_facts']])
  const refusal = await directFeedBootstrapRefusal(w.agent, plan, { firstStep: 1 })
  assert.equal(refusal.code, 'direct_feed_bootstrap_infeasible')
  assert.equal(refusal.details.step_index, 1, 'step 0 is completed history, so step 1 is the first to run')
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

// Fold C3 into C8 (owner decision 2026-10-20): the delegation scenario showed a step restaged twice at its start, C8 at the step close
// and C3 when the planner review round handed the same step back, each rebuilding the same packet. An executor restaged at a step close
// that asks for a review before doing anything now gets its own conversation back after the round, as one folded entry: the step block
// is rewritten in place with the live facts and the notes, so both survive every continuation of the step.
// An executor soft limit of 1 token puts every verified step close past the hard limit, so each one restages (restage-policy C8).
const FOLD_NOTES = 'Iron ore candidates must be re-read near the actor.'
const restagedCheckpoints = events => events.filter(row => row.event === 'context.restaged').map(row => row.data.checkpoint)
const foldRows = (events, name) => events.filter(row => row.event === name).map(row => row.data)
const stepCloseWorld = script => {
  const w = world(script)
  w.agent.restageSoftLimitOption = { executor: 1 }
  return w
}
const askReview = ({ memory }) => ({ stepId: activeStepId(memory), operations: [],
  plannerReview: { reason: 'local_recovery_exhausted', rationale: RUN_AC_RATIONALE } })
const ironAction = ctx => ({ stepId: activeStepId(ctx.memory), operations: [gather('iron-ore', 10)] })
const plannerNotes = (notes = FOLD_NOTES) => copperThenIron({ chatMessage: notes, currentStep: 1 })
const blockLine = (messages, prefix) => afOutgoing(messages).split('\n').find(line => line.startsWith(prefix)) ?? ''
const consecutiveAssistants = messages => messages.some((row, index) => index > 0 && row.role === 'assistant' && messages[index - 1].role === 'assistant')
// Runs the first step to its close, so the next executor is the step-close (C8) one.
const closeFirstStep = async w => { await w.say(); w.game.inventory['copper-ore'] = 10; await w.agent.completed() }

test('a review handback right after a step-close restage folds into it: one restage, the notes in the refreshed step block, a user turn last', async () => {
  let c8
  const w = stepCloseWorld([copperThenIron(), action, ctx => {
    assert.equal(ctx.agent.agentContext.role, 'executor')
    assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C8/)
    c8 = { handoffId: ctx.agent.agentContext.handoffId, messages: ctx.messages.length }
    return askReview(ctx)
  }, plannerNotes(), ctx => {
    const outgoing = afOutgoing(ctx.messages)
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.agent.agentContext.handoffId, c8.handoffId, 'the conversation that asked for the review is the one that resumes')
    assert.equal(outgoing.split('restage: role=executor').length - 1, 1, 'one packet')
    assert.match(outgoing, /restage: role=executor checkpoint=C8/, 'the step-close packet, with its origin')
    assert.doesNotMatch(outgoing, /checkpoint=C3/)
    assert.equal(outgoing.split(FOLD_NOTES).length - 1, 1, 'the notes once')
    assert.match(blockLine(ctx.messages, 'planner_review_notes'), new RegExp(FOLD_NOTES), 'in the step block record, not a second message')
    assert.equal(ctx.messages.filter(row => String(row.content).startsWith('[PLANNER_REVIEW_NOTES]')).length, 0)
    assert.equal(ctx.messages.filter(row => row.role === 'assistant').length, 1, 'the review request is the executor turn the handback answers')
    assert.equal(ctx.messages.length, c8.messages + 2, 'the review request and the pointer are all that was added')
    assert.equal(ctx.messages.at(-1).role, 'user')
    assert.match(ctx.messages.at(-1).content, /returned it unchanged.*planner_review_notes record/)
    assert.equal(consecutiveAssistants(ctx.messages), false)
    assert.equal(outgoing.includes('[EXECUTOR_REVIEW]'), false, 'the planner conversation stays parked')
    assert.equal(ctx.agent.agentContext.hasParkedPlanner, true)
    assert.equal(ctx.context.allowTools, true)
    return ironAction(ctx)
  }, ctx => {
    // F2: one batch later the conversation is rebuilt from baseMessages; the notes must still be in it.
    assert.match(blockLine(ctx.messages, 'planner_review_notes'), new RegExp(FOLD_NOTES), 'the notes survive the continuation')
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  await w.agent.completed()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'executor', 'planner', 'executor', 'executor'])
  assert.equal(w.game.mutations.length, 3, 'the folded executor acted on the same step, twice')
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8'], 'no C3 after the C8')
  const [folded, ...more] = foldRows(w.events, 'context.restage_folded')
  assert.equal(more.length, 0)
  assert.deepEqual([folded.role, folded.checkpoint, folded.folded_from, folded.reason, folded.handoff_id], ['executor', 'C8', 'C3', 'review_handback_at_step_close', c8.handoffId])
  assert.equal(folded.step_id, w.plan().steps[1].step_id)
  assert.equal(folded.notes_chars, FOLD_NOTES.length)
  assert.deepEqual([folded.facts_refreshed, folded.step_block_rewritten], [true, true])
  assert.ok(folded.request_id)
  const entered = w.events.filter(row => row.event === 'lifecycle.entered' && row.data.event === 'restage' && row.data.folded_from === 'C3')
  assert.equal(entered.length, 1, 'the folded entry went through the lifecycle table')
  assert.deepEqual([entered[0].data.role, entered[0].data.checkpoint], ['executor', 'C8'])
  assert.equal(w.events.filter(row => row.event === 'lifecycle.refused').length, 0)
  assert.equal(w.events.find(row => row.event === 'context.planner_resumed').data.executor_kept, true)
  assert.equal(w.events.filter(row => row.event === 'context.restage_fold_skipped').length, 0)
  assert.equal(w.memory.planningState(KEY).goal.review_notes?.[w.plan().steps[1].step_id], FOLD_NOTES, 'the notes are also stored on the goal for a later restage')
})

test('a fact that changed during the planner round shows its current value in the folded executor, as a C3 packet would', async () => {
  let atReview
  const w = stepCloseWorld([copperThenIron(), action, ctx => {
    atReview = blockLine(ctx.messages, 'held_counts')
    return askReview(ctx)
  }, ctx => { ctx.game.inventory['iron-ore'] = 7; return plannerNotes() }, ctx => {
    const now = blockLine(ctx.messages, 'held_counts')
    assert.notEqual(now, atReview, 'the held counts were read again at the handback')
    assert.match(now, /iron-ore=7/)
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 1)
  assert.match(atReview, /^held_counts/)
  assert.doesNotMatch(atReview, /iron-ore=7/)
})

test('the pre-review reads stay free of the re-read allowance, and the fold seeds the same fresh allowance a C3 handback does, traced', async () => {
  const w = stepCloseWorld([copperThenIron(), action, () => readNearby('fold-read-1', 'iron-ore'), askReview,
    ctx => { ctx.agent.observationBudgetOverride = null; ctx.agent.observationBudgetRemaining = 0; return plannerNotes() }, ctx => {
      assert.deepEqual({ override: ctx.agent.observationBudgetOverride, remaining: ctx.agent.observationBudgetRemaining }, { override: 4, remaining: 4 },
        'at least as able to act on the notes as a C3 handback, which seeds 4')
      const ledger = ctx.agent.stepReadLedger
      const key = ctx.agent.stepReadKey()
      const signatures = [...ledger.steps.get(key).keys()]
      assert.equal(signatures.length, 1, 'the executor read once before asking')
      for (const signature of signatures) assert.equal(ledger.isReestablishing(key, signature, ctx.agent.agentContext.conversationSeq), false, 'the result is still in the conversation')
      return ironAction(ctx)
    }])
  await closeFirstStep(w)
  const [folded] = foldRows(w.events, 'context.restage_folded')
  assert.equal(folded.reads_rebased, 1)
  assert.equal(folded.observation_remaining, 4)
  const started = foldRows(w.events, 'context.executor_observation_started').at(-1)
  assert.deepEqual([started.handoff_id, started.observation_remaining, started.reason], [folded.handoff_id, 4, 'new_executor_decision_at_review_handback'])
})

test('an empty planner reply still ends the resumed conversation on a user turn', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, plannerNotes(''), ctx => {
    assert.equal(ctx.messages.at(-1).role, 'user', 'a conversation never ends on the executor review request')
    assert.match(ctx.messages.at(-1).content, /returned it unchanged.*It sent no notes/)
    assert.equal(consecutiveAssistants(ctx.messages), false)
    assert.equal(blockLine(ctx.messages, 'planner_review_notes'), '')
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 1)
  assert.equal(foldRows(w.events, 'context.restage_folded')[0].notes_chars, 0)
})

test('a legacy blocker reply that already ends the executor conversation on an assistant turn gets no second one', async () => {
  const legacy = ({ memory }) => ({ ...runAB.legacy_reply, stepId: activeStepId(memory) })
  const w = stepCloseWorld([copperThenIron(), action, legacy, plannerNotes(), ctx => {
    assert.equal(consecutiveAssistants(ctx.messages), false, 'the blocker reply and the synthetic review request are not both assistant turns')
    assert.equal(ctx.messages.at(-1).role, 'user')
    return ironAction(ctx)
  }])
  w.agent.tryFreshContextActionRecovery = async () => ({ attempted: false })
  await closeFirstStep(w)
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 1)
  assert.equal(foldRows(w.events, 'executor.legacy_blocker_review').length, 1, 'the review was raised from the legacy blocker route')
})

test('a review handback with no step close before it stays a C3 handback, and says why the fold was not attempted', async () => {
  const w = stepCloseWorld([draft(), review('local_recovery_exhausted', RUN_AC_RATIONALE), draft({ chatMessage: 'Copper ore is 12 tiles east of the actor.', plan: ['A tempting different strategy'] }), ctx => {
    assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/)
    return action(ctx)
  }])
  await w.say()
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C3'], 'the plan-commit executor is rebuilt as before')
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 0)
  assert.equal(w.events.find(row => row.event === 'context.planner_resumed').data.executor_kept, undefined)
  const [skipped] = foldRows(w.events, 'context.restage_fold_skipped')
  assert.deepEqual([skipped.reason, skipped.stage, skipped.folded_from], ['not_step_close_restage', 'review', 'C3'])
  assert.ok(skipped.request_id)
})

test('a review handback after the step-close executor already acted stays a C3 handback', async () => {
  const w = stepCloseWorld([copperThenIron(), action, ctx => ({ stepId: activeStepId(ctx.memory), operations: [gather('iron-ore', 4)] }),
    askReview, plannerNotes(), ctx => {
      assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/)
      return ironAction(ctx)
    }])
  await closeFirstStep(w)
  assert.equal(w.game.mutations.length, 2)
  await w.agent.completed()
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'executor', 'executor', 'planner', 'executor'])
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'], 'the world changed since the step-close restage, so the executor is rebuilt from the world as it is now')
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 0)
  assert.deepEqual(foldRows(w.events, 'context.restage_fold_skipped').map(row => [row.reason, row.stage]), [['world_changed_since_step_close', 'review']])
})

// Every way the kept conversation can stop being the step's: each is traced with its reason and the handback restages as C3.
for (const [reason, tamper] of [
  ['plan_moved_on', meta => { meta.plan_id = 'other_plan' }],
  ['step_moved_on', meta => { meta.step_id = 'other_step' }],
  ['goal_moved_on', meta => { meta.goal_id = 'other_goal' }],
  ['actor_or_epoch_changed', meta => { meta.epoch = (meta.epoch ?? 0) + 99 }],
  ['reasoning_epoch_changed', meta => { meta.reasoning_epoch = (meta.reasoning_epoch ?? 0) + 99 }],
  ['kept_executor_not_resumable', meta => { meta.request_id = 'another_request' }],
  ['world_changed_since_step_close', (meta, agent) => { agent.worldMutationSeq += 1 }],
]) {
  test(`a folded handback the ${reason} is skipped on the record and restages as a clean C3 with the notes in its packet`, async () => {
    const w = stepCloseWorld([copperThenIron(), action, askReview,
      ctx => { tamper(ctx.agent.agentContext.parkedExecutor.meta, ctx.agent); return plannerNotes() }, ctx => {
        const outgoing = afOutgoing(ctx.messages)
        assert.match(outgoing, /restage: role=executor checkpoint=C3/)
        assert.equal(outgoing.split(FOLD_NOTES).length - 1, 1, 'the notes once')
        assert.match(blockLine(ctx.messages, 'planner_review_notes'), new RegExp(FOLD_NOTES), 'in the packet record of the rebuilt executor')
        assert.equal(consecutiveAssistants(ctx.messages), false)
        return ironAction(ctx)
      }])
    await closeFirstStep(w)
    assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'])
    assert.equal(foldRows(w.events, 'context.restage_folded').length, 0)
    const [skipped] = foldRows(w.events, 'context.restage_fold_skipped')
    assert.deepEqual([skipped.role, skipped.checkpoint, skipped.folded_from, skipped.reason, skipped.stage], ['executor', 'C8', 'C3', reason, 'handback'])
    assert.ok(skipped.request_id)
    assert.equal(w.agent.agentContext.hasParkedExecutor, false, 'the kept conversation is dropped once it cannot be used')
    assert.equal(w.game.mutations.length, 2)
  })
}

test('a restageContext refusal in fold mode falls back to a clean C3, and the kept conversation is gone', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
    const original = ctx.agent.restageContext.bind(ctx.agent)
    ctx.agent.restageContext = async args => (args.foldKept ? { restaged: false, reason: 'round_open' } : original(args))
    return plannerNotes()
  }, ctx => {
    assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/)
    assert.equal(ctx.agent.agentContext.hasParkedPlanner, true)
    assert.equal(consecutiveAssistants(ctx.messages), false)
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'])
  assert.deepEqual(foldRows(w.events, 'context.restage_fold_skipped').map(row => [row.reason, row.stage]), [['round_open', 'handback']])
  assert.equal(foldRows(w.events, 'context.restage_folded').length, 0)
})

test('restageContext in fold mode with nothing kept refuses before changing the conversation', async () => {
  const w = stepCloseWorld([draft()])
  await w.say().catch(() => {})
  w.agent.lifecycleEnter = () => undefined // the goal is closed after the failed request; this test is about the resume, not the table
  const before = { role: w.agent.agentContext.role, handoff: w.agent.agentContext.handoffId, seq: w.agent.agentContext.conversationSeq }
  const result = await w.agent.restageContext({ checkpoint: 'C8', reason: 'r', role: 'executor', foldKept: true })
  assert.deepEqual([result.restaged, result.reason], [false, 'kept_executor_not_resumable'])
  assert.deepEqual({ role: w.agent.agentContext.role, handoff: w.agent.agentContext.handoffId, seq: w.agent.agentContext.conversationSeq }, before)
  assert.equal(foldRows(w.events, 'context.restage_refused').at(-1).reason, 'kept_executor_not_resumable')
})

test('a kept executor dropped before the handback is traced, and the handback restages as C3', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => { ctx.agent.agentContext.dropParkedExecutor(); return plannerNotes() },
    ctx => { assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/); return ironAction(ctx) }])
  await closeFirstStep(w)
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'])
  assert.deepEqual(foldRows(w.events, 'context.restage_fold_skipped').map(row => [row.reason, row.stage]), [['kept_executor_dropped', 'handback']])
})

test('a planner round that never hands back does not leave the kept executor behind', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, () => { throw new Error('forced planner stop') }])
  await closeFirstStep(w).catch(() => {})
  assert.equal(w.agent.agentContext.hasParkedExecutor, false)
})

// The turn that follows the review request says only what happened to the step block.
const harnessTurn = messages => messages.findLast(row => String(row.content).startsWith('[HARNESS] The planner reviewed this step'))

test('a step-block rewrite that throws after the swap falls back to the full notes as a user turn, on the record', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
    ctx.agent.replaceExecutorStepBlock = () => { throw new Error('forced rewrite failure') }
    return plannerNotes()
  }, ctx => {
    const notesTurn = ctx.messages.findLast(row => String(row.content).startsWith('[PLANNER_REVIEW_NOTES]'))
    assert.equal(notesTurn?.role, 'user')
    assert.match(notesTurn.content, /Iron ore candidates must be re-read/, 'the notes follow whole as a message')
    assert.equal(consecutiveAssistants(ctx.messages), false)
    assert.equal(blockLine(ctx.messages, 'planner_review_notes'), '', 'the old step block carries none')
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  const [failed] = foldRows(w.events, 'context.restage_fold_rewrite_failed')
  assert.deepEqual([failed.reason, failed.message], ['step_block_rewrite_failed', 'forced rewrite failure'])
  assert.ok(failed.request_id)
  const [folded] = foldRows(w.events, 'context.restage_folded')
  assert.deepEqual([folded.step_block_rewritten, folded.facts_refreshed], [false, false])
  assert.equal(w.game.mutations.length, 2, 'the request went on')
})

test('with no notes and a failed rewrite the user turn does not claim a refresh', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
    ctx.agent.replaceExecutorStepBlock = () => { throw new Error('forced rewrite failure') }
    return plannerNotes('')
  }, ctx => {
    assert.match(harnessTurn(ctx.messages).content, /It sent no notes\. That step block is as it was before the review; its facts were not read again\./)
    assert.doesNotMatch(harnessTurn(ctx.messages).content, /refreshed from the live game/)
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  assert.equal(foldRows(w.events, 'context.restage_folded')[0].step_block_rewritten, false)
})

test('when no fact was read the rewritten block says so, and the trace agrees', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
    ctx.agent.gatherExecutorHandoffFacts = async () => undefined
    return plannerNotes()
  }, ctx => {
    assert.match(harnessTurn(ctx.messages).content, /rewritten, but its facts were not read again/)
    assert.doesNotMatch(harnessTurn(ctx.messages).content, /refreshed from the live game/)
    assert.match(blockLine(ctx.messages, 'planner_review_notes'), new RegExp(FOLD_NOTES))
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  const [folded] = foldRows(w.events, 'context.restage_folded')
  assert.deepEqual([folded.facts_refreshed, folded.step_block_rewritten], [false, true])
})

for (const [reason, gathered] of [
  ['actor_changed_during_handoff', { refusal: 'actor_changed_during_handoff', meta: {} }],
  ['facts_deferred_behind_batch', { facts: undefined, meta: { counts_deferred: true } }],
]) {
  test(`a fact read that ends in ${reason} falls back to a clean C3 and says why`, async () => {
    const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
      const original = ctx.agent.gatherExecutorHandoffFacts.bind(ctx.agent)
      let first = true
      ctx.agent.gatherExecutorHandoffFacts = async args => {
        if (first) { first = false; return gathered }
        return original(args)
      }
      return plannerNotes()
    }, ctx => {
      assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/)
      assert.match(blockLine(ctx.messages, 'planner_review_notes'), new RegExp(FOLD_NOTES))
      assert.equal(consecutiveAssistants(ctx.messages), false)
      return ironAction(ctx)
    }])
    await closeFirstStep(w)
    assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'])
    assert.equal(foldRows(w.events, 'context.restage_folded').length, 0)
    assert.deepEqual(foldRows(w.events, 'context.restage_fold_skipped').map(row => [row.reason, row.stage]), [[reason, 'handback']])
    assert.equal(w.agent.agentContext.hasParkedExecutor, false)
  })
}

test('a fold the restage guard would refuse spends no fact reads before falling back', async () => {
  let reads = 0
  const w = stepCloseWorld([copperThenIron(), action, askReview, ctx => {
    const original = ctx.agent.gatherExecutorHandoffFacts.bind(ctx.agent)
    ctx.agent.gatherExecutorHandoffFacts = async args => { reads++; return original(args) }
    const guard = ctx.agent.restageGuardRefusal.bind(ctx.agent)
    let first = true
    ctx.agent.restageGuardRefusal = safePoint => {
      if (first) { first = false; return 'round_open' }
      return guard(safePoint)
    }
    return plannerNotes()
  }, ctx => {
    assert.match(afOutgoing(ctx.messages), /restage: role=executor checkpoint=C3/)
    return ironAction(ctx)
  }])
  await closeFirstStep(w)
  assert.equal(reads, 1, 'only the C3 handback read the facts')
  assert.deepEqual(foldRows(w.events, 'context.restage_fold_skipped').map(row => [row.reason, row.stage]), [['round_open', 'handback']])
  assert.deepEqual(restagedCheckpoints(w.events), ['C3', 'C8', 'C3'])
})

test('the facts a fold carries are traced as a fold, not as a rebuilt context', async () => {
  const w = stepCloseWorld([copperThenIron(), action, askReview, plannerNotes(), ironAction])
  await closeFirstStep(w)
  const carried = foldRows(w.events, 'context.executor_facts_carried')
  assert.equal(carried.at(-1).reason, 'review_handback_folded_into_the_step_close_conversation')
  assert.equal(carried.at(-1).checkpoint, 'C8')
})
