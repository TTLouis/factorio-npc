import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { NpcAgentLoop as BaseNpcAgentLoop } from '../staging/npc-agent-loop.mjs'
import { createFactoryRegistry, registerFactoryCell } from './factory-registry.mjs'
import { prepareFactoryCellHost, projectFactoryCellResult, validateFactoryCellTool } from './factory-cell-tools.mjs'
import { buildPendingOperation } from './operation-reconciliation.mjs'
import { getActivePlan } from './planning-state.mjs'
import { toolCommand } from './structured-policy.mjs'

const WORLD = '1e837e91-4f33-43a2-a3aa-c891ee06ec66'
const KEY = 'npc:factory-tools-test'
const call = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const message = (...calls) => ({ content: '', tool_calls: calls })

function cell(unit = 27) {
  return { surface_index: 1, force_index: 1, assignment: { products: ['fixture-output'], purpose: 'Keep the committed production assignment', method: 'Native fixture process' },
    members: [{ unit_number: unit, name: 'fixture-machine', position: { x: unit, y: -4 }, surface_index: 1, force_index: 1, provenance: { source: 'native_fixture_receipt' } }],
    ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: 'fixture-output' }], origin: { source: 'trusted_fixture_registration' } }
}

class FakeFactorio {
  constructor() {
    this.calls = []; this.world = WORLD; this.tick = 100; this.observeCount = 0
    this.status = { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', session: 'fixture-session', actor_id: 24, actor_kind: 'standalone_character', epoch: 2,
      allowed: true, idle: true, actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 }
    this.task = { task_state: 'idle', queue_empty: true, queue_length: 0, admission_journal: [] }
  }
  async command(text) {
    assert.equal(typeof text, 'string', 'Host marker never reaches RCON')
    this.calls.push(text)
    if (text.includes('"sgluna_deployment","status"')) return JSON.stringify(this.status)
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: this.status.actor_id, valid: true }, surface_index: this.status.surface_index, force_index: this.status.force_index })
    if (text.includes('"autorio_operations","status"')) return JSON.stringify(this.task)
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: !!this.world, code: this.world ? 'ok' : 'world_unbound', world_id: this.world })
    if (text.includes("'sgluna_factory','bind_world_id'")) {
      assert.equal(this.world, undefined)
      this.world = text.match(/bind_world_id','([^']+)'/)[1]
      return JSON.stringify({ schema_version: 1, ok: true, world_id: this.world })
    }
    if (text.includes("'sgluna_factory','observe'")) {
      this.observeCount++
      const body = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1])
      await this.onObserve?.()
      return JSON.stringify({ ...body, ok: true, code: 'ok', tick: this.tick++, members: body.members.map(locator => ({ locator, state: 'observed',
        recipe: { state: 'known', truncated: false, products: [{ name: 'fixture-output' }], ingredients: [] },
        source_resources: { state: 'not_applicable', resources: [], truncated: false },
      })) })
    }
    if (text.includes('autorio_tools') && text.includes('get_inventory_items')) return JSON.stringify({ items: [{ name: 'fixture-item', count: 3 }] })
    throw new Error(`Unexpected fixture native command: ${text}`)
  }
}

function fixture({ registered = true, planned = true } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  if (planned) {
    memory.recordPlan(KEY, { sender: 'owner', text: 'Keep the assigned native production' }, {
      chatMessage: '', plan: ['Observe assigned production'], currentStep: 0, operations: [],
      stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', confidence: 0.9, requirements: [{ id: 'stock', kind: 'inventory_count', item_name: 'fixture-output', minimum: 1 }] } }],
    }, { validatedPlannerAdmission: true })
    memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  }
  if (registered) memory.restore({ ...memory.snapshot(), factory_registry_world_id: WORLD, factory_registry: registerFactoryCell(createFactoryRegistry(WORLD), cell()) })
  const game = new FakeFactorio()
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory, stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async () => { throw new Error('No provider call authorized') }, npcId: 'factory-tools-test', completionProtocolVersion: 2, jevCheckpoints: false })
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'request-factory-tools', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.observationBudgetRemaining = 10; agent.observationDecisionForced = false
  agent.behaviorTrace = { emit: async record => { events.push({ event: record.event, payload: record.data, options: { requestId: record.request_id }, record }); await agent.onTrace?.(record.event, record.data) } }
  return { memory, game, agent, events }
}
const results = w => w.agent.messages.filter(row => row.role === 'tool').map(row => ({ ...row, parsed: JSON.parse(row.content) }))

test('actual mixed tool batch preserves ordinary execution, budgets, correlated evidence and immutable jobs', async () => {
  const w = fixture()
  const plan = JSON.stringify(w.memory.planningState(KEY)); const registry = JSON.stringify(w.memory.getFactoryRegistry())
  const request = message(call('listFactoryCells'), call('inspectFactoryCell', { cell_id: 'cell-1' }), call('getInventoryItems'))
  const prepared = w.agent.prepareToolBatch(request)
  assert.equal(prepared[0].command, null)
  assert.equal(Object.keys(prepared[0]).includes('_sglunaExecuteObservation'), false)
  await w.agent.handleToolBatch(request, prepared)
  const replies = results(w)
  assert.equal(replies.length, 3)
  assert.equal(replies[0].parsed.cells[0].assignment.products[0], 'fixture-output')
  assert.equal(replies[1].parsed.commissioning, 'unverified')
  assert.equal(replies[1].parsed.native.members[0].locator.unit_number, 27)
  assert.equal(replies[2].parsed.items[0].count, 3)
  assert.equal(w.agent.observationBudgetRemaining, 7)
  assert.equal(JSON.stringify(w.memory.getFactoryRegistry()), registry)
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), plan)
  const evidence = w.events.find(row => row.event === 'factory_cell.native_evidence' && row.payload.method === 'observe')
  assert.equal(evidence.payload.request_id, 'request-factory-tools')
  assert.equal(evidence.options.requestId, 'request-factory-tools')
  assert.equal(JSON.parse(evidence.payload.native_response).members[0].locator.unit_number, 27)
})

test('legacy empty registry initializes against actual native world once without adopting hardware', async () => {
  const w = fixture({ registered: false }); w.game.world = undefined
  await w.agent.handleToolBatch(message(call('listFactoryCells')))
  assert.match(w.memory.factoryWorldBinding().world_id, /^[0-9a-f-]{36}$/)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.equal(results(w)[0].parsed.cells.length, 0)
  await w.agent.handleToolBatch(message(call('listFactoryCells', {}, 'list-again')))
  assert.equal(w.game.calls.filter(text => text.includes("'bind_world_id'")).length, 1)
})

test('planner can inspect a registered cell before committing a plan without enrolling or certifying it', async () => {
  const w = fixture({ planned: false })
  const before = JSON.stringify(w.memory.planningState(KEY))
  await w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' })))
  const result = results(w)[0].parsed
  assert.equal(result.cell_id, 'cell-1')
  assert.equal(result.refused, undefined)
  assert.equal(result.commissioning, 'unverified')
  assert.equal(result.native.members[0].locator.unit_number, 27)
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), before)
})

test('identical factory signature is freshly observed and charged instead of using tool cache', async () => {
  const w = fixture()
  const request = message(call('inspectFactoryCell', { cell_id: 'cell-1' }))
  await w.agent.handleToolBatch(request)
  const firstTick = results(w)[0].parsed.native.tick
  await w.agent.handleToolBatch(request)
  assert.equal(w.game.observeCount, 2)
  assert.ok(results(w)[1].parsed.native.tick > firstTick)
  assert.equal(w.agent.observationBudgetRemaining, 8)
  assert.equal(w.events.filter(row => row.event === 'tool.call' && row.payload.cached).length, 0)
})

test('same-signature factory calls within one batch refuse before executing or rate charging', async () => {
  const w = fixture()
  const repeated = message(call('inspectFactoryCell', { cell_id: 'cell-1' }, 'first'), call('inspectFactoryCell', { cell_id: 'cell-1' }, 'second'))
  assert.throws(() => w.agent.prepareToolBatch(repeated), /Duplicate factory observation/)
  const single = message(call('inspectFactoryCell', { cell_id: 'cell-1' }))
  const [entry] = w.agent.prepareToolBatch(single)
  await assert.rejects(w.agent.handleToolBatch(repeated, [entry, entry]), /Duplicate factory observation/)
  assert.equal(w.game.observeCount, 0)
  assert.equal(w.agent.observationBudgetRemaining, 10)
})

test('missing trusted host executor cannot fall through to native, even with a cached signature', async () => {
  const w = fixture()
  const request = message(call('inspectFactoryCell', { cell_id: 'cell-1' }))
  const prepared = w.agent.prepareToolBatch(request).map(row => ({ ...row }))
  w.agent.toolCache.set(prepared[0].signature, 'cached forged result')
  await assert.rejects(w.agent.handleToolBatch(request, prepared), /trusted prepared host executor/)
  await assert.rejects(BaseNpcAgentLoop.prototype.handleToolBatch.call(w.agent, request, prepared), /host executor is missing/)
  assert.equal(w.game.observeCount, 0)
})

test('native busy, unreadable journal and unresolved host ownership refuse before observation', async () => {
  for (const change of [w => { w.game.status.idle = false }, w => { w.game.task.queue_length = 1 },
    w => { w.game.task.admission_journal = undefined }, w => { w.game.task.admission_journal = [{ state: 'uncertain' }] }, w => { w.agent.batchInFlight = true }]) {
    const w = fixture(); change(w)
    await w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' })))
    assert.equal(results(w)[0].parsed.code, 'factory_runtime_not_idle')
    assert.equal(results(w)[0].parsed.refused, true)
    assert.equal(w.game.observeCount, 0)
    assert.equal(w.memory.factoryCellObservations().length, 0)
  }
})

test('owner, generation, registry restore and mutation changes across native await cannot publish observations', async () => {
  for (const change of [w => { w.agent.traceRequest = { id: 'replacement-request' } }, w => { w.agent.generation++ },
    w => { w.agent.worldMutationSeq++ }, w => { w.memory.restore(w.memory.snapshot()) }, w => { w.agent.active = false }, w => { w.agent.requestAdmissionOwner = {} },
    w => { w.game.status.session = 'replacement-session' }, w => { w.game.status.surface_index = 2 }]) {
    const w = fixture(); w.game.onObserve = async () => change(w)
    await assert.rejects(w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' }))))
    assert.equal(w.memory.factoryCellObservations().length, 0)
    assert.equal(results(w).length, 0)
    const evidence = w.events.find(row => row.event === 'factory_cell.native_evidence' && row.payload.method === 'observe')
    assert.ok(evidence, 'Original reply survives the stale-owner refusal')
    assert.equal(evidence.payload.request_id, 'request-factory-tools')
    assert.equal(evidence.record.request_id, 'request-factory-tools')
    assert.equal(evidence.record.actor_id, 24)
    assert.equal(evidence.record.session_id, 'fixture-session')
    assert.equal(JSON.parse(evidence.payload.native_response).members[0].locator.unit_number, 27)
  }
})

test('ownership changes during native evidence trace are fenced before recording or delivering a result', async () => {
  const w = fixture()
  w.agent.onTrace = async (event, payload) => {
    if (event === 'factory_cell.native_evidence' && payload.method === 'observe') w.agent.worldMutationSeq++
  }
  await assert.rejects(w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' }))), error => error.code === 'factory_tool_owner_stale')
  assert.equal(w.memory.factoryCellObservations().length, 0)
  assert.equal(results(w).length, 0)
})

test('post-read native busy retains raw evidence and a correlated refusal without publishing', async () => {
  const w = fixture()
  w.game.onObserve = async () => { w.game.task.queue_empty = false }
  await w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' })))
  assert.ok(w.events.some(row => row.event === 'factory_cell.native_evidence' && row.payload.method === 'observe'))
  assert.ok(w.events.some(row => row.event === 'factory_cell.tool_refused' && row.payload.request_id === 'request-factory-tools'))
  assert.equal(results(w)[0].parsed.refused, true)
  assert.equal(results(w)[0].parsed.code, 'factory_runtime_not_idle')
})

test('pinned evidence survives admission cancellation and never changes replacement trace sequence', async () => {
  const w = fixture()
  const replacement = { id: 'replacement', seq: 50 }
  w.game.onObserve = async () => {
    w.agent.traceRequest = replacement
    w.agent.assertRequestAdmission = () => { throw new Error('Request admission cancelled or superseded') }
  }
  await assert.rejects(w.agent.handleToolBatch(message(call('inspectFactoryCell', { cell_id: 'cell-1' }))))
  const captured = w.events.filter(row => ['factory_cell.native_evidence', 'factory_cell.tool_refused'].includes(row.event))
  assert.ok(captured.some(row => row.payload.method === 'observe'))
  assert.ok(captured.every(row => row.record.request_id === 'request-factory-tools' && row.record.actor_id === 24 && row.record.epoch === 2))
  assert.equal(replacement.seq, 50)
  assert.equal(results(w).length, 0)
})

test('real guarded error boundary receives expected unavailable tool results without a provider failure pause', async () => {
  const w = fixture()
  w.game.task.admission_journal = undefined
  // The scripted model-turn seam enters the actual prepare/dispatch path. The
  // real guarded boundary would classify/reset any exception escaping that path.
  w.agent.runTurnRedriving = async () => {
    const request = message(call('inspectFactoryCell', { cell_id: 'cell-1' }))
    await w.agent.handleToolBatch(request, w.agent.prepareToolBatch(request))
    return { chatMessage: 'Native availability remains unverified.', operations: [] }
  }
  const generation = w.agent.generation
  const result = await w.agent.runGuardedTurn()
  assert.deepEqual(result.operations, [])
  assert.equal(w.agent.generation, generation)
  assert.equal(w.agent.active, true)
  assert.equal(results(w)[0].parsed.refused, true)
  assert.equal(w.events.some(row => ['request.failed', 'provider.error', 'goal.paused'].includes(row.event)), false)
})

test('existing registry fault returns an explicit unavailable result and never an empty healthy registry', async () => {
  const w = fixture()
  w.memory.restore({ ...w.memory.snapshot(), factory_registry: {} })
  await w.agent.handleToolBatch(message(call('listFactoryCells')))
  const result = results(w)[0].parsed
  assert.equal(result.code, 'factory_registry_fault')
  assert.equal(result.refused, true)
  assert.equal(result.state, 'unverified')
  assert.equal(Object.hasOwn(result, 'cells'), false)
  assert.equal(w.memory.factoryRegistryStatus().status, 'fault')
  assert.equal(w.game.calls.some(text => text.includes('sgluna_factory')), false)
})

test('validation rejects resource overrides, world setters, malformed IDs and unbounded paging', () => {
  for (const args of [{ cell_id: 'cell-1', resource: 'iron-ore' }, { cell_id: 'cell-0' }, { cell_id: 'cell-9007199254740992' }, { cell_id: 'cell-1', world_id: WORLD },
    { cell_id: 'cell-1', binding: { source_unit_number: 1, target_unit_number: 2, recipe: 'override' } }]) assert.throws(() => toolCommand('inspectFactoryCell', args))
  for (const args of [{ limit: 0 }, { limit: 33 }, { offset: -1 }, { offset: 257 }]) assert.throws(() => validateFactoryCellTool('listFactoryCells', args))
  assert.equal(toolCommand('listFactoryCells', {}), null)
  assert.throws(() => toolCommand('bindFactoryWorld', { world_id: WORLD }))
})

test('projection returns bounded valid JSON, omission counts and a resumable list cursor', () => {
  const listing = { world_id: WORLD, revision: 1, offset: 0, total_cells: 20, next_offset: null,
    cells: Array.from({ length: 16 }, (_, index) => ({ cell_id: `cell-${index + 1}`, assignment: { products: ['fixture-output'], purpose: 'p'.repeat(2000), method: 'm'.repeat(2000) } })) }
  const result = projectFactoryCellResult(listing)
  assert.ok(result.length <= 12000)
  const projected = JSON.parse(result)
  assert.equal(projected.projection.omitted, true)
  assert.equal(projected.next_offset, projected.cells.length)
  assert.equal(projected.projection.omitted_cells + projected.cells.length, 16)
  assert.equal(listing.cells.length, 16)
  const native = JSON.parse(projectFactoryCellResult({ commissioning: 'unverified', native: { members: [{ contents: 'x'.repeat(14000) }] } }))
  assert.equal(native.projection.omitted_native_members, 1)
  assert.equal(native.commissioning, 'unverified')
  const oversized = { ...listing, cells: [{ cell_id: 'cell-1', assignment: { products: Array.from({ length: 64 }, (_, index) => `${index}`.padEnd(200, 'p')), purpose: 'p'.repeat(2000), method: 'm'.repeat(2000) } }] }
  const bounded = JSON.parse(projectFactoryCellResult(oversized))
  assert.ok(JSON.stringify(bounded).length <= 12000)
  assert.equal(bounded.cells[0].cell_id, 'cell-1')
  assert.equal(bounded.cells[0].assignment_omissions.products, 56)
  assert.equal(bounded.next_offset, 1)
})

async function settledHostFixture() {
  const w = fixture(); const state = w.memory.planningState(KEY); const plan = getActivePlan(state)
  const operations = [{ name: 'supply_entity', args: { unit_number: 27, items: [{ item_name: 'coal', count: 1 }] } }, { name: 'place_entity', args: { entity_name: 'lab' } }]
  const pending = buildPendingOperation({ requestId: w.agent.traceRequest.id, ordinal: 1, protocolVersion: 2, actor: w.agent.epoch,
    goalId: state.goal.goal_id, planId: plan.plan_id, stepId: plan.steps[0].step_id, operations, baseline: { generation: 1, max_batch_id: 0 }, now: 1 })
  w.memory.recordPendingOperation(KEY, pending)
  const ref = { batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1' }
  const cancelled = { ...ref, task_count: 2, task_types: ['moving_items', 'placing'], tick: 101, reason: 'placing:no_position',
    started_count: 2, tasks_started: 2, failed_before_mutation: true, failed_task_index: 1 }
  w.game.task = { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1,
    admission_journal: [{ operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
      actor_id: 24, epoch: 2, ordinal: 1, operation_count: 2, state: 'uncertain', generation: 1, tick: 100,
      ok: true, error: 'batch_reconciliation_required', slots: operations.map((operation, index) => ({ index: index + 1, ok: true, operation: operation.name, batch_refs: [ref], queued_tasks: 1 })) }],
    receipt_journal: [{ ...cancelled, state: 'cancelled' }], last_cancelled_batch: cancelled,
    basic_operation: { last_result: { operation_id: 2, type: 'placing', accepted: false, completed: false, code: 'no_position', tick: 101, actor_id: 24, entity_name: 'lab' } } }
  await w.agent.settleOutstandingOperation(w.game.task, pending.operation_key)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  return w
}

test('factory host re-proves exact durable per-slot settlement while provider reads retain raw uncertainty', async () => {
  const w = await settledHostFixture()
  const before = JSON.stringify(w.game.task)
  const result = await prepareFactoryCellHost(w.agent, (_observer, access) => { access.fence(); return 'readmitted' }).execute()
  assert.equal(result, 'readmitted')
  assert.equal(JSON.stringify(w.game.task), before)
  const request = message(call('listFactoryCells'))
  await w.agent.handleToolBatch(request, w.agent.prepareToolBatch(request))
  assert.equal(results(w).at(-1).parsed.code, 'factory_runtime_not_idle')
  assert.equal(results(w).at(-1).parsed.refused, true)
})

for (const fault of ['signature', 'attempt', 'ordinal', 'receipt', 'actor', 'goal', 'stale-owner']) test(`factory host settled uncertain admission refuses ${fault}`, async () => {
  const w = await settledHostFixture()
  if (fault === 'signature') w.game.task.admission_journal[0].signature = 'f'.repeat(64)
  if (fault === 'attempt') w.game.task.admission_journal[0].attempt_id += '-other'
  if (fault === 'ordinal') w.game.task.admission_journal[0].ordinal++
  if (fault === 'receipt') { w.game.task.receipt_journal = []; delete w.game.task.last_cancelled_batch }
  if (fault === 'actor') { w.agent.epoch.epoch++; w.game.status.epoch++ }
  if (fault === 'goal') w.memory.planningState(KEY).goal.goal_id = 'replacement-goal'
  const prepared = prepareFactoryCellHost(w.agent, () => assert.fail('held native state cannot acquire capability'))
  if (fault === 'stale-owner') w.agent.traceRequest = { id: 'replacement-request' }
  await assert.rejects(prepared.execute(), { code: fault === 'stale-owner' ? 'factory_tool_owner_stale' : 'factory_runtime_not_idle' })
})
