import assert from 'node:assert/strict'
import { FurnaceFactorio, recoverySession, ScriptedModel, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld } from './invalid-reference-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'
import fs from 'node:fs'
export const RUN_M_SEARCHES = JSON.parse(fs.readFileSync(new URL('./fixtures/run-m-local-search.json', import.meta.url), 'utf8'))
export function shorelineDecisionScript(_state, questions) {
  const overrides = {}
  if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
  for (const family of ['runtime_status', 'nearby_world', 'placement_candidates', 'entity_status']) {
    if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
  }
  return { overrides }
}

export const POWER_CHECKPOINT = { mode: 'all', requirements: [
  { kind: 'entity_count', prototype: 'lab', minimum: 1, state: 'powered' },
  { kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 },
] }
export const search = (name, args = {}) => ({ content: null, tool_calls: [{ id: `read-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
export const waterRead = radius => search('getFluidSourceTiles', { fluid_name: 'water', search_radius: radius, limit: 4 })
export const pumpRead = () => search('getPlacementCandidates', { entity_name: 'offshore-pump', radius: 24, limit: 1 })
export const block = () => decision([], { chatMessage: 'BLOCKED: No offshore-pump site within 24 tiles and no water was returned. I cannot build the connected power chain.' })
export const decision = (operations, rest = {}) => planReply({ plan: ['Build and power the lab, then craft one red pack'], currentStep: 0, operations, ...rest })
export const walk = { name: 'walk_to_position', args: { ...RUN_M_SEARCHES[2].result.ungenerated_chunks[0].center } }
export const placements = ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole', 'lab'].map((entity_name, i) => ({ name: 'place_entity', args: { entity_name, x: walk.args.x + i * 3, y: walk.args.y - 28 } }))

// A bounded fake physical model: no world state changes until an admitted batch
// completes. The native lane proves the same exploration/power path in Factorio.
export class ShorelineGame extends FurnaceFactorio {
  constructor() {
    super({ inventory: { 'offshore-pump': 1, boiler: 1, 'steam-engine': 1, 'small-electric-pole': 1, lab: 1, coal: 5, 'iron-plate': 2, 'copper-plate': 1 } })
    this.position = { ...RUN_M_SEARCHES[2].result.actor_position }; this.explored = false; this.placed = new Set(); this.powered = false
    this.preflight = () => ({ ok: true })
  }
  fluid(radius) {
    if (!this.explored) return structuredClone(RUN_M_SEARCHES[radius === 256 ? 2 : 0].result)
    const partial = radius === 256 && !this.explored
    const samples = this.explored ? [{ name: 'water', fluid_name: 'water', surface_index: 1, position: { x: walk.args.x, y: walk.args.y - 32 }, distance: 32 }] : []
    return { ok: true, fluid_name: 'water', actor_position: this.position, surface_index: 1, observed_tick: 610 + this.batchId,
      search_radius: radius, coverage: 'generated_bounding_square', coverage_complete: !partial,
      checked_chunks: partial ? 289 : 81, generated_chunk_count: partial ? 182 : 81, ungenerated_chunk_count: partial ? 107 : 0,
      ungenerated_chunks: partial ? [{ x: 4, y: 0, center: { x: 144, y: 16 } }] : {},
      ungenerated_chunks_truncated: partial, empty_result_is_conclusive: !partial, samples,
      returned_count: samples.length, truncated: partial, scanned_tile_limit: 256, scan_truncated: partial,
      matching_tile_prototypes: 16, ordering: partial ? 'nearest_first_among_scanned_tiles' : 'nearest_first' }
  }
  async command(text) {
    if (text.includes('"get_fluid_source_tiles"')) return JSON.stringify(this.fluid(Number(/search_radius=(\d+)/.exec(text)?.[1] ?? 128)))
    if (text.includes('"get_placement_candidates"') && !this.explored) return JSON.stringify(RUN_M_SEARCHES[1].result)
    if (text.includes('"get_placement_candidates"')) return JSON.stringify({ ok: true, entity_name: 'offshore-pump', center: this.position,
      radius: 24, legal_candidate_count: this.explored ? 1 : 0, returned_candidate_count: this.explored ? 1 : 0,
      candidates: [{ ...placements[0].args, direction: 0, candidate_id: 'pump-current' }] })
    if (text.includes('"evaluate_condition"') && text.includes('entity_count')) return JSON.stringify({ ok: true, kind: 'entity_count', prototype: 'lab', state: 'powered', satisfied: this.powered, current: this.powered ? 1 : 0, progressing: false, progress_known: true })
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { actor_id: this.status.actor_id, position: this.position, surface_index: 1, valid: true } })
    if (text.includes('"autorio_prototypes","details"')) return JSON.stringify({ found: false, query: 'lab' })
    if (text.includes('"get_nearby_entities"')) return JSON.stringify({ actor_position: this.position, entities: this.placed.has('boiler') ? [{ unit_number: this.furnace.unit_number, name: 'boiler', position: placements[1].args, surface_index: 1 }] : [] })
    const answer = await super.command(text)
    if (this.pendingBatch) {
      this.lastTaskTypes = this.pendingBatch.operations.map(op => ({ walk_to_position: 'walking', place_entity: 'placing', supply_entity: 'moving_items', craft_item: 'crafting' })[op.name])
      this.taskState = this.lastTaskTypes[0]
    }
    return answer
  }
  completeBatch() {
    const operations = structuredClone(this.pendingBatch?.operations)
    const batch = super.completeBatch()
    for (const op of operations) {
      if (op.name === 'walk_to_position') {
        const values = op.args.raw.match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/)
        assert.ok(values); this.position = { x: Number(values[1]), y: Number(values[2]) }; this.explored = true
      }
      if (op.name === 'place_entity') {
        const name = /^'([^']+)'/.exec(op.args.raw)?.[1]
        assert.equal(this.explored, true); assert.equal(this.inventory[name], 1); assert.ok(!this.placed.has(name))
        delete this.inventory[name]; this.placed.add(name)
      }
      if (op.name === 'supply_entity') this.powered = this.placed.size === 5 && this.inventory.coal < 5
      if (op.name === 'craft_item') {
        assert.equal(this.powered, true); assert.equal(this.inventory['iron-plate'], 2); assert.equal(this.inventory['copper-plate'], 1)
        delete this.inventory['iron-plate']; delete this.inventory['copper-plate']; this.inventory['automation-science-pack'] = 1
      }
    }
    this.lastBasicResult.type = this.lastTaskTypes[0]
    return batch
  }
}

export async function beginShoreline(t, { corrections, ready, beforeBlock, stateFile = null, game = new ShorelineGame() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let ctx
  const model = new ScriptedModel().push('planner', 'sol-power-contract', decision([], { checkpoint: POWER_CHECKPOINT,
    stepCompletions: [{ kind: 'deterministic', checkpoint: POWER_CHECKPOINT }],
    goal: { scope: 'finite', summary: 'Build powered lab and hold one red pack', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 }] },
  })).push('executor', 'local-water-absence', waterRead(128)).push('executor', 'local-pump-absence', pumpRead())
    .push('executor', 'fresh-actor', search('getActorStatus')).push('executor', 'inconclusive-expanded-water', waterRead(256))
    .push('executor', 'unsupported-world-blocker', async () => { await beforeBlock?.(ctx); return block() })
  for (const [name, reply] of corrections ?? [['explore', decision([walk])]]) model.push('executor', name, reply)
  const world = delegatedRecoveryWorld({ game, model, stateFile, decisionScript: shorelineDecisionScript })
  ctx = { t, game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  ready?.(ctx)
  ctx.session.queuePlayerRequest('TTLouis', 'Build the powered lab and craft one red pack')
  await settle(ctx.session)
  return ctx
}

export function queueShorelineDiscovery(model) {
  model.push('executor', 'discover-water-after-walk', waterRead(128)).push('executor', 'fresh-pump-candidate', pumpRead())
    .push('executor', 'place-connected-chain', messages => {
      const candidate = JSON.parse([...messages].reverse().find(m => m.role === 'tool').content).candidates[0]
      assert.equal(candidate.x, placements[0].args.x); assert.equal(candidate.y, placements[0].args.y)
      return decision(placements)
    })
}
export async function finishShoreline(ctx, { afterWalk = false, expectedSteps = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps) } = {}) {
  if (!afterWalk) {
    queueShorelineDiscovery(ctx.model)
    await completeAndReport(ctx)
    assert.equal(ctx.world.memory.currentPlan(KEY).task_board.completed_count, 0, 'walking is not the power result')
  }
  ctx.model.push('executor', 'discover-placed-boiler', search('getNearbyEntities', { name: 'boiler', radius: 24 }))
    .push('executor', 'fuel-boiler', messages => {
      const boiler = JSON.parse([...messages].reverse().find(m => m.role === 'tool').content).entities.find(e => e.name === 'boiler')
      assert.ok(boiler?.unit_number > 0)
      return decision([{ name: 'supply_entity', args: { unit_number: boiler.unit_number, items: [{ item_name: 'coal', count: 1 }] } }])
    })
  assert.ok(ctx.game.pendingBatch, JSON.stringify({ labels: ctx.model.labels, violations: ctx.model.violations, remaining: ctx.model.remaining, logs: ctx.logs, agentLogs: ctx.world.agentLogs, trace: ctx.world.trace.slice(-15) }))
  await completeAndReport(ctx)
  assert.equal(ctx.world.memory.currentPlan(KEY).task_board.completed_count, 0, 'placement is not powered science')
  ctx.model.push('executor', 'craft-one-red-pack', decision([{ name: 'craft_item', args: { item_name: 'automation-science-pack', count: 1 } }]))
  await completeAndReport(ctx)
  assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, expectedSteps, 'exploration, placement and power preserve the original result contract through final admission')
  await completeAndReport(ctx)
}
