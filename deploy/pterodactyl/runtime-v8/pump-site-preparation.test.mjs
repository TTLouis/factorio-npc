import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { batchStockDecision, evaluateBatchStock, STOCK_STATUS } from './batch-stock.mjs'
import { buildPendingOperation, duplicateEffectGuard, EFFECT, effectClassOf, isLostAcknowledgement, reconcilePendingOperation, RECONCILE_VERDICT } from './operation-reconciliation.mjs'
import { authoredCompletionContractSupported, evaluateCompletionContract, strictTaskTypesForOperation } from './step-completion.mjs'
import { observationToolFamily, observationToolTier, parseOperation, renderOperation, renderOperationPreflight, toolCommand, toolDefinitions } from './structured-policy.mjs'
import { FurnaceFactorio, recoverySession, ScriptedModel, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld } from './invalid-reference-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'
import { search, shorelineDecisionScript } from './shoreline-recovery-fixtures.mjs'

const PREPARE = { name: 'prepare_pump_site', args: { preparation_id: 'pump-preparation-1' } }
const ACTOR = { actor_id: 18, epoch: 3 }

test('pump preparation action accepts only a native registry reference and renders exact bounded calls', () => {
  assert.deepEqual(parseOperation(PREPARE), PREPARE)
  assert.equal(renderOperation(PREPARE), "remote.call('autorio_operations','prepare_pump_site','pump-preparation-1')")
  assert.equal(renderOperationPreflight(PREPARE), "/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','prepare_pump_site',{preparation_id='pump-preparation-1'})))")
  for (const preparation_id of ['', 'pump-preparation-0', 'pump-preparation--1', 'pump-preparation-1.5', 'placement-1', 'candidate-1', "pump-preparation-1');game.clear()", 1, null]) {
    assert.throws(() => parseOperation({ name: PREPARE.name, args: { preparation_id } }))
  }
  for (const args of [{}, null, [], { preparation_id: 'pump-preparation-1', x: 0 }, { preparation_id: 'pump-preparation-1', backend: 'robot' }, { preparation_id: 'pump-preparation-1', force: true }]) {
    assert.throws(() => parseOperation({ name: PREPARE.name, args }))
  }
  assert.throws(() => parseOperation({ ...PREPARE, code: 'anything' }))
})

test('pump preparation read schema and command agree on exact pump centers and native cardinal directions', () => {
  const tool = toolDefinitions.find(row => row.function.name === 'getPumpSitePreparation').function
  assert.deepEqual(tool.parameters.required, ['x', 'y'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.direction.enum, [0, 4, 8, 12])
  assert.equal(observationToolFamily('getPumpSitePreparation'), 'placement_candidates')
  assert.equal(observationToolTier('getPumpSitePreparation'), 'fact')
  assert.equal(toolCommand('getPumpSitePreparation', { x: 1.5, y: -2.5 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_pump_site_preparation",{x=1.5,y=-2.5,direction=0})))')
  for (const direction of [0, 4, 8, 12]) assert.match(toolCommand('getPumpSitePreparation', { x: 0, y: 0, direction }), new RegExp(`direction=${direction}\\}`))
  for (const args of [{}, { x: 0 }, { x: '1', y: 2 }, { x: Infinity, y: 0 }, { x: 1000001, y: 0 }, { x: 0, y: Number.NaN }, { x: 0, y: 0, direction: 2 }, { x: 0, y: 0, direction: 16 }, { x: 0, y: 0, force: true }, { x: 0, y: 0, backend: 'robot' }]) {
    assert.throws(() => toolCommand('getPumpSitePreparation', args))
  }
})

test('lost preparation acknowledgement and partial cancellation retain a world-effect fence against replay', () => {
  assert.equal(effectClassOf(PREPARE.name), 'world')
  assert.equal(isLostAcknowledgement(new Error('RCON connection closed')), true)
  const pending = buildPendingOperation({ requestId: 'req-pump-prep', operationKey: 'req-pump-prep/batch_1', ordinal: 1, protocolVersion: 2,
    operations: [PREPARE], actor: ACTOR, goalId: 'g', planId: 'p', stepId: 's' })
  const admission = { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
    ...ACTOR, ordinal: 1, operation_count: 1, generation: 1, state: 'uncertain', slots: [{ index: 1, ok: true, operation: PREPARE.name,
      batch_refs: [{ batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4' }] }] }
  const status = { batch_generation: 1, task_state: 'idle', queue_length: 0, admission_journal: [admission],
    receipt_journal: [{ batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4', state: 'cancelled', started_count: 1,
      task_count: 1, task_types: ['preparing_pump_site'], tick: 100, reason: 'preparing_pump_site:tile_changed' }] }
  const outcome = reconcilePendingOperation(pending, { actor: ACTOR, status })
  assert.notEqual(outcome.effect, EFFECT.NOT_HAPPENED)
  assert.notEqual(outcome.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(duplicateEffectGuard({ ...pending, effect: outcome.effect }, { operations: [PREPARE], planId: 'p', stepId: 's' }).refuse, true)
  const absent = reconcilePendingOperation(pending, { actor: ACTOR, status: { batch_generation: 1, admission_journal: [] } })
  assert.equal(absent.effect, EFFECT.UNKNOWN, 'a drained queue without the exact admission is no proof that landfill was untouched')
  const stale = reconcilePendingOperation(pending, { actor: { actor_id: 19, epoch: 4 }, status })
  assert.notEqual(stale.effect, EFFECT.NOT_HAPPENED)
})

test('reclaimed landfill is not credited to a dependent stock claim until inventory is observed', () => {
  const supply = { name: 'move_items_exact', args: { item_name: 'landfill', unit_number: 44, max_count: 1, to_entity: true } }
  const report = evaluateBatchStock({ operations: [PREPARE, supply], inventory: new Map(), preflight: [{ ok: true, recovered_items: [{ name: 'landfill', count: 8 }] },
    { ok: false, code: 'insufficient_items', target: { unit_number: 44 } }] })
  assert.equal(report.verdicts[0].status, STOCK_STATUS.UNACCOUNTED)
  assert.equal(report.verdicts[0].unaccounted.reason, 'terrain_recovery_requires_native_receipt_and_inventory_read')
  assert.notEqual(report.verdicts[1].status, STOCK_STATUS.COVERED_BY_EARLIER_OP)
  assert.equal(report.deferred_by_earlier_op.length, 0)
  assert.notEqual(batchStockDecision(report, new Set([1])).action, 'proceed', 'a rejected stock claim cannot be repaired by assuming a preparation yield')
  const observed = evaluateBatchStock({ operations: [supply], inventory: new Map([['landfill', 1]]), preflight: [{ ok: true, target: { unit_number: 44 } }] })
  assert.equal(observed.verdicts[0].status, STOCK_STATUS.COVERED)
})

test('only the strict preparation task can prove its receipt; preparation never proves a placed or working pump', () => {
  assert.deepEqual(strictTaskTypesForOperation(PREPARE), ['preparing_pump_site'])
  assert.notDeepEqual(strictTaskTypesForOperation(PREPARE), strictTaskTypesForOperation({ name: 'place_candidate', args: {} }))
  const fact = { kind: 'authoritative_operation_receipt', authoritative: true, operation_names: ['prepare_pump_site'] }
  const own = { mode: 'all', requirements: [{ id: 'prepared', kind: 'authoritative_operation_receipt', operation_name: 'prepare_pump_site' }] }
  assert.equal(authoredCompletionContractSupported(own), true)
  assert.equal(evaluateCompletionContract(own, { prepared: fact }).satisfied, true)
  const placed = { mode: 'all', requirements: [{ id: 'placed', kind: 'authoritative_operation_receipt', operation_name: 'place_candidate' }] }
  assert.equal(evaluateCompletionContract(placed, { placed: fact }).satisfied, false)
  const pumping = { mode: 'all', requirements: [{ id: 'pump', kind: 'entity_count', prototype: 'offshore-pump', minimum: 1, state: 'working' }] }
  assert.equal(evaluateCompletionContract(pumping, { pump: fact }).satisfied, false)
})

test('native preparation observation emits request-correlated bounded facts and no mutation or completion claim', async () => {
  const events = []
  const boundary = { traceRequest: { id: 'req-prep-fact' }, traceEvent: async (event, row) => { events.push({ event, ...row }) } }
  const read = raw => NpcAgentLoop.prototype.traceNativeObservationFact.call(boundary, 'getPumpSitePreparation', { x: 1.5, y: -2.5 }, raw)
  await read(JSON.stringify({ ok: true, preparation_id: 'pump-preparation-1', removal_tiles: [{ x: 1, y: -3 }], execution_strategy: 'actor', unrelated: 'do not leak' }))
  assert.deepEqual(events[0], { event: 'observation.pump_site_preparation_observed', request_id: 'req-prep-fact', reason: 'bounded_native_pump_site_preparation_read',
    readable: true, ok: true, code: undefined, preparation_id: 'pump-preparation-1', tile_count: 1, backend: 'actor' })
  await read('not json')
  assert.equal(events[1].readable, false)
  await read(JSON.stringify({ ok: false, code: 'water_search_required' }))
  assert.equal(events[2].ok, false)
  assert.equal(events[2].code, 'water_search_required')
  assert.ok(events.every(row => row.request_id === 'req-prep-fact' && !Object.hasOwn(row, 'completed')))
})

// The real serialized loop with a deliberately small physical model: changing
// terrain and consuming the pump happen only when the admitted task completes.
// The separate native lane proves those effects inside Factorio itself.
class CoveredWaterGame extends FurnaceFactorio {
  constructor() {
    super({ inventory: { 'offshore-pump': 1 } })
    this.uncovered = false; this.pump = false; this.readOrder = []; this.freshWater = false
  }

  async command(text) {
    if (text.includes('"get_fluid_source_tiles"')) {
      this.readOrder.push(this.uncovered ? 'fresh-water' : 'covered-water')
      this.freshWater = this.uncovered
      return JSON.stringify({ ok: true, fluid_name: 'water', surface_index: 1, actor_position: { x: 0, y: 0 }, observed_tick: 1000 + this.batchId,
        search_radius: 32, coverage: 'generated_bounding_square', coverage_complete: true, checked_chunks: 9, generated_chunk_count: 9, ungenerated_chunk_count: 0,
        empty_result_is_conclusive: true, samples: this.uncovered ? [{ name: 'water', position: { x: 2, y: -2 }, surface_index: 1 }] : [],
        covered_fluid_hints: this.uncovered ? [] : [{ position: { x: 2, y: -2 }, current_tile: 'landfill', hidden_tile: 'water', native_removable: true }], returned_count: this.uncovered ? 1 : 0 })
    }
    if (text.includes('"get_pump_site_preparation"')) {
      assert.equal(this.readOrder.at(-1), 'covered-water')
      assert.equal(this.uncovered, false)
      this.readOrder.push('prepare-read')
      return JSON.stringify({ ok: true, preparation_id: 'pump-preparation-1', removal_tiles: [{ x: 2, y: -2, tile_name: 'landfill' }], execution_strategy: 'actor' })
    }
    if (text.includes('"get_placement_candidates"')) {
      assert.equal(this.uncovered, true, 'candidate lookup must follow real removal completion')
      assert.equal(this.freshWater, true, 'old covered-water observation cannot support placement')
      this.readOrder.push('fresh-candidates')
      return JSON.stringify({ ok: true, entity_name: 'offshore-pump', candidate_set_id: 'placement-2', legal_candidate_count: 1, returned_candidate_count: 1,
        candidates: [{ candidate_id: 'candidate-1', entity_name: 'offshore-pump', x: 2.5, y: -1, direction: 0 }] })
    }
    if (text.includes("'autorio_preflight','operation','prepare_pump_site'")) return JSON.stringify({ ok: true })
    if (text.includes("'autorio_preflight','operation','place_candidate'")) return JSON.stringify({ ok: true, placement_item: { entity_name: 'offshore-pump', item_name: 'offshore-pump', count: 1, held_count: this.inventory['offshore-pump'] ?? 0 } })
    if (text.includes('"evaluate_condition"') && /entity_count|entity_working/.test(text)) return JSON.stringify({ ok: true, kind: text.includes('entity_count') ? 'entity_count' : 'entity_working',
      prototype: 'offshore-pump', entity_name: 'offshore-pump', state: 'working', current: this.pump ? 1 : 0, satisfied: this.pump, tick: ++this.gameTick })
    const answer = await super.command(text)
    if (this.pendingBatch) {
      this.lastTaskTypes = this.pendingBatch.operations.map(op => op.name === 'prepare_pump_site' ? 'preparing_pump_site' : 'placing')
      this.taskState = this.lastTaskTypes[0]
    }
    return answer
  }

  completeBatch() {
    const operation = this.pendingBatch?.operations[0]
    assert.ok(operation)
    if (operation.name === 'prepare_pump_site') {
      assert.equal(this.uncovered, false)
      this.uncovered = true; this.inventory.landfill = 1; this.readOrder.push('prepared')
    }
    else {
      assert.equal(operation.name, 'place_candidate')
      assert.equal(this.readOrder.at(-1), 'fresh-candidates')
      assert.equal(this.inventory['offshore-pump'], 1)
      delete this.inventory['offshore-pump']; this.pump = true
    }
    const receipt = super.completeBatch()
    this.lastBasicResult.type = this.lastTaskTypes[0]
    return receipt
  }
}

test('serialized loop uncovers only after receipt, rereads water, obtains a fresh candidate and separately verifies the pump', async t => {
  const game = new CoveredWaterGame(); const model = new ScriptedModel()
  const checkpoint = { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'offshore-pump', minimum: 1, state: 'working' }] }
  const reply = (operations, extra = {}) => planReply({ plan: ['Uncover water and place a working offshore pump'], currentStep: 0, operations, ...extra })
  const water = () => search('getFluidSourceTiles', { fluid_name: 'water', search_radius: 32, limit: 4 })
  model.push('planner', 'commit-pump-contract', reply([], { checkpoint, stepCompletions: [{ kind: 'deterministic', checkpoint }],
    goal: { scope: 'finite', summary: 'Working offshore pump', doneWhen: [{ kind: 'entity_working', entity_name: 'offshore-pump', minimum: 1 }] } }))
    .push('executor', 'find-covered-water', water())
    .push('executor', 'derive-bounded-removal', search('getPumpSitePreparation', { x: 2.5, y: -1, direction: 0 }))
    .push('executor', 'prepare-site', reply([PREPARE]))
  const world = delegatedRecoveryWorld({ game, model, decisionScript: shorelineDecisionScript })
  const ctx = { game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  ctx.session.queuePlayerRequest('TTLouis', 'Uncover covered water and place a working offshore pump')
  await settle(ctx.session)
  assert.equal(game.pendingBatch?.operations[0].name, 'prepare_pump_site', JSON.stringify({ logs: world.agentLogs, remaining: model.remaining, trace: world.trace.slice(-8) }))
  assert.equal(game.uncovered, false, 'read, preflight and admission do not uncover water')
  assert.equal(game.inventory.landfill, undefined)
  const steps = structuredClone(world.memory.planningState(KEY).plans.at(-1).steps)
  model.push('executor', 'refresh-water-after-removal', () => {
    assert.equal(game.pump, false)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'preparation receipt is not the pump checkpoint')
    return water()
  }).push('executor', 'find-current-legal-pump-site', search('getPlacementCandidates', { entity_name: 'offshore-pump', radius: 8, limit: 1 }))
    .push('executor', 'place-only-current-candidate', reply([{ name: 'place_candidate', args: { candidate_set_id: 'placement-2', candidate_id: 'candidate-1' } }]))
  await completeAndReport(ctx)
  assert.equal(game.pump, false)
  assert.equal(game.inventory.landfill, 1)
  assert.equal(game.pendingBatch?.operations[0].name, 'place_candidate', JSON.stringify({ logs: world.agentLogs, remaining: model.remaining, trace: world.trace.slice(-8) }))
  assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, steps)
  await completeAndReport(ctx)
  assert.equal(game.pump, true)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  assert.deepEqual(game.readOrder.filter(row => row !== 'fresh-candidates'), ['covered-water', 'prepare-read', 'prepared', 'fresh-water'])
  assert.equal(game.sent.length, 2, 'one bounded removal and one candidate placement; no automatic retries')
  assert.equal(world.named('observation.pump_site_preparation_observed').length, 1)
  assert.ok(world.named('observation.pump_site_preparation_observed')[0].request_id)
  assert.deepEqual(world.named('request.failed'), [])
  assert.deepEqual(world.named('recovery.auto_resume_started'), [])
  assert.deepEqual(model.remaining, [])
})
