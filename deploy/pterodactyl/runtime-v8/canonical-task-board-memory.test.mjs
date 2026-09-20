import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalContinuationPlan, CanonicalTaskBoardMemory, verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'
import { createTaskBoard, reconcileTaskBoard } from './common.mjs'

function board() {
  return {
    kind: 'task_board_lite',
    goal_id: 'goal_1',
    status: 'active',
    blocker: '',
    pause_reason: '',
    revision: 3,
    event_sequence: 0,
    evidence_sequence: 0,
    active_index: 2,
    active_step_id: 'step_3',
    completed_count: 2,
    total_steps: 5,
    steps: [
      { id: 'step_1', description: 'Find stone', status: 'completed' },
      { id: 'step_2', description: 'Mine stone', status: 'completed' },
      { id: 'step_3', description: 'Craft furnace', status: 'active' },
      { id: 'step_4', description: 'Build power', status: 'pending' },
      { id: 'step_5', description: 'Start research', status: 'pending' },
    ],
    evidence: [],
    events: [],
    created_at: 1,
    updated_at: 1,
  }
}

function planState(overrides = {}) {
  const taskBoard = overrides.task_board ?? board()
  return {
    goal_id: 'goal_1',
    owner: 'Louis',
    objective: 'Build early automation',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: taskBoard.steps.map(step => step.description),
    current_step: taskBoard.active_index,
    revision: 3,
    last_chat_message: 'Working',
    last_operations: ['craft_item {"item_name":"stone-furnace","count":1}'],
    updated_at: 1,
    history: [],
    task_board: taskBoard,
    ...overrides,
  }
}

function completedReceipt({ batchId = 7, taskTypes = ['crafting'], taskCount = taskTypes.length, basicOperation } = {}) {
  return {
    kind: 'operation_receipt',
    ref: `batch_${batchId}`,
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: batchId,
      task_count: taskCount,
      task_types: taskTypes,
      tick: 200,
      basic_operation: basicOperation,
    }),
  }
}

test('ordinary continuation cannot shrink a canonical five-step board to three steps', () => {
  const guarded = canonicalContinuationPlan(board(), {
    chatMessage: 'Still on the furnace step',
    plan: ['Find stone', 'Mine stone', 'Craft furnace'],
    currentStep: 2,
    operations: [{ name: 'wait', args: { ticks: 60 } }],
  })

  assert.equal(guarded.plan.length, 5)
  assert.equal(guarded.currentStep, 2)
  assert.deepEqual(guarded.plan, board().steps.map(step => step.description))
})

test('ordinary provider continuation preserves proposed focus without completion authority', () => {
  const guarded = canonicalContinuationPlan(board(), {
    plan: ['Mine stone', 'Build power'],
    currentStep: 1,
  })
  assert.equal(guarded.plan.length, 5)
  assert.equal(guarded.currentStep, 3)
})

test('initial planner currentStep is proposed focus only and cannot create a completed prefix', () => {
  const initial = createTaskBoard(['Gather ore', 'Smelt plates', 'Craft machine'], 2, { goalId: 'goal_focus', now: 1 })
  assert.equal(initial.active_index, 0)
  assert.equal(initial.completed_count, 0)
  assert.equal(initial.steps[0].status, 'active')
  assert.equal(initial.steps[1].status, 'pending')
  assert.equal(initial.steps[2].status, 'pending')
  assert.equal(initial.proposed_focus_index, 2)
  assert.equal(initial.proposed_focus_step_id, 'step_3')
})

test('reconcileTaskBoard records later focus without advancing verified progress', () => {
  const initial = createTaskBoard(['Gather ore', 'Smelt plates', 'Craft machine'], 0, { goalId: 'goal_focus', now: 1 })
  const proposed = reconcileTaskBoard(initial, ['Gather ore', 'Smelt plates', 'Craft machine'], 2, { now: 2 })
  assert.equal(proposed.active_index, 0)
  assert.equal(proposed.completed_count, 0)
  assert.equal(proposed.proposed_focus_index, 2)
  assert.equal(proposed.steps[0].status, 'active')
  assert.equal(proposed.steps[1].status, 'pending')
})

test('explicit failure replan is still allowed to replace the remaining suffix', () => {
  const proposal = {
    plan: ['Find stone', 'Mine stone', 'Recover alternate route', 'Build power'],
    currentStep: 2,
  }
  assert.equal(canonicalContinuationPlan(board(), proposal, { allowReplan: true }), proposal)
})

test('provider currentStep may propose later focus but cannot grant transfer completion authority', () => {
  const transferState = planState({
    last_operations: ['move_items_exact {"item_name":"iron-ore","unit_number":582,"max_count":20,"to_entity":true}'],
    last_mutation_verified: false,
  })
  const guarded = canonicalContinuationPlan(board(), {
    plan: board().steps.map(step => step.description),
    currentStep: 3,
    operations: [],
  }, { previousState: transferState })

  assert.equal(guarded.currentStep, 3)
  assert.deepEqual(guarded.plan, board().steps.map(step => step.description))
  assert.equal(transferState.task_board.active_index, 2)
  assert.equal(transferState.task_board.completed_count, 2)
  assert.equal(transferState.last_mutation_verified, false)
})

test('strict completed operation receipts are eligible for deterministic verification', () => {
  const verified = verifyDeterministicReceipt(planState(), completedReceipt())
  assert.deepEqual(verified, {
    verified: true,
    batchId: 7,
    taskTypes: ['crafting'],
    operationNames: ['craft_item'],
  })
})

test('successful entity transfers require a real positive-effect moving-items receipt', () => {
  const state = planState({
    last_operations: ['move_items_exact {"item_name":"coal","unit_number":99,"max_count":10,"to_entity":true}'],
  })
  const verified = verifyDeterministicReceipt(state, completedReceipt({
    taskTypes: ['moving_items'],
    basicOperation: {
      type: 'moving_items',
      accepted: true,
      completed: true,
      code: 'completed',
      item_name: 'coal',
      requested_count: 10,
      moved_count: 10,
      target_unit_number: 99,
      to_entity: true,
    },
  }))
  assert.equal(verified.verified, true)

  for (const basicOperation of [
    { type: 'moving_items', accepted: true, completed: true, code: 'completed', moved_count: 0, target_unit_number: 99, to_entity: true },
    { type: 'moving_items', accepted: false, completed: false, code: 'nothing_moved', moved_count: 0, target_unit_number: 99, to_entity: true },
  ]) {
    const rejected = verifyDeterministicReceipt(state, completedReceipt({ taskTypes: ['moving_items'], basicOperation }))
    assert.deepEqual(rejected, { verified: false, reason: 'transfer_effect_not_verified' })
  }
})

test('multi-item supply_entity verifies only when the whole moving-items batch completes with positive effect', () => {
  const state = planState({
    last_operations: ['supply_entity {"unit_number":582,"items":[{"item_name":"iron-ore","count":20},{"item_name":"coal","count":5}]}'],
  })
  const result = verifyDeterministicReceipt(state, completedReceipt({
    taskTypes: ['moving_items', 'moving_items'],
    taskCount: 2,
    basicOperation: {
      type: 'moving_items',
      accepted: true,
      completed: true,
      code: 'completed',
      item_name: 'coal',
      requested_count: 5,
      moved_count: 5,
      target_unit_number: 582,
      to_entity: true,
    },
  }))
  assert.equal(result.verified, true)
})

test('research and wait still require additional verification', () => {
  for (const [operation, taskType] of [
    ['research_technology {"technology_name":"automation"}', 'researching'],
    ['wait {"ticks":120}', 'waiting'],
  ]) {
    const state = planState({ last_operations: [operation] })
    const result = verifyDeterministicReceipt(state, completedReceipt({ taskTypes: [taskType] }))
    assert.equal(result.verified, false)
    assert.match(result.reason, /^operation_requires_additional_verification:/)
  }
})

test('receipt task types must match the submitted strict operations exactly', () => {
  const result = verifyDeterministicReceipt(planState(), completedReceipt({ taskTypes: ['mining'] }))
  assert.deepEqual(result, { verified: false, reason: 'receipt_operation_mismatch' })
})

test('receipt correlation must belong to the currently active goal and canonical step', () => {
  const state = planState()
  for (const correlation of [
    { goal_id: 'older_goal', step_id: 'step_3' },
    { goal_id: 'goal_1', step_id: 'step_2' },
  ]) {
    const evidence = completedReceipt()
    const summary = JSON.parse(evidence.summary)
    evidence.summary = JSON.stringify({ ...summary, correlation })
    const result = verifyDeterministicReceipt(state, evidence)
    assert.equal(result.verified, false)
    assert.match(result.reason, /^receipt_(goal|step)_mismatch$/)
  }
})

test('verified mutation receipt records proof without advancing semantic canonical progress', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())

  const nextBoard = memory.recordBoardEvidence('npc:airi', completedReceipt())
  const state = memory.currentPlan('npc:airi')

  assert.equal(nextBoard.active_index, 2)
  assert.equal(nextBoard.active_step_id, 'step_3')
  assert.equal(nextBoard.completed_count, 2)
  assert.equal(state.current_step, 2)
  assert.equal(state.plan.length, 5)
  assert.equal(state.status, 'active')
  assert.equal(state.last_mutation_verified, true)
  const proof = nextBoard.evidence.find(item => item.kind === 'deterministic_verification')
  assert.equal(proof.ref, 'batch_7')
  assert.equal(proof.step_id, 'step_3')
})

test('positive transfer receipt marks the mutation verified without completing the semantic step', () => {
  const transferBoard = board()
  transferBoard.steps[2] = { ...transferBoard.steps[2], description: 'Load furnace' }
  const state = planState({
    task_board: transferBoard,
    plan: transferBoard.steps.map(step => step.description),
    last_operations: ['move_items_exact {"item_name":"iron-ore","unit_number":582,"max_count":20,"to_entity":true}'],
    last_mutation_verified: false,
  })
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', state)

  const nextBoard = memory.recordBoardEvidence('npc:airi', completedReceipt({
    taskTypes: ['moving_items'],
    basicOperation: {
      type: 'moving_items',
      accepted: true,
      completed: true,
      code: 'completed',
      item_name: 'iron-ore',
      requested_count: 20,
      moved_count: 20,
      target_unit_number: 582,
      to_entity: true,
    },
  }))
  const nextState = memory.currentPlan('npc:airi')

  assert.equal(nextBoard.active_index, 2)
  assert.equal(nextBoard.completed_count, 2)
  assert.equal(nextBoard.active_step_id, 'step_3')
  assert.equal(nextState.last_mutation_verified, true)
  assert.equal(nextState.last_verified_batch_id, 7)
  assert.equal(nextBoard.evidence.some(item => item.kind === 'deterministic_verification' && item.ref === 'batch_7' && item.step_id === 'step_3'), true)
})

test('failed or zero-effect transfer receipt blocks the active step without completing it', () => {
  const transferBoard = board()
  transferBoard.steps[2] = { ...transferBoard.steps[2], description: 'Load furnace' }
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    task_board: transferBoard,
    plan: transferBoard.steps.map(step => step.description),
    last_operations: ['move_items_exact {"item_name":"iron-ore","unit_number":582,"max_count":20,"to_entity":true}'],
    last_mutation_verified: false,
  }))

  const blocked = memory.recordBoardEvidence('npc:airi', {
    kind: 'operation_error_receipt',
    ref: 'batch_7',
    summary: JSON.stringify({
      outcome: 'failed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 7,
      task_count: 1,
      task_types: ['moving_items'],
      basic_operation: {
        type: 'moving_items',
        accepted: false,
        completed: false,
        code: 'nothing_moved',
        moved_count: 0,
        target_unit_number: 582,
        to_entity: true,
      },
    }),
  })
  const state = memory.currentPlan('npc:airi')

  assert.equal(blocked.active_index, 2)
  assert.equal(blocked.completed_count, 2)
  assert.equal(blocked.steps[2].status, 'blocked')
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'transfer_failed:nothing_moved')
  assert.equal(state.last_mutation_verified, false)
})

test('duplicate completed receipt records one deterministic proof but cannot advance semantic progress', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())

  memory.recordBoardEvidence('npc:airi', completedReceipt())
  memory.recordBoardEvidence('npc:airi', completedReceipt())

  const state = memory.currentPlan('npc:airi')
  assert.equal(state.task_board.active_index, 2)
  assert.equal(state.task_board.completed_count, 2)
  assert.equal(state.current_step, 2)
  assert.equal(state.task_board.evidence.filter(item => item.kind === 'deterministic_verification' && item.ref === 'batch_7').length, 1)
})

test('verified final operation receipt does not close the semantic goal by itself', () => {
  const finalBoard = board()
  finalBoard.active_index = 4
  finalBoard.active_step_id = 'step_5'
  finalBoard.completed_count = 4
  finalBoard.steps = finalBoard.steps.map((step, index) => ({ ...step, status: index < 4 ? 'completed' : 'active' }))
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    task_board: finalBoard,
    current_step: 4,
    last_operations: ['clear_enemy_area {"search_radius":96}'],
  }))

  const nextBoard = memory.recordBoardEvidence('npc:airi', completedReceipt({ taskTypes: ['attacking'] }))
  const stored = memory.planByNpc.get('npc:airi')

  assert.equal(nextBoard.active_index, 4)
  assert.equal(nextBoard.status, 'active')
  assert.equal(stored.status, 'active')
  assert.equal(nextBoard.evidence.some(item => item.kind === 'deterministic_verification' && item.ref === 'batch_7'), true)
})

test('completed durable goals are retired from the current task slot', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    status: 'completed',
    plan: [],
    current_step: 0,
    task_board: { ...board(), status: 'completed' },
  }))

  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(memory.planByNpc.has('npc:airi'), false)
  assert.match(memory.planContext('npc:airi'), /No active durable goal/)
})

test('whole-goal completion returns the final completed receipt but retires it before the next UI sync', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState())
  const completion = {
    chatMessage: 'The requested goal is verified complete.',
    plan: [],
    currentStep: 0,
    operations: [],
  }

  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, completion, {
    continuation: true,
    verifiedCompletion: true,
    completionEvidence: [{ kind: 'deterministic_verification', ref: 'batch_final', summary: '{"verdict":"verified_complete"}' }],
  })
  const reconciled = memory.reconcileTaskBoard(key, board(), completion, recorded)

  assert.equal(reconciled.state.status, 'completed')
  assert.equal(reconciled.state.task_board.status, 'completed')
  assert.equal(memory.currentPlan(key), undefined)
  assert.equal(memory.planByNpc.has(key), false)
})

test('a new actionable request after an old completed goal gets a fresh goal identity and objective', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({
    goal_id: 'goal_old',
    objective: 'Smelt ten iron plates',
    status: 'completed',
    plan: [],
    current_step: 0,
    task_board: { ...board(), goal_id: 'goal_old', status: 'completed' },
  }))

  const next = memory.recordPlan(key, { sender: 'Louis', text: 'Build a sustained iron plate line' }, {
    chatMessage: 'Starting a new production goal.',
    plan: ['Inspect resources', 'Build sustained production'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  assert.equal(next.state.status, 'active')
  assert.notEqual(next.state.goal_id, 'goal_old')
  assert.equal(next.state.objective, 'Build a sustained iron plate line')
})

test('an unfinished durable goal still keeps its identity when a new prompt steers it', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({ goal_id: 'goal_active', objective: 'Build early automation' }))

  const steered = memory.recordPlan(key, { sender: 'Louis', text: 'Move the furnace east instead' }, {
    chatMessage: 'Adjusting the active plan.',
    plan: ['Find stone', 'Mine stone', 'Craft furnace', 'Build power', 'Start research'],
    currentStep: 2,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  assert.equal(steered.state.goal_id, 'goal_active')
  assert.equal(steered.state.objective, 'Build early automation')
})

test('terminatePlan removes one durable goal without implying completion', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', {
    goal_id: 'goal_1',
    status: 'active',
    plan: ['Build boiler'],
    current_step: 0,
    revision: 1,
    history: [],
  })
  const previous = memory.terminatePlan('npc:airi')
  assert.equal(previous.goal_id, 'goal_1')
  assert.equal(memory.planByNpc.has('npc:airi'), false)
  assert.equal(memory.currentPlan('npc:airi'), undefined)
})


test('completed prefix stays completed when a later placement recovery blocks', () => {
  const placementBoard = {
    ...board(),
    active_index: 1,
    active_step_id: 'step_2',
    completed_count: 1,
    total_steps: 3,
    steps: [
      { id: 'step_1', description: 'Craft chest', status: 'completed' },
      { id: 'step_2', description: 'Choose placement', status: 'active' },
      { id: 'step_3', description: 'Place chest', status: 'pending' },
    ],
  }
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({
    task_board: placementBoard,
    plan: placementBoard.steps.map(step => step.description),
    current_step: 1,
    last_operations: ['craft_item {"item_name":"wooden-chest","count":1}'],
    last_mutation_verified: true,
    last_verified_batch_id: 3,
  }))

  const blockedPlan = {
    chatMessage: 'Placement geometry is still unresolved.',
    plan: placementBoard.steps.map(step => step.description),
    currentStep: 1,
    operations: [],
  }
  const previous = memory.currentPlan(key)
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Place a chest nearby' }, blockedPlan, { continuation: true })
  const reconciled = memory.reconcileTaskBoard(key, placementBoard, blockedPlan, recorded, { previousState: previous })

  assert.equal(reconciled.state.status, 'active')
  assert.equal(reconciled.state.task_board.completed_count, 1)
  assert.equal(reconciled.state.task_board.active_index, 1)
  assert.equal(reconciled.state.task_board.steps[0].status, 'completed')
  assert.equal(reconciled.state.task_board.steps[1].status, 'active')
  assert.equal(reconciled.state.task_board.steps[2].status, 'pending')
})


test('provider currentStep proposal alone cannot increase canonical completed_count', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  const initial = board()
  initial.active_index = 1
  initial.active_step_id = 'step_2'
  initial.completed_count = 1
  initial.steps = initial.steps.map((step, index) => ({ ...step, status: index < 1 ? 'completed' : index === 1 ? 'active' : 'pending' }))
  memory.planByNpc.set(key, planState({
    task_board: initial,
    plan: initial.steps.map(step => step.description),
    current_step: 1,
    last_mutation_verified: true,
  }))
  const proposal = {
    chatMessage: 'I think later steps are done.',
    plan: initial.steps.map(step => step.description),
    currentStep: 4,
    operations: [],
  }
  const previous = memory.currentPlan(key)
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'continue' }, proposal, { continuation: true })
  const reconciled = memory.reconcileTaskBoard(key, initial, proposal, recorded, { previousState: previous })
  assert.equal(reconciled.state.task_board.active_index, 1)
  assert.equal(reconciled.state.task_board.completed_count, 1)
  assert.equal(reconciled.state.task_board.proposed_focus_index, 4)
})


test('replan keeps every unverified remaining step even when proposed currentStep points later', () => {
  const initial = createTaskBoard(['Gather ore', 'Smelt plates', 'Craft machine'], 0, { goalId: 'goal_replan', now: 1 })
  const replanned = reconcileTaskBoard(
    initial,
    ['Gather ore', 'Prepare fuel', 'Smelt plates', 'Craft machine'],
    2,
    { now: 2, allowReplan: true },
  )

  assert.equal(replanned.active_index, 0)
  assert.equal(replanned.completed_count, 0)
  assert.deepEqual(
    replanned.steps.map(step => step.description),
    ['Gather ore', 'Prepare fuel', 'Smelt plates', 'Craft machine'],
  )
  assert.equal(replanned.proposed_focus_index, 2)
  assert.equal(replanned.proposed_focus_step_id, 'step_2')
  assert.equal(replanned.steps[0].status, 'active')
  assert.equal(replanned.steps[1].status, 'pending')
})


test('canonical memory persists project and milestone hierarchy across restore', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())
  memory.updateProjectBoard('npc:airi', {
    current_milestone: { id: 'bootstrap', title: 'Establish burner production', completion_summary: 'Stable early production is available.' },
    next_milestones: [{ id: 'automation', title: 'Reach Automation' }, { id: 'power', title: 'Establish electric power' }],
    development_direction: 'vertical',
  })
  const snapshot = memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.currentPlan('npc:airi')
  assert.equal(state.project_board.project_id, 'goal_1')
  assert.equal(state.project_board.title, 'Build early automation')
  assert.equal(state.project_board.current_milestone.title, 'Establish burner production')
  assert.deepEqual(state.project_board.next_milestones.map(item => item.title), ['Reach Automation', 'Establish electric power'])
  assert.equal(state.project_board.development_direction, 'vertical')
  assert.match(restored.planContext('npc:airi'), /\[PROJECT_STATE\]/)
})

test('project status follows durable goal lifecycle authority', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())
  memory.currentPlan('npc:airi')
  memory.pausePlan('npc:airi', 'user_pause')
  assert.equal(memory.planByNpc.get('npc:airi').project_board.status, 'paused')
})


test('final Plan Tracker step completes the milestone without completing the long-horizon project', () => {
  const memory = new CanonicalTaskBoardMemory()
  const oneStepBoard = createTaskBoard(['Establish burner production'], 0, { goalId: 'goal_long', now: 1 })
  memory.planByNpc.set('npc:airi', planState({
    goal_id: 'goal_long',
    objective: 'Launch a rocket',
    plan: ['Establish burner production'],
    current_step: 0,
    task_board: oneStepBoard,
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal_long',
      title: 'Launch a rocket',
      status: 'active',
      completed_milestones: [],
      current_milestone: { title: 'Establish burner production', status: 'active' },
      next_milestones: [{ title: 'Reach Automation', status: 'tentative' }],
      development_direction: 'vertical',
      transition_state: '',
      revision: 1,
      updated_at: 1,
    },
  }))

  const result = memory.applyOutcomeAuthority('npc:airi', {
    kind: 'verified_complete',
    source: 'step_checkpoint_gate',
    reason_code: 'checkpoint_satisfied',
    evidence: [{ kind: 'deterministic_verification', ref: 'milestone-final', summary: 'verified' }],
    metadata: { scope: 'step' },
  })

  assert.equal(result.decision.accepted, true)
  assert.equal(result.milestoneCompleted, true)
  assert.equal(result.state.status, 'active')
  assert.equal(result.state.project_board.current_milestone, undefined)
  assert.equal(result.state.project_board.completed_milestones.at(-1).title, 'Establish burner production')
  assert.equal(result.state.project_board.transition_state, 'awaiting_next_milestone')
  assert.equal(memory.currentPlan('npc:airi').goal_id, 'goal_long')
})

test('activating a tentative next milestone resets the Plan Tracker for a fresh milestone plan', () => {
  const memory = new CanonicalTaskBoardMemory()
  const state = planState({
    goal_id: 'goal_long',
    objective: 'Launch a rocket',
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal_long',
      title: 'Launch a rocket',
      status: 'active',
      completed_milestones: [{ title: 'Establish burner production', status: 'completed' }],
      current_milestone: undefined,
      next_milestones: [{ title: 'Reach Automation', status: 'tentative' }],
      development_direction: 'vertical',
      transition_state: 'awaiting_next_milestone',
      revision: 2,
      updated_at: 2,
    },
  })
  memory.planByNpc.set('npc:airi', state)
  const advanced = memory.activateNextMilestone('npc:airi')
  assert.equal(advanced.changed, true)
  assert.equal(advanced.state.project_board.current_milestone.title, 'Reach Automation')
  assert.equal(advanced.state.project_board.transition_state, 'awaiting_milestone_plan')
  assert.equal(advanced.state.task_board.total_steps, 0)
  assert.equal(advanced.state.plan.length, 0)
})


test('activated next milestone stays pending until a fresh milestone-local plan is committed', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({
    goal_id: 'goal_long',
    objective: 'Launch a rocket',
    plan: [],
    current_step: 0,
    task_board: createTaskBoard([], 0, { goalId: 'goal_long', now: 1 }),
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal_long',
      title: 'Launch a rocket',
      status: 'active',
      completed_milestones: [{ title: 'Establish burner production', status: 'completed' }],
      current_milestone: undefined,
      next_milestones: [{ title: 'Reach Automation', status: 'tentative' }],
      development_direction: 'vertical',
      transition_state: 'awaiting_next_milestone',
      revision: 2,
      updated_at: 1,
    },
  }))

  const advanced = memory.activateNextMilestone(key)
  assert.equal(advanced.changed, true)
  assert.equal(advanced.state.project_board.current_milestone.title, 'Reach Automation')
  assert.equal(advanced.state.project_board.transition_state, 'awaiting_milestone_plan')
  assert.equal(advanced.state.task_board.steps.length, 0)

  const proposal = {
    chatMessage: 'Planning Automation.',
    plan: ['Prepare science production', 'Research Automation'],
    currentStep: 0,
    operations: [],
  }
  const previous = memory.currentPlan(key)
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'continue' }, proposal, { continuation: true })
  const reconciled = memory.reconcileTaskBoard(key, previous.task_board, proposal, recorded, {
    previousState: previous,
    allowReplan: true,
    newMilestone: true,
  })
  assert.equal(reconciled.state.project_board.transition_state, '')
  assert.equal(reconciled.state.task_board.steps.length, 2)
  assert.equal(reconciled.state.project_board.current_milestone.title, 'Reach Automation')
})


test('planner cannot silently replace an already-activated next milestone', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({
    goal_id: 'goal_long',
    objective: 'Launch a rocket',
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal_long',
      title: 'Launch a rocket',
      status: 'active',
      completed_milestones: [{ title: 'Establish burner production', status: 'completed' }],
      current_milestone: { id: 'automation', title: 'Reach Automation', status: 'active' },
      next_milestones: [{ title: 'Establish electric power', status: 'tentative' }],
      development_direction: 'vertical',
      transition_state: '',
      revision: 3,
      updated_at: 1,
    },
  }))

  const updated = memory.updateProjectBoard(key, {
    current_milestone: { title: 'Skip ahead to oil processing' },
    next_milestones: [{ title: 'Automate red and green science' }],
    development_direction: 'vertical',
  }, { preserveCurrentMilestone: true })

  assert.equal(updated.current_milestone.title, 'Reach Automation')
  assert.deepEqual(updated.next_milestones.map(item => item.title), ['Automate red and green science'])
})


test('hierarchy split transaction survives persistence and stays in model context', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())
  memory.markHierarchySplitPending('npc:airi', {
    reason_code: 'hierarchy_split_requested',
    reasoning_budget: 'deep',
    planning_horizon: 'subgoal',
    observation_budget: 2,
  })

  const snapshot = memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.currentPlan('npc:airi')

  assert.equal(state.hierarchy_split_pending.kind, 'split_current_milestone')
  assert.equal(state.hierarchy_split_pending.reasoning_budget, 'deep')
  assert.equal(state.hierarchy_split_pending.observation_budget, 2)
  assert.match(restored.planContext('npc:airi'), /\[HIERARCHY_TRANSITION\]/)
  assert.match(restored.planContext('npc:airi'), /Do not continue the old flat Plan Tracker/)
})


test('legacy milestone pending flags migrate into the canonical project transition state', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal_test',
      title: 'Long project',
      status: 'active',
      completed_milestones: [],
      current_milestone: { title: 'Reach Automation', status: 'active' },
      next_milestones: [],
      development_direction: 'vertical',
      transition_state: '',
      revision: 1,
      updated_at: 1,
    },
    milestone_plan_pending: true,
  }))

  const snapshot = memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.currentPlan('npc:airi')

  assert.equal(state.project_board.transition_state, 'awaiting_milestone_plan')
  assert.equal(state.milestone_transition_pending, undefined)
  assert.equal(state.milestone_plan_pending, undefined)
  assert.match(restored.planContext('npc:airi'), /\[MILESTONE_PLAN_TRANSITION\]/)
})


test('initial project split transaction survives persistence', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.beginHierarchyGoal('npc:airi', {
    sender: 'tester',
    text: 'Reach Automation',
  }, {
    reasoning_budget: 'strategic',
    planning_horizon: 'strategic',
    observation_budget: 3,
  })

  const snapshot = memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.currentPlan('npc:airi')

  assert.equal(state.status, 'active')
  assert.equal(state.objective, 'Reach Automation')
  assert.equal(state.hierarchy_split_pending.kind, 'split_project_goal')
  assert.equal(state.hierarchy_split_pending.reasoning_budget, 'strategic')
  assert.equal(state.hierarchy_split_pending.planning_horizon, 'strategic')
  assert.equal(state.hierarchy_split_pending.observation_budget, 3)
  assert.match(restored.planContext('npc:airi'), /HIERARCHY_TRANSITION/)
})


test('durable step completion contracts survive snapshot restore and only follow stable semantic step ids', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', {
    goal_id: 'goal_contract',
    owner: 'tester',
    objective: 'gather stone then build',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Gather stone', 'Build furnace'],
    current_step: 0,
    revision: 1,
    last_chat_message: '',
    last_operations: [],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: false,
    updated_at: Date.now(),
    history: [],
    task_board: createTaskBoard(['Gather stone', 'Build furnace'], 0, { goalId: 'goal_contract' }),
  })
  const contract = {
    mode: 'all',
    source: 'planner_semantic_checkpoint',
    confidence: 0.95,
    requirements: [{ id: 'stone_total', kind: 'inventory_count', item_name: 'stone', minimum: 100 }],
  }
  memory.setStepCompletionContract('npc:airi', 'step_1', contract)
  const snapshot = memory.snapshot()

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  assert.equal(restored.currentPlan('npc:airi').task_board.steps[0].completion_contract.requirements[0].minimum, 100)

  const previous = restored.currentPlan('npc:airi').task_board
  restored.reconcileTaskBoard('npc:airi', previous, {
    plan: ['Gather stone', 'Build furnace'],
    currentStep: 0,
  }, { state: restored.currentPlan('npc:airi') }, { allowReplan: false })
  assert.equal(restored.currentPlan('npc:airi').task_board.steps[0].completion_contract.requirements[0].minimum, 100)

  const beforeReplan = restored.currentPlan('npc:airi').task_board
  restored.reconcileTaskBoard('npc:airi', beforeReplan, {
    plan: ['Gather iron', 'Build furnace'],
    currentStep: 0,
  }, { state: restored.currentPlan('npc:airi') }, { allowReplan: true })
  const replanned = restored.currentPlan('npc:airi').task_board
  assert.notEqual(replanned.steps[0].id, 'step_1')
  assert.equal(replanned.steps[0].completion_contract, undefined)
})
