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
// Only ticks are kept, per force and per item, so storage stays bounded by the
// number of distinct items the NPC ever handled.

import type { LuaEntity } from 'factorio:runtime'

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
}

export interface HandWorkStorage {
  airi_hand_work?: Record<number, ForceHandWork>
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
  const all = storage.airi_hand_work ?? {}
  storage.airi_hand_work = all
  const work = all[force_index] ?? {}
  all[force_index] = work
  return work
}

/**
 * The NPC moved `item_name` into `entity`. A move into the entity's fuel
 * inventory is refuelling (allowed); a move into a turret or lab feeds nothing
 * that produces items. Everything else is hand feeding.
 */
export function record_hand_insert(force_index: number, item_name: string, entity_name: string, entity_type: string, into_fuel: boolean) {
  if (into_fuel || NON_PRODUCING_TYPES[entity_type]) return
  const work = force_work(force_index)
  work.insert_tick = game.tick
  work.insert_item = item_name
  work.insert_entity = entity_name
}

export function record_hand_crafted_tick(force_index: number, item_name: string) {
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

/** Item names mining `entity` can yield; ANY_ITEM when that is unknown. */
export function mined_item_names(entity: LuaEntity | undefined): string[] {
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
export function note_hand_mining(force_index: number, mining: boolean, target: LuaEntity | undefined) {
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
  const work = storage.airi_hand_work?.[force_index]
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
  return undefined
}
