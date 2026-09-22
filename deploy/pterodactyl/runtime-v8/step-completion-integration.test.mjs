import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
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

function inventoryContract(minimum = 10) {
  return {
    mode: 'all',
    source: 'main_planner',
    requirements: [{
      id: 'stone_total',
      kind: 'inventory_count',
      item_name: 'stone',
      minimum,
    }],
  }
}

function activeState({ minimum = 10, withContract = true, withVerification = true } = {}) {
  const evidence = withVerification
    ? [{
        id: 'evidence_1',
        kind: 'deterministic_verification',
        ref: 'batch_7',
        summary: JSON.stringify({
          verdict: 'verified_complete',
          operations: ['gather_resource'],
          task_types: ['walking_to_entity', 'mining'],
        }),
        step_id: 'step_1',
        at: Date.now(),
      }]
    : []
  return {
    goal_id: 'goal_completion',
    owner: 'tester',
    objective: 'gather stone and craft furnaces',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Gather enough stone', 'Craft 2 stone furnaces'],
    current_step: 0,
    revision: 2,
    last_chat_message: '',
    last_operations: ['gather_resource {"resource_name":"stone","count":10,"search_radius":64}'],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: withVerification,
    last_verified_batch_id: withVerification ? 7 : undefined,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_completion',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 2,
      event_sequence: 0,
      evidence_sequence: evidence.length,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        {
          id: 'step_1',
          description: 'Gather enough stone',
          status: 'active',
          ...(withContract ? { completion_contract: inventoryContract(minimum) } : {}),
        },
        { id: 'step_2', description: 'Craft 2 stone furnaces', status: 'pending' },
      ],
      evidence,
      events: [],
    },
  }
}

class Rcon {
  constructor(stone = 10) {
    this.stone = stone
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false, healthy: false, controller_live: false })
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify({ task_state: 'idle', queue_length: 0, queue_empty: true })
    if (text.includes('remote.call("autorio_tools","evaluate_condition"')) {
      if (text.includes('invented-item')) return JSON.stringify({ ok: false, error: 'unknown_item', item_name: 'invented-item' })
      return JSON.stringify({
        ok: true,
        kind: 'inventory_count',
        item_name: 'stone',
        current: this.stone,
        minimum: 10,
        satisfied: this.stone >= 10,
        progressing: false,
        progress_known: true,
      })
    }
    return '{}'
  }
}

function agentWithState({
  state = activeState(),
  stone = 10,
  commit = true,
  freshObservation = false,
} = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, state)
  memory.ensurePlanningDraft(key, state, { now: 100, migrated: true })
  if (commit) memory.commitPlanningPlan(key, { now: 110, migrated: true, runtime_validation: { passed: true } })

  const rcon = new Rcon(stone)
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    npcId: 'airi',
    systemPrompt: 'deterministic completion integration',
    provider: async () => { throw new Error('main planner not expected') },
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = key
  agent.requestInfo = { memoryKey: key, turnId: 1, sender: 'tester', text: 'continue' }
  agent.freshObservationSinceContinuation = freshObservation
  return { agent, memory, rcon, key }
}

function receipt() {
  return { view: { last_completed_batch: { batch_id: 7 } } }
}

test('explicit deterministic checkpoint closes only when authoritative world truth satisfies it', async () => {
  const { agent, memory, key } = agentWithState({ stone: 10 })
  const result = await agent.routeStepCompletionDecision(receipt())

  assert.equal(result.verified, true)
  assert.equal(memory.currentPlan(key).task_board.completed_count, 1)
  assert.equal(memory.currentPlan(key).task_board.active_step_id, 'step_2')
  assert.equal(getActivePlan(memory.planningState(key)).active_step_index, 1)
})

test('explicit deterministic checkpoint stays open when authoritative world truth is unmet', async () => {
  const { agent, memory, key } = agentWithState({ stone: 9 })
  const result = await agent.routeStepCompletionDecision(receipt())

  assert.equal(result.verified, false)
  assert.equal(result.reason, 'checkpoint_requirements_unsatisfied')
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
  assert.equal(getActivePlan(memory.planningState(key)).active_step_index, 0)
})

test('an authoritative operation receipt does not invent completion semantics for a prose-only step', async () => {
  const { agent, memory, key } = agentWithState({
    state: activeState({ withContract: false }),
    stone: 10,
  })
  const result = await agent.routeStepCompletionDecision(receipt())

  assert.equal(result.verified, false)
  assert.equal(result.reason, 'semantic_completion_requires_planner')
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.COMMITTED)
})

test('Main LLM can explicitly close a grounded prose-only step', async () => {
  const state = activeState({ withContract: false, withVerification: true })
  const { agent, memory, key } = agentWithState({ state })

  const result = await agent.applySemanticCompletionClaim({
    chatMessage: 'The current semantic outcome is achieved.',
    semanticCompletion: {
      stepId: 'step_1',
      rationale: 'The authoritative receipt and current world evidence are sufficient for this prose-only boundary.',
    },
  }, memory.currentPlan(key))

  assert.equal(result.applied, true)
  assert.equal(memory.currentPlan(key).task_board.completed_count, 1)
  assert.equal(memory.currentPlan(key).task_board.active_step_id, 'step_2')
  assert.equal(getActivePlan(memory.planningState(key)).active_step_index, 1)
})

test('semantic completion cannot bypass an existing deterministic contract', async () => {
  const { agent, memory, key } = agentWithState({ state: activeState({ withContract: true }) })

  await assert.rejects(
    agent.applySemanticCompletionClaim({
      chatMessage: 'Done.',
      semanticCompletion: { stepId: 'step_1', rationale: 'Claimed complete.' },
    }, memory.currentPlan(key)),
    /cannot_bypass_deterministic_contract/,
  )
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
})

test('semantic completion requires exact active step identity', async () => {
  const { agent, memory, key } = agentWithState({ state: activeState({ withContract: false }) })

  await assert.rejects(
    agent.applySemanticCompletionClaim({
      chatMessage: 'Done.',
      semanticCompletion: { stepId: 'step_2', rationale: 'Wrong step.' },
    }, memory.currentPlan(key)),
    /semantic_completion_step_mismatch/,
  )
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
})

test('semantic completion requires authoritative runtime grounding', async () => {
  const state = activeState({ withContract: false, withVerification: false })
  const { agent, memory, key } = agentWithState({ state })

  await assert.rejects(
    agent.applySemanticCompletionClaim({
      chatMessage: 'Done.',
      semanticCompletion: { stepId: 'step_1', rationale: 'Ungrounded claim.' },
    }, memory.currentPlan(key)),
    /requires_runtime_grounding/,
  )
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
})

test('a fresh authoritative observation may ground a prose-only semantic completion', async () => {
  const state = activeState({ withContract: false, withVerification: false })
  const { agent, memory, key } = agentWithState({ state, freshObservation: true })

  const result = await agent.applySemanticCompletionClaim({
    chatMessage: 'Observed and complete.',
    semanticCompletion: { stepId: 'step_1', rationale: 'Fresh world observation establishes the semantic boundary.' },
  }, memory.currentPlan(key))

  assert.equal(result.applied, true)
  assert.equal(memory.currentPlan(key).task_board.completed_count, 1)
})

test('planner-authored checkpoint is grounded and persisted deterministically before commit', async () => {
  const state = activeState({ withContract: false, withVerification: false })
  const { agent, memory, key } = agentWithState({ state, commit: false, stone: 3 })

  const result = await agent.persistPlannerCheckpoint({
    checkpoint: inventoryContract(10),
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 7 } }],
  })

  assert.equal(result.contract.requirements[0].minimum, 10)
  assert.equal(memory.currentPlan(key).task_board.steps[0].completion_contract.requirements[0].minimum, 10)
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.DRAFT)
})

test('unsupported or ungrounded planner checkpoint is rejected without a second AI reviewer', async () => {
  const state = activeState({ withContract: false, withVerification: false })
  const { agent, memory, key } = agentWithState({ state, commit: false })

  await assert.rejects(
    agent.persistPlannerCheckpoint({
      checkpoint: {
        mode: 'all',
        requirements: [{ id: 'invented', kind: 'inventory_count', item_name: 'invented-item', minimum: 1 }],
      },
      operations: [],
    }),
    /deterministic_checkpoint_rejected/,
  )
  assert.equal(memory.currentPlan(key).task_board.steps[0].completion_contract, undefined)
})

test('committed prose-only step cannot acquire a new deterministic meaning after commit', async () => {
  const state = activeState({ withContract: false, withVerification: true })
  const { agent } = agentWithState({ state })

  await assert.rejects(
    agent.persistPlannerCheckpoint({
      checkpoint: inventoryContract(10),
      operations: [],
    }),
    /committed_completion_contract_is_immutable/,
  )
})
