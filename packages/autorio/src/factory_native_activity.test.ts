import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { factory_native_consumers, factory_native_fuels, factory_native_item_topology, factory_native_progress } from './factory_native_activity'

const G = globalThis as any
const originalPrototypes = G.prototypes
const raises = () => { throw new Error('synthetic native getter failure') }
function fixture() {
  const force: any = { index: 1, is_chunk_visible: () => true }
  const surface: any = { index: 1, find_entities_filtered: vi.fn(() => []) }
  const entity: any = { valid: true, type: 'container', name: 'fixture-container', unit_number: 8, surface, force,
    position: { x: 0, y: 0 }, bounding_box: { left_top: { x: -0.5, y: -0.5 }, right_bottom: { x: 0.5, y: 0.5 } },
    prototype: {}, fluids_count: 0, quality: { name: 'native-quality' } }
  const actor: any = { force }
  const inserter = (id: number) => ({ ...entity, unit_number: id, name: 'fixture-inserter', type: 'inserter', pickup_target: undefined, pickup_position: { x: 100, y: 100 } })
  return { actor, entity, force, surface, inserter }
}
beforeEach(() => { G.game.tick = 11; G.storage = {} })
afterEach(() => { G.prototypes = originalPrototypes })

describe('native accepted fuel membership', () => {
  const requirement = { state: 'known', fuel_categories: ['live-fuel-category'] }
  it('distinguishes accepted live fuel from an ordinary material without recipe inference', () => {
    G.prototypes = { item: { 'ordinary-material': { fuel_value: 0 },
      'other-category-fuel': { fuel_categories: ['other'], fuel_value: 400 },
      'live-fuel': { fuel_categories: ['live-fuel-category'], fuel_value: 300 } } }
    expect(factory_native_fuels(requirement)).toMatchObject({ state: 'known', coverage: 'complete', truncated: false,
      items: [{ name: 'live-fuel', category: 'live-fuel-category', fuel_value: 300 }] })
    expect(factory_native_fuels({ state: 'unknown', fuel_categories: [] })).toMatchObject({ state: 'unknown', coverage: 'partial' })
  })
  it('does not make a partial prototype set authoritative for exclusion', () => {
    G.prototypes = { item: Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [`fixture-${i}`, { fuel_value: 0 }])) }
    expect(factory_native_fuels(requirement)).toMatchObject({ state: 'unknown', coverage: 'partial', truncated: true })
    G.prototypes = { item: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`fixture-${i}`, { fuel_categories: ['live-fuel-category'], fuel_value: 300 }])) }
    expect(factory_native_fuels(requirement)).toMatchObject({ state: 'unknown', coverage: 'partial', truncated: true })
  })
})

describe('exact native progress observations', () => {
  it('separates cumulative crafting cycles, cyclic mining progress and last-tick energy samples', () => {
    const { entity } = fixture()
    entity.type = 'furnace'; entity.products_finished = 4; entity.crafting_progress = 0.25
    expect(factory_native_progress(entity)).toMatchObject({ products_finished: { state: 'known', value: 4, basis: 'native_completed_crafting_cycles' },
      crafting_progress: { state: 'known', value: 0.25 }, mining_progress: { state: 'not_applicable' }, electricity_production: { state: 'not_applicable' } })
    entity.type = 'mining-drill'; entity.mining_progress = 0.5
    Object.defineProperty(entity, 'products_finished', { get: raises })
    expect(factory_native_progress(entity)).toMatchObject({ products_finished: { state: 'not_applicable' }, mining_progress: { state: 'known', value: 0.5 } })
    entity.type = 'generator'; entity.energy_generated_last_tick = 0
    entity.prototype.get_max_energy_production = vi.fn(() => 123)
    expect(factory_native_progress(entity)).toMatchObject({ energy_generated_last_tick: { state: 'known', value: 0 },
      electricity_production: { state: 'known', producer: true, maximum_energy_production: 123 }, coverage: { delivery: 'unverified', commissioning: 'unverified' } })
    expect(entity.prototype.get_max_energy_production).toHaveBeenCalledWith(entity.quality)
    entity.type = 'accumulator'
    expect(factory_native_progress(entity).electricity_production).toMatchObject({ state: 'not_applicable' })
  })
  it('does not default missing, thrown or malformed progress to zero', () => {
    const { entity } = fixture(); entity.type = 'furnace'
    expect(factory_native_progress(entity).products_finished).toMatchObject({ state: 'unknown', code: 'native_completed_crafting_cycles_unavailable' })
    entity.products_finished = 0.5
    expect(factory_native_progress(entity).products_finished).toMatchObject({ state: 'unknown', code: 'native_completed_crafting_cycles_malformed' })
    Object.defineProperty(entity, 'products_finished', { get: raises })
    expect(factory_native_progress(entity).products_finished).toMatchObject({ state: 'error' })
  })
})

describe('bounded direct native consumer coverage', () => {
  it('proves empty direct item coverage only after a complete all-force whole-surface enumeration', () => {
    const f = fixture(); const before = JSON.stringify(G.storage)
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ state: 'known', coverage: 'complete', truncated: false, unresolved: false, consumers: [], scanned_candidates: 0 })
    expect(f.surface.find_entities_filtered).toHaveBeenCalledWith({ type: expect.arrayContaining(['inserter', 'mining-drill', 'loader']), limit: 129 })
    expect(f.surface.find_entities_filtered.mock.calls[0][0].area).toBeUndefined()
    expect(f.surface.find_entities_filtered.mock.calls[0][0].force).toBeUndefined()
    expect(JSON.stringify(G.storage)).toBe(before)
  })
  it('includes an unregistered exact inserter consumer regardless of force or reach distance', () => {
    const f = fixture(); const consumer = f.inserter(77)
    Object.assign(consumer, { force: { index: 9 }, position: { x: 1000, y: 1000 }, pickup_target: f.entity })
    f.surface.find_entities_filtered.mockReturnValue([consumer])
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ state: 'known', coverage: 'complete', consumers: [
      { relation: 'inserter_pickup', state: 'connected', consumer: { unit_number: 77, force_index: 9 } },
    ] })
  })
  it('does not mistake a dormant nil native target for absence when pickup geometry touches the source', () => {
    const f = fixture(); const consumer = f.inserter(77); consumer.pickup_position = { x: 0, y: 0 }
    f.surface.find_entities_filtered.mockReturnValue([consumer])
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ state: 'unknown', coverage: 'partial', unresolved: true,
      consumers: [{ state: 'potential', consumer: { unit_number: 77 } }] })
  })
  it.each(['hidden', 'truncated', 'getter-error', 'electric', 'fluid'])('cannot prove consumer absence with %s evidence', mode => {
    const f = fixture(); const consumer = f.inserter(77)
    f.surface.find_entities_filtered.mockReturnValue([consumer])
    if (mode === 'hidden') f.force.is_chunk_visible = () => false
    if (mode === 'truncated') f.surface.find_entities_filtered.mockReturnValue(Array.from({ length: 129 }, () => consumer))
    if (mode === 'getter-error') Object.defineProperty(consumer, 'pickup_target', { get: raises })
    if (mode === 'electric') f.entity.prototype.electric_energy_source_prototype = {}
    if (mode === 'fluid') f.entity.fluids_count = 1
    const result = factory_native_consumers(f.actor, f.entity)
    expect(result.coverage).toBe('partial'); expect(result.unresolved).toBe(true)
    if (mode === 'truncated') expect(result.truncated).toBe(true)
    if (mode === 'hidden') expect(result.consumers).toEqual([])
    if (mode === 'getter-error') expect(result.state).toBe('error')
  })
  it('excludes unrelated belts and exact loader containers while retaining a loader that extracts from this inventory', () => {
    const f = fixture(); const loader = { ...f.inserter(77), type: 'loader', loader_type: 'output', loader_container: { ...f.entity, unit_number: 66 } }
    f.surface.find_entities_filtered.mockReturnValue([{ ...loader, type: 'transport-belt' }, loader])
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'complete', consumers: [] })
    loader.loader_container = f.entity
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'complete', consumers: [{ relation: 'loader_output', consumer: { unit_number: 77 } }] })
  })
  it('excludes a hidden fixed-vector inserter only using native prototype bounds, never custom vectors', () => {
    const f = fixture(); const hidden = { ...f.inserter(77), position: { x: 1000, y: 1000 },
      prototype: { allow_custom_vectors: false, inserter_pickup_position: [0, -2], inserter_drop_position: [0, 2], collision_box: f.entity.bounding_box } }
    f.surface.find_entities_filtered.mockReturnValue([hidden]); f.force.is_chunk_visible = () => false
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'complete', consumers: [] })
    hidden.prototype.allow_custom_vectors = true
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'partial', consumers: [] })
  })
  it('proves a sole incoming drill only when the full cut excludes other direct inventory producers', () => {
    const f = fixture(); const drill = { ...f.inserter(77), type: 'mining-drill', drop_target: f.entity, drop_position: f.entity.position }
    f.surface.find_entities_filtered.mockReturnValue([drill])
    expect(factory_native_item_topology(f.actor, f.entity).incoming_item_facts).toMatchObject({ coverage: 'complete', unresolved: false,
      producers: [{ relation: 'mining_drop', state: 'connected', producer: { unit_number: 77 } }] })
    const inserter = { ...f.inserter(78), drop_position: f.entity.position }
    f.surface.find_entities_filtered.mockReturnValue([drill, inserter])
    expect(factory_native_item_topology(f.actor, f.entity).incoming_item_facts).toMatchObject({ coverage: 'partial', unresolved: true,
      producers: [{ state: 'connected' }, { relation: 'inserter_drop', state: 'potential' }] })
    f.surface.find_entities_filtered.mockReturnValue([{ ...inserter, type: 'loader', loader_container: f.entity, loader_type: 'input' }])
    expect(factory_native_item_topology(f.actor, f.entity).incoming_item_facts).toMatchObject({ coverage: 'complete', producers: [{ relation: 'loader_input', state: 'connected' }] })
  })
  it('retains the miner receiver as a consumer and conservatively reports a dormant geometric receiver', () => {
    const f = fixture(); f.entity.type = 'mining-drill'; f.entity.drop_position = { x: 3, y: 0 }
    const receiver = { ...f.entity, unit_number: 99, type: 'container', prototype: { is_entity_with_owner: true }, get_max_inventory_index: () => 1 }
    f.entity.drop_target = receiver
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'complete', consumers: [{ relation: 'mining_drop', state: 'connected', consumer: { unit_number: 99 } }] })
    f.entity.drop_target = undefined
    f.surface.find_entities_filtered.mockImplementation((query: any) => query.position ? [receiver] : [])
    expect(factory_native_consumers(f.actor, f.entity)).toMatchObject({ coverage: 'partial', consumers: [{ relation: 'mining_drop', state: 'potential', consumer: { unit_number: 99 } }] })
  })
})
