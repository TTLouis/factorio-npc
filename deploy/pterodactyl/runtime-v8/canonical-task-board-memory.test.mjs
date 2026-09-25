import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalContinuationPlan, CanonicalTaskBoardMemory, verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'
import { createTaskBoard, reconcileTaskBoard } from './common.mjs'
import { getActivePlan, GOAL_STATUS, PLAN_STATUS } from './planning-state.mjs'

// A plan only commits on a real Jev scope review plus a real preflight result;
// there is deliberately no default, so tests state the review they mean.
// Commit authority is deterministic runtime validation; Jev scope review was retired.
const RUNTIME_VALIDATED = Object.freeze({ passed: true })

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

// Live 2026-09-25 16:15 (req_muh5t1wa_1): place a burner drill at a
// planner-chosen coordinate, then supply it starter coal. The engine refused
// the placement and cancelled the dependent transfer.
function placeAndSupplyState() {
  const placeBoard = board()
  placeBoard.steps[2] = { ...placeBoard.steps[2], description: 'Place a burner drill on iron ore and fuel it' }
  return planState({
    task_board: placeBoard,
    plan: placeBoard.steps.map(step => step.description),
    last_operations: [
      'place_entity {"entity_name":"burner-mining-drill","x":12,"y":-7,"direction":"north"}',
      'move_items {"item_name":"coal","entity_name":"burner-mining-drill","max_count":5,"to_entity":true}',
    ],
    last_mutation_verified: false,
  })
}

function placementRefusedReceipt(batchId, basicOverrides = {}) {
  return {
    kind: 'operation_error_receipt',
    ref: `batch_${batchId}`,
    summary: JSON.stringify({
      outcome: 'failed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: batchId,
      task_count: 2,
      task_types: ['placing', 'moving_items'],
      tick: 900 + batchId,
      reason: 'placing:not_placeable',
      basic_operation: {
        operation_id: 40 + batchId,
        tick: 900 + batchId,
        actor_id: 18,
        type: 'placing',
        accepted: true,
        completed: false,
        code: 'not_placeable',
        entity_name: 'burner-mining-drill',
        placement_footprint: {
          tile_width: 2,
          tile_height: 2,
          tile_box: { left_top: { x: 11, y: -8 }, right_bottom: { x: 13, y: -6 } },
          world_box: { left_top: { x: 11, y: -8 }, right_bottom: { x: 13, y: -6 } },
        },
        placement_grid: { x_offset: 0, y_offset: 0, nearest_valid_center: { x: 12, y: -7 } },
        placement_blockers: [{ name: 'rock-big', type: 'simple-entity', position: { x: 12.4, y: -6.6 } }],
        ...basicOverrides,
      },
      correlation: { goal_id: 'goal_1', step_id: 'step_3', actor_id: 18, actor_epoch: 3 },
    }),
  }
}

test('a refused placement in a placing + dependent transfer batch goes back to the planner, bounded, without blocking', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', placeAndSupplyState())

  const first = memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(7))
  let state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.blocker, '')
  assert.equal(first.status, 'active')
  assert.equal(first.active_index, 2)
  assert.equal(first.active_step_id, 'step_3')
  assert.equal(first.completed_count, 2)
  assert.equal(first.steps[2].status, 'active')
  const record = first.evidence.at(-1)
  assert.equal(record.kind, 'operation_failure_recoverable')
  assert.equal(record.step_id, 'step_3')
  const parsed = JSON.parse(record.summary)
  assert.equal(parsed.code, 'not_placeable')
  assert.deepEqual(parsed.nearest_valid_center, { x: 12, y: -7 })
  assert.equal(parsed.placement_blockers[0].name, 'rock-big')
  assert.equal(parsed.attempt, 1)

  // The same batch re-reported is not another attempt.
  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(7))
  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(8))
  state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.task_board.evidence.filter(item => item.kind === 'operation_failure_recoverable').length, 2)

  // Retries exhausted: the step is now a world blocker, named as a placement failure.
  const blocked = memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(9))
  state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:not_placeable')
  assert.equal(blocked.active_index, 2)
  assert.equal(blocked.completed_count, 2)
  assert.equal(blocked.steps[2].status, 'blocked')
})

test('a completed batch for the step ends the placement refusal streak', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', placeAndSupplyState())

  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(7))
  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(8))
  memory.recordBoardEvidence('npc:airi', { kind: 'operation_receipt', ref: 'batch_9', summary: JSON.stringify({ outcome: 'completed', batch_id: 9 }) })
  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(10))

  const state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(JSON.parse(state.task_board.evidence.at(-1).summary).attempt, 1)
})

test('the transfer itself failing in a placing + transfer batch still blocks as a transfer failure', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', placeAndSupplyState())

  memory.recordBoardEvidence('npc:airi', placementRefusedReceipt(7, {
    type: 'moving_items',
    code: 'nothing_moved',
    entity_name: undefined,
    placement_footprint: undefined,
    placement_grid: undefined,
    placement_blockers: undefined,
    item_name: 'coal',
    requested_count: 5,
    moved_count: 0,
    to_entity: true,
  }))
  const state = memory.currentPlan('npc:airi')

  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'transfer_failed:nothing_moved')
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_failure_recoverable'), false)
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
  const retiredContext = memory.planContext('npc:airi')
  assert.match(retiredContext, /\[RUNTIME_COMPAT_STATE\] No active compatibility task/)
  assert.doesNotMatch(retiredContext, /\[PLANNING_STATE\]/)
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


// The shelf emitter's job is to tell authorship apart from authority. The
// Main LLM authors every node either way, so these cover the two cases where
// that distinction decides whether the shelf moves at all.
function shelfMemory() {
  const memory = new CanonicalTaskBoardMemory()
  const state = planState()
  memory.planByNpc.set('npc:airi', state)
  memory.ensurePlanningDraft('npc:airi', state, { now: 1000 })
  return memory
}

const SHELF_NODES = Object.freeze([
  { id: 'roadmap_early_smelting', intent: 'establish reliable early iron and copper smelting' },
])

test('a re-shelved roadmap with no verified world change since the last one is refused', () => {
  const memory = shelfMemory()
  memory.reviseRoadmap('npc:airi', SHELF_NODES, { now: 1100 })
  const first = memory.planningState('npc:airi').roadmap
  assert.ok(first)

  memory.reviseRoadmap('npc:airi', [
    { id: 'roadmap_rethink', intent: 'skip smelting and go straight to oil' },
  ], { now: 1200 })

  // Preferring a different shelf is not a reason for the shelf to move.
  assert.equal(memory.planningState('npc:airi').roadmap.roadmap_revision_id, first.roadmap_revision_id)
  assert.deepEqual(memory.planningState('npc:airi').roadmap.nodes.map(node => node.id), ['roadmap_early_smelting'])
})

test('a roadmap revision standing on runtime-owned verified evidence moves the shelf', () => {
  const memory = shelfMemory()
  memory.reviseRoadmap('npc:airi', SHELF_NODES, { now: 1100 })
  memory.recordBoardEvidence('npc:airi', completedReceipt())

  memory.reviseRoadmap('npc:airi', [
    ...SHELF_NODES,
    { id: 'roadmap_red_science', intent: 'sustain red science production' },
  ], { now: 1300, reason: 'smelting proved out' })

  const roadmap = memory.planningState('npc:airi').roadmap
  assert.equal(roadmap.authority, 'verified_world_change')
  assert.deepEqual(roadmap.evidence_refs, ['batch_7'])
  assert.deepEqual(roadmap.nodes.map(node => node.id), ['roadmap_early_smelting', 'roadmap_red_science'])
  // Lineage survives the revision rather than being replaced.
  assert.equal(roadmap.derived_from_revision_id, memory.planningState('npc:airi').roadmap_history.at(-1).roadmap_revision_id)
})

test('canonical task memory exposes no project or milestone hierarchy control API', () => {
  const forbidden = Object.getOwnPropertyNames(CanonicalTaskBoardMemory.prototype)
    .filter(name => /project|milestone|hierarchy/i.test(name))
  assert.deepEqual(forbidden, [])
})

test('a blocked continuation is frozen even when a caller requests a replan', () => {
  const frozen = { ...board(), status: 'blocked', blocker: 'world_geometry_unresolved' }
  const proposal = {
    plan: ['Find stone', 'Use a different patch'],
    currentStep: 1,
    operations: [{ name: 'mine_resource', args: { resource_name: 'stone' } }],
  }
  const guarded = canonicalContinuationPlan(frozen, proposal, { allowReplan: true })
  assert.deepEqual(guarded.plan, board().steps.map(step => step.description))
  assert.equal(guarded.currentStep, frozen.active_index)
  assert.deepEqual(guarded.operations, [])
})

test('blocked reconciliation cannot create a suffix-replacement or no-op loop', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  const frozen = { ...board(), status: 'blocked', blocker: 'world_geometry_unresolved' }
  memory.planByNpc.set(key, planState({ status: 'blocked', blocker: frozen.blocker, task_board: frozen }))
  const proposal = { plan: ['Find stone', 'Use a different patch'], currentStep: 1, operations: [{ name: 'wait', args: { ticks: 1 } }] }
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'continue' }, proposal, { continuation: true })
  const reconciled = memory.reconcileTaskBoard(key, frozen, proposal, recorded, { allowReplan: true })
  assert.equal(reconciled.state.status, 'blocked')
  assert.deepEqual(reconciled.state.task_board.steps.map(step => step.description), board().steps.map(step => step.description))
  assert.equal(reconciled.state.task_board.revision, frozen.revision)
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

test('authoritative planning reducer persists BLOCKED and explicit user choice across restart', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, planState({
    task_board: {
      ...board(),
      active_index: 0,
      active_step_id: 'step_1',
      completed_count: 0,
      steps: board().steps.map((step, index) => ({ ...step, status: index === 0 ? 'active' : 'pending' })),
    },
    current_step: 0,
  }))

  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  memory.commitPlanningPlan(key, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  memory.applyOutcomeAuthority(key, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'operation_preflight_failed:missing_dependency',
    candidate_blocker: 'operation_preflight_failed:missing_dependency',
    evidence: [{ kind: 'operation_preflight_blocker', ref: 'preflight_1', summary: 'missing dependency' }],
  })
  memory.recordBlockedChoice(key, 'revise', 'Louis', { now: 130 })

  const before = getActivePlan(memory.planningState(key))
  assert.equal(before.status, PLAN_STATUS.BLOCKED)
  assert.equal(before.blocker.user_choice.choice, 'revise')
  assert.equal(memory.currentPlan(key).planning.blocked.awaiting_choice, false)
  assert.equal(memory.currentPlan(key).planning.blocked.choice, 'revise')

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  const after = getActivePlan(restored.planningState(key))
  assert.equal(after.status, PLAN_STATUS.BLOCKED)
  assert.equal(after.blocker.user_choice.choice, 'revise')
  assert.equal(restored.currentPlan(key).status, 'blocked')
  assert.equal(restored.currentPlan(key).planning.plan.plan_id, after.plan_id)
  assert.equal(restored.currentPlan(key).planning.blocked.choice, 'revise')
})

test('new goal after reducer cancellation gets fresh planning lineage under reused NPC key', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, planState({ goal_id: 'goal_old' }))
  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  memory.commitPlanningPlan(key, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  const oldPlanId = getActivePlan(memory.planningState(key)).plan_id

  memory.terminatePlan(key)
  const cancelled = getActivePlan(memory.planningState(key))
  assert.equal(cancelled.status, PLAN_STATUS.CANCELLED)

  const next = memory.recordPlan(key, { sender: 'Louis', text: 'Build a new smelting line' }, {
    chatMessage: 'Starting over.',
    plan: ['Inspect ore', 'Build smelting'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })
  const nextPlan = getActivePlan(memory.planningState(key))
  assert.equal(next.state.objective, 'Build a new smelting line')
  assert.notEqual(nextPlan.plan_id, oldPlanId)
  assert.equal(nextPlan.status, PLAN_STATUS.DRAFT)
})

test('legacy restart migration replays verified Task Board prefix before reducer projection', () => {
  const key = 'npc:airi'
  const legacy = new CanonicalTaskBoardMemory()
  const state = planState()
  legacy.planByNpc.set(key, state)
  const legacySnapshot = {
    version: 1,
    dialogue: [],
    plans: [{ key, state }],
  }

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(legacySnapshot)))
  const planning = restored.planningState(key)
  const active = getActivePlan(planning)

  assert.equal(active.status, PLAN_STATUS.EXECUTING)
  assert.equal(active.active_step_index, 2)
  assert.equal(active.execution.step_progress[active.steps[0].step_id].status, 'completed')
  assert.equal(active.execution.step_progress[active.steps[1].step_id].status, 'completed')
  assert.equal(restored.currentPlan(key).task_board.active_index, 2)
  assert.equal(restored.currentPlan(key).task_board.completed_count, 2)
})

test('blocked revise choice plus explicit user prompt creates successor and preserves completed prefix in predecessor', () => {
  const key = 'npc:airi'
  const blockedBoard = board()
  blockedBoard.status = 'blocked'
  blockedBoard.blocker = 'path_blocked'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, planState({
    task_board: blockedBoard,
    status: 'blocked',
    blocker: 'path_blocked',
  }))
  let planning = memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100, migrated: true })
  planning = memory.commitPlanningPlan(key, { now: 110, migrated: true, runtime_validation: RUNTIME_VALIDATED })
  planning = memory.replayLegacyVerifiedPrefix(key, memory.planByNpc.get(key), planning, { now: 115 })
  memory.planningByNpc.set(key, planning)
  memory.applyOutcomeAuthority(key, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'path_blocked',
    candidate_blocker: 'path_blocked',
    evidence: [{ kind: 'fresh_world_observation', ref: 'block_1', summary: 'blocked' }],
  })
  memory.recordBlockedChoice(key, 'revise', 'Louis', { now: 120 })

  const predecessor = getActivePlan(memory.planningState(key))
  const proposed = {
    chatMessage: 'Use another route.',
    plan: ['Find stone', 'Mine stone', 'Use alternate furnace recipe', 'Build power', 'Start research'],
    currentStep: 2,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Use the alternate route instead' }, proposed)
  const reconciled = memory.reconcileTaskBoard(key, blockedBoard, proposed, recorded, { previousState: planState({ task_board: blockedBoard, status: 'blocked', blocker: 'path_blocked' }) })
  const successor = getActivePlan(memory.planningState(key))

  assert.equal(recorded.userRevisionApproved, true)
  assert.equal(successor.plan_version, predecessor.plan_version + 1)
  assert.equal(successor.derived_from_plan_id, predecessor.plan_id)
  assert.equal(successor.status, PLAN_STATUS.DRAFT)
  assert.deepEqual(successor.steps.map(step => step.description), ['Use alternate furnace recipe', 'Build power', 'Start research'])
  assert.deepEqual(successor.carried_forward_evidence, [
    `${predecessor.plan_id}:${predecessor.steps[0].step_id}`,
    `${predecessor.plan_id}:${predecessor.steps[1].step_id}`,
  ])
  assert.equal(reconciled.state.status, 'active')
  assert.equal(reconciled.state.task_board.completed_count, 2)
  assert.equal(reconciled.state.task_board.active_index, 2)
  assert.equal(reconciled.state.task_board.steps[2].description, 'Use alternate furnace recipe')
})

// A two-step slice, both steps still pending, so one live adapter sequence can
// drive a plan from commit to PLAN_COMPLETED without fixture replay.
function twoStepState() {
  return planState({
    task_board: {
      ...board(),
      active_index: 0,
      active_step_id: 'step_1',
      completed_count: 0,
      total_steps: 2,
      steps: [
        { id: 'step_1', description: 'Gather iron', status: 'active' },
        { id: 'step_2', description: 'Build furnace', status: 'pending' },
      ],
    },
    current_step: 0,
  })
}

function driveSliceToCompletion(memory, key) {
  memory.planByNpc.set(key, twoStepState())
  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  memory.commitPlanningPlan(key, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  const first = { kind: 'deterministic_verification', ref: 'proof_step_1', summary: 'iron gathered' }
  memory.recordBoardEvidence(key, first)
  memory.applyOutcomeAuthority(key, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'step_1_verified',
    evidence: [first],
    metadata: { scope: 'step' },
  })
  const last = { kind: 'deterministic_verification', ref: 'proof_step_2', summary: 'furnace built' }
  memory.recordBoardEvidence(key, last)
  memory.applyOutcomeAuthority(key, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'verified_final_step',
    evidence: [last],
  })
}

test('a plan driven to completion through the live outcome path does NOT satisfy the goal', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  driveSliceToCompletion(memory, key)

  // The slice really did finish -- this is not a test that nothing happened.
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.COMPLETED)
  // And the goal is untouched. plan slice completed != user goal satisfied:
  // the runtime has no acceptance criteria for prose intent, so it may not
  // decide the intent was met.
  assert.equal(memory.planningState(key).goal.status, GOAL_STATUS.ACTIVE)
  assert.equal(memory.planningState(key).goal.satisfied_at, undefined)
  assert.equal(memory.planningState(key).log.some(entry => entry.type === 'GOAL_SATISFIED'), false)
})

test('an explicit user declaration carrying its own evidence satisfies the goal through the adapter', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  driveSliceToCompletion(memory, key)

  const satisfied = memory.recordGoalSatisfaction(key, {
    source: 'user',
    declaredBy: 'Louis',
    evidenceRefs: ['chat/Louis/goal_confirmed'],
    rationale: 'Louis confirmed the furnace line covers what he asked for.',
  })

  assert.equal(satisfied.goal.status, GOAL_STATUS.COMPLETED)
  assert.equal(satisfied.goal.satisfaction.source, 'user')
  assert.deepEqual(satisfied.goal.satisfaction.evidence_refs, ['chat/Louis/goal_confirmed'])
  assert.equal(satisfied.goal.satisfaction.rationale, 'Louis confirmed the furnace line covers what he asked for.')
  assert.ok(satisfied.log.some(entry => entry.type === 'GOAL_SATISFIED'))
  assert.equal(memory.planningState(key).goal.status, GOAL_STATUS.COMPLETED)
})

test('a goal-satisfaction declaration without its own evidence is refused', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  driveSliceToCompletion(memory, key)

  const unchanged = memory.recordGoalSatisfaction(key, { source: 'user', declaredBy: 'Louis', evidenceRefs: [] })
  assert.equal(unchanged.goal.status, GOAL_STATUS.ACTIVE)
  // Jev is not an authority over the user's intent, whatever it brings.
  const refused = memory.recordGoalSatisfaction(key, { source: 'jev', evidenceRefs: ['jev/review_1'] })
  assert.equal(refused.goal.status, GOAL_STATUS.ACTIVE)
})

test('a committed slice is frozen: a new instruction cannot replace it', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, twoStepState())
  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  memory.commitPlanningPlan(key, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  const inFlight = getActivePlan(memory.planningState(key))
  assert.equal(inFlight.status, PLAN_STATUS.COMMITTED)
  const planCountBefore = memory.planningState(key).plans.length

  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Forget the furnace, get a coal line running first' }, {
    chatMessage: 'Switching to coal.',
    plan: ['Find coal', 'Build a drill'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  // This used to supersede, at RECORD time -- before scope review and before
  // preflight. A replacement that fails either gate would then have destroyed
  // a validated plan and left an extra one behind. Supersession is a handover,
  // and an unreviewed draft is not a successor.
  assert.equal(recorded.supersededPlanId, undefined)
  const planning = memory.planningState(key)
  const active = getActivePlan(planning)
  assert.equal(active.plan_id, inFlight.plan_id, 'the frozen slice is still the active plan')
  assert.equal(active.status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(active.steps.map(step => step.description), inFlight.steps.map(step => step.description))
  assert.equal(planning.plans.length, planCountBefore, 'no successor was minted')
  assert.equal(planning.plans.some(item => item.status === PLAN_STATUS.SUPERSEDED), false)
  assert.equal(planning.log.some(entry => entry.type === 'PLAN_SUPERSEDED'), false)
})

test('an unadmitted draft may still be replaced outright', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, twoStepState())
  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  const draft = getActivePlan(memory.planningState(key))
  assert.equal(draft.status, PLAN_STATUS.DRAFT, 'nothing has been admitted yet')

  memory.recordPlan(key, { sender: 'Louis', text: 'Actually, coal first' }, {
    chatMessage: 'Switching to coal.',
    plan: ['Find coal', 'Build a drill'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  // Nothing was frozen, so replacing it destroys no validated work.
  const active = getActivePlan(memory.planningState(key))
  assert.deepEqual(active.steps.map(step => step.description), ['Find coal', 'Build a drill'])
  assert.notEqual(active.status, PLAN_STATUS.COMMITTED)
})

test('harness continuation and an unchanged plan never supersede the in-flight slice', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(key, twoStepState())
  memory.ensurePlanningDraft(key, memory.planByNpc.get(key), { now: 100 })
  memory.commitPlanningPlan(key, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  const inFlight = getActivePlan(memory.planningState(key))

  const continued = memory.recordPlan(key, { sender: 'Louis', text: 'continue' }, {
    chatMessage: 'Continuing.',
    plan: ['Find coal', 'Build a drill'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }, { continuation: true })
  assert.equal(continued.supersededPlanId, undefined)
  assert.equal(getActivePlan(memory.planningState(key)).plan_id, inFlight.plan_id)

  const reEmitted = memory.recordPlan(key, { sender: 'Louis', text: 'keep going with the furnace' }, {
    chatMessage: 'Same slice.',
    plan: ['Gather iron', 'Build furnace'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })
  assert.equal(reEmitted.supersededPlanId, undefined)
  assert.equal(getActivePlan(memory.planningState(key)).plan_id, inFlight.plan_id)
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.COMMITTED)
})

