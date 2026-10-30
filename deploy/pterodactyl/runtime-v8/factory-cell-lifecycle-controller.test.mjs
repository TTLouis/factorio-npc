import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { boardPlanAlignment, CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { createFactoryRegistry, registerFactoryCell, factoryMetadataDigest as digest } from './factory-registry.mjs'
import { beginFactoryCellLifecycle, projectFactoryLifecycleEvidence, captureFactoryLifecycleCloseProof, closeFactoryCellLifecycles } from './factory-cell-lifecycle-controller.mjs'

const WORLD = '1f207b33-f2b7-4104-b04d-21bb089a304e'; const KEY = 'npc:lifecycle-controller'
const clone = value => structuredClone(value)

test('runtime and canonical memory initialize in either isolated import order', () => {
  const loop = new URL('./npc-agent-loop.mjs', import.meta.url).href
  const memory = new URL('./canonical-task-board-memory.mjs', import.meta.url).href
  for (const first of [loop, memory]) {
    const script = `
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(first)});
      const { NpcDialogueMemory } = await import(${JSON.stringify(loop)});
      const { CanonicalTaskBoardMemory } = await import(${JSON.stringify(memory)});
      assert.ok(new CanonicalTaskBoardMemory() instanceof NpcDialogueMemory);
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 })
    assert.equal(child.error, undefined, `${first}: ${child.error}`)
    assert.equal(child.status, 0, `${first}: ${child.stderr}`)
  }
})

function fixture(steps = ['Maintain the fixture job']) {
  const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD })
  memory.recordPlan(KEY, { sender: 'owner', text: 'Preserve this fixture production job' }, {
    chatMessage: '', plan: steps, currentStep: 0, operations: [], stepCompletions: steps.map(() => ({ kind: 'deterministic',
      checkpoint: { mode: 'all', confidence: 0.9, requirements: [{ id: 'stock', kind: 'inventory_count', item_name: 'fixture-output', minimum: 1 }] } })),
  }, { validatedPlannerAdmission: true }); memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const member = { unit_number: 27, name: 'fixture-machine', position: { x: 4, y: 2 }, surface_index: 1, force_index: 1, provenance: { source: 'fixture' } }
  const registry = registerFactoryCell(createFactoryRegistry(WORLD), { surface_index: 1, force_index: 1,
    assignment: { products: ['fixture-output'], purpose: 'Preserve output', method: 'native fixture' }, members: [member],
    ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: 'fixture-output' }], origin: { source: 'fixture' } })
  memory.restore({ ...memory.snapshot(), factory_registry_world_id: WORLD, factory_registry: registry })
  const scope = { world_id: WORLD, surface_index: 1, force_index: 1, actor_id: 24, actor_epoch: 2, session_id: 'controller-session', request_id: 'controller-request' }
  const nativeRow = locator => ({ locator, ...locator, type: 'container', state: 'observed', recipe: { state: 'known', truncated: false, ingredients: [], products: [{ name: 'fixture-output', type: 'item' }] },
    endpoint_facts: { schema_version: 1, fluidboxes: { state: 'known', truncated: false, endpoints: [] }, services: {
      electricity: { state: 'not_applicable' }, electric_network: { state: 'known', present: false },
      heat: { state: 'not_applicable', input_source: { state: 'known', present: false }, buffer: { state: 'known', present: false } } } },
    consumer_facts: { schema_version: 1, tick: 100, identity_scope: 'enclosing_exact_member', scope: 'direct_native_item_consumers',
      state: 'known', coverage: 'complete', truncated: false, unresolved: false, consumers: [] },
    removal_readiness: { schema_version: 1, tick: 100, scope: 'exact_building_only', state: 'known', recovery_capacity: 'verified', code: 'known', actor_inventory: [],
      snapshot: { target: { ...locator, type: 'container', quality: 'normal' }, contents: [], products: [{ name: 'fixture-machine', quality: 'normal', count: 1 }],
        inventories: [{ index: 1, size: 4, items: [] }], fluidboxes: 0, fluids_empty: true } } })
  const observation = { native: { schema_version: 1, ok: true, ...scope, tick: 100, members: [nativeRow(member)] } }
  const game = { status: { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', session: scope.session_id, actor_id: 24, actor_kind: 'standalone_character', epoch: 2,
    allowed: true, idle: true, actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 },
  task: { task_state: 'idle', queue_empty: true, queue_length: 0, admission_journal: [] }, calls: [],
  async command(text) {
    this.calls.push(text)
    if (text.includes('"sgluna_deployment","status"')) return JSON.stringify(this.status)
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: 24, valid: true }, surface_index: 1, force_index: 1 })
    if (text.includes('"autorio_operations","status"')) return JSON.stringify(this.task)
    if (text.includes('"autorio_tools","get_nearby_entities"')) {
      this.exactBound = true
      return JSON.stringify({ entities: [{ ...member, type: 'container' }], surface_index: 1, actor: { position: { x: 0, y: 0 } } })
    }
    if (text.includes('"autorio_tools","evaluate_condition"')) return JSON.stringify(this.exactBound
      ? { ok: true, current: 1, exists: true, satisfied: true } : { ok: false, error: 'stale_exact_identity', stale: true, unit_number: 27 })
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: true, world_id: WORLD })
    if (text.includes("'sgluna_factory','observe'")) {
      const body = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1]); await this.onObserve?.()
      return JSON.stringify({ ...body, ok: true, tick: 100, members: body.members.map(locator => { const row = nativeRow(locator); this.mutateRow?.(row); return row }) })
    }
    throw new Error(`Unexpected deterministic fixture command: ${text}`)
  } }
  const agent = new NpcAgentLoop({ memory, rcon: game, stateFile: null, traceFile: null, decisionTraceFile: null, npcId: 'lifecycle-controller',
    completionProtocolVersion: 3, jevCheckpoints: false, provider: () => assert.fail('No inference authorized') })
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: scope.request_id, seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0); agent.behaviorTrace = { emit: async () => {} }
  const cell = registry.cells[0]
  const change = { transaction_id: 'controller-expansion', cell_id: cell.cell_id, kind: 'expand', assignment: clone(cell.assignment), action_limit: 1,
    expected_registry_revision: registry.revision, expected_lifecycle_revision: 0,
    expected_cells: [{ cell_id: cell.cell_id, revision: cell.revision, digest: digest(cell) }],
    operations: [{ kind: 'add', name: 'fixture-machine', position: { x: 6, y: 2 }, operation: { name: 'place_entity', args: { entity_name: 'fixture-machine', x: 6, y: 2 }, placed_entity: 'fixture-machine' } }] }
  return { memory, registry, cell, scope, observation, game, agent, change }
}
test('raw native evidence projection refuses incomplete consumers and forged readiness identity', () => {
  const w = fixture(); const project = () => projectFactoryLifecycleEvidence(w)
  assert.equal(project().job_preserved, true)
  for (const mutate of [row => { row.consumer_facts.coverage = 'partial' }, row => { row.consumer_facts.consumers = [{ relation: 'inserter_pickup', state: 'connected', consumer: { unit_number: 99 } }] },
    row => { row.consumer_facts.tick-- }, row => { delete row.recipe.products[0].type }]) {
    const x = fixture(); mutate(x.observation.native.members[0]); assert.throws(() => projectFactoryLifecycleEvidence(x))
  }
  w.observation.native.members[0].removal_readiness.snapshot.target.unit_number++
  assert.equal(project().members[0].recovery_capacity, 'unknown')
  const destructive = fixture(); destructive.change.kind = 'modify'
  destructive.change.operations = [{ kind: 'remove', member: clone(destructive.cell.members[0]), quality: 'normal',
    operation: { name: 'mine_entity_exact', args: { unit_number: 27 } } }]
  assert.throws(() => projectFactoryLifecycleEvidence(destructive), { code: 'factory_lifecycle_remaining_job_unproven' })
})
test('controller uses actual host owner/world/read fences and canonical strict persistence', async () => {
  const testRoot = path.resolve('test-results/factory-lifecycle-controller'); await fs.mkdir(testRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(testRoot, 'state-'))
  try {
    const w = fixture(); w.agent.stateFile = path.join(directory, 'state.json')
    const before = clone(w.memory.planningState(KEY)); await beginFactoryCellLifecycle(w.agent, w.change)
    const snapshot = JSON.parse(await fs.readFile(w.agent.stateFile, 'utf8'))
    assert.equal(snapshot.factory_lifecycle.events[0].type, 'begin')
    assert.deepEqual(w.memory.planningState(KEY), before)
    assert.ok(w.game.calls.some(text => text.includes("'sgluna_factory','observe'")))
    assert.equal(w.game.calls.some(text => text.includes('autorio_operation_admission')), false)
    const stale = fixture(); stale.agent.stateFile = path.join(directory, 'stale.json')
    stale.game.onObserve = async () => { stale.agent.traceRequest = { id: 'replaced-request', seq: 0 } }
    await assert.rejects(beginFactoryCellLifecycle(stale.agent, stale.change))
    assert.equal(stale.memory.factoryLifecycleTransactions().length, 0)
  } finally {
    assert.ok(path.resolve(directory).startsWith(testRoot + path.sep)); await fs.rm(directory, { recursive: true, force: true })
  }
})
test('serialized completion labels cannot grant cleanup; actual close result must match every requirement', async () => {
  const w = fixture(); await assert.rejects(closeFactoryCellLifecycles(w.agent, { proof: { verified: true } }), { code: 'factory_cleanup_completion_unproven' })
  const owner = w.agent.captureCheckpointOwner()
  assert.throws(() => captureFactoryLifecycleCloseProof(w.agent, owner, { key: KEY, step: { id: owner.stepId },
    contract: { mode: 'all', requirements: [{ id: 'a', kind: 'inventory_count' }] }, results: [] }), { code: 'factory_cleanup_completion_unproven' })
})

test('cleanup close binds the current board identity to its canonical owner and committed contract', async () => {
  const w = fixture(); const owner = w.agent.captureCheckpointOwner()
  const board = w.memory.currentPlan(KEY).task_board; const step = board.steps[board.active_index]
  assert.notEqual(step.id, owner.stepId)
  const contract = w.agent.persistedStepCheckpoint(board, step.id).contract
  const details = { key: KEY, step, contract, results: contract.requirements.map(row => ({ id: row.id, kind: row.kind, satisfied: true })) }
  for (const invalid of [{ ...details, step: { ...step, id: owner.stepId } },
    { ...details, contract: { ...contract, requirements: contract.requirements.map(row => ({ ...row, minimum: row.minimum + 1 })) } },
    { ...details, results: details.results.map(row => ({ ...row, satisfied: false })) }]) {
    assert.throws(() => captureFactoryLifecycleCloseProof(w.agent, owner, invalid), { code: 'factory_cleanup_completion_unproven' })
  }
  const before = clone(w.memory.planningState(KEY))
  const proof = captureFactoryLifecycleCloseProof(w.agent, owner, details)
  assert.deepEqual(await closeFactoryCellLifecycles(w.agent, { proof }), { complete: true })
  assert.deepEqual(w.memory.planningState(KEY), before)
  await assert.rejects(closeFactoryCellLifecycles(w.agent, { proof }), { code: 'factory_cleanup_completion_unproven' })
})

test('cleanup close aligns a carried-prefix successor while rejecting other steps and contracts', async () => {
  const w = fixture(['Verify the fixture stock', 'Maintain the fixture job'])
  const firstBoard = w.memory.currentPlan(KEY).task_board
  const contract = w.agent.persistedStepCheckpoint(firstBoard, firstBoard.active_step_id).contract
  const results = contract.requirements.map(row => ({ id: row.id, kind: row.kind, satisfied: true }))
  const closed = w.memory.applyOutcomeAuthority(KEY, { kind: 'verified_complete', source: 'deterministic_runtime',
    reason_code: 'deterministic_completion_contract', metadata: { scope: 'step' }, evidence: [{ kind: 'verified_world_state',
      ref: `checkpoint/${firstBoard.active_step_id}`, summary: JSON.stringify({ contract, results }) }] })
  assert.equal(closed.decision.accepted, true)
  w.memory.applyOutcomeAuthority(KEY, { kind: 'world_blocked', source: 'deterministic_runtime',
    reason_code: 'transfer_failed:item_missing', candidate_blocker: 'transfer_failed:item_missing',
    evidence: [{ kind: 'fresh_world_observation', ref: 'fixture-block', summary: 'fixture input unavailable' }] })
  w.memory.recordBlockedChoice(KEY, 'revise', 'owner')
  const blockedBoard = w.memory.currentPlan(KEY).task_board
  const proposed = { chatMessage: '', plan: ['Verify the fixture stock', 'Restore the fixture input', 'Maintain the fixture job'],
    currentStep: blockedBoard.completed_count, operations: [{ name: 'wait', args: { ticks: 1 } }] }
  const recorded = w.memory.recordPlan(KEY, { sender: 'owner', text: 'revise the plan' }, proposed)
  w.memory.reconcileTaskBoard(KEY, blockedBoard, proposed, recorded, { previousState: w.memory.currentPlan(KEY) })
  assert.equal(recorded.userRevisionApproved, true)
  w.memory.setStepCompletionContract(KEY, w.memory.currentPlan(KEY).task_board.active_step_id, contract)
  w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const owner = w.agent.captureCheckpointOwner(); const before = clone(w.memory.planningState(KEY))
  const board = w.memory.currentPlan(KEY).task_board; const plan = getActivePlan(before)
  assert.equal(boardPlanAlignment(board, plan), 1)
  assert.equal(owner.stepIndex, 0); assert.equal(board.active_index, 1)
  const step = board.steps[board.active_index]
  const committed = w.agent.persistedStepCheckpoint(board, step.id).contract
  const details = { key: KEY, step, contract: committed, results }
  for (const invalid of [{ ...details, step: board.steps[0] }, { ...details, step: board.steps[2] },
    { ...details, step: { id: owner.stepId } },
    { ...details, contract: { ...committed, requirements: committed.requirements.map(row => ({ ...row, minimum: row.minimum + 1 })) } }]) {
    assert.throws(() => captureFactoryLifecycleCloseProof(w.agent, owner, invalid), { code: 'factory_cleanup_completion_unproven' })
  }
  const proof = captureFactoryLifecycleCloseProof(w.agent, owner, details)
  assert.deepEqual(await closeFactoryCellLifecycles(w.agent, { proof }), { complete: true })
  assert.deepEqual(w.memory.planningState(KEY), before)
})

test('actual controller refuses item-only empty cuts for unregistered service consumers and unknown interfaces', async () => {
  const temporary = fixture(); temporary.change.kind = 'cleanup'
  temporary.change.operations = [{ kind: 'remove', member: temporary.cell.members[0], quality: 'normal' }]
  temporary.observation.native.members[0].recipe = { state: 'not_applicable', products: {} }
  temporary.observation.native.members[0].endpoint_facts.fluidboxes.endpoints = {}
  assert.equal(projectFactoryLifecycleEvidence({ ...temporary, temporary: [{ unit_number: 27, eligible: true }] }).redundancy, 'verified')
  for (const mutate of [row => { row.type = 'generator'; row.endpoint_facts.services.electricity = { state: 'known' }; row.live_unregistered_service_consumer = 'electric-load' },
    row => { row.type = 'assembling-machine'; row.recipe.products = [{ name: 'fixture-fluid', type: 'fluid' }]; row.endpoint_facts.fluidboxes.endpoints = [{ fluidbox_index: 1 }]; row.live_unregistered_service_consumer = 'fluid-receiver' },
    row => { row.endpoint_facts.services.heat = { state: 'known' } }, row => { delete row.endpoint_facts },
    row => { row.endpoint_facts.fluidboxes.state = 'unknown' }, row => { row.endpoint_facts.services.electric_network.present = true }]) {
    const w = fixture(); w.agent.stateFile = '/never-written-domain-refusal.json'; w.game.mutateRow = mutate
    await assert.rejects(beginFactoryCellLifecycle(w.agent, w.change), { code: 'factory_lifecycle_consumer_domain_unknown' })
    assert.equal(w.memory.factoryLifecycleTransactions().length, 0)
  }
  for (const kind of ['power', 'fluid', 'heat']) {
    const w = fixture(); w.cell.ports.push({ port_id: 'uncovered-service', direction: 'output', kind })
    assert.throws(() => projectFactoryLifecycleEvidence(w), { code: 'factory_lifecycle_consumer_domain_unknown' })
  }
})

test('native-driver staging uses real committed-plan executor handoff and retains planner mutation refusal', async () => {
  const w = fixture()
  assert.equal(w.agent.agentContext.role, 'planner')
  assert.throws(() => w.agent.validatePlannerRoleOutput({ operations: [w.change.operations[0].operation] }), { code: 'planner_cannot_mutate' })
  const before = clone(w.memory.planningState(KEY))
  const handoff = await w.agent.startExecutorAtCommit({ planId: before.active_plan_id, requestId: w.agent.traceRequest.id })
  assert.equal(handoff.restaged, true, JSON.stringify(handoff))
  assert.equal(w.agent.agentContext.role, 'executor'); assert.equal(w.agent.agentContext.hasParkedPlanner, true)
  assert.doesNotThrow(() => w.agent.validatePlannerRoleOutput({ operations: [w.change.operations[0].operation] }))
  const after = w.memory.planningState(KEY)
  assert.deepEqual(after.goal, before.goal); assert.deepEqual(after.plans, before.plans)
})

test('ordinary discovery binds synthetic checkpoint hardware without bypassing stale native identity', async () => {
  const w = fixture(); w.agent.observationBudgetRemaining = 10
  const contract = { mode: 'all', requirements: [{ id: 'exact-stock', kind: 'entity_inventory_count', unit_number: 27, item_name: 'fixture-output', minimum: 1 }] }
  const before = await w.agent.completionFactsForContract(contract, undefined, [], { committedIdentity: true })
  assert.equal(before['exact-stock'].stale, true); assert.equal(before['exact-stock'].authoritative, false)
  await w.agent.handleToolBatch({ content: '', tool_calls: [{ id: 'discover-checkpoint', type: 'function', function: {
    name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 12, name: 'fixture-machine', limit: 8 }) } }] })
  assert.ok(w.agent.liveObservedExactTarget(27))
  const after = await w.agent.completionFactsForContract(contract, undefined, [], { committedIdentity: true })
  assert.equal(after['exact-stock'].authoritative, true); assert.equal(after['exact-stock'].satisfied, true)
  assert.equal(w.game.calls.filter(text => text.includes('"autorio_tools","get_nearby_entities"')).length, 1)
})
