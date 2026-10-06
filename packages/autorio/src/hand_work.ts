// When the NPC (or a player on its force) last did by hand what a machine is
// supposed to do: mining an entity that yields an item, crafting an item, or
// putting anything but fuel into an entity.
//
// Why: `production_rate` goals (plan 3.7, W3) must measure automated output.
// On Factorio 2.0.77 the force item production statistics DO count ore the
// player-less NPC character mines by hand (measured in
// tests/factorio steam_power_cell.py), and plates smelted from ore the NPC
// hand-fed into a furnace are machine output in the statistics even though the
// NPC did the feeding (burner canary attempts 4 and 5). The statistics cannot
// tell those apart from a working factory, so the rate window is VOID while any
// of this hand work falls inside it: the goal can only be met by a window in
// which the factory ran on its own.
//
// A hand-fed machine keeps producing long after the insert: a stone furnace
// given 50 ore smelts for about 160 s. The 1.1x window rule alone would then
// read that output as automated after a minute or so. So the machine that was
// hand-fed is remembered too (unit number, per force, bounded), and every rate
// window stays void while it still holds an item that was hand-inserted into
// it, checked when the goal is evaluated. Chests are not machines: stocking one
// only voids the window after the insert.
//
// Ticks are kept per force and per item, plus at most MAX_FED_ENTITIES fed
// machines per force, so storage stays bounded and save/load safe (plain
// numbers and strings only).

import type { LuaEntity, LuaSurface, SurfaceIndex } from 'factorio:runtime'
import { note_output_proof_hand_craft, note_output_proof_manual_mutation } from './output_delivery_proof'
import { entity_role_inventories, has_separate_output } from './inventory_roles'
import { find_world_entities } from './npc_vision'

/** Fed machines remembered per force; more than this voids every window for a long while. */
export const MAX_FED_ENTITIES = 64
/** Items remembered per fed machine; beyond it any input item counts. */
const MAX_FED_ITEMS = 8
/** After the fed list overflowed, windows stay void at least this long (20 min). */
const FED_OVERFLOW_HOLD_TICKS = 20 * 3600

interface FedEntity {
  unit_number: number
  surface_index: number
  /** Where the machine stands; it is looked up again by this, see resolve_fed_entity. */
  x: number
  y: number
  entity_name: string
  /** Hand-inserted items still to be found in the machine's input. */
  items: string[]
  /** More items than MAX_FED_ITEMS were inserted: any input item counts. */
  any_item?: boolean
  tick: number
}

interface ForceHandWork {
  /** Last tick the NPC put a non-fuel item into an entity. */
  insert_tick?: number
  insert_item?: string
  insert_entity?: string
  /** Last tick hand mining of an entity yielding the item ended (or was seen). */
  mined_tick?: Record<string, number>
  /** Items whose hand mining is in progress, with the tick it started. */
  mining_active?: Record<string, number>
  /** Last tick a hand craft of the item finished. */
  crafted_tick?: Record<string, number>
  /** Machines hand-fed with non-fuel items whose input may still hold them. */
  fed?: FedEntity[]
  /** Tick the fed list could not take another machine. */
  fed_overflow_tick?: number
  /**
   * Last tick a fed machine was found emptied of hand-fed input (or gone). What
   * it smelted until then is still in the rate windows that follow, so they stay
   * void for a window after it. Found lazily, so it is never earlier than the
   * true drain.
   */
  fed_end_tick?: number
  fed_end_item?: string
  fed_end_entity?: string
}

export interface HandWorkStorage {
  sgluna_hand_work?: Record<number, ForceHandWork>
}

declare const storage: HandWorkStorage

/** Mining a target whose products are unknown voids every item's window. */
export const ANY_ITEM = '*'

// Entities whose inputs never come back out as items: ammunition and science
// packs are consumed there, so loading them is not feeding a production chain.
const NON_PRODUCING_TYPES: Record<string, boolean> = {
  'ammo-turret': true,
  'artillery-turret': true,
  'lab': true,
}

function force_work(force_index: number): ForceHandWork {
  const all = storage.sgluna_hand_work ?? {}
  storage.sgluna_hand_work = all
  const work = all[force_index] ?? {}
  all[force_index] = work
  return work
}

/**
 * The NPC moved `item_name` into `entity`. A move into the entity's fuel
 * inventory is refuelling (allowed); a move into a turret or lab feeds nothing
 * that produces items. Everything else is hand feeding.
 */
export function record_hand_insert(force_index: number, item_name: string, entity_name: string, entity_type: string, into_fuel: boolean, entity?: LuaEntity) {
  note_output_proof_manual_mutation(entity, into_fuel)
  if (into_fuel || NON_PRODUCING_TYPES[entity_type]) return
  const work = force_work(force_index)
  work.insert_tick = game.tick
  work.insert_item = item_name
  work.insert_entity = entity_name
  if (has_separate_output(entity_type) && entity !== undefined && entity.valid) remember_fed_entity(work, entity, item_name)
}

function remember_fed_entity(work: ForceHandWork, entity: LuaEntity, item_name: string) {
  const unit_number = entity.unit_number
  const fed = work.fed ?? []
  work.fed = fed
  // A machine without a unit number cannot be looked up again; the insert
  // window still applies to it.
  if (unit_number === undefined) return
  for (const entry of fed) {
    if (entry.unit_number !== unit_number) continue
    entry.tick = game.tick
    if (!entry.any_item && !entry.items.includes(item_name)) {
      if (entry.items.length >= MAX_FED_ITEMS) entry.any_item = true
      else entry.items.push(item_name)
    }
    return
  }
  if (fed.length >= MAX_FED_ENTITIES) prune_fed(work)
  const remaining = work.fed ?? []
  if (remaining.length >= MAX_FED_ENTITIES) {
    work.fed_overflow_tick = game.tick
    return
  }
  remaining.push({ unit_number, surface_index: entity.surface.index, x: entity.position.x, y: entity.position.y, entity_name: entity.name, items: [item_name], tick: game.tick })
}

/**
 * The fed machine, or undefined when it is gone. game.get_entity_by_unit_number
 * only indexes prototypes flagged for it (furnaces and assemblers are not, engine
 * 2.0.77), so the machine is found again by position, name and unit number, the
 * way entity_reference.ts does.
 */
function resolve_fed_entity(entry: FedEntity): LuaEntity | undefined {
  const surface = game.get_surface(entry.surface_index as SurfaceIndex)
  if (!surface || !surface.valid) return undefined
  for (const candidate of find_world_entities(surface, { position: { x: entry.x, y: entry.y }, radius: 0.25, name: entry.entity_name })) {
    if (candidate.valid && candidate.unit_number === entry.unit_number) return candidate
  }
  return undefined
}

/** Whether the machine's input inventories still hold a hand-inserted item. */
function holds_hand_fed_input(entity: LuaEntity, entry: FedEntity) {
  for (const { inventory, role } of entity_role_inventories(entity)) {
    if (role !== 'input') continue
    for (const item of inventory.get_contents()) {
      if (item.count > 0 && (entry.any_item || entry.items.includes(item.name))) return true
    }
  }
  return false
}

/**
 * Drops machines that are gone or whose hand-fed input is used up; returns the
 * most recently fed one that still holds hand-inserted input.
 */
function prune_fed(work: ForceHandWork) {
  const kept: FedEntity[] = []
  let still_fed: FedEntity | undefined
  for (const entry of work.fed ?? []) {
    const entity = resolve_fed_entity(entry)
    if (entity === undefined || !entity.valid || !holds_hand_fed_input(entity, entry)) {
      work.fed_end_tick = game.tick
      work.fed_end_item = entry.items[0]
      work.fed_end_entity = entry.entity_name
      continue
    }
    kept.push(entry)
    if (still_fed === undefined || entry.tick > still_fed.tick) still_fed = entry
  }
  work.fed = kept
  if (work.fed_overflow_tick !== undefined && kept.length === 0 && game.tick - work.fed_overflow_tick > FED_OVERFLOW_HOLD_TICKS) {
    work.fed_overflow_tick = undefined
  }
  return still_fed
}

export function record_hand_crafted_tick(force_index: number, item_name: string) {
  note_output_proof_hand_craft(force_index, item_name)
  const work = force_work(force_index)
  const crafted = work.crafted_tick ?? {}
  work.crafted_tick = crafted
  crafted[item_name] = game.tick
}

/** A player on the force mined an item by hand (on_player_mined_item). */
export function record_hand_mined_item(force_index: number, item_name: string) {
  const work = force_work(force_index)
  const mined = work.mined_tick ?? {}
  work.mined_tick = mined
  mined[item_name] = game.tick
}

/**
 * Entities the body is mining at `position`: minable entities whose position
 * is within half a tile of it, excluding the body itself. The mining state
 * carries a position, while `selected` may be unset or be a human's cursor
 * entity, so the target is resolved from the position. Empty when none is found.
 */
export function mining_targets_at(surface: LuaSurface, position: { x: number, y: number } | undefined, exclude?: LuaEntity): LuaEntity[] {
  if (!position) return []
  const found = find_world_entities(surface, {
    area: { left_top: { x: position.x - 0.5, y: position.y - 0.5 }, right_bottom: { x: position.x + 0.5, y: position.y + 0.5 } },
  })
  const targets: LuaEntity[] = []
  for (const entity of found) {
    if (!entity.valid || entity === exclude || entity.type === 'character') continue
    if ((entity.position.x - position.x) ** 2 + (entity.position.y - position.y) ** 2 > 0.25) continue
    if (prototypes.entity[entity.name]?.mineable_properties?.minable !== true) continue
    targets.push(entity)
    if (targets.length >= 8) break
  }
  return targets
}

/** Item names mining `entity` (or any of a list) can yield; ANY_ITEM when that is unknown. */
export function mined_item_names(entity: LuaEntity | LuaEntity[] | undefined): string[] {
  if (Array.isArray(entity)) {
    if (entity.length === 0) return [ANY_ITEM]
    const names: string[] = []
    for (const one of entity) {
      for (const name of mined_item_names(one)) if (!names.includes(name)) names.push(name)
    }
    return names
  }
  if (!entity || !entity.valid) return [ANY_ITEM]
  const properties = prototypes.entity[entity.name]?.mineable_properties
  if (!properties) return [ANY_ITEM]
  if (!properties.minable) return []
  const names: string[] = []
  for (const product of properties.products ?? []) {
    if (product.type === 'item') names.push(product.name)
  }
  return names
}

/**
 * The actor's mining state changed. Mining that starts marks every item the
 * target can yield as being hand-mined; mining that stops closes all of them
 * at this tick.
 */
export function note_hand_mining(force_index: number, mining: boolean, target: LuaEntity | LuaEntity[] | undefined) {
  const work = force_work(force_index)
  const active = work.mining_active ?? {}
  work.mining_active = active
  if (mining) {
    for (const name of mined_item_names(target)) {
      if (active[name] === undefined) active[name] = game.tick
    }
    return
  }
  const mined = work.mined_tick ?? {}
  work.mined_tick = mined
  for (const name of Object.keys(active)) {
    mined[name] = game.tick
    delete active[name]
  }
}

export interface HandWorkVoid {
  reason: 'hand_mined' | 'hand_crafted' | 'hand_inserted'
  tick: number
  item_name?: string
  entity_name?: string
}

/**
 * Hand work that makes a measurement of `item_name` since `since_tick` not
 * automated output, or undefined. `actor_mining` is whether the NPC's body is
 * mining right now: mining recorded as active while the body no longer mines
 * is closed here, at this tick, so an unobserved stop still voids the window
 * that follows it.
 */
export function hand_work_since(force_index: number, item_name: string, since_tick: number, actor_mining: boolean): HandWorkVoid | undefined {
  const work = storage.sgluna_hand_work?.[force_index]
  if (!work) return undefined
  const active = work.mining_active ?? {}
  if (!actor_mining && Object.keys(active).length > 0) note_hand_mining(force_index, false, undefined)
  for (const name of [item_name, ANY_ITEM]) {
    const started = (work.mining_active ?? {})[name]
    if (started !== undefined) return { reason: 'hand_mined', tick: game.tick, item_name: name }
    const mined = work.mined_tick?.[name]
    if (mined !== undefined && mined >= since_tick) return { reason: 'hand_mined', tick: mined, item_name: name }
  }
  const crafted = work.crafted_tick?.[item_name]
  if (crafted !== undefined && crafted >= since_tick) return { reason: 'hand_crafted', tick: crafted, item_name }
  if (work.insert_tick !== undefined && work.insert_tick >= since_tick) {
    return { reason: 'hand_inserted', tick: work.insert_tick, item_name: work.insert_item, entity_name: work.insert_entity }
  }
  // Machines hand-fed earlier that still hold hand-inserted input keep the
  // window void, however long ago the insert was.
  if (work.fed !== undefined && work.fed.length > 0) {
    const still_fed = prune_fed(work)
    if (still_fed !== undefined) return { reason: 'hand_inserted', tick: still_fed.tick, item_name: still_fed.items[0], entity_name: still_fed.entity_name }
  }
  if (work.fed_end_tick !== undefined && work.fed_end_tick >= since_tick) {
    return { reason: 'hand_inserted', tick: work.fed_end_tick, item_name: work.fed_end_item, entity_name: work.fed_end_entity }
  }
  if (work.fed_overflow_tick !== undefined) {
    prune_fed(work)
    if (work.fed_overflow_tick !== undefined) return { reason: 'hand_inserted', tick: work.fed_overflow_tick, item_name: ANY_ITEM }
  }
  return undefined
}
