import type { LuaEntity, OnEntityDiedEvent, OnPostEntityDiedEvent } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { selected_weapon_readiness } from './equipment'
import { entity_interaction_reach } from './interaction_range'

interface CorpseRecord {
  corpse_ref: string
  npc_id: string
  previous_actor_id: number
  surface_index: number
  force_index: number
  corpse_force_index?: number
  position: { x: number, y: number }
  death_tick: number
  entity?: LuaEntity
  state: 'awaiting_corpse' | 'available' | 'partial' | 'recovered' | 'lost'
  reason?: string
}

interface RecoveryResult {
  request_id: string
  corpse_ref: string
  operation_ordinal: number
  expected_actor_id: number
  max_slots: number
  max_count: number
  npc_id?: string
  actor_id?: number
  accepted: boolean
  reason: string
  moved_count: number
  moved_slots: number
  tick: number
}

declare const storage: {
  standalone_character_unit_number?: number
  standalone_npc_identity?: { id: string }
  sgluna_actor_mode?: string
  sgluna_corpses?: CorpseRecord[]
  sgluna_corpse_results?: RecoveryResult[]
  sgluna_corpse_registry_full?: boolean
  sgluna_corpse_operation_highwater?: Record<string, number>
}

const MAX_OPEN_CORPSES = 128
const MAX_TERMINAL_CORPSES = 32
const MAX_RESULTS = 8192

function records() {
  storage.sgluna_corpses ??= []
  return storage.sgluna_corpses
}

function terminal(record: CorpseRecord) {
  return record.state === 'recovered' || record.state === 'lost'
}

function bounded_integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function native_corpse_matches_record(record: CorpseRecord) {
  return record.entity?.valid === true && record.entity.surface.index === record.surface_index
    && record.entity.force.index === record.corpse_force_index
}

function refresh() {
  for (const record of records()) {
    if (terminal(record)) continue
    if (!record.entity?.valid) {
      // No death event inventory is copied; missing native evidence is lost.
      if (record.state !== 'awaiting_corpse' || game.tick > record.death_tick) {
        record.state = 'lost'
        record.reason = 'native_corpse_unavailable'
        record.entity = undefined
      }
      continue
    }
    if (!native_corpse_matches_record(record)) continue
    const inventory = record.entity.get_inventory(defines.inventory.character_corpse)
    if (inventory?.is_empty()) {
      record.state = 'recovered'
      record.reason = 'native_inventory_empty'
    }
  }
  const open = records().filter(record => !terminal(record))
  const closed = records().filter(terminal).slice(-MAX_TERMINAL_CORPSES)
  storage.sgluna_corpses = [...open, ...closed]
  // Pruning terminal corpses cannot enable another transfer: their exact refs
  // are no longer admitted. Never discard a receipt for a live partial corpse.
  storage.sgluna_corpse_results = storage.sgluna_corpse_results?.filter(result =>
    storage.sgluna_corpses!.some(record => record.corpse_ref === result.corpse_ref))
  storage.sgluna_corpse_registry_full = open.length >= MAX_OPEN_CORPSES
}

export function note_npc_death(event: OnEntityDiedEvent) {
  const entity = event.entity
  if (storage.sgluna_actor_mode !== 'npc' || entity.type !== 'character'
    || entity.unit_number !== storage.standalone_character_unit_number
    || !storage.standalone_npc_identity) return
  refresh()
  if (storage.sgluna_corpse_registry_full) {
    log('[AUTORIO] corpse.registry_full request_id=native_death reason=open_corpse_limit')
    return
  }
  const actor_id = entity.unit_number!
  if (records().some(record => record.previous_actor_id === actor_id)) return
  records().push({
    corpse_ref: `npc-corpse/${actor_id}/${event.tick}`,
    npc_id: storage.standalone_npc_identity.id,
    previous_actor_id: actor_id,
    surface_index: entity.surface.index,
    force_index: entity.force.index,
    position: { x: entity.position.x, y: entity.position.y },
    death_tick: event.tick,
    state: 'awaiting_corpse',
  })
  log(`[AUTORIO] corpse.recorded request_id=native_death/${actor_id} reason=npc_death`)
}

export function note_npc_corpse(event: OnPostEntityDiedEvent) {
  const record = records().find(entry => entry.previous_actor_id === event.unit_number
    && entry.death_tick === event.tick && entry.surface_index === event.surface_index
    && entry.state === 'awaiting_corpse')
  if (!record) return
  const corpses = event.corpses.filter(entity => entity.valid && entity.type === 'character-corpse')
  // Ambiguous evidence never grants access to a nearby human/other NPC corpse.
  if (corpses.length !== 1) {
    record.state = 'lost'
    record.reason = 'native_corpse_not_unique'
    return
  }
  record.entity = corpses[0]
  record.corpse_force_index = corpses[0].force.index
  record.state = 'available'
}

export function new_corpse_recovery_controller(get_actor: () => ControlledActor | undefined) {
  function status() {
    refresh()
    return {
      registry_full: storage.sgluna_corpse_registry_full ?? false,
      corpses: records().map(({ entity, ...record }) => ({
        ...record,
        unit_number: entity?.valid ? entity.unit_number : undefined,
        items: entity?.valid && native_corpse_matches_record({ ...record, entity }) ? entity.get_inventory(defines.inventory.character_corpse)?.get_contents() : undefined,
      })),
      last_result: storage.sgluna_corpse_results?.slice(-1)[0],
    }
  }

  function recover(corpse_ref: string, max_slots: number, max_count: number, expected_actor_id: number, request_id: string, operation_ordinal: number): RecoveryResult {
    refresh()
    const actor = get_actor()
    const identity = actor?.status_snapshot()
    const result: RecoveryResult = {
      request_id, corpse_ref, operation_ordinal, expected_actor_id, max_slots, max_count,
      npc_id: identity?.npc_id, actor_id: identity?.actor_id, accepted: false,
      reason: 'invalid_request', moved_count: 0, moved_slots: 0, tick: game.tick,
    }
    function finish(reason: string, retain = true) {
      result.reason = reason
      if (retain && typeof request_id === 'string' && request_id.length > 0 && request_id.length <= 160) {
        storage.sgluna_corpse_results ??= []
        if (storage.sgluna_corpse_results.length < MAX_RESULTS) storage.sgluna_corpse_results.push(result)
      }
      log(`[AUTORIO] corpse.recovery request_id=${request_id} reason=${reason} moved_count=${result.moved_count}`)
      return result
    }
    if (typeof request_id !== 'string' || request_id.length === 0 || request_id.length > 160
      || typeof corpse_ref !== 'string' || corpse_ref.length > 160
      || !bounded_integer(operation_ordinal, 1, 9007199254740991)
      || !bounded_integer(expected_actor_id, 1, 9007199254740991)
      || !bounded_integer(max_slots, 1, 16)
      || !bounded_integer(max_count, 1, 1000)) return finish('invalid_request', false)
    const previous = storage.sgluna_corpse_results?.find(receipt => receipt.request_id === request_id)
    if (previous) {
      if (previous.corpse_ref !== corpse_ref || previous.expected_actor_id !== expected_actor_id
        || previous.npc_id !== identity?.npc_id || previous.max_slots !== max_slots
        || previous.max_count !== max_count || previous.operation_ordinal !== operation_ordinal) {
        return finish('duplicate_conflict', false)
      }
      return { ...previous }
    }
    if ((storage.sgluna_corpse_results?.length ?? 0) >= MAX_RESULTS) return finish('receipt_capacity')
    if (!actor?.is_valid || !actor.character || identity?.kind !== 'standalone_character') return finish('no_standalone_actor')
    if (identity.actor_id !== expected_actor_id) return finish('actor_changed')
    if (!identity.npc_id) return finish('no_npc_identity')
    storage.sgluna_corpse_operation_highwater ??= {}
    const highwater = storage.sgluna_corpse_operation_highwater[identity.npc_id] ?? 0
    // Receipt pruning never permits replay: only the harness's next durable
    // operation ordinal can perform a new physical transfer for this NPC.
    if (operation_ordinal <= highwater) return finish('stale_operation_ordinal', false)
    storage.sgluna_corpse_operation_highwater[identity.npc_id] = operation_ordinal
    if (!selected_weapon_readiness(actor.character).ready) return finish('compatible_weapon_and_ammo_required')
    refresh()
    const record = records().find(entry => entry.corpse_ref === corpse_ref)
    if (!record || record.npc_id !== identity.npc_id) return finish('corpse_not_owned')
    if (terminal(record)) return finish(record.state)
    const corpse = record.entity
    if (!corpse?.valid) return finish('native_corpse_unavailable')
    if (actor.surface.index !== record.surface_index || actor.force.index !== record.force_index) return finish('surface_or_force_changed')
    if (corpse.surface.index !== record.surface_index || corpse.force.index !== record.corpse_force_index) return finish('corpse_surface_or_force_changed')
    const dx = corpse.position.x - actor.position.x
    const dy = corpse.position.y - actor.position.y
    if (dx * dx + dy * dy > entity_interaction_reach(actor) ** 2) return finish('too_far')
    const source = corpse.get_inventory(defines.inventory.character_corpse)
    const destination = actor.get_main_inventory()
    if (!source || !destination) return finish('inventory_unavailable')
    result.accepted = true
    for (let i = 0; i < source.length && result.moved_slots < max_slots && result.moved_count < max_count; i++) {
      const stack = source[i]
      if (!stack?.valid_for_read) continue
      const initial = stack.count
      for (let j = 0; j < destination.length && corpse.valid && source.valid && stack.valid && stack.valid_for_read && result.moved_count < max_count; j++) {
        const before = stack.count
        // Native stack transfer preserves quality, remaining ammo, durability,
        // equipment grids and item data. Count deltas are authoritative.
        destination[j].transfer_stack(stack, math.min(before, max_count - result.moved_count))
        result.moved_count += before - (stack.valid && stack.valid_for_read ? stack.count : 0)
      }
      if (!stack.valid || !stack.valid_for_read || stack.count < initial) result.moved_slots++
      if (!corpse.valid || !source.valid) break
    }
    const complete = !corpse.valid || !source.valid || source.is_empty()
    record.state = complete ? 'recovered' : 'partial'
    record.reason = complete ? 'native_inventory_empty' : 'items_remaining'
    return finish(complete ? 'recovered' : result.moved_count > 0 ? 'partial' : 'inventory_full')
  }

  return { status, recover }
}
