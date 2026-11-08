import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { newCopperGame, recoveryWorld, ScriptedModel, observation, plannerDraft, OBJECTIVE, FURNACE_UNIT, mixedOreBatch, PLATES, GOAL, STEP } from './recovery-loop-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'

function fixture(options) {
  const game = newCopperGame(options)
  const model = new ScriptedModel().push('planner', 'observe', observation()).push('planner', 'supply', plannerDraft())
  const w = recoveryWorld({ game, model })
  return { ...w, start: () => w.agent.request(OBJECTIVE, { sender: 'fixture' }) }
}

test('recovery fixture declares only its copper job and admits the unchanged copper supply', async () => {
  const w = fixture()
  await w.start()
  assert.equal(w.game.sent.length, 1)
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0].assignment.products, ['copper-plate'])
  assert.equal(w.memory.getFactoryRegistry().cells[0].origin.source, 'synthetic_fixture')
  assert.ok(w.game.factoryObservations.length > 0)
  assert.deepEqual(w.model.remaining, [])
  assert.deepEqual(w.model.violations, [])
})

test('declared iron job refuses the copper recovery proposal before native admission', async () => {
  const w = fixture({ factoryJob: 'iron-plate' })
  await assert.rejects(w.start(), { failure_code: 'factory_cell_input_unproven' })
  assert.equal(w.game.sent.length, 0)
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0].assignment.products, ['iron-plate'])
})

test('missing recovery native member stays missing across setup and cannot authorize work', async () => {
  const w = fixture()
  w.game.factoryMembers.delete(FURNACE_UNIT)
  w.game.installFactoryFixture(w.memory)
  w.game.installFactoryFixture(new CanonicalTaskBoardMemory())
  await assert.rejects(w.start(), { failure_code: 'factory_cell_resolution_required' })
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.game.factoryMembers.has(FURNACE_UNIT), false)
})

test('fresh recovery engine supplies independent native facts for a restored assignment', () => {
  const first = fixture()
  const memory = new CanonicalTaskBoardMemory(); memory.restore(first.memory.snapshot())
  const before = memory.snapshot().factory_registry
  const game = newCopperGame()
  game.installFactoryFixture(memory)
  assert.equal(game.factoryMembers.get(FURNACE_UNIT).recipe.name, 'copper-plate')
  assert.deepEqual(memory.getFactoryRegistry(), before)
})

test('new host memory cannot overwrite an already running recovery engine recipe or fault', () => {
  const w = fixture()
  const row = w.game.factoryMembers.get(FURNACE_UNIT)
  row.recipe.name = 'fixture-injected-job-mismatch'
  w.game.installFactoryFixture(new CanonicalTaskBoardMemory())
  assert.equal(w.game.factoryMembers.get(FURNACE_UNIT), row)
  assert.equal(row.recipe.name, 'fixture-injected-job-mismatch')
})

test('original mixed-ore Run G proposal remains unsent under the dedicated copper job', async () => {
  const operations = mixedOreBatch()
  const game = newCopperGame(); const before = structuredClone(game.inventory)
  const model = new ScriptedModel().push('planner', 'original:observe', observation())
    .push('planner', 'original:mixed-ore', planReply({ plan: [STEP], currentStep: 0, operations, checkpoint: PLATES,
      goal: GOAL, stepCompletions: [{ kind: 'deterministic', checkpoint: PLATES }] }))
  const w = recoveryWorld({ game, model })
  await assert.rejects(w.agent.request(OBJECTIVE, { sender: 'fixture' }), { failure_code: 'factory_cell_input_unproven' })
  assert.equal(game.sent.length, 0)
  assert.deepEqual(game.inventory, before)
  assert.deepEqual(mixedOreBatch(), operations)
  assert.deepEqual(model.violations, []); assert.deepEqual(model.remaining, [])
})
