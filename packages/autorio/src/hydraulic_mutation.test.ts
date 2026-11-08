import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hydraulic_mutation_preflight } from './hydraulic_mutation'
import { new_basic_operation_controller } from './basic_operations'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_orientation_runtime } from './orientation_runtime'
import { new_operation_admission } from './operation_admission'
import { new_task_manager } from './task_manager'

const G = globalThis as any
const WORLD = '11111111-1111-4111-8111-111111111111'
const originalEntityPrototypes = G.prototypes.entity
// Synthetic native telemetry: no game recipe, throughput or mining yield is
// inferred. The fixture declares an empty custom hydraulic prototype and its
// current native ports, custody product and inventory capacities.
function fixture() {
  const force = { index: 1, manual_mining_speed_modifier: 0, is_chunk_visible: () => true }
  const entities: any[] = []
  const surface: any = { index: 1, find_entities_filtered: () => entities, can_place_entity: () => true }
  const box = { index: 1, production_type: 'input-output', get_volume: () => 10,
    pipe_connections: [{ connection_type: 'normal', flow_direction: 'input-output', direction: 4,
      positions: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }] }
  const prototype = { name: 'fixture-hydraulic', type: 'pipe', tile_width: 1, tile_height: 1,
    collision_box: { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } },
    fluidbox_prototypes: [box], is_building: true, is_entity_with_owner: true,
    mineable_properties: { minable: true, mining_time: 0.2,
      products: [{ type: 'item', name: 'fixture-building', amount: 1, independent_probability: 1, shared_probability: { min: 0, max: 1 } }] } }
  function entity(id: number, x: number, direction = 0) {
    const e: any = { valid: true, name: prototype.name, type: 'pipe', unit_number: id, position: { x, y: 0 }, direction,
      prototype, surface, force, status: 0, minable: true, quality: { name: 'normal' }, fluids_count: 1,
      bounding_box: { left_top: { x: x - 0.4, y: -0.4 }, right_bottom: { x: x + 0.4, y: 0.4 } },
      supports_direction: true, rotatable: true, get_fluid: () => undefined, get_fluid_count: () => 0,
      has_fluid_segment: () => true, get_fluid_segment_id: () => 1,
      get_fluid_segment_filter: () => undefined, get_fluid_segment_fluid: () => undefined,
      get_fluid_capacity: () => 10, get_fluid_box_prototype: () => box,
      get_max_inventory_index: () => 0, get_inventory: () => undefined }
    e.get_fluid_box_pipe_connections = () => {
      const delta = e.direction === 0 ? { x: 1, y: 0 } : e.direction === 4 ? { x: 0, y: 1 }
        : e.direction === 8 ? { x: -1, y: 0 } : { x: 0, y: -1 }
      const position = { ...e.position }, target_position = { x: position.x + delta.x, y: position.y + delta.y }
      const target = entities.find(other => other !== e && other.valid && other.position.x === target_position.x && other.position.y === target_position.y)
      return [{ connection_type: 'normal', flow_direction: 'input-output', position, target_position,
        ...(target ? { target, target_fluidbox_index: 1 } : {}) }]
    }
    e.rotate = vi.fn(({ reverse }: { reverse: boolean }) => { e.direction = (e.direction + (reverse ? 12 : 4)) % 16; return true })
    entities.push(e)
    return e
  }
  const target = entity(91, 2)
  const inventory: any = { valid: true, index: 1, length: 4,
    supports_filters: () => false, supports_bar: () => false, get_insertable_count: () => 40 }
  for (let slot = 0; slot < inventory.length; slot++) inventory[slot] = { valid_for_read: false }
  target.mine = vi.fn(() => {
    inventory[0] = { valid_for_read: true, name: 'fixture-building', count: 1, quality: { name: 'normal' }, type: 'item', health: 1, prototype: {} }
    target.valid = false
    return true
  })
  const actor: any = { is_valid: true, force, surface, position: { x: 0, y: 0 },
    character: { valid: true, reach_distance: 10, prototype: { mining_speed: 1 } },
    status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character' }), get_main_inventory: () => inventory,
    get_mining_state: () => ({ mining: false }), set_mining_state: vi.fn(), set_walking_state: vi.fn(), set_shooting_state: vi.fn(), owns_player_index: () => false }
  G.prototypes.entity[prototype.name] = prototype
  G.game.get_entity_by_unit_number = (id: number) => entities.find(e => e.valid && e.unit_number === id)
  const manager = new_task_manager(() => actor)
  const controller = new_basic_operation_controller(() => actor, manager)
  const orientation = new_orientation_runtime(manager, controller)
  const runtime = new_basic_operation_runtime(manager, controller)
  const admission = new_operation_admission(() => actor, manager.get_status_snapshot)
  G.remote = { interfaces: { sgluna_deployment: { status: true, authorize: true } }, call: (_name: string, method: string, epoch: number) => method === 'status'
    ? { allowed: true, actor_id: 42, epoch: 1, session: 'hydraulic-test' } : epoch === 1 }
  const submitRemoval = (guard = false) => {
    expect(admission.begin({ operation_key: 'remove/one', attempt_id: 'attempt', actor_id: 42, epoch: 1,
      signature: 'exact-91', ordinal: 1, operation_count: 1, surface_index: 1 }).ok).toBe(true)
    const accepted = controller.submit_mining_exact(91, guard)
    if (accepted) {
      const batch = manager.get_status_snapshot().active_batch!
      admission.slot('remove/one', 1, { ok: true, operation: 'mine_entity_exact', batch_refs: [batch] })
      admission.finish('remove/one', { ok: true })
    }
    return accepted
  }
  return { target, actor, entities, controller, orientation, runtime, manager, submitRemoval,
    connect: () => entity(92, 3, 8) }
}

beforeEach(() => {
  G.prototypes.entity = {}
  G.storage = { sgluna_factory_world_id: WORLD,
    sgluna_fluid_preservation_history: { version: 1, origin: 'native_on_init', tick: 0, claim_count: 0 } }
  G.game.tick = 100
  G.defines.entity_status = { working: 1 }
  G.prototypes.item['fixture-building'] = { type: 'item', stack_size: 10 }
})
afterEach(() => { G.prototypes.entity = originalEntityPrototypes })

describe('native hydraulic mutation evidence', () => {
  it('admits an empty unprotected custom hydraulic target with a complete fresh network witness', () => {
    const f = fixture()
    expect(hydraulic_mutation_preflight(f.actor, 'rotate_entity', 91).ok).toBe(true)
    expect(f.controller.submit_rotate_exact(91, false, false)[0]).toBe(true)
    expect(f.orientation.state_rotating(f.actor)[0]).toBe(true)
    expect(f.target.rotate).toHaveBeenCalledTimes(1)
    expect(f.controller.status().last_result?.hydraulic_guard).toMatchObject({ version: 1, operation: 'rotate_entity',
      unit_number: 91, world_id: WORLD, actor_id: 42, epoch: 1, claim_count: 0 })
  })

  it('removes an empty unprotected hydraulic target only with the admitted native custody receipt', () => {
    const f = fixture()
    expect(f.submitRemoval(false)).toBe(true)
    f.runtime.state_mining(f.actor)
    expect(f.target.mine).not.toHaveBeenCalled()
    G.game.tick = 112
    f.runtime.state_mining(f.actor)
    expect(f.target.mine).toHaveBeenCalledTimes(1)
    expect(f.controller.status().last_result?.entity_removal).toMatchObject({ state: 'verified', target_gone: true,
      hydraulic_guard: { version: 1, operation: 'mine_entity_exact', unit_number: 91, world_id: WORLD, actor_id: 42, epoch: 1, claim_count: 0 },
      recovered_items: [{ name: 'fixture-building', count: 1, quality: 'normal' }] })
  })

  it('accepts passive pipe working status only with empty fresh hydraulic and custody evidence', () => {
    const f = fixture()
    f.target.status = G.defines.entity_status.working
    expect(hydraulic_mutation_preflight(f.actor, 'mine_entity_exact', 91).ok).toBe(true)
    expect(f.submitRemoval(false)).toBe(true)
    f.runtime.state_mining(f.actor)
    G.game.tick = 112
    f.runtime.state_mining(f.actor)
    expect(f.target.mine).toHaveBeenCalledTimes(1)
    expect(f.controller.status().last_result?.entity_removal).toMatchObject({ state: 'verified', target_gone: true })
  })

  it('still refuses fluid in a passive pipe whose native status is working', () => {
    const f = fixture()
    f.target.status = G.defines.entity_status.working
    f.target.get_fluid = () => ({ name: 'fixture-fluid', amount: 1 })
    expect(hydraulic_mutation_preflight(f.actor, 'mine_entity_exact', 91)).toMatchObject({ ok: false, code: 'hydraulic_network_not_empty' })
    expect(f.submitRemoval(false)).toBe(false)
    expect(f.target.mine).not.toHaveBeenCalled()
  })

  it('continues refusing working processors instead of treating working status as passive', () => {
    const f = fixture()
    f.target.type = 'assembling-machine'
    f.target.status = G.defines.entity_status.working
    expect(hydraulic_mutation_preflight(f.actor, 'mine_entity_exact', 91)).toMatchObject({ ok: false, code: 'hydraulic_network_active' })
    expect(f.submitRemoval(false)).toBe(false)
    expect(f.target.mine).not.toHaveBeenCalled()
  })

  it.each(['missing', 'legacy', 'wrong-count'])('refuses %s claim history even when the target is empty', fault => {
    const f = fixture()
    if (fault === 'missing') delete G.storage.sgluna_fluid_preservation_history
    if (fault === 'legacy') G.storage.sgluna_fluid_preservation_history.origin = 'legacy'
    if (fault === 'wrong-count') G.storage.sgluna_fluid_preservation_history.claim_count = 1
    expect(hydraulic_mutation_preflight(f.actor, 'rotate_entity', 91)).toMatchObject({ ok: false, code: 'hydraulic_history_unproven' })
    expect(f.controller.submit_rotate_exact(91, false, false)[0]).toBe(false)
    expect(f.target.rotate).not.toHaveBeenCalled()
  })

  it('rechecks an empty network changed after rotation queued, without an external flag bypass', () => {
    const f = fixture()
    expect(f.controller.submit_rotate_exact(91, false, false)[0]).toBe(true)
    f.connect()
    expect(f.orientation.state_rotating(f.actor)[0]).toBe(false)
    expect(f.target.rotate).not.toHaveBeenCalled()
    expect(f.controller.status().last_result).toMatchObject({ completed: false, code: 'hydraulic_mutation_refused', hydraulic_reason: 'hydraulic_witness_changed' })
  })

  it('cannot bypass native history or a missing frozen witness by clearing optional task flags', () => {
    const f = fixture()
    expect(f.controller.submit_rotate_exact(91, false, false)[0]).toBe(true)
    const task = f.manager.player_state.parameters_rotate_entity!
    task.external_world_guard = false
    task.hydraulic_guard = undefined
    expect(f.orientation.state_rotating(f.actor)[0]).toBe(false)
    expect(f.target.rotate).not.toHaveBeenCalled()
  })

  it('retains custody and refuses an empty network changed after exact removal queued', () => {
    const f = fixture()
    expect(f.submitRemoval(false)).toBe(true)
    f.runtime.state_mining(f.actor)
    f.connect()
    G.game.tick = 200
    f.runtime.state_mining(f.actor)
    expect(f.target.mine).not.toHaveBeenCalled()
    expect(f.target.valid).toBe(true)
    expect(f.controller.status().last_result?.entity_removal).toMatchObject({ state: 'refused', code: 'hydraulic_witness_changed' })
  })
})
