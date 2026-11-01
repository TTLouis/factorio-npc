import type { ControlledActor } from './actors/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create_production_planning_remote_interface } from './production_planning_remote'

const originalRemote = (globalThis as any).remote
const originalPairs = (globalThis as any).pairs
const originalPrototypes = (globalThis as any).prototypes

afterEach(() => {
  ;(globalThis as any).remote = originalRemote
  ;(globalThis as any).pairs = originalPairs
  ;(globalThis as any).prototypes = originalPrototypes
})

describe('autorio_planning remote contract', () => {
  it('registers solve and delegates a live recipe request through the controlled actor', () => {
    let planning: { solve: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: vi.fn((name: string, methods: any) => {
        if (name === 'autorio_planning') planning = methods
      }),
    }
    ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
    ;(globalThis as any).prototypes = { entity: {} }

    const recipe = {
      name: 'iron-gear-wheel',
      enabled: true,
      hidden: false,
      energy: 0.5,
      ingredients: [{ type: 'item', name: 'iron-plate', amount: 2 }],
      products: [{ type: 'item', name: 'iron-gear-wheel', amount: 1, probability: 1 }],
    }
    const actor = {
      is_valid: true,
      force: { recipes: { 'iron-gear-wheel': recipe } },
    } as unknown as ControlledActor

    create_production_planning_remote_interface(() => actor)

    expect((globalThis as any).remote.add_interface).toHaveBeenCalledOnce()
    expect(planning).toBeDefined()
    const result = planning!.solve({
      calculation_id: 'gear-rate',
      target: { type: 'item', name: 'iron-gear-wheel', rate_per_second: 2 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calculation_id).toBe('gear-rate')
    expect(result.external_inputs).toEqual([
      { type: 'item', name: 'iron-plate', rate_per_second: 4 },
    ])
  })

  it('exposes deterministic belt capacity through the same planning interface', () => {
    let planning: { capacity: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: (_name: string, methods: any) => { planning = methods },
    }
    ;(globalThis as any).prototypes = {
      entity: { 'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 } },
      item: {},
    }
    const controlled = actor({ belt_stack_size_bonus: 1 })

    create_production_planning_remote_interface(() => controlled)
    const result = planning!.capacity({
      kind: 'belt', prototype_name: 'transport-belt', scope: 'lane', required_rate_per_second: 10,
    })

    expect(result).toMatchObject({
      ok: true,
      kind: 'belt',
      validation: {
        scope: 'lane',
        unstacked_capacity_items_per_second: 7.5,
        stacked_capacity_items_per_second: 15,
        fits_unstacked: false,
        fits_stacked: true,
      },
    })
  })

  it('fails closed when there is no controlled actor', () => {
    let planning: { solve: (request: any) => any, capacity: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: (_name: string, methods: any) => {
        planning = methods
      },
    }

    create_production_planning_remote_interface(() => undefined)
    const result = planning!.solve({
      calculation_id: 'missing-actor',
      target: { type: 'item', name: 'iron-gear-wheel', rate_per_second: 1 },
    })

    expect(result).toEqual({
      ok: false,
      calculation_id: 'missing-actor',
      error: {
        code: 'INVALID_REQUEST',
        message: 'controlled actor is unavailable',
      },
    })
    expect(planning!.capacity({ kind: 'belt', prototype_name: 'transport-belt' })).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' },
    })
  })

  it('reads goal requirements through the peek lookup and never creates the body', () => {
    let planning: { goal_requirements: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: (_name: string, methods: any) => { planning = methods },
    }
    ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
    ;(globalThis as any).prototypes = { entity: {}, item: {}, fluid: {}, technology: {} }
    const created: string[] = []
    const peeked = {
      is_valid: true,
      force: {
        valid: true,
        recipes: { 'plain-recipe': { name: 'plain-recipe', enabled: true, hidden: false, category: 'crafting', additional_categories: [], ingredients: [], products: [{ type: 'item', name: 'plain-recipe', amount: 1 }] } },
        technologies: {},
      },
    } as unknown as ControlledActor

    create_production_planning_remote_interface(
      () => {
        created.push('get_actor')
        return undefined
      },
      { tick: () => {}, start: () => undefined, status: () => undefined, cancel: () => undefined } as any,
      () => peeked,
    )

    const result = planning!.goal_requirements({ items: ['plain-recipe'] })
    expect(result.ok).toBe(true)
    expect(result.locked).toEqual([])
    expect(created).toEqual([])
  })

  it('reports an unavailable actor from the peek lookup without falling back to get_actor', () => {
    let planning: { goal_requirements: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: (_name: string, methods: any) => { planning = methods },
    }
    create_production_planning_remote_interface(
      () => { throw new Error('a read must not create the body') },
      { tick: () => {}, start: () => undefined, status: () => undefined, cancel: () => undefined } as any,
      () => undefined,
    )
    expect(planning!.goal_requirements({ items: ['x'] })).toEqual({ ok: false, error: { code: 'NO_ACTOR', message: 'controlled actor is unavailable' } })
  })
})

function actor(force: Record<string, unknown>) {
  return { is_valid: true, force } as unknown as ControlledActor
}
