import { beforeEach, describe, expect, it } from 'vitest'
import { research_trigger_summary, with_research_trigger } from './research_trigger'

beforeEach(() => {
  ;(globalThis as any).prototypes.technology = {}
})

describe('research trigger knowledge', () => {
  it('exposes exact craft-item item and count instead of only the trigger type', () => {
    ;(globalThis as any).prototypes.technology['steam-power'] = {
      research_trigger: { type: 'craft-item', item: 'iron-plate', count: 50 },
    }
    expect(research_trigger_summary('steam-power')).toEqual({
      type: 'craft-item',
      item: 'iron-plate',
      count: 50,
    })
    expect(with_research_trigger('steam-power', { found: true, name: 'steam-power', trigger_type: 'craft-item' })).toMatchObject({
      research_trigger: { type: 'craft-item', item: 'iron-plate', count: 50 },
    })
  })

  it('reads the 2.0 ItemIDFilter table of a craft-item trigger (steam-power shape)', () => {
    ;(globalThis as any).prototypes.technology['steam-power'] = {
      research_trigger: { type: 'craft-item', item: { name: 'iron-plate' }, count: 50 },
    }
    expect(research_trigger_summary('steam-power')).toEqual({ type: 'craft-item', item: 'iron-plate', count: 50 })
  })

  it('keeps a named quality and reads EntityIDFilter tables and plain entity/fluid names', () => {
    const technologies = (globalThis as any).prototypes.technology
    technologies.orbit = { research_trigger: { type: 'send-item-to-orbit', item: { name: 'rocket-part', quality: 'rare', comparator: '>=' } } }
    technologies.build = { research_trigger: { type: 'build-entity', entity: { name: 'offshore-pump' } } }
    technologies.mine = { research_trigger: { type: 'mine-entity', entity: 'stone' } }
    technologies.fluid = { research_trigger: { type: 'craft-fluid', fluid: 'steam', amount: 100 } }
    technologies.spawner = { research_trigger: { type: 'capture-spawner' } }
    expect(research_trigger_summary('orbit')).toEqual({ type: 'send-item-to-orbit', item: 'rocket-part', item_quality: 'rare' })
    expect(research_trigger_summary('build')).toEqual({ type: 'build-entity', entity: 'offshore-pump' })
    expect(research_trigger_summary('mine')).toEqual({ type: 'mine-entity', entity: 'stone' })
    expect(research_trigger_summary('fluid')).toEqual({ type: 'craft-fluid', fluid: 'steam', amount: 100 })
    expect(research_trigger_summary('spawner')).toEqual({ type: 'capture-spawner' })
  })

  it('drops a malformed id instead of inventing a name', () => {
    ;(globalThis as any).prototypes.technology.odd = { research_trigger: { type: 'craft-item', item: { quality: 'normal' }, count: 5 } }
    expect(research_trigger_summary('odd')).toEqual({ type: 'craft-item', count: 5 })
  })

  it('passes through lab research without inventing a trigger', () => {
    ;(globalThis as any).prototypes.technology.automation = { research_trigger: undefined }
    expect(with_research_trigger('automation', { found: true, name: 'automation' })).toEqual({ found: true, name: 'automation' })
  })
})
