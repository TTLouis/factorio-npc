import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { create_placement_candidate_set, execute_placement_candidate } from './placement_candidates'
import { placement_footprint } from './placement_geometry'
import { ground_item_blockers } from './placement_ground_items'
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
    expect(ground_item_blockers(npc(surface, inventory_with(10)), FURNACE, 'offshore-pump', { x: -34, y: -36 }, 0)).toBeUndefined()
    expect(ground_item_blockers(npc(surface, inventory_with(10)), FURNACE, 'stone-furnace', { x: -34, y: -36 }, 0)).toHaveLength(1)
  })
})
