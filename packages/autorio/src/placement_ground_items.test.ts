import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_operation_admission } from './operation_admission'
import { create_placement_candidate_set, execute_placement_candidate } from './placement_candidates'
import { placement_footprint } from './placement_geometry'
import { placement_clearance } from './placement_clearing'
import { new_task_manager } from './task_manager'

// Run AE: a burner drill fueled before its furnace existed dropped one copper
// ore on its output tile. The script build check refused all 52 furnace
// footprints covering that tile because of the item lying there, so the NPC
// could never place the furnace a player would simply build over it.

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

const FURNACE = {
  name: 'stone-furnace',
  type: 'furnace',
  tile_width: 2,
  tile_height: 2,
  collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
}
const DROP = { x: -33.5, y: -35.296875 }

function inside(box: Box, position: { x: number, y: number }) {
  return position.x > box.left_top.x && position.x < box.right_bottom.x && position.y > box.left_top.y && position.y < box.right_bottom.y
}

function ground_item(name: string, count: number, position: { x: number, y: number }) {
  const entity: any = {
    valid: true,
    name: 'item-on-ground',
    type: 'item-entity',
    position,
    prototype: { collision_mask: { layers: { item: true } } },
    stack: { valid_for_read: true, name, count, quality: { name: 'normal' } },
  }
  entity.destroy = vi.fn(() => { entity.valid = false })
  return entity
}

function world(entities: any[]) {
  const live = () => entities.filter(entity => entity.valid)
  const in_area = (filters: any) => live().filter(entity => (!filters.type || entity.type === filters.type) && (!filters.area || inside(filters.area, entity.position)))
  const surface: any = {
    index: 1,
    get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
    find_entities_filtered: vi.fn((filters: any) => in_area(filters).slice(0, filters.limit ?? 1000)),
    count_entities_filtered: vi.fn((filters: any) => in_area(filters).length),
    // The script check: anything in the footprint blocks it, ground items included.
    can_place_entity: vi.fn((args: any) => in_area({ area: placement_footprint(FURNACE, args.position, args.direction).world_box }).length === 0),
  }
  return surface
}

function inventory_with(slots: number) {
  const held: Record<string, number> = { 'stone-furnace': 1 }
  const inventory: any = {
    held,
    get_item_count: vi.fn((name: string) => held[name] ?? 0),
    remove: vi.fn(({ name, count }: any) => {
      const removed = Math.min(held[name] ?? 0, count)
      held[name] = (held[name] ?? 0) - removed
      return removed
    }),
    insert: vi.fn((stack: any) => {
      const inserted = Math.min(stack.count, slots)
      slots -= inserted
      held[stack.name] = (held[stack.name] ?? 0) + inserted
      return inserted
    }),
  }
  return inventory
}

function npc(surface: any, inventory: any) {
  return {
    is_valid: true,
    character: { valid: true },
    position: { x: -33, y: -37 },
    surface,
    force: { index: 1 },
    get_main_inventory: () => inventory,
    entity_build_args: () => ({ force: { index: 1 } }),
    status_snapshot: () => ({ actor_id: 7, kind: 'standalone_character', valid: true, has_character: true, position: { x: -33, y: -37 } }),
  } as unknown as ControlledActor
}

function placing(actor: ControlledActor) {
  const manager = new_task_manager(() => actor)
  const controller = new_basic_operation_controller(() => actor, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  return { controller, runtime }
}

describe('ground items in a placement footprint (Run AE)', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity
  const originalItemPrototypes = (globalThis as any).prototypes.item

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': FURNACE }
    ;(globalThis as any).prototypes.item = { 'stone-furnace': {} }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
    ;(globalThis as any).prototypes.item = originalItemPrototypes
  })

  it('returns furnace candidates over the drill drop point and lists the ore lying there', () => {
    const ore = ground_item('copper-ore', 1, DROP)
    const surface = world([ore])
    const result = create_placement_candidate_set(npc(surface, inventory_with(10)), {
      entity_name: 'stone-furnace',
      covers_position: DROP,
      center: { x: -33, y: -34 },
      radius: 8,
      limit: 4,
    }) as any

    expect(result.ok).toBe(true)
    expect(result.returned_candidate_count).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.ground_items).toEqual([{ name: 'copper-ore', count: 1, quality: 'normal', position: DROP }])
    }
    expect(ore.destroy).not.toHaveBeenCalled()
  })

  it('still rejects a footprint that anything other than a ground item blocks', () => {
    const chest = { valid: true, name: 'wooden-chest', type: 'container', unit_number: 5, position: DROP, prototype: { collision_mask: { layers: { object: true, item: true } } } }
    const surface = world([ground_item('copper-ore', 1, DROP), chest])
    const result = create_placement_candidate_set(npc(surface, inventory_with(10)), {
      entity_name: 'stone-furnace',
      covers_position: DROP,
      center: { x: -33, y: -34 },
      radius: 8,
    }) as any

    expect(result.ok).toBe(true)
    expect(result.returned_candidate_count).toBe(0)
    expect(result.obstructions.rejected_count).toBeGreaterThan(0)
  })

  it('places over the ground item by picking it up first, then lets the native check decide', () => {
    const ore = ground_item('copper-ore', 1, DROP)
    const surface = world([ore])
    surface.create_entity = vi.fn((args: any) => ({ valid: true, name: args.name, type: 'furnace', unit_number: 21, position: args.position, direction: 0, surface, force: { index: 1 } }))
    const inventory = inventory_with(10)
    const actor = npc(surface, inventory)
    const { controller, runtime } = placing(actor)

    expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
    const result = runtime.state_placing(actor)

    expect(result?.[0]).toBe(true)
    expect(ore.destroy).toHaveBeenCalledTimes(1)
    expect(inventory.held['copper-ore']).toBe(1)
    expect(surface.can_place_entity).toHaveBeenCalledTimes(2)
    expect(surface.create_entity).toHaveBeenCalledTimes(1)
    expect(controller.status().last_result).toMatchObject({
      code: 'completed',
      placed_unit_number: 21,
      ground_items_picked_up: [{ name: 'copper-ore', count: 1, quality: 'normal', position: DROP }],
    })
  })

  it('fails without building when the ground items do not fit in the actor inventory', () => {
    const ore = ground_item('copper-ore', 3, DROP)
    const surface = world([ore])
    surface.create_entity = vi.fn()
    const actor = npc(surface, inventory_with(1))
    const { controller, runtime } = placing(actor)

    expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
    const result = runtime.state_placing(actor)

    expect(result?.[0]).toBe(false)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(ore.valid).toBe(true)
    expect(ore.stack.count).toBe(2)
    expect(controller.status().last_result).toMatchObject({
      code: 'ground_items_inventory_full',
      ground_items_picked_up: [{ name: 'copper-ore', count: 1 }],
      ground_item_left: { name: 'copper-ore', count: 2 },
    })
  })

  it('keeps a ground-item candidate executable until the native check refuses it for something else', () => {
    const entities: any[] = [ground_item('copper-ore', 1, DROP)]
    const surface = world(entities)
    const actor = npc(surface, inventory_with(10))
    const generated = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', covers_position: DROP, center: { x: -33, y: -34 }, radius: 8, limit: 1 }) as any
    const submit = vi.fn(() => true)

    expect(execute_placement_candidate(actor, generated.candidate_set_id, generated.candidates[0].id, submit)[0]).toBe(true)
    entities.push({ valid: true, name: 'character', type: 'character', position: DROP, prototype: { collision_mask: { layers: { object: true } } } })
    expect(execute_placement_candidate(actor, generated.candidate_set_id, generated.candidates[0].id, submit)).toEqual([false, 'placement candidate is no longer placeable'])
  })

  it('leaves tile-rule entities on their strict manual check', () => {
    ;(globalThis as any).prototypes.entity['offshore-pump'] = { ...FURNACE, name: 'offshore-pump', type: 'offshore-pump' }
    const surface = world([ground_item('copper-ore', 1, DROP)])
    expect(placement_clearance(npc(surface, inventory_with(10)), FURNACE, 'offshore-pump', { x: -34, y: -36 }, 0)).toBeUndefined()
    expect(placement_clearance(npc(surface, inventory_with(10)), FURNACE, 'stone-furnace', { x: -34, y: -36 }, 0)?.ground_items).toHaveLength(1)
  })
})

// Run AF preflight review: a placement that picked up ground items changed the
// actor inventory and the ground before it failed, so its cancelled batch must
// not carry the no-mutation proof that admission and runtime reconciliation
// settle as a refusal. These drive the real task manager, receipt journal and
// admission journal, and check that items are conserved.
describe('placement pickup mutation accounting (Run AF)', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity
  const originalItemPrototypes = (globalThis as any).prototypes.item
  const originalRemote = (globalThis as any).remote
  const identity = { operation_key: 'request/place-furnace', attempt_id: 'attempt-1', actor_id: 7, epoch: 3, signature: 'hash-1', ordinal: 1, operation_count: 1 }

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': FURNACE }
    ;(globalThis as any).prototypes.item = { 'stone-furnace': {} }
    ;(globalThis as any).remote = { interfaces: { sgluna_deployment: { authorize: true } }, call: vi.fn((_name: string, _method: string, epoch: number) => epoch === 3) }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
    ;(globalThis as any).prototypes.item = originalItemPrototypes
    ;(globalThis as any).remote = originalRemote
  })

  // One admitted place_entity operation, journaled the way the remote interface does it.
  function admitted_placement(surface: any, inventory: any) {
    const actor = npc(surface, inventory)
    const manager = new_task_manager(() => actor)
    const controller = new_basic_operation_controller(() => actor, manager)
    const runtime = new_basic_operation_runtime(manager, controller)
    const admission = new_operation_admission(() => actor, () => manager.get_status_snapshot())
    expect(admission.begin(identity)).toMatchObject({ ok: true })
    expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
    const active = (globalThis as any).storage.sgluna_task_active_batch
    const ref = { batch_id: active.batch_id, batch_generation: active.batch_generation, batch_ref: active.batch_ref }
    expect(admission.slot(identity.operation_key, 1, { ok: true, operation: 'place_entity', queued_tasks: 1, batch_refs: [ref] })).toMatchObject({ ok: true })
    admission.finish(identity.operation_key, { ok: true })
    expect(admission.status().records[0].state).toBe('admitted')
    const place = () => runtime.state_placing(actor)
    const receipt = () => manager.get_status_snapshot().receipt_journal.find((entry: any) => entry.batch_ref === ref.batch_ref)
    const record = () => admission.status().records[0]
    const receipts = () => manager.get_status_snapshot().receipt_journal as any[]
    return { controller, place, receipt, receipts, record }
  }

  function ground_count(entities: any[], name: string) {
    return entities.filter(entity => entity.valid).reduce((sum, entity) => sum + (entity.stack.name === name ? entity.stack.count : 0), 0)
  }

  it('keeps the no-mutation proof when the inventory took nothing from the ground', () => {
    const entities = [ground_item('copper-ore', 3, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn()
    const inventory = inventory_with(0)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(false)

    expect(run.controller.status().last_result).toMatchObject({ code: 'ground_items_inventory_full', ground_item_left: { name: 'copper-ore', count: 3 } })
    expect(run.controller.status().last_result?.ground_items_picked_up).toBeUndefined()
    expect(run.receipt()).toMatchObject({ state: 'cancelled', reason: 'placing:ground_items_inventory_full', started_count: 1, failed_before_mutation: true })
    expect(run.record()).toMatchObject({ state: 'failed', proven_refusal: true, error: 'refused_before_mutation' })
    expect(ground_count(entities, 'copper-ore')).toBe(3)
    expect(inventory.held['copper-ore'] ?? 0).toBe(0)
    expect(surface.create_entity).not.toHaveBeenCalled()
  })

  it('leaves a partial pickup uncertain, with the picked-up and remaining items conserved', () => {
    const entities = [ground_item('copper-ore', 3, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn()
    const inventory = inventory_with(1)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(false)

    const result = run.controller.status().last_result
    expect(result).toMatchObject({
      code: 'ground_items_inventory_full',
      ground_items_picked_up: [{ name: 'copper-ore', count: 1, position: DROP }],
      ground_item_left: { name: 'copper-ore', count: 2, position: DROP },
    })
    const receipt = run.receipt()
    expect(receipt).toMatchObject({ state: 'cancelled', reason: 'placing:ground_items_inventory_full', started_count: 1 })
    expect(receipt?.failed_before_mutation).toBeUndefined()
    expect(receipt?.failed_task_index).toBeUndefined()
    expect(run.record()).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    expect(run.record().proven_refusal).toBeUndefined()
    // 3 ore before: 1 in the inventory and 2 still on the ground, as reported.
    expect(inventory.held['copper-ore']).toBe(result?.ground_items_picked_up?.[0].count)
    expect(ground_count(entities, 'copper-ore')).toBe(result?.ground_item_left?.count)
    expect(inventory.held['copper-ore']! + ground_count(entities, 'copper-ore')).toBe(3)
    expect(inventory.held['stone-furnace']).toBe(1)
    expect(surface.create_entity).not.toHaveBeenCalled()
  })

  it('records every stack picked up before a later stack only partly fits', () => {
    const SECOND = { x: -34.5, y: -35.5 }
    const entities = [ground_item('copper-ore', 2, DROP), ground_item('copper-ore', 3, SECOND)]
    const surface = world(entities)
    surface.create_entity = vi.fn()
    const inventory = inventory_with(3)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(false)

    const result = run.controller.status().last_result
    expect(result).toMatchObject({
      code: 'ground_items_inventory_full',
      ground_items_picked_up: [{ name: 'copper-ore', count: 2, position: DROP }, { name: 'copper-ore', count: 1, position: SECOND }],
      ground_item_left: { name: 'copper-ore', count: 2, position: SECOND },
    })
    expect(run.receipt()?.failed_before_mutation).toBeUndefined()
    expect(run.record()).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    // 5 ore before: 3 in the inventory, the first stack gone and 2 left of the second.
    expect(entities[0].valid).toBe(false)
    expect(entities[1].stack.count).toBe(2)
    expect(inventory.held['copper-ore']).toBe(3)
    expect(inventory.held['copper-ore']! + ground_count(entities, 'copper-ore')).toBe(5)
  })

  it('does not carry one placement\'s pickup into the next placement\'s proof', () => {
    const entities = [ground_item('copper-ore', 3, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn()
    const inventory = inventory_with(1)
    const run = admitted_placement(surface, inventory)
    expect(run.place()?.[0]).toBe(false)
    expect(run.controller.status().last_result?.ground_items_picked_up).toHaveLength(1)

    // A second placement onto the same, still blocked tile with a full inventory
    // picks nothing up, so its own refusal keeps the proof.
    expect(run.controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
    expect(run.place()?.[0]).toBe(false)
    const second = run.controller.status().last_result
    expect(second).toMatchObject({ code: 'ground_items_inventory_full', ground_item_left: { count: 2 } })
    expect(second?.ground_items_picked_up).toBeUndefined()
    const latest = run.receipts().at(-1)
    expect(latest).toMatchObject({ state: 'cancelled', failed_before_mutation: true })
  })

  it('reports the pickup and withholds the proof when the native check still refuses after it', () => {
    const entities = [ground_item('copper-ore', 1, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn()
    // Something the obstruction sample cannot see refuses the second check.
    surface.can_place_entity.mockReturnValue(false)
    const inventory = inventory_with(10)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(false)

    expect(surface.can_place_entity).toHaveBeenCalledTimes(2)
    expect(run.controller.status().last_result).toMatchObject({
      code: 'not_placeable',
      ground_items_picked_up: [{ name: 'copper-ore', count: 1, position: DROP }],
    })
    expect(run.receipt()?.failed_before_mutation).toBeUndefined()
    expect(run.record()).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    expect(inventory.held['copper-ore']).toBe(1)
    expect(ground_count(entities, 'copper-ore')).toBe(0)
    expect(inventory.held['stone-furnace']).toBe(1)
  })

  it('keeps the pickup on a creation failure and withholds the proof', () => {
    const entities = [ground_item('copper-ore', 2, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn(() => undefined)
    const inventory = inventory_with(10)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(false)

    expect(run.controller.status().last_result).toMatchObject({
      code: 'create_failed',
      ground_items_picked_up: [{ name: 'copper-ore', count: 2, position: DROP }],
    })
    expect(run.receipt()).toMatchObject({ state: 'cancelled', reason: 'placing:create_failed' })
    expect(run.receipt()?.failed_before_mutation).toBeUndefined()
    expect(run.record()).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    expect(inventory.held['copper-ore']).toBe(2)
    expect(ground_count(entities, 'copper-ore')).toBe(0)
    // Creation failed, so the furnace item was not consumed.
    expect(inventory.held['stone-furnace']).toBe(1)
  })

  it('fails without a proof when a picked-up stack stays on the ground', () => {
    const ore = ground_item('copper-ore', 1, DROP)
    ore.destroy = vi.fn()
    const surface = world([ore])
    surface.create_entity = vi.fn()
    const run = admitted_placement(surface, inventory_with(10))

    expect(run.place()?.[0]).toBe(false)

    expect(run.controller.status().last_result).toMatchObject({
      code: 'ground_item_pickup_failed',
      ground_item_pickup_uncertain: true,
      ground_items_picked_up: [{ name: 'copper-ore', count: 1 }],
    })
    expect(run.receipt()?.failed_before_mutation).toBeUndefined()
    expect(run.record()).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    expect(surface.create_entity).not.toHaveBeenCalled()
  })

  it('completes a pickup and build with a receipt that matches the inventory change', () => {
    const entities = [ground_item('copper-ore', 2, DROP)]
    const surface = world(entities)
    surface.create_entity = vi.fn((args: any) => ({ valid: true, name: args.name, type: 'furnace', unit_number: 21, position: args.position, direction: 0, surface, force: { index: 1 } }))
    const inventory = inventory_with(10)
    const run = admitted_placement(surface, inventory)

    expect(run.place()?.[0]).toBe(true)

    const result = run.controller.status().last_result
    expect(result).toMatchObject({ code: 'completed', placed_unit_number: 21 })
    expect(result?.ground_items_picked_up).toEqual([{ name: 'copper-ore', count: 2, quality: 'normal', position: DROP }])
    expect(inventory.held['copper-ore']).toBe(2)
    expect(ground_count(entities, 'copper-ore')).toBe(0)
    expect(inventory.held['stone-furnace']).toBe(0)
    expect(run.receipt()).toMatchObject({ state: 'completed' })
    expect(run.record()).toMatchObject({ state: 'completed' })
  })
})
