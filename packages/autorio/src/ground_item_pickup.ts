import type { ControlledActor } from './actors/types'
import type { GroundItem } from './placement_ground_items'
import { describe_ground_item, ground_item_entities, MAX_GROUND_ITEMS } from './placement_ground_items'

// External harness only (the internal planner catalog does not list it): picks up the items lying on the ground in a
// small box with the character's native mining, the way a player picks them up, into the actor inventory. Nothing else
// in the box is mined: no tree, rock, building, resource or character (walking to it may still clear a natural obstacle
// on the only path, as every walk does). Placement still never clears; this is the
// separate, explicit operation that empties a footprint of ground items before a placement. The task is the area
// clearing task restricted to item-on-ground entities (area_clearing.ts).

export const MAX_PICKUP_RADIUS = 2
// Items can keep landing in the box (a drill dropping onto the ground); the task stops with a refusal after this many
// pickups instead of chasing a refilling drop tile.
export const MAX_PICKUPS = MAX_GROUND_ITEMS * 2
const MAX_COORDINATE = 1000000

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

/** The square box centred on (x, y): radius 0 is the one tile around the point, radius 2 is 5x5 tiles. */
export function pickup_box(x: number, y: number, radius: number): Box {
  const half = radius + 0.5
  return { left_top: { x: x - half, y: y - half }, right_bottom: { x: x + half, y: y + half } }
}

function position_inside(position: { x: number, y: number }, box: Box) {
  return position.x >= box.left_top.x && position.x <= box.right_bottom.x
    && position.y >= box.left_top.y && position.y <= box.right_bottom.y
}

export function pickup_args_refusal(x: unknown, y: unknown, radius: unknown): string | undefined {
  for (const value of [x, y]) {
    if (typeof value !== 'number' || value !== value || value < -MAX_COORDINATE || value > MAX_COORDINATE) return 'x'
  }
  if (typeof radius !== 'number' || radius !== math.floor(radius) || radius < 0 || radius > MAX_PICKUP_RADIUS) return 'radius'
  return undefined
}

/**
 * Read-only. Lists the ground items in the box (vision-safe read, at most MAX_GROUND_ITEMS) and refuses when there are
 * none, too many, or a stack that the actor inventory cannot take now. The task re-reads the box when it runs.
 */
export function ground_item_pickup_preflight(actor: ControlledActor | undefined, args: { x?: unknown, y?: unknown, radius?: unknown }) {
  const reject = (code: string, details: Record<string, unknown> = {}) => ({ ok: false, code, operation: 'pick_up_ground_items', ...details })
  if (!actor || !actor.is_valid || !actor.character) return reject('no_actor')
  const radius = args.radius ?? 0
  const field = pickup_args_refusal(args.x, args.y, radius)
  if (field) return reject('invalid_pickup_args', { field })
  const box = pickup_box(args.x as number, args.y as number, radius as number)
  const entities = ground_item_entities(actor, box)
  if (entities.length > MAX_GROUND_ITEMS) return reject('ground_items_over_limit', { limit: MAX_GROUND_ITEMS })
  const items: GroundItem[] = []
  for (const entity of entities) {
    // Same rule as the task: an item counts only when its position is inside the box, not when its box just overlaps.
    if (!position_inside(entity.position, box)) continue
    const item = describe_ground_item(entity)
    if (item) items.push(item)
  }
  if (items.length === 0) return reject('no_ground_items', { box })
  const inventory = actor.get_main_inventory()
  if (!inventory) return reject('no_actor')
  for (const item of items) {
    const stack = { name: item.name, count: item.count, ...(item.quality ? { quality: item.quality } : {}) }
    // The whole stack must fit; can_insert is true when only part of it does.
    if (inventory.get_insertable_count(stack as any) < item.count) return reject('inventory_full', { item })
  }
  return { ok: true, operation: 'pick_up_ground_items', box, items }
}
