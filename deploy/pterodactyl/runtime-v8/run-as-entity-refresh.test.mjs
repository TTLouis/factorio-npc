import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FurnaceFactorio, recoverySession, settle } from './recovery-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/run-as-entity-refresh.json', import.meta.url)))
const KEY = captured.key
const message = tap => ({ content: captured.responses.find(row => row.tap_request_id === tap).choices[0].message.content })
const stock = rows => Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.name, row.count]))

function world({ snapshot, readHook, traceHook, output = 10, provider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(snapshot ?? captured.memory))
  // Original pre-refusal planning history; committed step bodies/IDs and run
  // status are copied, never reconstructed into a cleaner plan.
  const machine = captured.machine
  const game = new FurnaceFactorio({ connectedPlayers: 0, inventory: captured.inventory,
    furnace: { unit_number: machine.id, position: machine.position, fuel: stock(machine.inventories.fuel),
      source: {}, output: { 'copper-plate': output } } })
  Object.assign(game.status, { actor_id: 12, epoch: 1, surface_index: 1, connected_players: 0 })
  game.batchId = 7 // AS's last native batch; new operations must not impersonate old receipts.
  game.researched.add('electronics')
  game.knownTechnologies.add('electronics')
  const events = []; const providers = []
  let agent
  const native = game.command.bind(game)
  game.command = async text => {
    await readHook?.({ text, game, agent, memory })
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ actor: { actor_id: game.status.actor_id }, surface_index: game.status.surface_index, force_index: game.forceIndex ?? 1 })
    if (text.includes('"autorio_crafting","status"')) return JSON.stringify(game.craftingStatus ?? { task_active: false, native_queue: [] })
    if (text.includes('"get_entity_status"')) {
      const detail = game.entityRead()
      Object.assign(detail, { actor_id: 12, observed_tick: 31234, surface_index: 1, force_index: 1 })
      Object.assign(detail.entity, { position: machine.position, force: 'player', inventories_truncated: false, inventory_items_truncated: false })
      return typeof game.entityOverride === 'string' ? game.entityOverride : JSON.stringify(game.entityOverride ?? detail)
    }
    if (text.includes('"recipe_details",\'copper-plate\'')) return JSON.stringify(captured.native_recipe)
    return native(text)
  }
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (messages, context) => {
      providers.push(context)
      if (provider) return provider(messages, context)
      if (providers.length === 1) return message('tap_24')
      throw new Error('AS fixture forbids model-owned repair')
    } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: KEY,
    requestInfo: { memoryKey: KEY, turnId: 1, sender: '<server>', text: captured.memory.plans[0].state.objective },
    traceRequest: { id: 'req_mvlkzpjx_1', usage: {} } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => { events.push(row); await traceHook?.({ row, game, agent, memory }) } }
  agent.messages = []; agent.baseMessages = []
  const held = () => getActivePlan(memory.planningState(KEY))
  return { memory, game, agent, events, providers, held }
}

test('original AS mutation reply renews furnace 19 and collects existing ten plates instead of replaying supply', async () => {
  const w = world()
  const steps = structuredClone(w.held().steps)
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  await w.agent.commitPlan(plan)
  assert.equal(w.game.sent.length, 1)
  assert.deepEqual(w.game.sent[0].operations, [{ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: 19, max_count: 10, to_entity: false } }])
  assert.equal(w.providers.length, 0)
  assert.equal(w.game.inventory['copper-plate'] ?? 0, 0, 'admission is not completion')
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.deepEqual(w.held().steps, steps)
})

test('original AS targeted observation reply can refresh a durable furnace locator without an entity checkpoint', async () => {
  const w = world({ provider: async () => ({ content: JSON.stringify({ chatMessage: '', stepId: w.held().steps[3].step_id, operations: [] }) }) })
  const result = await w.agent.handleObservationRequest(message('tap_22'), {
    generation: w.agent.generation, attribution: undefined, current: w.game.status, round: 1, recoveryAttempt: 0, allowTools: false,
  })
  assert.equal(result._sglunaObservationRefusal, undefined)
  assert.equal(w.agent.liveObservedExactTarget(19)?.name, 'stone-furnace')
  assert.equal(w.game.sent.length, 0, 'a read cannot admit gameplay')
  assert.equal(w.memory.targetedObservationLedger.size, 1)
})

test('residual binding loss after parsing drives the real Session admission and native completion without a model repair', async () => {
  const w = world()
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify({ ...w.game.entityRead(), surface_index: 1 }))
  const commit = w.agent.commitPlan.bind(w.agent)
  let injected = false
  w.agent.commitPlan = async plan => {
    if (!injected && plan.operations?.some(op => op.name === 'supply_entity')) {
      injected = true
      w.agent.liveEntityObservations.clear() // Deliberately bypass prevention after parse.
    }
    return commit(plan)
  }
  const ctx = recoverySession(w, { actorId: 12, epoch: 1 })
  await ctx.session.queueEvent(() => w.agent.runTurn(), { reportError: true })
  await settle(ctx.session)
  assert.equal(w.game.sent.length, 1, JSON.stringify({ logs: ctx.logs, events: w.events.slice(-8) }))
  assert.equal(w.game.sent[0].operations[0].name, 'move_items_exact')
  assert.equal(w.providers.length, 1, 'only the original AS proposal; no corrective model request')
  assert.ok(w.events.some(row => row.event === 'entity.refresh_detected' && row.data.source === 'admission_residual'))
  const close = w.agent.settleCompletedStepState.bind(w.agent)
  w.agent.settleCompletedStepState = (state, options) => close(state, { ...options, allowContinuation: false })
  w.game.completeBatch()
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  assert.equal(w.game.inventory['copper-plate'], 10)
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.equal(w.game.furnace.fuel.coal, 9)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.equal(w.held().execution.step_progress[w.held().steps[3].step_id].status, 'completed', JSON.stringify(ctx.logs))
  assert.ok(w.events.some(row => row.event === 'entity.refresh_settled'))
  assert.ok(analyzeBehaviorTrace(captured.failure_events).findings.some(row => row.signature === 'exact_entity_binding_unrecovered'))
  assert.equal(analyzeBehaviorTrace(w.events).findings.filter(row => row.signature === 'exact_entity_binding_unrecovered').length, 0)
  assert.equal(analyzeBehaviorTrace([...captured.failure_events, ...w.events]).findings.filter(row => row.signature === 'exact_entity_binding_unrecovered').length, 1,
    'Old trace rows with missing owner fields cannot be cleared by a different execution')
})

for (const kind of ['request', 'epoch', 'surface', 'step', 'amendment']) test(`refresh fences ${kind} supersession during native read`, async () => {
  let edited = false
  const w = world({ readHook: ({ text, agent, game, memory }) => {
    if (!text.includes('"get_entity_status"') || edited) return
    edited = true
    if (kind === 'request') agent.traceRequest = { id: 'replacement' }
    if (kind === 'epoch') game.status.epoch++
    if (kind === 'surface') game.status.surface_index = 2
    if (kind === 'step') getActivePlan(memory.planningState(KEY)).active_step_index = 2
    if (kind === 'amendment') agent.currentPendingAmendment = () => ({ pending: true })
  } })
  await assert.rejects(w.agent.parsePlanMessageChecked(message('tap_24')), /cancelled|superseded|epoch|surface|scope|stale/i)
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.agent.liveObservedExactTarget(19), undefined)
})

for (const kind of ['unreadable', 'replacement', 'wrong-force', 'wrong-surface', 'wrong-position', 'truncated']) test(`refresh refuses ${kind} native identity`, async () => {
  const w = world()
  const value = { ...w.game.entityRead(), actor_id: 12, surface_index: 1, force_index: 1 }
  Object.assign(value.entity, { position: { x: 55, y: 63 } })
  if (kind === 'unreadable') w.game.entityOverride = 'clipped'
  else {
    if (kind === 'replacement') value.entity.unit_number = 20
    if (kind === 'wrong-force') value.force_index = 2
    if (kind === 'wrong-surface') value.surface_index = 2
    if (kind === 'wrong-position') value.entity.position.x++
    if (kind === 'truncated') { w.game.entityOverride = ' '.repeat(65537); }
    else w.game.entityOverride = value
  }
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  assert.equal(w.agent.liveObservedExactTarget(19), undefined)
})

test('an interrupted claimed refresh survives restore and pauses without a new read or model request', async () => {
  const w = world()
  let saved
  w.agent.persistState = async () => { saved = w.memory.snapshot(); throw new Error('injected process exit') }
  await assert.rejects(w.agent.parsePlanMessageChecked(message('tap_24')), /injected process exit/)
  assert.ok(saved.entity_refresh_claims.length)
  const restored = world({ snapshot: saved })
  await restored.agent.runTurn()
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.game.sent.length, 0)
  assert.equal(restored.memory.pauseRecord(KEY).pause_reason, 'entity_refresh_interrupted')
})

test('output lost after renewal cannot turn collection-only recovery into feeding or crafting', async () => {
  let reads = 0
  const w = world({ readHook: ({ text, game }) => {
    if (text.includes('"get_entity_status"') && ++reads === 2) game.furnace.output = {}
  } })
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.game.inventory['copper-ore'], 10)
  assert.equal(w.memory.pauseRecord(KEY).pause_reason, 'production_collection_stock_unproven')
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.equal([...restored.productionTasks.values()][0].collection_only, true)
})

test('fresh inventory reconciliation collects only four missing plates and never re-supplies the existing ten', async () => {
  const w = world()
  w.game.inventory['copper-plate'] = 6
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(w.game.sent.length, 1)
  assert.equal(w.game.sent[0].operations[0].args.max_count, 4)
  assert.equal(w.game.sent[0].operations[0].args.to_entity, false)
  w.game.completeBatch()
  assert.equal(w.game.inventory['copper-plate'], 10)
  assert.equal(w.game.furnace.output['copper-plate'], 6)
})

for (const boundary of ['tool.call', 'tool.result', 'entity.refresh_bound']) test(`native work appearing during ${boundary} cannot publish a usable continuation`, async () => {
  const w = world({ traceHook: ({ row, game }) => {
    if (row.event === boundary) { game.status.idle = false; game.taskState = 'mining'; game.queueLength = 1 }
  } })
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  const result = await w.agent.commitPlan(plan)
  assert.equal(result.entityRefresh, 'deferred')
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.agent.liveObservedExactTarget(19), undefined)
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
})

for (const kind of ['queue', 'follow', 'crafting', 'condition_wait', 'pending']) test(`existing ${kind} fences automatic refresh before a probe`, async () => {
  let probes = 0
  const w = world({ readHook: ({ text }) => { if (text.includes('"get_entity_status"')) probes++ } })
  if (kind === 'queue') { w.game.taskState = 'walking'; w.game.queueLength = 1; w.game.status.idle = false }
  if (kind === 'follow') {
    const native = w.game.command.bind(w.game)
    w.game.command = text => text.includes('"autorio_follow","status"') ? JSON.stringify({ active: true }) : native(text)
  }
  if (kind === 'crafting') w.game.craftingStatus = { task_active: false, native_queue: [{ name: 'iron-plate', count: 1 }] }
  if (kind === 'condition_wait') w.memory.currentPlan(KEY).condition_wait = { state: 'active' }
  if (kind === 'pending') w.memory.pendingOperation = () => ({ state: 'unreconciled' })
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(probes, 0)
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.memory.controllerRecoveries?.size ?? 0, 0)
})

test('pending native uncertainty introduced by a trace cannot escape into refresh admission', async () => {
  const w = world({ traceHook: ({ row, memory }) => {
    if (row.event === 'tool.call') {
      memory.pendingOperation = () => ({ state: 'unreconciled' })
      memory.pendingOperations = () => [{ state: 'unreconciled' }]
    }
  } })
  await w.agent.commitPlan(await w.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.agent.liveObservedExactTarget(19), undefined)
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
})

test('a stale typed-observation disposition is discarded before a replacement request commits', async () => {
  const w = world()
  w.game.taskState = 'walking'; w.game.queueLength = 1
  await w.agent.handleObservationRequest(message('tap_22'), {
    generation: w.agent.generation, attribution: undefined, current: w.game.status, round: 1, recoveryAttempt: 0, allowTools: false,
  })
  assert.equal(w.agent.pendingEntityRefresh.action, 'deferred')
  w.agent.traceRequest = { id: 'replacement', usage: {} }
  w.game.taskState = 'idle'; w.game.queueLength = 0
  w.agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(w.game.entityRead()))
  await w.agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, stepId: w.held().steps[3].step_id,
    operations: [{ name: 'move_items_exact', args: { unit_number: 19, item_name: 'copper-plate', max_count: 10, to_entity: false } }] })
  assert.equal(w.game.sent.length, 1)
  assert.equal(w.agent.traceRequest.id, 'replacement')
  assert.equal(w.agent.pendingEntityRefresh, undefined)
})

test('a crash before successor creation leaves a bound claim that restores to an explicit pause', async () => {
  const w = world()
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  const commit = w.agent.commitPlan.bind(w.agent)
  w.agent.commitPlan = plan => { if (plan.productionTask) throw new Error('process exit before successor'); return commit(plan) }
  await assert.rejects(w.agent.commitPlan(plan), /process exit before successor/)
  const snapshot = structuredClone(w.memory.snapshot())
  assert.equal(snapshot.entity_refresh_claims[0][1].state, 'bound')
  const restored = world({ snapshot })
  await restored.agent.runTurn()
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.memory.pauseRecord(KEY).pause_reason, 'entity_refresh_interrupted')
})

test('a durably created collection successor survives a crash and resumes from fresh stock without a model', async () => {
  const w = world()
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  let snapshot
  w.agent.persistState = async () => {
    if (w.memory.productionTasks.size) { snapshot = structuredClone(w.memory.snapshot()); throw new Error('process exit after successor store') }
  }
  await assert.rejects(w.agent.commitPlan(plan), /process exit after successor store/)
  assert.equal(snapshot.production_tasks[0][1].collection_only, true)
  const restored = world({ snapshot })
  await restored.agent.runTurn()
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.game.sent.length, 1)
  assert.equal(restored.game.sent[0].operations[0].name, 'move_items_exact')
  assert.equal(restored.memory.controllerRecoveries.values().next().value.attempts, 1)
})

for (const kind of ['condition_wait', 'persistent_runtime', 'crafting', 'follow', 'late_crafting']) test(`restored collection successor respects ${kind} before native admission`, async () => {
  const w = world()
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  let snapshot
  w.agent.persistState = async () => {
    if (w.memory.productionTasks.size) { snapshot = structuredClone(w.memory.snapshot()); throw new Error('fixture crash after successor') }
  }
  await assert.rejects(w.agent.commitPlan(plan), /fixture crash/)
  const restored = world({ snapshot, traceHook: ({ row, game }) => {
    if (kind === 'late_crafting' && row.event === 'operations.admit') game.craftingStatus = { task_active: false, native_queue: [{ name: 'iron-plate', count: 1 }] }
  } })
  if (kind === 'condition_wait') restored.memory.currentPlan(KEY).condition_wait = { state: 'active' }
  if (kind === 'persistent_runtime') restored.memory.currentPlan(KEY).persistent_runtime = { active: true }
  if (kind === 'crafting') restored.game.craftingStatus = { task_active: false, native_queue: [{ name: 'iron-plate', count: 1 }] }
  if (kind === 'follow') {
    const native = restored.game.command.bind(restored.game)
    restored.game.command = text => text.includes('"autorio_follow","status"') ? JSON.stringify({ active: true }) : native(text)
  }
  const result = await restored.agent.runTurn()
  assert.equal(result.production, 'deferred')
  assert.equal(restored.game.sent.length, 0)
  assert.equal(restored.providers.length, 0)
  assert.ok(restored.events.some(row => row.event === 'production.collection_deferred'))
  assert.equal(restored.memory.controllerRecoveries.values().next().value.attempts, 1)
  if (kind === 'late_crafting') assert.equal(restored.memory.pendingOperation(KEY), null, 'Unsent attempt was authoritatively retired')
})

test('superseded restored-collection cleanup preserves a replacement admission installed during an await', async () => {
  const w = world()
  const plan = await w.agent.parsePlanMessageChecked(message('tap_24'))
  let snapshot
  w.agent.persistState = async () => {
    if (w.memory.productionTasks.size) { snapshot = structuredClone(w.memory.snapshot()); throw new Error('fixture crash after successor') }
  }
  await assert.rejects(w.agent.commitPlan(plan), /fixture crash/)
  const replacement = { replacement: true }
  let injected = false
  const restored = world({ snapshot, readHook: ({ text, agent }) => {
    if (!injected && agent.entityRefreshAdmission && text.includes('"autorio_actor","status"')) {
      injected = true
      agent.traceRequest = { id: 'replacement', usage: {} }
      agent.entityRefreshAdmission = replacement
    }
  } })
  await assert.rejects(restored.agent.runTurn(), /superseded|cancelled/i)
  assert.equal(injected, true)
  assert.equal(restored.agent.entityRefreshAdmission, replacement)
  assert.equal(restored.game.sent.length, 0)
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.memory.pauseRecord(KEY)?.paused, false)
})

for (const limit of ['step', 'goal']) test(`shared ${limit} recovery exhaustion survives restore and pauses without another probe`, async () => {
  const w = world(); const owner = w.agent.captureCheckpointOwner()
  const step = JSON.stringify([owner.planId, owner.planVersion, owner.stepId])
  const steps = limit === 'step' ? [{ key: step, attempts: 2 }]
    : Array.from({ length: 3 }, (_, i) => ({ key: JSON.stringify([owner.planId, owner.planVersion, `older-step-${i}`]), attempts: 2 }))
  w.memory.controllerRecoveries.set(JSON.stringify([KEY, owner.goalId]), { attempts: limit === 'step' ? 2 : 6, steps, last_at: Date.now() })
  const restored = world({ snapshot: structuredClone(w.memory.snapshot()) })
  await restored.agent.commitPlan(await restored.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(restored.game.sent.length, 0)
  assert.equal(restored.providers.length, 0)
  assert.equal(restored.memory.pauseRecord(KEY).pause_reason, 'controller_recovery_exhausted')
})

test('duplicate failure after restore cannot renew the same targeted read allowance', async () => {
  const w = world()
  await w.agent.parsePlanMessageChecked(message('tap_24'))
  const snapshot = structuredClone(w.memory.snapshot())
  snapshot.entity_refresh_claims[0][1].state = 'continued' // A finished decision, with no native receipt progress.
  const restored = world({ snapshot })
  await restored.agent.commitPlan(await restored.agent.parsePlanMessageChecked(message('tap_24')))
  assert.equal(restored.memory.pauseRecord(KEY).pause_reason, 'entity_refresh_allowance_exhausted')
  assert.equal(restored.memory.controllerRecoveries.values().next().value.attempts, 1)
})

test('unrecorded player-owned targets and incomplete historical locators retain the original refusal', async () => {
  for (const kind of ['placement', 'locator']) {
    const w = world()
    if (kind === 'placement') w.memory.authorizationState(KEY).world.npc_placements.length = 0
    else w.agent.exactTargetLocator = () => ({ name: 'stone-furnace' })
    await assert.rejects(w.agent.parsePlanMessageChecked(message('tap_24')), error => error.code === 'exact_entity_requires_live_observation')
    assert.equal(w.memory.entityRefreshClaims.size, 0)
    assert.equal(w.game.sent.length, 0)
  }
})

test('binding, admission and an ordinary decision wake do not clear the checker; only the correlated verified settlement does', () => {
  const before = captured.failure_events.filter(row => row.event === 'recovery.classified' && row.data?.reason_code === 'exact_entity_requires_live_observation')
  const events = ['entity.refresh_bound', 'operations.admit', 'entity.refresh_decision_wake'].map(event => ({
    event, request_id: 'req_mvlkzpjx_1', data: { request_id: 'req_mvlkzpjx_1', unit_number: 19 },
  }))
  const check = rows => analyzeBehaviorTrace(rows).findings.filter(row => row.signature === 'exact_entity_binding_unrecovered')
  assert.equal(check([...before, ...events]).length, 1)
  const owner = { goal_id: 'goal', plan_id: 'plan', plan_version: 1, step_id: 'step' }
  const detected = { event: 'entity.refresh_detected', ts: '2026-10-23T23:59:00Z', request_id: 'req_mvlkzpjx_1',
    data: { ...owner, request_id: 'req_mvlkzpjx_1', unit_number: 19 } }
  const settled = { event: 'entity.refresh_settled', request_id: 'next-native-callback', ts: '2026-10-24T00:00:00Z',
    data: { ...detected.data, disposition: 'verified_checkpoint_closed' } }
  for (const [field, value] of Object.entries({ request_id: 'different-request', goal_id: 'other-goal', plan_id: 'other-plan', plan_version: 2, step_id: 'other-step' })) {
    assert.equal(check([detected, { ...settled, data: { ...settled.data, [field]: value } }]).length, 1, field)
  }
  assert.equal(check([detected, settled]).length, 0)
  assert.equal(check([...before, settled]).length, 1, 'Historical failures with missing owner fields remain unresolved')
  const otherStep = { ...detected, data: { ...detected.data, step_id: 'another-step' } }
  assert.equal(check([detected, otherStep]).length, 2)
  assert.equal(check([detected, otherStep, settled]).length, 1)
})

test('normal-tools typed observations share the same bounded identity refresh and cannot mutate from the read', async () => {
  const w = world({ provider: async () => ({ content: JSON.stringify({ stepId: w.held().steps[3].step_id, operations: [] }) }) })
  const result = await w.agent.handleObservationRequest(message('tap_22'), {
    generation: w.agent.generation, attribution: undefined, current: w.game.status, round: 1, recoveryAttempt: 0, allowTools: true,
  })
  assert.equal(result._sglunaObservationRefusal, undefined)
  assert.equal(w.agent.liveObservedExactTarget(19)?.unit_number, 19)
  assert.equal(w.game.sent.length, 0)
  assert.equal(w.memory.controllerRecoveries.values().next().value.attempts, 1)
})
