import assert from 'node:assert/strict'
import test from 'node:test'
import { beginShoreline, finishShoreline, decision, placements } from './shoreline-recovery-fixtures.mjs'
import { completeAndReport, KEY } from './recovery-loop-fixtures.mjs'

test('original aggregate shoreline placement proposal cannot fabricate five member receipts', async t => {
  const ctx = await beginShoreline(t)
  const before = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  assert.equal(ctx.game.factoryMembers.size, 0)
  assert.equal(ctx.world.memory.getFactoryRegistry().cells.length, 0)
  ctx.model.push('executor', 'original-aggregate-placement', decision(placements))
  await completeAndReport(ctx)
  assert.equal(ctx.game.sent.length, 1, 'only the earlier exploration walk was sent')
  assert.equal(ctx.game.placed.size, 0)
  assert.equal(ctx.game.powered, false)
  assert.equal(ctx.world.memory.factoryPlacementCapacity().used, 0)
  assert.equal(ctx.world.named('request.failed').at(-1).failure_code, 'factory_enrollment_single_placement_required')
  assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, before)
})

test('shoreline native capability omission refuses enrollment even after genuine singleton receipts and power predicate', async t => {
  const ctx = await beginShoreline(t)
  const before = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  const command = ctx.game.command.bind(ctx.game)
  ctx.game.command = async text => {
    const raw = await command(text)
    if (!text.includes("'sgluna_factory','observe'")) return raw
    const body = JSON.parse(raw)
    for (const row of body.members) if (row.type === 'generator') row.progress_facts = { electricity_production: { state: 'unknown' } }
    return JSON.stringify(body)
  }
  await finishShoreline(ctx)
  assert.equal(ctx.game.placed.size, 5)
  assert.equal(ctx.game.powered, true, 'the original simulated power predicate follows actual placement/fuel completion')
  assert.equal(ctx.world.memory.factoryPlacementCapacity().used, 5)
  assert.equal(ctx.game.sent.filter(batch => batch.operations.some(op => op.name === 'place_entity')).length, 5)
  assert.equal(ctx.world.memory.getFactoryRegistry().cells.length, 0)
  assert.equal(ctx.world.named('factory_cell.enrollment_close_refused').at(-1).reason, 'factory_enrollment_native_unverified')
  assert.equal(ctx.world.named('goal.evaluated').some(row => row.satisfied), false)
  assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, before)
})
