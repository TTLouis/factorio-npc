import { beforeEach, describe, expect, it, vi } from 'vitest'
import { record_hand_crafted_tick, record_hand_insert } from './hand_work'
import { new_output_delivery_proof_controller, tick_output_delivery_proofs } from './output_delivery_proof'

const trace = vi.fn()

function world() {
  const force = { index: 1 }
  const surface = { index: 1 }
  const state = { count: 0, output_count: 0 }
  const chest: any = {
    valid: true, unit_number: 100, name: 'wooden-chest', type: 'container', force, surface,
    position: { x: 2, y: 0 }, get_inventory: () => ({ get_item_count: () => state.count }),
  }
  const recipe = { name: 'automation-science-pack', products: [{ type: 'item', name: 'automation-science-pack', amount: 1 }] }
  const producer: any = {
    valid: true, unit_number: 200, name: 'assembling-machine-1', type: 'assembling-machine', force, surface,
    position: { x: 0, y: 0 }, products_finished: 0,
    get_recipe: () => [recipe, { name: 'normal' }],
    get_output_inventory: () => ({ get_item_count: () => state.output_count }),
  }
  const inserter: any = {
    valid: true, unit_number: 300, name: 'inserter', type: 'inserter', force, surface,
    position: { x: 1, y: 0 }, pickup_target: producer, drop_target: chest,
    held_stack: { valid_for_read: false, name: 'automation-science-pack', count: 0, quality: { name: 'normal' } },
  }
  const entities: any = { 100: chest, 200: producer, 300: inserter }
  ;(globalThis as any).game.get_entity_by_unit_number = (id: number) => entities[id]
  const actor: any = { is_valid: true, force, surface }
  const controller = new_output_delivery_proof_controller(() => actor)
  const spec = {
    proof_id: 'red-proof', request_id: 'red-request', label: 'Red science output',
    chest_unit_number: 100, force_index: 1, surface_index: 1, item_name: 'automation-science-pack',
    lines: [{ producer_unit_number: 200, inserter_unit_number: 300 }], supply_unit_numbers: [400],
  }
  expect(controller.register(spec)).toMatchObject({ ok: true, engine_validated: false })
  function tick(tick: number, action: 'pickup' | 'drop' | 'none' = 'none') {
    ;(globalThis as any).game.tick = tick
    if (action === 'pickup') {
      producer.products_finished++
      inserter.held_stack.valid_for_read = true
      inserter.held_stack.count = 1
    }
    if (action === 'drop') {
      inserter.held_stack.valid_for_read = false
      inserter.held_stack.count = 0
      state.count++
    }
    tick_output_delivery_proofs()
  }
  return { controller, producer, chest, inserter, recipe, state, entities, spec, tick }
}

beforeEach(() => {
  ;(globalThis as any).storage = { sgluna_task_batch_generation: 1 }
  ;(globalThis as any).game.tick = 0
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).prototypes.item['automation-science-pack'] = {}
  ;(globalThis as any).log = trace
  trace.mockClear()
})

describe('conservative native output delivery candidate witness', () => {
  it('requires ten witnessed deliveries in each of five consecutive game-minute buckets', () => {
    const w = world()
    for (let tick = 1; tick <= 18000; tick++) {
      const phase = tick % 360
      w.tick(tick, phase === 100 ? 'pickup' : phase === 101 ? 'drop' : 'none')
    }
    expect(w.controller.status('red-proof')).toMatchObject({
      buckets: [10, 10, 10, 10, 10], successful_minutes: 5,
      candidate_met: true, satisfied: false, engine_validated: false, upstream_automation_verified: false,
    })
    expect(trace).toHaveBeenCalledWith('[AUTORIO] output.minute_verified request_id=red-request reason=native_candidate deliveries=10')
  })

  it('resets the entire witness when one minute falls below ten, even with earlier surplus', () => {
    const w = world()
    for (let tick = 1; tick <= 7200; tick++) {
      const phase = tick % (tick <= 3600 ? 180 : 400)
      w.tick(tick, phase === 100 ? 'pickup' : phase === 101 ? 'drop' : 'none')
    }
    expect(w.controller.status('red-proof')).toMatchObject({ candidate_met: false, successful_minutes: 0, reason: 'deficient_minute' })
  })

  it('rejects manual chest deposits and unrelated production instead of counting inventory growth', () => {
    const w = world()
    w.state.count = 50
    w.tick(1)
    expect(w.controller.status('red-proof')).toMatchObject({ candidate_met: false, reason: 'unexplained_chest_mutation' })
    expect(trace).toHaveBeenCalledWith('[AUTORIO] output.proof_reset request_id=red-request reason=unexplained_chest_mutation')
  })

  it('invalidates supplying-line manual inserts and hand-crafted output through existing actor accounting', () => {
    const w = world()
    record_hand_insert(1, 'copper-plate', 'assembling-machine-1', 'assembling-machine', false, w.producer)
    expect(w.controller.status('red-proof')).toMatchObject({ reason: 'manual_supply_or_output_mutation', successful_minutes: 0 })
    record_hand_insert(1, 'coal', 'assembling-machine-1', 'assembling-machine', true, w.producer)
    expect(w.controller.status('red-proof').reason).toBe('manual_supply_or_output_mutation')
    record_hand_crafted_tick(1, 'automation-science-pack')
    expect(w.controller.status('red-proof')).toMatchObject({ reason: 'manual_output_craft' })
  })

  it('does not replace a destroyed output with a chest at the same coordinates', () => {
    const w = world()
    w.chest.valid = false
    w.entities[100] = { ...w.chest, valid: true, unit_number: 101 }
    w.tick(1)
    expect(w.controller.status('red-proof')).toMatchObject({ candidate_met: false, reason: 'output_identity_changed' })
  })

  it('declines topology changes, disconnected sampling and attached humans', () => {
    const w = world()
    w.inserter.drop_target = { ...w.chest, unit_number: 101 }
    w.tick(1)
    expect(w.controller.status('red-proof').reason).toBe('supplying_line_changed')
    w.inserter.drop_target = w.chest
    w.tick(2)
    w.tick(4)
    expect(w.controller.status('red-proof').reason).toBe('sampling_gap_or_clock_changed')
    ;(globalThis as any).game.connected_players = [{}]
    w.tick(5)
    expect(w.controller.status('red-proof').reason).toBe('connected_humans_unsupported')
  })

  it('does not credit hand depletion without newly finished production from the bound source', () => {
    const w = world()
    w.inserter.held_stack.valid_for_read = true
    w.inserter.held_stack.count = 1
    w.tick(1)
    w.tick(2, 'drop')
    expect(w.controller.status('red-proof')).toMatchObject({ candidate_met: false, reason: 'unproven_source_output' })
  })

  it('clears the candidate window across a synchronized save generation change', () => {
    const w = world()
    w.tick(1)
    ;(globalThis as any).storage.sgluna_task_batch_generation = 2
    expect(w.controller.status('red-proof')).toMatchObject({ reason: 'save_generation_changed', successful_minutes: 0, candidate_met: false })
  })
})
