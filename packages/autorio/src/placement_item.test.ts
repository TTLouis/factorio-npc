import { beforeEach, describe, expect, it } from 'vitest'
import { resolve_entity_placement_item } from './placement_item'

beforeEach(() => {
  ;(globalThis as any).prototypes.item['alias-kit'] = {}
  ;(globalThis as any).prototypes.item['kit-a'] = {}
  ;(globalThis as any).prototypes.item['kit-b'] = {}
  ;(globalThis as any).prototypes.entity['alias-machine'] = {
    items_to_place_this: [{ name: 'alias-kit', count: 2 }],
  }
  ;(globalThis as any).prototypes.entity['ambiguous-machine'] = {
    items_to_place_this: [{ name: 'kit-a', count: 1 }, { name: 'kit-b', count: 1 }],
  }
  ;(globalThis as any).prototypes.entity['script-only'] = { items_to_place_this: [] }
})

describe('entity placement item resolution', () => {
  it('keeps entity identity distinct from its concrete placing item', () => {
    expect(resolve_entity_placement_item('alias-machine')).toEqual({
      ok: true,
      requirement: {
        entity_name: 'alias-machine',
        item_name: 'alias-kit',
        count: 2,
      },
    })
  })

  it('fails closed for unknown, non-placeable, ambiguous, and invalid placement items', () => {
    expect(resolve_entity_placement_item('unknown-machine')).toMatchObject({ ok: false, code: 'unknown_entity' })
    expect(resolve_entity_placement_item('script-only')).toMatchObject({ ok: false, code: 'not_item_placeable' })
    expect(resolve_entity_placement_item('ambiguous-machine')).toMatchObject({ ok: false, code: 'ambiguous_placement_item' })

    ;(globalThis as any).prototypes.entity['missing-item-prototype'] = {
      items_to_place_this: [{ name: 'missing-kit', count: 1 }],
    }
    ;(globalThis as any).prototypes.entity['invalid-count'] = {
      items_to_place_this: [{ name: 'alias-kit', count: 0 }],
    }
    expect(resolve_entity_placement_item('missing-item-prototype')).toMatchObject({
      ok: false,
      code: 'invalid_placement_item',
      item_name: 'missing-kit',
    })
    expect(resolve_entity_placement_item('invalid-count')).toMatchObject({
      ok: false,
      code: 'invalid_placement_item',
      item_name: 'alias-kit',
    })
  })
})
