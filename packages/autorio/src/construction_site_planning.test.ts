import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { find_construction_sites } from './construction_site_planning'

function fixture(options: { water?: boolean, obstacle?: boolean } = {}) {
  const character: any = {
    valid: true,
    type: 'character',
    name: 'character',
    position: { x: 0.5, y: 0.5 },
    surface: { index: 1 },
  }
  const rock: any = {
    valid: true,
    type: 'simple-entity',
    name: 'rock-big',
    position: { x: 0.5, y: 0.5 },
    surface: { index: 1 },
  }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    find_entities_filtered: vi.fn(({ area }: any) => {
      const includesOrigin = area.left_top.x <= 0.5 && area.right_bottom.x >= 0.5
        && area.left_top.y <= 0.5 && area.right_bottom.y >= 0.5
      if (!includesOrigin) return []
      return options.obstacle ? [character, rock] : [character]
    }),
    get_tile: vi.fn((x: number, y: number) => ({
      name: options.water && x === 0 && y === 0 ? 'water' : 'grass-1',
    })),
  }
  const actor = {
    is_valid: true,
    position: { x: 0.5, y: 0.5 },
    character,
    surface,
    force: { index: 1, name: 'player', is_chunk_visible: () => true, is_chunk_charted: () => true },
  } as unknown as ControlledActor
  return { actor, surface, character, rock }
}

beforeEach(() => {
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)
})

describe('bounded construction site planning', () => {
  it('accepts a clear rectangular envelope while treating characters as transient', () => {
    const { actor } = fixture()
    const result: any = find_construction_sites(actor, {
      width: 4,
      height: 6,
      position: { x: 0.5, y: 0.5 },
      search_radius: 6,
      max_candidates: 2,
    })

    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]).toMatchObject({
      candidate_id: 'site-1',
      bounds: { left_top: { x: -2, y: -3 }, right_bottom: { x: 2, y: 3 } },
      center: { x: 0, y: 0 },
      transient_character_count: 1,
    })
    expect(result.rejection_summary).toEqual({ occupied_entity: 0, blocking_terrain: 0, not_visible: 0 })
    expect(result.semantics.validation).toContain('not a machine layout')
  })

  it('summarizes blocked candidates without returning raw rejection coordinates', () => {
    const { actor } = fixture({ water: true, obstacle: true })
    const result: any = find_construction_sites(actor, {
      width: 2,
      height: 2,
      position: { x: 0.5, y: 0.5 },
      search_radius: 8,
      max_candidates: 3,
    })

    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(3)
    expect(result.rejection_summary.occupied_entity + result.rejection_summary.blocking_terrain).toBeGreaterThan(0)
    expect(result.rejected).toBeUndefined()
    expect(result.candidates.every((candidate: any) => candidate.bounds !== undefined)).toBe(true)
  })

  it('fails closed for unsafe dimensions or conflicting anchors', () => {
    const { actor } = fixture()
    expect(find_construction_sites(actor, { width: 1, height: 4 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(find_construction_sites(actor, {
      width: 4,
      height: 4,
      anchor_unit_number: 7,
      position: { x: 0, y: 0 },
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })
})
