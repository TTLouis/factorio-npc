import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resource_amount_observation } from './resource_amounts'

describe('resource amount observation', () => {
  const originalPrototypes = (globalThis as any).prototypes
  beforeEach(() => {
    ;(globalThis as any).game.tick = 500
    ;(globalThis as any).storage = {}
    ;(globalThis as any).prototypes = { entity: {
      'iron-ore': { type: 'resource' }, 'coal': { type: 'resource' }, 'stone-furnace': { type: 'furnace' },
    } }
  })
  afterEach(() => { (globalThis as any).prototypes = originalPrototypes })

  // Ore tiles as the engine stores them: one resource entity per tile, centred on it.
  function fixture(ores: { name: string, x: number, y: number, amount: number, infinite?: boolean }[], visible = (_chunk: { x: number, y: number }) => true) {
    const find_entities_filtered = vi.fn((filter: any) => ores
      // The engine matches by bounding box, so tiles touching the area edge are returned too.
      .filter(ore => ore.x + 0.5 >= filter.area.left_top.x && ore.x - 0.5 <= filter.area.right_bottom.x
        && ore.y + 0.5 >= filter.area.left_top.y && ore.y - 0.5 <= filter.area.right_bottom.y)
      .filter(ore => filter.name === undefined || ore.name === filter.name)
      .map(ore => ({ name: ore.name, position: { x: ore.x, y: ore.y }, amount: ore.amount,
        prototype: { infinite_resource: ore.infinite === true } })))
    const force = { index: 1, is_chunk_visible: vi.fn((_surface: any, chunk: { x: number, y: number }) => visible(chunk)) }
    const actor = { is_valid: true, character: {}, position: { x: 0.3, y: 0.7 }, force,
      surface: { index: 1, find_entities_filtered } } as any
    return { actor, find_entities_filtered }
  }

  const drillPatch = Array.from({ length: 25 }, (_, i) => ({ name: 'iron-ore', x: (i % 5) - 2 + 0.5, y: Math.floor(i / 5) - 2 + 0.5, amount: 100 + i }))

  it('totals each resource in a 5x5 drill square and counts every tile once', () => {
    const { actor } = fixture([...drillPatch, { name: 'iron-ore', x: 3.5, y: 0.5, amount: 9999 }, { name: 'coal', x: -1.5, y: -1.5, amount: 7 }])
    const result = resource_amount_observation(actor, { radius: 2 }) as any
    expect(result).toMatchObject({ ok: true, center_tile: { x: 0, y: 0 }, radius: 2, resource_kinds: 2, coverage_complete: true,
      area: { left_top: { x: -2, y: -2 }, right_bottom: { x: 3, y: 3 } } })
    // The tile at x=3.5 lies outside the square and the coal tile shares a square position with iron in this fixture.
    expect(result.resources[0]).toMatchObject({ name: 'iron-ore', tile_count: 25, total_amount: 25 * 100 + 300, min_amount: 100, max_amount: 124, infinite: false,
      bounding_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 2.5, y: 2.5 } } })
    expect(result.resources[1]).toMatchObject({ name: 'coal', tile_count: 1, total_amount: 7 })
    expect(result.tiles).toBeUndefined()
  })

  it('lists per-tile amounts nearest the centre first only for a named resource, and bounds them', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ name: 'iron-ore', x: (i % 10) - 5 + 0.5, y: Math.floor(i / 10) - 5 + 0.5, amount: 50 }))
    const { actor, find_entities_filtered } = fixture([...big, { name: 'coal', x: 0.5, y: 0.5, amount: 1 }])
    const result = resource_amount_observation(actor, { resource_name: 'iron-ore', radius: 5 }) as any
    expect(find_entities_filtered.mock.calls.every(([filter]: any) => filter.name === 'iron-ore' && filter.type === 'resource')).toBe(true)
    expect(result.resources).toHaveLength(1)
    expect(result.tiles).toHaveLength(64)
    expect(result.tiles_truncated).toBe(true)
    expect(result.tiles[0]).toEqual({ position: { x: 0.5, y: 0.5 }, amount: 50 })
  })

  it('reads only chunks seen now and names the rest as unknown, never absent', () => {
    // The square crosses into chunk x=-1, which the NPC does not see now.
    const { actor, find_entities_filtered } = fixture([{ name: 'iron-ore', x: -3.5, y: 0.5, amount: 400 }, { name: 'iron-ore', x: 1.5, y: 0.5, amount: 300 }],
      chunk => chunk.x >= 0)
    const result = resource_amount_observation(actor, { radius: 8 }) as any
    expect(result).toMatchObject({ coverage_complete: false, visible_chunks: 2, unseen_chunk_count: 2 })
    expect(result.unseen_chunks).toEqual(expect.arrayContaining([{ x: -1, y: 0 }, { x: -1, y: -1 }]))
    expect(result.resources).toEqual([expect.objectContaining({ name: 'iron-ore', tile_count: 1, total_amount: 300 })])
    expect(find_entities_filtered.mock.calls.every(([filter]: any) => filter.area.left_top.x >= 0)).toBe(true)
  })

  it('refuses a non-resource name, a bad radius and a missing actor without reading the surface', () => {
    const { actor, find_entities_filtered } = fixture(drillPatch)
    expect(resource_amount_observation(actor, { resource_name: 'stone-furnace' })).toMatchObject({ ok: false, code: 'unknown_resource' })
    expect(resource_amount_observation(actor, { radius: 49 })).toMatchObject({ ok: false, code: 'invalid_radius', maximum: 48 })
    expect(resource_amount_observation(actor, { radius: 1.5 })).toMatchObject({ ok: false, code: 'invalid_radius' })
    expect(resource_amount_observation(undefined, {})).toMatchObject({ ok: false, code: 'no_actor' })
    expect(find_entities_filtered).not.toHaveBeenCalled()
  })

  it('reports infinite resources as such', () => {
    const { actor } = fixture([{ name: 'iron-ore', x: 0.5, y: 0.5, amount: 300000, infinite: true }])
    const result = resource_amount_observation(actor, { radius: 0, center: { x: 0.9, y: 0.1 } }) as any
    expect(result.resources[0]).toMatchObject({ infinite: true, tile_count: 1, total_amount: 300000 })
    expect(result.area).toEqual({ left_top: { x: 0, y: 0 }, right_bottom: { x: 1, y: 1 } })
  })
})
