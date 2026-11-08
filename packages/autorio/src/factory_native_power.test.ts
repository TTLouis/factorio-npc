import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { factory_native_power_component } from './factory_native_power'

const G = globalThis as any
const originalPrototypes = G.prototypes
const originalDefines = G.defines
beforeEach(() => { G.game.tick = 19; G.defines = { ...originalDefines, wire_connector_id: { pole_copper: 5 } } })
afterEach(() => { G.prototypes = originalPrototypes; G.defines = originalDefines })
function fixture() {
  const force: any = { index: 1, is_chunk_visible: () => true }
  const surface: any = { index: 1, find_entities_filtered: vi.fn() }
  function entity(id: number, type: string, maximum: number, priority = 'secondary-input') {
    return { valid: true, unit_number: id, name: `fixture-${type}-${id}`, type, force, surface, position: { x: id, y: 0 },
      bounding_box: { left_top: { x: id - 1, y: -1 }, right_bottom: { x: id + 1, y: 1 } }, quality: { name: 'native-quality' },
      electric_network_id: 3, energy: 0, get_wire_connectors: () => ({}),
      prototype: { type, electric_energy_source_prototype: type === 'electric-pole' ? undefined : { usage_priority: priority }, get_max_energy_production: vi.fn(() => maximum) } }
  }
  const pole = entity(1, 'electric-pole', 0)
  const generator = entity(2, 'generator', 500, 'secondary-output')
  const consumer = entity(3, 'assembling-machine', 0)
  const rows = [pole, generator, consumer]
  const update = () => { G.prototypes = { entity: Object.fromEntries(rows.map(e => [e.name, e.prototype])) }; surface.find_entities_filtered.mockReturnValue(rows) }
  update()
  return { actor: { force } as any, force, surface, pole, generator, consumer, rows, entity, update }
}

describe('bounded native electric physical component', () => {
  it('enumerates live electric prototypes across the whole surface and returns exact members and measured buffers', () => {
    const f = fixture(); f.consumer.energy = 12
    const result = factory_native_power_component(f.actor, f.consumer)
    expect(result).toMatchObject({ state: 'known', coverage: 'complete', truncated: false, unresolved: false, tick: 19,
      electric_network_id: 3, capable_producers: [2], has_storage: false, has_interface: false,
      members: [{ unit_number: 1, role: 'pole' }, { unit_number: 2, role: 'producer' }, { unit_number: 3, role: 'consumer', energy: { value: 12 } }] })
    expect(f.surface.find_entities_filtered).toHaveBeenCalledWith({ name: f.rows.map(e => e.name), limit: 129 })
    expect(f.generator.prototype.get_max_energy_production).toHaveBeenCalledWith(f.generator.quality)
  })
  it('retains unregistered generators, storage and interfaces instead of certifying a sole supplier', () => {
    const f = fixture(); f.rows.push(f.entity(4, 'generator', 600, 'secondary-output'), f.entity(5, 'accumulator', 100, 'tertiary'), f.entity(6, 'electric-energy-interface', 900))
    f.update()
    expect(factory_native_power_component(f.actor, f.consumer)).toMatchObject({ coverage: 'complete', capable_producers: [2, 4], has_storage: true, has_interface: true })
  })
  it.each(['hidden', 'truncated', 'unknown-source', 'throw'])('keeps %s component evidence incomplete', mode => {
    const f = fixture()
    if (mode === 'hidden') f.force.is_chunk_visible = () => false
    if (mode === 'truncated') f.surface.find_entities_filtered.mockReturnValue(Array.from({ length: 129 }, () => f.pole))
    if (mode === 'unknown-source') { f.rows.push(f.entity(4, 'unclassified-native-source', 100)); f.update() }
    if (mode === 'throw') f.generator.prototype.get_max_energy_production = vi.fn(() => { throw new Error('getter') })
    expect(factory_native_power_component(f.actor, f.consumer)).toMatchObject({ coverage: 'partial', unresolved: true })
  })
  it('records native copper edges and refuses missing component endpoints', () => {
    const f = fixture(); const other = f.entity(4, 'electric-pole', 0); f.rows.push(other); f.update()
    f.pole.get_wire_connectors = () => ({ 5: { wire_connector_id: 5, connections: [{ target: { owner: other, wire_connector_id: 5 } }] } })
    expect(factory_native_power_component(f.actor, f.consumer)).toMatchObject({ coverage: 'complete', wire_edges: [{ from_unit_number: 1, to_unit_number: 4, from_connector: 5, to_connector: 5 }] })
    f.rows.pop(); f.update()
    expect(factory_native_power_component(f.actor, f.consumer)).toMatchObject({ coverage: 'partial', code: 'electric_wire_member_missing' })
  })
})
