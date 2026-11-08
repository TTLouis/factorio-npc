import { beforeEach, expect, it } from 'vitest'
import { apply_starter_sample, note_starter_servicing, STARTER_OBSERVATION_TICKS, STARTER_SAMPLE_TICKS } from './starter_base_acceptance'
import { record_hand_insert } from './hand_work'

function window() {
  return { version: 1, force_index: 1, bindings: {}, entities: {}, buckets: 0, delivered: false,
    capabilities: {}, replenished: {}, satisfied: false, reason: '', spec: { science_item: 'synthetic-science', technology: 'synthetic-research',
      supply_items: ['synthetic-supply'], construction_stocks: [{ item_name: 'synthetic-stock', minimum: 5 }] } } as any
}
function sample(tick: number, service = 0) {
  return { tick, service, science: tick, research: tick / STARTER_OBSERVATION_TICKS,
    labs: { 21: tick }, stock: { 'synthetic-stock': tick },
    produced: { 'synthetic-supply': tick, 'synthetic-stock': tick },
    inputs: { 'synthetic-input': tick },
    capabilities: { power: true, extraction: true, smelting: true, transport: true, assembly: true, lab: true } }
}
beforeEach(() => { (globalThis as any).storage = {} })

it('requires the complete observation, fresh lab delivery, completed research and replenished declared stock', () => {
  const held = window()
  for (let tick = 0; tick < STARTER_OBSERVATION_TICKS; tick += STARTER_SAMPLE_TICKS) apply_starter_sample(held, sample(tick))
  expect(held.satisfied).toBe(false)
  apply_starter_sample(held, sample(STARTER_OBSERVATION_TICKS))
  expect(held.satisfied).toBe(true)
  expect(held.buckets).toBe(5)
})

it.each(['manual_service', 'sampling_gap', 'lab_replaced', 'no_supply', 'no_stock', 'research_unfinished', 'no_lab_delivery', 'no_input_replenishment'])('rejects %s instead of inheriting earlier output', (reason) => {
  const held = window()
  for (let tick = 0; tick <= STARTER_OBSERVATION_TICKS; tick += STARTER_SAMPLE_TICKS) {
    const row = sample(tick)
    if (reason === 'manual_service' && tick > STARTER_OBSERVATION_TICKS / 2) row.service = 1
    if (reason === 'sampling_gap' && tick === STARTER_SAMPLE_TICKS) continue
    if (reason === 'lab_replaced' && tick > 0) row.labs = {} as any
    if (reason === 'no_supply') row.produced['synthetic-supply'] = 0
    if (reason === 'no_stock') row.stock['synthetic-stock'] = 0
    if (reason === 'research_unfinished') row.research /= 2
    if (reason === 'no_lab_delivery') row.labs[21] = 0
    if (reason === 'no_input_replenishment') row.inputs['synthetic-input'] = 10
    apply_starter_sample(held, row)
  }
  expect(held.satisfied).toBe(false)
})

it('fuel and lab hand insertions invalidate this window despite legacy production-rate exclusions', () => {
  note_starter_servicing(1)
  record_hand_insert(1, 'synthetic-fuel', 'synthetic-burner', 'furnace', true)
  record_hand_insert(1, 'synthetic-science', 'synthetic-lab', 'lab', false)
  expect((globalThis as any).storage.sgluna_starter_service[1]).toBe(3)
})
