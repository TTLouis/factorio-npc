import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { clearable_construction_blocker } from './area_clearing'
import { protected_read } from './electric_facts'
import { entity_last_user } from './entity_provenance'
import { record_hand_mined_item } from './hand_work'
import { is_placed_building_entity } from './mining_reach'
import { find_world_entities } from './npc_vision'
import { placement_check_args, placement_footprint } from './placement_geometry'
import { colliding_entities, collision_layers, terrain_collisions } from './placement_obstructions'
import { describe_ground_item, ground_item_entities, MAX_GROUND_ITEMS, type GroundItem } from './placement_ground_items'

// The one place that decides which collisions a build may clear instead of
// reporting the footprint blocked. Placement candidates, candidate revalidation
// and the placement itself all ask here, so they cannot disagree. Every answer
// comes from engine data (prototype type, mineable properties, force, last
// user, live links), never from entity names.
//
// A footprint is clearable when the native check refuses it for these reasons
// only, each blocker is one of
//   - a ground item (item-entity): picked up, as a player's build does;
//   - a natural obstruction: a neutral-force entity a hand can mine that is not
//     a placed building (trees; rocks, which the engine flags is_building but
//     which have no owner and no placing item). Cliffs are not minable, so they
//     stay blocked;
//   - the NPC's own idle entity: a placed building on the actor force that no
//     human built or configured (last_user is empty, per entity_provenance), is
//     hand-minable, and is not part of a running machine chain (see
//     running_chain_reason);
// no blocker is protected (the anchor a candidate request names, the entity a
// join must reach), the terrain under the footprint does not collide, and the
// whole footprint holds at most MAX_CLEARED_ENTITIES entities to clear. A player's
// building (another force, or a human last_user) is never clearable.

export const MAX_CLEARED_ENTITIES = 8
const MAX_CHAIN_INVENTORIES = 16
const MAX_CHAIN_NEIGHBOUR_SEARCH = 3

export type ClearReason = 'natural_obstruction' | 'own_idle_entity'

export interface ClearableEntity {
  name: string
  type: string
  unit_number?: number
  position: { x: number, y: number }
  reason: ClearReason
}

export interface ClearedEntity extends ClearableEntity {
  // What the inventory measured it gained from mining this entity.
  items: Array<{ name: string, count: number }>
}

export interface ClearBlocker {
  entity: LuaEntity
  info: ClearableEntity
}

export interface PlacementClearance {
  ground_items: GroundItem[]
  blockers: ClearBlocker[]
}

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

// A link is anything a reader can see attached: a single entity, or a non-empty
// list or record of them (poles list their wire neighbours by colour, belts their
// inputs and outputs).
function has_links(value: unknown, depth: number = 0): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'object') return true
  if (depth >= 2) return true
  for (const [, item] of pairs(value as Record<string, unknown>)) {
    if (has_links(item, depth + 1)) return true
  }
  return false
}

function neighbours_targeting(entity: LuaEntity, surface: ControlledActor['surface']) {
  const box: Box = protected_read(() => entity.bounding_box) ?? { left_top: entity.position, right_bottom: entity.position }
  const area: Box = {
    left_top: { x: box.left_top.x - MAX_CHAIN_NEIGHBOUR_SEARCH, y: box.left_top.y - MAX_CHAIN_NEIGHBOUR_SEARCH },
    right_bottom: { x: box.right_bottom.x + MAX_CHAIN_NEIGHBOUR_SEARCH, y: box.right_bottom.y + MAX_CHAIN_NEIGHBOUR_SEARCH },
  }
  const nearby = protected_read(() => find_world_entities(surface, { area, limit: 64 })) ?? []
  for (const other of nearby) {
    if (!other.valid || other === entity) continue
    if (protected_read(() => other.drop_target) === entity || protected_read(() => other.pickup_target) === entity) return true
  }
  return false
}

/**
 * Why an entity counts as part of a running machine chain, or undefined when it
 * is idle and standing alone. This is a conservative, data-driven reading of the
 * live entity, not a production model: it is a chain member when it is working,
 * holds anything (items, fuel, ingredients, fluid), is linked to another entity
 * (fluid connection, a drop or pickup target of its own, a wire or belt
 * neighbour), or another entity drops into it or picks from it. Anything that
 * cannot be read counts as idle only if every other read says so.
 */
export function running_chain_reason(entity: LuaEntity, surface: ControlledActor['surface']): string | undefined {
  const status = protected_read(() => entity.status)
  if (status !== undefined && status === defines.entity_status.working) return 'working'
  const max_inventory = protected_read(() => entity.get_max_inventory_index()) ?? 0
  for (let index = 1; index <= math.min(max_inventory, MAX_CHAIN_INVENTORIES); index++) {
    const inventory = protected_read(() => entity.get_inventory(index))
    if (inventory !== undefined && protected_read(() => inventory.is_empty()) === false) return 'holds_items'
  }
  const fluidbox = protected_read(() => entity.fluidbox)
  if (fluidbox !== undefined) {
    for (let index = 0; index < fluidbox.length; index++) {
      if (protected_read(() => fluidbox[index]) !== undefined) return 'holds_fluid'
      if (has_links(protected_read(() => fluidbox.get_connections(index + 1)))) return 'fluid_connected'
    }
  }
  if (protected_read(() => entity.drop_target) !== undefined) return 'drops_onto_entity'
  if (protected_read(() => entity.pickup_target) !== undefined) return 'picks_from_entity'
  if (has_links(protected_read(() => entity.neighbours))) return 'neighbour_linked'
  if (has_links(protected_read(() => entity.belt_neighbours))) return 'belt_linked'
  if (neighbours_targeting(entity, surface)) return 'fed_or_drained_by_entity'
  return undefined
}

/** How a build may clear this one colliding entity, or undefined when it may not. */
export function blocker_clearance(actor: ControlledActor, entity: LuaEntity, protect: number[] = []): ClearReason | undefined {
  if (!entity.valid) return undefined
  if (entity.unit_number !== undefined && protect.includes(entity.unit_number)) return undefined
  const force = protected_read(() => entity.force)
  if (!force) return undefined
  if (force.name === 'neutral') return clearable_construction_blocker(entity) ? 'natural_obstruction' : undefined
  if (force.index !== actor.force.index) return undefined
  if (!is_placed_building_entity(entity) || entity.minable !== true) return undefined
  if (protected_read(() => entity.prototype.mineable_properties.minable) !== true) return undefined
  if (entity_last_user(entity) !== undefined) return undefined
  if (running_chain_reason(entity, actor.surface) !== undefined) return undefined
  return 'own_idle_entity'
}

function describe_blocker(entity: LuaEntity, reason: ClearReason): ClearableEntity {
  return { name: entity.name, type: entity.type, unit_number: entity.unit_number, position: { x: entity.position.x, y: entity.position.y }, reason }
}

/**
 * What a build over this footprint would clear: its ground items and the
 * entities to mine, or undefined when the footprint is not clearable (it is
 * refused for another reason, a blocker is not clearable, tile-rule entities
 * keep their strict manual check, or nothing collides so there is nothing to
 * clear). Call it only for a footprint the native check refused.
 */
export function placement_clearance(actor: ControlledActor, prototype: any, entity_name: string, position: { x: number, y: number }, direction: number | undefined, protect: number[] = []): PlacementClearance | undefined {
  if (placement_check_args(entity_name).build_check_type !== undefined) return undefined
  const layers = collision_layers(prototype)
  if (layers === undefined) return undefined
  const footprint = placement_footprint(prototype, position, direction)
  const found = colliding_entities(actor, layers, footprint)
  if (found.unknown || found.truncated || found.entities.length === 0) return undefined
  const blockers: ClearBlocker[] = []
  let items = 0
  for (const entity of found.entities) {
    if (entity.type === 'item-entity') {
      if (++items > MAX_GROUND_ITEMS) return undefined
      continue
    }
    const reason = blocker_clearance(actor, entity, protect)
    if (reason === undefined || blockers.length >= MAX_CLEARED_ENTITIES) return undefined
    blockers.push({ entity, info: describe_blocker(entity, reason) })
  }
  const terrain = terrain_collisions(actor, layers, footprint)
  if (terrain.unknown || terrain.truncated || terrain.collisions > 0) return undefined
  const ground_items: GroundItem[] = []
  if (items > 0) {
    for (const entity of ground_item_entities(actor, footprint.world_box)) {
      if (!entity.valid) continue
      const item = describe_ground_item(entity)
      if (item) ground_items.push(item)
    }
    if (ground_items.length === 0 && blockers.length === 0) return undefined
  }
  return { ground_items, blockers }
}

/** True when the native check accepts the footprint, or would once its clearable blockers are cleared. */
export function placeable_or_clearable(actor: ControlledActor, prototype: any, entity_name: string, position: { x: number, y: number }, direction: number | undefined, protect: number[] = []) {
  if (actor.surface.can_place_entity({ name: entity_name, position, direction, force: actor.force, ...placement_check_args(entity_name) })) return true
  return placement_clearance(actor, prototype, entity_name, position, direction, protect) !== undefined
}

/**
 * Hand-mining ticks for this entity at the actor's mining speed, from the
 * prototype's mining time, or undefined when the rate cannot be read. The build
 * waits this long before the native mine call, as pump preparation does.
 */
export function clearing_mining_ticks(actor: ControlledActor, entity: LuaEntity): number | undefined {
  const character = actor.character
  const base = character?.prototype.mining_speed ?? 0
  const speed = base * (1 + (character?.character_mining_speed_modifier ?? 0) + actor.force.manual_mining_speed_modifier)
  const time = protected_read(() => entity.prototype.mineable_properties.mining_time)
  if (time === undefined || !(speed > 0) || !(time >= 0)) return undefined
  return math.ceil(time / speed * 60)
}

function mining_products(entity: LuaEntity) {
  const result: Array<{ name: string, count: number }> = []
  const products = protected_read(() => entity.prototype.mineable_properties.products) ?? []
  for (const product of products) {
    if (product.type !== 'item') continue
    const count = product.amount ?? product.amount_max ?? 1
    result.push({ name: product.name, count })
  }
  return result
}

/** True when the inventory can take everything this entity yields when mined (the most a random yield can give). */
export function mining_products_fit(inventory: LuaInventory, entity: LuaEntity) {
  for (const product of mining_products(entity)) {
    if (!inventory.can_insert({ name: product.name, count: product.count })) return false
  }
  return true
}

/**
 * Mines one blocker into the actor inventory with the native mine call and
 * measures what the inventory gained. inventory_full: nothing was mined because
 * the products do not fit. failed: the engine refused, or the entity remained.
 */
export function clear_blocker(actor: ControlledActor, inventory: LuaInventory, blocker: ClearBlocker) {
  if (!mining_products_fit(inventory, blocker.entity)) return { ok: false as const, code: 'clearing_inventory_full' as const }
  const names: Record<string, number> = {}
  for (const product of mining_products(blocker.entity)) names[product.name] = inventory.get_item_count(product.name)
  const mined = blocker.entity.mine({ inventory, force: false })
  if (!mined || blocker.entity.valid) return { ok: false as const, code: 'clearing_failed' as const }
  const items: Array<{ name: string, count: number }> = []
  for (const [name, before] of pairs(names)) {
    const gained = inventory.get_item_count(name) - before
    if (gained > 0) {
      items.push({ name, count: gained })
      record_hand_mined_item(actor.force.index, name)
    }
  }
  const cleared: ClearedEntity = { ...blocker.info, items }
  return { ok: true as const, cleared }
}
