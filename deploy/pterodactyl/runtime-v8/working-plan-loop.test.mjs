import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assignedReviewFixture, ASSIGNED_KEY, ASSIGNED_OBJECTIVE } from './assigned-producer-review-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'

for (const bypassCommitPrevention of [false, true]) test(`assignment refusal revises canonical strategy then legally continues (${bypassCommitPrevention ? 'residual' : 'prevention'})`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'working-plan-'))
  try {
    const w = assignedReviewFixture(path.join(directory, 'state.json'), { plannerRevision: true, bypassCommitPrevention, operationForm: 'move_items_exact', submissionForm: bypassCommitPrevention ? 'submitPlan' : 'json' })
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    const state = w.memory.planningState(ASSIGNED_KEY); const plan = getActivePlan(state)
    assert.equal(plan.plan_version, 2)
    assert.equal(state.plans.length, 2)
    assert.equal(state.plans[0].steps[0].description, 'Use the existing furnace to obtain at least 50 iron plates and one copper plate')
    assert.equal(plan.steps[0].description, 'Use the compatible iron producer and preserve the copper job')
    assert.equal(state.goal.objective, ASSIGNED_OBJECTIVE)
    assert.equal(result.operations[0].args.unit_number, 37)
    assert.equal(w.game.mutations.length, 1, 'refused wrong-unit batch never sent')
    assert.deepEqual(w.memory.getFactoryRegistry(), w.registry)
    assert.equal(w.events.filter(row => row.event === 'plan.working_revision_committed').length, 1)
    assert.ok(Object.keys(state.goal.effort.blockers).some(key => key.startsWith('assignment:')))
    // Synthetic native completion, through the real callback and fresh condition
    // reader. This fixture is not a Factorio engine/gameplay proof.
    w.game.lastBasicResult = { operation_id: w.game.batchId, tick: 600 + w.game.batchId, actor_id: w.game.status.actor_id,
      type: 'moving_items', accepted: true, completed: true, code: 'completed', target_unit_number: 37,
      item_name: 'iron-ore', to_entity: true, requested_count: 28, moved_count: 28 }
    w.game.inventory['iron-plate'] = 100
    w.game.inventory['copper-plate'] = 1
    await w.agent.completed()
    const advanced = w.memory.planningState(ASSIGNED_KEY)
    assert.ok(advanced.goal.effort.credits > 0, 'fresh relevant native advancement refreshes effort')
    assert.equal(advanced.goal.effort.spent, 0)
    assert.equal(advanced.plans[0].status, 'SUPERSEDED')
    assert.equal(advanced.goal.status, 'completed')
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
    assert.equal(getActivePlan(restored.planningState(ASSIGNED_KEY)).plan_version, 2)
    assert.deepEqual(restored.planningState(ASSIGNED_KEY).goal.effort.blockers, state.goal.effort.blockers)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})


for (const change of ['cancelled', 'grant_revoked', 'native_busy']) test(`revision read loses ${change} authority before successor publication`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-fence-'))
  try {
    const w = assignedReviewFixture(path.join(directory, 'state.json'), { plannerRevision: true, operationForm: 'move_items_exact' })
    const original = w.agent.validateStepCompletionDeclarations.bind(w.agent); let injected = false
    w.agent.validateStepCompletionDeclarations = async (plan, options) => {
      const result = await original(plan, options)
      if (options?.revising && !injected) {
        injected = true
        if (change === 'cancelled') w.agent.generation++
        else if (change === 'grant_revoked') w.memory.revokeAuthorization(ASSIGNED_KEY, w.memory.currentGoalGrant(ASSIGNED_KEY).grant_id)
        else w.game.status.idle = false
      }
      return result
    }
    await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }).catch(() => {})
    assert.equal(injected, true)
    assert.equal(getActivePlan(w.memory.planningState(ASSIGNED_KEY)).plan_version, 1)
    assert.equal(w.events.filter(row => row.event === 'plan.working_revision_committed').length, 0)
    assert.equal(w.game.mutations.length, 0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('late native progress after cancellation cannot refresh goal effort', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-fence-'))
  try {
    const w = assignedReviewFixture(path.join(directory, 'state.json'), { plannerRevision: true, operationForm: 'move_items_exact' })
    await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    const held = structuredClone(w.memory.planningState(ASSIGNED_KEY).goal.effort)
    w.game.inventory['iron-plate'] = 100
    const command = w.game.command.bind(w.game); let injected = false
    w.game.command = async text => {
      const result = await command(text)
      if (!injected && text.includes('inventory_count')) { injected = true; w.agent.generation++ }
      return result
    }
    const contract = getActivePlan(w.memory.planningState(ASSIGNED_KEY)).steps[0].completion_contract
    await w.agent.completionFactsForContract(contract).catch(() => {})
    assert.equal(injected, true)
    assert.deepEqual(w.memory.planningState(ASSIGNED_KEY).goal.effort, held)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
