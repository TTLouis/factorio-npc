// World for the composed delegation scenario (composed-delegation.test.mjs).
//
// A live-sized copper-patch world on top of recovery-loop-fixtures' FurnaceFactorio: a 16-kind inventory, a 25-entity neighbourhood
// (trees, rocks, ore tiles, a chest), a burner mining drill and a stone furnace that are NOT placed yet, and ore lying on the drill's
// drop tile (the Run AE spill). Placement candidates are read like the mod answers them (resource coverage, item_output_position,
// ground_items, footprint, obstruction sample); place_candidate runs against that world: it removes the item from the actor, creates
// the entity, picks the ground items up into the actor inventory and reports them in the receipt (the Run AF receipt). Mining,
// smelting and fuel burn advance only through advance(seconds); failAfterPrefix(n, result) refuses a batch after its first n tasks ran
// (Run Z batch 21). Nothing sets an inventory to an expected answer.

import assert from 'node:assert/strict'

import { FurnaceFactorio, FURNACE_UNIT } from './recovery-loop-fixtures.mjs'

export const DRILL_UNIT = 31
export const DRILL_POSITION = { x: 14, y: -6 }
export const DRILL_OUTPUT = { x: 13.5, y: -7.3 } // north-facing burner drill: vector_to_place_result {-0.5, -1.3}
export const FURNACE_POSITION = { x: 13, y: -8 } // 2x2: x 12..14, y -9..-7 covers the drop point
export const DRILL_SET = 'placement-41'
export const FURNACE_SET = 'placement-42'
export const GROUND_ORE = { name: 'copper-ore', count: 4, quality: 'normal', position: { x: 13.5, y: -7.3 } }

const FUEL_KJ = { coal: 4000, wood: 2000 }
const DRILL_KW = 150
const surfaceIndex = 1

// What the actor carries mid-game: the two machines to place plus the usual stock of a red-science start.
export const LIVE_INVENTORY = Object.freeze({
  'burner-mining-drill': 2,
  'stone-furnace': 3,
  coal: 38,
  wood: 14,
  stone: 31,
  'iron-plate': 87,
  'copper-plate': 6,
  'iron-ore': 24,
  'iron-gear-wheel': 11,
  'copper-cable': 18,
  'electronic-circuit': 4,
  pipe: 5,
  'small-electric-pole': 6,
  'wooden-chest': 2,
  'transport-belt': 20,
  inserter: 3,
})

const RECIPES = {
  'burner-mining-drill': { ingredients: [['iron-gear-wheel', 3], ['stone-furnace', 1], ['iron-plate', 3]], energy: 2, categories: ['crafting'] },
  'stone-furnace': { ingredients: [['stone', 5]], energy: 0.5, categories: ['crafting'] },
}

function recipeDetails(name) {
  const recipe = RECIPES[name]
  return { found: true, query: name, truncated: false, recipes: [{
    name, enabled: true, requested_crafts: 1, craftable_now_count: 0, craftable_now: false, inventory_overlay: {},
    bootstrap: { dependencies: [], first_unresolved: null }, hidden: false, energy: recipe.energy, categories: recipe.categories,
    hand_craftable_category: true,
    ingredients: recipe.ingredients.map(([ingredient, amount]) => ({ type: 'item', name: ingredient, amount })),
    products: [{ type: 'item', name, amount: 1 }], crafting_machine_count: 0, crafting_machines: [], crafting_machines_truncated: false,
  }], mined_from: [] }
}

// getPrototypeDetails answers for the two machines (mining drill: no require_resources_to_place, Run AE).
const PROTOTYPES = {
  'burner-mining-drill': { name: 'burner-mining-drill', type: 'mining-drill', mining_speed: 0.25, resource_categories: ['basic-solid'], vector_to_place_result: [-0.5, -1.3],
    energy_usage_watts: 150000, energy_source: { type: 'burner', fuel_categories: ['chemical'] }, place_items: [{ name: 'burner-mining-drill', count: 1 }] },
  'stone-furnace': { name: 'stone-furnace', type: 'furnace', crafting_speed: 1, crafting_categories: ['smelting'], energy_usage_watts: 90000, energy_source: { type: 'burner', fuel_categories: ['chemical'] }, place_items: [{ name: 'stone-furnace', count: 1 }] },
}

const box = (position, width, height) => ({
  left_top: { x: position.x - width / 2, y: position.y - height / 2 },
  right_bottom: { x: position.x + width / 2, y: position.y + height / 2 },
})
const footprint = position => ({
  tile_width: 2, tile_height: 2, grid: { x_offset: 0, y_offset: 0 },
  tile_box: box(position, 2, 2), world_box: box(position, 2, 2),
})

// The mod's obstruction block (placement_candidates.ts): sampled rejections, not exhaustive causes.
const obstructions = (rejected, tick) => ({
  source: 'native_placement_checks', observed_tick: tick, actor_id: 18,
  interpretation: 'observed_collision_mask_intersections_not_exhaustive_rejection_causes',
  surface_index: surfaceIndex, force_index: 1, scope: 'sampled_footprints', examined_count: 0, rejected_count: rejected, unknown_count: 0, samples: [], truncated: rejected > 0,
})

// The neighbourhood the actor sees: a copper patch, stone, trees, rocks, a chest. Positions are fixed; distances are from the actor.
function neighbourhood() {
  const entities = []
  const add = (entity) => {
    entities.push({ ...entity, distance: Math.round(Math.hypot(entity.position.x, entity.position.y) * 100) / 100 })
  }
  for (const [index, [x, y]] of [[12.5, -4.5], [13.5, -4.5], [14.5, -4.5], [12.5, -5.5], [13.5, -5.5], [14.5, -5.5], [15.5, -5.5], [13.5, -6.5], [14.5, -6.5], [15.5, -6.5]].entries()) {
    add({ name: 'copper-ore', type: 'resource', position: { x, y }, amount: 380 + index * 37, force: 'neutral' })
  }
  for (const [index, [x, y]] of [[22.5, 3.5], [23.5, 4.5], [22.5, 5.5]].entries()) add({ name: 'stone', type: 'resource', position: { x, y }, amount: 520 + index * 41, force: 'neutral' })
  for (const [index, [x, y]] of [[-8, 6], [-9, 9], [-5, 11], [-12, 4], [-14, 8], [-6, -9], [-10, -12], [4, 14]].entries()) {
    add({ name: index % 2 === 0 ? 'tree-05' : 'dry-tree', type: 'tree', unit_number: 900 + index, position: { x, y } })
  }
  for (const [index, [x, y]] of [[7, 9], [-3, -15], [18, 12]].entries()) add({ name: 'rock-big', type: 'simple-entity', unit_number: 940 + index, position: { x, y } })
  add({ name: 'wooden-chest', type: 'container', unit_number: 12, position: { x: 2.5, y: 1.5 } })
  return entities
}

export class DrillFurnaceFactorio extends FurnaceFactorio {
  constructor({ inventory = LIVE_INVENTORY, ground = [GROUND_ORE], connectedPlayers = 0 } = {}) {
    super({ inventory: { ...inventory }, connectedPlayers })
    Object.assign(this.status, { surface_index: surfaceIndex, force_index: 1 }) // the deployment status carries the actor's scope; the topology record needs it
    this.furnacePlaced = false
    this.furnace.position = FURNACE_POSITION
    this.drill = { unit_number: DRILL_UNIT, name: 'burner-mining-drill', placed: false, position: DRILL_POSITION, fuel: {}, energy_kj: 0, mined: 0 }
    this.ground = ground.map(item => ({ ...item, position: { ...item.position } }))
    this.neighbours = neighbourhood()
    this.candidateReads = [] // every placement-candidate read: { entity_name, args, set }
    this.placements = [] // what each place_candidate built, in order
    this.placementReceipts = [] // the receipt body each placement reported
    this.clock = 0
    this.entityCountReads = [] // every entity_count the harness asked, with the live answer
    this.oreAccumulator = 0
    this.smeltAccumulator = 0
  }

  // --- reads ---------------------------------------------------------------------------------------------------------------------

  nearbySnapshot() {
    const entities = [...this.neighbours]
    if (this.drill.placed) {
      const working = this.drillWorking()
      entities.push({ name: 'burner-mining-drill', type: 'mining-drill', unit_number: DRILL_UNIT, position: this.drill.position, direction: 0, distance: 15.2,
        status: working ? 1 : 6, status_name: working ? 'working' : 'no_fuel', working,
        spatial: { item_io: { drop_position: DRILL_OUTPUT, ...(this.furnacePlaced ? { drop_target: { name: 'stone-furnace', unit_number: FURNACE_UNIT } } : {}) } } })
    }
    if (this.furnacePlaced) {
      const status = this.entityStatus()
      entities.push({ name: 'stone-furnace', type: 'furnace', unit_number: FURNACE_UNIT, position: this.furnace.position, direction: 0, distance: 15.3, status: status.status, status_name: status.status_name, working: status.working })
    }
    // The mod's scan header (actor, tick, surface, force) is what the topology record reads.
    return { actor_id: 18, observed_tick: 900 + this.clock, actor_position: { x: 0, y: 0 }, surface: 'nauvis', surface_index: surfaceIndex, force_index: 1,
      matched_count: entities.length, returned_count: entities.length, truncated: false, entities }
  }

  drillWorking() {
    return this.drill.placed && (this.drill.energy_kj >= DRILL_KW || Object.values(this.drill.fuel).some(count => count > 0))
  }

  candidateRead(text) {
    const entityName = /entity_name='([^']+)'/.exec(text)?.[1]
    const covers = /covers_position=\{x=(-?[\d.]+),y=(-?[\d.]+)\}/.exec(text)
    const args = { entity_name: entityName, target_resource: /target_resource='([^']+)'/.exec(text)?.[1], covers_position: covers ? { x: Number(covers[1]), y: Number(covers[2]) } : undefined }
    const tick = 800 + this.candidateReads.length
    let reply
    if (entityName === 'burner-mining-drill') {
      const output = DRILL_OUTPUT
      reply = { ok: true, entity_name: entityName, candidate_set_id: DRILL_SET, generated_tick: tick, expires_tick: tick + 1800,
        center: { x: 13.5, y: -5.5 }, radius: 6, target_resource: args.target_resource, ordering: 'resource_coverage_then_nearest_to_center',
        electric_pole: null, scanned: 61, obstructions: obstructions(14, tick), legal_candidate_count: 3, returned_candidate_count: 3,
        candidates: [
          { id: 'candidate-1', position: DRILL_POSITION, direction: 0, distance_from_center: 0.71, item_output_position: output,
            resource_coverage: [{ name: 'copper-ore', entities: 4, amount: 1708 }], footprint: footprint(DRILL_POSITION) },
          { id: 'candidate-2', position: { x: 12, y: -6 }, direction: 0, distance_from_center: 1.58, item_output_position: { x: 11.5, y: -7.3 },
            resource_coverage: [{ name: 'copper-ore', entities: 2, amount: 817 }], footprint: footprint({ x: 12, y: -6 }) },
          { id: 'candidate-3', position: { x: 16, y: -6 }, direction: 0, distance_from_center: 2.55, item_output_position: { x: 15.5, y: -7.3 },
            resource_coverage: [{ name: 'copper-ore', entities: 1, amount: 439 }], footprint: footprint({ x: 16, y: -6 }) },
        ] }
    }
    else if (entityName === 'stone-furnace') {
      assert.ok(args.covers_position, 'a furnace for a drill output is searched with covers_position')
      reply = { ok: true, entity_name: entityName, candidate_set_id: FURNACE_SET, generated_tick: tick, expires_tick: tick + 1800,
        center: args.covers_position, radius: 4, covers_position: args.covers_position, ordering: 'resource_coverage_then_nearest_to_center',
        electric_pole: null, scanned: 33, obstructions: obstructions(6, tick), legal_candidate_count: 2, returned_candidate_count: 2,
        candidates: [
          // The footprint's only blocker is the spilled ore: it is listed, and placing this candidate picks it up (Run AE).
          { id: 'candidate-1', position: FURNACE_POSITION, direction: 0, distance_from_center: 0.7, footprint: footprint(FURNACE_POSITION),
            ground_items: this.ground.map(item => ({ ...item })) },
          { id: 'candidate-2', position: { x: 14, y: -8 }, direction: 0, distance_from_center: 0.58, footprint: footprint({ x: 14, y: -8 }) },
        ] }
    }
    else reply = { ok: false, error: 'unsupported entity in this fixture', entity_name: entityName }
    this.candidateReads.push({ entity_name: entityName, args, set: reply.candidate_set_id })
    return reply
  }

  // --- preflight ----------------------------------------------------------------------------------------------------------------

  furnacePreflight(text) {
    if (text.includes("'operation','place_candidate'")) {
      const set = /candidate_set_id='([^']+)'/.exec(text)?.[1]
      const entity = set === DRILL_SET ? 'burner-mining-drill' : set === FURNACE_SET ? 'stone-furnace' : undefined
      const result = entity
        ? { ok: true, operation: 'place_candidate', placement_item: { item_name: entity, count: 1, held_count: this.inventory[entity] ?? 0 } }
        : { ok: false, code: 'placement_candidate_unavailable' }
      this.preflights.push({ name: 'place_candidate', args: { candidate_set_id: set }, result })
      return result
    }
    return super.furnacePreflight(text)
  }

  supplyPreflight(request) {
    if (request.unit_number !== DRILL_UNIT) return super.supplyPreflight(request)
    const entries = request.items.map((item) => {
      const held = this.inventory[item.item_name] ?? 0
      const accepts = item.item_name in FUEL_KJ ? Math.max(0, 50 - (this.drill.fuel[item.item_name] ?? 0)) : 0
      return { item_name: item.item_name, requested: item.count, source_count: held, destination_accepts: accepts, expected_moved: Math.min(item.count, held, accepts),
        missing: Math.max(0, item.count - held), status: held < item.count ? 'supply_missing' : accepts === 0 ? 'destination_full' : 'ok',
        single_slot_destination: { inventory_index: 1, slot_count: 1 } }
    })
    const result = { operation: 'supply_entity', field: 'unit_number', identity: DRILL_UNIT, refusal_class: 'world',
      target: { unit_number: DRILL_UNIT, name: 'burner-mining-drill', position: this.drill.position, surface_index: surfaceIndex, force_index: 1 },
      transfer: { direction: 'to_entity', items: entries } }
    const bad = entries.find(entry => entry.status !== 'ok')
    return bad ? { ok: false, code: bad.status, ...result } : { ok: true, ...result }
  }

  // --- commands -----------------------------------------------------------------------------------------------------------------

  async command(text) {
    if (text.includes('"get_placement_candidates"')) return JSON.stringify(this.candidateRead(text))
    if (text.includes("remote.call('autorio_preflight','operation','place_candidate'")) return JSON.stringify(this.furnacePreflight(text))
    if (text.includes('"autorio_prototypes","details"')) {
      const name = /"details",'([^']+)'/.exec(text)?.[1]
      return JSON.stringify(PROTOTYPES[name] ? { found: true, query: name, entity: PROTOTYPES[name] } : { found: false, query: name, error: 'prototype not found as item, fluid, or entity' })
    }
    if (text.includes('"autorio_discovery","find_entities"')) {
      const resource = /"find_entities",'([^']+)'/.exec(text)?.[1]
      const tiles = this.neighbours.filter(entity => entity.name === resource).sort((a, b) => a.distance - b.distance).slice(0, 1)
      return JSON.stringify({ found: tiles.length > 0, name: resource, actor_position: { x: 0, y: 0 }, searched_radius: 32, max_radius: 1024, matched_count: tiles.length, returned_count: tiles.length, truncated: false, entities: tiles })
    }
    if (text.includes('"evaluate_condition"') && text.includes('"entity_count"')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)?.[1]
      const request = JSON.parse(encoded.replace(/\\(.)/g, '$1'))
      if (!['burner-mining-drill', 'stone-furnace'].includes(request.prototype)) return JSON.stringify({ ok: false, error: 'unknown_entity', prototype: request.prototype })
      const current = (request.prototype === 'burner-mining-drill' && this.drill.placed) || (request.prototype === 'stone-furnace' && this.furnacePlaced) ? 1 : 0
      this.entityCountReads.push({ prototype: request.prototype, current })
      return JSON.stringify({ ok: true, kind: 'entity_count', prototype: request.prototype, minimum: request.minimum, current, found: current, truncated: false,
        satisfied: current >= request.minimum, tick: 900 + this.entityCountReads.length, progress_known: false })
    }
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      if (name in RECIPES) return JSON.stringify(recipeDetails(name))
    }
    if (text.includes('get_entity_status') && text.includes(String(DRILL_UNIT))) {
      this.readCommands.push('get_entity_status')
      return JSON.stringify({ found: true, entity: { unit_number: DRILL_UNIT, name: 'burner-mining-drill', type: 'mining-drill', working: this.drillWorking(),
        status_name: this.drillWorking() ? 'working' : 'no_fuel', inventories: [{ index: 1, items: Object.entries(this.drill.fuel).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) }] } })
    }
    return super.command(text)
  }

  // --- the batch the game finishes ---------------------------------------------------------------------------------------------

  completeOperation(operation, batch) {
    const { args } = operation
    if (operation.name === 'place_candidate') {
      this.placeCandidate(args, batch)
      return true
    }
    if (operation.name === 'supply_entity' && args.unit_number === DRILL_UNIT) {
      for (const item of args.items) {
        const count = Math.min(item.count, this.inventory[item.item_name] ?? 0, item.item_name in FUEL_KJ ? 50 - (this.drill.fuel[item.item_name] ?? 0) : 0)
        if (count > 0) {
          this.inventory[item.item_name] -= count
          this.drill.fuel[item.item_name] = (this.drill.fuel[item.item_name] ?? 0) + count
        }
        this.effects.push({ batch_id: batch.batch_id, operation: operation.name, item: item.item_name, moved: count, to_entity: true, unit: DRILL_UNIT })
      }
      return true
    }
    return false
  }

  placeCandidate({ candidate_set_id: set, candidate_id: candidate }, batch) {
    const drill = set === DRILL_SET
    assert.ok(drill || set === FURNACE_SET, `unknown candidate set ${set}`)
    assert.equal(candidate, 'candidate-1', 'this world offers its legal placement as candidate-1')
    const item = drill ? 'burner-mining-drill' : 'stone-furnace'
    assert.ok((this.inventory[item] ?? 0) >= 1, `the actor holds no ${item} to place`)
    const position = drill ? DRILL_POSITION : FURNACE_POSITION
    // The native check decides again after the pickup; ground items are the footprint's only blocker.
    const pickedUp = []
    if (!drill) {
      for (const ground of this.ground) {
        this.inventory[ground.name] = (this.inventory[ground.name] ?? 0) + ground.count
        pickedUp.push({ ...ground, position: { ...ground.position } })
      }
      this.ground = []
    }
    this.inventory[item] -= 1
    if (drill) Object.assign(this.drill, { placed: true })
    else this.furnacePlaced = true
    this.placements.push({ batch_id: batch.batch_id, entity_name: item, position, picked_up: pickedUp })
    this.effects.push({ batch_id: batch.batch_id, operation: 'place_candidate', item, moved: 1, picked_up: pickedUp.reduce((sum, ground) => sum + ground.count, 0) })
    this.placementReceipts.push({
      type: 'placing', entity_name: item, placed_unit_number: drill ? DRILL_UNIT : FURNACE_UNIT, placed_entity_type: drill ? 'mining-drill' : 'furnace',
      placed_position: position, placed_surface_index: surfaceIndex, placed_direction: 0, ...(pickedUp.length > 0 ? { ground_items_picked_up: pickedUp } : {}),
    })
  }

  // The pending batch's first `prefix` tasks run and then the next one is refused before it creates anything (the mod's receipt: the
  // failing task's index, the tasks started, and the placement's native no-mutation claim for that task). Returns the failure reason
  // the mod's [ERROR] line carries. Run Z batch 21: the engine overlapped the boiler built earlier in the same batch.
  failAfterPrefix(prefix, result) {
    const batch = this.pendingBatch
    assert.ok(batch, 'failAfterPrefix: no admitted batch is pending')
    for (const operation of batch.operations.slice(0, prefix)) assert.ok(this.completeOperation(operation, batch), `${operation.name} is modelled`)
    this.pendingBatch = null
    const reason = this.failLastBatch(result, undefined, { failedTaskIndex: prefix })
    this.receipts.push({ ...this.cancelledBatch, state: 'cancelled' })
    return reason
  }

  completeBatch() {
    const placementsBefore = this.placementReceipts.length
    const batch = super.completeBatch()
    // The batch's last basic result is its last task's: a placement receipt when the batch ended in one.
    if (this.placementReceipts.length > placementsBefore && batch.operations.at(-1)?.name === 'place_candidate') {
      this.lastBasicResult = { operation_id: batch.batch_id, tick: 600 + batch.batch_id, actor_id: this.status.actor_id, accepted: true, completed: true, code: 'completed', ...this.placementReceipts.at(-1) }
    }
    return batch
  }

  // --- time ---------------------------------------------------------------------------------------------------------------------

  // Whole seconds pass: a fuelled drill mines 0.25 ore/s onto its drop point (into the furnace when one covers it, else onto the
  // ground), burning fuel; the furnace smelts one source ore per 3.2 s while it has fuel.
  advance(seconds) {
    for (let second = 0; second < seconds; second++) {
      this.clock += 1
      if (this.drill.placed) {
        if (this.drill.energy_kj < DRILL_KW) {
          const fuel = Object.keys(this.drill.fuel).find(name => this.drill.fuel[name] > 0)
          if (fuel) {
            this.drill.fuel[fuel] -= 1
            this.drill.energy_kj += FUEL_KJ[fuel]
          }
        }
        if (this.drill.energy_kj >= DRILL_KW) {
          this.drill.energy_kj -= DRILL_KW
          this.oreAccumulator += 0.25
          if (this.oreAccumulator >= 1) {
            this.oreAccumulator -= 1
            this.drill.mined += 1
            const covered = this.furnacePlaced && this.slotAccepts('source', 'copper-ore') > 0
            if (covered) this.furnace.source['copper-ore'] = (this.furnace.source['copper-ore'] ?? 0) + 1
            else this.ground.push({ name: 'copper-ore', count: 1, quality: 'normal', position: { ...DRILL_OUTPUT } })
          }
        }
      }
      if (this.furnacePlaced) {
        this.smeltAccumulator += 1 / 3.2
        if (this.smeltAccumulator >= 1) {
          this.smeltAccumulator -= 1
          this.smelt(1)
        }
      }
    }
  }

  worldTotals() {
    const totals = super.worldTotals()
    for (const [item, count] of Object.entries(this.drill.fuel)) totals[item] = (totals[item] ?? 0) + count
    for (const ground of this.ground) totals[ground.name] = (totals[ground.name] ?? 0) + ground.count
    return totals
  }
}
