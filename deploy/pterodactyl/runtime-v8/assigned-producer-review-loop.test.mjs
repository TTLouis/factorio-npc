import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { getActivePlan } from './planning-state.mjs'
import { assignedReviewFixture, ASSIGNED_KEY, ASSIGNED_OBJECTIVE } from './assigned-producer-review-fixtures.mjs'
import { assignedFactoryConflict, relevantFactoryAssignments, reconcileFactoryCellUse } from './factory-cell-use.mjs'
import { recoverFactoryCellUse } from './factory-cell-use-recovery.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'

async function withFixture(run, options) {
  const root = path.resolve('test-results/assigned-producer-review'); await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, 'case-'))
  try { await run(assignedReviewFixture(path.join(directory, 'state.json'), options)) }
  finally { assert.ok(directory.startsWith(root + path.sep)); await fs.rm(directory, { recursive: true, force: true }) }
}

for (const bypassCommitPrevention of [false, true]) test(`BK assigned input conflict: ${bypassCommitPrevention ? 'residual pre-send' : 'commit prevention'} returns through advisory notes without replacing plan`, async () => {
  let originalSteps
  await withFixture(async w => {
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    const state = w.memory.planningState(ASSIGNED_KEY); const plan = getActivePlan(state)
    assert.equal(w.plannerCalls(), 2); assert.equal(w.executorCalls(), 4)
    assert.equal(plan.plan_version, 1); assert.equal(state.plans.length, 1)
    assert.deepEqual(plan.steps, originalSteps, 'all committed descriptions, guidance and contracts remain exact')
    assert.equal(plan.steps[0].execution_guidance.materialSupply.resource, 'iron-ore')
    assert.deepEqual(w.memory.getFactoryRegistry(), w.registry)
    assert.equal(w.game.mutations.length, 1, 'wrong-unit batch was unsent')
    assert.equal(result.operations[0].args.unit_number, 37)
    assert.equal(w.events.filter(row => row.event === 'planner.review_round').length, 1)
    assert.equal(w.events.filter(row => row.event === 'plan.replacement_committed').length, 0)
    assert.equal(Object.entries(w.memory.planningState(ASSIGNED_KEY).goal.effort.blockers).filter(([key]) => key.startsWith('assignment:')).reduce((n, [, count]) => n + count, 0), 1)
    const saved = JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8'))
    assert.equal(saved.planning_states.find(row => row.key === ASSIGNED_KEY).state.goal.effort.blockers.executor_decision, 2)
    assert.ok(state.goal.review_notes[plan.steps[0].step_id].includes('producer 37'))
    const restored = new CanonicalTaskBoardMemory(); restored.restore(saved)
    assert.deepEqual(restored.planningState(ASSIGNED_KEY).goal.review_notes, state.goal.review_notes)
    assert.ok(w.replies.filter(row => row.role === 'executor').at(-1).messages.some(row => String(row.content).includes('planner_review_notes')))
  }, { bypassCommitPrevention, onProvider: (context, w) => {
    if (context.role === 'executor' && !originalSteps) originalSteps = structuredClone(getActivePlan(w.memory.planningState(ASSIGNED_KEY)).steps)
  } })
})

for (const operationForm of ['supply_entity', 'move_items_exact', 'productionTask']) for (const submissionForm of ['json', 'submitPlan']) test(`${operationForm}/${submissionForm} uses the same advisory boundary`, async () => {
  await withFixture(async w => {
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(result.operations[0].args.unit_number, 37)
    assert.equal(w.plannerCalls(), 2, JSON.stringify(w.events.filter(row => /refus|fail|recover|invalid/.test(row.event)))); assert.equal(w.game.mutations.length, 1)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.assigned_review_started').length, 1)
  }, { operationForm, submissionForm })
})

test('matching assigned input follows ordinary admission without review or allowance', async () => {
  await withFixture(async w => {
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(result.operations[0].args.unit_number, 37); assert.equal(w.plannerCalls(), 1)
    assert.equal(w.memory.snapshot().factory_use_recovery.records.length, 0)
  }, { matchingFirst: true })
})

const fences = {
  native_busy: w => { w.game.taskState = 'mining'; w.game.queueLength = 1 },
  unknown_journal: w => { w.game.admissionJournal = () => undefined },
  uncertain: w => { w.game.admissionJournal = () => [{ operation_key: 'other', state: 'uncertain' }] },
  stale_request: w => { w.agent.traceRequest = { ...w.agent.traceRequest, id: 'superseded' } },
  actor: w => { w.game.status.actor_id++ },
  epoch: w => { w.game.status.epoch++ },
  session: w => { w.game.status.session = 'other-session' },
  world: w => { w.game.factoryWorldId = '12345678-1234-1234-1234-123456789abc' },
  restored_state: w => w.memory.restore(w.memory.snapshot()),
  role: w => { w.agent.agentContext.role = 'planner' },
  owner_pause: w => w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' }),
  grant: w => { const grant = w.memory.currentGoalGrant(ASSIGNED_KEY); w.memory.revokeAuthorization(ASSIGNED_KEY, grant.grant_id, { reason: 'fixture' }) },
  changed_job_evidence: w => { w.game.factoryMembers.get(36).recipe.ingredients = [{ type: 'item', name: 'iron-ore' }] },
}
for (const [name, mutate] of Object.entries(fences)) test(`awaited refusal ${name} fences advisory continuation and all native sends`, async () => {
  let injected = false
  await withFixture(async w => {
    try { await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }) } catch { /* Expected refusal, never generic provider retry. */ }
    assert.equal(injected, true); assert.equal(w.plannerCalls(), 1); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.assigned_review_started').length, 0)
  }, { onTrace: async (row, w) => {
    if (!injected && row.event === 'factory_cell.boundary_refused') { injected = true; await mutate(w) }
  } })
})

test('repeating the wrong target exhausts the remaining durable goal effort after actual notes', async () => {
  let seeded = false
  await withFixture(async w => {
    await assert.rejects(w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }), { code: 'factory_cell_assigned_review_exhausted' })
    assert.equal(w.plannerCalls(), 2); assert.equal(w.game.mutations.length, 0)
    assert.equal(Object.entries(w.memory.planningState(ASSIGNED_KEY).goal.effort.blockers).filter(([key]) => key.startsWith('assignment:')).reduce((n, [, count]) => n + count, 0), 1)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.assigned_review_exhausted').length, 1)
  }, { repeatWrong: true, onProvider: (context, w) => {
    if (seeded || context.role !== 'executor') return
    seeded = true
    for (let i = 0; i < 21; i++) assert.equal(w.memory.spendGoalEffort(ASSIGNED_KEY, 'prior_attempt'), true)
  } })
})

test('goal effort exhaustion survives disk restore alongside unchanged legacy factory attempts', async () => {
  let seeded = false
  await withFixture(async w => {
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(result.goalStatus, 'paused')
    assert.equal(w.memory.pauseRecord(ASSIGNED_KEY).pause_class, 'guard')
    assert.match(w.memory.pauseRecord(ASSIGNED_KEY).pause_reason, /goal_no_progress_exhausted/)
    assert.equal(w.plannerCalls(), 1); assert.equal(w.game.mutations.length, 0)
    const saved = JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8'))
    assert.equal(saved.factory_use_recovery.records.reduce((n, row) => n + row.attempts.length, 0), 3)
    assert.equal(w.memory.planningState(ASSIGNED_KEY).goal.effort.spent, 24)
    assert.equal(w.memory.planningState(ASSIGNED_KEY).run.paused, true)
  }, { onProvider: async (context, w) => {
    if (seeded || context.role !== 'executor') return
    seeded = true
    const plan = getActivePlan(w.memory.planningState(ASSIGNED_KEY))
    for (let index = 0; index < 3; index++) w.memory.consumeFactoryUseRecovery(ASSIGNED_KEY, { prior: index }, {
      request_id: `prior-${index}`, plan_id: plan.plan_id, code: 'factory_cell_resolution_required', evidence_digest: 'a'.repeat(64) })
    for (let i = 0; i < 24; i++) assert.equal(w.memory.spendGoalEffort(ASSIGNED_KEY, 'prior_attempt'), true)
    await w.agent.persistState({ strict: true }); w.memory.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
  } })
})

test('strict persistence failure cannot issue an advisory request or world operation', async () => {
  let injected = false
  await withFixture(async w => {
    await assert.rejects(w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }), /fixture_durable_write_failed/)
    assert.equal(injected, true); assert.equal(w.plannerCalls(), 1); assert.equal(w.game.mutations.length, 0)
  }, { onTrace: (row, w) => {
    if (!injected && row.event === 'factory_cell.boundary_refused') {
      injected = true; w.agent.persistState = async ({ strict } = {}) => { assert.equal(strict, true); throw new Error('fixture_durable_write_failed') }
    }
  } })
})

test('model-shaped error cannot mint the private advisory witness', async () => {
  const error = Object.assign(new Error('factory_cell_input_unproven'), { code: 'factory_cell_input_unproven', witness: { facts: { unit_number: 36 } } })
  assert.equal(assignedFactoryConflict(error), undefined)
  assert.deepEqual(await recoverFactoryCellUse({}, error), { handled: false })
})

test('bounded retained assignments reach both roles without authorizing an operation', async () => {
  await withFixture(async w => {
    await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    const refs = relevantFactoryAssignments(w.agent)
    assert.equal(refs.cells.length, 2)
    assert.match(refs.status, /not_live_facts_or_authority/)
    for (const role of ['planner', 'executor']) {
      const packet = w.agent.buildRestagePacket({ role, checkpoint: 'C3' })
      assert.match(packet.text, /factory_assignments/)
      assert.match(packet.text, /native_recipe:synthetic-copper/); assert.match(packet.text, /native_recipe:synthetic-iron/)
    }
    const other = { ...w.agent, epoch: { ...w.agent.epoch, surface_index: 99 } }
    assert.equal(relevantFactoryAssignments(other, w.memory.planningState(ASSIGNED_KEY)), undefined)
  })
})

for (const variant of ['unknown_fuel', 'unknown_recipe', 'mixed_batch', 'unselected_material', 'controller_owned']) test(`unproven or internal ${variant} cannot receive model-conflict review authority`, async () => {
  let checked = false
  await withFixture(async w => {
    // The callback checks the native guard, then deliberately terminates this
    // fixture's provider invocation. Its sentinel is a provider failure, not
    // the native refusal already asserted below, and must not grant a review.
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(result.goalStatus, 'paused')
    const pause = w.memory.pauseRecord(ASSIGNED_KEY)
    assert.equal(pause.pause_class, 'guard')
    assert.equal(pause.pause_reason, 'provider_request_failed: fixture_checked_guard')
    assert.equal(checked, true); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.memory.snapshot().factory_use_recovery.records.length, 0)
    assert.equal(w.plannerCalls(), 1)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.assigned_review_started').length, 0)
    assert.equal(w.events.filter(row => row.event === 'planner.review_round').length, 0)
    assert.equal(w.events.filter(row => row.event === 'plan.replacement_committed').length, 0)
  }, { onProvider: async (context, w) => {
    if (context.role !== 'executor' || checked) return
    const operations = [{ name: 'supply_entity', args: { unit_number: 36, items: [{ item_name: 'iron-ore', count: 1 }] } }]
    if (variant === 'unknown_fuel') w.game.factoryMembers.get(36).fuel_item_facts.state = 'unknown'
    if (variant === 'unknown_recipe') w.game.factoryMembers.get(36).recipe.state = 'unknown'
    if (variant === 'mixed_batch') operations.push({ name: 'walk_to', args: { x: 1, y: 1 } })
    if (variant === 'unselected_material') operations[0].args.items[0].item_name = 'unrelated-material'
    if (variant === 'controller_owned') w.agent.productionAdmission = w.agent.captureCheckpointOwner()
    let failure
    try { await reconcileFactoryCellUse(w.agent, { phase: 'pre_send', operations }) } catch (error) { failure = error }
    assert.ok(failure, 'ordinary factory guard still refuses')
    assert.equal(assignedFactoryConflict(failure), undefined)
    checked = true; throw new Error('fixture_checked_guard')
  } })
})

test('owner cancellation while durable allowance is being persisted suppresses advisory request', async () => {
  let replaced = false
  await withFixture(async w => {
    try { await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }) } catch { /* Owner fence must stop. */ }
    assert.equal(replaced, true); assert.equal(w.plannerCalls(), 1); assert.equal(w.game.mutations.length, 0)
  }, { onTrace: (row, w) => {
    if (replaced || row.event !== 'factory_cell.boundary_refused') return
    replaced = true
    const persist = w.agent.persistState.bind(w.agent)
    w.agent.persistState = async options => { const result = await persist(options); w.agent.generation++; return result }
  } })
})

test('a previously consumed same-step review survives restore without imposing an obsolete one-review cap', async () => {
  let seeded = false
  await withFixture(async w => {
    const result = await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(result.operations[0].args.unit_number, 37)
    assert.equal(w.plannerCalls(), 2); assert.equal(w.game.mutations.length, 1)
    assert.equal(Object.entries(w.memory.planningState(ASSIGNED_KEY).goal.effort.blockers).filter(([key]) => key.startsWith('assignment:')).reduce((n, [, count]) => n + count, 0), 1)
  }, { onProvider: async (context, w) => {
    if (seeded || context.role !== 'executor') return
    seeded = true
    const plan = getActivePlan(w.memory.planningState(ASSIGNED_KEY))
    assert.equal(w.memory.claimReviewContinuation(ASSIGNED_KEY, plan.steps[0].step_id, { requestId: 'prior-advisory' }), true)
    await w.agent.persistState({ strict: true }); w.memory.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
  } })
})

for (const synchronous of [false, true]) test(`an advisory provider failure stays a provider failure without retry or replacement (synchronous frozen error=${synchronous})`, async () => {
  const failureMessage = synchronous ? 'fixture_request_rejected' : 'fixture_planner_provider_failure'
  let reviewCalls = 0
  await withFixture(async w => {
    if (synchronous) {
      const provider = w.agent.provider
      w.agent.provider = (messages, context) => {
        if (context.role === 'planner' && w.agent.reviewContinuation) {
          reviewCalls++
          throw Object.freeze(new Error(failureMessage))
        }
        return provider(messages, context)
      }
    }
    try { await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }) } catch (error) {
      assert.equal(error.message, failureMessage)
      assert.notEqual(error.pause_class, 'guard'); assert.notEqual(error.code, 'factory_cell_input_unproven')
    }
    assert.equal(reviewCalls, 1); assert.equal(w.game.mutations.length, 0)
    const failure = w.events.find(row => row.event === 'provider.error' && row.data.message === failureMessage)
    assert.equal(failure?.data.role, 'planner')
    assert.equal(w.events.findLast(row => row.event === 'request.completed')?.data.outcome, 'paused_provider_failure')
    assert.equal(w.events.findLast(row => row.event === 'goal.paused')?.data.provider_failure, true)
    assert.equal(w.events.findLast(row => row.event === 'goal.paused')?.data.cause, 'provider_request_failed')
    assert.equal(w.events.findLast(row => row.event === 'goal.paused')?.data.pause_class, 'guard')
    assert.equal(Object.entries(w.memory.planningState(ASSIGNED_KEY).goal.effort.blockers).filter(([key]) => key.startsWith('assignment:')).reduce((n, [, count]) => n + count, 0), 1)
    assert.equal(w.events.filter(row => row.event === 'plan.replacement_committed').length, 0)
  }, { onProvider: (context, w) => {
    if (!synchronous && context.role === 'planner' && w.agent.reviewContinuation) { reviewCalls++; throw new Error(failureMessage) }
  } })
})

test('returned advisory notes must be durable before the next executor request', async () => {
  let checked = false
  await withFixture(async w => {
    await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' })
    assert.equal(checked, true)
  }, { onProvider: async (context, w) => {
    if (context.role !== 'executor' || w.executorCalls() < 2) return
    const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
    const state = restored.planningState(ASSIGNED_KEY); const plan = getActivePlan(state)
    assert.ok(state.goal.review_notes[plan.steps[0].step_id].includes('producer 37'))
    assert.deepEqual(plan.steps, getActivePlan(w.memory.planningState(ASSIGNED_KEY)).steps)
    checked = true
  } })
})

test('failed strict returned-note save prevents fresh executor request and native continuation', async () => {
  let failedSave = false
  await withFixture(async w => {
    try { await w.agent.request(ASSIGNED_OBJECTIVE, { sender: 'owner' }) } catch (error) { assert.match(error.message, /fixture_note_save_failure/) }
    assert.equal(failedSave, true); assert.equal(w.executorCalls(), 2); assert.equal(w.plannerCalls(), 2)
    assert.equal(w.game.mutations.length, 0)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
    assert.equal(Object.keys(restored.planningState(ASSIGNED_KEY).goal.review_notes ?? {}).length, 0)
  }, { onProvider: (context, w) => {
    if (context.role !== 'planner' || !w.agent.reviewContinuation) return
    const persist = w.agent.persistState.bind(w.agent)
    w.agent.persistState = async options => {
      if (Object.keys(w.memory.planningState(ASSIGNED_KEY).goal.review_notes ?? {}).length) {
        assert.equal(options?.strict, true); failedSave = true; throw new Error('fixture_note_save_failure')
      }
      return persist(options)
    }
  } })
})
