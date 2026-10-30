import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { ensureCommittedFactoryCellBeforeClose, validateFactoryCellDraft, enrollFactoryProductionProducers, factoryPlacementAdmissionScope, directFeedSingletonPlacementRefusal } from './factory-cell-enrollment.mjs'
import { pauseStrandedPlanAfterRequestError } from './supervisor.mjs'
import { classifyRequestFailure, isProviderFailurePause } from './pause-class.mjs'
import { appendFactoryCellMetadata, factoryCellMetadataHead, registerFactoryCell } from './factory-registry.mjs'
import { reconcileFactoryCellUse, factoryUseDecision, factoryUseFailureWitness } from './factory-cell-use.mjs'
import { FactoryUseRecoveryStore, recoverFactoryCellUse } from './factory-cell-use-recovery.mjs'
import { playerObjectiveGrant } from './replacement-wake.mjs'

const KEY = 'npc:enrollment-test'
const WORLD = '1e837e91-4f33-43a2-a3aa-c891ee06ec66'
const INTENT = { kind: 'direct_feed', product: 'copper-plate', sourceEntity: 'burner-mining-drill', targetEntity: 'stone-furnace', purpose: 'Keep copper production assigned' }
const CHECKPOINT = { mode: 'all', confidence: 0.9, requirements: [{ id: 'held', kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] }
const clone = v => structuredClone(v)

async function implicitFixture({ startup = false, construction = false } = {}) {
  const w = fixture({ intent: false, materialSupply: { mode: 'direct_feed', resource: 'copper-ore' }, deferCommit: true,
    checkpoint: construction ? { mode: 'all', requirements: [INTENT.sourceEntity, INTENT.targetEntity].map(prototype => ({ kind: 'entity_count', prototype, minimum: 1 })) } : CHECKPOINT })
  w.memory.grantAuthorization(KEY, playerObjectiveGrant(w.memory.planningState(KEY).goal.goal_id))
  w.agent.stateFile = '/synthetic/strict-state'
  w.game.onObserve = response => {
    response.tick += w.game.observeCount
    for (const [index, row] of response.members.entries()) {
      row.type = index === 0 ? 'mining-drill' : 'furnace'
      row.burner_fuel_requirement = { state: 'known', required: true, truncated: false, fuel_categories: ['fixture-fuel'] }
      row.fuel_item_facts = { state: 'known', coverage: 'complete', truncated: false, items: [{ name: 'coal', category: 'fixture-fuel', fuel_value: 1 }] }
    }
    const [source, target] = response.members
    target.endpoint_facts = { schema_version: 1, inventories: { state: 'known', truncated: false,
      endpoints: [{ state: 'known', inventory_index: 3, roles: { state: 'known', values: ['output'] } }] },
      recipe_selection: { quality: { state: 'known', name: 'normal' } } }
    target.progress_facts = { crafting_progress: { state: 'known', value: 0 }, products_finished: { state: 'known', value: 0 } }
    target.inventories = [{ role: 'input', index: 2, state: 'known', truncated: false, items: [] },
      { role: 'output', index: 3, state: 'known', truncated: false, items: [] }]
    target.incoming_item_facts = { schema_version: 1, tick: response.tick, state: 'known', coverage: 'complete', truncated: false, unresolved: false,
      producers: [{ relation: 'mining_drop', state: 'connected', producer: source.locator }] }
    if (startup) {
      target.startup_recipe_candidates = { schema_version: 1, tick: response.tick, state: 'known', coverage: 'complete', truncated: false,
        selection: 'unselected', commissioning: 'unverified', basis: 'enabled_native_recipe_category_and_surface',
        candidates: [{ ...target.recipe, applicability: { state: 'available' } }] }
      target.recipe = { state: 'none', truncated: false, ingredients: [], products: [] }
    }
  }
  assert.equal((await reconcileFactoryCellUse(w.agent, { phase: 'commit' })).kind, 'establishment')
  w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  await w.build()
  return w
}

for (const startup of [false, true]) test(`implicit direct-feed establishment enrolls exact new receipts at first startup use (unselected=${startup})`, async () => {
  const w = await implicitFixture({ startup })
  const before = clone(w.memory.planningState(KEY))
  const operations = [{ name: 'supply_entity', args: { unit_number: 71, items: [{ item_name: 'coal', count: 1 }] } }]
  const result = await reconcileFactoryCellUse(w.agent, { phase: 'admission', operations })
  assert.equal(result.kind, 'existing'); assert.equal(result.delivery_ready, false)
  const cell = w.memory.getFactoryRegistry().cells[0]
  assert.deepEqual(cell.members.map(row => row.unit_number), [71, 72])
  assert.deepEqual(cell.assignment.products, ['copper-plate'])
  assert.ok(w.writes.some(row => row.factory_registry.cells.length === 1), 'registration reached strict canonical persistence')
  assert.deepEqual(w.memory.planningState(KEY), before, 'goal and committed plan semantics/history are untouched')
  await assert.rejects(w.enroll(), { code: 'factory_cell_delivery_unverified' })
  const pending = await w.agent.recordPendingOperationBeforeSend(operations, w.game.deployment, [{ ok: true, operation: 'supply_entity' }])
  assert.equal(pending.operations[0].name, 'supply_entity', 'actual shared presend admits only assigned startup fuel')
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1, 'fresh resolution does not enroll twice')
})

for (const mode of ['missing_receipt', 'wrong_resource', 'stale_owner', 'legacy_target', 'ambiguous_recipe']) test(`implicit establishment refuses ${mode} without adopting an existing member`, async () => {
  const w = await implicitFixture({ startup: true })
  if (mode === 'missing_receipt') {
    const snapshot = w.memory.snapshot(); snapshot.factory_placement_receipts.pop(); w.memory.restore(snapshot)
  }
  const observe = w.game.onObserve
  w.game.onObserve = response => {
    observe(response)
    if (mode === 'wrong_resource') response.members[0].source_resources.resources[0].name = 'iron-ore'
    if (mode === 'wrong_resource') response.members[0].source_resources.resources[0].products[0].name = 'iron-ore'
    if (mode === 'stale_owner') w.agent.traceRequest = { id: 'replacement-request' }
    if (mode === 'ambiguous_recipe') response.members[1].startup_recipe_candidates.candidates.push({ ...response.members[1].startup_recipe_candidates.candidates[0], name: 'other-native-recipe' })
  }
  const unit = mode === 'legacy_target' ? 999 : 71
  if (mode === 'legacy_target') w.memory.recordNpcPlacement(KEY, { unit_number: unit, entity_name: 'burner-mining-drill', actor_id: 24, actor_epoch: 2 })
  await assert.rejects(reconcileFactoryCellUse(w.agent, { phase: 'admission', operations: [{ name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'coal', count: 1 }] } }] }))
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
})

test('omitted/null intent cannot exempt typed material supply; dedicated supplier wins without changing copper', async () => {
  const w = await fixture().build(); await w.enroll()
  const copper = clone(w.memory.getFactoryRegistry().cells[0]); const goal = clone(w.memory.planningState(KEY))
  const iron = { materialSupply: { mode: 'direct_feed', resource: 'iron-ore' }, cellIntent: null }
  await assert.rejects(reconcileFactoryCellUse(w.agent, { step: iron }), { code: 'factory_cell_resolution_required' })
  const registry = registerFactoryCell(w.memory.getFactoryRegistry(), { surface_index: 1, force_index: 1,
    assignment: { products: ['iron-plate'], purpose: 'Synthetic dedicated iron supplier', method: 'direct_feed' },
    members: copper.members.map(member => ({ ...clone(member), unit_number: member.unit_number + 100,
      position: { x: member.position.x + 100, y: member.position.y }, provenance: { source: 'synthetic_fixture' } })),
    ports: [{ port_id: 'output', kind: 'item', direction: 'output', resource: 'iron-plate' }], origin: { source: 'synthetic_fixture' } })
  w.memory.restore({ ...w.memory.snapshot(), factory_registry: registry })
  w.game.onObserve = response => {
    if (response.members[0].locator.unit_number < 100) return
    response.members[0].source_resources.resources[0].name = 'iron-ore'
    response.members[0].source_resources.resources[0].products[0].name = 'iron-ore'
    response.members[1].recipe = { state: 'known', truncated: false, name: 'iron-plate', ingredients: [{ name: 'iron-ore', type: 'item' }], products: [{ name: 'iron-plate', type: 'item' }] }
  }
  const result = await reconcileFactoryCellUse(w.agent, { step: iron })
  assert.equal(result.cell_id, 'cell-2'); assert.equal(result.delivery.state, 'configured'); assert.equal(result.commissioning, 'unverified')
  assert.equal(factoryUseDecision(w.memory, KEY, iron).ok, true)
  await assert.rejects(reconcileFactoryCellUse(w.agent, { step: iron, operations: [{ name: 'move_items_exact', args: { unit_number: copper.members[1].unit_number, item_name: 'iron-ore', to_entity: true } }] }), { code: 'factory_cell_assigned_job_mismatch' })
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0], copper); assert.deepEqual(w.memory.planningState(KEY), goal)
  w.memory.restore(w.memory.snapshot())
  assert.equal(factoryUseDecision(w.memory, KEY, iron).ok, false, 'restored metadata does not restore native use authority')
})

test('typed resolution fences owner, native busy and registry changes across native awaits', async () => {
  for (const mode of ['owner', 'busy', 'registry']) {
    const w = await fixture().build(); await w.enroll()
    const before = clone(w.memory.getFactoryRegistry())
    w.game.onObserve = () => {
      if (mode === 'owner') w.agent.traceRequest = { id: 'replacement-request' }
      if (mode === 'busy') w.game.status.queue_empty = false
      if (mode === 'registry') w.memory.restore(w.memory.snapshot())
    }
    await assert.rejects(reconcileFactoryCellUse(w.agent, { step: { materialSupply: { mode: 'direct_feed', resource: 'copper-ore' } } }))
    assert.deepEqual(w.memory.getFactoryRegistry(), before); assert.equal(w.memory.pendingOperations(KEY).length, 0)
  }
})

test('actual canonical commit and shared close require attributed direct delivery from the matching unchanged assigned cell', async () => {
  const built = await fixture().build(); await built.enroll()
  const registry = clone(built.memory.getFactoryRegistry())
  const w = fixture({ intent: false, materialSupply: { mode: 'direct_feed', resource: 'copper-ore' }, registry, deferCommit: true })
  let delivered = false
  w.game.onObserve = response => {
    response.tick = 1000 + w.game.observeCount
    const [source, target] = response.members
    target.incoming_item_facts = { schema_version: 1, tick: response.tick, state: 'known', coverage: 'complete', truncated: false, unresolved: false,
      producers: [{ relation: 'mining_drop', state: 'connected', producer: source.locator }] }
    target.inventories = [{ role: 'input', index: 2, state: 'known', truncated: false, items: delivered ? [{ name: 'copper-ore', quality: 'normal', count: 1 }] : [] }]
    target.endpoint_facts = { recipe_selection: { quality: { state: 'known', name: 'normal' } } }
    target.progress_facts = { products_finished: { state: 'known', value: 0 }, crafting_progress: { state: 'known', value: 0 } }
  }
  assert.throws(() => w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } }), { code: 'factory_cell_resolution_required' })
  const first = await reconcileFactoryCellUse(w.agent)
  assert.equal(first.delivery_required, true); assert.equal(first.delivery_ready, false)
  w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  await assert.rejects(ensureCommittedFactoryCellBeforeClose(w.agent, w.agent.captureCheckpointOwner()), { code: 'factory_cell_delivery_unverified' })
  assert.equal(getActivePlan(w.memory.planningState(KEY)).status, 'COMMITTED')
  delivered = true
  const board = w.memory.currentPlan(KEY).task_board
  const result = await w.agent.applyStepClose('fixture_direct_window', { key: KEY, step: board.steps[board.active_index], contract: CHECKPOINT,
    results: [{ id: 'held', kind: 'inventory_count', satisfied: true }], reasonCode: 'fixture_native_checkpoint', source: 'deterministic_runtime' })
  assert.equal(result.closed, true)
  assert.deepEqual(w.memory.getFactoryRegistry(), registry)
  assert.ok(w.events.some(row => row.event === 'factory_cell.use_resolved' && row.data.phase === 'close' && row.data.resolution.delivery_ready === true))
})

test('canonical use approval cannot survive live owner, session or world mutation changes', async () => {
  const built = await fixture().build(); await built.enroll()
  const registry = clone(built.memory.getFactoryRegistry())
  for (const change of [
    w => { w.agent.traceRequest = { id: 'replacement' } },
    w => { w.agent.epoch = { ...w.agent.epoch, session: 'replacement' } },
    w => { w.agent.epoch = { ...w.agent.epoch, epoch: w.agent.epoch.epoch + 1 } },
    w => { w.agent.worldMutationSeq = (w.agent.worldMutationSeq ?? 0) + 1 },
    w => { w.agent.generation++ },
  ]) {
    const w = fixture({ intent: false, materialSupply: { mode: 'direct_feed', resource: 'copper-ore' }, registry, deferCommit: true })
    await reconcileFactoryCellUse(w.agent)
    change(w)
    assert.throws(() => w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } }), { code: 'factory_cell_resolution_required' })
  }
})

test('operating checkpoint refuses unknown native input coverage despite compatible assigned output', async () => {
  const w = await fixture().build(); await w.enroll()
  const step = { completion_contract: { mode: 'all', requirements: [
    { kind: 'entity_state', unit_number: w.memory.getFactoryRegistry().cells[0].members[1].unit_number, expected: 'working' },
  ] } }
  const observed = await reconcileFactoryCellUse(w.agent, { step, phase: 'activation' })
  assert.equal(observed.operating_ready, false)
  assert.equal(observed.cells.length, 1)
  assert.equal(factoryUseDecision(w.memory, KEY, step, { close: true }).code, 'factory_cell_operating_inputs_unverified')
  await assert.rejects(reconcileFactoryCellUse(w.agent, { step, phase: 'close' }), { code: 'factory_cell_operating_inputs_unverified' })
})

test('factory use recovery allowance is durable per goal/requirement across requests and cannot refund history', () => {
  const store = new FactoryUseRecoveryStore(); const requirement = { kind: 'direct_feed', resource: 'iron-ore' }
  const attempt = i => ({ request_id: `request-${i}`, plan_id: `plan-${i}`, code: 'factory_cell_resolution_required', evidence_digest: 'a'.repeat(64) })
  assert.equal(store.consume('goal', requirement, attempt(1)).allowed, true)
  assert.equal(store.consume('goal', requirement, attempt(1)).duplicate, true)
  let restored = new FactoryUseRecoveryStore(); restored.restore(store.snapshot())
  assert.equal(restored.consume('goal', requirement, attempt(2)).allowed, true)
  const saved = restored.snapshot(); restored = new FactoryUseRecoveryStore(); restored.restore(saved)
  assert.equal(restored.consume('goal', requirement, attempt(3)).allowed, true)
  assert.equal(restored.consume('goal', requirement, attempt(4)).exhausted, true)
  assert.equal(restored.consume('goal', { kind: 'direct_feed', resource: 'different-slice-resource' }, attempt(5)).exhausted, true, 'changed slice requirement cannot renew same-goal allowance')
  restored.restore(saved)
  assert.throws(() => restored.consume('goal', requirement, attempt(4)), { code: 'factory_use_recovery_fault' })
})

test('actual residual resolver consumes allowance before the existing guarded structural wake; goal and committed semantics stay immutable', async () => {
  const w = await fixture().build(); await w.enroll()
  const original = clone(w.memory.planningState(KEY)); const plan = getActivePlan(original)
  w.memory.grantAuthorization(KEY, playerObjectiveGrant(original.goal.goal_id))
  w.agent.replacementWakeEnabled = true; w.agent.stateFile = '/synthetic/persistence-enabled'
  w.agent.agentContext.role = 'planner'
  let wake
  w.agent.continueFromModMessage = async message => { wake = message; return { synthetic_planner_woken: true } }
  w.game.onObserve = response => { response.members[0].source_resources.resources[0].products[0].name = 'iron-ore' }
  let failure
  try { await reconcileFactoryCellUse(w.agent) }
  catch (error) { failure = error }
  assert.ok(failure)
  assert.ok(factoryUseFailureWitness(failure), JSON.stringify({ code: failure.code, details: failure.details }))
  assert.ok(w.memory.currentGoalGrant(KEY))
  const recovered = await recoverFactoryCellUse(w.agent, failure)
  assert.equal(recovered.handled, true, JSON.stringify({ state: getActivePlan(w.memory.planningState(KEY)).status, events: w.events.slice(-3) }))
  assert.match(wake, /PLAN_BLOCKED/)
  assert.match(wake, /factory_cell_resolution_required/)
  assert.equal(w.memory.snapshot().factory_use_recovery.records[0].attempts.length, 1)
  assert.ok(w.writes.some(row => row.factory_use_recovery?.records[0]?.attempts.length === 1))
  const after = w.memory.planningState(KEY)
  assert.equal(after.goal.goal_id, original.goal.goal_id); assert.equal(after.goal.requested_result, original.goal.requested_result)
  assert.deepEqual(getActivePlan(after).steps, plan.steps)
  assert.equal(getActivePlan(after).status, 'BLOCKED')
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.ok(w.events.some(row => row.event === 'plan.replacement_wake'))
})

for (const kind of ['miner', 'assembler', 'repeated', 'power']) test(`general ${kind} block enrolls exact receipt roles through real pre-send/settlement/close`, async () => {
  const members = kind === 'repeated' ? [{ role: 'left', entity: 'fixture-assembler' }, { role: 'right', entity: 'fixture-assembler' }]
    : [{ role: 'producer', entity: `fixture-${kind}` }]
  const outputs = members.map(row => ({ role: row.role, kind: kind === 'power' ? 'power' : 'item', resource: kind === 'power' ? null : 'fixture-product' }))
  const intent = { kind: 'production_block', purpose: 'Retain synthetic fixture production', members, outputs }
  const w = fixture({ intent })
  // Synthetic native shapes exercise ownership and role binding, not mechanics.
  w.game.onObserve = response => {
    response.members = response.members.filter(row => row.locator).map(row => ({ locator: row.locator, state: 'observed',
      recipe: kind === 'miner' || kind === 'power' ? { state: 'unsupported' } : { state: 'known', truncated: false,
        name: 'fixture-recipe', ingredients: [], products: [{ name: 'fixture-product', type: 'item' }] },
      source_resources: kind === 'miner' ? { state: 'known', truncated: false, resources: [{ name: 'fixture-resource', products_truncated: false,
        products: [{ name: 'fixture-product', type: 'item' }] }] } : { state: 'not_applicable' },
      ...(kind === 'power' ? { progress_facts: { electricity_production: { state: 'known', producer: true } } } : {}) }))
  }
  for (const member of members) await w.place(member.entity)
  const before = clone(w.memory.planningState(KEY))
  const result = await w.enroll()
  assert.equal(result.ok, true)
  const cell = w.memory.getFactoryRegistry().cells[0]
  assert.equal(cell.members.length, members.length)
  assert.deepEqual(cell.enrollment.member_roles.map(row => row.role), members.map(row => row.role))
  assert.deepEqual(cell.enrollment.member_roles.map(row => row.receipt_id), cell.enrollment.receipt_ids)
  assert.deepEqual(w.memory.planningState(KEY), before)
  const snapshot = w.memory.snapshot(); w.memory.restore(snapshot)
  assert.equal((await w.enroll()).duplicate, true)
  w.game.onObserve = response => { response.members = response.members.filter(row => row.locator).map(row => ({ locator: row.locator, state: 'observed', recipe: { state: 'unsupported' } })) }
  await assert.rejects(w.enroll(), { code: 'factory_enrollment_native_unverified' })
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0], cell)
})

test('original committed enrollment stays idempotent after additive metadata revision and restore', async () => {
  const w = await fixture().build(); await w.enroll()
  const snapshot = w.memory.snapshot(); const registry = snapshot.factory_registry; const cell = registry.cells[0]
  const { provenance, ...member } = cell.members[1]
  const request = { transaction_id: 'enrolled-input', cell_id: cell.cell_id, expected_registry_revision: registry.revision,
    expected_cells: [{ cell_id: cell.cell_id, revision: cell.revision, digest: factoryCellMetadataHead(cell) }],
    input_ports: [{ port_id: 'input', direction: 'input', kind: 'item', resource: 'copper-ore' }],
    port_bindings: [{ port_id: 'input', member, endpoint: { kind: 'inventory', inventory_index: 1 }, state: 'unverified', evidence_refs: ['unverified-host-declaration'] }],
    dependencies: [{ consumer: { cell_id: cell.cell_id, port_id: 'input' }, supplier: { kind: 'unresolved' }, delivery: { kind: 'unknown' } }] }
  const next = appendFactoryCellMetadata(registry, request, cell.origin).registry
  w.memory.restore({ ...snapshot, factory_registry: next })
  await assert.rejects(w.enroll(), { code: 'factory_cell_supplier_unverified' })
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
  assert.equal(w.memory.getFactoryRegistry().cells[0].revision, 2)
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0].enrollment, cell.enrollment)
})
function fixture({ intent = true, bound = true, materialSupply, registry, deferCommit = false, checkpoint = CHECKPOINT } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  if (bound) memory.initializeFactoryRegistry(WORLD)
  const draft = { chatMessage: '', plan: ['Build and configure one dedicated copper pair'], currentStep: 0, operations: [],
    executionGuidance: [{ approach: 'Build the observed direct-feed pair', rationale: 'Retain its intended output', constraints: [], skillIds: [],
      ...(intent === true ? { materialSupply: { mode: 'direct_feed', resource: 'copper-ore' } } : {}),
      ...(materialSupply ? { materialSupply } : {}),
      ...(intent ? { cellIntent: clone(typeof intent === 'object' ? intent : INTENT) } : {}) }],
    stepCompletions: [{ kind: 'deterministic', checkpoint }] }
  memory.recordPlan(KEY, { sender: 'owner', text: 'Build dedicated copper production' }, draft, { validatedPlannerAdmission: true })
  if (registry) memory.restore({ ...memory.snapshot(), factory_registry: clone(registry) })
  if (bound && !deferCommit) memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const events = []; const writes = []; const game = {
    world: WORLD, count: 0, observeCount: 0,
    deployment: { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', session: 'enrollment-session', actor_id: 24, actor_kind: 'standalone_character', epoch: 2,
      allowed: true, idle: true, actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 },
    status: { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, admission_journal: [], receipt_journal: [] },
  }
  const rcon = { command: async text => {
    await game.onCommand?.(text)
    if (text.includes('sgluna_deployment') && text.includes('status')) return JSON.stringify(game.deployment)
    if (text.includes('autorio_actor') && text.includes('status')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: 24, valid: true }, surface_index: 1, force_index: 1 })
    if (text.includes('autorio_operations') && text.includes('status')) return JSON.stringify(game.status)
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: Boolean(game.world), code: game.world ? 'ok' : 'world_unbound', world_id: game.world })
    if (text.includes("'sgluna_factory','observe'")) {
      game.observeCount++
      const request = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1])
      const [source, target] = request.members
      const response = { ...request, ok: true, tick: 1000, members: [
        { locator: source, state: 'observed', source_resources: { state: 'known', truncated: false, resources: [
          { name: 'copper-ore', amount: 100, products_truncated: false, products: [{ name: 'copper-ore', type: 'item' }] }] },
        recipe: { state: 'unsupported' }, item_routes: { state: 'known', truncated: false, routes: [{ kind: 'drop', state: 'connected', target }] } },
        { locator: target, state: 'observed', recipe: { state: 'known', truncated: false, name: 'copper-plate',
          ingredients: [{ name: 'copper-ore', type: 'item' }], products: [{ name: 'copper-plate', type: 'item' }] }, source_resources: { state: 'not_applicable', resources: [], truncated: false } },
      ] }
      await game.onObserve?.(response)
      return JSON.stringify(response)
    }
    throw new Error(`Unexpected native command: ${text}`)
  } }
  const agent = new NpcAgentLoop({ rcon, memory, stateFile: null, traceFile: null, decisionTraceFile: null,
    npcId: 'enrollment-test', completionProtocolVersion: 3, jevCheckpoints: false, provider: async () => { throw new Error('No provider authorized') } })
  agent.active = true; agent.epoch = { ...game.deployment }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'enrollment-request', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async record => { events.push(record); await game.onTrace?.(record) } }
  agent.persistState = async () => { writes.push(memory.snapshot()); await game.onPersist?.() }
  const w = { memory, agent, game, events, writes, draft }
  w.place = async (name, unit = ++game.count + 70) => {
    const pending = await agent.recordPendingOperationBeforeSend([{ name: 'place_entity', args: { entity_name: name, x: unit, y: 4 } }], game.deployment, [{ operation: 'place_entity', ok: true }])
    assert.equal(pending.surface_index, 1, 'actual shared pre-send supplies authoritative native surface')
    const n = pending.ordinal; const ref = { batch_id: n, batch_generation: 1, batch_ref: `batch-g1-${n}` }
    const batch = { ...ref, state: 'completed', task_count: 1, task_types: ['placing'], started_count: 1, tick: 100 + n }
    game.status.last_completed_batch = clone(batch); game.status.receipt_journal.push(batch)
    game.status.admission_journal.push({ operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, actor_id: 24, epoch: 2,
      ordinal: n, operation_count: 1, generation: 1, state: 'completed', ok: true, tick: 100 + n,
      slots: [{ index: 1, ok: true, operation: 'place_entity', queued_tasks: 1, batch_refs: [ref] }] })
    game.status.basic_operation = { last_result: { accepted: true, completed: true, code: 'completed', type: 'placing', operation_id: n, tick: batch.tick,
      actor_id: 24, actor_kind: 'standalone_character', entity_name: name, placed_unit_number: unit, placed_position: { x: unit, y: 4 }, placed_world_id: WORLD,
      placed_surface_index: 1, placed_force_index: 1, placed_batch_id: n, placed_batch_generation: 1, placed_batch_ref: ref.batch_ref } }
    const response = await agent.taskStatusReceipt()
    assert.equal(response.view.status_error, undefined)
    assert.equal(memory.pendingOperations(KEY).length, 0)
    assert.ok(memory.snapshot().factory_placement_receipts?.some(row => row.unit_number === unit))
    return pending
  }
  w.build = async () => { await w.place(INTENT.sourceEntity); await w.place(INTENT.targetEntity); return w }
  w.enroll = () => ensureCommittedFactoryCellBeforeClose(agent, agent.captureCheckpointOwner())
  return w
}

test('real pre-send to settlement captures intended AND intentless UUID-bound placements', async () => {
  for (const intent of [true, false]) {
    const w = fixture({ intent }); await w.place(INTENT.sourceEntity)
    assert.equal(w.memory.snapshot().factory_placement_receipts.length, 1)
    assert.equal(w.memory.snapshot().factory_placement_receipts[0].surface_index, 1)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  }
})

test('historical v1 neutral placement gains no cell authority; typed supply and real machine use still require canonical proof', async () => {
  const w = fixture({ intent: false }); w.agent.completionProtocolVersion = 1
  w.agent.memory = { currentPlan: () => ({ current_step: 0, task_board: { active_index: 0, steps: [{}] } }) }
  assert.equal((await reconcileFactoryCellUse(w.agent, { operations: [{ name: 'inspect', args: {} }] })).applicable, false)
  assert.equal(await factoryPlacementAdmissionScope(w.agent, [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 0, y: 0 } }]), undefined)
  await assert.rejects(reconcileFactoryCellUse(w.agent, { step: { materialSupply: { mode: 'direct_feed', resource: 'iron-ore' } } }), { code: 'factory_cell_world_unbound' })
  for (const name of ['supply_entity', 'set_machine_recipe', 'move_items_exact']) await assert.rejects(reconcileFactoryCellUse(w.agent,
    { operations: [{ name, args: { unit_number: 77 } }] }), { code: 'factory_cell_canonical_backend_required' })
})

test('typed production enrolls a fresh receipt-backed empty furnace and permits only its live native startup recipe', async () => {
  const w = fixture({ intent: false }); await w.place('stone-furnace', 88)
  w.agent.stateFile = '/synthetic/strict-state'
  const before = clone(w.memory.planningState(KEY))
  const recipe = { name: 'synthetic-smelt', enabled: true, crafting_machines_truncated: false, crafting_machines: [{ name: 'stone-furnace' }],
    ingredients: [{ name: 'synthetic-ore', type: 'item' }], products: [{ name: 'synthetic-plate', type: 'item' }] }
  const original = w.agent.rcon.command
  w.agent.rcon.command = async command => command.includes('recipe_details') ? JSON.stringify({ found: true, truncated: false, recipes: [recipe] }) : original(command)
  w.game.onObserve = response => {
    response.members = [{ locator: response.members[0].locator, state: 'observed', type: 'furnace', recipe: { state: 'none', products: [], ingredients: [], truncated: false },
      inventories: [{ role: 'input', index: 2, state: 'known', items: {}, truncated: false }, { role: 'output', index: 3, state: 'known', items: [], truncated: false }],
      progress_facts: { crafting_progress: { state: 'known', value: 0 } },
      endpoint_facts: { schema_version: 1, inventories: { state: 'known', truncated: false, endpoints: [{ inventory_index: 3, state: 'known', roles: { state: 'known', values: ['output'] } }] } } }]
  }
  const producer = { unit_number: 88, recipe_name: recipe.name }
  const enrolled = await enrollFactoryProductionProducers(w.agent, [producer])
  assert.equal(enrolled.length, 1); assert.deepEqual(enrolled[0].assignment.products, ['synthetic-plate'])
  assert.equal(enrolled[0].assignment.method, 'native_recipe:synthetic-smelt')
  const resolved = await reconcileFactoryCellUse(w.agent, { productionIntent: { producers: [producer] }, operations: [{ name: 'supply_entity', args: { unit_number: 88, items: [{ item_name: 'synthetic-ore', count: 1 }] } }] })
  assert.equal(resolved.ok, true); assert.equal(resolved.commissioning, 'unverified')
  await assert.rejects(reconcileFactoryCellUse(w.agent, { operations: [{ name: 'supply_entity', args: { unit_number: 88, items: [{ item_name: 'wrong-ore', count: 1 }] } }] }), { code: 'factory_cell_input_unproven' })
  await assert.rejects(enrollFactoryProductionProducers(w.agent, [{ unit_number: 999, recipe_name: recipe.name }]), { code: 'factory_cell_producer_placement_unproven' })
  assert.deepEqual(w.memory.planningState(KEY), before)
  w.memory.restore(w.memory.snapshot())
  recipe.crafting_machines = [{ name: 'different-machine' }]
  await assert.rejects(reconcileFactoryCellUse(w.agent, { productionIntent: { producers: [producer] } }), { code: 'factory_cell_recipe_capability_unproven' })
})

test('world prerequisite refuses unbound/assessment/unknown native identity before accepting draft intent', async () => {
  const w = fixture({ bound: false })
  assert.throws(() => w.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } }), { code: 'factory_enrollment_world_unbound' })
  await assert.rejects(validateFactoryCellDraft(w.agent, w.draft), error => error.code === 'factory_enrollment_world_unbound')
  const v = fixture(); v.game.world = undefined
  await assert.rejects(validateFactoryCellDraft(v.agent, v.draft), error => error.code === 'factory_world_identity_missing')
  await assert.rejects(validateFactoryCellDraft(v.agent, { ...v.draft, assessmentOnly: true }), error => error.code === 'factory_cell_intent_invalid')
  v.game.world = WORLD; const before = clone(v.memory.planningState(KEY))
  await validateFactoryCellDraft(v.agent, v.draft)
  assert.deepEqual(v.memory.planningState(KEY), before)
})

test('production pair enrollment preserves committed intent and is durable/idempotent across restore', async () => {
  const w = await fixture().build(); const before = clone(w.memory.planningState(KEY))
  const result = await w.enroll()
  assert.equal(result.ok, true); assert.equal(result.duplicate, false)
  assert.deepEqual(w.memory.planningState(KEY), before)
  const cell = w.memory.getFactoryRegistry().cells[0]
  assert.deepEqual(cell.assignment.products, ['copper-plate']); assert.equal(cell.enrollment.receipt_ids.length, 2)
  assert.equal(cell.state, 'unverified')
  assert.equal((await w.enroll()).cell_id, cell.cell_id)
  const snapshot = w.memory.snapshot(); w.memory.restore(snapshot)
  assert.equal((await w.enroll()).duplicate, true)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0], cell)
  assert.ok(w.events.some(row => row.event === 'factory_cell.enrolled' && row.data.dependencies === 'unverified'))
})

test('actual shared step-close barrier enrolls durably before outcome authority; missing provenance cannot close', async () => {
  const w = await fixture().build(); const order = []
  w.game.onPersist = () => { if (w.memory.getFactoryRegistry().cells.length) order.push('persisted') }
  const original = w.memory.applyOutcomeAuthority.bind(w.memory)
  w.memory.applyOutcomeAuthority = (...args) => { order.push('outcome'); assert.ok(order.includes('persisted')); return original(...args) }
  const plan = getActivePlan(w.memory.planningState(KEY)); const board = w.memory.currentPlan(KEY).task_board
  const closed = await w.agent.applyStepClose('fixture', { key: KEY, step: board.steps[board.active_index], contract: CHECKPOINT, results: [], reasonCode: 'fixture_native_checkpoint', source: 'deterministic_runtime' })
  assert.equal(closed.closed, true)
  assert.equal(getActivePlan(w.memory.planningState(KEY)).execution.step_progress[plan.steps[0].step_id].status, 'completed')
  const v = fixture(); v.agent.pauseForStepContract = async () => ({ paused: true })
  const vb = v.memory.currentPlan(KEY).task_board
  const refused = await v.agent.applyStepClose('fixture', { key: KEY, step: vb.steps[vb.active_index], contract: CHECKPOINT, results: [], reasonCode: 'fixture_native_checkpoint' })
  assert.equal(refused.closed, false); assert.equal(refused.reason, 'factory_enrollment_placement_missing')
  assert.equal(v.memory.getFactoryRegistry().cells.length, 0)
})

test('canonical completion cannot bypass missing committed enrollment through another outcome route', () => {
  const w = fixture()
  const result = w.memory.applyOutcomeAuthority(KEY, { kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'fixture_checkpoint',
    evidence: [{ kind: 'verified_world_state', ref: 'fixture', summary: 'fixture native checkpoint' }], metadata: { scope: 'step' } })
  assert.equal(result.decision.accepted, false)
  assert.equal(result.decision.rejection_reason, 'factory_enrollment_required')
})

test('copper remains copper: wrong source/product/route and unknown native facts never publish', async () => {
  for (const mutate of [
    r => { r.members[0].source_resources.resources[0].name = 'iron-ore'; r.members[0].source_resources.resources[0].products[0].name = 'iron-ore' },
    r => { r.members[1].recipe.products[0].name = 'iron-plate' },
    r => { r.members[1].recipe.products[0].type = 'fluid' },
    r => { delete r.members[1].recipe.products[0].type },
    r => { r.members[0].item_routes.routes[0].target.unit_number++ },
    r => { r.members[0].source_resources.state = 'unknown' }, r => { r.members[1].state = 'hidden' },
  ]) {
    const w = await fixture().build(); const before = clone(w.memory.planningState(KEY))
    w.game.onObserve = mutate
    await assert.rejects(w.enroll(), /factory_enrollment_native_|factory_native_observation_members_mismatch/)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
    assert.deepEqual(w.memory.planningState(KEY), before)
  }
})

test('original scope and intent are required; generic old hardware, ambiguous receipts and another step cannot enroll', async () => {
  const absent = await fixture({ intent: false }).build()
  assert.equal((await absent.enroll()).applicable, false)
  assert.equal(absent.memory.getFactoryRegistry().cells.length, 0)
  for (const change of [
    s => { s.factory_placement_receipts[0].semantic_step_id = 'other-step' },
    s => { s.factory_placement_receipts[0].goal_id = 'other-goal' },
    s => { s.factory_placement_receipts.push({ ...s.factory_placement_receipts[0], unit_number: 999, receipt_id: `${WORLD}/batch-g1-999/999`, batch_id: 999, batch_ref: 'batch-g1-999', operation_id: 999 }) },
    s => { delete s.factory_placement_receipts },
  ]) {
    const w = await fixture().build(); const snapshot = w.memory.snapshot(); change(snapshot)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(snapshot); w.agent.memory = restored
    await assert.rejects(w.enroll(), /factory_enrollment_|factory_placement_/)
    assert.equal(restored.getFactoryRegistry().cells.length, 0)
  }
})

test('pre-send shape, duplicate, busy and stale ownership fences prevent another placement record', async () => {
  const w = fixture()
  await assert.rejects(w.agent.recordPendingOperationBeforeSend([{ name: 'place_entity', args: { entity_name: INTENT.sourceEntity } }, { name: 'wait', args: {} }], w.game.deployment), /factory_enrollment_single_placement_required/)
  await w.place(INTENT.sourceEntity)
  await assert.rejects(w.place(INTENT.sourceEntity), /factory_enrollment_duplicate_placement/)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  const busy = fixture(); busy.game.status.queue_length = 1
  await assert.rejects(busy.place(INTENT.sourceEntity), /factory_runtime_not_idle/)
  const stale = fixture(); stale.game.onCommand = text => { if (text.includes('autorio_actor')) stale.agent.traceRequest = { id: 'superseded' } }
  await assert.rejects(stale.place(INTENT.sourceEntity), /stale|superseded/)
  assert.equal(stale.memory.pendingOperations(KEY).length, 0)
})

test('cancellation, new native work and persistence failure cannot advance or publish a verified assignment', async () => {
  for (const mutate of [w => { w.agent.traceRequest = { id: 'superseded' } }, w => { w.game.status.queue_length = 1 }, w => { w.memory.restore(w.memory.snapshot()) }]) {
    const w = await fixture().build(); w.game.onObserve = () => mutate(w)
    await assert.rejects(w.enroll(), /stale|superseded|not_idle/)
    assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  }
  const w = await fixture().build(); w.game.onPersist = () => { throw new Error('fixture persistence failure') }
  await assert.rejects(w.enroll())
  assert.equal(w.memory.factoryRegistryStatus().status, 'fault')
  assert.equal(w.memory.snapshot().factory_registry.cells.length, 1, 'applied assignment is preserved behind the durable fault')
  assert.notEqual(getActivePlan(w.memory.planningState(KEY)).status, 'COMPLETED')
})

test('actual early-goal completion enrolls built pair, pauses partial pair and permits wholly unbuilt intent to become moot', async () => {
  for (const built of [0, 1, 2]) {
    const w = fixture()
    if (built >= 1) await w.place(INTENT.sourceEntity)
    if (built === 2) await w.place(INTENT.targetEntity)
    // Supply a deterministic goal-evaluation fixture at the existing evaluator
    // boundary; the actual finish/registry/outcome/satisfaction methods run.
    w.memory.goalDefinition = () => ({ scope: 'finite' })
    const evaluation = { satisfied: true, results: [{ id: 'held', satisfied: true, current: 1 }], _sglunaGoalFence: { key: KEY } }
    w.agent.evaluateGoalCompletion = async () => evaluation
    w.agent.assertGoalEvaluationCurrent = async () => {}
    w.agent.pauseForStepContract = async ({ reason }) => ({ paused: true, reason })
    const result = await w.agent.finishIfGoalMet({ chatMessage: 'Goal native condition met' }, w.memory.currentPlan(KEY))
    if (built === 1) {
      assert.equal(result.paused, true); assert.equal(result.reason, 'factory_enrollment_placement_missing')
      assert.equal(w.memory.planningState(KEY).goal.status, 'active')
      assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
      assert.ok(w.events.some(row => row.event === 'factory_cell.goal_completion_refused' && row.data.original_goal_satisfied === true))
    }
    else {
      assert.equal(result.goalStatus, 'completed')
      assert.equal(w.memory.getFactoryRegistry().cells.length, built === 2 ? 1 : 0)
      assert.equal(w.memory.planningState(KEY).goal.status, 'completed')
    }
  }
})

test('canonical goal-completion and runtime satisfaction backstops cannot abandon a partially built intent', async () => {
  const w = fixture(); await w.place(INTENT.sourceEntity)
  const before = clone(w.memory.planningState(KEY))
  const result = w.memory.applyOutcomeAuthority(KEY, { kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'goal_definition_satisfied',
    evidence: [{ kind: 'verified_world_state', ref: 'fixture-goal-proof', summary: 'native goal fixture satisfied' }] })
  assert.equal(result.decision.accepted, false)
  assert.equal(result.decision.rejection_reason, 'factory_enrollment_required')
  w.memory.recordGoalSatisfaction(KEY, { source: 'runtime', evidenceRefs: ['fixture-goal-proof'] })
  assert.deepEqual(w.memory.planningState(KEY), before)
})

test('restored enrolled pair must revalidate native facts before actual early-goal completion', async () => {
  for (const mutate of [r => { r.members[1].recipe.state = 'unknown' }, r => { r.members[1].recipe.products[0].name = 'iron-plate' }]) {
    const w = await fixture().build(); await w.enroll()
    const assignment = clone(w.memory.getFactoryRegistry().cells[0])
    w.memory.restore(w.memory.snapshot())
    const reads = w.game.observeCount
    w.game.onObserve = mutate
    w.memory.goalDefinition = () => ({ scope: 'finite' })
    w.agent.evaluateGoalCompletion = async () => ({ satisfied: true, results: [{ id: 'held', satisfied: true, current: 1 }], _sglunaGoalFence: { key: KEY } })
    w.agent.assertGoalEvaluationCurrent = async () => {}
    w.agent.pauseForStepContract = async ({ reason }) => ({ paused: true, reason })
    const result = await w.agent.finishIfGoalMet({ chatMessage: 'Original goal condition is met' }, w.memory.currentPlan(KEY))
    assert.equal(result.paused, true)
    assert.match(result.reason, /^factory_enrollment_native_(unverified|mismatch)$/)
    assert.ok(w.game.observeCount > reads)
    assert.equal(w.memory.planningState(KEY).goal.status, 'active')
    assert.deepEqual(w.memory.getFactoryRegistry().cells, [assignment])
    assert.ok(w.events.some(row => row.event === 'factory_cell.goal_completion_refused' && row.data.original_goal_satisfied === true))
  }
})

test('actual request failure and supervisor pause preserve factory precommit/presend guard classification', async () => {
  for (const phase of ['draft', 'pre_send']) {
    const w = fixture({ bound: phase !== 'draft' })
    const before = clone(getActivePlan(w.memory.planningState(KEY)).steps)
    if (phase === 'draft') {
      // Earlier role/checkpoint validators have independent suites; this
      // isolates the real commitPlan factory prerequisite and failure unwind.
      w.agent.enforceExecutorContract = async value => value
      w.agent.validatePreflightCorrectionScope = async () => {}
      w.agent.validateStepCompletionDeclarations = async () => {}
      w.agent.runTurnRedriving = () => w.agent.commitPlan(clone(w.draft))
    }
    else w.agent.runTurnRedriving = () => w.agent.recordPendingOperationBeforeSend([
      { name: 'place_entity', args: { entity_name: INTENT.sourceEntity } }, { name: 'wait', args: {} },
    ], w.game.deployment)
    let failure
    await assert.rejects(w.agent.runGuardedTurn(), error => { failure = error; return true })
    const expected = phase === 'draft' ? 'factory_enrollment_world_unbound' : 'factory_enrollment_single_placement_required'
    assert.equal(failure.failure_code, expected)
    assert.equal(classifyRequestFailure(failure).pause_class, 'guard')
    assert.equal(classifyRequestFailure(failure).code, expected)
    assert.equal(failure.detail.current_batch_sent, false)
    assert.equal(failure.detail.prior_world_effects, 'not_reclassified')
    assert.equal(w.memory.pendingOperations(KEY).length, 0)
    assert.deepEqual(getActivePlan(w.memory.planningState(KEY)).steps, before)
    const failed = w.events.findLast(row => row.event === 'request.failed')
    assert.equal(failed.data.failure_code, expected)
    assert.equal(failed.data.pause_class, 'guard')
    const paused = await pauseStrandedPlanAfterRequestError({ agent: w.agent, currentPlanState: () => w.memory.currentPlan(KEY) }, failure)
    assert.equal(paused.status, 'paused')
    assert.ok(paused.pause_reason.startsWith(`${expected}:`))
    assert.equal(isProviderFailurePause(w.memory.pauseRecord(KEY), paused.pause_reason), false)
    assert.equal(w.events.findLast(row => row.event === 'goal.paused').data.provider_failure, false)
  }
})

for (const startup of [false, true]) test('plain construction pair closes with exact new custody before fuel, unselected=' + startup, async () => {
  const w = await implicitFixture({ startup, construction: true })
  const before = clone(getActivePlan(w.memory.planningState(KEY)).steps)
  const result = await w.enroll()
  assert.equal(result.kind, 'constructed'); assert.equal(result.delivery_ready, false); assert.equal(result.commissioning, 'unverified')
  assert.equal(factoryUseDecision(w.memory, KEY, getActivePlan(w.memory.planningState(KEY)).steps[0], { close: true }).ok, true)
  assert.equal(factoryUseDecision(w.memory, KEY, getActivePlan(w.memory.planningState(KEY)).steps[0]).ok, false, 'construction proof is not ordinary use authority')
  assert.deepEqual(getActivePlan(w.memory.planningState(KEY)).steps, before)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
  assert.equal(w.memory.getFactoryRegistry().cells[0].members.length, 2)
})

test('an active production task cannot borrow construction-only delivery exemption', async () => {
  const w = await implicitFixture({ startup: true, construction: true })
  const plan = getActivePlan(w.memory.planningState(KEY))
  w.memory.productionTasks ??= new Map()
  w.memory.productionTasks.set('synthetic-active-task', { owner: { goal_id: plan.goal_id, step_id: plan.steps[0].step_id }, status: 'active' })
  await assert.rejects(w.enroll(), { code: 'factory_cell_delivery_unverified' })
})

for (const timing of ['during_trace', 'after_certificate']) test(`construction close loses authority when production activates ${timing}`, async () => {
  const w = await implicitFixture({ startup: true, construction: true })
  const plan = getActivePlan(w.memory.planningState(KEY))
  const before = clone(plan.steps)
  const activate = () => {
    w.memory.productionTasks ??= new Map()
    w.memory.productionTasks.set('synthetic-active-task', { owner: { goal_id: plan.goal_id, step_id: plan.steps[0].step_id }, status: 'active' })
  }
  if (timing === 'during_trace') {
    const trace = w.agent.traceEvent.bind(w.agent)
    w.agent.traceEvent = async (event, data) => {
      await trace(event, data)
      if (event === 'factory_cell.use_resolved' && data.resolution.kind === 'constructed') activate()
    }
    await assert.rejects(w.enroll(), { code: 'factory_cell_delivery_unverified' })
  }
  else {
    assert.equal((await w.enroll()).kind, 'constructed')
    assert.equal(factoryUseDecision(w.memory, KEY, plan.steps[0], { close: true }).ok, true)
    activate()
  }
  assert.equal(factoryUseDecision(w.memory, KEY, plan.steps[0], { close: true }).ok, false)
  assert.equal(factoryUseDecision(w.memory, KEY, plan.steps[0]).ok, false)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.deepEqual(getActivePlan(w.memory.planningState(KEY)).steps, before)
})

test('a direct-feed step without an explicit intent refuses any batch that is not one placement alone, before admission', () => {
  const agentFor = step => ({ activePlanKey: () => KEY, memory: { planningState: () => undefined, currentPlan: () => ({ task_board: { active_index: 0, steps: [step] } }) } })
  const directFeed = agentFor({ id: 'step_1', execution_guidance: { materialSupply: { mode: 'direct_feed', resource: 'copper-ore' } } })
  const place = id => ({ name: 'place_candidate', args: { candidate_set_id: id, candidate_id: 'candidate-1' } })
  const fuel = { name: 'supply_entity', args: { unit_number: 7, items: [{ item_name: 'coal', count: 1 }] } }
  for (const [operations, index, placements] of [[[place('a'), place('b')], 1, 2], [[place('a'), fuel], 1, 1], [[fuel, place('a')], 1, 1], [[fuel, place('a'), place('b')], 2, 2]]) {
    const refused = directFeedSingletonPlacementRefusal(directFeed, operations)
    assert.deepEqual([refused.ok, refused.code, refused.refusal_class, refused.stage, refused.operation_index, refused.placements, refused.operations],
      [false, 'factory_direct_feed_single_placement_required', 'argument', 'preflight', index, placements, operations.length])
    assert.match(refused.correction_message, /no operation from this batch ran[\s\S]*one placement per batch/)
  }
  assert.equal(directFeedSingletonPlacementRefusal(directFeed, [place('a')]), undefined, 'one placement alone keeps exact custody')
  assert.equal(directFeedSingletonPlacementRefusal(directFeed, [fuel, fuel]), undefined, 'a batch without a placement is not affected')
  assert.equal(directFeedSingletonPlacementRefusal(agentFor({ id: 'step_1' }), [place('a'), place('b')]), undefined, 'only a direct-feed step')
  assert.equal(directFeedSingletonPlacementRefusal(agentFor({ id: 'step_1', completion_mode: 'deterministic', execution_guidance: { cellIntent: INTENT, materialSupply: { mode: 'direct_feed', resource: 'copper-ore' } } }),
    [place('a'), place('b')]), undefined, 'a committed intent keeps its own pre-send refusal')
})