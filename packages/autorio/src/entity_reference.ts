import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaSurface, UnitNumber } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

export interface EntityReferenceHint {
  name: string
  surface_index: LuaSurface['index']
  force_index: number
  position: MapPositionStruct
  observed_tick: number
}

declare const storage: {
  airi_entity_reference_hints?: Record<number, EntityReferenceHint>
}

function hints() {
  storage.airi_entity_reference_hints ??= {}
  return storage.airi_entity_reference_hints
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
  const candidates = surface.find_entities_filtered(filters as any)
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

export function resolve_exact_entity(actor: ControlledActor, unit_number: number) {
  return resolve_entity_reference(actor, unit_number, 'actor_body')
}
