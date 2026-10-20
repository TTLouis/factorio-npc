import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { create_placement_candidate_set, execute_placement_candidate, sort_candidates } from './placement_candidates'
import { placement_footprint } from './placement_geometry'
import { new_task_manager } from './task_manager'

// Run 19af: getPlacementCandidates returned legal drill candidates, but its rejected-footprint
// samples (footprints overlapping furnace 31) were listed first and both roles read the answer as
// blocked; the candidates were also about 15 tiles from the furnace they were meant to feed. The
// candidate read now lists candidates first, labels the rejected footprints, ranks by distance to
// an anchor entity, and treats footprints blocked only by clearable entities as legal.

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }
type Pos = { x: number, y: number }

const FURNACE = {
  name: 'stone-furnace',
  type: 'furnace',
  tile_width: 2,
  tile_height: 2,
  collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
}
const SPOT = { x: -33.5, y: -35.5 }
const ACTOR_FORCE = { index: 1, name: 'player' }
const NEUTRAL = { index: 3, name: 'neutral' }
const OTHER_FORCE = { index: 2, name: 'other' }
const STATUS = { working: 1, normal: 2, no_ingredients: 3 }
const MASK = { layers: { object: true } }

function inside(box: Box, position: Pos) {
  return position.x > box.left_top.x && position.x < box.right_bottom.x && position.y > box.left_top.y && position.y < box.right_bottom.y
}

let next_unit = 100
function entity(fields: Record<string, any>): any {
  const value: any = {
    valid: true,
    unit_number: next_unit++,
    force: ACTOR_FORCE,
    minable: true,
    surface: { index: 1 },
    ...fields,
  }
  value.destroy = vi.fn(() => { value.valid = false })
  return value
}

// Natural: trees and rocks are neutral-force, hand-minable, and not placed buildings. The engine marks
// every simple entity (a rock) as is_building, so the prototype's owner/placing item decides, as in the mod.
function tree(position: Pos) {
  const result = entity({
    name: 'tree-01',
    type: 'tree',
    position,
    force: NEUTRAL,
    prototype: { type: 'tree', is_building: false, is_entity_with_owner: false, items_to_place_this: [], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 0.55, products: [{ type: 'item', name: 'wood', amount: 4 }] } },
  })
  return result
}
function rock(position: Pos) {
  return entity({
    name: 'rock-big',
    type: 'simple-entity',
    position,
    force: NEUTRAL,
    prototype: { type: 'simple-entity', is_building: true, is_entity_with_owner: false, items_to_place_this: [], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 2, products: [{ type: 'item', name: 'stone', amount_min: 20, amount_max: 50 }] } },
  })
}
function cliff(position: Pos) {
  return entity({
    name: 'cliff',
    type: 'cliff',
    position,
    force: NEUTRAL,
    minable: false,
    prototype: { type: 'cliff', is_building: true, is_entity_with_owner: false, items_to_place_this: [], collision_mask: MASK, mineable_properties: { minable: false } },
  })
}
// A built chest. Defaults describe an idle NPC-built entity: actor force, no human last_user, no status,
// empty inventories, no fluid, no logistic or wire links.
function chest(position: Pos, fields: Record<string, any> = {}) {
  return entity({
    name: 'wooden-chest',
    type: 'container',
    position,
    prototype: { type: 'container', is_building: true, is_entity_with_owner: true, items_to_place_this: [{ name: 'wooden-chest', count: 1 }], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 0.2, products: [{ type: 'item', name: 'wooden-chest', amount: 1 }] } },
    status: undefined,
    last_user: undefined,
    get_max_inventory_index: () => 1,
    get_inventory: () => ({ is_empty: () => true }),
    fluidbox: [],
    ...fields,
  })
}

function ground_item(name: string, count: number, position: Pos) {
  return entity({
    name: 'item-on-ground',
    type: 'item-entity',
    position,
    prototype: { collision_mask: { layers: { item: true } } },
    stack: { valid_for_read: true, name, count, quality: { name: 'normal' } },
  })
}

function world(entities: any[]) {
  const live = () => entities.filter(value => value.valid)
  const in_area = (filters: any) => live().filter(value => (!filters.type || value.type === filters.type) && (!filters.area || inside(filters.area, value.position)))
  const surface: any = {
    index: 1,
    get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
    find_entities_filtered: vi.fn((filters: any) => in_area(filters).slice(0, filters.limit ?? 1000)),
    count_entities_filtered: vi.fn((filters: any) => in_area(filters).length),
    // The script check: anything in the footprint blocks it.
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
      // Room comes back for everything except the placement item, which was never part of the room under test.
      if (name !== 'stone-furnace') slots += removed
      return removed
    }),
    can_insert: vi.fn(({ count }: any) => count <= slots),
    insert: vi.fn((stack: any) => {
      const inserted = Math.min(stack.count, slots)
      slots -= inserted
      held[stack.name] = (held[stack.name] ?? 0) + inserted
      return inserted
    }),
  }
  return inventory
}

function npc(surface: any, inventory: any, position: Pos = { x: -33, y: -37 }) {
  return {
    is_valid: true,
    character: { valid: true, prototype: { mining_speed: 0.5 }, character_mining_speed_modifier: 0, resource_reach_distance: 2.7, build_distance: 10 },
    position,
    surface,
    force: { ...ACTOR_FORCE, manual_mining_speed_modifier: 0 },
    get_main_inventory: () => inventory,
    entity_build_args: () => ({ force: { index: 1 } }),
    status_snapshot: () => ({ actor_id: 7, kind: 'standalone_character', valid: true, has_character: true, position }),
  } as unknown as ControlledActor
}

// Native mining as the engine does it: the products go into the given inventory and the entity is gone.
function mineable(value: any) {
  value.mine = vi.fn(({ inventory: target }: any) => {
    for (const product of value.prototype.mineable_properties.products) target.insert({ name: product.name, count: product.amount ?? product.amount_max })
    value.valid = false
    return true
  })
  return value
}

function request(extra: Record<string, unknown> = {}) {
  return { entity_name: 'stone-furnace', covers_position: SPOT, center: { x: -33, y: -34 }, radius: 8, limit: 4, ...extra }
}

describe('placement candidate reads and clearing (Run 19af)', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity
  const originalItemPrototypes = (globalThis as any).prototypes.item
  const originalDefines = (globalThis as any).defines
  const originalGetEntity = (globalThis as any).game.get_entity_by_unit_number
  let by_unit: Record<number, any>

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': FURNACE }
    ;(globalThis as any).prototypes.item = { 'stone-furnace': {} }
    ;(globalThis as any).defines = { ...originalDefines, entity_status: STATUS }
    by_unit = {}
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => by_unit[unit]
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
    ;(globalThis as any).prototypes.item = originalItemPrototypes
    ;(globalThis as any).defines = originalDefines
    ;(globalThis as any).game.get_entity_by_unit_number = originalGetEntity
  })

  function register(...values: any[]) {
    for (const value of values) by_unit[value.unit_number] = value
    return values[0]
  }

  describe('candidates first, rejected footprints labelled apart', () => {
    it('lists the legal candidates before the rejected-footprint samples and labels those samples', () => {
      // A player's furnace beside the search centre: footprints overlapping it are rejected, the rest are legal.
      const player_furnace = register(chest({ x: -33, y: -34 }, { name: 'stone-furnace', type: 'furnace', unit_number: 31, force: OTHER_FORCE, prototype: { ...FURNACE, type: 'furnace', is_building: true, is_entity_with_owner: true, mineable_properties: { minable: true, mining_time: 0.2, products: [] } } }))
      const result = create_placement_candidate_set(npc(world([player_furnace]), inventory_with(10)), { entity_name: 'stone-furnace', center: { x: -33, y: -34 }, radius: 4, limit: 4 }) as any

      expect(result.ok).toBe(true)
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      expect(result.obstructions.rejected_count).toBeGreaterThan(0)
      const keys = Object.keys(result)
      expect(keys.indexOf('candidates')).toBeGreaterThan(-1)
      expect(keys.indexOf('candidates')).toBeLessThan(keys.indexOf('obstructions'))
      expect(result.obstructions.label).toBe('rejected_footprint_samples_not_candidates')
      expect(result.obstructions.samples[0].entities[0]).toMatchObject({ name: 'stone-furnace' })
      for (const candidate of result.candidates) {
        expect(candidate.id).toMatch(/^candidate-\d+$/)
        const box = candidate.footprint.world_box
        expect(inside(box, { x: -33, y: -34 })).toBe(false)
      }
    })
  })

  describe('anchor ranking', () => {
    it('ranks candidates by distance to the anchor entity and reports it', () => {
      const anchor = register(chest({ x: -39, y: -30 }, { name: 'stone-furnace', type: 'furnace', unit_number: 31, status: STATUS.working, prototype: { ...FURNACE, type: 'furnace', is_building: true, is_entity_with_owner: true, mineable_properties: { minable: true, mining_time: 0.2, products: [] } } }))
      const actor = npc(world([anchor]), inventory_with(10))
      const anchored = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', center: { x: -33, y: -34 }, radius: 8, limit: 5, anchor: { unit_number: 31 } } as any) as any
      const plain = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', center: { x: -33, y: -34 }, radius: 8, limit: 5 }) as any

      expect(anchored.ok).toBe(true)
      expect(anchored.ordering).toBe('nearest_to_anchor_first')
      expect(anchored.anchor).toMatchObject({ unit_number: 31, entity_name: 'stone-furnace' })
      const distances = anchored.candidates.map((candidate: any) => candidate.distance_from_anchor)
      expect(distances.every((value: unknown) => typeof value === 'number')).toBe(true)
      expect([...distances].sort((left: number, right: number) => left - right)).toEqual(distances)
      for (const candidate of anchored.candidates) expect(candidate.distance_from_anchor).toBeCloseTo(Math.hypot(candidate.position.x + 39, candidate.position.y + 30), 6)
      // With no anchor the existing ordering stands, nearest the search centre.
      expect(plain.ordering).toBe('resource_coverage_then_nearest_to_center')
      expect(plain.candidates[0].distance_from_anchor).toBeUndefined()
      expect(anchored.candidates[0].position).not.toEqual(plain.candidates[0].position)
    })

    it('searches around the anchor when no centre is given, however far the actor is', () => {
      const anchor = register(chest({ x: -18, y: -37 }, { name: 'stone-furnace', type: 'furnace', unit_number: 31, prototype: { ...FURNACE, type: 'furnace', is_building: true, is_entity_with_owner: true, mineable_properties: { minable: true, mining_time: 0.2, products: [] } } }))
      const actor = npc(world([anchor]), inventory_with(10))
      const result = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', radius: 5, limit: 3, anchor: { unit_number: 31 } } as any) as any

      expect(result.ok).toBe(true)
      expect(result.center).toEqual({ x: -18, y: -37 })
      for (const candidate of result.candidates) expect(candidate.distance_from_anchor).toBeLessThan(9)
    })

    it('refuses an anchor that is not an entity on the actor surface and force', () => {
      const actor = npc(world([]), inventory_with(10))
      expect(create_placement_candidate_set(actor, request({ anchor: { unit_number: 999 } })))
        .toMatchObject({ ok: false, code: 'anchor_entity_not_found' })
      expect(create_placement_candidate_set(actor, request({ anchor: { unit_number: 0 } })))
        .toMatchObject({ ok: false, code: 'invalid_anchor' })
    })

    it('never offers to clear the anchor itself, though the same idle entity is clearable without it', () => {
      const idle = register(chest(SPOT, { unit_number: 31 }))
      const actor = npc(world([idle]), inventory_with(10))
      const anchored = create_placement_candidate_set(actor, request({ anchor: { unit_number: 31 } })) as any
      const plain = create_placement_candidate_set(actor, request()) as any

      expect(anchored.returned_candidate_count).toBe(0)
      expect(plain.returned_candidate_count).toBeGreaterThan(0)
      expect(plain.candidates[0].clears).toMatchObject([{ name: 'wooden-chest', unit_number: 31, reason: 'own_idle_entity' }])
    })
  })

  describe('which footprint blockers count as clearable', () => {
    function candidates_over(blockers: any[]) {
      register(...blockers)
      return create_placement_candidate_set(npc(world(blockers), inventory_with(10)), request()) as any
    }

    it('treats a tree as a clearable natural obstruction and names it', () => {
      const result = candidates_over([tree(SPOT)])
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      for (const candidate of result.candidates) {
        expect(candidate.clears).toMatchObject([{ name: 'tree-01', type: 'tree', reason: 'natural_obstruction', position: SPOT }])
      }
    })

    it('treats a rock (a simple entity the engine flags is_building) as clearable by its prototype data', () => {
      const result = candidates_over([rock(SPOT)])
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      expect(result.candidates[0].clears).toMatchObject([{ name: 'rock-big', type: 'simple-entity', reason: 'natural_obstruction' }])
    })

    it('treats the NPC\'s own idle entity as clearable', () => {
      const result = candidates_over([chest(SPOT)])
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      expect(result.candidates[0].clears).toMatchObject([{ name: 'wooden-chest', reason: 'own_idle_entity' }])
    })

    it('still lists ground items and the entities to clear together', () => {
      const result = candidates_over([tree(SPOT), ground_item('copper-ore', 1, { x: -33.2, y: -35.2 })])
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      expect(result.candidates[0].ground_items).toMatchObject([{ name: 'copper-ore', count: 1 }])
      expect(result.candidates[0].clears).toMatchObject([{ name: 'tree-01' }])
    })

    it.each([
      ['a player building on another force', () => chest(SPOT, { force: OTHER_FORCE })],
      ['a same-force building a human built or configured', () => chest(SPOT, { last_user: { valid: true, name: 'owner', index: 5 } })],
      ['a cliff, which hand mining cannot remove', () => cliff(SPOT)],
      ['an own entity that is working', () => chest(SPOT, { status: STATUS.working })],
      ['an own entity holding items', () => chest(SPOT, { get_inventory: () => ({ is_empty: () => false }) })],
      ['an own entity connected to fluid', () => chest(SPOT, { fluidbox: Object.assign([undefined], { get_connections: () => [{ valid: true }] }) })],
      ['an own entity that drops onto another', () => chest(SPOT, { drop_target: { valid: true } })],
      ['an own entity that picks up from another', () => chest(SPOT, { pickup_target: { valid: true } })],
      ['an own entity wired to a pole', () => chest(SPOT, { neighbours: { copper: [{ valid: true }] } })],
      ['an own belt with a neighbour', () => chest(SPOT, { belt_neighbours: { inputs: [{ valid: true }], outputs: [] } })],
    ])('keeps %s blocked', (_label, make) => {
      const result = candidates_over([make()])
      expect(result.returned_candidate_count).toBe(0)
      expect(result.obstructions.rejected_count).toBeGreaterThan(0)
    })

    it('keeps an own entity blocked while another machine feeds or drains it', () => {
      const target = chest(SPOT)
      const drill = chest({ x: -36, y: -35.5 }, { name: 'burner-mining-drill', type: 'mining-drill', drop_target: target })
      const result = candidates_over([target, drill])
      expect(result.returned_candidate_count).toBe(0)
    })

    it('keeps the whole footprint blocked when any one blocker is not clearable', () => {
      const result = candidates_over([tree(SPOT), chest({ x: -33.2, y: -35.2 }, { force: OTHER_FORCE })])
      expect(result.returned_candidate_count).toBe(0)
    })

    // A pole needs the engine's own prototype fields for its supply area and wire reach.
    function pole(position: Pos, fields: Record<string, any> = {}) {
      const result = chest(position, { name: 'small-electric-pole', type: 'electric-pole', neighbours: { copper: [] }, ...fields })
      result.prototype = { ...result.prototype, type: 'electric-pole', supply_area_distance: 2.5, max_wire_distance: 7.5 }
      return result
    }
    // Something a pole could supply: it carries an electric energy source and does not collide with the footprint.
    function consumer(position: Pos) {
      return chest(position, { name: 'lab', type: 'lab', prototype: { type: 'lab', is_building: true, is_entity_with_owner: true, items_to_place_this: [{ name: 'lab', count: 1 }],
        collision_mask: { layers: { ground_tile: true } }, electric_energy_source_prototype: {}, mineable_properties: { minable: true, mining_time: 0.2, products: [] } } })
    }

    it('keeps a lone pole clearable only while nothing stands in its supply area', () => {
      const alone = candidates_over([pole(SPOT)])
      expect(alone.returned_candidate_count).toBeGreaterThan(0)
      expect(alone.candidates[0].clears).toMatchObject([{ name: 'small-electric-pole', reason: 'own_idle_entity' }])
      const supplying = candidates_over([pole(SPOT), consumer({ x: SPOT.x + 2.2, y: SPOT.y })])
      expect(supplying.returned_candidate_count).toBe(0)
    })

    it.each([
      ['a solar panel or accumulator on an electric network', () => chest(SPOT, { electric_network_id: 5 })],
      ['a consumer a pole covers', () => chest(SPOT, { electric_network_id: 9 })],
    ])('keeps %s blocked', (_label, make) => {
      expect(candidates_over([make()]).returned_candidate_count).toBe(0)
    })

    it('treats an unreadable last user as a player\'s work and never clears it', () => {
      const unreadable = chest(SPOT)
      Object.defineProperty(unreadable, 'last_user', { get() { throw new Error('last_user is not readable here') } })
      expect(candidates_over([unreadable]).returned_candidate_count).toBe(0)
    })

    it('keeps a neutral entity that holds items blocked, like an own one', () => {
      const holder = tree(SPOT)
      holder.get_max_inventory_index = () => 1
      holder.get_inventory = () => ({ is_empty: () => false })
      expect(candidates_over([holder]).returned_candidate_count).toBe(0)
    })

    it('fails closed when the neighbour scan fills its bound, since the entity that feeds this one may lie beyond it', () => {
      const crowd = Array.from({ length: 70 }, (_unused, index) => chest({ x: SPOT.x + 2.9, y: SPOT.y - 1 + index * 0.02 }, {
        name: 'filler', prototype: { type: 'container', is_building: true, is_entity_with_owner: true, items_to_place_this: [], collision_mask: { layers: { ground_tile: true } }, mineable_properties: { minable: false } },
      }))
      expect(candidates_over([chest(SPOT), ...crowd]).returned_candidate_count).toBe(0)
    })

    it('evaluates an entity once per request however many footprints touch it', () => {
      const idle = chest(SPOT)
      const reads = vi.fn(() => 1)
      idle.get_max_inventory_index = reads
      const result = candidates_over([idle])
      expect(result.returned_candidate_count).toBeGreaterThan(0)
      expect(result.legal_candidate_count).toBeGreaterThan(1)
      expect(reads).toHaveBeenCalledTimes(1)
    })

    it('does not check clearance for footprints the request\'s own covers filter drops', () => {
      const blockers = [chest({ x: -20, y: -20 })]
      register(...blockers)
      const surface = world(blockers)
      const actor = npc(surface, inventory_with(10))
      const result = create_placement_candidate_set(actor, request({ center: { x: -20, y: -20 }, radius: 2 })) as any
      // Every footprint in this window is dropped by covers_position, so none is probed or sampled.
      expect(result.obstructions.clearance_probes).toBe(0)
      expect(result.obstructions.rejected_count).toBe(0)
    })

    it('ranks a footprint that clears nothing ahead of one that clears something, anchor or not', () => {
      const base = { id: '', direction: 0, distance_from_center: 1, footprint: {} as any }
      const near_clearing: any = { ...base, position: { x: 1, y: 1 }, clears: [{ name: 'wooden-chest', type: 'container', position: { x: 1, y: 1 }, reason: 'own_idle_entity' }] }
      const far_clean: any = { ...base, position: { x: 9, y: 9 }, distance_from_center: 9 }
      const grounded: any = { ...base, position: { x: 5, y: 5 }, distance_from_center: 5, ground_items: [{ name: 'copper-ore', count: 1, position: { x: 5, y: 5 } }] }
      const plain: any = { ...base, position: { x: 5, y: 7 }, distance_from_center: 5 }
      for (const anchor of [undefined, { x: 1, y: 1 }]) {
        const values = [near_clearing, far_clean]
        sort_candidates(values, undefined, undefined, anchor)
        expect(values[0]).toBe(far_clean)
      }
      // At equal distance, fewer ground items first.
      const tied = [grounded, plain]
      sort_candidates(tied)
      expect(tied[0]).toBe(plain)
    })

    it('keeps terrain that collides blocked even when the entities in it are clearable', () => {
      const blockers = [tree(SPOT)]
      const surface = world(blockers)
      surface.get_tile = () => ({ name: 'water', collides_with: (layer: string) => layer === 'object' })
      const result = create_placement_candidate_set(npc(surface, inventory_with(10)), request()) as any
      expect(result.returned_candidate_count).toBe(0)
    })
  })

  describe('placing over clearable entities', () => {
    function build(blockers: any[], slots = 10, position: Pos = { x: -33, y: -37 }) {
      const inventory = inventory_with(slots)
      for (const blocker of blockers) if (blocker.type !== 'item-entity') mineable(blocker)
      register(...blockers)
      const surface = world(blockers)
      surface.create_entity = vi.fn((args: any) => ({ valid: true, name: args.name, type: 'furnace', unit_number: 21, position: args.position, direction: 0, surface, force: { index: 1 } }))
      const actor = npc(surface, inventory, position)
      const manager = new_task_manager(() => actor)
      const controller = new_basic_operation_controller(() => actor, manager)
      const runtime = new_basic_operation_runtime(manager, controller)
      return { actor, inventory, surface, manager, controller, runtime }
    }

    it('waits the native mining time, then mines the tree into the inventory and builds', () => {
      const wood = tree(SPOT)
      const { actor, inventory, surface, controller, runtime } = build([wood])
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)

      runtime.state_placing(actor)
      expect(wood.mine).not.toHaveBeenCalled()
      expect(surface.create_entity).not.toHaveBeenCalled()
      // 0.55 s of mining at speed 0.5 is 66 ticks.
      ;(globalThis as any).game.tick = 100 + 65
      runtime.state_placing(actor)
      expect(wood.mine).not.toHaveBeenCalled()
      ;(globalThis as any).game.tick = 100 + 66
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(true)
      expect(wood.mine).toHaveBeenCalledTimes(1)
      expect(wood.mine.mock.calls[0][0]).toMatchObject({ inventory, force: false })
      expect(inventory.held.wood).toBe(4)
      expect(surface.create_entity).toHaveBeenCalledTimes(1)
      expect(controller.status().last_result).toMatchObject({
        code: 'completed',
        placed_unit_number: 21,
        entities_cleared: [{ name: 'tree-01', type: 'tree', reason: 'natural_obstruction', position: SPOT, items: [{ name: 'wood', count: 4 }] }],
      })
    })

    it('clears the NPC\'s own idle entity the same way and reports it', () => {
      const own = chest(SPOT)
      const { actor, inventory, controller, runtime } = build([own])
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      ;(globalThis as any).game.tick = 100 + 1000
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(true)
      expect(inventory.held['wooden-chest']).toBe(1)
      expect(controller.status().last_result).toMatchObject({
        code: 'completed',
        entities_cleared: [{ name: 'wooden-chest', reason: 'own_idle_entity', items: [{ name: 'wooden-chest', count: 1 }] }],
      })
    })

    it('refuses with a clear code, before any mutation, when the inventory cannot take the products', () => {
      const wood = tree(SPOT)
      const { actor, surface, controller, runtime, manager } = build([wood], 2)
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(false)
      expect(wood.mine).not.toHaveBeenCalled()
      expect(wood.valid).toBe(true)
      expect(surface.create_entity).not.toHaveBeenCalled()
      expect(controller.status().last_result).toMatchObject({ code: 'clearing_inventory_full', clearing_left: { name: 'tree-01', unit_number: wood.unit_number } })
      expect(controller.status().last_result?.entities_cleared).toBeUndefined()
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_inventory_full', expect.objectContaining({ failed_before_mutation: true }))
    })

    it('reports what was cleared when a later blocker cannot be, and gives no proof of no mutation', () => {
      const first = tree({ x: -33.2, y: -35.2 })
      const second = tree({ x: -33.8, y: -35.8 })
      const { actor, controller, runtime, manager } = build([first, second])
      second.mine = vi.fn(() => false)
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      ;(globalThis as any).game.tick = 100 + 1000
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(false)
      expect(controller.status().last_result).toMatchObject({
        code: 'clearing_failed',
        entities_cleared: [{ name: 'tree-01', unit_number: first.unit_number }],
        clearing_left: { unit_number: second.unit_number },
      })
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_failed', expect.objectContaining({ failed_before_mutation: false }))
    })

    it('refuses before mining when the blockers together do not fit, though each would fit alone', () => {
      const first = tree({ x: -33.2, y: -35.2 })
      const second = tree({ x: -33.8, y: -35.8 })
      const { actor, controller, runtime, manager } = build([first, second], 4)
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(false)
      expect(first.mine).not.toHaveBeenCalled()
      expect(second.mine).not.toHaveBeenCalled()
      expect(controller.status().last_result).toMatchObject({ code: 'clearing_inventory_full' })
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_inventory_full', expect.objectContaining({ failed_before_mutation: true }))
    })

    it('counts every product of a blocker and the ground items in the room it needs', () => {
      const rubble = rock(SPOT)
      rubble.prototype.mineable_properties.products = [{ type: 'item', name: 'stone', amount: 5 }, { type: 'item', name: 'coal', amount: 5 }]
      const { actor, controller, runtime } = build([rubble], 6)
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      expect(runtime.state_placing(actor)?.[0]).toBe(false)
      expect(rubble.mine).not.toHaveBeenCalled()
      expect(controller.status().last_result).toMatchObject({ code: 'clearing_inventory_full' })

      const wood = tree(SPOT)
      const ore = ground_item('copper-ore', 3, { x: -33.2, y: -35.2 })
      const second = build([wood, ore], 5)
      expect(second.controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      expect(second.runtime.state_placing(second.actor)?.[0]).toBe(false)
      expect(wood.mine).not.toHaveBeenCalled()
      expect(ore.valid).toBe(true)
      expect(second.controller.status().last_result).toMatchObject({ code: 'clearing_inventory_full' })
    })

    it('leaves the inventory exactly as it was after the room check', () => {
      const wood = tree(SPOT)
      const { actor, inventory, controller, runtime } = build([wood], 10)
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      expect(inventory.held.wood ?? 0).toBe(0)
      expect(inventory.get_item_count('stone-furnace')).toBe(1)
    })

    it('records what a failed mine call changed: items that arrived although it returned false', () => {
      const wood = tree(SPOT)
      const { actor, inventory, controller, runtime, manager } = build([wood])
      wood.mine = vi.fn(({ inventory: target }: any) => { target.insert({ name: 'wood', count: 2 }); return false })
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      ;(globalThis as any).game.tick = 100 + 1000
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(false)
      expect(inventory.held.wood).toBe(2)
      expect(controller.status().last_result).toMatchObject({ code: 'clearing_failed', entities_cleared: [{ name: 'tree-01', items: [{ name: 'wood', count: 2 }] }] })
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_failed', expect.objectContaining({ failed_before_mutation: false }))
    })

    it('records an entity the engine destroyed although the mine call returned false', () => {
      const wood = tree(SPOT)
      const { actor, controller, runtime, manager } = build([wood])
      wood.mine = vi.fn(() => { wood.valid = false; return false })
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      ;(globalThis as any).game.tick = 100 + 1000
      runtime.state_placing(actor)

      expect(controller.status().last_result).toMatchObject({ code: 'clearing_failed', entities_cleared: [{ name: 'tree-01', items: [] }] })
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_failed', expect.objectContaining({ failed_before_mutation: false }))
    })

    it('keeps the no-mutation proof when a failed mine call changed nothing', () => {
      const wood = tree(SPOT)
      const { actor, controller, runtime, manager } = build([wood])
      wood.mine = vi.fn(() => false)
      const cancelled = vi.spyOn(manager, 'cancel_all_tasks')
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)
      ;(globalThis as any).game.tick = 100 + 1000
      runtime.state_placing(actor)

      expect(controller.status().last_result).toMatchObject({ code: 'clearing_failed' })
      expect(controller.status().last_result?.entities_cleared).toBeUndefined()
      expect(cancelled).toHaveBeenCalledWith('placing:clearing_failed', expect.objectContaining({ failed_before_mutation: true }))
    })

    it('walks within mining reach of a blocker first, then resumes the same placement', () => {
      const wood = tree(SPOT)
      // Within build reach of the spot but beyond hand-mining reach of the tree.
      const { actor, controller, runtime, manager } = build([wood], 10, { x: -33, y: -43 })
      expect(controller.submit_placement('stone-furnace', -34, -36, 0)).toBe(true)
      runtime.state_placing(actor)

      expect(manager.player_state.task_state).toBe('walking_to_entity')
      expect(wood.mine).not.toHaveBeenCalled()
      expect(manager.player_state.parameters_walk_to_entity?.requested_position).toEqual(SPOT)
    })

    it('does not clear what became unclearable after the candidate was read', () => {
      const own = chest(SPOT)
      const { actor, surface, controller, runtime } = build([own])
      const generated = create_placement_candidate_set(actor, request({ limit: 1 })) as any
      expect(generated.returned_candidate_count).toBe(1)
      own.status = STATUS.working
      const submit = vi.fn(() => true)

      expect(execute_placement_candidate(actor, generated.candidate_set_id, generated.candidates[0].id, submit)).toEqual([false, 'placement candidate is no longer placeable'])
      expect(submit).not.toHaveBeenCalled()
      expect(own.mine).not.toHaveBeenCalled()
      void surface; void controller; void runtime
    })

    it('hands the anchor to the placement so it can never be cleared there either', () => {
      const anchor = chest({ x: -30, y: -30 }, { unit_number: 31 })
      const { actor } = build([anchor])
      const generated = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', center: { x: -33, y: -34 }, radius: 3, limit: 1, anchor: { unit_number: 31 } } as any) as any
      const submit = vi.fn(() => true)

      expect(execute_placement_candidate(actor, generated.candidate_set_id, generated.candidates[0].id, submit)[0]).toBe(true)
      expect(submit).toHaveBeenCalledWith('stone-furnace', generated.candidates[0].position.x, generated.candidates[0].position.y, generated.candidates[0].direction, undefined, [31])
    })

    it('never clears the anchor even when a raw placement lands on it', () => {
      const anchor = chest(SPOT, { unit_number: 31 })
      const { actor, controller, runtime, surface } = build([anchor])
      expect(controller.submit_placement('stone-furnace', -34, -36, 0, undefined, [31])).toBe(true)
      const result = runtime.state_placing(actor)

      expect(result?.[0]).toBe(false)
      expect(anchor.mine).not.toHaveBeenCalled()
      expect(surface.create_entity).not.toHaveBeenCalled()
      expect(controller.status().last_result).toMatchObject({ code: 'not_placeable' })
    })
  })
})
