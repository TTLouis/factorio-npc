import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FurnaceFactorio, recoverySession, settle } from './recovery-loop-fixtures.mjs'

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/run-au-recovery.json', import.meta.url)))
const KEY = 'npc:npc-1'
const exact = tap => ({ content: captured.responses.find(v => v.tap_request_id === tap).choices[0].message.tool_calls[0].function.arguments })
const call = (id, unit) => ({ id, type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ unit_number: unit }) } })

function world({ readHook, traceHook, snapshot, collectionCount = 6 } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(snapshot ?? captured.memory))
  const game = new FurnaceFactorio({ inventory: { coal: 18, 'iron-plate': 8 },
    furnace: { unit_number: 16, position: { x: -95, y: 37 }, output: { 'copper-plate': 6 } } })
  Object.assign(game.status, { actor_id: 6, epoch: 1, surface_index: 1, connected_players: 0 })
  game.batchId = 5
  const events = []; const providers = []; const reads = []
  const native = game.command.bind(game)
  let agent
  const detail = unit => ({ found: true, actor_id: 6, surface_index: 1, force_index: 1, observed_tick: 37942,
    actor_position: { x: -93, y: 29 }, entity: unit === 15
      ? { name: 'burner-mining-drill', type: 'mining-drill', unit_number: 15, position: { x: -95, y: 39 }, force: 'player',
          working: game.drillWorking === true, status: game.drillWorking ? 1 : 53, status_name: game.drillWorking ? 'working' : 'no_fuel', energy_source: 'burner', inventories: [] }
      : { ...game.entityRead().entity, position: game.furnace.position, force: 'player' } })
  game.command = async text => {
    reads.push(text)
    await readHook?.({ text, game, agent, memory })
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ actor: { actor_id: game.status.actor_id }, surface_index: game.status.surface_index, force_index: 1 })
    if (text.includes('"autorio_crafting","status"')) return JSON.stringify(game.craftingStatus ?? { task_active: false, native_queue: [] })
    if (game.drillWorking && text.includes('entity_state') && text.includes('15')) return JSON.stringify({ ok: true, kind: 'entity_state', satisfied: true, progressing: true, unit_number: 15 })
    if (text.includes('"get_entity_status"')) return JSON.stringify(game.detailOverride ?? detail(text.includes('unit_number') ? 15 : /,15\)/.test(text) ? 15 : 16))
    return native(text)
  }
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3, stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async () => {
      providers.push(agent.liveObservedExactTarget(15))
      if (providers.length === 1) return exact('tap_25')
      // Ordinary remaining-work decision after harness reconciliation. No model
      // is asked to repair an ID or waive validation; no old fuel batch replay.
      if (providers.length === 2) return { content: JSON.stringify({ chatMessage: '', stepId: held().steps[3].step_id, checkpoint: held().steps[3].completion_contract, operations: [{ name: 'move_items_exact', args: { unit_number: 16, item_name: 'copper-plate', max_count: collectionCount, to_entity: false } }] }) }
      if (collectionCount === 10 && providers.length === 3) return { content: JSON.stringify({ chatMessage: '', stepId: held().steps[3].step_id, checkpoint: held().steps[3].completion_contract, operations: [{ name: 'wait', args: { ticks: 120 } }] }) }
      throw new Error('AU fixture forbids further inference')
    } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: KEY,
    requestInfo: { memoryKey: KEY, turnId: 1, sender: '<server>', text: memory.currentPlan(KEY).objective },
    traceRequest: { id: 'req_mvlv5o9z_1', usage: {} } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => { events.push(row); await traceHook?.({ row, game, agent, memory }) } }
  agent.messages = []; agent.baseMessages = []
  // The exact AU reply addresses both units. Unit16 retains its proven live
  // binding; unit15 deliberately loses it, as in the original failure.
  agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(detail(16)))
  const held = () => getActivePlan(memory.planningState(KEY))
  return { memory, game, agent, events, providers, reads, held, detail }
}

test('AU prevention: full native scope survives model-facing entity projection and diff', async () => {
  const w = world()
  for (let n = 0; n < 2; n++) {
    const tool = call(`native-${n}`, 15)
    if (n) { w.agent.toolCache.clear(); w.agent.liveEntityObservations.clear() }
    await w.agent.handleToolBatch({ content: '', tool_calls: [tool] })
    assert.equal(w.agent.liveObservedExactTarget(15)?.surface_index, 1)
    assert.equal(w.agent.liveObservedExactTarget(15)?.position.x, -95)
  }
})

for (const tap of ['tap_22', 'tap_25']) test(`AU exact ${tap}: missing historical surface is reconciled from authoritative actor/entity scope`, async () => {
  const w = world()
  const steps = structuredClone(w.held().steps)
  assert.equal(w.agent.exactTargetLocator(15).surface_index, undefined)
  const plan = await w.agent.parsePlanMessageChecked(exact(tap))
  assert.equal(w.agent.liveObservedExactTarget(15)?.surface_index, 1, JSON.stringify({ plan, events: w.events.slice(-4), pause: w.memory.pauseRecord(KEY), status: w.memory.currentPlan(KEY).status }))
  assert.ok(w.events.some(r => r.event === 'entity.refresh_bound' && r.data.unit_number === 15))
  assert.equal(w.game.sent.length, 0)
  assert.deepEqual(w.held().steps, steps)
  assert.ok(plan)
})

test('AU residual: Session detects post-parse binding loss and automatically continues without replaying either fuel mutation', async () => {
  const w = world()
  const steps = structuredClone(w.held().steps)
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(w.detail(15)))
  const commit = w.agent.commitPlan.bind(w.agent)
  let injected = false
  w.agent.commitPlan = async plan => {
    if (!injected && plan.operations?.some(v => v.name === 'supply_entity')) {
      injected = true
      w.agent.liveEntityObservations.delete('unit:15')
    }
    return commit(plan)
  }
  const ctx = recoverySession(w, { actorId: 6, epoch: 1 })
  await ctx.session.queueEvent(() => w.agent.runTurn(), { reportError: true })
  await settle(ctx.session)
  assert.equal(injected, true)
  assert.ok(w.events.some(r => r.event === 'entity.refresh_detected' && r.data.source === 'admission_residual'))
  assert.ok(w.events.some(r => r.event === 'entity.refresh_decision_wake'))
  assert.equal(w.providers.length, 2, JSON.stringify({ logs: ctx.logs, events: w.events.slice(-32).map(r => ({ event:r.event, reason:r.data?.reason, route:r.data?.route, role:r.data?.role })) }))
  assert.equal(w.providers[1]?.surface_index, 1, 'harness repairs before ordinary remaining-work decision')
  assert.equal(w.game.inventory.coal, 18, 'old batch cannot replay fuel')
  assert.equal(w.game.inventory['copper-plate'] ?? 0, 0)
  assert.deepEqual(w.held().steps, steps)
  assert.equal(w.memory.pauseRecord(KEY)?.paused ?? false, false)
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
  assert.ok(w.agent.batchInFlight, 'ordinary native work owns the next transition')
  assert.equal(w.game.sent.length, 1)
  assert.equal(w.game.sent[0].operations[0].name, 'move_items_exact')
  assert.equal(w.held().execution.step_progress[w.held().steps[3].step_id].status, 'active', 'six existing plates cannot satisfy the ten-plate checkpoint')
})

for (const kind of ['actor', 'epoch', 'surface', 'step', 'request', 'amendment']) test(`AU residual rejects ${kind} change during scope read`, async () => {
  let injected = false
  const w = world({ readHook: ({ text, game, agent, memory }) => {
    if (injected || !text.includes('"get_entity_status"')) return
    injected = true
    if (kind === 'actor') game.status.actor_id++
    if (kind === 'epoch') game.status.epoch++
    if (kind === 'surface') game.status.surface_index++
    if (kind === 'step') getActivePlan(memory.planningState(KEY)).active_step_index--
    if (kind === 'request') agent.traceRequest = { id: 'replacement', usage: {} }
    if (kind === 'amendment') agent.currentPendingAmendment = () => ({ pending: true })
  } })
  await assert.rejects(w.agent.parsePlanMessageChecked(exact('tap_25')), /stale|cancel|supersed|scope|actor|epoch|surface/i)
  assert.equal(w.game.sent.length, 0)
})

test('AU refresh allowance survives restore; interrupted correction cannot silently retry', async () => {
  const w = world()
  let snapshot
  w.agent.persistState = async () => { snapshot = structuredClone(w.memory.snapshot()); throw new Error('injected crash') }
  await assert.rejects(w.agent.parsePlanMessageChecked(exact('tap_25')), /injected crash/)
  const restored = world({ snapshot })
  await restored.agent.runTurn()
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.memory.pauseRecord(KEY).pause_reason, 'entity_refresh_interrupted')
  assert.equal(restored.memory.controllerRecoveries.values().next().value.attempts, 1)
})

for (const shape of ['wrong_force', 'wrong_position', 'wrong_unit', 'missing_surface', 'invalid_locator_surface']) test(`AU residual refuses ${shape} evidence`, async () => {
  const w = world()
  w.game.detailOverride = w.detail(15)
  if (shape === 'wrong_force') w.game.detailOverride.force_index = 2
  if (shape === 'wrong_position') w.game.detailOverride.entity.position.x++
  if (shape === 'wrong_unit') w.game.detailOverride.entity.unit_number++
  if (shape === 'missing_surface') delete w.game.detailOverride.surface_index
  if (shape === 'invalid_locator_surface') w.memory.currentPlan(KEY).exact_target_audit[0].locator.surface_index = 0
  if (shape === 'invalid_locator_surface') await assert.rejects(w.agent.parsePlanMessageChecked(exact('tap_25')), /surface_changed/)
  else {
    await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(exact('tap_25')))
    assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  }
  assert.equal(w.agent.liveObservedExactTarget(15), undefined)
  assert.equal(w.game.sent.length, 0)
})

for (const shape of ['pending', 'native_busy', 'crafting']) test(`AU missing-surface reconciliation preserves ${shape} fence`, async () => {
  const w = world()
  if (shape === 'pending') w.memory.pendingOperation = () => ({ state: 'uncertain' })
  if (shape === 'native_busy') { w.game.status.idle = false; w.game.taskState = 'mining'; w.game.queueLength = 1 }
  if (shape === 'crafting') w.game.craftingStatus = { task_active: true, native_queue: [] }
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(exact('tap_25')))
  assert.equal(w.reads.filter(s => s.includes('"get_entity_status"')).length, 0)
  assert.equal(w.game.sent.length, 0)
})

test('AU fresh native observation trace fences replacement before binding publication', async () => {
  const w = world({ traceHook: ({ row, agent }) => {
    if (row.event === 'entity.observation_bound') agent.traceRequest = { id: 'new-owner', usage: {} }
  } })
  const tool = call('old-owner-read', 15)
  await assert.rejects(w.agent.handleToolBatch({ content: '', tool_calls: [tool] }), /stale|cancel|supersed/i)
  assert.equal(w.agent.liveObservedExactTarget(15), undefined)
})

test('AU cached observation cannot resurrect a binding after invalidation', async () => {
  const w = world()
  const tool = call('first-fresh', 15)
  await w.agent.handleToolBatch({ content: '', tool_calls: [tool] })
  const before = w.reads.filter(s => s.includes('"get_entity_status"')).length
  w.agent.liveEntityObservations.clear()
  await w.agent.handleToolBatch({ content: '', tool_calls: [call('cached', 15)] })
  assert.equal(w.reads.filter(s => s.includes('"get_entity_status"')).length, before)
  assert.equal(w.agent.liveObservedExactTarget(15), undefined)
})

test('AU repeated renewal exhausts durable allowance without another entity probe', async () => {
  const w = world()
  await w.agent.parsePlanMessageChecked(exact('tap_25'))
  const reads = w.reads.filter(s => s.includes('"get_entity_status"')).length
  w.agent.liveEntityObservations.delete('unit:15')
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(exact('tap_25')))
  assert.equal(w.memory.pauseRecord(KEY).pause_reason, 'entity_refresh_allowance_exhausted')
  assert.equal(w.reads.filter(s => s.includes('"get_entity_status"')).length, reads)
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
  assert.equal(w.game.sent.length, 0)
})

test('AU residual continuation collects real output and native callback continues without weakening the checkpoint', async () => {
  const w = world({ collectionCount: 10 })
  // Additional-stock variant, not the historical AU world: four physical smelts
  // from declared fixture ore/fuel produce the missing four plates. One ore
  // remains loaded, and the native drill fact reports the same working cell.
  w.game.furnace.source = { 'copper-ore': 5 }
  w.game.furnace.fuel = { coal: 1 }
  assert.equal(w.game.smelt(4), 4)
  w.game.drillWorking = true
  w.game.researched.add('electronics'); w.game.knownTechnologies.add('electronics')
  const steps = structuredClone(w.held().steps)
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(w.detail(15)))
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(w.detail(16)))
  const commit = w.agent.commitPlan.bind(w.agent)
  let injected = false
  w.agent.commitPlan = async plan => {
    if (!injected && plan.operations?.some(v => v.name === 'supply_entity')) { injected = true; w.agent.liveEntityObservations.delete('unit:15') }
    return commit(plan)
  }
  const ctx = recoverySession(w, { actorId: 6, epoch: 1 })
  await ctx.session.queueEvent(() => w.agent.runTurn(), { reportError: true }); await settle(ctx.session)
  assert.equal(w.game.sent.length, 1, JSON.stringify(ctx.logs))
  const close = w.agent.settleCompletedStepState.bind(w.agent)
  w.agent.settleCompletedStepState = (state, options) => close(state, { ...options, allowContinuation: false })
  w.game.completeBatch()
  ctx.session.onGameLine('[AUTORIO] All operations completed'); await settle(ctx.session)
  assert.equal(w.game.inventory['copper-plate'], 10)
  assert.equal(w.game.inventory.coal, 18)
  assert.deepEqual(w.held().steps, steps)
  assert.equal(w.held().execution.step_progress[w.held().steps[3].step_id].status, 'active', 'retained receipt clauses still require ordinary proof; collection alone is not checkpoint completion')
  assert.equal(w.game.sent.length, 2, JSON.stringify(ctx.logs))
  assert.ok(w.agent.batchInFlight, 'native completion callback has a responsible next batch')
  assert.equal(w.memory.pauseRecord(KEY)?.paused ?? false, false)
  assert.equal(w.providers.length, 3, 'original proposal then two ordinary decisions across native callback; no model identity repair')
})
