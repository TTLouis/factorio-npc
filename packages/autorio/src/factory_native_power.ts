import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { area_known_visible } from './map_knowledge'
import { find_world_entities } from './npc_vision'

export const FACTORY_POWER_LIMITS = { prototypes: 4096, names: 512, entities: 128, connectors: 16, connections: 64 }
const finite = (v: unknown): v is number => typeof v === 'number' && v === v && v >= 0 && v < math.huge
function number(read: () => number | undefined) {
  const value = protected_read(() => ({ value: read() }))
  if (!value) return { state: 'error', code: 'native_number_unreadable' }
  return finite(value.value) ? { state: 'known', value: value.value } : { state: 'unknown', code: 'native_number_unavailable' }
}
function locator(entity: LuaEntity) {
  return { unit_number: entity.unit_number, name: entity.name, type: entity.type, position: { x: entity.position.x, y: entity.position.y },
    surface_index: entity.surface.index, force_index: entity.force.index }
}

// A bounded physical component snapshot, not measured supply. The whole surface
// query uses live prototype membership, so an undeclared source cannot disappear
// merely because it is absent from the host registry. Network IDs are ephemeral.
export function factory_native_power_component(actor: ControlledActor, entity: LuaEntity) {
  const members: Array<Record<string, any>> = []
  const wire_edges: Array<{ from_unit_number: number, to_unit_number: number, from_connector: number, to_connector: number }> = []
  const base = { schema_version: 1, tick: game.tick, identity_scope: 'enclosing_exact_member', scope: 'current_native_electric_component', members, wire_edges }
  let electric_network_id: number | undefined
  const refused = (code: string, truncated = false, state = 'unknown') => ({ ...base, electric_network_id, state, coverage: 'partial', truncated, unresolved: true, code })
  const read = protected_read(() => {
    if (entity.type !== 'electric-pole' && entity.prototype.electric_energy_source_prototype === undefined) return { ...base, state: 'not_applicable', coverage: 'complete', truncated: false, unresolved: false }
    const network = entity.electric_network_id
    if (!finite(network) || network === 0 || math.floor(network) !== network) return refused('electric_network_unavailable')
    electric_network_id = network
    const names: string[] = []
    let scanned = 0
    for (const [name, prototype] of pairs(prototypes.entity)) {
      if (scanned++ >= FACTORY_POWER_LIMITS.prototypes) return refused('electric_prototypes_truncated', true)
      if (prototype.type === 'electric-pole' || prototype.type === 'power-switch' || prototype.electric_energy_source_prototype !== undefined) {
        if (names.length >= FACTORY_POWER_LIMITS.names) return refused('electric_prototype_names_truncated', true)
        names.push(name)
      }
    }
    if (!names.includes(entity.name)) return refused('electric_member_prototype_missing')
    const candidates = find_world_entities(entity.surface, { name: names, limit: FACTORY_POWER_LIMITS.entities + 1 })
    if (candidates.length > FACTORY_POWER_LIMITS.entities) return refused('electric_entities_truncated', true)
    let unresolved: string | undefined
    for (const candidate of candidates) {
      if (!candidate.valid || !area_known_visible(actor.force, candidate.surface, candidate.bounding_box)) { unresolved ??= 'electric_candidate_not_visible'; continue }
      // Switches may join two networks. Do not treat a missing single-network
      // ID as proof that an attached switch is irrelevant.
      if (candidate.type === 'power-switch') {
        let count = 0
        for (const [, connector] of pairs(candidate.get_wire_connectors(false) ?? {})) {
          if (++count > FACTORY_POWER_LIMITS.connectors || connector.connections.length > FACTORY_POWER_LIMITS.connections) return refused('electric_switch_connections_truncated', true)
          for (const connection of connector.connections) {
            const owner = connection.target.owner
            if (!owner.valid || !area_known_visible(actor.force, owner.surface, owner.bounding_box)) unresolved ??= 'electric_switch_connection_unknown'
            else if (owner.electric_network_id === network) unresolved ??= 'electric_switch_component_unsupported'
          }
        }
        continue
      }
      if (candidate.electric_network_id !== network) continue
      if (candidate.unit_number === undefined) { unresolved ??= 'electric_member_identity_unknown'; continue }
      const maximum = number(() => candidate.prototype.get_max_energy_production(candidate.quality))
      const energy = number(() => candidate.energy)
      const source = candidate.prototype.electric_energy_source_prototype
      const priority = source?.usage_priority
      let role = 'unknown'
      if (candidate.type === 'electric-pole') role = 'pole'
      else if (candidate.type === 'accumulator') role = 'storage'
      else if (candidate.type === 'electric-energy-interface') role = 'interface'
      else if (['generator', 'solar-panel'].includes(candidate.type) && maximum.state === 'known' && maximum.value! > 0) role = 'producer'
      else if (maximum.state === 'known' && maximum.value === 0 && ['primary-input', 'secondary-input', 'tertiary'].includes(priority ?? '')) role = 'consumer'
      if (role === 'unknown' || maximum.state !== 'known' || energy.state !== 'known') unresolved ??= 'electric_member_capability_unknown'
      members.push({ ...locator(candidate), role, energy, maximum_energy_production: maximum, usage_priority: priority })
      if (candidate.type === 'electric-pole') {
        let count = 0
        for (const [, connector] of pairs(candidate.get_wire_connectors(false) ?? {})) {
          if (++count > FACTORY_POWER_LIMITS.connectors || connector.connections.length > FACTORY_POWER_LIMITS.connections) return refused('electric_wire_connections_truncated', true)
          for (const connection of connector.connections) {
            // Circuit wires do not carry electric supply.
            const id = connector.wire_connector_id
            if (id !== defines.wire_connector_id.pole_copper) continue
            const target = connection.target.owner
            if (!target.valid || !area_known_visible(actor.force, target.surface, target.bounding_box) || target.unit_number === undefined) { unresolved ??= 'electric_wire_target_unknown'; continue }
            if (target.type !== 'electric-pole' || target.electric_network_id !== network) { unresolved ??= 'electric_wire_component_unsupported'; continue }
            wire_edges.push({ from_unit_number: candidate.unit_number, to_unit_number: target.unit_number, from_connector: id, to_connector: connection.target.wire_connector_id })
          }
        }
      }
    }
    if (!members.some(member => member.unit_number === entity.unit_number)) return refused('electric_member_not_in_component')
    for (const edge of wire_edges) if (!members.some(member => member.unit_number === edge.to_unit_number)) unresolved ??= 'electric_wire_member_missing'
    members.sort((a, b) => a.unit_number - b.unit_number)
    wire_edges.sort((a, b) => a.from_unit_number - b.from_unit_number || a.to_unit_number - b.to_unit_number || a.from_connector - b.from_connector || a.to_connector - b.to_connector)
    if (unresolved) return refused(unresolved)
    return { ...base, electric_network_id, state: 'known', coverage: 'complete', truncated: false, unresolved: false,
      has_storage: members.some(member => member.role === 'storage'), has_interface: members.some(member => member.role === 'interface'),
      capable_producers: members.filter(member => member.role === 'producer').map(member => member.unit_number), scanned_candidates: candidates.length }
  })
  return read ?? refused('electric_component_native_read_failed', false, 'error')
}
