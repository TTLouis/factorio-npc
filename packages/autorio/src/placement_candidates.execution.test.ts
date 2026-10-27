import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_placement_candidate_set, execute_placement_candidate, placement_candidate_preflight } from './placement_candidates'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

describe('placement candidate execution', () => {
  const originalPairs = (globalThis as any).pairs
  const originalStorage = (globalThis as any).storage
  const originalGame = (globalThis as any).game
  const originalEntityPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game = { tick: 100 }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).storage = originalStorage
    ;(globalThis as any).game = originalGame
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
  })

  function actor(canPlace: (args?: any) => boolean = () => true) {
    return {
      position: { x: 0, y: 0 },
      force: { index: 2, is_chunk_charted: () => true, is_chunk_visible: () => true },
      surface: {
        index: 7,
        can_place_entity: canPlace,
        find_entities_filtered: () => [],
      },
    } as any
  }

  it('executes by candidate identity and reuses the stored coordinates', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    const controlled = actor(({ position }: any) => position.x === 0.5 && position.y === 0.5)
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      center: { x: 0, y: 0 },
      radius: 1,
      limit: 1,
    }) as any

    const submitted: any[] = []
    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      (entity_name, x, y, direction) => {
        submitted.push({ entity_name, x, y, direction })
        return true
      },
    )

    expect(result[0]).toBe(true)
    expect(submitted).toEqual([{
      entity_name: 'modded-building',
      x: 0.5,
      y: 0.5,
      direction: generated.candidates[0].direction,
    }])
  })

  it('rejects a candidate that became unplaceable before execution', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    let placeable = true
    const controlled = actor(() => placeable)
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      radius: 1,
      limit: 1,
    }) as any
    placeable = false

    let submitted = false
    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      () => {
        submitted = true
        return true
      },
    )

    expect(result).toEqual([false, 'placement candidate is no longer placeable'])
    expect(submitted).toBe(false)
  })

  it('rejects expired candidate sets', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    const controlled = actor()
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      radius: 1,
      limit: 1,
    }) as any
    ;(globalThis as any).game.tick = generated.expires_tick + 1

    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      () => true,
    )

    expect(result).toEqual([false, 'placement candidate set expired'])
  })

  it('preflights the trusted candidate identity and current held alias/count without queueing, preserving TTL, surface and geometry checks', () => {
    ;(globalThis as any).prototypes.item['candidate-test-kit'] = {}
    ;(globalThis as any).prototypes.entity = { 'candidate-test-machine': { name: 'candidate-test-machine', type: 'container',
      tile_width: 1, tile_height: 1, items_to_place_this: [{ name: 'candidate-test-kit', count: 2 }] } }
    let held = 1; let placeable = true
    const controlled = actor(() => placeable)
    controlled.is_valid = true
    controlled.get_main_inventory = () => ({ get_item_count: (name: string) => { expect(name).toBe('candidate-test-kit'); return held } })
    const generated = create_placement_candidate_set(controlled, { entity_name: 'candidate-test-machine', radius: 1, limit: 1 }) as any
    const check = () => placement_candidate_preflight(controlled, generated.candidate_set_id, generated.candidates[0].id)
    expect(check()).toMatchObject({ ok: false, code: 'placement_item_missing', placement_item: { entity_name: 'candidate-test-machine', held_count: 1, count: 2 } })
    held = 2
    expect(check()).toMatchObject({ ok: true, placement_item: { item_name: 'candidate-test-kit', held_count: 2 } })
    placeable = false
    expect(check()).toMatchObject({ ok: false, code: 'placement_candidate_unavailable', error: 'placement candidate is no longer placeable' })
    placeable = true; controlled.surface.index = 8
    expect(check()).toMatchObject({ ok: false, code: 'placement_candidate_unavailable', error: 'placement candidate belongs to another actor surface/force' })
    controlled.surface.index = 7
    expect(placement_candidate_preflight(controlled, generated.candidate_set_id, 'candidate-999')).toMatchObject({ ok: false, code: 'placement_candidate_unavailable' })
    ;(globalThis as any).game.tick = generated.expires_tick + 1
    expect(check()).toMatchObject({ ok: false, code: 'placement_candidate_unavailable', error: 'placement candidate set expired' })
  })
})
