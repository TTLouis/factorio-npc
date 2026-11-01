import assert from 'node:assert/strict'
import test from 'node:test'

import { assertStrictBoundary, completeAndReport, FurnaceFactorio, KEY, recoverySession, recoveryWorld, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'
import { gather, inventoryCheckpoint, jevContractLog, planReply } from './task-loop-fixtures.mjs'

// Run J's exact final planner answer. No real model/Jev, world stock injection or direct resume helper.
const runJReply = () => planReply({
  chatMessage: 'BLOCKED: I can’t verify whether steam-power registered after the iron plates were produced. The last observed research state showed it incomplete, and later production may have changed that; the next science unlock depends on confirming this trigger.',
  plan: ['Verify steam-power trigger completion'], currentStep: 0, operations: [],
  stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'steam-power' }] } }],
  roadmapNodeIds: ['steam-power-trigger'], developmentMode: 'vertical',
})
const shelf = [
  { id: 'steam-power-trigger', intent: 'Gather the first capability input.' },
  { id: 'finish', intent: 'Hold one copper ore.', depends_on: ['steam-power-trigger'] },
]
const draft = (item, goal) => planReply({
  plan: [`Gather one ${item}`], currentStep: 0, operations: [gather(item, 1)],
  checkpoint: inventoryCheckpoint(item, 1),
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint(item, 1) }],
  ...(goal ? { goal, roadmap: shelf } : {}),
  roadmapNodeIds: [item === 'iron-ore' ? 'steam-power-trigger' : 'finish'],
})
async function begin(t, replies) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new FurnaceFactorio()
  game.knownTechnologies.add('steam-power')
  const model = new ScriptedModel().push('planner', 'first-slice', draft('iron-ore', {
    scope: 'finite', summary: 'Hold one copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 1 }],
  }))
  for (const [label, reply, role = 'planner'] of replies) model.push(role, label, reply)
  const world = recoveryWorld({ game, model })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'Gather iron and then hold one copper ore'), true)
  await settle(ctx.session)
  assert.ok(game.pendingBatch)
  ctx.firstPlan = structuredClone(world.memory.planningState(KEY).plans.at(-1))
  ctx.goalId = world.memory.planningState(KEY).goal.goal_id
  return ctx
}

for (const plannerOnly of [false, true]) test(`R-J: completed slice -> exact checkpoint-bearing BLOCKED reply -> ${plannerOnly ? 'planner-only draft and executor' : 'planner batch'} -> successor receipt -> verified goal`, async t => {
  const successor = draft('copper-ore')
  if (plannerOnly) { const body = JSON.parse(successor.content); body.operations = []; successor.content = JSON.stringify(body) }
  const replies = [['run-j-blocker', runJReply()], ['corrected-successor', successor]]
  if (plannerOnly) replies.push(['successor-executor', draft('copper-ore'), 'executor'])
  const ctx = await begin(t, replies)
  await completeAndReport(ctx)
  assert.deepEqual(ctx.world.named('request.failed').map(row => row.message), [], 'Run J must not die at checkpoint_requires_active_step')
  assert.equal(ctx.game.inventory['iron-ore'], 1)
  assert.equal(ctx.game.inventory['copper-ore'] ?? 0, 0, 'no stock before the successor batch completes')
  const planning = ctx.world.memory.planningState(KEY)
  assert.equal(planning.goal.goal_id, ctx.goalId)
  assert.equal(planning.plans.find(plan => plan.plan_id === ctx.firstPlan.plan_id).status, 'COMPLETED')
  assert.deepEqual(planning.plans.find(plan => plan.plan_id === ctx.firstPlan.plan_id).steps, ctx.firstPlan.steps)
  assert.notEqual(planning.plans.at(-1).plan_id, ctx.firstPlan.plan_id)
  assert.equal(ctx.game.researched.has('steam-power'), false, 'the unsupported claim never manufactures research')
  assert.equal(ctx.game.sent.length, 2, 'only the two admitted gathering batches mutate the world')
  assert.equal(planning.goal.fresh_context_recovery_used, true, 'committing the successor never refunds the durable recovery allowance')
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-ore'], 1)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.world.memory.currentPlan(KEY), undefined)
  assert.equal(ctx.world.named('recovery.fresh_context_started').length, 1)
  const routed = ctx.world.named('planning.completed_slice_blocker_routed')
  assert.equal(routed.length, 1)
  assert.deepEqual([routed[0].reason, routed[0].goal_id, routed[0].plan_id], ['completed_slice_has_no_active_checkpoint_target', ctx.goalId, ctx.firstPlan.plan_id])
  assert.ok(routed[0].request_id)
  if (plannerOnly) assert.equal(ctx.world.named('plan.delegation_committed').length, 1)
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  assertStrictBoundary(ctx)
})

test('R-J exhausted: repeated unsupported blocker preserves completed history and spends only the existing recovery', async t => {
  const ctx = await begin(t, [['run-j-blocker', runJReply()], ['repeated-blocker', runJReply()]])
  await completeAndReport(ctx)
  const failures = ctx.world.named('request.failed')
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /unverified_blocker_recovery_exhausted/)
  assert.equal(failures[0].harness_state_fault, undefined)
  assert.equal(ctx.world.named('recovery.fresh_context_started').length, 1)
  const planning = ctx.world.memory.planningState(KEY)
  assert.equal(planning.goal.goal_id, ctx.goalId)
  assert.equal(planning.goal.fresh_context_recovery_used, true)
  assert.equal(planning.plans.length, 1)
  assert.equal(planning.plans[0].status, 'COMPLETED')
  assert.deepEqual(planning.plans[0].steps, ctx.firstPlan.steps)
  assert.equal(ctx.game.sent.length, 1)
  assert.equal(ctx.game.researched.has('steam-power'), false)
  assert.equal(ctx.game.inventory['copper-ore'] ?? 0, 0)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*unverified_blocker_recovery_exhausted/i] })
})

for (const change of ['stop', 'epoch']) test(`R-J fence: ${change} during the bounded planner reply cannot admit a successor`, async t => {
  let announce
  let release
  const started = new Promise(resolve => { announce = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const ctx = await begin(t, [['run-j-blocker', runJReply()], ['pending-successor', async () => {
    announce()
    await pending
    return draft('copper-ore')
  }]])
  const completion = completeAndReport(ctx)
  await started
  if (change === 'stop') assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'stop'), true)
  else ctx.game.status.epoch += 1
  release()
  await completion
  await settle(ctx.session)
  assert.equal(ctx.game.sent.length, 1)
  assert.equal(ctx.game.inventory['copper-ore'] ?? 0, 0)
  assert.equal(ctx.game.pendingBatch, null)
  const planning = ctx.world.memory.planningState(KEY)
  assert.equal(planning.goal.goal_id, ctx.goalId)
  assert.equal(planning.plans[0].status, 'COMPLETED')
  assert.deepEqual(planning.plans[0].steps, ctx.firstPlan.steps)
  assert.equal(ctx.world.named('request.failed').some(row => row.harness_state_fault === 'checkpoint_requires_active_step'), false)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*(?:cancelled|superseded|epoch changed)/i] })
})
