import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beginShoreline, finishShoreline, queueShorelineDiscovery, decision, block, walk, RUN_M_SEARCHES, shorelineDecisionScript } from './shoreline-recovery-fixtures.mjs'
import { ScriptedModel, recoverySession, settle, KEY, assertStrictBoundary } from './recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, EXECUTOR_MODEL, PLANNER_MODEL } from './invalid-reference-fixtures.mjs'
import { localFluidSearchFact } from './targeted-observation.mjs'

test('Run M full loop: exact local/inconclusive water reads -> rejected blocker -> exploration receipt -> fresh discovery -> powered lab -> verified science goal', async t => {
  let ctx
  ctx = await beginShoreline(t, { ready: value => { ctx = value }, beforeBlock: async value => {
    // Run M had already spent its one-per-goal fresh-context recovery before
    // reaching the shoreline. Carry that durable policy state into the replay.
    assert.equal(value.world.memory.claimFreshContextRecovery(KEY, { requestId: 'prior-run-m-recovery' }), true)
    await value.world.agent.persistState()
  }, corrections: [['choose-native-frontier', (messages, context) => {
    assert.ok(messages.some(m => m.content?.includes('[LOCAL_FLUID_SEARCH_RECOVERY]')))
    assert.equal(context.allowTools, false, 'correction does not reopen observation tools')
    assert.equal(ctx.game.sent.length, 0, 'the harness never auto-walked or auto-placed')
    return decision([walk])
  }]] })
  const held = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  const [rejection] = ctx.world.named('recovery.local_fluid_search_blocker_rejected')
  assert.ok(rejection?.request_id)
  assert.equal(rejection.reason, 'local_fluid_search_is_not_world_blocker')
  assert.equal(rejection.water_search.ungenerated_chunk_count, 107)
  assert.deepEqual(rejection.water_search.exploration_centers, RUN_M_SEARCHES[2].result.ungenerated_chunks.map(c => c.center))
  assert.equal(ctx.game.explored, false)
  assert.equal(ctx.game.powered, false)
  await finishShoreline(ctx, { expectedSteps: held })
  assert.equal(ctx.world.memory.currentPlan(KEY), undefined, 'verified goal retires its completed canonical plan')
  assert.equal(ctx.game.powered, true)
  assert.equal(ctx.game.inventory['automation-science-pack'], 1)
  assert.ok(ctx.world.named('goal.evaluated').length, JSON.stringify(ctx.world.trace.filter(e => /checkpoint|step\.close|goal\./.test(e.event)).slice(-10)))
  assertStrictBoundary(ctx)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.world.named('recovery.routed'), [])
  assert.deepEqual(ctx.world.named('recovery.auto_resume_started'), [])
  assert.equal(ctx.world.modelRequests[0].model, PLANNER_MODEL)
  assert.ok(ctx.world.modelRequests.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assertStrictBoundary(ctx)
})

for (const change of ['stop', 'epoch']) test(`Run M ${change} fences the pending exploration correction`, async t => {
  let ctx, start, release
  const started = new Promise(resolve => { start = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const running = beginShoreline(t, { ready: value => { ctx = value }, corrections: [['pending-walk', async () => { start(); await pending; return decision([walk]) }]] })
  await started
  if (change === 'stop') ctx.session.queuePlayerRequest('TTLouis', 'stop')
  else ctx.game.status.epoch++
  release(); await running; await settle(ctx.session)
  assert.equal(ctx.game.sent.length, 0); assert.equal(ctx.game.explored, false)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*(?:cancelled|superseded|epoch changed)/i] })
})

test('Run M repeated unsupported search blockers consume only the existing category cap and admit nothing', async t => {
  const ctx = await beginShoreline(t, { corrections: Array.from({ length: 3 }, (_, i) => [`repeat-${i}`, block()]) })
  assert.equal(ctx.world.named('recovery.local_fluid_search_blocker_rejected').length, 4)
  assert.equal(ctx.world.named('recovery.classified').at(-1).retry_limit, 3)
  assert.equal(ctx.game.sent.length, 0)
  assert.deepEqual(ctx.world.named('recovery.fresh_context_started'), [])
  assertStrictBoundary(ctx)
})

test('Run M lost exploration acknowledgement + process/mod restart settles exact receipt and never replays the walk', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shoreline-restart-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'state.json')
  const first = await beginShoreline(t, { stateFile, ready: ctx => { ctx.game.dropAckOnce = true } })
  const goalId = first.world.memory.planningState(KEY).goal.goal_id
  first.game.completeBatch(); first.game.reloadMod()
  first.session.stopping = true; first.session.clearAutoResume()
  const model = new ScriptedModel(); queueShorelineDiscovery(model)
  const world = delegatedRecoveryWorld({ game: first.game, model, stateFile, decisionScript: shorelineDecisionScript })
  const ctx = { t, game: first.game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  await world.agent.loadPersistentState()
  ctx.session.queueStartupRecovery(ctx.session.currentPlanState())
  await settle(ctx.session)
  assert.equal(world.named('operation.recovery_settled').at(-1)?.reason, 'restart_exact_completed_receipt')
  assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
  assert.equal(world.agent.localFluidSearchObservation, undefined, 'restart/fresh positive read never inherits old negative coverage')
  await finishShoreline(ctx, { afterWalk: true })
  assert.equal(ctx.game.sent.filter(batch => batch.operations.some(op => op.name === 'walk_to_position')).length, 1)
  assertStrictBoundary(ctx)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assertStrictBoundary(ctx)
})

test('Run M bounded native search facts reject malformed coverage, mismatched requests and forged exploration centers', () => {
  const result = RUN_M_SEARCHES[2].result
  const args = { fluid_name: 'water', search_radius: 256 }
  assert.ok(localFluidSearchFact(JSON.stringify(result), args))
  for (const patch of [{ coverage_complete: true }, { empty_result_is_conclusive: true }, { returned_count: 1 }, { surface_index: 0 },
    { checked_chunks: 0 }, { ungenerated_chunks: [{ x: 1, y: 1, center: { x: 9000000, y: 0 } }] }, { samples: [{ secret: 'never-retain-me' }] }]) {
    assert.equal(localFluidSearchFact(JSON.stringify({ ...result, ...patch }), args), undefined)
  }
  assert.equal(localFluidSearchFact(JSON.stringify(result), { ...args, search_radius: 128 }), undefined)
  assert.equal(localFluidSearchFact(JSON.stringify(result), { ...args, fluid_name: 'oil' }), undefined)
  assert.equal(localFluidSearchFact('x'.repeat(4097), args), undefined)
})
