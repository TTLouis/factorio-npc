import type { ControlledActor } from './actors/types'
import type { LuaEntity } from 'factorio:runtime'
import { protected_read } from './electric_facts'
import { resolve_visible_entity_reference, remember_entity_reference } from './entity_reference'
import { preservation_geometry_for_actor } from './knowledge'
import { hydraulic_claim_protection } from './placement_candidates'
import { area_known_visible } from './map_knowledge'
import { find_world_entities } from './npc_vision'
import { factory_world_identity } from './factory_cell_observation'
import { vector_xy } from './placement_geometry'

export interface HydraulicMutationWitness {
  version: 1
  operation: string
  unit_number: number
  world_id: string
  actor_id: number
  epoch: number
  session: string
  claim_count: number
  network: any[]
  envelope: { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }
  prototype_ports: any[]
  neighbour_prototypes?: { count: number, margin: number }
}
const MAX_NETWORK = 16
const MAX_NEIGHBOURS = 64
const finite = (v: unknown): v is number => typeof v === 'number' && v === v && v !== math.huge && v !== -math.huge
const positive = (v: unknown): v is number => finite(v) && v > 0 && math.floor(v) === v
function fail(code: string) { return { ok: false as const, code } }

// The rotation envelope covers every prototype port position and the rotated
// footprint, not one guessed successor direction. Any network that could join
// through that envelope is included in the same empty/unprotected proof.
function rotation_envelope(entity: LuaEntity) {
  const boxes = entity.prototype.fluidbox_prototypes
  if (!boxes || boxes.length > 16) return undefined
  const collision = entity.prototype.collision_box
  const corners = [vector_xy(collision.left_top), vector_xy(collision.right_bottom)]
  if (corners.some(p => !p)) return undefined
  let radius = 0
  for (const p of corners) radius = math.max(radius, math.sqrt(p!.x ** 2 + p!.y ** 2))
  const ports: any[] = []
  for (const box of boxes) {
    const connections = box.pipe_connections
    if (!connections || connections.length > 16) return undefined
    for (const connection of connections) {
      if (connection.connection_type !== 'normal' || !connection.positions || connection.positions.length < 1 || connection.positions.length > 4) return undefined
      const positions = []
      for (const raw of connection.positions) {
        const p = vector_xy(raw)
        if (!p) return undefined
        radius = math.max(radius, math.sqrt(p.x ** 2 + p.y ** 2))
        positions.push(p)
      }
      ports.push({ storage: box.index, type: connection.connection_type, direction: connection.direction, positions })
      if (ports.length > 16) return undefined
    }
  }
  if (!finite(radius) || radius > 64) return undefined
  radius += 2
  return { ports, area: { left_top: { x: entity.position.x - radius, y: entity.position.y - radius },
    right_bottom: { x: entity.position.x + radius, y: entity.position.y + radius } } }
}

// A modded neighbour may put its normal port outside its own collision box.
// Derive the search margin from the complete current prototype set, rather than
// assuming all neighbouring ports belong to entities within two tiles.
function neighbour_search_margin() {
  let count = 0; let margin = 0
  for (const [, prototype] of pairs(prototypes.entity)) {
    count++
    if (count > 4096) return undefined
    const boxes = prototype.fluidbox_prototypes
    if (!boxes || boxes.length > 16) return undefined
    for (const box of boxes) {
      const connections = box.pipe_connections
      if (!connections || connections.length > 16) return undefined
      for (const connection of connections) {
        // A new normal port cannot create an underground/linked connection.
        if (connection.connection_type !== 'normal') continue
        if (!connection.positions || connection.positions.length < 1 || connection.positions.length > 4) return undefined
        for (const raw of connection.positions) {
          const p = vector_xy(raw)
          if (!p) return undefined
          margin = math.max(margin, math.sqrt(p.x ** 2 + p.y ** 2))
          if (!finite(margin) || margin > 64) return undefined
        }
      }
    }
  }
  return count > 0 ? { count, margin } : undefined
}

function prove(actor: ControlledActor, operation: string, entity: LuaEntity) {
  const boxes = entity.prototype.fluidbox_prototypes
  if (!boxes || !finite(entity.fluids_count) || entity.fluids_count < 0 || entity.fluids_count > 16 || boxes.length > 16) return fail('hydraulic_target_unreadable')
  if (boxes.length === 0 && entity.fluids_count === 0) return { ok: true as const, witness: undefined }
  if (!['rotate_entity', 'mine_entity_exact'].includes(operation)) return fail('hydraulic_operation_unsupported')
  const world = factory_world_identity()
  if (!world.ok || !world.world_id || !remote.interfaces.sgluna_deployment?.status) return fail('hydraulic_owner_unproven')
  const owner: any = remote.call('sgluna_deployment', 'status')
  const session: unknown = owner.session
  if (owner.allowed !== true || owner.actor_id !== actor.status_snapshot().actor_id || !positive(owner.epoch)
    || typeof session !== 'string' || session.length < 1 || session.length > 240) return fail('hydraulic_owner_unproven')
  const rotation = rotation_envelope(entity)
  if (!rotation) return fail('hydraulic_geometry_unproven')
  const neighbours = operation === 'rotate_entity' ? neighbour_search_margin() : undefined
  if (operation === 'rotate_entity' && !neighbours) return fail('hydraulic_neighbour_prototypes_unproven')
  const envelope = operation === 'rotate_entity' ? {
    left_top: { x: rotation.area.left_top.x - neighbours!.margin, y: rotation.area.left_top.y - neighbours!.margin },
    right_bottom: { x: rotation.area.right_bottom.x + neighbours!.margin, y: rotation.area.right_bottom.y + neighbours!.margin },
  } : entity.bounding_box
  if (!envelope || !area_known_visible(actor.force, actor.surface, envelope)) return fail('hydraulic_envelope_not_visible')
  const pending: number[] = [entity.unit_number!]
  if (operation === 'rotate_entity') {
    const nearby = find_world_entities(actor.surface, { area: envelope, limit: MAX_NEIGHBOURS + 1 })
    if (nearby.length > MAX_NEIGHBOURS) return fail('hydraulic_neighbour_scan_truncated')
    for (const other of nearby) {
      const prototype_boxes = other.prototype.fluidbox_prototypes
      if (!prototype_boxes) return fail('hydraulic_neighbour_unreadable')
      if (other.fluids_count === 0 && prototype_boxes.length === 0) continue
      if (!positive(other.unit_number)) return fail('hydraulic_neighbour_identity_unproven')
      remember_entity_reference(other)
      if (!pending.includes(other.unit_number)) pending.push(other.unit_number)
    }
  }
  const network: any[] = []
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > MAX_NETWORK) return fail('hydraulic_network_over_limit')
    const resolved = resolve_visible_entity_reference(actor, pending[index], 'actor_body').entity
    if (!resolved?.valid || resolved.force.index !== actor.force.index || resolved.surface.index !== actor.surface.index) return fail('hydraulic_network_scope_unproven')
    // Passive native pipes/tanks report working without processing materials.
    // Their complete geometry and empty-fluid custody checks still apply below.
    if (resolved.status === defines.entity_status.working && !['pipe', 'storage-tank'].includes(resolved.type)) return fail('hydraulic_network_active')
    if (['assembling-machine', 'furnace', 'rocket-silo'].includes(resolved.type) && resolved.crafting_progress > 0) return fail('hydraulic_process_in_flight')
    if (!finite(resolved.fluids_count) || resolved.fluids_count < 0 || resolved.fluids_count > 16) return fail('hydraulic_network_unreadable')
    for (let storage = 1; storage <= resolved.fluids_count; storage++) if (resolved.get_fluid(storage) !== undefined) return fail('hydraulic_network_not_empty')
    const geometry = preservation_geometry_for_actor(actor, pending[index])
    if (!geometry) return fail('hydraulic_network_geometry_unproven')
    network.push(geometry)
    const storages: any[] = geometry.fluid_storages
    for (const storage of storages) for (const port of storage.pipe_connections as any[]) {
      if (!port.connected) continue
      if (!positive(port.target?.unit_number)) return fail('hydraulic_edge_identity_unproven')
      if (!pending.includes(port.target.unit_number)) pending.push(port.target.unit_number)
    }
  }
  network.sort((a, b) => a.entity.unit_number - b.entity.unit_number)
  const protection = hydraulic_claim_protection(actor, network, envelope)
  if (!protection.ok) return protection
  const witness: HydraulicMutationWitness = { version: 1, operation, unit_number: entity.unit_number!, world_id: world.world_id,
    actor_id: owner.actor_id, epoch: owner.epoch, session, claim_count: protection.claim_count,
    network, envelope, prototype_ports: rotation.ports, neighbour_prototypes: neighbours }
  return { ok: true as const, witness }
}

export function hydraulic_mutation_preflight(actor: ControlledActor | undefined, operation: string, unit_number: number) {
  if (!actor?.is_valid || !positive(unit_number)) return fail('hydraulic_target_unreadable')
  return protected_read(() => {
    const entity = resolve_visible_entity_reference(actor, unit_number, 'actor_body').entity
    if (!entity?.valid || entity.unit_number !== unit_number || entity.surface.index !== actor.surface.index || entity.force.index !== actor.force.index) return fail('hydraulic_exact_target_unproven')
    return prove(actor, operation, entity)
  }) ?? fail('hydraulic_native_read_failed')
}

export function hydraulic_mutation_matches(actor: ControlledActor, operation: string, unit_number: number, frozen: HydraulicMutationWitness | undefined) {
  const fresh = hydraulic_mutation_preflight(actor, operation, unit_number)
  if (!fresh.ok) return fresh
  if (fresh.witness === undefined && frozen === undefined) return { ok: true as const }
  if (!fresh.witness || !frozen || helpers.table_to_json(fresh.witness) !== helpers.table_to_json(frozen)) return fail('hydraulic_witness_changed')
  return { ok: true as const }
}
