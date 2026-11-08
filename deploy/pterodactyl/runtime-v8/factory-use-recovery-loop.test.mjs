import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { getActivePlan } from './planning-state.mjs'
import { factoryStepRequirement } from './factory-cell-use.mjs'
import { recoveryFixture, RECOVERY_KEY, RECOVERY_OBJECTIVE } from './factory-use-recovery-fixtures.mjs'

async function withFixture(run, options) {
  const root = path.resolve('test-results/factory-use-recovery'); await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, 'case-'))
  try { await run(recoveryFixture(path.join(directory, 'state.json'), options)) }
  finally { assert.ok(directory.startsWith(root + path.sep)); await fs.rm(directory, { recursive: true, force: true }) }
}

test('actual request residual mismatch automatically commits same-goal successor and sends only assigned iron action', async () => {
  await withFixture(async w => {
    const copper = structuredClone(w.registry.cells[0])
    const result = await w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' })
    const state = w.memory.planningState(RECOVERY_KEY); const current = getActivePlan(state)
    assert.equal(w.plannerCalls(), 2, JSON.stringify(w.events.slice(-8)))
    assert.equal(w.executorCalls(), 4)
    assert.equal(current.plan_version, 2)
    assert.equal(current.working_revision.predecessor_plan_id, state.plans[0].plan_id)
    assert.equal(state.goal.objective, RECOVERY_OBJECTIVE)
    assert.ok(state.plans.every(plan => plan.goal_id === state.goal.goal_id))
    assert.equal(state.plans[0].steps[0].description, 'Produce iron using the existing pair')
    assert.deepEqual(w.memory.getFactoryRegistry().cells[0], copper)
    assert.equal(w.game.mutations.length, 1, 'wrong copper submission was completely unsent')
    assert.equal(result.operations[0].args.unit_number, 138)
    assert.equal(w.memory.planningState(RECOVERY_KEY).goal.effort.blockers['factory:factory_cell_assigned_job_mismatch'], 1)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.recovery_started').length, 1)
    assert.equal(w.events.filter(row => row.event === 'plan.working_revision_committed').length, 1)
    const saved = JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8'))
    assert.equal(saved.planning_states.find(row => row.key === RECOVERY_KEY).state.goal.effort.blockers['factory:factory_cell_assigned_job_mismatch'], 1)
  })
})

test('deliberate commit-prevention miss reaches real pre-send detector and automatically continues through successor admission', async () => {
  await withFixture(async w => {
    const result = await w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' })
    assert.equal(w.agent.fixtureMissInjected, true)
    const refusal = w.events.find(row => row.event === 'factory_cell.boundary_refused')
    assert.equal(refusal.data.factory_boundary, 'pre_send')
    assert.equal(w.plannerCalls(), 2); assert.equal(w.game.mutations.length, 1)
    assert.equal(result.operations[0].args.unit_number, 138)
    assert.equal(w.memory.planningState(RECOVERY_KEY).goal.effort.blockers['factory:factory_cell_assigned_job_mismatch'], 1)
    assert.equal(w.memory.planningState(RECOVERY_KEY).plans.length, 2)
    assert.deepEqual(w.memory.getFactoryRegistry().cells[0], w.registry.cells[0])
  }, { bypassCommitPrevention: true })
})

const fences = {
  native_busy: w => { w.game.taskState = 'mining'; w.game.queueLength = 1 },
  unknown_journal: w => { w.game.admissionJournal = () => undefined },
  uncertain_journal: w => { w.game.admissionJournal = () => [{ operation_key: 'other-uncertain', state: 'uncertain' }] },
  stale_request: w => { w.agent.traceRequest = { ...w.agent.traceRequest, id: 'superseded-factory-request' } },
  stale_actor: w => { w.game.status.actor_id++ },
  stale_epoch: w => { w.game.status.epoch++ },
  stale_session: w => { w.game.status.session = 'replaced-native-session' },
  restored_registry: w => { w.memory.restore(w.memory.snapshot()) },
  revoked_grant: w => { const grant = w.memory.currentGoalGrant(RECOVERY_KEY); w.memory.revokeAuthorization(RECOVERY_KEY, grant.grant_id, { reason: 'fixture_owner_revocation' }) },
  operator_pause: w => w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' }),
}

for (const [name, mutate] of Object.entries(fences)) test(`residual ${name} arriving during awaited refusal trace prevents replacement and native sends`, async () => {
  let injected = false
  await withFixture(async w => {
    let failure
    try { await w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' }) } catch (error) { failure = error }
    assert.equal(injected, true)
    assert.equal(w.plannerCalls(), 1)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.events.filter(row => row.event === 'factory_cell.recovery_started').length, 0)
    assert.equal(w.memory.snapshot().factory_use_recovery.records.length, 0)
    assert.ok(failure || w.memory.planningState(RECOVERY_KEY).run.paused || !w.agent.active, 'must terminate or hold visibly')
  }, { onTrace: async (row, w) => {
    if (!injected && row.event === 'factory_cell.boundary_refused' && row.data.code === 'factory_cell_assigned_job_mismatch') {
      injected = true; await mutate(w)
    }
  } })
})

test('same-goal exhaustion persists through real canonical restore and is durably paused before another executor action', async () => {
  let seeded = false
  await withFixture(async w => {
    const result = await w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' })
    assert.equal(seeded, true); assert.equal(result.goalStatus, 'paused')
    assert.equal(w.memory.pauseRecord(RECOVERY_KEY).pause_class, 'guard')
    assert.match(w.memory.pauseRecord(RECOVERY_KEY).pause_reason, /goal_no_progress_exhausted/)
    assert.equal(w.plannerCalls(), 1); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.memory.planningState(RECOVERY_KEY).goal.effort.spent, 24)
    const saved = JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8'))
    assert.equal(saved.factory_use_recovery.records.reduce((n, row) => n + row.attempts.length, 0), 3)
    assert.equal(w.memory.planningState(RECOVERY_KEY).run.paused, true, 'guard pause retains the accepted goal while durably stopping its run')
  }, { onProvider: async (context, w) => {
    if (seeded || context.role !== 'executor') return
    seeded = true
    const state = w.memory.planningState(RECOVERY_KEY); const plan = getActivePlan(state)
    for (let index = 0; index < 3; index++) w.memory.consumeFactoryUseRecovery(RECOVERY_KEY,
      { ...factoryStepRequirement(plan.steps[0]), resource: `prior-slice-${index}` },
      { request_id: `prior-${index}`, plan_id: plan.plan_id, code: 'factory_cell_resolution_required', evidence_digest: 'a'.repeat(64) })
    for (let i = 0; i < 24; i++) assert.equal(w.memory.spendGoalEffort(RECOVERY_KEY, 'prior_attempt'), true)
    await w.agent.persistState({ strict: true })
    w.memory.restore(JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8')))
  } })
})
