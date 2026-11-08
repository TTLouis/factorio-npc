import assert from 'node:assert/strict'
import test from 'node:test'
import { restorePlanningState, getActivePlan } from './planning-state.mjs'
import { evaluateOperationAdmission } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { creditGoalEffort, spendGoalEffort, GOAL_EFFORT_LIMIT } from './goal-effort.mjs'
test('goal effort credits only new native peaks; IDs, targets, reconstruction and blocker changes cannot renew it', () => {
  const contract = { requirements: [{ id: 'old', kind: 'inventory_count', item_name: 'synthetic-output', minimum: 10 }] }
  const facts = count => ({ old: { kind: 'inventory_count', current: count, authoritative: true } })
  let effort = creditGoalEffort(undefined, contract, facts(2))
  effort = spendGoalEffort(effort, 'assignment:producer:resource')
  effort = creditGoalEffort(effort, contract, facts(4))
  assert.equal(effort.spent, 0); assert.equal(effort.credits, 1)
  effort = spendGoalEffort(effort, 'another_blocker')
  effort = creditGoalEffort(effort, contract, facts(1))
  effort = creditGoalEffort(effort, contract, facts(4))
  assert.equal(effort.spent, 1)
  for (let i = 1; i < GOAL_EFFORT_LIMIT; i++) effort = spendGoalEffort(JSON.parse(JSON.stringify(effort)), `new:${i}`)
  assert.equal(spendGoalEffort(effort, 'rewritten-plan'), undefined)
  assert.equal(creditGoalEffort(effort, contract, { old: { ...facts(8).old, authoritative: false } }).spent, GOAL_EFFORT_LIMIT)
})

test('surplus beyond satisfied target cannot buy progress', () => {
  const contract = { requirements: [{ id: 'count', kind: 'inventory_count', item_name: 'already-enough', minimum: 1 }] }
  let held = creditGoalEffort(undefined, contract, { count: { kind: 'inventory_count', current: 100, authoritative: true } })
  held = spendGoalEffort(held, 'unmet-other-requirement')
  assert.equal(creditGoalEffort(held, contract, { count: { kind: 'inventory_count', current: 101, authoritative: true } }).spent, 1)
})

test('raising the target does not credit inventory already observed', () => {
  const requirement = { id: 'count', kind: 'inventory_count', item_name: 'same-item', minimum: 1 }
  const facts = { count: { kind: 'inventory_count', current: 100, authoritative: true } }
  let held = creditGoalEffort(undefined, { requirements: [requirement] }, facts)
  held = spendGoalEffort(held, 'replan')
  held = creditGoalEffort(held, { requirements: [{ ...requirement, minimum: 1000 }] }, facts)
  assert.equal(held.spent, 1)
  assert.equal(held.credits, 0)
})


test('legacy effort restoration is conservative and unknown revised authority stays fenced', () => {
  const key = 'npc:migration'; const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(key, { sender: 'owner', text: 'Obtain fixture stock' }, { plan: ['Obtain stock'], currentStep: 0, operations: [] }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(key, { runtime_validation: { passed: true } })
  const raw = structuredClone(memory.planningState(key)); delete raw.goal.effort
  raw.plans[0].execution = { ...raw.plans[0].execution, batches_attempted: 7 }
  raw.goal.review_continuation_steps = ['retained-review']
  const restored = restorePlanningState(raw)
  assert.equal(restored.goal.effort.spent, 8)
  for (const metadata of [null, { version: 99, grant_id: 'future' }, { version: 1 }]) {
    const candidate = structuredClone(raw); candidate.plans[0].working_revision = metadata
    const held = restorePlanningState(candidate)
    assert.deepEqual(getActivePlan(held).working_revision, metadata)
    assert.equal(getActivePlan(held).working_revision_unsupported, true)
    assert.equal(evaluateOperationAdmission(held, { operations: [{ name: 'wait_ticks', args: { ticks: 1 } }], actor: { actor_id: 1, actor_epoch: 1 } }).ok, false)
  }
  const snapshot = memory.snapshot(); delete snapshot.planning_states[0].state.goal.effort
  snapshot.factory_use_recovery = { schema_version: 1, records: [{ goal_id: raw.goal.goal_id, requirement_digest: 'a'.repeat(64), attempts: [{ request_id: 'old', plan_id: raw.active_plan_id, code: 'old-blocker', evidence_digest: 'b'.repeat(64) }] }] }
  const migrated = new CanonicalTaskBoardMemory(); migrated.restore(snapshot)
  assert.ok(migrated.planningState(key).goal.effort.spent >= 1)
  assert.deepEqual(migrated.snapshot().factory_use_recovery, { ...snapshot.factory_use_recovery, fault: false })
})
