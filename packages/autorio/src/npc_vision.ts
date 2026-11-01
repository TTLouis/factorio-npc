import type { EntityID, EntitySearchFilters, LuaEntity, LuaSurface } from 'factorio:runtime'
import type { ActorStatusSnapshot, ControlledActor } from './actors/types'

// The standalone NPC's live map vision (docs/NPC_CHARACTER_ARCHITECTURE.md,
// "Map knowledge"). A character prototype has no chunk_exploration_radius, so a
// hidden vehicle, "sgluna-npc-vision" (data.lua), follows the NPC and charts the
// area around it the way a spidertron does. The vehicle must not interact with
// the world at all: the prototype removes every interaction, this module keeps
// exactly one of them next to the live NPC, and the helpers below keep it out of
// every entity scan so nothing in the mod can observe, mine, clear or avoid it.

export const NPC_VISION_ENTITY_NAME = 'sgluna-npc-vision'

// The vehicle follows the NPC when the NPC changes chunk, and is corrected this
// often otherwise, so a stale position can never leave the NPC without vision.
const FOLLOW_CORRECTION_INTERVAL = 60
// A failed create is retried at most this often so it cannot spend every tick.
const CREATE_RETRY_INTERVAL = 300
// While creation keeps failing only the first failure and every Nth is logged.
const CREATE_FAILURE_LOG_EVERY = 12

interface NpcVisionRecord {
  entity: LuaEntity
  unit_number: number
  actor_id: number
  force_index: number
  surface_index: number
  created_tick: number
}

declare const storage: {
  sgluna_npc_vision?: NpcVisionRecord
  // In storage, not a module local, so every multiplayer peer decides
  // identically whether to try creating the vehicle on a given tick.
  sgluna_npc_vision_retry_tick?: number
  sgluna_npc_vision_failures?: number
}

export function is_npc_vision_entity(entity: { name: string }) {
  return entity.name === NPC_VISION_ENTITY_NAME
}

export function without_npc_vision<T extends { name: string }>(entities: readonly T[]): T[] {
  const result: T[] = []
  for (const entity of entities) {
    if (!is_npc_vision_entity(entity)) result.push(entity)
  }
  return result
}

// A name filter that asks for the vehicle matches nothing, whatever else it lists.
function names_vision(id: EntityID) {
  return (typeof id === 'string' ? id : id.name) === NPC_VISION_ENTITY_NAME
}

function world_filters(filters: EntitySearchFilters): EntitySearchFilters | undefined {
  const name = filters.name
  if (name === undefined) return filters
  if (!Array.isArray(name)) return names_vision(name as EntityID) ? undefined : filters
  const names = name as readonly EntityID[]
  const kept = names.filter(candidate => !names_vision(candidate))
  if (kept.length === names.length) return filters
  return kept.length === 0 ? undefined : { ...filters, name: kept }
}

// A scan whose name filter lists real entities, whose type filter leaves out
// cars, or that asks for ghosts, can never match the vehicle, so it goes to the
// engine as it is. Anything else (area, radius, force ... and every inverted
// filter) could return it and is post-filtered.
function cannot_match_vehicle(filters: EntitySearchFilters) {
  if (filters.name !== undefined || filters.ghost_name !== undefined || filters.ghost_type !== undefined) return true
  const type = filters.type
  if (type === undefined) return false
  const types = Array.isArray(type) ? type as readonly string[] : [type as string]
  return !types.includes('car')
}

// The engine applies `limit` before this module drops the vehicle, so a limited
// scan asks for one extra result. If several vehicles (an orphan) ate that
// window and the engine had more to give, it is repeated without the limit.
function post_filtered(surface: LuaSurface, filters: EntitySearchFilters): LuaEntity[] {
  const limit = filters.limit
  if (limit === undefined) return without_npc_vision(surface.find_entities_filtered(filters))
  const raw = surface.find_entities_filtered({ ...filters, limit: limit + 1 })
  const found = without_npc_vision(raw)
  if (found.length >= limit || raw.length < limit + 1) return found.slice(0, limit)
  const { limit: _limit, ...unlimited } = filters
  return without_npc_vision(surface.find_entities_filtered(unlimited)).slice(0, limit)
}

/**
 * LuaSurface.find_entities_filtered for the game world as the NPC and the model
 * see it: the vision vehicle is never part of it, whatever the filters are
 * (including `limit` and `invert`). Every entity scan in the mod goes through
 * this; npc_vision.test.ts fails on a direct call.
 */
export function find_world_entities(surface: LuaSurface, filters: EntitySearchFilters): LuaEntity[] {
  // An inverted name filter that lists the vehicle excludes it in the engine;
  // otherwise the vehicle is matched and dropped below.
  if (filters.invert === true) return post_filtered(surface, filters)
  const allowed = world_filters(filters)
  if (allowed === undefined) return []
  if (cannot_match_vehicle(allowed)) return without_npc_vision(surface.find_entities_filtered(allowed))
  return post_filtered(surface, allowed)
}

/** LuaSurface.count_entities_filtered, without the vision vehicle. */
export function count_world_entities(surface: LuaSurface, filters: EntitySearchFilters): number {
  const direct = filters.invert !== true
  const allowed = direct ? world_filters(filters) : filters
  if (allowed === undefined) return 0
  if (direct && cannot_match_vehicle(allowed)) return surface.count_entities_filtered(allowed)
  // Counting stays in the engine while no vehicle exists; otherwise the vehicle
  // could be among the matches, so the matches are listed and counted here.
  if (surface.count_entities_filtered({ name: NPC_VISION_ENTITY_NAME }) === 0) return surface.count_entities_filtered(allowed)
  return post_filtered(surface, allowed).length
}

type TraceField = [key: string, value: string | number | boolean | undefined]

function trace(event: string, fields: TraceField[]) {
  const parts: string[] = []
  for (const [key, value] of fields) {
    if (value !== undefined) parts.push(`${key}=${value}`)
  }
  log(`[AUTORIO] ${event} ${parts.join(' ')}`)
}

export function new_npc_vision_controller() {
  function destroy_record(record: NpcVisionRecord, reason: string) {
    const was_valid = record.entity.valid
    if (was_valid) record.entity.destroy({ raise_destroy: false })
    storage.sgluna_npc_vision = undefined
    trace('npc.vision.destroyed', [
      ['actor_id', record.actor_id],
      ['unit_number', record.unit_number],
      ['reason', reason],
      ['entity_valid', was_valid],
    ])
  }

  // Destroy every vision vehicle except the one stored for `keep_actor_id`.
  // Called when the mod is initialised or its configuration changes, and before
  // a new vehicle is created, so a lost record or an old save never leaves a
  // vehicle that nothing follows.
  function sweep(keep_actor_id: number | undefined, reason: string, quiet_when_empty = false) {
    const record = storage.sgluna_npc_vision
    const keep = record !== undefined
      && record.entity.valid
      && keep_actor_id !== undefined
      && record.actor_id === keep_actor_id
      ? record.unit_number
      : undefined
    let destroyed = 0
    for (const [_index, surface] of pairs(game.surfaces)) {
      if (!surface.valid) continue
      for (const entity of surface.find_entities_filtered({ name: NPC_VISION_ENTITY_NAME })) {
        if (!entity.valid || (keep !== undefined && entity.unit_number === keep)) continue
        entity.destroy({ raise_destroy: false })
        destroyed++
      }
    }
    if (record !== undefined && keep === undefined) storage.sgluna_npc_vision = undefined
    // The sweep before every create finds nothing almost always; say so only
    // when something was destroyed.
    if (destroyed > 0 || !quiet_when_empty) {
      trace('npc.vision.swept', [
        ['keep_actor_id', keep_actor_id],
        ['kept_unit_number', keep],
        ['destroyed', destroyed],
        ['reason', reason],
      ])
    }
    return destroyed
  }

  function create(actor: ControlledActor, actor_id: number, reason: string) {
    const retry_tick = storage.sgluna_npc_vision_retry_tick
    if (retry_tick !== undefined && game.tick < retry_tick) return undefined

    sweep(actor_id, `before_create:${reason}`, true)
    const position = actor.position
    // Nothing is built: no event, no smoke, and nothing under it is removed.
    const build = () => actor.surface.create_entity({
      name: NPC_VISION_ENTITY_NAME,
      position,
      force: actor.force,
      raise_built: false,
      create_build_effect_smoke: false,
      spawn_decorations: false,
      move_stuck_players: false,
      preserve_ghosts_and_corpses: true,
    })
    // Some surfaces may refuse the entity by throwing instead of returning nothing.
    let entity: LuaEntity | undefined
    let failure: string | undefined
    if (typeof pcall === 'function') {
      const [ok, result] = pcall(() => build())
      if (ok) entity = result as LuaEntity | undefined
      else failure = `create_entity_threw:${String(result).slice(0, 120)}`
    }
    else {
      entity = build()
    }
    if (failure === undefined && (entity === undefined || !entity.valid || entity.unit_number === undefined)) {
      failure = 'create_entity_returned_nothing'
    }
    if (failure !== undefined || entity === undefined) {
      storage.sgluna_npc_vision_retry_tick = game.tick + CREATE_RETRY_INTERVAL
      const failures = (storage.sgluna_npc_vision_failures ?? 0) + 1
      storage.sgluna_npc_vision_failures = failures
      if (failures === 1 || failures % CREATE_FAILURE_LOG_EVERY === 0) {
        trace('npc.vision.create_failed', [
          ['actor_id', actor_id],
          ['reason', failure],
          ['trigger', reason],
          ['failures', failures],
        ])
      }
      return undefined
    }

    // Every way of touching it is switched off. The prototype already removes
    // them; this covers a stale prototype and keeps the runtime state explicit.
    entity.destructible = false
    entity.minable = false
    entity.operable = false
    entity.rotatable = false
    storage.sgluna_npc_vision_retry_tick = undefined
    storage.sgluna_npc_vision_failures = undefined
    const record: NpcVisionRecord = {
      entity,
      unit_number: entity.unit_number as number,
      actor_id,
      force_index: actor.force.index,
      surface_index: actor.surface.index,
      created_tick: game.tick,
    }
    storage.sgluna_npc_vision = record
    trace('npc.vision.created', [
      ['actor_id', actor_id],
      ['unit_number', record.unit_number],
      ['surface_index', record.surface_index],
      ['x', position.x],
      ['y', position.y],
      ['reason', reason],
    ])
    return record
  }

  function follow(actor: ControlledActor, record: NpcVisionRecord, actor_id: number) {
    const entity = record.entity
    const position = actor.position
    const changed_surface = entity.surface.index !== actor.surface.index
    if (!changed_surface && entity.position.x === position.x && entity.position.y === position.y) return
    if (!entity.teleport(position, actor.surface, false, false)) {
      // Only cars, spidertrons and players cross surfaces; if the engine refuses
      // anyway, the vehicle is rebuilt next to the NPC instead.
      destroy_record(record, changed_surface ? 'surface_teleport_refused' : 'teleport_refused')
      create(actor, actor_id, 'recreate_after_teleport_refused')
      return
    }
    record.surface_index = actor.surface.index
  }

  /** Drop the vehicle: the actor it followed is gone, replaced or not an NPC. */
  function release(reason: string) {
    const record = storage.sgluna_npc_vision
    if (record === undefined) return false
    destroy_record(record, reason)
    return true
  }

  /**
   * Keep exactly one vision vehicle next to this standalone NPC actor, and none
   * for any other actor. `identity` is the actor's status snapshot and
   * `changed_chunk` is awareness' own chunk-change test.
   */
  function tick(actor: ControlledActor, identity: ActorStatusSnapshot, changed_chunk: boolean) {
    if (identity.kind !== 'standalone_character' || identity.actor_id === undefined) {
      release(identity.kind === 'standalone_character' ? 'actor_without_id' : 'actor_not_standalone')
      return
    }
    const actor_id = identity.actor_id

    let record = storage.sgluna_npc_vision
    if (record !== undefined && record.actor_id !== actor_id) {
      destroy_record(record, 'actor_replaced')
      record = undefined
    }
    else if (record !== undefined && !record.entity.valid) {
      destroy_record(record, 'entity_invalid')
      record = undefined
    }

    if (record === undefined) {
      create(actor, actor_id, 'no_vehicle')
      return
    }

    if (changed_chunk || game.tick % FOLLOW_CORRECTION_INTERVAL === 0) follow(actor, record, actor_id)
  }

  function status(): Record<string, unknown> {
    const record = storage.sgluna_npc_vision
    if (record === undefined || !record.entity.valid) {
      return { present: false, stored: record !== undefined }
    }
    const entity = record.entity
    return {
      present: true,
      unit_number: record.unit_number,
      actor_id: record.actor_id,
      surface_index: entity.surface.index,
      position: entity.position,
      active: entity.active,
      destructible: entity.destructible,
      minable: entity.minable,
      operable: entity.operable,
      rotatable: entity.rotatable,
      is_military_target: entity.is_military_target,
      force: entity.force.name,
      created_tick: record.created_tick,
    }
  }

  return { tick, release, sweep, status }
}

export type NpcVisionController = ReturnType<typeof new_npc_vision_controller>
