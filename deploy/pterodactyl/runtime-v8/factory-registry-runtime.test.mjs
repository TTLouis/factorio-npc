import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { directFeedBootstrapRefusal } from './direct-feed-bootstrap-runtime.mjs'
import { miningDetails, recipeDetails } from './direct-feed-bootstrap-fixtures.mjs'
import { buildPendingOperation, EFFECT } from './operation-reconciliation.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

const KEY = 'npc:factory-test'
const WORLD = 'ac8b843a-3e61-4df0-bd05-f5de2139f181'
const CHECKPOINT = { mode: 'all', requirements: [{ id: 'held', kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }], confidence: 0.9 }

function plan(memory, objective = 'Declare copper production') {
  memory.recordPlan(KEY, { sender: 'owner', text: objective }, {
    chatMessage: 'Inspect and build the assigned cell.', plan: ['Build assigned production', 'Register assigned production'], currentStep: 0,
    operations: [], stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }, { kind: 'deterministic', checkpoint: CHECKPOINT }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.COMMITTED)
}

function world({ initialize = true } = {}) {
  const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
  const events = []
  memory.traceSink = (name, payload) => events.push({ name, ...payload })
  plan(memory)
  if (initialize) memory.initializeFactoryRegistry(WORLD)
  const context = { world_id: WORLD, surface_index: 1, force_index: 1, actor_id: 24, actor_epoch: 2,
    request_id: 'request-1', native_idle: true, pending: false, uncertain: false }
  const receipts = new Map()
  const runtime = memory.createFactoryRegistryRuntime(KEY, () => structuredClone(context), id => structuredClone(receipts.get(id)))
  return { memory, context, runtime, receipts, events }
}

function placed(w, unit = 27, name = 'burner-mining-drill') {
  const scope = w.runtime.scope()
  w.memory.recordNpcPlacement(KEY, { unit_number: unit, entity_name: name, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch })
  const raw = { unit_number: unit, name, position: { x: unit, y: -4 }, surface_index: 1, force_index: 1,
    provenance: { source: 'npc_placement_receipt', receipt_id: `native/batch-${unit}/placement-1` } }
  w.receipts.set(raw.provenance.receipt_id, { ...scope, receipt_id: raw.provenance.receipt_id,
    unit_number: unit, name, position: raw.position })
  return { member: w.runtime.recordPlacement(raw, scope), raw, scope }
}

function declaration(member, origin = { ...member.provenance, source: 'runtime_registration' }) {
  return { surface_index: 1, force_index: 1,
    assignment: { products: ['copper-plate'], purpose: 'Retain copper output', method: 'Declared direct feed' },
    members: [member], ports: [{ port_id: 'fuel', direction: 'input', kind: 'fuel', resource: 'coal' },
      { port_id: 'out', direction: 'output', kind: 'item', resource: 'copper-plate' }], origin }
}
function register(w, unit = 27, name) {
  const { member } = placed(w, unit, name)
  return w.runtime.registerCell(declaration(member), w.runtime.scope())
}
const dependency = cell => ({ consumer: { cell_id: cell.cell_id, port_id: 'fuel' },
  supplier: { kind: 'manual', reference: 'owner fuel input' }, delivery: { kind: 'manual' } })
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code)

test('real canonical lifecycle registration preserves goal and plan bytes and returns defensive registry copies', () => {
  const w = world()
  const { member, scope } = placed(w)
  const before = JSON.stringify(w.memory.planningState(KEY))
  const board = JSON.stringify(w.memory.currentPlan(KEY))
  const cell = w.runtime.registerCell(declaration(member), scope)
  assert.equal(cell.state, 'unverified')
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), before)
  assert.equal(JSON.stringify(w.memory.currentPlan(KEY)), board)
  const view = w.memory.getFactoryRegistry()
  view.cells[0].assignment.products[0] = 'iron-plate'
  cell.members[0].name = 'forged'
  const lookup = w.memory.getFactoryMemberAssignment({ world_id: WORLD, surface_index: 1, force_index: 1, unit_number: 27, name: member.name })
  lookup.assignment.products.length = 0
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0].assignment.products, ['copper-plate'])
  throwsCode(() => w.memory.initializeFactoryRegistry('another-world'), 'factory_world_mismatch')
  assert.equal(w.memory.initializeFactoryRegistry(WORLD).cells.length, 1)
})

test('assignments and dependencies outlive goal, actor and snapshot restore without inheriting old authority', () => {
  const w = world()
  const cell = register(w)
  w.runtime.registerDependency(dependency(cell), w.runtime.scope())
  const registry = w.memory.getFactoryRegistry()
  const oldScope = w.runtime.scope()
  w.memory.clearTaskContext(KEY)
  plan(w.memory, 'Build independent iron production')
  w.context.actor_id = 30
  w.context.actor_epoch = 4
  w.context.request_id = 'request-2'
  assert.deepEqual(w.memory.getFactoryRegistry(), registry)
  throwsCode(() => w.runtime.registerDependency(dependency(cell), oldScope), 'factory_runtime_scope_stale')
  const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
  restored.restore(JSON.parse(JSON.stringify(w.memory.snapshot())))
  assert.deepEqual(restored.getFactoryRegistry(), registry)
  assert.equal(restored.getFactoryMemberAssignment({ world_id: WORLD, surface_index: 1, force_index: 1, unit_number: 27 }).cell_id, cell.cell_id)
  assert.equal(restored.checkOperationAdmission(KEY, { operations: [{ name: 'mine_entity_exact', args: { unit_number: 700 } }] }).ok, true)
  const frozen = restored.getFactoryRegistry()
  restored.clearTaskContext(KEY)
  assert.deepEqual(restored.getFactoryRegistry(), frozen)
})

test('legacy snapshots do not adopt NPC placements or infer a world registry', () => {
  const legacy = new CanonicalTaskBoardMemory()
  plan(legacy)
  legacy.recordNpcPlacement(KEY, { unit_number: 27, entity_name: 'burner-mining-drill', actor_id: 24, actor_epoch: 2 })
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(legacy.snapshot())
  assert.deepEqual(restored.factoryRegistryStatus(), { status: 'uninitialized' })
  assert.equal(Object.hasOwn(restored.snapshot(), 'factory_registry'), false)
  throwsCode(() => restored.getFactoryRegistry(), 'factory_registry_uninitialized')
  assert.deepEqual(restored.initializeFactoryRegistry(WORLD).cells, [])
  const w = world(); register(w)
  const before = w.memory.getFactoryRegistry()
  w.memory.restore(legacy.snapshot())
  assert.deepEqual(w.memory.getFactoryRegistry(), before, 'an absent legacy field never resets the initialized world')
})

test('explicit malformed registry is a durable fail-closed fault across save, restore and attempted reinitialization', () => {
  for (const invalid of [null, [], { schema_version: 99 }, { world_id: WORLD, cells: [] }]) {
    const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
    memory.restore({ ...new CanonicalTaskBoardMemory().snapshot(), factory_registry: invalid })
    assert.deepEqual(memory.factoryRegistryStatus(), { status: 'fault' })
    throwsCode(() => memory.getFactoryRegistry(), 'factory_registry_fault')
    throwsCode(() => memory.getFactoryMemberAssignment({ unit_number: 27 }), 'factory_registry_fault')
    throwsCode(() => memory.initializeFactoryRegistry(WORLD), 'factory_registry_fault')
    assert.equal(memory.factoryPlacementAvailability({ unit_number: 27, entity_name: 'burner-mining-drill' }).status, 'unknown')
    const saved = memory.snapshot()
    assert.ok(saved.factory_registry_fault)
    const again = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
    again.restore(saved)
    again.restore(new CanonicalTaskBoardMemory().snapshot())
    throwsCode(() => again.getFactoryRegistry(), 'factory_registry_fault')
    assert.equal(again.checkOperationAdmission(KEY, { operations: [{ name: 'rotate_entity', args: { unit_number: 27 } }] }).code, 'factory_registry_unavailable')
    assert.equal(again.checkOperationAdmission(KEY, { operations: [{ name: 'wait', args: { ticks: 1 } }] }).ok, true)
  }
})

test('restore rejects wrong explicit world and a registry payload without a host world binding', () => {
  const w = world(); register(w)
  const wrong = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: 'different-save' })
  wrong.restore(w.memory.snapshot())
  throwsCode(() => wrong.getFactoryRegistry(), 'factory_registry_fault')
  const unbound = new CanonicalTaskBoardMemory()
  const snapshot = w.memory.snapshot(); delete snapshot.factory_registry_world_id
  unbound.restore(snapshot)
  throwsCode(() => unbound.getFactoryRegistry(), 'factory_registry_fault')
})

test('newer snapshots cannot delete or rewrite prior cell assignments and dependencies', () => {
  for (const mutate of [
    row => { row.cells = []; row.dependencies = [] },
    row => { row.cells[0].assignment.purpose = 'repurposed' },
    row => { row.cells[0].members[0].position.x++ },
    row => { row.dependencies = [] },
    row => { row.dependencies[0].supplier.reference = 'changed owner' },
    row => { row.next_cell_id = 1 },
    row => { row.next_dependency_id = 1 },
  ]) {
    const w = world(); const cell = register(w)
    w.runtime.registerDependency(dependency(cell), w.runtime.scope())
    const next = w.memory.snapshot()
    next.factory_registry.revision += 10
    mutate(next.factory_registry)
    w.memory.restore(next)
    throwsCode(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
    assert.ok(w.memory.snapshot().factory_registry_fault)
  }
})

test('a valid append-only newer restore is accepted but invalidates previous request capability', () => {
  const w = world(); register(w)
  const before = w.memory.snapshot()
  register(w, 28, 'stone-furnace')
  const newer = w.memory.snapshot()
  const other = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
  other.restore(before)
  other.restore(newer)
  assert.equal(other.getFactoryRegistry().cells.length, 2)
  w.memory.restore(newer)
  throwsCode(() => w.runtime.scope(), 'factory_runtime_stale')
})

test('restore cannot rewind previously reserved counter gaps even when all IDs remain individually valid', () => {
  for (const counter of ['next_cell_id', 'next_dependency_id']) {
    const w = world(); register(w)
    const reserved = w.memory.snapshot()
    reserved.factory_registry.revision = 20
    reserved.factory_registry.next_cell_id = 5
    reserved.factory_registry.next_dependency_id = 5
    w.memory.restore(reserved)
    assert.equal(w.memory.getFactoryRegistry()[counter], 5)
    const regressed = w.memory.snapshot()
    regressed.factory_registry.revision = 21
    regressed.factory_registry[counter] = 4
    w.memory.restore(regressed)
    throwsCode(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
  }
})

test('registration requires current request, actor, epoch, world, plan, step and expected revision', () => {
  for (const patch of [
    { request_id: 'stale' }, { actor_id: 25 }, { actor_epoch: 3 }, { world_id: 'wrong' },
    { surface_index: 2 }, { force_index: 2 }, { goal_id: 'old-goal' }, { plan_id: 'old-plan' },
    { plan_version: 99 }, { step_id: 'old-step' }, { semantic_step_id: 'old-semantic-step' },
  ]) {
    const w = world(); const { member, scope } = placed(w)
    throwsCode(() => w.runtime.registerCell(declaration(member), { ...scope, ...patch }), 'factory_runtime_scope_stale')
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  }
  const w = world(); const { member, scope } = placed(w)
  throwsCode(() => w.runtime.registerCell(declaration(member), { ...scope, expected_revision: 3 }), 'factory_registry_revision_stale')
  w.context.request_id = 'superseding-request'
  throwsCode(() => w.runtime.registerCell(declaration(member), scope), 'factory_runtime_scope_stale')
  throwsCode(() => w.runtime.registerCell(declaration(member), w.runtime.scope()), 'factory_origin_stale')
})

test('busy, pending, uncertain and blocked plan contexts cannot register cells', () => {
  for (const patch of [{ native_idle: false }, { pending: true }, { uncertain: true }]) {
    const w = world(); const { member, scope } = placed(w)
    Object.assign(w.context, patch)
    throwsCode(() => w.runtime.registerCell(declaration(member), scope), 'factory_runtime_not_idle')
  }
  const w = world(); const { member, scope } = placed(w)
  w.memory.dispatchPlanningEvent(KEY, { type: 'STRUCTURAL_BLOCKER_CONFIRMED', plan_id: scope.plan_id, reason_code: 'test-blocker', source: 'runtime', now: 1000 })
  throwsCode(() => w.runtime.registerCell(declaration(member), scope), 'factory_plan_authority_missing')
})

test('durable uncertain operations fence registration even when the host callback reports idle', () => {
  const w = world(); const { member, scope } = placed(w)
  const pending = buildPendingOperation({ requestId: scope.request_id, goalId: scope.goal_id, planId: scope.plan_id,
    stepId: scope.step_id, actor: { actor_id: scope.actor_id, epoch: scope.actor_epoch },
    operations: [{ name: 'mine_entity_exact', args: { unit_number: 999 } }], now: 100 })
  assert.ok(w.memory.recordPendingOperation(KEY, { ...pending, effect: EFFECT.PARTIAL_UNKNOWN }))
  assert.equal(w.context.pending, false)
  assert.equal(w.memory.pendingOperations(KEY).length, 1)
  throwsCode(() => w.runtime.registerCell(declaration(member), scope), 'factory_runtime_not_idle')
})

test('old placement rows alone and forged native identity, scope or receipt cannot enroll a cell', () => {
  const w = world()
  const { member, raw } = placed(w)
  for (const forged of [
    { ...raw, position: { x: 999, y: -4 } },
    { ...raw, surface_index: 2 }, { ...raw, force_index: 2 },
    { ...raw, provenance: { ...raw.provenance, receipt_id: 'invented' } },
  ]) assert.throws(() => w.runtime.recordPlacement(forged, w.runtime.scope()))
  w.receipts.clear()
  throwsCode(() => w.runtime.recordPlacement(raw, w.runtime.scope()), 'factory_native_placement_mismatch')
  const invented = structuredClone(member); invented.position.x = 999
  throwsCode(() => w.runtime.registerCell(declaration(invented), w.runtime.scope()), 'factory_placement_unproven')
  const player = { ...raw, unit_number: 400 }
  throwsCode(() => w.runtime.recordPlacement(player, w.runtime.scope()), 'factory_placement_unproven')
  const fresh = w.memory.createFactoryRegistryRuntime(KEY, () => w.context, () => undefined)
  throwsCode(() => fresh.registerCell(declaration(member), fresh.scope()), 'factory_placement_unproven')
})

test('a unit cannot be assigned twice and dependency mutations require current revision and scope', () => {
  const w = world(); const { member } = placed(w)
  const cell = w.runtime.registerCell(declaration(member), w.runtime.scope())
  throwsCode(() => w.runtime.registerCell(declaration(member), w.runtime.scope()), 'duplicate_assignment')
  const stale = w.runtime.scope()
  register(w, 28, 'stone-furnace')
  throwsCode(() => w.runtime.registerDependency(dependency(cell), stale), 'factory_registry_revision_stale')
  throwsCode(() => w.runtime.registerDependency(dependency(cell), { ...w.runtime.scope(), world_id: 'other' }), 'factory_runtime_scope_stale')
  w.context.force_index = 2
  throwsCode(() => w.runtime.registerDependency(dependency(cell), w.runtime.scope()), 'factory_dependency_scope_mismatch')
})

test('retained same-goal receipts span requests, steps and actor epochs without rewriting member history', () => {
  const w = world(); const first = placed(w)
  const original = structuredClone(first.member.provenance)
  const committed = getActivePlan(w.memory.planningState(KEY))
  assert.ok(committed.steps[0].completion_contract, JSON.stringify(committed.steps[0]))
  w.memory.dispatchPlanningEvent(KEY, { type: 'STEP_EVIDENCE_ACCEPTED', source: 'runtime', now: Date.now(), plan_id: first.scope.plan_id,
    step_id: first.scope.step_id, evidence: { source: 'runtime', ref: 'verified-step-1', kind: 'deterministic_verification', satisfied_requirement_ids: ['held'] } })
  const accepted = getActivePlan(w.memory.planningState(KEY))
  assert.equal(accepted.execution.step_progress[first.scope.step_id].contract_satisfied, true, JSON.stringify(accepted.execution.step_progress[first.scope.step_id]))
  w.memory.dispatchPlanningEvent(KEY, { type: 'STEP_COMPLETED', source: 'runtime', now: Date.now(), plan_id: first.scope.plan_id, step_id: first.scope.step_id })
  assert.equal(getActivePlan(w.memory.planningState(KEY)).active_step_index, 1)
  Object.assign(w.context, { request_id: 'request-later', actor_epoch: 3 })
  // Re-read the original retained native receipt under current enrollment
  // authority; placement actor/epoch still matches the historical NPC row.
  const earlier = w.runtime.recordPlacement(first.raw, w.runtime.scope())
  assert.deepEqual(earlier.provenance, original)
  const second = placed(w, 28, 'stone-furnace')
  const declared = declaration(earlier, w.runtime.origin())
  declared.members.push(second.member)
  const cell = w.runtime.registerCell(declared, w.runtime.scope())
  assert.equal(cell.origin.request_id, 'request-later')
  assert.equal(cell.origin.actor_epoch, 3)
  assert.deepEqual(cell.members[0].provenance, original)
  assert.equal(cell.members[1].provenance.request_id, 'request-later')
  assert.notEqual(cell.members[0].provenance.semantic_step_id, cell.members[1].provenance.semantic_step_id)
})

test('actual admission refuses registered destructive and ambiguous mutations with correlated world reasons', () => {
  const w = world(); register(w)
  w.memory.clearTaskContext(KEY); plan(w.memory, 'Build iron independently')
  for (const operation of [
    { name: 'mine_entity_exact', args: { unit_number: 27 } },
    { name: 'rotate_entity', args: { unit_number: 27, direction: 4 } },
    { name: 'set_machine_recipe', args: { unit_number: 27, recipe_name: 'iron-plate' } },
    { name: 'mine_entity', args: { entity_name: 'burner-mining-drill', count: 1 } },
  ]) {
    const result = w.memory.checkOperationAdmission(KEY, { operations: [operation], actor: w.context }, { requestId: 'protect-request' })
    assert.equal(result.code, 'factory_cell_change_forbidden')
    assert.equal(result.refusal_class, 'world')
    assert.equal(result.cell_id, 'cell-1')
    assert.equal(w.events.at(-1).name, 'admission.factory_cell_refused')
    assert.equal(w.events.at(-1).request_id, 'protect-request')
  }
  for (const operation of [
    { name: 'mine_entity_exact', args: { unit_number: 900 } },
    { name: 'mine_entity', args: { entity_name: 'tree', count: 1 } },
    { name: 'clear_construction_area', args: { x: 0, y: 0, width: 4, height: 4 } },
  ]) assert.equal(w.memory.checkOperationAdmission(KEY, { operations: [operation] }).ok, true)
  for (const operation of [
    { name: 'supply_entity', args: { unit_number: 27, items: [{ item_name: 'coal', count: 1 }] } },
    { name: 'move_items_exact', args: { unit_number: 27, item_name: 'copper-plate', to_entity: false, max_count: 1 } },
  ]) assert.equal(w.memory.checkOperationAdmission(KEY, { operations: [operation] }).code, 'factory_cell_operation_resolution_required')
  assert.equal(w.memory.getFactoryRegistry().cells[0].state, 'unverified', 'ordinary supply is not commissioning proof')
})

async function bootstrap(memory) {
  const traces = []; const reads = []
  const game = new FakeFactorio({ factoryWorldId: WORLD })
  for (const cell of memory.factoryRegistryStatus().status === 'initialized' ? memory.getFactoryRegistry().cells : []) {
    for (const member of cell.members) game.factoryMembers.set(member.unit_number, { locator: member, state: 'observed', type: 'mining-drill',
      recipe: { state: 'unsupported' }, source_resources: { state: 'known', truncated: false,
        resources: [{ name: 'copper-ore', products_truncated: false, products: [{ type: 'item', name: 'copper-ore' }] }] } })
  }
  const nativeCommand = game.command.bind(game)
  game.command = async command => {
      if (!command.startsWith('{')) return nativeCommand(command)
      const { tool, args } = JSON.parse(command); reads.push({ tool, args })
      if (tool === 'getMiningDetails') return JSON.stringify(miningDetails('iron-ore', ['burner-mining-drill']))
      if (tool === 'getRecipeDetails') return JSON.stringify(recipeDetails(args.item_or_recipe))
      if (tool === 'getInventoryItems') return JSON.stringify([{ name: 'iron-plate', count: 8 }, { name: 'stone-furnace', count: 1 }])
      if (tool === 'getEntityStatus') return JSON.stringify({ found: true, entity: { unit_number: args.unit_number, name: 'burner-mining-drill' } })
      throw new Error(`Unexpected read ${tool}`)
    }
  const agent = new NpcAgentLoop({ memory, rcon: game, npcId: 'factory-test', stateFile: null, traceFile: null, decisionTraceFile: null,
    completionProtocolVersion: 3, jevCheckpoints: false, provider: async () => { throw new Error('No provider in bootstrap probe') } })
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'bootstrap-request' }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async row => traces.push({ name: row.event, ...row.data }) }
  const observation = agent.observationToolCommand.bind(agent)
  agent.observationToolCommand = (tool, args) => ['getMiningDetails', 'getRecipeDetails', 'getInventoryItems', 'getEntityStatus'].includes(tool)
    ? JSON.stringify({ tool, args }) : observation(tool, args)
  const refusal = await directFeedBootstrapRefusal(agent, { executionGuidance: [{ materialSupply: { mode: 'direct_feed', resource: 'iron-ore' } }] })
  return { refusal, traces, reads }
}

test('real bootstrap baseline counts an unassigned copper drill as spare; registry membership excludes it without step preserve', async () => {
  const w = world(); placed(w)
  const baseline = await bootstrap(w.memory)
  assert.equal(baseline.refusal, undefined)
  assert.equal(baseline.traces[0].verdict, 'feasible')
  assert.equal(baseline.reads.filter(row => row.tool === 'getEntityStatus').length, 1)
  const { member } = placed(w)
  w.runtime.registerCell(declaration(member), w.runtime.scope())
  const protectedResult = await bootstrap(w.memory)
  assert.equal(protectedResult.refusal.code, 'direct_feed_bootstrap_infeasible')
  const checked = protectedResult.traces.find(row => row.name === 'plan.direct_feed_bootstrap_checked')
  assert.equal(checked.verdict, 'infeasible')
  assert.equal(protectedResult.reads.filter(row => row.tool === 'getEntityStatus').length, 0)
  assert.deepEqual(checked.preserved, [], 'world assignment does not depend on step preserve')
})

test('real bootstrap reports unknown on a corrupt registry even when there are no recorded machines', async () => {
  for (const hasPlacement of [false, true]) {
    const w = world()
    if (hasPlacement) placed(w)
    const saved = w.memory.snapshot(); saved.factory_registry = null
    w.memory.restore(saved)
    const result = await bootstrap(w.memory)
    assert.equal(result.refusal, undefined)
    assert.equal(result.traces[0].verdict, 'unknown')
    assert.equal(result.traces[0].reason, 'facts_unreadable')
    assert.equal(result.reads.length, 0)
  }
})
