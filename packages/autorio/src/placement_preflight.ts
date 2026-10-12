import type { ControlledActor } from './actors/types'
import { resolve_entity_placement_item } from './placement_item'

// A read of current held stock, not a reservation or a promise about dispatch.
// Execution repeats the same resolver/count check before creating an entity.
export function placement_item_preflight(actor: ControlledActor | undefined, entity_name: string) {
  if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
  const inventory = actor.get_main_inventory()
  if (!inventory) return { ok: false, code: 'no_inventory' }
  const resolved = resolve_entity_placement_item(entity_name)
  if (!resolved.ok) return resolved
  const held_count = inventory.get_item_count(resolved.requirement.item_name)
  const placement_item = { ...resolved.requirement, held_count }
  if (typeof held_count !== 'number' || held_count !== held_count
    || held_count !== math.floor(held_count) || held_count < 0 || held_count > 9007199254740991) {
    return { ok: false, code: 'placement_item_unreadable', entity_name }
  }
  if (held_count < resolved.requirement.count) return { ok: false, code: 'placement_item_missing', placement_item }
  return { ok: true, placement_item }
}
