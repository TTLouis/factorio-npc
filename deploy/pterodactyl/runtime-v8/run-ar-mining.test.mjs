import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { buildPendingOperation, operationSignature, reconcilePendingOperation, duplicateEffectGuard } from './operation-reconciliation.mjs'
import { progressObligationKey, progressVector } from './executor-progress-audit.mjs'
import { gatherDeficit } from './gather-recovery.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { pinLegacyFixtureSkillContext, FakeFactorio } from './task-loop-fixtures.mjs'
import { recoverySession, settle } from './recovery-loop-fixtures.mjs'

const ar = JSON.parse(fs.readFileSync(new URL('./fixtures/run-ar-mining.json', import.meta.url)))

test('original executor submitPlan and closed reply retain the exact AR resource choices', () => {
  const bodies = ar.model_responses.flatMap(row => row.choices.map(choice => choice.message)).flatMap(message =>
    message.tool_calls?.filter(call => call.function.name === 'submitPlan').map(call => JSON.parse(call.function.arguments))
    ?? (message.content ? [JSON.parse(message.content)] : []))
  assert.ok(bodies.some(body => operationSignature(body.operations) === operationSignature(ar.operations)))
  assert.ok(bodies.some(body => body.operations?.length === 1 && body.operations[0].args.resource_name === 'coal'
    && body.operations[0].args.count === 10))
})

function world({ readHook, traceHook, inventory, memory: snapshot, preflight } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(snapshot ?? ar.memory))
  pinLegacyFixtureSkillContext(memory)
  const game = new FakeFactorio({ inventory: inventory ?? ar.inventory, preflight })
  Object.assign(game.status, { actor_id: 25, epoch: 1, connected_players: 0, surface_index: 1 })
  game.batchId = 1
  game.cancelledBatch = structuredClone(ar.native.last_cancelled_batch)
  game.lastBasicResult = structuredClone(ar.native.basic_operation.last_result)
  game.admissions = structuredClone(ar.native.admission_journal)
  game.admissions[0].batch_id = 1
  const events = []; const providers = []
  const held = () => getActivePlan(memory.planningState(ar.key))
  let agent
  const native = game.command.bind(game)
  game.command = async text => {
    await readHook?.({ text, agent, memory, game })
    // Current FakeFactorio publishes its durable receipt journal separately
    // from last_cancelled_batch. Mirror this fixture's explicitly declared
    // original terminal receipt, including the restart variant's new identity.
    if (text.includes('remote.call("autorio_operations","status")') && game.cancelledBatch) {
      const receipt = game.cancelledBatch
      const generation = receipt.batch_generation ?? game.generation ?? 1
      const ref = receipt.batch_ref ?? `batch-g${generation}-${receipt.batch_id}`
      game.factoryTerminalBatchReceipts.set(ref, { ...receipt, batch_generation: generation, batch_ref: ref, state: 'cancelled' })
    }
    if (text.includes('"autorio_crafting","status"')) return JSON.stringify(game.craftingStatus ?? { task_active: false, native_queue: [] })
    if (text.includes('"mining_details"')) {
      const name = /"mining_details",'([^']+)'/.exec(text)[1]
      return JSON.stringify({ found: true, truncated: false, resources: [{ name, infinite: false,
        products: [{ name, type: 'item', amount: 1 }], hand_mining: { seconds_per_cycle: 1 } }] })
    }
    return native(text)
  }
  agent = new NpcAgentLoop({ allowEphemeralSkillHandoff: true, rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (_messages, context) => {
      if (context.triggerSource === 'step_contract') throw new Error('Fixture stops at the next unbound native-identity checkpoint')
      providers.push(context)
      throw new Error(`AR regression: unexpected model-owned repair ${JSON.stringify(events.slice(-10).map(r => ({ event: r.event, reason: r.data?.reason, preflight: r.data?.preflight })))}`)
    } })
  Object.assign(agent, { active: true, epoch: structuredClone(game.status), lastMemoryKey: ar.key,
    requestInfo: { memoryKey: ar.key, turnId: 1, sender: '<server>', text: ar.memory.plans[0].state.objective },
    traceRequest: { id: 'req_mvlh1w1v_1', usage: {} } })
  agent.agentContext.beginLineage('executor')
  agent.messages = []; agent.baseMessages = []
  agent.behaviorTrace = { emit: async row => { events.push(row); await traceHook?.({ row, agent, game, memory }) } }
  // The fixture changes the world only after a real admitted operation and its
  // explicit native completion below; admission itself creates no inventory.
  game.onMutation = () => { game.taskState = 'mining'; game.status.idle = false }
  const finish = () => {
    const text = game.mutations.at(-1)
    for (const match of text.matchAll(/'gather_resource','([^']+)',(\d+),/g)) game.inventory[match[1]] = (game.inventory[match[1]] ?? 0) + Number(match[2])
    for (const match of text.matchAll(/'mine_resource_at','([^']+)',[-\d.]+,[-\d.]+,(\d+)/g)) game.inventory[match[1]] = (game.inventory[match[1]] ?? 0) + Number(match[2])
    game.taskState = 'idle'; game.status.idle = true
  }
  return { game, memory, agent, events, providers, held, finish }
}

// A separate navigation-origin residual fixture, using the same real Session
// failure/completion scheduling as AR. Native-origin metadata below is a fake
// game's deterministic output; the real-engine runner independently proves it.
function navigationWorld({ coalPosition = { x: 10.5, y: 0.5 }, ...options } = {}) {
  const w = world(options)
  const original = w.memory.pendingOperations(ar.key)[0]
  // Preserve the frozen AR operation identity; changing its radius would be
  // correctly refused by the canonical pending-operation reducer.
  const ops = structuredClone(ar.operations)
  const origin = { x: 0, y: 0 }
  const witnesses = ops.map((op, index) => ({ origin, position: index ? coalPosition : { x: -72.5, y: 0.5 },
    radius: op.args.search_radius, amount: 100, actor_id: 25, surface_index: 1, force_index: 1, tick: 100 }))
  const built = buildPendingOperation({ requestId: original.request_id, operationKey: original.operation_key,
    attemptId: original.attempt_id, ordinal: original.ordinal, protocolVersion: 2, operations: ops,
    actor: original.actor, surfaceIndex: 1, goalId: original.goal_id, planId: original.plan_id, stepId: original.step_id,
    baseline: original.baseline, now: original.sent_at, preflight: witnesses.map((resource_search, i) => ({
      ok: true, operation: 'gather_resource', identity: ops[i].args.resource_name, resource_search })) })
  w.memory.updatePendingOperation(ar.key, { operations: built.operations, signature: built.signature }, original.operation_key)
  const record = w.game.admissions[0]
  record.signature = built.signature
  record.tick = Math.max(record.tick, 100)
  for (const slot of record.slots) slot.gather_search_origin = { ...origin, surface_index: 1, force_index: 1, tick: record.tick }
  w.game.cancelledBatch.reason = 'navigation_no_target'
  w.game.cancelledBatch.tasks_started = 3
  w.game.cancelledBatch.started_count = Math.max(3, w.game.cancelledBatch.started_count)
  const command = w.game.command.bind(w.game)
  w.game.command = async text => {
    const raw = await command(text)
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify({ ...JSON.parse(raw),
      actor_surface_index: w.game.status.surface_index, actor_force_index: w.game.status.force_index ?? 1 })
    return raw
  }
  return w
}

test('queued gather-origin residual runs real Session failure -> exact missing-only native admission -> ordinary completion callback', async () => {
  const w = navigationWorld()
  const native = JSON.parse(await w.game.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'))
  const held = w.memory.pendingOperations(ar.key)[0]
  const verdict = reconcilePendingOperation(held, { status: native, actor: w.game.status })
  assert.equal(verdict.reason, 'exact_terminal_gather_cancelled', JSON.stringify({ held, native, verdict }))
  const semanticGoal = () => { const g = w.memory.planningState(ar.key).goal; return { goal_id: g.goal_id, objective: g.objective, definition: g.definition } }
  const immutable = structuredClone({ goal: semanticGoal(), steps: w.held().steps })
  const ctx = recoverySession(w, { actorId: 25, epoch: 1 })
  ctx.session.onGameLine('[AUTORIO] [ERROR] navigation failed: no_target; dependent operations cancelled')
  await settle(ctx.session)
  assert.equal(w.game.mutations.length, 1)
  assert.match(w.game.mutations[0], /'mine_resource_at','coal',10.5,0.5,10/)
  assert.doesNotMatch(w.game.mutations[0], /'gather_resource'|'mine_resource_at','copper-ore'/)
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.equal(w.game.inventory.coal ?? 0, 0, 'correction admission is not acquired stock')
  assert.equal(w.providers.length, 0)
  assert.deepEqual(w.held().steps, immutable.steps)
  assert.deepEqual(semanticGoal(), immutable.goal)
  const residual = w.events.find(row => row.event === 'gather.residual_detected')
  assert.equal(residual.data.cancellation_reason, 'navigation_no_target')
  assert.deepEqual(residual.data.slot_outcomes.map(row => row.state), ['completed', 'navigation_failed_before_acquisition'])
  // Bound this fixture at the next ordinary checkpoint transition, as AR does;
  // next-step authoring is unrelated to the native correction being tested.
  const close = w.agent.settleCompletedStepState.bind(w.agent)
  w.agent.settleCompletedStepState = (state, options) => close(state, { ...options, allowContinuation: false })
  w.finish()
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  const afterNative = JSON.parse(await w.game.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'))
  assert.equal(w.held().active_step_index, 1, JSON.stringify({ inventory: w.game.inventory,
    pending: w.memory.pendingOperations(ar.key), verdicts: w.memory.pendingOperations(ar.key).map(p => reconcilePendingOperation(p, { status: afterNative, actor: w.game.status })),
    native: afterNative, events: w.events.slice(-24), sessionLogs: ctx.logs }))
  assert.equal(w.memory.pendingOperations(ar.key).length, 0)
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.equal(w.game.inventory.coal, 10)
  assert.ok(w.events.some(row => row.event === 'gather.recovery_continued'))
})

test('nested exact-location correction cannot escape the originally admitted gather disk', async () => {
  const w = navigationWorld({ coalPosition: { x: 1023.5, y: 0.5 }, preflight: text => text.includes("'mine_resource_at'")
    ? { ok: false, code: 'resource_source_not_found', resource_correction: { resource_name: 'coal',
      position: { x: 1025.5, y: 0.5 }, origin: { x: 1023.5, y: 0.5 }, radius: 5, surface_index: 1, amount: 100 } }
    : { ok: true } })
  const ctx = recoverySession(w, { actorId: 25, epoch: 1 })
  ctx.session.onGameLine('[AUTORIO] [ERROR] navigation failed: no_target; dependent operations cancelled')
  await settle(ctx.session)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_preflight_resource_source_not_found')
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.events.filter(row => row.event === 'mining.location_corrected').length, 0)
})

for (const boundary of ['gather.residual_detected', 'gather.reconciled']) test(`navigation-origin recovery ownership cannot cross cancellation during ${boundary}`, async () => {
  const w = navigationWorld({ traceHook: ({ row, agent }) => { if (row.event === boundary) agent.cancel('user_stop') } })
  await assert.rejects(w.agent.failed('navigation:no_target'), /cancelled|superseded|stale/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
})

test('duplicate same-resource gather authority cannot select an arbitrary source witness', () => {
  const w = navigationWorld()
  const pending = w.memory.pendingOperations(ar.key)[0]
  pending.operations.push(structuredClone(pending.operations[1]))
  assert.equal(gatherDeficit(pending, w.held().steps[0].completion_contract, new Map(Object.entries(ar.inventory))), undefined)
})

test('force replacement during navigation-origin reconciliation cannot mine under the replacement force', async () => {
  const w = navigationWorld({ traceHook: ({ row, game }) => { if (row.event === 'gather.residual_detected') game.status.force_index = 2 } })
  await assert.rejects(w.agent.failed('navigation:no_target'), /gather_recovery_force_changed|cancelled|superseded|stale/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
})

test('exact AR cancelled copper/coal batch is terminal partial, never success or blind replay', () => {
  const w = world()
  const pending = w.memory.pendingOperations(ar.key)[0]
  assert.equal(operationSignature(ar.operations), pending.signature)
  const result = reconcilePendingOperation(pending, { status: ar.native, actor: { actor_id: 25, epoch: 1 } })
  assert.equal(result.reason, 'exact_terminal_gather_cancelled')
  assert.equal(result.verdict, 'admitted_partial')
  assert.equal(duplicateEffectGuard(pending, { operations: ar.operations }).refuse, true, 'receipt alone cannot release the hold')
  assert.deepEqual(gatherDeficit(pending, w.held().steps[0].completion_contract, new Map(Object.entries(ar.inventory))), [ar.operations[1]])
})

test('exact AR residual mining_rejected drives Session failure -> harness deficit -> native callback without model repair', async () => {
  const w = world()
  const steps = structuredClone(w.held().steps)
  const ctx = recoverySession(w, { actorId: 25, epoch: 1 })
  ctx.session.onGameLine('[AUTORIO] [ERROR] mining failed: mining_rejected; dependent operations cancelled')
  await settle(ctx.session)
  assert.equal(w.game.mutations.length, 1, JSON.stringify({ events: w.events.slice(-10), logs: ctx.logs }))
  assert.match(w.game.mutations[0], /'gather_resource','coal',10,1024/)
  assert.doesNotMatch(w.game.mutations[0], /'gather_resource','copper-ore'/)
  assert.equal(w.game.inventory.coal ?? 0, 0, 'admission is not completion')
  assert.equal(w.providers.length, 0)
  assert.deepEqual(w.held().steps, steps)
  assert.equal(w.held().active_step_index, 0)
  assert.ok(w.events.some(row => row.event === 'gather.recovery_continued' && row.data.request_id === 'req_mvlh1w1v_1'))
  // Preserve the exact step's final completion proof while avoiding a synthetic
  // provider call to author the unrelated next-step checkpoint in this fixture.
  const close = w.agent.settleCompletedStepState.bind(w.agent)
  w.agent.settleCompletedStepState = (state, options) => close(state, { ...options, allowContinuation: false })
  w.finish()
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.equal(w.game.inventory.coal, 10)
  assert.equal(w.memory.pendingOperations(ar.key).length, 0)
  assert.ok(analyzeBehaviorTrace(ar.reconciliation_events).findings.some(row => row.signature === 'gather_partial_unrecovered'))
  assert.equal(analyzeBehaviorTrace([...ar.reconciliation_events, ...w.events]).findings.filter(row => row.signature === 'gather_partial_unrecovered').length, 0)
})

test('partial coal yield is reconciled to only its missing amount through the real admission path', async () => {
  const w = world({ inventory: { ...ar.inventory, coal: 4 } })
  await w.agent.failed('mining:mining_rejected')
  assert.match(w.game.mutations[0], /'gather_resource','coal',6,1024/)
  assert.equal(w.providers.length, 0)
})

test('a terminal failure whose fresh inventory already meets the checkpoint advances once without replay', async () => {
  const w = world({ inventory: { ...ar.inventory, coal: 10 } })
  // End this fixture at the newly activated identity-dependent furnace step;
  // the real close/evaluator executes, only unrelated next-step authoring ends.
  w.agent.continueAfterFreshStepClose = async fresh => ({ gather: 'checkpoint_closed', fresh, operations: [] })
  const result = await w.agent.failed('mining:mining_rejected')
  assert.deepEqual(result.operations, [])
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.held().execution.step_progress[w.held().steps[0].step_id].status, 'completed')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.ok(w.events.some(row => row.event === 'plan.step_closed_on_fresh_read'))
  assert.ok(w.events.some(row => row.event === 'gather.checkpoint_closed' && row.data.reason === 'verified_checkpoint_closed'
    && row.data.operation_key === ar.native.admission_journal[0].operation_key))
  assert.equal(analyzeBehaviorTrace([...ar.reconciliation_events, ...w.events]).findings.filter(row => row.signature === 'gather_partial_unrecovered').length, 0)
})

test('stock changing after an all-met read keeps the failed recovery visible until verified checkpoint closure', async () => {
  const w = world({ inventory: { ...ar.inventory, coal: 10 }, traceHook: ({ row, game }) => {
    // External stock change between deficit calculation and the ordinary fresh
    // evaluator: the first read alone cannot grant settlement authority.
    if (row.event === 'gather.reconciled') game.inventory.coal = 0
  } })
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_checkpoint_changed')
  assert.equal(w.events.filter(row => row.event === 'gather.checkpoint_closed').length, 0)
  for (const events of [w.events, w.events.slice(0, w.events.findIndex(row => row.event === 'gather.reconciled') + 1)]) {
    assert.ok(analyzeBehaviorTrace([...ar.reconciliation_events, ...events]).findings.some(row => row.signature === 'gather_partial_unrecovered'))
  }
})

test('restart/restage preserves the gather recovery allowance and explicit exhaustion', async () => {
  let w = world()
  for (let attempt = 0; attempt < 3; attempt++) {
    await w.agent.failed(`mining:mining_rejected ${attempt}`)
    if (attempt === 2) break
    const pending = w.memory.pendingOperations(ar.key)[0]
    assert.ok(pending, JSON.stringify({ attempt, pause: w.memory.pauseRecord(ar.key), events: w.events.filter(r => r.event.startsWith('gather.')) }))
    const record = w.game.admissions.at(-1)
    const failed = { ...structuredClone(ar.native.last_cancelled_batch), batch_id: w.game.batchId,
      batch_ref: `batch-g1-${w.game.batchId}`, task_count: 2, task_types: ['walking_to_entity', 'mining'], tasks_started: 2, tick: Date.now() + attempt }
    record.state = 'uncertain'
    const snapshot = w.memory.snapshot()
    const next = world({ memory: snapshot })
    next.game.batchId = w.game.batchId
    next.game.admissions = [record]; next.game.cancelledBatch = failed
    next.game.lastBasicResult = { ...next.game.lastBasicResult, tick: failed.tick }
    assert.equal(next.memory.pendingOperations(ar.key)[0].operation_key, pending.operation_key)
    w = next
  }
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_exhausted')
  assert.ok(w.events.some(row => row.event === 'gather.recovery_exhausted'))
})

for (const [name, edit] of [
  ['wrong actor', s => { s.admission_journal[0].actor_id++ }],
  ['wrong signature', s => { s.admission_journal[0].signature = 'wrong' }],
  ['wrong ordinal', s => { s.admission_journal[0].ordinal++ }],
  ['native busy', s => { s.task_state = 'mining' }],
  ['queued work', s => { s.queue_length = 1 }],
  ['active batch', s => { s.active_batch = s.last_cancelled_batch }],
  ['generation change', s => { s.batch_generation++ }],
  ['mixed effects', s => { s.admission_journal[0].slots[0].operation = 'move_items_exact' }],
  ['receipt missing', s => { s.receipt_journal = [] }],
  ['task witness mismatch', s => { s.receipt_journal[0].task_types[0] = 'placing' }],
]) test(`gather terminal reconciliation fences ${name}`, () => {
  const w = world(); const status = structuredClone(ar.native); edit(status)
  assert.notEqual(reconcilePendingOperation(w.memory.pendingOperations(ar.key)[0], { status, actor: { actor_id: 25, epoch: 1 } }).reason, 'exact_terminal_gather_cancelled')
})

for (const boundary of ['inventory', 'trace']) test(`supersession during ${boundary} cannot clear, charge or mutate replacement work`, async () => {
  let changed = false
  const mutate = ({ agent }) => { if (!changed) { changed = true; agent.traceRequest = { id: 'replacement', usage: {} } } }
  const w = world(boundary === 'inventory' ? { readHook: args => { if (args.text.includes('"get_inventory_items"')) mutate(args) } }
    : { traceHook: args => { if (args.row.event === 'gather.residual_detected') mutate(args) } })
  await assert.rejects(w.agent.failed('mining:mining_rejected'), /cancelled|superseded|stale/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
  assert.equal(w.memory.gatherRecoveries?.size ?? 0, 0)
  assert.equal(w.agent.traceRequest.id, 'replacement')
})

test('unreadable inventory never becomes empty, recovery pauses without replay', async () => {
  const w = world()
  const command = w.game.command.bind(w.game)
  w.game.command = text => text.includes('"get_inventory_items"') ? 'clipped' : command(text)
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_facts_unproven')
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
})

test('nearby coordinate correction remains harness-owned, same resource and step, with executor reminder', async () => {
  const op = { name: 'mine_resource_at', args: { resource_name: 'coal', x: -89, y: -30, count: 10 } }
  const candidate = { resource_name: 'coal', position: { x: -90.5, y: -30.5 }, origin: { x: -89, y: -30 }, radius: 5, surface_index: 1, amount: 100 }
  const w = world({ preflight: text => text.includes("'mine_resource_at'") && text.includes("['x']=-89")
    ? { ok: false, code: 'resource_source_not_found', resource_correction: candidate } : { ok: true } })
  w.memory.clearPendingOperation(ar.key, { operationKey: ar.native.admission_journal[0].operation_key })
  w.game.admissions = []; w.game.cancelledBatch = undefined
  await w.agent.commitPlan({ chatMessage: '', stepId: w.held().steps[0].step_id, plan: [], currentStep: 0, operations: [op] })
  assert.equal(w.game.mutations.length, 1)
  assert.match(w.game.mutations[0], /'mine_resource_at','coal',-90.5,-30.5,10/)
  assert.equal(w.providers.length, 0)
  assert.ok(w.agent.messages.some(row => row.content?.includes('position reminder')))
  assert.ok(w.events.some(row => row.event === 'mining.location_corrected'))
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  const packet = buildHandoffPacket({ planningState: restored.planningState(ar.key), role: 'executor', checkpoint: 'C4' })
  assert.match(packet.text, /Position reminder: coal/)
})

test('residual retry preflight failure is harness-paused and cannot enter model repair', async () => {
  const w = world({ preflight: () => ({ ok: false, code: 'resource_source_not_found' }) })
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.providers.length, 0)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_preflight_resource_source_not_found')
})

test('crash after source settlement preserves a claimed recovery and restores to a visible pause', async () => {
  const w = world()
  const persist = w.agent.persistState.bind(w.agent)
  let snapshot
  w.agent.persistState = async options => {
    if (!w.memory.pendingOperations(ar.key).length && w.memory.gatherRecoveries?.size) {
      snapshot = structuredClone(w.memory.snapshot())
      throw new Error('injected process exit after source settlement')
    }
    return persist(options)
  }
  await assert.rejects(w.agent.failed('mining:mining_rejected'), /injected process exit/)
  assert.ok(snapshot)
  const restored = world({ memory: snapshot })
  await restored.agent.runTurn()
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.game.mutations.length, 0)
  assert.equal(restored.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_interrupted')
})

for (const boundary of ['gather.residual_detected', 'gather.reconciled', 'operations.admit']) test(`same-epoch surface replacement during ${boundary} cannot mine a replacement surface`, async () => {
  const w = world({ traceHook: ({ row, game }) => { if (row.event === boundary) game.status.surface_index = 2 } })
  // The fake models the native begin fence in addition to the host await fences.
  const native = w.game.command.bind(w.game)
  w.game.command = async text => {
    if (text.includes('"begin",helpers.json_to_table') && text.includes('surface_index')) {
      const encoded = /"begin",helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(text)[1]
      const identity = JSON.parse(JSON.parse(encoded))
      if (identity.surface_index !== w.game.status.surface_index) { w.game.beginRefusal = 'stale_actor_surface' }
    }
    return native(text)
  }
  await w.agent.failed('mining:mining_rejected').catch(error => assert.match(error.message, /surface|stale|epoch|admission/i))
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
})

for (const kind of ['follow', 'crafting', 'condition_wait']) test(`existing ${kind} retains its wake and cannot be replaced by gathering recovery`, async () => {
  const w = world()
  const native = w.game.command.bind(w.game)
  w.game.command = text => kind === 'follow' && text.includes('"autorio_follow","status"')
    ? JSON.stringify({ active: true }) : native(text)
  if (kind === 'crafting') w.game.craftingStatus = { task_active: true, native_queue: [{ recipe: 'iron-gear-wheel', count: 1 }] }
  if (kind === 'condition_wait') w.memory.currentPlan(ar.key).condition_wait = { state: 'active' }
  const result = await w.agent.failed('mining:mining_rejected')
  assert.equal(result.gather, 'deferred')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
})

test('a restored current-epoch terminal batch recovers on an executor wake even when the native failure callback was lost', async () => {
  const w = world()
  await w.agent.runTurn()
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.providers.length, 0)
  assert.match(w.game.mutations[0], /'gather_resource','coal',10,1024/)
})

test('a busy native queue retains its callback without a provider wake or acquisition replay', async () => {
  const w = world()
  w.game.taskState = 'mining'; w.game.status.idle = false
  const result = await w.agent.failed('late duplicate failure callback')
  assert.equal(result.gather, 'deferred')
  assert.equal(w.providers.length, 0)
  assert.equal(w.game.mutations.length, 0)
})

test('a new condition wait during a recovery trace preserves the original effect hold and wait wake', async () => {
  const w = world({ traceHook: ({ row, memory }) => {
    if (row.event === 'gather.residual_detected') memory.currentPlan(ar.key).condition_wait = { state: 'active' }
  } })
  const result = await w.agent.failed('mining:mining_rejected')
  assert.equal(result.gather, 'deferred')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
  assert.equal(w.memory.gatherRecoveries?.size ?? 0, 0)
})

for (const change of ['amendment', 'stop']) test(`${change} arriving during inventory reconciliation cannot release or replay effects`, async () => {
  let once = false
  const w = world({ readHook: ({ text, agent }) => {
    if (once || !text.includes('"get_inventory_items"')) return
    once = true
    if (change === 'stop') agent.cancel('user_stop')
    else agent.currentPendingAmendment = () => ({ text: 'new instructions' })
  } })
  await assert.rejects(w.agent.failed('mining:mining_rejected'), /authority|cancel|superseded|stale/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pendingOperations(ar.key).length, 1)
})

test('corrupt restored recovery accounting cannot renew an allowance', async () => {
  const snapshot = structuredClone(ar.memory)
  snapshot.gather_recoveries = [['bad', [{ step: 'bad', state: 'unknown' }]]]
  const w = world({ memory: snapshot })
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_ledger_unreadable')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
})

test('missing surface correlation cannot authorize acquiring a deficit on another surface', async () => {
  const snapshot = structuredClone(ar.memory)
  for (const record of snapshot.planning_states[0].state.operation_ledger.records) delete record.surface_index
  delete snapshot.planning_states[0].state.run.pending_operation.surface_index
  const w = world({ memory: snapshot })
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_surface_unproven')
  assert.equal(w.game.mutations.length, 0)
})

test('native begin refusal during a harness correction cannot enter model-managed retries', async () => {
  const w = world()
  w.game.beginRefusal = 'stale_actor_surface'
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.memory.pauseRecord(ar.key).pause_reason, 'gather_recovery_native_admission_refused')
  assert.equal(w.game.inventory.coal ?? 0, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.game.taskState, 'idle')
})

test('lost acknowledgement of an admitted correction preserves its native callback and never replays the batch', async () => {
  const w = world()
  let dropped = false
  const native = w.game.command.bind(w.game)
  w.game.command = async text => {
    const result = await native(text)
    if (!dropped && text.includes('local ok,result=pcall')) { dropped = true; throw new Error('RCON acknowledgement missing') }
    return result
  }
  await w.agent.failed('mining:mining_rejected')
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.providers.length, 0)
  assert.ok(w.events.some(row => row.event === 'operations.ack' && row.data.reconciled === true))
})

for (const variant of ['far', 'wrong_surface', 'wrong_resource']) test(`coordinate correction rejects a ${variant} suggestion through ordinary admission`, async () => {
  const op = { name: 'mine_resource_at', args: { resource_name: 'coal', x: 0, y: 0, count: 10 } }
  const candidate = { resource_name: variant === 'wrong_resource' ? 'copper-ore' : 'coal',
    position: { x: variant === 'far' ? 6 : 1, y: 0 }, origin: { x: 0, y: 0 }, radius: 5,
    surface_index: variant === 'wrong_surface' ? 2 : 1, amount: 100 }
  const w = world({ preflight: () => ({ ok: false, code: 'resource_source_not_found', resource_correction: candidate }) })
  w.memory.clearPendingOperation(ar.key, { operationKey: ar.native.admission_journal[0].operation_key })
  await w.agent.commitPlan({ chatMessage: '', stepId: w.held().steps[0].step_id, plan: [], currentStep: 0, operations: [op] })
    .catch(error => assert.match(error.message, /AR regression|blocked|preflight/i))
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.filter(row => row.event === 'mining.location_corrected').length, 0)
})


test('progress auditor composes with exact terminal partial gather reconciliation before deficit admission', async () => {
  const w = world()
  w.agent.executorProgressAudit = true
  w.agent.allowEphemeralProgressAudit = true
  const plan = w.held(); const step = plan.steps[plan.active_step_index]
  const pending = w.memory.pendingOperations(ar.key)[0]
  const contract = step.completion_contract
  const beforeFacts = await w.agent.completionFactsForContract(contract, undefined, [], { committedIdentity: true })
  // Explicit replay substitution: original pre-attempt facts are not in AR's
  // snapshot. Use zero relevant stock to exercise an advancing partial attempt.
  for (const fact of Object.values(beforeFacts)) if (Number.isFinite(fact.current)) fact.current = 0
  const before = progressVector(contract, beforeFacts)
  assert.ok(before)
  w.memory.progressAudits = new Map([[JSON.stringify([ar.key, plan.goal_id, progressObligationKey(contract, step.obligations?.preserve)]), {
    version: 1, attempts: 1, reviews: 0, state: 'claimed', baseline: before, previous: before, peak: { ...before }, history: [], blocked: [],
    claim: { operation_key: pending.operation_key, signature: pending.signature, actor: pending.actor,
      plan_id: pending.plan_id, step_id: pending.step_id, attempt_id: pending.attempt_id, ordinal: pending.ordinal, operations: ar.operations },
  }]])
  try { await w.agent.failed('mining:mining_rejected') } catch (error) { throw new Error(JSON.stringify(w.events.slice(-10)), { cause: error }) }
  assert.equal(w.game.mutations.length, 1)
  assert.match(w.game.mutations[0], /'gather_resource','coal',10,1024/)
  assert.doesNotMatch(w.game.mutations[0], /'gather_resource','copper-ore'/)
  const episode = [...w.memory.progressAudits.values()][0]
  assert.equal(episode.history[0].decision, 'progress')
  assert.equal(episode.attempts, 2)
  assert.equal(w.providers.length, 0)
})
