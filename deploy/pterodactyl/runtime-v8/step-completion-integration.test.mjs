import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

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

function activeState({ inventoryMinimum = 10, boundary = 'checkpoint_here', relation = 'advances_current', includeCheckpoint = true } = {}) {
  const evidence = [{
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
  if (includeCheckpoint) {
    evidence.push({
      id: 'evidence_2',
      kind: 'step_checkpoint_contract',
      ref: 'checkpoint/step_1',
      summary: JSON.stringify({
        boundary,
        relation,
        contract: {
          mode: 'all',
          source: 'operation_intent',
          confidence: 0.94,
          requirements: [{
            id: 'intent_1',
            kind: 'inventory_count',
            item_name: 'stone',
            minimum: inventoryMinimum,
          }],
        },
      }),
      step_id: 'step_1',
      at: Date.now(),
    })
  }
  return {
    goal_id: 'goal_completion',
    owner: 'tester',
    objective: 'gather stone and craft furnaces',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Gather 10 stone', 'Craft 2 stone furnaces'],
    current_step: 0,
    revision: 2,
    last_chat_message: '',
    last_operations: ['gather_resource {"resource_name":"stone","count":10,"search_radius":64}'],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 7,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_completion',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 2,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'Gather 10 stone', status: 'active' },
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

function checkpointDecision(choice = 'candidate_1', boundary = 'checkpoint_here', confidence = 0.94, relation = 'advances_current') {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      contract: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { candidate_1: choice === 'candidate_1' ? 0.94 : 0.03, candidate_2: 0.03, semantic_unknown: 0.03 },
      },
      compound_step: { type: 'noul', noul: boundary === 'split_recommended' ? 0.92 : 0.08 },
      step_relation: {
        type: 'choice',
        choice: relation,
        confidence: 0.95,
        probabilities: { advances_current: relation === 'advances_current' ? 0.95 : 0.01, prerequisite_for_current: relation === 'prerequisite_for_current' ? 0.95 : 0.01, belongs_to_later_step: relation === 'belongs_to_later_step' ? 0.95 : 0.01, replan_needed: relation === 'replan_needed' ? 0.95 : 0.01, unrelated: relation === 'unrelated' ? 0.95 : 0.01 },
      },
      checkpoint_boundary: {
        type: 'choice',
        choice: boundary,
        confidence: 0.93,
        probabilities: { checkpoint_here: 0.9, keep_step_open: 0.05, split_recommended: 0.05 },
      },
    },
    usage: { input_tokens: 70, output_tokens: 8, cost: 0.000003 },
  }
}

function agentWithState({ state = activeState(), stone = 10, decisionProvider = async () => checkpointDecision() } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', state)
  const agent = new NpcAgentLoop({
    rcon: new Rcon(stone),
    memory,
    npcId: 'airi',
    systemPrompt: 'checkpoint integration',
    provider: async () => { throw new Error('main planner not expected') },
    interactionDecisionProvider: decisionProvider,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:airi'
  agent.requestInfo = { memoryKey: 'npc:airi', turnId: 1, sender: 'tester', text: 'continue' }
  return { agent, memory }
}

test('quantity operation without an explicit semantic checkpoint fails closed before completion', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  let calls = 0
  const { agent, memory } = agentWithState({
    state,
    decisionProvider: async (decisionState, questions) => {
      calls++
      assert.equal(decisionState.contract, 'step_checkpoint_normalizer')
      assert.equal(decisionState.proposed_operations[0].name, 'gather_resource')
      assert.equal(decisionState.proposed_checkpoint, undefined)
      assert.equal(questions.contract.criteria.candidate_1, undefined)
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          contract: {
            type: 'choice',
            choice: 'semantic_unknown',
            confidence: 0.96,
            probabilities: { semantic_unknown: 0.96, runtime_supported_unknown: 0.04 },
          },
          compound_step: { type: 'noul', noul: 0.1 },
          step_relation: {
            type: 'choice',
            choice: 'advances_current',
            confidence: 0.95,
            probabilities: { advances_current: 0.95, prerequisite_for_current: 0.01, belongs_to_later_step: 0.01, replan_needed: 0.02, unrelated: 0.01 },
          },
          checkpoint_boundary: {
            type: 'choice',
            choice: 'checkpoint_here',
            confidence: 0.9,
            probabilities: { checkpoint_here: 0.9, keep_step_open: 0.05, split_recommended: 0.05 },
          },
        },
      }
    },
  })

  const result = await agent.routeStepCheckpointDecision({
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 10, search_radius: 64 } }],
  })

  assert.equal(calls, 1)
  assert.equal(result.boundary, 'keep_step_open')
  assert.equal(result.contract.mode, 'semantic_unknown')
  const checkpoint = memory.planByNpc.get('npc:airi').task_board.evidence.find(item => item.kind === 'step_checkpoint_contract')
  assert.ok(checkpoint)
  const summary = JSON.parse(checkpoint.summary)
  assert.equal(summary.contract.mode, 'semantic_unknown')
  assert.equal(summary.boundary, 'keep_step_open')
})

test('Jev flags a later-step batch before admission while allowing a current-step prerequisite', async () => {
  const driftState = activeState({ includeCheckpoint: false })
  driftState.task_board.evidence = []
  const { agent: driftAgent, memory: driftMemory } = agentWithState({
    state: driftState,
    decisionProvider: async () => checkpointDecision('candidate_1', 'keep_step_open', 0.94, 'belongs_to_later_step'),
  })
  const drift = await driftAgent.routeStepCheckpointDecision({
    checkpoint: {
      mode: 'all',
      source: 'planner_semantic_checkpoint',
      requirements: [{ id: 'furnaces_total', kind: 'inventory_count', item_name: 'stone-furnace', minimum: 2 }],
    },
    operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 2 } }],
  })
  assert.equal(drift.relation, 'belongs_to_later_step')
  assert.equal(drift.boundary, 'keep_step_open')
  const driftCheckpoint = driftMemory.planByNpc.get('npc:airi').task_board.evidence.find(item => item.kind === 'step_checkpoint_contract')
  assert.equal(JSON.parse(driftCheckpoint.summary).relation, 'belongs_to_later_step')

  const prereqState = activeState({ includeCheckpoint: false })
  prereqState.task_board.evidence = []
  const { agent: prereqAgent } = agentWithState({
    state: prereqState,
    decisionProvider: async () => checkpointDecision('candidate_1', 'keep_step_open', 0.94, 'prerequisite_for_current'),
  })
  const prereq = await prereqAgent.routeStepCheckpointDecision({
    checkpoint: {
      mode: 'all',
      source: 'planner_semantic_checkpoint',
      requirements: [{ id: 'furnace_total', kind: 'inventory_count', item_name: 'stone-furnace', minimum: 1 }],
    },
    operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
  })
  assert.equal(prereq.relation, 'prerequisite_for_current')
  assert.equal(prereq.boundary, 'keep_step_open')
})

test('compound Jev assessment cannot accept a one-requirement checkpoint as step completion', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  const { agent, memory } = agentWithState({
    state,
    decisionProvider: async () => ({
      ...checkpointDecision('candidate_1', 'checkpoint_here'),
      answers: {
        ...checkpointDecision('candidate_1', 'checkpoint_here').answers,
        compound_step: { type: 'noul', noul: 0.92 },
      },
    }),
  })

  const result = await agent.routeStepCheckpointDecision({
    checkpoint: {
      mode: 'all',
      source: 'planner_semantic_checkpoint',
      requirements: [{ id: 'stone_total', kind: 'inventory_count', item_name: 'stone', minimum: 10 }],
    },
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 10, search_radius: 64 } }],
  })

  assert.equal(result.boundary, 'split_recommended')
  const checkpoint = memory.planByNpc.get('npc:airi').task_board.evidence.find(item => item.kind === 'step_checkpoint_contract')
  assert.equal(JSON.parse(checkpoint.summary).boundary, 'split_recommended')
})

test('completion uses the pre-admission checkpoint and does not ask Jev to reinterpret low-level task names', async () => {
  let completionJevCalls = 0
  const { agent } = agentWithState({
    decisionProvider: async () => {
      completionJevCalls++
      throw new Error('completion must not call Jev')
    },
  })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })

  assert.equal(completionJevCalls, 0)
  assert.equal(result.verified, true)
  assert.equal(result.state.task_board.completed_count, 1)
  assert.equal(result.state.task_board.active_index, 1)
  assert.equal(result.state.task_board.steps[0].status, 'completed')
  assert.equal(result.state.task_board.steps[1].status, 'active')
})

test('checkpoint remains open when deterministic inventory truth does not satisfy the semantic threshold', async () => {
  const { agent, memory } = agentWithState({ stone: 9 })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'checkpoint_requirements_unsatisfied')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 0)
  assert.equal(memory.planByNpc.get('npc:airi').task_board.active_index, 0)
})

test('Jev may deliberately keep a compound semantic step open after a useful batch', async () => {
  const { agent, memory } = agentWithState({ state: activeState({ boundary: 'keep_step_open' }) })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'checkpoint_kept_open')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.active_index, 0)
})

test('Jev may normalize a correlated authoritative receipt into a completion contract without owning world truth', async () => {
  const state = activeState({ boundary: 'keep_step_open' })
  state.task_board.evidence[1].summary = JSON.stringify({
    boundary: 'keep_step_open',
    relation: 'advances_current',
    contract: { mode: 'semantic_unknown', requirements: [], confidence: 0.2 },
  })
  const { agent, memory } = agentWithState({
    state,
    decisionProvider: async (decisionState, questions) => {
      assert.equal(decisionState.contract, 'receipt_completion_normalizer')
      assert.equal(decisionState.active_step.description, 'Gather 10 stone')
      assert.deepEqual(decisionState.authoritative_receipt.operation_names, ['gather_resource'])
      assert.ok(questions.receipt_scope.criteria.complete_current_step)
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          receipt_scope: {
            type: 'choice',
            choice: 'complete_current_step',
            confidence: 0.93,
            probabilities: { complete_current_step: 0.93, progress_only: 0.05, semantic_unknown: 0.02 },
          },
        },
      }
    },
  })

  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, true)
  assert.equal(result.contract.source, 'jev_receipt_scope')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.steps[0].status, 'completed')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.active_index, 1)
})

test('receipt completion normalization fails closed on low confidence, progress-only, or Jev outage', async () => {
  for (const decisionProvider of [
    async () => ({ answers: { receipt_scope: { choice: 'complete_current_step', confidence: 0.84 } } }),
    async () => ({ answers: { receipt_scope: { choice: 'progress_only', confidence: 0.99 } } }),
    async () => { throw new Error('temporary Jev outage') },
  ]) {
    const { agent, memory } = agentWithState({
      state: activeState({ boundary: 'keep_step_open' }),
      decisionProvider,
    })
    const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
    assert.equal(result.verified, false)
    assert.equal(result.reason, 'checkpoint_kept_open')
    assert.equal(memory.planByNpc.get('npc:airi').task_board.active_index, 0)
  }
})

test('receipt completion normalization never runs without same-step deterministic verification', async () => {
  const state = activeState({ boundary: 'keep_step_open' })
  state.task_board.evidence[0].step_id = 'step_2'
  let calls = 0
  const { agent } = agentWithState({
    state,
    decisionProvider: async () => { calls++; throw new Error('must not run') },
  })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'no_authoritative_operation_receipt')
  assert.equal(calls, 0)
})

test('Jev split recommendation cannot itself advance canonical state', async () => {
  const { agent, memory } = agentWithState({ state: activeState({ boundary: 'split_recommended' }) })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'checkpoint_split_recommended')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 0)
})


test('post-step Jev exposes reanchor_plan as a first-class lightweight route', async () => {
  const state = activeState({ boundary: 'keep_step_open', relation: 'belongs_to_later_step' })
  const { agent } = agentWithState({
    state,
    decisionProvider: async (decisionState, questions) => {
      assert.equal(decisionState.semantic_alignment.step_relation, 'belongs_to_later_step')
      assert.equal(decisionState.semantic_alignment.admission_aligned, false)
      assert.ok(questions.route.criteria.reanchor_plan)
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          route: {
            type: 'choice',
            choice: 'reanchor_plan',
            confidence: 0.93,
            probabilities: { reanchor_plan: 0.93, replan: 0.04, continue_current: 0.03 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5, cost: 0.000002 },
      }
    },
  })

  const result = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0, queue_empty: true } })
  assert.equal(result.route, 'reanchor_plan')
  assert.equal(result.requested_route, 'reanchor_plan')
})

test('semantic drift cannot be downgraded to continue_current by post-step routing', async () => {
  const state = activeState({ boundary: 'keep_step_open', relation: 'belongs_to_later_step' })
  const { agent } = agentWithState({
    state,
    decisionProvider: async () => ({
      model: 'jev-latest',
      provider: 'TypeSafe',
      answers: {
        route: {
          type: 'choice',
          choice: 'continue_current',
          confidence: 0.7,
          probabilities: { continue_current: 0.7, reanchor_plan: 0.25, replan: 0.05 },
        },
      },
      usage: { input_tokens: 50, output_tokens: 5, cost: 0.000002 },
    }),
  })

  const result = await agent.routePostStepDecision({ view: { task_state: 'idle', queue_length: 0, queue_empty: true } })
  assert.equal(result.requested_route, 'continue_current')
  assert.equal(result.route, 'reanchor_plan')
  assert.equal(result.fallback_reason, 'semantic_alignment_requires_reanchor')
})

test('missing pre-admission checkpoint fails closed even with an authoritative batch receipt', async () => {
  const { agent, memory } = agentWithState({ state: activeState({ includeCheckpoint: false }) })
  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'missing_pre_admission_checkpoint')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 0)
})


test('Jev can select a semantic total checkpoint that differs from the next operation amount', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.objective = 'Ensure I have at least 100 stone before building furnaces'
  state.plan = ['Ensure I have at least 100 stone', 'Craft stone furnaces']
  state.task_board.steps[0].description = 'Ensure I have at least 100 stone'
  state.task_board.steps[1].description = 'Craft stone furnaces'
  state.task_board.evidence = []

  const { agent, memory } = agentWithState({
    state,
    stone: 102,
    decisionProvider: async (decisionState, questions) => {
      assert.equal(decisionState.proposed_checkpoint.requirements[0].minimum, 100)
      assert.match(questions.contract.criteria.candidate_1, /"minimum":100/)
      assert.equal(questions.contract.criteria.candidate_2, undefined)
      return checkpointDecision('candidate_1', 'checkpoint_here', 0.96, 'advances_current')
    },
  })

  const checkpoint = {
    mode: 'all',
    source: 'planner_semantic_checkpoint',
    requirements: [{
      id: 'stone_total',
      kind: 'inventory_count',
      item_name: 'stone',
      minimum: 100,
    }],
  }
  const result = await agent.routeStepCheckpointDecision({
    checkpoint,
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 40, search_radius: 512 } }],
  })

  assert.equal(result.boundary, 'checkpoint_here')
  assert.equal(result.contract.source, 'planner_semantic_checkpoint')
  assert.equal(result.contract.requirements[0].minimum, 100)

  const stored = memory.planByNpc.get('npc:airi').task_board.evidence.find(item => item.kind === 'step_checkpoint_contract')
  const summary = JSON.parse(stored.summary)
  assert.equal(summary.contract.requirements[0].minimum, 100)
})


test('checkpoint routing outage keeps useful admission open while withholding completion authority', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  const { agent } = agentWithState({ state, decisionProvider: null })

  const result = await agent.routeStepCheckpointDecision({
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 10, search_radius: 64 } }],
  })

  assert.equal(result.relation, 'advances_current')
  assert.equal(result.boundary, 'keep_step_open')
  assert.equal(result.contract.mode, 'semantic_unknown')
  assert.equal(result.reason, 'decision_provider_unavailable')
})

test('checkpoint decision failure does not masquerade as semantic drift', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  const { agent } = agentWithState({
    state,
    decisionProvider: async () => { throw new Error('jev temporarily unavailable') },
  })

  const result = await agent.routeStepCheckpointDecision({
    operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
  })

  assert.equal(result.relation, 'advances_current')
  assert.equal(result.boundary, 'keep_step_open')
  assert.equal(result.contract.mode, 'semantic_unknown')
  assert.equal(result.reason, 'checkpoint_decision_failed')
})


test('durable step completion contract survives without checkpoint evidence and remains completion authority', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = state.task_board.evidence.filter(item => item.kind === 'deterministic_verification')
  state.task_board.steps[0].completion_contract = {
    mode: 'all',
    source: 'planner_semantic_checkpoint',
    confidence: 0.96,
    requirements: [{
      id: 'stone_total',
      kind: 'inventory_count',
      item_name: 'stone',
      minimum: 10,
    }],
  }
  state.task_board.steps[0].completion_contract_at = Date.now()

  let completionJevCalls = 0
  const { agent } = agentWithState({
    state,
    stone: 10,
    decisionProvider: async () => {
      completionJevCalls++
      throw new Error('durable completion verification must not call Jev')
    },
  })

  const result = await agent.routeStepCompletionDecision({ view: { last_completed_batch: { batch_id: 7 } } })
  assert.equal(completionJevCalls, 0)
  assert.equal(result.verified, true)
  assert.equal(result.state.task_board.active_index, 1)
})

test('durable completion contract does not bypass semantic alignment for a later operation batch', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  state.task_board.steps[0].completion_contract = {
    mode: 'all',
    source: 'planner_semantic_checkpoint',
    confidence: 0.96,
    requirements: [{
      id: 'stone_total',
      kind: 'inventory_count',
      item_name: 'stone',
      minimum: 10,
    }],
  }
  state.task_board.steps[0].completion_contract_at = Date.now()

  let calls = 0
  const { agent } = agentWithState({
    state,
    decisionProvider: async (decisionState, questions) => {
      calls++
      assert.equal(decisionState.durable_completion_contract.requirements[0].item_name, 'stone')
      assert.ok(questions.step_relation)
      return checkpointDecision('candidate_1', 'keep_step_open', 0.96, 'belongs_to_later_step')
    },
  })

  const result = await agent.routeStepCheckpointDecision({
    operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
  })
  assert.equal(calls, 1)
  assert.equal(result.relation, 'belongs_to_later_step')
  assert.equal(result.boundary, 'keep_step_open')
})

test('approved planner semantic checkpoint is attached to the active Task Board step', async () => {
  const state = activeState({ includeCheckpoint: false })
  state.task_board.evidence = []
  const { agent, memory } = agentWithState({
    state,
    decisionProvider: async () => checkpointDecision('candidate_1', 'checkpoint_here', 0.96, 'advances_current'),
  })

  const result = await agent.routeStepCheckpointDecision({
    checkpoint: {
      mode: 'all',
      source: 'planner_semantic_checkpoint',
      requirements: [{ id: 'stone_total', kind: 'inventory_count', item_name: 'stone', minimum: 100 }],
    },
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 40, search_radius: 64 } }],
  })

  assert.equal(result.boundary, 'checkpoint_here')
  const durable = memory.planByNpc.get('npc:airi').task_board.steps[0].completion_contract
  assert.equal(durable.source, 'planner_semantic_checkpoint')
  assert.equal(durable.requirements[0].minimum, 100)
})
