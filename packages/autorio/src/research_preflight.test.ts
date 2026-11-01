import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { research_operation_preflight } from './research_preflight'

function technology(name: string, options: {
  researched?: boolean
  enabled?: boolean
  prerequisites?: Record<string, any>
  trigger?: Record<string, any>
} = {}) {
  return {
    name,
    level: 1,
    researched: options.researched ?? false,
    enabled: options.enabled ?? true,
    prerequisites: options.prerequisites ?? {},
    prototype: {
      max_level: 1,
      ...(options.trigger ? { research_trigger: options.trigger } : {}),
    },
    research_unit_count: 10,
    research_unit_energy: 30,
    research_unit_ingredients: [{ name: 'automation-science-pack', amount: 1 }],
  }
}

function world(technologies: Record<string, any>, options: {
  research_enabled?: boolean
  current_research?: any
  research_queue?: any[]
} = {}) {
  const force: any = {
    valid: true,
    index: 1,
    research_enabled: options.research_enabled ?? true,
    technologies,
    current_research: options.current_research,
    research_queue: options.research_queue ?? [],
    research_progress: 0.25,
    add_research: vi.fn(),
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    force,
  } as unknown as ControlledActor

  const prototypes_by_name: Record<string, any> = {}
  for (const name of Object.keys(technologies)) {
    prototypes_by_name[name] = technologies[name].prototype
  }
  ;(globalThis as any).prototypes.technology = prototypes_by_name
  return { actor, force }
}

beforeEach(() => {
  ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
  ;(globalThis as any).prototypes = { technology: {} }
})

describe('deterministic research operation preflight', () => {
  it('accepts ready, already researched, and valid already-queued research without mutation', () => {
    const ready_tech = technology('automation')
    const ready = world({ automation: ready_tech })
    expect(research_operation_preflight(ready.actor, 'automation')).toMatchObject({
      ok: true,
      operation: 'research_technology',
      technology: 'automation',
      state: 'ready',
    })
    expect(ready.force.add_research).not.toHaveBeenCalled()

    const researched_tech = technology('automation', { researched: true })
    const researched = world({ automation: researched_tech })
    expect(research_operation_preflight(researched.actor, 'automation')).toMatchObject({
      ok: true,
      state: 'already_researched',
    })
    expect(researched.force.add_research).not.toHaveBeenCalled()

    const other = technology('logistics')
    const queued_tech = technology('automation')
    const queued = world(
      { automation: queued_tech, logistics: other },
      { current_research: other, research_queue: [other, queued_tech] },
    )
    expect(research_operation_preflight(queued.actor, 'automation')).toMatchObject({
      ok: true,
      state: 'already_queued',
      current_research: { name: 'logistics' },
      queue_length: 2,
    })
    expect(queued.force.add_research).not.toHaveBeenCalled()
  })

  it('returns dependency-first next_actionable for a multi-level missing-prerequisite chain', () => {
    const root = technology('steam-power')
    const middle = technology('electronics', { prerequisites: { 'steam-power': root } })
    const target = technology('automation', { prerequisites: { electronics: middle } })
    const { actor, force } = world({
      'steam-power': root,
      electronics: middle,
      automation: target,
    })

    const result: any = research_operation_preflight(actor, 'automation')
    expect(result).toMatchObject({
      ok: false,
      code: 'missing_prerequisites',
      technology: 'automation',
      next_actionable: {
        name: 'steam-power',
        status: 'ready',
        mode: 'science',
      },
      research_path: {
        target: 'automation',
        pending_count: 3,
        pending_path_truncated: false,
      },
    })
    expect(result.research_path.pending_path.map((node: any) => node.name)).toEqual([
      'steam-power',
      'electronics',
      'automation',
    ])
    expect(result.research_path.requested.unresolved_prerequisites).toEqual(['electronics'])
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('returns the exact deterministic research trigger for trigger research', () => {
    const trigger = { type: 'craft-item', item: 'iron-plate', count: 50 }
    const steam = technology('steam-power', { trigger })
    const { actor, force } = world({ 'steam-power': steam })

    const result: any = research_operation_preflight(actor, 'steam-power')
    expect(result).toMatchObject({
      ok: false,
      code: 'trigger_research',
      technology: 'steam-power',
      research_trigger: trigger,
      next_actionable: {
        name: 'steam-power',
        mode: 'trigger',
        research_trigger: trigger,
      },
    })
    expect(result.research_trigger).toEqual(trigger)
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('reports force_busy with bounded current and queue identity and never replaces the force queue', () => {
    const target = technology('automation')
    const queue = Array.from({ length: 12 }, (_, index) => technology(`queued-${index}`))
    const { actor, force } = world(
      {
        automation: target,
        ...Object.fromEntries(queue.map(item => [item.name, item])),
      },
      { current_research: queue[0], research_queue: queue },
    )

    const result: any = research_operation_preflight(actor, 'automation')
    expect(result).toMatchObject({
      ok: false,
      code: 'force_busy',
      current_research: { name: 'queued-0', progress: 0.25 },
      queue_length: 12,
      queue_truncated: true,
    })
    expect(result.queue).toHaveLength(8)
    expect(force.research_queue).toEqual(queue)
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('keeps permanent deterministic research errors as rejections', () => {
    const unknown = world({ automation: technology('automation') })
    expect(research_operation_preflight(unknown.actor, '__missing__')).toMatchObject({
      ok: false,
      code: 'unknown_technology',
    })

    const disabled_tech = technology('automation', { enabled: false })
    const disabled = world({ automation: disabled_tech })
    expect(research_operation_preflight(disabled.actor, 'automation')).toMatchObject({
      ok: false,
      code: 'technology_disabled',
    })

    const force_disabled = world(
      { automation: technology('automation') },
      { research_enabled: false },
    )
    expect(research_operation_preflight(force_disabled.actor, 'automation')).toMatchObject({
      ok: false,
      code: 'research_disabled',
    })

    expect(research_operation_preflight(undefined, 'automation')).toMatchObject({
      ok: false,
      code: 'no_actor',
    })
    expect(research_operation_preflight(unknown.actor, 'automation\ninvalid')).toMatchObject({
      ok: false,
      code: 'invalid_name',
      technology: '<invalid>',
    })

    expect(unknown.force.add_research).not.toHaveBeenCalled()
    expect(disabled.force.add_research).not.toHaveBeenCalled()
    expect(force_disabled.force.add_research).not.toHaveBeenCalled()
  })

  it('bounds long dependency output while preserving the exact next actionable technology', () => {
    const technologies: Record<string, any> = {}
    let previous: any
    for (let index = 0; index < 20; index++) {
      const name = `tech-${index}`
      const prerequisites = previous ? { [previous.name]: previous } : {}
      const current = technology(name, { prerequisites })
      technologies[name] = current
      previous = current
    }
    const { actor, force } = world(technologies)
    const result: any = research_operation_preflight(actor, 'tech-19')

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_prerequisites',
      next_actionable: { name: 'tech-0' },
      research_path: {
        node_count: 20,
        pending_count: 20,
        pending_path_truncated: true,
      },
    })
    expect(result.research_path.pending_path).toHaveLength(12)
    expect(force.add_research).not.toHaveBeenCalled()
  })
})
