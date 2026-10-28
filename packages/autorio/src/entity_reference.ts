import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaSurface, UnitNumber } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { area_known_visible } from './map_knowledge'
import { find_world_entities, is_npc_vision_entity } from './npc_vision'

export interface EntityReferenceHint {
  name: string
  surface_index: LuaSurface['index']
  force_index: number
  position: MapPositionStruct
  observed_tick: number
}

declare const storage: {
  sgluna_entity_reference_hints?: Record<number, EntityReferenceHint>
}

function hints() {
  storage.sgluna_entity_reference_hints ??= {}
  return storage.sgluna_entity_reference_hints
}

export function remember_entity_reference(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid || entity.unit_number === undefined) return
  hints()[entity.unit_number] = {
    name: entity.name,
    surface_index: entity.surface.index,
    force_index: entity.force.index,
    position: { x: entity.position.x, y: entity.position.y },
    observed_tick: game.tick,
  }
}

export function entity_reference_hint(unit_number: number) {
  const hint = hints()[unit_number]
  if (!hint) return undefined
  return {
    ...hint,
    position: { x: hint.position.x, y: hint.position.y },
  }
}

// actor_body: the actor's own surface and force (body actions).
// map_visible: any surface and force; callers apply their own charted/visible
// and force policy checks afterwards (map inspection and mutation, navigation
// targets, construction anchors).
export type EntityReferenceScope = 'actor_body' | 'map_visible'

function identity_at(surface: LuaSurface, hint: EntityReferenceHint, unit_number: number, force?: ControlledActor['force']) {
  const filters: Record<string, unknown> = {
    position: hint.position,
    radius: 0.25,
    name: hint.name,
  }
  if (force) filters.force = force
  const candidates = find_world_entities(surface, filters as any)
  for (const candidate of candidates) {
    if (!candidate.valid || candidate.unit_number !== unit_number) continue
    remember_entity_reference(candidate)
    return candidate
  }
  return undefined
}

export function resolve_entity_reference(actor: ControlledActor, unit_number: number, scope: EntityReferenceScope) {
  // Only prototypes flagged get-by-unit-number are indexed here; ordinary
  // buildings are not and fall through to the observation hint.
  const direct = game.get_entity_by_unit_number(unit_number as UnitNumber)
  // The hidden NPC vision vehicle is not part of the world the NPC can reference.
  if (direct && direct.valid && is_npc_vision_entity(direct)) return undefined
  if (direct && direct.valid) {
    remember_entity_reference(direct)
    return direct
  }

  // The observation hint is only a lookup aid for the *same* identity: never
  // substitute a replacement that merely has the same name and position.
  const hint = hints()[unit_number]
  if (!hint) return undefined
  if (scope === 'actor_body') {
    if (hint.surface_index !== actor.surface.index || hint.force_index !== actor.force.index) return undefined
    return identity_at(actor.surface, hint, unit_number, actor.force)
  }
  const surface = game.get_surface(hint.surface_index)
  if (!surface || !surface.valid) return undefined
  return identity_at(surface, hint, unit_number)
}

// The entity a record bound to this unit_number on this surface and force, read without an actor (a ledger settling an
// operation long after it ran): the engine's own lookup, else the observation hint for the same identity.
export function resolve_recorded_entity(unit_number: number, surface_index: number, force_index: number) {
  const direct = game.get_entity_by_unit_number(unit_number as UnitNumber)
  if (direct && direct.valid && is_npc_vision_entity(direct)) return undefined
  if (direct && direct.valid) return direct.surface.index === surface_index && direct.force.index === force_index ? direct : undefined
  const hint = hints()[unit_number]
  if (!hint || hint.surface_index !== surface_index || hint.force_index !== force_index) return undefined
  const surface = game.get_surface(surface_index as LuaSurface['index'])
  if (!surface || !surface.valid) return undefined
  return identity_at(surface, hint, unit_number)
}

export function resolve_exact_entity(actor: ControlledActor, unit_number: number) {
  return resolve_entity_reference(actor, unit_number, 'actor_body')
}

export type VisibleEntityReference =
  | { entity: LuaEntity, code: 'ok' }
  | { entity?: undefined, code: 'not_found' | 'not_visible' | 'wrong_surface' }

function entity_known_visible(actor: ControlledActor, entity: LuaEntity) {
  const box = entity.bounding_box
  return area_known_visible(actor.force, entity.surface, box ?? { left_top: entity.position, right_bottom: entity.position })
}

// A unit number the model names (an anchor, a connection target, a layout endpoint), resolved only where the NPC sees it now.
// An entity in a chunk the NPC does not see is `not_visible` whether it still stands there or not: nothing there is scanned
// and its hint is not refreshed, so an old observation never comes back as a fresh fact or as execution authority. Another
// surface is `wrong_surface`; with actor_body scope another force is `not_found`, as resolve_entity_reference treats it.
export function resolve_visible_entity_reference(actor: ControlledActor, unit_number: number, scope: EntityReferenceScope): VisibleEntityReference {
  const direct = game.get_entity_by_unit_number(unit_number as UnitNumber)
  if (direct && direct.valid && !is_npc_vision_entity(direct)) {
    if (direct.surface.index !== actor.surface.index) return { code: 'wrong_surface' }
    if (scope === 'actor_body' && direct.force.index !== actor.force.index) return { code: 'not_found' }
    if (!entity_known_visible(actor, direct)) return { code: 'not_visible' }
    remember_entity_reference(direct)
    return { entity: direct, code: 'ok' }
  }
  if (direct && direct.valid) return { code: 'not_found' }

  const hint = hints()[unit_number]
  if (!hint) return { code: 'not_found' }
  if (hint.surface_index !== actor.surface.index) return { code: 'wrong_surface' }
  if (scope === 'actor_body' && hint.force_index !== actor.force.index) return { code: 'not_found' }
  if (!area_known_visible(actor.force, actor.surface, { left_top: hint.position, right_bottom: hint.position })) return { code: 'not_visible' }
  const entity = identity_at(actor.surface, hint, unit_number, scope === 'actor_body' ? actor.force : undefined)
  if (!entity) return { code: 'not_found' }
  if (!entity_known_visible(actor, entity)) return { code: 'not_visible' }
  return { entity, code: 'ok' }
}
