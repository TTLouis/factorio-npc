import { hydraulic_mutation_preflight } from './hydraulic_mutation'
import { area_known_visible } from './map_knowledge'
import { find_world_entities } from './npc_vision'
import type { ControlledActor } from './actors/types'
import { resolve_visible_entity_reference } from './entity_reference'
import { candidate_fluid_ports, complete_live_fluid_ports, fluid_ports_align } from './placement_spatial_features'
import { inspect_removal } from './entity_removal_receipt'
import { factory_world_identity } from './factory_cell_observation'
import { protected_read } from './electric_facts'

// A native witness, never a prototype-name allowlist. External operations repeat
// this at execution as well as in the host's atomic admission callback.
export function external_world_preflight(actor: ControlledActor | undefined, operation: string, unit_number: number) {
  const refusal = (code: string) => ({ ok: false as const, code })
  if (!actor?.is_valid) return refusal('no_actor')
  const resolved = resolve_visible_entity_reference(actor, unit_number, 'actor_body')
  const entity = resolved.entity
  if (!entity?.valid || entity.unit_number !== unit_number || entity.force.index !== actor.force.index || entity.surface.index !== actor.surface.index) return refusal('external_exact_target_unproven')
  const hydraulic = ['rotate_entity', 'mine_entity_exact'].includes(operation) ? hydraulic_mutation_preflight(actor, operation, unit_number) : undefined
  if (hydraulic && !hydraulic.ok) return hydraulic
  const witness = protected_read(() => {
    const prototype_boxes = entity.prototype.fluidbox_prototypes
    if (!prototype_boxes || prototype_boxes.length > 16 || entity.fluids_count > 16) return undefined
    const ports = complete_live_fluid_ports(entity)
    if (!ports.complete) return undefined
    for (let i = 1; i <= entity.fluids_count; i++) if (entity.get_fluid(i) !== undefined) return undefined
    if (operation === 'set_machine_recipe' && ports.ports.some(port => port.connected)) return undefined
    // Disabled recipe fluidboxes may hide their ports. Prove the complete
    // prototype geometry and an empty visible neighbour envelope before a first
    // recipe activates them; current live disconnection alone is insufficient.
    if (operation === 'set_machine_recipe' && prototype_boxes.length > 0) {
      let expected = 0
      for (const box of prototype_boxes) expected += box.pipe_connections.length
      const potential = candidate_fluid_ports(entity.prototype, entity.position, entity.direction)
      if (!potential || expected !== potential.length || expected < 1 || expected > 16
        || potential.some(port => port.connection_type !== 'normal' || port.direction === undefined || ![0, 4, 8, 12].includes(port.direction))) return undefined
      let left = entity.position.x, right = left, top = entity.position.y, bottom = top
      for (const port of potential) {
        left = math.min(left, port.position.x); right = math.max(right, port.position.x)
        top = math.min(top, port.position.y); bottom = math.max(bottom, port.position.y)
      }
      if (right - left > 128 || bottom - top > 128) return undefined
      const area = { left_top: { x: left - 2, y: top - 2 }, right_bottom: { x: right + 2, y: bottom + 2 } }
      if (!area_known_visible(actor.force, actor.surface, area)) return undefined
      const neighbours = find_world_entities(actor.surface, { area, limit: 65 })
      if (neighbours.length > 64) return undefined
      for (const other of neighbours) {
        if (other === entity || other.fluids_count === 0) continue
        const live = complete_live_fluid_ports(other)
        if (!live.complete || live.ports.some(from => potential.some(to => fluid_ports_align(from, to)))) return undefined
      }
    }
    return { version: 1, unit_number, entity_name: entity.name, actor_id: actor.status_snapshot().actor_id,
      surface_index: entity.surface.index, force_index: entity.force.index, tick: game.tick,
      prototype_fluidbox_count: prototype_boxes.length, fluidbox_count: entity.fluids_count, connected_ports: ports.ports.filter(port => port.connected).length,
      hydraulic_guard: hydraulic?.ok ? hydraulic.witness : undefined }
  })
  if (!witness) return refusal('external_hydraulic_target_unproven')
  if (operation === 'mine_entity_exact') {
    const world = factory_world_identity()
    const inventory = actor.get_main_inventory()
    if (!world.ok || !inventory) return refusal('removal_owner_unproven')
    const custody = inspect_removal(entity, inventory)
    if (!custody.ok) return refusal(custody.code)
  }
  if (operation === 'set_machine_recipe' && entity.type !== 'assembling-machine') return refusal('not_recipe_machine')
  return { ok: true as const, external_world_safety: witness }
}
