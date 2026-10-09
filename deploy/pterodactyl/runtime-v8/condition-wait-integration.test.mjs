import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { makeConditionWait } from './step-completion.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function state(goalId = 'goal_condition') {
  return {
    goal_id: goalId,
    owner: 'tester',
    objective: 'smelt enough material and then craft the requested item',
    status: 'active',
    admission_status: undefined,
    blocker: '',
    pause_reason: '',
    persistent_runtime: undefined,
    condition_wait: undefined,
    plan: ['Smelt required material', 'Craft requested item'],
    current_step: 0,
    revision: 1,
    last_chat_message: '',
    last_operations: [],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 8,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: goalId,
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 1,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'Smelt required material', status: 'active' },
        { id: 'step_2', description: 'Craft requested item', status: 'pending' },
      ],
      evidence: [{
        id: 'evidence_1',
        kind: 'deterministic_verification',
        ref: 'batch_8',
        summary: JSON.stringify({ verdict: 'operation_completed_but_semantic_step_not_yet_verified' }),
        step_id: 'step_1',
        at: Date.now(),
      }],
      events: [],
    },
  }
}

class ConditionRcon {
  constructor() {
    this.working = true
    this.inventoryCount = 0
    this.pendingCondition = null
    this.actorId = 18
    this.actorEpoch = 3
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) {
      return JSON.stringify({ ...deployment(), actor_id: this.actorId, epoch: this.actorEpoch })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify({ active: false, healthy: false, controller_live: false, state: 'idle' })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_tools","evaluate_condition"')) {
      if (this.pendingCondition) return this.pendingCondition
      if (text.includes('inventory_count')) {
        return JSON.stringify({
          ok: true,
          kind: 'inventory_count',
          satisfied: this.inventoryCount >= 9,
          current: this.inventoryCount,
          minimum: 9,
          progress_known: false,
        })
      }
      return JSON.stringify({
        ok: true,
        kind: 'entity_state',
        satisfied: this.working,
        unit_number: 582,
        progressing: this.working,
        progress_known: true,
        entity_status: this.working ? 1 : 0,
      })
    }
    return '{}'
  }
}

function postStepDecisionResponse(route = 'wait_runtime', {
  granularity = 'keep',
  development = 'maintain',
  reasoningBudget = 'normal',
  planningHorizon = 'checkpoint',
  observationBudget = 0,
  milestoneTransition,
} = {}) {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      route: { type: 'choice', choice: route, confidence: 0.95 },
      granularity: { type: 'choice', choice: granularity, confidence: 0.9 },
      development: { type: 'choice', choice: development, confidence: 0.9 },
      reasoning_budget: { type: 'choice', choice: reasoningBudget, confidence: 0.8 },
      planning_horizon: { type: 'choice', choice: planningHorizon, confidence: 0.8 },
      observation_budget: { type: 'score', score: observationBudget, confidence: 0.8 },
      ...(milestoneTransition
        ? { milestone_transition: { type: 'choice', choice: milestoneTransition, confidence: 0.9 } }
        : {}),
    },
    usage: { input_tokens: 40, output_tokens: 4, cost: 0.000002 },
  }
}

function decisionResponse(route = 'wait_runtime') {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      failure_class: { type: 'choice', choice: 'provider_format', confidence: 0.9 },
      next_recovery: { type: 'choice', choice: route, confidence: 0.95 },
      world_failure_supported: { type: 'noul', noul: 0.05 },
      need_fresh_observation: { type: 'noul', noul: 0.05 },
      need_semantic_replan: { type: 'noul', noul: 0.05 },
    },
    usage: { input_tokens: 70, output_tokens: 8, cost: 0.000003 },
  }
}

function makeAgent({ decisionProvider, provider, committed = false } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:sgluna', state())
  // A step close is decided in the reducer first (3.3 move 5), which only
  // closes admitted work. Tests that place a wait directly (bypassing
  // registration) ask for a committed plan; the registration path itself is
  // tested from an uncommitted draft.
  if (committed) {
    memory.ensurePlanningDraft('npc:sgluna', memory.planByNpc.get('npc:sgluna'), { now: 1 })
    memory.commitPlanningPlan('npc:sgluna', { now: 2, runtime_validation: { passed: true } })
  }
  const rcon = new ConditionRcon()
  let mainCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    npcId: 'sgluna',
    systemPrompt: 'condition wait integration test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    interactionDecisionProvider: decisionProvider,
    provider: provider ?? (async () => {
      mainCalls++
      throw new Error('main planner should not be called')
    }),
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:sgluna'
  agent.requestInfo = {
    memoryKey: 'npc:sgluna',
    turnId: 1,
    sender: 'tester',
    text: 'smelt enough material and then craft the requested item',
  }
  agent.baseMessages = [{ role: 'system', content: agent.systemPrompt }]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  return { agent, memory, rcon, mainCalls: () => mainCalls }
}

test('live exact machine passive progress suppresses action omission without a main planner wake', async () => {
  const { agent, memory, mainCalls } = makeAgent()
  agent.recordLiveEntityObservation({
    name: 'stone-furnace',
    type: 'furnace',
    unit_number: 582,
    position: { x: 4, y: 0 },
    working: true,
    status: 1,
  }, { x: 0, y: 0 }, 'getEntityStatus')

  const result = await agent.commitPlan({
    chatMessage: 'The already-loaded machine is still making progress.',
    plan: ['Smelt required material', 'Craft requested item'],
    currentStep: 1,
    operations: [],
  })

  const durable = memory.planByNpc.get('npc:sgluna')
  assert.equal(result.goalStatus, 'active')
  assert.equal(durable.task_board.completed_count, 0)
  assert.equal(durable.task_board.active_index, 0)
  assert.equal(durable.task_board.proposed_focus_index, 1)
  assert.equal(durable.condition_wait?.state, 'active')
  assert.equal(durable.condition_wait?.mode, 'passive_progress')
  assert.equal(durable.condition_wait?.actor_id, 18)
  assert.equal(durable.condition_wait?.actor_epoch, 3)
  assert.equal(agent.actionOmissionRepairActive, false)
  assert.equal(mainCalls(), 0)
})

test('unchanged passive progress polls without waking the main planner', async () => {
  const { agent, memory, mainCalls } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, mode: 'passive_progress', maxChecks: 10 },
  )

  const polled = await agent.pollConditionWait()
  assert.equal(polled.action, 'waiting')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait?.state, 'active')
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
  assert.equal(mainCalls(), 0)
})

test('a wait on a still-uncommitted draft is never registered as a wait the reducer cannot close: registration commits the draft, and the wait then closes its step', async () => {
  const { agent, memory, rcon } = makeAgent()
  memory.ensurePlanningDraft('npc:sgluna', memory.planByNpc.get('npc:sgluna'), { now: 1 })
  assert.equal(getActivePlan(memory.planningState('npc:sgluna')).status, PLAN_STATUS.DRAFT, 'a zero-operation draft that no preflight ever committed')
  agent.recordLiveEntityObservation({
    name: 'stone-furnace', type: 'furnace', unit_number: 582, position: { x: 4, y: 0 }, working: true, status: 1,
  }, { x: 0, y: 0 }, 'getEntityStatus')

  await agent.commitPlan({
    chatMessage: 'The machine is still making progress.',
    plan: ['Smelt required material', 'Craft requested item'],
    currentStep: 0,
    operations: [],
  })

  const durable = memory.planByNpc.get('npc:sgluna')
  assert.equal(durable.condition_wait?.state, 'active')
  assert.equal(getActivePlan(memory.planningState('npc:sgluna')).status, PLAN_STATUS.COMMITTED, 'the wait registered on admitted work')

  durable.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, maxChecks: 10 },
  )
  rcon.inventoryCount = 9
  const verified = await agent.pollConditionWait()
  assert.equal(verified.action, 'verified')
  assert.equal(verified.state.task_board.completed_count, 1)
  assert.equal(getActivePlan(memory.planningState('npc:sgluna')).active_step_index, 1)
})

test('a wait that reaches the close on an uncommitted draft is cleared and handed back once, not re-polled forever', async () => {
  const { agent, memory, rcon } = makeAgent()
  memory.ensurePlanningDraft('npc:sgluna', memory.planByNpc.get('npc:sgluna'), { now: 1 })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, maxChecks: 10 },
  )
  rcon.inventoryCount = 9

  const handedBack = await agent.pollConditionWait()

  assert.equal(handedBack.action, 'wake')
  assert.equal(handedBack.reason, 'plan_not_committed')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined, 'the wait is gone, so nothing polls it again')
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
  assert.equal(await agent.pollConditionWait(), null)
})

test('grounded inventory condition advances exactly one canonical step once satisfied', async () => {
  const { agent, memory, rcon } = makeAgent({ committed: true })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, maxChecks: 10 },
  )

  rcon.inventoryCount = 0
  const waiting = await agent.pollConditionWait()
  assert.equal(waiting.action, 'waiting')
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)

  rcon.inventoryCount = 9
  const verified = await agent.pollConditionWait()
  assert.equal(verified.action, 'verified')
  assert.equal(verified.state.status, 'active')
  assert.equal(verified.state.task_board.completed_count, 1)
  assert.equal(verified.state.task_board.active_index, 1)
  assert.equal(verified.state.task_board.steps[0].status, 'completed')

  const duplicate = await agent.pollConditionWait()
  assert.equal(duplicate, null)
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 1)
})

test('Jev wait_runtime remains valid with idle Autorio while a condition watcher is healthy', async () => {
  const { agent, memory, mainCalls } = makeAgent({
    decisionProvider: async () => decisionResponse('wait_runtime'),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, mode: 'passive_progress', maxChecks: 10 },
  )

  const result = await agent.recoverPlan(agent.generation, new Error('invalid provider JSON'), 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(memory.planByNpc.get('npc:sgluna').status, 'active')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait?.state, 'active')
  assert.equal(mainCalls(), 0)
})

test('condition timeout or stopped passive progress never fakes completion', async () => {
  const { agent, memory, rcon } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, mode: 'passive_progress', maxChecks: 10 },
  )
  rcon.working = false

  const result = await agent.pollConditionWait()
  assert.equal(result.action, 'wake')
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.active_index, 0)
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined)
})

test('stale condition result cannot mutate a replacement task', async () => {
  const { agent, memory, rcon } = makeAgent()
  const old = memory.planByNpc.get('npc:sgluna')
  old.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: old.goal_id, stepId: old.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, maxChecks: 10 },
  )

  let release
  rcon.pendingCondition = new Promise(resolve => {
    release = () => resolve(JSON.stringify({
      ok: true,
      kind: 'inventory_count',
      satisfied: true,
      current: 99,
      minimum: 9,
      progress_known: false,
    }))
  })

  const polling = agent.pollConditionWait()
  memory.terminatePlan('npc:sgluna')
  memory.planByNpc.set('npc:sgluna', state('goal_replacement'))
  release()
  const result = await polling

  assert.equal(result.action, 'stale')
  const replacement = memory.planByNpc.get('npc:sgluna')
  assert.equal(replacement.goal_id, 'goal_replacement')
  assert.equal(replacement.task_board.completed_count, 0)
  assert.equal(replacement.task_board.active_index, 0)
})


test('post-step Jev wait_runtime accepts idle Autorio only after deterministic watcher validation', async () => {
  const { agent, memory, mainCalls } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('wait_runtime'),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )

  const routed = await agent.routePostStepDecision({
    view: { task_state: 'idle', queue_length: 0 },
  })
  assert.equal(routed.route, 'wait_runtime')
  assert.equal(routed.runtime_reason, 'condition_wait_active')
  assert.equal(mainCalls(), 0)
})


test('steering maintain converts continue_current into runtime wait with healthy deterministic progress', async () => {
  const { agent, memory } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('continue_current', {
      development: 'maintain',
      reasoningBudget: 'micro',
      observationBudget: 0,
    }),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )

  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.requested_route, 'continue_current')
  assert.equal(routed.route, 'wait_runtime')
  assert.equal(routed.fallback_reason, 'steering_maintain_authoritative_runtime')
  assert.equal('hierarchy_gate' in routed, false)
})

test('post-step routing accepts canonical continue_runtime vocabulary and preserves the existing internal continuation path', async () => {
  const { agent, memory } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('continue_runtime', {
      development: 'maintain',
      reasoningBudget: 'micro',
      observationBudget: 0,
    }),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )

  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.requested_route, 'continue_current')
  assert.equal(routed.route, 'wait_runtime')
  assert.equal('hierarchy_gate' in routed, false)
})

test('steering refuses runtime wait when Jev says the direction is not maintain', async () => {
  const { agent, memory } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('wait_runtime', {
      development: 'vertical',
    }),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )

  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.requested_route, 'wait_runtime')
  assert.equal(routed.route, 'fallback_planner')
  assert.equal(routed.fallback_reason, 'steering_requires_planner')
  assert.equal('hierarchy_action' in routed, false)
  assert.equal('hierarchy_gate' in routed, false)
})

test('retired granularity split advice cannot create a replan on a completion boundary', async () => {
  const { agent, memory } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('wait_runtime', {
      granularity: 'split',
      development: 'maintain',
    }),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )

  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.requested_route, 'wait_runtime')
  assert.equal(routed.route, 'wait_runtime')
  assert.equal('hierarchy_action' in routed, false)
})

test('M9 idle continue_runtime falls back to planner when no valid watcher exists', async () => {
  const { agent, memory, mainCalls } = makeAgent({
    decisionProvider: async () => decisionResponse('continue_runtime'),
  })
  const routed = await agent.routeRecoveryDecision(new Error('provider timeout'), 1)
  assert.equal(routed.requested_route, 'continue_runtime')
  assert.equal(routed.route, 'wake_planner')
  assert.equal(routed.rejection_reason, 'continue_runtime_without_authoritative_active_runtime')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined)
  assert.equal(mainCalls(), 0)
})

test('provider and recovery failures preserve a healthy watcher and never wake the main planner', async () => {
  for (const reason of [
    'invalid provider JSON',
    'finish=length output budget exhausted',
    'provider timeout',
    'recovery provider failed',
  ]) {
    const { agent, memory, mainCalls } = makeAgent({
      decisionProvider: async () => {
        throw new Error('decision provider unavailable')
      },
    })
    const durable = memory.planByNpc.get('npc:sgluna')
    durable.condition_wait = makeConditionWait(
      { kind: 'entity_state', unit_number: 582, expected: 'working' },
      {
        goalId: durable.goal_id,
        stepId: durable.task_board.active_step_id,
        actorId: agent.epoch.actor_id,
        actorEpoch: agent.epoch.epoch,
        mode: 'passive_progress',
        maxChecks: 10,
      },
    )

    const result = await agent.recoverPlan(agent.generation, new Error(reason), 1)
    assert.equal(result.goalStatus, 'active')
    assert.equal(memory.planByNpc.get('npc:sgluna').status, 'active')
    assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait?.state, 'active')
    assert.equal(agent.actionOmissionRepairActive, false)
    assert.equal(mainCalls(), 0)
  }
})

test('stale exact entity identity invalidates the watcher without completion', async () => {
  const { agent, memory, rcon } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 10,
    },
  )
  rcon.pendingCondition = JSON.stringify({
    ok: false,
    stale: true,
    error: 'stale_exact_identity',
  })

  const result = await agent.pollConditionWait()
  assert.equal(result.action, 'failed')
  assert.equal(result.reason, 'stale_exact_identity')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined)
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
})

test('healthy passive progress times out at its bounded check limit without fake completion', async () => {
  const { agent, memory } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      mode: 'passive_progress',
      maxChecks: 1,
    },
  )

  const result = await agent.pollConditionWait()
  assert.equal(result.action, 'timeout')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined)
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
})

test('actor epoch change cancels the watcher and a stale poll cannot complete the task', async () => {
  const { agent, memory, rcon } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    {
      goalId: durable.goal_id,
      stepId: durable.task_board.active_step_id,
      actorId: agent.epoch.actor_id,
      actorEpoch: agent.epoch.epoch,
      maxChecks: 10,
    },
  )

  let release
  rcon.pendingCondition = new Promise(resolve => {
    release = () => resolve(JSON.stringify({
      ok: true,
      kind: 'inventory_count',
      satisfied: true,
      current: 99,
      minimum: 9,
      progress_known: false,
    }))
  })

  const polling = agent.pollConditionWait()
  await new Promise(resolve => setImmediate(resolve))
  rcon.actorEpoch = 4
  release()
  const result = await polling

  assert.equal(result.action, 'failed')
  assert.equal(result.reason, 'condition_lifecycle_changed')
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait, undefined)
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
})


test('legacy milestone transition data is inert for post-step routing', async () => {
  const { agent, memory } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('continue_current', {
      milestoneTransition: 'advance_next',
      reasoningBudget: 'normal',
      planningHorizon: 'subgoal',
    }),
  })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.project_board = {
    kind: 'project_board_v1',
    project_id: durable.goal_id,
    title: durable.objective,
    status: 'active',
    completed_milestones: [{ title: 'Establish burner production', status: 'completed' }],
    current_milestone: undefined,
    next_milestones: [{ title: 'Reach Automation', status: 'tentative' }],
    development_direction: 'vertical',
    transition_state: 'awaiting_next_milestone',
    revision: 2,
    updated_at: Date.now(),
  }
  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.route, 'continue_current')
  assert.equal('hierarchy_action' in routed, false)
  const retained = memory.planByNpc.get('npc:sgluna')
  assert.equal(retained.project_board.transition_state, 'awaiting_next_milestone')
  assert.equal(retained.task_board.total_steps, durable.task_board.total_steps)
})


test('retired granularity collapse advice is inert instead of silently replanning', async () => {
  const { agent } = makeAgent({
    decisionProvider: async () => postStepDecisionResponse('continue_current', {
      granularity: 'collapse',
      development: 'maintain',
    }),
  })
  const routed = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0 } })
  assert.equal(routed.route, 'continue_current')
  assert.equal('hierarchy_action' in routed, false)
})


test('adaptive observation-pressure completion forces a no-tools planner decision instead of pausing', async () => {
  let decisionCalls = 0
  let providerOptions
  const { agent } = makeAgent({
    decisionProvider: async () => {
      decisionCalls++
      return decisionResponse('pause_recoverable')
    },
    provider: async (_messages, options) => {
      providerOptions = options
      throw new Error('forced decision test stop')
    },
  })

  await assert.rejects(
    agent.recoverPlan(
      agent.generation,
      new Error('The targeted observation budget allowed by decision pressure is complete. Stop observing. Reuse the live evidence already collected and return the next executable action, or a truthful blocker naming the still-missing fact.'),
      1,
    ),
    /forced decision test stop/,
  )

  assert.equal(decisionCalls, 0)
  assert.equal(providerOptions.allowTools, false)
  assert.equal(agent.actionOmissionRepairActive, true)
  assert.equal(agent.actionOmissionObservationUsed, true)
  assert.equal(agent.actionOmissionForceNoTools, true)
})

test('recovery route does not inherit the parent planning reasoning budget', async () => {
  let seenOptions
  const { agent } = makeAgent({
    decisionProvider: async () => decisionResponse('wake_planner'),
    provider: async (_messages, options) => {
      seenOptions = options
      throw new Error('stop after capture')
    },
  })
  agent.reasoningBudgetOverride = 'strategic'

  await assert.rejects(
    agent.recoverPlan(agent.generation, new Error('provider returned invalid JSON'), 1),
    // M11D routes a format failure deterministically, without a Jev route
    // call, so the capturing provider's own error surfaces unwrapped.
    /stop after capture/,
  )
  assert.equal(seenOptions.triggerSource, 'recovery_continue_low')
  assert.equal(seenOptions.reasoningBudget, undefined)
  assert.equal(agent.reasoningBudgetOverride, 'strategic')
})

test('M9 recovery observe falls back to planner when the deterministic observation budget is exhausted', async () => {
  const { agent } = makeAgent({
    decisionProvider: async () => decisionResponse('observe'),
  })
  agent.observationBudgetRemaining = 0

  const routed = await agent.routeRecoveryDecision(new Error('one mutable fact is missing'), 1)
  assert.equal(routed.requested_route, 'observe')
  assert.equal(routed.route, 'wake_planner')
  assert.equal(routed.rejection_reason, 'targeted_observation_budget_exhausted')
})


test('continuation boundary clears a previous forced observation-decision state', async () => {
  let seenOptions
  const { agent } = makeAgent({
    provider: async (_messages, options) => {
      seenOptions = options
      throw new Error('capture continuation options')
    },
  })
  agent.observationDecisionPressure = true
  agent.observationDecisionPressureRemaining = 0
  agent.observationDecisionForced = true

  await assert.rejects(
    agent.continueFromModMessage('[MOD] synthetic continuation', 'test.synthetic_continuation'),
    /capture continuation options/,
  )
  assert.equal(seenOptions.allowTools, true)
})


test('Jev observation budget partially admits useful read-only observations instead of dropping the whole batch', async () => {
  const { agent } = makeAgent()
  agent.observationBudgetRemaining = 1
  const message = {
    role: 'assistant',
    content: null,
    tool_calls: [10, 20, 30].map((radius, index) => ({
      id: `obs-budget-${index}`,
      type: 'function',
      function: {
        name: 'getNearbyEntities',
        arguments: JSON.stringify({ radius, limit: 1 }),
      },
    })),
  }

  await agent.handleToolBatch(message)

  const toolMessages = agent.messages.filter(entry => entry.role === 'tool')
  assert.equal(toolMessages.length, 1)
  assert.equal(toolMessages[0].tool_call_id, 'obs-budget-0')
  assert.equal(agent.observationBudgetRemaining, 0)
  assert.equal(agent.observationDecisionForced, true)
})

test('read-only observation batches above the four-call turn cap execute the bounded prefix and defer the rest', async () => {
  const { agent } = makeAgent()
  agent.observationBudgetRemaining = null
  const message = {
    role: 'assistant',
    content: null,
    tool_calls: [10, 20, 30, 40, 50].map((radius, index) => ({
      id: `obs-cap-${index}`,
      type: 'function',
      function: {
        name: 'getNearbyEntities',
        arguments: JSON.stringify({ radius, limit: 1 }),
      },
    })),
  }

  await agent.handleToolBatch(message)

  const toolMessages = agent.messages.filter(entry => entry.role === 'tool')
  assert.equal(toolMessages.length, 4)
  assert.deepEqual(toolMessages.map(entry => entry.tool_call_id), ['obs-cap-0', 'obs-cap-1', 'obs-cap-2', 'obs-cap-3'])
  assert.equal(agent.observationDecisionForced, false)
  assert.match(agent.messages.at(-1)?.content ?? '', /partially admitted/i)
  assert.match(agent.messages.at(-1)?.content ?? '', /deferred 1/i)
})

// Plan 2.5: waits from game data.
function machineOutputObservation({ current, satisfied = false, working = true, eta } = {}) {
  return JSON.stringify({
    ok: true,
    kind: 'entity_inventory_count',
    satisfied,
    current,
    minimum: 10,
    unit_number: 582,
    progressing: working,
    progress_known: true,
    entity_status: working ? 1 : 0,
    ...(eta ? { eta } : {}),
  })
}

test('a working machine checkpoint becomes a completion wait instead of a guessed wait', async () => {
  const { agent, memory, mainCalls } = makeAgent()
  memory.planByNpc.get('npc:sgluna').task_board.steps[0].completion_contract = {
    mode: 'all',
    requirements: [{ id: 'plates', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 }],
  }
  agent.recordLiveEntityObservation({
    name: 'stone-furnace',
    type: 'furnace',
    unit_number: 582,
    position: { x: 4, y: 0 },
    working: true,
    status: 1,
  }, { x: 0, y: 0 }, 'getEntityStatus')

  const result = await agent.commitPlan({
    chatMessage: 'The furnace is smelting the plates.',
    plan: ['Smelt required material', 'Craft requested item'],
    currentStep: 1,
    operations: [],
  })

  const wait = memory.planByNpc.get('npc:sgluna').condition_wait
  assert.equal(result.goalStatus, 'active')
  assert.equal(wait?.mode, 'completion')
  assert.deepEqual(wait?.condition, { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 })
  assert.equal(mainCalls(), 0)
})

test('a BLOCKED reply is recorded as a blocker even while the machine works toward the checkpoint', async () => {
  const { agent, memory } = makeAgent()
  const events = []
  const traceEvent = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => { events.push({ event, data }); return traceEvent(event, data) }
  memory.planByNpc.get('npc:sgluna').task_board.steps[0].completion_contract = {
    mode: 'all',
    requirements: [{ id: 'plates', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 }],
  }
  agent.recordLiveEntityObservation({
    name: 'stone-furnace',
    type: 'furnace',
    unit_number: 582,
    position: { x: 4, y: 0 },
    working: true,
    status: 1,
  }, { x: 0, y: 0 }, 'getEntityStatus')

  const result = await agent.commitPlan({
    chatMessage: 'BLOCKED: the plates are needed elsewhere and no other iron ore is reachable.',
    plan: ['Smelt required material', 'Craft requested item'],
    currentStep: 1,
    operations: [],
  })

  // The reply takes the blocker path (outcome authority decides blocked or
  // paused on its evidence); it is never parked as a wait on the furnace.
  const durable = memory.planByNpc.get('npc:sgluna')
  assert.equal(durable.condition_wait, undefined)
  assert.ok(['blocked', 'paused'].includes(result.goalStatus), result.goalStatus)
  assert.equal(durable.status, result.goalStatus)
  assert.ok(events.some(entry => entry.event === 'outcome.candidate' && entry.data.kind === 'world_blocked'))
})

test('the machine expectation sets the wake deadline and is traced once', async () => {
  const { agent, memory, rcon } = makeAgent({ committed: true })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch },
  )
  const events = []
  agent.traceEvent = async (event, data) => { events.push({ event, data }) }

  rcon.pendingCondition = machineOutputObservation({ current: 2, eta: { recipe: 'iron-plate', seconds_per_craft: 3.2, crafts_needed: 8, seconds_to_target: 24.8, seconds_until_idle: 40 } })
  const first = await agent.pollConditionWait()
  assert.equal(first.action, 'waiting')
  const scheduled = memory.planByNpc.get('npc:sgluna').condition_wait
  assert.equal(scheduled.expected_seconds, 24.8)
  assert.ok(scheduled.timeout_ms >= Math.ceil((24.8 * 1.5 + 30) * 1000) && scheduled.timeout_ms < 70_000, String(scheduled.timeout_ms))
  assert.ok(Number.isFinite(scheduled.expected_finish_at))

  rcon.pendingCondition = machineOutputObservation({ current: 5, eta: { seconds_to_target: 16 } })
  await agent.pollConditionWait()
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait.timeout_ms, scheduled.timeout_ms)
  assert.equal(memory.planByNpc.get('npc:sgluna').condition_wait.expected_seconds, 16)
  assert.equal(events.filter(entry => entry.event === 'runtime.condition_scheduled').length, 1)

  // The checkpoint holding closes the step; elapsed time never does.
  rcon.pendingCondition = machineOutputObservation({ current: 10, satisfied: true })
  const verified = await agent.pollConditionWait()
  assert.equal(verified.action, 'verified')
  assert.equal(verified.state.task_board.completed_count, 1)
})

test('an overrun wakes the planner with expected and elapsed seconds, never a completion', async () => {
  const { agent, memory, rcon } = makeAgent()
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch },
  )
  rcon.pendingCondition = machineOutputObservation({ current: 3, eta: { seconds_to_target: 20 } })
  const first = await agent.pollConditionWait()
  assert.equal(first.action, 'waiting')

  // Move the registration back past the derived deadline (20 s x 1.5 + 30 s).
  const wait = memory.planByNpc.get('npc:sgluna').condition_wait
  wait.registered_at -= wait.timeout_ms
  const overrun = await agent.pollConditionWait()
  assert.equal(overrun.action, 'timeout')
  assert.equal(overrun.expected_seconds, 20)
  assert.ok(overrun.elapsed_seconds >= 60, String(overrun.elapsed_seconds))
  assert.equal(memory.planByNpc.get('npc:sgluna').task_board.completed_count, 0)
})

// --- step contracts: the condition-wait close does not go through applyStepClose, so it binds the next contract itself ---

const WAIT_PLATES = { mode: 'all', requirements: [{ id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 }] }
const NEXT_STEP_CONTRACT = { mode: 'all', requirements: [{ id: 'craft', kind: 'inventory_count', item_name: 'copper-plate', minimum: 4 }] }

function committedWithPendingNextStep(options = {}) {
  const made = makeAgent(options)
  const { memory, rcon, agent } = made
  memory.ensurePlanningDraft('npc:sgluna', memory.planByNpc.get('npc:sgluna'), {
    now: 1,
    stepCompletions: [{ kind: 'deterministic', checkpoint: WAIT_PLATES }, { kind: 'deterministic' }],
  })
  memory.commitPlanningPlan('npc:sgluna', { now: 2, runtime_validation: { passed: true } })
  const durable = memory.planByNpc.get('npc:sgluna')
  durable.condition_wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: durable.goal_id, stepId: durable.task_board.active_step_id, actorId: agent.epoch.actor_id, actorEpoch: agent.epoch.epoch, maxChecks: 10 },
  )
  rcon.inventoryCount = 9
  const rows = []
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  return { ...made, rows }
}

const targetStepOf = (messages) => {
  const text = String(messages.find(message => message.role === 'user' && String(message.content).startsWith('[STEP_CONTRACT_REQUEST]')).content)
  return JSON.parse(text.slice(text.indexOf(' {"goal"') + 1)).target.step_id
}

test('step contracts: a satisfied condition wait closes its step and binds the next step\'s contract before the close is credited', async () => {
  const seen = []
  const { agent, memory, rows } = committedWithPendingNextStep({
    provider: async (messages, context) => {
      seen.push(context)
      return { content: JSON.stringify({ stepId: targetStepOf(messages), checkpoint: NEXT_STEP_CONTRACT }) }
    },
  })
  const verified = await agent.pollConditionWait()

  assert.equal(verified.action, 'verified')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].triggerSource, 'step_contract')
  assert.equal(seen[0].allowTools, false)
  const plan = getActivePlan(memory.planningState('npc:sgluna'))
  assert.equal(plan.active_step_index, 1)
  assert.equal(plan.steps[1].contract_status, 'bound')
  assert.equal(plan.steps[1].contract_binding.binding, 'just_in_time')
  assert.equal(verified.state.task_board.steps[1].completion_contract.requirements[0].item_name, 'copper-plate', 'the state the poll returns already carries the bound contract')
  const order = rows.map(row => row.event)
  assert.ok(order.indexOf('plan.contract_bound_just_in_time') < order.indexOf('step.verified'), 'bound before the close is traced as verified')
  const requested = rows.find(row => row.event === 'plan.contract_requested')
  assert.equal(requested.data.trigger, 'condition_wait')
  assert.equal(requested.data.closed_by, 'condition_wait')
  assert.ok(requested.data.request_id)
})

test('step contracts: a condition wait whose next contract cannot be bound still records the close and pauses the goal visibly', async () => {
  const { agent, memory, rows } = committedWithPendingNextStep({ provider: async () => { throw new Error('upstream 503') } })
  const result = await agent.pollConditionWait()

  assert.equal(result.action, 'paused')
  assert.match(result.chat_message, /I could not get a valid completion checkpoint for the next step/)
  const plan = getActivePlan(memory.planningState('npc:sgluna'))
  assert.equal(plan.execution.step_progress[plan.steps[0].step_id].status, 'completed')
  assert.equal(plan.steps[1].contract_status, 'pending')
  assert.equal(memory.planByNpc.get('npc:sgluna').pause_reason, 'step_contract_unavailable')
  assert.equal(rows.filter(row => row.event === 'step.verified').length, 1)
  assert.equal(rows.find(row => row.event === 'plan.contract_call_failed').data.step_id, plan.steps[1].step_id)
})
