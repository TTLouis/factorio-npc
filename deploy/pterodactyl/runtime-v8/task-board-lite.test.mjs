import { fluidFixture } from './fluid-preservation-fixtures.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addTaskBoardEvidence,
  createTaskBoard,
  reconcileTaskBoard,
  sanitizeTaskBoard,
  setTaskBoardStatus,
  taskBoardProgress,
} from './common.mjs'

test('creates a bounded canonical board with stable step ids', () => {
  const board = createTaskBoard(['observe', 'build', 'verify'], 0, { goalId: 'goal_1', now: 100 })
  assert.equal(board.goal_id, 'goal_1')
  assert.equal(board.total_steps, 3)
  assert.equal(board.active_step_id, 'step_1')
  assert.deepEqual(board.steps.map(step => [step.id, step.status]), [
    ['step_1', 'active'],
    ['step_2', 'pending'],
    ['step_3', 'pending'],
  ])
  assert.deepEqual(taskBoardProgress(board), {
    status: 'active', completed: 0, total: 3, index: 1,
    step_id: 'step_1', step: 'observe',
    proposed_focus_index: 0, proposed_focus_step_id: 'step_1',
    blocker: '', pause_reason: '', revision: 1,
  })
})

test('does not let a continuation silently expand 1/5 into 1/7', () => {
  const original = createTaskBoard(['one', 'two', 'three', 'four', 'five'], 0, { now: 10 })
  const changed = reconcileTaskBoard(original, ['one', 'extra-a', 'two', 'three', 'four', 'five', 'extra-b'], 0, { now: 20 })
  assert.equal(changed, original)
  assert.equal(taskBoardProgress(changed).total, 5)
  assert.equal(taskBoardProgress(changed).index, 1)
})

test('advances only when runtime marks the matching later canonical step authoritative', () => {
  const original = createTaskBoard(['observe', 'build', 'load', 'verify'], 0, { now: 10 })
  const proposed = reconcileTaskBoard(original, ['observe', 'build', 'load', 'verify'], 2, { now: 15 })
  assert.equal(proposed.active_step_id, 'step_1')
  assert.equal(proposed.completed_count, 0)
  assert.equal(proposed.proposed_focus_step_id, 'step_3')

  const advanced = reconcileTaskBoard(proposed, ['observe', 'build', 'load', 'verify'], 2, { now: 20, authoritativeAdvance: true })
  assert.equal(advanced.active_step_id, 'step_3')
  assert.equal(advanced.completed_count, 2)
  assert.equal(advanced.total_steps, 4)
  assert.deepEqual(advanced.steps.map(step => step.status), ['completed', 'completed', 'active', 'pending'])
})

test('failure recovery may replace only the remaining suffix without losing completed progress', () => {
  let board = createTaskBoard(['observe', 'walk', 'build', 'verify'], 0, { now: 10 })
  board = reconcileTaskBoard(board, ['observe', 'walk', 'build', 'verify'], 2, { now: 20, authoritativeAdvance: true })
  const replanned = reconcileTaskBoard(board, ['observe', 'walk', 'escape water', 'repath', 'build', 'verify'], 2, { now: 30, allowReplan: true })
  assert.equal(replanned.completed_count, 2)
  assert.equal(replanned.active_index, 2)
  assert.deepEqual(replanned.steps.map(step => step.description), ['observe', 'walk', 'escape water', 'repath', 'build', 'verify'])
  assert.equal(replanned.steps[0].status, 'completed')
  assert.equal(replanned.steps[1].status, 'completed')
  assert.equal(replanned.steps[2].status, 'active')
})

test('records blockers, pauses, completion and bounded evidence as board truth', () => {
  let board = createTaskBoard(['build', 'verify'], 0, { now: 1 })
  board = addTaskBoardEvidence(board, { summary: 'batch_7 completed', ref: 'batch_7', now: 2 })
  assert.equal(board.evidence.at(-1).step_id, 'step_1')
  assert.equal(board.evidence.at(-1).ref, 'batch_7')

  board = setTaskBoardStatus(board, 'blocked', { blocker: 'placement_collision', now: 3 })
  assert.equal(board.status, 'blocked')
  assert.equal(board.steps[0].status, 'blocked')

  board = setTaskBoardStatus(board, 'paused', { pauseReason: 'user_stop', now: 4 })
  assert.equal(board.steps[0].status, 'paused')

  board = setTaskBoardStatus(board, 'completed', { now: 5 })
  assert.equal(board.completed_count, 2)
  assert.equal(board.active_step_id, undefined)
  assert.deepEqual(board.steps.map(step => step.status), ['completed', 'completed'])
})

test('sanitizes persisted board data and migrates a legacy plan when board is missing', () => {
  const legacy = sanitizeTaskBoard(undefined, { fallbackPlan: ['a', 'b'], fallbackCurrentStep: 1, goalId: 'goal_old', now: 50 })
  assert.equal(legacy.goal_id, 'goal_old')
  assert.equal(legacy.active_step_id, 'step_1')
  assert.equal(legacy.completed_count, 0)
  assert.equal(legacy.proposed_focus_index, 1)
  assert.equal(legacy.proposed_focus_step_id, 'step_2')

  const restored = sanitizeTaskBoard({
    ...legacy,
    evidence: [{ id: 'e1', kind: 'operation_receipt', summary: 'ok', ref: 'batch_1', at: 51, step_id: 'step_2' }],
    events: [...legacy.events, { seq: 2, type: 'evidence', at: 51, revision: 2, evidence_id: 'e1' }],
  }, { goalId: 'goal_old', now: 60 })
  assert.equal(restored.total_steps, 2)
  assert.equal(restored.evidence[0].ref, 'batch_1')
  assert.equal(restored.events.at(-1).type, 'evidence')
})


test('replanning never rebinds old evidence to a changed semantic step id', () => {
  let board = createTaskBoard(['gather stone', 'craft furnaces', 'verify output'], 0, { now: 10 })
  board = reconcileTaskBoard(board, ['gather stone', 'craft furnaces', 'verify output'], 1, { now: 20, authoritativeAdvance: true })
  const replacedStepId = board.active_step_id
  const unchangedVerifyId = board.steps[2].id
  board = addTaskBoardEvidence(board, { kind: 'deterministic_verification', summary: 'crafted furnaces', ref: 'batch_2', now: 21 })

  const replanned = reconcileTaskBoard(board, ['gather stone', 'smelt iron plates', 'verify output'], 1, { now: 30, allowReplan: true })

  assert.equal(replanned.completed_count, 1)
  assert.notEqual(replanned.active_step_id, replacedStepId)
  assert.equal(replanned.steps[1].description, 'smelt iron plates')
  assert.equal(replanned.steps[2].id, unchangedVerifyId)
  assert.equal(replanned.evidence.at(-1).step_id, replacedStepId)
  assert.notEqual(replanned.evidence.at(-1).step_id, replanned.active_step_id)

  const restored = sanitizeTaskBoard(replanned, { goalId: replanned.goal_id, now: 40 })
  assert.equal(restored.active_step_id, replanned.active_step_id)
  assert.equal(restored.steps[2].id, unchangedVerifyId)
  assert.equal(restored.evidence.at(-1).step_id, replacedStepId)
})


test('native preservation receipt stays whole across board add/restore while prose remains bounded', () => {
  const { receipt } = fluidFixture()
  Object.assign(receipt, { batch_ref: 'batch-g1-5', task_count: 1, task_types: ['placing'] })
  receipt.basic_operation.operation_id = 9
  const original = JSON.stringify(receipt)
  assert.ok(original.length > 1200)
  let board = createTaskBoard(['place boiler'], 0, { goalId: 'goal_1', now: 100 })
  board = addTaskBoardEvidence(board, { kind: 'operation_receipt', ref: 'batch-g1-5', summary: original })
  const retained = JSON.parse(board.evidence.at(-1).summary)
  assert.deepEqual(retained.basic_operation.preservation_binding, receipt.basic_operation.preservation_binding)
  assert.deepEqual(retained.admitted_batch, receipt.admitted_batch)
  assert.deepEqual(retained.correlation, receipt.correlation)
  assert.equal(sanitizeTaskBoard(board).evidence.at(-1).summary, board.evidence.at(-1).summary)
  assert.equal(addTaskBoardEvidence(board, { kind: 'note', summary: 'x'.repeat(3000) }).evidence.at(-1).summary.length, 1200)
})

test('malformed and oversized native binding receipts cannot acquire proof on add or restore', () => {
  const { receipt } = fluidFixture()
  Object.assign(receipt, { batch_ref: 'batch-g1-5', task_count: 1, task_types: ['placing'] })
  receipt.basic_operation.operation_id = 9
  const edits = [
    row => { row.basic_operation.preservation_binding.owner.session = '' },
    row => { row.basic_operation.preservation_binding.ordinal = 0 },
    row => { row.admitted_batch.operation_key = 'other' },
    row => { row.correlation.actor_epoch++ },
    row => { row.basic_operation.placed_position.x = null },
    row => { row.task_count = {} },
    row => { row.extra = 'x'.repeat(8000) },
  ]
  const board = createTaskBoard(['place boiler'], 0, { goalId: 'goal_1', now: 100 })
  for (const edit of edits) {
    const changed = structuredClone(receipt); edit(changed)
    const summary = JSON.stringify(changed)
    assert.equal(addTaskBoardEvidence(board, { kind: 'operation_receipt', summary }).evidence.at(-1).summary, '')
    const restored = sanitizeTaskBoard({ ...board, evidence: [{ kind: 'operation_receipt', summary }] })
    assert.equal(restored.evidence.at(-1).summary, '')
  }
})
