import type { ControlledActor } from './actors/types'
import type { LuaEntity } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { entity_reference_hint, remember_entity_reference, resolve_entity_reference, resolve_exact_entity } from './entity_reference'

function actor() {
  const find = vi.fn(() => [])
  return {
    is_valid: true,
    position: { x: 0, y: 0 },
    force: { index: 1 },
    surface: { index: 1, find_entities_filtered: find },
  } as unknown as ControlledActor & { surface: { find_entities_filtered: ReturnType<typeof vi.fn> } }
}

function entity(unit_number: number, overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    unit_number,
    name: 'stone-furnace',
    position: { x: 2, y: 3 },
    surface: { index: 1 },
    force: { index: 1 },
    ...overrides,
  } as unknown as LuaEntity
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)
})

describe('exact entity references', () => {
  it('uses the native unit-number lookup for a live exact entity', () => {
    const a = actor()
    const target = entity(104)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    expect(resolve_exact_entity(a, 104)).toBe(target)
    expect(entity_reference_hint(104)).toMatchObject({
      name: 'stone-furnace',
      position: { x: 2, y: 3 },
      observed_tick: 100,
    })
    expect(a.surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('recovers the same live identity from its observed position when native lookup misses', () => {
    const a = actor()
    const observed = entity(104)
    remember_entity_reference(observed)
    a.surface.find_entities_filtered.mockReturnValue([observed])

    expect(resolve_exact_entity(a, 104)).toBe(observed)
    expect(a.surface.find_entities_filtered).toHaveBeenCalledWith({
      position: { x: 2, y: 3 },
      radius: 0.25,
      name: 'stone-furnace',
      force: a.force,
    })
  })

  it('keeps a replacement at the same coordinate as a distinct identity', () => {
    const a = actor()
    remember_entity_reference(entity(104))
    ;(globalThis as any).game.tick = 120
    const replacement = entity(105)
    remember_entity_reference(replacement)
    a.surface.find_entities_filtered.mockReturnValue([replacement])

    expect(resolve_exact_entity(a, 104)).toBeUndefined()
    expect(entity_reference_hint(104)).toMatchObject({
      name: 'stone-furnace',
      position: { x: 2, y: 3 },
      observed_tick: 100,
    })
    expect(entity_reference_hint(105)).toMatchObject({
      name: 'stone-furnace',
      position: { x: 2, y: 3 },
      observed_tick: 120,
    })
  })

  it('resolves another force or surface only in the map_visible scope', () => {
    const a = actor()
    const other_surface = { index: 2, valid: true, find_entities_filtered: vi.fn() }
    const wreck = entity(106, { name: 'crash-site-chest-1', surface: other_surface, force: { index: 3 } })
    remember_entity_reference(wreck)
    other_surface.find_entities_filtered.mockReturnValue([wreck])
    ;(globalThis as any).game.get_surface = vi.fn((index: number) => index === 2 ? other_surface : undefined)

    expect(resolve_exact_entity(a, 106)).toBeUndefined()
    expect(resolve_entity_reference(a, 106, 'actor_body')).toBeUndefined()
    expect(a.surface.find_entities_filtered).not.toHaveBeenCalled()

    expect(resolve_entity_reference(a, 106, 'map_visible')).toBe(wreck)
    expect(other_surface.find_entities_filtered).toHaveBeenCalledWith({
      position: { x: 2, y: 3 },
      radius: 0.25,
      name: 'crash-site-chest-1',
    })
  })

  it('never substitutes a different identity in the map_visible scope', () => {
    const a = actor()
    remember_entity_reference(entity(107))
    const replacement = entity(108)
    a.surface.find_entities_filtered.mockReturnValue([replacement])
    ;(globalThis as any).game.get_surface = vi.fn(() => a.surface)

    expect(resolve_entity_reference(a, 107, 'map_visible')).toBeUndefined()
  })
})
