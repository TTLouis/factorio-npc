import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execute_removal, inspect_removal, removal_fits, removal_snapshot } from './entity_removal_receipt'
import { new_basic_operation_controller } from './basic_operations'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_operation_admission } from './operation_admission'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

const G = globalThis as any
const WORLD = '11111111-1111-4111-8111-111111111111'
// Synthetic software fixtures. Product quantities are supplied native facts,
// not authored game recipes or removal yields.
function inventory(size: number) {
  const inv: any = { valid: true, index: 1, length: size, supports_filters: () => false, supports_bar: () => false }
  const stack = (name: string, count: number, quality = 'normal') => ({ valid_for_read: true, name, count, quality: { name: quality }, type: 'item', health: 1, prototype: {} })
  inv.put = (slot: number, name: string, count: number, quality = 'normal') => { inv[slot] = stack(name, count, quality) }
  for (let i = 0; i < size; i++) inv[i] = { valid_for_read: false }
  inv.get_insertable_count = ({ name, quality }: any) => {
    let room = 0
    for (let i = 0; i < size; i++) {
      if (!inv[i].valid_for_read) room += G.prototypes.item[name].stack_size
      else if (inv[i].name === name && inv[i].quality.name === quality) room += G.prototypes.item[name].stack_size - inv[i].count
    }
    return room
  }
  return inv
}
function fixture() {
  const contents = inventory(2)
  contents.put(0, 'payload', 2, 'uncommon')
  const held = inventory(6)
  const force = { index: 1, manual_mining_speed_modifier: 0, is_chunk_visible: () => true }
  const surface: any = { index: 1, find_entities_filtered: () => [] }
  const target: any = { valid: true, unit_number: 91, name: 'fixture-container', type: 'container', minable: true,
    position: { x: 2, y: 0 }, quality: { name: 'uncommon' }, force, surface, status: 0, fluids_count: 0,
    bounding_box: { left_top: { x: 1.5, y: -0.5 }, right_bottom: { x: 2.5, y: 0.5 } },
    get_max_inventory_index: () => 1, get_inventory: () => contents,
    prototype: { is_building: true, is_entity_with_owner: true, fluidbox_prototypes: [],
      mineable_properties: { minable: true, mining_time: 0.2, products: [{ type: 'item', name: 'building', amount: 1, independent_probability: 1, shared_probability: { min: 0, max: 1 } }] } },
  }
  target.mine = vi.fn(() => { held.put(0, 'payload', 2, 'uncommon'); held.put(1, 'building', 1, 'uncommon'); target.valid = false; return true })
  const actor: any = { is_valid: true, surface, force, position: { x: 0, y: 0 },
    character: { valid: true, reach_distance: 10, prototype: { mining_speed: 1 } },
    get_main_inventory: () => held, status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character' }),
    get_mining_state: () => ({ mining: false }), set_mining_state: vi.fn(), set_walking_state: vi.fn(), set_shooting_state: vi.fn(), owns_player_index: () => false,
  }
  let epoch = 1
  G.remote = { interfaces: { sgluna_deployment: { status: true, authorize: true } }, call: (_name: string, method: string, expected: number) => method === 'status'
    ? { allowed: true, actor_id: 42, epoch, session: 'removal-session' } : expected === epoch }
  G.game.get_entity_by_unit_number = (id: number) => id === 91 && target.valid ? target : undefined
  const manager = new_task_manager(() => actor)
  const controller = new_basic_operation_controller(() => actor, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  const admission = new_operation_admission(() => actor, () => manager.get_status_snapshot())
  const correlation = { operation_key: 'remove/one', attempt_id: 'attempt-1', actor_id: 42, epoch: 1, signature: 'exact91', ordinal: 1, operation_count: 1, surface_index: 1 }
  const submit = () => {
    expect(admission.begin(correlation).ok).toBe(true)
    expect(controller.submit_mining_exact(91)).toBe(true)
    const batch = manager.get_status_snapshot().active_batch!
    expect(admission.slot(correlation.operation_key, 1, { ok: true, operation: 'mine_entity_exact', batch_refs: [batch] }).ok).toBe(true)
    expect(admission.finish(correlation.operation_key, { ok: true }).ok).toBe(true)
  }
  return { target, contents, held, actor, manager, controller, runtime, admission, correlation, submit, changeEpoch: () => { epoch++ } }
}
beforeEach(() => {
  G.storage = { sgluna_factory_world_id: WORLD }
  G.game.tick = 100
  G.defines.entity_status = { working: 1 }
  G.prototypes.item = { building: { type: 'item', stack_size: 10 }, payload: { type: 'item', stack_size: 10 } }
  G.prototypes.entity['fixture-container'] = { type: 'container' }
})

describe('native exact-building custody', () => {
  it('rejects combined capacity although each independent item fits', () => {
    const f = fixture(); const one = inventory(1)
    const snapshot = removal_snapshot(f.target)
    expect(one.get_insertable_count({ name: 'building', quality: 'uncommon' })).toBeGreaterThan(0)
    expect(one.get_insertable_count({ name: 'payload', quality: 'uncommon' })).toBeGreaterThan(2)
    expect(removal_fits(one, snapshot)).toBe(false)
    expect(inspect_removal(f.target, one)).toEqual({ ok: false, code: 'removal_inventory_full' })
    expect(f.target.mine).not.toHaveBeenCalled()
  })
  it.each(['fluid', 'metadata', 'random-products', 'filters', 'process'])('refuses unsupported or loss-bearing %s before mutation', mode => {
    const f = fixture()
    if (mode === 'fluid') Object.assign(f.target, { fluids_count: 1, get_fluid: () => ({ name: 'native-fluid', amount: 1 }) })
    if (mode === 'metadata') f.contents[0].type = 'blueprint'
    if (mode === 'random-products') f.target.prototype.mineable_properties.products[0].independent_probability = 0.5
    if (mode === 'filters') { f.held.supports_filters = () => true; f.held.get_filter = () => ({ name: 'building' }) }
    if (mode === 'process') { f.target.type = 'assembling-machine'; f.target.crafting_progress = 0.25 }
    expect(inspect_removal(f.target, f.held).ok).toBe(false)
    expect(f.target.mine).not.toHaveBeenCalled()
  })
  it('does not accept a true native return or vanished target without recovered products', () => {
    const f = fixture(); const before = removal_snapshot(f.target)
    f.target.mine.mockImplementation(() => { f.target.valid = false; return true })
    const receipt: any = { state: 'prepared', before, actor_before: [], native_call: 'not_attempted' }
    execute_removal(f.actor, f.target, f.held, receipt)
    expect(receipt).toMatchObject({ state: 'partial', native_call: 'returned_true', target_gone: true, recovered_items: [] })
  })
  it('retains actual partial transfer when native mine returns false', () => {
    const f = fixture(); const before = removal_snapshot(f.target)
    f.target.mine.mockImplementation(() => { f.held.put(0, 'payload', 1, 'uncommon'); f.contents[0].count = 1; return false })
    const receipt: any = { state: 'prepared', before, actor_before: [], native_call: 'not_attempted' }
    execute_removal(f.actor, f.target, f.held, receipt)
    expect(receipt).toMatchObject({ state: 'partial', native_call: 'returned_false', target_gone: false,
      recovered_items: [{ name: 'payload', quality: 'uncommon', count: 1 }], after: { contents: [{ count: 1 }] } })
  })
})

describe('real exact-building task and existing admission lifecycle', () => {
  it('waits native mining duration then durably exposes verified quality-aware custody in both existing receipts', () => {
    const f = fixture(); f.submit(); f.runtime.state_mining(f.actor)
    expect(f.target.mine).not.toHaveBeenCalled()
    expect(f.admission.status('remove/one').records[0].entity_removal?.state).toBe('prepared')
    G.game.tick = 111; f.runtime.state_mining(f.actor); expect(f.target.mine).not.toHaveBeenCalled()
    G.game.tick = 112; f.runtime.state_mining(f.actor)
    const receipt = f.controller.status().last_result?.entity_removal
    expect(receipt).toMatchObject({ state: 'verified', code: 'removal_custody_verified', world_id: WORLD,
      target_gone: true, native_call: 'returned_true', binding: { operation_key: 'remove/one', epoch: 1, session: 'removal-session' },
      recovered_items: [{ name: 'payload', quality: 'uncommon', count: 2 }, { name: 'building', quality: 'uncommon', count: 1 }] })
    expect(f.admission.status('remove/one').records[0].entity_removal).toEqual(receipt)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.target.mine).toHaveBeenCalledTimes(1)
    expect(f.admission.begin(f.correlation)).toMatchObject({ ok: true, duplicate: true })
  })
  it.each(['disappearance', 'contents-change', 'stale-epoch', 'cancel', 'restart'])('does not repeat or invent success after %s', mode => {
    const f = fixture(); f.submit(); f.runtime.state_mining(f.actor)
    if (mode === 'disappearance') f.target.valid = false
    if (mode === 'contents-change') f.contents[0].count++
    if (mode === 'stale-epoch') f.changeEpoch()
    if (mode === 'cancel') f.manager.cancel_all_tasks('operator-stop')
    if (mode === 'restart') f.manager.reconcile_startup('new-deployment-session')
    G.game.tick = 200; f.runtime.state_mining(f.actor)
    const record = f.admission.status('remove/one').records[0]
    expect(record.entity_removal?.state).not.toBe('verified')
    expect(f.target.mine).not.toHaveBeenCalled()
    if (mode === 'restart') expect(record.state).toBe('uncertain')
  })
  it('refuses a bare exact-building call without native admission authority', () => {
    const f = fixture(); f.controller.submit_mining_exact(91); f.runtime.state_mining(f.actor)
    expect(f.controller.status().last_result?.code).toBe('entity_removal_uncertain')
    expect(f.target.mine).not.toHaveBeenCalled()
  })
  it('retains an injected partial native effect through actual failure and admission settlement without repeating it', () => {
    const f = fixture(); f.submit(); f.runtime.state_mining(f.actor)
    f.target.mine.mockImplementation(() => { f.held.put(0, 'payload', 1, 'uncommon'); f.contents[0].count = 1; return false })
    G.game.tick = 112; f.runtime.state_mining(f.actor)
    expect(f.controller.status().last_result).toMatchObject({ completed: false, code: 'entity_removal_uncertain',
      entity_removal: { state: 'partial', target_gone: false, native_call: 'returned_false', recovered_items: [{ count: 1 }] } })
    expect(f.admission.status('remove/one').records[0].entity_removal?.state).toBe('partial')
    G.game.tick = 200; f.runtime.state_mining(f.actor)
    expect(f.target.mine).toHaveBeenCalledTimes(1)
  })
})
