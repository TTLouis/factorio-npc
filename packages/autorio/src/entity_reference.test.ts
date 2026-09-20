import type { ControlledActor } from './actors/types'
import type { LuaEntity } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remember_entity_reference, resolve_exact_entity } from './entity_reference'

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

describe('exact entity reference recovery', () => {
  it('prefers the native unit-number lookup when it succeeds', () => {
    const a = actor()
    const target = entity(104)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    expect(resolve_exact_entity(a, 104)).toBe(target)
    expect(a.surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('never exposes the internal awareness radar through exact entity references', () => {
    const a = actor()
    const internal = entity(104, { name: 'airi-npc-awareness-radar' })

    remember_entity_reference(internal)
    expect((globalThis as any).storage).toEqual({})

    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => internal)
    expect(resolve_exact_entity(a, 104)).toBeUndefined()
  })

  it('recovers an observed exact entity by position without substituting another unit', () => {
    const a = actor()
    const observed = entity(104)
    remember_entity_reference(observed)

    const wrong = entity(105)
    const same = entity(104)
    a.surface.find_entities_filtered.mockReturnValue([wrong, same])

    expect(resolve_exact_entity(a, 104)).toBe(same)
    expect(a.surface.find_entities_filtered).toHaveBeenCalledWith({
      position: { x: 2, y: 3 },
      radius: 0.25,
      name: 'stone-furnace',
      force: a.force,
    })
  })

  it('fails closed when the observed unit number is gone', () => {
    const a = actor()
    remember_entity_reference(entity(104))
    a.surface.find_entities_filtered.mockReturnValue([entity(105)])

    expect(resolve_exact_entity(a, 104)).toBeUndefined()
  })
})
