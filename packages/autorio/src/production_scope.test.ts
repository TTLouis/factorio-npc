import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { production_scope_context } from './production_scope'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function recipe(name: string, ingredients: Array<Record<string, unknown>>, products: Array<Record<string, unknown>>) {
  return { name, enabled: true, hidden: false, ingredients, products }
}

function statistics(values: Record<string, { oneMinuteIn: number, oneMinuteOut: number, tenMinuteIn: number, tenMinuteOut: number }>) {
  return {
    get_flow_count: ({ name, category, precision_index }: { name: string, category: string, precision_index: number }) => {
      const value = values[name] ?? { oneMinuteIn: 0, oneMinuteOut: 0, tenMinuteIn: 0, tenMinuteOut: 0 }
      const oneMinute = precision_index === 1
      if (category === 'input') return oneMinute ? value.oneMinuteIn : value.tenMinuteIn
      return oneMinute ? value.oneMinuteOut : value.tenMinuteOut
    },
  }
}

function actorWith(recipes: Record<string, unknown>) {
  const itemStats = statistics({
    'electronic-circuit': { oneMinuteIn: 600, oneMinuteOut: 540, tenMinuteIn: 480, tenMinuteOut: 450 },
    'copper-cable': { oneMinuteIn: 1800, oneMinuteOut: 1620, tenMinuteIn: 1500, tenMinuteOut: 1440 },
    'copper-plate': { oneMinuteIn: 3600, oneMinuteOut: 3000, tenMinuteIn: 3300, tenMinuteOut: 3000 },
    'iron-plate': { oneMinuteIn: 3000, oneMinuteOut: 2400, tenMinuteIn: 2700, tenMinuteOut: 2400 },
  })
  return {
    is_valid: true,
    surface: { index: 7, name: 'nauvis' },
    force: {
      index: 1,
      name: 'player',
      recipes,
      get_item_production_statistics: () => itemStats,
      get_fluid_production_statistics: () => statistics({}),
    },
  } as unknown as ControlledActor
}

describe('production scope context', () => {
  const originalPairs = (globalThis as any).pairs
  const originalDefines = (globalThis as any).defines

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).defines = { flow_precision_index: { one_minute: 1, ten_minutes: 2 } }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).defines = originalDefines
  })

  it('returns target-oriented surface statistics for the target and bounded upstream materials', () => {
    const actor = actorWith({
      'electronic-circuit': recipe('electronic-circuit', [
        { type: 'item', name: 'iron-plate', amount: 1 },
        { type: 'item', name: 'copper-cable', amount: 3 },
      ], [{ type: 'item', name: 'electronic-circuit', amount: 1 }]),
      'copper-cable': recipe('copper-cable', [
        { type: 'item', name: 'copper-plate', amount: 1 },
      ], [{ type: 'item', name: 'copper-cable', amount: 2 }]),
    })

    const result = production_scope_context(actor, {
      calculation_id: 'green-scope',
      target: { type: 'item', name: 'electronic-circuit' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.surface).toEqual({ index: 7, name: 'nauvis' })
    expect(result.materials.map(material => [material.depth, material.name])).toEqual([
      [0, 'electronic-circuit'],
      [1, 'copper-cable'],
      [1, 'iron-plate'],
      [2, 'copper-plate'],
    ])
    expect(result.materials[0].observed[0]).toEqual({
      window: '1m',
      production_per_second: 10,
      consumption_per_second: 9,
      net_per_second: 1,
    })
    expect(result.materials[0].observed[1]).toEqual({
      window: '10m',
      production_per_second: 8,
      consumption_per_second: 7.5,
      net_per_second: 0.5,
    })
    expect(result.coverage.complete).toBe(true)
    expect(JSON.stringify(result)).not.toContain('recommended')
    expect(result.semantics.decision).toContain('model must choose')
  })

  it('reports bounded incomplete coverage instead of pretending the scope graph is complete', () => {
    const actor = actorWith({
      a: recipe('a', [{ type: 'item', name: 'b', amount: 1 }], [{ type: 'item', name: 'a', amount: 1 }]),
      b: recipe('b', [{ type: 'item', name: 'c', amount: 1 }], [{ type: 'item', name: 'b', amount: 1 }]),
    })
    const result = production_scope_context(actor, {
      calculation_id: 'bounded',
      target: { type: 'item', name: 'a' },
      max_depth: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.truncation_reasons).toContain('depth limit 1 reached')
  })

  it('does not report a depth truncation when producers at the depth limit have no ingredients', () => {
    const actor = actorWith({
      a: recipe('a', [{ type: 'item', name: 'b', amount: 1 }], [{ type: 'item', name: 'a', amount: 1 }]),
      b: recipe('b', [], [{ type: 'item', name: 'b', amount: 1 }]),
    })
    const result = production_scope_context(actor, {
      calculation_id: 'leaf-at-limit',
      target: { type: 'item', name: 'a' },
      max_depth: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.materials.map(material => material.name)).toEqual(['a', 'b'])
    expect(result.coverage.complete).toBe(true)
  })

  it('rejects invalid bounds before reading world statistics', () => {
    const actor = actorWith({})
    expect(production_scope_context(actor, {
      calculation_id: 'bad',
      target: { type: 'item', name: 'iron-plate' },
      max_depth: 7,
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })
})
