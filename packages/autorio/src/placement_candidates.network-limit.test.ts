import { beforeEach, describe, expect, it, vi } from 'vitest'
import { preservation_geometry_for_actor } from './knowledge'
import { protected_network_fact } from './placement_candidates'

// A straight pipe chain 1..n: each entity's geometry names its connected neighbours,
// the shape the preservation guard walks.
vi.mock('./knowledge', async importOriginal => ({
  ...await importOriginal<typeof import('./knowledge')>(),
  preservation_geometry_for_actor: vi.fn(),
}))

const geometry = vi.mocked(preservation_geometry_for_actor)

function chain(length: number, unreadable?: number) {
  geometry.mockImplementation((_actor: any, unit_number: number) => {
    if (unit_number === unreadable || unit_number < 1 || unit_number > length) return undefined
    const neighbours = [unit_number - 1, unit_number + 1].filter(unit => unit >= 1 && unit <= length)
    return { unit_number, fluid_storages: [{ pipe_connections: neighbours.map(unit => ({ connected: true, target: { unit_number: unit } })) }] }
  })
}

// 2026-11-03 trial finding 1: candidates must report the bound the freeze applies.
describe('protected fluid network fact', () => {
  const actor: any = {}
  beforeEach(() => { geometry.mockReset() })

  it('proves a network of exactly the limit and reports its size', () => {
    chain(16)
    expect(protected_network_fact(actor, 1)).toEqual({ version: 1, limit: 16, provable: true, entity_count: 16 })
  })

  it('refuses one entity past the limit from any joined entity', () => {
    chain(17)
    expect(protected_network_fact(actor, 1)).toEqual({ version: 1, limit: 16, provable: false, reason: 'protected_network_over_limit', entity_count_at_least: 17 })
    expect(protected_network_fact(actor, 9)).toMatchObject({ provable: false, reason: 'protected_network_over_limit' })
  })

  it('names the entity the guard cannot read', () => {
    chain(5, 4)
    expect(protected_network_fact(actor, 1)).toEqual({ version: 1, limit: 16, provable: false, reason: 'protected_geometry_unavailable', unit_number: 4 })
  })

  it('reports a read fault as unprovable instead of throwing into the candidate answer', () => {
    geometry.mockImplementation(() => { throw new Error('invalid entity') })
    expect(protected_network_fact(actor, 1)).toEqual({ version: 1, limit: 16, provable: false, reason: 'protected_network_read_failed' })
  })
})
